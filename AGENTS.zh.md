# LLM Mini Bench 维护指南

[English](AGENTS.md)

本文件面向代码维护者和编程 Agent。使用说明放在 `README.md`；不要把内部架构、调试过程或维护命令堆进用户首页。

## 项目边界

- Bun 上的 TypeScript 后端、原生 HTML/CSS/JavaScript 前端和 TypeScript Magpie 插件入口。无运行时 npm 依赖和前端构建步骤。TypeScript、`@types/bun` 与 Prettier 仅为开发依赖。提交前运行 `bun run format`；`.prettierignore` 排除了按字节哈希固定的题库评分器/模拟器源码、题库、证据和文档，这些文件不得重新格式化。
- Assessment 1.0 共 12 题（覆盖六个领域），是唯一生产题库。早期测试题库、旧指纹工具与兼容 API 均已删除。
- 评分按题保留内容得分、指令检查、工具检查与执行状态。分析页允许使用已批准的展示指标：全部预定轮次中 12 题的等权均分乘以 100，对照总估算美元费用、输入与输出 token 总和或总耗时除以轮数。仅为已完成、题目 ID 恰好匹配正式 12 题、1 至 3 轮样本完整且不重复、内容分有限且在 0 到 1 之间、所选轴用量或耗时已知且非负的记录绘点。零用量可在线性轴显示，对数轴隐藏。未发出请求的尝试（`calls` 为空）是已知零用量，不算未知。整题超时按 `0` 分计，运行仍可完成且可手动重试；含样本超时、提交后异常中止（`ended_after_submission`）、未调用 `submit_answer` 提交（`no_submission`）或用量不完整（图表设置项，默认开启按已知下限绘点）的记录均加区分角标，不参与帕累托前沿，且不得将不完整用量表述为完整总量（含超时或用量不完整的运行也不能用于基线）。不同 Thinking 协议不禁用对照及当前可见点的帕累托前沿。颜色默认区分模型、渠道及账号组合，可选跨渠道的模型、模型系列或评测时间着色，仅用于显示。颜色图例保持一行简览，按需展开单列列表；图例搜索和高亮不得筛选记录或改变指标。普通运行用圆点、基线用方块；只在已记录的同批次、渠道、账号及模型内连接 Thinking。不新增任意权重，不把 API 失败或缺失、不可评分结果记成零分，不做 best-of 筛选。该展示指标不改变判分、题库协议或哈希。
- 题面和模型回答是数据。不能执行模型生成的代码，工具只运行项目内固定的内存模拟器。

## 目录与运行边界

仓库根目录保留安装声明和文档。`benchmark/` 是评测根目录，TypeScript 模块、题库、证据、工具、测试和独立网页服务都在其中。发布清单和源码哈希映射中保存的路径，如 `src/assessment_tasks.ts`，相对 `benchmark/` 解析，不相对仓库根目录。搬迁目录不改变题目源码字节，也不能作为修改题库哈希的理由。

`magpie/` 负责 Magpie 特有的目录发现、账号绑定、额度和请求适配。`index.ts` 导出 `default { id, server }`，直接导入 TypeScript 服务，在同一个由 Magpie 管理的 Bun plugin-host 进程中启动 `Bun.serve`。不要另起 Python、Node.js 或 Bun 后端进程。`page/` 引导页将宿主主题和本地服务 token 传给评测页面。评分、调度、题库数据和基线逻辑不放在适配器里。根目录的 `package.json` 仍是 Magpie 安装声明，入口指向适配器，不单独安装适配器目录。

