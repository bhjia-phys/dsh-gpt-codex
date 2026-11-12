/**
 * GPT (ChatGPT / Codex) adapter — Host half.
 *
 * The desktop 0.2.1-rc.5 build already ships everything needed to *talk* to
 * ChatGPT:
 *
 *   - `@deepseek-ai/dsh-llm-pi-ai` mounts dormant (zero routes) in the base
 *     bundle;
 *   - `@earendil-works/pi-ai` carries the `openai-codex` provider at
 *     `https://chatgpt.com/backend-api` with nine chat models;
 *   - `dsh-llm-pi-ai` registers an OAuth authorization flow for it under the
 *     credential record `llm-pi-ai/openai-codex`, and `UNSERVED_OAUTH` excludes
 *     only `openai`, so that flow is real.
 *
 * What is *missing* is the surface and the route:
 *
 *   1. Nothing ever calls `ctx.authorization.begin()` for that key. Searching
 *      the whole installed app finds exactly one caller —
 *      `dsh-deepseek-account-platform` — for DeepSeek's own account. The Models
 *      page hides the API-key field for a keyless native-auth provider and its
 *      `settings.models.sign-in` seat is taken by the DeepSeek account dialog.
 *   2. `llm-pi-ai` has no `openai-codex` route, so even a stored credential
 *      would serve no model.
 *
 * This plugin supplies both and nothing else. It never re-implements token
 * exchange, refresh, or the backend protocol: it writes the record shape
 * `dsh-llm-pi-ai` already reads and adds the provider route through the settings
 * seam, then defers to the shipped adapter for every request.
 *
 * Why the route goes through settings and not this bundle's patch layer: a
 * Cordis patch replaces a matched entry's *whole* config rather than deep
 * merging it, and the profile's own `cordis.patch.yml` already sets
 * `llm-pi-ai`'s providers. A bundle-level patch would therefore be replaced at
 * the profile layer. `ctx.settings.mutate()` is the same write path the Models
 * page uses, and it edits the profile override that actually wins.
 */

import { existsSync, promises as fsp } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { installStreamRepair, resolveRepairEndpoints } from './stream-repair.js';

/** Credential-record scope `dsh-llm-pi-ai` reads and writes. */
const RECORD_SCOPE = 'llm-pi-ai';

/** pi-ai provider id backing ChatGPT subscription traffic. */
const PROVIDER = 'openai-codex';

/** Profile entry id / settings namespace that owns the provider routes. */
const SETTINGS_NS = 'llm-pi-ai';

const API_PREFIX = '/gpt-codex';

/** The credential seam's grammar is a lowercase hyphenated `<scope>/<id>`. */
const RECORD_KEY = `${RECORD_SCOPE}/${PROVIDER}`;

/** pi-ai reads the ChatGPT account id from this namespaced JWT claim. */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';

/** Where the Codex CLI keeps its own ChatGPT login. */
function codexAuthFile() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

/**
 * Decode a JWT payload without verifying it.
 *
 * This is not an authentication decision: the token is already the user's, and
 * chatgpt.com verifies its signature on every request. We read it for the two
 * facts the stored record must carry — the ChatGPT account id and the expiry —
 * which is exactly what pi-ai's own `credentialsFromToken` does.
 */
function decodeJwtPayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return undefined;
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Keep untrusted JWT/refresh timestamps finite before they enter JSON records. */
function secondsToMs(seconds) {
  if (typeof seconds !== 'number') return undefined;
  const milliseconds = seconds * 1000;
  return Number.isFinite(milliseconds) ? milliseconds || 0 : undefined;
}

function accountIdFromAccessToken(accessToken) {
  const auth = decodeJwtPayload(accessToken)?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

/**
 * Translate `~/.codex/auth.json` into the record `dsh-llm-pi-ai` stores for an
 * OAuth grant.
 *
 * pi-ai's credential shape is `{ type: 'oauth', access, refresh, expires,
 * accountId }`; `dsh-llm-pi-ai` wraps it as `{ kind: 'grant', payload }` (see
 * `toRecord`). Writing that shape is how the shipped adapter starts serving the
 * subscription without any token exchange of our own.
 *
 * @returns `{ record, facts }`, or `{ error }` when the file holds no usable
 *   ChatGPT login.
 */
function recordFromCodexAuth(auth) {
  if (!auth || typeof auth !== 'object') return { error: 'auth.json 不是一个对象' };
  const mode = String(auth.auth_mode ?? '');
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== 'object') {
    return {
      error:
        mode === 'apikey'
          ? 'Codex CLI 当前用的是 API key 登录，不是 ChatGPT 订阅，没有可复用的 OAuth 凭据'
          : 'Codex CLI 的登录文件里没有 OAuth token',
    };
  }
  const access = String(tokens.access_token ?? '');
  const refresh = String(tokens.refresh_token ?? '');
  if (access === '' || refresh === '') return { error: 'Codex CLI 的登录缺少 access 或 refresh token' };

  const payload = decodeJwtPayload(access);
  const accountId = accountIdFromAccessToken(access) ?? (typeof tokens.account_id === 'string' ? tokens.account_id : undefined);
  if (accountId === undefined) return { error: '无法从 access token 里读出厂 ChatGPT 账号 id' };

  const expires = secondsToMs(payload?.exp) ?? Date.now();
  const planType = payload?.[JWT_CLAIM_PATH]?.chatgpt_plan_type;

  return {
    record: { kind: 'grant', payload: { type: 'oauth', access, refresh, expires, accountId } },
    facts: { accountId, expires, ...(typeof planType === 'string' ? { planType } : {}) },
  };
}

