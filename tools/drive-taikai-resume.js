#!/usr/bin/env node
/*
  大会の復帰を本編で回す（`docs/design/taikai/resume-spec.md` §9 段3）

    node tools/drive-taikai-resume.js

  `index.html` を Playwright で開いて、**表紙の「続きから」から先**を押す。
  純関数の側は `tools/test-taikai-resume.js`（段2）が見ているので、
  ここで見るのは**配線**——セーブ・画面・釦・捨てる条件。

    0. 控えが無い通常の起動で、いままでどおり事務所へ行くこと
    1. 途中の控えがあると、出走表に一言が出ること（文面・釦・「通信」と書かない）
    2. ［続ける］で1回戦が打ち直されず、`finish()` で
       `pendingTaikai` と `Resume` の**両方**が消えること
    3. ［この大会を諦める］で両方消えて事務所へ行くこと
    4. §7 の捨てる条件それぞれで、**黙って**事務所へ行くこと（一言を出さない）
    5. 「最初からはじめる」「セーブを消す」で `Resume` の控えも落ちること
       （`st` とは別の localStorage キーなので、忘れると残る）

  **控えは手で組まずに `runTournament` を実際に回して作る**——手で組むと
  形が本物とずれて、通っても何も保証しない。

  `--base` で配信元を変えられる（既定は自前の http サーバ）。
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

const chars = require('../src/characters.js');
const ALL = chars.JANDOLS.concat(chars.FREE_AGENTS);
const RKEY = 'jandol_match_resume_v1';

let pass = 0; const fails = [];
const ok = (c, n, d) => { if (c) { pass++; console.log('  ok  ' + n); }
  else { fails.push(n + (d ? ' … ' + d : '')); console.log('  NG  ' + n + (d ? ' … ' + d : '')); } };
const eq = (a, b, n) => ok(a === b, n, 'got ' + JSON.stringify(a) + ' / want ' + JSON.stringify(b));

const TEAM = ALL.filter((c) => c.contract === 'free' && c.rank === 'D').slice(0, 3).map((c) => c.id);
/* **`comp` を入れておく。**`JANDOLS` は `comp` を持たないので、契約したときに
   `scout.js` / `office.js` が `compFromRank` で埋める。空のまま契約済みにすると
   `finish()` の育成が `undefined.toFixed()` で落ちる（本編では起きない形） */
const COMP = {}; TEAM.forEach((id) => { COMP[id] = 20; });
function save(over) {
  return Object.assign({
    discovered: ALL.map((c) => c.id), contracted: TEAM.slice(),
    comp: Object.assign({}, COMP), compMax: {}, grades: {}, favor: {}, popUp: {},
    team: TEAM.slice(), teamDecided: true, money: 20000000,
    playerRank: 'S', playerWins: 9, records: {}, recent: [], agency: 5, beaten: [],
    officeName: 'テスト', officePref: 'tokyo',
    assign: {}, fatigue: {}, cond: {}, local: {}, mailRead: [],
    offers: [], offerFired: [], offerAccepted: ['taikai-open'], wins: {},
    autoMatch: true, pendingTaikai: null,
    parlor: { open: true, day: 40, rep: 55, tables: 4, interior: 3, auto: 2, sign: 2, shifts: {} },
  }, over || {});
}
const read = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('jandol_save_v1')));
const peekResume = (p) => p.evaluate((k) => localStorage.getItem(k), RKEY);
const screenOf = (p) => p.evaluate(() => ({
  title: (document.querySelector('.tkTitle') || {}).textContent || '',
  resume: !!document.querySelector('.tkResume'),
  head: (document.querySelector('.tkResume h2') || {}).textContent || '',
  body: (document.querySelector('.tkResume p') || {}).textContent || '',
  buttons: Array.from(document.querySelectorAll('.tkResumeBtns button')).map((b) => b.textContent.trim()),
  start: !!document.querySelector('[data-act="start"]'),
  room: !!document.querySelector('.ofRoom'),
  text: (document.body.innerText || '').slice(0, 120),
}));

