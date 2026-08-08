import { Type } from "typebox";
import { defineReviewTool, reviewTool } from "./spec.js";

export interface SearchDiffDetails {
  pattern: string;
  count: number;
}

/**
 * Grep the PR's own diff.
 *
 * Answers the question a single-file reviewer cannot: "was this renamed
 * everywhere?", "does any other file in this PR still call the old signature?".
 * It searches only the diff already in memory — no network, no repository.
 */
export const searchDiffTool = defineReviewTool({
  meta: {
    id: "search_diff",
    evidenceKind: "llm",
    enabledByDefault: true,
    costHint: "free",
    promptSnippet:
      "search_diff — search every file changed in this PR for a pattern, to check consistency across files.",
  },
  build(context) {
    return reviewTool({
      name: "search_diff",
      label: "Search diff",
      description:
        "Search all files changed in this pull request for a regular expression. Use this to check " +
        "whether a change was applied consistently — for example whether a renamed function still " +
        "has old call sites, or whether a new flag is handled everywhere it is read. " +
        "Returns matching changed lines with their file and line number.",
      parameters: Type.Object({
        pattern: Type.String({ description: "JavaScript regular expression source, e.g. \\bgetUser\\(" }),
        maxResults: Type.Optional(Type.Number({ description: "Cap on returned matches (default 40)." })),
      }),
      async execute(_toolCallId, params) {
        context.report?.(params.pattern);

        let regex: RegExp;
        try {
          regex = new RegExp(params.pattern, "gi");
        } catch (error) {
          throw new Error(`Invalid regular expression: ${(error as Error).message}`);
        }

        const limit = Math.min(params.maxResults ?? 40, 200);
        const matches: string[] = [];

        outer: for (const file of context.snapshot.files) {
          for (const hunk of file.hunks) {
            for (const line of hunk.lines) {
              if (line.kind === "context") continue;
              regex.lastIndex = 0;
              if (!regex.test(line.text)) continue;
              const marker = line.kind === "add" ? "+" : "-";
              const lineNo = line.newLine ?? line.oldLine ?? 0;
              matches.push(`${file.path}:${lineNo}: ${marker}${line.text.trim()}`);
              if (matches.length >= limit) break outer;
            }
          }
        }

        const text =
          matches.length === 0
            ? `No changed line matches /${params.pattern}/.`
            : `${matches.length} matching changed line(s):\n\n${matches.join("\n")}`;

        return {
          content: [{ type: "text" as const, text }],
          details: { pattern: params.pattern, count: matches.length },
        };
      },
    });
  },
});
