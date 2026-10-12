// 产出「周报客诉总表」版面 v2 — 全部游戏整合到同一张工作表
//
// 两种排法（用 --layout 选擇）：
//   stack   ：每个游戏一段方塊，由上往下堆疊（同一张表，A~C 欄）
//   columns ：每个游戏一组欄位（A/B/C、H/I/J、…），橫向并排，比照飞书母表样式
//
// 用法:
//   node bin/build-sheet.mjs --layout stack   --game data/g1.json --game data/g2.json --out report/sheet
//   node bin/build-sheet.mjs --layout columns --app data/app.json --games data/tag_*.json --out report/sheet
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyze, genOf } from '../lib/report.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const argsAll = (n) => {
  const out = [];
  argv.forEach((v, i) => {
    if (v === '--' + n && argv[i + 1]) out.push(argv[i + 1]);
  });
  return out;
};

const appFile = arg('app');
const tagFiles = argsAll('game');
const periodLabel = arg('period', '');
const outBase = arg('out', 'report/sheet');
const layout = arg('layout', 'stack');
const onlyWithData = arg('all-zero', 'hide') !== 'show'; // 预设不列 0 笔标签
const showDual = arg('dual', 'hide') === 'show'; // 预设不列「非坐席原因差評」附加标签
const showEmptyGames = arg('empty-games', 'hide') === 'show'; // 预设不列「完全没有客诉」的游戏

if (!appFile || !tagFiles.length) {
  console.error('用法: node bin/build-sheet.mjs --app <app.json> --game <tag1.json> [--game <tag2.json> ...] --period "<短标>" --layout stack|columns --out <前綴>');
  process.exit(1);
}

const appJson = JSON.parse(await fs.readFile(appFile, 'utf8'));
const tagJsons = [];
for (const f of tagFiles) tagJsons.push(JSON.parse(await fs.readFile(f, 'utf8')));

/** 把单一游戏的标签资料攤成 { title, sumLine, rows:[[name,total,detail]] } */
function buildBlock(appJ, tagJ) {
  const a = analyze(appJ, tagJ);
  const game = tagJ.app;
  const l1Sorted = a.l1Rows
    .filter((r) => (r.l1 ?? r.l2) !== 'Sum')
    .slice()
    .sort((x, y) => genOf(y) - genOf(x));

  const rows = [];
  for (const r of l1Sorted) {
    const name = r.l1 ?? r.l2;
    const isDual = r.isDualTag || /非坐席原因差[评评]/.test(name);
    if (isDual && !showDual) continue; // 附加标签不列出（仍计入有效客诉计算）
    if (onlyWithData && genOf(r) === 0) continue; // 0 笔的一级标签不列
    const kids = a.l2Rows
      .filter((x) => x.l1 === name)
      .filter((x) => !onlyWithData || genOf(x) > 0)
      .sort((x, y) => genOf(y) - genOf(x));
    const childLines = kids.map((k) => `>${k.l2} ${genOf(k)}`);
    rows.push({ name: `·${name}`, total: genOf(r), detail: childLines.join('\n'), isDual });
  }
  const t = a.tickets;
  const sumLine = t
    ? `${a.labeled}+${a.invalid}（无效）　［总客诉 ${t.total}：无标签 ${t.noTag} + 无效来访 ${t.invalidVisit}］`
    : `${a.labeled}+${a.invalid}（无效）`;
  return {
    game,
    a,
    title: `总客诉量 (${periodLabel})`,
    gameName: game,
    sumLine,
    rows,
  };
}

const blocks = tagJsons.map((t) => buildBlock(appJson, t)).filter((b) => showEmptyGames || b.a.gen > 0);
const Q = (v) => {
  const s = String(v ?? '');
  return /[\t"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const out = [];
if (layout === 'stack') {
  for (const b of blocks) {
    out.push([b.gameName].map(Q).join('\t'));
    out.push([b.title, b.sumLine].map(Q).join('\t'));
    out.push('');
    for (const r of b.rows) out.push([r.name, r.total, r.detail].map(Q).join('\t'));
    out.push('');
    out.push('');
  }
} else {
  // 橫向并排：每组 3 欄（标签 / 数字 / 明细），组与组之间空 2 欄（比照飞书 A-C、H-J）
  const GAP = 2;
  const maxRows = Math.max(...blocks.map((b) => b.rows.length + 3));
  for (let i = 0; i < maxRows; i++) {
    const cells = [];
    blocks.forEach((b, bi) => {
      if (bi > 0) for (let g = 0; g < GAP; g++) cells.push('');
      if (i === 0) cells.push(b.gameName, '', '');
      else if (i === 1) cells.push(b.title, b.sumLine, '');
      else if (i === 2) cells.push('', '', '');
      else if (i - 3 < b.rows.length) {
        const r = b.rows[i - 3];
        cells.push(r.name, r.total, r.detail);
      } else cells.push('', '', '');
    });
    out.push(cells.map(Q).join('\t'));
  }
}

await fs.mkdir(path.dirname(outBase), { recursive: true });
await fs.writeFile(`${outBase}.tsv`, '\uFEFF' + out.join('\n'), 'utf8');

console.log(`产出：${outBase}.tsv（layout=${layout}，${blocks.length} 个游戏）`);
console.log('--- 预览 ---');
console.log(out.join('\n'));
