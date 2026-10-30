// 打開設定對話窗並截圖
import fs from 'node:fs/promises';
import { loadConfig, listTargets, findPage, connect, sleep } from '../lib/cdp.mjs';

const cfg = await loadConfig();
const GUI = 'http://127.0.0.1:8791';

const conn = await connect(cfg.port);
// 找或開 GUI 分頁
let targets = await listTargets(cfg.port);
let page = targets.find((t) => t.type === 'page' && t.url.includes('8791'));
if (!page) {
  const { targetId } = await conn.send('Target.createTarget', { url: GUI });
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    targets = await listTargets(cfg.port);
    page = targets.find((t) => t.id === targetId);
    if (page && page.url.includes('8791')) break;
  }
}
if (!page) {
  console.log('找不到 GUI 分頁');
  process.exit(1);
}
console.log('GUI 分頁：' + page.url);

const sid = await conn.attach(page.id);
const ev = conn.makeEval(sid, { timeout: 60000 });
await conn.send('Page.enable', {}, sid);

// 重新載入確保拿到最新版
await conn.send('Page.reload', { ignoreCache: true }, sid);
await sleep(2500);

// 點「AI 设定」
const clicked = await ev(`
(() => {
  const b = document.getElementById('btnSettings');
  if (!b) return 'no button';
  b.click();
  return 'clicked';
})()
`);
console.log('点击 AI 设定：' + clicked);
await sleep(4500); // 等自动查询模型清单回来

// 截圖（只截對話窗區域較清楚，這裡截整頁）
const shot = await conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
await fs.mkdir('docs', { recursive: true });
await fs.writeFile('docs/settings.png', Buffer.from(shot.data, 'base64'));
console.log('截圖：docs/settings.png');

// 檢查對話窗是否顯示
const visible = await ev(`(() => { const m = document.getElementById('settingsModal'); return m ? !m.hidden : 'missing'; })()`);
console.log('对话窗显示：' + visible);

conn.close();
process.exit(0);
