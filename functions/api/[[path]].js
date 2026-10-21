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
const validTime = s => (s && /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null);
const localNow = env => {
  const d = new Date(now() + (+env.TZ_OFFSET_MIN || 0) * 60000);
  return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) };
};

async function addMsg(db, userId, conv, by, text) {
  await db.prepare('INSERT INTO messages (user_id,conv,by_,text,ts) VALUES (?,?,?,?,?)').bind(userId, conv, by, text, now()).run();
}
async function addJob(db, userId, conv, chain, prompt) {
  if (!chain.length) return;
  await db.prepare('INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created) VALUES (?,?,?,?,?,?)')
    .bind(userId, conv, chain[0], JSON.stringify(chain.slice(1)), prompt, now()).run();
}
async function loadAll(db, userId) {
  const bots = (await db.prepare('SELECT id,name,task,schedule FROM bots WHERE user_id=? ORDER BY created').bind(userId).all()).results;
  const groups = (await db.prepare('SELECT id,name,task,members,schedule FROM groups_ WHERE user_id=? ORDER BY created').bind(userId).all()).results
    .map(g => ({ ...g, members: JSON.parse(g.members) }));
  return { bots, groups };
}

// Templates offered in the app
const TEMPLATES = {
  assistant: {
    bots: [{ k: 'a', name: '助理', task: '回答我的問題，必要時用瀏覽器查資料或操作我已登入的網站，做完回報重點。' }],
    groups: []
  },
  guesthouse: {
    bots: [
      { k: 'b1', name: '訂房員', task: '開 Booking.com 合作夥伴後台（已登入），抓今天與明天的入住、退房訂單：房號、客人姓名、晚數，整理成清單交給群組。' },
      { k: 'b2', name: '暱稱員', task: '開 LINE 官方帳號後台（已登入），讀各旅館聊天列表的客人暱稱，依「名字 M/D」「M/D-D」「補助」規則整理今天的入住與續住。' },
      { k: 'b3', name: '房務員', task: '整合群組裡訂房員與暱稱員的資料，算出今天要掃的房間，更新到 E·ROOM（eroom.yzprojecttw.com）。' },
      { k: 'b4', name: '記帳員', task: '把群組裡今天的訂房資料寫進我的 Google 訂房紀錄試算表，重複的不寫。' },
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
        // due schedules
        const { date, hm } = localNow(env);
        for (const b of (await db.prepare("SELECT id,name FROM bots WHERE user_id=? AND schedule IS NOT NULL AND schedule<=? AND IFNULL(last_run,'')<>?").bind(U, hm, date).all()).results) {
          await db.prepare('UPDATE bots SET last_run=? WHERE id=?').bind(date, b.id).run();
          await addMsg(db, U, b.id, 'sys', `${hm} 排程啟動`);
          await addJob(db, U, b.id, [b.id], '（排程觸發）請執行你的指定任務，完成後回報結果。');
        }
        for (const g of (await db.prepare("SELECT id,members FROM groups_ WHERE user_id=? AND schedule IS NOT NULL AND schedule<=? AND IFNULL(last_run,'')<>?").bind(U, hm, date).all()).results) {
          await db.prepare('UPDATE groups_ SET last_run=? WHERE id=?').bind(date, g.id).run();
          await addMsg(db, U, g.id, 'sys', `${hm} 排程啟動`);
          await addJob(db, U, g.id, JSON.parse(g.members), '（排程觸發）請依群組協作規則執行你負責的部分，完成後回報結果。');
        }
        // stale running jobs (> 20 min) become errors
        const stale = (await db.prepare("SELECT id,conv,bot_id FROM jobs WHERE user_id=? AND status='running' AND started<?").bind(U, now() - 20 * 60000).all()).results;
        for (const s of stale) {
          await db.prepare("UPDATE jobs SET status='error' WHERE id=?").bind(s.id).run();
          await addMsg(db, U, s.conv, s.bot_id, '⚠ 執行逾時，已中止。');
        }
        const job = await db.prepare("SELECT * FROM jobs WHERE user_id=? AND status='pending' ORDER BY id LIMIT 1").bind(U).first();
        if (!job) return J({ job: null });
        const claimed = await db.prepare("UPDATE jobs SET status='running', started=? WHERE id=? AND status='pending'").bind(now(), job.id).run();
        if (!claimed.meta.changes) return J({ job: null });
        const { bots, groups } = await loadAll(db, U);
        const name = id => id === 'me' ? '使用者' : id === 'sys' ? '系統' : (bots.find(b => b.id === id)?.name || '已刪除的機器人');
        const bot = bots.find(b => b.id === job.bot_id);
        if (!bot) { await db.prepare("UPDATE jobs SET status='error' WHERE id=?").bind(job.id).run(); return J({ job: null }); }
        const group = groups.find(g => g.id === job.conv);
        const hist = (await db.prepare('SELECT by_,text FROM messages WHERE user_id=? AND conv=? ORDER BY id DESC LIMIT 30').bind(U, job.conv).all()).results.reverse();
        return J({
          job: {
            id: job.id, prompt: job.prompt,
            bot: { name: bot.name, task: bot.task },
            group: group ? { name: group.name, task: group.task, members: group.members.map(name) } : null,
            history: hist.map(h => ({ who: name(h.by_), text: h.text }))
          }
        });
      }
      if (path === 'runner/done' && m === 'POST') {
        const job = await db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND status='running'").bind(+body.id, U).first();
        if (!job) return err('找不到執行中的任務', 404);
        const ok = body.ok !== false;
        await db.prepare('UPDATE jobs SET status=? WHERE id=?').bind(ok ? 'done' : 'error', job.id).run();
        await addMsg(db, U, job.conv, job.bot_id, clean(body.text, 20000) || (ok ? '（完成，無回覆內容）' : '⚠ 執行失敗'));
        if (ok) await addJob(db, U, job.conv, JSON.parse(job.chain), job.prompt);
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
      const { bots, groups } = await loadAll(db, U);
      const msgs = (await db.prepare(after
        ? 'SELECT id,conv,by_ AS by,text,ts FROM messages WHERE user_id=? AND id>? ORDER BY id LIMIT 500'
        : 'SELECT * FROM (SELECT id,conv,by_ AS by,text,ts FROM messages WHERE user_id=? AND ?=0 ORDER BY id DESC LIMIT 500) ORDER BY id')
        .bind(U, after).all()).results;
      const busy = (await db.prepare("SELECT conv,bot_id,status FROM jobs WHERE user_id=? AND status IN ('pending','running')").bind(U).all()).results;
      const u = await db.prepare('SELECT runner_seen FROM users WHERE id=?').bind(U).first();
      return J({ me: me.name, runnerOnline: now() - (u.runner_seen || 0) < 60000, bots, groups, msgs, busy });
    }
    if (path === 'template' && m === 'POST') {
      const t = TEMPLATES[body.name];
      if (!t) return err('沒有這個範本');
      const map = {};
      for (const b of t.bots) {
        map[b.k] = uid();
        await db.prepare('INSERT INTO bots (id,user_id,name,task,created) VALUES (?,?,?,?,?)').bind(map[b.k], U, b.name, b.task, now()).run();
      }
      for (const g of t.groups)
        await db.prepare('INSERT INTO groups_ (id,user_id,name,task,members,created) VALUES (?,?,?,?,?,?)')
          .bind('g-' + uid(), U, g.name, g.task, JSON.stringify(g.members.map(k => map[k])), now() + 1).run();
      return J({ ok: true });
    }
    if (path === 'bots' && m === 'POST') {
      const name = clean(body.name, 20), task = clean(body.task, 4000);
      if (!name || !task) return err('名稱和任務都要填');
      const id = uid();
      await db.prepare('INSERT INTO bots (id,user_id,name,task,schedule,created) VALUES (?,?,?,?,?,?)').bind(id, U, name, task, validTime(body.schedule), now()).run();
      await addMsg(db, U, id, 'sys', '機器人已建立');
      return J({ id });
    }
    if (path.startsWith('bots/')) {
      const id = path.slice(5);
      if (m === 'PUT') {
        const name = clean(body.name, 20), task = clean(body.task, 4000);
        if (!name || !task) return err('名稱和任務都要填');
        await db.prepare('UPDATE bots SET name=?,task=?,schedule=? WHERE id=? AND user_id=?').bind(name, task, validTime(body.schedule), id, U).run();
        return J({ ok: true });
      }
      if (m === 'DELETE') {
        await db.batch([
          db.prepare('DELETE FROM bots WHERE id=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare("DELETE FROM jobs WHERE bot_id=? AND user_id=? AND status='pending'").bind(id, U)
        ]);
        return J({ ok: true });
      }
    }
    if (path === 'groups' && m === 'POST') {
      const name = clean(body.name, 20), task = clean(body.task, 4000);
      const { bots } = await loadAll(db, U);
      const members = (Array.isArray(body.members) ? body.members : []).filter(x => bots.some(b => b.id === x));
      if (!name || !task || !members.length) return err('名稱、成員、協作規則都要填');
      const id = 'g-' + uid();
      await db.prepare('INSERT INTO groups_ (id,user_id,name,task,members,schedule,created) VALUES (?,?,?,?,?,?,?)').bind(id, U, name, task, JSON.stringify(members), validTime(body.schedule), now()).run();
      await addMsg(db, U, id, 'sys', '群組已建立');
      return J({ id });
    }
    if (path.startsWith('groups/')) {
      const id = path.slice(7);
      if (m === 'PUT') {
        const name = clean(body.name, 20), task = clean(body.task, 4000);
        const { bots } = await loadAll(db, U);
        const members = (Array.isArray(body.members) ? body.members : []).filter(x => bots.some(b => b.id === x));
        if (!name || !task || !members.length) return err('名稱、成員、協作規則都要填');
        await db.prepare('UPDATE groups_ SET name=?,task=?,members=?,schedule=? WHERE id=? AND user_id=?').bind(name, task, JSON.stringify(members), validTime(body.schedule), id, U).run();
        return J({ ok: true });
      }
      if (m === 'DELETE') {
        await db.batch([
          db.prepare('DELETE FROM groups_ WHERE id=? AND user_id=?').bind(id, U),
          db.prepare('DELETE FROM messages WHERE conv=? AND user_id=?').bind(id, U),
          db.prepare("DELETE FROM jobs WHERE conv=? AND user_id=? AND status='pending'").bind(id, U)
        ]);
        return J({ ok: true });
      }
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
    if (path === 'cancel' && m === 'POST') {
      await db.prepare("DELETE FROM jobs WHERE user_id=? AND conv=? AND status='pending'").bind(U, clean(body.conv, 64)).run();
      await db.prepare("UPDATE jobs SET status='error' WHERE user_id=? AND conv=? AND status='running'").bind(U, clean(body.conv, 64)).run();
      await addMsg(db, U, clean(body.conv, 64), 'sys', '已停止目前的任務');
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
