/* ============================================================
   事務所の部屋 — office-room.js（A6 第一段）
   依存：jansou-floor.js（描画の道具を借りる。office/room.md §3.1）
   使う側：office.js

   事務所の一室を **雀荘と同じ 200×164・同じ倍率** で描く。
   物を押すと各機能へ入る（名簿・ボード・メール・掲示・扉）。

   ------------------------------------------------------------
   借りるもの・借りないもの（room.md §3）
   ------------------------------------------------------------
   借りる … `el` `rect` `gridRects`（画素の描法）、`fit`（倍率）、
            寸法、`PAL`、`STAFF_BODY`（第四段）、`drawCarpet`（板張り）、
            `drawFixtures`（ソファ・観葉植物）、枠の CSS（`.jnFloor` 一式）
   借りない … `JansouFloor.mount()`。1,300行の再生機は部屋に要らない。
            擬似 `parlor` を食わせると `normalize()` の丸めが混ざる
            （遠征先の店で一度通った道）

   ------------------------------------------------------------
   決めごと
   ------------------------------------------------------------
   - **押せる物は全部 x 10〜190 の内側。部屋は横に送らせない**（§2.4）。
     380px では窓が 180 で既定の送りが 10 なので、この範囲は必ず見える
   - **画素の層に文字を置かない。**文字は当たり層（DOM）に出す
   - **`layout()` と `roomView()` は純関数。**`tools/test-office.js` が読む
   - **新しい色を増やさない。**`PAL` から取る。事務所の壁は `signOff`
     （灯っていないネオンの色＝雀荘の壁を一段起こしたもの）、床は板張り
   - **常時アニメは `clock` の位相だけから。乱数を混ぜない。形を動かさない**
     （第一段では何も動かない。第二段で PC の光と窓の雲）
   ============================================================ */

