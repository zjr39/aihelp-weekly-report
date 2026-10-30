// 用 LLM 把玩家對話濃縮成一句中文摘要
//
// 為什麼要摘要而不是直接貼原文：
//   同一標籤下常有 6～30 筆客訴，原文長短不一、語言各異（日／韓／泰／英／中），
//   週報需要的是「玩家主要在問什麼」的一句話，不是逐筆列出。
//
// 一次呼叫處理一個遊戲（該遊戲所有標籤），減少 API 呼叫次數與費用。
import { chat, parseJsonLoose } from './llm.mjs';

const MAX_MSG_CHARS = 200; // 單則訊息截斷長度（表單類訊息較長，留寬一點才看得到細節）
const MAX_TOTAL_CHARS = 9000; // 每個標籤送出的總字數上限
const MAX_MSGS_PER_TAG = 25; // 每個標籤最多送幾則
const MIN_MSG_CHARS = 2; // 太短沒資訊量（但要放寬，玩家常只打「帳號」「儲值」）

/** 把訊息清單整理成送給模型的文字（去重、截斷、控制長度） */
function formatMessages(messages) {
  const cleaned = [];
  for (const raw of messages) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (t) cleaned.push(t);
  }
  if (!cleaned.length) return [];

  // 先做一次嚴格過濾；如果全被濾掉，就放寬到只看「非空」
  const pick = (minLen) => {
    const seen = new Set();
    const out = [];
    let total = 0;
    for (const t of cleaned) {
      if (t.length < minLen) continue;
      const key = t.slice(0, 40).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const v = t.length > MAX_MSG_CHARS ? t.slice(0, MAX_MSG_CHARS) + '…' : t;
      if (total + v.length > MAX_TOTAL_CHARS) break;
      out.push(v);
      total += v.length;
      if (out.length >= MAX_MSGS_PER_TAG) break;
    }
    return out;
  };

  let picked = pick(MIN_MSG_CHARS);
  if (!picked.length) picked = pick(0);
  return picked;
}

/** 規則式備援：模型不可用時，至少給出代表性原話 */
export function fallbackSummary(messages, count) {
  const picked = formatMessages(messages).slice(0, count && count <= 1 ? 1 : 2);
  if (!picked.length) return count ? `（${count} 筆，无可用对话内容）` : '';
  const quoted = picked.map((t) => `「${t.replace(/…$/, '')}」`).join('');
  // 只有一笔时不要写「等」
  const suffix = !count || count <= 1 ? '' : `等（${count} 筆）`;
  return sanitizeSummary(`玩家反映${quoted}${suffix}`);
}

const MAX_SUMMARY_CHARS = 64;

/**
 * 摘要後處理：
 *   1. 移除個人資料（電話／郵箱／長串數字 ID）——這些絕不該出現在週報裡
 *   2. 過長就截到最後一個完整子句
 *
 * 個人資料是「整段子句丟掉」，不是只刪數字 —— 否則會留下
 * 「留電話 ；」「邮箱 收不到验证码」這種殘句。
 */
