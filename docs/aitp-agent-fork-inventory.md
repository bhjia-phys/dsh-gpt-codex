# AITP-agent 上游「GPT 适配 + ChatGPT 官方登录」实现清单

考古对象：`F:\AI_Workspace\dsh-aitp\_upstream\extracted\AITP-agent-main`（fork 根 `package.json` version = `0.2.1-rc.2`，`_upstream/extracted/AITP-agent-main/package.json:1`）。
对照对象：本机安装的官方桌面版 `0.2.1-rc.5`，`<DSH_INSTALL>\resources\app.asar`（`/dsh/node_modules/...`，下文记作 `app.asar:`）。

阅读方法（供下一个人复现）：
- fork 是解包的 TS 源码，直接读 `.ts`。
- 官方包是 asar，我用 pwsh 读 asar 头 + 索引、按 offset 取出单个文件到内存再读（不落盘），所以下文官方证据的"行号"是该文件自身行号，不是 asar 偏移。
- 判断"官方有没有"用两种手段：读官方同名 bundle 的源码文本，以及统计符号出现次数（0 = 该构建里不存在）。

结论一句话：**官方 0.2.1-rc.5 已经原生具备「GPT 适配 + ChatGPT 官方登录」的全部服务端能力；fork 真正独有的东西是「一个终端交互消费者」+「一整套 Codex 传输层/错误分类/退出的修补」+「压缩与沙箱的几个语义修正」。所以"GPT 适配插件"这个说法要拆开看：登录入口是插件层可以补的洞，传输层和适配器寿命不是。**

---

## A. 官方 0.2.1-rc.5 已原生具备（不需要再实现）

这一节最重要：很多人在 upstream 上重写一遍的东西其实官方都有。

| 能力 | 官方证据（app.asar 内部路径:行） | 说明 |
|---|---|---|
| pi-ai 适配器本体 | `/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1830` | `class PiAiAdapter extends LlmAdapter`，与 fork 同构（快照/`prepareCall`/`streamWithSnapshot`） |
| provider overlay（OAuth-only 路由加 api-key 方法） | 同上 `:862`（`harnessApiKeyAuth`）、`:893`（`routeAuth`）、`:908`（`reuseCatalogProvider`）、`:926`（`buildProvider`） | 与 fork `packages/llm/llm-pi-ai/src/provider.ts:77,131,144,167` 逐行等价 |
| 凭据记录适配层 | 同上 `:2040`（`RECORD_SCOPE = "llm-pi-ai"`）、`:2046`（`recordKeyFor`）、`:2080`（`toPiCredential`）、`:2094`（`toRecord`）、`:2137`（`credentialStoreFrom`）、`:2185`（`authContextFrom`） | 与 fork `src/auth.ts:29,36,74,91,141,203` 等价，含 `jsonImage`（`:2061`）和 `UNSTORABLE_PROVIDER_ID`（`:2158`） |
| 授权 flow 注册（含 openai-codex） | 同上 `:2438-2596`：`:2454` `UNSERVED_OAUTH`、`:2467` `loginMethods`、`:2490` `relay`、`:2530` `restate`、`:2562` `registerPiAiFlows` | 与 fork `src/login.ts:26,40,58,100,131` 等价；`UNSERVED_OAUTH` 只排除 `openai`（因为要 `getDeviceId`），`openai-codex` 可登录 |
| 自动挂载 flow | 同上 `:2915` `registerPiAiFlows(authorized, auth)`，包在 `ctx.inject(["authorization"], ...)`（`:2912` 附近） | 与 fork `src/index.ts:240` 等价：有 authorization 服务就自动注册 |
| `ctx.authorization` 服务（注册/开始/取消/settled） | `/dsh/node_modules/@deepseek-ai/dsh-authorization/lib/index.js:75`（`registerFlow`）、`:117`（`cancel`）、`:138`（`begin`）、`:177`（`authorization/settled`）、`:247`（`NOT_COMMITTED`） | 完整闭合的 seam，含"flow 必须自己 commit，否则拒"的语义 |
| ChatGPT/Codex 的 OAuth 协议实现 | `/dsh/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js:321-345`（`openaiCodexOAuth`：`login` 先发 select 让用户选 browser / device_code）、`:275-314`（浏览器流，起 `localhost:1455/auth/callback` 回调服务器 + 允许手贴回调 URL）、`:263-274`（设备码流）、`:123-141`（refresh） | 也就是说浏览器回调、设备码、PKCE 全在 pi-ai 里，不在 harness 也不在 fork 插件里 |
| openai-codex provider 声明 | `/dsh/node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js:8-21` | `baseUrl: https://chatgpt.com/backend-api`，`auth.oauth = lazyOAuth(openAI Codex OAuth)`，`api = openAICodexResponsesApi` |
| openai-codex 模型目录 | `/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json`（`openai-codex-responses` 下 9 个模型：gpt-5.3-codex-spark / 5.5 / 5.6-luna / 5.6-sol / 5.6-terra / 6-astra / 6-luna / 6-sol / 6.1-sol） | 与 fork 记录"九个 Codex catalog models"一致（`agent/notes/harness-integration.md:19`） |
| 凭据落盘（`.credentials.yaml` + `<owner>/<id>` 记录） | `/dsh/node_modules/@deepseek-ai/dsh-credentials-local/README.md:84-107`；`/dsh/node_modules/@deepseek-ai/dsh-credentials/README.md:63-81` | 记录类型 `api-key` / `grant`，grant payload 逐字保存 |
| 跨进程刷新锁 | `plugins` 侧无差：`auth.ts` 注释即说明 refresh 在 `credentialStore.modify()` 内跑（fork `src/auth.ts:124-131`，官方 `lib/index.js:2137` 同一实现） | 刷新由 pi-ai 触发、由 `credentials-local` 的 writer lock 串行化 |
| pi-ai Codex 传输层 | `/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js:686`（`closeOpenAICodexWebSocketSessions`）、`:651`（`websocketSessionCache`）、`:704`（`registerSessionResourceCleanup`）、`/dsh/node_modules/@earendil-works/pi-ai/dist/session-resources.js:1-22`（`cleanupSessionResources`） | 清理设施存在，但**没有调用方**，见 E3 |

