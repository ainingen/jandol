#!/usr/bin/env node
/*
  出走表をブラウザで回す（`docs/design/taikai/field-spec.md` §9）

    node tools/drive-taikai-field.js
    node tools/drive-taikai-field.js --shots DIR    五つの大会の頭を撮る

  純関数の側（`ladderOf` / `pickSpotlight`）は `tools/test-taikai-field.js` が
  見ているので、ここで見るのは**画面でしか確かめられないもの**——

    1. 五つの大会で、色（`data-tier`）と梯子が合っていること
    2. ③④のカードの段位が、⑤の全員一覧と食い違わないこと
       （`teamCards()` を引き直すと疲労のぶんずれる。§2③）
    3. **注目に出した子が⑤の全員一覧にも出ていること**（§1）
    4. 顔が七枚までで、⑤には一枚も無いこと（§7）
    5. 入場の演出（§6）——タイトル戦と雀エイト選抜戦だけ、
       `prefers-reduced-motion` では出ない、復帰では出ない、
       **触ったら終端へ飛ぶ**
    6. §4.1 の罠——出走表のどこを押しても顔ぶれが引き直されないこと

  `taikai.html`（単体ページ）で回す。**`office.js` が読まれていないので
  調子は出ない**——それも §6.3 のとおり。
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

/* 出られる段位は大会ごとに違う（`canEnter`）。新人戦は C 級まで */
const TIERS = [['rookie', 'C', ['16名', '4卓', '決勝卓']],
  ['local', 'B', ['16名', '4卓', '決勝卓']],
  ['open', 'A', ['64名', '16卓', '4卓', '決勝卓']],
  ['title', 'S', ['64名', '16卓', '4卓', '決勝卓']],
  ['eight', 'S', ['64名', '16卓', '4卓', '決勝卓']]];
const TEAM = [67, 70, 73];
const save = (over) => Object.assign({
  discovered: [], contracted: TEAM.slice(), comp: { 67: 60, 70: 55, 73: 70 },
  favor: {}, team: TEAM.slice(), teamDecided: true, money: 5000000,
  playerRank: 'S', records: {}, recent: [], beaten: [],
  playerName: 'テスト事務所', playerFace: 'p01',
}, over || {});

/* 画面から読むもの。**カードと一覧の段位を突き合わせる**ため、
   両方から名前と級を拾う */
const viewOf = (p) => p.evaluate(() => ({
  tier: document.querySelector('.tkRoot').dataset.tier || null,
  title: (document.querySelector('.tkTitle') || {}).textContent || '',
  ladder: Array.from(document.querySelectorAll('.tkLadder li')).map((n) => n.textContent),
  prize: (document.querySelector('.tkPrizeBig b') || {}).textContent || '',
  cards: Array.from(document.querySelectorAll('.tkCard')).map((n) => ({
    name: (n.querySelector('.tkCardName') || {}).textContent || '',
    grade: (n.querySelector('.tkCardSub b') || {}).textContent || '',
    why: ((n.querySelector('.tkWhy') || {}).textContent || '').trim(),
    mine: n.classList.contains('mine'),
    cond: !!n.querySelector('.tkCond'),
  })),
  spot: Array.from(document.querySelectorAll('.tkCardsSpot .tkCardName')).map((n) => n.textContent),
  list: Array.from(document.querySelectorAll('.tkGroup')).flatMap((g) => {
    const grade = ((g.querySelector('.tkGroupT') || {}).textContent || '').trim().split(/\s/)[0];
    return Array.from(g.querySelectorAll('.tkName')).map((n) => ({ name: n.textContent, grade }));
  }),
  faces: document.querySelectorAll('.tkRoot img').length,
  listFaces: document.querySelectorAll('.tkGroup img').length,
  enter: document.querySelector('.tkRoot').classList.contains('tkEnter'),
  resume: !!document.querySelector('.tkResume'),
}));