const OfficeRoom = (() => {
  'use strict';

  const F = typeof JansouFloor !== 'undefined' ? JansouFloor : null;
  const PAL = F ? F.PAL : {};
  const W = F ? F.FLOOR_W : 200;
  const H = F ? F.FLOOR_H : 164;
  const WALL_H = F ? F.WALL_H : 35;
  const CARPET_Y = F ? F.CARPET_Y : 37;

  /* 押せる物を置いてよい範囲（§2.4）。380px の窓 180 ＋ 既定の送り 10 */
  const SAFE = { x0: 10, x1: 190 };
  /* 当たりの最小（floor px）。倍率2で 44px（§2.3） */
  const HIT_MIN = 22;
  /* 押せる物どうしの当たりの間隔（floor px） */
  const HIT_GAP = 4;

  /* ---------- 見取り図（room.md §2.2）。純関数 ----------
     tap … 押したときの鍵。無ければ飾り（当たりを持たない）。
     **タイムカードは置かない。**「今日を始める」は下の帯にあり、部屋の中に
     もう一つ置くと、何の物か分からない箱が一つ増えるだけだった（実機で見た） */
  function layout() {
    return [
      { key: 'eight',  x: 14,  y: 4,   w: 48, h: 26, tap: 'eight', name: '雀エイトの額' },
      { key: 'cert',   x: 66,  y: 8,   w: 8,  h: 18, tap: null,    name: '段位の賞状' },
      { key: 'window', x: 80,  y: 3,   w: 34, h: 26, tap: null,    name: '窓' },
      { key: 'board',  x: 126, y: 3,   w: 62, h: 28, tap: 'board', name: 'ホワイトボード' },
      { key: 'pc',     x: 12,  y: 44,  w: 48, h: 32, tap: 'mail',  name: 'パソコン' },
      { key: 'desk',   x: 70,  y: 84,  w: 60, h: 30, tap: 'desk',  name: '事務机' },
      { key: 'sofa',   x: 140, y: 62,  w: 24, h: 24, tap: null,    name: 'ソファ' },
      { key: 'plant',  x: 180, y: 126, w: 8,  h: 16, tap: null,    name: '観葉植物' },
      { key: 'door',   x: 88,  y: 138, w: 24, h: 25, tap: 'door',  name: '扉' },
    ];
  }

  /* 当たりの矩形。絵より小さければ中心から HIT_MIN まで広げる。純関数 */
  function hitOf(it) {
    const w = Math.max(HIT_MIN, it.w), h = Math.max(HIT_MIN, it.h);
    return { x: Math.round(it.x + it.w / 2 - w / 2), y: Math.round(it.y + it.h / 2 - h / 2), w, h };
  }

  /* ---------- 部屋の見え方（room.md §5）。純関数 ----------
     第一段で読むのは朝／夜と店の有無だけ。印（未読・付箋・額の金）は第二段。
     **ここで返さないものは描かない**——描く条件をテストで固定するため */
  function roomView(st, ctx) {
    st = st || {}; ctx = ctx || {};
    const parlor = st.parlor || {};
    return {
      night: !!ctx.night,
      open: !!parlor.open,
      trip: !!(st.trip && st.trip.dayLeft > 0),
    };
  }

  /* ============================================================
     描く
     ============================================================ */
  const el = (name, attrs) => F.el(name, attrs);
  const rect = (x, y, w, h, fill) => F.rect(x, y, w, h, fill);

  /* 事務所の壁。雀荘の壁（`PAL.wall`）を一段起こした `signOff`。
     **雀荘の drawWall は借りない**——ネオンの看板と貼り紙は事務所に要らない */
  function drawRoomWall(g) {
    g.appendChild(rect(0, 0, W, WALL_H, PAL.signOff));
    g.appendChild(rect(0, WALL_H - 3, W, 3, PAL.wall));
    /* 腰板。板張りの床と同じ木で、上下を一つの部屋に見せる */
    g.appendChild(rect(0, WALL_H - 6, W, 3, PAL.tableWood));
  }

  /* 雀エイトの額（48×26）。金の額縁に八つの小さな写真の枠 */
  function drawEight(g, it, view) {
    g.appendChild(rect(it.x, it.y, it.w, it.h, PAL.ink));
    g.appendChild(rect(it.x + 1, it.y + 1, it.w - 2, it.h - 2, PAL.gold));
    g.appendChild(rect(it.x + 3, it.y + 3, it.w - 6, it.h - 6, PAL.panel));
    /* 八人の枠。2段×4。第二段で「うちの子」が金に灯る */
    for (let i = 0; i < 8; i++) {
      const cx = it.x + 6 + (i % 4) * 10, cy = it.y + 5 + Math.floor(i / 4) * 9;
      g.appendChild(rect(cx, cy, 8, 7, PAL.closedTop));
      g.appendChild(rect(cx + 2, cy + 1, 4, 3, PAL.tileLow));
      g.appendChild(rect(cx + 1, cy + 5, 6, 2, PAL.closed));
    }
    /* 題字の帯（文字は置かない。金の細い帯だけ） */
    g.appendChild(rect(it.x + 6, it.y + it.h - 3, it.w - 12, 1, PAL.goldHi));
  }

  /* 段位の賞状（8×18）。押せない。朱の印が一つ */
  function drawCert(g, it) {
    g.appendChild(rect(it.x, it.y, it.w, it.h, PAL.ink));
    g.appendChild(rect(it.x + 1, it.y + 1, it.w - 2, it.h - 2, PAL.tile));
    g.appendChild(rect(it.x + 2, it.y + 4, it.w - 4, 1, PAL.tileLow));
    g.appendChild(rect(it.x + 2, it.y + 7, it.w - 4, 1, PAL.tileLow));
    g.appendChild(rect(it.x + 2, it.y + 10, it.w - 4, 1, PAL.tileLow));
    g.appendChild(rect(it.x + 3, it.y + 13, 2, 2, PAL.feltLow));
  }

  /* 窓（34×26）。朝は金の空、夜は紺と月 */
  function drawWindow(g, it, view) {
    g.appendChild(rect(it.x, it.y, it.w, it.h, PAL.ink));
    if (view.night) {
      g.appendChild(rect(it.x + 2, it.y + 2, it.w - 4, it.h - 4, PAL.night));
      g.appendChild(rect(it.x + it.w - 11, it.y + 5, 5, 5, PAL.tile));
      g.appendChild(rect(it.x + it.w - 10, it.y + 6, 3, 3, PAL.goldHi));
      g.appendChild(rect(it.x + 5, it.y + 9, 1, 1, PAL.tileLow));
      g.appendChild(rect(it.x + 11, it.y + 14, 1, 1, PAL.tileLow));
    } else {
      g.appendChild(rect(it.x + 2, it.y + 2, it.w - 4, it.h - 4, PAL.goldHi));
      g.appendChild(rect(it.x + 2, it.y + 2, it.w - 4, 7, PAL.neonYellow));
      g.appendChild(rect(it.x + 2, it.y + it.h - 8, it.w - 4, 6, PAL.gold));
      /* 雲。第二段で `clock` の位相だけで流す */
      g.appendChild(rect(it.x + 6, it.y + 7, 9, 3, PAL.tile));
      g.appendChild(rect(it.x + 18, it.y + 12, 11, 3, PAL.tile));
    }
    /* 桟 */
    g.appendChild(rect(it.x + Math.floor(it.w / 2), it.y + 2, 2, it.h - 4, PAL.ink));
    g.appendChild(rect(it.x + 2, it.y + Math.floor(it.h / 2), it.w - 4, 2, PAL.ink));
  }

  /* ホワイトボード（62×28）。白い面に三本の列線。磁石は第三段 */
  function drawBoard(g, it) {
    g.appendChild(rect(it.x, it.y, it.w, it.h, PAL.ink));
    g.appendChild(rect(it.x + 1, it.y + 1, it.w - 2, it.h - 2, PAL.tileLow));
    g.appendChild(rect(it.x + 2, it.y + 2, it.w - 4, it.h - 4, PAL.tile));
    /* 見出しの帯（店／休み／出）。文字は置かない */
    g.appendChild(rect(it.x + 4, it.y + 4, it.w - 8, 3, PAL.neonPink));
    const col = Math.floor((it.w - 8) / 3);
    for (let i = 1; i < 3; i++) g.appendChild(rect(it.x + 4 + i * col, it.y + 4, 1, it.h - 8, PAL.tileLow));
    /* 行線（昼／夕／夜） */
    for (let i = 1; i < 4; i++) g.appendChild(rect(it.x + 4, it.y + 7 + i * 5, it.w - 8, 1, PAL.tileLow));
    /* ペン受け */
    g.appendChild(rect(it.x + 10, it.y + it.h - 2, it.w - 20, 2, PAL.closed));
    g.appendChild(rect(it.x + 14, it.y + it.h - 3, 6, 1, PAL.neonCyan));
  }

  /* パソコンの机（48×32）。机の上に本体と画面。第二段で画面が光る */
  function drawPc(g, it, view) {
    const dx = it.x, dy = it.y + it.h - 14;
    /* 机 */
    g.appendChild(rect(dx, dy, it.w, 12, PAL.tableWood));
    g.appendChild(rect(dx, dy, it.w, 2, PAL.plankGrain));
    g.appendChild(rect(dx + 2, dy + 12, 3, 2, PAL.ink));
    g.appendChild(rect(dx + it.w - 5, dy + 12, 3, 2, PAL.ink));
    /* 画面（20×16）。縁は暗く、面は消えた色 */
    const mx = dx + 10, my = it.y + 2;
    g.appendChild(rect(mx, my, 22, 17, PAL.ink));
    g.appendChild(rect(mx + 2, my + 2, 18, 12, view.night ? PAL.closed : PAL.closedTop));
    g.appendChild(rect(mx + 4, my + 4, 10, 1, PAL.tileLow));
    g.appendChild(rect(mx + 4, my + 7, 13, 1, PAL.tileLow));
    g.appendChild(rect(mx + 4, my + 10, 8, 1, PAL.tileLow));
    /* 脚と台 */
    g.appendChild(rect(mx + 9, my + 17, 4, 2, PAL.ink));
    g.appendChild(rect(mx + 6, my + 19, 10, 1, PAL.ink));
    /* キーボードと湯呑み */
    g.appendChild(rect(dx + 8, dy + 4, 20, 4, PAL.closedTop));
    g.appendChild(rect(dx + 9, dy + 5, 18, 2, PAL.closed));
    g.appendChild(rect(dx + 36, dy + 3, 5, 5, PAL.tile));
    g.appendChild(rect(dx + 37, dy + 3, 3, 1, PAL.neonGreen));
  }

  /* 事務机（60×30）。名簿と写真立て、ハンコ。第二段で付箋 */
  function drawDesk(g, it) {
    g.appendChild(rect(it.x, it.y + 6, it.w, it.h - 10, PAL.tableWood));
    g.appendChild(rect(it.x, it.y + 6, it.w, 2, PAL.plankGrain));
    g.appendChild(rect(it.x + 2, it.y + it.h - 4, 4, 4, PAL.ink));
    g.appendChild(rect(it.x + it.w - 6, it.y + it.h - 4, 4, 4, PAL.ink));
    /* 名簿（開いた台帳） */
    g.appendChild(rect(it.x + 6, it.y + 9, 24, 14, PAL.ink));
    g.appendChild(rect(it.x + 7, it.y + 10, 11, 12, PAL.tile));
    g.appendChild(rect(it.x + 19, it.y + 10, 10, 12, PAL.tile));
    for (let i = 0; i < 3; i++) {
      g.appendChild(rect(it.x + 9, it.y + 12 + i * 3, 7, 1, PAL.tileLow));
      g.appendChild(rect(it.x + 21, it.y + 12 + i * 3, 6, 1, PAL.tileLow));
    }
    /* 写真立て（三つ。制服の色） */
    for (let i = 0; i < 3; i++) {
      const px = it.x + 34 + i * 8, py = it.y + 1;
      g.appendChild(rect(px, py, 7, 9, PAL.ink));
      g.appendChild(rect(px + 1, py + 1, 5, 7, PAL.tileLow));
      g.appendChild(rect(px + 2, py + 2, 3, 2, PAL.tile));
      g.appendChild(rect(px + 2, py + 5, 3, 2, PAL.staffCloth));
    }
    /* ハンコと朱肉 */
    g.appendChild(rect(it.x + 36, it.y + 14, 6, 6, PAL.feltLow));
    g.appendChild(rect(it.x + 44, it.y + 12, 3, 8, PAL.ink));
    g.appendChild(rect(it.x + 44, it.y + 12, 3, 2, PAL.feltLow));
    /* 電話 */
    g.appendChild(rect(it.x + 50, it.y + 12, 7, 8, PAL.ink));
    g.appendChild(rect(it.x + 51, it.y + 14, 5, 4, PAL.closed));
  }

  /* 扉（24×25）。下の階へ降りる。雀荘の入口と同じ x の帯 */
  function drawDoor(g, it, view) {
    g.appendChild(rect(it.x - 2, it.y - 2, it.w + 4, it.h + 2, PAL.ink));
    g.appendChild(rect(it.x, it.y, it.w, it.h, PAL.tableWood));
    g.appendChild(rect(it.x + 3, it.y + 3, it.w - 6, 8, PAL.plankGrain));
    g.appendChild(rect(it.x + 3, it.y + 13, it.w - 6, 8, PAL.plankGrain));
    g.appendChild(rect(it.x + it.w - 6, it.y + 12, 2, 2, PAL.gold));
    /* 上の階だと分かる札。店が無ければ暗い札 */
    g.appendChild(rect(it.x + 4, it.y - 7, it.w - 8, 5, PAL.ink));
    g.appendChild(rect(it.x + 5, it.y - 6, it.w - 10, 3, view.open ? PAL.neonPink : PAL.closed));
  }

  /* 夜の膜と机のランプ（room.md §6）。雀荘の drawLight の夜と同じ手 */
  function drawNight(g, items) {
    g.appendChild(el('rect', { x: 0, y: 0, width: W, height: H, fill: PAL.night, opacity: 0.42 }));
    const desk = items.find((it) => it.key === 'desk');
    if (desk) {
      g.appendChild(el('rect', { x: desk.x - 6, y: desk.y - 10, width: desk.w + 12, height: desk.h + 16,
        fill: PAL.goldHi, opacity: 0.16 }));
      /* ランプ本体 */
      g.appendChild(rect(desk.x + it0(desk), desk.y - 4, 6, 3, PAL.goldHi));
      g.appendChild(rect(desk.x + it0(desk) + 2, desk.y - 1, 2, 7, PAL.ink));
    }
  }
  const it0 = (desk) => desk.w - 12;

  /* ---------- 一枚描く ---------- */
  function drawRoom(svg, view) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const g = el('g', { 'shape-rendering': 'crispEdges' });
    svg.appendChild(g);
    const items = layout();
    drawRoomWall(g);
    /* 床は雀荘の板張りそのもの。内装1で板張りになる（§10） */
    F.drawCarpet(g, { interior: 1 }, PAL);
    items.forEach((it) => {
      switch (it.key) {
        case 'eight': drawEight(g, it, view); break;
        case 'cert': drawCert(g, it); break;
        case 'window': drawWindow(g, it, view); break;
        case 'board': drawBoard(g, it); break;
        case 'pc': drawPc(g, it, view); break;
        case 'desk': drawDesk(g, it); break;
        case 'door': drawDoor(g, it, view); break;
        default: break;
      }
    });
    /* ソファと観葉植物は雀荘の設置物の絵をそのまま借りる（マス単位） */
    const sofa = items.find((it) => it.key === 'sofa');
    const plant = items.find((it) => it.key === 'plant');
    const toCell = (it) => ({ x: Math.round((it.x - F.GX0) / F.GRID), y: Math.round((it.y - F.GY0) / F.GRID) });
    F.drawFixtures(g, { items: [
      Object.assign({ id: 1, kind: 'sofa' }, toCell(sofa)),
      Object.assign({ id: 2, kind: 'plant' }, toCell(plant)),
    ] }, { interior: 1 }, PAL);
    if (view.night) drawNight(g, items);
  }

  /* ============================================================
     枠（雀荘の .jnFloor と同じ三段。room.md §2.1）
     ============================================================ */
  /* 押せる物の札。**文字は当たり層にだけ置く**（画素の層には置かない）。
     雀荘がスタッフに名前札を付けているのと同じ札（`.jnFlTag`）。
     絵だけでは「額」と「机」が押せるかどうか読めなかった（実機で見た）ので、
     押せる物には必ず札を付ける。**飾りには付けない**——札の有無が
     「押せるかどうか」そのものになる */
  const TAGS = { eight: '雀エイト', board: 'ボード', mail: 'メール', desk: '名簿', door: '出かける' };

  /* opts
       title … 上の帯（事務所名）
       sub   … 上の帯の右（県・N日目の朝）
       tags  … 押せる物の札。false で消す。既定は TAGS */
  function mount(host, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.className = 'jnFloor bare ofRoom';
    wrap.innerHTML =
      '<div class="jnFlTop"><span class="jnFlName"></span><span class="jnFlDay"></span></div>' +
      '<div class="jnFlStage"><div class="jnFlUi"></div><div class="ofRoomHits"></div></div>' +
      '<div class="ofRoomBand"></div>';
    host.appendChild(wrap);
    wrap.querySelector('.jnFlName').textContent = opts.title || '事務所';
    wrap.querySelector('.jnFlDay').textContent = opts.sub || '';

    const stage = wrap.querySelector('.jnFlStage');
    const ui = wrap.querySelector('.jnFlUi');
    const hits = wrap.querySelector('.ofRoomHits');
    const band = wrap.querySelector('.ofRoomBand');
    let svg = null;
    let scale = 2, floorW = W, panX = 0;
    let view = { night: false, open: false, trip: false };
    const handlers = {};
    let raf = 0;
    const live = { clock: 0, t0: 0 };

    function floorToScreen(fx, fy) { return { x: (fx - panX) * scale, y: fy * scale }; }

    function measure() {
      const availW = Math.max(160, (host.parentNode ? host.clientWidth : 0) || wrap.clientWidth || 360);
      const f = F.fit(availW);
      scale = f.scale; floorW = f.floorW;
      /* 部屋は送らせない。既定の中央で固定（§2.4） */
      panX = Math.round(Math.max(0, W - floorW) / 2);
      stage.style.width = (floorW * scale) + 'px';
      stage.style.height = (H * scale) + 'px';
      if (svg) {
        svg.setAttribute('width', W * scale);
        svg.setAttribute('height', H * scale);
        svg.style.left = (-panX * scale) + 'px';
      }
      placeHits();
    }

    function placeHits() {
      hits.innerHTML = '';
      /* 札も置き直す。**resize で足しっぱなしにすると二重に出る**（実際に出た） */
      ui.querySelectorAll('.ofRoomTag').forEach((t) => t.remove());
      layout().forEach((it) => {
        if (!it.tap) return;
        const r = hitOf(it);
        const p = floorToScreen(r.x, r.y);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ofRoomHit';
        b.dataset.tap = it.tap;
        b.setAttribute('aria-label', it.name);
        b.style.left = p.x + 'px'; b.style.top = p.y + 'px';
        b.style.width = (r.w * scale) + 'px'; b.style.height = (r.h * scale) + 'px';
        b.addEventListener('click', () => { if (handlers[it.tap]) handlers[it.tap](it); });
        hits.appendChild(b);
        if (opts.tags !== false) {
          const tags = opts.tags || TAGS;
          const t = document.createElement('span');
          t.className = 'jnFlTag ofRoomTag';
          t.textContent = tags[it.tap] || it.name;
          /* 下に出す。下辺の物（扉）は上に */
          const below = it.y + it.h + 9 <= H;
          const q = floorToScreen(it.x + it.w / 2, below ? it.y + it.h : it.y);
          t.style.left = q.x + 'px';
          if (below) t.style.top = (q.y + 2) + 'px';
          else t.style.bottom = ((H - it.y) * scale + 2) + 'px';
          ui.appendChild(t);
        }
      });
    }

    function render(v) {
      view = Object.assign({}, view, v || {});
      if (!svg) {
        svg = el('svg', { class: 'jnFlPix', viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true' });
        stage.insertBefore(svg, ui);
      }
      ui.innerHTML = '';
      measure();
      drawRoom(svg, view);
      wrap.classList.toggle('night', !!view.night);
    }

    /* 常時アニメの時計。第一段では描き直すものが無いので、時計だけ進む */
    function idle() {
      cancelAnimationFrame(raf);
      live.t0 = performance.now();
      const tick = (now) => {
        if (!wrap.isConnected) return;
        live.clock = (now - live.t0) / 1000;
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    function destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }
    function onResize() { if (wrap.isConnected) measure(); }
    window.addEventListener('resize', onResize);

    return {
      render, idle, destroy,
      on: (key, fn) => { handlers[key] = fn; },
      band,
      setTop: (title, sub) => {
        wrap.querySelector('.jnFlName').textContent = title || '';
        wrap.querySelector('.jnFlDay').textContent = sub || '';
      },
    };
  }

  return { mount, layout, hitOf, roomView, TAGS, SAFE, HIT_MIN, HIT_GAP, W, H };
})();

if (typeof module !== 'undefined') {
  module.exports = { OfficeRoom };
}
