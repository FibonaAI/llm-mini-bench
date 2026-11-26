# Mini Bench 基线

[English](README.md)

本目录用于存放通过完整性检查、供离线参考的 `assessment-baseline-v1` 快照。每份基线保留正式发布题库（`1.0` 或 `2.0`）全部 12 题的所有预定轮次、所属 `bank_version`、逐题内容分、指令检查和工具检查。部分题目、运行失败或不可评分的样本不能补成零分，也不能导入基线。

这些文件是离线参考证据，不是用户的初始数据。应用启动时个人工作区为空，只展示配置的数据目录中保存的个人运行与基线。

## 导入新基线

在仓库根目录执行：

```bash
bun benchmark/tools/import_assessment_baseline.ts /path/to/run.json \
  --target-id TARGET_ID --output-dir benchmark/baselines
```

输入必须是原生 Bench `run.json`，且对应目标完成了 Assessment `1.0` 或 `2.0` 的全部 12 道题目和所有预定轮次。工具会检查任务快照、源码哈希、逐样本执行协议和可评分性，并以内容哈希命名输出 JSON 文件，不会调用模型。
