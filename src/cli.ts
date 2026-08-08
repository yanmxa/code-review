#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ensureProxySupport } from "./net/proxy.js";

// Before any network call: a configured-but-unused proxy is the single most
// confusing failure mode this tool has, and it is fixable at launch.
ensureProxySupport();

import { findRunDir, listRuns } from "./checkpoint/store.js";
import type { Models } from "@earendil-works/pi-ai";
import {
  type Config,
  type ConfigOverrides,
  type Language,
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
import { parseBudgetLimit, serializeBudgetLimit } from "./budget/limit.js";
import { BUILTIN_RULE_IDS } from "./engine/rules-engine.js";
import {
  allModelCandidates,
  type Asker,
  createAsker,
  INIT_TEXT,
  modelChoices,
  suggestLadder,
} from "./init/prompts.js";
import { DismissalStore } from "./memory/dismissals.js";
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
  code-review config [--edit]         show the configuration a run would use
  code-review init [-y]               create review.config.json, asking what matters
  code-review auth                    show which credentials are configured
  code-review login [provider]        sign in with a subscription (default: openai-codex)
  code-review logout <provider>       forget a stored credential
  code-review dismissed <pr-url>      show what this repo's maintainers rejected
  code-review undismiss <pr-url> <fp> raise a dismissed finding again

${theme.strong("Options")}
  --budget <amount>     e.g. 10, ¥10, $1.50, 800k tokens      (default ${serializeBudgetLimit(DEFAULT_CONFIG.budget.limit)})
  --model <ref>         primary model, e.g. openai/gpt-5.4
  --prompt <text>       extra context for this run, e.g. "this is a revert of #892"
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
      prompt: { type: "string" },
      lang: { type: "string" },
      post: { type: "boolean" },
      report: { type: "string" },
      fresh: { type: "boolean" },
      "no-tui": { type: "boolean" },
      verbose: { type: "boolean" },
      "fail-on": { type: "string" },
      yes: { type: "boolean", short: "y" },
      edit: { type: "boolean" },
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
      return values.edit === true ? commandEditConfig() : commandConfig(config);
    case "init":
      return commandInit(config, values.yes === true);
    case "dismissed":
      return commandDismissed(rest[0]);
    case "undismiss":
      return commandUndismiss(rest[0], rest[1]);
    default:
      return commandReview(config, command as string, values);
  }
}

