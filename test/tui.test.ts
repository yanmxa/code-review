import { TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Dashboard } from "../src/tui/dashboard.js";
import { budgetGauge } from "../src/tui/theme.js";
import { TraceView } from "../src/tui/trace-view.js";
import { TriagePanel } from "../src/tui/triage.js";
import { clip, spread, windowAround, wrap } from "../src/tui/widgets.js";
import type { Finding, PrSnapshot, ReviewUnit, TraceEvent } from "../src/types.js";
import { FakeTerminal } from "./helpers/fake-terminal.js";
import { createPlainRenderer } from "../src/tui/plain.js";

function snapshot(): PrSnapshot {
  return {
    target: {
      platform: "github",
      owner: "acme",
      repo: "widgets",
      number: 7,
      apiBase: "https://api.github.com",
      webUrl: "https://github.com/acme/widgets/pull/7",
    },
    meta: {
      title: "Add cache eviction so the process stops growing without bound",
      description: "" as PrSnapshot["meta"]["description"],
      author: "dev",
      sourceBranch: "feature/evict",
      targetBranch: "main",
      baseSha: "base000",
      headSha: "head111",
      state: "open",
    },
    diff: "" as PrSnapshot["diff"],
    files: [],
  };
}

function unit(id: string): ReviewUnit {
  return {
    id,
    path: id,
    change: "modified",
    hunks: [],
    additions: 3,
    deletions: 1,
    patch: "" as ReviewUnit["patch"],
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    unitId: "src/cache.ts",
    path: "src/cache.ts",
    line: 42,
    severity: "major",
    title: "Lock is not released on the error path",
    body: "If `parse` throws, `release()` is never reached and every later request blocks forever.",
    evidence: [{ kind: "llm", reasoning: "The try block has no finally." }],
    confidence: "reference",
    fingerprint: "abc1234567",
    tracePath: "traces/src_cache.ts.jsonl",
    source: "agent",
    ...overrides,
  };
}

/** The pi-tui contract: a rendered line must never exceed the width given. */
function assertWithinWidth(lines: string[], width: number): void {
  for (const [index, line] of lines.entries()) {
    expect(
      visibleWidth(line),
      `line ${index} is ${visibleWidth(line)} wide (max ${width}): ${JSON.stringify(line.slice(0, 80))}`,
    ).toBeLessThanOrEqual(width);
  }
}

describe("widgets", () => {
  it("clips to a visible width, ignoring ANSI codes", () => {
    const styled = "[36mhello world[39m";
    expect(visibleWidth(clip(styled, 5))).toBeLessThanOrEqual(5);
  });

  it("pushes the right side flush to the edge", () => {
    const line = spread("left", "right", 20);
    expect(visibleWidth(line)).toBe(20);
    expect(line.endsWith("right")).toBe(true);
  });

  it("yields the left side first when space runs out", () => {
    expect(visibleWidth(spread("a very long left side", "right", 12))).toBeLessThanOrEqual(12);
  });

  it("wraps prose without exceeding the width", () => {
    const lines = wrap("the quick brown fox jumps over the lazy dog", 12);
    assertWithinWidth(lines, 12);
    expect(lines.length).toBeGreaterThan(1);
  });

  it("hard-splits a word longer than the line", () => {
    assertWithinWidth(wrap("supercalifragilisticexpialidocious", 10), 10);
  });

  it("wraps CJK prose without losing or duplicating glyphs", () => {
    // Regression: the hard-split path advanced by column count while slicing by
    // character index. A CJK glyph is two columns wide, so every wrap point
    // dropped half the characters — visible as `**bold**` markers being torn
    // apart in the findings detail pane.
    const text = "这一行被密钥扫描器判定为疑似凭据，内容已在传给模型前脱敏。请从代码中移除，改用密钥管理服务，并轮换该凭据。";
    const lines = wrap(text, 24);
    assertWithinWidth(lines, 24);
    expect(lines.join("")).toBe(text);
  });

  it("wraps mixed CJK and ASCII without losing glyphs", () => {
    const text = "规则 secret-in-diff 命中 demo/src/config.ts:4 —— 请轮换该凭据并从代码中移除它";
    const lines = wrap(text, 20);
    assertWithinWidth(lines, 20);
    // Where a break lands (inside a CJK run or at a space) is a layout choice;
    // what must hold is that every glyph survives exactly once.
    const strip = (s: string) => s.replace(/\s+/g, "");
    expect(strip(lines.join(""))).toBe(strip(text));
  });

  it("never loops forever on a glyph wider than the line", () => {
    expect(wrap("宽", 1)).toEqual(["宽"]);
  });

  it("keeps the selection inside the window", () => {
    expect(windowAround(100, 0, 10)).toEqual({ start: 0, end: 10 });
    expect(windowAround(100, 99, 10)).toEqual({ start: 90, end: 100 });
    expect(windowAround(5, 3, 10)).toEqual({ start: 0, end: 5 });
    const middle = windowAround(100, 50, 10);
    expect(middle.start).toBeLessThanOrEqual(50);
    expect(middle.end).toBeGreaterThan(50);
  });
});

