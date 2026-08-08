# code-review

给一个 PR 链接，产出**按证据分级**的代码评审意见。基于 [pi](https://github.com/earendil-works/pi) 框架。

*[English →](README.md)*

**它怎么读一个 PR**

- **确定性检查先行** —— 密钥、SQL 拼接、不安全随机数、缺测试…… 这些不需要模型，命中即为可采纳级证据
- **每个文件一个 agent 循环** —— 带只读工具（读文件、搜索本 PR 改动、跑 TypeScript 编译器），最多 6 轮
- **把 CI 结果注入评审上下文** —— 失败的 check 及其精确到行的诊断，随 diff 一起进入这个文件的 user message。测试挂没挂是已经测量出来的事实，不必让模型去猜
- **只在有依据时下结论** —— 有确定性证据的标"可直接采纳"，模型推断的标"仅供参考"，两者不混
- **被否决过的不再提** —— 维护者删掉或 resolve 一条评论，就是永久否决

完整机制见 [一次评审是怎么跑完的](docs/how-it-works.zh.md)。

**它作为工具是否可信**

- **断网重启不重跑** —— run id 由「仓库 + PR 号 + head SHA」哈希得出，所以重跑同一条命令必然落回同一个断点目录，不需要记任何 id（[原理](docs/how-it-works.zh.md#断点续跑的原理)）
- **花费有上限** —— 预算超了自动降级模型，再超就停，但零成本的规则检查照常跑完
- **每条意见可追溯** —— 完整 prompt、模型原始回复、工具调用全在一个 trace 文件里
- **密钥不出本机** —— 脱敏由类型系统强制，不 clone 仓库、不执行任何仓库代码
- **规则和评审重点可配置** —— 项目自己的检查和关注点写在配置里，不用改源码

---

## 快速开始

```bash
git clone https://github.com/yanmxa/code-review && cd code-review
npm install -g .                       # 编译并把 code-review 装到 PATH

export OPENAI_API_KEY=sk-...           # 也支持 MOONSHOT / ANTHROPIC / OPENROUTER
gh auth login                          # 或 export GITHUB_TOKEN

code-review auth                       # 确认凭据已识别
code-review config                     # 看这次会用什么预算和降级链
code-review https://github.com/yanmxa/code-review/pull/1 --budget 6
```

不想装全局：`npm install && npm run dev -- <pr-url>`。

---

## 界面

评审进行中：左边文件进度，右边 agent 此刻在做什么，顶部始终是花费和当前模型。

```
⬢ yanmxa/code-review #1 demo: add cache eviction, session lookup, and retry helper
demo/planted-defects → main · 4 files                                                 openai/gpt-5.4
▱▱▱▱▱▱▱▱▱▱ ¥0.25/¥6.00 · → ¥0.29 · ↑4.1k ↓1.5k ⛁10.8k                                               

╭─ 文件 ─────────────────────────── 2/4 ─╮╭─ 进行中 ───────────────────────────────────────────────╮
│✓ demo/src/cache.ts                  2  ││▸ demo/src/retry.ts                                     │
│✓ demo/src/config.ts                 1  ││  → get_file demo/src/retry.ts                          │
│⠋ demo/src/retry.ts                     ││    demo/src/retry.ts (11 lines)                        │
│◌ demo/src/session.ts                   ││  → search_diff withRetry\(                             │
│                                        ││    No changed line matches /withRetry\(/.              │
│                                        ││────────────────────                                    │
│                                        ││循环条件用的是 i <= attempts，默认 3                    │
│                                        ││会跑四次。正在确认调用方是否依赖这个行为…               │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
╰────────────────────────────────────────╯╰────────────────────────────────────────────────────────╯

━━━━━━━━━━━━ 2/4 · 00:00  ●4 ○0                                                    ctrl+c 存档并退出
```

跑完进入分诊：按置信度分两组，可采纳的默认已勾选，`p` 一键回评。右侧显示这条意见**凭什么**被判成这一档。

```
⬢ 评审结果 · 8 total  ● 5  ○ 3                                                ▱▱▱▱▱▱▱▱▱▱ ¥0.25/¥6.00

╭─ 发现 ─────────────────────────── 5/8 ─╮╭─ 详情 ─────────────────────────────────────────────────╮
│● 可直接采纳 (5)                        ││● Credential committed in this change                   │
│▌[x] ● config.ts:4 Credential commi...  ││F-001 · 阻断 · 可直接采纳                               │
│ [x] ● session.ts:14 SQL built by s...  ││demo/src/config.ts:4                                    │
│ [x] ● session.ts:8 Non-cryptograph...  ││                                                        │
│ [x] ● cache.ts:15 New `console` lo...  ││The secret scanner classified this line as              │
│ [x] ● session.ts:4 Loose equality ...  ││`aws-access-key` (the value was masked before any       │
│                                        ││model saw it). Remove it from the code, move it to an   │
│○ 仅供参考 (3)                          ││environment variable or secret manager, and **rotate    │
│ [ ] ○ cache.ts:11 Eviction runs ev...  ││the credential** — it is already in git history.        │
│ [ ] ○ retry.ts:3 Retry loop perfor...  ││                                                        │
│ [ ] ○ session.ts:15 Database failu...  ││证据                                                    │
│                                        ││  ● 规则 secret-in-diff 命中 demo/src/config.ts:4 —     │
│                                        ││    awsAccessKeyId: "[REDACTED:aws-access-key:1a5d]",   │
│                                        ││                                                        │
│                                        ││→ traces/demo_src_config.ts.jsonl   t 查看 trace        │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
╰────────────────────────────────────────╯╰────────────────────────────────────────────────────────╯

                                     ↑↓ 移动 · space 选中 · a 全选可采纳 · t trace · p 回评 · q 退出
```

<details>
<summary><b>按 <code>t</code> 查看某条意见的完整 trace</b></summary>

```
╭─ F-002 · traces/demo_src_session.ts.jsonl ───────────────────────────────────────────────────────╮
│ 03:46:18 ✦ rule loose-equality demo/src/session.ts:4                                             │
│ 03:46:18 ✦ rule insecure-random demo/src/session.ts:8                                            │
│▌03:46:18 ✦ rule sql-string-concat demo/src/session.ts:14                                         │
│ 03:46:18 ▸ unit demo/src/session.ts openai/gpt-5.4                                               │
│ 03:46:18 ↑ llm 1 msg · 4 tools openai/gpt-5.4                                                    │
│ 03:46:20 ↓ llm toolUse ↑269 ↓128 $0.0030                                                         │
│ 03:46:20 → search_diff {"pattern":"\\bloadSession\\s*\\(","maxResu...                            │
│ 03:46:20   · 1 matching changed line(s):                                                         │
│ 03:46:20 ↑ llm 3 msg · 4 tools openai/gpt-5.4                                                    │
│ 03:46:22 ↓ llm toolUse ↑433 ↓42 $0.0021                                                          │
│ 03:46:22 → get_file {"path":"demo/src/db.ts","startLine":1}                                      │
│ 03:46:23   · File not found at head commit: demo/src/db.ts                                       │
│ 03:46:23 ↑ llm 5 msg · 4 tools openai/gpt-5.4                                                    │
│ 03:46:25 ↓ llm toolUse ↑497 ↓41 $0.0022                                                          │
│ 03:46:25 → search_diff {"pattern":"\\bcreateConnection\\b","maxRes...                            │
│ 03:46:25   · 2 matching changed line(s):                                                         │
│                                                                   ↑↓ 移动 · enter 展开 · esc 关闭│
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

调了哪些工具、发出去的 prompt 原文、模型原始回复、每步花了多少钱。回车展开任意一行。

</details>

没有 TTY 时（CI、管道、`--no-tui`）自动降级为逐行输出，消费的是同一个事件流。

---

## 自己验证一下

这些不是单测断言，是可以直接复现的命令。演示 PR 里埋了 6 个缺陷。

```bash
PR=https://github.com/yanmxa/code-review/pull/1

# 断点续跑：跑一半 kill 掉，重跑同一条命令
code-review $PR --budget 6 &
sleep 30 && pkill -f "code-review $PR"
code-review $PR --budget 6            # 只重跑被打断的那个文件，其余不重复计费

# 预算降级：预计会超支时自动切到更便宜的模型
code-review $PR --budget 0.30 --fresh --no-tui | grep downgrade

# 预算硬停：第一个文件就超预算，剩下的仍跑完免费的规则检查
code-review $PR --budget 0.12 --fresh --no-tui ; echo "退出码 $?"   # 3 = 预算耗尽

# 脱敏：埋进 PR 的 AWS key 在任何产物里都搜不到原值
grep -r "AKIAIOSFODNN7EXAMPLE" ~/.code-review/runs/  # 零命中
grep -rho "\[REDACTED:[a-z-]*:" ~/.code-review/runs/ | sort -u

# 幂等回评：连跑两次 --post，第二次不会重复发
code-review $PR --post && code-review $PR --post
```

实测结果：续跑时只重跑被打断的那个文件，已完成的不重复计费；`--budget 0.30` 时跑完第 1 个文件就预测到会花 ¥0.37 而降级，之后预测逐步收敛，最终 ¥0.16 落在预算内；硬停时 4 个文件只有 1 个过了 LLM，报告里仍有 5 条可采纳意见。

### 反馈闭环：被否掉的意见不会再提

工具会记住**这个仓库的维护者拒绝过什么**，下次不再提。

判定"拒绝"只认两个明确信号：评论被**删除**，或所在线程被标记 **resolved**。回复反驳算讨论不算判决，不采信。

```bash
code-review dismissed <pr-url>            # 看这个仓库否掉过什么
code-review undismiss <pr-url> <fp>       # 撤销某一条
```

记忆是**仓库级**的，不是运行级——运行目录按 head SHA 建，放在那里的记忆会在下次 push 时蒸发，而那正是工具要重复自己的时刻。

被扣下的意见**不会出现在任何输出里**，只会报告扣了几条。先展示再说"我扣了它"比不过滤更糟。

这条不是锦上添花：一个每次 push 都重复同一条无效意见的机器人，团队学会的唯一行为是无视它。

### 缺少测试是确定性判断

"改了 `src/foo.ts`，本 PR 没动任何看起来覆盖它的测试" —— 这是人做 review 问得最多的问题，而且完全不需要模型。

只在**有实质逻辑新增**时触发（≥8 行，不算 import、括号、注释），按文件名跨生态匹配测试（`foo.test.ts` / `test_foo.py` / `foo_test.go` / `FooTest.java` / `foo_spec.rb` …）。

按名字匹配必然有漏：测试可能覆盖了它却没在名字里提。所以它是 `minor` 级、正文里明说"若已被其他测试覆盖可忽略"——**并且被否一次之后就永远不再提**。两个功能正好互补。

---

## 需求对照表

题目的六条硬性要求，各自由哪个模块实现、被哪个测试证明：

| 要求 | 怎么做的 | 代码 | 测试 |
| --- | --- | --- | --- |
| **可恢复** | Run id = `sha256(平台:仓库:PR号:head SHA)`，**重跑同一条命令就是续跑**。findings 先落盘、再写确认它的 state —— 崩在中间最多重跑一个文件，永不丢已付费的结果。`state.json` 临时文件 + rename 原子写入。 | `checkpoint/store.ts` | `store.test.ts`（16） |
| **token 预算** | 闸门装在 **stream function** 里，每一次 LLM 调用都要过它（包括 agent 自己多打的那轮）。降级看的是**预测**（`已花 ÷ 已完成比例`）而不是已花多少 —— 花掉一半预算跑完一半文件是正好在轨，不该触发任何动作。预计超支 → 降一档；降到底还超 → 收缩上下文；真的花完 → 停。**硬停后仍跑零成本规则**，部分结果依然有价值。 | `budget/budget.ts`<br>`engine/review-agent.ts` | `budget.test.ts`（33） |
| **可观测** | 每个评审单元一个 JSONL：完整 system prompt、每条消息、模型原始回复、每次工具调用与结果、规则命中、预算事件。报告里是链接，TUI 里按 `t`，命令行 `code-review trace`。 | `trace/tracer.ts` | `pipeline.test.ts` |
| **置信度分级** | **只有机器可复现的证据能评为"可直接采纳"**：确定性规则命中，或静态检查诊断。模型推理无论多笃定都只是"仅供参考"。模型必须引用工具调用 id，编造的 id 被静默丢弃而非奖励。 | `engine/grade.ts`<br>`engine/rules-engine.ts` | `rules.test.ts`（23） |
| **安全** | 脱敏**编译器强制**：出网/落盘的字符串都是 branded 类型 `Redacted<string>`，忘了脱敏是编译错误而非泄漏。规则源自 gitleaks + 熵值扫描。不 clone、无 shell 工具，全程只有 REST。唯一子进程是 `gh auth token`。 | `security/redactor.ts` | `redactor.test.ts`（27） |
| **可扩展** | 一个工具 = 一个文件 + `tools/index.ts` 加一行。prompt 里的工具清单由 `meta.promptSnippet` 生成，分级读 `meta.evidenceKind` —— 主流程一行不改。 | `tools/spec.ts`<br>`tools/index.ts` | `tools.test.ts`（17） |

---

## 新增一个工具

题目要求"新增工具是声明式注册，不改主流程"。`ts_syntax_check` 就是这样加的，**只改两处**：

**① 新建 `src/tools/ts-syntax-check.ts`**

```ts
export const tsSyntaxCheckTool = defineReviewTool({
  meta: {
    id: "ts_syntax_check",
    evidenceKind: "static",   // ← 让它的输出可以把 finding 提升为"可直接采纳"
    enabledByDefault: true,
    costHint: "free",
    promptSnippet: "ts_syntax_check — 对改动的 .ts/.js 文件跑 TypeScript 编译器…",
  },                          //   ↑ 自动进入 system prompt
  build(context) {
    return reviewTool({
      name: "ts_syntax_check",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, params) { /* … */ },
    });
  },
});
```

**② `src/tools/index.ts` 加一行**

```diff
 export const TOOL_REGISTRY: ToolSpec[] = [
   getFileTool,
   searchDiffTool,
+  tsSyntaxCheckTool,
   submitFindingsTool,
 ];
```

没有第三处。pipeline、prompt 拼装、置信度分级全都不动。运行时可关：`{"tools": {"ts_syntax_check": false}}`。

**它怎么保证安全**：文件取到内存，交给 TypeScript 编译器的**虚拟 CompilerHost**。`noResolve` 不碰 import，`noEmit` 不写文件 —— 编译器只把代码当**数据**解析。代价是拿不到跨模块类型，所以"找不到模块"类诊断被过滤，只留语法错误和文件内自洽的类型错误。这个限制写在工具自己的 description 里。

---

## 命令与配置

```bash
code-review <pr-url> [options]      # 评审一个 PR

code-review runs                    # 列出所有断点
code-review triage <run-id>         # 重新打开某次运行的结果浏览器
code-review trace <run-id> <unit>   # 打印某个单元的完整 trace

code-review config                  # 查看这次运行会用的配置
code-review init                    # 生成 review.config.json 供编辑
code-review auth                    # 查看当前配置了哪些凭据
code-review login [provider]        # 用订阅登录（默认 openai-codex）
code-review logout <provider>       # 删除已存的凭据

code-review dismissed <pr-url>      # 看这个仓库否掉过什么
code-review undismiss <pr-url> <fp> # 撤销某一条否决
```

| 选项 | 说明 |
| --- | --- |
| `--budget <amount>` | `10`、`¥10`、`$1.50`、`800k tokens`。裸数字用配置里的单位（默认 ¥10） |
| `--model <ref>` | 指定主模型，如 `openai/gpt-5.4`。指定后不再自动降级 |
| `--lang <zh\|en>` | 评审意见与报告的语言（默认 zh） |
| `--post` | 把结果作为行内评论回评到 PR |
| `--report <path>` | 额外把 markdown 报告写到指定路径 |
| `--fresh` | 忽略已有断点，从头开始 |
| `--no-tui` / `--verbose` | 逐行输出 / 同时打印模型流式输出 |
| `--fail-on <adoptable\|any>` | CI 用：命中则退出码 2 |

退出码：`0` 正常，`2` 命中 `--fail-on`，`3` 预算耗尽（部分结果），`1` 出错。

**配置优先级**：内置默认 → `~/.config/code-review/config.json` → `./review.config.json` → 环境变量 → 命令行。`code-review init` 生成一份可编辑的，`code-review config` 查看合并后的结果。

```jsonc
{
  "budget": {
    "limit": "¥10",            // 也可以 "$1.50" 或 "800k tokens"
    "usdToCny": 7.25,          // 仅当 limit 用人民币时需要
    "models": [                // 优先级：预计会超支时逐档下降
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "openai/gpt-5.4-nano"
    ]
  },
  "tools": { "ts_syntax_check": true },

  "rules": {                                     // 确定性检查（产出可采纳级证据）
    "disabled": ["todo-added"],                  //   关掉不认同的内置规则
    "severity": { "console-log": "nit" },        //   改严重级
    "custom": [{                                 //   只有这个项目知道的检查
      "id": "no-legacy-import",
      "severity": "major",
      "files": "\\.ts$",
      "pattern": "from\\s+[\"'][^\"']*legacy/",
      "title": "Imports from legacy/",
      "body": "legacy/ 已冻结，需要什么先搬进 src/。"
    }]
  },

  "review": {                                    // 评审员的人设
    "focus": "这是一个 Go 服务，最关心错误包装和 context 传递。",
    "ignore": ["命名风格", "注释格式"]             //   已经吵完的话题，别再提
  },

  "lang": "zh"
}
```

`code-review config` 打印合并后的完整结果——**"这次会用什么"不该需要先跑一次才知道**。

**降级不看已花了多少，看预计会花多少。** 每跑完一个文件重算一次 `已花 ÷ 已完成比例`：

```
¥ downgrade — gpt-5.4 → gpt-5.4-mini — projected ¥0.37 against ¥0.30 after 1/4 files
✓ cache.ts    ¥0.09/¥0.30 · projected ¥0.37
✓ config.ts   ¥0.11/¥0.30 · projected ¥0.22    ← 换便宜模型后预测自行收敛
✓ session.ts  ¥0.16/¥0.30 · projected ¥0.16    ← 最终落在预算内
```

花掉一半预算跑完一半文件是**正好在轨**，不该降级；花掉一半只跑完五分之一才是要出事。所以配置里没有阈值——超了降一档，降到底还超就收缩上下文，真的花完才停。

<details>
<summary><b>用 ChatGPT 订阅代替 API key</b></summary>

`openai-codex` 通过 ChatGPT 订阅访问同样的模型，调用由订阅覆盖，不按 token 计费：

```bash
code-review login openai-codex      # 浏览器授权，凭据存到 ~/.code-review/auth.json（0600）
code-review <pr-url> --model openai-codex/gpt-5.4
```

OAuth 流程本身是 pi 提供的；这里补的是终端交互和一个落盘的凭据存储——pi-ai 只提供内存版。

**注意**：订阅模式下 provider 不报告单次费用，预算改用 API 标价折算。它仍限制工作量、仍驱动降级链，但所有数字加 `≈` 前缀，报告里写明由订阅覆盖。它是**工作量上限，不是账单**。

</details>

---

## 架构

```
PR URL → 拉取(REST，不 clone) → 脱敏 → 切分成评审单元
       → 每个单元：确定性规则 ∥ agent 循环(只读工具 + submit_findings)
       → 去重 → 按证据分级 → 报告 / TUI 分诊 / 回评
```

机制细节见 [一次评审是怎么跑完的](docs/how-it-works.zh.md)；下面三个取舍的展开论证见 [设计文档](docs/design.zh.md)：

- **每个文件一个 agent 循环**，不是整个 PR 一次调用。文件是人做 review 的思考单位，也让断点、预算、上下文都有了自然边界。
- **预算与追踪挂在 stream function 上**，不散在流程里。这样它们对每一次 LLM 调用生效，而 pipeline 完全不知道它们存在。
- **"可直接采纳"只认机器证据**。曾写过"附近有规则命中就提升置信度"，被测试推翻删掉了——位置相近不等于说的是同一件事。

依赖 pi 的三个包：`pi-ai`（统一 LLM 接口 + 逐次用量/成本）、`pi-agent-core`（agent 循环 + 声明式工具）、`pi-tui`（差分渲染终端 UI）。

产物示例见 [`examples/`](examples/)：[评审报告](examples/sample-report.zh.md)、[一条 trace](examples/sample-trace.jsonl)、[断点文件](examples/sample-state.json)。

---

## 开发

```bash
npm test              # 243 个测试，全部离线，不需要任何 API key
npm run typecheck
npm run dev -- <url>  # tsx 直跑，不用先 build
```

测试不需要网络：LLM 走 pi-ai 的 faux provider，GitHub 走内存假 adapter，TUI 走实现了 `Terminal` 接口的桩。

<details>
<summary><b>已知限制</b></summary>

- **续跑粒度是文件级**。崩在文件中间会重跑那个文件（几分钱），不是从上一次工具调用继续。更细的粒度要持久化 agent 中间状态，复杂度不划算。
- **`ts_syntax_check` 拿不到跨模块类型**（没有 `node_modules`），只查语法和文件内自洽的类型错误。
- **GitLab 回评是逐条 discussion**，不像 GitHub 一次提交，部分失败时会有一半评论已发出。
- **`--verify` 只标注、不改分级**。让第二个模型同意就升级是自欺欺人——模型互相同意不是确定性。
- **顺序执行**，大 PR 比并行慢 3-4 倍。换来确定的花费顺序和可读的断点语义。

</details>

<details>
<summary><b>在代理后面</b></summary>

Node 的 `fetch` 默认**不读** `HTTPS_PROXY`（curl 会读），表现为一个看起来像 API key 出问题的 `Connection error.`。检测到配置了代理会自动带 `NODE_USE_ENV_PROXY=1` 重启一次，无需手动处理。

</details>

---

## 关于 AI 的使用

本项目由 AI 辅助完成，过程记录在 [`docs/ai-usage.md`](docs/ai-usage.md)：哪些是 AI 写的、怎么验证的、AI 写错了什么（6 个缺陷）、又是怎么被发现的。

MIT License.
