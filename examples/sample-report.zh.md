# 代码评审报告 — demo: add cache eviction, session lookup, and retry helper

| | |
| --- | --- |
| **拉取请求** | [yanmxa/code-review/pull/1](https://github.com/yanmxa/code-review/pull/1) |
| **分支** | `demo/planted-defects` → `main` |
| **Head** | `b5afa3ffb7` |
| **已评审文件** | 4 / 4 |
| **花费** | ¥0.35 / ¥6.00 ($0.0490) |
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

这里在 `size >= max` 时无条件删除最旧项，但 `Map#set` 更新一个已存在的 `key` 并不会增加缓存大小。结果是在缓存已满时，只要写入的是一个已有 key，就会额外删掉另一条记录，导致缓存条目数比预期少 1。应先判断 `key` 是否已存在，只在插入新 key 且容量已满时再执行驱逐。

<details><summary>证据 · 追踪: `traces/demo_src_cache.ts.jsonl`</summary>

- 模型推断：阅读完整文件可知唯一的容量控制逻辑就在这里，而 `Map#set` 对已有键是覆盖不是新增，因此当前条件会在覆盖写时错误触发淘汰。

</details>

### F-007 · ○ `demo/src/config.ts:4` — 配置中硬编码了云服务凭证标识

**重要** · 仅供参考

`awsAccessKeyId` 被提交到源码后会把运行环境凭证与代码绑定，后续很容易被复制到其他环境或与仓库历史一起长期暴露。应改为从环境变量或密钥管理服务读取，并避免在示例配置里保留任何真实格式的凭证字段。

<details><summary>证据 · 追踪: `traces/demo_src_config.ts.jsonl`</summary>

- 模型推断：第 4 行新增了 `awsAccessKeyId` 常量配置；虽然访问密钥 ID 不等同于 secret，但它仍属于应从配置/密钥管理系统注入的凭证组成部分，不应硬编码进仓库。

</details>

### F-008 · ○ `demo/src/retry.ts:3` — 重试次数循环存在 off-by-one，实际会多执行一次

**重要** · 仅供参考

`for (let i = 0; i <= attempts; i++)` 会在 `attempts = 3` 时最多调用 `fn()` 4 次，而函数名和参数语义通常都表示“总尝试次数”为 3。这样会让调用方在限流、扣费或幂等性较弱的操作上多执行一次。应将条件改为 `< attempts`，或明确把参数重命名为 `retries`。

**建议改法**

```suggestion
for (let i = 0; i < attempts; i++) {
```

<details><summary>证据 · 追踪: `traces/demo_src_retry.ts.jsonl`</summary>

- 模型推断：直接根据新增代码可见，循环从 0 开始且使用 `<= attempts`，因此总迭代次数是 `attempts + 1`。

</details>

### F-009 · ○ `demo/src/session.ts:15-16` — 吞掉数据库异常会把故障伪装成“未找到会话”

**重要** · 仅供参考

这里的空 `catch` 会在查询失败时直接返回 `undefined`，调用方无法区分“没有 session”和“数据库出错”。这会把真实的基础设施故障静默降级成正常业务分支，导致鉴权/会话逻辑误判。至少应记录并重新抛出异常，或返回一个显式的错误结果。

<details><summary>证据 · 追踪: `traces/demo_src_session.ts.jsonl`</summary>

- 模型推断：通读文件可见 `loadSession` 在 `catch` 中没有任何处理；而 `try` 分支返回查询结果，因此异常路径会隐式返回 `undefined`，改变了函数契约并隐藏错误。

</details>

## 附录

### 花费

| 模型 | 调用 | 输入 token | 输出 token | USD |
| --- | ---: | ---: | ---: | ---: |
| `openai/gpt-5.4` | 7 | 8,853 | 1,712 | 0.0490 |
| **合计** | **7** | **8,853** | **1,712** | **0.0490** |

### 脱敏统计

以下内容在发送给模型之前已被替换为占位符，原值从未离开本机。

- `aws-access-key` × 1
- `high-entropy` × 70

---

_由 code-review 生成 · 2026-08-08T02:30:00.597Z_
