#!/usr/bin/env node
/**
 * Pentest Bridge CLI — the agent-side client.
 *
 * Everything the bridge can do is reachable as `bridge <action> key=value ...`.
 * Values are parsed as JSON when possible, so numbers, booleans, arrays and
 * objects all work without extra escaping:
 *
 *   bridge navigate url=https://example.com
 *   bridge dom.query selector="input[type=password]" all=true
 *   bridge flag.set name=isAdmin value=true
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.PB_DATA_DIR || path.join(ROOT, '.data');
const HOST = process.env.PB_HOST || '127.0.0.1';
const PORT = Number(process.env.PB_PORT || 9104);
const BASE = `http://${HOST}:${PORT}`;

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function readToken() {
  const env = process.env.PB_TOKEN;
  if (env) return env.trim();
  const f = path.join(DATA_DIR, 'token');
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    console.error(C.red('No token found.') + ` Start the server first:\n  ${C.cyan('node server/index.js')}`);
    console.error(C.dim(`(expected ${f}; override with PB_TOKEN=...)`));
    process.exit(2);
  }
}

function parseValue(raw) {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim();
  if (t === '') return '';
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  // Try JSON only when it clearly is JSON, so "007", "1.2.3" and "a:b" survive.
  if (/^[[{"]|^-?\d+(\.\d+)?$|^(true|false|null)$/.test(t)) {
    try { return JSON.parse(t); } catch { /* keep as string */ }
  }
  return raw;
}

/** `--flag` → true, `--no-flag` → false, bare → true. */
function parseFlag(arg) {
  if (arg.startsWith('--no-')) return [arg.slice(5).replace(/-/g, '_'), false];
  if (arg.startsWith('--')) return [arg.slice(2).replace(/-/g, '_'), true];
  return null;
}

function parseArgs(argv) {
  const params = {};
  const positional = [];
  for (const arg of argv) {
    if (arg === '--raw') { params.__raw = true; continue; }
    if (arg === '--timeout' || arg === '-t') continue; // handled positionally below
    const f = parseFlag(arg);
    if (f) { params[f[0]] = f[1]; continue; }
    if (arg.startsWith('--') && arg.includes('=')) {
      const i = arg.indexOf('=');
      params[arg.slice(2, i).replace(/-/g, '_')] = parseValue(arg.slice(i + 1));
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      params[arg.slice(0, eq).replace(/-/g, '_')] = parseValue(arg.slice(eq + 1));
    } else {
      positional.push(arg);
    }
  }
  return { params, positional };
}

const TOKEN = readToken();

