# 评测辅助工具

[English](README.md)

从仓库根目录用 Bun 执行以下命令。输入和输出的相对路径以当前工作目录为基准，其他位置的文件可使用绝对路径。这些工具只处理已保存的本地数据，不调用模型。

## 汇总校准记录

```sh
bun benchmark/tools/analyze_assessment.ts INPUT.jsonl --output SUMMARY.json
```

输入是 `benchmark/calibrate_assessment.ts` 产生的 JSONL，输出保留各目标、各题与所有重复轮次，分别记录内容得分、指令检查和执行失败。不生成全库权重，不导出自动排名。输出文件必须尚不存在。

## 汇总排除异常后的完成得分

```sh
bun benchmark/tools/report_assessment_completion.ts \
  --input INPUT.jsonl --output COMPLETION.json
```

这个补充指标保留已完成的有限得分，将明确的任务失败及歧义、不可评分的最终提交计为零分，排除 API、传输及其他基础设施异常。对每个模型与 Thinking 组合，异常最多占全部预定题目与轮次样本的 30%。10 个样本中 3 个异常、20 个样本中 6 个异常均可接受，超过后输出 `assessment_valid: false` 和 `score_percent: null`。得分为纳入样本的分数之和除以纳入数量，再乘 100。展示得分时必须同时展示异常数量，排除异常可能使比较产生偏差。

旧记录中的 `SampleTimeout` 或 `TimeoutError` 本身只能归为原因未明的超时异常，不能证明模型计算失败，流式活动也不能确定超时原因。纯评分 API 可接收单独核实的计算超时证据，也接受经审阅确认的任务到时未完成记录：原始证据必须显示实质性推理或回答内容持续至已记录的本地整题超时，但不据此声称上游持续计算了多久。当前执行器与这个 CLI 都不会仅凭事件数量、心跳或时间自动作出这些判断。

缺失、重复或非预定样本会被拒绝。重复传入 `--input` 只能合并不同目标，且题库内容、源码哈希、配置和轮次计划必须一致。报告记录输入和报告源码摘要，不自行重放评分器，也不覆盖已有文件。原始记录、生产分析图入选条件和基线规则保持不变。

## 在工作区查看校准结果

```sh
bun benchmark/tools/import_calibration.ts --input INPUT.jsonl [--data-dir DIR]
```

把一份 `benchmark/calibrate_assessment.ts` 的 JSONL 转成个人工作区里的只读运行（默认 `MAGPIE_BENCH_DATA_DIR` 或 `~/.local/share/magpie-mini-bench`），任务页和分析页就能看到它的逐题矩阵、失败原因和得分。原始字节原样复制为运行日志，并记录输入文件摘要；同一文件重复导入不会生效。导入的运行标为“校准导入”，没有路由身份，不能重试，也不能升级为基线。实验题库仍不会出现在正式图表里。运行在服务启动时加载，导入后需要重载插件或重启服务。

## 从完整运行导入基线

```sh
bun benchmark/tools/import_assessment_baseline.ts /path/to/assessment/RUN_ID/run.json \
  --target-id TARGET_ID --output-dir benchmark/baselines
```

输入必须是执行服务保存的完整 `run.json`，不是校准器的 JSONL，也不是旧基线摘要。工具校验 1.0 完整 14 题、全部预定轮次、题库哈希、源码和逐样本执行协议，只接受完成且可评分的结果。

输出文件名由完整快照的内容哈希生成。相同证据再次导入不会覆盖不同内容。随附基线目录属于项目资料；个人基线推荐通过插件页面保存，避免把个人数据写入项目。

## 重放随附历史证据

```sh
bun benchmark/tools/replay_assessment_evidence.ts
```

命令先校验已登记的快照和原始文件摘要，再通过当前 TypeScript 实现重放 19 份已保存响应、5 次模拟器调用和 14 份评分。它直接输出报告，不发网络请求，也不修改历史证据。使用 `--output NEW_FILE` 可将报告保存到新文件。报告区分历史 Python 源码哈希与当前 TypeScript 源码哈希，结果一致不表示源码相同。

## 真实评测入口

`bun benchmark/bench.ts start` 和 `bun benchmark/calibrate_assessment.ts` 会发请求，可能收费，不属于离线验证。常规使用方法见[项目首页](../../README.zh.md)，详细预算与路由见[执行说明](../../docs/BENCH_EXECUTION.zh.md)。
