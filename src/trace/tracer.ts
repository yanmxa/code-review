import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "../security/redactor.js";
import type { TraceEvent, TraceEventPayload } from "../types.js";

/**
 * Append-only per-unit trace.
 *
 * One file per review unit means a finding's provenance is a single readable
 * file rather than a slice of a global log, and it survives a crash mid-run
 * because every event is flushed as it happens.
 *
 * Everything written passes through the redactor a second time. The inputs were
 * already redacted upstream; this is belt-and-braces for anything a model may
 * have echoed back, and it costs nothing on text that has no secrets.
 */
export class Tracer {
  private seq = 0;

  private constructor(
    private readonly file: string,
    private readonly redactor: Redactor,
    /** Path relative to the run directory, recorded on each finding. */
    readonly relativePath: string,
  ) {}

  static forUnit(runDir: string, unitId: string, redactor: Redactor): Tracer {
    const dir = join(runDir, "traces");
    mkdirSync(dir, { recursive: true });
    const name = `${sanitizeUnitId(unitId)}.jsonl`;
    return new Tracer(join(dir, name), redactor, join("traces", name));
  }

  write(event: TraceEventPayload): void {
    const full: TraceEvent = { ts: new Date().toISOString(), seq: this.seq++, ...event };
    const line = this.redactor.redact(JSON.stringify(full));
    appendFileSync(this.file, `${line}\n`, "utf8");
  }

  static read(runDir: string, relativePath: string): TraceEvent[] {
    let raw: string;
    try {
      raw = readFileSync(join(runDir, relativePath), "utf8");
    } catch {
      return [];
    }
    const events: TraceEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TraceEvent);
      } catch {
        // A torn final line is expected after a hard kill; keep what parsed.
      }
    }
    return events;
  }
}

/** Unit ids contain slashes (they are paths); trace filenames must not. */
export function sanitizeUnitId(unitId: string): string {
  return unitId.replace(/[^A-Za-z0-9._#-]/g, "_");
}
