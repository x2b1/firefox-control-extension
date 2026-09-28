'use strict';
/* Hub tests: command lifecycle. The failure modes that matter are the ones that
 * would otherwise hang an agent forever — timeouts, disconnects, duplicate and
 * orphan reports. */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-hub-'));
process.env.PB_DATA_DIR = TMP;

const { Hub } = require('../server/hub');

/** Minimal stand-in for an SSE http.ServerResponse that records event names. */
function namedRes() {
  const chunks = [];
  const pending = [];
  let name = null;
  return {
    chunks,
    pending,
    ended: false,
    write(s) {
      chunks.push(s);
      if (s.startsWith('event: ')) name = s.slice(7).trim();
      if (s.startsWith('data: ')) {
        try {
          const obj = JSON.parse(s.slice(6));
          obj.__name = name;
          pending.push(obj);
        } catch { /* not a data frame */ }
      }
      return true;
    },
    end() {
      this.ended = true;
    },
    take(n) {
      return pending.filter((p) => p.__name === n);
    },
  };
}

test('exec delivers a command over the stream and resolves the result', async () => {
  const hub = new Hub({ log() {} });
  const res = namedRes();
  const client = hub.addClient({ clientId: 'c1', label: 'test' }, res);

  const p = hub.exec({ action: 'tab.list', params: {} });
  await new Promise((r) => setTimeout(r, 10));

  const cmd = res.take('command')[0];
  assert.ok(cmd, 'a command frame was written');
  assert.equal(cmd.action, 'tab.list');

  hub.settle({ id: cmd.id, ok: true, data: { tabs: [] } });
  const out = await p;
  assert.deepEqual(out.data, { tabs: [] });
  assert.equal(out.clientId, client.id);
  assert.ok(out.ms >= 0);
});

test('a failing command rejects with the extension error message', async () => {
  const hub = new Hub({ log() {} });
  const res = namedRes();
  hub.addClient({ clientId: 'c1' }, res);
  const p = hub.exec({ action: 'dom.click', params: {} });
  await new Promise((r) => setTimeout(r, 10));
  const cmd = res.take('command')[0];
  hub.settle({ id: cmd.id, ok: false, error: 'no element matches body > .x' });
  await assert.rejects(p, /no element matches/);
});

test('a command times out rather than hanging forever', async () => {
  const hub = new Hub({ log() {} });
  const res = namedRes();
  hub.addClient({ clientId: 'c1' }, res);
  await assert.rejects(
    hub.exec({ action: 'main.eval', params: {}, timeout: 60 }),
    /timed out after 60ms/
  );
});

test('a late report for a timed-out command is ignored, not a crash', async () => {
  const hub = new Hub({ log() {} });
  const res = namedRes();
  hub.addClient({ clientId: 'c1' }, res);
  const p = hub.exec({ action: 'navigate', params: {}, timeout: 40 });
  const cmd = await new Promise((r) => setTimeout(() => r(res.take('command')[0]), 10));
  await assert.rejects(p);
  // The extension finally answers, well after we gave up.
  assert.equal(hub.settle({ id: cmd.id, ok: true, data: { late: true } }), false);
});

test('disconnecting rejects every in-flight command for that client', async () => {
  const hub = new Hub({ log() {} });
  const res = namedRes();
  hub.addClient({ clientId: 'c1' }, res);
  const a = hub.exec({ action: 'navigate', params: {} });
  const b = hub.exec({ action: 'screenshot', params: {} });
  await new Promise((r) => setTimeout(r, 10));
  hub.removeClient('c1');
  await assert.rejects(a, /disconnected/);
  await assert.rejects(b, /disconnected/);
  assert.equal(hub.clients.size, 0);
});

test('exec with no client attached fails fast with actionable text', async () => {
  const hub = new Hub({ log() {} });
  await assert.rejects(hub.exec({ action: 'tab.list' }), /no extension attached/);
});

test('a fresh client becomes the active target', () => {
  const hub = new Hub({ log() {} });
  hub.addClient({ clientId: 'a' }, namedRes());
  hub.addClient({ clientId: 'b' }, namedRes());
  assert.equal(hub.activeClientId, 'b');
  hub.removeClient('b');
  assert.equal(hub.activeClientId, 'a', 'falls back to the remaining client');
  hub.removeClient('a');
  assert.equal(hub.activeClientId, null);
});

test('an unknown clientId is rejected rather than silently rerouted', async () => {
  const hub = new Hub({ log() {} });
  hub.addClient({ clientId: 'a' }, namedRes());
  await assert.rejects(hub.exec({ action: 'tab.list', clientId: 'ghost' }), /no such client/);
});

test('client.list never leaks the token or profile paths', () => {
  const hub = new Hub({ log() {} });
  hub.addClient({ clientId: 'a', label: 'ff', profile: 'pentest' }, namedRes());
  const [c] = hub.clientList();
  assert.deepEqual(Object.keys(c).sort(), ['active', 'allow', 'connectedAt', 'id', 'label', 'mode', 'profile']);
});

test('the event ring buffer is bounded', () => {
  const hub = new Hub({ log() {} });
  for (let i = 0; i < 1500; i++) hub.pushEvent('a', 'net', { i });
  const tail = hub.tail(10);
  assert.equal(tail.length, 10);
  assert.equal(tail[9].payload.i, 1499, 'keeps the newest, drops the oldest');
});

test('sending to a removed client returns false instead of throwing', () => {
  const hub = new Hub({ log() {} });
  hub.addClient({ clientId: 'a' }, namedRes());
  hub.removeClient('a');
  assert.equal(hub.send('a', 'command', {}), false);
});

fs.rmSync(TMP, { recursive: true, force: true });
