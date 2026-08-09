import type { DiffFile } from "../types.js";

export interface Introduced {
  path: string;
  /** What was added: a whole file, or a name other code could now call. */
  kind: "file" | "export";
  name: string;
}

/**
 * Names this change adds that something else could be expected to use.
 *
 * The cross-file question everyone knows is "did A and B stop agreeing". The
 * one that gets missed is "A was added and nobody calls it" — a retry helper
 * written and not wired in, a config key nothing reads, an error type nothing
 * catches. That is not an inconsistency between two places, it is a change that
 * stopped halfway, and it is invisible to a per-file reviewer by construction:
 * the file that introduces the thing looks complete on its own.
 *
 * Computed here rather than asked of the model, because a regular expression
 * over added lines is exact, free, and does not spend a turn. The model's job
 * is the part that needs judgement — whether the absence of a caller is a
 * mistake or simply not this pull request's business.
 */
export function introducedByChange(files: DiffFile[], limit = 40): Introduced[] {
  const out: Introduced[] = [];

  for (const file of files) {
    if (file.binary) continue;
    if (file.change === "added") out.push({ path: file.path, kind: "file", name: file.path });

    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== "add") continue;
        const name = exportedName(line.text);
        if (name) out.push({ path: file.path, kind: "export", name });
      }
    }
  }

  // A long list stops being a checklist and becomes noise; a change that adds
  // forty public names is a rewrite, and the agent is better off reading it.
  return out.slice(0, limit);
}

/**
 * The name a line makes available to other code, if it makes one.
 *
 * Deliberately shallow — it reads added lines, not a syntax tree, and it is
 * meant to prompt a question rather than settle one. Missing a name costs a
 * question that does not get asked; inventing one would cost a false finding,
 * so the patterns only match declarations that are unambiguously public.
 */
function exportedName(text: string): string | undefined {
  const line = text.trim();

  // TypeScript / JavaScript
  const ts = line.match(
    /^export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  );
  if (ts?.[1]) return ts[1];

  // Go: an exported identifier is one that starts with a capital.
  const go = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/);
  if (go?.[1]) return go[1];

  // Python: module-level definitions, ignoring the private convention.
  const py = line.match(/^(?:def|class)\s+([A-Za-z]\w*)/);
  if (py?.[1] && !py[1].startsWith("_")) return py[1];

  return undefined;
}
