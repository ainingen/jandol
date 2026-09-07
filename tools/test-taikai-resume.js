#!/usr/bin/env node
/*
  大会の進行の控え（`docs/design/taikai/resume-spec.md` §4・§5）— 段2

    node tools/test-taikai-resume.js

  ここに書くのは **DOMに触らない側だけ**。`taikai.js` の画面（`mount` 以下）は
  触っていないし、ここからも呼ばない（§8）。見るのは `runTournament` の
  入口（`progress`）と出口（`onProgress`）だけ。

  §9 段2 の四項目：

    1. `playRealMatch` が2回戦で throw する stub で回す → `onProgress` に積まれた
       控えを渡して再度回す → **1回戦の結果が打ち直されず、`rounds` が同じ、
       最終的な `outcomeOf` が全員ぶん出る**
    2. 控えの `tables` が使われ、`makeTables` が呼ばれないこと
    3. `done` 付きの控えで、自分の卓が打たれずに結果が入ること
    4. 控え無しでいままでと同じ結果になること

  **`makeTables` を呼んだかどうかは差し替えて数える。**`tournament.js` の
  export をそのまま置き換えるのではなく、グローバルに載せた同じ関数を
  数える皮で包む（`taikai.js` はグローバルから読む）
*/
'use strict';

const chars = require('../src/characters.js');
Object.assign(global, {
  JANDOLS: chars.JANDOLS, FREE_AGENTS: chars.FREE_AGENTS, STYLES: chars.STYLES,
  PLAYER: chars.PLAYER, REGIONS: chars.REGIONS, RANK_INFO: chars.RANK_INFO,
  CONTRACTS: chars.CONTRACTS, popOf: chars.popOf,
});
const T = require('../src/tournament.js');
Object.assign(global, T);
global.Tournament = T;
const Taikai = require('../src/taikai.js');

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  … ' + detail : ''));
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' / want ' + JSON.stringify(b));
}
const J = (v) => JSON.stringify(v);
/* **大きいものを丸ごと出さない。**卓割りも結果も64人ぶんあるので、
   そのまま出すと画面が埋まって、どこが違うのかが読めなくなる（実際に埋まった）。
   食い違った最初の一つだけ言う */
function same(a, b, name) {
  const x = J(a), y = J(b);
  if (x === y) { pass++; return; }
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  fails.push(name + '  … ' + i + '文字目から違う: '
    + x.slice(Math.max(0, i - 30), i + 40) + '  ／  '
    + y.slice(Math.max(0, i - 30), i + 40));
}

/* ------------------------------------------------------------
   枠を手で組む。`prepare()` は乱数で `field` を作るので通さない
   ——**同じ顔ぶれで二度回して比べたい**（§9 段2 の 1・4）
------------------------------------------------------------ */
/* **64人にする。**`while (alive.length > 4)` は 64→16→4 と二度回り、
   決勝卓と合わせて**三回戦**になる。16人だと一度しか回らず、
   「1回戦は打ち直さない／2回戦から打つ」を見られない（実際に見られなかった） */
const SIZE = 64;                                   // 一回戦64 → 準決勝16 → 決勝卓4
const ROUNDS = 3;
function mkField() {
  const me = Object.assign({}, PLAYER, { id: 0, playerStrength: 55 });
  const foes = JANDOLS.slice(0, SIZE - 1);
  return [me].concat(foes);
}
function mkPrepared() {
  const field = mkField();
  return { tierId: 'open', tier: TOURNAMENTS.open, field, team: [field[0]] };
}
/* **自分が必ず勝ち上がる stub。**`simulateTable` に任せると
   一回戦で落ちる走行があり、「2回戦から打つ」が見られない日が出る */
function winStub(onCall) {
  return async (t, ctx) => {
    if (onCall) { const r = onCall(t, ctx); if (r) return r; }
    const me = t.find((c) => c.id === 0);
    const rest = t.filter((c) => c.id !== 0);
    return [{ chara: me, place: 1 }].concat(rest.map((c, i) => ({ chara: c, place: i + 2 })));
  };
}
/* 卓割りの乱数を止める。**同じ並びで二度回すため**——
   `makeTables` は `Math.random` でシャッフルするので、固定しないと
   「打ち直していない」を見ているのか「たまたま違う」のかが分からない */
function withFixedRandom(fn) {
  const real = Math.random;
  let n = 0;
  Math.random = () => { n = (n * 1103515245 + 12345) % 2147483648; return n / 2147483648; };
  try { return fn(); } finally { Math.random = real; }
}

