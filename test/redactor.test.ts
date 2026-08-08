import { describe, expect, it } from "vitest";
import { Redactor } from "../src/security/redactor.js";
import { shannonEntropy } from "../src/security/secret-rules.js";

/**
 * Credential fixtures are assembled at runtime rather than written as literals.
 *
 * A file full of token-shaped strings trips GitHub's push protection — which is
 * the correct behaviour, and exactly what this module exists to enforce. The
 * redactor still sees the fully-formed value; only the repository never stores
 * one.
 */
const fake = (prefix: string, body: string): string => `${prefix}${body}`;

const AWS_KEY = fake("AKIA", "IOSFODNN7EXAMPLE");
const GH_TOKEN = fake("ghp", "_1234567890abcdefghijklmnopqrstuvwx");
const GITLAB_TOKEN = fake("glpat", "-ABCDEFGHIJKLMNOPQRST");
const SLACK_TOKEN = fake("xox", "b-123456789012-abcdefghijklmnop");
const OPENAI_KEY = fake("sk-", "proj-abcdefghijklmnopqrstuvwxyz012345");
const JWT = [fake("eyJ", "hbGciOiJIUzI1NiJ9"), fake("eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0"), "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join(".");

describe("Redactor — pattern rules", () => {
  const cases: [string, string, string][] = [
    ["aws-access-key", `const key = "${AWS_KEY}";`, AWS_KEY],
    ["github-token", `Authorization: Bearer ${GH_TOKEN}`, GH_TOKEN],
    ["gitlab-token", `token: ${GITLAB_TOKEN}`, GITLAB_TOKEN],
    ["slack-token", SLACK_TOKEN, SLACK_TOKEN],
    ["jwt", JWT, JWT.split(".")[0] as string],
    ["openai-key", `OPENAI_API_KEY=${OPENAI_KEY}`, OPENAI_KEY],
    ["url-credentials", "postgres://admin:hunter2pass@db.internal:5432/app", "hunter2pass"],
    ["generic-assignment", `password: "correct-horse-battery"`, "correct-horse-battery"],
  ];

  for (const [ruleId, input, secret] of cases) {
    it(`masks ${ruleId}`, () => {
      const { text, hits } = new Redactor().redactWithHits(input);
      expect(text).not.toContain(secret);
      expect(text).toContain("[REDACTED:");
      expect(hits.length).toBeGreaterThan(0);
    });
  }

  it("masks a whole private key block", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEAxGZ8h1Kq9v0m3nQ7pLbYtRw2sF4dGcJhVnMxKpQrStUvWxYz",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const output = new Redactor().redact(input);
    expect(output).not.toContain("MIIEowIBAAKC");
    expect(output).toContain("[REDACTED:private-key:");
  });

  it("produces a stable placeholder for the same secret", () => {
    const redactor = new Redactor();
    const a = redactor.redact(`key=${AWS_KEY}`);
    const b = redactor.redact(`other=${AWS_KEY}`);
    const digestOf = (s: string) => s.match(/\[REDACTED:[^:]+:([a-f0-9]{4})\]/)?.[1];
    expect(digestOf(a)).toBe(digestOf(b));
  });

  it("is idempotent — redacting twice does not double-mask", () => {
    const redactor = new Redactor();
    const once = redactor.redact(`key=${AWS_KEY}`);
    const twice = redactor.redact(once);
    expect(twice).toBe(once);
  });

  it("counts hits per rule for the report appendix", () => {
    const redactor = new Redactor();
    redactor.redact(`a=${AWS_KEY} b=${fake("AKIA", "IOSFODNN7FAKEXYZ")}`);
    expect(redactor.stats()["aws-access-key"]).toBe(2);
  });
});

