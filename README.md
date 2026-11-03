# dsh-gpt-codex — 用 ChatGPT 订阅驱动 DeepSeek Harness 桌面版

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

这个插件补上桌面版 0.2.1-rc.5 里唯一缺的那一块：让你**用 ChatGPT 订阅（而不是 API key）跑 GPT**。

底层东西其实官方都已经装好了，本插件不重复实现：

| 已原生具备 | 位置 |
|---|---|
| pi-ai 适配器（dormant，零 route） | `@deepseek-ai/dsh-llm-pi-ai`，随 `dsh-base` 挂载 |
| `openai-codex` provider，`https://chatgpt.com/backend-api`，9 个 chat 模型 | `@earendil-works/pi-ai` 1.1.0 |
| ChatGPT OAuth 授权流（`llm-pi-ai/openai-codex`） | `dsh-llm-pi-ai` 的 `registerPiAiFlows` |
| 凭据落盘与跨进程刷新 | `dsh-credentials-local` → `~/.dsh/.credentials.yaml` |

**缺的只有两件事**，也正是本插件的全部内容：

1. **没人能触发那条 OAuth 流。** 全应用里 `authorization.begin()` 的唯一调用方是 DeepSeek 账号插件；Models 页面对 `openai-codex`（`env: []` + `oauth: true` 的 keyless native auth）**连 API key 输入框都不渲染**，`settings.models.sign-in` 又被 DeepSeek 首次引导占着。所以界面上根本没有登录入口。
2. **`llm-pi-ai` 没有 `openai-codex` 这条 route**，即使有凭据也不服务任何模型。

> 换句话说：官方并不缺 GPT 适配器，缺的是**触发登录的入口**和**一条 route**。这个插件只补这两处，不重写适配器。

## 快速开始

```bash
git clone https://github.com/bhjia-phys/dsh-gpt-codex.git
cd dsh-gpt-codex
npm test          # 43 项离线测试，不联网、不碰真实凭据
```

安装到某个 DSH profile（以 `desktop` 为例）：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dsh": { "profile": { "bundles": [ /* … */ "dsh-gpt-codex" ] } },
"dependencies": { "dsh-gpt-codex": "link:/absolute/path/to/dsh-gpt-codex" }
```

把包链接进 profile 的 `node_modules/`（非 scoped 包直接放顶层），重启桌面版，然后打开 **设置 → GPT 接入**。

## 两种登录方式

### A. 复用已有的 Codex CLI 登录（推荐，最快）

如果你在这台机器的 Codex CLI 里已经登录过 ChatGPT（`~/.codex/auth.json` 存在且 `auth_mode: chatgpt`），插件直接把里面的 OAuth token 搬进 Harness 的凭据库：

- **不联网、不重开浏览器、不重新授权**
- 写入的记录形状与 `dsh-llm-pi-ai` 读取的完全一致：`kind: grant` + `payload: { type:'oauth', access, refresh, expires, accountId }`
- `accountId` 从 access token 的 `https://api.openai.com/auth` claim 里读（就是 pi-ai 自己 `credentialsFromToken` 的做法）；`expires` 来自 JWT 的 `exp`
- access token 过期也没关系：pi-ai 会在下一次请求时用 `refresh` token 自动续期

### B. 浏览器 OAuth（没有 Codex CLI 登录时）

插件在 Host 半调用 `ctx.authorization.begin({ key: 'llm-pi-ai/openai-codex' })`，把 pi-ai 自己的流程跑起来：

1. 先问你选登录方式（browser / device code）
2. browser：回调地址 `127.0.0.1:1455/auth/callback`；端口被占用时退化成「粘贴授权码或重定向 URL」
3. device code：给出验证码与 `https://auth.openai.com/codex/device`

面板会实时显示 URL、验证码和待回答问题。**登录尝试不可跨页面刷新恢复**（授权 seam 不持久化 attempt），刷新页面就得重来。

## 两个必须知道的实测事实

这两条都不是推理出来的，是 2026-11-02 在这台机器上量出来的，而且都会让人误判成「插件坏了」。

### 1. `exp` 没过期 ≠ token 还能用

存进去的 access token 距离 `exp` 还有 **6.85 天**，但 `api.openai.com/v1/me` 和 Codex 后端都返回 **401**——服务端提前吊销了它。同一个 refresh token 却能正常换出新 token。

