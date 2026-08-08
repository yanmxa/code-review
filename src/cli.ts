#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
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
import { authStatus, terminalInteraction } from "./auth/login.js";
import { FileCredentialStore } from "./auth/credential-store.js";
import { parseTarget } from "./platform/adapter.js";
import { createModelRegistry, executeRun, KNOWN_PROVIDERS, providerForLogin } from "./run.js";
import { Tracer } from "./trace/tracer.js";
import { createPlainRenderer } from "./tui/plain.js";
import { runDashboard } from "./tui/app.js";
import { theme } from "./tui/theme.js";
import type { RunEvent } from "./types.js";

const USAGE = `
${theme.accent("code-review")} — code review agent for GitHub / GitLab pull requests

${theme.strong("Usage")}
  code-review <pr-url> [options]      review a pull request

${theme.strong("Results")}
  code-review runs                    list checkpointed runs
  code-review triage <run-id>         reopen the findings browser for a finished run
  code-review trace <run-id> <unit>   print a unit's full trace

${theme.strong("Setup")}
  code-review config                  show the configuration a run would use
  code-review init                    write review.config.json to edit
  code-review auth                    show which credentials are configured
  code-review login [provider]        sign in with a subscription (default: openai-codex)
  code-review logout <provider>       forget a stored credential

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
  Model     a subscription via \`code-review login\`, or an API key in the
            environment: OPENAI_API_KEY / MOONSHOT_API_KEY / ANTHROPIC_API_KEY /
            OPENROUTER_API_KEY

${theme.dim("Config: ~/.config/code-review/config.json, then ./review.config.json, then env, then flags.")}
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
    case "login":
      return commandLogin(rest[0]);
    case "logout":
      return commandLogout(rest[0]);
    case "auth":
      return commandAuth();
    case "config":
      return commandConfig(config);
    case "init":
      return commandInit(config);
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

/**
 * Sign in to a provider that bills through a subscription rather than a key.
 *
 * The OAuth flow prints a URL, waits for the browser round-trip, and stores the
 * resulting credential in ~/.code-review/auth.json (mode 0600).
 */
async function commandLogin(providerId = "openai-codex"): Promise<number> {
  const models = await providerForLogin(providerId);
  const credential = await models.login(providerId, "oauth", terminalInteraction());

  process.stdout.write(
    `\n${theme.ok("✓")} Signed in to ${theme.accent(providerId)} (${credential.type}).\n` +
      theme.dim(`  Credential stored in ${new FileCredentialStore().path}\n`) +
      theme.dim(`  Use it with:  code-review <pr-url> --model ${providerId}/gpt-5.4\n`),
  );
  return 0;
}

async function commandLogout(providerId: string | undefined): Promise<number> {
  if (!providerId) throw new Error(`Usage: code-review logout <${KNOWN_PROVIDERS.join("|")}>`);
  await new FileCredentialStore().delete(providerId);
  process.stdout.write(`${theme.dim(`Forgot the stored credential for ${providerId}.`)}\n`);
  return 0;
}

/** Show what is configured, so a failing run has an obvious first thing to check. */
async function commandAuth(): Promise<number> {
  let models;
  try {
    models = await createModelRegistry();
  } catch (error) {
    process.stdout.write(`${theme.warn((error as Error).message)}\n`);
    return 1;
  }

  const statuses = await authStatus(models, [...KNOWN_PROVIDERS]);
  for (const status of statuses) {
    if (!status.configured) continue;
    const kind =
      status.type === "oauth"
        ? theme.ok("subscription (OAuth)")
        : theme.dim(`api key${status.source ? ` · ${status.source}` : ""}`);
    process.stdout.write(`${theme.accent(status.providerId.padEnd(16))} ${kind}\n`);
  }
  if (statuses.every((status) => !status.configured)) {
    process.stdout.write(theme.dim("No model credentials configured.\n"));
  }

  const github = process.env.GITHUB_TOKEN ? "GITHUB_TOKEN" : "gh auth token";
  process.stdout.write(`${theme.accent("github".padEnd(16))} ${theme.dim(github)}\n`);
  return 0;
}

/**
 * Print the configuration a run would actually use.
 *
 * Config comes from four layers, and "which model is it going to use, and when
 * does it downgrade" is the first question when a run costs more or less than
 * expected. Answering it without starting a run is worth a command.
 */
function commandConfig(config: Config): number {
  const w = (line: string) => process.stdout.write(`${line}\n`);

  w(theme.strong("Sources") + theme.dim("  (later layers win)"));
  for (const path of [userConfigPath(), projectConfigPath()]) {
    const present = existsSync(path);
    w(`  ${present ? theme.ok("✓") : theme.dim("·")} ${present ? path : theme.dim(path)}`);
  }
  const envKeys = Object.keys(process.env).filter((key) => key.startsWith("CODE_REVIEW_"));
  w(`  ${envKeys.length > 0 ? theme.ok("✓") : theme.dim("·")} environment${envKeys.length > 0 ? ` ${theme.dim(envKeys.join(", "))}` : theme.dim(" (no CODE_REVIEW_* set)")}`);

  w("");
  w(theme.strong("Budget"));
  w(`  total           ${theme.accent(`¥${config.budget.totalCny}`)} ${theme.dim(`@ ${config.budget.usdToCny} CNY/USD`)}`);
  w(`  squeeze at      ${theme.dim(`${Math.round(config.budget.squeezeAtFraction * 100)}% — smaller file windows`)}`);
  w(`  hard stop at    ${theme.dim(`${Math.round(config.budget.hardStopAtFraction * 100)}% — rules-only for the rest`)}`);

  w("");
  w(theme.strong("Model ladder") + theme.dim("  (switches as the budget is consumed)"));
  for (const step of config.budget.ladder) {
    const at = step.atFraction === 0 ? "start" : `${Math.round(step.atFraction * 100)}%`;
    w(`  ${theme.dim(at.padStart(6))}  ${theme.model(formatModelRef(step.model))}`);
  }

  w("");
  w(theme.strong("Other"));
  w(`  language        ${theme.accent(config.lang)}`);
  w(`  max turns/file  ${theme.accent(String(config.maxTurnsPerUnit))}`);
  w(`  file context    ${theme.accent(String(config.fileContextLines))} ${theme.dim(`lines (${config.fileContextLinesSqueezed} when squeezed)`)}`);
  w(`  split files at  ${theme.accent(String(config.maxUnitDiffLines))} ${theme.dim("diff lines")}`);
  w(`  checkpoints     ${theme.dim(config.runDir)}`);

  const disabled = Object.entries(config.tools).filter(([, on]) => !on).map(([id]) => id);
  w(`  tools           ${disabled.length === 0 ? theme.dim("all enabled") : theme.warn(`disabled: ${disabled.join(", ")}`)}`);
  return 0;
}

/** Write a starting config next to the project, so the defaults are editable. */
function commandInit(config: Config): number {
  const path = projectConfigPath();
  if (existsSync(path)) {
    process.stdout.write(theme.warn(`${path} already exists — leaving it alone.\n`));
    return 1;
  }
  const starter = {
    budget: {
      totalCny: config.budget.totalCny,
      usdToCny: config.budget.usdToCny,
      ladder: config.budget.ladder,
      squeezeAtFraction: config.budget.squeezeAtFraction,
      hardStopAtFraction: config.budget.hardStopAtFraction,
    },
    models: config.models,
    tools: { ts_syntax_check: true },
    lang: config.lang,
    maxTurnsPerUnit: config.maxTurnsPerUnit,
    fileContextLines: config.fileContextLines,
  };
  writeFileSync(path, `${JSON.stringify(starter, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${theme.ok("✓")} Wrote ${theme.accent(path)}\n` +
      theme.dim("  Edit it, then check the result with:  code-review config\n"),
  );
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
  if (!runId) throw new Error("Usage: code-review triage <run-id>");
  const dir = findRunDir(config.runDir, runId);
  if (!dir) throw new Error(`No run matching "${runId}". Try: code-review runs`);

  const { browseRun } = await import("./tui/app.js");
  await browseRun(dir, config);
  return 0;
}

function commandTrace(config: Config, runId: string | undefined, unitId: string | undefined): number {
  if (!runId || !unitId) throw new Error("Usage: code-review trace <run-id> <unit-id>");
  const dir = findRunDir(config.runDir, runId);
  if (!dir) throw new Error(`No run matching "${runId}". Try: code-review runs`);

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
    if (process.env.CODE_REVIEW_DEBUG) process.stderr.write(`${error.stack}\n`);
    process.exit(1);
  });

export { buildConfig, formatModelRef };
