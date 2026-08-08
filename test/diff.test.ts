import { describe, expect, it } from "vitest";
import {
  addedLines,
  commentableLines,
  parseUnifiedDiff,
  renderHunks,
  snapToCommentable,
} from "../src/platform/diff.js";

const SIMPLE = `diff --git a/src/cache.ts b/src/cache.ts
index 1111111..2222222 100644
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -10,7 +10,8 @@ export class Cache {
   get(key: string) {
     const entry = this.map.get(key);
-    if (entry == null) return undefined;
+    if (entry === undefined) return undefined;
+    this.hits++;
     return entry.value;
   }
 }
`;

describe("parseUnifiedDiff — basics", () => {
  it("parses a single modified file", () => {
    const files = parseUnifiedDiff(SIMPLE);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.path).toBe("src/cache.ts");
    expect(file.change).toBe("modified");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
    expect(file.binary).toBe(false);
  });

  it("assigns correct post-image line numbers", () => {
    const [file] = parseUnifiedDiff(SIMPLE);
    const added = addedLines(file!.hunks);
    expect(added.map((a) => a.line)).toEqual([12, 13]);
    expect(added[0]?.text).toContain("entry === undefined");
    expect(added[1]?.text).toContain("this.hits++");
  });

  it("assigns correct pre-image line numbers to deletions", () => {
    const [file] = parseUnifiedDiff(SIMPLE);
    const deleted = file!.hunks[0]!.lines.filter((l) => l.kind === "del");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.oldLine).toBe(12);
  });

  it("round-trips hunks back to unified diff text", () => {
    const [file] = parseUnifiedDiff(SIMPLE);
    const rendered = renderHunks(file!.hunks);
    expect(rendered.split("\n")[0]).toContain("@@ -10,7 +10,8 @@");
    expect(rendered).toContain("+    this.hits++;");
    expect(rendered).toContain("-    if (entry == null) return undefined;");
  });
});

describe("parseUnifiedDiff — file change kinds", () => {
  it("detects added files", () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file?.change).toBe("added");
    expect(file?.path).toBe("new.ts");
    expect(file?.additions).toBe(2);
    expect(addedLines(file!.hunks).map((l) => l.line)).toEqual([1, 2]);
  });

  it("detects deleted files", () => {
    const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const a = 1;
-export const b = 2;
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file?.change).toBe("deleted");
    expect(file?.deletions).toBe(2);
  });

  it("detects renames and keeps both paths", () => {
    const diff = `diff --git a/old/name.ts b/new/name.ts
similarity index 92%
rename from old/name.ts
rename to new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,2 +1,2 @@
-const x = 1;
+const x = 2;
 export default x;
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file?.change).toBe("renamed");
    expect(file?.path).toBe("new/name.ts");
    expect(file?.oldPath).toBe("old/name.ts");
  });

  it("detects binary files and yields no hunks", () => {
    const diff = `diff --git a/logo.png b/logo.png
index 4444444..5555555 100644
Binary files a/logo.png and b/logo.png differ
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file?.binary).toBe(true);
    expect(file?.change).toBe("binary");
    expect(file?.hunks).toHaveLength(0);
  });

  it("handles paths containing spaces", () => {
    const diff = `diff --git a/my dir/file name.ts b/my dir/file name.ts
--- a/my dir/file name.ts
+++ b/my dir/file name.ts
@@ -1 +1 @@
-a
+b
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file?.path).toBe("my dir/file name.ts");
  });
});

describe("parseUnifiedDiff — edge cases", () => {
  it("handles multiple hunks in one file", () => {
    const diff = `diff --git a/multi.ts b/multi.ts
--- a/multi.ts
+++ b/multi.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -20,3 +20,4 @@
 x
 y
+z
 w
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file?.hunks).toHaveLength(2);
    expect(addedLines(file!.hunks).map((l) => l.line)).toEqual([2, 22]);
  });

  it("handles multiple files in one diff", () => {
    const diff = SIMPLE + `diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-old
+new
`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["src/cache.ts", "b.ts"]);
  });

  it("ignores the no-newline-at-EOF marker", () => {
    const diff = `diff --git a/x.txt b/x.txt
--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    expect(file?.hunks[0]?.lines).toHaveLength(2);
  });

  it("treats an unmarked empty line inside a hunk as context", () => {
    const diff = `diff --git a/y.ts b/y.ts
--- a/y.ts
+++ b/y.ts
@@ -1,3 +1,4 @@
 const a = 1;

+const b = 2;
 const c = 3;
`;
    const [file] = parseUnifiedDiff(diff);
    expect(file?.hunks[0]?.lines).toHaveLength(4);
    expect(addedLines(file!.hunks)[0]?.line).toBe(3);
  });

  it("handles single-line hunk headers without counts", () => {
    const diff = `diff --git a/z.ts b/z.ts
--- a/z.ts
+++ b/z.ts
@@ -5 +5 @@
-a
+b
`;
    const [file] = parseUnifiedDiff(diff);
    const hunk = file!.hunks[0]!;
    expect(hunk.oldStart).toBe(5);
    expect(hunk.oldCount).toBe(1);
    expect(addedLines([hunk])[0]?.line).toBe(5);
  });

  it("returns an empty list for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("comment anchoring", () => {
  it("includes context lines, not just additions", () => {
    const [file] = parseUnifiedDiff(SIMPLE);
    const lines = commentableLines(file!.hunks);
    // Post-image lines 10..17 are all present in the hunk.
    expect(lines.has(10)).toBe(true);
    expect(lines.has(12)).toBe(true);
    expect(lines.has(17)).toBe(true);
    expect(lines.has(99)).toBe(false);
  });

  it("snaps a near-miss line onto the diff", () => {
    const commentable = new Set([10, 11, 12]);
    expect(snapToCommentable(11, commentable)).toBe(11);
    expect(snapToCommentable(13, commentable)).toBe(12);
    expect(snapToCommentable(9, commentable)).toBe(10);
  });

  it("prefers the earlier line when both directions tie", () => {
    expect(snapToCommentable(10, new Set([9, 11]))).toBe(9);
  });

  it("refuses to snap a line that is far outside the diff", () => {
    expect(snapToCommentable(100, new Set([10, 11, 12]))).toBeNull();
  });
});
