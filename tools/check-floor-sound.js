#!/usr/bin/env node
/*
  営業中の店の牌の音（`src/ui-sound.js` の (B)。spec.md §2.7）

    node tools/check-floor-sound.js

  **一秒あたりの回数は、押して測るしかない。**`test-match.js` は
  「上限の定数が一箇所にある」ところまでしか見られない。

  見るのは五つ。

    1. **等速（×1）で鳴る**こと。一秒あたりの最大が上限（3回/秒）以内
    2. **倍速（×2 / ×4）で減る**こと。上限を速さで割ったところに収まる
    3. **スキップでは一度も鳴らない**こと
       ——skip は一フレームで残りのタイムラインを全部飲み干すので、
       素通しにすると数百本が一度に飛ぶ
    4. **タブが隠れているあいだは鳴らない**こと（`document.hidden`）
    5. **鳴らすのは discard と draw だけ**——営業に和了やリーチを当てない

  測りかたは**滑る一秒窓の最大**。日の平均で測ると、ポップアップで
  止まっているあいだが分母に入って、いくらでも小さく見える。
  **機械銃になっていないか**を知りたいので、いちばん混んだ一秒を見る。
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.wav': 'audio/wav' };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 滑る一秒窓の最大（回/秒） */
function peak(times) {
  let best = 0;
  for (let i = 0; i < times.length; i++) {
    let n = 0;
    for (let j = i; j < times.length && times[j] - times[i] < 1000; j++) n++;
    if (n > best) best = n;
  }
  return best;
}

