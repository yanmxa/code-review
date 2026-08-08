# code-review

Give it a pull request URL. It reviews the change and grades every finding by
the evidence behind it. Built on the [pi](https://github.com/earendil-works/pi) framework.

*[中文文档 →](README.zh.md)*

**How it reads a pull request**

- **Deterministic checks run first** — committed secrets, SQL concatenation, unsafe randomness, missing tests. These need no model, and a hit is adoptable-tier evidence
- **One agent loop per file** — with read-only tools (read a file, search this PR's changes, run the TypeScript compiler), capped at six turns
- **CI results go to the model too** — failing tests and their line-level errors enter the context alongside the diff, instead of being guessed at
- **It only concludes what it can back** — machine-verifiable evidence is "adoptable", model reasoning is "for reference", and the two are never blurred
- **A rejected comment is never raised again** — deleting or resolving one is a permanent no
- **You can supply what the PR does not say** — `--prompt "this is a revert of #892"` or `"the retry loop is deliberate"`, and every file is reviewed knowing it

The full mechanism: [how a review runs](docs/how-it-works.zh.md) (Chinese).

**Whether the tool itself is trustworthy**

- **Survives being killed** — run the same command again and it picks up where it stopped ([why](docs/how-it-works.zh.md#断点续跑的原理))
- **Stays inside a budget** — downgrades the model as spend rises, stops at the limit, still finishes the zero-cost checks
- **Every finding is traceable** — full prompt, raw model response, and tool calls in one file
- **Secrets never leave the machine** — redaction is type-enforced; the repo is never cloned and no repo code runs
- **Rules and review focus are configurable** — a project writes its own checks and priorities in config, not in a fork

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

### Verify the claims yourself

These are not test assertions; they are commands you can run. The demo PR has
six planted defects.

```bash
PR=https://github.com/yanmxa/code-review/pull/1

# Resume: kill it mid-run, then re-run the same command
code-review $PR --budget 6 &
sleep 30 && pkill -f "code-review $PR"
code-review $PR --budget 6            # redoes only the interrupted file, no double billing

# Downgrade: switches to a cheaper model when projected to overrun
code-review $PR --budget 0.30 --fresh --no-tui | grep downgrade

# Hard stop: the first file blows the budget; the rest still run the free rules
code-review $PR --budget 0.12 --fresh --no-tui ; echo "exit $?"   # 3 = budget exhausted

# Redaction: the planted AWS key is nowhere in any artifact
grep -r "AKIAIOSFODNN7EXAMPLE" ~/.code-review/runs/   # no hits
grep -rho "\[REDACTED:[a-z-]*:" ~/.code-review/runs/ | sort -u

# Idempotent posting: run --post twice, nothing is duplicated
code-review $PR --post && code-review $PR --post
```

Measured: resume redoes only the interrupted file and never re-bills the
finished ones; with `--budget 0.30` the first file already forecast ¥0.37 and
triggered a downgrade, after which the forecast converged and the run closed at
¥0.16; under the hard stop only 1 of 4 files reached the model, yet the report
still carried 5 adoptable findings.

---

## What it looks like

During the run: file progress on the left, what the agent is doing right now on
the right, spend and current model always on top.

```
⬢ yanmxa/code-review #1 demo: add cache eviction, session lookup, and...
demo/planted-defects → main · 4 files                                     openai/gpt-5.4
▱▱▱▱▱▱▱▱▱▱ ¥0.30/¥6.00 · → ¥0.34 · ↑8.7k ↓1.2k ⛁4.6k

╭─ Files ──────────────────── 2/4 ─╮╭─ Activity ───────────────────────────────────────╮
│✓ demo/src/cache.ts            2  ││    demo/src/retry.ts (11 lines)                  │
│✓ demo/src/config.ts           1  ││  → ts_syntax_check demo/src/retry.ts             │
│⠋ demo/src/retry.ts               ││    no diagnostics                                │
│◌ demo/src/session.ts             ││────────────────────                              │
│                                  ││The condition is i <= attempts, so a default of   │
│                                  ││3 runs four times. Checking callers…              │
│                                  ││                                                  │
╰──────────────────────────────────╯╰──────────────────────────────────────────────────╯

━━━━━━━━━━━━ 2/4 · 00:00  ●4 ○0                                 ctrl+c checkpoint & quit
```

<details>
<summary><b>Then triage: two groups by confidence, adoptable ones pre-selected</b></summary>

`p` posts the selection. The right pane shows *why* a finding earned its tier.

```
⬢ Review findings · 10 total  ● 7  ○ 3                            ▱▱▱▱▱▱▱▱▱▱ ¥0.30/¥6.00

╭─ Findings ──────────────── 7/10 ─╮╭─ Detail ─────────────────────────────────────────╮
│● ADOPTABLE (7)                   ││● Credential committed in this change             │
│▌[x] ● config.ts:4 Credential...  ││F-001 · blocker · adoptable                       │
│ [x] ● session.ts:14 SQL buil...  ││demo/src/config.ts:4                              │
│ [x] ● session.ts:8 Non-crypt...  ││                                                  │
│ [x] ● cache.ts:15 New `conso...  ││The secret scanner classified this line as        │
│ [x] ● retry.ts:1 Changed wit...  ││`aws-access-key` (the value was masked before     │
│ [x] ● session.ts:4 Changed w...  ││any model saw it). Remove it from the code, move  │
│ [x] ● session.ts:4 Loose equ...  ││it to an environment variable or secret manager,  │
│                                  ││and **rotate the credential** — it is already in  │
│○ REFERENCE (3)                   ││git history.                                      │
│ [ ] ○ cache.ts:11 Eviction r...  ││                                                  │
╰──────────────────────────────────╯╰──────────────────────────────────────────────────╯

                    ↑↓ move · space toggle · a all adoptable · t trace · p post · q quit
```

</details>

<details>
<summary><b>Press <code>t</code> for the full trace behind any finding</b></summary>

```
╭─ F-002 · traces/demo_src_session.ts.jsonl ───────────────────────────────────────────╮
│▌14:39:34 ✦ rule no-test-change demo/src/session.ts:4                                 │
│ 14:39:34 ✦ rule loose-equality demo/src/session.ts:4                                 │
│ 14:39:34 ✦ rule insecure-random demo/src/session.ts:8                                │
│ 14:39:34 ✦ rule sql-string-concat demo/src/session.ts:14                             │
│ 14:39:34 ▸ unit demo/src/session.ts openai/gpt-5.4                                   │
│ 14:39:34 ↑ llm 1 msg · 4 tools openai/gpt-5.4                                        │
│ 14:39:36 ↓ llm toolUse ↑1.6k ↓86 $0.0053                                             │
│ 14:39:36 → get_file {"path":"demo/src/db.ts","startLine":1}                          │
│ 14:39:38   · File not found at head commit: demo/src/db.ts                           │
│ 14:39:38 ↑ llm 3 msg · 4 tools openai/gpt-5.4                                        │
│ 14:39:41 ↓ llm toolUse ↑176 ↓48 $0.0015                                              │
│                                                    ↑↓ move · enter expand · esc close│
╰──────────────────────────────────────────────────────────────────────────────────────╯
```

Which tools ran, the exact prompt sent, the raw model response, and what each
step cost. Enter expands any row.

</details>

Without a TTY — CI, a pipe, `--no-tui` — it falls back to line output driven by
the same event stream.

---

## Commands and configuration

```bash
code-review <pr-url> [options]      # review a pull request
code-review runs                    # list checkpointed runs
code-review triage <run-id>         # reopen the findings browser
code-review trace <run-id> <unit>   # print a unit's full trace
code-review config                  # show the configuration a run would use
```

The options you will reach for:

| Option | Meaning |
| --- | --- |
| `--budget <amount>` | `10`, `¥10`, `$1.50`, `800k tokens` (default ¥10) |
| `--model <ref>` | Pin the model; setting it disables the ladder |
| `--prompt <text>` | Context for this run, e.g. `"this is a revert of #892"` |
| `--post` | Post findings back to the pull request |
| `--fresh` | Ignore any checkpoint and start over |
| `--fail-on <adoptable\|any>` | For CI: exit 2 when findings of that tier exist |

A config file sets the budget and model order, adds or removes deterministic
rules, and tells the reviewer what this project cares about:

```jsonc
{
  "budget": { "limit": "¥10", "models": ["openai/gpt-5.4", "openai/gpt-5.4-mini"] },
  "rules":  { "disabled": ["todo-added"], "custom": [ /* your own checks */ ] },
  "review": { "focus": "A Go service; error wrapping matters", "ignore": ["naming"] }
}
```

Full reference — every flag and field, credentials, and how to add a tool — in
**[docs/configuration.zh.md](docs/configuration.zh.md)** (Chinese).

---

## Extending

Rules can only do what a regular expression can. When something has to actually
be *looked up* — run a compiler, query an advisory database, call an internal
service — that is a tool.

A tool is one file plus one line in the registry; the main flow is untouched:

```diff
 export const TOOL_REGISTRY: ToolSpec[] = [
   getFileTool,
   searchDiffTool,
+  yourTool,
   submitFindingsTool,
 ];
```

`meta.promptSnippet` generates the tool list in the prompt, and
`meta.evidenceKind` decides whether its output can promote a finding to
adoptable. There is no third place to change.

Worked example and how to choose `evidenceKind`:
[docs/configuration.zh.md](docs/configuration.zh.md#加一个工具) (Chinese).

---

## Project layout

```
src/
├── platform/      GitHub / GitLab adapters, and a hand-written unified-diff parser
├── security/      Redaction: gitleaks-derived rules plus an entropy scan, brand-enforced
├── engine/
│   ├── units.ts        diff → review units
│   ├── rules-engine.ts deterministic checks (built-in and project-defined)
│   ├── review-agent.ts the agent loop; budget and tracing hang off its streamFn
│   ├── grade.ts        evidence → tier, dedupe, fingerprints
│   └── pipeline.ts     owns the order of work, never its content
├── tools/         read-only tools the agent may call, declaratively registered
├── budget/        the ledger and the forecast-driven ladder
├── checkpoint/    findings written before the state that acknowledges them
├── memory/        repository-scoped record of what maintainers rejected
├── trace/         one JSONL per review unit
├── report/        markdown report and idempotent posting
└── tui/           dashboard / triage / trace viewer; plain.ts renders the same event stream
```

Tests mirror the modules they cover under `test/`.

Built on three pi packages: `pi-ai` (unified LLM API with per-call usage and
cost), `pi-agent-core` (agent loop, declarative tools), `pi-tui`
(differential-rendering terminal UI). The tradeoffs are in the
[design notes](docs/design.zh.md).

### Documentation

| Document | Contents |
| --- | --- |
| [How a review runs](docs/how-it-works.zh.md) | The mechanism, following one real finding end to end |
| [Configuration](docs/configuration.zh.md) | Every flag and field, credentials, adding a tool |
| [Design notes](docs/design.zh.md) | The tradeoffs, and what each one gave up |
| [`examples/`](examples/) | Real artifacts: [report](examples/sample-report.en.md) · [trace](examples/sample-trace.jsonl) · [checkpoint](examples/sample-state.json) |

All three are in Chinese.

---

## Development

```bash
npm test              # 261 tests, fully offline, no API key needed
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
