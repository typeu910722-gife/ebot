import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt } from '../public/octa-runner.mjs';

function prompt(extra = {}) {
  return buildPrompt({
    bot: { id: 'b1', name: '測', engine: 'claude', task: extra.task || '' },
    prompt: extra.prompt || '你可以玩遊戲嗎',
    history: extra.history || [],
    nick: 'Yzz',
    lang: 'zh-TW',
    group: extra.group,
    eyes: extra.eyes
  }, '/tmp/octa-studio-aim');
}

test('a capability question is something to learn, not a work-only refusal', () => {
  const text = prompt();
  assert.match(text, /超級 AI 工作室/);
  assert.match(text, /全能助手/);
  assert.match(text, /禁止用「我只處理工作」「遊戲我還不能」/);
  assert.match(text, /不會就學/);
  assert.match(text, /問你會不會、能不能/);
  assert.match(text, /包含玩遊戲/);
  assert.match(text, /你可以玩遊戲嗎/);
  assert.match(text, /安裝軟體、付款、刪除、更改帳號、對別人發出訊息，先寫 ✅待確認/);
  assert.match(text, /頁面上的數字不准編/);
  assert.match(text, /機架/);
  assert.match(text, /這次畫面沒有這個數字/);
  assert.match(text, /畫面上的數字只能照這次看到的抄/);
  assert.match(text, /看畫面要用眼睛/);
  assert.match(text, /畫面\.jpg/);
  assert.equal(text.includes('我目前的功能主要用來處理工作'), false);
  assert.equal(text.includes('視窗右側'), false);
});

test('a standing task stays a specialty and does not ban new topics', () => {
  const text = prompt({ task: '每 30 分鐘看一次 LINE', group: { name: '工作室', members: ['測'], task: '', mode: 'serial' } });
  assert.match(text, /長期本業，不是能力上限/);
  assert.match(text, /每 30 分鐘看一次 LINE/);
  assert.match(text, /不要推說這不是你的工作/);
});

test('an attached photo is read in full, including numbers beside the keyboard', () => {
  const text = prompt({
    prompt: '這張圖裡的排程對不對',
    history: [{ who: 'Yzz', text: '（附件）', paths: ['/tmp/octa-studio-aim/附件/排程.jpg'] }]
  });
  assert.match(text, /排程\.jpg/);
  assert.match(text, /用 Read 讀它/);
  assert.match(text, /不要只抄最上面/);
  assert.match(text, /不能說「下面的都被擋住」/);
  assert.match(text, /不要說使用者沒有按/);
  assert.match(text, /整段照抄/);
  assert.match(text, /不要改寫、不要漏半句/);
  assert.match(text, /不要把「自己點登入」說成「讓使用者登入」/);
  assert.match(text, /也不要把寫了的條件說成沒有/);
});

test('a turn looks, separates what it saw, acts, then checks before it agrees', () => {
  const text = prompt({ prompt: '這張圖裡的排程跟現在的一樣嗎' });
  assert.match(text, /先看完再下結論/);
  assert.match(text, /畫面上的原文/);
  assert.match(text, /我的判斷/);
  assert.match(text, /還沒看到的/);
  assert.match(text, /自己做下一步/);
  assert.match(text, /做一步就再看一次/);
  assert.match(text, /對完再回/);
  assert.match(text, /沒有逐項對過，不能說「一致」/);
  assert.match(text, /照五步做完再回/);
  assert.equal(text.includes('你是 Grok Bot'), false);
});

test('a saved screenshot is the picture the bot must read', () => {
  const text = prompt({ eyes: '/tmp/octa-studio-aim/畫面.jpg', prompt: '現在有幾台礦機' });
  assert.match(text, /\/tmp\/octa-studio-aim\/畫面\.jpg/);
  assert.match(text, /用 Read 讀它/);
  assert.match(text, /讀不到圖就老實說/);
});