async function rpc(action, params = {}, { timeout = 60_000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${BASE}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ action, params, timeout: timeout - 2000 }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: `bad response: ${text.slice(0, 200)}` }; }
    if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`timed out after ${timeout}ms`);
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`nothing listening on ${HOST}:${PORT} — start it with: node server/index.js`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function admin(path, method = 'GET') {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function out(obj, raw) {
  if (raw) {
    const d = obj.data ?? obj;
    if (d && typeof d.dataUrl === 'string') return console.log(d.dataUrl);
    process.stdout.write((typeof d === 'string' ? d : JSON.stringify(d, null, 2)) + '\n');
    return;
  }
  console.log(JSON.stringify(obj, null, 2));
}

function fail(err) {
  console.error(C.red('✗ ') + err.message);
  if (process.env.PB_DEBUG) console.error(C.dim(err.stack));
  process.exit(1);
}

// ------------------------------------------------------------------ usage

const USAGE = `
${C.bold('pentest bridge')} ${C.dim('— drive your authorised test browser from the agent side')}

${C.bold('USAGE')}
  bridge <action> [key=value ...] [--flag] [--no-flag] [--raw] [-t ms]

${C.bold('NAVIGATION')}
  navigate url=<url> [tabId] [expectHost] [timeout]
  reload | back | forward | title [tabId] | set.title title=<t>
  tab.list | tab.create url=<url> | tab.close [tabId] | tab.activate [tabId] | tab.info [tabId]
  screenshot [tabId] --raw            ${C.dim('# data URL; pipe to a file')}

${C.bold('DOM')}
  page.info [tabId]
  dom.snapshot [selector] [maxChars]
  dom.query selector=<css> [all] [textChars] [attrs]
  dom.html [selector] [outer] [maxChars]
  dom.text [selector]
  dom.click selector=<css> [index] [expectUrlChange] [settleMs]
  dom.type selector=<css> text=<v> [clear] [typing] [delay] [check] [submit]
  dom.select selector=<css> value=<v> | label=<v> | index=<n>
  dom.check selector=<css> checked
  dom.scroll [y] [x] [selector] [behavior]
  dom.forms [tabId]                   ${C.dim('# every form + field; great for recon')}
  dom.inputs [tabId]                  ${C.dim('# every input incl. pre-filled values')}
  frame.list | (any page action) frameUrl=<substr>

${C.bold('SCRIPT + NETWORK')}
  main.eval expression=<js> [await] [timeout]
  main.fetch url=<url> [method] [body] [headers] [credentials] [mode]
  ws.connect url=<ws://...> [send] [expect] [timeout]
  net.log [clear] [tabId]             ${C.dim('# all fetch/XHR/WS/beacon since load')}
  net.clear

${C.bold('STATE')}
  cookies.get [domain] [includeValues]
  cookies.set url=<u> name=<n> value=<v> [secure] [httpOnly] [sameSite] [expiration]
  cookies.clear [domain]
  storage.local [key] [value] [remove] [clear]
  storage.session [key] [value] [remove]
  flag.get name=<flag>                ${C.dim('# JSON-decoded — the useful one for SPA flags')}
  flag.set name=<flag> value=<json> | remove
  dialog.policy [accept] [promptText] [suppressBeforeUnload]
  dialog.list | dialog.clear

${C.bold('CONTROL')}
  status | clients | events [n] | tail
  allow <host> | deny <host> | allow-all | lock
  policy | help

${C.bold('EXAMPLES')}
  bridge allow example.com
  bridge navigate url=https://example.com/login
  bridge dom.forms
  bridge main.eval expression="document.cookie"
  bridge main.fetch url=/api/me credentials=include --raw
  bridge flag.set name=featureFlags value='{"beta":true}'
  bridge screenshot --raw > /tmp/shot.png
`;

const POSITIONAL_SLOTS = {
  navigate: ['url', 'tabId', 'expectHost', 'timeout'],
  eval: ['expression', 'await'],
  fetch: ['url', 'method', 'body'],
  'ws.connect': ['url', 'send'],
  'dom.query': ['selector', 'all'],
  'dom.html': ['selector'],
  'dom.text': ['selector'],
  'dom.click': ['selector', 'index'],
  'dom.type': ['selector', 'text'],
  'dom.select': ['selector', 'value'],
  'dom.check': ['selector', 'checked'],
  'dom.snapshot': ['selector', 'maxChars'],
  'dom.scroll': ['y', 'x', 'selector'],
  'cookies.get': ['domain'],
  'flag.get': ['name'],
  'flag.set': ['name', 'value'],
  allow: ['host'],
};

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === 'help' || argv[0] === '-h' || argv[0] === '--help') {
    console.log(USAGE);
    return;
  }

  const cmd = argv[0];
  const { params, positional } = parseArgs(argv.slice(1));
  const raw = !!params.__raw;
  delete params.__raw;

  // ---------------------------------------------------------- local admin
  if (cmd === 'tail') {
    const res = await fetch(`${BASE}/tail`, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) fail(new Error(`HTTP ${res.status} — is the token current?`));
    console.log(C.dim('streaming events; ctrl-c to stop'));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (line.startsWith('data: ')) {
          const evt = JSON.parse(line.slice(6));
          const t = new Date(evt.ts).toISOString().slice(11, 23);
          console.log(C.dim(t) + ' ' + C.cyan(evt.type) + ' ' + C.dim(JSON.stringify(evt.payload).slice(0, 200)));
        }
      }
    }
    return;
  }

  if (cmd === 'allow') {
    const host = positional[0];
    if (!host) fail(new Error('usage: bridge allow <host>'));
    const r = await rpc('policy.allow', { host });
    return out(r, raw);
  }
  if (cmd === 'deny') {
    const host = positional[0];
    if (!host) fail(new Error('usage: bridge deny <host>'));
    return out(await rpc('policy.deny', { host }), raw);
  }
  if (cmd === 'allow-all') return out(await rpc('policy.allowAll', {}), raw);
  if (cmd === 'lock') return out(await rpc('policy.lock', {}), raw);
  if (cmd === 'policy') return out(await rpc('policy.get', {}), raw);
  if (cmd === 'status') return out(await admin('/status'), raw);
  if (cmd === 'clients') return out(await admin('/status'), raw);
  if (cmd === 'events') {
    const n = positional[0] || 50;
    return out(await admin(`/events?n=${encodeURIComponent(n)}`), raw);
  }

  // --------------------------------------------------------- sugar + argv
  // Fold bare positionals into the first N params the action expects, so
  // `bridge dom.query "input"` does the obvious thing.
  let action = cmd;
  if (cmd === 'eval') action = 'main.eval';
  else if (cmd === 'fetch') action = 'main.fetch';
  else if (cmd === 'shot') action = 'screenshot';

  const slots = POSITIONAL_SLOTS[action] || [];
  positional.forEach((p, i) => {
    const slot = slots[i];
    if (slot && params[slot] === undefined) params[slot] = parseValue(p);
  });

  // `net.log clear` -> {clear:true}
  if (positional[0] === 'clear' && action === 'net.log') params.clear = true;

  const timeoutArg = argv.indexOf('-t');
  const timeout = timeoutArg > -1 ? Number(argv[timeoutArg + 1]) : undefined;

  const r = await rpc(action, params, timeout ? { timeout } : {});
  out(r, raw);
}

export { parseValue, parseArgs, POSITIONAL_SLOTS };

/** Only run when invoked directly, so the parsers stay unit-testable. */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(fail);
}
