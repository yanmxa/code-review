import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/platform/diff.js";
import { Redactor } from "../src/security/redactor.js";
import { planUnits } from "../src/engine/units.js";
import { hasMatchingTestChange, isTestPath, runRules, stemOf } from "../src/engine/rules-engine.js";
import type { ReviewUnit } from "../src/types.js";

/** Build a one-file unit whose added lines are exactly `added`. */
function unitWith(path: string, added: string[], context: string[] = []): ReviewUnit {
  const body = [...context.map((line) => ` ${line}`), ...added.map((line) => `+${line}`)];
  const diff =
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
    `@@ -1,${context.length} +1,${body.length} @@\n${body.join("\n")}\n`;
  const files = parseUnifiedDiff(new Redactor().redact(diff));
  const { units } = planUnits(files, 600);
  return units[0] as ReviewUnit;
}

function ruleIds(path: string, added: string[]): string[] {
  return runRules(unitWith(path, added), "en").map((hit) => hit.ruleId);
}

describe("rules — fire on real defects", () => {
  it("flags a committed credential", () => {
    // The redactor masks the value first; the placeholder on an added line is
    // itself the proof that a credential was committed.
    const ids = ruleIds("src/config.ts", [`  awsAccessKeyId: "AKIAIOSFODNN7EXAMPLE",`]);
    expect(ids).toContain("secret-in-diff");
  });

  it("flags a leftover debugger", () => {
    expect(ruleIds("src/a.ts", ["    debugger;"])).toContain("leftover-debugger");
  });

  it("flags new console logging", () => {
    expect(ruleIds("src/a.ts", ['    console.log("cache set", key);'])).toContain("console-log");
  });

  it("flags loose equality", () => {
    expect(ruleIds("src/a.ts", ["  return sessions.find((s) => s.id == id);"])).toContain("loose-equality");
  });

  it("flags a swallowed exception", () => {
    expect(ruleIds("src/a.ts", ["  } catch (e) {}"])).toContain("swallowed-error");
    expect(ruleIds("src/a.py", ["    except ValueError: pass"])).toContain("swallowed-error");
  });

  it("flags SQL built by concatenation", () => {
    // Regression: the original pattern excluded quote characters, so it could
    // never match the concatenation it was written to catch.
    const ids = ruleIds("src/db.ts", [
      `    return await db.query("SELECT * FROM sessions WHERE user_id = '" + userId + "'");`,
    ]);
    expect(ids).toContain("sql-string-concat");
  });

  it("flags SQL built from a template literal", () => {
    expect(ruleIds("src/db.ts", ["  db.query(`SELECT * FROM users WHERE id = ${id}`);"])).toContain(
      "sql-string-concat",
    );
  });

  it("flags SQL built with python string formatting", () => {
    expect(ruleIds("src/db.py", ['    cur.execute("SELECT * FROM t WHERE a = %s" % value)'])).toContain(
      "sql-string-concat",
    );
  });

  it("flags Math.random used to mint an identifier", () => {
    // Regression: the credential word usually sits on the function signature,
    // not the line with the call, so the same-line-only pattern never matched.
    const ids = ruleIds("src/session.ts", [
      "  return Math.random().toString(36).slice(2) + Date.now().toString(36);",
    ]);
    expect(ids).toContain("insecure-random");
  });

  it("flags Math.random named as a token on the same line", () => {
    expect(ruleIds("src/a.ts", ["  const token = Math.random();"])).toContain("insecure-random");
  });

  it("flags disabled TLS verification", () => {
    expect(ruleIds("src/http.ts", ["  const agent = new https.Agent({ rejectUnauthorized: false });"])).toContain(
      "disabled-tls-verification",
    );
    expect(ruleIds("src/http.py", ["    requests.get(url, verify=False)"])).toContain(
      "disabled-tls-verification",
    );
  });

  it("flags shell interpolation", () => {
    expect(ruleIds("src/run.ts", ["  exec(`git checkout ${branch}`);"])).toContain("shell-injection");
  });

  it("flags a new TODO", () => {
    expect(ruleIds("src/a.ts", ["  // TODO: handle the empty case"])).toContain("todo-added");
  });
});

describe("rules — stay quiet on correct code", () => {
  it("leaves `== null` alone", () => {
    expect(ruleIds("src/a.ts", ["  if (value == null) return;"])).not.toContain("loose-equality");
  });

  it("leaves parameterized SQL alone", () => {
    const ids = ruleIds("src/db.ts", [
      `    return db.query("SELECT * FROM sessions WHERE user_id = $1", [userId]);`,
    ]);
    expect(ids).not.toContain("sql-string-concat");
  });

  it("leaves a SQL keyword in a comment alone", () => {
    expect(ruleIds("src/db.ts", ["  // SELECT is handled by the ORM + the cache layer"])).not.toContain(
      "sql-string-concat",
    );
  });

  it("leaves Math.random used for jitter alone", () => {
    expect(
      ruleIds("src/retry.ts", ["  const jitter = Math.random() * 100;"]),
    ).not.toContain("insecure-random");
  });

  it("leaves plain Math.random alone", () => {
    expect(ruleIds("src/game.ts", ["  const roll = Math.floor(Math.random() * 6) + 1;"])).not.toContain(
      "insecure-random",
    );
  });

  it("leaves a caught-and-logged exception alone", () => {
    expect(ruleIds("src/a.ts", ["  } catch (e) { log.error(e); }"])).not.toContain("swallowed-error");
  });

  it("does not apply JS rules to other languages", () => {
    expect(ruleIds("src/main.go", ["\tdebugger := true"])).not.toContain("leftover-debugger");
  });
});

