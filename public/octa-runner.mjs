#!/usr/bin/env node
// OCTA runner — runs on your own computer and uses the AI tools you're signed in to.
// Each bot gets its own browser window with its own profile (separate logins, cookies, tabs),
// so several bots can work at the same time without touching each other.
// Files (attachments, screenshots, what bots make) are kept on this computer in the OCTA file folder,
// one folder per bot or group; bots may read each other's folders.
//
// One computer per account is the 主機 (host) and does the work; others wait on standby.
//
// CLI (cloud version):
//   first time:  node octa-runner.mjs <網站網址> <執行器金鑰>
//   afterwards:  node octa-runner.mjs
// The desktop app imports startRunner() instead.
// Requires: Node 18+, at least one AI CLI (Claude Code, Codex, Gemini…), Google Chrome.

import { spawn, spawnSync, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, copyFileSync, openSync, closeSync, lstatSync } from 'node:fs';
import { dirname, join, extname, basename, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const VERSION = '15.7';
const PW_MCP = '@playwright/mcp@0.0.83';
const WIN = process.platform === 'win32';
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const CHUNK = 900_000;

let cfg = {}, workDir = '', MAX = 3, log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// tools installed after the app started aren't on its PATH yet; add the usual install folders
if (WIN) {
  const add = [join(os.homedir(), '.local', 'bin'), join(process.env.APPDATA || '', 'npm'), join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama'), join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'), join(process.env.LOCALAPPDATA || '', 'cursor-agent')];
  process.env.PATH = [...add.filter(p => !(process.env.PATH || '').includes(p)), process.env.PATH].join(';');
}

