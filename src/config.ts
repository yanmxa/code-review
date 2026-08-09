import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseBudgetLimit } from "./budget/limit.js";
import type { BudgetConfig, ModelRef, Severity } from "./types.js";

export type Language = "zh" | "en";

export interface Config {
  budget: BudgetConfig;
  /** Per-tool enable/disable, keyed by ToolSpec.meta.id. */
  tools: Record<string, boolean>;
  /** Project-specific deterministic checks, layered over the built-ins. */
  rules: RulesConfig;
  /** What this project wants the reviewer to care about. */
  review: ReviewConfig;
  lang: Language;
  /** Max turns a single review unit may take before it is forced to submit. */
  maxTurnsPerUnit: number;
  /**
   * Turn cap for the pull-request pass, which has more ground to cover.
   *
   * A per-file agent starts with its file already in the prompt. This one has
   * to find out what changed, fan out across it, and then verify a suspicion —
   * on a four-file pull request that used most of the per-file allowance before
   * it had a hypothesis, and it submitted only because it was told to.
   */
  maxTurnsPerPullRequest: number;
  /** Lines of surrounding file context the get_file tool may return. */
  fileContextLines: number;
  /** Squeezed value for the above once the budget crosses squeezeAtFraction. */
  fileContextLinesSqueezed: number;
  /** Split a file into multiple units past this many diff lines. */
  maxUnitDiffLines: number;
  runDir: string;
  /** Discard any existing checkpoint for this PR and start over. */
  fresh: boolean;
}

/**
 * Deterministic checks a project can add, silence, or re-grade.
 *
 * The built-in rules encode what is true of most code. What is true of *this*
 * codebase — "always wrap errors", "never import from `legacy/`" — only the
 * team knows, and requiring a fork to express it would make the extensibility
 * claim apply to tools alone.
 */
export interface RulesConfig {
  /** Built-in rule ids to switch off. */
  disabled: string[];
  /** Re-grade a built-in, e.g. `{"todo-added": "nit"}`. */
  severity: Record<string, Severity>;
  custom: CustomRule[];
}

export interface CustomRule {
  id: string;
  severity: Severity;
  /** JavaScript regular expression source, matched against each added line. */
  pattern: string;
  /** Optional second pattern that must also match the same line. */
  requires?: string;
  /** Suppress the rule on lines matching this. */
  unless?: string;
  /** Restrict to paths matching this regular expression. */
  files?: string;
  title: string;
  body: string;
}

export interface ReviewConfig {
  /**
   * Appended to the reviewer's instructions. The place to say "this is a Go
   * service, watch error wrapping" or "we care about accessibility".
   */
  focus?: string;
  /** Topics the reviewer must not raise, e.g. ["naming", "comment style"]. */
  ignore: string[];
  /**
   * A note for this run only, from `--prompt`.
   *
   * The reviewer's context is otherwise assembled entirely from the pull
   * request, and the person starting the run routinely knows something it
   * cannot derive — that this is a revert, that a retry loop is deliberate,
   * that only the auth files matter. Without somewhere to say it, that
   * knowledge is simply lost.
   */
  prompt?: string;
}

