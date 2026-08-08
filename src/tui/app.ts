import {
  isViewportTUI,
  Key,
  matchesKey,
  ProcessTerminal,
  TuiAltScreen,
  type TUI,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RunStore } from "../checkpoint/store.js";
import type { Config, Language } from "../config.js";
import { renderReport, type ReportInput } from "../report/markdown.js";
import { postFindings } from "../report/post.js";
import { Redactor } from "../security/redactor.js";
import { Tracer } from "../trace/tracer.js";
import { createAdapter, executeRun, type RunOutcome } from "../run.js";
import type { Finding, PrSnapshot, RunEvent, RunState, Target } from "../types.js";
import { Dashboard } from "./dashboard.js";
import { theme } from "./theme.js";
import { TraceView } from "./trace-view.js";
import { TriagePanel } from "./triage.js";

export interface DashboardOptions {
  target: Target;
  config: Config;
  signal?: AbortSignal;
}

/**
 * Run a review with the full-screen UI, then hand off to triage.
 *
 * The TUI is a pure consumer of `RunEvent`s — the same stream the plain
 * renderer reads — so the review logic has no idea whether anyone is watching.
 */
export async function runDashboard(options: DashboardOptions): Promise<RunOutcome> {
  const tui = new TuiAltScreen(new ProcessTerminal());
  const dashboard = new Dashboard(tui, options.config.lang, options.config.budget.totalCny);

  tui.addChild(dashboard);
  tui.start();
  const spinner = setInterval(() => dashboard.tick(), 100);

  // Ctrl+C during a run should checkpoint and leave, not tear the terminal.
  const removeInput = tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      stop(tui, spinner, removeInput);
      process.exit(130);
    }
    return undefined;
  });

  let outcome: RunOutcome;
  try {
    outcome = await executeRun({
      target: options.target,
      config: options.config,
      emit: (event: RunEvent) => dashboard.handle(event),
      signal: options.signal,
    });
  } catch (error) {
    stop(tui, spinner, removeInput);
    throw error;
  }

  clearInterval(spinner);
  removeInput();

  if (outcome.findings.length > 0) {
    await triageLoop(tui, {
      findings: outcome.findings,
      state: outcome.store.current,
      snapshot: outcome.snapshot,
      store: outcome.store,
      report: outcome.report,
      config: options.config,
    });
  }

  tui.stop();
  printClosing(outcome.reportPath, outcome.findings, options.config);
  return outcome;
}

/** Reopen a finished run's findings — `pi-review triage <run-id>`. */
export async function browseRun(runDir: string, config: Config): Promise<void> {
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as RunState;
  const snapshot = JSON.parse(readFileSync(join(runDir, "pr.json"), "utf8")) as PrSnapshot;

  const { store } = RunStore.open({
    runDir: join(runDir, ".."),
    target: snapshot.target,
    headSha: state.headSha,
    diffHash: state.diffHash,
  });
  const findings = store.readFindings();

  if (findings.length === 0) {
    process.stdout.write(theme.dim("This run recorded no findings.\n"));
    return;
  }

  const report: ReportInput = {
    snapshot,
    findings,
    state,
    lang: config.lang,
    budgetTotalCny: config.budget.totalCny,
    redactionStats: {},
    budgetEvents: [],
    skipped: [],
  };

  const tui = new TuiAltScreen(new ProcessTerminal());
  tui.start();
  await triageLoop(tui, { findings, state, snapshot, store, report, config });
  tui.stop();
  printClosing(join(runDir, "report.md"), findings, config);
}

interface TriageContext {
  findings: Finding[];
  state: RunState;
  snapshot: PrSnapshot;
  store: RunStore;
  report: ReportInput;
  config: Config;
}

/**
 * The interactive findings browser, until the user quits.
 *
 * Resolves rather than blocking the process, so the caller stays in charge of
 * tearing down the terminal exactly once.
 */
async function triageLoop(tui: TUI, context: TriageContext): Promise<void> {
  let lang: Language = context.config.lang;

  await new Promise<void>((resolve) => {
    const mount = () => {
      tui.clear();
      const panel = new TriagePanel(
        tui,
        context.findings,
        lang,
        context.state.spend.cny,
        context.config.budget.totalCny,
        {
          onQuit: () => resolve(),
          onToggleLang: () => {
            lang = lang === "zh" ? "en" : "zh";
            context.report.lang = lang;
            mount();
          },
          onTrace: (finding) => showTrace(tui, context, finding, lang),
          onPost: async (selected) => {
            const result = await postFindings({
              adapter: await createAdapter(context.snapshot.target, new Redactor().seedFromEnv()),
              snapshot: context.snapshot,
              store: context.store,
              findings: selected,
              report: { ...context.report, findings: selected },
              lang,
            });
            if (result.posted === 0 && result.skippedAsDuplicate > 0) {
              throw new Error(
                lang === "zh"
                  ? "这些发现此前已经评论过，未重复发布。"
                  : "All selected findings were already posted on an earlier run.",
              );
            }
          },
        },
      );
      tui.addChild(panel);
      tui.setFocus(panel);
      tui.requestRender();
    };
    mount();
  });

  // Refresh the report so the file on disk matches what the user just read
  // (the language toggle is the case that matters).
  context.report.lang = lang;
  context.store.writeReport(renderReport(context.report));
}

function showTrace(tui: TUI, context: TriageContext, finding: Finding, lang: Language): void {
  const events = Tracer.read(context.store.dirs.root, finding.tracePath);
  if (events.length === 0) return;

  const overlay = tui.showOverlay(
    new TraceView(tui, events, `${finding.id} · ${finding.tracePath}`, lang, () => {
      overlayHandle?.hide();
      tui.requestRender();
    }),
    { width: "86%", maxHeight: "82%", anchor: "center" },
  );
  const overlayHandle = overlay;
  overlay.focus();
  tui.requestRender();
}

function stop(tui: TUI, spinner: NodeJS.Timeout, removeInput: () => void): void {
  clearInterval(spinner);
  removeInput();
  tui.stop();
}

function printClosing(reportPath: string, findings: Finding[], config: Config): void {
  const adoptable = findings.filter((f) => f.confidence === "adoptable").length;
  process.stdout.write(
    `\n${theme.ok("●")} ${theme.strong(String(adoptable))} ${config.lang === "zh" ? "条可直接采纳" : "adoptable"}` +
      `   ${theme.warn("○")} ${theme.strong(String(findings.length - adoptable))} ${config.lang === "zh" ? "条仅供参考" : "reference"}\n` +
      `${theme.dim(config.lang === "zh" ? "报告：" : "Report: ")}${reportPath}\n`,
  );
}

export { isViewportTUI };
