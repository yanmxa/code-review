# code-review

A code review agent for GitHub and GitLab pull requests, built on the [pi](https://github.com/earendil-works/pi) framework.

*[中文文档 →](README.zh.md)*

Give it a pull request URL. It reviews the change, grades every finding by the
evidence behind it, and either writes a markdown report or posts the findings
back as inline comments. It survives being killed, stays inside a budget you
set, and never sends a secret to a model.

```bash
export OPENAI_API_KEY=sk-...      # or MOONSHOT_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY
gh auth login                     # or export GITHUB_TOKEN

npm install && npm run build
node dist/cli.js https://github.com/owner/repo/pull/123 --budget 10
```

---

## What it looks like

**The run dashboard.** File progress on the left, what the agent is doing right
now on the right, and one line at the top that always answers *what has this
cost me and which model am I on*.

```
⬢ yanmxa/code-review #1 demo: add cache eviction, session lookup, and retry helper
demo/planted-defects → main · 4 files                                                 openai/gpt-5.4
▰▱▱▱▱▱▱▱▱▱ ¥0.31/¥6.00 · ↑9.1k ↓1.3k ⛁6.1k                                                          

╭─ Files ────────────────────────── 2/4 ─╮╭─ Activity ─────────────────────────────────────────────╮
│✓ demo/src/cache.ts                  2  ││▸ demo/src/retry.ts                                     │
│✓ demo/src/config.ts                 2  ││  → get_file demo/src/retry.ts                          │
│⠋ demo/src/retry.ts                     ││    demo/src/retry.ts (11 lines)                        │
│◌ demo/src/session.ts                   ││  → search_diff withRetry\(                             │
│                                        ││    No changed line matches /withRetry\(/.              │
│                                        ││────────────────────                                    │
│                                        ││The loop condition uses i <= attempts, so with the      │
│                                        ││default of 3 it runs four times. Checking whether any   │
│                                        ││caller depends on that…                                 │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
╰────────────────────────────────────────╯╰────────────────────────────────────────────────────────╯

━━━━━━━━━━━━ 2/4 · 00:00  ●4 ○0                                             ctrl+c checkpoint & quit
```

**The findings browser.** Two groups by confidence, adoptable ones pre-selected,
`p` to post the selection back to the PR. The right pane shows *why* a finding
earned the label it has.

```
⬢ Review findings · 8 total  ● 5  ○ 3                                         ▰▱▱▱▱▱▱▱▱▱ ¥0.31/¥6.00

╭─ Findings ─────────────────────── 5/8 ─╮╭─ Detail ───────────────────────────────────────────────╮
│● ADOPTABLE (5)                         ││● Credential committed in this change                   │
│▌[x] ● config.ts:4 Credential commi...  ││F-001 · blocker · adoptable                             │
│ [x] ● session.ts:14 SQL built by s...  ││demo/src/config.ts:4                                    │
│ [x] ● session.ts:8 Non-cryptograph...  ││                                                        │
│ [x] ● cache.ts:15 New `console` lo...  ││The secret scanner classified this line as              │
│ [x] ● session.ts:4 Loose equality ...  ││`aws-access-key` (the value was masked before any       │
│                                        ││model saw it). Remove it from the code, move it to an   │
│○ REFERENCE (3)                         ││environment variable or secret manager, and **rotate    │
│ [ ] ○ cache.ts:11 Eviction runs ev...  ││the credential** — it is already in git history.        │
│ [ ] ○ retry.ts:3 Retry loop perfor...  ││                                                        │
│ [ ] ○ session.ts:15 Database failu...  ││Evidence                                                │
│                                        ││  ● rule secret-in-diff matched demo/src/config.ts:4 —  │
│                                        ││    awsAccessKeyId: "[REDACTED:aws-access-key:1a5d]",   │
│                                        ││                                                        │
│                                        ││→ traces/demo_src_config.ts.jsonl   t open trace        │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
╰────────────────────────────────────────╯╰────────────────────────────────────────────────────────╯

                       ↑↓ move · space toggle · a all adoptable · t trace · p post · l lang · q quit
```

**The trace viewer** (`t`). The complete timeline behind any finding: which
tools ran, the exact prompt that was sent, the raw model response, and what each
step cost. Enter expands any row.

```
╭─ F-002 · traces/demo_src_session.ts.jsonl ───────────────────────────────────────────────────────╮
│ 02:28:51 ✦ rule loose-equality demo/src/session.ts:4                                             │
│ 02:28:51 ✦ rule insecure-random demo/src/session.ts:8                                            │
│▌02:28:51 ✦ rule sql-string-concat demo/src/session.ts:14                                         │
│ 02:28:51 ▸ unit demo/src/session.ts openai/gpt-5.4                                               │
│ 02:28:51 ↑ llm 1 msg · 4 tools openai/gpt-5.4                                                    │
│ 02:28:54 ↓ llm toolUse ↑1.8k ↓78 $0.0057                                                         │
│ 02:28:54 → get_file {"path":"demo/src/session.ts","startLine":1}                                 │
│ 02:28:55   · demo/src/session.ts                                                                 │
│ 02:28:55 ↑ llm 3 msg · 4 tools openai/gpt-5.4                                                    │
│ 02:28:57 ↓ llm toolUse ↑552 ↓44 $0.0024                                                          │
│ 02:28:57 → get_file {"path":"demo/src/db.ts","startLine":1}                                      │
│ 02:28:57   · File not found at head commit: demo/src/db.ts                                       │
│ 02:28:57 ↑ llm 5 msg · 4 tools openai/gpt-5.4                                                    │
│ 02:28:59 ↓ llm toolUse ↑618 ↓44 $0.0026                                                          │
│ 02:28:59 → search_diff {"pattern":"createConnection\\(|query\\(","...                            │
│ 02:28:59   · 2 matching changed line(s):                                                         │
│                                                                ↑↓ move · enter expand · esc close│
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

Without a TTY — CI, a pipe, or `--no-tui` — it falls back to line output driven
by the same event stream.

---

## Requirements, and what implements each

| Requirement | How | Code | Tests |
| --- | --- | --- | --- |
| **Resumable**<br>a restart must not start over | Run id is `sha256(platform:repo:number:headSha)`, so **re-running the same command *is* resuming** — there is no run id to remember. Findings are written before the state that acknowledges them, so a crash costs at most one file and can never lose a result already paid for. `state.json` is written to a temp file and renamed. | `src/checkpoint/store.ts` | `test/store.test.ts` (16) |
| **Token budget**<br>settable, degrades when exceeded | The budget gate lives in the **stream function**, so every LLM call passes through it — including turns the agent decides to take on its own. Downgrade to mini at 50%, nano at 85%, squeeze context at 75%, hard stop at 100%. After a hard stop the **zero-cost deterministic rules still run**, so partial results stay worth reading. | `src/budget/budget.ts`<br>`src/engine/review-agent.ts` | `test/budget.test.ts` (17) |
| **Observable**<br>every comment links to a trace | One JSONL file per review unit: the full system prompt, every message, the raw model response, every tool call and result, rule hits, budget events. Each finding carries a `tracePath` — a link in the report, `t` in the TUI, `code-review trace <run> <unit>` on the command line. | `src/trace/tracer.ts` | `test/pipeline.test.ts` |
| **Confidence tiers**<br>adoptable vs. for-reference | **Only machine-reproducible evidence promotes a finding to "adoptable"**: a deterministic rule hit, or a static analysis diagnostic. Model reasoning, however confident, stays "for reference". The model must cite tool call ids in `supportingToolCalls`; ids that do not resolve against the trace are silently dropped rather than rewarded. | `src/engine/grade.ts`<br>`src/engine/rules-engine.ts` | `test/rules.test.ts` (23) |
| **Security**<br>no secrets to the LLM, no code execution | Redaction is **compiler-enforced**: everything bound for a model or for disk is a branded `Redacted<string>`, so forgetting to redact is a type error, not a leak. Rules are gitleaks-derived plus an entropy scan. The repository is never cloned and no shell tool exists — every access is a REST call. The only subprocess in the program is `gh auth token`. | `src/security/redactor.ts` | `test/redactor.test.ts` (27) |
| **Extensible**<br>declarative tool registration | A tool is one file exporting a `ToolSpec`, plus one line in `tools/index.ts`. The system prompt's tool list is generated from `meta.promptSnippet`; confidence grading reads `meta.evidenceKind`. The pipeline is never touched. Full example below. | `src/tools/spec.ts`<br>`src/tools/index.ts` | `test/tools.test.ts` (17) |

---

## Adding a tool

The brief asks that adding a tool such as a typechecker be declarative and leave
the main flow alone. `ts_syntax_check` was added exactly that way, in two places:

**① a new file, `src/tools/ts-syntax-check.ts`**

```ts
export const tsSyntaxCheckTool = defineReviewTool({
  meta: {
    id: "ts_syntax_check",
    evidenceKind: "static",   // ← lets its output promote a finding to "adoptable"
    enabledByDefault: true,
    costHint: "free",
    promptSnippet: "ts_syntax_check — run the TypeScript compiler over a changed file…",
  },                          //   ↑ goes into the system prompt automatically
  build(context) {
    return reviewTool({
      name: "ts_syntax_check",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, params) { /* … */ },
    });
  },
});
```

**② one line in `src/tools/index.ts`**

```diff
 export const TOOL_REGISTRY: ToolSpec[] = [
   getFileTool,
   searchDiffTool,
+  tsSyntaxCheckTool,
   submitFindingsTool,
 ];
