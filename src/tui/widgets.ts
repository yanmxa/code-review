import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "./theme.js";

/**
 * Layout primitives.
 *
 * pi-tui's `Box` handles padding and background but not borders, and the
 * dashboard's readability comes almost entirely from framing: panels give the
 * eye somewhere to rest and make the three regions legible at a glance.
 *
 * The hard contract from pi-tui is that a rendered line must never exceed the
 * width it was given — anything wider corrupts the differential renderer. Every
 * helper here enforces that with `visibleWidth`, which is ANSI-aware.
 */

const BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

export interface PanelOptions {
  title?: string;
  /** Right-aligned text on the title row, e.g. a count or a gauge. */
  badge?: string;
  focused?: boolean;
  /** Pad the body to exactly this many rows. */
  height?: number;
}

/** Draw a rounded panel around `body`, clipped to `width`. */
export function panel(body: string[], width: number, options: PanelOptions = {}): string[] {
  if (width < 4) return body.map((line) => clip(line, Math.max(0, width)));

  const inner = width - 2;
  const border = options.focused ? theme.accent : theme.dim;
  const out: string[] = [];

  out.push(border(BORDER.topLeft + titleRow(options, inner) + BORDER.topRight));

  const rows = options.height !== undefined ? options.height : body.length;
  for (let i = 0; i < rows; i++) {
    const line = body[i] ?? "";
    out.push(border(BORDER.vertical) + pad(clip(line, inner), inner) + border(BORDER.vertical));
  }

  out.push(border(BORDER.bottomLeft + BORDER.horizontal.repeat(inner) + BORDER.bottomRight));
  return out;
}

function titleRow(options: PanelOptions, inner: number): string {
  const border = options.focused ? theme.accent : theme.dim;
  if (!options.title && !options.badge) return BORDER.horizontal.repeat(inner);

  const title = options.title ? ` ${options.title} ` : "";
  const badge = options.badge ? ` ${options.badge} ` : "";
  const titleWidth = visibleWidth(title);
  const badgeWidth = visibleWidth(badge);
  const fill = inner - titleWidth - badgeWidth - 2;

  if (fill < 0) {
    return BORDER.horizontal + clip(title, Math.max(0, inner - 2)) + BORDER.horizontal;
  }
  return (
    BORDER.horizontal +
    (options.focused ? theme.accent.bold(title) : theme.strong(title)) +
    border(BORDER.horizontal.repeat(fill)) +
    badge +
    BORDER.horizontal
  );
}

/** Truncate to a visible width, ANSI sequences accounted for. */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  return visibleWidth(text) <= width ? text : truncateToWidth(text, width);
}

/** Right-pad to a visible width. */
export function pad(text: string, width: number): string {
  const current = visibleWidth(text);
  return current >= width ? text : text + " ".repeat(width - current);
}

/** Left-pad to a visible width. */
export function padStart(text: string, width: number): string {
  const current = visibleWidth(text);
  return current >= width ? text : " ".repeat(width - current) + text;
}

/**
 * Place `left` and `right` on one line with `right` flush to the edge.
 * The left side yields first when space runs out.
 */
export function spread(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return clip(right, width);
  const leftClipped = clip(left, width - rightWidth - 1);
  return pad(leftClipped, width - rightWidth) + right;
}

/** Split two panels side by side, honouring each one's own width. */
export function columns(left: string[], right: string[], leftWidth: number, rightWidth: number): string[] {
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    out.push(pad(clip(left[i] ?? "", leftWidth), leftWidth) + pad(clip(right[i] ?? "", rightWidth), rightWidth));
  }
  return out;
}

/**
 * Window a list around the selected row.
 *
 * Keeps the cursor off the edges when possible so the user can see where they
 * are heading, which matters more in a fixed-height pane than raw scrolling.
 */
export function windowAround(total: number, selected: number, height: number): { start: number; end: number } {
  if (total <= height) return { start: 0, end: total };
  const margin = Math.min(2, Math.floor(height / 3));
  let start = selected - margin;
  start = Math.max(0, Math.min(start, total - height));
  return { start, end: start + height };
}

/** `3/12` style progress, plus a compact bar. */
export function progressBar(done: number, total: number, width: number): string {
  if (total === 0) return "";
  const filled = Math.round((done / total) * width);
  return theme.ok("━".repeat(filled)) + theme.dim("━".repeat(Math.max(0, width - filled)));
}

/**
 * Word-wrap plain text (no ANSI) to a width.
 *
 * Width is measured in terminal columns, not characters — a CJK glyph occupies
 * two columns. The hard-split path below must therefore advance by the
 * characters actually consumed, not by the column count, or Chinese text loses
 * and duplicates glyphs at every wrap point.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      // A word wider than the line gets hard-split rather than overflowing.
      // CJK prose is one such "word": it carries no spaces to break on.
      if (visibleWidth(word) > width) {
        if (line) out.push(line);
        let rest = word;
        while (visibleWidth(rest) > width) {
          const piece = takeColumns(rest, width);
          out.push(piece);
          rest = rest.slice(piece.length);
        }
        line = rest;
        continue;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (visibleWidth(candidate) > width) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Longest prefix of `text` that fits in `columns` terminal columns. */
export function takeColumns(text: string, columns: number): string {
  let taken = "";
  let used = 0;
  // Iterate by code point so surrogate pairs and CJK glyphs stay intact.
  for (const char of text) {
    const w = visibleWidth(char);
    if (used + w > columns) break;
    taken += char;
    used += w;
  }
  // A single glyph wider than the whole line would otherwise loop forever.
  return taken.length > 0 ? taken : [...text][0] ?? "";
}

/** A key-hint footer: `↑↓ move · enter open · q quit`. */
export function keyHints(hints: [string, string][]): string {
  return hints.map(([key, label]) => `${theme.accent(key)} ${theme.dim(label)}`).join(theme.dim(" · "));
}
