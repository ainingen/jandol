#!/usr/bin/env node
/*
  対局の復帰をブラウザで確かめる（`docs/design/match/resume-spec.md` §8 段2）

    node tools/drive-resume.js
    node tools/drive-resume.js --speed 200 --length tonpuu

  見るのは四つ。**`tools/test-resume.js` は node で localStorage を差し替えて
  見ているので、ここは「実際に打って本物の localStorage が動くか」だけ**を見る。

    1. 局が始まるたびに `localStorage` の中身が更新されること（§3）
       ——局番号・本場の組が、局が進むぶんだけ増える
    2. 控えた値が、そのとき動いている `Game` と一致していること
       ——`kyoku` / `honba` / `riichiSticks` / 持ち点 / `startDealer`
    3. **半荘を打ち切ったら消えていること**（§4）
       `showResult` の前に消すので、順位が出ている時点でもう無い
    4. `?dealer=` が効くこと（§7 の副産物）
       ——いままで `Match.play` が `Game` へ転送していなかった

  あわせて、**opts の転送そのもの**も見る（段3 の前提）。
  `Match.play` に `kyoku` / `honba` / `riichiSticks` / `scores` を渡して、
  卓がその局から始まるか。**画面は段3 なので、ここでは直に呼ぶ。**

  終了コードは 0（全部通った）か 1（どれか落ちた）。
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\n/, ''));
  process.exit(0);
}

const ROOT = path.resolve(opt('root', path.join(__dirname, '..')));
const WIDTH = +opt('width', 780);
const HEIGHT = +opt('height', 392);
/* 速すぎると局が瞬きの間に終わって、見張りが取りこぼす。
   遅すぎると通しで何分もかかる。200 は「速い」の目盛り */
const SPEED = +opt('speed', 200);
const LENGTH = opt('length', 'tonpuu');
const SEED = opt('seed', '20260907');
const POLL = +opt('poll', 40);
const TIMEOUT = +opt('timeout', 180) * 1000;

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
  '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { process.stdout.write(a.join(' ') + '\n'); };

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; log('  ✓ ' + name); return; }
  fails.push(name + (detail ? '  … ' + detail : ''));
  log('  ✗ ' + name + (detail ? '  … ' + detail : ''));
}

