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
- [x] 執行器 v6：再加 copilot、cursor(agent)、qwen、opencode；bots.model 選填；長提示寫入 octa-task.md 給吃參數的 CLI
- [ ] 各家真實帳號實測（沙盒只驗證到參數 / 設定檔解析：codex、opencode、copilot）
## AI 連線（易用性）
- [x] 執行器 v7 回報已安裝的 AI（users.engines）；連線測試工作（jobs.kind='test'，jobs.result）
- [x] 「AI 連線」頁：每個 AI 的適合對象、費用、安裝／登入步驟、複製按鈕、測試；桌面版一鍵安裝並登入（開終端機跑腳本）
- [x] 設定指引改為：連上電腦 → 連接 AI → Chrome → 建機器人 → 試跑；機器人 AI 選單顯示已連接狀態
## 流暢度與多語
- [x] 送出即顯示（樂觀更新）、依忙碌調整輪詢、只在內容變動時重繪、未讀數徽章與分頁標題、草稿保存、輸入框自動長高、新訊息按鈕、貼上／拖放附件、複製訊息、時間戳、搜尋（Ctrl+K）、Esc 關閉、提示訊息、動畫（尊重減少動態）
- [x] 多語：i18n-core.js 以字典翻譯畫面文字（[data-u] 使用者內容不翻）；en / ja 手寫、zh-CN 由 OpenCC 轉換；範本依語言建立；機器人依語言回覆（settings.lang）
- [x] 執行器 v8（回覆語言）
- [x] 機器人頭貼可選 Emoji（bots.avatar；24 個常用 + 自訂；範本附預設頭貼）
## 桌面版 2（帳號同步、效能）
- [x] 桌面版預設登入雲端帳號：視窗載入 octa.yzprojecttw.com，preload 橋接（octaDesktop），登入後自動取得本機專屬執行器金鑰（label desktop:主機名）並在主程序執行；可切換離線模式（本機 SQLite）
- [x] runner-token 依 label 分開，不會把其他電腦的金鑰作廢
- [x] 效能：AI 工具偵測改非同步並快取（原本 spawnSync 會卡住整個程式）、本機資料庫存檔改 3 秒批次
- [x] YZ 進度條：啟動畫面（splash）、網頁載入遮罩、操作中頂部進度條，重要操作期間鎖住畫面
## 待辦
- [x] 公版清理：範本改通用（助理、研究、門市、民宿），移除個人化字樣；加入「設定指引」（無機器人時自動開啟，可試跑）；README 重寫
- [x] 倉庫已公開；Release v1.5.0 自動發布 OCTA-Setup.exe（固定網址 releases/latest/download/OCTA-Setup.exe）
- [x] 網頁版首頁（未登入顯示）：介紹、下載按鈕、三步驟、功能、支援的 AI、常見問題