async function api(path, body, method = 'POST', signal) {
  const r = await fetch(cfg.url + '/api/' + path, {
    method, signal,
    headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: 'Bearer ' + cfg.token } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

// ---------- file folder (attachments, screenshots, outputs) ----------
export const storeDir = () => (cfg.getStore ? cfg.getStore() : cfg.store) || join(cfg.home || '.', 'files');
const safeName = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 60) || '未命名';
const shortId = id => String(id).replace(/^g-/, '').replace(/[^\w]/g, '').slice(0, 8);
// one folder per bot or group, named "名稱_編號"; renamed when the bot is renamed
function convDir(conv) {
  const root = storeDir(), tag = '_' + shortId(conv.id), want = join(root, safeName(conv.name) + tag);
  mkdirSync(root, { recursive: true });
  if (!existsSync(want)) {
    const old = readdirSync(root).find(f => f.endsWith(tag));
    if (old) { try { renameSync(join(root, old), want); } catch { return join(root, old); } }
  }
  for (const sub of ['附件', '截圖', '輸出']) mkdirSync(join(want, sub), { recursive: true });
  return want;
}
const rel = p => relative(storeDir(), p).split(sep).join('/');
function freeName(dir, name) {   // don't overwrite: "報表.xlsx" → "報表 (2).xlsx"
  const ext = extname(name), base = name.slice(0, name.length - ext.length);
  let p = join(dir, name);
  for (let i = 2; existsSync(p); i++) p = join(dir, `${base} (${i})${ext}`);
  return p;
}
// an uploaded file → this computer's folder; the cloud copy is then deleted
async function saveUpload(f) {
  const d = await api('file/' + f.id, null, 'GET');
  const dir = join(convDir({ id: f.conv, name: f.convName || f.conv }), '附件');
  const p = freeName(dir, safeName(f.name || d.name));
  const buf = Buffer.from(d.data, 'base64');
  writeFileSync(p, buf);
  await api('runner/stored', { id: f.id, path: rel(p), size: buf.length });
  log(`📥 已存到電腦：${rel(p)}`);
  return p;
}
// someone opened a file that lives here: send a temporary copy
async function sendCopy(f) {
  const p = join(storeDir(), String(f.path || ''));
  if (!f.path || !existsSync(p)) return api('runner/blob', { id: f.id, missing: true });
  const data = readFileSync(p).toString('base64');
  for (let i = 0, n = 0; i < data.length || n === 0; i += CHUNK, n++)
    await api('runner/blob', { id: f.id, n, data: data.slice(i, i + CHUNK), last: i + CHUNK >= data.length });
}

// ---------- per-bot workspace (browser profile and AI tool settings) ----------
const extToken = () => (cfg.getExtToken ? cfg.getExtToken() : cfg.extToken) || '';
// mode 'own': the bot's own Chrome profile (separate logins). mode 'mine': the user's real Chrome through the
// Playwright Extension, so saved logins and passwords work; each bot gets its own tab group there.
function botDir(id, mode = 'own', port = 0) {
  const safe = String(id).replace(/[^\w-]/g, '');
  const dir = join(workDir, 'bots', safe);
  mkdirSync(join(dir, 'shots'), { recursive: true });
  const profile = join(dir, 'profile');
  const mine = mode === 'mine';
  const pwArgs = mine ? ['--extension', '--output-dir', join(dir, 'shots')]
    : port ? ['--cdp-endpoint', `http://127.0.0.1:${port}`, '--output-dir', join(dir, 'shots')]   // the bot's own browser that stays open
    : ['--browser', 'chrome', '--user-data-dir', profile, '--output-dir', join(dir, 'shots')];
  const env = { ...(cfg.pwCli ? cfg.nodeEnv || {} : {}), ...(mine && extToken() ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: extToken() } : {}) };
  const server = cfg.pwCli
    ? { command: cfg.nodeBin || process.execPath, args: [cfg.pwCli, ...pwArgs], env }   // bundled (desktop app)
    : WIN ? { command: 'cmd', args: ['/c', 'npx', '-y', PW_MCP, ...pwArgs], env } : { command: 'npx', args: ['-y', PW_MCP, ...pwArgs], env };
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { browser: server } }, null, 2));
  // the same browser server, in each CLI's own config format
  const put = (f, o) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), JSON.stringify(o, null, 2)); };
  put('.gemini/settings.json', { mcpServers: { browser: { ...server, timeout: 60000, trust: true } } });
  put('.agents/mcp_config.json', { mcpServers: { browser: { ...server } } });   // Antigravity CLI (agy)
  put('.qwen/settings.json', { mcpServers: { browser: { ...server, timeout: 60000, trust: true } } });
  put('.cursor/mcp.json', { mcpServers: { browser: server } });
  put('.mcp.json', { mcpServers: { browser: server } });   // Grok CLI reads the project .mcp.json
  put('copilot-mcp.json', { mcpServers: { browser: { type: 'local', ...server, tools: ['*'] } } });
  return { dir, profile, server, put };
}
export function findChrome() {
  if (cfg.chrome && existsSync(cfg.chrome)) return cfg.chrome;
  const c = WIN ? [
    join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
  ] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return c.find(p => p && existsSync(p));
}
function newestImage(dir, since) {
  let best = null;
  const walk = d => {
    for (const f of readdirSync(d)) {
      if (f === 'profile') continue;
      const p = join(d, f), st = statSync(p);
      if (st.isDirectory()) { if (d === dir) walk(p); continue; }
      if (/\.(png|jpe?g|webp)$/i.test(f) && st.mtimeMs >= since && (!best || st.mtimeMs > best.t)) best = { p, t: st.mtimeMs, size: st.size };
    }
  };
  try { walk(dir); } catch { }
  return best;
}
function newFiles(dir, since) {   // what the bot put in its 輸出 folder during this job
  try {
    return readdirSync(dir).map(f => ({ f, p: join(dir, f) })).filter(x => { const st = statSync(x.p); return st.isFile() && st.mtimeMs >= since; })
      .slice(0, 8).map(x => ({ name: x.f, path: rel(x.p), size: statSync(x.p).size }));
  } catch { return []; }
}
const q = a => (WIN && /[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);

// ---------- prompts ----------
// said again right before the instruction: in groups, models (small ones especially) took on another member's name and duties
const whoAmI = job => { const E = ENGINES[job.bot.engine || 'claude'] || ENGINES.claude;
  return `提醒：你是「${job.bot.name}」，用的 AI 是 ${E.label}${job.bot.model ? `（${job.bot.model}）` : ''}。` + (job.group ? '對話裡其他機器人的發言是它們自己的，不是你的；不要用它們的名字、模型或任務介紹自己。' : ''); };
function buildPrompt(job, here) {
  const lines = [
    `你是 OCTA（奧克塔）裡的機器人「${job.bot.name}」，在使用者自己的電腦上執行。`,
    job.bot.task ? `你的指定任務：${job.bot.task}` : '你還沒有指定任務：從使用者的訊息了解你要長期負責什麼。'
  ];
  if (job.group) lines.push(
    `你在群組「${job.group.name}」，成員依序為：${job.group.members.join('、')}。`,
    job.group.task ? `群組協作規則：${job.group.task}` : '群組沒有特別規則：依各成員的指定任務分工。',
    '只做你自己負責的部分，可以引用其他成員在對話裡交出的資料。',
    ...(job.group.mode === 'parallel' && !String(job.prompt || '').includes('@' + job.bot.name) ? ['成員是同時收到這則訊息、各自並行處理的。先判斷這則訊息該不該由你處理：跟你的職責無關、或別的成員明顯更適合時，整則回覆只寫「（略過）」；問整個群組的（例如大家自我介紹）就要回答。'] : []),
    ...(job.canAsk ? ['需要其他成員的資料或幫忙時，單獨一行寫「@成員名 你的問題」，系統會請對方回答再叫你回來繼續；整件工作交給更適合的成員時寫「@成員名 交接：要做的事」，交出去後你就不用再做。'] : []),
    '資訊不夠、會影響結果時，直接問使用者並停下等回覆，不要亂猜。'
  );
  if (job.colleagues?.length && !job.group) {
    lines.push('OCTA 裡的其他機器人同事（像全天待命的員工，可以在背景互相幫忙）：');
    for (const c of job.colleagues) lines.push(`- ${c.name}：${c.task || '（還沒有指定任務）'}`);
    if (job.canAsk) lines.push('需要同事的資料或幫忙時，單獨一行寫「@同事名 你的問題」，系統會在背景傳給對方，對方回答後自動叫你繼續；整件事交給更適合的同事做，寫「@同事名 交接：要做的事」，對方做完會回報給你。不需要就不要寫。');
  }
  lines.push('', '你的運作環境（使用者問到你用什麼 AI、方案、還剩多少流量時，照這些資料回答，不要說你查不到）：', ...aboutMe(job));
  if (job.memory?.length) lines.push('', '你記得的事（之前學到的偏好和重要事實；重要決定前仍要到來源確認最新狀況）：', ...job.memory.map(m => '- ' + m));
  if (job.skills?.length) lines.push('', '你會的技能（使用者說「執行技能 X」或要做相同的事時，照步驟做）：', ...job.skills.map(k => `【${k.name}】\n${k.steps}`));
  if (job.notes) lines.push('', '共用資料（所有機器人都要知道）：', job.notes);
  if (job.folderNotes) lines.push('', `分區「${job.folder}」的資料：`, job.folderNotes);
  lines.push(
    '',
    '檔案：',
    `- 這個對話的資料夾：${here}（附件在「附件」，截圖在「截圖」）。`,
    `- 要交給使用者的檔案（報表、圖片、文件）存到 ${join(here, '輸出')}，會自動附在你的回覆裡。`,
    `- 其他機器人和群組的資料夾都在 ${storeDir()} 底下（名稱_編號），需要時可以讀取別人的檔案，但不要改動或刪除別人的檔案。`,
    '',
    '工作方式（像一個能自己做事的助理）：',
    '- 理解目標後，自己規劃步驟並一路做完，不要每一步都停下來問。為了完成工作需要的查看動作（打開網頁、點開對話、讀訊息、翻頁、下載報表）直接做。',
    '- 做完先講結果，再列出「需要你決定的事」，每一項附上你的建議做法。',
    '- 主動做下一步：根據指定任務推斷接下來應該做什麼。在允許範圍內就直接做；需要核准的事（例如回覆客人）先把內容擬好，用 ✅待確認 讓使用者一鍵核准。例如看到未回覆的客人訊息，就點開讀完、擬好回覆。',
    '- 指定任務太簡短或模糊時（只有幾個字），根據你看到的實際情況推斷完整的工作內容，用 📝任務更新 寫出來，並提出合適的例行任務。',
    '- 記住長期有用的事：使用者說了穩定的偏好、規則或重要事實（例如「回覆客人要用敬語」「302 房冷氣壞了」），在回覆最後加一行「📌記住：一句話」。一次性的事不要記。',
    '- 存成技能：使用者說「把這個流程存起來／存成技能」，或同一套步驟你已經做順了，在回覆最後寫「🧩技能：技能名稱」，換行後條列每個步驟（去哪裡、點什麼、怎麼判斷、輸出什麼），最後一行寫「🧩結束」。',
    '',
    '規則：',
    `- 用${({ 'zh-TW': '繁體中文', 'zh-CN': '簡體中文', en: '英文（English）', ja: '日文（日本語）' })[job.lang] || '繁體中文'}回覆，簡潔、先給結果。你的最後輸出會原封不動顯示成聊天訊息。`,
    job.bot.browser === 'mine'
      ? '- 需要操作網站時，用 browser 工具。這是使用者自己的 Chrome（有他已登入的網站和已儲存的密碼）。只在你自己的分頁群組裡操作，不要關閉或改動使用者其他分頁。遇到登入頁時，點帳號欄位，從 Chrome 跳出的已儲存帳號中選一個讓它自動填入；不要自己猜或輸入密碼。'
      : '- 需要操作網站時，用 browser 工具。這是你專屬、一直開著的瀏覽器（獨立的登入和分頁，上次開的分頁都還在，可以接著用），不會影響其他機器人。使用者有時會在同一個視窗旁觀或幫你登入。',
    job.bot.page ? `- 你上次停在：${job.bot.page}` : '',
    '- 登入頁只要點選已經記住的帳號（例如顯示帳號名稱和「登入」按鈕、「以 XX 身分繼續」），不必輸入密碼或驗證碼時，直接點它繼續。',
    '- 需要輸入帳號密碼、驗證碼或手機確認時，停在那一頁，回報「需要使用者在電腦上登入」（照抄這幾個字）和要登入的網站。使用者會把你的瀏覽器叫到螢幕上幫你登入，再叫你繼續。',
    '- 發訊息給任何人、付款、刪除資料、更改帳號設定：除非使用者在對話中明確下令，否則只準備好內容並請使用者確認，不要執行。',
    '- 需要使用者核准才能做的事，在回覆最後單獨一行寫「✅待確認：要做的事（一句話）」（「✅待確認：」這幾個字照抄，不要翻譯），然後停下。使用者回「核准：…」後才執行。',
    ...(job.allowed?.length ? ['- 使用者已經「一律允許」你做下面這些事：遇到同一類的事直接做，不用再寫 ✅待確認，做完在回覆裡清楚列出做了什麼（對象、數量、內容）。只限這些事本身，不要擴大解讀；付款、刪除資料、更改帳號設定仍然每次都要問：', ...job.allowed.map(t => '  · ' + t)] : []),
    '- 只回報實際完成的事，做不到就直說。',
    `- 自動排程：使用者要你定時或持續做某件事（每天幾點、每隔多久巡一次）時，不要叫他自己去設定，在回覆最後加一行「⏰例行任務：名稱｜時間｜每次要做的事」。時間寫法：每天固定時間用 24 小時制（08:00,13:30），每隔一段時間寫「每30分鐘」或「每2小時」，兩種可以並用。例如「⏰例行任務：巡 LINE 訊息｜每30分鐘｜檢查 LINE 官方帳號新訊息，擬好回覆給我確認」（「⏰例行任務：」和「｜」照抄）。要「有新東西才做」時，時間欄寫「每10分鐘監看 網址」（系統會不花 AI 流量地檢查那個網頁，內容有變化才叫你），或寫「外部事件」（給一個觸發網址讓 LINE、表單等服務呼叫）。系統會自動建立；同名的會更新。你的任務本身就是要持續盯著某個地方（訊息、訂單、後台）時，主動建議並建立一個每隔一段時間的例行任務。${job.routines?.length ? '這個對話已經有的例行任務：' + job.routines.map(r => `${r.name}（${r.times.map(t => t.startsWith('*/') ? `每 ${t.slice(2)} 分鐘` : t).join('、')}${r.enabled ? '' : '，已停用'}）`).join('；') + '。' : ''}`,
    '- 自動整理指定任務：當使用者在對話中說明你長期要負責的工作、固定做法、規則或排程（不是一次性的小請求）時，在回覆最後加上：「📝任務更新：」換行後寫出完整、更新後的指定任務（把原本的任務和新的說明合併成一份，條列清楚：負責什麼、去哪裡做、怎麼做、結果怎麼回報、要注意的規則），最後一行寫「📝結束」。這兩個標記照抄。沒有新的長期工作說明就不要寫。',
    job.bot.livePort ? '' : '- 若這次有用瀏覽器：結束前用 browser_take_screenshot 截目前畫面（type 設 jpeg，filename 設 last.jpeg），並在回覆最後一行寫「📍 目前頁面：網址」。',
    '',
    '對話紀錄（舊到新）：'
  );
  // older messages are shortened; the last few stay whole
  // small local models (Ollama) get a shorter history: they are slower and get confused by long conversations
  const small = (job.bot.engine || 'claude') === 'opencode', hist = small ? job.history.slice(-8) : job.history, cut = small ? 300 : 600;
  hist.forEach((h, i) => {
    const recent = i >= hist.length - (small ? 2 : 4), t = recent || h.text.length <= cut ? h.text : h.text.slice(0, cut) + '…（較早的訊息，已截短）';
    lines.push(`【${h.who}】${t}` + (h.paths?.length ? `\n（附件，可直接讀取這些檔案：${h.paths.join('、')}）` : ''));
  });
  lines.push('', ...tabsNow(job), '', '先判斷這則指示的類型：(1) 只問你的設定、任務內容、AI 方案 → 直接回答，不用工具。(2) 問到網頁上、畫面上、帳號裡現在的狀況（例如「你看到什麼」「現在有幾則訊息」），或使用者說他幫你打開、登入好了 → 先用 browser_snapshot 看你瀏覽器目前的分頁再回答，不要說你還沒看。(3) 要你做事 → 直接動手做。', '', whoAmI(job), '現在請處理這則指示：', job.prompt);
  return lines.filter(l => l !== '').join('\n');
}

// what the bot runs on and how much of the plan is left, for the prompt
const PLAN_NOTE = { grokbot: 'Grok Bot 方案（在 xAI 雲端電腦上工作，用量看 Grok Bot App 的 Usage）', grok: 'Grok（xAI）帳號（官方沒有提供剩餘量查詢）', gemini: 'Google 帳號的 Antigravity 額度（免費帳號也能用；在 agy 裡輸入 /usage 可查剩餘量）', copilot: 'GitHub Copilot 訂閱（GitHub 沒有提供剩餘量查詢）', cursor: 'Cursor 訂閱（Cursor 沒有提供剩餘量查詢）', qwen: 'Qwen 帳號（官方沒有提供剩餘量查詢）', opencode: '電腦本機的 Ollama 模型，免費、沒有流量限制' };
// the tabs open in the bot's browser right now (the user may have just opened or signed in to one)
function tabsNow(job) {
  const t = job.bot.tabs;
  if (!t) return [];
  if (!t.length) return ['你的瀏覽器目前沒有開著的網頁。'];
  return ['你的瀏覽器目前開著的分頁（使用者可能剛幫你打開或登入好）：', ...t.map((x, i) => `${i + 1}. ${x.title || '(無標題)'} — ${x.url}`)];
}
function aboutMe(job) {
  const e = job.bot.engine || 'claude', E = ENGINES[e] || ENGINES.claude, u = usageNow[e];
  const out = [`- AI：${E.label}${job.bot.model ? `，模型 ${job.bot.model}` : '（該工具的預設模型）'}；在使用者的主機電腦「${os.hostname()}」上執行，透過 OCTA 執行器 v${VERSION}。`];
  const when = t => { try { return new Date(t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return t; } };
  if (u?.windows?.length) {
    const lab = { '5h': '5 小時額度', '7d': '本週額度', '30d': '本月額度' };
    out.push(`- 方案：${u.plan || '（讀不到方案名稱）'}`);
    for (const w of u.windows) out.push(`- ${lab[w.k] || (/^\d+h$/.test(w.k) ? parseInt(w.k) + ' 小時額度' : w.k)}：已用 ${w.used}%，剩 ${Math.max(0, 100 - w.used)}%${w.reset ? `，${when(w.reset)} 重置` : ''}`);
    out.push(`- 以上是 ${when(u.t)} 讀到的數字（每 10 分鐘更新）。`);
  } else if (e === 'claude' || e === 'codex') {
    out.push(`- 方案：${u?.plan || '讀不到'}；剩餘流量這次讀不到${u?.error ? `（${u.error}）` : ''}，請使用者到 OCTA「設定 → AI 連線」查看。`);
  } else out.push(`- 方案：${PLAN_NOTE[e] || '官方沒有提供剩餘量查詢'}`);
  if (job.usageToday != null) out.push(`- 今天 OCTA 已經用這個 AI 執行了 ${job.usageToday} 次工作。`);
  return out;
}

// install: { win, mac } shell commands, or npm: package name (needs Node.js); pre: installed first; login: command that starts sign-in
export const ENGINES = {
  claude: { label: 'Claude Code', bin: 'claude', site: 'https://code.claude.com', login: 'claude', loginHint: '視窗出現後輸入 /login，選 Claude 訂閱帳號',
    install: { win: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"', mac: 'curl -fsSL https://claude.ai/install.sh | bash' },
    paths: { win: '%USERPROFILE%\\.local\\bin', mac: '$HOME/.local/bin' } },
  codex: { label: 'Codex CLI（ChatGPT）', bin: 'codex', site: 'https://developers.openai.com/codex/cli', npm: '@openai/codex', login: 'codex login', loginHint: '瀏覽器會打開，用 ChatGPT 帳號登入' },
  // Google moved personal accounts from Gemini CLI to the Antigravity CLI (agy) in June 2026; the key stays 'gemini' so existing bots keep working
  gemini: { label: 'Antigravity CLI（Gemini／Claude）', bin: 'agy', site: 'https://antigravity.google/docs/cli', login: 'agy', loginHint: '瀏覽器會打開，用 Google 帳號登入（免費帳號也可以），完成後輸入 /quit 離開',
    install: { win: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://antigravity.google/cli/install.ps1 | iex"', mac: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    paths: { win: '%USERPROFILE%\\.local\\bin', mac: '$HOME/.local/bin' } },
  copilot: { label: 'GitHub Copilot CLI', bin: 'copilot', site: 'https://github.com/github/copilot-cli', npm: '@github/copilot', login: 'copilot', loginHint: '視窗出現後輸入 /login，用 GitHub 帳號登入' },
  cursor: { label: 'Cursor CLI', bin: 'agent', site: 'https://cursor.com/cli', login: 'agent login', loginHint: '瀏覽器會打開，用 Cursor 帳號登入',
    install: { win: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm \'https://cursor.com/install?win32=true\' | iex"', mac: 'curl https://cursor.com/install -fsS | bash' },
    paths: { win: '%LOCALAPPDATA%\\cursor-agent', mac: '$HOME/.local/bin' } },
  qwen: { label: 'Qwen Code', bin: 'qwen', site: 'https://github.com/QwenLM/qwen-code', npm: '@qwen-code/qwen-code', login: 'qwen', loginHint: '依畫面選擇登入方式，完成後輸入 /quit 離開' },
  // local open models only — no paid API keys. OpenCode drives the model and the browser tool; Ollama runs the model.
  grok: { label: 'Grok CLI（xAI）', bin: 'grok', site: 'https://docs.x.ai/build/overview', login: 'grok login', loginHint: '瀏覽器會打開，用你的 X／Grok 帳號登入',
    install: { win: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"', mac: 'curl -fsSL https://x.ai/cli/install.sh | bash' } },
  // a bot from the user's Grok Bot app, driven through the open-source grok-bot-cli (third party, not by xAI);
  // it uses the signed-in Grok Bot desktop app on this computer
  grokbot: { label: 'Grok Bot（grok-bot-cli）', bin: 'gbot', site: 'https://github.com/ScriptedAlchemy/grok-bot-cli', npm: 'grok-bot-cli',
    login: 'gbot bots list', loginHint: '先在這台電腦安裝並登入 Grok Bot 桌面 App；這裡會列出你的 Grok Bot 機器人' },
  opencode: { label: 'Ollama 本機模型', bin: 'opencode', also: 'ollama', site: 'https://ollama.com', npm: 'opencode-ai',
    pre: { win: 'winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements', mac: 'brew install --cask ollama' },
    paths: { win: '%LOCALAPPDATA%\\Programs\\Ollama', mac: '/usr/local/bin' },
    login: 'ollama pull qwen3', loginHint: '正在下載 qwen3 模型（約 5 GB），完成後機器人的「模型」填 qwen3' }
};
const FILE_INSTR = '請先完整讀取目前資料夾裡的 octa-task.md，依照裡面的指示執行。最後的輸出要直接是給使用者看的回覆。';
const STDIN_INSTR = '請依照標準輸入中的完整指示執行，最後輸出要給使用者看的回覆。';
// Windows consoles often answer in the local code page (e.g. Big5), not UTF-8
function decode(chunks) {
  const buf = Buffer.concat(chunks), utf = buf.toString('utf8');
  if (!WIN || !utf.includes('�')) return utf;
  for (const enc of ['big5', 'gbk', 'shift_jis']) { try { const t = new TextDecoder(enc).decode(buf); if (!t.includes('�')) return t; } catch { } }
  return utf;
}
const installed = {};
// Windows: tools installed after OCTA started aren't on its PATH; re-read the saved PATH now and then
let pathRead = 0;
function refreshPath() {
  if (!WIN || Date.now() - pathRead < 120000) return Promise.resolve();
  pathRead = Date.now();
  return new Promise(ok => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"],
    { windowsHide: true, timeout: 20000 }, (err, out) => {
      if (!err && out) {
        const have = new Set(String(process.env.PATH || '').toLowerCase().split(';'));
        const more = String(out).trim().split(';').map(p => p.replace(/%([^%]+)%/g, (_, v) => process.env[v] || '')).filter(p => p && !have.has(p.toLowerCase()));
        if (more.length) process.env.PATH = process.env.PATH + ';' + more.join(';');
      }
      ok();
    }));
}
// looks through PATH itself instead of running `where` for each tool: running many `where` at once
// sometimes timed out on Windows, which made AIs flip between connected and not connected
function findBin(bin) {
  const dirs = String(process.env.PATH || '').split(WIN ? ';' : ':').filter(Boolean);
  const exts = WIN ? ['', ...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)] : [''];
  for (const d of dirs) for (const x of exts) { const p = join(d.replace(/^"|"$/g, ''), bin + x); try { if (existsSync(p) && (WIN ? x !== '' : true)) return p; } catch { } }
  return '';
}
// async on purpose: a blocking check freezes the desktop app's window
export async function has(bin, fresh) {   // a missing command can't be told apart from a failing one after the fact, so check first
  const c = installed[bin];
  if (!fresh && c && (c.ok || Date.now() - c.t < 30000)) return c.ok;
  if (!c?.ok) await refreshPath();
  const p = findBin(bin);
  installed[bin] = { ok: !!p, t: Date.now(), path: p };
  return !!p;
}
const engineReady = async (k, fresh) => (await has(ENGINES[k].bin, fresh)) && (!ENGINES[k].also || await has(ENGINES[k].also, fresh))
  && (k !== 'grokbot' || !grokBotEnv().missing);   // Grok Bot: the tool alone isn't enough, the app's sign-in must be readable
let lastReport = 0;
const engineReport = async () => {   // tell the app which AI tools this computer has, about once a minute
  if (Date.now() - lastReport < 60000) return undefined;
  lastReport = Date.now();
  const keys = Object.keys(ENGINES), oks = await Promise.all(keys.map(k => engineReady(k, true)));
  return Object.fromEntries(keys.map((k, i) => [k, oks[i]]));
};

// ---------- how much of each plan is left ----------
// Claude and ChatGPT report their plan limits; the others don't offer a way to ask.
async function claudeUsage() {
  const f = join(os.homedir(), '.claude', '.credentials.json');
  if (!existsSync(f)) return { error: 'no-credentials' };   // e.g. kept in the macOS keychain
  const o = JSON.parse(readFileSync(f, 'utf8'))?.claudeAiOauth || {}, tok = o.accessToken;
  if (!tok) return { error: 'no-credentials' };
  const plan = { max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise' }[String(o.subscriptionType || '').toLowerCase()] || (o.subscriptionType ? 'Claude ' + o.subscriptionType : '');
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { authorization: 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) return { error: 'HTTP ' + r.status, plan };
  const d = await r.json();
  const w = (x, k) => (x && typeof x.utilization === 'number' ? { k, used: Math.round(x.utilization), reset: x.resets_at || null } : null);
  return { plan, windows: [w(d.five_hour, '5h'), w(d.seven_day, '7d')].filter(Boolean) };
}
function codexPlan() {   // ChatGPT plan from the sign-in Codex saved (only the plan label is read)
  try {
    const a = JSON.parse(readFileSync(join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
    const p = JSON.parse(Buffer.from(String(a?.tokens?.id_token || '').split('.')[1] || '', 'base64url').toString())['https://api.openai.com/auth']?.chatgpt_plan_type;
    return p ? 'ChatGPT ' + p[0].toUpperCase() + p.slice(1) : '';
  } catch { return ''; }
}
// label a quota window by its real length (the free ChatGPT plan has a monthly window, not 5 hours)
const winKey = (m, k) => !m ? k : m <= 1440 ? (m === 300 ? '5h' : Math.round(m / 60) + 'h') : m <= 10080 ? '7d' : '30d';
function codexUsage() {   // `codex app-server` answers account/rateLimits/read over JSON-RPC
  return new Promise(resolve => {
    let done = false, buf = '';
    const child = spawn('codex', ['app-server'], { shell: WIN, windowsHide: true });
    const finish = v => { if (done) return; done = true; clearTimeout(t); try { child.kill(); } catch { } resolve(v); };
    const t = setTimeout(() => finish({ error: 'timeout' }), 15000);
    const send = o => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { } };
    child.on('error', () => finish(null));
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' }); }
        if (msg.id === 2) {
          const rl = msg.result?.rateLimits || msg.result || {};
          const w = (x, k) => (x && typeof x.usedPercent === 'number' ? { k: winKey(x.windowDurationMins, k), used: Math.round(x.usedPercent), reset: x.resetsAt ? new Date(x.resetsAt * (x.resetsAt < 1e12 ? 1000 : 1)).toISOString() : null } : null);
          finish(msg.error ? { error: msg.error.message || 'error', plan: codexPlan() } : { plan: codexPlan() || (rl.planType ? 'ChatGPT ' + rl.planType : ''), windows: [w(rl.primary, '5h'), w(rl.secondary, '7d')].filter(Boolean) });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'octa', title: 'OCTA', version: VERSION } } });
  });
}
// which models each AI on this computer offers (for the model menu); asked from the tools that can list them
const runText = (bin, args) => new Promise(ok => execFile(bin, args, { shell: WIN, windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 4 << 20 }, (e, out, err) => ok(e ? '' : String(out || '') + String(err || ''))));
let lastModels = 0;
async function modelReport() {   // every 30 minutes
  if (Date.now() - lastModels < 30 * 60000) return undefined;
  lastModels = Date.now();
  const out = {};
  if (await has('ollama')) out.opencode = (await runText('ollama', ['list'])).split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean).slice(0, 30);
  if (await has('agent')) {
    const t = (await runText('agent', ['--list-models'])).replace(/\x1b\[[0-9;]*m/g, '');
    out.cursor = [...new Set(t.split('\n').map(l => (l.match(/^\s*(?:[-*•]\s*)?([a-z0-9][\w.\-]{2,40})(?:\s|$)/i) || [])[1]).filter(x => x && /\d|-/.test(x)))].slice(0, 30);
  }
  if (await has('agy')) {
    const t = (await runText('agy', ['models'])).replace(/\x1b\[[0-9;]*m/g, '');
    out.gemini = [...new Set(t.split("\n").map(l => (l.match(/^\s*([a-z][\w.\-]*-[\w.\-]+)\s/i) || [])[1]).filter(Boolean))].slice(0, 30);   // agy also serves Claude and GPT-OSS models (separate weekly quota)
  }
  if (await has('gbot')) { try { out.grokbot = (await grokBots()).map(b => b.name).slice(0, 40); } catch { } }
  if (await has('copilot')) {
    const t = await runText('copilot', ['--help']);
    const m = t.match(/--model[\s\S]{0,300}?choices:\s*([^)]+)\)/);
    if (m) out.copilot = [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]).slice(0, 40);
  }
  return out;
}
let lastUsage = 0, usageNow = {};
async function usageReport() {   // every 10 minutes
  if (Date.now() - lastUsage < 10 * 60000) return undefined;
  lastUsage = Date.now();
  const out = {};
  usageNow = out;   // bots read this to answer "how much quota is left" 
  const safe = async (k, fn) => { try { const v = (await engineReady(k)) ? await fn() : null; if (v) out[k] = { ...v, t: Date.now() }; } catch (e) { out[k] = { error: String(e.message || e).slice(0, 80), t: Date.now() }; } };
  await Promise.all([safe('claude', claudeUsage), safe('codex', codexUsage)]);
  return out;
}

// opts.onLine: called with each stdout line (live progress); opts.ctl.kill() stops the run
async function spawnCli(bin, args, dir, input, opts = {}) {
  if (!(await has(bin))) return { code: -1, out: '', err: '', missing: true };
  return new Promise(resolve => {
    const child = spawn(bin, WIN ? args.map(q) : args, { cwd: dir, shell: WIN, windowsHide: true });
    const out = [], err = [];
    let killed = false, part = '';
    if (opts.ctl) opts.ctl.kill = () => { try { WIN ? spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }) : child.kill(); } catch { } };
    const timer = setTimeout(() => { killed = true; child.kill(); }, JOB_TIMEOUT_MS);
    child.stdout.on('data', d => {
      out.push(d);
      if (!opts.onLine) return;
      part += d.toString('utf8');
      let i; while ((i = part.indexOf('\n')) >= 0) { const l = part.slice(0, i); part = part.slice(i + 1); try { opts.onLine(l); } catch { } }
    });
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: decode(out), err: e.message, missing: e.code === 'ENOENT' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: decode(out), err: decode(err) + (killed ? '\n執行超過 15 分鐘，已中止。' : '') }); });
    child.stdin.on('error', () => { });
    child.stdin.end(input);
  });
}
// tokens a run used: Claude reports them in its result; Codex prints "tokens used"
const claudeTokens = u => (u ? (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) : null);
const toml = v => (Array.isArray(v) ? '[' + v.map(x => JSON.stringify(String(x))).join(',') + ']' : JSON.stringify(String(v)));
// the model Ollama should use: the bot's, or the first one downloaded on this computer
function ollamaModel(model) {
  if (model) return model.replace(/^ollama\//, '');
  const r = spawnSync('ollama', ['list'], { encoding: 'utf8', shell: WIN, windowsHide: true, timeout: 10000 });
  return (r.stdout || '').split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]).find(Boolean) || '';
}
// what Claude Code is doing right now, in words, from its stream-json events
function describeTool(name, input = {}) {
  const n = String(name).replace(/^mcp__browser__/, '');
  const host = u => { try { return new URL(u).host; } catch { return String(u || '').slice(0, 40); } };
  const short = s => String(s || '').replace(/\s+/g, ' ').slice(0, 40);
  return ({
    browser_navigate: `打開 ${host(input.url)}`, browser_click: `點擊「${short(input.element)}」`, browser_type: `在「${short(input.element)}」輸入`,
    browser_fill_form: '填寫表單', browser_snapshot: '讀取網頁內容', browser_take_screenshot: '截圖', browser_select_option: '選擇選項',
    browser_tabs: '切換分頁', browser_wait_for: '等待網頁載入', browser_press_key: '按鍵盤', browser_navigate_back: '回上一頁', browser_evaluate: '讀取網頁資料',
    Read: `讀取檔案 ${basename(String(input.file_path || ''))}`, Write: `寫入檔案 ${basename(String(input.file_path || ''))}`, Edit: `修改檔案 ${basename(String(input.file_path || ''))}`,
    Glob: '找檔案', Grep: '搜尋檔案內容', WebSearch: `上網搜尋「${short(input.query)}」`, WebFetch: `讀取網頁 ${host(input.url)}`
  })[n] || (n.startsWith('browser_') ? '操作瀏覽器' : `使用 ${n}`);
}
async function runEngine(engine, prompt, b, model, live = {}) {
  let tokens = null;
  const { dir, server } = b;
  const store = storeDir();
  const m = (flag) => (model ? [flag, model] : []);
  writeFileSync(join(dir, 'octa-task.md'), prompt);   // for CLIs that take the prompt as an argument (avoids Windows length limits)
  let r, text;
  switch (engine) {
    case 'codex': {
      const last = join(dir, '.codex-last.txt');
      try { writeFileSync(last, ''); } catch { }
      const c = ['approval_policy="never"', `sandbox_workspace_write.writable_roots=${toml([store])}`,
        `mcp_servers.browser.command=${toml(server.command)}`, `mcp_servers.browser.args=${toml(server.args)}`,
        'mcp_servers.browser.startup_timeout_sec=60', 'mcp_servers.browser.default_tools_approval_mode="approve"',
        ...Object.entries(server.env || {}).map(([k, v]) => `mcp_servers.browser.env.${k}=${toml(v)}`)];
      r = await spawnCli('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir, '-o', last, ...m('-m'), ...c.flatMap(x => ['-c', x]), '-'], dir, prompt, { ctl: live.ctl });
      // Codex's sandbox isn't available on every Windows setup: run without it rather than not at all (other engines run unsandboxed too)
      if (r.code !== 0 && /sandbox/i.test(r.err || '')) r = await spawnCli('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-C', dir, '-o', last, ...m('-m'), ...c.flatMap(x => ['-c', x]), '-'], dir, prompt, { ctl: live.ctl });
      try { text = readFileSync(last, 'utf8').trim(); } catch { }
      break;
    }
    case 'gemini': r = await spawnCli('agy', ['-p', FILE_INSTR, '--dangerously-skip-permissions', '--output-format', 'text', '--print-timeout', '15m', '--add-dir', store, ...m('--model')], dir, '', { ctl: live.ctl }); break;
    case 'qwen': r = await spawnCli('qwen', ['--yolo', '--include-directories', store, ...m('-m'), '-p', STDIN_INSTR], dir, prompt, { ctl: live.ctl }); break;
    case 'copilot': r = await spawnCli('copilot', ['-p', FILE_INSTR, '-s', '--allow-all-tools', '--allow-all-paths', '--no-color',
      '--additional-mcp-config', '@' + join(dir, 'copilot-mcp.json'), ...m('--model')], dir, '', { ctl: live.ctl }); break;
    case 'grok': r = await spawnCli('grok', ['--no-auto-update', '--no-alt-screen', '--always-approve', '--cwd', dir, '--output-format', 'plain', ...m('-m'), '-p', FILE_INSTR], dir, '', { ctl: live.ctl }); break;
    case 'cursor': r = await spawnCli('agent', ['-p', '--force', '--approve-mcps', '--output-format', 'text', ...m('--model'), FILE_INSTR], dir, '', { ctl: live.ctl }); break;
    case 'opencode': {
      if (!(await has('ollama'))) { r = { missing: true }; break; }
      const name = ollamaModel(model);
      if (!name) return { ok: false, text: '⚠ 這台電腦的 Ollama 還沒有下載任何模型。請在「AI 連線 → Ollama」按「一鍵安裝並登入」，或在終端機執行 ollama pull qwen3。' };
      // only the local Ollama provider is enabled: no paid APIs
      b.put('opencode.json', {
        $schema: 'https://opencode.ai/config.json', enabled_providers: ['ollama'], model: 'ollama/' + name,
        provider: { ollama: { npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: 'http://127.0.0.1:11434/v1' }, models: { [name]: { name } } } },
        mcp: { browser: { type: 'local', command: [server.command, ...server.args], environment: server.env || {}, enabled: true } },
        tools: { task: false, todowrite: false, todoread: false, grep: false, glob: false }   // grep/glob need ripgrep, often missing on Windows; small local models misuse sub-agents and to-do lists, then reply about the error
      });
      // /no_think: qwen3-style models skip their long hidden reasoning (several times faster on a laptop)
      r = await spawnCli('opencode', ['run', '--auto', '--dir', dir, '-m', 'ollama/' + name, '/no_think ' + FILE_INSTR.replace('目前資料夾裡的 octa-task.md', `檔案 ${join(dir, 'octa-task.md')}（用 read 工具讀這個完整路徑）`)], dir, '', { ctl: live.ctl });
      break;
    }
    default: {
      // stream-json: lets OCTA show what the bot is doing while it works
      let result = null;
      r = await spawnCli('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config', '--add-dir', store, ...m('--model'),
        '--allowedTools', 'mcp__browser,WebFetch,WebSearch,Read,Write,Edit,Glob,Grep'], dir, prompt, {
        ctl: live.ctl,
        onLine: l => {
          let e; try { e = JSON.parse(l); } catch { return; }
          if (e.type === 'result') { result = e; return; }
          if (e.type === 'assistant') for (const c of e.message?.content || []) {
            if (c.type === 'tool_use') live.progress?.(describeTool(c.name, c.input));
            else if (c.type === 'text' && c.text?.trim()) live.progress?.('整理回覆中');
          }
        }
      });
      if (result) { text = String(result.result || '').trim(); if (result.is_error && r.code === 0) r.code = 1; tokens = claudeTokens(result.usage); }
      else if (r.out && r.out.trim().startsWith('{')) text = '';   // stream with no result: fall back to the error output
    }
  }
  text = (text || r.out || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  const E = ENGINES[engine] || ENGINES.claude;
  if (r.missing) return { ok: false, text: `⚠ 這台電腦沒有安裝 ${E.label}。請到「AI 連線」安裝並登入（${E.site}），或在任務設定把這個機器人改用其他 AI。` };
  if (tokens == null) { const tm = String((r.err || '') + (r.out || '')).match(/tokens used[:\s]*([\d,]+)/i); if (tm) tokens = +tm[1].replace(/,/g, ''); }
  if (r.code === 0 && text) return { ok: true, text, tokens };
  return { ok: false, text: `⚠ ${E.label} 執行失敗：` + failText(r, prompt) };
}
// the useful part of a failed run: CLIs like Codex echo the whole prompt into their log, which buried the real error
function failText(r, prompt) {
  let t = String((r.err || '').trim() || (r.out || '').trim()).replace(/\x1b\[[0-9;]*m/g, '');
  if (!t) return '結束碼 ' + r.code;
  const errs = [...new Set(t.split('\n').map(l => l.trim()).filter(l => /^(error|錯誤)\b|^\[?error\]?[:\s]|\berror:\s|exception\b|failed\b/i.test(l)))];
  if (errs.length) return errs.slice(-8).join('\n').slice(-1200);
  const p = String(prompt || '').trim();
  if (p) { const tail = p.slice(-200), i = t.lastIndexOf(tail); if (i >= 0) t = t.slice(i + tail.length).trim() || '（沒有錯誤訊息，結束碼 ' + r.code + '）'; }
  return t.slice(-1200);
}

// ---------- job handlers ----------
async function chatJob(job) {
  if (typeof job.shareBrowser === 'boolean') shareBrowser = job.shareBrowser;
  return chatRun(job);
}
async function chatRun(job) {
  const own = job.bot.browser !== 'mine';
  let port = 0;
  if (own && job.bot.engine !== 'grokbot') { try { port = await ensureBrowser(job.bot); } catch (e) { log('瀏覽器：' + e.message); } }   // a Grok Bot works on xAI's cloud computer
  const b = botDir(job.bot.id, job.bot.browser, port), { dir } = b;
  const here = convDir(job.conv || job.bot);
  if (port) busyBots.add(job.bot.id);
  for (const h of job.history) {   // attachments: already in the folder, or saved there now
    h.paths = [];
    for (const f of h.files || []) {
      try {
        const p = f.path ? join(storeDir(), f.path) : null;
        if (p && existsSync(p)) { h.paths.push(p); continue; }
        if (!f.path) { h.paths.push(await saveUpload({ ...f, conv: job.conv?.id || job.bot.id, convName: job.conv?.name || job.bot.name })); continue; }
        // made on another computer: get a copy through OCTA (that computer sends it) and keep it here
        const d = await api('file/' + encodeURIComponent(f.id), undefined, 'GET');
        mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.from(d.data || '', 'base64')); h.paths.push(p);
        log(`📥 從其他電腦取得：${f.path}`);
      } catch (e) { log('附件讀取失敗：' + e.message); }
    }
  }
  restoreSkills(dir, job.nskills);
  const start = Date.now() - 1000;
  log(`▶ ${job.bot.name}［${job.bot.engine || 'claude'}］${job.group ? ' @' + job.group.name : ''}：${job.prompt.slice(0, 40)}`);
  job.bot.livePort = port;
  if (port) { try { job.bot.tabs = await cdp(port, async send => (await pagesOf(send)).filter(p => !/^(about:blank|chrome:)/.test(p.url)).slice(0, 6).map(p => ({ title: p.title.slice(0, 80), url: p.url.slice(0, 200) }))); } catch { } }
  // live progress (at most every 4 s); if the user pressed 停止, the server says so and the run is stopped
  const ctl = {};
  let lastSent = 0, pendingText = '', timerP = null;
  const flush = () => { timerP = null; lastSent = Date.now(); api('runner/progress', { id: job.id, text: pendingText }).then(r => { if (r.stop) { log(`■ ${job.bot.name}：使用者按了停止`); ctl.kill?.(); } }).catch(() => { }); };
  const progress = t => { pendingText = t; if (timerP) return; const wait = Math.max(0, 4000 - (Date.now() - lastSent)); timerP = setTimeout(flush, wait); };
  progress('開始工作');
  const beat = setInterval(() => { if (!timerP) flush(); }, 15000);   // also notices 停止 for AIs that don't report progress
  let res;
  const engine = job.bot.engine || 'claude';
  try {
    res = engine === 'grokbot' ? await runGrokBot(job, { progress, ctl })
      : engine === 'claude' && job.warm && (await has('claude'))
      ? await warmClaude(job, b, here, { progress, ctl })        // AI 待機: reuse the running Claude session
      : await runEngine(engine, buildPrompt(job, here), b, job.bot.model, { progress, ctl });
  }
  finally { clearTimeout(timerP); clearInterval(beat); busyBots.delete(job.bot.id); if (port) touchBrowser(job.bot.id); }
  if (port && shareBrowser) await syncOut(port);
  // what the browser shows now: taken by OCTA itself (no need for the bot to remember)
  let page = (res.text.match(/📍\s*目前頁面[:：]\s*(\S+)/) || [])[1];
  const d = new Date(), z = n => String(n).padStart(2, '0'), stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
  const saveShot = async (buf, ext) => {
    const p = freeName(join(here, '截圖'), safeName(job.bot.name) + '-' + stamp + ext);
    writeFileSync(p, buf);
    await api('runner/shot', { id: job.id, path: rel(p), name: basename(p), size: buf.length });
  };
  try {
    const live = port ? await browserSnapshot(port, start) : null;
    if (live) { if (live.url && !/^(about:|chrome:)/.test(live.url)) page = live.url; if (live.jpeg) await saveShot(live.jpeg, '.jpeg'); }
    else { const shot = newestImage(dir, start); if (shot) await saveShot(readFileSync(shot.p), extname(shot.p).toLowerCase()); }
  } catch (e) { log('截圖儲存失敗：' + e.message); }
  const nsk = collectSkills(dir, job.nskills);
  await api('runner/done', { id: job.id, ok: res.ok, text: res.text, page, tokens: res.tokens ?? null, files: res.ok ? newFiles(join(here, '輸出'), start) : [], browser: !!port, ...(nsk ? { nskills: nsk } : {}) });
  log(`${res.ok ? '✓' : '✗'} ${job.bot.name}`);
  if (['claude', 'codex'].includes(job.bot.engine || 'claude')) lastUsage = 0;   // refresh how much is left
  try { cfg.onDone?.(job, res); } catch { }
}

