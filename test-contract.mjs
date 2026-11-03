/**
 * Contract test: does the record this plugin bridges survive the *real*
 * credential store's admission rules, and does `dsh-llm-pi-ai` read it back?
 *
 * The two upstream packages live inside the installed app's `app.asar`, so this
 * test extracts the admission logic's observable contract rather than importing
 * a private module: it asserts the exact constraints the shipped parsers enforce,
 * and it cross-checks them against the plugin's own output.
 *
 * Run with `node test-contract.mjs`.
 */

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const passed = [];
const check = async (label, fn) => {
  await fn();
  passed.push(label);
  console.log(`  ok  ${label}`);
};

/**
 * Where DeepSeek Harness installs its `app.asar` on this platform.
 *
 * Derived from the home directory rather than hard-coded, so the repository
 * carries no machine-specific paths. Windows and macOS differ; Linux packs often
 * live elsewhere, which is why `DSH_ASAR` overrides this.
 */
function defaultAsarPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
  }
  if (process.platform === 'darwin') {
    return '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
  }
  return undefined;
}

/**
 * The exact grammar the shipped credential seam enforces on a record key:
 * `KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/` on both halves
 * (`dsh-credentials/lib/types/index.js:14`).
 */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;
function isCredentialKey(key) {
  const at = key.indexOf('/');
  if (at <= 0) return false;
  return KEY_SEGMENT_PATTERN.test(key.slice(0, at)) && KEY_SEGMENT_PATTERN.test(key.slice(at + 1));
}

/**
 * `assertJsonValue` (`dsh-credentials-local/lib/index.js:295-310`) — a grant
 * payload must survive a JSON round trip.
 */
function assertJsonValue(where, value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${where}: non-finite number`);
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`${where}: ${typeof value} is not JSON`);
  if (seen.has(value)) throw new TypeError(`${where}: cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(where, item, seen);
  } else {
    for (const [key, nested] of Object.entries(value)) {
      if (nested === undefined) throw new TypeError(`${where}: "${key}" is undefined`);
      assertJsonValue(where, nested, seen);
    }
  }
  seen.delete(value);
}

/** ------------------------------------------------------------------ fixtures */

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

// A fixture account id. The plugin treats it as an opaque string, so any UUID works.
const accountId = '00000000-0000-4000-8000-000000000000';
const expiresAtMs = Date.now() + 7 * 24 * 3600 * 1000;
const accessToken = fakeJwt({ exp: Math.floor(expiresAtMs / 1000), 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'free' } });

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'gpt-codex-contract-'));
const codexAuthFile = path.join(tmp, 'auth.json');
await fsp.writeFile(
  codexAuthFile,
  JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: fakeJwt({}), access_token: accessToken, refresh_token: 'refresh-1', account_id: accountId },
    last_refresh: new Date().toISOString(),
  }),
  'utf8',
);

/** ---------------------------------------------------- drive the real plugin */

