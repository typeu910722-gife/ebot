// OCTA API — Cloudflare Pages Function, single router.
// Web app uses a "web" session token; each computer's runner uses its own "runner" token.
// One computer per account is the 主機 (host): it runs every bot. Phones and other computers
// use the web app to give instructions. Changes bump users.rev; clients and the host long-poll it.

const J = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (msg, status = 400) => J({ error: msg }, status);
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const randTok = () => hex(crypto.getRandomValues(new Uint8Array(24)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN = 60000, DAY = 86400000;
const WARM = [0, 30, 60, 120, 300, 600, -1];   // AI 待機 seconds after a reply (0: off, -1: always)
const MAX_ASK_DEPTH = 4;          // how many times bots may hand questions to each other in one run
const HOST_ONLINE_MS = 6 * MIN;   // the host writes a heartbeat every ~4 minutes
const WAIT_MS = 25000;            // long-poll length
const CHUNK = 900_000;            // base64 characters per stored piece
const MAX_FILE = 10 * 1024 * 1024;
const SESSION_IDLE = 90 * DAY;    // web sign-ins expire after 90 days without use

async function pbkdf2(pw, salt, iter = 100000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: iter }, key, 256));
}
async function hashPw(pw) { const salt = randTok(); return `pbkdf2$100000$${salt}$${await pbkdf2(pw, salt)}`; }
async function checkPw(pw, stored) {
  const [, iter, salt, h] = String(stored || '').split('$');
  if (!salt) return false;
  const got = await pbkdf2(pw, salt, +iter);
  if (got.length !== h.length) return false;
  let d = 0; for (let i = 0; i < h.length; i++) d |= got.charCodeAt(i) ^ h.charCodeAt(i);
  return d === 0;
}
// short description of the device from its user agent, for the device list
function deviceName(ua) {
  ua = String(ua || '');
  const os = /OCTA|Electron/.test(ua) ? 'OCTA 電腦版' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '裝置';
  const br = /OCTA|Electron/.test(ua) ? '' : /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}
const reqMeta = req => ({
  ua: deviceName(req.headers.get('user-agent')),
  ip: req.headers.get('cf-connecting-ip') || '',
  place: [req.cf?.city, req.cf?.country].filter(Boolean).join(', ')
});
async function newSession(db, userId, kind, label = null, meta = {}) {
  const t = randTok();
  await db.prepare('INSERT INTO sessions (token,user_id,kind,label,created,seen,ua,ip,place) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(await sha(t), userId, kind, label, now(), now(), meta.ua || null, meta.ip || null, meta.place || null).run();
  return t;
}
async function auth(req, db) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return null;
  const tok = await sha(t);
  const s = await db.prepare('SELECT s.token,s.user_id,s.kind,s.label,s.seen,s.created,s.info,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').bind(tok).first();
  if (!s) return null;
  if (s.kind === 'web') {
    const last = s.seen || s.created;
    if (now() - last > SESSION_IDLE) { await db.prepare('DELETE FROM sessions WHERE token=?').bind(tok).run(); return null; }
    if (now() - last > 6 * 3600000) await db.prepare('UPDATE sessions SET seen=? WHERE token=?').bind(now(), tok).run();   // rarely written
  }
  return s;
}
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
// routine times: "HH:MM" every day, or "*/N" every N minutes (5–720)
const isEvery = t => /^\*\/\d+$/.test(t);
const cleanTimes = a => {
  const list = Array.isArray(a) ? a : [];
  const fixed = [...new Set(list.filter(s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)))].sort().slice(0, 12);
  const ev = list.map(s => String(s).match(/^\*\/(\d+)$/)).filter(Boolean).map(mm => Math.min(720, Math.max(5, +mm[1])))[0];
  return ev ? ['*/' + ev, ...fixed] : fixed;
};
const localNow = (env, t = now()) => {
  const d = new Date(t + (+env.TZ_OFFSET_MIN || 0) * 60000);
  return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) };
};
const bump = (db, userId) => db.prepare('UPDATE users SET rev=rev+1 WHERE id=?').bind(userId).run();

