// 檢查專用 Chrome 的登入狀態（DOM 判斷，不看文字）
import { loadConfig, listTargets, findPage, connect, sleep } from '../lib/cdp.mjs';

const cfg = await loadConfig();
const t = await listTargets(cfg.port);
const pg = findPage(t, cfg.host);
if (!pg) {
  console.log(JSON.stringify({ ok: false, why: '找不到分頁' }));
  process.exit(1);
}
const c = await connect(cfg.port);
const sid = await c.attach(pg.id);
const ev = c.makeEval(sid);
for (let i = 0; i < 30; i++) {
  if ((await ev(`document.querySelectorAll('.el-tabs__item').length`)) >= 5) break;
  await sleep(1000);
}
const info = {
  href: await ev('location.href'),
  tokenLen: await ev(`(localStorage.getItem('token')||'').length`),
  tabs: await ev(`document.querySelectorAll('.el-tabs__item').length`),
  buttons: await ev(`document.querySelectorAll('button, .el-button').length`),
  hasSearchView: await ev(`(() => { for (const e of document.querySelectorAll('*')) { const v = e.__vue__; if (v && v.$options && v.$options.name === 'SearchView') return true; } return false; })()`),
};
info.ok = info.tokenLen > 0 && info.tabs >= 5;
console.log(JSON.stringify(info, null, 1));
c.close();
process.exit(info.ok ? 0 : 2);
