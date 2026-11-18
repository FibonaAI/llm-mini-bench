# 题库与评分

[English](ASSESSMENT_BANK.md)

Assessment 1.0 是唯一生产／默认的 14 题题库。正式清单位于 `benchmark/banks/assessment-1.0.json`，完整题面位于 `benchmark/banks/assessment-1.0.questions.json`。页面和执行服务默认使用 1.0；所有题库版本与独立校准器都使用同一个清单驱动加载器和判分实现。

Assessment 2.0 是 `experimental-unvalidated` 校准题库，其最终 14 题候选以自适应隐藏 DFA 识别为主（11 道 DFA 题和 3 道文本推理题）。文件为 `benchmark/banks/assessment-2.0.json` 与 `assessment-2.0.questions.json`。仅凭接受/拒绝反馈无法确定任意隐藏状态名，因此恢复命名状态表不是有效的识别目标。保留观察记录用于审查题目设计，不将这些分数用作能力测量或达到目标分数的证据。

Assessment 2.1 是独立的实验候选，共 14 题：9 道静态推理、代码、上下文和指令题，3 道有限候选黑盒识别题，以及 2 道文档调查题。黑盒题覆盖因果实验、异常语义和调度策略，已用决策树证明每个候选都能在公开探针预算内识别；文档题覆盖关税修订与 SLA 仲裁。静态题包括别名内存与已处理异常下的编译器保护条件合成、撤回证据后恢复旧约束的时序证据推理，以及 15 个原子事件并发栈的有限位宽 ABA 分析。时序题通过排列过滤与拓扑状态搜索独立核验；并发题询问七项结构性质与标签位宽，两套独立解释器对全部交错执行核验答案。隐藏状态名 DFA 识别已移出候选，因为仅凭接受/拒绝反馈无法确定状态名。此前以 DFA 为主的分数不能证明通用能力或达到目标分数。文件为 `benchmark/banks/assessment-2.1.json` 与 `assessment-2.1.questions.json`。所有实验题库都不是基线、排行榜或 1.0 的替代品。

所有版本都通过 `src/assessment_bank.ts` 加载清单中的 `task_file` 和精确的 `grading` 描述，没有按版本分支的加载器。新数据化任务共用精确字段评分，支持标记分数和封闭别名；声明式 `assessment-resource-v1` 任务提供固定内存资源网络，包含库存、保底、容量、污染、版本和冲突反馈；`assessment-dfa-v1` 提供隐藏确定性自动机，支持有限自适应接受查询和精确转移表提交；命名内置 oracle 保持 1.0 原评分与工具模拟器。模型回答始终是数据，不会被执行。

## 生产 1.0 题目

| ID | 领域 | 考察内容 |
| --- | --- | --- |
| `K04_Genetic_Code` | 知识 | 指定非标准遗传密码表 |
| `K05_DNS_Negative_Cache` | 知识 | RFC 2308 缓存键与 TTL |
| `K06_Treaty_Exceptions` | 知识 | 条约效力、履行与边界例外 |
| `R01_Stopping_Urn` | 推理 | 停止规则下的潜变量后验与期望 |
| `R02_Causal_Counterfactual` | 推理 | 观察、干预和反事实 |
| `R03_Parallel_Schedule` | 推理 | 资源约束下的最优调度与解计数 |
| `C01_Finally_Aliasing` | 代码语义 | `finally`、对象别名、变更与重绑定 |
| `C03_Optimistic_Transactions` | 代码语义 | 保存的读状态、版本验证和写偏差 |
| `X02_Payment_Evidence` | 材料整合 | 支付去重、冲销和生效时间 |
| `X03_Bitemporal_Revisions` | 材料整合 | 双时间轴、整行修订和证据定位 |
| `I01_Coupled_Transform` | 指令遵从 | 筛选、排序、关联与校验和 |
| `I02_Quoted_Instructions` | 指令遵从 | 可信指令与引用数据的边界 |
| `T02_Inventory_Impossible` | 工具操作 | 识别库存不可行性，避免非法动作 |
| `T03_Booking_Feedback` | 工具操作 | 根据真实模拟冲突反馈恢复预订 |

题目 ID 保持稳定，不为视觉连续编号而更名。题面中的修订标签记录具体实现来源，不是额外可选的题库版本。

## 实验 2.2 题目

Assessment 2.2 固定为十题：八道文本题和两道固定工具题。使用 `--bank-version 2.2` 显式选择。清单为 `benchmark/banks/assessment-2.2.json`，完整题面、工具、文档和评分数据位于 `benchmark/banks/assessment-2.2.questions.json`。它使用既有加载器和判分器，不修改 1.0、2.0 或 2.1 的题目字节。

