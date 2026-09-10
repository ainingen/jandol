#!/usr/bin/env node
/*
  回戦のあいだの中継（`docs/design/taikai/round-spec.md`）の錠

    node tools/test-taikai-round.js

  ここに書くのは **DOMに触らない側だけ**。中継の画面（`mount` 以下）は
  ブラウザで確かめる。見るのは `runTournament` のフック（`onRoundStart`）だけ。

  段1 の検品は一つ——**`onRoundStart` を渡さないときに一行も挙動が変わらない。**
  同じ種で二度回して、`rounds` も `outcomeOf` も `onProgress` の流れも
  完全に一致することを見る。

  そのうえで §3 の `info` と §2 の出す条件を固定する：

    - 呼ばれるのは回戦の数だけ（決勝卓を含む）
    - `table` は**自分が座る卓**。いなければ `null`
    - 控えに結果がある回戦は `table` が `null`（もう打ち終わっている）
    - `Resume` の控えがその卓を指していれば `table` が `null`（東1局からではない）
    - **`hasSavedFor` は控えを消費しない**——中継の判定のあとで復帰が生きていること
    - `prev` は前の回戦。一回戦では `null`
    - 呼ばれるのは卓を打つ前（`playRealMatch` より先）
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
const Taikai = require('../src/taikai.js');

const fs = require('fs');
const pathm = require('path');
const rd = (f) => fs.readFileSync(pathm.join(__dirname, '..', f), 'utf8');
/* 錠は**コメントを外した本文**で見る（仕様の引用に釣られないため） */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const TK = strip(rd('src/taikai.js'));
const SHELL = rd('shell.html');

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  … ' + detail : ''));
}
const J = (v) => JSON.stringify(v);
function eq(a, b, name) { ok(a === b, name, 'got ' + J(a) + ' / want ' + J(b)); }
/* 大きいものを丸ごと出さない（`test-taikai-resume.js` と同じ作法）。
   食い違った最初の一つだけ言う */
function same(a, b, name) {
  const x = J(a), y = J(b);
  if (x === y) { pass++; return; }
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  fails.push(name + '  … ' + i + '文字目から違う: '
    + x.slice(Math.max(0, i - 30), i + 40) + '  ／  ' + y.slice(Math.max(0, i - 30), i + 40));
}

/* ------------------------------------------------------------
   枠を手で組む（`prepare()` は乱数で `field` を作るので通さない）。
   **64人にする**——`while` が 64→16→4 と二度回り、決勝卓と合わせて三回戦
------------------------------------------------------------ */
const SIZE = 64;
const ROUNDS = 3;
function mkPrepared() {
  const me = Object.assign({}, PLAYER, { id: 0, playerStrength: 55 });
  const field = [me].concat(JANDOLS.slice(0, SIZE - 1));
  return { tierId: 'open', tier: TOURNAMENTS.open, field, team: [field[0]] };
}
/* 自分が必ず勝ち上がる stub（決勝卓まで届かせるため） */
function winStub(onCall) {
  return async (t, ctx) => {
    if (onCall) { const r = onCall(t, ctx); if (r) return r; }
    const me = t.find((c) => c.id === 0);
    const rest = t.filter((c) => c.id !== 0);
    return [{ chara: me, place: 1 }].concat(rest.map((c, i) => ({ chara: c, place: i + 2 })));
  };
}
/* **`await` すること。**`try { return fn(); } finally { ... }` だと、
   `fn()` が返す約束を待たずに `Math.random` を戻してしまい、
   **大会の中身は本物の乱数で回る**——二度回して比べる錠が、
   「一致していない」ではなく「毎回ちがう」で落ちる（実際に落ちた） */
async function withFixedRandom(fn) {
  const real = Math.random;
  let n = 0;
  Math.random = () => { n = (n * 1103515245 + 12345) % 2147483648; return n / 2147483648; };
  try { return await fn(); } finally { Math.random = real; }
}
/* 見比べられる形に畳む。`chara` はそのまま出すと大きすぎる */
const digest = (run) => ({
  tierId: run.tierId,
  rounds: run.rounds.map((rd) => ({ name: rd.name, size: rd.size,
    results: rd.results.map((r) => ({ hasPlayer: r.hasPlayer, hasTeam: r.hasTeam,
      seats: r.result.map((x) => [x.chara.id, x.place]) })) })),
  final: run.finalResult.map((x) => [x.chara.id, x.place]),
  beaten: run.beaten.slice().sort((a, b) => a - b),
  met: run.met.slice().sort((a, b) => a - b),
  mine: run.outcomeOf(0),
  place: run.placeOf(0),
});

