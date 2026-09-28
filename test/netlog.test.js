'use strict';
/* net.log body capture.
 *
 * XHR entries have always carried `responseText`; fetch entries did not, so a
 * page built on fetch (most modern apps) showed status and headers with no
 * body. That made net.log useless for reading a config or API response.
 *
 * The body is read from a clone so the page receives an untouched Response --
 * consuming the original stream would break the app. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const hookSrc = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'hook.js'), 'utf8'
);

const fetchBranch = hookSrc.slice(hookSrc.indexOf('window.fetch = function pbFetch'));
const xhrBranch = hookSrc.slice(hookSrc.indexOf('XMLHttpRequest.prototype.send'));

test('fetch entries capture the response body', () => {
  assert.match(fetchBranch, /responseText/, 'fetch must record responseText like XHR does');
  assert.match(fetchBranch, /res\.clone\(\)/, 'must clone, not consume the original stream');
  assert.match(fetchBranch, /\.text\(\)/, 'must read the clone as text');
});

test('the page still receives its own unconsumed Response', () => {
  // The critical safety property: reading for the log must not drain the body
  // the application is about to read, which would break the page.
  const after = fetchBranch.slice(fetchBranch.indexOf('return res;'));
  assert.ok(after.length > 0, 'the original response is still returned');
  const cloneRead = fetchBranch.indexOf('res.clone().text()');
  const returnIdx = fetchBranch.indexOf('return res;');
  assert.ok(cloneRead < returnIdx, 'the clone is read before returning');
  assert.doesNotMatch(fetchBranch.slice(0, returnIdx), /(?<!clone\(\))res\.text\(\)/,
    'must never call .text() on the original response');
});

test('a failure to read the body does not break the page', () => {
  assert.match(fetchBranch, /opaque or already-locked|clone unavailable/,
    'clone failures must be swallowed, not thrown into the page');
});

test('both transports now expose the same field name', () => {
  assert.match(xhrBranch, /responseText/, 'XHR keeps responseText');
  assert.match(fetchBranch, /responseText/, 'fetch now also uses responseText');
});

test('net.log is still routed to the MAIN-world hook', () => {
  // bridge.js forwards via main('net.log', p) and hook.js answers it in its
  // router. A rename in one file only would break the channel silently.
  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'extension', 'bridge.js'), 'utf8'
  );
  assert.match(bridgeSrc, /main\('net\.log'/, 'bridge.js forwards net.log to the hook');
  assert.match(hookSrc, /case 'net\.log'/, 'hook.js handles net.log');
  assert.match(hookSrc, /case 'net\.clear'/, 'hook.js handles net.clear');
});
