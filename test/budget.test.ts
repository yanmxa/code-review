import { describe, expect, it } from "vitest";
import { BudgetManager, emptyLedger } from "../src/budget/budget.js";
import {
  formatBudget,
  formatTokenCount,
  parseBudgetLimit,
  serializeBudgetLimit,
} from "../src/budget/limit.js";
import type { BudgetConfig } from "../src/types.js";

function config(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    limit: { amount: 10, unit: "CNY" },
    usdToCny: 7.25,
    models: [
      { provider: "openai", id: "big" },
      { provider: "openai", id: "mid" },
      { provider: "openai", id: "small" },
    ],
    ...overrides,
  };
}

/** Spend exactly `cny` by recording one call priced to hit it. */
function spendCny(budget: BudgetManager, cny: number): void {
  budget.record("openai/big", { input: 1000, output: 100, cost: { total: cny / 7.25 } });
}

describe("parseBudgetLimit", () => {
  const cases: [string, number, string][] = [
    ["10", 10, "CNY"],
    ["¥10", 10, "CNY"],
    ["10cny", 10, "CNY"],
    ["10元", 10, "CNY"],
    ["$1.50", 1.5, "USD"],
    ["1.5usd", 1.5, "USD"],
    ["800k tokens", 800_000, "tokens"],
    ["1.2M tokens", 1_200_000, "tokens"],
    ["500000 tokens", 500_000, "tokens"],
  ];

  for (const [input, amount, unit] of cases) {
    it(`reads "${input}" as ${amount} ${unit}`, () => {
      expect(parseBudgetLimit(input)).toEqual({ amount, unit });
    });
  }

  it("gives a bare number the configured default unit", () => {
    // Without this, `--budget 10` would be a number with no meaning.
    expect(parseBudgetLimit("10", "USD")).toEqual({ amount: 10, unit: "USD" });
    expect(parseBudgetLimit("500k", "tokens")).toEqual({ amount: 500_000, unit: "tokens" });
  });

  it("rejects what it cannot read rather than guessing", () => {
    expect(() => parseBudgetLimit("ten")).toThrow(/Cannot read/);
    expect(() => parseBudgetLimit("10 euros")).toThrow(/Unknown budget unit/);
    expect(() => parseBudgetLimit("0")).toThrow(/positive/);
    expect(() => parseBudgetLimit("")).toThrow(/empty/);
  });

  it("round-trips through its own formatter", () => {
    expect(formatBudget(10, "CNY")).toBe("¥10.00");
    expect(formatBudget(1.5, "USD")).toBe("$1.50");
    expect(formatBudget(800_000, "tokens")).toBe("800k tokens");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
  });
});

describe("BudgetManager — accounting in the limit's unit", () => {
  it("counts CNY by converting the provider's USD at the configured rate", () => {
    const budget = new BudgetManager(config());
    budget.record("openai/big", { input: 100, output: 10, cost: { total: 1 } });
    expect(budget.spent).toBeCloseTo(7.25, 6);
    expect(budget.spend.usd).toBe(1);
  });

  it("counts USD directly, with no exchange rate involved", () => {
    const budget = new BudgetManager(config({ limit: { amount: 5, unit: "USD" } }));
    budget.record("openai/big", { input: 100, output: 10, cost: { total: 1.25 } });
    expect(budget.spent).toBeCloseTo(1.25, 6);
  });

  it("counts tokens, which need no price at all", () => {
    const budget = new BudgetManager(config({ limit: { amount: 10_000, unit: "tokens" } }));
    budget.record("openai/big", { input: 3000, output: 500, cost: { total: 0 } });
    expect(budget.spent).toBe(3500);
  });

  it("tracks tokens and dollars regardless of which one is the limit", () => {
    const budget = new BudgetManager(config());
    budget.record("openai/big", { input: 100, output: 10, cacheRead: 5, cost: { total: 0.1 } });
    budget.record("openai/mid", { input: 200, output: 20, cost: { total: 0.02 } });
    expect(budget.spend.calls).toBe(2);
    expect(budget.spend.inputTokens).toBe(300);
    expect(budget.spend.cacheReadTokens).toBe(5);
    expect(budget.spend.byModel["openai/mid"]?.usd).toBeCloseTo(0.02, 6);
  });

  it("clamps the reported fraction at 1 so gauges cannot overflow", () => {
    const budget = new BudgetManager(config());
    spendCny(budget, 25);
    expect(budget.fraction).toBe(1);
    expect(budget.rawFraction).toBeCloseTo(2.5, 6);
  });
});

