import { type Component, Key, matchesKey, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { Language } from "../config.js";
import { certaintyLabel, confidenceLabel, severityLabel } from "../i18n/messages.js";
import type { Confidence, DiffFile, Evidence, Finding } from "../types.js";
import { type BudgetUnit, formatBudget } from "../budget/limit.js";
import { excerptAround } from "../platform/diff.js";
import { budgetGauge, confidenceGlyph, GLYPH, severityStyle, theme } from "./theme.js";
import { clip, columns, keyHints, pad, panel, spread, windowAround, wrap } from "./widgets.js";

type Row =
  | { kind: "header"; label: string; tier: Confidence; legend?: string }
  | { kind: "finding"; finding: Finding };

/**
 * How sure the model says it is, shown only where the question is open.
 *
 * An adoptable finding is backed by something anyone can re-derive, so the
 * model's opinion of it adds nothing and "拿不准" beside a compiler diagnostic
 * would be doubt about a fact. Inside the reference group it is the only thing
 * separating claims that otherwise look identical.
 */
function certaintyNote(finding: Finding, lang: Language): string {
  if (finding.confidence !== "reference") return "";
  // Every row in the group carries one. Marking only the doubtful ones left the
  // reader unable to tell "the model was sure" from "the model said nothing",
  // which is the difference the mark exists to report.
  const certainty = finding.certainty ?? "unsure";
  const paint = certainty === "certain" ? theme.text : certainty === "likely" ? theme.dim : theme.warn;
  return theme.dim(" · ") + paint(certaintyLabel(certainty, lang));
}

/** A named divider, so no block of text is left for the reader to classify. */
function section(title: string, width: number): string[] {
  const rule = "─".repeat(Math.max(0, width - visibleWidth(title) - 3));
  return ["", theme.dim(`${title} ${rule}`)];
}

function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export interface TriageActions {
  onPost(selected: Finding[]): Promise<void>;
  onTrace(finding: Finding): void;
  onQuit(): void;
}

/**
 * The findings browser.
 *
 * Sorted into two groups because that is the decision the reader has to make —
 * *what can I take as-is* versus *what should I think about* — and every row
 * carries a checkbox because the useful next action is posting a subset, not
 * all or nothing.
 */
export class TriagePanel implements Component {
  private rows: Row[] = [];
  private cursor = 0;
  private readonly selected = new Set<string>();
  private status?: string;
  private detailOffset = 0;

  constructor(
    private readonly tui: TUI,
    private findings: Finding[],
    private lang: Language,
    private readonly spent: number,
    private readonly limit: number,
    private readonly unit: BudgetUnit,
    /** The PR's parsed diff, so a finding can show the lines it is about. */
    private readonly files: DiffFile[],
    private readonly actions: TriageActions,
  ) {
    this.rebuild();
    // Pre-select what the tool is confident about: the common action is
    // "post the adoptable ones", and making that one keypress is the point.
    for (const finding of findings) {
      if (finding.confidence === "adoptable") this.selected.add(finding.fingerprint);
    }
    this.moveTo(this.firstFindingIndex());
  }

  setLanguage(lang: Language): void {
    this.lang = lang;
    this.rebuild();
    this.tui.requestRender();
  }

  get selectedFindings(): Finding[] {
    return this.findings.filter((finding) => this.selected.has(finding.fingerprint));
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const current = this.rows[this.cursor];

    if (matchesKey(data, Key.up) || data === "k") this.move(-1);
    else if (matchesKey(data, Key.down) || data === "j") this.move(1);
    // The detail pane is taller than most findings and shorter than some. Its
    // own keys, because the arrows belong to the list — losing the cursor to
    // read an evidence line would be a bad trade.
    else if (matchesKey(data, Key.pageUp) || data === "K") this.detailOffset = Math.max(0, this.detailOffset - 5);
    else if (matchesKey(data, Key.pageDown) || data === "J") this.detailOffset += 5;
    else if (data === " ") this.toggleCurrent();
    else if (data === "a") this.selectTier("adoptable");
    else if (data === "A") this.selectAll();
    else if (data === "n") this.selected.clear();
    else if (data === "t" && current?.kind === "finding") this.actions.onTrace(current.finding);
    else if (matchesKey(data, Key.enter) && current?.kind === "finding") this.actions.onTrace(current.finding);
    else if (data === "p") void this.post();
    else if (data === "q" || matchesKey(data, Key.escape)) this.actions.onQuit();
    else return;

    this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = Math.max(8, (this.tui.terminal.rows ?? 24) - 6);
    const listWidth = Math.max(30, Math.min(56, Math.floor(width * 0.42)));
    const detailWidth = width - listWidth;

    const list = panel(this.renderList(listWidth - 4, height - 2), listWidth, {
      title: this.lang === "zh" ? "发现" : "Findings",
      badge: theme.dim(`${this.selected.size}/${this.findings.length}`),
      focused: true,
      height: height - 2,
    });
    const detail = panel(this.renderDetail(detailWidth - 4, height - 2), detailWidth, {
      title: this.lang === "zh" ? "详情" : "Detail",
      height: height - 2,
    });

    return [
      ...this.renderHeader(width),
      ...columns(list, detail, listWidth, detailWidth),
      ...this.renderFooter(width),
    ].map((line) => clip(line, width));
  }

  private renderHeader(width: number): string[] {
    const adoptable = this.findings.filter((f) => f.confidence === "adoptable").length;
    const left =
      `${theme.accent(GLYPH.brand)} ${theme.strong(this.lang === "zh" ? "评审结果" : "Review findings")}` +
      theme.dim(` · ${this.findings.length} total`) +
      `  ${confidenceGlyph("adoptable")} ${theme.ok(String(adoptable))}` +
      `  ${confidenceGlyph("reference")} ${theme.warn(String(this.findings.length - adoptable))}`;
    const right =
      `${budgetGauge(this.limit > 0 ? this.spent / this.limit : 0)} ` +
      theme.dim(`${formatBudget(this.spent, this.unit)}/${formatBudget(this.limit, this.unit)}`);
    return [spread(left, right, width), ""];
  }

  private renderList(width: number, height: number): string[] {
    const { start, end } = windowAround(this.rows.length, this.cursor, height);
    const out: string[] = [];

    for (let i = start; i < end; i++) {
      const row = this.rows[i];
      if (!row) continue;

      if (row.kind === "header") {
        const paint = row.tier === "adoptable" ? theme.ok.bold : theme.warn.bold;
        const legend =
          row.legend && visibleWidth(row.label) + visibleWidth(row.legend) + 2 <= width
            ? `  ${row.legend}`
            : "";
        out.push(paint(clip(row.label, width)) + legend);
        continue;
      }

      const finding = row.finding;
      const isCursor = i === this.cursor;
      const checkbox = this.selected.has(finding.fingerprint) ? theme.ok("[x]") : theme.dim("[ ]");
      const location = `${finding.path.split("/").pop()}:${finding.line}`;
      const head = `${checkbox} ${confidenceGlyph(finding.confidence, finding.certainty)} ${severityStyle(finding.severity)(location)} `;
      const label = head + clip(finding.title, Math.max(4, width - 1 - visibleWidth(head)));

      out.push(
        isCursor
          ? theme.accent("▌") + pad(clip(label, width - 1), width - 1)
          : ` ${clip(label, width - 1)}`,
      );
    }
    return out;
  }

  /**
   * One finding, in the order the questions get asked.
   *
   * *What is it* (title), *where and how much should I trust it* (a labelled
   * facts block), then *why* — the reviewer's own words, the code they are
   * about, the fix, and what backs the claim. Every section is named: an
   * unlabelled paragraph of prose between two code blocks made the reader work
   * out for themselves which part was the argument and which was the evidence.
   * The trace sits alone at the foot, below a rule, because it leaves this
   * screen rather than continuing it.
   */
  private renderDetail(width: number, height: number): string[] {
    const row = this.rows[this.cursor];
    if (!row || row.kind !== "finding") {
      return [theme.dim(this.lang === "zh" ? "选择一条发现查看详情。" : "Select a finding to see its detail.")];
    }
    const finding = row.finding;
    const zh = this.lang === "zh";
    const out: string[] = [];

    out.push(theme.strong(clip(finding.title, width)));
    out.push("");

    const label = (text: string) => theme.dim(padEnd(text, zh ? 8 : 12));
    out.push(label(zh ? "文件" : "File") + theme.accent(clip(`${finding.path}:${finding.line}`, width - 12)));
    out.push(label(zh ? "严重级" : "Severity") + severityStyle(finding.severity)(severityLabel(finding.severity, this.lang)));
    out.push(
      label(zh ? "置信度" : "Confidence") +
        confidenceGlyph(finding.confidence, finding.certainty) +
        ` ${confidenceLabel(finding.confidence, this.lang)}` +
        certaintyNote(finding, this.lang),
    );

    out.push(...section(zh ? "说明" : "What is wrong", width));
    out.push(...wrap(finding.body, width - 2).map((line) => `  ${theme.text(line)}`));

    // The code being talked about, before anything is proposed for it. A
    // suggested replacement with nothing to compare against asks the reader to
    // leave and go find the file, which is most of the work of reviewing.
    const excerpt = this.excerptFor(finding);
    if (excerpt.length > 0) {
      out.push(...section(zh ? "改动" : "In the diff", width));
      for (const entry of excerpt) {
        const marker = entry.kind === "add" ? "+" : entry.kind === "del" ? "-" : " ";
        const number = entry.line === undefined ? "    " : String(entry.line).padStart(4);
        const paint = entry.kind === "add" ? theme.ok : entry.kind === "del" ? theme.danger : theme.dim;
        const body = `${number} ${marker}${entry.text}`;
        out.push(
          entry.anchored
            ? theme.accent("▸") + paint(clip(body, width - 1))
            : ` ${paint(clip(body, width - 1))}`,
        );
      }
    }

    if (finding.suggestion) {
      out.push(...section(zh ? "建议改法" : "Suggested change", width));
      for (const line of finding.suggestion.split("\n")) {
        out.push(theme.ok(`  ${clip(line, width - 2)}`));
      }
    }

    out.push(...section(zh ? "证据" : "Evidence", width));
    for (const evidence of finding.evidence) {
      const glyph = evidence.kind === "llm" ? theme.warn("○") : theme.ok("●");
      for (const [index, line] of wrap(describeEvidence(evidence, this.lang), width - 4).entries()) {
        out.push(index === 0 ? `  ${glyph} ${line}` : `    ${theme.dim(line)}`);
      }
    }

    const room = Math.max(1, height - 2);
    // Clamped against the content, not the keypress: only rendering knows how
    // much room is left, and pinning the trace to the foot had been quietly
    // eating whatever did not fit above it — evidence sections vanished with
    // nothing to say they existed.
    this.detailOffset = Math.min(this.detailOffset, Math.max(0, out.length - room));
    const body = out.slice(this.detailOffset, this.detailOffset + room);
    const more = out.length > room ? theme.dim(`  ${this.detailOffset + room}/${out.length}  `) : "";
    const footer = [
      theme.dim("─".repeat(Math.max(0, width - visibleWidth(more)))) + more,
      `${theme.accent("t")} ${theme.dim(zh ? "查看完整 trace" : "open full trace")}   ` +
        theme.dim(clip(finding.tracePath, Math.max(0, width - 20))),
    ];
    const gap = Math.max(0, room - body.length);
    return [...body, ...Array<string>(gap).fill(""), ...footer];
  }

  private renderFooter(width: number): string[] {
    const hints = keyHints([
      ["↑↓", this.lang === "zh" ? "移动" : "move"],
      ["space", this.lang === "zh" ? "选中" : "toggle"],
      ["a", this.lang === "zh" ? "全选可采纳" : "all adoptable"],
      ["J/K", this.lang === "zh" ? "翻详情" : "scroll"],
      ["t", "trace"],
      ["p", this.lang === "zh" ? "回评" : "post"],
      ["q", this.lang === "zh" ? "退出" : "quit"],
    ]);
    return ["", spread(this.status ? theme.ok(this.status) : "", hints, width)];
  }

  private async post(): Promise<void> {
    const selected = this.selectedFindings;
    if (selected.length === 0) {
      this.status = this.lang === "zh" ? "没有选中任何发现。" : "Nothing selected.";
      this.tui.requestRender();
      return;
    }
    this.status = this.lang === "zh" ? `正在回评 ${selected.length} 条…` : `Posting ${selected.length}…`;
    this.tui.requestRender();
    try {
      await this.actions.onPost(selected);
      this.status = this.lang === "zh" ? `已回评 ${selected.length} 条。` : `Posted ${selected.length}.`;
    } catch (error) {
      this.status = theme.danger(`${(error as Error).message}`);
    }
    this.tui.requestRender();
  }

  /** The changed lines this finding anchors to, or nothing if the diff has moved on. */
  private excerptFor(finding: Finding) {
    const file = this.files.find((entry) => entry.path === finding.path);
    if (!file) return [];
    return excerptAround(file.hunks, finding.line, finding.endLine).slice(0, 14);
  }

  private rebuild(): void {
    const adoptable = this.findings.filter((f) => f.confidence === "adoptable");
    const reference = this.findings.filter((f) => f.confidence === "reference");
    this.rows = [];

    if (adoptable.length > 0) {
      this.rows.push({
        kind: "header",
        tier: "adoptable",
        label: `${GLYPH.adoptable} ${this.lang === "zh" ? "可直接采纳" : "ADOPTABLE"} (${adoptable.length})`,
      });
      for (const finding of adoptable) this.rows.push({ kind: "finding", finding });
    }
    if (reference.length > 0) {
      if (adoptable.length > 0) this.rows.push({ kind: "header", tier: "reference", label: "" });
      this.rows.push({
        kind: "header",
        tier: "reference",
        label:
          `${GLYPH.reference} ${this.lang === "zh" ? "仅供参考" : "REFERENCE"} (${reference.length})`,
        // Explains the three marks below it, and is dropped whole rather than
        // clipped: half a legend is worse than none.
        legend: theme.dim(
          `${GLYPH.sure}${certaintyLabel("certain", this.lang)} ${GLYPH.likely}${certaintyLabel("likely", this.lang)} ${GLYPH.reference}${certaintyLabel("unsure", this.lang)}`,
        ),
      });
      for (const finding of reference) this.rows.push({ kind: "finding", finding });
    }
  }

  /** Move the cursor, skipping group headers in the direction of travel. */
  private move(delta: number): void {
    this.detailOffset = 0;
    let next = this.cursor;
    for (let step = 0; step < this.rows.length; step++) {
      next += delta;
      if (next < 0 || next >= this.rows.length) return;
      if (this.rows[next]?.kind === "finding") {
        this.cursor = next;
        return;
      }
    }
  }

  private moveTo(index: number): void {
    if (index >= 0 && index < this.rows.length) this.cursor = index;
  }

  private firstFindingIndex(): number {
    return Math.max(0, this.rows.findIndex((row) => row.kind === "finding"));
  }

  private toggleCurrent(): void {
    const row = this.rows[this.cursor];
    if (row?.kind !== "finding") return;
    const key = row.finding.fingerprint;
    if (this.selected.has(key)) this.selected.delete(key);
    else this.selected.add(key);
  }

  private selectTier(tier: Confidence): void {
    for (const finding of this.findings) {
      if (finding.confidence === tier) this.selected.add(finding.fingerprint);
    }
  }

  private selectAll(): void {
    for (const finding of this.findings) this.selected.add(finding.fingerprint);
  }
}

export function describeEvidence(evidence: Evidence, lang: Language): string {
  switch (evidence.kind) {
    case "rule":
      return lang === "zh"
        ? `规则 ${evidence.ruleId} 命中 ${evidence.path}:${evidence.line} — ${evidence.excerpt}`
        : `rule ${evidence.ruleId} matched ${evidence.path}:${evidence.line} — ${evidence.excerpt}`;
    case "static":
      return lang === "zh"
        ? `${evidence.toolId} 在 ${evidence.path}:${evidence.line} 报告：${evidence.diagnostic}`
        : `${evidence.toolId} reported at ${evidence.path}:${evidence.line}: ${evidence.diagnostic}`;
    case "llm":
      return lang === "zh" ? `模型推断：${evidence.reasoning}` : `model reasoning: ${evidence.reasoning}`;
  }
}