**官方没有的一处（对"能不能直接用"很关键）：**

- 官方 base bundle 的 `llm-pi-ai` 行是空的 dormant 挂载（`/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:128-136` 只有注释，没有 `config.providers`）。fork 在同一位置加了 `providers: { openai: {}, openai-codex: {} }`（fork `packages/bundle/base/cordis.patch.yml:128-137`），这是 fork 独有的一处"默认值"，但用 profile patch 就能表达——本机 desktop profile 正是这么做的（`~/.dsh\profiles\desktop\cordis.patch.yml:66-80` 自己声明了 `opendesign` 路由）。

- 官方 headless profile 默认把凭据与授权**关掉**：`/dsh/node_modules/@deepseek-ai/dsh-headless/cordis.patch.yml:35-43`（`credentials disabled: true`、`authorization disabled: true`、`deepseek-account disabled: true`），官方 README 明确要求用户自己加两行恢复（`/dsh/node_modules/@deepseek-ai/dsh-headless/README.md` 的 `### Credentials` 节）。**这不是缺陷，是 profile 策略。** 桌面版走 `dsh-base + dsh-web-app`，两者都不禁用，所以桌面版没有这个问题。

---

## B. fork 独有的改动（逐条 + 证据）

### B1. 新增终端授权消费者（唯一真正"新增的产品件"）

- 文件：`apps/cli/src/aitp-auth.ts`（161 行，全新文件）。
  - `inject = ['cmdlineArgs', 'authorization', 'credentials']`：`apps/cli/src/aitp-auth.ts:15`
  - `runAuthCommand`：`auth list` 只列 `llm-pi-ai/` 前缀的 flow 与"是否已存凭据"（`:36-41`），`auth login <provider>` 调 `ctx.authorization.begin({...})`（`:43-48`），成功 0 / 取消 130
  - `terminalInteraction`：`node:readline/promises` + 自定义 `PromptOutput extends Writable`（`:54-60`）实现 secret 输入不回显；`historySize: 0`（`:73`）防止密钥进入下一条 prompt 的历史；`SIGINT`/`close` → `controller.abort()`（`:74-75`）
  - `apply`：用 commander 定义 `list` / `login <provider> [--method]`，provider 必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（`:126`），然后等 `ctx.appReady.onReady()` 再开跑（`:141`），`ctx.appExit(code)` 退出（`:143-151`）
- 配套 overlay：`apps/cli/config/aitp-auth.cordis.patch.yml:1-12`（禁 `headless-startup`/`headless-runner`，强制 `credentials`/`authorization` 启用，insert `id: aitp-auth` 一行）
- 启动器接线：`scripts/aitp-agent.ts:87-89`（`aitp-agent auth ...` → `--profile headless --patch aitp-agent.yml --patch aitp-auth.yml <args>`）
- 测试：`apps/cli/tests/aitp-auth.spec.ts`（5 例，含"不打印 grant"）、`apps/cli/tests/aitp-auth.expected.e2e.ts`（真实 profile 起进程；`:16-66` 是一段 Python PTY 脚本，验证"上一条 secret 不能被下一条 prompt 回忆出来"；`:112-133` 断言 `.credentials.yaml` 里 `llm-pi-ai/cloudflare-workers-ai` 的 `kind: api-key` 结构）

### B2. headless 上的凭据/传输默认值

- `apps/cli/config/aitp-agent.cordis.patch.yml:6-15`：`credentials.disabled: false`（抵消 headless 默认），`llm-pi-ai.config.providers.openai-codex.transport: sse`（规避 auto/WebSocket 不退出，见 E3）
- `apps/cli/config/aitp-agent.cordis.patch.yml:2-4`：`system-prompt.personaPrefix` 换成 aitp-agent（非 GPT 链路，列出以免遗漏）

### B3. 适配器寿命与 Codex 会话归属（`src/adapter.ts` 相对官方多出的部分）

官方同文件**没有**这些符号（我在官方 bundle 里统计 `adapter.dispose`/`lifetime`/`codexSessions`/`providerFailure` 出现次数均为 0）：

1. `import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses'`：`src/adapter.ts:29`
2. 字段 `private readonly codexSessions = new Set<string>()` 与 `private readonly lifetime = new AbortController()`：`src/adapter.ts:325-326`
3. `dispose()`：中止 lifetime、对每个记录的 sessionId 调 `closeOpenAICodexWebSocketSessions`、清空集合：`src/adapter.ts:333-337`
4. 记录归属：只在 `model.api === 'openai-codex-responses' && options.sessionId` 时加入集合（`src/adapter.ts:471-473`）；`upstream` 用 `AbortSignal.any([lifetime, consumer, options.signal])`（`:491-493`）
5. 插件卸载时调用：`src/index.ts:234` `ctx.effect(() => () => { adapter.dispose() })`
6. 测试：`tests/codex-responses.spec.ts:150-172`（只关自己用过的非空 sessionId；卸载时中止挂起流）

### B4. Codex 错误分类保真（给既有 `dsh-llm-retry` 用）

