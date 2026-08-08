import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { allModelCandidates, modelChoices, suggestLadder } from "../src/init/prompts.js";
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

const choice = (id: string, input: number): ModelChoice => ({
  ref: { provider: "openai", id },
  label: `openai/${id}`,
  inputCost: input,
  outputCost: input * 6,
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
