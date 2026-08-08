import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Language } from "../config.js";
import { skipLabel } from "../i18n/messages.js";
import type {
  Finding,
  ModelRef,
  PrSnapshot,
  ReviewUnit,
  RunEvent,
  SkipReason,
  SpendLedger,
  UnitStatus,
} from "../types.js";
import {
  budgetGauge,
  confidenceGlyph,
  formatCny,
  formatDuration,
  formatTokens,
  GLYPH,
  statusGlyph,
  theme,
} from "./theme.js";
import { clip, columns, keyHints, pad, panel, progressBar, spread, windowAround, wrap } from "./widgets.js";

interface UnitRow {
  id: string;
  status: UnitStatus;
  findings: number;
  skipReason?: SkipReason;
}

/**
 * The live run view.
 *
 * Three regions, each answering one question a waiting user actually has:
 * the header says *what is this and what has it cost*, the left column says
 * *how far along*, and the right column says *what is it doing right now*.
 * Nothing else earns space.
 */
export class Dashboard implements Component {
  private snapshot?: PrSnapshot;
  private readonly units = new Map<string, UnitRow>();
  private order: string[] = [];
  private activeUnit?: string;
  private model?: ModelRef;
  private spend?: SpendLedger;
  private fraction = 0;
  private notional = false;
  private resumed = false;
  private readonly findings: Finding[] = [];
  private readonly activity: string[] = [];
  private streamTail = "";
  private notice?: { level: string; text: string };
  private readonly startedAt = Date.now();
  private spinnerFrame = 0;
  private finished = false;

  private static readonly SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  constructor(
    private readonly tui: TUI,
    private readonly lang: Language,
    private readonly totalCny: number,
  ) {}

  /** Drives the spinner and the elapsed clock; stopped when the run ends. */
  tick(): void {
    if (this.finished) return;
    this.spinnerFrame = (this.spinnerFrame + 1) % Dashboard.SPINNER.length;
    this.tui.requestRender();
  }

