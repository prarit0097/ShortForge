'use strict';

/**
 * Generates build/icon.ico (256x256) with no external image deps.
 * Draws a rounded violet->pink gradient tile with a white "play" mark,
 * PNG-encodes it by hand, then wraps the PNG into a Vista-style .ico.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

// ---- CRC32 (for PNG chunks) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ---- Draw RGBA pixels ----
function drawPixels() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const c1 = [124, 92, 255];   // accent violet
  const c2 = [255, 92, 138];   // accent coral
  const radius = 48;           // rounded corners

  // Play triangle geometry (centered, slightly right-weighted)
  const cx = SIZE * 0.46;
  const cy = SIZE * 0.5;
  const triW = SIZE * 0.30;
  const triH = SIZE * 0.34;
  const ax = cx - triW / 2, ay = cy - triH / 2;
  const bx = cx - triW / 2, by = cy + triH / 2;
  const dx = cx + triW / 2, dy = cy;

  function inTriangle(x, y) {
    const s = (dy - by) * (x - bx) + (bx - dx) * (y - by);
    const t = (ay - dy) * (x - dx) + (dx - ax) * (y - dy);
    const area = (dy - by) * (ax - bx) + (bx - dx) * (ay - by);
    const s1 = s / area, t1 = t / area;
    return s1 >= 0 && t1 >= 0 && s1 + t1 <= 1;
  }

  function cornerAlpha(x, y) {
    // Smooth rounded-rect mask.
    const corners = [
      [radius, radius], [SIZE - radius, radius],
      [radius, SIZE - radius], [SIZE - radius, SIZE - radius],
    ];
    const inX = x > radius && x < SIZE - radius;
    const inY = y > radius && y < SIZE - radius;
    if (inX || inY) return 1;
    let near = corners[0];
    let best = Infinity;
    for (const c of corners) {
      const d = (x - c[0]) ** 2 + (y - c[1]) ** 2;
      if (d < best) { best = d; near = c; }
    }
    const dist = Math.sqrt(best);
    return Math.max(0, Math.min(1, radius - dist + 0.5));
  }

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const t = (x + y) / (2 * SIZE); // diagonal gradient
      let r = lerp(c1[0], c2[0], t);
      let g = lerp(c1[1], c2[1], t);
      let b = lerp(c1[2], c2[2], t);
      if (inTriangle(x, y)) { r = 255; g = 255; b = 255; }
      const a = cornerAlpha(x, y) * 255;
      px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b); px[i + 3] = Math.round(a);
    }
  }
  return px;
}

// ---- PNG encode ----
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(px) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Filtered scanlines (filter byte 0 per row).
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const off = y * (SIZE * 4 + 1);
    raw[off] = 0;
    px.copy(raw, off + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO wrap (single PNG entry) ----
function wrapIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type = icon
  header.writeUInt16LE(1, 4);   // count

  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 -> 0
  entry[1] = 0; // height 256 -> 0
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset

  return Buffer.concat([header, entry, png]);
}

const px = drawPixels();
const png = encodePng(px);
const ico = wrapIco(png);
const out = path.join(__dirname, 'icon.ico');
fs.writeFileSync(out, ico);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('Wrote', out, `(${ico.length} bytes, 256x256)`);
