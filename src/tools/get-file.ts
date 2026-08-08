import { Type } from "typebox";
import { defineReviewTool, reviewTool } from "./spec.js";

export interface GetFileDetails {
  path: string;
  found: boolean;
  start?: number;
  end?: number;
  totalLines?: number;
}

/**
 * Read a file from the PR's head commit.
 *
 * The diff alone is not enough to judge most findings — "is this lock ever
 * released?" needs the rest of the function. This fetches through the host's
 * API, so the repository is never cloned and nothing in it is executed.
 */
export const getFileTool = defineReviewTool({
  meta: {
    id: "get_file",
    evidenceKind: "llm",
    enabledByDefault: true,
    costHint: "free",
    promptSnippet: "get_file — read a file at the PR head commit to see code the diff does not show.",
  },
  build(context) {
    const cache = new Map<string, string | null>();

    return reviewTool({
      name: "get_file",
      label: "Read file",
      description:
        "Read the full contents of a file at the pull request's head commit. Use this when the diff " +
        "alone is not enough to decide whether something is a real problem — for example to check " +
        "how a changed function is called, or whether a resource is released elsewhere. " +
        "Returns line-numbered text. Secrets are masked before you see them.",
      parameters: Type.Object({
        path: Type.String({
          description: "Repository-relative path, e.g. src/cache/store.ts",
        }),
        startLine: Type.Optional(
          Type.Number({ description: "First line to return (1-based). Defaults to 1." }),
        ),
      }),
      async execute(_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: GetFileDetails }> {
        const path = params.path.replace(/^\.?\//, "");
        context.report?.(path);

        if (!cache.has(path)) {
          const content = await context.adapter.fetchFile(
            context.snapshot.target,
            path,
            context.snapshot.meta.headSha,
          );
          cache.set(path, content);
        }
        const content = cache.get(path) ?? null;

        if (content === null) {
          return {
            content: [{ type: "text" as const, text: `File not found at head commit: ${path}` }],
            details: { path, found: false },
          };
        }

        const lines = content.split("\n");
        const start = Math.max(1, params.startLine ?? 1);
        const end = Math.min(lines.length, start - 1 + context.fileContextLines);
        const slice = lines
          .slice(start - 1, end)
          .map((line, index) => `${String(start + index).padStart(5)}  ${line}`)
          .join("\n");

        const truncated = end < lines.length || start > 1;
        const note = truncated
          ? `\n\n[showing lines ${start}-${end} of ${lines.length}; call again with startLine to see more]`
          : "";

        return {
          content: [{ type: "text" as const, text: `${path}\n\n${slice}${note}` }],
          details: { path, found: true, start, end, totalLines: lines.length },
        };
      },
    });
  },
});
