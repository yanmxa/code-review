import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseBudgetLimit } from "./budget/limit.js";
import type { BudgetConfig, ModelRef } from "./types.js";

export type Language = "zh" | "en";

export interface Config {
  budget: BudgetConfig;
  models: {
    primary: ModelRef;
    /** Cheap model for the pre-pass that orders and prunes the file list. */
    triage: ModelRef;
    /** Model used by the optional --verify refutation pass. */
    verify: ModelRef;
  };
  /** Per-tool enable/disable, keyed by ToolSpec.meta.id. */
  tools: Record<string, boolean>;
  lang: Language;
  /** Max turns a single review unit may take before it is forced to submit. */
  maxTurnsPerUnit: number;
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
  models: {
    primary: { provider: "openai", id: "gpt-5.4" },
    triage: { provider: "openai", id: "gpt-5.4-nano" },
    verify: { provider: "openai", id: "gpt-5.4-mini" },
  },
  tools: {},
  lang: "zh",
  maxTurnsPerUnit: 6,
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
  models?: Partial<Config["models"]>;
  tools?: Record<string, boolean>;
} & Partial<Omit<Config, "budget" | "models" | "tools">>;

/**
 * Merge layers in precedence order: defaults < user config < project config <
 * env < CLI flags. Later layers win field by field; `ladder` is replaced whole
 * because a half-merged ladder is never what anyone means.
 */
export function resolveConfig(...layers: ConfigOverrides[]): Config {
  let config: Config = structuredClone(DEFAULT_CONFIG);
  for (const layer of layers) {
    const { budget, models, tools, ...rest } = layer;
    const migrated = budget ? migrateBudget(budget as Record<string, unknown>) : {};
    config = {
      ...config,
      ...stripUndefined(rest),
      budget: { ...config.budget, ...stripUndefined(migrated) },
      models: { ...config.models, ...stripUndefined(models ?? {}) },
      tools: { ...config.tools, ...(tools ?? {}) },
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

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ConfigOverrides {
  const overrides: ConfigOverrides = {};
  const budget: Partial<BudgetConfig> = {};
  if (env.CODE_REVIEW_BUDGET) budget.limit = parseBudgetLimit(env.CODE_REVIEW_BUDGET);
  else if (env.CODE_REVIEW_BUDGET_CNY) budget.limit = { amount: Number(env.CODE_REVIEW_BUDGET_CNY), unit: "CNY" };
  if (env.CODE_REVIEW_USD_CNY) budget.usdToCny = Number(env.CODE_REVIEW_USD_CNY);
  if (Object.keys(budget).length > 0) overrides.budget = budget;
  if (env.CODE_REVIEW_MODEL) overrides.models = { primary: parseModelRef(env.CODE_REVIEW_MODEL) };
  if (env.CODE_REVIEW_LANG === "zh" || env.CODE_REVIEW_LANG === "en") overrides.lang = env.CODE_REVIEW_LANG;
  return overrides;
}
