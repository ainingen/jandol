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
       **段1 で変えた**（`taikai/resume-spec.md` §3）：`Match.play` は消さず
       `done` を書くだけになり、消すのは呼び出し元（`match.html` の `await` のあと）。
       順位が出ている時点では **`done` 付きで残っていて**、`await` が返ると消える
    4. `?dealer=` が効くこと（§7 の副産物）
       ——いままで `Match.play` が `Game` へ転送していなかった

  あわせて、**opts の転送そのもの**（`Match.play` に直に渡す経路）と、
  **段3 の復帰画面**（§6）も見る。

    5. 控えを手で置いて開くと、`.dbg` の位置に一言と釦二つが出ること。
       **局名が控えどおり**であること。**「通信」と書いていない**こと
    6. ［再開する］→ 画面の局名・4人の持ち点・親が控えどおりであること
    7. ［破棄する］→ 控えが消えて、従来の釦が戻ること
    8. **控えがあるときは `?start=1` でも始まらない**こと（§6-5）
    9. `?dealer=abc` が `RangeError` で止まること（申し送りの回収）

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
      /* **終わったあとの `kyoku` は「次に配る番号」であって、局ではない。**
         東風なら最後の局は 4 で、終局すると `kyoku` は 5 になり `finished` が立つ。
         控えは配ったときにしか書かれないので 4 のまま——**これは食い違いではない。**
         突き合わせる側がここを見ずに比べると、終局の一瞬を捕まえたときだけ
         `{rec:"4:0", game:"5:0"}` で落ちる（見張りを消して巡回が速くなり、
         毎回捕まえるようになって気づいた。2026年9月10日） */
      finished: !!g.finished, maxKyoku: g.maxKyoku,
      scores: g.players.map((p) => p.score) };
  });
  /* **控えと Game を一度の evaluate で撮る。**別々に `await` すると、
     その隙に局が進んで**古い控えと新しい Game**を並べてしまう
     ——「二度続けて食い違ったら」の確認そのものが同じ穴を踏んでいた */
  const both = () => page.evaluate((k) => {
    let rec = null, err = null;
    try {
      const raw = localStorage.getItem(k);
      rec = raw === null ? null : JSON.parse(raw);
    } catch (e) { err = String(e); }
    const g = (typeof UI !== 'undefined') && UI.game;
    return { rec, err, live: g ? { kyoku: g.kyoku, honba: g.honba,
      finished: !!g.finished, maxKyoku: g.maxKyoku } : null };
  }, KEY);

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
        /* **終局後は比べない**（`live()` のコメント）。`kyoku` が最後の局を
           越えたところで `finished` が立つ。そこから先の番号は「次に配る番号」で、
           配っていない以上、控えが追いつくことはない */
        const ended = (x) => !!(x && (x.finished || x.kyoku > x.maxKyoku));
        if (l && !ended(l) && (l.kyoku !== p.rec.kyoku || l.honba !== p.rec.honba)) {
          /* 局が切り替わる一瞬は、控えが古いことがある。次の巡回で揃うので
             「二度続けて食い違ったら」だけを拾う。
             **確認は一度の evaluate で撮る**（別々に await すると同じ穴を踏む） */
          const again = await both();
          const l2 = again.live;
          if (again.rec && l2 && !ended(l2)
              && (l2.kyoku !== again.rec.kyoku || l2.honba !== again.rec.honba)) {
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
        /* 押す**前**の状態を見る。**段1 で変わったところ**（`taikai/resume-spec.md` §3）：
           以前は `Match.play` が `showResult` の前に消していたので「もう無い」だったが、
           いまは**消さずに `done` を書く。**消すのは呼び出し元（`match.html` は
           `await` のあと）。順位を眺めている最中に落ちても、
           控えは `done` 付きで残っている */
        const atResult = await peek();
        ok(atResult.gone !== true,
          '順位が出ている時点では**まだ控えが残っている**（消すのは呼び出し元）',
          JSON.stringify(atResult));
        ok(!!(atResult.rec && Array.isArray(atResult.rec.done)),
          '　そこに done が書かれている', JSON.stringify(atResult.rec && atResult.rec.done));
        if (atResult.rec && Array.isArray(atResult.rec.done)) {
          const d = atResult.rec.done;
          ok(d.length === 4, '　done は4人ぶん', JSON.stringify(d));
          ok(new Set(d.map((r) => r.seat)).size === 4, '　席がだぶらない', JSON.stringify(d));
          ok(JSON.stringify(d.map((r) => r.place).sort()) === '[1,2,3,4]',
            '　順位は 1〜4 が一つずつ', JSON.stringify(d));
        }
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

    /* **`await` が返ったあとに `match.html` が消す**（§4 の書き換え後）。
       `window.lastRank` が入った時点で `await` は返っている */
    const after = await peek();
    ok(after.gone === true,
      '打ち切って await が返ったら消えている（消すのは match.html。§4）',
      JSON.stringify(after.rec || after));
  }

  /* ============================================================
     4. ?dealer= が効く（§7 の副産物）
     ============================================================ */
  log('\n## ?dealer= が Game まで届く');
  for (const d of [0, 1, 2, 3]) {
    /* **一つ前の走行の控えを消してから開く。**この見張りは卓が立った瞬間に
       次へ行くので、対局は途中で捨てられ `Resume.clear()`（§4）まで届かない。
       控えが残ったまま次を開くと **`?start=1` が止まる**（§6-5 のとおり）ので、
       消しておかないと二つ目から「卓が立たなかった」になる（実際になった） */
    await page.goto(base + '?sfx=0');
    await page.evaluate((k) => { try { localStorage.removeItem(k); } catch (e) {} }, KEY);
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

  /* ============================================================
     5〜8. 復帰の画面（段3・§6）

     **控えを手で置いて開く。**落ちるのを待っていられないので、
     `localStorage` に直に書いてから読み直す
     ============================================================ */
  log('\n## 控えを置いて開く（§6）');

  /* 控えを一つ組む。**`Resume.save` を通さない**
     ——通すと「Resume が書いたものを Resume が読んだ」だけになり、
     手で置いた古い控えを読めるかの確認にならない */
  const plant = async (over) => {
    await page.goto(base + '?sfx=0');
    return page.evaluate(([k, o]) => {
      const rec = Object.assign({
        v: 1, at: Date.now(),
        seats: [0, JANDOLS[0].id, JANDOLS[1].id, JANDOLS[2].id],
        kyoku: 2, honba: 1, riichiSticks: 1,
        scores: [26800, 24200, 25000, 24000],
        startDealer: 3,
        opts: { length: 'hanchan', speed: 0, showHints: true,
          discardMode: 'single', title: '単体の対局' },
      }, o || {});
      localStorage.setItem(k, JSON.stringify(rec));
      return rec.seats.map((id, i) => (id === 0 ? 'あなた' : JANDOLS[i - 1].name));
    }, [KEY, over || {}]);
  };
  const notice = () => page.evaluate(() => {
    const b = document.getElementById('dbgResume');
    const dbg = document.querySelector('.dbg');
    return {
      shown: !!b && !b.hidden,
      head: b && b.querySelector('h2') ? b.querySelector('h2').textContent : null,
      body: b && b.querySelector('p') ? b.querySelector('p').textContent : null,
      buttons: b ? Array.from(b.querySelectorAll('button')).map((x) => x.textContent) : [],
      dbgShown: !!dbg && !dbg.hidden,
      inMatch: document.body.classList.contains('inMatch'),
    };
  });

  {
    await plant();
    await page.reload();
    const n = await notice();
    ok(n.shown, '控えがあると一言が出る');
    ok(n.head === 'この局をやり直します', '見出しは「この局をやり直します」', String(n.head));
    ok(n.body === '一時的に画面が止まったため、東2局 1本場 の最初から再開します',
      '本文の局名が控えどおり（東2局 1本場）', String(n.body));
    ok(!/通信|回線|ネット|オフライン|Wi-?Fi/i.test(String(n.body) + String(n.head)),
      '**「通信」と書いていない**（§1）', String(n.body));
    ok(JSON.stringify(n.buttons) === JSON.stringify(['再開する', '破棄する']),
      '釦は二つ（再開する／破棄する）', JSON.stringify(n.buttons));
    ok(n.dbgShown === false, '一言が出ているあいだ従来の釦は隠れている');
    ok(n.inMatch === false, '勝手に始まっていない');
  }

  /* 局名の組み立て。**`kyoku > 4` なら南、表示は ((kyoku-1)%4)+1** */
  for (const [k, h, want] of [[1, 0, '東1局 0本場'], [4, 3, '東4局 3本場'],
    [5, 0, '南1局 0本場'], [8, 2, '南4局 2本場']]) {
    await plant({ kyoku: k, honba: h });
    await page.reload();
    const n = await notice();
    ok(n.body === '一時的に画面が止まったため、' + want + ' の最初から再開します',
      '局名 ' + want + '（kyoku ' + k + ' / honba ' + h + '）', String(n.body));
  }

  /* §5：捨てる条件に当たった控えでは**一言を出さない**。黙って消す */
  for (const [over, why] of [
    [{ v: 2 }, '版が違う'],
    [{ at: Date.now() - 25 * 3600 * 1000 }, '24時間を超えている'],
    [{ kyoku: 9 }, 'maxKyoku を超えている'],
    [{ seats: [0, 1, 2, 99999] }, '引けないキャラIDがいる'],
  ]) {
    await plant(over);
    await page.reload();
    const n = await notice();
    ok(!n.shown, '捨てる控え（' + why + '）では一言を出さない');
    ok(n.dbgShown === true, '　従来の画面のまま');
    const p = await peek();
    ok(p.gone === true, '　黙って消えている', JSON.stringify(p.rec || p));
  }

  /* **`done` の付いた控えは黙って消す**（`taikai/resume-spec.md` §3）。
     打ち切ったあと、結果を見ている最中に落ちたときのもの。
     **結果画面を再現する価値は無い**ので一言も出さない
     （本編の大会は同じ `done` を「打たずに結果として使う」——段2以降） */
  {
    const DONE = [{ seat: 2, place: 1 }, { seat: 0, place: 2 },
                  { seat: 3, place: 3 }, { seat: 1, place: 4 }];
    await plant({ done: DONE });
    await page.reload();
    const n = await notice();
    ok(!n.shown, 'done 付きの控えでは一言を出さない');
    ok(n.dbgShown === true, '　従来の画面のまま');
    ok(n.inMatch === false, '　勝手に始まらない');
    const p = await peek();
    ok(p.gone === true, '　黙って消えている', JSON.stringify(p.rec || p));

    /* **形が壊れた done は §5 が捨てる**（load の中で弾く） */
    await plant({ done: [{ seat: 0, place: 1 }] });
    await page.reload();
    const n2 = await notice();
    ok(!n2.shown, '壊れた done でも一言を出さない');
    const p2 = await peek();
    ok(p2.gone === true, '　黙って消えている', JSON.stringify(p2.rec || p2));
  }

  /* ---- 6. ［再開する］ ---- */
  log('\n## ［再開する］');
  {
    const names = await plant({ kyoku: 6, honba: 2, riichiSticks: 1, startDealer: 1,
      scores: [30000, 20000, 28000, 22000] });
    await page.reload();
    await page.click('#dbgResumeGo');
    let got = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && !got) {
      got = await live();
      if (!got) await sleep(20);
    }
    ok(!!got, '［再開する］で卓が立つ');
    if (got) {
      ok(got.kyoku === 6, '局が控えどおり（南2局＝通し6局目）', String(got.kyoku));
      ok(got.honba === 2, '本場が控えどおり', String(got.honba));
      ok(got.sticks === 1, '供託が控えどおり', String(got.sticks));
      ok(got.startDealer === 1, '起家が控えどおり', String(got.startDealer));
      ok(got.dealer === (1 + 6 - 1) % 4, '親が控えから派生している（(1+6-1)%4=0）',
        String(got.dealer));
      ok(got.bakaze === 28, '南場になっている', String(got.bakaze));
      ok(JSON.stringify(got.scores) === JSON.stringify([30000, 20000, 28000, 22000]),
        '4人の持ち点が控えどおり', JSON.stringify(got.scores));
    }
    /* 画面に出ているもの（人が見るもの）。**中の値だけ合っていても足りない。**
       席プレートは DOM の並びが席順ではない（top/left/right/bottom の順に置かれ、
       席は bottom=0 / right=1 / top=2 / left=3）ので、**id で席順に読み直す** */
    const shown = await page.evaluate(() => {
      const ids = ['#plate-bottom', '#plate-right', '#plate-top', '#plate-left'];
      const pick = (sel, cls) => {
        const e = document.querySelector(sel + ' ' + cls);
        return e ? e.textContent : null;
      };
      const k = document.querySelector('.kyoku');
      const w = document.querySelector('.wall');
      return {
        kyoku: k ? k.textContent : null,
        wall: w ? w.textContent : null,
        scores: ids.map((sel) => pick(sel, '.pt')),
        names: ids.map((sel) => pick(sel, '.nm')),
      };
    });
    ok(shown.kyoku === '南2局', '画面の局名が「南2局」', String(shown.kyoku));
    ok(/2本場/.test(String(shown.wall)), '画面の本場が「2本場」', String(shown.wall));
    ok(JSON.stringify(shown.scores) === JSON.stringify(['30000', '20000', '28000', '22000']),
      '画面の4人の持ち点が控えどおり（席順）', JSON.stringify(shown.scores));
    /* 自分の席（seat 0）は SEAT_LABEL のまま「自分」。相手三人は控えの顔ぶれ */
    ok(shown.names[0] === '自分', '自分の席は「自分」', String(shown.names[0]));
    ok(JSON.stringify(shown.names.slice(1)) === JSON.stringify(names.slice(1)),
      '相手三人が控えどおり（JANDOLS を引き直した）',
      JSON.stringify(shown.names.slice(1)) + ' / ' + JSON.stringify(names.slice(1)));
    /* 再開したあとも控えは残る——**ここでもう一度落ちたら、また同じ局から** */
    const p = await peek();
    ok(p.rec && p.rec.kyoku === 6, '再開しても控えは残っている（また落ちてもよい）',
      JSON.stringify(p.rec || p));
  }

  /* ---- 7. ［破棄する］ ---- */
  log('\n## ［破棄する］');
  {
    await plant();
    await page.reload();
    ok((await notice()).shown, '前提：一言が出ている');
    await page.click('#dbgResumeDrop');
    const n = await notice();
    ok(!n.shown, '［破棄する］で一言が消える');
    ok(n.dbgShown === true, '　従来の画面（釦）が戻る');
    ok(n.inMatch === false, '　対局は始まらない');
    const p = await peek();
    ok(p.gone === true, '　控えが消えている', JSON.stringify(p.rec || p));
    /* 読み直しても出てこないこと */
    await page.reload();
    ok(!(await notice()).shown, '読み直しても一言は出ない');
  }

  /* ---- 8. 控えがあるときは ?start=1 でも始めない（§6-5） ---- */
  log('\n## ?start=1 と控えの同居（§6-5）');
  {
    await plant();
    await page.goto(base + '?start=1&auto=1&speed=0&length=tonpuu&sfx=0');
    await sleep(1500);
    const n = await notice();
    ok(n.shown, '控えがあれば ?start=1 でも一言が出る');
    ok(n.inMatch === false, '**控えがあれば ?start=1 でも始まらない**（§6-5）');
    const p = await peek();
    ok(p.rec && p.rec.kyoku === 2, '　控えが新しい対局に上書きされていない',
      JSON.stringify(p.rec || p));
    /* 破棄すれば、そのあとは従来どおり自分で始められる */
    await page.click('#dbgResumeDrop');
    await page.goto(base + '?start=1&auto=1&speed=0&length=ikkyoku&sfx=0');
    let ran = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && !ran) {
      ran = await page.evaluate(() => document.body.classList.contains('inMatch'));
      if (!ran) await sleep(20);
    }
    ok(ran, '控えが無ければ ?start=1 はいままでどおり始まる');
  }

  /* ---- 9. ?dealer=abc は投げる（申し送りの回収） ---- */
  log('\n## ?dealer= の範囲外');
  {
    await page.evaluate((k) => { try { localStorage.removeItem(k); } catch (e) {} }, KEY);
    for (const [d, want] of [['abc', true], ['4', true], ['-1', true], ['2', false]]) {
      const p2 = await ctx.newPage();
      await p2.addInitScript(() => {
        window.__err = [];
        window.addEventListener('unhandledrejection',
          (e) => { window.__err.push(String(e.reason && e.reason.name) + ': ' + String(e.reason && e.reason.message)); });
      });
      await p2.goto(base + '?start=1&auto=1&speed=0&length=ikkyoku&sfx=0&dealer=' + d);
      await sleep(1200);
      const errs = await p2.evaluate(() => window.__err || []);
      const threw = errs.some((x) => /RangeError/.test(x) && /startDealer/.test(x));
      ok(threw === want,
        '?dealer=' + d + (want ? ' は RangeError で止まる' : ' は通る'),
        JSON.stringify(errs));
      await p2.close();
    }
  }

  ok(errors.length === 0, 'ページで例外が出ていない', errors.slice(0, 3).join(' / '));

  await browser.close();
  srv.close();

  log('\n通過 ' + pass + ' 件' + (fails.length ? ' / 失敗 ' + fails.length + ' 件' : ''));
  if (fails.length) { fails.forEach((f) => log('  ✗ ' + f)); process.exit(1); }
  log('すべて通過');
})();