// ---------- the bot's own Claude Code skills (.claude/skills in its folder) travel with the account ----------
const SKILL_EXT = /\.(md|txt|json|ya?ml|py|js|mjs|ts|sh|ps1|csv|html|css|toml)$/i;
function skillFiles(root) {
  const out = {}; let total = 0;
  const walk = (d, pre) => { let es = []; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = join(d, e.name), r = pre ? pre + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!/^(node_modules|\.git)$/.test(e.name)) walk(p, r); }
      else if (SKILL_EXT.test(e.name)) { try { const st = statSync(p); if (st.size > 60000 || total + st.size > 250000) continue; total += st.size; out[r] = readFileSync(p, 'utf8'); } catch { } } } };
  walk(root, ''); return out;
}
function collectSkills(dir, had) {
  const files = skillFiles(join(dir, '.claude', 'skills'));
  if (!Object.keys(files).length && !had) return null;
  const h = createHash('sha1').update(JSON.stringify(files)).digest('hex');
  return h === had?.h ? null : { h, files };
}
function restoreSkills(dir, sk) {   // e.g. on a new host computer
  if (!sk?.files) return;
  for (const [r, text] of Object.entries(sk.files)) {
    if (r.split('/').includes('..')) continue;
    const p = join(dir, '.claude', 'skills', ...r.split('/'));
    try { if (!existsSync(p) || readFileSync(p, 'utf8') !== text) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); } } catch { }
  }
}

