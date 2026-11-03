# 桌面版 0.2.1-rc.5：用 ChatGPT 订阅跑 GPT 的链路与插件边界

证据根：`../evidence/asar/`（下列「lib/index.js」「README.md」等均指该目录内、文件名把 `/` 换成 `__` 的解包副本，例如 `__dsh__node_modules__@deepseek-ai__dsh-llm-pi-ai__lib__index.js`）。这一份是笔记引用到的 23 个文件，共 0.8 MB；要取别的文件用 `node tools/extract-asar.mjs get <asar 内路径>`，全量索引见 `evidence/asar-index.txt`。
范围：只做静态核实 + 只读探测；未发起任何 OAuth 登录，未改 profile / credentials / asar。

> 结论已被实现验证：本仓库按本文 §5 的判断写成，`npm test`（36 + 7 项）离线通过。

## 0. 结论速览

| 链路 | 可行性 | 依赖 |
|---|---|---|
| 纯配置（`openai-codex: {}`）+ Models 页登录 | **不成立**：Models 页没有触发 pi-ai OAuth 的入口 | `openai-codex` 的 flow 已注册，但全应用只有 DeepSeek 账号登录调用 `authorization.begin()` |
| 纯配置 + 手写 `.credentials.yaml` 的 grant 记录 | **技术上可行、未端到端验证** | 需要一条已授权的 access/refresh token；harness 会用 refresh 自行续期 |
| 插件 Host 半调 `ctx.authorization.begin()` | **成立**（唯一程序化入口） | `authorization` 已在 base composition 中 |
| 插件 client 半直接登录 | **不成立**（client 无 authorization remote 命名空间） | 必须 Host 执行、client 只做 UI + 同源 HTTP |

## 1. route 最小 YAML（直接可粘）

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      openai-codex: {}          # 不写 models → 用 pi-ai 内置目录 9 个 chat 模型
                                # 不写 apiKeyEnv → 走 pi-ai 自己的 OAuth credential store