function makeCtx() {
  const state = { tools: new Map(), routes: new Map(), records: new Map(), providers: undefined, writes: [] };
  const ctx = {
    effect(callback) {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get(name) {
      if (name === 'credentials') {
        return {
          async readRecord(key) {
            return state.records.get(key);
          },
          async modifyRecord(key, mutate) {
            // Mirror the shipped store's admission: re-read, mutate, admit, render.
            const next = await mutate(state.records.get(key));
            if (next === undefined) return state.records.get(key);
            assert.ok(isCredentialKey(key), `store would reject the key ${key}`);
            if (next.kind === 'grant') assertJsonValue(`record "${key}" payload`, next.payload, new Set());
            if (next.kind !== 'grant' && next.kind !== 'api-key') throw new Error(`unknown kind ${next.kind}`);
            state.records.set(key, next);
            return next;
          },
          async deleteRecord(key) {
            state.records.delete(key);
          },
        };
      }
      if (name === 'settings') {
        return {
          describe: () => [{ ns: 'llm-pi-ai', revision: state.writes.length, value: { providers: { ...(state.providers ?? {}) } } }],
          async mutate(ns, ops) {
            state.writes.push({ ns, ops });
            for (const op of ops) {
              if (op.op === 'set' && op.path[0] === 'providers') state.providers = { ...(state.providers ?? {}), [op.path[1]]: op.value };
            }
          },
        };
      }
      return undefined;
    },
    inject(names, callback) {
      if (!names.includes('tools')) return undefined;
      callback({ effect: ctx.effect, tools: { register: (definition) => (state.tools.set(definition.name, definition), () => {}) } });
      return undefined;
    },
    webServer: { register: (route) => (state.routes.set(route.path, route.handler), () => {}) },
  };
  return { ctx, state };
}

async function request(state, method, url, body) {
  const handler = state.routes.get(url.split('?')[0]);
  assert.ok(handler, `route ${url}`);
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, async *[Symbol.asyncIterator]() { yield* chunks; } };
  let resolveEnd;
  const ended = new Promise((resolve) => (resolveEnd = resolve));
  const res = { statusCode: 200, headers: {}, setHeader(n, v) { this.headers[n] = v; }, end(p) { resolveEnd(p); } };
  await handler(req, res);
  return { status: res.statusCode, json: JSON.parse(String(await ended)) };
}

const { apply, inject } = await import('./index.js');

console.log('dsh-gpt-codex upstream contract');

// ---- the record key is addressable by the shipped seam
await check('the record key satisfies KEY_SEGMENT_PATTERN on both halves', () => {
  assert.ok(isCredentialKey('llm-pi-ai/openai-codex'));
  assert.equal(isCredentialKey('llm-pi-ai/openai.codex'), false, 'the grammar would reject a dot');
  assert.equal(isCredentialKey('llm-pi-ai/OpenAI-Codex'), false, 'the grammar would reject uppercase');
});

// ---- bridging produces a record the store admits
const { ctx, state } = makeCtx();
apply(ctx, { codexAuthPath: codexAuthFile });
const signedIn = await request(state, 'POST', '/gpt-codex/sign-in', { mode: 'codex-cli' });
await check('the store admits the bridged grant record', () => {
  assert.equal(signedIn.json.ok, true);
  const record = state.records.get('llm-pi-ai/openai-codex');
  assert.ok(record);
  assert.equal(record.kind, 'grant');
  assertJsonValue('payload', record.payload, new Set());
});

// ---- the payload matches pi-ai's OAuth credential shape exactly
await check('the grant payload is pi-ai\'s OAuth credential shape', () => {
  const { payload } = state.records.get('llm-pi-ai/openai-codex');
  assert.deepEqual(Object.keys(payload).sort(), ['access', 'accountId', 'expires', 'refresh', 'type']);
  assert.equal(payload.type, 'oauth');
  assert.equal(typeof payload.access, 'string');
  assert.equal(typeof payload.refresh, 'string');
  assert.equal(typeof payload.expires, 'number');
  assert.equal(typeof payload.accountId, 'string');
  // `toPiCredential` returns the payload verbatim for a grant, so pi-ai must see
  // exactly these four fields; an extra one would ride into the wire request.
  assert.equal(payload.access, accessToken);
});

// ---- what dsh-llm-pi-ai's credentialStoreFrom().list() would report
await check('credentialStoreFrom().list() would report it as an oauth grant', () => {
  const records = [...state.records.entries()];
  const mine = records
    .filter(([key]) => key.slice(0, key.indexOf('/')) === 'llm-pi-ai')
    .map(([key, record]) => ({ providerId: key.slice(key.indexOf('/') + 1), type: record.kind === 'api-key' ? 'api_key' : 'oauth' }));
  assert.deepEqual(mine, [{ providerId: 'openai-codex', type: 'oauth' }]);
});

