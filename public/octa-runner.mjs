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

export const VERSION = '10.1';
const PW_MCP = '@playwright/mcp@0.0.83';
const WIN = process.platform === 'win32';
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const CHUNK = 900_000;

let cfg = {}, workDir = '', MAX = 3, log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// tools installed after the app started aren't on its PATH yet; add the usual install folders
if (WIN) {
  const add = [join(os.homedir(), '.local', 'bin'), join(process.env.APPDATA || '', 'npm'), join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama')];
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
function botDir(id, mode = 'own') {
  const safe = String(id).replace(/[^\w-]/g, '');
  const dir = join(workDir, 'bots', safe);
  mkdirSync(join(dir, 'shots'), { recursive: true });
  const profile = join(dir, 'profile');
  const mine = mode === 'mine';
  const pwArgs = mine ? ['--extension', '--output-dir', join(dir, 'shots')] : ['--browser', 'chrome', '--user-data-dir', profile, '--output-dir', join(dir, 'shots')];
  const env = { ...(cfg.pwCli ? cfg.nodeEnv || {} : {}), ...(mine && extToken() ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: extToken() } : {}) };
  const server = cfg.pwCli
    ? { command: cfg.nodeBin || process.execPath, args: [cfg.pwCli, ...pwArgs], env }   // bundled (desktop app)
    : WIN ? { command: 'cmd', args: ['/c', 'npx', '-y', PW_MCP, ...pwArgs], env } : { command: 'npx', args: ['-y', PW_MCP, ...pwArgs], env };
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { browser: server } }, null, 2));
  // the same browser server, in each CLI's own config format
  const put = (f, o) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), JSON.stringify(o, null, 2)); };
  put('.gemini/settings.json', { mcpServers: { browser: { ...server, timeout: 60000, trust: true } } });
  put('.qwen/settings.json', { mcpServers: { browser: { ...server, timeout: 60000, trust: true } } });
  put('.cursor/mcp.json', { mcpServers: { browser: server } });
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
function buildPrompt(job, here) {
  const lines = [
    `你是 OCTA（奧克塔）裡的機器人「${job.bot.name}」，在使用者自己的電腦上執行。`,
    `你的指定任務：${job.bot.task}`
  ];
  if (job.group) lines.push(
    `你在群組「${job.group.name}」，成員依序為：${job.group.members.join('、')}。`,
    `群組協作規則：${job.group.task}`,
    '只做你自己負責的部分，可以引用前面成員在對話裡交出的資料。'
  );
  if (job.colleagues?.length) {
    lines.push(`你在分區「${job.folder || '未分區'}」，同分區的同事：`);
    for (const c of job.colleagues) lines.push(`- ${c.name}：${c.task}`);
    if (job.canAsk) lines.push('需要同事的資料或幫忙時，在回覆中單獨一行寫「@同事名 你的問題」，系統會請對方回答，再把你叫回來繼續。不需要就不要寫。');
  }
  if (job.notes) lines.push('', '共用資料（所有機器人都要知道）：', job.notes);
  if (job.folderNotes) lines.push('', `分區「${job.folder}」的資料：`, job.folderNotes);
  lines.push(
    '',
    '檔案：',
    `- 這個對話的資料夾：${here}（附件在「附件」，截圖在「截圖」）。`,
    `- 要交給使用者的檔案（報表、圖片、文件）存到 ${join(here, '輸出')}，會自動附在你的回覆裡。`,
    `- 其他機器人和群組的資料夾都在 ${storeDir()} 底下（名稱_編號），需要時可以讀取別人的檔案，但不要改動或刪除別人的檔案。`,
    '',
    '規則：',
    `- 用${({ 'zh-TW': '繁體中文', 'zh-CN': '簡體中文', en: '英文（English）', ja: '日文（日本語）' })[job.lang] || '繁體中文'}回覆，簡潔、先給結果。你的最後輸出會原封不動顯示成聊天訊息。`,
    job.bot.browser === 'mine'
      ? '- 需要操作網站時，用 browser 工具。這是使用者自己的 Chrome（有他已登入的網站和已儲存的密碼）。只在你自己的分頁群組裡操作，不要關閉或改動使用者其他分頁。遇到登入頁時，點帳號欄位，從 Chrome 跳出的已儲存帳號中選一個讓它自動填入；不要自己猜或輸入密碼。'
      : '- 需要操作網站時，用 browser 工具。這是你專屬的瀏覽器（獨立設定檔，登入狀態會保留），不會影響其他機器人。',
    job.bot.page ? `- 你上次停在：${job.bot.page}` : '',
    '- 遇到登入頁、驗證碼、或需要輸入密碼時，停止並回報「需要使用者在電腦上登入」（照抄這幾個字）。使用者會在 OCTA 按「在電腦上打開瀏覽器」，在另一個不會被關掉的視窗登入，登入狀態會保存給你用；不要請使用者在你正在操作的視窗裡輸入。',
    '- 發訊息給任何人、付款、刪除資料、更改帳號設定：除非使用者在對話中明確下令，否則只準備好內容並請使用者確認，不要執行。',
    '- 需要使用者核准才能做的事，在回覆最後單獨一行寫「✅待確認：要做的事（一句話）」（「✅待確認：」這幾個字照抄，不要翻譯），然後停下。使用者回「核准：…」後才執行。',
    '- 只回報實際完成的事，做不到就直說。',
    '- 若這次有用瀏覽器：結束前用 browser_take_screenshot 截目前畫面（type 設 jpeg，filename 設 last.jpeg），並在回覆最後一行寫「📍 目前頁面：網址」。',
    '',
    '對話紀錄（舊到新）：'
  );
  for (const h of job.history) lines.push(`【${h.who}】${h.text}` + (h.paths?.length ? `\n（附件，可直接讀取這些檔案：${h.paths.join('、')}）` : ''));
  lines.push('', '現在請處理這則指示：', job.prompt);
  return lines.filter(l => l !== '').join('\n');
}

