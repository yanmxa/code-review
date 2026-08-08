#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ensureProxySupport } from "./net/proxy.js";

// Before any network call: a configured-but-unused proxy is the single most
// confusing failure mode this tool has, and it is fixable at launch.
ensureProxySupport();

import { findRunDir, listRuns } from "./checkpoint/store.js";
import {
  type Config,
  type ConfigOverrides,
  configFromEnv,
  DEFAULT_CONFIG,
  formatModelRef,
  loadConfigFile,
  parseModelRef,
  projectConfigPath,
  resolveConfig,
  userConfigPath,
} from "./config.js";
import { parseTarget } from "./platform/adapter.js";
import { executeRun } from "./run.js";
import { Tracer } from "./trace/tracer.js";
import { createPlainRenderer } from "./tui/plain.js";
import { runDashboard } from "./tui/app.js";
import { theme } from "./tui/theme.js";
import type { RunEvent } from "./types.js";

const USAGE = `
${theme.accent("pi-review")} — code review agent for GitHub / GitLab pull requests

${theme.strong("Usage")}
  pi-review <pr-url> [options]
  pi-review runs                    list checkpointed runs
  pi-review triage <run-id>         reopen the findings browser for a finished run
  pi-review trace <run-id> <unit>   print a unit's trace

${theme.strong("Options")}
  --budget <cny>        total budget for this review          (default ${DEFAULT_CONFIG.budget.totalCny})
  --model <ref>         primary model, e.g. openai/gpt-5.4
  --lang <zh|en>        language for findings and the report  (default ${DEFAULT_CONFIG.lang})
  --post                post findings back to the pull request
  --report <path>       also write the markdown report here
  --fresh               ignore any checkpoint and start over
  --no-tui              line output instead of the dashboard
  --verbose             with --no-tui, also stream model output
  --fail-on <tier>      exit 2 if findings of this tier exist (adoptable|any)
  -h, --help            show this

${theme.strong("Credentials")}
  GitHub    GITHUB_TOKEN, or an authenticated \`gh\`
  GitLab    GITLAB_TOKEN
  Model     OPENAI_API_KEY / MOONSHOT_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY

${theme.dim("Config: ~/.config/pi-review/config.json, then ./review.config.json, then env, then flags.")}
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      budget: { type: "string" },
      model: { type: "string" },
      lang: { type: "string" },
      post: { type: "boolean" },
      report: { type: "string" },
      fresh: { type: "boolean" },
      "no-tui": { type: "boolean" },
      verbose: { type: "boolean" },
      "fail-on": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return positionals.length === 0 && !values.help ? 1 : 0;
  }

  const config = buildConfig(values);
  const [command, ...rest] = positionals;

  switch (command) {
    case "runs":
      return commandRuns(config);
    case "triage":
      return commandTriage(config, rest[0]);
    case "trace":
      return commandTrace(config, rest[0], rest[1]);
    default:
      return commandReview(config, command as string, values);
  }
}

function buildConfig(values: Record<string, unknown>): Config {
  const flags: ConfigOverrides = {};
  if (typeof values.budget === "string") {
    const totalCny = Number(values.budget);
    if (!Number.isFinite(totalCny) || totalCny <= 0) throw new Error(`--budget must be a positive number`);
    flags.budget = { totalCny };
  }
  if (typeof values.model === "string") {
    const primary = parseModelRef(values.model);
    // A hand-picked primary model replaces the whole ladder: silently
    // downgrading to a different family than the user asked for would be worse
    // than running out of budget.
    flags.models = { primary };
    flags.budget = { ...flags.budget, ladder: [{ atFraction: 0, model: primary }] };
  }
  if (values.lang === "zh" || values.lang === "en") flags.lang = values.lang;
  if (values.fresh === true) flags.fresh = true;

  return resolveConfig(
    loadConfigFile(userConfigPath()),
    loadConfigFile(projectConfigPath()),
    configFromEnv(),
    flags,
  );
}

async function commandReview(
  config: Config,
  url: string,
  values: Record<string, unknown>,
): Promise<number> {
  const target = parseTarget(url);
  const useTui = !values["no-tui"] && process.stdout.isTTY === true && !process.env.CI;

  const controller = new AbortController();
  const onSigint = () => {
    process.stderr.write(theme.warn("\nInterrupted — progress is checkpointed; re-run to resume.\n"));
    controller.abort();
  };
  process.once("SIGINT", onSigint);

  try {
    if (useTui) {
      const outcome = await runDashboard({ target, config, signal: controller.signal });
      return exitCodeFor(outcome.findings, outcome.hardStopped, values["fail-on"]);
    }

    const render = createPlainRenderer({
      lang: config.lang,
      totalCny: config.budget.totalCny,
      verbose: values.verbose === true,
    });
    const outcome = await executeRun({
      target,
      config,
      emit: (event: RunEvent) => render(event),
      post: values.post === true,
      reportPath: typeof values.report === "string" ? values.report : undefined,
      signal: controller.signal,
    });

    if (outcome.posted) {
      process.stdout.write(
        theme.dim(
          `Posted ${outcome.posted.posted} comment(s)` +
            (outcome.posted.skippedAsDuplicate > 0
              ? `, skipped ${outcome.posted.skippedAsDuplicate} already present`
              : "") +
            (outcome.posted.url ? ` → ${outcome.posted.url}` : "") +
            "\n",
        ),
      );
    }
    return exitCodeFor(outcome.findings, outcome.hardStopped, values["fail-on"]);
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function exitCodeFor(
  findings: { confidence: string }[],
  hardStopped: boolean,
  failOn: unknown,
): number {
  if (hardStopped) return 3;
  if (failOn === "adoptable" && findings.some((f) => f.confidence === "adoptable")) return 2;
  if (failOn === "any" && findings.length > 0) return 2;
  return 0;
}

function commandRuns(config: Config): number {
  const runs = listRuns(config.runDir);
  if (runs.length === 0) {
    process.stdout.write(theme.dim(`No checkpointed runs in ${config.runDir}\n`));
    return 0;
  }
  for (const run of runs) {
    const status = run.finished ? theme.ok("done") : theme.warn("partial");
    process.stdout.write(
      `${theme.accent(run.runId)}  ${status.padEnd(18)} ` +
        `${String(run.done).padStart(3)}/${String(run.units).padEnd(3)} units  ` +
        `${String(run.findings).padStart(3)} findings  ` +
        `¥${run.spendCny.toFixed(2).padStart(6)}  ` +
        `${theme.dim(run.updatedAt.slice(0, 19).replace("T", " "))}  ${run.prUrl}\n`,
    );
  }
  return 0;
}

async function commandTriage(config: Config, runId: string | undefined): Promise<number> {
  if (!runId) throw new Error("Usage: pi-review triage <run-id>");
  const dir = findRunDir(config.runDir, runId);
  if (!dir) throw new Error(`No run matching "${runId}". Try: pi-review runs`);

  const { browseRun } = await import("./tui/app.js");
  await browseRun(dir, config);
  return 0;
}

function commandTrace(config: Config, runId: string | undefined, unitId: string | undefined): number {
  if (!runId || !unitId) throw new Error("Usage: pi-review trace <run-id> <unit-id>");
  const dir = findRunDir(config.runDir, runId);
  if (!dir) throw new Error(`No run matching "${runId}". Try: pi-review runs`);

  const relative = unitId.startsWith("traces/")
    ? unitId
    : `traces/${unitId.replace(/[^A-Za-z0-9._#-]/g, "_")}.jsonl`;
  const events = Tracer.read(dir, relative);
  if (events.length === 0) throw new Error(`No trace at ${relative} in ${dir}`);

  for (const event of events) {
    process.stdout.write(`${theme.dim(event.ts)} ${theme.accent(event.type)}\n`);
    process.stdout.write(`${JSON.stringify(event, null, 2)}\n\n`);
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    process.stderr.write(theme.danger(`\n${error.message}\n`));
    if (process.env.PI_REVIEW_DEBUG) process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  });

export { buildConfig, formatModelRef };
