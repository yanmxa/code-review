import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineReviewTool, type RawFinding, reviewTool, type SubmitDetails } from "./spec.js";

/**
 * The unit's exit door.
 *
 * Returning `terminate: true` ends the agent loop without another LLM call, so
 * a finished review costs exactly the turns it needed. It also gives us
 * structured findings instead of prose we would have to parse back out.
 */
export const submitFindingsTool = defineReviewTool({
  meta: {
    id: "submit_findings",
    evidenceKind: "llm",
    enabledByDefault: true,
    costHint: "free",
    promptSnippet: "submit_findings — report your findings and end the review of this file.",
  },
  build(context) {
    return reviewTool({
      name: "submit_findings",
      label: "Submit findings",
      description:
        "Report your review findings for this file and finish. Call this exactly once, as your final " +
        "action. Report an empty list if the change is fine — that is a valid and common outcome. " +
        "Only report problems you can point at a specific changed line for.",
      parameters: Type.Object({
        findings: Type.Array(
          Type.Object({
            path: Type.String({ description: "File path the finding is about." }),
            line: Type.Number({
              description: "Line number in the NEW version of the file that the comment anchors to.",
            }),
            endLine: Type.Optional(
              Type.Number({ description: "Last line, for findings spanning a range." }),
            ),
            severity: StringEnum(["blocker", "major", "minor", "nit"], {
              description:
                "blocker: must fix before merge. major: a real bug or risk. minor: worth fixing. nit: style.",
            }),
            title: Type.String({ description: "One short line naming the problem." }),
            body: Type.String({
              description: "Why it is a problem and what to do, in 1-4 sentences. Markdown allowed.",
            }),
            suggestion: Type.Optional(
              Type.String({
                description:
                  "Replacement code for the anchored lines only, if you are confident. No diff markers.",
              }),
            ),
            supportingToolCalls: Type.Array(
              Type.String({ description: "Ids of tool calls whose output supports this finding." }),
              {
                description:
                  "Tool call ids that back this finding. Cite only ids you actually received results " +
                  "from. Findings citing verifiable tool output are graded higher.",
              },
            ),
            reasoning: Type.Optional(
              Type.String({ description: "Short note on how you concluded this." }),
            ),
            // Optional on purpose. Required, a model that simply omitted it
            // failed schema validation and lost the entire submission — every
            // finding for that file, to gain one adjective. Omitting it is read
            // as "unsure", so silence costs the finding its place in the order
            // rather than its existence.
            certainty: Type.Optional(
              StringEnum(["certain", "likely", "unsure"], {
              description:
                "How sure you are that this is really a problem, judged by what could prove you " +
                "wrong. certain: you read the code that would contradict this and it does not — " +
                "anyone re-reading the same code would agree. likely: the diff strongly implies it, " +
                "but you did not check everything that might explain it away. unsure: it could " +
                "equally be deliberate, or accounted for by code you have not read. Most findings " +
                "drawn from a diff alone are `likely` at best; reserve `certain` for the ones you " +
                "actually went and checked. This orders findings for the reader and does not decide " +
                "whether one is presented as directly adoptable, so answering honestly costs you " +
                "nothing — and say in `reasoning` what you could not check.",
              }),
            ),
          }),
        ),
        summary: Type.String({ description: "One sentence on the overall state of this file." }),
      }),
      async execute(_toolCallId, params) {
        const findings = params.findings as RawFinding[];
        context.report?.(`${findings.length} finding(s)`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Recorded ${findings.length} finding(s) for ${context.unit.id}.`,
            },
          ],
          details: { submitted: findings } satisfies SubmitDetails,
          // Nothing useful can follow this; spending another LLM call would be waste.
          terminate: true,
        };
      },
    });
  },
});
