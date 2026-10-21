// E·BOT API — Cloudflare Pages Function, single router.
// Web app uses a "web" session token; the local runner uses a "runner" token.

const J = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (msg, status = 400) => J({ error: msg }, status);
const now = () => Date.now();
const uid = () => crypto.randomUUID();
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const randTok = () => hex(crypto.getRandomValues(new Uint8Array(24)));
const MAX_ASK_DEPTH = 4;   // how many times bots may hand questions to each other in one run

async function pbkdf2(pw, salt, iter = 100000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: iter }, key, 256));
}
async function hashPw(pw) { const salt = randTok(); return `pbkdf2$100000$${salt}$${await pbkdf2(pw, salt)}`; }
async function checkPw(pw, stored) {
  const [, iter, salt, h] = stored.split('$');
  const got = await pbkdf2(pw, salt, +iter);
  if (got.length !== h.length) return false;
  let d = 0; for (let i = 0; i < h.length; i++) d |= got.charCodeAt(i) ^ h.charCodeAt(i);
  return d === 0;
}
async function newSession(db, userId, kind, label = null) {
  const t = randTok();
  await db.prepare('INSERT INTO sessions (token,user_id,kind,label,created) VALUES (?,?,?,?,?)').bind(await sha(t), userId, kind, label, now()).run();
  return t;
}
async function auth(req, db) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) return null;
  return db.prepare('SELECT s.user_id, s.kind, u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').bind(await sha(t)).first();
}
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const cleanTimes = a => [...new Set((Array.isArray(a) ? a : []).filter(s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s)))].sort().slice(0, 12);
const localNow = env => {
  const d = new Date(now() + (+env.TZ_OFFSET_MIN || 0) * 60000);
  return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) };
};

async function addMsg(db, userId, conv, by, text) {
  await db.prepare('INSERT INTO messages (user_id,conv,by_,text,ts) VALUES (?,?,?,?,?)').bind(userId, conv, by, text, now()).run();
}
// chain: list of bot ids (all use `prompt`) or {b, p} steps
async function addJob(db, userId, conv, chain, prompt, depth = 0) {
  const steps = chain.map(s => (typeof s === 'string' ? { b: s, p: prompt } : s));
  if (!steps.length) return;
  await db.prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,depth) VALUES (?,?,?,?,?,?,?)')
    .bind(userId, conv, steps[0].b, JSON.stringify(steps.slice(1)), steps[0].p, now(), depth).run();
}
async function loadAll(db, userId) {
  const [b, g, f, r] = await db.batch([
    db.prepare('SELECT id,name,task,folder,shot_ts,page FROM bots WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,name,task,members,folder FROM groups_ WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,name FROM folders WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,conv,name,prompt,times,enabled FROM routines WHERE user_id=? ORDER BY created').bind(userId)
  ]);
  return {
    bots: b.results,
    groups: g.results.map(x => ({ ...x, members: JSON.parse(x.members) })),
    folders: f.results,
    routines: r.results.map(x => ({ ...x, times: JSON.parse(x.times), enabled: !!x.enabled }))
  };
}
const folderOk = (folders, id) => (id && folders.some(f => f.id === id) ? id : null);

// Templates offered in the app
const TEMPLATES = {
  assistant: {
    folder: null,
    bots: [{ k: 'a', name: '助理', task: '回答我的問題，必要時用瀏覽器查資料或操作我已登入的網站，做完回報重點。' }],
    groups: []
  },
  guesthouse: {
    folder: '旅館',
    bots: [
      { k: 'b1', name: '訂房員', task: '開 Booking.com 合作夥伴後台，抓今天與明天的入住、退房訂單：房號、客人姓名、晚數，整理成清單。' },
      { k: 'b2', name: '暱稱員', task: '開 LINE 官方帳號後台，讀各旅館聊天列表的客人暱稱，依「名字 M/D」「M/D-D」「補助」規則整理今天的入住與續住。' },
      { k: 'b3', name: '房務員', task: '整合訂房員與暱稱員的資料，算出今天要掃的房間，更新到 E·ROOM（eroom.yzprojecttw.com）。資料不夠時直接問同事。' },
      { k: 'b4', name: '記帳員', task: '把今天的訂房資料寫進我的 Google 訂房紀錄試算表，重複的不寫。' },
      { k: 'b5', name: '迎賓員', task: '依今天入住名單擬好每位客人的入住資訊訊息，列出來給我確認。我在對話裡明確說「發送」前，絕對不要發給任何客人。' }
    ],
    groups: [{ name: '每日入住流程', task: '依序協作：訂房員、暱稱員抓資料 → 房務員更新 E·ROOM → 記帳員寫試算表 → 迎賓員擬入住訊息給我確認。', members: ['b1', 'b2', 'b3', 'b4', 'b5'] }]
  }
};

