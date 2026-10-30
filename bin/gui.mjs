// 周报客诉统计 — 本地可视化控制台（零依赖 HTTP server + SSE 即时进度）
//
// 用法: node bin/gui.mjs [--port 8791] [--no-open]
//
// 功能：
//   POST /api/start    { start, end }  开始爬取
//   POST /api/pause                     暂停（在游戏之间的安全点停住）
//   POST /api/resume                    继续
//   POST /api/stop                      终止
//   GET  /api/state                     目前状态（JSON）
//   GET  /api/events                    SSE 即时事件流
//   GET  /api/download/:kind           kind = xlsx | tsv | json
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, StopRequested } from '../lib/collectCore.mjs';
import { transform, buildSheet, buildXlsxReport, prepareSummaryGroups } from '../lib/pipeline.mjs';
import { summarizeGroups, fallbackSummary } from '../lib/summarize.mjs';
import { testConnection as testLlm, listModels as listLlmModels } from '../lib/llm.mjs';
import { loadConfig, saveConfig } from '../lib/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const PORT = Number(arg('port', 8791));
const CTRL_FILE = path.join(ROOT, 'raw', '.control.json');
const LOG_FILE = path.join(ROOT, 'raw', '.last-run.log');

// ── 首次使用的设定状态 ──
// 不再「没设定就退出」—— 那样使用者得开终端跑 npm run setup，对非技术用户是门槛。
// 改成：照常启动界面，由网页里的「首次设定」画面引导填 AIHelp 网址。
let needsSetup = false;
{
  const launcherModes = ['--probe', '--wait-ready', '--banner', '--already', '--failed', '--stopped'];
  const isLauncherMode = argv.some((a) => launcherModes.includes(a));
  if (!isLauncherMode) {
    try {
      const { loadConfig } = await import('../lib/config.mjs');
      const c = await loadConfig({ autoCreate: false });
      if (!c.configured) {
        needsSetup = true;
        console.log(`
  ┌─────────────────────────────────────────────────────────┐
  │  首次使用：请在打开的网页里填写 AIHelp 网址            │
  └─────────────────────────────────────────────────────────┘

  设定精灵会引导你完成（约 1 分钟）。
`);
      }
    } catch (e) {
      // 设定档坏了也不要直接死，让使用者能在界面上修
      needsSetup = true;
      console.error(`\n  设定档读取失败：${e.message}`);
      console.error('  可以删除 config.json 后在界面上重新设定\n');
    }
  }
}

// ── 启动器輔助模式（让 .cmd 保持纯 ASCII，中文一律由 Node 以 UTF-8 输出）──
if (argv.includes('--banner')) {
  process.stdout.write(
    [
      '',
      '  ============================================================',
      '    客诉周报工具 - 视觉化界面',
      '  ============================================================',
      '',
      '    正在启动，稍后会自动打开浏览器…',
      '    使用完毕请直接关闭这个黑色窗口（或按 Ctrl+C）。',
      '',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

if (argv.includes('--probe')) {
  // 检查端口是否已有服务器在跑：0 = 已在执行，1 = 没在跑
  const net = await import('node:net');
  await new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: PORT });
    s.on('connect', () => {
      s.destroy();
      process.exit(0);
    });
    s.on('error', () => process.exit(1));
    s.setTimeout(2000, () => {
      s.destroy();
      process.exit(1);
    });
  });
}

if (argv.includes('--already')) {
  process.stdout.write('\n  工具已经在执行中，直接为你打开界面…\n');
  process.exit(0);
}

