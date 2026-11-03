/**
 * Host-half test: runs index.js apply() against a fake DSH context and drives
 * the real credential bridging, route enabling, tools and HTTP routes.
 *
 * No network, no real OAuth, no writes to the user's real credential store: the
 * credentials and settings services are doubles and the Codex CLI file is a
 * fixture in a temp directory.
 *
 * Run with the same Node as DSH: `node test-host.mjs`.
 */

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gpt-codex-host-'));

/** ------------------------------------------------------------------ fixtures */

/** Build an unsigned JWT whose payload carries the ChatGPT claims pi-ai reads. */
function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

// A fixture account id. The plugin treats it as an opaque string, so any UUID works.
const accountId = '00000000-0000-4000-8000-000000000000';
const expiresAtMs = Date.now() + 7 * 24 * 3600 * 1000;
const accessToken = fakeJwt({
  exp: Math.floor(expiresAtMs / 1000),
  iat: Math.floor(Date.now() / 1000),
  'https://api.openai.com/auth': {
    chatgpt_account_id: accountId,
    chatgpt_plan_type: 'plus',
  },
});

const codexAuthFile = path.join(tmp, 'auth.json');
await fsp.writeFile(
  codexAuthFile,
  JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: fakeJwt({}), access_token: accessToken, refresh_token: 'refresh-token-value', account_id: accountId },
    last_refresh: new Date().toISOString(),
  }),
  'utf8',
);

/** A Codex CLI login that used an API key instead of a subscription. */
const apiKeyOnlyFile = path.join(tmp, 'auth-apikey.json');
await fsp.writeFile(apiKeyOnlyFile, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test', tokens: null }), 'utf8');

/** --------------------------------------------------------------- fake context */

function makeCtx(options = {}) {
  const state = {
    tools: new Map(),
    routes: new Map(),
    records: new Map(),
    settingsWrites: [],
    inflight: new Map(),
    flows: new Map(),
    disposed: 0,
    notices: [],
    promptAnswer: options.promptAnswer ?? 'browser',
  };

  const ctx = {
    effect(callback) {
      const disposer = callback();
      return () => {
        state.disposed += 1;
        if (typeof disposer === 'function') disposer();
      };
    },
    get(name) {
      if (name === 'credentials') {
        return {
          async readRecord(key) {
            return state.records.get(key);
          },
          async modifyRecord(key, mutate) {
            const next = await mutate(state.records.get(key));
            if (next !== undefined) state.records.set(key, next);
            return state.records.get(key);
          },
          async deleteRecord(key) {
            state.records.delete(key);
          },
        };
      }
      if (name === 'settings') {
        return {
          describe() {
            return [
              {
                ns: 'llm-pi-ai',
                revision: state.settingsWrites.length,
                value: { providers: { ...(state.providers ?? {}) } },
                user: { providers: { ...(state.providers ?? {}) } },
              },
            ];
          },
          async mutate(ns, ops, expectedRevision) {
            state.settingsWrites.push({ ns, ops, expectedRevision });
            for (const op of ops) {
              if (op.op === 'set' && op.path[0] === 'providers') {
                state.providers = { ...(state.providers ?? {}), [op.path[1]]: op.value };
              }
            }
          },
        };
      }
      if (name === 'authorization') {
        return {
          describe(key) {
            const flow = state.flows.get(key);
            return flow === undefined ? undefined : { key, label: flow.label, methods: flow.methods, inFlight: false };
          },
          async begin(request) {
            const flow = state.flows.get(request.key);
            if (flow === undefined) throw new Error(`no flow for ${request.key}`);
            const session = {
              method: 'oauth',
              signal: request.signal ?? new AbortController().signal,
              notify: (notice) => {
                state.notices.push(notice);
                request.interaction.notify(notice);
              },
              prompt: (prompt) => {
                state.prompts = [...(state.prompts ?? []), prompt];
                return request.interaction.prompt(prompt);
              },
            };
            await flow.run(session);
            return { status: 'authorized' };
          },
          cancel(key) {
            state.cancelled = key;
          },
        };
      }
      return undefined;
    },
    inject(names, callback) {
      // `tools` is the only optional service this plugin asks for.
      if (!names.includes('tools')) return undefined;
      callback({
        effect: ctx.effect,
        tools: {
          register(definition) {
            state.tools.set(definition.name, definition);
            return () => {};
          },
        },
      });
      return undefined;
    },
    webServer: {
      register(route) {
        state.routes.set(route.path, route.handler);
        return () => {};
      },
    },
  };

  return { ctx, state };
}

async function request(state, method, url, body) {
  const handler = state.routes.get(url.split('?')[0]);
  assert.ok(handler, `route ${url} is registered`);
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
  let resolveEnd;
  const ended = new Promise((resolve) => {
    resolveEnd = resolve;
  });
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(payload) {
      resolveEnd(payload);
    },
  };
  await handler(req, res);
  const payload = await ended;
  return { status: res.statusCode, json: payload === undefined ? undefined : JSON.parse(String(payload)) };
}