describe("budget gauge", () => {
  it("fills proportionally", () => {
    expect(visibleWidth(budgetGauge(0))).toBe(10);
    expect(visibleWidth(budgetGauge(0.5))).toBe(10);
    expect(visibleWidth(budgetGauge(1))).toBe(10);
    expect(budgetGauge(0).includes("▰")).toBe(false);
    expect(budgetGauge(1).includes("▱")).toBe(false);
  });

  it("changes colour at the downgrade thresholds", () => {
    // The gauge turning yellow is the same event as the model getting cheaper.
    expect(budgetGauge(0.4)).not.toBe(budgetGauge(0.6));
    expect(budgetGauge(0.6)).not.toBe(budgetGauge(0.9));
  });
});

describe("Dashboard", () => {
  function mount(columns = 100, rows = 30) {
    const terminal = new FakeTerminal(columns, rows);
    const tui = new TuiAltScreen(terminal);
    return { tui, dashboard: new Dashboard(tui, "en", 10) };
  }

  it("renders before any event arrives", () => {
    const { dashboard } = mount();
    const lines = dashboard.render(100);
    assertWithinWidth(lines, 100);
    expect(lines.join("\n")).toContain("code-review");
  });

  it("shows the PR, the file list, and the budget once a run starts", () => {
    const { dashboard } = mount();
    dashboard.handle({
      type: "run_start",
      snapshot: snapshot(),
      units: [unit("src/cache.ts"), unit("src/config.ts")],
      resumed: false,
      model: { provider: "openai", id: "gpt-5.4" },
    });
    const text = dashboard.render(100).join("\n");
    expect(text).toContain("acme/widgets");
    expect(text).toContain("#7");
    expect(text).toContain("src/cache.ts");
    expect(text).toContain("openai/gpt-5.4");
    expect(text).toContain("¥0.00/¥10.00");
  });

  it("marks a resumed run so the user knows work was skipped", () => {
    const { dashboard } = mount();
    dashboard.handle({
      type: "run_start",
      snapshot: snapshot(),
      units: [unit("a.ts")],
      resumed: true,
      model: { provider: "openai", id: "gpt-5.4" },
    });
    expect(dashboard.render(100).join("\n")).toContain("resumed");
  });

  it("reflects unit progress and skip reasons", () => {
    const { dashboard } = mount();
    dashboard.handle({
      type: "run_start",
      snapshot: snapshot(),
      units: [unit("a.ts"), unit("b.ts")],
      resumed: false,
      model: { provider: "openai", id: "gpt-5.4" },
    });
    dashboard.handle({ type: "unit_end", unitId: "a.ts", status: "done", findings: 2 });
    dashboard.handle({
      type: "unit_end",
      unitId: "b.ts",
      status: "skipped",
      findings: 0,
      skipReason: "generated",
    });
    const text = dashboard.render(100).join("\n");
    expect(text).toContain("generated");
    expect(text).toMatch(/1\/2|2\/2/);
  });

  it("surfaces a budget downgrade", () => {
    const { dashboard } = mount();
    dashboard.handle({
      type: "budget",
      kind: "downgrade",
      detail: "openai/gpt-5.4 → openai/gpt-5.4-mini at 51%",
    });
    expect(dashboard.render(100).join("\n")).toContain("downgrade");
  });

  it("stays within width at every terminal size", () => {
    for (const columns of [60, 80, 100, 140, 200]) {
      const { dashboard } = mount(columns, 24);
      dashboard.handle({
        type: "run_start",
        snapshot: snapshot(),
        units: [unit("src/very/deeply/nested/path/to/a/file/with/a/long/name.ts")],
        resumed: true,
        model: { provider: "openai", id: "gpt-5.4" },
      });
      dashboard.handle({ type: "unit_start", index: 1, unitId: "src/very/deeply/nested/path/to/a/file/with/a/long/name.ts" });
      dashboard.handle({
        type: "tool_start",
        unitId: "x",
        name: "get_file",
        summary: "src/very/deeply/nested/path/to/a/file/with/a/long/name.ts",
      });
      dashboard.handle({ type: "stream_delta", unitId: "x", text: "reasoning ".repeat(80) });
      dashboard.handle({ type: "finding", finding: finding() });
      dashboard.handle({
        type: "spend",
        ledger: {
          usd: 1.2,
          inputTokens: 128_000,
          outputTokens: 9_000,
          cacheReadTokens: 41_000,
          calls: 12,
          byModel: {},
        },
        fraction: 0.87,
        model: { provider: "openai", id: "gpt-5.4-nano" },
        unit: "CNY",
        limit: 10,
        spent: 8.7,
        projected: 12.4,
      });
      assertWithinWidth(dashboard.render(columns), columns);
    }
  });

  it("survives a terminal too narrow to be useful", () => {
    const { dashboard } = mount(20, 10);
    assertWithinWidth(dashboard.render(20), 20);
  });
});