- `codexHttpFailure`（读 body 前 16 KiB，取 `error.code/type/message`，丢弃原文）：`src/adapter.ts:81-115`
- `codexRetryDelay`（`retry-after-ms` 优先，`retry-after` 秒或 HTTP-date）：`src/adapter.ts:117-122`
- `codexFailure`（401/403/invalid_api_key→AUTH；402/usage_not_included→QUOTA；429→RATE_LIMIT；context→CONTEXT_WINDOW_EXCEEDED；400/413→INVALID_REQUEST；408→TIMEOUT；5xx→SERVER；否则 PI_AI_ERROR，并带 `providerRetryAfterMs`）：`src/adapter.ts:125-140`
- `codexEventFailure`（只认 Responses SSE/WS 的 `error` / `response.failed` 信封；`previous_response_not_found` 与 `websocket_connection_limit_reached` 交回 SDK）：`src/adapter.ts:147-166`
- 接线：`fetch` 包装记录 HTTP 失败（`:529-534`）、`onProviderStreamEvent` 记录事件级失败（`:535-538`）
- `stream.ts` 增加第 5 参 `providerFailure`：`src/stream.ts:148`、消费点 `:222-236`（保留既有 overflow 检测优先、结构化分类其次、只保留 fallback 类别不保留原文）
- 官方对照：`toStreamChunks(events, contextWindow, callerSignal, requestedModel)` 只有 4 参（app.asar `.../dsh-llm-pi-ai/lib/index.js:1537`），`classifyPiAiError` 仍在（`:1448`），即官方只能靠错误 message 正则猜类别，拿不到 status/retry-after。

### B5. pi-ai 依赖补丁（`patches/@earendil-works__pi-ai@1.1.0.patch`，在 `pnpm-workspace.yaml:108-109` 注册）

三块，全部是 fork 独有（官方 asar 里我逐点核对过）：

1. **去掉 5 个 stream adapter 的 per-delta 重解析**：`anthropic-messages`、`bedrock-converse-stream`、`mistral-conversations`、`openai-completions`、`openai-responses-shared`、`pi-messages` 每收到一个 delta 就 `parseStreamingJson(整段累计 JSON)` 的那一行被删（`patches/@earendil-works__pi-ai@1.1.0.patch:5-73`）。
   官方仍在：`/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:261`、`openai-responses-shared.js:559,610`、`anthropic-messages.js:595`、`bedrock-converse-stream.js:560`、`mistral-conversations.js:571`。O(n²) 后果见 `packages/llm/llm-pi-ai/README.md:268`。
2. **Codex WebSocket 缓存所有权**：
   - `scheduleSessionWebSocketExpiry` 开头加"若缓存里已不是这个 entry 就关掉并返回"，避免退休 entry 留下孤儿 idle timer/socket（`patch:81-86`）
   - `acquireWebSocket` 在 `await connectWebSocket` 之后、`set` 之前加 `if (accountEntries?.has(accountId))` → 保留先到的所有权，本次连接只用一次（`patch:100-104`）
   - 官方对照：`/dsh/.../openai-codex-responses.js:876-950` 完全没有 `has(accountId)` 保护，后到者直接覆盖。
3. **连接建立与取消竞争**：`connectWebSocket` 返回后若 `signal.aborted` 就关掉并抛 `Request was aborted`（`patch:94-97`）；`socket.send` 之前再检查一次 `options?.signal?.aborted`（`patch:112-114`）。
   官方对照：`/dsh/.../openai-codex-responses.js:1196-1214` 的 `try { socket.send(...) }` 前没有任何 abort 检查。

### B6. 压缩（`packages/compaction/compaction-basic`）

官方同包**没有**这些语义（我统计 `isCompactCheckpointSource`、`failedAutomatic`、`nonshrink`、`callBudget` 在官方 `dsh-compaction-basic/lib/index.js` 中出现次数均为 0）：

- 单独一条 checkpoint 不算新素材，不自动再摘要：`src/region.ts:156-163`（`isCompactCheckpointSource` 判断）；官方 `selectCompactableRange` 直接返回 `{start, end}`，无此分支（app.asar `/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:410-433`）
- 失败且历史/header/触发完全未变的自动压缩在服务存活期内不重复付费：`src/index.ts`（"failed automatic attempts on exactly unchanged history"），官方无
- 超大历史按"完整、工具配对平衡的前缀"分批，每批至少吃掉一个未处理节点（`src/index.ts:386-444`），用完下界就可见失败而不是截断/换 provider
- 摘要请求按所选模型容量估算，含 summary prompt + tools + 输出预算（`src/summarizer.ts` + `src/index.ts`）
- 证据：`agent/notes/harness-integration.md:64`、`docs/agent/14-implementation-blueprint.md:135-136`；回归 `tests` 按该节文字

### B7. 沙箱同模式重试（fs / pwsh）

- `packages/fs/tool-fs/src/sandbox.ts:87-93`：**先**比较 `args.sandbox_permissions === standingPolicy.mode` 就直接返回 standing policy（不需要理由），**再** `validateEscalationArgs`。
  官方顺序相反：`approveEscalation` 之前先 `validateEscalationArgs(args.sandbox_permissions, args.justification)`（app.asar `/dsh/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js:1135-1137`）→ 官方"同模式 + 缺理由"仍抛 `sandbox_permissions requires a justification`。
- `packages/shell/tool-pwsh/src/index.ts:107-119`：`validatePwshArgs(args, effectiveMode)` 多一个参数，同模式提前 `return`。
  官方 `validatePwshArgs(args)` 不接 effectiveMode（app.asar `/dsh/node_modules/@deepseek-ai/dsh-tool-pwsh/lib/index.js` 的 `function validatePwshArgs(args)`），同模式 + 缺理由同样抛。
- 官方 bash 已经有这个短路（`/dsh/node_modules/@deepseek-ai/dsh-tool-bash/lib/index.js:239` `if (args.sandbox_permissions !== void 0 && args.sandbox_permissions === effectiveMode) return;`），所以 fork 修的是"fs 与 pwsh 没跟 bash 对齐"。
- `approveEscalation` 本身对同模式是放行的（`packages/sandbox/sandbox/src/escalation.ts:173`；官方 `/dsh/node_modules/@deepseek-ai/dsh-sandbox/lib/index.js` 同一行语义），所以官方的问题只在**校验顺序**。

