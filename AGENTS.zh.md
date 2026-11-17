# LLM Mini Bench 维护指南

[English](AGENTS.md)

本文件面向代码维护者和编程 Agent。使用说明放在 `README.md`；不要把内部架构、调试过程或维护命令堆进用户首页。

## 项目边界

- Bun 上的 TypeScript 后端、原生 HTML/CSS/JavaScript 前端和 TypeScript Magpie 插件入口。无运行时 npm 依赖、前端构建步骤或已配置的格式化工具。TypeScript 与 `@types/bun` 仅为开发依赖。
- Assessment 1.0 共 14 题，是唯一生产／默认发布版本。Assessment 2.0、Assessment 2.1、Assessment 2.2 和 Assessment 2.3 只能显式选择，用于 `experimental-unvalidated` 校准；不得变成另一套默认题库，也不能在未经独立验证时提升为基线。旧八题、五题协议、旧指纹工具与兼容 API 保持删除。
- 评分按题保留内容得分、指令检查、工具检查与执行状态。分析页允许使用已批准的展示指标：全部预定轮次中 14 题的等权均分乘以 100，对照总估算美元费用或输入与输出 token 总和除以轮数。仅为已完成、题目 ID 恰好匹配正式 14 题、1 至 3 轮样本完整且不重复、内容分有限且在 0 到 1 之间、所选费用或 token 轴用量已知且非负的记录绘点。零用量可在线性轴显示，对数轴隐藏。未发出请求的尝试（`calls` 为空）是已知零用量，不算未知。得分完整但部分尝试未返回用量时，分析页可按已知下限绘点（图表设置项，默认开启）并加区分角标；这类点不参与帕累托前沿，不得表述为完整总量，也不能用于基线。不同 Thinking 协议不禁用对照及当前可见点的帕累托前沿。颜色默认区分模型、渠道及账号组合，可选跨渠道的模型或模型系列着色，仅用于显示。颜色图例保持一行简览，按需展开单列列表；图例搜索和高亮不得筛选记录或改变指标。普通运行用圆点、基线用方块；只在已记录的同批次、渠道、账号及模型内连接 Thinking。不新增任意权重，不把失败或缺失记成零分，不做 best-of 筛选。该展示指标不改变判分、题库协议或哈希。
- 题面和模型回答是数据。不能执行模型生成的代码，工具只运行项目内固定的内存模拟器。

## 目录与运行边界

仓库根目录保留安装声明和文档。`benchmark/` 是评测根目录，TypeScript 模块、题库、证据、工具、测试和独立网页服务都在其中。发布清单和源码哈希映射中保存的路径，如 `src/assessment_tasks.ts`，相对 `benchmark/` 解析，不相对仓库根目录。搬迁目录不改变题目源码字节，也不能作为修改题库哈希的理由。

`magpie/` 负责 Magpie 特有的目录发现、账号绑定、额度和请求适配。`index.ts` 导出 `default { id, server }`，直接导入 TypeScript 服务，在同一个由 Magpie 管理的 Bun plugin-host 进程中启动 `Bun.serve`。不要另起 Python、Node.js 或 Bun 后端进程。`page/` 引导页将宿主主题和本地服务 token 传给评测页面。评分、调度、题库数据和基线逻辑不放在适配器里。根目录的 `package.json` 仍是 Magpie 安装声明，入口指向适配器，不单独安装适配器目录。