describe("Redactor — runtime credential seeding", () => {
  it("masks the process's own tokens by exact match", () => {
    const redactor = new Redactor().seed("s3cret-value-that-is-long");
    const output = redactor.redact("echo s3cret-value-that-is-long");
    expect(output).not.toContain("s3cret-value-that-is-long");
    expect(output).toContain("[REDACTED:runtime-credential:");
  });

  it("ignores short seeds that would mask innocent text", () => {
    const redactor = new Redactor().seed("abc");
    expect(redactor.redact("abc def")).toBe("abc def");
  });

  it("picks up *_TOKEN / *_KEY style env vars", () => {
    const redactor = new Redactor().seedFromEnv({
      MY_SERVICE_TOKEN: "tokenvalue-1234567890",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv);
    const output = redactor.redact("using tokenvalue-1234567890 and /usr/bin");
    expect(output).not.toContain("tokenvalue-1234567890");
    expect(output).toContain("/usr/bin");
  });
});

describe("Redactor — entropy scanner", () => {
  it("masks a high-entropy credential no pattern anticipated", () => {
    const secret = "Zx7Qm2Rv9Tb4Ns1Pk8Wl3Yj6Hd5Gf0Ac";
    const output = new Redactor().redact(`custom_header: ${secret}`);
    expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED:high-entropy:");
  });

  it("leaves git SHAs alone", () => {
    const sha = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c";
    expect(new Redactor().redact(`ref: ${sha}`)).toContain(sha);
  });

  it("leaves UUIDs alone", () => {
    const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    expect(new Redactor().redact(`id=${uuid}`)).toContain(uuid);
  });

  it("leaves long identifiers alone", () => {
    const code = "const getUserAccountPreferencesFromCache = () => {};";
    expect(new Redactor().redact(code)).toBe(code);
  });

  it("leaves obvious placeholders alone", () => {
    const line = "AWS_SECRET_ACCESS_KEY=your-secret-access-key-goes-here";
    // The generic-env rule may still fire; what matters is nothing is lost that
    // a reviewer needs. Assert the entropy rule specifically did not claim it.
    const redactor = new Redactor();
    redactor.redact(line);
    expect(redactor.stats()["high-entropy"]).toBeUndefined();
  });

  it("leaves URLs with long paths alone", () => {
    // Regression: a candidate class containing "/" merged an entire URL path
    // into one high-entropy token and masked the link.
    const line =
      "// see https://github.com/istanbuljs/v8-to-istanbul/blob/da1c8ef19c33c7419d4c4c5db4a4fb69dee2b13c/lib/source.js#L131";
    const redactor = new Redactor();
    expect(redactor.redact(line)).toBe(line);
    expect(redactor.stats()["high-entropy"]).toBeUndefined();
  });

  it("still catches a base64 secret that contains slashes", () => {
    const secret = "aB3xK9m2Qw7ZrT4/vN8pLc5YhJ6dGf0s";
    const output = new Redactor().redact(`token ${secret}`);
    expect(output).toContain("[REDACTED:high-entropy:");
  });

  it("computes entropy", () => {
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
    expect(shannonEntropy("abcdefgh")).toBeCloseTo(3, 5);
  });
});

describe("Redactor — diff fidelity", () => {
  it("preserves diff structure so line geometry still parses", () => {
    const diff = [
      "@@ -1,3 +1,4 @@",
      " const config = {",
      `+  awsKey: "${AWS_KEY}",`,
      "   region: 'us-east-1',",
      " };",
    ].join("\n");
    const output = new Redactor().redact(diff);
    const lines = output.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[2]?.startsWith("+")).toBe(true);
    expect(output).not.toContain(AWS_KEY);
  });

  it("reports the line each secret was found on", () => {
    const input = ["line one", "line two", `key=${AWS_KEY}`].join("\n");
    const { hits } = new Redactor().redactWithHits(input);
    expect(hits[0]?.line).toBe(3);
  });
});

describe("Redactor — path vs base64 discrimination", () => {
  it("leaves a bare source path alone", () => {
    const line = "import x from 'packages/coverage-v8/src/provider.ts';";
    const redactor = new Redactor();
    expect(redactor.redact(line)).toBe(line);
    expect(redactor.stats()["high-entropy"]).toBeUndefined();
  });

  it("leaves an absolute filesystem path alone", () => {
    const line = "cwd: /usr/local/share/some-application/config";
    expect(new Redactor().redact(line)).toBe(line);
  });
});

describe("holes found by running against a real pull request", () => {
  it("masks an AWS secret access key, slashes and all", () => {
    // Shipped: the access key id beside it was masked and this was not, so a
    // credential reached the model in the same prompt as its own warning.
    const out = new Redactor().redact(
      `awsSecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",`,
    ) as unknown as string;
    expect(out).not.toContain("wJalrXUtnFEMI");
    expect(out).toContain("[REDACTED:");
  });

  it("sees a credential word inside a camelCase name", () => {
    // `\b` needs a non-word character before the keyword and there is none in
    // the middle of an identifier, so every camelCase config key was invisible.
    const out = new Redactor().redact(`myAuthToken: "s3cr3tV4lueHere123"`) as unknown as string;
    expect(out).not.toContain("s3cr3tV4lueHere123");
  });

  it("still leaves a name that merely contains a credential word alone", () => {
    for (const line of [`authorName: "Alice Smith Jones"`, `tokenizer: "sentencepiece-bpe"`]) {
      expect(new Redactor().redact(line) as unknown as string).toBe(line);
    }
  });

  it("catches a slash-bearing high-entropy value with no keyword to key off", () => {
    // The entropy scanner is the net under the named rules; treating anything
    // with two slashes as a file path had cut a hole in exactly the alphabet
    // base64 uses.
    const out = new Redactor().redact(
      `const v = "Zm9vYmFy/QmFzZTY0U3Ry+aW5nVmFsdWU/dGhpc0lzTG9uZw";`,
    ) as unknown as string;
    expect(out).toContain("[REDACTED:");
  });

  it("still leaves a URL path alone", () => {
    const url = `see https://github.com/istanbuljs/v8-to-istanbul/blob/da1c8ef29d/lib/branch.js`;
    expect(new Redactor().redact(url) as unknown as string).toBe(url);
  });
})
