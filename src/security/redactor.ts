import { createHash } from "node:crypto";
import type { Redacted } from "../types.js";
import {
  ENTROPY_CANDIDATE,
  ENTROPY_MIN_LENGTH,
  ENTROPY_THRESHOLD,
  isEntropyAllowlisted,
  isPathLike,
  looksLikeCredential,
  SECRET_RULES,
  shannonEntropy,
} from "./secret-rules.js";

export interface RedactionHit {
  ruleId: string;
  placeholder: string;
  /** 1-based line within the redacted text where the secret appeared. */
  line: number;
}

export interface RedactionResult {
  text: Redacted;
  hits: RedactionHit[];
}

/**
 * The single point through which every byte reaches an LLM or the disk.
 *
 * Two independent layers:
 *  1. Pattern rules (gitleaks-derived) — high precision, named placeholders.
 *  2. An entropy scan — catches credential shapes no pattern anticipated.
 *
 * Plus a seed list: the process's own tokens (GITHUB_TOKEN, OPENAI_API_KEY, …)
 * are masked by exact match, so an accidental echo of our own credentials can
 * never be persisted or uploaded.
 */
export class Redactor {
  private readonly seeds = new Set<string>();
  private readonly counts = new Map<string, number>();

  /** Register literal values that must never appear in output. */
  seed(...values: (string | undefined)[]): this {
    for (const value of values) {
      // Short values would mask innocent text; real credentials are long.
      if (value && value.length >= 8) this.seeds.add(value);
    }
    return this;
  }

  /** Seed from the ambient environment. Call once at startup. */
  seedFromEnv(env: NodeJS.ProcessEnv = process.env): this {
    for (const [key, value] of Object.entries(env)) {
      if (/(_TOKEN|_KEY|_SECRET|_PASSWORD|_CREDENTIALS)$/.test(key)) this.seed(value);
    }
    return this;
  }

  /** Rule hit counts accumulated over the run, for the report appendix. */
  stats(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  /**
   * Mask every secret in `text`.
   *
   * Placeholders are `[REDACTED:<rule>:<4 hex of sha256(secret)>]`. The digest is
   * stable, so a model can still reason "the same credential appears in two
   * files" without ever seeing the credential.
   */
  redactWithHits(text: string): RedactionResult {
    let out = text;
    const hits: RedactionHit[] = [];

    const replace = (ruleId: string, secret: string): string => {
      const placeholder = `[REDACTED:${ruleId}:${digest(secret)}]`;
      this.counts.set(ruleId, (this.counts.get(ruleId) ?? 0) + 1);
      return placeholder;
    };

    // Layer 0: our own credentials, exact match.
    for (const seed of this.seeds) {
      if (!out.includes(seed)) continue;
      const placeholder = replace("runtime-credential", seed);
      out = out.split(seed).join(placeholder);
      hits.push({ ruleId: "runtime-credential", placeholder, line: 1 });
    }

    // Layer 1: pattern rules.
    for (const rule of SECRET_RULES) {
      rule.pattern.lastIndex = 0;
      out = out.replace(rule.pattern, (match, ...groups) => {
        const groupIndex = rule.group ?? 0;
        const secret = groupIndex === 0 ? match : (groups[groupIndex - 1] as string | undefined);
        if (!secret) return match;
        // Already-masked text must not be masked twice.
        if (secret.startsWith("[REDACTED:")) return match;
        const placeholder = replace(rule.id, secret);
        hits.push({ ruleId: rule.id, placeholder, line: 0 });
        return match.replace(secret, placeholder);
      });
    }

    // Layer 2: entropy sweep over what survived.
    ENTROPY_CANDIDATE.lastIndex = 0;
    out = out.replace(ENTROPY_CANDIDATE, (token: string, offset: number, whole: string) => {
      if (token.length < ENTROPY_MIN_LENGTH) return token;
      if (isPathLike(token, offset > 0 ? whole[offset - 1] : undefined)) return token;
      if (isEntropyAllowlisted(token)) return token;
      if (!looksLikeCredential(token)) return token;
      if (shannonEntropy(token) < ENTROPY_THRESHOLD) return token;
      const placeholder = replace("high-entropy", token);
      hits.push({ ruleId: "high-entropy", placeholder, line: 0 });
      return placeholder;
    });

    // Resolve line numbers now that the text is final.
    if (hits.length > 0) {
      const lines = out.split("\n");
      for (const hit of hits) {
        const index = lines.findIndex((line) => line.includes(hit.placeholder));
        hit.line = index >= 0 ? index + 1 : 1;
      }
    }

    return { text: out as Redacted, hits };
  }

  redact(text: string): Redacted {
    return this.redactWithHits(text).text;
  }

  /**
   * Mark text as safe without scanning it.
   *
   * Only for strings this program authored (headers, prompt scaffolding, i18n).
   * Never call it on anything that came from a repository or an API.
   */
  static trusted(text: string): Redacted {
    return text as Redacted;
  }
}

function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 4);
}
