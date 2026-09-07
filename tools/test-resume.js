#!/usr/bin/env node
/*
  対局の復帰 — `Game` の口の錠（段1）

    node tools/test-resume.js

  `docs/design/match/resume-spec.md` §8 段1。ここで見るのは **`Game` だけ**
  ——保存そのもの（`Resume` / `localStorage` / `match.html` の復帰画面）は段2以降で、
  この道具はブラウザを立てない（`test-match.js` と同じ方針）。

  見るのは五つ。

    1. `opts` で局の頭の状態が入ること（§7）
       `kyoku` `honba` `riichiSticks` `scores`、および
       そこから**派生する** `dealer` と `bakaze`（§2）
    2. `kyoku = 5` の南場（`length: 'hanchan'`）
       `bakaze === 28`、`dealer === (startDealer + 4) % 4`
    3. **既定値のときに、いままでと同じ結果になること**
       `kyoku = 1` なら `dealer === startDealer`。渡さなければ 25000 点の4人
       ——ここが崩れると、復帰の口を足しただけで普通の対局が変わる
    4. **範囲外は黙って丸めずに投げること**（§7）
       丸めると「東4局のつもりが東1局から始まっていた」が黙って通る
    5. `io.handStart` を持たない `io` でも `playHand()` が回ること（§3）
       ——`io` は `UI` だけではない（`tools/measure-fatigue.js` はヘッドレスの `io`）

  **`deal()` と `nextKyoku()` には触らない**（§10）ので、ここでも見ない。
  局の進みかたの錠は `tools/test-match.js` の側にある。
*/
'use strict';

/* ブラウザでは <script> が並ぶだけなので、グローバルに置くのがそのままの姿。
   `playHand()` を実際に回す試験だけが Engine と AI を読む */
global.Engine = require('../src/engine.js');
global.AI = require('../src/ai.js');
const { Game } = require('../src/game.js');

let pass = 0;
const fails = [];

function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  … ' + detail : ''));
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' / want ' + JSON.stringify(b));
}
/* 投げること自体と、投げかたの両方を見る。
   `throw` を消して丸めに戻したら、ここが落ちる */
function throws(fn, name) {
  try { fn(); } catch (e) { ok(e instanceof RangeError, name + '（RangeError）', String(e)); return; }
  fails.push(name + '  … 投げなかった');
}

/* 何もしない `io`。`playHand()` を回す試験だけが中身を使う */
const NOOP_IO = {
  update: () => {},
  event: async () => {},
  aiTell: async () => {},
  aiPause: async () => {},
  result: async () => {},
  gameOver: async () => {},
  accuseResult: async () => {},
  askTurn: async () => { throw new Error('askTurn が呼ばれた（spectate のはず）'); },
  askCall: async () => { throw new Error('askCall が呼ばれた（spectate のはず）'); },
};
const scores = (g) => g.players.map((p) => p.score);

/* ============================================================
   1. `opts` で局の頭の状態が入る（§7）
   ============================================================ */
{
  const g = new Game(NOOP_IO, {
    length: 'hanchan', startDealer: 3,
    kyoku: 2, honba: 1, riichiSticks: 2,
    scores: [25000, 26000, 24000, 25000],
  });
  eq(g.kyoku, 2, 'opts.kyoku が入る');
  eq(g.honba, 1, 'opts.honba が入る');
  eq(g.riichiSticks, 2, 'opts.riichiSticks が入る（本数）');
  ok(JSON.stringify(scores(g)) === JSON.stringify([25000, 26000, 24000, 25000]),
    'opts.scores が席順で入る', JSON.stringify(scores(g)));
  eq(g.startDealer, 3, 'startDealer は渡したまま');
  /* 親は保存せず kyoku から引く（§2）。(3 + 2 - 1) % 4 = 0 */
  eq(g.dealer, 0, 'dealer は (startDealer + kyoku - 1) % 4 で派生する');
  eq(g.bakaze, 27, 'kyoku 2 は東場');

  /* 自風は dealer を確定させたあとに置くこと。
     先に置くと、復帰したときだけ一周ずれる（描画が先に走った瞬間に見える） */
  ok(g.players.every((p) => p.jikaze === 27 + ((p.seat - g.dealer + 4) % 4)),
    '自風の保険が dealer と揃っている', JSON.stringify(g.players.map((p) => p.jikaze)));

  /* 局中の状態は保存しない（§2）。deal() が作り直すので、
     この時点ではまだ配られていない */
  ok(g.players.every((p) => p.hand.length === 0), '配牌はまだ引いていない');
  eq(g.finished, false, '終わっていない');
}

