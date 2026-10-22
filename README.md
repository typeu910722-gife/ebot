# OCTA｜奧克塔

用聊天介面指揮多個 AI 機器人。機器人在**你自己的電腦**上工作，用的是你自己的訂閱方案，不用另外付 API 費用。每個機器人可以選：

| AI 引擎 | 需要安裝的工具 | 登入方式 |
| --- | --- | --- |
| Claude | [Claude Code](https://code.claude.com) | `claude` → `/login`（Pro / Max） |
| ChatGPT | [Codex CLI](https://developers.openai.com/codex/cli) | `codex` → Sign in with ChatGPT |
| Gemini | [Antigravity CLI](https://antigravity.google/docs/cli)（`agy`） | `agy` → Google 帳號（免費帳號可用） |
| Grok Bot（帶入你在 Grok Bot 的機器人） | [grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli)（第三方）＋ Grok Bot 桌面 App | 先登入 Grok Bot App |
| 本機開源模型（免費，不接付費 API） | [Ollama](https://ollama.com) ＋ [OpenCode](https://opencode.ai) | `ollama pull qwen3`，機器人模型填 `qwen3` |

## 快速開始（桌面版，推薦）

1. 安裝至少一個 AI 工具並登入（見上表，預設用 Claude）
2. 安裝 [Google Chrome](https://www.google.com/chrome/)
3. 下載 [OCTA-Setup.exe](https://github.com/typeu910722-gife/octa/releases/latest/download/OCTA-Setup.exe) 並安裝（或到 [octa.yzprojecttw.com](https://octa.yzprojecttw.com) 首頁按下載）
4. 打開 OCTA，照「設定指引」完成，選一個範本試跑

打開後登入 OCTA 帳號，這台電腦就是**主機**，負責執行所有機器人；手機、平板和其他電腦打開網頁版（octa.yzprojecttw.com）登入同一個帳號就能即時指揮、收通知。多台電腦都裝了 OCTA 時只有主機接工作，可在「設定 → 電腦與主機」切換。不想註冊也可以選「離線模式」，資料只存在這台電腦。第一次執行時 Windows 若顯示「Windows 已保護您的電腦」，按「其他資訊 → 仍要執行」（安裝檔未簽章）。

## 能做什麼

- **機器人**：每個機器人有自己的指定任務，並可選 Claude、ChatGPT、Gemini、Ollama 本機模型，或帶入 Grok Bot 的機器人
- **群組**：把機器人拉進群組依序協作，或用 `@名字` 指定誰做
- **分區**：區隔不同門市或專案；同分區的機器人可以互相詢問
- **例行任務**：每天固定時間自動執行，可隨時開關；可選雲端排程（主機離線時排隊並通知）或電腦排程
- **瀏覽器**：每個機器人可用自己的獨立 Chrome（分頁、登入分開），或「使用我的 Chrome」直接用你已登入的網站與已儲存的密碼（透過 [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)，每個機器人有自己的分頁群組）；最多 3 個同時工作
- **用聊天交代**：建立機器人只要取名字，直接傳訊息說要做什麼，它會自己整理成指定任務、建好例行任務（每天幾點或每隔幾分鐘）
- **自主工作**：自己規劃步驟一路做完，做完列出需要你決定的事；登入時把它的瀏覽器叫到螢幕上幫它登入再按「繼續」
- **記憶與技能**：📌 記住你的偏好和規則；🧩 把做順的流程存成技能，輸入 / 叫出指令選單
- **核准按鈕**：發訊息、付款這類動作先擬好等你核准，可選「只這次」「一律允許」或「拒絕」；清單上會標「待你處理」
- **檔案存在主機電腦**：附件、截圖、機器人放進「輸出」的檔案都存在主機的 OCTA 資料夾（每個機器人／群組一個資料夾，可互相讀取），也能改存到 Google 雲端硬碟；手機要看時即時從主機讀取
- **即時更新**：長輪詢，指示和回覆馬上出現；每個裝置都能跳通知
- **帳號安全**：裝置清單（輸入密碼移除）、修改密碼、重設碼、登入失敗鎖定
- **AI 剩餘流量**：AI 連線頁顯示 Claude、ChatGPT 方案剩餘比例，其他顯示 OCTA 今日使用次數
- **分區資料／共用資料**：寫一次，機器人都會讀
- **通知**：需要你處理時，跳電腦通知，也可以送到 Telegram 或 LINE
- **離線模式手機遙控**：離線模式下，設定 → 電腦與主機 → 手機遠端，用網址加 8 碼配對碼連進來
- **工作紀錄**：每次執行的結果與花費時間
- **多語介面**：繁體中文、English、简体中文、日本語（機器人也會用你選的語言回覆）

## 雲端版（多帳號，自己架）

適合想用網址登入、多人各自使用的情況。網站只負責存資料與排隊，AI 仍在每個人自己的電腦上執行。

```
手機 / 電腦瀏覽器 ─► Cloudflare Pages（網頁 + API）─► D1 資料庫
                              ▲
                              │ 長輪詢領任務（有變動立刻回應）、回寫結果
                    使用者電腦上的 octa-runner.mjs
                              │
                    claude -p ＋ 每個機器人的專屬 Chrome
```

1. Fork 這個倉庫
2. 建資料庫：
   ```
   npx wrangler d1 create octa
   npx wrangler d1 execute octa --remote --file schema.sql
   ```
3. 把 `wrangler.toml` 的 `database_name`、`database_id` 換成你的
4. Cloudflare → Workers 和 Pages → 建立 → Pages → 連接 Git，選你的 fork，其他保持預設
5. 例行任務的雲端排程靠 `.github/workflows/cron.yml` 每 5 分鐘呼叫 `/api/cron`；網址不是 octa.yzprojecttw.com 的話，在 GitHub 倉庫設定變數 `OCTA_URL`
6. `wrangler.toml` 可調整 `TZ_OFFSET_MIN`（例行任務時區）、`ALLOW_SIGNUP`（是否開放註冊）、`DOWNLOAD_URL`（首頁下載按鈕）

使用者登入後，照網站上的「設定指引」下載執行器並連線（需要 Node 18+）。

## 開發

```
# 雲端版
npx wrangler d1 execute <你的資料庫名稱> --local --file schema.sql
npx wrangler pages dev

# 桌面版
cd desktop
npm install
npm run serve      # 用 Node 直接跑，自動打開瀏覽器
npm start          # Electron 視窗
npm run dist       # 打包 Windows 安裝檔（Linux 需要 wine64 + wine32）
```

在 Actions 執行「Desktop build」（或推送 `v*` 標籤），會在 Windows 上打包並發布成最新 Release；版本號取自 `desktop/package.json`。

| 路徑 | 內容 |
| --- | --- |
| `public/index.html` | 網頁介面（雲端版與桌面版共用） |
| `functions/api/[[path]].js` | API（雲端版與桌面版共用） |
| `public/octa-runner.mjs` | 執行器：領任務、呼叫 Claude Code、管理每個機器人的瀏覽器 |
| `desktop/` | 桌面版：本機 SQLite、Electron 視窗、手機遠端 |
| `schema.sql` | 資料表 |
| `public/i18n-core.js`、`i18n/` | 多語介面：在 `i18n/strings.py` 加翻譯，執行 `python3 i18n/build.py` 產生字典 |

## 安全

- 機器人預設不替你發訊息、付款、刪資料，會先請你核准
- 執行器只允許瀏覽器、網路查詢，以及機器人自己資料夾內的讀寫
- 雲端版密碼以 PBKDF2 儲存，登入與執行器金鑰只存雜湊
- 桌面版只接受本機連線；手機遠端需要配對碼，猜錯 10 次自動換碼

## 授權

MIT
