import type { BudgetLimit, BudgetUnit } from "./budget/limit.js";

/**
 * Core domain types shared across the pipeline.
 *
 * Everything here is JSON-serializable on purpose: the checkpoint store persists
 * these shapes verbatim, so a run can be resumed by a different process.
 */

// ---------------------------------------------------------------------------
// Redaction brand
// ---------------------------------------------------------------------------

declare const redactedBrand: unique symbol;

/**
 * A string that has passed through {@link Redactor.redact}.
 *
 * The brand is the enforcement mechanism for the "no secrets to the LLM" rule:
 * anything that ships text to a model or to disk accepts only `Redacted`, so
 * forgetting to redact is a compile error rather than a leak.
 */
export type Redacted = string & { readonly [redactedBrand]: true };

// ---------------------------------------------------------------------------
// Platform / PR
// ---------------------------------------------------------------------------

export type PlatformId = "github" | "gitlab";

/** A parsed PR/MR locator. */
export interface Target {
  platform: PlatformId;
  /** GitHub: "owner". GitLab: full namespace path, e.g. "group/sub". */
  owner: string;
  repo: string;
  /** GitHub PR number, GitLab MR iid. */
  number: number;
  /** API base, e.g. https://api.github.com or https://gitlab.com/api/v4 */
  apiBase: string;
  /** Human-facing URL the user passed in. */
  webUrl: string;
}

export interface PrMeta {
  title: string;
  /** PR body/description. Redacted — descriptions routinely contain tokens. */
  description: Redacted;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  baseSha: string;
  headSha: string;
  /** GitLab needs start_sha for discussion positions; GitHub leaves it undefined. */
  startSha?: string;
  state: string;
  additions?: number;
  deletions?: number;
}

export interface PrSnapshot {
  target: Target;
  meta: PrMeta;
  /** Raw unified diff of the whole PR, redacted. */
  diff: Redacted;
  files: DiffFile[];
}

// ---------------------------------------------------------------------------
// Diff model
// ---------------------------------------------------------------------------

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the pre-image, undefined for added lines. */
  oldLine?: number;
  /** Line number in the post-image, undefined for deleted lines. */
  newLine?: number;
  /** Line body without the leading +/-/space marker. */
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The `@@ ... @@` header line as it appeared in the diff. */
  header: string;
  lines: DiffLine[];
}

export type FileChangeKind = "added" | "modified" | "deleted" | "renamed" | "binary";

export interface DiffFile {
  /** Post-image path (pre-image path for deletions). */
  path: string;
  oldPath?: string;
  change: FileChangeKind;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** True when the diff carried no textual hunks (binary, or too large for the host). */
  binary: boolean;
}

// ---------------------------------------------------------------------------
// Review units
// ---------------------------------------------------------------------------

export type UnitStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";

export type SkipReason = "binary" | "generated" | "triage" | "budget" | "empty";

/** One reviewable slice of the PR: a whole file, or a group of hunks from one file. */
export interface ReviewUnit {
  /** Stable id: `path` or `path#2` when a file is split. */
  id: string;
  path: string;
  change: FileChangeKind;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** Rendered diff text for this unit, redacted — this is what the model sees. */
  patch: Redacted;
}

// ---------------------------------------------------------------------------
// Findings & evidence
// ---------------------------------------------------------------------------

export type Severity = "blocker" | "major" | "minor" | "nit";

export type Confidence = "adoptable" | "reference";

/**
 * How sure the model says it is — its own view, never a verdict.
 *
 * Deliberately not called confidence. `Confidence` above is the tier, and it is
 * decided by evidence anyone can re-derive; this is the model grading its own
 * homework. Keeping the two words apart in the code is the same reason they are
 * kept apart on screen: a "high confidence" badge sitting inside the
 * reference group would quietly undo the distinction the tiers exist to make.
 */
export type Certainty = "certain" | "likely" | "unsure";

/**
 * Why we believe a finding.
 *
 * `rule` and `static` come from deterministic machinery and are the only kinds
 * that can promote a finding to `adoptable`. `llm` is model reasoning alone.
 */
export type Evidence =
  | { kind: "rule"; ruleId: string; path: string; line: number; excerpt: string }
  | { kind: "static"; toolId: string; diagnostic: string; path: string; line: number }
  | { kind: "llm"; reasoning: string };

