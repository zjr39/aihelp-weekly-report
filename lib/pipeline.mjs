// 周报产生流程的模组化版本（GUI 直接呼叫，不用子程序）
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyze, genOf, METRICS, num } from './report.mjs';
import { writeXlsx } from './xlsx.mjs';

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

/** 把 collectCore 的原始输出转成报表要用的 app.json / tag_*.json */
export async function transform({ inFile, outBase, onLog = () => {} }) {
  const raw = JSON.parse(await fs.readFile(inFile, 'utf8'));
  const { start, end } = raw.period;
  const ticketCounts = raw.ticketsByGame || {};

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
  }));

  const appJson = {
    source: `AIHelp（${path.basename(inFile)}）`,
    capturedNote: `统计区间 ${start} ~ ${end}`,
    timezone: 'Hongkong (GMT +8)',
    queryType: '指标发生时间',
    tab: '应用',
    columns: ['应用名称', ...METRICS.map((m) => m.label)],
    rows: appRows,
  };

  await fs.mkdir(path.dirname(outBase), { recursive: true });
  await fs.writeFile(`${outBase}_app.json`, JSON.stringify(appJson, null, 1), 'utf8');
  onLog(`应用视角：${appRows.length} 列`);

  const tagFiles = [];
  for (const g of raw.appList) {
    const l1 = raw.tagLevel1ByGame?.[g.gameId];
    const l2 = raw.tagLevel2ByGame?.[g.gameId];
    if (!l1 && !l2) continue;

    const rows = [];
    if (l1) {
      for (const s of l1.rows) {
        const base = Object.fromEntries(METRIC_MAP.map(([zh, api]) => [zh, s[api] ?? 0]));
        if (s.level1Tag === 'Sum') rows.push({ level: 'l1', l1: 'Sum', ...base, isTotal: true });
        else rows.push({ level: 'l1', l1: s.level1Tag, ...base });
      }
    }
    if (l2) {
      for (const s of l2.rows) {
        if (s.level2Tag === 'Sum') continue;
        rows.push({ level: 'l2', l1: s.level1Tag ?? null, l2: s.level2Tag, ...Object.fromEntries(METRIC_MAP.map(([zh, api]) => [zh, s[api] ?? 0])) });
      }
    }

    const obj = {
      source: `AIHelp（${path.basename(inFile)}）`,
      capturedNote: `统计区间 ${start} ~ ${end}`,
      timezone: 'Hongkong (GMT +8)',
      queryType: '指标发生时间',
      tab: '标签',
      app: g.gameName,
      gameId: g.gameId,
      l1Sum: l1 ? l1.sum : null,
      l2Sum: l2 ? l2.sum : null,
      tickets: ticketCounts[g.gameId] || ticketCounts[String(g.gameId)] || null,
      rows,
    };
    const file = `${outBase}_tag_${g.gameId}.json`;
    await fs.writeFile(file, JSON.stringify(obj, null, 1), 'utf8');
    tagFiles.push(file);
  }
  onLog(`标签视角：${tagFiles.length} 个游戏`);
  return { appFile: `${outBase}_app.json`, tagFiles };
}

