# 代码评审报告 — demo: add cache eviction, session lookup, and retry helper

| | |
| --- | --- |
| **拉取请求** | [yanmxa/code-review/pull/1](https://github.com/yanmxa/code-review/pull/1) |
| **分支** | `demo/planted-defects` → `main` |
| **Head** | `3a8205bd48` |
| **CI** | ✅ success |
| **已评审文件** | 4 / 4 |
| **花费** | ¥0.40 / ¥6.00 (12.2k tokens) |
| **使用的模型** | `openai/gpt-5.4` |
| **Run** | `89acc558042e` |

## 概览

共 11 条发现：7 条有确定性证据支撑、可直接采纳，4 条为模型推断、供参考。 其中 3 条为阻断级，建议合并前处理。

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

## 💭 仅供参考（模型推断） (4)

### F-008 · ○ `demo/src/config.ts:5` — 提交中硬编码了 AWS secret access key

**阻断** · 仅供参考

`awsSecretAccessKey` 被直接写入源码，会使任何能访问仓库或构建产物的人获得长期凭证。这类密钥应从提交历史中移除并立即轮换，运行时改为通过环境变量或密钥管理服务注入。

<details><summary>证据 · 追踪: `traces/demo_src_config.ts.jsonl`</summary>

- 模型推断：差异中新增了一条明显的 AWS secret access key；自动检查已覆盖上一行的 access key id，但这一行同样是需要单独处理的凭证泄露。

</details>

### F-009 · ○ `demo/src/cache.ts:11-13` — 满容量时更新已有 key 会错误驱逐其他缓存项

**重要** · 仅供参考

这里在 `size >= max` 时先执行驱逐，但没有先判断 `key` 是否已经存在。这样当缓存已满且调用 `set` 只是更新一个已有 key 时，也会把最旧的另一项删掉，导致无关数据被意外驱逐。应先检查 `this.map.has(key)`，只有插入新 key 且容量已满时才淘汰旧项。

<details><summary>证据 · 追踪: `traces/demo_src_cache.ts.jsonl`</summary>

- 模型推断：结合文件上下文可见 `set` 既用于新增也用于更新；当前新增的驱逐逻辑对这两种情况一视同仁，因此在更新已有键时会触发错误淘汰。

</details>

### F-010 · ○ `demo/src/retry.ts:3` — 重试次数循环存在 off-by-one，实际会多执行一次

**重要** · 仅供参考

这里使用 `i <= attempts` 会让 `fn` 最多执行 `attempts + 1` 次；例如默认值 `attempts = 3` 时会尝试 4 次。函数名和参数名都表明 `attempts` 表示总尝试次数，因此这会让调用方在失败场景下多发一次请求/写操作。建议改为 `i < attempts`，或者把参数重命名为 `retries` 来匹配当前行为。

<details><summary>证据 · 追踪: `traces/demo_src_retry.ts.jsonl`</summary>

- 模型推断：直接根据循环边界和默认参数推导：`i` 从 0 开始且包含上界，会比声明的 attempts 多执行一次。

</details>

### F-011 · ○ `demo/src/session.ts:15` — 吞掉数据库异常会把失败伪装成“未找到会话”

**重要** · 仅供参考

这里的 `catch` 为空，`db.query(...)` 失败时 `loadSession` 会静默返回 `undefined`。调用方将无法区分“没有 session”与“数据库出错”，这会掩盖真实故障并让上层继续在错误状态下运行。至少应重新抛出异常，或返回一个明确的错误结果。

<details><summary>证据 · 追踪: `traces/demo_src_session.ts.jsonl`</summary>

- 模型推断：通读该文件可见 `loadSession` 在 `catch` 分支没有任何返回或抛出，因此 Promise 会以 `undefined` 成功结束，改变了错误处理语义。

</details>

## 附录

### 花费

| 模型 | 调用 | 输入 token | 输出 token | USD |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-5.4` | 10 | 10,281 | 1,877 | 0.0558 |
| **合计** | **10** | **10,281** | **1,877** | **0.0558** |

### 脱敏统计

以下内容在发送给模型之前已被替换为占位符，原值从未离开本机。

- `aws-access-key` × 1
- `high-entropy` × 119

---

_由 code-review 生成 · 2026-08-08T13:52:32.074Z_