describe("BudgetManager — the ladder steps on forecast, not on spend", () => {
  it("does not downgrade when spend and progress are in step", () => {
    // Half the budget on half the files is exactly on track. Downgrading here
    // would make the remaining files worse for no reason — the flaw that
    // replaced the old fixed-threshold ladder.
    const budget = new BudgetManager(config());
    spendCny(budget, 5);
    budget.reviewProgress(5, 10);
    expect(budget.currentModel().id).toBe("big");
    expect(budget.projectedTotal).toBeCloseTo(10, 6);
  });

  it("downgrades when the run is projected to overrun", () => {
    const budget = new BudgetManager(config());
    const events: string[] = [];
    budget.onEvent((event) => events.push(event.kind));

    spendCny(budget, 5); // half the money…
    budget.reviewProgress(2, 10); // …on a fifth of the files

    expect(budget.projectedTotal).toBeCloseTo(25, 6);
    expect(budget.currentModel().id).toBe("mid");
    expect(events).toContain("downgrade");
  });

  it("downgrades one rung at a time, so one costly file cannot collapse the ladder", () => {
    const budget = new BudgetManager(config());
    spendCny(budget, 9);
    budget.reviewProgress(1, 10); // projects ¥90 — wildly over
    expect(budget.currentModel().id).toBe("mid");
    budget.reviewProgress(2, 10);
    expect(budget.currentModel().id).toBe("small");
  });

  it("never climbs back up", () => {
    const budget = new BudgetManager(config());
    spendCny(budget, 5);
    budget.reviewProgress(2, 10);
    expect(budget.currentModel().id).toBe("mid");

    // The forecast improves, but a reversible ladder would make cost
    // non-monotonic and the run unpredictable.
    budget.reviewProgress(9, 10);
    expect(budget.currentModel().id).toBe("mid");
  });

  it("squeezes context once the ladder is exhausted and it is still over", () => {
    const budget = new BudgetManager(config());
    const kinds: string[] = [];
    budget.onEvent((event) => kinds.push(event.kind));

    spendCny(budget, 8);
    budget.reviewProgress(1, 10); // → mid
    budget.reviewProgress(2, 10); // → small
    expect(budget.squeezed).toBe(false);
    budget.reviewProgress(3, 10); // no rungs left → squeeze
    expect(budget.squeezed).toBe(true);
    expect(kinds).toEqual(["downgrade", "downgrade", "squeeze"]);
  });

  it("does nothing before any unit has finished", () => {
    // With no progress there is no forecast, only a division by zero.
    const budget = new BudgetManager(config());
    spendCny(budget, 9);
    budget.reviewProgress(0, 10);
    expect(budget.currentModel().id).toBe("big");
    expect(budget.projectedTotal).toBeUndefined();
  });

  it("stays on the primary model for a run that is comfortably inside budget", () => {
    const budget = new BudgetManager(config());
    for (let done = 1; done <= 10; done++) {
      spendCny(budget, 0.2);
      budget.reviewProgress(done, 10);
    }
    expect(budget.currentModel().id).toBe("big");
    expect(budget.squeezed).toBe(false);
  });
});

describe("BudgetManager — stopping is about fact, not forecast", () => {
  it("allows calls while money remains, however bad the forecast", () => {
    const budget = new BudgetManager(config());
    spendCny(budget, 1);
    budget.reviewProgress(1, 100); // projects ¥100 against a ¥10 budget
    expect(budget.authorize().allowed).toBe(true);
  });

  it("refuses once the budget is actually spent", () => {
    const budget = new BudgetManager(config());
    spendCny(budget, 10);
    expect(budget.authorize()).toEqual({ allowed: false, reason: "exhausted" });
    expect(budget.hardStopped).toBe(true);
  });

  it("announces the stop exactly once", () => {
    const budget = new BudgetManager(config());
    let stops = 0;
    budget.onEvent((event) => event.kind === "hard_stop" && stops++);
    spendCny(budget, 12);
    budget.authorize();
    budget.authorize();
    expect(stops).toBe(1);
  });

  it("allows the call that lands just under the limit", () => {
    const budget = new BudgetManager(config());
    spendCny(budget, 9.99);
    expect(budget.authorize().allowed).toBe(true);
  });

  it("stops on tokens the same way it stops on money", () => {
    const budget = new BudgetManager(config({ limit: { amount: 1000, unit: "tokens" } }));
    budget.record("openai/big", { input: 900, output: 200, cost: { total: 0 } });
    expect(budget.authorize().allowed).toBe(false);
  });
});