| ID | 考察内容 |
| --- | --- |
| `F_Marginal_Compatibility` | 二元边缘分布的整体兼容性与可达到的精确边界 |
| `F_Private_Recommendations` | 私有、盲选和公开信息下的服从约束与次级最优值 |
| `F_Distributed_Guessing` | 局部观察、极值覆盖与不同的规则对称性 |
| `R22_Private_Information_Announcements` | 否定公告、高阶知识与公开信息位的反事实 |
| `CFinal_Aliased_Rotation_Fusion` | 别名程序等价性、最小保护条件与信息损失 |
| `CFinal_Erased_Token_Batching` | 歧义分词、最短语义损失与无界输入族 |
| `CFinal_Snapshot_Serial_Witness` | 快照与串行执行等价性、读取观察与最小见证组合 |
| `E_Final_Scoped_Release_Evidence` | 六份文档中的权限、时间、范围与条件证据转移 |
| `I_Final_Reconcile_Uncertain_Identity` | 合法修正、不确定身份匹配与边界，不执行嵌入请求 |
| `T_Final_Reserve_Change_Dispatch` | 保底变化、冲突反馈与不可逆污染下的实际调拨 |

独立可执行检查位于 `benchmark/tests/assessment_2_2_*oracle*.test.ts`，数学和有限状态证明位于 `benchmark/tests/fixtures/assessment-2.2-*.md`。分词题的无界输入族有适用于所有 n 的论证，不只检查有限样例。调拨验证覆盖四种保底变化组合和多种合法控制策略，不限定唯一操作轨迹。测试只使用 Bun 和固定的作者验证代码，不执行模型生成的程序。

文本和文档题按精确语义字段等权评分。调拨题沿用资源判分器，其内容分包含物理目标、如实报告、检查状态、处理冲突反馈和操作合法性，同时保留独立的指令与工具检查；不能把它描述为只按最终回答评分。

完整实验校准均分包含每个预定轮次的全部十题，各题等权。任何缺失、失败或不可评分样本都会使整套总分保持 null；部分已观察均分必须标明，不能替代总分。部分模型完成较慢时按模型报告，不自动据此删题。开发模型上的观察不是留出验证、目标难度证明或排行榜。下文的生产分析图仍要求精确匹配 1.0 题目 ID，不把 2.2 绘成生产对照。

## 实验 2.3 题目

Assessment 2.3 固定为十二题，均衡覆盖全部六个领域（`knowledge`、`reasoning`、`code`、`context`、`instruction` 和 `tool_use`，每个领域两题：九道文本题和三道固定工具题）。使用 `--bank-version 2.3` 显式选择。清单为 `benchmark/banks/assessment-2.3.json`，完整题面、文档、账本和评分数据位于 `benchmark/banks/assessment-2.3.questions.json`，独立 Bun 验证位于 `benchmark/tests/assessment_2_3.test.ts` 和 `benchmark/tests/assessment_2_3_oracles.test.ts`。它复用既有加载器、精确字段判分器以及文档／黑盒／授权释放模拟器，不修改 `1.0`、`2.0`、`2.1` 或 `2.2`。

## 评分规则

- `content_score` 为 0 到 1 的逐题语义得分，部分题按多个语义检查点给部分分。
- `instruction_checks` 单独记录输出格式与指令要求。内容正确不自动表示所有指令均已满足。
- 工具题在独立内存状态中运行，保留调用轨迹、最终状态、工具检查和结果。非法操作不修改模拟器状态，但会影响对应检查。
- 明确错误和主动弃答可以是零分；请求失败、无法解析、不可评分或未完成不是零分。
- 每个预定轮次都保留，不挑最好一次。下文的展示均分对各题等权，不把小问或重复轮次视为独立能力维度。

### 用工具提交答案（`submit-answer-tool-v1`）

题目可声明 `answer_protocol: "submit-answer-tool-v1"` 和 `answer_schema`（JSON Schema 对象，只写答案字段名和值类型，不含答案）。执行器会在题目自带工具之外加一个 `submit_answer` 工具，参数格式就是这个 schema，并附固定说明。可见文本不再用来提取答案：

- Agent 一直运行到某轮不再调用工具为止，以**最后一次有效**的 `submit_answer` 参数为最终答案，交给原有评分器评分。参数无效时把拒绝原因返回给模型，模型可以重新提交。
- 结束时一次都没提交，按有效的 0 分计（`outcome: "no_submission"`），即使正文里写了正确答案也一样。不会调用工具的模型因此得 0 分，不单独检测线路能力。
- 有效提交之后再超时或遇到上游错误，仍按这次提交评分（记在 `answer_submission.ended_after_submission`）。没有提交时仍属执行失败，不计 0 分。
- 这个协议下不会再出现 `ambiguous` 或 `ungradable`。

