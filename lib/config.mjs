// 設定載入與自動探索
//
// 設計原則：使用者只需要填一個 dashboardUrl，其餘全部自動決定。
//   - 瀏覽器路徑：查 Windows 登錄檔 App Paths + 常見安裝位置（Chrome 優先，退回 Edge）
//   - profile 目錄：%LOCALAPPDATA%\aihelp-weekly\chrome-profile
//   - 輸出目錄：專案根目錄底下的 raw/ data/ report/ downloads/
//
// 設定來源優先序（後面覆蓋前面）：
//   1. 內建預設
//   2. config.json（不存在時會從 config.example.json 複製一份）
//   3. 環境變數（AIHELP_DASHBOARD_URL / AIHELP_CHROME / AIHELP_PORT / AIHELP_PROFILE_DIR）
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_FILE = path.join(ROOT, 'config.json');
export const EXAMPLE_FILE = path.join(ROOT, 'config.example.json');

/** 範本裡的預留網址；等於這個值就代表「還沒設定」 */
export const PLACEHOLDER_HOST = 'YOUR-COMPANY.aihelp.net';
const PLACEHOLDER_URL = `https://${PLACEHOLDER_HOST}/dashboard/`;

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 決定專用 profile 目錄。
 *
 * 除了預設位置，也會探查早期版本用過的路徑 —— 這樣從舊版升級的使用者
 * 不會白白丟掉已經登入好的 session。
 */
async function resolveProfileDir(rawProfileDir) {
  if (rawProfileDir) return rawProfileDir;

  const local = process.env.LOCALAPPDATA || ROOT;
  const candidates = [
    path.join(local, 'aihelp-weekly', 'chrome-profile'), // 目前預設
    path.join(local, 'AIHelp-Auto', 'profile'), // 早期版本用過
  ];
  for (const p of candidates) {
    if (await exists(p)) return p;
  }
  return candidates[0];
}

// ───────── 瀏覽器探索 ─────────

/** 查 Windows 登錄檔的 App Paths（最可靠，不依賴 PATH 或猜路徑） */
function fromRegistry(exe) {
  const keys = [
    `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
  ];
  for (const k of keys) {
    try {
      const out = execFileSync('reg', ['query', k, '/ve'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/REG_SZ\s+(.+?)\s*$/m);
      if (m && m[1]) {
        const p = m[1].replace(/^"|"$/g, '').trim();
        if (p) return p;
      }
    } catch {}
  }
  return null;
}

/**
 * 找出可用的 Chromium 系瀏覽器。Chrome 優先，其次 Edge。
 * @returns {Promise<{path:string, kind:'chrome'|'edge'}|null>}
 */
export async function findBrowser() {
  const envOverride = process.env.AIHELP_CHROME;
  if (envOverride) {
    if (await exists(envOverride)) return { path: envOverride, kind: /msedge/i.test(envOverride) ? 'edge' : 'chrome' };
    return null; // 使用者明確指定但不存在 → 不要偷偷換別的
  }

  for (const [exe, kind] of [
    ['chrome.exe', 'chrome'],
    ['msedge.exe', 'edge'],
  ]) {
    const p = fromRegistry(exe);
    if (p && (await exists(p))) return { path: p, kind };
  }

  const bases = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(Boolean);
  for (const [rel, kind] of [
    ['Google\\Chrome\\Application\\chrome.exe', 'chrome'],
    ['Microsoft\\Edge\\Application\\msedge.exe', 'edge'],
  ]) {
    for (const b of bases) {
      const p = path.join(b, rel);
      if (await exists(p)) return { path: p, kind };
    }
  }
  return null;
}

// ───────── 網址推導 ─────────

/** 把 dashboardUrl 正規化成 origin / host / 統計頁網址 */
export function deriveSite(dashboardUrl) {
  const u = new URL(dashboardUrl);
  const origin = `${u.protocol}//${u.host}`;
  const hasPath = /\/dashboard/i.test(u.pathname) || dashboardUrl.includes('#');
  return {
    origin,
    host: u.host,
    dashboardUrl: hasPath ? dashboardUrl : `${origin}/dashboard/`,
  };
}

/** 判斷是否已完成設定（dashboardUrl 還是範本值就代表沒設定） */
export function isConfigured(cfg) {
  if (!cfg || !cfg.dashboardUrl) return false;
  try {
    // 注意：new URL() 會把 host 轉成小寫，所以比對前要先統一大小寫，
    // 否則範本值 "YOUR-COMPANY" 會因為變成 "your-company" 而比對失敗。
    const host = deriveSite(cfg.dashboardUrl).host.toLowerCase();
    return host !== PLACEHOLDER_HOST.toLowerCase();
  } catch {
    return false;
  }
}

// ───────── 載入 / 儲存 ─────────

/**
 * 載入設定。會自動補齊所有可推導的欄位。
 * @param {{autoCreate?:boolean}} opts autoCreate=false 時，config.json 不存在也不會建立
 */
export async function loadConfig(opts = {}) {
  const { autoCreate = true } = opts;
  let raw = null;

  try {
    raw = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (autoCreate) {
        try {
          const example = await fs.readFile(EXAMPLE_FILE, 'utf8');
          await fs.writeFile(CONFIG_FILE, example, 'utf8');
          raw = JSON.parse(example);
        } catch {
          raw = {};
        }
      } else {
        raw = {};
      }
    } else if (e instanceof SyntaxError) {
      throw new Error(`config.json 格式错误（${e.message}）。请修正它，或删除后重新执行 npm run setup`);
    } else {
      throw e;
    }
  }

  // 環境變數覆寫
  if (process.env.AIHELP_DASHBOARD_URL) raw.dashboardUrl = process.env.AIHELP_DASHBOARD_URL;
  if (process.env.AIHELP_PORT) raw.port = Number(process.env.AIHELP_PORT);
  if (process.env.AIHELP_PROFILE_DIR) raw.profileDir = process.env.AIHELP_PROFILE_DIR;

  const site = deriveSite(raw.dashboardUrl || PLACEHOLDER_URL);
  const browser = await findBrowser();
  const profileDir = await resolveProfileDir(raw.profileDir);

  return {
    // ── 使用者可設定（有給就用給的）──
    dashboardUrl: site.dashboardUrl,
    port: raw.port || 9222,
    profileDir,
    chrome: raw.chrome || (browser ? browser.path : null),
    timezone: raw.timezone || 'Local',
    locale: raw.locale || 'zh-CN',
    weekAnchor: raw.weekAnchor || 'fri',

    // ── 自動推導（不要寫進 config.json）──
    origin: site.origin,
    host: site.host,
    browserKind: browser ? browser.kind : null,
    chromeFound: !!(raw.chrome ? await exists(raw.chrome) : browser),

    // ── 輸出目錄（一律在專案內）──
    root: ROOT,
    rawDir: path.join(ROOT, 'raw'),
    dataDir: path.join(ROOT, 'data'),
    reportDir: path.join(ROOT, 'report'),
    downloadDir: path.join(ROOT, 'downloads'),

    configured: isConfigured({ dashboardUrl: site.dashboardUrl }),
  };
}

/** 把設定寫回 config.json（只寫使用者該看到的欄位，不含推導值） */
export async function saveConfig(patch) {
  let cur = {};
  try {
    cur = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch {}
  const next = { ...cur, ...patch };
  await fs.writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** 建立所有輸出目錄 */
export async function ensureDirs(cfg) {
  for (const d of [cfg.rawDir, cfg.dataDir, cfg.reportDir, cfg.downloadDir]) {
    await fs.mkdir(d, { recursive: true });
  }
}
