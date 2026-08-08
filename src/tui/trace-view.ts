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
  private detailOffset = 0;

  constructor(
    private readonly tui: TUI,
    private readonly events: TraceEvent[],
    private readonly title: string,
    private readonly lang: Language,
    private readonly onClose: () => void,
  ) {}

  invalidate(): void {}

  /**
   * Arrows move between events, or through one when it is open.
   *
   * An expanded payload used to be cut at whatever fit and there was no way to
   * reach the rest — a diff and a model's full reply both run well past a
   * screen, so the trace held the evidence and would not show it. Opening a row
   * hands the arrows to its contents; closing it hands them back.
   */
  handleInput(data: string): void {
    const inside = this.expanded.has(this.cursor);
    const up = matchesKey(data, Key.up) || data === "k";
    const down = matchesKey(data, Key.down) || data === "j";

    if (up) {
      if (inside && this.detailOffset > 0) this.detailOffset--;
      else if (!inside) this.cursor = Math.max(0, this.cursor - 1);
    } else if (down) {
      if (inside) this.detailOffset++;
      else this.cursor = Math.min(this.events.length - 1, this.cursor + 1);
    } else if (matchesKey(data, Key.enter) || data === " ") this.toggle();
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
    // An open row is given the rest of the box: its payload is what the reader
    // came for, and centring the cursor would spend half the space on events
    // above it that are one line each.
    const { start, end } = this.expanded.has(this.cursor)
      ? { start: this.cursor, end: this.events.length }
      : windowAround(this.events.length, this.cursor, height);
    for (let i = start; i < end; i++) {
      const event = this.events[i];
      if (!event) continue;
      const isCursor = i === this.cursor;
      const marker = isCursor ? theme.accent("▌") : " ";
      lines.push(marker + clip(summarizeEvent(event), inner - 1));

      if (this.expanded.has(i)) {
        const body = this.detail(event, inner - 4);
        // Clamp here rather than on the keypress: only rendering knows how many
        // rows are left, and scrolling past the end would show an empty box.
        const room = Math.max(1, height - (i - start) - 2);
        this.detailOffset = Math.min(this.detailOffset, Math.max(0, body.length - room));
        for (const line of body.slice(this.detailOffset, this.detailOffset + room)) {
          lines.push(`   ${theme.dim(clip(line, inner - 3))}`);
        }
        if (body.length > room) {
          lines.push(theme.dim(`   ── ${this.detailOffset + room}/${body.length} ──`));
        }
      }
    }

    for (const line of lines.slice(0, height)) {
      out.push(theme.accent("│") + pad(clip(line, inner), inner) + theme.accent("│"));
    }

    const open = this.expanded.has(this.cursor);
    const hints = keyHints([
      ["↑↓", open ? (this.lang === "zh" ? "滚动" : "scroll") : this.lang === "zh" ? "移动" : "move"],
      ["enter", open ? (this.lang === "zh" ? "收起" : "collapse") : this.lang === "zh" ? "展开" : "expand"],
      ["esc", this.lang === "zh" ? "关闭" : "close"],
    ]);
    out.push(theme.accent("│") + pad(spread("", hints, inner), inner) + theme.accent("│"));
    out.push(theme.accent(`╰${"─".repeat(inner)}╯`));
    return out;
  }


  /**
   * The full payload, for the row the user asked about.
   *
   * Messages lead. The system prompt is 38 lines and identical for every file
   * in the run, so putting it first pushed the diff — the whole reason anyone
   * opens a trace — past the bottom of the overlay, and it read as though no
   * user message had been sent at all. It is still here, below, because "what
   * exactly was this model asked" has to be answerable; it is just no longer
   * the thing standing in front of the answer.
   */
  private detail(event: TraceEvent, width: number): string[] {
    switch (event.type) {
      case "llm_request":
        return [
          theme.dim(`── messages (${event.messages.length}) ──`),
          ...event.messages.flatMap((message) => [
            theme.accent(`  ${roleOf(message)}:`),
            ...wrap(textOf(message), width).slice(0, 200),
          ]),
          "",
          theme.dim("── system prompt ──"),
          ...wrap(event.systemPrompt, width).slice(0, 60),
        ];
      case "llm_response":
        return wrap(textOf({ content: event.content }), width).slice(0, 80);
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
    this.detailOffset = 0;
  }
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}

function roleOf(message: unknown): string {
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : "message";
}

/**
 * A message's text as text.
 *
 * `JSON.stringify` on a content array turns a unified diff into one line with
 * literal `\n` between every row of it — technically the whole payload, and
 * unreadable, which for an audit trail is close to not having it. Anything that
 * is not a text part still falls back to JSON so nothing is silently hidden.
 */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? message, null, 1);

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : JSON.stringify(part, null, 1);
    })
    .join("\n");
}

/**
 * One line per event: what happened, and what it cost.
 *
 * Shared with `code-review trace`, which used to print every event as pretty
 * JSON — 639 lines for one file, 318 of them a single request's prompt. The
 * observability escape hatch has to be readable to be one, so both surfaces
 * draw the same timeline and the raw form stays behind `--json`.
 */
export function summarizeEvent(event: TraceEvent): string {
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
