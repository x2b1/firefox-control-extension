'use strict';
/* main.fetch body handling.
 *
 * The CLI parses `body={...}` as JSON, so the content script receives an
 * object. fetch() stringifies a non-string body with toString(), which
 * produces the literal "[object Object]" — and the API answers with
 * "The request body is not valid JSON", sending the reader looking for an
 * encoding problem in the wrong place. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const hookSrc = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'hook.js'), 'utf8'
);
const fetchCase = hookSrc.slice(hookSrc.indexOf("case 'main.fetch'"));
const branch = fetchCase.slice(0, fetchCase.indexOf("case 'ws.connect'"));

test('a plain-object body is JSON-serialised before fetch sees it', () => {
  assert.match(branch, /JSON\.stringify\(body\)/,
    'object bodies must be serialised, not passed raw');
  assert.match(branch, /typeof body !== 'string'/,
    'the guard must distinguish strings from objects');
});

test('binary and form body types are passed through untouched', () => {
  // Re-serialising these would destroy the upload, so each must be excluded.
  for (const t of ['Blob', 'ArrayBuffer', 'URLSearchParams', 'FormData']) {
    assert.match(branch, new RegExp(`body instanceof ${t}`),
      `${t} must be excluded from serialisation`);
  }
});

test('an absent body stays absent rather than becoming "undefined"', () => {
  assert.match(branch, /body != null/, 'null/undefined must be left alone');
  assert.doesNotMatch(branch, /JSON\.stringify\(params\.body\)/,
    'must not serialise unconditionally');
});

test('the CLI parses key=value bodies as JSON, which is why this matters', () => {
  const cli = fs.readFileSync(
    path.join(__dirname, '..', 'cli', 'bridge.mjs'), 'utf8'
  );
  assert.match(cli, /JSON\.parse\(t\)/, 'the CLI still JSON-parses values');
  assert.match(cli, /\^[[{"]/, 'objects/arrays/strings are recognised as JSON');
});
