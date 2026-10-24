// Server-side policy for OCTA coding tasks.
// Model text, tool arguments, and repo content cannot change these rules.

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

export const DEFAULT_MAX_REPAIRS = 3;
export const LIMITS = {
  maxContextChars: 24_000,
  maxRepairs: DEFAULT_MAX_REPAIRS,
  commandTimeoutMs: 120_000,
  maxOutputChars: 12_000,
  maxDiffChars: 60_000,
  maxConcurrentWritersPerWorktree: 1
};

export class PolicyError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'PolicyError';
    this.code = extra.code || 'POLICY';
    this.needsApproval = extra.needsApproval || null;
    this.audit = extra.audit !== false;
  }
}

const SECRET_FILE = /(^|[\\/])(\.env($|\.)|.*\.(pem|key|p12|pfx)$|id_rsa|id_ed25519|credentials\.json|\.npmrc|\.netrc)$/i;
const SECRET_LINE = /((?:api[_-]?key|token|password|secret|authorization|credential)\s*[:=]\s*)(\S+)/gi;

export function redact(text, max = LIMITS.maxOutputChars) {
  return String(text ?? '')
    .replace(SECRET_LINE, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9]{8,}\b/g, '[redacted]')
    .slice(0, max);
}

export function isSecretPath(p) {
  return SECRET_FILE.test(String(p || '').replace(/\\/g, '/'));
}

