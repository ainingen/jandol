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
  const PAL = {
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
  };

  /* ---------- フロアの寸法（§4.7 の実測） ---------- */
  const FLOOR_H = 164;
  const FLOOR_W_MAX = 200;
  const WALL_H = 35;        // 壁 0〜34
  const EDGE_Y = 35;        // 床の縁（巾木）35〜36
  const CARPET_Y = 37;      // カーペット 37〜163

  const TABLE_W = 30, TABLE_H = 20;   // 卓（実測）
  const COL_PITCH = 60;               // 卓の横の間隔（卓30＋左右の席）
  const SEAT_W = 12, SEAT_H = 16;     // 客スプライト

  /* ---------- 倍率とフロア幅（§4.1） ----------
     倍率 s は 160*s <= 使える幅 を満たす最大の整数（2〜4に丸める）。
     フロア幅は min(200, floor(使える幅 / s))。高さは164固定 */
  function fit(availW) {
    let s = 2;
    for (let i = 4; i >= 2; i--) { if (160 * i <= availW) { s = i; break; } }
    /* **下限でクランプしないこと。** floor(幅/倍率) を上回る値を返すと
       そのぶん枠からはみ出す。狭いときはフロアが細くなるのが正しい */
    return { scale: s, floorW: Math.min(FLOOR_W_MAX, Math.floor(availW / s)) };
  }

  /* ---------- 卓の配置（卓2〜8） ----------
     1行あたり最大3卓。3行必要なときだけ縦の間隔を詰める */
  function layout(tables, floorW) {
    const cols = Math.max(1, Math.min(3, Math.floor(floorW / COL_PITCH)));
    const rows = Math.ceil(tables / cols);

    /* 縦の間隔は**行数から決める**。狭い幅（2列）で卓8だと4行になり、
       固定の間隔では床からはみ出す。上には席の帯（16px）が要る */
    const top = CARPET_Y + SEAT_H;
    const availH = (FLOOR_H - 6) - top;
    const pitchY = rows <= 1 ? 0
      : Math.min(52, Math.floor((availH - TABLE_H) / (rows - 1)));
    const blockH = (rows - 1) * pitchY + TABLE_H;
    /* 上寄せ。中央に置くと卓2の日に床の上半分がただの空き地に見える。
       下の余りは入口・ソファ・カウンターが埋めていく（§10） */
    const y0 = top + Math.min(8, Math.max(0, Math.floor((availH - blockH) / 2)));

    /* 間隔が詰まった配置では卓の上に席を置かない。
       置くと上の卓に客がめり込む */
    const tight = pitchY > 0 && pitchY < 40;

    const out = [];
    let left = tables;
    for (let r = 0; r < rows; r++) {
      const n = Math.min(cols, left);
      left -= n;
      const spanW = n * COL_PITCH;
      const x0 = Math.round((floorW - spanW) / 2);
      for (let c = 0; c < n; c++) {
        out.push({
          idx: out.length,
          x: x0 + c * COL_PITCH + Math.round((COL_PITCH - TABLE_W) / 2),
          y: y0 + r * pitchY,
          tight,
        });
      }
    }
    return out;
  }

  /* 卓のまわりの席。左・右と、余裕があれば上に2つ */
  function seatsOf(t) {
    const seats = [
      { x: t.x - SEAT_W - 1, y: t.y + 1, face: 1 },
      { x: t.x + TABLE_W + 1, y: t.y + 1, face: -1 },
    ];
    if (!t.tight) {
      seats.push({ x: t.x + 3, y: t.y - SEAT_H, face: 1 });
      seats.push({ x: t.x + TABLE_W - SEAT_W - 3, y: t.y - SEAT_H, face: 1 });
    }
    return seats;
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
    const starts = slotStartTimes();
    const dayEndT = starts[2] + SLOT_SEC[2];
    const ev = [];
    const push = (e) => { ev.push(e); return e; };

    /* 席の占有。seat 番号 = table位置 * 4 + 席（0〜3）。一日通しで持つ */
    const occ = new Array(seatsN).fill(null);   // {guestId, since, leaveAt, slot, amount}
    const walks = [];                            // 歩行中 {until, count}
    let lastTable = tableIdx.length ? tableIdx[0] : 0;
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
      }
    }
    function freeSeats() {
      const out = [];
      for (let i = 0; i < occ.length; i++) if (!occ[i]) out.push(i);
      return out;
    }
    /* 同じ卓で n 席まとめて空いているところ。無ければ空席をばらで */
    function pickSeats(n) {
      const free = freeSeats();
      if (free.length < n) return null;
      for (let ti = 0; ti < tableIdx.length; ti++) {
        const mine = free.filter((s) => (s / SEATS_PER_TABLE | 0) === ti);
        if (mine.length >= n) return mine.slice(0, n);
      }
      return free.slice(0, n);
    }
    /* 満席なら、いちばん早くから座っている客を追い出す */
    function evictOldest(n, t) {
      const seated = [];
      for (let i = 0; i < occ.length; i++) if (occ[i]) seated.push(i);
      seated.sort((a, b) => occ[a].since - occ[b].since);
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
        arrivals.push({ type: tp, count, face, favTalent, transient,
          /* 主（段階3）になった常連は、常連の主の姿で描く */
          look: reg && G.stageOf(reg.visits || 0) >= 3 ? 'nushi' : tp.key });
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
        let seats = pickSeats(a.count);
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
          seats = pickSeats(a.count) || freeSeats().slice(0, a.count);
        }
        if (!seats || seats.length < a.count) {
          /* 席数より大きい群（卓1で4人など）。入るぶんだけ座らせる */
          seats = freeSeats().slice(0, a.count);
        }
        const table = tableIdx[(seats[0] / SEATS_PER_TABLE) | 0];
        const seatNo = seats[0] % SEATS_PER_TABLE;
        const leaveAt = Math.min(dayEndT, t + dwell);
        seats.forEach((s, j) => {
          occ[s] = { guestId, since: t, leaveAt, slot: si, amount: amounts[k],
                     table: tableIdx[(s / SEATS_PER_TABLE) | 0], seat: s % SEATS_PER_TABLE,
                     count: a.count, head: j === 0 };
        });
        if (mode === 'walk') walkN++; else swapN++;
        lastTable = table;
        push({ t, kind: 'arrive', slot: si, guestId, typeKey: a.type.key, look: a.look, count: a.count,
               amount: amounts[k], favTalent: a.favTalent, transient: a.transient || undefined,
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
        /* 指名。演出だけ（§5.4）。帯ごとに一人まで */
        if (rng() < 0.35) {
          push({ t: t0 + D * (0.3 + rng() * 0.5), kind: 'nominate',
                 charaId: onDuty[Math.floor(rng() * onDuty.length)] });
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
    /* 今日来た顔（同じ人は一度）。jansou.js が名前を用意し、締めで常連に反映する */
    summary.faces = [];
    const seenFace = new Set();
    ev.forEach((e) => {
      if (e.kind !== 'arrive' || e.transient || seenFace.has(e.guestId)) return;
      seenFace.add(e.guestId);
      summary.faces.push({ id: e.guestId, typeKey: e.typeKey, favTalent: e.favTalent });
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
  function drawWall(g, floorW, parlor) {
    const sign = parlor.sign | 0, lv = parlor.interior | 0;
    g.appendChild(rect(0, 0, floorW, WALL_H, PAL.wall));
    g.appendChild(rect(0, WALL_H - 3, floorW, 3, PAL.wallLow));

    /* 壁の下端のLED。宣伝3から灯る */
    if (sign >= 3) {
      const led = [PAL.neonCyan, PAL.neonPink, PAL.neonYellow, PAL.neonGreen];
      for (let x = 1; x < floorW; x += 3) {
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
      neon(g, 'GIRLS', 6, 3, '#4a2a44', '#3a2036');
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
    if (lv >= 3) g.appendChild(rect(Math.min(floorW - 9, 110), 0, 1, 9, '#6a5a70'));

    /* スタンド花。**奥の壁に立てる。**床に置くと卓が3行になったとき
       客や卓の裏に隠れて、買った手応えが出ない（実際に隠れた）。
       看板とパネルとミラーボールを避けて、壁の右側に二基 */
    if (lv >= 4) {
      [floorW - 30, floorW - 15].forEach((fx) => {
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
  function drawCarpet(g, floorW, parlor) {
    if ((parlor.interior | 0) < 2) {
      g.appendChild(rect(0, EDGE_Y, floorW, 2, '#6a5a4a'));
      g.appendChild(rect(0, CARPET_Y, floorW, FLOOR_H - CARPET_Y, PAL.plankA));
      /* 板の継ぎ目。**長い横板に見せる。**縦の継ぎ目を短い周期で入れると
         煉瓦に見えてしまうので、板一枚につき1本だけ、間隔を空けて置く */
      for (let y = CARPET_Y + 8, row = 0; y < FLOOR_H; y += 8, row++) {
        g.appendChild(rect(0, y, floorW, 1, PAL.plankSeam));
        /* 木目。板ごとに位置をずらす（時刻に依らない固定の並び） */
        for (let k = 0; k < 2; k++) {
          const x = (row * 37 + k * 79 + 11) % (floorW - 20) + 6;
          g.appendChild(rect(x, y - 5, 10, 1, PAL.plankGrain));
        }
        /* 板の継ぎ目（縦）。1行に1本だけ */
        const bx = (row * 53 + 17) % (floorW - 8) + 4;
        g.appendChild(rect(bx, y - 7, 1, Math.min(7, FLOOR_H - (y - 7)), PAL.plankSeam));
      }
      return;
    }
    g.appendChild(rect(0, EDGE_Y, floorW, 2, PAL.edge));
    g.appendChild(rect(0, CARPET_Y, floorW, FLOOR_H - CARPET_Y, PAL.carpetA));
    /* 4×4の市松（周期8） */
    for (let y = CARPET_Y; y < FLOOR_H; y += 4) {
      for (let x = 0; x < floorW; x += 4) {
        const on = (((x / 4) | 0) + (((y - CARPET_Y) / 4) | 0)) % 2 === 0;
        if (on) g.appendChild(rect(x, y, Math.min(4, floorW - x), Math.min(4, FLOOR_H - y), PAL.carpetB));
      }
    }
    /* 菱形の柄を周期8で散らす */
    for (let y = CARPET_Y + 6; y < FLOOR_H - 2; y += 8) {
      for (let x = 4; x < floorW - 2; x += 8) {
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
  function drawTable(g, t, kind, auto) {
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

  /* 床の設備。**内装の段階で増えていく**（§10）。
       1 板張りの床だけ（素っ気ない部屋）
       2 カーペット（drawCarpet）
       3 ミラーボール・指名パネル（drawWall / drawActors）
       4 スタンド花・ソファ席
       5 ドリンクカウンターとボトル棚 → girls-ivory.png の完成形 */
  function drawFixtures(g, floorW, parlor) {
    const lv = parlor.interior | 0;
    /* 入口のマット。内装1は素の板張りなので敷かない */
    if (lv >= 2) g.appendChild(rect((floorW >> 1) - 16, FLOOR_H - 6, 32, 4, '#c86ab0'));
    /* ソファ席 */
    if (lv >= 4) {
      const sx = 3, sy = FLOOR_H - 30;
      g.appendChild(rect(sx, sy, 30, 18, '#b8508e'));
      g.appendChild(rect(sx + 1, sy + 3, 13, 13, '#d46aa8'));
      g.appendChild(rect(sx + 16, sy + 3, 13, 13, '#d46aa8'));
    }
    /* ドリンクカウンターとボトル棚 */
    if (lv >= 5) {
      const cx = floorW - 34, cy = FLOOR_H - 30;
      g.appendChild(rect(cx, cy, 31, 20, PAL.panel));
      g.appendChild(rect(cx + 1, cy + 1, 29, 5, '#6e3c64'));
      const cols = ['#96f0ff', '#ff56b2', '#ffe86e', '#96ffb4'];
      cols.forEach((c, i) => g.appendChild(rect(cx + 3 + i * 7, cy + 8, 5, 5, c)));
      for (let i = 0; i < 4; i++) {
        g.appendChild(rect(cx + 4 + i * 7, cy + 14, 3, 5, i % 2 ? '#dcd0c0' : '#c8a44a'));
      }
    }
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

  function mount(host, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.className = 'jnFloor';
    wrap.innerHTML =
      '<div class="jnFlTop"><span class="jnFlName">ガールズ雀荘 〜雀ドル亭〜</span>' +
      '<span class="jnFlDay"></span></div>' +
      '<div class="jnFlBar"><span class="jnFlSlot"></span>' +
      '<span class="jnFlTrack"><span class="jnFlFill"></span></span>' +
      '<span class="jnFlSales"></span><span class="jnFlSpeed">' +
      [1, 2, 4].map((v) => '<button type="button" class="jnFlSp" data-speed="' + v + '">×' + v + '</button>').join('') +
      '<button type="button" class="jnFlSp skip" data-skip="1" hidden>スキップ</button></span></div>' +
      '<div class="jnFlStage"><div class="jnFlUi"></div><div class="jnFlHits"></div></div>' +
      '<div class="jnFlTicker"></div>';
    host.appendChild(wrap);

    const stage = wrap.querySelector('.jnFlStage');
    const ui = wrap.querySelector('.jnFlUi');
    const hits = wrap.querySelector('.jnFlHits');
    const hitEls = new Map();      // guestId:seat -> div。作り直さず位置だけ動かす
    let svg = null, roomG = null, lightG = null, actG = null, defs = null;
    let scale = 3, floorW = FLOOR_W_MAX;
    let tables = [];
    let parlor = {};
    let staffList = [];
    const made = {};

    /* **フロア座標→画面座標はここだけ。** UI層は全部これを通す（§8） */
    function floorToScreen(fx, fy) { return { x: fx * scale, y: fy * scale }; }
    function screenToFloor(px, py) { return { x: px / scale, y: py / scale }; }

    function measure() {
      /* **測るのは mount に渡された枠。** wrap は width:max-content なので、
         そこを測ると中身が決まる前の幅（ほぼ0）を拾ってしまう */
      const availW = Math.max(160, (host.clientWidth || host.parentNode.clientWidth || 360) - 6);
      const f = fit(availW);
      scale = f.scale; floorW = f.floorW;
      stage.style.width = (floorW * scale) + 'px';
      stage.style.height = (FLOOR_H * scale) + 'px';
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

    function entrance() { return { x: (floorW >> 1) - 6, y: FLOOR_H - 20 }; }
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
      /* **どこも埋まっていたら通路へ。ここで同じ場所に重ねない。**
         丸写真が重なると誰が誰だか分からなくなる（実際に4人重なった）。
         通路は卓の下すぐ。床の下端に置くと店の隅に取り残されて見える */
      const lastY = tables.reduce((a, t) => Math.max(a, t.y), 0);
      const aisleY = Math.min(FLOOR_H - 16, lastY + TABLE_H + 4);
      for (let i = 0; i < 8; i++) {
        const key = 'aisle:' + i;
        if (!taken.has(key)) return { x: Math.min(floorW - 10, 8 + i * 22), y: aisleY, at: key };
      }
      return { x: Math.min(floorW - 10, 8), y: aisleY, at: null };
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
      svg = el('svg', {
        class: 'jnFlPix', viewBox: '0 0 ' + floorW + ' ' + FLOOR_H,
        width: floorW * scale, height: FLOOR_H * scale,
        'shape-rendering': 'crispEdges', 'aria-hidden': 'true',
      });
      defs = el('defs', {});
      svg.appendChild(defs);
      roomG = el('g', {}); lightG = el('g', {}); actG = el('g', {});
      svg.appendChild(roomG); svg.appendChild(actG); svg.appendChild(lightG);

      drawWall(roomG, floorW, parlor);
      drawCarpet(roomG, floorW, parlor);
      drawFixtures(roomG, floorW, parlor);
      tables = layout(parlor.tables || 2, floorW);
      const closed = live.closedTables || 0;
      tables.forEach((t, i) => {
        t.kind = i >= tables.length - closed ? 'closed'
          : i === live.myTable ? 'mine' : 'normal';
        drawTable(roomG, t, t.kind, parlor.auto);
      });
      /* スタッフの体は一つの <g> を使い回す */
      const gg = el('g', { id: 'jns-body' });
      gridRects(STAFF_BODY, staffColor).forEach((r) => gg.appendChild(r));
      defs.appendChild(gg);
      stage.insertBefore(svg, ui);
    }

    function guestDef(typeKey, frame) {
      const id = 'jnc-' + typeKey + '-' + frame;
      if (!made[id]) {
        const t = G.BY_KEY[typeKey];
        const gg = el('g', { id });
        gridRects(G.grid(typeKey, frame), guestColor(t)).forEach((r) => gg.appendChild(r));
        defs.appendChild(gg);
        made[id] = true;
      }
      return '#' + id;
    }
    function putGuest(typeKey, x, y, frame) {
      const sh = el('g', { transform: 'translate(' + Math.round(x) + ',' + (Math.round(y) + SEAT_H) + ')' });
      shadowRects(SEAT_W).forEach((r) => sh.appendChild(r));
      actG.appendChild(sh);
      actG.appendChild(el('use', { href: guestDef(typeKey, frame), x: Math.round(x), y: Math.round(y) }));
    }

    /* ---------- 照明（帯で変わる。§4.3「ピンクを差す」） ---------- */
    function drawLight() {
      while (lightG.firstChild) lightG.removeChild(lightG.firstChild);
      if (live.slot === 1) {
        lightG.appendChild(el('rect', { x: 0, y: CARPET_Y, width: floorW, height: FLOOR_H - CARPET_Y,
          fill: '#ffb478', opacity: 0.07 }));
      } else if (live.slot === 2) {
        lightG.appendChild(el('rect', { x: 0, y: CARPET_Y, width: floorW, height: FLOOR_H - CARPET_Y,
          fill: '#301634', opacity: 0.16 }));
        tables.forEach((t) => {
          if (t.kind === 'closed') return;
          lightG.appendChild(el('rect', { x: t.x - 6, y: t.y - 6, width: TABLE_W + 12, height: TABLE_H + 12,
            fill: '#ff56b2', opacity: 0.10 }));
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

    /* ---------- 役者（毎フレーム組み直す） ---------- */
    function drawActors() {
      while (actG.firstChild) actG.removeChild(actG.firstChild);
      const c = live.clock;

      /* 座っている客。席番号を位相にして打牌の手を動かす（時刻だけから） */
      live.seated.forEach((g) => {
        g.seats.forEach((s, j) => {
          const p = seatPos(s.table, s.seat);
          if (!p) return;
          const frame = (Math.floor(c * 1.6 + (s.table * 4 + s.seat) * 0.7) % 3) === 0 ? 1 : 0;
          putGuest(g.look || g.typeKey, p.x, p.y, frame);
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
        const cx = Math.min(floorW - 9, 110), cy = 14, ph = Math.floor(c * 4) % 2;
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
      wrap.querySelector('[data-skip]').hidden = !live.playing || live.skipping;
      wrap.querySelector('.jnFlTicker').textContent = live.ticker || '';

      ui.innerHTML = '';
      const d = Math.round(11 * scale);          // 頭の直径。11 floor px（§4.5）
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
        tag.style.left = Math.min(floorW * scale - 28, Math.max(28, Math.round(p.x))) + 'px';
        tag.style.top = Math.round(p.y + 7 * scale) + 'px';
        ui.appendChild(tag);
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

    function paint() { drawLight(); drawActors(); drawUi(); drawHits(); }

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
        live.seated.set('p' + i, { typeKey: g.typeKey, count: 1, seats: [{ table: g.table, seat: g.seat }] });
      });
      /* スタッフは空いている席に。埋まっていれば通路に */
      const used = new Set((st.guests || []).map((g) => g.table + ':' + g.seat));
      const spots = [];
      tables.forEach((t, ti) => {
        if (t.kind === 'closed') return;
        seatsOf(t).forEach((s, si) => { if (!used.has(ti + ':' + si)) spots.push({ x: s.x + 1, y: s.y + 9 }); });
      });
      staffList.forEach((c, i) => {
        const p = spots[i] || { x: 10 + (i % 6) * 28, y: FLOOR_H - 18 };
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
    });

    let tid = null;
    const onResize = () => {
      clearTimeout(tid);
      tid = setTimeout(() => { buildRoom(); paint(); }, 120);
    };
    window.addEventListener('resize', onResize);

    return {
      el: wrap, render, play, setSpeed, skip, pause, resume,
      floorToScreen, screenToFloor,
      get scale() { return scale; },
      get floorW() { return floorW; },
      get playing() { return live.playing; },
      destroy() {
        live.playing = false;
        if (raf) cancelAnimationFrame(raf);
        window.removeEventListener('resize', onResize);
        wrap.remove();
      },
    };
  }

  return {
    mount, fit, layout, seatsOf, gridRects, build, slotStartTimes, spriteSvg, bottleSvg, insertEvent,
    drawWall, drawCarpet, drawFixtures, drawTable,
    PAL, FLOOR_H, FLOOR_W_MAX, TABLE_W, TABLE_H, SEAT_W, SEAT_H, COL_PITCH,
    WALL_H, CARPET_Y,
    SLOT_SEC, INTERMISSION, MAX_WALK, WALK_SEC, SWAP_SEC, SEATS_PER_TABLE,
  };
})();

if (typeof module !== 'undefined') {
  module.exports = { JansouFloor };
}
