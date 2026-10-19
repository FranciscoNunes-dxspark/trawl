// Draws Glim into assets/: glim.svg (README, GitHub), glim.png (social preview), glim.ico
// (the Windows executable's icon), and glim-transparent.svg/.png/.ico (just the fish, no background),
// all from the pixels in src/glim.js.
//   node scripts/logo.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PALETTE, glimPixels } from '../src/glim.js';

const BG = '#0f1724';
// Trim any empty columns at the sides, so the fish sits in the middle.
const full = glimPixels('idle');
const used = [...full[0]].map((_, x) => full.some((row) => row[x] !== '.'));
const first = used.indexOf(true);
const last = used.lastIndexOf(true);
const px = full.map((row) => row.slice(first, last + 1));
const W = px[0].length;
const H = px.length;

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];

// Square canvas with the fish centred and a margin, as RGBA rows.
function canvas(size) {
  const cells = 20; // the drawing is 16 × 10; leave room around it
  const scale = size / cells;
  const ox = (cells - W) / 2;
  const oy = (cells - H) / 2;
  const bg = hex(BG);
  const radius = size * 0.18;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      // Rounded square background, transparent outside the corners.
      const cx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const cy = Math.max(radius - y, y - (size - 1 - radius), 0);
      if (cx * cx + cy * cy > radius * radius) {
        row.push(0, 0, 0, 0);
        continue;
      }
      const c = px[Math.floor(y / scale - oy)]?.[Math.floor(x / scale - ox)];
      row.push(...(PALETTE[c] ? hex(PALETTE[c]) : bg));
    }
    rows.push(row);
  }
  return rows;
}

// Just the fish on transparency, cropped to the drawing: `scale` image pixels per drawing pixel.
function bare(scale) {
  const rows = [];
  for (let y = 0; y < H * scale; y++) {
    const row = [];
    for (let x = 0; x < W * scale; x++) {
      const c = px[Math.floor(y / scale)][Math.floor(x / scale)];
      row.push(...(PALETTE[c] ? hex(PALETTE[c]) : [0, 0, 0, 0]));
    }
    rows.push(row);
  }
  return rows;
}

/** Encodes RGBA rows as a PNG; a number means the square background canvas of that size. */
function png(image) {
  const rows = typeof image === 'number' ? canvas(image) : image;
  const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(rows[0].length / 4, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO files may hold PNGs directly (Windows Vista and later).
// The fish centred on a transparent square, for icons. 16 cells across, so the usual icon
// sizes (16, 32, 48 … 256) are whole multiples and every pixel stays crisp.
function bareSquare(size) {
  const cells = 16;
  const scale = size / cells;
  const ox = Math.floor((cells - W) / 2);
  const oy = Math.floor((cells - H) / 2);
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      const c = px[Math.floor(y / scale) - oy]?.[Math.floor(x / scale) - ox];
      row.push(...(PALETTE[c] ? hex(PALETTE[c]) : [0, 0, 0, 0]));
    }
    rows.push(row);
  }
  return rows;
}

// An uncompressed 32-bit icon image: BITMAPINFOHEADER, BGRA rows bottom-up, then the 1-bit
// transparency mask older readers use. Every program that reads .ico files reads these.
function dib(rows) {
  const w = rows[0].length / 4;
  const h = rows.length;
  const maskRow = Math.ceil(w / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(w, 4);
  head.writeInt32LE(h * 2, 8); // colour rows plus mask rows
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(w * h * 4 + maskRow * h, 20);
  const pixels = Buffer.alloc(w * h * 4);
  const mask = Buffer.alloc(maskRow * h);
  for (let y = 0; y < h; y++) {
    const src = rows[h - 1 - y];
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = src.slice(x * 4, x * 4 + 4);
      pixels.set([b, g, r, a], (y * w + x) * 4);
      if (a === 0) mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([head, pixels, mask]);
}

/**
 * An .ico with one image per size; `draw(size)` makes each (the dark square by default).
 * Bitmaps up to 128 px and a PNG at 256, the usual layout: some readers can't decode small PNGs.
 */
function ico(sizes, draw = canvas) {
  const images = sizes.map((s) => (s >= 256 ? png(draw(s)) : dib(draw(s))));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map((img, i) => {
    const e = Buffer.alloc(16);
    e[0] = sizes[i] >= 256 ? 0 : sizes[i];
    e[1] = sizes[i] >= 256 ? 0 : sizes[i];
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

/** The logo as SVG: on its dark rounded square, or with `background: false` just the fish, cropped. */
function svg({ background = true } = {}) {
  const cells = background ? 20 : null;
  const ox = background ? (cells - W) / 2 : 0;
  const oy = background ? (cells - H) / 2 : 0;
  const rects = [];
  px.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (PALETTE[c]) rects.push(`<rect x="${x + ox}" y="${y + oy}" width="1.02" height="1.02" fill="${PALETTE[c]}"/>`);
    }),
  );
  const box = background ? `0 0 ${cells} ${cells}` : `0 0 ${W} ${H}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" shape-rendering="crispEdges">
<title>Glim, the Trawl anglerfish</title>
${background ? `<rect width="${cells}" height="${cells}" rx="3.6" fill="${BG}"/>\n` : ''}${rects.join('\n')}
</svg>
`;
}

mkdirSync('assets', { recursive: true });
writeFileSync('assets/glim.svg', svg());
writeFileSync('assets/glim.png', png(512));
writeFileSync('assets/glim.ico', ico([16, 24, 32, 48, 64, 128, 256]));
// Just the fish on transparency, for light pages, slides and stickers.
writeFileSync('assets/glim-transparent.svg', svg({ background: false }));
writeFileSync('assets/glim-transparent.png', png(bare(32)));
writeFileSync('assets/glim-transparent@4x.png', png(bare(128)));
writeFileSync('assets/glim-transparent.ico', ico([16, 32, 48, 64, 128, 256], bareSquare));
console.log('assets/glim.svg, glim.png, glim.ico, glim-transparent.svg, glim-transparent.png, glim-transparent@4x.png, glim-transparent.ico');
