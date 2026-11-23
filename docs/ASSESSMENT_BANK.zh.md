# 题库与评分

[English](ASSESSMENT_BANK.md)

Assessment 1.0 是正式生产 12 题题库。正式清单位于 `benchmark/banks/assessment-1.0.json`，完整题面位于 `benchmark/banks/assessment-1.0.questions.json`。页面、执行服务与独立校准器均使用同一个清单驱动加载器（`src/assessment_bank.ts`）和判分实现。

数据定义的文本题使用共用精确字段判分（`assessment-exact-fields-v1`），支持精确分数标签与封闭别名集合。交互式工具题通过 `src/assessment_interactive.ts` 绑定固定内存模拟器（`assessment-documents-v1`、`assessment-blackbox-v1` 与 `assessment-delegated-release-v1`）。模型回答始终作为纯数据处理，绝不执行。

## 生产 1.0 题目

| ID | 领域 | 考察内容 |
| --- | --- | --- |
| `K23_HTTP_Conditional_Cache_Precedence` | 知识 | RFC 9110/9111 条件请求优先级、验证器强弱与 `304` 新鲜度更新 |
| `K23_IEEE754_ThreeValued_Semantics` | 知识 | IEEE 754-2019 binary64 舍入/FMA/NaN 规则与 ISO SQL 三值逻辑 |
| `R23_InContext_Glyph_Morphism` | 推理 | 上下文代数同态规则归纳、动态链式约简与逆向合成 |
| `R23_InContext_Conservation_Frames` | 推理 | 上下文守恒律发现与多步晶格状态／阻挫追踪 |
| `C23_Async_Generator_Finally_Override` | 代码语义 | `async function*`、`yield*` 委托、`finally` 中的 `return()`/`throw()` 与微任务顺序 |
| `C23_MVCC_Savepoint_SSI` | 代码语义 | MVCC 快照可见性、`ROLLBACK TO SAVEPOINT` 锁保留与 SSI 安全快照 |
| `X23_Subagent_MultiTrack_Reconciliation` | 材料整合 | 多轨子代理审计对账、工作树来源核验与法定人数规则 |
| `E23_Tight_Conditional_Audit` | 材料整合 | 紧预算文档调查、字段级权限隔离与条件豁免判定 |
| `I23_MultiAgent_DAG_Orchestration` | 指令遵从 | 多代理 DAG 调度、两阶段核验签批与资源争用 |
| `I23_Polysemy_Contextual_Translation` | 指令遵从 | 法律与历史语境多义词消歧及反向诱饵翻译核查 |
| `T23_Adaptive_Fault_Diagnosis` | 工具操作 | 九候选故障模式下的两步自适应极小极大探针诊断 |
| `T23_Delegated_Authority_Release` | 工具操作 | 委托授权链核验、祖先作用域交集收窄与零非法操作 |

题目 ID 保持稳定，不为视觉连续编号而更名。题面中的修订标签记录具体实现来源，不是额外可选的题库版本。

## 判分原则

- **内容得分**：每题按通过的语义检查项比例报告 `[0, 1]` 范围内的 `content_score`，不预设领域权重。
- **格式与指令分离**：`instruction_checks` 与 `content_checks` 分别报告。
- **弃权与不可评分输出**：整题弃权（`"UNKNOWN"`、`"UNSURE"`、`"ABSTAIN"`、`"不知道"`）记为 `content_score: 0`、`outcome: "abstained"`。格式损坏或缺失的文本输出保持 `content_score: null`。
- **工具提交答案（`submit-answer-tool-v1`）**：Assessment 1.0 的全部 12 道题均声明 `answer_protocol: "submit-answer-tool-v1"` 与精确的 `answer_schema`。执行器注入严格的 `submit_answer` 工具，并直接对最后一次合法 `submit_answer` 调用的原始 JSON 参数字符串判分，忽略散文说明或更早的草稿。如果已完成回合从未调用 `submit_answer` 提交 JSON 对象，则记为 `content_score: 0`、`outcome: "no_submission"`，且 `instruction_checks.submitted_via_tool: false`。如果回合已记录有效 `submit_answer` 后又发生上游错误、超时或上限中止，执行器仍按最后一次有效提交判分，记为 `status: "completed"` 并记录 `ended_after_submission`。

工具循环超过轮次、请求或 Token 预算时，单独记录执行失败。所有题目只有固定判分器，无模型评审，不执行模型生成的程序。

## 得分费用图