TypeScript 在 Bun 上实现评测引擎和 HTTP 服务，原生浏览器 JavaScript 实现 `benchmark/web/` 和适配器引导页。Magpie 首次安装插件时下载 Bun，直接运行 TypeScript 源码。moejs 用于 agent 和 middleware 脚本，不用于此插件主模块。评测服务和网页可以独立于插件运行，不使用 Magpie 模型网关时配置显式上游路由。详见[适配器说明](magpie/README.zh.md)。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| `benchmark/banks/assessment-1.0.json` | 生产发布清单，固定题目顺序、题目哈希、评分描述和共用源码哈希 |
| `benchmark/banks/assessment-2.0.json` | `experimental-unvalidated` 清单，仅用于显式校准，绝不作为生产默认 |
| `benchmark/banks/assessment-2.1.json` | 均衡的 `experimental-unvalidated` 清单，仅用于显式校准，绝不作为生产默认 |
| `benchmark/banks/assessment-2.2.json` | 紧凑多领域的 `experimental-unvalidated` 清单，仅用于显式校准，绝不作为生产默认 |
| `benchmark/banks/assessment-2.3.json` | 均衡覆盖六领域的 12 题 `experimental-unvalidated` 清单，仅用于显式校准，绝不作为生产默认 |
| `benchmark/banks/assessment-*.questions.json` | 各版本共用同一加载路径的完整可序列化题面 |
| `benchmark/src/assessment_bank.ts` | 校验任意路径安全的题库清单并加载可运行题目，不按版本写分支；正式入口必须通过此加载器 |
| `benchmark/src/assessment_data.ts` | 共用数据化精确字段评分与命名内置 oracle 适配；数据评分内容参与任务哈希 |
| `benchmark/src/assessment_resource.ts` | 声明式资源网络与固定模拟器，用于库存、保底、污染和版本交互任务 |
| `benchmark/src/assessment_dfa.ts` | 通过有限自适应查询识别隐藏 DFA，并校验完整转移表提交 |
| `benchmark/src/assessment_depot.ts` | 声明式仓库堆叠、容量、有序装运和真实终态评分；搬运额度属于题目数据 |
| `benchmark/src/assessment_push_planning.ts` | 完全可观察的单箱推动规划与真实终态评分；不设步数额度 |
| `benchmark/src/assessment_delegated_release.ts` | 不可变授权链、共享祖先额度与实际释放完成度评分 |
| `benchmark/src/assessment_safe_control.ts` | 部分可观测物理控制、不可逆损伤与实际归零交付评分 |
| `benchmark/src/assessment_tasks.ts` | 共用解析、评分与基础任务实现 |
| `benchmark/src/assessment_json.ts` | 严格 JSON 解析与规范化序列化，纳入当前题库源码哈希 |
| `benchmark/src/assessment_knowledge.ts`、`benchmark/src/assessment_challenges.ts` | 知识和挑战任务 |
| `benchmark/src/assessment_tools.ts` | 内存工具状态机与评分 |
| `benchmark/src/assessment_baselines.ts`、`benchmark/src/assessment_observations.ts` | 严格基线校验与独立的逐题分析纯投影，共用一次查询范围内的来源验证上下文 |
| `benchmark/src/assessment_provenance.ts` | 统一执行源码依赖闭包与字节／哈希捕获，生产 1.0 也包含加载器的无条件依赖 |
| `benchmark/src/run_protocol.ts` | 请求配置标准化与共用样本协议身份构建，保留省略、null 和 stream 语义 |
| `benchmark/src/assessment_response.ts` | 可见回答提取与明确单价解析 |
| `benchmark/src/production_bank.ts` | 正式题库版本的唯一来源；界面、默认任务和入图都从这里读取 |
| `benchmark/src/assessment_answer_protocol.ts` | 可选的 `submit-answer-tool-v1`：逐题 `answer_schema`，以最后一次有效提交评分，未提交计 0 分；新题库应采用 |
| `benchmark/src/client.ts` | Responses HTTP 客户端，不做 Chat Completions 回退 |
| `benchmark/src/bench_routes.ts`、`benchmark/src/bench_adapter.ts` | 显式路由与通用适配器接口 |
| `magpie/magpie_adapter.ts`、`magpie/magpie_routes.ts`、`magpie/magpie_accounts.ts`、`magpie/magpie_quotas.ts` | Magpie 目录、账号绑定、请求头及额度标准化 |
| `benchmark/src/bench_execution.ts` | 计划、原子准入／发布、并发、重试与取消的协调 |
| `benchmark/src/bench_execution_storage.ts`、`benchmark/src/bench_execution_queries.ts` | 私有持久化 JSON／日志及轻量运行／任务摘要投影 |
| `benchmark/src/assessment_runner.ts` | 独立于 CLI 入口的单样本执行、预算与同步日志契约 |
| `benchmark/calibrate_assessment.ts` | 复用共用执行器的独立校准 CLI，默认仍为已发布 14 题 |
| `benchmark/bench.ts` | CLI 客户端与独立 `serve` 入口，客户端命令使用已运行服务的调度器 |
| `benchmark/backend/mini_bench.ts`、`benchmark/src/bench_http_body.ts` | HTTP／认证／服务组合及独立的限长响应体读取；模型目录缓存属于适配器 |
| `benchmark/web/app-context.js` | 共用前端状态、服务依赖与事件约定；兼容 getter 引用同一份状态 |
| `benchmark/web/bench.js`、`task-submission.js`、`task-history-view.js`、`runs.js` | 分别负责任务协调与轮询、提交与重试、内联历史与详情、精确目标选择 |
| `benchmark/web/analysis.js`、`analysis-model.js` | 分析协调与按轴缓存的指标派生；呈现和历史归属变化不重新扫描逐题样本 |
| `benchmark/web/` | 分析图与共用的跨渠道统一搜索选择器，支持渠道／模型／思考筛选，统一使用 `/api/bench/`；保留逐题详情，不设独立题库页 |
| `package.json`、`magpie/index.ts`、`magpie/page/` | Magpie 插件声明、后端生命周期和页面引导 |
| `benchmark/tools/` | 离线分析、基线导入和只读校准导入（`import_calibration.ts`，不可重试、不可升级为基线），不在导入模块时发请求 |
| `benchmark/tests/` | 离线 Bun 测试与前端验证 |

