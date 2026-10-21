#!/usr/bin/env node
// OCTA runner — runs on your own computer, uses YOUR Claude Code login (Pro/Max).
// Each bot gets its own browser window with its own profile (separate logins, cookies, tabs),
// so several bots can work at the same time without touching each other.
//
// CLI (cloud version):
//   first time:  node octa-runner.mjs <網站網址> <執行器金鑰>
//   afterwards:  node octa-runner.mjs
// The desktop app imports startRunner() instead.
// Requires: Node 18+, Claude Code (`claude` logged in with /login), Google Chrome.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '7';
const PW_MCP = '@playwright/mcp@0.0.83';
const WIN = process.platform === 'win32';
const POLL_MS = 5000;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

let cfg = {}, workDir = '', MAX = 3, log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

async function api(path, body, method = 'POST') {
  const r = await fetch(cfg.url + '/api/' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: 'Bearer ' + cfg.token } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

// ---------- per-bot workspace ----------
function botDir(id) {
  const safe = String(id).replace(/[^\w-]/g, '');
  const dir = join(workDir, 'bots', safe);
  mkdirSync(join(dir, 'shots'), { recursive: true });
  const profile = join(dir, 'profile');
  const pwArgs = ['--browser', 'chrome', '--user-data-dir', profile, '--output-dir', join(dir, 'shots')];
  const server = cfg.pwCli
    ? { command: cfg.nodeBin || process.execPath, args: [cfg.pwCli, ...pwArgs], env: cfg.nodeEnv || {} }   // bundled (desktop app)
    : WIN ? { command: 'cmd', args: ['/c', 'npx', '-y', PW_MCP, ...pwArgs] } : { command: 'npx', args: ['-y', PW_MCP, ...pwArgs] };
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { browser: server } }, null, 2));
  // the same browser server, in each CLI's own config format
  const put = (f, o) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), JSON.stringify(o, null, 2)); };
  put('.gemini/settings.json', { mcpServers: { browser: { ...server, timeout: 60000, trust: true } } });
  put('.qwen/settings.json', { mcpServers: { browser: { ...server, timeout: 60000, trust: true } } });
  put('.cursor/mcp.json', { mcpServers: { browser: server } });
  put('copilot-mcp.json', { mcpServers: { browser: { type: 'local', ...server, tools: ['*'] } } });
  put('opencode.json', { $schema: 'https://opencode.ai/config.json', mcp: { browser: { type: 'local', command: [server.command, ...server.args], environment: server.env || {}, enabled: true } } });
  return { dir, profile, server };
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
const q = a => (WIN && /[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);

// ---------- prompts ----------
function buildPrompt(job) {
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
    '規則：',
    '- 用繁體中文回覆，簡潔、先給結果。你的最後輸出會原封不動顯示成聊天訊息。',
    '- 需要操作網站時，用 browser 工具。這是你專屬的瀏覽器（獨立設定檔，登入狀態會保留），不會影響其他機器人。',
    job.bot.page ? `- 你上次停在：${job.bot.page}` : '',
    '- 遇到登入頁、驗證碼、或需要輸入密碼時，停止並回報「需要使用者在電腦上登入」。',
    '- 發訊息給任何人、付款、刪除資料、更改帳號設定：除非使用者在對話中明確下令，否則只準備好內容並請使用者確認，不要執行。',
    '- 需要使用者核准才能做的事，在回覆最後單獨一行寫「✅待確認：要做的事（一句話）」，然後停下。使用者回「核准：…」後才執行。',
    '- 只回報實際完成的事，做不到就直說。',
    '- 若這次有用瀏覽器：結束前用 browser_take_screenshot 截目前畫面（type 設 jpeg，filename 設 last.jpeg），並在回覆最後一行寫「📍 目前頁面：網址」。',
    '',
    '對話紀錄（舊到新）：'
  );
  for (const h of job.history) lines.push(`【${h.who}】${h.text}` + (h.paths?.length ? `\n（附件，可直接讀取這些檔案：${h.paths.join('、')}）` : ''));
  lines.push('', '現在請處理這則指示：', job.prompt);
  return lines.filter(l => l !== '').join('\n');
}

