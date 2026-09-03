/* ============================================================
   遠征先の雀荘 — scoutshop.js
   依存：characters.js / geo.js / scout.js（抽選の重み）/
        jansou-guests.js（客のタイプ）/ jansou-floor.js（PAL と自動配置）

   使い方：
     ScoutShop.buildShop(st, trip, rng) -> shop     **純関数**
     ScoutShop.palOf(typeKey)           -> PAL への浅い上書き
     ScoutShop.pickType(scale, rng)     -> 店の型
     ScoutShop.quirkOf(styleKey)        -> 癖のキー（打ち筋20種 → 癖6種）
     ScoutShop.quirksFor(styleKey, rng) -> 席一つぶんの癖の配列

   設計は docs/design/scout/spec.md。ここまでの範囲：
   **店の型・色・誰がいるか・声をかける回数**（A4.5-1）と
   **癖**（A4.5-2。§4.4）。交渉（§5）はまだ入っていない。

   ------------------------------------------------------------
   遠征先の店は帳簿を持たない（§1）
   ------------------------------------------------------------
   `JansouFloor.build`（タイムライン生成）を通さない。**一日を再生しない。**
   出すのは静止した一枚で、動くのは乱数を使わない常時アニメだけ
   （打牌の手・ネオン・ミラーボール。`live.clock` だけから位相が出る）。

   ------------------------------------------------------------
   `shop.parlor` は擬似（§6.3）
   ------------------------------------------------------------
   **`Jansou.normalize()` を通さないこと。**通すと `tables` が最低2に
   丸められるなど、自分の店の決めごとが混ざる。
   `JansouFloor` が読むキーだけを持たせる。

   **`shop` を `parlor` の下に置かないこと。**`Jansou.normalize()` は
   知らないキーを捨てる（引き継ぎ書 §5）。置き場所は `trip.shop`。
   ============================================================ */