/** ---------------------------------------------------------------------- suite */

/**
 * A scriptable stand-in for the two network calls this plugin makes: the OAuth
 * token endpoint and the Codex backend probe.
 *
 * Offline tests must never reach auth.openai.com or chatgpt.com, so `fetch` is
 * replaced for the duration of a case and restored afterwards. Each recorded call
 * lets a test assert what was sent, not just what came back.
 */
function installFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    for (const route of routes) {
      if (target.includes(route.match)) {
        const result = typeof route.reply === 'function' ? route.reply(init) : route.reply;
        return new Response(result.body ?? '', {
          status: result.status ?? 200,
          headers: result.headers ?? {},
        });
      }
    }
    throw new Error(`unexpected network call in a test: ${target}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** A token endpoint reply carrying a fresh, longer-lived grant. */
function tokenReply(overrides = {}) {
  const fresh = fakeJwt({
    exp: Math.floor((Date.now() + 10 * 24 * 3600 * 1000) / 1000),
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' },
  });
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      access_token: overrides.access_token ?? fresh,
      refresh_token: overrides.refresh_token ?? 'rotated-refresh-token',
      expires_in: overrides.expires_in ?? 864000,
    }),
  };
}

/** A backend reply that looks like a one-token completion. */
function streamReply() {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_test"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      '',
    ].join('\n'),
  };
}

const { apply } = await import('./index.js');
const passed = [];
const check = async (label, fn) => {
  await fn();
  passed.push(label);
  console.log(`  ok  ${label}`);
};

console.log('dsh-gpt-codex host tests');

// ---- 1. status before anything is configured
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile });
  const status = await request(state, 'GET', '/gpt-codex/status');
  await check('GET /status reports no credential but a bridgeable Codex CLI login', () => {
    assert.equal(status.status, 200);
    assert.equal(status.json.credential.configured, false);
    assert.equal(status.json.codexCli.present, true);
    assert.equal(status.json.codexCli.bridgeable, true, status.json.codexCli.bridgeError);
    assert.equal(status.json.codexCli.planType, 'plus');
    assert.equal(status.json.codexCli.accountId, accountId);
  });
}

// ---- 2. bridging writes the exact record shape dsh-llm-pi-ai reads
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile });
  // Bridging refreshes first (an access token can be revoked long before its
  // `exp`), so the token endpoint needs an answer.
  const net = installFetch([{ match: 'auth.openai.com/oauth/token', reply: tokenReply() }]);
  try {
    const signedIn = await request(state, 'POST', '/gpt-codex/sign-in', { mode: 'codex-cli' });
    await check('POST /sign-in bridges the Codex CLI login into a grant record', () => {
      assert.equal(signedIn.status, 200);
      assert.equal(signedIn.json.ok, true);
      const record = state.records.get('llm-pi-ai/openai-codex');
      assert.ok(record, 'record written under llm-pi-ai/openai-codex');
      assert.equal(record.kind, 'grant');
      assert.equal(record.payload.type, 'oauth');
      assert.equal(record.payload.accountId, accountId);
      assert.equal(typeof record.payload.expires, 'number');
      // The stored pair is the refreshed one, not the file's stale token.
      assert.equal(signedIn.json.tokenSource, 'refreshed');
      assert.equal(record.payload.refresh, 'rotated-refresh-token');
      assert.ok(record.payload.expires > Date.now(), 'the refreshed expiry is in the future');
    });
  } finally {
    net.restore();
  }
}

// ---- 2b. the refresh request carries pi-ai's client id and the real refresh token
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile });
  const net = installFetch([{ match: 'auth.openai.com/oauth/token', reply: tokenReply() }]);
  try {
    await request(state, 'POST', '/gpt-codex/sign-in', { mode: 'codex-cli' });
    await check('the refresh exchange uses the Codex OAuth client and the stored refresh token', () => {
      const calls = net.calls.filter((call) => call.url.includes('auth.openai.com/oauth/token'));
      assert.equal(calls.length, 1, 'exactly one token exchange');
      const body = String(calls[0].init.body);
      assert.match(body, /grant_type=refresh_token/);
      assert.match(body, /refresh_token=refresh-token-value/);
      assert.match(body, /client_id=app_EMoamEEZ73f0CkXaXp7hrann/);
      assert.equal(calls[0].init.method, 'POST');
    });
  } finally {
    net.restore();
  }
}

// ---- 2c. a dead refresh token falls back to the file's own token, and says so
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile });
  const net = installFetch([{ match: 'auth.openai.com/oauth/token', reply: { status: 400, body: '{"error":"invalid_grant"}' } }]);
  try {
    const signedIn = await request(state, 'POST', '/gpt-codex/sign-in', { mode: 'codex-cli' });
    await check('an unusable refresh token falls back to the file token and warns', () => {
      assert.equal(signedIn.json.ok, true, 'the bridge still completes');
      assert.equal(signedIn.json.tokenSource, 'codex-cli-file');
      assert.match(signedIn.json.refreshWarning, /refresh token 已失效/);
      const record = state.records.get('llm-pi-ai/openai-codex');
      assert.equal(record.payload.access, accessToken, 'the file token is kept as a fallback');
    });
  } finally {
    net.restore();
  }
}

// ---- 3. the payload survives a JSON round trip (the store's admission rule)
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile });
  const net = installFetch([{ match: 'auth.openai.com/oauth/token', reply: tokenReply() }]);
  try {
    await request(state, 'POST', '/gpt-codex/sign-in', { mode: 'codex-cli' });
    await check('the grant payload survives a JSON round trip unchanged', () => {
      const record = state.records.get('llm-pi-ai/openai-codex');
      assert.deepEqual(JSON.parse(JSON.stringify(record.payload)), record.payload);
      assert.equal(JSON.stringify(record.payload).includes('undefined'), false);
    });
  } finally {
    net.restore();
  }
}

// ---- 4. bridging enables the provider route through the settings seam
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile });
  const net = installFetch([{ match: 'auth.openai.com/oauth/token', reply: tokenReply() }]);
  try {
    await request(state, 'POST', '/gpt-codex/sign-in', { mode: 'codex-cli' });
    await check('POST /sign-in adds a catalog-backed openai-codex route pinned to SSE', () => {
      const write = state.settingsWrites.find((entry) => entry.ns === 'llm-pi-ai');
      assert.ok(write, 'a settings write happened');
      assert.deepEqual(write.ops, [{ op: 'set', path: ['providers', 'openai-codex'], value: { transport: 'sse' } }]);
      assert.deepEqual(state.providers['openai-codex'], { transport: 'sse' });
    });
  } finally {
    net.restore();
  }
}

// ---- 5. an already-configured route is left alone
{
  const { ctx, state } = makeCtx();
  state.providers = { 'openai-codex': { transport: 'sse' } };
  apply(ctx, { codexAuthPath: codexAuthFile });
  const result = await request(state, 'POST', '/gpt-codex/route/enable', {});
  await check('an existing openai-codex route is not overwritten', () => {
    assert.equal(result.json.changed, false);
    assert.equal(result.json.reason, 'already-configured');
    assert.deepEqual(state.providers['openai-codex'], { transport: 'sse' });
    assert.equal(state.settingsWrites.length, 0);
  });
}

// ---- 5b. a route the user configured differently is respected, not rewritten
{
  const { ctx, state } = makeCtx();
  state.providers = { 'openai-codex': { transport: 'websocket', models: [{ id: 'gpt-6.1-sol' }] } };
  apply(ctx, { codexAuthPath: codexAuthFile });
  const result = await request(state, 'POST', '/gpt-codex/route/enable', {});
  await check('a user-tuned openai-codex route is respected verbatim', () => {
    assert.equal(result.json.changed, false);
    assert.equal(result.json.reason, 'already-configured-differently');
    assert.equal(state.settingsWrites.length, 0);
    assert.equal(state.providers['openai-codex'].transport, 'websocket');
    assert.equal(state.providers['openai-codex'].models.length, 1);
  });
}

// ---- 6. an API-key Codex login is refused with a reason
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: apiKeyOnlyFile });
  const result = await request(state, 'POST', '/gpt-codex/sign-in', { mode: 'codex-cli' });
  await check('an API-key Codex login is refused, not silently mis-bridged', () => {
    assert.equal(result.status, 500);
    assert.match(result.json.error.message, /API key/);
    assert.equal(state.records.size, 0);
  });
}

// ---- 7. a missing Codex CLI file is reported
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: path.join(tmp, 'does-not-exist.json') });
  const result = await request(state, 'POST', '/gpt-codex/sign-in', { mode: 'codex-cli' });
  await check('a missing Codex CLI login is reported with its path', () => {
    assert.equal(result.status, 500);
    assert.match(result.json.error.message, /未找到 Codex CLI 的登录文件/);
  });
}

// ---- 8. sign-out removes the record
{
  const { ctx, state } = makeCtx();
  state.records.set('llm-pi-ai/openai-codex', { kind: 'grant', payload: { type: 'oauth' } });
  apply(ctx, { codexAuthPath: codexAuthFile });
  const result = await request(state, 'POST', '/gpt-codex/sign-out', {});
  await check('POST /sign-out deletes only the harness record', () => {
    assert.equal(result.json.ok, true);
    assert.equal(state.records.has('llm-pi-ai/openai-codex'), false);
  });
}

// ---- 9. tools are registered with the agent-visible names
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile });
  await check('the three agent tools are registered', () => {
    for (const name of ['gpt_status', 'gpt_sign_in', 'gpt_sign_out']) {
      assert.ok(state.tools.has(name), `${name} registered`);
    }
    const signIn = state.tools.get('gpt_sign_in');
    assert.equal(signIn.parameters.properties.mode.enum.join(','), 'codex-cli,browser');
    assert.equal(signIn.parameters.additionalProperties, false);
  });
}

// ---- 10. gpt_sign_in drives the same bridge and reports the route change
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile });
  const tool = state.tools.get('gpt_sign_in');
  const value = await tool.execute({ mode: 'codex-cli' });
  await check('gpt_sign_in writes the record and reports route:changed', () => {
    assert.equal(value.ok, true);
    assert.equal(value.source, 'codex-cli');
    assert.equal(value.planType, 'plus');
    assert.equal(value.route.changed, true);
    assert.ok(state.records.has('llm-pi-ai/openai-codex'));
  });
}

// ---- 11. gpt_sign_in in browser mode refuses rather than guessing
{
  const { ctx, state } = makeCtx();
  // The real pi-ai flow's first act is to ask which login method to use, so a
  // headless caller fails here — at the prompt, not somewhere deeper.
  state.flows.set('llm-pi-ai/openai-codex', {
    label: 'OpenAI Codex (legacy)',
    methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }],
    async run(session) {
      await session.prompt({ type: 'select', message: 'Select OpenAI Codex login method:', options: [{ id: 'browser', label: 'browser' }] });
      throw new Error('should not get past the prompt');
    },
  });
  apply(ctx, { codexAuthPath: codexAuthFile });
  const tool = state.tools.get('gpt_sign_in');
  const value = await tool.execute({ mode: 'browser' });
  await check('gpt_sign_in(browser) refuses headless interaction honestly', () => {
    assert.equal(value.ok, false);
    assert.match(value.error, /人工交互/);
    assert.equal(state.records.size, 0);
  });
}

// ---- 12. the OAuth route path: start → question → answer → authorized
{
  const { ctx, state } = makeCtx();
  // Stand in for the flow dsh-llm-pi-ai registers: it reports the authorize URL,
  // asks which login method, asks for the pasted code, then commits a record
  // through the same credential seam the real flow writes through.
  state.flows.set('llm-pi-ai/openai-codex', {
    label: 'OpenAI Codex (legacy)',
    methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }],
    async run(session) {
      session.notify({ message: 'A browser window should open.', url: 'https://auth.openai.com/oauth/authorize?x=1' });
      const method = await session.prompt({
        type: 'select',
        message: 'Select OpenAI Codex login method:',
        options: [
          { id: 'browser', label: 'Browser login (default)' },
          { id: 'device_code', label: 'Device code login (headless)' },
        ],
      });
      assert.equal(method, 'browser');
      const code = await session.prompt({
        type: 'manual_code',
        message: 'Complete login in your browser, or paste the authorization code / redirect URL here:',
        placeholder: 'http://localhost:1455/auth/callback',
      });
      assert.equal(code, 'the-code');
      await ctx.get('credentials').modifyRecord('llm-pi-ai/openai-codex', async () => ({
        kind: 'grant',
        payload: { type: 'oauth', access: accessToken, refresh: 'r', expires: expiresAtMs, accountId },
      }));
    },
  });

  apply(ctx, { codexAuthPath: codexAuthFile });

  const started = await request(state, 'POST', '/gpt-codex/oauth/start', {});
  await check('POST /oauth/start reports the authorize URL and the pending question', () => {
    assert.equal(started.status, 200);
    const seenUrl = started.json.attempt.url ?? [...state.notices].some((notice) => typeof notice.url === 'string');
    assert.ok(seenUrl, `a URL reached the surface: ${JSON.stringify(started.json.attempt)}`);
  });

  const afterStart = await request(state, 'GET', '/gpt-codex/oauth/state');
  await check('GET /oauth/state exposes the pending question', () => {
    const question = afterStart.json.attempt.question;
    assert.ok(question, 'a question is pending');
    assert.equal(question.kind, 'select');
    assert.equal(question.options.length, 2);
  });

  await request(state, 'POST', '/gpt-codex/oauth/answer', { value: 'browser' });

  // The flow then asks for the pasted code.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const secondQuestion = await request(state, 'GET', '/gpt-codex/oauth/state');
  await check('the second prompt (manual code) is surfaced as a text question', () => {
    const question = secondQuestion.json.attempt.question;
    assert.ok(question, 'a second question is pending');
    assert.equal(question.kind, 'manual_code');
    assert.equal(question.placeholder, 'http://localhost:1455/auth/callback');
  });

  await request(state, 'POST', '/gpt-codex/oauth/answer', { value: 'the-code' });
  await new Promise((resolve) => setTimeout(resolve, 400));

  const finalState = await request(state, 'GET', '/gpt-codex/oauth/state');
  const statusAfter = await request(state, 'GET', '/gpt-codex/status');
  await check('a completed OAuth attempt stores the record and enables the route', () => {
    assert.equal(finalState.json.attempt.phase, 'authorized', JSON.stringify(finalState.json.attempt));
    assert.equal(statusAfter.json.credential.configured, true);
    assert.equal(statusAfter.json.credential.accountId, accountId);
    assert.equal(state.providers['openai-codex'] !== undefined, true);
  });
}

// ---- 13. cancel aborts the attempt and tells the seam
{
  const { ctx, state } = makeCtx();
  state.flows.set('llm-pi-ai/openai-codex', {
    label: 'OpenAI Codex (legacy)',
    methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }],
    async run(session) {
      session.notify({ message: 'waiting', url: 'https://example.invalid/auth' });
      // Never answers: the test cancels instead.
      await new Promise((resolve, reject) => {
        session.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });
  apply(ctx, { codexAuthPath: codexAuthFile });
  await request(state, 'POST', '/gpt-codex/oauth/start', {});
  const cancelled = await request(state, 'POST', '/gpt-codex/oauth/cancel', {});
  await new Promise((resolve) => setTimeout(resolve, 250));
  const after = await request(state, 'GET', '/gpt-codex/oauth/state');
  await check('POST /oauth/cancel aborts and settles the attempt', () => {
    assert.equal(cancelled.json.ok, true);
    assert.equal(state.cancelled, 'llm-pi-ai/openai-codex');
    assert.equal(after.json.attempt.phase, 'cancelled', JSON.stringify(after.json.attempt));
    assert.equal(after.json.attempt.error, undefined, 'a user cancel is an outcome, not an error');
  });
}

// ---- 14. a browser sign-in request over the bridge route is refused
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile });
  const result = await request(state, 'POST', '/gpt-codex/sign-in', { mode: 'browser' });
  await check('POST /sign-in with mode=browser is refused with guidance', () => {
    assert.equal(result.status, 400);
    assert.match(result.json.error.message, /人工交互/);
  });
}

// ---- 15. autoEnableRoute runs only when a credential already exists
{
  const { ctx, state } = makeCtx();
  state.records.set('llm-pi-ai/openai-codex', { kind: 'grant', payload: { type: 'oauth' } });
  apply(ctx, { codexAuthPath: codexAuthFile, autoEnableRoute: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await check('a pre-existing credential enables the route on load', () => {
    assert.equal(state.providers?.['openai-codex'] !== undefined, true);
  });
}

{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile, autoEnableRoute: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await check('with no credential the route is left untouched', () => {
    assert.equal(state.providers, undefined);
    assert.equal(state.settingsWrites.length, 0);
  });
}

{
  const { ctx, state } = makeCtx();
  state.records.set('llm-pi-ai/openai-codex', { kind: 'grant', payload: { type: 'oauth' } });
  apply(ctx, { codexAuthPath: codexAuthFile, autoEnableRoute: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await check('autoEnableRoute:false leaves the route alone', () => {
    assert.equal(state.providers, undefined);
  });
}

// ---- 16. method guards
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile });
  const wrongMethod = await request(state, 'POST', '/gpt-codex/status', {});
  const wrongMethod2 = await request(state, 'GET', '/gpt-codex/sign-in');
  await check('each route rejects the wrong HTTP method', () => {
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod2.status, 405);
  });
}

// ---- 17. the module declares its hard dependency and reads the rest softly
{
  const module = await import('./index.js');
  await check('the module declares webServer as its only hard dependency', () => {
    assert.deepEqual([...module.inject], ['webServer']);
  });
}

// ---- 18. client bundle shape
{
  const source = await fsp.readFile(path.join(here, 'client.js'), 'utf8');
  // Comments name the APIs this half must not use; strip them before asserting,
  // so the check is about code and not about prose.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  await check('client.js uses the __ModuleLoader__ shell with the package name', () => {
    assert.match(source, /window\.__ModuleLoader__\.load\(/);
    assert.match(source, /id: 'dsh-gpt-codex'/);
    assert.match(source, /factory\(require\)/);
    assert.match(source, /require\('react'\)/);
    // The client half must not reach for anything it cannot have.
    assert.equal(/require\('node:/.test(code), false, 'no node: builtins');
    assert.equal(/ctx\.remote\b/.test(code), false, 'no ctx.remote namespace');
    assert.equal(/\bhost\.call\b/.test(code), false, 'no host.call');
    assert.equal(/\bprocess\./.test(code), false, 'no process in the browser half');
    // Colour literals only as fallbacks beside a --dsw-alias-* token.
    const colours = code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(colours.filter((value) => !['#fff', '#d93025'].includes(value)), []);
    // Every colour must sit next to a themed variable, not replace one.
    for (const literal of ['#fff', '#d93025']) {
      const at = code.indexOf(literal);
      if (at < 0) continue;
      const window = code.slice(Math.max(0, at - 160), at);
      assert.match(window, /--dsw-alias-/, `${literal} must be a fallback for a themed token`);
    }
  });
}

// ---- 19. patch + package metadata agree
{
  const manifest = JSON.parse(await fsp.readFile(path.join(here, 'package.json'), 'utf8'));
  const patch = await fsp.readFile(path.join(here, 'cordis.patch.yml'), 'utf8');
  const client = await fsp.readFile(path.join(here, 'client.js'), 'utf8');
  await check('package.json, cordis.patch.yml and client.js name the same plugin', () => {
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(manifest.dsh.client.platform, 'web');
    assert.deepEqual(manifest.exports['./client'], './client.js');
    // The three places a package name appears must agree: a mismatch in any one
    // makes the bundle fail to load (patch) or the client module never register.
    assert.match(patch, new RegExp(`name: '${manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.match(client, new RegExp(`id: '${manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.match(patch, /id: gpt-codex/);
  });
}