export async function onRequest({ request: req, env, params }) {
  const db = env.DB;
  const path = (params.path || []).join('/');
  const m = req.method;
  let body = {};
  if (m !== 'GET') { try { body = await req.json(); } catch { body = {}; } }

  try {
    // ---------- public ----------
    if (path === 'signup' && m === 'POST') {
      if (env.ALLOW_SIGNUP !== 'true') return err('目前不開放註冊', 403);
      const name = clean(body.name, 32), pw = String(body.pw || '');
      if (!/^[\w.\-一-鿿]{2,32}$/.test(name)) return err('帳號需 2–32 字，只能用中英文、數字、底線、點、減號');
      if (pw.length < 8) return err('密碼至少 8 碼');
      if (await db.prepare('SELECT 1 FROM users WHERE name=?').bind(name).first()) return err('這個帳號已被使用');
      const id = uid();
      await db.prepare('INSERT INTO users (id,name,pw,created) VALUES (?,?,?,?)').bind(id, name, await hashPw(pw), now()).run();
      return J({ token: await newSession(db, id, 'web') });
    }
    if (path === 'login' && m === 'POST') {
      const u = await db.prepare('SELECT id,pw FROM users WHERE name=?').bind(clean(body.name, 32)).first();
      if (!u || !(await checkPw(String(body.pw || ''), u.pw))) return err('帳號或密碼錯誤', 401);
      return J({ token: await newSession(db, u.id, 'web') });
    }
    if (path === 'config' && m === 'GET') return J({ signup: env.ALLOW_SIGNUP === 'true' });

    const me = await auth(req, db);
    if (!me) return err('請先登入', 401);
    const U = me.user_id;

    // ---------- runner ----------
    if (path.startsWith('runner/')) {
      if (me.kind !== 'runner') return err('需要執行器金鑰', 403);
      await db.prepare('UPDATE users SET runner_seen=? WHERE id=?').bind(now(), U).run();

      if (path === 'runner/next' && m === 'POST') {
        const { date, hm } = localNow(env);
        const all = await loadAll(db, U);
        // routines that are due today and not yet fired for that time
        for (const r of (await db.prepare('SELECT * FROM routines WHERE user_id=? AND enabled=1').bind(U).all()).results) {
          const fired = JSON.parse(r.fired || '{}');
          const due = JSON.parse(r.times).filter(t => t <= hm && fired[t] !== date);
          if (!due.length) continue;
          due.forEach(t => (fired[t] = date));
          const upd = await db.prepare('UPDATE routines SET fired=? WHERE id=? AND IFNULL(fired,\'\')=IFNULL(?,\'\')').bind(JSON.stringify(fired), r.id, r.fired).run();
          if (!upd.meta.changes) continue;   // another poll fired it
          const g = all.groups.find(x => x.id === r.conv), b = all.bots.find(x => x.id === r.conv);
          if (!g && !b) continue;
          await addMsg(db, U, r.conv, 'sys', `${due[due.length - 1]} 例行任務：${r.name}`);
          await addJob(db, U, r.conv, g ? g.members : [b.id], `（例行任務「${r.name}」）${r.prompt || '請執行你的指定任務，完成後回報結果。'}`);
        }
        // stale running jobs become errors
        const stale = (await db.prepare("SELECT id,conv,bot_id FROM jobs WHERE user_id=? AND status='running' AND ((kind='chat' AND started<?) OR started<?)").bind(U, now() - 20 * 60000, now() - 3 * 3600000).all()).results;
        for (const s of stale) {
          await db.prepare("UPDATE jobs SET status='error' WHERE id=?").bind(s.id).run();
          await addMsg(db, U, s.conv, s.bot_id, '⚠ 執行逾時，已中止。');
        }
        // one job per bot at a time, so each bot keeps its own browser to itself
        const job = await db.prepare(`SELECT * FROM jobs j WHERE user_id=? AND status='pending'
          AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.user_id=j.user_id AND r.bot_id=j.bot_id AND r.status='running')
          ORDER BY id LIMIT 1`).bind(U).first();
        if (!job) return J({ job: null });
        const claimed = await db.prepare("UPDATE jobs SET status='running', started=? WHERE id=? AND status='pending'").bind(now(), job.id).run();
        if (!claimed.meta.changes) return J({ job: null });
        const { bots, groups, folders } = all;
        const name = id => id === 'me' ? '使用者' : id === 'sys' ? '系統' : (bots.find(b => b.id === id)?.name || '已刪除的機器人');
        const bot = bots.find(b => b.id === job.bot_id);
        if (!bot) { await db.prepare("UPDATE jobs SET status='error' WHERE id=?").bind(job.id).run(); return J({ job: null }); }
        const group = groups.find(g => g.id === job.conv);
        const hist = (await db.prepare('SELECT by_,text FROM messages WHERE user_id=? AND conv=? ORDER BY id DESC LIMIT 30').bind(U, job.conv).all()).results.reverse();
        return J({
          job: {
            id: job.id, kind: job.kind, url: job.url, prompt: job.prompt,
            canAsk: job.depth < MAX_ASK_DEPTH,
            bot: { id: bot.id, name: bot.name, task: bot.task, page: bot.page },
            folder: folders.find(f => f.id === bot.folder)?.name || null,
            colleagues: bots.filter(b => b.id !== bot.id && (b.folder || null) === (bot.folder || null)).map(b => ({ name: b.name, task: b.task })),
            group: group ? { name: group.name, task: group.task, members: group.members.map(name) } : null,
            history: hist.map(h => ({ who: name(h.by_), text: h.text }))
          }
        });
      }
      if (path === 'runner/done' && m === 'POST') {
        const job = await db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND status='running'").bind(+body.id, U).first();
        if (!job) return err('找不到執行中的任務', 404);
        const ok = body.ok !== false;
        const text = clean(body.text, 20000) || (ok ? '（完成，無回覆內容）' : '⚠ 執行失敗');
        await db.prepare('UPDATE jobs SET status=? WHERE id=?').bind(ok ? 'done' : 'error', job.id).run();
        await addMsg(db, U, job.conv, job.bot_id, text);
        if (body.page) await db.prepare('UPDATE bots SET page=? WHERE id=? AND user_id=?').bind(clean(body.page, 500), job.bot_id, U).run();
        if (!ok || job.kind !== 'chat') return J({ ok: true });
        let rest = JSON.parse(job.chain).map(s => (typeof s === 'string' ? { b: s, p: job.prompt } : s));
        // a bot asks a colleague in the same 分區: a line starting with "@名字 問題"
        const { bots } = await loadAll(db, U);
        const self = bots.find(b => b.id === job.bot_id);
        const asks = [];
        if (self && job.depth < MAX_ASK_DEPTH) {
          for (const line of text.split('\n')) {
            const mm = line.trim().match(/^@(\S+)\s+(.+)$/);
            if (!mm) continue;
            const to = bots.find(b => b.name === mm[1] && b.id !== self.id && (b.folder || null) === (self.folder || null));
            if (to && !asks.some(a => a.b === to.id)) asks.push({ b: to.id, p: `${self.name} 問你：${mm[2]}\n請直接回答 ${self.name}。` });
          }
        }
        if (asks.length) rest = [...asks, { b: self.id, p: `同事已在上面回覆你的問題，請根據回覆繼續完成原本的指示：${job.prompt}` }, ...rest];
        await addJob(db, U, job.conv, rest, job.prompt, job.depth + (asks.length ? 1 : 0));
        return J({ ok: true });
      }
      if (path === 'runner/shot' && m === 'POST') {
        const job = await db.prepare("SELECT bot_id FROM jobs WHERE id=? AND user_id=?").bind(+body.id, U).first();
        if (!job) return err('找不到任務', 404);
        const data = String(body.data || ''), mime = /^image\/(png|jpeg|webp)$/.test(body.mime) ? body.mime : 'image/png';
        if (!data || data.length > 1_500_000) return err('截圖太大或是空的');
        await db.prepare('INSERT INTO shots (bot_id,user_id,mime,data,ts) VALUES (?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET mime=excluded.mime,data=excluded.data,ts=excluded.ts')
          .bind(job.bot_id, U, mime, data, now()).run();
        await db.prepare('UPDATE bots SET shot_ts=? WHERE id=? AND user_id=?').bind(now(), job.bot_id, U).run();
        return J({ ok: true });
      }
      return err('未知的執行器路徑', 404);
    }

    // ---------- web app ----------
    if (path === 'logout' && m === 'POST') {
      await db.prepare('DELETE FROM sessions WHERE token=?').bind(await sha(req.headers.get('authorization').slice(7))).run();
      return J({ ok: true });
    }
    if (path === 'state' && m === 'GET') {
      const after = +new URL(req.url).searchParams.get('after') || 0;
      const all = await loadAll(db, U);
      const msgs = (await db.prepare(after
        ? 'SELECT id,conv,by_ AS by,text,ts FROM messages WHERE user_id=? AND id>? ORDER BY id LIMIT 500'
        : 'SELECT * FROM (SELECT id,conv,by_ AS by,text,ts FROM messages WHERE user_id=? AND ?=0 ORDER BY id DESC LIMIT 500) ORDER BY id')
        .bind(U, after).all()).results;
      const busy = (await db.prepare("SELECT conv,bot_id,status,kind FROM jobs WHERE user_id=? AND status IN ('pending','running')").bind(U).all()).results;
      const u = await db.prepare('SELECT runner_seen FROM users WHERE id=?').bind(U).first();
      return J({ me: me.name, runnerOnline: now() - (u.runner_seen || 0) < 60000, ...all, msgs, busy });
    }
    if (path === 'template' && m === 'POST') {
      const t = TEMPLATES[body.name];
      if (!t) return err('沒有這個範本');
      let folder = null;
      if (t.folder) {
        folder = (await db.prepare('SELECT id FROM folders WHERE user_id=? AND name=?').bind(U, t.folder).first())?.id;
        if (!folder) { folder = 'f-' + uid(); await db.prepare('INSERT INTO folders (id,user_id,name,created) VALUES (?,?,?,?)').bind(folder, U, t.folder, now()).run(); }
      }
      const map = {};
      for (const b of t.bots) {
        map[b.k] = uid();
        await db.prepare('INSERT INTO bots (id,user_id,name,task,folder,created) VALUES (?,?,?,?,?,?)').bind(map[b.k], U, b.name, b.task, folder, now()).run();
      }
      for (const g of t.groups)
        await db.prepare('INSERT INTO groups_ (id,user_id,name,task,members,folder,created) VALUES (?,?,?,?,?,?,?)')
          .bind('g-' + uid(), U, g.name, g.task, JSON.stringify(g.members.map(k => map[k])), folder, now() + 1).run();
      return J({ ok: true });
    }

    // folders (分區)
    if (path === 'folders' && m === 'POST') {
      const name = clean(body.name, 20);
      if (!name) return err('分區名稱要填');
      const id = 'f-' + uid();
      await db.prepare('INSERT INTO folders (id,user_id,name,created) VALUES (?,?,?,?)').bind(id, U, name, now()).run();
      return J({ id });
    }
    if (path.startsWith('folders/')) {
      const id = path.slice(8);
      if (m === 'PUT') {
        const name = clean(body.name, 20);
        if (!name) return err('分區名稱要填');
        await db.prepare('UPDATE folders SET name=? WHERE id=? AND user_id=?').bind(name, id, U).run();
        return J({ ok: true });
      }
      if (m === 'DELETE') {   // items fall back to 未分區
        await db.batch([
          db.prepare('UPDATE bots SET folder=NULL WHERE folder=? AND user_id=?').bind(id, U),
          db.prepare('UPDATE groups_ SET folder=NULL WHERE folder=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM folders WHERE id=? AND user_id=?').bind(id, U)
        ]);
        return J({ ok: true });
      }
    }
    if (path === 'move' && m === 'POST') {
      const { folders } = await loadAll(db, U);
      const folder = folderOk(folders, body.folder);
      const id = clean(body.id, 64);
      await db.prepare(`UPDATE ${id.startsWith('g-') ? 'groups_' : 'bots'} SET folder=? WHERE id=? AND user_id=?`).bind(folder, id, U).run();
      return J({ ok: true });
    }

    // bots
    if (path === 'bots' && m === 'POST') {
      const name = clean(body.name, 20), task = clean(body.task, 4000);
      if (!name || !task) return err('名稱和任務都要填');
      const { folders, bots } = await loadAll(db, U);
      if (bots.some(b => b.name === name)) return err('已經有同名的機器人，名字要不同才能用 @ 叫它');
      const id = uid();
      await db.prepare('INSERT INTO bots (id,user_id,name,task,folder,created) VALUES (?,?,?,?,?,?)').bind(id, U, name, task, folderOk(folders, body.folder), now()).run();
      await addMsg(db, U, id, 'sys', '機器人已建立');
      return J({ id });
    }
    if (path.startsWith('bots/')) {
      const id = path.slice(5);
      if (m === 'PUT') {
        const name = clean(body.name, 20), task = clean(body.task, 4000);
        if (!name || !task) return err('名稱和任務都要填');
        const { folders, bots } = await loadAll(db, U);
        if (bots.some(b => b.name === name && b.id !== id)) return err('已經有同名的機器人');
        await db.prepare('UPDATE bots SET name=?,task=?,folder=? WHERE id=? AND user_id=?').bind(name, task, folderOk(folders, body.folder), id, U).run();
        return J({ ok: true });
      }
      if (m === 'DELETE') {
        await db.batch([
          db.prepare('DELETE FROM shots WHERE bot_id=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM routines WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM bots WHERE id=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare("DELETE FROM jobs WHERE bot_id=? AND user_id=? AND status='pending'").bind(id, U)
        ]);
        return J({ ok: true });
      }
    }

    // groups
    const groupBody = async () => {
      const name = clean(body.name, 20), task = clean(body.task, 4000);
      const { bots, folders } = await loadAll(db, U);
      const members = (Array.isArray(body.members) ? body.members : []).filter(x => bots.some(b => b.id === x));
      if (!name || !task || !members.length) throw new Error('名稱、成員、協作規則都要填');
      return { name, task, members: JSON.stringify(members), folder: folderOk(folders, body.folder) };
    };
    if (path === 'groups' && m === 'POST') {
      let g; try { g = await groupBody(); } catch (e) { return err(e.message); }
      const id = 'g-' + uid();
      await db.prepare('INSERT INTO groups_ (id,user_id,name,task,members,folder,created) VALUES (?,?,?,?,?,?,?)').bind(id, U, g.name, g.task, g.members, g.folder, now()).run();
      await addMsg(db, U, id, 'sys', '群組已建立');
      return J({ id });
    }
    if (path.startsWith('groups/')) {
      const id = path.slice(7);
      if (m === 'PUT') {
        let g; try { g = await groupBody(); } catch (e) { return err(e.message); }
        await db.prepare('UPDATE groups_ SET name=?,task=?,members=?,folder=? WHERE id=? AND user_id=?').bind(g.name, g.task, g.members, g.folder, id, U).run();
        return J({ ok: true });
      }
      if (m === 'DELETE') {
        await db.batch([
          db.prepare('DELETE FROM routines WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM groups_ WHERE id=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare("DELETE FROM jobs WHERE conv=? AND user_id=? AND status='pending'").bind(id, U)
        ]);
        return J({ ok: true });
      }
    }

    // routines (例行任務)
    if (path === 'routines' && m === 'POST') {
      const { bots, groups } = await loadAll(db, U);
      const conv = clean(body.conv, 64), name = clean(body.name, 40), times = cleanTimes(body.times);
      if (!bots.some(b => b.id === conv) && !groups.some(g => g.id === conv)) return err('找不到對話', 404);
      if (!name || !times.length) return err('名稱和時間都要填');
      const { date, hm } = localNow(env);   // times already past today start tomorrow
      const fired = Object.fromEntries(times.filter(t => t <= hm).map(t => [t, date]));
      await db.prepare('INSERT INTO routines (id,user_id,conv,name,prompt,times,enabled,fired,created) VALUES (?,?,?,?,?,?,1,?,?)')
        .bind('r-' + uid(), U, conv, name, clean(body.prompt, 2000), JSON.stringify(times), JSON.stringify(fired), now()).run();
      return J({ ok: true });
    }
    if (path.startsWith('routines/')) {
      const id = path.slice(9);
      const r = await db.prepare('SELECT * FROM routines WHERE id=? AND user_id=?').bind(id, U).first();
      if (!r) return err('找不到例行任務', 404);
      if (m === 'PUT') {
        const name = clean(body.name ?? r.name, 40), times = body.times ? cleanTimes(body.times) : JSON.parse(r.times);
        if (!name || !times.length) return err('名稱和時間都要填');
        const enabled = body.enabled === undefined ? r.enabled : body.enabled ? 1 : 0;
        let fired = r.fired;
        if (enabled && !r.enabled) {   // turning on: don't fire times already past today
          const { date, hm } = localNow(env);
          fired = JSON.stringify(Object.fromEntries(times.filter(t => t <= hm).map(t => [t, date])));
        }
        await db.prepare('UPDATE routines SET name=?,prompt=?,times=?,enabled=?,fired=? WHERE id=?')
          .bind(name, body.prompt === undefined ? r.prompt : clean(body.prompt, 2000), JSON.stringify(times), enabled, fired, id).run();
        return J({ ok: true });
      }
      if (m === 'DELETE') { await db.prepare('DELETE FROM routines WHERE id=?').bind(id).run(); return J({ ok: true }); }
    }

    if (path === 'messages' && m === 'POST') {
      const conv = clean(body.conv, 64), text = clean(body.text, 4000);
      if (!text) return err('訊息是空的');
      const { bots, groups } = await loadAll(db, U);
      const bot = bots.find(b => b.id === conv), group = groups.find(g => g.id === conv);
      if (!bot && !group) return err('找不到對話', 404);
      await addMsg(db, U, conv, 'me', text);
      let chain;
      if (bot) chain = [bot.id];
      else {
        const named = group.members.filter(id => { const b = bots.find(x => x.id === id); return b && text.includes('@' + b.name); });
        chain = named.length ? named : group.members;
      }
      await addJob(db, U, conv, chain, text);
      return J({ ok: true });
    }
    if (path.startsWith('shot/') && m === 'GET') {
      const s = await db.prepare('SELECT mime,data,ts FROM shots WHERE bot_id=? AND user_id=?').bind(path.slice(5), U).first();
      return J(s || {});
    }
    if (path === 'open' && m === 'POST') {
      const { bots, groups } = await loadAll(db, U);
      const bot = bots.find(b => b.id === body.bot);
      const conv = clean(body.conv, 64);
      if (!bot || !(conv === bot.id || groups.some(g => g.id === conv))) return err('找不到機器人', 404);
      let url = clean(body.url, 500);
      if (url && !/^https?:\/\//.test(url)) url = 'https://' + url;
      await addMsg(db, U, conv, 'sys', `請電腦開啟「${bot.name}」的瀏覽器${url ? '：' + url : ''}`);
      await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,?,?,'[]','',?,'open',?)").bind(U, conv, bot.id, now(), url || null).run();
      return J({ ok: true });
    }
    if (path === 'cancel' && m === 'POST') {
      const conv = clean(body.conv, 64);
      await db.prepare("DELETE FROM jobs WHERE user_id=? AND conv=? AND status='pending'").bind(U, conv).run();
      await db.prepare("UPDATE jobs SET status='error' WHERE user_id=? AND conv=? AND status='running'").bind(U, conv).run();
      await addMsg(db, U, conv, 'sys', '已停止目前的任務');
      return J({ ok: true });
    }
    if (path === 'runner-token' && m === 'POST') {
      await db.prepare("DELETE FROM sessions WHERE user_id=? AND kind='runner'").bind(U).run();
      return J({ token: await newSession(db, U, 'runner', 'runner') });
    }
    return err('找不到這個 API', 404);
  } catch (e) {
    return err('伺服器錯誤：' + (e.message || e), 500);
  }
}
