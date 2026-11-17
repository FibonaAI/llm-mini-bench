# 题库文件

[English](README.md)

Assessment 1.0 是唯一生产／默认题库。Assessment 2.0、2.1、2.2 和 2.3 都是 `experimental-unvalidated` 校准题库，绝不会被默认选择。

- [assessment-1.0.json](assessment-1.0.json)：生产清单，包含 14 题、稳定的顺序和任务哈希、命名评分描述、共用源码哈希及证据路径
- [assessment-1.0.questions.json](assessment-1.0.questions.json)：保持不变的 1.0 可序列化题面
- [assessment-2.0.json](assessment-2.0.json)：14 题实验清单，保留用于审查题目设计；仅凭接受/拒绝反馈无法确定任意隐藏状态名，其命名状态分数不是有效能力测量
- [assessment-2.0.questions.json](assessment-2.0.questions.json)：可序列化的 2.0 题面
- [assessment-2.1.json](assessment-2.1.json)：均衡实验清单，14 题覆盖推理、代码、证据整合、指令和工具使用
- [assessment-2.1.questions.json](assessment-2.1.questions.json)：可序列化的 2.1 题面
- [assessment-2.2.json](assessment-2.2.json)：紧凑的多领域实验题库清单，固定评分描述和源码哈希
- [assessment-2.2.questions.json](assessment-2.2.questions.json)：完整的 2.2 题面、精确答案描述与固定工具配置
- [assessment-2.3.json](assessment-2.3.json)：均衡覆盖六个领域的 12 题实验题库清单，固定评分描述与源码哈希
- [assessment-2.3.questions.json](assessment-2.3.questions.json)：完整的 2.3 题面、精确答案描述与固定工具配置

加载器是 `src/assessment_bank.ts`。所有版本都使用相同的清单加题面文件路径，没有按题库版本编写的加载分支。`src/assessment_data.ts` 实现共用精确字段数据评分，以及到命名内置 oracle 和固定模拟器的适配；`src/assessment_resource.ts` 提供声明式交互资源网络与模拟器，`src/assessment_dfa.ts` 提供隐藏 DFA 自适应查询模拟器。数据化标准答案和资源模拟器配置都参与任务哈希；1.0 的命名评分描述保持原任务快照及 `6e089b1c…684d` 任务哈希。

清单中的源码与证据路径均相对评测根目录 `benchmark/`。每份清单固定原有四份判分模块、共用严格 JSON 解析器、数据评分适配器、声明式资源模拟器和隐藏 DFA 模拟器。历史基线保留原始源码哈希映射，不改写原始证据。题目实现的修订标签不构成额外题库版本。

评分与校准见[题库说明](../../docs/ASSESSMENT_BANK.zh.md)，修改与验证要求见[维护指南](../../AGENTS.zh.md)。
