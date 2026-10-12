// 用全新的 Chrome app 視窗打開 GUI，讓使用者直接看到介面
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, listTargets, findPage, connect, sleep } from '../lib/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = await loadConfig();
const GUI = 'http://127.0.0.1:8791/';

console.log('在專用 Chrome 開啟 GUI…');
const conn = await connect(cfg.port);
const created = await conn.send('Target.createTarget', { url: GUI });
await sleep(4000);

const list = await listTargets(cfg.port);
const page = list.find((t) => t.id === created.targetId);
if (!page) {
  console.log('找不到剛開的分頁');
  process.exit(1);
}
console.log('分頁：' + page.url);

const sid = await conn.attach(page.id);
const ev = conn.makeEval(sid);
const info = {
  title: await ev('document.title'),
  h1: await ev(`(document.querySelector('h1')||{}).textContent || ''`),
  buttons: await ev(`[...document.querySelectorAll('button')].map(b => b.textContent.trim()).join(' | ')`),
  dateInputs: await ev(`[...document.querySelectorAll('input[type=date]')].map(i => i.value).join(' ~ ')`),
  chromeStatus: await ev(`(document.getElementById('chromeStatus')||{}).textContent || ''`),
  tableHeaders: await ev(`[...document.querySelectorAll('th')].map(th => th.textContent.trim()).join(' | ')`),
  bodyLen: await ev('document.body.innerText.length'),
};
console.log(JSON.stringify(info, null, 1));

// 把 GUI 分頁帶到前景，方便使用者看到
try {
  await conn.send('Target.activateTarget', { targetId: page.id });
  console.log('\n已將 GUI 分頁切到前景。');
} catch (e) {
  console.log('\n無法切到前景：' + e.message);
}
conn.close();
process.exit(0);
