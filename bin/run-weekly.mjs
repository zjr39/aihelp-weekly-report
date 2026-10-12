// 周报客诉统计 —— 一键执行（命令列）
//
// 用法:
//   node bin/run-weekly.mjs                          # 上一个周期（预设：上周五~本周四）
//   node bin/run-weekly.mjs --week this              # 本周期
//   node bin/run-weekly.mjs --start 2026-10-09 --end 2026-10-15
//   node bin/run-weekly.mjs --skip-collect           # 用既有 raw 档重跑报表
//
// 参数:
//   --start / --end <YYYY-MM-DD>   明确指定区间
//   --week <last|this>             自动算出区间
//   --week-anchor <fri|mon>        周期起始日（预设 fri = 周五~周四）
//   --label <文字>                 报表标题用的短标签
//   --out <名称>                   输出档名（预设依日期生成）
//   --skip-collect                 跳过抓取，直接用既有的 raw/<out>.json
//   --no-open                      不要自动开启产出的档案
//
// 流程: 检查登入 -> 抓取(collect) -> 转换(transform) -> 产表(buildSheet + buildXlsxReport)
//
// 注意：这里是「直接呼叫模组」，不是用子程序跑其他脚本。
//       早期版本用 spawnSync 逐一把 CLI 包装当子程序跑，会有管道缓冲与
//       路径解析问题，已全部改掉。
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureDirs, ROOT } from '../lib/config.mjs';
import { listTargets, findPage, connect } from '../lib/cdp.mjs';
import { collect, StopRequested } from '../lib/collectCore.mjs';
import { transform, buildSheet, buildXlsxReport } from '../lib/pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───────── 参数解析 ─────────
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);

function parseDay(s, isEnd) {
  const m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) throw new Error(`日期格式错误：「${s}」（请用 YYYY-MM-DD，例如 2026-10-09）`);
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')} ${isEnd ? '23:59:59' : '00:00:00'}`;
}
const fmtDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * 算出「統計周期」。
 *
 * 本工具的預設周期是**周五 ~ 周四**（客服团队常见的结算周期），
 * 而不是日历上的周一~周日。
 *
 * 作法是錨定在**結束日**（週四）：找含今天在內、最近一次週四，
 * 再往前推 6 天就是起始日（週五）。這樣「本周期」與介面上的
 * 「本周」按鈕結果完全一致。
 *
 * 用 --week-anchor mon 可以改成周一~周日制。
 */
function periodOf(anchorDow, offsetWeeks) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const endDow = (anchorDow + 6) % 7; // 周五(5) -> 結束日周四(4)
  const back = (now.getDay() - endDow + 7) % 7;
  const endDay = new Date(now);
  endDay.setDate(endDay.getDate() - back + offsetWeeks * 7);
  const startDay = new Date(endDay);
  startDay.setDate(startDay.getDate() - 6);
  return { start: fmtDay(startDay), end: fmtDay(endDay) };
}

const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

let start = arg('start');
let end = arg('end');
const week = arg('week');
const anchorName = (arg('week-anchor') || 'fri').toLowerCase();
const anchorDow = anchorName === 'mon' ? 1 : 5;

if (week) {
  if (week !== 'last' && week !== 'this') throw new Error('--week 只接受 last 或 this');
  const p = periodOf(anchorDow, week === 'last' ? -1 : 0);
  start = p.start;
  end = p.end;
  console.log(`（--week ${week} 自动算出：${start}（${WEEK_NAMES[anchorDow]}） ~ ${end}）`);
}

if (!start || !end) {
  // 没给参数时，预设跑「上一个完整周期」
  const p = periodOf(anchorDow, -1);
  start = p.start;
  end = p.end;
  console.log(`（未指定区间，预设使用上一个周期：${start} ~ ${end}）`);
}

const startFull = parseDay(start, false);
const endFull = parseDay(end, true);
if (startFull > endFull) throw new Error(`起始日（${start}）晚于结束日（${end}）`);

const label = arg('label', `${start.slice(5).replace('-', '/')}-${end.slice(5).replace('-', '/')}`);
const outName = arg('out', start.slice(0, 7).replace('-', '') + '_' + start + '_' + end);
const skipCollect = has('skip-collect');
const noOpen = has('no-open');

const cfg = await loadConfig();

if (!cfg.configured) {
  console.error(`
  尚未完成设定。

  请先执行：  npm run setup
`);
  process.exit(1);
}

await ensureDirs(cfg);

const rawFile = path.join(cfg.rawDir, `${outName}.json`);
const dataBase = path.join(cfg.dataDir, outName);
const reportBase = path.join(cfg.reportDir, outName);

console.log('='.repeat(66));
console.log(`  客诉周报自动化　统计区间：${startFull} ~ ${endFull}`);
console.log(`  报表标签：${label}　站台：${cfg.host}`);
console.log('='.repeat(66));

const t0 = Date.now();
const step = (n, t) => console.log(`\n${'─'.repeat(66)}\n[${n}] ${t}\n${'─'.repeat(66)}`);

