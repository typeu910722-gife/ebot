# E·BOT

像 Grok bot 一樣用聊天介面指揮多個 AI 機器人，但實際執行的是**你自己電腦上的 Claude Code**，用的是你自己的 Claude 方案（Pro / Max），不用另外付 API 費。

- 新建機器人，給每個機器人指定任務
- 把機器人拉進群組，依序協作，或用 `@名字` 指定誰做
- 每天固定時間自動執行
- 機器人透過 Claude in Chrome 操作你已登入的網站（後台、試算表等）
- 多帳號：每個人登入自己的帳號、連自己的電腦

## 架構

```
手機 / 電腦瀏覽器 ──► Cloudflare Pages（網頁 + API）──► D1 資料庫
                                   ▲
                                   │ 每 5 秒領任務、回寫結果
                     你電腦上的執行器 ebot-runner.mjs
                                   │
                             claude -p --chrome（你的 Claude 登入）
```

網站只負責存資料與排隊；所有 AI 執行都發生在使用者自己的電腦，用使用者自己的 Claude 帳號。

## 使用（已架好的站）

1. 打開網站註冊帳號
2. 「設定」→ 照步驟下載執行器、產生金鑰、執行
3. 新建機器人或套用範本，開始對話

執行器需求：Node 18+、[Claude Code](https://code.claude.com)（用 `/login` 登入 Pro/Max）、Chrome + [Claude in Chrome](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn) 擴充功能。Windows 請用原生 PowerShell（Claude in Chrome 不支援 WSL）。

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
