// 移除 VBS 的 BOM —— Windows Script Host 會被 BOM 弄壞（Option Explicit 解析失敗）
import fs from 'node:fs/promises';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法：node tools/strip-bom.mjs <file...>');
  process.exit(1);
}

let changed = 0;
for (const f of files) {
  const buf = await fs.readFile(f);
  let text = buf.toString('utf8');
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) text = text.slice(1);
  // 統一 CRLF
  text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const out = Buffer.from(text, 'utf8');
  // 只在需要時才寫回（避免無謂改動 mtime）
  const needsWrite = hadBom || !buf.equals(out);
  if (needsWrite) {
    await fs.writeFile(f, out);
    changed++;
  }
  const head = (await fs.readFile(f)).subarray(0, 3);
  console.log(`  ${f}: BOM=${hadBom ? '有（已移除）' : '无'}，前 3 bytes = ${[...head].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
}
console.log(`\n共修改 ${changed} 个文件`);
