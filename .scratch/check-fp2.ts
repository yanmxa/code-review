import { GitHubAdapter, resolveGitHubToken } from "../src/platform/github.js";
import { parseTarget } from "../src/platform/adapter.js";
import { Redactor } from "../src/security/redactor.js";
const redactor = new Redactor();
const token = await resolveGitHubToken();
const target = parseTarget("https://github.com/vitest-dev/vitest/pull/7000");
const adapter = new GitHubAdapter({ redactor, token });
const snap = await adapter.fetchPr(target);
console.log("after diff:", redactor.stats());
for (const f of snap.files) {
  const c = await adapter.fetchFile(target, f.path, snap.meta.headSha);
  if (c?.includes("[REDACTED:")) {
    for (const line of c.split("\n")) if (line.includes("[REDACTED:")) console.log(f.path, "|", JSON.stringify(line.slice(0, 200)));
  }
}
console.log("final:", redactor.stats());