async function addMsg(db, userId, conv, by, text, files = null) {
  await db.prepare('INSERT INTO messages (user_id,conv,by_,text,files,ts) VALUES (?,?,?,?,?,?)').bind(userId, conv, by, text, files && files.length ? JSON.stringify(files) : null, now()).run();
}
// chain: list of bot ids (all use `prompt`) or {b, p} steps
async function addJob(db, userId, conv, chain, prompt, depth = 0) {
  const steps = chain.map(s => (typeof s === 'string' ? { b: s, p: prompt } : s));
  if (!steps.length) return;
  await db.prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth) VALUES (?,?,?,?,?,?,?)')
    .bind(userId, conv, steps[0].b, JSON.stringify(steps.slice(1)), steps[0].p, now(), depth).run();
}
const STANDBY = '待命巡查';   // a bot on 24-hour standby: checks its duties every N minutes, says nothing when there's nothing to do
const BG = /^〔背景:([^:〕]+):(ask|give)〕/;   // a bot's message to another bot, run in the other bot's own chat
const turnsOf = g => /輪流|依序|按順序|接力/.test(g.task || '');
const passed = t => /^[（(]?\s*(略過|PASS)\s*[）)]?[。.]?$/i.test(String(t).trim());
async function loadAll(db, userId) {
  const [b, g, f, r] = await db.batch([
    db.prepare('SELECT id,name,task,folder,engine,model,avatar,browser,shot_ts,shot_file,page,bpc FROM bots WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,name,task,members,folder FROM groups_ WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,name,notes FROM folders WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,conv,name,prompt,times,enabled,hook,watch FROM routines WHERE user_id=? ORDER BY created').bind(userId)
  ]);
  return {
    bots: b.results,
    groups: g.results.map(x => ({ ...x, members: JSON.parse(x.members) })),
    folders: f.results,
    routines: r.results.map(x => ({ ...x, times: JSON.parse(x.times), enabled: !!x.enabled, watch: x.watch ? JSON.parse(x.watch) : null }))
  };
}
async function getSettings(db, userId) {
  const u = await db.prepare('SELECT settings FROM users WHERE id=?').bind(userId).first();
  try { return JSON.parse(u?.settings || '{}'); } catch { return {}; }
}
const putSettings = (db, userId, st) => db.prepare('UPDATE users SET settings=? WHERE id=?').bind(JSON.stringify(st), userId).run();
const mask = t => (t ? '••••' + String(t).slice(-4) : '');
async function sendNotify(env, st, text) {
  const out = [];
  if (st.tg?.token && st.tg?.chat) {
    const r = await fetch(`https://api.telegram.org/bot${st.tg.token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: st.tg.chat, text: text.slice(0, 4000) })
    }).catch(() => null);
    out.push(r?.ok ? 'Telegram' : 'Telegram（失敗）');
  }
  if (st.line?.token && st.line?.to) {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + st.line.token },
      body: JSON.stringify({ to: st.line.to, messages: [{ type: 'text', text: text.slice(0, 4900) }] })
    }).catch(() => null);
    out.push(r?.ok ? 'LINE' : 'LINE（失敗）');
  }
  return out;
}
const needsYou = t => /✅待確認|需要使用者|^⚠/m.test(t);
const ENGINES = ['claude', 'codex', 'gemini', 'grok', 'grokbot', 'copilot', 'cursor', 'qwen', 'opencode'];
const engineOk = e => (ENGINES.includes(e) ? e : 'claude');
const avatarOk = a => { const v = clean(a, 16); return v && !/[<>&"']/.test(v) ? v : null; };
// grokbot: the model field holds the Grok Bot's name. opencode is only used with local Ollama models (no paid APIs): "qwen3" → "ollama/qwen3"
const modelOk = (engine, m) => { const v = clean(m, 80) || null; if (!v || engine !== 'opencode') return v; return 'ollama/' + v.replace(/^ollama\//, '').replace(/^.*\//, ''); };
const TEMPLATE_AVATARS = { a: '🤖', r1: '🔎', r2: '📝', s1: '🧾', s2: '💬', s3: '📊', l1: '🛎️', l2: '🧹', l3: '👋' };
// Columns and tables added after the first release. Applied automatically the first time a new
// version runs against an older database (each statement is skipped if it already exists).
const MIGRATIONS = [
  'ALTER TABLE users ADD COLUMN host TEXT', 'ALTER TABLE users ADD COLUMN rev INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE users ADD COLUMN reset TEXT',
  'ALTER TABLE sessions ADD COLUMN seen INTEGER', 'ALTER TABLE sessions ADD COLUMN ua TEXT', 'ALTER TABLE sessions ADD COLUMN ip TEXT', 'ALTER TABLE sessions ADD COLUMN place TEXT', 'ALTER TABLE sessions ADD COLUMN info TEXT',
  'ALTER TABLE bots ADD COLUMN shot_file TEXT',
  'ALTER TABLE files ADD COLUMN conv TEXT', 'ALTER TABLE files ADD COLUMN loc TEXT', 'ALTER TABLE files ADD COLUMN path TEXT', 'ALTER TABLE files ADD COLUMN size INTEGER', 'ALTER TABLE files ADD COLUMN want INTEGER',
  'CREATE INDEX IF NOT EXISTS file_user ON files(user_id, loc)', 'CREATE INDEX IF NOT EXISTS ses_user ON sessions(user_id, kind)', 'CREATE INDEX IF NOT EXISTS msg_conv ON messages(user_id, conv, id)',
  'CREATE TABLE IF NOT EXISTS chunks (file_id TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (file_id, n))',
  'CREATE TABLE IF NOT EXISTS logins (k TEXT PRIMARY KEY, fails INTEGER NOT NULL, until INTEGER NOT NULL)',
  'ALTER TABLE jobs ADD COLUMN progress TEXT', 'ALTER TABLE jobs ADD COLUMN tokens INTEGER',
  'ALTER TABLE routines ADD COLUMN hook TEXT', 'ALTER TABLE routines ADD COLUMN watch TEXT', 'ALTER TABLE routines ADD COLUMN wstate TEXT',
  'CREATE INDEX IF NOT EXISTS routine_hook ON routines(hook)',
  'ALTER TABLE files ADD COLUMN pc TEXT', 'ALTER TABLE bots ADD COLUMN bpc TEXT', 'ALTER TABLE jobs ADD COLUMN pc TEXT'
];
let schemaOk = false;
async function ensureSchema(db) {
  if (schemaOk) return;
  try { await db.prepare('SELECT want FROM files LIMIT 0').all(); await db.prepare('SELECT k FROM logins LIMIT 0').all(); await db.prepare('SELECT progress, tokens FROM jobs LIMIT 0').all(); await db.prepare('SELECT hook, watch, wstate FROM routines LIMIT 0').all(); await db.prepare('SELECT pc FROM files LIMIT 0').all(); await db.prepare('SELECT bpc FROM bots LIMIT 0').all(); await db.prepare('SELECT pc FROM jobs LIMIT 0').all(); schemaOk = true; return; } catch { }
  for (const sql of MIGRATIONS) { try { await db.prepare(sql).run(); } catch { } }
  schemaOk = true;
}

// requests that don't change anything other devices need to see
const NO_BUMP = /^(signup|login|logout|pair|cron|wait|reset|password|devices|notify\/|settings|runner\/(next|blob|hello|bye|progress))/;
const folderOk = (folders, id) => (id && folders.some(f => f.id === id) ? id : null);
const MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const mimeOf = (name, given) => clean(given, 100) || MIMES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';
const safePath = p => { const v = clean(p, 400).replace(/\\/g, '/'); return v && !v.split('/').includes('..') && !/^\/|^[a-z]:/i.test(v) ? v : null; };

// ---------- host computer ----------
async function hostInfo(db, userId) {
  const u = await db.prepare('SELECT host, engines FROM users WHERE id=?').bind(userId).first();
  const runners = (await db.prepare("SELECT token,label,seen,info,created FROM sessions WHERE user_id=? AND kind='runner' ORDER BY created").bind(userId).all()).results;
  const host = runners.find(r => (r.label || 'runner') === (u?.host || '')) || null;
  const info = host?.info ? JSON.parse(host.info) : null;
  return {
    hostLabel: host ? (host.label || 'runner') : null,
    online: !!host && now() - (host.seen || 0) < HOST_ONLINE_MS,
    engines: info?.engines || (u?.engines ? JSON.parse(u.engines) : null),
    models: info?.models || null,
    runners
  };
}

// ---------- 例行任務 ----------
// sched 'cloud' (default): fired on time by the cloud (cron / any open client); if the host is off the job waits for it.
// sched 'pc': fired only by the host computer itself; times missed while it was off are skipped.
async function fireRoutines(env, db, userId, byHost) {
  const list = (await db.prepare('SELECT * FROM routines WHERE user_id=? AND enabled=1').bind(userId).all()).results;
  if (!list.length) return 0;
  const st = await getSettings(db, userId);
  const pc = st.sched === 'pc';
  if (pc && !byHost) return 0;
  const { date, hm } = localNow(env), late = localNow(env, now() - 10 * MIN).hm;
  let n = 0, all = null, hostOnline = null;
  for (const r of list) {
    const fired = JSON.parse(r.fired || '{}');
    const times = JSON.parse(r.times);
    const due = times.filter(t => !isEvery(t) && t <= hm && fired[t] !== date);
    // "every N minutes": due when N minutes passed since the last run, and the previous run is finished
    const ev = times.find(isEvery);
    if (ev && now() - (+fired[ev] || 0) >= (+ev.slice(2)) * MIN - 30000) {
      const open = await db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND conv=? AND status IN ('pending','running') LIMIT 1").bind(userId, r.conv).first();
      if (!open) due.push(ev);
    }
    if (!due.length) continue;
    due.forEach(t => (fired[t] = isEvery(t) ? now() : date));
    const upd = await db.prepare("UPDATE routines SET fired=? WHERE id=? AND IFNULL(fired,'')=IFNULL(?,'')").bind(JSON.stringify(fired), r.id, r.fired).run();
    if (!upd.meta.changes) continue;   // someone else fired it
    const t = isEvery(due[due.length - 1]) ? hm : due[due.length - 1];
    if (pc && !isEvery(due[due.length - 1]) && hm >= '00:10' && t < late) { await addMsg(db, userId, r.conv, 'sys', `${t} 例行任務「${r.name}」：電腦當時沒開，已略過`); n++; continue; }
    all = all || await loadAll(db, userId);
    const g = all.groups.find(x => x.id === r.conv), b = all.bots.find(x => x.id === r.conv);
    if (!g && !b) continue;
    // the bot is waiting for the user to sign in: don't run (and report the same thing) again until they reply
    const lastReal = await db.prepare("SELECT by_, text FROM messages WHERE user_id=? AND conv=? AND by_<>'sys' ORDER BY id DESC LIMIT 1").bind(userId, r.conv).first();
    if (lastReal && lastReal.by_ !== 'me' && /需要使用者在電腦上登入/.test(lastReal.text)) {
      const last = await db.prepare('SELECT by_, text FROM messages WHERE user_id=? AND conv=? ORDER BY id DESC LIMIT 1').bind(userId, r.conv).first();
      if (!(last?.by_ === 'sys' && last.text.startsWith('例行任務先暫停'))) { await addMsg(db, userId, r.conv, 'sys', `例行任務先暫停：「${r.name}」要等你在機器人的瀏覽器登入。登入後按「登入好了，繼續」或傳任何訊息，就會恢復。`); n++; }
      continue;
    }
    if (r.name !== STANDBY) await addMsg(db, userId, r.conv, 'sys', `${t} 例行任務：${r.name}`);
    await addJob(db, userId, r.conv, g ? g.members : [b.id], `（例行任務「${r.name}」）${r.prompt || '請執行你的指定任務，完成後回報結果。'}`);
    if (!byHost) {
      if (hostOnline === null) hostOnline = env.isLocal ? true : (await hostInfo(db, userId)).online;
      if (!hostOnline) {
        await addMsg(db, userId, r.conv, 'sys', '主機電腦目前離線，開機連上後就會執行');
        await sendNotify(env, st, `【OCTA】例行任務「${r.name}」時間到了，但主機電腦離線。電腦開機連上 OCTA 後會自動執行。`);
      }
    }
    n++;
  }
  if (n) await bump(db, userId);
  return n;
}

// ---------- event triggers ----------
// hook: a secret key → POST /api/hook/<key> starts the routine (LINE webhook, Zapier, forms…)
// watch: {url, sel, every} → the host computer checks the page in the bot's browser and starts the routine when it changes
function triggerFrom(body, old) {
  const t = body.trigger;
  if (t === 'hook') return { hook: old?.hook || randTok(), watch: null };
  if (t === 'watch') {
    let url = clean(body.watch?.url, 500);
    if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
    if (!url) throw new Error('要監看的網址要填');
    const every = [5, 10, 15, 30, 60].includes(+body.watch?.every) ? +body.watch.every : 10;
    return { hook: null, watch: JSON.stringify({ url, sel: clean(body.watch?.sel, 200), every }) };
  }
  return { hook: null, watch: null };
}
// a routine started by an event: if an earlier event is still waiting in line, add this one to it
async function fireEvent(env, db, r, what) {
  const pend = await db.prepare("SELECT id,prompt FROM jobs WHERE user_id=? AND conv=? AND status='pending' AND prompt LIKE ? ORDER BY id DESC LIMIT 1").bind(r.user_id, r.conv, `（例行任務「${r.name}」%`).first();
  if (pend) { await db.prepare('UPDATE jobs SET prompt=? WHERE id=?').bind((pend.prompt + '\n\n（又來一個事件）\n' + what).slice(0, 20000), pend.id).run(); await bump(db, r.user_id); return 'merged'; }
  const all = await loadAll(db, r.user_id);
  const g = all.groups.find(x => x.id === r.conv), b = all.bots.find(x => x.id === r.conv);
  if (!g && !b) return 'gone';
  await addMsg(db, r.user_id, r.conv, 'sys', /交接的工作：/.test(what) ? `⚡ ${what.slice(0, 300)}` : `⚡ 事件觸發：${r.name}`);
  await addJob(db, r.user_id, r.conv, g ? g.members : [b.id], `（例行任務「${r.name}」由事件觸發）${r.prompt || '請執行你的指定任務，完成後回報結果。'}\n\n事件內容：\n${what}`.slice(0, 20000));
  await bump(db, r.user_id);
  return 'fired';
}
// LINE webhook body → readable lines
function describeEvent(raw, body) {
  if (body && Array.isArray(body.events)) {
    return body.events.map(e => {
      const who = e.source?.userId ? `（使用者 ${e.source.userId}）` : '';
      if (e.type === 'message') return `LINE ${e.message?.type === 'text' ? '文字訊息' : e.message?.type || '訊息'}${who}：${e.message?.text || ''}`;
      return `LINE 事件 ${e.type}${who}`;
    }).join('\n');
  }
  // another AI (e.g. Grok Bot) handing work over: {"text": "...", "from": "..."}
  const t = body && typeof body === 'object' ? body.text || body.task || body.message || body.content : null;
  if (typeof t === 'string' && t.trim()) return `${body.from ? `「${String(body.from).slice(0, 40)}」` : '外部'}交接的工作：${t.slice(0, 4000)}`;
  return raw.slice(0, 4000);
}

// ---------- rate limiting (sign-in, password reset) ----------
async function blocked(db, keys) {
  for (const [k, max] of keys) {
    const r = await db.prepare('SELECT fails,until FROM logins WHERE k=?').bind(k).first();
    if (r && r.until > now() && r.fails >= max) return Math.ceil((r.until - now()) / MIN);
  }
  return 0;
}
async function failed(db, keys) {
  for (const [k] of keys)
    await db.prepare(`INSERT INTO logins (k,fails,until) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET
      fails=CASE WHEN until<? THEN 1 ELSE fails+1 END, until=CASE WHEN until<? THEN excluded.until ELSE until END`).bind(k, now() + 15 * MIN, now(), now()).run();
}
const cleared = (db, keys) => db.batch(keys.map(([k]) => db.prepare('DELETE FROM logins WHERE k=?').bind(k)));

// ---------- files ----------
async function storeChunks(db, fileId, data) {
  const st = [];
  for (let i = 0, n = 0; i < data.length; i += CHUNK, n++) st.push(db.prepare('INSERT OR REPLACE INTO chunks (file_id,n,data,ts) VALUES (?,?,?,?)').bind(fileId, n, data.slice(i, i + CHUNK), now()));
  for (let i = 0; i < st.length; i += 20) await db.batch(st.slice(i, i + 20));
}
async function readChunks(db, fileId) {
  return (await db.prepare('SELECT data FROM chunks WHERE file_id=? ORDER BY n').bind(fileId).all()).results.map(r => r.data).join('');
}
// periodic clean-up, run from /api/cron about once an hour
async function cleanup(db) {
  const t = now();
  await db.batch([
    db.prepare("DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE loc='pc') AND ts<?").bind(t - 3600000),   // temporary viewing copies
    db.prepare("UPDATE files SET want=NULL WHERE loc='pc' AND want IS NOT NULL AND id NOT IN (SELECT file_id FROM chunks)"),
    db.prepare("DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE loc='cloud' AND conv IS NULL AND ts<?)").bind(t - 2 * DAY),
    db.prepare("DELETE FROM files WHERE loc='cloud' AND conv IS NULL AND ts<?").bind(t - 2 * DAY),
    db.prepare("DELETE FROM jobs WHERE status IN ('done','error') AND created<?").bind(t - 30 * DAY),
    db.prepare("DELETE FROM sessions WHERE kind='web' AND IFNULL(seen,created)<?").bind(t - SESSION_IDLE),
    db.prepare('DELETE FROM logins WHERE until<?').bind(t - DAY)
  ]);
}

// Templates offered in the app, per interface language (generated from i18n/templates.py)
const TEMPLATES_I18N = {
 "zh-TW": {
  "assistant": {
   "folder": null,
   "bots": [
    [
     "a",
     "助理",
     "回答我的問題。需要時用瀏覽器查資料，或操作我已登入的網站。做完用幾句話回報重點。"
    ]
   ],
   "groups": []
  },
  "research": {
   "folder": "研究",
   "bots": [
    [
     "r1",
     "查資料員",
     "依我的問題上網找資料，至少比對兩個來源，附上網址。"
    ],
    [
     "r2",
     "整理員",
     "把查資料員找到的內容整理成重點摘要或表格，標出不確定的地方。"
    ]
   ],
   "groups": [
    [
     "研究小組",
     "查資料員先找資料，整理員再整理成摘要。",
     [
      "r1",
      "r2"
     ]
    ]
   ]
  },
  "shop": {
   "folder": "門市",
   "bots": [
    [
     "s1",
     "訂單員",
     "打開分區資料裡寫的訂單後台，整理今天的新訂單：品項、數量、客人、取貨或出貨時間。"
    ],
    [
     "s2",
     "客服員",
     "依訂單員的資料，擬好要回覆客人的訊息，列出來給我確認。我說「發送」前不要發出。"
    ],
    [
     "s3",
     "回報員",
     "把今天的訂單和待處理事項整理成一則簡短日報。"
    ]
   ],
   "groups": [
    [
     "每日門市流程",
     "訂單員整理訂單 → 客服員擬回覆 → 回報員寫日報。",
     [
      "s1",
      "s2",
      "s3"
     ]
    ]
   ]
  },
  "lodging": {
   "folder": "民宿",
   "bots": [
    [
     "l1",
     "訂房員",
     "打開分區資料裡寫的訂房平台後台，整理今天與明天的入住、退房：房號、客人、晚數。"
    ],
    [
     "l2",
     "房務員",
     "依訂房員的資料，算出今天要打掃的房間，列成清單；分區資料有房務看板網址時就更新上去。"
    ],
    [
     "l3",
     "迎賓員",
     "依今天入住名單，用分區資料裡的入住說明擬好每位客人的訊息，列出來給我確認。我說「發送」前不要發出。"
    ]
   ],
   "groups": [
    [
     "每日入住流程",
     "訂房員整理訂房 → 房務員排打掃 → 迎賓員擬入住訊息給我確認。",
     [
      "l1",
      "l2",
      "l3"
     ]
    ]
   ]
  }
 },
 "en": {
  "assistant": {
   "folder": null,
   "bots": [
    [
     "a",
     "Assistant",
     "Answer my questions. Use the browser to look things up or work on sites I am signed into when needed. Report the key points in a few sentences when done."
    ]
   ],
   "groups": []
  },
  "research": {
   "folder": "Research",
   "bots": [
    [
     "r1",
     "Researcher",
     "Search the web for my question, compare at least two sources, and include links."
    ],
    [
     "r2",
     "Summarizer",
     "Turn what the Researcher found into a short summary or table and flag anything uncertain."
    ]
   ],
   "groups": [
    [
     "Research team",
     "The Researcher finds sources first, then the Summarizer writes the summary.",
     [
      "r1",
      "r2"
     ]
    ]
   ]
  },
  "shop": {
   "folder": "Shop",
   "bots": [
    [
     "s1",
     "Order clerk",
     "Open the order dashboard listed in the folder notes and list today’s new orders: items, quantities, customers, pickup or shipping times."
    ],
    [
     "s2",
     "Support",
     "Using the Order clerk’s list, draft replies to customers and show them to me for approval. Do not send anything until I say “send”."
    ],
    [
     "s3",
     "Reporter",
     "Write a short daily report of today’s orders and open items."
    ]
   ],
   "groups": [
    [
     "Daily shop routine",
     "Order clerk lists orders → Support drafts replies → Reporter writes the daily report.",
     [
      "s1",
      "s2",
      "s3"
     ]
    ]
   ]
  },
  "lodging": {
   "folder": "Guesthouse",
   "bots": [
    [
     "l1",
     "Bookings",
     "Open the booking platform dashboard listed in the folder notes and list today’s and tomorrow’s check-ins and check-outs: room, guest, nights."
    ],
    [
     "l2",
     "Housekeeping",
     "From the Bookings list, work out which rooms need cleaning today; update the housekeeping board if the folder notes list one."
    ],
    [
     "l3",
     "Welcome",
     "For today’s arrivals, draft each guest’s message using the check-in instructions in the folder notes and show them to me for approval. Do not send anything until I say “send”."
    ]
   ],
   "groups": [
    [
     "Daily check-in routine",
     "Bookings lists arrivals → Housekeeping plans cleaning → Welcome drafts check-in messages for my approval.",
     [
      "l1",
      "l2",
      "l3"
     ]
    ]
   ]
  }
 },
 "ja": {
  "assistant": {
   "folder": null,
   "bots": [
    [
     "a",
     "アシスタント",
     "私の質問に答えてください。必要に応じてブラウザで調べたり、ログイン済みのサイトを操作したりして、終わったら要点を数文で報告してください。"
    ]
   ],
   "groups": []
  },
  "research": {
   "folder": "リサーチ",
   "bots": [
    [
     "r1",
     "調査係",
     "質問についてウェブで調べ、2 つ以上の情報源を比較し、URL を添えてください。"
    ],
    [
     "r2",
     "まとめ係",
     "調査係が見つけた内容を要点や表にまとめ、不確かな点を明記してください。"
    ]
   ],
   "groups": [
    [
     "リサーチチーム",
     "調査係が先に調べ、まとめ係が要約します。",
     [
      "r1",
      "r2"
     ]
    ]
   ]
  },
  "shop": {
   "folder": "店舗",
   "bots": [
    [
     "s1",
     "注文係",
     "フォルダのメモに書かれた注文管理画面を開き、今日の新規注文（品目・数量・お客様・受け取りや発送の時間）をまとめてください。"
    ],
    [
     "s2",
     "カスタマー係",
     "注文係の情報をもとにお客様への返信を下書きし、確認のため私に見せてください。「送信」と言うまで送らないでください。"
    ],
    [
     "s3",
     "レポート係",
     "今日の注文と未対応の事項を短い日報にまとめてください。"
    ]
   ],
   "groups": [
    [
     "毎日の店舗業務",
     "注文係が注文を整理 → カスタマー係が返信を下書き → レポート係が日報を作成。",
     [
      "s1",
      "s2",
      "s3"
     ]
    ]
   ]
  },
  "lodging": {
   "folder": "民宿",
   "bots": [
    [
     "l1",
     "予約係",
     "フォルダのメモに書かれた予約サイトの管理画面を開き、今日と明日のチェックイン・チェックアウト（部屋番号・お客様・泊数）をまとめてください。"
    ],
    [
     "l2",
     "清掃係",
     "予約係の情報から今日清掃する部屋をリストにし、フォルダのメモに清掃ボードの URL があれば更新してください。"
    ],
    [
     "l3",
     "お迎え係",
     "今日到着するお客様ごとに、フォルダのメモのチェックイン案内を使ってメッセージを下書きし、確認のため私に見せてください。「送信」と言うまで送らないでください。"
    ]
   ],
   "groups": [
    [
     "毎日のチェックイン業務",
     "予約係が予約を整理 → 清掃係が清掃を計画 → お迎え係がチェックイン案内を下書きして私に確認。",
     [
      "l1",
      "l2",
      "l3"
     ]
    ]
   ]
  }
 },
 "zh-CN": {
  "assistant": {
   "folder": null,
   "bots": [
    [
     "a",
     "助理",
     "回答我的问题。需要时用浏览器查数据，或操作我已登录的网站。做完用几句话回报重点。"
    ]
   ],
   "groups": []
  },
  "research": {
   "folder": "研究",
   "bots": [
    [
     "r1",
     "查数据员",
     "依我的问题上网找数据，至少比对两个来源，附上网址。"
    ],
    [
     "r2",
     "整理员",
     "把查数据员找到的内容整理成重点摘要或表格，标出不确定的地方。"
    ]
   ],
   "groups": [
    [
     "研究小组",
     "查数据员先找数据，整理员再整理成摘要。",
     [
      "r1",
      "r2"
     ]
    ]
   ]
  },
  "shop": {
   "folder": "门市",
   "bots": [
    [
     "s1",
     "订单员",
     "打开分区数据里写的订单后台，整理今天的新订单：品项、数量、客人、取货或出货时间。"
    ],
    [
     "s2",
     "客服员",
     "依订单员的数据，拟好要回复客人的消息，列出来给我确认。我说「发送」前不要发出。"
    ],
    [
     "s3",
     "回报员",
     "把今天的订单和待处理事项整理成一则简短日报。"
    ]
   ],
   "groups": [
    [
     "每日门市流程",
     "订单员整理订单 → 客服员拟回复 → 回报员写日报。",
     [
      "s1",
      "s2",
      "s3"
     ]
    ]
   ]
  },
  "lodging": {
   "folder": "民宿",
   "bots": [
    [
     "l1",
     "订房员",
     "打开分区数据里写的订房平台后台，整理今天与明天的入住、退房：房号、客人、晚数。"
    ],
    [
     "l2",
     "房务员",
     "依订房员的数据，算出今天要打扫的房间，列成清单；分区数据有房务看板网址时就更新上去。"
    ],
    [
     "l3",
     "迎宾员",
     "依今天入住名单，用分区数据里的入住说明拟好每位客人的消息，列出来给我确认。我说「发送」前不要发出。"
    ]
   ],
   "groups": [
    [
     "每日入住流程",
     "订房员整理订房 → 房务员排打扫 → 迎宾员拟入住消息给我确认。",
     [
      "l1",
      "l2",
      "l3"
     ]
    ]
   ]
  }
 }
};

export async function onRequest(ctx) {
  const { request: req, env, params } = ctx;
  const path = (params.path || []).join('/');
  if (!ctx.env.isLocal) await ensureSchema(ctx.env.DB);
  const res = await route(ctx);
  if (req.method !== 'GET' && res.status < 300 && res._u && !NO_BUMP.test(path)) { try { await bump(env.DB, res._u); } catch { } }
  return res;
}

async function route({ request: req, env, params }) {
  const db = env.DB;
  const path = (params.path || []).join('/');
  const m = req.method;
  const url = new URL(req.url);
  let body = {}, rawBody = '';
  if (m !== 'GET') { rawBody = await req.text().catch(() => ''); try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; } }

  try {
    // ---------- public ----------
    const meta = reqMeta(req);
    if (path === 'signup' && m === 'POST') {
      if (env.ALLOW_SIGNUP !== 'true') return err('目前不開放註冊', 403);
      const name = clean(body.name, 32), pw = String(body.pw || '');
      if (!/^[\w.\-一-鿿]{2,32}$/.test(name)) return err('帳號需 2–32 字，只能用中英文、數字、底線、點、減號');
      if (pw.length < 8) return err('密碼至少 8 碼');
      const lim = [['ipsign:' + meta.ip, 10]];
      const wait = await blocked(db, lim);
      if (wait) return err(`嘗試太多次，請 ${wait} 分鐘後再試`, 429);
      if (await db.prepare('SELECT 1 FROM users WHERE name=?').bind(name).first()) return err('這個帳號已被使用');
      await failed(db, lim);   // counts sign-ups per IP
      const id = uid();
      await db.prepare('INSERT INTO users (id,name,pw,created) VALUES (?,?,?,?)').bind(id, name, await hashPw(pw), now()).run();
      return J({ token: await newSession(db, id, 'web', null, meta) });
    }
    if (path === 'login' && m === 'POST') {
      const name = clean(body.name, 32);
      const lim = [['n:' + name.toLowerCase(), 5], ['ip:' + meta.ip, 30]];
      const wait = await blocked(db, lim);
      if (wait) return err(`密碼錯太多次，請 ${wait} 分鐘後再試，或用「忘記密碼」`, 429);
      const u = await db.prepare('SELECT id,pw FROM users WHERE name=?').bind(name).first();
      if (!u || !(await checkPw(String(body.pw || ''), u.pw))) { await failed(db, lim); return err('帳號或密碼錯誤', 401); }
      await cleared(db, lim.slice(0, 1));
      return J({ token: await newSession(db, u.id, 'web', null, meta) });
    }
    if (path === 'reset/send' && m === 'POST') {   // send a reset code to the account's Telegram / LINE
      const name = clean(body.name, 32), lim = [['rs:' + name.toLowerCase(), 3], ['ip:' + meta.ip, 30]];
      const wait = await blocked(db, lim);
      if (wait) return err(`請 ${wait} 分鐘後再試`, 429);
      await failed(db, lim);
      const u = await db.prepare('SELECT id FROM users WHERE name=?').bind(name).first();
      if (u) {
        const st = await getSettings(db, u.id);
        if ((st.tg?.token && st.tg?.chat) || (st.line?.token && st.line?.to)) {
          const code = await newResetCode(db, u.id);
          await sendNotify(env, st, `【OCTA】密碼重設碼：${code}\n15 分鐘內有效。不是你本人操作的話，請忽略這則訊息。`);
        }
      }
      return J({ ok: true });   // same answer either way, so account names can't be probed
    }
    if (path === 'reset' && m === 'POST') {
      const name = clean(body.name, 32), pw = String(body.pw || ''), code = clean(body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (pw.length < 8) return err('新密碼至少 8 碼');
      const lim = [['rc:' + name.toLowerCase(), 5], ['ip:' + meta.ip, 30]];
      const wait = await blocked(db, lim);
      if (wait) return err(`嘗試太多次，請 ${wait} 分鐘後再試`, 429);
      const u = await db.prepare('SELECT id,reset FROM users WHERE name=?').bind(name).first();
      const r = u?.reset ? JSON.parse(u.reset) : null;
      if (!r || r.exp < now() || r.h !== await sha(code)) { await failed(db, lim); return err('重設碼錯誤或已過期', 401); }
      await db.batch([
        db.prepare('UPDATE users SET pw=?, reset=NULL WHERE id=?').bind(await hashPw(pw), u.id),
        db.prepare("DELETE FROM sessions WHERE user_id=? AND kind='web'").bind(u.id)
      ]);
      await cleared(db, [lim[0], ['n:' + name.toLowerCase()]]);   // a successful reset also unlocks sign-in
      return J({ token: await newSession(db, u.id, 'web', null, meta) });
    }
    if (path === 'config' && m === 'GET') return J({ signup: env.ALLOW_SIGNUP === 'true', local: !!env.isLocal, pair: !!env.pairCheck, download: env.DOWNLOAD_URL || '', repo: env.REPO_URL || '' });
    if (path === 'pair' && m === 'POST') {   // desktop offline mode: phone pairs with a code instead of an account
      if (!env.pairCheck) return err('這個版本不使用配對碼', 404);
      if (!env.pairCheck(String(body.code || ''))) return err('配對碼錯誤或已失效', 401);
      return J({ token: await newSession(db, 'local', 'web', 'phone', meta) });
    }
    if (path.startsWith('hook/')) {   // external event: LINE webhook, Zapier, a form…
      const key = path.slice(5);
      if (!/^[0-9a-f]{48}$/.test(key)) return err('找不到', 404);
      const r = await db.prepare('SELECT * FROM routines WHERE hook=?').bind(key).first();
      if (!r) return err('找不到', 404);
      if (m === 'GET') return J({ ok: true, routine: r.name });   // lets services check the address
      if (!r.enabled) return J({ ok: true, skipped: 'disabled' });
      const raw = rawBody || '';
      const what = describeEvent(raw, body);
      if (Array.isArray(body.events) && !body.events.length) return J({ ok: true });   // LINE "Verify" sends no events
      const lim = [['hook:' + key, 120]];
      if (await blocked(db, lim)) return J({ ok: false, error: 'too many events' }, 429);
      await failed(db, lim);   // counts events per 15 minutes
      return J({ ok: true, result: await fireEvent(env, db, r, what || '（沒有內容）') });
    }
    if (path === 'cron') {   // called every few minutes (GitHub Actions); fires routines on time and tidies up
      const users = (await db.prepare('SELECT DISTINCT user_id FROM routines WHERE enabled=1').all()).results;
      let fired = 0;
      for (const u of users) { try { fired += await fireRoutines(env, db, u.user_id, false); } catch { } }
      if (new Date().getUTCMinutes() < 5 || url.searchParams.has('clean')) await cleanup(db);
      return J({ ok: true, fired });
    }

    const me = env.isLocal ? { user_id: 'local', kind: 'local', name: '本機', label: 'local' } : await auth(req, db);
    if (!me) return err('請先登入', 401);
    const U = me.user_id;
    const ok = (data = { ok: true }) => { const r = J(data); r._u = U; return r; };   // a change other devices should see

    // ---------- files ----------
    if (path.startsWith('file/') && m === 'GET') {
      const id = path.slice(5);
      let f = await db.prepare('SELECT id,name,mime,data,loc,want,path,size,pc FROM files WHERE id=? AND user_id=?').bind(id, U).first();
      if (!f) return err('找不到檔案', 404);
      // where the file is: the desktop app on the host computer reads it from its own disk instead of through the cloud
      if (url.searchParams.has('meta')) return J({ name: f.name, mime: f.mime, loc: f.loc || (f.data ? 'db' : 'cloud'), path: f.loc === 'pc' ? f.path : null, size: f.size || null });
      if (f.data) return J({ name: f.name, mime: f.mime, data: f.data });   // older files kept in the database
      if (f.loc === 'pc' && f.want !== -1) {
        // the file is on the computer that made it (host or not): ask it for a temporary copy and wait
        const pcOf = f.pc || null;
        if (!f.want || now() - f.want > MIN) { await db.prepare('UPDATE files SET want=? WHERE id=?').bind(now(), id).run(); await bump(db, U); }
        const t0 = now();
        while (now() - t0 < 20000) {
          await sleep(1000);
          f = await db.prepare('SELECT want FROM files WHERE id=?').bind(id).first();
          if (f?.want === -1) break;
        }
        if (f?.want !== -1) {
          if (env.isLocal) return err('電腦還在讀取檔案，請稍後再試', 503);
          const h = await hostInfo(db, U), owner = pcOf, on = owner ? h.runners.find(r => (r.label || 'runner') === owner) : null;
          const who = (owner || h.hostLabel || '').replace(/^desktop:/, '');
          if (owner && owner !== h.hostLabel) return err(on && now() - (on.seen || 0) < HOST_ONLINE_MS ? `檔案在「${who}」電腦上，還在讀取，請稍後再試` : `這個檔案存在「${who}」電腦上，那台電腦目前離線。打開那台電腦的 OCTA 就能讀取`, 503);
          return err(h.online ? '電腦還在讀取檔案，請稍後再試' : '這個檔案存在主機電腦上，電腦目前離線', 503);
        }
        f = await db.prepare('SELECT name,mime FROM files WHERE id=?').bind(id).first();
      }
      return J({ name: f.name, mime: f.mime, data: await readChunks(db, id) });
    }
    if (path === 'files' && m === 'POST') {   // upload: kept in the cloud only until the host computer saves it
      const data = String(body.data || ''), name = clean(body.name, 120).replace(/[\\/:*?"<>|]/g, '_') || '檔案';
      if (!data) return err('檔案是空的');
      if (data.length > MAX_FILE * 1.37) return err('檔案太大（上限 10MB）');
      const conv = clean(body.conv, 64) || null;
      const id = 'file-' + uid();
      await storeChunks(db, id, data);
      await db.prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,size) VALUES (?,?,?,?,'',?,?,'cloud',?)").bind(id, U, name, mimeOf(name, body.mime), now(), conv, Math.round(data.length * 0.75)).run();
      return ok({ id, name, mime: mimeOf(name, body.mime) });
    }

    // ---------- runner (the computer that runs bots) ----------
    if (path.startsWith('runner/')) {
      if (me.kind !== 'runner' && me.kind !== 'local') return err('需要執行器金鑰', 403);
      const label = me.label || 'runner';
      // heartbeat and computer info, written only every few minutes or when something changed
      if (me.kind === 'runner' && (path === 'runner/next' || path === 'runner/hello')) {
        const info = { engines: body.engines && typeof body.engines === 'object' ? Object.fromEntries(ENGINES.map(k => [k, !!body.engines[k]])) : undefined, version: clean(body.version, 20) || undefined, app: clean(body.app, 20) || undefined, store: clean(body.store, 300) || undefined, usage: body.usage && typeof body.usage === 'object' && JSON.stringify(body.usage).length < 3000 ? body.usage : undefined,
          models: body.models && typeof body.models === 'object' && JSON.stringify(body.models).length < 6000 ? body.models : undefined };
        const old = me.info ? JSON.parse(me.info) : {};
        const merged = { ...old, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) };
        if (now() - (me.seen || 0) > 4 * MIN || JSON.stringify(merged) !== JSON.stringify(old))
          await db.prepare('UPDATE sessions SET seen=?, info=? WHERE token=?').bind(now(), JSON.stringify(merged), me.token).run();
        if (info.engines && JSON.stringify(info.engines) !== JSON.stringify(old.engines || null)) await bump(db, U);   // an AI got installed or removed: open pages update
      }
      if (me.kind === 'local' && body.engines && typeof body.engines === 'object')
        await db.prepare('UPDATE users SET engines=? WHERE id=?').bind(JSON.stringify(Object.fromEntries(ENGINES.map(k => [k, !!body.engines[k]]))), U).run();
      if (me.kind === 'local' && ((body.usage && typeof body.usage === 'object') || (body.models && typeof body.models === 'object'))) { const st = await getSettings(db, U); if (body.usage) st._usage = body.usage; if (body.models) st._models = body.models; await putSettings(db, U, st); }
      if (path === 'runner/hello') return J({ user: U, name: me.name, label });
      if (path === 'runner/bye' && m === 'POST') { if (me.kind === 'runner') await db.prepare('UPDATE sessions SET seen=0 WHERE token=?').bind(me.token).run(); return J({ ok: true }); }

      // only the host computer works; others wait on standby
      let isHost = me.kind === 'local';
      if (!isHost) {
        const u = await db.prepare('SELECT host FROM users WHERE id=?').bind(U).first();
        const hostExists = u?.host && await db.prepare("SELECT 1 FROM sessions WHERE user_id=? AND kind='runner' AND IFNULL(label,'runner')=?").bind(U, u.host).first();
        if (!hostExists) { await db.prepare('UPDATE users SET host=? WHERE id=?').bind(label, U).run(); await bump(db, U); isHost = true; }   // first computer becomes the host
        else isHost = u.host === label;
      }
      // a computer on standby still sends files that live on it, and does jobs addressed to it (handing logins over)
      if (!isHost && path === 'runner/next' && m === 'POST') {
        const t0 = now(); let rev = null;
        for (; ;) {
          const u2 = await db.prepare('SELECT rev, host FROM users WHERE id=?').bind(U).first(), r = u2?.rev ?? 0;
          if (u2?.host === label) return J({ job: null });   // this computer just became the host: ask again as the host
          if (r !== rev) { rev = r; const w = await pcWork(env, db, U, label, body.slots === undefined ? 1 : +body.slots); if (w) return J({ ...w, standby: true }); }
          if (!body.wait || now() - t0 > WAIT_MS) return J({ job: null, standby: true });
          await sleep(1000);
        }
      }
      if (!isHost && !['runner/done', 'runner/blob', 'runner/xfer', 'runner/progress'].includes(path)) {
        if (body.wait) await sleep(WAIT_MS);
        return J({ job: null, standby: true });
      }

      if (path === 'runner/next' && m === 'POST') {
        let changed = await fireRoutines(env, db, U, true);
        // stale running jobs become errors
        const stale = (await db.prepare("SELECT id,conv,bot_id FROM jobs WHERE user_id=? AND status='running' AND ((kind='chat' AND started<?) OR started<?)").bind(U, now() - 20 * MIN, now() - 3 * 3600000).all()).results;
        for (const s of stale) {
          await db.prepare("UPDATE jobs SET status='error' WHERE id=?").bind(s.id).run();
          await addMsg(db, U, s.conv, s.bot_id, '⚠ 執行逾時，已中止。');
          changed++;
        }
        if (changed) await bump(db, U);
        const slots = body.slots === undefined ? 1 : +body.slots;
        const t0 = now();
        let rev = null;
        for (; ;) {
          const u2 = await db.prepare('SELECT rev, host FROM users WHERE id=?').bind(U).first(), r = u2?.rev ?? 0;
          if (r !== rev) {   // something changed since the last look
            rev = r;
            if (me.kind === 'runner' && u2.host !== label) return J({ job: null, standby: true });   // another computer just became the host
            const out = await nextWork(env, db, U, slots, me.kind === 'runner' ? label : null);
            if (out) return J(out);
          }
          if (!body.wait || now() - t0 > WAIT_MS) return J({ job: null });
          await sleep(1000);
        }
      }
      if (path === 'runner/watches' && m === 'POST') {   // pages the host should check for changes
        const rows = (await db.prepare("SELECT r.id,r.conv,r.watch,g.members FROM routines r LEFT JOIN groups_ g ON g.id=r.conv WHERE r.user_id=? AND r.enabled=1 AND r.watch IS NOT NULL").bind(U).all()).results;
        return J({ watches: rows.map(r => { const w = JSON.parse(r.watch); return { id: r.id, bot: r.members ? JSON.parse(r.members)[0] : r.conv, ...w }; }) });
      }
      if (path === 'runner/watched' && m === 'POST') {   // a checked page: start the routine when it changed
        const r = await db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').bind(clean(body.id, 64), U).first();
        if (!r || !r.watch) return J({ ok: true });
        const text = clean(body.text, 8000), hash = clean(body.hash, 80);
        const old = r.wstate ? JSON.parse(r.wstate) : null;
        await db.prepare('UPDATE routines SET wstate=? WHERE id=?').bind(JSON.stringify({ hash, text, t: now() }), r.id).run();
        if (!old || old.hash === hash || !hash) return J({ ok: true, changed: false });   // first look only remembers the page
        const before = new Set(String(old.text || '').split('\n').map(x => x.trim()).filter(Boolean));
        const added = text.split('\n').map(x => x.trim()).filter(x => x && !before.has(x)).slice(0, 40).join('\n');
        const w = JSON.parse(r.watch);
        const res = await fireEvent(env, db, r, `監看的網頁有變化：${w.url}\n新出現的內容：\n${added || '（版面有變動，請打開網頁確認）'}`);
        return J({ ok: true, changed: true, result: res });
      }
      if (path === 'runner/progress' && m === 'POST') {   // what the bot is doing now; also tells the computer if 停止 was pressed
        const r = await db.prepare("UPDATE jobs SET progress=? WHERE id=? AND user_id=? AND status='running'").bind(clean(body.text, 120), +body.id, U).run();
        if (!r.meta.changes) return J({ stop: true });
        await bump(db, U);
        return J({ ok: true });
      }
      if (path === 'runner/stored' && m === 'POST') {   // the host saved an uploaded file into its OCTA folder
        const p = safePath(body.path);
        if (!p) return err('路徑不正確');
        await db.batch([
          db.prepare("UPDATE files SET loc='pc', path=?, size=COALESCE(?,size), want=NULL, pc=? WHERE id=? AND user_id=?").bind(p, +body.size || null, me.kind === 'runner' ? label : null, clean(body.id, 64), U),
          db.prepare('DELETE FROM chunks WHERE file_id=?').bind(clean(body.id, 64))
        ]);
        return J({ ok: true });
      }
      if (path === 'runner/xfer' && m === 'POST') {   // the old computer's logins, kept here only until the host takes them
        const job = await db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND kind='export' AND status='running'").bind(+body.id, U).first();
        if (!job) return err('找不到任務', 404);
        const n = Math.max(0, Math.floor(+body.n || 0)), data = String(body.data || '');
        if (data.length > CHUNK + 10 || n > 20) return err('資料太大');
        await db.prepare('INSERT OR REPLACE INTO chunks (file_id,n,data,ts) VALUES (?,?,?,?)').bind('xfer-' + job.id, n, data, now()).run();
        if (body.last) {
          await db.prepare("UPDATE jobs SET status='done', finished=? WHERE id=?").bind(now(), job.id).run();
          await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url,pc) VALUES (?,?,?,'[]','',?,'import',?,?)").bind(U, job.conv, job.bot_id, now(), 'xfer-' + job.id, job.url).run();
          await bump(db, U);
        }
        return J({ ok: true });
      }
      if (path.startsWith('runner/xfer/') && m === 'GET') {
        const id = path.slice('runner/xfer/'.length);
        const job = await db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND kind='import' AND url=? AND status='running'").bind(U, id).first();
        if (!job) return err('找不到資料', 404);
        return J({ data: await readChunks(db, id) });
      }
      if (path === 'runner/blob' && m === 'POST') {   // temporary copy of a file someone wants to see
        const id = clean(body.id, 64);
        const f = await db.prepare('SELECT 1 FROM files WHERE id=? AND user_id=?').bind(id, U).first();
        if (!f) return err('找不到檔案', 404);
        if (body.missing) { await db.prepare('UPDATE files SET want=NULL WHERE id=?').bind(id).run(); return J({ ok: true }); }
        const n = Math.max(0, Math.floor(+body.n || 0)), data = String(body.data || '');
        if (data.length > CHUNK + 10) return err('片段太大');
        await db.prepare('INSERT OR REPLACE INTO chunks (file_id,n,data,ts) VALUES (?,?,?,?)').bind(id, n, data, now()).run();
        if (body.last) await db.prepare('UPDATE files SET want=-1 WHERE id=?').bind(id).run();
        return J({ ok: true });
      }
      if (path === 'runner/done' && m === 'POST') {
        const job = await db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND status='running'").bind(+body.id, U).first();
        if (!job) return err('找不到執行中的任務', 404);
        const good = body.ok !== false;
        if (job.kind === 'export' || job.kind === 'import') {   // handing a bot's website logins to another computer
          await db.prepare('UPDATE jobs SET status=?, finished=?, result=? WHERE id=?').bind(good ? 'done' : 'error', now(), clean(body.text, 3000), job.id).run();
          if (job.kind === 'import' || !good) {
            await db.prepare('DELETE FROM chunks WHERE file_id=?').bind(job.kind === 'import' ? job.url : 'xfer-' + job.id).run();
            if (good) await db.prepare('UPDATE bots SET bpc=? WHERE id=? AND user_id=?').bind(job.pc || null, job.bot_id, U).run();
            await addMsg(db, U, job.conv, 'sys', clean(body.text, 500) || (good ? '已帶入網站登入' : '⚠ 帶入網站登入失敗'));
            await bump(db, U);
          }
          return ok();
        }
        if (job.kind === 'test' || job.kind === 'list' || job.kind === 'install') {
          await db.prepare('UPDATE jobs SET status=?, finished=?, result=? WHERE id=?').bind(good ? 'done' : 'error', now(), clean(body.text, 3000), job.id).run();
          return ok();
        }
        let text = clean(body.text, 20000) || (good ? '（完成，無回覆內容）' : '⚠ 執行失敗');
        // 📝任務更新：… 📝結束 — the bot learned what its standing job is; save it as its 指定任務
        let learned = null;
        const tm = good && job.kind === 'chat' ? text.match(/📝\s*任務更新[:：]\s*([\s\S]*?)(?:📝\s*結束|$)/) : null;
        if (tm) {
          learned = clean(tm[1], 4000);
          text = clean(text.replace(tm[0], ''), 20000) || '（已更新指定任務）';
        }
        // 📌記住：… — a lasting fact or preference the bot should keep (its memory)
        const remember = [];
        // 🧩技能：名稱 … 🧩結束 — a workflow saved to rerun later (shown in the / menu)
        const skillsNew = [];
        // small local models (Ollama) fire these on everything ("已記住：自我介紹已完成…"): their markers are dropped, not saved
        const small = (await db.prepare('SELECT engine FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first())?.engine === 'opencode';
        if (good && job.kind === 'chat') {
          text = text.replace(/^\s*📌\s*記住[:：]\s*(.+)$/gm, (_, t) => { const v = clean(t, 300); if (v && !small) remember.push(v); return ''; });
          text = text.replace(/🧩\s*技能[:：]\s*([^\n]+)\n([\s\S]*?)🧩\s*結束/g, (_, n, st2) => { const name = clean(n, 40), steps = clean(st2, 3000); if (name && steps && !small) skillsNew.push({ name, steps }); return ''; });
          text = text.trim() || '（已記下）';
        }
        // ⏰例行任務：名稱｜08:00,13:30｜要做的事 — the bot sets up a daily routine the user asked for
        const plans = [];
        if (good && job.kind === 'chat') {
          text = text.replace(/^\s*⏰\s*例行任務[:：]\s*(.+?)\s*[｜|]\s*(.+?)\s*[｜|]\s*(.+)$/gm, (_, n, t, p) => {
            const wm = String(t).match(/監看\s*(https?:\/\/\S+)/), every = (String(t).match(/每\s*(\d+)\s*分/) || [])[1];
            if (wm) { plans.push({ name: clean(n, 40), times: [], prompt: clean(p, 2000), trigger: 'watch', watch: { url: wm[1], every: +every || 10 } }); return ''; }
            if (/外部事件|webhook/i.test(t)) { plans.push({ name: clean(n, 40), times: [], prompt: clean(p, 2000), trigger: 'hook' }); return ''; }
            const times = cleanTimes(String(t).replace(/每\s*(\d+)\s*分(鐘)?/g, '*/$1').replace(/每\s*(\d+)\s*小時/g, (_, h) => '*/' + h * 60).split(/[,，、\s]+/).map(x => { if (/^\*\/\d+$/.test(x)) return x; const mm = x.match(/^(\d{1,2})[:：](\d{2})$/); return mm ? mm[1].padStart(2, '0') + ':' + mm[2] : ''; }));
            if (clean(n, 40) && times.length) plans.push({ name: clean(n, 40), times, prompt: clean(p, 2000) });
            return '';
          }).trim() || '（已設定例行任務）';
        }
        const tk = Number.isFinite(+body.tokens) && body.tokens !== null ? Math.max(0, Math.round(+body.tokens)) : null;
        await db.prepare('UPDATE jobs SET status=?, finished=?, tokens=? WHERE id=?').bind(good ? 'done' : 'error', now(), tk, job.id).run();
        // where its website logins live: the first computer its browser ran on, until they're moved
        if (me.kind === 'runner' && body.browser) await db.prepare('UPDATE bots SET bpc=? WHERE id=? AND user_id=? AND bpc IS NULL').bind(label, job.bot_id, U).run();
        if (body.nskills && typeof body.nskills === 'object' && JSON.stringify(body.nskills).length < 300000) {   // the bot's own Claude Code skills, kept with the account
          const st = await getSettings(db, U); st.nskills = st.nskills || {}; st.nskills[job.bot_id] = { h: clean(body.nskills.h, 64), files: body.nskills.files || {} }; await putSettings(db, U, st);
        }
        // files the bot made in its 輸出 folder become attachments of the reply
        const outs = [];
        for (const f of (Array.isArray(body.files) ? body.files : []).slice(0, 8)) {
          const p = safePath(f.path), name = clean(f.name, 120);
          if (!p || !name) continue;
          const id = 'file-' + uid(), mime = mimeOf(name, f.mime);
          await db.prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,path,size,pc) VALUES (?,?,?,?,'',?,?,'pc',?,?,?)").bind(id, U, name, mime, now(), job.conv, p, +f.size || null, me.kind === 'runner' ? label : null).run();
          outs.push({ id, name, mime });
        }
        const isGroup = (await loadAll(db, U)).groups.some(g => g.id === job.conv);
        const quiet = isGroup || job.prompt.startsWith('（例行任務') || BG.test(job.prompt) || /^同事「[^」]*」回覆了你在背景問/.test(job.prompt);   // where "（略過）" means nothing to show
        if (!(quiet && passed(text) && !outs.length)) await addMsg(db, U, job.conv, job.bot_id, text, outs);
        if (remember.length || skillsNew.length) {
          const st = await getSettings(db, U);
          if (remember.length) { st.memory = st.memory || {}; st.memory[job.bot_id] = [...new Set([...(st.memory[job.bot_id] || []), ...remember])].slice(-40); }
          if (skillsNew.length) { st.skills = st.skills || {}; const cur = (st.skills[job.bot_id] || []).filter(x => !skillsNew.some(n => n.name === x.name)); st.skills[job.bot_id] = [...cur, ...skillsNew].slice(-20); }
          await putSettings(db, U, st);
          if (remember.length) await addMsg(db, U, job.conv, 'sys', `已記住：${remember.join('；').slice(0, 200)}`);
          for (const k of skillsNew) await addMsg(db, U, job.conv, 'sys', `已存成技能「${k.name}」，輸入 / 就能叫它`);
        }
        for (const r of plans.filter(x => x.trigger).slice(0, 3)) {   // event-triggered routines the bot set up
          const old = await db.prepare('SELECT * FROM routines WHERE user_id=? AND conv=? AND name=?').bind(U, job.conv, r.name).first();
          let trig; try { trig = triggerFrom(r, old); } catch { continue; }
          if (old) await db.prepare('UPDATE routines SET prompt=?,enabled=1,hook=?,watch=?,wstate=NULL WHERE id=?').bind(r.prompt, trig.hook, trig.watch, old.id).run();
          else await db.prepare("INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created,hook,watch) VALUES (?,?,?,?,?,'[]',1,'{}',?,?,?)").bind('r-' + uid(), U, job.conv, r.name, r.prompt, now(), trig.hook, trig.watch).run();
          await addMsg(db, U, job.conv, 'sys', r.trigger === 'watch' ? `已設定例行任務「${r.name}」：網頁 ${r.watch.url} 有變化時開始（每 ${r.watch.every || 10} 分鐘檢查）` : `已設定例行任務「${r.name}」：外部事件觸發。觸發網址在任務設定 → 例行任務裡`);
        }
        for (const r of plans.filter(x => !x.trigger).slice(0, 5)) {
          const { date, hm } = localNow(env);
          const fired = JSON.stringify(Object.fromEntries(r.times.filter(t => !isEvery(t) && t <= hm).map(t => [t, date])));   // times already past today start tomorrow
          const old = await db.prepare('SELECT id FROM routines WHERE user_id=? AND conv=? AND name=?').bind(U, job.conv, r.name).first();
          if (old) await db.prepare('UPDATE routines SET times=?,prompt=?,enabled=1,fired=? WHERE id=?').bind(JSON.stringify(r.times), r.prompt, fired, old.id).run();
          else await db.prepare('INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,?,1,?,?)').bind('r-' + uid(), U, job.conv, r.name, r.prompt, JSON.stringify(r.times), fired, now()).run();
          await addMsg(db, U, job.conv, 'sys', `已${old ? '更新' : '新增'}例行任務「${r.name}」：${r.times.map(t => isEvery(t) ? `每 ${t.slice(2)} 分鐘` : '每天 ' + t).join('、')}`);
        }
        if (learned && learned.length >= 4) {
          const cur = await db.prepare('SELECT task FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first();
          if (cur && cur.task !== learned) {
            await db.prepare('UPDATE bots SET task=? WHERE id=? AND user_id=?').bind(learned, job.bot_id, U).run();
            await addMsg(db, U, job.conv, 'sys', `已自動更新「${(await db.prepare('SELECT name FROM bots WHERE id=?').bind(job.bot_id).first())?.name || '機器人'}」的指定任務，可在任務設定修改`);
          }
        }
        if (job.kind === 'chat') {
          const st = await getSettings(db, U);
          const who = (await db.prepare('SELECT name FROM bots WHERE id=?').bind(job.bot_id).first())?.name || '機器人';
          if (!good || needsYou(text)) await sendNotify(env, st, `【OCTA】${who} 需要你處理：\n${text.slice(0, 600)}`);
          else if (st.notifyAll && !JSON.parse(job.chain).length) await sendNotify(env, st, `【OCTA】${who} 完成：\n${text.slice(0, 600)}`);
        }
        if (body.page) await db.prepare('UPDATE bots SET page=? WHERE id=? AND user_id=?').bind(clean(body.page, 500), job.bot_id, U).run();
        if (!good || job.kind !== 'chat') return ok();
        let rest = JSON.parse(job.chain).map(s => (typeof s === 'string' ? { b: s, p: job.prompt } : s));
        // a bot asks a colleague in the same 分區: a line starting with "@名字 問題"
        const { bots, groups } = await loadAll(db, U);
        const self = bots.find(b => b.id === job.bot_id), grp = groups.find(g => g.id === job.conv);
        const asks = [], gives = [];
        // a background message finished: hand the answer back to the bot that sent it
        const bg = job.prompt.match(BG), from = bg && bots.find(b => b.id === bg[1]);
        if (from && self && !passed(text)) {
          await addMsg(db, U, from.id, 'sys', `🔁 「${self.name}」${bg[2] === 'ask' ? '回覆' : '完成交辦'}：${text.slice(0, 800)}`);
          if (bg[2] === 'ask' && job.depth < MAX_ASK_DEPTH) await addJob(db, U, from.id, [from.id], `同事「${self.name}」回覆了你在背景問的問題：\n${text.slice(0, 3000)}\n\n請根據回覆繼續你原本在做的工作（看前面的對話）；已經沒事就只回「（略過）」。`, job.depth + 1);
        }
        if (self && job.depth < MAX_ASK_DEPTH && !passed(text)) {
          for (const line of text.split('\n')) {
            const mm = line.trim().match(/^@(\S+)\s+(.+)$/);
            if (!mm) continue;
            const to = bots.find(b => b.name === mm[1] && b.id !== self.id && (!grp || grp.members.includes(b.id)));
            if (!to || asks.some(a => a.b === to.id) || gives.some(a => a.b === to.id)) continue;
            const hand = mm[2].match(/^交接\s*[:：]?\s*(.+)$/);   // "@名字 交接：…" passes the whole job on; no need to come back
            if (!grp) {   // outside a group: the other bot works on it in the background, in its own chat
              const what = hand ? hand[1] : mm[2];
              await addMsg(db, U, to.id, 'sys', `🔁 「${self.name}」${hand ? '交辦' : '問'}：${what.slice(0, 600)}`);
              await addJob(db, U, to.id, [to.id], hand
                ? `〔背景:${self.id}:give〕同事「${self.name}」交辦給你：${what}\n請照你的職責完成，最後簡短回報結果，回報會自動傳給${self.name}。`
                : `〔背景:${self.id}:ask〕同事「${self.name}」在背景問你：${what}\n請直接回答，回答會自動傳給${self.name}。`, job.depth + 1);
              gives.push({ b: to.id });
              continue;
            }
            if (hand) gives.push({ b: to.id, p: `${self.name} 把工作交接給你：${hand[1]}\n（原本的指示：${job.prompt.slice(0, 1500)}）\n請接手完成並回報。` });
            else asks.push({ b: to.id, p: `${self.name} 問你：${mm[2]}\n請直接回答 ${self.name}。` });
          }
        }
        if (asks.length) rest = [...asks, { b: self.id, p: `同事已在上面回覆你的問題，請根據回覆繼續完成原本的指示：${job.prompt}` }, ...rest];
        for (const g of gives) if (g.p) await addJob(db, U, job.conv, [g], g.p, job.depth + 1);
        if (gives.length || from) await bump(db, U);
        await addJob(db, U, job.conv, rest, job.prompt, job.depth + (asks.length ? 1 : 0));
        return ok();
      }
      if (path === 'runner/shot' && m === 'POST') {   // the screenshot stays on the computer; only where it is goes up
        const job = await db.prepare('SELECT bot_id,conv FROM jobs WHERE id=? AND user_id=?').bind(+body.id, U).first();
        if (!job) return err('找不到任務', 404);
        const p = safePath(body.path), name = clean(body.name, 120) || 'screenshot.jpg';
        if (!p) return err('路徑不正確');
        const old = await db.prepare('SELECT shot_file FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first();
        const id = 'file-' + uid();
        await db.batch([
          db.prepare("INSERT INTO files (id,user_id,name,mime,data,ts,conv,loc,path,size,pc) VALUES (?,?,?,?,'',?,?,'pc',?,?,?)").bind(id, U, name, mimeOf(name, body.mime), now(), job.conv, p, +body.size || null, me.kind === 'runner' ? label : null),
          db.prepare('UPDATE bots SET shot_ts=?, shot_file=?, bpc=IFNULL(bpc,?) WHERE id=? AND user_id=?').bind(now(), id, me.kind === 'runner' ? label : null, job.bot_id, U),
          db.prepare('DELETE FROM files WHERE id=? AND user_id=?').bind(old?.shot_file || '', U),
          db.prepare('DELETE FROM chunks WHERE file_id=?').bind(old?.shot_file || ''),
          db.prepare('DELETE FROM shots WHERE bot_id=? AND user_id=?').bind(job.bot_id, U)
        ]);
        return ok();
      }
      return err('未知的執行器路徑', 404);
    }

    // ---------- web app ----------
    if (path === 'logout' && m === 'POST') {
      if (me.token) await db.prepare('DELETE FROM sessions WHERE token=?').bind(me.token).run();
      return J({ ok: true });
    }
    if (path === 'wait' && m === 'GET') {   // long-poll: returns as soon as anything changes (or after 25 s)
      const have = +url.searchParams.get('rev');
      try { await fireRoutines(env, db, U, false); } catch { }
      const t0 = now();
      for (; ;) {
        const rev = (await db.prepare('SELECT rev FROM users WHERE id=?').bind(U).first())?.rev ?? 0;
        if (rev !== have || now() - t0 > WAIT_MS) return J({ rev });
        await sleep(1000);
      }
    }
    if (path === 'state' && m === 'GET') {
      const all = await loadAll(db, U);
      const convIds = [...all.bots.map(b => b.id), ...all.groups.map(g => g.id)];
      const [ur, busy, rev, ...lasts] = await db.batch([
        // recent bot replies, for unread counts and notifications
        db.prepare("SELECT conv,id FROM messages WHERE user_id=? AND by_ NOT IN ('me','sys') ORDER BY id DESC LIMIT 300").bind(U),
        db.prepare("SELECT conv,bot_id,status,kind,started,progress FROM jobs WHERE user_id=? AND kind<>'test' AND status IN ('pending','running')").bind(U),
        db.prepare('SELECT rev FROM users WHERE id=?').bind(U),
        // newest non-system message of each conversation (list previews); one indexed lookup each
        ...convIds.map(c => db.prepare("SELECT conv,id,by_ AS by,substr(text,1,140) AS text,ts FROM messages WHERE user_id=? AND conv=? AND by_<>'sys' ORDER BY id DESC LIMIT 1").bind(U, c))
      ]);
      const last = { results: lasts.flatMap(r => r.results) };
      const h = env.isLocal ? null : await hostInfo(db, U);
      const st = await getSettings(db, U);
      const { date } = localNow(env), dayStart = Date.parse(date + 'T00:00:00Z') - (+env.TZ_OFFSET_MIN || 0) * 60000;
      const tok = (await db.prepare('SELECT bot_id, SUM(tokens) AS t, COUNT(*) AS n FROM jobs WHERE user_id=? AND created>=? AND kind=\'chat\' GROUP BY bot_id').bind(U, dayStart).all()).results;
      return J({ tokens: Object.fromEntries(tok.map(r => [r.bot_id, { t: r.t, n: r.n }])),
        me: me.name, local: me.kind === 'local', rev: rev.results[0]?.rev ?? 0,
        engines: h ? h.engines : JSON.parse((await db.prepare('SELECT engines FROM users WHERE id=?').bind(U).first())?.engines || 'null'),
        runnerOnline: env.runnerOnline ? env.runnerOnline() : h.online,
        host: h ? h.hostLabel : 'local', computers: h ? h.runners.length : 1, shareBrowser: st.shareBrowser !== false, sched: st.sched === 'pc' ? 'pc' : 'cloud', quick: st.quick || {}, allow: st.allow || {}, pins: st.pins || [], mute: st.mute || {}, memory: st.memory || {}, skills: st.skills || {}, nsk: Object.fromEntries(Object.entries(st.nskills || {}).map(([k, v]) => [k, [...new Set(Object.keys(v.files || {}).map(p => p.split('/')[0]))]])), warm: WARM.includes(+st.warm) ? +st.warm : 120, models: h ? h.models : st._models || null,
        ...all, last: last.results, ur: ur.results.map(r => [r.conv, r.id]), busy: busy.results
      });
    }
    if (path === 'messages' && m === 'GET') {   // one conversation, 50 at a time
      const conv = clean(url.searchParams.get('conv'), 64), before = +url.searchParams.get('before') || 0, after = +url.searchParams.get('after') || 0;
      const lim = Math.min(100, +url.searchParams.get('limit') || 50);
      const rows = (await (after
        ? db.prepare('SELECT id,conv,by_ AS by,text,files,ts FROM messages WHERE user_id=? AND conv=? AND id>? ORDER BY id LIMIT ?').bind(U, conv, after, lim)
        : db.prepare('SELECT * FROM (SELECT id,conv,by_ AS by,text,files,ts FROM messages WHERE user_id=? AND conv=? AND id<? ORDER BY id DESC LIMIT ?) ORDER BY id').bind(U, conv, before || 9e15, lim)
      ).all()).results.map(x => ({ ...x, files: x.files ? JSON.parse(x.files) : [] }));
      return J({ msgs: rows, more: !after && rows.length === lim });
    }
    if (path === 'template' && m === 'POST') {
      const lang = TEMPLATES_I18N[body.lang] ? body.lang : ((await getSettings(db, U)).lang || 'zh-TW');
      const raw = (TEMPLATES_I18N[lang] || TEMPLATES_I18N['zh-TW'])[body.name];
      if (!raw) return err('沒有這個範本');
      const t = { folder: raw.folder, bots: raw.bots.map(([k, name, task]) => ({ k, name, task })), groups: raw.groups.map(([name, task, members]) => ({ name, task, members })) };
      let folder = null;
      if (t.folder) {
        folder = (await db.prepare('SELECT id FROM folders WHERE user_id=? AND name=?').bind(U, t.folder).first())?.id;
        if (!folder) { folder = 'f-' + uid(); await db.prepare('INSERT INTO folders (id,user_id,name,created) VALUES (?,?,?,?)').bind(folder, U, t.folder, now()).run(); }
      }
      const map = {};
      for (const b of t.bots) {
        map[b.k] = uid();
        await db.prepare('INSERT INTO bots (id,user_id,name,task,folder,avatar,created) VALUES (?,?,?,?,?,?,?)').bind(map[b.k], U, b.name, b.task, folder, TEMPLATE_AVATARS[b.k] || null, now()).run();
      }
      for (const g of t.groups)
        await db.prepare('INSERT INTO groups_ (id,user_id,name,task,members,folder,created) VALUES (?,?,?,?,?,?,?)')
          .bind('g-' + uid(), U, g.name, g.task, JSON.stringify(g.members.map(k => map[k])), folder, now() + 1).run();
      return ok();
    }

    // folders (分區)
    if (path === 'folders' && m === 'POST') {
      const name = clean(body.name, 20);
      if (!name) return err('分區名稱要填');
      const id = 'f-' + uid();
      await db.prepare('INSERT INTO folders (id,user_id,name,notes,created) VALUES (?,?,?,?,?)').bind(id, U, name, clean(body.notes, 20000), now()).run();
      return ok({ id });
    }
    if (path.startsWith('folders/')) {
      const id = path.slice(8);
      if (m === 'PUT') {
        const name = clean(body.name, 20);
        if (!name) return err('分區名稱要填');
        await db.prepare('UPDATE folders SET name=?, notes=? WHERE id=? AND user_id=?').bind(name, clean(body.notes, 20000), id, U).run();
        return ok();
      }
      if (m === 'DELETE') {   // items fall back to 未分區
        await db.batch([
          db.prepare('UPDATE bots SET folder=NULL WHERE folder=? AND user_id=?').bind(id, U),
          db.prepare('UPDATE groups_ SET folder=NULL WHERE folder=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM folders WHERE id=? AND user_id=?').bind(id, U)
        ]);
        return ok();
      }
    }
    if (path === 'move' && m === 'POST') {
      const { folders } = await loadAll(db, U);
      const folder = folderOk(folders, body.folder);
      const id = clean(body.id, 64);
      await db.prepare(`UPDATE ${id.startsWith('g-') ? 'groups_' : 'bots'} SET folder=? WHERE id=? AND user_id=?`).bind(folder, id, U).run();
      return ok();
    }

    // bots
    if (path === 'bots' && m === 'POST') {
      const name = clean(body.name, 20), task = clean(body.task, 4000);
      if (!name) return err('名稱要填');   // the task may be empty: the bot learns it from the chat
      const { folders, bots } = await loadAll(db, U);
      if (bots.some(b => b.name === name)) return err('已經有同名的機器人，名字要不同才能用 @ 叫它');
      const id = uid(), engine = engineOk(body.engine);
      await db.prepare('INSERT INTO bots (id,user_id,name,task,folder,engine,model,avatar,browser,created) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id, U, name, task, folderOk(folders, body.folder), engine, modelOk(engine, body.model), avatarOk(body.avatar), body.browser === 'mine' ? 'mine' : null, now()).run();
      await addMsg(db, U, id, 'sys', task ? '機器人已建立' : '機器人已建立：直接傳訊息告訴它要做什麼，它會自己整理成指定任務');
      return ok({ id });
    }
    if (path.startsWith('bots/') && path.endsWith('/bring-logins') && m === 'POST') {   // move a bot's website logins to the host computer
      const id = path.slice(5, -'/bring-logins'.length);
      const b = await db.prepare('SELECT id,bpc FROM bots WHERE id=? AND user_id=?').bind(id, U).first();
      if (!b) return err('找不到機器人', 404);
      const h = await hostInfo(db, U);
      if (!b.bpc) return err('這個機器人還沒在任何電腦上用過自己的瀏覽器');
      if (b.bpc === h.hostLabel) return err('它的網站登入已經在主機電腦上了');
      const old = h.runners.find(r => (r.label || 'runner') === b.bpc), who = b.bpc.replace(/^desktop:/, '');
      if (!old) return err(`找不到「${who}」電腦（可能已移除）`);
      if (now() - (old.seen || 0) >= HOST_ONLINE_MS) return err(`「${who}」電腦目前離線，請先打開那台電腦的 OCTA`, 409);
      if (!h.online) return err('主機電腦離線', 409);
      const r = await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url,pc) VALUES (?,?,?,'[]','',?,'export',?,?)").bind(U, id, id, now(), h.hostLabel, b.bpc).run();
      await addMsg(db, U, id, 'sys', `正在從「${who}」電腦把網站登入帶到主機…`);
      return ok({ id: r.meta.last_row_id });
    }
    if (path.startsWith('bots/')) {
      const id = path.slice(5);
      if (m === 'PUT') {
        const name = clean(body.name, 20), task = clean(body.task, 4000);
        if (!name) return err('名稱要填');   // the task may be empty: the bot learns it from the chat
        const { folders, bots } = await loadAll(db, U);
        if (bots.some(b => b.name === name && b.id !== id)) return err('已經有同名的機器人');
        const engine = engineOk(body.engine);
        await db.prepare('UPDATE bots SET name=?,task=?,folder=?,engine=?,model=?,avatar=?,browser=? WHERE id=? AND user_id=?').bind(name, task, folderOk(folders, body.folder), engine, modelOk(engine, body.model), avatarOk(body.avatar), body.browser === 'mine' ? 'mine' : null, id, U).run();
        return ok();
      }
      if (m === 'DELETE') {   // files stay on the host computer; only the records go
        // take the bot out of its groups; a group left with nobody is removed too
        const { groups } = await loadAll(db, U);
        for (const g of groups.filter(x => x.members.includes(id))) {
          const left = g.members.filter(x => x !== id);
          if (left.length) await db.prepare('UPDATE groups_ SET members=? WHERE id=? AND user_id=?').bind(JSON.stringify(left), g.id, U).run();
          else await db.batch([
            db.prepare('DELETE FROM groups_ WHERE id=? AND user_id=?').bind(g.id, U),
            db.prepare('DELETE FROM routines WHERE conv=? AND user_id=?').bind(g.id, U),
            db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(g.id, U),
            db.prepare("DELETE FROM jobs WHERE conv=? AND user_id=? AND status='pending'").bind(g.id, U)
          ]);
        }
        await db.batch([
          db.prepare('DELETE FROM shots WHERE bot_id=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM routines WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM bots WHERE id=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE conv=? AND user_id=?)').bind(id, U),
          db.prepare('DELETE FROM files WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare("DELETE FROM jobs WHERE bot_id=? AND user_id=? AND status='pending'").bind(id, U)
        ]);
        return ok();
      }
    }

    // groups
    const groupBody = async () => {
      const name = clean(body.name, 20), task = clean(body.task, 4000);
      const { bots, folders } = await loadAll(db, U);
      const members = (Array.isArray(body.members) ? body.members : []).filter(x => bots.some(b => b.id === x));
      if (!name || !members.length) throw new Error('名稱和成員都要填');   // rules are optional: members take turns in order
      return { name, task, members: JSON.stringify(members), folder: folderOk(folders, body.folder) };
    };
    if (path === 'groups' && m === 'POST') {
      let g; try { g = await groupBody(); } catch (e) { return err(e.message); }
      const id = 'g-' + uid();
      await db.prepare('INSERT INTO groups_ (id,user_id,name,task,members,folder,created) VALUES (?,?,?,?,?,?,?)').bind(id, U, g.name, g.task, g.members, g.folder, now()).run();
      await addMsg(db, U, id, 'sys', '群組已建立');
      return ok({ id });
    }
    if (path.startsWith('groups/')) {
      const id = path.slice(7);
      if (m === 'PUT') {
        let g; try { g = await groupBody(); } catch (e) { return err(e.message); }
        await db.prepare('UPDATE groups_ SET name=?,task=?,members=?,folder=? WHERE id=? AND user_id=?').bind(g.name, g.task, g.members, g.folder, id, U).run();
        return ok();
      }
      if (m === 'DELETE') {
        await db.batch([
          db.prepare('DELETE FROM routines WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM groups_ WHERE id=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE conv=? AND user_id=?)').bind(id, U),
          db.prepare('DELETE FROM files WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare("DELETE FROM jobs WHERE conv=? AND user_id=? AND status='pending'").bind(id, U)
        ]);
        return ok();
      }
    }

    // routines (例行任務)
    if (path === 'routines' && m === 'POST') {
      const { bots, groups } = await loadAll(db, U);
      const conv = clean(body.conv, 64), name = clean(body.name, 40), times = cleanTimes(body.times);
      if (!bots.some(b => b.id === conv) && !groups.some(g => g.id === conv)) return err('找不到對話', 404);
      let trig; try { trig = triggerFrom(body); } catch (e) { return err(e.message); }
      if (!name || (!times.length && !trig.hook && !trig.watch)) return err('名稱和時間（或觸發方式）都要填');
      const { date, hm } = localNow(env);   // times already past today start tomorrow
      const fired = Object.fromEntries(times.filter(t => !isEvery(t) && t <= hm).map(t => [t, date]));
      const id = 'r-' + uid();
      await db.prepare('INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created,hook,watch) VALUES (?,?,?,?,?,?,1,?,?,?,?)')
        .bind(id, U, conv, name, clean(body.prompt, 2000), JSON.stringify(times), JSON.stringify(fired), now(), trig.hook, trig.watch).run();
      return ok({ id, hook: trig.hook });
    }
    if (path.startsWith('routines/')) {
      const id = path.slice(9);
      const r = await db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').bind(id, U).first();
      if (!r) return err('找不到例行任務', 404);
      if (m === 'PUT') {
        const name = clean(body.name ?? r.name, 40), times = body.times ? cleanTimes(body.times) : JSON.parse(r.times);
        let trig = { hook: r.hook, watch: r.watch };
        if (body.trigger !== undefined) { try { trig = triggerFrom(body, r); } catch (e) { return err(e.message); } }
        if (!name || (!times.length && !trig.hook && !trig.watch)) return err('名稱和時間（或觸發方式）都要填');
        const enabled = body.enabled === undefined ? r.enabled : body.enabled ? 1 : 0;
        let fired = r.fired;
        if (enabled && !r.enabled || body.times) {   // turning on or changing times: don't fire times already past today
          const { date, hm } = localNow(env);
          fired = JSON.stringify(Object.fromEntries(times.filter(t => !isEvery(t) && t <= hm).map(t => [t, date])));
        }
        await db.prepare('UPDATE routines SET name=?,prompt=?,times=?,enabled=?,fired=?,hook=?,watch=?,wstate=? WHERE id=?')
          .bind(name, body.prompt === undefined ? r.prompt : clean(body.prompt, 2000), JSON.stringify(times), enabled, fired, trig.hook, trig.watch, trig.watch === r.watch ? r.wstate : null, id).run();
        return ok({ hook: trig.hook });
      }
      if (m === 'DELETE') { await db.prepare('DELETE FROM routines WHERE id=?').bind(id).run(); return ok(); }
    }

    if (path === 'messages' && m === 'POST') {
      const conv = clean(body.conv, 64), text = clean(body.text, 4000);
      if (!text && !(body.files || []).length) return err('訊息是空的');
      const { bots, groups } = await loadAll(db, U);
      const bot = bots.find(b => b.id === conv), group = groups.find(g => g.id === conv);
      if (!bot && !group) return err('找不到對話', 404);
      const fileIds = (Array.isArray(body.files) ? body.files : []).slice(0, 6).map(x => clean(x, 64));
      const files = fileIds.length ? (await db.prepare(`SELECT id,name,mime FROM files WHERE user_id=? AND id IN (${fileIds.map(() => '?').join(',')})`).bind(U, ...fileIds).all()).results : [];
      if (files.length) await db.prepare(`UPDATE files SET conv=? WHERE user_id=? AND conv IS NULL AND id IN (${files.map(() => '?').join(',')})`).bind(conv, U, ...files.map(f => f.id)).run();
      await addMsg(db, U, conv, 'me', text || '（附件）', files);
      let chain;
      if (bot) chain = [bot.id];
      else {
        const named = group.members.filter(id => { const b = bots.find(x => x.id === id); return b && text.includes('@' + b.name); });
        chain = named.length ? named : group.members;
      }
      // groups: members work at the same time and each decides whether the message is theirs; rules saying 輪流/依序 keep turns
      if (group && !turnsOf(group)) for (const id of chain) await addJob(db, U, conv, [id], text || '請處理我傳的附件。');
      else await addJob(db, U, conv, chain, text || '請處理我傳的附件。');
      return ok();
    }
    if (path === 'clear' && m === 'POST') {   // empty one conversation's history
      const conv = clean(body.conv, 64);
      const { bots, groups } = await loadAll(db, U);
      if (!bots.some(b => b.id === conv) && !groups.some(g => g.id === conv)) return err('找不到對話', 404);
      await db.batch([
        db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(conv, U),
        db.prepare("DELETE FROM jobs WHERE conv=? AND user_id=? AND status='pending'").bind(conv, U)
      ]);
      await addMsg(db, U, conv, 'sys', '對話紀錄已清空');
      return ok();
    }
    if (path === 'grokbot/list' && m === 'POST') {   // ask the host computer for the bots in the user's Grok Bot
      const r = await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,'__test','list:grokbot','[]','',?,'list','grokbot')").bind(U, now()).run();
      return ok({ id: r.meta.last_row_id });
    }
    if (path === 'engine-install' && m === 'POST') {   // from any device: the host computer opens the install window
      const engine = engineOk(body.engine);
      if (['copilot', 'cursor', 'qwen', 'grok'].includes(engine)) return err('這個 AI 暫時不開放連接', 400);
      const h = env.isLocal ? null : await hostInfo(db, U);
      if (h && !h.online) return err('主機電腦離線，請先打開主機電腦上的 OCTA', 409);
      const hs = h && h.runners.find(r => (r.label || 'runner') === h.hostLabel), hv = hs?.info ? JSON.parse(hs.info).app || '' : '';
      if (h && hv && hv.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0) < 2002004) return err('主機電腦的 OCTA 版本太舊，請先更新到 v2.2.4 以上', 409);
      const r = await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,'__test',?,'[]','',?,'install',?)")
        .bind(U, 'install:' + engine, now(), engine).run();
      return ok({ id: r.meta.last_row_id });
    }
    if (path === 'engine-test' && m === 'POST') {
      const engine = engineOk(body.engine);
      const r = await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,'__test',?,'[]',?,?,'test',?)")
        .bind(U, 'test:' + engine, '這是 OCTA 的連線測試，請只回覆兩個字：OK', now(), engine).run();
      return ok({ id: r.meta.last_row_id });
    }
    if (path.startsWith('job/') && m === 'GET') {
      const j = await db.prepare('SELECT status,result FROM jobs WHERE id=? AND user_id=?').bind(+path.slice(4), U).first();
      return j ? J(j) : err('找不到', 404);
    }
    if (path === 'settings' && m === 'GET') {
      const st = await getSettings(db, U);
      return J({ warm: WARM.includes(+st.warm) ? +st.warm : 120, shareBrowser: st.shareBrowser !== false, notes: st.notes || '', notifyAll: !!st.notifyAll, sched: st.sched === 'pc' ? 'pc' : 'cloud', tg: { token: mask(st.tg?.token), chat: st.tg?.chat || '' }, line: { token: mask(st.line?.token), to: st.line?.to || '' } });
    }
    if (path === 'settings' && m === 'PUT') {
      const st = await getSettings(db, U);
      if (body.notes !== undefined) st.notes = clean(body.notes, 20000);
      if (body.notifyAll !== undefined) st.notifyAll = !!body.notifyAll;
      if (['cloud', 'pc'].includes(body.sched)) st.sched = body.sched;
      if (body.warm !== undefined && WARM.includes(+body.warm)) st.warm = +body.warm;
      if (body.shareBrowser !== undefined) st.shareBrowser = !!body.shareBrowser;
      if (['zh-TW', 'zh-CN', 'en', 'ja'].includes(body.lang)) st.lang = body.lang;
      // per-bot extras kept with the account: 置頂, notifications, memory (📌), skills (🧩)
      if (Array.isArray(body.pins)) { st.pins = body.pins.map(x => clean(x, 64)).filter(Boolean).slice(0, 50); await putSettings(db, U, st); await bump(db, U); return J({ ok: true }); }
      if (body.mute && typeof body.mute === 'object') { st.mute = st.mute || {}; const id = clean(body.mute.bot, 64); if (body.mute.on) st.mute[id] = 1; else delete st.mute[id]; await putSettings(db, U, st); await bump(db, U); return J({ ok: true }); }
      if (body.memory && typeof body.memory === 'object') {
        st.memory = st.memory || {}; const id = clean(body.memory.bot, 64), list = (Array.isArray(body.memory.list) ? body.memory.list : []).map(x => clean(x, 300)).filter(Boolean).slice(-40);
        if (list.length) st.memory[id] = list; else delete st.memory[id];
        await putSettings(db, U, st); await bump(db, U); return J({ ok: true });
      }
      if (body.skills && typeof body.skills === 'object') {
        st.skills = st.skills || {}; const id = clean(body.skills.bot, 64);
        const list = (Array.isArray(body.skills.list) ? body.skills.list : []).map(x => ({ name: clean(x?.name, 40), steps: clean(x?.steps, 3000) })).filter(x => x.name && x.steps).slice(0, 20);
        if (list.length) st.skills[id] = list; else delete st.skills[id];
        await putSettings(db, U, st); await bump(db, U); return J({ ok: true });
      }
      if (body.allow && typeof body.allow === 'object') {   // 一律允許: things a bot may do without asking each time
        const bid = clean(body.allow.bot, 64), list = (Array.isArray(body.allow.list) ? body.allow.list : []).map(x => clean(x, 120)).filter(Boolean).slice(0, 20);
        st.allow = st.allow || {};
        if (list.length) st.allow[bid] = list; else delete st.allow[bid];
        await putSettings(db, U, st);
        await bump(db, U);
        return J({ ok: true });
      }
      if (body.quick && typeof body.quick === 'object') {   // 常用指令 per conversation
        const conv = clean(body.quick.conv, 64), list = (Array.isArray(body.quick.list) ? body.quick.list : []).map(x => clean(x, 300)).filter(Boolean).slice(0, 12);
        st.quick = st.quick || {};
        if (list.length) st.quick[conv] = list; else delete st.quick[conv];
        await putSettings(db, U, st);
        await bump(db, U);
        return J({ ok: true });
      }
      for (const k of ['tg', 'line']) if (body[k]) {
        const cur = st[k] || {};
        const tok = clean(body[k].token, 300);
        if (tok && !tok.startsWith('••••')) cur.token = tok;
        if (body[k].token === '') delete cur.token;
        const dest = clean(body[k][k === 'tg' ? 'chat' : 'to'], 100);
        cur[k === 'tg' ? 'chat' : 'to'] = dest;
        st[k] = cur;
      }
      await putSettings(db, U, st);
      if (body.sched !== undefined) await bump(db, U);
      return J({ ok: true });
    }
    if (path === 'notify/test' && m === 'POST') {
      const sent = await sendNotify(env, await getSettings(db, U), '【OCTA】測試通知：設定成功 ✓');
      return sent.length ? J({ sent }) : err('還沒有設定任何通知管道');
    }
    if (path === 'notify/detect' && m === 'POST') {   // find the Telegram chat id from the latest message sent to the bot
      const st = await getSettings(db, U);
      if (!st.tg?.token) return err('先填 Telegram Bot Token 並儲存');
      const r = await fetch(`https://api.telegram.org/bot${st.tg.token}/getUpdates`).then(x => x.json()).catch(() => null);
      const chat = r?.result?.reverse().find(u => u.message?.chat?.id)?.message.chat.id;
      if (!chat) return err('找不到訊息。請先用 Telegram 傳任何一句話給你的 bot，再按一次');
      st.tg.chat = String(chat);
      await putSettings(db, U, st);
      return J({ chat: String(chat) });
    }
    if (path === 'logs' && m === 'GET') {
      const { bots, groups } = await loadAll(db, U);
      const rows = (await db.prepare("SELECT id,conv,bot_id,prompt,status,kind,url,created,started,finished FROM jobs WHERE user_id=? ORDER BY id DESC LIMIT 100").bind(U).all()).results;
      return J({ logs: rows.map(r => ({ ...r, bot: r.kind === 'test' ? 'AI 連線測試：' + r.url : bots.find(b => b.id === r.bot_id)?.name || '已刪除', convName: (bots.find(b => b.id === r.conv) || groups.find(g => g.id === r.conv))?.name || '', prompt: r.prompt.slice(0, 80) })) });
    }
    if (path.startsWith('shot/') && m === 'GET') {
      const b = await db.prepare('SELECT shot_file FROM bots WHERE id=? AND user_id=?').bind(path.slice(5), U).first();
      if (b?.shot_file) return J({ file: b.shot_file });
      const s = await db.prepare('SELECT mime,data,ts FROM shots WHERE bot_id=? AND user_id=?').bind(path.slice(5), U).first();
      return J(s || {});
    }
    if (path === 'open' && m === 'POST') {
      const { bots, groups } = await loadAll(db, U);
      const bot = bots.find(b => b.id === body.bot);
      const conv = clean(body.conv, 64);
      if (!bot || !(conv === bot.id || groups.some(g => g.id === conv))) return err('找不到機器人', 404);
      let link = clean(body.url, 500);
      if (body.hide) link = 'octa:hide';   // put the window back in the background
      else if (link && !/^https?:\/\//.test(link)) link = 'https://' + link;
      // don't stack duplicates if the button is pressed again before the computer picks it up
      if (await db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND bot_id=? AND kind='open' AND status='pending'").bind(U, bot.id).first()) return J({ ok: true, queued: true });
      await addMsg(db, U, conv, 'sys', body.hide ? `把「${bot.name}」的瀏覽器收到背景` : `在電腦上顯示「${bot.name}」的瀏覽器${link ? '：' + link : ''}`);
      await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,?,?,'[]','',?,'open',?)").bind(U, conv, bot.id, now(), link || null).run();
      return ok();
    }
    if (path === 'cancel' && m === 'POST') {
      const conv = clean(body.conv, 64);
      await db.prepare("DELETE FROM jobs WHERE user_id=? AND conv=? AND status='pending'").bind(U, conv).run();
      await db.prepare("UPDATE jobs SET status='error' WHERE user_id=? AND conv=? AND status='running'").bind(U, conv).run();
      await addMsg(db, U, conv, 'sys', '已停止目前的任務');
      return ok();
    }
    if (path === 'runner-token' && m === 'POST') {
      // each computer keeps its own key; making a new one only replaces the key with the same label
      const label = clean(body.label, 60) || 'runner';
      await db.prepare("DELETE FROM sessions WHERE user_id=? AND kind='runner' AND IFNULL(label,'runner')=?").bind(U, label).run();
      return ok({ token: await newSession(db, U, 'runner', label, { ua: clean(body.device, 60) || label }) });
    }

    // ---------- account: devices, computers, password ----------
    if (path === 'devices' && m === 'GET') {
      const rows = (await db.prepare('SELECT token,kind,label,created,seen,ua,ip,place,info FROM sessions WHERE user_id=? ORDER BY IFNULL(seen,created) DESC').bind(U).all()).results;
      const h = env.isLocal ? null : await hostInfo(db, U);
      return J({
        devices: rows.filter(r => r.kind === 'web').map(r => ({ id: r.token.slice(0, 16), name: r.ua || '裝置', place: r.place || '', created: r.created, seen: r.seen || r.created, current: r.token === me.token })),
        computers: rows.filter(r => r.kind === 'runner').map(r => {
          const info = r.info ? JSON.parse(r.info) : {};
          return { id: r.token.slice(0, 16), name: (r.label || 'runner').replace(/^desktop:/, ''), seen: r.seen || 0, online: now() - (r.seen || 0) < HOST_ONLINE_MS, host: (r.label || 'runner') === h?.hostLabel, version: info.app || info.version || '', engines: info.engines || null, store: info.store || '' };
        })
      });
    }
    if (path === 'devices/remove' && m === 'POST') {   // sign out chosen devices / remove computers (password required)
      const u = await db.prepare('SELECT pw FROM users WHERE id=?').bind(U).first();
      const lim = [['n:' + me.name.toLowerCase(), 5]];
      if (await blocked(db, lim)) return err('密碼錯太多次，請稍後再試', 429);
      if (!(await checkPw(String(body.pw || ''), u?.pw))) { await failed(db, lim); return err('密碼錯誤', 403); }
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(x => clean(x, 16)).filter(x => /^[0-9a-f]{16}$/.test(x));
      if (!ids.length) return err('請選擇裝置');
      for (const id of ids) await db.prepare("DELETE FROM sessions WHERE user_id=? AND substr(token,1,16)=?").bind(U, id).run();
      await bump(db, U);
      return J({ ok: true, removed: ids.length });
    }
    if (path === 'host' && m === 'POST') {   // choose which computer runs the bots
      const r = await db.prepare("SELECT label FROM sessions WHERE user_id=? AND kind='runner' AND substr(token,1,16)=?").bind(U, clean(body.id, 16)).first();
      if (!r) return err('找不到這台電腦', 404);
      await db.prepare('UPDATE users SET host=? WHERE id=?').bind(r.label || 'runner', U).run();
      return ok();
    }
    if (path === 'password' && m === 'POST') {
      const pw = String(body.pw || '');
      if (pw.length < 8) return err('新密碼至少 8 碼');
      const u = await db.prepare('SELECT pw FROM users WHERE id=?').bind(U).first();
      const lim = [['n:' + me.name.toLowerCase(), 5]];
      if (await blocked(db, lim)) return err('密碼錯太多次，請稍後再試', 429);
      if (!(await checkPw(String(body.old || ''), u?.pw))) { await failed(db, lim); return err('目前的密碼不對', 403); }
      await db.batch([
        db.prepare('UPDATE users SET pw=? WHERE id=?').bind(await hashPw(pw), U),
        db.prepare("DELETE FROM sessions WHERE user_id=? AND kind='web' AND token<>?").bind(U, me.token || '')   // other devices sign in again
      ]);
      return J({ ok: true });
    }
    if (path === 'me' && m === 'GET') return J({ id: U, name: me.name });
    if (path === 'ai-usage' && m === 'GET') {   // plan quota reported by the host + how often OCTA used each AI today
      const { date } = localNow(env);
      const dayStart = Date.parse(date + 'T00:00:00Z') - (+env.TZ_OFFSET_MIN || 0) * 60000;
      const rows = (await db.prepare("SELECT b.engine AS e, COUNT(*) AS n FROM jobs j JOIN bots b ON b.id=j.bot_id WHERE j.user_id=? AND j.kind='chat' AND j.created>=? GROUP BY b.engine").bind(U, dayStart).all()).results;
      const h = env.isLocal ? null : await hostInfo(db, U);
      const hostRow = h?.runners.find(r => (r.label || 'runner') === h.hostLabel);
      const usage = env.isLocal ? (await getSettings(db, U))._usage || null : (hostRow?.info ? JSON.parse(hostRow.info).usage || null : null);
      return J({ today: Object.fromEntries(rows.map(r => [r.e || 'claude', r.n])), usage, engines: h ? h.engines : null });
    }
    if (path === 'reset-code' && m === 'POST') return J({ code: await newResetCode(db, U), minutes: 15 });   // shown on a signed-in device

    return err('找不到這個 API', 404);
  } catch (e) {
    return err('伺服器錯誤：' + (e.message || e), 500);
  }
}

async function newResetCode(db, userId) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', rnd = crypto.getRandomValues(new Uint8Array(8));
  const code = [...rnd].map(b => chars[b % chars.length]).join('');
  await db.prepare('UPDATE users SET reset=? WHERE id=?').bind(JSON.stringify({ h: await sha(code), exp: now() + 15 * MIN }), userId).run();
  return code;
}

