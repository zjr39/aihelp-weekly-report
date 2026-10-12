// AIHelp 儀表板的頁面路徑與 API 端點（集中管理，不要在別的檔案硬編碼網址）
//
// 所有路徑都相對「使用者自己設定的站台」推導，所以同一個工具可以給
// 任何 AIHelp 客戶使用，不需要改程式碼。

/** 客訴統計頁（趨勢 → 應用 / 標籤） */
export const statsPage = (cfg) => cfg.dashboardUrl;

/** 客訴列表頁（逐筆客訴，含標籤）—— 有效／無效的權威來源 */
export const ticketListPage = (cfg) => `${cfg.origin}/dashboard/#/manual/tickets/?queryType=0`;

/** 客訴列表 API（需要頁面自己產生簽章，不能自行重放） */
export const ticketSearchApi = (cfg) => `${cfg.origin}/console/api/ticket/home/searchnew`;

/** 客訴统计 API（應用 11 欄指標 + 一級/二級標籤） */
export const statsApi = (cfg) => `${cfg.origin}/console/api/stat/rpastat/ticketstatmerge`;

/** 從任意頁面網址取回 host，用於在 Chrome 分頁清單中比對 */
export const hostOf = (cfg) => cfg.host;
