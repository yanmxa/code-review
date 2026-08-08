import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

/**
 * Credentials on disk, so an OAuth login survives the process.
 *
 * pi-ai ships only an in-memory store and expects the host to supply a
 * persistent one. This is that: a single JSON file, mode 0600, holding one
 * credential per provider.
 *
 * The file holds live access and refresh tokens, so it is never read by
 * anything that renders output — and the redactor is seeded from it at startup,
 * so an accidental echo of a token cannot reach a prompt or a trace.
 */
export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string = defaultAuthPath()) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId];
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  /**
   * Read-modify-write, serialized.
   *
   * pi-ai refreshes OAuth tokens under this lock; two concurrent refreshes
   * writing the same file would lose one of the new refresh tokens and log the
   * user out.
   */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const run = this.chain.then(async () => {
      const all = this.load();
      const next = await fn(all[providerId]);
      if (next) all[providerId] = next;
      else delete all[providerId];
      this.save(all);
      return next;
    });
    // Keep the chain alive even when a caller's callback rejects.
    this.chain = run.catch(() => undefined);
    return run;
  }

  async delete(providerId: string): Promise<void> {
    await this.modify(providerId, async () => undefined);
  }

  /** Token values to seed the redactor with, so our own credentials never leak. */
  secrets(): string[] {
    const out: string[] = [];
    for (const credential of Object.values(this.load())) {
      const record = credential as unknown as Record<string, unknown>;
      for (const value of Object.values(record)) {
        if (typeof value === "string" && value.length >= 16) out.push(value);
      }
    }
    return out;
  }

  private load(): Record<string, Credential> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Credential>;
    } catch {
      return {};
    }
  }

  private save(all: Record<string, Credential>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }
}

export function defaultAuthPath(): string {
  return join(homedir(), ".code-review", "auth.json");
}
