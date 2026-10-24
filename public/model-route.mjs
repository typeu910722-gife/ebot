// Classifies a model failure and chooses retry, fallback, or stop.
// This is a policy function. It does not call a provider and must not treat every error as quota.

export function classifyModelFailure(text, flags = {}) {
  if (flags.stopped) return 'cancelled';
  const t = String(text || '');
  if (/使用者按了停止|已停止|aborted by user|operation was aborted/i.test(t)) return 'cancelled';
  if (/invalid[_\s-]?api[_\s-]?key|incorrect api key|authentication_error|\b401\b|unauthorized|invalid token|API Key 無效|憑證無效|登入失效|not logged in|please login|未登入/i.test(t)) return 'auth';
  if (/quota|usage limit|out of (extra )?credits|insufficient[_\s-]?credit|upgrade your (plan|subscription)|額度(用完|不足)|用量上限|已達上限/i.test(t)) return 'quota';
  if (/\b429\b|too many requests|rate limit/i.test(t)) return 'rate_limit';
  if (/\b(502|503|504)\b|gateway timeout|timed out|timeout|ECONNRESET|EAI_AGAIN|temporarily unavailable|overloaded|服務暫時|網路錯誤/i.test(t)) return 'transient';
  if (/(websearch|搜尋工具|mcp|plugin|技能).{0,40}(fail|失敗|error|不可用)|(fail|失敗).{0,24}(websearch|搜尋工具|mcp|plugin|技能)/i.test(t)) return 'tool';
  return 'execution';
}

function nextLive(chain, index, now) {
  for (let i = index + 1; i < chain.length; i++) {
    if (!(chain[i]?.spentUntil > now)) return i;
  }
  return -1;
}

// chain items: { id, spentUntil }. index is the model that just failed.
// tries counts retries already used on that same model.
export function decideRoute({ kind, tries = 0, chain = [], index = 0, resetsAt = 0, now = Date.now() } = {}) {
  const later = nextLive(chain, index, now);
  if (kind === 'cancelled') return { action: 'stop', reason: 'cancelled', message: '已停止，不會再重試或改用備援。' };
  if (kind === 'auth') return { action: 'stop', reason: 'auth', message: '這個 AI 的登入或 API Key 無效。請到「AI 連線」檢查憑證，系統不會重複呼叫。' };
  if (kind === 'tool') return { action: 'stop', reason: 'tool', message: '工具或搜尋失敗。這次不更換模型，請檢查工具與網路後再重試。' };
  if (kind === 'execution' || !kind) return { action: 'stop', reason: 'execution', message: '' };
  if (kind === 'quota') {
    if (later < 0) return { action: 'stop', reason: 'quota', message: '主要模型和備援都無法使用（額度）。任務已保留，可稍後重新執行。' };
    return { action: 'switch', index: later, reason: 'quota', spend: true, message: '額度用完，改由備援接手。已完成的步驟會保留。' };
  }
  if (kind === 'rate_limit') {
    if (resetsAt > now || tries >= 1) {
      if (later < 0) return { action: 'stop', reason: 'rate_limit', message: '目前被限流，而且沒有可用的備援。請稍後再執行。' };
      return { action: 'switch', index: later, reason: 'rate_limit', spend: resetsAt > now, message: '遇到 HTTP 429。同一個模型不會無限重試，已改用備援。' };
    }
    return { action: 'retry', reason: 'rate_limit', message: '遇到 HTTP 429，用同一個模型再試一次。' };
  }
  if (kind === 'transient') {
    if (tries < 2) return { action: 'retry', reason: 'transient', message: '服務暫時故障，用同一個模型再試一次。' };
    if (later < 0) return { action: 'stop', reason: 'transient', message: '服務暫時故障，重試與備援都已用完。任務進度已保留。' };
    return { action: 'switch', index: later, reason: 'transient', message: '服務暫時故障，有限次重試後改用備援。' };
  }
  return { action: 'stop', reason: kind, message: '' };
}
