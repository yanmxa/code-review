import { type Component, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { Language } from "../config.js";
import type { TraceEvent } from "../types.js";
import { formatTokens, GLYPH, theme } from "./theme.js";
import { clip, keyHints, pad, spread, windowAround, wrap } from "./widgets.js";

/**
 * The trace viewer.
 *
 * This is where "every comment links to a trace" stops being a claim and
 * becomes something a reviewer can act on: a timeline of exactly what the agent
 * saw and said, with the full prompt one keypress away. Rows collapse by
 * default because the point is to scan the shape of a run first and only then
 * dive into one request.
 */
export class TraceView implements Component {
  private cursor = 0;
  private readonly expanded = new Set<number>();

  constructor(
    private readonly tui: TUI,
    private readonly events: TraceEvent[],
    private readonly title: string,
    private readonly lang: Language,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || data === "k") this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, Key.down) || data === "j")
      this.cursor = Math.min(this.events.length - 1, this.cursor + 1);
    else if (matchesKey(data, Key.enter) || data === " ") this.toggle();
    else if (data === "q" || matchesKey(data, Key.escape)) this.onClose();
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const inner = width - 2;
    const height = Math.max(8, Math.floor((this.tui.terminal.rows ?? 24) * 0.8) - 4);
    const out: string[] = [];

    out.push(theme.accent(`╭─ ${theme.strong(clip(this.title, inner - 4))} ${"─".repeat(Math.max(0, inner - clip(this.title, inner - 4).length - 3))}╮`));

    const lines: string[] = [];
    const { start, end } = windowAround(this.events.length, this.cursor, height);
    for (let i = start; i < end; i++) {
      const event = this.events[i];
      if (!event) continue;
      const isCursor = i === this.cursor;
      const marker = isCursor ? theme.accent("▌") : " ";
      lines.push(marker + clip(this.summarize(event), inner - 1));

      if (this.expanded.has(i)) {
        for (const line of this.detail(event, inner - 4)) {
          lines.push(`   ${theme.dim(clip(line, inner - 3))}`);
        }
      }
    }

    for (const line of lines.slice(0, height)) {
      out.push(theme.accent("│") + pad(clip(line, inner), inner) + theme.accent("│"));
    }

    const hints = keyHints([
      ["↑↓", this.lang === "zh" ? "移动" : "move"],
      ["enter", this.lang === "zh" ? "展开" : "expand"],
      ["esc", this.lang === "zh" ? "关闭" : "close"],
    ]);
    out.push(theme.accent("│") + pad(spread("", hints, inner), inner) + theme.accent("│"));
    out.push(theme.accent(`╰${"─".repeat(inner)}╯`));
    return out;
  }

  /** One line per event: what happened, and what it cost. */
  private summarize(event: TraceEvent): string {
    const time = theme.dim(event.ts.slice(11, 19));
    switch (event.type) {
      case "unit_start":
        return `${time} ${theme.accent("▸ unit")} ${event.unitId} ${theme.model(event.model)}`;
      case "llm_request":
        return `${time} ${theme.accent("↑ llm")} ${theme.dim(`${event.messages.length} msg · ${event.toolNames.length} tools`)} ${theme.model(event.model)}`;
      case "llm_response":
        return (
          `${time} ${theme.ok("↓ llm")} ${theme.dim(event.stopReason)} ` +
          theme.dim(
            `↑${formatTokens(event.usage.input)} ↓${formatTokens(event.usage.output)} $${event.usage.costUsd.toFixed(4)}`,
          ) +
          (event.errorMessage ? ` ${theme.danger(clip(event.errorMessage, 40))}` : "")
        );
      case "tool_call":
        return `${time} ${theme.accent(GLYPH.tool)} ${theme.text(event.name)} ${theme.dim(clip(JSON.stringify(event.params), 46))}`;
      case "tool_result":
        return `${time}   ${event.isError ? theme.danger("!") : theme.dim("·")} ${theme.dim(clip(firstLine(event.preview), 56))}`;
      case "rule_hit":
        return `${time} ${theme.ok("✦ rule")} ${event.ruleId} ${theme.dim(`${event.path}:${event.line}`)}`;
      case "redaction":
        return `${time} ${theme.warn("⊘ redacted")} ${event.ruleId} ${theme.dim(`×${event.count}`)}`;
      case "budget":
        return `${time} ${theme.warn("¥ " + event.kind)} ${theme.dim(event.detail)}`;
      case "resumed":
        return `${time} ${theme.warn("↻ resumed")} ${theme.dim(event.note)}`;
      case "unit_end":
        return `${time} ${theme.accent("■ end")} ${theme.dim(`${event.findingIds.length} finding(s) · $${event.spendUsd.toFixed(4)} · ${event.status}`)}`;
    }
  }

  /** The full payload, for the row the user asked about. */
  private detail(event: TraceEvent, width: number): string[] {
    switch (event.type) {
      case "llm_request":
        return [
          "── system prompt ──",
          ...wrap(event.systemPrompt, width).slice(0, 40),
          "── messages ──",
          ...wrap(JSON.stringify(event.messages, null, 1), width).slice(0, 80),
        ];
      case "llm_response":
        return wrap(JSON.stringify(event.content, null, 1), width).slice(0, 60);
      case "tool_call":
        return wrap(JSON.stringify(event.params, null, 1), width).slice(0, 30);
      case "tool_result":
        return wrap(event.preview, width).slice(0, 30);
      default:
        return wrap(JSON.stringify(event, null, 1), width).slice(0, 20);
    }
  }

  private toggle(): void {
    if (this.expanded.has(this.cursor)) this.expanded.delete(this.cursor);
    else this.expanded.add(this.cursor);
  }
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}