(async () => {
  const { srv, port } = await serve();
  const BASE = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 380, height: 740 } });

  /* 大会を途中まで進めた控えを作る。**実際に runTournament を回して作る**
     ——手で組むと形が本物とずれる */
  async function makePending(page, stopAfter) {
    await page.goto(BASE + '/index.html');
    await page.evaluate((s) => localStorage.setItem('jandol_save_v1', JSON.stringify(s)), save());
    await page.goto(BASE + '/index.html');
    await page.waitForTimeout(400);
    return page.evaluate(async ([stop]) => {
      const st = JSON.parse(localStorage.getItem('jandol_save_v1'));
      const ALLC = JANDOLS.concat(FREE_AGENTS);
      const me = Object.assign({}, PLAYER, { id: 0, playerStrength: 55 });
      const team = [me].concat((st.team || []).map((id) => ALLC.find((c) => c.id === id)));
      const field = [me].concat(ALLC.slice(0, 63));
      const prepared = { tierId: 'open', tier: TOURNAMENTS.open, field, team };
      let snap = null, n = 0;
      const BOOM = new Error('stop');
      try {
        await Taikai.runTournament(prepared, {
          offerId: 'taikai-open',
          playRealMatch: async (t) => {
            if (++n > stop) throw BOOM;
            const meC = t.find((c) => c.id === 0);
            const rest = t.filter((c) => c.id !== 0);
            return [{ chara: meC, place: 1 }].concat(rest.map((c, i) => ({ chara: c, place: i + 2 })));
          },
          onProgress: (p) => { snap = JSON.parse(JSON.stringify(p)); },
        });
      } catch (e) { if (e !== BOOM) throw e; }
      return snap;
    }, [stopAfter]);
  }

  async function open(page, st, resumeRec) {
    await page.goto(BASE + '/index.html');
    await page.evaluate(([s, k, r]) => {
      localStorage.setItem('jandol_save_v1', JSON.stringify(s));
      if (r) localStorage.setItem(k, JSON.stringify(r)); else localStorage.removeItem(k);
    }, [st, RKEY, resumeRec || null]);
    await page.goto(BASE + '/index.html');
    await page.waitForTimeout(400);
    await page.click('[data-act="continue"]');
    await page.waitForTimeout(700);
  }

  /* ============================================================
     0. 控えが無い通常の起動＝いままでどおり
     ============================================================ */
  console.log('\n--- 控えが無いとき（いままでどおり）---');
  {
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await open(page, save());
    const s = await screenOf(page);
    eq(errs.length, 0, 'エラーが出ない', errs.join(' / '));
    ok(s.room, '**続きから → 事務所**（部屋が出る）', s.text);
    ok(!s.resume, '一言は出ない');
    const st = await read(page);
    eq(st.pendingTaikai, null, 'pendingTaikai は null のまま');
    await page.close();
  }

  /* ============================================================
     1. 途中の控えがあると、出走表に一言が出る
     ============================================================ */
  console.log('\n--- 途中の控えがあるとき ---');
  let pending = null;
  {
    const page = await ctx.newPage();
    pending = await makePending(page, 1);          // 一回戦だけ打った状態
    ok(pending && pending.rounds && pending.rounds.length >= 1, '控えが作れた',
       JSON.stringify(pending && pending.rounds && pending.rounds.length));
    eq(pending.offerId, 'taikai-open', '控えに offerId が載っている');

    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await open(page, save({ pendingTaikai: pending }));
    const s = await screenOf(page);
    eq(errs.length, 0, 'エラーが出ない', errs.join(' / '));
    ok(!s.room, '事務所へは行かない');
    ok(s.resume, '**出走表に一言が出る**', s.text);
    eq(s.head, 'この大会をやり直します', '見出し');
    ok(/^一時的に画面が止まったため、全国オープン /.test(s.body), '本文の頭', s.body);
    ok(!/通信|回線|ネット|オフライン|Wi-?Fi/i.test(s.body + s.head), '**「通信」と書いていない**', s.body);
    eq(JSON.stringify(s.buttons), JSON.stringify(['続ける', 'この大会を諦める']), '釦は二つ');
    ok(!s.start, '「卓に着く」は出さない');
    console.log('    本文: ' + s.body);
    ok(/ の最初から再開します$/.test(s.body), '控えが無ければ「…の最初から再開します」', s.body);
    await page.close();
  }

  /* ---- 1b. `done` 付きの控え＝その対局はもう終わっている ----
     **局名を出さない。**戻る先が局の頭ではなく「結果」なので、
     局名を出すと打ち直すように読める（`taikai/resume-spec.md` §3・§6） */
  {
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    const table = (pending.rounds[pending.ri] || pending.rounds[0]).tables.find((t) => t.includes(0))
      || pending.rounds[0].tables[0];
    const done = table.map((id, i) => ({ seat: i, place: i + 1 }));
    const rec = { v: 1, at: Date.now(), seats: table.slice(), kyoku: 3, honba: 1,
                  riichiSticks: 0, scores: [25000, 25000, 25000, 25000], startDealer: 0,
                  opts: { length: 'tonpuu' }, done };
    await open(page, save({ pendingTaikai: pending }), rec);
    const s = await screenOf(page);
    eq(errs.length, 0, 'エラーが出ない', errs.join(' / '));
    ok(s.resume, 'done 付きでも一言は出る（大会そのものは途中）');
    eq(s.body,
      '一時的に画面が止まったため、全国オープン 準決勝 の対局は終わっていました。結果から続けます',
      '**done のときの文面**');
    /* 「対局」にも「局」が入るので、**局名の形**で見る（東N局／南N局／N本場） */
    ok(!/[東南]\d局|\d+本場/.test(s.body), '　局名は出さない', s.body);
    ok(!/通信|回線|ネット|オフライン|Wi-?Fi/i.test(s.body), '　「通信」と書いていない');
    console.log('    本文: ' + s.body);
    await page.close();
  }

  /* ============================================================
     2. 「続ける」→ 打ち直さずに最後まで → finish で両方消える
     ============================================================ */
  console.log('\n--- 「続ける」 ---');
  {
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await open(page, save({ pendingTaikai: pending }));
    const before = JSON.stringify(pending.rounds[0]);
    await page.click('[data-act="resume"]');
    await page.waitForTimeout(2500);
    const st1 = await read(page);
    eq(JSON.stringify(st1.pendingTaikai.rounds[0]), before,
       '**1回戦の控えがそのまま残る（打ち直していない）**');
    /* 結果画面へ */
    await page.click('[data-act="result"]').catch(() => {});
    await page.waitForTimeout(900);
    const st2 = await read(page);
    eq(errs.length, 0, 'エラーが出ない', errs.join(' / '));
    if (errs.length) console.log('    エラー: ' + errs.join(' / '));
    eq(st2.pendingTaikai, null, '**finish で pendingTaikai が消える**');
    eq(await peekResume(page), null, '**Resume の控えも同時に消える**');
    ok((st2.records || {}).open, '大会の戦績が入っている', JSON.stringify(st2.records));
    await page.close();
  }

  /* ============================================================
     3. 「諦める」→ 両方消えて事務所へ
     ============================================================ */
  console.log('\n--- 「この大会を諦める」 ---');
  {
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    const rec = { v: 1, at: Date.now(), seats: [0, 1, 2, 3], kyoku: 2, honba: 1,
                  riichiSticks: 0, scores: [25000, 25000, 25000, 25000], startDealer: 0,
                  opts: { length: 'tonpuu' } };
    await open(page, save({ pendingTaikai: pending }), rec);
    ok((await screenOf(page)).resume, '前提：一言が出ている');
    await page.click('[data-act="abandon"]');
    await page.waitForTimeout(800);
    const s = await screenOf(page);
    const st = await read(page);
    eq(errs.length, 0, 'エラーが出ない', errs.join(' / '));
    ok(s.room, '**事務所へ行く**', s.text);
    eq(st.pendingTaikai, null, '**pendingTaikai が消える**');
    eq(await peekResume(page), null, '**Resume の控えも消える**');
    await page.close();
  }

  /* ============================================================
     4. §7 の捨てる条件。どれも黙って事務所へ
     ============================================================ */
  console.log('\n--- §7 の捨てる条件 ---');
  {
    const bad = [
      ['v が合わない', (p) => { p.v = 2; }],
      ['tierId が TOURNAMENTS に無い', (p) => { p.tierId = 'そんな大会は無い'; }],
      ['fieldIds に引けない id', (p) => { p.fieldIds[3] = 999999; }],
      ['fieldIds に自分がいない', (p) => { p.fieldIds = p.fieldIds.filter((i) => i !== 0); }],
      ['fieldIds にチームの子がいない', (p) => { p.fieldIds = p.fieldIds.filter((i) => i !== TEAM[0]); }],
      ['tables の id が fieldIds の外', (p) => { p.rounds[0].tables[0][0] = 999999; }],
      ['results の長さが tables と違う', (p) => { p.rounds[0].results.pop(); }],
      ['rounds が配列でない', (p) => { p.rounds = 'こわれている'; }],
    ];
    for (const [why, breakIt] of bad) {
      const page = await ctx.newPage();
      const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
      const p = JSON.parse(JSON.stringify(pending));
      breakIt(p);
      await open(page, save({ pendingTaikai: p }));
      await page.waitForTimeout(300);
      const s = await screenOf(page);
      const st = await read(page);
      ok(s.room, '（' + why + '）事務所へ行く', s.text.slice(0, 60));
      ok(!s.resume, '　一言を出さない');
      eq(st.pendingTaikai, null, '　黙って消える');
      eq(errs.length, 0, '　エラーが出ない', errs.join(' / '));
      await page.close();
    }
  }

  /* ============================================================
     5. 「最初からはじめる」「セーブを消す」で Resume も落ちる
     ============================================================ */
  console.log('\n--- 最初からはじめる／セーブを消す ---');
  {
    const rec = { v: 1, at: Date.now(), seats: [0, 1, 2, 3], kyoku: 2, honba: 0,
                  riichiSticks: 0, scores: [25000, 25000, 25000, 25000], startDealer: 0,
                  opts: { length: 'tonpuu' } };
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html');
    await page.evaluate(([s, k, r]) => {
      localStorage.setItem('jandol_save_v1', JSON.stringify(s));
      localStorage.setItem(k, JSON.stringify(r));
    }, [save({ pendingTaikai: pending }), RKEY, rec]);
    await page.goto(BASE + '/index.html');
    await page.waitForTimeout(400);
    /* 「最初からはじめる」→ 事務所名と本拠地の画面 →「はじめる」で `onStart` */
    await page.click('[data-act="new"]');
    await page.waitForTimeout(500);
    await page.click('[data-pref="tokyo"]');
    await page.waitForTimeout(200);
    await page.click('[data-act="go"]');
    await page.waitForTimeout(800);
    const st = await read(page);
    eq(st.pendingTaikai, null, '「最初からはじめる」で pendingTaikai が消える');
    eq(await peekResume(page), null, '**Resume の控えも消える**（別のキー）');
    await page.close();

    /* 「セーブを消す」（#appReset）。window.confirm を受ける */
    const page2 = await ctx.newPage();
    page2.on('dialog', (d) => d.accept());
    await page2.goto(BASE + '/index.html');
    await page2.evaluate(([s, k, r]) => {
      localStorage.setItem('jandol_save_v1', JSON.stringify(s));
      localStorage.setItem(k, JSON.stringify(r));
    }, [save({ pendingTaikai: pending }), RKEY, rec]);
    await page2.goto(BASE + '/index.html');
    await page2.waitForTimeout(400);
    await page2.click('[data-act="continue"]');
    await page2.waitForTimeout(600);
    await page2.click('#appReset');
    await page2.waitForTimeout(700);
    eq(await peekResume(page2), null, '「セーブを消す」でも Resume の控えが消える');
    await page2.close();
  }

  await browser.close();
  srv.close();
  console.log('\n通過 ' + pass + ' 件');
  if (fails.length) { console.log('失敗 ' + fails.length + ' 件'); fails.forEach((x) => console.log('  - ' + x)); process.exit(1); }
  console.log('すべて通過');
})();
