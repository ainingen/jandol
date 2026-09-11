#!/usr/bin/env node
/*
  プロローグをブラウザで回す（`docs/design/title/prologue-spec.md` §9 の 4〜8）

    node tools/drive-prologue.js
    node tools/drive-prologue.js --shots DIR    一画面目・最後の画面・とばすを撮る

  純関数の側（本文の形・副題との対・クラス名）は `tools/test-prologue.js` が見ている。
  ここで見るのは**画面**——出る／出ない、押したら進むこと、とばせること、
  閉じたあとに表紙の canvas が生きていること。

  **`index.html` で回すこと。**プロローグは表紙から入るので、
  単体ページ（team.html / taikai.html / meikan.html）には無い
  ——あれらは prologue.js を読まない（spec §5）。
  **`index.html` はビルド結果**なので、先に `python3 build.py` を回すこと。
  入っていなければ、その場で止めて言う（黙って全部落ちるより分かりやすい）。
*/
'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');

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
const { chromium } = loadPlaywright();

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.wav': 'audio/wav' };
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

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SHOTS = arg('--shots', null);

let pass = 0; const fails = [];
const ok = (c, n, d) => {
  if (c) { pass++; console.log('  ok  ' + n); }
  else { fails.push(n + (d ? ' … ' + d : '')); console.log('  NG  ' + n + (d ? ' … ' + d : '')); }
};
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n,
  'got ' + JSON.stringify(a) + ' / want ' + JSON.stringify(b));

const { PROLOGUE } = require('../src/prologue.js');
const PAGES = PROLOGUE.length;

/* 進行済みのセーブ（「続きから」を出すため）。中身は最小限でよい
   ——ここで見るのは「プロローグが出ないこと」だけ */
const DONE_SAVE = {
  discovered: [], contracted: [], comp: {}, favor: {},
  team: [], teamDecided: true, money: 500000, playerRank: 'D',
  records: {}, recent: [], beaten: [],
  playerName: 'テスト事務所', playerFace: 'p01',
  officeName: 'テスト事務所', officePref: 'tokyo',
  assign: {}, trip: null, offers: [], mailRead: [], local: {},
  offerFired: [], offerAccepted: [], popUp: {}, wins: {},
  fatigue: {}, cond: {}, fatigueDay: -1, condDay: -1,
};

