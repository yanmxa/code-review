import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashDiff, RunStore } from "../src/checkpoint/store.js";
import { postFindings } from "../src/report/post.js";
import { renderReport, type ReportInput } from "../src/report/markdown.js";
import { Redactor } from "../src/security/redactor.js";
import type { Finding, PrSnapshot } from "../src/types.js";
import { FakePlatform, SAMPLE_DIFF, TEST_TARGET } from "./helpers/fake-platform.js";

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "code-review-post-"));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    unitId: "src/cache.ts",
    path: "src/cache.ts",
    line: 12,
    severity: "major",
    title: "Eviction removes the wrong entry",
    body: "Map iteration order is insertion order, not access order.",
    evidence: [{ kind: "llm", reasoning: "Map preserves insertion order." }],
    confidence: "reference",
    fingerprint: "aaaaaaaaaa",
    tracePath: "traces/src_cache.ts.jsonl",
    source: "agent",
    ...overrides,
  };
}

async function harness(findings: Finding[]) {
  const adapter = new FakePlatform(SAMPLE_DIFF);
  const snapshot = await adapter.fetchPr(TEST_TARGET);
  const { store } = RunStore.open({
    runDir,
    target: TEST_TARGET,
    headSha: snapshot.meta.headSha,
    diffHash: hashDiff(snapshot.diff),
  });
  const report: ReportInput = {
    snapshot,
    findings,
    state: store.current,
    lang: "en",
    budgetTotalCny: 10,
    redactionStats: {},
    budgetEvents: [],
    skipped: [],
  };
  return { adapter, snapshot, store, report };
}

describe("postFindings — anchoring", () => {
  it("posts a finding anchored inside the diff", async () => {
    const findings = [finding()];
    const { adapter, snapshot, store, report } = await harness(findings);
    const result = await postFindings({ adapter, snapshot, store, findings, report, lang: "en" });

    expect(result.posted).toBe(1);
    expect(adapter.posted[0]?.comments[0]?.path).toBe("src/cache.ts");
  });

  it("drops a finding whose line is not in the diff rather than failing the review", async () => {
    // GitHub rejects the whole review request for one bad anchor, so an
    // unanchorable comment must never reach the API.
    const findings = [finding({ line: 900 })];
    const { adapter, snapshot, store, report } = await harness(findings);
    const result = await postFindings({ adapter, snapshot, store, findings, report, lang: "en" });

    expect(result.posted).toBe(0);
    expect(result.unanchorable).toBe(1);
    expect(adapter.posted[0]?.comments).toHaveLength(0);
  });

  it("snaps a near-miss anchor onto the diff", async () => {
    const findings = [finding({ line: 14 })];
    const { adapter, snapshot, store, report } = await harness(findings);
    await postFindings({ adapter, snapshot, store, findings, report, lang: "en" });
    const line = adapter.posted[0]?.comments[0]?.line ?? 0;
    expect(line).toBeGreaterThan(0);
    expect(Math.abs(line - 14)).toBeLessThanOrEqual(3);
  });
});

describe("postFindings — idempotency", () => {
  it("does not repost a finding already on the pull request", async () => {
    const findings = [finding()];
    const { adapter, snapshot, store, report } = await harness(findings);

    const first = await postFindings({ adapter, snapshot, store, findings, report, lang: "en" });
    expect(first.posted).toBe(1);

    const second = await postFindings({ adapter, snapshot, store, findings, report, lang: "en" });
    expect(second.posted).toBe(0);
    expect(second.skippedAsDuplicate).toBe(1);
  });

  it("recognizes a comment posted by an earlier process it has no local record of", async () => {
    const findings = [finding()];
    const { adapter, snapshot, store, report } = await harness(findings);
    adapter.existing = [{ id: 1, fingerprint: "aaaaaaaaaa", isSummary: false }];

    const result = await postFindings({ adapter, snapshot, store, findings, report, lang: "en" });
    expect(result.posted).toBe(0);
    expect(result.skippedAsDuplicate).toBe(1);
  });

  it("still posts findings that are new since the last run", async () => {
    const first = [finding()];
    const { adapter, snapshot, store, report } = await harness(first);
    await postFindings({ adapter, snapshot, store, findings: first, report, lang: "en" });

    const both = [finding(), finding({ fingerprint: "bbbbbbbbbb", title: "Another problem", line: 13 })];
    const result = await postFindings({ adapter, snapshot, store, findings: both, report, lang: "en" });
    expect(result.posted).toBe(1);
    expect(result.skippedAsDuplicate).toBe(1);
  });

  it("records fingerprints only after the host accepted them", async () => {
    const findings = [finding()];
    const { adapter, snapshot, store, report } = await harness(findings);
    await postFindings({ adapter, snapshot, store, findings, report, lang: "en", dryRun: true });
    // A dry run must leave nothing behind, or a later real post would skip.
    expect(store.readPosted()).toEqual([]);
  });
});

