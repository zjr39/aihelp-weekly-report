// GUI 端到端測試（v2）：真的啟動一次蒐集，驗證進度、暫停/繼續、下載
// 用法: node tools/gui-e2e.mjs [baseUrl] [start] [end]
import http from 'node:http';

const BASE = process.argv[2] || 'http://127.0.0.1:8791';
const START = process.argv[3] || '2026-10-10';
const END = process.argv[4] || '2026-10-11';
const HOST = new URL(BASE);

function req(path, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const r = http.request(
      {
        host: HOST.hostname,
        port: HOST.port,
        path,
        method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json = null;
          try { json = JSON.parse(buf.toString('utf8')); } catch {}
          resolve({ status: res.statusCode, json, buf, headers: res.headers });
        });
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 背景訂閱 SSE（用 http 模組，避免 fetch abort 的競態） ──
const sseStats = { state: 0, log: 0, finished: 0, lastLog: '' };
let sseReq = null;
(function subscribe() {
  sseReq = http.request({ host: HOST.hostname, port: HOST.port, path: '/api/events' }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const p of parts) {
        const ev = /event: (\w+)/.exec(p)?.[1];
        if (!ev) continue;
        if (ev === 'state') sseStats.state++;
        else if (ev === 'finished') sseStats.finished++;
        else if (ev === 'log') {
          sseStats.log++;
          const m = /data: (.*)/.exec(p);
          if (m) { try { sseStats.lastLog = JSON.parse(m[1]); } catch {} }
        }
      }
    });
  });
  sseReq.end();
})();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`);
};

// ── 環境檢查 ──
const chk = await req('/api/check-chrome');
check('環境檢查（已登入）', chk.json?.ok === true, chk.json?.message || '');

if (chk.json?.ok !== true) {
  console.log('\n⚠️ 環境未就緒，停止測試。請先讓專用 Chrome 登入。');
  process.exit(2);
}

// ── 啟動 ──
console.log(`\n=== 啟動蒐集 ${START} ~ ${END} ===`);
const started = await req('/api/start', { method: 'POST', body: { start: START, end: END } });
check('啟動 API', started.status === 200 && started.json?.ok === true, JSON.stringify(started.json));

// ── 等第一個遊戲開始（同時驗證進度事件） ──
let sawGame = false;
let sawStep = false;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const st = await req('/api/state');
  const s = st.json;
  if (!s) continue;
  if (s.step) sawStep = true;
  if (s.games?.length) sawGame = true;
  if (i % 5 === 0) {
    const cur = s.games?.find((g) => g.tickets?.status === 'running');
    console.log(`  phase=${s.phase} step="${s.step}" 遊戲=${s.games?.length || 0} 完成=${s.progress.finished}/${s.games?.length || 0}${cur ? ' 正在抓：' + cur.name : ''}`);
  }
  if (sawGame && s.phase === 'running') break;
  if (['done', 'error', 'stopped'].includes(s.phase)) break;
}
check('收到步驟事件', sawStep);
check('遊戲清單已列出', sawGame);

// ── 測試暫停 / 繼續 ──
const p = await req('/api/pause', { method: 'POST' });
await sleep(5000);
const stPaused = await req('/api/state');
check('暫停生效', p.status === 200 && stPaused.json?.phase === 'paused', `phase=${stPaused.json?.phase}`);
const pausedLog = (stPaused.json?.log || []).some((l) => /暫停|暂停|PAUSED/.test(l));
check('爬蟲回報已暫停', pausedLog, (stPaused.json?.log || []).filter((l) => /暫停|暂停|PAUSED/.test(l)).slice(-1)[0] || '（找不到暫停訊息）');

const rs = await req('/api/resume', { method: 'POST' });
await sleep(3000);
const stResumed = await req('/api/state');
check('繼續生效', rs.status === 200 && stResumed.json?.phase === 'running', `phase=${stResumed.json?.phase}`);

// ── 等完成 ──
console.log('\n=== 等待完成 ===');
let final = null;
for (let i = 0; i < 200; i++) {
  await sleep(3000);
  const st = await req('/api/state');
  final = st.json;
  if (i % 10 === 0) console.log(`  phase=${final.phase} step="${final.step}" 完成=${final.progress.finished}/${final.games?.length || 0}`);
  if (['done', 'error', 'stopped'].includes(final.phase)) break;
}

console.log('\n=== 最終狀態 ===');
console.log('phase  =', final.phase);
console.log('error  =', final.error);
console.log('files  =', JSON.stringify(final.files));
console.log('\n各遊戲：');
for (const g of final.games || []) {
  const t = g.tickets || {};
  console.log(`  ${String(g.name).padEnd(24)} 客訴=${String(t.total ?? '-').padStart(4)} 有效=${String(t.valid ?? '-').padStart(4)} 無效=${String(t.invalid ?? '-').padStart(3)}  L1=${g.level1?.sum ?? '-'} L2=${g.level2?.sum ?? '-'}`);
}

check('任務完成無錯誤', final.phase === 'done', `phase=${final.phase} error=${final.error || '無'}`);
check('進度表有 9 個遊戲', (final.games || []).length === 9, `${(final.games || []).length} 個`);
check('每個遊戲的客訴資料都完成', (final.games || []).every((g) => g.tickets?.status === 'done'));
check('summary 事件已收到', !!final.summary, final.summary ? `有效合計 ${final.summary.totalValid} / 無效 ${final.summary.totalInvalid}` : '');
check('SSE 有推播狀態', sseStats.state > 3, `${sseStats.state} 次 state、${sseStats.log} 筆日誌`);

// ── 下載 Excel ──
if (final.files?.xlsx) {
  const dl = await req('/api/download/xlsx');
  const isZip = dl.buf[0] === 0x50 && dl.buf[1] === 0x4b;
  const name = decodeURIComponent((dl.headers['content-disposition'] || '').replace(/.*filename\*=UTF-8''/, ''));
  check('下載 Excel', dl.status === 200 && isZip && dl.buf.length > 2000, `${dl.buf.length} bytes、ZIP=${isZip}、檔名=${name}`);
  const dlraw = await req('/api/download/raw');
  check('下載原始 JSON', dlraw.status === 200 && dlraw.buf[0] === 0x7b, `${dlraw.buf.length} bytes`);
}

if (sseReq) sseReq.destroy();
const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${results.length} 項通過 ===`);
process.exit(pass === results.length ? 0 : 1);
