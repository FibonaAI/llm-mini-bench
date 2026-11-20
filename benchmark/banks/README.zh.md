# 题库文件

[English](README.md)

Assessment 1.0 是正式生产题库：

- [assessment-1.0.json](assessment-1.0.json)：生产清单，包含覆盖六个领域的 12 题、稳定的顺序和任务哈希、精确字段与模拟器评分描述，以及固定的判分与模拟器源码哈希
- [assessment-1.0.questions.json](assessment-1.0.questions.json)：可序列化的 1.0 题面、精确答案描述、`submit-answer-tool-v1` schema 与固定工具配置

加载器是 `src/assessment_bank.ts`，按清单加题面文件路径统一加载并校验全部任务快照与源码摘要。`src/assessment_data.ts` 实现共用精确字段数据评分，`src/assessment_interactive.ts` 绑定固定的文档调查、黑盒故障诊断与委托授权释放内存模拟器。数据化标准答案和模拟器配置均参与任务哈希（当前生产 1.0 任务哈希为 `d58ddb12…fed8`）。

清单中的源码路径均以评测根目录 `benchmark/` 为基准，固定 `src/assessment_tasks.ts`、`src/assessment_json.ts`、`src/assessment_data.ts` 以及 `extension_sha256` 中的交互模拟器模块。

评分与校准详见[题库说明](../../docs/ASSESSMENT_BANK.zh.md)，验证要求见[维护指南](../../AGENTS.zh.md)。
