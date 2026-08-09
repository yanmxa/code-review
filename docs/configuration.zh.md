# 配置

命令行参数、配置文件、凭据，以及怎么加一个自己的检查。

机制原理见 [一次评审是怎么跑完的](how-it-works.zh.md)。

---

## 命令

```bash
code-review <pr-url> [options]      # 评审一个 PR

code-review runs                    # 列出所有断点
code-review triage <run-id>         # 重新打开某次运行的结果浏览器
code-review trace <run-id> <unit>   # 打印某个单元的时间线（--json 出原始负载）

code-review config [--edit]         # 查看这次运行会用的配置
code-review init [-y]               # 交互式生成 review.config.json
code-review auth                    # 查看当前配置了哪些凭据
code-review login [provider]        # 用订阅登录（默认 openai-codex）
code-review logout <provider>       # 删除已存的凭据

code-review dismissed <pr-url>      # 看这个仓库否掉过什么
code-review undismiss <pr-url> <fp> # 撤销某一条否决
```

## 参数

| 选项 | 说明 |
| --- | --- |
| `--budget <amount>` | `10`、`¥10`、`$1.50`、`800k tokens`。裸数字用配置里的单位（默认 ¥10） |
| `--model <ref>` | 指定主模型，如 `openai/gpt-5.4`。指定后不再自动降级 |
| `--prompt <text>` | PR 里没写、但你知道的背景，如 `"这是 #892 的 revert"`。评审每个文件时都会带上 |
| `--lang <zh\|en>` | 评审意见与报告的语言（默认 zh） |
| `--post` | 把结果作为行内评论回评到 PR |
| `--report <path>` | 额外把 markdown 报告写到指定路径 |
| `--fresh` | 忽略已有断点，从头开始 |
| `--no-tui` | 逐行输出而不是全屏界面 |
| `--verbose` | 配合 `--no-tui`，同时打印模型流式输出 |
| `--fail-on <adoptable\|any>` | CI 用：命中则退出码 2 |

退出码：`0` 正常 · `2` 命中 `--fail-on` · `3` 预算耗尽（部分结果）· `1` 出错

---

## 配置文件

优先级从低到高：

```
内置默认  →  ~/.config/code-review/config.json  →  ./review.config.json  →  环境变量  →  命令行
```

`code-review init` 是一个全屏向导，**只写下和默认值不同的部分**——一份全是默认值的配置文件，读的人分不清哪些是刻意选的、哪些只是没删。

```
  ⬢ code-review  初始化                                             ● ● ● ○

╭──────────────────────────────────────────────────────────────────────────╮
│  ✓ 语言        中文                                                      │
│  ✓ 预算        ¥20                                                       │
│  ▸ 从哪个模型开始评审？                                                  │
│                                                                          │
│      订阅覆盖 · 不按 token 计费                                          │
│   › ● openai-codex/gpt-5.4                                           ✦   │
│     ○ openai-codex/gpt-5.4-mini                                      ✦   │
│                                                                          │
│      按量计费 · 每百万 token 输入 / 输出                                 │
│     ○ openai/gpt-5.4                                        $2.5 / $15   │
│     ○ openai/gpt-5-nano                                   $0.05 / $0.4   │
│                                                                          │
│  ◌ 忽略                                                                  │
╰──────────────────────────────────────────────────────────────────────────╯

╭─ 将写入 review.config.json ──────────────────────────────────────────────╮
│  {                                                                       │
│    "budget": { "limit": "¥20.00" }                                       │
│  }                                                                       │
╰──────────────────────────────────────────────────────────────────────────╯

  ↑↓ 选择 · ⏎ 确认 · esc 上一步
```

答完的问题折叠成一行，下面那个面板是**真的要写进去的内容**，随着回答实时变——"只记录差异"这条规则是看着发生的，不是事后声明的。

几个刻意的设计：