// install: { win, mac } shell commands, or npm: package name (needs Node.js); login: command that starts sign-in
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
  opencode: { label: 'OpenCode', bin: 'opencode', site: 'https://opencode.ai', npm: 'opencode-ai', login: 'opencode auth login', loginHint: '選你要用的服務（DeepSeek、xAI、Ollama…）並貼上金鑰' }
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
function has(bin, fresh) {   // a missing command can't be told apart from a failing one after the fact, so check first
  const c = installed[bin];
  if (!fresh && c && (c.ok || Date.now() - c.t < 60000)) return c.ok;
  const r = spawnSync(WIN ? 'where' : 'which', [bin], { windowsHide: true });
  installed[bin] = { ok: r.status === 0, t: Date.now() };
  return r.status === 0;
}
let lastReport = 0;
const engineReport = () => {   // tell the app which AI tools this computer has, about once a minute
  if (Date.now() - lastReport < 60000) return undefined;
  lastReport = Date.now();
  return Object.fromEntries(Object.entries(ENGINES).map(([k, e]) => [k, has(e.bin, true)]));
};
function spawnCli(bin, args, dir, input) {
  return new Promise(resolve => {
    if (!has(bin)) return resolve({ code: -1, out: '', err: '', missing: true });
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
async function runEngine(engine, prompt, b, model) {
  const { dir, server } = b;
  const m = (flag) => (model ? [flag, model] : []);
  writeFileSync(join(dir, 'octa-task.md'), prompt);   // for CLIs that take the prompt as an argument (avoids Windows length limits)
  let r, text;
  switch (engine) {
    case 'codex': {
      const last = join(dir, '.codex-last.txt');
      try { writeFileSync(last, ''); } catch { }
      const c = ['approval_policy="never"', `mcp_servers.browser.command=${toml(server.command)}`, `mcp_servers.browser.args=${toml(server.args)}`,
        'mcp_servers.browser.startup_timeout_sec=60', 'mcp_servers.browser.default_tools_approval_mode="approve"',
        ...Object.entries(server.env || {}).map(([k, v]) => `mcp_servers.browser.env.${k}=${toml(v)}`)];
      r = await spawnCli('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir, '-o', last, ...m('-m'), ...c.flatMap(x => ['-c', x]), '-'], dir, prompt);
      try { text = readFileSync(last, 'utf8').trim(); } catch { }
      break;
    }
    case 'gemini': r = await spawnCli('gemini', ['-p', STDIN_INSTR, '--yolo', ...m('-m')], dir, prompt); break;
    case 'qwen': r = await spawnCli('qwen', ['--yolo', ...m('-m'), '-p', STDIN_INSTR], dir, prompt); break;
    case 'copilot': r = await spawnCli('copilot', ['-p', FILE_INSTR, '-s', '--allow-all-tools', '--allow-all-paths', '--no-color',
      '--additional-mcp-config', '@' + join(dir, 'copilot-mcp.json'), ...m('--model')], dir, ''); break;
    case 'cursor': r = await spawnCli('agent', ['-p', '--force', '--approve-mcps', '--output-format', 'text', ...m('--model'), FILE_INSTR], dir, ''); break;
    case 'opencode': r = await spawnCli('opencode', ['run', '--auto', '--dir', dir, ...m('-m'), FILE_INSTR], dir, ''); break;
    default: r = await spawnCli('claude', ['-p', '--output-format', 'text', '--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config', ...m('--model'),
      '--allowedTools', 'mcp__browser,WebFetch,WebSearch,Read,Write,Edit,Glob,Grep'], dir, prompt);
  }
  text = (text || r.out).replace(/\x1b\[[0-9;]*m/g, '').trim();
  const E = ENGINES[engine] || ENGINES.claude;
  if (r.missing) return { ok: false, text: `⚠ 這台電腦沒有安裝 ${E.label}。請先安裝並登入（${E.site}），或在任務設定把這個機器人改用其他 AI。` };
  if (r.code === 0 && text) return { ok: true, text };
  return { ok: false, text: `⚠ ${E.label} 執行失敗：` + (r.err.trim() || r.out.trim() || '結束碼 ' + r.code).slice(-1500) };
}

// ---------- job handlers ----------
async function chatJob(job) {
  const b = botDir(job.bot.id), { dir } = b;
  for (const h of job.history) {   // attachments → files the bot can Read
    h.paths = [];
    for (const f of h.files || []) {
      const p = join(dir, 'inputs', f.id.slice(-8) + '-' + basename(f.name).replace(/[^\w.\-\u4e00-\u9fff]/g, '_'));
      try {
        if (!existsSync(p)) { const d = await api('file/' + f.id, null, 'GET'); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.from(d.data, 'base64')); }
        h.paths.push(p);
      } catch (e) { log('附件下載失敗：' + e.message); }
    }
  }
  const start = Date.now() - 1000;
  log(`▶ ${job.bot.name}［${job.bot.engine || 'claude'}］${job.group ? ' @' + job.group.name : ''}：${job.prompt.slice(0, 40)}`);
  const res = await runEngine(job.bot.engine || 'claude', buildPrompt(job), b, job.bot.model);
  const shot = newestImage(dir, start);
  if (shot && shot.size < 1_100_000) {
    const ext = extname(shot.p).slice(1).toLowerCase();
    await api('runner/shot', { id: job.id, mime: 'image/' + (ext === 'jpg' ? 'jpeg' : ext), data: readFileSync(shot.p).toString('base64') })
      .catch(e => log('截圖上傳失敗：' + e.message));
  }
  const page = (res.text.match(/📍\s*目前頁面[:：]\s*(\S+)/) || [])[1];
  await api('runner/done', { id: job.id, ok: res.ok, text: res.text, page });
  log(`${res.ok ? '✓' : '✗'} ${job.bot.name}`);
}

async function testJob(job) {
  const b = botDir('_test-' + job.engine);
  log(`🔌 測試 ${ENGINES[job.engine]?.label || job.engine}`);
  const res = await runEngine(job.engine, job.prompt, b, '');
  lastReport = 0;   // refresh the installed list right after a test
  await api('runner/done', { id: job.id, ok: res.ok, text: res.text });
}

function openJob(job) {
  return new Promise(resolve => {
    const { profile } = botDir(job.bot.id);
    const chrome = findChrome();
    if (!chrome) {
      api('runner/done', { id: job.id, ok: false, text: '⚠ 找不到 Chrome。請在 octa-runner.json 加上 "chrome": "Chrome 執行檔路徑"。' }).finally(resolve);
      return;
    }
    log(`🌐 開啟 ${job.bot.name} 的瀏覽器`);
    const child = spawn(chrome, [`--user-data-dir=${profile}`, '--no-first-run', '--new-window', job.url || job.bot.page || 'about:blank'], { stdio: 'ignore' });
    child.on('error', e => api('runner/done', { id: job.id, ok: false, text: '⚠ 無法開啟 Chrome：' + e.message }).finally(resolve));
    child.on('exit', () => {
      api('runner/done', { id: job.id, ok: true, text: '瀏覽器已關閉，登入狀態已保存在我的專屬設定檔。' }).finally(resolve);
      log(`🌐 ${job.bot.name} 的瀏覽器已關閉`);
    });
  });
}

// ---------- main loop ----------
let active = 0, failures = 0, ticking = false, stopped = false, onFatal = null;
async function tick() {
  if (ticking || stopped) return;
  ticking = true;
  try {
    while (active < MAX && !stopped) {
      const { job } = await api('runner/next', { engines: engineReport() });
      failures = 0;
      if (!job) break;
      active++;
      (job.kind === 'open' ? openJob(job) : job.kind === 'test' ? testJob(job) : chatJob(job))
        .catch(e => { log('任務錯誤：' + e.message); return api('runner/done', { id: job.id, ok: false, text: '⚠ ' + e.message }).catch(() => { }); })
        .finally(() => { active--; setTimeout(tick, 300); });
    }
  } catch (e) {
    failures++;
    log('連線問題：' + e.message);
    if (/執行器金鑰|請先登入/.test(e.message)) { stopped = true; onFatal?.('金鑰無效，請到網站「設定」重新產生。'); }
  } finally { ticking = false; }
}
function schedule() { if (!stopped) tick().finally(() => setTimeout(schedule, Math.min(POLL_MS * 2 ** Math.min(failures, 4), 60000))); }

// opts: { url, token, home, max, chrome, pwCli, nodeBin, nodeEnv, log, onFatal }
export function startRunner(opts) {
  cfg = { ...opts, url: opts.url.replace(/\/+$/, '') };
  workDir = join(opts.home, 'work');
  MAX = Math.max(1, Math.min(+opts.max || 3, 8));
  if (opts.log) log = opts.log;
  onFatal = opts.onFatal || null;
  stopped = false;
  mkdirSync(join(workDir, 'bots'), { recursive: true });
  if (!existsSync(join(workDir, 'CLAUDE.md')))
    writeFileSync(join(workDir, 'CLAUDE.md'), '# 給機器人的背景資料\n\n這個檔案所有機器人都會讀。也可以直接在 OCTA 的「設定 → 共用資料」和各分區資料裡填寫。\n');
  log(`OCTA 執行器 v${VERSION} 啟動，最多 ${MAX} 個機器人同時工作`);
  if (!cfg.pwCli) {
    log('準備瀏覽器工具…');
    spawnSync(WIN ? 'cmd' : 'npx', WIN ? ['/c', 'npx', '-y', PW_MCP, '--version'] : ['-y', PW_MCP, '--version'], { stdio: 'ignore', timeout: 180000 });
  }
  schedule();
  return { stop: () => { stopped = true; }, active: () => active };
}

// ---------- CLI ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const cfgPath = join(here, 'octa-runner.json'), oldCfg = join(here, 'ebot-runner.json');
  let c = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : existsSync(oldCfg) ? JSON.parse(readFileSync(oldCfg, 'utf8')) : {};
  if (process.argv[2]) { c = { ...c, url: process.argv[2].replace(/\/+$/, ''), token: process.argv[3] }; writeFileSync(cfgPath, JSON.stringify(c, null, 2)); }
  if (!c.url || !c.token) { console.error('第一次請執行：node octa-runner.mjs <網站網址> <執行器金鑰>'); process.exit(1); }
  console.log(`連線到 ${c.url}（Ctrl+C 停止）`);
  startRunner({ ...c, home: here, onFatal: m => { console.error(m); process.exit(1); } });
}
