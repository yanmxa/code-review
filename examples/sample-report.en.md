# Code Review Report — demo: add cache eviction, session lookup, and retry helper

| | |
| --- | --- |
| **Pull request** | [yanmxa/code-review/pull/1](https://github.com/yanmxa/code-review/pull/1) |
| **Branch** | `demo/planted-defects` → `main` |
| **Head** | `b5afa3ffb7` |
| **Files reviewed** | 4 / 4 |
| **Spend** | ¥0.25 / ¥6.00 (5.6k tokens) |
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

### F-006 · ○ `demo/src/cache.ts:11-13` — Eviction runs even when updating an existing key

**major** · reference

When the cache is full, this branch deletes the oldest entry before checking whether `key` is already present. Updating an existing entry should not grow the map, but with the current logic it still evicts another item and leaves the cache one slot under capacity. Only evict when `!this.map.has(key)` and the insert would actually increase the size.

<details><summary>Evidence · Trace: `traces/demo_src_cache.ts.jsonl`</summary>

- model reasoning: Reading the full file shows `set` always performs the eviction check before `map.set`, so a full cache drops an entry even for pure updates.

</details>

### F-007 · ○ `demo/src/retry.ts:3` — Retry loop performs one more attempt than requested

**major** · reference

The loop condition uses `<= attempts`, so `withRetry(fn, 3)` can call `fn` **4 times** instead of 3. That changes the contract of the helper and can cause duplicate side effects or exceed rate limits; stop once `i` reaches `attempts`.

**Suggested change**

```suggestion
for (let i = 0; i < attempts; i++) {
```

<details><summary>Evidence · Trace: `traces/demo_src_retry.ts.jsonl`</summary>

- model reasoning: The loop starts at 0, so using `<= attempts` executes for indices 0 through `attempts` inclusive, which is `attempts + 1` iterations.

</details>

### F-008 · ○ `demo/src/session.ts:15-16` — Database failures are silently turned into `undefined`

**major** · reference

This empty `catch` causes `loadSession()` to resolve successfully with `undefined` whenever the query throws. Callers can no longer distinguish "session not found" from "database unavailable", which will mask outages and can lead to incorrect authentication flow. Re-throw the error or convert it into an explicit error result instead of swallowing it.

<details><summary>Evidence · Trace: `traces/demo_src_session.ts.jsonl`</summary>

- model reasoning: Reading the function shows that the `catch` block has no return or throw, so any exception from `db.query(...)` is suppressed and the async function resolves `undefined`.

</details>

## Appendix

### Spend

| Model | Calls | Input tokens | Output tokens | USD |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-5.4` | 8 | 4,082 | 1,480 | 0.0351 |
| **Total** | **8** | **4,082** | **1,480** | **0.0351** |

### Redaction summary

These were replaced with placeholders before anything was sent to a model; the original values never left this machine.

- `aws-access-key` × 1
- `high-entropy` × 58

---

_Generated by code-review · 2026-08-08T03:46:31.322Z_