### B8. 启动器与打包（与 GPT 相关的部分）

- `scripts/aitp-agent.ts:65-76` `aitpEnvironment`：注入 `TSX_TSCONFIG_PATH = <repo>/tsconfig.json`、`DSH_HOME = ~/.aitp-agent`、`DSH_BUNDLED_SKILL_DIR`
- `scripts/aitp-agent.ts:242-246`：`detached: process.platform !== 'win32'`，POSIX 用进程组转发 SIGINT/SIGTERM（`:247-257`）——修"wrapper 先退、子进程留着"
- 其余（品牌 `ui-brand-aitp`、`apps/desktop` 命名、`private` 包注册）与 GPT 无关，不展开

---

## C. 那个「终端认证插件」到底是什么

### C1. 包名 / 目录

**它不是 npm 包，也不是 `packages/` 下的独立包。** 它是一个插在 CLI 应用里的 cordis 插件行：

- 行 id：`aitp-auth`（`apps/cli/config/aitp-auth.cordis.patch.yml:11-12`，`name: '../src/aitp-auth.ts'`）
- 源文件：`apps/cli/src/aitp-auth.ts`
- 归属：`apps/cli`（fork 的 CLI 应用），不是 `packages/` 的工作区包
- 载体：`--profile headless` + 两个 `--patch` overlay（`scripts/aitp-agent.ts:87-89`）

### C2. 依赖的 harness 服务

| 服务 | 来源包 | 用途 | 证据 |
|---|---|---|---|
| `cmdlineArgs` | `@deepseek-ai/dsh-cmdline` | 读 `auth list|login` 子命令 | `apps/cli/src/aitp-auth.ts:7,15` |
| `authorization` | `@deepseek-ai/dsh-authorization` | `list()` / `begin()` | `:8-9,15,37,43` |
| `credentials` | `@deepseek-ai/dsh-credentials` | `describeRecord`（只报"是否已存"，绝不打值） | `:10,38` |
| `appReady` / `appExit` | `@deepseek-ai/dsh-cmdline`（launcher 提供） | 等启动完成再跑；用 launcher 的退出路径收尾 | `:133-135,141,143` |

注意两个细节：一是它**不自己写凭据**——写入者是 pi-ai（flow 内部 commit），凭证落盘归 `credentials-local`（`agent/notes/harness-integration.md:15` 明确"provider code and its credential store continue to own authentication"）；二是它**不 import 任何 pi-ai 类型到产品路径**（只在测试里 import `credentialStoreFrom`，`apps/cli/tests/aitp-auth.spec.ts:11`）。

### C3. 登录交互方式

**是 PTY/终端提示（readline），不是浏览器回调，也不是设备码实现。** 但要分三层看，容易混：

1. **终端消费者这一层**：只做"打印通知 / 提问"。`notify` 把 `message`、`url`、`code` 三样分别打印（`apps/cli/src/aitp-auth.ts:101-105`）；`prompt` 处理 `text` / `secret` / `select` 三种（`:78-99`），`select` 支持输入序号或 option id（`:92`），`secret` 期间静音回显（`:88`）。
2. **pi-ai 的 openai-codex flow 这一层**：先弹 `select` 让用户选 `browser`（默认）或 `device_code`（`/dsh/.../dist/auth/oauth/openai-codex.js:325-332`）。
   - 选 `browser` → 起 `http://localhost:1455/auth/callback` 本地回调服务器，打印授权 URL，然后 `waitForCallbackOrManualInput` 同时等"浏览器回调"和"用户粘贴 code/整条回调 URL"（`:275-314`）；端口被占（常见：Codex CLI 也占 1455）时降级为"只能手贴"，`startOAuthCallbackServer(...).catch(() => undefined)`（`:286`）。
   - 选 `device_code` → `POST /api/accounts/deviceauth/usercode` 拿 user_code，打印设备码页面 URL，然后轮询到授权（`:263-274`、`:172-224`）。
3. **回调这件事本身**：`startOAuthCallbackServer`（`/dsh/.../dist/auth/oauth/callback-server.js:14-146`）是普通 `node:http` 单次回调处理器，校验 `state`、拒重复 claim（409）、成功后返回一张 HTML 页。

所以：**"浏览器回调"是 pi-ai 提供的，"终端"只是把这个过程念出来并收集人输入。** 插件本身不含任何 OAuth 协议代码。

### C4. 能否原样搬成 bundle 插件

**不能原样搬。** 三个硬阻塞，按严重程度：

1. **拿不到命令行。** 桌面版的 host 入口是 `apps/desktop-host`，它调 `runProfile({ profile: 'desktop', patchFiles: [], args: ['--no-open','--host','127.0.0.1','--port','0'] })`，args 是常量（`/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:226-243`）。`cmdlineArgs` 在桌面版里是这 5 个固定词，没有 `auth login` 的位置。CLI 的 `--patch` 更是 launcher 级参数（`apps/cli/src/args.ts:170`），桌面版不开放。
2. **没有 TTY。** `terminalInteraction` 直接写 `process.stdout` / 读 `process.stdin`，`process.stdin.isTTY` 为假时 readline 会走非终端模式（`apps/cli/src/aitp-auth.ts:73`），在 Electron 里等于没有输入。桌面版的 stdout 是 Electron 的日志管道，用户看不到。
3. **`appReady`/`appExit` 语义不同。** 桌面版由 launcher 在 boot 完成后立刻 `commit()`（`apps/cli/src/profile-boot.ts:341-345`），`appExit` 会走 `shutdown.shutdown(code)` 关掉整个应用（`:336`）——一个"登录工具"不该有这种权力。

**可搬的部分**：`AuthorizationInteraction` 那 20 行（`notify` / `prompt` / 取消映射）与 `runAuthCommand` 的 `begin()` 调用是纯 seam 用法，换成任何前端都能用。真正要重写的是"人从哪来"。

