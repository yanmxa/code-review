import type { PrMeta, PrSnapshot, Redacted, Target } from "../types.js";
import type { Redactor } from "../security/redactor.js";
import { parseUnifiedDiff } from "./diff.js";
import { HttpError } from "./github.js";
import {
  type AdapterDeps,
  findingMarker,
  type MarkerComment,
  parseMarker,
  type PlatformAdapter,
  type PostResult,
  projectPath,
  type ReviewPayload,
  SUMMARY_MARKER,
} from "./adapter.js";

export function resolveGitLabToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GITLAB_TOKEN || env.CI_JOB_TOKEN || undefined;
}

/**
 * GitLab merge requests over the v4 REST API.
 *
 * GitLab returns per-file diffs rather than one unified document, so we
 * reassemble a unified diff and hand it to the same parser GitHub uses — every
 * stage downstream then works identically regardless of host.
 */
export class GitLabAdapter implements PlatformAdapter {
  readonly platform = "gitlab" as const;
  private readonly redactor: Redactor;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  /** Needed to anchor discussion positions; captured during fetchPr. */
  private diffRefs?: { base_sha: string; head_sha: string; start_sha: string };

  constructor(deps: AdapterDeps) {
    this.redactor = deps.redactor;
    this.token = deps.token;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async fetchPr(target: Target): Promise<PrSnapshot> {
    const base = this.mrUrl(target);
    const mr = await this.request<GitLabMr>(base);
    this.diffRefs = mr.diff_refs;

    const changes = await this.paginate<GitLabDiff>(`${base}/diffs?per_page=100`);
    const unified = changes.map(toUnifiedDiff).join("");

    const meta: PrMeta = {
      title: mr.title ?? "(untitled)",
      description: this.redactor.redact(mr.description ?? ""),
      author: mr.author?.username ?? "unknown",
      sourceBranch: mr.source_branch ?? "",
      targetBranch: mr.target_branch ?? "",
      baseSha: mr.diff_refs?.base_sha ?? "",
      headSha: mr.diff_refs?.head_sha ?? mr.sha ?? "",
      startSha: mr.diff_refs?.start_sha,
      state: mr.state ?? "opened",
    };

    const diff = this.redactor.redact(unified);
    return { target, meta, diff, files: parseUnifiedDiff(diff) };
  }

  async fetchFile(target: Target, path: string, ref: string): Promise<Redacted | null> {
    const url =
      `${target.apiBase}/projects/${encodeURIComponent(projectPath(target))}` +
      `/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;
    try {
      return this.redactor.redact(await this.requestText(url));
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }

  async listExistingComments(target: Target): Promise<MarkerComment[]> {
    const notes = await this.paginate<{ id: number; body: string }>(
      `${this.mrUrl(target)}/notes?per_page=100`,
    );
    const out: MarkerComment[] = [];
    for (const note of notes) {
      const marker = parseMarker(note.body ?? "");
      if (marker.fingerprint || marker.isSummary) out.push({ id: note.id, ...marker });
    }
    return out;
  }

  async postReview(target: Target, payload: ReviewPayload): Promise<PostResult> {
    const base = this.mrUrl(target);
    let posted = 0;
    let demoted = 0;

    // GitLab has no batch review endpoint: each inline comment is its own
    // discussion, so a failure affects one comment rather than the whole set.
    for (const comment of payload.comments) {
      if (!this.diffRefs) {
        demoted++;
        continue;
      }
      try {
        await this.request(`${base}/discussions`, {
          method: "POST",
          body: JSON.stringify({
            body: comment.body,
            position: {
              position_type: "text",
              base_sha: this.diffRefs.base_sha,
              head_sha: this.diffRefs.head_sha,
              start_sha: this.diffRefs.start_sha,
              new_path: comment.path,
              old_path: comment.path,
              new_line: comment.line,
            },
          }),
        });
        posted++;
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        demoted++;
      }
    }

    const body =
      demoted > 0
        ? `${payload.summary}\n\n${payload.comments
            .slice(posted)
            .map((comment) => `**\`${comment.path}:${comment.line}\`**\n\n${comment.body}`)
            .join("\n\n")}`
        : payload.summary;

    const note = await this.request<{ id: number }>(`${base}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });

    return { posted, demoted, url: `${target.webUrl}#note_${note.id}` };
  }

  private mrUrl(target: Target): string {
    return `${target.apiBase}/projects/${encodeURIComponent(projectPath(target))}/merge_requests/${target.number}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "pi-review",
    };
    if (this.token) headers["PRIVATE-TOKEN"] = this.token;
    return headers;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { ...this.headers(), ...(init.headers ?? {}) },
    });
    if (!response.ok) throw await HttpError.from(response, url);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async requestText(url: string): Promise<string> {
    const response = await this.fetchImpl(url, { headers: this.headers() });
    if (!response.ok) throw await HttpError.from(response, url);
    return response.text();
  }

  private async paginate<T>(startUrl: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 20; page++) {
      const url = `${startUrl}${startUrl.includes("?") ? "&" : "?"}page=${page}`;
      const response = await this.fetchImpl(url, { headers: this.headers() });
      if (!response.ok) throw await HttpError.from(response, url);
      const batch = (await response.json()) as T[];
      out.push(...batch);
      const next = response.headers.get("x-next-page");
      if (!next) break;
    }
    return out;
  }
}

/** Rebuild `diff --git` framing that GitLab strips from its per-file payloads. */
export function toUnifiedDiff(change: GitLabDiff): string {
  const oldPath = change.old_path ?? change.new_path ?? "";
  const newPath = change.new_path ?? change.old_path ?? "";
  const header = [`diff --git a/${oldPath} b/${newPath}`];

  if (change.new_file) header.push("new file mode 100644");
  if (change.deleted_file) header.push("deleted file mode 100644");
  if (change.renamed_file) {
    header.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  }
  header.push(
    change.deleted_file ? "--- a/" + oldPath : change.new_file ? "--- /dev/null" : `--- a/${oldPath}`,
  );
  header.push(change.deleted_file ? "+++ /dev/null" : `+++ b/${newPath}`);

  const body = change.diff ?? "";
  if (body.length === 0) return `${header.join("\n")}\nBinary files a/${oldPath} and b/${newPath} differ\n`;
  return `${header.join("\n")}\n${body.endsWith("\n") ? body : `${body}\n`}`;
}

export interface GitLabDiff {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  diff?: string;
}

interface GitLabMr {
  title?: string;
  description?: string;
  state?: string;
  sha?: string;
  source_branch?: string;
  target_branch?: string;
  author?: { username?: string };
  diff_refs?: { base_sha: string; head_sha: string; start_sha: string };
}

export { findingMarker, SUMMARY_MARKER };
