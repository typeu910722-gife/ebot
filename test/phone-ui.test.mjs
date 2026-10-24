import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('phone sheets rise from the bottom and menus become action sheets with a cancel', () => {
  assert.match(page, /\.veil\{place-items:end center;padding:0\}/);
  assert.match(page, /@keyframes sheetup/);
  assert.match(page, /\.menu\.asheet\{/);
  assert.match(page, /class="mcancel">取消</);
  assert.match(page, /\.mveil\{position:fixed;inset:0/);
});

test('holding or right-clicking a row or a message opens its menu, and a message can be sent on', () => {
  assert.match(page, /function holdOn\(root,find,open\)/);
  assert.match(page, /addEventListener\('contextmenu'/);
  assert.match(page, /holdOn\(\$\('list'\)/);
  assert.match(page, /holdOn\(\$\('msgs'\)/);
  assert.match(page, /傳給別的機器人…/);
  assert.match(page, /function pickTarget\(m\)/);
  assert.match(page, /askCopy\(b\.dataset\.to,msg\)/);
  // a long press must not also start a drag, and the lift that ends it must not close the menu it opened
  assert.match(page, /if\(e\.target\.closest\('\.more'\)\|\|lpHit\)\{e\.preventDefault\(\);return\}/);
  assert.match(page, /document\.addEventListener\('click',e=>\{if\(lpHit\)return;if\(!e\.target\.closest\('\.menu'\)\)closeMenu\(\)\}\)/);
  // the phone header keeps the name readable: task settings live under ⋯
  assert.match(page, /\.ph #railToggle,\.ph #modelBtn,\.ph #edit\{display:none\}/);
});

test('back goes up one level on a phone instead of leaving the page', () => {
  assert.match(page, /window\.addEventListener\('popstate'/);
  assert.match(page, /function navPush\(k\)\{if\(!phoneUI\(\)\)return;if\(navSkip>0\)\{navQueue\.push\(k\);return\}/);
  assert.match(page, /new MutationObserver\(\(\)=>\{if\(!\$\('veil'\)\.hidden\)/);
  assert.match(page, /navPush\('chat'\)/);
  assert.match(page, /t\.clientX<28&&\$\('app'\)\.classList\.contains\('chat'\)/);
  assert.match(page, /if\(dy>110\)closeSheet\(\)/);
});

test('chats get day separators and the phone send key is the round arrow', () => {
  assert.match(page, /function dayLabel\(ts\)/);
  assert.match(page, /I18N\.t\('昨天'\)/);
  assert.match(page, /class="day"/);
  assert.match(page, /<span class="sl">送出<\/span><span class="sa2" aria-hidden="true">↑<\/span>/);
  assert.match(page, /const COARSE=matchMedia\('\(hover:none\) and \(pointer:coarse\)'\)\.matches/);
  assert.match(page, /&&!COARSE\)\{e\.preventDefault\(\);\$\('f'\)\.requestSubmit\(\)\}/);
  assert.match(page, /@media \(hover:none\)\{\n  \.item\{padding:12px 8px;min-height:60px\}/);
});
