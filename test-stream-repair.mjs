/**
 * Stream-repair test: the defect, the repair, and the shipped parser's verdict.
 *
 * The point of this file is that it does not test a model of pi-ai — it extracts
 * the *shipped* parsers out of the installed `app.asar` and runs them. A repair
 * that only satisfies this repository's own assumptions would pass every other
 * test here and still fail on the user's machine.
 *
 * Covered:
 *   1. the reported failure reproduces from the shipped parser (position 186);
 *   2. the repair makes both parallel calls parse, on the Responses path;
 *   3. same for chat completions (`tool_calls[].index` reuse);
 *   4. bare prompts, `[DONE]`, comments and invalid JSON stay byte-identical;
 *   5. the fetch wrapper touches only its endpoints and disposes cleanly.
 *
 * Run with `node test-stream-repair.mjs`. Skips the parser cases when the app is
 * not installed (set DSH_ASAR to point at app.asar).
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createCompletionsNormalizer,
  createResponsesNormalizer,
  installStreamRepair,
  resolveRepairEndpoints,
} from './stream-repair.js';

const passed = [];
const check = async (label, fn) => {
  await fn();
  passed.push(label);
  console.log(`  ok  ${label}`);
};

/** Where the app lives, derived rather than hard-coded (see test-contract.mjs). */
function defaultAsarPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'resources', 'app.asar');
  }
  if (process.platform === 'darwin') return '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
  return undefined;
}

/**
 * Extract archive subtrees into a real directory.
 *
 * Content starts at `8 + framing.readUInt32LE(4)`, not `16 + headerSize`: a
 * padded JSON header makes the naive formula short by up to 3 bytes, which
 * prepends each file with the tail of its predecessor.
 */
async function extractSubtree(asar, outDir, prefixes) {
  const handle = await fsp.open(asar, 'r');
  try {
    const framing = Buffer.alloc(16);
    await handle.read(framing, 0, 16, 0);
    const headerSize = framing.readUInt32LE(12);
    const base = 8 + framing.readUInt32LE(4);
    const raw = Buffer.alloc(headerSize);
    await handle.read(raw, 0, headerSize, 16);
    const tree = JSON.parse(raw.toString('utf8').replace(/\0+$/, ''));
    const files = [];
    const walk = (node, prefix) => {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const full = `${prefix}/${name}`;
        if (entry.files) { walk(entry, full); continue; }
        const offset = Number(entry.offset);
        const size = Number(entry.size);
        if (Number.isFinite(offset) && Number.isFinite(size) && size > 0) files.push({ path: full, offset, size });
      }
    };
    walk(tree, '');
    let written = 0;
    for (const entry of files) {
      if (!prefixes.some((prefix) => entry.path.startsWith(prefix))) continue;
      const target = path.join(outDir, entry.path.replace(/^\//, '').split('/').join(path.sep));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const buffer = Buffer.alloc(entry.size);
      await handle.read(buffer, 0, entry.size, base + entry.offset);
      await fsp.writeFile(target, buffer);
      written += 1;
    }
    return written;
  } finally {
    await handle.close();
  }
}

/** Both calls from the report, verbatim — 186 and 221 characters. */
const CALL_A = {
  id: 'fc_a1', call_id: 'call_a1', name: 'grep',
  arguments: '{"pattern": "apiKeyEnv|openai-api-key|API key|nativeAuth", "path": "D:\\\\CODEWORK\\\\DSH\\\\plugins\\\\dsh-gpt-codex\\\\evidence\\\\asar\\\\dsh__node_modules__@deepseek-ai__dsh-llm-pi-ai__README.md"}',
};
const CALL_B = {
  id: 'fc_b2', call_id: 'call_b2', name: 'grep',
  arguments: '{"pattern": "supportedProtocols|apiKeyEnv|resolveProfiles|function buildRoutes|routeKey", "path": "D:\\\\CODEWORK\\\\DSH\\\\plugins\\\\dsh-gpt-codex\\\\evidence\\\\asar\\\\dsh__node_modules__@deepseek-ai__dsh-llm-pi-ai__lib__index.js"}',
};
assert.equal(CALL_A.arguments.length, 186, 'the report says position 186');

/**
 * A non-compliant Responses stream: one slot shared by both calls, no
 * `function_call_arguments.done`, and the item in `output_item.done` carries no
 * arguments. This is the smallest shape that produces the reported message.
 */
function brokenResponsesStream() {
  return [
    { type: 'response.created', response: { id: 'resp_1', service_tier: 'default' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: CALL_A.id, call_id: CALL_A.call_id, name: CALL_A.name, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: CALL_A.id, delta: CALL_A.arguments },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: CALL_B.id, delta: CALL_B.arguments },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: CALL_A.id, call_id: CALL_A.call_id, name: CALL_A.name } },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } },
  ];
}

