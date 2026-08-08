import chalk, { type ChalkInstance } from "chalk";
import type { Confidence, Severity, UnitStatus } from "../types.js";

/**
 * One restrained palette, used by every surface.
 *
 * Structure is dim, one accent (cyan) marks what the app is, and colour is
 * otherwise reserved for meaning: green for settled and adoptable, yellow for
 * provisional, red for trouble. A terminal that colours everything communicates
 * nothing.
 */
export interface Theme {
  accent: ChalkInstance;
  dim: ChalkInstance;
  text: ChalkInstance;
  strong: ChalkInstance;
  ok: ChalkInstance;
  warn: ChalkInstance;
  danger: ChalkInstance;
  model: ChalkInstance;
}

export const theme: Theme = {
  accent: chalk.cyan,
  dim: chalk.dim,
  text: chalk.white,
  strong: chalk.bold,
  ok: chalk.green,
  warn: chalk.yellow,
  danger: chalk.red,
  model: chalk.magenta,
};

export const GLYPH = {
  adoptable: "●",
  reference: "○",
  done: "✓",
  active: "▸",
  pending: "◌",
  skipped: "⊘",
  failed: "✗",
  tool: "→",
  gaugeFull: "▰",
  gaugeEmpty: "▱",
  brand: "⬢",
} as const;

export function statusGlyph(status: UnitStatus): string {
  switch (status) {
    case "done":
      return theme.ok(GLYPH.done);
    case "in_progress":
      return theme.accent(GLYPH.active);
    case "skipped":
      return theme.dim(GLYPH.skipped);
    case "failed":
      return theme.danger(GLYPH.failed);
    default:
      return theme.dim(GLYPH.pending);
  }
}

export function confidenceGlyph(confidence: Confidence): string {
  return confidence === "adoptable" ? theme.ok(GLYPH.adoptable) : theme.warn(GLYPH.reference);
}

export function severityStyle(severity: Severity): ChalkInstance {
  switch (severity) {
    case "blocker":
      return theme.danger;
    case "major":
      return theme.warn;
    default:
      return theme.dim;
  }
}

/**
 * The budget gauge.
 *
 * Colour tracks the downgrade ladder rather than an arbitrary scale, so the bar
 * turning yellow is the same event as the model getting cheaper.
 */
export function budgetGauge(fraction: number, width = 10): string {
  const filled = Math.min(width, Math.round(fraction * width));
  const colour = fraction >= 0.85 ? theme.danger : fraction >= 0.5 ? theme.warn : theme.ok;
  return colour(GLYPH.gaugeFull.repeat(filled)) + theme.dim(GLYPH.gaugeEmpty.repeat(width - filled));
}

export function formatCny(value: number): string {
  return `¥${value.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
