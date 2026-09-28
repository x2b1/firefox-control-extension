'use strict';
/* Background page (persistent).
 *
 * Owns the single upstream connection to the agent server, routes each
 * command to the right tab and frame, and funnels every result back. Also
 * handles the things a content script cannot: tab lifecycle, cookies, the
 * omnibox, screenshots, and alert/confirm/prompt. */
const api = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULTS = { host: '127.0.0.1', port: 9104 };
/** Frames we have seen, so a command can target an iframe rather than the top page. */
const frames = new Map(); // key `${tabId}:${frameId}` -> { tabId, frameId, url }
const state = {
  token: '',
  connected: false,
  clientId: null,
  label: 'firefox',
  policy: { allow: [], mode: 'lock' },
  lastError: null,
  commands: 0,
  events: 0,
};

const nowStamp = () => new Date().toISOString().slice(11, 23);
const setBadge = (text, color) => {
  try {
    api.browserAction.setBadgeText({ text });
    if (color) api.browserAction.setBadgeBackgroundColor({ color });
  } catch { /* popup-only contexts */ }
};

const rememberFrame = (tabId, frameId, url) => {
  if (Number.isInteger(tabId)) frames.set(`${tabId}:${frameId}`, { tabId, frameId, url });
};
const forgetTabFrames = (tabId) => {
  for (const [k, v] of frames) if (v.tabId === tabId) frames.delete(k);
};

// ---------------------------------------------------------------- upstream

let source = null;
let retry = 0;
let retryTimer = null;

function baseUrl() {
  return `http://${DEFAULTS.host}:${DEFAULTS.port}`;
}

async function send(path, body) {
  const res = await fetch(baseUrl() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': state.token },
    body: JSON.stringify({ ...body, clientId: state.clientId }),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function setConnected(on, err) {
  state.connected = on;
  state.lastError = err || null;
  setBadge(on ? 'ON' : 'OFF', on ? '#1f9d55' : '#c0392b');
  api.storage.local.set({ connected: on, lastError: state.lastError });
  api.runtime.sendMessage({ op: 'bridge.status' }).catch(() => {});
}

function connect() {
  if (source) { try { source.close(); } catch { /* noop */ } source = null; }
  if (!state.token) { setConnected(false, 'no token set'); return; }
  if (state.clientId) return; // already attached

  // EventSource cannot set headers, so the token rides in the query string.
  const url = `${baseUrl()}/attach?token=${encodeURIComponent(state.token)}&label=${encodeURIComponent(state.label)}`;
  const es = new EventSource(url);
  source = es;

  es.addEventListener('ready', (ev) => {
    retry = 0;
    const d = JSON.parse(ev.data);
    state.clientId = d.clientId;
    setConnected(true, null);
    console.log(`[pentest-bridge] attached as ${d.clientId}`);
    api.runtime.sendMessage({ op: 'bridge.policy', policy: state.policy }).catch(() => {});
  });

  es.addEventListener('policy', (ev) => {
    state.policy = JSON.parse(ev.data).policy || state.policy;
    pushPolicyToTabs().catch(() => {});
    api.runtime.sendMessage({ op: 'bridge.policy', policy: state.policy }).catch(() => {});
  });

  es.addEventListener('command', (ev) => {
    const cmd = JSON.parse(ev.data);
    handle(cmd).catch((err) => {
      report({ id: cmd.id, action: cmd.action, ok: false, error: String(err && err.message ? err.message : err) });
    });
  });

  es.addEventListener('error', () => {
    // EventSource fires `error` on both transient drops and permanent refusal;
    // only tear down when it is genuinely closed, otherwise we fight our own
    // reconnect logic.
    if (es.readyState === EventSource.CLOSED) {
      const wasConnected = state.connected;
      detachLocal();
      setConnected(false, wasConnected ? 'disconnected from agent' : `cannot reach ${baseUrl()}`);
      scheduleReconnect();
    }
  });
}

function scheduleReconnect() {
  if (retryTimer) return;
  const delay = Math.min(1000 * 2 ** retry++, 15_000);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function detachLocal() {
  if (source) { try { source.close(); } catch { /* noop */ } }
  source = null;
  state.clientId = null;
}

async function report(payload) {
  try {
    await send('/report', { type: 'result', ...payload });
  } catch (err) {
    console.warn('[pentest-bridge] could not report result:', err.message);
  }
}

async function pushEvent(event, payload) {
  state.events += 1;
  try {
    await send('/report', { type: 'event', event, payload });
  } catch {
    /* upstream gone; drop the event rather than growing an unbounded queue */
  }
}

// ------------------------------------------------------------ policy push

async function pushPolicyToTabs() {
  const tabs = await api.tabs.query({});
  await Promise.all(
    tabs.map((t) =>
      api.tabs
        .sendMessage(t.id, { op: 'policy.set', policy: state.policy })
        .catch(() => {})
    )
  );
}

// ------------------------------------------------------------- frame index

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    forgetTabFrames(tabId);
    pushEvent('tab.changed', { tabId, url: tab.url, status: changeInfo.status }).catch(() => {});
  }
  api.tabs
    .sendMessage(tabId, { op: 'policy.set', policy: state.policy })
    .catch(() => {});
});

