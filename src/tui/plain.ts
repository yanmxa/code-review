import type { Language } from "../config.js";
import { confidenceLabel, severityLabel, skipLabel } from "../i18n/messages.js";
import type { RunEvent } from "../types.js";
import { budgetGauge, formatCny, GLYPH, theme } from "./theme.js";

export interface PlainOptions {
  lang: Language;
  totalCny: number;
  /** Print streaming model output. Off by default: it is noise in a log. */
  verbose?: boolean;
  write?: (line: string) => void;
}

/**
 * Line-oriented renderer for pipes, CI, and `--no-tui`.
 *
 * It consumes exactly the same event stream as the dashboard, so the two can
 * never drift: there is one source of truth about what happened, and two ways
 * of drawing it.
 */
export function createPlainRenderer(options: PlainOptions): (event: RunEvent) => void {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const { lang } = options;

  let total = 0;
  let index = 0;

  return (event: RunEvent) => {
    switch (event.type) {
      case "run_start": {
        total = event.units.length;
        const meta = event.snapshot.meta;
        write(
          `${theme.accent(GLYPH.brand)} ${theme.strong(event.snapshot.target.owner + "/" + event.snapshot.target.repo)} ` +
            `#${event.snapshot.target.number} — ${meta.title}`,
        );
        write(
          theme.dim(
            `  ${meta.sourceBranch} → ${meta.targetBranch} · ${total} unit(s) · ` +
              `${theme.model(`${event.model.provider}/${event.model.id}`)}` +
              (event.resumed ? theme.warn("  [resumed from checkpoint]") : ""),
          ),
        );
        break;
      }

      case "unit_start":
        index++;
        write(`${theme.accent(GLYPH.active)} [${index}/${total}] ${event.unitId}`);
        break;

      case "unit_end": {
        if (event.status === "skipped") {
          const reason = event.skipReason ? skipLabel(event.skipReason, lang) : "";
          write(`${theme.dim(GLYPH.skipped)} ${theme.dim(`${event.unitId} — ${reason}`)}`);
        } else if (event.status === "failed") {
          write(`${theme.danger(GLYPH.failed)} ${event.unitId} ${theme.danger("failed")}`);
        } else {
          write(
            `${theme.ok(GLYPH.done)} ${event.unitId} ${theme.dim(`— ${event.findings} finding(s)`)}`,
          );
        }
        break;
      }

      case "tool_start":
        if (options.verbose) write(theme.dim(`    ${GLYPH.tool} ${event.name} ${event.summary}`));
        break;

      case "stream_delta":
        if (options.verbose) process.stdout.write(theme.dim(event.text));
        break;

      case "finding":
        write(
          `    ${event.finding.confidence === "adoptable" ? theme.ok(GLYPH.adoptable) : theme.warn(GLYPH.reference)} ` +
            `${severityLabel(event.finding.severity, lang)} ` +
            `${theme.dim(`${event.finding.path}:${event.finding.line}`)} ${event.finding.title} ` +
            theme.dim(`[${confidenceLabel(event.finding.confidence, lang)}]`),
        );
        break;

      case "spend":
        write(
          theme.dim(
            `    ${budgetGauge(event.fraction)} ${event.notional ? "≈" : ""}${formatCny(event.ledger.cny)}/${formatCny(options.totalCny)} · ` +
              `${event.ledger.calls} call(s) · ${theme.model(`${event.model.provider}/${event.model.id}`)}`,
          ),
        );
        break;

      case "budget":
        write(`${theme.warn("¥")} ${theme.warn(event.kind)} — ${event.detail}`);
        break;

      case "notice":
        write(
          event.level === "error"
            ? theme.danger(`! ${event.text}`)
            : event.level === "warn"
              ? theme.warn(`! ${event.text}`)
              : theme.dim(`  ${event.text}`),
        );
        break;

      case "run_end": {
        const adoptable = event.findings.filter((f) => f.confidence === "adoptable").length;
        write("");
        write(
          `${theme.strong("Done.")} ${event.findings.length} finding(s) — ` +
            `${theme.ok(`${adoptable} adoptable`)}, ${theme.warn(`${event.findings.length - adoptable} reference`)} · ` +
            `${formatCny(event.state.spend.cny)}`,
        );
        if (event.reportPath) write(theme.dim(`Report: ${event.reportPath}`));
        break;
      }
    }
  };
}