---

## D. 凭据落盘：路径 + record key 格式

### D1. 文件路径

- 默认 `$DSH_HOME/.credentials.yaml`；`DSH_HOME` 未设时 `~/.dsh`（`/dsh/node_modules/@deepseek-ai/dsh-credentials-local/README.md:42-47`、`:45`）
- fork 的启动器把 `DSH_HOME` 改到 `~/.aitp-agent`（`scripts/aitp-agent.ts:72`），所以 fork 里落盘在 `~/.aitp-agent/.credentials.yaml`；其 live e2e 断言也用的这个 home（`apps/cli/tests/aitp-auth.expected.e2e.ts:113-133`）
- 本机实测存在 `%USERPROFILE%\.dsh\.credentials.yaml`（19 行；现有 records 只有 `client-connection/browser-session`、`deepseek-account-platform/device`、`deepseek-account-platform/default`，**没有任何 `llm-pi-ai/*`**，也就是这台机器还没做 ChatGPT 登录）
- 权限：POSIX 要求 owner-only，否则拒载（`README.md:115`）；Windows 跳过检查

### D2. record key 格式

`<scope>/<id>`，本链路固定为 **`llm-pi-ai/<provider id>`**：

- `RECORD_SCOPE = 'llm-pi-ai'`、`recordKeyFor(providerId) = credentialKey(RECORD_SCOPE, providerId)`：fork `src/auth.ts:29,36-38`；官方 `lib/index.js:2040,2046-2048`
- 因此 ChatGPT 登录写的是 **`llm-pi-ai/openai-codex`**（不是 `llm-pi-ai/openai`；`openai` 那条走 api-key）
- id 段必须是"小写连字符标识符"，否则记录层拒写（`UNSTORABLE_PROVIDER_ID`，fork `src/auth.ts:163-171`；官方 `lib/index.js:2158`）；flow 注册时也预检（`src/login.ts:143-148`）

### D3. 文档结构（`dsh-credentials-local` README 就是规范）

```yaml
version: 1
refs:                       # 环境变量名 -> 值（apiKeyEnv 引用解析用）
  DEEPSEEK_API_KEY: sk-…
records:                    # <owner>/<id> -> 记录
  llm-pi-ai/openai-codex:
    kind: grant             # grant | api-key
    payload:                # grant 时逐字保存，只有 owner 能解释
      type: oauth
      access: eyJhbGciOi…
      refresh: rft_9f8e7d…
      expires: 1786000000000
  llm-pi-ai/amazon-bedrock:
    kind: api-key
    env: { AWS_PROFILE: prod }
```

（`/dsh/node_modules/@deepseek-ai/dsh-credentials-local/README.md:86-107`；字段守则在 `:109-111`：grant payload 必须能无损 JSON 往返。）

三个实现细节值得记住：

- **grant 的 payload 是不透明的**：`llm-pi-ai` 只做 `jsonImage()` 规整（丢 `undefined`、数组里 `undefined`→`null`，其余原样），不解释 token 格式——fork `src/auth.ts:52-62,99`；官方 `:2061-2090`。这就是"pi-ai 拥有格式、harness 拥有存储"的分工，也是 refresh 字段能跟着轮转的原因。
- **api-key 记录是结构化的**（`key` / `env`），逐字段搬运：`src/auth.ts:76-81,92-98`。
- **store 的 `list()` 只认自己 scope 的记录**：别人的 payload 不按本格式解释（`src/auth.ts:149-162`）。

### D4. 刷新逻辑

- 触发方是 pi-ai（`Models` 内部），不是 harness 也不是插件。
- 刷新发生在 `credentialStore.modify()` 里，所以 `credentials-local` 的 writer lock 必须覆盖一次网络往返，而不是一次本地 rename（fork `src/auth.ts:124-131` 的注释直说此事）。
- 官方与 fork 在这层**完全一致**（实现同一份 `credentialStoreFrom`），没有 fork 增量。
- 未验证项：自然过期的 grant 在真实会话里刷新（`agent/notes/harness-integration.md:54` 明确列为未建立）。

---

## E. 已知缺陷与根因（一句话一条）

### E1. 登录后"凭据服务被禁用"

现象：headless 里登录成功、下一条请求却报无凭据。
根因：headless profile 默认 `credentials` + `authorization` 两行都 `disabled: true`（`/dsh/node_modules/@deepseek-ai/dsh-headless/cordis.patch.yml:35-43`），不是 bug 而是 profile 策略；fork 在 `apps/cli/config/aitp-agent.cordis.patch.yml:6-8` 与 `aitp-auth.cordis.patch.yml:6-9` 各补一次。
证据链：`agent/notes/harness-integration.md:65`、`current.md:343`（"登录后凭据服务仍被默认配置禁用…已修复"）。

### E2. 从仓库外启动无法解析 loader

现象：在仓库外的临时目录用源码启动，loader / tsconfig 找不到，存好的 grant 用不上。
根因：源码启动走 `tsx/esm`，Loader 的 `baseUrl` 与安装锚点按仓库 `package.json` 解析（`apps/cli/src/profile-boot.ts:78`、`:313-323`），cwd 一离开仓库就断。
修法：launcher 显式给 `TSX_TSCONFIG_PATH=<repo>/tsconfig.json`（`scripts/aitp-agent.ts:71` 与 `:237` `register({ tsconfig })`）。
证据：`agent/notes/harness-integration.md:65`。

### E3. auto / WebSocket 不能自然退出（"回答完了但进程不退"）

