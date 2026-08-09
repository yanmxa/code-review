# code-review

Give it a pull request URL. It reviews the change and grades every finding by
the evidence behind it. Built on the [pi](https://github.com/earendil-works/pi) framework.

*[中文文档 →](README.zh.md)*

**How it reads a pull request**

- **Deterministic checks run first** — committed secrets, SQL concatenation, unsafe randomness, missing tests. Free, and a hit is adoptable-tier evidence
- **One agent per file** — read-only tools, six turns
- **Then one for the pull request** — it decides where to look, and finds what one file cannot show: a caller not updated with its callee, a field added to a model but not the migration
- **CI results go in too** — failing tests and their line-level errors, alongside the diff, instead of being guessed at
- **It only concludes what it can back** — machine-verifiable evidence is "adoptable", model reasoning is "for reference"; the latter also carries the model's own certainty (`◉ sure`, `◐ likely`, `○ unsure`), which only orders the list
- **A rejected comment is never raised again** — deleting or resolving one is a permanent no
- **You can supply what the PR does not say** — `--prompt "this is a revert of #892"`

The full mechanism: [how a review runs](docs/how-it-works.zh.md) (Chinese).

**Whether the tool itself is trustworthy**

- **Survives being killed** — run the same command again and it picks up where it stopped ([why](docs/how-it-works.zh.md#断点续跑))
- **Stays inside a budget** — downgrades the model as spend rises, stops at the limit, still finishes the zero-cost checks ([budget](docs/configuration.zh.md#budget))
- **Every finding is traceable** — full prompt, raw model response, and tool calls in one file ([trace](docs/how-it-works.zh.md#trace-与否决记忆))
- **Secrets never leave the machine** — redaction is type-enforced; the repo is never cloned and no repo code runs ([worked example](docs/how-it-works.zh.md#例一一个被提交进来的密钥))
- **Rules and review focus are configurable** — a project writes its own checks ([rules](docs/configuration.zh.md#rules)) and priorities ([review](docs/configuration.zh.md#review)) in config, not in a fork

---

## Quick start

```bash
git clone https://github.com/yanmxa/code-review && cd code-review
npm install -g .                       # builds and puts `code-review` on your PATH
                                       # (remove later: npm uninstall -g code-review)

export OPENAI_API_KEY=sk-...           # or MOONSHOT / ANTHROPIC / OPENROUTER
gh auth login                          # or export GITHUB_TOKEN

code-review auth                       # confirm credentials are found
code-review init                       # pick a budget and a model, interactively
code-review https://github.com/yanmxa/code-review/pull/1
```

Prefer not to install globally: `npm install && npm run dev -- <pr-url>`.

---

### Verify the claims yourself

Resume, budget downgrade, hard stop, redaction, idempotent posting, the
cross-file pass, the dismissal loop — each is a command you can run against the
demo pull request rather than a test assertion to take on trust:
**[docs/verify.zh.md](docs/verify.zh.md)** (Chinese).

---

## What it looks like

During the run: file progress on the left, what the agent is doing right now on
the right, spend and current model always on top.

```
⬢ yanmxa/code-review #1 demo: add cache eviction, session lookup, and retry helper
demo/planted-defects → main · 4 files                                            openai/gpt-5.4-mini
▱▱▱▱▱▱▱▱▱▱ ¥0.04/¥1.00 · → ¥0.08 · ↑3.6k ↓654 ⛁1.5k

╭─ Files ────────────────────────── 2/4 ─╮╭─ Activity ─────────────────────────────────────────────╮
│✓ demo/src/cache.ts                  2  ││    demo/src/cache.ts                                   │
│✓ demo/src/config.ts                 2  ││  → submit_findings 1 finding(s)                        │
│⠹ demo/src/retry.ts                     ││    Recorded 1 finding(s) for demo/src/cache.ts.        │
│◌ demo/src/session.ts                   ││▸ demo/src/config.ts                                    │
│                                        ││  → submit_findings 0 finding(s)                        │
│                                        ││    Recorded 0 finding(s) for demo/src/config.ts.       │
│                                        ││▸ demo/src/retry.ts                                     │
│                                        ││  → get_file demo/src/retry.ts                          │
│                                        ││    demo/src/retry.ts                                   │
╰────────────────────────────────────────╯╰────────────────────────────────────────────────────────╯

━━━━━━━━━━━━ 2/4 · 00:14  ●3 ○1                                             ctrl+c checkpoint & quit
```

<details>
<summary><b>Then triage: two groups by confidence, adoptable ones pre-selected</b></summary>

`p` posts the selection. The right pane shows *why* a finding earned its tier.

```
⬢ Review findings · 11 total  ● 8  ○ 3                                        ▰▱▱▱▱▱▱▱▱▱ ¥0.10/¥1.00

╭─ Findings ────────────────────── 8/11 ─╮╭─ Detail ───────────────────────────────────────────────╮
│● ADOPTABLE (8)                         ││Database errors are swallowed and turned into a suc...  │
│ [x] ● config.ts:4 Credential commi...  ││                                                        │
│ [x] ● config.ts:5 Credential commi...  ││File        demo/src/session.ts:15                      │
│ [x] ● session.ts:14 SQL built by s...  ││Severity    major                                       │
│ [x] ● session.ts:8 Non-cryptograph...  ││Confidence  ◉ reference · sure                          │
│ [x] ● cache.ts:15 New `console` lo...  ││                                                        │
│ [x] ● retry.ts:1 Changed without a...  ││What is wrong ──────────────────────────────────────    │
│ [x] ● session.ts:4 Changed without...  ││  If `db.query(...)` fails, this catch block            │
│ [x] ● session.ts:4 Loose equality ...  ││  suppresses the exception and `loadSession` falls      │
│                                        ││  through without returning anything. Callers will see  │
│○ REFERENCE (3)  ◉sure ◐likely ○unsure  ││  a resolved `undefined` instead of a failure, which    │
│ [ ] ◉ retry.ts:3 Retry helper perf...  ││  can mask outages and make session lookups fail open   │
│▌[ ] ◉ session.ts:15 Database error...  ││  in code that treats "no result" the same as "could    │
│ [ ] ◐ cache.ts:11 Cache can still ...  ││  not query". Re-throw the error or return an explicit  │
│                                        ││  failure value.                                        │
│                                        ││                                                        │
│                                        ││In the diff ────────────────────────────────────────    │
│                                        ││   11 +export async function loadSession(userId: st...  │
│                                        ││─────────────────────────────────────────────  18/30    │
│                                        ││t open full trace   traces/demo_src_session.ts.jsonl    │
╰────────────────────────────────────────╯╰────────────────────────────────────────────────────────╯

                   ↑↓ move · space toggle · a all adoptable · J/K scroll · t trace · p post · q quit
```

</details>

<details>
<summary><b>Press <code>t</code> for the full trace behind any finding</b></summary>

```
╭─ F-010 · traces/demo_src_session.ts.jsonl ─────────────────────────────────────────╮
│▌16:54:37 ✦ rule no-test-change demo/src/session.ts:4                               │
│ 16:54:37 ✦ rule loose-equality demo/src/session.ts:4                               │
│ 16:54:37 ✦ rule insecure-random demo/src/session.ts:8                              │
│ 16:54:37 ✦ rule sql-string-concat demo/src/session.ts:14                           │
│ 16:54:37 ▸ unit demo/src/session.ts openai/gpt-5.4-mini                            │
│ 16:54:37 ↑ llm 1 msg · 4 tools openai/gpt-5.4-mini                                 │
│ 16:54:40 ↓ llm toolUse ↑1.8k ↓64 $0.0016                                           │
│ 16:54:40 → get_file {"path":"demo/src/session.ts","startLine":1}                   │
│ 16:54:41   · demo/src/session.ts                                                   │
│ 16:54:41 ↑ llm 3 msg · 4 tools openai/gpt-5.4-mini                                 │
│ 16:54:43 ↓ llm toolUse ↑498 ↓112 $0.0010                                           │
│ 16:54:43 → get_file {"path":"demo/src/db.ts","startLine":1}                        │
│ 16:54:43   · File not found at head commit: demo/src/db.ts                         │
│                                                  ↑↓ move · enter expand · esc close│
╰────────────────────────────────────────────────────────────────────────────────────╯
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
code-review trace <run-id> <unit>   # print a unit's timeline (--json for payloads)
code-review config                  # show the configuration a run would use
code-review init                    # write a config by answering four questions
code-review auth                    # show which credentials were found
code-review login openai-codex      # sign in with a ChatGPT plan instead of a key
code-review dismissed <pr-url>      # what this repository has already rejected
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
| [How a review runs](docs/how-it-works.zh.md) | The mechanism, following two real findings end to end |
| [Verify it yourself](docs/verify.zh.md) | Every claim above, as a command to run |
| [Configuration](docs/configuration.zh.md) | Every flag and field, credentials, adding a tool |
| [Design notes](docs/design.zh.md) | The tradeoffs, and what each one gave up |
| [`examples/`](examples/) | Real artifacts: [report](examples/sample-report.en.md) · [trace](examples/sample-trace.jsonl) · [checkpoint](examples/sample-state.json) |

The documents are in Chinese; the examples are not.

---

## Development

```bash
npm test              # 301 tests, fully offline, no API key needed
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