api.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await api.tabs.get(tabId).catch(() => null);
  setBadge(state.connected ? 'ON' : 'OFF', state.connected ? '#1f9d55' : '#c0392b');
  pushEvent('tab.activated', { tabId, url: tab?.url }).catch(() => {});
});

api.tabs.onRemoved.addListener((tabId) => {
  forgetTabFrames(tabId);
  pushEvent('tab.removed', { tabId }).catch(() => {});
});

/* The content script announces itself so background knows which frameId belongs
 * to which tab. `sender` carries the ids for free, so this needs no extra
 * permission. */
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.op === 'frame.hello') {
    rememberFrame(sender.tab?.id, sender.frameId, msg.url);
    sendResponse({ ok: true, tabId: sender.tab?.id, frameId: sender.frameId });
  }
  return false;
});

// ------------------------------------------------------- dialogs / popups
//
// Handled entirely in the MAIN-world hook (see hook.js) because Firefox gives
// extensions no event for alert/confirm/prompt. This side only sets the answer
// policy and reads back what the page actually raised.

// ------------------------------------------------------- command dispatch

async function callContent(tabId, frameId, action, params) {
  const target = { frameId: frameId == null ? 0 : frameId };
  const msg = { op: 'page.call', action, params: params || {} };
  let lastErr = null;
  /* Retry with backoff: a command issued right after navigation can arrive
   * before the content script has registered in the new document, which shows
   * up as "Receiving end does not exist" rather than as a slow page. */
  const backoff = [150, 300, 600, 1000, 1500];
  for (let attempt = 0; attempt < backoff.length; attempt++) {
    try {
      const res = await api.tabs.sendMessage(tabId, msg, target);
      if (res?.ok) return res.data;
      lastErr = new Error(res?.error || 'content script returned an error');
      // A real error from the page (no such element, and so on) will not fix
      // itself on retry; only a missing receiver is worth waiting out.
      if (!/receiving end does not exist|message manager disconnected|context invalidated/i.test(lastErr.message)) break;
    } catch (err) {
      lastErr = err;
      if (!/receiving end does not exist|message manager disconnected|Extension context invalidated/i.test(err.message)) break;
    }
    await new Promise((r) => setTimeout(r, backoff[attempt]));
  }
  if (/receiving end does not exist/i.test(lastErr?.message || '')) {
    throw new Error(
      `${action}: no content script in tab ${tabId}${frameId ? ` frame ${frameId}` : ''} after ${backoff.length} attempts. ` +
      `The page may still be loading, or the bridge may need reloading.`
    );
  }
  throw lastErr || new Error('content script did not respond');
}

async function activeTabId() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  return tab.id;
}

async function resolveTab(params) {
  return params.tabId != null ? params.tabId : activeTabId();
}

/** Find the deepest frame in a tab whose URL matches, for iframe targeting. */
function findFrame(tabId, matcher) {
  for (const f of frames.values()) {
    if (f.tabId !== tabId) continue;
    if (!matcher || (f.url && f.url.includes(matcher))) return f;
  }
  return null;
}

const TABLESS = new Set(['tab.list', 'tab.create', 'client.list', 'client.select', 'policy.get', 'policy.allow', 'policy.deny', 'policy.allowAll', 'policy.lock', 'bridge.status', 'bridge.log']);
void TABLESS; // documented list of actions that do not need a tab; dispatch() short-circuits them above

/* --------------------------------------------------------------- policy
 *
 * The content script gates page-level actions itself, but tab-level actions
 * never reach it -- so they need their own gate. Otherwise cookies.get and
 * screenshot read any site in the profile regardless of the allow list.
 *
 * Matching lives in lib/policy.js so there is one implementation of the
 * subdomain rule, and it is unit-tested. */

const hostOfUrl = (u) => PBPolicy.hostOf(u);
const hostAllowed = (url) => PBPolicy.isAllowed(url, state.policy);

