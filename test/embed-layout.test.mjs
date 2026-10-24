import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dockLayout, embedFrames, isBlankUrl } from '../desktop/embed-layout.mjs';
import { pickLivePage } from '../public/octa-runner.mjs';

test('a wide window keeps the chat beside the browser', () => {
  const lay = dockLayout(1920, 1000);
  assert.equal(lay.mode, 'side');
  assert.ok(lay.main.width >= 920);
  assert.ok(lay.side.width >= 420);
  assert.equal(lay.main.width + lay.side.width, 1920);
  assert.equal(lay.side.x, lay.main.width);
  assert.equal(lay.main.height, 1000);
  assert.equal(lay.side.height, 1000);
});

test('a narrower window puts the browser under the chat', () => {
  const lay = dockLayout(1366, 768);
  assert.equal(lay.mode, 'bottom');
  assert.equal(lay.main.width, 1366);
  assert.equal(lay.side.width, 1366);
  assert.equal(lay.side.y, lay.main.height);
  assert.equal(lay.main.height + lay.side.height, 768);
  assert.ok(lay.main.height >= 380);
});

test('the visible page is the real site, not the opening card', () => {
  assert.equal(isBlankUrl(''), true);
  assert.equal(isBlankUrl('about:blank'), true);
  assert.equal(isBlankUrl('data:text/html,hi'), true);
  assert.equal(isBlankUrl('https://chat.line.biz/'), false);
  const page = pickLivePage([
    { type: 'page', url: 'data:text/html,splash', targetId: 'splash' },
    { type: 'page', url: 'https://chat.line.biz/account', targetId: 'line' },
    { type: 'page', url: 'about:blank', targetId: 'blank' }
  ]);
  assert.equal(page.targetId, 'line');
});

test('foreground tabs are the on-screen view', () => {
  const src = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async createTarget'), src.indexOf('async closeTarget'));
  assert.ok(fn.includes('params?.background'));
  assert.ok(fn.indexOf('params?.background') < fn.indexOf('new BrowserWindow'));
  assert.match(fn, /isBlankUrl/);
  assert.match(fn, /embedShow\(port, true\)/);
  assert.doesNotMatch(fn, /embedShow\(port, 'open'\)/);
  assert.match(src, /dockLayout/);
  assert.match(src, /bucket\.shown === 'open' \? 'open' : 'thumb'/);
  const pkg = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('browser-chrome.html'));
  assert.ok(pkg.build.files.includes('browser-preload.cjs'));
});

test('a thumbnail leaves the chat full width', () => {
  const lay = embedFrames(1920, 1000, 'thumb');
  assert.equal(lay.mode, 'thumb');
  assert.equal(lay.main.width, 1920);
  assert.equal(lay.main.height, 1000);
  assert.equal(lay.page, null);
  assert.ok(lay.chrome.width <= 220);
  assert.ok(lay.chrome.x + lay.chrome.width <= 1920);
  assert.ok(lay.chrome.y + lay.chrome.height <= 1000);
  assert.ok(lay.chrome.width >= 120);
});

test('opening the browser docks it under a collapse bar', () => {
  const wide = embedFrames(1920, 1000, 'open');
  assert.equal(wide.mode, 'open');
  assert.ok(wide.main.width >= 920);
  assert.equal(wide.chrome.height, 40);
  assert.equal(wide.page.y, wide.chrome.y + wide.chrome.height);
  assert.equal(wide.main.width + wide.page.width, 1920);
  const narrow = embedFrames(1366, 768, 'open');
  assert.equal(narrow.main.width, 1366);
  assert.equal(narrow.chrome.y, narrow.main.height);
  assert.equal(narrow.page.y, narrow.chrome.y + narrow.chrome.height);
  assert.equal(narrow.main.height + narrow.chrome.height + narrow.page.height, 768);
});

test('a hidden browser does not take space', () => {
  const lay = embedFrames(1920, 1000, false);
  assert.equal(lay.mode, 'hidden');
  assert.equal(lay.main.width, 1920);
  assert.equal(lay.main.height, 1000);
  assert.equal(lay.page, null);
  assert.equal(lay.chrome, null);
});
