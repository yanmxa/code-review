import { createHash } from "node:crypto";
import { commentableLines, snapToCommentable } from "../platform/diff.js";
import type { EvidenceKind } from "../tools/spec.js";
import type { RawFinding } from "../tools/spec.js";
import type { Certainty, Confidence, Evidence, Finding, ReviewUnit, Severity } from "../types.js";
import type { RuleHit } from "./rules-engine.js";

/** How far from a rule/static hit a finding may sit and still claim its evidence. */
export const EVIDENCE_LINE_TOLERANCE = 3;

export interface GradeContext {
  unit: ReviewUnit;
  tracePath: string;
  /** toolCallId -> tool name, from the agent run. */
  toolCallNames: Map<string, string>;
  /** tool name -> what its output is worth as evidence. */
  evidenceKinds: Map<string, EvidenceKind>;
  /** Static diagnostics observed during the unit, keyed by "path:line". */
  staticHits: { toolId: string; path: string; line: number; diagnostic: string }[];
}

/**
 * Turn a rule hit into a finding.
 *
 * These start life adoptable: the evidence *is* the finding, and anyone can
 * re-derive it from the diff.
 */
export function findingFromRule(hit: RuleHit, unit: ReviewUnit, tracePath: string): Finding {
  const evidence: Evidence[] = [
    { kind: "rule", ruleId: hit.ruleId, path: hit.path, line: hit.line, excerpt: hit.excerpt },
  ];
  return {
    id: "",
    unitId: unit.id,
    path: hit.path,
    line: hit.line,
    severity: hit.severity,
    title: hit.title,
    body: hit.body,
    evidence,
    confidence: "adoptable",
    fingerprint: fingerprint(hit.path, hit.title, hit.line),
    tracePath,
    source: "rule",
  };
}

/**
 * Turn a model-reported finding into a graded one, or drop it.
 *
 * Two gates, both of which throw away work on purpose:
 *  - the anchor must land on a line the diff touches, or the comment could never
 *    be posted and probably refers to code the PR did not change;
 *  - cited tool call ids must exist. A model that invents an id to look
 *    well-supported gets that citation removed, not rewarded.
 */
export function gradeAgentFinding(raw: RawFinding, context: GradeContext): Finding | null {
  const commentable = commentableLines(context.unit.hunks);
  const line = snapToCommentable(Math.round(raw.line), commentable, EVIDENCE_LINE_TOLERANCE);
  if (line === null) return null;

  const path = raw.path?.trim() || context.unit.path;
  const evidence: Evidence[] = [];

  for (const toolCallId of raw.supportingToolCalls ?? []) {
    const toolName = context.toolCallNames.get(toolCallId);
    if (!toolName) continue; // Fabricated or stale id — silently dropped.
    const kind = context.evidenceKinds.get(toolName);
    if (kind !== "static") continue; // Only verifiable output becomes evidence.

    const match = context.staticHits.find(
      (hit) => hit.path === path && Math.abs(hit.line - line) <= EVIDENCE_LINE_TOLERANCE,
    );
    if (match) {
      evidence.push({
        kind: "static",
        toolId: match.toolId,
        diagnostic: match.diagnostic,
        path: match.path,
        line: match.line,
      });
    }
  }

  // Deliberately absent: promotion because a rule happened to fire nearby.
  // Proximity is not corroboration — a `console.log` rule hit on line 13 says
  // nothing about whether the model's claim about eviction order on line 13 is
  // true, and promoting on location alone would make the tier meaningless. Rule
  // hits already produce their own adoptable findings, and the prompt tells the
  // model not to restate them, so a model finding on the same line is by
  // construction a different claim.

  if (raw.reasoning) evidence.push({ kind: "llm", reasoning: raw.reasoning });

  const finding: Finding = {
    id: "",
    unitId: context.unit.id,
    path,
    line,
    severity: normalizeSeverity(raw.severity),
    title: raw.title.trim(),
    body: raw.body.trim(),
    evidence,
    confidence: confidenceOf(evidence),
    fingerprint: fingerprint(path, raw.title, line),
    tracePath: context.tracePath,
    source: "agent",
  };
  finding.certainty = normalizeCertainty(raw.certainty);
  if (raw.endLine !== undefined && raw.endLine > line) finding.endLine = Math.round(raw.endLine);
  if (raw.suggestion?.trim()) finding.suggestion = raw.suggestion.trim();
  return finding;
}

