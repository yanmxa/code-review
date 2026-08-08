# Code Review Report — demo: add cache eviction, session lookup, and retry helper

| | |
| --- | --- |
| **Pull request** | [yanmxa/code-review/pull/1](https://github.com/yanmxa/code-review/pull/1) |
| **Branch** | `demo/planted-defects` → `main` |
| **Head** | `3a8205bd48` |
| **CI** | ✅ success |
| **Files reviewed** | 4 / 4 |
| **Spend** | ¥0.32 / ¥6.00 (10.3k tokens) |
| **Models used** | `openai/gpt-5.4` |
| **Run** | `89acc558042e` |

## Summary

9 finding(s): 6 backed by deterministic evidence and directly adoptable, 3 from model reasoning and offered as suggestions. 2 of them are blockers and should be resolved before merging.

## ✅ Directly adoptable (backed by deterministic evidence) (6)

### F-001 · ● `demo/src/config.ts:4` — Credential committed in this change

**blocker** · adoptable

The secret scanner classified this line as `aws-access-key` (the value was masked before any model saw it). Remove it from the code, move it to an environment variable or secret manager, and **rotate the credential** — it is already in git history.

<details><summary>Evidence · Trace: `traces/demo_src_config.ts.jsonl`</summary>

- deterministic rule `secret-in-diff` matched `demo/src/config.ts:4`: `awsAccessKeyId: "[REDACTED:aws-access-key:1a5d]",`

</details>

### F-002 · ● `demo/src/session.ts:14` — SQL built by string concatenation

**blocker** · adoptable

Interpolating a variable into SQL opens an injection hole. Use a parameterized query with placeholders instead of concatenation or template literals.

<details><summary>Evidence · Trace: `traces/demo_src_session.ts.jsonl`</summary>

- deterministic rule `sql-string-concat` matched `demo/src/session.ts:14`: `return await db.query("SELECT * FROM sessions WHERE user_id = '" + userId + "'");`

</details>

### F-003 · ● `demo/src/session.ts:8` — Non-cryptographic randomness for an identifier

**major** · adoptable

`Math.random()` and the `random` module produce predictable output. If this value is used as a session token, password, nonce, or salt, an attacker can derive it — use `crypto.randomUUID()`, `crypto.getRandomValues()`, or Python's `secrets`. Ignore this if the value is only a non-security identifier.

<details><summary>Evidence · Trace: `traces/demo_src_session.ts.jsonl`</summary>

- deterministic rule `insecure-random` matched `demo/src/session.ts:8`: `return Math.random().toString(36).slice(2) + Date.now().toString(36);`

</details>

### F-004 · ● `demo/src/cache.ts:15` — New `console` logging

**minor** · adoptable

A new `console.log`/`console.debug` is usually debugging residue. Use the project's logger if the output is intended.

<details><summary>Evidence · Trace: `traces/demo_src_cache.ts.jsonl`</summary>

- deterministic rule `console-log` matched `demo/src/cache.ts:15`: `console.log("cache set", key);`

</details>

### F-005 · ● `demo/src/session.ts:4` — Changed without a matching test change

**minor** · adoptable

This change adds 8 lines of logic to `demo/src/session.ts`, and the pull request does not touch any test file that appears to cover it. Ignore this if the behaviour is covered by a test that does not match on name — but it is worth confirming once.

<details><summary>Evidence · Trace: `traces/demo_src_session.ts.jsonl`</summary>

- deterministic rule `no-test-change` matched `demo/src/session.ts:4`: `return sessions.find((s) => s.id == id);`

</details>

### F-006 · ● `demo/src/session.ts:4` — Loose equality comparison

**minor** · adoptable

`==` / `!=` coerce types and produce surprising results (`0 == ""` is true). Prefer `===` / `!==` outside the `== null` idiom.

<details><summary>Evidence · Trace: `traces/demo_src_session.ts.jsonl`</summary>

- deterministic rule `loose-equality` matched `demo/src/session.ts:4`: `return sessions.find((s) => s.id == id);`

</details>

## 💭 For reference (model reasoning) (3)

### F-007 · ○ `demo/src/cache.ts:11-13` — Eviction runs even when overwriting an existing key

**major** · reference

When the cache is full, `set` evicts an entry before it knows whether `key` is already present. Updating an existing key at capacity should keep the same number of entries, but this branch removes the oldest item anyway and shrinks the effective cache contents by one. Guard the eviction with `!this.map.has(key)` so replacement updates do not discard unrelated entries.

<details><summary>Evidence · Trace: `traces/demo_src_cache.ts.jsonl`</summary>

- model reasoning: Reading the full file shows `set` always evicts on `size >= max` and only checks/updates the target key afterward, so overwrites at capacity incorrectly delete another entry.

</details>

### F-008 · ○ `demo/src/retry.ts:3` — Retries one more time than the `attempts` parameter promises

**major** · reference

The loop condition uses `i <= attempts`, so `withRetry(fn, 3)` will call `fn` **4** times before failing. Callers will reasonably expect `attempts` to be the total number of tries here, so this silently changes retry budgets and can amplify load on flaky dependencies. Change the condition to `i < attempts` if `attempts` is meant to be the maximum number of attempts.

**Suggested change**

```suggestion
for (let i = 0; i < attempts; i++) {
```

<details><summary>Evidence · Trace: `traces/demo_src_retry.ts.jsonl`</summary>

- model reasoning: Reading the loop bounds shows an off-by-one error: starting at 0 and continuing while `i <= attempts` produces `attempts + 1` iterations.

</details>

### F-009 · ○ `demo/src/session.ts:15-16` — Database failures are silently converted into a successful `undefined` result

**major** · reference

The empty `catch` block swallows every query error and lets `loadSession` resolve with `undefined`. That makes connection/query failures indistinguishable from “no session found”, so callers can continue with incorrect state instead of handling the database error. Re-throw the exception or translate it into an explicit error result.

<details><summary>Evidence · Trace: `traces/demo_src_session.ts.jsonl`</summary>

- model reasoning: Reading the changed function shows that any exception from `db.query(...)` is caught and ignored, and the async function then falls through without returning a value.

</details>

## Appendix

### Spend

| Model | Calls | Input tokens | Output tokens | USD |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-5.4` | 7 | 8,875 | 1,391 | 0.0438 |
| **Total** | **7** | **8,875** | **1,391** | **0.0438** |

### Redaction summary

These were replaced with placeholders before anything was sent to a model; the original values never left this machine.

- `aws-access-key` × 1
- `high-entropy` × 69

---

_Generated by code-review · 2026-08-08T13:53:27.066Z_