// ---------- handing a bot's website logins to another computer (cookies of its own browser) ----------
const cookieParams = list => list.filter(c => c.name && c.domain)
  .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, ...(c.sameSite ? { sameSite: c.sameSite } : {}), ...(c.expires > 0 ? { expires: c.expires } : {}) }));
// switching to the shared browser: bring the sign-ins from every bot's old browser into it, once
async function mergeOldProfiles() {   // once: the sign-ins in every bot's browser (and the 2.4.x shared one) go into the shared store
  const mark = join(workDir, '.octa-logins-merged');
  if (existsSync(mark)) return;
  const root = join(workDir, 'bots'), chrome = findChrome();
  const when = p => { for (const f of [join(p, 'Default', 'Network', 'Cookies'), join(p, 'Default', 'Cookies'), p]) { try { return statSync(f).mtimeMs; } catch { } } return 0; };
  let dirs = []; try { dirs = readdirSync(root).map(d => join(root, d, 'profile')).filter(p => existsSync(p)); } catch { }
  if (existsSync(sharedProfile())) dirs.push(sharedProfile());
  dirs.sort((a, b) => when(a) - when(b));   // newest last: its sign-in wins when two have the same site
  const all = []; let n = 0;
  for (const p of dirs) {
    let port = 0;
    for (const [, b] of browsers) if (b.profile === p) port = b.port;   // already open: read it directly
    let child = null;
    if (!port) {
      if (!chrome || profileInUse(p)) continue;
      port = 9390 + (n++ % 9);
      child = spawn(chrome, [`--user-data-dir=${p}`, `--remote-debugging-port=${port}`, '--headless=new', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', windowsHide: true });
      child.on('error', () => { });
    }
    try {
      for (let i = 0; i < 40 && !(await cdpInfo(port)); i++) await pause(300);
      const { cookies = [] } = await cdp(port, send => send('Storage.getCookies'));
      all.push(...cookies);
      if (child) await cdp(port, send => send('Browser.close')).catch(() => { });
    } catch (e) { log('讀取舊瀏覽器登入失敗：' + e.message); }
    finally { try { child?.kill(); } catch { } }
  }
  const total = all.length ? addToJar(all) : 0;
  mkdirSync(workDir, { recursive: true }); writeFileSync(mark, String(total));
  const sites = new Set(all.map(c => String(c.domain).replace(/^\./, '').split('.').slice(-2).join('.')));
  if (all.length) log(`🔑 已把各機器人瀏覽器的登入合併成共用登入（${sites.size} 個網站）`);
}

async function exportJob(job) {
  if (typeof job.shareBrowser === 'boolean') shareBrowser = job.shareBrowser;
  const port = await ensureBrowser(job.bot);
  const { cookies = [] } = await cdp(port, send => send('Storage.getCookies'));
  const data = Buffer.from(JSON.stringify(cookies)).toString('base64');
  for (let i = 0, n = 0; i < data.length || n === 0; i += CHUNK, n++) await api('runner/xfer', { id: job.id, n, data: data.slice(i, i + CHUNK), last: i + CHUNK >= data.length });
  log(`🔑 已送出 ${job.bot.name} 的網站登入（${cookies.length} 筆）`);
}
async function importJob(job) {
  if (typeof job.shareBrowser === 'boolean') shareBrowser = job.shareBrowser;
  const { data } = await api('runner/xfer/' + encodeURIComponent(job.xfer), undefined, 'GET');
  const cookies = cookieParams(JSON.parse(Buffer.from(data || '', 'base64').toString('utf8') || '[]'));
  const port = await ensureBrowser(job.bot);
  await cdp(port, send => send('Storage.setCookies', { cookies }));
  if (shareBrowser) addToJar(cookies);
  const sites = new Set(cookies.map(c => c.domain.replace(/^\./, '').split('.').slice(-2).join('.')));
  log(`🔑 已帶入 ${job.bot.name} 的網站登入（${sites.size} 個網站）`);
  await api('runner/done', { id: job.id, ok: true, text: `已把「${job.bot.name}」的網站登入帶到這台主機（${sites.size} 個網站）。有些網站會綁定裝置，可能還是要再登入一次。` });
}

// ---------- Grok Bot (through grok-bot-cli) ----------
function jsonOut(text) { const t = String(text || '').trim(); const i = t.search(/[[{]/); if (i < 0) return null; try { return JSON.parse(t.slice(i)); } catch { return null; } }
const pickArr = o => (Array.isArray(o) ? o : o && (o.bots || o.items || o.entries || o.thread || o.messages || o.data || o.results)) || [];
// gbot reads the Grok Bot app's session and asks xAI's gateway: the first call can take a while, and its errors matter
// grok-bot-cli finds the app's sign-in at <APPDATA>/Grok Bot/gateway-descriptor.json; if this copy of the app keeps it
// somewhere else, look for it and point grok-bot-cli there
let gbEnv = null, gbLook = 0;
function grokBotEnv() {
  if (Date.now() - gbLook < 5 * 60000) return gbEnv;
  gbLook = Date.now(); gbEnv = null;
  const want = 'gateway-descriptor.json', home = os.homedir();
  const std = WIN ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Grok Bot') : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Grok Bot') : join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Grok Bot');
  if (existsSync(join(std, want))) return gbEnv = { found: std };
  const roots = WIN ? [process.env.APPDATA, process.env.LOCALAPPDATA, home, join(home, '.grokbot')] : [join(home, '.config'), join(home, 'Library', 'Application Support'), join(home, '.grokbot')];
  for (const r of roots.filter(Boolean)) {
    let subs = []; try { subs = readdirSync(r, { withFileTypes: true }).filter(d => d.isDirectory() && /grok/i.test(d.name)).map(d => join(r, d.name)); } catch { }
    for (const d of [r, ...subs]) if (existsSync(join(d, want)) && basename(d) === 'Grok Bot') return gbEnv = { found: d, env: WIN ? { APPDATA: dirname(d) } : { XDG_CONFIG_HOME: dirname(d) } };
  }
  return gbEnv = { missing: std };
}
// on Windows run grok-bot-cli's script with node directly: going through gbot.cmd (cmd.exe) mangles messages with line breaks or quotes
function gbotCmd(args) {
  if (WIN) {
    const shim = installed.gbot?.path || findBin('gbot'), mjs = shim && join(dirname(shim), 'node_modules', 'grok-bot-cli', 'dist', 'bin', 'gbot.mjs');
    if (mjs && existsSync(mjs)) return ['node', [mjs, ...args], false];
  }
  return ['gbot', WIN ? args.map(q) : args, WIN];
}
const runGbot = (args, timeout = 90000) => new Promise(ok => { const [cmd, a, shell] = gbotCmd(args); execFile(cmd, a, { shell, windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 8 << 20, env: { ...process.env, ...(grokBotEnv()?.env || {}) } },
  (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out || ''), err: String(err || '') + (e?.killed ? '\n（超過 90 秒沒有回應）' : '') })); });
const gbotError = r => (r.err || r.out).replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-6).join('\n').slice(0, 600) || ('結束碼 ' + r.code);
async function grokBots() {   // [{name, description}] — groups included (they take messages too)
  const where = grokBotEnv();
  if (where.missing) throw new Error(`找不到 Grok Bot 桌面 App 的登入資料（${where.missing}${sep}gateway-descriptor.json）。請在這台電腦打開 Grok Bot App 並登入（用官方安裝版，不是複製來的資料夾），讓它連上一次後再試。`);
  const r = await runGbot(['bots', 'list', '--gateway', '--json']);
  const j = jsonOut(r.out);
  if (j) return pickArr(j).map(b => ({ name: String(b.name || b.title || b.displayName || ''), description: (b.isGroup ? '（群組）' : '') + String(b.description || b.instructions || b.label || '') })).filter(b => b.name);
  if (r.code !== 0) throw new Error('grok-bot-cli 讀取失敗：' + gbotError(r));
  return r.out.split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(l => l && !/^(name|bots?)\b/i.test(l)).map(l => ({ name: l.split(/\s{2,}|\t/)[0], description: '' })).filter(b => b.name);
}
const entryText = e => typeof e === 'string' ? e : e.text || e.body || e.markdown || e.message?.text || (Array.isArray(e.content) ? e.content.map(c => c.text || '').join('') : typeof e.content === 'string' ? e.content : '');
const fromUser = e => /^(user|me|human|you)$/i.test(String(e.role || e.author?.type || e.author || e.from || e.sender || e.kind || ''));
async function runGrokBot(job, live) {
  const name = job.bot.model;
  if (!(await has('gbot'))) return { ok: false, text: '⚠ 這台電腦還沒安裝 grok-bot-cli。請到「AI 連線 → Grok Bot」安裝。' };
  if (!name) return { ok: false, text: '⚠ 這個機器人還沒選擇要帶入的 Grok Bot 機器人，請到任務設定的「模型」選一個。' };
  let cursor = jsonOut((await runGbot(['thread', name, '--json'])).out)?.cursor;
  const msg = [job.prompt, ...job.history.slice(-1).flatMap(h => h.paths?.length ? ['（附件在使用者電腦上：' + h.paths.join('、') + '）'] : [])].join('\n');
  live.progress?.('交給 Grok Bot「' + name + '」處理');
  const sent = await runGbot(['send', name, msg], 120000);
  if (sent.code !== 0) return { ok: false, text: '⚠ 傳給 Grok Bot 失敗：' + ((sent.err || sent.out || '').trim().slice(-800) || '結束碼 ' + sent.code) };
  const got = [], t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < JOB_TIMEOUT_MS && !stopped) {
    await pause(5000);
    const j = jsonOut((await runGbot(['thread', name, ...(cursor ? ['--after', String(cursor)] : []), '--json'])).out);
    if (!j) continue;
    if (j.cursor) cursor = j.cursor;
    const fresh = pickArr(j).filter(e => !fromUser(e)).map(entryText).filter(x => x && x.trim() && x.trim() !== msg.trim());
    if (fresh.length) { got.push(...fresh); quiet = 0; live.progress?.('Grok Bot 回覆中'); }
    else if (got.length && ++quiet >= 3) break;   // replies stopped for ~15 s
  }
  return got.length ? { ok: true, text: got.join('\n\n') } : { ok: false, text: '⚠ Grok Bot 在時間內沒有回覆，可以在 Grok Bot App 裡看看它的狀況。' };
}
// started from any device (phone, web): open the install window on this computer, then watch for the tool
async function installJob(job) {
  const E = ENGINES[job.engine];
  if (!E || !cfg.openInstall) return api('runner/done', { id: job.id, ok: false, text: '這台主機不是 OCTA 桌面版，無法自動安裝，請在主機電腦上手動安裝。' });
  try { await cfg.openInstall(job.engine); } catch (e) { return api('runner/done', { id: job.id, ok: false, text: '無法打開安裝視窗：' + e.message }); }
  log(`🧩 已打開 ${E.label} 的安裝視窗`);
  await api('runner/done', { id: job.id, ok: true, text: `已在主機電腦「${os.hostname()}」打開 ${E.label} 的安裝視窗。` });
  // report as soon as it's installed (checks every 10 seconds for up to 15 minutes)
  const t0 = Date.now();
  const tick = setInterval(async () => {
    if (await engineReady(job.engine, true)) { clearInterval(tick); lastReport = 0; lastModels = 0; lastUsage = 0; log(`✓ ${E.label} 已安裝`); }
    else if (Date.now() - t0 > 15 * 60000) clearInterval(tick);
  }, 10000);
}
async function listJob(job) {
  let result;
  if (!(await has('gbot', true))) result = JSON.stringify({ error: '這台電腦還沒安裝 grok-bot-cli，請先在「AI 連線 → Grok Bot」按安裝' });
  else try { result = JSON.stringify(await grokBots()); } catch (e) { result = JSON.stringify({ error: e.message }); }
  await api('runner/done', { id: job.id, ok: true, text: result });
}