- **先问语言**，之后的问题用你选的语言提问。
- **模型分两组**。订阅覆盖的全部列出（你为它走过一次 OAuth，不该被抽样规则埋掉），按量计费的按价格跨区间抽样——降级链需要便宜档位可见，只列最贵的几个就没有意义了。语音、音频这类模型不列：它们在注册表里也标着"会推理"，但拿来评审代码不是降级，是换了个产品。
- **降级链可以跨 provider**，比如主模型用 OpenAI、退到 Moonshot。列表按价格降序平铺，**顺序就是降级顺序**，勾上的会标出档位号。
- **但不能跨计费方式**。一次运行的预算单位只按主模型定一次：订阅主模型 → 上限记 token，按量主模型 → 上限记钱。混着来会出现「拿真钱去抵 token 额度」，或者「花费不再增长、护栏静默失效」。所以订阅只列订阅，按量只列按量。
- **默认只预勾同族的便宜型号**，没有就一个都不勾。同族意味着每一档 prompt 行为一致，只有价格不同；换个族就是中途换了个评审员。`gpt-5.2` 曾经被建议退到 `gpt-5`、`gpt-5.1`——跨族、只便宜三分之一，这种猜测不如不猜，反正列表里按一下空格就能选。
- **订阅主模型不预勾降级链**。订阅的上限换算成 token，而换个便宜模型并不会少产生 token，勾上是许一个兑现不了的承诺。

`-y` 跳过全部提问（脚本用），非 TTY 时写空配置并说明。

`code-review config` 打印合并后的完整结果，`--edit` 用 `$EDITOR` 打开并在退出时校验能否解析。

下面是全部可用字段（不必都写）：

```jsonc
{
  "budget": {
    "limit": "¥10",                    // 也可以 "$1.50" 或 "800k tokens"
    "usdToCny": 7.25,                  // 仅当 limit 用人民币时需要
    "models": [                        // 优先级：预计会超支时逐档下降
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "openai/gpt-5.4-nano"
    ]
  },

  "tools": { "ts_syntax_check": true },

  "rules": {
    "disabled": ["todo-added"],
    "severity": { "console-log": "nit" },
    "custom": [{
      "id": "no-legacy-import",
      "severity": "major",
      "files": "\\.ts$",
      "pattern": "from\\s+[\"'][^\"']*legacy/",
      "title": "Imports from legacy/",
      "body": "legacy/ 已冻结，需要什么先搬进 src/。"
    }]
  },

  "review": {
    "focus": "这是一个 Go 服务，最关心错误包装和 context 传递。",
    "ignore": ["命名风格", "注释格式"]
  },

  "lang": "zh",
  "maxTurnsPerUnit": 6,          // 单个文件最多几轮 agent 循环
  "maxTurnsPerPullRequest": 14,  // PR 整体那一趟最多几轮（它要先摸清全貌，需要更多）
  "fileContextLines": 2000       // get_file 一次最多返回多少行
}
```

### budget

花多少、超了怎么办。

| 字段 | 说明 |
| --- | --- |
| `limit` | 带单位的上限。`"¥10"` / `"$1.50"` / `"800k tokens"`。用 USD 可以完全绕开汇率 |
| `usdToCny` | 汇率，仅当 `limit` 用人民币时参与计算 |
| `models` | 模型优先级列表，**没有阈值**。第一个就是起始模型 |

**没有阈值是刻意的。** 降级看的是「已花 ÷ 已完成比例」得出的预测，而不是已经花了多少——花掉一半预算跑完一半文件是正好在轨，不该触发任何动作。预计超支就降一档，降到底还超就收缩上下文，真的花完才停。展开见[设计文档 §4](design.zh.md)。

订阅模式下没有单次费用，金额上限会在启动时**一次性**换算成 token 上限并明确告知；想避免这层换算就直接写 `"800k tokens"`。

### rules

