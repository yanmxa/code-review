import {
  type Component,
  Key,
  matchesKey,
  ProcessTerminal,
  type TUI,
  TuiAltScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, type ConfigOverrides } from "../config.js";
import { parseBudgetLimit, serializeBudgetLimit } from "../budget/limit.js";
import {
  buildInitConfig,
  INIT_TEXT,
  type InitAnswers,
  type InitStrings,
  type ModelChoice,
  suggestLadder,
} from "../init/prompts.js";
import type { ModelRef } from "../types.js";
import { GLYPH, theme } from "./theme.js";
import { clip, keyHints, panel, windowAround } from "./widgets.js";

type StepId = "lang" | "budget" | "model" | "ladder" | "ignore";

const STEPS: StepId[] = ["lang", "budget", "model", "ladder", "ignore"];

const BUDGET_DEFAULT = serializeBudgetLimit(DEFAULT_CONFIG.budget.limit);

/** A selectable line in the model list; headers separate the two billing kinds. */
type ModelRow = { kind: "header"; label: string } | { kind: "model"; choice: ModelChoice };

/**
 * The setup wizard.
 *
 * Everything else this tool shows you is a full-screen panelled view; a
 * sequence of readline questions in the same binary looked like a different
 * program. Beyond looking of a piece, the shape earns its keep twice: answered
 * steps collapse to one line each so the whole decision stays visible while you
 * make the next one, and the file that will be written is rendered live
 * underneath — the "only what differs is saved" rule is the sort of claim a
 * reader should be able to watch happen rather than take on trust.
 */
export class InitWizard implements Component {
  private step = 0;
  private cursor = 0;
  private readonly ladderPicked = new Set<string>();
  private answers: InitAnswers;
  private ladderOptions: ModelRef[] = [];
  private rows: ModelRow[] = [];

  constructor(
    private readonly tui: TUI,
    private readonly candidates: ModelChoice[],
    private readonly listed: ModelChoice[],
    private readonly done: (answers: InitAnswers | null) => void,
  ) {
    this.answers = {
      lang: DEFAULT_CONFIG.lang,
      // Empty, not pre-filled with the default. A pre-filled field looks like
      // an editable value but behaves like a prefix: typing "¥20" into "¥10.00"
      // produced "¥10.00¥20". The default belongs behind the cursor as a hint.
      budget: "",
      ladder: [],
      ignore: "",
    };
    this.rows = buildRows(listed, this.text);
    this.cursor = DEFAULT_CONFIG.lang === "zh" ? 0 : 1;
  }

  invalidate(): void {}

  private get text(): InitStrings {
    return INIT_TEXT[this.answers.lang];
  }

  private get current(): StepId {
    return STEPS[this.step]!;
  }

  // ---------------------------------------------------------------- input

  handleInput(data: string): void {
    if (data === "\u0003") return this.done(null); // ctrl+c abandons the whole thing

    if (matchesKey(data, Key.escape)) {
      if (this.step === 0) return this.done(null);
      this.back();
      return this.tui.requestRender();
    }

    switch (this.current) {
      case "lang":
      case "model":
        this.navigate(data, this.selectableCount());
        if (matchesKey(data, Key.enter)) this.commit();
        break;
      case "ladder":
        this.navigate(data, this.ladderOptions.length);
        if (data === " ") this.toggleLadder();
        else if (matchesKey(data, Key.enter)) this.commit();
        break;
      case "budget":
      case "ignore":
        if (matchesKey(data, Key.enter)) this.commit();
        else this.edit(data);
        break;
    }
    this.tui.requestRender();
  }

  private navigate(data: string, count: number): void {
    if (count === 0) return;
    const delta = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : 0;
    if (delta !== 0) this.cursor = (this.cursor + delta + count) % count;
  }

  /** Append printable input; drop escape sequences so arrow keys never land in the text. */
  private edit(data: string): void {
    const field = this.current === "budget" ? "budget" : "ignore";
    if (matchesKey(data, Key.backspace) || data === "\u007f" || data === "\b") {
      this.answers[field] = [...this.answers[field]].slice(0, -1).join("");
      return;
    }
    if (data.startsWith("\u001b") || data < " ") return;
    this.answers[field] += data;
  }