export const DEFAULT_CONFIG: Config = {
  budget: {
    limit: { amount: 10, unit: "CNY" },
    usdToCny: 7.25,
    // Priority order, no thresholds: the run steps down a rung whenever it is
    // projected to overrun. Same prompt shape, three price points.
    models: [
      { provider: "openai", id: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4-mini" },
      { provider: "openai", id: "gpt-5.4-nano" },
    ],
  },
  tools: {},
  rules: { disabled: [], severity: {}, custom: [] },
  review: { ignore: [] },
  lang: "zh",
  maxTurnsPerUnit: 6,
  maxTurnsPerPullRequest: 14,
  fileContextLines: 2000,
  fileContextLinesSqueezed: 400,
  maxUnitDiffLines: 600,
  runDir: join(homedir(), ".code-review", "runs"),
  fresh: false,
};

/** Anything a config file or CLI flag may override. */
export type ConfigOverrides = {
  /** Loose on disk: older keys are migrated by {@link migrateBudget}. */
  budget?: Partial<BudgetConfig> | Record<string, unknown>;
  tools?: Record<string, boolean>;
  rules?: Partial<RulesConfig>;
  review?: Partial<ReviewConfig>;
} & Partial<Omit<Config, "budget" | "tools" | "rules" | "review">>;

/**
 * Merge layers in precedence order: defaults < user config < project config <
 * env < CLI flags. Later layers win field by field; `ladder` is replaced whole
 * because a half-merged ladder is never what anyone means.
 */
export function resolveConfig(...layers: ConfigOverrides[]): Config {
  let config: Config = structuredClone(DEFAULT_CONFIG);
  for (const layer of layers) {
    const { budget, tools, rules, review, ...rest } = layer;
    const migrated = budget ? migrateBudget(budget as Record<string, unknown>) : {};
    config = {
      ...config,
      ...stripUndefined(rest),
      budget: { ...config.budget, ...stripUndefined(migrated) },
      tools: { ...config.tools, ...(tools ?? {}) },
      rules: {
        disabled: [...config.rules.disabled, ...(rules?.disabled ?? [])],
        severity: { ...config.rules.severity, ...(rules?.severity ?? {}) },
        // Custom rules accumulate: a project config should be able to add to
        // the user's personal ones rather than silently replace them.
        custom: [...config.rules.custom, ...(rules?.custom ?? [])],
      },
      review: {
        ...config.review,
        ...stripUndefined(review ?? {}),
        ignore: [...config.review.ignore, ...(review?.ignore ?? [])],
      },
    };
  }
  validate(config);
  return config;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function validate(config: Config): void {
  if (!(config.budget.limit.amount > 0)) throw new Error("budget.limit must be greater than zero");
  if (!(config.budget.usdToCny > 0)) throw new Error("budget.usdToCny must be > 0");
  if (config.budget.models.length === 0) throw new Error("budget.models must list at least one model");

  // A malformed custom rule must fail at startup, not silently never match.
  for (const rule of config.rules.custom) {
    if (!rule.id) throw new Error("Every rules.custom entry needs an id");
    for (const [field, source] of [
      ["pattern", rule.pattern],
      ["requires", rule.requires],
      ["unless", rule.unless],
      ["files", rule.files],
    ] as const) {
      if (source === undefined) continue;
      try {
        new RegExp(source);
      } catch (error) {
        throw new Error(`rules.custom["${rule.id}"].${field} is not a valid regex: ${(error as Error).message}`);
      }
    }
  }
}

/**
 * Accept the shape earlier versions wrote.
 *
 * The old config expressed the budget as a bare CNY number and pinned each
 * ladder rung to a spend fraction. Those fractions no longer exist — the run
 * steps down on projected overrun instead — so the rungs migrate to a plain
 * priority list and the thresholds are dropped.
 */
export function migrateBudget(raw: Record<string, unknown>): Partial<BudgetConfig> {
  const out: Partial<BudgetConfig> = {};

  if (typeof raw.limit === "string") out.limit = parseBudgetLimit(raw.limit);
  else if (raw.limit && typeof raw.limit === "object") out.limit = raw.limit as BudgetConfig["limit"];
  else if (typeof raw.totalCny === "number") out.limit = { amount: raw.totalCny, unit: "CNY" };

  if (typeof raw.usdToCny === "number") out.usdToCny = raw.usdToCny;

  if (Array.isArray(raw.models)) {
    out.models = raw.models.map((entry) =>
      typeof entry === "string" ? parseModelRef(entry) : (entry as ModelRef),
    );
  } else if (Array.isArray(raw.ladder)) {
    out.models = (raw.ladder as { model: ModelRef | string }[]).map((step) =>
      typeof step.model === "string" ? parseModelRef(step.model) : step.model,
    );
  }

  return out;
}

/** Read a JSON config file. Missing is fine; malformed is not. */
export function loadConfigFile(path: string): ConfigOverrides {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as ConfigOverrides;
  } catch (error) {
    throw new Error(`Malformed config at ${path}: ${(error as Error).message}`);
  }
}

export function userConfigPath(): string {
  return join(homedir(), ".config", "code-review", "config.json");
}

export function projectConfigPath(cwd = process.cwd()): string {
  return join(cwd, "review.config.json");
}

/** Parse `provider/model-id`, or a bare id against a default provider. */
export function parseModelRef(spec: string, defaultProvider = "openai"): ModelRef {
  const slash = spec.indexOf("/");
  if (slash < 0) return { provider: defaultProvider, id: spec };
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

/**
 * The model a run starts on.
 *
 * There is exactly one place this is written down — the head of the ladder.
 * A separate `primary` field said the same thing a second time, and two
 * statements of one fact can disagree: a config naming one model there and a
 * different one at the head of the ladder would run the second while pricing
 * and subscription conversion used the first.
 */
export function primaryModel(config: Config): ModelRef {
  return config.budget.models[0]!;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  const budget: Partial<BudgetConfig> = {};
  if (env.CODE_REVIEW_BUDGET) budget.limit = parseBudgetLimit(env.CODE_REVIEW_BUDGET);
  else if (env.CODE_REVIEW_BUDGET_CNY) budget.limit = { amount: Number(env.CODE_REVIEW_BUDGET_CNY), unit: "CNY" };
  if (env.CODE_REVIEW_USD_CNY) budget.usdToCny = Number(env.CODE_REVIEW_USD_CNY);
  if (Object.keys(budget).length > 0) overrides.budget = budget;
  if (env.CODE_REVIEW_MODEL) overrides.budget = { ...overrides.budget, models: [parseModelRef(env.CODE_REVIEW_MODEL)] };
  if (env.CODE_REVIEW_LANG === "zh" || env.CODE_REVIEW_LANG === "en") overrides.lang = env.CODE_REVIEW_LANG;
  return overrides;
}
