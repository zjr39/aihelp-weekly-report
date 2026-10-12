// 收集 AIHelp 客诉统计 + 真实客诉明细 —— 可程式呼叫的核心（GUI 直接在同程序内执行）
//
// 无效客诉 = 无标签客诉 + 带「无效来访」标签的客诉
// 有效客诉 = 总客诉 − 无效客诉
//
// 两个关键陷阱（都是实际踩过的）：
//   1. 签名标头綁定端点：统计端点的标头拿去打客诉列表会 403，
//      所以必须分別拦截 ticketstatmerge 与 ticket/home/searchnew 自己的标头。
//   2. 背景分页的 innerText 一律是空字串，不能用文字判断页面是否加载完成，
//      只能用 DOM 元素数量。
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, listTargets, findPage, connect, sleep } from '../lib/cdp.mjs';
import { ticketListPage, ticketSearchApi } from './pages.mjs';

// 这兩個是「資料標籤」的比對值，必須與 AIHelp 後台顯示的文字完全一致。
// 同时保留简繁两种写法，避免使用者帐号语言设定不同时比对失败。
const INVALID_TAGS = ['无效来访', '無效來訪'];
const DUAL_TAGS = ['非坐席原因差评', '非坐席原因差評'];

const sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Number(x) === Number(b[i]));

export class StopRequested extends Error {
  constructor(msg = '使用者终止') {
    super(msg);
    this.name = 'StopRequested';
  }
}

