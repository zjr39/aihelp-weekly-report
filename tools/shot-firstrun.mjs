// 截圖：首次使用設定畫面
import fs from 'node:fs/promises';
import { loadConfig, listTargets, connect, sleep } from '../lib/cdp.mjs';

const cfg = await loadConfig();
const conn = await connect(cfg.port);

let targets = await listTargets(cfg.port);
let page = targets.find((t) => t.type === 'page' && t.url.includes('8791'));
if (!page) {
  const { targetId } = await conn.send('Target.createTarget', { url: 'http://127.0.0.1:8791/' });
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    targets = await listTargets(cfg.port);
    page = targets.find((t) => t.id === targetId);
    if (page) break;
  }
}
if (!page) { console.log('找不到 GUI 分頁'); process.exit(1); }

const sid = await conn.attach(page.id);
const ev = conn.makeEval(sid, { timeout: 60000 });
await conn.send('Page.enable', {}, sid);
await conn.send('Page.navigate', { url: 'http://127.0.0.1:8791/' }, sid);
await sleep(3000);

const st = await ev(`
(() => {
  const o = document.getElementById('setupOverlay');
  return JSON.stringify({ exists: !!o, visible: o ? getComputedStyle(o).display !== 'none' : false });
})()
`);
console.log('設定畫面：' + st);

const shot = await conn.send('Page.captureScreenshot', { format: 'png' }, sid);
await fs.mkdir('docs', { recursive: true });
await fs.writeFile('docs/first-run.png', Buffer.from(shot.data, 'base64'));
console.log('截圖：docs/first-run.png');

conn.close();
process.exit(0);
