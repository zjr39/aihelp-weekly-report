// 周报客诉统计：计算逻辑（v4，以「真实客诉」为权威）
//
// ── 权威来源：客诉列表（真实客诉明细）──
//   无效客诉 = 没有标签的客诉 + 带「无效来访」标签的客诉
//   有效客诉 = 总客诉 − 无效客诉
//   实测验证（9/24–10/8）：
//     DOE          101 = 89 有效 + 12 无效（12 笔无标签）
//     天龙八部2     54 = 48 有效 +  6 无效（6 笔无效来访）
//     パーフェクトワールド Z 23 = 19 有效 +  4 无效（4 笔无标签）
//     勇士不要停     50 = 47 有效 +  3 无效
//
// ── 统计页的标签数字（仅供明细对帳，不可用来算有效/无效）──
//   同一笔客诉可能带多个一级标签 → 一级 Sum 可能大于或小于真实客诉数
//   （DOE 一级Sum=94 < 101；天龙八部2 一级Sum=56 > 54）
import fs from 'node:fs/promises';

export const DUAL_TAGS = ['非坐席原因差评', '非坐席原因差評'];
export const INVALID_TAGS = ['无效来访', '無效來訪'];

const METRICS = [
  { key: '客诉生成量', label: '客诉生成量' },
  { key: '客诉解决量', label: '客诉解决量' },
  { key: '回复次数', label: '回复次数' },
  { key: '回复量', label: '回复量' },
  { key: '评价量', label: '评价量' },
  { key: '评价率', label: '评价率（%）' },
  { key: '好评量', label: '好评量' },
  { key: '差评量', label: '差评量' },
  { key: '满意度', label: '满意度（%）' },
];

const num = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[,\s%]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const r1 = (n) => Math.round(n * 10) / 10;
const isDual = (name) => DUAL_TAGS.includes(String(name ?? '').trim());
const genOf = (r) => num(r['客诉生成量']);
const sumGen = (rows) => rows.reduce((a, r) => a + genOf(r), 0);

function splitLevels(rows) {
  return { l1: rows.filter((r) => r.level === 'l1'), l2: rows.filter((r) => r.level !== 'l1') };
}

export function analyze(appJson, tagJson) {
  const appGames = appJson.rows.filter((r) => !r.isTotal);
  const appTotal = appJson.rows.find((r) => r.isTotal) || null;
  const appByGame = new Map(appGames.map((r) => [r.app, r]));

  const tagGameName = tagJson ? tagJson.app : null;
  const appRow = tagGameName ? appByGame.get(tagGameName) : null;
  const gen = appRow ? genOf(appRow) : null;

  const warnings = [];
  let l1Rows = [];
  let l1Sum = null;
  let l2Rows = [];
  let l2Sum = null;
  let dualRow = null;
  let dualGen = 0;
  let groups = [];
  let basis = null;
  let labeled = null; // 有效客诉
  let invalid = null;
  let effective = null;
  let tickets = null;

  if (tagJson) {
    const { l1, l2 } = splitLevels(tagJson.rows.filter((r) => !r.isTotal));
    l1Rows = l1;
    l2Rows = l2;
    l1Sum = l1.length ? sumGen(l1) : null;
    l2Sum = l2.length ? sumGen(l2) : null;
    dualRow = l1.find((r) => isDual(r.l1 ?? r.l2)) || null;
    dualGen = dualRow ? genOf(dualRow) : 0;

    l2Rows = l2Rows.slice().sort((a, b) => genOf(b) - genOf(a));
    const perL1 = new Map();
    for (const r of l2Rows) {
      const k = r.l1 ?? '-';
      const cur = perL1.get(k) || { l1: k, total: 0, items: [] };
      cur.total += genOf(r);
      cur.items.push(r);
      perL1.set(k, cur);
    }
    groups = [...perL1.values()].sort((a, b) => b.total - a.total);

    // ── 以真实客诉为权威 ──
    tickets = tagJson.tickets || null;
    if (tickets && typeof tickets.total === 'number') {
      basis = '真实客诉';
      labeled = tickets.valid;
      invalid = tickets.invalid;
    } else if (l1Sum !== null) {
      // 退回旧算法（仅供相容）并警告
      basis = '一级标签（旧算法，未用真实客诉）';
      labeled = l1Sum - dualGen;
      invalid = gen !== null ? gen - labeled : null;
      warnings.push('此游戏缺少真实客诉资料，改用一级标签推算，数字可能不準。');
    }
    effective = gen !== null && gen > 0 && labeled !== null ? r1((labeled / gen) * 100) : null;

    if (gen !== null && labeled !== null && tickets && gen !== tickets.total) {
      warnings.push(`应用视角客诉生成量(${gen}) 与真实客诉数(${tickets.total}) 不一致。`);
    }
    if (l1Sum !== null && tickets && l1Sum !== tickets.total) {
      warnings.push(
        `统计页一级标签加总(${l1Sum}) 与真实客诉数(${tickets.total}) 差 ${l1Sum - tickets.total}，` +
          `原因是有客诉带多个一级标签（统计页会重复计算）——有效/无效以真实客诉为準。`,
      );
    }
    if (tagJson.incompleteLevels?.l2) warnings.push(`二级标签资料不完整（${tagJson.incompleteLevels.l2}）。`);
  }

  const appSumGen = sumGen(appGames);
  if (appTotal && appSumGen !== genOf(appTotal)) {
    warnings.push(`应用 Sum 欄位(${genOf(appTotal)}) 与各游戏加总(${appSumGen}) 不一致。`);
  }

  return {
    appGames,
    appTotal,
    tagGameName,
    appRow,
    gen,
    basis,
    tickets,
    l1Rows,
    l1Sum,
    l2Rows,
    l2Sum,
    dualRow,
    dualGen,
    groups,
    labeled,
    invalid,
    effective,
    warnings,
    appSumGen,
  };
}

export async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

export { METRICS, num, r1, genOf, sumGen };
