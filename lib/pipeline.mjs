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
export async function transform({ inFile, outBase, onLog = () => {}, summaries = null }) {
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
      // 「具体内容」摘要：{ 二级标签名: 一句摘要 }
      summaries: (summaries && (summaries[g.gameName] || summaries[g.gameId] || summaries[String(g.gameId)])) || {},
      rows,
    };
    const file = `${outBase}_tag_${g.gameId}.json`;
    await fs.writeFile(file, JSON.stringify(obj, null, 1), 'utf8');
    tagFiles.push(file);
  }
  onLog(`标签视角：${tagFiles.length} 个游戏`);
  return { appFile: `${outBase}_app.json`, tagFiles };
}

/**
 * 为「具体内容」摘要准备输入：每个游戏的每个二级标签，收集对应客诉的玩家发言。
 *
 * ── 关键：标签是树状的，客诉带的是「叶节点」标签 ──
 *   统计页把标签汇总到二级（例如 L2「內容/玩法咨詢」= 13 笔，其中 8 笔的
 *   实际标签是 L3「游戏道具」、1 笔是 L3「未来咨讯」、4 笔直接标在 L2）。
 *   所以不能直接用 tagList 的名称去比对 L2 名称 —— 必须先用标签树
 *   （tagLevel2ByGame[gid].tagTree）把每个叶节点映射回它的 L2 祖先。
 *
 *   实测（DOE 2026-10-02~10-08）：用这个方法后每个 L2 标签的笔数与统计页
 *   完全一致（13=13、2=2、4=4、1=1…）。
 */
