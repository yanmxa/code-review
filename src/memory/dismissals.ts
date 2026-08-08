import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { MarkerComment } from "../platform/adapter.js";
import type { Target } from "../types.js";

export type DismissalReason = "deleted" | "resolved";

export interface PostedRecord {
  pr: number;
  at: string;
}

export interface DismissalRecord extends PostedRecord {
  how: DismissalReason;
}

export interface ReviewMemory {
  version: 1;
  /** Fingerprints this tool has posted, and where. */
  posted: Record<string, PostedRecord>;
  /** Fingerprints a maintainer has since rejected. Never raised again. */
  dismissed: Record<string, DismissalRecord>;
}

/**
 * What a repository's maintainers have already said no to.
 *
 * Scoped to the repository rather than the run: a run directory is keyed by
 * head SHA, so anything remembered there would evaporate the moment someone
 * pushes a commit — which is exactly when the tool would repeat itself.
 *
 * The point is not to save API calls. A reviewer that raises the same rejected
 * comment on every push teaches the team to ignore it, and a review tool that
 * gets ignored has failed regardless of how good its findings are.
 */
export class DismissalStore {
  private memory: ReviewMemory;

  constructor(readonly path: string) {
    this.memory = load(path);
  }

  static forTarget(target: Target, root = defaultMemoryDir()): DismissalStore {
    const key = `${target.platform}--${target.owner}--${target.repo}`.replace(/[^A-Za-z0-9._-]/g, "_");
    return new DismissalStore(join(root, `${key}.json`));
  }

  /** Fingerprints that must not be raised again. */
  dismissed(): Set<string> {
    return new Set(Object.keys(this.memory.dismissed));
  }

  reasonFor(fingerprint: string): DismissalRecord | undefined {
    return this.memory.dismissed[fingerprint];
  }

  posted(): Set<string> {
    return new Set(Object.keys(this.memory.posted));
  }

  recordPosted(fingerprints: string[], pr: number): void {
    const at = new Date().toISOString();
    for (const fingerprint of fingerprints) {
      this.memory.posted[fingerprint] = { pr, at };
    }
    this.save();
  }

  /**
   * Compare what we posted against what the host still shows, and treat the
   * difference as rejection.
   *
   * A comment that was deleted, or whose thread was resolved, is a maintainer
   * saying no. Those are the only two signals that are unambiguous; a reply
   * arguing with the finding is a conversation, not a verdict, and is left alone.
   */
  reconcile(present: MarkerComment[], pr: number): DismissalRecord[] {
    const stillThere = new Map<string, MarkerComment>();
    for (const comment of present) {
      if (comment.fingerprint) stillThere.set(comment.fingerprint, comment);
    }

    const newly: DismissalRecord[] = [];
    const at = new Date().toISOString();

    for (const [fingerprint, record] of Object.entries(this.memory.posted)) {
      if (this.memory.dismissed[fingerprint]) continue;
      const comment = stillThere.get(fingerprint);

      const how: DismissalReason | undefined = !comment
        ? "deleted"
        : comment.resolved
          ? "resolved"
          : undefined;
      if (!how) continue;

      const entry: DismissalRecord = { pr: record.pr || pr, at, how };
      this.memory.dismissed[fingerprint] = entry;
      newly.push(entry);
    }

    if (newly.length > 0) this.save();
    return newly;
  }

  /** Undo a dismissal, for when it was recorded in error. */
  forget(fingerprint: string): boolean {
    if (!this.memory.dismissed[fingerprint]) return false;
    delete this.memory.dismissed[fingerprint];
    this.save();
    return true;
  }

  clear(): void {
    this.memory = emptyMemory();
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.memory, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}

function emptyMemory(): ReviewMemory {
  return { version: 1, posted: {}, dismissed: {} };
}

function load(path: string): ReviewMemory {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ReviewMemory;
    if (parsed.version !== 1) return emptyMemory();
    return { version: 1, posted: parsed.posted ?? {}, dismissed: parsed.dismissed ?? {} };
  } catch {
    return emptyMemory();
  }
}

export function defaultMemoryDir(): string {
  return join(homedir(), ".code-review", "memory");
}