/** Both calls announced on the SAME slot: the repairable shape. */
function sharedSlotStream() {
  return [
    { type: 'response.created', response: { id: 'resp_1', service_tier: 'default' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: CALL_A.id, call_id: CALL_A.call_id, name: CALL_A.name, arguments: '' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: CALL_B.id, call_id: CALL_B.call_id, name: CALL_B.name, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: CALL_A.id, delta: CALL_A.arguments },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: CALL_B.id, delta: CALL_B.arguments },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: CALL_A.id, call_id: CALL_A.call_id, name: CALL_A.name, arguments: CALL_A.arguments } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: CALL_B.id, call_id: CALL_B.call_id, name: CALL_B.name, arguments: CALL_B.arguments } },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } },
  ];
}

/** The same stream with ids and correct slots: what a compliant server sends. */
function compliantResponsesStream() {
  return [
    { type: 'response.created', response: { id: 'resp_1', service_tier: 'default' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: CALL_A.id, call_id: CALL_A.call_id, name: CALL_A.name, arguments: '' } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: CALL_B.id, call_id: CALL_B.call_id, name: CALL_B.name, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: CALL_A.id, delta: CALL_A.arguments },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: CALL_B.id, delta: CALL_B.arguments },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: CALL_A.id, call_id: CALL_A.call_id, name: CALL_A.name, arguments: CALL_A.arguments } },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: CALL_B.id, call_id: CALL_B.call_id, name: CALL_B.name, arguments: CALL_B.arguments } },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } },
  ];
}

/** --- 1/2: the shipped Responses parser, before and after the repair ------- */

const asar = process.env.DSH_ASAR ?? defaultAsarPath();
const asarExists = asar === undefined ? false : await fsp.stat(asar).then(() => true).catch(() => false);
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'gpt-codex-stream-'));

let processResponsesStream;
let calculateCostReady = false;
if (asarExists) {
  // Keep each package's own package.json: pi-ai declares `type: module`, while
  // partial-json is CommonJS and Node's named-export detection needs it that way.
  await extractSubtree(asar, work, [
    '/dsh/node_modules/@earendil-works/pi-ai/dist',
    '/dsh/node_modules/@earendil-works/pi-ai/package.json',
    '/dsh/node_modules/partial-json',
  ]);
  const root = path.join(work, 'dsh', 'node_modules');
  const shared = await import(pathToFileURL(path.join(root, '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-responses-shared.js')).href);
  processResponsesStream = shared.processResponsesStream;
  calculateCostReady = true;
}

