# 产物示例 / Sample artifacts

这些文件来自对 [yanmxa/code-review#1](https://github.com/yanmxa/code-review/pull/1)
的一次真实运行，未经编辑。

| 文件 | 是什么 |
| --- | --- |
| `sample-report.md` | 评审报告：按置信度分两组，每条附证据与 trace 路径，附录含花费明细与脱敏统计 |
| `sample-trace.jsonl` | 一个评审单元的完整 trace：规则命中、完整 prompt、模型原始回复、每次工具调用与结果、用量 |
| `sample-state.json` | 断点文件：各单元状态、累计花费、降级档位、diff 哈希 |

注意 `sample-trace.jsonl` 里那条被埋入 PR 的 AWS 密钥 —— 它只以
`[REDACTED:aws-access-key:5d3c]` 出现，原值从未离开本机。