/**
 * Read back the model's own certainty, defaulting to the cautious end.
 *
 * A missing or unrecognised value means the model did not commit to one, and
 * the honest reading of that is "unsure" rather than a free pass — the field
 * is where it says how much to trust it, so silence is not a strong claim.
 */
export function normalizeCertainty(value: string | undefined): Certainty {
  return value === "certain" || value === "likely" ? value : "unsure";
}

/**
 * The grading rule, stated once.
 *
 * Adoptable requires machine-checkable evidence. Model confidence, however
 * emphatic, is not evidence — that distinction is the entire point of the tier.
 */
export function confidenceOf(evidence: Evidence[]): Confidence {
  return evidence.some((item) => item.kind === "rule" || item.kind === "static")
    ? "adoptable"
    : "reference";
}

/**
 * Merge findings that describe the same problem.
 *
 * The common case is a rule and the model both flagging one line: the reader
 * should see one finding with both kinds of evidence, not two that disagree
 * about tier.
 */
export function dedupe(findings: Finding[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();

  for (const finding of findings) {
    const existing = byFingerprint.get(finding.fingerprint);
    if (!existing) {
      byFingerprint.set(finding.fingerprint, { ...finding });
      continue;
    }
    const merged: Finding = {
      ...existing,
      // Keep the more urgent severity and the richer explanation.
      severity: moreSevere(existing.severity, finding.severity),
      body: existing.body.length >= finding.body.length ? existing.body : finding.body,
      evidence: [...existing.evidence, ...finding.evidence],
      source: existing.source === finding.source ? existing.source : "merged",
    };
    if (!merged.suggestion && finding.suggestion) merged.suggestion = finding.suggestion;
    merged.certainty =
      certaintyRank(existing.certainty) <= certaintyRank(finding.certainty)
        ? existing.certainty
        : finding.certainty;
    merged.confidence = confidenceOf(merged.evidence);
    byFingerprint.set(finding.fingerprint, merged);
  }

  const out = [...byFingerprint.values()];
  out.sort(
    (a, b) =>
      tierRank(a.confidence) - tierRank(b.confidence) ||
      severityRank(a.severity) - severityRank(b.severity) ||
      // Among equally serious claims, the one the model could actually confirm
      // is worth reading first. This only ever reorders within a tier: the tier
      // itself is decided by evidence, and self-assessment is not evidence.
      certaintyRank(a.certainty) - certaintyRank(b.certainty) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
  out.forEach((finding, index) => {
    finding.id = `F-${String(index + 1).padStart(3, "0")}`;
  });
  return out;
}

/**
 * Identity of a finding.
 *
 * Line numbers are bucketed by 5 so a re-run whose model anchors one line off
 * still recognizes its own previous comment and does not post a duplicate.
 */
export function fingerprint(path: string, title: string, line: number): string {
  const normalizedTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .trim();
  return createHash("sha256")
    .update(`${path}|${normalizedTitle}|${Math.floor(line / 5)}`)
    .digest("hex")
    .slice(0, 10);
}

const SEVERITY_ORDER: Severity[] = ["blocker", "major", "minor", "nit"];

function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** Rules are deterministic, so a finding with no stated certainty ranks as certain. */
function certaintyRank(certainty: Certainty | undefined): number {
  return certainty === undefined || certainty === "certain" ? 0 : certainty === "likely" ? 1 : 2;
}

function tierRank(confidence: Confidence): number {
  return confidence === "adoptable" ? 0 : 1;
}

function moreSevere(a: Severity, b: Severity): Severity {
  return severityRank(a) <= severityRank(b) ? a : b;
}

function normalizeSeverity(value: string): Severity {
  const lowered = value?.toLowerCase();
  return (SEVERITY_ORDER as string[]).includes(lowered) ? (lowered as Severity) : "minor";
}
