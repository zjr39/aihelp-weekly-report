// 本機模擬 OpenAI 相容服務 —— 用來在不花錢、不需真 key 的情況下驗證摘要流程
//
// 用法：node tools/mock-llm.mjs [port]
// 然後在工具裡把 API 位址設成 http://127.0.0.1:8899，模型隨便填（例如 mock）
//
// 它會解析我們送出的提示，把每個標籤回一句固定的假摘要，格式與真模型一致。
import http from 'node:http';

const PORT = Number(process.argv[2] || 8899);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'not found' } }));
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad json' } }));
    }

    const userMsg = (payload.messages || []).find((m) => m.role === 'user')?.content || '';
    // 從提示中抽出標籤名：标签「XXX」（N 笔）
    const tags = [...userMsg.matchAll(/标签「([^」]+)」/g)].map((m) => m[1]);

    const arr = tags.map((tag) => ({
      tag,
      summary: `【模拟】玩家主要在询问${tag}相关问题`,
    }));

    const content = JSON.stringify(arr);
    const out = {
      id: 'mock-1',
      object: 'chat.completion',
      model: payload.model || 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
    console.log(`  [mock] 標籤 ${tags.length} 個 → 已回覆`);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`模拟 LLM 服务已启动：http://127.0.0.1:${PORT}`);
  console.log('（在工具里把 API 位址填这个、模型填 mock 即可）');
});
