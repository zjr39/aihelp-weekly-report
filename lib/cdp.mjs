// 极简 CDP 客户端（WebSocket 直连既有的 --remote-debugging-port）
//
// 设定载入已移到 lib/config.mjs（会自动探索浏览器与路径）。
// 这里重新导出，让既有程式码的 `import { loadConfig } from './cdp.mjs'` 继续可用。
import http from 'node:http';
import { loadConfig } from './config.mjs';

export { loadConfig };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2500 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** 等 CDP 端点出现，回传 version 资讯 */
export async function waitForCdp(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await httpGet(port, '/json/version');
      if (r.status === 200) return JSON.parse(r.body);
    } catch {}
    await sleep(500);
  }
  return null;
}

export async function listTargets(port) {
  const r = await httpGet(port, '/json/list');
  if (r.status !== 200) throw new Error('/json/list -> HTTP ' + r.status);
  return JSON.parse(r.body);
}

export function findPage(targets, substr) {
  const pages = targets.filter((t) => t.type === 'page');
  if (!substr) return pages[0];
  const hit = (t) => t.url.includes(substr) || (t.title || '').includes(substr);
  // 同名分页可能有多个（例如 about:blank 过渡页），優先挑「已载入目标站台」的那个
  return pages.find((t) => hit(t) && !t.url.startsWith('about:')) || pages.find(hit);
}

/** 连上 browser-level WebSocket，支援 flatten session */
export async function connect(port) {
  const v = await waitForCdp(port, 4);
  if (!v) throw new Error(`CDP 端点不存在（port ${port}）。请先执行 bin/chrome-up.mjs`);
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连线失敗')), { once: true });
  });

  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(`${m.error.message || 'CDP error'} (${JSON.stringify(m.error).slice(0, 200)})`)) : resolve(m.result);
      return;
    }
    if (m.method) for (const l of listeners) l(m);
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const p = { id, method, params };
      if (sessionId) p.sessionId = sessionId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(p));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('timeout: ' + method));
        }
      }, 120000);
    });

  const on = (fn) => listeners.push(fn);
  const close = () => {
    try {
      ws.close();
    } catch {}
  };

  const attach = async (targetId) => (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;

  const makeEval = (sessionId) => async (expression, { awaitPromise = true, timeout = 60000 } = {}) => {
    const res = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }, sessionId),
      sleep(timeout).then(() => {
        throw new Error('evaluate timeout after ' + timeout + 'ms');
      }),
    ]);
    if (res.exceptionDetails) {
      throw new Error('JS 例外: ' + JSON.stringify(res.exceptionDetails).slice(0, 500));
    }
    return res.result.value;
  };

  return { send, on, close, attach, makeEval, version: v, ws };
}

