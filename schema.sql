-- E·BOT schema (Cloudflare D1)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  pw TEXT NOT NULL,              -- pbkdf2$iter$salt$hash
  created INTEGER NOT NULL,
  runner_seen INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,        -- sha256 of token
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'web' | 'runner'
  label TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  task TEXT NOT NULL,
  schedule TEXT,                 -- 'HH:MM' local time, optional
  last_run TEXT,                 -- 'YYYY-MM-DD'
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups_ (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  task TEXT NOT NULL,
  members TEXT NOT NULL,         -- JSON array of bot ids, in order
  schedule TEXT,
  last_run TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  conv TEXT NOT NULL,            -- bot id or group id
  by_ TEXT NOT NULL,             -- 'me' | 'sys' | bot id
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS msg_user ON messages(user_id, id);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  conv TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT '[]', -- bot ids to run after this one
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | error
  created INTEGER NOT NULL,
  started INTEGER
);
CREATE INDEX IF NOT EXISTS job_user ON jobs(user_id, status, id);