/** Throws unless the target tab's host is enabled. */
async function assertAllowedTab(params, action) {
  const tabId = await resolveTab(params);
  const tab = await api.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error(`tab ${tabId} does not exist`);
  if (!hostAllowed(tab.url)) {
    const host = hostOfUrl(tab.url) || '(unknown)';
    throw new Error(
      `${action} is blocked: tab ${tabId} is on "${host}", which is not enabled. ` +
      `Run: bridge allow ${host}   (or: bridge allow-all to open up the whole browser)`
    );
  }
  return tabId;
}

/** Actions that expose page or session content, and so need an allowed tab. */
const NEEDS_ALLOWED_TAB = new Set([
  'screenshot', 'title', 'set.title',
  'cookies.get', 'cookies.set', 'cookies.clear',
  'dialog.policy', 'dialog.list', 'dialog.clear',
]);

async function handle(cmd) {
  const { id, action, params = {} } = cmd;
  state.commands += 1;
  const started = Date.now();
  try {
    const data = await dispatch(action, params);
    /* Report the value as-is. An earlier version did `{ ...data, _ms }` to
     * attach a duration, but spreading a primitive silently mangles it:
     * {...2} is {} and {...'abc'} is {0:'a',1:'b',2:'c'}. main.eval returns
     * whatever the expression produced, so strings and numbers are normal
     * results and must survive intact. Timing is measured server-side. */
    report({ id, action, ok: true, data });
  } catch (err) {
    report({ id, action, ok: false, error: String(err && err.message ? err.message : err) });
  }
  void started;
}

async function dispatch(action, params) {
  // ------------------------------------------------------ local, no tab needed
  switch (action) {
    case 'bridge.status':
      return {
        connected: state.connected,
        clientId: state.clientId,
        label: state.label,
        policy: state.policy,
        commands: state.commands,
        events: state.events,
        lastError: state.lastError,
        knownFrames: [...frames.values()].slice(0, 100),
        actions: Object.keys(PAGE_ACTIONS).concat(Object.keys(TAB_ACTIONS)),
      };
    case 'bridge.log':
      return { lines: ['background log is not persisted; use /events for the live stream'] };
    case 'client.list':
      return { clients: [] };
    case 'policy.get':
      return { policy: state.policy };
    case 'policy.allow':
      state.policy.allow = [...new Set([...state.policy.allow, String(params.host).toLowerCase()])];
      await pushPolicyToTabs();
      return { policy: state.policy };
    case 'policy.deny':
      state.policy.allow = state.policy.allow.filter((h) => h !== String(params.host).toLowerCase());
      await pushPolicyToTabs();
      return { policy: state.policy };
    case 'policy.allowAll':
      state.policy.mode = 'allow-all';
      await pushPolicyToTabs();
      return { policy: state.policy };
    case 'policy.lock':
      state.policy = { allow: [], mode: 'lock' };
      await pushPolicyToTabs();
      return { policy: state.policy };
    default:
      break;
  }

  // ------------------------------------------------------------- tab-level
  if (TAB_ACTIONS[action]) {
    if (NEEDS_ALLOWED_TAB.has(action)) await assertAllowedTab(params, action);
    return await TAB_ACTIONS[action](params);
  }

  // ------------------------------------------------------------ page-level
  if (PAGE_ACTIONS[action]) {
    const tabId = await resolveTab(params);
    const frame = params.frameUrl ? findFrame(tabId, params.frameUrl) : null;
    if (params.frameUrl && !frame) {
      throw new Error(`no loaded frame matching "${params.frameUrl}" in tab ${tabId}. Known frames: ${JSON.stringify([...frames.values()].filter((f) => f.tabId === tabId).map((f) => f.url))}`);
    }
    return await callContent(tabId, frame ? frame.frameId : 0, action, params);
  }

  throw new Error(`unknown action: ${action}`);
}

// ---------------------------------------------------------------- tab ops