// ---- the minimal route is valid under resolveRouteModels
await check('the enabled route is the catalog-backed profile with SSE pinned', () => {
  assert.deepEqual(state.providers, { 'openai-codex': { transport: 'sse' } });
  // `resolveProfiles` treats every key on `profile` as optional, so this object
  // validates; `resolveRouteModels` substitutes the installed catalog because no
  // `models` list is configured.
  const allowed = new Set([
    'apiKeyEnv', 'displayName', 'api', 'baseURL', 'models', 'modelOverrides', 'compat',
    'defaultContextWindow', 'defaultMaxTokens', 'defaultInput', 'headers', 'reasoning',
    'thinkingBudgets', 'cacheRetention', 'transport', 'timeoutMs', 'websocketConnectTimeoutMs',
    'streamIdleTimeoutMs', 'maxRequestImageBytes', 'requestImagePixelBudget', 'requestImageMaxBytes',
    'retryPolicy',
  ]);
  for (const key of Object.keys(state.providers['openai-codex'])) {
    assert.ok(allowed.has(key), `unexpected route field ${key}`);
  }
  // `transport` is one of the four the schema accepts; `api` is deliberately
  // absent because hand-declaring `openai-codex-responses` is refused.
  assert.deepEqual(['sse', 'websocket', 'websocket-cached', 'auto'].includes(state.providers['openai-codex'].transport), true);
  assert.equal('api' in state.providers['openai-codex'], false, 'api must stay catalog-owned');
});

// ---- the installed catalog actually describes this route
await check('the installed pi-ai catalog serves chat models for openai-codex', async () => {
  // Read the real catalog entry out of the installed app rather than trusting a
  // copy: this is the fact the whole plugin leans on. The location is discovered
  // from the environment so the check runs on any machine, and it skips cleanly
  // when the app is absent.
  const asar = process.env.DSH_ASAR ?? defaultAsarPath();
  const exists = asar === undefined ? false : await fsp.stat(asar).then(() => true).catch(() => false);
  if (!exists) {
    console.log('  --  installed app not found (set DSH_ASAR to point at app.asar); skipping the catalog cross-check');
    return;
  }
  const handle = await fsp.open(asar, 'r');
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    const headerSize = header.readUInt32LE(12);
    const raw = Buffer.alloc(headerSize);
    await handle.read(raw, 0, headerSize, 16);
    const index = JSON.parse(raw.toString('utf8').replace(/\0+$/, ''));
    const base = 16 + headerSize;
    const target = '/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json';
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const full = `${prefix}/${name}`;
        if (entry.files) {
          const found = walk(entry, full);
          if (found) return found;
        } else if (full === target) {
          return entry;
        }
      }
      return undefined;
    };
    const entry = walk(index, '');
    assert.ok(entry, 'the openai-codex catalog file is installed');
    const buffer = Buffer.alloc(Number(entry.size));
    await handle.read(buffer, 0, Number(entry.size), base + Number(entry.offset));
    const catalog = JSON.parse(buffer.toString('utf8'));
    const models = Object.values(catalog['openai-codex-responses'] ?? {});
    assert.ok(models.length > 0, 'the catalog lists chat models');
    for (const model of models) {
      assert.equal(model.type, 'chat');
      assert.equal(model.provider, 'openai-codex');
      assert.equal(model.baseUrl, 'https://chatgpt.com/backend-api');
      assert.equal(model.api, 'openai-codex-responses');
    }
    // An empty route profile inherits all of these, so the plugin never has to
    // restate a model list that would drift from the installed catalog.
    assert.ok(models.some((model) => model.id === 'gpt-6.1-sol'), 'the Ace model AITP used upstream is present');
  } finally {
    await handle.close();
  }
});

// ---- the plugin's hard dependency is the only service it cannot do without
await check('webServer is the only declared hard dependency', () => {
  assert.deepEqual([...inject], ['webServer']);
});

await fsp.rm(tmp, { recursive: true, force: true });
console.log(`\n${passed.length} checks passed`);
