// 逐位元組檢查 xlsx：換行字元、樣式索引、wrapText 綁定
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

function readZipEntries(buf) {
  const entries = new Map();
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const ds = i + 30 + nameLen + extraLen;
    const raw = buf.slice(ds, ds + compSize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    i = ds + compSize;
  }
  return entries;
}

const file = process.argv[2];
const entries = readZipEntries(await fs.readFile(file));
const sheet = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
const styles = entries.get('xl/styles.xml').toString('utf8');

// 1) 找 C6 儲存格，逐字元列出
const m = sheet.match(/<c r="C6"[\s\S]*?<\/c>/);
console.log('=== C6 儲存格原始 XML ===');
console.log(JSON.stringify(m ? m[0] : 'NOT FOUND'));

if (m) {
  const inner = m[0];
  const chars = [...inner].map((ch) => {
    const code = ch.codePointAt(0);
    if (code === 0x0a) return '\\n(0x0A)';
    if (code < 32) return `\\x${code.toString(16)}`;
    return ch;
  });
  console.log('\n=== 逐字元（只看 <t> 內容）===');
  const t = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
  if (t) {
    const cs = [...t[1]].map((ch) => (ch.codePointAt(0) === 10 ? '[LF]' : ch));
    console.log(cs.join(''));
  }
}

// 2) C6 用的樣式索引 → 對應的 cellXfs
const c6style = m ? /s="(\d+)"/.exec(m[0]) : null;
const sIdx = c6style ? Number(c6style[1]) : 0;
console.log(`\n=== C6 樣式索引 = ${sIdx} ===`);
const xfs = [...styles.matchAll(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((x) => x[0]);
const cellXfsBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
const cellXfs = cellXfsBlock ? [...cellXfsBlock[1].matchAll(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((x) => x[0]) : [];
console.log('cellXfs 總數 =', cellXfs.length);
console.log('索引 ' + sIdx + ' => ' + (cellXfs[sIdx] || 'OUT OF RANGE'));

// 3) 檢查所有 wrapText 出現位置
console.log('\n=== 所有含 wrapText 的 xf ===');
cellXfs.forEach((x, i) => {
  if (/wrapText/.test(x)) console.log(`  [${i}] ${x}`);
});

console.log('\n=== sheetView 設定 ===');
console.log((/<sheetViews>[\s\S]*?<\/sheetViews>/.exec(sheet) || [''])[0]);