export function sanitizeSummary(text) {
  let s = String(text || '').trim();
  if (!s) return '';

  const PII = [
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, // email
    /\+?\d[\d\s()-]{7,}\d/, // 電話
    /\b[0-9a-f]{16,}\b/i, // UID / 長 hash
    /\b\d{6,}\b/, // 6 位以上純數字（角色 ID、訂單號）
  ];
  const hasPII = (x) => PII.some((re) => re.test(x));

  // 依標點切成子句（保留分隔符），含個資的子句整段丟掉
  const parts = s.split(/([；;，,、])/);
  const kept = [];
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i];
    const sep = parts[i + 1] || '';
    if (!clause) continue;
    if (hasPII(clause)) continue;
    kept.push(clause.trim() + (sep === ';' ? '；' : sep === '、' ? '、' : sep === ',' ? '，' : sep === '，' ? '，' : sep === '；' ? '；' : ''));
  }

  let out = kept
    .join('')
    .replace(/[；;、，,]\s*(?=[；;、，,])/g, '')
    .replace(/^[\s；;、，,。.]+|[\s；;、，,]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 整段丟掉會讓摘要短到沒意義（例如只剩「忘记密码」）→
  // 退回「只把個資換成佔位符」的版本，保留句子結構
  if (out.length < 8) {
    out = s;
    for (const re of PII) out = out.replace(new RegExp(re.source, 'g'), '某帳號');
    out = out
      .replace(/[；;、，,]\s*(?=[；;、，,])/g, '')
      .replace(/^\s*[；;、，,]+\s*|\s*[；;、，,]+\s*$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // 英數混合的角色名（例如 Arka17）——模型不該抄，這裡兜底
  out = out.replace(/\b[A-Za-z]{3,}\d{1,6}\b/g, '某角色');

  if (!out) return '';

  // ── 長度：截到最後一個完整子句 ──
  if (out.length > MAX_SUMMARY_CHARS) {
    const cut = out.slice(0, MAX_SUMMARY_CHARS);
    const lastBreak = Math.max(cut.lastIndexOf('；'), cut.lastIndexOf('，'), cut.lastIndexOf('、'));
    out = (lastBreak >= 20 ? cut.slice(0, lastBreak) : cut).replace(/[\s；;、，,]+$/, '') + '…';
  }

  return out;
}

const SYSTEM_PROMPT = `你是客服数据分析助手，负责把玩家原始讯息浓缩成简体中文的摘要。

【最重要】必须写出「具体的」内容：
- 什么功能、什么道具、什么活动、什么 bug 现象、什么具体诉求
- 绝对不要写「反映游戏建议」「有问题」「咨询游戏内容」「反馈异常」这种空泛说法
- 保留原文出现的专有名词（道具名、活动名、功能名、货币名、NPC 名、等级数）

规则：
1. 一个标签写一句摘要，说清楚玩家具体在问什么、反映什么问题。
2. 一个标签里有多个不同主题时，用「；」分隔，每项都要具体（最多 3 项）。
3. 长度 20～60 个汉字，不要引号，结尾不加句号。
4. 不要用「玩家」开头，直接写内容。
5. **绝对不要写个人资料**：电话、邮箱、账号 ID、角色 ID、UID、身份証号、
   玩家暱称一律略过。要提角色就说「某玩家的角色」，不要抄名字或数字。
6. 不要写具体日期、时间戳、订单号等流水号。
7. 玩家讯息可能是日语、韩语、泰语、英语或**繁体中文**，一律输出**简体中文**。
   即使原文是繁体（例如「儲值」「帳號」「異常」），也要写成简体（储值、账号、异常）。
8. 只输出 JSON 数组，不要任何解释或其他文字。`;

// 给模型一个明确的范例，比单纯描述规则有效得多
const EXAMPLE = [
  {
    tag: '系统、玩法建议',
    summary: '反馈武器天赋升级太繁琐、关卡雷电伤害过强；询问能否转服并折算代金券',
  },
  {
    tag: '异常反馈',
    summary: '反映试炼之塔 800 层神迹宝箱显示已领取却没收到；副本进入后黑屏闪退',
  },
].map((x) => JSON.stringify(x)).join('\n');

/**
 * 标签名正規化，用來比對「模型回的標籤」與「我們送的標籤」。
 *
 * 為什麼需要：我們要求模型一律輸出簡體中文，它連**標籤名**也一起簡化了 ——
 * 送出去的是「內容/玩法咨詢」，回來的變成「内容/玩法咨询」，逐字比對就對不上。
 * 這裡做繁簡 + 空白 + 全半角斜線的正規化，兩邊都套用。
 */
const TAG_T2S = {
  遊: '游', 戲: '戏', 問: '问', 題: '题', 儲: '储', 賬: '账', 帳: '账', 號: '号',
  議: '议', 禮: '礼', 碼: '码', 詢: '询', 評: '评', 無: '无', 來: '来', 訪: '访',
  內: '内', 異: '异', 饋: '馈', 補: '补', 統: '统', 綁: '绑', 刪: '删', 級: '级',
  誤: '误', 請: '请', 啟: '启', 動: '动', 閃: '闪', 優: '优', 養: '养', 圖: '图',
  資: '资', 訊: '讯', 連: '连', 線: '线', 務: '务', 應: '应', 該: '该', 為: '为',
  與: '与', 這: '这', 個: '个', 們: '们', 時: '时', 實: '实', 現: '现', 發: '发',
  過: '过', 還: '还', 將: '将', 從: '从', 對: '对', 經: '经', 見: '见', 續: '续',
  讓: '让', 於: '于', 麼: '么', 樣: '样', 聯: '联', 繫: '系', 電: '电', 話: '话',
  層: '层', 寵: '宠', 數: '数', 辦: '办', 轉: '转', 職: '职', 業: '业', 獎: '奖',
  勵: '励', 領: '领', 購: '购', 買: '买', 賣: '卖', 價: '价', 錢: '钱', 鑽: '钻',
  賽: '赛', 機: '机', 進: '进', 選: '选', 擇: '择', 裝: '装', 備: '备', 壞: '坏',
  顯: '显', 傳: '传', 戰: '战', 鬥: '斗', 勝: '胜', 敗: '败', 輸: '输', 贏: '赢',
  氣: '气', 場: '场', 區: '区', 隊: '队', 組: '组', 頻: '频', 幫: '帮', 會: '会',
  團: '团', 敵: '敌', 軍: '军', 陣: '阵', 營: '营', 牆: '墙', 擊: '击', 殺: '杀',
  傷: '伤', 藥: '药', 費: '费', 額: '额', 滿: '满', 夠: '够', 沒: '没', 種: '种',
  類: '类', 項: '项', 條: '条', 書: '书', 單: '单', 張: '张', 鐘: '钟', 間: '间',
  週: '周', 曆: '历', 歲: '岁', 齡: '龄', 嗎: '吗', 喲: '哟', 囉: '啰',
};

function normTag(s) {
  return [...String(s || '')]
    .map((c) => TAG_T2S[c] || c)
    .join('')
    .replace(/[／]/g, '/')
    .replace(/[\s\u3000]/g, '')
    .toLowerCase();
}

/**
 * @param {object} opts
 * @param {Array}  opts.groups   [{ gameName, items: [{ tag, messages: string[], count }] }]
 * @param {object} opts.llm      { baseUrl, apiKey, model }
 * @param {Function} opts.log
 * @returns {Promise<Object>} { [gameName]: { [tag]: summary } }
 */
export async function summarizeGroups({ groups, llm, log = () => {} } = {}) {
  const result = {};
  const usable = (groups || []).filter((g) => g && g.items && g.items.length);
  if (!usable.length) return result;

  let gameIdx = 0;
  for (const g of usable) {
    gameIdx++;
    // 每個標籤整理出要送出的訊息
    const prepared = g.items
      .map((it) => ({ tag: it.tag, msgs: formatMessages(it.messages), count: it.count || (it.messages || []).length }))
      .filter((it) => it.msgs.length);

    result[g.gameName] = {};
    if (!prepared.length) {
      log(`  ${g.gameName}：没有可用对话，跳过摘要`);
      continue;
    }

    // 组装提示
    const blocks = prepared.map((p) => `标签「${p.tag}」（${p.count} 笔）的玩家讯息：\n${p.msgs.map((m) => '- ' + m).join('\n')}`).join('\n\n');

    const userMsg = `${blocks}

输出格式范例（照这个详细程度写）：
${EXAMPLE}

请输出 JSON 数组，每项形如 {"tag":"标签名","summary":"一句摘要"}，标签名必须与上面完全一致，共 ${prepared.length} 项。
每个 summary 都要写到「具体是什么」，不要只写类别。`;

    let ok = false;
    let lastReply = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const reply = await chat({
          baseUrl: llm.baseUrl,
          apiKey: llm.apiKey,
          model: llm.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMsg },
          ],
          temperature: 0.2,
          // 推理模型（deepseek-flash / deepseek-v4-pro）会先输出思考过程，
          // max_tokens 太小会导致 content 为空或不完整。
          // lib/llm.mjs 内建截断自动加倍重试，这里给一个够大的起始值即可。
          maxTokens: Math.max(4096, 240 * prepared.length + 1024),
          timeoutMs: 240000,
        });

        const parsed = parseJsonLoose(reply);
        // 模型有时只回「单个物件」而不是阵列（只有一个标签时特别常见），
        // 要包成阵列，否则会被当成空的丢掉、白白重试。
        const arr = Array.isArray(parsed)
          ? parsed
          : parsed && (parsed.tag || parsed.summary)
            ? [parsed]
            : parsed?.items || parsed?.data || [];
        // 除錯用：把模型這次的原始回覆留著，失敗時打在日志里
        lastReply = String(reply).slice(0, 300);
        let filled = 0;
        for (const item of arr) {
          const tag = String(item && (item.tag || item.label || item.name) || '').trim();
          const sum = String(item && (item.summary || item.text || item.desc) || '').trim();
          if (!tag || !sum) continue;
          // 標籤名可能被模型微調（繁簡、空白差異），用正規化後的比對
          const match =
            prepared.find((p) => p.tag === tag) ||
            prepared.find((p) => normTag(p.tag) === normTag(tag));
          if (!match) continue;
          result[g.gameName][match.tag] = sanitizeSummary(sum.replace(/^["「『]|["」』]$/g, '').replace(/[。.]$/, ''));
          filled++;
        }
        // 只有「全部都摘要到」才算完成；有漏的會再试一次补齐
        const total = prepared.filter((p) => result[g.gameName][p.tag]).length;
        if (total >= prepared.length) {
          log(`  ${g.gameName}：${total}/${prepared.length} 个标签已摘要（${gameIdx}/${usable.length}）`);
          ok = true;
          break;
        }
        if (total > 0) {
          log(`  [!] ${g.gameName}：${total}/${prepared.length} 个标签成功，重试补齐剩餘（第 ${attempt} 次）`);
          ok = true;
          continue;
        }
        log(`  [!] ${g.gameName}：模型回覆无法对应标签（第 ${attempt} 次）${lastReply ? '｜模型说：' + lastReply.replace(/\s+/g, ' ').slice(0, 160) : ''}`);
      } catch (e) {
        log(`  [!] ${g.gameName}：摘要失败（第 ${attempt} 次）——${e.message}`);
        if (attempt === 3) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    // 备援：模型失败时，没摘要到的标签给代表性原话
    if (!ok || Object.keys(result[g.gameName]).length < prepared.length) {
      for (const p of prepared) {
        if (!result[g.gameName][p.tag]) {
          result[g.gameName][p.tag] = fallbackSummary(p.msgs, p.count);
        }
      }
      if (!ok) log(`  ${g.gameName}：改用代表性原话作为摘要`);
    }
  }

  return result;
}