/* `makeTables` を数える皮。**`taikai.js` はグローバルから読む** */
function countingMakeTables() {
  const real = T.makeTables;
  const box = { calls: 0, restore: null };
  global.makeTables = (f) => { box.calls++; return real(f); };
  box.restore = () => { global.makeTables = real; };
  return box;
}

/* 控えの形（§4）を機械的に見る */
function checkShape(p, where) {
  ok(p && typeof p === 'object', where + '：控えはオブジェクト');
  if (!p) return;
  eq(p.v, 1, where + '：v は 1');
  eq(p.tierId, 'open', where + '：tierId が入る');
  ok(Array.isArray(p.fieldIds) && p.fieldIds.length === SIZE,
     where + '：fieldIds は出走表ぶん', J(p.fieldIds && p.fieldIds.length));
  ok(p.fieldIds.every((id) => Number.isInteger(id)), where + '：fieldIds は id の配列');
  ok(Array.isArray(p.rounds), where + '：rounds は配列');
  p.rounds.forEach((r, i) => {
    ok(Array.isArray(r.tables) && r.tables.length > 0, where + '：rounds[' + i + '].tables がある');
    ok(r.tables.every((t) => Array.isArray(t) && t.every((id) => Number.isInteger(id))),
       where + '：tables は id の配列', J(r.tables));
    ok(Array.isArray(r.results) && r.results.length === r.tables.length,
       where + '：results は卓の数だけある', J(r.results && r.results.length));
  });
  ok(Number.isInteger(p.ri), where + '：ri は整数');
}

/* ============================================================
   1. 途中で落ちる → 控えから続ける
   ============================================================ */
