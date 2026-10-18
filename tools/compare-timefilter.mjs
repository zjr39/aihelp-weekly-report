// A/B 對照：create（searchTimeType=1）vs metric（searchTimeType=0）的完整資料差異
import fs from 'node:fs/promises';

const A = 'raw/_ab_create.json'; // create 模式
const B = 'raw/202610_2026-10-02_2026-10-08.json'; // metric 模式

const a = JSON.parse(await fs.readFile(A, 'utf8'));
const b = JSON.parse(await fs.readFile(B, 'utf8'));

console.log('=== 確認兩份的篩選模式 ===');
console.log(`  A（create）: searchTimeType=${a.appView?.request?.searchTimeType}`);
console.log(`  B（metric）: searchTimeType=${b.appView?.request?.searchTimeType}`);

// ── 1) 應用視角 11 欄指標逐欄比對 ──
console.log('\n=== 應用視角：逐欄位比對 ===');
const aRows = a.appView?.statsList || [];
const bRows = b.appView?.statsList || [];
const byGame = (rows) => new Map(rows.map((r) => [r.gameName, r]));
const aMap = byGame(aRows);
const bMap = byGame(bRows);

const METRICS = [
  ['produceNum', '客诉生成量'],
  ['resolvedNum', '客诉解决量'],
  ['replyNum', '回复次数'],
  ['replyChatNum', '回复量'],
  ['feedBackNum', '评价量'],
  ['feedBackRate', '评价率'],
  ['goodFeedBackNum', '好评量'],
  ['badFeedBackNum', '差评量'],
  ['satisfactionRate', '满意度'],
  ['unResolvedNum', '未解决'],
  ['fcr', 'FCR'],
];

let anyDiff = false;
for (const [key, label] of METRICS) {
  const diffs = [];
  for (const [name, ra] of aMap) {
    const rb = bMap.get(name);
    if (!rb) continue;
    const va = ra[key];
    const vb = rb[key];
    if (String(va) !== String(vb)) diffs.push(`${name}: ${va} → ${vb}`);
  }
  if (diffs.length) {
    anyDiff = true;
    console.log(`\n  【${label}】${diffs.length} 处不同`);
    diffs.forEach((d) => console.log('     ' + d));
  }
}
if (!anyDiff) console.log('  ✅ 11 个指标全部相同');

// ── 2) 一級 / 二級標籤明細比對 ──
for (const [k, label] of [
  ['tagLevel1ByGame', '一级标签'],
  ['tagLevel2ByGame', '二级标签'],
]) {
  console.log(`\n=== ${label}：逐遊戲 Sum 比對 ===`);
  const ga = a[k] || {};
  const gb = b[k] || {};
  let diffs = 0;
  for (const gid of Object.keys(ga)) {
    const sa = ga[gid]?.sum;
    const sb = gb[gid]?.sum;
    if (String(sa) !== String(sb)) {
      console.log(`  ${ga[gid].gameName}: ${sa} → ${sb}`);
      diffs++;
    }
  }
  // 也比對每個標籤的數字
  let rowDiffs = 0;
  const rowSamples = [];
  for (const gid of Object.keys(ga)) {
    const ra = ga[gid]?.rows || [];
    const rb = gb[gid]?.rows || [];
    const keyField = k === 'tagLevel1ByGame' ? 'level1Tag' : 'level2Tag';
    const ma = new Map(ra.map((r) => [r[keyField], r.produceNum]));
    const mb = new Map(rb.map((r) => [r[keyField], r.produceNum]));
    for (const [tag, va] of ma) {
      const vb = mb.get(tag);
      if (String(va) !== String(vb)) {
        rowDiffs++;
        if (rowSamples.length < 6) rowSamples.push(`${ga[gid].gameName} / ${tag}: ${va} → ${vb}`);
      }
    }
  }
  console.log(`  Sum 不同：${diffs} 个游戏；各标签数字不同：${rowDiffs} 处`);
  rowSamples.forEach((s) => console.log('     ' + s));
}

// ── 3) 客訴明細（理論上完全不受影響）──
console.log('\n=== 客訴明細（應完全相同）===');
const ca = a.ticketsByGame || {};
const cb = b.ticketsByGame || {};
let same = true;
for (const gid of Object.keys(ca)) {
  const x = ca[gid];
  const y = cb[gid];
  if (!y) continue;
  if (x.total !== y.total || x.valid !== y.valid || x.invalid !== y.invalid) {
    same = false;
    console.log(`  ${x.gameName}: 客诉 ${x.total}→${y.total}  有效 ${x.valid}→${y.valid}  无效 ${x.invalid}→${y.invalid}`);
  }
}
if (same) console.log('  ✅ 完全相同（证明客诉明细不受筛选影响）');
