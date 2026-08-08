import type { PlatformId, PrSnapshot, Redacted, Target } from "../types.js";
import type { Redactor } from "../security/redactor.js";

/** A comment we previously posted, identified by its embedded marker. */
export interface MarkerComment {
  /** Provider-side id, used to update the summary comment in place. */
  id: string | number;
  /** Fingerprint parsed out of the `<!-- code-review:f:... -->` marker. */
  fingerprint?: string;
  isSummary: boolean;
  /**
   * Whether the maintainer marked the thread resolved.
   *
   * Undefined means the host cannot tell us. That is not the same as `false`:
   * treating "unknown" as "unresolved" keeps a finding alive, which is the
   * safer default when the signal is missing.
   */
  resolved?: boolean;
}

export interface InlineComment {
  path: string;
  line: number;
  startLine?: number;
  body: string;
}

export interface ReviewPayload {
  summary: string;
  comments: InlineComment[];
}

/**
 * What continuous integration currently says about the head commit.
 *
 * A failing test suite is the strongest evidence about a change that exists,
 * and unlike anything the model can infer, it is a fact. Fetching it costs one
 * request; reasoning about correctness without it means arguing with an answer
 * that was already available.
 */
export interface CheckSummary {
  conclusion: "success" | "failure" | "pending" | "unknown";
  failed: { name: string; summary?: string; url?: string }[];
  /** Machine-produced diagnostics anchored to a file and line. */
  annotations: { path: string; line: number; level: string; message: string }[];
}

export interface PostResult {
  posted: number;
  /** Comments that could not be anchored and were folded into the summary. */
  demoted: number;
  url?: string;
}

/**
 * A read-mostly view of a hosted PR.
 *
 * Every method is plain HTTP. Nothing here clones a repository or executes
 * anything from it — that is the structural guarantee behind the "no arbitrary
 * code execution" requirement, not a policy we remember to follow.
 */
export interface PlatformAdapter {
  readonly platform: PlatformId;
  fetchPr(target: Target): Promise<PrSnapshot>;
  /** File content at a ref, redacted. `null` when the path does not exist there. */
  fetchFile(target: Target, path: string, ref: string): Promise<Redacted | null>;
  listExistingComments(target: Target): Promise<MarkerComment[]>;
  /** CI state for a commit. Implementations may return `unknown` when unavailable. */
  fetchChecks?(target: Target, ref: string): Promise<CheckSummary>;
  postReview(target: Target, payload: ReviewPayload): Promise<PostResult>;
}

export interface AdapterDeps {
  redactor: Redactor;
  token?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Parse a PR/MR URL.
 *
 * Accepts the browser URLs people actually paste:
 *   https://github.com/owner/repo/pull/123
 *   https://gitlab.com/group/sub/repo/-/merge_requests/45
 *   https://gitlab.example.com/group/repo/merge_requests/45  (older style)
 */
export function parseTarget(url: string): Target {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a URL: ${url}`);
  }

  const segments = parsed.pathname.split("/").filter(Boolean);

  const prIndex = segments.findIndex((s) => s === "pull" || s === "pulls");
  if (prIndex > 0 && isGitHubHost(parsed.hostname)) {
    const number = Number(segments[prIndex + 1]);
    if (!Number.isInteger(number)) throw new Error(`No PR number in URL: ${url}`);
    const owner = segments[prIndex - 2];
    const repo = segments[prIndex - 1];
    if (!owner || !repo) throw new Error(`No owner/repo in URL: ${url}`);
    return {
      platform: "github",
      owner,
      repo,
      number,
      apiBase:
        parsed.hostname === "github.com"
          ? "https://api.github.com"
          : `${parsed.origin}/api/v3`,
      webUrl: url,
    };
  }

  const mrIndex = segments.findIndex((s) => s === "merge_requests");
  if (mrIndex > 0) {
    const number = Number(segments[mrIndex + 1]);
    if (!Number.isInteger(number)) throw new Error(`No MR number in URL: ${url}`);
    // Everything before the (optional) "-" separator is the project path.
    let projectSegments = segments.slice(0, mrIndex);
    if (projectSegments[projectSegments.length - 1] === "-") projectSegments = projectSegments.slice(0, -1);
    if (projectSegments.length < 2) throw new Error(`No project path in URL: ${url}`);
    const repo = projectSegments[projectSegments.length - 1] as string;
    const owner = projectSegments.slice(0, -1).join("/");
    return {
      platform: "gitlab",
      owner,
      repo,
      number,
      apiBase: `${parsed.origin}/api/v4`,
      webUrl: url,
    };
  }

  throw new Error(
    `Unrecognized PR/MR URL: ${url}\n` +
      `Expected .../pull/<n> (GitHub) or .../merge_requests/<n> (GitLab).`,
  );
}

function isGitHubHost(hostname: string): boolean {
  return hostname === "github.com" || hostname.includes("github");
}

/** `group/sub/repo` for GitLab, `owner/repo` for GitHub. */
export function projectPath(target: Target): string {
  return `${target.owner}/${target.repo}`;
}

export const SUMMARY_MARKER = "<!-- code-review:summary -->";

export function findingMarker(fingerprint: string): string {
  return `<!-- code-review:f:${fingerprint} -->`;
}

export function parseMarker(body: string): { fingerprint?: string; isSummary: boolean } {
  if (body.includes(SUMMARY_MARKER)) return { isSummary: true };
  const match = body.match(/<!-- code-review:f:([a-f0-9]+) -->/);
  return match?.[1] ? { fingerprint: match[1], isSummary: false } : { isSummary: false };
}
