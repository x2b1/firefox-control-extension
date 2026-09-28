'use strict';
/* Policy tests: the deny-by-default gate that keeps the bridge inert on every
 * site you are not testing. */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Must be set before requiring anything that reads DATA_DIR.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-policy-'));
process.env.PB_DATA_DIR = TMP;

const policy = require('../server/policy');

const reset = () => {
  policy.setMode('lock');
  policy.save({ allow: [], mode: 'lock' });
};

test('lock mode denies everything, including hosts that were never added', () => {
  reset();
  assert.equal(policy.isAllowed('https://example.com/'), false);
  assert.equal(policy.isAllowed('https://bank.com/login'), false);
});

test('allow-all mode permits anything', () => {
  reset();
  policy.setMode('allow-all');
  assert.equal(policy.isAllowed('https://example.com/'), true);
  reset();
});

test('exact host match', () => {
  reset();
  policy.add('example.com');
  assert.equal(policy.isAllowed('https://example.com/'), true);
  assert.equal(policy.isAllowed('https://example.com:8443/a?b=1'), true);
  assert.equal(policy.isAllowed('https://evil.com/'), false);
});

test('subdomains of an allowed apex are covered, but not the reverse', () => {
  reset();
  policy.add('example.com');
  assert.equal(policy.isAllowed('https://api.example.com/x'), true);
  assert.equal(policy.isAllowed('https://a.b.example.com/x'), true);
  // Suffix confusion must not match: "notexample.com" is a different registrable
  // domain, and a naive endsWith check without the dot guard would allow it.
  assert.equal(policy.isAllowed('https://notexample.com/'), false);
  assert.equal(policy.isAllowed('https://example.com.evil.net/'), false);
});

test('leading wildcard matches apex and subdomains', () => {
  reset();
  policy.add('*.target.tld');
  assert.equal(policy.isAllowed('https://target.tld/'), true);
  assert.equal(policy.isAllowed('https://staging.target.tld/'), true);
  assert.equal(policy.isAllowed('https://x.target.tld/'), true);
  assert.equal(policy.isAllowed('https://targetx.tld/'), false);
});

test('bare "*" allows all hosts', () => {
  reset();
  policy.add('*');
  assert.equal(policy.isAllowed('https://anything.dev/'), true);
  reset();
});

test('hostOf strips scheme, port, credentials and path', () => {
  assert.equal(policy.hostOf('https://user:pw@api.example.co.uk:8443/a/b?c=1#d'), 'api.example.co.uk');
  assert.equal(policy.hostOf('not a url'), '');
  assert.equal(policy.hostOf(''), '');
});

test('non-http schemes are normalised, and junk is refused', () => {
  reset();
  policy.add('example.com');
  // Pages served from a data:/blob: origin have no hostname; they must not be
  // able to inherit an unrelated allow rule.
  assert.equal(policy.isAllowed('data:text/html,<h1>x'), false);
  assert.equal(policy.isAllowed('about:blank'), false);
  assert.equal(policy.isAllowed('javascript:alert(1)'), false);
});

test('add/remove round-trips and persists', () => {
  reset();
  policy.add('A.com');
  policy.add('b.com');
  assert.deepEqual(policy.load().allow, ['a.com', 'b.com']);
  policy.remove('a.com');
  assert.deepEqual(policy.load().allow, ['b.com']);
  reset();
});

test('hostMatches never matches an empty host', () => {
  assert.equal(policy.hostMatches('', 'example.com'), false);
  assert.equal(policy.hostMatches('example.com', ''), false);
  assert.equal(policy.hostMatches('', ''), false);
});

fs.rmSync(TMP, { recursive: true, force: true });
