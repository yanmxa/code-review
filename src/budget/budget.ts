import type { BudgetConfig, ModelRef, SpendLedger } from "../types.js";
import { formatBudget } from "./limit.js";

export type BudgetDecision =
  | { allowed: true; model: ModelRef }
  | { allowed: false; reason: "exhausted" };

export interface BudgetEvent {
  kind: "downgrade" | "squeeze" | "hard_stop";
  detail: string;
}

export function emptyLedger(): SpendLedger {
  return {
    usd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    calls: 0,
    byModel: {},
  };
}

/**
 * The run's spend ledger, and the control loop that reacts to it.
 *
 * Two rules, deliberately different:
 *
 *   **Stop on fact.** The run halts when the budget is actually spent. That is
 *   a real constraint and needs no forecasting.
 *
 *   **Steer on forecast.** Choosing when to downgrade from how much has been
 *   spent ignores the only thing that matters — whether the remaining work will
 *   fit. Spending half the budget on half the files is exactly on track and
 *   must not trigger anything; spending half on a fifth of them is an emergency.
 *   So the ladder steps on projected total, recomputed after each unit.
 *
 * That is why the ladder carries no thresholds. It is an ordered list of models
 * and nothing more: over budget, step down one rung; out of rungs and still
 * over, squeeze the context; actually out of money, stop.
 */
export class BudgetManager {
  private readonly listeners: ((event: BudgetEvent) => void)[] = [];
  private ledger: SpendLedger;
  private stage = 0;
  private squeezedFlag = false;
  private reserved = 0;
  private stopped = false;
  private projection?: number;

  constructor(
    private readonly config: BudgetConfig,
    initial?: { ledger?: SpendLedger; stage?: number; squeezed?: boolean },
  ) {
    this.ledger = initial?.ledger ?? emptyLedger();
    this.stage = initial?.stage ?? 0;
    this.squeezedFlag = initial?.squeezed ?? false;
  }

  onEvent(listener: (event: BudgetEvent) => void): void {
    this.listeners.push(listener);
  }

  get spend(): SpendLedger {
    return this.ledger;
  }

  /** Consumption so far, expressed in the budget's own unit. */
  get spent(): number {
    const unit = this.config.limit.unit;
    if (unit === "tokens") return this.ledger.inputTokens + this.ledger.outputTokens;
    if (unit === "USD") return this.ledger.usd;
    return this.ledger.usd * this.config.usdToCny;
  }

  get limit(): number {
    return this.config.limit.amount;
  }

  /**
   * The ceiling in force right now: the limit, less anything held back.
   *
   * The pull-request pass runs after every file, which put the most valuable
   * work in the position that is cheapest to sacrifice — it inherited whatever
   * rung the ladder had fallen to, and a run that hit the limit dropped it
   * silently. Coverage is the commodity here and cross-cutting judgement is the
   * scarce good; holding a share back means the sweep downgrades itself rather
   * than starving the one pass nothing else can do.
   *
   * `limit` itself is untouched, because that is the number the user typed and
   * the gauge has to keep showing it.
   */
  get workingLimit(): number {
    return Math.max(0, this.limit - this.reserved);
  }

  /** Hold back `amount`, or a share of the limit, for work still to come. */
  reserveFor(amount: number): void {
    this.reserved = Math.max(0, Math.min(amount, this.limit));
  }

  /** The held-back share is now the work being done. */
  releaseReserve(): void {
    if (this.reserved === 0) return;
    this.reserved = 0;
    // Latched by a limit that no longer applies: a sweep that stopped on the
    // reduced ceiling must not carry that stop into the pass it stopped for.
    this.stopped = this.spent >= this.limit;
  }

  get unit(): BudgetConfig["limit"]["unit"] {
    return this.config.limit.unit;
  }

  get usdToCnyRate(): number {
    return this.config.usdToCny;
  }

  /** Spent / limit, clamped so gauges never overflow. */
  get fraction(): number {
    return Math.min(1, this.rawFraction);
  }

  get rawFraction(): number {
    return this.limit > 0 ? this.spent / this.limit : 0;
  }

  get ladderStage(): number {
    return this.stage;
  }

  get hardStopped(): boolean {
    return this.stopped;
  }

