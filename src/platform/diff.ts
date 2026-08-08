import type { DiffFile, DiffHunk, DiffLine, DiffLineKind, FileChangeKind } from "../types.js";

/**
 * Unified-diff parser.
 *
 * We parse the diff ourselves rather than trusting the host's per-file JSON
 * because two later stages need exact line geometry: evidence anchoring (is this
 * finding on a line the PR actually touched?) and comment placement (GitHub
 * rejects a review comment whose line is not part of the diff).
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split("\n");

  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const closeHunk = () => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };
  const closeFile = () => {
    closeHunk();
    if (current) files.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    if (line.startsWith("diff --git ")) {
      closeFile();
      const paths = parseGitHeader(line);
      current = {
        path: paths.newPath,
        change: "modified",
        hunks: [],
        additions: 0,
        deletions: 0,
        binary: false,
      };
      if (paths.oldPath !== paths.newPath) current.oldPath = paths.oldPath;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.change = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.change = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length);
      current.change = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
      current.change = "renamed";
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
      current.change = "binary";
      continue;
    }
    // `--- a/x` / `+++ b/x` are authoritative when the git header was ambiguous
    // (quoted paths, spaces). /dev/null tells us add vs delete without a mode line.
    if (line.startsWith("--- ")) {
      const p = stripPrefix(line.slice(4));
      if (p === null) current.change = "added";
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = stripPrefix(line.slice(4));
      if (p === null) current.change = "deleted";
      else if (current.change !== "renamed") current.path = p;
      continue;
    }

    if (line.startsWith("@@")) {
      closeHunk();
      const parsed = parseHunkHeader(line);
      if (!parsed) continue;
      hunk = { ...parsed, header: line, lines: [] };
      oldLine = parsed.oldStart;
      newLine = parsed.newStart;
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith("\\")) continue; // "\ No newline at end of file"

    const marker = line[0];
    const text = line.slice(1);
    let entry: DiffLine | null = null;

    if (marker === "+") {
      entry = { kind: "add", newLine, text };
      newLine++;
      current.additions++;
    } else if (marker === "-") {
      entry = { kind: "del", oldLine, text };
      oldLine++;
      current.deletions++;
    } else if (marker === " ") {
      entry = { kind: "context", oldLine, newLine, text };
      oldLine++;
      newLine++;
    } else if (line === "") {
      // A truly empty line inside a hunk is an unmarked context line: some
      // producers strip the trailing space. Only treat it as such while the
      // hunk still has budget, otherwise it is the separator before the next file.
      const consumed = hunk.lines.filter((l) => l.kind !== "add").length;
      if (consumed < hunk.oldCount) {
        entry = { kind: "context", oldLine, newLine, text: "" };
        oldLine++;
        newLine++;
      } else {
        closeHunk();
        continue;
      }
    } else {
      // Anything else ends the hunk (e.g. a trailing "-- " signature block).
      closeHunk();
      continue;
    }

    hunk.lines.push(entry);
  }

  closeFile();
  return files;
}

function stripPrefix(raw: string): string | null {
  let value = raw.trim();
  // Strip a trailing tab-separated timestamp emitted by some diff producers.
  const tab = value.indexOf("\t");
  if (tab >= 0) value = value.slice(0, tab);
  if (value === "/dev/null") return null;
  if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value) as string;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

function parseGitHeader(line: string): { oldPath: string; newPath: string } {
  const rest = line.slice("diff --git ".length);
  // Quoted form: "a/x y" "b/x y"
  if (rest.startsWith('"')) {
    const match = rest.match(/^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"$/);
    if (match) {
      return {
        oldPath: stripPrefix(JSON.parse(`"${match[1]}"`) as string) ?? "",
        newPath: stripPrefix(JSON.parse(`"${match[2]}"`) as string) ?? "",
      };
    }
  }
  // Unquoted paths may contain spaces; the split point is the midpoint where
  // "a/<p> b/<p>" holds. Try every space and keep the split that is consistent.
  const tokens = rest.split(" ");
  for (let i = 1; i < tokens.length; i++) {
    const left = tokens.slice(0, i).join(" ");
    const right = tokens.slice(i).join(" ");
    if (left.startsWith("a/") && right.startsWith("b/")) {
      const oldPath = left.slice(2);
      const newPath = right.slice(2);
      if (oldPath === newPath || tokens.length === 2) return { oldPath, newPath };
    }
  }
  const half = Math.floor(tokens.length / 2);
  return {
    oldPath: stripPrefix(tokens.slice(0, half).join(" ")) ?? "",
    newPath: stripPrefix(tokens.slice(half).join(" ")) ?? "",
  };
}

function parseHunkHeader(
  line: string,
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/** Render hunks back to unified-diff text — this is what the model reads. */
export function renderHunks(hunks: DiffHunk[]): string {
  const out: string[] = [];
  for (const hunk of hunks) {
    out.push(hunk.header);
    for (const line of hunk.lines) {
      const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      out.push(marker + line.text);
    }
  }
  return out.join("\n");
}

/**
 * Post-image line numbers that a review comment may anchor to.
 *
 * GitHub only accepts comments on lines present in the diff; anchoring anywhere
 * else is a 422. Context lines count, which is why this is not just the adds.
 */
export function commentableLines(hunks: DiffHunk[]): Set<number> {
  const lines = new Set<number>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== undefined) lines.add(line.newLine);
    }
  }
  return lines;
}

/** Post-image line numbers the PR actually introduces. Rules only fire on these. */
export function addedLines(hunks: DiffHunk[]): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newLine !== undefined) {
        out.push({ line: line.newLine, text: line.text });
      }
    }
  }
  return out;
}

/**
 * Snap a line to the nearest commentable line within `maxDistance`.
 *
 * Models routinely anchor a finding one or two lines off. Rejecting those would
 * throw away real findings; silently moving them far would misattribute them.
 */
export function snapToCommentable(
  line: number,
  commentable: Set<number>,
  maxDistance = 3,
): number | null {
  if (commentable.has(line)) return line;
  for (let d = 1; d <= maxDistance; d++) {
    if (commentable.has(line - d)) return line - d;
    if (commentable.has(line + d)) return line + d;
  }
  return null;
}

/**
 * The changed lines a finding points at, with a little of what surrounds them.
 *
 * A suggested replacement is not reviewable on its own — the reader has to see
 * what it replaces, and a line number alone means leaving the tool to go and
 * look. Numbers are the post-image ones the comment anchors to, so they match
 * what the platform will show once the comment is posted.
 */
export function excerptAround(
  hunks: DiffHunk[],
  line: number,
  endLine: number | undefined,
  context = 3,
): { line?: number; kind: DiffLineKind; text: string; anchored: boolean }[] {
  const last = endLine ?? line;
  const flat = hunks.flatMap((hunk) => hunk.lines);
  // Deletions carry no post-image number, so they are kept by position rather
  // than by number: dropping them would hide the very code being replaced.
  const near = flat.filter((entry) => {
    if (entry.newLine === undefined) return false;
    return entry.newLine >= line - context && entry.newLine <= last + context;
  });
  if (near.length === 0) return [];

  const first = flat.indexOf(near[0]!);
  const stop = flat.indexOf(near[near.length - 1]!);
  const slice = flat.slice(Math.max(0, first - 1), stop + 1);

  return slice.map((entry) => ({
    line: entry.newLine,
    kind: entry.kind,
    text: entry.text,
    anchored: entry.newLine !== undefined && entry.newLine >= line && entry.newLine <= last,
  }));
}