// ---------- AI 待機: keep a Claude Code session running between messages ----------
// The first message sends everything; while the session waits, the next message only sends what's new,
// so there is no restart and nothing to re-read. job.warm: seconds to keep waiting (-1: always).
const sessions = new Map();   // bot id → { child, fp, lastId, turn, timer }
function closeSession(id, why) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  clearTimeout(s.timer);
  try { s.child.stdin.end(); } catch { }
  setTimeout(() => { try { WIN ? spawn('taskkill', ['/pid', String(s.child.pid), '/t', '/f'], { windowsHide: true }) : s.child.kill(); } catch { } }, 4000);
  if (why) log(`💤 ${why}`);
}
function startSession(job, b) {
  const { dir } = b, m = job.bot.model ? ['--model', job.bot.model] : [];
  const child = spawn('claude', (WIN ? a => a.map(q) : a => a)(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config', '--add-dir', storeDir(), ...m,
    '--allowedTools', 'mcp__browser,WebFetch,WebSearch,Read,Write,Edit,Glob,Grep']), { cwd: dir, shell: WIN, windowsHide: true });
  const s = { child, turn: null, err: [] };
  let part = '';
  child.stdout.on('data', d => {
    part += d.toString('utf8');
    let i;
    while ((i = part.indexOf('\n')) >= 0) {
      const l = part.slice(0, i); part = part.slice(i + 1);
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (!s.turn) continue;
      if (e.type === 'assistant') for (const c of e.message?.content || []) {
        if (c.type === 'tool_use') s.turn.progress?.(describeTool(c.name, c.input));
        else if (c.type === 'text' && c.text?.trim()) s.turn.progress?.('整理回覆中');
      }
      if (e.type === 'result') { const t = s.turn; s.turn = null; t.done({ ok: !e.is_error && !!String(e.result || '').trim(), text: String(e.result || '').trim() || '⚠ Claude Code 沒有回覆內容', tokens: claudeTokens(e.usage) }); }
    }
  });
  child.stderr.on('data', d => { s.err.push(d); if (s.err.length > 50) s.err.shift(); });
  child.stdin.on('error', () => { });
  const gone = msg => { for (const [k, v] of sessions) if (v === s) sessions.delete(k); clearTimeout(s.timer); if (s.turn) { const t = s.turn; s.turn = null; t.done({ ok: false, text: '⚠ Claude Code 執行失敗：' + (decode(s.err).trim().slice(-1200) || msg) }); } };
  child.on('error', e => gone(e.message));
  child.on('exit', code => gone('結束碼 ' + code));
  return s;
}
async function warmClaude(job, b, here, live) {
  // anything that changes the bot's standing instructions starts a fresh session
  const fp = JSON.stringify([job.memory, (job.skills || []).map(k => k.name + k.steps), job.bot.task, job.bot.model, job.bot.browser, job.bot.livePort, job.notes, job.folderNotes, job.group, (job.colleagues || []).map(c => c.name + c.task), job.allowed, job.lang, storeDir(), job.conv?.id]);
  let s = sessions.get(job.bot.id), text;
  const ids = job.history.map(h => h.id || 0), newest = Math.max(0, ...ids);
  if (s && s.fp === fp && s.convId === job.conv?.id) {
    clearTimeout(s.timer);
    // only what happened since the last turn, then the new instruction
    const fresh = job.history.filter(h => (h.id || 0) > s.lastId && !(h.who === '使用者' && h.text === job.prompt));
    text = [fresh.length ? '（上次之後的新對話）\n' + fresh.map(h => `【${h.who}】${h.text}` + (h.paths?.length ? `\n（附件，可直接讀取這些檔案：${h.paths.join('、')}）` : '')).join('\n') : '',
      tabsNow(job).join('\n'), '先判斷這則指示的類型：(1) 只問你的設定、任務內容、AI 方案 → 直接回答，不用工具。(2) 問到網頁上、畫面上、帳號裡現在的狀況（例如「你看到什麼」「現在有幾則訊息」），或使用者說他幫你打開、登入好了 → 先用 browser_snapshot 看你瀏覽器目前的分頁再回答，不要說你還沒看。(3) 要你做事 → 直接動手做。', whoAmI(job), '現在請處理這則指示：', job.prompt].filter(Boolean).join('\n\n');
    log(`⚡ ${job.bot.name}：AI 待機中，直接接續`);
  } else {
    if (s) closeSession(job.bot.id);
    s = startSession(job, b);
    s.fp = fp; s.convId = job.conv?.id;
    sessions.set(job.bot.id, s);
    text = buildPrompt(job, here);
  }
  s.lastId = newest;
  live.ctl.kill = () => closeSession(job.bot.id, `${job.bot.name}：已停止`);
  const res = await new Promise(done => {
    s.turn = { done, progress: live.progress };
    try { s.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'); }
    catch (e) { s.turn = null; done({ ok: false, text: '⚠ ' + e.message }); }
  });
  if (sessions.get(job.bot.id) === s) {
    if (job.warm > 0) s.timer = setTimeout(() => closeSession(job.bot.id, `${job.bot.name}：待機 ${job.warm} 秒到了，AI 先休息`), job.warm * 1000);
    if (!res.ok) closeSession(job.bot.id);   // start clean after an error
  }
  return res;
}

async function testJob(job) {
  if (job.engine === 'grokbot') {
    const ok = await has('gbot', true);
    let bots = [], why = '';
    if (ok) try { bots = await grokBots(); } catch (e) { why = e.message; }
    lastReport = 0; lastModels = 0;
    return api('runner/done', { id: job.id, ok: ok && bots.length > 0, text: !ok ? '這台電腦還沒安裝 grok-bot-cli' : bots.length ? `連上了，找到 ${bots.length} 個 Grok Bot 機器人：${bots.map(b => b.name).join('、')}` : why || 'Grok Bot 裡沒有任何機器人（請確認 Grok Bot 桌面 App 已登入）' });
  }
  const b = botDir('_test-' + job.engine);
  log(`🔌 測試 ${ENGINES[job.engine]?.label || job.engine}`);
  const res = await runEngine(job.engine, job.prompt, b, '');
  lastReport = 0; lastUsage = 0; lastModels = 0;   // refresh the installed list, models and quotas right after a test
  await api('runner/done', { id: job.id, ok: res.ok, text: res.text });
}

// ---------- each bot's own browser: one Chrome that stays open between jobs ----------
// It starts in the background (off screen). The AI connects to it over CDP, so tabs and logins carry over.
// 「在電腦上顯示」 brings the same window forward: you see what the bot sees, and can log in right there.
const browsers = new Map();   // key ('shared' or bot id) → { port, last }
let shareBrowser = true;   // sign-ins shared between bots; each bot still has its own browser, so bots work in parallel
const sharedProfile = () => join(workDir, 'profile-shared');   // 2.4.0–2.4.2 used one shared Chrome here: its sign-ins get merged in
const jarFile = () => join(workDir, 'shared-logins.json');
const readJar = () => { try { return JSON.parse(readFileSync(jarFile(), 'utf8')); } catch { return []; } };
const ckKey = c => `${c.name}|${c.domain}|${c.path || '/'}`;
function addToJar(list) {   // newest values win; expired ones drop out
  const now = Date.now() / 1000, m = new Map(readJar().map(c => [ckKey(c), c]));
  for (const c of list) if (c.name && c.domain) m.set(ckKey(c), c);
  const out = [...m.values()].filter(c => !(c.expires > 0 && c.expires < now));
  mkdirSync(workDir, { recursive: true }); writeFileSync(jarFile(), JSON.stringify(out)); return out.length;
}
// before a bot works: give its browser everyone's sign-ins; after: add what it signed in to
async function syncIn(port) {   // also take sign-ins from other bots' browsers that are open right now (they only save theirs when their job ends)
  let m = {}; try { m = JSON.parse(readFileSync(join(workDir, 'ports.json'), 'utf8')); } catch { }
  await Promise.all(Object.values(m).filter(p => p !== port).map(async p => { if (await cdpInfo(p)) await syncOut(p); }));
  const jar = readJar(); if (jar.length) await cdp(port, send => send('Storage.setCookies', { cookies: cookieParams(jar) })).catch(e => log('帶入共用登入失敗：' + e.message)); }
async function syncOut(port) { try { const { cookies = [] } = await cdp(port, send => send('Storage.getCookies')); addToJar(cookies); } catch (e) { log('儲存共用登入失敗：' + e.message); } }
const busyBots = new Set();
const pause = ms => new Promise(r => setTimeout(r, ms));
function profileInUse(profile) {   // a Chrome window (without the debugging port) still has this profile open
  if (WIN) {
    const f = join(profile, 'lockfile');
    if (!existsSync(f)) return false;
    try { closeSync(openSync(f, 'r+')); return false; } catch (e) { return ['EBUSY', 'EPERM', 'EACCES'].includes(e.code); }
  }
  try { lstatSync(join(profile, 'SingletonLock')); return true; } catch { return false; }
}
function portOf(id) {   // a fixed local port per bot, kept in work/ports.json
  const f = join(workDir, 'ports.json');
  let m = {}; try { m = JSON.parse(readFileSync(f, 'utf8')); } catch { }
  if (!m[id]) { const used = new Set(Object.values(m)); let p = 9311; while (used.has(p)) p++; m[id] = p; writeFileSync(f, JSON.stringify(m)); }
  return m[id];
}
async function cdpInfo(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function cdp(port, fn) {   // a short CDP session on the browser
  if (typeof WebSocket === 'undefined') throw new Error('需要 Node 22 以上');
  const v = await cdpInfo(port);
  if (!v) throw new Error('瀏覽器沒有開著');
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('連不上瀏覽器')); setTimeout(() => no(new Error('連不上瀏覽器')), 5000); });
  let n = 0; const wait = {};
  ws.onmessage = e => { const m = JSON.parse(e.data); if (wait[m.id]) { wait[m.id](m); delete wait[m.id]; } };
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const id = ++n; wait[id] = m => (m.error ? no(new Error(m.error.message)) : ok(m.result));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (wait[id]) { delete wait[id]; no(new Error('瀏覽器沒有回應')); } }, 15000);
  });
  try { return await fn(send); } finally { try { ws.close(); } catch { } }
}
const pagesOf = async send => (await send('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
const touchBrowser = id => { const b = browsers.get(id); if (b) b.last = Date.now(); };
export async function ensureBrowser(bot) {
  const port = await openBrowser(bot);
  if (shareBrowser) { await mergeOldProfiles().catch(e => log('合併舊登入失敗：' + e.message)); await syncIn(port); }
  return port;
}
async function openBrowser(bot) {
  const port = portOf(bot.id);
  const key = bot.id;
  if (await cdpInfo(port)) { browsers.set(key, { port, last: Date.now() }); return port; }
  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Google Chrome');
  const profile = botDir(bot.id).profile;
  mkdirSync(profile, { recursive: true });
  for (let i = 0; i < 10 && profileInUse(profile); i++) await pause(1000);   // an old window may still be closing
  if (profileInUse(profile)) throw new Error('這個機器人的瀏覽器有一個舊視窗開著，請先關掉它');
  const child = spawn(chrome, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
    '--restore-last-session', '--window-position=-32000,-32000', '--window-size=1280,860'], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => { });
  child.unref();
  for (let i = 0; i < 40; i++) { if (await cdpInfo(port)) break; await pause(500); }
  if (!(await cdpInfo(port))) throw new Error('Chrome 沒有啟動');
  browsers.set(key, { port, last: Date.now(), profile });
  if (sessions.has(bot.id)) closeSession(bot.id);   // a waiting AI was connected to the old browser
  log(`🌐 ${bot.name} 的瀏覽器已在背景開啟`);
  // some systems pull an off-screen window back on screen: then keep it minimised instead
  try {
    await cdp(port, async send => {
      const [p] = await pagesOf(send);
      if (!p) return;
      const { windowId, bounds } = await send('Browser.getWindowForTarget', { targetId: p.targetId });
      if (bounds.left > -5000) await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    });
  } catch { }
  return port;
}
async function browserSnapshot(port, since) {   // screenshot + address of the tab the bot used last
  return cdp(port, async send => {
    const pages = await pagesOf(send);
    if (!pages.length) return null;
    const p = pages.find(x => x.attached) || pages[0];
    const { sessionId } = await send('Target.attachToTarget', { targetId: p.targetId, flatten: true });
    let jpeg = null;
    try { jpeg = Buffer.from((await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }, sessionId)).data, 'base64'); } catch { }
    await send('Target.detachFromTarget', { sessionId }).catch(() => { });
    return { url: p.url, jpeg };
  });
}
async function showBrowser(port, url, hide) {
  return cdp(port, async send => {
    let pages = await pagesOf(send), targetId = pages[0]?.targetId;
    if (url || !targetId) targetId = (await send('Target.createTarget', { url: url || 'about:blank' })).targetId;
    const { windowId } = await send('Browser.getWindowForTarget', { targetId });
    if (hide) { await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => { }); await send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000 } }); return; }
    await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => { });
    await send('Browser.setWindowBounds', { windowId, bounds: { left: 60, top: 40, width: 1280, height: 860 } });
    await send('Target.activateTarget', { targetId });
  });
}
async function openJob(job) {
  if (typeof job.shareBrowser === 'boolean') shareBrowser = job.shareBrowser;
  const done = (ok, text) => { log(`🌐 ${job.bot.name}：${text}`); return api('runner/done', { id: job.id, ok, text }).catch(() => { }); };
  const hide = job.url === 'octa:hide';
  try {
    if (hide && !(await cdpInfo(portOf(job.bot.id)))) return done(true, '我的瀏覽器已經收起來了。');
    const port = await ensureBrowser(job.bot);
    await showBrowser(port, hide ? '' : job.url, hide);
    touchBrowser(job.bot.id);
    if (hide && shareBrowser) await syncOut(port);   // signed in by hand: every bot gets it
    return done(true, hide ? '我的瀏覽器已收到背景，我會繼續在裡面工作。'
      : busyBots.has(job.bot.id) ? '我的瀏覽器已經在電腦上顯示，我正在裡面工作，先別操作；要幫我登入請等我停下來。'
      : '我的瀏覽器已經在電腦上顯示。需要登入就直接在裡面登入，好了回來按「登入好了，繼續」。');
  } catch (e) { return done(false, '⚠ 無法打開瀏覽器：' + e.message); }
}
// ---------- 監看網頁: check pages in the bot's own browser, start the routine only when they change ----------
// No AI is used for checking, so it costs no tokens; the bot is called only when something new shows up.
let watches = [], watchesAt = 0;
const lastLook = new Map();
async function readPage(port, url, sel) {
  return cdp(port, async send => {
    const { targetId } = await send('Target.createTarget', { url, background: true });
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId)).result?.value;
      for (let i = 0; i < 40 && (await ev('document.readyState').catch(() => '')) !== 'complete'; i++) await pause(500);
      await pause(4000);   // pages that load their content afterwards (chat lists, dashboards)
      const s = JSON.stringify(sel || '');
      return String(await ev(`(()=>{const sel=${s};const els=sel?[...document.querySelectorAll(sel)]:[document.body];return els.map(e=>e.innerText).join('\\n')})()`) || '').slice(0, 8000);
    } finally { await send('Target.closeTarget', { targetId }).catch(() => { }); }
  });
}
async function checkWatches() {
  if (standby || stopped) return;
  if (Date.now() - watchesAt > 5 * 60000) { watchesAt = Date.now(); try { watches = (await api('runner/watches', {})).watches || []; } catch { } }
  for (const w of watches) {
    if (Date.now() - (lastLook.get(w.id) || 0) < (w.every || 10) * 60000) continue;
    if (busyBots.has(w.bot) || sessions.get(w.bot)?.turn) continue;   // don't disturb a bot at work
    lastLook.set(w.id, Date.now());
    try {
      const port = await ensureBrowser({ id: w.bot, name: '監看' });
      const text = (await readPage(port, w.url, w.sel)).replace(/\d{1,2}:\d{2}(:\d{2})?/g, '').trim();   // ignore clocks on the page
      const hash = createHash('sha1').update(text).digest('hex');
      const r = await api('runner/watched', { id: w.id, hash, text });
      if (r.changed) log(`👀 監看的網頁有變化：${w.url}`);
    } catch (e) { log('監看失敗：' + e.message); }
  }
}