现象：`transport: auto` 或显式 `websocket` 下任务完成，进程被挂住，多次要 240/180/60/90 秒后强杀。
根因：pi-ai 的 `websocketSessionCache`（`/dsh/.../openai-codex-responses.js:651`）把 socket 连同 idle timer 留在**模块级** Map 里；适配器/插件卸载时没有任何人调 `closeOpenAICodexWebSocketSessions`，Node 事件循环因此不空。
**官方 0.2.1-rc.5 仍然如此**：我逐文件扫了 196 个 pi-ai dist js 与 1045 个 `@deepseek-ai/*` 包 js，`cleanupSessionResources` **只出现在它自己的定义文件里，零调用方**（`/dsh/node_modules/@earendil-works/pi-ai/dist/session-resources.js:1-22` 导出 `registerSessionResourceCleanup` 与 `cleanupSessionResources`；`openai-codex-responses.js:704` 把自己的 `closeOpenAICodexWebSocketSessions` 注册进去，但没有任何 harness 代码触发 cleanup）。
fork 三层修：适配器 `dispose()` 主动关（`src/adapter.ts:333-337`）、补丁里"退休 entry 立刻 close"（`patch:81-86`）、默认降级到 `sse`（`apps/cli/config/aitp-agent.cordis.patch.yml:10-15`）。
证据：`agent/notes/harness-integration.md:66,70,72`、`current.md:343`。

### E4. 缓存所有权被覆盖（并发连接泄漏）

现象：同一 session/account 两个请求并发，插件卸载后仍有一个 socket 未关。
根因：`acquireWebSocket` 在 `await connectWebSocket(...)` 之后才 `accountEntries.set(accountId, entry)`（官方 `/dsh/.../openai-codex-responses.js:876-935`），两个并发调用都能在"查到空缓存 → 连接建立完成"这段窗口里通过，后到者覆盖先到者的 entry；先到者的 socket 从此没有 owner，`closeOpenAICodexWebSocketSessions` 也找不到它。
fork 修：`if (accountEntries?.has(accountId)) return { socket, reused: false, release: () => closeWebSocketSilently(socket) }`（`patch:100-104`），即"第一份所有权保留，本次连接一次性使用"。
证据：`agent/notes/harness-integration.md:66`、`packages/llm/llm-pi-ai/tests/codex-responses.spec.ts:150-161`。

### E5. 连接建立与取消竞争（取消后仍发请求）

现象：`abort()` 在 WebSocket 握手期间到达，握手完成后照样 `send`，请求真的发出去了。
根因：`socket.send(JSON.stringify({ type: 'response.create', ... }))` 之前没有重查 signal（官方 `/dsh/.../openai-codex-responses.js:1196-1214`）。
fork 修：连接返回后查一次（`patch:94-97`）、发送前再查一次（`patch:112-114`）。
证据：`agent/notes/harness-integration.md:66`、`current.md:343`（"两条路径均有修改前失败的测试"）。

### E6. 错误分类在 SDK 层被拍平

现象：HTTP 401/402/429/5xx 与 `response.failed` 的 `code` 全被压成一句字符串，重试插件只能瞎猜，把认证失败当瞬时错误重试。
根因：pi-ai 把异常收敛成 `error.message`（`src/stream.ts:34-41` 的 `XXX(pi-ai upstream)` 注释把机制写清楚了：undici 的 `cause` 链在上游被丢），HTTP status 与 `retry-after` 不进入 harness 视野。
fork 修：请求局部（`fetch` 包装 + `onProviderStreamEvent`）保留有界结构事实，转成 `LlmFailure{code,status,providerRetryAfterMs}` 给既有 `dsh-llm-retry`（B4）。
证据：`agent/notes/harness-integration.md:68`、`packages/llm/llm-pi-ai/tests/codex-retry.spec.ts`（整文件）、`tests/codex-responses.spec.ts:132-148`（不保留原文）。

### E7. 压缩的重复付费 / 不收敛

现象：单独一条 checkpoint 被反复摘要；历史没变时失败的自动压缩反复重付；超大历史整段塞爆或静默截断。
根因：`selectCompactableRange` 没有"单独 checkpoint 不算新素材"的分支，引擎没有"同输入失败记忆"与"整段 tool-balanced 前缀 + 调用上限"的预算（官方 `/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js:410-433` 只有朴素的首尾选择）。
fork 修：B6。
证据：`docs/agent/14-implementation-blueprint.md:135-136`、`agent/notes/harness-integration.md:64`。

### E8. 同模式 escalation 被拒（fs / pwsh 与 bash 不一致）

现象：明明已经在 `workspace-write`，模型再带一次 `sandbox_permissions: workspace-write` + 一句理由，被拒；不带理由更被拒。
根因：官方 `fs.resolvePolicy` 与 `pwsh.validatePwshArgs` 先做"字段配对/非空理由"校验，之后才由 `approveEscalation` 判同模式放行（官方 `/dsh/.../dsh-tool-fs/lib/index.js:1135-1137`、`dsh-tool-pwsh/lib/index.js` 的 `validatePwshArgs(args)` 签名不接 effectiveMode），于是校验顺序把合法的同模式调用挡在门外；bash 早就有短路（`/dsh/.../dsh-tool-bash/lib/index.js:239`）。
fork 修：把短路提到校验之前（`packages/fs/tool-fs/src/sandbox.ts:88-93`、`packages/shell/tool-pwsh/src/index.ts:107-119`）。
证据：`docs/agent/14-implementation-blueprint.md:134`、`agent/notes/harness-integration.md:63`。

### E9. 设备码登录失败（未定级）

现象：设备码流拿到了 user_code，但授权完成前失败，`agent/notes/harness-integration.md:59,81` 记为"underlying cause remains unidentified"。
根因：**未知**。可能面在 pi-ai 的 `pollOpenAICodexDeviceAuth` 错误分类（403/404 当 pending、`slow_down` 有单独分支，`:201-221`），也可能是账号侧对该 client 未开设备授权（`:150-152` 有专门的 404 文案"not enabled for this server"）。**不要当成已修。**

### E10. 上下文容量口径不一致（未修，属外部事实）

