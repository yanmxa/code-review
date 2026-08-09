import type { Language, ReviewConfig } from "../config.js";
import type { CheckSummary } from "../platform/adapter.js";
import type { PrSnapshot, ReviewUnit } from "../types.js";
import type { RuleHit } from "./rules-engine.js";

/**
 * The reviewer persona.
 *
 * Two things it insists on, both of which exist to keep downstream stages honest:
 * anchor every finding to a changed line (so it can be posted), and cite the
 * tool calls that back it (so confidence grading has something to verify).
 */
export function SYSTEM_PROMPT(
  toolSnippets: string[],
  lang: Language,
  review?: ReviewConfig,
): string {
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

${language}${projectSection(review)}`;
}

/**
 * What this project asks of a reviewer, spliced into the persona.
 *
 * The built-in instructions describe a competent reviewer of code in general.
 * They cannot know that this is a Go service where unwrapped errors matter, or
 * that this team has settled its naming arguments and does not want them
 * reopened. Only the project knows that, and without a way to say it the
 * reviewer keeps making the same off-target comments.
 */
function projectSection(review?: ReviewConfig): string {
  if (!review) return "";
  const parts: string[] = [];

  if (review.focus?.trim()) {
    parts.push(`## What this project cares about\n\n${review.focus.trim()}`);
  }
  if (review.ignore.length > 0) {
    parts.push(
      `## Settled here — do not raise\n\n` +
        review.ignore.map((topic) => `- ${topic}`).join("\n") +
        `\n\nThese have been decided. Raising them again wastes the reader's attention.`,
    );
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

/** The per-unit user message: the diff, plus whatever the rules pass already found. */
export function buildUnitPrompt(
  unit: ReviewUnit,
  ruleHits: RuleHit[],
  snapshot: PrSnapshot,
  lang: Language,
  checks?: CheckSummary,
  note?: string,
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

  // A failing test suite is the highest-signal evidence available about a
  // change, and it is a fact rather than an inference. Handing the agent the
  // actual failures lets it connect them to the diff; without this it would be
  // reasoning about correctness while the answer sat one API call away.
  if (checks && checks.conclusion !== "success") {
    const failing = checks.failed.map((run) => `- \`${run.name}\`: ${run.summary ?? "failed"}`).join("\n");
    const related = checks.annotations
      .filter((note) => note.path === unit.path)
      .slice(0, 20)
      .map((note) => `- \`${note.path}:${note.line}\` ${note.message}`)
      .join("\n");

    parts.push(
      `## Continuous integration is currently ${checks.conclusion}\n\n${failing}` +
        (related
          ? `\n\n### Reported against this file\n\n${related}\n\n` +
            `These are machine-produced diagnostics. If one explains a problem in this diff, ` +
            `say so and cite it — that is far stronger than reasoning from the diff alone.`
          : `\n\nNo diagnostic points at this file. Do not assume the failure is caused here.`),
    );
  }

  if (ruleHits.length > 0) {
    parts.push(
      `## Deterministic checks already flagged these lines\n\n` +
        ruleHits.map((hit) => `- \`${hit.path}:${hit.line}\` — ${hit.title} (rule \`${hit.ruleId}\`)`).join("\n") +
        `\n\nThese are already reported with their own evidence; do not duplicate them. ` +
        `Use them as signal about what kind of change this is.`,
    );
  }

  // Placed last, immediately before the instruction to begin: whoever started
  // this run knows something the pull request does not say, and it should be
  // the freshest thing in context rather than buried above the diff.
  if (note?.trim()) {
    parts.push(
      `## From the person who started this review\n\n${note.trim()}\n\n` +
        `Treat this as context about the change, not as a finding to report.`,
    );
  }

  parts.push(
    lang === "zh"
      ? "现在审查这个文件。需要更多上下文时调用工具，完成后调用 submit_findings。"
      : "Review this file now. Use tools when you need more context, then call submit_findings.",
  );

  return parts.join("\n\n");
}

/**
 * The reviewer persona for the pull-request pass.
 *
 * The per-file pass asks "is anything wrong in this file", which is a linter's
 * question. This one asks a reviewer's: does the change do what it says it
 * does, coherently, across every place it had to touch. That means it has to
 * decide where to look, so it is given the tools to go and look — the previous
 * version was handed a list of summaries and asked to notice things about code
 * it could not read.
 */
export function CROSS_FILE_SYSTEM_PROMPT(
  toolSnippets: string[],
  lang: Language,
  review?: ReviewConfig,
): string {
  const language =
    lang === "zh"
      ? "Write finding titles and bodies in Simplified Chinese. Keep code identifiers, file paths and error codes in their original form."
      : "Write finding titles and bodies in English.";

  return `You are a senior engineer reviewing a pull request as a whole, after every file has already
been read on its own.

## Your question is not "is this line wrong"

Each file has been reviewed in isolation and anything visible inside one file is already reported.
Repeating it wastes the reader's attention. You are here for what isolation cannot see:

1. A change made in one place and not in its counterpart — a caller not updated with its callee, a
   field added to a model but not to the migration, a constant duplicated and changed once.
2. A contract altered on one side only: a signature, a return shape, an error type, a config key,
   an API route, a serialized format.
3. A new code path that bypasses something the codebase relies on — an auth check, a validation, a
   cleanup, a lock.
4. The change failing to do what its description says, or doing something the description does not
   mention.

## Work like a reviewer, not a scanner

Start from what this pull request is trying to do — the title, the description, and the shape of the
file list tell you that. Form a specific suspicion about where it could be incomplete, then go and
check it: \`get_diff\` shows what any changed file actually did, \`get_file\` shows the code around it
at this commit, \`search_diff\` finds a name across every change at once.

Check the suspicion before reporting it. "This might not have been updated" is not a finding; the
whole value of this pass is that you can look.

## How to finish

Call \`submit_findings\` exactly once. **Reporting nothing is the expected outcome for most pull
requests** — a coherent change is the normal case, and a padded cross-file section is worse than an
empty one because it teaches the reader to skip this whole section.

Anchor each finding to a line the diff actually touches, in whichever file makes the problem
clearest to whoever has to fix it. Say in \`reasoning\` what you checked, and be honest in
\`certainty\`: a suspicion you confirmed by reading both sides is \`certain\`, one you inferred from a
name is not.

## Available tools

${toolSnippets.map((snippet) => `- ${snippet}`).join("\n")}

${language}${projectSection(review)}`;
}

/** The per-run brief: what changed, and what each file's own review concluded. */
export function buildCrossFilePrompt(
  snapshot: PrSnapshot,
  summaries: { unitId: string; summary: string }[],
  reported: { path: string; line: number; title: string }[],
  lang: Language,
  note?: string,
): string {
  const parts: string[] = [];

  parts.push(
    `# Pull request\n\n` +
      `Title: ${snapshot.meta.title}\n` +
      `Branch: ${snapshot.meta.sourceBranch} → ${snapshot.meta.targetBranch}\n` +
      `Author: ${snapshot.meta.author}`,
  );

  const description = snapshot.meta.description.trim();
  parts.push(
    description.length > 0
      ? `## What it says it does\n\n${truncate(description, 3000)}`
      : `## What it says it does\n\nNothing — the description is empty, so the code is the only account of the intent.`,
  );

  parts.push(
    `## Files changed\n\n` +
      snapshot.files
        .map((file) => `- \`${file.path}\` — ${file.change} (+${file.additions} / -${file.deletions})`)
        .join("\n"),
  );

  if (summaries.length > 0) {
    parts.push(
      `## What each file's own review concluded\n\n` +
        summaries.map((entry) => `- \`${entry.unitId}\`: ${entry.summary}`).join("\n"),
    );
  }

  // Named so they are not reported twice. Titles only: the bodies would be a
  // large part of the context window and add nothing to "do not repeat this".
  if (reported.length > 0) {
    parts.push(
      `## Already reported — do not repeat these\n\n` +
        reported.map((item) => `- \`${item.path}:${item.line}\` ${item.title}`).join("\n"),
    );
  }

  if (note?.trim()) {
    parts.push(
      `## From the person who started this review\n\n${note.trim()}\n\n` +
        `Treat this as context about the change, not as a finding to report.`,
    );
  }

  parts.push(
    lang === "zh"
      ? "现在把这次改动作为一个整体来看。先想清楚它要做什么、哪里可能没做完，再用工具去核实，最后调用 submit_findings。没有跨文件问题就报空，这是常态。"
      : "Now look at the change as a whole. Work out what it is trying to do and where it could be " +
        "incomplete, check that with the tools, then call submit_findings. Reporting nothing is the " +
        "normal outcome.",
  );

  return parts.join("\n\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}