/* opts.scores は startScore より優先（§7） */
{
  const g = new Game(NOOP_IO, { startScore: 30000, scores: [1000, 2000, 3000, 4000] });
  ok(JSON.stringify(scores(g)) === JSON.stringify([1000, 2000, 3000, 4000]),
    'opts.scores は startScore より優先', JSON.stringify(scores(g)));
}
{
  const g = new Game(NOOP_IO, { startScore: 30000 });
  ok(scores(g).every((s) => s === 30000), 'scores を渡さなければ startScore のまま');
}

/* 飛んだ点（負の持ち点）も入る——`nextKyoku` が終了を決めるのは局の終わりで、
   復帰の入口で弾く話ではない。ここで拒むと「読めるが復帰できない保存」が出る */
{
  const g = new Game(NOOP_IO, { scores: [-1500, 30000, 35000, 36500] });
  eq(scores(g)[0], -1500, 'マイナスの持ち点も入る');
}

/* ============================================================
   2. kyoku = 5 の南場（§8 段1）
   ============================================================ */
{
  const g = new Game(NOOP_IO, { length: 'hanchan', startDealer: 3, kyoku: 5 });
  eq(g.bakaze, 28, 'kyoku 5 は南場（bakaze 28）');
  eq(g.dealer, (3 + 4) % 4, 'kyoku 5 の親は (startDealer + 4) % 4');
  eq(g.dealer, 3, '　同じことを数で言う（起家に一周戻る）');
  /* 表示は ((kyoku-1)%4)+1（§6）。南1局になること */
  eq(((g.kyoku - 1) % 4) + 1, 1, '表示上は「南1局」');
}
{
  const g = new Game(NOOP_IO, { length: 'hanchan', startDealer: 0, kyoku: 8, honba: 3 });
  eq(g.bakaze, 28, '南4局も南場');
  eq(g.dealer, 3, '南4局の親（起家 0）');
  eq(g.honba, 3, '本場も入る');
}
/* kyoku 4 と 5 の境目。ここを > 4 でなく >= 4 と書くとずれる */
{
  eq(new Game(NOOP_IO, { length: 'hanchan', kyoku: 4 }).bakaze, 27, '東4局はまだ東場');
  eq(new Game(NOOP_IO, { length: 'hanchan', kyoku: 5 }).bakaze, 28, '南1局から南場');
}

/* 親の一周。起家をずらしても式が合うこと */
for (let sd = 0; sd < 4; sd++) {
  for (let k = 1; k <= 8; k++) {
    const g = new Game(NOOP_IO, { length: 'hanchan', startDealer: sd, kyoku: k });
    eq(g.dealer, (sd + k - 1) % 4, `起家 ${sd} / ${k}局目の親`);
  }
}

/* ============================================================
   3. 既定値のときは、いままでと同じ（§7）
   ============================================================ */
{
  /* startDealer を渡さなければ乱数。どこに落ちても kyoku=1 なら dealer=startDealer */
  for (let i = 0; i < 40; i++) {
    const g = new Game(NOOP_IO, {});
    ok(g.dealer === g.startDealer, '既定：kyoku 1 なら dealer === startDealer',
      'dealer ' + g.dealer + ' / startDealer ' + g.startDealer);
    ok(g.dealer >= 0 && g.dealer < 4, '既定：親は 0〜3');
  }
}
{
  const g = new Game(NOOP_IO, { startDealer: 2 });
  eq(g.kyoku, 1, '既定の kyoku は 1');
  eq(g.honba, 0, '既定の honba は 0');
  eq(g.riichiSticks, 0, '既定の riichiSticks は 0');
  eq(g.bakaze, 27, '既定は東場');
  eq(g.dealer, 2, '既定：dealer === startDealer');
  ok(scores(g).every((s) => s === 25000), '既定の持ち点は 25000 の4人');
  ok(g.players.every((p) => p.jikaze === 27 + ((p.seat - 2 + 4) % 4)),
    '既定でも自風の保険はいままでどおり');
}
/* undefined を明示的に渡しても既定に落ちること
   ——`match.js` が opts をそのまま転送する（段2）ので、
   「持っていないキー」と「undefined のキー」が同じに扱われる必要がある */
{
  const g = new Game(NOOP_IO, {
    startDealer: 1, kyoku: undefined, honba: undefined,
    riichiSticks: undefined, scores: undefined,
  });
  eq(g.kyoku, 1, 'kyoku: undefined は既定');
  eq(g.honba, 0, 'honba: undefined は既定');
  eq(g.riichiSticks, 0, 'riichiSticks: undefined は既定');
  ok(scores(g).every((s) => s === 25000), 'scores: undefined は startScore');
  eq(g.dealer, 1, 'undefined だらけでも dealer === startDealer');
}
/* 既定の length は東風のまま。復帰の口を足して maxKyoku が動いていないこと */
{
  eq(new Game(NOOP_IO, {}).maxKyoku, 4, '既定は東風（maxKyoku 4）');
  eq(new Game(NOOP_IO, { length: 'hanchan' }).maxKyoku, 8, '半荘は 8');
  eq(new Game(NOOP_IO, { length: 'ikkyoku' }).maxKyoku, 1, '一局は 1');
}