`agent/notes/harness-integration.md:48`：静态 pi-ai 目录给 `openai-codex` 272,000，Codex 本机元数据默认有效值 475,000，服务端真实上限未核准。adapter 只是如实暴露 catalog 值。这是策略问题不是 bug。

---

## F. 「不改核心、只写插件」拿不到的部分（这篇的重点判断）

先给判据：**在 0.2.1-rc.5 里，一个插件能做的只有三件事**——(a) 往 `ctx.authorization.registerFlow` 注册 flow；(b) 用 `ctx.credentials` 读写自己的 `<scope>/<id>` 记录；(c) 用 `ctx.llm.registerAdapter(routes, adapter)` 注册一个**完整实现** `LlmAdapter` 的适配器。它**不能**给已挂载的适配器加钩子、加字段、加 `dispose()`，也**不能**改 vendor 里的 pi-ai。

据此分类：

### F1. 插件层能拿到的（可以只写插件）

1. **登录入口（人从哪触发）**——最大的机会点，理由见 F3 第一段与 G2。`authorization` seam 是公开的，`registerFlow` 已经在官方 `llm-pi-ai` 里自动跑（官方 `lib/index.js:2915`），所以 `openai-codex` 的 flow **本来就存在**；缺的只是"有人去 `begin()` 它"。
2. **登录后/登录前的凭据状态展示**——`ctx.credentials.describeRecord('llm-pi-ai/openai-codex')` 就是全部，官方 `dsh-credentials` README 已公开这个契约（`/dsh/node_modules/@deepseek-ai/dsh-credentials/README.md:73-81`）。
3. **给 flow 加一条自己的 provider 路由**（比如自建反代或另一家 OAuth）——`ctx.authorization.registerFlow` + `ctx.credentials.modifyRecord` 足够，不需要碰 pi-ai。
4. **把登录结果暴露给 Web 前端**——用 `ctx.webServer.register({ kind: 'exact'|'prefix', path, handler })`（`/dsh/node_modules/@deepseek-ai/dsh-host-webserver/README.md:59-63`）。本仓库已有的 `@local/aitp-research-desk` 就是这么做的：host 侧 `ctx.webServer.register`（`packages/aitp-research-desk/index.js:1169-1183`），client 侧 `fetch('/aitp-research/api/...')`（`packages/aitp-research-desk/client.js:9`）。**这条路完全不改核心。**

### F2. 插件层拿不到的（必须改核心或改依赖）

| 想要的能力 | 为什么拿不到 | 要改哪里 |
|---|---|---|
| Codex WebSocket 缓存所有权、退休 entry 关闭 | 逻辑在 vendored pi-ai dist 内（`websocketSessionCache` 是模块级 Map） | `patches/@earendil-works__pi-ai@1.1.0.patch` 或换 pi-ai 版本 |
| 连接建立后/发送前的取消检查 | 同上，`socket.send` 在 pi-ai 内部 | 同上 |
| 流式参数 O(n²) 重解析 | 同上，5 个 stream adapter 内部 | 同上 |
| **适配器卸载时关连接** | `PiAiAdapter` 官方版**没有 `dispose()`**、没有 `lifetime`、不记录 `codexSessions`（我在官方 bundle 里统计这些符号均为 0，见 B3）。插件只能拿到 `@earendil-works/pi-ai` 的公开 export（`closeOpenAICodexWebSocketSessions` 确实可 import），但**它无法知道"哪些 sessionId 属于自己"**——`options.sessionId` 是 agent-loop 直接给适配器的，不经过插件 | `dsh-llm-pi-ai`（官方源码），或自己写一个完整 `LlmAdapter` 替换掉它 |
| 卸载时中止在途请求 | 同上，`upstream` 只合并了 `consumer` 与 `options.signal`，没有插件可控的常驻 signal | 同上 |
| Codex HTTP/事件错误分类保留 | `codexHttpFailure` / `codexEventFailure` / `toStreamChunks` 的第 5 参都是适配器内部实现，官方 `toStreamChunks` 只有 4 参（`:1537`） | `dsh-llm-pi-ai` 的 `stream.ts` + `adapter.ts` |
| 压缩的 checkpoint/预算语义 | 在 `dsh-compaction-basic` 内部 | 该包 |
| fs/pwsh 同模式 escalation 的校验顺序 | 在 `dsh-tool-fs` / `dsh-tool-pwsh` 内部 | 那两个包 |
| `transport: auto` 的默认降级 | 可以只在 profile patch 里写 `transport: sse`（**这条是配置，不是代码**）；但"auto 不退出"的根因仍在 F2 前两行 | 配置可绕过，根因不可 |
| 让我们自己的 CLI 子命令（`auth login`）在桌面版可用 | 桌面版 args 是常量 5 个词（F3.1），且 `--patch` 是 launcher 级参数 | 桌面版 host 入口（Electron 侧），或换一个不改 launcher 的入口 |

### F3. 桌面版"点不到登录"的确切缺口（这是本任务最该带走的一条）

三件事连起来看：

1. **服务端全都在。** `openai-codex` 的 flow 在桌面版一启动就注册好了（官方 `llm-pi-ai` 的 `ctx.inject(["authorization"], ...)`，`lib/index.js:2914-2916`），`authorization`（`/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:117-118`）与 `credentials`（同文件 `:125-126`）在 desktop profile 里都是启用状态，`dsh-web-app` 不覆盖这两行。
2. **UI 有一个现成的插槽，但没人往里放东西。** Models 页面在"没有 api-key 就直接编辑"之前会先问插槽：
   `return apiKey ? editor : renderSlot("settings.models.sign-in", { complete, useApiKey }, { fallback: editor })`
   （`/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js:2968`）
   而这个插槽在官方构建里**只有 DeepSeek 自己的 onboarding 对话框注册**（同文件 `:4508-4515`，`id: "deepseek-official"`，`children: { "settings.models.sign-in": { kind: "single", scope: "root" } }`）。
