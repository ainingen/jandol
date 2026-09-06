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

  /* ============================================================
     音の確認（debug.html の「音」の区画）

     **必ず sound.js を経由して鳴らす。**`<audio>` で直に鳴らすと
     `playbackRate` の揺らぎも音量設定も通らないので、
     ゲームで実際に聞こえる音とは別のものを聴くことになる。

     見たいのは三つ：
       ・discard1〜4 を並べて聴き比べる（音量が揃っているか）
       ・打牌を連打して、同じ音が二回続かないこと
       ・audio/ の全ファイルが読めていること
     ============================================================ */

  /* ui.js と同じ揺らぎ。同じ音が17回続くと機械音に聞こえるので ±3% 振る */
  const jitter = () => 1 + (Math.random() * 2 - 1) * 0.03;

  /* audio/ にある全ファイル。**Sound の FILES から組む**ので、
     鳴らし分けを足したらこの一覧にも自動で出る。
     控え（discard.wav）は FILES に無いが audio/ にはあるので、明示して足す */
  function audioFiles() {
    const out = [];
    (typeof Sound === 'undefined' ? [] : Sound.NAMES).forEach((name) => {
      const files = (Sound.FILES && Sound.FILES[name]) || [name];
      files.forEach((f) => out.push({ file: f, name: name, many: files.length > 1 }));
      /* 複数持つ名前は、同名の一本が「一本も読めなかったとき」の控えとして残っている */
      if (files.length > 1 && files.indexOf(name) < 0) {
        out.push({ file: name, name: name, spare: true });
      }
    });
    return out;
  }

  function soundPanel(host) {
    if (typeof Sound === 'undefined') {
      host.textContent = 'sound.js が読まれていない（debug.html の script を確かめること）';
      return;
    }
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    let shake = true;               // ゲームと同じ揺らぎを掛けるか
    const heard = [];               // 鳴らした順（同じ音が続かないのを目でも見る）

    /* ---- 打牌の連打 ---- */
    const mash = el('button', 'dbgBig');
    mash.type = 'button';
    mash.innerHTML = '<b>打牌（連打できる）</b>'
      + '<i>Sound.play(\'discard\') を一回。四本から選ばれる。'
      + '<b>直前と同じものは続けて出ない</b>——下の並びで確かめられる</i>';

    const log = el('div', 'sfxLog', '（まだ鳴らしていない）');
    const say = (file) => {
      if (file) heard.unshift(file);
      if (heard.length > 12) heard.length = 12;
      log.textContent = heard.length ? '鳴った順（新しい順）： ' + heard.join(' ← ') : '（鳴らなかった）';
    };

    /* ---- 上の操作 ---- */
    const row = el('div', 'row');
    const runs = el('button', null, '8回続けて鳴らす');
    runs.type = 'button';
    const vols = [['ふつう', 1], ['小さく', 0.5], ['消す', 0]].map(([label, v]) => {
      const b = el('button', null, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        Sound.init();
        Sound.volume(v);
        vols.forEach((x) => x.classList.toggle('on', x === b));
        say(null);
      });
      return b;
    });
    const shakeBtn = el('button', 'on', '揺らぎ ±3%：入');
    shakeBtn.type = 'button';
    shakeBtn.addEventListener('click', () => {
      shake = !shake;
      shakeBtn.textContent = '揺らぎ ±3%：' + (shake ? '入' : '切');
      shakeBtn.classList.toggle('on', shake);
    });
    row.append(runs, el('span', 'sfxSep', '音量'), ...vols, shakeBtn);

    const status = el('div', 'sfxStat', '（押すと読み込む）');
    const list = el('div', 'sfxList');
    host.append(mash, row, log, status, list);

    /* ---- 鳴らす ---- */
    const opts = () => (shake ? { rate: jitter() } : undefined);
    /* 読み込みは押されるまで始めない（AudioContext はユーザー操作の中で作る）。
       **読み終わったら一度だけ一覧を描き直す**——さもないと、マウント時に組んだ
       「読めていない」の札が、鳴っているのに残る（一本ずつの ▶ は refresh を呼ばないため） */
    let shown = false;
    const ready = () => {
      Sound.init();
      return Sound.load().then((r) => {
        if (!shown) { shown = true; refresh(); }
        return r;
      });
    };

    mash.addEventListener('click', () => { ready().then(() => { say(Sound.play('discard', opts())); refresh(); }); });
    runs.addEventListener('click', () => {
      ready().then(() => {
        let n = 0;
        const tick = () => {
          say(Sound.play('discard', opts()));
          if (++n < 8) setTimeout(tick, 380);
        };
        tick();
        refresh();
      });
    });
    vols[0].classList.add('on');

    /* ---- 一覧 ---- */
    function refresh() {
      list.innerHTML = '';
      const files = audioFiles();
      let miss = 0;
      files.forEach((f) => {
        const got = f.spare ? null : Sound.sources(f.name).indexOf(f.file) >= 0;
        if (got === false) miss++;
        const r = el('div', 'sfxRow');
        const b = el('button', null, '▶');
        b.type = 'button';
        b.addEventListener('click', () => {
          ready().then(() => {
            /* 控えは束に入っていないので preview で鳴らす。経路は同じ */
            if (f.spare) Sound.preview(f.file, opts()).then((x) => say(x));
            else say(Sound.play(f.name, Object.assign({ file: f.file }, opts())));
          });
        });
        r.append(b, el('span', 'sfxName', f.file + '.wav'));
        if (f.many) r.append(el('span', 'sfxTag many', f.name + ' の鳴らし分け'));
        else if (f.spare) r.append(el('span', 'sfxTag spare', f.name + ' の控え（普段は鳴らない）'));
        else r.append(el('span', 'sfxTag', f.name));
        if (got === false) r.append(el('span', 'sfxTag bad', '読めていない'));
        list.appendChild(r);
      });
      const n = Sound.loaded('discard');
      status.textContent = '打牌 ' + n + '本'
        + (n ? '（' + Sound.sources('discard').join(' / ') + '）' : '')
        + ' ／ 一覧 ' + files.length + '本'
        + (miss ? ' ／ **読めていないものが ' + miss + '本ある**' : '');
    }
    refresh();
  }

  return { SAVE_KEY, PRESETS, build, apply, clear, panel, soundPanel, audioFiles };
})();

if (typeof module !== 'undefined') {
  module.exports = { JandolDebug };
}