/* 画面から読むもの */
const viewOf = (p) => p.evaluate(() => {
  const ls = Array.from(document.querySelectorAll('.plLine'));
  const skip = document.querySelector('.plSkip');
  const go = document.querySelector('.plGo');
  const r = skip ? skip.getBoundingClientRect() : null;
  return {
    root: !!document.querySelector('.plRoot'),
    lines: ls.length,
    shown: ls.filter((n) => n.classList.contains('on')).length,
    first: (ls[0] || {}).textContent || '',
    kin: ls.filter((n) => n.classList.contains('plKin')).length,
    dots: document.querySelectorAll('.plDot').length,
    dotOn: Array.from(document.querySelectorAll('.plDot')).findIndex((d) => d.classList.contains('on')),
    skip: !!skip,
    skipIn: !!r && r.top >= 0 && r.left >= 0
      && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
    skipBox: r ? { y: Math.round(r.top), b: Math.round(r.bottom) } : null,
    go: !!go && !go.hidden,
    setup: !!document.querySelector('.ttSetupT'),
    top: !!document.querySelector('[data-act="new"]'),
    /* 表紙の canvas が DOM にあり、中身が空でないこと（§9-8）。
       **画面のスクリーンショットでは判別できない**ので、canvas だけを読む */
    cover: (() => {
      const c = document.getElementById('cover');
      if (!c) return 'no canvas';
      if (getComputedStyle(c).display === 'none') return 'display:none';
      try {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4000) if (d[i] || d[i + 1] || d[i + 2]) n++;
        return n;
      } catch (e) { return 'tainted:' + e.message; }
    })(),
  };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 一画面ぶんが全部出るまで待つ（出きる前に押すと「残りを全部出す」になる） */
async function waitFilled(p) {
  for (let i = 0; i < 60; i++) {
    const v = await viewOf(p);
    if (v.lines && v.shown === v.lines) return v;
    await sleep(60);
  }
  return viewOf(p);
}

(async () => {
  const built = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  if (built.indexOf('prologue.js') < 0) {
    console.error('index.html に prologue.js が入っていません。'
      + 'python3 build.py を先に回すこと。');
    process.exit(1);
  }

  const { srv, port } = await serve();
  const base = 'http://127.0.0.1:' + port + '/';
  const browser = await chromium.launch();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  async function open(w, h, save) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => ok(false, 'PAGEERROR', e.message));
    if (save) {
      await p.goto(base + 'index.html');
      await p.evaluate((s) => localStorage.setItem('jandol_save_v1', JSON.stringify(s)), save);
    }
    await p.goto(base + 'index.html');
    await p.waitForSelector('[data-act="new"], [data-act="continue"]', { timeout: 10000 });
    /* 表紙の canvas は非同期に描く。読む前に一拍おく */
    await sleep(700);
    return { ctx, p };
  }

  /* ---------- [4] とばす（§9-4） ---------- */
  console.log('\n[4] 「はじめる」→ とばす');
  {
    const { ctx, p } = await open(812, 334, null);
    const before = await viewOf(p);
    ok(!before.root, 'はじめる前はプロローグが出ていない');
    await p.click('[data-act="new"]');
    await sleep(120);
    let v = await viewOf(p);
    ok(v.root, 'プロローグが出る');
    ok(v.skip, 'とばすが最初から出ている');
    eq(v.dots, PAGES, '点は画面数ぶん');
    eq(v.dotOn, 0, '一画面目が強調される');
    if (SHOTS) { await waitFilled(p); await p.screenshot({ path: path.join(SHOTS, 'page1.png') }); }
    await p.click('.plSkip');
    await sleep(250);
    v = await viewOf(p);
    ok(!v.root, 'とばすで覆いが消える');
    ok(v.setup, '「あなたのこと」が出る');
    await ctx.close();
  }

  /* ---------- [5] 画面数ぶん押す（§9-5） ---------- */
  console.log('\n[5] 「はじめる」→ 画面数ぶん押す');
  {
    const { ctx, p } = await open(812, 334, null);
    await p.click('[data-act="new"]');
    await sleep(60);

    /* 出ている途中で押したら、飛ばさずに**残りを全部出す**（§3） */
    let v = await viewOf(p);
    ok(v.shown < v.lines, '一画面目は順に出てくる', v.shown + '/' + v.lines);
    await p.click('.plText');
    await sleep(60);
    v = await viewOf(p);
    eq(v.shown, v.lines, '途中で押したら残りが全部出る');
    eq(v.dotOn, 0, '途中で押しても次の画面へは行かない');

    for (let i = 0; i < PAGES - 1; i++) {
      await waitFilled(p);
      await p.click('.plText');
      await sleep(300);
      v = await waitFilled(p);
      eq(v.dotOn, i + 1, (i + 2) + '画面目へ進む');
    }

    v = await waitFilled(p);
    eq(v.lines, PROLOGUE[PAGES - 1].length, '最後の画面の行数');
    eq(v.kin, 1, '最後の一行だけ金');
    ok(v.go, '最後の画面で釦が出る');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'last.png') });

    /* **最後の画面は押しても進まない**（§3）。誤爆で終わらせない */
    await p.click('.plText');
    await sleep(250);
    v = await viewOf(p);
    ok(v.root, '最後の画面は押しても閉じない');
    ok(!v.setup, '最後の画面は押しても設定画面へ行かない');

    await p.click('.plGo');
    await sleep(250);
    v = await viewOf(p);
    ok(!v.root, '釦で覆いが消える');
    ok(v.setup, '「あなたのこと」が出る');

    /* ---------- [8] 閉じたあとも表紙の canvas が生きている（§9-8） ---------- */
    ok(typeof v.cover === 'number', '#cover が DOM にあり読める', String(v.cover));
    ok(typeof v.cover === 'number' && v.cover > 0,
      '#cover の中身が空でない', String(v.cover));
    await ctx.close();
  }

  /* ---------- [6] 「続きから」では出ない（§9-6） ---------- */
  console.log('\n[6] 「続きから」ではプロローグが出ない');
  {
    const { ctx, p } = await open(812, 334, DONE_SAVE);
    let v = await viewOf(p);
    ok(!v.root, '表紙ではまだ出ていない');
    const hasContinue = await p.evaluate(() => !!document.querySelector('[data-act="continue"]'));
    ok(hasContinue, '進行済みのセーブで「続きから」が出る');
    await p.click('[data-act="continue"]');
    await sleep(600);
    v = await viewOf(p);
    ok(!v.root, '「続きから」でプロローグが出ない');
    ok(!v.setup, '「続きから」で設定画面にも行かない');

    /* 同じセーブでも「最初からはじめる」なら出る（§1 の表） */
    await p.goto(base + 'index.html');
    await p.waitForSelector('[data-act="new"]', { timeout: 10000 });
    await p.click('[data-act="new"]');
    await sleep(120);
    v = await viewOf(p);
    ok(v.root, '「最初からはじめる」では出る');
    await ctx.close();
  }

  /* ---------- [7] とばすが画面の中にいる（§9-7） ---------- */
  console.log('\n[7] とばすが画面の中にいる');
  for (const [w, h] of [[812, 334], [375, 812]]) {
    const { ctx, p } = await open(w, h, null);
    await p.click('[data-act="new"]');
    await sleep(120);
    const v = await waitFilled(p);
    ok(v.skip, w + '×' + h + '：とばすがある');
    ok(v.skipIn, w + '×' + h + '：とばすが画面の中にいる', JSON.stringify(v.skipBox));
    /* 本文も画面の中に収まっていること（§6。入りきらなければ流れる） */
    const fits = await p.evaluate(() => {
      const r = document.querySelector('.plRoot');
      return r.scrollHeight <= r.clientHeight;
    });
    ok(fits, w + '×' + h + '：一画面ぶんが流さずに収まる');
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'skip-' + w + 'x' + h + '.png') });
    await ctx.close();
  }

  await browser.close();
  srv.close();

  console.log('\n' + pass + '件');
  if (fails.length) {
    console.error('落ちた ' + fails.length + '件:');
    fails.forEach((f) => console.error('  ' + f));
    process.exit(1);
  }
})();
