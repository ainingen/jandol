/* ============================================================
   debug.js — 開発用のセーブを作る（自分で遊んで確かめるため）

   **本番のビルドには入らない。**
   `build.py` の JS リストにこのファイルを載せていないので、
   `index.html` からは一行も読まれない。読むのは開発用の入口だけ：

     debug.html    … ここから状態を作って本編（index.html）へ入る
     jansou.html   … 雀荘の単体ページ（もとから開発用）

   **リストに足さないこと。** 足すと普通のプレイヤーに見えてしまう。
   配布ZIPを作るときも `debug.html` と `src/debug.js` は外すこと
   （`README.md` の配布の手順）。

   なぜ要るか：
     作ったフロア・設備・隣接コンボは、金と評判と所属人数が揃わないと
     画面に出てこない。最初から遊んで揃えるのは現実的でないので、
     揃った状態をここで作る。
   ============================================================ */
const JandolDebug = (() => {
  'use strict';

  const SAVE_KEY = 'jandol_save_v1';
  const ALL = () => JANDOLS.concat(FREE_AGENTS);

  /* ---------- 用意する状態 ----------
     そこそこ … 設備を自分で買い足す余地を残す（買う手触りを見たいとき）
     全部盛り … 内装5・卓6。ソファとカウンターが並び、くつろぎ席・カウンター席・
                入口席の3つが最初から成立している。**ラウンジと花道は成立しない**
                （autoPlace はソファとカウンターを隣に置かない）。
                模様替えで自分で組むと出る。
                評判が高いので上客・特別な客・ボトル勝負がよく出る */
  const PRESETS = {
    asobu: {
      label: '遊べる状態を作る',
      note: '1000万円・8人契約・評判45・卓4／内装3　設備は自分で買い足せる',
      money: 10000000, hires: 8, discovered: 30,
      day: 60, rep: 45, tables: 4, interior: 3, auto: 2, sign: 2, speed: 2,
      shifts: [false, true, true],
      bottles: [2, 1, 1, 0, 0, 0],
      regulars: [['inkyo', 3], ['kaisha', 10], ['madam', 12], ['shachou', 30]],
    },
    zenbu: {
      label: '全部盛りにする',
      note: '1000万円・14人契約・評判80・卓6／内装5　コンボ3つ成立・特別な客が出やすい',
      money: 10000000, hires: 14, discovered: 999,
      day: 120, rep: 80, tables: 6, interior: 5, auto: 3, sign: 3, speed: 2,
      shifts: [true, true, true],
      bottles: [4, 3, 2, 2, 1, 0],
      regulars: [['inkyo', 3], ['kaisha', 10], ['madam', 12], ['oshifan', 14],
                 ['shachou', 30], ['nushi', 35], ['uchishi', 11]],
    },
  };

  /* 常連を仕込む。**形は makeGuest に作らせる。**
     手で書くと sei / mei / nijina の組み合わせが崩れて、
     段階3の「二つ名＋姓名」が出なくなる */
  function makeRegulars(spec, contracted) {
    const out = {};
    if (typeof JansouGuests === 'undefined') return out;
    spec.forEach(([typeKey, visits], i) => {
      const g = JansouGuests.makeGuest(typeKey, Math.random);
      g.visits = visits;
      /* 推しファンには推しを持たせる（居ないと乗り換えの経路に入る） */
      if (typeKey === 'oshifan' && contracted.length) {
        g.favTalent = contracted[i % contracted.length];
      }
      out[JansouGuests.faceId(typeKey, i)] = g;
    });
    return out;
  }

  /* 開発用の状態をひとつ組み立てる。localStorage には書かない（build と apply を分ける） */
  function build(name) {
    const p = PRESETS[name];
    if (!p) throw new Error('知らないプリセット: ' + name);

    /* 人気の高い順に契約する。出勤者の人気が客を呼ぶので、
       ここが低いとフロアがすかすかになって設備の効きが見えない */
    const roster = ALL().slice().sort((a, b) => (b.pop || 0) - (a.pop || 0));
    const contracted = roster.slice(0, p.hires).map((c) => c.id);

    const discovered = roster.slice(0, p.discovered).map((c) => c.id)
      .concat(FREE_AGENTS.map((c) => c.id));

    const comp = {};
    const grades = {};
    /* **`characters.js` の `comp` は全員 undefined。**実行時に
       `compFromRank` で入るので、ここでそのまま写すと `undefined` が入り、
       下の「少し育てておく」が `(undefined||0)+18` で 18 に潰れる
       （契約した子の完成度が全員18になっていた） */
    ALL().forEach((c) => {
      comp[c.id] = c.comp == null ? compFromRank(c.rank) : c.comp;
      grades[c.id] = c.rank;
    });
    /* 契約した子は少し育てておく。伸びしろの天井（compMax）は触らない */
    contracted.forEach((id) => {
      const c = ALL().find((x) => x.id === id);
      if (c) comp[id] = Math.min(100, comp[id] + 18);
    });

    const shifts = {};
    contracted.forEach((id) => { shifts[id] = p.shifts.slice(); });

    return {
      discovered: Array.from(new Set(discovered)),
      contracted,
      comp, compMax: {}, grades, favor: {},
      team: contracted.slice(0, 4),
      teamDecided: true,               // これが false だと雀荘のタブが押せない
      money: p.money,
      playerName: 'デバッグ', playerFace: 'p01',
      playerRank: 'B', playerWins: 3, records: {}, recent: [],
      agency: 3, beaten: [],
      autoMatch: false, matchSpeed: 520, showHints: true,
      parlor: {
        open: true, day: p.day, rep: p.rep,
        tables: p.tables, interior: p.interior, auto: p.auto, sign: p.sign,
        speed: p.speed, joinNight: false,
        shifts,
        bottles: p.bottles.slice(),
        regulars: makeRegulars(p.regulars, contracted),
        seen: {}, buffs: [], log: [],
        total: { days: p.day, sales: 0, profit: 0, guests: 0 },
        /* floor は書かない。normalize() の reconcile が
           卓数と内装から今までどおりの絵を組む（placement.md §2.2） */
      },
    };
  }

  /* 書いて入る。呼んだ側でページを移すこと */
  function apply(name) {
    const st = build(name);
    localStorage.setItem(SAVE_KEY, JSON.stringify(st));
    return st;
  }

  function clear() { localStorage.removeItem(SAVE_KEY); }

  /* ---------- 押せる形にして置く ----------
     host … 釦を並べる要素
     opts.then … 押したあとに行く先（既定はページの再読み込み） */
  function panel(host, opts) {
    opts = opts || {};
    const go = opts.then || (() => location.reload());
    Object.keys(PRESETS).forEach((name) => {
      const p = PRESETS[name];
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dbgBig';
      b.innerHTML = '<b>' + p.label + '</b><i>' + p.note + '</i>';
      b.addEventListener('click', () => { apply(name); go(name); });
      host.appendChild(b);
    });
  }

  return { SAVE_KEY, PRESETS, build, apply, clear, panel };
})();

if (typeof module !== 'undefined') {
  module.exports = { JandolDebug };
}
