// 驗證產出的 xlsx：檢查換行、列高、樣式
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

function readZipEntries(buf) {
  const entries = new Map();
  let i = 0;
  while (i < buf.length - 4) {
    const sig = buf.readUInt32LE(i);
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const dataStart = i + 30 + nameLen + extraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    entries.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    i = dataStart + compSize;
  }
  return entries;
}

const file = process.argv[2];
const buf = await fs.readFile(file);
const entries = readZipEntries(buf);
const sheet = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
const styles = entries.get('xl/styles.xml').toString('utf8');

console.log('檔案：' + path.basename(file));
console.log('entries：' + [...entries.keys()].join(', '));
console.log('wrapText 樣式數：' + (styles.match(/wrapText="1"/g) || []).length);
console.log('換行符（&#10; 或實體）出現次數：' + (sheet.match(/\n/g) || []).length);

// 抓出含換行的儲存格
const cellsWithNl = [...sheet.matchAll(/<c r="([A-Z]+\d+)"[^>]*t="inlineStr"[^>]*>\s*<is><t[^>]*>([\s\S]*?)<\/t><\/is><\/c>/g)]
  .filter((m) => m[2].includes('\n'))
  .map((m) => ({ ref: m[1], lines: m[2].split('\n').length, text: m[2].replace(/\n/g, ' ⏎ ') }));

console.log(`\n含多行的儲存格：${cellsWithNl.length} 個`);
for (const c of cellsWithNl.slice(0, 6)) console.log(`  ${c.ref}（${c.lines} 行）：${c.text}`);

// 檢查列高
const rows = [...sheet.matchAll(/<row r="(\d+)"([^>]*)>/g)].map((m) => ({ r: Number(m[1]), attrs: m[2] }));
const withHeight = rows.filter((r) => /ht="/.test(r.attrs));
console.log(`\n有設定列高的列：${withHeight.length} / ${rows.length}`);
// 找出 パーフェクトワールド Z 區塊的列
const pIdx = sheet.indexOf('パーフェクトワールド Z');
if (pIdx > 0) {
  const before = sheet.slice(0, pIdx);
  const rowNum = (before.match(/<row r="(\d+)"/g) || []).length;
  console.log(`\nパーフェクトワールド Z 在第 ${rowNum} 列附近；該區塊列高：`);
  for (const r of rows.filter((x) => x.r >= rowNum && x.r <= rowNum + 5)) {
    const ht = /ht="(\d+)"/.exec(r.attrs);
    console.log(`  row ${r.r}  height=${ht ? ht[1] : '（預設）'}`);
  }
}
