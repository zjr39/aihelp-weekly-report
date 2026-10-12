// 周报客诉统计 —— CLI 入口（薄包装，实际逻辑在 lib/collectCore.mjs）
//
// 用法: node bin/collect-v3.mjs --start "2026-09-24 00:00:00" --end "2026-10-08 23:59:59" [--label "..."] [--out raw/xxx] [--control raw/.control.json]
import fs from 'node:fs/promises';
import { collect, StopRequested } from '../lib/collectCore.mjs';
import { out, progress } from '../lib/log.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const start = arg('start');
const end = arg('end');
const label = arg('label', `${start} ~ ${end}`);
const outBase = arg('out', 'raw/collect');
const CONTROL = arg('control', '');

if (!start || !end) {
  console.error('用法: node bin/collect-v3.mjs --start "YYYY-MM-DD HH:mm:ss" --end "YYYY-MM-DD HH:mm:ss" [--label "..."] [--out raw/xxx]');
  process.exit(1);
}

async function readCtrl() {
  if (!CONTROL) return null;
  try {
    return JSON.parse(await fs.readFile(CONTROL, 'utf8'));
  } catch {
    return null;
  }
}

try {
  const res = await collect({
    start,
    end,
    label,
    outBase,
    onLog: (m) => out(m),
    onProgress: (p) => progress(p),
    shouldPause: async () => {
      const c = await readCtrl();
      return !!(c && c.pause);
    },
    shouldStop: async () => {
      const c = await readCtrl();
      return !!(c && c.stop);
    },
  });
  out(`\n已存 ${res.outFile}`);
  process.exit(0);
} catch (e) {
  if (e instanceof StopRequested) {
    out(`\n[STOPPED] ${e.message}`);
    process.exit(3);
  }
  console.error('\n❌ ' + e.message);
  process.exit(1);
}
