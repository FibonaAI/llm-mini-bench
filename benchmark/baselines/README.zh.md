# Mini Bench 基线

[English](README.md)

本目录只保存通过完整性检查的 `assessment-baseline-v1` 快照。每份基线保留 14 题的全部预定轮次、逐题内容分和指令检查，不计算全库总分或能力权重。部分题目、运行失败或不可评分的样本不能补成零分，也不能导入基线。

这些文件是离线验证证据，不是用户的初始数据。应用不会将本目录加载到个人工作区，只展示配置的数据目录中保存的个人基线。

基线快照、原始 JSONL 和验证报告都保存在本目录。原始记录中的历史路径字段不改写；当前文件位置以基线快照的 `evidence.path` 为准，相对 `benchmark/` 解析。随附快照和原始 JSONL 保留原始字节。

## 随项目提供的实测

当前只有 `remote-magpie/openai/gpt-6-luna`、请求 thinking 为 `high` 的一次完整轮次，采集于 2026-11-10。14 题均完成且可评分。这一份观测不构成已校准榜单，不能证明模型排名、重复稳定性或广泛能力。

保存的源码哈希映射以评测根目录 `benchmark/` 为路径基准。原始证据保留在 [`baselines/assessment-bank-1.0-smoke.jsonl`](assessment-bank-1.0-smoke.jsonl)，离线验证结果见 [`baselines/assessment-baseline-verification.json`](assessment-baseline-verification.json)。TypeScript 重放报告区分原始 Python 来源与当前 TypeScript 源码哈希，离线检查已保存的请求协议、评分重算和模拟工具调用。它记录这份证据的行为等价性，不声称源码相同，也不重新调用模型。

[assessment-historical-provenance.json](assessment-historical-provenance.json) 固定随附快照的精确摘要及原始 Python 来源。快照保留原判分与执行程序的源码哈希，不把历史执行冒充为当前程序执行。此例外不接受任意历史个人基线。原记录没有账户绑定，`account_ref` 为 `null`，`account_evidence` 为 `unrecorded`。请求的 thinking 不等于已独立验证上游实际启用的 thinking。用量来自保存的响应，费用是逐次调用的估算之和，不是账单。

## 导入新基线

在仓库根目录运行：

```bash
bun benchmark/tools/import_assessment_baseline.ts /path/to/run.json \
  --target-id TARGET_ID --output-dir benchmark/baselines
```

输入必须是原生 Bench `run.json`，且目标完整运行了 Mini Bench 的所有题目和预定轮次。工具校验题目快照、来源哈希、逐样本协议及可评分性后写入以内容哈希命名的 JSON，不调用模型，也不兼容旧题库报告。

加载器拒绝旧 schema、损坏文件和不兼容来源。新基线必须符合当前题目与源码证据。明确固定的历史随附观测按其原始来源校验。历史个人运行仍可查看，但不能通过替换源码哈希将不兼容运行提升为基线。复查随项目提供的证据：

```bash
bun benchmark/tools/replay_assessment_evidence.ts
```