这些题目字段会进入题目快照和协议哈希，所以启用它们属于题库快照的一部分。Assessment 2.3 的全部十二道题均启用 `submit-answer-tool-v1`；生产 1.0 和早期实验题库（`2.0`–`2.2`）未启用。真实冒烟测试否决了“任意对象”参数格式：多个模型把整份答案包成一个自造的字符串参数。

工具循环超过轮次、请求或 Token 预算时，单独记录执行失败。所有题目只有固定判分器，无模型评审，不执行模型生成的程序。

## 生产 1.0 得分费用图

目标计划运行 `R` 轮时，分析图纵轴为 `100 × sum(content_score) / (14 × R)`，横轴为 `estimated_cost_usd / R`。这是对已保存内容得分的等权展示汇总，不是新判分器，也不改变 Mini Bench 题库协议或哈希。指令和工具检查仍单独保留。

绘点要求状态为 `completed`、题目 ID 恰好匹配正式 14 题，且 `R` 是 1 至 3 的整数。每题在第 1 至第 `R` 轮都必须恰有一个已完成样本，内容得分有限且在 `[0, 1]` 内。缺失、重复、失败或不可评分的样本均使该记录不能绘点，不补成零分。费用必须已知、有限且非负，并包含工具后续请求。未知费用保持 `null`；未发出请求的尝试是已知零费用。零费用在线性轴有效，在对数轴隐藏。得分完整但部分尝试未返回用量时，分析页可按已知下限绘点并加明显角标，不参与前沿，也不代表完整总量。

不能绘点的记录仍保留逐题和原始详情。满足绘点条件不等于协议可比，也不等于可保存为新基线。图表不推断模型或账号异常。

## 可比性

对照结果时检查题库版本、任务快照、题目源码哈希、Thinking 和执行协议。输出 Token 上限、工具调用上限、轮次上限和超时也属于样本协议。不能把未知历史参数补成当前默认值。

TypeScript 实现保留 1.0 题面、顺序和题目哈希。当前清单记录八份共用 TypeScript 源码哈希：原有四份判分模块、共用严格 JSON 解析器、共用数据评分适配器、声明式资源模拟器和隐藏 DFA 模拟器。使用可选黑盒、文档、仓库、单箱推动规划、委托授权释放或安全物理控制格式的题库还通过 `extension_sha256` 固定适配器与模拟器；校准和服务运行同时保留这些扩展源码哈希。数据化标准答案参与任务哈希；1.0 命名评分描述不改变其原任务快照。历史快照保留原始四份 Python 判分源码的哈希映射。离线重放可验证已保存证据的评分和模拟器行为等价，但不表示源码哈希相同，也不能证明所有历史运行均可比。

这是一套小规模探索性能力题库，覆盖范围有限。单轮完整运行不代表重复可靠性，当前参考基线也不证明模型排名。

## 独立校准

以下命令使用 Bun，从仓库根目录运行。

以下命令会发模型请求并可能收费，先确认模型目录中存在目标及 Thinking 档位，设置 `MAGPIE_BENCH_BASE_URL` 与 `MAGPIE_BENCH_API_KEY`：

```sh
bun benchmark/calibrate_assessment.ts \
  --target 'YOUR_EXACT_MODEL_ID=high' \
  --output /tmp/assessment-1.0-run.jsonl \
  --rounds 1 --timeout 600
```

默认加载完整生产 1.0 题库。只有显式添加 `--bank-version 2.0`、`--bank-version 2.1`、`--bank-version 2.2` 或 `--bank-version 2.3` 才选择实验题库，实验运行不能提升为基线。`--task-ids` 只能从所选题库中选取诊断子集，子集结果不能提升为完整基线。输出使用新文件，不覆盖已有结果。

独立校准器只有显式传入相应选项时才设置响应 token、请求次数或 USD 上限。默认每样本超时为 600 秒（可设 10-600 秒）。样本按任务池执行，一个样本结束立刻补上下一个。`--max-api-retries 0..3` 在整题超时内重试临时 API 错误（默认不重试）。传输超时或缺少用量只使当前样本失败，不中止其余校准。要在任务页和分析页查看校准结果，用 `benchmark/tools/import_calibration.ts` 以只读方式导入。无 token 上限时使用 32,768 token 做预算预留估算，但不截断响应；实际用量与估算费用仍会写入证据。

离线汇总不发请求。逐题 `content_mean` 只包含可评分答案；`failure_as_zero_mean` 则把失败或不可评分样本计为零，用于执行层诊断，但不改写已保存评分或绘点资格。

```sh
bun benchmark/tools/analyze_assessment.ts /tmp/assessment-1.0-run.jsonl \
  --output /tmp/assessment-1.0-summary.json
```

日常多模型、多账号运行推荐使用[执行服务](BENCH_EXECUTION.zh.md)，它统一管理并发并保存完整 `run.json`，可直接校验并保存基线。
