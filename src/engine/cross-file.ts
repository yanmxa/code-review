import type { Models } from "@earendil-works/pi-ai";
import type { BudgetManager } from "../budget/budget.js";
import type { RunStore } from "../checkpoint/store.js";
import type { Config } from "../config.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import { Redactor } from "../security/redactor.js";
import { selectTools, type ToolContext } from "../tools/index.js";
import { Tracer } from "../trace/tracer.js";
import type { Finding, PrSnapshot, ReviewUnit, RunEventSink } from "../types.js";
import { dedupe, gradeAgentFinding } from "./grade.js";
import { buildCrossFilePrompt, CROSS_FILE_SYSTEM_PROMPT } from "./prompts.js";
import { runAgentPass } from "./review-agent.js";

/**
 * The id of the pull-request pass, as a unit.
 *
 * Registering it in the checkpoint alongside the files costs nothing and buys
 * resume, progress, and budget forecasting for free — the alternative was a
 * special case in each of them. The leading `#` cannot collide with a path.
 */
export const CROSS_FILE_UNIT_ID = "#pull-request";

/** A stand-in unit so the pass can use the same tools, tracer and store as any file. */
export function crossFileUnit(): ReviewUnit {
  return {
    id: CROSS_FILE_UNIT_ID,
    path: CROSS_FILE_UNIT_ID,
    change: "modified",
    hunks: [],
    additions: 0,
    deletions: 0,
    patch: Redactor.trusted(""),
  };
}

export interface CrossFileDeps {
  models: Models;
  adapter: PlatformAdapter;
  snapshot: PrSnapshot;
  config: Config;
  budget: BudgetManager;
  store: RunStore;
  redactor: Redactor;
  emit: RunEventSink;
  signal?: AbortSignal;
  summaries: { unitId: string; summary: string }[];
  /** Everything already reported, so the pass does not say it a second time. */
  reported: Finding[];
}

export interface CrossFileResult {
  findings: Finding[];
  summary: string;
  spendUsd: number;
  status: "done" | "failed";
}

/**
 * Review the pull request as a whole, once every file has been read alone.
 *
 * This is the pass that justifies calling the thing an agent rather than a
 * pipeline. The per-file loop is a sweep: the program decides what is looked
 * at, in what order, for how long, and each file is reviewed by an agent with
 * no memory of the others. That is the right shape for coverage — predictable
 * spend, clean checkpoints — and it is structurally blind to the findings a
 * reviewer is actually valued for, which are about two places at once.
 *
 * Here the model decides where to look. It is given the intent (title,
 * description), the shape of the change, what each file's own review concluded,
 * and tools to go and read anything it wants. The same `streamFn` meters and
 * traces it, so agency costs nothing in accountability.
 */
export async function reviewPullRequest(deps: CrossFileDeps): Promise<CrossFileResult> {
  const { config, store, budget, redactor, emit } = deps;
  const unit = crossFileUnit();
  const tracer = Tracer.forUnit(store.dirs.root, unit.id, redactor);

  const toolContext: ToolContext = {
    adapter: deps.adapter,
    snapshot: deps.snapshot,
    unit,
    redactor,
    fileContextLines: budget.squeezed
      ? config.fileContextLinesSqueezed
      : config.fileContextLines,
    signal: deps.signal,
  };
  const selection = selectTools(toolContext, deps.snapshot.target.platform, config.tools);

  const staticHits: { toolId: string; path: string; line: number; diagnostic: string }[] = [];
  const result = await runAgentPass(
    unit,
    {
      system: (snippets) => CROSS_FILE_SYSTEM_PROMPT(snippets, config.lang, config.review),
      user: buildCrossFilePrompt(
        deps.snapshot,
        deps.summaries,
        deps.reported.map((finding) => ({
          path: finding.path,
          line: finding.line,
          title: finding.title,
        })),
        config.lang,
        config.review.prompt,
      ),
      nudge:
        "You are out of turns. Call submit_findings now with whatever cross-file problems you " +
        "confirmed. An empty list is the expected answer if you found none.",
      maxTurns: config.maxTurnsPerPullRequest,
    },
    {
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
    },
  );

  // Anchoring across files is the whole point, so the anchor check looks up the
  // hunks of whatever file the finding names rather than the unit's own — which
  // are empty here, and would reject every finding.
  const byPath = new Map(deps.snapshot.files.map((file) => [file.path, file.hunks]));
  const findings = dedupe(
    result.raw
      .map((raw) =>
        gradeAgentFinding(raw, {
          unit,
          tracePath: tracer.relativePath,
          toolCallNames: result.toolCallNames,
          evidenceKinds: selection.evidenceKinds,
          staticHits,
          hunksFor: (path) => byPath.get(path),
        }),
      )
      .filter((finding): finding is Finding => finding !== null),
  );

  return {
    findings,
    summary: `${findings.length} cross-file finding(s)`,
    spendUsd: result.spendUsd,
    status: result.status,
  };
}
