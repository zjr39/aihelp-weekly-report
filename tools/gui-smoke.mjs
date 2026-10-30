// GUI 煙霧測試：不需真的爬取，只驗證 API 與靜態檔
const BASE = process.argv[2] || 'http://127.0.0.1:8791';

async function get(p) {
  const r = await fetch(BASE + p);
  const t = await r.text();
  return { status: r.status, len: t.length, head: t.slice(0, 120), text: t };
}
async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t.slice(0, 200) };
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`);
};

// 1) 首頁（標題在去識別化時改過，這裡用穩定的結構特徵判斷）
const home = await get('/');
check(
  '首頁可載入',
  home.status === 200 && /<title>/.test(home.text) && /id="btnStart"/.test(home.text),
  `HTTP ${home.status}, ${home.len} bytes`,
);

// 2) 靜態檔
const css = await get('/static/style.css');
check('CSS 可載入', css.status === 200 && css.len > 500, `${css.len} bytes`);
const js = await get('/static/app.js');
check('JS 可載入', js.status === 200 && js.len > 1000, `${js.len} bytes`);

// 3) 狀態 API
const st = await get('/api/state');
let stJson = null;
try { stJson = JSON.parse(st.text); } catch {}
check('狀態 API', st.status === 200 && stJson && typeof stJson.phase === 'string', stJson ? `phase=${stJson.phase}` : '');

// 4) 環境檢查
const chk = await get('/api/check-chrome');
let chkJson = null;
try { chkJson = JSON.parse(chk.text); } catch {}
check('環境檢查 API', chk.status === 200 && chkJson && typeof chkJson.ok === 'boolean', chkJson ? chkJson.message : '');

// 5) 日期驗證
const bad1 = await post('/api/start', { start: 'x', end: 'y' });
check('拒絕錯誤日期格式', bad1.status === 400, bad1.json && bad1.json.error);
const bad2 = await post('/api/start', { start: '2026-10-10', end: '2026-10-01' });
check('拒絕起訖顛倒', bad2.status === 400, bad2.json && bad2.json.error);

// 6) 未執行時的操作
const p1 = await post('/api/pause');
check('未執行時暫停被拒', p1.status === 409, p1.json && p1.json.error);
const s1 = await post('/api/stop');
check('未執行時終止被拒', s1.status === 409, s1.json && s1.json.error);

// 7) 下載端點：有檔案回 200（xlsx 型別）、沒檔案回 404，兩者都算正常
//    （不能假設「一定還沒產出檔案」—— 跑過一次就會有）
const d1 = await get('/api/download/xlsx');
const okKind = d1.status === 200 || d1.status === 404;
check(
  '下載端點回應正常',
  okKind,
  `HTTP ${d1.status}${d1.status === 200 ? '（已有檔案）' : '（尚無檔案）'}`,
);

// 不存在的下載類型一定要 404
const d2 = await get('/api/download/not-a-real-kind');
check('不存在的下載類型回 404', d2.status === 404, `HTTP ${d2.status}`);

// 8) SSE 可連線並收到初始 state
const sse = await new Promise((resolve) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { ctrl.abort(); resolve({ ok: false, detail: '逾時' }); }, 4000);
  fetch(BASE + '/api/events', { signal: ctrl.signal })
    .then(async (r) => {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.includes('event: state')) {
          clearTimeout(timer);
          ctrl.abort();
          resolve({ ok: true, detail: `${r.status}, 收到 ${buf.length} bytes` });
          return;
        }
      }
    })
    .catch(() => {});
});
check('SSE 事件流', sse.ok, sse.detail);

// 9) 404
const nf = await get('/api/nonexistent');
check('未知路徑回 404', nf.status === 404, `HTTP ${nf.status}`);

const pass = results.filter((r) => r.ok).length;
console.log(`\n=== ${pass}/${results.length} 項通過 ===`);
process.exit(pass === results.length ? 0 : 1);
