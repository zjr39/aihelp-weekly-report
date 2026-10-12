// 把 ICO 內各尺寸輸出成 PNG，方便目視檢查
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const ico = await fs.readFile('assets/icon.ico');
const count = ico.readUInt16LE(4);
await fs.mkdir('raw/icon-preview', { recursive: true });

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(CRC(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 從 ICO 的某一項取出 RGBA（同時支援 DIB 與 PNG 內嵌） */
function readEntry(buf, size) {
  if (buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    // PNG
    let off = 8;
    const idat = [];
    let w = 0,
      h = 0;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') {
        w = data.readUInt32BE(0);
        h = data.readUInt32BE(4);
      }
      if (type === 'IDAT') idat.push(data);
      off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * 4 + 1;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) raw.copy(out, y * w * 4, y * stride + 1, y * stride + 1 + w * 4);
    return { w, h, rgba: out };
  }
  // DIB
  const w = buf.readInt32LE(4);
  const h2 = buf.readInt32LE(8) / 2;
  const out = Buffer.alloc(w * h2 * 4);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w; x++) {
      const s = 40 + y * w * 4 + x * 4;
      const d = ((h2 - 1 - y) * w + x) * 4;
      out[d] = buf[s + 2];
      out[d + 1] = buf[s + 1];
      out[d + 2] = buf[s];
      out[d + 3] = buf[s + 3];
    }
  }
  return { w, h: h2, rgba: out };
}

const big = [];
for (let i = 0; i < count; i++) {
  const e = 6 + i * 16;
  const size = ico[e] === 0 ? 256 : ico[e];
  const bytes = ico.readUInt32LE(e + 8);
  const offset = ico.readUInt32LE(e + 12);
  const { w, h, rgba } = readEntry(ico.subarray(offset, offset + bytes), size);
  await fs.writeFile(`raw/icon-preview/${String(size).padStart(3, '0')}.png`, encodePng(w, h, rgba));
  big.push({ size, w, h, rgba });
  console.log(`  ${size}x${size} → raw/icon-preview/${String(size).padStart(3, '0')}.png (${w}x${h})`);
}

// 拼一張對照圖（放大 4 倍排成一列），方便一眼檢查
const scale = 3;
const idx = big.map((b) => b.size);
const totalW = big.reduce((a, b) => a + b.w * (b.size <= 48 ? scale : 1) + 8, 8);
const maxH = Math.max(...big.map((b) => b.h * (b.size <= 48 ? scale : 1)));
const sheet = Buffer.alloc(totalW * maxH * 4);
let cx = 8;
for (const b of big) {
  const s = b.size <= 48 ? scale : 1;
  for (let y = 0; y < b.h * s; y++) {
    for (let x = 0; x < b.w * s; x++) {
      const sx = Math.floor(x / s);
      const sy = Math.floor(y / s);
      const si = (sy * b.w + sx) * 4;
      const di = (y * totalW + cx + x) * 4;
      if (di + 3 >= sheet.length) continue;
      const a = b.rgba[si + 3] / 255;
      sheet[di] = Math.round(b.rgba[si] * a + 240 * (1 - a));
      sheet[di + 1] = Math.round(b.rgba[si + 1] * a + 240 * (1 - a));
      sheet[di + 2] = Math.round(b.rgba[si + 2] * a + 240 * (1 - a));
      sheet[di + 3] = 255;
    }
  }
  cx += b.w * s + 8;
}
await fs.writeFile('raw/icon-preview/_sheet.png', encodePng(totalW, maxH, sheet));
console.log(`\n對照圖：raw/icon-preview/_sheet.png (${totalW}x${maxH})`);
