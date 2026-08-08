# code-review

基于 [pi](https://github.com/earendil-works/pi) 框架的 GitHub / GitLab 代码评审 Agent。

*[English →](README.md)*

给一个 PR 链接，产出按证据分级的评审意见 —— 断网重启能续跑，预算超了自动降级，每条意见都能追溯到它的原始 prompt 和模型回复，密钥永远不会离开本机。

```bash
export OPENAI_API_KEY=sk-...      # 或 MOONSHOT_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY
gh auth login                     # 或 export GITHUB_TOKEN

npm install && npm run build
node dist/cli.js https://github.com/owner/repo/pull/123 --budget 10
```

---

## 它长什么样

**评审进行中。** 左边是文件进度，右边是 agent 此刻在做什么，顶部一行始终回答"花了多少、还剩多少、现在用哪个模型"。

```
⬢ yanmxa/code-review #1 Add cache eviction, session lookup, and retry helper
feature/add-eviction-and-auth → main · 4 files                                        openai/gpt-5.4
▰▱▱▱▱▱▱▱▱▱ ¥0.41/¥6.00 · ↑8.5k ↓2.3k ⛁6.1k

╭─ 文件 ─────────────────────────── 2/4 ─╮╭─ 进行中 ───────────────────────────────────────────────╮
│✓ src/cache.ts                       3  ││▸ src/retry.ts                                          │
│✓ src/config.ts                      1  ││  → get_file src/retry.ts                               │
│⠋ src/retry.ts                          ││    src/retry.ts (11 lines)                             │
│◌ src/session.ts                        ││  → ts_syntax_check src/retry.ts                        │
│                                        ││    1 diagnostic: TS1005 ';' expected                   │
│                                        ││────────────────────                                    │
│                                        ││循环条件用的是 i <= attempts，默认 3 会跑四次。         │
│                                        ││正在确认调用方是否依赖这个行为…                         │
╰────────────────────────────────────────╯╰────────────────────────────────────────────────────────╯

━━━━━━━━━━━━ 2/4 · 00:41  ●2 ○3                                             ctrl+c 存档并退出
```

**结果分诊。** 按置信度分两组，可采纳的默认已勾选，`p` 一键回评到 PR。右侧显示这条意见**凭什么**被判成这个级别。

```
⬢ 评审结果 · 9 total  ● 5  ○ 4                                                ▰▱▱▱▱▱▱▱▱▱ ¥0.41/¥6.00

╭─ 发现 ─────────────────────────── 5/9 ─╮╭─ 详情 ─────────────────────────────────────────────────╮
│● 可直接采纳 (5)                        ││● 提交中包含疑似密钥                                    │
│▌[x] ● config.ts:4 提交中包含疑似密钥   ││F-001 · 阻断 · 可直接采纳                               │
│ [x] ● session.ts:14 SQL 语句拼接变量   ││src/config.ts:4                                         │
│ [x] ● session.ts:8 用非密码学随机...   ││                                                        │
│ [x] ● cache.ts:15 新增了 console 日志  ││这一行被密钥扫描器判定为 `aws-access-key`（内容已在传   │
│ [x] ● session.ts:4 使用了宽松相等比较  ││给模型前脱敏）。请从代码中移除，改用密钥管理服务，并    │
│                                        ││**轮换该凭据** —— 它已经进入了 git 历史。               │
│○ 仅供参考 (4)                          ││                                                        │
│ [ ] ○ cache.ts:11 满容量时覆盖已有...  ││证据                                                    │
│ [ ] ○ cache.ts:12 当前驱逐策略按插...  ││  ● 确定性规则 secret-in-diff 命中 src/config.ts:4 —    │
│ [ ] ○ retry.ts:3 重试次数比 attem...   ││    awsAccessKeyId: "[REDACTED:aws-access-key:5d3c]",   │
│ [ ] ○ session.ts:15 吞掉数据库异常...  ││                                                        │
│                                        ││→ traces/src_config.ts.jsonl   t 打开 trace             │
╰────────────────────────────────────────╯╰────────────────────────────────────────────────────────╯

                       ↑↓ 移动 · space 选中 · a 全选可采纳 · t trace · p 回评 · l 语言 · q 退出
```

**追溯**（按 `t`）。每条意见背后完整的时间线：调了哪些工具、发出去的 prompt 原文、模型的原始回复、这一步花了多少钱。回车展开任意一行。

```
╭─ F-002 · traces/src_session.ts.jsonl ────────────────────────────────────────────────────────────╮
│ 02:04:17 ✦ rule loose-equality src/session.ts:4                                                  │
│ 02:04:17 ✦ rule insecure-random src/session.ts:8                                                 │
│▌02:04:17 ✦ rule sql-string-concat src/session.ts:14                                              │
│ 02:04:17 ▸ unit src/session.ts openai/gpt-5.4                                                    │
│ 02:04:17 ↑ llm 1 msg · 4 tools openai/gpt-5.4                                                    │
│ 02:04:20 ↓ llm toolUse ↑90 ↓137 $0.0027                                                          │
│ 02:04:20 → get_file {"path":"src/session.ts","startLine":1}                                      │
│ 02:04:20 → search_diff {"pattern":"\\.query\\(","maxResults":20}                                 │
│ 02:04:20   · 1 matching changed line(s):                                                         │
│ 02:04:21 ↑ llm 5 msg · 4 tools openai/gpt-5.4                                                    │
│                                                                ↑↓ 移动 · enter 展开 · esc 关闭   │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

没有 TTY 时（CI、管道、`--no-tui`）自动降级为逐行输出，消费的是同一个事件流。

---

## 需求对照表

题目的六条硬性要求，各自由哪个模块实现、被哪个测试证明：

| 要求 | 怎么做的 | 代码 | 测试 |
| --- | --- | --- | --- |
| **可恢复**<br>断网/重启不从头跑 | Run id = `sha256(平台:仓库:PR号:head SHA)`，所以**重跑同一条命令就是续跑**，不需要记 run id。findings 先落盘、再写确认它的 state —— 崩在中间最多重跑一个文件，永远不会丢已付费的结果。`state.json` 用临时文件 + rename 原子写入。 | `src/checkpoint/store.ts` | `test/store.test.ts`（16） |
| **token 预算**<br>可设总额，超了降级或截断 | 预算闸门装在 **stream function** 里，所以每一次 LLM 调用都要过它 —— 包括 agent 自己决定多打的那一轮。50% 降级到 mini、85% 降到 nano、75% 收缩上下文、100% 硬停。硬停后**仍然跑零成本的确定性规则**，所以部分结果依然有价值。 | `src/budget/budget.ts`<br>`src/engine/review-agent.ts` | `test/budget.test.ts`（17） |
| **可观测**<br>每条评论关联 trace | 每个评审单元一个 JSONL 文件，记录完整 system prompt、每条消息、模型原始回复、每次工具调用与结果、规则命中、预算事件。每条 finding 带 `tracePath`，报告里是链接，TUI 里按 `t` 打开，命令行 `code-review trace <run> <unit>`。 | `src/trace/tracer.ts` | `test/pipeline.test.ts` |
| **置信度分级**<br>可采纳 vs 仅供参考 | **只有机器可复现的证据才能评为"可直接采纳"**：确定性规则命中，或静态检查工具的诊断。模型自己的推理无论多笃定都只是"仅供参考"。模型必须在 `supportingToolCalls` 里引用工具调用 id，引用不存在的 id 会被静默丢弃而不是被奖励。 | `src/engine/grade.ts`<br>`src/engine/rules-engine.ts` | `test/rules.test.ts`（23） |
| **安全**<br>不上传 secret、不跑任意代码 | 脱敏是**编译器强制**的：所有出网/落盘的字符串都是 branded 类型 `Redacted<string>`，忘了脱敏是编译错误而不是泄漏。规则源自 gitleaks，外加熵值扫描。不 clone 仓库、不注册任何 shell 工具 —— 全程只有 REST 调用。唯一的子进程是 `gh auth token`。 | `src/security/redactor.ts` | `test/redactor.test.ts`（27） |
| **可扩展**<br>新增工具声明式注册 | 一个工具 = 一个文件导出 `ToolSpec` + `tools/index.ts` 里加一行。system prompt 的工具清单由 `meta.promptSnippet` 生成，置信度分级读 `meta.evidenceKind` —— 主流程一行都不用改。完整示例见下。 | `src/tools/spec.ts`<br>`src/tools/index.ts` | `test/tools.test.ts`（17） |

---

## 新增一个工具：完整示例

题目要求"新增一个工具（如 typecheck）是声明式注册，不改主流程"。`ts_syntax_check` 就是这样加进来的，改动只有两处：

**① 新建 `src/tools/ts-syntax-check.ts`**

```ts
export const tsSyntaxCheckTool = defineReviewTool({
  meta: {
    id: "ts_syntax_check",
    evidenceKind: "static",        // ← 这一行让它的输出可以把 finding 提升为"可直接采纳"
    enabledByDefault: true,
    costHint: "free",
    promptSnippet: "ts_syntax_check — 对改动的 .ts/.js 文件跑 TypeScript 编译器…",
  },                               //   ↑ 自动进入 system prompt
  build(context) {
    return reviewTool({
      name: "ts_syntax_check",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, params) { /* … */ },
    });
  },
});
```

**② `src/tools/index.ts` 里加一行**

```diff
 export const TOOL_REGISTRY: ToolSpec[] = [
   getFileTool,
   searchDiffTool,
+  tsSyntaxCheckTool,
   submitFindingsTool,
 ];
