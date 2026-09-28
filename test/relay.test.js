'use strict';
/* Relay shape tests.
 *
 * The bug these exist to prevent: hook.js sends
 *   { __PB__: true, type: 'res', payload: { id, ok, data } }
 * and the content script once read the id off the top level, so every reply
 * matched nothing and every main.* command timed out after 30s. The wire format
 * is the contract between two separately-loaded files in different worlds, so
 * it gets tested rather than trusted. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..', 'extension');
const hookSrc = fs.readFileSync(path.join(EXT, 'hook.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(EXT, 'bridge.js'), 'utf8');

const CH = '__PB__';

/** Run hook.js in a stub page realm and capture what it posts. */
function loadHook() {
  const posted = [];
  const listeners = [];
  const sandbox = {
    location: { href: 'https://example.com/page', origin: 'https://example.com' },
    navigator: { sendBeacon: undefined },
    performance: { now: () => 0 },
    document: { title: 'stub' },
    console: { log() {}, warn() {}, error() {} },
    fetch: () => Promise.resolve({ ok: true }),
    EventSource: function () {},
    WebSocket: function () {},
    XMLHttpRequest: function () {},
    XMLHttpRequest_: null,
    PointerEvent: function () {},
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    postMessage: (data) => posted.push(data),
    Blob: function () {},
    setTimeout,
    clearTimeout,
    Promise,
    URL,
    Object,
    Array,
    JSON,
    Math,
    Date,
    Error,
    String,
    Number,
    Set: undefined,
  };
  sandbox.window = sandbox;
  sandbox.XMLHttpRequest.prototype = { open() {}, send() {}, addEventListener() {} };
  sandbox.setRequestHeader = null;
  vm.createContext(sandbox);
  vm.runInContext(hookSrc, sandbox, { filename: 'hook.js' });
  /* Grab the window reference from *inside* the realm. A vm context proxies the
   * sandbox object, so the outer `sandbox` is not identity-equal to the inner
   * `window`, and the hook's `ev.source !== window` guard would silently reject
   * every message. That guard is correct and worth keeping -- it stops page
   * scripts from driving the hook -- so the harness has to satisfy it. */
  vm.runInContext('globalThis.__innerWindow = window;', sandbox);
  return { sandbox, posted, listeners, inner: sandbox.__innerWindow };
}

test('hook.js runs without throwing in a bare page realm', () => {
  const { sandbox } = loadHook();
  assert.equal(sandbox.__PB_HOOK__, true, 'hook sets its own presence flag');
});

test('hook.js announces itself on load with the ready message', () => {
  const { posted } = loadHook();
  const ready = posted.find((m) => m.type === 'ready');
  assert.ok(ready, 'a ready message is posted at startup');
  assert.equal(ready[CH], true, 'messages are tagged with the channel key');
  assert.equal(ready.payload.url, 'https://example.com/page');
});

test('the res message nests the id inside payload', async () => {
  // This is the exact contract the content script depends on.
  const { posted, listeners, inner } = loadHook();
  const onMessage = listeners.find((l) => l.type === 'message');
  assert.ok(onMessage, 'hook listens for message events');

  // The hook ignores anything whose source is not its own window, which is
  // what keeps other scripts on the page from driving it.
  onMessage.fn({
    source: inner,
    data: { [CH]: true, type: 'req', id: 'abc123', action: 'ping', params: {} },
  });
  await new Promise((r) => setTimeout(r, 20));

  const res = posted.find((m) => m.type === 'res');
  assert.ok(res, 'a res message was posted');
  assert.equal(res[CH], true);
  assert.equal(res.payload.id, 'abc123', 'id is inside payload, not top level');
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.data.url, 'https://example.com/page', 'ping returns the page url');
  assert.equal(res.id, undefined, 'and is NOT duplicated at the top level');
});

test('the hook ignores messages from anything but its own window', async () => {
  const { posted, listeners } = loadHook();
  const onMessage = listeners.find((l) => l.type === 'message');
  onMessage.fn({
    source: { other: 'window' },
    data: { [CH]: true, type: 'req', id: 'evil', action: 'main.eval', params: { expression: '1' } },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posted.find((m) => m.type === 'res'), undefined,
    'a page script must not be able to invoke the hook itself');
});

test('the hook rejects an unknown action with an error, not a silent drop', async () => {
  const { posted, listeners, inner } = loadHook();
  const onMessage = listeners.find((l) => l.type === 'message');
  onMessage.fn({
    source: inner,
    data: { [CH]: true, type: 'req', id: 'zzz', action: 'not.a.real.action', params: {} },
  });
  await new Promise((r) => setTimeout(r, 20));
  const res = posted.find((m) => m.type === 'res');
  assert.ok(res, 'still replies');
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /not\.a\.real\.action/);
});

test('the content script reads the id from payload, not the top level', () => {
  // Guards the regression directly: a top-level read compiles and runs fine,
  // it just never matches, so only an assertion on the source can catch it.
  const resBranch = bridgeSrc.slice(bridgeSrc.indexOf("d.type === 'res'"));
  const branch = resBranch.slice(0, resBranch.indexOf('} else if'));
  assert.match(branch, /d\.payload/, 'must read the id out of payload');
  assert.doesNotMatch(branch, /waiting\.get\(d\.id\)/, 'must not read the id off the top level');
  assert.match(branch, /waiting\.get\(p\.id\)/);
});

test('both sides agree on the channel key', () => {
  assert.match(hookSrc, new RegExp(`const CH = '${CH}'`));
  assert.match(bridgeSrc, new RegExp(`const CH = '${CH}'`));
});

test('the request shape the bridge sends is what the hook expects', () => {
  const mainFn = bridgeSrc.slice(bridgeSrc.indexOf('function main('));
  const send = mainFn.slice(0, mainFn.indexOf('// ----'));
  assert.match(send, /type: 'req'/, 'requests are tagged type=req');
  assert.match(send, /\bid\b/, 'requests carry the id the hook must echo');
  assert.match(send, /\baction\b/);
  assert.match(send, /\bparams\b/);
  assert.match(hookSrc, /d\.type !== 'req'/, 'hook filters on type=req');
});

test('hook.js does not double-install itself', () => {
  const { sandbox } = loadHook();
  // Second evaluation in the same realm must bail out early.
  const before = sandbox.__PB_HOOK__;
  vm.runInContext(hookSrc, sandbox, { filename: 'hook.js-again' });
  assert.equal(sandbox.__PB_HOOK__, before);
});

test('the inject-once guard in bridge.js checks the same flag', () => {
  assert.match(bridgeSrc, /if \(window\.__PB_HOOK__\) return;/,
    'bridge.js must skip injection when the hook is already present');
});