  private toggleLadder(): void {
    const ref = this.ladderOptions[this.cursor];
    if (!ref) return;
    const label = refLabel(ref);
    if (this.ladderPicked.has(label)) this.ladderPicked.delete(label);
    else this.ladderPicked.add(label);
    this.syncLadder();
  }

  /**
   * Keep the answer in step with the checkboxes.
   *
   * The selection used to be read only when the step was confirmed, so the
   * live preview showed a ladder of one while two rungs sat ticked above it. A
   * preview that lags the input is worse than none: it is a wrong answer to the
   * question "what am I about to write".
   */
  /** Whether the chosen model is reached through a plan rather than a price. */
  private onSubscription(): boolean {
    const chosen = this.answers.model && refLabel(this.answers.model);
    return this.candidates.some((c) => c.label === chosen && c.subscription);
  }

  private syncLadder(): void {
    this.answers.ladder = this.ladderOptions.filter((ref) => this.ladderPicked.has(refLabel(ref)));
  }

  // ------------------------------------------------------------- stepping

  private commit(): void {
    switch (this.current) {
      case "lang":
        this.answers.lang = this.cursor === 0 ? "zh" : "en";
        this.rows = buildRows(this.listed, this.text);
        break;
      case "model": {
        this.answers.model = this.selectableRows()[this.cursor]?.choice.ref;
        // The suggestion is a starting point the user can edit, not a decision:
        // pre-ticked because accepting it is the common case, listed because
        // "what happens when the money runs out" should not be a surprise.
        this.ladderOptions = this.answers.model
          ? suggestLadder(this.answers.model, this.candidates)
          : [];
        this.ladderPicked.clear();
        // Ticked by default only when money is what runs out. Under a plan the
        // limit counts tokens, and a cheaper model does not produce fewer of
        // them — so the rungs are offered, but pre-selecting them would promise
        // a saving the ladder cannot deliver.
        if (!this.onSubscription()) {
          for (const ref of this.ladderOptions) this.ladderPicked.add(refLabel(ref));
        }
        this.syncLadder();
        break;
      }
      case "ladder":
        break;
      case "ignore":
        return this.done(this.answers);
    }
    this.advance(1);
  }

  private back(): void {
    this.advance(-1);
  }

  /** Move to the next applicable step; steps with nothing to ask are not steps. */
  private advance(direction: 1 | -1): void {
    let next = this.step + direction;
    while (next > 0 && next < STEPS.length && !this.applicable(STEPS[next]!)) next += direction;
    this.step = Math.max(0, Math.min(STEPS.length - 1, next));
    this.cursor = this.initialCursor();
  }

  private applicable(step: StepId): boolean {
    if (step === "model") return this.listed.length > 0;
    if (step === "ladder") return this.ladderOptions.length > 0;
    return true;
  }

  private initialCursor(): number {
    if (this.current === "lang") return this.answers.lang === "zh" ? 0 : 1;
    if (this.current === "model") {
      const chosen = this.answers.model && refLabel(this.answers.model);
      const index = this.selectableRows().findIndex((row) => row.choice.label === chosen);
      return index >= 0 ? index : 0;
    }
    return 0;
  }

  private selectableRows(): { kind: "model"; choice: ModelChoice }[] {
    return this.rows.filter((row): row is { kind: "model"; choice: ModelChoice } => row.kind === "model");
  }

  private selectableCount(): number {
    return this.current === "lang" ? 2 : this.selectableRows().length;
  }

  // --------------------------------------------------------------- render

  render(width: number): string[] {
    const t = this.text;
    // A form is read, not scanned. The dashboard earns its full width by
    // showing three regions at once; stretching a single short question across
    // an ultrawide terminal just puts the answer and its label a hand's width
    // apart. Cap it at a comfortable measure and leave the rest of the screen
    // empty — the emptiness is not wasted, it is what makes the box a focus.
    const w = Math.min(Math.max(width - 2, 24), 76);
    const inner = w - 4;
    const body: string[] = [];

    for (const [index, id] of STEPS.entries()) {
      if (!this.applicable(id) && index !== this.step) continue;
      if (index < this.step) body.push(this.answeredRow(id));
      else if (index === this.step) body.push(...this.activeRows(id, inner));
      else body.push(`  ${theme.dim(GLYPH.pending)} ${theme.dim(t.steps[index] ?? "")}`);
    }

    const config = buildInitConfig(this.answers);
    const out = [
      "",
      `  ${theme.accent(GLYPH.brand)} ${theme.strong("code-review")}  ${theme.dim(t.title)}` +
        `${this.progressDots(w)}`,
      "",
      ...panel(body, w, { focused: true }),
      "",
      ...panel(previewBody(config, t.previewEmpty), w, { title: theme.dim(t.preview) }),
      "",
      `  ${this.hints()}`,
    ];
    return out.map((line) => clip(line, width));
  }

