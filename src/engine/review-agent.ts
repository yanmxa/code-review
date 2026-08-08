import { Agent, type AgentEvent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import type { BudgetManager } from "../budget/budget.js";
import type { Config } from "../config.js";
import type { Redactor } from "../security/redactor.js";
import { selectTools } from "../tools/index.js";
import type { RawFinding, SubmitDetails, ToolContext } from "../tools/spec.js";
import type { Tracer } from "../trace/tracer.js";
import type { ModelRef, PrSnapshot, ReviewUnit } from "../types.js";
import type { CheckSummary } from "../platform/adapter.js";
import type { RuleHit } from "./rules-engine.js";
import { buildUnitPrompt, SYSTEM_PROMPT } from "./prompts.js";

export interface UnitReviewResult {
  raw: RawFinding[];
  /** toolCallId -> tool name, so the grader can resolve cited evidence. */
  toolCallNames: Map<string, string>;
  spendUsd: number;
  status: "done" | "failed";
  note?: string;
  stopped: "submitted" | "max_turns" | "budget" | "error";
}

export interface ReviewAgentDeps {
  models: Models;
  adapter: ToolContext["adapter"];
  budget: BudgetManager;
  tracer: Tracer;
  redactor: Redactor;
  config: Config;
  snapshot: PrSnapshot;
  onDelta?: (text: string) => void;
  onTool?: (phase: "start" | "end", name: string, summary: string, isError?: boolean) => void;
  /**
   * Static-analysis diagnostics observed during this unit.
   *
   * Reported out of band because these are what let a finding be promoted to
   * adoptable: the grader needs the raw diagnostics, not the model's retelling
   * of them.
   */
  onStaticDiagnostics?: (hits: StaticHit[]) => void;
  /** CI state, handed to the model as fact rather than left to inference. */
  checks?: CheckSummary;
  signal?: AbortSignal;
}

export interface StaticHit {
  toolId: string;
  path: string;
  line: number;
  diagnostic: string;
}

/**
 * Review one unit with a pi agent loop.
 *
 * The interesting part is {@link meteredStream}: budget enforcement, model
 * downgrade, and tracing all live in the stream function, so they apply to every
 * LLM call the loop makes — including turns the agent decides to take on its own
 * — without the pipeline or the tools knowing they exist.
 */
export async function reviewUnit(
  unit: ReviewUnit,
  ruleHits: RuleHit[],
  deps: ReviewAgentDeps,
): Promise<UnitReviewResult> {
  const { models, budget, tracer, config } = deps;

  const startingModel = budget.currentModel();
  const resolved = resolveModel(models, startingModel);
  tracer.write({
    type: "unit_start",
    unitId: unit.id,
    model: `${startingModel.provider}/${startingModel.id}`,
    patchSha: shortHash(unit.patch),
  });

  const toolContext: ToolContext = {
    adapter: deps.adapter,
    snapshot: deps.snapshot,
    unit,
    redactor: deps.redactor,
    fileContextLines: budget.squeezed ? config.fileContextLinesSqueezed : config.fileContextLines,
    signal: deps.signal,
  };

  const selection = selectTools(toolContext, deps.snapshot.target.platform, config.tools);

  const toolCallNames = new Map<string, string>();
  let spendUsd = 0;
  let turns = 0;
  // Held in an object because both fields are written from inside callbacks;
  // plain locals would be narrowed to their initializers by control-flow analysis.
  const run: { submitted: RawFinding[] | null; stopped: UnitReviewResult["stopped"] } = {
    submitted: null,
    stopped: "max_turns",
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT(selection.promptSnippets, config.lang, config.review),
      model: resolved,
      thinkingLevel: "low",
      tools: selection.tools,
    },
    // Findings arrive through submit_findings, so the loop never needs to run
    // past a submission or past the turn cap.
    shouldStopAfterTurn: () => {
      turns++;
      if (run.submitted !== null) {
        run.stopped = "submitted";
        return true;
      }
      if (budget.hardStopped) {
        run.stopped = "budget";
        return true;
      }
      if (turns >= config.maxTurnsPerUnit) {
        run.stopped = "max_turns";
        return true;
      }
      return false;
    },
    streamFn: meteredStream(deps, (usd) => {
      spendUsd += usd;
    }),
  });

  const unsubscribe = agent.subscribe((event) => {
    handleAgentEvent(event, {
      tracer,
      toolCallNames,
      onDelta: deps.onDelta,
      onTool: deps.onTool,
      onStaticDiagnostics: deps.onStaticDiagnostics,
      onSubmit: (findings) => {
        run.submitted = findings;
      },
    });
  });

  try {
    await agent.prompt(buildUnitPrompt(unit, ruleHits, deps.snapshot, config.lang, deps.checks));

    // One nudge, whatever the reason it stopped without reporting.
    //
    // Running out of turns is the case that matters: the model has already been
    // paid for several rounds of reading the file, and discarding that because
    // it never said "done" throws away the whole unit. The nudge costs one call
    // and recovers it. `shouldStopAfterTurn` ends the run straight after, so
    // this can never loop.
    if (run.submitted === null && !budget.hardStopped) {
      await agent.prompt(
        "You are out of turns for this file. Call submit_findings now with whatever you have. " +
          "If you found nothing worth reporting, call it with an empty findings list.",
      );
    }
  } catch (error) {
    const note = (error as Error).message;
    tracer.write({ type: "unit_end", findingIds: [], spendUsd, status: "failed", note });
    unsubscribe();
    return { raw: [], toolCallNames, spendUsd, status: "failed", note, stopped: "error" };
  }
  unsubscribe();

  const raw: RawFinding[] = run.submitted ?? [];
  const status = run.submitted === null && run.stopped !== "budget" ? "failed" : "done";
  const note =
    run.submitted === null
      ? run.stopped === "budget"
        ? "budget exhausted before the model reported"
        : "model never called submit_findings"
      : undefined;

  tracer.write({
    type: "unit_end",
    findingIds: raw.map((finding) => `${finding.path}:${finding.line}`),
    spendUsd,
    status,
    ...(note ? { note } : {}),
  });

  return { raw, toolCallNames, spendUsd, status, note, stopped: run.stopped };
}

