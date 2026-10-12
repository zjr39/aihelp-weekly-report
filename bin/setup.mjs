// 首次设定精灵
//
// 用法:
//   node bin/setup.mjs                          互动模式
//   node bin/setup.mjs --url <dashboardUrl> --yes   非互动（给自动化用）
//   node bin/setup.mjs --check                  只检查环境，不写入设定
//
// 做六件事:
//   1. 检查 Node 版本
//   2. 探索 Chrome / Edge
//   3. 询问 AIHelp 仪表板网址
//   4. 建立输出资料夹
//   5. 启动专用 Chrome 并请使用者登入一次
//   6. 验证抓得到游戏清单，成功才写入 config.json
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { loadConfig, saveConfig, ensureDirs, findBrowser, deriveSite, isConfigured, ROOT, CONFIG_FILE } from '../lib/config.mjs';
import { waitForCdp, listTargets, findPage, connect, sleep } from '../lib/cdp.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);

// --check 只做环境检查，绝不提问、绝不写入
const checkOnly = has('check');
const nonInteractive = has('yes') || !!arg('url') || checkOnly;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};
const ok = (m) => console.log(`  ${C.green}✓${C.reset} ${m}`);
const bad = (m) => console.log(`  ${C.red}✗${C.reset} ${m}`);
const warn = (m) => console.log(`  ${C.yellow}!${C.reset} ${m}`);
const step = (n, m) => console.log(`\n${C.cyan}${C.bold}[${n}] ${m}${C.reset}`);
const info = (m) => console.log(`    ${C.dim}${m}${C.reset}`);

let rl = null;
const ask = async (q, dflt) => {
  if (nonInteractive) return dflt;
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = dflt ? ` ${C.dim}(预设: ${dflt})${C.reset}` : '';
  const a = (await rl.question(`  ${q}${suffix}\n  > `)).trim();
  return a || dflt;
};
const confirm = async (q, dfltYes = true) => {
  if (nonInteractive) return dfltYes;
  const a = (await ask(`${q} [${dfltYes ? 'Y/n' : 'y/N'}]`)).toLowerCase();
  if (!a) return dfltYes;
  return a === 'y' || a === 'yes' || a === '是';
};

function bail(msg, hint) {
  console.log('');
  bad(msg);
  if (hint) hint.split('\n').forEach((l) => info(l));
  if (rl) rl.close();
  process.exit(1);
}

console.log(`${C.bold}
  ╭──────────────────────────────────────────────╮
  │  AIHelp 客诉周报工具 - 首次设定              │
  ╰──────────────────────────────────────────────╯${C.reset}`);

// ───────── 1) Node 版本 ─────────
step(1, '检查 Node.js');
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  bail(`Node.js 版本过旧（${process.versions.node}），需要 18 以上。`, '请到 https://nodejs.org/ 下载 LTS 版本安装后重试。');
}
ok(`Node.js ${process.versions.node}`);

// ───────── 2) 浏览器 ─────────
step(2, '寻找浏览器');
const browser = await findBrowser();
if (!browser) {
  bail(
    '找不到 Chrome 或 Edge。',
    '本工具需要一个 Chromium 核心的浏览器来连线 AIHelp。\n' +
      '请安装 Google Chrome：https://www.google.com/chrome/\n' +
      '或用环境变数指定路径：set AIHELP_CHROME=D:\\path\\to\\chrome.exe',
  );
}
ok(`找到 ${browser.kind === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'}`);
info(browser.path);
if (browser.kind === 'edge') {
  warn('用的是 Edge。功能相同，但本工具主要针对 Chrome 测试。');
}

// ───────── 3) 仪表板网址 ─────────
step(3, 'AIHelp 仪表板网址');
let url = arg('url') || process.env.AIHELP_DASHBOARD_URL || null;

if (!url) {
  const cur = await loadConfig();
  if (isConfigured(cur)) {
    info(`目前设定：${cur.dashboardUrl}`);
    const keep = await confirm('沿用这个网址吗？', true);
    if (keep) url = cur.dashboardUrl;
  }
}

while (!url) {
  const input = await ask('请贴上你的 AIHelp 仪表板网址\n（就是平常打开客诉统计页面时，浏览器网址列的那串）');
  const candidate = String(input || '').trim();
  if (!candidate) {
    warn('不能空白。');
    continue;
  }
  try {
    const u = new URL(candidate.startsWith('http') ? candidate : 'https://' + candidate);
    if (!/aihelp/i.test(u.host)) {
      warn(`网址看起来不像 AIHelp（host = ${u.host}）。`);
      if (!(await confirm('仍然要用这个网址吗？', false))) continue;
    }
    url = candidate.startsWith('http') ? candidate : 'https://' + candidate;
  } catch {
    warn('这不是有效的网址，请再试一次。');
  }
}

let site;
try {
  site = deriveSite(url);
} catch (e) {
  bail(`网址解析失败：${e.message}`);
}
ok(`站台：${site.origin}`);
info(`host = ${site.host}`);

if (checkOnly) {
  console.log(`\n${C.green}环境检查完成（--check 模式，未写入设定）。${C.reset}\n`);
  if (rl) rl.close();
  process.exit(0);
}

// ───────── 4) 写入设定 + 建资料夹 ─────────
step(4, '建立设定与资料夹');
await saveConfig({ dashboardUrl: site.dashboardUrl });
ok(`已写入 ${path.relative(ROOT, CONFIG_FILE)}`);

