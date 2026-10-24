// A localhost Chrome DevTools endpoint for one in-app Chromium page.
// Playwright and the runner speak browser-level CDP; Electron's debugger is page-level.
// This bridge is the browser, and it forwards page commands to the adapter.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text, opcode = 0x81) {
  const payload = Buffer.from(text);
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([opcode, len]);
  else if (len < 65536) head = Buffer.from([opcode, 126, len >> 8, len & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = opcode; head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function createParser(onText, onControl) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 8) return 'close';
      if (opcode === 9) { onControl?.('pong', payload); continue; }
      if (opcode === 10 || opcode === 0) continue;
      if (opcode === 1) onText(payload.toString('utf8'));
    }
  };
}

export function startCdpBridge(adapter, port = 0) {
  const clients = new Set();
  const sessions = new Map();
  const told = new WeakMap(); // socket → Set of target ids it has already been given
  let seq = 0, autoAttach = false, waitDbg = false;
  const sendTo = (socket, obj) => { try { socket.write(encodeFrame(JSON.stringify(obj))); } catch { } };
  const sendAll = obj => { for (const socket of clients) sendTo(socket, obj); };
  const sessionFor = targetId => [...sessions].find(([, id]) => id === targetId)?.[0] || null;
  // each connection hears about a page once. the name tag connects first; the bot's browser tools connect
  // later and must still be told, or they see no page and cannot open anything
  function notify(t, sockets) {
    let sessionId = sessionFor(t.id);
    if (!sessionId) { sessionId = 's' + (++seq); sessions.set(sessionId, t.id); }
    const msg = { method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...info(t), attached: true }, waitingForDebugger: waitDbg } };
    for (const socket of sockets) {
      if (!clients.has(socket)) continue;
      let seen = told.get(socket);
      if (!seen) told.set(socket, seen = new Set());
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      sendTo(socket, msg);
    }
    return sessionId;
  }
  function forget(socket) {
    clients.delete(socket);
    const seen = told.get(socket);
    told.delete(socket);
    if (!seen) return;
    for (const id of seen) {
      if ([...clients].some(c => told.get(c)?.has(id))) continue;
      for (const [sid, tid] of [...sessions]) if (tid === id) sessions.delete(sid);
    }
  }
  // Electron names the main frame with its own id. Playwright looks that frame up under the target
  // id, and anything else throws "Frame has been detached" before the address is even opened.
  const frames = new Map();
  const PRE_TREE = new Set(['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Page.lifecycleEvent']);
  const track = targetId => {
    let s = frames.get(targetId);
    if (!s) frames.set(targetId, s = { main: null, children: new Set(), seenTree: false, pre: [], held: [] });
    return s;
  };
  const learnMain = (targetId, realId) => {
    if (!realId || realId === targetId) return false;
    const s = track(targetId);
    if (s.main === realId) return false;
    s.children.delete(realId);
    s.main = realId;
    return true;
  };
  const mapOut = (targetId, id) => (id && track(targetId).main === id ? targetId : id);
  const mapIn = (targetId, id) => (id === targetId && track(targetId).main ? track(targetId).main : id);
  const ID_KEYS = new Set(['frameId', 'parentFrameId', 'parentId']);
  function mapIds(node, fn, parentKey) {
    if (Array.isArray(node)) return node.map(item => mapIds(item, fn, parentKey));
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && (ID_KEYS.has(k) || (k === 'id' && parentKey === 'frame'))) out[k] = fn(v);
      else if (v && typeof v === 'object') out[k] = mapIds(v, fn, k);
      else out[k] = v;
    }
    return out;
  }
  function absorbTree(targetId, node, isRoot) {
    const frame = node?.frame;
    if (!frame) return;
    const s = track(targetId);
    if (isRoot) learnMain(targetId, frame.id);
    else if (frame.id && frame.id !== s.main) s.children.add(frame.id);
    if (!isRoot && !frame.parentId) frame.parentId = s.main || targetId;
    frame.id = mapOut(targetId, frame.id);
    if (frame.parentId) frame.parentId = mapOut(targetId, frame.parentId);
    for (const child of node.childFrames || []) absorbTree(targetId, child, false);
  }
  function noteFrame(targetId, method, params) {
    const s = track(targetId);
    if (method === 'Page.frameNavigated' && params?.frame) {
      if (!params.frame.parentId) return learnMain(targetId, params.frame.id);
      if (params.frame.id) s.children.add(params.frame.id);
      return true;
    }
    if (method === 'Page.frameAttached') {
      if (!params?.parentFrameId) return learnMain(targetId, params?.frameId);
      if (params?.frameId) s.children.add(params.frameId);
      return true;
    }
    if (method === 'Page.frameDetached' && params?.frameId && params.frameId !== s.main) s.children.delete(params.frameId);
    return false;
  }
  function deliver(targetId, method, params) {
    const sessionId = sessionFor(targetId);
    if (!sessionId) {
      if (PRE_TREE.has(method)) track(targetId).pre.push({ method, params });
      return;
    }
    const learned = noteFrame(targetId, method, params);
    let body = params || {};
    try { body = mapIds(structuredClone(body), id => mapOut(targetId, id)); } catch { body = mapIds(body, id => mapOut(targetId, id)); }
    sendAll({ method, params: body, sessionId });
    if (learned) releaseHeld(targetId);
  }
  function holdContext(targetId, method, params) {
    if (method !== 'Runtime.executionContextCreated') return false;
    const id = params?.context?.auxData?.frameId;
    if (!id) return false;
    const s = track(targetId);
    if (id === s.main || id === targetId || s.children.has(id)) return false;
    s.held.push(params);
    return true;
  }
  function releaseHeld(targetId) {
    const s = track(targetId);
    const pending = s.held.splice(0);
    for (const params of pending) {
      const id = params?.context?.auxData?.frameId;
      if (id === s.main || s.children.has(id)) deliver(targetId, 'Runtime.executionContextCreated', params);
      else s.held.push(params);
    }
  }
  function flushPre(targetId) {
    const s = track(targetId);
    const queued = s.pre.splice(0);
    for (const ev of queued) {
      if (holdContext(targetId, ev.method, ev.params)) continue;
      deliver(targetId, ev.method, ev.params);
    }
  }
  adapter.onEvent?.((targetId, method, params) => {
    const raw = params || {};
    const s = track(targetId);
    if (!s.seenTree && PRE_TREE.has(method)) {
      s.pre.push({ method, params: raw });
      if (s.pre.length > 100) s.pre.shift();
      return;
    }
    if (s.seenTree && holdContext(targetId, method, raw)) return;
    deliver(targetId, method, raw);
  });
  // Playwright drops the whole connection (the tools then all report "Transport closed") unless every
  // page target carries a browserContextId, even when that context is the default one.
  const CONTEXT = 'octa';
  const info = t => ({ targetId: t.id, type: 'page', title: t.title || '', url: t.url || 'about:blank', attached: false, canAccessOpener: false, browserContextId: CONTEXT });
  async function browserCommand(method, params, socket) {
    if (method === 'Browser.getVersion') return { protocolVersion: '1.3', product: 'Chrome/128.0.6613.186', revision: 'octa', userAgent: 'OCTA', jsVersion: '12.0' };
    if (method === 'Browser.getWindowForTarget') return adapter.bounds?.(params?.targetId) || { windowId: 1, bounds: { left: 0, top: 0, width: 1100, height: 800, windowState: 'normal' } };
    if (method === 'Browser.setWindowBounds') { await adapter.setBounds?.(params?.bounds || {}); return {}; }
    if (method === 'Browser.close') { await adapter.close?.(); return {}; }
    if (method === 'Browser.setDownloadBehavior' || method === 'Browser.grantPermissions' || method === 'Browser.resetPermissions') return {};
    if (method === 'Storage.getCookies' || method === 'Storage.setCookies') {
      const page = adapter.list()[0];
      if (!page) return method === 'Storage.getCookies' ? { cookies: [] } : {};
      return await adapter.command(page.id, method, params || {}) || {};
    }
    if (method === 'Target.getTargets' || method === 'Target.getTargetInfo') {
      const list = adapter.list();
      if (method === 'Target.getTargetInfo') return { targetInfo: info(list.find(t => t.id === params.targetId) || list[0]) };
      return { targetInfos: list.map(info) };
    }
    if (method === 'Target.setDiscoverTargets') {
      if (params?.discover) for (const t of adapter.list()) sendAll({ method: 'Target.targetCreated', params: { targetInfo: info(t) } });
      return {};
    }
    if (method === 'Target.setAutoAttach') {
      autoAttach = !!params?.autoAttach;
      waitDbg = !!params?.waitForDebuggerOnStart;
      if (autoAttach) for (const t of adapter.list()) notify(t, [socket]);
      return {};
    }
    if (method === 'Target.attachToTarget') {
      const t = adapter.list().find(x => x.id === params.targetId) || { id: params.targetId, title: '', url: 'about:blank' };
      return { sessionId: notify(t, [socket]) };
    }
    if (method === 'Target.detachFromTarget') {
      const tid = params?.targetId || (params?.sessionId && sessions.get(params.sessionId));
      if (tid) told.get(socket)?.delete(tid);
      if (tid && ![...clients].some(c => told.get(c)?.has(tid))) { for (const [sid, id] of [...sessions]) if (id === tid) sessions.delete(sid); }
      return {};
    }
    if (method === 'Target.activateTarget') { await adapter.activateTarget?.(params.targetId); return {}; }
    if (method === 'Target.createTarget') {
      const created = await adapter.createTarget(params || {});
      if (!sessionFor(created.id)) sendAll({ method: 'Target.targetCreated', params: { targetInfo: info(created) } });
      notify(created, autoAttach ? [...clients] : [socket]);
      return { targetId: created.id };
    }
    if (method === 'Target.closeTarget') {
      await adapter.closeTarget?.(params.targetId);
      for (const c of clients) told.get(c)?.delete(params.targetId);
      for (const [sid, id] of [...sessions]) if (id === params.targetId) sessions.delete(sid);
      frames.delete(params.targetId);
      sendAll({ method: 'Target.targetDestroyed', params: { targetId: params.targetId } });
      return { success: true };
    }
    const err = new Error('OCTA 瀏覽器沒有這個指令：' + method);
    err.expose = true;
    throw err;
  }
  async function onMessage(text, socket) {
    let msg; try { msg = JSON.parse(text); } catch { return; }
    const reply = (extra) => { try { socket.write(encodeFrame(JSON.stringify({ id: msg.id, ...extra, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }))); } catch { } };
    try {
      if (msg.sessionId) {
        if (msg.method === 'Runtime.runIfWaitingForDebugger') { reply({ result: {} }); return; }
        // these are browser-target commands; a page debugger rejects them and Playwright then abandons the page
        if (msg.method === 'Target.setAutoAttach' || msg.method === 'Target.setDiscoverTargets') { reply({ result: {} }); return; }
        const targetId = sessions.get(msg.sessionId);
        if (!targetId) throw new Error('分頁連線已結束');
        const sent = mapIds(msg.params || {}, id => mapIn(targetId, id));
        let out = await adapter.command(targetId, msg.method, sent) || {};
        try { out = structuredClone(out); } catch { /* already a plain result */ }
        if (msg.method === 'Page.getFrameTree' && out.frameTree) absorbTree(targetId, out.frameTree, true);
        else if (msg.method === 'Page.navigate' && typeof out.frameId === 'string') {
          if (!sent.frameId || sent.frameId === track(targetId).main) learnMain(targetId, out.frameId);
          out.frameId = mapOut(targetId, out.frameId);
        } else out = mapIds(out, id => mapOut(targetId, id));
        if (msg.method === 'Page.getFrameTree') track(targetId).seenTree = true;
        reply({ result: out });
        // the context can arrive before the frame tree. hold it until Playwright has read the tree
        // and attached its listeners, or the read of the page waits until it times out
        if (msg.method === 'Page.getFrameTree') setTimeout(() => flushPre(targetId), 0);
        releaseHeld(targetId);
      } else reply({ result: await browserCommand(msg.method, msg.params || {}, socket) || {} });
    } catch (e) { reply({ error: { code: -32000, message: String(e.message || e) } }); }
  }
  const server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
    const list = () => adapter.list().map(t => ({ id: t.id, type: 'page', title: t.title || '', url: t.url || 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${bound}/devtools/page/${t.id}` }));
    let body = null;
    if (path === '/json/version') body = { Browser: 'Chrome/128.0.6613.186', 'Protocol-Version': '1.3', 'User-Agent': 'OCTA', 'V8-Version': '12.0', 'WebKit-Version': '537.36', webSocketDebuggerUrl: `ws://127.0.0.1:${bound}/devtools/browser/octa` };
    else if (path === '/json/list' || path === '/json') body = list();
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(body ? JSON.stringify(body) : '{}');
  });
  let bound = port;
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    clients.add(socket);
    const feed = createParser(text => onMessage(text, socket), (kind, payload) => {
      if (kind === 'pong') { try { socket.write(encodeFrame(payload, 0x8a)); } catch { } }
    });
    socket.on('data', chunk => { if (feed(chunk) === 'close') { forget(socket); try { socket.end(); } catch { } } });
    socket.on('close', () => forget(socket));
    socket.on('error', () => forget(socket));
  });
  return new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', () => {
      bound = server.address().port;
      ok({
        port: bound,
        close: () => new Promise(done => { for (const s of clients) { try { s.destroy(); } catch { } } server.close(() => done()); })
      });
    });
  });
}
