import type { BudgetConfig, ModelRef, SpendLedger } from "../types.js";

export type BudgetDecision =
  | { allowed: true; model: ModelRef; downgradedFrom?: ModelRef }
  | { allowed: false; reason: "hard_stop" };

export interface BudgetEvent {
  kind: "downgrade" | "squeeze" | "hard_stop";
  detail: string;
}

export function emptyLedger(): SpendLedger {
  return {
    usd: 0,
    cny: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    calls: 0,
    byModel: {},
  };
}

/**
 * The run's spend ledger and the policy that reacts to it.
 *
 * Every LLM call passes through {@link authorize} before it happens and
 * {@link record} after. That single funnel is why the budget can react mid-unit
 * rather than only between units: a downgrade takes effect on the very next turn.
 */
export class BudgetManager {
  private readonly listeners: ((event: BudgetEvent) => void)[] = [];
  private ledger: SpendLedger;
  private stage = 0;
  private squeezedFlag = false;
  private stopped = false;

  constructor(
    private readonly config: BudgetConfig,
    initial?: { ledger?: SpendLedger; stage?: number; squeezed?: boolean; hardStopped?: boolean },
  ) {
    this.ledger = initial?.ledger ?? emptyLedger();
    this.stage = initial?.stage ?? 0;
    this.squeezedFlag = initial?.squeezed ?? false;
    this.stopped = initial?.hardStopped ?? false;
  }

  onEvent(listener: (event: BudgetEvent) => void): void {
    this.listeners.push(listener);
  }

  get spend(): SpendLedger {
    return this.ledger;
  }

  get totalCny(): number {
    return this.config.totalCny;
  }

  /** Spent / total, clamped at 1 so gauges never overflow. */
  get fraction(): number {
    return Math.min(1, this.ledger.cny / this.config.totalCny);
  }

  /** Unclamped, for deciding whether the hard stop has been crossed. */
  get rawFraction(): number {
    return this.ledger.cny / this.config.totalCny;
  }

  get ladderStage(): number {
    return this.stage;
  }

  get hardStopped(): boolean {
    return this.stopped;
  }

  /**
   * Whether the budget is spent, latching and announcing it the moment we notice.
   *
   * Callers other than {@link authorize} need this: the ledger can cross the
   * limit on a response, and nothing would observe it until the next request
   * unless the check is available on its own. Reading a stale `hardStopped`
   * would let one more unit start on money that is already gone.
   */
  checkExhausted(): boolean {
    if (this.stopped) return true;
    if (this.rawFraction < this.config.hardStopAtFraction) return false;
    this.stopped = true;
    this.emit({
      kind: "hard_stop",
      detail: `¥${this.ledger.cny.toFixed(2)} / ¥${this.config.totalCny.toFixed(2)}`,
    });
    return true;
  }

  /** True once context should be trimmed to stretch the remaining budget. */
  get squeezed(): boolean {
    return this.squeezedFlag;
  }

  /** The model the current spend level calls for. */
  currentModel(): ModelRef {
    const ladder = this.config.ladder;
    return (ladder[this.stage] ?? ladder[ladder.length - 1])!.model;
  }

  /**
   * Decide whether the next LLM call may run, and on which model.
   *
   * Called before *every* request, including the ones a tool makes internally.
   */
  authorize(): BudgetDecision {
    if (this.checkExhausted()) return { allowed: false, reason: "hard_stop" };

    const previous = this.currentModel();
    this.advanceLadder();
    const model = this.currentModel();

    if (!this.squeezedFlag && this.rawFraction >= this.config.squeezeAtFraction) {
      this.squeezedFlag = true;
      this.emit({
        kind: "squeeze",
        detail: `${Math.round(this.rawFraction * 100)}% spent — trimming context`,
      });
    }

    if (model.id !== previous.id || model.provider !== previous.provider) {
      this.emit({
        kind: "downgrade",
        detail: `${previous.provider}/${previous.id} → ${model.provider}/${model.id} at ${Math.round(
          this.rawFraction * 100,
        )}%`,
      });
      return { allowed: true, model, downgradedFrom: previous };
    }

    return { allowed: true, model };
  }

  /** Fold a completed call's usage into the ledger. */
  record(modelId: string, usage: UsageLike): void {
    const usd = usage.cost?.total ?? 0;
    this.ledger.usd += usd;
    this.ledger.cny = this.ledger.usd * this.config.usdToCny;
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

  /**
   * Cost of a hypothetical call, for the pre-flight warning.
   * Uses the primary model's rates, which is the optimistic case.
   */
  estimateCny(inputTokens: number, outputTokens: number, rates: { input: number; output: number }): number {
    const usd = (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
    return usd * this.config.usdToCny;
  }

  snapshot(): { ledger: SpendLedger; stage: number; squeezed: boolean; hardStopped: boolean } {
    return {
      ledger: this.ledger,
      stage: this.stage,
      squeezed: this.squeezedFlag,
      hardStopped: this.stopped,
    };
  }

  private advanceLadder(): void {
    const ladder = this.config.ladder;
    let target = this.stage;
    for (let i = this.stage + 1; i < ladder.length; i++) {
      if (this.rawFraction >= (ladder[i] as { atFraction: number }).atFraction) target = i;
      else break;
    }
    this.stage = target;
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
