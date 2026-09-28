'use strict';
/**
 * Hub: registry of attached extensions + the command/event router.
 *
 * Transport is SSE (server -> extension) and POST (extension -> server), so
 * there is no socket library and no framing to get wrong. Long-lived push is
 * all SSE needs; commands and results are request/response.
 */
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const DEFAULT_TIMEOUT = 30_000;
const MAX_EVENTS = 1000;

class Hub extends EventEmitter {
  constructor({ log }) {
    super();
    this.log = log || (() => {});
    /** @type {Map<string, {id,label,profile,policy,res,connectedAt,lastSeen,activeTabId}>} */
    this.clients = new Map();
    /** @type {Map<string, {resolve,reject,timer,action}>} */
    this.pending = new Map();
    /** @type {Array<{ts,clientId,type,payload}>} */
    this.events = [];
    this.activeClientId = null;
  }

  // ---------------------------------------------------------------- clients

  addClient(meta, res) {
    const id = meta.clientId || crypto.randomBytes(8).toString('hex');
    const client = {
      id,
      label: meta.label || 'firefox',
      profile: meta.profile || 'default',
      policy: meta.policy || { allow: [], mode: 'lock' },
      res,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      activeTabId: null,
    };
    this.clients.set(id, client);
    this.activeClientId = id;
    this.log(`client attached id=${id} label=${client.label} profile=${client.profile}`);
    this.emit('clients', this.clientList());
    this.pushEvent(id, 'client.attached', { label: client.label, profile: client.profile });
    return client;
  }

  removeClient(id) {
    const c = this.clients.get(id);
    if (!c) return;
    try {
      c.res.end();
    } catch {
      /* already gone */
    }
    this.clients.delete(id);
    if (this.activeClientId === id) {
      this.activeClientId = this.clients.keys().next().value ?? null;
    }
    // Fail anything that was in flight so callers get a real error rather
    // than hanging until timeout.
    for (const [pid, p] of this.pending) {
      if (p.clientId === id) {
        clearTimeout(p.timer);
        p.reject(new Error('extension disconnected before the command completed'));
        this.pending.delete(pid);
      }
    }
    this.log(`client detached id=${id}`);
    this.emit('clients', this.clientList());
  }

  clientList() {
    return [...this.clients.values()].map((c) => ({
      id: c.id,
      label: c.label,
      profile: c.profile,
      connectedAt: c.connectedAt,
      active: c.id === this.activeClientId,
      allow: c.policy?.allow ?? [],
      mode: c.policy?.mode ?? 'lock',
    }));
  }

  selectClient(id) {
    if (id && this.clients.has(id)) {
      this.activeClientId = id;
      this.emit('clients', this.clientList());
      return this.clients.get(id);
    }
    if (id) throw new Error(`no such client: ${id}`);
    const c = this.activeClientId ? this.clients.get(this.activeClientId) : null;
    if (!c) throw new Error('no extension attached — open Firefox and click the extension icon');
    return c;
  }

  // ------------------------------------------------------------------- SSE

  /** Write one SSE frame. */
  frame(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  send(clientId, event, data) {
    const c = this.clients.get(clientId);
    if (!c) return false;
    try {
      this.frame(c.res, event, data);
      return true;
    } catch (err) {
      this.log(`sse write failed client=${clientId}: ${err.message}`);
      this.removeClient(clientId);
      return false;
    }
  }

  broadcast(event, data) {
    for (const id of this.clients.keys()) this.send(id, event, data);
  }

  // -------------------------------------------------------------- commands

  /**
   * Dispatch a command to an extension and await its result.
   * Every failure mode resolves through a real rejection, never a hang.
   */
  async exec({ action, params = {}, clientId, timeout = DEFAULT_TIMEOUT }) {
    const client = this.selectClient(clientId);
    const id = crypto.randomBytes(12).toString('hex');
    const started = Date.now();

    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command "${action}" timed out after ${timeout}ms`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, action, clientId: client.id, started });
    });

    const ok = this.send(client.id, 'command', { id, action, params, deadline: started + timeout });
    if (!ok) {
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
      }
      throw new Error('extension stream is not writable');
    }

    const data = await result;
    return { action, clientId: client.id, ms: Date.now() - started, data };
  }

  /**
   * Called by the extension when a command finishes.
   * Resolves with the payload on success, rejects with a real Error on
   * failure, and returns false for an id we are no longer waiting on
   * (duplicate or late report).
   */
  settle({ id, ok, data, error }) {
    const p = this.pending.get(id);
    if (!p) return false; // duplicate/late report, already timed out
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (ok) p.resolve(data);
    else p.reject(new Error(typeof error === 'string' ? error : JSON.stringify(error)));
    return true;
  }

  // ---------------------------------------------------------------- events

  pushEvent(clientId, type, payload) {
    const evt = { ts: Date.now(), clientId, type, payload };
    this.events.push(evt);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.emit('event', evt);
    if (type === 'tab.activated' || type === 'tab.changed') {
      const c = this.clients.get(clientId);
      if (c && Number.isInteger(payload?.tabId)) c.activeTabId = payload.tabId;
    }
    return evt;
  }

  tail(n = 100) {
    return this.events.slice(-n);
  }
}

module.exports = { Hub, DEFAULT_TIMEOUT };