// ---- 20. the provider-card slot key must match the owner's dispatch key
{
  const source = await fsp.readFile(path.join(here, 'client.js'), 'utf8');
  await check('the provider-card registration is keyed by the pi-ai settings namespace', () => {
    // The Models page dispatches this keyed slot with
    // `{ entryKey: row.entry.settingsNs }`, and the renderer resolves a keyed slot
    // by `options.key === entryKey`. Registering under any other key renders
    // nothing — silently. For the pi-ai family the namespace is `llm-pi-ai`.
    const block = source.slice(source.indexOf("inject('settings.models.provider-card'"));
    assert.ok(block.length > 0, 'the provider-card slot is registered');
    const keyMatch = block.slice(0, 400).match(/key:\s*'([^']+)'/);
    assert.ok(keyMatch, 'the registration names a key');
    assert.equal(keyMatch[1], 'llm-pi-ai', 'the key must equal the pi-ai settingsNs');
  });
}

// ---- 21. the settings page and the provider card are both registered
{
  const source = await fsp.readFile(path.join(here, 'client.js'), 'utf8');
  await check('both entry points are registered and the card is scoped to openai-codex', () => {
    assert.match(source, /inject\('settings\.section'/);
    assert.match(source, /inject\('settings\.models\.provider-card'/);
    // The card renders inside every pi-ai row, so it must filter by provider id.
    assert.match(source, /provider\?\.provider === 'openai-codex'/);
    // ...and return null for the other providers in the same family.
    assert.match(source, /if \(!isCodex\) return null;/);
  });
}

/**
 * The measured failure this plugin has to survive:
 *
 *   A stored access token whose `exp` is ~7 days away returns 401 from the Codex
 *   backend, while its refresh token still exchanges successfully. "Configured"
 *   and "working" are therefore different facts, and only a real request or a
 *   refresh can tell them apart.
 *
 * These cases pin the recovery behaviour rather than trusting `exp`.
 */

// ---- 22. a live probe reports success for a token the backend accepts
{
  const { ctx, state } = makeCtx();
  state.records.set('llm-pi-ai/openai-codex', {
    kind: 'grant',
    payload: { type: 'oauth', access: accessToken, refresh: 'r', expires: expiresAtMs, accountId },
  });
  apply(ctx, { codexAuthPath: codexAuthFile });
  const net = installFetch([{ match: 'chatgpt.com/backend-api/codex/responses', reply: streamReply() }]);
  try {
    const verified = await request(state, 'GET', '/gpt-codex/verify');
    await check('GET /verify reports a working token as working', () => {
      assert.equal(verified.status, 200);
      assert.equal(verified.json.probe.ok, true, JSON.stringify(verified.json.probe));
      assert.match(verified.json.probe.detail, /接受/);
      // The probe must send the headers the backend actually requires.
      const call = net.calls.find((entry) => entry.url.includes('/codex/responses'));
      assert.ok(call, 'the probe reached the codex backend');
      const headers = call.init.headers;
      assert.equal(headers['OpenAI-Beta'], 'responses=experimental');
      assert.equal(headers.accept, 'text/event-stream');
      assert.equal(headers['chatgpt-account-id'], accountId);
      assert.equal(headers.originator, 'pi');
      assert.match(headers.authorization, /^Bearer /);
      assert.ok(headers['session-id'], 'a session id is sent');
      assert.equal(call.init.method, 'POST');
    });
  } finally {
    net.restore();
  }
}

// ---- 23. a 401 is healed by one refresh, and the retried probe then passes
{
  const { ctx, state } = makeCtx();
  state.records.set('llm-pi-ai/openai-codex', {
    kind: 'grant',
    payload: { type: 'oauth', access: accessToken, refresh: 'r', expires: expiresAtMs, accountId },
  });
  apply(ctx, { codexAuthPath: codexAuthFile });
  let backendCalls = 0;
  const net = installFetch([
    {
      match: 'chatgpt.com/backend-api/codex/responses',
      // First call is rejected (the revoked-token case), the retry succeeds.
      reply: () => (++backendCalls === 1 ? { status: 401, body: '' } : streamReply()),
    },
    { match: 'auth.openai.com/oauth/token', reply: tokenReply() },
  ]);
  try {
    const verified = await request(state, 'GET', '/gpt-codex/verify');
    await check('a 401 triggers exactly one refresh and the retry succeeds', () => {
      assert.equal(verified.json.probe.ok, true, JSON.stringify(verified.json.probe));
      assert.equal(verified.json.probe.recoveredBy, 'refresh');
      assert.equal(backendCalls, 2, 'probe, then retry');
      assert.equal(net.calls.filter((entry) => entry.url.includes('oauth/token')).length, 1);
      // The repaired record is persisted, so the next model call uses it.
      const record = state.records.get('llm-pi-ai/openai-codex');
      assert.equal(record.payload.refresh, 'rotated-refresh-token');
      assert.equal(record.payload.accountId, accountId);
    });
  } finally {
    net.restore();
  }
}

// ---- 24. a 401 with a dead refresh token is reported, not retried forever
{
  const { ctx, state } = makeCtx();
  state.records.set('llm-pi-ai/openai-codex', {
    kind: 'grant',
    payload: { type: 'oauth', access: accessToken, refresh: 'dead', expires: expiresAtMs, accountId },
  });
  apply(ctx, { codexAuthPath: codexAuthFile });
  const net = installFetch([
    { match: 'chatgpt.com/backend-api/codex/responses', reply: { status: 401, body: '' } },
    { match: 'auth.openai.com/oauth/token', reply: { status: 400, body: '{"error":"invalid_grant"}' } },
  ]);
  try {
    const verified = await request(state, 'GET', '/gpt-codex/verify');
    await check('an unrecoverable 401 is reported with the refresh failure attached', () => {
      assert.equal(verified.json.probe.ok, false);
      assert.equal(verified.json.probe.code, 'UNAUTHORIZED');
      assert.match(verified.json.probe.refreshError, /refresh token 已失效/);
      // No second backend attempt: the token was never replaced.
      assert.equal(net.calls.filter((entry) => entry.url.includes('/codex/responses')).length, 1);
    });
  } finally {
    net.restore();
  }
}

// ---- 25. no credential means no probe at all
{
  const { ctx, state } = makeCtx();
  apply(ctx, { codexAuthPath: codexAuthFile });
  const net = installFetch([]);
  try {
    const verified = await request(state, 'GET', '/gpt-codex/verify');
    await check('with no credential the verify route answers without touching the network', () => {
      assert.equal(verified.json.probe.ok, false);
      assert.equal(verified.json.probe.code, 'NO_CREDENTIAL');
      assert.equal(net.calls.length, 0);
    });
  } finally {
    net.restore();
  }
}

// ---- 26. ?refresh=1 forces a refresh before probing
{
  const { ctx, state } = makeCtx();
  state.records.set('llm-pi-ai/openai-codex', {
    kind: 'grant',
    payload: { type: 'oauth', access: accessToken, refresh: 'r', expires: expiresAtMs, accountId },
  });
  apply(ctx, { codexAuthPath: codexAuthFile });
  const net = installFetch([
    { match: 'auth.openai.com/oauth/token', reply: tokenReply() },
    { match: 'chatgpt.com/backend-api/codex/responses', reply: streamReply() },
  ]);
  try {
    const verified = await request(state, 'GET', '/gpt-codex/verify?refresh=1');
    await check('GET /verify?refresh=1 exchanges the refresh token first', () => {
      assert.equal(verified.json.probe.ok, true);
      assert.equal(net.calls.filter((entry) => entry.url.includes('oauth/token')).length, 1);
      const record = state.records.get('llm-pi-ai/openai-codex');
      assert.equal(record.payload.refresh, 'rotated-refresh-token');
    });
  } finally {
    net.restore();
  }
}

// ---- 27. gpt_status can skip the network
{
  const { ctx, state } = makeCtx();
  state.records.set('llm-pi-ai/openai-codex', {
    kind: 'grant',
    payload: { type: 'oauth', access: accessToken, refresh: 'r', expires: expiresAtMs, accountId },
  });
  apply(ctx, { codexAuthPath: codexAuthFile });
  const net = installFetch([]);
  try {
    const tool = state.tools.get('gpt_status');
    const offline = await tool.execute({ verify: false });
    await check('gpt_status(verify:false) stays offline and reports no probe', () => {
      assert.equal(offline.ok, true);
      assert.equal(offline.probe, undefined);
      assert.equal(net.calls.length, 0);
      // The renderer must still produce a readable report.
      const blocks = tool.output.render({}, offline);
      assert.match(blocks[0].text, /真实请求验证/);
    });
  } finally {
    net.restore();
  }
}

// ---- 28. gpt_status(verify) surfaces the probe outcome to the model
{
  const { ctx, state } = makeCtx();
  state.records.set('llm-pi-ai/openai-codex', {
    kind: 'grant',
    payload: { type: 'oauth', access: accessToken, refresh: 'r', expires: expiresAtMs, accountId },
  });
  apply(ctx, { codexAuthPath: codexAuthFile });
  const net = installFetch([{ match: 'chatgpt.com/backend-api/codex/responses', reply: streamReply() }]);
  try {
    const tool = state.tools.get('gpt_status');
    const value = await tool.execute({});
    await check('gpt_status verifies by default and renders the verdict', () => {
      assert.equal(value.ok, true);
      assert.equal(value.probe.ok, true);
      const blocks = tool.output.render({}, value);
      assert.match(blocks[0].text, /真实请求验证：通过/);
    });
  } finally {
    net.restore();
  }
}

await fsp.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed.length} checks passed`);
