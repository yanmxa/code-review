# 代码评审报告 — Add cache eviction, session lookup, and retry helper

| | |
| --- | --- |
| **拉取请求** | [yanmxa/pi-review-demo/pull/1](https://github.com/yanmxa/pi-review-demo/pull/1) |
| **分支** | `feature/add-eviction-and-auth` → `main` |
| **Head** | `fb24853f81` |
| **已评审文件** | 4 / 4 |
| **花费** | ¥0.41 / ¥6.00 ($0.0569) |
| **使用的模型** | `openai/gpt-5.4` |
| **Run** | `a537f800fa76` |

## 概览

共 9 条发现：5 条有确定性证据支撑、可直接采纳，4 条为模型推断、供参考。 其中 2 条为阻断级，建议合并前处理。

## ✅ 可直接采纳（有确定性证据） (5)

### F-001 · ● `src/config.ts:4` — 提交中包含疑似密钥

**阻断** · 可直接采纳

这一行被密钥扫描器判定为 `aws-access-key`（内容已在传给模型前脱敏）。请从代码中移除，改用环境变量或密钥管理服务，并**轮换该凭据**——它已经进入了 git 历史。

<details><summary>证据 · 追踪: `traces/src_config.ts.jsonl`</summary>

- 确定性规则 `secret-in-diff` 命中 `src/config.ts:4`：`awsAccessKeyId: "[REDACTED:aws-access-key:1a5d]",`

</details>

### F-002 · ● `src/session.ts:14` — SQL 语句拼接变量

**阻断** · 可直接采纳

把变量拼进 SQL 会引入注入风险。请使用参数化查询（占位符 + 参数数组），而不是字符串拼接或模板串。

<details><summary>证据 · 追踪: `traces/src_session.ts.jsonl`</summary>

- 确定性规则 `sql-string-concat` 命中 `src/session.ts:14`：`return await db.query("SELECT * FROM sessions WHERE user_id = '" + userId + "'");`

</details>

### F-003 · ● `src/session.ts:8` — 用非密码学随机数生成标识符

**重要** · 可直接采纳

`Math.random()` / `random` 模块的输出是可预测的。如果这个值被用作 session token、密码、nonce 或 salt，攻击者可以推算出它——请改用 `crypto.randomUUID()`、`crypto.getRandomValues()` 或 Python 的 `secrets`。若仅作非安全用途的标识符，可以忽略本条。

<details><summary>证据 · 追踪: `traces/src_session.ts.jsonl`</summary>

- 确定性规则 `insecure-random` 命中 `src/session.ts:8`：`return Math.random().toString(36).slice(2) + Date.now().toString(36);`

</details>

### F-004 · ● `src/cache.ts:15` — 新增了 console 日志

**次要** · 可直接采纳

新增的 `console.log`/`console.debug` 通常是调试残留。若确实需要日志，请使用项目的 logger。

<details><summary>证据 · 追踪: `traces/src_cache.ts.jsonl`</summary>

- 确定性规则 `console-log` 命中 `src/cache.ts:15`：`console.log("cache set", key);`

</details>

### F-005 · ● `src/session.ts:4` — 使用了宽松相等比较

**次要** · 可直接采纳

`==` / `!=` 会做类型转换，容易产生意外结果（如 `0 == ""` 为真）。除 `== null` 外请使用 `===` / `!==`。

<details><summary>证据 · 追踪: `traces/src_session.ts.jsonl`</summary>

- 确定性规则 `loose-equality` 命中 `src/session.ts:4`：`return sessions.find((s) => s.id == id);`

</details>

## 💭 仅供参考（模型推断） (4)

### F-006 · ○ `src/cache.ts:11-13` — 满容量时覆盖已有 key 会误删其他缓存项

**重要** · 仅供参考

这里在 `size >= max` 时先驱逐最旧项，但没有先判断 `key` 是否已存在。结果是在缓存已满时执行 `set` 更新已有 key（尤其是非最旧 key）会先删掉别的条目，而这次更新本来并不会增加容量。应先处理已有 key 的更新，只有插入新 key 且超限时才驱逐。

<details><summary>证据 · 追踪: `traces/src_cache.ts.jsonl`</summary>

- 模型推断：从文件可见 `set` 在任何满容量写入前都会驱逐，而 `Map#set` 更新已有 key 不会增加 size，因此会造成不必要的数据丢失。

</details>

### F-007 · ○ `src/cache.ts:12` — 当前驱逐策略按插入顺序删除，和“LRU-style eviction”不一致

**重要** · 仅供参考

`Map.keys().next().value` 取到的是最早插入的 key，而 `get()` 只是读取值、不会刷新其“最近使用”顺序，所以热点数据也会被优先驱逐。这会把实现退化成 FIFO，而不是描述里的 LRU。若要做 LRU，至少需要在命中 `get` 时把 key 重新插入，或维护独立的访问顺序。

<details><summary>证据 · 追踪: `traces/src_cache.ts.jsonl`</summary>

- 模型推断：读取完整文件后，`get` 仅调用 `map.get`，没有任何 recency 更新；因此这里删除的是最早插入项，不是最久未使用项。

</details>

### F-008 · ○ `src/retry.ts:3` — 重试次数比 `attempts` 多执行了一次

**重要** · 仅供参考

这里的循环条件使用了 `i <= attempts`，会让 `fn` 总共执行 `attempts + 1` 次，而不是参数名通常表达的“最多执行 `attempts` 次”。例如默认值 `3` 实际会尝试 4 次，这会让调用方的重试预算、限流或幂等假设失效。建议改为 `i < attempts`，或者把参数改名为更明确的 `retries`。

<details><summary>证据 · 追踪: `traces/src_retry.ts.jsonl`</summary>

- 模型推断：阅读循环边界即可确认存在 off-by-one：初始 i=0，直到 i=attempts 都会进入循环。

</details>

### F-009 · ○ `src/session.ts:15` — 吞掉数据库异常会把真实故障伪装成“没有会话”

**重要** · 仅供参考

`catch` 里什么都不做会让 `loadSession` 在查询失败时解析为 `undefined`，而不是向调用方抛出错误。这样认证/会话相关代码很容易把数据库故障误判成“用户没有 session”，导致错误处理、告警和重试逻辑全部失效。至少应当重新抛出异常，或返回一个明确的失败结果。

<details><summary>证据 · 追踪: `traces/src_session.ts.jsonl`</summary>

- 模型推断：阅读 `loadSession` 可见 `try` 中 `return` 了查询结果，但 `catch` 为空，因此任何 `db.query` 异常都会被静默吞掉并改变函数的失败语义。

</details>

## 附录

### 花费

| 模型 | 调用 | 输入 token | 输出 token | USD |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-5.4` | 8 | 8,467 | 2,279 | 0.0569 |
| **合计** | **8** | **8,467** | **2,279** | **0.0569** |

### 脱敏统计

以下内容在发送给模型之前已被替换为占位符，原值从未离开本机。

- `aws-access-key` × 1

---

_由 pi-review 生成 · 2026-08-08T02:10:14.575Z_
