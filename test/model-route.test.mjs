import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyModelFailure, decideRoute } from '../public/model-route.mjs';

const chain = [{ id: 'claude' }, { id: 'gemini' }, { id: 'opencode|qwen3' }];
const now = 1_000_000;

test('simulated errors are classified before any fallback decision', () => {
  assert.equal(classifyModelFailure('usage limit exceeded'), 'quota');
  assert.equal(classifyModelFailure('HTTP 429 too many requests'), 'rate_limit');
  assert.equal(classifyModelFailure('invalid api key'), 'auth');
  assert.equal(classifyModelFailure('503 temporarily unavailable'), 'transient');
  assert.equal(classifyModelFailure('AssertionError test.js failed'), 'execution');
  assert.equal(classifyModelFailure('WebSearch failed: network'), 'tool');
  assert.equal(classifyModelFailure('usage limit', { stopped: true }), 'cancelled');
});

test('simulated quota switches once and stops when every model is spent', () => {
  const first = decideRoute({ kind: 'quota', tries: 0, chain, index: 0, now });
  assert.equal(first.action, 'switch');
  assert.equal(first.index, 1);
  const second = decideRoute({ kind: 'quota', tries: 0, chain, index: 1, now });
  assert.equal(second.action, 'switch');
  assert.equal(second.index, 2);
  const done = decideRoute({ kind: 'quota', tries: 0, chain, index: 2, now });
  assert.equal(done.action, 'stop');
  assert.match(done.message, /保留/);
});

test('simulated HTTP 429 retries once, then switches, and does not loop', () => {
  const retry = decideRoute({ kind: 'rate_limit', tries: 0, chain, index: 0, now });
  assert.equal(retry.action, 'retry');
  const again = decideRoute({ kind: 'rate_limit', tries: 1, chain, index: 0, now });
  assert.equal(again.action, 'switch');
  assert.equal(again.index, 1);
  const none = decideRoute({ kind: 'rate_limit', tries: 1, chain: [chain[0]], index: 0, now });
  assert.equal(none.action, 'stop');
});

test('simulated auth, tool, execution, and cancel do not switch or retry', () => {
  for (const kind of ['auth', 'tool', 'execution', 'cancelled']) {
    const d = decideRoute({ kind, tries: 0, chain, index: 0, now });
    assert.equal(d.action, 'stop', kind);
    assert.equal(d.index, undefined);
  }
  assert.match(decideRoute({ kind: 'auth', chain, index: 0, now }).message, /API Key/);
  assert.equal(decideRoute({ kind: 'execution', chain, index: 0, now }).message, '');
});

test('simulated transient failure retries twice on the same model before switching', () => {
  assert.equal(decideRoute({ kind: 'transient', tries: 0, chain, index: 0, now }).action, 'retry');
  assert.equal(decideRoute({ kind: 'transient', tries: 1, chain, index: 0, now }).action, 'retry');
  const hop = decideRoute({ kind: 'transient', tries: 2, chain, index: 0, now });
  assert.equal(hop.action, 'switch');
  assert.equal(hop.index, 1);
});