export function prepareSummaryGroups(raw) {
  const groups = [];
  const details = raw.ticketDetails || {};
  const convs = raw.conversations || {};

  for (const g of raw.appList || []) {
    const gid = String(g.gameId);
    const d = details[gid] || details[g.gameId];
    const l2 = raw.tagLevel2ByGame?.[gid] || raw.tagLevel2ByGame?.[g.gameId];
    if (!d || !l2) continue;

    const items = d.items || [];

    // 1) 從標籤樹建立「標籤名 → 所屬 L1 / L2」對照
    const ancestor = new Map(); // tagName -> { l1, l2, level }
    (function walk(nodes, path) {
      for (const n of nodes || []) {
        const p = [...path, n];
        const l1 = p.find((x) => Number(x.level) === 1);
        const l2n = p.find((x) => Number(x.level) === 2);
        if (n.tagName) ancestor.set(n.tagName, { l1: l1?.tagName || null, l2: l2n?.tagName || null, level: Number(n.level) });
        walk(n.children, p);
      }
    })(l2.tagTree || [], []);

    // 2) 把每筆客訴的標籤往上捲到 L2（一個客訴對同一個 L2 只算一次）
    const byL2 = new Map(); // L2 名 -> [客訴]
    const byL1 = new Map(); // L1 名 -> [客訴]（給「只有 L1、沒有 L2 子項」的標籤用）
    for (const it of items) {
      const seenL2 = new Set();
      const seenL1 = new Set();
      for (const t of it.tags || []) {
        const info = ancestor.get(t);
        // 標籤不在樹裡時，就用標籤本身當名稱（可能是新建但未同步的標籤）
        const l2Name = info ? info.l2 || info.l1 || t : t;
        const l1Name = info ? info.l1 || t : t;
        if (!seenL2.has(l2Name)) {
          seenL2.add(l2Name);
          if (!byL2.has(l2Name)) byL2.set(l2Name, []);
          byL2.get(l2Name).push(it);
        }
        if (!seenL1.has(l1Name)) {
          seenL1.add(l1Name);
          if (!byL1.has(l1Name)) byL1.set(l1Name, []);
          byL1.get(l1Name).push(it);
        }
      }
    }

    // 3) 把客訴的發言收集起來（優先對話，沒有就用標題）
    const messagesOf = (list) => {
      const out = [];
      for (const it of list) {
        const c = it.ticketId ? convs[it.ticketId] : null;
        if (c && c.player && c.player.length) {
          for (const p of c.player) out.push(p.text);
        } else {
          const title = String(it.title || '')
            .replace(/^\s*\[\d+\]\s*/, '')
            .trim();
          if (title) out.push(title);
        }
      }
      return out;
    };

    const tagItems = [];
    for (const r of l2.rows || []) {
      const tag = r.level2Tag;
      if (!tag || tag === 'Sum') continue;
      if (/非坐席原因差[评評]/.test(tag)) continue;
      // 原始統計資料的欄位是 produceNum；已轉換過的資料是「客诉生成量」
      const count = num(r.produceNum ?? r['客诉生成量']);
      if (count <= 0) continue;

      const matched = byL2.get(tag) || byL1.get(tag) || [];
      const messages = messagesOf(matched);
      if (!messages.length) continue;
      tagItems.push({ tag, messages, count, matched: matched.length });
    }

    if (tagItems.length) groups.push({ gameName: g.gameName, gameId: g.gameId, items: tagItems });
  }
  return groups;
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

  grid.push([C(`客诉统计周报　${periodLabel}`, 'title'), EMPTY(), EMPTY(), EMPTY(), EMPTY()]);
  merges.push([0, 0, 0, 4]);
  rowHeights[0] = 30;
  grid.push([C(appJson.capturedNote || `统计区间 ${periodLabel}`, 'subtitle'), EMPTY(), EMPTY(), EMPTY(), EMPTY()]);
  merges.push([1, 0, 1, 4]);
  rowHeights[1] = 18;
  grid.push([C('', 'spacer'), EMPTY(), EMPTY(), EMPTY(), EMPTY()]);
  rowHeights[2] = 8;

  for (const tagJson of ordered) {
    const a = analyze(appJson, tagJson);
    if (skipEmpty && !(a.gen > 0)) continue;
    const sums = tagJson.summaries || {};

    const nameIdx = grid.length;
    grid.push([C(`　${a.tagGameName}`, 'gameName'), C('', 'gameName'), C('', 'gameName'), C('', 'gameName'), C('', 'gameName')]);
    merges.push([nameIdx, 0, nameIdx, 4]);
    rowHeights[nameIdx] = 24;

    const sumIdx = grid.length;
    grid.push([C(`总客诉量 (${periodLabel})`, 'sumLabel'), C(`${a.labeled}+${a.invalid}（无效）`, 'sumValue'), C('', 'sumNote'), C('', 'sumNote'), C('', 'sumNote')]);
    merges.push([sumIdx, 1, sumIdx, 1]);
    rowHeights[sumIdx] = 26;

    // 表头：一级标签 | 数量 | 二级标签 | 数量 | 具体内容
    const headIdx = grid.length;
    grid.push([
      C('一级标签', 'tableHeader'),
      C('数量', 'tableHeader'),
      C('二级标签', 'tableHeader'),
      C('数量', 'tableHeader'),
      C('具体内容', 'tableHeader'),
    ]);
    rowHeights[headIdx] = 22;

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

      if (!kids.length) {
        // 只有一级标签、没有二级明细时的退路
        const ri = grid.length;
        grid.push([C(`·${name}`, 'catName'), C(genOf(r), 'catValue'), C('', 'subCatName'), C('', 'subCatValue'), C('', 'summary')]);
        rowHeights[ri] = 21;
        continue;
      }

      const firstRow = grid.length;
      for (let i = 0; i < kids.length; i++) {
        const k = kids[i];
        const ri = grid.length;
        const isFirst = i === 0;
        const summary = sums[k.l2] || '';
        grid.push([
          C(isFirst ? `·${name}` : '', isFirst ? 'catName' : 'subCatName'),
          C(isFirst ? genOf(r) : '', isFirst ? 'catValue' : 'subCatValue'),
          C(`>${k.l2}`, 'subCatName'),
          C(genOf(k), 'subCatValue'),
          C(summary, 'summary'),
        ]);
        // 摘要可能较长，估算需要几行
        const chars = String(summary).length;
        rowHeights[ri] = chars > 26 ? 17 * Math.ceil(chars / 26) + 6 : 21;
      }
      // 一级标签跨它的二级行合并（只有多于一行时才需要）
      if (kids.length > 1) {
        const lastRow = grid.length - 1;
        merges.push([firstRow, 0, lastRow, 0]);
        merges.push([firstRow, 1, lastRow, 1]);
      }
    }

    const gap = grid.length;
    grid.push([C('', 'spacer'), EMPTY(), EMPTY(), EMPTY(), EMPTY()]);
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
    colWidths: [22, 8, 24, 8, 52],
    rowHeights,
    freezeRows: 0,
    merges,
  });
  await fs.writeFile(outBase + '.path.txt', res.file, 'utf8');
  return res;
}