## 本地验证

命令以仓库根目录为工作目录，使用 Bun 1.4.0 或更高版本，用 `bun install` 安装开发依赖：

```sh
# 后端、题库、模拟器、协议、基线、HTTP、CLI 和适配器测试；网关均为 mock
bun run test

# TypeScript 类型检查，不生成构建产物
bun run typecheck

# 可选安装渠道验收，需要 Git，使用 loopback registry 和临时仓库
bun run test:install

# 可选浏览器验收，需要 playwright-cli 与 Chromium，所有 API 均为 mock
bun run test:browser
bun run test:browser:sandbox

# 查看独立校准和离线工具帮助，不发模型请求
bun benchmark/calibrate_assessment.ts --help
bun benchmark/tools/analyze_assessment.ts --help
bun benchmark/tools/import_assessment_baseline.ts --help
```

静态 JS/SVG 响应必须保留限定于 `Origin: null` 的 CORS 头：Magpie 在不透明来源的 `sandbox="allow-scripts"` iframe 中嵌入页面。沙箱浏览器测试必须经过真实 HTTP 响应，不能 mock 响应头。UI 发布还必须在实际 Magpie 窗口验收；切换标签可能继续复用旧 iframe，因此重启服务后还要重新加载宿主页面。UI 验收不得启动付费评测。

用 Bun 验证运行行为，交付前运行 TypeScript 类型检查。前端验证使用临时目录和 mock API，不连真实模型；浏览器验收至少覆盖绘点条件与坐标轴模式、实例隔离的选择、计划、启动、取消、任务历史搜索、逐题详情、完整基线和空状态。

独立后端入口为 `bun benchmark/bench.ts serve --port 3481`，必须设置至少 32 字符的 `MAGPIE_BENCH_TOKEN`。持久服务用受管理的 tmux 任务运行并明确通知方式。不要与已运行的插件争用端口或数据目录；测试使用临时数据目录和随机端口。

## 题库变更

1. 每份清单选择正式任务及可序列化 `task_file`，评分描述恰好覆盖这些任务 ID。不从源码整批导出候选集合，不添加按版本分支的加载器。题目实现中的修订标签不是可选题库版本。
2. 原有四份判分模块、共用严格 JSON 解析器、共用数据评分适配器、声明式资源模拟器和隐藏 DFA 模拟器的字节哈希属于题库校验。即使只改注释，也会改变源码哈希。数据化标准答案参与任务哈希；1.0 命名评分保持原任务快照和任务哈希。不要为了让测试通过而跳过校验或直接覆盖期望值。
3. 变更题干、工具、判分或测量协议时，先说明对已有结果可比性的影响，再更新对应版本、清单、题面导出、独立答案测试及基线。
4. `benchmark/tests/assessment_bank.test.ts` 检查统一加载、正式 14 题导出与正确答案，`benchmark/tests/assessment_2.test.ts` 独立枚举或重放每道实验性 2.0 题的答案，`benchmark/tests/assessment_2_1.test.ts` 检查 2.1 的均衡覆盖与每道预期答案，`assessment_2_1_oracles.test.ts` 和 `assessment_2_1_hard_oracles.test.ts` 提供独立有限枚举。`benchmark/tests/assessment_2_2.test.ts` 检查紧凑覆盖和生产默认不变，`assessment_2_2_*oracle*.test.ts` 独立检查答案和模拟器路径。其他 `assessment_*.test.ts` 覆盖解析边界、独立枚举和工具行为。至少保留这些真实行为检查，不以删测试掩盖不兼容。
5. 只改执行代码但未改题目时，不改题库哈希。保存当次执行源码哈希，不把历史结果的执行来源伪装成当前代码。

## 基线与证据

