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
 * 呼叫模型。
 * @returns {Promise<string>} 模型回覆的文字內容
 */
export async function chat({ baseUrl, apiKey, model, messages, temperature = 0.2, maxTokens = 2048, timeoutMs = 120000 }) {
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

  if (typeof content !== 'string' || !content.trim()) {
    // 常见原因 1：推理模型（deepseek-reasoner / deepseek-flash 等）把 token
    //   全花在 reasoning_content 上，content 就被截断了。
    // 常见原因 2：max_tokens 太小。
    if (finish === 'length') {
      throw new Error(
        `模型输出被 max_tokens(${maxTokens}) 截断，没有留下答案` +
          (reasoning ? '。这个模型会先输出思考过程（reasoning_content），需要更大的 max_tokens' : '') +
          '。请换用小一点的模型，或改用非推理模型。',
      );
    }
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
