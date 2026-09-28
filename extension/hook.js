'use strict';
/* MAIN world. Runs before page scripts so the instrumentation is in place for
 * the very first request the document makes. Everything here stays in the
 * page's own JS realm on purpose: eval, same-origin fetch and WebSocket
 * construction must look like the page made them, or CORS and cookie scoping
 * will differ from what the target expects. */
(() => {
  if (window.__PB_HOOK__) return;
  window.__PB_HOOK__ = true;

  const CH = '__PB__';
  const log = [];
  let seq = 0;
  const MAX = 500;

  const post = (type, payload) => {
    try {
      window.postMessage({ [CH]: true, type, payload }, '*');
    } catch {
      /* structured clone failure; never let logging break the page */
    }
  };

  const summarize = (v) => {
    if (v == null) return v;
    const t = typeof v;
    if (t === 'string') return v.length > 4096 ? v.slice(0, 4096) + `…[+${v.length - 4096}]` : v;
    if (t === 'object') {
      try {
        const s = JSON.stringify(v);
        return s.length > 4096 ? s.slice(0, 4096) + '…' : s;
      } catch {
        return '[unserializable]';
      }
    }
    return v;
  };

  const record = (entry) => {
    entry.id = ++seq;
    entry.t = Date.now();
    log.push(entry);
    if (log.length > MAX) log.shift();
    post('net', entry);
  };

  const urlOf = (u) => {
    try {
      return new URL(String(u), location.href).href;
    } catch {
      return String(u);
    }
  };

  const headersOf = (h) => {
    const out = {};
    if (!h) return out;
    try {
      if (typeof h.forEach === 'function' && typeof h.get === 'function') {
        h.forEach((v, k) => { out[k] = v; });
        return out;
      }
      if (Array.isArray(h)) for (const [k, v] of h) out[k] = v;
      else for (const k of Object.keys(h)) out[k] = h[k];
    } catch {
      /* exotic Headers */
    }
    return out;
  };

  // ------------------------------------------------------------------ fetch

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function pbFetch(input, init) {
      const started = performance.now();
      const url = urlOf(input && input.url ? input.url : input);
      const method = (init && init.method) || (input && input.method) || 'GET';
      const headers = headersOf((init && init.headers) || (input && input.headers));
      const rec = {
        kind: 'fetch',
        url,
        method: String(method).toUpperCase(),
        reqHeaders: headers,
        reqBody: summarize(init && init.body),
        credentials: (init && init.credentials) || (input && input.credentials) || 'same-origin',
      };
      return origFetch.apply(this, arguments).then(
        (res) => {
          rec.status = res.status;
          rec.resHeaders = headersOf(res.headers);
          rec.type = res.type;
          rec.ms = Math.round(performance.now() - started);
          record(rec);
          return res;
        },
        (err) => {
          rec.error = String(err && err.message ? err.message : err);
          rec.ms = Math.round(performance.now() - started);
          record(rec);
          throw err;
        }
      );
    };
  }

  // -------------------------------------------------------------------- XHR

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function pbOpen(method, url) {
    this.__pb = { method: String(method).toUpperCase(), url: urlOf(url), reqHeaders: {} };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function pbSetHeader(k, v) {
    if (this.__pb) this.__pb.reqHeaders[k] = v;
    return origSetHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function pbSend(body) {
    const meta = this.__pb || { method: 'GET', url: '', reqHeaders: {} };
    const started = performance.now();
    const xhr = this;
    const done = () => {
      record({
        kind: 'xhr',
        url: meta.url,
        method: meta.method,
        reqHeaders: meta.reqHeaders,
        reqBody: summarize(body),
        status: xhr.status,
        resHeaders: (() => {
          const o = {};
          const raw = String(xhr.getAllResponseHeaders() || '').trim();
          for (const line of raw.split(/[\r\n]+/)) {
            const i = line.indexOf(':');
            if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
          }
          return o;
        })(),
        responseText: summarize(safeText(xhr)),
        ms: Math.round(performance.now() - started),
      });
    };
    // Response text of a huge download would be captured twice and stall the
    // renderer, so only read it for non-binary and non-huge responses.
    function safeText(x) {
      try {
        const ct = (x.getResponseHeader('content-type') || '').toLowerCase();
        if (/image|video|audio|font|zip|gzip|octet-stream|protobuf/.test(ct)) return null;
        const len = Number(x.getResponseHeader('content-length') || 0);
        if (len > 512 * 1024) return null;
        return x.responseType === '' || x.responseType === 'text' ? x.responseText : null;
      } catch {
        return null;
      }
    }
    this.addEventListener('loadend', done, { once: true });
    return origSend.apply(this, arguments);
  };

  // -------------------------------------------------------------- WebSocket

  const OrigWS = window.WebSocket;
  if (typeof OrigWS === 'function') {
    const Patched = function pbWebSocket(url, protocols) {
      const ws = new OrigWS(url, protocols);
      const rec = { kind: 'ws', url: urlOf(url), frames: [] };
      record(rec);
      ws.addEventListener('message', (e) => {
        rec.frames.push({ dir: 'in', at: Date.now(), data: summarize(e.data) });
        if (rec.frames.length > 50) rec.frames.shift();
        post('net', rec);
      });
      const origSendFn = ws.send.bind(ws);
      ws.send = function pbSend(data) {
        rec.frames.push({ dir: 'out', at: Date.now(), data: summarize(data) });
        if (rec.frames.length > 50) rec.frames.shift();
        post('net', rec);
        return origSendFn(data);
      };
      return ws;
    };
    Patched.prototype = OrigWS.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Patched[k] = OrigWS[k];
    window.WebSocket = Patched;
  }

  // ------------------------------------------------------- beacon / eventsrc

  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function pbBeacon(url, data) {
      record({ kind: 'beacon', url: urlOf(url), method: 'POST', reqBody: summarize(data) });
      return origBeacon(url, data);
    };
  }

  const OrigES = window.EventSource;
  if (typeof OrigES === 'function') {
    const PatchedES = function pbEventSource(url, cfg) {
      record({ kind: 'sse', url: urlOf(url) });
      return new OrigES(url, cfg);
    };
    PatchedES.prototype = OrigES.prototype;
    window.EventSource = PatchedES;
  }

  // ---------------------------------------------------------------- dialogs
  //
  // Firefox exposes no WebExtension hook for alert/confirm/prompt, and the
  // CDP-style ones are not available to extensions here either. So we shadow
  // them in the page realm. They must stay SYNCHRONOUS: confirm() has to
  // return a boolean to the caller right now, so we answer from a policy the
  // agent sets up-front instead of blocking on a round trip. Every dialog is
  // still recorded and pushed, so nothing is silently swallowed.
  const dialogs = [];
  let answer = { accept: true, promptText: '' };
  let suppressBeforeUnload = false;

  const recordDialog = (type, message, defaultValue) => {
    const d = { id: ++seq, type, message: String(message ?? ''), defaultValue, at: Date.now() };
    dialogs.push(d);
    if (dialogs.length > MAX) dialogs.shift();
    post('dialog', d);
    return d;
  };

  const origAlert = window.alert;
  window.alert = function pbAlert(message) {
    recordDialog('alert', message, undefined);
    return undefined;
  };
  void origAlert;

  const origConfirm = window.confirm;
  window.confirm = function pbConfirm(message) {
    recordDialog('confirm', message, undefined);
    return !!answer.accept;
  };
  void origConfirm;

  const origPrompt = window.prompt;
  window.prompt = function pbPrompt(message, dflt) {
    recordDialog('prompt', message, dflt);
    return answer.promptText != null && answer.promptText !== '' ? String(answer.promptText) : dflt;
  };
  void origPrompt;

  // Capturing listener runs before page handlers, so suppression is reliable.
  window.addEventListener(
    'beforeunload',
    (e) => {
      if (suppressBeforeUnload) {
        e.stopImmediatePropagation();
        delete e.returnValue;
        return '';
      }
    },
    true
  );

  // ---------------------------------------------------------------- console

  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = function pbConsole(...args) {
      post('console', {
        level,
        text: args.map((a) => (typeof a === 'string' ? a : summarize(a))).join(' ').slice(0, 2000),
      });
      return orig(...args);
    };
  }

  // --------------------------------------------------------- request router

  const nativeFetch = window.fetch;

  async function rpc(id, action, params) {
    switch (action) {
      case 'ping':
        return { url: location.href, injected: true };
      case 'net.log':
        return {
          entries: params?.clear ? (log.length = 0, []) : log.slice(),
          total: log.length,
        };
      case 'net.clear':
        log.length = 0;
        return { ok: true };
      case 'main.eval': {
        // indirect eval => global scope, so `document`/`window` resolve normally.
        const result = (0, eval)(params.expression);
        if (params.await && result && typeof result.then === 'function') {
          return await result;
        }
        return result;
      }
      case 'main.fetch': {
        const res = await nativeFetch.call(window, params.url, {
          method: params.method || 'GET',
          headers: params.headers || undefined,
          body: params.body,
          credentials: params.credentials || 'include',
          mode: params.mode || undefined,
          redirect: params.redirect || 'follow',
          referrer: params.referrer,
        });
        const text = await res.text();
        return {
          status: res.status,
          statusText: res.statusText,
          url: res.url,
          headers: headersOf(res.headers),
          body: text.length > 2_000_000 ? text.slice(0, 2_000_000) + '…' : text,
        };
      }
      case 'ws.connect': {
        return await new Promise((resolve) => {
          const ws = new OrigWS(params.url, params.protocols || undefined);
          const frames = [];
          const done = (state, extra) => {
            resolve({ state, url: params.url, frames, ...(extra || {}) });
            try { ws.close(); } catch { /* already closed */ }
          };
          const timer = setTimeout(() => done('timeout'), Math.min(params.timeout || 5000, 60_000));
          ws.addEventListener('open', () => post('net', { kind: 'ws-open', url: params.url }));
          ws.addEventListener('message', (e) => {
            frames.push({ dir: 'in', data: summarize(e.data) });
            post('net', { kind: 'ws', url: params.url, frames: frames.slice(-10) });
            if (params.expect !== undefined) {
              if (params.expect > 0) {
                params.expect -= 1;
                if (params.send !== undefined) ws.send(params.send);
              } else {
                clearTimeout(timer);
                done('message');
              }
            }
          });
          ws.addEventListener('error', () => {
            clearTimeout(timer);
            done('error', { note: 'WebSocket error (likely CORS/origin or refused)' });
          });
          ws.addEventListener('close', (e) => {
            clearTimeout(timer);
            if (e.wasClean) done('closed');
          });
          if (params.send !== undefined) ws.send(params.send);
        });
      }
      case 'dom.snapshot': {
        return domSnapshot(params);
      }
      case 'dialog.policy': {
        answer = {
          accept: params?.accept !== false,
          promptText: params?.promptText ?? '',
        };
        suppressBeforeUnload = !!params?.suppressBeforeUnload;
        return { answer, suppressBeforeUnload };
      }
      case 'dialog.list': {
        return { dialogs, count: dialogs.length, answer, suppressBeforeUnload };
      }
      case 'dialog.clear': {
        dialogs.length = 0;
        return { ok: true };
      }
      case 'set.title': {
        document.title = params.title;
        return { title: document.title };
      }
      default:
        throw new Error(`main-world handler has no action "${action}"`);
    }
  }

  function domSnapshot(params) {
    const max = params?.maxChars || 60_000;
    const root = params?.selector ? document.querySelector(params.selector) : document.body;
    if (!root) return { text: '', truncated: false, nodes: 0 };
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS']);
    let out = '';
    let nodes = 0;
    const walk = (el, depth) => {
      if (nodes > 4000 || out.length > max) return;
      if (el.nodeType === 3) {
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        if (t) { out += '  '.repeat(depth) + t + '\n'; nodes++; }
        return;
      }
      if (el.nodeType !== 1 || SKIP.has(el.tagName)) return;
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0;
      const label = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
      const attrs = [];
      for (const a of ['name', 'type', 'href', 'src', 'value', 'placeholder', 'role', 'aria-label']) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v) attrs.push(`${a}="${String(v).slice(0, 120)}"`);
      }
      out += '  '.repeat(depth) + `<${label}${id}${cls}${attrs.length ? ' ' + attrs.join(' ') : ''}>` +
             (visible ? '' : ' [hidden]') + '\n';
      nodes++;
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(root, 0);
    return { text: out.slice(0, max), truncated: out.length > max, nodes };
  }

  // Transport to the isolated-world content script. Request ids are namespaced
  // per direction so the two channels cannot collide.
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[CH] !== true || d.type !== 'req') return;
    const { id, action, params } = d;
    try {
      const data = await rpc(id, action, params);
      post('res', { id, ok: true, data });
    } catch (err) {
      post('res', { id, ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  // Tell the bridge we are alive so it can fail fast with a useful message
  // instead of waiting for a timeout.
  post('ready', { url: location.href });
})();