/** 产生 .tsv（往下堆疊版面） */
export async function buildSheet({ appFile, tagFiles, periodLabel, outBase }) {
  const appJson = JSON.parse(await fs.readFile(appFile, 'utf8'));
  const tagJsons = [];
  for (const f of tagFiles) tagJsons.push(JSON.parse(await fs.readFile(f, 'utf8')));

  const Q = (v) => {
    const s = String(v ?? '');
    return /[\t"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [];
  for (const tagJson of tagJsons) {
    const a = analyze(appJson, tagJson);
    if (!(a.gen > 0)) continue;
    lines.push(Q(a.tagGameName));
    lines.push([Q(`总客诉量 (${periodLabel})`), Q(`${a.labeled}+${a.invalid}（无效）`)].join('\t'));
    lines.push('');
    const l1 = a.l1Rows
      .filter((r) => (r.l1 ?? r.l2) !== 'Sum')
      .filter((r) => genOf(r) > 0)
      .filter((r) => !/非坐席原因差[评评]/.test(r.l1 ?? r.l2 ?? ''))
      .sort((x, y) => genOf(y) - genOf(x));
    for (const r of l1) {
      const name = r.l1 ?? r.l2;
      const kids = a.l2Rows
        .filter((x) => x.l1 === name)
        .filter((x) => genOf(x) > 0)
        .sort((x, y) => genOf(y) - genOf(x));
      lines.push([Q(`·${name}`), Q(genOf(r)), Q(kids.map((k) => `>${k.l2} ${genOf(k)}`).join('\n'))].join('\t'));
    }
    lines.push('');
    lines.push('');
  }
  await fs.mkdir(path.dirname(outBase), { recursive: true });
  await fs.writeFile(`${outBase}.tsv`, '\uFEFF' + lines.join('\n'), 'utf8');
  return { file: `${outBase}.tsv`, lines: lines.length };
}

/** 产生格式化的 .xlsx */
export async function buildXlsxReport({ appFile, tagFiles, periodLabel, outBase, skipEmpty = true }) {
  const appJson = JSON.parse(await fs.readFile(appFile, 'utf8'));
  const tagJsons = [];
  for (const f of tagFiles) tagJsons.push(JSON.parse(await fs.readFile(f, 'utf8')));

  const appGen = new Map(appJson.rows.map((r) => [r.app, genOf(r)]));
  const ordered = tagJsons.slice().sort((a, b) => (appGen.get(b.app) ?? 0) - (appGen.get(a.app) ?? 0));

  const grid = [];
  const rowHeights = {};
  const merges = [];
  const C = (v, s) => ({ v, s });
  const EMPTY = () => C('', 'default');

  grid.push([C(`客诉统计周报　${periodLabel}`, 'title'), EMPTY(), EMPTY()]);
  merges.push([0, 0, 0, 2]);
  rowHeights[0] = 30;
  grid.push([C(appJson.capturedNote || `统计区间 ${periodLabel}`, 'subtitle'), EMPTY(), EMPTY()]);
  merges.push([1, 0, 1, 2]);
  rowHeights[1] = 18;
  grid.push([C('', 'spacer'), EMPTY(), EMPTY()]);
  rowHeights[2] = 8;

  for (const tagJson of ordered) {
    const a = analyze(appJson, tagJson);
    if (skipEmpty && !(a.gen > 0)) continue;

    const nameIdx = grid.length;
    grid.push([C(`　${a.tagGameName}`, 'gameName'), C('', 'gameName'), C('', 'gameName')]);
    merges.push([nameIdx, 0, nameIdx, 2]);
    rowHeights[nameIdx] = 24;

    const sumIdx = grid.length;
    grid.push([C(`总客诉量 (${periodLabel})`, 'sumLabel'), C(`${a.labeled}+${a.invalid}（无效）`, 'sumValue'), C('', 'sumNote')]);
    rowHeights[sumIdx] = 26;

    const l1 = a.l1Rows
      .filter((r) => (r.l1 ?? r.l2) !== 'Sum')
      .filter((r) => genOf(r) > 0)
      .filter((r) => !/非坐席原因差[评评]/.test(r.l1 ?? r.l2 ?? ''))
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
      const lineCount = Math.max(1, detail.split('\n').filter(Boolean).length);
      rowHeights[ri] = lineCount > 1 ? 17 * lineCount + 6 : 21;
    }

    const gap = grid.length;
    grid.push([C('', 'spacer'), EMPTY(), EMPTY()]);
    rowHeights[gap] = 10;
  }

  // 附表
  const tIdx = grid.length;
  grid.push([C('附表：各游戏总表（应用视角）', 'title'), EMPTY(), EMPTY()]);
  merges.push([tIdx, 0, tIdx, 2]);
  rowHeights[tIdx] = 26;
  grid.push([C('', 'spacer'), EMPTY(), EMPTY()]);
  grid.push(['应用名称', ...METRICS.map((m) => m.label), '有效客诉', '无效客诉'].map((h, i) => C(h, 'tableHeader')));
  rowHeights[grid.length - 1] = 30;

  const tagByName = new Map(tagJsons.map((t) => [t.app, t]));
  for (const g of appJson.rows.filter((r) => !r.isTotal)) {
    const t = tagByName.get(g.app);
    const a2 = t ? analyze(appJson, t) : null;
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

  const file = outBase.endsWith('.xlsx') ? outBase : outBase + '.xlsx';
  const res = await writeXlsx(file, grid, {
    sheetName: `${periodLabel || '客诉统计'}`.replace(/[\\/?*[\]:]/g, '-').slice(0, 31),
    colWidths: [26, 14, 44],
    rowHeights,
    freezeRows: 0,
    merges,
  });
  await fs.writeFile(outBase + '.path.txt', res.file, 'utf8');
  return res;
}