// install: { win, mac } shell commands, or npm: package name (needs Node.js); pre: installed first; login: command that starts sign-in
export const ENGINES = {
  claude: { label: 'Claude Code', bin: 'claude', site: 'https://code.claude.com', login: 'claude', loginHint: '視窗出現後輸入 /login，選 Claude 訂閱帳號',
    install: { win: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"', mac: 'curl -fsSL https://claude.ai/install.sh | bash' },
    paths: { win: '%USERPROFILE%\\.local\\bin', mac: '$HOME/.local/bin' } },
  codex: { label: 'Codex CLI（ChatGPT）', bin: 'codex', site: 'https://developers.openai.com/codex/cli', npm: '@openai/codex', login: 'codex login', loginHint: '瀏覽器會打開，用 ChatGPT 帳號登入' },
  gemini: { label: 'Gemini CLI', bin: 'gemini', site: 'https://github.com/google-gemini/gemini-cli', npm: '@google/gemini-cli', login: 'gemini', loginHint: '選「Login with Google」，登入後輸入 /quit 離開' },
  copilot: { label: 'GitHub Copilot CLI', bin: 'copilot', site: 'https://github.com/github/copilot-cli', npm: '@github/copilot', login: 'copilot', loginHint: '視窗出現後輸入 /login，用 GitHub 帳號登入' },
  cursor: { label: 'Cursor CLI', bin: 'agent', site: 'https://cursor.com/cli', login: 'agent login', loginHint: '瀏覽器會打開，用 Cursor 帳號登入',
    install: { win: 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm \'https://cursor.com/install?win32=true\' | iex"', mac: 'curl https://cursor.com/install -fsS | bash' } },
  qwen: { label: 'Qwen Code', bin: 'qwen', site: 'https://github.com/QwenLM/qwen-code', npm: '@qwen-code/qwen-code', login: 'qwen', loginHint: '依畫面選擇登入方式，完成後輸入 /quit 離開' },
  // local open models only — no paid API keys. OpenCode drives the model and the browser tool; Ollama runs the model.
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
// async on purpose: a blocking check freezes the desktop app's window
export function has(bin, fresh) {   // a missing command can't be told apart from a failing one after the fact, so check first
  const c = installed[bin];
  if (!fresh && c && (c.ok || Date.now() - c.t < 60000)) return Promise.resolve(c.ok);
  return new Promise(ok => execFile(WIN ? 'where' : 'which', [bin], { windowsHide: true, timeout: 10000 }, err => {
    installed[bin] = { ok: !err, t: Date.now() };
    ok(!err);
  }));
}
const engineReady = async (k, fresh) => (await has(ENGINES[k].bin, fresh)) && (!ENGINES[k].also || await has(ENGINES[k].also, fresh));
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
  const tok = JSON.parse(readFileSync(f, 'utf8'))?.claudeAiOauth?.accessToken;
  if (!tok) return { error: 'no-credentials' };
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { authorization: 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) return { error: 'HTTP ' + r.status };
  const d = await r.json();
  const w = (x, k) => (x && typeof x.utilization === 'number' ? { k, used: Math.round(x.utilization), reset: x.resets_at || null } : null);
  return { windows: [w(d.five_hour, '5h'), w(d.seven_day, '7d')].filter(Boolean) };
}
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
          const w = (x, k) => (x && typeof x.usedPercent === 'number' ? { k, used: Math.round(x.usedPercent), reset: x.resetsAt ? new Date(x.resetsAt * (x.resetsAt < 1e12 ? 1000 : 1)).toISOString() : null } : null);
          finish(msg.error ? { error: msg.error.message || 'error' } : { windows: [w(rl.primary, '5h'), w(rl.secondary, '7d')].filter(Boolean) });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'octa', title: 'OCTA', version: VERSION } } });
  });
}
let lastUsage = 0;
async function usageReport() {   // every 10 minutes
  if (Date.now() - lastUsage < 10 * 60000) return undefined;
  lastUsage = Date.now();
  const out = {};
  const safe = async (k, fn) => { try { const v = (await engineReady(k)) ? await fn() : null; if (v) out[k] = { ...v, t: Date.now() }; } catch (e) { out[k] = { error: String(e.message || e).slice(0, 80), t: Date.now() }; } };
  await Promise.all([safe('claude', claudeUsage), safe('codex', codexUsage)]);
  return out;
}