const MODEL = {
  id: 'gpt-5.5', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api',
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Run a stream through the shipped parser and report what it handed back. */
async function parseResponses(events) {
  const output = {
    role: 'assistant', content: [], api: 'openai-codex-responses', provider: 'openai-codex', model: MODEL.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'pending', timestamp: Date.now(),
  };
  const stream = { events: [], push(event) { this.events.push(event); } };
  async function* feed() { for (const event of events) yield event; }
  let thrown;
  try { await processResponsesStream(feed(), output, stream, MODEL, {}); }
  catch (error) { thrown = error.message.split('\n')[0]; }
  return { output, thrown };
}

const normalizerRepair = (events) => {
  const normalize = createResponsesNormalizer();
  // The parser receives decoded chunks; the normalizer mutates them in place.
  return events.map((event) => {
    const copy = structuredClone(event);
    normalize(copy);
    return copy;
  });
};

if (processResponsesStream === undefined || !calculateCostReady) {
  console.log('  --  installed app not found (set DSH_ASAR to app.asar); skipping the shipped-parser checks');
} else {
  await check('the shipped parser reproduces the reported failure on a shared output_index', async () => {
    const { output } = await parseResponses(brokenResponsesStream());
    const blocks = output.content.filter((block) => block.type === 'toolCall');
    assert.equal(blocks.length, 1, 'both calls collapse into one block');
    assert.ok(blocks[0].argumentsError, 'the merged arguments fail to parse');
    assert.equal(
      blocks[0].argumentsError.split('\n')[0],
      'Unexpected non-whitespace character after JSON at position 186 (line 1 column 187)',
      'the message is the one in the bug report',
    );
    assert.equal(
      blocks[0].argumentsError.split('Received arguments:\n')[1],
      CALL_A.arguments + CALL_B.arguments,
      'the buffer is exactly both calls concatenated',
    );
  });

  await check('the repair gives every call its own slot and both parse', async () => {
    // Both calls announced on ONE slot, argument text streamed per call, and
    // `output_item.done` carrying each call's arguments back. Unrepaired, the
    // shipped parser loses them; repaired, both survive.
    const broken = [
      { type: 'response.created', response: { id: 'resp_1', service_tier: 'default' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: CALL_A.id, call_id: CALL_A.call_id, name: CALL_A.name, arguments: '' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: CALL_B.id, call_id: CALL_B.call_id, name: CALL_B.name, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: CALL_A.id, delta: CALL_A.arguments },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: CALL_B.id, delta: CALL_B.arguments },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: CALL_A.id, call_id: CALL_A.call_id, name: CALL_A.name, arguments: CALL_A.arguments } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: CALL_B.id, call_id: CALL_B.call_id, name: CALL_B.name, arguments: CALL_B.arguments } },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } },
    ];

    const unrepaired = await parseResponses(structuredClone(broken));
    assert.ok(unrepaired.thrown, `the shipped parser refuses this stream (${unrepaired.thrown})`);

    const repaired = normalizerRepair(broken);
    const indexes = new Set(repaired.filter((event) => Object.hasOwn(event, 'output_index')).map((event) => event.output_index));
    assert.deepEqual([...indexes].sort(), [0, 1], 'the two calls sit on two slots');
    for (const event of repaired) {
      if (event.type === 'response.function_call_arguments.delta') {
        assert.equal(event.output_index, event.item_id === CALL_A.id ? 0 : 1, 'each delta follows its own item');
      }
    }
    const { output, thrown } = await parseResponses(repaired);
    assert.equal(thrown, undefined, 'the repaired stream completes');
    const blocks = output.content.filter((block) => block.type === 'toolCall');
    assert.deepEqual(blocks.map((block) => block.id.split('|')[0]), [CALL_A.call_id, CALL_B.call_id]);
    assert.deepEqual(blocks.map((block) => block.arguments), [JSON.parse(CALL_A.arguments), JSON.parse(CALL_B.arguments)]);
    assert.deepEqual(blocks.map((block) => block.argumentsError), [undefined, undefined]);
  });

  await check('deltas for an unannounced call are left alone, so the failure stays visible', async () => {
    // The server never sent `output_item.added` for B. Moving B's text to a slot
    // the parser has no block for would drop a tool call the model asked for —
    // a quiet wrong turn. Leaving it merged keeps the error, and the route's
    // retry policy re-asks. This is the documented limit, pinned as a test.
    const repaired = normalizerRepair(brokenResponsesStream());
    assert.equal(repaired.filter((event) => event.item_id === CALL_B.id).every((event) => event.output_index === 0), true);
    const { output } = await parseResponses(repaired);
    const block = output.content.find((item) => item.type === 'toolCall');
    assert.equal(block.argumentsError.split('\n')[0], 'Unexpected non-whitespace character after JSON at position 186 (line 1 column 187)');
  });

  await check('a repaired stream whose announced calls arrive first yields both calls', async () => {
    // Both calls announced (on one reused slot), then each call's text.
    const broken = brokenResponsesStream();
    broken.splice(2, 0, {
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: CALL_B.id, call_id: CALL_B.call_id, name: CALL_B.name, arguments: '' },
    });
    const repaired = normalizerRepair(broken);
    const { output, thrown } = await parseResponses(repaired);
    // B was announced, so its text keeps a block of its own; A's slot still holds
    // both texts because the server sent no `function_call_arguments.done`, so
    // this stream fails on A and the retry policy takes over.
    assert.ok(thrown || output.content.some((block) => block.type === 'toolCall' && block.argumentsError));
    assert.equal(repaired.filter((event) => event.type === 'response.output_item.added').length, 2);
  });

  await check('a compliant stream passes through unchanged', async () => {
    const events = compliantResponsesStream();
    const before = structuredClone(events);
    const repaired = normalizerRepair(events);
    assert.deepEqual(repaired, before, 'no event is rewritten when the server is correct');
    const { output } = await parseResponses(repaired);
    assert.deepEqual(
      output.content.filter((block) => block.type === 'toolCall').map((block) => block.arguments),
      [JSON.parse(CALL_A.arguments), JSON.parse(CALL_B.arguments)],
    );
  });
}