```

- Config = `z.object({ providers: z.dict(profile).default({}).volatile() })`（`dsh-llm-pi-ai/lib/index.js:1083`）；profile 合法字段见 `:1049-1081`。
- 空 profile 之所以可用：`resolveRouteModels` 在 `models` 缺省时回落内置目录（`:674-678`），`resolveProfiles` 不再要求手写 api/baseURL（`:1117-1186`）。
- 内置模型（`@earendil-works/pi-ai/dist/providers/data/openai-codex.json`，pi-ai 1.1.0）：`gpt-5.3-codex-spark`(text, ctx 128k)、`gpt-5.5`、`gpt-5.6-luna/sol/terra`、`gpt-6-astra/luna/sol`、`gpt-6.1-sol`（均 text+image，ctx 272k，maxTokens 128k，`reasoning:true`）。全部 `api: openai-codex-responses`。
- 注意：`api` 不能手写 `openai-codex-responses`；`supportedProtocols()` 只含 openai-completions / openai-responses / anthropic-messages（`:834-838`）。catalog route 不写 `api` 才复用 catalog provider 的 codex 实现（`:926-928`、`:908-919`）。

## 2. 登录由谁发起

链路：`ctx.authorization.registerFlow` ← **dsh-llm-pi-ai**（`:2562-2596`，key = `llm-pi-ai/<providerId>`，`recordKeyFor` `:2046-2048`）→ `ctx.authorization.begin({key,method,interaction,signal})`（`dsh-authorization/lib/index.js:138-166`）→ 唯一现存调用方是 **dsh-deepseek-account-platform**（`lib/index.js:854-860`，且其 interaction 是 `prompt: () => Promise.reject(...)`，即它只服务自己的 flow）。

- `UNSERVED_OAUTH = new Set(["openai"])`（`dsh-llm-pi-ai/lib/index.js:2454`）→ `openai-codex` 的 oauth 方法**被提供**（`:2467-2480`）。
- 交互形态（pi-ai `dist/auth/oauth/openai-codex.js`）：
  1. 先 `prompt({type:'select', message:'Select OpenAI Codex login method:', options:[browser | device_code]})`（`:325-332`）→ 经 llm-pi-ai `restate()` 变成 `kind:'select'`。
  2. browser：`notify({type:'auth_url', url})`（`:287-291`）；本地回调服务器 `127.0.0.1:1455/auth/callback`（`:22`、`:278-286`），端口被占则 `catch(() => undefined)` 退化为「粘贴 redirect URL」；回调 host 可用 `PI_OAUTH_CALLBACK_HOST` 覆盖（`:32-34`）。同时并行 `prompt({type:'manual_code'})`（`:293-296`）→ restate 成 `kind:'text'`。
  3. device_code：`notify({type:'device_code', userCode, verificationUri})`（`:265-271`）。
- asar 全文检索：`authorization.begin` 仅 2 处，都在 deepseek-account-platform；`remote.authorization` / `namespace: "authorization"` **零命中** → client 侧没有 authorization RPC。

## 3. 凭据落盘

- 文件 `$DSH_HOME/.credentials.yaml`（默认 `~/.dsh/.credentials.yaml`，`dsh-credentials-local/lib/index.js:56-62`；config `path`/`dshHome`/`watch`/`debounceMs` `:396-401`）。
- record key = `<scope>/<id>`，本链路即 `llm-pi-ai/openai-codex`；scope 段与 id 段都必须 match `^[a-z][a-z0-9-]*$`（`dsh-credentials/lib/index.js:15`、`:56-59`）。
- 落盘内容：`kind: grant` + `payload:` = pi-ai 的 oauth credential 原样（`{type:'oauth', access, refresh, expires, accountId}`，`openai-codex.js:247-259`；存储侧 `jsonImage` 去掉 undefined，`:2061-2104`）。
- 刷新：`ModifyRecord` 的 mtime 语义 —— pi-ai 在 store 的 `modify()` 里做 refresh（`dsh-llm-pi-ai/lib/index.js:2157-2163`；pi-ai `dist/auth/resolve.js:62-95`），落盘用跨进程文件锁，等待上限 30s（`dsh-credentials-local/lib/index.js:78`、`:556-573`）。刷新只看 `expires`，5 分钟内到期就刷（`resolve.js:100-116`）。
- 登出 = `ctx.credentials.deleteRecord(credentialKey('llm-pi-ai','openai-codex'))`（`dsh-authorization/README.md:149`；`llm-pi-ai` 的 `delete` `:2164-2167`）。
- 现网实测：`~/.dsh/.credentials.yaml` 现有 `llm-pi-ai/opendesign` 之外的 4 条记录，**没有** `llm-pi-ai/openai-codex`。

## 4. 是否存在 CLI/工具入口触发 pi-ai OAuth？—— 没有

- `dsh` CLI（`@deepseek-ai/dsh/lib/bin.js`）只有 `--profile / --from-default-profile / --patch / --dump-config / --dump-config-schema / --dump-default-config` 和 `plugin`（转发 pnpm）。**无 login/auth 子命令**（`:104-116`）。
- `@earendil-works/pi-ai` 自带 `bin: pi-ai → dist/cli.js`，`pi-ai login <provider>` 确实存在；但它把凭证写到 **cwd 的 `auth.json`**（`cli.js:5,13-24,60-63`），**不写** harness 的 `llm-pi-ai/<id>` record → 对桌面版无效。
- `@openai/codex` 不在 asar 里（`"@openai/codex"` 零命中）；`.codex` 全文仅 1 处命中且是 openai SDK 的无关文件；`auth.json` 只出现在 pi-ai 的 README 与 cli.js。**Codex CLI 的 `~/.codex/auth.json` 不被 harness 读取**。
- 斜杠命令：`dsh-commands/lib/index.js` 只有通用 `register()`，`login|auth` 零命中。
- `dsh-tool-cordis` 是只读检视工具，不能调用业务方法（README:71）。
- 唯一现存的 `~/.codex/auth.json`（auth_mode=chatgpt，access token 含 `https://api.openai.com/auth`.chatgpt_account_id，未过期）**可以**作为手工搬料来源：把它映射成 `kind: grant` 的 record 即可，但这条路径未端到端验证。

## 5. 插件能做什么 / 不能做什么