// ───────── 0) 环境检查 ─────────
step('0/4', '检查专用浏览器与登入状态');
{
  if (!cfg.chrome) {
    console.error('\n  找不到 Chrome。请执行 npm run setup 重新设定。');
    process.exit(1);
  }
  let targets = [];
  try {
    targets = await listTargets(cfg.port);
  } catch {
    console.log('  专用浏览器没在跑，正在启动…');
    const child = spawn(cfg.chrome, [`--remote-debugging-port=${cfg.port}`, `--user-data-dir=${cfg.profileDir}`, '--no-first-run', '--no-default-browser-check', cfg.dashboardUrl], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    const { waitForCdp } = await import('../lib/cdp.mjs');
    const ver = await waitForCdp(cfg.port, 60);
    if (!ver) {
      console.error('\n  浏览器启动失败。请执行 npm run setup 检查环境。');
      process.exit(1);
    }
    targets = await listTargets(cfg.port);
  }
  const page = findPage(targets, cfg.host);
  if (!page) {
    console.error('\n  找不到 AIHelp 分页。请执行 npm run chrome 后再试。');
    process.exit(1);
  }

  const conn = await connect(cfg.port);
  const sid = await conn.attach(page.id);
  const ev = conn.makeEval(sid);
  // 背景分页的 innerText 一律是空的，所以要一并看 DOM 证据
  const href = await ev('location.href');
  const text = await ev('document.body ? document.body.innerText.slice(0,120) : ""');
  const tabs = await ev(`document.querySelectorAll('.el-tabs__item').length`);
  const tokenLen = await ev(`(localStorage.getItem('token')||'').length`);
  conn.close();

  const needLogin = /#\/login|#\/signin/i.test(href) || /登录您的账号|登入您的帳號/.test(text) || (tabs < 5 && tokenLen === 0);
  if (needLogin) {
    console.error('\n  登入已失效。请在专用浏览器视窗重新登入 AIHelp，然后再跑一次。');
    process.exit(2);
  }
  console.log('  ✓ 已登入');
}

// ───────── 1) 抓取 ─────────
let raw;
if (skipCollect) {
  step('1/4', `跳过抓取，使用既有的 ${path.relative(ROOT, rawFile)}`);
  raw = JSON.parse(await fs.readFile(rawFile, 'utf8'));
  console.log(`  （该档区间为 ${raw.period.start} ~ ${raw.period.end}，建立于 ${raw.collectedAt}）`);
} else {
  step('1/4', '抓取资料（应用视角 + 真实客诉 + 一级/二级标签）');
  const res = await collect({
    start: startFull,
    end: endFull,
    label,
    outBase: path.join(cfg.rawDir, outName),
    onLog: (m) => console.log(m),
    onProgress: () => {},
  });
  raw = JSON.parse(await fs.readFile(res.outFile, 'utf8'));
}

// ───────── 2) 转换 ─────────
step('2/4', '转换成报表格式');
const { appFile, tagFiles } = await transform({ inFile: rawFile, outBase: dataBase, onLog: (m) => console.log('  ' + m) });
if (!tagFiles.length) throw new Error('找不到标签资料档，转换步骤可能失败');

// ───────── 3) 产生报表 ─────────
step('3/4', '产生报表（往下堆叠版面）');
const sheet = await buildSheet({ appFile, tagFiles, periodLabel: label, outBase: reportBase });
console.log(`  文字档：${path.relative(ROOT, sheet.file)}（${sheet.lines} 行）`);

const shortCN = (d) => {
  const [, mo, dd] = d.split('-');
  return `${Number(mo)}月${Number(dd)}`;
};
const xlsxName = `周报_${shortCN(start)}-${shortCN(end)}`;

step('3b/4', '产生离线 Excel 档（.xlsx）');
const xlsx = await buildXlsxReport({ appFile, tagFiles, periodLabel: label, outBase: path.join(cfg.reportDir, xlsxName) });
const xlsxPath = xlsx.file;

// ───────── 4) 完成 ─────────
const secs = Math.round((Date.now() - t0) / 1000);
const tsv = reportBase + '.tsv';
const counts = Object.values(raw.ticketsByGame || {});
const sumValid = counts.reduce((a, c) => a + (c.valid || 0), 0);
const sumInvalid = counts.reduce((a, c) => a + (c.invalid || 0), 0);

step('4/4', '完成');
console.log(`  耗时：${Math.floor(secs / 60)} 分 ${secs % 60} 秒`);
console.log(`  游戏数：${counts.length}　有效合计：${sumValid}　无效合计：${sumInvalid}`);
console.log('');
console.log(`  Excel ：${xlsxPath}   <- 双击即可开启`);
console.log(`  文字档：${tsv}`);
console.log(`  原始档：${rawFile}`);

if (!noOpen) {
  try {
    const child = spawn('cmd', ['/c', 'start', '', xlsxPath], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log('\n  已为你开启 Excel 档。');
  } catch {
    console.log('\n  （自动开启失败，请手动打开上面的路径）');
  }
}
console.log('');

process.exit(0);