TypeScript 在 Bun 上实现评测引擎和 HTTP 服务，原生浏览器 JavaScript 实现 `benchmark/web/` 和适配器引导页。Magpie 首次安装插件时下载 Bun，直接运行 TypeScript 源码。moejs 用于 agent 和 middleware 脚本，不用于此插件主模块。评测服务和网页可以独立于插件运行，不使用 Magpie 模型网关时配置显式上游路由。详见[适配器说明](magpie/README.zh.md)。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| `benchmark/banks/assessment-1.0.json` | 生产发布清单，固定题目顺序、题目哈希、评分描述和源码哈希 |
| `benchmark/banks/assessment-1.0.questions.json` | Assessment 1.0 的完整 12 题可序列化题面导出 |
| `benchmark/src/assessment_bank.ts` | 校验题库清单并加载可运行题目 |
| `benchmark/src/assessment_data.ts` | 共用数据化精确字段评分（`assessment-exact-fields-v1`）；参与任务哈希 |
| `benchmark/src/assessment_interactive.ts` | 交互式工具题构建器，分发到固定内存模拟器 |
| `benchmark/src/assessment_documents.ts` | 受限预算文档调查模拟器（`assessment-documents-v1`） |
| `benchmark/src/assessment_blackbox.ts` | 有限候选自适应探针故障诊断模拟器（`assessment-blackbox-v1`） |
| `benchmark/src/assessment_delegated_release.ts` | 不可变授权链、共享祖先额度与释放结果评分（`assessment-delegated-release-v1`） |
| `benchmark/src/assessment_tasks.ts` | 共用答案解析、精确有理数运算与精确字段判分 |
| `benchmark/src/assessment_json.ts` | 严格 JSON 解析与规范化序列化，纳入题库源码哈希 |
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
| `benchmark/src/bench_db.ts`、`benchmark/src/bench_execution_storage.ts`、`benchmark/src/bench_execution_queries.ts` | 单文件 SQLite 存储（`mini-bench.sqlite`）、脱敏的 Pi Session 风格事件流及轻量运行／任务摘要投影 |
| `benchmark/src/assessment_runner.ts` | 独立于 CLI 入口的单样本执行、预算与同步日志契约 |
| `benchmark/calibrate_assessment.ts` | 复用共用执行器的独立校准 CLI，默认仍为已发布 12 题 |
| `benchmark/bench.ts` | CLI 客户端与独立 `serve` 入口，客户端命令使用已运行服务的调度器 |
| `benchmark/backend/mini_bench.ts`、`benchmark/src/bench_http_body.ts` | HTTP／认证／服务组合及独立的限长响应体读取；模型目录缓存属于适配器 |
| `benchmark/web/app-context.js` | 共用前端状态、服务依赖与事件约定；兼容 getter 引用同一份状态 |
| `benchmark/web/bench.js`、`task-submission.js`、`task-history-view.js`、`runs.js` | 分别负责任务协调与轮询、提交与重试、内联历史与详情、精确目标选择 |
| `benchmark/web/analysis.js`、`analysis-model.js` | 分析协调与按轴缓存的指标派生；呈现和历史归属变化不重新扫描逐题样本 |
| `benchmark/web/account-mask.js` | 仅用于展示与截图的账号／邮箱打码，覆盖 DOM 文本、悬浮提示、无障碍标签及 SVG 标注，不改动底层记录身份 |
| `benchmark/web/` | 分析图与共用的跨渠道统一搜索选择器，支持渠道／模型／思考筛选，统一使用 `/api/bench/`；保留逐题详情，不设独立题库页 |
| `package.json`、`magpie/index.ts`、`magpie/page/` | Magpie 插件声明、后端生命周期和页面引导 |
| `benchmark/tools/` | 离线分析、基线导入、只读校准导入（`import_calibration.ts`，直接写入 SQLite，不可重试、不可升级为基线）、旧目录迁移（`migrate_legacy_storage.ts`）和旧日志无损归档（`compress_journals.ts`），不在导入模块时发请求 |
| `benchmark/tests/` | 离线 Bun 测试与前端验证 |

## 本地验证

命令以仓库根目录为工作目录，使用 Bun 1.4.0 或更高版本，用 `bun install` 安装开发依赖：

