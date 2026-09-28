'use strict';
/**
 * Domain policy.
 *
 * Deny-by-default. The extension starts inert and the server owns the policy,
 * pushing it down on connect. This keeps the live session surface scoped to
 * whatever you are actually testing instead of "every site you have ever
 * visited, including your webmail".
 */
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./token');

const POLICY_FILE = path.join(DATA_DIR, 'policy.json');

const DEFAULT_POLICY = { allow: [], mode: 'lock' }; // mode: 'lock' | 'allow-all'

function load() {
  try {
    const p = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
    return {
      allow: Array.isArray(p.allow) ? p.allow.map((s) => String(s).toLowerCase()) : [],
      mode: p.mode === 'allow-all' ? 'allow-all' : 'lock',
    };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

function save(policy) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2), { mode: 0o600 });
}

/** Reduce a URL to a registrable-ish host: strips scheme, port, userinfo, path. */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * host "api.example.co.uk" matches policy entry "example.co.uk".
 * Leading "*." also matches the bare apex. We deliberately do NOT implement
 * public-suffix handling; a missing entry only ever makes the policy stricter.
 */
function hostMatches(host, entry) {
  if (!host || !entry) return false;
  const h = host.toLowerCase();
  const e = entry.toLowerCase();
  if (e === '*') return true;
  if (e.startsWith('*.')) {
    const apex = e.slice(2);
    return h === apex || h.endsWith('.' + apex);
  }
  return h === e || h.endsWith('.' + e);
}

function isAllowed(url, policy = load()) {
  if (policy.mode === 'allow-all') return true;
  const host = hostOf(url);
  if (!host) return false;
  return policy.allow.some((entry) => hostMatches(host, entry));
}

function add(host) {
  const h = String(host).trim().toLowerCase();
  if (!h) throw new Error('host required');
  const p = load();
  if (!p.allow.includes(h)) p.allow.push(h);
  save(p);
  return p;
}

function remove(host) {
  const h = String(host).trim().toLowerCase();
  const p = load();
  p.allow = p.allow.filter((e) => e !== h);
  if (p.mode !== 'allow-all' && p.allow.length === 0) p.mode = 'lock';
  save(p);
  return p;
}

function setMode(mode) {
  const p = load();
  p.mode = mode === 'allow-all' ? 'allow-all' : 'lock';
  save(p);
  return p;
}

module.exports = { load, save, isAllowed, hostOf, hostMatches, add, remove, setMode, POLICY_FILE };
