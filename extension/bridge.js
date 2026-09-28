'use strict';
/* ISOLATED world content script.
 *
 * Two responsibilities:
 *   1. DOM primitives (click, type, snapshot, forms…) that need clean access to
 *      the document without the page's own prototypes interfering.
 *   2. A relay to the MAIN-world hook for eval / fetch / WebSocket / net log.
 *
 * The domain gate below is the important part: the script is injected on every
 * URL (the extension needs <all_urls> for its tab-level features) but it
 * refuses to do anything unless the server has enabled the current host. */
(() => {
  if (window.__PB_BRIDGE__) return;
  window.__PB_BRIDGE__ = true;

  const CH = '__PB__';
  const api = typeof browser !== 'undefined' ? browser : chrome;

  let policy = { allow: [], mode: 'lock' };
  let frameId = null;
  let tabId = null;

  const hostOf = () => PBPolicy.hostOf(location.href);
  const allowed = () => PBPolicy.isAllowed(location.href, policy);

  // ------------------------------------------------------------ MAIN-world

  let seq = 0;
  const waiting = new Map();
  /* Set by any inbound message from the MAIN world, so hook.status can tell
   * "hook never loaded" apart from "hook loaded but the relay is broken". */
  let relaySeen = false;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[CH] !== true) return;
    relaySeen = true;
    if (d.type === 'res') {
      // The id lives inside `payload`, matching the shape hook.js's post()
      // builds. Reading it off the top level silently matched undefined and
      // every reply was dropped, which presented as a 30s timeout.
      const p = d.payload || {};
      const w = waiting.get(p.id);
      if (w) { waiting.delete(p.id); clearTimeout(w.timer); w.settle(p); }
    } else if (d.type === 'net' || d.type === 'console' || d.type === 'dialog') {
      api.runtime.sendMessage({ op: 'page.event', kind: d.type, payload: d.payload, url: location.href });
    } else if (d.type === 'ready') {
      api.runtime.sendMessage({ op: 'page.ready', url: location.href });
    }
  });

  function main(action, params, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      const id = `m${++seq}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`main-world "${action}" timed out after ${timeout}ms (is the MAIN-world hook loaded? cross-origin frame?)`));
      }, timeout);
      waiting.set(id, {
        timer,
        settle: (d) => (d.ok ? resolve(d.data) : reject(new Error(d.error))),
      });
      window.postMessage({ [CH]: true, type: 'req', id, action, params }, '*');
    });
  }

  // ------------------------------------------------------------ DOM helpers

  const all = (sel) => Array.from(document.querySelectorAll(sel));
  const one = (sel) => document.querySelector(sel);

  function pick(selector, index = 0) {
    const list = all(selector);
    if (!list.length) throw new Error(`no element matches ${selector}`);
    const el = list[index];
    if (!el) throw new Error(`index ${index} out of range (${list.length} match ${selector})`);
    return el;
  }

  /** React/Vue overwrite the value setter, so assign via the native prototype
   *  setter and fire the events their synthetic-input tracker listens for. */
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function realClick(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    }
    el.click();
    el.focus?.();
  }

  const attrsOf = (el, keys) => {
    const o = {};
    for (const k of keys || ['id', 'class', 'name', 'type', 'href', 'src', 'value', 'placeholder', 'aria-label', 'role', 'data-testid']) {
      const v = el.getAttribute?.(k);
      if (v != null) o[k] = v.length > 200 ? v.slice(0, 200) + '…' : v;
    }
    return o;
  };

  // ------------------------------------------------------------- dispatcher

  const ops = {
    async 'page.info'() {
      return {
        url: location.href,
        origin: location.origin,
        title: document.title,
        readyState: document.readyState,
        isMainFrame: window === window.top,
        tabId,
        frameId,
        allowed: allowed(),
        host: hostOf(),
      };
    },

    async 'dom.query'(p) {
      const els = p.all ? all(p.selector) : [pick(p.selector, p.index || 0)];
      return els.slice(0, p.limit || 200).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.textContent || '').trim().slice(0, p.textChars || 500),
          attrs: attrsOf(el, p.attrs),
          value: 'value' in el ? el.value : undefined,
          visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden',
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      });
    },

    async 'dom.html'(p) {
      const el = p.selector ? pick(p.selector, p.index || 0) : document.documentElement;
      const html = p.outer === false ? el.innerHTML : el.outerHTML;
      return { html: html.slice(0, p.maxChars || 1_000_000), length: html.length };
    },

    async 'dom.text'(p) {
      const el = p.selector ? pick(p.selector, p.index || 0) : document.body;
      return { text: (el.innerText || el.textContent || '').slice(0, p.maxChars || 200_000) };
    },

    async 'dom.click'(p) {
      const el = pick(p.selector, p.index || 0);
      if (p.expectUrlChange) {
        const before = location.href;
        await realClick(el);
        // Navigation tears the frame down, so poll the background for the tab.
        await new Promise((r) => setTimeout(r, p.settleMs || 1200));
        return { ok: true, navigated: before, now: location.href };
      }
      await realClick(el);
      return { ok: true, tag: el.tagName.toLowerCase(), attrs: attrsOf(el) };
    },

    async 'dom.type'(p) {
      const el = pick(p.selector, p.index || 0);
      el.scrollIntoView({ block: 'center' });
      if (p.clear !== false) setValue(el, '');
      if (p.text !== undefined) {
        if (p.typing && el.focus) {
          el.focus();
          for (const ch of String(p.text)) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
            setValue(el, (el.value || '') + ch);
            el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
            await new Promise((r) => setTimeout(r, p.delay || 25));
          }
        } else {
          setValue(el, String(p.text));
        }
      }
      if (p.check !== undefined && 'checked' in el) el.checked = !!p.check;
      if (p.submit) {
        const form = el.form || el.closest('form');
        if (!form) throw new Error('no form found for submit');
        form.requestSubmit ? form.requestSubmit() : form.submit();
      }
      return { ok: true, value: 'value' in el ? el.value : undefined };
    },

    async 'dom.select'(p) {
      const el = pick(p.selector, p.index || 0);
      if (el.tagName !== 'SELECT') throw new Error(`${p.selector} is a ${el.tagName}, not a SELECT`);
      const options = Array.from(el.options).map((o, i) => ({ i, value: o.value, label: o.textContent.trim() }));
      let target = null;
      if (p.value !== undefined) target = options.find((o) => o.value === String(p.value));
      else if (p.label !== undefined) target = options.find((o) => o.label === String(p.label));
      else if (p.index !== undefined) target = options[p.index];
      if (!target) throw new Error(`no option matched ${JSON.stringify({ value: p.value, label: p.label, index: p.index })}; options=${JSON.stringify(options.slice(0, 40))}`);
      setValue(el, target.value);
      return { ok: true, selected: target, options };
    },

    async 'dom.check'(p) {
      const el = pick(p.selector, p.index || 0);
      if (!('checked' in el)) throw new Error(`${p.selector} is not checkable`);
      el.checked = !!p.checked;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, checked: el.checked };
    },

    async 'dom.scroll'(p) {
      if (p.selector) pick(p.selector, p.index || 0).scrollIntoView({ block: p.block || 'center', behavior: p.behavior || 'smooth' });
      else window.scrollBy({ top: p.y || 0, left: p.x || 0, behavior: p.behavior || 'smooth' });
      await new Promise((r) => setTimeout(r, p.settleMs || 400));
      return { ok: true, scrollY: window.scrollY, scrollX: window.scrollX };
    },

    /* Enumeration is what you actually want during recon: one call, the whole
     * attack surface of a form, instead of fifty selectors. */
    async 'dom.forms'() {
      return Array.from(document.forms).map((f, i) => ({
        index: i,
        id: f.id || undefined,
        name: f.getAttribute('name') || undefined,
        action: f.action,
        method: (f.method || 'get').toLowerCase(),
        enctype: f.enctype,
        target: f.target || undefined,
        fields: Array.from(f.elements).map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || undefined,
          name: el.getAttribute('name') || undefined,
          id: el.id || undefined,
          value: 'value' in el ? String(el.value).slice(0, 200) : undefined,
          required: el.required || undefined,
          disabled: el.disabled || undefined,
          options: el.tagName === 'SELECT'
            ? Array.from(el.options).map((o) => o.value)
            : undefined,
        })),
        submit: Array.from(f.querySelectorAll('button[type=submit],input[type=submit],button:not([type])'))
          .map((b) => (b.innerText || b.value || '').trim()).filter(Boolean),
      }));
    },

    async 'dom.inputs'() {
      return all('input, textarea, select, [contenteditable=true]').map((el, i) => ({
        index: i,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        name: el.getAttribute('name') || undefined,
        id: el.id || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        /* Values are included on purpose: checking whether the app pre-fills a
         * token, a role or an internal id is the whole point. Only ever run
         * this against targets you are authorised to test. */
        value: 'value' in el ? String(el.value).slice(0, 300) : (el.textContent || '').slice(0, 300),
        hidden: el.type === 'hidden' || el.offsetParent === null,
        inForm: !!el.closest('form'),
      }));
    },

    async 'dom.snapshot'(p) { return main('dom.snapshot', p); },

    async 'storage.local'(p) {
      if (p.clear) { localStorage.clear(); return { ok: true, cleared: true }; }
      if (p.remove) { localStorage.removeItem(p.remove); return { ok: true }; }
      if (p.key !== undefined) {
        const raw = localStorage.getItem(p.key);
        let parsed = null;
        if (raw != null) { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
        if (p.value !== undefined) {
          localStorage.setItem(p.key, typeof p.value === 'string' ? p.value : JSON.stringify(p.value));
          return { ok: true, key: p.key, stored: p.value };
        }
        return { key: p.key, raw, value: parsed };
      }
      const all_ = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        all_[k] = localStorage.getItem(k);
      }
      return { items: all_, count: Object.keys(all_).length };
    },

    async 'storage.session'(p) {
      if (p.clear) { sessionStorage.clear(); return { ok: true }; }
      if (p.remove) { sessionStorage.removeItem(p.remove); return { ok: true }; }
      if (p.key !== undefined) {
        if (p.value !== undefined) {
          sessionStorage.setItem(p.key, typeof p.value === 'string' ? p.value : JSON.stringify(p.value));
          return { ok: true, key: p.key };
        }
        const raw = sessionStorage.getItem(p.key);
        let parsed = null;
        if (raw != null) { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
        return { key: p.key, raw, value: parsed };
      }
      const all_ = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        all_[k] = sessionStorage.getItem(k);
      }
      return { items: all_, count: Object.keys(all_).length };
    },

    /* JSON-encoded cookie-like flags are how most SPAs persist feature flags
     * and impersonation switches; reading them raw is rarely enough. */
    async 'flag.get'(p) {
      if (!p.name) throw new Error('name required');
      const raw = localStorage.getItem(p.name);
      let parsed = null;
      if (raw != null) { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
      return { name: p.name, raw, value: parsed };
    },

    async 'flag.set'(p) {
      if (!p.name) throw new Error('name required');
      const store = p.store === 'session' ? sessionStorage : localStorage;
      if (p.remove) { store.removeItem(p.name); return { ok: true, removed: p.name }; }
      if (p.value === undefined) throw new Error('value or remove required');
      store.setItem(p.name, typeof p.value === 'string' ? p.value : JSON.stringify(p.value));
      return { ok: true, name: p.name, stored: p.value };
    },

    /* Diagnostics for the MAIN-world channel. The failure mode here is
     * otherwise silent and misleading: a dead hook looks exactly like a slow
     * page, and the caller gets a 30s timeout instead of a cause. */
    async 'hook.status'() {
      // Note: window.__PB_HOOK__ cannot be read from here. This script is in
      // the isolated world, which has its own `window`; a property set by
      // hook.js in the page realm is invisible to us. The only honest check
      // for a live hook is a round trip.
      let roundTrip = null;
      try {
        roundTrip = await main('ping', {}, 2000);
      } catch (err) {
        return { hookAlive: false, relaySeen, error: String(err.message || err), url: location.href };
      }
      return { hookAlive: true, relaySeen, ping: roundTrip, url: location.href };
    },

    async 'main.eval'(p) { return main('main.eval', p, p.timeout || 30_000); },
    async 'main.fetch'(p) { return main('main.fetch', p, p.timeout || 60_000); },
    async 'ws.connect'(p) { return main('ws.connect', p, (p.timeout || 5000) + 5000); },
    async 'net.log'(p) { return main('net.log', p); },
    async 'net.clear'() { return main('net.clear', {}); },

    async 'frame.list'() {
      return { url: location.href, isMainFrame: window === window.top, tabId, frameId };
    },

    async 'set.title'(p) {
      document.title = p.title;
      return { title: document.title };
    },

    async 'dialog.policy'(p) { return main('dialog.policy', p); },
    async 'dialog.list'() { return main('dialog.list', {}); },
    async 'dialog.clear'() { return main('dialog.clear', {}); },
  };

  // ------------------------------------------------------- MAIN-world hook

  /*
   * The MAIN-world half is injected by hand rather than declared in the
   * manifest. `content_scripts[].world: "MAIN"` is not honoured for MV2 in
   * Firefox, so hook.js silently never ran and every main.* command timed out
   * with a misleading "cross-origin frame?" error. Appending a
   * <script src=moz-extension://...> tag runs in the page's own realm on every
   * supported version; the manifest lists hook.js as a web-accessible resource.
   */
  function injectHook() {
    if (window.__PB_HOOK__) return;
    try {
      const s = document.createElement('script');
      s.src = api.runtime.getURL('hook.js');
      s.async = false;
      s.dataset.pb = 'hook';
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (err) {
      console.warn('[pentest-bridge] MAIN-world hook injection failed:', err);
    }
  }

  injectHook();

  // -------------------------------------------------------------- messaging

  /* Announce this frame so the background can route commands into iframes.
   * `sender` carries tabId/frameId, so no extra permission is needed. */
  api.runtime.sendMessage({ op: 'frame.hello', url: location.href }).then((r) => {
    tabId = r?.tabId ?? null;
    frameId = r?.frameId ?? null;
  }).catch(() => { /* background not ready; commands will still work in top frame */ });

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg.op === 'frame.hello') {
        tabId = msg.tabId;
        frameId = msg.frameId;
        sendResponse({ ok: true, tabId, frameId, url: location.href });
        return;
      }
      if (msg.op === 'policy.set') {
        policy = msg.policy || { allow: [], mode: 'lock' };
        sendResponse({ ok: true, allowed: allowed(), policy });
        return;
      }
      if (msg.op === 'page.call') {
        if (!allowed()) {
          throw new Error(
            `domain "${hostOf() || '(unknown)'}" is not enabled for this bridge. ` +
            `From the agent side run: bridge allow ${hostOf() || '<host>'} ` +
            `(or bridge allow-all to open up the whole browser)`
          );
        }
        const fn = ops[msg.action];
        if (!fn) throw new Error(`no such page action: ${msg.action}`);
        sendResponse({ ok: true, data: await fn(msg.params || {}) });
        return;
      }
      sendResponse({ ok: false, error: `unknown op: ${msg.op}` });
    })().catch((err) => {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    });
    return true; // async
  });
})();
