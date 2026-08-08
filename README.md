# code-review

Give it a pull request URL. It reviews the change and grades every finding by
the evidence behind it. Built on the [pi](https://github.com/earendil-works/pi) framework.

*[中文文档 →](README.zh.md)*

- **Survives being killed** — re-running the same command *is* resuming; there is no run id to remember
- **Stays inside a budget** — downgrades the model as spend rises, stops at the limit, but still finishes the zero-cost checks
- **Every finding is traceable** — full prompt, raw model response, and tool calls in one file
- **Two confidence tiers** — machine-verifiable evidence is "adoptable"; model reasoning is "for reference"
- **Secrets never leave the machine** — redaction is type-enforced; the repo is never cloned and no repo code runs

---

## Quick start

```bash
git clone https://github.com/yanmxa/code-review && cd code-review
npm install -g .                       # builds and puts `code-review` on your PATH

export OPENAI_API_KEY=sk-...           # or MOONSHOT / ANTHROPIC / OPENROUTER
gh auth login                          # or export GITHUB_TOKEN

code-review auth                       # confirm credentials are found
code-review config                     # see the budget and model ladder it will use
code-review https://github.com/yanmxa/code-review/pull/1 --budget 6
```

Prefer not to install globally: `npm install && npm run dev -- <pr-url>`.

---

## What it looks like

During the run: file progress on the left, what the agent is doing right now on
the right, spend and current model always on top.

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

Then triage: two groups by confidence, adoptable ones pre-selected, `p` posts
the selection. The right pane shows *why* a finding earned its tier.

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

<details>
<summary><b>Press <code>t</code> for the full trace behind any finding</b></summary>

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

Which tools ran, the exact prompt sent, the raw model response, and what each
step cost. Enter expands any row.

</details>

Without a TTY — CI, a pipe, `--no-tui` — it falls back to line output driven by
the same event stream.

---

## Verify the claims yourself

These are not test assertions; they are commands you can run. The demo PR has
six planted defects.

```bash
PR=https://github.com/yanmxa/code-review/pull/1

# Resume: kill it mid-run, then re-run the same command
code-review $PR --budget 6 &
sleep 30 && pkill -f "code-review $PR"
code-review $PR --budget 6            # redoes only the interrupted file, no double billing

# Downgrade: switches to a cheaper model once half the budget is gone
code-review $PR --budget 0.30 --fresh --no-tui | grep downgrade

# Hard stop: the first file blows the budget; the rest still run the free rules
code-review $PR --budget 0.12 --fresh --no-tui ; echo "exit $?"   # 3 = budget exhausted

# Redaction: the planted AWS key is nowhere in any artifact
grep -r "AKIAIOSFODNN7EXAMPLE" ~/.code-review/runs/   # no hits
grep -rho "\[REDACTED:[a-z-]*:" ~/.code-review/runs/ | sort -u

# Idempotent posting: run --post twice, nothing is duplicated
code-review $PR --post && code-review $PR --post
```

Measured: resume went ¥0.24 → ¥0.35 (the three finished files were not
re-billed); the downgrade fired at 58% and the run closed at ¥0.21 inside a
¥0.30 budget; under the hard stop only 1 of 4 files reached the model, yet the
report still carried 5 adoptable findings.

---

## Requirements, and what implements each

| Requirement | How | Code | Tests |
| --- | --- | --- | --- |
| **Resumable** | Run id is `sha256(platform:repo:number:headSha)`, so **re-running the same command resumes**. Findings are written before the state that acknowledges them: a crash costs at most one file and never a paid-for result. `state.json` is written to a temp file and renamed. | `checkpoint/store.ts` | `store.test.ts` (16) |
| **Token budget** | The gate lives in the **stream function**, so every LLM call passes through it — including turns the agent takes on its own. Mini at 50%, squeeze context at 75%, nano at 85%, hard stop at 100%. After a hard stop the **zero-cost rules still run**, so partial results stay worth reading. | `budget/budget.ts`<br>`engine/review-agent.ts` | `budget.test.ts` (17) |
| **Observable** | One JSONL per review unit: full system prompt, every message, raw model response, every tool call and result, rule hits, budget events. A link in the report, `t` in the TUI, `code-review trace` on the command line. | `trace/tracer.ts` | `pipeline.test.ts` |
| **Confidence tiers** | **Only machine-reproducible evidence promotes a finding to "adoptable"**: a deterministic rule hit or a static analysis diagnostic. Model reasoning stays "for reference". Cited tool call ids are resolved against the trace; fabricated ones are dropped, not rewarded. | `engine/grade.ts`<br>`engine/rules-engine.ts` | `rules.test.ts` (23) |
| **Security** | Redaction is **compiler-enforced**: anything bound for a model or for disk is a branded `Redacted<string>`, so forgetting to redact is a type error, not a leak. gitleaks-derived rules plus an entropy scan. Never clones, registers no shell tool — every access is REST. The only subprocess is `gh auth token`. | `security/redactor.ts` | `redactor.test.ts` (27) |
| **Extensible** | A tool is one file plus one line in `tools/index.ts`. The prompt's tool list comes from `meta.promptSnippet`; grading reads `meta.evidenceKind`. The pipeline is never touched. | `tools/spec.ts`<br>`tools/index.ts` | `tools.test.ts` (17) |

---

## Adding a tool

The brief asks that adding a tool be declarative and leave the main flow alone.
`ts_syntax_check` was added exactly that way, in **two places**:

**① a new file, `src/tools/ts-syntax-check.ts`**

```ts
export const tsSyntaxCheckTool = defineReviewTool({
  meta: {
    id: "ts_syntax_check",
    evidenceKind: "static",   // ← lets its output promote a finding to "adoptable"
    enabledByDefault: true,
    costHint: "free",
    promptSnippet: "ts_syntax_check — run the TypeScript compiler over a changed file…",
  },                          //   ↑ enters the system prompt automatically
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

There is no third place. Disable it at runtime with
`{"tools": {"ts_syntax_check": false}}`.

**Why it is safe**: the file is fetched into memory and handed to the TypeScript
compiler through a virtual `CompilerHost`. `noResolve` stops it reaching for
imports, `noEmit` stops it writing anything — the compiler only parses
repository code as **data**. The cost is that cross-module types are
unavailable, so "cannot find module" diagnostics are filtered out and only
syntax errors and self-contained type errors remain. That limit is stated in the
tool's own description.

---

## Commands and configuration

```bash
code-review <pr-url> [options]      # review a pull request

code-review runs                    # list checkpointed runs
code-review triage <run-id>         # reopen the findings browser
code-review trace <run-id> <unit>   # print a unit's full trace

code-review config                  # show the configuration a run would use
code-review init                    # write review.config.json to edit
code-review auth                    # show which credentials are configured
code-review login [provider]        # sign in with a subscription
code-review logout <provider>       # forget a stored credential
```

| Option | Meaning |
| --- | --- |
| `--budget <cny>` | Total budget for this review, in CNY (default 10) |
| `--model <ref>` | Primary model, e.g. `openai/gpt-5.4`. Setting it disables the ladder |
| `--lang <zh\|en>` | Language of findings and report (default zh) |
| `--post` | Post findings back to the PR as inline comments |
| `--report <path>` | Also write the markdown report here |
| `--fresh` | Ignore any checkpoint and start over |
| `--no-tui` / `--verbose` | Line output / also stream model output |
| `--fail-on <adoptable\|any>` | For CI: exit 2 when findings of that tier exist |

Exit codes: `0` clean, `2` matched `--fail-on`, `3` budget exhausted (partial
results), `1` error.

**Config precedence**: defaults → `~/.config/code-review/config.json` →
`./review.config.json` → environment → CLI flags. `code-review init` writes an
editable copy; `code-review config` shows the merged result.

```jsonc
{
  "budget": {
    "totalCny": 10,
    "usdToCny": 7.25,
    "ladder": [                                    // triggered by fraction spent
      { "atFraction": 0,    "model": { "provider": "openai", "id": "gpt-5.4" } },
      { "atFraction": 0.5,  "model": { "provider": "openai", "id": "gpt-5.4-mini" } },
      { "atFraction": 0.85, "model": { "provider": "openai", "id": "gpt-5.4-nano" } }
    ]
  },
  "tools": { "ts_syntax_check": true },
  "lang": "en"
}
```

<details>
<summary><b>Using a ChatGPT subscription instead of an API key</b></summary>

`openai-codex` reaches the same models through a ChatGPT plan, so calls are
covered by the subscription rather than billed per token:

```bash
code-review login openai-codex      # browser auth; token stored in ~/.code-review/auth.json (0600)
code-review <pr-url> --model openai-codex/gpt-5.4
```

The OAuth flow is pi's; this tool adds the terminal prompts and a file-backed
credential store, because pi-ai ships only an in-memory one.

**Note**: under a plan the provider reports no per-call cost, so the budget
works from list prices. It still limits how much work runs and still drives the
downgrade ladder, but every figure is prefixed `≈` and the report says the calls
were covered by a subscription. It is a work limiter, not a bill.

</details>

---

## Architecture

```
PR URL → fetch (REST, no clone) → redact → split into review units
       → per unit: deterministic rules ∥ agent loop (read-only tools + submit_findings)
       → dedupe → grade by evidence → report / TUI triage / post
```

Three decisions worth stating; the reasoning is in the
[design doc](docs/design.zh.md) (Chinese):

- **One agent loop per file**, not one call for the whole PR. A file is the unit
  a human reviewer thinks in, and it gives checkpoints, budget, and context a
  natural boundary.
- **Budget and tracing hang off the stream function**, not the pipeline. They
  apply to every LLM call while the pipeline stays unaware they exist.
- **"Adoptable" requires machine evidence.** An earlier version promoted a
  finding when a rule fired nearby; a test killed it. Proximity is not
  corroboration.

Built on three pi packages: `pi-ai` (unified LLM API with per-call usage and
cost), `pi-agent-core` (agent loop, declarative tools), `pi-tui`
(differential-rendering terminal UI).

Unedited artifacts in [`examples/`](examples/): the
[report](examples/sample-report.en.md), a [trace](examples/sample-trace.jsonl),
and the [checkpoint file](examples/sample-state.json).

---

## Development

```bash
npm test              # 189 tests, fully offline, no API key needed
npm run typecheck
npm run dev -- <url>  # run from source via tsx
```

No network required: the LLM is pi-ai's faux provider, the host is an in-memory
adapter, and the terminal is a stub implementing pi-tui's `Terminal` interface.

<details>
<summary><b>Known limitations</b></summary>

- **Checkpoints are file-grained.** A crash mid-file re-runs that file (a few
  cents), not from the last tool call. Finer granularity would mean persisting
  the agent's intermediate state, which is not worth the complexity.
- **`ts_syntax_check` has no cross-module types** (no `node_modules`), so it
  catches syntax errors and self-contained type errors only.
- **GitLab posts one discussion per comment.** It has no batch review endpoint,
  so a partial failure leaves some comments posted.
- **`--verify` annotates but never changes a tier.** Promoting because a second
  model agreed would be self-deception — models can be wrong together.
- **Sequential**, 3-4× slower than parallel on a large PR. The trade buys
  deterministic spend ordering and readable checkpoint semantics.

</details>

<details>
<summary><b>Behind a proxy</b></summary>

Node's `fetch` does **not** read `HTTPS_PROXY` (curl does), which surfaces as a
`Connection error.` that looks like a bad API key. When a proxy is configured,
the CLI re-execs once with `NODE_USE_ENV_PROXY=1` so it just works.

</details>

---

## On AI assistance

Built with AI assistance. [`docs/ai-usage.md`](docs/ai-usage.md) records the
process honestly: which parts AI wrote, how they were verified, the six defects
AI introduced, and how each was caught.

MIT License.
