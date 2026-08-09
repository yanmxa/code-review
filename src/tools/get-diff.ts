import { Type } from "typebox";
import { renderHunks } from "../platform/diff.js";
import { defineReviewTool, reviewTool } from "./spec.js";

/**
 * The changed lines of any file in this pull request.
 *
 * A reviewer's most valuable observation is usually about two places at once —
 * a contract altered on one side, a migration that no longer matches its model.
 * Until now the only way to look at another file's changes was `search_diff`,
 * which answers "does this pattern appear" and not "what happened here". A
 * suspicion you can only test by guessing a regular expression mostly goes
 * uninvestigated.
 *
 * The diff is already redacted: it comes from the snapshot, which was scanned
 * once on arrival, so nothing here can reach the model that was not already
 * cleared to.
 */
export const getDiffTool = defineReviewTool({
  meta: {
    id: "get_diff",
    evidenceKind: "llm",
    enabledByDefault: true,
    costHint: "free",
    promptSnippet:
      "get_diff — read the changed lines of any file in this pull request, to check a suspicion about another file.",
  },
  build(context) {
    return reviewTool({
      name: "get_diff",
      label: "Read a file's diff",
      description:
        "Return the diff hunks for one changed file in this pull request. Use it when a change here " +
        "implies something should also have changed somewhere else, or when you need to see what a " +
        "file's change actually was rather than searching it for a pattern. Call `list_changed_files` " +
        "first if you are unsure of the exact path.",
      parameters: Type.Object({
        path: Type.String({ description: "Path of a file changed in this pull request." }),
      }),
      async execute(_toolCallId, params) {
        const { path } = params as { path: string };
        const file = context.snapshot.files.find((entry) => entry.path === path);

        if (!file) {
          const near = context.snapshot.files
            .filter((entry) => entry.path.includes(path) || path.includes(entry.path))
            .map((entry) => entry.path)
            .slice(0, 5);
          context.report?.(`${path} is not in this PR`);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `\`${path}\` is not one of the files changed in this pull request.` +
                  (near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : "") +
                  ` Use get_file to read a file the PR did not change.`,
              },
            ],
            details: { found: false, hunks: 0 },
          };
        }

        if (file.binary || file.hunks.length === 0) {
          return {
            content: [{ type: "text" as const, text: `\`${path}\` has no textual diff (${file.change}).` }],
            details: { found: true, hunks: 0 },
          };
        }

        context.report?.(`${path} (+${file.additions}/-${file.deletions})`);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `\`${path}\` — ${file.change} (+${file.additions} / -${file.deletions})\n\n` +
                `\`\`\`diff\n${renderHunks(file.hunks)}\n\`\`\``,
            },
          ],
          details: { found: true, hunks: file.hunks.length },
        };
      },
    });
  },
});

/**
 * What this pull request touched, as a list.
 *
 * The per-file pass never needed it — it was handed its file. A pass that has
 * to decide *where to look* cannot start without knowing what there is.
 */
export const listChangedFilesTool = defineReviewTool({
  meta: {
    id: "list_changed_files",
    evidenceKind: "llm",
    enabledByDefault: true,
    costHint: "free",
    promptSnippet: "list_changed_files — list every file this pull request changes, with its size.",
  },
  build(context) {
    return reviewTool({
      name: "list_changed_files",
      label: "List changed files",
      description: "List every file changed by this pull request, with its change type and line counts.",
      parameters: Type.Object({}),
      async execute() {
        const lines = context.snapshot.files.map(
          (file) => `- \`${file.path}\` — ${file.change} (+${file.additions} / -${file.deletions})`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: lines.length > 0 ? lines.join("\n") : "This pull request changes no files.",
            },
          ],
          details: { count: lines.length },
        };
      },
    });
  },
});
