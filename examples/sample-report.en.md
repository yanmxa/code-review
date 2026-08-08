# Code Review Report — demo: add cache eviction, session lookup, and retry helper

| | |
| --- | --- |
| **Pull request** | [yanmxa/code-review/pull/1](https://github.com/yanmxa/code-review/pull/1) |
| **Branch** | `demo/planted-defects` → `main` |
| **Head** | `3a8205bd48` |
| **CI** | ✅ success |
| **Files reviewed** | 4 / 4 |
| **Spend** | ¥0.30 / ¥6.00 (10.0k tokens) |
| **Models used** | `openai/gpt-5.4` |
| **Run** | `89acc558042e` |

## Summary

10 finding(s): 7 backed by deterministic evidence and directly adoptable, 3 from model reasoning and offered as suggestions. 2 of them are blockers and should be resolved before merging.

## ✅ Directly adoptable (backed by deterministic evidence) (7)

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

### F-005 · ● `demo/src/retry.ts:1` — Changed without a matching test change

**minor** · adoptable

This change adds 8 lines of logic to `demo/src/retry.ts`, and the pull request does not touch any test file that appears to cover it. Ignore this if the behaviour is covered by a test that does not match on name — but it is worth confirming once.

<details><summary>Evidence · Trace: `traces/demo_src_retry.ts.jsonl`</summary>

- deterministic rule `no-test-change` matched `demo/src/retry.ts:1`: `export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {`

</details>

### F-006 · ● `demo/src/session.ts:4` — Changed without a matching test change

**minor** · adoptable

This change adds 8 lines of logic to `demo/src/session.ts`, and the pull request does not touch any test file that appears to cover it. Ignore this if the behaviour is covered by a test that does not match on name — but it is worth confirming once.

<details><summary>Evidence · Trace: `traces/demo_src_session.ts.jsonl`</summary>

- deterministic rule `no-test-change` matched `demo/src/session.ts:4`: `return sessions.find((s) => s.id == id);`

</details>

### F-007 · ● `demo/src/session.ts:4` — Loose equality comparison

**minor** · adoptable

`==` / `!=` coerce types and produce surprising results (`0 == ""` is true). Prefer `===` / `!==` outside the `== null` idiom.

<details><summary>Evidence · Trace: `traces/demo_src_session.ts.jsonl`</summary>

- deterministic rule `loose-equality` matched `demo/src/session.ts:4`: `return sessions.find((s) => s.id == id);`

</details>

## 💭 For reference (model reasoning) (3)

### F-008 · ○ `demo/src/cache.ts:11-13` — Eviction runs even when updating an existing cache key

**major** · reference

When the cache is full, `set()` now evicts the oldest entry before every write. If `key` is already present, this turns a simple update into an unnecessary eviction of some *other* entry, so the cache loses data even though its size would have stayed the same. Guard the eviction with `!this.map.has(key)` so only inserts trigger eviction.

<details><summary>Evidence · Trace: `traces/demo_src_cache.ts.jsonl`</summary>

- model reasoning: Reading the full class shows `set()` can both insert and update entries; only inserts should evict at capacity.

</details>

### F-009 · ○ `demo/src/retry.ts:3` — Retry loop runs one more attempt than requested

**major** · reference

The loop condition uses `<= attempts`, so `withRetry(fn, 3)` can call `fn` **4 times** instead of 3. That changes the contract of the helper and can trigger duplicated side effects or exceed rate limits; iterate while `i < attempts` if `attempts` is meant to be the total number of tries.

**Suggested change**

```suggestion
for (let i = 0; i < attempts; i++) {
```

<details><summary>Evidence · Trace: `traces/demo_src_retry.ts.jsonl`</summary>

- model reasoning: Starting `i` at 0 and continuing through `i === attempts` yields `attempts + 1` executions.

</details>

### F-010 · ○ `demo/src/session.ts:15-16` — Database errors are silently swallowed

**major** · reference

If `db.query(...)` throws, this `catch` block returns `undefined` and hides the failure from callers. That makes real database problems look like "no session found" and can let the application continue with incorrect state; rethrow the error or translate it into an explicit failure result instead of ignoring it.

<details><summary>Evidence · Trace: `traces/demo_src_session.ts.jsonl`</summary>

- model reasoning: The full file shows an empty `catch` block, so `loadSession` resolves successfully with `undefined` on query failure rather than surfacing the exception.

</details>

## Appendix

### Spend

| Model | Calls | Input tokens | Output tokens | USD |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-5.4` | 8 | 8,740 | 1,214 | 0.0412 |
| **Total** | **8** | **8,740** | **1,214** | **0.0412** |

### Redaction summary

These were replaced with placeholders before anything was sent to a model; the original values never left this machine.

- `aws-access-key` × 1
- `high-entropy` × 53

---

_Generated by code-review · 2026-08-08T14:39:48.996Z_
