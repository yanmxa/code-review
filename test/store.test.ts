import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyLedger } from "../src/budget/budget.js";
import { computeRunId, findRunDir, hashDiff, listRuns, RunStore } from "../src/checkpoint/store.js";
import type { Finding, Target } from "../src/types.js";

const TARGET: Target = {
  platform: "github",
  owner: "acme",
  repo: "widgets",
  number: 42,
  apiBase: "https://api.github.com",
  webUrl: "https://github.com/acme/widgets/pull/42",
};

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "code-review-test-"));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function open(overrides: { headSha?: string; diffHash?: string; fresh?: boolean } = {}) {
  return RunStore.open({
    runDir,
    target: TARGET,
    headSha: overrides.headSha ?? "abc123",
    diffHash: overrides.diffHash ?? hashDiff("the diff"),
    fresh: overrides.fresh ?? false,
  });
}

function finding(id: string, unitId = "src/a.ts"): Finding {
  return {
    id,
    unitId,
    path: "src/a.ts",
    line: 10,
    severity: "major",
    title: `finding ${id}`,
    body: "body",
    evidence: [{ kind: "llm", reasoning: "because" }],
    confidence: "reference",
    fingerprint: id,
    tracePath: "traces/src_a.ts.jsonl",
    source: "agent",
  };
}

describe("RunStore — identity", () => {
  it("derives the same run id for the same PR at the same head", () => {
    expect(computeRunId(TARGET, "abc123")).toBe(computeRunId(TARGET, "abc123"));
  });

  it("derives a different run id for a new head commit", () => {
    expect(computeRunId(TARGET, "abc123")).not.toBe(computeRunId(TARGET, "def456"));
  });
});

describe("RunStore — resume", () => {
  it("starts fresh the first time", () => {
    const { store, resumed } = open();
    expect(resumed).toBe(false);
    expect(store.current.units).toEqual([]);
  });

  it("resumes an existing run and keeps completed units", () => {
    const first = open().store;
    first.initUnits([{ id: "a.ts", path: "a.ts" }, { id: "b.ts", path: "b.ts" }]);
    first.completeUnit("a.ts", [finding("f1")], { status: "done", spendUsd: 0.02 });

    const { store, resumed } = open();
    expect(resumed).toBe(true);
    expect(store.unit("a.ts")?.status).toBe("done");
    expect(store.unit("b.ts")?.status).toBe("pending");
    expect(store.pendingUnits().map((u) => u.id)).toEqual(["b.ts"]);
    expect(store.readFindings()).toHaveLength(1);
  });

  it("re-queues a unit that was in progress when the process died", () => {
    const first = open().store;
    first.initUnits([{ id: "a.ts", path: "a.ts" }]);
    first.markUnit("a.ts", { status: "in_progress" });

    const { store } = open();
    expect(store.unit("a.ts")?.status).toBe("pending");
  });

  it("keeps spend from the interrupted attempt — the tokens were really spent", () => {
    const first = open().store;
    const ledger = emptyLedger();
    ledger.usd = 0.5;
    first.updateSpend(ledger, 1, true, false);

    const { store } = open();
    expect(store.current.spend.usd).toBe(0.5);
    expect(store.current.ladderStage).toBe(1);
    expect(store.current.squeezed).toBe(true);
  });

  it("discards the checkpoint when the diff changed under it", () => {
    const first = open().store;
    first.initUnits([{ id: "a.ts", path: "a.ts" }]);
    first.completeUnit("a.ts", [finding("f1")], { status: "done", spendUsd: 0.02 });

    const { store, resumed, staleReason } = open({ diffHash: hashDiff("a different diff") });
    expect(resumed).toBe(false);
    expect(staleReason).toMatch(/changed/);
    expect(store.current.units).toEqual([]);
    // Stale findings must not bleed into the new run.
    expect(store.readFindings()).toEqual([]);
  });

  it("--fresh throws away a valid checkpoint", () => {
    const first = open().store;
    first.initUnits([{ id: "a.ts", path: "a.ts" }]);
    first.completeUnit("a.ts", [finding("f1")], { status: "done", spendUsd: 0.02 });

    const { store, resumed } = open({ fresh: true });
    expect(resumed).toBe(false);
    expect(store.readFindings()).toEqual([]);
  });
});

