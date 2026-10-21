# E·BOT

像 Grok bot 一樣用聊天介面指揮多個 AI 機器人，但實際執行的是**你自己電腦上的 Claude Code**，用的是你自己的 Claude 方案（Pro / Max），不用另外付 API 費。

- 新建機器人，給每個機器人指定任務
- **分區**：把不同門市／專案的機器人分開；同分區的機器人可以互相詢問（回覆裡寫 `@同事 問題`）
- 把機器人拉進群組，依序協作，或用 `@名字` 指定誰做
- **例行任務**：每天多個固定時間自動執行，可隨時開關
- **每個機器人有自己的瀏覽器**（獨立 Chrome 設定檔：分頁、登入、Cookie 各自分開），最多 3 個同時工作互不干擾；聊天室裡可看它最後停在哪一頁、或叫電腦打開它的瀏覽器讓你登入
- 多帳號雲端版，或下載桌面版（不用帳號、資料只在自己電腦）
- 核准按鈕、檔案與圖片附件、分區資料與共用資料、Telegram / LINE 通知、工作紀錄

## 架構

```
手機 / 電腦瀏覽器 ──► Cloudflare Pages（網頁 + API）──► D1 資料庫
                                   ▲
                                   │ 每 5 秒領任務、回寫結果
                     你電腦上的執行器 ebot-runner.mjs
                                   │
          claude -p ＋ 每個機器人專屬的 Playwright Chrome（你的 Claude 登入）
```

網站只負責存資料與排隊；所有 AI 執行都發生在使用者自己的電腦，用使用者自己的 Claude 帳號。

## 使用（已架好的站）

1. 打開網站註冊帳號
2. 「設定」→ 照步驟下載執行器、產生金鑰、執行
3. 新建機器人或套用範本，開始對話

執行器需求：Node 18+、[Claude Code](https://code.claude.com)（用 `/login` 登入 Pro/Max）、Google Chrome。瀏覽器工具用 [@playwright/mcp](https://github.com/microsoft/playwright-mcp)，執行器會自動透過 npx 取得。同時工作數量可在 `ebot-runner.json` 加 `"max": 3` 調整。

## 自己架一份

1. Fork 這個倉庫
2. 建 D1 資料庫並建表：
   ```
   npx wrangler d1 create ebot
   npx wrangler d1 execute ebot --remote --file schema.sql
   ```
3. 把 `wrangler.toml` 的 `database_id` 換成你的
4. Cloudflare → Workers 和 Pages → 建立 → Pages → 連接 Git，選你的 fork，其他保持預設
5. 視需要調整 `wrangler.toml` 的 `TZ_OFFSET_MIN`（排程時區）與 `ALLOW_SIGNUP`（是否開放註冊）

本機開發：`npx wrangler d1 execute ebot --local --file schema.sql && npx wrangler pages dev`

## 安全

- 密碼以 PBKDF2 雜湊儲存；登入與執行器金鑰都只存 SHA-256 雜湊
- 執行器金鑰只能領自己帳號的任務；重新產生會讓舊金鑰失效
- 機器人預設不會替你發訊息、付款、刪資料，會先請你確認
- 執行器只允許瀏覽器、網路查詢與 `work/` 資料夾內的讀寫工具

## 授權

MIT

## 桌面版（下載安裝，不用帳號）

`desktop/` 是 Windows 安裝版：網頁、資料庫、執行器全部在自己電腦上，不用註冊、不用金鑰，資料不經過雲端。

- 下載：GitHub Releases 的 `EBOT-Setup-x.y.z.exe`
- 需要：[Claude Code](https://code.claude.com)（安裝後在終端機執行 `claude`、輸入 `/login`）、Google Chrome。不需要另外裝 Node。
- 手機遙控：設定 → 手機遠端，會產生網址與 8 碼配對碼（Cloudflare 快速通道，網址每次不同）
- 縮到右下角常駐，可設定開機自動啟動；機器人需要你處理時會跳電腦通知
- 未簽章的安裝檔第一次執行時，Windows 會顯示「Windows 已保護您的電腦」，按「其他資訊 → 仍要執行」

開發：
```
cd desktop
npm install
npm run serve      # 用 Node 直接跑（不開視窗，自動打開瀏覽器）
npm start          # Electron 視窗
npm run dist       # 打包 Windows 安裝檔（Linux 需安裝 wine64 + wine32）
```
推送 `v*` 標籤時，GitHub Actions 會在 Windows 上自動打包並附加到 Release。
