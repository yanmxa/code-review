/**
 * Secret detection patterns.
 *
 * Patterns are adapted from the gitleaks default ruleset
 * (https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml, MIT).
 * They are deliberately biased toward false positives: over-redacting costs a
 * little review fidelity, under-redacting ships a credential to a third party.
 */

export interface SecretRule {
  id: string;
  /** Must be global; `redact` relies on `lastIndex` semantics. */
  pattern: RegExp;
  /**
   * Which capture group holds the secret itself. 0 = the whole match.
   * Using a group lets us keep `api_key=` visible while masking the value.
   */
  group?: number;
}

export const SECRET_RULES: SecretRule[] = [
  // Whole private key blocks — matched first so the body is never entropy-scanned.
  {
    id: "private-key",
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY( BLOCK)?-----/g,
  },
  { id: "aws-access-key", pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g, group: 1 },
  { id: "github-token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{16,255})\b/g, group: 1 },
  { id: "github-pat", pattern: /\b(github_pat_[A-Za-z0-9_]{22,255})\b/g, group: 1 },
  { id: "gitlab-token", pattern: /\b(glpat-[A-Za-z0-9\-_]{20,})\b/g, group: 1 },
  { id: "slack-token", pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, group: 1 },
  { id: "stripe-key", pattern: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g, group: 1 },
  { id: "openai-key", pattern: /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/g, group: 1 },
  { id: "anthropic-key", pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, group: 1 },
  { id: "google-api-key", pattern: /\b(AIza[0-9A-Za-z\-_]{35})\b/g, group: 1 },
  { id: "npm-token", pattern: /\b(npm_[A-Za-z0-9]{36})\b/g, group: 1 },
  { id: "jwt", pattern: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, group: 1 },
  // user:password@host in connection strings / URLs.
  {
    id: "url-credentials",
    pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]{3,})@/g,
    group: 1,
  },
  // Generic `secret = "..."` / `secret: '...'` / `SECRET=...` assignments.
  {
    id: "generic-assignment",
    pattern:
      /\b(?:pass(?:wo?rd)?|secret|token|api[_-]?key|apikey|access[_-]?key|auth|credential)s?\s*[:=]\s*["'`]([^"'`\n]{6,})["'`]/gi,
    group: 1,
  },
  // The same idea in camelCase, which the rule above cannot see: `\b` needs a
  // non-word character before the keyword, and there is none in the middle of
  // `awsSecretAccessKey`. Deliberately case-sensitive — with the `i` flag the
  // trailing `(?![a-z])` would also reject uppercase, and that guard is what
  // keeps `authorName` and `tokenizer` out of it.
  {
    id: "generic-assignment-camel",
    pattern:
      /[A-Za-z0-9_$]*?(?:Pass(?:wo?rd)?|Secret|Token|Api[_-]?Key|ApiKey|Access[_-]?Key|Auth|Credential)(?![a-z])[A-Za-z0-9_$]*\s*[:=]\s*["'`]([^"'`\n]{6,})["'`]/g,
    group: 1,
  },
  {
    id: "generic-env",
    pattern:
      /\b(?:[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*([^\s"'`#][^\s"'`#]{7,})/g,
    group: 1,
  },
];

/**
 * Values that look high-entropy but are public by construction. Redacting these
 * would strip information reviewers need (a commit SHA in a diff is meaningful).
 */
const ENTROPY_ALLOWLIST: RegExp[] = [
  /^[0-9a-f]{7,40}$/, // git SHAs
  /^sha(256|512)-/, // lockfile integrity hashes are handled by skipping lockfiles, but be safe
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUIDs
  /^(?:[A-Za-z]+[-_])?(?:example|sample|placeholder|dummy|fake|test|xxx+|your|changeme|redacted)/i,
  /^\d+$/,
  /^[A-Za-z]+$/, // single-case words, no matter how long
];

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export const ENTROPY_MIN_LENGTH = 24;
export const ENTROPY_THRESHOLD = 4.0;

/**
 * Candidate tokens for the entropy scanner: long base64/hex-ish runs.
 *
 * `/` is in the class because base64 uses it, but slashes are also what makes
 * a URL path look like one enormous high-entropy token. {@link isPathLike}
 * separates the two.
 */
export const ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{24,}/g;

/**
 * Distinguish a filesystem/URL path from a base64 blob that happens to contain
 * a slash.
 *
 * Paths continue from a preceding `/` or `.` (`https://github.` + `com/org/…`,
 * or `/usr/` + `local/share/…`) and carry several separators. A base64 secret
 * appears after whitespace or a delimiter and is dense between its slashes.
 */
export function isPathLike(token: string, precedingChar: string | undefined): boolean {
  if (precedingChar === "/" || precedingChar === ".") return true;
  const segments = token.split("/");
  if (segments.length < 3) return false;

  // Counting slashes was not enough, and the miss was serious: an AWS secret
  // access key is base64, so slashes are part of its alphabet, and
  // `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` was read as a path and sent to
  // the model intact. What separates the two is what sits between the slashes —
  // a path's segments are words (lowercase, hyphenated, dotted), a key's are
  // dense mixed-case runs.
  const wordy = segments.filter(
    (segment) => segment.length > 0 && /^[a-z0-9]+([._-][a-z0-9]+)*$/.test(segment),
  ).length;
  return wordy * 2 >= segments.length;
}

export function isEntropyAllowlisted(token: string): boolean {
  return ENTROPY_ALLOWLIST.some((re) => re.test(token));
}

/**
 * A token has to mix character classes to be credential-shaped. Long identifiers
 * like `getUserAccountPreferences` clear the length bar but not this one.
 */
export function looksLikeCredential(token: string): boolean {
  const hasDigit = /\d/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const classes = [hasDigit, hasLower, hasUpper].filter(Boolean).length;
  if (classes < 2) return false;
  // Reject identifier-shaped text: snake_case / kebab-case words with no digits
  // are code, not keys.
  if (!hasDigit && /^[A-Za-z]+([_-][A-Za-z]+)*$/.test(token)) return false;
  return true;
}
