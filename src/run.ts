import { createModels, type Models, type MutableModels } from "@earendil-works/pi-ai";
import type { RunStore } from "./checkpoint/store.js";
import type { Config } from "./config.js";
import { runReview } from "./engine/pipeline.js";
import { GitHubAdapter, resolveGitHubToken } from "./platform/github.js";
import { GitLabAdapter, resolveGitLabToken } from "./platform/gitlab.js";
import type { PlatformAdapter } from "./platform/adapter.js";
import { renderReport, type ReportInput } from "./report/markdown.js";
import { postFindings, type PostSummary } from "./report/post.js";
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

  const redactor = new Redactor().seedFromEnv();
  const adapter = await createAdapter(target, redactor);
  const models = await createModelRegistry();

  const budgetEvents: { kind: string; detail: string }[] = [];
  const emit: RunEventSink = (event: RunEvent) => {
    if (event.type === "budget") budgetEvents.push({ kind: event.kind, detail: event.detail });
    options.emit(event);
  };

  const result = await runReview(target, {
    adapter,
    models,
    redactor,
    config,
    emit,
    signal: options.signal,
  });

  const { skipped } = planUnits(result.snapshot.files, config.maxUnitDiffLines);
  const report: ReportInput = {
    snapshot: result.snapshot,
    findings: result.findings,
    state: result.store.current,
    lang: config.lang,
    budgetTotalCny: config.budget.totalCny,
    redactionStats: redactor.stats(),
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
    hardStopped: result.store.current.hardStopped,
  };
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
 * Providers are imported lazily and only when a key exists for them: loading a
 * provider pulls in its SDK, and a missing key would surface as a confusing
 * auth error mid-run rather than a clear one at startup.
 */
export async function createModelRegistry(env: NodeJS.ProcessEnv = process.env): Promise<Models> {
  const models: MutableModels = createModels();
  const loaded: string[] = [];

  if (env.OPENAI_API_KEY) {
    const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
    models.setProvider(openaiProvider());
    loaded.push("openai");
  }
  if (env.MOONSHOT_API_KEY) {
    const { moonshotaiProvider } = await import("@earendil-works/pi-ai/providers/moonshotai");
    models.setProvider(moonshotaiProvider());
    loaded.push("moonshotai");
  }
  if (env.ANTHROPIC_API_KEY) {
    const { anthropicProvider } = await import("@earendil-works/pi-ai/providers/anthropic");
    models.setProvider(anthropicProvider());
    loaded.push("anthropic");
  }
  if (env.OPENROUTER_API_KEY) {
    const { openrouterProvider } = await import("@earendil-works/pi-ai/providers/openrouter");
    models.setProvider(openrouterProvider());
    loaded.push("openrouter");
  }

  if (loaded.length === 0) {
    throw new Error(
      "No LLM credentials found. Set one of OPENAI_API_KEY, MOONSHOT_API_KEY, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY.",
    );
  }

  return models;
}
