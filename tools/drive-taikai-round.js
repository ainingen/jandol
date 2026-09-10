#!/usr/bin/env node
/*
  回戦のあいだの中継をブラウザで回す（`docs/design/taikai/round-spec.md` §9 段2）

    node tools/drive-taikai-round.js
    node tools/drive-taikai-round.js --shots DIR    一回戦・準決勝・決勝卓を撮る

  純関数の側（`onRoundStart` の口）は `tools/test-taikai-round.js` が見ている。
  ここで見るのは**画面**——出る／出ない、中身、押したら進むこと。

  `taikai.html` に**自分で解決する `playRealMatch`** を差し込んで回す。
  実対局そのものは通さない（それは `tools/drive-office.js --real` の仕事）。
  **`body.inMatch` の掛け外しは `shell.html` の側**なので、最後に
  `index.html` で一度だけ通しで見る（§7）。
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
const ok = (c, n, d) => { if (c) { pass++; console.log('  ok  ' + n); }
  else { fails.push(n + (d ? ' … ' + d : '')); console.log('  NG  ' + n + (d ? ' … ' + d : '')); } };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n,
  'got ' + JSON.stringify(a) + ' / want ' + JSON.stringify(b));

const TEAM = [67, 70, 73];
const save = (over) => Object.assign({
  discovered: [], contracted: TEAM.slice(), comp: { 67: 60, 70: 55, 73: 70 },
  favor: {}, team: TEAM.slice(), teamDecided: true, money: 5000000,
  playerRank: 'S', records: {}, recent: [], beaten: [],
  playerName: 'テスト事務所', playerFace: 'p01', autoMatch: false,
}, over || {});

/* 画面から読むもの */
const viewOf = (p) => p.evaluate(() => ({
  title: (document.querySelector('.tkTitle') || {}).textContent || '',
  bridge: !!document.querySelector('[data-act="round-go"]'),
  go: ((document.querySelector('[data-act="round-go"]') || {}).textContent || '').trim(),
  up: !!document.querySelector('.tkBridgeUp'),
  line: ((document.querySelector('.tkBridgeLine') || {}).textContent || '').replace(/\s+/g, ''),
  who: ((document.querySelector('.tkBridgeWho') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
  out: ((document.querySelector('.tkBridgeOut') || {}).textContent || '').replace(/\s+/g, ' ').trim(),
  rest: ((document.querySelector('.tkBridgeRest') || {}).textContent || '').replace(/\s+/g, ''),
  cards: Array.from(document.querySelectorAll('.tkCards .tkCard')).map((n) => ({
    name: (n.querySelector('.tkCardName') || {}).textContent || '',
    mine: n.classList.contains('mine'),
    why: !!n.querySelector('.tkWhy'),
    bare: n.classList.contains('tkBare'),
  })),
  tier: document.querySelector('.tkRoot').dataset.tier || null,
  hold: document.body.classList.contains('tkHold'),
  final: !!document.querySelector('.tkBridge.final'),
  prize: ((document.querySelector('.tkStakes .tkPrizeBig b') || {}).textContent || '').trim(),
  ladder: document.querySelectorAll('.tkLadder li').length,
  /* 決勝卓のカードの実測（§5・E）。**顔がカードいっぱいか**、
     **打ち筋と完成度バーが出ていないか**を計算後の値で見る */
  shape: (() => {
    const cs = Array.from(document.querySelectorAll('.tkCards .tkCard'));
    if (!cs.length) return null;
    const c = cs[0];
    /* **打ち筋と完成度バーは自分のカードには元から無い。**
       出す・出さないを見るには**仲間か相手のカード**を取ること。
       **`tkBare` では選ばない**——決勝では印そのものを立てないので（G）、
       自分のカードが選ばれて全部 `null` になる */
    const other = cs.find((x) => !x.classList.contains('mine')) || cs[1] || c;
    const g = (sel) => { const e = other.querySelector(sel); return e ? getComputedStyle(e).display : null; };
    return {
      /* 縁のぶんを外して測る（`.mine` は 2px なので、外枠だと必ず食い違う） */
      cardH: c.clientHeight,
      faceH: Math.round(c.querySelector('.tkFace').getBoundingClientRect().height),
      style: g('.tkCardStyle'), track: g('.tkTrack'), cond: g('.tkCond'),
    };
  })(),
  result: !!document.querySelector('.tkChampion'),
  rounds: !!document.querySelector('.tkRound'),
}));

/* 自分の勝ち負けを外から決める `playRealMatch` を差し込む。
   **卓は解決するまで待つ**ので、中継 → 対局 → 中継 の順が押して確かめられる */
const install = (p, winRounds) => p.evaluate((wins) => {
  window.__calls = [];
  store.playRealMatch = (t, ctx) => {
    window.__calls.push({ round: ctx.round, name: ctx.name, isFinal: !!ctx.isFinal,
      ids: t.map((c) => c.id) });
    const me = t.find((c) => c.id === 0);
    const rest = t.filter((c) => c.id !== 0);
    const win = wins.indexOf(ctx.round) >= 0;
    return Promise.resolve(win
      ? [{ chara: me, place: 1 }].concat(rest.map((c, i) => ({ chara: c, place: i + 2 })))
      : rest.map((c, i) => ({ chara: c, place: i + 1 })).concat([{ chara: me, place: 4 }]));
  };
}, winRounds);

(async () => {
  const { srv, port } = await serve();
  const BASE = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  const open = async (over) => {
    const ctx = await browser.newContext({ viewport: { width: 392, height: 740 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => { fails.push('PAGEERROR ' + e.message); console.log('  NG  PAGEERROR ' + e.message); });
    await p.goto(BASE + '/taikai.html');
    await p.evaluate((s) => localStorage.setItem('jandol_save_v1', JSON.stringify(s)), save(over));
    await p.reload();
    return p;
  };
  const shot = async (p, n) => { if (SHOTS) {
    /* **顔が届くのを待つ。**撮るのが早いと `onerror` 前の空の img のまま写り、
       画像がある子まで影絵に見える */
    await p.evaluate(() => Promise.all(
      Array.from(document.images).map((i) => (i.complete ? null
        : new Promise((r) => { i.onload = i.onerror = r; })))));
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.waitForTimeout(120);
    await p.screenshot({ path: path.join(SHOTS, n + '.png') });
  } };

  /* ============================================================
     1. 勝ち上がるとき — 一回戦・準決勝・決勝卓で三回出る
     ============================================================ */
  console.log('\n[勝ち上がる]');
  {
    const p = await open();
    await install(p, [0, 1, 2]);
    await p.click('button.tkTier[data-tier="open"]');       // 64人
    await p.click('[data-act="start"]');
    await p.waitForSelector('[data-act="round-go"]', { timeout: 5000 });

    const r1 = await viewOf(p);
    eq(r1.title, '一回戦', '一回戦の中継が出る');
    ok(!r1.up, '**一回戦では②勝ち上がりを出さない**（前の回戦が無い）');
    eq(r1.go, '一回戦を打つ', '釦の文言は「◯◯を打つ」');
    eq(r1.cards.length, 4, '次の卓は四枚');
    eq(r1.cards.filter((c) => c.mine).length, 1, '自分のカードだけ縁が金');
    ok(r1.cards[0].mine, '自分が先頭');
    eq(r1.cards.filter((c) => c.why).length, 0, '**見出し語（why）は付けない**（§4③）');
    eq(r1.tier, 'open', '大会の色が付いたまま');
    /* **セーブを消す釦を出さない**（§7）。`#appReset` は shell.html の枠なので
       `taikai.html` には無い。ここで見るのは印が立っていること */
    ok(r1.hold, '中継のあいだは body.tkHold が立つ（「最初からやり直す」を隠す）');
    await shot(p, 'round-1');

    await p.click('[data-act="round-go"]');
    await p.waitForFunction(() => window.__calls.length >= 1, null, { timeout: 5000 });
    await p.waitForSelector('[data-act="round-go"]', { timeout: 5000 });
    const r2 = await viewOf(p);
    eq(r2.title, '準決勝', '打ち終わると次の中継（準決勝）が出る');
    ok(r2.hold, '次の中継でも印が立っている');
    ok(r2.up, '準決勝では②勝ち上がりが出る');
    /* **人数を決め打ちしない。**自分以外の三人は別の卓にいて `simulateTable` が
       処理するので、何人残るかは走行ごとに変わる。見るのは
       「数と名前が食い違っていないこと」 */
    const n = Number((r2.line.match(/：(\d+)人/) || [])[1]);
    const who = r2.who ? r2.who.split('／').map((x) => x.trim()).filter(Boolean) : [];
    eq(who.length, n, '「N人が残りました」の数と、並んだ名前の数が合う');
    ok(n >= 1 && who.indexOf('テスト事務所') >= 0,
      '自分は必ず残っている（勝ち上がったので）', r2.line + ' / ' + r2.who);
    ok(who.every((x) => r2.out.indexOf(x) < 0),
      '残った子が「落ちた子」の側に出ていない', r2.out);
    eq(r2.rest, '残り16名', '残り人数が出る');
    eq(r2.go, '準決勝を打つ', '釦の文言が回戦名で変わる');
    await shot(p, 'round-2');

    await p.click('[data-act="round-go"]');
    await p.waitForFunction(() => window.__calls.length >= 2, null, { timeout: 5000 });
    await p.waitForSelector('[data-act="round-go"]', { timeout: 5000 });
    const r3 = await viewOf(p);
    eq(r3.title, '決勝卓', '決勝卓の中継が出る');
    eq(r3.rest, '残り4名', '決勝卓は残り4名');
    /* ---- 段3（§5・E）---- */
    ok(r3.final, '決勝卓は .tkBridge.final');
    ok(!r1.final && !r2.final, '通常の回戦には final が付かない');
    eq(r3.go, '決勝卓へ', '釦は「決勝卓へ」');
    ok(r3.up, '②の勝ち上がりは決勝でも出す（四人で入って何人残ったかが読める）');
    ok(/^[\d,]+円$/.test(r3.prize), '賞金を再掲する', r3.prize);
    ok(!r1.prize && !r2.prize, '通常の回戦では賞金を出さない', r1.prize + '/' + r2.prize);
    eq(r3.ladder, 0, '梯子は出さない（ここが最後なので先が無い）');
    /* **顔がカードいっぱい**（E）。上半分だけの通常のカードと分ける */
    ok(r3.shape.faceH === r3.shape.cardH,
      '決勝は顔がカードいっぱい', JSON.stringify(r3.shape));
    ok(r2.shape.faceH < r2.shape.cardH * 0.8,
      '通常の回戦は顔が上半分だけのまま', JSON.stringify(r2.shape));
    /* **打ち筋と完成度バーは出さない**（E）。三回戦打って来た相手なので数字は要らない */
    eq([r3.shape.style, r3.shape.track], ['none', 'none'],
      '決勝は打ち筋・完成度バーを出さない');
    eq([r2.shape.style, r2.shape.track], ['block', 'block'],
      '通常の回戦では出したまま');
    /* **決勝では `tkBare` を立てない**（G）。名前と級が顔に重なるので、
       「空いた高さの真ん中へ寄せる」出番がそもそも無い。
       通常の回戦では自分のカードにだけ立っていること */
    ok(!r3.cards.some((c) => c.bare), '決勝のカードに tkBare が付かない',
      JSON.stringify(r3.cards.map((c) => c.bare)));
    eq(r2.cards.map((c) => c.bare), [true, false, false, false],
      '通常の回戦では自分のカードだけ tkBare');
    await shot(p, 'round-3');

    await p.click('[data-act="round-go"]');
    await p.waitForFunction(() => window.__calls.length >= 3, null, { timeout: 5000 });
    await p.waitForSelector('[data-act="result"]', { timeout: 8000 });
    ok(!(await viewOf(p)).hold, '中継が終われば印が落ちる（進行の画面では出す）');
    const calls = await p.evaluate(() => window.__calls);
    eq(calls.map((c) => c.name), ['一回戦', '準決勝', '決勝卓'], '三回戦とも自分が打った');
    eq(calls.map((c) => c.isFinal), [false, false, true], '決勝卓だけ isFinal');
    ok((await viewOf(p)).rounds, '打ち切ると進行の画面へ抜ける');
    await p.close();
  }

  /* ============================================================
     2. 一回戦で落ちたら、そのあとは出ない（§2）
     ============================================================ */
  console.log('\n[一回戦で落ちる]');
  {
    const p = await open();
    await install(p, []);                                   // 一度も勝たない
    await p.click('button.tkTier[data-tier="open"]');
    await p.click('[data-act="start"]');
    await p.waitForSelector('[data-act="round-go"]', { timeout: 5000 });
    eq((await viewOf(p)).title, '一回戦', '一回戦は出る');
    await p.click('[data-act="round-go"]');
    await p.waitForSelector('[data-act="result"]', { timeout: 8000 });
    const v = await viewOf(p);
    ok(!v.bridge, '敗退したあとの準決勝・決勝卓では中継が出ない');
    ok(!v.hold, '敗退して抜けたあとも印が落ちている');
    ok(v.rounds, 'そのまま進行の画面へ抜ける');
    eq((await p.evaluate(() => window.__calls)).length, 1, '打ったのは一回戦だけ');
    await p.close();
  }

  /* ============================================================
     3. 「自動で処理する」なら出ない（§2.1）
     ============================================================ */
  console.log('\n[自動で処理する]');
  {
    const p = await open({ autoMatch: true });
    await install(p, [0, 1, 2]);
    await p.click('button.tkTier[data-tier="open"]');
    await p.click('[data-act="start"]');
    await p.waitForSelector('[data-act="result"]', { timeout: 8000 });
    const v = await viewOf(p);
    ok(!v.bridge, 'autoMatch では中継が一度も出ない');
    ok(!v.hold, 'autoMatch では印も立たない');
    ok(v.rounds, '進行の画面まで一気に進む');
    await p.close();
  }

  /* ============================================================
     4. 16人の大会（準決勝 → 決勝卓の二回戦）
     ============================================================ */
  console.log('\n[16人の大会]');
  {
    const p = await open({ playerRank: 'C' });
    await install(p, [0, 1]);
    await p.click('button.tkTier[data-tier="rookie"]');
    await p.click('[data-act="start"]');
    await p.waitForSelector('[data-act="round-go"]', { timeout: 5000 });
    const a = await viewOf(p);
    /* **一回戦の名前が「準決勝」になる**（§8）。いまは直さないので、
       そうなっていることを錠にしておく——直したときにここが落ちる */
    eq(a.title, '準決勝', '16人の大会は一回戦の名前が「準決勝」（§8。いまは直さない）');
    ok(!a.up, '最初の回戦なので②は出ない');
    await p.click('[data-act="round-go"]');
    await p.waitForFunction(() => window.__calls.length >= 1, null, { timeout: 5000 });
    await p.waitForSelector('[data-act="round-go"]', { timeout: 5000 });
    eq((await viewOf(p)).title, '決勝卓', '次が決勝卓');
    await p.close();
  }

  /* ============================================================
     5. 二度押しても一回しか進まない（§7）
     ============================================================ */
  console.log('\n[二度押し]');
  {
    const p = await open();
    await install(p, [0, 1, 2]);
    await p.click('button.tkTier[data-tier="open"]');
    await p.click('[data-act="start"]');
    await p.waitForSelector('[data-act="round-go"]', { timeout: 5000 });
    await p.evaluate(() => {
      const b = document.querySelector('[data-act="round-go"]');
      b.click(); b.click(); b.click();
    });
    await p.waitForSelector('[data-act="round-go"]', { timeout: 5000 });
    eq((await viewOf(p)).title, '準決勝', '三度押しても一回戦ぶんしか進まない');
    eq((await p.evaluate(() => window.__calls)).length, 1, '対局も一回しか始まらない');
    await p.close();
  }

  await browser.close();
  srv.close();
  console.log('\n通過 ' + pass + ' 件');
  if (fails.length) { console.log('失敗 ' + fails.length + ' 件'); fails.forEach((x) => console.log('  - ' + x)); process.exit(1); }
  console.log('すべて通過');
})();
