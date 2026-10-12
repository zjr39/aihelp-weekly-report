// 把 .vbs 轉成 UTF-16LE + BOM
//
// 為什麼：Windows Script Host 用系統 ANSI 字碼頁讀 .vbs。
//   - UTF-8（無 BOM）：中文全形標點（，。「」）會被拆成無效位元組 → 編譯錯誤「無效字元」／「未結束的字串常數」
//   - UTF-8 + BOM：BOM 讓 Option Explicit 解析失敗
//   - UTF-16LE + BOM：✅ 實測中文、全形標點、引號全部正常
//
// 所以 .vbs 一律用 UTF-16LE + BOM。
import fs from 'node:fs/promises';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法：node tools/vbs-to-utf16.mjs <file.vbs...>');
  process.exit(1);
}

for (const f of files) {
  const buf = await fs.readFile(f);
  let text;
  // 先判斷來源編碼
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString('utf16le');
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    text = buf.subarray(3).toString('utf8');
  } else {
    text = buf.toString('utf8');
  }
  // 統一 CRLF
  text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

  const out = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  await fs.writeFile(f, out);
  const head = out.subarray(0, 4);
  console.log(`  ${f}: ${out.length} bytes，前 4 = ${[...head].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
}
console.log(`\n已轉換 ${files.length} 個 .vbs 為 UTF-16LE + BOM`);
