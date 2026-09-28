'use strict';
/**
 * Token management for the bridge.
 *
 * The token is the ONLY thing standing between a random website you happen to
 * be visiting and a full remote-control channel into your browser. It is
 * generated once with 256 bits of entropy, stored 0600, and treated as a
 * secret everywhere: never logged, never echoed in /health.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.PB_DATA_DIR || path.join(__dirname, '..', '.data');
const TOKEN_FILE = path.join(DATA_DIR, 'token');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function loadOrCreateToken() {
  ensureDataDir();
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch {
    /* fall through and mint a new one */
  }
  const token = crypto.randomBytes(32).toString('hex');
  // Write via a temp file so a crash mid-write cannot leave a truncated token
  // (a truncated token would look "valid" but be guessable if only partly random).
  const tmp = `${TOKEN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
  return token;
}

/** Constant-time compare that does not leak length via early return. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Hash first so differing lengths do not throw and do not leak length.
  const ha = crypto.createHash('sha256').update(ab).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { loadOrCreateToken, safeEqual, DATA_DIR, TOKEN_FILE };
