import { type BudgetUnit, formatBudget, formatTokenCount } from "../budget/limit.js";
import type { Language } from "../config.js";
import { confidenceLabel, severityLabel, skipLabel, t } from "../i18n/messages.js";
import type {
  Confidence,
  Evidence,
  Finding,
  PrSnapshot,
  RunState,
  SpendLedger,
} from "../types.js";

export interface ReportInput {
  snapshot: PrSnapshot;
  findings: Finding[];
  state: RunState;
  lang: Language;
  /** The budget's unit, so the report never assumes a currency. */
  unit: BudgetUnit;
  limit: number;
  spent: number;
  redactionStats: Record<string, number>;
  budgetEvents: { kind: string; detail: string }[];
  skipped: { path: string; reason: Parameters<typeof skipLabel>[0] }[];
}

/**
 * Render the review as markdown.
 *
 * The structure is the deliverable's argument: adoptable findings first, each
 * with the evidence that earned it that label, then everything the model merely
 * suspects, then an appendix that makes the run auditable — what it cost, what
 * it skipped, and what it masked.
 */
export function renderReport(input: ReportInput): string {
  const { lang, findings, snapshot, state } = input;
  const out: string[] = [];

  const adoptable = findings.filter((finding) => finding.confidence === "adoptable");
  const reference = findings.filter((finding) => finding.confidence === "reference");

  out.push(`# ${t("reportTitle", lang)} — ${escapeMd(snapshot.meta.title)}`);
  out.push(renderMetaTable(input));

  if (state.hardStopped) out.push(`> ${t("partialWarning", lang)}`);

  out.push(`## ${t("summaryHeading", lang)}`);
  out.push(renderSummary(input, adoptable.length, reference.length));

  if (findings.length === 0) {
    out.push(t("noFindings", lang));
  } else {
    out.push(`## ✅ ${t("adoptableHeading", lang)} (${adoptable.length})`);
    out.push(
      adoptable.length === 0
        ? lang === "zh"
          ? "_无_"
          : "_None_"
        : adoptable.map((finding) => renderFinding(finding, lang)).join("\n\n"),
    );

    out.push(`## 💭 ${t("referenceHeading", lang)} (${reference.length})`);
    out.push(
      reference.length === 0
        ? lang === "zh"
          ? "_无_"
          : "_None_"
        : reference.map((finding) => renderFinding(finding, lang)).join("\n\n"),
    );
  }

  out.push(renderAppendix(input));
  return `${out.join("\n\n")}\n`;
}

function renderMetaTable(input: ReportInput): string {
  const { snapshot, state, lang } = input;
  const rows: [string, string][] = [
    [lang === "zh" ? "拉取请求" : "Pull request", `[${escapeMd(shortUrl(state.prUrl))}](${state.prUrl})`],
    [lang === "zh" ? "分支" : "Branch", `\`${snapshot.meta.sourceBranch}\` → \`${snapshot.meta.targetBranch}\``],
    ["Head", `\`${state.headSha.slice(0, 10)}\``],
    [t("filesReviewed", lang), `${state.units.filter((unit) => unit.status === "done").length} / ${state.units.length}`],
    [t("spendHeading", lang), formatSpend(input)],
    [t("modelsUsed", lang), Object.keys(state.spend.byModel).map((id) => `\`${id}\``).join(", ") || "—"],
    ["Run", `\`${state.runId}\``],
  ];
  return [
    `| | |`,
    `| --- | --- |`,
    ...rows.map(([label, value]) => `| **${label}** | ${value} |`),
  ].join("\n");
}

function renderSummary(input: ReportInput, adoptable: number, reference: number): string {
  const { lang, findings } = input;
  const bySeverity = (severity: string) => findings.filter((f) => f.severity === severity).length;
  const blockers = bySeverity("blocker");

  if (lang === "zh") {
    const head =
      findings.length === 0
        ? "本次改动未发现问题。"
        : `共 ${findings.length} 条发现：${adoptable} 条有确定性证据支撑、可直接采纳，${reference} 条为模型推断、供参考。`;
    const tail = blockers > 0 ? ` 其中 ${blockers} 条为阻断级，建议合并前处理。` : "";
    return head + tail;
  }
  const head =
    findings.length === 0
      ? "No problems found in this change."
      : `${findings.length} finding(s): ${adoptable} backed by deterministic evidence and directly adoptable, ${reference} from model reasoning and offered as suggestions.`;
  const tail = blockers > 0 ? ` ${blockers} of them are blockers and should be resolved before merging.` : "";
  return head + tail;
}

