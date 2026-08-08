import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { dedupe } from "../src/engine/grade.js";
import { runReview } from "../src/engine/pipeline.js";
import { Redactor } from "../src/security/redactor.js";
import { Tracer } from "../src/trace/tracer.js";
import type { RunEvent } from "../src/types.js";
import { FakePlatform, SAMPLE_DIFF, TEST_TARGET } from "./helpers/fake-platform.js";

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "code-review-pipe-"));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

/**
 * A models collection backed by the faux provider, scripted so every unit
 * submits findings on its first turn. `cost` is set so spend is predictable.
 */
function scriptedModels(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider({
    provider: "openai",
    models: [
      { id: "gpt-5.4", cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 } },
      { id: "gpt-5.4-mini", cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { id: "gpt-5.4-nano", cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 } },
    ],
    tokensPerSecond: 100_000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { models, faux };
}

/**
 * The faux provider reports zero usage unless the scripted message carries its
 * own, so we attach a realistic one — otherwise budget behaviour would never be
 * exercised offline.
 */
function submitMessage(findings: unknown[], costUsd = 0.02) {
  const message = fauxAssistantMessage([
    fauxToolCall("submit_findings", { findings, summary: "reviewed" }),
  ]);
  message.usage = {
    input: 4000,
    output: 400,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 4400,
    cost: { input: costUsd * 0.6, output: costUsd * 0.4, cacheRead: 0, cacheWrite: 0, total: costUsd },
  };
  return message;
}

function config(overrides: Parameters<typeof resolveConfig>[0] = {}) {
  return resolveConfig({ runDir, lang: "en", ...overrides });
}

async function run(
  responses: ReturnType<typeof fauxAssistantMessage>[],
  overrides: Parameters<typeof resolveConfig>[0] = {},
) {
  const adapter = new FakePlatform(SAMPLE_DIFF);
  const { models } = scriptedModels(responses);
  const events: RunEvent[] = [];
  const result = await runReview(TEST_TARGET, {
    adapter,
    models,
    redactor: new Redactor(),
    config: config(overrides),
    emit: (event) => events.push(event),
  });
  return { ...result, events, adapter };
}

describe("pipeline — end to end, offline", () => {
  it("reviews every unit and returns graded findings", async () => {
    const { findings, store } = await run([
      submitMessage([
        {
          path: "src/cache.ts",
          line: 13,
          severity: "major",
          title: "Eviction removes the wrong entry",
          body: "Map iteration order is insertion order, not access order, so this evicts the oldest inserted key rather than the least recently used one.",
          supportingToolCalls: [],
          reasoning: "Map preserves insertion order.",
        },
      ]),
      submitMessage([]),
    ]);

    expect(findings.length).toBeGreaterThan(0);
    expect(store.current.finished).toBe(true);
    expect(store.current.units.every((unit) => unit.status === "done")).toBe(true);
    // Findings survive a reload: they were written to disk, not just returned.
    expect(store.readFindings().length).toBeGreaterThan(0);
  });

  it("grades a rule-backed finding as adoptable and a model-only one as reference", async () => {
    const { findings } = await run([
      submitMessage([
        {
          path: "src/cache.ts",
          line: 13,
          severity: "minor",
          title: "Consider documenting the eviction policy",
          body: "A comment would help.",
          supportingToolCalls: [],
        },
      ]),
      submitMessage([]),
    ]);

    const bySource = Object.fromEntries(findings.map((f) => [f.title, f]));
    const modelOnly = bySource["Consider documenting the eviction policy"];
    expect(modelOnly?.confidence).toBe("reference");
    expect(modelOnly?.evidence.every((e) => e.kind === "llm")).toBe(true);

    // The planted AWS key is caught deterministically, so it is directly adoptable.
    const secret = findings.find((f) => f.evidence.some((e) => e.kind === "rule" && e.ruleId === "secret-in-diff"));
    expect(secret?.confidence).toBe("adoptable");
    expect(secret?.severity).toBe("blocker");
  });

  it("never lets the planted secret reach the model or the trace", async () => {
    const { store } = await run([submitMessage([]), submitMessage([])]);

    const traces = store.current.units.flatMap((unit) =>
      Tracer.read(store.dirs.root, `traces/${unit.id.replace(/[^A-Za-z0-9._#-]/g, "_")}.jsonl`),
    );
    expect(traces.length).toBeGreaterThan(0);

    const everything = JSON.stringify(traces) + JSON.stringify(store.readSnapshot());
    expect(everything).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(everything).toContain("[REDACTED:aws-access-key:");
  });

  it("drops a finding anchored outside the diff", async () => {
    const { findings } = await run([
      submitMessage([
        {
          path: "src/cache.ts",
          line: 900,
          severity: "major",
          title: "Problem on a line this PR never touched",
          body: "…",
          supportingToolCalls: [],
        },
      ]),
      submitMessage([]),
    ]);
    expect(findings.some((f) => f.title.includes("never touched"))).toBe(false);
  });

  it("ignores a fabricated tool call id instead of rewarding it", async () => {
    const { findings } = await run([
      submitMessage([
        {
          path: "src/cache.ts",
          line: 13,
          severity: "major",
          title: "Claims tool support it never had",
          body: "…",
          supportingToolCalls: ["call_does_not_exist"],
        },
      ]),
      submitMessage([]),
    ]);
    const bogus = findings.find((f) => f.title === "Claims tool support it never had");
    expect(bogus?.confidence).toBe("reference");
    expect(bogus?.evidence.some((e) => e.kind === "static")).toBe(false);
  });

  it("writes a trace containing the full prompt and the raw response", async () => {
    const { store } = await run([submitMessage([]), submitMessage([])]);
    const events = Tracer.read(store.dirs.root, "traces/src_cache.ts.jsonl");

    const request = events.find((event) => event.type === "llm_request");
    expect(request).toBeDefined();
    expect(request?.type === "llm_request" && request.systemPrompt).toContain("senior code reviewer");
    expect(request?.type === "llm_request" && request.toolNames).toContain("submit_findings");

    const response = events.find((event) => event.type === "llm_response");
    expect(response).toBeDefined();
    expect(response?.type === "llm_response" && response.usage.costUsd).toBeGreaterThanOrEqual(0);

    expect(events.some((event) => event.type === "unit_start")).toBe(true);
    expect(events.some((event) => event.type === "unit_end")).toBe(true);
    expect(events.some((event) => event.type === "tool_call")).toBe(true);
  });
});

describe("pipeline — budget", () => {
  it("accumulates spend across units", async () => {
    const { budget } = await run([submitMessage([]), submitMessage([])]);
    expect(budget.spend.calls).toBeGreaterThanOrEqual(2);
    expect(budget.spend.usd).toBeGreaterThan(0);
  });

  it("hard-stops and reports partial results when the budget runs out", async () => {
    // A budget so small the very first response blows through it.
    const { findings, store, events } = await run([submitMessage([]), submitMessage([])], {
      budget: { totalCny: 0.0000001 },
    });

    expect(store.current.hardStopped).toBe(true);
    const skipped = store.current.units.filter((unit) => unit.skipReason === "budget");
    expect(skipped.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "budget" && event.kind === "hard_stop")).toBe(true);
    // Rule findings still land: they cost nothing and are the most valuable ones.
    expect(findings.some((f) => f.confidence === "adoptable")).toBe(true);
  });
});

