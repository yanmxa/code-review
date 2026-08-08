import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Finding, PrSnapshot, RunState, SpendLedger, Target, UnitState } from "../types.js";
import { emptyLedger } from "../budget/budget.js";

export interface RunDirs {
  root: string;
  state: string;
  snapshot: string;
  findings: string;
  report: string;
  posted: string;
}

/**
 * Durable run state.
 *
 * The ordering rule is the whole design: findings are appended before the state
 * that acknowledges them. A crash in the gap re-runs one unit (costing a few
 * cents) and can never lose a finding that was already paid for.
 */
export class RunStore {
  readonly dirs: RunDirs;

  private constructor(
    readonly runId: string,
    root: string,
    private state: RunState,
  ) {
    this.dirs = {
      root,
      state: join(root, "state.json"),
      snapshot: join(root, "pr.json"),
      findings: join(root, "findings.jsonl"),
      report: join(root, "report.md"),
      posted: join(root, "posted.json"),
    };
  }

  /**
   * Open the run for this PR at this head SHA, resuming if one exists.
   *
   * The run id is derived from the target and head SHA, so re-running the same
   * command resumes by construction — the user never has to pass a run id.
   */
  static open(options: {
    runDir: string;
    target: Target;
    headSha: string;
    diffHash: string;
    fresh?: boolean;
  }): { store: RunStore; resumed: boolean; staleReason?: string } {
    const runId = computeRunId(options.target, options.headSha);
    const root = join(options.runDir, runId);

    if (options.fresh && existsSync(root)) rmSync(root, { recursive: true, force: true });

    if (existsSync(join(root, "state.json"))) {
      const existing = readJson<RunState>(join(root, "state.json"));
      if (existing && existing.version === 1) {
        if (existing.diffHash !== options.diffHash) {
          return {
            store: RunStore.create(runId, root, options),
            resumed: false,
            staleReason:
              "The PR diff changed since the last run; starting fresh (previous checkpoint discarded).",
          };
        }
        const store = new RunStore(runId, root, existing);
        store.recoverInterrupted();
        return { store, resumed: true };
      }
    }

    return { store: RunStore.create(runId, root, options), resumed: false };
  }

  private static create(
    runId: string,
    root: string,
    options: { target: Target; headSha: string; diffHash: string },
  ): RunStore {
    mkdirSync(root, { recursive: true });
    // A stale findings file from a discarded run must not bleed into this one.
    rmSync(join(root, "findings.jsonl"), { force: true });
    const now = new Date().toISOString();
    const state: RunState = {
      version: 1,
      runId,
      prUrl: options.target.webUrl,
      platform: options.target.platform,
      headSha: options.headSha,
      diffHash: options.diffHash,
      startedAt: now,
      updatedAt: now,
      spend: emptyLedger(),
      ladderStage: 0,
      squeezed: false,
      hardStopped: false,
      units: [],
      crossFileDone: false,
      finished: false,
    };
    const store = new RunStore(runId, root, state);
    store.persist();
    return store;
  }

  get current(): RunState {
    return this.state;
  }

  /** Seed the unit list on first run; a resumed run keeps its existing statuses. */
  initUnits(units: { id: string; path: string }[]): void {
    if (this.state.units.length > 0) return;
    this.state.units = units.map<UnitState>((unit) => ({
      id: unit.id,
      path: unit.path,
      status: "pending",
      findings: 0,
      spendUsd: 0,
      attempts: 0,
    }));
    this.persist();
  }

  unit(unitId: string): UnitState | undefined {
    return this.state.units.find((u) => u.id === unitId);
  }

  pendingUnits(): UnitState[] {
    return this.state.units.filter((u) => u.status === "pending");
  }

  markUnit(unitId: string, patch: Partial<UnitState>): void {
    const unit = this.unit(unitId);
    if (!unit) return;
    Object.assign(unit, patch);
    this.persist();
  }

  /**
   * Record a finished unit. Findings hit the disk first, then the state that
   * marks the unit done — never the other way round.
   */
  completeUnit(unitId: string, findings: Finding[], patch: Partial<UnitState>): void {
    if (findings.length > 0) this.appendFindings(findings);
    this.markUnit(unitId, { ...patch, findings: findings.length });
  }

