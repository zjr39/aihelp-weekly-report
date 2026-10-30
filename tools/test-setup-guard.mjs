// 驗證：未設定 / 設定損壞時，gui.mjs 的行為
//
// 設計已改：不再「未設定就退出」，改成照常啟動、由網頁顯示首次設定畫面。
// 這樣非技術使用者不必開終端跑 npm run setup。
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';

const CFG = 'config.json';
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const waitPort = (port, timeoutMs = 20000) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) resolve(false);
        else setTimeout(tick, 300);
      });
    };
    tick();
  });

/** 啟動 gui，等它就緒，回傳 {proc, out()} */
async function startGui() {
  const p = spawn(process.execPath, ['bin/gui.mjs', '--port', String(PORT)], { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => (out += d.toString('utf8')));
  p.stderr.on('data', (d) => (out += d.toString('utf8')));
  const up = await waitPort(PORT);
  return { p, up, out: () => out };
}

async function stop(p) {
  try { p.kill(); } catch {}
  try { process.kill(p.pid); } catch {}
  await new Promise((r) => setTimeout(r, 900));
}

const backup = await fs.readFile(CFG, 'utf8').catch(() => null);
if (!backup) {
  console.log('⚠️  找不到 config.json，跳过测试');
  process.exit(0);
}

try {
  // ── 情境 A：未設定（範本值）──
  console.log('\n=== A) 未設定（範本值）===');
  await fs.writeFile(CFG, JSON.stringify({ dashboardUrl: 'https://YOUR-COMPANY.aihelp.net/dashboard/' }, null, 2) + '\n', 'utf8');
  let g = await startGui();
  check('伺服器仍然啟動（不再直接退出）', g.up);
  if (g.up) {
    const st = await fetch(`${BASE}/api/state`).then((r) => r.json()).catch(() => ({}));
    check('回報 needsSetup', st.needsSetup === true, String(st.needsSetup));
    const home = await fetch(`${BASE}/`).then((r) => r.text()).catch(() => '');
    check('首頁有首次設定畫面', /id="setupOverlay"/.test(home));
    const r = await fetch(`${BASE}/api/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: '2026-10-02', end: '2026-10-08' }),
    });
    check('未設定時拒絕採集', r.status === 400, `HTTP ${r.status}`);
  }
  check('輸出無崩溃堆栈', !/at .*\.mjs:\d+:\d+/.test(g.out()), g.out().split('\n')[0].slice(0, 60));
  await stop(g.p);

  // ── 情境 B：格式損壞 ──
  console.log('\n=== B) config.json 格式損壞 ===');
  await fs.writeFile(CFG, '{ this is not json', 'utf8');
  g = await startGui();
  check('仍然啟動（讓使用者能在界面上修）', g.up);
  if (g.up) {
    const st = await fetch(`${BASE}/api/state`).then((r) => r.json()).catch(() => ({}));
    check('回報 needsSetup', st.needsSetup === true, String(st.needsSetup));
  }
  check('輸出無崩溃堆栈', !/at .*\.mjs:\d+:\d+/.test(g.out()), g.out().split('\n')[0].slice(0, 60));
  await stop(g.p);

  // ── 情境 C：輔助模式不受影響 ──
  console.log('\n=== C) 輔助模式 ===');
  const banner = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['bin/gui.mjs', '--banner'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.on('close', () => resolve(out));
    setTimeout(() => { try { p.kill(); } catch {} resolve(out); }, 5000);
  });
  check('--banner 仍可用', /客诉周报工具/.test(banner));
} finally {
  await fs.writeFile(CFG, backup, 'utf8');
  console.log('\n（已还原 config.json）');
}

console.log(`\n=== ${pass}/${pass + fail} 项通过 ===`);
process.exit(fail ? 1 : 0);
