# 代码评审报告 — demo: add cache eviction, session lookup, and retry helper

| | |
| --- | --- |
| **拉取请求** | [yanmxa/code-review/pull/1](https://github.com/yanmxa/code-review/pull/1) |
| **分支** | `demo/planted-defects` → `main` |
| **Head** | `3a8205bd48` |
| **CI** | ✅ success |
| **已评审文件** | 4 / 4 |
| **花费** | ¥0.33 / ¥6.00 (9.5k tokens) |
| **使用的模型** | `openai/gpt-5.4` |
| **Run** | `89acc558042e` |

## 概览

共 10 条发现：7 条有确定性证据支撑、可直接采纳，3 条为模型推断、供参考。 其中 2 条为阻断级，建议合并前处理。

## ✅ 可直接采纳（有确定性证据） (7)

### F-001 · ● `demo/src/config.ts:4` — 提交中包含疑似密钥

**阻断** · 可直接采纳

这一行被密钥扫描器判定为 `aws-access-key`（内容已在传给模型前脱敏）。请从代码中移除，改用环境变量或密钥管理服务，并**轮换该凭据**——它已经进入了 git 历史。

<details><summary>证据 · 追踪: `traces/demo_src_config.ts.jsonl`</summary>

- 确定性规则 `secret-in-diff` 命中 `demo/src/config.ts:4`：`awsAccessKeyId: "[REDACTED:aws-access-key:1a5d]",`

</details>

### F-002 · ● `demo/src/session.ts:14` — SQL 语句拼接变量

**阻断** · 可直接采纳

把变量拼进 SQL 会引入注入风险。请使用参数化查询（占位符 + 参数数组），而不是字符串拼接或模板串。

<details><summary>证据 · 追踪: `traces/demo_src_session.ts.jsonl`</summary>

- 确定性规则 `sql-string-concat` 命中 `demo/src/session.ts:14`：`return await db.query("SELECT * FROM sessions WHERE user_id = '" + userId + "'");`

</details>

### F-003 · ● `demo/src/session.ts:8` — 用非密码学随机数生成标识符

**重要** · 可直接采纳

`Math.random()` / `random` 模块的输出是可预测的。如果这个值被用作 session token、密码、nonce 或 salt，攻击者可以推算出它——请改用 `crypto.randomUUID()`、`crypto.getRandomValues()` 或 Python 的 `secrets`。若仅作非安全用途的标识符，可以忽略本条。

<details><summary>证据 · 追踪: `traces/demo_src_session.ts.jsonl`</summary>

- 确定性规则 `insecure-random` 命中 `demo/src/session.ts:8`：`return Math.random().toString(36).slice(2) + Date.now().toString(36);`

</details>

### F-004 · ● `demo/src/cache.ts:15` — 新增了 console 日志

**次要** · 可直接采纳

新增的 `console.log`/`console.debug` 通常是调试残留。若确实需要日志，请使用项目的 logger。

<details><summary>证据 · 追踪: `traces/demo_src_cache.ts.jsonl`</summary>

- 确定性规则 `console-log` 命中 `demo/src/cache.ts:15`：`console.log("cache set", key);`

</details>

### F-005 · ● `demo/src/retry.ts:1` — 改动没有配套的测试变更

**次要** · 可直接采纳

这次改动为 `demo/src/retry.ts` 新增了 8 行逻辑，但本 PR 没有改动任何看起来覆盖它的测试文件。如果这段逻辑已被其他测试覆盖（或按文件名匹配不到），可以忽略本条——但它值得确认一次。

<details><summary>证据 · 追踪: `traces/demo_src_retry.ts.jsonl`</summary>

- 确定性规则 `no-test-change` 命中 `demo/src/retry.ts:1`：`export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {`

</details>

### F-006 · ● `demo/src/session.ts:4` — 改动没有配套的测试变更

**次要** · 可直接采纳

这次改动为 `demo/src/session.ts` 新增了 8 行逻辑，但本 PR 没有改动任何看起来覆盖它的测试文件。如果这段逻辑已被其他测试覆盖（或按文件名匹配不到），可以忽略本条——但它值得确认一次。

<details><summary>证据 · 追踪: `traces/demo_src_session.ts.jsonl`</summary>

- 确定性规则 `no-test-change` 命中 `demo/src/session.ts:4`：`return sessions.find((s) => s.id == id);`

</details>

### F-007 · ● `demo/src/session.ts:4` — 使用了宽松相等比较

**次要** · 可直接采纳

`==` / `!=` 会做类型转换，容易产生意外结果（如 `0 == ""` 为真）。除 `== null` 外请使用 `===` / `!==`。

<details><summary>证据 · 追踪: `traces/demo_src_session.ts.jsonl`</summary>

- 确定性规则 `loose-equality` 命中 `demo/src/session.ts:4`：`return sessions.find((s) => s.id == id);`

</details>

## 💭 仅供参考（模型推断） (3)

### F-008 · ○ `demo/src/cache.ts:11` — 更新已存在的 key 时也会触发淘汰，导致错误删除其他缓存项

**重要** · 仅供参考

这里在 `this.map.size >= this.max` 时无条件删除最旧项，但 `Map#set` 更新一个已存在的 `key` 并不会增加容量。结果是在缓存已满时写入已有键，会先删掉别的键，再覆盖当前键，最终把缓存条目数意外减少 1。应先判断 `key` 是否已存在，只在插入新键且容量已满时才执行淘汰。

<details><summary>证据 · 追踪: `traces/demo_src_cache.ts.jsonl`</summary>

- 模型推断：读取文件可见 `set` 在任何满容量写入时都会先删最旧项，而随后 `this.map.set(key, value)` 可能只是更新已有项，不会新增元素。

</details>

### F-009 · ○ `demo/src/retry.ts:3` — 重试次数循环存在 off-by-one，实际会多执行一次

**重要** · 仅供参考

当前条件 `i <= attempts` 会让 `fn` 在 `attempts = 3` 时最多执行 4 次，而不是通常语义下的 3 次尝试。这会导致额外的副作用或超时，尤其当 `fn` 不是幂等操作时更危险。建议改为 `i < attempts`，或者明确把参数重命名为 `retries` 以匹配现有实现。

**建议改法**

```suggestion
for (let i = 0; i < attempts; i++) {
```

<details><summary>证据 · 追踪: `traces/demo_src_retry.ts.jsonl`</summary>

- 模型推断：从循环边界可直接推导出当 attempts 为 N 时，i 会取到 0..N，共执行 N+1 次。

</details>

### F-010 · ○ `demo/src/session.ts:15` — 吞掉数据库异常会把失败伪装成“未找到会话”

**重要** · 仅供参考

`catch` 里什么都不做会让 `loadSession` 在查询失败时直接返回 `undefined`，调用方无法区分“没有会话”和“数据库出错”，容易继续按正常流程运行并隐藏真实故障。至少应当重新抛出异常，或返回一个明确的错误结果让上层处理。

<details><summary>证据 · 追踪: `traces/demo_src_session.ts.jsonl`</summary>

- 模型推断：从文件内容可见 `catch` 块为空，函数也没有在错误分支返回任何值，因此查询异常会被静默吞掉并导致隐式返回 `undefined`。

</details>

## 附录

### 花费

| 模型 | 调用 | 输入 token | 输出 token | USD |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-5.4` | 9 | 7,906 | 1,568 | 0.0452 |
| **合计** | **9** | **7,906** | **1,568** | **0.0452** |

### 脱敏统计

以下内容在发送给模型之前已被替换为占位符，原值从未离开本机。

- `aws-access-key` × 1
- `high-entropy` × 92

---

_由 code-review 生成 · 2026-08-08T14:42:09.434Z_
