// 完整驗證 AI 設定對話窗的各種開關方式
import { loadConfig, listTargets, connect, sleep } from '../lib/cdp.mjs';

const GUI = 'http://127.0.0.1:8791';
const cfg = await loadConfig();
const conn = await connect(cfg.port);

// 找 GUI 分頁；沒有就自己開一個（分頁可能被關掉，不該讓測試直接崩）
let targets = await listTargets(cfg.port);
let page = targets.find((t) => t.type === 'page' && t.url.includes('8791'));
if (!page) {
  const { targetId } = await conn.send('Target.createTarget', { url: GUI });
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    targets = await listTargets(cfg.port);
    page = targets.find((t) => t.id === targetId);
    if (page) break;
  }
}
if (!page) {
  console.log('❌ 找不到也開不出 GUI 分頁（請先確認 http://127.0.0.1:8791 有在跑）');
  process.exit(1);
}

const sid = await conn.attach(page.id);
const ev = conn.makeEval(sid, { timeout: 60000 });
await conn.send('Page.enable', {}, sid);
await conn.send('Page.navigate', { url: GUI }, sid);
await sleep(2500);

const state = () =>
  ev(`
(() => {
  const m = document.getElementById('settingsModal');
  const b = document.getElementById('baseUrlField');
  const c = document.getElementById('modelChips');
  const off = document.getElementById('offline');
  const vis = (el) => !!el && getComputedStyle(el).display !== 'none';
  return JSON.stringify({
    modal: vis(m),
    baseUrlField: vis(b),
    modelChips: vis(c),
    offlineBanner: vis(off),
    model: (document.getElementById('llmModel') || {}).value || '',
  });
})()
`);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log('=== 1) 頁面載入後 ===');
let s = JSON.parse(await state());
console.log('  ' + JSON.stringify(s));
check('對話窗預設關閉', s.modal === false);
check('離線橫幅不顯示', s.offlineBanner === false);

console.log('\n=== 2) 點「AI 設定」 ===');
await ev(`document.getElementById('btnSettings').click()`);
await sleep(2000);
s = JSON.parse(await state());
console.log('  ' + JSON.stringify(s));
check('對話窗打開', s.modal === true);
check('位址欄隱藏（選了 DeepSeek）', s.baseUrlField === false);
check('模型按鈕有顯示', s.modelChips === true);
check('模型已選 deepseek-flash', /deepseek-flash/.test(s.model), s.model);

console.log('\n=== 3) 按 ESC 關閉 ===');
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(600);
s = JSON.parse(await state());
check('ESC 可關閉', s.modal === false);

console.log('\n=== 4) 重新開啟 → 點背景關閉 ===');
await ev(`document.getElementById('btnSettings').click()`);
await sleep(1500);
await ev(`
(() => {
  const m = document.getElementById('settingsModal');
  m.dispatchEvent(new MouseEvent('click', { bubbles: true }));
})()
`);
await sleep(600);
s = JSON.parse(await state());
check('點背景可關閉', s.modal === false);

console.log('\n=== 5) 開啟 → 按「儲存」→ 自動關閉 ===');
await ev(`document.getElementById('btnSettings').click()`);
await sleep(2000);
await ev(`document.getElementById('btnSaveSettings').click()`);
await sleep(500);
s = JSON.parse(await state());
const msg = await ev(`(document.getElementById('settingsMsg') || {}).textContent || ''`);
check('儲存中對話窗還開著', s.modal === true, msg);
// 存檔是網路請求 + 900ms 延遲，等 3 秒比較穩
await sleep(3000);
s = JSON.parse(await state());
check('儲存後自動關閉', s.modal === false);

console.log('\n=== 6) 切到「自訂」→ 位址欄應出現 ===');
await ev(`document.getElementById('btnSettings').click()`);
await sleep(1200);
await ev(`document.querySelector('.provider[data-provider="custom"]').click()`);
await sleep(600);
s = JSON.parse(await state());
check('自訂模式顯示位址欄', s.baseUrlField === true);

console.log('\n=== 7) 切回 DeepSeek → 位址欄應隱藏 ===');
await ev(`document.querySelector('.provider[data-provider="deepseek"]').click()`);
await sleep(1800);
s = JSON.parse(await state());
check('DeepSeek 模式隱藏位址欄', s.baseUrlField === false);

// 收尾：關掉對話窗
await ev(`document.getElementById('btnCloseSettings').click()`);
await sleep(400);

console.log(`\n=== ${pass}/${pass + fail} 項通過 ===`);
conn.close();
process.exit(fail ? 1 : 0);
