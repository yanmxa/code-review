import { createModels, type Models, type MutableModels } from "@earendil-works/pi-ai";
import type { RunStore } from "./checkpoint/store.js";
import { type Config, primaryModel } from "./config.js";
import { runReview } from "./engine/pipeline.js";
import { GitHubAdapter, resolveGitHubToken } from "./platform/github.js";
import { GitLabAdapter, resolveGitLabToken } from "./platform/gitlab.js";
import type { PlatformAdapter } from "./platform/adapter.js";
import { renderReport, type ReportInput } from "./report/markdown.js";
import { postFindings, type PostSummary } from "./report/post.js";
import { FileCredentialStore } from "./auth/credential-store.js";
import { DismissalStore } from "./memory/dismissals.js";
import { isSubscriptionAuth } from "./auth/login.js";
import { formatBudget, formatTokenCount } from "./budget/limit.js";
import { Redactor } from "./security/redactor.js";
import type { Finding, PrSnapshot, RunEvent, RunEventSink, SkipReason, Target } from "./types.js";
import { planUnits } from "./engine/units.js";

export interface RunOptions {
  target: Target;
  config: Config;
  emit: RunEventSink;
  post?: boolean;
  reportPath?: string;
  signal?: AbortSignal;
}

export interface RunOutcome {
  findings: Finding[];
  store: RunStore;
  snapshot: PrSnapshot;
  report: ReportInput;
  reportPath: string;
  posted?: PostSummary;
  /** Findings withheld because they had been dismissed before. */
  suppressed: number;
  hardStopped: boolean;
}

/**
 * Composition root: build the services, run the review, write the report.
 *
 * Everything that touches the outside world — credentials, providers, the
 * filesystem — is wired here, so the pipeline and the engine stay testable
 * against fakes.
 */
export async function executeRun(options: RunOptions): Promise<RunOutcome> {
  const { target, config } = options;

  const credentials = new FileCredentialStore();
  // Stored OAuth tokens are live credentials. Seeding them means an accidental
  // echo can never reach a prompt, a trace, or a checkpoint.
  const redactor = new Redactor().seedFromEnv().seed(...credentials.secrets());
  const adapter = await createAdapter(target, redactor);
  const models = await createModelRegistry(process.env, credentials);
  const budgetConfig = await resolveBudgetUnit(models, config, options.emit);
  const memory = DismissalStore.forTarget(target);

  const budgetEvents: { kind: string; detail: string }[] = [];
  const emit: RunEventSink = (event: RunEvent) => {
    if (event.type === "budget") budgetEvents.push({ kind: event.kind, detail: event.detail });
    options.emit(event);
  };

  const result = await runReview(target, {
    adapter,
    models,
    redactor,
    config: { ...config, budget: budgetConfig },
    emit,
    dismissed: memory.dismissed(),
    signal: options.signal,
  });

  const { skipped } = planUnits(result.snapshot.files, config.maxUnitDiffLines);
  const report: ReportInput = {
    snapshot: result.snapshot,
    findings: result.findings,
    state: result.store.current,
    lang: config.lang,
    unit: result.budget.unit,
    limit: result.budget.limit,
    spent: result.budget.spent,
    redactionStats: redactor.stats(),
    ...(result.checks ? { checks: result.checks } : {}),
    budgetEvents,
    skipped: [
      ...skipped.map((entry) => ({ path: entry.path, reason: entry.reason })),
      ...result.store.current.units
        .filter((unit) => unit.status === "skipped" && unit.skipReason)
        .map((unit) => ({ path: unit.path, reason: unit.skipReason as SkipReason })),
    ],
  };

  const markdown = renderReport(report);
  const reportPath = options.reportPath ?? result.store.writeReport(markdown);
  if (options.reportPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(options.reportPath, markdown, "utf8");
    result.store.writeReport(markdown);
  }

  let posted: PostSummary | undefined;
  if (options.post) {
    posted = await postFindings({
      adapter,
      snapshot: result.snapshot,
      store: result.store,
      findings: result.findings,
      report,
      lang: config.lang,
      memory,
    });
  }

  emit({ type: "run_end", findings: result.findings, state: result.store.current, reportPath });

  return {
    findings: result.findings,
    store: result.store,
    snapshot: result.snapshot,
    report,
    reportPath,
    posted,
    suppressed: result.suppressed,
    hardStopped: result.store.current.hardStopped,
  };
}

/**
 * Decide what the budget actually counts, given how the run is paid for.
 *
 * A subscription bills nothing per call. Keeping a money limit there would mean
 * pricing every call from a list the user is not being charged against — a
 * number that looks like spend and is not. So a money limit is converted, once
 * and out loud, into the token limit it corresponds to, and everything
 * downstream counts the quantity that genuinely moves.
 */
