# Magpie 适配器

[English](README.md)

本目录将 Magpie 接到 [benchmark/](../benchmark/) 中的评测应用，不包含题库、评分、调度器或基线实现。

## 安装边界

npm 和 GitHub 安装方式见[项目首页](../README.zh.md)。本地开发时，也可以注册仓库根目录：

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin add "$PWD"
/Applications/magpie.app/Contents/MacOS/magpie plugin on "$PWD"
```

从仓库根目录运行这些命令，不要把 `magpie/` 单独注册为插件，也不要只复制本目录。

根目录的 [package.json](../package.json) 是安装声明。`main` 指向 `./magpie/index.ts`，`magpie.page.file` 指向 `magpie/page/index.html`。[Magpie 在首次安装插件时下载 Bun](https://usemagpie.ai/docs/plugins)，直接运行 TypeScript 源码。插件使用无需另装 Python 或 Node.js、安装运行时 npm 依赖或进行构建。

更新后端代码后，先确认没有活跃评测，再仅停用、启用 LLM Mini Bench 并重新加载宿主页面。只刷新页面不会重新加载后端。不要自动重启或更新 Magpie 作为修复手段，宿主操作可能改写 agent 接入文件。插件生命周期测试不能证明真实宿主已重新加载。

## 文件与运行环境

| 文件或目录 | 运行环境与职责 |
| --- | --- |
| `index.ts` | 导出 `default { id, server }` 的 TypeScript 模块，校验插件选项，直接导入服务，在 Magpie 的 Bun plugin-host 中管理服务生命周期 |
| `magpie_service.ts`、`magpie_adapter.ts` | 组装通用服务，负责 Magpie 目录 HTTP、缓存与刷新 |
| `magpie_routes.ts`、`magpie_accounts.ts`、`magpie_quotas.ts` | 标准化路由及额度，在请求客户端处理显式账号固定 |
| `page/index.html`、`page/boot.js` | 浏览器引导页，读取 Magpie 选项和主题，携带本地服务 token 打开评测页面 |
| `../benchmark/backend/mini_bench.ts` | Bun HTTP 服务，通过 `Bun.serve` 提供评测 API 和网页 |
| `../benchmark/src/` | TypeScript 评测、评分、路由、调度和基线逻辑 |
| `../benchmark/web/` | 原生 HTML/CSS/浏览器 JavaScript 评测界面 |

适配器和后端在同一个由 Magpie 管理的 Bun 进程中运行，不启动 Python、Node.js 或独立 Bun 进程。Magpie 的 moejs 引擎用于 agent 和 middleware 脚本，不用于此插件主模块。

## 启动与配置

页面首次打开时自动初始化连接：生成 256 位随机本地 token 和私有端口范围中的端口，通过 Magpie 支持的 `options.set` 桥接保存，再仅重新加载自身 iframe，使宿主运行时和远程服务代理使用同一配置。已有的有效设置和可选账号绑定会保留，不提供无认证的 token 查询接口。

完成这次握手后，适配器直接导入 `benchmark/backend/mini_bench.ts` 并启动本地服务。如需上游凭证或显式路由覆盖，应将其放入 Magpie plugin-host 的进程环境，只在另一个 CLI 终端中设置并不生效。

评测后端和界面也可以通过 Bun 独立运行，不依赖适配器。启动方式和显式账号路由见[执行说明](../docs/BENCH_EXECUTION.zh.md)。不要另起服务占用已启用插件的端口或数据目录。

## 本地多账号与多 Key 绑定

Magpie 通过 `X-Magpie-Account` 请求头将请求固定到本机供应商的单个订阅账号或 API Key：不路由、不切换，失败时原样返回厂商错误。在 Magpie `v0.1.4621+` 上，适配器会自动读取 `GET /v1/magpie/accounts?models=full`（仅含标识符、不含明文密钥，且覆盖无额度信息的 API Key 渠道），将所有已启用的本机账号与 Key 展开在每个模型的默认路由旁作为 `gateway_account_binding` 固定绑定目标，并按网关返回的 `pin`（`<provider>/<id>`）原样固定请求。在 Magpie `v0.1.4805+` 上，`models=full` 会按 `/v1/models` 格式返回每个账号完整可服务模型的元数据（`display_name`、推理档位、`pricing`、`kind` 等），不再受 `/v1/models` 对外暴露上限限制并按账号实际服务范围过滤；同时兼容 `v0.1.4794+` 的纯模型 ID 列表，未在目录中提供单价的模型仍以 `pricing: null` 允许正常评测（Tokens 与耗时维度正常入图，费用保持 `null`）。重名或占位标签会自动附加非敏感 `id` 区分，停用条目和远端路由不会被当作本机账号固定，遇到 `401`/`403` 时清空自动发现目标。在尚未提供 `/v1/magpie/accounts` 的旧版 Magpie 上，适配器会自动回退读取 `/v1/magpie/quotas/cards` 中的具名本地卡片，接口不可用时降级为默认路由。

也可在插件选项中通过可选的 `accounts` 数组显式绑定（填写 `pin`、账号名或 ID），用于自定义 `account_ref` 或限定模型列表（保留已自动保存的连接设置；同一本机渠道/账号下显式 `accounts` 优先于自动发现）：

```json
{
  "accounts": [
    { "provider_id": "codex", "account": "first@example.invalid", "account_ref": "codex-first", "models": ["codex/gpt-6-luna"] },
    { "provider_id": "relay", "account": "work-key", "account_ref": "relay-work" }
  ]
}
```

`account` 使用接收请求的本机 Magpie 能识别的账号名称或路由轨迹 ID。同名账号应使用各自的轨迹 ID。省略 `models` 时，展示该本地渠道下所有带价格的目录模型；列出模型并不证明账号支持它。Magpie 在账号不存在或不可用时返回错误，不会改用其他账号。适配器设置 `X-Magpie-Account`，计划中保存不含密钥的绑定指纹；Mini Bench 核心不解析这项配置或请求头。

这不能固定 Remote Magpie 后面的账号，请求头只在接收端生效。远端额度仍是只读信息。账号绑定是请求证据，不是独立核验的上游身份；Magpie 可能在同一账号内重试，Mini Bench 在配置的重试次数与整题超时（或历史运行）上限内重试临时 API 失败，不切换账号绑定。

## 离线适配器测试

从仓库根目录运行：

```sh
bun test ./magpie
```

测试检查适配器生命周期，不发付费模型请求。验证两种分发形式时运行：

```sh
bun run test:install
```

这项可选检查需要 Git，使用当前 Bun 可执行文件。它先生成发布压缩包，通过隔离的本地回环 npm registry 按包名和版本安装，再从带版本标签的临时 Git 仓库安装同一份源码。两份安装结果都必须能提供题库和网页，个人基线列表应为空。检查不会调用 Magpie CLI、注册到真实宿主、连接公共 registry 或发起模型请求。它验证共用的 Bun 安装和运行约定，不证明 npm 版本或 GitHub 标签已经对外发布。完整评测验证见 [AGENTS.zh.md](../AGENTS.zh.md)。