describe("pipeline — resume", () => {
  it("does not re-review a unit that already completed", async () => {
    const adapter = new FakePlatform(SAMPLE_DIFF);
    const redactor = new Redactor();

    const first = scriptedModels([submitMessage([]), submitMessage([])]);
    await runReview(TEST_TARGET, {
      adapter,
      models: first.models,
      redactor,
      config: config(),
      emit: () => {},
    });
    const callsInFirstRun = first.faux.state.callCount;
    expect(callsInFirstRun).toBeGreaterThan(0);

    // Same PR, same diff: everything is already done, so nothing should be spent.
    const second = scriptedModels([submitMessage([]), submitMessage([])]);
    const events: RunEvent[] = [];
    const result = await runReview(TEST_TARGET, {
      adapter,
      models: second.models,
      redactor,
      config: config(),
      emit: (event) => events.push(event),
    });

    expect(second.faux.state.callCount).toBe(0);
    expect(events.some((event) => event.type === "run_start" && event.resumed)).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("re-runs everything when --fresh is set", async () => {
    const adapter = new FakePlatform(SAMPLE_DIFF);
    const redactor = new Redactor();

    const first = scriptedModels([submitMessage([]), submitMessage([])]);
    await runReview(TEST_TARGET, { adapter, models: first.models, redactor, config: config(), emit: () => {} });

    const second = scriptedModels([submitMessage([]), submitMessage([])]);
    await runReview(TEST_TARGET, {
      adapter,
      models: second.models,
      redactor,
      config: config({ fresh: true }),
      emit: () => {},
    });

    expect(second.faux.state.callCount).toBeGreaterThan(0);
  });
});

describe("pipeline — unit planning", () => {
  it("skips files that are not worth reviewing", async () => {
    const diff =
      SAMPLE_DIFF +
      `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,2 +1,3 @@
 {
+  "lockfileVersion": 3,
 }
`;
    const adapter = new FakePlatform(diff);
    const { models } = scriptedModels([submitMessage([]), submitMessage([])]);
    const events: RunEvent[] = [];
    await runReview(TEST_TARGET, {
      adapter,
      models,
      redactor: new Redactor(),
      config: config(),
      emit: (event) => events.push(event),
    });

    const skipped = events.filter(
      (event) => event.type === "unit_end" && event.status === "skipped",
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.type === "unit_end" && skipped[0].unitId).toBe("package-lock.json");
  });
});

describe("pipeline — findings on disk", () => {
  it("dedupes a unit's findings after a resumed run recorded them twice", async () => {
    const adapter = new FakePlatform(SAMPLE_DIFF);
    const redactor = new Redactor();

    const first = scriptedModels([submitMessage([]), submitMessage([])]);
    const { store } = await runReview(TEST_TARGET, {
      adapter,
      models: first.models,
      redactor,
      config: config(),
      emit: () => {},
    });

    // Simulate what a mid-unit crash leaves behind: the unit re-runs and
    // appends its findings a second time to the append-only log.
    const onDisk = store.readFindings();
    expect(onDisk.length).toBeGreaterThan(0);
    store.appendFindings(onDisk);
    expect(store.readFindings().length).toBe(onDisk.length * 2);

    // Anything presenting findings to a user must collapse them back.
    expect(dedupe(store.readFindings())).toHaveLength(onDisk.length);
  });
});

describe("pipeline — dismissed findings", () => {
  it("never emits a finding a maintainer already rejected", async () => {
    const adapter = new FakePlatform(SAMPLE_DIFF);
    const { models } = scriptedModels([submitMessage([]), submitMessage([])]);

    // Learn what the run would normally produce.
    const baseline: RunEvent[] = [];
    const first = await runReview(TEST_TARGET, {
      adapter,
      models,
      redactor: new Redactor(),
      config: config(),
      emit: (event) => baseline.push(event),
    });
    const victim = first.findings[0];
    expect(victim).toBeDefined();

    // Now re-run with that fingerprint dismissed.
    const second = scriptedModels([submitMessage([]), submitMessage([])]);
    const events: RunEvent[] = [];
    const result = await runReview(TEST_TARGET, {
      adapter,
      models: second.models,
      redactor: new Redactor(),
      config: config({ fresh: true }),
      emit: (event) => events.push(event),
      dismissed: new Set([victim!.fingerprint]),
    });

    expect(result.findings.map((f) => f.fingerprint)).not.toContain(victim!.fingerprint);
    expect(result.suppressed).toBeGreaterThan(0);

    // Showing it and then announcing it was withheld would be worse than not
    // filtering at all, so it must not reach the event stream either.
    const emitted = events.filter((e) => e.type === "finding");
    expect(emitted.map((e) => e.type === "finding" && e.finding.fingerprint)).not.toContain(
      victim!.fingerprint,
    );
    expect(events.some((e) => e.type === "notice" && e.text.includes("Withheld"))).toBe(true);
  });
});

describe("pipeline — a model that never reports", () => {
  it("nudges once even after the turn cap, keeping what it already paid for", async () => {
    const adapter = new FakePlatform(SAMPLE_DIFF);
    const { models, faux } = scriptedModels([]);
    faux.setResponses([
      // The model talks instead of reporting, and the turn cap is already spent.
      fauxAssistantMessage("Let me look at this more closely."),
      // The nudge lands, and the work is recovered.
      submitMessage([
        {
          path: "src/cache.ts",
          line: 13,
          severity: "minor",
          title: "Reported only after being nudged",
          body: "…",
          supportingToolCalls: [],
        },
      ]),
      submitMessage([]),
      submitMessage([]),
    ]);

    const result = await runReview(TEST_TARGET, {
      adapter,
      models,
      redactor: new Redactor(),
      // One turn: with the previous condition the nudge was skipped exactly
      // when it was needed most, discarding rounds that had already been billed.
      config: config({ maxTurnsPerUnit: 1 }),
      emit: () => {},
    });

    expect(result.findings.some((f) => f.title === "Reported only after being nudged")).toBe(true);
  });
});