export async function collect({
  start,
  end,
  label = `${start} ~ ${end}`,
  outBase,
  onProgress = () => {},
  onLog = () => {},
  shouldPause = async () => false,
  shouldStop = async () => false,
  ownTab = true,
} = {}) {
  if (!start || !end) throw new Error('collect 需要 start 与 end');
  const cfg = await loadConfig();
  const fromMs = new Date(start.replace(' ', 'T') + '+08:00').getTime();
  const toMs = new Date(end.replace(' ', 'T') + '+08:00').getTime();
  const hdrFile = `${outBase}.headers.json`;

  const log = (m = '') => onLog(String(m));
  const prog = (kind, extra = '') => onProgress(`${kind}${extra ? '|' + extra : ''}`);

  async function checkpoint(where) {
    for (;;) {
      if (await shouldStop()) throw new StopRequested(`收到终止指令（${where}）`);
      if (!(await shouldPause())) return;
      log(`[暂停] ${where}…按继续以恢复`);
      prog('paused', where);
      await sleep(1000);
    }
  }

  // ───────── 连线与分页 ─────────
  const targets = await listTargets(cfg.port);
  let page = findPage(targets, cfg.host);
  if (!page) throw new Error('找不到 AIHelp 分页（请先执行 bin/chrome-up.mjs）');
  const conn = await connect(cfg.port);
  let sid = await conn.attach(page.id);
  let ev = conn.makeEval(sid, { timeout: 180000 });
  let ownTabId = null;

  /** 等页面渲染完成（只看 DOM，不看文字 —— 背景分页的 innerText 是空的） */
  async function waitRendered({ timeoutMs = 90000, label: lbl = '统计页' } = {}) {
    const t0 = Date.now();
    let last = '（尚未取得）';
    while (Date.now() - t0 < timeoutMs) {
      try {
        const stat = JSON.parse(await ev(`(() => JSON.stringify({ tabs: document.querySelectorAll('.el-tabs__item').length, btns: document.querySelectorAll('button, .el-button').length }))()`));
        last = `tabs=${stat.tabs} buttons=${stat.btns}`;
        if (stat.tabs >= 5 && stat.btns >= 5) return Date.now() - t0;
      } catch (e) {
        last = 'evaluate 失败：' + e.message;
      }
      await sleep(1000);
    }
    throw new Error(`${lbl} 渲染超时（${timeoutMs / 1000}s，最后 ${last}）`);
  }

  /** 安装拦截器（页面重载后要重新安装） */
  async function installInterceptor() {
    await ev(`
(() => {
  window.__CAP__ = [];
  window.__HDR__ = window.__HDR__ || {};
  const O = XMLHttpRequest.prototype;
  if (O.__hooked) return window.__HDR__.tickets ? 'kept' : 'reinstalled';
  O.__hooked = true;
  const oOpen = O.open, oSend = O.send, oSet = O.setRequestHeader;
  O.open = function (m, u) { this.__u = u; this.__m = m; this.__h = {}; return oOpen.apply(this, arguments); };
  O.setRequestHeader = function (k, v) { try { if (this.__h) this.__h[k] = v; } catch (e) {} return oSet.apply(this, arguments); };
  O.send = function (b) {
    const self = this;
    const url = String(self.__u || '');
    if (/ticketstatmerge/.test(url)) {
      self.addEventListener('loadend', () => { try { window.__CAP__.push({ body: String(b || ''), len: (self.responseText || '').length, resp: self.responseText || '' }); } catch (e) {} });
    }
    if (String(self.__m || '').toUpperCase() === 'POST' && /console\\/api\\//.test(url)) {
      self.addEventListener('loadend', () => {
        try {
          if (/ticket\\/home\\/searchnew/.test(url)) window.__HDR__.tickets = { url, headers: self.__h };
          else if (!window.__HDR__.stat) window.__HDR__.stat = { url, headers: self.__h };
        } catch (e) {}
      });
    }
    return oSend.apply(this, arguments);
  };
  return 'installed';
})()
`);
  }

  const getHdr = async (which) => JSON.parse(await ev(`window.__HDR__ && window.__HDR__.${which} ? JSON.stringify(window.__HDR__.${which}) : 'null'`));

  /** 导览到指定网址并等渲染完成，之后重新安装拦截器 */
  async function goto(url, lbl) {
    await conn.send('Page.navigate', { url }, sid);
    await waitRendered({ timeoutMs: 90000, label: lbl });
    await sleep(2000);
    await installInterceptor();
  }

  const cleanup = async () => {
    if (!ownTabId) return;
    const id = ownTabId;
    ownTabId = null;
    try {
      await conn.send('Target.closeTarget', { targetId: id });
    } catch {}
  };

  try {
    if (ownTab) {
      log('打开全新分页（确保干净状态）…');
      const created = await conn.send('Target.createTarget', { url: cfg.dashboardUrl });
      ownTabId = created.targetId;
      for (let i = 0; i < 40; i++) {
        await sleep(800);
        const t = (await listTargets(cfg.port)).find((x) => x.id === ownTabId);
        if (t && !t.url.startsWith('about:')) {
          page = t;
          break;
        }
      }
      sid = await conn.attach(page.id);
      ev = conn.makeEval(sid, { timeout: 180000 });
      const ms = await waitRendered({ timeoutMs: 90000, label: '新分页' });
      log(`  页面已渲染（${(ms / 1000).toFixed(1)}s）`);
      const hrefNow = await ev('location.href');
      if (/#\/login|#\/signin/i.test(hrefNow)) throw new Error('登入已失效，请在专用 Chrome 重新登入');
      log('  新分页就緒：' + String(hrefNow).slice(0, 90));
    }
    await installInterceptor();

    // ───────── 客诉列表：签名綁定「请求参数」，所以不能重放请求 ─────────
    //   正确做法：切到客诉列表页，设置好条件后呼叫页面自己的 homeSearch，
    //   让页面自己产生签名。而且「所有应用」一次查询就回传全部游戏的客诉，
    //   不需要逐游戏切換（快很多，也少很多出错机会）。

    /** 在客诉列表页用页面自身的方法查询，回传所有游戏的 items */
    async function fetchAllTickets() {
      await goto(ticketListPage(cfg), '客诉列表页');
      await sleep(2500);

      // 等 NewChats 组件挂载完成（这页的分页／按钮会先出现，组件较慢）
      const hasNewChats = `(() => { for (const e of document.querySelectorAll('*')) { const v = e.__vue__; if (v && v.$options && v.$options.name === 'NewChats') return true; } return false; })()`;
      let ncReady = false;
      const tNC = Date.now();
      while (Date.now() - tNC < 60000) {
        if (await ev(hasNewChats)) {
          ncReady = true;
          break;
        }
        await sleep(1000);
      }
      if (!ncReady) {
        // 再导览一次通常就会好（第一次进这页较慢）
        log('  NewChats 组件尚未就緒，重新载入客诉列表页…');
        await goto(ticketListPage(cfg), '客诉列表页');
        await sleep(3000);
        const t2 = Date.now();
        while (Date.now() - t2 < 60000) {
          if (await ev(hasNewChats)) {
            ncReady = true;
            break;
          }
          await sleep(1000);
        }
      }
      if (!ncReady) throw new Error('客诉列表页的 NewChats 组件载入逾时');
      log(`  客诉列表页就緒（${((Date.now() - tNC) / 1000).toFixed(1)}s）`);

      await ev(`
(() => {
  window.__TL__ = [];
  const O = XMLHttpRequest.prototype;
  if (O.__tlcap) return 1;
  O.__tlcap = true;
  const oOpen = O.open, oSend = O.send;
  O.open = function (m, u) { this.__u = u; return oOpen.apply(this, arguments); };
  O.send = function (b) {
    const self = this;
    if (/ticket\\/home\\/searchnew/.test(String(self.__u || ''))) {
      self.addEventListener('loadend', () => {
        try { window.__TL__.push({ body: String(b || ''), len: (self.responseText || '').length, resp: self.responseText || '' }); } catch (e) {}
      });
    }
    return oSend.apply(this, arguments);
  };
  return 1;
})()
`);

      const allItems = [];
      let totalItems = 0;
      let pageIndex = 1;
      for (;;) {
        if (await shouldStop()) throw new StopRequested('收到终止指令');
        const seqBefore = JSON.parse(await ev(`JSON.stringify({ n: (window.__TL__||[]).length })`)).n;
        const setup = JSON.parse(
          await ev(`
(async () => {
  let nc = null;
  for (const el of document.querySelectorAll('*')) {
    const v = el.__vue__;
    if (v && v.$options && v.$options.name === 'NewChats') { nc = v; break; }
  }
  if (!nc) return JSON.stringify({ ok: false, why: '找不到 NewChats 组件' });
  const base = nc._data.lastSearchParams ? JSON.parse(JSON.stringify(nc._data.lastSearchParams)) : {};
  const params = Object.assign(base, {
    queryType: '2',
    gameIdList: '',
    pageIndex: ${pageIndex},
    pageSize: 100,
    createTimeFrom: ${fromMs},
    createTimeTo: ${toMs},
    nofinish: '2',
    searchSource: 'ticket',
    toCancel: true,
  });
  nc._data.lastSearchParams = params;
  nc._data.lastSearchParamsToSearch = JSON.parse(JSON.stringify(params));
  try {
    if (typeof nc.homeSearch === 'function') nc.homeSearch();
    else if (typeof nc.homeSearchCore === 'function') nc.homeSearchCore();
    else return JSON.stringify({ ok: false, why: '找不到查询方法' });
  } catch (e) { return JSON.stringify({ ok: false, why: '呼叫失败：' + e.message }); }
  return JSON.stringify({ ok: true });
})()
`),
        );
        if (!setup.ok) throw new Error('无法驅动客诉列表查询：' + setup.why);

        let info = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 60000) {
          const arr = JSON.parse(await ev(`JSON.stringify((window.__TL__||[]).map((r,i)=>({ i, len: r.len })))`));
          const fresh = arr.filter((r) => r.i >= seqBefore && r.len > 50);
          if (fresh.length) {
            info = fresh[fresh.length - 1];
            break;
          }
          await sleep(600);
        }
        if (!info) throw new Error(`第 ${pageIndex} 页查询超时`);

        const CHUNK = 20000;
        const parts = [];
        for (let off = 0; off < info.len; off += CHUNK) {
          const p = await ev(`(() => { const r = (window.__TL__||[])[${info.i}]; return JSON.stringify({ s: (r && r.resp || '').substr(${off}, ${CHUNK}) }); })()`);
          parts.push(JSON.parse(p).s);
        }
        const j = JSON.parse(parts.join(''));
        if (j.flag === false) throw new Error(`客诉列表 API code=${j.code} ${j.desc}`);
        const d = j.data || {};
        totalItems = d.totalItems || 0;
        const items = d.items || [];
        allItems.push(...items);
        const pages = d.totalPages || 1;
        log(`  第 ${pageIndex}/${pages} 页：${items.length} 笔（累计 ${allItems.length}／总计 ${totalItems}）`);
        prog('progress', `客诉明细 ${allItems.length}/${totalItems}`);
        if (pageIndex >= pages || !items.length) break;
        pageIndex++;
      }
      return { items: allItems, total: totalItems };
    }

    // ───────── 游戏清单 ─────────
    const appsCache = path.join(path.dirname(outBase), 'appList.json');
    let appList = null;
    try {
      const c = JSON.parse(await fs.readFile(appsCache, 'utf8'));
      if (Array.isArray(c) && c.length) appList = c;
    } catch {}
    if (!appList) {
      log('\n[0b] 取得游戏清单…');
      await clickText('趋势');
      await sleep(1500);
      await clickText('应用');
      await sleep(2500);
      await clickText('所有应用', { timeoutMs: 15000 });
      await sleep(2000);
      const d = JSON.parse(
        await ev(`
(() => {
  const drop = [...document.querySelectorAll('.el-select-dropdown')].find((x) => /所有应用/.test(x.textContent || ''));
  if (!drop) return JSON.stringify({ games: [] });
  const out = [];
  for (const el of drop.querySelectorAll('*')) {
    const v = el.__vue__;
    if (!v || !v.$options) continue;
    const nm = String(v.$options.name || '');
    if (nm !== 'ElOption' && nm !== 'Option') continue;
    const val = v.value;
    const lbl = String(v.currentLabel || '').replace(/\\s+/g, ' ').trim();
    if (/所有应用/.test(lbl) || val === undefined || val === null || val === '') continue;
    out.push({ gameId: Number(val), gameName: lbl });
  }
  const seen = new Set();
  return JSON.stringify({ games: out.filter((o) => { if (seen.has(o.gameId)) return false; seen.add(o.gameId); return true; }).filter((o) => o.gameId > 10000 && !/条\\/页|阶段|队列/.test(o.gameName)) });
})()
`),
      );
      appList = d.games;
      if (!appList.length) throw new Error('无法取得游戏清单');
      await fs.mkdir(path.dirname(appsCache), { recursive: true });
      await fs.writeFile(appsCache, JSON.stringify(appList, null, 2), 'utf8');
      // 菜单开著会擋住后续操作，关掉它
      await ev(`document.body.click()`);
      await sleep(500);
    }
    const ALL_APPS = appList.map((a) => a.gameId);
    log(`游戏清单（${appList.length} 个）：${appList.map((a) => a.gameName).join('、')}`);
    prog('games', String(appList.length));

    // ───────── 共用页面操作 ─────────
    const SET_STATE = (s, e, appIds) => `
(() => {
  const findComp = (name) => { for (const el of document.querySelectorAll('*')) { const v = el.__vue__; if (v && v.$options && v.$options.name === name) return v; } return null; };
  const dp = findComp('AiDatePicker'), sv = findComp('SearchView');
  if (!dp || !sv) return JSON.stringify({ ok: false });
  dp.datePickerValue = [${JSON.stringify(s)}, ${JSON.stringify(e)}];
  sv.timeList = [${JSON.stringify(s)}, ${JSON.stringify(e)}];
  sv.selectAppList = ${JSON.stringify(appIds)};
  sv.appSelectionValues = [];
  sv.$forceUpdate && sv.$forceUpdate();
  return JSON.stringify({ ok: true });
})()
`;

    const SEARCH = `
(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, '').trim();
  const btn = [...document.querySelectorAll('button, .el-button')].find((e) => norm(e.textContent).includes('搜索'));
  if (!btn) return 'not-found';
  btn.click();
  return 'ok';
})()
`;

    async function waitFor(expr, { timeoutMs = 25000, label = '元素' } = {}) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (await ev(expr)) return true;
        await sleep(400);
      }
      return false;
    }

    async function clickText(text, { timeoutMs = 20000 } = {}) {
      const expr = `
(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, '').trim();
  const t = norm(${JSON.stringify(text)});
  const cands = [...document.querySelectorAll('.el-tabs__item, .tag-level-item, button, .el-button, span, div, a, li')];
  const hits = cands.filter((e) => norm(e.textContent) === t);
  if (!hits.length) return false;
  hits.sort((a, b) => a.children.length - b.children.length || a.textContent.length - b.textContent.length);
  hits[0].click();
  return true;
})()
`;
      return await waitFor(expr, { timeoutMs, label: text });
    }

    async function readResp(idx, len) {
      const CHUNK = 24000;
      const parts = [];
      for (let off = 0; off < len; off += CHUNK) {
        const p = await ev(`(() => { const c = (window.__CAP__||[])[${idx}]; return JSON.stringify({ s: c ? c.resp.substr(${off}, ${CHUNK}) : '' }); })()`);
        parts.push(JSON.parse(p).s);
      }
      return parts.join('');
    }

    const SEARCH_BTN_EXISTS = `[...document.querySelectorAll('button, .el-button')].some((e) => (e.textContent || '').replace(/\\s+/g, '').includes('搜索'))`;

    async function statQuery(expect, { retries = 5, perTryMs = 40000, tab = null } = {}) {
      let problem = '';
      for (let attempt = 1; attempt <= retries; attempt++) {
        if (await shouldStop()) throw new StopRequested('收到终止指令');
        if (attempt > 1) await sleep(Math.min(20000, 3000 * (attempt - 1)));
        if (tab && attempt > 1) {
          await clickText('趋势');
          await sleep(1200);
          await clickText(tab);
          await sleep(2200);
          if (expect.tagLevel !== undefined) {
            await clickText(expect.tagLevel === 1 ? '一级标签' : '二级标签');
            await sleep(1600);
          }
        }
        const from = JSON.parse(await ev(`JSON.stringify({ n: (window.__CAP__||[]).length })`)).n;
        await ev(SET_STATE(start, end, expect.gameIds));
        await sleep(1000);
        await waitFor(SEARCH_BTN_EXISTS, { timeoutMs: 25000, label: '搜索按钮' });
        if ((await ev(SEARCH)) !== 'ok') throw new Error('找不到搜索按钮');
        const t0 = Date.now();
        let idx = null,
          len = 0,
          body = null;
        while (Date.now() - t0 < perTryMs) {
          const info = JSON.parse(
            await ev(`(() => { const all = (window.__CAP__||[]); const c = all.slice(${from}); const last = c[c.length-1]; return JSON.stringify({ idx: last ? all.length-1 : null, len: last ? last.len : 0, body: last ? last.body : null }); })()`),
          );
          if (info.idx !== null && info.len > 0) {
            idx = info.idx;
            len = info.len;
            body = info.body;
            break;
          }
          await sleep(600);
        }
        if (idx === null) {
          problem = '超时未收到回应';
          continue;
        }
        const req = JSON.parse(body);
        if (expect.statsType !== undefined && req.statsType !== expect.statsType) {
          problem = `statsType=${req.statsType}（预期 ${expect.statsType}）`;
          continue;
        }
        if (expect.tagLevel !== undefined && req.tagLevel !== expect.tagLevel) {
          problem = `tagLevel=${req.tagLevel}`;
          continue;
        }
        if (expect.gameIds && !sameIds(req.gameIdList, expect.gameIds)) {
          problem = 'gameIdList 不符';
          continue;
        }
        if (req.timeStart !== start || req.timeEnd !== end) {
          problem = `时间不符（${req.timeStart}）`;
          continue;
        }
        const respText = await readResp(idx, len);
        if (/^\s*Too Many Requests/i.test(respText)) {
          problem = 'Too Many Requests（限流）';
          continue;
        }
        let json = null;
        try {
          json = JSON.parse(respText);
        } catch {
          problem = `回应非 JSON：${respText.slice(0, 120)}`;
          continue;
        }
        if (json.flag === false) {
          problem = `API code=${json.code} ${json.desc}`;
          continue;
        }
        return { req, json, attempt };
      }
      throw new Error(`统计查询失败：${problem}`);
    }

    // ───────── 1) 应用视角 ─────────
    log('\n[1/4] 应用视角（全部游戏）…');
    prog('step', '1/4 应用视角');
    await clickText('趋势');
    await sleep(1500);
    await clickText('应用');
    await sleep(2500);
    const appRes = await statQuery({ gameIds: ALL_APPS, statsType: 2 }, { tab: '应用' });
    const appRows = appRes.json.data.statsList || [];
    log(`  OK ${appRows.length} 列`);

    // ───────── 2) 真实客诉明细（一次查全部游戏）─────────
    log('\n[2/4] 真实客诉明细（全部游戏一次查完）…');
    prog('step', '2/4 客诉明细（一次查全部游戏）');
    const fetched = await fetchAllTickets();
    log(`  共取回 ${fetched.items.length} 笔客诉（API 回报总计 ${fetched.total} 笔）`);
    await goto(cfg.dashboardUrl, '客诉统计页');

    // 依游戏分组，并计算有效／无效
    const counts = {};
    const ticketDetails = {};
    const grouped = new Map();
    for (const t of fetched.items) {
      const gid = t.gameId ?? t.bsGameId ?? t.bsgameid ?? null;
      if (gid === null) continue;
      const key = String(gid);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(t);
    }
    for (const g of appList) {
      const items = grouped.get(String(g.gameId)) || [];
      const total = items.length;
      const noTag = items.filter((t) => !(t.tagList && t.tagList.length)).length;
      const invalidVisit = items.filter((t) => (t.tagList || []).some((x) => INVALID_TAGS.includes(x))).length;
      const dualTag = items.filter((t) => (t.tagList || []).some((x) => DUAL_TAGS.includes(x))).length;
      const invalid = noTag + invalidVisit;
      const valid = total - invalid;
      counts[g.gameId] = { gameName: g.gameName, total, noTag, invalidVisit, dualTag, valid, invalid };
      ticketDetails[g.gameId] = {
        gameName: g.gameName,
        items: items.map((t) => ({ tags: t.tagList, createTimeText: t.createTimeText, title: (t.title || '').slice(0, 80) })),
      };
      log(`  ${g.gameName.padEnd(22)} 客诉=${String(total).padStart(4)}  无标签=${noTag}  无效来访=${invalidVisit}  -> 有效=${valid}  无效=${invalid}`);
      prog('done', `tickets|${g.gameId}|${g.gameName}|${total}|${valid}|${invalid}`);
    }
    const sumFetched = Object.values(counts).reduce((a, c) => a + c.total, 0);
    if (fetched.total !== sumFetched) {
      log(`  [!] 取回 ${sumFetched} 笔，但 API 回报总计 ${fetched.total} 笔（可能有未列在应用清单的游戏）`);
    }

    // ───────── 3) 一级标签 ─────────
    log('\n[3/4] 统计页 -> 一级标签（逐游戏）…');
    prog('step', '3/4 一级标签');
    await clickText('标签');
    await sleep(2500);
    await clickText('一级标签');
    await sleep(2000);
    const l1ByGame = {};
    for (let gi = 0; gi < appList.length; gi++) {
      const g = appList[gi];
      await checkpoint(`一级标签 ${g.gameName}`);
      prog('game', `level1|${g.gameId}|${g.gameName}|${gi + 1}|${appList.length}`);
      try {
        const r = await statQuery({ gameIds: [g.gameId], statsType: 7, tagLevel: 1 }, { tab: '标签' });
        const rows = r.json.data.statsList || [];
        const sum = rows.find((s) => s.level1Tag === 'Sum');
        l1ByGame[g.gameId] = { gameName: g.gameName, sum: sum ? sum.produceNum : null, rows, tagTree: r.json.data.internationalTagList || [] };
        log(`  ${g.gameName.padEnd(22)} 一级Sum=${sum ? sum.produceNum : '?'}`);
        prog('done', `level1|${g.gameId}|${g.gameName}|${sum ? sum.produceNum : ''}`);
      } catch (e) {
        if (e instanceof StopRequested) throw e;
        log(`  [!] ${g.gameName}（一级）：${e.message}`);
        prog('error', `level1|${g.gameId}|${g.gameName}|${e.message}`);
      }
    }

    // ───────── 4) 二级标签 ─────────
    log('\n[4/4] 统计页 -> 二级标签（逐游戏）…');
    prog('step', '4/4 二级标签');
    await clickText('二级标签');
    await sleep(2000);
    const l2ByGame = {};
    for (let gi = 0; gi < appList.length; gi++) {
      const g = appList[gi];
      await checkpoint(`二级标签 ${g.gameName}`);
      prog('game', `level2|${g.gameId}|${g.gameName}|${gi + 1}|${appList.length}`);
      try {
        const r = await statQuery({ gameIds: [g.gameId], statsType: 7, tagLevel: 2 }, { tab: '标签' });
        const rows = r.json.data.statsList || [];
        const sum = rows.find((s) => s.level2Tag === 'Sum');
        l2ByGame[g.gameId] = { gameName: g.gameName, sum: sum ? sum.produceNum : null, rows, tagTree: r.json.data.internationalTagList || [] };
        log(`  ${g.gameName.padEnd(22)} 二级Sum=${sum ? sum.produceNum : '?'}`);
        prog('done', `level2|${g.gameId}|${g.gameName}|${sum ? sum.produceNum : ''}`);
      } catch (e) {
        if (e instanceof StopRequested) throw e;
        log(`  [!] ${g.gameName}（二级）：${e.message}`);
        prog('error', `level2|${g.gameId}|${g.gameName}|${e.message}`);
      }
      await clickText('一级标签');
      await sleep(600);
      await clickText('二级标签');
      await sleep(800);
    }

    // ───────── 存档 ─────────
    await fs.mkdir(path.dirname(outBase), { recursive: true });
    const payload = {
      period: { start, end, label },
      collectedAt: new Date().toISOString(),
      collector: 'collectCore.mjs',
      formula: { invalid: '无标签客诉 + 带「无效来访」标签的客诉', valid: '总客诉 − 无效客诉' },
      appList,
      appView: { statsList: appRows, request: appRes.req },
      ticketsByGame: counts,
      ticketDetails,
      tagLevel1ByGame: l1ByGame,
      tagLevel2ByGame: l2ByGame,
    };
    await fs.writeFile(`${outBase}.json`, JSON.stringify(payload), 'utf8');

    let tv = 0,
      ti = 0;
    const summaryRows = [];
    for (const g of appList) {
      const c = counts[g.gameId];
      if (!c) continue;
      tv += c.valid;
      ti += c.invalid;
      summaryRows.push({ gameId: g.gameId, gameName: g.gameName, total: c.total, valid: c.valid, invalid: c.invalid, ok: c.valid + c.invalid === c.total });
      log(`  ${g.gameName.padEnd(22)} ${String(c.total).padStart(4)} = ${String(c.valid).padStart(4)} 有效 + ${String(c.invalid).padStart(3)} 无效`);
    }
    log(`  ${'合计'.padEnd(22)} ${String(tv + ti).padStart(4)} = ${String(tv).padStart(4)} 有效 + ${String(ti).padStart(3)} 无效`);
    prog('summary', JSON.stringify({ games: summaryRows.length, totalValid: tv, totalInvalid: ti, rows: summaryRows }));

    return { outFile: `${outBase}.json`, appList, counts, summary: { games: summaryRows.length, totalValid: tv, totalInvalid: ti, rows: summaryRows } };
  } finally {
    await cleanup();
    try {
      conn.close();
    } catch {}
  }
}
