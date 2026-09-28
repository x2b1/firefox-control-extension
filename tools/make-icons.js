'use strict';
// Generate the extension icons without an image library: raw RGBA -> zlib ->
// PNG chunks. Keeps the repo dependency-free.
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A rounded-square badge with a bridge glyph, drawn analytically. */
function pixel(x, y, size) {
  const u = (x + 0.5) / size;
  const v = (y + 0.5) / size;

  // Rounded square body.
  const r = 0.22;
  const dx = Math.max(r - u, 0, u - (1 - r));
  const dy = Math.max(r - v, 0, v - (1 - r));
  const outside = Math.hypot(dx, dy) - r;
  if (outside > 0) return [0, 0, 0, 0];

  // Vertical gradient background.
  const t = v;
  let bg = [
    Math.round(0x1a + (0x0d - 0x1a) * t),
    Math.round(0x2e + (0x14 - 0x2e) * t),
    Math.round(0x5c + (0x28 - 0x5c) * t),
  ];

  // Two pylons and a deck: the "bridge".
  const inPylonL = u > 0.24 && u < 0.32 && v > 0.34 && v < 0.72;
  const inPylonR = u > 0.68 && u < 0.76 && v > 0.34 && v < 0.72;
  const inDeck = v > 0.62 && v < 0.70 && u > 0.24 && u < 0.76;
  const inCable = Math.abs(v - (0.36 + Math.abs(u - 0.5) * 0.34)) < 0.022 && u > 0.32 && u < 0.68;
  if (inPylonL || inPylonR || inDeck || inCable) {
    return [0x6f, 0x9b, 0xff, 0xff];
  }
  // Live dot.
  if (Math.hypot(u - 0.5, v - 0.44) < 0.085) return [0x2e, 0xcc, 0x71, 0xff];

  return [...bg, 0xff];
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, pixel));
  console.log('wrote', path.relative(process.cwd(), file));
}
