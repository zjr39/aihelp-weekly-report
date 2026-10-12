// 驗證 ICO 內每一張內嵌 PNG 是否合法
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const ico = await fs.readFile('assets/icon.ico');
const count = ico.readUInt16LE(4);
console.log(`ICO 內含 ${count} 張圖，總大小 ${ico.length} bytes\n`);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function checkPng(buf, label) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return `${label}: ❌ PNG 簽章錯誤`;
  // 走訪 chunk
  let off = 8;
  const chunks = [];
  let w = 0,
    h = 0,
    bitDepth = 0,
    colorType = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    if (dataStart + len + 4 > buf.length) return `${label}: ❌ chunk ${type} 超出範圍（off=${off} len=${len} total=${buf.length}）`;
    chunks.push(type);
    if (type === 'IHDR') {
      w = buf.readUInt32BE(dataStart);
      h = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
    }
    off = dataStart + len + 4;
  }
  const trailing = buf.length - off;
  const ok = chunks[0] === 'IHDR' && chunks[chunks.length - 1] === 'IEND' && trailing === 0;
  return `${label}: ${ok ? '✅' : '❌'} ${w}x${h} depth=${bitDepth} colorType=${colorType} chunks=[${chunks.join(',')}] 剩餘=${trailing}`;
}

for (let i = 0; i < count; i++) {
  const e = 6 + i * 16;
  const w = ico[e];
  const h = ico[e + 1];
  const bytes = ico.readUInt32LE(e + 8);
  const offset = ico.readUInt32LE(e + 12);
  const size = w === 0 ? 256 : w;
  const slice = ico.subarray(offset, offset + bytes);
  const inRange = offset + bytes <= ico.length;
  console.log(`[${i}] 目錄宣告 ${size}x${size} (${w},${h})  size=${bytes} offset=${offset} 範圍內=${inRange}`);
  console.log('    ' + checkPng(slice, '  PNG'));
}