(async () => {
  const { chromium } = loadPlaywright();
  const { srv, port } = await serve(ROOT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR ' + e.message); });

  const base = 'http://127.0.0.1:' + port + '/match.html';
  const KEY = 'jandol_match_resume_v1';

  /* localStorage をそのまま読む。**Resume を経由しない**
     ——経由すると「Resume が自分の言い分を返しただけ」になる */
  const peek = () => page.evaluate((k) => {
    let raw = null;
    try { raw = localStorage.getItem(k); } catch (e) { return { err: String(e) }; }
    if (raw === null) return { gone: true };
    try { return { rec: JSON.parse(raw) }; } catch (e) { return { bad: raw.slice(0, 80) }; }
  }, KEY);
  /* **`window.UI` と書かないこと。**`src/ui.js` は `const UI = {...}` なので、
     古典スクリプトの最上位の `const` は**字句的なグローバル**になり、
     `window` のプロパティにはならない。`window.UI` は永遠に undefined で、
     「卓が立たなかった」と「見に行く先が違った」が同じ絵になる（実際に踏んだ） */
  const live = () => page.evaluate(() => {
    const g = (typeof UI !== 'undefined') && UI.game;
    if (!g) return null;
    return { kyoku: g.kyoku, honba: g.honba, sticks: g.riichiSticks,
      startDealer: g.startDealer, dealer: g.dealer, bakaze: g.bakaze,
      scores: g.players.map((p) => p.score) };
  });

  /* ============================================================
     1〜3. 打ち切るまで見張る
     ============================================================ */
  log('\n## 一戦を通して見張る（' + LENGTH + '・speed ' + SPEED + '）');
  {
    const q = new URLSearchParams({ start: '1', auto: '1', speed: String(SPEED),
      length: LENGTH, seed: SEED, sfx: '0' });
    await page.goto(base + '?' + q.toString());

    /* 開いた直後は何も無いこと（前の走行の残りが混ざっていないこと） */
    await page.evaluate((k) => { try { localStorage.removeItem(k); } catch (e) {} }, KEY);

    const seen = [];          // 控えられた「局:本場」を出た順に
    const mismatches = [];    // 控えと Game が食い違った瞬間
    let sawAny = false;
    let sawLive = 0;          // Game を実際に覗けた回数（0 だと下の一致は空証明になる）
    let finished = false;
    const t0 = Date.now();

    while (Date.now() - t0 < TIMEOUT) {
      const [p, l] = await Promise.all([peek(), live()]);
      if (p.err) { fails.push('localStorage が読めない: ' + p.err); break; }
      if (p.bad) { fails.push('壊れたものが入っている: ' + p.bad); break; }
      if (l) sawLive++;

      if (p.rec) {
        sawAny = true;
        const key = p.rec.kyoku + ':' + p.rec.honba;
        if (seen[seen.length - 1] !== key) seen.push(key);
        /* 控えは局の頭のもの。局中に点棒は動くので、突き合わせるのは
           **局が変わっていない間の kyoku / honba / startDealer** だけ */
        if (l && (l.kyoku !== p.rec.kyoku || l.honba !== p.rec.honba)) {
          /* 局が切り替わる一瞬は、控えが古いことがある。次の巡回で揃うので
             「二度続けて食い違ったら」だけを拾う */
          const again = await peek();
          const l2 = await live();
          if (again.rec && l2 && (l2.kyoku !== again.rec.kyoku || l2.honba !== again.rec.honba)) {
            mismatches.push(JSON.stringify({ rec: again.rec.kyoku + ':' + again.rec.honba,
              game: l2.kyoku + ':' + l2.honba }));
          }
        }
        if (l && l.startDealer !== p.rec.startDealer) {
          mismatches.push('startDealer ' + l.startDealer + ' / 控え ' + p.rec.startDealer);
        }
      }

      /* 対局が終わると #matchRoot が空になり、body.inMatch が外れる */
      const done = await page.evaluate(() => !document.body.classList.contains('inMatch')
        && !!window.lastRank);
      if (done) { finished = true; break; }
      /* 対局終了のモーダル（結果へ）を押す */
      const btn = await page.$('#overlay .panel button');
      if (btn) {
        /* 押す**前**に、もう消えていること（§4：showResult の前に消す） */
        const atResult = await peek();
        ok(atResult.gone === true,
          '順位が出ている時点でもう消えている（showResult より前に消す）',
          JSON.stringify(atResult.rec || atResult));
        await btn.click();
      }
      await sleep(POLL);
    }

    ok(sawAny, '対局中に localStorage へ控えが入る');
    ok(finished, '対局が最後まで進んだ', 'seen ' + seen.join(' → '));
    log('    控えられた局: ' + seen.join(' → '));
    ok(seen.length >= 4,
      '局が始まるたびに更新される（' + LENGTH + 'なら4回以上）', 'seen ' + seen.length + ' 回');
    ok(new Set(seen).size === seen.length,
      '同じ「局:本場」が二度控えられない（局の頭で一度だけ）', seen.join(' → '));
    /* **突き合わせが空証明になっていないこと。**Game を一度も覗けないまま
       「食い違いは無かった」と言うと、何も見ていないのに通る（実際に一度そうなった） */
    ok(sawLive > 0, '動いている Game を実際に覗けた', 'sawLive ' + sawLive);
    ok(mismatches.length === 0,
      '控えの中身は動いている Game と一致している（' + sawLive + '回突き合わせた）',
      mismatches.slice(0, 3).join(' / '));

    const after = await peek();
    ok(after.gone === true, '打ち切ったら消えている（§4）', JSON.stringify(after.rec || after));
  }

  /* ============================================================
     4. ?dealer= が効く（§7 の副産物）
     ============================================================ */
  log('\n## ?dealer= が Game まで届く');
  for (const d of [0, 1, 2, 3]) {
    const q = new URLSearchParams({ start: '1', auto: '1', speed: '0',
      length: 'ikkyoku', seed: SEED, sfx: '0', dealer: String(d) });
    await page.goto(base + '?' + q.toString());
    /* 卓が立ち上がった瞬間を捕まえる（speed 0 はすぐ終わる） */
    let got = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      got = await live();
      if (got) break;
      await sleep(10);
    }
    ok(got && got.startDealer === d, '?dealer=' + d + ' が起家に届く',
      got ? 'startDealer ' + got.startDealer : '卓が立たなかった');
    ok(got && got.dealer === d, '　1局目の親は起家そのもの',
      got ? 'dealer ' + got.dealer : '-');
  }

  /* ============================================================
     5. opts の転送（段3 の前提。画面はまだ無いので直に呼ぶ）
     ============================================================ */
  log('\n## opts を渡すとその局から始まる');
  {
    await page.goto(base + '?sfx=0');
    const got = await page.evaluate(async () => {
      const me = Object.assign({}, PLAYER, { face: 'p01' });
      const seats = [me, JANDOLS[0], JANDOLS[1], JANDOLS[2]];
      document.body.classList.add('inMatch');
      Match.play(document.getElementById('matchRoot'), seats, {
        title: '復帰の確認', speed: 0, length: 'hanchan', showHints: true,
        discardMode: 'single',
        startDealer: 1, kyoku: 6, honba: 2, riichiSticks: 1,
        scores: [30000, 20000, 28000, 22000],
      });
      /* 卓が立ち上がるのを待つ */
      for (let i = 0; i < 400 && !(typeof UI !== 'undefined' && UI.game); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const g = (typeof UI !== 'undefined') ? UI.game : null;
      if (!g) return null;
      return { kyoku: g.kyoku, honba: g.honba, sticks: g.riichiSticks,
        startDealer: g.startDealer, dealer: g.dealer, bakaze: g.bakaze,
        scores: g.players.map((p) => p.score),
        label: document.querySelector('.kyoku') ? document.querySelector('.kyoku').textContent : null };
    });
    ok(!!got, '卓が立った');
    if (got) {
      ok(got.kyoku === 6, 'kyoku が届く', String(got.kyoku));
      ok(got.honba === 2, 'honba が届く', String(got.honba));
      ok(got.sticks === 1, 'riichiSticks が届く', String(got.sticks));
      ok(got.startDealer === 1, 'startDealer が届く', String(got.startDealer));
      ok(got.dealer === (1 + 6 - 1) % 4, '親は kyoku から派生する', String(got.dealer));
      ok(got.bakaze === 28, '南場になる', String(got.bakaze));
      ok(JSON.stringify(got.scores) === JSON.stringify([30000, 20000, 28000, 22000]),
        '持ち点が届く', JSON.stringify(got.scores));
      /* 画面の局名も合っていること（段3 の一言がここを読む） */
      ok(got.label === '南2局', '画面の局名が「南2局」', String(got.label));
    }
    /* 控えが本物の localStorage に入っていること（この経路でも handStart が効く） */
    const p = await peek();
    ok(p.rec && p.rec.kyoku === 6 && p.rec.honba === 2,
      'この経路でも局の頭が控えられる', JSON.stringify(p.rec || p));
  }

  ok(errors.length === 0, 'ページで例外が出ていない', errors.slice(0, 3).join(' / '));

  await browser.close();
  srv.close();

  log('\n通過 ' + pass + ' 件' + (fails.length ? ' / 失敗 ' + fails.length + ' 件' : ''));
  if (fails.length) { fails.forEach((f) => log('  ✗ ' + f)); process.exit(1); }
  log('すべて通過');
})();
