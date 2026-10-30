// 測試首次設定流程（沒有 config.json 的情況下）
const BASE = 'http://127.0.0.1:8791';
let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${n}${d ? '  ' + d : ''}`);
  ok ? pass++ : fail++;
};

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

console.log('=== 1) 未設定時，伺服器仍然啟動（不再直接退出）===');
let s = await get('/api/state');
check('伺服器有回應', s.status === 200, `HTTP ${s.status}`);
check('state.needsSetup = true', s.json.needsSetup === true, String(s.json.needsSetup));

console.log('\n=== 2) 未設定時不能開始採集 ===');
const st = await post('/api/start', { start: '2026-10-02', end: '2026-10-08' });
check('被拒絕', st.status === 400, `HTTP ${st.status}`);
check('有清楚的中文說明', /首次设定|设定/i.test(st.json.error || ''), st.json.error || '');

console.log('\n=== 3) 網址驗證 ===');
for (const [url, shouldFail, why] of [
  ['', true, '空白'],
  ['https://YOUR-COMPANY.aihelp.net/dashboard/', true, '範例網址'],
  ['https://example.com', true, '不是 aihelp.net'],
  ['not a url at all', true, '亂填'],
]) {
  const r = await post('/api/setup', { dashboardUrl: url });
  check(`拒絕「${why}」`, r.status === 400 && r.json.ok !== true, r.json.message || `HTTP ${r.status}`);
}

console.log('\n=== 4) 只填網域也能自動補完 ===');
let r = await post('/api/setup', { dashboardUrl: 'acme-game.aihelp.net' });
check('接受純網域', r.status === 200 && r.json.ok === true, r.json.message || r.json.dashboardUrl || '');
check('補成完整網址', String(r.json.dashboardUrl || '').includes('acme-game.aihelp.net'), r.json.dashboardUrl || '');

console.log('\n=== 5) 設定完成後狀態更新 ===');
s = await get('/api/state');
check('needsSetup 變 false', s.json.needsSetup === false, String(s.json.needsSetup));

const chk = await get('/api/check-chrome');
check('環境檢查恢復正常', chk.status === 200, chk.json.message || '');

console.log(`\n=== ${pass}/${pass + fail} 項通過 ===`);
process.exit(fail ? 1 : 0);
