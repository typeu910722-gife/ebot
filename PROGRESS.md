# E·BOT 進度
## 雲端版（bot.yzprojecttw.com）
- [x] 前端（E·ROOM 金黑風格）、多帳號、Pages Functions + D1
- [x] 執行器 v4 `public/ebot-runner.mjs`：可匯入的 startRunner()、最多 3 個並行、每個機器人獨立 Chrome（Playwright MCP）、截圖、遠端開瀏覽器
- [x] 分區 + 同分區互問、例行任務、範本
- [x] 核准按鈕（✅待確認：…）、附件（files 表）、分區資料 / 共用資料、Telegram / LINE 通知、工作紀錄
## 桌面版（desktop/）
- [x] server.mjs：sql.js 本機資料庫（D1 相容包裝）、共用同一份 API 與網頁、內建執行器、localhost 防 CSRF / DNS rebinding
- [x] 手機遠端：cloudflared 快速通道 + 8 碼配對碼（10 次錯誤自動換碼）
- [x] main.mjs：Electron 視窗、系統匣、電腦通知、開機自動啟動、內建 Playwright MCP（用 Electron 當 Node）
- [x] electron-builder NSIS 打包成功（Linux + wine 建置）；GitHub Actions 推 v* 標籤自動打包
- [ ] 在真正的 Windows 上實測安裝檔（尚未）
- [ ] 手機遠端通道實測（沙盒內無法連 trycloudflare）
## 待辦
- [ ] 倉庫改公開（需 Yz 在 GitHub 設定）