export interface Finding {
  id: string;
  unitId: string;
  path: string;
  /** Post-image line the comment anchors to. */
  line: number;
  endLine?: number;
  severity: Severity;
  title: string;
  /** Explanation body, markdown. Already redacted. */
  body: string;
  /** Optional replacement snippet rendered as a GitHub ```suggestion block. */
  suggestion?: string;
  evidence: Evidence[];
  confidence: Confidence;
  /** Model's own reading of how solid this is. Orders findings; never promotes one. */
  certainty?: Certainty;
  /** Stable identity for dedupe and post-idempotency. */
  fingerprint: string;
  /** Relative path of the trace file that produced this finding. */
  tracePath: string;
  source: "rule" | "agent" | "merged";
  /** Set by the optional --verify pass. Annotates only; never changes `confidence`. */
  verification?: { refuted: boolean; note: string; model: string };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface ModelRef {
  provider: string;
  id: string;
}

export type { BudgetLimit, BudgetUnit } from "./budget/limit.js";

export interface BudgetConfig {
  /** What the run may consume, and in which unit. */
  limit: BudgetLimit;
  /** Only consulted when the limit is denominated in CNY. */
  usdToCny: number;
  /**
   * Models in priority order. No thresholds: the run steps down one rung
   * whenever it is projected to overrun, so the numbers that used to live here
   * were describing the control loop rather than the user's preference.
   */
  models: ModelRef[];
}

export interface SpendLedger {
  /** Always tracked, whatever the limit's unit — providers bill in USD. */
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  calls: number;
  byModel: Record<string, { usd: number; calls: number; inputTokens: number; outputTokens: number }>;
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

/**
 * A trace event without its ordering fields — what callers construct.
 * `TraceEvent` adds `ts`/`seq` as an intersection so the union still
 * discriminates on `type` when reading a trace back.
 */
export type TraceEventPayload =
  | { type: "unit_start"; unitId: string; model: string; patchSha: string }
  | { type: "llm_request"; model: string; systemPrompt: string; messages: unknown[]; toolNames: string[] }
  | {
      type: "llm_response";
      model: string;
      stopReason: string;
      content: unknown[];
      usage: { input: number; output: number; cacheRead: number; costUsd: number };
      errorMessage?: string;
    }
  | { type: "tool_call"; toolCallId: string; name: string; params: unknown }
  | { type: "tool_result"; toolCallId: string; name: string; preview: string; isError: boolean }
  | { type: "rule_hit"; ruleId: string; path: string; line: number }
  | { type: "redaction"; ruleId: string; count: number; placeholders: string[] }
  | { type: "budget"; kind: "downgrade" | "squeeze" | "hard_stop"; detail: string }
  | { type: "resumed"; note: string }
  | { type: "unit_end"; findingIds: string[]; spendUsd: number; status: UnitStatus; note?: string };

export type TraceEvent = TraceEventPayload & { ts: string; seq: number };

// ---------------------------------------------------------------------------
// Run state (checkpoint)
// ---------------------------------------------------------------------------

export interface UnitState {
  id: string;
  path: string;
  status: UnitStatus;
  skipReason?: SkipReason;
  findings: number;
  spendUsd: number;
  attempts: number;
}

export interface RunState {
  version: 1;
  runId: string;
  prUrl: string;
  platform: PlatformId;
  headSha: string;
  /** sha256 of the raw diff; a mismatch means the PR moved and the run is stale. */
  diffHash: string;
  startedAt: string;
  updatedAt: string;
  spend: SpendLedger;
  /** The budget this run was given, so a later report never guesses at it. */
  budget?: { limit: number; unit: BudgetUnit; usdToCny: number };
  /** The `--prompt` note, so resuming reviews the rest the same way. */
  prompt?: string;
  ladderStage: number;
  squeezed: boolean;
  hardStopped: boolean;
  units: UnitState[];
  crossFileDone: boolean;
  finished: boolean;
}

// ---------------------------------------------------------------------------
// Run events (drive both TUI and plain renderers)
// ---------------------------------------------------------------------------

export type RunEvent =
  | { type: "run_start"; snapshot: PrSnapshot; units: ReviewUnit[]; resumed: boolean; model: ModelRef }
  | { type: "unit_start"; unitId: string }
  | { type: "unit_end"; unitId: string; status: UnitStatus; findings: number; skipReason?: SkipReason }
  | { type: "tool_start"; unitId: string; name: string; summary: string }
  | { type: "tool_end"; unitId: string; name: string; summary: string; isError: boolean }
  | { type: "stream_delta"; unitId: string; text: string }
  | {
      type: "spend";
      ledger: SpendLedger;
      fraction: number;
      model: ModelRef;
      /** The budget's unit, so renderers never assume a currency. */
      unit: BudgetUnit;
      limit: number;
      spent: number;
      /** Forecast total once at least one unit has finished. */
      projected?: number;
    }
  | { type: "budget"; kind: "downgrade" | "squeeze" | "hard_stop"; detail: string }
  | { type: "finding"; finding: Finding }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "run_end"; findings: Finding[]; state: RunState; reportPath?: string };

export type RunEventSink = (event: RunEvent) => void;
