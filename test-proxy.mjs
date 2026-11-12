/** Offline regression: proxy configuration must work after fetch initializes. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { apply } from './index.js';

const seen = [];
const proxy = http.createServer((req, res) => {
  seen.push(req.url);
  res.end('proxied');
});
proxy.on('connect', (req, socket, head) => {
  seen.push(req.url);
  socket.on('error', () => {});
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  const reply = () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied');
  if (head.length) reply();
  else socket.once('data', reply);
});
const local = http.createServer((_req, res) => res.end('local'));
proxy.listen(0, '127.0.0.1');
local.listen(0, '127.0.0.1');
await Promise.all([once(proxy, 'listening'), once(local, 'listening')]);
const localUrl = `http://127.0.0.1:${local.address().port}/`;
const originalAgent = http.globalAgent;
const envBefore = { ...process.env };
const disposers = [];
try {
  // This is the desktop startup order: another plugin used fetch before GPT.
  assert.equal(await (await fetch(localUrl)).text(), 'local');
  apply({
    get() { return undefined; },
    inject() {},
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    webServer: { register() { return () => {}; } },
  }, { proxy: `http://127.0.0.1:${proxy.address().port}`, autoEnableRoute: false });

  assert.equal(await (await fetch('http://gpt-proxy-regression.invalid/response', {
    signal: AbortSignal.timeout(3000),
  })).text(), 'proxied');
  assert.equal(await (await fetch(localUrl)).text(), 'local');
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes('gpt-proxy-regression.invalid'));
  assert.deepEqual({ ...process.env }, envBefore, 'plugin preserves process environment');
} finally {
  for (const dispose of disposers.reverse()) dispose();
  assert.equal(http.globalAgent, originalAgent, 'unload restores previous agents');
  await Promise.all([proxy, local].map((server) => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  })));
}
console.log('PASS: initialized fetch uses proxy, loopback bypasses it, unload restores agents');