/**
 * Wrap the provider stream with the budget gate and the trace writer.
 *
 * Every LLM call in the run goes through here, which is what makes "downgrade
 * on the next call" and "every prompt is on disk" true by construction rather
 * than by discipline.
 */
export function meteredStream(
  deps: Pick<ReviewAgentDeps, "models" | "budget" | "tracer" | "redactor">,
  onSpend?: (usd: number) => void,
): StreamFn {
  return (model, context, options) => {
    const decision = deps.budget.authorize();
    if (!decision.allowed) return budgetExhaustedStream(model);

    // The ladder may have moved since the agent was constructed; honour it now.
    const active = sameModel(decision.model, model) ? model : resolveModel(deps.models, decision.model);

    deps.tracer.write({
      type: "llm_request",
      model: `${active.provider}/${active.id}`,
      systemPrompt: context.systemPrompt ?? "",
      messages: context.messages,
      toolNames: (context.tools ?? []).map((tool) => tool.name),
    });

    const upstream = deps.models.streamSimple(active, context, options);
    const relay = createAssistantMessageEventStream();
    void pump(upstream, relay, deps, active, onSpend);
    return relay;
  };
}

/**
 * Forward provider events to the agent, metering and tracing the terminal one.
 *
 * A relay rather than a generator because `AssistantMessageEventStream` carries
 * a `result()` promise the agent loop awaits — wrapping it in a plain async
 * iterable would drop that.
 */
async function pump(
  upstream: AssistantMessageEventStream,
  relay: AssistantMessageEventStream,
  deps: Pick<ReviewAgentDeps, "budget" | "tracer">,
  model: Model<string>,
  onSpend?: (usd: number) => void,
): Promise<void> {
  let final: AssistantMessage | undefined;
  try {
    for await (const event of upstream) {
      // The terminal message rides on `message` when the call succeeded and on
      // `error` when it did not; both carry the usage we have to pay for.
      if (event.type === "done" || event.type === "error") {
        final = event.type === "done" ? event.message : event.error;
        const usage: Usage | undefined = final?.usage && withCost(final.usage, model);
        if (final && usage) {
          deps.budget.record(`${model.provider}/${model.id}`, usage);
          onSpend?.(usage.cost?.total ?? 0);
          deps.tracer.write({
            type: "llm_response",
            model: `${model.provider}/${model.id}`,
            stopReason: final.stopReason,
            content: final.content,
            usage: {
              input: usage.input ?? 0,
              output: usage.output ?? 0,
              cacheRead: usage.cacheRead ?? 0,
              costUsd: usage.cost?.total ?? 0,
            },
            ...(final.errorMessage ? { errorMessage: final.errorMessage } : {}),
          });
        }
      }
      relay.push(event);
    }
    relay.end(final);
  } catch (error) {
    // The StreamFn contract forbids rejecting: failures must arrive as a
    // terminal error event so the agent loop can unwind normally.
    const message = errorMessage(model, (error as Error).message);
    relay.push({ type: "error", reason: "error", error: message });
    relay.end(message);
  }
}