const TAB_ACTIONS = {
  async 'tab.list'(p) {
    const tabs = await api.tabs.query({});
    const open = p.reveal === true || state.policy.mode === 'allow-all';
    return {
      reveal: open,
      tabs: tabs.map((t) => {
        // A gated tab is reduced to its host: enough to enable it, without
        // handing out the full URL of every inbox you have open.
        const allowed = hostAllowed(t.url);
        return {
          id: t.id,
          index: t.index,
          active: t.active,
          windowId: t.windowId,
          status: t.status,
          host: hostOfUrl(t.url) || null,
          allowed,
          url: open || allowed ? t.url : undefined,
          title: open || allowed ? t.title : undefined,
        };
      }),
    };
  },
  async 'tab.create'(p) {
    const t = await api.tabs.create({ url: p.url, active: p.active !== false, index: p.index });
    return { tabId: t.id, url: t.url, pendingUrl: t.pendingUrl };
  },
  async 'tab.close'(p) {
    const id = await resolveTab(p);
    await api.tabs.remove(id);
    return { closed: id };
  },
  async 'tab.activate'(p) {
    const id = p.tabId != null ? p.tabId : (await activeTabId());
    const tab = await api.tabs.get(id);
    await api.tabs.update(id, { active: true });
    if (tab.windowId) await api.windows.update(tab.windowId, { focused: true });
    return { activated: id };
  },
  async 'tab.info'(p) {
    const id = await resolveTab(p);
    const t = await api.tabs.get(id);
    return { id: t.id, url: t.url, title: t.title, status: t.status, active: t.active, windowId: t.windowId };
  },
  async 'navigate'(p) {
    const id = await resolveTab(p);
    const url = /^https?:|^about:|^data:|^file:/i.test(p.url) ? p.url : `https://${p.url}`;
    await api.tabs.update(id, { url });
    if (p.waitMs !== 0) {
      const deadline = Date.now() + (p.timeout || 20_000);
      let last;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        last = await api.tabs.get(id).catch(() => null);
        if (last?.status === 'complete') break;
      }
      if (p.expectHost && last?.url && !new URL(last.url).hostname.includes(p.expectHost)) {
        throw new Error(`landed on ${last.url}, expected host containing "${p.expectHost}" (possible redirect or block page)`);
      }
      return { tabId: id, url: last?.url, title: last?.title, status: last?.status };
    }
    return { tabId: id, navigating: true };
  },
  async 'reload'(p) {
    const id = await resolveTab(p);
    await api.tabs.reload(id, { bypassCache: !!p.bypassCache });
    return { reloaded: id };
  },
  async 'back'(p) { const id = await resolveTab(p); await api.tabs.goBack(id); return { tabId: id }; },
  async 'forward'(p) { const id = await resolveTab(p); await api.tabs.goForward(id); return { tabId: id }; },
  async 'title'(p) {
    const id = await resolveTab(p);
    return { title: (await api.tabs.get(id)).title };
  },
  async 'set.title'(p) {
    const id = await resolveTab(p);
    await callContent(id, 0, 'set.title', p);
    return { ok: true };
  },
  async 'screenshot'(p) {
    const id = await resolveTab(p);
    const dataUrl = await api.tabs.captureVisibleTab(p.windowId, { format: p.format || 'png' });
    return { dataUrl, bytes: dataUrl.length, windowId: p.windowId };
  },
  async 'cookies.get'(p) {
    if (p.domain) {
      // An explicit domain is a deliberate request; it already passed the
      // allowed-tab check, but the domain itself must also be enabled.
      if (!hostAllowed(`https://${p.domain.replace(/^\./, '')}`)) {
        throw new Error(`cookies.get is blocked: "${p.domain}" is not an enabled domain`);
      }
    }
    const cookies = await api.cookies.getAll(p.domain ? { domain: p.domain } : {});
    // With no domain, the result is filtered to enabled hosts rather than
    // returned wholesale -- otherwise this walks the entire cookie jar.
    const visible = p.domain
      ? cookies
      : cookies.filter((c) => hostAllowed(`https://${c.domain.replace(/^\./, '')}`));
    const withheld = cookies.length - visible.length;
    return {
      count: visible.length,
      withheldByPolicy: p.domain ? 0 : withheld,
      cookies: visible.map((c) => ({
        name: c.name, value: p.includeValues === false ? `<${String(c.value).length}b>` : c.value,
        domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
        sameSite: c.sameSite, hostOnly: c.hostOnly, session: c.session,
        expirationDate: c.expirationDate, storeId: c.storeId,
      })),
    };
  },
  async 'cookies.set'(p) {
    if (!p.url) throw new Error('cookies.set needs a url');
    if (!hostAllowed(p.url)) {
      throw new Error(`cookies.set is blocked: "${hostOfUrl(p.url)}" is not an enabled domain`);
    }
    const c = await api.cookies.set({
      url: p.url, name: p.name, value: p.value, path: p.path || '/',
      secure: !!p.secure, httpOnly: !!p.httpOnly,
      sameSite: p.sameSite || 'unspecified',
      expirationDate: p.expiration,
    });
    if (!c) throw new Error('cookies.set rejected (check url/sameSite combination)');
    return { ok: true, cookie: { name: c.name, domain: c.domain, path: c.path, secure: c.secure } };
  },
  async 'cookies.clear'(p) {
    if (p.domain && !hostAllowed(`https://${p.domain.replace(/^\./, '')}`)) {
      throw new Error(`cookies.clear is blocked: "${p.domain}" is not an enabled domain`);
    }
    const all = await api.cookies.getAll(p.domain ? { domain: p.domain } : {});
    // Never bulk-delete outside the enabled set: a stray cookies.clear with no
    // domain would otherwise log the user out of every site in the profile.
    const cookies = p.domain ? all : all.filter((c) => hostAllowed(`https://${c.domain.replace(/^\./, '')}`));
    const removed = [];
    for (const c of cookies) {
      const scheme = c.secure ? 'https' : 'http';
      const host = c.domain.replace(/^\./, '');
      const ok = await api.cookies.remove({
        url: `${scheme}://${host}${c.path}`, name: c.name, storeId: c.storeId,
        firstPartyDomain: c.firstPartyDomain,
      });
      if (ok) removed.push(`${c.domain} ${c.name}`);
    }
    return {
      removed: removed.length,
      cookies: removed,
      withheldByPolicy: all.length - cookies.length,
    };
  },
  async 'dialog.policy'(p) {
    const id = await resolveTab(p);
    return callContent(id, 0, 'dialog.policy', p);
  },
  async 'dialog.list'(p) {
    const id = await resolveTab(p);
    return callContent(id, 0, 'dialog.list', p);
  },
  async 'dialog.clear'(p) {
    const id = await resolveTab(p);
    return callContent(id, 0, 'dialog.clear', p);
  },
};