### 能
1. **Host 半发起登录**：`ctx.authorization.begin({ key: 'llm-pi-ai/openai-codex', interaction, signal })`。`authorization` 行已在 base bundle（`dsh-base/cordis.patch.yml:117-118`），`credentials-local` 在 `:125-126`。类型见 §6。
2. **自己写 HTTP 路由供 client 调**：`ctx.webServer.register({ kind:'exact', path, handler })`（`dsh-host-webserver/README.md:61`）。本机插件 `@local/aitp-research-desk` 就是这么做的（`packages/aitp-research-desk/index.js:1166-1186` → `/aitp-research/api/...`），并已实测 `GET http://127.0.0.1:32250/aitp-research/api/projects` → **200**。
3. **在 Models 页每张 provider 卡片里塞按钮**：`settings.models.provider-card`（keyed, scope root，由 `ui-settings-models` 的 `settings.section` 声明，`lib/client.js:4492-4495`）。owner props 精确为 `{ provider: ProviderDirectoryEntry, configured: boolean, keyConfigured: boolean }`（`cordis-client-runner/lib/client.js` slot 契约；dispatch 见 models client `:2541-2545`、`:2616-2620`、`:2725-2729`），`entryKey = row.entry.settingsNs`，pi-ai 家族 = `"llm-pi-ai"`（`llm-pi-ai/lib/index.js:2817,2864`）。目录是「catalog 全量 ∪ 已配置 route」（`:2841-2857`），所以 `openai-codex` 即使还没配置也有 row（此时 `configured:false`）。
4. **让 GPT 模型出现在选择器**：不需要插件。只要 `llm-pi-ai` 有一条可服务的 `openai-codex` route，`ctx.llm.registerAdapter` 就会注册 route（`:2941-2956`），`listProviders()/listModels()` → `buildModelCatalog()` 自动进 picker（`dsh-api-session-controller/lib/index.js:563-611`）。默认模型另有 `agent-default-model`（`dsh-agent-default-model/README.md:34-46`）。

### 不能
1. **不能靠改 `cordis.patch.yml` 触发登录**：patch 只能给 row 喂 config（`dsh-app-boot/README.md:61,204` —— 整段替换、不深合并），而登录是运行期一次人机对话。
2. **client 半不能直接登录**：无 `authorization` remote 命名空间（§2）。`ctx.remote` 只暴露 typert 生成的命名空间（settings/credentials/llm/session/terminal/workspace…），插件无法自造一个（`dsh-typert-loader/README.md`、`dsh-typert-registry/README.md:46`）。client 只能：调插件自己的 HTTP 路由 → Host 执行 begin。
3. **不能把 `settings.models.sign-in` 用在 pi-ai 上**：那个 slot 只在 **DeepSeek 首次运行引导**（`settings.onboarding` 的 `deepseek-official` 行）里渲染，是「凭据编辑器之前选 DeepSeek 账号 vs API key」的选择器（models client `:2968-2973`、`:4508-4517`）；唯一占用者是 settings-account（`AccountOnboarding`）。pi-ai 卡片不会 dispatch 它。
4. **Models 页 api-key 输入框对 `openai-codex` 被隐藏**：`keylessNativeAuth = nativeAuth?.env.length === 0 && nativeAuth.oauth`（`models client:2030`），而 `openai-codex` 在 PROVIDER_DATA 里正是 `env: []`（`llm-pi-ai/lib/index.js:2729-2732`）→ 整块 key 字段不渲染（`:2045`）。所以页面上连「贴 key」都没有。

## 6. `interaction` 精确类型（可直接照抄）

```ts
interface AuthorizationNotice { message: string; url?: string; code?: string }   // 只有这三个字段

type AuthorizationPrompt = { signal?: AbortSignal } & (
  | { kind: 'text';    message: string; placeholder?: string }
  | { kind: 'secret';  message: string; placeholder?: string }
  | { kind: 'select';  message: string; options: readonly AuthorizationPromptOption[] }
)
interface AuthorizationPromptOption { id: string; label: string; description?: string }

interface AuthorizationInteraction {
  notify(notice: AuthorizationNotice): void
  prompt(prompt: AuthorizationPrompt): Promise<string>   // select 回 option.id；text/secret 回输入串
}

interface AuthorizationRequest {
  key: CredentialKey          // 'llm-pi-ai/openai-codex'
  method?: string             // 'oauth' | 'api-key'，缺省取 flow.methods[0]
  interaction: AuthorizationInteraction
  signal?: AbortSignal
}
// begin() → { status: 'authorized' | 'cancelled' }；抛 NO_FLOW / UNKNOWN_METHOD /
// ALREADY_IN_FLIGHT / NOT_COMMITTED；人拒绝时 flow 抛 AuthorizationDeclinedError → 归为 cancelled
```