if (argv.includes('--failed')) {
  process.stdout.write(
    [
      '',
      '  ------------------------------------------------------------',
      '    启动失败。常见原因：',
      '      1. Node.js 未安装或不在 PATH',
      '      2. 8791 端口被其他程式佔用',
      '    请把上面的错误画面截图回报。',
      '  ------------------------------------------------------------',
      '',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

if (argv.includes('--stopped')) {
  process.stdout.write('\n  服务器已停止。\n');
  process.exit(0);
}

if (argv.includes('--wait-ready')) {
  // 等服务器真的开始 LISTEN 再开浏览器（取代固定 sleep，避免「无法连线」）
  const net = await import('node:net');
  const timeoutMs = Number(arg('timeout', 30000));
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const s = net.createConnection({ host: '127.0.0.1', port: PORT });
      s.on('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', (e) => {
        lastErr = e.code || e.message;
        resolve(false);
      });
      s.setTimeout(1500, () => {
        s.destroy();
        resolve(false);
      });
    });
    if (ok) {
      process.stdout.write(`  服务器就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）\n`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  process.stderr.write(`  等待服务器逾时（${timeoutMs / 1000}s，最后错误 ${lastErr}）\n`);
  process.exit(1);
}

// ───────── 状态 ─────────
const state = {
  phase: 'idle', // idle | running | paused | done | error | stopped
  start: null,
  end: null,
  label: null,
  step: '',
  games: {}, // gameId -> { name, tickets:{status,total,valid,invalid}, level1:{}, level2:{} }
  gameOrder: [],
  log: [],
  error: null,
  summary: null,
  files: {},
  startedAt: null,
  finishedAt: null,
  progress: { finished: 0, total: 0 },
  timeFilter: 'create', // create = 客訴創建時間、metric = 指標發生時間
};
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {}
  }
}
function pushLog(line) {
  const clean = String(line).replace(/\r$/, '');
  if (!clean.trim()) return;
  state.log.push(clean);
  if (state.log.length > 600) state.log.splice(0, state.log.length - 600);
  broadcast('log', clean);
}
function setPhase(p) {
  state.phase = p;
  broadcast('state', publicState());
}
function publicState() {
  return {
    phase: state.phase,
    start: state.start,
    end: state.end,
    label: state.label,
    step: state.step,
    games: state.gameOrder.map((id) => state.games[id]),
    progress: state.progress,
    error: state.error,
    summary: state.summary,
    files: state.files,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    log: state.log.slice(-300),
    // 統計頁的「時間依據」：客訴創建時間（create）/ 指標發生時間（metric）
    timeFilter: state.timeFilter || 'create',
    // 首次使用尚未設定 AIHelp 网址 → 界面顯示設定畫面
    needsSetup,
  };
}

// 啟動時先把設定讀進來（給介面顯示時間依據用）
try {
  const { loadConfig } = await import('../lib/config.mjs');
  const c = await loadConfig({ autoCreate: false });
  state.timeFilter = c.timeFilter || 'create';
} catch {}

// 这个服务器必须「打不死」：蒐集流程与 HTTP 服务在同一个程序内，
// 任何未捕捉的例外或未处理的 rejection 都会让整个界面死掉（使用者看到的症狀就是「按了没反应」）。
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException] ' + (e && e.stack ? e.stack : e));
  try {
    pushLog(`⚠️ 内部错误（已拦截，服务继续）：${e && e.message ? e.message : e}`);
    if (state.phase === 'running' || state.phase === 'paused') {
      state.error = `内部错误：${e && e.message ? e.message : e}`;
      setPhase('error');
    }
  } catch {}
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection] ' + (e && e.stack ? e.stack : e));
  try {
    pushLog(`⚠️ 未处理的错误（已拦截，服务继续）：${e && e.message ? e.message : e}`);
    if (state.phase === 'running' || state.phase === 'paused') {
      state.error = `内部错误：${e && e.message ? e.message : e}`;
      setPhase('error');
    }
  } catch {}
});

// ───────── 任务控制（直接呼叫模组，不用子程序 —— 避免管道缓冲与程序竞态） ─────────
let currentJob = null;

async function writeCtrl(obj) {
  await fs.mkdir(path.dirname(CTRL_FILE), { recursive: true });
  await fs.writeFile(CTRL_FILE, JSON.stringify({ pause: false, stop: false, ...obj }), 'utf8');
}

