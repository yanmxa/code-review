import { describe, expect, it } from "vitest";
import { dedupe, gradeAgentFinding } from "../src/engine/grade.js";
import type { EvidenceKind } from "../src/tools/spec.js";
import type { ReviewUnit } from "../src/types.js";

const unit: ReviewUnit = {
  id: "a.ts",
  path: "a.ts",
  change: "modified",
  additions: 1,
  deletions: 0,
  patch: "" as never,
  hunks: [
    {
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 2,
      header: "@@ -1 +1,2 @@",
      lines: [
        { kind: "context", oldLine: 1, newLine: 1, text: "a" },
        { kind: "add", newLine: 2, text: "b" },
      ],
    },
  ],
};

const context = {
  unit,
  tracePath: "traces/a.ts.jsonl",
  toolCallNames: new Map<string, string>(),
  evidenceKinds: new Map<string, EvidenceKind>(),
  staticHits: [],
};

const raw = { path: "a.ts", line: 2, severity: "major", title: "T", body: "B" };

describe("the model's own certainty", () => {
  it("reads back what the model said", () => {
    expect(gradeAgentFinding({ ...raw, certainty: "likely" }, context)?.certainty).toBe("likely");
  });

  it("treats a missing or unrecognised value as unsure", () => {
    // The field is where the model says how much to trust it, so silence there
    // is not a strong claim.
    expect(gradeAgentFinding(raw, context)?.certainty).toBe("unsure");
    expect(gradeAgentFinding({ ...raw, certainty: "very" }, context)?.certainty).toBe("unsure");
  });

  it("never promotes a finding out of the reference tier", () => {
    // The entire point of the tiers: evidence decides what is adoptable, and a
    // model's opinion of its own work is not evidence however emphatic.
    expect(gradeAgentFinding({ ...raw, certainty: "certain" }, context)?.confidence).toBe("reference");
  });

  it("orders equally severe findings by how sure the model is", () => {
    const make = (title: string, certainty: string) =>
      gradeAgentFinding({ ...raw, title, certainty }, context)!;
    const out = dedupe([make("U", "unsure"), make("C", "certain"), make("L", "likely")]);
    expect(out.map((finding) => finding.title)).toEqual(["C", "L", "U"]);
  });

  it("lets severity outrank it, because blocking the merge is the bigger question", () => {
    const nit = gradeAgentFinding({ ...raw, title: "N", severity: "nit", certainty: "certain" }, context)!;
    const blocker = gradeAgentFinding(
      { ...raw, title: "B", severity: "blocker", certainty: "unsure" },
      context,
    )!;
    expect(dedupe([nit, blocker]).map((finding) => finding.title)).toEqual(["B", "N"]);
  });
});
