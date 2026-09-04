/* ============================================================
   直営雀荘 — jansou-floor.js
   フロアの描画（第一段：静止画）

   依存：jansou-guests.js（客タイプとスプライト）
   使う側：jansou.js

   仕様は docs/design/jansou/spec.md §4「絵の作り方」。
   実測値は §4.7。配色・レイアウトはモック画像が正。

   ------------------------------------------------------------
   描き方（§4.1 の決定）
   ------------------------------------------------------------
   SVG に shape-rendering="crispEdges" で矩形を並べる。
   canvas は一枚も使わない（PLiCyのサムネイル制約に触れないため）。

   スプライトは 1文字＝1ピクセルの文字グリッドで持ち、
   横方向のランをまとめて <rect> に落とす。同じ絵は <defs> の <g> に
   一度だけ置いて <use> で並べるので、画面上の要素は50個程度で済む。

   **描画層とデータを分けてあるのは差し替えのため。**
   実機でノード数が問題になったら、同じ文字グリッドから
   オフスクリーンcanvasでスプライトシートを焼いて
   background-position で貼る方式に替えられる（§4.1 の3番）。

   ------------------------------------------------------------
   倍率（§4.1 の決定）
   ------------------------------------------------------------
   倍率は2〜4の整数。フロアの横幅のほうを可変にして幅を使い切る。
   高さは164で固定。**座標変換は floorToScreen() に集約すること。**
   UI層（客カードの当たり判定・スタッフの頭・名前札）が全部これを通る。
   ============================================================ */

