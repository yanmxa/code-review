import type { Models } from "@earendil-works/pi-ai";
import { BudgetManager } from "../budget/budget.js";
import { hashDiff, RunStore } from "../checkpoint/store.js";
import { type Config, primaryModel } from "../config.js";
import type { CheckSummary, PlatformAdapter } from "../platform/adapter.js";
import type { Redactor } from "../security/redactor.js";
import { selectTools } from "../tools/index.js";
import type { ToolContext } from "../tools/spec.js";
import { Tracer } from "../trace/tracer.js";
import type { Finding, PrSnapshot, ReviewUnit, RunEventSink, Target } from "../types.js";
import { CROSS_FILE_UNIT_ID, crossFileUnit, reviewPullRequest } from "./cross-file.js";
import { dedupe, findingFromRule, gradeAgentFinding } from "./grade.js";
import { reviewUnit } from "./review-agent.js";
import { type PrRuleContext, redactHits, runRules } from "./rules-engine.js";
import { estimateTokens, planUnits } from "./units.js";

/** Share of the limit held back for the pull-request pass. */
const CROSS_FILE_BUDGET_SHARE = 0.15;

export interface PipelineDeps {
  adapter: PlatformAdapter;
  models: Models;
  redactor: Redactor;
  config: Config;
  emit: RunEventSink;
  /**
   * Fingerprints a maintainer has already rejected on this repository. A
   * reviewer that re-raises a dismissed comment on every push teaches the team
   * to ignore it, so these are dropped before anyone sees them.
   */
  dismissed?: Set<string>;
  signal?: AbortSignal;
}

export interface PipelineResult {
  findings: Finding[];
  /** How many findings were withheld because they had been dismissed before. */
  suppressed: number;
  store: RunStore;
  snapshot: PrSnapshot;
  budget: BudgetManager;
  resumed: boolean;
  /** CI state at the head commit, when the host could tell us. */
  checks?: CheckSummary;
}

/**
 * The whole review, start to finish.
 *
 * This function knows the *order* of the work and nothing about its content:
 * which tools exist, which rules fire, how confidence is decided, and when to
 * downgrade a model are all owned elsewhere. That is what makes adding a tool a
 * one-file change.
 */
