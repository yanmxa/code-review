import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
    totalCny: 10,
    usdToCny: 7.25,
    // A single-generation ladder: same prompt shape, three price points.
    ladder: [
      { atFraction: 0, model: { provider: "openai", id: "gpt-5.4" } },
      { atFraction: 0.5, model: { provider: "openai", id: "gpt-5.4-mini" } },
      { atFraction: 0.85, model: { provider: "openai", id: "gpt-5.4-nano" } },
    ],
    squeezeAtFraction: 0.75,
    hardStopAtFraction: 1,
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
  budget?: Partial<BudgetConfig>;
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
    config = {
      ...config,
      ...stripUndefined(rest),
      budget: { ...config.budget, ...stripUndefined(budget ?? {}) },
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
  if (!(config.budget.totalCny > 0)) throw new Error("budget.totalCny must be > 0");
  if (!(config.budget.usdToCny > 0)) throw new Error("budget.usdToCny must be > 0");
  if (config.budget.ladder.length === 0) throw new Error("budget.ladder must not be empty");
  const fractions = config.budget.ladder.map((step) => step.atFraction);
  if (fractions.some((f, i) => i > 0 && f <= (fractions[i - 1] as number))) {
    throw new Error("budget.ladder steps must have strictly increasing atFraction");
  }
  if (fractions[0] !== 0) throw new Error("budget.ladder must start with atFraction 0");
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
  if (env.CODE_REVIEW_BUDGET_CNY) budget.totalCny = Number(env.CODE_REVIEW_BUDGET_CNY);
  if (env.CODE_REVIEW_USD_CNY) budget.usdToCny = Number(env.CODE_REVIEW_USD_CNY);
  if (Object.keys(budget).length > 0) overrides.budget = budget;
  if (env.CODE_REVIEW_MODEL) overrides.models = { primary: parseModelRef(env.CODE_REVIEW_MODEL) };
  if (env.CODE_REVIEW_LANG === "zh" || env.CODE_REVIEW_LANG === "en") overrides.lang = env.CODE_REVIEW_LANG;
  return overrides;
}