  /** Where you are in the form, right-aligned against the panel's edge. */
  private progressDots(w: number): string {
    const applicable = STEPS.filter((id, i) => this.applicable(id) || i === this.step);
    const here = applicable.indexOf(this.current);
    const dots = applicable
      .map((_, i) => (i < here ? theme.ok("●") : i === here ? theme.accent("●") : theme.dim("○")))
      .join(" ");
    const used = visibleWidth("  ⬢ code-review  ") + visibleWidth(this.text.title);
    const gap = Math.max(1, w - used - applicable.length * 2);
    return " ".repeat(gap) + dots;
  }

  private answeredRow(id: StepId): string {
    const t = this.text;
    const label = t.steps[STEPS.indexOf(id)] ?? "";
    return `  ${theme.ok(GLYPH.done)} ${theme.dim(padVisible(label, 10))}${theme.text(this.summary(id))}`;
  }

  private summary(id: StepId): string {
    const t = this.text;
    switch (id) {
      case "lang":
        return t.languageOptions[this.answers.lang === "zh" ? 0 : 1];
      case "budget":
        return this.answers.budget || theme.dim(BUDGET_DEFAULT);
      case "model":
        return this.answers.model ? refLabel(this.answers.model) : theme.dim("—");
      case "ladder":
        return this.answers.ladder.length > 0
          ? this.answers.ladder.map(refLabel).join(theme.dim(" → "))
          : theme.dim("—");
      case "ignore":
        return this.answers.ignore || theme.dim("—");
    }
  }

  private activeRows(id: StepId, inner: number): string[] {
    const t = this.text;
    const heading = `  ${theme.accent(GLYPH.active)} ${theme.strong(questionOf(id, t))}`;
    const rows = [heading, ""];

    switch (id) {
      case "lang":
        t.languageOptions.forEach((option, index) => {
          rows.push(radio(index === this.cursor, option, ""));
        });
        break;
      case "budget":
        rows.push(`      ${this.field(this.answers.budget, BUDGET_DEFAULT)}`);
        rows.push("", `      ${theme.dim(this.budgetProblem() ?? t.budgetHint)}`);
        break;
      case "model":
        rows.push(...this.modelRows(inner));
        break;
      case "ladder":
        this.ladderOptions.forEach((ref, index) => {
          const on = this.ladderPicked.has(refLabel(ref));
          const box = on ? theme.ok("[✓]") : theme.dim("[ ]");
          const arrow = theme.dim(`${index + 1}.`);
          rows.push(
            `   ${index === this.cursor ? theme.accent("›") : " "} ${box} ${arrow} ${on ? theme.text(refLabel(ref)) : theme.dim(refLabel(ref))}`,
          );
        });
        if (this.onSubscription()) rows.push("", `      ${theme.dim(t.ladderSubscription)}`);
        break;
      case "ignore":
        rows.push(`      ${this.field(this.answers.ignore, "")}`);
        rows.push("", `      ${theme.dim(t.ignoreHint)}`);
        break;
    }
    rows.push("");
    return rows;
  }

  /**
   * The model list, windowed so a long catalogue cannot push the preview off
   * screen, with the group heading pinned to the top of the window.
   *
   * Scrolling treats a heading like any other row, which meant two rows of
   * movement left "✦" in a column with nothing to say what it meant. A heading
   * is not content you scroll past — it is the thing that makes the rows under
   * it readable — so whichever group the top row belongs to is always named.
   */
  private modelRows(inner: number): string[] {
    const selectable = this.selectableRows();
    const cursorRow = this.rows.indexOf(selectable[this.cursor]!);
    const { start, end } = windowAround(this.rows.length, Math.max(0, cursorRow), 11);
    const out: string[] = [];

    if (this.rows[start]?.kind !== "header") {
      const heading = this.rows.slice(0, start).findLast((row) => row.kind === "header");
      if (heading?.kind === "header") out.push(`      ${theme.dim(heading.label)}`);
    }

    for (let i = start; i < end; i++) {
      const row = this.rows[i]!;
      if (row.kind === "header") {
        if (i > start) out.push("");
        out.push(`      ${theme.dim(row.label)}`);
        continue;
      }
      const index = selectable.indexOf(row);
      const price = row.choice.subscription
        ? theme.ok("✦")
        : theme.dim(`$${row.choice.inputCost} / $${row.choice.outputCost}`);
      out.push(radio(index === this.cursor, row.choice.label, price, inner));
    }
    if (end < this.rows.length) out.push(`      ${theme.dim("…")}`);
    return out;
  }