function insideRoot(rootReal, candidate) {
  const rel = relative(rootReal, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Resolve target against the workspace and reject escapes, including symlinks.
export function resolveInside(root, target) {
  if (!root) throw new PolicyError('沒有工作區');
  const rootReal = realpathSync(root);
  const raw = String(target ?? '');
  if (!raw || raw.includes('\0')) throw new PolicyError('路徑不正確');
  const abs = resolve(rootReal, raw);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    let parentReal;
    try { parentReal = realpathSync(parent); } catch { throw new PolicyError('路徑超出授權工作區'); }
    if (!insideRoot(rootReal, parentReal)) throw new PolicyError('路徑超出授權工作區');
    real = resolve(parentReal, basename(abs));
  }
  if (!insideRoot(rootReal, real)) throw new PolicyError('路徑超出授權工作區');
  if (isSecretPath(relative(rootReal, real)) || isSecretPath(basename(real))) throw new PolicyError('拒絕讀寫密鑰或環境檔');
  return real;
}

export function assertionScore(src) {
  const s = String(src || '');
  const hits = s.match(/\bassert(?:\.strictEqual|\.deepEqual|\.equal|\.ok|\.fail)?\s*\(|\bexpect\s*\(|\b(?:it|test|describe)\s*\(/g);
  return hits ? hits.length : 0;
}

const TEST_FILE = /(^|[\\/])(test|tests|__tests__|spec)([\\/]|$)|[\\/][^\\/]*\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])(test|spec)\.[cm]?[jt]sx?$/i;
export function isTestFile(relPath) {
  return TEST_FILE.test(String(relPath || '').replace(/\\/g, '/'));
}

const WEAK_SNIPPET = /\bprocess\.exit\s*\(\s*0\s*\)|\b(?:it|test|describe)\.skip\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\b(?:it|test)\.only\s*\(/;

function scriptDisablesTests(before, after) {
  const b = String(before || ''), a = String(after || '');
  if (a === b) return false;
  if (/^(?:true|exit 0|:|node -e ["']process\.exit\(0\)["'])$/i.test(a.trim())) return true;
  if (/\b(?:exit 0|process\.exit\(\s*0\s*\)|--passWithNoTests)\b/.test(a) && !/\b(?:exit 0|process\.exit\(\s*0\s*\)|--passWithNoTests)\b/.test(b)) return true;
  return false;
}

// Refuse deletes, weaker assertions, and test scripts rewritten to pass without checking.
export function evaluateWrite(root, relPath, content, previous) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel || rel.split('/').includes('..')) throw new PolicyError('路徑不正確');
  const abs = resolveInside(root, rel);
  if (content == null) throw new PolicyError('拒絕刪除檔案');
  const next = String(content);
  if (isTestFile(rel)) {
    if (!next.trim()) throw new PolicyError('拒絕刪除測試', { code: 'SAFETY' });
    if (previous != null && assertionScore(next) < assertionScore(previous)) throw new PolicyError('拒絕削弱測試斷言', { code: 'SAFETY' });
    if (WEAK_SNIPPET.test(next) && !WEAK_SNIPPET.test(String(previous || ''))) throw new PolicyError('拒絕跳過或假裝測試通過', { code: 'SAFETY' });
  }
  if (/(^|\/)package\.json$/.test(rel) && previous) {
    let a = {}, b = {};
    try { a = JSON.parse(previous); b = JSON.parse(next); } catch { throw new PolicyError('package.json 不是合法 JSON'); }
    if (scriptDisablesTests(a.scripts?.test, b.scripts?.test)) throw new PolicyError('拒絕把測試指令改成一律成功', { code: 'SAFETY' });
  }
  return abs;
}

const DENY_BIN = new Set(['rm', 'rmdir', 'del', 'erase', 'sudo', 'su', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'bash', 'sh', 'cmd', 'powershell', 'pwsh', 'docker', 'podman', 'kubectl', 'wrangler', 'firebase', 'fly', 'vercel', 'netlify', 'gh', 'python', 'python3', 'pip', 'pip3', 'ruby', 'perl', 'php']);
const DEP_BIN = new Set(['npm', 'pnpm', 'yarn', 'bun']);

function binOf(argv0) {
  return basename(String(argv0 || '')).toLowerCase().replace(/\.exe$/, '').replace(/\.cmd$/, '');
}

function deny(reason, extra = {}) {
  return { allow: false, reason, needsApproval: extra.needsApproval || null, audit: true };
}

function scriptTextUnsafe(text) {
  return /\b(curl|wget|ssh|sudo|rm\s|del\s|wrangler|kubectl|docker|npm\s+install|pnpm\s+add|yarn\s+add|git\s+push|git\s+reset|git\s+clean)\b/i.test(String(text || ''));
}

function evalGit(argv, ctx) {
  const sub = argv[1];
  const read = new Set(['status', 'diff', 'log', 'rev-parse', 'show', 'ls-files']);
  if (read.has(sub)) return { allow: true };
  if (sub === 'branch' && argv[2] === '--show-current') return { allow: true };
  if (['push', 'merge', 'rebase', 'reset', 'clean', 'checkout', 'switch', 'worktree', 'commit', 'pull', 'fetch'].includes(sub)) {
    const kind = sub === 'push' || sub === 'merge' ? 'git' : 'git';
    return deny(`git ${sub} 需要核准`, { needsApproval: kind });
  }
  if (sub === 'add') {
    const paths = argv.slice(2).filter(a => !a.startsWith('-'));
    if (argv.includes('-A') || argv.includes('--all') || argv.includes('.')) {
      if (ctx.cwd && insideRoot(realpathSync(ctx.root), realpathSync(ctx.cwd))) return { allow: true };
    }
    for (const p of paths) {
      try { resolveInside(ctx.root, p); } catch { return deny('git add 路徑超出工作區'); }
    }
    return paths.length ? { allow: true } : deny('git add 需要明確路徑');
  }
  return deny('這個 git 指令不在允許清單');
}

function evalPkg(bin, argv, ctx) {
  const sub = argv[1];
  if (['install', 'i', 'ci', 'add', 'update', 'remove', 'uninstall', 'publish'].includes(sub)) {
    return deny(`${bin} ${sub} 需要事先核准`, { needsApproval: sub === 'publish' ? 'deploy' : 'dependencies' });
  }
  if (sub === 'test') return { allow: true };
  if (sub === 'run') {
    const name = argv[2];
    const scripts = ctx.scripts || {};
    if (!name || !Object.prototype.hasOwnProperty.call(scripts, name)) return deny('只能執行 package.json 裡已有的指令');
    if (['deploy', 'release', 'migrate', 'migration'].includes(name) || /deploy|migrate/i.test(name)) return deny(`${name} 需要核准`, { needsApproval: /deploy|release/.test(name) ? 'deploy' : 'migrate' });
    if (scriptTextUnsafe(scripts[name])) return deny('這個指令含有未核准的危險內容', { needsApproval: /wrangler|kubectl|docker|deploy/i.test(scripts[name]) ? 'deploy' : null });
    return { allow: true };
  }
  return deny(`${bin} ${sub || ''} 不在允許清單`.trim());
}

function evalNode(argv, ctx) {
  if (argv.includes('-e') || argv.includes('-p') || argv.includes('--eval')) return deny('拒絕 node -e');
  const file = argv.slice(1).find(a => !a.startsWith('-'));
  if (!file) return deny('node 需要工作區內的檔案');
  try { resolveInside(ctx.root, file); } catch (e) { return deny(e.message); }
  return { allow: true };
}

// The model never receives a shell. argv is checked here, outside the model.
export function evaluateCommand(argv, ctx = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string' || /[\0\n\r]/.test(a))) return deny('指令格式不正確');
  if (!ctx.root) return deny('沒有工作區');
  let cwdReal, rootReal;
  try { rootReal = realpathSync(ctx.root); cwdReal = realpathSync(ctx.cwd || ctx.root); } catch { return deny('工作目錄不存在'); }
  if (!insideRoot(rootReal, cwdReal)) return deny('工作目錄超出授權工作區');
  const bin = binOf(argv[0]);
  const joined = argv.join(' ');
  if (/\b(deploy|production)\b/i.test(joined) && bin !== 'git' && bin !== 'npm' && bin !== 'node') return deny('正式部署需要核准', { needsApproval: 'deploy' });
  if (DENY_BIN.has(bin)) {
    if (['wrangler', 'firebase', 'fly', 'vercel', 'netlify', 'kubectl', 'gh'].includes(bin)) return deny('正式部署或遠端操作需要核准', { needsApproval: 'deploy' });
    return deny(`${bin} 不在允許清單`);
  }
  if (bin === 'git') return evalGit(argv, { ...ctx, root: rootReal, cwd: cwdReal });
  if (DEP_BIN.has(bin)) return evalPkg(bin, argv, ctx);
  if (bin === 'node') return evalNode(argv, ctx);
  if (bin === 'npx') return deny('npx 需要事先核准', { needsApproval: 'dependencies' });
  return deny(`${bin} 不在允許清單`);
}

// Production deploy stays closed unless a person recorded approval. Approval still does not run the deploy.
export function evaluateDeploy(approval) {
  const d = approval?.deploy;
  if (!d || d.allow !== true || d.target !== 'production' || d.by !== 'user') {
    return { allowed: false, executed: false, deployed: false, reason: 'approval_required' };
  }
  return { allowed: true, executed: false, deployed: false, reason: '已記錄正式部署核准；執行器不會自動部署' };
}

export function evaluateMerge(approval) {
  const m = approval?.merge;
  if (!m || m.allow !== true || m.by !== 'user') return { allowed: false, executed: false, merged: false, reason: 'approval_required' };
  return { allowed: true, executed: false, merged: false, reason: '已記錄合併核准；執行器不會自動合併受保護分支' };
}

const ENV_ALLOW = /^(PATH|HOME|TMPDIR|TEMP|TMP|LANG|LC_ALL|LC_CTYPE|SYSTEMROOT|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA|WINDIR|NODE_PATH|PATHEXT|SHELL|TERM)$/i;
const ENV_SECRET = /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH/i;

export function safeProcessEnv(src = process.env) {
  const out = { npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false', CI: '1' };
  for (const [k, v] of Object.entries(src || {})) {
    if (v == null) continue;
    if (!ENV_ALLOW.test(k)) continue;
    if (ENV_SECRET.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function clampRepairs(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_MAX_REPAIRS;
  return Math.max(0, Math.min(DEFAULT_MAX_REPAIRS, Math.floor(v)));
}