describe("rules — scope", () => {
  it("only fires on lines the change adds", () => {
    // A pre-existing `debugger` is the repository's problem, not this PR's.
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " function go() {",
      "   debugger;",
      "+  return 1;",
      " }",
    ].join("\n");
    const { units } = planUnits(parseUnifiedDiff(diff), 600);
    expect(runRules(units[0] as ReviewUnit, "en")).toHaveLength(0);
  });

  it("reports the post-image line number so the comment can be anchored", () => {
    const unit = unitWith("src/a.ts", ["  debugger;"], ["const a = 1;", "const b = 2;"]);
    const hit = runRules(unit, "en")[0];
    expect(hit?.line).toBe(3);
    expect(hit?.path).toBe("src/a.ts");
  });

  it("renders findings in the requested language", () => {
    const unit = unitWith("src/a.ts", ["    debugger;"]);
    expect(runRules(unit, "zh")[0]?.title).toMatch(/debugger/);
    expect(runRules(unit, "zh")[0]?.body).toMatch(/[一-龥]/);
    expect(runRules(unit, "en")[0]?.body).not.toMatch(/[一-龥]/);
  });
});

describe("rules — missing test coverage", () => {
  const logic = (n: number) => Array.from({ length: n }, (_, i) => `  const step${i} = compute(${i});`);

  function idsWithContext(path: string, added: string[], changedPaths: string[]): string[] {
    const unit = unitWith(path, added);
    return runRules(unit, "en", { changedPaths }).map((hit) => hit.ruleId);
  }

  it("flags substantive logic that ships without a matching test change", () => {
    // The most common human review comment, and fully deterministic.
    const ids = idsWithContext("src/retry.ts", logic(10), ["src/retry.ts"]);
    expect(ids).toContain("no-test-change");
  });

  it("stays quiet when the PR changes a test that names the file", () => {
    for (const test of [
      "src/retry.test.ts",
      "src/__tests__/retry.ts",
      "test/retry_test.go",
      "tests/test_retry.py",
      "spec/retry_spec.rb",
    ]) {
      const ids = idsWithContext("src/retry.ts", logic(10), ["src/retry.ts", test]);
      expect(ids, `${test} should count as coverage`).not.toContain("no-test-change");
    }
  });

  it("does not ask for tests for a trivial change", () => {
    expect(idsWithContext("src/retry.ts", logic(3), ["src/retry.ts"])).not.toContain("no-test-change");
  });

  it("does not count imports or braces toward the threshold", () => {
    const noise = [
      'import { a } from "./a";',
      'import { b } from "./b";',
      "}",
      ");",
      "// a comment",
      "",
      'import { c } from "./c";',
      "}",
      ");",
      "}",
    ];
    expect(idsWithContext("src/retry.ts", noise, ["src/retry.ts"])).not.toContain("no-test-change");
  });

  it("does not ask a test file to have tests", () => {
    expect(idsWithContext("src/retry.test.ts", logic(20), ["src/retry.test.ts"])).not.toContain(
      "no-test-change",
    );
  });

  it("leaves declaration, config, and migration files alone", () => {
    for (const path of [
      "src/types.d.ts",
      "src/types.ts",
      "vite.config.ts",
      "src/migrations/001_init.ts",
      "README.md",
      "package.json",
    ]) {
      expect(idsWithContext(path, logic(20), [path]), path).not.toContain("no-test-change");
    }
  });

  it("does not fire at all without pull-request context", () => {
    // A single file cannot know what else the change touched, so the rule must
    // stay silent rather than guess.
    const unit = unitWith("src/retry.ts", logic(20));
    expect(runRules(unit, "en").map((h) => h.ruleId)).not.toContain("no-test-change");
  });

  it("anchors to the first substantive added line so the comment can be posted", () => {
    const unit = unitWith("src/retry.ts", logic(10));
    const hit = runRules(unit, "en", { changedPaths: ["src/retry.ts"] }).find(
      (h) => h.ruleId === "no-test-change",
    );
    expect(hit?.line).toBeGreaterThan(0);
    expect(hit?.severity).toBe("minor");
  });
});

describe("test-path heuristics", () => {
  it("recognises test paths across ecosystems", () => {
    for (const path of [
      "src/a.test.ts",
      "src/a.spec.tsx",
      "test/a.ts",
      "tests/a.js",
      "src/__tests__/a.ts",
      "pkg/a_test.go",
      "tests/test_a.py",
      "spec/a_spec.rb",
      "src/AThing Tests.java".replace(" ", ""),
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
  });

  it("does not mistake source for test", () => {
    for (const path of ["src/a.ts", "src/latest.ts", "src/contest.js", "lib/protest.py"]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });

  it("reduces a path to the stem a test would name", () => {
    expect(stemOf("src/cache/store.ts")).toBe("store");
    expect(stemOf("src/cache/store.test.ts")).toBe("store");
    expect(stemOf("tests/test_store.py")).toBe("store");
  });

  it("refuses to guess on a stem too short to be distinctive", () => {
    expect(hasMatchingTestChange("src/a.ts", [])).toBe(true);
  });
});
