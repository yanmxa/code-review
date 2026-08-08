import { GitHubAdapter, resolveGitHubToken } from "../src/platform/github.js";
import { parseTarget } from "../src/platform/adapter.js";
import { Redactor } from "../src/security/redactor.js";

const url = process.argv[2] ?? "https://github.com/octocat/Hello-World/pull/2846";
const redactor = new Redactor().seedFromEnv();
const token = await resolveGitHubToken();
redactor.seed(token);
console.log("token resolved:", token ? `yes (${token.slice(0, 4)}…)` : "no");

const target = parseTarget(url);
const adapter = new GitHubAdapter({ redactor, token });
const snap = await adapter.fetchPr(target);
console.log(`PR: ${snap.meta.title}`);
console.log(`  ${snap.meta.sourceBranch} -> ${snap.meta.targetBranch}  head=${snap.meta.headSha.slice(0,8)}`);
console.log(`  files=${snap.files.length}  +${snap.meta.additions}/-${snap.meta.deletions}  state=${snap.meta.state}`);
for (const f of snap.files.slice(0, 8)) {
  console.log(`   ${f.change.padEnd(9)} ${f.path}  (+${f.additions}/-${f.deletions}, ${f.hunks.length} hunks)`);
}
const first = snap.files.find(f => f.hunks.length > 0);
if (first) {
  const content = await adapter.fetchFile(target, first.path, snap.meta.headSha);
  console.log(`fetchFile(${first.path}) -> ${content === null ? "null" : `${content.split("\n").length} lines`}`);
}
console.log("redaction stats:", redactor.stats());
