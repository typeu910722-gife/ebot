import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const log = JSON.parse(readFileSync(new URL('../public/changelog.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));

test('the look is switched only inside Settings, and the colours fade across', () => {
  assert.doesNotMatch(page, /data-theme-btn/);
  assert.doesNotMatch(page, /id="hTheme"|id="lTheme"|id="theme"/);
  assert.match(page, /h\.classList\.add\('theming'\)/);
  assert.match(page, /html\.theming,html\.theming \*,html\.theming \*::before,html\.theming \*::after\{transition:background-color \.45s ease,color \.45s ease/);
  assert.match(page, /data-set-theme="dark"/);
  assert.match(page, /data-set-theme="light"/);
});

test('text size applies to the whole interface and is remembered on the device', () => {
  assert.match(page, /const FS=\{s:'小',m:'標準',l:'大',xl:'特大'\}/);
  assert.match(page, /function applyFs\(k\)/);
  assert.match(page, /localStorage\.setItem\('octa_fs',k\)/);
  // applied before first paint, like the theme
  assert.match(page, /var f=localStorage\.getItem\('octa_fs'\);if\(f&&f!=='m'\)document\.documentElement\.setAttribute\('data-fs',f\)/);
  assert.match(page, /html\[data-fs="s"\]\{--fz:\.93\}html\[data-fs="l"\]\{--fz:1\.12\}html\[data-fs="xl"\]\{--fz:2\}/);
  assert.match(page, /html\[data-fs\] body\{font-size:calc\(15px \* var\(--fz\)\)\}/);
  assert.match(page, /html\[data-fs\] \.bub\{font-size:calc\(15px \* var\(--fz\)\)\}/);
  assert.match(page, /data-set-fs="\$\{k\}"/);
});

test('settings on a big screen is one wide two-pane page; the phone keeps the stacked list', () => {
  assert.match(page, /const settingsShell=\(\)=>!phoneUI\(\)/);
  assert.match(page, /function settingsFrame\(\)/);
  assert.match(page, /<div class="sheet settings">/);
  assert.match(page, /<nav class="snav"/);
  assert.match(page, /<div class="sbody" id="sbody">/);
  assert.match(page, /\.sgrid\{display:grid;grid-template-columns:236px minmax\(0,1fr\)/);
  assert.match(page, /\.sheet\.settings\{width:min\(980px,100%\)/);
  // the first page is 外觀 (look): theme, text size, language
  assert.match(page, /\['look','🎨','外觀','深色或紙色、字體大小、語言'\]/);
  assert.match(page, /function openLook\(\)/);
  assert.match(page, /if\(settingsShell\(\)&&!opts\.solo\)\{/);
  // pages opened from elsewhere still render inside the shell; what's-new stays its own sheet
  assert.match(page, /\{back:closeSheet,solo:true\}/);
  // coding pages render into the shell too, and leaving them stops the poll
  assert.match(page, /function codeFrame\(inner\)/);
  assert.match(page, /if\(typeof stopCodePoll==='function'\)stopCodePoll\(\);settingsGo\[b\.dataset\.s\]\(\)/);
  // the phone list no longer carries the theme buttons inline
  const phoneList = page.slice(page.indexOf('function openSettings(k)'), page.indexOf('const when=t=>'));
  assert.doesNotMatch(phoneList, /theme-pick/);
  assert.match(phoneList, /<nav class="smenu">/);
});

test('attachments show as thumbnails or file cards before and after sending', () => {
  assert.match(page, /class="chip pic\$\{f\.up\?' up':''\}"><img src="\$\{f\.url\}"/);
  assert.match(page, /class="chip file\$\{f\.up\?' up':''\}"><span class="fico">/);
  assert.match(page, /url:\/\^image\\\/\/\.test\(file\.type\)\?URL\.createObjectURL\(file\):''/);
  assert.match(page, /fileCache\[r\.id\]=Promise\.resolve\(\{name,mime,data\}\)/);
  assert.match(page, /class="fcard" data-open-file="\$\{esc\(f\.id\)\}"/);
  assert.match(page, /function fico\(name,mime\)/);
  assert.match(page, /const fsize=n=>/);
  assert.match(page, /\.chip\.pic\{position:relative;padding:0;border-radius:12px;overflow:hidden;width:64px;height:64px/);
  // the server keeps the size with the message so cards show it after a reload, in the order they were attached
  assert.match(api, /SELECT id,name,mime,size FROM files WHERE user_id=\? AND id IN/);
  assert.match(api, /files\.sort\(\(x, y\) => fileIds\.indexOf\(x\.id\) - fileIds\.indexOf\(y\.id\)\)/);
});

test('the desktop version matches the changelog, and the appearance release is still recorded', () => {
  assert.equal(pkg.version, log[0].v);
  assert.equal(log[0].v, '3.0.16');
  assert.ok(log[0].notes.some(n => n.includes('兩倍')));
  const look = log.find(x => x.v === '3.0.13');
  assert.ok(look.notes.some(n => n.includes('字體大小')));
  assert.ok(look.notes.some(n => n.includes('縮圖')));
});