  /** The cursor sits before the placeholder, so it is obvious nothing is typed yet. */
  private field(value: string, placeholder: string): string {
    if (value) return `${theme.text(value)}${theme.accent("▏")}`;
    return `${theme.accent("▏")}${theme.dim(placeholder)}`;
  }

  /** Said out loud rather than silently dropped from the preview. */
  private budgetProblem(): string | undefined {
    const typed = this.answers.budget.trim();
    if (!typed) return undefined;
    try {
      parseBudgetLimit(typed);
      return undefined;
    } catch {
      return theme.warn(this.text.budgetBad);
    }
  }

  private hints(): string {
    const k = this.text.keys;
    const pairs: [string, string][] = [];
    if (this.current === "budget" || this.current === "ignore") {
      pairs.push(["⏎", k.accept]);
    } else {
      pairs.push(["↑↓", k.move]);
      if (this.current === "ladder") pairs.push(["space", k.toggle]);
      pairs.push(["⏎", k.accept]);
    }
    pairs.push(["esc", this.step === 0 ? k.cancel : k.back]);
    return keyHints(pairs);
  }
}

function questionOf(id: StepId, t: InitStrings): string {
  switch (id) {
    case "lang":
      return t.language;
    case "budget":
      return t.budget;
    case "model":
      return t.model;
    case "ladder":
      return t.ladder;
    case "ignore":
      return t.ignore;
  }
}

function radio(selected: boolean, label: string, trailing: string, inner = 0): string {
  const mark = selected ? theme.accent("›") : " ";
  const dot = selected ? theme.accent("●") : theme.dim("○");
  const name = selected ? theme.text(label) : theme.dim(label);
  if (!trailing) return `   ${mark} ${dot} ${name}`;
  const gap = Math.max(2, inner - 8 - visibleWidth(label) - visibleWidth(trailing));
  return `   ${mark} ${dot} ${name}${" ".repeat(gap)}${trailing}`;
}

/** Model rows split by how they are billed — the two are not comparable numbers. */
function buildRows(listed: ModelChoice[], t: InitStrings): ModelRow[] {
  const rows: ModelRow[] = [];
  const subscription = listed.filter((c) => c.subscription);
  const metered = listed.filter((c) => !c.subscription);

  if (subscription.length > 0) {
    rows.push({ kind: "header", label: t.modelSubscription });
    for (const choice of subscription) rows.push({ kind: "model", choice });
  }
  if (metered.length > 0) {
    rows.push({ kind: "header", label: t.modelMetered });
    for (const choice of metered) rows.push({ kind: "model", choice });
  }
  return rows;
}

function previewBody(config: ConfigOverrides, emptyNote: string): string[] {
  if (Object.keys(config).length === 0) return [`  ${theme.dim(emptyNote)}`];
  return JSON.stringify(config, null, 2)
    .split("\n")
    .map((line) => `  ${theme.dim(line)}`);
}

function refLabel(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`;
}

function visible(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, "").length;
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visible(text)));
}

/**
 * Run the wizard full-screen, resolving with the answers or null if abandoned.
 *
 * The caller owns writing the file: a wizard that also performed the side
 * effect would have to know about paths and overwrite rules, and could not be
 * driven by a test.
 */
export async function runInitWizard(
  candidates: ModelChoice[],
  listed: ModelChoice[],
): Promise<InitAnswers | null> {
  const tui = new TuiAltScreen(new ProcessTerminal());
  tui.start();

  const answers = await new Promise<InitAnswers | null>((resolve) => {
    const wizard = new InitWizard(tui, candidates, listed, resolve);
    tui.addChild(wizard);
    tui.setFocus(wizard);
    tui.requestRender();
  });

  tui.stop({ preserveScreen: true });
  return answers;
}