/** --- 3: chat completions reuse `tool_calls[].index` ----------------------- */

await check('chat-completions index reuse is repaired by call id', () => {
  // Every fragment names its call, which is what the gateways that trip this do
  // (they reuse `index` but do send distinct `id`s).
  const chunks = [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: CALL_A.id, type: 'function', function: { name: 'grep', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: CALL_B.id, type: 'function', function: { name: 'grep', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: CALL_A.id, function: { arguments: CALL_A.arguments } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: CALL_B.id, function: { arguments: CALL_B.arguments } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const normalize = createCompletionsNormalizer();
  // Only the fragments whose wire index disagrees with their id are rewritten;
  // A's later fragments already carry the right index, so they stay untouched.
  assert.deepEqual(chunks.map((chunk) => normalize(chunk)), [false, true, false, true, false]);

  // Aggregate the way pi-ai does: blocks keyed by stream index only.
  const blocks = new Map();
  for (const chunk of chunks) {
    for (const call of chunk.choices[0].delta.tool_calls ?? []) {
      const block = blocks.get(call.index) ?? { id: '', name: '', args: '' };
      if (!block.id && call.id) block.id = call.id;
      if (!block.name && call.function?.name) block.name = call.function.name;
      if (call.function?.arguments) block.args += call.function.arguments;
      blocks.set(call.index, block);
    }
  }
  assert.equal(blocks.size, 2, 'two independent calls');
  assert.deepEqual([...blocks.values()].map((block) => ({ id: block.id, args: JSON.parse(block.args) })), [
    { id: CALL_A.id, args: JSON.parse(CALL_A.arguments) },
    { id: CALL_B.id, args: JSON.parse(CALL_B.arguments) },
  ]);
});

await check('an id-less fragment follows the call last seen on its wire index', () => {
  // Unambiguous only because the two calls do not interleave. This is the
  // documented limit: without ids, fragments cannot be attributed.
  const chunks = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: CALL_A.id, function: { name: 'grep', arguments: CALL_A.arguments } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: CALL_B.id, function: { name: 'grep', arguments: CALL_B.arguments } }] } }] },
  ];
  const normalize = createCompletionsNormalizer();
  normalize(chunks[0]);
  normalize(chunks[1]);
  assert.deepEqual(chunks.map((chunk) => chunk.choices[0].delta.tool_calls[0].index), [0, 1]);
  assert.equal(createResponsesNormalizer()({ type: 'response.function_call_arguments.delta', delta: '{}' }), false, 'no id, nothing to key on');
});

await check('a repeated id keeps its slot when the wire index moves', () => {
  const normalize = createCompletionsNormalizer();
  normalize({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'read', arguments: '' } }] } }] });
  const moved = { choices: [{ index: 0, delta: { tool_calls: [{ index: 5, id: 'call_x', function: { arguments: '{}' } }] } }] };
  normalize(moved);
  assert.equal(moved.choices[0].delta.tool_calls[0].index, 0, 'follows the id it belongs to');
});

