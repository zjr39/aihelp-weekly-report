// 用 LLM 把玩家對話濃縮成一句中文摘要
//
// 為什麼要摘要而不是直接貼原文：
//   同一標籤下常有 6～30 筆客訴，原文長短不一、語言各異（日／韓／泰／英／中），
//   週報需要的是「玩家主要在問什麼」的一句話，不是逐筆列出。
//
// 一次呼叫處理一個遊戲（該遊戲所有標籤），減少 API 呼叫次數與費用。
import { chat, parseJsonLoose } from './llm.mjs';

const MAX_MSG_CHARS = 120; // 單則訊息截斷長度
const MAX_TOTAL_CHARS = 6000; // 每個標籤送出的總字數上限
const MAX_MSGS_PER_TAG = 20; // 每個標籤最多送幾則
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
  const picked = formatMessages(messages).slice(0, 2);
  if (!picked.length) return count ? `（${count} 筆，无可用对话内容）` : '';
  const quoted = picked.map((t) => `「${t.replace(/…$/, '')}」`).join('');
  return `玩家反映${quoted}等${count ? `（${count} 筆）` : ''}`;
}

const SYSTEM_PROMPT = `你是客服数据分析助手，负责把玩家原始讯息浓缩成简体中文的一句话摘要。

规则：
1. 每个标签写一句摘要，说明「玩家主要在询问／反映什么」。
2. 长度 15～35 个汉字，不要引号，不要句号结尾。
3. 不要写「玩家」这个词开头，直接写主题内容（例如「询问副本通关条件与角色培养」）。
4. 玩家讯息可能是日语、韩语、泰语、英语或中文，请一律输出简体中文。
5. 如果讯息内容杂乱无法归纳，就写最突出的那个主题。
6. 只输出 JSON 数组，不要任何解释或其他文字。`;

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

请输出 JSON 数组，每项形如 {"tag":"标签名","summary":"一句摘要"}，标签名必须与上面完全一致，共 ${prepared.length} 项。`;

    let ok = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
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
          maxTokens: 60 * prepared.length + 200,
          timeoutMs: 120000,
        });

        const parsed = parseJsonLoose(reply);
        const arr = Array.isArray(parsed) ? parsed : parsed.items || parsed.data || [];
        let filled = 0;
        for (const item of arr) {
          const tag = String(item && (item.tag || item.label || item.name) || '').trim();
          const sum = String(item && (item.summary || item.text || item.desc) || '').trim();
          if (!tag || !sum) continue;
          // 標籤名可能被模型微調（空白差異），做寬鬆比對
          const match = prepared.find((p) => p.tag === tag) || prepared.find((p) => p.tag.replace(/\s/g, '') === tag.replace(/\s/g, ''));
          if (!match) continue;
          result[g.gameName][match.tag] = sum.replace(/^["「『]|["」』]$/g, '').replace(/[。.]$/, '');
          filled++;
        }
        if (filled > 0) {
          log(`  ${g.gameName}：${filled}/${prepared.length} 个标签已摘要（${gameIdx}/${usable.length}）`);
          ok = true;
          break;
        }
        log(`  [!] ${g.gameName}：模型回覆无法对应标签（第 ${attempt} 次）`);
      } catch (e) {
        log(`  [!] ${g.gameName}：摘要失败（第 ${attempt} 次）——${e.message}`);
        if (attempt === 2) break;
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
