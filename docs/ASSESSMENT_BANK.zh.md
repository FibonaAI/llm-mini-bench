# 题库与评分

[English](ASSESSMENT_BANK.md)

Assessment 2.0 与 Assessment 1.0 是工作区并存提供的两套正式 12 题题库（`benchmark/banks/assessment-2.0.json` / `assessment-2.0.questions.json` 与 `benchmark/banks/assessment-1.0.json` / `assessment-1.0.questions.json`）。页面、执行服务与独立校准器共用同一个清单驱动加载器（`src/assessment_bank.ts`），同时按 `bank_version` 将判分机制、基线、分析图表与任务记录严格隔离。

数据定义的文本题使用共用精确字段判分（`assessment-exact-fields-v1`），支持精确分数标签与封闭别名集合。交互式工具题分别通过 `src/assessment_interactive.ts`（1.0 的 `v1` 模拟器）与 `src/assessment_interactive_v2.ts`（2.0 的 `assessment-documents-v2`、`assessment-blackbox-v2` 与 `assessment-delegated-release-v2`，要求预算内真实模拟器轨迹证据方可获得高阶内容分）绑定固定内存模拟器。模型回答始终作为纯数据处理，绝不执行。

## 正式 2.0 题目（`task_sha256: 84feeda2…24a3`）

| ID | 领域 | 考查内容 |
| --- | --- | --- |
| `K25_IPv4_BitReverse_Abduction` | 知识 | 无提示、无样例的底层硬件/协议溯因：将伪装为 IPv4 点分十进制标签的字节按 8-bit 串口位序（LSB↔MSB）反转并还原大写 ASCII 英文国家名 |
| `K25_FIDE_Perft_EdgeCases` | 知识 | 标准国际象棋（FIDE）双 FEN 局面单层合法步与将军步精确计数，综合考查水平吃过路兵牵制、对角牵制、升变将军与王车易位受攻格边界 |
| `R25_Shifted_Pinyin_Abduction` | 推理 | 无提示、无样例的双层真实输入溯因：美式 QWERTY 右手整体右移一格叠加中文拼音音节重切分 |
| `R25_Morse_Sentence_Camouflage` | 推理 | 无提示、无样例的伪装符号溯因：五词真英文表面伪装下的国际摩尔斯电码点划极性反相还原 |
| `C25_FourSlot_Readback` | 代码语义 | 四槽位环形存储与检查点/指针回滚交错并发，求解触发上升（`a<b`）与下降（`a>b`）撕裂读回的最少原子总步数及中间守卫约束 |
| `C25_Clock_Belady_Anomaly` | 代码语义 | 二次机会（Clock）页面置换算法容量反常，定位 `cap=3` 缺页数大于 `cap=2` 的最短字典序首请求序列及缺页对 |
| `X25_Checkout_Credit_Audit` | 材料整合 | 跨时区（`UTC` 与 `UTC+8`）分站点交错回滚修订、边缘与源站故障归因、按桶末时刻标注的分钟区间及同秒重试去重分母对账 |
| `E25_Tight_Budget_Deductive_Audit` | 材料整合 | 自 `INDEX` 起步的 5 次零冗余预算档案核查，规避未经核验的 `BRIEF` 并通过净重算术提前排除 `LOG_A` 以在预算内调取有效费率表 `TAR_C` |
| `I25_SOP_MinStep_Protocol` | 指令遵从 | 五阀安全联锁启动规程最短步规划与字典序决胜，耦合三条全承重状态前置条件、禁态不变式及同阀/相邻阀连续切换冷却约束 |
| `I25_Bilingual_Custody_Discrepancy` | 指令遵从 | 六条独立中英交接记录的本班木箱实物接管（`H`/`N`/`U`）真值投影，区分出门条逆否、仅移交会签单实物、另页登记与提箱许可 |
| `T25_Deceptive_Relay_Matrix` | 工具操作 | 4 次零冗余探针预算下的 16 候选 × 12 触点反贪心继电器隔离：11 个 `8:8` 平衡触点中 10 个为陷阱，仅唯一全局保底首探针（`I`）及各分支唯一可行次探针可在 4 步内完备定位 |
| `T25_Delegated_Manifest_Dispatch` | 工具操作 | 签名委托账本下的零拒绝最大清舱放行（8 项中唯一满额放行 6 项），耦合共享祖先额度、祖父级撤销、操作类型匹配与未签名派车单抗干扰 |

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
- **工具提交答案（`submit-answer-tool-v1`）**：Assessment 2.0 与 Assessment 1.0 的全部 12 道题均声明 `answer_protocol: "submit-answer-tool-v1"` 与精确的 `answer_schema`。执行器注入严格的 `submit_answer` 工具，并直接对最后一次合法 `submit_answer` 调用的原始 JSON 参数字符串判分，忽略散文说明或更早的草稿。如果已完成回合从未调用 `submit_answer` 提交 JSON 对象，则记为 `content_score: 0`、`outcome: "no_submission"`，且 `instruction_checks.submitted_via_tool: false`。如果回合已记录有效 `submit_answer` 后又发生上游错误、超时或上限中止，执行器仍按最后一次有效提交判分，记为 `status: "completed"` 并记录 `ended_after_submission`。

