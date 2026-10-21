# OCTA 進度
## 雲端版（octa.yzprojecttw.com）
- [x] 前端（E·ROOM 金黑風格）、多帳號、Pages Functions + D1
- [x] 執行器 v4 `public/octa-runner.mjs`：可匯入的 startRunner()、最多 3 個並行、每個機器人獨立 Chrome（Playwright MCP）、截圖、遠端開瀏覽器
- [x] 分區 + 同分區互問、例行任務、範本
- [x] 核准按鈕（✅待確認：…）、附件（files 表）、分區資料 / 共用資料、Telegram / LINE 通知、工作紀錄
## 桌面版（desktop/）
- [x] server.mjs：sql.js 本機資料庫（D1 相容包裝）、共用同一份 API 與網頁、內建執行器、localhost 防 CSRF / DNS rebinding
- [x] 手機遠端：cloudflared 快速通道 + 8 碼配對碼（10 次錯誤自動換碼）
- [x] main.mjs：Electron 視窗、系統匣、電腦通知、開機自動啟動、內建 Playwright MCP（用 Electron 當 Node）
- [x] electron-builder NSIS 打包成功（Linux+wine 與 GitHub Actions windows-latest 皆成功，run 39585548610）；推 v* 標籤或手動觸發 workflow 可重打包
- [ ] 在真正的 Windows 上實測安裝檔（尚未）
- [ ] 手機遠端通道實測（沙盒內無法連 trycloudflare）
## 多 AI 引擎
- [x] bots.engine（claude / codex / gemini）；執行器 v5 依引擎呼叫 claude -p、codex exec（-c 注入 Playwright MCP）、gemini -p --yolo（.gemini/settings.json）
- [x] 任務設定可選 AI 引擎；設定指引顯示 Codex / Gemini 安裝狀態
- [ ] 真實 Codex / Gemini 帳號實測（沙盒只驗證到參數解析）
## 待辦
- [x] 公版清理：範本改通用（助理、研究、門市、民宿），移除個人化字樣；加入「設定指引」（無機器人時自動開啟，可試跑）；README 重寫
- [ ] 倉庫改公開（需 Yz 在 GitHub 設定）
