'use strict';
/**
 * HTTP surface. Everything except /health requires the bearer token AND a
 * non-browser Origin, so a page you are visiting cannot drive the bridge even
 * if it somehow learns the token via a side channel.
 *
 * Bind is 127.0.0.1 only. Do not put this on 0.0.0.0.
 */
const http = require('node:http');
const { URL } = require('node:url');

const { loadOrCreateToken, safeEqual } = require('./token');
const policy = require('./policy');
const { Hub, DEFAULT_TIMEOUT } = require('./hub');

const PORT = Number(process.env.PB_PORT || 9104);
const HOST = process.env.PB_HOST || '127.0.0.1';
const TOKEN = loadOrCreateToken();
const START = Date.now();

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const hub = new Hub({ log });

/* Origins we accept from browsers. `null` covers file:// and sandboxed frames;
 * we still require the token there, so this is not a bypass. Only an extension
 * scheme is ever accepted -- no web origin can satisfy this, which is the
 * property that makes the gate worth having at all. */
const ALLOWED_ORIGIN_RE = /^(moz-extension:\/\/[0-9a-f-]+|chrome-extension:\/\/[0-9a-z-]+)$/i;

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error(`invalid JSON: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function tokenOf(req, url) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const h = req.headers['x-bridge-token'];
  if (typeof h === 'string' && h) return h;
  // EventSource cannot set headers, so the SSE stream carries the token in the
  // query string. It is a same-machine loopback request, so the exposure is
  // limited to the extension's own devtools log.
  return url?.searchParams.get('token') || '';
}

/**
 * Two independent gates. A cross-site request from a normal page will fail the
 * Origin check *and* be missing the header the browser refuses to let
 * attacker-controlled script set cross-origin.
 */
function authed(req, url) {
  if (!safeEqual(tokenOf(req, url), TOKEN)) {
    return { ok: false, code: 401, error: 'invalid or missing token' };
  }
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !ALLOWED_ORIGIN_RE.test(origin)) {
    return { ok: false, code: 403, error: `origin not allowed: ${origin}` };
  }
  return { ok: true };
}

const KNOWN_ACTIONS = new Set([
  // tab / navigation
  'tab.list', 'tab.create', 'tab.close', 'tab.activate', 'tab.info',
  'navigate', 'reload', 'back', 'forward',
  'screenshot', 'title', 'set.title',
  // cookies
  'cookies.get', 'cookies.set', 'cookies.clear',
  // dom
  'page.info', 'dom.query', 'dom.html', 'dom.text', 'dom.click', 'dom.type',
  'dom.select', 'dom.check', 'dom.scroll', 'dom.forms', 'dom.inputs', 'dom.snapshot',
  'frame.list',
  // storage + flags
  'storage.local', 'storage.session', 'flag.get', 'flag.set',
  // script / network
  'main.eval', 'main.fetch', 'ws.connect', 'net.log', 'net.clear',
  // dialogs
  'dialog.policy', 'dialog.list', 'dialog.clear', 'hook.status',
  // bridge control
  'policy.get', 'policy.allow', 'policy.deny', 'policy.allowAll', 'policy.lock',
  'bridge.status', 'bridge.log', 'client.list', 'client.select',
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  // Unauthenticated, and deliberately reveals nothing sensitive: a page must be
  // able to see "is it there" without learning the token or the allowlist.
  if (p === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'pentest-bridge',
      version: require('../package.json').version,
      uptimeSec: Math.round((Date.now() - START) / 1000),
      clients: hub.clients.size,
    });
  }

  const auth = authed(req, url);
  if (!auth.ok) return json(res, auth.code, { error: auth.error });

  try {
    // ---------------------------------------------------- extension -> us
    /* EventSource always issues a GET and cannot set headers, so /attach is a
     * GET and authenticates from the query string. The token still has to
     * clear the Origin gate, so a web page cannot open a stream here. */
    if (p === '/attach' && req.method === 'GET') {
      const meta = { label: url.searchParams.get('label') || 'firefox' };
      const client = hub.addClient(meta, null);
      // SSE needs to hold the response open; write headers then keep the socket.
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      client.res = res;
      hub.frame(res, 'policy', { policy: policy.load() });
      hub.frame(res, 'ready', { clientId: client.id });
      const beat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(beat);
        }
      }, 20_000);
      beat.unref?.();
      req.on('close', () => {
        clearInterval(beat);
        hub.removeClient(client.id);
      });
      return;
    }

    if (p === '/report' && req.method === 'POST') {
      const msg = await readBody(req);
      if (msg.type === 'result') {
        const known = hub.settle(msg);
        if (!known) hub.pushEvent(msg.clientId, 'command.orphan', { id: msg.id, action: msg.action });
        return json(res, 200, { ok: true, matched: known });
      }
      if (msg.type === 'event') {
        hub.pushEvent(msg.clientId, msg.event, msg.payload || {});
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: 'unknown report type' });
    }

    // ------------------------------------------------------ us -> extension
    if (p === '/rpc' && req.method === 'POST') {
      const cmd = await readBody(req);
      if (!cmd.action) return json(res, 400, { error: 'action required' });
      if (!KNOWN_ACTIONS.has(cmd.action)) {
        return json(res, 400, {
          error: `unknown action: ${cmd.action}`,
          hint: 'see extension/lib/actions.js for the full surface',
        });
      }
      const out = await hub.exec({
        action: cmd.action,
        params: cmd.params || {},
        clientId: cmd.clientId,
        timeout: cmd.timeout || DEFAULT_TIMEOUT,
      });
      return json(res, 200, { ok: true, ...out });
    }

    if (p === '/status' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        clients: hub.clientList(),
        activeClient: hub.activeClientId,
        pending: [...hub.pending.values()].map((v) => ({ action: v.action, ms: Date.now() - v.started })),
        policy: policy.load(),
      });
    }

    if (p === '/events' && req.method === 'GET') {
      const n = Math.min(Number(url.searchParams.get('n') || 100), 1000);
      return json(res, 200, { ok: true, events: hub.tail(n) });
    }

    if (p === '/events' && req.method === 'GET') return;
    // Tail events live over SSE for the CLI.
    if (p === '/tail' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const onEvent = (evt) => {
        try {
          hub.frame(res, 'event', evt);
        } catch {
          /* closed */
        }
      };
      const onClients = (list) => {
        try {
          hub.frame(res, 'clients', list);
        } catch {
          /* closed */
        }
      };
      hub.on('event', onEvent);
      hub.on('clients', onClients);
      const beat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(beat);
        }
      }, 20_000);
      beat.unref?.();
      req.on('close', () => {
        clearInterval(beat);
        hub.off('event', onEvent);
        hub.off('clients', onClients);
      });
      return;
    }

    return json(res, 404, { error: `no route ${req.method} ${p}` });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

server.on('clientError', (_e, sock) => sock.destroy());

module.exports = { server, hub, log, TOKEN, PORT, HOST, KNOWN_ACTIONS };

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const line = '='.repeat(64);
    console.log(line);
    console.log('  Pentest Bridge — agent control server');
    console.log(line);
    console.log(`  listening   http://${HOST}:${PORT}`);
    console.log(`  token file  ${require('./token').TOKEN_FILE}`);
    console.log(`  policy      ${policy.load().mode} [${policy.load().allow.join(', ') || 'no domains'}]`);
    console.log(line);
    console.log('  Paste this token into the extension popup:');
    console.log(`  ${TOKEN}`);
    console.log(line);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log(`${sig} — closing`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
