import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const DOCS = ["README.md", "README.zh.md"];

/** Display columns, counting CJK as two — the terminal draws these boxes that way. */
function columns(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]!);
}

describe("the screenshots in the READMEs", () => {
  // A terminal screenshot with a ragged right edge reads as a broken tool, and
  // it is exactly the kind of damage an innocent one-line edit does silently.
  for (const file of DOCS) {
    it(`${file} draws every box at one width`, () => {
      const markdown = readFileSync(join(ROOT, file), "utf8");
      for (const block of fencedBlocks(markdown)) {
        if (!block.includes("╭")) continue;
        const framed = block
          .split("\n")
          .filter((line) => line.length > 0 && "│╭╰".includes(line[0]!));
        const widths = new Set(framed.map(columns));
        expect(widths, `${file}: ${[...widths].join(" vs ")}`).toHaveProperty("size", 1);
      }
    });
  }
});

describe("the links in the READMEs", () => {
  for (const file of DOCS) {
    it(`${file} points only at files that exist`, () => {
      const markdown = readFileSync(join(ROOT, file), "utf8");
      const targets = [...markdown.matchAll(/\]\((?!https?:)([^)#]+)/g)].map((match) => match[1]!);
      const missing = targets.filter((target) => !existsSync(join(ROOT, target)));
      expect(missing).toEqual([]);
    });
  }
});