describe("BudgetManager — resume", () => {
  it("continues from a restored ledger and rung", () => {
    const ledger = emptyLedger();
    ledger.usd = 1;
    const budget = new BudgetManager(config(), { ledger, stage: 1, squeezed: true });
    expect(budget.spent).toBeCloseTo(7.25, 6);
    expect(budget.currentModel().id).toBe("mid");
    expect(budget.squeezed).toBe(true);
  });

  it("round-trips through a snapshot", () => {
    const budget = new BudgetManager(config());
    spendCny(budget, 8);
    budget.reviewProgress(1, 10);
    const restored = new BudgetManager(config(), budget.snapshot());
    expect(restored.currentModel().id).toBe(budget.currentModel().id);
    expect(restored.spent).toBeCloseTo(budget.spent, 6);
  });
});

describe("BudgetManager — estimation", () => {
  it("prices a hypothetical call in the budget's unit", () => {
    // 1M input @ $2 + 1M output @ $10 = $12
    const rates = { input: 2, output: 10 };
    expect(new BudgetManager(config()).estimate(1e6, 1e6, rates)).toBeCloseTo(12 * 7.25, 4);
    expect(
      new BudgetManager(config({ limit: { amount: 5, unit: "USD" } })).estimate(1e6, 1e6, rates),
    ).toBeCloseTo(12, 4);
    expect(
      new BudgetManager(config({ limit: { amount: 5, unit: "tokens" } })).estimate(1e6, 1e6, rates),
    ).toBe(2e6);
  });
});

describe("budget limits round-trip", () => {
  it("re-reads whatever it wrote", () => {
    for (const input of ["¥10", "$1.50", "800k tokens", "1.2M tokens"]) {
      const parsed = parseBudgetLimit(input);
      expect(parseBudgetLimit(serializeBudgetLimit(parsed))).toEqual(parsed);
    }
  });
});

describe("holding budget back for work still to come", () => {
  it("stops the sweep early enough to leave the reserve intact", () => {
    // The pull-request pass runs last, which made it the cheapest thing to
    // sacrifice: it inherited the ladder's lowest rung and a run that hit the
    // limit dropped it without saying so.
    const budget = new BudgetManager(config());
    budget.reserveFor(1.5);
    spendCny(budget, 8.6);
    expect(budget.checkExhausted()).toBe(true);
    // And the number the user typed is still the number on the gauge.
    expect(budget.limit).toBe(10);
  });

  it("un-latches when the reserve becomes the work being done", () => {
    const budget = new BudgetManager(config());
    budget.reserveFor(1.5);
    spendCny(budget, 8.6);
    expect(budget.checkExhausted()).toBe(true);
    budget.releaseReserve();
    expect(budget.checkExhausted()).toBe(false);
    expect(budget.authorize().allowed).toBe(true);
  });

  it("stays stopped when the money is genuinely gone", () => {
    const budget = new BudgetManager(config());
    budget.reserveFor(1.5);
    spendCny(budget, 10.4);
    expect(budget.checkExhausted()).toBe(true);
    budget.releaseReserve();
    expect(budget.checkExhausted()).toBe(true);
  });

  it("steps the ladder against the working ceiling, not the full one", () => {
    const budget = new BudgetManager(config());
    budget.reserveFor(1.5);
    spendCny(budget, 4.3);
    // Forecast 8.6 — inside the ¥10 limit, over the ¥8.50 the sweep may use.
    budget.reviewProgress(1, 2);
    expect(budget.currentModel().id).toBe("mid");
  });
});