- 只对生产 Assessment 1.0 接受 `assessment-baseline-v1`。完整 14 题、全部预定轮次、任务快照、当前全部源码哈希、Thinking 与逐样本协议必须通过 `build_assessment_baseline` 校验。实验性 2.0、2.1、2.2 和 2.3 运行只是校准证据，不能提升为基线。
- `bank_scope=subset` 不可提升为完整基线。缺失来源、不可评分和旧 schema 不能靠补默认值或改版本号升级。
- 原始调用、失败尝试和工具轨迹先落盘，再评分。Token 和费用缺失保持 `null`；汇总包括工具后续请求，估算不是账单。
- 个人工作区初始为空，不自动将捆绑的测试基线加载到服务或分析界面。需要观察记录的浏览器测试应显式填充自己的临时数据目录。
- 保持随附历史基线与原始 JSONL 的字节不变。`benchmark/baselines/assessment-historical-provenance.json` 固定历史快照的精确摘要及原始 Python 来源。TypeScript 离线重放验证行为等价，不表示源码相同。不能将历史哈希改写成当前哈希。
- 历史 Assessment 1.0 个人运行仍可查看，来源不兼容时不能提升为新基线。不能将随附证据的例外扩展到任意个人快照。
- 随附基线快照、原始实测记录和验证报告统一放在 `benchmark/baselines/`。项目目前只随附一份单轮完整观测，不把它描述成已验证排行榜。
- 个人运行在数据目录的 `assessment/`，个人基线在 `assessment-baselines/`。不读写已退役的个人 `runs/`、`baselines/` 或自定义旧题库文件；删除项目外个人数据需单独授权。
- 目录中的 `provider_id` 是 `owned_by` 声明的精确实例 ID，不是已核验的实际服务商或供应商类型。远端路由展开必须有经过边界校验的 `magpie_via` 目录证据及正式的 owner 前缀路径，排除本地 `auto/`、`group/` 条目，只展开一级命名空间，完整请求模型名不变。新快照保留 `remote_route` 元数据，不为历史推导补全，也不把随机 hop ID 保存为身份。目录握手会附带非对话模型，必须过滤。快照只保留当时记录的元数据，不用当前目录回填历史身份。`gateway-default` 是并发池，不是上游账号。未知供应商类型和图标使用中性展示，不编造异常标签或检测器。
- 题库内容相同还不够，Thinking、输出预算、工具轮次等执行配置也必须可比。`default` 是不发送 `reasoning`，不是显式 `none`。

## 安全与运行约束

- 真实评测、校准和额外实测可能收费，执行前确认模型、账号、次数和预算。离线测试通过不构成真实请求授权。
- 上游凭证只通过服务进程环境变量引用，不放进路由 JSON、前端、日志或文档。账号名称和模型回显不等于实际身份已核验。
- 保持 loopback 监听、token、Host/Origin 校验、严格 JSON 和无重定向请求。错误响应不能泄露凭证或完整异常内容。
- 临时 API 错误按 `max_api_retries` 重试，默认首次请求之外最多 3 次，同账号且共用整题超时时间。新任务默认每题总超时 600 秒，无 token、请求数、费用、工具调用数或交互轮数上限；历史任务手动重试保留原来显式记录的限制。能力问题不重试，不切换账号，重启不自动续跑。手动重试须由用户明确操作，保留历次尝试且不重跑成功样本。创建任务超时先查历史，不自动重发任务创建请求。
- 一个任务包含独立持久化的单目标子 run。新任务默认完整题库 3 轮、run 内样本并发 6、任务内 run 并发 3，全局默认 18；账号和全局上限可以进一步限流。直接 run 保留每目标串行限制。全部子 run 证据和任务归属提交成功后才允许调度，不改写历史 run 字节。修改调度器时覆盖取消、发布失败、存储失败与重启边界。
- 新任务只暴露整题超时（默认 600 秒），另保留轮数及并发；不重新引入请求、token、费用、工具或交互轮数上限。提交前展示样本规模和超时，历史重试保留当时记录的限制。不能暗示 Magpie 目录路由固定了账号；宿主网关也可能内部重试。账号固定和禁止上游重试需要明确受支持的宿主能力，生成路由名称不构成证据。

## 维护习惯

沿用现有 TypeScript 风格，保持清晰命名和小函数，局部修改不顺手统一全项目格式。新增功能同步维护对应测试，文档说明必须以当前实现为准。

仅保留当前使用文档，不再添加旧方案、原型归档或历史兼容说明。`benchmark/baselines/` 中保留的当前基线证据不是临时文件。可清理 `.playwright-cli/`、测试缓存和 `.DS_Store`；发布前确认无 token、个人数据、浏览器缓存或临时验证产物混入项目。

发布包由根目录 `package.json` 的 `files` 白名单控制，运行源码快照、题库清单、捆绑证据、网页资源和 Magpie 入口必须齐全。发布前检查 `npm pack --dry-run --json --ignore-scripts`，将实际压缩包解压到临时目录，并在那里运行离线测试与插件启动验证。不得包含个人 `assessment/`、`assessment-baselines/`、路由凭证、浏览器缓存或验证日志。打标签、推送或发布前确认项目许可证和目标位置。

用户文档入口是 [README.zh.md](README.zh.md)，执行协议与 API 见 [docs/BENCH_EXECUTION.zh.md](docs/BENCH_EXECUTION.zh.md)，评分说明见 [docs/ASSESSMENT_BANK.zh.md](docs/ASSESSMENT_BANK.zh.md)。
