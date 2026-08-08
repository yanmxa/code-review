import type { Models } from "@earendil-works/pi-ai";
import { BudgetManager } from "../budget/budget.js";
import { hashDiff, RunStore } from "../checkpoint/store.js";
import type { Config } from "../config.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import type { Redactor } from "../security/redactor.js";
import { selectTools } from "../tools/index.js";
import type { ToolContext } from "../tools/spec.js";
import { Tracer } from "../trace/tracer.js";
import type { Finding, PrSnapshot, ReviewUnit, RunEventSink, Target } from "../types.js";
import { dedupe, findingFromRule, gradeAgentFinding } from "./grade.js";
import { reviewUnit } from "./review-agent.js";
import { redactHits, runRules } from "./rules-engine.js";
import { estimateTokens, planUnits } from "./units.js";

export interface PipelineDeps {
  adapter: PlatformAdapter;
  models: Models;
  redactor: Redactor;
  config: Config;
  emit: RunEventSink;
  /**
   * True when the active credential is a subscription rather than a metered API
   * key. Under a plan the provider bills nothing per call, so every figure the
   * budget reports is a list-price estimate — useful as a work limiter, but not
   * money spent, and it must not be presented as such.
   */
  notionalSpend?: boolean;
  signal?: AbortSignal;
}

export interface PipelineResult {
  findings: Finding[];
  store: RunStore;
  snapshot: PrSnapshot;
  budget: BudgetManager;
  resumed: boolean;
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
  emit({ type: "notice", level: "info", text: `Fetching ${target.webUrl}` });
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

  // --- Plan --------------------------------------------------------------
  const { units, skipped } = planUnits(snapshot.files, config.maxUnitDiffLines);
  store.initUnits(units.map((unit) => ({ id: unit.id, path: unit.path })));

  const budget = new BudgetManager(config.budget, {
    ledger: store.current.spend,
    stage: store.current.ladderStage,
    squeezed: store.current.squeezed,
    hardStopped: false, // A resumed run gets a fresh chance; the ledger still applies.
  });
  budget.onEvent((event) => emit({ type: "budget", ...event }));

  if (deps.notionalSpend) {
    emit({
      type: "notice",
      level: "info",
      text:
        "Subscription credential in use — calls are covered by your plan. " +
        "Spend below is a list-price estimate, not money charged; it still caps how much work runs.",
    });
  }

  emit({
    type: "run_start",
    snapshot,
    units,
    resumed,
    model: budget.currentModel(),
  });

  for (const skip of skipped) {
    emit({ type: "unit_end", unitId: skip.id, status: "skipped", findings: 0, skipReason: skip.reason });
  }

  warnIfBudgetLooksTight(units, budget, models, config, emit);

  // --- Review ------------------------------------------------------------
  const findings: Finding[] = store.readFindings();
  const summaries: { unitId: string; summary: string }[] = [];

  for (const unit of units) {
    const state = store.unit(unit.id);
    if (!state || state.status === "done" || state.status === "skipped") continue;

    // Out of money, but the deterministic pass costs nothing and produces the
    // highest-value findings — running it anyway is what makes a budget-stopped
    // report worth reading instead of merely truncated.
    if (budget.checkExhausted()) {
      const rulesOnly = runRulesOnly(unit, { ...deps, snapshot, store });
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

    emit({ type: "unit_start", unitId: unit.id });
    store.markUnit(unit.id, { status: "in_progress", attempts: state.attempts + 1 });

    const unitFindings = await reviewOneUnit(unit, { ...deps, snapshot, budget, store });

    findings.push(...unitFindings.findings);
    summaries.push({ unitId: unit.id, summary: unitFindings.summary });

    store.completeUnit(unit.id, unitFindings.findings, {
      status: unitFindings.status,
      spendUsd: unitFindings.spendUsd,
    });
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
      notional: deps.notionalSpend ?? false,
    });
  }

  // --- Finish ------------------------------------------------------------
  const graded = dedupe(findings);
  store.finish();
  persistSpend(store, budget);

  return { findings: graded, store, snapshot, budget, resumed };
}

async function reviewOneUnit(
  unit: ReviewUnit,
  deps: PipelineDeps & { snapshot: PrSnapshot; budget: BudgetManager; store: RunStore },
): Promise<{ findings: Finding[]; summary: string; spendUsd: number; status: "done" | "failed" }> {
  const { config, redactor, store, budget, emit } = deps;
  const tracer = Tracer.forUnit(store.dirs.root, unit.id, redactor);

  // Deterministic pass first: its output is both a finding source and context
  // that stops the model from re-reporting what a regex already caught.
  const ruleHits = redactHits(runRules(unit, config.lang), redactor);
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
    summary:
      findings.length === 0
        ? "no findings"
        : `${findings.length} finding(s): ${findings.map((f) => f.title).slice(0, 3).join("; ")}`,
    spendUsd: result.spendUsd,
    status: result.status,
  };
}

/** The zero-cost half of a unit review, for when there is no budget left. */
function runRulesOnly(
  unit: ReviewUnit,
  deps: PipelineDeps & { snapshot: PrSnapshot; store: RunStore },
): Finding[] {
  const tracer = Tracer.forUnit(deps.store.dirs.root, unit.id, deps.redactor);
  tracer.write({ type: "budget", kind: "hard_stop", detail: "rules-only pass; no model calls" });

  const hits = redactHits(runRules(unit, deps.config.lang), deps.redactor);
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
  store.updateSpend(snapshot.ledger, snapshot.stage, snapshot.squeezed, snapshot.hardStopped);
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
  const primary = models.getModel(config.models.primary.provider, config.models.primary.id);
  if (!primary) return;

  const inputTokens = units.reduce((sum, unit) => sum + estimateTokens(unit.patch) + 900, 0);
  const outputTokens = units.length * 700;
  const estimate = budget.estimateCny(inputTokens, outputTokens, {
    input: primary.cost.input,
    output: primary.cost.output,
  });

  if (estimate > budget.totalCny * 0.6) {
    emit({
      type: "notice",
      level: "warn",
      text:
        `Estimated ¥${estimate.toFixed(2)} for ${units.length} unit(s) against a ¥${budget.totalCny.toFixed(2)} budget — ` +
        `expect an early downgrade. Raise it with --budget if you want the primary model throughout.`,
    });
  }
}
