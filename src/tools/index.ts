import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PlatformId } from "../types.js";
import { getFileTool } from "./get-file.js";
import { searchDiffTool } from "./search-diff.js";
import { submitFindingsTool } from "./submit-findings.js";
import { tsSyntaxCheckTool } from "./ts-syntax-check.js";
import type { ToolContext, ToolSpec } from "./spec.js";

/**
 * The tool registry.
 *
 * This list is the entire extension point. Adding a capability — a typechecker,
 * a linter, a dependency-advisory lookup — is a new file plus one line here.
 * No pipeline stage, prompt, or grading rule needs to change: the prompt is
 * generated from `meta.promptSnippet`, and confidence grading reads
 * `meta.evidenceKind`.
 *
 * An explicit array is preferred over filesystem auto-discovery: it type-checks,
 * survives bundling, and makes the enabled set reviewable in one glance.
 */
export const TOOL_REGISTRY: ToolSpec[] = [
  getFileTool,
  searchDiffTool,
  tsSyntaxCheckTool,
  submitFindingsTool,
] as ToolSpec[];

export interface ToolSelection {
  tools: AgentTool[];
  /** Lines describing the active tools, spliced into the system prompt. */
  promptSnippets: string[];
  /** toolId -> evidenceKind, consumed by the confidence grader. */
  evidenceKinds: Map<string, ToolSpec["meta"]["evidenceKind"]>;
}

/**
 * Instantiate the tools active for one review unit.
 *
 * `overrides` comes from config (`{"ts-syntax-check": false}`); unknown ids are
 * ignored so a stale config never breaks a run.
 */
export function selectTools(
  context: ToolContext,
  platform: PlatformId,
  overrides: Record<string, boolean> = {},
): ToolSelection {
  const tools: AgentTool[] = [];
  const promptSnippets: string[] = [];
  const evidenceKinds = new Map<string, ToolSpec["meta"]["evidenceKind"]>();

  for (const spec of TOOL_REGISTRY) {
    const enabled = overrides[spec.meta.id] ?? spec.meta.enabledByDefault;
    if (!enabled) continue;
    if (spec.meta.platforms && !spec.meta.platforms.includes(platform)) continue;

    const tool = spec.build(context);
    tools.push(tool as AgentTool);
    promptSnippets.push(spec.meta.promptSnippet);
    evidenceKinds.set(tool.name, spec.meta.evidenceKind);
  }

  return { tools, promptSnippets, evidenceKinds };
}

export type { ToolContext, ToolSpec } from "./spec.js";
export { defineReviewTool } from "./spec.js";