function buildConfig(values: Record<string, unknown>): Config {
  const flags: ConfigOverrides = {};
  if (typeof values.budget === "string") {
    // A bare number takes the configured default unit, so `--budget 10` still
    // means something — and `code-review config` always states which.
    flags.budget = { limit: parseBudgetLimit(values.budget) };
  }
  if (typeof values.model === "string") {
    // A hand-picked model collapses the ladder: silently downgrading to a
    // different family than the user asked for would be worse than overrunning.
    flags.budget = { ...(flags.budget ?? {}), models: [parseModelRef(values.model)] };
  }
  if (typeof values.prompt === "string" && values.prompt.trim()) {
    flags.review = { prompt: values.prompt.trim() };
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
            (outcome.posted.skippedAsDismissed > 0
              ? `, withheld ${outcome.posted.skippedAsDismissed} previously dismissed`
              : "") +
            (outcome.posted.newlyDismissed > 0
              ? `, learned ${outcome.posted.newlyDismissed} new dismissal(s)`
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
  w(`  limit           ${theme.accent(serializeBudgetLimit(config.budget.limit))}` +
    (config.budget.limit.unit === "CNY" ? theme.dim(`  @ ${config.budget.usdToCny} CNY/USD`) : ""));

  w("");
  w(theme.strong("Models") + theme.dim("  (priority order; steps down when projected to overrun)"));
  config.budget.models.forEach((model, index) => {
    w(`  ${theme.dim(String(index + 1))}. ${theme.model(formatModelRef(model))}`);
  });
  w(theme.dim("  then: trim context · then: stop and finish with the free rule checks"));

  w("");
  w(theme.strong("Other"));
  w(`  language        ${theme.accent(config.lang)}`);
  w(`  max turns/file  ${theme.accent(String(config.maxTurnsPerUnit))}`);
  w(`  file context    ${theme.accent(String(config.fileContextLines))} ${theme.dim(`lines (${config.fileContextLinesSqueezed} when squeezed)`)}`);
  w(`  split files at  ${theme.accent(String(config.maxUnitDiffLines))} ${theme.dim("diff lines")}`);
  w(`  checkpoints     ${theme.dim(config.runDir)}`);

  const disabledTools = Object.entries(config.tools).filter(([, on]) => !on).map(([id]) => id);
  w(`  tools           ${disabledTools.length === 0 ? theme.dim("all enabled") : theme.warn(`disabled: ${disabledTools.join(", ")}`)}`);

  w("");
  w(theme.strong("Rules") + theme.dim("  (deterministic checks — these produce adoptable findings)"));
  w(`  built-in        ${theme.accent(String(BUILTIN_RULE_IDS.length))} ${theme.dim(BUILTIN_RULE_IDS.join(", "))}`);
  if (config.rules.disabled.length > 0) {
    w(`  disabled        ${theme.warn(config.rules.disabled.join(", "))}`);
  }
  for (const [id, severity] of Object.entries(config.rules.severity)) {
    w(`  re-graded       ${theme.accent(id)} ${theme.dim(`→ ${severity}`)}`);
  }
  for (const rule of config.rules.custom) {
    w(`  project rule    ${theme.accent(rule.id)} ${theme.dim(`${rule.severity} · /${rule.pattern}/`)}`);
  }

  if (config.review.focus || config.review.ignore.length > 0 || config.review.prompt) {
    w("");
    w(theme.strong("Reviewer"));
    if (config.review.focus) w(`  focus           ${theme.text(config.review.focus)}`);
    if (config.review.ignore.length > 0) {
      w(`  will not raise  ${theme.dim(config.review.ignore.join(", "))}`);
    }
    if (config.review.prompt) w(`  this run         ${theme.text(config.review.prompt)}`);
  }
  return 0;
}

/**
 * Write a starting config by asking, and record only what differs.
 *
 * The previous version dumped every default into the file. A config that
 * restates the defaults is worse than no config: a reader cannot tell what the
 * project chose from what nobody got round to deleting.
 */
async function commandInit(config: Config, assumeYes: boolean): Promise<number> {
  const path = projectConfigPath();
  if (existsSync(path)) {
    process.stdout.write(theme.warn(`${path} already exists — leaving it alone.\n`));
    return 1;
  }

  const chosen: ConfigOverrides = {};
  const interactive = !assumeYes && process.stdin.isTTY === true;

  if (!interactive && !assumeYes) {
    process.stdout.write(
      theme.dim("Not a terminal — writing an empty config. Use -y to silence this, or run it interactively.\n"),
    );
  }

  if (interactive) {
    const asker = createAsker();
    try {
      // Language first, so every question after it is asked in the language the
      // answers will be written in.
      const langIndex = await asker.choice(
        `${INIT_TEXT.zh.language} / ${INIT_TEXT.en.language}`,
        [...INIT_TEXT.en.languageOptions],
        DEFAULT_CONFIG.lang === "zh" ? 0 : 1,
      );
      const lang: Language = langIndex === 0 ? "zh" : "en";
      if (lang !== DEFAULT_CONFIG.lang) chosen.lang = lang;
      const t = INIT_TEXT[lang];
      process.stdout.write(`\n${theme.dim(`  ${t.intro}`)}\n\n`);

      const defaultLimit = serializeBudgetLimit(DEFAULT_CONFIG.budget.limit);
      const budget = await asker.line(t.budget, defaultLimit);
      if (budget !== defaultLimit) {
        chosen.budget = { limit: serializeBudgetLimit(parseBudgetLimit(budget)) };
      }

      const ladder = await askModels(asker, t);
      if (ladder) chosen.budget = { ...(chosen.budget ?? {}), models: ladder };

      process.stdout.write("\n");
      const ignore = await asker.line(t.ignore, "");
      const topics = ignore.split(/[,，]/).map((topic) => topic.trim()).filter(Boolean);
      if (topics.length > 0) chosen.review = { ignore: topics };
    } finally {
      asker.close();
    }
  }

  // An empty object when nothing was chosen. Writing the defaults back would
  // reintroduce exactly the problem this command exists to avoid: a file whose
  // reader cannot tell a decision from a leftover.
  writeFileSync(path, `${JSON.stringify(chosen, null, 2)}\n`, "utf8");

  const t = INIT_TEXT[chosen.lang ?? DEFAULT_CONFIG.lang];
  const body = JSON.stringify(chosen, null, 2)
    .split("\n")
    .map((line) => `  ${theme.dim(line)}`)
    .join("\n");

  process.stdout.write(
    `\n${theme.ok("✓")} ${theme.accent(path)}\n\n${body}\n\n` +
      theme.dim(`  ${Object.keys(chosen).length > 0 ? t.wrote : t.nothing}\n`) +
      theme.dim(`  ${t.seeAll}\n`),
  );
  return 0;
}

/**
 * Pick the starting model from a list, then confirm what it falls back to.
 *
 * Returns undefined when the answer matches the defaults, so nothing is written.
 * Needs credentials to know what exists; without them the question is skipped
 * rather than asked in a form the user cannot answer.
 */
async function askModels(
  asker: Asker,
  t: (typeof INIT_TEXT)["zh"],
): Promise<string[] | undefined> {
  let models: Models;
  try {
    models = await createModelRegistry();
  } catch {
    return undefined;
  }

  const defaultRef = DEFAULT_CONFIG.budget.models[0]!;
  const candidates = allModelCandidates(models);
  const choices = modelChoices(candidates, defaultRef);
  if (choices.length === 0) return undefined;

  const defaultIndex = Math.max(
    0,
    choices.findIndex((c) => c.label === formatModelRef(defaultRef)),
  );

  process.stdout.write("\n");
  const index = await asker.choice(
    t.model,
    choices.map((c) => `${c.label.padEnd(28)} ${theme.dim(`$${c.inputCost} / $${c.outputCost}`)}`),
    defaultIndex,
  );
  const primary = choices[index]!.ref;

  const suggested = suggestLadder(primary, candidates);
  if (suggested.length === 0) return [formatModelRef(primary)];

  process.stdout.write(`\n  ${t.ladder}\n\n`);
  suggested.forEach((ref, i) => {
    process.stdout.write(`   ${theme.dim("↓")} ${theme.accent(String(i + 1).padStart(2))}. ${formatModelRef(ref)}\n`);
  });

  const answer = await asker.line(`\n  ${t.ladderHint}`, "");
  const picked = answer
    .split(/[,，]/)
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= suggested.length)
    .map((n) => suggested[n - 1]!);

  const ladder = [primary, ...(picked.length > 0 ? picked : suggested)].map(formatModelRef);
  const isDefault =
    ladder.length === DEFAULT_CONFIG.budget.models.length &&
    ladder.every((ref, i) => ref === formatModelRef(DEFAULT_CONFIG.budget.models[i]!));
  return isDefault ? undefined : ladder;
}

/** Open the project config in $EDITOR, creating it if it does not exist yet. */
function commandEditConfig(): number {
  const path = projectConfigPath();
  if (!existsSync(path)) writeFileSync(path, "{\n}\n", "utf8");
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const result = spawnSync(editor, [path], { stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write(theme.warn(`${editor} exited with ${result.status}\n`));
    return 1;
  }
  // Re-resolving proves the file still parses before the user discovers it mid-run.
  resolveConfig(loadConfigFile(path));
  process.stdout.write(`${theme.ok("✓")} ${theme.dim(`${path} parses`)}\n`);
  return 0;
}

/**
 * Show what this repository's maintainers have rejected.
 *
 * Suppression that cannot be inspected is indistinguishable from a tool that
 * quietly stopped working, so the memory is always visible and always undoable.
 */
function commandDismissed(url: string | undefined): number {
  if (!url) throw new Error("Usage: code-review dismissed <pr-url>");
  const memory = DismissalStore.forTarget(parseTarget(url));
  const entries = [...memory.dismissed()];

  if (entries.length === 0) {
    process.stdout.write(theme.dim("Nothing has been dismissed for this repository.\n"));
    return 0;
  }
  for (const fingerprint of entries) {
    const record = memory.reasonFor(fingerprint);
    process.stdout.write(
      `${theme.accent(fingerprint)}  ${theme.dim(`${record?.how ?? "?"} · PR #${record?.pr ?? "?"} · ${record?.at?.slice(0, 10) ?? ""}`)}\n`,
    );
  }
  process.stdout.write(
    theme.dim(`\n${entries.length} withheld. Undo one with: code-review undismiss <pr-url> <fingerprint>\n`),
  );
  return 0;
}

function commandUndismiss(url: string | undefined, fingerprint: string | undefined): number {
  if (!url || !fingerprint) throw new Error("Usage: code-review undismiss <pr-url> <fingerprint>");
  const memory = DismissalStore.forTarget(parseTarget(url));
  const ok = memory.forget(fingerprint);
  process.stdout.write(
    ok
      ? `${theme.ok("✓")} ${fingerprint} will be raised again.\n`
      : theme.warn(`${fingerprint} was not dismissed.\n`),
  );
  return ok ? 0 : 1;
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
        `${run.spendUsd.toFixed(4).padStart(8)} USD  ` +
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
