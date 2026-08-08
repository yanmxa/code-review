# 代码评审报告 — demo: add cache eviction, session lookup, and retry helper

| | |
| --- | --- |
| **拉取请求** | [yanmxa/code-review/pull/1](https://github.com/yanmxa/code-review/pull/1) |
| **分支** | `demo/planted-defects` → `main` |
| **Head** | `b5afa3ffb7` |
| **已评审文件** | 4 / 4 |
| **花费** | ¥0.28 / ¥6.00 (5.0k tokens) |
| **使用的模型** | `openai/gpt-5.4` |
| **Run** | `2a008cf0e899` |

## 概览

共 9 条发现：5 条有确定性证据支撑、可直接采纳，4 条为模型推断、供参考。 其中 2 条为阻断级，建议合并前处理。

## ✅ 可直接采纳（有确定性证据） (5)

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

### F-005 · ● `demo/src/session.ts:4` — 使用了宽松相等比较

**次要** · 可直接采纳

`==` / `!=` 会做类型转换，容易产生意外结果（如 `0 == ""` 为真）。除 `== null` 外请使用 `===` / `!==`。

<details><summary>证据 · 追踪: `traces/demo_src_session.ts.jsonl`</summary>

- 确定性规则 `loose-equality` 命中 `demo/src/session.ts:4`：`return sessions.find((s) => s.id == id);`

</details>

## 💭 仅供参考（模型推断） (4)

### F-006 · ○ `demo/src/cache.ts:11-13` — 更新已存在的 key 时会错误驱逐其他缓存项

**重要** · 仅供参考

这里在 `size >= max` 时无条件删除最旧项，但 `Map.set` 覆盖一个已存在的 key 并不会增加容量。结果是在缓存已满时更新现有 key，也会平白删掉另一条记录，导致缓存内容丢失。应先判断 `key` 是否已存在，只在插入新 key 且容量已满时才执行驱逐。

<details><summary>证据 · 追踪: `traces/demo_src_cache.ts.jsonl`</summary>

- 模型推断：我查看了完整文件，`set` 是唯一的写入口；当前逻辑在满容量时先驱逐、后 `set`，没有区分“新增”与“覆盖”两种情况，因此会在覆盖现有键时错误删除其他条目。

</details>

### F-007 · ○ `demo/src/config.ts:4` — 源码中新增了云凭证配置项

**重要** · 仅供参考

这里把 `awsSecretAccessKey` 直接放进了可提交的配置对象中；即使当前值是示例值，这种模式也会让真实凭证被复制进仓库，并且运行时也更难通过环境变量或密钥管理服务隔离不同环境。请改为从环境变量或专用的 secret manager 读取，并避免在默认配置里保留任何密钥字段。

<details><summary>证据 · 追踪: `traces/demo_src_config.ts.jsonl`</summary>

- 模型推断：这是一个明确的安全问题：把密钥字段作为源码中的静态配置提交，会鼓励并固化不安全的凭证管理方式。尽管自动检查已提示该行疑似密钥，这里的问题是该设计本身不应出现在代码中。

</details>

### F-008 · ○ `demo/src/retry.ts:3` — 重试次数存在 off-by-one，实际会多调用一次

**重要** · 仅供参考

当前循环条件 `i <= attempts` 会让 `fn` 最多执行 `attempts + 1` 次，因此默认值 `3` 实际会尝试 4 次。这会悄悄改变调用方对 `attempts` 参数的语义预期，并可能导致多一次副作用操作。应将条件改为 `< attempts`，或者把参数明确重命名为总尝试次数之外的“重试次数”。

**建议改法**

```suggestion
for (let i = 0; i < attempts; i++) {
```

<details><summary>证据 · 追踪: `traces/demo_src_retry.ts.jsonl`</summary>

- 模型推断：直接根据循环边界可知，当 `attempts = 3` 时，`i` 会取 0、1、2、3 共四次。

</details>

### F-009 · ○ `demo/src/session.ts:15-16` — 吞掉数据库异常会把真实故障伪装成“查无会话”

**重要** · 仅供参考

这里的 `catch` 块直接忽略了 `db.query(...)` 抛出的异常，导致 `loadSession` 在数据库失败时返回 `undefined`。调用方无法区分“没有 session”和“查询失败”，很容易继续按未登录/空结果处理，从而掩盖线上故障并绕过上层的重试或告警逻辑。至少应重新抛出异常，或返回一个显式的错误结果。

<details><summary>证据 · 追踪: `traces/demo_src_session.ts.jsonl`</summary>

- 模型推断：通读文件可见 `loadSession` 在 `catch` 中没有任何返回或抛错，因此 Promise 会以 `undefined` 成功结束，改变了失败路径的语义。

</details>

## 附录

### 花费

| 模型 | 调用 | 输入 token | 输出 token | USD |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-5.4` | 8 | 3,144 | 1,862 | 0.0389 |
| **合计** | **8** | **3,144** | **1,862** | **0.0389** |

### 脱敏统计

以下内容在发送给模型之前已被替换为占位符，原值从未离开本机。

- `aws-access-key` × 1
- `high-entropy` × 65

---

_由 code-review 生成 · 2026-08-08T03:45:10.905Z_