// browsers idle for 30 minutes and not on screen are closed to save memory (tabs come back next time)
async function reapBrowsers(all) {
  for (const [id, b] of browsers) {
    const inUse = busyBots.has(id) || sessions.has(id);
    if (!all && inUse) continue;   // in use, or an AI is waiting (待機)
    if (!all && Date.now() - b.last < 30 * 60000) continue;
    try {
      await cdp(b.port, async send => {
        if (!all) {
          const [p] = await pagesOf(send);
          if (p) { const { bounds } = await send('Browser.getWindowForTarget', { targetId: p.targetId }); if (bounds.left > -5000 && bounds.windowState !== 'minimized') return; }   // the user is looking at it
        }
        await send('Browser.close');
      });
      browsers.delete(id);
    } catch { browsers.delete(id); }
  }
}

// ---------- main loop: long-poll, so work starts the moment it's sent ----------
let active = 0, failures = 0, stopped = true, onFatal = null, polling = false, standby = false;
const fileWork = new Set();
function runJob(job) {
  active++;
  (job.kind === 'open' ? openJob(job) : job.kind === 'test' ? testJob(job) : job.kind === 'list' ? listJob(job) : job.kind === 'install' ? installJob(job) : job.kind === 'export' ? exportJob(job) : job.kind === 'import' ? importJob(job) : chatJob(job))
    .catch(e => { log('任務錯誤：' + e.message); return api('runner/done', { id: job.id, ok: false, text: '⚠ ' + e.message }).catch(() => { }); })
    .finally(() => { active--; kick(); });
}
function doFiles(inbox = [], pull = []) {
  for (const f of inbox) if (!fileWork.has(f.id)) { fileWork.add(f.id); saveUpload(f).catch(e => log('附件儲存失敗：' + e.message)).finally(() => fileWork.delete(f.id)); }
  for (const f of pull) if (!fileWork.has(f.id)) { fileWork.add(f.id); sendCopy(f).catch(e => log('傳送檔案失敗：' + e.message)).finally(() => fileWork.delete(f.id)); }
}
let poll = null;
const kick = () => { if (active < MAX) poll?.abort(); };   // a slot freed up: ask again right away (with the free slot)
async function loop() {
  if (polling) return;
  polling = true;
  while (!stopped) {
    try {
      const slots = MAX - active;
      poll = new AbortController();
      const r = await api('runner/next', {
        wait: true, slots, engines: await engineReport(), usage: await usageReport(), models: await modelReport(),
        version: VERSION, app: cfg.appVersion || undefined, store: storeDir()
      }, 'POST', slots ? undefined : poll.signal).catch(e => { if (e.name === 'AbortError') return {}; throw e; });
      failures = 0;
      if ('job' in r && !!r.standby !== standby) { standby = !!r.standby; log(standby ? '⏸ 這台電腦目前是備用電腦，由主機執行機器人。可在「設定 → 電腦」改成主機。' : '▶ 這台電腦是主機，開始接工作。'); cfg.onStandby?.(standby); }
      doFiles(r.inbox, r.pull);
      if (r.job) runJob(r.job);
    } catch (e) {
      failures++;
      log('連線問題：' + e.message);
      if (/執行器金鑰|請先登入/.test(e.message)) { stopped = true; onFatal?.('金鑰無效，請重新登入 OCTA 或到網站「設定」重新產生。'); break; }
      await new Promise(ok => setTimeout(ok, Math.min(2000 * 2 ** Math.min(failures, 5), 60000)));
    }
  }
  polling = false;
}