目标计划运行 `R` 轮时，分析图纵轴为 `100 × sum(content_score) / (12 × R)`，横轴可在三项中切换：`estimated_cost_usd / R`（每轮估算费用）、输入加输出 token 总量除以 `R`（每轮总 tokens）或 `elapsed_seconds / R`（每轮耗时）。这是对已保存内容得分的等权展示汇总，不是新判分器，也不改变 Mini Bench 题库协议或哈希。指令和工具检查仍单独保留。

绘点要求状态为 `completed`、题目 ID 恰好匹配正式 12 题，且 `R` 是 1 至 3 的整数。每题在第 1 至第 `R` 轮都必须恰有一个已结束样本，内容得分有限且在 `[0, 1]` 内。缺失、重复、API 失败或不可评分的样本均使该记录不能绘点，不补成零分。整题超时（`SampleTimeout` / `status: "timeout"`）按 `0` 分计，运行仍可完成且保留手动重试资格。所选横轴指标必须已知、有限且非负，并包含工具后续请求。未知费用保持 `null`；未发出请求的尝试是已知零费用。零费用记录在费用轴的对数和线性刻度下均可入图并绘制在左边界坐标轴上，但不计入帕累托前沿；其余横轴的零用量在线性轴有效、在对数轴隐藏。得分完整但部分尝试未返回用量时，分析页可按已知下限绘点（不代表完整总量）。凡含执行异常项（样本超时、提交答案后异常中止 `ended_after_submission`、未调用 `submit_answer` 提交 `no_submission` 或用量不完整）的绘点记录均带橙色角标，且不参与帕累托前沿。

不能绘点的记录仍保留逐题和原始详情。满足绘点条件不等于协议可比，也不等于可保存为新基线（例如含超时样本或用量不完整的运行不能保存为基线）。图表只标注直接记录的执行异常，不推断模型或账号异常。

## 可比性

对照结果时检查题库版本、任务快照、题目源码哈希、Thinking 和执行协议。输出 Token 上限、工具调用上限、轮次上限和超时也属于样本协议。不能把未知历史参数补成当前默认值。

当前清单记录三份核心 TypeScript 源码哈希（`src/assessment_tasks.ts`、`src/assessment_json.ts` 与 `src/assessment_data.ts`），并通过 `extension_sha256` 固定交互模拟器模块（`src/assessment_interactive.ts`、`src/assessment_blackbox.ts`、`src/assessment_documents.ts` 与 `src/assessment_delegated_release.ts`）；校准和服务运行同时保留完整执行源码闭包。数据化标准答案和模拟器配置均参与任务哈希（`d58ddb12…fed8`）。

这是一套小规模探索性能力题库，覆盖范围有限。单轮完整运行不代表重复可靠性，也不构成通用模型排行榜。

## 独立校准

以下命令使用 Bun，从仓库根目录运行。

以下命令会发模型请求并可能收费，先确认模型目录中存在目标及 Thinking 档位，设置 `MAGPIE_BENCH_BASE_URL` 与 `MAGPIE_BENCH_API_KEY`：

```sh
bun benchmark/calibrate_assessment.ts \
  --target 'YOUR_EXACT_MODEL_ID=high' \
  --output /tmp/assessment-1.0-run.jsonl \
  --rounds 1 --timeout 600
```

默认加载完整生产 1.0 题库。`--task-ids` 可从题库中选取诊断子集，子集结果不能提升为完整基线。输出使用新文件，不覆盖已有结果。

独立校准器只有显式传入相应选项时才设置响应 token、请求次数或 USD 上限。默认每样本超时为 600 秒（可设 10-600 秒）。样本按任务池执行，一个样本结束立刻补上下一个。`--max-api-retries 0..3` 在整题超时内重试临时 API 错误（默认不重试）。传输超时或缺少用量只使当前样本失败，不中止其余校准。要在任务页和分析页查看校准结果，用 `benchmark/tools/import_calibration.ts` 以只读方式导入。

离线汇总不发请求。逐题 `content_mean` 只包含可评分答案；`failure_as_zero_mean` 则把失败或不可评分样本计为零，用于执行层诊断，但不改写已保存评分或绘点资格：

```sh
bun benchmark/tools/analyze_assessment.ts /tmp/assessment-1.0-run.jsonl \
  --output /tmp/assessment-1.0-summary.json
```

日常多模型、多账号运行推荐使用[执行服务](BENCH_EXECUTION.zh.md)，它统一管理并发并保存完整 `run.json`，可直接校验并保存基线。
