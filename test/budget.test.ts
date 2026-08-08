import { describe, expect, it } from "vitest";
import { BudgetManager, emptyLedger } from "../src/budget/budget.js";
import type { BudgetConfig } from "../src/types.js";

const CONFIG: BudgetConfig = {
  totalCny: 10,
  usdToCny: 7.25,
  ladder: [
    { atFraction: 0, model: { provider: "openai", id: "big" } },
    { atFraction: 0.5, model: { provider: "openai", id: "mid" } },
    { atFraction: 0.85, model: { provider: "openai", id: "small" } },
  ],
  squeezeAtFraction: 0.75,
  hardStopAtFraction: 1,
};

/** Spend exactly `cny` by recording one call priced to hit it. */
function spend(budget: BudgetManager, cny: number): void {
  budget.record("openai/big", { input: 1000, output: 100, cost: { total: cny / CONFIG.usdToCny } });
}

describe("BudgetManager — accounting", () => {
  it("converts USD to CNY at the configured rate", () => {
    const budget = new BudgetManager(CONFIG);
    budget.record("openai/big", { input: 100, output: 10, cost: { total: 1 } });
    expect(budget.spend.usd).toBe(1);
    expect(budget.spend.cny).toBeCloseTo(7.25, 6);
  });

  it("accumulates tokens and calls per model", () => {
    const budget = new BudgetManager(CONFIG);
    budget.record("openai/big", { input: 100, output: 10, cacheRead: 5, cost: { total: 0.1 } });
    budget.record("openai/mid", { input: 200, output: 20, cost: { total: 0.02 } });
    expect(budget.spend.calls).toBe(2);
    expect(budget.spend.inputTokens).toBe(300);
    expect(budget.spend.cacheReadTokens).toBe(5);
    expect(budget.spend.byModel["openai/big"]?.calls).toBe(1);
    expect(budget.spend.byModel["openai/mid"]?.usd).toBeCloseTo(0.02, 6);
  });

  it("clamps the reported fraction at 1 so gauges cannot overflow", () => {
    const budget = new BudgetManager(CONFIG);
    spend(budget, 25);
    expect(budget.fraction).toBe(1);
    expect(budget.rawFraction).toBeCloseTo(2.5, 6);
  });
});

describe("BudgetManager — downgrade ladder", () => {
  it("starts on the first rung", () => {
    expect(new BudgetManager(CONFIG).currentModel().id).toBe("big");
  });

  it("downgrades once spend crosses a rung", () => {
    const budget = new BudgetManager(CONFIG);
    const events: string[] = [];
    budget.onEvent((event) => events.push(`${event.kind}:${event.detail}`));

    spend(budget, 5.1);
    const decision = budget.authorize();

    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.model.id).toBe("mid");
    expect(decision.allowed && decision.downgradedFrom?.id).toBe("big");
    expect(events.some((event) => event.startsWith("downgrade:"))).toBe(true);
  });

  it("does not downgrade below the crossed rung", () => {
    const budget = new BudgetManager(CONFIG);
    spend(budget, 4.9);
    expect(budget.authorize().allowed && budget.currentModel().id).toBe("big");
  });

  it("skips straight to the last rung when spend jumps past several", () => {
    const budget = new BudgetManager(CONFIG);
    spend(budget, 9);
    budget.authorize();
    expect(budget.currentModel().id).toBe("small");
    expect(budget.ladderStage).toBe(2);
  });

  it("never climbs back up after a downgrade", () => {
    const budget = new BudgetManager(CONFIG);
    spend(budget, 9);
    budget.authorize();
    expect(budget.currentModel().id).toBe("small");
    // A ladder that could reverse would make cost non-monotonic and confuse the user.
    budget.authorize();
    expect(budget.currentModel().id).toBe("small");
  });

  it("emits a downgrade event only once per rung", () => {
    const budget = new BudgetManager(CONFIG);
    const downgrades: string[] = [];
    budget.onEvent((event) => event.kind === "downgrade" && downgrades.push(event.detail));
    spend(budget, 6);
    budget.authorize();
    budget.authorize();
    budget.authorize();
    expect(downgrades).toHaveLength(1);
  });
});

describe("BudgetManager — context squeeze", () => {
  it("engages once past the squeeze threshold", () => {
    const budget = new BudgetManager(CONFIG);
    expect(budget.squeezed).toBe(false);
    spend(budget, 7.6);
    budget.authorize();
    expect(budget.squeezed).toBe(true);
  });

  it("fires its event exactly once", () => {
    const budget = new BudgetManager(CONFIG);
    let count = 0;
    budget.onEvent((event) => event.kind === "squeeze" && count++);
    spend(budget, 8);
    budget.authorize();
    budget.authorize();
    expect(count).toBe(1);
  });
});

describe("BudgetManager — hard stop", () => {
  it("refuses further calls at 100%", () => {
    const budget = new BudgetManager(CONFIG);
    spend(budget, 10);
    const decision = budget.authorize();
    expect(decision).toEqual({ allowed: false, reason: "hard_stop" });
    expect(budget.hardStopped).toBe(true);
  });

  it("stays stopped on subsequent calls without re-emitting", () => {
    const budget = new BudgetManager(CONFIG);
    let stops = 0;
    budget.onEvent((event) => event.kind === "hard_stop" && stops++);
    spend(budget, 12);
    budget.authorize();
    budget.authorize();
    expect(stops).toBe(1);
    expect(budget.authorize().allowed).toBe(false);
  });

  it("allows the call that lands exactly under the limit", () => {
    const budget = new BudgetManager(CONFIG);
    spend(budget, 9.99);
    expect(budget.authorize().allowed).toBe(true);
  });
});

describe("BudgetManager — resume", () => {
  it("continues from a restored ledger rather than starting at zero", () => {
    const ledger = emptyLedger();
    ledger.usd = 1;
    ledger.cny = 7.25;

    const budget = new BudgetManager(CONFIG, { ledger, stage: 1, squeezed: false });
    expect(budget.spend.cny).toBeCloseTo(7.25, 6);
    // Restored at 72.5% spent: still on rung 1, and one more call pushes it to squeeze.
    expect(budget.currentModel().id).toBe("mid");
    spend(budget, 0.5);
    budget.authorize();
    expect(budget.squeezed).toBe(true);
  });

  it("round-trips through a snapshot", () => {
    const budget = new BudgetManager(CONFIG);
    spend(budget, 8.6);
    budget.authorize();
    const snapshot = budget.snapshot();

    const restored = new BudgetManager(CONFIG, snapshot);
    expect(restored.currentModel().id).toBe("small");
    expect(restored.squeezed).toBe(true);
    expect(restored.spend.cny).toBeCloseTo(8.6, 6);
  });
});

describe("BudgetManager — estimation", () => {
  it("prices a hypothetical call in CNY", () => {
    const budget = new BudgetManager(CONFIG);
    // 1M input @ $2 + 1M output @ $10 = $12 → ¥87
    const estimate = budget.estimateCny(1_000_000, 1_000_000, { input: 2, output: 10 });
    expect(estimate).toBeCloseTo(12 * 7.25, 4);
  });
});
