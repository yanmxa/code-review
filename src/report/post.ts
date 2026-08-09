import type { RunStore } from "../checkpoint/store.js";
import type { DismissalStore } from "../memory/dismissals.js";
import type { Language } from "../config.js";
import { commentableLines, snapToCommentable } from "../platform/diff.js";
import {
  findingMarker,
  type InlineComment,
  type PlatformAdapter,
  SUMMARY_MARKER,
} from "../platform/adapter.js";
import type { Finding, PrSnapshot } from "../types.js";
import { renderComment, renderPostSummary, type ReportInput } from "./markdown.js";

export interface PostOptions {
  adapter: PlatformAdapter;
  snapshot: PrSnapshot;
  store: RunStore;
  findings: Finding[];
  report: ReportInput;
  lang: Language;
  /** Repository-scoped memory of what has been posted and what was rejected. */
  memory?: DismissalStore;
  /** Skip the network call and report what would happen. */
  dryRun?: boolean;
}

export interface PostSummary {
  posted: number;
  skippedAsDuplicate: number;
  unanchorable: number;
  /** Findings withheld because a maintainer had already rejected them. */
  skippedAsDismissed: number;
  /** Newly detected rejections, learned from this run's reconciliation. */
  newlyDismissed: number;
  url?: string;
}

/**
 * Post findings back to the pull request.
 *
 * Two properties matter more than the mechanics. It is **idempotent**: every
 * comment carries a fingerprint marker, and anything already on the PR is
 * skipped, so a re-run after a crash does not spam the author. And it is
 * **anchor-safe**: a comment whose line is not part of the diff would make the
 * whole review request fail, so those are filtered out here and folded into the
 * summary instead.
 */
export async function postFindings(options: PostOptions): Promise<PostSummary> {
  const { adapter, snapshot, store, findings, lang } = options;

  const alreadyPosted = new Set(store.readPosted());
  let newlyDismissed = 0;
  const superseded: string[] = [];

  try {
    const present = await adapter.listExistingComments(snapshot.target);
    for (const comment of present) {
      if (comment.fingerprint) alreadyPosted.add(comment.fingerprint);
      // A summary describes one run, so the next run's summary retires it. The
      // fingerprint check spares the folded-together comment an unanchorable
      // review produces: it is a summary and a set of findings at once, and
      // those findings are still live.
      if (comment.isSummary && !comment.fingerprint && comment.nodeId) superseded.push(comment.nodeId);
    }
    // Claim what is already on the pull request before comparing against it.
    // Every one of these carries our own marker, so the pull request — not the
    // local file — is the durable record of what was said. Without this step a
    // review posted from another machine, or before the memory was cleared, is
    // invisible: deleting it teaches nothing, because nothing remembers it was
    // ever there.
    // Titled from this run's findings where the fingerprint still matches, so
    // a record claimed from the host reads as a sentence rather than a hash.
    const byFingerprint = new Map(findings.map((finding) => [finding.fingerprint, finding]));
    options.memory?.recordPosted(
      present
        .filter((comment) => comment.fingerprint)
        .map((comment) => {
          const finding = byFingerprint.get(comment.fingerprint!);
          return {
            fingerprint: comment.fingerprint!,
            ...(finding ? { title: finding.title, where: `${finding.path}:${finding.line}` } : {}),
          };
        }),
      snapshot.target.number,
    );
    // Anything we posted that is now gone, or whose thread was resolved, is a
    // maintainer saying no. Learn it here, before deciding what to post.
    newlyDismissed = options.memory?.reconcile(present, snapshot.target.number).length ?? 0;
  } catch {
    // If the host will not tell us what is already there, the local record is
    // still a decent guard — better to post than to abort the whole run.
  }

  const dismissed = options.memory?.dismissed() ?? new Set<string>();

  // Which post-image lines each file actually exposes for comments.
  const anchorsByPath = new Map<string, Set<number>>();
  for (const file of snapshot.files) anchorsByPath.set(file.path, commentableLines(file.hunks));

  const comments: InlineComment[] = [];
  const postedFingerprints: string[] = [];
  const postedRecords: { fingerprint: string; title: string; where: string }[] = [];
  let skippedAsDuplicate = 0;
  let skippedAsDismissed = 0;
  let unanchorable = 0;

  for (const finding of findings) {
    if (dismissed.has(finding.fingerprint)) {
      skippedAsDismissed++;
      continue;
    }
    if (alreadyPosted.has(finding.fingerprint)) {
      skippedAsDuplicate++;
      continue;
    }

    const anchors = anchorsByPath.get(finding.path);
    const line = anchors ? snapToCommentable(finding.line, anchors) : null;
    if (line === null) {
      unanchorable++;
      continue;
    }

    const comment: InlineComment = {
      path: finding.path,
      line,
      body: renderComment(finding, lang, findingMarker(finding.fingerprint)),
    };
    if (finding.endLine !== undefined && anchors?.has(finding.endLine) && finding.endLine > line) {
      comment.startLine = line;
      comment.line = finding.endLine;
    }
    comments.push(comment);
    postedFingerprints.push(finding.fingerprint);
    postedRecords.push({
      fingerprint: finding.fingerprint,
      title: finding.title,
      where: `${finding.path}:${finding.line}`,
    });
  }

  const summary = renderPostSummary(
    options.report,
    { inline: comments.length, skippedAsDuplicate },
    SUMMARY_MARKER,
  );

  if (options.dryRun) {
    return {
      posted: comments.length,
      skippedAsDuplicate,
      skippedAsDismissed,
      newlyDismissed,
      unanchorable,
    };
  }

  const result = await adapter.postReview(snapshot.target, { summary, comments });
  // Recorded only after the host accepted them, so a failed post is retried.
  store.addPosted(postedFingerprints);
  options.memory?.recordPosted(postedRecords, snapshot.target.number);

  // Only once the replacement is up: if the post had failed, the older summary
  // would still be the best account of this pull request available, and folding
  // it away first would have left the reader with nothing.
  if (adapter.minimizeOutdated && superseded.length > 0) {
    await adapter.minimizeOutdated(snapshot.target, superseded);
  }

  return {
    posted: result.posted,
    skippedAsDuplicate,
    skippedAsDismissed,
    newlyDismissed,
    unanchorable: unanchorable + result.demoted,
    url: result.url,
  };
}