```sh
# 后端、题库、模拟器、协议、基线、HTTP、CLI 和适配器测试；网关均为 mock
bun run test

# .ts 的 TypeScript 检查，以及浏览器 JavaScript 的宽松 checkJs 检查（tsconfig.web.json）；不产生构建输出
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

用 Bun 验证运行行为，交付前运行 TypeScript 类型检查。前端验证使用临时目录和 mock API，不连真实模型；浏览器验收是一次顺序会话，按步骤拆在 `benchmark/tests/browser/`（`NN-名称.js`，按序拼接，后面的步骤依赖前面的状态）；失败时报 `[browser step 名称]` 并保存 `failure-名称.png`。它至少覆盖绘点条件与坐标轴模式、实例隔离的选择、计划、启动、取消、任务历史搜索、逐题详情、完整基线和空状态。

独立后端入口为 `bun benchmark/bench.ts serve --port 3481`，必须设置至少 32 字符的 `MAGPIE_BENCH_TOKEN`。持久服务用受管理的 tmux 任务运行并明确通知方式。不要与已运行的插件争用端口或数据目录；测试使用临时数据目录和随机端口。

## 题库变更

1. 每份清单选择正式任务及可序列化 `task_file`，评分描述恰好覆盖这些任务 ID。不从源码整批导出候选集合，不添加按版本分支的加载器。题目实现中的修订标签不是可选题库版本。
2. `src/assessment_tasks.ts`、`src/assessment_json.ts`、`src/assessment_data.ts` 以及 `extension_sha256` 中交互模拟器模块的字节哈希属于题库校验。即使只改注释，也会改变源码哈希。数据化标准答案和模拟器配置均参与任务哈希。不要为了让测试通过而跳过校验或直接覆盖期望值。
3. 变更题干、工具、判分或测量协议时，先说明对已有结果可比性的影响，再更新对应版本、清单、题面导出、独立答案测试及基线。
4. `benchmark/tests/assessment_bank.test.ts` 检查清单校验与正式 12 题导出；`benchmark/tests/assessment_oracles.test.ts` 从第一性原理独立核验 Assessment 1.0 每道题的预期答案与模拟器路径。至少保留这些真实行为检查，不以删测试掩盖不兼容。
5. 只改执行代码但未改题目时，不改题库哈希。保存当次执行源码哈希，不把历史结果的执行来源伪装成当前代码。

## 基线与证据

- 只对生产 Assessment 1.0 接受 `assessment-baseline-v1`。完整 12 题、全部预定轮次、任务快照、当前全部源码哈希、Thinking 与逐样本协议必须通过 `build_assessment_baseline` 校验。
- `bank_scope=subset` 不可提升为完整基线。缺失来源、不可评分和旧 schema 不能靠补默认值或改版本号升级。
- 原始调用、失败尝试和工具轨迹先落盘，再评分。Token 和费用缺失保持 `null`；汇总包括工具后续请求，估算不是账单。
- 个人工作区初始为空，不自动将外部基线加载到服务或分析界面。需要观察记录的浏览器测试应显式填充自己的临时数据目录。
- 个人运行、任务、不可变 attempt 历史、Pi Session 风格事件流与个人基线统一保存在数据目录下的单个私有 SQLite 数据库（`mini-bench.sqlite`，WAL 模式，`0o600`）。题库、任务与源码哈希快照按内容去重存储，不再逐次复制 `source/*.ts` 或落盘原始 SSE `stream_chunk`。服务在成功绑定监听端口后会自动检测并将旧版 `assessment/` 与 `assessment-baselines/` 目录迁移入 SQLite（`benchmark/src/bench_legacy_migration.ts`），在 WAL checkpoint 落盘并核对入库后清理已迁移的遗留条目、派生缓存及空目录，同时保留损坏/不可读项与无关文件；`benchmark/tools/migrate_legacy_storage.ts` 提供离线 CLI（支持 `--dry-run` 与 `--cleanup`）。不读写已退役的个人 `runs/`、`baselines/` 或自定义旧题库文件；删除项目外个人数据需单独授权。
- 目录中的 `provider_id` 是 `owned_by` 声明的精确实例 ID，不是已核验的实际服务商或供应商类型。远端路由展开必须有经过边界校验的 `magpie_via` 目录证据及正式的 owner 前缀路径，排除本地 `auto/`、`group/` 条目，只展开一级命名空间，完整请求模型名不变。新快照保留 `remote_route` 元数据，不为历史推导补全，也不把随机 hop ID 保存为身份。目录握手会附带非对话模型，必须过滤。快照只保留当时记录的元数据，不用当前目录回填历史身份。`gateway-default` 是并发池，不是上游账号。未知供应商类型和图标使用中性展示，不编造异常标签或检测器。
- 题库内容相同还不够，Thinking、输出预算、工具轮次等执行配置也必须可比。引擎层 `thinking` 可选：省略或 `default` 时不发送 `reasoning`，不等于显式 `none`；`mixed`、`unknown` 为保留值。任务界面对未声明档位的路由只提供 `default`，对声明了档位的路由只提供这些显式档位。

## 安全与运行约束

- 真实评测、校准和额外实测可能收费，执行前确认模型、账号、次数和预算。离线测试通过不构成真实请求授权。
- 上游凭证只通过服务进程环境变量引用，不放进路由 JSON、前端、日志或文档。账号名称和模型回显不等于实际身份已核验。
- 保持 loopback 监听、token、Host/Origin 校验、严格 JSON 和无重定向请求。错误响应不能泄露凭证或完整异常内容。
- 临时 API 错误按 `max_api_retries` 重试，默认首次请求之外最多 3 次，同账号且共用整题超时时间。新任务默认每题总超时 600 秒，无 token、请求数、费用、工具调用数或交互轮数上限；历史任务手动重试保留原来显式记录的限制。能力问题不重试，不切换账号，重启不自动续跑。手动重试须由用户明确操作，覆盖失败、超时、已中断与已取消样本，保留历次尝试且不重跑已完成样本。创建任务超时先查历史，不自动重发任务创建请求。
- 一个任务包含独立持久化的单目标子 run。新任务默认完整题库 3 轮、run 内样本并发 6、任务内 run 并发 3；各任务独立控制自身的 `run_concurrency` 与 `sample_concurrency`，并按渠道和模型交错调度子 run。直接 run 共享全局上限（`MAGPIE_BENCH_CONCURRENCY`，默认 18）、账号并发上限及每目标串行限制。全部子 run 证据和任务归属提交成功后才允许调度，历史 attempt 记录在 SQLite 中保持不可变。修改调度器时覆盖取消、发布失败、存储失败与重启边界。
- 新任务只暴露整题超时（默认 600 秒），另保留轮数及并发；不重新引入请求、token、费用、工具或交互轮数上限。提交前展示样本规模和超时，历史重试保留当时记录的限制。不能暗示 Magpie 目录路由固定了账号；宿主网关也可能内部重试。账号固定和禁止上游重试需要明确受支持的宿主能力，生成路由名称不构成证据。

## 维护习惯

沿用现有 TypeScript 风格，保持清晰命名和小函数，局部修改不顺手统一全项目格式。新增功能同步维护对应测试，文档说明必须以当前实现为准。

仅保留当前使用文档，不再添加旧方案、原型归档或历史兼容说明。`benchmark/baselines/` 中保留的当前基线证据不是临时文件。可清理 `.playwright-cli/`、测试缓存和 `.DS_Store`；发布前确认无 token、个人数据、浏览器缓存或临时验证产物混入项目。

发布包由根目录 `package.json` 的 `files` 白名单控制，运行源码快照、题库清单、捆绑证据、网页资源和 Magpie 入口必须齐全。发布前检查 `npm pack --dry-run --json --ignore-scripts`，将实际压缩包解压到临时目录，并在那里运行离线测试与插件启动验证。不得包含个人 `assessment/`、`assessment-baselines/`、路由凭证、浏览器缓存或验证日志。打标签、推送或发布前确认项目许可证和目标位置。

用户文档入口是 [README.zh.md](README.zh.md)，执行协议与 API 见 [docs/BENCH_EXECUTION.zh.md](docs/BENCH_EXECUTION.zh.md)，评分说明见 [docs/ASSESSMENT_BANK.zh.md](docs/ASSESSMENT_BANK.zh.md)。