const PAGE_ACTIONS = {
  'page.info': 1, 'dom.query': 1, 'dom.html': 1, 'dom.text': 1, 'dom.click': 1,
  'dom.type': 1, 'dom.select': 1, 'dom.check': 1, 'dom.scroll': 1, 'dom.forms': 1,
  'dom.inputs': 1, 'dom.snapshot': 1, 'storage.local': 1, 'storage.session': 1,
  'flag.get': 1, 'flag.set': 1, 'main.eval': 1, 'main.fetch': 1, 'ws.connect': 1,
  'net.log': 1, 'net.clear': 1, 'frame.list': 1, 'set.title': 1,
  'dialog.policy': 1, 'dialog.list': 1, 'dialog.clear': 1, 'hook.status': 1,
};

// ------------------------------------------------------------ boot / popup

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.op) {
      case 'bridge.configure': {
        state.token = String(msg.token || '').trim();
        state.label = String(msg.label || 'firefox');
        await api.storage.local.set({ token: state.token, label: state.label });
        if (state.token) connect();
        sendResponse({ ok: true, connected: state.connected, tokenSet: !!state.token });
        return;
      }
      case 'bridge.disconnect': {
        detachLocal();
        setConnected(false, 'disconnected by user');
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        sendResponse({ ok: true });
        return;
      }
      case 'bridge.status':
        sendResponse({ ok: true, state: { ...state, frames: frames.size } });
        return;
      case 'bridge.test': {
        try {
          const res = await fetch(baseUrl() + '/health');
          const body = await res.json();
          sendResponse({ ok: true, health: body });
        } catch (err) {
          sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
        }
        return;
      }
      case 'bridge.probeActiveTab': {
        // Popup convenience: prove the gate works on the tab you are looking at.
        const id = await activeTabId();
        try {
          const info = await callContent(id, 0, 'page.info', {});
          sendResponse({ ok: true, info: `${info.host} — ${info.allowed ? 'ENABLED' : 'blocked by policy'}` });
        } catch (err) {
          sendResponse({ ok: false, error: String(err.message || err) });
        }
        return;
      }
      default:
        sendResponse({ ok: false, error: `unknown op: ${msg.op}` });
    }
  })().catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true;
});

(async () => {
  const stored = await api.storage.local.get(['token', 'label']);
  state.token = stored.token || '';
  state.label = stored.label || `firefox-${(new Date()).toISOString().slice(0, 10)}`;
  setBadge('OFF', '#95a5a6');
  if (state.token) connect();
})();

/* React to the token changing underneath us (popup, devtools, or an automated
 * harness) so the bridge can be re-pointed without restarting Firefox. */
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.token && changes.token.newValue !== state.token) {
    state.token = String(changes.token.newValue || '').trim();
    detachLocal();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retry = 0;
    if (state.token) connect();
    else setConnected(false, 'token cleared');
  }
  if (changes.label && changes.label.newValue) {
    state.label = String(changes.label.newValue);
  }
});