```

没有第三处改动。pipeline、prompt 拼装、置信度分级全都不用动。运行时还能按配置关掉：`{"tools": {"ts_syntax_check": false}}`。

**这个工具怎么保证安全**：文件通过 HTTPS 取到内存，交给 TypeScript 编译器的**虚拟 CompilerHost**。`noResolve` 让编译器不去碰 import，`noEmit` 让它不写任何文件 —— 编译器只是把仓库代码当**数据**来解析，不执行任何东西。代价是拿不到跨模块类型，所以"找不到模块"这类诊断会被过滤掉，只保留语法错误和文件内自洽的类型错误。这个限制写在工具自己的 description 里，模型知道它的输出意味着什么。

---

## 命令

```bash
code-review <pr-url> [options]      # 评审一个 PR
code-review runs                    # 列出所有断点
code-review triage <run-id>         # 重新打开某次运行的结果浏览器
code-review trace <run-id> <unit>   # 打印某个单元的完整 trace
```

| 选项 | 说明 |
| --- | --- |
| `--budget <cny>` | 本次评审的总预算，人民币（默认 10） |
| `--model <ref>` | 指定主模型，如 `openai/gpt-5.4`、`moonshotai/kimi-k2.5`。指定后不再自动降级 |
| `--lang <zh\|en>` | 评审意见与报告的语言（默认 zh） |
| `--post` | 把结果作为行内评论回评到 PR |
| `--report <path>` | 额外把 markdown 报告写到指定路径 |
| `--fresh` | 忽略已有断点，从头开始 |
| `--no-tui` / `--verbose` | 逐行输出 / 同时打印模型流式输出 |
| `--fail-on <adoptable\|any>` | CI 用：命中则退出码 2 |

退出码：`0` 正常，`2` 命中 `--fail-on`，`3` 预算耗尽（部分结果），`1` 出错。

**配置优先级**：内置默认 → `~/.config/code-review/config.json` → `./review.config.json` → 环境变量 → 命令行参数。

```jsonc
{
  "budget": {
    "totalCny": 10,
    "usdToCny": 7.25,
    "ladder": [                                    // 降级链，按已花费比例触发
      { "atFraction": 0,    "model": { "provider": "openai", "id": "gpt-5.4" } },
      { "atFraction": 0.5,  "model": { "provider": "openai", "id": "gpt-5.4-mini" } },
      { "atFraction": 0.85, "model": { "provider": "openai", "id": "gpt-5.4-nano" } }
    ]
  },
  "tools": { "ts_syntax_check": true },
  "lang": "zh"
}
```

---

## 实际跑一次是什么样

对着一个故意埋了缺陷的 PR（[yanmxa/code-review#1](https://github.com/yanmxa/code-review/pull/1)）：

```
$ code-review https://github.com/yanmxa/code-review/pull/1 --budget 6 --no-tui

