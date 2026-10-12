// 驗證：未設定時 gui.mjs 應給出清楚指示而非崩潰
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CFG = 'config.json';

// 備份
const backup = await fs.readFile(CFG, 'utf8').catch(() => null);
if (!backup) {
  console.log('⚠️  找不到 config.json，跳過測試');
  process.exit(0);
}
await fs.writeFile('_archive/config.json.keep', backup, 'utf8');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

try {
  // ── 情境 A：未設定（範本值）──
  await fs.writeFile(CFG, JSON.stringify({ dashboardUrl: 'https://YOUR-COMPANY.aihelp.net/dashboard/' }, null, 2) + '\n', 'utf8');
  try {
    await run(process.execPath, ['bin/gui.mjs', '--port', '8799'], { timeout: 30000 });
    check('未设定时应以非零结束', false, '竟然成功了');
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    check('未设定时以非零结束', e.code !== 0, `exit=${e.code}`);
    check('有提示执行 npm run setup', /npm run setup/.test(out));
    check('不是崩溃堆栈', !/at .*\.mjs:\d+:\d+/.test(out), out.split('\n')[0].slice(0, 60));
  }

  // ── 情境 B：格式損壞 ──
  await fs.writeFile(CFG, '{ this is not json', 'utf8');
  try {
    await run(process.execPath, ['bin/gui.mjs', '--port', '8799'], { timeout: 30000 });
    check('损坏的 config 应被挡下', false, '竟然成功了');
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    check('损坏的 config 被挡下', e.code !== 0, `exit=${e.code}`);
    check('提示可删除后重跑 setup', /npm run setup/.test(out));
  }

  // ── 情境 C：辅助模式不受影响 ──
  try {
    const { stdout } = await run(process.execPath, ['bin/gui.mjs', '--banner'], { timeout: 20000 });
    check('--banner 辅助模式仍可用', /客诉周报工具/.test(stdout));
  } catch (e) {
    check('--banner 辅助模式仍可用', false, e.message);
  }
} finally {
  // 還原
  await fs.writeFile(CFG, backup, 'utf8');
  await fs.rm('_archive/config.json.keep', { force: true });
  console.log('\n（已还原 config.json）');
}

console.log(`\n=== ${pass}/${pass + fail} 项通过 ===`);
process.exit(fail ? 1 : 0);