describe("RunStore — crash safety", () => {
  it("recovers findings written before a torn state file", () => {
    const { store } = open();
    store.initUnits([{ id: "a.ts", path: "a.ts" }]);
    store.completeUnit("a.ts", [finding("f1")], { status: "done", spendUsd: 0.01 });

    // Simulate a kill during the state write: the temp file exists, state.json is old.
    writeFileSync(`${store.dirs.state}.tmp`, "{ partial", "utf8");

    const reopened = open().store;
    expect(reopened.readFindings()).toHaveLength(1);
    expect(reopened.unit("a.ts")?.status).toBe("done");
  });

  it("tolerates a torn final line in findings.jsonl", () => {
    const { store } = open();
    store.initUnits([{ id: "a.ts", path: "a.ts" }]);
    store.appendFindings([finding("f1"), finding("f2")]);
    writeFileSync(store.dirs.findings, `${readFileSync(store.dirs.findings, "utf8")}{"id":"f3","pa`, "utf8");

    expect(store.readFindings().map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("never leaves a half-written state.json", () => {
    const { store } = open();
    store.initUnits([{ id: "a.ts", path: "a.ts" }]);
    // Whatever is at the path must always be complete JSON, because it is
    // written to a temp file and renamed into place.
    expect(() => JSON.parse(readFileSync(store.dirs.state, "utf8"))).not.toThrow();
  });
});

describe("RunStore — posted fingerprints", () => {
  it("accumulates without duplicating", () => {
    const { store } = open();
    store.addPosted(["aaa", "bbb"]);
    store.addPosted(["bbb", "ccc"]);
    expect(store.readPosted().sort()).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("returns an empty list before anything is posted", () => {
    expect(open().store.readPosted()).toEqual([]);
  });
});

describe("run listing", () => {
  it("summarizes runs newest first", () => {
    const a = open({ headSha: "sha-a" }).store;
    a.initUnits([{ id: "a.ts", path: "a.ts" }, { id: "b.ts", path: "b.ts" }]);
    a.completeUnit("a.ts", [finding("f1")], { status: "done", spendUsd: 0.02 });

    const b = open({ headSha: "sha-b" }).store;
    b.initUnits([{ id: "c.ts", path: "c.ts" }]);

    const runs = listRuns(runDir);
    expect(runs).toHaveLength(2);
    expect((runs[0]?.updatedAt ?? "") >= (runs[1]?.updatedAt ?? "")).toBe(true);
    const withFindings = runs.find((run) => run.runId === a.runId);
    expect(withFindings?.findings).toBe(1);
    expect(withFindings?.units).toBe(2);
    expect(withFindings?.done).toBe(1);
  });

  it("returns nothing for a directory that does not exist", () => {
    expect(listRuns(join(runDir, "nope"))).toEqual([]);
  });

  it("resolves an abbreviated run id", () => {
    const { store } = open();
    expect(findRunDir(runDir, store.runId.slice(0, 6))).toBe(join(runDir, store.runId));
    expect(findRunDir(runDir, "zzzzzz")).toBeNull();
  });
});

describe("RunStore — the budget a run was given", () => {
  it("records it, so a later view never reports a limit this run never had", () => {
    const { store } = open();
    const ledger = emptyLedger();
    ledger.usd = 0.5;
    store.updateSpend(ledger, 0, false, false, { limit: 6, unit: "CNY", usdToCny: 7.25 });

    const reopened = open().store;
    expect(reopened.current.budget).toEqual({ limit: 6, unit: "CNY", usdToCny: 7.25 });
    expect(reopened.current.spend.usd).toBe(0.5);
  });
});