// what the host computer should do next: a job (if it has a free slot), uploads to save, files to send
// what a computer on standby should do: send files that live on it, jobs addressed to it
async function pcWork(env, db, U, label, slots) {
  const pull = (await db.prepare("SELECT id,path FROM files WHERE user_id=? AND loc='pc' AND want>? AND pc=? LIMIT 10").bind(U, now() - MIN, label).all()).results;
  let job = null;
  if (slots > 0) {
    const j = await db.prepare("SELECT * FROM jobs WHERE user_id=? AND status='pending' AND pc=? AND kind='export' ORDER BY id LIMIT 1").bind(U, label).first();
    if (j && (await db.prepare("UPDATE jobs SET status='running', started=? WHERE id=? AND status='pending'").bind(now(), j.id).run()).meta.changes) job = await jobPayload(env, db, U, j);
  }
  return job || pull.length ? { job, inbox: [], pull } : null;
}
async function nextWork(env, db, U, slots, label = null) {
  // files that live on another computer are sent by that computer
  const files = (await db.prepare("SELECT id,name,mime,conv,loc,path FROM files WHERE user_id=? AND ((loc='cloud' AND conv IS NOT NULL) OR (loc='pc' AND want>? AND (pc IS NULL OR pc=? OR ? IS NULL))) LIMIT 10").bind(U, now() - MIN, label, label).all()).results;
  const inbox = files.filter(f => f.loc === 'cloud').map(f => ({ id: f.id, name: f.name, conv: f.conv }));
  const pull = files.filter(f => f.loc === 'pc').map(f => ({ id: f.id, path: f.path }));
  let job = null;
  if (slots > 0) {
    // one task per bot at a time; showing its browser on screen ('open') never waits
    const j = await db.prepare(`SELECT * FROM jobs j WHERE user_id=? AND status='pending' AND (j.pc IS NULL OR j.pc=?)
      AND (j.kind='open' OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.user_id=j.user_id AND r.bot_id=j.bot_id AND r.status='running' AND r.kind<>'open'))
      ORDER BY (j.kind='open') DESC, id LIMIT 1`).bind(U, label || '').first();
    if (j) {
      const claimed = await db.prepare("UPDATE jobs SET status='running', started=? WHERE id=? AND status='pending'").bind(now(), j.id).run();
      if (claimed.meta.changes) { await bump(db, U); job = await jobPayload(env, db, U, j); }
    }
  }
  if (!job && !inbox.length && !pull.length) return null;
  const all = (inbox.length || job) ? await loadAll(db, U) : null;
  const convName = id => (all?.bots.find(b => b.id === id) || all?.groups.find(g => g.id === id))?.name || '';
  return { job, inbox: inbox.map(f => ({ ...f, convName: convName(f.conv) })), pull };
}
async function jobPayload(env, db, U, job) {
  if (job.kind === 'test') return { id: job.id, kind: 'test', engine: engineOk(job.url), prompt: job.prompt };
  if (job.kind === 'list') return { id: job.id, kind: 'list', what: job.url };
  if (job.kind === 'install') return { id: job.id, kind: 'install', engine: engineOk(job.url) };
  if (job.kind === 'export' || job.kind === 'import') {
    const b = await db.prepare('SELECT id,name,browser FROM bots WHERE id=? AND user_id=?').bind(job.bot_id, U).first();
    if (!b) { await db.prepare("UPDATE jobs SET status='error' WHERE id=?").bind(job.id).run(); return null; }
    const st = await getSettings(db, U);
    return { id: job.id, kind: job.kind, shareBrowser: st.shareBrowser !== false, bot: { id: b.id, name: b.name, browser: 'own' }, xfer: job.kind === 'import' ? job.url : undefined };
  }
  const { bots, groups, folders } = await loadAll(db, U);
  const name = id => id === 'me' ? '使用者' : id === 'sys' ? '系統' : (bots.find(b => b.id === id)?.name || '已刪除的機器人');
  const bot = bots.find(b => b.id === job.bot_id);
  if (!bot) { await db.prepare("UPDATE jobs SET status='error' WHERE id=?").bind(job.id).run(); return null; }
  const group = groups.find(g => g.id === job.conv);
  const conv = group || bot;
  const hist = (await db.prepare('SELECT id,by_,text,files FROM messages WHERE user_id=? AND conv=? ORDER BY id DESC LIMIT 30').bind(U, job.conv).all()).results.reverse();
  const fileIds = [...new Set(hist.flatMap(h => (h.files ? JSON.parse(h.files) : []).map(f => f.id)))];
  const where = fileIds.length ? (await db.prepare(`SELECT id,path FROM files WHERE user_id=? AND id IN (${fileIds.map(() => '?').join(',')})`).bind(U, ...fileIds).all()).results : [];
  const pathOf = id => where.find(w => w.id === id)?.path || null;
  const st = await getSettings(db, U);
  const { date } = localNow(env);   // how many jobs this AI already ran today, so the bot can tell the user
  const dayStart = Date.parse(date + 'T00:00:00Z') - (+env.TZ_OFFSET_MIN || 0) * 60000;
  const usageToday = (await db.prepare("SELECT COUNT(*) AS n FROM jobs j JOIN bots b ON b.id=j.bot_id WHERE j.user_id=? AND j.kind='chat' AND j.created>=? AND IFNULL(b.engine,'claude')=?").bind(U, dayStart, bot.engine || 'claude').first())?.n ?? null;
  return {
    id: job.id, kind: job.kind, url: job.url, prompt: job.prompt, usageToday, warm: WARM.includes(+st.warm) ? +st.warm : 120, allowed: (st.allow || {})[bot.id] || [], memory: (st.memory || {})[bot.id] || [], skills: (st.skills || {})[bot.id] || [],
    nskills: (st.nskills || {})[bot.id] || null,
    routines: (await db.prepare('SELECT name,times,enabled FROM routines WHERE user_id=? AND conv IN (?,?)').bind(U, job.conv, bot.id).all()).results.map(r => ({ name: r.name, times: JSON.parse(r.times), enabled: !!r.enabled })),
    canAsk: job.depth < MAX_ASK_DEPTH,
    conv: { id: conv.id, name: conv.name },
    shareBrowser: st.shareBrowser !== false,
    bot: { id: bot.id, name: bot.name, task: bot.task, page: bot.page, engine: bot.engine || 'claude', model: bot.model || '', browser: bot.browser === 'mine' ? 'mine' : 'own' },
    folder: folders.find(f => f.id === bot.folder)?.name || null,
    folderNotes: folders.find(f => f.id === bot.folder)?.notes || '',
    notes: st.notes || '',
    lang: st.lang || 'zh-TW',
    colleagues: bots.filter(b => b.id !== bot.id).sort((a, b) => ((a.folder || null) === (bot.folder || null) ? 0 : 1) - ((b.folder || null) === (bot.folder || null) ? 0 : 1)).slice(0, 20).map(b => ({ id: b.id, name: b.name, task: b.task })),
    group: group ? { name: group.name, task: group.task, members: group.members.map(name), mode: turnsOf(group) ? 'turns' : 'parallel' } : null,
    history: hist.map(h => ({ id: h.id, who: name(h.by_), text: h.text, files: (h.files ? JSON.parse(h.files) : []).map(f => ({ ...f, path: pathOf(f.id) })) }))
  };
}
