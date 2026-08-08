import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { allModelCandidates, buildInitConfig, modelChoices, suggestLadder } from "../src/init/prompts.js";
import type { ModelChoice } from "../src/init/prompts.js";

function registry(models: { id: string; input: number; output: number; reasoning?: boolean }[]) {
  const faux = fauxProvider({
    provider: "openai",
    models: models.map((m) => ({
      id: m.id,
      reasoning: m.reasoning ?? true,
      cost: { input: m.input, output: m.output, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  const collection = createModels();
  collection.setProvider(faux.provider);
  return collection;
}

const choice = (id: string, input: number, subscription = false): ModelChoice => ({
  ref: { provider: "openai", id },
  label: `openai/${id}`,
  inputCost: input,
  outputCost: input * 6,
  subscription,
});

describe("model candidates", () => {
  it("leaves out what nobody would review with", () => {
    // A registry holds ancient and eye-watering models; offering them turns a
    // choice into a search.
    const models = registry([
      { id: "gpt-5.4", input: 2.5, output: 15 },
      { id: "o1-pro", input: 150, output: 600 },
      { id: "free-tier", input: 0, output: 0 },
      { id: "chatty", input: 1, output: 4, reasoning: false },
    ]);
    expect(allModelCandidates(models).map((c) => c.ref.id)).toEqual(["gpt-5.4"]);
  });

  it("leaves out models that reason but do not review", () => {
    // `gpt-realtime` is a speech model whose registry entry sets `reasoning`,
    // and it was cheap enough to be offered as a review fallback. Falling back
    // to it is not a degraded review, it is a different product.
    const models = registry([
      { id: "gpt-5.4", input: 2.5, output: 15 },
      { id: "gpt-realtime-2.1", input: 4, output: 16 },
      { id: "gpt-4o-audio-preview", input: 2.5, output: 10 },
    ]);
    expect(allModelCandidates(models).map((c) => c.ref.id)).toEqual(["gpt-5.4"]);
  });

  it("marks the providers reached through a subscription", () => {
    const models = registry([{ id: "gpt-5.4", input: 2.5, output: 15 }]);
    expect(allModelCandidates(models, new Set(["openai"]))[0]!.subscription).toBe(true);
    expect(allModelCandidates(models)[0]!.subscription).toBe(false);
  });

  it("orders by price so the list reads top-down", () => {
    const models = registry([
      { id: "cheap", input: 0.2, output: 1 },
      { id: "dear", input: 5, output: 30 },
      { id: "mid", input: 2, output: 12 },
    ]);
    expect(allModelCandidates(models).map((c) => c.ref.id)).toEqual(["dear", "mid", "cheap"]);
  });
});

describe("the picker list", () => {
  const many = Array.from({ length: 20 }, (_, i) => choice(`m${i}`, 6 - i * 0.3));

  it("shows everything when there is little to show", () => {
    const few = [choice("a", 2), choice("b", 1)];
    expect(modelChoices(few, few[0]!.ref)).toHaveLength(2);
  });

  it("spans the price range instead of only the expensive end", () => {
    // A ladder needs cheap rungs, so they have to be visible.
    const shown = modelChoices(many, many[0]!.ref);
    expect(shown.length).toBeLessThanOrEqual(8);
    expect(shown[0]!.inputCost).toBeCloseTo(6, 5);
    expect(shown[shown.length - 1]!.inputCost).toBeLessThan(1);
  });

  it("always keeps the default visible", () => {
    const target = many[7]!;
    const shown = modelChoices(many, target.ref);
    expect(shown.map((c) => c.label)).toContain(target.label);
  });

  it("never samples away a model the user signed in for", () => {
    // Sampling once dropped every subscription model, so an OAuth login looked
    // like it had done nothing. They cost no extra to run; they are all shown.
    const subscribed = Array.from({ length: 6 }, (_, i) => choice(`sub${i}`, 5 - i * 0.5, true));
    const shown = modelChoices([...subscribed, ...many], many[0]!.ref);
    for (const model of subscribed) expect(shown.map((c) => c.label)).toContain(model.label);
    // And they lead, because a plan costs nothing more to use than it already did.
    expect(shown.slice(0, subscribed.length).every((c) => c.subscription)).toBe(true);
  });
});

describe("the config an answer set implies", () => {
  const base = { lang: "zh" as const, budget: "¥10.00", ladder: [], ignore: "" };

  it("writes nothing when every answer is the default", () => {
    expect(buildInitConfig(base)).toEqual({});
  });

  it("records only what differs", () => {
    expect(buildInitConfig({ ...base, budget: "$2", ignore: "命名风格, 注释格式" })).toEqual({
      budget: { limit: "$2.00" },
      review: { ignore: ["命名风格", "注释格式"] },
    });
  });

  it("puts the chosen model at the head of the ladder", () => {
    const config = buildInitConfig({
      ...base,
      model: { provider: "openai", id: "gpt-5.4" },
      ladder: [{ provider: "openai", id: "gpt-5.4-mini" }],
    });
    expect(config.budget?.models).toEqual(["openai/gpt-5.4", "openai/gpt-5.4-mini"]);
  });

  it("leaves an unparseable amount out rather than guessing at one", () => {
    expect(buildInitConfig({ ...base, budget: "lots" })).toEqual({});
  });
});

describe("ladder suggestions", () => {
  const candidates = [
    choice("gpt-5.4", 2.5),
    choice("gpt-5.4-mini", 0.75),
    choice("gpt-5.4-nano", 0.2),
    choice("o3", 2),
    choice("gpt-5.1", 1.25),
  ];

  it("stays inside the family, so only the price changes between rungs", () => {
    const ladder = suggestLadder({ provider: "openai", id: "gpt-5.4" }, candidates);
    expect(ladder.map((r) => r.id)).toEqual(["gpt-5.4-mini", "gpt-5.4-nano"]);
  });

  it("draws on every candidate, not just what the picker showed", () => {
    // Regression: suggestions came from the shortened display list, so the
    // cheaper family members were routinely missing and the ladder crossed
    // families for no reason.
    const shown = modelChoices(candidates, candidates[0]!.ref, 2);
    expect(shown.map((c) => c.ref.id)).not.toContain("gpt-5.4-nano");
    expect(suggestLadder({ provider: "openai", id: "gpt-5.4" }, candidates).map((r) => r.id)).toContain(
      "gpt-5.4-nano",
    );
  });

  it("falls back to the next cheaper models when a family has no siblings", () => {
    const ladder = suggestLadder({ provider: "openai", id: "o3" }, candidates);
    expect(ladder.map((r) => r.id)).toEqual(["gpt-5.1", "gpt-5.4-mini"]);
  });

  it("suggests nothing when the choice is already the cheapest", () => {
    expect(suggestLadder({ provider: "openai", id: "gpt-5.4-nano" }, candidates)).toEqual([]);
  });
});
