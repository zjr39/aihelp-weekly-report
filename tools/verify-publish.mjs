// 驗證發佈版的關鍵檔案都正確
import fs from 'node:fs/promises';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  → ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log('=== package.json ===');
const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
check('JSON 合法', true);
check('name', pkg.name === 'aihelp-weekly-report', pkg.name);
check('license 是 MIT', pkg.license === 'MIT', pkg.license);
check('零依赖', Object.keys(pkg.dependencies || {}).length === 0 && Object.keys(pkg.devDependencies || {}).length === 0);
check('engines.node', !!pkg.engines?.node, pkg.engines?.node);

console.log('\n=== npm scripts 指向的档案都存在 ===');
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  const m = cmd.match(/node\s+(\S+\.mjs)/);
  if (!m) {
    check(`script "${name}"`, true, '（非 node 指令，略过）');
    continue;
  }
  let ok = false;
  try {
    await fs.access(m[1]);
    ok = true;
  } catch {}
  check(`script "${name}" -> ${m[1]}`, ok);
}

console.log('\n=== config.example.json ===');
const ex = JSON.parse(await fs.readFile('config.example.json', 'utf8'));
check('JSON 合法', true);
check('只有 dashboardUrl 是必填概念', !!ex.dashboardUrl, ex.dashboardUrl);

console.log('\n=== .gitignore 关键项目 ===');
const gi = await fs.readFile('.gitignore', 'utf8');
for (const p of ['config.json', 'raw/', 'data/', 'report/', 'downloads/', '_archive/', 'node_modules/']) {
  check(p, gi.includes(p));
}

console.log('\n=== 必要文件 ===');
for (const f of ['README.md', 'LICENSE', 'package.json', '.gitignore', 'config.example.json', 'docs/技术笔记.md', 'assets/icon.ico']) {
  let ok = false;
  try {
    await fs.access(f);
    ok = true;
  } catch {}
  check(f, ok);
}

console.log('\n=== 设定档保护 ===');
const cfgSrc = await fs.readFile('lib/config.mjs', 'utf8');
check('有 autoCreate 逻辑', /autoCreate/.test(cfgSrc));
check('有环境变数覆盖', /AIHELP_DASHBOARD_URL/.test(cfgSrc));
check('会探查旧 profile 路径', /AIHelp-Auto/.test(cfgSrc));
check('PLACEHOLDER_HOST 已定义', /PLACEHOLDER_HOST/.test(cfgSrc));

console.log(`\n=== ${pass}/${pass + fail} 项通过 ===`);
process.exit(fail ? 1 : 0);
