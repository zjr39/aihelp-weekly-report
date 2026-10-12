// 模擬「雙擊 .cmd」的完整驗收測試
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CMD = process.argv[2] || '啟動工具.cmd';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = require('node:net').createConnection({ host: '127.0.0.1', port });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function get(pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 8791, path: pathname, timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✅' : '❌'} ${n}${d ? '  → ' + d : ''}`); };

// 確認起始狀態
const wasOpen = await portOpen(8791);
console.log(`起始狀態：8791 ${wasOpen ? '已被佔用' : '空閒'}\n`);

// 執行 .cmd（模擬雙擊）
console.log(`執行 ${CMD} …`);
const child = spawn('cmd.exe', ['/c', CMD], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let out = '';
child.stdout.on('data', (c) => (out += c));
child.stderr.on('data', (c) => (out += c));

let alive = true;
child.on('exit', (code) => { alive = false; console.log(`  （程序結束，code=${code}）`); });

await sleep(9000);

check('程序未閃退（仍在執行）', alive, alive ? '' : '已結束 → 這就是閃退');

const open2 = await portOpen(8791);
check('8791 埠有在監聽', open2);

if (open2) {
  try {
    const st = await get('/api/state');
    const j = JSON.parse(st.body);
    check('GUI API 可用', st.status === 200 && typeof j.phase === 'string', `phase=${j.phase}`);
    const home = await get('/');
    check('首頁可載入', home.status === 200 && /客訴週報/.test(home.body), `${home.body.length} bytes`);
    const chk = await get('/api/check-chrome');
    const cj = JSON.parse(chk.body);
    check('Chrome 環境檢查', typeof cj.ok === 'boolean', cj.message);
  } catch (e) {
    check('GUI API 可用', false, e.message);
  }
}

// 若這次是我們啟動的，測完就收掉
if (!wasOpen && alive) {
  console.log('\n（測試完成，關閉剛啟動的伺服器）');
  child.kill();
  await sleep(1500);
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${results.length} 項通過 ===`);
if (out.trim()) {
  const lines = out.split('\n').filter((l) => l.trim()).slice(0, 10);
  console.log('\n輸出（前 10 行）：');
  lines.forEach((l) => console.log('  ' + l.replace(/\r$/, '')));
}
process.exit(pass === results.length ? 0 : 1);
