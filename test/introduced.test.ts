import { describe, expect, it } from "vitest";
import { introducedByChange } from "../src/engine/introduced.js";
import { parseUnifiedDiff } from "../src/platform/diff.js";

function diff(path: string, added: string[], header = "@@ -1,0 +1,9 @@"): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    header,
    ...added.map((line) => `+${line}`),
  ].join("\n");
}

describe("what a change introduces", () => {
  it("names the things other code could now call", () => {
    const files = parseUnifiedDiff(
      diff("src/retry.ts", [
        "export async function withRetry<T>(fn: () => Promise<T>) {",
        "  const x = 1;",
        "export const DEFAULT_ATTEMPTS = 3;",
        "export interface RetryOptions {",
      ]),
    );
    expect(introducedByChange(files).map((item) => item.name)).toEqual([
      "withRetry",
      "DEFAULT_ATTEMPTS",
      "RetryOptions",
    ]);
  });

  it("counts a whole new file as introduced", () => {
    const files = parseUnifiedDiff(diff("src/new.ts", ["const private1 = 1;"]));
    files[0]!.change = "added";
    expect(introducedByChange(files)).toContainEqual({
      path: "src/new.ts",
      kind: "file",
      name: "src/new.ts",
    });
  });

  it("says nothing about code that stayed private", () => {
    // A false name costs a false finding; a missing one costs a question that
    // does not get asked. Only unambiguously public declarations are matched.
    const files = parseUnifiedDiff(
      diff("src/util.ts", [
        "  const helper = () => 1;",
        "function notExported() {}",
        "  export const nested = 2;",
      ]),
    );
    expect(introducedByChange(files).map((item) => item.name)).toEqual(["nested"]);
  });

  it("reads Go and Python too", () => {
    const go = parseUnifiedDiff(diff("srv/handler.go", ["func ServeHTTP(w http.ResponseWriter) {", "func private() {}"]));
    expect(introducedByChange(go).map((item) => item.name)).toEqual(["ServeHTTP"]);

    const py = parseUnifiedDiff(diff("app/main.py", ["def handle(request):", "def _internal():", "class Router:"]));
    expect(introducedByChange(py).map((item) => item.name)).toEqual(["handle", "Router"]);
  });

  it("stops before the list turns into noise", () => {
    // Forty new public names is a rewrite; a checklist that long is not read,
    // and the agent is better off reading the diff itself.
    const many = Array.from({ length: 60 }, (_, i) => `export const NAME${i} = ${i};`);
    expect(introducedByChange(parseUnifiedDiff(diff("src/big.ts", many)))).toHaveLength(40);
  });

  it("ignores lines the change only read past", () => {
    // Context and deleted lines are not introductions.
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@",
        " export function stillHere() {}",
        "-export function goneNow() {}",
        "+export function brandNew() {}",
      ].join("\n"),
    );
    expect(introducedByChange(files).map((item) => item.name)).toEqual(["brandNew"]);
  });
});
