// 截取 GUI 分頁的畫面
import fs from 'node:fs/promises';
import { loadConfig, listTargets, connect, sleep } from '../lib/cdp.mjs';

const cfg = await loadConfig();
const list = await listTargets(cfg.port);
const page = list.find((t) => t.type === 'page' && t.url.includes('8791'));
if (!page) throw new Error('找不到 GUI 分頁');

const conn = await connect(cfg.port);
const sid = await conn.attach(page.id);
await conn.send('Page.enable', {}, sid);
await sleep(1500);
const shot = await conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sid);
const out = 'report/_gui_screenshot.png';
await fs.writeFile(out, Buffer.from(shot.data, 'base64'));
console.log('截圖已存：' + out);
conn.close();
process.exit(0);