/**
 * The OAuth client id and token endpoint pi-ai's Codex flow uses.
 *
 * These are pi-ai's own public constants (`openai-codex.js:18-21`), not a secret:
 * they identify the desktop app to auth.openai.com the same way the Codex CLI
 * does. Restating them here is what lets this plugin refresh a token without
 * importing pi-ai's private module.
 */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/**
 * Reachability of `auth.openai.com` and `chatgpt.com` is not a given.
 *
 * Measured on this machine: both hosts time out on a direct connection and answer
 * normally through the local Clash proxy on 127.0.0.1:7897 — while the Windows
 * *system* proxy switch is off, so nothing inherited it. Node's global `fetch`
 * ignores `HTTP(S)_PROXY` unless `NODE_USE_ENV_PROXY=1` is set at process start,
 * which an already-running desktop app cannot acquire retroactively.
 *
 * The plugin resolves a proxy URL for the global dispatcher. Explicit plugin
 * configuration takes precedence over the process environment; otherwise
 * requests connect directly.
 *
 * @param configured - the plugin's own `proxy` config value, '' for unset.
 * @returns a proxy URL, or undefined to connect directly.
 */
function resolveProxyUrl(configured) {
  const value = String(configured || '').trim();
  if (value !== '') return value;
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  // Nothing configured: leave it to the caller. Probing a guessed local port
  // would make every request pay for a connection attempt to nothing.
  return undefined;
}

/**
 * Configure the dispatcher used by pi-ai's global fetch, including when another
 * plugin has already initialized it. Changing NODE_USE_ENV_PROXY at runtime
 * alone does not rebuild that dispatcher. Requires Node >= 24.14.
 *
 * @returns A disposer restoring the previous agents and dispatcher, or undefined
 *   when no proxy was requested. The process environment is left intact.
 */
function installProcessProxy(proxyUrl) {
  if (proxyUrl === undefined) return undefined;
  if (typeof http.setGlobalProxyFromEnv !== 'function') {
    throw new Error('GPT 代理需要 Node.js 24.14 或更新版本；请更新 DeepSeek Harness 桌面版。');
  }
  const bypass = process.env.no_proxy ?? process.env.NO_PROXY ?? '';
  return http.setGlobalProxyFromEnv({
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    no_proxy: [bypass, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(','),
  });
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * Why this exists at all: an access token's `exp` claim is *not* a reliable
 * signal that the server still accepts it. Measured on 2026-11-02, a token with
 * 6.85 days left on `exp` returned 401 from both `api.openai.com/v1/me` and the
 * Codex backend, while the matching refresh token exchanged successfully and the
 * new token worked. So "not expired" and "still authorized" are different facts,
 * and only a refresh (or a real request) tells them apart. Bridging must
 * therefore be willing to refresh up front rather than trust `exp`.
 *
 * @returns `{ access, refresh, expires, accountId, planType }`, or `{ error }`.
 */
async function refreshGrant(refreshToken, signal, proxyUrl) {
  let response;
  try {
    response = await fetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted === true) return { error: '刷新被取消' };
    return {
      error: `刷新请求失败：${error && error.message ? error.message : String(error)}${
        proxyUrl === undefined ? '（如果这里直连不上，请在插件配置里设 proxy，例如 http://127.0.0.1:7897）' : `（代理 ${proxyUrl}）`
      }`,
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // 400/401 here means the refresh token itself is dead: the user must sign in
    // again, and saying so is more useful than echoing the endpoint's error body.
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { error: `refresh token 已失效（HTTP ${response.status}），需要重新登录`, dead: true };
    }
    return { error: `刷新失败（HTTP ${response.status}）${text ? `：${text.slice(0, 200)}` : ''}` };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { error: '刷新响应不是 JSON' };
  }
  const access = typeof body?.access_token === 'string' ? body.access_token : '';
  const nextRefresh = typeof body?.refresh_token === 'string' ? body.refresh_token : refreshToken;
  if (access === '') return { error: '刷新响应里没有 access_token' };

  const payload = decodeJwtPayload(access);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (typeof accountId !== 'string' || accountId === '') return { error: '刷新后的 token 里没有 ChatGPT 账号 id' };
  const now = Date.now();
  const duration = secondsToMs(body?.expires_in);
  const refreshedExpiry = duration === undefined ? undefined : now + duration;
  const expires = Number.isFinite(refreshedExpiry) ? refreshedExpiry : secondsToMs(payload?.exp) ?? now;
  const planType = payload?.[JWT_CLAIM_PATH]?.chatgpt_plan_type;

  return {
    access,
    refresh: nextRefresh,
    expires,
    accountId,
    ...(typeof planType === 'string' ? { planType } : {}),
  };
}

/** The Codex backend and the model a probe asks for. */
const CODEX_BACKEND = 'https://chatgpt.com/backend-api/codex/responses';
const PROBE_MODEL = 'gpt-6.1-sol';

/**
 * Ask the Codex backend for one trivial completion, to learn whether the stored
 * token is actually accepted.
 *
 * Nothing else answers that question. A stored record can be well-formed, its
 * `exp` can be days away, and the backend can still answer 401 — which is exactly
 * what happened here on 2026-11-02. A probe costs one tiny request and turns
 * "configured" into "working".
 *
 * The headers mirror pi-ai's `buildSSEHeaders`
 * (`openai-codex-responses.js:1299-1309`) because the backend distinguishes
 * clients by them; a request without `OpenAI-Beta` and `accept: text/event-stream`
 * is rejected even when the token is fine.
 *
 * @returns `{ ok, status, detail, planType?, code? }`.
 */
async function probeBackend(accessToken, accountId, signal, proxyUrl) {
  const sessionId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let response;
  try {
    response = await fetch(CODEX_BACKEND, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'chatgpt-account-id': accountId,
        originator: 'pi',
        'OpenAI-Beta': 'responses=experimental',
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'session-id': sessionId,
        'x-client-request-id': sessionId,
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        instructions: 'You are a helpful assistant.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: OK' }] }],
        stream: true,
        store: false,
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted === true) return { ok: false, code: 'ABORTED', detail: '探测被取消' };
    return {
      ok: false,
      code: 'NETWORK',
      detail: `无法连接 Codex 后端：${error && error.message ? error.message : String(error)}${
        proxyUrl === undefined ? '（如果这里直连不上，请在插件配置里设 proxy）' : `（代理 ${proxyUrl}）`
      }`,
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      status: response.status,
      code: response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
      detail: `Codex 后端返回 HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`,
    };
  }

  // Read only enough of the stream to see a delta or a failure; the probe never
  // needs the whole response.
  let seen = '';
  try {
    const reader = response.body?.getReader?.();
    if (reader !== undefined) {
      const decoder = new TextDecoder();
      let budget = 40;
      while (budget-- > 0) {
        const { done, value } = await reader.read();
        if (done === true) break;
        seen += decoder.decode(value, { stream: true });
        if (seen.includes('response.output_text.delta') || seen.includes('response.completed') || seen.includes('response.failed')) break;
      }
      await reader.cancel().catch(() => void 0);
    }
  } catch (error) {
    if (signal?.aborted === true) return { ok: false, code: 'ABORTED', detail: '探测被取消' };
    return { ok: false, code: 'STREAM', detail: `读取响应失败：${error && error.message ? error.message : String(error)}` };
  }

  if (seen.includes('response.output_text.delta') || seen.includes('response.completed')) {
    return { ok: true, status: response.status, detail: `Codex 后端接受了这次请求（模型 ${PROBE_MODEL}）` };
  }
  if (seen.includes('response.failed')) {
    const match = seen.match(/"message"\s*:\s*"([^"]{0,300})"/);
    return { ok: false, status: response.status, code: 'FAILED', detail: `请求被拒绝：${match ? match[1] : '未说明原因'}` };
  }
  return { ok: false, status: response.status, code: 'EMPTY', detail: '后端返回了空响应' };
}

