# E·BOT

用聊天介面指揮多個 AI 機器人。機器人在**你自己的電腦**上用 **Claude Code** 工作，用的是你自己的 Claude 方案（Pro / Max），不用另外付 API 費用。

## 快速開始（桌面版，推薦）

1. 安裝 [Claude Code](https://code.claude.com)，在終端機輸入 `claude`，再輸入 `/login` 登入
2. 安裝 [Google Chrome](https://www.google.com/chrome/)
3. 從 [Releases](../../releases) 下載 `EBOT-Setup-x.y.z.exe` 並安裝
4. 打開 E·BOT，照「設定指引」完成，選一個範本試跑

不用註冊帳號，資料只存在你的電腦。第一次執行時 Windows 若顯示「Windows 已保護您的電腦」，按「其他資訊 → 仍要執行」（安裝檔未簽章）。

## 能做什麼

- **機器人**：每個機器人有自己的指定任務
- **群組**：把機器人拉進群組依序協作，或用 `@名字` 指定誰做
- **分區**：區隔不同門市或專案；同分區的機器人可以互相詢問
- **例行任務**：每天固定時間自動執行，可隨時開關
- **獨立瀏覽器**：每個機器人有自己的 Chrome（分頁、登入各自分開），最多 3 個同時工作；可看它最後停在哪一頁
- **核准按鈕**：發訊息、付款這類動作，機器人會先等你按「核准」
- **附件**：傳圖片、PDF、文字檔給機器人
- **分區資料／共用資料**：寫一次，機器人都會讀
- **通知**：需要你處理時，跳電腦通知，也可以送到 Telegram 或 LINE
- **手機遙控**：設定 → 手機遠端，用網址加 8 碼配對碼連進來
- **工作紀錄**：每次執行的結果與花費時間

## 雲端版（多帳號，自己架）

適合想用網址登入、多人各自使用的情況。網站只負責存資料與排隊，AI 仍在每個人自己的電腦上執行。

```
手機 / 電腦瀏覽器 ─► Cloudflare Pages（網頁 + API）─► D1 資料庫
                              ▲
                              │ 每 5 秒領任務、回寫結果
                    使用者電腦上的 ebot-runner.mjs
                              │
                    claude -p ＋ 每個機器人的專屬 Chrome
```

1. Fork 這個倉庫
2. 建資料庫：
   ```
   npx wrangler d1 create ebot
   npx wrangler d1 execute ebot --remote --file schema.sql
   ```
3. 把 `wrangler.toml` 的 `database_id` 換成你的
4. Cloudflare → Workers 和 Pages → 建立 → Pages → 連接 Git，選你的 fork，其他保持預設
5. `wrangler.toml` 可調整 `TZ_OFFSET_MIN`（例行任務時區）與 `ALLOW_SIGNUP`（是否開放註冊）

使用者登入後，照網站上的「設定指引」下載執行器並連線（需要 Node 18+）。

## 開發

```
# 雲端版
npx wrangler d1 execute ebot --local --file schema.sql
npx wrangler pages dev

# 桌面版
cd desktop
npm install
npm run serve      # 用 Node 直接跑，自動打開瀏覽器
npm start          # Electron 視窗
npm run dist       # 打包 Windows 安裝檔（Linux 需要 wine64 + wine32）
```

推送 `v*` 標籤，GitHub Actions 會在 Windows 上打包並附加到 Release。

| 路徑 | 內容 |
| --- | --- |
| `public/index.html` | 網頁介面（雲端版與桌面版共用） |
| `functions/api/[[path]].js` | API（雲端版與桌面版共用） |
| `public/ebot-runner.mjs` | 執行器：領任務、呼叫 Claude Code、管理每個機器人的瀏覽器 |
| `desktop/` | 桌面版：本機 SQLite、Electron 視窗、手機遠端 |
| `schema.sql` | 資料表 |

## 安全

- 機器人預設不替你發訊息、付款、刪資料，會先請你核准
- 執行器只允許瀏覽器、網路查詢，以及機器人自己資料夾內的讀寫
- 雲端版密碼以 PBKDF2 儲存，登入與執行器金鑰只存雜湊
- 桌面版只接受本機連線；手機遠端需要配對碼，猜錯 10 次自動換碼

## 授權

MIT