```

There is no third place. The pipeline, prompt assembly, and confidence grading
are all untouched. Config can disable it at runtime:
`{"tools": {"ts_syntax_check": false}}`.

**Why this tool is safe.** The file is fetched over HTTPS into memory and handed
to the TypeScript compiler through a virtual `CompilerHost`. `noResolve` stops
the compiler reaching for imports and `noEmit` stops it writing anything — the
compiler only ever parses repository code as **data**. The cost is that
cross-module types are unavailable, so "cannot find module" diagnostics are
filtered out and only syntax errors and self-contained type errors remain. That
limit is stated in the tool's own description, so the model knows what its
output means.

---

## Commands

```bash
code-review <pr-url> [options]      # review a pull request
code-review runs                    # list checkpointed runs
code-review triage <run-id>         # reopen the findings browser for a finished run
code-review trace <run-id> <unit>   # print a unit's full trace
```

| Option | Meaning |
| --- | --- |
| `--budget <cny>` | Total budget for this review, in CNY (default 10) |
| `--model <ref>` | Primary model, e.g. `openai/gpt-5.4`, `moonshotai/kimi-k2.5`. Setting it disables the downgrade ladder |
| `--lang <zh\|en>` | Language of findings and report (default zh) |
| `--post` | Post findings back to the PR as inline comments |
| `--report <path>` | Also write the markdown report here |
| `--fresh` | Ignore any checkpoint and start over |
| `--no-tui` / `--verbose` | Line output / also stream model output |
| `--fail-on <adoptable\|any>` | For CI: exit 2 when findings of that tier exist |

Exit codes: `0` clean, `2` matched `--fail-on`, `3` budget exhausted (partial
results), `1` error.

**Config precedence**: built-in defaults → `~/.config/code-review/config.json` →
`./review.config.json` → environment → CLI flags.

```jsonc
{
  "budget": {
    "totalCny": 10,
    "usdToCny": 7.25,
    "ladder": [                                    // triggered by fraction of budget spent
      { "atFraction": 0,    "model": { "provider": "openai", "id": "gpt-5.4" } },
      { "atFraction": 0.5,  "model": { "provider": "openai", "id": "gpt-5.4-mini" } },
      { "atFraction": 0.85, "model": { "provider": "openai", "id": "gpt-5.4-nano" } }
    ]
  },
  "tools": { "ts_syntax_check": true },
  "lang": "en"
}
```

---

## A real run

Against a pull request with deliberately planted defects
([yanmxa/code-review#1](https://github.com/yanmxa/code-review/pull/1)):

```
$ code-review https://github.com/yanmxa/code-review/pull/1 --budget 6 --no-tui --lang en

