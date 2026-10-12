// 把 bin/collect.mjs 的原始输出，转成 bin/build-sheet.mjs 要的格式
//   app.json : 应用视角（各游戏 11 欄指标）
//   tag_<游戏>.json : 标签视角（一级标签 + 二级标签两層）
//
// 用法: node bin/transform.mjs --in raw/2026-W41.json --out data/2026-W41
import fs from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const inFile = arg('in');
const outBase = arg('out', 'data/collect');
if (!inFile) {
  console.error('用法: node bin/transform.mjs --in raw/xxx.json --out data/xxx');
  process.exit(1);
}

const raw = JSON.parse(await fs.readFile(inFile, 'utf8'));
const { start, end, label } = raw.period;
const ticketCounts = raw.ticketsByGame || {}; // 真实客诉数（权威来源）

// ── 应用视角 → app.json ──
const appRows = (raw.appView?.statsList || []).map((s) => ({
  app: s.gameName,
  客诉生成量: s.produceNum ?? 0,
  客诉解决量: s.resolvedNum ?? 0,
  回复次数: s.replyNum ?? 0,
  回复量: s.replyChatNum ?? 0,
  评价量: s.feedBackNum ?? 0,
  评价率: s.feedBackRate ?? 0,
  好评量: s.goodFeedBackNum ?? 0,
  差评量: s.badFeedBackNum ?? 0,
  满意度: s.satisfactionRate ?? 0,
  isTotal: s.gameId === 0 || s.gameName === 'Sum',
  gameId: s.gameId,
  // 原始欄位備查（供除错与补欄位）
  _raw: {
    unResolvedNum: s.unResolvedNum,
    closeNum: s.closeNum,
    avgFirstResponseTime: s.avgFirstResponseTime,
    avgHandleTime: s.avgHandleTime,
    fcr: s.fcr,
  },
}));

const appJson = {
  source: `AIHelp API 收集（${inFile}）`,
  capturedNote: `查詢区间 ${start} ~ ${end}`,
  timezone: 'Hongkong (GMT +8)',
  queryType: '指标发生时间',
  tab: '应用',
  columns: appRows.length ? Object.keys(appRows[0]).filter((k) => !k.startsWith('_') && !['isTotal', 'gameId'].includes(k)) : [],
  rows: appRows,
};

// ── 标签视角 → 每个游戏一个 tag.json（含 l1 / l2 两層） ──
const METRIC_MAP = [
  ['客诉生成量', 'produceNum'],
  ['客诉解决量', 'resolvedNum'],
  ['回复次数', 'replyNum'],
  ['回复量', 'replyChatNum'],
  ['评价量', 'feedBackNum'],
  ['评价率', 'feedBackRate'],
  ['好评量', 'goodFeedBackNum'],
  ['差评量', 'badFeedBackNum'],
  ['满意度', 'satisfactionRate'],
];

function tagRow(s, level, nameKey) {
  const row = { level, l1: s.level1Tag ?? null, l2: s.level2Tag ?? null };
  for (const [zh, api] of METRIC_MAP) row[zh] = s[api] ?? 0;
  row.tag = s.tag ?? null;
  return row;
}

const tagFiles = [];
await fs.mkdir(path.dirname(outBase), { recursive: true });

for (const g of raw.appList) {
  const l1 = raw.tagLevel1ByGame?.[g.gameId];
  const l2 = raw.tagLevel2ByGame?.[g.gameId];
  if (!l1 && !l2) continue;

  const rows = [];
  if (l1) {
    // 一级标签：保留 Sum 列 + 所有明细列（含 0 笔，供对帳）
    for (const s of l1.rows) {
      if (s.level1Tag === 'Sum') {
        rows.push({ level: 'l1', l1: 'Sum', ...Object.fromEntries(METRIC_MAP.map(([zh, api]) => [zh, s[api] ?? 0])), isTotal: true });
      } else {
        rows.push({ level: 'l1', l1: s.level1Tag, ...Object.fromEntries(METRIC_MAP.map(([zh, api]) => [zh, s[api] ?? 0])) });
      }
    }
  }
  if (l2) {
    for (const s of l2.rows) {
      if (s.level2Tag === 'Sum') continue; // 二级自家 Sum 已有（一级 Sum 为同值时不重复）
      rows.push({ level: 'l2', l1: s.level1Tag ?? null, l2: s.level2Tag, ...Object.fromEntries(METRIC_MAP.map(([zh, api]) => [zh, s[api] ?? 0])) });
    }
  }

  const obj = {
    source: `AIHelp API 收集（${inFile}）`,
    capturedNote: `查詢区间 ${start} ~ ${end}`,
    timezone: 'Hongkong (GMT +8)',
    queryType: '指标发生时间',
    tab: '标签',
    app: g.gameName,
    gameId: g.gameId,
    l1Sum: l1 ? l1.sum : null,
    l2Sum: l2 ? l2.sum : null,
    // 真实客诉数（权威）：无效 = 无标签 + 无效来访
    tickets: ticketCounts[g.gameId] || ticketCounts[String(g.gameId)] || null,
    rows,
  };

  const safe = g.gameName.replace(/[\\/:*?"<>|]/g, '_');
  const file = `${outBase}_tag_${g.gameId}.json`;
  await fs.writeFile(file, JSON.stringify(obj, null, 1), 'utf8');
  tagFiles.push({ file, game: g.gameName, gameId: g.gameId, l1Sum: obj.l1Sum, l2Sum: obj.l2Sum, rows: rows.length });
}

await fs.writeFile(`${outBase}_app.json`, JSON.stringify(appJson, null, 1), 'utf8');

console.log(`✅ 应用视角：${outBase}_app.json（${appRows.length} 列）`);
console.log(`✅ 标签视角：${tagFiles.length} 个档案`);
for (const t of tagFiles) console.log(`   ${t.game}（${path.basename(t.file)}）一级Sum=${t.l1Sum} 二级Sum=${t.l2Sum} 共 ${t.rows} 列`);
console.log(`\n下一步：node bin/build-sheet.mjs --layout stack --app ${outBase}_app.json ${tagFiles.map((t) => `--game ${t.file}`).join(' ')} --period "${label}" --out report/week`);
