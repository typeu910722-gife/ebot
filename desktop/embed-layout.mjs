// How the in-app browser shares the OCTA window.
// Wide windows: browser on the right, chat keeps the desktop layout (list + conversation).
// Narrow windows: browser underneath, so the page does not collapse into the phone layout.

export const PAGE = { width: 1280, height: 800 };

export function isBlankUrl(url) {
  const u = String(url || '');
  return !u || u === 'about:blank' || u.startsWith('data:');
}

// thumb: a corner preview, the chat keeps the whole window.
// open: the page docks beside or under the chat, with a bar to collapse it.
export function embedFrames(w, h, mode) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const main = { x: 0, y: 0, width: w, height: h };
  if (mode === 'thumb') {
    const width = Math.min(220, Math.max(120, w - 28));
    const height = Math.min(148, Math.max(84, Math.round(width * 0.67)));
    return {
      mode: 'thumb',
      main,
      page: null,
      chrome: {
        x: Math.max(8, w - width - 14),
        y: Math.max(8, h - height - 14),
        width: Math.min(width, Math.max(1, w - 8)),
        height: Math.min(height, Math.max(1, h - 8))
      }
    };
  }
  if (mode === 'open') {
    const dock = dockLayout(w, h);
    const bar = 40;
    const side = dock.side;
    return {
      mode: 'open',
      main: dock.main,
      chrome: { x: side.x, y: side.y, width: side.width, height: bar },
      page: { x: side.x, y: side.y + bar, width: side.width, height: Math.max(1, side.height - bar) }
    };
  }
  return { mode: 'hidden', main, page: null, chrome: null };
}

export function dockLayout(w, h) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const chatMin = 920;
  let sideW = Math.round(w * 0.42);
  sideW = Math.max(420, Math.min(860, sideW));
  if (w - sideW >= chatMin) {
    const left = w - sideW;
    return {
      mode: 'side',
      main: { x: 0, y: 0, width: left, height: h },
      side: { x: left, y: 0, width: sideW, height: h }
    };
  }
  const sideH = Math.min(Math.round(h * 0.46), Math.max(240, h - 380));
  const top = Math.max(1, h - sideH);
  return {
    mode: 'bottom',
    main: { x: 0, y: 0, width: w, height: top },
    side: { x: 0, y: top, width: w, height: Math.max(1, h - top) }
  };
}
