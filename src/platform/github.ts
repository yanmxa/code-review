import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrMeta, PrSnapshot, Redacted, Target } from "../types.js";
import type { Redactor } from "../security/redactor.js";
import { parseUnifiedDiff } from "./diff.js";
import {
  type AdapterDeps,
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

  async listExistingComments(target: Target): Promise<MarkerComment[]> {
    const out: MarkerComment[] = [];
    const repo = `${target.apiBase}/repos/${target.owner}/${target.repo}`;

    const inline = await this.paginate<{ id: number; body: string }>(
      `${repo}/pulls/${target.number}/comments?per_page=100`,
    );
    for (const comment of inline) {
      const marker = parseMarker(comment.body ?? "");
      if (marker.fingerprint || marker.isSummary) out.push({ id: comment.id, ...marker });
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
      "User-Agent": "pi-review",
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

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}${body ? `: ${truncate(body)}` : ""}`);
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
