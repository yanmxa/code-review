# 一次评审是怎么跑完的

这份文档跟着**一条真实的发现**走完全程 —— 从 PR 里的一行代码，到 GitHub 上的一条评论 —— 沿途说明每一步收到什么、产出什么、以及为什么这么切分。

想看"为什么这样设计"的取舍论证，看 [设计文档](design.zh.md)。这里讲的是**机制**。

---

## 全景

```
                    ┌─────────────────────────────────────────────┐
   PR URL ─────────▶│ ① 取材   REST 拉 PR 元信息 + unified diff    │
                    │          + CI 状态与诊断（不 clone 仓库）      │
                    └────────────────────┬────────────────────────┘
                                         ▼
                    ┌─────────────────────────────────────────────┐
                    │ ② 脱敏   此后每个字符串都是 Redacted<string> │
                    └────────────────────┬────────────────────────┘
                                         ▼
                    ┌─────────────────────────────────────────────┐
                    │ ③ 切分   一个改动文件 = 一个评审单元          │
                    │          锁文件/二进制/生成物直接跳过          │
                    └────────────────────┬────────────────────────┘
                                         ▼
        ┌────────────────────── 逐单元、顺序 ──────────────────────┐
        │                                                          │
        │   ④ 规则扫描（零成本）──────────┐                        │
        │      只看 PR 新增的行            │                        │
        │      命中 → rule 证据            ├──▶ ⑥ 定级             │
        │                                  │      rule/static → 可采纳
        │   ⑤ Agent 循环（花钱）──────────┘      仅 llm    → 参考  │
        │      工具: get_file / search_diff                        │
        │           ts_syntax_check / submit_findings              │
        │      每次 LLM 调用穿过 meteredStream:                    │
        │        预算闸门 → 选模型 → 写 trace                       │
        │                                  ▼                       │
        │   ⑦ 去重 → 滤掉被否决的 → findings 落盘 → state 落盘      │
        │   ⑧ 重算预测 → 该降级就降级                               │
        │                                                          │
        └──────────────────────────┬───────────────────────────────┘
                                   ▼
                    ┌─────────────────────────────────────────────┐
                    │ ⑨ 全局去重 → 报告 / TUI 分诊 / 幂等回评      │
                    └─────────────────────────────────────────────┘
```

---

## 跟着一条发现走

用演示 PR 里真实存在的一条：`demo/src/session.ts` 用字符串拼接构造 SQL。

### 起点：PR 里的一行

```ts
return await db.query("SELECT * FROM sessions WHERE user_id = '" + userId + "'");
```

### ① 取材 —— `src/platform/github.ts`

三次 REST 调用，都不 clone：

| 调用 | 拿到什么 |
| --- | --- |
| `GET /pulls/{n}` | 标题、描述、分支、`head_sha` |
| 同上 + `Accept: …v3.diff` | 整个 PR 的 unified diff 原文 |
| `GET /commits/{sha}/check-runs` | CI 结论；失败时再取 annotations |

**为什么不 clone**：不 clone 就没有"仓库里的代码被执行"这条路径可走。安全不是靠记得小心，是靠没有那个能力。

### ② 脱敏 —— `src/security/redactor.ts`

diff 原文整体过一遍脱敏，返回 branded 类型 `Redacted<string>`。此后凡是要出网或落盘的接口**只接受这个类型**——忘记脱敏是编译错误。

同一个 PR 里 `demo/src/config.ts` 的那行 AWS key 就在这一步变成：

```
awsAccessKeyId: "[REDACTED:aws-access-key:1a5d]",
```

后四位是 `sha256(密钥)` 的前缀：**稳定但不可逆**。模型仍能推理"这两处是同一个凭据"，却永远看不到凭据。

### ③ 切分 —— `src/engine/units.ts`

自己写的 diff 解析器（`src/platform/diff.ts`）把 diff 拆成文件与 hunk，记录每一行的**前像/后像行号**。这个行号几何后面三处都要用：规则锚点、模型锚点校验、回评定位。