function handleProgress(payload) {
  const [kind, ...rest] = payload.split('|');
  if (kind === 'step') {
    state.step = rest.join('|');
    broadcast('state', publicState());
    return;
  }
  if (kind === 'game') {
    const [stage, gameId, name] = rest;
    ensureGame(gameId, name);
    state.games[gameId][stage] = { ...(state.games[gameId][stage] || {}), status: 'running' };
    state.current = { stage, gameId, name };
    broadcast('state', publicState());
    return;
  }
  if (kind === 'done') {
    const [stage, gameId, name, v1, v2, v3] = rest;
    ensureGame(gameId, name);
    if (stage === 'tickets') {
      state.games[gameId].tickets = { status: 'done', total: Number(v1), valid: Number(v2), invalid: Number(v3) };
      state.progress.finished++;
    } else {
      state.games[gameId][stage] = { status: 'done', sum: v1 === '' ? null : Number(v1) };
    }
    broadcast('state', publicState());
    return;
  }
  if (kind === 'error') {
    const [stage, gameId, name, msg] = rest;
    ensureGame(gameId, name);
    state.games[gameId][stage] = { status: 'error', error: msg };
    pushLog(`⚠️ ${name} ${stage} 失败：${msg}`);
    broadcast('state', publicState());
    return;
  }
  if (kind === 'summary') {
    state.summary = JSON.parse(rest.join('|'));
    broadcast('state', publicState());
    return;
  }
}

function ensureGame(gameId, name) {
  if (!state.games[gameId]) {
    state.games[gameId] = { gameId, name };
    state.gameOrder.push(gameId);
  }
  if (name) state.games[gameId].name = name;
}

const longDate = (d) => `${d} 00:00:00`;
const longDateEnd = (d) => `${d} 23:59:59`;
const shortCN = (d) => {
  const [, mo, dd] = d.split('-');
  return `${Number(mo)}月${Number(dd)}`;
};