/* ============================================================
   4. 範囲外は投げる（§7。黙って丸めない）
   ============================================================ */
throws(() => new Game(NOOP_IO, { kyoku: 0 }), 'kyoku 0 は投げる');
throws(() => new Game(NOOP_IO, { kyoku: -1 }), 'kyoku が負なら投げる');
throws(() => new Game(NOOP_IO, { kyoku: 5 }), '東風で kyoku 5 は投げる（maxKyoku 4）');
throws(() => new Game(NOOP_IO, { length: 'hanchan', kyoku: 9 }), '半荘で kyoku 9 は投げる');
throws(() => new Game(NOOP_IO, { length: 'ikkyoku', kyoku: 2 }), '一局で kyoku 2 は投げる');
throws(() => new Game(NOOP_IO, { kyoku: 1.5 }), 'kyoku が整数でなければ投げる');
throws(() => new Game(NOOP_IO, { kyoku: '2' }), 'kyoku が文字列なら投げる');
throws(() => new Game(NOOP_IO, { kyoku: NaN }), 'kyoku が NaN なら投げる');
throws(() => new Game(NOOP_IO, { kyoku: null }), 'kyoku が null なら投げる');
throws(() => new Game(NOOP_IO, { honba: -1 }), 'honba が負なら投げる');
throws(() => new Game(NOOP_IO, { honba: 1.5 }), 'honba が整数でなければ投げる');
throws(() => new Game(NOOP_IO, { riichiSticks: -1 }), 'riichiSticks が負なら投げる');
throws(() => new Game(NOOP_IO, { riichiSticks: 0.5 }), 'riichiSticks が整数でなければ投げる');
throws(() => new Game(NOOP_IO, { scores: [1, 2, 3] }), 'scores が3つなら投げる');
throws(() => new Game(NOOP_IO, { scores: [1, 2, 3, 4, 5] }), 'scores が5つなら投げる');
throws(() => new Game(NOOP_IO, { scores: [1, 2, 3, 'x'] }), 'scores に数でないものが混ざれば投げる');
throws(() => new Game(NOOP_IO, { scores: [1, 2, 3, NaN] }), 'scores に NaN が混ざれば投げる');
throws(() => new Game(NOOP_IO, { scores: 25000 }), 'scores が配列でなければ投げる');
throws(() => new Game(NOOP_IO, { scores: null }), 'scores が null なら投げる');

/* 境目は通ること。**投げすぎも壊れている** */
{
  ok(new Game(NOOP_IO, { kyoku: 1 }).kyoku === 1, 'kyoku 1 は通る');
  ok(new Game(NOOP_IO, { kyoku: 4 }).kyoku === 4, '東風の kyoku 4 は通る');
  ok(new Game(NOOP_IO, { length: 'hanchan', kyoku: 8 }).kyoku === 8, '半荘の kyoku 8 は通る');
  ok(new Game(NOOP_IO, { honba: 0 }).honba === 0, 'honba 0 は通る');
  ok(new Game(NOOP_IO, { riichiSticks: 0 }).riichiSticks === 0, 'riichiSticks 0 は通る');
}

/* ============================================================
   5. `io.handStart` の口（§3）
   ============================================================ */

/* 持っていない `io` でも回ること。**`?.` を外したらここが落ちる。**
   `spectate: true` で四人とも AI なので askTurn は呼ばれない
   （`tools/measure-fatigue.js` と同じ形） */