/** The record's shape plus only the fields that are safe to show. */
function describeRecord(record) {
  if (record === undefined) return { configured: false };
  if (record.kind === 'api-key') return { configured: true, kind: 'api-key' };
  const payload = record.payload ?? {};
  const expires = typeof payload.expires === 'number' && Number.isFinite(payload.expires) ? payload.expires || 0 : undefined;
  return {
    configured: true,
    kind: 'grant',
    ...(typeof payload.type === 'string' ? { type: payload.type } : {}),
    ...(typeof payload.accountId === 'string' ? { accountId: payload.accountId } : {}),
    ...(expires === undefined ? {} : { expires, expired: expires <= Date.now() }),
    hasRefresh: typeof payload.refresh === 'string' && payload.refresh.length > 0,
  };
}

/**
 * Hard requirement: the panel talks to this plugin over its own exact HTTP
 * routes. `tools`, `credentials`, `authorization` and `settings` are read
 * through `ctx.inject`/`ctx.get` so a composition that lacks one still loads.
 */
export const inject = ['webServer'];

export function apply(ctx, rawConfig) {
  const settings = {
    codexAuthPath: rawConfig?.codexAuthPath ? String(rawConfig.codexAuthPath) : '',
    proxy: resolveProxyUrl(rawConfig?.proxy),
    autoEnableRoute: rawConfig?.autoEnableRoute !== false,
    // Extra stream endpoints on top of the Codex backend, for relays that
    // re-serve `openai-codex` from a different base URL.
    endpoints: Array.isArray(rawConfig?.endpoints) ? rawConfig.endpoints : [],
    // Retry `MALFORMED_RESPONSE` on the route this plugin owns: the repair above
    // fixes a reused slot, but a genuinely corrupt argument string can only be
    // recovered by asking the model again.
    retryMalformed: rawConfig?.retryMalformedResponses !== false,
  };

  const authFilePath = () => settings.codexAuthPath || codexAuthFile();
  const credentials = () => ctx.get('credentials');
  const settingsService = () => ctx.get('settings');

  /** Counters for {@link installStreamRepair}; read by `GET /gpt-codex/stream-repair`. */
  const streamRepairStats = { responses: 0, repairedEvents: 0 };
  const STREAM_REPAIR_VERSION = '0.2.0';

  // ------------------------------------------------------------ provider route ---

  /**
   * Make sure `llm-pi-ai` serves the `openai-codex` route.
   *
   * The route is catalog-backed, so it needs no `models` list: `resolveRouteModels`
   * falls back to the installed catalog, and a profile that names no `apiKeyEnv`
   * authenticates through pi-ai's own credential store — where
   * `llm-pi-ai/openai-codex` lives. The one field this plugin does set is
   * `transport: 'sse'`.
   *
   * Why SSE: pi-ai's Codex WebSocket cache keeps sockets and their idle timers in
   * a module-level map, and nothing in this shipped build calls
   * `closeOpenAICodexWebSocketSessions` — `cleanupSessionResources` has no caller
   * anywhere in the installed app. A finished WebSocket turn therefore keeps the
   * event loop alive, which in a desktop app reads as "answered but never
   * settled". The upstream AITP fork hit the same thing and settled on SSE as its
   * tested default; `auto` may select WebSocket, so it inherits the leak. This is
   * a transport choice only: `api` stays whatever the catalog declares.
   *
   * @returns `{ changed, reason }`; never throws, because a missing settings
   *   service must not break sign-in.
   */
  const ROUTE_PROFILE = { transport: 'sse' };

  /**
   * Codes the shipped default retry policy retries.
   *
   * `dsh-llm` retries EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT and TRANSPORT,
   * and deliberately leaves `MALFORMED_RESPONSE` out (being a `retryChoice` does
   * not add it to the default set). A reused tool-call slot arrives as exactly
   * that code, so without this the whole turn stops on its first attempt — which
   * is what the bug report shows: one bad response, then nothing.
   */
  const DEFAULT_RETRY_CODES = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'];

  /** The route profile this plugin recommends, given its configuration. */
  const routeProfile = () => {
    if (!settings.retryMalformed) return { ...ROUTE_PROFILE };
    return {
      ...ROUTE_PROFILE,
      retryPolicy: {
        mode: 'normal',
        maxRetries: 2,
        retryableCodes: [...DEFAULT_RETRY_CODES, 'MALFORMED_RESPONSE'],
      },
    };
  };

  /** Order-insensitive JSON image, for comparing a stored profile with a target. */
  const stableImage = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableImage).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableImage(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };

  /** Whether an existing profile is exactly the shape this plugin recommends. */
  const sameProfile = (current) => {
    if (current === null || typeof current !== 'object') return false;
    return stableImage(current) === stableImage(routeProfile());
  };

  /**
   * Whether a stored profile is the shape an earlier version of this plugin
   * wrote, and nothing else.
   *
   * That is indistinguishable from something the user typed, but it is only
   * `transport: 'sse'` — the recommended transport — so adding the retry policy
   * cannot contradict a deliberate choice. Anything with another field, another
   * transport, or a policy of its own stays untouched.
   */
  const isLegacyOwnProfile = (current) => stableImage(current) === stableImage(ROUTE_PROFILE);

  const ensureRoute = async () => {
    const service = settingsService();
    if (service === void 0) return { changed: false, reason: 'no-settings-service' };
    let descriptor;
    try {
      descriptor = service.describe().find((row) => row.ns === SETTINGS_NS);
    } catch (error) {
      return { changed: false, reason: `describe failed: ${error && error.message ? error.message : String(error)}` };
    }
    if (descriptor === void 0) return { changed: false, reason: 'no-llm-pi-ai-entry' };
    const providers = descriptor.value?.providers;
    if (providers && Object.hasOwn(providers, PROVIDER)) {
      const current = providers[PROVIDER];
      if (sameProfile(current)) return { changed: false, reason: 'already-configured' };
      // A route an earlier version of this plugin wrote is upgraded in place;
      // anything a user tuned — another transport, a pinned model list, their own
      // retry policy — always wins.
      if (!settings.retryMalformed || !isLegacyOwnProfile(current)) {
        return { changed: false, reason: 'already-configured-differently' };
      }
      try {
        await service.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', PROVIDER], value: routeProfile() }], descriptor.revision);
        return { changed: true, reason: 'upgraded' };
      } catch (error) {
        return { changed: false, reason: `mutate failed: ${error && error.message ? error.message : String(error)}` };
      }
    }
    try {
      await service.mutate(SETTINGS_NS, [{ op: 'set', path: ['providers', PROVIDER], value: routeProfile() }], descriptor.revision);
      return { changed: true, reason: 'added' };
    } catch (error) {
      return { changed: false, reason: `mutate failed: ${error && error.message ? error.message : String(error)}` };
    }
  };

  // ---------------------------------------------------------------- status ---

  const readStatus = async () => {
    const store = credentials();
    if (store === void 0) {
      return {
        ok: false,
        reason: 'no-credential-store',
        message: '此组合没有挂载凭据服务（dsh-credentials-local），登录结果无处保存。',
      };
    }
    const record = await store.readRecord(RECORD_KEY);
    const file = authFilePath();
    let codexCli = { path: file, present: false };
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
        const bridged = recordFromCodexAuth(parsed);
        codexCli = {
          path: file,
          present: true,
          // Tool outputs cross a lossless-JSON boundary without HTTP's implicit
          // stringify cleanup: unavailable facts must be absent, not undefined.
          ...(typeof parsed.auth_mode === 'string' ? { authMode: parsed.auth_mode } : {}),
          bridgeable: bridged.record !== undefined,
          ...(bridged.error === undefined ? {} : { bridgeError: bridged.error }),
          ...(bridged.facts ?? {}),
        };
      } catch (error) {
        codexCli = { path: file, present: true, error: error && error.message ? error.message : String(error) };
      }
    }

    let route = { configured: false };
    const service = settingsService();
    if (service !== void 0) {
      try {
        const descriptor = service.describe().find((row) => row.ns === SETTINGS_NS);
        const providers = descriptor?.value?.providers;
        const profile = providers?.[PROVIDER];
        route = {
          configured: Boolean(providers && Object.hasOwn(providers, PROVIDER)),
          // Whether this route will actually recover from the malformed
          // tool-argument response a reused stream slot produces.
          retriesMalformed: profile?.retryPolicy?.retryableCodes?.includes?.('MALFORMED_RESPONSE') === true,
        };
      } catch {
        route = { configured: false, error: 'cannot read settings' };
      }
    }

    const authorization = ctx.get('authorization');
    return {
      ok: true,
      provider: PROVIDER,
      recordKey: RECORD_KEY,
      credential: describeRecord(record),
      codexCli,
      route,
      flowAvailable: authorization?.describe?.(RECORD_KEY) !== undefined,
    };
  };

  /**
   * Status plus a live backend probe.
   *
   * Separate from {@link readStatus} because it costs a network round trip: the
   * page calls it on demand, and the tools call it when the answer matters.
   */
  const verifyStatus = async (signal) => {
    const status = await readStatus();
    if (status.ok !== true) return status;
    const store = credentials();
    const record = await store.readRecord(RECORD_KEY);
    if (record === undefined || record.kind !== 'grant') {
      return { ...status, probe: { ok: false, code: 'NO_CREDENTIAL', detail: '还没有保存 ChatGPT 凭据。' } };
    }
    const access = record.payload?.access;
    const accountId = record.payload?.accountId;
    if (typeof access !== 'string' || typeof accountId !== 'string') {
      return { ...status, probe: { ok: false, code: 'BAD_RECORD', detail: '凭据记录缺少 access token 或账号 id。' } };
    }

    let probe = await probeBackend(access, accountId, signal, settings.proxy);

    // A 401 with a still-valid refresh token is recoverable: refresh once and
    // retry, which is exactly the case measured on this machine.
    if (probe.ok !== true && probe.code === 'UNAUTHORIZED') {
      const refresh = record.payload?.refresh;
      if (typeof refresh === 'string' && refresh !== '') {
        const refreshed = await refreshGrant(refresh, signal, settings.proxy);
        if (refreshed.error === undefined) {
          await commitRecord({
            kind: 'grant',
            payload: {
              type: 'oauth',
              access: refreshed.access,
              refresh: refreshed.refresh,
              expires: refreshed.expires,
              accountId: refreshed.accountId,
            },
          });
          const retried = await probeBackend(refreshed.access, refreshed.accountId, signal, settings.proxy);
          probe = { ...retried, recoveredBy: 'refresh' };
          return { ...(await readStatus()), probe };
        }
        probe = { ...probe, refreshError: refreshed.error };
      }
    }
    return { ...status, probe };
  };

  /** The seam's only write path; this is also what the authorization seam watches. */
  const commitRecord = async (record) => {
    const store = credentials();
    if (store === void 0) throw new Error('没有挂载凭据服务（dsh-credentials-local），无法保存登录结果。');
    await store.modifyRecord(RECORD_KEY, async () => record);
  };

  const seedFromCodexCli = async () => {
    const file = authFilePath();
    if (!existsSync(file)) {
      throw new Error(
        `未找到 Codex CLI 的登录文件：${file}。请先在该机器上完成一次 Codex CLI 的 ChatGPT 登录，或改用浏览器登录。`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(`无法解析 ${file}：${error && error.message ? error.message : String(error)}`);
    }
    const bridged = recordFromCodexAuth(parsed);
    if (bridged.record === undefined) throw new Error(`无法复用 Codex CLI 登录：${bridged.error}`);

    // An access token whose `exp` is still in the future can already be dead
    // server-side (measured), so exchange the refresh token first and store the
    // fresh pair. Falling back to the file's own token when the refresh is
    // unavailable keeps the bridge useful offline; the status page reports which
    // path was taken.
    const refreshed = await refreshGrant(bridged.record.payload.refresh, undefined, settings.proxy);
    const record =
      refreshed.error === undefined
        ? {
            kind: 'grant',
            payload: {
              type: 'oauth',
              access: refreshed.access,
              refresh: refreshed.refresh,
              expires: refreshed.expires,
              accountId: refreshed.accountId,
            },
          }
        : bridged.record;

    await commitRecord(record);
    const route = await ensureRoute();
    return {
      ...(refreshed.error === undefined
        ? {
            accountId: refreshed.accountId,
            expires: refreshed.expires,
            ...(refreshed.planType === undefined ? {} : { planType: refreshed.planType }),
            tokenSource: 'refreshed',
          }
        : { ...bridged.facts, tokenSource: 'codex-cli-file', refreshWarning: refreshed.error }),
      route,
    };
  };

  /**
   * Refresh the stored grant in place.
   *
   * pi-ai also refreshes on its own (inside the credential store's `modify`), but
   * only once it decides a request needs it. Offering an explicit refresh lets a
   * user recover from a token the server revoked early without waiting for a
   * failed model call, and lets this plugin repair what it bridged.
   */
  const refreshStoredGrant = async () => {
    const store = credentials();
    if (store === void 0) throw new Error('没有挂载凭据服务。');
    const current = await store.readRecord(RECORD_KEY);
    if (current === undefined || current.kind !== 'grant') throw new Error('没有可刷新的 ChatGPT 授权记录。');
    const refresh = current.payload?.refresh;
    if (typeof refresh !== 'string' || refresh === '') throw new Error('这条授权记录没有 refresh token，需要重新登录。');
    const refreshed = await refreshGrant(refresh, undefined, settings.proxy);
    if (refreshed.error !== undefined) throw new Error(refreshed.error);
    await commitRecord({
      kind: 'grant',
      payload: {
        type: 'oauth',
        access: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
        accountId: refreshed.accountId,
      },
    });
    return {
      accountId: refreshed.accountId,
      expires: refreshed.expires,
      ...(refreshed.planType === undefined ? {} : { planType: refreshed.planType }),
    };
  };

  /**
   * Drive pi-ai's own OAuth flow through the authorization seam.
   *
   * This is the whole of the "official login" path: `dsh-llm-pi-ai` registered
   * the flow, so this plugin contributes only the interaction surface and the
   * fact that somebody finally calls `begin()`.
   *
   * pi-ai asks two things on this route — which login method (browser vs device
   * code), and, when the loopback callback is unreachable, the pasted code.
   * Neither can be answered without a human, so this in-process caller refuses
   * to guess; the client panel supplies a real interaction instead.
   */
  const signInWithBrowser = async (interaction, signal) => {
    const authorization = ctx.get('authorization');
    if (authorization === void 0) throw new Error('此组合没有挂载授权服务（dsh-authorization），无法发起浏览器登录。');
    if (authorization.describe?.(RECORD_KEY) === undefined) {
      throw new Error(`没有为 ${RECORD_KEY} 注册授权流；确认 llm-pi-ai 已加载。`);
    }
    const outcome = await authorization.begin({ key: RECORD_KEY, signal, interaction });
    if (outcome.status === 'authorized') await ensureRoute();
    return outcome;
  };

  // ------------------------------------------------------------------ tools ---

  ctx.inject(['tools'], (toolCtx) => {
    const register = (definition) => {
      try {
        return toolCtx.effect(() => toolCtx.tools.register(definition));
      } catch (error) {
        console.error('[dsh-gpt-codex] tool registration failed:', definition.name, error);
        return undefined;
      }
    };

    register({
      name: 'gpt_status',
      description:
        '查看「GPT / ChatGPT 订阅」接入状态：是否已保存 ChatGPT 凭据、能否复用本机 Codex CLI 的登录、llm-pi-ai 是否已启用 openai-codex 这条 route，'
        + '并用一次真实请求确认 token 是否真的被后端接受（`verify: true`，默认开启；设为 false 只看本地状态、不联网）。'
        + ' 切换模型到 GPT 或排查 GPT 请求失败前调用。',
      parameters: {
        type: 'object',
        properties: {
          verify: { type: 'boolean', description: '是否向 Codex 后端发一次真实小请求来确认可用，默认 true。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => {
          if (value.ok !== true) return [{ type: 'text', text: `GPT 接入不可用：${value.message}` }];
          const c = value.credential ?? {};
          const lines = [
            'GPT / ChatGPT 接入状态',
            `- provider：${value.provider}（凭据记录 ${value.recordKey}）`,
            `- 凭据：${c.configured ? `已保存（${c.type ?? c.kind}${c.expired ? '，按 exp 已过期' : ''}）` : '未保存'}`,
          ];
          if (c.configured && c.accountId) lines.push(`- ChatGPT 账号：${c.accountId}`);
          const cli = value.codexCli ?? {};
          if (cli.present) {
            lines.push(
              `- Codex CLI 登录（${cli.path}）：${
                cli.bridgeable ? `可复用${cli.planType ? ` · 套餐 ${cli.planType}` : ''}` : `不可复用（${cli.bridgeError ?? cli.error ?? '未知原因'}）`
              }`,
            );
          } else {
            lines.push(`- Codex CLI 登录：未找到（${cli.path}）`);
          }
          lines.push(`- openai-codex route：${value.route?.configured ? '已启用' : '未启用（调用 gpt_sign_in 时会自动补上）'}`);
          if (value.route?.configured) {
            // A route without the retry add-on stops the turn on the first
            // malformed tool-call response; say so instead of leaving the user
            // to rediscover it from a failure message.
            lines.push(
              value.route.retriesMalformed === true
                ? '- 流式工具调用修复：已启用（按 id 纠正被复用位置的并行调用；参数无法解析时重试）'
                : '- 流式工具调用修复：部分启用（按 id 纠正位置；参数无法解析时**不会**重试——调用 POST /gpt-codex/route/enable 可补上）',
            );
          }
          lines.push(`- 浏览器 OAuth 流：${value.flowAvailable ? '已注册，可在面板发起' : '未注册'}`);
          const probe = value.probe;
          if (probe !== undefined) {
            lines.push(
              probe.ok === true
                ? `- 真实请求验证：通过 —— ${probe.detail}${probe.recoveredBy === 'refresh' ? '（token 曾被吊销，已用 refresh token 自动换新）' : ''}`
                : `- 真实请求验证：失败 —— ${probe.detail}${probe.refreshError ? `；尝试刷新也失败：${probe.refreshError}` : ''}`,
            );
            if (probe.ok !== true && probe.code === 'UNAUTHORIZED') {
              lines.push('  → access token 被服务端拒绝。refresh token 若已失效，需要重新走一次登录（gpt_sign_in 或面板里的浏览器登录）。');
            }
          } else {
            // Never let "a record exists" read as "it works": the measured 401
            // happens on a token whose exp is days away.
            lines.push('- 真实请求验证：未做（本次只看本地状态）。凭据存在不等于后端接受；要确认可用请调用 gpt_status（不带 verify:false）。');
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args) {
        return args?.verify === false ? readStatus() : verifyStatus();
      },
    });

    register({
      name: 'gpt_sign_in',
      description:
        '配置「GPT / ChatGPT 订阅」登录，并确保 llm-pi-ai 启用了 openai-codex route。默认 mode=codex-cli：把本机 Codex CLI 已有的 ChatGPT 登录取出来写入 Harness 凭据库（不联网、不重开浏览器）。'
        + ' mode=browser 需要由人在桌面面板里完成浏览器授权，不适合在工具里无人值守调用。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['codex-cli', 'browser'],
            description: '登录方式，默认 codex-cli（复用本机 Codex CLI 登录）。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => {
          if (value.ok === true) {
            const routeNote = value.route?.changed
              ? '已自动补上 llm-pi-ai 的 openai-codex route'
              : value.route?.reason === 'already-configured'
                ? 'route 早已存在'
                : `route 未改动（${value.route?.reason ?? 'unknown'}）`;
            return [
              {
                type: 'text',
                text: `已写入 ChatGPT 凭据（来源 ${value.source}${value.planType ? ` · 套餐 ${value.planType}` : ''}）。${routeNote}。现在可以把模型切到 GPT。`,
              },
            ];
          }
          return [{ type: 'text', text: `登录未完成：${value.error}` }];
        },
      },
      async execute(args) {
        const mode = args?.mode === 'browser' ? 'browser' : 'codex-cli';
        try {
          if (mode === 'browser') {
            const outcome = await signInWithBrowser({
              notify: () => void 0,
              prompt: () =>
                Promise.reject(
                  new Error('浏览器登录需要人工交互（选择登录方式 / 粘贴授权码），请在桌面面板里操作，或使用 mode=codex-cli。'),
                ),
            });
            return { ok: outcome.status === 'authorized', provider: PROVIDER, source: 'browser-oauth', status: outcome.status };
          }
          const facts = await seedFromCodexCli();
          return {
            ok: true,
            provider: PROVIDER,
            source: 'codex-cli',
            accountId: facts.accountId,
            expires: facts.expires,
            ...(facts.planType === undefined ? {} : { planType: facts.planType }),
            route: facts.route,
          };
        } catch (error) {
          return { ok: false, provider: PROVIDER, error: typeof error?.message === 'string' ? error.message : String(error) };
        }
      },
    });

    register({
      name: 'gpt_sign_out',
      description: '删除本机保存的 ChatGPT 凭据（只删除 Harness 的记录，不向 OpenAI 撤销授权，也不影响 Codex CLI 自己的登录）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) =>
          value.ok === true
            ? [{ type: 'text', text: '已删除本机保存的 ChatGPT 凭据。' }]
            : [{ type: 'text', text: `登出失败：${value.error}` }],
      },
      async execute() {
        try {
          const store = credentials();
          if (store === void 0) throw new Error('没有挂载凭据服务。');
          await store.deleteRecord(RECORD_KEY);
          return { ok: true };
        } catch (error) {
          return { ok: false, error: typeof error?.message === 'string' ? error.message : String(error) };
        }
      },
    });
  });

  // ------------------------------------------------------------------ routes ---

  const route = (routePath, handler) => {
    try {
      ctx.effect(() =>
        ctx.webServer.register({
          kind: 'exact',
          path: routePath,
          handler: async (req, res) => {
            try {
              await handler(req, res);
            } catch (error) {
              sendJson(res, error && error.statusCode ? error.statusCode : 500, {
                error: { message: error && error.message ? error.message : String(error) },
              });
            }
          },
        }),
      );
    } catch (error) {
      console.error('[dsh-gpt-codex] route registration failed:', routePath, error);
    }
  };

  route(`${API_PREFIX}/status`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'GET only' } });
    sendJson(res, 200, await readStatus());
  });

  route(`${API_PREFIX}/stream-repair`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'GET only' } });
    sendJson(res, 200, {
      ok: true,
      version: STREAM_REPAIR_VERSION,
      endpoints: resolveRepairEndpoints(settings.endpoints).map((endpoint) => ({ url: endpoint.url, dialect: endpoint.dialect })),
      ...streamRepairStats,
    });
  });

  /**
   * Status plus a live probe. `?refresh=1` additionally exchanges the refresh
   * token before probing, which is the recovery path when the server revoked an
   * access token early.
   */
  route(`${API_PREFIX}/verify`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'GET only' } });
    const forceRefresh = typeof req.url === 'string' && req.url.includes('refresh=1');
    if (forceRefresh) {
      try {
        await refreshStoredGrant();
      } catch (error) {
        // A dead refresh token is a real answer, not a crash: report it and let
        // the probe below show the resulting state.
        const message = error && error.message ? error.message : String(error);
        return sendJson(res, 200, { ...(await readStatus()), probe: { ok: false, code: 'REFRESH_FAILED', detail: message } });
      }
    }
    sendJson(res, 200, await verifyStatus());
  });

  route(`${API_PREFIX}/sign-in`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    const body = await readJsonBody(req);
    if (body.mode === 'browser') {
      return sendJson(res, 400, {
        error: {
          message: '浏览器登录需要人工交互（选择登录方式、可能在浏览器里完成授权），请在 Exec 面板的「GPT 登录」里发起，或使用 Codex CLI 桥接。',
        },
      });
    }
    const facts = await seedFromCodexCli();
    sendJson(res, 200, { ok: true, provider: PROVIDER, source: 'codex-cli', ...facts });
  });

  route(`${API_PREFIX}/sign-out`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    const store = credentials();
    if (store === void 0) throw new Error('没有挂载凭据服务。');
    await store.deleteRecord(RECORD_KEY);
    sendJson(res, 200, { ok: true });
  });

  /**
   * Start the real OAuth flow and hand the browser URL back to the panel.
   *
   * The flow is not resumable across a page reload (the seam keeps attempts in
   * the process that started them), so this is deliberately a fire-and-report
   * call: the attempt runs in the Host, the panel shows the URL and the codes the
   * flow reports, and the outcome is polled from `/oauth/state`.
   */
  let browserAttempt = undefined;
  /** The settled view of the last attempt, kept so the panel can show its outcome. */
  let lastSettledView = { phase: 'idle' };

  route(`${API_PREFIX}/oauth/start`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    if (browserAttempt !== undefined) {
      return sendJson(res, 409, {
        error: { message: '已有一次浏览器登录在进行中；先取消它，或稍等它结束。' },
        attempt: browserAttempt.view,
      });
    }

    const attempt = {
      controller: new AbortController(),
      notices: [],
      pending: undefined,
      view: { phase: 'starting', url: undefined, code: undefined, message: undefined },
      done: Promise.resolve(undefined),
    };
    browserAttempt = attempt;
    lastSettledView = { phase: 'idle' };

    const publish = (change) => {
      attempt.view = { ...attempt.view, ...change };
    };

    attempt.done = signInWithBrowser(
      {
        notify: (notice) => {
          attempt.notices.push(notice);
          publish({
            phase: 'waiting',
            url: typeof notice?.url === 'string' ? notice.url : attempt.view.url,
            code: typeof notice?.code === 'string' ? notice.code : attempt.view.code,
            message: typeof notice?.message === 'string' ? notice.message : attempt.view.message,
          });
        },
        prompt: (prompt) => {
          // pi-ai asks: pick a login method, then paste the code if the loopback
          // callback could not be reached. Hand both to the panel and wait.
          return new Promise((resolve, reject) => {
            const settle = {
              resolve: (value) => {
                attempt.pending = undefined;
                resolve(value);
              },
              reject: (error) => {
                attempt.pending = undefined;
                reject(error);
              },
            };
            attempt.pending = { prompt, ...settle };
            publish({
              phase: 'awaiting-input',
              question: {
                kind: typeof prompt?.type === 'string' ? prompt.type : 'text',
                message: typeof prompt?.message === 'string' ? prompt.message : '',
                options: Array.isArray(prompt?.options) ? prompt.options : undefined,
                placeholder: typeof prompt?.placeholder === 'string' ? prompt.placeholder : undefined,
              },
            });
          });
        },
      },
      attempt.controller.signal,
    )
      .then((outcome) => {
        publish({ phase: outcome.status === 'authorized' ? 'authorized' : 'cancelled', question: undefined });
        return outcome;
      })
      .catch((error) => {
        // A user-cancelled attempt is an outcome, not a failure to report loudly.
        const cancelled = attempt.controller.signal.aborted === true;
        publish({
          phase: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? undefined : error && error.message ? error.message : String(error),
          question: undefined,
        });
        return undefined;
      })
      .finally(() => {
        if (browserAttempt === attempt) browserAttempt = undefined;
        lastSettledView = attempt.view;
      });

    // Give the flow a moment to report its first notice (the authorize URL) so a
    // panel that opens right away has something to show.
    await Promise.race([attempt.done, new Promise((resolve) => setTimeout(resolve, 1500))]);
    sendJson(res, 200, { ok: true, attempt: attempt.view });
  });

  route(`${API_PREFIX}/oauth/answer`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    const body = await readJsonBody(req);
    const attempt = browserAttempt;
    if (attempt === undefined || attempt.pending === undefined) {
      return sendJson(res, 409, { error: { message: '当前没有等待回答的授权问题。' } });
    }
    const value = body.value === undefined || body.value === null ? '' : String(body.value);
    attempt.pending.resolve(value);
    attempt.pending = undefined;
    sendJson(res, 200, { ok: true });
  });

  route(`${API_PREFIX}/oauth/cancel`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    if (browserAttempt !== undefined) {
      const authorization = ctx.get('authorization');
      browserAttempt.controller.abort();
      authorization?.cancel?.(RECORD_KEY);
      browserAttempt.pending?.reject(new Error('用户取消了登录'));
      browserAttempt.pending = undefined;
    }
    sendJson(res, 200, { ok: true });
  });

  route(`${API_PREFIX}/oauth/state`, async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: { message: 'GET only' } });
    sendJson(res, 200, { attempt: browserAttempt?.view ?? lastSettledView });
  });

  route(`${API_PREFIX}/route/enable`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only' } });
    sendJson(res, 200, { ok: true, ...(await ensureRoute()) });
  });

  // A stored credential with no route serves nothing; make the common case work
  // without the user having to know that these are two separate facts.
  if (settings.autoEnableRoute) {
    ctx.effect(() => {
      let cancelled = false;
      const run = async () => {
        const store = credentials();
        if (store === void 0) return;
        try {
          const record = await store.readRecord(RECORD_KEY);
          if (cancelled || record === undefined) return;
          await ensureRoute();
        } catch (error) {
          console.warn('[dsh-gpt-codex] could not enable the openai-codex route:', error && error.message ? error.message : error);
        }
      };
      void run();
      return () => {
        cancelled = true;
      };
    }, 'dsh-gpt-codex: enable route when a credential exists');
  }

  if (settings.proxy !== undefined) {
    ctx.effect(() => installProcessProxy(settings.proxy), 'dsh-gpt-codex: proxy for the global fetch');
    console.info('[dsh-gpt-codex] 模型请求的运行时代理已启用');
  } else {
    console.info('[dsh-gpt-codex] 没有配置代理；模型请求将直连 auth.openai.com / chatgpt.com');
  }

  // Installed last, so it wraps whatever `fetch` the proxy setup left behind
  // rather than being replaced by it. pi-ai's model requests go through
  // `globalThis.fetch` with no per-request override, which is why a fetch-level
  // wrapper is the only place this repair can live without forking pi-ai.
  const repairEndpointList = resolveRepairEndpoints(settings.endpoints);
  ctx.effect(
    () => installStreamRepair(globalThis, repairEndpointList, streamRepairStats),
    'dsh-gpt-codex: tool-call identity repair for streamed responses',
  );
  console.info(
    `[dsh-gpt-codex] 流式工具调用修复已启用（${repairEndpointList.length} 个端点，按 id 纠正被复用位置的并行调用）`,
  );
}
