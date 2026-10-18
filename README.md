# AIHelp 客诉周报工具

从 [AIHelp](https://aihelp.net) 客服系统自动采集客诉数据，算出**有效／无效客诉**，一键产出排版好的周报 Excel。

> **零依赖**：不需要 `npm install`，只要有 Node.js 就能跑。
> **不抢鼠标**：全程在背景的独立浏览器里操作，不会干扰你手上的工作。

<!-- 截图建议：把截图放到 docs/screenshot.png 后取消下一行注解 -->
<!-- ![界面截图](docs/screenshot.png) -->

---

## 这个工具解决什么问题

AIHelp 后台能看到客诉数量和标签分布，但「**有效客诉率**」需要人工判断：
一笔客诉如果没有标签、或者只带了「无效来访」标签，那它就不算有效客诉。

每周手动从后台捞数据、逐个游戏切换标签页、再贴进 Excel —— 重复、耗时、还容易抄错。

这个工具把整件事变成一个按钮：

```
无效客诉 = 没有标签的客诉 + 带「无效来访」标签的客诉
有效客诉 = 总客诉 − 无效客诉
有效率   = 有效客诉 ÷ 总客诉
```

数字的来源有两份，会互相核对：

| 来源 | 用途 |
|---|---|
| **客诉列表页**（逐笔客诉的标签） | 有效／无效的**权威依据** |
| **客诉统计页**（应用指标 + 一／二级标签） | 报表版面用 |

> 统计页的「一级标签加总」有时会比真实客诉数多或少（同一笔客诉可能带多个一级标签），
> 所以有效／无效一律以「客诉列表页」的逐笔标签为准。

---

## 快速开始

### 1. 安装 Node.js

到 <https://nodejs.org/> 下载 **LTS** 版本安装（需要 18 以上）。

装完打开命令提示字元（cmd）或 PowerShell，确认可用：

```
node --version
```

### 2. 取得这个专案

```bash
git clone <这个 repo 的网址>
cd aihelp-weekly-report
```

或者直接下载 ZIP 解压也可以。

### 3. 执行设定精灵

```bash
npm run setup
```

它会引导你完成：

1. 检查 Node 版本
2. 自动寻找 Chrome 或 Edge
3. **询问你的 AIHelp 仪表板网址**（就是平常打开客诉统计页时，浏览器网址列那串）
4. 建立资料夹
5. 打开专用浏览器，请你登入一次
6. 验证连线，成功才写入设定

设好之后就可以用了：

```bash
npm start
```

浏览器会自动打开界面。

---

## 安装桌面图示（Windows，选做）

想要双击桌面图示就能用、不要每次开命令行：

```bash
npm run install-shortcut
```

> 请先完成上面的「设定精灵」，桌面图示才能正常运作。
> 专案搬家后重跑一次这个指令即可修复。

会建立两个桌面图示：

| 图示 | 作用 |
|---|---|
| **客诉周报工具** | 背景启动（**不会出现黑色视窗**）并打开界面 |
| **结束客诉周报工具** | 停止背景服务 |

移除：

```bash
npm run uninstall-shortcut
```

想改成「看得到黑色视窗」的版本（方便盯日志）：

```bash
npm run install-shortcut -- -ShowWindow
```

如果不想装图示，也可以直接双击专案根目录的 `start.cmd`（会显示黑色视窗）。

---

## 使用方式

### 图形界面（推荐）

```
npm start
```

1. 确认日期（预设已带好**上周五 ~ 本周四**）
2. 按「开始采集」
3. 等约 3 分钟（会即时显示正在抓哪个游戏）
4. 按「下载 Excel 表格」

界面支援 **暂停 / 继续 / 终止**，全程可以放着自己跑。

### 命令列

```bash
# 上一个周期（上周五 ~ 本周四）
npm run weekly

# 本周期
npm run weekly -- --week this

# 指定区间
npm run weekly -- --start 2026-10-09 --end 2026-10-15

# 只重跑报表，不重新抓取
npm run weekly -- --skip-collect
```

跑完会用系统预设程式打开产出的 Excel。

---

## 设定

设定档是 `config.json`（**不会进版控**，每个人不同）。绝大多数情况只要填一个栏位：

```json
{
  "dashboardUrl": "https://YOUR-COMPANY.aihelp.net/dashboard/"
}
```

其余全部自动决定：

| 项目 | 预设行为 |
|---|---|
| 浏览器路径 | 自动探索（登錄檔 → 常见安装位置，Chrome 优先、其次 Edge） |
| 专用 profile | `%LOCALAPPDATA%\aihelp-weekly\chrome-profile` |
| 输出目录 | 专案内的 `raw/` `data/` `report/` `downloads/` |
| 週期起始 | 周五（即周五 ~ 周四） |
| 统计页时间依据 | **客诉创建时间**（`timeFilter: "create"`） |

### 关于「时间依据」

AIHelp 客诉统计页有个下拉选单决定「时间怎么归到週期」：

| 选项 | `timeFilter` | 含义 |
|---|---|---|
| **客诉创建时间** | `"create"`（预设） | 按「客诉建立的那一刻」归属。所有数字描述**同一批客诉**（本週建立的） |
| 指标发生时间 | `"metric"` | AIHelp 的原始预设。按「指标发生的那一刻」归属 |

本工具预设用**客诉创建时间**，因为客诉明细页（算有效／无效的依据）本来就是按创建时间抓的，
两边的基础一致才对得上帐。

实测两者差异（某个 7 天区间）：

| 指标 | 指标发生时间 | 客诉创建时间 |
|---|---|---|
| 客诉生成量 | 95 | 95（不变） |
| 客诉解决量 | 71 | 32 |
| 评价率 | 46.5% | 78.1% |
| 一／二级标签明细 | — | **完全相同** |

> 差异来源：`客诉解决量` 在指标模式下是「这週被解决的」（含上週建立的客诉），
> 在创建模式下是「这週建立且已解决的」。前者会跨週期重复计算同一批客诉。

要切回 AIHelp 的原始行为，在 `config.json` 加一行：

```json
{ "timeFilter": "metric" }
```

### 进阶选项

```json
{
  "dashboardUrl": "https://YOUR-COMPANY.aihelp.net/dashboard/",
  "port": 9222,
  "chrome": "D:\\Chrome\\chrome.exe",
  "profileDir": "D:\\aihelp-profile",
  "weekAnchor": "fri",
  "timeFilter": "create"
}
```

也可以全部用环境变数覆盖（方便做排程或 CI）：

```
AIHELP_DASHBOARD_URL
AIHELP_CHROME
AIHELP_PORT
AIHELP_PROFILE_DIR
```

---

## 输出档案

| 路径 | 内容 |
|---|---|
| `report/周报_10月2-10月8.xlsx` | **成品**：排版好的 Excel |
| `report/<区间>.tsv` | 纯文字版 |
| `raw/<区间>.json` | 原始资料（含每一笔客诉的标签，可回溯重算） |
| `data/<区间>_*.json` | 转换后的中间档 |

`raw/` 里面存了每一笔客诉的标签，所以之后想改统计逻辑重算，不需要重新抓取。

---

## 疑难排解

**Q：界面显示「登录已失效」**
按界面右上角「启动 Chrome」，在弹出的视窗登入一次，回界面重新整理。

**Q：找不到 Chrome**
执行 `npm run setup` 会重新探索。或直接安装 Chrome：<https://www.google.com/chrome/>

**Q：连接埠被占用**
```
端口 9222 已被占用（浏览器）
端口 8791 已被占用（界面）
```
用别的端口：`npm start -- --port 8792`，或改 `config.json` 的 `port`。

**Q：双击桌面图示后弹出「服务器启动失败」**
记录档在 `%TEMP%\aihelp-launcher.log`，内容可以直接拿来排查。

**Q：某个游戏失败**
界面会用红色徽章标出。通常是暂时性限流，重跑一次即可。

**Q：想改统计逻辑重算，不想重抓**
用 `npm run weekly -- --skip-collect`，或直接改 `lib/report.mjs` 后重跑。

---

## 专案结构

```
bin/                 命令列入口与界面伺服器
  setup.mjs            首次设定精灵
  gui.mjs              界面伺服器（http://127.0.0.1:8791）
  gui/                 界面（HTML / CSS / JS，无框架）
  run-weekly.mjs       一键跑完整流程
  collect-v3.mjs       只做采集
  chrome-up.mjs        启动／检查专用浏览器
  install-launcher.ps1 桌面图示安装
  launch-hidden.vbs    背景启动器
lib/                 核心逻辑
  config.mjs           设定载入与浏览器自动探索
  pages.mjs            AIHelp 页面与 API 路径（集中管理，不散落各处）
  collectCore.mjs      采集核心
  pipeline.mjs         转换 + 产生报表
  report.mjs           有效／无效的计算与对帐
  xlsx.mjs             零依赖 Excel 产生器
  cdp.mjs              Chrome DevTools Protocol 客户端
tools/               开发与维护脚本
docs/                文件
assets/              图示
```

---

## 开发

```bash
node --check lib/collectCore.mjs     # 语法检查
node tools/gui-smoke.mjs             # 界面冒烟测试
node tools/gui-e2e.mjs               # 界面端对端测试
node tools/verify-xlsx.mjs <file>    # 验证产出的 Excel 结构
node tools/make-icon.mjs             # 重新产生图示
```

改过 `.vbs` 之后**务必**执行：

```bash
node tools/vbs-to-utf16.mjs bin/launch-hidden.vbs
```

原因见 [docs/技术笔记.md](docs/技术笔记.md)。

---

## 已知限制

- **仅支援 Windows**。核心逻辑是纯 Node、可移植，但启动器与桌面图示是 Windows 专用的。
- **需要能登入 AIHelp**。工具用的是你自己的帐号 session，不会也不能绕过权限。
- **UI 选择器依赖 AIHelp 前端结构**。如果 AIHelp 大改版，可能需要在 `lib/collectCore.mjs`
  调整选择器与元件名称。

---

## 授权

[MIT](LICENSE)