(async () => {
  const { srv, port } = await serve();
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 380, height: 740 } });
  const p = await ctx.newPage();
  /* 営業の音だけを、鳴った時刻ごと控える（対局の中は数えない） */
  await p.addInitScript(() => {
    window.__floor = []; window.__names = {};
    const hook = () => {
      if (typeof Sound === 'undefined' || Sound.__hooked) return;
      const orig = Sound.play;
      Sound.play = function (n, o) {
        if (!document.body.classList.contains('inMatch') && n !== 'tap') {
          window.__floor.push(performance.now());
          window.__names[n] = (window.__names[n] || 0) + 1;
        }
        return orig.call(Sound, n, o);
      };
      Sound.__hooked = true;
    };
    document.addEventListener('DOMContentLoaded', hook);
    setTimeout(hook, 300);
  });
  p.on('pageerror', (e) => { fails.push('PAGEERROR ' + e.message); console.log('  NG  PAGEERROR ' + e.message); });

  const base = 'http://127.0.0.1:' + port + '/';
  await p.goto(base + 'debug.html');
  await p.evaluate(() => {
    JandolDebug.apply('asobu');
    const s = JSON.parse(localStorage.getItem('jandol_save_v1'));
    s.autoMatch = true;                 // 夜のボトル勝負は数値処理に落とす
    if (!s.officePref) s.officePref = 'tokyo';
    localStorage.setItem('jandol_save_v1', JSON.stringify(s));
  });
  await p.goto(base + 'index.html');
  await p.waitForSelector('[data-act="continue"]', { timeout: 15000 });
  await p.click('[data-act="continue"]');
  await p.waitForSelector('#ofRoomHost', { timeout: 15000 });

  const snap = () => p.evaluate(() => {
    const vis = (s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.offsetParent !== null; };
    const pop = document.querySelector('.popup');
    const skip = document.querySelector('[data-skip]');
    return {
      popup: !!pop, pick: !!document.querySelector('.popup [data-pick]'),
      skipVisible: !!skip && !skip.hidden,
      floor: !!document.querySelector('.jnFloor'),
      run: vis('#ofBand #ofRun'), sheet: vis('.ofSheet'),
      nextSheet: vis('.ofSheet #ofNext'), nextBand: vis('#ofBand #ofNext'),
    };
  });

  /* 一日を回す。`speed` を渡すとフロアが出た時点でその速さにする。
     `useSkip` ならスキップを押す。返すのは営業中に鳴った時刻の並び */
  async function runDay(speed, useSkip) {
    await p.evaluate(() => { window.__floor = []; window.__names = {}; });
    let st = await snap();
    /* 朝に戻っていなければ戻るまで送る */
    for (let i = 0; i < 40 && !st.run; i++) {
      if (st.pick) await p.click('.popup [data-pick]').catch(() => {});
      else if (st.popup) await p.click('.popup [data-key]:not([disabled])').catch(() => {});
      else if (st.nextSheet || st.nextBand) await p.click(st.nextSheet ? '.ofSheet #ofNext' : '#ofBand #ofNext').catch(() => {});
      else if (st.skipVisible) await p.click('[data-skip]:not([hidden])').catch(() => {});
      await sleep(250); st = await snap();
    }
    await p.click('#ofBand #ofRun');
    let sped = false, skipped = false;
    const t0 = Date.now();
    for (;;) {
      st = await snap();
      if (st.floor && !sped && speed) {
        await p.click('.jnFlSp[data-speed="' + speed + '"]').catch(() => {});
        sped = true;
      }
      if (useSkip && st.skipVisible && !skipped) {
        await p.click('[data-skip]:not([hidden])').catch(() => {});
        skipped = true;
      } else if (st.pick) await p.click('.popup [data-pick]').catch(() => {});
      else if (st.popup) await p.click('.popup [data-key]:not([disabled])').catch(() => {});
      else if (st.nextSheet || st.nextBand) break;
      await sleep(180);
      if (Date.now() - t0 > 180000) { fails.push('一日が終わらない'); break; }
    }
    return p.evaluate(() => ({ at: window.__floor.slice(), names: Object.assign({}, window.__names) }));
  }

  console.log('\n[1][2] 速さごとの一秒あたりの回数（滑る一秒窓の最大）');
  const got = {};
  for (const sp of [1, 2, 4]) {
    const r = await runDay(sp, false);
    const cap = 3 / sp;                       // FLOOR_MAX_PER_SEC / speed
    got[sp] = { n: r.at.length, peak: peak(r.at), names: r.names };
    console.log('  ×' + sp + '　鳴った ' + r.at.length + ' 回　最大 ' + got[sp].peak
      + ' 回/秒（上限 ' + cap.toFixed(2) + '）　' + JSON.stringify(r.names));
  }
  ok(got[1].n > 0, '等速（×1）で鳴る');
  /* 窓の端の丸めで1回ぶん多く数えうるので +1 まで許す */
  ok(got[1].peak <= 3 + 1, '×1 の最大が 3回/秒 以内', String(got[1].peak));
  ok(got[2].peak <= 1.5 + 1, '×2 の最大が 1.5回/秒 以内', String(got[2].peak));
  ok(got[4].peak <= 0.75 + 1, '×4 の最大が 0.75回/秒 以内', String(got[4].peak));
  ok(got[2].peak <= got[1].peak && got[4].peak <= got[2].peak,
    '**倍速ほど減る**（×1 ≥ ×2 ≥ ×4）',
    [got[1].peak, got[2].peak, got[4].peak].join(' / '));
  const kinds = Object.keys(got[1].names).concat(Object.keys(got[2].names)).sort();
  ok(kinds.every((k) => k === 'discard' || k === 'draw'),
    '鳴らすのは discard と draw だけ', kinds.join(','));

  console.log('\n[3] スキップでは鳴らない');
  const sk = await runDay(1, true);
  console.log('  スキップ　鳴った ' + sk.at.length + ' 回');
  ok(sk.at.length === 0, '**スキップ中は一度も鳴らない**', String(sk.at.length));

  console.log('\n[4] タブが隠れているあいだは鳴らない');
  const hidden = await p.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    const a = UiSound.floor('pay', 1);
    Object.defineProperty(document, 'hidden', d ? d : { get: () => false, configurable: true });
    return a;
  });
  ok(hidden === false, 'document.hidden のあいだは鳴らない');

  console.log('\n[5] 時計を持たない（相乗りしている）');
  const timers = await p.evaluate(() => {
    /* 営業が終わったあと、誰も鳴らし続けていないこと */
    const before = window.__floor.length;
    return new Promise((r) => setTimeout(() => r(window.__floor.length - before), 1500));
  });
  ok(timers === 0, '営業が終われば鳴りやむ（止めかたが要らない）', String(timers));

  await br.close(); srv.close();
  console.log('\n通過 ' + pass + ' 件');
  if (fails.length) { console.log('NG ' + fails.length + ' 件'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  console.log('すべて通過');
})();
