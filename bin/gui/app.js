'use strict';

const $ = (id) => document.getElementById(id);
const PHASE_TEXT = {
  idle: ['待机中', ''],
  running: ['采集中…', 'run'],
  paused: ['已暂停（按「继续」恢复）', 'pause'],
  done: ['全部采集成功，无错误', 'ok'],
  error: ['完成，但有错误', 'err'],
  stopped: ['已终止', 'err'],
};

// ── 日期：统计周期为「上周五 ~ 本周四」 ──
function todayISO(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return fmt(d);
}
function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** 回传包含「含今天在内、最近一次星期四」的那个周期（周五 → 周四） */
function periodOf(offsetWeeks = 0) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  // 找最近的星期四（含今天）；周日~周四都算「本周的周四」
  const day = now.getDay(); // 0=Sun ... 5=Fri, 4=Thu
  let backToThu = (day - 4 + 7) % 7;
  const thu = new Date(now);
  thu.setDate(thu.getDate() - backToThu + offsetWeeks * 7);
  const fri = new Date(thu);
  fri.setDate(fri.getDate() - 6);
  return { start: fmt(fri), end: fmt(thu) };
}

function applyPeriod(offsetWeeks) {
  const p = periodOf(offsetWeeks);
  $('startDate').value = p.start;
  $('endDate').value = p.end;
}
applyPeriod(0);

document.querySelectorAll('[data-quick]').forEach((btn) => {
  btn.addEventListener('click', () => applyPeriod(btn.dataset.quick === 'last' ? -1 : 0));
});

// ── 与伺服器的连线狀态 ──
let serverAlive = true;
function setOffline(off) {
  if (serverAlive === !off) return;
  serverAlive = !off;
  $('offline').hidden = !off;
  if (off) {
    const el = $('statusLine');
    el.textContent = '已与后台服务断开连接';
    el.className = 'status err';
  }
}

let lastState = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderGames(games) {
  const body = $('gameBody');
  if (!games || !games.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">尚未开始</td></tr>';
    return;
  }
  body.innerHTML = games
    .map((g) => {
      const cell = (stage) => {
        const s = g[stage];
        if (!s) return '<span class="badge wait">等待</span>';
        if (s.status === 'running') return '<span class="badge run">进行中</span>';
        if (s.status === 'error') return `<span class="badge error" title="${escapeHtml(s.error || '')}">失败</span>`;
        if (stage === 'tickets') return `<span class="badge done">${s.total} 笔</span>`;
        return `<span class="badge done">${s.sum === null || s.sum === undefined ? '—' : s.sum}</span>`;
      };
      const t = g.tickets || {};
      const validPct = t.total ? Math.round((t.valid / t.total) * 1000) / 10 : null;
      return `<tr>
        <td>${escapeHtml(g.name)}</td>
        <td class="num">${cell('tickets')}</td>
        <td class="num">${cell('level1')}</td>
        <td class="num">${cell('level2')}</td>
        <td class="num"><b>${t.total ?? ''}</b></td>
        <td class="num" style="color:#12805c"><b>${t.valid ?? ''}</b>${validPct !== null ? `<div class="muted small">${validPct}%</div>` : ''}</td>
        <td class="num" style="color:#c0392b"><b>${t.invalid ?? ''}</b></td>
      </tr>`;
    })
    .join('');
}

function render(s) {
  lastState = s;
  setOffline(false);
  const [text, cls] = PHASE_TEXT[s.phase] || ['', ''];
  const statusEl = $('statusLine');
  statusEl.textContent = text + (s.error ? `：${s.error}` : '');
  statusEl.className = 'status ' + cls;

  $('stepLabel').textContent = s.step ? '当前步骤：' + s.step : '尚未开始';
  const tf = $('timeFilterLabel');
  if (tf) tf.textContent = s.timeFilter === 'metric' ? '指标发生时间' : '客诉创建时间';
  const totalGames = s.games ? s.games.length : 0;
  const finished = s.games ? s.games.filter((g) => g.tickets && g.tickets.status === 'done').length : 0;
  $('progressText').textContent = totalGames ? `${finished} / ${totalGames} 个游戏` : '0 / 0';
  $('barFill').style.width = totalGames ? `${Math.round((finished / totalGames) * 100)}%` : '0%';

  renderGames(s.games);

  const busy = s.phase === 'running' || s.phase === 'paused';
  $('btnStart').disabled = busy;
  $('btnPause').disabled = s.phase !== 'running';
  $('btnPause').textContent = s.phase === 'paused' ? '▶ 继续' : '⏸ 暂停';
  $('btnPause').onclick = s.phase === 'paused' ? doResume : doPause;
  $('btnStop').disabled = !busy;

  if (Array.isArray(s.log) && s.log.length && $('log').childElementCount === 0) {
    $('log').textContent = s.log.join('\n');
    if ($('autoScroll').checked) $('log').scrollTop = $('log').scrollHeight;
  }

  const done = ['done', 'error', 'stopped'].includes(s.phase);
  $('resultCard').hidden = !done;
  if (done) {
    const rows = s.games || [];
    const sumValid = rows.reduce((a, g) => a + (g.tickets?.valid || 0), 0);
    const sumInvalid = rows.reduce((a, g) => a + (g.tickets?.invalid || 0), 0);
    const failed = rows.filter((g) => !g.tickets || g.tickets.status !== 'done');
    const headline =
      s.phase === 'done'
        ? '<div class="result-ok">✅ 全部采集成功，无错误</div>'
        : s.phase === 'stopped'
          ? '<div class="result-err">⏹ 已终止（数据不完整）</div>'
          : failed.length
            ? `<div class="result-err">⚠️ 完成，但有 ${failed.length} 个游戏未成功：${failed.map((g) => escapeHtml(g.name)).join('、')}</div>`
            : `<div class="result-err">⚠️ 未能完成：${escapeHtml(s.error || '未知错误')}</div>`;
    $('resultBody').innerHTML = `${headline}
      <div class="kv">
        <div>统计区间<br><b>${s.start || ''} ~ ${s.end || ''}</b></div>
        <div>游戏数<br><b>${rows.length}</b></div>
        <div>有效客诉合计<br><b style="color:#12805c">${sumValid}</b></div>
        <div>无效客诉合计<br><b style="color:#c0392b">${sumInvalid}</b></div>
      </div>
      ${s.files && s.files.xlsx ? `<div class="muted small" style="margin-top:10px">报表文件：${escapeHtml(s.files.xlsx)}</div>` : ''}`;
    $('downloadRow').hidden = !(s.files && s.files.xlsx);
  }
}