✓ demo/src/cache.ts — 2 finding(s)
    ● minor   demo/src/cache.ts:15   New `console` logging                       [adoptable]
    ○ major   demo/src/cache.ts:11   Eviction runs even when replacing a key     [reference]
✓ demo/src/config.ts — 1 finding(s)
    ● blocker demo/src/config.ts:4   Credential committed in this change         [adoptable]
✓ demo/src/retry.ts — 1 finding(s)
    ○ major   demo/src/retry.ts:3    Retry loop performs one extra attempt       [reference]
✓ demo/src/session.ts — 4 finding(s)
    ● blocker demo/src/session.ts:14 SQL built by string concatenation           [adoptable]
    ● major   demo/src/session.ts:8  Non-cryptographic randomness for an id      [adoptable]
    ● minor   demo/src/session.ts:4  Loose equality comparison                   [adoptable]
    ○ major   demo/src/session.ts:15 Database failures silently become "no session" [reference]

Done. 8 finding(s) — 5 adoptable, 3 reference · ¥0.31
```

Unedited artifacts are in [`examples/`](examples/): the
[report](examples/sample-report.en.md), one
[trace](examples/sample-trace.jsonl), and the
[checkpoint file](examples/sample-state.json).

**Behaviour verified against that real PR**, not only in unit tests:

- **Resume** — `kill -9` mid-run, then re-run the same command. Only the
  interrupted file is redone; the three completed ones are neither re-reviewed
  nor re-billed (¥0.24 → ¥0.35).
- **Downgrade** — `--budget 0.30` switches to `gpt-5.4-mini` at 55% spent and
  finishes inside budget at ¥0.22.
- **Hard stop** — `--budget 0.12` blows the budget on the first file. The
  remaining three skip the model but **still run the deterministic rules**, so
  the report still carries 5 adoptable findings. Exit code 3.
- **Redaction** — the planted AWS key appears only as
  `[REDACTED:aws-access-key:5d3c]` in traces, checkpoints, and prompts. Grepping
  the artifacts for the raw value returns nothing.
- **Idempotent posting** — running `--post` twice skips the 7 comments already
  present and posts only the 1 new finding.

---

## Architecture

```
PR URL → fetch (REST, no clone) → redact → split into review units
       → per unit: deterministic rules ∥ agent loop (read-only tools + submit_findings)
       → dedupe → grade by evidence → report / TUI triage / post