3. **于是 `openai-codex` 在 Models 页是个死胡同。** 该 provider 的 `nativeAuth` 是 `env: []` + `oauth: true`（`/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:2729` 的 `openai-codex` 条目、配 `providerDefaultsOf`），命中 `keylessNativeAuth`（同文件 `:2030`），而 keyless 时 api-key 输入框**整个不渲染**（`:2045`：`keylessNativeAuth ? null : (...key field...)`，实测该分支包住了 key 输入与其提示文案）。插槽没人注册 → 回退到 editor → editor 里没有 key 字段 → 用户既不能登录也不能填 key。
   （这也解释了为什么"官方支持 Codex OAuth"和"用户点不到登录"能同时为真。`UNSERVED_OAUTH` 只排 `openai`，`openai-codex` 是**故意**留成 OAuth-only 的；官方 `lib/index.js:2447-2454` 的注释与 `README.md:253` 的"OpenAI offers no ChatGPT sign-in"说的都是 `openai` 那条，别混。）

**判断：这个缺口是插件层可以补的**——写一个 client 插件注册 `settings.models.sign-in`（scope root, kind single），配一个 host 插件用 `ctx.webServer.register` 暴露 `authorization.describe/list/begin/cancel` 的 HTTP 端点，`begin` 的 `AuthorizationInteraction` 由 host 侧用一个"把 notify/prompt 塞进 SSE 或轮询队列"的实现顶上。**不改核心。** 前提是接受"登录期间要有一个跟随页面的交互通道"，这正是官方 `AuthorizationInteraction` 契约的设计意图（"the interaction travels with the request, not a registry"，`/dsh/node_modules/@deepseek-ai/dsh-authorization/README.md` 的 Design philosophy）。

**但同一个插件拿不到 F2 表里的任何一行**——即"能登进去"和"登进去之后连接不泄漏、错误分类准、取消立刻生效、压缩不重复付费"是两件不同层级的事，后者全在核心/依赖里。

### F4. 一个容易误判的点：`openai` vs `openai-codex`

- `openai`（Responses API，`api.openai.com/v1`）：`auth.apiKey`（`OPENAI_API_KEY`）+ `auth.oauth`（`loginLabel: "Sign in with ChatGPT"`），但 OAuth 必须拿到 `LoginOptions.getDeviceId()` 返回的 UUID，否则 `openai-chatgpt.js:186-192` 直接抛 `Sign in with ChatGPT requires a device ID (UUID) for this installation`。harness 没有"给第三方账号用的安装 ID"，所以 fork 与官方都把 `openai` 放进 `UNSERVED_OAUTH`（fork `src/login.ts:26`；官方 `lib/index.js:2454`），该路由只走 api-key。
  注意**插件也补不上这条**：`openai` 的 flow 已被官方 `llm-pi-ai` 以 `llm-pi-ai/openai` 为 key 注册（只是 methods 里没有 oauth），再注册同 key 会撞 `DUPLICATE_FLOW`（`/dsh/node_modules/@deepseek-ai/dsh-authorization/lib/index.js:77`）；换一个 scope 注册的 flow 写出的记录，`dsh-llm-pi-ai` 又不会去读。**结论：走 `openai-codex`，不要试图复活 `openai` 的 ChatGPT 登录。**
- `openai-codex`（`chatgpt.com/backend-api`，`openai-codex-responses`）：OAuth-only，不需要 deviceId，就是"官方 ChatGPT 登录"。**要接 GPT 订阅，走这条。**

---

## G. 一句话总结给决策用

1. **官方 0.2.1-rc.5 不缺"GPT 适配"，缺"触发登录的入口"。** 适配器、OAuth 协议、凭据存储、flow 注册、UI 插槽全都在；插槽空着。
2. **fork 独有的产品件只有 `apps/cli/src/aitp-auth.ts` 一个文件 + 两个 overlay。** 它是终端原语，桌面版不能原样搬，但它的 seam 用法可以照抄。
3. **fork 真正有价值、且官方仍缺的，是传输层与适配器寿命的修补**（B3/B5 共 5 条），全部落在 pi-ai dist 与 `dsh-llm-pi-ai` 内部——**"只写插件"一条都拿不到**。
4. **如果目标是"桌面版能登 ChatGPT 并稳定用"，最小可行是两层**：插件层补 UI 入口（F3）+ 核心层合入 B3/B5（或换一个带 `dispose` 的适配器版本）。只做前者能登进去，但会继承 E3/E4/E5 的挂起与泄漏。

---

## 未找到 / 未验证（不猜）

- **未找到**任何"官方 0.2.1-rc.5 已把 `authorization` 暴露成 Web Remote"的证据：我扫了全 asar，`authorization.begin` 的调用方只有 `dsh-deepseek-account-platform`（`/dsh/node_modules/@deepseek-ai/dsh-deepseek-account-platform/lib/index.js`），remote 命名空间里没有 `authorization`（`remote.credentials`/`remote.settings`/`remote.account`/`remote.workspace`/`remote.terminal` 有，`remote.authorization` 没有）。**所以前端要登录必须自带通道。**
- **未找到** fork 里除 `aitp-auth.ts` 之外的第二处"授权消费者"；`packages/credentials/authorization` 是 seam 本身，`deepseek-account-platform` 是 DeepSeek 自家账号。
- **未验证**：过期 grant 的自然刷新、设备码失败根因（E9）、Windows 上的 launcher 信号语义（`agent/notes/harness-integration.md:134` 自认"Windows signaling remains untested"）、原生打包应用（`:144`）。
- 本笔记**没有**发起任何真实 OAuth、没有联网登录、没有执行改动状态的脚本；对 `%USERPROFILE%\.dsh\.credentials.yaml` 只统计了 record key 名，没有读取任何值。