  appendFindings(findings: Finding[]): void {
    const lines = findings.map((finding) => JSON.stringify(finding)).join("\n");
    appendFileSync(this.dirs.findings, `${lines}\n`, "utf8");
  }

  readFindings(): Finding[] {
    let raw: string;
    try {
      raw = readFileSync(this.dirs.findings, "utf8");
    } catch {
      return [];
    }
    const out: Finding[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Finding);
      } catch {
        // Torn last line from a hard kill.
      }
    }
    return out;
  }

  saveSnapshot(snapshot: PrSnapshot): void {
    writeAtomic(this.dirs.snapshot, JSON.stringify(snapshot));
  }

  readSnapshot(): PrSnapshot | null {
    return readJson<PrSnapshot>(this.dirs.snapshot);
  }

  updateSpend(
    spend: SpendLedger,
    ladderStage: number,
    squeezed: boolean,
    hardStopped: boolean,
    budget?: RunState["budget"],
  ): void {
    this.state.spend = spend;
    if (budget) this.state.budget = budget;
    this.state.ladderStage = ladderStage;
    this.state.squeezed = squeezed;
    this.state.hardStopped = hardStopped;
    this.persist();
  }

  /** Record the run-level note, once, when the run starts. */
  setPrompt(prompt: string | undefined): void {
    if (!prompt || this.state.prompt === prompt) return;
    this.state.prompt = prompt;
    this.persist();
  }

  markCrossFileDone(): void {
    this.state.crossFileDone = true;
    this.persist();
  }

  finish(): void {
    this.state.finished = true;
    this.persist();
  }

  writeReport(markdown: string): string {
    writeAtomic(this.dirs.report, markdown);
    return this.dirs.report;
  }

  readPosted(): string[] {
    return readJson<string[]>(this.dirs.posted) ?? [];
  }

  addPosted(fingerprints: string[]): void {
    const merged = new Set([...this.readPosted(), ...fingerprints]);
    writeAtomic(this.dirs.posted, JSON.stringify([...merged]));
  }

  /**
   * A unit left `in_progress` means the process died mid-unit. Reset it to
   * pending so it re-runs; its spend stays on the ledger because the tokens were
   * genuinely consumed and pretending otherwise would make the budget a lie.
   */
  private recoverInterrupted(): void {
    let changed = false;
    for (const unit of this.state.units) {
      if (unit.status === "in_progress") {
        unit.status = "pending";
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    this.state.updatedAt = new Date().toISOString();
    writeAtomic(this.dirs.state, JSON.stringify(this.state, null, 2));
  }
}

/** Same PR at the same head resolves to the same run — that is what makes resume automatic. */
export function computeRunId(target: Target, headSha: string): string {
  return createHash("sha256")
    .update(`${target.platform}:${target.owner}/${target.repo}:${target.number}:${headSha}`)
    .digest("hex")
    .slice(0, 12);
}

export function hashDiff(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}

/** Write via a temp file + rename so a crash can never leave a half-written state.json. */
function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export interface RunSummary {
  runId: string;
  prUrl: string;
  updatedAt: string;
  finished: boolean;
  units: number;
  done: number;
  findings: number;
  spendUsd: number;
}

/** Enumerate checkpointed runs, newest first — backs `code-review runs`. */
export function listRuns(runDir: string): RunSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(runDir);
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const entry of entries) {
    const statePath = join(runDir, entry, "state.json");
    if (!existsSync(statePath)) continue;
    const state = readJson<RunState>(statePath);
    if (!state) continue;
    out.push({
      runId: state.runId,
      prUrl: state.prUrl,
      updatedAt: state.updatedAt,
      finished: state.finished,
      units: state.units.length,
      done: state.units.filter((u) => u.status === "done").length,
      findings: state.units.reduce((sum, u) => sum + u.findings, 0),
      spendUsd: state.spend.usd,
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Resolve a full or abbreviated run id to its directory. */
export function findRunDir(runDir: string, runIdPrefix: string): string | null {
  try {
    const matches = readdirSync(runDir).filter(
      (entry) => entry.startsWith(runIdPrefix) && statSync(join(runDir, entry)).isDirectory(),
    );
    return matches.length === 1 ? join(runDir, matches[0] as string) : null;
  } catch {
    return null;
  }
}
