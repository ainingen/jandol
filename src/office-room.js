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

  /* ---------- 人の立ち位置（room.md §10 第四段）。純関数 ----------
     **事務所に女の子がいなければ、それは事務所ではなく管理画面になる。**

     出勤の子は**扉の脇**、休みの子は**ソファ**。遠征・依頼の子は**いない**
     （不在そのものが絵になる）。机と扉のあいだの床は、ここに立たせるために
     空けてあった（§2.2）。

     並びは**扉に近いほうから左右交互**。左右に振るのは、片側だけ伸びると
     「行列」に見えて、事務所ではなく順番待ちになるため。
     `[x, y]` は体（9×7）の左上。頭（11px）はその上に乗る */
  const DUTY_SPOTS = [
    /* 前列は片側4人まで。**5人目からは後列**——片側5人並ぶと
       「行列」に見えて、集合写真ではなく順番待ちになる（14人の絵で見た） */
    [64, 134], [118, 134], [52, 134], [130, 134], [40, 134], [142, 134], [28, 134], [154, 134],
    [58, 118], [134, 118], [46, 118], [146, 118], [34, 118], [158, 118], [22, 118],
    [16, 134], [166, 134],
  ];
  /* ソファ（x140〜164・y62〜86）。座るのは二人まで、あとは脇に立つ */
  const REST_SPOTS = [
    [141, 68, true], [153, 68, true], [168, 78, false], [131, 74, false],
  ];
  /* 夜に一人だけ残る子（`room.md` §6）。**机の向こう＝ランプの下**に立たせる。
     ソファにも置いてみたが、灯りが机にしかないので**暗がりに座っている**だけに
     見えた。残業は「まだ仕事をしている」なので、机で書いているほうが読める */
  const LATE_SPOT = [96, 76];

  /* 何人まで部屋に出すか（§10 第四段の実測）。
     超えたぶんは出さず、下の帯に「ほか N 人」と出す——
     **描かないより、いないことにするほうが嘘になる**ので、数は必ず言う */
  const MAX_DUTY = DUTY_SPOTS.length;
  const MAX_REST = REST_SPOTS.length;

  /* 人 → 立ち位置。純関数。**並びは id 順で固定**（毎朝入れ替わると、
     誰がどこにいるかを覚えられない。雀エイトの「同点は id で固定」と同じ話） */
  function spotsFor(people) {
    const out = [];
    let d = 0, r = 0;
    (people || []).forEach((p) => {
      if (p.where === 'late') {
        out.push({ id: p.id, where: 'late', x: LATE_SPOT[0], y: LATE_SPOT[1], sit: false, over: false });
      } else if (p.where === 'rest') {
        if (r >= REST_SPOTS.length) { out.push({ id: p.id, where: p.where, over: true }); return; }
        const s = REST_SPOTS[r++];
        out.push({ id: p.id, where: 'rest', x: s[0], y: s[1], sit: s[2], over: false });
      } else {
        if (d >= DUTY_SPOTS.length) { out.push({ id: p.id, where: p.where, over: true }); return; }
        const s = DUTY_SPOTS[d++];
        out.push({ id: p.id, where: 'duty', x: s[0], y: s[1], sit: false, over: false });
      }
    });
    return out;
  }

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
    /* 部屋にいる人（第四段）。**誰がいるかは office.js が決める**
       （`Office.roomPeopleOf`。`assign` の解釈は向こうが持っている）。
       ここがやるのは**どこに立つか**だけ */
    const people = spotsFor(ctx.people || []);
    /* 未読（第二段）。**セーブの中だけで決まる**ので、ここで数える。
       疲労と雀エイトは `Office` を引かないと分からないので、
       office.js が `ctx` で渡す（人と同じ分担） */
    const read = st.mailRead || [];
    const unread = (st.offers || []).filter((o) => read.indexOf(o.id) < 0).length;
    return {
      night: !!ctx.night,
      open: !!parlor.open,
      trip: !!(st.trip && st.trip.dayLeft > 0),
      people,
      /* 出しきれなかった人数。下の帯に出す */
      over: people.filter((p) => p.over).length,
      /* 誰かが出ている（遠征・依頼）。扉の脇に鞄を置く印になる */
      away: !!ctx.away,
      /* ---- 印（§5） ---- */
      /* 今日の並び（第三段）。**壁の板は読むだけ**なので、要るのは数だけ */
      board: ctx.board || { slots: [0, 0, 0], rest: 0, away: 0 },
      unread,                       // パソコンの画面が光る＋件数
      tired: !!ctx.tired,           // 机に赤い付箋
      mine8: !!ctx.mine8,           // 額が金になる
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

  /* 雀エイトの額（48×26）。八つの小さな写真の枠。
     **額縁は普段は木。金になるのは「うちの子が入っている」ときだけ**（§5）——
     いつも金だと、金であることが何も言っていない */
  function drawEight(g, it, view) {
    const mine = !!view.mine8;
    g.appendChild(rect(it.x, it.y, it.w, it.h, PAL.ink));
    g.appendChild(rect(it.x + 1, it.y + 1, it.w - 2, it.h - 2, mine ? PAL.goldHi : PAL.tableWood));
    if (mine) g.appendChild(rect(it.x + 2, it.y + 2, it.w - 4, it.h - 4, PAL.gold));
    g.appendChild(rect(it.x + 3, it.y + 3, it.w - 6, it.h - 6, PAL.panel));
    for (let i = 0; i < 8; i++) {
      const cx = it.x + 6 + (i % 4) * 10, cy = it.y + 5 + Math.floor(i / 4) * 9;
      /* うちの子は一枠だけ金で縁取る（表の中の「金で縁取られる」と同じ言いかた） */
      const own = mine && i === 0;
      g.appendChild(rect(cx - (own ? 1 : 0), cy - (own ? 1 : 0),
        8 + (own ? 2 : 0), 7 + (own ? 2 : 0), own ? PAL.goldHi : PAL.closedTop));
      g.appendChild(rect(cx + 2, cy + 1, 4, 3, PAL.tileLow));
      g.appendChild(rect(cx + 1, cy + 5, 6, 2, PAL.closed));
    }
    g.appendChild(rect(it.x + 6, it.y + it.h - 3, it.w - 12, 1, mine ? PAL.goldHi : PAL.closed));
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

  /* ホワイトボード（62×28）。**今日の並びを一目で言うだけの板**（第三段）。
     動かすのはボードのシートの中——**壁の板は読むもの、シートが操作**。

     **写真の丸は載せない。**11px の丸は 62px の板に5つしか並ばず、
     14人だと二段でも足りない。しかも 380px（倍率2）では 22px の丸で、
     **顔として読めない**（実機で並べて見た。§10 第三段）。
     板に要るのは「誰か」ではなく「何人がどこか」で、誰かは部屋の人が言っている。

     四行。上から**昼・夕・夜**（出勤している人数ぶんの印）と、
     **休み・出**（灰と金）。左端の色札が行の意味を持つ */
  /* **癖の印と同じ三色**（シアン・黄・ピンク）。2ドットでも見分けられることが
     四型の店で確かめてある色なので、3px の点でも効く。
     黄と金は近すぎて並べると分からなかった（実機で見た） */
  const BOARD_ROWS = [
    { key: 0, col: 'neonCyan' }, { key: 1, col: 'neonYellow' }, { key: 2, col: 'neonPink' },
  ];
  function drawBoard(g, it, view) {
    const b = view.board || { slots: [0, 0, 0], rest: 0, away: 0 };
    g.appendChild(rect(it.x, it.y, it.w, it.h, PAL.ink));
    g.appendChild(rect(it.x + 1, it.y + 1, it.w - 2, it.h - 2, PAL.tileLow));
    g.appendChild(rect(it.x + 2, it.y + 2, it.w - 4, it.h - 4, PAL.tile));
    const x0 = it.x + 4, dx = it.x + 12, max = Math.floor((it.w - 16) / 3);
    const dot = (n, y, col) => {
      for (let i = 0; i < Math.min(n, max); i++) {
        g.appendChild(rect(dx + i * 3, y, 2, 3, col));
      }
      /* 入りきらないぶんは末尾を切って、切れたことを一つの点で言う */
      if (n > max) g.appendChild(rect(dx + max * 3, y, 1, 3, PAL.ink));
    };
    /* **行ごとに色を変える。**長さだけで分けると、どの行が何の帯なのかを
       左端の5pxの札だけで見分けることになる（実機で並べたら分からなかった）。
       色と長さの二つで言う——癖の印で覚えたことと同じ */
    BOARD_ROWS.forEach((r, i) => {
      const y = it.y + 5 + i * 4;
      g.appendChild(rect(x0, y, 5, 3, PAL[r.col]));
      dot(b.slots[r.key] | 0, y, PAL[r.col]);
    });
    /* 四行目は休み（灰）と出（金）。**同じ行に並べる**——どちらも「店にいない」 */
    const y3 = it.y + 5 + 3 * 4;
    g.appendChild(rect(x0, y3, 5, 3, PAL.closed));
    dot(b.rest | 0, y3, PAL.closedTop);
    for (let i = 0; i < Math.min(b.away | 0, 4); i++) {
      g.appendChild(rect(dx + (Math.min(b.rest | 0, max) + i) * 3, y3, 2, 3, PAL.gold));
    }
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
    /* **未読があれば画面が点いている**（§5）。消えていれば灰。
       光の明滅は `lightG` が持つ——形は動かさない、明るさだけ */
    const on = view.unread > 0 && !view.night;
    g.appendChild(rect(mx, my, 22, 17, PAL.ink));
    g.appendChild(rect(mx + 2, my + 2, 18, 12, on ? PAL.night : view.night ? PAL.closed : PAL.closedTop));
    g.appendChild(rect(mx + 4, my + 4, 10, 1, on ? PAL.neonCyan : PAL.tileLow));
    g.appendChild(rect(mx + 4, my + 7, 13, 1, on ? PAL.neonCyan : PAL.tileLow));
    g.appendChild(rect(mx + 4, my + 10, 8, 1, on ? PAL.neonCyan : PAL.tileLow));
    /* 封筒の印。**画面の中に置く**ので、光っているのが何の光かが分かる */
    if (on) {
      g.appendChild(rect(mx + 15, my + 8, 5, 4, PAL.tile));
      g.appendChild(rect(mx + 15, my + 8, 5, 1, PAL.neonCyan));
    }
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

  /* 疲れている子がいる印（§5）。**机に赤い付箋を一枚。**
     人数は出さない——名簿を開けば誰かは分かるので、ここは「見にいく理由」だけ。
     台帳の上に貼るので、名簿とつながって見える */
  function drawNote(g, desk) {
    const x = desk.x + 10, y = desk.y + 6;
    g.appendChild(rect(x - 1, y - 1, 10, 9, PAL.ink));
    g.appendChild(rect(x, y, 8, 7, PAL.felt));
    g.appendChild(rect(x, y, 8, 2, PAL.feltTop));
    g.appendChild(rect(x + 2, y + 4, 4, 1, PAL.tile));
  }

  /* 扉（24×25）。下の階へ降りる。雀荘の入口と同じ x の帯 */
  function drawDoor(g, it, view) {
    g.appendChild(rect(it.x - 2, it.y - 2, it.w + 4, it.h + 2, PAL.ink));
    g.appendChild(rect(it.x, it.y, it.w, it.h, PAL.tableWood));
    g.appendChild(rect(it.x + 3, it.y + 3, it.w - 6, 8, PAL.plankGrain));
    g.appendChild(rect(it.x + 3, it.y + 13, it.w - 6, 8, PAL.plankGrain));
    g.appendChild(rect(it.x + it.w - 6, it.y + 12, 2, 2, PAL.gold));
    /* 下の階の看板。**店があればネオンが点き、無ければ消えている**（§5）。
       消えているだけでは「まだ持っていない」と読めないので、
       **扉に貸店舗の貼り紙**を足す——これで空き店舗だと分かる */
    g.appendChild(rect(it.x + 4, it.y - 7, it.w - 8, 5, PAL.ink));
    g.appendChild(rect(it.x + 5, it.y - 6, it.w - 10, 3, view.open ? PAL.neonPink : PAL.closed));
    if (!view.open) {
      g.appendChild(rect(it.x + 7, it.y + 6, 10, 12, PAL.ink));
      g.appendChild(rect(it.x + 8, it.y + 7, 8, 10, PAL.tile));
      for (let i = 0; i < 3; i++) g.appendChild(rect(it.x + 10, it.y + 9 + i * 3, 4, 1, PAL.closed));
    }
  }

  /* ---------- 人（第四段） ----------
     **雀荘で制服を着て歩いている、あの体そのもの**（`STAFF_BODY`）。
     同じスプライトが上の階に立っているのが、地続きのいちばん強い形。
     顔は写真の丸（`.jnFlHead`）を当たり層に置く——雀荘のフロアと同じ作り。

     **体は `<use>` で使い回す。**14人ぶんを毎回 rect で描くと400枚を超える */
  function bodyDef(defs) {
    const g = el('g', { id: 'ofr-body' });
    F.gridRects(F.STAFF_BODY, F.staffColor).forEach((r) => g.appendChild(r));
    defs.appendChild(g);
  }
  function drawPeople(g, view) {
    (view.people || []).forEach((p) => {
      if (p.over) return;
      /* 足元の影。**座っている子には敷かない**（浮いて見える） */
      if (!p.sit) {
        g.appendChild(rect(p.x + 1, p.y + 7, 7, 1, PAL.shadow));
        g.appendChild(rect(p.x, p.y + 8, 9, 1, PAL.shadow));
      }
      g.appendChild(el('use', { href: '#ofr-body', x: p.x, y: p.y }));
    });
  }

  /* 出ている子がいる印（遠征・依頼）。**扉の脇に鞄。**
     不在は絵にならない——誰も立っていない部屋は「休みが多い日」と
     見分けが付かないので、物のほうで言う */
  function drawBag(g) {
    const x = 74, y = 150;
    g.appendChild(rect(x, y, 10, 8, PAL.ink));
    g.appendChild(rect(x + 1, y + 1, 8, 6, PAL.tableWood));
    g.appendChild(rect(x + 1, y + 3, 8, 1, PAL.plankGrain));
    g.appendChild(rect(x + 3, y - 2, 4, 2, PAL.ink));
  }

  /* ============================================================
     光の層（room.md §5・§6）。**毎フレーム描き直すのはここだけ。**
     部屋そのもの（`roomG`）は一枚のまま。

     動くのは**明るさだけ。形は動かさない**——`slow` の三点で学んだこと
     （形が変わる動きは飾りではない）。位相は `clock` だけから引き、
     **乱数を混ぜない**。
     ============================================================ */
  function drawLight(g, view, clock) {
    while (g.firstChild) g.removeChild(g.firstChild);
    const items = layout();
    const desk = items.find((it) => it.key === 'desk');
    const pc = items.find((it) => it.key === 'pc');

    if (view.night) {
      /* 夜の膜。**壁のほうを深く沈める**（灯りは机の上にしかない） */
      g.appendChild(el('rect', { x: 0, y: 0, width: W, height: CARPET_Y,
        fill: PAL.night, opacity: 0.52 }));
      g.appendChild(el('rect', { x: 0, y: CARPET_Y, width: W, height: H - CARPET_Y,
        fill: PAL.night, opacity: 0.40 }));
      /* 机のランプ。**灯っているのはここだけ**なので、夜に見る物（日報）が分かる。
         **一枚の矩形で塗らない**——四角い光の箱に見えて、床板を横切る線が出る
         （実際に出た）。薄いのを三枚重ねて、外へ行くほど弱くする */
      if (desk) {
        [[16, 24, 0.05], [9, 14, 0.06], [3, 6, 0.07]].forEach(([m, mv, op]) => {
          g.appendChild(el('rect', { x: desk.x - m, y: desk.y - mv, width: desk.w + m * 2,
            height: desk.h + mv + 8, fill: PAL.goldHi, opacity: op }));
        });
        g.appendChild(rect(desk.x + desk.w - 12, desk.y - 4, 6, 3, PAL.goldHi));
        g.appendChild(rect(desk.x + desk.w - 10, desk.y - 1, 2, 7, PAL.ink));
      }
      return;
    }

    /* 未読があるあいだ、画面の光が呼吸する。**1.6秒で一往復、明るさだけ** */
    if (view.unread > 0 && pc) {
      const t = (Math.sin(clock * (Math.PI * 2) / 1.6) + 1) / 2;
      g.appendChild(el('rect', { x: pc.x + 8, y: pc.y, width: 26, height: 21,
        fill: PAL.neonCyan, opacity: 0.10 + 0.14 * t }));
    }
  }

  /* ---------- 一枚描く ---------- */
  function drawRoom(svg, view) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const defs = el('defs', {});
    svg.appendChild(defs);
    bodyDef(defs);
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
        case 'board': drawBoard(g, it, view); break;
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
    /* 疲れている子がいる印。台帳の上に貼る */
    if (view.tired) {
      const desk = items.find((it) => it.key === 'desk');
      if (desk) drawNote(g, desk);
    }
    /* 人は物の**あと**。机やソファの手前に立つ */
    if (view.away) drawBag(g);
    drawPeople(g, view);
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
    let svg = null, lightG = null;
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
          /* **件数は札に。**画素の層に文字は置かない（§5）。
             光っているのが何件ぶんなのかは、開かなくても分かるべき */
          if (it.tap === 'mail' && view.unread > 0 && !view.night) {
            t.textContent += ' ' + view.unread;
            t.classList.add('on');
          }
          /* 下に出す。下辺の物（扉）は上に */
          const below = it.y + it.h + 9 <= H;
          const q = floorToScreen(it.x + it.w / 2, below ? it.y + it.h : it.y);
          t.style.left = q.x + 'px';
          if (below) t.style.top = (q.y + 2) + 'px';
          else t.style.bottom = ((H - it.y) * scale + 2) + 'px';
          ui.appendChild(t);
        }
      });
      /* 人の頭（写真の丸）と当たり。**雀荘のフロアと同じ `.jnFlHead`**。
         顔が分かる必要はない——誰かがそこにいることが伝わればよく、
         誰かは押せば分かる（名簿のその行へ飛ぶ） */
      const d = Math.round(11 * scale);
      (view.people || []).forEach((p) => {
        if (p.over) return;
        const q = floorToScreen(p.x + 4.5, p.y - 1);
        const head = document.createElement('div');
        head.className = 'jnFlHead';
        head.style.left = Math.round(q.x - d / 2) + 'px';
        head.style.top = Math.round(q.y - d) + 'px';
        head.style.width = head.style.height = d + 'px';
        head.innerHTML = '<img src="img/' + String(p.id).padStart(3, '0') + '.webp" alt="" onerror="this.remove()">';
        ui.appendChild(head);
        /* 当たりは頭から足元まで。**体だけだと 9×7 で押せない** */
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ofRoomHit ofRoomMate';
        b.dataset.mate = p.id;
        b.setAttribute('aria-label', '所属の子');
        const top = floorToScreen(p.x - 1, p.y - 12);
        b.style.left = top.x + 'px'; b.style.top = top.y + 'px';
        b.style.width = (11 * scale) + 'px'; b.style.height = (20 * scale) + 'px';
        b.addEventListener('click', () => { if (handlers.mate) handlers.mate(p.id); });
        hits.appendChild(b);
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
      /* **光の層は部屋のいちばん上。**人も膜の下に沈む（夜） */
      lightG = el('g', { 'shape-rendering': 'crispEdges' });
      svg.appendChild(lightG);
      drawLight(lightG, view, live.clock);
      wrap.classList.toggle('night', !!view.night);
    }

    /* 常時アニメの時計。第一段では描き直すものが無いので、時計だけ進む */
    function idle() {
      cancelAnimationFrame(raf);
      live.t0 = performance.now();
      const tick = (now) => {
        if (!wrap.isConnected) return;
        live.clock = (now - live.t0) / 1000;
        /* **動かすものが無い日は触らない。**未読が無ければ光は静止画のまま */
        if (lightG && !view.night && view.unread > 0) drawLight(lightG, view, live.clock);
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

  return { mount, layout, hitOf, roomView, spotsFor, TAGS, SAFE, HIT_MIN, HIT_GAP,
           DUTY_SPOTS, REST_SPOTS, LATE_SPOT, MAX_DUTY, MAX_REST, W, H };
})();

if (typeof module !== 'undefined') {
  module.exports = { OfficeRoom };
}