export async function runReview(target: Target, deps: PipelineDeps): Promise<PipelineResult> {
  const { adapter, models, redactor, config, emit } = deps;

  // --- Fetch -------------------------------------------------------------
  emit({ type: "notice", level: "info", text: `Fetching ${target.webUrl}`, transient: true });
  const snapshot = await adapter.fetchPr(target);
  const diffHash = hashDiff(snapshot.diff);

  const { store, resumed, staleReason } = RunStore.open({
    runDir: config.runDir,
    target,
    headSha: snapshot.meta.headSha,
    diffHash,
    fresh: config.fresh,
  });
  if (staleReason) emit({ type: "notice", level: "warn", text: staleReason });
  store.saveSnapshot(snapshot);

  // A resumed run must review the remaining files the way the first pass did,
  // so the note survives on disk rather than only in the command line.
  const note = config.review.prompt ?? store.current.prompt;
  store.setPrompt(note);
  const runConfig: Config = note
    ? { ...config, review: { ...config.review, prompt: note } }
    : config;
  if (note) emit({ type: "notice", level: "info", text: `Review note: ${note}` });

  // --- Plan --------------------------------------------------------------
  // One request, before any model call: CI is a fact about this change, and
  // reviewing without it means inferring what was already measured.
  const checks = await adapter.fetchChecks?.(target, snapshot.meta.headSha).catch(() => undefined);
  if (checks && checks.conclusion === "failure") {
    emit({
      type: "notice",
      level: "warn",
      text: `CI is failing on this head commit (${checks.failed.map((run) => run.name).join(", ")}).`,
    });
  }

  const { units, skipped } = planUnits(snapshot.files, config.maxUnitDiffLines);
  // Worth doing only when there is more than one file to hold in mind at once.
  const wantsCrossFile = units.length > 1;
  if (wantsCrossFile) units.push(crossFileUnit());
  const ruleContext: PrRuleContext = { changedPaths: snapshot.files.map((file) => file.path) };
  store.initUnits(units.map((unit) => ({ id: unit.id, path: unit.path })));

  const budget = new BudgetManager(config.budget, {
    ledger: store.current.spend,
    stage: store.current.ladderStage,
    squeezed: store.current.squeezed,
  });
  budget.onEvent((event) => emit({ type: "budget", ...event }));
  // Held back so the sweep downgrades itself rather than starving the pass that
  // runs after it. A share rather than a fixed amount, because the limit is the
  // only signal available about how large this pull request is expected to be:
  // on a comfortable budget it never binds, and on a tight one it decides which
  // of the two gets cut — coverage, which the free rules partly stand in for,
  // or the only pass that can see two files at once.
  if (wantsCrossFile) budget.reserveFor(budget.limit * CROSS_FILE_BUDGET_SHARE);

  emit({
    type: "run_start",
    snapshot,
    units,
    resumed,
    model: budget.currentModel(),
  });

  // Say what is being counted, and how much of it is already gone, before the
  // first call rather than after it. Renderers learn the budget's unit from
  // spend events, so a run whose money limit had become a token limit opened on
  // a currency gauge that could not move, and a resumed run opened on a zero it
  // was about to contradict.
  emit({
    type: "spend",
    ledger: budget.spend,
    fraction: budget.fraction,
    model: budget.currentModel(),
    unit: budget.unit,
    limit: budget.limit,
    spent: budget.spent,
  });

  for (const skip of skipped) {
    emit({ type: "unit_end", unitId: skip.id, status: "skipped", findings: 0, skipReason: skip.reason });
  }

  warnIfBudgetLooksTight(units, budget, models, config, emit);

  // --- Review ------------------------------------------------------------
  const dismissed = deps.dismissed ?? new Set<string>();
  let suppressed = 0;
  /** Drop what a maintainer already rejected, before anyone sees it. */
  const keep = (candidates: Finding[]): Finding[] => {
    const kept = candidates.filter((finding) => !dismissed.has(finding.fingerprint));
    suppressed += candidates.length - kept.length;
    return kept;
  };

  const findings: Finding[] = keep(store.readFindings());
  const summaries: { unitId: string; summary: string }[] = [];
  const settled = () =>
    store.current.units.filter((unit) => unit.status !== "pending" && unit.status !== "in_progress").length;

  for (const unit of units) {
    const state = store.unit(unit.id);
    if (!state || state.status === "done" || state.status === "skipped") continue;
    const isCrossFile = unit.id === CROSS_FILE_UNIT_ID;
    // The share was held for exactly this; from here on the full limit applies.
    if (isCrossFile) budget.releaseReserve();

    // Out of money, but the deterministic pass costs nothing and produces the
    // highest-value findings — running it anyway is what makes a budget-stopped
    // report worth reading instead of merely truncated.
    if (budget.checkExhausted()) {
      const rulesOnly = keep(runRulesOnly(unit, { ...deps, snapshot, store, ruleContext }));
      store.completeUnit(unit.id, rulesOnly, { status: "skipped", skipReason: "budget" });
      findings.push(...rulesOnly);
      for (const finding of rulesOnly) emit({ type: "finding", finding });
      emit({
        type: "unit_end",
        unitId: unit.id,
        status: "skipped",
        findings: rulesOnly.length,
        skipReason: "budget",
      });
      continue;
    }
    if (deps.signal?.aborted) break;

    emit({ type: "unit_start", unitId: unit.id, index: units.indexOf(unit) + 1 });
    store.markUnit(unit.id, { status: "in_progress", attempts: state.attempts + 1 });

    const reviewed = isCrossFile
      ? await reviewPullRequest({
          models: deps.models,
          adapter: deps.adapter,
          snapshot,
          config: runConfig,
          budget,
          store,
          redactor: deps.redactor,
          emit,
          ...(deps.signal ? { signal: deps.signal } : {}),
          summaries,
          reported: findings,
        })
      : await reviewOneUnit(unit, {
          ...deps,
          config: runConfig,
          snapshot,
          budget,
          store,
          ruleContext,
          checks,
        });
    const unitFindings = { ...reviewed, findings: keep(reviewed.findings) };

    findings.push(...unitFindings.findings);
    summaries.push({ unitId: unit.id, summary: unitFindings.summary });

    store.completeUnit(unit.id, unitFindings.findings, {
      status: unitFindings.status,
      spendUsd: unitFindings.spendUsd,
    });
    // Re-forecast now that one more file's real cost is known. This is what
    // moves the ladder — not how much has been spent, but whether the rest fits.
    budget.reviewProgress(settled(), store.current.units.length);
    persistSpend(store, budget);

    emit({
      type: "unit_end",
      unitId: unit.id,
      status: unitFindings.status,
      findings: unitFindings.findings.length,
    });
    for (const finding of unitFindings.findings) emit({ type: "finding", finding });
    emit({
      type: "spend",
      ledger: budget.spend,
      fraction: budget.fraction,
      model: budget.currentModel(),
      unit: budget.unit,
      limit: budget.limit,
      spent: budget.spent,
      projected: budget.projectedTotal,
    });
  }

  // --- Finish ------------------------------------------------------------
  const kept = dedupe(findings);

  if (suppressed > 0) {
    emit({
      type: "notice",
      level: "info",
      text: `Withheld ${suppressed} finding(s) a maintainer dismissed on an earlier review.`,
    });
  }

  store.finish();
  persistSpend(store, budget);

  return { findings: kept, suppressed, store, snapshot, budget, resumed, checks };
}