function renderChrome(info) {
  const el = $('chromeStatus');
  el.textContent = info.message;
  el.className = 'chip ' + (info.ok ? 'chip-ok' : info.reason === 'login' ? 'chip-warn' : 'chip-err');
}

// ── SSE ──
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => render(JSON.parse(e.data)));
  es.addEventListener('finished', (e) => render(JSON.parse(e.data)));
  es.addEventListener('log', (e) => {
    const line = JSON.parse(e.data);
    const log = $('log');
    log.textContent += (log.textContent ? '\n' : '') + line;
    if ($('autoScroll').checked) log.scrollTop = log.scrollHeight;
  });
  es.onopen = () => setOffline(false);
  es.onerror = () => {
    es.close();
    setOffline(true);
    setTimeout(connect, 3000);
  };
}
connect();

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || j.message || `HTTP ${res.status}`);
  return j;
}

async function doStart() {
  $('btnStart').disabled = true;
  try {
    await api('/api/start', { start: $('startDate').value, end: $('endDate').value });
  } catch (e) {
    alert('无法开始：' + e.message);
    $('btnStart').disabled = false;
  }
}
async function doPause() {
  try {
    await api('/api/pause');
  } catch (e) {
    alert(e.message);
  }
}
async function doResume() {
  try {
    await api('/api/resume');
  } catch (e) {
    alert(e.message);
  }
}
async function doStop() {
  if (!confirm('确定要终止采集吗？已抓到的数据会保留，但报表不会产生。')) return;
  try {
    await api('/api/stop');
  } catch (e) {
    alert(e.message);
  }
}
async function doLaunchChrome() {
  const btn = $('btnChrome');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '处理中…';
  try {
    const r = await api('/api/launch-chrome', {});
    btn.textContent = old;
    setTimeout(checkChrome, 800);
  } catch (e) {
    alert(e.message);
    btn.textContent = old;
  } finally {
    btn.disabled = false;
  }
}

async function doQuit() {
  if (!confirm('确定要关闭工具吗？\n\n关闭后这个页面会失效，需要重新双击桌面的「客诉周报工具」图示才能再使用。')) return;
  // 采集进行中要特别提醒
  const busy = lastState && (lastState.phase === 'running' || lastState.phase === 'paused');
  if (busy && !confirm('⚠️ 目前正在采集，关闭会中断这次采集（已抓到的原始数据会保留）。\n\n确定要关闭吗？')) return;
  const btn = $('btnQuit');
  btn.disabled = true;
  btn.textContent = '关闭中…';
  try {
    await api('/api/shutdown', {});
    document.body.innerHTML =
      '<div style="display:flex;height:100vh;align-items:center;justify-content:center;' +
      'font-family:\'Microsoft YaHei\',sans-serif;color:#39527d;text-align:center;line-height:2">' +
      '<div><div style="font-size:44px">✅</div><h2 style="margin:12px 0">工具已关闭</h2>' +
      '<p style="color:#7488a8">这个页面可以关掉了。<br>下次使用请双击桌面的「客诉周报工具」图示。</p></div></div>';
  } catch (e) {
    // 服务已停止时请求会失败，这其实代表关闭成功
    document.body.innerHTML =
      '<div style="display:flex;height:100vh;align-items:center;justify-content:center;' +
      'font-family:\'Microsoft YaHei\',sans-serif;color:#39527d;text-align:center;line-height:2">' +
      '<div><div style="font-size:44px">✅</div><h2 style="margin:12px 0">工具已关闭</h2>' +
      '<p style="color:#7488a8">这个页面可以关掉了。</p></div></div>';
  }
}

$('btnStart').onclick = doStart;
$('btnStop').onclick = doStop;
$('btnChrome').onclick = doLaunchChrome;
$('btnQuit').onclick = doQuit;
$('btnXlsx').onclick = () => (location.href = '/api/download/xlsx');
$('btnTsv').onclick = () => (location.href = '/api/download/tsv');
$('btnRaw').onclick = () => (location.href = '/api/download/raw');

async function checkChrome() {
  try {
    renderChrome(await api('/api/check-chrome'));
    setOffline(false);
  } catch (e) {
    setOffline(true);
  }
}
checkChrome();
setInterval(checkChrome, 30000);
