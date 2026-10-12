// 產生 assets/icon.ico —— 零依賴（只用 Node 內建 zlib）
//
// ICO 格式：6 bytes 檔頭 + 每張圖 16 bytes 目錄項 + 各張圖的資料。
//
// 編碼選擇（實測結論，別亂改）：
//   GDI+（System.Drawing.Icon.ToBitmap）**無法處理 PNG 內嵌的 ICO 項目**，
//   會丟「請求的範圍擴展超過了陣列的結尾」。
//   → 256x256 用 PNG（體積小，Windows 殼層支援），其餘尺寸一律用 BMP/DIB。
//   混合格式是產業慣例，且實測 GDI+ 載入／轉點陣圖都正常。
//
// 圖案：深藍圓角底 + 白色報表 + 藍色文字列 + 綠色勾勾（呼應 Excel 週報配色 #2F5597）
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'icon.ico');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_FROM = 256; // 這個尺寸（含）以上才用 PNG 內嵌

const NAVY = [0x2f, 0x55, 0x97]; // #2F5597，與 Excel 報表主色一致
const WHITE = [0xff, 0xff, 0xff];
const GREEN = [0x21, 0xa3, 0x66];

/** 简易绘图：回传 RGBA buffer；坐标皆为 0..1 的比例 */
function draw(size) {
  const buf = Buffer.alloc(size * size * 4, 0);
  const S = size;
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    // 簡單 alpha 混合（疊在既有像素上）
    const sa = a / 255;
    const da = buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
    buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
    buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  };
  const fillRect = (x0, y0, x1, y1, color, a = 255) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = Math.round(x0); x < Math.round(x1); x++) set(x, y, color, a);
  };
  const fillRound = (x0, y0, x1, y1, rad, color, a = 255) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++) {
      for (let x = Math.round(x0); x < Math.round(x1); x++) {
        // 圓角判斷
        const cx = Math.min(Math.max(x, x0 + rad), x1 - rad - 1);
        const cy = Math.min(Math.max(y, y0 + rad), y1 - rad - 1);
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= rad * rad) set(x, y, color, a);
      }
    }
  };
  const fillCircle = (cx, cy, r, color, a = 255) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) set(x, y, color, a);
      }
    }
  };

  const pad = Math.max(1, Math.round(S * 0.04));
  const rad = Math.max(2, Math.round(S * 0.22));

  // 底色（圓角方塊）
  fillRound(pad, pad, S - pad, S - pad, rad, NAVY);

  // 內部深色區塊（模擬報表紙）
  const m = Math.round(S * 0.22);
  const pw = Math.round(S * 0.52);
  const ph = Math.round(S * 0.5);
  const px = Math.round((S - pw) / 2) - Math.round(S * 0.02);
  const py = Math.round((S - ph) / 2) + Math.round(S * 0.01);
  fillRound(px, py, px + pw, py + ph, Math.max(1, Math.round(S * 0.05)), WHITE);

  // 報表上的「文字列」
  const lineH = Math.max(1, Math.round(S * 0.055));
  const gap = Math.max(1, Math.round(S * 0.05));
  const lx = px + Math.round(S * 0.07);
  const lw = pw - Math.round(S * 0.14);
  for (let i = 0; i < 3; i++) {
    const ly = py + Math.round(S * 0.1) + i * (lineH + gap);
    fillRect(lx, ly, lx + lw * (i === 2 ? 0.55 : 1), ly + lineH, [0xc8, 0xd4, 0xe8]);
  }

  // 右下角綠色勾勾徽章（代表「有效／完成」）
  // 注意：整個徽章必須完整落在藍底內，否則小尺寸會看不清楚
  const cr = Math.max(2, Math.round(S * 0.17));
  const ccx = S - pad - cr - Math.round(S * 0.03);
  const ccy = S - pad - cr - Math.round(S * 0.03);
  fillCircle(ccx, ccy, cr + Math.max(1, Math.round(S * 0.022)), WHITE); // 白圈讓勾勾從藍底跳出來
  fillCircle(ccx, ccy, cr, GREEN);
  const th = Math.max(1, Math.round(S * 0.055));
  const drawLine = (x0, y0, x1, y1, t, color) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 3 + 1;
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * i) / steps;
      fillCircle(x, y, t / 2, color);
    }
  };
  drawLine(ccx - cr * 0.45, ccy + cr * 0.02, ccx - cr * 0.12, ccy + cr * 0.38, th, WHITE);
  drawLine(ccx - cr * 0.12, ccy + cr * 0.38, ccx + cr * 0.46, ccy - cr * 0.34, th, WHITE);

  return buf;
}

/** 把 RGBA buffer 編成 PNG */
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: None
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** 把 RGBA buffer 編成 BMP/DIB（ICO 內部格式，GDI+ 相容性最好） */
function dib(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const xorSize = size * size * 4;
  const andSize = maskRow * size;
  const buf = Buffer.alloc(40 + xorSize + andSize);
  buf.writeUInt32LE(40, 0); // biSize
  buf.writeInt32LE(size, 4); // biWidth
  buf.writeInt32LE(size * 2, 8); // biHeight = XOR + AND 兩份
  buf.writeUInt16LE(1, 12); // biPlanes
  buf.writeUInt16LE(32, 14); // biBitCount
  buf.writeUInt32LE(0, 16); // biCompression = BI_RGB
  buf.writeUInt32LE(xorSize + andSize, 20); // biSizeImage
  // 像素：BGRA、由下而上
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4;
      const d = 40 + y * size * 4 + x * 4;
      buf[d] = rgba[s + 2];
      buf[d + 1] = rgba[s + 1];
      buf[d + 2] = rgba[s];
      buf[d + 3] = rgba[s + 3];
    }
  }
  // AND mask 全 0（透明度交給 alpha 通道）
  return buf;
}

const pngs = SIZES.map((s) => {
  const rgba = draw(s);
  return { size: s, data: s >= PNG_FROM ? png(s, rgba) : dib(s, rgba) };
});

// 組 ICO
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(pngs.length, 4);

const dirSize = 16 * pngs.length;
let offset = 6 + dirSize;
const dirs = [];
const blobs = [];
for (const p of pngs) {
  const d = Buffer.alloc(16);
  d[0] = p.size >= 256 ? 0 : p.size; // 256 记为 0
  d[1] = p.size >= 256 ? 0 : p.size;
  d[2] = 0; // 調色盤色數
  d[3] = 0; // reserved
  d.writeUInt16LE(1, 4); // color planes
  d.writeUInt16LE(32, 6); // bits per pixel
  d.writeUInt32LE(p.data.length, 8); // dwBytesInRes
  d.writeUInt32LE(offset, 12); // dwImageOffset
  dirs.push(d);
  blobs.push(p.data);
  offset += p.data.length;
}

const ico = Buffer.concat([header, ...dirs, ...blobs]);
await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, ico);

console.log(`已產生 ${OUT}`);
console.log(`  尺寸：${SIZES.join(', ')}`);
console.log(`  編碼：< ${PNG_FROM} 用 BMP/DIB，>= ${PNG_FROM} 用 PNG`);
console.log(`  大小：${(ico.length / 1024).toFixed(1)} KB`);