const cfg = await loadConfig();
await ensureDirs(cfg);
ok('已建立 raw/ data/ report/ downloads/');

// ───────── 5) 启动 Chrome、请使用者登入 ─────────
step(5, '启动专用浏览器并登入');
if (!cfg.chrome) bail('设定档里没有浏览器路径。');

// 已经在跑就沿用
let ver = await waitForCdp(cfg.port, 2);
if (ver) {
  ok('专用浏览器已在执行，沿用它');
} else {
  await fs.mkdir(cfg.profileDir, { recursive: true });
  const child = spawn(
    cfg.chrome,
    [
      `--remote-debugging-port=${cfg.port}`,
      `--user-data-dir=${cfg.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      site.dashboardUrl,
    ],
    { stdio: 'ignore', detached: true },
  );
  child.unref();
  info(`已启动（pid ${child.pid}）`);
  ver = await waitForCdp(cfg.port, 60);
  if (!ver) bail('浏览器启动失败（CDP 端点未出现）。', '请确认没有其他程序占用连接埠 ' + cfg.port);
}
ok(`CDP 就绪：${ver.Browser}`);

// 找页面
async function pickPage() {
  let targets = await listTargets(cfg.port);
  let page = findPage(targets, cfg.host);
  if (page && !page.url.startsWith('about:')) return page;
  const conn0 = await connect(cfg.port);
  const { targetId } = await conn0.send('Target.createTarget', { url: site.dashboardUrl });
  conn0.close();
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    targets = await listTargets(cfg.port);
    const p = targets.find((t) => t.id === targetId && !t.url.startsWith('about:')) || findPage(targets, cfg.host);
    if (p && !p.url.startsWith('about:')) return p;
  }
  return findPage(targets, cfg.host);
}

const page = await pickPage();
if (!page) bail('找不到仪表板分页。');

// 等页面渲染（注意：背景分页的 innerText 一律是空的，只能用 DOM 数量判断）
const conn = await connect(cfg.port);
const sid = await conn.attach(page.id);
const ev = conn.makeEval(sid);

const readState = async () => {
  const href = await ev('location.href');
  const tabs = await ev(`document.querySelectorAll('.el-tabs__item').length`);
  const tokenLen = await ev(`(localStorage.getItem('token')||'').length`);
  const text = await ev('document.body ? document.body.innerText.slice(0,150) : ""');
  const needLogin = /#\/login|#\/signin/i.test(href) || /登录您的账号|登入您的帳號/.test(text) || (tabs < 5 && tokenLen === 0);
  return { href, tabs, tokenLen, needLogin };
};

let st = await readState();
if (st.needLogin) {
  console.log('');
  warn('尚未登入 AIHelp。');
  info('请切换到刚打开的浏览器视窗，输入你的 AIHelp 帐号密码登入。');
  info('登入完成后回到这里按 Enter 继续。');
  if (nonInteractive) {
    warn('（非互动模式：等待最多 3 分钟）');
  } else {
    await ask('登入完成后按 Enter');
  }
  // 等登入完成
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < 180000) {
    await sleep(2000);
    try {
      st = await readState();
    } catch {
      continue;
    }
    if (!st.needLogin) break;
    const cur = `tabs=${st.tabs} token=${st.tokenLen}`;
    if (cur !== last) {
      last = cur;
      info(`等待中… ${cur}`);
    }
  }
  if (st.needLogin) {
    conn.close();
    bail('仍侦测不到登入状态。', '请确认浏览器里已经登入成功，然后重新执行 npm run setup');
  }
}
ok('已登入');

// ───────── 6) 验证抓得到游戏清单 ─────────
step(6, '验证连线');
info('正在读取你的游戏（应用）清单…');

// 到客诉统计页
await conn.send('Page.navigate', { url: site.dashboardUrl }, sid).catch(() => {});
for (let i = 0; i < 40; i++) {
  try {
    if ((await ev(`document.querySelectorAll('.el-tabs__item').length`)) >= 5) break;
  } catch {}
  await sleep(1000);
}
await sleep(1500);

// 用页面自身的元件读取应用清单（与采集流程相同的路径）
const gamesRaw = await ev(`
(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  for (const el of document.querySelectorAll('*')) {
    const v = el.__vue__;
    if (v && v.$options && v.$options.name === 'SearchView' && Array.isArray(v.selectAppList)) {
      return JSON.stringify({ ok: true, count: v.selectAppList.length });
    }
  }
  return JSON.stringify({ ok: false });
})()
`);

let gameCount = 0;
try {
  const g = JSON.parse(gamesRaw);
  gameCount = g.count || 0;
} catch {}

conn.close();

if (gameCount > 0) {
  ok(`读取到 ${gameCount} 个应用`);
} else {
  warn('读不到应用清单（可能页面还在载入）。');
  info('这不影响安装，第一次采集时会重新读取。');
}

// ───────── 完成 ─────────
console.log(`
${C.green}${C.bold}  设定完成！${C.reset}

  接下来：
    ${C.bold}npm start${C.reset}          开启可视化界面
    ${C.bold}npm run weekly${C.reset}   命令列直接跑一份周报

  想要桌面图示（双击即用）：
    ${C.bold}npm run install-shortcut${C.reset}

  详细说明见 README.md
`);
if (rl) rl.close();
