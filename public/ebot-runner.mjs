#!/usr/bin/env node
// E·BOT runner — runs on your own computer, uses YOUR Claude Code login (Pro/Max).
// Each bot gets its own browser window with its own profile (separate logins, cookies, tabs),
// so several bots can work at the same time without touching each other.
//
// Usage:
//   first time:  node ebot-runner.mjs <網站網址> <執行器金鑰>
//   afterwards:  node ebot-runner.mjs
// Requires: Node 18+, Claude Code (`claude` logged in with /login), Google Chrome.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '3';
const PW_MCP = '@playwright/mcp@0.0.83';
const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(here, 'ebot-runner.json');
const workDir = join(here, 'work');
const WIN = process.platform === 'win32';
mkdirSync(join(workDir, 'bots'), { recursive: true });
if (!existsSync(join(workDir, 'CLAUDE.md')))
  writeFileSync(join(workDir, 'CLAUDE.md'), '# 給機器人的背景資料\n\n在這裡寫下所有機器人都要知道的固定資訊（網站網址、試算表連結、房號、入住說明範本等）。\n');

let cfg = {};
if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
if (process.argv[2]) {
  cfg = { ...cfg, url: process.argv[2].replace(/\/+$/, ''), token: process.argv[3] };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}
if (!cfg.url || !cfg.token) {
  console.error('第一次請執行：node ebot-runner.mjs <網站網址> <執行器金鑰>');
  process.exit(1);
}
const MAX = Math.max(1, Math.min(+cfg.max || 3, 8));   // bots working at the same time
const POLL_MS = 5000;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

async function api(path, body) {
  const r = await fetch(cfg.url + '/api/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.token },
    body: JSON.stringify(body || {})
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
  const npx = WIN ? { command: 'cmd', args: ['/c', 'npx'] } : { command: 'npx', args: [] };
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({
    mcpServers: {
      browser: {
        command: npx.command,
        args: [...npx.args, '-y', PW_MCP, '--browser', 'chrome', '--user-data-dir', profile, '--output-dir', join(dir, 'shots')]
      }
    }
  }, null, 2));
  return { dir, profile };
}
function findChrome() {
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
    `你是 E·BOT 裡的機器人「${job.bot.name}」，在使用者自己的電腦上執行。`,
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
  lines.push(
    '',
    '規則：',
    '- 用繁體中文回覆，簡潔、先給結果。你的最後輸出會原封不動顯示成聊天訊息。',
    '- 需要操作網站時，用 browser 工具。這是你專屬的瀏覽器（獨立設定檔，登入狀態會保留），不會影響其他機器人。',
    job.bot.page ? `- 你上次停在：${job.bot.page}` : '',
    '- 遇到登入頁、驗證碼、或需要輸入密碼時，停止並回報「需要使用者在電腦上登入」。',
    '- 發訊息給任何人、付款、刪除資料、更改帳號設定：除非使用者在對話中明確下令，否則只準備好內容並請使用者確認，不要執行。',
    '- 只回報實際完成的事，做不到就直說。',
    '- 若這次有用瀏覽器：結束前用 browser_take_screenshot 截目前畫面（type 設 jpeg，filename 設 last.jpeg），並在回覆最後一行寫「📍 目前頁面：網址」。',
    '',
    '對話紀錄（舊到新）：'
  );
  for (const h of job.history) lines.push(`【${h.who}】${h.text}`);
  lines.push('', '現在請處理這則指示：', job.prompt);
  return lines.filter(l => l !== '').join('\n');
}

function runClaude(prompt, dir) {
  return new Promise(resolve => {
    const args = ['-p', '--output-format', 'text', '--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config',
      '--allowedTools', 'mcp__browser,WebFetch,WebSearch,Read,Write,Edit,Glob,Grep'];
    const child = spawn('claude', WIN ? args.map(q) : args, { cwd: dir, shell: WIN, windowsHide: true });
    let out = '', errOut = '';
    const timer = setTimeout(() => { child.kill(); errOut += '\n執行超過 15 分鐘，已中止。'; }, JOB_TIMEOUT_MS);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (errOut += d));
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, text: '⚠ 無法啟動 Claude Code：' + e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve({ ok: true, text: out.trim() });
      else resolve({ ok: false, text: '⚠ 執行失敗：' + (errOut.trim() || out.trim() || '結束碼 ' + code).slice(-1500) });
    });
    child.stdin.end(prompt);
  });
}

// ---------- job handlers ----------
async function chatJob(job) {
  const { dir } = botDir(job.bot.id);
  const start = Date.now() - 1000;
  log(`▶ ${job.bot.name}${job.group ? ' @' + job.group.name : ''}：${job.prompt.slice(0, 40)}`);
  const res = await runClaude(buildPrompt(job), dir);
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

function openJob(job) {
  return new Promise(resolve => {
    const { profile } = botDir(job.bot.id);
    const chrome = findChrome();
    if (!chrome) {
      api('runner/done', { id: job.id, ok: false, text: '⚠ 找不到 Chrome。請在 ebot-runner.json 加上 "chrome": "Chrome 執行檔路徑"。' }).finally(resolve);
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
let active = 0, failures = 0, ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    while (active < MAX) {
      const { job } = await api('runner/next');
      failures = 0;
      if (!job) break;
      active++;
      (job.kind === 'open' ? openJob(job) : chatJob(job))
        .catch(e => { log('任務錯誤：' + e.message); return api('runner/done', { id: job.id, ok: false, text: '⚠ ' + e.message }).catch(() => { }); })
        .finally(() => { active--; setTimeout(tick, 300); });
    }
  } catch (e) {
    failures++;
    log('連線問題：' + e.message);
    if (/執行器金鑰|請先登入/.test(e.message)) { console.error('金鑰無效，請到網站「設定」重新產生。'); process.exit(1); }
  } finally { ticking = false; }
}
function schedule() { tick().finally(() => setTimeout(schedule, Math.min(POLL_MS * 2 ** Math.min(failures, 4), 60000))); }

log(`E·BOT 執行器 v${VERSION} 啟動，連線到 ${cfg.url}，最多 ${MAX} 個機器人同時工作（Ctrl+C 停止）`);
log('準備瀏覽器工具…');
spawnSync(WIN ? 'cmd' : 'npx', WIN ? ['/c', 'npx', '-y', PW_MCP, '--version'] : ['-y', PW_MCP, '--version'], { stdio: 'ignore', timeout: 180000 });
schedule();
