import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { startCdpBridge } from '../desktop/cdp-bridge.mjs';

const { chromium } = createRequire(new URL('../desktop/package.json', import.meta.url))('playwright-core');

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
    assert.equal(targets.targetInfos[0].browserContextId, 'octa');
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

// Playwright MCP connects this way. Without a browserContextId it asserts and drops the socket,
// and the in-app window stays on the "網頁會開在這裡" splash because nothing can navigate it.
test('Playwright can attach to the in-app page and navigate it', async () => {
  const pages = [{ id: 'page-1', title: 'splash', url: 'data:text/html,hi' }];
  let emit = () => {};
  const tree = (url, loader) => ({ frameTree: { frame: { id: 'page-1', loaderId: loader, url, mimeType: 'text/html' } } });
  const bridge = await startCdpBridge({
    onEvent(cb) { emit = cb; },
    list: () => pages.map(p => ({ ...p })),
    bounds: () => ({ windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' } }),
    async command(targetId, method, params) {
      if (method === 'Page.getFrameTree') return tree(pages[0].url, 'l1');
      if (method === 'Runtime.enable') {
        setTimeout(() => emit(targetId, 'Runtime.executionContextCreated', { context: { id: 1, origin: '', name: '', auxData: { isDefault: true, type: 'default', frameId: targetId } } }), 20);
        return {};
      }
      if (method === 'Page.navigate') {
        pages[0].url = params.url;
        emit(targetId, 'Page.frameNavigated', { frame: { id: targetId, loaderId: 'l2', url: params.url, mimeType: 'text/html' } });
        emit(targetId, 'Runtime.executionContextCreated', { context: { id: 2, origin: params.url, name: '', auxData: { isDefault: true, type: 'default', frameId: targetId } } });
        for (const name of ['commit', 'DOMContentLoaded', 'load']) emit(targetId, 'Page.lifecycleEvent', { frameId: targetId, loaderId: 'l2', name });
        return { frameId: targetId, loaderId: 'l2' };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 's1' };
      if (method.startsWith('Target.')) throw new Error('page debugger rejected ' + method);
      return {};
    },
    async createTarget(params) {
      const page = { id: 'page-' + (pages.length + 1), title: '', url: params.url || 'about:blank' };
      pages.push(page);
      return page;
    }
  });
  const unhandled = [];
  const onUnhandled = e => unhandled.push(String(e && e.message));
  process.on('unhandledRejection', onUnhandled);
  try {
    // the name tag connects and attaches the page before the bot's tools do
    const tag = await client(bridge.port);
    await tag.send('Target.setDiscoverTargets', { discover: true });
    const tagged = await tag.send('Target.attachToTarget', { targetId: 'page-1', flatten: true });
    assert.ok(tagged.sessionId);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${bridge.port}`, { timeout: 8000, noDefaults: true });
    const page = browser.contexts()[0].pages()[0];
    assert.equal(page.url(), 'data:text/html,hi');
    page.setDefaultTimeout(4000);
    await page.goto('https://account.line.biz/', { waitUntil: 'commit' });
    assert.equal(page.url(), 'https://account.line.biz/');
    assert.deepEqual(unhandled, []);
    await browser.close();
    tag.ws.close();
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await bridge.close();
  }
});

// Electron's page debugger reports a blink frame id. Playwright only navigates a frame whose id
// equals the target id, and otherwise throws "Frame has been detached" before the URL is opened.
test('Playwright can open a page when the frame id differs from the target id', async () => {
  const pages = [{ id: 'page-1', title: 'splash', url: 'data:text/html,hi' }];
  let blink = 'F1A0.1';
  let ctx = 1;
  let emit = () => {};
  const navigates = [];
  const worlds = [];
  const tree = () => ({ frameTree: { frame: { id: blink, loaderId: 'l-' + blink, url: pages[0].url, mimeType: 'text/html' }, childFrames: [{ frame: { id: 'child-9', parentId: blink, loaderId: 'lc', url: 'about:blank', mimeType: 'text/html' } }] } });
  const bridge = await startCdpBridge({
    onEvent(cb) { emit = cb; },
    list: () => pages.map(p => ({ ...p })),
    bounds: () => ({ windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' } }),
    async command(targetId, method, params) {
      if (method === 'Page.getFrameTree') {
        await new Promise(r => setTimeout(r, 30));
        return tree();
      }
      if (method === 'Runtime.enable') {
        emit(targetId, 'Runtime.executionContextCreated', { context: { id: ctx, origin: pages[0].url, name: '', auxData: { isDefault: true, type: 'default', frameId: blink } } });
        return {};
      }
      if (method === 'Page.createIsolatedWorld') {
        worlds.push(params.frameId);
        const id = ++ctx;
        emit(targetId, 'Runtime.executionContextCreated', { context: { id, origin: pages[0].url, name: params.worldName || '', auxData: { isDefault: false, type: 'isolated', frameId: params.frameId } } });
        return { executionContextId: id };
      }
      if (method === 'Page.navigate') {
        navigates.push(params.frameId);
        const next = blink === 'F1A0.1' ? 'F1A0.2' : 'F1A0.3';
        pages[0].url = params.url;
        blink = next;
        const loaderId = 'L' + next;
        emit(targetId, 'Page.frameNavigated', { frame: { id: next, loaderId, url: params.url, mimeType: 'text/html' } });
        emit(targetId, 'Runtime.executionContextDestroyed', { executionContextId: 1 });
        emit(targetId, 'Runtime.executionContextCreated', { context: { id: ++ctx, origin: params.url, name: '', auxData: { isDefault: true, type: 'default', frameId: next } } });
        emit(targetId, 'Runtime.executionContextCreated', { context: { id: ++ctx, origin: params.url, name: 'utility', auxData: { isDefault: false, type: 'isolated', frameId: next } } });
        for (const name of ['commit', 'DOMContentLoaded', 'load']) emit(targetId, 'Page.lifecycleEvent', { frameId: next, loaderId, name });
        return { frameId: next, loaderId };
      }
      if (method === 'Runtime.evaluate') {
        if (String(params.expression || '').includes('UtilityScript')) return { result: { type: 'object', objectId: 'util-' + (params.contextId || 0), description: 'UtilityScript' } };
        return { result: { type: 'string', value: pages[0].url } };
      }
      if (method === 'Runtime.callFunctionOn') return { result: { type: 'string', value: pages[0].url } };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 's1' };
      if (method.startsWith('Target.')) throw new Error('page debugger rejected ' + method);
      return {};
    },
    async createTarget(params) {
      const page = { id: 'page-' + (pages.length + 1), title: '', url: params.url || 'about:blank' };
      pages.push(page);
      return page;
    }
  });
  const unhandled = [];
  const onUnhandled = e => unhandled.push(String(e && e.message));
  process.on('unhandledRejection', onUnhandled);
  try {
    const tag = await client(bridge.port);
    await tag.send('Target.setDiscoverTargets', { discover: true });
    await tag.send('Target.attachToTarget', { targetId: 'page-1', flatten: true });
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${bridge.port}`, { timeout: 8000, noDefaults: true });
    const page = browser.contexts()[0].pages()[0];
    page.setDefaultTimeout(4000);
    assert.equal(page.url(), 'data:text/html,hi');
    assert.equal(await page.evaluate('location.href'), 'data:text/html,hi');
    await page.goto('https://manager.line.biz/', { waitUntil: 'load' });
    assert.equal(page.url(), 'https://manager.line.biz/');
    assert.equal(await page.evaluate('location.href'), 'https://manager.line.biz/');
    await page.goto('https://manager.line.biz/account/', { waitUntil: 'load' });
    assert.equal(page.url(), 'https://manager.line.biz/account/');
    assert.equal(navigates[0], 'F1A0.1');
    assert.equal(navigates[1], 'F1A0.2');
    assert.ok(worlds.includes('F1A0.1'));
    assert.equal(worlds.includes('page-1'), false);
    assert.deepEqual(unhandled, []);
    await browser.close();
    tag.ws.close();
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await bridge.close();
  }
});
