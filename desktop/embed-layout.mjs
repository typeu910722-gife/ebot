// How the in-app browser shares the OCTA window.
// Wide windows: browser on the right, chat keeps the desktop layout (list + conversation).
// Narrow windows: browser underneath, so the page does not collapse into the phone layout.

export function isBlankUrl(url) {
  const u = String(url || '');
  return !u || u === 'about:blank' || u.startsWith('data:');
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
