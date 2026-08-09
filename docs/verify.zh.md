# 自己验一遍

下面不是测试断言，是可以直接敲的命令。演示 PR 里埋了六个缺陷。

```bash
PR=https://github.com/yanmxa/code-review/pull/1
```

---

## 断网重启不重跑

```bash
code-review $PR --budget 6 &
sleep 30 && pkill -f "code-review $PR"
code-review $PR --budget 6
```

第二次会打出 `[resumed from checkpoint]`，只重跑被打断的那个文件。**已花的钱接着累加，不从零开始**——实测第一次跑到 7679 tokens 被杀，续跑从那里继续到 9.6k。

`code-review runs` 能看到断点。

## 预算降级

```bash
code-review $PR --budget ¥0.22 --fresh --no-tui | grep downgrade
```

看的是**预测**不是已花：跑完第 1 个文件预测总共要 ¥0.46，超了 ¥0.22 就降一档；预测随后收敛 0.46 → 0.27 → 0.19，最终 ¥0.16 落在预算内，退出码 0。

## 预算硬停

```bash
code-review $PR --budget "9k tokens" --fresh --no-tui ; echo "exit $?"
```

退出码 **3**。4 个文件只有 2 个过了 LLM，但报告里仍有 8 条「可直接采纳」——**规则不花钱，所以照跑**。这是"部分结果"和"截断结果"的区别。

## secret 没进过 prompt

```bash
code-review $PR --no-tui
grep -r "AKIAIOSFODNN7EXAMPLE" ~/.code-review/runs/   # 零命中
grep -r "wJalrXUtnFEMI" ~/.code-review/runs/          # 零命中（secret key）
grep -rho "\[REDACTED:[a-z-]*:" ~/.code-review/runs/ | sort -u
```

trace 里存的是**完整 prompt 和模型原始回复**，所以这个 grep 是真检查。

## 跨文件的那一趟

```bash
code-review trace $(ls -t ~/.code-review/runs | head -1) '#pull-request'
```

看它自己决定去看哪里：先 `list_changed_files`，再 `get_diff` 铺开，然后 `search_diff` 验证某个怀疑。它在这个 PR 上报的是 `withRetry` 没有调用方——`retry.ts` 和 `session.ts` 单独看都完整，逐文件那趟报不出来。

## 回评幂等

```bash
code-review $PR --post
code-review $PR --post     # Posted 0 comment(s), skipped N already present
```

第二趟发完，去 PR 上看：上一趟的汇总已经折叠成灰色（GitHub 记作 outdated，点开还能看），只有最新那条摊开。行内评论不折叠——一条意见没被谁撤回，它就还是那一行上的最后一句话。

## 被否掉的不再提

到 PR 上删掉一条它发的评论，然后：

```bash
code-review $PR --post                # learned 1 new dismissal(s), withheld 1
code-review dismissed $PR             # 看它记住了什么
code-review undismiss $PR <fingerprint>   # 撤销
```

被扣下的意见不会出现在任何输出里，只报告扣了几条。

## 给它 PR 里没写的背景

```bash
code-review $PR --fresh --prompt "retry.ts 里那个 i <= attempts 是故意的"
```

那条 off-by-one 就不会再报。`--prompt` 会写进断点，续跑时沿用同一份说明。

---

## 离线跑测试

```bash
npm test          # 319 个，不需要任何 API key
```

LLM 用 pi-ai 的 faux provider，代码托管用内存适配器，终端用实现了 pi-tui `Terminal` 接口的桩。