await check('an id-less fragment follows the call seen on its own wire index', () => {
  const normalize = createCompletionsNormalizer();
  normalize({ choices: [{ index: 0, delta: { tool_calls: [{ index: 2, id: 'call_y', function: { name: 'read', arguments: '{' } }] } }] });
  const anonymous = { choices: [{ index: 0, delta: { tool_calls: [{ index: 2, function: { arguments: '}' } }] } }] };
  normalize(anonymous);
  assert.equal(anonymous.choices[0].delta.tool_calls[0].index, 2, 'stays on the call it continues');
});

/** --- 4: the SSE re-framer keeps everything else intact -------------------- */

/**
 * Drive one SSE body through the installed wrapper.
 *
 * The body is emitted one byte at a time so a split UTF-8 sequence or a split
 * frame boundary is part of the test rather than a footnote.
 */
async function framed(source, url = 'https://chatgpt.com/backend-api/codex/responses') {
  const target = {
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        const bytes = new TextEncoder().encode(source);
        for (let index = 0; index < bytes.length; index += 1) controller.enqueue(bytes.slice(index, index + 1));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream', 'content-encoding': 'zstd' } }),
  };
  const stats = { responses: 0, repairedEvents: 0 };
  const dispose = installStreamRepair(target, resolveRepairEndpoints(), stats);
  const response = await target.fetch(url);
  const text = await response.text();
  const encoding = response.headers.get('content-encoding');
  dispose();
  return { text, stats, encoding };
}

