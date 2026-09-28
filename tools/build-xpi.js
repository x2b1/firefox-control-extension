'use strict';
/* Package the extension into a signed-installable XPI (a zip). Temporary
 * installs via about:debugging do not need this; it is here for when you want
 * to drop the file into a profile or hand it to another machine. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const EXT = path.join(__dirname, '..', 'extension');
const OUT = path.join(__dirname, '..', 'out', 'pentest-bridge.xpi');

/* --- minimal store/deflate zip writer ------------------------------------ */

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
  return (crc ^ -1) >>> 0;
}

function walk(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, acc);
    else acc.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return acc;
}

const files = walk(EXT).sort();
// manifest.json first is conventional and some tooling expects it early.
files.sort((a, b) => (a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : 0));

const locals = [];
const centrals = [];
let offset = 0;

for (const name of files) {
  const nameBuf = Buffer.from(name, 'utf8');
  const raw = fs.readFileSync(path.join(EXT, name));
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  // Fall back to stored if compression made it bigger (tiny files).
  const useDeflate = deflated.length < raw.length;
  const body = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const sum = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);      // version needed
  local.writeUInt16LE(0, 6);       // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10);      // mod time (fixed: reproducible builds)
  local.writeUInt16LE(0x21, 12);   // mod date (1980-01-01)
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, nameBuf, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);    // version made by
  central.writeUInt16LE(20, 6);    // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(sum, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);    // extra
  central.writeUInt16LE(0, 32);    // comment
  central.writeUInt16LE(0, 34);    // disk
  central.writeUInt16LE(0, 36);    // internal attrs
  central.writeUInt32LE(0o644 << 16, 38); // external attrs
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const xpi = Buffer.concat([...locals, centralBuf, end]);
fs.writeFileSync(OUT, xpi);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${files.length} files, ${xpi.length} bytes)`);

// Verify it round-trips through the system unzip if available.
try {
  const { execFileSync } = require('node:child_process');
  execFileSync('unzip', ['-t', OUT], { stdio: 'pipe' });
  console.log('zip integrity: ok');
} catch {
  console.log('(unzip not available; skipped integrity check)');
}
