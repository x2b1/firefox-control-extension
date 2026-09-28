'use strict';
/* Token tests. safeEqual is the single comparison guarding every route, so it
 * gets tested against the awkward inputs that a hand-rolled `===` would
 * mishandle. */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-token-'));
process.env.PB_DATA_DIR = TMP;

const { loadOrCreateToken, safeEqual, TOKEN_FILE } = require('../server/token');

test('the generated token is 256 bits of lowercase hex', () => {
  const t = loadOrCreateToken();
  assert.match(t, /^[a-f0-9]{64}$/);
});

test('the token is stable across calls within a process', () => {
  assert.equal(loadOrCreateToken(), loadOrCreateToken());
});

test('the token file is written 0600 inside a 0700 data dir', () => {
  const mode = fs.statSync(TOKEN_FILE).mode & 0o777;
  assert.equal(mode, 0o600, `token file mode was ${mode.toString(8)}`);
  const dirMode = fs.statSync(path.dirname(TOKEN_FILE)).mode & 0o777;
  assert.equal(dirMode, 0o700, `data dir mode was ${dirMode.toString(8)}`);
});

test('safeEqual accepts the right token and rejects everything else', () => {
  const t = loadOrCreateToken();
  assert.equal(safeEqual(t, t), true);
  assert.equal(safeEqual(t, t.toUpperCase()), false);
  assert.equal(safeEqual(t, t.slice(1)), false);
  assert.equal(safeEqual(t, t + '0'), false);
  assert.equal(safeEqual(t, ''), false);
  assert.equal(safeEqual('', t), false);
});

test('safeEqual handles non-string and hostile input without throwing', () => {
  const t = loadOrCreateToken();
  for (const bad of [null, undefined, 0, 1, {}, [], ['x'], true, Symbol('x'), 10n, () => {}]) {
    assert.equal(safeEqual(bad, t), false);
    assert.equal(safeEqual(t, bad), false);
  }
});

test('safeEqual rejects a control-character padded token', () => {
  // A naive prefix or substring comparison can be fooled by control
  // characters; hashing both sides first closes that off.
  const t = loadOrCreateToken();
  const NUL = String.fromCharCode(0);
  assert.equal(safeEqual(NUL + t, t), false);
  assert.equal(safeEqual(t + NUL, t), false);
  assert.equal(safeEqual(NUL + t + NUL, t), false);
  assert.equal(safeEqual(' ' + t, t), false);
});

test('a corrupt token file is replaced, not trusted', () => {
  loadOrCreateToken();
  fs.writeFileSync(TOKEN_FILE, 'not-a-token\n');
  const fresh = loadOrCreateToken();
  assert.notEqual(fresh, 'not-a-token');
  assert.match(fresh, /^[a-f0-9]{64}$/);
  // Minting happens exactly once; the replacement is then stable.
  assert.equal(loadOrCreateToken(), fresh);
});

test('a valid token file is reused, not rotated on every boot', () => {
  const t = loadOrCreateToken();
  assert.equal(loadOrCreateToken(), t);
});

fs.rmSync(TMP, { recursive: true, force: true });
