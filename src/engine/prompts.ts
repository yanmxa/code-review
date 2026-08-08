import type { Language } from "../config.js";
import type { PrSnapshot, ReviewUnit } from "../types.js";
import type { RuleHit } from "./rules-engine.js";

/**
 * The reviewer persona.
 *
 * Two things it insists on, both of which exist to keep downstream stages honest:
 * anchor every finding to a changed line (so it can be posted), and cite the
 * tool calls that back it (so confidence grading has something to verify).
 */
export function SYSTEM_PROMPT(toolSnippets: string[], lang: Language): string {
  const language =
    lang === "zh"
      ? "Write finding titles and bodies in Simplified Chinese. Keep code identifiers, file paths and error codes in their original form."
      : "Write finding titles and bodies in English.";

  return `You are a precise, senior code reviewer working through one file of a pull request at a time.

## What you are looking for, in priority order

1. Correctness bugs the change introduces: wrong conditions, off-by-one, unhandled null/undefined,
   race conditions, resource leaks, incorrect error handling, broken invariants.
2. Security problems: injection, unsafe deserialization, missing authorization checks, secrets in code,
   unsafe use of user input.
3. Behaviour the change breaks elsewhere: signatures that no longer match their callers, renamed
   things still referenced by the old name, contracts silently altered.
4. Only then: clarity and maintainability, and only when the cost of the comment is worth it.

## What you must not do

- Do not comment on formatting, import order, or anything a formatter owns.
- Do not restate what the diff does. A reviewer can read.
- Do not report a problem you cannot point at a specific line for.
- Do not speculate about code you have not read. If you need to see more, use a tool.
- Do not invent tool call ids. Cite only ids you actually received results from.

## Available tools

${toolSnippets.map((snippet) => `- ${snippet}`).join("\n")}

## How to finish

Call \`submit_findings\` exactly once as your final action. Reporting zero findings is a normal and
frequent outcome — a clean file is a real result, and a padded review is worse than a short one.

Anchor every finding to a line number in the NEW version of the file, on a line the diff touches.
For each finding, list in \`supportingToolCalls\` the ids of the tool calls whose output supports it.
Findings backed by verifiable tool output are presented to the user as directly adoptable; findings
backed only by your reasoning are presented as suggestions. Both are useful — grade yourself honestly.

${language}`;
}

/** The per-unit user message: the diff, plus whatever the rules pass already found. */
export function buildUnitPrompt(
  unit: ReviewUnit,
  ruleHits: RuleHit[],
  snapshot: PrSnapshot,
  lang: Language,
): string {
  const parts: string[] = [];

  parts.push(
    `# Pull request\n\n` +
      `Title: ${snapshot.meta.title}\n` +
      `Branch: ${snapshot.meta.sourceBranch} → ${snapshot.meta.targetBranch}\n` +
      `Author: ${snapshot.meta.author}`,
  );

  const description = snapshot.meta.description.trim();
  if (description.length > 0) {
    parts.push(`## Description\n\n${truncate(description, 2000)}`);
  }

  parts.push(
    `# File under review: \`${unit.path}\`\n\n` +
      `Change type: ${unit.change} (+${unit.additions} / -${unit.deletions})` +
      (unit.id !== unit.path ? `\nThis is part ${unit.id.split("#")[1]} of a file split across units.` : ""),
  );

  parts.push(`## Diff\n\n\`\`\`diff\n${unit.patch}\n\`\`\``);

  if (ruleHits.length > 0) {
    parts.push(
      `## Deterministic checks already flagged these lines\n\n` +
        ruleHits.map((hit) => `- \`${hit.path}:${hit.line}\` — ${hit.title} (rule \`${hit.ruleId}\`)`).join("\n") +
        `\n\nThese are already reported with their own evidence; do not duplicate them. ` +
        `Use them as signal about what kind of change this is.`,
    );
  }

  parts.push(
    lang === "zh"
      ? "现在审查这个文件。需要更多上下文时调用工具，完成后调用 submit_findings。"
      : "Review this file now. Use tools when you need more context, then call submit_findings.",
  );

  return parts.join("\n\n");
}

/** Prompt for the PR-level pass. Operates on unit summaries, never raw diffs. */
export function buildCrossFilePrompt(
  snapshot: PrSnapshot,
  summaries: { unitId: string; summary: string }[],
  lang: Language,
): string {
  return [
    `# Pull request\n\nTitle: ${snapshot.meta.title}\nBranch: ${snapshot.meta.sourceBranch} → ${snapshot.meta.targetBranch}`,
    `# Per-file review results\n\n${summaries
      .map((entry) => `- \`${entry.unitId}\`: ${entry.summary}`)
      .join("\n")}`,
    `Each file above was reviewed on its own. Look for problems that only appear when you consider ` +
      `the change as a whole: a change made in one file but not its counterpart, an interface altered ` +
      `on one side only, a migration applied inconsistently.\n\n` +
      `Use search_diff to check suspicions against the actual changed lines. Report only cross-file ` +
      `problems — anything visible within a single file has already been covered. Reporting nothing ` +
      `is the expected outcome for most pull requests.\n\n` +
      `Anchor each finding to a real changed line and call submit_findings when done.`,
    lang === "zh" ? "用简体中文书写结论。" : "Write your conclusions in English.",
  ].join("\n\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}