describe("comment bodies", () => {
  it("embeds a fingerprint marker so the next run can recognize it", async () => {
    const findings = [finding()];
    const { adapter, snapshot, store, report } = await harness(findings);
    await postFindings({ adapter, snapshot, store, findings, report, lang: "en" });
    expect(adapter.posted[0]?.comments[0]?.body).toContain("<!-- code-review:f:aaaaaaaaaa -->");
  });

  it("shows machine-checkable evidence but not raw model reasoning", async () => {
    const findings = [
      finding({
        confidence: "adoptable",
        evidence: [
          { kind: "rule", ruleId: "console-log", path: "src/cache.ts", line: 12, excerpt: "console.log(x)" },
          { kind: "llm", reasoning: "internal chain of thought" },
        ],
      }),
    ];
    const { adapter, snapshot, store, report } = await harness(findings);
    await postFindings({ adapter, snapshot, store, findings, report, lang: "en" });

    const body = adapter.posted[0]?.comments[0]?.body ?? "";
    expect(body).toContain("console-log");
    expect(body).not.toContain("internal chain of thought");
  });

  it("marks the summary so it can be updated instead of duplicated", async () => {
    const findings = [finding()];
    const { adapter, snapshot, store, report } = await harness(findings);
    await postFindings({ adapter, snapshot, store, findings, report, lang: "en" });
    expect(adapter.posted[0]?.summary).toContain("<!-- code-review:summary -->");
  });
});

describe("report rendering", () => {
  it("separates the two confidence tiers and shows the evidence for each", async () => {
    const findings = [
      finding({
        id: "F-001",
        confidence: "adoptable",
        fingerprint: "aaa",
        title: "Credential committed",
        evidence: [
          { kind: "rule", ruleId: "secret-in-diff", path: "src/config.ts", line: 4, excerpt: "key = ..." },
        ],
      }),
      finding({ id: "F-002", confidence: "reference", fingerprint: "bbb", title: "Maybe a race" }),
    ];
    const { report } = await harness(findings);
    const markdown = renderReport(report);

    expect(markdown).toContain("Directly adoptable");
    expect(markdown).toContain("For reference");
    expect(markdown).toContain("secret-in-diff");
    expect(markdown).toContain("traces/src_cache.ts.jsonl");
  });

  it("renders a clean review without inventing findings", async () => {
    const { report } = await harness([]);
    expect(renderReport(report)).toContain("nothing worth reporting");
  });

  it("warns loudly when the budget cut the run short", async () => {
    const { report } = await harness([]);
    report.state.hardStopped = true;
    expect(renderReport(report)).toContain("partial results");
  });

  it("reports redaction counts without revealing what was masked", async () => {
    const { report } = await harness([]);
    report.redactionStats = { "aws-access-key": 2 };
    const markdown = renderReport(report);
    expect(markdown).toContain("aws-access-key");
    expect(markdown).toContain("× 2");
    expect(markdown).not.toContain("AKIA");
  });

  it("renders Chinese when asked", async () => {
    const { report } = await harness([finding()]);
    report.lang = "zh";
    const markdown = renderReport(report);
    expect(markdown).toContain("代码评审报告");
    expect(markdown).toContain("仅供参考");
  });
});

describe("snapshot safety", () => {
  it("keeps the planted secret out of everything that gets written", async () => {
    const adapter = new FakePlatform(SAMPLE_DIFF, {}, new Redactor());
    const snapshot: PrSnapshot = await adapter.fetchPr(TEST_TARGET);
    expect(JSON.stringify(snapshot)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
