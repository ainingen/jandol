#!/usr/bin/env node
/*
  対局の復帰 — `Game` の口と `Resume` の錠（段1・段2）

    node tools/test-resume.js

  `docs/design/match/resume-spec.md` §8。**DOMに触らない側だけ**を見る
  （`test-match.js` と同じ方針）。実際に打って `localStorage` が
  更新されるかは `tools/drive-resume.js`、復帰の画面は段3。

  段1（`Game` の口）で見るのは五つ。

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

  段2（`Resume`）で見るのは三つ。

    6. 控えた記録の形（§2）
       局中の状態（山・手牌・河・ドラ）を持たないこと、
       `bakaze` と `dealer` を持たないこと（`kyoku` から派生するので）、
       `opts` は5つだけ控えること
    7. **捨てる条件が全部効くこと**（§5）
       版・24時間・数の合わない配列・`maxKyoku` 超え・引けないキャラ。
       **捨てるときは黙って消すこと**——投げない
    8. **`localStorage` が使えなくても対局が続くこと**（§8 段2）
       Safari のプライベートモードは `setItem` で投げる

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

  /* ============================================================
     6〜8. `Resume`（段2）

     **ブラウザは立てない。**`localStorage` だけを差し替えて、
     保存の形と「捨てる条件」（§5）を見る。
     実際に打って更新されるかは `tools/drive-resume.js`（Playwright）
     ============================================================ */
  {
    /* 最小の localStorage。**投げる版にも差し替えられる**ようにしておく */
    const mem = { data: null, failWrite: false, failRead: false };
    global.localStorage = {
      getItem: (k) => {
        if (mem.failRead) throw new Error('読めない環境');
        return k === 'jandol_match_resume_v1' ? mem.data : null;
      },
      setItem: (k, v) => {
        if (mem.failWrite) throw new Error('QuotaExceededError');
        if (k === 'jandol_match_resume_v1') mem.data = String(v);
      },
      removeItem: (k) => { if (k === 'jandol_match_resume_v1') mem.data = null; },
    };
    const chars = require('../src/characters.js');
    global.JANDOLS = chars.JANDOLS;
    global.FREE_AGENTS = chars.FREE_AGENTS;
    global.PLAYER = chars.PLAYER;
    global.Game = Game;
    const Resume = require('../src/resume.js');

    const SEATS = [
      Object.assign({}, chars.PLAYER),
      chars.JANDOLS[0], chars.JANDOLS[1], chars.JANDOLS[2],
    ];
    const OPTS = { title: '単体の対局', speed: 520, length: 'hanchan',
      showHints: true, discardMode: 'single' };
    const mkGame = (over) => new Game(NOOP_IO, Object.assign(
      { length: 'hanchan', startDealer: 3, kyoku: 2, honba: 1, riichiSticks: 2,
        scores: [25000, 26000, 24000, 25000] }, over || {}));
    const stored = () => JSON.parse(mem.data);
    const reset = () => { mem.data = null; mem.failWrite = false; mem.failRead = false; };

    /* ---- 6. 控えた記録の形（§2） ---- */
    reset();
    ok(Resume.save(mkGame(), SEATS, OPTS) === true, 'save は書けたら true');
    {
      const r = stored();
      eq(r.v, 1, '版が入る');
      eq(r.kyoku, 2, 'kyoku を控える');
      eq(r.honba, 1, 'honba を控える');
      eq(r.riichiSticks, 2, 'riichiSticks を控える');
      eq(r.startDealer, 3, 'startDealer を控える');
      ok(JSON.stringify(r.scores) === JSON.stringify([25000, 26000, 24000, 25000]),
        '持ち点を席順で控える', JSON.stringify(r.scores));
      ok(JSON.stringify(r.seats) === JSON.stringify(SEATS.map((c) => c.id)),
        'キャラIDを席順で控える（自分が先頭）', JSON.stringify(r.seats));
      ok(Number.isInteger(r.at) && Math.abs(Date.now() - r.at) < 5000, '時刻が入る');

      /* **派生できるものは控えない**（§2）。控えると二か所になって必ずずれる */
      ok(!('bakaze' in r), 'bakaze は控えない（kyoku から派生する）');
      ok(!('dealer' in r), 'dealer は控えない（kyoku から派生する）');
      /* **局中の状態は控えない。**deal() が作り直す */
      const keys = Object.keys(r).join(' ');
      ok(!/wall|deadWall|hand|discard|dora|melds/i.test(keys),
        '山・手牌・河・ドラ・副露は控えない', keys);

      /* opts は5つだけ（§2）。復帰の値を混ぜると最上位と二重になる */
      ok(JSON.stringify(Object.keys(r.opts).sort())
        === JSON.stringify(['discardMode', 'length', 'showHints', 'speed', 'title']),
        'opts は5つだけ控える', JSON.stringify(Object.keys(r.opts)));
    }
    /* 復帰の値が opts に紛れ込まないこと（段3 で opts に足して渡すため） */
    reset();
    Resume.save(mkGame(), SEATS, Object.assign({}, OPTS,
      { kyoku: 5, honba: 9, scores: [0, 0, 0, 0], startDealer: 1 }));
    {
      const o = stored().opts;
      ok(!('kyoku' in o) && !('honba' in o) && !('scores' in o) && !('startDealer' in o),
        '復帰の値は opts に控えない（最上位と二重にしない）', JSON.stringify(o));
      eq(stored().kyoku, 2, '最上位は Game の値のまま');
    }

    /* 読み戻せること。**Game にそのまま渡して投げないこと**が約束（§7） */
    reset();
    Resume.save(mkGame(), SEATS, OPTS);
    {
      const rec = Resume.load();
      ok(!!rec, '書いた直後は読める');
      eq(rec.kyoku, 2, '読み戻した kyoku');
      eq(rec.startDealer, 3, '読み戻した startDealer');
      ok(rec.charas.length === 4 && rec.charas[0].id === 0,
        'キャラを引き直して添える（§6-3）');
      ok(rec.charas[1] === chars.JANDOLS[0], '引いたのは元データそのもの');
      /* 通った記録は Game が受け取れること——ここが段3 の前提 */
      let g2 = null;
      try {
        g2 = new Game(NOOP_IO, Object.assign({}, rec.opts, {
          startDealer: rec.startDealer, kyoku: rec.kyoku, honba: rec.honba,
          riichiSticks: rec.riichiSticks, scores: rec.scores,
        }));
      } catch (e) { fails.push('load を通った記録で Game が投げた  … ' + e); }
      if (g2) {
        eq(g2.kyoku, 2, '復帰した Game の kyoku');
        eq(g2.dealer, 0, '復帰した Game の親（(3+2-1)%4）');
        eq(g2.players[1].score, 26000, '復帰した Game の持ち点');
      }
      ok(mem.data !== null, 'load は消さない（通ったものは残す）');
    }

    /* 局名（§6 の一言）。表示は ((kyoku-1)%4)+1、kyoku>4 なら南 */
    eq(Resume.kyokuName(2, 1), '東2局 1本場', '局名（東場）');
    eq(Resume.kyokuName(5, 0), '南1局 0本場', '局名（南場）');
    eq(Resume.kyokuName(8, 3), '南4局 3本場', '局名（南4局）');

    /* ---- 7. 捨てる条件（§5）。**黙って消すこと** ---- */
    const put = (over) => {
      reset();
      Resume.save(mkGame(), SEATS, OPTS);
      const r = Object.assign(stored(), over || {});
      mem.data = JSON.stringify(r);
    };
    const dropped = (over, name) => {
      put(over);
      let got;
      try { got = Resume.load(); } catch (e) { fails.push(name + '  … 投げた: ' + e); return; }
      ok(got === null, name + '（null を返す）', JSON.stringify(got && got.kyoku));
      ok(mem.data === null, name + '（黙って消す）');
    };

    dropped({ v: 2 }, '版が違えば捨てる');
    dropped({ v: 0 }, '版が 0 でも捨てる');
    dropped({ at: Date.now() - 25 * 3600 * 1000 }, '24時間を超えたら捨てる');
    dropped({ at: Date.now() + 10 * 60 * 1000 }, '未来の時刻なら捨てる（時計が動いた）');
    dropped({ seats: [0, 1, 2] }, 'seats が3つなら捨てる');
    dropped({ seats: [0, 1, 2, 3, 4] }, 'seats が5つなら捨てる');
    dropped({ scores: [1, 2, 3] }, 'scores が3つなら捨てる');
    dropped({ scores: [1, 2, 3, 'x'] }, 'scores に数でないものが混ざれば捨てる');
    dropped({ kyoku: 0 }, 'kyoku が 1 未満なら捨てる');
    dropped({ kyoku: 9 }, '半荘で kyoku 9 なら捨てる（maxKyoku 超え）');
    dropped({ kyoku: 1.5 }, 'kyoku が整数でなければ捨てる');
    dropped({ honba: -1 }, 'honba が負なら捨てる');
    dropped({ riichiSticks: -1 }, 'riichiSticks が負なら捨てる');
    dropped({ startDealer: 4 }, 'startDealer が 0〜3 の外なら捨てる');
    dropped({ seats: [0, 1, 2, 99999] }, '引けないキャラIDなら捨てる');
    dropped({ seats: [1, 2, 3, 4] }, '自分（id 0）がいない卓なら捨てる');

    /* 長さで maxKyoku が変わること。**Game の式を写していない**ことの確認でもある */
    dropped({ kyoku: 5, opts: Object.assign({}, OPTS, { length: 'tonpuu' }) },
      '東風で kyoku 5 なら捨てる');
    dropped({ kyoku: 2, opts: Object.assign({}, OPTS, { length: 'ikkyoku' }) },
      '一局で kyoku 2 なら捨てる');
    {
      put({ kyoku: 4, opts: Object.assign({}, OPTS, { length: 'tonpuu' }) });
      ok(Resume.load() !== null, '東風の kyoku 4 は通る（境目を投げすぎない）');
      put({ kyoku: 8 });
      ok(Resume.load() !== null, '半荘の kyoku 8 は通る');
    }

    /* 壊れた中身。**投げずに捨てる** */
    reset(); mem.data = 'これはJSONではない';
    ok(Resume.load() === null, '壊れた JSON なら捨てる');
    ok(mem.data === null, '　黙って消す');
    reset(); mem.data = 'null';
    ok(Resume.load() === null, 'null が入っていれば捨てる');
    reset(); mem.data = '[1,2,3]';
    ok(Resume.load() === null, '配列が入っていれば捨てる');
    reset();
    ok(Resume.load() === null, '何も無ければ null');

    /* clear は消す。二度呼んでも壊れない */
    reset();
    Resume.save(mkGame(), SEATS, OPTS);
    ok(mem.data !== null, '前提：書けている');
    Resume.clear();
    ok(mem.data === null, 'clear で消える');
    Resume.clear();
    ok(mem.data === null, 'clear は二度呼んでも壊れない');

    /* ---- 8. localStorage が使えなくても続くこと（§8 段2） ---- */
    reset();
    mem.failWrite = true;
    let threw = null;
    try {
      ok(Resume.save(mkGame(), SEATS, OPTS) === false, '書けなければ false を返す');
    } catch (e) { threw = e; }
    ok(threw === null, '**setItem が投げても save は投げない**（対局は続く）', String(threw));

    reset();
    mem.failRead = true;
    threw = null;
    try { ok(Resume.load() === null, '読めなければ null'); } catch (e) { threw = e; }
    ok(threw === null, '**getItem が投げても load は投げない**', String(threw));

    reset();
    mem.failWrite = true;
    threw = null;
    try { Resume.clear(); } catch (e) { threw = e; }
    ok(threw === null, 'clear も投げない');
    mem.failWrite = false;

    /* 座っている人が言えない卓は控えない（書いても §5 が捨てるだけ） */
    reset();
    ok(Resume.save(mkGame(), [SEATS[0], SEATS[1], SEATS[2], {}], OPTS) === false,
      'id の無い席が混ざれば控えない');
    ok(mem.data === null, '　何も書かない');
    ok(Resume.save(mkGame(), [SEATS[0], SEATS[1]], OPTS) === false,
      '4人でなければ控えない');

    /* **毎局上書きされること**（§3）。局が進むたびに新しい頭が入る */
    reset();
    Resume.save(mkGame({ kyoku: 2, honba: 0 }), SEATS, OPTS);
    eq(stored().kyoku, 2, '2局目を控えた');
    Resume.save(mkGame({ kyoku: 3, honba: 0 }), SEATS, OPTS);
    eq(stored().kyoku, 3, '3局目で上書きされる（増えない）');
  }

  /* ---------------- 結果 ---------------- */
  console.log('対局の復帰 — Game の口と Resume の錠（段1・段2）');
  console.log('通過 ' + pass + ' 件' + (fails.length ? ' / 失敗 ' + fails.length + ' 件' : ''));
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('すべて通過');
})();