✓ src/cache.ts — 3 finding(s)
    ● 次要  src/cache.ts:15   新增了 console 日志                       [可直接采纳]
    ○ major src/cache.ts:11   满容量时覆盖已有键会误删另一个条目        [仅供参考]
✓ src/config.ts — 1 finding(s)
    ● 阻断  src/config.ts:4   提交中包含疑似密钥                        [可直接采纳]
✓ src/session.ts — 4 finding(s)
    ● 阻断  src/session.ts:14 SQL 语句拼接变量                          [可直接采纳]
    ● 重要  src/session.ts:8  用非密码学随机数生成标识符                [可直接采纳]
    ○ major src/session.ts:15 吞掉数据库异常，故障被当成"没查到"        [仅供参考]

Done. 9 finding(s) — 5 adoptable, 4 reference · ¥0.41
```

完整产物见 [`examples/`](examples/)：[评审报告](examples/sample-report.md)、[一条 trace](examples/sample-trace.jsonl)、[断点文件](examples/sample-state.json)。

**在真实 PR 上验证过的行为**（不只是单测）：

- **续跑**：`kill -9` 打断，重跑同一条命令 → 只重跑被打断的那个文件，已完成的三个既不重跑也不重复计费（¥0.238 → ¥0.346）。
- **降级**：`--budget 0.30` → 花到 55% 时自动切到 `gpt-5.4-mini`，最终 ¥0.22 收在预算内。
- **硬停**：`--budget 0.12` → 第一个文件就超预算，剩下 3 个文件跳过 LLM 但**仍跑完确定性规则**，报告里仍有 5 条可采纳意见，退出码 3。
- **脱敏**：埋进 PR 的 AWS key 在 trace、断点、prompt 里全都只以 `[REDACTED:aws-access-key:5d3c]` 出现，grep 原值零命中。
- **幂等回评**：连续两次 `--post` → 第二次跳过 7 条已存在的，只发新增的 1 条。

---

## 架构

```
PR URL → 拉取(REST，不 clone) → 脱敏 → 切分成评审单元
       → 每个单元：确定性规则 ∥ agent 循环(只读工具 + submit_findings)
       → 去重 → 按证据分级 → 报告 / TUI 分诊 / 回评
