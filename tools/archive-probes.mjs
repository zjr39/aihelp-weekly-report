// 把探索/除錯時期的腳本移到 _archive/（保留可回溯，不刪除）
import fs from 'node:fs/promises';
import path from 'node:path';

// 正式運作需要的檔案（保留在原位）
const KEEP = new Set([
  'gui.mjs',
  'gui',
  'chrome-up.mjs',
  'collect-v3.mjs',
  'transform.mjs',
  'build-sheet.mjs',
  'build-xlsx.mjs',
  'run-weekly.mjs',
]);

const archiveDir = '_archive/bin';
await fs.mkdir(archiveDir, { recursive: true });

const entries = await fs.readdir('bin', { withFileTypes: true });
let moved = 0;
const movedList = [];
for (const e of entries) {
  if (KEEP.has(e.name)) continue;
  const src = path.join('bin', e.name);
  const dst = path.join(archiveDir, e.name);
  await fs.rename(src, dst);
  moved++;
  movedList.push(e.name);
}

console.log(`已封存 ${moved} 個探索用檔案 → ${archiveDir}/`);
movedList.sort().forEach((n) => console.log('  ' + n));

console.log('\nbin/ 保留：');
for (const e of await fs.readdir('bin', { withFileTypes: true })) {
  console.log('  ' + (e.isDirectory() ? e.name + '/' : e.name));
}
