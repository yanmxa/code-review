import type {
  MarkerComment,
  PlatformAdapter,
  PostResult,
  ReviewPayload,
} from "../../src/platform/adapter.js";
import { parseUnifiedDiff } from "../../src/platform/diff.js";
import { Redactor } from "../../src/security/redactor.js";
import type { PrSnapshot, Redacted, Target } from "../../src/types.js";

export const TEST_TARGET: Target = {
  platform: "github",
  owner: "acme",
  repo: "widgets",
  number: 7,
  apiBase: "https://api.github.com",
  webUrl: "https://github.com/acme/widgets/pull/7",
};

/** An in-memory host, so the pipeline can be exercised without a network. */
export class FakePlatform implements PlatformAdapter {
  readonly platform = "github" as const;
  readonly posted: ReviewPayload[] = [];
  existing: MarkerComment[] = [];

  constructor(
    private readonly diff: string,
    private readonly files: Record<string, string> = {},
    private readonly redactor = new Redactor(),
  ) {}

  async fetchPr(target: Target): Promise<PrSnapshot> {
    const diff = this.redactor.redact(this.diff);
    return {
      target,
      meta: {
        title: "Add cache eviction",
        description: this.redactor.redact("Fixes the unbounded cache."),
        author: "dev",
        sourceBranch: "feature/evict",
        targetBranch: "main",
        baseSha: "base000",
        headSha: "head111",
        state: "open",
      },
      diff,
      files: parseUnifiedDiff(diff),
    };
  }

  async fetchFile(_target: Target, path: string): Promise<Redacted | null> {
    const content = this.files[path];
    return content === undefined ? null : this.redactor.redact(content);
  }

  async listExistingComments(): Promise<MarkerComment[]> {
    return this.existing;
  }

  async postReview(_target: Target, payload: ReviewPayload): Promise<PostResult> {
    this.posted.push(payload);
    return { posted: payload.comments.length, demoted: 0, url: "https://example.test/review/1" };
  }
}

export const SAMPLE_DIFF = `diff --git a/src/cache.ts b/src/cache.ts
index 1111111..2222222 100644
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -8,6 +8,12 @@ export class Cache {
   constructor(private max: number) {}

   set(key: string, value: unknown) {
+    if (this.map.size >= this.max) {
+      const oldest = this.map.keys().next().value;
+      this.map.delete(oldest);
+    }
+    console.log("cache set", key);
     this.map.set(key, value);
   }
 }
diff --git a/src/config.ts b/src/config.ts
index 3333333..4444444 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,4 +1,6 @@
 export const config = {
   region: "us-east-1",
+  awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",
+  retries: 3,
 };
`;
