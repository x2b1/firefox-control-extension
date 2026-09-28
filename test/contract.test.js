'use strict';
/* Contract test.
 *
 * Three places must agree on the set of actions: the server's allow-list, the
 * background page's routers, and the content script's implementations. Drift
 * between them is silent at runtime — a typo just becomes "unknown action" or a
 * dispatch that never fires — so assert they line up here instead. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-contract-'));
process.env.PB_DATA_DIR = TMP;
process.env.PB_PORT = '0';

const EXT = path.join(__dirname, '..', 'extension');
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');
const { KNOWN_ACTIONS } = require('../server/index');

const background = read('background.js');
const bridge = read('bridge.js');
const hook = read('hook.js');

/**
 * Extract the members of an object literal, bounded by brace matching.
 * `memberRe` differs per object: methods are written `async 'name'(`, the
 * routing table is written `'name': 1`. Getting this wrong is silent, so the
 * test below also asserts the extraction found a plausible number of members.
 */
function members(src, marker, memberRe) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `marker ${marker} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return [...src.slice(open, i).matchAll(memberRe)].map((m) => m[1]);
      }
    }
  }
  throw new Error(`unbalanced braces after ${marker}`);
}

const METHOD_RE = /async\s+'([a-z][\w.]*)'\s*\(/g;
const TABLE_RE = /'([a-z][\w.]*)'\s*:\s*1\s*,?/g;

const tabActions = members(background, 'const TAB_ACTIONS = {', METHOD_RE);
const pageActions = members(background, 'const PAGE_ACTIONS = {', TABLE_RE);
const contentOpsList = members(bridge, 'const ops = {', METHOD_RE);

test('the action-table extraction actually found the tables', () => {
  // Guards against a regex that silently matches nothing (or matches a string
  // literal), which would make every assertion below vacuously true.
  assert.ok(tabActions.length > 15, `only found ${tabActions.length} tab actions`);
  assert.ok(pageActions.length > 20, `only found ${pageActions.length} page actions`);
  assert.ok(contentOpsList.length > 20, `only found ${contentOpsList.length} content ops`);
  assert.ok(tabActions.includes('screenshot'), 'tab actions look wrong');
  assert.ok(pageActions.includes('dom.click'), 'page actions look wrong');
});

test('the content script implements every action the background routes', () => {
  const missing = pageActions.filter((a) => !contentOpsList.includes(a));
  assert.deepEqual(missing, [], `bridge.js is missing: ${missing.join(', ')}`);
});

test('the server allow-list covers every action the background handles', () => {
  const routed = [...tabActions, ...pageActions];
  const missing = routed.filter((a) => !KNOWN_ACTIONS.has(a));
  assert.deepEqual(missing, [], `server KNOWN_ACTIONS is missing: ${missing.join(', ')}`);
});

test('the server allow-list has no entries the background cannot handle', () => {
  // Actions answered by dispatch()'s early switch, before any tab is needed.
  const dispatchStart = background.indexOf('async function dispatch(');
  const switchStart = background.indexOf('switch (action) {', dispatchStart);
  assert.notEqual(switchStart, -1, 'dispatch switch not found');
  const switchEnd = background.indexOf('    default:', switchStart);
  const localActions = new Set(
    [...background.slice(switchStart, switchEnd).matchAll(/case\s+'([\w.]+)'/g)].map((m) => m[1])
  );
  assert.ok(localActions.size >= 8, `only found ${localActions.size} local actions`);

  // client.* is answered by the CLI directly and never dispatched.
  const CLI_ONLY = new Set(['client.list', 'client.select', 'bridge.log']);
  const routed = new Set([...tabActions, ...pageActions, ...localActions]);
  const orphans = [...KNOWN_ACTIONS].filter((a) => !routed.has(a) && !CLI_ONLY.has(a));
  assert.deepEqual(orphans, [], `nothing routes these: ${orphans.join(', ')}`);
});

test('every MAIN-world action the bridge forwards exists in the hook router', () => {
  // bridge.js forwards these to hook.js via main(); a missing case would only
  // fail at runtime with "main-world handler has no action".
  const hookActions = new Set(
    [...hook.matchAll(/case\s+'([\w.]+)'\s*:/g)].map((m) => m[1])
  );
  const forwarded = new Set(
    [...bridge.matchAll(/main\('([\w.]+)'/g)].map((m) => m[1])
  );
  const missing = [...forwarded].filter((a) => !hookActions.has(a));
  assert.deepEqual(missing, [], `hook.js router is missing: ${missing.join(', ')}`);
});

test('globals shared across manifest scripts are declared with var', () => {
  // Firefox compiles each file in background.scripts / content_scripts as its
  // own script. A top-level `const` does not reach the sibling files, which
  // passes every syntax check and then fails at runtime with
  // "X is not defined". `var` lands on the shared sandbox global.
  const shared = [
    ['lib/policy.js', 'PBPolicy'],
    ['lib/util.js', 'PB'],
  ];
  for (const [file, name] of shared) {
    const src = read(file);
    assert.match(src, new RegExp(`^var ${name} =`, 'm'), `${name} must be a top-level var in ${file}`);
    assert.doesNotMatch(src, new RegExp(`^const ${name} =`, 'm'), `${name} must not be const in ${file}`);
  }
});

test('every script referenced by the manifest exists on disk', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const files = [
    ...manifest.background.scripts,
    ...manifest.content_scripts.flatMap((c) => c.js),
    manifest.browser_action.default_popup,
    ...Object.values(manifest.icons),
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(EXT, f)), `manifest references missing file: ${f}`);
  }
});

test('the manifest script order puts shared libs before their consumers', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const bg = manifest.background.scripts;
  assert.ok(bg.indexOf('lib/policy.js') < bg.indexOf('background.js'),
    'background.js uses PBPolicy, so lib/policy.js must load first');
  const isolated = manifest.content_scripts.find((c) => c.world === 'ISOLATED');
  assert.ok(isolated.js.indexOf('lib/policy.js') < isolated.js.indexOf('bridge.js'),
    'bridge.js uses PBPolicy, so lib/policy.js must load first');
});

test('the CLI sugar aliases all point at real actions', () => {
  const aliases = { eval: 'main.eval', fetch: 'main.fetch', shot: 'screenshot' };
  for (const [alias, target] of Object.entries(aliases)) {
    assert.ok(KNOWN_ACTIONS.has(target), `${alias} -> ${target} is not a real action`);
  }
});

test('no duplicate action names', () => {
  const dupes = (arr) => arr.filter((v, i) => arr.indexOf(v) !== i);
  assert.deepEqual(dupes(pageActions), []);
  assert.deepEqual(dupes(tabActions), []);
  assert.deepEqual(dupes(contentOpsList), []);
});

test('the manifest asks for only the permissions the code actually uses', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const src = background + bridge + hook;
  for (const perm of manifest.permissions) {
    if (perm.startsWith('<')) continue; // host permission, not an API
    const api = perm.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    assert.ok(
      src.includes(`api.${api}.`) || src.includes(`browser.${api}.`),
      `manifest requests "${perm}" but no code calls ${api}.*`
    );
  }
});

test('the manifest loads the ISOLATED bridge at document_start in all frames', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.content_scripts.length, 1, 'one injected script; the hook is injected by hand');
  const cs = manifest.content_scripts[0];
  assert.equal(cs.world, 'ISOLATED', 'DOM work belongs in the isolated world');
  assert.ok(cs.js.includes('bridge.js'));
  assert.equal(cs.run_at, 'document_start', 'must run before page scripts to catch the first request');
  assert.equal(cs.all_frames, true, 'iframes are attack surface too');
  assert.equal(cs.match_about_blank, true);
});

test('the MAIN-world hook is injected by script tag, not a manifest world', () => {
  // Firefox does not honour content_scripts[].world: "MAIN" for MV2, so the
  // hook silently never loads and every main.* command times out.
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(
    !manifest.content_scripts.some((c) => c.world === 'MAIN'),
    'MV2 ignores world:MAIN; declaring it gives a silently dead hook'
  );
  const war = manifest.web_accessible_resources || [];
  assert.ok(
    war.includes('hook.js') || war.some((w) => (w.resources || []).includes('hook.js')),
    'hook.js must be web-accessible for <script src> injection'
  );
  const bridge = read('bridge.js');
  assert.match(bridge, /getURL\('hook\.js'\)/, 'bridge.js must inject hook.js itself');
  assert.match(bridge, /createElement\('script'\)/);
  assert.match(bridge, /__PB_HOOK__/, 'must not double-inject');
});

test('the background page is persistent, so the SSE stream survives', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.background.persistent, true);
  assert.equal(manifest.manifest_version, 2, 'Firefox MV2; MV3 suspends the background page');
});

fs.rmSync(TMP, { recursive: true, force: true });