async function runJob(start, end) {
  const trace = (m) => {
    state.log.push(`[trace] ${m}`);
    console.error(`[gui-trace] ${m}`);
  };
  try {
    trace('runJob 进入');
    state.start = start;
    state.end = end;
    state.label = `${shortCN(start)}-${shortCN(end)}`;
    state.games = {};
    state.gameOrder = [];
    state.log = [];
    state.error = null;
    state.summary = null;
    state.files = {};
    state.step = '';
    state.progress = { finished: 0, total: 0 };
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    setPhase('running');
    trace('phase=running 已设置');
    await writeCtrl({ pause: false, stop: false });
    trace('控制档已写入');

    const outName = `${start.slice(0, 7).replace('-', '')}_${start}_${end}`;
    const rawFile = path.join(ROOT, 'raw', `${outName}.json`);
    const xlsxName = `客诉周报_${shortCN(start)}-${shortCN(end)}`;

    pushLog(`=== 开始采集：${start} ~ ${end} ===`);
    // 先确认环境，避免一开始就卡在连线
    let cfg = null;
    try {
      const { listTargets, findPage, connect, loadConfig } = await import('../lib/cdp.mjs');
      cfg = await loadConfig();
      const targets = await listTargets(cfg.port);
      const pg = findPage(targets, cfg.host);
      if (!pg) throw new Error('专用 Chrome 未启动或找不到 AIHelp 分页 → 请按「启动 Chrome」');
      const c2 = await connect(cfg.port);
      const sid2 = await c2.attach(pg.id);
      const ev2 = c2.makeEval(sid2);
      const href2 = await ev2('location.href');
      const text2 = await ev2('document.body ? document.body.innerText.slice(0,120) : ""');
      c2.close();
      if (/#\/login|#\/signin/i.test(href2) || /登录您的账号|登录您的帳号/.test(text2)) {
        throw new Error('登录已失效 → 请在专用 Chrome 重新登录后再试');
      }
      pushLog('环境检查通过（已登录）');
    } catch (e) {
      state.error = e.message;
      state.finishedAt = new Date().toISOString();
      setPhase('error');
      pushLog('❌ 无法开始：' + e.message);
      broadcast('finished', publicState());
      return;
    }
    // 直接在同一个程序内执行，进度用 callback 即时回报
    const job = await collect({
      start: longDate(start),
      end: longDateEnd(end),
      label: state.label,
      outBase: path.join(ROOT, 'raw', outName),
      onLog: (m) => pushLog(m),
      onProgress: (p) => handleProgress(p),
      shouldPause: async () => {
        try {
          const c = JSON.parse(await fs.readFile(CTRL_FILE, 'utf8'));
          return !!c.pause;
        } catch {
          return false;
        }
      },
      shouldStop: async () => {
        try {
          const c = JSON.parse(await fs.readFile(CTRL_FILE, 'utf8'));
          return !!c.stop;
        } catch {
          return false;
        }
      },
    });

    // ───────── 用 LLM 产生「具体内容」摘要 ─────────
    let summaries = null;
    if (cfg && cfg.summarize !== false) {
      pushLog('\n=== 产生具体内容摘要 ===');
      state.step = '产生具体内容摘要';
      broadcast('state', publicState());
      try {
        const rawJson = JSON.parse(await fs.readFile(job.outFile, 'utf8'));
        const groups = prepareSummaryGroups(rawJson);
        if (!groups.length) {
          pushLog('  （没有可用于摘要的对话资料）');
        } else if (!cfg.llm.enabled) {
          pushLog('  ⚠️ 尚未设定 API 位址／模型 → 改用代表性原话作为摘要');
          pushLog('     请点右上角「设定」填入 AI 服务资讯');
          summaries = {};
          for (const g of groups) {
            summaries[g.gameName] = {};
            for (const it of g.items) summaries[g.gameName][it.tag] = fallbackSummary(it.messages, it.count);
          }
        } else {
          pushLog(`  使用模型：${cfg.llm.model}（${new URL(cfg.llm.baseUrl).host}）`);
          summaries = await summarizeGroups({ groups, llm: cfg.llm, log: (m) => pushLog(m) });
        }
      } catch (e) {
        pushLog(`  [!] 摘要产生失败：${e.message}`);
      }
    }

    pushLog('\n=== 转换数据 ===');
    state.step = '转换数据格式';
    broadcast('state', publicState());
    const { appFile, tagFiles } = await transform({
      inFile: job.outFile,
      outBase: path.join(ROOT, 'data', outName),
      onLog: (m) => pushLog('  ' + m),
      summaries,
    });

    pushLog('\n=== 产生报表 ===');
    state.step = '产生 Excel 报表';
    broadcast('state', publicState());
    const xlsxRes = await buildXlsxReport({
      appFile,
      tagFiles,
      periodLabel: state.label,
      outBase: path.join(ROOT, 'report', xlsxName),
    });
    const sheetRes = await buildSheet({
      appFile,
      tagFiles,
      periodLabel: state.label,
      outBase: path.join(ROOT, 'report', outName),
    });
    pushLog(`  Excel：${path.basename(xlsxRes.file)}`);
    pushLog(`  文字档：${path.basename(sheetRes.file)}`);

    const xlsxPath = xlsxRes.file;
    state.files = {
      xlsx: path.basename(xlsxPath),
      xlsxFull: xlsxPath,
      raw: path.basename(job.outFile),
      tsv: path.basename(sheetRes.file),
    };
    state.summary = job.summary;
    state.step = '完成';
    state.finishedAt = new Date().toISOString();
    const failed = state.gameOrder.filter((id) => !state.games[id].tickets || state.games[id].tickets.status !== 'done');
    setPhase(failed.length ? 'error' : 'done');
    state.error = failed.length ? `${failed.length} 个游戏的客诉数据未成功取得` : null;
    pushLog(`\n=== ${failed.length ? '完成（有错误）' : '全部采集成功，无错误'} ===`);
    broadcast('finished', publicState());
  } catch (e) {
    const stopped = e instanceof StopRequested || /终止/.test(e.message);
    state.error = stopped ? '使用者终止' : e.message;
    state.finishedAt = new Date().toISOString();
    setPhase(stopped ? 'stopped' : 'error');
    pushLog(`\n${stopped ? '⏹ 已终止' : '❌ 发生错误：' + e.message}`);
    broadcast('finished', publicState());
  } finally {
    currentJob = null;
    try {
      await fs.rm(CTRL_FILE, { force: true });
    } catch {}
  }
}

