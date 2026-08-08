import { GitHubAdapter, resolveGitHubToken } from "../src/platform/github.js";
import { parseTarget } from "../src/platform/adapter.js";
import { Redactor } from "../src/security/redactor.js";
const redactor = new Redactor();
const token = await resolveGitHubToken();
const target = parseTarget("https://github.com/vitest-dev/vitest/pull/7000");
const snap = await new GitHubAdapter({ redactor, token }).fetchPr(target);
for (const line of snap.diff.split("\n")) {
  if (line.includes("[REDACTED:")) console.log(JSON.stringify(line));
}
