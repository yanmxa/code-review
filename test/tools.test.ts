import { describe, expect, it } from "vitest";
import { buildUnitPrompt, SYSTEM_PROMPT } from "../src/engine/prompts.js";
import { selectTools, TOOL_REGISTRY } from "../src/tools/index.js";
import { typecheckInMemory } from "../src/tools/ts-syntax-check.js";
import { Redactor } from "../src/security/redactor.js";
import type { ToolContext } from "../src/tools/spec.js";
import { FakePlatform, SAMPLE_DIFF, TEST_TARGET } from "./helpers/fake-platform.js";
import { parseUnifiedDiff } from "../src/platform/diff.js";
import { planUnits } from "../src/engine/units.js";

async function context(files: Record<string, string> = {}): Promise<ToolContext> {
  const adapter = new FakePlatform(SAMPLE_DIFF, files);
  const snapshot = await adapter.fetchPr(TEST_TARGET);
  const { units } = planUnits(snapshot.files, 600);
  return {
    adapter,
    snapshot,
    unit: units[0]!,
    redactor: new Redactor(),
    fileContextLines: 2000,
  };
}

describe("tool registry", () => {
  it("declares metadata every consumer needs", () => {
    for (const spec of TOOL_REGISTRY) {
      expect(spec.meta.id, "each tool needs a stable id").toBeTruthy();
      expect(["rule", "static", "llm"]).toContain(spec.meta.evidenceKind);
      expect(spec.meta.promptSnippet, `${spec.meta.id} needs a prompt snippet`).toBeTruthy();
    }
  });

  it("has unique tool ids", () => {
    const ids = TOOL_REGISTRY.map((spec) => spec.meta.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds the enabled tools and their prompt lines together", async () => {
    const selection = selectTools(await context(), "github");
    expect(selection.tools.map((tool) => tool.name)).toContain("submit_findings");
    // The system prompt's tool list is generated, never hand-maintained.
    expect(selection.promptSnippets).toHaveLength(selection.tools.length);
  });

  it("exposes each tool's evidence weight to the grader", async () => {
    const selection = selectTools(await context(), "github");
    expect(selection.evidenceKinds.get("ts_syntax_check")).toBe("static");
    expect(selection.evidenceKinds.get("get_file")).toBe("llm");
  });

  it("lets config disable a tool without touching the pipeline", async () => {
    const selection = selectTools(await context(), "github", { ts_syntax_check: false });
    expect(selection.tools.map((tool) => tool.name)).not.toContain("ts_syntax_check");
    expect(selection.promptSnippets.join()).not.toContain("ts_syntax_check");
  });

  it("ignores unknown ids in config so a stale file cannot break a run", async () => {
    const selection = selectTools(await context(), "github", { no_such_tool: false });
    expect(selection.tools.length).toBe(TOOL_REGISTRY.length);
  });
});

describe("get_file", () => {
  it("returns line-numbered content", async () => {
    const ctx = await context({ "src/cache.ts": "line one\nline two\nline three" });
    const tool = TOOL_REGISTRY.find((spec) => spec.meta.id === "get_file")!.build(ctx);
    const result = await tool.execute("call_1", { path: "src/cache.ts" } as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("    1  line one");
    expect(text).toContain("    3  line three");
  });

  it("reports a missing file rather than throwing", async () => {
    const ctx = await context();
    const tool = TOOL_REGISTRY.find((spec) => spec.meta.id === "get_file")!.build(ctx);
    const result = await tool.execute("call_1", { path: "nope.ts" } as never);
    expect(result.details).toMatchObject({ found: false });
  });

  it("masks secrets before the model sees the file", async () => {
    const ctx = await context({ "src/cache.ts": `const key = "AKIAIOSFODNN7EXAMPLE";` });
    const tool = TOOL_REGISTRY.find((spec) => spec.meta.id === "get_file")!.build(ctx);
    const result = await tool.execute("call_1", { path: "src/cache.ts" } as never);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("[REDACTED:");
  });
});

describe("search_diff", () => {
  it("finds changed lines matching a pattern", async () => {
    const ctx = await context();
    const tool = TOOL_REGISTRY.find((spec) => spec.meta.id === "search_diff")!.build(ctx);
    const result = await tool.execute("call_1", { pattern: "console\\.log" } as never);
    expect(result.details).toMatchObject({ count: 1 });
  });

  it("rejects an invalid regular expression with a usable message", async () => {
    const ctx = await context();
    const tool = TOOL_REGISTRY.find((spec) => spec.meta.id === "search_diff")!.build(ctx);
    await expect(tool.execute("call_1", { pattern: "([" } as never)).rejects.toThrow(/Invalid regular expression/);
  });
});

describe("ts_syntax_check", () => {
  it("reports a syntax error with its line", () => {
    const diagnostics = typecheckInMemory("a.ts", "export function f( {\n  return 1;\n}\n");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.line).toBeGreaterThan(0);
    expect(diagnostics[0]?.code).toBeGreaterThan(0);
  });

  it("reports a self-contained type error", () => {
    const diagnostics = typecheckInMemory("a.ts", "const n: number = 1;\nconst s: string = n;\n");
    expect(diagnostics.some((d) => d.line === 2)).toBe(true);
  });

  it("stays quiet on correct code", () => {
    expect(typecheckInMemory("a.ts", "export const add = (a: number, b: number): number => a + b;\n")).toEqual([]);
  });

  it("suppresses diagnostics that only mean the project was not loaded", () => {
    // We deliberately do not resolve imports, so "cannot find module" is noise
    // indistinguishable from a real finding and must never be reported.
    const diagnostics = typecheckInMemory(
      "a.ts",
      `import { helper } from "./helper.js";\nexport const x = helper(1);\n`,
    );
    expect(diagnostics.map((d) => d.code)).not.toContain(2307);
  });

  it("handles TSX", () => {
    expect(() => typecheckInMemory("a.tsx", "export const C = () => <div>hi</div>;\n")).not.toThrow();
  });

  it("never executes the code it is given", () => {
    // The compiler parses text as data. If it evaluated anything, this would
    // throw or write a file; it does neither.
    const hostile = `throw new Error("should not run");\nrequire("node:fs").writeFileSync("/tmp/pwned", "x");\n`;
    expect(() => typecheckInMemory("a.ts", hostile)).not.toThrow();
  });
});

describe("reviewer prompt — a project can steer it", () => {
  it("carries the project's focus into the instructions", () => {
    const prompt = SYSTEM_PROMPT(["a — b"], "en", {
      focus: "This is a Go service; unwrapped errors are the thing we care about.",
      ignore: [],
    });
    expect(prompt).toContain("unwrapped errors");
  });

  it("names settled topics the reviewer must not reopen", () => {
    const prompt = SYSTEM_PROMPT(["a — b"], "en", { ignore: ["naming", "comment style"] });
    expect(prompt).toContain("naming");
    expect(prompt).toContain("comment style");
    expect(prompt).toMatch(/do not raise/i);
  });

  it("adds nothing when the project said nothing", () => {
    const bare = SYSTEM_PROMPT(["a — b"], "en");
    expect(bare).not.toMatch(/do not raise/i);
    expect(bare).not.toContain("What this project cares about");
  });
});

describe("unit prompt — CI is given as fact", () => {
  function unitOf(path: string) {
    return {
      id: path,
      path,
      change: "modified" as const,
      hunks: [],
      additions: 3,
      deletions: 0,
      patch: "@@ -1 +1 @@\n+x" as never,
    };
  }

  it("hands the model the failing checks and their diagnostics for this file", async () => {
    const adapter = new FakePlatform(SAMPLE_DIFF);
    const snapshot = await adapter.fetchPr(TEST_TARGET);
    const prompt = buildUnitPrompt(unitOf("src/cache.ts"), [], snapshot, "en", {
      conclusion: "failure",
      failed: [{ name: "vitest", summary: "1 failing" }],
      annotations: [
        { path: "src/cache.ts", line: 12, level: "failure", message: "expected b, got a" },
        { path: "src/other.ts", line: 3, level: "failure", message: "unrelated" },
      ],
    });

    expect(prompt).toContain("vitest");
    expect(prompt).toContain("expected b, got a");
    // A diagnostic about another file would invite the model to blame this one.
    expect(prompt).not.toContain("unrelated");
  });

  it("says so plainly when nothing points at this file", async () => {
    const adapter = new FakePlatform(SAMPLE_DIFF);
    const snapshot = await adapter.fetchPr(TEST_TARGET);
    const prompt = buildUnitPrompt(unitOf("src/cache.ts"), [], snapshot, "en", {
      conclusion: "failure",
      failed: [{ name: "vitest" }],
      annotations: [],
    });
    expect(prompt).toMatch(/Do not assume the failure is caused here/i);
  });

  it("stays silent when CI is green", async () => {
    const adapter = new FakePlatform(SAMPLE_DIFF);
    const snapshot = await adapter.fetchPr(TEST_TARGET);
    const prompt = buildUnitPrompt(unitOf("src/cache.ts"), [], snapshot, "en", {
      conclusion: "success",
      failed: [],
      annotations: [],
    });
    expect(prompt).not.toContain("Continuous integration");
  });
});