async function spawnCli(bin, args, dir, input) {
  if (!(await has(bin))) return { code: -1, out: '', err: '', missing: true };
  return new Promise(resolve => {
    const child = spawn(bin, WIN ? args.map(q) : args, { cwd: dir, shell: WIN, windowsHide: true });
    const out = [], err = [];
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, JOB_TIMEOUT_MS);
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: decode(out), err: e.message, missing: e.code === 'ENOENT' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: decode(out), err: decode(err) + (killed ? '\n執行超過 15 分鐘，已中止。' : '') }); });
    child.stdin.on('error', () => { });
    child.stdin.end(input);
  });
}
const toml = v => (Array.isArray(v) ? '[' + v.map(x => JSON.stringify(String(x))).join(',') + ']' : JSON.stringify(String(v)));
// the model Ollama should use: the bot's, or the first one downloaded on this computer
function ollamaModel(model) {
  if (model) return model.replace(/^ollama\//, '');
  const r = spawnSync('ollama', ['list'], { encoding: 'utf8', shell: WIN, windowsHide: true, timeout: 10000 });
  return (r.stdout || '').split('\n').slice(1).map(l => l.trim().split(/\s+/)[0]).find(Boolean) || '';
}
async function runEngine(engine, prompt, b, model) {
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
      r = await spawnCli('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir, '-o', last, ...m('-m'), ...c.flatMap(x => ['-c', x]), '-'], dir, prompt);
      try { text = readFileSync(last, 'utf8').trim(); } catch { }
      break;
    }
    case 'gemini': r = await spawnCli('gemini', ['-p', STDIN_INSTR, '--yolo', '--include-directories', store, ...m('-m')], dir, prompt); break;
    case 'qwen': r = await spawnCli('qwen', ['--yolo', '--include-directories', store, ...m('-m'), '-p', STDIN_INSTR], dir, prompt); break;
    case 'copilot': r = await spawnCli('copilot', ['-p', FILE_INSTR, '-s', '--allow-all-tools', '--allow-all-paths', '--no-color',
      '--additional-mcp-config', '@' + join(dir, 'copilot-mcp.json'), ...m('--model')], dir, ''); break;
    case 'cursor': r = await spawnCli('agent', ['-p', '--force', '--approve-mcps', '--output-format', 'text', ...m('--model'), FILE_INSTR], dir, ''); break;
    case 'opencode': {
      if (!(await has('ollama'))) { r = { missing: true }; break; }
      const name = ollamaModel(model);
      if (!name) return { ok: false, text: '⚠ 這台電腦的 Ollama 還沒有下載任何模型。請在「AI 連線 → Ollama」按「一鍵安裝並登入」，或在終端機執行 ollama pull qwen3。' };
      // only the local Ollama provider is enabled: no paid APIs
      b.put('opencode.json', {
        $schema: 'https://opencode.ai/config.json', enabled_providers: ['ollama'], model: 'ollama/' + name,
        provider: { ollama: { npm: '@ai-sdk/openai-compatible', name: 'Ollama', options: { baseURL: 'http://127.0.0.1:11434/v1' }, models: { [name]: { name } } } },
        mcp: { browser: { type: 'local', command: [server.command, ...server.args], environment: server.env || {}, enabled: true } }
      });
      r = await spawnCli('opencode', ['run', '--auto', '--dir', dir, '-m', 'ollama/' + name, FILE_INSTR], dir, '');
      break;
    }
    default: r = await spawnCli('claude', ['-p', '--output-format', 'text', '--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config', '--add-dir', store, ...m('--model'),
      '--allowedTools', 'mcp__browser,WebFetch,WebSearch,Read,Write,Edit,Glob,Grep'], dir, prompt);
  }
  text = (text || r.out || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  const E = ENGINES[engine] || ENGINES.claude;
  if (r.missing) return { ok: false, text: `⚠ 這台電腦沒有安裝 ${E.label}。請到「AI 連線」安裝並登入（${E.site}），或在任務設定把這個機器人改用其他 AI。` };
  if (r.code === 0 && text) return { ok: true, text };
  return { ok: false, text: `⚠ ${E.label} 執行失敗：` + ((r.err || '').trim() || (r.out || '').trim() || '結束碼 ' + r.code).slice(-1500) };
}

// ---------- job handlers ----------
async function chatJob(job) {
  const b = botDir(job.bot.id, job.bot.browser), { dir } = b;
  const here = convDir(job.conv || job.bot);
  for (const h of job.history) {   // attachments: already in the folder, or saved there now
    h.paths = [];
    for (const f of h.files || []) {
      try {
        const p = f.path ? join(storeDir(), f.path) : null;
        if (p && existsSync(p)) { h.paths.push(p); continue; }
        if (!f.path) h.paths.push(await saveUpload({ ...f, conv: job.conv?.id || job.bot.id, convName: job.conv?.name || job.bot.name }));
      } catch (e) { log('附件讀取失敗：' + e.message); }
    }
  }
  const start = Date.now() - 1000;
  log(`▶ ${job.bot.name}［${job.bot.engine || 'claude'}］${job.group ? ' @' + job.group.name : ''}：${job.prompt.slice(0, 40)}`);
  const res = await runEngine(job.bot.engine || 'claude', buildPrompt(job, here), b, job.bot.model);
  const shot = newestImage(dir, start);
  if (shot) {   // keep the screenshot in the conversation's 截圖 folder; only its location goes to the cloud
    try {
      const d = new Date(), z = n => String(n).padStart(2, '0'), stamp = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
      const p = freeName(join(here, '截圖'), safeName(job.bot.name) + '-' + stamp + extname(shot.p).toLowerCase());
      copyFileSync(shot.p, p);
      await api('runner/shot', { id: job.id, path: rel(p), name: basename(p), size: shot.size });
    } catch (e) { log('截圖儲存失敗：' + e.message); }
  }
  const page = (res.text.match(/📍\s*目前頁面[:：]\s*(\S+)/) || [])[1];
  await api('runner/done', { id: job.id, ok: res.ok, text: res.text, page, files: res.ok ? newFiles(join(here, '輸出'), start) : [] });
  log(`${res.ok ? '✓' : '✗'} ${job.bot.name}`);
  if (['claude', 'codex'].includes(job.bot.engine || 'claude')) lastUsage = 0;   // refresh how much is left
  try { cfg.onDone?.(job, res); } catch { }
}

async function testJob(job) {
  const b = botDir('_test-' + job.engine);
  log(`🔌 測試 ${ENGINES[job.engine]?.label || job.engine}`);
  const res = await runEngine(job.engine, job.prompt, b, '');
  lastReport = 0; lastUsage = 0;   // refresh the installed list and quotas right after a test
  await api('runner/done', { id: job.id, ok: res.ok, text: res.text });
}

// Is a Chrome window still using this profile? (Windows keeps "lockfile" open; macOS/Linux keep a SingletonLock link)
function profileInUse(profile) {
  if (WIN) {
    const f = join(profile, 'lockfile');
    if (!existsSync(f)) return false;
    try { closeSync(openSync(f, 'r+')); return false; } catch (e) { return ['EBUSY', 'EPERM', 'EACCES'].includes(e.code); }
  }
  try { lstatSync(join(profile, 'SingletonLock')); return true; } catch { return false; }
}
const pause = ms => new Promise(r => setTimeout(r, ms));
// The window stays the user's until they close it: the bot doesn't touch this browser meanwhile,
// so typing a password or a code there is never interrupted.
function openJob(job) {
  return new Promise(async resolve => {
    const { profile } = botDir(job.bot.id);
    const chrome = findChrome();
    const done = (ok, text) => { log(`🌐 ${job.bot.name}：${text}`); api('runner/done', { id: job.id, ok, text }).catch(() => { }).finally(resolve); };
    if (!chrome) return done(false, '⚠ 找不到 Chrome。請在 octa-runner.json 加上 "chrome": "Chrome 執行檔路徑"。');
    // the bot's own automated Chrome may still be closing after its last job: wait so the window isn't shut under you
    for (let i = 0; i < 15 && profileInUse(profile); i++) await pause(1000);
    const target = job.url || job.bot.page;   // no address: the page the bot was last on, or Chrome's last session
    const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', ...(target ? ['--new-window', target] : ['--restore-last-session'])];
    log(`🌐 開啟 ${job.bot.name} 的瀏覽器${target ? '：' + target : '（上次的畫面）'}`);
    let child;
    try { child = spawn(chrome, args, { stdio: 'ignore', windowsHide: false }); } catch (e) { return done(false, '⚠ 無法開啟 Chrome：' + e.message); }
    child.on('error', e => done(false, '⚠ 無法開啟 Chrome：' + e.message));
    child.on('exit', async () => {
      // Chrome often hands the window to another process and exits right away; keep the job
      // (and so the bot) waiting until no window uses the profile any more
      await pause(2000);
      const t0 = Date.now();
      while (profileInUse(profile) && Date.now() - t0 < 3 * 3600000 && !stopped) await pause(3000);
      done(true, '你關掉了我的瀏覽器，登入狀態已保存，我可以繼續工作了。');
    });
  });
}

// ---------- main loop: long-poll, so work starts the moment it's sent ----------
let active = 0, failures = 0, stopped = true, onFatal = null, polling = false, standby = false;
const fileWork = new Set();
function runJob(job) {
  active++;
  (job.kind === 'open' ? openJob(job) : job.kind === 'test' ? testJob(job) : chatJob(job))
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
        wait: true, slots, engines: await engineReport(), usage: await usageReport(),
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

// opts: { url, token, home, max, chrome, pwCli, nodeBin, nodeEnv, log, onFatal, onDone, onStandby, getStore, getExtToken, appVersion }
export function startRunner(opts) {
  cfg = { ...opts, url: opts.url.replace(/\/+$/, '') };
  workDir = join(opts.home, 'work');
  MAX = Math.max(1, Math.min(+opts.max || 3, 8));
  if (opts.log) log = opts.log;
  onFatal = opts.onFatal || null;
  stopped = false; lastReport = 0; lastUsage = 0; standby = false;
  mkdirSync(join(workDir, 'bots'), { recursive: true });
  mkdirSync(storeDir(), { recursive: true });
  log(`OCTA 執行器 v${VERSION} 啟動，最多 ${MAX} 個機器人同時工作；檔案資料夾：${storeDir()}`);
  if (!cfg.pwCli) {
    log('準備瀏覽器工具…');
    spawnSync(WIN ? 'cmd' : 'npx', WIN ? ['/c', 'npx', '-y', PW_MCP, '--version'] : ['-y', PW_MCP, '--version'], { stdio: 'ignore', timeout: 180000 });
  }
  loop();
  const myCfg = cfg;
  return {
    stop: () => { stopped = true; poll?.abort(); if (myCfg.token) fetch(myCfg.url + '/api/runner/bye', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + myCfg.token }, body: '{}' }).catch(() => { }); },
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
