#!/usr/bin/env node
/*
  効果音の鳴らし分けをブラウザで確かめる（src/sound.js。docs/design/match/spec.md §2）

    node tools/check-sound.js

  なぜ要るか：
    `sound.js` は fetch と AudioContext を使うので node から直に呼べない。
    音そのものは聞けないが、**どの音源を選んだか**は観測できる——
    `AudioBufferSourceNode.prototype.buffer` の setter を包んで、
    渡された AudioBuffer の長さ（サンプル数）を控える。四本は長さが違うので、
    それで一本ずつ見分けられる。

  見るのは四つ。**音源を差し替えたら、また回すこと。**

    1. 打牌を20回鳴らして、読めた音源が全部出ること
    2. 同じものが二回続かないこと
    3. discard1.wav が無くても、残りで鳴ること（手で用意するので揃わない日がある）
    4. discard1〜4 が一本も無く discard.wav だけでも鳴ること（差し替えの途中）

  ファイルを消して試すのではなく、その URL だけ 404 に落として試す。
  audio/ には手を触れない。
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLAYS = 20;

function loadPlaywright() {
  const tries = ['playwright', 'playwright-core',
    '/usr/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright',
    '/opt/node22/lib/node_modules/playwright'];
  try {
    const g = require('child_process').execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (g) tries.push(path.join(g, 'playwright'));
  } catch (e) { /* npm が無くてもよい */ }
  for (const t of tries) { try { return require(t); } catch (e) { /* 次 */ } }
  console.error('playwright が見つからない。npm i -g playwright');
  process.exit(1);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wav': 'audio/wav' };
function serve(root) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (detail ? '  ' + detail : '')); }
}

(async () => {
  const { chromium } = loadPlaywright();
  const { srv, port } = await serve(ROOT);
  const browser = await chromium.launch();

  /* block … 404 に落とすファイル名（拡張子なし）。audio/ は触らない */
  async function run(block) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { console.log('  PAGEERROR ' + e.message); fail++; });
    /* 選んだ音源を控える。長さ（サンプル数）で一本ずつ見分ける */
    await page.addInitScript(() => {
      window.__picked = [];
      const proto = window.AudioBufferSourceNode && window.AudioBufferSourceNode.prototype;
      const d = proto && Object.getOwnPropertyDescriptor(proto, 'buffer');
      if (!d || !d.set) return;
      Object.defineProperty(proto, 'buffer', {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set(v) { if (v) window.__picked.push(v.length); d.set.call(this, v); },
      });
    });
    for (const name of block) {
      await page.route('**/audio/' + name + '.wav', (r) => r.fulfill({ status: 404, body: '' }));
    }
    await page.goto('http://127.0.0.1:' + port + '/match.html');
    await page.waitForFunction(() => typeof Sound !== 'undefined');
    const out = await page.evaluate(async (n) => {
      Sound.init();
      Sound.volume(1);
      await Sound.load();
      for (let i = 0; i < n; i++) Sound.play('discard');
      return { picked: window.__picked.slice(), loaded: Sound.loaded('discard'), names: Sound.NAMES };
    }, PLAYS);
    await ctx.close();
    return out;
  }

  console.log('効果音の鳴らし分け — src/sound.js');

  /* ---- 1・2. 四本そろっているとき ---- */
  console.log('\n四本そろっているとき（discard1〜4）');
  const all = await run([]);
  const uniq = [...new Set(all.picked)];
  ok(all.loaded === 4, '四本とも読めている', '読めた ' + all.loaded + '本');
  ok(all.picked.length === PLAYS, PLAYS + '回とも鳴った', '鳴った ' + all.picked.length + '回');
  ok(uniq.length === 4, '20回で四本すべてが出た', '出たのは ' + uniq.length + '種 ' + JSON.stringify(uniq));
  let repeats = 0;
  for (let i = 1; i < all.picked.length; i++) if (all.picked[i] === all.picked[i - 1]) repeats++;
  ok(repeats === 0, '同じものが二回続いていない', repeats + '回続いた');
  ok(JSON.stringify(all.names) === JSON.stringify(
    ['discard', 'draw', 'call', 'riichi', 'agari', 'deal', 'dora', 'ryuukyoku', 'tap']),
  'NAMES は論理名9つのまま', JSON.stringify(all.names));

  /* ---- 3. 一本欠けているとき ---- */
  console.log('\ndiscard1.wav が無いとき');
  const three = await run(['discard1']);
  ok(three.loaded === 3, '残り三本で立ち上がる', '読めた ' + three.loaded + '本');
  ok(three.picked.length === PLAYS, PLAYS + '回とも鳴った', '鳴った ' + three.picked.length + '回');
  ok([...new Set(three.picked)].length === 3, '残り三本が出た',
    JSON.stringify([...new Set(three.picked)]));
  let r3 = 0;
  for (let i = 1; i < three.picked.length; i++) if (three.picked[i] === three.picked[i - 1]) r3++;
  ok(r3 === 0, '同じものが二回続いていない', r3 + '回続いた');

  /* ---- 4. 差し替えの途中（discard.wav だけ） ---- */
  console.log('\ndiscard1〜4 が無く discard.wav だけのとき');
  const one = await run(['discard1', 'discard2', 'discard3', 'discard4']);
  ok(one.loaded === 1, '控えの一本に落ちる', '読めた ' + one.loaded + '本');
  ok(one.picked.length === PLAYS, PLAYS + '回とも鳴った（無音にならない）',
    '鳴った ' + one.picked.length + '回');

  /* ---- 念のため：全部無いとき ---- */
  console.log('\n打牌の音源が一本も無いとき');
  const none = await run(['discard', 'discard1', 'discard2', 'discard3', 'discard4']);
  ok(none.loaded === 0 && none.picked.length === 0, '黙って何もしない（落ちない）',
    '読めた ' + none.loaded + '本 / 鳴った ' + none.picked.length + '回');

  await browser.close();
  srv.close();
  console.log('\n通過 ' + pass + ' 件' + (fail ? ' / 失敗 ' + fail + ' 件' : ''));
  if (fail) process.exit(1);
  console.log('すべて通過');
})().catch((e) => { console.error(e); process.exit(1); });
