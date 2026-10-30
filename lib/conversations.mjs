// 抓取客訴的實際對話內容
//
// 為什麼要這樣做：
//   客訴列表 API 只給標題（例如「[10]遊戲問題（含誤操作申請提交）」），
//   資訊量不足，沒辦法判斷玩家到底在問什麼。真正的內容在對話裡。
//
// 為什麼不自己組 HTTP 請求：
//   AIHelp 網關的簽章綁定「請求參數」。實測把 ticketId 換成另一個值重放，
//   直接 403。所以必須讓頁面自己發請求 —— 呼叫頁面元件的
//   $api.chat.queryMessagePagination()，簽章由頁面的 axios 攔截器產生。
//
// 對應的實際請求：
//   GET /console/api/chat/message/page?ticketId=...&requestGameId=...&limit=100&scrollingDirection=up
//   回應：{ data: { contentList: [{ message, customerType, trueName, timeStamp }] } }
//   customerType: 3 = 玩家、0 = 客服

/** 從訊息陣列抽出玩家／客服的發言 */
/**
 * 从各种形态的 message 取出文字。
 *
 * AIHelp 的 message 可能是字串，也可能是物件：
 *   messageType 2（图片）：{ attachments: [{url,...}], reply: '图片附带的文字' }
 *   messageType 9（评价）：{ is_default, star_index, time }  → 没有文字，跳过
 */
function textOf(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    // 图片讯息里 reply 是客服打的字，最有价值
    if (typeof raw.reply === 'string' && raw.reply.trim()) return raw.reply;
    if (typeof raw.text === 'string' && raw.text.trim()) return raw.text;
    if (typeof raw.content === 'string' && raw.content.trim()) return raw.content;
    return ''; // 纯附件、评价等，没有可读文字
  }
  return String(raw);
}

/**
 * 从讯息阵列抽出玩家／客服的发言。
 *
 * 注意栏位名称：页面内为了缩小传输量，把讯息缩写成 { m, c, t }：
 *   m = message      文字内容（可能是字串，也可能是物件）
 *   c = customerType 3 = 玩家、0 = 客服、1 = 系统
 *   t = timeStamp
 * 这里必须用缩写的键读取 —— 曾经写成 m.message 导致全部读到 undefined，
 * 结果 95 笔客诉的对话全是空的（摘要退化成只看标题）。
 */
function splitMessages(list) {
  const player = [];
  const agent = [];
  for (const m of list || []) {
    const isObj = m && typeof m === 'object';
    const raw = isObj ? (m.m !== undefined ? m.m : m.message) : m;
    const text = textOf(raw)
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    // 图片／语音等非文字讯息是占位符，跳过
    if (/^\[(圖片|图片|语音|語音|檔案|文件|视频|影片)\]$/i.test(text)) continue;
    const ct = Number(isObj ? (m.c !== undefined ? m.c : m.customerType) : NaN);
    const ts = Number(isObj ? (m.t !== undefined ? m.t : m.timeStamp) : 0) || 0;
    if (ct === 3) player.push({ text, ts });
    else if (ct === 0) agent.push({ text, ts });
    // customerType 1 是系统自动讯息（「感谢您的回馈…」），不计入
  }
  return { player, agent };
}

/**
 * 批次取得對話。
 *
 * @param {object}   opts
 * @param {Function} opts.ev         頁面 evaluate 函式（lib/cdp.mjs 的 makeEval）
 * @param {Array}    opts.tickets    [{ ticketId, gameId }]
 * @param {number}   opts.batchSize  每批同時抓幾筆（預設 4，太高會被限流）
 * @param {Function} opts.onProgress (done, total) => void
 * @param {Function} opts.shouldStop () => Promise<boolean>
 * @returns {Promise<Object>} ticketId -> { player: [...], agent: [...] }
 */
export async function fetchConversations({ ev, tickets, batchSize = 4, onProgress = () => {}, shouldStop = async () => false, log = () => {} } = {}) {
  const out = {};
  const list = (tickets || []).filter((t) => t && t.ticketId);
  if (!list.length) return out;

  let done = 0;
  let failed = 0;

  for (let i = 0; i < list.length; i += batchSize) {
    if (await shouldStop()) break;
    const batch = list.slice(i, i + batchSize);

    // 一次 evaluate 抓一整批（在頁面內並行，減少往返）
    let res;
    try {
      const raw = await ev(
        `
(async () => {
  // 找客訴列表頁的 NewChats 元件（$api 掛在它身上）
  let nc = null;
  for (const el of document.querySelectorAll('*')) {
    const v = el.__vue__;
    if (v && v.$options && v.$options.name === 'NewChats' && v.$api && v.$api.chat) { nc = v; break; }
  }
  if (!nc) return JSON.stringify({ ok: false, why: '找不到 NewChats 组件（请确认在客诉列表页）' });

  const items = ${JSON.stringify(batch)};
  const results = await Promise.all(items.map(async (t) => {
    try {
      const r = await nc.$api.chat.queryMessagePagination({
        ticketId: t.ticketId,
        requestGameId: t.gameId || nc.ticketGameId,
        limit: 100,
        scrollingDirection: 'up',
      });
      if (!r || r.flag === false) {
        return { ticketId: t.ticketId, error: 'API ' + (r && r.code) + ' ' + String((r && r.desc) || '').slice(0, 80) };
      }
      const list = (r.data && r.data.contentList) || [];
      return {
        ticketId: t.ticketId,
        msgs: list.map((m) => ({ m: m.message == null ? '' : m.message, c: Number(m.customerType), t: Number(m.timeStamp) || 0 })),
      };
    } catch (e) {
      return { ticketId: t.ticketId, error: String((e && e.message) || e).slice(0, 120) };
    }
  }));
  return JSON.stringify({ ok: true, results });
})()
`,
        { timeout: 90000 },
      );
      res = JSON.parse(raw);
    } catch (e) {
      failed += batch.length;
      log(`  [!] 取对话失败（批次 ${Math.floor(i / batchSize) + 1}）：${e.message}`);
      continue;
    }

    if (!res.ok) {
      // 元件找不到是致命问题（管线错误），直接抛出
      throw new Error(res.why || '无法取得对话');
    }

    for (const r of res.results || []) {
      if (r.error) {
        failed++;
        out[r.ticketId] = { player: [], agent: [], error: r.error };
      } else {
        const parsed = splitMessages(r.msgs);
        parsed.rawCount = Array.isArray(r.msgs) ? r.msgs.length : 0;
        out[r.ticketId] = parsed;
      }
    }

    done += batch.length;
    onProgress(done, list.length);
  }

  if (failed) log(`  [!] 有 ${failed} 笔客诉取不到对话，摘要时会略过`);

  // 健全性检查：API 说成功、但一笔发言都没解析出来，几乎一定是解析 bug。
  // 这种情况宁可大声警告，也不要让摘要静静退化成只看标题。
  const totalRaw = Object.values(out).reduce((a, c) => a + (c.rawCount || 0), 0);
  const totalPlayer = Object.values(out).reduce((a, c) => a + ((c.player && c.player.length) || 0), 0);
  if (totalRaw > 0 && totalPlayer === 0) {
    log(`  [!] 警告：收到 ${totalRaw} 则讯息，却解析不出任何玩家发言 —— 可能是解析逻辑错误`);
  } else if (totalRaw === 0) {
    log(`  [!] 警告：整批都没有收到任何讯息，摘要会退回使用客诉标题`);
  }
  return out;
}
