import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DismissalStore } from "../src/memory/dismissals.js";
import type { MarkerComment } from "../src/platform/adapter.js";
import type { Target } from "../src/types.js";

const TARGET: Target = {
  platform: "github",
  owner: "acme",
  repo: "widgets",
  number: 7,
  apiBase: "https://api.github.com",
  webUrl: "https://github.com/acme/widgets/pull/7",
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "code-review-memory-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const open = () => DismissalStore.forTarget(TARGET, root);
const comment = (fingerprint: string, resolved?: boolean): MarkerComment => ({
  id: fingerprint,
  fingerprint,
  isSummary: false,
  ...(resolved === undefined ? {} : { resolved }),
});

describe("DismissalStore — learning a rejection", () => {
  it("treats a deleted comment as a rejection", () => {
    const memory = open();
    memory.recordPosted([{ fingerprint: "aaa" }, { fingerprint: "bbb" }], 7);

    // "bbb" is gone from the PR: the maintainer deleted it.
    const newly = memory.reconcile([comment("aaa")], 7);

    expect(newly).toHaveLength(1);
    expect(memory.dismissed()).toEqual(new Set(["bbb"]));
    expect(memory.reasonFor("bbb")?.how).toBe("deleted");
  });

  it("treats a resolved thread as a rejection", () => {
    const memory = open();
    memory.recordPosted([{ fingerprint: "aaa" }], 7);
    memory.reconcile([comment("aaa", true)], 7);
    expect(memory.reasonFor("aaa")?.how).toBe("resolved");
  });

  it("leaves an open comment alone", () => {
    const memory = open();
    memory.recordPosted([{ fingerprint: "aaa" }], 7);
    memory.reconcile([comment("aaa", false)], 7);
    expect(memory.dismissed().size).toBe(0);
  });

  it("does not infer a rejection when the host cannot tell us", () => {
    // `resolved: undefined` means unknown, not unresolved. Guessing here would
    // silently suppress a live finding.
    const memory = open();
    memory.recordPosted([{ fingerprint: "aaa" }], 7);
    memory.reconcile([comment("aaa")], 7);
    expect(memory.dismissed().size).toBe(0);
  });

  it("ignores comments it never posted", () => {
    const memory = open();
    memory.recordPosted([{ fingerprint: "aaa" }], 7);
    memory.reconcile([comment("aaa"), comment("someone-elses")], 7);
    expect(memory.dismissed().size).toBe(0);
  });

  it("reports each rejection once", () => {
    const memory = open();
    memory.recordPosted([{ fingerprint: "aaa" }], 7);
    expect(memory.reconcile([], 7)).toHaveLength(1);
    expect(memory.reconcile([], 7)).toHaveLength(0);
  });
});

describe("DismissalStore — memory outlives the run", () => {
  it("survives a new process, which is the whole point", () => {
    // Run directories are keyed by head SHA, so anything remembered there would
    // vanish on the next push — exactly when the tool would repeat itself.
    open().recordPosted([{ fingerprint: "aaa" }], 7);
    open().reconcile([], 7);
    expect(open().dismissed()).toEqual(new Set(["aaa"]));
  });

  it("is scoped per repository, not per pull request", () => {
    open().recordPosted([{ fingerprint: "aaa" }], 7);
    open().reconcile([], 7);

    // A different PR on the same repository inherits the rejection.
    const other = DismissalStore.forTarget({ ...TARGET, number: 99 }, root);
    expect(other.dismissed().has("aaa")).toBe(true);

    // A different repository does not.
    const elsewhere = DismissalStore.forTarget({ ...TARGET, repo: "gadgets" }, root);
    expect(elsewhere.dismissed().size).toBe(0);
  });

  it("starts empty rather than throwing when the file is corrupt", () => {
    const memory = open();
    memory.recordPosted([{ fingerprint: "aaa" }], 7);
    rmSync(memory.path);
    expect(open().dismissed().size).toBe(0);
  });
});

describe("DismissalStore — a suppression must be undoable", () => {
  it("forgets a rejection on request", () => {
    const memory = open();
    memory.recordPosted([{ fingerprint: "aaa" }], 7);
    memory.reconcile([], 7);
    expect(memory.forget("aaa")).toBe(true);
    expect(open().dismissed().size).toBe(0);
  });

  it("says so when there was nothing to forget", () => {
    expect(open().forget("nope")).toBe(false);
  });
});

describe("reading back a decision", () => {
  it("keeps what the comment said, so the record means something to a person", () => {
    // `code-review dismissed` printed a column of fingerprints: technically the
    // list of decisions, useless for deciding whether to undo one.
    const memory = open();
    memory.recordPosted(
      [{ fingerprint: "aaa", title: "Swallowed database error", where: "src/db.ts:40" }],
      7,
    );
    memory.reconcile([], 7);
    expect(memory.reasonFor("aaa")).toMatchObject({
      title: "Swallowed database error",
      where: "src/db.ts:40",
      how: "deleted",
    });
  });

  it("still works for memories written before titles were kept", () => {
    const memory = open();
    memory.recordPosted([{ fingerprint: "bbb" }], 7);
    memory.reconcile([], 7);
    expect(memory.reasonFor("bbb")?.title).toBeUndefined();
    expect(memory.dismissed().has("bbb")).toBe(true);
  });
})
