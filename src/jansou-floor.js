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
    tableEdge: '#a668ce', tableMine: '#60a0e1', tableCall: '#ffce50',
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
  function drawWall(g, floorW, parlor) {
    g.appendChild(rect(0, 0, floorW, WALL_H, PAL.wall));
    g.appendChild(rect(0, WALL_H - 3, floorW, 3, PAL.wallLow));

    /* 壁の下端のLED。点線で色を回す */
    const led = [PAL.neonCyan, PAL.neonPink, PAL.neonYellow, PAL.neonGreen];
    for (let x = 1; x < floorW; x += 3) {
      g.appendChild(rect(x, WALL_H - 2, 1, 1, led[(x / 3 | 0) % led.length]));
    }

    /* 看板。SIGN の段階で灯りが増える（§10） */
    neon(g, 'GIRLS', 6, 3, PAL.neonPink, '#a01e64');
    if ((parlor.sign | 0) >= 2) neon(g, '*', 48, 3, PAL.neonYellow, '#a08a20');
    neon(g, 'MAHJONG', 58, 3, PAL.neonCyan, '#2080a0');

    /* ミラーボール（内装3から） */
    if ((parlor.interior | 0) >= 3) {
      const cx = Math.min(floorW - 9, 110), cy = 14;   // 看板の字に重ねない
      g.appendChild(rect(cx, 0, 1, cy - 5, '#6a5a70'));
      const ball = ['..###..', '.#####.', '#######', '#######', '#######', '.#####.', '..###..'];
      ball.forEach((line, y) => {
        for (let x = 0; x < line.length; x++) {
          if (line[x] !== '#') continue;
          const on = (x + y) % 2 === 0;
          g.appendChild(rect(cx - 3 + x, cy - 3 + y, 1, 1, on ? '#dceaff' : '#8898c0'));
        }
      });
    }

    /* 指名ランキングのパネル（金枠） */
    const px = 6, py = 16, pw = 40, ph = 15;
    g.appendChild(rect(px, py, pw, ph, PAL.gold));
    g.appendChild(rect(px + 1, py + 1, pw - 2, ph - 2, '#1c0c20'));
    const bars = [[PAL.neonYellow, 26], [PAL.neonCyan, 20], [PAL.neonGreen, 13]];
    bars.forEach((b, i) => g.appendChild(rect(px + 3, py + 4 + i * 4, b[1], 2, b[0])));
  }

  function drawCarpet(g, floorW) {
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

  /* 卓。kind は 'normal' | 'mine' | 'call' | 'closed' */
  function drawTable(g, t, kind) {
    const x = t.x, y = t.y;
    if (kind === 'closed') {
      g.appendChild(rect(x, y, TABLE_W, TABLE_H, PAL.closed));
      g.appendChild(rect(x + 3, y + 3, TABLE_W - 6, TABLE_H - 6, PAL.closedTop));
      return;
    }
    const edge = kind === 'mine' ? PAL.tableMine : kind === 'call' ? PAL.tableCall : PAL.tableEdge;
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
    /* 牌。4枚組を4つ */
    for (let i = 0; i < 4; i++) {
      const tx = x + 4 + i * 6;
      g.appendChild(rect(tx, y + 12, 4, 4, PAL.tile));
      g.appendChild(rect(tx, y + 16, 4, 1, PAL.tileLow));
    }
  }

  /* 床の設備。内装の段階で増えていく（§10。段階の作り込みは第五段） */
  function drawFixtures(g, floorW, parlor) {
    const lv = parlor.interior | 0;
    /* 入口のマット */
    g.appendChild(rect((floorW >> 1) - 16, FLOOR_H - 6, 32, 4, '#c86ab0'));
    /* ソファ席 */
    if (lv >= 2) {
      const sx = 3, sy = FLOOR_H - 30;
      g.appendChild(rect(sx, sy, 30, 18, '#b8508e'));
      g.appendChild(rect(sx + 1, sy + 3, 13, 13, '#d46aa8'));
      g.appendChild(rect(sx + 16, sy + 3, 13, 13, '#d46aa8'));
    }
    /* ドリンクカウンターとボトル棚 */
    if (lv >= 4) {
      const cx = floorW - 34, cy = FLOOR_H - 30;
      g.appendChild(rect(cx, cy, 31, 20, PAL.panel));
      g.appendChild(rect(cx + 1, cy + 1, 29, 5, '#6e3c64'));
      const cols = ['#96f0ff', '#ff56b2', '#ffe86e', '#96ffb4'];
      cols.forEach((c, i) => g.appendChild(rect(cx + 3 + i * 7, cy + 8, 5, 5, c)));
      for (let i = 0; i < 4; i++) {
        g.appendChild(rect(cx + 4 + i * 7, cy + 14, 3, 5, i % 2 ? '#dcd0c0' : '#c8a44a'));
      }
    }
    /* スタンド花 */
    if (lv >= 3) {
      [[floorW - 62, FLOOR_H - 26], [(floorW >> 1) - 34, FLOOR_H - 26]].forEach(([fx, fy]) => {
        g.appendChild(rect(fx + 3, fy + 8, 2, 12, '#e8dcc8'));
        g.appendChild(rect(fx, fy + 18, 8, 3, '#e8dcc8'));
        [[0, 0, '#ff9ec8'], [4, 1, '#ffe86e'], [2, 4, '#ff84a8'], [6, 5, '#96ffb4']].forEach(([dx, dy, c]) =>
          g.appendChild(rect(fx + dx, fy + dy, 2, 2, c)));
      });
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

  /* 足元の楕円影。床が明るいので全スプライトに敷く（§4.4） */
  function shadowRects(w) {
    return [rect(1, 0, w - 2, 1, PAL.shadow), rect(0, -1, w, 1, PAL.shadow)];
  }

  /* ============================================================
     組み立て
     ============================================================ */
  function mount(host, opts) {
    opts = opts || {};
    const root = host;
    const wrap = document.createElement('div');
    wrap.className = 'jnFloor';
    wrap.innerHTML =
      '<div class="jnFlTop"><span class="jnFlName">ガールズ雀荘 〜雀ドル亭〜</span>' +
      '<span class="jnFlDay"></span></div>' +
      '<div class="jnFlBar"><span class="jnFlSlot"></span>' +
      '<span class="jnFlTrack"><span class="jnFlFill"></span></span>' +
      '<span class="jnFlSales"></span><span class="jnFlSpeed"></span></div>' +
      '<div class="jnFlStage"><div class="jnFlUi"></div></div>' +
      '<div class="jnFlTicker"></div>';
    root.appendChild(wrap);

    const stage = wrap.querySelector('.jnFlStage');
    const ui = wrap.querySelector('.jnFlUi');
    let svg = null;
    let scale = 3, floorW = FLOOR_W_MAX;
    let last = null;

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

    function render(state) {
      last = state || last || {};
      const st = last;
      const parlor = st.parlor || {};
      measure();

      if (svg) svg.remove();
      svg = el('svg', {
        class: 'jnFlPix', viewBox: '0 0 ' + floorW + ' ' + FLOOR_H,
        width: floorW * scale, height: FLOOR_H * scale,
        'shape-rendering': 'crispEdges', 'aria-hidden': 'true',
      });
      const defs = el('defs', {});
      svg.appendChild(defs);

      /* 使う客タイプぶんだけ <g> を作って <use> で並べる */
      const made = {};
      function useGuest(typeKey, x, y, frame) {
        const t = G.BY_KEY[typeKey];
        if (!t) return;
        const id = 'jnc-' + typeKey + '-' + (frame || 0);
        if (!made[id]) {
          const gg = el('g', { id });
          gridRects(G.grid(typeKey, frame || 0), guestColor(t)).forEach((r) => gg.appendChild(r));
          defs.appendChild(gg);
          made[id] = true;
        }
        const sh = el('g', { transform: 'translate(' + x + ',' + (y + SEAT_H) + ')' });
        shadowRects(SEAT_W).forEach((r) => sh.appendChild(r));
        svg.appendChild(sh);
        svg.appendChild(el('use', { href: '#' + id, x, y }));
      }

      drawWall(svg, floorW, parlor);
      drawCarpet(svg, floorW);
      drawFixtures(svg, floorW, parlor);

      /* 卓 */
      const tables = layout(parlor.tables || 2, floorW);
      const closed = st.closedTables || 0;
      const mineIdx = st.myTable != null ? st.myTable : -1;
      tables.forEach((t, i) => {
        const kind = i >= tables.length - closed ? 'closed'
          : i === mineIdx ? 'mine'
            : st.callTable === i ? 'call' : 'normal';
        drawTable(svg, t, kind);
        t.kind = kind;
      });

      /* 客 */
      (st.guests || []).forEach((g0) => {
        const t = tables[g0.table];
        if (!t || t.kind === 'closed') return;
        const ss = seatsOf(t);
        const s = ss[g0.seat % ss.length];
        useGuest(g0.typeKey, s.x, s.y, g0.frame || 0);
      });

      /* スタッフ（B案）。体はここ、頭と名前札はUI層 */
      const staffBodyId = 'jns-body';
      if ((st.staff || []).length) {
        const gg = el('g', { id: staffBodyId });
        gridRects(STAFF_BODY, staffColor).forEach((r) => gg.appendChild(r));
        defs.appendChild(gg);
      }
      const spots = staffSpots(tables, floorW, (st.staff || []).length, st.guests);
      (st.staff || []).forEach((s, si) => {
        const p = spots[si];
        const sh = el('g', { transform: 'translate(' + p.x + ',' + (p.y + 7) + ')' });
        shadowRects(9).forEach((r) => sh.appendChild(r));
        svg.appendChild(sh);
        svg.appendChild(el('use', { href: '#' + staffBodyId, x: p.x, y: p.y }));
        s._x = p.x; s._y = p.y;
        /* 指名のハートは図形で描く（§4.6） */
        if (s.nominated) {
          HEART.forEach((line, y) => {
            for (let x = 0; x < line.length; x++) {
              if (line[x] === '#') svg.appendChild(rect(p.x + 8 + x, p.y - 13 + y, 1, 1, PAL.neonPink));
            }
          });
        }
      });

      stage.insertBefore(svg, ui);
      renderUi(st, tables);
    }

    /* スタッフの立ち位置。**空いている席に立たせる。**
       客と同じ場所に置くと丸写真が客に重なって、どちらも読めなくなる。
       席が全部埋まっていたら通路に立たせる */
    function staffSpots(tables, floorW, n, guests) {
      const used = new Set((guests || []).map((g) => g.table + ':' + g.seat));
      const free = [];
      tables.forEach((t, ti) => {
        if (t.kind === 'closed') return;
        seatsOf(t).forEach((s, si) => {
          /* 体（9×7）を席の枠の下端にそろえる。頭はその上に出る */
          if (!used.has(ti + ':' + si)) free.push({ x: s.x + 1, y: s.y + 9 });
        });
      });
      const aisleY = FLOOR_H - 18;
      for (let i = 0; free.length < n; i++) free.push({ x: 10 + (i % 6) * 28, y: aisleY });
      return free.slice(0, n).map((p) => ({
        x: Math.max(1, Math.min(floorW - 10, p.x)),
        y: Math.max(CARPET_Y + 12, p.y),
      }));
    }

    /* ---------- UI層（等倍のDOM。§4.2） ---------- */
    function renderUi(st, tables) {
      const parlor = st.parlor || {};
      wrap.querySelector('.jnFlDay').textContent = st.headNote ||
        ((parlor.day || 0) + '日目・' + (st.slotName ? st.slotName + '営業中' : '準備中'));
      wrap.querySelector('.jnFlSlot').textContent = st.slotName || '開店前';
      wrap.querySelector('.jnFlFill').style.width = Math.round((st.progress || 0) * 100) + '%';
      wrap.querySelector('.jnFlSales').innerHTML =
        '本日 <b>' + (st.sales || 0).toLocaleString('ja-JP') + '円</b>' +
        (st.extra ? '<i>＋臨時 ' + st.extra.toLocaleString('ja-JP') + '円</i>' : '');
      wrap.querySelector('.jnFlSpeed').innerHTML = [1, 2, 4].map((v) =>
        '<button type="button" class="jnFlSp' + (v === (parlor.speed || 1) ? ' on' : '') +
        '" data-speed="' + v + '">×' + v + '</button>').join('');
      wrap.querySelector('.jnFlTicker').textContent = st.ticker || '';

      /* スタッフの丸写真と名前札。座標は floorToScreen を通す */
      ui.innerHTML = '';
      const d = Math.round(11 * scale);          // 頭の直径。11 floor px（§4.5）
      (st.staff || []).forEach((s) => {
        if (s._x == null) return;
        const p = floorToScreen(s._x + 4.5, s._y - 1);
        const head = document.createElement('div');
        head.className = 'jnFlHead';
        head.style.left = Math.round(p.x - d / 2) + 'px';
        head.style.top = Math.round(p.y - d) + 'px';
        head.style.width = head.style.height = d + 'px';
        head.innerHTML = '<img src="img/' + String(s.id).padStart(3, '0') +
          '.webp" alt="" onerror="this.remove()">';
        ui.appendChild(head);

        const tag = document.createElement('span');
        tag.className = 'jnFlTag';
        tag.textContent = s.name;
        tag.style.left = Math.min(floorW * scale - 28, Math.max(28, Math.round(p.x))) + 'px';
        tag.style.top = Math.round(p.y + 7 * scale) + 'px';
        ui.appendChild(tag);
      });

      /* 満卓の札 */
      if (st.fullSlot) {
        const t = tables[0];
        if (t) {
          const p = floorToScreen(t.x - 10, t.y - 20);
          const b = document.createElement('span');
          b.className = 'jnFlFull';
          b.textContent = '満卓';
          b.style.left = Math.max(2, Math.round(p.x)) + 'px';
          b.style.top = Math.round(p.y) + 'px';
          ui.appendChild(b);
        }
      }
    }

    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-speed]');
      if (b && opts.onSpeed) opts.onSpeed(+b.dataset.speed);
    });

    let tid = null;
    const onResize = () => { clearTimeout(tid); tid = setTimeout(() => render(null), 120); };
    window.addEventListener('resize', onResize);

    return {
      el: wrap,
      render,
      floorToScreen,
      screenToFloor,
      get scale() { return scale; },
      get floorW() { return floorW; },
      destroy() { window.removeEventListener('resize', onResize); wrap.remove(); },
    };
  }

  return {
    mount, fit, layout, seatsOf, gridRects,
    PAL, FLOOR_H, FLOOR_W_MAX, TABLE_W, TABLE_H, SEAT_W, SEAT_H, COL_PITCH,
    WALL_H, CARPET_Y,
  };
})();

if (typeof module !== 'undefined') {
  module.exports = { JansouFloor };
}
