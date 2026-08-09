import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";
import { runReview } from "../src/engine/pipeline.js";
import { CROSS_FILE_UNIT_ID } from "../src/engine/cross-file.js";
import { Redactor } from "../src/security/redactor.js";
import { Tracer } from "../src/trace/tracer.js";
import type { RunEvent } from "../src/types.js";
import { FakePlatform, SAMPLE_DIFF, TEST_TARGET } from "./helpers/fake-platform.js";

let runDir: string;
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "cross-file-"));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

function withUsage(message: ReturnType<typeof fauxAssistantMessage>) {
  // The faux provider reports zero usage unless the message carries its own.
  message.usage = {
    input: 2000,
    output: 200,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2200,
    cost: { input: 0.006, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  };
  return message;
}

function submit(findings: unknown[]) {
  return withUsage(
    fauxAssistantMessage([fauxToolCall("submit_findings", { findings, summary: "reviewed" })]),
  );
}

function toolCall(name: string, args: Record<string, unknown>) {
  return withUsage(fauxAssistantMessage([fauxToolCall(name, args)]));
}

async function run(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "gpt-5.4", cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 } }],
    tokensPerSecond: 100_000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);

  const events: RunEvent[] = [];
  const result = await runReview(TEST_TARGET, {
    adapter: new FakePlatform(SAMPLE_DIFF),
    models,
    redactor: new Redactor(),
    config: resolveConfig({ runDir, lang: "en", budget: { models: ["openai/gpt-5.4"] } }),
    emit: (event) => events.push(event),
  });
  return { ...result, events, faux };
}

describe("the pull-request pass", () => {
  it("runs after the files and is checkpointed like one", async () => {
    // Registering it as a unit is what buys resume, progress and forecasting
    // without a special case in any of them.
    const { store, events } = await run([submit([]), submit([]), submit([])]);
    const ids = store.current.units.map((unit) => unit.id);
    expect(ids[ids.length - 1]).toBe(CROSS_FILE_UNIT_ID);
    expect(store.unit(CROSS_FILE_UNIT_ID)?.status).toBe("done");

    const started = events.filter((e) => e.type === "unit_start").map((e) => e.unitId);
    expect(started[started.length - 1]).toBe(CROSS_FILE_UNIT_ID);
  });

  it("reports a finding about a file it was not handed", async () => {
    // The reason the pass exists. Anchoring it to one unit's hunks — as the
    // per-file grader does — would reject exactly the findings it is for.
    const { findings } = await run([
      submit([]),
      submit([]),
      submit([
        {
          path: "src/config.ts",
          line: 4,
          severity: "major",
          title: "retries added but no caller reads it",
          body: "`retries` is introduced here and never consumed by the cache change in this PR.",
          supportingToolCalls: [],
          certainty: "likely",
        },
      ]),
    ]);
    const cross = findings.find((finding) => finding.title.includes("retries"));
    expect(cross?.path).toBe("src/config.ts");
    expect(cross?.confidence).toBe("reference");
  });

  it("can read another file's diff rather than guessing a regular expression", async () => {
    const { faux } = await run([
      submit([]),
      submit([]),
      toolCall("get_diff", { path: "src/cache.ts" }),
      submit([]),
    ]);
    expect(faux.state.callCount).toBe(4);
  });

  it("does not run when there is only one file to hold in mind", async () => {
    // Two passes over one file is one pass too many: there is no "across".
    const single = SAMPLE_DIFF.slice(0, SAMPLE_DIFF.indexOf("diff --git a/src/config.ts"));
    const faux = fauxProvider({
      provider: "openai",
      models: [{ id: "gpt-5.4", cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 } }],
      tokensPerSecond: 100_000,
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([submit([])]);

    const result = await runReview(TEST_TARGET, {
      adapter: new FakePlatform(single),
      models,
      redactor: new Redactor(),
      config: resolveConfig({ runDir, lang: "en", budget: { models: ["openai/gpt-5.4"] } }),
      emit: () => {},
    });
    expect(result.store.current.units.map((unit) => unit.id)).not.toContain(CROSS_FILE_UNIT_ID);
  });

  it("leaves a trace of its own, like any other unit", async () => {
    const { store } = await run([submit([]), submit([]), submit([])]);
    const events = Tracer.read(store.dirs.root, "traces/#pull-request.jsonl");
    expect(events.some((event) => event.type === "llm_request")).toBe(true);
  });
});
