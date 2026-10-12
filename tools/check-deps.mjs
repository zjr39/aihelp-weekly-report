// 確認正式檔案的 import 依賴，避免封存後斷鏈
import fs from 'node:fs/promises';

const official = [
  'bin/gui.mjs',
  'bin/collect-v3.mjs',
  'bin/transform.mjs',
  'bin/build-sheet.mjs',
  'bin/build-xlsx.mjs',
  'bin/run-weekly.mjs',
  'bin/chrome-up.mjs',
  'lib/collectCore.mjs',
  'lib/pipeline.mjs',
  'lib/report.mjs',
  'lib/xlsx.mjs',
  'lib/cdp.mjs',
  'lib/log.mjs',
];

const all = new Set();
for (const f of official) {
  const s = await fs.readFile(f, 'utf8');
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let m;
  const found = [];
  while ((m = re.exec(s))) {
    if (m[1].startsWith('.')) found.push(m[1]);
    else all.add('(外部) ' + m[1]);
  }
  if (found.length) console.log(`${f}\n  → ${found.join('\n  → ')}`);
  found.forEach((x) => all.add(x));
}

console.log('\n=== 所有相對依賴 ===');
const rel = [...all].filter((x) => !x.startsWith('(外部)')).sort();
rel.forEach((x) => console.log('  ' + x));

// 檢查這些依賴是否都指向保留清單內的檔案
const KEEP_FILES = new Set([
  'bin/gui.mjs',
  'bin/chrome-up.mjs',
  'bin/collect-v3.mjs',
  'bin/transform.mjs',
  'bin/build-sheet.mjs',
  'bin/build-xlsx.mjs',
  'bin/run-weekly.mjs',
  'lib/collectCore.mjs',
  'lib/pipeline.mjs',
  'lib/report.mjs',
  'lib/xlsx.mjs',
  'lib/cdp.mjs',
  'lib/log.mjs',
]);

// 解析相對路徑
import path from 'node:path';
const bad = [];
for (const f of official) {
  const s = await fs.readFile(f, 'utf8');
  const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(s))) {
    const resolved = path.normalize(path.join(path.dirname(f), m[1]));
    if (!KEEP_FILES.has(resolved)) bad.push(`${f} → ${resolved}`);
  }
}
console.log('\n=== 結論 ===');
console.log(bad.length ? '⚠️ 需要保留的依賴：\n  ' + bad.join('\n  ') : '✅ 正式檔案只依賴保留清單內的檔案，可安全封存其餘腳本');