describe("TriagePanel", () => {
  function mount(findings: Finding[]) {
    const terminal = new FakeTerminal(120, 30);
    const tui = new TuiAltScreen(terminal);
    const panel = new TriagePanel(tui, findings, "en", 3.4, 10, "CNY", [], {
      onPost: async () => {},
      onTrace: () => {},
      onQuit: () => {},
    });
    return { panel, terminal };
  }

  it("groups findings by confidence", () => {
    const { panel } = mount([
      finding({ confidence: "adoptable", title: "Credential committed", fingerprint: "aaa" }),
      finding({ confidence: "reference", title: "Consider a comment", fingerprint: "bbb" }),
    ]);
    const text = panel.render(120).join("\n");
    expect(text).toContain("ADOPTABLE (1)");
    expect(text).toContain("REFERENCE (1)");
  });

  it("pre-selects adoptable findings so posting them is one keypress", () => {
    const { panel } = mount([
      finding({ confidence: "adoptable", fingerprint: "aaa" }),
      finding({ confidence: "reference", fingerprint: "bbb" }),
    ]);
    expect(panel.selectedFindings.map((f) => f.fingerprint)).toEqual(["aaa"]);
  });

  it("toggles a selection with space", () => {
    const { panel } = mount([finding({ confidence: "reference", fingerprint: "bbb" })]);
    expect(panel.selectedFindings).toHaveLength(0);
    panel.handleInput(" ");
    expect(panel.selectedFindings).toHaveLength(1);
    panel.handleInput(" ");
    expect(panel.selectedFindings).toHaveLength(0);
  });

  it("selects everything with A and clears with n", () => {
    const { panel } = mount([
      finding({ confidence: "adoptable", fingerprint: "aaa" }),
      finding({ confidence: "reference", fingerprint: "bbb" }),
    ]);
    panel.handleInput("A");
    expect(panel.selectedFindings).toHaveLength(2);
    panel.handleInput("n");
    expect(panel.selectedFindings).toHaveLength(0);
  });

  it("skips group headers when moving the cursor", () => {
    const { panel } = mount([
      finding({ confidence: "adoptable", title: "First", fingerprint: "aaa" }),
      finding({ confidence: "reference", title: "Second", fingerprint: "bbb" }),
    ]);
    panel.handleInput("j");
    // Landing on a header would show an empty detail pane.
    expect(panel.render(120).join("\n")).toContain("Second");
  });

  it("shows the evidence behind the selected finding", () => {
    const { panel } = mount([
      finding({
        confidence: "adoptable",
        evidence: [
          { kind: "rule", ruleId: "secret-in-diff", path: "src/config.ts", line: 3, excerpt: "key = ..." },
        ],
      }),
    ]);
    const text = panel.render(120).join("\n");
    expect(text).toContain("secret-in-diff");
    expect(text).toContain("traces/");
  });

  it("stays within width at every terminal size", () => {
    for (const columns of [60, 80, 120, 200]) {
      const { panel } = mount([
        finding({ confidence: "adoptable", fingerprint: "aaa" }),
        finding({ confidence: "reference", fingerprint: "bbb", title: "A ".repeat(60) }),
      ]);
      assertWithinWidth(panel.render(columns), columns);
    }
  });
});

