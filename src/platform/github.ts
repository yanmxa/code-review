import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrMeta, PrSnapshot, Redacted, Target } from "../types.js";
import type { Redactor } from "../security/redactor.js";
import { parseUnifiedDiff } from "./diff.js";
import {
  type AdapterDeps,
  type CheckSummary,
  findingMarker,
  type MarkerComment,
  parseMarker,
  type PlatformAdapter,
  type PostResult,
  type ReviewPayload,
  SUMMARY_MARKER,
} from "./adapter.js";

const execFileAsync = promisify(execFile);

/**
 * Resolve a GitHub token.
 *
 * `gh auth token` is the only subprocess this program ever spawns. It is a local,
 * user-installed binary invoked with a fixed argv — no repository content
 * reaches it.
 */
export async function resolveGitHubToken(): Promise<string | undefined> {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 10_000 });
    const token = stdout.trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export class GitHubAdapter implements PlatformAdapter {
  readonly platform = "github" as const;
  private readonly redactor: Redactor;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: AdapterDeps) {
    this.redactor = deps.redactor;
    this.token = deps.token;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async fetchPr(target: Target): Promise<PrSnapshot> {
    const base = `${target.apiBase}/repos/${target.owner}/${target.repo}/pulls/${target.number}`;

    const [prJson, diffText] = await Promise.all([
      this.request<GitHubPr>(base),
      this.requestText(base, "application/vnd.github.v3.diff"),
    ]);

    const meta: PrMeta = {
      title: prJson.title ?? "(untitled)",
      description: this.redactor.redact(prJson.body ?? ""),
      author: prJson.user?.login ?? "unknown",
      sourceBranch: prJson.head?.ref ?? "",
      targetBranch: prJson.base?.ref ?? "",
      baseSha: prJson.base?.sha ?? "",
      headSha: prJson.head?.sha ?? "",
      state: prJson.state ?? "open",
      additions: prJson.additions,
      deletions: prJson.deletions,
    };

    // Redact before parsing so no unredacted diff text is ever held as a value
    // that could be passed onward by mistake.
    const diff = this.redactor.redact(diffText);
    const files = parseUnifiedDiff(diff);

    return { target, meta, diff, files };
  }

  async fetchFile(target: Target, path: string, ref: string): Promise<Redacted | null> {
    const url = `${target.apiBase}/repos/${target.owner}/${target.repo}/contents/${encodeURIComponent(
      path,
    ).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`;
    try {
      const text = await this.requestText(url, "application/vnd.github.raw");
      return this.redactor.redact(text);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * CI state, plus whatever diagnostics the failing checks anchored to a file.
   *
   * Annotations are the valuable part: a check that says "cache.test.ts:12
   * expected b, got a" points at the defect far more precisely than the model
   * can from the diff. Failures here are swallowed — a review must not depend
   * on a repository having CI at all.
   */
  async fetchChecks(target: Target, ref: string): Promise<CheckSummary> {
    const repo = `${target.apiBase}/repos/${target.owner}/${target.repo}`;
    const empty: CheckSummary = { conclusion: "unknown", failed: [], annotations: [] };

    let runs: GitHubCheckRun[];
    try {
      const response = await this.request<{ check_runs?: GitHubCheckRun[] }>(
        `${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
      );
      runs = response.check_runs ?? [];
    } catch {
      return empty;
    }
    if (runs.length === 0) return empty;

    const failed = runs.filter((run) => run.conclusion === "failure" || run.conclusion === "timed_out");
    const pending = runs.some((run) => run.status !== "completed");

    const summary: CheckSummary = {
      conclusion: failed.length > 0 ? "failure" : pending ? "pending" : "success",
      failed: failed.map((run) => ({
        name: run.name ?? "check",
        ...(run.output?.summary ? { summary: truncate(run.output.summary, 300) } : {}),
        ...(run.html_url ? { url: run.html_url } : {}),
      })),
      annotations: [],
    };

    // Only failing checks are worth the extra requests, and only a few of them:
    // a run with hundreds of annotations is a linter, not a signal.
    for (const run of failed.slice(0, 5)) {
      try {
        const notes = await this.request<GitHubAnnotation[]>(
          `${repo}/check-runs/${run.id}/annotations?per_page=50`,
        );
        for (const note of notes) {
          if (!note.path || typeof note.start_line !== "number") continue;
          summary.annotations.push({
            path: note.path,
            line: note.start_line,
            level: note.annotation_level ?? "failure",
            message: this.redactor.redact(
              `${note.title ? `${note.title}: ` : ""}${note.message ?? ""}`.trim(),
            ),
          });
        }
      } catch {
        // A run without readable annotations still counts as a failure.
      }
    }
    return summary;
  }

  async listExistingComments(target: Target): Promise<MarkerComment[]> {
    const out: MarkerComment[] = [];
    const repo = `${target.apiBase}/repos/${target.owner}/${target.repo}`;

    // Resolution lives only in GraphQL; REST cannot see it. A failure here
    // leaves `resolved` undefined, which keeps findings alive rather than
    // silently suppressing them.
    const resolvedIds = await this.resolvedCommentIds(target).catch(() => undefined);

    const inline = await this.paginate<{ id: number; body: string }>(
      `${repo}/pulls/${target.number}/comments?per_page=100`,
    );
    for (const comment of inline) {
      const marker = parseMarker(comment.body ?? "");
      if (!marker.fingerprint && !marker.isSummary) continue;
      out.push({
        id: comment.id,
        ...marker,
        ...(resolvedIds ? { resolved: resolvedIds.has(comment.id) } : {}),
      });
    }

    // The run summary lives on the issue timeline, not the review thread.
    const issue = await this.paginate<{ id: number; body: string }>(
      `${repo}/issues/${target.number}/comments?per_page=100`,
    );
    for (const comment of issue) {
      const marker = parseMarker(comment.body ?? "");
      if (marker.fingerprint || marker.isSummary) out.push({ id: comment.id, ...marker });
    }

    return out;
  }

  async postReview(target: Target, payload: ReviewPayload): Promise<PostResult> {
    const repo = `${target.apiBase}/repos/${target.owner}/${target.repo}`;
    let posted = 0;
    let demoted = 0;
    let url: string | undefined;

    if (payload.comments.length > 0) {
      const comments = payload.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: "RIGHT" as const,
        ...(comment.startLine !== undefined && comment.startLine < comment.line
          ? { start_line: comment.startLine, start_side: "RIGHT" as const }
          : {}),
        body: comment.body,
      }));

      try {
        const review = await this.request<{ html_url?: string }>(
          `${repo}/pulls/${target.number}/reviews`,
          {
            method: "POST",
            body: JSON.stringify({ event: "COMMENT", body: payload.summary, comments }),
          },
        );
        posted = comments.length;
        url = review.html_url;
      } catch (error) {
        // A single unanchorable comment fails the whole review request. Rather
        // than lose everything, fold the inline bodies into one issue comment.
        if (!(error instanceof HttpError) || error.status !== 422) throw error;
        demoted = comments.length;
        const merged = [payload.summary, ...payload.comments.map(demoteToBody)].join("\n\n");
        const comment = await this.request<{ html_url?: string }>(
          `${repo}/issues/${target.number}/comments`,
          { method: "POST", body: JSON.stringify({ body: merged }) },
        );
        url = comment.html_url;
        return { posted: 0, demoted, url };
      }
    }

    if (payload.comments.length === 0) {
      const comment = await this.request<{ html_url?: string }>(
        `${repo}/issues/${target.number}/comments`,
        { method: "POST", body: JSON.stringify({ body: payload.summary }) },
      );
      url = comment.html_url;
    }

    return { posted, demoted, url };
  }

  /**
   * Review-comment ids whose thread the maintainer marked resolved.
   *
   * Resolution is a first-class "no" — stronger than silence and weaker than
   * deletion — and GitHub exposes it only through GraphQL.
   */
  private async resolvedCommentIds(target: Target): Promise<Set<number>> {
    const endpoint = target.apiBase.replace(/\/api\/v3$/, "/api/graphql").replace(
      "https://api.github.com",
      "https://api.github.com/graphql",
    );
    const query = `
      query($owner:String!,$repo:String!,$number:Int!){
        repository(owner:$owner,name:$repo){
          pullRequest(number:$number){
            reviewThreads(first:100){
              nodes{ isResolved comments(first:50){ nodes{ databaseId } } }
            }
          }
        }
      }`;

    const response = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: this.headers("application/json"),
      body: JSON.stringify({
        query,
        variables: { owner: target.owner, repo: target.repo, number: target.number },
      }),
    });
    if (!response.ok) throw await HttpError.from(response, endpoint);

    const payload = (await response.json()) as GraphQlThreads;
    const ids = new Set<number>();
    for (const thread of payload.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
      if (!thread.isResolved) continue;
      for (const comment of thread.comments?.nodes ?? []) {
        if (typeof comment.databaseId === "number") ids.add(comment.databaseId);
      }
    }
    return ids;
  }

  /** Replace the previous run's summary instead of stacking a new one. */
  async updateSummary(target: Target, commentId: string | number, body: string): Promise<void> {
    await this.request(
      `${target.apiBase}/repos/${target.owner}/${target.repo}/issues/comments/${commentId}`,
      { method: "PATCH", body: JSON.stringify({ body }) },
    );
  }

  // -------------------------------------------------------------------------

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "code-review",
      "Content-Type": "application/json",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { ...this.headers("application/vnd.github+json"), ...(init.headers ?? {}) },
    });
    if (!response.ok) throw await HttpError.from(response, url);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async requestText(url: string, accept: string): Promise<string> {
    const response = await this.fetchImpl(url, { headers: this.headers(accept) });
    if (!response.ok) throw await HttpError.from(response, url);
    return response.text();
  }

  private async paginate<T>(startUrl: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = startUrl;
    // Bounded so a pathological PR cannot spin here forever.
    for (let page = 0; url && page < 20; page++) {
      const response: Response = await this.fetchImpl(url, {
        headers: this.headers("application/vnd.github+json"),
      });
      if (!response.ok) throw await HttpError.from(response, url);
      out.push(...((await response.json()) as T[]));
      url = nextLink(response.headers.get("link"));
    }
    return out;
  }
}

function demoteToBody(comment: { path: string; line: number; body: string }): string {
  return `**\`${comment.path}:${comment.line}\`**\n\n${comment.body}`;
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/**
 * What went wrong, in the terms the person at the terminal is in.
 *
 * The default was the status, the API URL, and the response body — so mistyping
 * a pull request number produced a line of GitHub's JSON, including a link to
 * the REST documentation for an endpoint the user never knowingly called. The
 * statuses worth naming are the ones a person actually hits; anything else
 * still shows the raw body, because an unexplained failure is better than a
 * confidently wrong explanation.
 */
function explain(status: number, url: string, body: string): string {
  const target = url.replace("https://api.github.com/repos/", "").replace("/pulls/", " #");
  switch (status) {
    case 401:
      return `GitHub rejected the credentials (401). Check GITHUB_TOKEN, or run \`gh auth login\`.`;
    case 403:
      return /rate limit/i.test(body)
        ? `GitHub rate limit reached (403). Wait, or use a token with a higher limit.`
        : `GitHub refused the request (403) for ${target}. The token may lack access to this repository.`;
    case 404:
      return (
        `Not found on GitHub (404): ${target}\n` +
        `Check the number, and that the token can see this repository — a private repo reads as 404 without access.`
      );
    case 422:
      return `GitHub rejected the request (422) for ${target}: ${truncate(body)}`;
    default:
      return `HTTP ${status} for ${url}${body ? `: ${truncate(body)}` : ""}`;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(explain(status, url, body));
    this.name = "HttpError";
  }

  static async from(response: Response, url: string): Promise<HttpError> {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // Body already consumed or unavailable; the status alone is diagnostic enough.
    }
    return new HttpError(response.status, url, body);
  }
}

function truncate(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export { findingMarker, SUMMARY_MARKER };

interface GitHubCheckRun {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string;
  html_url?: string;
  output?: { summary?: string };
}

interface GitHubAnnotation {
  path?: string;
  start_line?: number;
  annotation_level?: string;
  title?: string;
  message?: string;
}

interface GraphQlThreads {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: { nodes?: { isResolved?: boolean; comments?: { nodes?: { databaseId?: number }[] } }[] };
      };
    };
  };
}

interface GitHubPr {
  title?: string;
  body?: string;
  state?: string;
  additions?: number;
  deletions?: number;
  user?: { login?: string };
  head?: { ref?: string; sha?: string };
  base?: { ref?: string; sha?: string };
}
