// 启动／连上「专用 CDP Chrome」，并检查 AIHelp 登入狀态
// 用法: node bin/chrome-up.mjs [--url <url>] [--no-open]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { loadConfig, waitForCdp, listTargets, findPage, connect, sleep } from '../lib/cdp.mjs';

const cfg = await loadConfig();
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const noOpen = argv.includes('--no-open');

await fs.mkdir(cfg.profileDir, { recursive: true });

// 1) 已经在跑？直接沿用
let ver = await waitForCdp(cfg.port, 2);
let launched = false;
if (!ver) {
  const child = spawn(
    cfg.chrome,
    [
      `--remote-debugging-port=${cfg.port}`,
      `--user-data-dir=${cfg.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      cfg.dashboardUrl,
    ],
    { stdio: 'ignore', detached: true },
  );
  child.unref();
  launched = true;
  console.log(`已启动专用 Chrome（pid ${child.pid}），设定档：${cfg.profileDir}`);
  ver = await waitForCdp(cfg.port, 60);
  if (!ver) {
    console.error('❌ CDP 端点未出现，启动失敗');
    process.exit(1);
  }
} else {
  console.log('专用 Chrome 已在执行，沿用它。');
}
console.log(`CDP OK：${ver.Browser}`);

// 2) 找 dashboard 分页；没有就开一个
async function pick() {
  let targets = await listTargets(cfg.port);
  let page = findPage(targets, cfg.host);
  if (page) return page;
  if (noOpen) return null;
  const conn0 = await connect(cfg.port);
  const { targetId } = await conn0.send('Target.createTarget', { url: cfg.dashboardUrl });
  conn0.close();
  for (let i = 0; i < 30; i++) {
    await sleep(700);
    targets = await listTargets(cfg.port);
    const p = targets.find((t) => t.id === targetId && !t.url.startsWith('about:')) || findPage(targets, cfg.host);
    if (p && !p.url.startsWith('about:')) return p;
  }
  return findPage(targets, cfg.host);
}

const page = await pick();
if (!page) {
  console.error('❌ 找不到 AIHelp 分页');
  process.exit(1);
}
console.log(`分页：${page.id}｜${page.url}`);

// 3) 检查登入狀态
//    注意：背景分页的 innerText 一律是空的，所以要用 DOM 元素判断，不能只看文字。
const conn = await connect(cfg.port);
const sid = await conn.attach(page.id);
const ev = conn.makeEval(sid);
for (let i = 0; i < 30; i++) {
  if ((await ev(`document.querySelectorAll('.el-tabs__item').length`)) >= 5) break;
  await sleep(1000);
}
const state = {
  href: await ev('location.href'),
  title: await ev('document.title'),
  tabs: await ev(`document.querySelectorAll('.el-tabs__item').length`),
  buttons: await ev(`document.querySelectorAll('button, .el-button').length`),
  tokenLen: await ev(`(localStorage.getItem('token')||'').length`),
  text: await ev('document.body ? document.body.innerText.slice(0,120) : ""'),
};
state.needLogin =
  /#\/login|#\/signin/i.test(state.href) || /登录您的账号|登入您的帳号/.test(state.text) || (state.tabs < 5 && state.tokenLen === 0);

console.log(JSON.stringify(state, null, 2));
if (state.needLogin) {
  console.log('\n⚠️  尚未登入。');
  console.log('   请切换到刚开启的浏览器视窗，登入你的 AIHelp 帐号，然后再跑一次这个指令。');
  process.exitCode = 2;
} else {
  console.log('\n✅ 已登入，可以开始采集。');
}
conn.close();
process.exit(process.exitCode || 0);
