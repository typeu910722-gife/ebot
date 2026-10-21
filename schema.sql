-- E·BOT schema (Cloudflare D1)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  pw TEXT NOT NULL,              -- pbkdf2$iter$salt$hash
  created INTEGER NOT NULL,
  runner_seen INTEGER DEFAULT 0,
  settings TEXT                  -- JSON: notes, notifyAll, tg{token,chat}, line{token,to}
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,        -- sha256 of token
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'web' | 'runner'
  label TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS folders (   -- 分區: bots in the same folder can ask each other
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT,                    -- 分區資料: shared facts every bot in the folder reads
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  task TEXT NOT NULL,
  folder TEXT,
  created INTEGER NOT NULL,
  shot_ts INTEGER,
  page TEXT                      -- last page the bot reported
);
CREATE TABLE IF NOT EXISTS groups_ (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  task TEXT NOT NULL,
  members TEXT NOT NULL,         -- JSON array of bot ids, in order
  folder TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS routines (  -- 例行任務
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conv TEXT NOT NULL,            -- bot id or group id
  name TEXT NOT NULL,
  prompt TEXT,
  times TEXT NOT NULL,           -- JSON ["06:10","12:10"] local time
  enabled INTEGER NOT NULL DEFAULT 1,
  fired TEXT,                    -- JSON {"06:10":"2026-10-21"}
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  conv TEXT NOT NULL,
  by_ TEXT NOT NULL,             -- 'me' | 'sys' | bot id
  text TEXT NOT NULL,
  files TEXT,                    -- JSON [{id,name,mime}]
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS msg_user ON messages(user_id, id);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  conv TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT '[]', -- steps to run after this one: [{b, p}]
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | error
  created INTEGER NOT NULL,
  started INTEGER,
  kind TEXT NOT NULL DEFAULT 'chat', -- chat | open (open the bot's browser for manual login)
  url TEXT,
  depth INTEGER NOT NULL DEFAULT 0, -- bot-to-bot question hops
  finished INTEGER
);
CREATE INDEX IF NOT EXISTS job_user ON jobs(user_id, status, id);
CREATE TABLE IF NOT EXISTS shots (   -- latest browser screenshot per bot
  bot_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,            -- base64
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (   -- chat attachments
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,            -- base64
  ts INTEGER NOT NULL
);