/* `Resume` を差し替える。**`taikai.js` はグローバルから読む** */
async function withResume(rec, fn) {
  const had = Object.prototype.hasOwnProperty.call(global, 'Resume');
  const old = global.Resume;
  global.Resume = { load: () => rec, clear: () => {} };
  try { return await fn(); } finally { if (had) global.Resume = old; else delete global.Resume; }
}

(async () => {
  console.log('回戦のあいだ（taikai/round-spec.md）');

  /* ============================================================
     1. 渡さないときに一行も挙動が変わらない（段1 の検品）
     ============================================================ */
  {
    const a = [], b = [];
    const runA = await withFixedRandom(() => Taikai.runTournament(mkPrepared(), {
      playRealMatch: winStub(), onProgress: (p) => a.push(J(p)),
    }));
    const runB = await withFixedRandom(() => Taikai.runTournament(mkPrepared(), {
      playRealMatch: winStub(), onProgress: (p) => b.push(J(p)),
      onRoundStart: async () => {},
    }));
    same(digest(runA), digest(runB), '中継を挟んでも結果が完全に一致する');
    eq(a.length, b.length, '控えの書き出しの回数も同じ');
    same(a, b, '控えの中身も一字一句同じ');
  }

  /* ============================================================
     1-2. 渡さない走行は**同期のまま**回りきる

     `playRealMatch` を渡さない経路は一度も `await` しないので、
     `Math.random` を差し替えて**すぐ戻しても**結果が固定される。
     `await bridge(...)` を素で置くと（＝中の頭で返しても）ここが崩れ、
     本物の乱数で回るようになって二度の結果が食い違う。
     `tools/test-taikai-resume.js` の「`onProgress` を渡しても結果が変わらない」が
     実際にそれで落ちた。**その落とし穴をこちら側にも置いておく**
     ============================================================ */
  {
    /* **`await` しない**のが要点。`fn()` の同期の部分だけが種の中に入る */
    const syncSeeded = (fn) => {
      const real = Math.random;
      let n = 0;
      Math.random = () => { n = (n * 1103515245 + 12345) % 2147483648; return n / 2147483648; };
      try { return fn(); } finally { Math.random = real; }
    };
    const a = await syncSeeded(() => Taikai.runTournament(mkPrepared(), {}));
    const b = await syncSeeded(() => Taikai.runTournament(mkPrepared(), {}));
    same(digest(a), digest(b), '中継を渡さない走行は同期のまま（種を戻しても結果が固定される）');
  }

  /* ============================================================
     2. §3 の info — 呼ばれる回数・中身・呼ばれる順
     ============================================================ */
  {
    const seen = [];
    const order = [];
    await withFixedRandom(() => Taikai.runTournament(mkPrepared(), {
      playRealMatch: winStub((t, ctx) => { order.push('play:' + ctx.round); return null; }),
      onRoundStart: async (info) => {
        order.push('bridge:' + info.ri);
        seen.push({
          ri: info.ri, name: info.name, size: info.size, isFinal: info.isFinal,
          table: info.table ? info.table.map((c) => c.id) : null,
          prev: info.prev ? info.prev.name : null,
          alive: info.alive.length,
        });
      },
    }));
    eq(seen.length, ROUNDS, '回戦の数だけ呼ばれる（決勝卓を含む）');
    same(seen.map((x) => x.ri), [0, 1, 2], 'ri は 0 から順に');
    same(seen.map((x) => x.name), ['一回戦', '準決勝', '決勝卓'], 'name は回戦名');
    same(seen.map((x) => x.size), [64, 16, 4], 'size はその回戦の残り人数');
    same(seen.map((x) => x.isFinal), [false, false, true], 'isFinal は決勝卓だけ真');
    same(seen.map((x) => x.alive), [64, 16, 4], 'alive も残り人数');
    same(seen.map((x) => x.prev), [null, '一回戦', '準決勝'], 'prev は前の回戦。一回戦では null');
    ok(seen.every((x) => Array.isArray(x.table) && x.table.length === 4),
      '勝ち上がっているあいだ table は四人', J(seen.map((x) => x.table && x.table.length)));
    ok(seen.every((x) => x.table.indexOf(0) >= 0), 'table には必ず自分がいる');
    /* **卓を打つ前に呼ばれること。**これより後だと打ち始めてしまう */
    same(order, ['bridge:0', 'play:0', 'bridge:1', 'play:1', 'bridge:2', 'play:2'],
      '中継 → 対局 の順で、回戦ごとに交互に来る');
  }

  /* ============================================================
     3. 自分が落ちた回戦は table が null（§2）
     ============================================================ */
  {
    const seen = [];
    await withFixedRandom(() => Taikai.runTournament(mkPrepared(), {
      /* 一回戦で自分を4位にする */
      playRealMatch: winStub((t) => {
        const me = t.find((c) => c.id === 0);
        const rest = t.filter((c) => c.id !== 0);
        return rest.map((c, i) => ({ chara: c, place: i + 1 })).concat([{ chara: me, place: 4 }]);
      }),
      onRoundStart: async (info) => {
        seen.push(info.table ? info.table.map((c) => c.id) : null);
      },
    }));
    eq(seen.length, ROUNDS, '敗退しても回戦の数だけ呼ばれる');
    ok(Array.isArray(seen[0]) && seen[0].indexOf(0) >= 0, '一回戦は自分の卓がある');
    eq(seen[1], null, '敗退したあとの準決勝は table が null');
    eq(seen[2], null, '自分が出ていない決勝卓も table が null');
  }

  /* ============================================================
     4. 控えから結果を戻す回戦は table が null（§2）
     ============================================================ */
  {
    /* まず一回戦だけ打って控えを作る */
    let progress = null;
    const BOOM = new Error('ここで落ちたことにする');
    await withFixedRandom(async () => {
      try {
        await Taikai.runTournament(mkPrepared(), {
          playRealMatch: winStub((t, ctx) => { if (ctx.round === 1) throw BOOM; return null; }),
          onProgress: (p) => { progress = JSON.parse(J(p)); },
        });
      } catch (e) { if (e !== BOOM) throw e; }
    });
    ok(progress && progress.rounds[0]
      && progress.rounds[0].results.every((r) => r), '控えに一回戦の結果が入っている');

    const seen = [];
    await withFixedRandom(() => Taikai.runTournament(mkPrepared(), {
      playRealMatch: winStub(), progress,
      onRoundStart: async (info) => {
        seen.push(info.table ? info.table.map((c) => c.id) : null);
      },
    }));
    eq(seen.length, ROUNDS, '控えから戻しても回戦の数だけ呼ばれる');
    eq(seen[0], null, '控えに結果がある一回戦は table が null');
    ok(Array.isArray(seen[1]) && seen[1].indexOf(0) >= 0, '打ち直す準決勝は table がある');
  }

  /* ============================================================
     5. Resume の控えがその卓を指していれば table は null（§2.2）
        **そのうえで控えが消えていないこと**——判定で消すと復帰が死ぬ
     ============================================================ */
  {
    /* 一回戦の自分の卓を先に知る（同じ種なら同じ卓割りになる） */
    let firstSeats = null;
    await withFixedRandom(() => Taikai.runTournament(mkPrepared(), {
      playRealMatch: winStub(),
      onRoundStart: async (info) => {
        if (info.ri === 0 && info.table) firstSeats = info.table.map((c) => c.id);
      },
    }));
    ok(Array.isArray(firstSeats), '一回戦の自分の卓が取れた');

    /* その卓の局の途中で落ちた控え（`done` なし＝まだ打ち終わっていない） */
    const rec = { seats: firstSeats, kyoku: 3, honba: 1 };
    const seen = [];
    let handed = null;
    /* 控えを使うには `progress` が要る（`taikai.js` は progress があるときだけ読む）。
       一回戦の結果はまだ空にしておく */
    const prog0 = { v: 1, tierId: 'open', offerId: null,
      fieldIds: mkPrepared().field.map((c) => c.id), rounds: [], ri: 0 };
    await withResume(rec, () => withFixedRandom(() => Taikai.runTournament(mkPrepared(), {
      progress: prog0,
      playRealMatch: winStub((t, ctx) => { if (ctx.round === 0) handed = ctx.resume; return null; }),
      onRoundStart: async (info) => {
        seen.push(info.table ? info.table.map((c) => c.id) : null);
      },
    })));
    eq(seen[0], null, '局の途中から戻る回戦は table が null（東1局からではない）');
    /* **ここが本命。**判定が控えを食っていたら `resume` が渡らない */
    ok(handed === rec, '判定のあとも控えが生きていて、復帰に渡る（§2.2）',
      handed ? 'ちがう控えが渡った' : '控えが渡らなかった');
    ok(Array.isArray(seen[1]) && seen[1].indexOf(0) >= 0,
      '次の回戦は東1局からなので table がある');
  }

  /* ============================================================
     6. 投げても握りつぶさない（中継で落ちたら大会も止まる）
     ============================================================ */
  {
    const BOOM = new Error('中継で落ちた');
    let threw = null;
    await withFixedRandom(async () => {
      try {
        await Taikai.runTournament(mkPrepared(), {
          playRealMatch: winStub(),
          onRoundStart: async () => { throw BOOM; },
        });
      } catch (e) { threw = e; }
    });
    ok(threw === BOOM, '中継が投げたらそのまま外へ出る（黙って進まない）');
  }

  /* ============================================================
     7. 枠を出さない印（§7）— `body.tkHold`

     中継のあいだは `#appReset`（セーブを消す釦）と `#nav`（下のタブ）を出さない。
     **どちらも `shell.html` の持ち物**なので、taikai.js は印を立てるだけ。
     nav を残すと**答えずに抜けられ、解決されない `runTournament` が控えを
     抱えたまま残る**——遊ぶ側は「続きから」で入り直した別の走行を見ることになる
     ============================================================ */
  {
    ok(/renderBridge\([\s\S]{0,120}?holdChrome\(true\)/.test(TK),
      '中継を組むときに印を立てる');
    ok(/showLoading\(\)\s*\{[\s\S]{0,120}?holdChrome\(false\)/.test(TK),
      '卓に入るときに印を落とす');
    /* **shell.html の側で隠す。**枠は向こうの持ち物 */
    const rule = (SHELL.match(/body\.tkHold[^{]*\{[^}]*\}/g) || []).join(' ');
    ok(/\.appReset/.test(rule), 'shell.html が tkHold で .appReset を隠す', rule);
    ok(/#nav/.test(rule), 'shell.html が tkHold で #nav を隠す（§7・F）', rule);
    ok(/#scroll[^{]*\{[^}]*padding-bottom:0/.test(rule),
      'nav を消したぶんの下の余白も消す（残すと底に 64px の空白）', rule);
    /* **最後の砦。**印を立てた画面から抜ける道が go() しかないので、
       ここで落とさないと次の画面まで枠が消えたままになる */
    ok(/function go\(name, opts\)[\s\S]{0,600}?classList\.remove\('tkHold'\)/.test(SHELL),
      'shell.html の go() が印を落とす（最後の砦）');
    /* **新しい出口を作らないこと。**中継から出られるのは「打つ」だけで、
       中断はリロード →「続きから」→「この大会を諦める」の道が受け持つ */
    const bridge = (TK.match(/function renderBridge\([\s\S]*?\n    \}/) || [''])[0];
    const acts = (bridge.match(/data-act="[a-z-]+"/g) || []);
    same(acts, ['data-act="round-go"'], '中継の押せる口は round-go 一つだけ');
  }

  /* ============================================================
     8. 決勝卓は CSS だけで組み替える（§5・E）

     **`cardHTML` に分岐を増やさない。**出走表と中継と決勝で三通りのカードを
     組むことになり、直すたびに三か所を見ることになる
     ============================================================ */
  {
    const card = (TK.match(/const cardHTML = \(c, o\) => \{[\s\S]*?\n    \};/) || [''])[0];
    ok(card.length > 100, 'cardHTML が読めた', String(card.length));
    ok(!/isFinal|final/.test(card), 'cardHTML に決勝卓の分岐が無い（CSS だけで組み替える）');
    /* 渡せるのは `mine` と `why` の二つだけ */
    const keys = Array.from(new Set((card.match(/\bo\.[a-zA-Z]+/g) || [])));
    same(keys.sort(), ['o.mine', 'o.why'], 'cardHTML が見る opts は mine と why だけ');

    /* 決勝の見せ方は `.tkBridge.final` の側に全部あること */
    const CSS = rd('src/taikai.css');
    ['\\.tkBridge\\.final \\.tkFace', '\\.tkBridge\\.final \\.tkCard'].forEach((re) => {
      ok(new RegExp(re).test(CSS), 'CSS に ' + re.replace(/\\\\/g, '') + ' がある');
    });
    /* **A の `tkBare` を決勝で打ち消していること**（顔に重なるので縦中央にしない） */
    ok(/\.tkBridge\.final \.tkCard\.tkBare \.tkCardSub\{[^}]*margin-bottom:0/.test(CSS),
      '決勝では tkBare の縦中央を効かせない');
    /* **顔を広げる側は `tkBare` に触らせない**（G）。実機で「自分のカードだけ
       通常の組み方に見える」と報告が出た。原因は再現していないが、
       **顔を全面にする二本（`.tkCard` の `aspect-ratio` と `.tkFace` の
       `position:absolute`）が `tkBare` を挟まない形であること**は錠にしておく
       ——ここに `tkBare` が入ると、自分のカードだけ本当に外れる */
    const faceRules = (CSS.match(/\.tkBridge\.final [^{]*\.tkFace[^{]*\{[^}]*\}/g) || [])
      .concat(CSS.match(/\.tkBridge\.final \.tkCard\{[^}]*\}/g) || []);
    ok(faceRules.length >= 2, '顔を全面にする規則が読めた', String(faceRules.length));
    ok(!faceRules.some((r) => /tkBare|\.mine/.test(r)),
      '顔を全面にする規則は tkBare と mine を見ない（自分のカードも同じ組み方）');
  }

  /* ============================================================
     9. 対局終了の釦の文言（§6）

     既定は `'結果へ'` のまま。大会から来たときだけ `shell.html` が渡す。
     **練習対局・雀荘・遠征は触らない**
     ============================================================ */
  {
    const M = rd('src/match.js');
    ok(/label: opts\.doneLabel \|\| '結果へ'/.test(M),
      'showResult は文言を外から受け、既定は 結果へ');
    ok(!/\bisFinal\b/.test(M), 'match.js は大会かどうかを自分で数えない（isFinal を見ない）');

    const SH = rd('shell.html');
    ok(/doneLabel:/.test(SH), 'shell.html が doneLabel を渡す');
    ok(/ctx\.round == null \? undefined/.test(SH),
      '大会から来たときだけ渡す（round が無い経路＝雀荘・遠征・練習は既定のまま）');
    ok(/ctx\.isFinal \? '結果へ'\s*:\s*'次の回戦へ'/.test(SH),
      '決勝卓は 結果へ、通常の回戦は 次の回戦へ');
    /* **雀荘・遠征の呼び出しに `round` を足さないこと。**足すと
       「次の回戦へ」が雀荘の卓にも出る */
    ok(!/round:/.test(rd('src/jansou.js').split('playRealMatch(table,')[1] || '').valueOf()
      && !/round:/.test((rd('src/office.js').match(/playRealMatch\(table, Object\.assign\([^;]*/) || [''])[0]),
      '雀荘と遠征は ctx に round を入れない');
  }

  /* ------------------------------------------------------------ */
  if (fails.length) {
    console.log(pass + ' 件通過、' + fails.length + ' 件失敗');
    fails.forEach((f) => console.log('  × ' + f));
    process.exit(1);
  }
  console.log(pass + ' 件通過');
  console.log('すべて通過');
})();
