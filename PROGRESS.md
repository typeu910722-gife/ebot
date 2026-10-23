# OCTA 進度

> 部署規則：使用者 2026-10-22 指示「以後自動推上線」— 每次改完測試通過就直接合併 main、推送並跑 desktop.yml 發布。

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
## 自動更新
- [x] electron-updater（GitHub Releases，latest.yml）：啟動 8 秒後與每 6 小時檢查；左上角「更新」→ 下載進度 → 重新啟動並更新；設定可手動檢查
## 使用我的 Chrome
- [x] bots.browser='mine'：Playwright MCP --extension 連使用者真正的 Chrome（已登入網站、已儲存密碼），每個機器人自己的分頁群組；extension token 只存在本機（desktop.json / octa-runner.json extToken）；執行器 v9
## v2.0（2026-10-22）
- [x] 主機制：每帳號一台主機電腦執行（users.host，第一台連上的自動當主機），其他電腦待命；設定 → 電腦與主機可切換、移除
- [x] 即時推送：users.rev 變動計數＋/api/wait 長輪詢（25 秒）；執行器 runner/next 也長輪詢（有工作 <1 秒接到）
- [x] 資料庫寫入只在有變動時：主機心跳每 4 分鐘寫一次（sessions.seen）
- [x] 例行任務雲端／電腦排程（settings.sched，預設雲端）；/api/cron 由 GitHub Actions 每 5 分鐘呼叫，順便清理舊資料
- [x] 檔案存在主機電腦：上傳先暫存 chunks，主機收下後刪雲端；檢視時 want → 主機上傳暫存片段；截圖、輸出也存電腦；Google 雲端硬碟 / 自選資料夾（desktop/store）
- [x] 訊息依對話分頁載入（/api/messages），state 只給清單預覽與未讀
- [x] 裝置清單、密碼移除、改密碼、重設碼（已登入裝置產生或傳到 Telegram/LINE）、登入限流（logins 表）、90 天未用自動登出
- [x] 桌面版登出可保留工作；重新登入沿用執行器金鑰（runner/hello 比對帳號）
- [x] 每個裝置的瀏覽器通知；設定改選單；最新版本頁（public/changelog.json）；更新橫幅「看更新內容」
- [x] AI 連線：各家擅長、剩餘流量（Claude OAuth usage、Codex app-server rateLimits；其他顯示今日次數）；Ollama 取代付費 API
- [x] 測試：API 腳本 31 項、執行器假 CLI 端對端、網頁 UI、Electron 雲端模式（登入、登出保留、重新登入沿用）、離線模式舊資料庫遷移
- [ ] Windows 實機、Ollama / Codex 剩餘流量實機驗證
## 待辦
- [x] 公版清理：範本改通用（助理、研究、門市、民宿），移除個人化字樣；加入「設定指引」（無機器人時自動開啟，可試跑）；README 重寫
- [x] 倉庫已公開；Release v1.5.0 自動發布 OCTA-Setup.exe（固定網址 releases/latest/download/OCTA-Setup.exe）
- [x] 網頁版首頁（未登入顯示）：介紹、下載按鈕、三步驟、功能、支援的 AI、常見問題
## v2.2.0（2026-10-22 已上線：網站＋桌面版 Release）
- [x] 例行任務事件觸發：網頁監看（runner/watches、runner/watched，CDP 背景讀頁比對雜湊）、外部事件網址 /api/hook/<key>（LINE events 解析、合併待處理工作、限流）；⏰ 標記支援「監看 url」「外部事件」
- [x] Grok 引擎（官方 Grok CLI）；Grok Bot 引擎（grok-bot-cli / gbot）＋帶入機器人（grokbot/list、kind=list 工作）
- [x] 測試：webhook、監看、gbot 假 CLI 端對端、UI（觸發表單、帶入）、API 31 項
- [ ] 實機：Grok CLI / Grok Bot App 登入、LINE webhook 真實呼叫

## 2026-10-23 2.5.2–2.5.6
- 群組：無 @ 時成員並行處理、無關的回「（略過）」並隱藏；規則含「輪流/依序/接力」才依序。成員可 @問、@交接。
- 外部交接：Grok Bot 首席 POST hook → Claude助理 實測成功（約 30 秒）；對話顯示交接者與內容。
- 共用登入：job 開始時也從其他機器人「開著的」瀏覽器抓 cookies（2.5.3）。
- Ollama：關 grep/glob（ripgrep 缺）、給 octa-task.md 絕對路徑。
- 機器人可自己點「已記住帳號」登入；需密碼仍停下。
- LINE 測試：Claude、Gemini 已傳給 yzz；ChatGPT 要使用者輸入 LINE 密碼；Ollama 待 2.5.6 重試。
- 待辦：Grok Bot CLI 匯入（app 不寫 gateway-descriptor.json）；Claude 週額度剩 3%（10/26 重置）。
- 2.6.0：背景互通（私聊中 @同事 → 對方自己對話跑 〔背景:id:ask|give〕，結果 🔁 回傳；ask 會叫回原機器人）；24 小時待命 = 例行任務「待命巡查」*/N，不發系統訊息、（略過）隱藏；同事清單改全部機器人。
- 2.7.0：備援 AI（bots.fb、jobs.eng，QUOTA 錯誤→下一個）；瀏覽器 --window-name＋profile 名稱/主題色；群組依「之後/然後」依序；所有引擎給 octa-task.md 絕對路徑；agy 英文旁白過濾；cookie host-only 用 url 設定。
- 2.8.0：群組提問側窗（#askp，回覆=@bot）、無@回答回給發問者（asksUser，你們/大家除外）、聊聊/討論→輪流、st.spent 記住額度用完到 reset、瀏覽器留在桌面（cascade，不最小化/不移出畫面）、【回覆】標記切掉工作旁白。
- 2.9.0：tagScript 加即時游標（mousemove/mousedown/keydown/focusin）；playwright-mcp 加 --caps vision（browser_mouse_click_xy）；網站操作步驟提示；🗺️網站筆記 → st.sites 共用注入 prompt。
- 2.9.3：dayInfo（今天/昨天/明天＋住宿分類規則、搜尋前幾天）、workNotes（bots/<id>/工作筆記.md 自動注入 prompt，機器人自行維護）。待查：Grok Bot 對同問題的回答（使用者中止電腦操作）。