describe("TraceView", () => {
  const events: TraceEvent[] = [
    { ts: "2026-08-08T10:00:00.000Z", seq: 0, type: "unit_start", unitId: "src/cache.ts", model: "openai/gpt-5.4", patchSha: "abcd1234" },
    {
      ts: "2026-08-08T10:00:01.000Z",
      seq: 1,
      type: "llm_request",
      model: "openai/gpt-5.4",
      systemPrompt: "You are a precise, senior code reviewer.",
      messages: [{ role: "user", content: "review this" }],
      toolNames: ["get_file", "submit_findings"],
    },
    {
      ts: "2026-08-08T10:00:04.000Z",
      seq: 2,
      type: "llm_response",
      model: "openai/gpt-5.4",
      stopReason: "toolUse",
      content: [{ type: "text", text: "checking the lock" }],
      usage: { input: 3200, output: 180, cacheRead: 0, costUsd: 0.0074 },
    },
    { ts: "2026-08-08T10:00:05.000Z", seq: 3, type: "budget", kind: "downgrade", detail: "to mini at 51%" },
  ];

  function mount(columns = 100) {
    const tui = new TuiAltScreen(new FakeTerminal(columns, 30));
    return new TraceView(tui, events, "F-001 · traces/src_cache.ts.jsonl", "en", () => {});
  }

  it("shows one line per event with cost", () => {
    const text = mount().render(100).join("\n");
    expect(text).toContain("unit");
    expect(text).toContain("llm");
    expect(text).toContain("$0.0074");
    expect(text).toContain("downgrade");
  });

  it("expands the full prompt on demand", () => {
    const view = mount();
    expect(view.render(100).join("\n")).not.toContain("senior code reviewer");
    view.handleInput("j");
    view.handleInput("\r");
    expect(view.render(100).join("\n")).toContain("senior code reviewer");
  });

  it("stays within width at every terminal size", () => {
    for (const columns of [60, 80, 100, 160]) {
      const view = mount(columns);
      view.handleInput("j");
      view.handleInput("\r");
      assertWithinWidth(view.render(columns), columns);
    }
  });
});

describe("the plain renderer's progress counter", () => {
  it("keeps its place across a resume", () => {
    // A locally-incremented counter restarted at 1 on a resumed run, so the
    // third file announced itself as "[1/4]".
    const lines: string[] = [];
    const render = createPlainRenderer({ lang: "en", write: (line: string) => lines.push(line) });
    render({ type: "unit_start", unitId: "c.ts", index: 3 });
    expect(lines.join("\n")).toContain("[3/");
  });
})