  handle(event: RunEvent): void {
    switch (event.type) {
      case "run_start":
        this.snapshot = event.snapshot;
        this.model = event.model;
        this.resumed = event.resumed;
        for (const unit of event.units as ReviewUnit[]) {
          if (!this.units.has(unit.id)) {
            this.units.set(unit.id, { id: unit.id, status: "pending", findings: 0 });
            this.order.push(unit.id);
          }
        }
        break;

      case "unit_start":
        this.activeUnit = event.unitId;
        this.setUnit(event.unitId, { status: "in_progress" });
        this.streamTail = "";
        this.pushActivity(theme.accent(`${GLYPH.active} ${event.unitId}`));
        break;

      case "unit_end":
        if (!this.units.has(event.unitId)) {
          this.units.set(event.unitId, { id: event.unitId, status: event.status, findings: 0 });
          this.order.push(event.unitId);
        }
        this.setUnit(event.unitId, {
          status: event.status,
          findings: event.findings,
          skipReason: event.skipReason,
        });
        if (this.activeUnit === event.unitId) this.activeUnit = undefined;
        break;

      case "tool_start":
        this.pushActivity(`  ${theme.dim(GLYPH.tool)} ${theme.text(event.name)} ${theme.dim(clip(event.summary, 40))}`);
        break;

      case "tool_end":
        if (event.isError) {
          this.pushActivity(`    ${theme.danger("!")} ${theme.dim(clip(event.summary, 50))}`);
        } else if (event.summary) {
          this.pushActivity(`    ${theme.dim(clip(event.summary, 54))}`);
        }
        break;

      case "stream_delta":
        this.streamTail = `${this.streamTail}${event.text}`.slice(-600);
        break;

      case "finding":
        this.findings.push(event.finding);
        break;

      case "spend":
        this.spend = event.ledger;
        this.fraction = event.fraction;
        this.model = event.model;
        this.notional = event.notional;
        break;

      case "budget":
        this.pushActivity(`  ${theme.warn("¥")} ${theme.warn(event.kind)} ${theme.dim(clip(event.detail, 46))}`);
        break;

      case "notice":
        this.notice = { level: event.level, text: event.text };
        break;

      case "run_end":
        this.finished = true;
        this.activeUnit = undefined;
        break;
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    // All state is recomputed on every render; nothing is cached.
  }

  render(width: number): string[] {
    const out: string[] = [];
    out.push(...this.renderHeader(width));

    // The two columns get whatever the header and footer leave. A fixed split
    // keeps the unit list readable without letting it crowd out the activity
    // pane on a narrow terminal.
    const bodyHeight = Math.max(6, (this.tui.terminal.rows ?? 24) - 10);
    const leftWidth = Math.max(24, Math.min(46, Math.floor(width * 0.42)));
    const rightWidth = width - leftWidth;

    const left = panel(this.renderUnits(leftWidth - 4, bodyHeight - 2), leftWidth, {
      title: this.lang === "zh" ? "文件" : "Files",
      badge: this.progressBadge(),
      height: bodyHeight - 2,
    });
    const right = panel(this.renderActivity(rightWidth - 4, bodyHeight - 2), rightWidth, {
      title: this.lang === "zh" ? "进行中" : "Activity",
      height: bodyHeight - 2,
    });

    out.push(...columns(left, right, leftWidth, rightWidth));
    out.push(...this.renderFooter(width));
    return out.map((line) => clip(line, width));
  }

  private renderHeader(width: number): string[] {
    const meta = this.snapshot?.meta;
    const target = this.snapshot?.target;

    const title = target
      ? `${theme.accent(GLYPH.brand)} ${theme.strong(`${target.owner}/${target.repo}`)} ${theme.accent(`#${target.number}`)} ${theme.text(clip(meta?.title ?? "", Math.max(10, width - 40)))}`
      : `${theme.accent(GLYPH.brand)} ${theme.strong("code-review")} ${theme.dim("starting…")}`;

    const branch = meta
      ? theme.dim(`${meta.sourceBranch} → ${meta.targetBranch}`) +
        theme.dim(` · ${this.snapshot?.files.length ?? 0} files`) +
        (this.resumed ? theme.warn("  ↻ resumed") : "")
      : "";

    const gauge = this.spend
      ? `${budgetGauge(this.fraction)} ${theme.strong(`${this.notional ? "≈" : ""}${formatCny(this.spend.cny)}`)}${theme.dim(`/${formatCny(this.totalCny)}`)}` +
        theme.dim(
          ` · ↑${formatTokens(this.spend.inputTokens)} ↓${formatTokens(this.spend.outputTokens)}` +
            (this.spend.cacheReadTokens > 0 ? ` ⛁${formatTokens(this.spend.cacheReadTokens)}` : ""),
        )
      : `${budgetGauge(0)} ${theme.dim(`${formatCny(0)}/${formatCny(this.totalCny)}`)}`;

    const modelBadge = this.model ? theme.model(`${this.model.provider}/${this.model.id}`) : "";

    return [title, spread(branch, modelBadge, width), spread(gauge, "", width), ""];
  }

  private renderUnits(width: number, height: number): string[] {
    const rows = this.order.map((id) => this.units.get(id) as UnitRow);
    const activeIndex = Math.max(0, rows.findIndex((row) => row.status === "in_progress"));
    const { start, end } = windowAround(rows.length, activeIndex, height);

    const out: string[] = [];
    for (const row of rows.slice(start, end)) {
      const glyph =
        row.status === "in_progress" ? theme.accent(Dashboard.SPINNER[this.spinnerFrame] as string) : statusGlyph(row.status);

      const suffix =
        row.status === "skipped" && row.skipReason
          ? theme.dim(skipLabel(row.skipReason, this.lang))
          : row.findings > 0
            ? theme.ok(`${row.findings}`)
            : row.status === "done"
              ? theme.dim("—")
              : "";

      const name = row.status === "pending" ? theme.dim(row.id) : theme.text(row.id);
      out.push(`${glyph} ${spread(name, suffix, width - 2)}`);
    }

    if (end < rows.length) out.push(theme.dim(`  … ${rows.length - end} more`));
    return out;
  }

  private renderActivity(width: number, height: number): string[] {
    const out: string[] = [];

    if (this.notice) {
      const style =
        this.notice.level === "error" ? theme.danger : this.notice.level === "warn" ? theme.warn : theme.dim;
      out.push(style(clip(this.notice.text, width)));
      out.push("");
    }

    // Recent tool activity, then whatever the model is currently saying. The
    // stream is the least important of the two, so it gets the leftover rows.
    const streamRows = Math.min(6, Math.max(0, height - out.length - 4));
    const activityRows = Math.max(0, height - out.length - streamRows - 1);
    out.push(...this.activity.slice(-activityRows).map((line) => clip(line, width)));

    if (this.streamTail && streamRows > 0) {
      out.push(theme.dim("─".repeat(Math.min(width, 20))));
      const text = this.streamTail.replace(/\s+/g, " ").trim();
      // Wrapped on word boundaries: mid-word breaks make streaming output read
      // as garbled rather than as a thought in progress.
      out.push(...wrap(text, width).slice(-streamRows).map((line) => theme.dim(line)));
    }

    return out;
  }

  private renderFooter(width: number): string[] {
    const done = [...this.units.values()].filter(
      (unit) => unit.status === "done" || unit.status === "skipped" || unit.status === "failed",
    ).length;
    const total = this.units.size;
    const adoptable = this.findings.filter((f) => f.confidence === "adoptable").length;

    const left =
      `${progressBar(done, total, 12)} ${theme.dim(`${done}/${total}`)}` +
      theme.dim(` · ${formatDuration(Date.now() - this.startedAt)}`) +
      (this.findings.length > 0
        ? `  ${confidenceGlyph("adoptable")}${theme.ok(String(adoptable))} ${confidenceGlyph("reference")}${theme.warn(String(this.findings.length - adoptable))}`
        : "");

    const right = this.finished
      ? keyHints([["enter", this.lang === "zh" ? "查看结果" : "review findings"]])
      : keyHints([["ctrl+c", this.lang === "zh" ? "存档并退出" : "checkpoint & quit"]]);

    return ["", spread(left, right, width)];
  }

  private progressBadge(): string {
    const done = [...this.units.values()].filter((unit) => unit.status !== "pending" && unit.status !== "in_progress").length;
    return theme.dim(`${done}/${this.units.size}`);
  }

  private setUnit(id: string, patch: Partial<UnitRow>): void {
    const existing = this.units.get(id);
    if (existing) Object.assign(existing, patch);
  }

  private pushActivity(line: string): void {
    this.activity.push(line);
    if (this.activity.length > 200) this.activity.splice(0, this.activity.length - 200);
  }
}

export { pad };