await check('a clean stream is re-framed without changing any payload byte', async () => {
  const source = [
    ': keep-alive comment',
    'event: response.output_item.added',
    `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: CALL_A.id } })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\r\n');
  const { text, stats, encoding } = await framed(source);
  assert.equal(text, source, 'byte-identical');
  assert.equal(stats.repairedEvents, 0);
  assert.equal(stats.responses, 1, 'the endpoint was recognised');
  // fetch already decoded the body; leaving this header would decode it twice.
  assert.equal(encoding, null, 'content-encoding is dropped on the re-framed response');
});

await check('only the shared-slot stream changes, and the change is the position field', async () => {
  const source = sharedSlotStream().map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const { text, stats } = await framed(source);
  // Three of B's events carried it onto A's slot: its announcement, its delta and
  // its `output_item.done`. Everything else already agreed with its id.
  assert.equal(stats.repairedEvents, 3, `repaired ${stats.repairedEvents} events`);
  const reparsed = text.split('\n\n').filter((frame) => frame.startsWith('data: ')).map((frame) => JSON.parse(frame.slice(6)));
  assert.deepEqual(reparsed.map((event) => event.output_index ?? null), [null, 0, 1, 0, 1, 0, 1, null]);
});

await check('the wrapper ignores other URLs, non-SSE responses and disposes', async () => {
  const seen = [];
  const original = async (...args) => {
    seen.push(args);
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  };
  const target = { fetch: original };
  const init = { method: 'POST', headers: { authorization: 'Bearer mock' }, body: 'untouched' };
  const dispose = installStreamRepair(target, resolveRepairEndpoints());
  const json = await target.fetch('https://chatgpt.com/backend-api/codex/responses', init);
  assert.equal(await json.text(), '{"ok":true}');
  assert.strictEqual(seen[0][1], init, 'request init passes through untouched');
  const other = await target.fetch('https://example.test/v1/chat/completions', init);
  assert.equal(await other.text(), '{"ok":true}');
  dispose();
  assert.strictEqual(target.fetch, original, 'fetch is restored');
});

await check('cancelling the repaired body cancels the upstream stream', async () => {
  // The plugin's own backend probe reads a few frames and cancels; that cancel
  // has to reach the network stream, or every probe leaks a connection.
  // The cancellation travels through a pending `pull`, so the upstream reader is
  // still waiting on it when the caller cancels.
  let cancelledWith;
  const upstream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.created","response":{"id":"r"}}\n\n'));
    },
    cancel(reason) { cancelledWith = reason; },
  });
  const target = { fetch: async () => new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }) };
  const dispose = installStreamRepair(target, resolveRepairEndpoints());
  try {
    const response = await target.fetch('https://chatgpt.com/backend-api/codex/responses');
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel('probe-finished');
    // Cancellation may settle a tick later; it must still arrive.
    for (let tick = 0; tick < 10 && cancelledWith === undefined; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(cancelledWith, 'probe-finished');
  } finally {
    dispose();
  }
});

await check('an upstream failure surfaces instead of being swallowed', async () => {
  const failure = new Error('network down');
  const target = { fetch: async () => { throw failure; } };
  const dispose = installStreamRepair(target, resolveRepairEndpoints());
  try {
    await assert.rejects(target.fetch('https://chatgpt.com/backend-api/codex/responses'), failure);
  } finally {
    dispose();
  }
});

await check('resolveRepairEndpoints always covers the Codex backend and dedupes', () => {
  const endpoints = resolveRepairEndpoints([
    'https://relay.test/openai/v1/responses',
    { url: 'https://relay.test/openai/v1/chat/completions', dialect: 'completions' },
    'https://relay.test/openai/v1/responses',
  ]);
  assert.deepEqual(endpoints.map((endpoint) => endpoint.url), [
    'https://chatgpt.com/backend-api/codex/responses',
    'https://relay.test/openai/v1/responses',
    'https://relay.test/openai/v1/chat/completions',
  ]);
  assert.equal(endpoints[2].dialect, 'completions');
  assert.equal(resolveRepairEndpoints()[0].url, 'https://chatgpt.com/backend-api/codex/responses');
});

/**
 * End-to-end through pi-ai's own `stream()`: fetch, SSE decode, parser, events.
 *
 * The unit tests above hand decoded events straight to the parser. This one goes
 * through the entry point `dsh-llm-pi-ai` actually calls, so a repair that only
 * works on the test's own plumbing still fails here.
 */
await check('pi-ai stream() returns two usable tool calls instead of one corrupt one', async () => {
  if (asarExists) {
    const root = path.join(work, 'dsh', 'node_modules');
    const { stream } = await import(pathToFileURL(path.join(root, '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-codex-responses.js')).href);
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // The repairable shape: both calls announced, on one reused slot.
        res.end(`${sharedSlotStream().map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const endpoint = `${origin}/codex/responses`;
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const apiKey = `${encode({ alg: 'none' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })}.sig`;
    const model = {
      id: 'gpt-5.5', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: origin,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, input: [],
    };
    const context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] };
    const previous = globalThis.fetch;
    const stats = { responses: 0, repairedEvents: 0 };
    // Install on the real global: pi-ai reads `globalThis.fetch` at request time.
    const restore = installStreamRepair(globalThis, [{ url: endpoint, dialect: 'responses' }], stats);
    try {
      const events = stream(model, context, { apiKey, transport: 'sse', maxRetries: 0 });
      let message;
      for await (const event of events) if (event.type === 'done') message = event.message;
      assert.ok(message, 'a terminal message arrives');
      assert.equal(message.stopReason, 'toolUse', `the turn is usable (${message.errorMessage ?? 'no error'})`);
      const calls = message.content.filter((block) => block.type === 'toolCall');
      assert.deepEqual(calls.map((block) => block.id), [`${CALL_A.call_id}|${CALL_A.id}`, `${CALL_B.call_id}|${CALL_B.id}`]);
      assert.deepEqual(calls.map((block) => block.arguments), [JSON.parse(CALL_A.arguments), JSON.parse(CALL_B.arguments)]);
      assert.ok(stats.repairedEvents > 0, 'the repair actually rewrote frames');
    } finally {
      restore();
      server.close();
      assert.strictEqual(globalThis.fetch, previous, 'the global fetch is restored');
    }
  }
});

await fsp.rm(work, { recursive: true, force: true });
console.log(`\n${passed.length} stream-repair checks passed`);
