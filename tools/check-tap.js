#!/usr/bin/env node
/*
  釦の音を全画面に通す（`src/ui-sound.js`。docs/design/match/spec.md §2.7）

    node tools/check-tap.js

  **ブラウザでしか確かめられない側。**委譲の listener は `document` に
  一つだけ置いてあるので、Node の require では一度も動かない。

  見るのは七つ。

    1. **最初の pointerdown で `Sound.init()` と `Sound.load()` が走る**こと。
       いままでは大会の「卓に着く」だけが解除の口で、表紙から入って
       事務所を触っても AudioContext が無かった。**二度目からは呼ばない**
    2. 表紙・事務所・雀荘・大会・名鑑・チーム・名簿・遠征の釦で `tap` が鳴ること
    3. **釦でないところを押しても鳴らない**こと（画面の地・部屋の絵）
    4. **対局中は鳴らない**こと（`body.inMatch`）。牌は `<span>` なので
       元より引っかからないが、鳴きの釦は `UI.buttons` が自分で `tap` を
       鳴らしている。二重に鳴らすとそこだけ耳につく
    5. `[data-nosound]` の下では鳴らないこと（逃げ道が効くこと）
    6. **音量0では一度も鳴らない**こと（`Sound.play` の `vol <= 0`）
    7. 連打（20回）で取りこぼさず、`AudioContext` が一つのままであること
    8. **事務所・大会の要所**（`UiSound.cue`）が、場面の名前だけで鳴ること。
       表に無い場面では鳴らないこと、対局中は鳴らないこと。
       **実際に出る場面まで押す側**は、夜の日報（`report`）をここで通す
       ——発見（`find`）は遠征を何日も回すので `drive-office.js --real`、
       勝ち上がり（`advance`）は大会を打つので `drive-taikai-round.js` の土地

  `Sound.play` は実際に鳴らすところまで通す（headless でも `AudioContext` は
  作れる）。数えるのは `window.__sfx`——`tools/drive-office.js` と同じ仕掛け。
*/
'use strict';
const path = require('path'), http = require('http'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
function lp() {
  const t = ['playwright', 'playwright-core'];
  try {
    const g = require('child_process').execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (g) t.push(path.join(g, 'playwright'));
  } catch (e) {}
  for (const x of t) { try { return require(x); } catch (e) {} }
  console.error('playwright が無い'); process.exit(1);
}
const { chromium } = lp();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wav': 'audio/wav' };
function serve() {
  return new Promise((res) => {
    const srv = http.createServer((rq, rs) => {
      const f = path.join(ROOT, decodeURIComponent(rq.url.split('?')[0]));
      fs.readFile(f, (e, b) => {
        if (e) { rs.writeHead(404); rs.end(''); return; }
        rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
        rs.end(b);
      });
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}
let pass = 0; const fails = [];
const ok = (c, n, d) => { if (c) { pass++; console.log('  ok  ' + n); } else { fails.push(n); console.log('  NG  ' + n + (d ? ' … ' + d : '')); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n, 'got ' + JSON.stringify(a) + ' / want ' + JSON.stringify(b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { srv, port } = await serve();
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 380, height: 740 } });
  const p = await ctx.newPage();
  /* `Sound` の入口を数える。**play は本物を通す**（音量0で黙ることまで見たいので、
     途中で握り潰さない）。init / load は回数だけ控えて素通し */
  await p.addInitScript(() => {
    window.__sfx = {}; window.__init = 0; window.__load = 0;
    const hook = () => {
      if (typeof Sound === 'undefined' || Sound.__hooked) return;
      const play = Sound.play, init = Sound.init, load = Sound.load;
      Sound.play = function (n, o) { window.__sfx[n] = (window.__sfx[n] || 0) + 1; return play.call(Sound, n, o); };
      Sound.init = function () { window.__init++; return init.call(Sound); };
      Sound.load = function () { window.__load++; return load.call(Sound); };
      Sound.__hooked = true;
    };
    document.addEventListener('DOMContentLoaded', hook);
    setTimeout(hook, 300);
  });
  p.on('pageerror', (e) => { fails.push('PAGEERROR ' + e.message); console.log('  NG  PAGEERROR ' + e.message); });

  const base = 'http://127.0.0.1:' + port + '/';
  const taps = () => p.evaluate(() => (window.__sfx || {}).tap || 0);
  const counts = () => p.evaluate(() => ({ tap: (window.__sfx || {}).tap || 0, init: window.__init, load: window.__load }));
  /* 押す。**実際のポインタ列**（mouse.down/up）で押すものと、
     画面を壊さずに押しだけ見たいところは dispatchEvent で pointerdown を出す。
     どちらも document まで上がるので、委譲の listener から見れば同じ */
  async function press(sel) {
    const before = await taps();
    await p.dispatchEvent(sel, 'pointerdown', { bubbles: true });
    await sleep(30);
    return (await taps()) - before;
  }
  async function realPress(sel) {
    const before = await taps();
    const b = await p.evaluate((s) => {
      const e = document.querySelector(s); const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, sel);
    await p.mouse.move(b.x, b.y); await p.mouse.down(); await p.mouse.up();
    await sleep(120);
    return (await taps()) - before;
  }
  /* その画面でいま押せる釦を一つ選ぶ（見えていて disabled でないもの）。
     **`#view` の中だけを見る**——下のタブや上の帯を拾うと、
     どの画面でも同じ釦を押して「鳴った」と言うことになる */
  const firstBtn = () => p.evaluate(() => {
    const root = document.querySelector('#view') || document;
    const list = Array.from(root.querySelectorAll('button'));
    const e = list.find((b) => !b.disabled && b.offsetParent !== null
      && b.getBoundingClientRect().width > 4);
    if (!e) return null;
    e.id = e.id || '__tapProbe';
    return '#' + e.id;
  });
  async function ringsHere(label) {
    const sel = await firstBtn();
    if (!sel) { ok(false, label + 'の釦で鳴る', '押せる釦が見つからない'); return; }
    ok(await press(sel) === 1, label + 'の釦で鳴る', sel);
  }

  /* ---------- 下ごしらえ：遊べるセーブ ---------- */
  await p.goto(base + 'debug.html');
  await p.evaluate(() => {
    JandolDebug.apply('asobu');
    const s = JSON.parse(localStorage.getItem('jandol_save_v1'));
    s.autoMatch = true;
    if (!s.officePref) s.officePref = 'tokyo';
    localStorage.setItem('jandol_save_v1', JSON.stringify(s));
  });

  console.log('\n[1] 最初の pointerdown で初期化が走る');
  await p.goto(base + 'index.html');
  await p.waitForSelector('[data-act="continue"]', { timeout: 15000 });
  let c = await counts();
  eq([c.init, c.load], [0, 0], '押す前は AudioContext を作っていない（自動再生制限）');
  const n1 = await realPress('[data-act="continue"]');
  ok(n1 === 1, '**表紙**の「続きから」を実際に押すと鳴る');
  c = await counts();
  eq([c.init, c.load], [1, 1], '最初の pointerdown で init / load が一度ずつ');
  await p.waitForSelector('#ofRoomHost', { timeout: 15000 });
  await press('#ofRoomHost');
  c = await counts();
  eq([c.init, c.load], [1, 1], '**二度目からは呼ばない**');

  console.log('\n[2] 画面ごとに鳴る');
  await ringsHere('事務所');
  /* 部屋の物（`.ofRoomHit`）。**札（`.jnFlTag`）は当たりではない**
     ——`.jnFlUi` が `pointer-events:none` なので、指は下の釦に当たる。
     押せるのは釦のほうなので、鳴らすのも釦のほう */
  ok(await realPress('.ofRoomHit[data-tap="desk"]') === 1, '**部屋の物**（事務机＝名簿）で鳴る');
  await p.waitForSelector('.ofSheet', { timeout: 5000 });
  await ringsHere('名簿のシート');
  if (await p.$('.ofSheetClose')) { await realPress('.ofSheetClose'); await sleep(250); }

  for (const [go, label] of [['jansou', '雀荘'], ['taikai', '大会'], ['meikan', '名鑑'], ['team', 'チーム']]) {
    const n = await realPress('[data-go="' + go + '"]');
    ok(n === 1, 'タブ（' + label + '）で鳴る');
    await sleep(350);
    await ringsHere(label);
  }

  /* 遠征の下書き（事務所の扉 → 出かける） */
  await realPress('[data-go="office"]'); await sleep(400);
  ok(await realPress('.ofRoomHit[data-tap="door"]') === 1, '**遠征**の入口（扉）で鳴る');
  await p.waitForSelector('.ofSheet', { timeout: 5000 });
  await ringsHere('遠征の下書き');
  if (await p.$('.ofSheetClose')) { await realPress('.ofSheetClose'); await sleep(250); }

  console.log('\n[3] 釦でないところは鳴らない');
  await realPress('[data-go="office"]'); await sleep(400);
  eq(await press('#scroll'), 0, '画面の地を押しても鳴らない');
  eq(await press('#ofRoomHost'), 0, '部屋の絵（canvas の親）を押しても鳴らない');

  console.log('\n[4][5] 除きかたは muted() 一つで決める');
  await p.evaluate(() => {
    /* 対局中の印を立てるだけ。実際に打つのは drive-match.js の仕事 */
    document.body.classList.add('inMatch');
    const b = document.createElement('button');
    b.id = '__tapIn'; b.textContent = 'x';
    document.body.appendChild(b);
    const box = document.createElement('div');
    box.setAttribute('data-nosound', '');
    const b2 = document.createElement('button'); b2.id = '__tapNo'; b2.textContent = 'y';
    box.appendChild(b2); document.body.appendChild(box);
  });
  eq(await press('#__tapIn'), 0, '**body.inMatch のあいだは鳴らない**（tap と discard の二重を避ける）');
  await p.evaluate(() => document.body.classList.remove('inMatch'));
  eq(await press('#__tapIn'), 1, 'inMatch を外せば鳴る（対照）');
  eq(await press('#__tapNo'), 0, '[data-nosound] の下では鳴らない');

  console.log('\n[6] 音量0では鳴らない');
  await p.evaluate(() => Sound.volume(0));
  eq(await press('#__tapIn'), 1, '音量0でも委譲は Sound.play まで来る（数えているのは入口）');
  const rang = await p.evaluate(() => Sound.play('tap'));
  eq(rang, null, '**音量0なら Sound.play が null を返す**（一本も鳴らない）');
  await p.evaluate(() => Sound.volume(1));

  console.log('\n[7] 連打');
  const b0 = await taps();
  for (let i = 0; i < 20; i++) await p.dispatchEvent('#__tapIn', 'pointerdown', { bubbles: true });
  await sleep(200);
  eq((await taps()) - b0, 20, '20連打で20回（取りこぼさない）');
  const one = await p.evaluate(() => window.__init);
  eq(one, 1, 'AudioContext は一つのまま');

  console.log('\n[8] 事務所・大会の要所（UiSound.cue）');
  const cues = await p.evaluate(() => {
    const before = Object.assign({}, window.__sfx);
    const n = (k) => (window.__sfx[k] || 0) - (before[k] || 0);
    const out = {};
    out.find = [UiSound.cue('find'), n('dora')];
    out.advance = [UiSound.cue('advance'), n('agari')];
    out.report = [UiSound.cue('report'), n('ryuukyoku')];
    out.unknown = UiSound.cue('taiya');
    out.none = UiSound.cue();
    document.body.classList.add('inMatch');
    out.inMatch = UiSound.cue('find');
    document.body.classList.remove('inMatch');
    out.table = Object.keys(UiSound.CUE).sort();
    return out;
  });
  eq(cues.find, [true, 1], "'find'（遠征で見つけた）が dora を鳴らす");
  eq(cues.advance, [true, 1], "'advance'（勝ち上がり）が agari を鳴らす");
  eq(cues.report, [true, 1], "'report'（夜の日報）が ryuukyoku を鳴らす");
  eq(cues.unknown, false, '表に無い場面では鳴らない');
  eq(cues.none, false, '名前を渡さなければ鳴らない');
  eq(cues.inMatch, false, '対局中は鳴らない（(A)(B) と同じ muted の判じ方）');
  eq(cues.table, ['advance', 'find', 'report'], 'CUE は三つだけ');

  console.log('\n[8b] 夜の日報が開いたら、実際に鳴ること');
  /* 朝 →「今日を始める」→ 営業（スキップ）→ 夜。日報はシートが開いた最初の一度だけ */
  await p.evaluate(() => { window.__sfx = {}; });
  await realPress('[data-go="office"]'); await sleep(400);
  {
    const t0 = Date.now();
    let ran = false;
    for (;;) {
      const st = await p.evaluate(() => {
        const vis = (s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.offsetParent !== null; };
        const skip = document.querySelector('[data-skip]');
        return {
          popup: !!document.querySelector('.popup'),
          pick: !!document.querySelector('.popup [data-pick]'),
          skipVisible: !!skip && !skip.hidden,
          run: vis('#ofBand #ofRun'),
          nextSheet: vis('.ofSheet #ofNext'), nextBand: vis('#ofBand #ofNext'),
          ryuukyoku: (window.__sfx || {}).ryuukyoku || 0,
        };
      });
      if (st.nextSheet || st.nextBand) { ran = st.ryuukyoku > 0; break; }
      if (st.run) await p.click('#ofBand #ofRun').catch(() => {});
      else if (st.pick) await p.click('.popup [data-pick]').catch(() => {});
      else if (st.popup) await p.click('.popup [data-key]:not([disabled])').catch(() => {});
      else if (st.skipVisible) await p.click('[data-skip]:not([hidden])').catch(() => {});
      await sleep(200);
      if (Date.now() - t0 > 120000) break;
    }
    ok(ran, '**夜の日報が開いた一度だけ鳴る**（一日を回して確認）');
    /* 日報を閉じて開き直しても、その晩はもう鳴らない */
    const again = await p.evaluate(() => {
      const b = document.querySelector('.ofSheetClose');
      if (b) b.click();
      const n0 = (window.__sfx || {}).ryuukyoku || 0;
      const d = document.querySelector('.ofRoomHit[data-tap="desk"]');
      if (d) d.click();
      return ((window.__sfx || {}).ryuukyoku || 0) - n0;
    });
    eq(again, 0, '同じ晩に開き直しても鳴らない');
  }

  await br.close(); srv.close();
  console.log('\n通過 ' + pass + ' 件');
  if (fails.length) { console.log('NG ' + fails.length + ' 件'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  console.log('すべて通過');
})();
