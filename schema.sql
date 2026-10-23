-- OCTA schema (Cloudflare D1)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  pw TEXT NOT NULL,              -- pbkdf2$iter$salt$hash
  created INTEGER NOT NULL,
  runner_seen INTEGER DEFAULT 0,
  settings TEXT,                 -- JSON: notes, notifyAll, tg{token,chat}, line{token,to}
  engines TEXT,                  -- JSON: which AI CLIs the host computer found installed
  host TEXT,                     -- label of the runner session that does the work (主機)
  rev INTEGER NOT NULL DEFAULT 0,-- bumped on every change; clients long-poll it (/api/wait)
  reset TEXT                     -- JSON {h: sha256(code), exp} password reset code
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,        -- sha256 of token
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'web' | 'runner'
  label TEXT,
  created INTEGER NOT NULL,
  seen INTEGER,                  -- last activity (written at most every few minutes)
  ua TEXT,                       -- device description for the device list
  ip TEXT,
  place TEXT,                    -- city / country from Cloudflare
  info TEXT                      -- runner: JSON {engines, version, store}
);
CREATE INDEX IF NOT EXISTS ses_user ON sessions(user_id, kind);
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
  engine TEXT NOT NULL DEFAULT 'claude', -- claude | codex | gemini | copilot | cursor | qwen | opencode
  model TEXT,                    -- optional model name for the engine
  avatar TEXT,                   -- optional emoji shown instead of the first letter
  browser TEXT,                  -- null: own Chrome profile; 'mine': the user's Chrome via the Playwright Extension
  created INTEGER NOT NULL,
  shot_ts INTEGER,
  page TEXT,                     -- last page the bot reported
  shot_file TEXT,               -- files.id of the last screenshot (kept on the host computer)
  bpc TEXT,                      -- the computer that has its browser (logins)
  fb TEXT                        -- backup AIs: JSON ["engine|model", …], used in order when the AI runs out of quota
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
  created INTEGER NOT NULL,
  hook TEXT,                     -- secret key: POST /api/hook/<key> starts the routine (LINE webhook, forms…)
  watch TEXT,                    -- JSON {url, sel, every}: start when this page changes
  wstate TEXT                    -- JSON {hash, text, t}: last look at the watched page
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
CREATE INDEX IF NOT EXISTS msg_conv ON messages(user_id, conv, id);
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
  kind TEXT NOT NULL DEFAULT 'chat', -- chat | open (open the bot's browser for manual login) | test
  url TEXT,
  depth INTEGER NOT NULL DEFAULT 0, -- bot-to-bot question hops
  finished INTEGER,
  result TEXT,                   -- for kind='test' (AI connection test)
  progress TEXT,                 -- what the bot is doing right now (shown while it works)
  tokens INTEGER,                -- tokens the run used (when the AI reports it)
  pc TEXT,                       -- only this computer may take it (handing logins over)
  eng TEXT                       -- "engine|model" a backup AI runs this job with
);
CREATE INDEX IF NOT EXISTS job_user ON jobs(user_id, status, id);
CREATE TABLE IF NOT EXISTS shots (   -- latest browser screenshot per bot
  bot_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,            -- base64
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (   -- attachments, screenshots, bot outputs
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,            -- legacy base64 ('' for new files: content is in chunks or on the host computer)
  ts INTEGER NOT NULL,
  conv TEXT,                     -- conversation it belongs to
  loc TEXT,                      -- 'cloud' (waiting for the host computer) | 'pc' (saved on the host computer)
  path TEXT,                     -- path inside the computer's OCTA file folder
  size INTEGER,
  want INTEGER,                  -- someone asked to see it: the computer that has it uploads a temporary copy
  pc TEXT                        -- which computer has it (runner label)
);
CREATE TABLE IF NOT EXISTS chunks (  -- file content in pieces of up to ~1 MB (temporary)
  file_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  data TEXT NOT NULL,            -- base64
  ts INTEGER NOT NULL,
  PRIMARY KEY (file_id, n)
);
CREATE TABLE IF NOT EXISTS logins (  -- failed sign-in / reset attempts, for rate limiting
  k TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  until INTEGER NOT NULL
);
