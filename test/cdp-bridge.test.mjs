import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startCdpBridge } from '../desktop/cdp-bridge.mjs';

function adapter() {
  const pages = [{ id: 'page-1', title: 'OCTA', url: 'about:blank' }];
  const commands = [];
  return {
    commands,
    list: () => pages,
    bounds: () => ({ windowId: 1, bounds: { left: 0, top: 0, width: 900, height: 700, windowState: 'normal' } }),
    async command(targetId, method, params) {
      commands.push({ targetId, method, params });
      if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'Battery 4/7' } };
      return {};
    },
    async createTarget(params) {
      const page = { id: 'page-2', title: '背景', url: params.url || 'about:blank' };
      pages.push(page);
      return page;
    },
    async closeTarget(id) { const i = pages.findIndex(p => p.id === id); if (i >= 0) pages.splice(i, 1); }
  };
}

async function client(port) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('ws')); });
  let n = 0; const wait = new Map(); const events = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
    else events.push(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
    const id = ++n;
    wait.set(id, m => (m.error ? no(new Error(m.error.message)) : ok(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => { if (wait.has(id)) { wait.delete(id); no(new Error('timeout ' + method)); } }, 3000);
  });
  return { ws, send, events };
}

test('the in-app browser endpoint lists one page and forwards a read', async () => {
  const ad = adapter();
  const bridge = await startCdpBridge(ad);
  try {
    const { send, events, ws } = await client(bridge.port);
    const targets = await send('Target.getTargets');
    assert.equal(targets.targetInfos.length, 1);
    assert.equal(targets.targetInfos[0].url, 'about:blank');
    await send('Target.setDiscoverTargets', { discover: true });
    assert.equal(events.some(e => e.method === 'Target.targetCreated'), true);
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    assert.equal(events.some(e => e.method === 'Target.attachedToTarget' && e.params.targetInfo.targetId === 'page-1'), true);
    const attached = await send('Target.attachToTarget', { targetId: 'page-1', flatten: true });
    const read = await send('Runtime.evaluate', { expression: 'document.body.innerText' }, attached.sessionId);
    assert.equal(read.result.value, 'Battery 4/7');
    assert.deepEqual(ad.commands[0].targetId, 'page-1');
    const bounds = await send('Browser.getWindowForTarget', { targetId: 'page-1' });
    assert.ok(bounds.bounds.left > -5000);
    const created = await send('Target.createTarget', { url: 'https://rollercoin.com/game', background: true });
    assert.equal(created.targetId, 'page-2');
    await send('Target.closeTarget', { targetId: 'page-2' });
    assert.equal((await send('Target.getTargets')).targetInfos.some(t => t.targetId === 'page-2'), false);
    ws.close();
  } finally { await bridge.close(); }
});
