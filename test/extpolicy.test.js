'use strict';
/* Tests for the extension's shared policy module.
 *
 * This is the file the extension actually runs, so it is tested directly rather
 * than through a copy. The subdomain-suffix cases matter most: a naive
 * endsWith() grants a different registrable domain access. */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const P = require('../extension/lib/policy.js');

const locked = { allow: [], mode: 'lock' };
const lock = (...hosts) => ({ allow: hosts, mode: 'lock' });
const open = { allow: [], mode: 'allow-all' };

test('locked with an empty list permits nothing', () => {
  assert.equal(P.isAllowed('https://example.com/', locked), false);
  assert.equal(P.isAllowed('https://mail.proton.me/u/0/inbox', locked), false);
});

test('a missing or malformed policy denies rather than throwing', () => {
  assert.equal(P.isAllowed('https://example.com/', undefined), false);
  assert.equal(P.isAllowed('https://example.com/', null), false);
  assert.equal(P.isAllowed('https://example.com/', {}), false);
  assert.equal(P.isAllowed('https://example.com/', { allow: null, mode: 'lock' }), false);
});

test('allow-all permits everything, which is the point of the flag', () => {
  assert.equal(P.isAllowed('https://example.com/', open), true);
  assert.equal(P.isAllowed('https://mail.proton.me/u/0/inbox', open), true);
  assert.equal(P.isAllowed('about:blank', open), true, 'even schemes with no host');
});

test('an exact host matches, ports and paths do not matter', () => {
  const p = lock('example.com');
  assert.equal(P.isAllowed('https://example.com/', p), true);
  assert.equal(P.isAllowed('https://example.com:8443/a?b=1#c', p), true);
  assert.equal(P.isAllowed('http://example.com', p), true);
});

test('subdomains are covered but lookalike domains are not', () => {
  const p = lock('example.com');
  assert.equal(P.isAllowed('https://api.example.com/x', p), true);
  assert.equal(P.isAllowed('https://a.b.example.com/x', p), true);
  // The suffix-confusion cases a missing dot guard would let through.
  assert.equal(P.isAllowed('https://notexample.com/', p), false);
  assert.equal(P.isAllowed('https://example.com.evil.net/', p), false);
  assert.equal(P.isAllowed('https://evil.net/?x=example.com', p), false);
});

test('a leading wildcard matches the apex and its subdomains', () => {
  const p = lock('*.target.tld');
  assert.equal(P.isAllowed('https://target.tld/', p), true);
  assert.equal(P.isAllowed('https://staging.target.tld/', p), true);
  assert.equal(P.isAllowed('https://targetx.tld/', p), false);
});

test('a bare * allows any host', () => {
  assert.equal(P.isAllowed('https://anything.dev/', lock('*')), true);
});

test('hostless schemes never match a host rule', () => {
  const p = lock('example.com');
  for (const u of ['data:text/html,<h1>x', 'about:blank', 'javascript:alert(1)', 'blob:https://example.com/x', '']) {
    assert.equal(P.isAllowed(u, p), false, u);
  }
});

test('userinfo in the URL cannot spoof the host', () => {
  const p = lock('example.com');
  // new URL() takes the host after the '@', so this is example.com and should
  // match; what must never happen is the reverse.
  assert.equal(P.isAllowed('https://example.com@evil.net/', p), false);
  assert.equal(P.isAllowed('https://evil.net@example.com/', p), true);
});

test('isHostAllowed works on a bare hostname', () => {
  const p = lock('example.com');
  assert.equal(P.isHostAllowed('example.com', p), true);
  assert.equal(P.isHostAllowed('api.example.com', p), true);
  assert.equal(P.isHostAllowed('notexample.com', p), false);
  assert.equal(P.isHostAllowed('', p), false);
  assert.equal(P.isHostAllowed(null, p), false);
  assert.equal(P.isHostAllowed('anything.dev', open), true);
});

test('hostMatches rejects empty inputs on both sides', () => {
  for (const [h, e] of [['', 'example.com'], ['example.com', ''], ['', ''], [null, null]]) {
    assert.equal(P.hostMatches(h, e), false, `${h}/${e}`);
  }
});

test('a wildcard with no apex is refused rather than matching everything', () => {
  const p = lock('*.');
  assert.equal(P.isAllowed('https://example.com/', p), false);
  assert.equal(P.isAllowed('https://anything.dev/', p), false);
});

test('case is normalised on both sides', () => {
  assert.equal(P.isAllowed('https://EXAMPLE.com/', lock('example.com')), true);
  assert.equal(P.isAllowed('https://example.com/', lock('EXAMPLE.COM')), true);
  assert.equal(P.hostMatches('API.Example.com', 'example.com'), true);
});

test('the server and the extension agree on the matching rule', () => {
  // Two implementations of a security rule must not drift. Same inputs, same
  // verdicts, for the cases that separate a correct dot guard from a sloppy one.
  process.env.PB_DATA_DIR = require('node:fs').mkdtempSync(
    path.join(require('node:os').tmpdir(), 'pb-parity-')
  );
  const serverPolicy = require('../server/policy');
  const cases = [
    ['https://example.com/', lock('example.com')],
    ['https://api.example.com/', lock('example.com')],
    ['https://notexample.com/', lock('example.com')],
    ['https://example.com.evil.net/', lock('example.com')],
    ['https://target.tld/', lock('*.target.tld')],
    ['https://targetx.tld/', lock('*.target.tld')],
    ['https://a.b.c.example.com/', lock('example.com')],
    ['https://data:text/html,x', lock('example.com')],
  ];
  for (const [url, p] of cases) {
    const mine = P.isAllowed(url, p);
    // Feed the same rule through the server's implementation.
    const theirs = serverPolicy.hostMatches(serverPolicy.hostOf(url), p.allow[0]);
    assert.equal(mine, theirs, `disagreement on ${url} vs ${p.allow[0]}`);
  }
});