const JansouFloor = (() => {
  'use strict';

  const G = typeof JansouGuests !== 'undefined' ? JansouGuests : null;

  /* ---------- パレット（§4.3） ---------- */
  /* **正はこれ一つ。**遠征先の店だけが浅いマージで三色を差し替える */
  const PAL0 = {
    carpetA: '#d4c6b2', carpetB: '#ccbda8', carpetPat: '#baa692', edge: '#a88e78',
    wall: '#301634', wallLow: '#241028',
    neonPink: '#ff56b2', neonCyan: '#60e8ff', neonYellow: '#ffe86e', neonGreen: '#96ffb4',
    tableEdge: '#a668ce', tableMine: '#60a0e1', tableCall: '#ffce50', tableWood: '#8a6a48',
    plankA: '#b8a894', plankSeam: '#9a8a74', plankGrain: '#ac9c86',
    feltTop: '#f06eb0', felt: '#ce3a84', feltLow: '#a02064',
    tile: '#fffcf0', tileLow: '#cec6b2',
    panel: '#542c4c', panelInk: '#fff6e0', panelSub: '#eebee1',
    gold: '#ffce50', goldHi: '#ffe86e',
    ink: '#3e2c24',
    staffCloth: '#e84896', staffTrim: '#ffce50',
    shadow: '#b29e8c',
    closed: '#8c7a92', closedTop: '#a894ae',
    /* 夜の灯り。**値はいままで drawLight に直書きしてあったもの。**
       パレットに出したのは、遠征先の店で型ごとに差し替えるため
       （`scout/spec.md` §3.3）。自分の店では同じ値なので絵は変わらない */
    night: '#301634', lamp: '#ff56b2',
    /* 灯っていないネオン（看板 lv1 のとき）。**値はいままでの直書きのまま。**
       遠征先の店では壁と同じ色にして消す——古い雀荘が「GIRLS」の
       看板を掲げていては、型を差し替えた意味がなくなる */
    signOff: '#4a2a44', signOffLow: '#3a2036',
  };
  /* 別名。**部屋（壁・床・卓・設備）以外はこちらを直に読む**——
     客とスタッフのスプライト、模様替えの枠、指名のハートなど。
     そこは店の型で差し替えない（`scout/spec.md` §3.3）。
     差し替わるのは、上の4つの drawer に `pal` を渡した経路だけ */
  const PAL = PAL0;

  /* ---------- フロアの寸法（§4.7 の実測） ---------- */
  const FLOOR_H = 164;
  const FLOOR_W = 200;      // 論理フロアの幅。**端末によらず固定**（placement.md §1.1）
  const FLOOR_W_MAX = FLOOR_W;
  const WALL_H = 35;        // 壁 0〜34
  const EDGE_Y = 35;        // 床の縁（巾木）35〜36
  const CARPET_Y = 37;      // カーペット 37〜163

  const TABLE_W = 30, TABLE_H = 20;   // 卓（実測）
  const COL_PITCH = 60;               // 卓の横の間隔（旧レイアウトの名残。互換のため残す）
  const SEAT_W = 12, SEAT_H = 16;     // 客スプライト

  /* ---------- 倍率と、見えるフロアの幅（§4.1） ----------
     倍率 s は 160*s <= 使える幅 を満たす最大の整数（2〜4に丸める）。
     **floorW は「窓の幅」であって、フロアの幅ではない。**
     論理フロアは常に 200 で、狭いときは横にずらして見る（placement.md §3） */
  function fit(availW) {
    const fw = (i) => Math.min(FLOOR_W, Math.floor(availW / i));
    /* 隠れるぶんのうち、**物が置ける範囲**がどれだけ削れるか。
       左右 4px ずつは余白の絨毯なので、そこは削れても構わない */
    const lost = (i) => Math.max(0, (FLOOR_W - fw(i)) - GX0 * 2);
    /* **横送りは狭いときの手段であって、既定ではない。**
       店の中身がほぼ全部入る倍率があれば、そちらを選ぶ。
       削れるのが 8px までなら許す（席の絵は12px。半分は超えない） */
    let s = 0;
    for (let i = 4; i >= 2; i--) { if (lost(i) <= 8) { s = i; break; } }
    /* どの倍率でも入らない狭さ（〜360px）。従来どおり 160px が入る倍率にして、
       残りは横送りで見る（placement.md §3） */
    if (!s) for (let i = 4; i >= 2; i--) { if (160 * i <= availW) { s = i; break; } }
    if (!s) s = 2;
    /* **下限でクランプしないこと。** floor(幅/倍率) を上回る値を返すと
       そのぶん枠からはみ出す。狭いときは窓が細くなるのが正しい */
    return { scale: s, floorW: fw(s) };
  }

  /* ============================================================
     マス目と設置物（placement.md §1・§2）

     8px 角のマス目を 24列 × 15行。原点は (4, 38)。
     設置物はマス単位で `parlor.floor.items` に保存する。
     **卓の足元は席4つを含めた 7×5 マス**なので、置けた卓には必ず4席が描ける。
     狭い幅で上の2席が消える問題は、ここで構造的に無くなる。
     ============================================================ */
  const GRID = 8;
  const GX0 = 4, GY0 = 38;            // マス目の原点（floor px）。壁35＋巾木2の下
  const COLS = 24, ROWS = 15;         // 4+24*8=196<=200、38+15*8=158<=164
  const TABLE_DX = 13, TABLE_DY = 17; // 足元の左上から見た卓（30×20）の位置

  const KINDS = {
    table:   { w: 7, h: 5, name: '卓' },
    sofa:    { w: 3, h: 3, name: 'ソファ席' },
    counter: { w: 3, h: 3, name: 'ドリンクカウンター' },
    plant:   { w: 1, h: 2, name: '観葉植物' },
    door:    { w: 4, h: 2, name: '入口' },
  };
  /* 入口は固定。動かせないし、上に物は置けない */
  const DOOR = { id: 0, kind: 'door', x: 10, y: 13 };

  const cellX = (gx) => GX0 + gx * GRID;
  const cellY = (gy) => GY0 + gy * GRID;
  const sizeOf = (kind) => KINDS[kind] || KINDS.plant;

  function overlaps(a, b) {
    const sa = sizeOf(a.kind), sb = sizeOf(b.kind);
    return a.x < b.x + sb.w && b.x < a.x + sa.w && a.y < b.y + sb.h && b.y < a.y + sa.h;
  }
  function inBounds(it) {
    const s = sizeOf(it.kind);
    return it.x >= 0 && it.y >= 0 && it.x + s.w <= COLS && it.y + s.h <= ROWS;
  }
  function covers(it, gx, gy) {
    const s = sizeOf(it.kind);
    return gx >= it.x && gx < it.x + s.w && gy >= it.y && gy < it.y + s.h;
  }
  /* そこに置けるか。範囲内・入口に掛からない・他と重ならない（純関数） */
  function canPlace(floor, it, ignoreId) {
    if (!it || !KINDS[it.kind] || it.kind === 'door') return false;
    if (!Number.isInteger(it.x) || !Number.isInteger(it.y)) return false;
    if (!inBounds(it) || overlaps(it, DOOR)) return false;
    const items = (floor && floor.items) || [];
    return !items.some((o) => o.id !== ignoreId && overlaps(it, o));
  }
  /* そのマスに何も無いか（スタッフの立ち位置に使う） */
  function freeCell(floor, gx, gy) {
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return false;
    if (covers(DOOR, gx, gy)) return false;
    return !((floor && floor.items) || []).some((o) => covers(o, gx, gy));
  }

  /* ---------- 自動配置（placement.md §2.3） ----------
     **既存プレイヤーの店をそのまま再現するためのもの。**
     旧 layout() の「1行3卓・行を中央に寄せる」をマス目の上でなぞる。
     卓7・8だけは3行目が入口に当たるので左右に振る（旧レイアウトはここで
     ソファ・カウンターと同じ高さに並んでいた。それがこの作業で直る） */
  const ROWS_FOR = (n) => (n <= 3 ? [1] : n <= 6 ? [1, 7] : [0, 5, 10]);
  const TAIL_COLS = [0, 14];                    // 3行目は入口を避けて左右へ
  const SOFA_SPOTS = [[0, 12], [21, 9], [21, 0], [7, 10]];
  const COUNTER_SPOTS = [[20, 12], [21, 12], [21, 3], [10, 10]];

  function scanSpot(floor, kind) {
    for (let gy = 0; gy < ROWS; gy++) {
      for (let gx = 0; gx < COLS; gx++) {
        if (canPlace(floor, { kind, x: gx, y: gy })) return { x: gx, y: gy };
      }
    }
    return null;
  }
  function spotFor(floor, kind, spots) {
    for (const [x, y] of spots || []) {
      if (canPlace(floor, { kind, x, y })) return { x, y };
    }
    return scanSpot(floor, kind);
  }
  function pushItem(floor, kind, x, y) {
    floor.items.push({ id: floor.next++, kind, x, y });
  }

  function autoPlace(opts) {
    opts = opts || {};
    const n = Math.max(0, Math.min(8, opts.tables | 0));
    const lv = opts.interior | 0;
    const rows = ROWS_FOR(n);
    /* 3行のときは右の帯（3列）をソファとカウンターに空けておく */
    const span = rows.length >= 3 ? COLS - 3 : COLS;
    const floor = { v: 1, auto: true, items: [], next: 1, mine: null };
    let left = n;
    rows.forEach((gy, r) => {
      const k = Math.min(3, left);
      left -= k;
      const tail = r === rows.length - 1 && rows.length >= 3 && k < 3;
      const x0 = Math.floor((span - k * 7) / 2);
      for (let i = 0; i < k; i++) pushItem(floor, 'table', tail ? TAIL_COLS[i] : x0 + i * 7, gy);
    });
    if (lv >= 4) { const p = spotFor(floor, 'sofa', SOFA_SPOTS); if (p) pushItem(floor, 'sofa', p.x, p.y); }
    if (lv >= 5) { const p = spotFor(floor, 'counter', COUNTER_SPOTS); if (p) pushItem(floor, 'counter', p.x, p.y); }
    return floor;
  }

  /* ---------- セーブとの突き合わせ（placement.md §2.2。純関数・冪等） ----------
     normalize() から毎回通す。**ここが壊れると進行中の店が消える。**
       ・floor が無い（既存セーブ）→ autoPlace で今までと同じ絵を組む
       ・auto（模様替えをしていない）→ 卓数・内装が変わったら組み直す
       ・auto でない → 置いてあるものを尊重し、数だけ合わせる */
  function fixCount(floor, kind, want, spots) {
    const mine = floor.items.filter((it) => it.kind === kind);
    for (let i = mine.length - 1; i >= want; i--) {
      floor.items.splice(floor.items.indexOf(mine[i]), 1);
    }
    for (let i = mine.length; i < want; i++) {
      const p = spotFor(floor, kind, spots);
      if (!p) break;
      pushItem(floor, kind, p.x, p.y);
    }
  }
  /* mine は**卓の id**。番号（何番目か）で持つと、卓を撤去したときに
     指す先がずれる。id なら並べ替えても撤去しても指したままか、消えるだけ */
  function validMine(mine, floor) {
    return floor.items.some((it) => it.kind === 'table' && it.id === mine) ? mine : null;
  }
  function tableSpots(floor) {
    /* 卓を足すときの置き場所。autoPlace と同じ並びを先に見る */
    const out = [];
    [[0, 5, 10], [1, 7], [1]].forEach((rows) => rows.forEach((gy) => {
      [0, 7, 14, 1, 8, 15, 5, 12].forEach((gx) => out.push([gx, gy]));
    }));
    return out;
  }

  function reconcile(floor, opts) {
    opts = opts || {};
    const n = Math.max(0, Math.min(8, opts.tables | 0));
    const lv = opts.interior | 0;
    const wantSofa = lv >= 4 ? 1 : 0, wantCounter = lv >= 5 ? 1 : 0;
    const src = floor && typeof floor === 'object' ? floor : {};
    const srcItems = Array.isArray(src.items) ? src.items : null;
    const auto = src.auto !== false || !srcItems;

    let out;
    if (auto) {
      out = autoPlace({ tables: n, interior: lv });
      /* 観葉植物は自動配置の対象外。置いてあって、まだ置ける場所なら残す */
      (srcItems || []).forEach((raw) => {
        if (!raw || raw.kind !== 'plant') return;
        const it = { id: out.next, kind: 'plant', x: raw.x | 0, y: raw.y | 0 };
        if (canPlace(out, it)) { out.items.push(it); out.next++; }
      });
    } else {
      out = { v: 1, auto: false, items: [], next: 1, mine: null };
      /* 置ける順に拾い直す。範囲外・重なり・入口に掛かるものは落として置き直す。
         **id は保つ**（mine が id で指しているので、振り直すと指す先が変わる）。
         欠けているものと重複しているものだけ、あとで振り直す */
      const used = new Set();
      srcItems.forEach((raw) => {
        if (!raw || !KINDS[raw.kind] || raw.kind === 'door') return;
        const id = Number.isInteger(raw.id) && raw.id > 0 && !used.has(raw.id) ? raw.id : 0;
        const it = { id, kind: raw.kind, x: raw.x | 0, y: raw.y | 0 };
        if (!canPlace(out, it)) return;
        out.items.push(it);
        if (id) used.add(id);
      });
      out.next = (used.size ? Math.max.apply(null, Array.from(used)) : 0) + 1;
      out.items.forEach((it) => { if (!it.id) it.id = out.next++; });
      fixCount(out, 'table', n, tableSpots(out));
      fixCount(out, 'sofa', wantSofa, SOFA_SPOTS);
      fixCount(out, 'counter', wantCounter, COUNTER_SPOTS);
    }
    out.mine = validMine(src.mine, out);
    return out;
  }

  /* ---------- 隣接コンボ（placement.md §5。純関数） ----------
     足元の矩形どうしの隙間が**1マス以内**なら隣接。ぴったり付けないと
     成立しないのは、指で置くには厳しい。並び順には依存しない。

     **効くのは「誰が座るか・どれだけ居るか・誰から立つか・チップ・
     ボトル・常連の進み・指名」だけ。** `computeDay` の guests と sales は
     1円も動かさない（§5.3 の厳密一致を崩さないため）。 */
  const COMBOS = [
    { key: 'kutsurogi', name: 'くつろぎ席', need: '卓＋ソファ', see: '長く居る・チップ' },
    { key: 'counter',   name: 'カウンター席', need: '卓＋カウンター', see: '上客が座る' },
    { key: 'iriguchi',  name: '入口席',     need: '卓＋入口', see: '一見さん・回転が速い' },
    { key: 'shizuka',   name: '静かな席',   need: '卓が他とも入口とも離れている', see: '常連と特別な客' },
    { key: 'hanamichi', name: '花道',       need: '卓の左右に観葉植物', see: '指名が増える' },
    { key: 'lounge',    name: 'ラウンジ',   need: 'ソファ＋カウンター', see: 'ボトルの格が上がる' },
  ];
  const COMBO_BY_KEY = {};
  COMBOS.forEach((c) => { COMBO_BY_KEY[c.key] = c; });

  const TIP_PER_GUEST = 300;    // くつろぎ席のチップ（一人あたり・臨時収入）
  const DWELL_RELAX = 1.4;      // くつろぎ席は長く居る
  const DWELL_DOOR = 0.7;       // 入口席は回転が速い

  /* 隣接（1マスの隙間まで数える） */
  function adjacent(a, b) {
    const sa = sizeOf(a.kind), sb = sizeOf(b.kind);
    const gx = Math.max(0, b.x - (a.x + sa.w), a.x - (b.x + sb.w));
    const gy = Math.max(0, b.y - (a.y + sa.h), a.y - (b.y + sb.h));
    return Math.max(gx, gy) <= 1;
  }
  /* 卓の左右（席の外）に付いているか。花道はここだけ横並びを見る */
  function sideOf(t, p) {
    const st = KINDS.table, sp = sizeOf(p.kind);
    if (!(p.y < t.y + st.h && t.y < p.y + sp.h)) return null;
    if (p.x + sp.w <= t.x && t.x - (p.x + sp.w) <= 1) return 'left';
    if (t.x + st.w <= p.x && p.x - (t.x + st.w) <= 1) return 'right';
    return null;
  }

  function combos(floor) {
    const items = (floor && floor.items) || [];
    const tables = items.filter((it) => it.kind === 'table');
    const sofas = items.filter((it) => it.kind === 'sofa');
    const counters = items.filter((it) => it.kind === 'counter');
    const plants = items.filter((it) => it.kind === 'plant');
    const byId = {};
    const counts = {};
    const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };

    tables.forEach((t) => {
      const keys = [];
      if (sofas.some((o) => adjacent(t, o))) keys.push('kutsurogi');
      if (counters.some((o) => adjacent(t, o))) keys.push('counter');
      const atDoor = adjacent(t, DOOR);
      if (atDoor) keys.push('iriguchi');
      if (!atDoor && !tables.some((o) => o.id !== t.id && adjacent(t, o))) keys.push('shizuka');
      const sides = {};
      plants.forEach((p) => { const w = sideOf(t, p); if (w) sides[w] = true; });
      if (sides.left && sides.right) keys.push('hanamichi');
      keys.forEach(bump);
      byId[t.id] = keys;
    });

    const lounge = sofas.some((sf) => counters.some((c) => adjacent(sf, c)));
    if (lounge) bump('lounge');
    return {
      byId, counts, lounge,
      list: COMBOS.filter((c) => counts[c.key])
        .map((c) => ({ key: c.key, name: c.name, see: c.see, n: counts[c.key] })),
    };
  }

  /* 卓ごとの性質。**帳簿層（build）に渡すのはこれだけ**（placement.md §6.2）。
     tableIdx は「使える卓」の並び（閉鎖卓と自分の卓を除いたもの）で、
     返す配列はその並びにそろえる */
  function tableTraits(floor, tableIdx) {
    const c = combos(floor);
    const tables = tablesOf(floor);
    return (tableIdx || []).map((ti) => {
      const t = tables[ti];
      const keys = (t && c.byId[t.id]) || [];
      const has = (k) => keys.indexOf(k) >= 0;
      const door = has('iriguchi'), relax = has('kutsurogi');
      return {
        idx: ti, keys,
        /* **入口席は他が何であれ回転が速い。**近いほど客が入れ替わる */
        dwellMul: door ? DWELL_DOOR : relax ? DWELL_RELAX : 1,
        evictRank: door ? 0 : relax ? 2 : 1,      // 小さいほど先に立つ
        tip: relax ? TIP_PER_GUEST : 0,           // ソファが隣なら、帰りぎわにチップ
        /* 席の好み。卓に複数あるときは 入口席 → カウンター席 → 静かな席 の順 */
        prefer: door ? 'shinki' : has('counter') ? 'joukyaku' : has('shizuka') ? 'tokubetsu' : null,
        hanamichi: has('hanamichi'),
      };
    });
  }

  /* ---------- 模様替えの操作（純関数。placement.md §7） ----------
     どれも**新しい floor を返す**（置けなければ null）。
     一度でも手を入れた店は `auto: false` になり、以後は勝手に動かない */
  function copyFloor(floor) {
    return { v: 1, auto: false, next: floor.next | 1,
             items: floor.items.map((it) => ({ id: it.id, kind: it.kind, x: it.x, y: it.y })),
             mine: floor.mine != null ? floor.mine : null };
  }
  /* その点にあるもの。**足元ぜんぶが当たり判定**（席の余白も掴める）。
     小さいものを先に見る。卓の陰に隠れた観葉植物を掴めなくしない */
  function pickItem(floor, fx, fy) {
    const gx = Math.floor((fx - GX0) / GRID), gy = Math.floor((fy - GY0) / GRID);
    const hits = ((floor && floor.items) || []).filter((it) => covers(it, gx, gy));
    hits.sort((a, b) => (sizeOf(a.kind).w * sizeOf(a.kind).h) - (sizeOf(b.kind).w * sizeOf(b.kind).h));
    return hits[0] || null;
  }
  /* 足元が床からはみ出さないように寄せる */
  function clampCell(kind, gx, gy) {
    const s = sizeOf(kind);
    return { x: Math.max(0, Math.min(COLS - s.w, Math.round(gx))),
             y: Math.max(0, Math.min(ROWS - s.h, Math.round(gy))) };
  }
  function moveItem(floor, id, gx, gy) {
    const out = copyFloor(floor);
    const it = out.items.find((o) => o.id === id);
    if (!it) return null;
    const p = clampCell(it.kind, gx, gy);
    const moved = { id: it.id, kind: it.kind, x: p.x, y: p.y };
    if (!canPlace(out, moved, id)) return null;
    it.x = p.x; it.y = p.y;
    return out;
  }
  function addItem(floor, kind, spots) {
    const out = copyFloor(floor);
    const p = spotFor(out, kind, spots || []);
    if (!p) return null;
    const it = { id: out.next++, kind, x: p.x, y: p.y };
    out.items.push(it);
    return { floor: out, item: it };
  }
  /* 置き場所の候補。**まず決め打ちの並び、次に近いところから。**
     買ったものが画面の外に置かれると、置いたことに気づけない */
  function spotsNear(floor, kind, near, preferred) {
    const out = (preferred || []).slice();
    const all = [];
    for (let gy = 0; gy < ROWS; gy++) {
      for (let gx = 0; gx < COLS; gx++) {
        if (canPlace(floor, { kind, x: gx, y: gy })) all.push([gx, gy]);
      }
    }
    const nx = near ? near.x : COLS / 2, ny = near ? near.y : ROWS / 2;
    all.sort((a, b) => (Math.abs(a[0] - nx) + Math.abs(a[1] - ny)) -
                       (Math.abs(b[0] - nx) + Math.abs(b[1] - ny)));
    return out.concat(all);
  }

  function removeItem(floor, id) {
    const out = copyFloor(floor);
    const i = out.items.findIndex((o) => o.id === id);
    if (i < 0) return null;
    out.items.splice(i, 1);
    out.mine = validMine(out.mine, out);
    return out;
  }
  /* 二つを入れ替える。**卓8まで置くと床がほぼ埋まり、空きが無くなる。**
     入れ替えが無いと、そこから先は一つも動かせない店になる */
  function swapItems(floor, idA, idB) {
    const out = copyFloor(floor);
    const a = out.items.find((o) => o.id === idA);
    const b = out.items.find((o) => o.id === idB);
    if (!a || !b || a === b) return null;
    const ax = a.x, ay = a.y;
    a.x = b.x; a.y = b.y; b.x = ax; b.y = ay;
    const fits = (it) => inBounds(it) && !overlaps(it, DOOR) &&
      !out.items.some((o) => o !== it && overlaps(it, o));
    return fits(a) && fits(b) ? out : null;
  }
  function setMine(floor, id) {
    const out = copyFloor(floor);
    out.mine = out.mine === id ? null : validMine(id, out);
    return out;
  }

  /* ---------- 卓と席 ---------- */
  /* 置いてある卓を並び順に。x,y は卓（30×20）の左上の floor px */
  function tablesOf(floor) {
    const out = [];
    ((floor && floor.items) || []).forEach((it) => {
      if (it.kind !== 'table') return;
      out.push({ idx: out.length, id: it.id, gx: it.x, gy: it.y,
                 x: cellX(it.x) + TABLE_DX, y: cellY(it.y) + TABLE_DY });
    });
    return out;
  }
  function itemsOf(floor, kind) {
    return ((floor && floor.items) || []).filter((it) => it.kind === kind);
  }
  /* 卓のまわりの席。**4つとも必ずある**（足元がそのぶん確保されている） */
  function seatsOf(t) {
    return [
      { x: t.x - SEAT_W - 1, y: t.y + 1, face: 1 },
      { x: t.x + TABLE_W + 1, y: t.y + 1, face: -1 },
      { x: t.x + 3, y: t.y - SEAT_H, face: 1 },
      { x: t.x + TABLE_W - SEAT_W - 3, y: t.y - SEAT_H, face: 1 },
    ];
  }
  /* 卓の足元をぐるりと囲むマスのうち、何も無いもの（スタッフの立ち位置。§1.3） */
  function ringCells(floor, t) {
    const s = KINDS.table, out = [];
    for (let gy = t.gy - 1; gy <= t.gy + s.h; gy++) {
      for (let gx = t.gx - 1; gx <= t.gx + s.w; gx++) {
        const edge = gx === t.gx - 1 || gx === t.gx + s.w || gy === t.gy - 1 || gy === t.gy + s.h;
        if (edge && freeCell(floor, gx, gy)) out.push({ x: gx, y: gy });
      }
    }
    return out;
  }

  /* ============================================================
     帳簿層 — タイムライン生成（純関数。DOMに触らない）
     仕様は spec.md §5.4。乱数は引数の rng だけを使う。

     build(day, opts, rng) -> { timeline, summary }
       day   … Jansou.computeDay() の結果（slots[i].guests / sales / full）
       opts  … { fees:[昼,夕,夜の場代], tableIdx:[使える卓の番号],
                 slotStaff:[[id...]×3], bonuses:[{slot, at, amount, label}],
                 interrupts:[{slot, at, node}],
                 regulars:{id→常連}, seen:{id→回数},   … 顔の選択に使う（§7）
                 visitor:{slot, at, typeKey, stay} }  … 帳簿に載らない来訪者（荒らし）
       rng   … 0〜1 を返す関数

     帳簿層で守ること:
       Σ arrive.count（帯ごと） = day.slots[i].guests
       Σ pay.amount（帯ごと）   = day.slots[i].sales   … 端数は帯の最後の pay に寄せる
       歩行中は MAX_WALK 人まで、占有は席数まで、swap は満席のときだけ
     ============================================================ */
  const SLOT_SEC = [14, 14, 18];     // §5.1
  const INTERMISSION = 1;            // 幕間
  const MAX_WALK = 3;                // 同時に歩ける組数（§5.4。群は連れ立って歩くので1組）
  const WALK_SEC = 1.5;              // 入口から席まで（×1）
  const SWAP_SEC = 0.3;              // 席の入れ替わり（×1）
  const SEATS_PER_TABLE = 4;

  /* 種類ごとの並び順。同時刻なら 退店 → 到着 → 支払い の順に消化する。
     退店を先にしないと swap の席が空かない */
  const ORD = { slotStart: 0, leave: 1, arrive: 2, full: 3, pay: 4, bonus: 5,
                staffMove: 6, nominate: 7, visitor: 8, interrupt: 9, visitorLeave: 10,
                slotEnd: 11, dayEnd: 12 };

  function slotStartTimes() {
    const out = [];
    let t = 0;
    for (let i = 0; i < SLOT_SEC.length; i++) { out.push(t); t += SLOT_SEC[i] + INTERMISSION; }
    return out;
  }

  function build(day, opts, rng) {
    opts = opts || {};
    rng = rng || Math.random;
    const fees = opts.fees || [1600, 2100, 2600];
    const tableIdx = (opts.tableIdx || []).slice();
    const seatsN = tableIdx.length * SEATS_PER_TABLE;
    /* 卓ごとの性質（placement.md §5・§6.2）。渡されなければ全部ふつうの卓。
       **ここが変えるのは「誰が座るか・どれだけ居るか・誰から立つか・チップ」だけ。**
       Σcount＝guests と Σpay＝sales は動かさない */
    const traits = (opts.tables && opts.tables.length === tableIdx.length)
      ? opts.tables
      : tableIdx.map((ti) => ({ idx: ti, keys: [], dwellMul: 1, evictRank: 1, tip: 0, prefer: null }));
    const groupOf = (seatNo) => (seatNo / SEATS_PER_TABLE) | 0;
    const starts = slotStartTimes();
    const dayEndT = starts[2] + SLOT_SEC[2];
    const ev = [];
    const push = (e) => { ev.push(e); return e; };

    /* 席の占有。seat 番号 = table位置 * 4 + 席（0〜3）。一日通しで持つ */
    const occ = new Array(seatsN).fill(null);   // {guestId, since, leaveAt, slot, amount}
    const walks = [];                            // 歩行中 {until, count}
    let lastTable = tableIdx.length ? tableIdx[0] : 0;
    let tips = 0;                       // くつろぎ席のチップの合計（settle が足す）
    const summary = { perSlot: [], seats: seatsN };

    /* 予定どおりの退店を、時刻 t まで進める */
    function release(t) {
      for (let i = 0; i < occ.length; i++) {
        const o = occ[i];
        if (o && o.leaveAt <= t) { leaveNow(i, o.leaveAt); }
      }
    }
    function leaveNow(seatNo, t, evicted) {
      const o = occ[seatNo];
      if (!o) return;
      occ[seatNo] = null;
      if (o.head) {                 // 群は先頭の席だけが退店と支払いを持つ
        push({ t, kind: 'leave', guestId: o.guestId, table: o.table, seat: o.seat, count: o.count,
               evicted: !!evicted });
        push({ t, kind: 'pay', slot: o.slot, guestId: o.guestId, amount: o.amount, table: o.table });
        /* くつろぎ席のチップ。**場代（pay）には混ぜない。**
           臨時収入（bonus）の経路なので、帯の Σpay＝sales は動かない（§5.4） */
        if (o.tip) {
          const amount = o.tip * o.count;
          tips += amount;
          push({ t, kind: 'bonus', amount, label: 'チップ', table: o.table, combo: 'kutsurogi' });
        }
      }
    }
    function freeSeats() {
      const out = [];
      for (let i = 0; i < occ.length; i++) if (!occ[i]) out.push(i);
      return out;
    }
    /* 同じ卓で n 席まとめて空いているところ。無ければ空席をばらで。
       want（客の好み）に合う卓があればそこから見る。**空きの有無は変えない** */
    function pickSeats(n, want) {
      const free = freeSeats();
      if (free.length < n) return null;
      const order = [];
      for (let ti = 0; ti < tableIdx.length; ti++) order.push(ti);
      /* sort は安定なので、同じ好みのなかでは番号の若い卓が先（乱数は使わない） */
      if (want) order.sort((a, b) => (traits[b].prefer === want ? 1 : 0) - (traits[a].prefer === want ? 1 : 0));
      for (const ti of order) {
        const mine = free.filter((s) => groupOf(s) === ti);
        if (mine.length >= n) return mine.slice(0, n);
      }
      return free.slice(0, n);
    }
    /* 満席なら、いちばん早くから座っている客を追い出す */
    function evictOldest(n, t) {
      const seated = [];
      for (let i = 0; i < occ.length; i++) if (occ[i]) seated.push(i);
      /* **入口席から先に立ち、くつろぎ席は最後まで残る。**同じなら早く座った順 */
      seated.sort((a, b) => (traits[groupOf(a)].evictRank - traits[groupOf(b)].evictRank) ||
                            (occ[a].since - occ[b].since));
      const out = [];
      for (const s of seated) {
        if (out.length >= n) break;
        const o = occ[s];
        if (!o) continue;             // 群の連れとして、もう出したあと
        /* 群は丸ごと出す。ばらで追い出すと支払いが二重になる */
        for (let j = 0; j < occ.length; j++) {
          if (occ[j] && occ[j].guestId === o.guestId) { leaveNow(j, t, true); out.push(j); }
        }
      }
      return out.slice(0, n);
    }
    /* 歩いている組数。群は連れ立って歩くので1組と数える */
    function walkersAt(t) {
      let n = 0;
      for (const w of walks) if (w.until > t) n += 1;
      return n;
    }

    const G = typeof JansouGuests !== 'undefined' ? JansouGuests
      : (typeof require === 'function' ? require('./jansou-guests.js').JansouGuests : null);
    const usedToday = new Set();

    for (let si = 0; si < SLOT_SEC.length; si++) {
      const D = SLOT_SEC[si], t0 = starts[si];
      const slot = day.slots[si];
      const guests = slot.guests | 0, sales = slot.sales | 0;
      const fee = fees[si];
      const onDuty = (opts.slotStaff && opts.slotStaff[si]) || [];
      push({ t: t0, kind: 'slotStart', slot: si, staff: onDuty.slice() });

      /* ---- 到着イベントを人数ぶん組む（群は人数を消費） ----
         推しファンは、推しになれる子が出勤している帯にしか来ない（§6.1。見た目だけ） */
      const pool = G.TYPES.filter((x) => x.weight > 0 && x.slots.indexOf(si) >= 0 &&
        !(x.key === 'oshifan' && !onDuty.length));
      const single = pool.filter((x) => !(x.effect && x.effect.kind === 'group'));
      const pickFrom = (arr) => {
        const W = arr.reduce((a, x) => a + x.weight, 0);
        let r = rng() * W;
        for (const x of arr) { r -= x.weight; if (r <= 0) return x; }
        return arr[arr.length - 1];
      };
      const arrivals = [];
      let left = guests;
      while (left > 0) {
        let tp = pickFrom(pool);
        const gsize = tp.effect && tp.effect.kind === 'group' ? tp.effect.val : 1;
        if (gsize > left) tp = pickFrom(single);           // 「カップル1人」は作らない
        const count = tp.effect && tp.effect.kind === 'group' ? tp.effect.val : 1;
        /* 誰が来るか。**同じ人は一日に一度だけ。** かぶったら引き直し、
           それでもかぶれば池を順に見て空いている顔、それも無ければその日限りの
           id（覚えない）にする。id が重なると席の追い出しや支払いが二重になる */
        let face = G.pickFace(tp.key, opts.regulars, opts.seen, rng);
        for (let r = 0; r < 3 && usedToday.has(face); r++) face = G.pickFace(tp.key, opts.regulars, opts.seen, rng);
        let transient = false;
        if (usedToday.has(face)) {
          face = null;
          for (let n = 0; n < G.FACES; n++) {
            const cand = G.faceId(tp.key, n);
            if (!usedToday.has(cand)) { face = cand; break; }
          }
          if (!face) { face = tp.key + '#d' + si + '-' + arrivals.length; transient = true; }
        }
        usedToday.add(face);
        const reg = opts.regulars && opts.regulars[face];
        const favTalent = tp.key === 'oshifan'
          ? ((reg && reg.favTalent != null && onDuty.indexOf(reg.favTalent) >= 0) ? reg.favTalent
            : onDuty[Math.floor(rng() * onDuty.length)])
          : null;
        const stage = reg ? G.stageOf(reg.visits || 0) : 0;
        arrivals.push({ type: tp, count, face, favTalent, transient, stage, cat: tp.cat,
          /* 主（段階3）になった常連は、常連の主の姿で描く */
          look: stage >= 3 ? 'nushi' : tp.key });
        left -= count;
      }
      const N = arrivals.length;

      /* 支払いの内訳。feeMul で色を付け、合計を sales に厳密に合わせる */
      const raw = arrivals.map((a) => fee * (a.type.feeMul > 0 ? a.type.feeMul : 1) * a.count);
      const rawSum = raw.reduce((a, b) => a + b, 0) || 1;
      const amounts = raw.map((r) => Math.round(r * sales / rawSum));
      if (N) amounts[N - 1] += sales - amounts.reduce((a, b) => a + b, 0);

      const dwell = Math.max(2.0, Math.min(D, D * seatsN / Math.max(1, guests) * 0.85));
      let fullDone = false, walkN = 0, swapN = 0;

      arrivals.forEach((a, k) => {
        const t = t0 + D * Math.pow((k + 0.5) / N, 0.8);
        release(t);
        const guestId = a.face;
        /* どの席を好むか（placement.md §5.2）。
           上客はカウンター席、特別な客と段階2以上の常連は静かな席、
           一見さんは入口席。**好みであって決まりではない**（空いていなければ他へ） */
        const want = a.cat === 'joukyaku' ? 'joukyaku'
          : (a.cat === 'tokubetsu' || a.stage >= 2) ? 'tokubetsu'
          : a.stage === 0 ? 'shinki' : null;
        let seats = pickSeats(a.count, want);
        let mode = 'swap', evict = null;
        if (seats) {
          /* 空席あり。歩ける枠があれば歩く */
          if (walkersAt(t) < MAX_WALK) {
            mode = 'walk';
            walks.push({ until: t + WALK_SEC, count: a.count });
          }
        } else {
          /* 満席。いちばん古い客を出して席を作る */
          const freed = evictOldest(a.count, t);
          evict = freed.length ? true : null;
          seats = pickSeats(a.count, want) || freeSeats().slice(0, a.count);
        }
        if (!seats || seats.length < a.count) {
          /* 席数より大きい群（卓1で4人など）。入るぶんだけ座らせる */
          seats = freeSeats().slice(0, a.count);
        }
        const group = groupOf(seats[0]);
        const tr = traits[group];
        const table = tableIdx[group];
        const seatNo = seats[0] % SEATS_PER_TABLE;
        /* くつろぎ席は長く、入口席は短く（滞在は上限であって保証ではない） */
        const leaveAt = Math.min(dayEndT, t + dwell * (tr.dwellMul || 1));
        seats.forEach((s, j) => {
          occ[s] = { guestId, since: t, leaveAt, slot: si, amount: amounts[k],
                     table: tableIdx[groupOf(s)], seat: s % SEATS_PER_TABLE,
                     count: a.count, head: j === 0, tip: j === 0 ? (tr.tip || 0) : 0 };
        });
        if (mode === 'walk') walkN++; else swapN++;
        lastTable = table;
        push({ t, kind: 'arrive', slot: si, guestId, typeKey: a.type.key, look: a.look, count: a.count,
               amount: amounts[k], favTalent: a.favTalent, transient: a.transient || undefined,
               combo: tr.keys && tr.keys.length ? tr.keys.slice() : undefined,
               table, seat: seatNo,
               seats: seats.map((s) => ({ table: tableIdx[(s / SEATS_PER_TABLE) | 0], seat: s % SEATS_PER_TABLE })),
               mode, evict });
        if (!fullDone && slot.full && freeSeats().length === 0) {
          fullDone = true;
          push({ t, kind: 'full', slot: si });
        }
      });

      /* ---- スタッフの動き（種から、2.5〜4秒間隔） ---- */
      if (onDuty.length) {
        let t = t0 + 1.5 + rng() * 1.5, r = 0;
        while (t < t0 + D - 1) {
          push({ t, kind: 'staffMove', charaId: onDuty[r % onDuty.length], table: lastTable });
          r++;
          t += 2.5 + rng() * 1.5;
        }
        /* 指名。演出だけ（§5.4）。帯ごとに一人まで。
           **花道（卓の左右に観葉植物）があれば二人まで**（placement.md §5.2） */
        if (rng() < 0.35) {
          push({ t: t0 + D * (0.3 + rng() * 0.5), kind: 'nominate',
                 charaId: onDuty[Math.floor(rng() * onDuty.length)] });
        }
        if (traits.some((tr) => tr.hanamichi) && rng() < 0.35) {
          push({ t: t0 + D * (0.3 + rng() * 0.5), kind: 'nominate',
                 charaId: onDuty[Math.floor(rng() * onDuty.length)], combo: 'hanamichi' });
        }
      }

      (opts.bonuses || []).filter((b) => b.slot === si).forEach((b) => {
        push({ t: t0 + Math.min(D - 0.5, b.at != null ? b.at : D * 0.6), kind: 'bonus',
               amount: b.amount, label: b.label });
      });
      (opts.interrupts || []).filter((x) => x.slot === si).forEach((x) => {
        push({ t: t0 + Math.min(D - 0.5, x.at != null ? x.at : 1), kind: 'interrupt', node: x.node });
      });
      /* 帳簿に載らない来訪者（荒らし）。入口に現れて、割り込みのあと去る。
         guests にも sales にも数えない（§5.3 の厳密一致を崩さない） */
      if (opts.visitor && opts.visitor.slot === si) {
        const v = opts.visitor;
        const tv = t0 + Math.max(0, (v.at != null ? v.at : 5) - 1.5);
        push({ t: tv, kind: 'visitor', typeKey: v.typeKey, name: v.name || '' });
        push({ t: Math.min(t0 + D - 0.2, tv + (v.stay || 6)), kind: 'visitorLeave' });
      }

      push({ t: t0 + D, kind: 'slotEnd', slot: si, guests, sales });
      summary.perSlot.push({ guests, sales, arrives: N, walks: walkN, swaps: swapN });
    }

    /* 閉店。まだ座っている客は一斉に帰る */
    release(dayEndT);
    for (let i = 0; i < occ.length; i++) if (occ[i]) leaveNow(i, dayEndT);
    push({ t: dayEndT, kind: 'dayEnd' });

    /* 同時刻は ORD の順。sort は安定なので、同種は入れた順のまま */
    ev.sort((a, b) => (a.t - b.t) || (ORD[a.kind] - ORD[b.kind]));
    summary.duration = dayEndT;
    /* チップの合計。**再生では1円も増減しない**（タイムラインに入っている
       bonus の合計と必ず一致する）。settle がこれを臨時収入に足す */
    summary.tips = tips;
    /* 今日来た顔（同じ人は一度）。jansou.js が名前を用意し、締めで常連に反映する */
    summary.faces = [];
    const seenFace = new Set();
    ev.forEach((e) => {
      if (e.kind !== 'arrive' || e.transient || seenFace.has(e.guestId)) return;
      seenFace.add(e.guestId);
      summary.faces.push({ id: e.guestId, typeKey: e.typeKey, favTalent: e.favTalent,
                           combo: e.combo ? e.combo.slice() : [] });
    });
    return { timeline: ev, summary };
  }

  /* ============================================================
     SVG を組む道具
     ============================================================ */
  const NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }
  function rect(x, y, w, h, fill) {
    return el('rect', { x, y, width: w, height: h, fill });
  }

  /* 文字グリッド → 矩形。横に続く同じ色をひとまとめにする */
  function gridRects(grid, colorOf) {
    const out = [];
    grid.forEach((line, y) => {
      let run = null;
      for (let x = 0; x <= line.length; x++) {
        const col = x < line.length ? colorOf(line[x]) : null;
        if (run && run.col === col) { run.w++; continue; }
        if (run) out.push(rect(run.x, y, run.w, 1, run.col));
        run = col ? { x, w: 1, col } : null;
      }
    });
    return out;
  }

  /* ---------- 5×7のドット文字（ネオン用。使う字だけ） ----------
     日本語はUI層に出すので、ここは看板のアルファベットだけでよい */
  const GLYPH = {
    G: ['.###.', '#....', '#....', '#.##.', '#..#.', '#..#.', '.###.'],
    I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    R: ['###..', '#..#.', '#..#.', '###..', '#.#..', '#..#.', '#..#.'],
    L: ['#....', '#....', '#....', '#....', '#....', '#....', '####.'],
    S: ['.###.', '#....', '#....', '.##..', '...#.', '...#.', '###..'],
    M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
    A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
    O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    N: ['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#'],
  };

  const STAR = ['...#...', '...#...', '.#####.', '#######', '.#####.', '..#.#..', '.#...#.'];
  /* ハート。♥はフォント未収録なので図形で描く（§4.6） */
  const HEART = ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'];

  /* 点灯した点の集合を作る */
  function litSet(rowsArr, ox, oy, set) {
    rowsArr.forEach((line, y) => {
      for (let x = 0; x < line.length; x++) if (line[x] === '#') set.add((oy + y) + ',' + (ox + x));
    });
  }

  /* ネオン。まわりに一回り暗い縁を置くと光って見える */
  function neon(g, text, ox, oy, bright, dim) {
    const on = new Set();
    let x = ox;
    for (const ch of text) {
      if (ch === ' ') { x += 3; continue; }
      if (ch === '*') { litSet(STAR, x, oy, on); x += 8; continue; }
      if (GLYPH[ch]) { litSet(GLYPH[ch], x, oy, on); x += 6; }
    }
    const halo = new Set();
    on.forEach((k) => {
      const [y, xx] = k.split(',').map(Number);
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dy, dx]) => {
        const kk = (y + dy) + ',' + (xx + dx);
        if (!on.has(kk)) halo.add(kk);
      });
    });
    halo.forEach((k) => { const [y, xx] = k.split(',').map(Number); g.appendChild(rect(xx, y, 1, 1, dim)); });
    on.forEach((k) => { const [y, xx] = k.split(',').map(Number); g.appendChild(rect(xx, y, 1, 1, bright)); });
  }

  /* ============================================================
     部屋を描く
     ============================================================ */
  /* 壁。**SIGN が看板、INTERIOR がパネルとミラーボール**（§10）。
     買い足すほど girls-ivory.png の完成形に近づく */
  /* 部屋を描く4つは `pal` を受ける。**既定は PAL。**
     遠征先の店は型ごとに壁・床・卓の三色だけ差し替える
     （`scout/spec.md` §3.3）。**浅いマージにすること**——
     ネオンや金まで差し替えると型の色が壊れる。
     客とスタッフのスプライトは `<symbol>` に色が焼いてあるので、
     ここを通らない（＝差し替わらない）。それでよい */
  function drawWall(g, parlor, pal) {
    const PAL = pal || PAL0;
    const sign = parlor.sign | 0, lv = parlor.interior | 0;
    g.appendChild(rect(0, 0, FLOOR_W, WALL_H, PAL.wall));
    g.appendChild(rect(0, WALL_H - 3, FLOOR_W, 3, PAL.wallLow));

    /* 壁の下端のLED。宣伝3から灯る */
    if (sign >= 3) {
      const led = [PAL.neonCyan, PAL.neonPink, PAL.neonYellow, PAL.neonGreen];
      for (let x = 1; x < FLOOR_W; x += 3) {
        g.appendChild(rect(x, WALL_H - 2, 1, 1, led[(x / 3 | 0) % led.length]));
      }
    }

    /* 看板（§10）。
       1 手書きの貼り紙 … 灯りは無く、壁に紙が貼ってあるだけ
       2 通りに看板     … GIRLS が灯る
       3 雑誌に広告     … ★ MAHJONG も灯り、壁の下端にLEDが入る */
    if (sign >= 2) neon(g, 'GIRLS', 6, 3, PAL.neonPink, '#a01e64');
    else {
      /* 貼り紙。消えたネオン管の下に、手書きの紙が数枚 */
      neon(g, 'GIRLS', 6, 3, PAL.signOff, PAL.signOffLow);
      [[10, 16], [24, 18], [38, 15]].forEach(([x, y]) => {
        g.appendChild(rect(x, y, 9, 7, '#e8dcc8'));
        g.appendChild(rect(x + 1, y + 2, 7, 1, '#6a5a50'));
        g.appendChild(rect(x + 1, y + 4, 5, 1, '#6a5a50'));
      });
    }
    if (sign >= 3) {
      neon(g, '*', 48, 3, PAL.neonYellow, '#a08a20');
      neon(g, 'MAHJONG', 58, 3, PAL.neonCyan, '#2080a0');
    }

    /* ミラーボールの紐（玉は drawActors が回す）。内装3から */
    if (lv >= 3) g.appendChild(rect(Math.min(FLOOR_W - 9, 110), 0, 1, 9, '#6a5a70'));

    /* スタンド花。**奥の壁に立てる。**床に置くと卓が3行になったとき
       客や卓の裏に隠れて、買った手応えが出ない（実際に隠れた）。
       看板とパネルとミラーボールを避けて、壁の右側に二基 */
    if (lv >= 4) {
      [FLOOR_W - 30, FLOOR_W - 15].forEach((fx) => {
        const fy = 17;
        g.appendChild(rect(fx + 3, fy + 8, 2, 12, '#e8dcc8'));
        g.appendChild(rect(fx, fy + 18, 8, 2, '#e8dcc8'));
        [[0, 0, '#ff9ec8'], [4, 1, '#ffe86e'], [2, 4, '#ff84a8'], [6, 5, '#96ffb4'],
         [1, 6, '#ffe86e']].forEach(([dx, dy, c]) => g.appendChild(rect(fx + dx, fy + dy, 2, 2, c)));
      });
    }

    /* 指名ランキングのパネル（金枠）。内装3から。
       宣伝が弱いうちは看板が無いので、パネルは看板の位置に寄せない */
    if (lv >= 3) {
      const px = 6, py = 16, pw = 40, ph = 15;
      g.appendChild(rect(px, py, pw, ph, PAL.gold));
      g.appendChild(rect(px + 1, py + 1, pw - 2, ph - 2, '#1c0c20'));
      const bars = [[PAL.neonYellow, 26], [PAL.neonCyan, 20], [PAL.neonGreen, 13]];
      bars.forEach((b, i) => g.appendChild(rect(px + 3, py + 4 + i * 4, b[1], 2, b[0])));
    }
  }

  /* 床。**内装1は板張り、2から §4.7 のカーペット**（§10） */
  function drawCarpet(g, parlor, pal) {
    const PAL = pal || PAL0;
    if ((parlor.interior | 0) < 2) {
      g.appendChild(rect(0, EDGE_Y, FLOOR_W, 2, '#6a5a4a'));
      g.appendChild(rect(0, CARPET_Y, FLOOR_W, FLOOR_H - CARPET_Y, PAL.plankA));
      /* 板の継ぎ目。**長い横板に見せる。**縦の継ぎ目を短い周期で入れると
         煉瓦に見えてしまうので、板一枚につき1本だけ、間隔を空けて置く */
      for (let y = CARPET_Y + 8, row = 0; y < FLOOR_H; y += 8, row++) {
        g.appendChild(rect(0, y, FLOOR_W, 1, PAL.plankSeam));
        /* 木目。板ごとに位置をずらす（時刻に依らない固定の並び） */
        for (let k = 0; k < 2; k++) {
          const x = (row * 37 + k * 79 + 11) % (FLOOR_W - 20) + 6;
          g.appendChild(rect(x, y - 5, 10, 1, PAL.plankGrain));
        }
        /* 板の継ぎ目（縦）。1行に1本だけ */
        const bx = (row * 53 + 17) % (FLOOR_W - 8) + 4;
        g.appendChild(rect(bx, y - 7, 1, Math.min(7, FLOOR_H - (y - 7)), PAL.plankSeam));
      }
      return;
    }
    g.appendChild(rect(0, EDGE_Y, FLOOR_W, 2, PAL.edge));
    g.appendChild(rect(0, CARPET_Y, FLOOR_W, FLOOR_H - CARPET_Y, PAL.carpetA));
    /* 4×4の市松（周期8） */
    for (let y = CARPET_Y; y < FLOOR_H; y += 4) {
      for (let x = 0; x < FLOOR_W; x += 4) {
        const on = (((x / 4) | 0) + (((y - CARPET_Y) / 4) | 0)) % 2 === 0;
        if (on) g.appendChild(rect(x, y, Math.min(4, FLOOR_W - x), Math.min(4, FLOOR_H - y), PAL.carpetB));
      }
    }
    /* 菱形の柄を周期8で散らす */
    for (let y = CARPET_Y + 6; y < FLOOR_H - 2; y += 8) {
      for (let x = 4; x < FLOOR_W - 2; x += 8) {
        g.appendChild(rect(x + 1, y, 2, 1, PAL.carpetPat));
        g.appendChild(rect(x, y + 1, 4, 1, PAL.carpetPat));
        g.appendChild(rect(x + 1, y + 2, 2, 1, PAL.carpetPat));
      }
    }
  }

  /* 卓。kind は 'normal' | 'mine' | 'call' | 'closed'。
     **見た目は AUTO の段階で変わる**（§10）。
       1 手積み … 木の縁。山が乱れていて、自動卓の穴が無い
       2 全自動卓 … 紫の縁と中央の穴
       3 点数表示付き … 縁に点数の小窓が4つ */
  function drawTable(g, t, kind, auto, pal) {
    const PAL = pal || PAL0;
    const x = t.x, y = t.y, lv = Math.max(1, auto | 0);
    if (kind === 'closed') {
      g.appendChild(rect(x, y, TABLE_W, TABLE_H, PAL.closed));
      g.appendChild(rect(x + 3, y + 3, TABLE_W - 6, TABLE_H - 6, PAL.closedTop));
      return;
    }
    const edge = kind === 'mine' ? PAL.tableMine : kind === 'call' ? PAL.tableCall
      : lv >= 2 ? PAL.tableEdge : PAL.tableWood;
    g.appendChild(rect(x, y, TABLE_W, TABLE_H, edge));
    /* ラシャ */
    g.appendChild(rect(x + 3, y + 3, TABLE_W - 6, 1, PAL.feltTop));
    g.appendChild(rect(x + 3, y + 4, TABLE_W - 6, TABLE_H - 8, PAL.felt));
    g.appendChild(rect(x + 3, y + TABLE_H - 4, TABLE_W - 6, 1, PAL.feltLow));
    /* 点棒箱まわり（卓上の小物） */
    g.appendChild(rect(x + 4, y + 5, 3, 2, '#ffb478'));
    g.appendChild(rect(x + 7, y + 5, 7, 2, PAL.gold));
    g.appendChild(rect(x + 17, y + 5, 6, 2, '#ffb4d2'));
    g.appendChild(rect(x + 23, y + 5, 3, 2, '#96f0ff'));
    /* 全自動卓の穴 */
    if (lv >= 2) g.appendChild(rect(x + 13, y + 8, 4, 3, PAL.feltLow));
    /* 点数表示の小窓 */
    if (lv >= 3) {
      for (let i = 0; i < 4; i++) {
        g.appendChild(rect(x + 5 + i * 6, y + 1, 5, 1, '#1c0c20'));
        g.appendChild(rect(x + 6 + i * 6, y + 1, 3, 1, PAL.neonCyan));
      }
    }
    /* 牌。手積みは山がそろっていない */
    for (let i = 0; i < 4; i++) {
      const tx = x + 4 + i * 6;
      const dy = lv >= 2 ? 0 : [0, 1, 0, 1][i];
      g.appendChild(rect(tx, y + 12 + dy, 4, 4, PAL.tile));
      g.appendChild(rect(tx, y + 16 + dy, 4, 1, PAL.tileLow));
    }
  }

  /* 床の設備。**置いてあるものを描く**（placement.md §4）。
     どれも足元のマスに収まる大きさで描き直してある（ソファ・カウンターは 24px 幅）。
     内装の段階との対応（spec.md §10）は normalize() が持つ：
       4 でソファ席、5 でドリンクカウンターが `floor.items` に入る */
  function drawFixtures(g, floor, parlor, pal) {
    const PAL = pal || PAL0;
    const lv = parlor.interior | 0;
    /* 入口のマット。内装1は素の板張りなので敷かない */
    if (lv >= 2) g.appendChild(rect(cellX(DOOR.x), FLOOR_H - 6, 32, 4, '#c86ab0'));

    itemsOf(floor, 'sofa').forEach((it) => {
      const sx = cellX(it.x), sy = cellY(it.y);
      g.appendChild(rect(sx, sy + 5, 24, 18, '#b8508e'));
      g.appendChild(rect(sx + 1, sy + 8, 10, 13, '#d46aa8'));
      g.appendChild(rect(sx + 13, sy + 8, 10, 13, '#d46aa8'));
    });

    itemsOf(floor, 'counter').forEach((it) => {
      const cx = cellX(it.x), cy = cellY(it.y);
      g.appendChild(rect(cx, cy + 3, 24, 20, PAL.panel));
      g.appendChild(rect(cx + 1, cy + 4, 22, 5, '#6e3c64'));
      const cols = ['#96f0ff', '#ff56b2', '#ffe86e', '#96ffb4'];
      cols.forEach((c, i) => g.appendChild(rect(cx + 2 + i * 5, cy + 11, 4, 4, c)));
      for (let i = 0; i < 4; i++) {
        g.appendChild(rect(cx + 2 + i * 5, cy + 17, 3, 5, i % 2 ? '#dcd0c0' : '#c8a44a'));
      }
    });

    /* 観葉植物（1×2マス）。花道コンボのための小物 */
    itemsOf(floor, 'plant').forEach((it) => {
      const px = cellX(it.x), py = cellY(it.y);
      g.appendChild(rect(px + 1, py + 10, 6, 5, '#a4603c'));
      g.appendChild(rect(px + 1, py + 9, 6, 1, '#c07850'));
      g.appendChild(rect(px + 3, py + 5, 2, 5, '#3c8450'));
      [[0, 3], [5, 3], [1, 1], [4, 0], [2, 4]].forEach(([dx, dy]) =>
        g.appendChild(rect(px + dx, py + dy, 3, 3, '#4aa464')));
    });
  }

  /* ============================================================
     スプライト
     ============================================================ */
  function guestColor(t) {
    const ink = G.INK;
    return (ch) => {
      switch (ch) {
        case '.': case ' ': return null;
        case 'h': return t.hair;
        case 'H': return t.hairDark;
        case 'c': return t.cloth;
        case 'C': return t.clothDark;
        case 'd': return t.decoColor;
        case 'D': return t.decoDark;
        default: return ink[ch] || null;
      }
    };
  }

  /* スタッフの体。ピンクの制服・金の襟と帯・両脇に手（§4.5 のB案） */
  const STAFF_BODY = [
    '.ttttttt.',
    'ottttttto',
    'occccccco',
    'socccccos',
    'occccccco',
    'ottttttto',
    '.ooooooo.',
  ];
  function staffColor(ch) {
    if (ch === '.') return null;
    if (ch === 'o') return PAL.ink;
    if (ch === 't') return PAL.staffTrim;
    if (ch === 'c') return PAL.staffCloth;
    if (ch === 's') return G.INK.s;
    return null;
  }

  /* 客カード用。スプライトを svg にして返す（等倍DOMの中に置く） */
  function spriteSvg(typeKey, px) {
    const t = G.BY_KEY[typeKey] || G.TYPES[0];
    const sv = el('svg', { viewBox: '0 0 12 17', width: 12 * px, height: 17 * px,
      'shape-rendering': 'crispEdges', 'aria-hidden': 'true' });
    shadowRects(SEAT_W).forEach((r) => { r.setAttribute('y', +r.getAttribute('y') + 16); sv.appendChild(r); });
    gridRects(G.grid(t.key, 0), guestColor(t)).forEach((r) => sv.appendChild(r));
    return sv;
  }

  /* ボトル勝負のダイアログ用。瓶を svg にして返す（§9） */
  function bottleSvg(tier, px) {
    const b = G.bottleOf(tier);
    const sv = el('svg', { viewBox: '0 0 8 14', width: 8 * px, height: 14 * px,
      'shape-rendering': 'crispEdges', 'aria-hidden': 'true' });
    const col = (ch) => ({ o: PAL.ink, c: b.col.cap, b: b.col.body, l: b.col.label, h: '#ffffff' }[ch] || null);
    gridRects(G.BOTTLE_SPRITE, col).forEach((r) => sv.appendChild(r));
    return sv;
  }

  /* タイムラインに後から差す（挑戦の割り込みなど）。時刻と種類の順を保つ */
  function insertEvent(timeline, e) {
    let i = 0;
    while (i < timeline.length && ((timeline[i].t - e.t) || (ORD[timeline[i].kind] - ORD[e.kind])) <= 0) i++;
    timeline.splice(i, 0, e);
    return timeline;
  }

  /* 足元の楕円影。床が明るいので全スプライトに敷く（§4.4） */
  function shadowRects(w) {
    return [rect(1, 0, w - 2, 1, PAL.shadow), rect(0, -1, w, 1, PAL.shadow)];
  }

  /* ============================================================
     組み立て — 演出層と表示層（spec.md §5.4）

     mount(host, opts) -> controller
       controller.render(state)                 静止画（第一段の見せ方）
       controller.play(timeline, hooks) -> Promise
         hooks.parlor / hooks.staff:[{id,name}]
         hooks.onInterrupt(node) -> Promise    割り込み（ask・実対局）
       controller.setSpeed(1|2|4) / controller.skip()

     再生層は乱数を一切引かない。歩く／入れ替わるはタイムラインの mode を
     読むだけ。常時アニメ（打牌・揺れ・ミラーボール・ネオン）は
     タイムライン秒だけから決める。ここに乱数を混ぜると
     スキップとの一致テストが崩れる。
     ============================================================ */
  const LEAVE_SEC = 1.0;       // 席から入口へ（×1）
  const POP_SEC = 1.3;         // 金額ポップの表示（実時間）
  const POP_MERGE = 0.5;       // 同じ卓のポップを束ねる窓（実時間）
  const SLOT_NAMES = ['昼', '夕', '夜'];
  const SLOT_HOURS = ['12〜17時', '17〜21時', '21〜26時'];
  const yen = (n) => Math.round(n).toLocaleString('ja-JP') + '円';

  /* スキップ釦を隠すか（monthly.md §13）。**純関数。**
     再生中だけ出す。**割り込み（ask・実対局）と客カードで止まっている間は消す。**
     ポップアップは画面ぜんぶを覆うので、その下に押せる釦を残してはいけない。
     残すと、自動で回すときクリックが覆いに吸われて、
     ページが固まったようにしか見えなくなる（実際に一度これを追いかけた） */
  function skipHidden(st) {
    st = st || {};
    return !st.playing || !!st.skipping || !!st.waiting || !!st.paused;
  }

  /* opts
       title  … 上の帯に出す店の名前（既定は自分の店）
       bare   … 速度・スキップの帯を作らない（遠征先の店。scout/spec.md §2.3）
       pal    … 壁・床・卓の色。**PAL への浅いマージ済みのもの**を渡す */
  function mount(host, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.className = 'jnFloor' + (opts.bare ? ' bare' : '');
    wrap.innerHTML =
      '<div class="jnFlTop"><span class="jnFlName"></span>' +
      '<span class="jnFlDay"></span></div>' +
      (opts.bare ? '' :
      '<div class="jnFlBar"><span class="jnFlSlot"></span>' +
      '<span class="jnFlTrack"><span class="jnFlFill"></span></span>' +
      '<span class="jnFlSales"></span><span class="jnFlSpeed">' +
      [1, 2, 4].map((v) => '<button type="button" class="jnFlSp" data-speed="' + v + '">×' + v + '</button>').join('') +
      '<button type="button" class="jnFlSp skip" data-skip="1" hidden>スキップ</button></span></div>') +
      '<div class="jnFlStage"><div class="jnFlUi"></div><div class="jnFlHits"></div>' +
      '<button type="button" class="jnFlPan left" data-pan="-1" aria-label="左を見る" hidden></button>' +
      '<button type="button" class="jnFlPan right" data-pan="1" aria-label="右を見る" hidden></button></div>' +
      '<div class="jnFlEdit" hidden></div>' +
      '<div class="jnFlTicker"></div>';
    host.appendChild(wrap);
    /* **名前は textContent で入れる。**店の名前は生成物なので、
       innerHTML に混ぜると生成の仕方を変えたときに壊れる */
    wrap.querySelector('.jnFlName').textContent =
      opts.title || 'ガールズ雀荘 〜雀ドル亭〜';
    /* 部屋の色。差し替えないなら PAL のまま */
    const pal = opts.pal || PAL0;

    const stage = wrap.querySelector('.jnFlStage');
    const ui = wrap.querySelector('.jnFlUi');
    const hits = wrap.querySelector('.jnFlHits');
    const hitEls = new Map();      // guestId:seat -> div。作り直さず位置だけ動かす
    const panL = wrap.querySelector('.jnFlPan.left');
    const panR = wrap.querySelector('.jnFlPan.right');
    let svg = null, roomG = null, lightG = null, actG = null, defs = null;
    let scale = 3, floorW = FLOOR_W;
    let panX = null;               // 見えている左端（floor px）。null は「まだ決めていない」
    let tables = [];
    let floor = null;              // 置いてあるもの（parlor.floor）
    let editG = null;              // 模様替えのマス目・選択枠・置き先の見当
    const editBar = wrap.querySelector('.jnFlEdit');
    /* 模様替え（placement.md §7）。sel は選んでいるものの id、
       ghost は「いまタップ／指を離したらここに置く」の見当 */
    const edit = {
      on: false, sel: null, ghost: null, drag: null, arm: null, hooks: {}, note: '',
    };
    let parlor = {};
    let staffList = [];
    const made = {};

    /* **フロア座標→画面座標はここだけ。** UI層は全部これを通す（§8）。
       横送り（placement.md §3）もここに乗せる。**単位は floor px** なので
       画面では倍率の整数倍だけ動き、ニアレストネイバーが崩れない */
    function floorToScreen(fx, fy) { return { x: (fx - panX) * scale, y: fy * scale }; }
    function screenToFloor(px, py) { return { x: px / scale + panX, y: py / scale }; }

    const panMax = () => Math.max(0, FLOOR_W - floorW);
    function clampPan() {
      const max = panMax();
      if (panX == null) panX = Math.round(max / 2);      // 既定は中央
      panX = Math.max(0, Math.min(max, Math.round(panX)));
    }
    function applyPan() {
      if (svg) svg.style.left = (-panX * scale) + 'px';
      const max = panMax();
      /* 隠れているのがほぼ余白だけなら、横送りの矢印は出さない（つまんで動かすのは効く） */
      const show = edit.on ? max > 0 : max > GX0 * 2 + 4;
      panL.hidden = !show; panR.hidden = !show;
      panL.disabled = panX <= 0; panR.disabled = panX >= max;
    }

    function measure() {
      /* **測るのは mount に渡された枠。** wrap は width:max-content なので、
         そこを測ると中身が決まる前の幅（ほぼ0）を拾ってしまう */
      /* **画面から外れていると host.parentNode が null になる。**
         `shell.html` の `go()` は `#view` を空にするだけで後始末の口が無いので、
         外れたあとにも resize が飛んでくる（実際にここで落ちた） */
      const availW = Math.max(160,
        (host.clientWidth || (host.parentNode && host.parentNode.clientWidth) || 360) - 6);
      const f = fit(availW);
      scale = f.scale; floorW = f.floorW;
      stage.style.width = (floorW * scale) + 'px';
      stage.style.height = (FLOOR_H * scale) + 'px';
      clampPan();
    }

    /* ---------- 再生の状態 ----------
       seated  … guestId -> {typeKey, count, seats:[{table,seat}]}
       walkers … 入口から席へ。leavers … 席から入口へ
       staff   … charaId -> {x,y,tx,ty,t0}（floor px） */
    const live = {
      playing: false, clock: 0, real: 0, idx: 0, speed: 1, skipping: false,
      seated: new Map(), walkers: [], leavers: [], pops: [], flashes: [],
      staff: new Map(), hearts: new Set(),
      slot: -1, sales: 0, extra: 0, ticker: '', full: false, dayNo: 0, headNote: '',
      visitor: null, highlight: null, paused: false, queue: [],
    };
    function resetLive() {
      live.clock = 0; live.real = 0; live.idx = 0; live.skipping = false;
      live.seated = new Map(); live.walkers = []; live.leavers = []; live.pops = []; live.flashes = [];
      live.staff = new Map(); live.hearts = new Set();
      live.slot = -1; live.sales = 0; live.extra = 0; live.ticker = ''; live.full = false;
      live.visitor = null; live.highlight = null; live.paused = false; live.queue = [];
      hitEls.forEach((d) => d.remove()); hitEls.clear();
    }

    /* 入口。**論理フロアの固定位置**（入口のマスの中）。窓の幅では動かない */
    function entrance() { return { x: cellX(DOOR.x) + 10, y: FLOOR_H - 20 }; }
    /* 席の描画位置。詰まった配置では上の2席が無いので null（描かない） */
    function seatPos(table, seat) {
      const t = tables[table];
      if (!t) return null;
      return seatsOf(t)[seat] || null;
    }
    /* いま埋まっている席（座っている客＋向かっている客） */
    function takenSeats() {
      const set = new Set();
      live.seated.forEach((g) => g.seats.forEach((s) => set.add(s.table + ':' + s.seat)));
      live.walkers.forEach((w) => (w.seats || []).forEach((s) => set.add(s.table + ':' + s.seat)));
      return set;
    }
    /* スタッフの立ち位置。**空いている席に立つ**（モックの見せ方）。
       客の上に立たないように、他のスタッフが居る席も避ける。
       全部埋まっていたら卓の手前に立つ */
    function staffSpotFor(table, selfId) {
      if (!tables.length) return entrance();
      const home = Math.max(0, Math.min(tables.length - 1, table | 0));
      const taken = takenSeats();
      live.staff.forEach((s, id) => { if (id !== selfId && s.at) taken.add(s.at); });

      /* 目当ての卓 → 近い卓の順に、空いている席を探す */
      const order = tables.map((_, i) => i).sort((a, b) => Math.abs(a - home) - Math.abs(b - home));
      for (const ti of order) {
        if (tables[ti].kind === 'closed') continue;
        const ss = seatsOf(tables[ti]);
        for (let i = 0; i < ss.length; i++) {
          if (!taken.has(ti + ':' + i)) return { x: ss[i].x + 1, y: ss[i].y + 9, at: ti + ':' + i };
        }
      }
      /* **どこも埋まっていたら卓のまわりの空いているマスへ**（placement.md §1.3）。
         ここで同じ場所に重ねない。丸写真が重なると誰が誰だか分からなくなる
         （実際に4人重なった）。詰めて置くとスタッフが入口に溜まる */
      for (const ti of order) {
        for (const c of ringCells(floor, tables[ti])) {
          const key = 'c:' + c.x + ':' + c.y;
          if (!taken.has(key)) return { x: cellX(c.x), y: cellY(c.y) + 1, at: key };
        }
      }
      /* それでも空きが無ければ入口のわき。床の下端に置くと店の隅に取り残されて見える */
      const door = entrance();
      for (let i = 0; i < 6; i++) {
        const key = 'door:' + i;
        if (!taken.has(key)) {
          return { x: Math.max(2, Math.min(FLOOR_W - 12, door.x - 30 + i * 12)), y: door.y, at: key };
        }
      }
      return { x: door.x, y: door.y, at: null };
    }
    function moveStaff(id, table) {
      const s = live.staff.get(id);
      if (!s) return;
      const to = staffSpotFor(table, id);
      s.fx = s.x; s.fy = s.y; s.tx = to.x; s.ty = to.y; s.t0 = live.clock; s.at = to.at; s.table = table;
      if (live.skipping) { s.x = to.x; s.y = to.y; s.t0 = -9; }
    }
    /* 客が来た席に立っていたスタッフは脇へどく */
    function yieldSeats(seats) {
      const keys = new Set(seats.map((x) => x.table + ':' + x.seat));
      live.staff.forEach((s, id) => { if (s.at && keys.has(s.at)) moveStaff(id, s.table); });
    }

    /* ---------- 部屋（静的） ---------- */
    function buildRoom() {
      measure();
      if (svg) svg.remove();
      for (const k in made) delete made[k];
      /* **描くのは常に論理フロアの 200×164。** 窓が狭いときは横に送って見る
         （placement.md §3）。ここで幅を変えると、端末ごとに絵が変わってしまう */
      svg = el('svg', {
        class: 'jnFlPix', viewBox: '0 0 ' + FLOOR_W + ' ' + FLOOR_H,
        width: FLOOR_W * scale, height: FLOOR_H * scale,
        'shape-rendering': 'crispEdges', 'aria-hidden': 'true',
      });
      defs = el('defs', {});
      svg.appendChild(defs);
      roomG = el('g', {}); lightG = el('g', {}); actG = el('g', {}); editG = el('g', {});
      svg.appendChild(roomG); svg.appendChild(actG); svg.appendChild(lightG); svg.appendChild(editG);

      /* 編集中は手元の floor（動かしている途中のもの）をそのまま描く。
         突き合わせを通すと、置いた場所が勝手に直されてしまう */
      if (!edit.on || !floor) {
        floor = reconcile(parlor.floor, { tables: parlor.tables || 2, interior: parlor.interior });
      }
      drawWall(roomG, parlor, pal);
      drawCarpet(roomG, parlor, pal);
      drawFixtures(roomG, floor, parlor, pal);
      tables = tablesOf(floor);
      const closed = live.closedTables || 0;
      tables.forEach((t, i) => {
        t.kind = !edit.on && i >= tables.length - closed ? 'closed'
          : (edit.on ? floor.mine === t.id : i === live.myTable) ? 'mine' : 'normal';
        drawTable(roomG, t, t.kind, parlor.auto, pal);
      });
      /* スタッフの体は一つの <g> を使い回す */
      const gg = el('g', { id: 'jns-body' });
      gridRects(STAFF_BODY, staffColor).forEach((r) => gg.appendChild(r));
      defs.appendChild(gg);
      stage.insertBefore(svg, ui);
      applyPan();
    }

    /* `sex` は遠征先の店だけが渡す（`scout/spec.md` §4.4）。
       **キャッシュの鍵に混ぜること**——混ぜないと男女で同じ絵が出る */
    function guestDef(typeKey, frame, sex) {
      const id = 'jnc-' + typeKey + '-' + frame + (sex ? '-' + sex : '');
      if (!made[id]) {
        const t = G.BY_KEY[typeKey];
        const gg = el('g', { id });
        gridRects(G.grid(typeKey, frame, sex), guestColor(t)).forEach((r) => gg.appendChild(r));
        defs.appendChild(gg);
        made[id] = true;
      }
      return '#' + id;
    }
    function putGuest(typeKey, x, y, frame, sex) {
      const sh = el('g', { transform: 'translate(' + Math.round(x) + ',' + (Math.round(y) + SEAT_H) + ')' });
      shadowRects(SEAT_W).forEach((r) => sh.appendChild(r));
      actG.appendChild(sh);
      actG.appendChild(el('use', { href: guestDef(typeKey, frame, sex), x: Math.round(x), y: Math.round(y) }));
    }

    /* ---------- 照明（帯で変わる。§4.3「ピンクを差す」） ---------- */
    function drawLight() {
      while (lightG.firstChild) lightG.removeChild(lightG.firstChild);
      /* **灯りの色も部屋のもの。**壁と卓を差し替えたのに灯りがピンクのままだと、
         どの型の店も一目では同じに見える（実際そう見えた） */
      if (live.slot === 1) {
        lightG.appendChild(el('rect', { x: 0, y: CARPET_Y, width: FLOOR_W, height: FLOOR_H - CARPET_Y,
          fill: '#ffb478', opacity: 0.07 }));
      } else if (live.slot === 2) {
        lightG.appendChild(el('rect', { x: 0, y: CARPET_Y, width: FLOOR_W, height: FLOOR_H - CARPET_Y,
          fill: pal.night, opacity: 0.16 }));
        tables.forEach((t) => {
          if (t.kind === 'closed') return;
          lightG.appendChild(el('rect', { x: t.x - 6, y: t.y - 6, width: TABLE_W + 12, height: TABLE_H + 12,
            fill: pal.lamp, opacity: 0.10 }));
        });
      }
      /* タップした客の枠（customer-card.png の黄色い枠） */
      if (live.highlight) {
        const g = live.seated.get(live.highlight);
        const p = g && seatPos(g.seats[0].table, g.seats[0].seat);
        if (p) {
          lightG.appendChild(el('rect', { x: p.x - 1, y: p.y - 1, width: SEAT_W + 2, height: SEAT_H + 2,
            fill: 'none', stroke: PAL.tableCall, 'stroke-width': 1 }));
        }
      }
      /* 席の入れ替わりの光（swap） */
      live.flashes.forEach((f) => {
        lightG.appendChild(el('rect', { x: f.x, y: f.y, width: SEAT_W, height: SEAT_H,
          fill: '#ffffff', opacity: 0.35 * (1 - f.p) }));
      });
    }

    /* ---------- 癖（`scout/spec.md` §4.5。遠征先の店だけ） ----------
       **スプライトの箱の外へ出す。**最初は 12×16 の中に 1〜3ドットの印を
       置いていたが、**店に20人ばらばらに座っていると見つけられなかった**
       （並べて比べれば違うが、探す状況ではまるで効かない）。
       離れて効くのは**シルエットが崩れているかどうか**なので、
       頭の上に浮かべるか、体の横・足元に輪郭からはみ出す大きさで置く。

       系統は二つのまま。**`beat` は頭の上の印、`mark` は体まわりの物。**
       雀ドルは両方付き、ただの客はどちらか一つ。
       **遠目に「二つ付いている子」を探す**のがこの画面でやること。

       描くのは `live.clock` の位相だけから（乱数を混ぜない）が、
       **動きに判別を担わせない。**動くのは飾りで、効くのは形と色。

       色は `PAL`（＝ PAL0）から。**`pal` を使わない**——
       店の型で印の色まで変わると、型をまたいで癖を覚えられない。 */
    const BEAT_DEFAULT = 1.6;      // 既定の打牌。3拍に1回なので周期は約1.9秒
    const BEAT_FAST = 6.7;         // 手が速い。同じ勘定で約0.45秒

    /* 手の上がりかた。**`fast` は上がりっぱなし**（頭の上の速度線と対で読む） */
    function beatFrame(quirk, c, ph) {
      const has = (k) => quirk && quirk.indexOf(k) >= 0;
      if (has('still')) return 0;
      if (has('fast')) return 1;                       // 上げたまま
      if (has('slow')) return 0;
      return (Math.floor(c * BEAT_DEFAULT + ph) % 3) === 0 ? 1 : 0;
    }

    /* 頭の上の印（`beat`）。**箱の上に出す**ので、行は負の値になる。

       **三つとも暗い縁で浮かせる**（`outlined`）。床は型ごとに変わるが
       どれも中間の明るさ（板張り #a89478 / リノリウム #8e8a80 /
       カーペット #d4c6b2 / 寄木 #b8a07a）なので、**明るい色だけでは
       床に溶ける型が出る**——`still` の灰色が場末の店で危なかった。
       縁を付ければ、どの床でも同じ見た目のまま浮く。

       **型ごとに色を変えないこと。**変えると店を移るたびに覚え直しになる。 */
    function drawBeatSign(quirk, p, c, ph) {
      const x = Math.round(p.x), y = Math.round(p.y);
      const has = (k) => quirk.indexOf(k) >= 0;
      if (has('fast')) {
        /* 速度線2本。シアン。少し左右に揺れる（飾り） */
        const w = (Math.floor(c * 4 + ph) % 2) ? 1 : 0;
        outlined(x + 1 + w, y - 7, 8, 2, PAL.neonCyan);
        outlined(x + 3 + w, y - 4, 8, 2, PAL.neonCyan);
      }
      if (has('slow')) {
        /* 縦に三点（…）。黄。**三つとも必ず描く。**
           以前は下から順に灯していたが、**瞬間によっては1点しか出ず**、
           小さな黄色い点ひとつになって見落とした（場末の店で実際に危なかった）。
           形が変わる動きは「飾り」ではない——動かすのは色の明るさだけ */
        const lit = Math.floor(c * 1.6 + ph) % 3;
        for (let i = 0; i < 3; i++) {
          outlined(x + 5, y - 4 - i * 3, 2, 2, i === lit ? PAL.goldHi : PAL.neonYellow);
        }
      }
      if (has('still')) {
        /* 横一本の長い線（凪）。動かない。
           **灰色ではなくピンク。**灰は場末の店（灰色の床）で埋もれる。
           シアン・黄と色相がいちばん離れているのがこれ */
        outlined(x, y - 5, 12, 2, PAL.neonPink);
      }
    }

    /* 体まわりの物（`mark`）。**箱からはみ出す大きさで置く**

       **細い線にしないこと。**最初は 1ドット幅の棒にしていたが、
       客の持ち物（`DECO` の 瓶・本・マイク・鞄）が同じ列に同じ細さで
       描かれていて、**印として立たなかった**（実機の全景で見つけられなかった）。

       だから二つ守る。
         ・**2ドット以上の太さ**にする
         ・**暗い縁で浮かせる**（`outlined`）。床の色が店の型で変わっても、
           縁があれば必ず背景から分離する */
    function outlined(x, y, w, h, fill) {
      actG.appendChild(rect(x - 1, y - 1, w + 2, h + 2, PAL.ink));
      actG.appendChild(rect(x, y, w, h, fill));
    }

    function drawMark(quirk, p, c, ph) {
      const x = Math.round(p.x), y = Math.round(p.y);
      const has = (k) => quirk.indexOf(k) >= 0;
      if (has('bou')) {
        /* 立直棒が立っている。席の右に**2ドット幅で8ドット**。上端が赤 */
        outlined(x + 13, y + 3, 2, 8, PAL.tile);
        actG.appendChild(rect(x + 13, y + 3, 2, 2, PAL.felt));
      }
      if (has('meld')) {
        /* 晒し牌の塊。体の右下に**5×4**で張り出す。時々1枚増える */
        const more = (Math.floor(c * 0.5 + ph) % 4) === 0 ? 1 : 0;
        outlined(x + 12, y + 8, 5 + more, 4, PAL.tile);
        actG.appendChild(rect(x + 12, y + 10, 5 + more, 2, PAL.tileLow));
      }
      if (has('guard')) {
        /* 河が横に長い。足元に**13ドット×3**の列。ゆっくり伸び縮みする（飾り） */
        const n = 11 + (Math.floor(c * 0.8 + ph) % 3);
        outlined(x - 1, y + SEAT_H, n, 3, PAL.tile);
        actG.appendChild(rect(x - 1, y + SEAT_H + 1, n, 2, PAL.tileLow));
      }
    }

    /* ---------- 役者（毎フレーム組み直す） ---------- */
    function drawActors() {
      while (actG.firstChild) actG.removeChild(actG.firstChild);
      const c = live.clock;

      /* 座っている客。席番号を位相にして打牌の手を動かす（時刻だけから）。
         `g.quirk` があれば癖で振りかたが変わり、印が足される
         （遠征先の店だけ。`scout/spec.md` §4.4） */
      live.seated.forEach((g) => {
        g.seats.forEach((s, j) => {
          const p = seatPos(s.table, s.seat);
          if (!p) return;
          const ph = (s.table * 4 + s.seat) * 0.7;
          const q = g.quirk;
          const frame = beatFrame(q, c, ph);
          putGuest(g.look || g.typeKey, p.x, p.y, frame, g.sex);
          /* **物を先、頭の印をあと**。物は体に隠れてよいが、
             頭の印は何にも隠れてはいけない（遠目に効くのはこちら） */
          if (q) { drawMark(q, p, c, ph); drawBeatSign(q, p, c, ph); }
        });
      });
      /* 歩いている客（入る／出る）。足は進み具合から */
      const walk = (w, to) => {
        const p = Math.min(1, (c - w.t0) / w.dur);
        const x = w.from.x + (w.to.x - w.from.x) * p, y = w.from.y + (w.to.y - w.from.y) * p;
        const frame = Math.floor(p * 6) % 2;
        for (let j = 0; j < Math.min(w.count, 4); j++) putGuest(w.typeKey, x - j * 6, y + j * 2, frame);
      };
      live.walkers.forEach((w) => walk(w));
      live.leavers.forEach((w) => walk(w));
      /* 入口の待ち客。次に来る swap を最大2人まで見せる（§5.4） */
      const door = entrance();
      live.queue.forEach((q, i) => putGuest(q.typeKey, door.x + 14 + i * 9, door.y + 2, 0));
      /* 帳簿に載らない来訪者（荒らし）。入口の脇に立つ */
      if (live.visitor) putGuest(live.visitor.typeKey, door.x - 18, door.y - 2, Math.floor(c * 2) % 2);

      /* スタッフの体。接客中は体を揺らす（時刻だけから） */
      live.staff.forEach((s, id) => {
        const p = Math.min(1, (c - s.t0) / 1.0);
        s.x = s.fx + (s.tx - s.fx) * p; s.y = s.fy + (s.ty - s.fy) * p;
        const bob = p >= 1 && !s.leaving ? (Math.floor(c * 2 + id) % 2) : 0;
        const sh = el('g', { transform: 'translate(' + Math.round(s.x) + ',' + (Math.round(s.y) + 7) + ')' });
        shadowRects(9).forEach((r) => sh.appendChild(r));
        actG.appendChild(sh);
        actG.appendChild(el('use', { href: '#jns-body', x: Math.round(s.x), y: Math.round(s.y) - bob }));
        if (live.hearts.has(id)) {
          HEART.forEach((line, y) => {
            for (let x = 0; x < line.length; x++) {
              if (line[x] === '#') actG.appendChild(rect(Math.round(s.x) + 8 + x, Math.round(s.y) - 13 + y, 1, 1, PAL.neonPink));
            }
          });
        }
      });
      /* ミラーボールは回る（内装3から） */
      if ((parlor.interior | 0) >= 3) {
        const cx = Math.min(FLOOR_W - 9, 110), cy = 14, ph = Math.floor(c * 4) % 2;
        for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) {
          if (Math.abs(x) + Math.abs(y) > 4) continue;
          if ((x + y + ph) % 2 === 0) actG.appendChild(rect(cx + x, cy + y, 1, 1, '#ffffff'));
        }
      }
    }

    /* ---------- UI層 ---------- */
    function drawUi() {
      wrap.querySelector('.jnFlDay').textContent = live.headNote ||
        ((live.dayNo || 0) + '日目・' + (live.slot >= 0 ? SLOT_NAMES[live.slot] + '営業中' : '準備中'));
      /* 速度・スキップの帯は `bare`（遠征先の店）では作っていない。
         **無ければ触らない。**querySelector が null を返す */
      if (!opts.bare) {
        const starts = slotStartTimes();
        const slotLabel = live.slot >= 0
          ? SLOT_NAMES[live.slot] + ' <i>' + SLOT_HOURS[live.slot] + '</i>' : '開店前';
        wrap.querySelector('.jnFlSlot').innerHTML = slotLabel;
        const prog = live.slot >= 0 ? Math.min(1, (live.clock - starts[live.slot]) / SLOT_SEC[live.slot]) : 0;
        wrap.querySelector('.jnFlFill').style.width = Math.round(prog * 100) + '%';
        wrap.querySelector('.jnFlSales').innerHTML =
          '本日 <b>' + yen(live.sales) + '</b>' + (live.extra ? '<i>＋臨時 ' + yen(live.extra) + '</i>' : '');
        /* **ボタンは作り直さない。** 毎フレーム innerHTML で作り直すと、
           押した瞬間に要素が入れ替わって取りこぼす（実際に押せなかった） */
        wrap.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', +b.dataset.speed === live.speed));
        wrap.querySelector('[data-skip]').hidden = skipHidden(
          { playing: live.playing, skipping: live.skipping, waiting, paused: live.paused });
      }
      wrap.querySelector('.jnFlTicker').textContent = live.ticker || '';

      ui.innerHTML = '';
      const d = Math.round(11 * scale);          // 頭の直径。11 floor px（§4.5）
      /* 名前札は**三度に分けて置く**。作る → まとめて測る → まとめて置く。
         測るのを一度にまとめないと、要素ごとに版が組み直る（14人ぶんで14回）。
         **幅は覚えない。**丸ゴシックが届く前に測った値を覚えてしまうと、
         代替書体の幅のまま残って重なりの判定が外れる（実際にこれで一組重なった） */
      const tags = [];
      live.staff.forEach((s, id) => {
        const info = staffList.find((c) => c.id === id) || { name: '' };
        const p = floorToScreen(s.x + 4.5, s.y - 1);
        const head = document.createElement('div');
        head.className = 'jnFlHead';
        head.style.left = Math.round(p.x - d / 2) + 'px';
        head.style.top = Math.round(p.y - d) + 'px';
        head.style.width = head.style.height = d + 'px';
        head.innerHTML = '<img src="img/' + String(id).padStart(3, '0') + '.webp" alt="" onerror="this.remove()">';
        ui.appendChild(head);
        const tag = document.createElement('span');
        tag.className = 'jnFlTag';
        tag.textContent = info.name;
        ui.appendChild(tag);
        tags.push({ tag, x: p.x, y0: Math.round(p.y + 7 * scale) });
      });
      tags.forEach((o) => { o.w = o.tag.offsetWidth; o.h = o.tag.offsetHeight || 16; });
      /* **重なったら段を下げる。**立ち位置（staffSpotFor）は必ずばらけるが、
         札は席の間隔より広いので、14人出勤すると隣の席の子と字が重なって
         読めなくなる（実際に重なった）。丸写真は動かさない。
         **動かすのは札だけ**なので、誰の札かは真上の写真で分かる。
         幅は `transform:translateX(-50%)` で効くので、端に寄せる量にも要る
         （決め打ちの28pxだと、長い名前が枠からはみ出て頭を欠く） */
      const put = [];
      tags.forEach((o) => {
        const half = Math.min(o.w / 2 + 1, floorW * scale / 2);
        const cx = Math.min(Math.floor(floorW * scale - half),
                            Math.max(Math.ceil(half), Math.round(o.x)));
        const a = cx - o.w / 2, b = cx + o.w / 2;
        let top = o.y0;
        for (let lane = 1; lane <= 6 && put.some((q) =>
          top < q.top + q.h && q.top < top + o.h && q.a < b && a < q.b); lane++) {
          top = o.y0 + lane * (o.h + 1);
        }
        put.push({ a, b, top, h: o.h });
        o.tag.style.left = cx + 'px';
        o.tag.style.top = top + 'px';
      });
      if (live.full) {
        const t = tables[0];
        if (t) {
          const p = floorToScreen(t.x - 10, t.y - 20);
          const b = document.createElement('span');
          b.className = 'jnFlFull'; b.textContent = '満卓';
          b.style.left = Math.max(2, Math.round(p.x)) + 'px';
          b.style.top = Math.max(2, Math.round(p.y)) + 'px';
          ui.appendChild(b);
        }
      }
      live.pops.forEach((pp) => {
        const t = tables[pp.table];
        const base = t ? { x: t.x + TABLE_W / 2, y: t.y - 4 } : entrance();
        const age = live.real - pp.t0;
        const p = floorToScreen(base.x, base.y - age * 6);
        const b = document.createElement('span');
        b.className = 'jnFlPop' + (pp.label ? ' bonus' : '');
        b.textContent = (pp.label ? pp.label + ' ' : '') + '+' + yen(pp.amount) + (pp.count > 1 ? ' ×' + pp.count : '');
        b.style.left = Math.round(p.x) + 'px';
        b.style.top = Math.round(p.y) + 'px';
        b.style.opacity = String(Math.max(0, 1 - Math.max(0, age - POP_SEC * 0.6) / (POP_SEC * 0.4)));
        ui.appendChild(b);
      });
    }

    /* 当たり判定。客ごとに透明なボタンを置き、位置だけ更新する。
       毎フレーム作り直すと押した瞬間に消えて取りこぼす（速度ボタンで実際に起きた） */
    function drawHits() {
      const keep = new Set();
      live.seated.forEach((g, id) => {
        g.seats.forEach((s, j) => {
          const p = seatPos(s.table, s.seat);
          if (!p) return;
          const key = id + ':' + j;
          keep.add(key);
          let d = hitEls.get(key);
          if (!d) {
            d = document.createElement('button');
            d.type = 'button'; d.className = 'jnFlHit'; d.dataset.guest = id;
            d.setAttribute('aria-label', '客を見る');
            hits.appendChild(d); hitEls.set(key, d);
          }
          const q = floorToScreen(p.x, p.y);
          d.style.left = Math.round(q.x) + 'px'; d.style.top = Math.round(q.y) + 'px';
          d.style.width = (SEAT_W * scale) + 'px'; d.style.height = (SEAT_H * scale) + 'px';
        });
      });
      hitEls.forEach((d, key) => { if (!keep.has(key)) { d.remove(); hitEls.delete(key); } });
    }

    /* ============================================================
       模様替え（placement.md §7）
       ・触りかた … ものをつまんで動かす／タップして選び、床をタップして動かす
       ・**置ける場所は置く前に見せる**（緑＝置ける／赤＝置けない）
       ・撤去は二度押し。一度目で「本当に撤去する」に変わる
       ============================================================ */
    function editFrame(g, x, y, w, h, color, inset) {
      const i = inset || 0;
      g.appendChild(rect(x + i, y + i, w - i * 2, 1, color));
      g.appendChild(rect(x + i, y + h - i - 1, w - i * 2, 1, color));
      g.appendChild(rect(x + i, y + i, 1, h - i * 2, color));
      g.appendChild(rect(x + w - i - 1, y + i, 1, h - i * 2, color));
    }
    function cellRect(it) {
      const s = KINDS[it.kind];
      return { x: cellX(it.x), y: cellY(it.y), w: s.w * GRID, h: s.h * GRID };
    }
    function drawEditLayer() {
      while (editG.firstChild) editG.removeChild(editG.firstChild);
      /* 空いているマスに点を打つ。**置ける場所が一目で分かる** */
      for (let gy = 0; gy < ROWS; gy++) {
        for (let gx = 0; gx < COLS; gx++) {
          if (!freeCell(floor, gx, gy)) continue;
          editG.appendChild(rect(cellX(gx) + 3, cellY(gy) + 3, 2, 2, '#9a8874'));
        }
      }
      /* 卓の足元は「卓＋席4つ」。**席の場所を薄く出す。**
         これが無いと、卓より大きな枠が何のためのものか分からない */
      tablesOf(floor).forEach((t) => {
        seatsOf(t).forEach((st) => {
          editG.appendChild(el('rect', { x: st.x, y: st.y, width: SEAT_W, height: SEAT_H,
            fill: '#ffffff', opacity: '0.10' }));
          editFrame(editG, st.x, st.y, SEAT_W, SEAT_H, '#6a5a50');
        });
      });
      /* 入口は動かせないし、上にも置けない */
      const dr = cellRect(DOOR);
      editG.appendChild(el('rect', { x: dr.x, y: dr.y, width: dr.w, height: dr.h,
        fill: PAL.neonPink, opacity: '0.18' }));
      editFrame(editG, dr.x, dr.y, dr.w, dr.h, '#c86ab0');
      /* **コンボが成立している卓は薄く塗る**（placement.md §5）。
         効果が見えないと、配置を工夫する気にならない */
      const cb = combos(floor);
      tablesOf(floor).forEach((t) => {
        if (!(cb.byId[t.id] || []).length) return;
        const it = floor.items.find((o) => o.id === t.id);
        const r = cellRect(it);
        editG.appendChild(el('rect', { x: r.x, y: r.y, width: r.w, height: r.h,
          fill: PAL.neonGreen, opacity: '0.10' }));
      });
      /* 選んでいるもの */
      const sel = edit.sel != null && floor.items.find((it) => it.id === edit.sel);
      if (sel) {
        const r = cellRect(sel);
        editFrame(editG, r.x, r.y, r.w, r.h, PAL.gold);
        editFrame(editG, r.x, r.y, r.w, r.h, PAL.gold, 2);
      }
      /* 置き先の見当。**緑なら置ける、赤なら置けない** */
      if (edit.ghost) {
        const s = KINDS[edit.ghost.kind];
        const x = cellX(edit.ghost.x), y = cellY(edit.ghost.y);
        const w = s.w * GRID, h = s.h * GRID;
        const c = !edit.ghost.ok ? '#ff6a72' : edit.ghost.swap ? PAL.neonCyan : '#96ffb4';
        editG.appendChild(el('rect', { x, y, width: w, height: h, fill: c, opacity: '0.3' }));
        editFrame(editG, x, y, w, h, c);
        editFrame(editG, x, y, w, h, c, 1);
      }
    }

    /* コンボの札（UI層。ドットの世界に日本語を置くと潰れる。spec.md §4.2） */
    function drawEditTags() {
      const cb = combos(floor);
      const put = (fx, fy, text) => {
        const p = floorToScreen(fx, fy);
        const b = document.createElement('span');
        b.className = 'jnFlCombo';
        b.textContent = text;
        b.style.left = Math.max(1, Math.min(floorW * scale - 8, Math.round(p.x))) + 'px';
        b.style.top = Math.round(p.y) + 'px';
        ui.appendChild(b);
      };
      tablesOf(floor).forEach((t) => {
        const keys = cb.byId[t.id] || [];
        if (!keys.length) return;
        const it = floor.items.find((o) => o.id === t.id);
        put(cellX(it.x) + 1, cellY(it.y), keys.map((k) => COMBO_BY_KEY[k].name).join('・'));
      });
      if (cb.lounge) {
        const c = itemsOf(floor, 'counter')[0];
        if (c) put(cellX(c.x), cellY(c.y), COMBO_BY_KEY.lounge.name);
      }
    }

    const esc = (t) => String(t).replace(/[&<>"']/g,
      (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

    function selItem() {
      return edit.sel != null ? floor.items.find((it) => it.id === edit.sel) || null : null;
    }
    function btn(act, label, note, cls, off) {
      return '<button type="button" class="jnFlEb' + (cls ? ' ' + cls : '') + '" data-act="' + act + '"' +
        (off ? ' disabled' : '') + '><b>' + esc(label) + '</b>' +
        (note ? '<i>' + esc(note) + '</i>' : '') + '</button>';
    }
    function renderEditBar() {
      if (!edit.on) { editBar.hidden = true; editBar.innerHTML = ''; return; }
      editBar.hidden = false;
      const h = edit.hooks;
      const it = selItem();
      const money = h.money ? h.money() : 0;
      let row = '';
      if (it) {
        const name = KINDS[it.kind].name;
        const canSell = h.canSell ? h.canSell(it.kind) : false;
        const back = h.refundOf ? h.refundOf(it.kind) : 0;
        if (it.kind === 'table') {
          row += btn('mine', floor.mine === it.id ? '自分の卓をやめる' : '自分の卓にする',
            '夜、代表が着く卓', floor.mine === it.id ? 'on' : '');
        }
        if (edit.arm === it.id) {
          /* **「やめる」を、いま押した「撤去」と同じ場所に出す。**
             確かめのボタンを同じ位置に出すと、二度押しで消えてしまう */
          row += btn('unarm', 'やめる', '');
          row += btn('sell', '本当に撤去する', '+' + yen(back), 'danger');
        } else if (canSell) {
          row += btn('arm', name + 'を撤去', '半額 +' + yen(back) + ' が戻る');
        } else if (it.kind === 'table') {
          row += btn('none', '撤去できない', '卓は2つ必要', '', true);
        } else if (it.kind === 'sofa' || it.kind === 'counter') {
          row += btn('none', '撤去できない', '内装のぶん', '', true);
        }
        row += btn('close', 'とじる', '');
        /* 選んでいる間も終われるようにする。とじてからでないと帰れないのは不便 */
        if (edit.arm !== it.id) row += btn('done', '模様替えを終える', '', 'done');
      } else {
        const tp = h.priceOf ? h.priceOf('table') : null;
        const pp = h.priceOf ? h.priceOf('plant') : null;
        row += tp
          ? btn('buy-table', '卓を増設', yen(tp.cost), '', money < tp.cost)
          : btn('none', '卓は8つまで', '', '', true);
        if (pp) row += btn('buy-plant', '観葉植物を買う', yen(pp.cost), '', money < pp.cost);
        row += btn('done', '模様替えを終える', '', 'done');
      }
      /* **いま何が成立しているか**を常に出す。効果が見えないと配置を工夫しない */
      const cb = combos(floor);
      const made = cb.list.length
        ? cb.list.map((c) => '<b>' + esc(c.name) + (c.n > 1 ? '×' + c.n : '') + '</b>' +
            '<i>' + esc(c.see) + '</i>').join('')
        : '<span class="jnFlEbNone">まだ何も成立していません。卓のとなりにソファやカウンターを置くと付きます</span>';
      editBar.innerHTML =
        '<div class="jnFlEbTop"><span class="jnFlEbNote">' + esc(edit.note) + '</span>' +
        '<span class="jnFlEbMoney">所持金 ' + yen(money) + '</span></div>' +
        '<div class="jnFlEbMade">' + made + '</div>' +
        '<div class="jnFlEbRow">' + row + '</div>';
    }

    function note(t) { edit.note = t; }
    /* **そこに置くとコンボがどう変わるか。**置く前に分かると、工夫する気になる */
    function comboDelta(g) {
      if (!g || !g.ok || !edit.drag) return '';
      const next = g.swap ? swapItems(floor, edit.drag.id, g.swap)
                          : moveItem(floor, edit.drag.id, g.x, g.y);
      if (!next) return '';
      const b = combos(floor).counts, a = combos(next).counts;
      const up = [], down = [];
      COMBOS.forEach((c) => {
        const d = (a[c.key] || 0) - (b[c.key] || 0);
        if (d > 0) up.push(c.name); else if (d < 0) down.push(c.name);
      });
      return up.length ? '　' + up.join('・') + ' が成立します'
        : down.length ? '　' + down.join('・') + ' が消えます' : '';
    }
    function commitFloor(change) {
      if (edit.hooks.commit) edit.hooks.commit(floor, change || {});
      buildRoom(); renderEditBar(); paint();
    }
    function applyMove(id, gx, gy) {
      const next = moveItem(floor, id, gx, gy);
      if (!next) { note('ここには置けません'); renderEditBar(); paint(); return false; }
      floor = next;
      note('動かしました');
      commitFloor({ kind: 'move' });
      return true;
    }
    /* 置き先の見当。置けないときは、指の下のものと**入れ替えられるか**を見る。
       卓8まで置くと床がほぼ埋まるので、入れ替えが無いと一つも動かせなくなる */
    function applySwap(idA, idB) {
      const next = swapItems(floor, idA, idB);
      if (!next) { note('入れ替えられません'); renderEditBar(); paint(); return false; }
      floor = next;
      note('入れ替えました');
      commitFloor({ kind: 'move' });
      return true;
    }
    function ghostFor(id, gx, gy, fx, fy) {
      const it = floor.items.find((o) => o.id === id);
      if (!it) return null;
      const c = clampCell(it.kind, gx, gy);
      if (canPlace(floor, { kind: it.kind, x: c.x, y: c.y }, id)) {
        return { kind: it.kind, x: c.x, y: c.y, ok: true };
      }
      const other = fx != null ? pickItem(floor, fx, fy) : null;
      if (other && other.id !== id && swapItems(floor, id, other.id)) {
        return { kind: it.kind, x: other.x, y: other.y, ok: true, swap: other.id };
      }
      return { kind: it.kind, x: c.x, y: c.y, ok: false };
    }

    /* 端に指を置いたままでも横送りする。狭い幅で、画面の外へ動かせなくならないように */
    let edgeTimer = null, edgeDir = 0;
    function stopEdgePan() { clearInterval(edgeTimer); edgeTimer = null; edgeDir = 0; }
    function edgePan(clientX) {
      const r = stage.getBoundingClientRect();
      const x = clientX - r.left;
      const dir = panMax() <= 0 ? 0 : x < 26 ? -1 : x > r.width - 26 ? 1 : 0;
      if (dir === edgeDir) return;
      stopEdgePan();
      edgeDir = dir;
      if (!dir) return;
      edgeTimer = setInterval(() => {
        panX += dir * 2; clampPan(); applyPan();
        const d = edit.drag;
        if (d && d.last) {
          const p = stagePoint(d.last);
          edit.ghost = ghostFor(d.id, Math.floor((p.x - GX0) / GRID) - d.ox,
                                       Math.floor((p.y - GY0) / GRID) - d.oy, p.x, p.y);
        }
        paint();
      }, 40);
    }
    function stagePoint(e) {
      const r = stage.getBoundingClientRect();
      return screenToFloor(e.clientX - r.left, e.clientY - r.top);
    }

    editBar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      const h = edit.hooks;
      const it = selItem();
      if (act === 'done') { stopEdgePan(); if (h.onDone) h.onDone(); return; }
      if (act === 'close') { edit.sel = null; edit.arm = null; note('動かしたいものをタップ'); }
      else if (act === 'unarm') { edit.arm = null; note(''); }
      else if (act === 'arm' && it) { edit.arm = it.id; note('もう一度押すと撤去します'); }
      else if (act === 'mine' && it) {
        floor = setMine(floor, it.id);
        note(floor.mine === it.id ? 'ここを自分の卓にしました' : '自分の卓をやめました');
        commitFloor({ kind: 'mine' });
        return;
      } else if (act === 'sell' && it && edit.arm === it.id) {
        const back = h.refundOf ? h.refundOf(it.kind) : 0;
        const next = removeItem(floor, it.id);
        if (next) {
          floor = next; edit.sel = null; edit.arm = null;
          note(KINDS[it.kind].name + 'を撤去しました（+' + yen(back) + '）');
          commitFloor({ kind: 'sell', itemKind: it.kind, refund: back });
          return;
        }
      } else if (act === 'buy-table' || act === 'buy-plant') {
        const kind = act === 'buy-table' ? 'table' : 'plant';
        const price = h.priceOf ? h.priceOf(kind) : null;
        if (!price || (h.money ? h.money() : 0) < price.cost) return;
        /* **買ったものが窓の外に置かれると、置いたことに気づけない。**
           決め打ちの並びのうち「いま見えている」ものを先に、あとは近い順に */
        const near = { x: Math.round((panX + floorW / 2 - GX0) / GRID), y: Math.round(ROWS / 2) };
        const seen = (gx) => cellX(gx) >= panX - 2 &&
          cellX(gx) + KINDS[kind].w * GRID <= panX + floorW + 2;
        const spots = (kind === 'table' ? tableSpots(floor) : []).filter(([gx]) => seen(gx));
        const res = addItem(floor, kind, spotsNear(floor, kind, near, spots));
        if (!res) { note('置ける場所がありません'); renderEditBar(); return; }
        floor = res.floor; edit.sel = res.item.id; edit.arm = null;
        note(KINDS[kind].name + 'を置きました。動かせます');
        commitFloor({ kind: 'buy', itemKind: kind, cost: price.cost });
        return;
      }
      renderEditBar(); paint();
    });

    function setEdit(on, hooks) {
      stopEdgePan();
      edit.on = !!on;
      edit.hooks = hooks || {};
      edit.sel = null; edit.ghost = null; edit.drag = null; edit.arm = null;
      edit.note = on ? '動かしたいものをタップ。床をタップするとそこへ動きます' : '';
      wrap.classList.toggle('editing', edit.on);
      if (edit.hooks.parlor) parlor = edit.hooks.parlor() || parlor;
      resetLive();
      live.headNote = on ? '模様替え' : '';
      floor = null;                       // 入るときに読み直す
      buildRoom();
      renderEditBar();
      paint();
    }

    function paint() {
      if (edit.on) { drawEditLayer(); drawUi(); drawEditTags(); return; }
      drawLight(); drawActors(); drawUi(); drawHits();
    }

    /* ---------- 静止画（第一段の見せ方） ---------- */
    function render(state) {
      const st = state || {};
      parlor = st.parlor || parlor || {};
      staffList = st.staff || [];
      resetLive();
      live.closedTables = st.closedTables || 0;
      live.myTable = st.myTable != null ? st.myTable : -1;
      live.dayNo = parlor.day || 0;
      live.headNote = st.headNote || '';
      live.slot = st.slot != null ? st.slot : 2;
      live.sales = st.sales || 0;
      live.ticker = st.ticker || '';
      live.speed = parlor.speed || 1;
      buildRoom();
      (st.guests || []).forEach((g, i) => {
        /* `quirk` は遠征先の店だけが渡す（`ScoutShop.stateOf`）。
           自分の店の `Jansou` は入れないので null のまま＝何も描かれない */
        live.seated.set('p' + i, { typeKey: g.typeKey, count: 1,
          quirk: (g.quirk && g.quirk.length) ? g.quirk : null,
          sex: g.sex || null,
          seats: [{ table: g.table, seat: g.seat }] });
      });
      /* スタッフは空いている席に。埋まっていれば通路に */
      const used = new Set((st.guests || []).map((g) => g.table + ':' + g.seat));
      const spots = [];
      tables.forEach((t, ti) => {
        if (t.kind === 'closed') return;
        seatsOf(t).forEach((s, si) => { if (!used.has(ti + ':' + si)) spots.push({ x: s.x + 1, y: s.y + 9 }); });
      });
      staffList.forEach((c, i) => {
        /* 空き席が足りないぶんは床の下端に並べる。**7人目からは段を上げる。**
           横に剰余だけで折り返すと7人目が1人目と同じ場所に重なり、
           丸写真が一枚に見える（staffSpotFor が席で同じ罠を避けているのと同じ話） */
        const p = spots[i] || { x: 10 + (i % 6) * 28, y: FLOOR_H - 18 - Math.floor(i / 6) * 13 };
        live.staff.set(c.id, { x: p.x, y: p.y, fx: p.x, fy: p.y, tx: p.x, ty: p.y, t0: -9 });
        if (c.nominated) live.hearts.add(c.id);
      });
      live.queue = [];
      paint();
    }

    /* ---------- 再生 ---------- */
    function applyEvent(e, hooks) {
      const c = live.clock;
      switch (e.kind) {
        case 'slotStart': {
          live.slot = e.slot; live.full = false;
          live.ticker = SLOT_NAMES[e.slot] + 'の営業（' + SLOT_HOURS[e.slot] + '）';
          /* 帯のシフトどおりに出入りする。昼だけの子は夜には居ない */
          const want = new Set(e.staff || []);
          live.staff.forEach((s, id) => {
            if (want.has(id) || s.leaving) return;
            const door = entrance();
            s.fx = s.x; s.fy = s.y; s.tx = door.x; s.ty = door.y; s.t0 = c; s.leaving = true; s.at = null;
            live.hearts.delete(id);
            if (live.skipping) live.staff.delete(id);
          });
          (e.staff || []).forEach((id, i) => {
            if (live.staff.has(id) && !live.staff.get(id).leaving) return;
            const door = entrance();
            const table = i % Math.max(1, tables.length);
            live.staff.set(id, { x: door.x, y: door.y, fx: door.x, fy: door.y, tx: door.x, ty: door.y,
              t0: c, at: null, table, leaving: false });
            moveStaff(id, table);
          });
          break;
        }
        case 'visitor':
          live.visitor = { typeKey: e.typeKey, name: e.name };
          live.ticker = (e.name ? e.name + ' が' : '') + '入口で騒いでいる';
          break;
        case 'visitorLeave':
          live.visitor = null;
          break;
        case 'arrive': {
          const seatOne = () => live.seated.set(e.guestId, { typeKey: e.typeKey, look: e.look, count: e.count,
            seats: e.seats, amount: e.amount, favTalent: e.favTalent, transient: e.transient });
          const to = seatPos(e.seats[0].table, e.seats[0].seat) || entrance();
          yieldSeats(e.seats);
          if (e.mode === 'walk' && !live.skipping) {
            live.walkers.push({ guestId: e.guestId, typeKey: e.typeKey, count: e.count, seats: e.seats,
              from: entrance(), to, t0: c, dur: WALK_SEC, seat: seatOne });
          } else {
            seatOne();
            if (!live.skipping) live.flashes.push({ x: to.x, y: to.y, t0: c, dur: SWAP_SEC, p: 0 });
          }
          break;
        }
        case 'leave': {
          const g = live.seated.get(e.guestId);
          live.seated.delete(e.guestId);
          /* まだ歩いて向かっている途中なら、そのまま消す */
          live.walkers = live.walkers.filter((w) => w.guestId !== e.guestId);
          if (g && !live.skipping) {
            const from = seatPos(g.seats[0].table, g.seats[0].seat) || entrance();
            live.leavers.push({ guestId: e.guestId, typeKey: g.typeKey, count: g.count,
              from, to: entrance(), t0: c, dur: LEAVE_SEC });
          }
          break;
        }
        case 'pay': {
          live.sales += e.amount;
          if (live.skipping) break;
          const same = live.pops.find((p) => p.table === e.table && !p.label && live.real - p.t0 < POP_MERGE);
          if (same) { same.amount += e.amount; same.count++; same.t0 = live.real; }
          else live.pops.push({ table: e.table, amount: e.amount, count: 1, t0: live.real });
          break;
        }
        case 'bonus':
          live.extra += e.amount;
          live.ticker = e.label + '（+' + yen(e.amount) + '）';
          if (!live.skipping) live.pops.push({ table: -1, amount: e.amount, count: 1, t0: live.real, label: e.label });
          break;
        case 'full':
          live.full = true;
          live.ticker = '満卓になった';
          break;
        case 'staffMove':
          moveStaff(e.charaId, e.table);
          break;
        case 'nominate': {
          live.hearts.add(e.charaId);
          const info = staffList.find((x) => x.id === e.charaId);
          live.ticker = (info ? info.name : 'スタッフ') + ' に指名が入った！';
          break;
        }
        case 'slotEnd':
          live.full = false;
          live.ticker = SLOT_NAMES[e.slot] + '：' + e.guests + '人　' + yen(e.sales);
          break;
        case 'dayEnd':
          live.ticker = '閉店。おつかれさまでした';
          break;
        default: break;
      }
    }

    function advance(dt) {
      live.real += dt;
      const c = live.clock;
      live.staff.forEach((s, id) => { if (s.leaving && c - s.t0 >= 1.0) live.staff.delete(id); });
      live.walkers = live.walkers.filter((w) => {
        if (c - w.t0 >= w.dur) { w.seat(); return false; }
        return true;
      });
      live.leavers = live.leavers.filter((w) => c - w.t0 < w.dur);
      live.flashes.forEach((f) => { f.p = Math.min(1, (c - f.t0) / f.dur); });
      live.flashes = live.flashes.filter((f) => f.p < 1);
      live.pops = live.pops.filter((p) => live.real - p.t0 < POP_SEC);
    }

    let raf = null, resolvePlay = null, timeline = null, hooksRef = null;
    let waiting = false, consuming = false;

    /* 入口の待ち客＝次に来る swap を最大2人（先読みは表示だけ。結果に触れない） */
    function refreshQueue() {
      live.queue = [];
      if (live.skipping) return;
      for (let i = live.idx; i < timeline.length && live.queue.length < 2; i++) {
        const e = timeline[i];
        if (e.t > live.clock + 2.0) break;
        if (e.kind === 'arrive' && e.mode === 'swap') live.queue.push({ typeKey: e.typeKey });
      }
    }

    async function consume() {
      if (consuming) return;
      consuming = true;
      try {
        while (live.idx < timeline.length && timeline[live.idx].t <= live.clock) {
          const e = timeline[live.idx++];
          if (e.kind === 'interrupt') {
            waiting = true;
            /* 挑戦者が居れば、その席に黄色い枠を出しておく */
            if (e.node && e.node.guestId && live.seated.has(e.node.guestId)) live.highlight = e.node.guestId;
            paint();
            try { await hooksRef.onInterrupt(e.node); }
            finally { waiting = false; live.highlight = null; }
            continue;
          }
          applyEvent(e, hooksRef);
          if (hooksRef.onEvent) hooksRef.onEvent(e);
        }
      } finally { consuming = false; }
    }

    function finish() {
      live.playing = false;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      paint();
      const done = resolvePlay; resolvePlay = null;
      if (done) done();
    }

    function play(tl, hooks) {
      return new Promise((resolve) => {
        timeline = tl; hooksRef = hooks || {}; resolvePlay = resolve;
        parlor = hooks.parlor || parlor;
        staffList = hooks.staff || [];
        resetLive();
        live.closedTables = hooks.closedTables || 0;
        live.myTable = hooks.myTable != null ? hooks.myTable : -1;
        live.dayNo = (parlor.day || 0) + 1;
        live.speed = hooks.speed || parlor.speed || 1;
        live.playing = true;
        buildRoom();
        staffList.forEach((c, i) => {
          const table = i % Math.max(1, tables.length);
          live.staff.set(c.id, { x: 0, y: 0, fx: 0, fy: 0, tx: 0, ty: 0, t0: -9, at: null, table });
          const p = staffSpotFor(table, c.id);
          Object.assign(live.staff.get(c.id), { x: p.x, y: p.y, fx: p.x, fy: p.y, tx: p.x, ty: p.y, at: p.at });
        });
        let prev = performance.now();
        const duration = tl.length ? tl[tl.length - 1].t : 0;

        function step(now) {
          if (!live.playing) return;
          const dt = Math.min(0.1, (now - prev) / 1000);
          prev = now;
          if (!waiting && !live.paused) {
            if (live.skipping) {
              live.clock = duration;
              live.walkers.forEach((w) => w.seat());
              live.walkers = []; live.leavers = []; live.pops = []; live.flashes = [];
            } else {
              live.clock += dt * live.speed;
            }
            consume();
            refreshQueue();
          }
          advance(dt);
          paint();
          if (!waiting && !consuming && live.idx >= timeline.length &&
              !live.walkers.length && !live.leavers.length) { finish(); return; }
          raf = requestAnimationFrame(step);
        }
        raf = requestAnimationFrame(step);
      });
    }

    function setSpeed(v) { live.speed = v; }
    function skip() { if (live.playing) live.skipping = true; }
    function pause() { live.paused = true; }
    function resume() { live.paused = false; }

    /* 客をタップ → 止めて → カード（jansou.js が描く）→ 閉じたら再開 */
    hits.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-guest]');
      if (!b || !live.playing || !hooksRef || !hooksRef.onGuestTap || live.paused) return;
      const id = b.dataset.guest;
      const g = live.seated.get(id);
      if (!g) return;
      pause();
      live.highlight = id;
      paint();
      try {
        await hooksRef.onGuestTap({ guestId: id, typeKey: g.typeKey, look: g.look, count: g.count,
          amount: g.amount, favTalent: g.favTalent, seats: g.seats, transient: g.transient });
      } finally {
        live.highlight = null;
        resume();
      }
    });

    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-speed]');
      if (b) { setSpeed(+b.dataset.speed); if (opts.onSpeed) opts.onSpeed(+b.dataset.speed); if (!live.playing) drawUi(); return; }
      if (e.target.closest('[data-skip]')) skip();
      const p = e.target.closest('[data-pan]');
      if (p) { panX += (+p.dataset.pan) * 24; clampPan(); applyPan(); paint(); }
    });

    /* ---------- 床のうえの操作（横送りと模様替え） ----------
       切り分けはこれだけ（placement.md §3・§7.2）：

         ものの上から始めた   → そのものを動かす（指を離すまで置き先を見せる）
         何も無い床から始めた → 動かせば横送り、動かさなければ「そこへ置く」

       狭い幅ほど床の空きが減るので、模様替え中は横送りの矢印を必ず出し、
       ものをつまんだまま窓の端へ寄せると自動で送る。
       客のボタンの上から始めたときは、どちらもしない（タップを取りこぼす） */
    let pan = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest && e.target.closest('button')) return;
      const p = stagePoint(e);
      if (edit.on) {
        /* ものの上なら、それをつまむ。何も無い床でも、**選んでいるものがあれば
           それを持ってきて置く**（指を離す前に緑／赤が見える）。
           選んでいるものが無いときだけ、床をなぞると横送りになる */
        const hit = pickItem(floor, p.x, p.y);
        const it = hit || selItem();
        if (it) {
          const s = KINDS[it.kind];
          edit.sel = it.id; edit.arm = null;
          edit.drag = { id: it.id, x0: e.clientX, y0: e.clientY, moved: false, last: e,
            grabbed: !!hit,
            ox: hit ? Math.floor((p.x - GX0) / GRID) - it.x : ((s.w - 1) >> 1),
            oy: hit ? Math.floor((p.y - GY0) / GRID) - it.y : ((s.h - 1) >> 1) };
          edit.ghost = ghostFor(it.id, Math.floor((p.x - GX0) / GRID) - edit.drag.ox,
                                       Math.floor((p.y - GY0) / GRID) - edit.drag.oy, p.x, p.y);
          note(hit ? KINDS[it.kind].name + 'をつまんでいます'
                   : (edit.ghost && edit.ghost.ok ? 'ここに置けます' : 'ここには置けません'));
          try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 古い実装 */ }
          renderEditBar(); paint();
          return;
        }
      }
      pan = { x: e.clientX, from: panX, moved: false, fx: p.x, fy: p.y };
      if (panMax() > 0) { try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 同上 */ } }
    });
    stage.addEventListener('pointermove', (e) => {
      const d = edit.drag;
      if (d) {
        if (Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) > 5) d.moved = true;
        d.last = e;
        const p = stagePoint(e);
        edit.ghost = ghostFor(d.id, Math.floor((p.x - GX0) / GRID) - d.ox,
                                    Math.floor((p.y - GY0) / GRID) - d.oy, p.x, p.y);
        if (d.moved) {
          note((!edit.ghost || !edit.ghost.ok ? 'ここには置けません'
            : edit.ghost.swap ? 'ここと入れ替えます' : 'ここに置けます') + comboDelta(edit.ghost));
        }
        edgePan(e.clientX);
        renderEditBar(); paint();
        return;
      }
      if (!pan) return;
      if (Math.abs(e.clientX - pan.x) > 3) pan.moved = true;
      if (panMax() > 0) { panX = pan.from - (e.clientX - pan.x) / scale; clampPan(); applyPan(); paint(); }
    });
    function endPointer() {
      const d = edit.drag;
      if (d) {
        edit.drag = null;
        stopEdgePan();
        const g = edit.ghost;
        edit.ghost = null;
        /* つまんだだけ（動かしていない）なら、選んだだけにする。
           そこで動かしてしまうと、選ぶたびに保存が走る */
        if (d.grabbed && !d.moved) note('動かしたい場所をタップするか、そのままつまんで動かします');
        else if (g && g.ok && g.swap) { applySwap(d.id, g.swap); return; }
        else if (g && g.ok) { applyMove(d.id, g.x, g.y); return; }
        else note('ここには置けません');
        renderEditBar(); paint();
        return;
      }
      if (pan && !pan.moved && edit.on) { note('動かしたいものをタップ'); renderEditBar(); paint(); }
      pan = null;
    }
    ['pointerup', 'pointercancel'].forEach((k) => stage.addEventListener(k, endPointer));

    let tid = null;
    const onResize = () => {
      clearTimeout(tid);
      tid = setTimeout(() => {
        /* **外れていたら自分で片づける。**画面を替えたときに
           後始末の口が無いので、ここで気づいて listener を外す。
           そうしないと、開くたびに resize の受け口が一つずつ増える */
        if (!wrap.isConnected) { destroy(); return; }
        buildRoom(); paint();
      }, 120);
    };
    window.addEventListener('resize', onResize);

    /* ---------- 止まったまま動き続ける（scout/spec.md §2.3・§3.1） ----------
       **タイムラインを消化しない再生。**遠征先の店はこれで見せる。
       時計を進めて `paint()` するだけなので、動くのは
       **乱数を使わない常時アニメ**（打牌の手・ネオン・ミラーボール）だけ。
       これらは `drawActors()` が `live.clock` からだけ位相を出しているので、
       時計さえ進めば動く。**乱数は一切引かない。**

       **`live.playing` を立てること。**客のタップ判定が
       `!live.playing` で弾いているので、立てないと声をかけられない。

       止めるのは `stop()`。**画面から外れたら自分で止まる**——
       `shell.html` の `go()` は `#view` を空にするだけで後始末の口が無いので、
       ここで見ていないと rAF が回りっぱなしになる */
    function idle(hooks) {
      /* **タップの受け口は `hooksRef`。**`play()` と同じ入れ物を使う
         （タップの処理は一箇所しかない） */
      if (hooks) hooksRef = hooks;
      if (live.playing) return;
      live.playing = true;
      let prev = performance.now();
      const step = (now) => {
        if (!live.playing) return;
        if (!wrap.isConnected) { live.playing = false; raf = null; return; }
        const dt = Math.min(0.1, (now - prev) / 1000);
        prev = now;
        if (!live.paused) live.clock += dt;
        advance(dt);
        paint();
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }

    function stop() {
      live.playing = false;
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    }

    /* **名前付きにしてある。**`onResize` が「外れていたら自分で片づける」で
       呼ぶので、返り値のメソッドとしてだけ持たせると届かない */
    function destroy() {
      live.playing = false;
      stopEdgePan();
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      clearTimeout(tid);
      window.removeEventListener('resize', onResize);
      wrap.remove();
    }

    return {
      el: wrap, render, play, idle, stop, setSpeed, skip, pause, resume, setEdit,
      floorToScreen, screenToFloor, destroy,
      get scale() { return scale; },
      get floorW() { return floorW; },
      get playing() { return live.playing; },
    };
  }

  return {
    mount, fit, seatsOf, gridRects, build, slotStartTimes, spriteSvg, bottleSvg, insertEvent,
    /* 再生の見せかたの決めごと（純関数） */
    skipHidden,
    /* マス目と設置物（placement.md §1・§2）。純関数 */
    autoPlace, reconcile, canPlace, freeCell, tablesOf, itemsOf, ringCells, cellX, cellY,
    pickItem, clampCell, moveItem, swapItems, removeItem, setMine, addItem, tableSpots, spotsNear,
    /* 隣接コンボ（placement.md §5）。純関数 */
    combos, tableTraits, adjacent, COMBOS, COMBO_BY_KEY, TIP_PER_GUEST,
    SOFA_SPOTS, COUNTER_SPOTS,
    KINDS, DOOR, GRID, COLS, ROWS, GX0, GY0,
    drawWall, drawCarpet, drawFixtures, drawTable,
    /* 描画の道具。**事務所の部屋（office-room.js）が借りる**（office/room.md §3.1）。
       同じ関数で描くから同じ粒になる。振る舞いはここで一つも変えていない */
    el, rect, STAFF_BODY, staffColor,
    PAL, FLOOR_H, FLOOR_W, FLOOR_W_MAX, TABLE_W, TABLE_H, SEAT_W, SEAT_H, COL_PITCH,
    WALL_H, CARPET_Y,
    SLOT_SEC, INTERMISSION, MAX_WALK, WALK_SEC, SWAP_SEC, SEATS_PER_TABLE,
  };
})();

if (typeof module !== 'undefined') {
  module.exports = { JansouFloor };
}
