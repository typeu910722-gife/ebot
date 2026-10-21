#!/usr/bin/env node
// E·BOT runner — runs on your own computer, uses YOUR Claude Code login (Pro/Max).
// Usage:
//   first time:  node ebot-runner.mjs <網站網址> <執行器金鑰>
//   afterwards:  node ebot-runner.mjs
// Requires: Node 18+, Claude Code (`claude` logged in with /login), Chrome + Claude in Chrome extension.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(here, 'ebot-runner.json');
const workDir = join(here, 'work');
mkdirSync(workDir, { recursive: true });
if (!existsSync(join(workDir, 'CLAUDE.md')))
  writeFileSync(join(workDir, 'CLAUDE.md'), '# 給機器人的背景資料\n\n在這裡寫下機器人需要知道的固定資訊（網站網址、試算表連結、房號、入住說明範本等）。\n');

let cfg = {};
if (process.argv[2]) {
  cfg = { url: process.argv[2].replace(/\/+$/, ''), token: process.argv[3] };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
} else if (existsSync(cfgPath)) cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
if (!cfg.url || !cfg.token) {
  console.error('第一次請執行：node ebot-runner.mjs <網站網址> <執行器金鑰>');
  process.exit(1);
}

const POLL_MS = 5000;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const TOOLS = 'mcp__claude-in-chrome,WebFetch,WebSearch,Read,Write,Edit,Glob,Grep';
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
  lines.push(
    '',
    '規則：',
    '- 用繁體中文回覆，簡潔、先給結果。你的最後輸出會原封不動顯示成聊天訊息。',
    '- 需要操作網站時使用 Claude in Chrome（使用者已登入的 Chrome）。',
    '- 遇到登入頁、驗證碼、或需要輸入密碼時，停止並回報需要使用者處理。',
    '- 發訊息給任何人、付款、刪除資料、更改帳號設定：除非使用者在對話中明確下令，否則只準備好內容並請使用者確認，不要執行。',
    '- 只回報實際完成的事，做不到就直說。',
    '',
    '對話紀錄（舊到新）：'
  );
  for (const h of job.history) lines.push(`【${h.who}】${h.text}`);
  lines.push('', '現在請處理這則指示：', job.prompt);
  return lines.join('\n');
}

function runClaude(prompt) {
  return new Promise(resolve => {
    const child = spawn('claude', ['-p', '--chrome', '--output-format', 'text', '--allowedTools', TOOLS], {
      cwd: workDir, shell: process.platform === 'win32', windowsHide: true
    });
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

let failures = 0;
async function loop() {
  try {
    const { job } = await api('runner/next');
    failures = 0;
    if (job) {
      log(`▶ ${job.bot.name}${job.group ? ' @' + job.group.name : ''}：${job.prompt.slice(0, 40)}`);
      const res = await runClaude(buildPrompt(job));
      await api('runner/done', { id: job.id, ok: res.ok, text: res.text });
      log(res.ok ? '✓ 完成' : '✗ 失敗');
      return setTimeout(loop, 500);
    }
  } catch (e) {
    failures++;
    log('連線問題：' + e.message);
    if (/執行器金鑰|請先登入/.test(e.message)) { console.error('金鑰無效，請到網站「設定」重新產生。'); process.exit(1); }
  }
  setTimeout(loop, Math.min(POLL_MS * 2 ** Math.min(failures, 4), 60000));
}

log(`E·BOT 執行器啟動，連線到 ${cfg.url}（按 Ctrl+C 停止）`);
loop();