所以「凭据已配置」和「真的能用」是两个不同的事实，只有**真实请求**或**刷新**才能区分。插件因此：

- 桥接时**先刷新再存**，不信任 `exp`
- 提供 `GET /gpt-codex/verify`：发一次真实小请求，401 时自动刷新并重试一次
- `gpt_status` 默认带验证；`verify: false` 时才只看本地状态（并明确标注「未验证」）

### 2. 直连不通，而这台机器上 DSH 拿不到系统代理

`auth.openai.com` 和 `chatgpt.com` 直连**超时**；走本机 Clash（`127.0.0.1:7897`）立即通。而 Windows 的**系统代理开关是关着的**（`ProxyEnable: 0`），所以没有进程自动继承代理。

更麻烦的是：Node 的全局 `fetch` **默认忽略** `HTTP(S)_PROXY`，除非进程启动时就设了 `NODE_USE_ENV_PROXY=1`——已经跑起来的桌面版无法补上这个变量。

所以插件自己解析代理并给每个请求挂显式 `dispatcher`：`proxy` 配置 > `HTTPS_PROXY`/`HTTP_PROXY` > 直连。在 `cordis.patch.yml` 里写：

```yaml
- id: gpt-codex
  name: 'dsh-gpt-codex'
  config:
    proxy: 'http://127.0.0.1:7897'
```

> 这条也是「处理失败 / token has expired」真正的根因：请求根本没到 OpenAI，或带着被吊销的 token 到了。

## 面板在哪

两个入口：

1. **设置 → GPT 接入**（`settings.section`，`id: gpt-codex`）：完整生命周期。显示凭据状态与到期时间、ChatGPT 账号、Codex CLI 登录是否可复用、route 是否启用、OAuth 流是否可用；按钮：复用 Codex CLI 登录 / 浏览器登录 / 仅启用 route / **验证能否用** / **刷新 token** / 登出。
2. **设置 → 模型 → `openai-codex` 那一行的卡片内**（`settings.models.provider-card`）：就在用户本来要找 provider 配置的地方，给一个「复用 Codex CLI 登录」按钮。

> 第 2 个入口有个坑值得记下来：`settings.models.provider-card` 是 **keyed** slot，渲染器按 `options.key === entryKey` 解析（`dsh-client-ui-renderer/lib/client.js:1179`），而 Models 页传入的 `entryKey` 是 `row.entry.settingsNs` —— pi-ai 家族即 `"llm-pi-ai"`。key 写成别的值不会报错，只是**静默不渲染**。测试里专门钉了这条契约。

## Agent 工具

模型自己也能操作这三件事：

| 工具 | 作用 |
|---|---|
| `gpt_status` | 凭据、Codex CLI 可复用性、route 状态，默认发一次真实请求确认可用（`verify: false` 可跳过） |
| `gpt_sign_in` | `mode: 'codex-cli'`（默认）桥接；`mode: 'browser'` 会如实拒绝，因为需要人工交互 |
| `gpt_sign_out` | 删除本机记录（不向 OpenAI 撤销，也不动 Codex CLI 自己的登录） |

## HTTP 路由

客户端半只能走同源 `fetch`（client bundle 里没有 `host`、没有 fs、没有 `ctx.remote` 的自定义命名空间）：

```
GET  /gpt-codex/status
POST /gpt-codex/sign-in        { mode: 'codex-cli' }
POST /gpt-codex/sign-out
POST /gpt-codex/oauth/start
POST /gpt-codex/oauth/answer   { value }
POST /gpt-codex/oauth/cancel
GET  /gpt-codex/oauth/state
POST /gpt-codex/route/enable
```

## 为什么 route 走 settings 而不是 bundle patch

Cordis patch 对匹配到的条目是**整段替换**、不深合并（`dsh-app-boot/README.md:204`），而 profile 的 `cordis.patch.yml` 已经写了 `llm-pi-ai` 的 providers。如果插件在 bundle 层 patch 这一行，会在 profile 层被整个覆盖掉。所以插件改用 `ctx.settings.mutate()` —— 与 Models 页同一条写入路径，落在真正生效的那一层。

`{ transport: 'sse' }` 这个 route 不是占位符，而是刻意的配置：

