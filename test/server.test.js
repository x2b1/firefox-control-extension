'use strict';
/* HTTP surface tests.
 *
 * The scenario that motivates this file: you have the extension installed and
 * you browse to an attacker-controlled page. That page can run
 * `fetch('http://127.0.0.1:9104/rpc', {...})` from your browser. Every test
 * below asserts it cannot get anywhere. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-http-'));
process.env.PB_DATA_DIR = TMP;
process.env.PB_PORT = '0';

const { server, hub, TOKEN } = require('../server/index');
const policy = require('../server/policy');

let base;
let clientRes;

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  hub.removeClient(clientRes?.clientId);
  // SSE streams are long-lived by design, so close() alone would wait forever.
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function call(pathname, { method = 'GET', body, token = TOKEN, origin, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (token) h['x-bridge-token'] = token;
  if (origin) h.origin = origin;
  const res = await fetch(base + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

/** Simulate the extension: hold an SSE stream open, then answer commands. */
async function attachExtension() {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/attach?token=${TOKEN}&label=test`, {
    headers: { 'x-bridge-token': TOKEN },
    signal: ctrl.signal,
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ready = null;
  const readyP = new Promise((r) => (ready = r));
  const commands = [];

  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const nameLine = chunk.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!nameLine || !dataLine) continue;
          const ev = { name: nameLine.slice(7).trim(), data: JSON.parse(dataLine.slice(6)) };
          if (ev.name === 'ready') ready(ev.data.clientId);
          if (ev.name === 'command') commands.push(ev.data);
        }
      }
    } catch { /* aborted */ }
  })();

  const clientId = await readyP;
  return {
    clientId,
    commands,
    async answer(index, payload) {
      const cmd = commands[index];
      await call('/report', { method: 'POST', body: { type: 'result', clientId, ...payload } });
      return cmd;
    },
    stop: () => ctrl.abort(),
  };
}

// ----------------------------------------------------------------- /health

test('/health answers without a token and leaks nothing sensitive', async () => {
  const r = await call('/health', { token: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.service, 'pentest-bridge');
  // No token, no allowlist, no client detail.
  const serialised = JSON.stringify(r.body);
  assert.ok(!serialised.includes(TOKEN));
  assert.ok(!('policy' in r.body));
  assert.ok(!('token' in r.body));
});

// -------------------------------------------------------------------- auth

test('every non-health route rejects a missing token', async () => {
  for (const [method, p] of [
    ['GET', '/status'],
    ['GET', '/events'],
    ['GET', '/tail'],
    ['GET', '/attach'],
    ['POST', '/rpc'],
    ['POST', '/report'],
  ]) {
    const r = await call(p, { method, token: null, body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 401, `${method} ${p} must require a token`);
  }
});

test('a wrong or malformed token is rejected', async () => {
  // A NUL byte cannot legally be sent in an HTTP header, so that case is
  // covered directly against safeEqual in token.test.js instead.
  for (const bad of ['x', TOKEN.slice(0, 32), TOKEN + '0', 'A'.repeat(64), ' ', '']) {
    const r = await call('/status', { token: bad });
    assert.equal(r.status, 401, `token "${bad.slice(0, 8)}..." must be rejected`);
  }
});

test('the token is accepted via Authorization: Bearer too', async () => {
  const res = await fetch(`${base}/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
});

/* ---------------------------------------------------------------------------
 * The attack: a page on the open web, running in this browser, posting to the
 * bridge. It has no token and cannot set custom headers cross-origin.
 * ------------------------------------------------------------------------- */

test('a cross-site page cannot reach /rpc (no token, browser Origin)', async () => {
  const r = await call('/rpc', {
    method: 'POST',
    token: null,
    origin: 'https://evil.example',
    body: { action: 'dom.inputs' },
  });
  assert.equal(r.status, 401);
});

test('a cross-origin request WITH a valid token is still refused by the Origin gate', async () => {
  // Defence in depth: even if the token leaked (a screenshot, a pasted log, a
  // compromised dependency), a token alone must not be enough from a web page.
  const r = await call('/rpc', {
    method: 'POST',
    token: TOKEN,
    origin: 'https://evil.example',
    body: { action: 'dom.inputs' },
  });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /origin not allowed/);
});

