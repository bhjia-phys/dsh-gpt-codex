/** Direct tool boundary regression: HTTP JSON.stringify used to hide undefined.
 * Fixtures and service doubles only; all fetch calls are intercepted, never live.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from './index.js';

// Deliberately inspect the original value, not a JSON-sanitized copy. Reject
// values JSON would silently omit/coerce as well as cycles and exotic objects.
function assertLosslessJson(value, where = '$', seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value) && !Object.is(value, -0), `${where}: non-JSON number`);
    return;
  }
  assert.equal(typeof value, 'object', `${where}: ${typeof value} is not JSON`);
  assert.ok(!seen.has(value), `${where}: cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertLosslessJson(value[i], `${where}[${i}]`, seen);
    assert.equal(Object.keys(value).length, value.length, `${where}: extra array keys`);
  } else {
    assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)), `${where}: non-plain object`);
    assert.equal(Reflect.ownKeys(value).length, Object.keys(value).length, `${where}: hidden/symbol keys`);
    for (const [key, item] of Object.entries(value)) assertLosslessJson(item, `${where}.${key}`, seen);
  }
  seen.delete(value);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-codex-json-'));
const realFetch = globalThis.fetch;
const accountId = 'fixture-account';
const claim = 'https://api.openai.com/auth';
const jwt = (payload) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const token = (extra = {}) => jwt({ exp: 2000000000, [claim]: { chatgpt_account_id: accountId }, ...extra });
const auth = (access = token()) => ({ tokens: { access_token: access, refresh_token: 'fixture-refresh' } });
const record = (extra = {}) => ({ kind: 'grant', payload: { type: 'oauth', access: token(), refresh: 'fixture-refresh', accountId, expires: 2000000000000, ...extra } });
let nextFile = 0;
async function fixture(value) {
  const file = path.join(tmp, `${nextFile++}.json`);
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}
function context(options = {}) {
  const state = { tools: new Map(), record: options.record, calls: [] };
  const ctx = {
    effect(fn) { return fn(); },
    get(name) {
      if (name === 'credentials' && !options.noStore) return {
        async readRecord() { return state.record; },
        async modifyRecord(_key, mutate) { state.record = await mutate(state.record); },
        async deleteRecord() { if (options.deleteError) throw options.deleteError; state.record = undefined; },
      };
      if (name === 'settings') return {
        describe: () => [{ ns: 'llm-pi-ai', value: { providers: {} }, revision: 0 }],
        async mutate() {},
      };
      if (name === 'authorization' && options.outcome) return {
        describe: () => ({ key: 'llm-pi-ai/openai-codex' }),
        async begin() { return { status: options.outcome }; },
      };
      return undefined;
    },
    inject(_names, fn) { fn({ effect: ctx.effect, tools: { register(tool) { state.tools.set(tool.name, tool); return () => {}; } } }); },
    webServer: { register() { return () => {}; } },
  };
  apply(ctx, { codexAuthPath: options.file ?? path.join(tmp, 'missing.json'), autoEnableRoute: false });
  return state;
}
const failures = [];
let passed = 0;
async function check(label, options, name, args, inspect = () => {}) {
  try {
    const state = context(options);
    globalThis.fetch = async (url) => {
      state.calls.push(String(url));
      if (options.networkError) throw new Error('fixture network failure');
      if (String(url).includes('/oauth/token')) return new Response(JSON.stringify({ access_token: options.refreshedToken ?? token(), expires_in: options.expiresIn ?? 3600 }), { status: options.refreshStatus ?? 200 });
      return new Response(options.body ?? 'data: {"type":"response.output_text.delta","delta":"OK"}\n', { status: options.status ?? 200 });
    };
    const tool = state.tools.get(name);
    const output = await tool.execute(args);
    assertLosslessJson(output);
    assert.deepEqual(JSON.parse(JSON.stringify(output)), output);
    const blocks = tool.output.render(args, output);
    assertLosslessJson(blocks);
    inspect(output, state);
    // Public facts and render blocks must never expose the fixture tokens.
    const serialized = JSON.stringify({ output, blocks });
    assert.equal(serialized.includes('fixture-refresh'), false);
    assert.equal(serialized.includes('e30.'), false);
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.error(`  FAIL  ${label}: ${error.message}`);
  }
}
try {
  // Prove the guard itself catches the lossy values a stringify-only test misses.
  for (const value of [{ x: undefined }, [undefined], [,], { x: NaN }, { x: Infinity }, { x: -0 }, { x: 1n }, new Date(), { x() {} }]) {
    assert.throws(() => assertLosslessJson(value));
  }
  const full = await fixture({ auth_mode: 'chatgpt', ...auth(token({ [claim]: { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' } })) });
  const minimal = await fixture(auth());
  const invalid = await fixture({ auth_mode: 'apikey', tokens: null });
  const malformed = await fixture('not-json');
  const overflow = await fixture(auth(token({ exp: 1e308 })));
  const noField = (object, key) => assert.equal(Object.hasOwn(object, key), false, `${key} must be absent`);
  await check('offline status: full CLI login', { file: full, record: record() }, 'gpt_status', { verify: false }, (o, s) => { noField(o.codexCli, 'bridgeError'); noField(o, 'probe'); assert.equal(s.calls.length, 0); });
  await check('offline status: absent auth mode and plan', { file: minimal }, 'gpt_status', { verify: false }, (o) => { noField(o.codexCli, 'authMode'); noField(o.codexCli, 'planType'); });
  await check('offline status: unbridgeable CLI login', { file: invalid }, 'gpt_status', { verify: false }, (o) => { noField(o.codexCli, 'accountId'); assert.equal(o.codexCli.bridgeable, false); });
  await check('offline status: malformed CLI JSON', { file: malformed }, 'gpt_status', { verify: false });
  await check('offline status: absent CLI file', {}, 'gpt_status', { verify: false });
  await check('offline status: no credential service', { noStore: true }, 'gpt_status', { verify: false });
  await check('offline status: partial grant payload', { record: { kind: 'grant', payload: {} } }, 'gpt_status', { verify: false }, (o) => { for (const key of ['type', 'accountId', 'expires', 'expired']) noField(o.credential, key); });
  await check('offline status: non-finite stored expiration', { record: record({ expires: Infinity }) }, 'gpt_status', { verify: false }, (o) => noField(o.credential, 'expires'));
  await check('offline status: overflowing JWT expiration', { file: overflow }, 'gpt_status', { verify: false });
  await check('default verification: accepted token', { file: full, record: record() }, 'gpt_status', {}, (o, s) => { assert.equal(o.probe.ok, true); assert.equal(s.calls.length, 1); });
  await check('verification: no grant', {}, 'gpt_status', { verify: true });
  await check('verification: API key record', { record: { kind: 'api-key' } }, 'gpt_status', {});
  await check('verification: bad grant', { file: minimal, record: { kind: 'grant', payload: {} } }, 'gpt_status', {});
  await check('verification: rejected and refresh failed', { file: full, record: record(), status: 401, refreshStatus: 400 }, 'gpt_status', {});
  await check('verification: refreshed grant without plan', { file: minimal, record: record(), status: 401 }, 'gpt_status', {}, (o) => assert.equal(o.probe.recoveredBy, 'refresh'));
  await check('verification: network failure', { file: full, record: record(), networkError: true }, 'gpt_status', {});
  await check('verification: empty backend stream', { file: full, record: record(), body: '' }, 'gpt_status', {});
  await check('sign-in: refreshed token without plan', { file: minimal }, 'gpt_sign_in', {}, (o) => { assert.equal(o.ok, true); noField(o, 'planType'); });
  await check('sign-in: refreshed token drops old plan', { file: full }, 'gpt_sign_in', {}, (o) => { assert.equal(o.ok, true); noField(o, 'planType'); });
  await check('sign-in: overflowing refreshed expiration', { file: minimal, refreshedToken: token({ exp: 1e308 }), expiresIn: 1e308 }, 'gpt_sign_in', {});
  await check('sign-in: fallback token without plan', { file: minimal, refreshStatus: 400 }, 'gpt_sign_in', {}, (o) => { assert.equal(o.ok, true); noField(o, 'planType'); });
  await check('sign-in: full fallback token', { file: full, refreshStatus: 400 }, 'gpt_sign_in', {}, (o) => assert.equal(o.planType, 'plus'));
  await check('sign-in: missing CLI file', {}, 'gpt_sign_in', {});
  await check('sign-in: no credential service', { file: minimal, noStore: true }, 'gpt_sign_in', {});
  await check('sign-in: unavailable browser OAuth', {}, 'gpt_sign_in', { mode: 'browser' });
  await check('sign-in: authorized browser outcome', { outcome: 'authorized' }, 'gpt_sign_in', { mode: 'browser' });
  await check('sign-in: cancelled browser outcome', { outcome: 'cancelled' }, 'gpt_sign_in', { mode: 'browser' });
  await check('sign-out: fake store success', { record: record() }, 'gpt_sign_out', {});
  await check('sign-out: missing store', { noStore: true }, 'gpt_sign_out', {});
  await check('sign-out: fake store failure', { deleteError: new Error('fixture failure') }, 'gpt_sign_out', {});
  await check('sign-out: thrown non-string message', { deleteError: { message: 1n } }, 'gpt_sign_out', {}, (o) => assert.equal(typeof o.error, 'string'));
} finally {
  globalThis.fetch = realFetch;
  await fs.rm(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} JSON boundary checks passed; ${failures.length} failed`);
assert.equal(failures.length, 0, failures.join('\n'));
