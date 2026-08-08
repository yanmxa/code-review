import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { PlatformAdapter } from "../platform/adapter.js";
import type { Redactor } from "../security/redactor.js";
import type { PlatformId, PrSnapshot, ReviewUnit } from "../types.js";

/**
 * How much a tool's output is worth as evidence.
 *
 * This is the field that makes confidence grading mechanical rather than a vibe:
 * a finding is promoted to "adoptable" only when it cites a tool whose output is
 * reproducible without an LLM.
 */
export type EvidenceKind = "rule" | "static" | "llm";

export interface ToolMeta {
  id: string;
  evidenceKind: EvidenceKind;
  /** Restrict to certain hosts; omit for all. */
  platforms?: PlatformId[];
  enabledByDefault: boolean;
  /** Shown in the TUI activity pane so users can see what a tool costs them. */
  costHint: "free" | "cheap";
  /** One line for the system prompt's tool list. */
  promptSnippet: string;
}

/** Everything a tool may reach. Deliberately narrow: no shell, no filesystem. */
export interface ToolContext {
  adapter: PlatformAdapter;
  snapshot: PrSnapshot;
  unit: ReviewUnit;
  redactor: Redactor;
  /** Current context budget for file reads; shrinks when the budget is squeezed. */
  fileContextLines: number;
  signal?: AbortSignal;
  /** Report progress to the TUI without the tool knowing a TUI exists. */
  report?: (summary: string) => void;
}

/**
 * A tool, declared.
 *
 * `build` is a closure factory rather than a bare AgentTool because a tool needs
 * per-unit context (which PR, which file, which budget) that does not exist at
 * module load. The pipeline calls `build` once per unit and never learns what
 * any individual tool does.
 */
export interface ToolSpec {
  meta: ToolMeta;
  build(context: ToolContext): AgentTool;
}

export function defineReviewTool(spec: ToolSpec): ToolSpec {
  return spec;
}

/**
 * Identity helper that infers a tool's parameter type from its schema.
 *
 * Without it, `TParams` would have to be inferred through `build`'s return type,
 * which is circular — the object literal is contextually typed by the very
 * generic being inferred — and collapses `params` to `unknown`. Passing the tool
 * as a direct argument gives inference something to work from.
 */
export function reviewTool<TParams extends TSchema, TDetails>(
  tool: AgentTool<TParams, TDetails>,
): AgentTool<TParams, TDetails> {
  return tool;
}

/** Shape returned by the submit_findings tool, before grading. */
export interface RawFinding {
  path: string;
  line: number;
  endLine?: number;
  severity: string;
  title: string;
  body: string;
  suggestion?: string;
  supportingToolCalls?: string[];
  reasoning?: string;
  certainty?: string;
}

export interface SubmitDetails {
  submitted: RawFinding[];
}