// ───────── HTTP ─────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ico': 'image/x-icon' };

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      const html = await fs.readFile(path.join(__dirname, 'gui', 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(html);
    }
    if (p.startsWith('/static/')) {
      const f = path.join(__dirname, 'gui', path.basename(p));
      const ext = path.extname(f);
      const data = await fs.readFile(f);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return res.end(data);
    }

    if (p === '/api/state') return json(res, 200, publicState());

    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
      clients.add(res);
      const ka = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {}
      }, 15000);
      req.on('close', () => {
        clearInterval(ka);
        clients.delete(res);
      });
      return;
    }

    // ───────── 首次設定（在网页上填 AIHelp 网址，不用开终端）─────────
    if (p === '/api/setup' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const url = String(body.dashboardUrl || '').trim();
        if (!url) return json(res, 400, { ok: false, message: '请填写 AIHelp 网址' });

        const { saveConfig } = await import('../lib/config.mjs');
        const { PLACEHOLDER_HOST } = await import('../lib/config.mjs');

        // 正规化：允许只填网域
        let full = url;
        if (!/^https?:\/\//i.test(full)) full = 'https://' + full;
        let u;
        try {
          u = new URL(full);
        } catch {
          return json(res, 400, { ok: false, message: '网址格式不正确，请填成 https://你的公司.aihelp.net/dashboard/' });
        }
        if (!u.hostname) return json(res, 400, { ok: false, message: '网址格式不正确' });
        // 注意：new URL() 会把 hostname 转小写，PLACEHOLDER_HOST 是大小写混排的，
        // 所以要比对时必须两边都转小写（这个坑之前踩过一次）。
        if (u.hostname.toLowerCase() === PLACEHOLDER_HOST.toLowerCase()) {
          return json(res, 400, { ok: false, message: '请填你自己的 AIHelp 网址，不是范例网址' });
        }
        if (!/aihelp\.net$/i.test(u.hostname)) {
          return json(res, 400, { ok: false, message: `这看起来不是 AIHelp 网址（应该是 xxx.aihelp.net）` });
        }
        // 补成 dashboard 路径
        if (!/\/dashboard/i.test(u.pathname)) {
          u.pathname = '/dashboard/';
        }

        await saveConfig({ dashboardUrl: u.origin + u.pathname + (u.hash || '#/insight/tickets/ticket') });
        needsSetup = false;
        broadcast('state', publicState());
        return json(res, 200, { ok: true, dashboardUrl: u.origin });
      } catch (e) {
        return json(res, 500, { ok: false, message: e.message });
      }
    }

    if (p === '/api/start' && req.method === 'POST') {
      if (needsSetup) return json(res, 400, { error: '请先完成首次设定（填写 AIHelp 网址）' });
      if (state.phase === 'running' || state.phase === 'paused') return json(res, 409, { error: '已有任务在执行中' });
      const { start, end } = await readBody(req);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
        return json(res, 400, { error: '日期格式需为 YYYY-MM-DD' });
      }
      if (start > end) return json(res, 400, { error: '起始日不可晚于结束日' });
      currentJob = runJob(start, end).catch((e) => pushLog('❌ 任务異常：' + e.message));
      return json(res, 200, { ok: true, start, end });
    }

    if (p === '/api/pause' && req.method === 'POST') {
      if (state.phase !== 'running') return json(res, 409, { error: '目前没有执行中的任务' });
      await writeCtrl({ pause: true, stop: false });
      setPhase('paused');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/resume' && req.method === 'POST') {
      if (state.phase !== 'paused') return json(res, 409, { error: '任务不在暂停状态' });
      await writeCtrl({ pause: false, stop: false });
      setPhase('running');
      return json(res, 200, { ok: true });
    }
    if (p === '/api/stop' && req.method === 'POST') {
      if (state.phase !== 'running' && state.phase !== 'paused') return json(res, 409, { error: '目前没有执行中的任务' });
      await writeCtrl({ pause: false, stop: true });
      setPhase('stopped');
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/download/')) {
      const kind = p.split('/').pop();
      let file = null;
      if (kind === 'xlsx') file = state.files.xlsxFull;
      else if (kind === 'raw') file = path.join(ROOT, 'raw', state.files.raw || '');
      else if (kind === 'tsv') file = path.join(ROOT, 'report', state.files.tsv || '');
      if (!file) return json(res, 404, { error: '没有可下载的文件' });
      try {
        const data = await fs.readFile(file);
        const name = path.basename(file);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Content-Length': data.length,
        });
        return res.end(data);
      } catch {
        return json(res, 404, { error: '文件不存在' });
      }
    }

    if (p === '/api/launch-chrome' && req.method === 'POST') {
      // 启动专用 Chrome，或把它叫到最前面
      try {
        const { listTargets, findPage, connect, waitForCdp, loadConfig } = await import('../lib/cdp.mjs');
        const { spawn } = await import('node:child_process');
        const cfg = await loadConfig();
        let already = false;
        try {
          const targets = await listTargets(cfg.port);
          already = targets.length > 0;
          const page = findPage(targets, cfg.host);
          if (page) {
            const conn = await connect(cfg.port);
            try {
              await conn.send('Target.activateTarget', { targetId: page.id });
            } catch {}
            conn.close();
          }
        } catch {
          already = false;
        }
        if (!already) {
          // 找不到 Chrome / Edge 时给使用者看得懂的说明，而不是 spawn 失败
          if (!cfg.chrome) {
            return json(res, 200, {
              ok: false,
              message:
                '找不到 Chrome 或 Edge 浏览器。请先安装 Google Chrome（https://www.google.com/chrome/），装好后重新启动本工具。',
            });
          }
          await fs.mkdir(cfg.profileDir, { recursive: true });
          const child = spawn(
            cfg.chrome,
            [`--remote-debugging-port=${cfg.port}`, `--user-data-dir=${cfg.profileDir}`, '--no-first-run', '--no-default-browser-check', cfg.dashboardUrl],
            { stdio: 'ignore', detached: true },
          );
          child.unref();
          const ver = await waitForCdp(cfg.port, 60);
          if (!ver) return json(res, 500, { ok: false, message: 'Chrome 启动失败（CDP 端点未出现）' });
          return json(res, 200, { ok: true, message: '已启动专用 Chrome，请在該窗口登录 AIHelp' });
        }
        return json(res, 200, { ok: true, message: '已将专用 Chrome 叫到最前面' });
      } catch (e) {
        return json(res, 500, { ok: false, message: '操作失败：' + e.message });
      }
    }

    // ───────── 設定（AI 服務）─────────
    if (p === '/api/settings' && req.method === 'GET') {
      try {
        const c = await loadConfig({ autoCreate: false });
        return json(res, 200, {
          ok: true,
          llm: { baseUrl: c.llm.baseUrl, model: c.llm.model, hasKey: !!c.llm.apiKey, enabled: c.llm.enabled },
          summarize: c.summarize !== false,
          timeFilter: c.timeFilter || 'create',
        });
      } catch (e) {
        return json(res, 500, { ok: false, message: e.message });
      }
    }

    if (p === '/api/settings' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { saveConfig } = await import('../lib/config.mjs');
        const patch = {};
        const llmPatch = {};
        // 只有「有填东西」才覆盖 —— 空白一律视为「不修改」，
        // 避免使用者只改其中一项时把其他设定（尤其是 API Key）清掉。
        if (typeof body.llmBaseUrl === 'string' && body.llmBaseUrl.trim()) llmPatch.baseUrl = body.llmBaseUrl.trim();
        if (typeof body.llmModel === 'string' && body.llmModel.trim()) llmPatch.model = body.llmModel.trim();
        if (typeof body.llmApiKey === 'string' && body.llmApiKey.trim()) llmPatch.apiKey = body.llmApiKey.trim();
        if (body.clearKey) llmPatch.apiKey = '';
        if (Object.keys(llmPatch).length) patch.llm = llmPatch;
        if (typeof body.summarize === 'boolean') patch.summarize = body.summarize;

        const saved = await saveConfig(patch);

        // 立刻套用到執行中的狀態（不必重啟）
        const c = await loadConfig({ autoCreate: false });
        state.timeFilter = c.timeFilter || 'create';
        broadcast('state', publicState());

        return json(res, 200, {
          ok: true,
          llm: { baseUrl: saved.llm?.baseUrl || '', model: saved.llm?.model || '', hasKey: !!saved.llm?.apiKey, enabled: c.llm.enabled },
          summarize: c.summarize !== false,
        });
      } catch (e) {
        return json(res, 500, { ok: false, message: e.message });
      }
    }

    if (p === '/api/models' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const c = await loadConfig({ autoCreate: false });
        const probe = {
          baseUrl: (body.llmBaseUrl || '').trim() || c.llm.baseUrl,
          apiKey: (body.llmApiKey || '').trim() || c.llm.apiKey,
        };
        if (!probe.baseUrl) return json(res, 200, { ok: false, message: '请先选择服务商或填写 API 位址' });
        try {
          const models = await listLlmModels(probe);
          return json(res, 200, { ok: true, models });
        } catch (e) {
          return json(res, 200, { ok: false, message: e.message });
        }
      } catch (e) {
        return json(res, 500, { ok: false, message: e.message });
      }
    }

    if (p === '/api/test-llm' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const c = await loadConfig({ autoCreate: false });
        // 允許先用表單上的值測試（不必先儲存）
        const probe = {
          baseUrl: (body.llmBaseUrl || '').trim() || c.llm.baseUrl,
          apiKey: (body.llmApiKey || '').trim() || c.llm.apiKey,
          model: (body.llmModel || '').trim() || c.llm.model,
        };
        if (!probe.baseUrl) return json(res, 200, { ok: false, message: '请先填写 API 位址' });
        if (!probe.model) return json(res, 200, { ok: false, message: '请先填写模型名称' });
        try {
          const r = await testLlm(probe);
          return json(res, 200, { ok: true, message: `连线成功（${r.ms} ms）：${r.reply}`, ms: r.ms });
        } catch (e) {
          return json(res, 200, { ok: false, message: e.message });
        }
      } catch (e) {
        return json(res, 500, { ok: false, message: e.message });
      }
    }

    if (p === '/api/check-chrome') {
      const { listTargets, findPage, connect, loadConfig } = await import('../lib/cdp.mjs');
      const cfg = await loadConfig();
      try {
        const targets = await listTargets(cfg.port);
        const page = findPage(targets, cfg.host);
        if (!page) {
          // 对使用者说人话：不要说「执行 chrome-up.mjs」这种开发者指令
          return json(res, 200, {
            ok: false,
            reason: 'no-page',
            message: 'Chrome 还没启动 → 请按右上角「启动 Chrome」',
          });
        }
        const conn = await connect(cfg.port);
        const sid = await conn.attach(page.id);
        const ev = conn.makeEval(sid);
        const href = await ev('location.href');
        // 注意：背景分页的 innerText 一律是空字串，所以不能只看文字，要看 DOM 证据
        const text = await ev('document.body ? document.body.innerText.slice(0,120) : ""');
        const tabs = await ev(`document.querySelectorAll('.el-tabs__item').length`);
        const tokenLen = await ev(`(localStorage.getItem('token')||'').length`);
        conn.close();
        const needLogin =
          /#\/login|#\/signin/i.test(href) ||
          /登录您的账号|登录您的帳号/.test(text) ||
          (tabs < 5 && tokenLen === 0);
        return json(res, 200, needLogin ? { ok: false, reason: 'login', message: '登录已失效，请在专用 Chrome 重新登录' } : { ok: true, message: '已登录，可以开始' });
      } catch (e) {
        return json(res, 200, { ok: false, reason: 'no-chrome', message: '专用 Chrome 未启动：' + e.message });
      }
    }

    if (p === '/api/shutdown' && req.method === 'POST') {
      // 供「关闭工具」按钮与桌面「结束」捷径使用
      json(res, 200, { ok: true, message: '工具已关闭' });
      pushLog('收到关闭指令，正在停止服务…');
      setTimeout(() => process.exit(0), 600);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`
  ┌─────────────────────────────────────────────────────────┐
  │  工具已经在运行了（端口 ${PORT} 被占用）                  │
  └─────────────────────────────────────────────────────────┘

  这通常不是错误 —— 可能是你之前已经打开过这个工具。

  请直接用浏览器打开：  http://127.0.0.1:${PORT}

  如果想重新启动，请先双击桌面的「结束客诉周报工具」，
  或关掉之前那个黑色窗口，再试一次。
`);
    process.exit(1);
  }
  console.error('服务器错误：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`GUI 已启动：http://127.0.0.1:${PORT}`);
});