test('a page origin cannot attach as an extension either', async () => {
  const r = await call('/attach', { token: TOKEN, origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('/attach requires a token in the query string, since EventSource cannot set headers', async () => {
  const res = await fetch(`${base}/attach`, { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 401, 'no token -> rejected before any stream opens');
  await res.text();
});

test('the real extension Origin is accepted', async () => {
  const r = await call('/status', { token: TOKEN, origin: 'moz-extension://a1b2c3d4-1234-5678-9abc-0123456789ab' });
  assert.equal(r.status, 200);
});

test('a sandboxed file:// page (Origin: null) still needs the token', async () => {
  const r = await call('/rpc', {
    method: 'POST',
    token: null,
    origin: 'null',
    body: { action: 'tab.list' },
  });
  assert.equal(r.status, 401);
});

// ------------------------------------------------------------------ /rpc

test('an unknown action is rejected before it reaches the extension', async () => {
  const r = await call('/rpc', { method: 'POST', body: { action: 'rm.-rf' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown action/);
});

test('/rpc without an attached extension explains what to do', async () => {
  const r = await call('/rpc', { method: 'POST', body: { action: 'tab.list' } });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /no extension attached/);
});

// ----------------------------------------------------- end-to-end dispatch

test('a real command round-trips: /rpc -> SSE -> /report -> /rpc', async () => {
  const ext = await attachExtension();
  try {
    const pending = call('/rpc', {
      method: 'POST',
      body: { action: 'page.info', params: { tabId: 1 } },
    });
    // Let the command reach the extension stream.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(ext.commands.length, 1, 'extension received the command');
    assert.equal(ext.commands[0].action, 'page.info');
    assert.deepEqual(ext.commands[0].params, { tabId: 1 });

    await ext.answer(0, { id: ext.commands[0].id, ok: true, data: { url: 'https://target.test/' } });
    const r = await pending;
    assert.equal(r.status, 200);
    assert.equal(r.body.data.url, 'https://target.test/');
  } finally {
    ext.stop();
  }
});

test('an error from the extension surfaces as a non-200 with a useful message', async () => {
  const ext = await attachExtension();
  try {
    const pending = call('/rpc', {
      method: 'POST',
      body: { action: 'dom.click', params: { selector: '#nope' } },
    });
    await new Promise((r) => setTimeout(r, 60));
    await ext.answer(0, {
      id: ext.commands[0].id,
      ok: false,
      error: 'no element matches #nope',
    });
    const r = await pending;
    assert.equal(r.status, 500);
    assert.match(r.body.error, /no element matches/);
  } finally {
    ext.stop();
  }
});

test('a duplicate report for the same command is absorbed', async () => {
  const ext = await attachExtension();
  try {
    const pending = call('/rpc', { method: 'POST', body: { action: 'tab.list' } });
    await new Promise((r) => setTimeout(r, 60));
    const first = await ext.answer(0, { id: ext.commands[0].id, ok: true, data: { n: 1 } });
    assert.equal((await pending).body.data.n, 1);
    const second = await call('/report', {
      method: 'POST',
      body: { type: 'result', clientId: ext.clientId, id: first.id, ok: true, data: { n: 2 } },
    });
    assert.equal(second.body.matched, false, 'second settle is ignored');
  } finally {
    ext.stop();
  }
});

test('malformed JSON gets a readable error rather than a hang', async () => {
  const res = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { 'x-bridge-token': TOKEN, 'content-type': 'application/json' },
    body: '{not json',
  });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.match(body.error, /invalid JSON/);
});

// ------------------------------------------------------------------ misc

test('/status never returns the token', async () => {
  const r = await call('/status');
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes(TOKEN));
});

test('unknown routes 404 with the method and path', async () => {
  const r = await call('/nope');
  assert.equal(r.status, 404);
  assert.match(r.body.error, /GET \/nope/);
});

test('a command timeout is enforced server-side', async () => {
  const ext = await attachExtension();
  try {
    const r = await call('/rpc', {
      method: 'POST',
      body: { action: 'navigate', params: {}, timeout: 150 },
    });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /timed out/);
  } finally {
    ext.stop();
  }
});