  get squeezed(): boolean {
    return this.squeezedFlag;
  }

  /** What the run is currently forecast to consume in total, once measurable. */
  get projectedTotal(): number | undefined {
    return this.projection;
  }

  currentModel(): ModelRef {
    const models = this.config.models;
    return (models[this.stage] ?? models[models.length - 1])!;
  }

  /**
   * Whether the budget is spent, latching and announcing it the moment we notice.
   *
   * Callers other than {@link authorize} need this: the ledger can cross the
   * limit on a response, and nothing would observe it until the next request.
   * Reading a stale flag would let one more unit start on money already gone.
   */
  checkExhausted(): boolean {
    if (this.stopped) return true;
    if (this.workingLimit > 0 && this.spent < this.workingLimit) return false;
    this.stopped = true;
    const held =
      this.reserved > 0 ? ` (${this.formatted(this.reserved)} held for the pull-request pass)` : "";
    this.emit({
      kind: "hard_stop",
      detail: `${this.formatted(this.spent)} / ${this.formatted(this.limit)}${held}`,
    });
    return true;
  }

  /** Gate every LLM call. Only actual spend can refuse one. */
  authorize(): BudgetDecision {
    if (this.checkExhausted()) return { allowed: false, reason: "exhausted" };
    return { allowed: true, model: this.currentModel() };
  }

  /**
   * Recompute the forecast after a unit finishes, and escalate if it overruns.
   *
   * At most one step per unit: a single expensive file should nudge the ladder,
   * not collapse it. Steps are one-way — a ladder that could climb back would
   * make cost non-monotonic and the run unpredictable.
   *
   * An early forecast is a small sample and can overreact, and that bias is
   * deliberate: downgrading a file too soon costs some review quality, while
   * downgrading too late costs whole files to the hard stop. The cheaper
   * mistake is the one to make.
   */
  reviewProgress(unitsDone: number, unitsTotal: number): void {
    if (unitsDone <= 0 || unitsTotal <= 0) return;
    const progress = Math.min(1, unitsDone / unitsTotal);
    this.projection = this.spent / progress;

    if (this.projection <= this.workingLimit) return;

    const over =
      `projected ${this.formatted(this.projection)} against ${this.formatted(this.workingLimit)} ` +
      `after ${unitsDone}/${unitsTotal} files`;

    if (this.stage < this.config.models.length - 1) {
      const from = this.currentModel();
      this.stage++;
      const to = this.currentModel();
      this.emit({
        kind: "downgrade",
        detail: `${from.provider}/${from.id} → ${to.provider}/${to.id} — ${over}`,
      });
      return;
    }

    if (!this.squeezedFlag) {
      this.squeezedFlag = true;
      this.emit({ kind: "squeeze", detail: `trimming context — ${over}` });
    }
  }

  /** Fold a completed call's usage into the ledger. */
  record(modelId: string, usage: UsageLike): void {
    const usd = usage.cost?.total ?? 0;
    this.ledger.usd += usd;
    this.ledger.inputTokens += usage.input ?? 0;
    this.ledger.outputTokens += usage.output ?? 0;
    this.ledger.cacheReadTokens += usage.cacheRead ?? 0;
    this.ledger.calls += 1;

    const entry = (this.ledger.byModel[modelId] ??= {
      usd: 0,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    entry.usd += usd;
    entry.calls += 1;
    entry.inputTokens += usage.input ?? 0;
    entry.outputTokens += usage.output ?? 0;
  }

  /** Cost of a hypothetical call in the budget's unit, for the pre-flight warning. */
  estimate(inputTokens: number, outputTokens: number, rates: { input: number; output: number }): number {
    if (this.config.limit.unit === "tokens") return inputTokens + outputTokens;
    const usd = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
    return this.config.limit.unit === "USD" ? usd : usd * this.config.usdToCny;
  }

  formatted(value: number): string {
    return formatBudget(value, this.config.limit.unit);
  }

  snapshot(): { ledger: SpendLedger; stage: number; squeezed: boolean } {
    return { ledger: this.ledger, stage: this.stage, squeezed: this.squeezedFlag };
  }

  private emit(event: BudgetEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cost?: { total?: number };
}
