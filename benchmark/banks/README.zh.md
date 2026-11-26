# 题库文件

[English](README.md)

Assessment 2.0 与 Assessment 1.0 是并存提供的两套正式题库：

- [assessment-2.0.json](assessment-2.0.json) 与 [assessment-2.0.questions.json](assessment-2.0.questions.json)：Assessment 2.0 正式清单与 12 题导出（`task_sha256: 84feeda2…24a3`），采用极简无引导精确字段评分与证据门控 `v2` 交互模拟器
- [assessment-1.0.json](assessment-1.0.json) 与 [assessment-1.0.questions.json](assessment-1.0.questions.json)：Assessment 1.0 正式清单与 12 题导出（`task_sha256: d58ddb12…fed8`），采用精确字段评分与 `v1` 交互模拟器

加载器是 `src/assessment_bank.ts`，按所选版本清单加题面文件路径统一加载并校验全部任务快照与源码摘要。`src/assessment_data.ts` 实现共用精确字段数据评分，`src/assessment_interactive.ts` 绑定 `v1` 内存模拟器，`src/assessment_interactive_v2.ts` 在复用底层状态机的基础上绑定 `v2` 证据门控评分器。数据化标准答案和模拟器配置均参与各自题库的任务哈希计算。

清单中的源码路径均以评测根目录 `benchmark/` 为基准，固定 `src/assessment_tasks.ts`、`src/assessment_json.ts`、`src/assessment_data.ts` 以及 `extension_sha256` 中的交互模拟器模块。

评分与校准详见[题库说明](../../docs/ASSESSMENT_BANK.zh.md)，验证要求见[维护指南](../../AGENTS.zh.md)。
