// 把 xlsx 的 sheet1 內容印成可讀的網格，方便檢查版面
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const run = promisify(execFile);
const file = process.argv[2] || 'report/_test5col.xlsx';

// 用 PowerShell 解壓（Windows 內建；Expand-Archive 只吃 .zip，先複製一份）
const tmp = path.join(os.tmpdir(), '_xlsx_dump_' + Date.now());
await fs.mkdir(tmp, { recursive: true });
const zipCopy = path.join(tmp, 'book.zip');
await fs.copyFile(file, zipCopy);
const outDir = path.join(tmp, 'x');
await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipCopy}' -DestinationPath '${outDir}' -Force`]);

const sheet = await fs.readFile(path.join(outDir, 'xl/worksheets/sheet1.xml'), 'utf8');
const shared = await fs.readFile(path.join(outDir, 'xl/sharedStrings.xml'), 'utf8').catch(() => null);

// 解析 sharedStrings
const strings = [];
if (shared) {
  for (const m of shared.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const txt = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('');
    strings.push(
      txt
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#10;/g, '\n'),
    );
  }
}

// 解析 rows
const rows = new Map();
for (const rm of sheet.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
  const r = Number(rm[1]);
  const cells = new Map();
  // 分開處理：自閉合 <c .../> 沒有內容；<c ...>...</c> 才有
  const cellRe = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  for (const cm of rm[2].matchAll(cellRe)) {
    const col = cm[1];
    const attrs = cm[2] || '';
    const body = cm[3] || '';
    if (!body) continue; // 自閉合＝空儲存格
    const vm = body.match(/<v>([\s\S]*?)<\/v>/);
    let val = vm ? vm[1] : '';
    if (/t="s"/.test(attrs)) val = strings[Number(val)] ?? '';
    else if (/t="inlineStr"/.test(attrs)) {
      const im = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      val = im ? im[1] : '';
    }
    if (val !== '') {
      cells.set(
        col,
        val
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#10;/g, '\n')
          .replace(/&amp;/g, '&'),
      );
    }
  }
  if (cells.size) rows.set(r, cells);
}

const maxRow = Math.max(...rows.keys());
console.log(`檔案：${path.basename(file)}　共 ${maxRow} 列\n`);
console.log('列 | A(一级)              | B(数) | C(二级)              | D(数) | E(具体内容)');
console.log('-'.repeat(120));
for (let r = 1; r <= maxRow; r++) {
  const c = rows.get(r) || new Map();
  const A = (c.get('A') || '').replace(/\n/g, '⏎').slice(0, 20);
  const B = (c.get('B') || '').slice(0, 5);
  const C = (c.get('C') || '').replace(/\n/g, '⏎').slice(0, 20);
  const D = (c.get('D') || '').slice(0, 5);
  const E = (c.get('E') || '').replace(/\n/g, '⏎').slice(0, 52);
  if (!A && !B && !C && !D && !E) continue;
  console.log(`${String(r).padStart(3)}| ${A.padEnd(20)} | ${B.padEnd(5)} | ${C.padEnd(20)} | ${D.padEnd(5)} | ${E}`);
}

await fs.rm(tmp, { recursive: true, force: true });