// opts: { url, token, home, max, chrome, pwCli, nodeBin, nodeEnv, log, onFatal, onDone, onStandby, getStore, getExtToken, appVersion, openInstall(engine) }
export function startRunner(opts) {
  cfg = { ...opts, url: opts.url.replace(/\/+$/, '') };
  workDir = join(opts.home, 'work');
  MAX = Math.max(1, Math.min(+opts.max || 3, 8));
  if (opts.log) log = opts.log;
  onFatal = opts.onFatal || null;
  stopped = false; lastReport = 0; lastUsage = 0; lastModels = 0; standby = false;
  mkdirSync(join(workDir, 'bots'), { recursive: true });
  mkdirSync(storeDir(), { recursive: true });
  log(`OCTA 執行器 v${VERSION} 啟動，最多 ${MAX} 個機器人同時工作；檔案資料夾：${storeDir()}`);
  if (!cfg.pwCli) {
    log('準備瀏覽器工具…');
    spawnSync(WIN ? 'cmd' : 'npx', WIN ? ['/c', 'npx', '-y', PW_MCP, '--version'] : ['-y', PW_MCP, '--version'], { stdio: 'ignore', timeout: 180000 });
  }
  loop();
  const reaper = setInterval(() => reapBrowsers(false).catch(() => { }), 5 * 60000);
  const watcher = setInterval(() => checkWatches().catch(() => { }), 60000);
  watchesAt = 0; lastLook.clear();
  setTimeout(() => checkWatches().catch(() => { }), 15000);
  const myCfg = cfg;
  return {
    stop: () => { stopped = true; poll?.abort(); clearInterval(reaper); clearInterval(watcher); reapBrowsers(true).catch(() => { }); for (const id of [...sessions.keys()]) closeSession(id); if (myCfg.token) fetch(myCfg.url + '/api/runner/bye', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + myCfg.token }, body: '{}' }).catch(() => { }); },
    active: () => active, standby: () => standby
  };
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const cfgPath = join(here, 'octa-runner.json'), oldCfg = join(here, 'ebot-runner.json');
  let c = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : existsSync(oldCfg) ? JSON.parse(readFileSync(oldCfg, 'utf8')) : {};
  if (process.argv[2]) { c = { ...c, url: process.argv[2].replace(/\/+$/, ''), token: process.argv[3] }; writeFileSync(cfgPath, JSON.stringify(c, null, 2)); }
  if (!c.url || !c.token) { console.error('第一次請執行：node octa-runner.mjs <網站網址> <執行器金鑰>'); process.exit(1); }
  console.log(`連線到 ${c.url}（Ctrl+C 停止）`);
  const r = startRunner({ ...c, home: here, onFatal: m => { console.error(m); process.exit(1); } });
  process.on('SIGINT', () => { r.stop(); setTimeout(() => process.exit(0), 500); });
}