```

三个设计上的取舍，详见 [设计文档](docs/design.zh.md)：

- **每个文件一个 agent 循环**，不是整个 PR 一次调用。文件是人做 review 时的思考单位，也让断点、预算、上下文都有了自然边界。
- **预算与追踪都挂在 stream function 上**，不是散落在流程里。这样它们对每一次 LLM 调用生效，而 pipeline 完全不知道它们存在。
- **"可直接采纳"只认机器证据**。曾经写过"finding 附近有规则命中就提升置信度"，被测试打脸删掉了 —— 位置相近不等于说的是同一件事，靠位置提升会让这个分级失去意义。

依赖 pi 的三个包：`pi-ai`（统一 LLM 接口 + 逐次用量/成本）、`pi-agent-core`（agent 循环 + 声明式工具 + `terminate` 语义）、`pi-tui`（差分渲染的终端 UI）。

---

## 开发

```bash
npm test              # 182 个测试，全部离线
npm run typecheck
npm run dev -- <url>  # tsx 直跑，不用先 build
```

测试不需要任何 API key 和网络：LLM 走 pi-ai 的 faux provider，GitHub 走内存里的假 adapter，TUI 走实现了 `Terminal` 接口的桩。

### 已知限制

诚实地说清楚边界：

- **续跑粒度是文件级**。崩在一个文件中间会重跑那个文件（成本几分钱），不是从上一次工具调用继续。换更细的粒度需要把 agent 的中间状态也持久化，收益不抵复杂度。
- **`ts_syntax_check` 拿不到跨模块类型**（没有 `node_modules`），只能查语法错误和文件内自洽的类型错误。
- **GitLab 回评是逐条 discussion**，不像 GitHub 那样一次 review 提交，所以部分失败时会有一半评论已发出。
- **`--verify` 复核只标注、不改变分级**。让第二个模型同意就升级为"可直接采纳"是自欺欺人 —— 模型互相同意不是确定性。
- 中文宽字符在极窄终端（< 60 列）下会被截断得比较早；宽度契约本身有测试保证不会撑破布局。

### 代理

如果你在代理后面：Node 的 `fetch` 默认**不读** `HTTPS_PROXY`（curl 会读），表现出来是模型返回一个看起来像 API key 出问题的 `Connection error.`。检测到配置了代理会自动带 `NODE_USE_ENV_PROXY=1` 重启一次，无需手动处理。

---

## 关于 AI 的使用

这个项目是用 AI 辅助完成的，过程记录在 [`docs/ai-usage.md`](docs/ai-usage.md)：哪些部分是 AI 写的、怎么验证的、AI 写错了什么又是怎么发现的。

MIT License.