```

Three design decisions worth stating; the reasoning is in the
[design doc](docs/design.zh.md) (Chinese):

- **One agent loop per file**, not one call for the whole PR. A file is the unit
  a human reviewer thinks in, and it gives checkpoints, budget, and context a
  natural boundary.
- **Budget and tracing hang off the stream function**, not off the pipeline.
  That way they apply to every LLM call while the pipeline stays unaware they
  exist.
- **"Adoptable" requires machine evidence.** An earlier version promoted a
  finding when a rule happened to fire nearby; a test killed it. Proximity is not
  corroboration, and promoting on location alone makes the tier meaningless.

Built on three pi packages: `pi-ai` (unified LLM API with per-call usage and
cost), `pi-agent-core` (agent loop, declarative tools, `terminate` semantics),
and `pi-tui` (differential-rendering terminal UI).

---

## Development

```bash
npm test              # 182 tests, fully offline
npm run typecheck
npm run dev -- <url>  # run from source via tsx, no build step
```

The suite needs no API key and no network: the LLM is pi-ai's faux provider, the
host is an in-memory adapter, and the terminal is a stub implementing pi-tui's
`Terminal` interface.

### Known limitations

- **Checkpoints are file-grained.** A crash mid-file re-runs that file (a few
  cents), not from the last tool call. Finer granularity would mean persisting
  the agent's intermediate state, which is not worth the complexity.
- **`ts_syntax_check` has no cross-module types** (no `node_modules`), so it
  catches syntax errors and self-contained type errors only.
- **GitLab posts one discussion per comment.** GitLab has no batch review
  endpoint, so a partial failure leaves some comments posted. GitHub submits one
  review that either fully succeeds or falls back to a summary comment.
- **`--verify` annotates but never changes a tier.** Promoting a finding because
  a second model agreed would be self-deception — models can be wrong together.
- Wide CJK characters truncate early in very narrow terminals (< 60 columns).
  The width contract itself is test-enforced, so the layout never breaks.

### Behind a proxy

Node's `fetch` does **not** read `HTTPS_PROXY` (curl does), which surfaces as a
`Connection error.` from the model that looks like a bad API key. When a proxy is
configured, this CLI re-execs once with `NODE_USE_ENV_PROXY=1` so it just works.

---

## On AI assistance

This project was built with AI assistance. [`docs/ai-usage.md`](docs/ai-usage.md)
records the process honestly: which parts AI wrote, how they were verified, the
six defects AI introduced, and how each was caught.

MIT License.
