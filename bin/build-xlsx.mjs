// 产生离线 Excel 报表（.xlsx）— 一张工作表、每个游戏一段方塊
//
// 版面：
//   客诉统计周报（期间）                     ← 大标
//   统计区间：...
//
//   ▌游戏名称                                ← 深蓝底白字
//   总客诉量 (期间) │ 89+12（无效）           ← 淺蓝底；无效数字红色放大
//   ·游戏問题       │ 58  │ >内容/玩法咨詢 48 ⏎ >异常反馈 10
//   ...
//
// 用法: node bin/build-xlsx.mjs --app data/xxx_app.json --game data/xxx_tag_*.json --period "9/24-10/8" --out report/xxx
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyze, genOf, METRICS, num } from '../lib/report.mjs';
import { writeXlsx } from '../lib/xlsx.mjs';

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
const skipEmpty = arg('empty-games', 'hide') !== 'show';
const sortBySize = arg('sort', 'app') === 'app';

if (!appFile || !tagFiles.length) {
  console.error('用法: node bin/build-xlsx.mjs --app <app.json> --game <tag.json> [--game ...] --period "..." --out <前綴>');
  process.exit(1);
}

const appJson = JSON.parse(await fs.readFile(appFile, 'utf8'));
const tagJsons = [];
for (const f of tagFiles) tagJsons.push(JSON.parse(await fs.readFile(f, 'utf8')));

// 依应用视角客诉生成量排序（大的排前面）
const appGen = new Map(appJson.rows.map((r) => [r.app, genOf(r)]));
const ordered = sortBySize ? tagJsons.slice().sort((a, b) => (appGen.get(b.app) ?? 0) - (appGen.get(a.app) ?? 0)) : tagJsons;

const grid = [];
const rowHeights = {};
const merges = [];
const C = (v, s) => ({ v, s });
const EMPTY = () => C('', 'default');

// ── 标题区 ──
grid.push([C(`客诉统计周报　${periodLabel}`, 'title'), EMPTY(), EMPTY()]);
merges.push([0, 0, 0, 2]);
rowHeights[0] = 30;

grid.push([C(appJson.capturedNote || `统计区间 ${periodLabel}`, 'subtitle'), EMPTY(), EMPTY()]);
merges.push([1, 0, 1, 2]);
rowHeights[1] = 18;

grid.push([C('', 'spacer'), EMPTY(), EMPTY()]);
rowHeights[2] = 8;

// ── 各游戏方塊 ──
for (const tagJson of ordered) {
  const a = analyze(appJson, tagJson);
  if (skipEmpty && !(a.gen > 0)) continue;

  // 游戏名称列
  const nameIdx = grid.length;
  grid.push([C(`　${a.tagGameName}`, 'gameName'), C('', 'gameName'), C('', 'gameName')]);
  merges.push([nameIdx, 0, nameIdx, 2]);
  rowHeights[nameIdx] = 24;

  // 总客诉量列
  const sumIdx = grid.length;
  grid.push([C(`总客诉量 (${periodLabel})`, 'sumLabel'), C(`${a.labeled}+${a.invalid}（无效）`, 'sumValue'), C('', 'sumNote')]);
  rowHeights[sumIdx] = 26;

  // 一级标签列（0 笔不列、附加标签不列；依客诉生成量排序）
  const l1 = a.l1Rows
    .filter((r) => (r.l1 ?? r.l2) !== 'Sum')
    .filter((r) => genOf(r) > 0)
    .filter((r) => !/非坐席原因差[评评]/.test(r.l1 ?? r.l2 ?? ''))
    .slice()
    .sort((x, y) => genOf(y) - genOf(x));

  for (const r of l1) {
    const name = r.l1 ?? r.l2;
    const kids = a.l2Rows
      .filter((x) => x.l1 === name)
      .filter((x) => genOf(x) > 0)
      .sort((x, y) => genOf(y) - genOf(x));
    const detail = kids.map((k) => `>${k.l2} ${genOf(k)}`).join('\n');
    const ri = grid.length;
    grid.push([C(`·${name}`, 'catName'), C(genOf(r), 'catValue'), C(detail, 'detail')]);
    const lines = Math.max(1, detail.split('\n').filter(Boolean).length);
    // 列高要足够让每个二级标签各佔一行（10pt 中文約需 16pt 行高）
    rowHeights[ri] = lines > 1 ? 17 * lines + 6 : 21;
  }

  // 区塊间隔
  const gap = grid.length;
  grid.push([C('', 'spacer'), EMPTY(), EMPTY()]);
  rowHeights[gap] = 10;
}

// ── 附录：各游戏总表 ──
{
  const tIdx = grid.length;
  grid.push([C('附表：各游戏总表（应用视角）', 'title'), EMPTY(), EMPTY()]);
  merges.push([tIdx, 0, tIdx, 2]);
  rowHeights[tIdx] = 26;
  grid.push([C('', 'spacer'), EMPTY(), EMPTY()]);

  const hIdx = grid.length;
  const header = ['应用名称', ...METRICS.map((m) => m.label), '有效客诉', '无效客诉'];
  grid.push(header.map((h) => C(h, 'tableHeader')));
  rowHeights[hIdx] = 30;

  const tagByName = new Map(tagJsons.map((t) => [t.app, t]));
  for (const g of appJson.rows.filter((r) => !r.isTotal)) {
    const t = tagByName.get(g.app);
    const a2 = t ? analyze(appJson, t) : null;
    const isTotal = false;
    grid.push([
      C(g.app, 'tableText'),
      ...METRICS.map((m) => C(typeof g[m.key] === 'number' ? g[m.key] : num(g[m.key]), 'tableNum')),
      C(a2 && a2.labeled !== null ? a2.labeled : '', 'tableNum'),
      C(a2 && a2.invalid !== null ? a2.invalid : '', 'tableNum'),
    ]);
  }
  const total = appJson.rows.find((r) => r.isTotal);
  if (total) {
    grid.push([
      C('Sum（全部应用）', 'totalRowLabel'),
      ...METRICS.map((m) => C(typeof total[m.key] === 'number' ? total[m.key] : num(total[m.key]), 'totalRow')),
      C('', 'totalRow'),
      C('', 'totalRow'),
    ]);
  }
}

const outFile = outBase.endsWith('.xlsx') ? outBase : outBase + '.xlsx';
const res = await writeXlsx(outFile, grid, {
  sheetName: `${periodLabel || '客诉统计'}`.replace(/[\\/?*[\]:]/g, '-').slice(0, 31),
  colWidths: [26, 14, 44],
  rowHeights,
  freezeRows: 0,
  merges,
});
const games = grid.filter((r) => r[0] && typeof r[0].v === 'string' && /^　/.test(r[0].v)).length;
if (res.lockedFrom) {
  console.log(`⚠️ ${path.basename(res.lockedFrom)} 正被开启（锁定中），已改存为：`);
  console.log(`   ${res.file}`);
} else {
  console.log(`产出：${res.file}（${Math.round(res.bytes / 1024)} KB，${grid.length} 列，${games} 个游戏方塊）`);
}
await fs.writeFile(outBase + '.path.txt', res.file, 'utf8');
