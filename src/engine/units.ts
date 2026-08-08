import type { DiffFile, DiffHunk, Redacted, ReviewUnit, SkipReason } from "../types.js";
import { renderHunks } from "../platform/diff.js";

export interface UnitPlan {
  units: ReviewUnit[];
  skipped: { id: string; path: string; reason: SkipReason }[];
}

/**
 * Files whose diffs cost tokens and yield nothing. Reviewing a lockfile is a
 * pure loss: it is machine-written, enormous, and no comment on it is actionable.
 */
const SKIP_PATTERNS: { pattern: RegExp; reason: SkipReason }[] = [
  { pattern: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/, reason: "generated" },
  { pattern: /\.min\.(js|css)$/, reason: "generated" },
  { pattern: /(^|\/)(dist|build|vendor|node_modules|__snapshots__)\//, reason: "generated" },
  { pattern: /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|woff2?|ttf|eot|mp4|mov|wasm|so|dylib|dll|exe|class|jar)$/i, reason: "binary" },
  { pattern: /\.(pb\.go|generated\.ts|g\.dart)$/, reason: "generated" },
  { pattern: /(^|\/)(go\.mod)$/, reason: "generated" },
];

/**
 * Split a PR into review units.
 *
 * One unit per file is the default: it is the granularity a reviewer thinks in,
 * it bounds each agent's context, and it makes the checkpoint meaningful —
 * losing a unit loses one file's worth of work. Very large files are split
 * further so a single monster file cannot blow the context window.
 */
export function planUnits(files: DiffFile[], maxUnitDiffLines: number): UnitPlan {
  const units: ReviewUnit[] = [];
  const skipped: UnitPlan["skipped"] = [];

  for (const file of files) {
    const skipReason = classifySkip(file);
    if (skipReason) {
      skipped.push({ id: file.path, path: file.path, reason: skipReason });
      continue;
    }

    const groups = groupHunks(file.hunks, maxUnitDiffLines);
    groups.forEach((hunks, index) => {
      const id = groups.length === 1 ? file.path : `${file.path}#${index + 1}`;
      units.push({
        id,
        path: file.path,
        change: file.change,
        hunks,
        additions: countLines(hunks, "add"),
        deletions: countLines(hunks, "del"),
        // Already redacted upstream: hunks come from a redacted diff.
        patch: renderHunks(hunks) as Redacted,
      });
    });
  }

  return { units, skipped };
}

function classifySkip(file: DiffFile): SkipReason | null {
  if (file.binary) return "binary";
  if (file.hunks.length === 0) return "empty";
  for (const { pattern, reason } of SKIP_PATTERNS) {
    if (pattern.test(file.path)) return reason;
  }
  // A deletion has nothing left to review; its risk shows up in the files that
  // used to reference it, which the cross-file pass covers.
  if (file.change === "deleted") return "empty";
  return null;
}

/**
 * Pack hunks into groups under the line cap.
 *
 * Hunks are kept whole — splitting one would hand the model a fragment whose
 * line numbers no longer line up with anything it can cite.
 */
function groupHunks(hunks: DiffHunk[], maxLines: number): DiffHunk[][] {
  const groups: DiffHunk[][] = [];
  let current: DiffHunk[] = [];
  let currentLines = 0;

  for (const hunk of hunks) {
    const size = hunk.lines.length;
    if (current.length > 0 && currentLines + size > maxLines) {
      groups.push(current);
      current = [];
      currentLines = 0;
    }
    current.push(hunk);
    currentLines += size;
  }
  if (current.length > 0) groups.push(current);
  return groups.length > 0 ? groups : [[]];
}

function countLines(hunks: DiffHunk[], kind: "add" | "del"): number {
  let total = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) if (line.kind === kind) total++;
  }
  return total;
}

/** Rough token estimate for the pre-flight budget warning. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}