- 不写 `models` → `resolveRouteModels` 回落内置目录的 9 个模型
- 不写 `apiKeyEnv` → 走 pi-ai 自己的 OAuth credential store（即 `llm-pi-ai/openai-codex`）
- **不要**手写 `api: openai-codex-responses`：`supportedProtocols()` 只允许 openai-completions / openai-responses / anthropic-messages；catalog route 不写 `api` 才会复用 codex 实现
- **`transport: 'sse'` 是规避一个官方缺陷**：pi-ai 的 Codex WebSocket 缓存把 socket 连同 idle timer 留在模块级 Map 里，而这个版本里 `cleanupSessionResources` **零调用方**——没人调 `closeOpenAICodexWebSocketSessions`。结果是 WebSocket 那一轮答完之后事件循环不空，桌面版上表现为「回答完了但请求不收尾」。`auto` 可能选中 WebSocket，因此继承这个问题。上游 AITP fork 撞到同一件事，最后也把 SSE 定成默认。这只是传输选择，协议本身没变。

如果你自己已经配置了 `openai-codex`（换 transport、钉模型列表、改 endpoint），插件**不会覆盖**：它会报 `already-configured-differently` 然后放着不动。

## 安装

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dsh": { "profile": { "bundles": [ /* … */ "dsh-gpt-codex" ] } },
"dependencies": { "dsh-gpt-codex": "link:/absolute/path/to/dsh-gpt-codex" }
```

再把包链接进 profile 的 `node_modules/dsh-gpt-codex`（非 scoped 包放顶层），然后**重启桌面版**。

## 配置

```yaml
- insert:
    - id: gpt-codex
      name: 'dsh-gpt-codex'
      config:
        codexAuthPath: ''      # 空 = $CODEX_HOME 或 ~/.codex
        autoEnableRoute: true  # 已有凭据时自动补上 openai-codex route
```

## 测试

```bash
node test-host.mjs      # 36 项：桥接、route 启用、OAuth 状态机、工具、路由、客户端包形态、slot 契约、刷新自愈、真实探测
node test-contract.mjs  #  7 项：record 是否能通过真实 store 的准入规则；与已安装 pi-ai 目录交叉验证
```

两个测试都不联网、不发起真实 OAuth、不碰真实凭据库（用替身），`test-contract.mjs` 会从已安装的 `app.asar` 里读出真实的 `openai-codex` 目录做交叉验证。

## 已知边界

- **必须有真实的 ChatGPT 订阅账号。** 插件不绕过计费或授权。
- **`begin()` 只确认「本次 attempt 内 record 被提交」，不保证 token 可用。** 首次真实请求能否被 codex 后端接受，需要真实网络与订阅才能证明 —— 这不在本插件的测试范围内。
- **面板里的浏览器登录依赖 Host 进程存活**；页面刷新会丢掉进行中的 attempt。
- **Codex CLI 那条路只有在 `auth_mode: chatgpt` 时可用**；`auth_mode: apikey` 会被明确拒绝（不会悄悄搬一个错误形状进去）。
- pi-ai 的 `originator` 头默认是 `"pi"`。若后端策略要求别的值，需要在 pi-ai 上游改，插件层碰不到。

## 更多文档

- [docs/desktop-integration-findings.md](docs/desktop-integration-findings.md) — 桌面版链路核实：登录入口到底缺在哪、凭据怎么落盘、`interaction` 的精确类型，以及两条**实测出来**的坑（token `exp` 未到期却已被吊销；Node 的 `fetch` 默认忽略代理导致请求根本没发出）。
- [docs/aitp-agent-fork-inventory.md](docs/aitp-agent-fork-inventory.md) — 对照 AITP-agent fork：官方 0.2.1-rc.5 已原生具备什么、那个 fork 独有改了什么，以及**哪些问题只写插件根本修不了**（适配器 `dispose()`、错误分类、WebSocket 缓存所有权等）。
- [tools/extract-asar.mjs](tools/extract-asar.mjs) — 上面两份文档里每条结论都标了 `文件:行号`；这个工具从你自己安装的应用里重新解包，用来核对。不含任何厂商源码。

## 贡献

两个测试是唯一的准入门槛：

```bash
npm test
```

它们刻意不联网、不碰真实凭据，所以任何人在任何机器上都能跑。`test-contract.mjs` 会尝试从已安装的 DeepSeek Harness 里读真实目录做交叉验证；找不到应用时自动跳过（可用 `DSH_ASAR` 指定路径）。

## 许可

[MIT](LICENSE)