async function reviewOneUnit(
  unit: ReviewUnit,
  deps: PipelineDeps & {
    snapshot: PrSnapshot;
    budget: BudgetManager;
    store: RunStore;
    ruleContext: PrRuleContext;
    checks?: CheckSummary;
  },
): Promise<{ findings: Finding[]; summary: string; spendUsd: number; status: "done" | "failed" }> {
  const { config, redactor, store, budget, emit } = deps;
  const tracer = Tracer.forUnit(store.dirs.root, unit.id, redactor);

  // Deterministic pass first: its output is both a finding source and context
  // that stops the model from re-reporting what a regex already caught.
  const ruleHits = redactHits(runRules(unit, config.lang, deps.ruleContext, config.rules), redactor);
  for (const hit of ruleHits) {
    tracer.write({ type: "rule_hit", ruleId: hit.ruleId, path: hit.path, line: hit.line });
  }

  const ruleFindings = ruleHits.map((hit) => findingFromRule(hit, unit, tracer.relativePath));

  const staticHits: { toolId: string; path: string; line: number; diagnostic: string }[] = [];

  const result = await reviewUnit(unit, ruleHits, {
    models: deps.models,
    adapter: deps.adapter,
    budget,
    tracer,
    redactor,
    config,
    snapshot: deps.snapshot,
    signal: deps.signal,
    onDelta: (text) => emit({ type: "stream_delta", unitId: unit.id, text }),
    onTool: (phase, name, summary, isError) => {
      emit(
        phase === "start"
          ? { type: "tool_start", unitId: unit.id, name, summary }
          : { type: "tool_end", unitId: unit.id, name, summary, isError: isError ?? false },
      );
    },
    onStaticDiagnostics: (hits) => staticHits.push(...hits),
    ...(deps.checks ? { checks: deps.checks } : {}),
  });

  const toolContext: ToolContext = {
    adapter: deps.adapter,
    snapshot: deps.snapshot,
    unit,
    redactor,
    fileContextLines: config.fileContextLines,
  };
  const { evidenceKinds } = selectTools(toolContext, deps.snapshot.target.platform, config.tools);

  const agentFindings = result.raw
    .map((raw) =>
      gradeAgentFinding(raw, {
        unit,
        tracePath: tracer.relativePath,
        toolCallNames: result.toolCallNames,
        evidenceKinds,
        staticHits,
      }),
    )
    .filter((finding): finding is Finding => finding !== null);

  const findings = dedupe([...ruleFindings, ...agentFindings]);

  return {
    findings,
    // What the file is for, in the model's words. The count is a fallback for
    // when it did not say — a list of complaints is a poor description, and the
    // pull-request pass is already handed every reported finding separately.
    summary:
      result.summary?.trim() ||
      (findings.length === 0
        ? "no findings"
        : `${findings.length} finding(s): ${findings.map((f) => f.title).slice(0, 3).join("; ")}`),
    spendUsd: result.spendUsd,
    status: result.status,
  };
}

/** The zero-cost half of a unit review, for when there is no budget left. */
function runRulesOnly(
  unit: ReviewUnit,
  deps: PipelineDeps & { snapshot: PrSnapshot; store: RunStore; ruleContext: PrRuleContext },
): Finding[] {
  const tracer = Tracer.forUnit(deps.store.dirs.root, unit.id, deps.redactor);
  tracer.write({ type: "budget", kind: "hard_stop", detail: "rules-only pass; no model calls" });

  const hits = redactHits(runRules(unit, deps.config.lang, deps.ruleContext, deps.config.rules), deps.redactor);
  for (const hit of hits) {
    tracer.write({ type: "rule_hit", ruleId: hit.ruleId, path: hit.path, line: hit.line });
  }
  const findings = dedupe(hits.map((hit) => findingFromRule(hit, unit, tracer.relativePath)));
  tracer.write({
    type: "unit_end",
    findingIds: findings.map((finding) => finding.fingerprint),
    spendUsd: 0,
    status: "skipped",
    note: "budget exhausted — deterministic rules only",
  });
  return findings;
}

function persistSpend(store: RunStore, budget: BudgetManager): void {
  const snapshot = budget.snapshot();
  store.updateSpend(snapshot.ledger, snapshot.stage, snapshot.squeezed, budget.hardStopped, {
    limit: budget.limit,
    unit: budget.unit,
    usdToCny: budget.usdToCnyRate,
  });
}

/**
 * Warn before spending anything if the diff plainly exceeds the budget.
 *
 * The estimate is deliberately optimistic (primary-model rates, one pass per
 * unit). Being told up front that a downgrade is coming beats discovering it at
 * 50%.
 */
function warnIfBudgetLooksTight(
  units: ReviewUnit[],
  budget: BudgetManager,
  models: Models,
  config: Config,
  emit: RunEventSink,
): void {
  const primary = models.getModel(primaryModel(config).provider, primaryModel(config).id);
  if (!primary) return;

  const inputTokens = units.reduce((sum, unit) => sum + estimateTokens(unit.patch) + 900, 0);
  const outputTokens = units.length * 700;
  const estimate = budget.estimate(inputTokens, outputTokens, {
    input: primary.cost.input,
    output: primary.cost.output,
  });

  if (estimate > budget.limit * 0.6) {
    emit({
      type: "notice",
      level: "warn",
      text:
        `Estimated ${budget.formatted(estimate)} for ${units.length} unit(s) against a ${budget.formatted(budget.limit)} budget — ` +
        `expect an early downgrade. Raise it with --budget if you want the primary model throughout.`,
    });
  }
}
