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
  let seq = 0, autoAttach = false, waitDbg = false;
  const attach = t => {
    const sessionId = 's' + (++seq);
    sessions.set(sessionId, t.id);
    sendAll({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...info(t), attached: true }, waitingForDebugger: waitDbg } });
    return sessionId;
  };
  const sendAll = obj => {
    const frame = encodeFrame(JSON.stringify(obj));
    for (const socket of clients) { try { socket.write(frame); } catch { } }
  };
  adapter.onEvent?.((targetId, method, params) => {
    for (const [sessionId, id] of sessions) if (id === targetId) sendAll({ method, params: params || {}, sessionId });
  });
  // Playwright drops the whole connection (the tools then all report "Transport closed") unless every
  // page target carries a browserContextId, even when that context is the default one.
  const CONTEXT = 'octa';
  const info = t => ({ targetId: t.id, type: 'page', title: t.title || '', url: t.url || 'about:blank', attached: false, canAccessOpener: false, browserContextId: CONTEXT });
  async function browserCommand(method, params) {
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
      if (autoAttach) for (const t of adapter.list()) if (![...sessions.values()].includes(t.id)) attach(t);
      return {};
    }
    if (method === 'Target.attachToTarget') {
      const known = [...sessions].find(([, id]) => id === params.targetId);
      const sessionId = known ? known[0] : attach(adapter.list().find(t => t.id === params.targetId) || { id: params.targetId, title: '', url: 'about:blank' });
      return { sessionId };
    }
    if (method === 'Target.detachFromTarget') { for (const [sid, id] of sessions) if (sid === params?.sessionId || id === params?.targetId) sessions.delete(sid); return {}; }
    if (method === 'Target.activateTarget') { await adapter.activateTarget?.(params.targetId); return {}; }
    if (method === 'Target.createTarget') {
      const created = await adapter.createTarget(params || {});
      // reusing the open tab (the splash page) must not attach it a second time: Playwright closes the
      // connection on a duplicate target, and every browser tool then fails
      if (![...sessions.values()].includes(created.id)) {
        sendAll({ method: 'Target.targetCreated', params: { targetInfo: info(created) } });
        if (autoAttach) attach(created);
      }
      return { targetId: created.id };
    }
    if (method === 'Target.closeTarget') { await adapter.closeTarget?.(params.targetId); sendAll({ method: 'Target.targetDestroyed', params: { targetId: params.targetId } }); return { success: true }; }
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
        reply({ result: await adapter.command(targetId, msg.method, msg.params || {}) || {} });
      } else reply({ result: await browserCommand(msg.method, msg.params || {}) || {} });
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
    socket.on('data', chunk => { if (feed(chunk) === 'close') { clients.delete(socket); try { socket.end(); } catch { } } });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
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
