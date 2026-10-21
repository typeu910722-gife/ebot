// OCTA API — Cloudflare Pages Function, single router.
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
    db.prepare('SELECT id,name,task,folder,engine,model,avatar,browser,shot_ts,page FROM bots WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,name,task,members,folder FROM groups_ WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,name,notes FROM folders WHERE user_id=? ORDER BY created').bind(userId),
    db.prepare('SELECT id,conv,name,prompt,times,enabled FROM routines WHERE user_id=? ORDER BY created').bind(userId)
  ]);
  return {
    bots: b.results,
    groups: g.results.map(x => ({ ...x, members: JSON.parse(x.members) })),
    folders: f.results,
    routines: r.results.map(x => ({ ...x, times: JSON.parse(x.times), enabled: !!x.enabled }))
  };
}
async function getSettings(db, userId) {
  const u = await db.prepare('SELECT settings FROM users WHERE id=?').bind(userId).first();
  try { return JSON.parse(u?.settings || '{}'); } catch { return {}; }
}
const mask = t => (t ? '••••' + String(t).slice(-4) : '');
async function sendNotify(env, st, text) {
  const out = [];
  if (env.onNotify) { try { env.onNotify(text); out.push('桌面'); } catch { } }
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
const ENGINES = ['claude', 'codex', 'gemini', 'copilot', 'cursor', 'qwen', 'opencode'];
const engineOk = e => (ENGINES.includes(e) ? e : 'claude');
const avatarOk = a => { const v = clean(a, 16); return v && !/[<>&"']/.test(v) ? v : null; };
const TEMPLATE_AVATARS = { a: '🤖', r1: '🔎', r2: '📝', s1: '🧾', s2: '💬', s3: '📊', l1: '🛎️', l2: '🧹', l3: '👋' };
const folderOk = (folders, id) => (id && folders.some(f => f.id === id) ? id : null);

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
    if (path === 'config' && m === 'GET') return J({ signup: env.ALLOW_SIGNUP === 'true', local: !!env.isLocal, pair: !!env.pairCheck, download: env.DOWNLOAD_URL || '', repo: env.REPO_URL || '' });
    if (path === 'pair' && m === 'POST') {   // desktop app: phone pairs with a code instead of an account
      if (!env.pairCheck) return err('這個版本不使用配對碼', 404);
      if (!env.pairCheck(String(body.code || ''))) return err('配對碼錯誤或已失效', 401);
      return J({ token: await newSession(db, 'local', 'web', 'phone') });
    }

    const me = env.isLocal ? { user_id: 'local', kind: 'local', name: '本機' } : await auth(req, db);
    if (!me) return err('請先登入', 401);
    const U = me.user_id;

    if (path.startsWith('file/') && m === 'GET') {
      const f = await db.prepare('SELECT name,mime,data FROM files WHERE id=? AND user_id=?').bind(path.slice(5), U).first();
      return f ? J(f) : err('找不到檔案', 404);
    }

    // ---------- runner ----------
    if (path.startsWith('runner/')) {
      if (me.kind !== 'runner' && me.kind !== 'local') return err('需要執行器金鑰', 403);
      await db.prepare('UPDATE users SET runner_seen=? WHERE id=?').bind(now(), U).run();
      if (body.engines && typeof body.engines === 'object')
        await db.prepare('UPDATE users SET engines=? WHERE id=?').bind(JSON.stringify(Object.fromEntries(ENGINES.map(k => [k, !!body.engines[k]]))), U).run();

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
        if (job.kind === 'test') return J({ job: { id: job.id, kind: 'test', engine: engineOk(job.url), prompt: job.prompt } });
        const { bots, groups, folders } = all;
        const name = id => id === 'me' ? '使用者' : id === 'sys' ? '系統' : (bots.find(b => b.id === id)?.name || '已刪除的機器人');
        const bot = bots.find(b => b.id === job.bot_id);
        if (!bot) { await db.prepare("UPDATE jobs SET status='error' WHERE id=?").bind(job.id).run(); return J({ job: null }); }
        const group = groups.find(g => g.id === job.conv);
        const hist = (await db.prepare('SELECT by_,text,files FROM messages WHERE user_id=? AND conv=? ORDER BY id DESC LIMIT 30').bind(U, job.conv).all()).results.reverse();
        const st = await getSettings(db, U);
        return J({
          job: {
            id: job.id, kind: job.kind, url: job.url, prompt: job.prompt,
            canAsk: job.depth < MAX_ASK_DEPTH,
            bot: { id: bot.id, name: bot.name, task: bot.task, page: bot.page, engine: bot.engine || 'claude', model: bot.model || '', browser: bot.browser === 'mine' ? 'mine' : 'own' },
            folder: folders.find(f => f.id === bot.folder)?.name || null,
            folderNotes: folders.find(f => f.id === bot.folder)?.notes || '',
            notes: st.notes || '',
            lang: st.lang || 'zh-TW',
            colleagues: bots.filter(b => b.id !== bot.id && (b.folder || null) === (bot.folder || null)).map(b => ({ name: b.name, task: b.task })),
            group: group ? { name: group.name, task: group.task, members: group.members.map(name) } : null,
            history: hist.map(h => ({ who: name(h.by_), text: h.text, files: h.files ? JSON.parse(h.files) : [] }))
          }
        });
      }
      if (path === 'runner/done' && m === 'POST') {
        const job = await db.prepare("SELECT * FROM jobs WHERE id=? AND user_id=? AND status='running'").bind(+body.id, U).first();
        if (!job) return err('找不到執行中的任務', 404);
        const ok = body.ok !== false;
        if (job.kind === 'test') {
          await db.prepare('UPDATE jobs SET status=?, finished=?, result=? WHERE id=?').bind(ok ? 'done' : 'error', now(), clean(body.text, 3000), job.id).run();
          return J({ ok: true });
        }
        const text = clean(body.text, 20000) || (ok ? '（完成，無回覆內容）' : '⚠ 執行失敗');
        await db.prepare('UPDATE jobs SET status=?, finished=? WHERE id=?').bind(ok ? 'done' : 'error', now(), job.id).run();
        await addMsg(db, U, job.conv, job.bot_id, text);
        if (job.kind === 'chat') {
          const st = await getSettings(db, U);
          const who = (await db.prepare('SELECT name FROM bots WHERE id=?').bind(job.bot_id).first())?.name || '機器人';
          if (!ok || needsYou(text)) await sendNotify(env, st, `【OCTA】${who} 需要你處理：\n${text.slice(0, 600)}`);
          else if (st.notifyAll && !JSON.parse(job.chain).length) await sendNotify(env, st, `【OCTA】${who} 完成：\n${text.slice(0, 600)}`);
        }
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
      const h = req.headers.get('authorization');
      if (h) await db.prepare('DELETE FROM sessions WHERE token=?').bind(await sha(h.slice(7))).run();
      return J({ ok: true });
    }
    if (path === 'state' && m === 'GET') {
      const after = +new URL(req.url).searchParams.get('after') || 0;
      const all = await loadAll(db, U);
      const msgs = (await db.prepare(after
        ? 'SELECT id,conv,by_ AS by,text,files,ts FROM messages WHERE user_id=? AND id>? ORDER BY id LIMIT 500'
        : 'SELECT * FROM (SELECT id,conv,by_ AS by,text,files,ts FROM messages WHERE user_id=? AND ?=0 ORDER BY id DESC LIMIT 500) ORDER BY id')
        .bind(U, after).all()).results.map(x => ({ ...x, files: x.files ? JSON.parse(x.files) : [] }));
      const busy = (await db.prepare("SELECT conv,bot_id,status,kind FROM jobs WHERE user_id=? AND kind<>'test' AND status IN ('pending','running')").bind(U).all()).results;
      const u = await db.prepare('SELECT runner_seen, engines FROM users WHERE id=?').bind(U).first();
      return J({ me: me.name, local: me.kind === 'local', engines: u?.engines ? JSON.parse(u.engines) : null, runnerOnline: env.runnerOnline ? env.runnerOnline() : now() - (u?.runner_seen || 0) < 60000, ...all, msgs, busy });
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
      return J({ ok: true });
    }

    // folders (分區)
    if (path === 'folders' && m === 'POST') {
      const name = clean(body.name, 20);
      if (!name) return err('分區名稱要填');
      const id = 'f-' + uid();
      await db.prepare('INSERT INTO folders (id,user_id,name,notes,created) VALUES (?,?,?,?,?)').bind(id, U, name, clean(body.notes, 20000), now()).run();
      return J({ id });
    }
    if (path.startsWith('folders/')) {
      const id = path.slice(8);
      if (m === 'PUT') {
        const name = clean(body.name, 20);
        if (!name) return err('分區名稱要填');
        await db.prepare('UPDATE folders SET name=?, notes=? WHERE id=? AND user_id=?').bind(name, clean(body.notes, 20000), id, U).run();
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
      await db.prepare('INSERT INTO bots (id,user_id,name,task,folder,engine,model,avatar,browser,created) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id, U, name, task, folderOk(folders, body.folder), engineOk(body.engine), clean(body.model, 80) || null, avatarOk(body.avatar), body.browser === 'mine' ? 'mine' : null, now()).run();
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
        await db.prepare('UPDATE bots SET name=?,task=?,folder=?,engine=?,model=?,avatar=?,browser=? WHERE id=? AND user_id=?').bind(name, task, folderOk(folders, body.folder), engineOk(body.engine), clean(body.model, 80) || null, avatarOk(body.avatar), body.browser === 'mine' ? 'mine' : null, id, U).run();
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
      if (!text && !(body.files || []).length) return err('訊息是空的');
      const { bots, groups } = await loadAll(db, U);
      const bot = bots.find(b => b.id === conv), group = groups.find(g => g.id === conv);
      if (!bot && !group) return err('找不到對話', 404);
      const fileIds = (Array.isArray(body.files) ? body.files : []).slice(0, 6).map(x => clean(x, 64));
      const files = fileIds.length ? (await db.prepare(`SELECT id,name,mime FROM files WHERE user_id=? AND id IN (${fileIds.map(() => '?').join(',')})`).bind(U, ...fileIds).all()).results : [];
      await db.prepare('INSERT INTO messages (user_id,conv,by_,text,files,ts) VALUES (?,?,?,?,?,?)').bind(U, conv, 'me', text || '（附件）', files.length ? JSON.stringify(files) : null, now()).run();
      let chain;
      if (bot) chain = [bot.id];
      else {
        const named = group.members.filter(id => { const b = bots.find(x => x.id === id); return b && text.includes('@' + b.name); });
        chain = named.length ? named : group.members;
      }
      await addJob(db, U, conv, chain, text || '請處理我傳的附件。');
      return J({ ok: true });
    }
    if (path === 'engine-test' && m === 'POST') {
      const engine = engineOk(body.engine);
      const r = await db.prepare("INSERT INTO jobs (user_id,conv,bot_id,chain,prompt,created,kind,url) VALUES (?,'__test',?,'[]',?,?,'test',?)")
        .bind(U, 'test:' + engine, '這是 OCTA 的連線測試，請只回覆兩個字：OK', now(), engine).run();
      return J({ id: r.meta.last_row_id });
    }
    if (path.startsWith('job/') && m === 'GET') {
      const j = await db.prepare('SELECT status,result FROM jobs WHERE id=? AND user_id=?').bind(+path.slice(4), U).first();
      return j ? J(j) : err('找不到', 404);
    }
    if (path === 'files' && m === 'POST') {
      const data = String(body.data || ''), name = clean(body.name, 120) || '檔案', mime = clean(body.mime, 100) || 'application/octet-stream';
      if (!data || data.length > 1_400_000) return err('檔案太大（上限約 1MB）');
      const id = 'file-' + uid();
      await db.prepare('INSERT INTO files (id,user_id,name,mime,data,ts) VALUES (?,?,?,?,?,?)').bind(id, U, name, mime, data, now()).run();
      return J({ id, name, mime });
    }
    if (path === 'settings' && m === 'GET') {
      const st = await getSettings(db, U);
      return J({ notes: st.notes || '', notifyAll: !!st.notifyAll, tg: { token: mask(st.tg?.token), chat: st.tg?.chat || '' }, line: { token: mask(st.line?.token), to: st.line?.to || '' } });
    }
    if (path === 'settings' && m === 'PUT') {
      const st = await getSettings(db, U);
      if (body.notes !== undefined) st.notes = clean(body.notes, 20000);
      if (body.notifyAll !== undefined) st.notifyAll = !!body.notifyAll;
      if (['zh-TW', 'zh-CN', 'en', 'ja'].includes(body.lang)) st.lang = body.lang;
      for (const k of ['tg', 'line']) if (body[k]) {
        const cur = st[k] || {};
        const tok = clean(body[k].token, 300);
        if (tok && !tok.startsWith('••••')) cur.token = tok;
        if (body[k].token === '') delete cur.token;
        const dest = clean(body[k][k === 'tg' ? 'chat' : 'to'], 100);
        cur[k === 'tg' ? 'chat' : 'to'] = dest;
        st[k] = cur;
      }
      await db.prepare('UPDATE users SET settings=? WHERE id=?').bind(JSON.stringify(st), U).run();
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
      await db.prepare('UPDATE users SET settings=? WHERE id=?').bind(JSON.stringify(st), U).run();
      return J({ chat: String(chat) });
    }
    if (path === 'logs' && m === 'GET') {
      const { bots, groups } = await loadAll(db, U);
      const rows = (await db.prepare("SELECT id,conv,bot_id,prompt,status,kind,url,created,started,finished FROM jobs WHERE user_id=? ORDER BY id DESC LIMIT 100").bind(U).all()).results;
      return J({ logs: rows.map(r => ({ ...r, bot: r.kind === 'test' ? 'AI 連線測試：' + r.url : bots.find(b => b.id === r.bot_id)?.name || '已刪除', convName: (bots.find(b => b.id === r.conv) || groups.find(g => g.id === r.conv))?.name || '', prompt: r.prompt.slice(0, 80) })) });
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
      // don't stack duplicates if the button is pressed again before the computer picks it up
      if (await db.prepare("SELECT 1 FROM jobs WHERE user_id=? AND bot_id=? AND kind='open' AND status='pending'").bind(U, bot.id).first()) return J({ ok: true, queued: true });
      await addMsg(db, U, conv, 'sys', `請電腦開啟「${bot.name}」的瀏覽器${url ? '：' + url : '（上次的畫面）'}`);
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
      // each computer keeps its own key; making a new one only replaces the key with the same label
      const label = clean(body.label, 60) || 'runner';
      await db.prepare("DELETE FROM sessions WHERE user_id=? AND kind='runner' AND IFNULL(label,'runner')=?").bind(U, label).run();
      return J({ token: await newSession(db, U, 'runner', label) });
    }
    return err('找不到這個 API', 404);
  } catch (e) {
    return err('伺服器錯誤：' + (e.message || e), 500);
  }
}