/**
 * A well-formed "stopped" stream.
 *
 * A budget stop is delivered exactly like a provider error, so the agent loop
 * needs no special case for running out of money.
 */
function budgetExhaustedStream(model: Model<string>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = errorMessage(model, "Budget exhausted — review stopped before this call.");
  stream.push({ type: "start", partial: message });
  stream.push({ type: "error", reason: "error", error: message });
  stream.end(message);
  return stream;
}

/**
 * Fill in cost when the provider reported tokens but no price.
 *
 * Several gateways (and the faux provider used in tests) return usage counts
 * with a zero cost block. Trusting that verbatim would leave the ledger at ¥0
 * and silently disable the entire budget mechanism, so we price it ourselves
 * from the model's published rates.
 */
function withCost(usage: Usage, model: Model<string>): Usage {
  if ((usage.cost?.total ?? 0) > 0) return usage;
  if (usage.totalTokens <= 0) return usage;
  return { ...usage, cost: calculateCost(model, usage) };
}

function errorMessage(model: Model<string>, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: text,
    timestamp: Date.now(),
  };
}

function handleAgentEvent(
  event: AgentEvent,
  handlers: {
    tracer: Tracer;
    toolCallNames: Map<string, string>;
    onDelta?: (text: string) => void;
    onTool?: (phase: "start" | "end", name: string, summary: string, isError?: boolean) => void;
    onStaticDiagnostics?: (hits: StaticHit[]) => void;
    onSubmit: (findings: RawFinding[]) => void;
  },
): void {
  switch (event.type) {
    case "message_update": {
      const delta = event.assistantMessageEvent;
      if (delta.type === "text_delta" && typeof delta.delta === "string") {
        handlers.onDelta?.(delta.delta);
      }
      break;
    }
    case "tool_execution_start": {
      handlers.toolCallNames.set(event.toolCallId, event.toolName);
      handlers.tracer.write({
        type: "tool_call",
        toolCallId: event.toolCallId,
        name: event.toolName,
        params: event.args,
      });
      handlers.onTool?.("start", event.toolName, summarizeArgs(event.args));
      break;
    }
    case "tool_execution_end": {
      const result = event.result as { content?: { text?: string }[]; details?: unknown } | undefined;
      const preview = result?.content?.[0]?.text?.slice(0, 400) ?? "";
      handlers.tracer.write({
        type: "tool_result",
        toolCallId: event.toolCallId,
        name: event.toolName,
        preview,
        isError: event.isError,
      });
      handlers.onTool?.("end", event.toolName, firstLine(preview), event.isError);

      if (event.toolName === "submit_findings" && !event.isError) {
        const details = result?.details as SubmitDetails | undefined;
        if (details?.submitted) handlers.onSubmit(details.submitted);
      }

      // Diagnostics are captured from the tool's own structured output rather
      // than from what the model says about them — the grader must not be able
      // to be talked into promoting a finding.
      if (!event.isError) {
        const details = result?.details as
          | { path?: string; diagnostics?: { line: number; code: number; message: string }[] }
          | undefined;
        if (details?.diagnostics?.length && details.path) {
          handlers.onStaticDiagnostics?.(
            details.diagnostics.map((diagnostic) => ({
              toolId: event.toolName,
              path: details.path as string,
              line: diagnostic.line,
              diagnostic: `TS${diagnostic.code}: ${diagnostic.message}`,
            })),
          );
        }
      }
      break;
    }
    default:
      break;
  }
}

function summarizeArgs(args: unknown): string {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    const key = ["path", "pattern", "findings"].find((k) => k in record);
    if (key === "findings") return `${(record.findings as unknown[])?.length ?? 0} finding(s)`;
    if (key) return String(record[key]);
  }
  return "";
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function resolveModel(models: Models, ref: ModelRef): Model<string> {
  const model = models.getModel(ref.provider, ref.id);
  if (!model) {
    const available = models
      .getModels(ref.provider)
      .slice(0, 8)
      .map((m) => m.id)
      .join(", ");
    throw new Error(
      `Unknown model ${ref.provider}/${ref.id}.` +
        (available ? ` Available on ${ref.provider}: ${available}…` : ` Provider ${ref.provider} has no models.`),
    );
  }
  return model as Model<string>;
}

function sameModel(ref: ModelRef, model: Model<string>): boolean {
  return ref.provider === model.provider && ref.id === model.id;
}

function shortHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export type { Context };
