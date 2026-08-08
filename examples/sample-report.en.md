# Code Review Report — demo: add cache eviction, session lookup, and retry helper

| | |
| --- | --- |
| **Pull request** | [yanmxa/code-review/pull/1](https://github.com/yanmxa/code-review/pull/1) |
| **Branch** | `demo/planted-defects` → `main` |
| **Head** | `b5afa3ffb7` |
| **Files reviewed** | 4 / 4 |
| **Spend** | ¥0.31 / ¥6.00 ($0.0430) |
| **Models used** | `openai/gpt-5.4` |
| **Run** | `2a008cf0e899` |

## Summary

8 finding(s): 5 backed by deterministic evidence and directly adoptable, 3 from model reasoning and offered as suggestions. 2 of them are blockers and should be resolved before merging.

## ✅ Directly adoptable (backed by deterministic evidence) (5)

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

### F-005 · ● `demo/src/session.ts:4` — Loose equality comparison

**minor** · adoptable

`==` / `!=` coerce types and produce surprising results (`0 == ""` is true). Prefer `===` / `!==` outside the `== null` idiom.

<details><summary>Evidence · Trace: `traces/demo_src_session.ts.jsonl`</summary>

- deterministic rule `loose-equality` matched `demo/src/session.ts:4`: `return sessions.find((s) => s.id == id);`

</details>

## 💭 For reference (model reasoning) (3)

### F-006 · ○ `demo/src/cache.ts:11-13` — Eviction runs even when overwriting an existing key

**major** · reference

This condition evicts an entry whenever the cache is full, even if `set` is only updating a key that is already present. For example, with a full cache containing `a` and `b`, calling `set("b", nextValue)` will first delete `a`, which incorrectly drops an unrelated entry. Only evict when `key` is not already in the map.

<details><summary>Evidence · Trace: `traces/demo_src_cache.ts.jsonl`</summary>

- model reasoning: Reading the full file shows `set` unconditionally evicts on `size >= max` before checking whether the incoming key already exists, so updates at capacity lose an extra entry.

</details>

### F-007 · ○ `demo/src/retry.ts:3` — Retry loop performs one more attempt than requested

**major** · reference

The loop condition `i <= attempts` calls `fn()` `attempts + 1` times, so `attempts = 3` results in 4 executions. That breaks the helper's contract and can duplicate side effects or exceed rate limits. Change the condition to `< attempts` if `attempts` is meant to be the total number of tries.

**Suggested change**

```suggestion
for (let i = 0; i < attempts; i++) {
```

<details><summary>Evidence · Trace: `traces/demo_src_retry.ts.jsonl`</summary>

- model reasoning: Counting the iterations shows the loop runs for `i = 0, 1, ..., attempts`, which is one more execution than the API name and default value imply.

</details>

### F-008 · ○ `demo/src/session.ts:15-16` — Database failures are silently turned into “no session”

**major** · reference

The empty `catch` swallows every query error and lets `loadSession()` resolve to `undefined`. That makes a database outage indistinguishable from a missing session, so callers can continue with incorrect state instead of handling the failure. Re-throw the error (or return an explicit error result) so lookup failures are not hidden.

<details><summary>Evidence · Trace: `traces/demo_src_session.ts.jsonl`</summary>

- model reasoning: Reading the full file shows the `catch` block is empty, so any exception from `db.query(...)` is suppressed and the async function falls through without a return value.

</details>

## Appendix

### Spend

| Model | Calls | Input tokens | Output tokens | USD |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-5.4` | 8 | 9,056 | 1,255 | 0.0430 |
| **Total** | **8** | **9,056** | **1,255** | **0.0430** |

### Redaction summary

These were replaced with placeholders before anything was sent to a model; the original values never left this machine.

- `aws-access-key` × 1
- `high-entropy` × 69

---

_Generated by code-review · 2026-08-08T02:29:05.035Z_
