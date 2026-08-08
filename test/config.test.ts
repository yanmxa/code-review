import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, primaryModel, resolveConfig } from "../src/config.js";

describe("config — the model a run starts on", () => {
  it("comes from the head of the ladder, which is the only place it is written", () => {
    // A separate `primary` field stated the same fact twice, and two statements
    // of one fact can disagree.
    const config = resolveConfig({
      budget: { models: [{ provider: "openai", id: "a" }, { provider: "openai", id: "b" }] },
    });
    expect(primaryModel(config)).toEqual({ provider: "openai", id: "a" });
  });

  it("follows the ladder when a config replaces it", () => {
    const config = resolveConfig({ budget: { models: ["moonshotai/kimi-k2.5"] } as never });
    expect(primaryModel(config).provider).toBe("moonshotai");
  });

  it("has no settings for passes that do not exist", () => {
    // triage and verify were configurable while nothing read them, which told
    // users they could tune behaviour that was never implemented.
    expect(JSON.stringify(DEFAULT_CONFIG)).not.toContain("triage");
    expect(JSON.stringify(DEFAULT_CONFIG)).not.toContain("verify");
  });
});

describe("config — layering", () => {
  it("lets a later layer win field by field", () => {
    const config = resolveConfig({ lang: "en" }, { budget: { limit: "¥3" } as never });
    expect(config.lang).toBe("en");
    expect(config.budget.limit).toEqual({ amount: 3, unit: "CNY" });
  });

  it("accumulates custom rules rather than replacing them", () => {
    // A project config should be able to add to a user's personal rules.
    const config = resolveConfig(
      { rules: { custom: [{ id: "a", severity: "minor", pattern: "a", title: "A", body: "a" }] } },
      { rules: { custom: [{ id: "b", severity: "minor", pattern: "b", title: "B", body: "b" }] } },
    );
    expect(config.rules.custom.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("migrates the shape earlier versions wrote", () => {
    const config = resolveConfig({
      budget: {
        totalCny: 25,
        ladder: [{ atFraction: 0, model: { provider: "openai", id: "old" } }],
      },
    } as never);
    expect(config.budget.limit).toEqual({ amount: 25, unit: "CNY" });
    expect(primaryModel(config).id).toBe("old");
  });

  it("rejects a custom rule whose regex does not compile", () => {
    // Silently never matching is the worst outcome for a check someone wrote
    // on purpose, so it fails when the config loads.
    expect(() =>
      resolveConfig({
        rules: { custom: [{ id: "bad", severity: "minor", pattern: "([", title: "x", body: "y" }] },
      }),
    ).toThrow(/not a valid regex/);
  });
});