(async () => {
  {
    ok(!('handStart' in NOOP_IO), '前提：この io は handStart を持たない');
    const g = new Game(NOOP_IO, { spectate: true, length: 'ikkyoku', startDealer: 0 });
    let r = null;
    try {
      r = await g.playHand();
    } catch (e) {
      fails.push('handStart を持たない io で playHand が落ちた  … ' + (e && e.stack || e));
    }
    ok(r === 'continue' || r === 'end',
      'handStart を持たない io でも playHand が最後まで回る', 'got ' + JSON.stringify(r));
  }

  /* 持っている `io` では、局の頭で一度だけ呼ばれ、`Game` そのものが渡ること */
  {
    const seen = [];
    const io = Object.assign({}, NOOP_IO, { handStart: (g) => { seen.push(g); } });
    const g = new Game(io, { spectate: true, length: 'ikkyoku', startDealer: 0 });
    await g.playHand();
    eq(seen.length, 1, 'handStart は一局につき一度だけ呼ばれる');
    ok(seen[0] === g, 'handStart には Game そのものが渡る');
  }

  /* 呼ばれる位置。**deal() の直後で、最初のツモの前**（§3）。
     `update` より前でなければ、描画のほうが先に走る */
  {
    const order = [];
    let atCall = null;
    const io = Object.assign({}, NOOP_IO, {
      handStart: (g) => {
        order.push('handStart');
        /* 局中の状態は作り直されている（deal() の後）。
           配牌はあるが、まだ誰も打っていない */
        atCall = {
          hands: g.players.map((p) => p.hand.length),
          discards: g.players.reduce((n, p) => n + p.discards.length, 0),
          dora: g.doraIndicators.length,
          kyoku: g.kyoku, honba: g.honba, sticks: g.riichiSticks,
          scores: g.players.map((p) => p.score),
        };
      },
      update: () => { order.push('update'); },
      event: async () => { order.push('event'); },
    });
    const g = new Game(io, {
      spectate: true, length: 'hanchan', startDealer: 2,
      kyoku: 3, honba: 2, riichiSticks: 1, scores: [26000, 24000, 25000, 25000],
    });
    await g.playHand();
    eq(order[0], 'handStart', 'handStart は update より前（deal() の直後）');
    eq(order[1], 'update', '　その次が update');
    eq(order[2], 'event', '　そのあとが局名の帯');
    /* `deal()` が配るのは四人とも13枚。**親の14枚目は配牌ではなくツモ**で、
       それは playHand の輪の中（drawTile）なので、この時点ではまだ来ていない */
    ok(atCall.hands.every((n) => n === 13),
      'handStart の時点で配牌は済んでいる（四人とも13枚）', JSON.stringify(atCall.hands));
    eq(atCall.discards, 0, 'handStart の時点で河は空（最初の打牌の前）');
    eq(atCall.dora, 1, 'handStart の時点でドラ表示は1枚');
    /* **保存したい値がその場で読めること**（§2）。
       ここが読めなければ、段2 で書き出すものが無い */
    eq(atCall.kyoku, 3, 'handStart から kyoku が読める');
    eq(atCall.honba, 2, 'handStart から honba が読める');
    eq(atCall.sticks, 1, 'handStart から riichiSticks が読める');
    ok(JSON.stringify(atCall.scores) === JSON.stringify([26000, 24000, 25000, 25000]),
      'handStart から持ち点が読める（点棒が動く前）', JSON.stringify(atCall.scores));
    ok(g.startDealer === 2, 'handStart のあとも startDealer は動かない');
  }

  /* 局をまたいで毎回呼ばれること。**局の頭ごとに一度。**
     一局だけの `length` では確かめられないので、東風を最後まで回す */
  {
    let calls = 0;
    const keys = [];
    const io = Object.assign({}, NOOP_IO, {
      handStart: (g) => { calls++; keys.push(g.kyoku + ':' + g.honba); },
    });
    const g = new Game(io, { spectate: true, length: 'tonpuu', startDealer: 0 });
    await g.run();
    ok(calls >= 4, '東風なら handStart は4回以上（連荘があれば増える）', 'calls ' + calls);
    ok(keys.length === new Set(keys).size,
      '同じ「局:本場」で二度呼ばれない', keys.join(' / '));
    ok(g.finished === true || g.kyoku > g.maxKyoku, '対局は終わっている');
  }

  /* 途中の局から始めて、そこから最後まで回れること。
     ——**局の頭の状態だけで対局が続く**というのが復帰の前提そのもの（§1） */
  {
    const keys = [];
    const io = Object.assign({}, NOOP_IO, {
      handStart: (g) => { keys.push(g.kyoku); },
    });
    const g = new Game(io, {
      spectate: true, length: 'hanchan', startDealer: 1,
      kyoku: 7, honba: 0, riichiSticks: 1, scores: [30000, 20000, 28000, 22000],
    });
    await g.run();
    eq(keys[0], 7, '始まりは渡した局（南3局）');
    ok(g.kyoku >= 7, '局は戻らない', 'kyoku ' + g.kyoku);
    ok(g.finished === true, '南4局まで打って終わる');
    /* 供託1本は誰かが持っていく。点棒の合計は 25000×4 ＋ 供託1000 */
    const total = g.players.reduce((n, p) => n + p.score, 0);
    eq(total, 100000 + 1000, '点棒の合計は持ち込みぶんと供託で閉じる');
  }

  /* ---------------- 結果 ---------------- */
  console.log('対局の復帰 — Game の口の錠（段1）');
  console.log('通過 ' + pass + ' 件' + (fails.length ? ' / 失敗 ' + fails.length + ' 件' : ''));
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('すべて通過');
})();