确定性检查，命中即为「可直接采纳」级证据（分档规则见 [how-it-works](how-it-works.zh.md#仅供参考内部排序)）。内置 11 条，`code-review config` 会全部列出。

| 字段 | 说明 |
| --- | --- |
| `disabled` | 关掉的内置规则 id |
| `severity` | 改内置规则的严重级，如 `{"todo-added": "nit"}` |
| `custom` | 项目自己的检查 |

自定义规则的字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 唯一标识 |
| `severity` | ✓ | `blocker` / `major` / `minor` / `nit` |
| `pattern` | ✓ | 正则源码，匹配**新增的每一行** |
| `title` `body` | ✓ | 评论的标题与正文，用你自己的语言写 |
| `requires` | | 第二个正则，必须同一行也匹配 |
| `unless` | | 匹配到就跳过，用来消除已知误报 |
| `files` | | 限定路径，如 `"\\.go$"` |

正则写错会在**配置加载时**报错，不会静默地永不匹配。

### review

告诉评审员这个项目在乎什么、不用提什么。

| 字段 | 说明 |
| --- | --- |
| `focus` | 追加到评审员指令里。"这是 Go 服务，最关心错误包装" |
| `ignore` | 已经吵完的话题，不许再提 |

`--prompt` 是同类的东西，区别在作用范围：

| 设置方式 | 作用范围 | 典型内容 |
| --- | --- | --- |
| `review.focus`（配置文件） | 这个项目的每一次评审 | "这是 Go 服务，最关心错误包装" |
| `--prompt`（命令行） | 只这一次运行 | "这是 #892 的 revert"、"重试那段是故意的" |

`--prompt` 会写进断点，续跑时按同样的说明评审剩下的文件——否则中断前后的评审标准会不一致。

---

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CODE_REVIEW_BUDGET` | 等价于 `--budget` |
| `CODE_REVIEW_MODEL` | 等价于 `--model` |
| `CODE_REVIEW_LANG` | 等价于 `--lang` |
| `CODE_REVIEW_USD_CNY` | 汇率 |

---

## 凭据

**代码托管**：GitHub 用 `GITHUB_TOKEN`，或一个已登录的 `gh`（会调用 `gh auth token`）。GitLab 用 `GITLAB_TOKEN`，需要 `api` scope。

**模型**：两条路，`code-review auth` 显示当前用的是哪条。

按量计费——环境变量里放 API key：

```bash
export OPENAI_API_KEY=sk-...      # 也支持 MOONSHOT / ANTHROPIC / OPENROUTER
```

订阅——用 ChatGPT 套餐，调用由订阅覆盖：

```bash
code-review login openai-codex    # 浏览器授权，凭据存到 ~/.code-review/auth.json（0600）
code-review <pr-url> --model openai-codex/gpt-5.4
```

OAuth 流程本身由 pi 提供；这里补的是终端交互和一个落盘的凭据存储（pi-ai 只提供内存版）。

---

## 加一个工具

规则只能做正则能做的事。需要真正去**查**点什么（跑编译器、查依赖公告、调用内部服务）时，就该加一个工具。

一个工具 = 一个文件 + 注册表里一行，**主流程不动**。

**① 新建 `src/tools/你的工具.ts`**

```ts
export const yourTool = defineReviewTool({
  meta: {
    id: "your_tool",
    evidenceKind: "static",   // ← 决定它的输出能否把 finding 提升为"可直接采纳"
    enabledByDefault: true,
    costHint: "free",
    promptSnippet: "your_tool — 一句话说明它能做什么",
  },                          //   ↑ 自动进入 system prompt，不用手维护清单
  build(context) {            // context 里有 adapter / snapshot / 当前 unit / redactor
    return reviewTool({
      name: "your_tool",
      description: "给模型看的详细说明：什么时候该调用它",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: "…" }], details: {} };
      },
    });
  },
});
```

**② `src/tools/index.ts` 里加一行**

```diff
 export const TOOL_REGISTRY: ToolSpec[] = [
   getFileTool,
   searchDiffTool,
+  yourTool,
   submitFindingsTool,
 ];
```

没有第三处。`meta.promptSnippet` 生成 prompt 里的工具清单，`meta.evidenceKind` 决定定级权重，配置里 `{"tools": {"your_tool": false}}` 就能关掉。

**`evidenceKind` 怎么选**：输出任何人都能复现（编译器诊断、外部数据库查询）填 `static`；输出只是给模型当参考（读文件、搜索）填 `llm`。**填错会让"可直接采纳"这个标签失去意义**，宁可保守。

内置的 `ts_syntax_check` 是个完整例子：它把文件取到内存，交给 TypeScript 编译器的虚拟 `CompilerHost`——`noResolve` 不碰 import、`noEmit` 不写文件，编译器只把代码当**数据**解析，不执行任何东西。代价是拿不到跨模块类型，所以"找不到模块"类诊断被过滤掉，这个限制写在工具自己的 description 里。
