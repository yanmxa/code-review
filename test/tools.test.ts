import { describe, expect, it } from "vitest";
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