(async () => {
  console.log('大会の進行の控え（taikai/resume-spec.md §4・§5）— 段2');

  /* ---------- 1. 2回戦で throw する stub ---------- */
  {
    const prepared = mkPrepared();
    const seen = [];
    let progress = null;
    const BOOM = new Error('ここで落ちたことにする');

    /* 自分の卓だけ「打った」印を残す stub。2回戦（round 1）で投げる */
    const stub = winStub((t, ctx) => {
      seen.push(ctx.round);
      if (ctx.round === 1) throw BOOM;
      return null;
    });

    let threw = null;
    await withFixedRandom(async () => {
      try {
        await Taikai.runTournament(prepared, {
          playRealMatch: stub,
          onProgress: (p) => { progress = JSON.parse(JSON.stringify(p)); },
          offerId: 'taikai-open-3',
        });
      } catch (e) { threw = e; }
    });
    ok(threw === BOOM, '2回戦で落ちた（stub が投げた）', String(threw));
    ok(seen.includes(0), '1回戦は打っていた', J(seen));
    checkShape(progress, '落ちたところの控え');
    /* **ここから先は控えがある前提。**無いまま進むと投げて、
       何件通ったかも分からなくなる（`onProgress` を実装する前に一度そうなった） */
    if (!progress) {
      ok(false, '控えが `onProgress` に届いていない（この先は見られない）');
      console.log(pass + ' 件通過');
      console.log('\n失敗 ' + fails.length + ' 件:');
      fails.forEach((f) => console.log('  ✗ ' + f));
      process.exit(1);
    }
    eq(progress.offerId, 'taikai-open-3', '依頼の id が控えに載る');

    /* 1回戦は全部の卓の結果が入っていること */
    const r0 = progress.rounds[0];
    ok(r0.results.every((x) => Array.isArray(x)),
       '1回戦の結果が全卓ぶん控えられている', J(r0.results.map((x) => (x ? 'o' : '-')).join('')));
    ok(progress.rounds[1] && progress.rounds[1].results.some((x) => x === null),
       '2回戦は途中（結果が入っていない卓がある）');
    const firstRound = J(r0);

    /* ---------- 控えを渡して再度回す ---------- */
    const seen2 = [];
    const stub2 = winStub((t, ctx) => { seen2.push(ctx.round); return null; });
    let progress2 = null;
    const run = await withFixedRandom(() => Taikai.runTournament(prepared, {
      playRealMatch: stub2,
      progress,
      onProgress: (p) => { progress2 = JSON.parse(JSON.stringify(p)); },
    }));

    ok(!seen2.includes(0), '**1回戦は打ち直されない**（自分の卓を呼んでいない）', J(seen2));
    ok(seen2.includes(1), '2回戦からは打つ', J(seen2));
    same(progress2.rounds[0], JSON.parse(firstRound), '**1回戦の控えがそのまま残る**（rounds が同じ）');

    /* 走り切って、全員ぶんの成績が出る */
    ok(run && Array.isArray(run.rounds), '走り切って結果が返る');
    eq(run.rounds.length, ROUNDS, '一回戦・準決勝・決勝卓の3つ');
    eq(run.rounds[0].size, SIZE, '一回戦は64人');
    eq(run.rounds[run.rounds.length - 1].name, '決勝卓', '最後は決勝卓');
    const missing = prepared.field.filter((c) => run.outcomeOf(c.id) === null);
    eq(missing.length, 0, '**outcomeOf が全員ぶん出る**',
       missing.map((c) => c.name).join('・'));
    eq(run.finalResult.length, 4, '決勝卓は4人');
    /* 1回戦の顔ぶれと結果が、控えたものと一致していること */
    const backIds = run.rounds[0].results.map((x) => x.table.map((c) => c.id));
    same(backIds, progress.rounds[0].tables, '1回戦の卓割りが控えどおり');
    const backPlaces = run.rounds[0].results.map((x) => x.result.map((y) => ({ id: y.chara.id, place: y.place })));
    same(backPlaces, progress.rounds[0].results, '1回戦の着順も控えどおり');
  }

  /* ============================================================
     2. 控えの tables が使われ、makeTables が呼ばれない
     ============================================================ */
  {
    const prepared = mkPrepared();
    let progress = null;
    await withFixedRandom(() => Taikai.runTournament(prepared, {
      onProgress: (p) => { progress = JSON.parse(JSON.stringify(p)); },
    }));
    eq(progress.rounds.length, ROUNDS, '前提：最後まで控えられている');

    const box = countingMakeTables();
    let progress2 = null;
    await withFixedRandom(() => Taikai.runTournament(prepared, {
      progress, onProgress: (p) => { progress2 = JSON.parse(JSON.stringify(p)); },
    }));
    box.restore();
    eq(box.calls, 0, '**控えが揃っていれば makeTables を一度も呼ばない**');
    same(progress2.rounds.map((r) => r.tables), progress.rounds.map((r) => r.tables),
       '卓割りは控えたものがそのまま使われる');
    same(progress2.rounds.map((r) => r.results), progress.rounds.map((r) => r.results),
       '結果も控えたものがそのまま（打ち直していない）');

    /* 控えが無ければ、いままでどおり `makeTables` を呼ぶ（比べる相手） */
    const box2 = countingMakeTables();
    await withFixedRandom(() => Taikai.runTournament(prepared, {}));
    box2.restore();
    ok(box2.calls > 0, '控えが無ければ makeTables を呼ぶ（前提の確認）', String(box2.calls));
  }

  /* ============================================================
     3. `done` 付きの控えで、自分の卓が打たれずに結果が入る
     ============================================================ */
  {
    const prepared = mkPrepared();
    /* 一回戦の卓割りだけ控えて、結果は空にする */
    let progress = null;
    await withFixedRandom(() => Taikai.runTournament(prepared, {
      onProgress: (p) => { if (!progress && p.rounds[0]) progress = JSON.parse(JSON.stringify(p)); },
    }));
    const half = JSON.parse(JSON.stringify(progress));
    half.rounds = [{ name: half.rounds[0].name, size: half.rounds[0].size,
                     tables: half.rounds[0].tables,
                     results: half.rounds[0].tables.map(() => null) }];
    half.ri = 0;
    const myTable = half.rounds[0].tables.find((ids) => ids.includes(0));
    ok(!!myTable, '前提：自分の卓が控えにある');

    /* `Resume` を差し替える。**`taikai.js` はグローバルから読む**
       （ブラウザでは `src/resume.js` が置くもの） */
    /* **自分（id 0）を一着にする。**ここで負けると一回戦で敗退して
       以降の卓が無くなり、「残りの回戦だけ打つ」が見られない */
    const pi = myTable.indexOf(0);
    const DONE = [{ seat: pi, place: 1 }].concat(
      myTable.map((id, i) => i).filter((i) => i !== pi)
        .map((i, n) => ({ seat: i, place: n + 2 })));
    let loads = 0;
    global.Resume = {
      load: () => { loads++; return { seats: myTable.slice(), done: DONE }; },
    };
    let called = 0;
    const run = await withFixedRandom(() => Taikai.runTournament(prepared, {
      playRealMatch: winStub(() => { called++; return null; }),
      progress: half,
    }));
    eq(called, ROUNDS - 1, '**一回戦は打たれない**（残りの回戦だけ打つ）');
    ok(loads > 0, 'Resume.load を読んだ', String(loads));

    /* `done` のとおりの着順が入っていること */
    const mine = run.rounds[0].results.find((x) => x.hasPlayer);
    ok(!!mine, '自分の卓が rounds に入っている');
    const got = mine.result.map((x) => ({ id: x.chara.id, place: x.place }));
    const want = DONE.slice().sort((a, b) => a.place - b.place)
      .map((d) => ({ id: myTable[d.seat], place: d.place }));
    same(got, want, '**`done` がそのまま着順になる**');
    ok(got.every((x, i) => x.place === i + 1), '着順は 1〜4 の順に並ぶ');

    /* 席が一致しない控えは使わない（§5 の 4 の三つめ） */
    global.Resume = { load: () => ({ seats: [999, 998, 997, 996], done: DONE }) };
    let called2 = 0, sawResume = 0;
    await withFixedRandom(() => Taikai.runTournament(prepared, {
      playRealMatch: winStub((t, ctx) => { called2++; if (ctx.resume) sawResume++; return null; }),
      progress: half,
    }));
    eq(called2, ROUNDS, '席が一致しなければ、自分の卓も普通に打つ（全回戦）');
    eq(sawResume, 0, '　ctx.resume は渡さない');

    /* `done` 無しの控えは `ctx.resume` として渡る（§5 の 4 の二つめ） */
    const REC = { seats: myTable.slice(), kyoku: 2, honba: 1, riichiSticks: 1,
                  scores: [26000, 24000, 25000, 25000], startDealer: 3 };
    global.Resume = { load: () => REC };
    const seenCtx = [];
    await withFixedRandom(() => Taikai.runTournament(prepared, {
      playRealMatch: winStub((t, ctx) => { seenCtx.push(ctx.resume || null); return null; }),
      progress: half,
    }));
    eq(seenCtx.length, ROUNDS, '自分の卓を全回戦ぶん打つ');
    same(seenCtx[0], REC, '**一回戦には控えが `ctx.resume` で渡る**（局の頭から）');
    eq(seenCtx[1], null, '二度目には渡さない（控えは一度きり）');
    delete global.Resume;

    /* **`progress` が無ければ `Resume` を読まない。**
       最初から始めるときに古い控えを拾うと、関係のない卓を復帰させてしまう */
    let loads2 = 0;
    global.Resume = { load: () => { loads2++; return { seats: myTable.slice(), done: DONE }; } };
    await withFixedRandom(() => Taikai.runTournament(prepared, {
      playRealMatch: winStub(),
    }));
    eq(loads2, 0, '**控えが無い走行では Resume.load を読まない**');
    delete global.Resume;
  }

  /* ============================================================
     4. 控え無しでいままでどおり
     ============================================================ */
  {
    const prepared = mkPrepared();
    /* `onProgress` も `progress` も渡さない＝段2 の前と同じ呼びかた */
    const run = await withFixedRandom(() => Taikai.runTournament(prepared, {}));
    ok(run && Array.isArray(run.rounds), '控え無しでも走る');
    eq(run.rounds.length, ROUNDS, '回戦の数は同じ');
    eq(run.finalResult.length, 4, '決勝卓は4人');
    ok(prepared.field.every((c) => run.outcomeOf(c.id) !== null), 'outcomeOf が全員ぶん出る');
    ok(Array.isArray(run.met) && Array.isArray(run.beaten), 'met / beaten が配列で返る');
    ok(typeof run.placeOf === 'function', 'placeOf が返る');

    /* **同じ種なら同じ結果**（`onProgress` を足しても乱数の引きかたが変わっていない）*/
    const a = withFixedRandom(() => Taikai.runTournament(prepared, {}));
    const b = withFixedRandom(() => Taikai.runTournament(prepared, { onProgress: () => {} }));
    const flat = (r) => r.rounds.map((x) => x.results.map((y) =>
      y.result.map((z) => z.chara.id + ':' + z.place).join(',')).join('|')).join(' / ');
    same(flat(await a), flat(await b),
       '**`onProgress` を渡しても結果が変わらない**（乱数の引きかたが同じ）');

    /* `playRealMatch` が何も返さないときは数値処理に落ちる（既存の約束） */
    const run2 = await withFixedRandom(() => Taikai.runTournament(prepared, {
      playRealMatch: async () => null,
    }));
    ok(run2.rounds.every((r) => r.results.every((x) => x.result.length === x.table.length)),
       'playRealMatch が null を返しても卓は埋まる');
  }

  console.log(pass + ' 件通過');
  if (fails.length) {
    console.log('\n失敗 ' + fails.length + ' 件:');
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('すべて通過');
})();