async function resolveBudgetUnit(
  models: Models,
  config: Config,
  emit: RunEventSink,
): Promise<Config["budget"]> {
  const budget = config.budget;
  if (budget.limit.unit === "tokens") return budget;
  if (!(await isSubscriptionAuth(models, primaryModel(config).provider))) return budget;

  const primary = models.getModel(primaryModel(config).provider, primaryModel(config).id);
  if (!primary) return budget;

  const usd = budget.limit.unit === "USD" ? budget.limit.amount : budget.limit.amount / budget.usdToCny;
  // Assume a typical review's 6:1 input:output split when pricing the swap.
  const blendedPerMillion = primary.cost.input * (6 / 7) + primary.cost.output * (1 / 7);
  if (!(blendedPerMillion > 0)) return budget;
  const tokens = Math.round((usd / blendedPerMillion) * 1_000_000);

  emit({
    type: "notice",
    level: "info",
    text:
      `Subscription credential — calls are covered by your plan, so there is no per-call cost to budget. ` +
      `${formatBudget(budget.limit.amount, budget.limit.unit)} at ${primary.id} list price is about ` +
      `${formatTokenCount(tokens)} tokens; budgeting that instead. Set --budget in tokens to be explicit.`,
  });

  return { ...budget, limit: { amount: tokens, unit: "tokens" } };
}

export async function createAdapter(target: Target, redactor: Redactor): Promise<PlatformAdapter> {
  if (target.platform === "github") {
    const token = await resolveGitHubToken();
    // Our own credentials must never survive into a trace or a prompt.
    redactor.seed(token);
    if (!token) {
      throw new Error(
        "No GitHub credentials. Set GITHUB_TOKEN, or run `gh auth login` so `gh auth token` can supply one.",
      );
    }
    return new GitHubAdapter({ redactor, token });
  }

  const token = resolveGitLabToken();
  redactor.seed(token);
  if (!token) {
    throw new Error("No GitLab credentials. Set GITLAB_TOKEN to a token with `api` scope.");
  }
  return new GitLabAdapter({ redactor, token });
}

/**
 * Build the model registry.
 *
 * Two credential paths, both supported:
 *  - **API key** from the environment — metered per token.
 *  - **OAuth** stored by `code-review login` — a ChatGPT/Claude subscription,
 *    where calls are covered by the plan rather than billed per token.
 *
 * Providers backed by a key are only registered when that key exists: loading a
 * provider pulls in its SDK, and a missing key would otherwise surface as a
 * confusing auth error mid-run instead of a clear one at startup. OAuth-backed
 * providers are registered whenever a stored credential exists.
 */
export async function createModelRegistry(
  env: NodeJS.ProcessEnv = process.env,
  credentials: FileCredentialStore = new FileCredentialStore(),
): Promise<Models> {
  const models: MutableModels = createModels({ credentials });
  const loaded: string[] = [];

  const stored = new Set((await credentials.list()).map((entry) => entry.providerId));

  if (env.OPENAI_API_KEY || stored.has("openai")) {
    const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
    models.setProvider(openaiProvider());
    loaded.push("openai");
  }
  // Subscription access to the same OpenAI models, via a ChatGPT plan.
  if (stored.has("openai-codex")) {
    const { openaiCodexProvider } = await import("@earendil-works/pi-ai/providers/openai-codex");
    models.setProvider(openaiCodexProvider());
    loaded.push("openai-codex");
  }
  if (env.MOONSHOT_API_KEY || stored.has("moonshotai")) {
    const { moonshotaiProvider } = await import("@earendil-works/pi-ai/providers/moonshotai");
    models.setProvider(moonshotaiProvider());
    loaded.push("moonshotai");
  }
  if (env.ANTHROPIC_API_KEY || stored.has("anthropic")) {
    const { anthropicProvider } = await import("@earendil-works/pi-ai/providers/anthropic");
    models.setProvider(anthropicProvider());
    loaded.push("anthropic");
  }
  if (env.OPENROUTER_API_KEY || stored.has("openrouter")) {
    const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
    models.setProvider(openrouterProvider());
    loaded.push("openrouter");
  }

  if (loaded.length === 0) {
    throw new Error(
      "No model credentials found.\n" +
        "  Subscription:  code-review login openai-codex   (uses your ChatGPT plan)\n" +
        "  API key:       export OPENAI_API_KEY=…          (also MOONSHOT / ANTHROPIC / OPENROUTER)",
    );
  }

  return models;
}

/** Providers this tool knows how to register, for `login` and `auth`. */
export const KNOWN_PROVIDERS = [
  "openai-codex",
  "openai",
  "anthropic",
  "moonshotai",
  "openrouter",
] as const;

/** Every provider that can be logged into interactively. */
export async function providerForLogin(id: string): Promise<MutableModels> {
  const models: MutableModels = createModels({ credentials: new FileCredentialStore() });
  switch (id) {
    case "openai-codex": {
      const { openaiCodexProvider } = await import("@earendil-works/pi-ai/providers/openai-codex");
      models.setProvider(openaiCodexProvider());
      break;
    }
    case "openai": {
      const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
      models.setProvider(openaiProvider());
      break;
    }
    case "anthropic": {
      const { anthropicProvider } = await import("@earendil-works/pi-ai/providers/anthropic");
      models.setProvider(anthropicProvider());
      break;
    }
    case "moonshotai": {
      const { moonshotaiProvider } = await import("@earendil-works/pi-ai/providers/moonshotai");
      models.setProvider(moonshotaiProvider());
      break;
    }
    case "openrouter": {
      const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
      models.setProvider(openrouterProvider());
      break;
    }
    default:
      throw new Error(`Unknown provider "${id}". Known: ${KNOWN_PROVIDERS.join(", ")}`);
  }
  return models;
}