const ScoutShop = (() => {
  'use strict';

  /* ------------------------------------------------------------
     店の型（spec.md §3.2）
     型は行き先の県の `scale` から重み付きで引く。
     大きい県ほど高級店が出やすく、小さい県は古い店。
     `w` は scale 1〜5 のときの重み。**初期値。手応えを見てから動かす**
  ------------------------------------------------------------ */
  const SHOP_TYPES = [
    { key: 'old',   name: '古い雀荘',           w: [5, 4, 3, 2, 1], tables: [2, 3], interior: 1, auto: 1, sign: 1 },
    { key: 'back',  name: '場末の店',           w: [4, 4, 3, 2, 1], tables: [2, 4], interior: 1, auto: 1, sign: 1 },
    { key: 'girls', name: '街のガールズ雀荘',   w: [1, 2, 3, 4, 4], tables: [3, 5], interior: 3, auto: 2, sign: 2 },
    /* **高級店の `sign` は 1。**2以上にすると `drawWall` が
       「GIRLS」のネオンを出す（自分の店の看板）。高級店が
       ガールズ雀荘の看板を掲げていては格が壊れる。
       県の紹介文の「看板を出していない卓もある」とも噛み合う */
    { key: 'lux',   name: '高級店',             w: [0, 1, 2, 3, 5], tables: [4, 6], interior: 5, auto: 3, sign: 1 },
  ];
  const TYPE_BY_KEY = {};
  SHOP_TYPES.forEach((t) => { TYPE_BY_KEY[t.key] = t; });

  /* ------------------------------------------------------------
     壁・床・卓の三色（spec.md §3.3）
     **新しい色を発明しない。**どれも PAL / theme.css / style.css に
     既にある色か、その明度違い。ネオン・金・客・スタッフの色は
     共通のまま（浅いマージ）。

     **指示は「壁・床・卓の三色」だったが、四つめに「夜の灯り」を足した。**
     `drawLight` が夜の帯にピンクの覆いを掛けるので、
     壁と卓だけ差し替えても**どの型の店も一目では同じに見えた**（実際そう見えた）。
     灯りは部屋のものなので、型と一緒に決まるほうが素直。
     `PAL` 側の既定は `drawLight` に直書きしてあった値そのままなので、
     **自分の店の絵は1ドットも変わらない**。

     `girls` に上書きが無いのは意図的。自分の店と同じ絵が出ることで
     「よそもうちと同じ商売をしている」が伝わる。
  ------------------------------------------------------------ */
  const PALETTES = {
    old: {
      wall: '#3a3026', wallLow: '#2a2118',
      /* 板張り（内装1なので drawCarpet は plank 系を使う） */
      plankA: '#a89478', plankSeam: '#8c7a60', plankGrain: '#9c8a70', edge: '#7a6a52',
      tableWood: '#8a6a48', tableEdge: '#8a6a48',
      /* 緑のラシャ。style.css の --bamboo:#2e7d5b から */
      feltTop: '#3f8a62', felt: '#2f6a4a', feltLow: '#1f4a34',
      /* 夜の灯り。裸電球の色（壁と同系＋暖色の傘） */
      /* 「GIRLS」の看板は壁に溶かして消す */
      signOff: '#3a3026', signOffLow: '#2a2118',
      night: '#3a3026', lamp: '#ffb478',
    },
    back: {
      wall: '#24262e', wallLow: '#191b21',
      plankA: '#8e8a80', plankSeam: '#767268', plankGrain: '#827e74', edge: '#68645c',
      tableWood: '#6a5a48', tableEdge: '#6a5a48',
      /* 色褪せた青。style.css の --indigo:#2a5b93 を沈めたもの */
      feltTop: '#5c6a78', felt: '#4a5560', feltLow: '#38414a',
      /* 蛍光灯。冷たく白い */
      /* 「GIRLS」の看板は壁に溶かして消す */
      signOff: '#24262e', signOffLow: '#191b21',
      night: '#24262e', lamp: '#a8c0d0',
    },
    girls: {},                       // **PAL のまま**（自分の店と同じ系統）
    lux: {
      /* theme.css の --urushi:#13201c / --urushi-3:#0e1a17 */
      wall: '#14211c', wallLow: '#0e1a17',
      /* 寄木 */
      carpetA: '#b8a07a', carpetB: '#b09876', carpetPat: '#a08a66', edge: '#8c7658',
      plankA: '#b8a07a', plankSeam: '#9a8460', plankGrain: '#ac9670',
      tableEdge: '#2a1e14', tableWood: '#2a1e14',
      /* 深緑。style.css の --back:#1f5646（牌の背） */
      feltTop: '#2f6a56', felt: '#1f5646', feltLow: '#143a30',
      /* 傘ランプの金。theme.css の --gold:#d9b45e */
      /* 「GIRLS」の看板は壁に溶かして消す */
      signOff: '#14211c', signOffLow: '#0e1a17',
      night: '#14211c', lamp: '#d9b45e',
    },
  };

  /* PAL への**浅い**上書き。ネオンや金まで差し替えると型の色が壊れる */
  function palOf(typeKey) {
    const base = (typeof JansouFloor !== 'undefined' && JansouFloor.PAL) || {};
    return Object.assign({}, base, PALETTES[typeKey] || {});
  }

  function pickType(scale, rng) {
    rng = rng || Math.random;
    const i = Math.min(4, Math.max(0, (scale | 0) - 1));
    const total = SHOP_TYPES.reduce((a, t) => a + t.w[i], 0);
    let r = rng() * total;
    for (const t of SHOP_TYPES) { r -= t.w[i]; if (r <= 0) return t.key; }
    return SHOP_TYPES[0].key;
  }

  /* ------------------------------------------------------------
     その日いる雀ドルの数（spec.md §3.5）
     **雀ドルが一人もいない日を許す。**毎日誰かいると、一日3回の上限が
     常に足りて緊張が消える。規模の小さい県ほど空振りが多い。
     `scale 1` の県では三日に二日は空振りになる。それでよい。
  ------------------------------------------------------------ */
  const ANY_CHANCE = [0.35, 0.45, 0.55, 0.62, 0.70];    // その日一人でもいる確率
  const TWO_CHANCE = [0.10, 0.15, 0.22, 0.30, 0.38];    // 一人いたとき、二人目もいる確率

  function jandolCount(scale, rng) {
    const i = Math.min(4, Math.max(0, (scale | 0) - 1));
    if (rng() >= ANY_CHANCE[i]) return 0;
    return rng() < TWO_CHANCE[i] ? 2 : 1;
  }

  /* 声をかけられる回数（初期値）。滞在が長いほど機会が増える
     ——**日ごとに戻る**ので、日数がそのまま回数になる */
  const CALLS_PER_DAY = 3;

  /* ------------------------------------------------------------
     癖（spec.md §4.4）— A4.5-2

     **打ち筋20種を癖6種へ写す。写像は全単射にしない。**
     一対一だと観察が対応表を引く作業になる。6種に束ねると
     「攻め型の誰かが3人いる」までしか分からず、そこから先は選ぶことになる
     （§4.4「これは妥協ではなく設計」）。

     癖には**二つの系統**がある。

       beat … 打牌の2フレームの振りかた（`fast` / `slow` / `still`）
       mark … 12×16 の中に置く1〜3ドットの印（`bou` / `meld` / `guard`）

     **雀ドルは beat と mark が一つずつ揃う（二拍）。
     ただの客はどちらか一つだけ（一拍）。**

     系統を分けたのは、**二つ付いたときに互いを打ち消さないため。**
     beat を二つ持たせると（たとえば `fast` と `slow`）片方しか描けず、
     ただの客と見分けが付かない——「二拍そろう」が目で判る形に
     なっているのは、この分けかたのおかげ。
  ------------------------------------------------------------ */
  const QUIRKS = [
    { key: 'fast',  kind: 'beat', name: '手が速い',       tell: '手が速かったのは' },
    { key: 'slow',  kind: 'beat', name: '長考する',       tell: '長考していたのは' },
    { key: 'still', kind: 'beat', name: '動かない',       tell: '動きが少なかったのは' },
    { key: 'bou',   kind: 'mark', name: '立直棒が早い',   tell: '立直棒を早くから置いていたのは' },
    { key: 'meld',  kind: 'mark', name: '鳴きが多い',     tell: '鳴きが多かったのは' },
    { key: 'guard', kind: 'mark', name: '河が横に伸びる', tell: '河が横に伸びていたのは' },
  ];
  const QUIRK_BY_KEY = {};
  QUIRKS.forEach((q) => { QUIRK_BY_KEY[q.key] = q; });
  const BEATS = QUIRKS.filter((q) => q.kind === 'beat').map((q) => q.key);
  const MARKS = QUIRKS.filter((q) => q.kind === 'mark').map((q) => q.key);

  /* 打ち筋20種 → 癖6種（spec.md §4.4 の表そのまま）。
     **`characters.js` の STYLES の20キーを漏れなく埋めること。**
     `tools/test-scout.js` が20種すべて写ることを見ている */
  const STYLE_QUIRK = {
    speed: 'fast',   lasukai: 'fast',  balance: 'fast',
    judge: 'slow',   read: 'slow',     perfect: 'slow',
    menzen: 'bou',   oya: 'bou',       shoubu: 'bou',   top: 'bou',
    naki: 'meld',    toitoi: 'meld',   some: 'meld',
    wall: 'guard',   betaori: 'guard',
    chiitoi: 'still', mura: 'still',   mental: 'still', oorasu: 'still', gyakkyo: 'still',
  };
  function quirkOf(styleKey) { return STYLE_QUIRK[styleKey] || null; }

  /* ただの客に癖が付く割合。**初期値。§8 で実機を見てから決める** */
  const PLAIN_QUIRK = 0.25;

  /* 席一つぶんの癖を配る（純関数。`rng` は buildShop から）。
     `styleKey` が無ければただの客。

     **打ち筋から来るほうを必ず先頭に置く**——声をかけたあとに
     「あの癖はこの打ち筋だった」と結んで札に出すため（§4.4 の末尾） */
  function quirksFor(styleKey, rng) {
    if (!styleKey) {
      if (rng() >= PLAIN_QUIRK) return [];
      const pool = rng() < 0.5 ? BEATS : MARKS;
      return [pool[Math.floor(rng() * pool.length)]];
    }
    const own = quirkOf(styleKey);
    if (!own) return [];
    /* 二つめは**必ずもう一方の系統から**。同じ系統だと片方が描けない */
    const other = QUIRK_BY_KEY[own].kind === 'beat' ? MARKS : BEATS;
    return [own, other[Math.floor(rng() * other.length)]];
  }

  /* ------------------------------------------------------------
     店の名前。`jansou-guests.js` の姓の表を借りて「雀荘 ○○」にする。
     **新しい名前の表を作らない**（字が増えるとフォントを回し直すことになる）
  ------------------------------------------------------------ */
  const SHOP_SUFFIX = { old: '', back: '', girls: '', lux: '' };
  function nameOf(typeKey, rng) {
    const G = typeof JansouGuests !== 'undefined' ? JansouGuests : null;
    const pool = (G && G.SEI) || ['佐藤', '鈴木', '高橋'];
    const base = pool[Math.floor(rng() * pool.length)];
    const t = TYPE_BY_KEY[typeKey] || SHOP_TYPES[0];
    return '雀荘 ' + base + (SHOP_SUFFIX[t.key] || '');
  }

  /* ------------------------------------------------------------
     種から乱数を作る。**ここを通すこと。**

     `jansou.js` と同じ線形合同法だが、**種をそのまま渡してはいけない。**
     `s1 = 1664525·s0 + 1013904223 (mod 2^32)` なので、隣り合う種の
     一手目は 1664525/2^32 ≒ 0.0004 しか違わない。日ごとに
     `seeded(day)` で引くと、**毎日同じ店の型が出る**（実際に出た）。

     種を大きな奇素数で散らし、二手ぶん捨ててから返す。
     二手目の差は 1664525² になり、そこで初めて散る。
  ------------------------------------------------------------ */
  function seeded(seed) {
    let s = ((seed | 0) * 2654435761) >>> 0;
    const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    next(); next();
    return next;
  }

  /* ------------------------------------------------------------
     その日の店を組む（純関数・spec.md §6）
     **乱数はここで使い切る。**描画層は shop を読むだけで引かない
     （jansou/spec.md §1 と同じ作法）。

     `st`   … セーブ（discovered / contracted / agency を見る）
     `trip` … 遠征（pref と dayLeft）
     `rng`  … 0〜1。テストで固定できるように注入する
  ------------------------------------------------------------ */
  function buildShop(st, trip, rng) {
    rng = rng || Math.random;
    const pref = (typeof Geo !== 'undefined' && Geo.prefOf(trip.pref)) || null;
    const scale = pref ? pref.scale : 3;
    const typeKey = pickType(scale, rng);
    const t = TYPE_BY_KEY[typeKey];

    const tables = t.tables[0] + Math.floor(rng() * (t.tables[1] - t.tables[0] + 1));

    /* **擬似 parlor。`Jansou.normalize()` を通さない**（§6.3）。
       `JansouFloor` が読むキーだけを持たせる。`floor: null` なら
       `reconcile` が `autoPlace` で卓を組む */
    const parlor = {
      day: 0, tables, interior: t.interior, auto: t.auto, sign: t.sign,
      rep: 0, speed: 1, floor: null, shifts: {}, buffs: [], log: [],
      bottles: [0, 0, 0, 0, 0, 0], regulars: {}, seen: {}, months: [],
    };

    /* --- 席を埋める --- */
    const G = typeof JansouGuests !== 'undefined' ? JansouGuests : null;
    const pool = G ? G.TYPES.filter((x) => x.weight > 0 && x.slots.indexOf(2) >= 0) : [];
    const fill = 0.40 + scale * 0.06;             // 大きい県ほど混んでいる
    const seats = [];
    for (let ti = 0; ti < tables; ti++) {
      for (let si = 0; si < 4; si++) {
        if (rng() > fill) continue;
        seats.push({ table: ti, seat: si, typeKey: weighted(pool, rng), charaId: null, quirk: null });
      }
    }

    /* --- 雀ドルを混ぜる（§3.5。ゼロの日がある） --- */
    const region = pref ? pref.region : null;
    /* **「昨日いた子」を除外しない**（§3.6）。母集団は毎回まるごと */
    const cand = (typeof Scout !== 'undefined' && Scout.findCandidates)
      ? Scout.findCandidates(region, st) : [];
    const want = Math.min(jandolCount(scale, rng), seats.length, cand.length);
    const taken = [];
    for (let i = 0; i < want; i++) {
      const c = drawWeighted(cand, taken, st, rng);
      if (!c) break;
      taken.push(c.id);
      /* 空いている席のどれかに座らせる（まだ雀ドルの居ない席） */
      const free = seats.filter((s) => s.charaId == null);
      if (!free.length) break;
      const s = free[Math.floor(rng() * free.length)];
      s.charaId = c.id;
      /* **雀ドルは二拍**（打ち筋から来る癖＋もう一方の系統の癖。§4.4） */
      s.quirk = quirksFor(c.style, rng);
    }

    /* --- 残りはただの客。**一部にだけ癖が付く**（§4.3） ---
       「癖がある＝雀ドル」にすると観察が完全情報になり、
       3回の上限も見抜く余地も意味を失う。**打てる常連はいる** */
    seats.forEach((s) => { if (!s.quirk) s.quirk = quirksFor(null, rng); });

    return {
      day: -1,                      // 呼ぶ側が parlor.day を入れる（引き直しの印）
      type: typeKey,
      name: nameOf(typeKey, rng),
      parlor,
      seats,
      staff: [],                    // A4.5-1 では絵だけ。押せるのは A4.5-2 以降
      calls: CALLS_PER_DAY,
      met: [],
    };
  }

  /* 客のタイプを重みで引く（jansou.js の weighted と同じ形） */
  function weighted(arr, rng) {
    if (!arr.length) return 'salary';
    let total = arr.reduce((a, t) => a + t.weight, 0);
    let r = rng() * total;
    for (const t of arr) { r -= t.weight; if (r <= 0) return t.key; }
    return arr[arr.length - 1].key;
  }

  /* **`drawOne` と同じ重み**（`Scout.discoverWeights`）で一人引く。
     事務所が小さいうちは上位が見つかりにくい、がそのまま効く */
  function drawWeighted(cand, taken, st, rng) {
    const skip = new Set(taken);
    const pool = cand.filter((c) => !skip.has(c.id));
    if (!pool.length) return null;
    const w = (c) => (typeof Scout !== 'undefined' && Scout.discoverWeights)
      ? Scout.discoverWeights(c.rank, st.agency || 1) : 1;
    const total = pool.reduce((a, c) => a + w(c), 0);
    let r = rng() * total;
    for (const c of pool) { r -= w(c); if (r <= 0) return c; }
    return pool[pool.length - 1];
  }

  /* ------------------------------------------------------------
     `JansouFloor.render` に渡す形へ（描画層はここを読むだけ）
  ------------------------------------------------------------ */
  function stateOf(shop, st) {
    return {
      parlor: shop.parlor,
      /* **癖はここでだけ渡す。**自分の店の `Jansou` は `guests` に
         `quirk` を入れないので、床は何も描かない（§4 の「自分の店には出さない」） */
      guests: shop.seats.map((s) => ({
        table: s.table, seat: s.seat, typeKey: s.typeKey, quirk: (s.quirk || []).slice(),
      })),
      staff: [],
      closedTables: 0, myTable: -1,
      slot: 2, sales: 0,
      /* **日付を出さない。**よその店は帳簿を持たないので、
         既定の「N日目・夜営業中」が出ると自分の店の作りに見える */
      headNote: '覗いている',
      ticker: '',
    };
  }

  /* 席の並び順は `JansouFloor` が `live.seated` に入れる 'p0','p1',… と
     一対一。タップで返る guestId から席を引き当てるのに使う */
  function seatOfGuestId(shop, guestId) {
    const m = /^p(\d+)$/.exec(String(guestId || ''));
    if (!m) return null;
    return shop.seats[+m[1]] || null;
  }

  return {
    SHOP_TYPES, TYPE_BY_KEY, PALETTES, ANY_CHANCE, TWO_CHANCE, CALLS_PER_DAY,
    QUIRKS, QUIRK_BY_KEY, STYLE_QUIRK, BEATS, MARKS, PLAIN_QUIRK,
    seeded, palOf, pickType, jandolCount, nameOf, buildShop, stateOf, seatOfGuestId,
    quirkOf, quirksFor,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ScoutShop };
}
