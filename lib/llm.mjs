// 呼叫 OpenAI 相容的 Chat Completions 介面
//
// 支援任何相容實作：DeepSeek、OpenAI、Azure OpenAI、Ollama、vLLM、One-API…
// 只要在設定裡填「API 位址」＋「API Key」＋「模型名稱」即可。
//
// 位址寫法（都會自動補成 .../chat/completions）：
//   https://api.deepseek.com             → https://api.deepseek.com/chat/completions
//   https://api.deepseek.com/v1          → https://api.deepseek.com/v1/chat/completions
//   https://api.openai.com/v1            → https://api.openai.com/v1/chat/completions
//   http://localhost:11434/v1            → http://localhost:11434/v1/chat/completions

/** 把使用者填的位址正規化成 chat/completions 端點 */
export function completionsUrl(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('尚未设定 API 位址');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (/\/chat\/completions$/i.test(u)) return u;
  return u + '/chat/completions';
}

/**
 * 查詢服務提供哪些模型（GET {base}/models）
 *
 * 各家的模型名稱差很多，而且會随時間改版，所以不要寫死 ——
 * 直接問服務端最準。
 */
export async function listModels({ baseUrl, apiKey, timeoutMs = 20000 }) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('尚未设定 API 位址');
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  const url = base.replace(/\/chat\/completions$/i, '') + '/models';

  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers, signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`取得模型清单逾时：${url}`);
    throw new Error(`连线失败（${url}）：${e.message}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || detail;
    } catch {}
    throw new Error(`HTTP ${res.status}：${detail}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('模型清单不是 JSON：' + text.slice(0, 200));
  }
  const arr = json.data || json.models || (Array.isArray(json) ? json : []);
  const ids = arr
    .map((m) => (typeof m === 'string' ? m : m.id || m.name || m.model))
    .filter(Boolean)
    .map(String)
    .sort();
  return [...new Set(ids)];
}

/**
 * 呼叫模型。
 *
 * 推理模型（deepseek-flash、deepseek-v4-pro 等）会先输出一段思考过程再作答，
 * 思考过程也算 max_tokens。模型越大、问题越複杂，思考就越长，额度不够时
 * content 会是空的（finish_reason = "length"）。
 *
 * 所以这里内建「截断就自动加倍重试」：max_tokens 不够会自动往上翻倍，
 * 使用者不需要自己调。
 *
 * @returns {Promise<string>} 模型回覆的文字內容
 */
export async function chat({ baseUrl, apiKey, model, messages, temperature = 0.2, maxTokens = 2048, timeoutMs = 180000, retries = 2 }) {
  let tokens = maxTokens;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chatOnce({ baseUrl, apiKey, model, messages, temperature, maxTokens: tokens, timeoutMs });
    } catch (e) {
      lastErr = e;
      // 只有「被 max_tokens 截断」才值得加倍重试；其他错误直接抛
      if (e.code !== 'TRUNCATED' || attempt === retries) throw e;
      tokens = Math.min(tokens * 2, 32000);
      if (e.reasoningLen) {
        // 有思考过程，倍加倍得保守一点
        tokens = Math.min(Math.max(tokens, e.reasoningLen * 3), 32000);
      }
    }
  }
  throw lastErr;
}

/** 单次呼叫（不含重试） */
async function chatOnce({ baseUrl, apiKey, model, messages, temperature = 0.2, maxTokens = 2048, timeoutMs = 180000 }) {
  const url = completionsUrl(baseUrl);
  if (!model) throw new Error('尚未设定模型名称');

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`呼叫模型逾时（${Math.round(timeoutMs / 1000)}s）：${url}`);
    throw new Error(`连线失败（${url}）：${e.message}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    // 尽量把服务端给的错误讯息带出来，方便使用者自己排查
    let detail = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || j.msg || detail;
    } catch {}
    const hint =
      res.status === 401
        ? '（API Key 无效或未填）'
        : res.status === 404
          ? '（API 位址或模型名称错误）'
          : res.status === 429
            ? '（额度不足或限流）'
            : '';
    throw new Error(`模型回应 HTTP ${res.status}${hint}：${detail}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`模型回应不是 JSON：${text.slice(0, 200)}`);
  }

  const choice = json.choices?.[0] || {};
  const content = choice.message?.content;
  const reasoning = choice.message?.reasoning_content;
  const finish = choice.finish_reason;

  // finish_reason = "length" 代表输出被 max_tokens 截断 —— 即使 content 有值，
  // 那也是「不完整的」。对 JSON 输出尤其致命（解析会失败或漏项），
  // 所以一律当成需要重试的情况往上抛。
  if (finish === 'length') {
    const err = new Error(
      `模型输出被 max_tokens(${maxTokens}) 截断` +
        (reasoning ? `（思考过程已用掉 ${reasoning.length} 字）` : '') +
        (content ? `，只拿回不完整的 ${content.length} 字` : '，没有留下答案'),
    );
    err.code = 'TRUNCATED';
    err.reasoningLen = reasoning ? reasoning.length : 0;
    err.partial = typeof content === 'string' ? content : '';
    throw err;
  }

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(
      '模型没有回传内容' + (reasoning ? `（只给了思考过程 ${reasoning.length} 字）` : '') + '：' + JSON.stringify(json).slice(0, 200),
    );
  }
  return content.trim();
}

/**
 * 从模型回覆中抽出 JSON（容忍 ```json 围栏、前后多余文字）
 */
export function parseJsonLoose(text) {
  let s = String(text || '').trim();
  // 去掉 markdown 围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch {}
  // 找第一个 [ 或 { 到最后一个 ] 或 }
  const firstArr = s.indexOf('[');
  const firstObj = s.indexOf('{');
  const start = firstArr >= 0 && (firstObj < 0 || firstArr < firstObj) ? firstArr : firstObj;
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    const candidate = s.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  throw new Error('无法从模型回覆解析 JSON：' + text.slice(0, 200));
}

/** 测试连线：发一句最短的讯息，确认位址／Key／模型都可用 */
/** 测试连线：发一句最短的讯息，确认位址／Key／模型都可用 */
export async function testConnection(cfg) {
  const started = Date.now();
  // 注意：max_tokens 不能给小 —— 推理模型（deepseek-reasoner / deepseek-flash）
  // 会先把 token 花在思考过程上，给 16 个 token 会导致 content 是空的。
  const reply = await chat({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    messages: [{ role: 'user', content: '回覆「OK」两个字' }],
    maxTokens: 1024,
    temperature: 0,
    timeoutMs: 60000,
  });
  return { ok: true, ms: Date.now() - started, reply: reply.slice(0, 80) };
}