来源：`dsh-tool-cordis/lib/types/api-catalog.js:4841-4879`（= `dsh-authorization/src/types.ts` 的公开投影）；行为见 `dsh-authorization/lib/index.js:138-250`。`begin` 的返回值只保证「本次 attempt 期间观察到 record 被提交」（`:240-249`），不保证 token 能通。

## 7. 明确做不到 / 必须人肉

- 必须有一个**真实的 ChatGPT Plus/Pro 订阅账号**并在浏览器里完成一次授权（或 device code 到 `https://auth.openai.com/codex/device` 输入码）。
- 必须在 **有浏览器的环境**完成（或接受粘贴 redirect URL）；桌面版主进程不替你做这件事。
- 本版本**没有任何 shipped UI/CLI** 能对 pi-ai provider 发起登录；不做插件（或不做手工写 record）就只能到此为止。
- 手工写 record 需要一条非过期 access token 且 JWT 里带 `chatgpt_account_id`（codex API 用它填 `chatgpt-account-id` 头，`pi-ai/dist/api/openai-codex-responses.js:1272-1296`），否则 `toAuth` 之后请求必失败。

---

## 8. 2026-11-02 端到端实测：两条会让人误判成「插件坏了」的事实

插件装好、面板出现、凭据显示「已保存」之后，一次真实对话仍然报 **「处理失败 / Your authentication token has expired」**。逐层排查后是两个独立原因叠在一起，两条都不是推理，是量出来的。

### 8.1 `exp` 没过期 ≠ token 还能用

| 观察 | 数值 |
|---|---|
| 存进 `.credentials.yaml` 的 access token `exp` | 2026-11-09（还剩 6.85 天） |
| 同一 token 打 `api.openai.com/v1/me` | **401** |
| 同一 token 打 `chatgpt.com/backend-api/codex/responses` | **401** |
| 用配套 refresh token 换新 token | **200**，新 token 打后端 **200 + 正常出字** |

结论：服务端会**提前吊销** access token，`exp` 只是名义寿命。所以「凭据已配置」和「真的能用」是两个事实，只有**刷新**或**真实请求**能区分。

推论（已落在插件里）：桥接时必须**先刷新再存**；`gpt_status` 默认附带一次真实探测；401 时自动刷新并重试一次。

### 8.2 直连不通，且 Node 的 fetch 默认忽略代理

| 观察 | 结果 |
|---|---|
| 直连 `auth.openai.com` / `chatgpt.com` | **超时** |
| 走 `127.0.0.1:7897`（本机 Clash） | 正常响应 |
| Windows 系统代理 | `ProxyEnable: 0`（**关着**），没有进程继承 |
| Node 全局 `fetch` 是否读 `HTTPS_PROXY` | **默认不读**，除非 `NODE_USE_ENV_PROXY=1` |

关键机制：pi-ai 的 SSE 路径是 `(options?.fetch ?? globalThis.fetch)(...)`（`openai-codex-responses.js:267`），而 shipped 的 `dsh-llm-pi-ai` **不传 `options.fetch`** —— 所以所有模型请求都落在 Node 的全局 fetch 上。插件走 per-request dispatcher 只能救它自己那两次调用，**救不了模型路径**，那正好会表现为「状态页好看、一聊天就失败」。

还试过 `undici.ProxyAgent`：**不可用**——`undici` 在这个应用里没有作为包安装（Node 内部有，但 `require('undici')` 从 app 和 profile 都 `MODULE_NOT_FOUND`）。

最终做法：插件在 `apply()` 里设 `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY/HTTP_PROXY`，实测进程内 fetch 立即生效（无需重启进程），并且真实请求返回 200。

### 8.3 一条副产物

pi-ai 自带的 `resolveHttpProxyUrlForTarget` 只用于 **WebSocket**（`openai-codex-responses.js:740`），SSE 路径不经过它。所以本机锁 `transport: 'sse'` 的同时，也意味着 pi-ai 自己的代理逻辑彻底不参与，必须靠 8.2 的进程级设置。