`demo/src/session.ts` 成为一个独立单元。

### ④ 规则扫描 —— `src/engine/rules-engine.ts`

**只扫 PR 新增的行**。翻旧账会让评审变成"关于这个仓库"而不是"关于这次改动"。

`sql-string-concat` 命中，产出一条 `RuleHit`：

```ts
{ ruleId: "sql-string-concat", path: "demo/src/session.ts", line: 14,
  severity: "blocker", excerpt: 'return await db.query("SELECT * FROM …' }
```

这条**自带证据**——任何人拿着 diff 和这个正则都能复现——所以它出生就是"可直接采纳"。

规则可由配置增删改（见 [配置](#配置能改什么)）。

### ⑤ Agent 循环 —— `src/engine/review-agent.ts`

每个单元起一个独立的 `Agent`（pi-agent-core），最多 6 轮。

**system prompt** 由三部分拼成：

```
评审员人设（关注什么、不许做什么）
  + 工具清单           ← 由每个工具的 meta.promptSnippet 生成，不手维护
  + 项目自定义         ← config 里的 review.focus / review.ignore
```

**user message** 包含：PR 标题与描述、**这个文件**的 diff、CI 失败信息（如有）、以及 ④ 已经命中的规则并附一句"这些已经报过了，别重复"。

于是模型不会浪费一轮再说一遍 SQL 注入，转而去找规则看不见的东西——本例中它找到了"吞掉数据库异常，故障被伪装成没查到"。

**关键的拦截点**：`meteredStream` 包住了 pi 的 `streamFn`，所以**每一次** LLM 调用——包括 agent 自己多打的那几轮——都要穿过它：

```
authorize()      ← 花完了没有？该用哪个模型？
  ↓
写 llm_request   ← 完整 system prompt + 每条消息
  ↓
调用 provider
  ↓
写 llm_response  ← 原始回复 + 用量  →  记账
```

「预算能在单元中途生效」和「每条评论都有 trace」这两件事，因此是**结构性保证**而不是纪律要求：没有任何路径能绕过它去调模型。

模型以 `submit_findings` 收尾，该工具返回 `terminate: true`——不再多花一次调用去说"我说完了"。

### ⑥ 定级 —— `src/engine/grade.ts`

模型交上来的每条发现过两道闸：

**闸一：锚点必须落在 diff 触及的行。** 落不上就丢弃——这条评论根本发不出去，而且多半在说 PR 没改过的代码。允许 ±3 行吸附，因为模型经常差一两行。

**闸二：引用的 tool call id 拿去 trace 核对。** 对不上就把这条引用丢掉（不是丢掉整条发现）。**编造引用不会被奖励**，只会让它自然掉回"仅供参考"。

定级规则本身只有一条：

| 证据 | 来源 | 能否"可直接采纳" |
| --- | --- | --- |
| `rule` | 确定性正则命中 | ✅ |
| `static` | 静态检查工具诊断（如 `ts_syntax_check`） | ✅ |
| `llm` | 模型推理 | ❌ |

**刻意不做的事**：不因为"附近有规则命中"就提升置信度。位置相近不等于说的是同一件事——这条逻辑存在过，被测试推翻后删掉了。

### ⑦ 落盘 —— `src/checkpoint/store.ts`

顺序是整个断点设计的核心：

```
1. findings.jsonl   ← 追加写
2. state.json       ← 临时文件 + rename（原子）
```

崩在两步之间，这个单元下次重跑一遍（几分钱）。反过来的顺序会**永久丢掉一条已经付过费的发现**。宁可重算，不可丢结果。

### ⑧ 重算预测 —— `src/budget/budget.ts`

每跑完一个单元算一次 `已花 ÷ 已完成比例`：

```
预计会超  → 降一档模型
降到底还超 → 收缩上下文
真的花完了 → 停，剩下的单元只跑零成本规则
```

**照事实停，照预测调。** 详见[设计文档 §4](design.zh.md)。

### ⑨ 回评 —— `src/report/post.ts`

发出去之前先做三件事：

1. **对账**：把「我们发过什么」和「PR 上现在还有什么」比对。消失的、或线程被 resolved 的，记为**否决**。
2. **过滤**：已否决的不发；已存在的不重复发。
3. **校验锚点**：确认行号在 diff 里，否则降级为文件级评论或并入摘要——一条锚点非法会让整个 review 请求 422 失败。

每条评论末尾埋一个不可见标记：

```html
<!-- code-review:f:92bb5e70ae -->
```

这就是幂等性的全部机制。fingerprint = `sha256(路径 + 规范化标题 + 行号/5)`，行号按 5 分桶，所以模型下次锚偏一两行也认得出是同一条。

### 终点：PR 上的一条评论

```
● **SQL 语句拼接变量** · 阻断 · 可直接采纳

把变量拼进 SQL 会引入注入风险。请使用参数化查询（占位符 + 参数数组）…

> 确定性规则 `sql-string-concat` 命中 `demo/src/session.ts:14`：
> `return await db.query("SELECT * FROM sessions WHERE user_id = '" + userId + "'");`
```

**评论里没有的东西**：trace 路径和 finding id。两者都只在本机有意义——trace 在跑评审那台机器的 `~/.code-review/runs/` 下，finding id 每次运行按排序重新分配。放进永久评论只会误导。它们出现在报告、TUI 和 `code-review trace` 里，那才是能打开它们的地方。

---

## 断点续跑的原理

"重跑同一条命令就是续跑"不是加了个 `--resume` 开关，而是**让运行的身份可以被推导出来**。

### run id 是算出来的，不是发出来的

```
runId = sha256("github:yanmxa/code-review:1:b5afa3ff…").slice(0, 12)
          ↑平台      ↑仓库              ↑PR号 ↑head SHA
```

同一个 PR、同一个 head commit → **必然**算出同一个目录：

```
~/.code-review/runs/89acc558042e/
├── state.json        各单元状态、累计花费、降级档位、diffHash
├── pr.json           脱敏后的 PR 快照
├── findings.jsonl    追加写
├── traces/           每单元一个
└── report.md
```

用户不需要记任何 id——因为 id 就是从他输入的东西推出来的。**PR 有了新提交（head SHA 变了）就是另一次运行**，不会拿旧结果糊弄人。

### 启动时的三岔路

```
目录不存在                    → 全新运行
目录在，且 diffHash 对得上     → 续跑
目录在，但 diffHash 对不上     → PR 在断点之后被改过 → 丢弃重来，并告知用户
```

`diffHash` 是整个 diff 的 sha256。head SHA 相同而 diff 不同在正常情况下不会发生，但 force push 到同一个 SHA、或 GitHub 端的差异都可能造成，**宁可重来也不要把新旧结果混在一起**。

### 中断的单元：重置为待办，但账不抹

```ts
for (const unit of units) {
  if (unit.status === "in_progress") unit.status = "pending";
}
```

崩溃时正在跑的那个单元会重跑一次。**已经花掉的钱留在账本上**——token 是真的消耗掉了，假装没花过会让预算变成谎话。

### 写入顺序是核心

```
completeUnit():
   1. findings.jsonl   ← 追加写
   2. state.json       ← 写临时文件 + rename（原子）
```

崩在两步之间：这个单元的 state 还是 `in_progress`，重启后重置为 `pending`、重跑一次——代价是几分钱。

**反过来的顺序**（先写 state 后写 findings）崩在中间会**永久丢掉一条已经付过费的发现**。宁可重算，不可丢结果。

`state.json` 用「写临时文件再 rename」而不是直接覆写——rename 在 APFS/ext4 上是原子的，所以那个路径上永远是一份完整的 JSON，不会出现读到半截的情况。

### 副作用：findings.jsonl 会有重复

追加写是它崩溃安全的原因，代价是续跑会让同一个单元的发现写两次。**所有把发现拿给人看的地方都先 `dedupe()`**。

（这里踩过坑：`code-review triage` 一开始漏了去重，TUI 里出现重复条目，补了测试。）

### 实测

```bash
code-review $PR --budget 6 &
sleep 30 && pkill -f "code-review $PR"     # 打断
code-review $PR --budget 6                 # 同一条命令
```

结果：只重跑被打断的那一个文件，已完成的三个既不重跑也不重复计费（¥0.24 → ¥0.35）。

---

## 一条发现留下的痕迹

跑完之后，这条发现在四个地方留下记录：

| 位置 | 内容 |
| --- | --- |
| `~/.code-review/runs/<id>/findings.jsonl` | 结构化发现，含证据与 fingerprint |
| `~/.code-review/runs/<id>/traces/demo_src_session.ts.jsonl` | 完整时间线：规则命中、每次 LLM 请求的原文 prompt、模型原始回复、每次工具调用与结果、逐次用量 |
| `~/.code-review/runs/<id>/report.md` | 人读的报告，按置信度分组 |
| `~/.code-review/memory/github--yanmxa--code-review.json` | 发过了；如果之后被否，这里会记下 |

看 trace：

```bash
code-review trace <run-id> demo/src/session.ts    # 命令行
code-review triage <run-id>                       # TUI 里按 t
```

---

## 反馈闭环：被否掉的意见不会再提

工具会记住**这个仓库的维护者拒绝过什么**，下次不再提。

判定"拒绝"只认两个明确信号：评论被**删除**，或所在线程被标记 **resolved**。回复反驳算讨论不算判决，不采信。

```bash
code-review dismissed <pr-url>            # 看这个仓库否掉过什么
code-review undismiss <pr-url> <fp>       # 撤销某一条
```

记忆是**仓库级**的，不是运行级——运行目录按 head SHA 建，放在那里的记忆会在下次 push 时蒸发，而那正是工具要重复自己的时刻。

被扣下的意见**不会出现在任何输出里**，只会报告扣了几条。先展示再说"我扣了它"比不过滤更糟。

这条不是锦上添花：一个每次 push 都重复同一条无效意见的机器人，团队学会的唯一行为是无视它。

## 缺少测试是确定性判断

"改了 `src/foo.ts`，本 PR 没动任何看起来覆盖它的测试" —— 这是人做 review 问得最多的问题，而且完全不需要模型。

只在**有实质逻辑新增**时触发（≥8 行，不算 import、括号、注释），按文件名跨生态匹配测试（`foo.test.ts` / `test_foo.py` / `foo_test.go` / `FooTest.java` / `foo_spec.rb` …）。

按名字匹配必然有漏：测试可能覆盖了它却没在名字里提。所以它是 `minor` 级、正文里明说"若已被其他测试覆盖可忽略"——**并且被否一次之后就永远不再提**。两个功能正好互补。

---

## 配置

参数、配置字段、凭据、以及怎么加一个工具，见 [配置文档](configuration.zh.md)。

---

## 各阶段的成本

一次真实运行（4 个文件、演示 PR、`--budget 6`）的分布：

| 阶段 | 成本 |
| --- | --- |
| ① 取材 | 3-8 次 REST 调用，¥0 |
| ② 脱敏 | 纯本地正则 + 熵值扫描，¥0 |
| ③ 切分 | 纯本地，¥0 |
| ④ 规则扫描 | 纯本地，**¥0** |
| ⑤ Agent 循环 | **全部花费在这里**，约 ¥0.28 |
| ⑥⑦⑧ | 纯本地，¥0 |
| ⑨ 回评 | 1-2 次 REST 调用，¥0 |

这个分布解释了一个设计选择：**预算耗尽后仍然跑 ④**。规则零成本且产出的恰恰是最高价值的发现（密钥、SQL 注入）。因为 LLM 没钱了就把免费检查也跳过，是把"部分结果"变成"截断结果"。

实测 `--budget 0.12` 时，4 个文件只有 1 个过了 LLM，报告里仍有 5 条可直接采纳的意见。