(async () => {
  const { srv, port } = await serve();
  const BASE = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  const open = async (over, ctxOpts) => {
    const ctx = await browser.newContext(Object.assign(
      { viewport: { width: 392, height: 740 } }, ctxOpts || {}));
    const p = await ctx.newPage();
    await p.goto(BASE + '/taikai.html');
    await p.evaluate((s) => localStorage.setItem('jandol_save_v1', JSON.stringify(s)), save(over));
    await p.reload();
    return p;
  };

  /* ---- 1〜4：五つの大会 ---- */
  for (const [tier, rank, ladder] of TIERS) {
    console.log('\n[' + tier + ']');
    const p = await open({ playerRank: rank, recent: [5, 3], beaten: [5] });
    await p.click('button.tkTier[data-tier="' + tier + '"]');
    await p.waitForTimeout(200);
    const v = await viewOf(p);
    eq(v.tier, tier, 'root に data-tier が付く');
    eq(v.ladder, ladder, '梯子が人数から出ている');
    ok(/^[\d,]+円$/.test(v.prize), '賞金が出ている', v.prize);

    /* ③は四人、④は三人。自分のカードだけ mine */
    eq(v.cards.length, 7, 'カードは七枚（四人＋三人）');
    eq(v.cards.filter((c) => c.mine).length, 1, '金の縁は自分の一枚だけ');
    ok(v.cards[0].mine, '先頭は自分');
    eq(v.cards.slice(0, 4).filter((c) => c.why).length, 0, '③には見出し語が無い');
    eq(v.cards.slice(4).filter((c) => c.why).length, 3, '④は三人とも見出し語を持つ');
    ok(v.cards.slice(4).every((c) => /前に当たって|優勝候補/.test(c.why)),
      '見出し語は二種類のどちらか', JSON.stringify(v.cards.slice(4).map((c) => c.why)));
    ok(!/当たります/.test(JSON.stringify(v.cards)),
      '「この中の誰かと当たります」とは書かない（卓割りはまだ）');
    /* 単体ページには office.js が無いので調子は出ない（§6.3） */
    eq(v.cards.filter((c) => c.cond).length, 0, '調子は出ない（office.js が無い環境）');

    /* **カードの段位と一覧の段位が食い違わないこと**（§2③） */
    const inList = new Map(v.list.map((x) => [x.name, x.grade]));
    v.cards.forEach((c) => {
      if (c.name === 'テスト事務所') return;                 // 自分は「あなた」の組
      ok(inList.get(c.name) === c.grade,
        'カードと一覧の段位が一致（' + c.name + '）',
        c.grade + ' / ' + inList.get(c.name));
    });
    /* **注目に出した子が一覧から消えていないこと**（§1） */
    v.spot.forEach((n) => ok(inList.has(n), '注目の子が全員一覧にもいる（' + n + '）'));
    /* 顔は七枚まで。⑤には一枚も無い（§7） */
    ok(v.faces <= 7, '顔は七枚まで', String(v.faces));
    eq(v.listFaces, 0, '全員一覧に顔は出さない');

    if (SHOTS) {
      await p.evaluate(() => { document.querySelector('.tkRoot').classList.add('tkSkip'); window.scrollTo(0, 0); });
      await p.waitForTimeout(120);
      await p.screenshot({ path: path.join(SHOTS, 'field-' + tier + '.png') });
    }
    await p.close();
  }

  /* ---- 5：入場の演出（§6） ---- */
  console.log('\n[入場]');
  for (const [tier, rank, , ] of TIERS) {
    const want = tier === 'title' || tier === 'eight';
    const p = await open({ playerRank: rank });
    await p.click('button.tkTier[data-tier="' + tier + '"]');
    const v = await viewOf(p);
    ok(v.enter === want, tier + ' で演出が' + (want ? '出る' : '出ない'), String(v.enter));
    await p.close();
  }
  {
    const p = await open({});
    await p.click('button.tkTier[data-tier="title"]');
    const anim = (sel) => p.$eval(sel, (n) => getComputedStyle(n).animationName + ' ' + getComputedStyle(n).animationDelay);
    ok((await anim('.tkFieldHead')).startsWith('tkDrop'), '見出し帯が落ちる（0.0s）', await anim('.tkFieldHead'));
    eq(await anim('.tkStakes'), 'tkRise 0.25s', '賞金と梯子は 0.25s');
    eq(await p.$$eval('.tkCards .tkCard', (ns) => ns.slice(0, 4).map((n) => getComputedStyle(n).animationDelay)),
      ['0.45s', '0.54s', '0.63s', '0.72s'], '四人は 0.45s から 0.09s ずつ');
    /* **触ったら終端へ飛ぶ。**地の状態が終端でなければ、ここで壊れる */
    await p.mouse.click(196, 420);
    ok(await p.$eval('.tkRoot', (n) => n.classList.contains('tkSkip')), '触ると .tkSkip が付く');
    const end = await p.$eval('.tkCards .tkCard', (n) => getComputedStyle(n).opacity + '/' + getComputedStyle(n).transform);
    ok(end.indexOf('1/none') === 0, '触ると終端の状態（不透明・ずれなし）', end);

    /* ---- 6：§4.1 の罠。押しても顔ぶれが引き直されない ---- */
    const before = await p.$$eval('.tkName', (ns) => ns.map((x) => x.textContent).join(','));
    await p.mouse.click(196, 300);
    await p.mouse.click(60, 500);
    await p.waitForTimeout(200);
    eq(await p.$$eval('.tkName', (ns) => ns.map((x) => x.textContent).join(',')), before,
      '出走表を押しても顔ぶれが引き直されない（§4.1）');
    await p.close();
  }
  /* **見張りの外し忘れはブラウザから見えない。**`pointerdown` は root へ
     上がってくるので、出走表を出るときに押した釦のクリックが見張りを
     使い切ってしまう——落ちない検査は錠になっていないので置かない。
     残っているかどうかは `tools/test-taikai-field.js` が本文で見ている */
  {
    const p = await open({}, { reducedMotion: 'reduce' });
    await p.click('button.tkTier[data-tier="title"]');
    ok(!(await viewOf(p)).enter, 'prefers-reduced-motion では演出が出ない');
    await p.close();
  }
  {
    /* 復帰では出さない。`opts.resume` を直に渡して `startResume` を通す
       ——控えの中身そのものは `tools/drive-taikai-resume.js` が見ている */
    const p = await open({});
    const v = await p.evaluate(() => {
      const ids = [0, 67, 70, 73].concat(JANDOLS.slice(0, 60).map((c) => c.id));
      const root = document.getElementById('taikai');
      Taikai.mount(root, {
        get: () => JSON.parse(localStorage.getItem('jandol_save_v1')), set: () => {},
      }, { resume: { v: 1, tierId: 'title', fieldIds: ids, rounds: [], offerId: null } });
      return { resume: !!root.querySelector('.tkResume'),
               enter: root.classList.contains('tkEnter'),
               start: !!root.querySelector('[data-act="start"]') };
    });
    ok(v.resume, '復帰の一言が出ている（この経路を通った）');
    ok(!v.enter, '復帰では演出が出ない');
    ok(!v.start, '復帰のときは「卓に着く」を出さない（いままでどおり）');
    await p.close();
  }

  await browser.close();
  srv.close();
  console.log('\n通過 ' + pass + ' 件');
  if (fails.length) { console.log('失敗 ' + fails.length + ' 件'); fails.forEach((x) => console.log('  - ' + x)); process.exit(1); }
  console.log('すべて通過');
})();