工具循环超过轮次、请求或 Token 预算时，单独记录执行失败。所有题目只有固定判分器，无模型评审，不执行模型生成的程序。

## 得分费用图

目标计划运行 `R` 轮时，分析图纵轴为 `100 × sum(content_score) / (12 × R)`，横轴可在三项中切换：`estimated_cost_usd / R`（每轮估算费用）、输入加输出 Token 总量除以 `R`（每轮总 Token）或 `elapsed_seconds / R`（每轮耗时）。这是对已保存内容得分的等权展示汇总，不是新判分器，也不改变 Mini Bench 题库协议或哈希。指令和工具检查仍单独保留。

绘点要求状态为 `completed`、题目 ID 恰好匹配正式 12 题，且 `R` 是 1 至 3 的整数。每题在第 1 至第 `R` 轮都必须恰有一个已结束样本，内容得分有限且在 `[0, 1]` 内。缺失、重复、API 失败或不可评分的样本均使该记录不能绘点，不补成零分。整题超时（`SampleTimeout` / `status: "timeout"`）按 `0` 分计，运行仍可完成且保留手动重试资格。所选横轴指标必须已知、有限且非负，并包含工具后续请求。未知费用保持 `null`；未发出请求的尝试是已知零费用。零费用记录在费用轴的对数和线性刻度下均可入图并绘制在左边界坐标轴上，但不计入帕累托前沿；其余横轴的零用量在线性轴有效、在对数轴隐藏。得分完整但部分尝试未返回用量时，分析页可按已知下限绘点（不代表完整总量）。凡含执行异常项（样本超时、提交答案后异常中止 `ended_after_submission`、未调用 `submit_answer` 提交 `no_submission` 或用量不完整）的绘点记录均带橙色角标，且不参与帕累托前沿。

不能绘点的记录仍保留逐题和原始详情。满足绘点条件不等于协议可比，也不等于可保存为新基线（例如含超时样本或用量不完整的运行不能保存为基线）。图表只标注直接记录的执行异常，不推断模型或账号异常。

## 可比性

对照结果时检查题库版本、任务快照、题目源码哈希、Thinking 和执行协议。输出 Token 上限、工具调用上限、轮次上限和超时也属于样本协议。不能把未知历史参数补成当前默认值。

每份清单记录三份核心 TypeScript 源码哈希（`src/assessment_tasks.ts`、`src/assessment_json.ts` 与 `src/assessment_data.ts`），并通过 `extension_sha256` 固定交互模拟器模块（1.0 固定 `v1` 模块，2.0 同时固定 `v1` 与 `v2` 模块）；校准和服务运行同时保留完整执行源码闭包。数据化标准答案和模拟器配置均参与各自题库的任务哈希（2.0 为 `84feeda2…24a3`，1.0 为 `d58ddb12…fed8`）。

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

默认加载完整生产 1.0 题库（传入 `--bank-version 2.0` 可校准 Assessment 2.0）。`--task-ids` 可从题库中选取诊断子集，子集结果不能提升为完整基线。输出使用新文件，不覆盖已有结果。

独立校准器只有显式传入相应选项时才设置响应 Token、请求次数或 USD 上限。默认每样本超时为 600 秒（可设 10-600 秒）。样本按任务池执行，一个样本结束立刻补上下一个。`--max-api-retries 0..3` 在整题超时内重试临时 API 错误（默认不重试）。传输超时或缺少用量只使当前样本失败，不中止其余校准。要在任务页和分析页查看校准结果，用 `benchmark/tools/import_calibration.ts` 以只读方式导入。

离线汇总不发请求。逐题 `content_mean` 只包含可评分答案；`failure_as_zero_mean` 则把失败或不可评分样本计为零，用于执行层诊断，但不改写已保存评分或绘点资格：

```sh
bun benchmark/tools/analyze_assessment.ts /tmp/assessment-1.0-run.jsonl \
  --output /tmp/assessment-1.0-summary.json
```

日常多模型、多账号运行推荐使用[执行服务](BENCH_EXECUTION.zh.md)，它统一管理并发并保存完整 `run.json`，可直接校验并保存基线。