/** One finding, with its evidence made visible rather than asserted. */
export function renderFinding(finding: Finding, lang: Language): string {
  const parts: string[] = [];
  const range = finding.endLine ? `${finding.line}-${finding.endLine}` : `${finding.line}`;

  parts.push(
    `### ${finding.id} · ${tierGlyph(finding.confidence)} \`${finding.path}:${range}\` — ${escapeMd(finding.title)}`,
  );
  parts.push(
    `**${severityLabel(finding.severity, lang)}** · ${confidenceLabel(finding.confidence, lang)}`,
  );
  parts.push(finding.body);

  if (finding.suggestion) {
    parts.push(`**${t("suggestionHeading", lang)}**\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``);
  }

  parts.push(
    `<details><summary>${t("evidenceHeading", lang)} · ${t("traceLabel", lang)}: \`${finding.tracePath}\`</summary>\n\n` +
      finding.evidence.map((item) => `- ${renderEvidence(item, lang)}`).join("\n") +
      `\n\n</details>`,
  );

  if (finding.verification) {
    const verdict = finding.verification.refuted
      ? lang === "zh"
        ? "复核模型不认同此结论"
        : "a second model disagreed with this"
      : lang === "zh"
        ? "复核模型认同此结论"
        : "a second model agreed";
    parts.push(`> ${verdict}（${finding.verification.model}）：${finding.verification.note}`);
  }

  return parts.join("\n\n");
}

function renderEvidence(evidence: Evidence, lang: Language): string {
  switch (evidence.kind) {
    case "rule":
      return lang === "zh"
        ? `确定性规则 \`${evidence.ruleId}\` 命中 \`${evidence.path}:${evidence.line}\`：\`${truncate(evidence.excerpt, 120)}\``
        : `deterministic rule \`${evidence.ruleId}\` matched \`${evidence.path}:${evidence.line}\`: \`${truncate(evidence.excerpt, 120)}\``;
    case "static":
      return lang === "zh"
        ? `静态检查 \`${evidence.toolId}\` 在 \`${evidence.path}:${evidence.line}\` 报告：${evidence.diagnostic}`
        : `static check \`${evidence.toolId}\` reported at \`${evidence.path}:${evidence.line}\`: ${evidence.diagnostic}`;
    case "llm":
      return lang === "zh" ? `模型推断：${evidence.reasoning}` : `model reasoning: ${evidence.reasoning}`;
  }
}

function renderAppendix(input: ReportInput): string {
  const { lang, state, redactionStats, budgetEvents, skipped } = input;
  const parts: string[] = [`## ${t("appendixHeading", lang)}`];

  parts.push(
    `### ${t("spendHeading", lang)}\n\n` +
      [
        `| ${lang === "zh" ? "模型" : "Model"} | ${lang === "zh" ? "调用" : "Calls"} | ${lang === "zh" ? "输入 token" : "Input tokens"} | ${lang === "zh" ? "输出 token" : "Output tokens"} | USD |`,
        `| --- | ---: | ---: | ---: | ---: |`,
        ...Object.entries(state.spend.byModel).map(
          ([model, entry]) =>
            `| \`${model}\` | ${entry.calls} | ${entry.inputTokens.toLocaleString()} | ${entry.outputTokens.toLocaleString()} | ${entry.usd.toFixed(4)} |`,
        ),
        `| **${lang === "zh" ? "合计" : "Total"}** | **${state.spend.calls}** | **${state.spend.inputTokens.toLocaleString()}** | **${state.spend.outputTokens.toLocaleString()}** | **${state.spend.usd.toFixed(4)}** |`,
      ].join("\n"),
  );

  if (budgetEvents.length > 0) {
    parts.push(
      `### ${t("budgetEventsHeading", lang)}\n\n` +
        budgetEvents.map((event) => `- \`${event.kind}\` — ${event.detail}`).join("\n"),
    );
  }

  if (skipped.length > 0) {
    parts.push(
      `### ${t("skippedHeading", lang)}\n\n` +
        skipped.map((entry) => `- \`${entry.path}\` — ${skipLabel(entry.reason, lang)}`).join("\n"),
    );
  }

  const redactions = Object.entries(redactionStats);
  if (redactions.length > 0) {
    parts.push(
      `### ${t("redactionHeading", lang)}\n\n${t("redactionNote", lang)}\n\n` +
        redactions.map(([rule, count]) => `- \`${rule}\` × ${count}`).join("\n"),
    );
  }

  parts.push(`---\n\n_${t("generatedBy", lang)} · ${new Date().toISOString()}_`);
  return parts.join("\n\n");
}

/**
 * The body of a single inline PR comment.
 *
 * Deliberately excludes the trace path and the finding id. Both are artifacts of
 * one local run: the trace lives under `~/.code-review/runs/<id>/` on the
 * machine that did the review, and finding ids are assigned per run, so a
 * permanent comment citing `F-001` may point at something else next time.
 * Whoever reads this comment on the PR cannot act on either. The trace stays
 * reachable where it is useful — the report, the TUI, and `code-review trace`.
 */
export function renderComment(finding: Finding, lang: Language, marker: string): string {
  const parts: string[] = [];
  parts.push(
    `${tierGlyph(finding.confidence)} **${escapeMd(finding.title)}** · ${severityLabel(finding.severity, lang)} · ${confidenceLabel(finding.confidence, lang)}`,
  );
  parts.push(finding.body);

  if (finding.suggestion) parts.push("```suggestion\n" + finding.suggestion + "\n```");

  // Machine-checkable evidence is worth showing: it is reproducible by the
  // reader. Model reasoning is not, and is left to the report.
  const machineEvidence = finding.evidence.filter((item) => item.kind !== "llm");
  if (machineEvidence.length > 0) {
    parts.push(machineEvidence.map((item) => `> ${renderEvidence(item, lang)}`).join("\n"));
  }

  parts.push(`<sub>${t("postedComment", lang)}</sub>`);
  parts.push(marker);
  return parts.join("\n\n");
}

/** The review-level comment posted alongside the inline ones. */
export function renderPostSummary(
  input: ReportInput,
  posting: { inline: number; skippedAsDuplicate: number },
  marker: string,
): string {
  const { lang } = input;
  const adoptable = input.findings.filter((f) => f.confidence === "adoptable").length;
  const reference = input.findings.length - adoptable;
  const spend = formatSpend(input);

  const lines =
    lang === "zh"
      ? [
          `## 🔍 code-review 代码评审`,
          renderSummary(input, adoptable, reference),
          `本次回评 ${posting.inline} 条行内评论` +
            (posting.skippedAsDuplicate > 0 ? `，另有 ${posting.skippedAsDuplicate} 条此前已评论过，未重复发布。` : "。"),
          `花费 ${spend}。`,
        ]
      : [
          `## 🔍 code-review`,
          renderSummary(input, adoptable, reference),
          `Posted ${posting.inline} inline comment(s)` +
            (posting.skippedAsDuplicate > 0
              ? `; ${posting.skippedAsDuplicate} were already posted on an earlier run and were not repeated.`
              : "."),
          `Spend: ${spend}.`,
        ];

  if (input.state.hardStopped) lines.push(`> ${t("partialWarning", lang)}`);
  lines.push(marker);
  return lines.join("\n\n");
}

export function formatSpend(input: Pick<ReportInput, "spent" | "limit" | "unit" | "state">): string {
  const core = `${formatBudget(input.spent, input.unit)} / ${formatBudget(input.limit, input.unit)}`;
  // Tokens are what a subscription actually consumes; dollars are what a key
  // is billed. Show the other one in parentheses so neither reader has to convert.
  const aside =
    input.unit === "tokens"
      ? `$${input.state.spend.usd.toFixed(4)} at list price`
      : `${formatTokenCount(input.state.spend.inputTokens + input.state.spend.outputTokens)} tokens`;
  return `${core} (${aside})`;
}

function tierGlyph(confidence: Confidence): string {
  return confidence === "adoptable" ? "●" : "○";
}

function shortUrl(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return url;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Escape only what would break a markdown table cell or heading. */
function escapeMd(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
