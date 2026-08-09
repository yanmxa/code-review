# code-review

给一个 PR 链接，产出**按证据分级**的代码评审意见。基于 [pi](https://github.com/earendil-works/pi) 框架。

*[English →](README.md)*

**它怎么读一个 PR**

- **确定性检查先行** —— 密钥、SQL 拼接、不安全随机数、缺测试。不花钱，命中即为可采纳级证据
- **每个文件一个 agent** —— 只读工具，最多 6 轮
- **再来一趟看整体** —— 自己决定去看哪里，找调用方没跟着改、model 加了字段而 migration 没加这类问题
- **CI 结果一起喂进去** —— 失败的测试和精确到行的报错随 diff 进上下文，不用模型猜
- **只在有依据时下结论** —— 有确定性证据的「可直接采纳」，模型推断的「仅供参考」，后者还带一个自评（`◉确定` `◐多半` `○拿不准`），只影响排序
- **被否决过的不再提** —— 删掉或 resolve 一条评论就是永久否决
- **能补充 PR 里没写的背景** —— `--prompt "这是 #892 的 revert"`

完整机制见 [一次评审是怎么跑完的](docs/how-it-works.zh.md)。

**它作为工具是否可信**

- **断网重启不重跑** —— 崩了就重跑同一条命令，自动接着上次继续（[原理](docs/how-it-works.zh.md#断点续跑)）
- **花费有上限** —— 预算超了自动降级模型，再超就停，但零成本的规则检查照常跑完（[budget](docs/configuration.zh.md#budget)）
- **每条意见可追溯** —— 完整 prompt、模型原始回复、工具调用全在一个 trace 文件里（[trace](docs/how-it-works.zh.md#trace-与否决记忆)）
- **密钥不出本机** —— 脱敏由类型系统强制，不 clone 仓库、不执行任何仓库代码（[实例](docs/how-it-works.zh.md#例一一个被提交进来的密钥)）
- **规则和评审重点可配置** —— 项目自己的检查和关注点写在配置里，不用改源码（[怎么配](docs/configuration.zh.md#配置文件)）

---

## 快速开始

```bash
git clone https://github.com/yanmxa/code-review && cd code-review
npm install -g .                       # 编译并把 code-review 装到 PATH
                                       # （卸载：npm uninstall -g code-review）

export OPENAI_API_KEY=sk-...           # 也支持 MOONSHOT / ANTHROPIC / OPENROUTER
gh auth login                          # 或 export GITHUB_TOKEN

code-review auth                       # 确认凭据已识别
code-review init                       # 交互式选好预算和模型（想改就再跑一次）
code-review config                     # 看这次会用什么预算和降级链
code-review https://github.com/yanmxa/code-review/pull/1 --budget 6
```

不想装全局：`npm install && npm run dev -- <pr-url>`。

---

### 自己验一遍

续跑、预算降级、硬停、脱敏、幂等回评、跨文件那一趟、否决闭环——每条都是可以直接敲的命令，不是让你相信的测试断言：**[docs/verify.zh.md](docs/verify.zh.md)**。

---

## 界面

评审进行中：左边文件进度，右边 agent 此刻在做什么，顶部始终是花费和当前模型。

```
⬢ yanmxa/code-review #1 demo: add cache eviction, session lookup, and retry helper
demo/planted-defects → main · 4 files                                            openai/gpt-5.4-mini
▱▱▱▱▱▱▱▱▱▱ ¥0.04/¥1.00 · → ¥0.06 · ↑1.8k ↓1.2k ⛁10.8k

╭─ 文件 ─────────────────────────── 3/4 ─╮╭─ 进行中 ───────────────────────────────────────────────╮
│✓ demo/src/config.ts                 2  ││                                                        │
│✓ demo/src/retry.ts                  2  ││▸ demo/src/session.ts                                   │
│⠹ demo/src/session.ts                   ││  → get_file demo/src/session.ts                        │
│                                        ││    demo/src/session.ts                                 │
│                                        ││  → get_file demo/src/db.ts                             │
│                                        ││  → search_diff loadSession\(|newSessionToken\(|fin...  │
│                                        ││    2 matching changed line(s):                         │
│                                        ││    File not found at head commit: demo/src/db.ts       │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
│                                        ││                                                        │
╰────────────────────────────────────────╯╰────────────────────────────────────────────────────────╯

━━━━━━━━━━━━ 3/4 · 00:23  ●4 ○2                                                    ctrl+c 存档并退出
```

<details>
<summary><b>跑完进入分诊：按置信度分两组，可采纳的默认已勾选</b></summary>

`p` 一键回评选中的。右侧显示这条意见**凭什么**被判成这一档。

```
⬢ 评审结果 · 11 total  ● 8  ○ 3                                               ▰▱▱▱▱▱▱▱▱▱ ¥0.12/¥1.00

╭─ 发现 ────────────────────────── 8/11 ─╮╭─ 详情 ─────────────────────────────────────────────────╮
│● 可直接采纳 (8)                        ││提交中包含疑似密钥                                      │
│▌[x] ● config.ts:4 提交中包含疑似密钥   ││                                                        │
│ [x] ● config.ts:5 提交中包含疑似密钥   ││文件    demo/src/config.ts:4                            │
│ [x] ● session.ts:14 SQL 语句拼接变量   ││严重级  阻断                                            │
│ [x] ● session.ts:8 用非密码学随机...   ││置信度  ● 可直接采纳                                    │
│ [x] ● cache.ts:15 新增了 console 日志  ││                                                        │
│ [x] ● retry.ts:1 改动没有配套的测...   ││说明 ───────────────────────────────────────────────    │
│ [x] ● session.ts:4 改动没有配套的...   ││  这一行被密钥扫描器判定为                              │
│ [x] ● session.ts:4 使用了宽松相等比较  ││  `aws-access-key`（内容已在传给模型前脱敏）。请从代码  │
│                                        ││  中移除，改用环境变量或密钥管理服务，并**轮换该凭据**  │
│○ 仅供参考 (3)  ◉确定 ◐多半 ○拿不准     ││  ——它已经进入了 git 历史。                             │
│ [ ] ◉ retry.ts:3 `attempts` 被多执...  ││                                                        │
│ [ ] ◉ session.ts:15 吞掉数据库异常...  ││改动 ───────────────────────────────────────────────    │
│ [ ] ◐ cache.ts:11 更新已有键时会误...  ││    1  export const config = {                          │
│                                        ││    2    region: "us-east-1",                           │
│                                        ││    3    timeoutMs: 5000,                               │
│                                        ││▸   4 +  awsAccessKeyId: "[REDACTED:aws-access-key:...  │
│                                        ││    5 +  awsSecretAccessKey: "[REDACTED:generic-ass...  │
│                                        ││─────────────────────────────────────────────  18/23    │
│                                        ││t 查看完整 trace   traces/demo_src_config.ts.jsonl      │
╰────────────────────────────────────────╯╰────────────────────────────────────────────────────────╯

                        ↑↓ 移动 · space 选中 · a 全选可采纳 · J/K 翻详情 · t trace · p 回评 · q 退出
```

</details>

<details>
<summary><b>按 <code>t</code> 查看某条意见的完整 trace</b></summary>

```
╭─ F-010 · traces/demo_src_session.ts.jsonl ─────────────────────────────────────────╮
│▌16:54:37 ✦ rule no-test-change demo/src/session.ts:4                               │
│ 16:54:37 ✦ rule loose-equality demo/src/session.ts:4                               │
│ 16:54:37 ✦ rule insecure-random demo/src/session.ts:8                              │
│ 16:54:37 ✦ rule sql-string-concat demo/src/session.ts:14                           │
│ 16:54:37 ▸ unit demo/src/session.ts openai/gpt-5.4-mini                            │
│ 16:54:37 ↑ llm 1 msg · 4 tools openai/gpt-5.4-mini                                 │
│ 16:54:40 ↓ llm toolUse ↑1.8k ↓64 $0.0016                                           │
│ 16:54:40 → get_file {"path":"demo/src/session.ts","startLine":1}                   │
│ 16:54:41   · demo/src/session.ts                                                   │
│ 16:54:41 ↑ llm 3 msg · 4 tools openai/gpt-5.4-mini                                 │
│ 16:54:43 ↓ llm toolUse ↑498 ↓112 $0.0010                                           │
│ 16:54:43 → get_file {"path":"demo/src/db.ts","startLine":1}                        │
│ 16:54:43   · File not found at head commit: demo/src/db.ts                         │
│                                                     ↑↓ 移动 · enter 展开 · esc 关闭│
╰────────────────────────────────────────────────────────────────────────────────────╯
```

调了哪些工具、发出去的 prompt 原文、模型原始回复、每步花了多少钱。回车展开任意一行。

</details>

没有 TTY 时（CI、管道、`--no-tui`）自动降级为逐行输出，消费的是同一个事件流。

---

## 命令与配置

```bash
code-review <pr-url> [options]      # 评审一个 PR
code-review runs                    # 列出所有断点
code-review triage <run-id>         # 重新打开某次运行的结果浏览器
code-review trace <run-id> <unit>   # 打印某个单元的时间线（--json 出原始负载）
code-review config                  # 查看这次运行会用的配置
code-review init                    # 交互式创建或修改配置
code-review auth                    # 看当前找到了哪些凭据
code-review login openai-codex      # 用 ChatGPT 订阅代替 API key
code-review dismissed <pr-url>      # 这个仓库已经否掉过什么
```

常用参数：

| 选项 | 说明 |
| --- | --- |
| `--budget <amount>` | `10`、`¥10`、`$1.50`、`800k tokens`（默认 ¥10） |
| `--model <ref>` | 指定主模型，指定后不再自动降级 |
| `--prompt <text>` | 这次运行的额外说明，如 `"这是 #892 的 revert"` |
| `--post` | 把结果回评到 PR |
| `--fresh` | 忽略断点从头开始 |
| `--fail-on <adoptable\|any>` | CI 用：命中则退出码 2 |

配置文件可以改预算与模型优先级、增删确定性规则、指定评审重点：

```jsonc
{
  "budget": { "limit": "¥10", "models": ["openai/gpt-5.4", "openai/gpt-5.4-mini"] },
  "rules":  { "disabled": ["todo-added"], "custom": [ /* 项目自己的检查 */ ] },
  "review": { "focus": "这是 Go 服务，最关心错误包装", "ignore": ["命名风格"] }
}
```

完整的参数、配置字段、凭据设置和「怎么加一个工具」见 **[配置文档](docs/configuration.zh.md)**。

---

## 扩展

规则只能做正则能做的事；要真正去**查**点什么（跑编译器、查依赖公告、调内部服务），就加一个工具。

一个工具 = 一个文件 + 注册表里一行，**主流程不动**：

```diff
 export const TOOL_REGISTRY: ToolSpec[] = [
   getFileTool,
   searchDiffTool,
+  yourTool,
   submitFindingsTool,
 ];
```

`meta.promptSnippet` 自动生成 prompt 里的工具清单，`meta.evidenceKind` 决定它的输出能否把发现提升为「可直接采纳」。没有第三处要改。

完整示例与 `evidenceKind` 怎么选，见 [配置文档](docs/configuration.zh.md#加一个工具)。

---

## 项目结构

```
src/
├── platform/      GitHub / GitLab adapter，自写的 unified diff 解析器
├── security/      脱敏：gitleaks 规则 + 熵值扫描，branded 类型强制
├── engine/
│   ├── units.ts        diff → 评审单元
│   ├── rules-engine.ts 确定性检查（内置 + 项目自定义）
│   ├── review-agent.ts agent 循环；预算与 trace 都挂在这里的 streamFn 上
│   ├── grade.ts        按证据定级、去重、fingerprint
│   └── pipeline.ts     只管顺序，不管内容
├── tools/         agent 可用的只读工具，声明式注册
├── budget/        账本 + 预测式降级
├── checkpoint/    断点：findings 先落盘，state 原子写入
├── memory/        仓库级的否决记忆
├── trace/         每单元一个 JSONL
├── report/        markdown 报告 + 幂等回评
└── tui/           dashboard / 分诊 / trace 浏览；plain.ts 是同一事件流的行式渲染
```

测试与被测模块一一对应，`test/` 下同名。

依赖 pi 的三个包：`pi-ai`（统一 LLM 接口 + 逐次用量/成本）、`pi-agent-core`（agent 循环 + 声明式工具）、`pi-tui`（差分渲染终端 UI）。设计取舍见 [设计文档](docs/design.zh.md)。

### 文档

| 文档 | 内容 |
| --- | --- |
| [一次评审是怎么跑完的](docs/how-it-works.zh.md) | 机制：跟着两条真实发现走完全程 |
| [自己验一遍](docs/verify.zh.md) | 上面每条说法对应的命令 |
| [配置](docs/configuration.zh.md) | 全部参数、配置字段、凭据、怎么加工具 |
| [设计文档](docs/design.zh.md) | 取舍：为什么这样设计，放弃了什么 |
| [`examples/`](examples/) | 真实运行的产物：[报告](examples/sample-report.zh.md) · [trace](examples/sample-trace.jsonl) · [断点](examples/sample-state.json) |

---

## 开发

```bash
npm test              # 301 个测试，全部离线，不需要任何 API key
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
