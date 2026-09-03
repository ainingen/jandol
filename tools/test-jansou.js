#!/usr/bin/env node
/*
  直営雀荘の純関数テスト

    node tools/test-jansou.js

  なぜ要るか：
    README に「engine.js テスト35件合格」とあるが、そのテストは
    リポジトリにコミットされていない（docs/design/jansou/spec.md §13）。
    復元できないので、雀荘リニューアルで足した純関数はここで担保する。

  ここに書くのは **DOMに触らない関数だけ**。
  描画そのものはブラウザ検証（spec.md §13 後半）で見る。

  第二段でタイムライン生成（JansouFloor.build）が入ったら、
  「各帯の pay 合計が day.slots[i].sales に厳密一致」
  「スキップ消化と通常消化で store に入る結果が完全一致」
  をここに足すこと。
*/
'use strict';

const { JansouFloor } = require('../src/jansou-floor.js');
const { Jansou } = require('../src/jansou.js');
const { JansouGuests } = require('../src/jansou-guests.js');

let pass = 0;
const fails = [];

function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  … ' + detail : ''));
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' / want ' + JSON.stringify(b));
}

/* ============================================================
   倍率とフロア幅（spec.md §4.1 の決定）
   ============================================================ */
{
  /* 論理フロアは200で固定。floorW は**見えている窓の幅**（placement.md §3）。
     店の中身がほぼ全部入る倍率を選ぶので、ここの値は自由配置の前と変わらない */
  const cases = [
    [380, 2, 190],   // 縦持ち
    [600, 3, 200],   // 中くらい
    [760, 4, 190],   // #app の上限
    [320, 2, 160],   // ちょうど2倍が入る境目
    [1200, 4, 200],  // 広くてもフロア幅は200で頭打ち
  ];
  cases.forEach(([w, s, fw]) => {
    const f = JansouFloor.fit(w);
    eq(f.scale, s, '倍率 幅' + w);
    eq(f.floorW, fw, 'フロア幅 幅' + w);
  });

  /* 倍率は必ず整数で2〜4。はみ出さない */
  for (let w = 200; w <= 1400; w += 7) {
    const f = JansouFloor.fit(w);
    ok(Number.isInteger(f.scale) && f.scale >= 2 && f.scale <= 4, '倍率が2〜4の整数 幅' + w, f.scale);
    ok(f.floorW * f.scale <= w, 'はみ出さない 幅' + w, f.floorW * f.scale);
    /* マス目の192pxが2倍で入る幅（384px〜）なら、隠れるのは左右の余白＋8pxまで。
       それより狭いところは横送りで見る（placement.md §3） */
    if (w >= 384) {
      ok(JansouFloor.FLOOR_W - f.floorW - JansouFloor.GX0 * 2 <= 8,
        '中身がほぼ全部見える 幅' + w, f.floorW);
    }
  }
}

/* ============================================================
   マス目と設置物（docs/design/jansou/placement.md §1・§2）
   ============================================================ */
{
  const F = JansouFloor;
  const W = F.TABLE_W, H = F.TABLE_H;
  const size = (kind) => F.KINDS[kind];
  const rectOf = (it) => ({ x: it.x, y: it.y, w: size(it.kind).w, h: size(it.kind).h });
  const hit = (a, b) => {
    const ra = rectOf(a), rb = rectOf(b);
    return ra.x < rb.x + rb.w && rb.x < ra.x + ra.w && ra.y < rb.y + rb.h && rb.y < ra.y + ra.h;
  };

  /* マス目が床に収まっている */
  ok(F.GX0 + F.COLS * F.GRID <= F.FLOOR_W, 'マス目が横に収まる', F.GX0 + F.COLS * F.GRID);
  ok(F.GY0 + F.ROWS * F.GRID <= F.FLOOR_H, 'マス目が縦に収まる', F.GY0 + F.ROWS * F.GRID);
  ok(F.GY0 >= F.CARPET_Y, 'マス目が壁にめり込まない', F.GY0);

  /* ---- 卓2〜8 × 内装1〜5：置いたものが床に収まり、重ならない ---- */
  for (let n = 2; n <= 8; n++) {
    for (let iv = 1; iv <= 5; iv++) {
      const fl = F.autoPlace({ tables: n, interior: iv });
      const tag = '卓' + n + '/内装' + iv;
      eq(F.tablesOf(fl).length, n, tag + ' 卓の数');
      eq(fl.items.filter((it) => it.kind === 'sofa').length, iv >= 4 ? 1 : 0, tag + ' ソファ');
      eq(fl.items.filter((it) => it.kind === 'counter').length, iv >= 5 ? 1 : 0, tag + ' カウンター');

      fl.items.forEach((it, i) => {
        const s = size(it.kind);
        ok(it.x >= 0 && it.x + s.w <= F.COLS, tag + ' 横に収まる ' + i, it.x);
        ok(it.y >= 0 && it.y + s.h <= F.ROWS, tag + ' 縦に収まる ' + i, it.y);
        ok(!hit(it, F.DOOR), tag + ' 入口に掛からない ' + i, it.x + ',' + it.y);
        for (let j = i + 1; j < fl.items.length; j++) {
          ok(!hit(it, fl.items[j]), tag + ' 重ならない ' + i + '-' + j);
        }
      });

      /* **席は4つとも必ずある。**狭い幅で上の2席が消える問題はここで消えている */
      F.tablesOf(fl).forEach((t, ti) => {
        const seats = F.seatsOf(t);
        eq(seats.length, 4, tag + ' 卓' + ti + ' の席は4つ');
        seats.forEach((s, si) => {
          ok(s.x >= 0 && s.x + F.SEAT_W <= F.FLOOR_W, tag + ' 席が横に収まる ' + ti + '/' + si, s.x);
          ok(s.y >= F.CARPET_Y - 1 && s.y + F.SEAT_H <= F.FLOOR_H, tag + ' 席が床の中 ' + ti + '/' + si, s.y);
        });
        ok(t.y >= F.CARPET_Y && t.y + H <= F.FLOOR_H, tag + ' 卓が床の中 ' + ti, t.y);
      });

      /* 客どうし・卓どうしが重ならない（席まで含めた見た目の判定） */
      const boxes = F.tablesOf(fl).map((t) => ({ x: t.x - W / 2, y: t.y }));
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const hit2 = Math.abs(boxes[i].x - boxes[j].x) < W && Math.abs(boxes[i].y - boxes[j].y) < H;
          ok(!hit2, tag + ' 卓の絵が重ならない ' + i + '-' + j);
        }
      }
    }
  }

  /* ---- 移行：既存プレイヤーの店が、いままでと同じ絵で再現される ----
     旧 layout()（幅200）をここに写して突き合わせる。
     卓7・8の3行目だけは入口を避けて左右に振るので、そこは形が変わる
     （それが今回直している「3行目とソファ・カウンターが同じ高さ」） */
  function oldLayout(tables) {
    const floorW = 200, PITCH = 60, SEAT_H = 16, CARPET_Y = 37, FLOOR_H = 164;
    const cols = Math.max(1, Math.min(3, Math.floor(floorW / PITCH)));
    const rows = Math.ceil(tables / cols);
    const top = CARPET_Y + SEAT_H;
    const availH = (FLOOR_H - 6) - top;
    const pitchY = rows <= 1 ? 0 : Math.min(52, Math.floor((availH - H) / (rows - 1)));
    const blockH = (rows - 1) * pitchY + H;
    const y0 = top + Math.min(8, Math.max(0, Math.floor((availH - blockH) / 2)));
    const out = [];
    let left = tables;
    for (let r = 0; r < rows; r++) {
      const k = Math.min(cols, left);
      left -= k;
      const x0 = Math.round((floorW - k * PITCH) / 2);
      for (let c = 0; c < k; c++) {
        out.push({ x: x0 + c * PITCH + Math.round((PITCH - W) / 2), y: y0 + r * pitchY, row: r });
      }
    }
    return out;
  }

  for (let n = 2; n <= 8; n++) {
    const before = oldLayout(n);
    const after = F.tablesOf(JansouFloor.reconcile(null, { tables: n, interior: 1 }));
    const tag = '移行 卓' + n;
    eq(after.length, before.length, tag + ' 卓の数が同じ');

    /* 行の分かれ方（1行3卓、余りは最後の行）が同じ */
    const rowsB = {}, rowsA = {};
    before.forEach((t, i) => { (rowsB[t.row] = rowsB[t.row] || []).push(i); });
    after.forEach((t, i) => { (rowsA[t.gy] = rowsA[t.gy] || []).push(i); });
    const keyB = Object.keys(rowsB).map((k) => rowsB[k].join(',')).join('|');
    const keyA = Object.keys(rowsA).sort((x, y) => x - y).map((k) => rowsA[k].join(',')).join('|');
    eq(keyA, keyB, tag + ' 行の分かれ方が同じ');

    /* 並び順（左から右・上から下）が同じ */
    for (let i = 1; i < after.length; i++) {
      const sameRow = after[i].gy === after[i - 1].gy;
      ok(sameRow ? after[i].x > after[i - 1].x : after[i].gy > after[i - 1].gy,
        tag + ' 並び順 ' + i);
    }

    /* 位置のずれ。3行になる卓7・8の3行目だけは入口を避けるので別扱い */
    const lastRow = Math.max.apply(null, before.map((t) => t.row));
    before.forEach((t, i) => {
      const moved = n >= 7 && t.row === lastRow;
      const dx = Math.abs(after[i].x - t.x), dy = Math.abs(after[i].y - t.y);
      ok(dy <= 4, tag + ' 縦のずれが小さい ' + i, dy);
      if (!moved) ok(dx <= 16, tag + ' 横のずれが小さい ' + i, dx);
    });
  }

  /* 卓7・8では、3行目の卓とソファ・カウンターが同じ高さに並ばない（今回の直し） */
  [7, 8].forEach((n) => {
    const fl = F.autoPlace({ tables: n, interior: 5 });
    const lows = F.tablesOf(fl).filter((t) => t.gy >= 10);
    fl.items.filter((it) => it.kind === 'sofa' || it.kind === 'counter').forEach((it) => {
      lows.forEach((t) => {
        const apart = it.x + size(it.kind).w <= t.gx || t.gx + F.KINDS.table.w <= it.x;
        ok(apart, '卓' + n + ' 3行目と' + it.kind + 'が重ならない');
      });
    });
  });

  /* ---- reconcile：冪等で、既存セーブを壊さない ---- */
  {
    const mk = (t, iv) => JansouFloor.reconcile(null, { tables: t, interior: iv });
    for (let n = 2; n <= 8; n++) {
      const once = mk(n, 5);
      const twice = JansouFloor.reconcile(once, { tables: n, interior: 5 });
      eq(JSON.stringify(twice), JSON.stringify(once), '突き合わせが冪等 卓' + n);
    }
    /* 壊れた項目は落として置き直す。数は必ず合う */
    const broken = { v: 1, auto: false, items: [
      { id: 1, kind: 'table', x: 0, y: 0 },
      { id: 2, kind: 'table', x: 0, y: 0 },        // 重なり
      { id: 3, kind: 'table', x: 99, y: 0 },       // 範囲外
      { id: 4, kind: 'table', x: 10, y: 13 },      // 入口の上
      { id: 5, kind: 'nazo', x: 3, y: 3 },         // 知らない種類
      { id: 6, kind: 'sofa', x: 21, y: 0 },
    ], next: 7, mine: 99 };
    const fixed = JansouFloor.reconcile(broken, { tables: 4, interior: 4 });
    eq(F.tablesOf(fixed).length, 4, '壊れたセーブでも卓の数が合う');
    eq(fixed.items.filter((it) => it.kind === 'sofa').length, 1, '壊れたセーブでもソファは1つ');
    ok(!fixed.items.some((it) => it.kind === 'nazo'), '知らない種類は落ちる');
    eq(fixed.mine, null, '指していない自分の卓は null');
    fixed.items.forEach((it, i) => {
      for (let j = i + 1; j < fixed.items.length; j++) ok(!hit(it, fixed.items[j]), '直したあとも重ならない');
      ok(!hit(it, F.DOOR), '直したあとも入口に掛からない');
    });
    /* 模様替え済み（auto:false）の店は、卓を増やしても置いたものが動かない */
    const kept = JansouFloor.reconcile(fixed, { tables: 6, interior: 4 });
    eq(F.tablesOf(kept).length, 6, '卓を増やすと6つになる');
    F.tablesOf(fixed).forEach((t, i) => {
      const k = F.tablesOf(kept)[i];
      ok(k.gx === t.gx && k.gy === t.gy, '模様替え済みの卓は動かない ' + i);
    });
    /* 自動配置のままの店は、卓が増えると組み直す（＝いままでの絵） */
    const auto4 = JansouFloor.reconcile(null, { tables: 4, interior: 1 });
    const auto5 = JansouFloor.reconcile(auto4, { tables: 5, interior: 1 });
    eq(JSON.stringify(F.tablesOf(auto5).map((t) => [t.gx, t.gy])),
      JSON.stringify(F.tablesOf(F.autoPlace({ tables: 5, interior: 1 })).map((t) => [t.gx, t.gy])),
      '自動配置のままなら組み直す');
    /* 自分の卓は範囲の中だけ残る */
    eq(JansouFloor.reconcile({ v: 1, auto: true, items: [], next: 1, mine: 1 },
      { tables: 4, interior: 1 }).mine, 1, '自分の卓は残る');
  }

  /* ---- 模様替えの操作（placement.md §7。純関数） ---- */
  {
    const F2 = JansouFloor;
    const fl = F2.autoPlace({ tables: 4, interior: 3 });   // 卓4（1,1）(8,1)(15,1)(8,7)
    const t0 = fl.items[0];

    /* つまむ判定は**足元ぜんぶ**。卓の絵の外（席の余白）でも掴める */
    eq(F2.pickItem(fl, F2.cellX(t0.x) + 2, F2.cellY(t0.y) + 2).id, t0.id, '足元の隅でも掴める');
    eq(F2.pickItem(fl, F2.cellX(t0.x) + 20, F2.cellY(t0.y) + 20).id, t0.id, '卓の上でも掴める');
    ok(!F2.pickItem(fl, F2.cellX(10) + 4, F2.cellY(13) + 4), '入口は掴めない');
    ok(!F2.pickItem(fl, 2, 2), '壁のところには何も無い');

    /* 足元が床からはみ出さないように寄せる */
    eq(JSON.stringify(F2.clampCell('table', -5, -5)), '{"x":0,"y":0}', '左上に寄せる');
    eq(JSON.stringify(F2.clampCell('table', 99, 99)),
      '{"x":' + (F2.COLS - 7) + ',"y":' + (F2.ROWS - 5) + '}', '右下に寄せる');

    /* 動かす：重なる・入口・範囲外は断る。**断ったときは null で、元は変わらない** */
    ok(!F2.moveItem(fl, t0.id, fl.items[1].x, fl.items[1].y), '重なる場所へは動かせない');
    ok(!F2.moveItem(fl, t0.id, 8, 11), '入口に掛かる場所へは動かせない');   // 行11は10に寄る
    ok(!F2.moveItem(fl, 999, 0, 0), '無いものは動かせない');
    const moved = F2.moveItem(fl, t0.id, 0, 10);
    ok(!!moved, '空いている場所へは動かせる');
    eq(moved.auto, false, '一度動かしたら自動配置ではなくなる');
    eq(fl.items[0].x, t0.x, '元の floor は書き換わらない');
    eq(F2.tablesOf(moved).length, 4, '動かしても卓の数は変わらない');
    eq(moved.items.map((it) => it.id).join(','), fl.items.map((it) => it.id).join(','), 'id は変わらない');
    /* はみ出す指定は寄せてから判定する（指が枠の外に出ても置ける） */
    const clamped = F2.moveItem(fl, t0.id, -3, 10);
    ok(clamped && clamped.items[0].x === 0, 'はみ出す指定は内側に寄せる');

    /* 自分の卓は id で覚える。撤去すると外れる */
    const mineSet = F2.setMine(fl, t0.id);
    eq(mineSet.mine, t0.id, '自分の卓にできる');
    eq(F2.setMine(mineSet, t0.id).mine, null, 'もう一度押すとやめられる');
    const sold = F2.removeItem(mineSet, t0.id);
    eq(F2.tablesOf(sold).length, 3, '撤去すると1つ減る');
    eq(sold.mine, null, '自分の卓を撤去したら外れる');
    /* **他の卓の id は動かない。**番号で持つと、ここでずれる */
    eq(sold.items[0].id, fl.items[1].id, '撤去しても残りの id は変わらない');

    /* **入れ替え。**卓8まで置くと床がほぼ埋まり、空きが無くなる。
       入れ替えが無いと、そこから先は一つも動かせない店になる */
    {
      const full = F2.autoPlace({ tables: 8, interior: 5 });
      const ts = full.items.filter((it) => it.kind === 'table');
      /* 空いている 7×5 はもう無い（＝動かす先が無い） */
      let room = 0;
      for (let gy = 0; gy < F2.ROWS; gy++) {
        for (let gx = 0; gx < F2.COLS; gx++) if (F2.canPlace(full, { kind: 'table', x: gx, y: gy })) room++;
      }
      eq(room, 0, '卓8では卓を置ける空きが無い');
      const sw = F2.swapItems(full, ts[0].id, ts[7].id);
      ok(!!sw, '空きが無くても入れ替えはできる');
      const a = sw.items.find((it) => it.id === ts[0].id), b = sw.items.find((it) => it.id === ts[7].id);
      ok(a.x === ts[7].x && a.y === ts[7].y && b.x === ts[0].x && b.y === ts[0].y, '場所が入れ替わる');
      eq(sw.auto, false, '入れ替えたら自動配置ではなくなる');
      eq(F2.tablesOf(sw).length, 8, '入れ替えても数は変わらない');
      sw.items.forEach((it, i) => {
        for (let j = i + 1; j < sw.items.length; j++) {
          ok(!(it.x < sw.items[j].x + F2.KINDS[sw.items[j].kind].w &&
               sw.items[j].x < it.x + F2.KINDS[it.kind].w &&
               it.y < sw.items[j].y + F2.KINDS[sw.items[j].kind].h &&
               sw.items[j].y < it.y + F2.KINDS[it.kind].h), '入れ替えても重ならない');
        }
      });
      ok(!F2.swapItems(full, ts[0].id, 999), '無いものとは入れ替えられない');
      ok(!F2.swapItems(full, ts[0].id, ts[0].id), '自分自身とは入れ替えない');
      /* 大きさが違うと、入れ替えた先で他とぶつかることがある。そのときは断る */
      const sofa = full.items.find((it) => it.kind === 'sofa');
      ok(!F2.swapItems(full, ts[0].id, sofa.id), '大きさが合わない入れ替えは断る');
    }

    /* 買ったものは、見えているところの近くに置かれる */
    const near = { x: 20, y: 1 };
    const res = F2.addItem(fl, 'plant', F2.spotsNear(fl, 'plant', near, []));
    ok(!!res && res.item.kind === 'plant', '観葉植物を置ける');
    ok(Math.abs(res.item.x - near.x) + Math.abs(res.item.y - near.y) <= 4,
      '近いところに置かれる', res.item.x + ',' + res.item.y);
    ok(F2.canPlace(fl, { kind: 'plant', x: res.item.x, y: res.item.y }), '置いた先は空いていた');

    /* 模様替えした店は、突き合わせを通しても**勝手に動かない** */
    const custom = F2.moveItem(F2.setMine(fl, fl.items[1].id), t0.id, 0, 10);
    const back = JansouFloor.reconcile(custom, { tables: 4, interior: 3 });
    eq(back.items.map((it) => it.kind + it.x + ',' + it.y).join(' '),
       custom.items.map((it) => it.kind + it.x + ',' + it.y).join(' '), '置いた場所が残る');
    eq(back.mine, custom.mine, '自分の卓も残る');
    /* 卓を撤去したあと、tables を減らして通しても残りは動かない */
    const sold2 = F2.removeItem(custom, custom.items[2].id);
    const back2 = JansouFloor.reconcile(sold2, { tables: 3, interior: 3 });
    eq(F2.tablesOf(back2).length, 3, '撤去した数のまま');
    eq(back2.items.map((it) => it.kind + it.x + ',' + it.y).join(' '),
       sold2.items.map((it) => it.kind + it.x + ',' + it.y).join(' '), '撤去しても残りは動かない');
  }

  /* ---- canPlace / freeCell ---- */
  {
    const fl = F.autoPlace({ tables: 2, interior: 1 });
    ok(!F.canPlace(fl, { kind: 'table', x: 5, y: 1 }), '重なる場所には置けない');
    ok(!F.canPlace(fl, { kind: 'table', x: 10, y: 10 }), '入口に掛かる場所には置けない');
    ok(!F.canPlace(fl, { kind: 'table', x: F.COLS - 3, y: 0 }), '範囲外には置けない');
    ok(F.canPlace(fl, { kind: 'table', x: 0, y: 10 }), '空いていれば置ける');
    ok(F.canPlace(fl, { kind: 'table', x: 5, y: 1 }, 1), '自分自身は避ける相手に数えない');
    ok(!F.freeCell(fl, 10, 13), '入口のマスは空いていない');
    ok(F.freeCell(fl, 0, 14), '何も無いマスは空いている');
    ok(!F.freeCell(fl, -1, 0), '範囲外は空いていない');
    /* 卓のまわりのマスは、卓そのものと重ならない */
    F.tablesOf(fl).forEach((t) => {
      F.ringCells(fl, t).forEach((c) => ok(F.freeCell(fl, c.x, c.y), '卓のまわりのマスは空いている'));
    });
  }
}

/* ============================================================
   隣接コンボ（docs/design/jansou/placement.md §5）
   ============================================================ */
{
  const F = JansouFloor;
  const mk = (items) => ({ v: 1, auto: false, next: 99,
    items: items.map((a, i) => ({ id: i + 1, kind: a[0], x: a[1], y: a[2] })), mine: null });

  /* --- 隣接は1マスの隙間まで。ぴったり付けなくても成立する --- */
  const T = ['table', 0, 0];
  eq(F.combos(mk([T, ['sofa', 7, 0]])).counts.kutsurogi, 1, '接していれば くつろぎ席');
  eq(F.combos(mk([T, ['sofa', 8, 0]])).counts.kutsurogi, 1, '1マス空きでも くつろぎ席');
  ok(!F.combos(mk([T, ['sofa', 9, 0]])).counts.kutsurogi, '2マス空くと成立しない');
  eq(F.combos(mk([T, ['sofa', 7, 5]])).counts.kutsurogi, 1, '斜めに角で触れても成立する');

  /* --- 6つとも成立する --- */
  eq(F.combos(mk([T, ['counter', 7, 0]])).counts.counter, 1, 'カウンター席');
  eq(F.combos(mk([['table', 8, 8]])).counts.iriguchi, 1, '入口のとなりは 入口席');
  eq(F.combos(mk([T])).counts.shizuka, 1, '離れていれば 静かな席');
  ok(!F.combos(mk([['table', 8, 8]])).counts.shizuka, '入口のとなりは静かではない');
  ok(!F.combos(mk([T, ['table', 7, 0]])).counts.shizuka, '卓が並んでいれば静かではない');
  eq(F.combos(mk([T, ['plant', 23, 0]])).counts.hanamichi, undefined, '片側だけでは花道にならない');
  eq(F.combos(mk([['table', 1, 0], ['plant', 0, 0], ['plant', 8, 0]])).counts.hanamichi, 1,
    '卓の左右に観葉植物で 花道');
  ok(F.combos(mk([['sofa', 0, 0], ['counter', 3, 0]])).lounge, 'ソファ＋カウンターで ラウンジ');
  ok(!F.combos(mk([['sofa', 0, 0], ['counter', 5, 0]])).lounge, '離れていればラウンジではない');

  /* --- 並び順に依存しない（対称） --- */
  const a1 = mk([T, ['sofa', 7, 0], ['counter', 7, 4], ['plant', 20, 0]]);
  const a2 = { v: 1, auto: false, next: 99, items: a1.items.slice().reverse(), mine: null };
  eq(JSON.stringify(F.combos(a1).counts), JSON.stringify(F.combos(a2).counts), '並び順に依存しない');

  /* --- 卓ごとの性質（build に渡すもの） --- */
  {
    const fl = mk([['table', 0, 0], ['sofa', 7, 0], ['table', 8, 8], ['table', 0, 6]]);
    const tr = F.tableTraits(fl, [0, 1, 2]);
    eq(tr.length, 3, '使える卓のぶんだけ返す');
    eq(tr[0].tip, F.TIP_PER_GUEST, 'くつろぎ席にはチップ');
    ok(tr[0].dwellMul > 1, 'くつろぎ席は長く居る', tr[0].dwellMul);
    eq(tr[0].evictRank, 2, 'くつろぎ席は最後に立つ');
    ok(tr[1].dwellMul < 1, '入口席は回転が速い', tr[1].dwellMul);
    eq(tr[1].evictRank, 0, '入口席は最初に立つ');
    eq(tr[1].prefer, 'shinki', '入口席は一見さん');
    eq(tr[1].tip, 0, '入口席にチップは無い');
    /* 入口席とくつろぎ席が重なったら、入口席が勝つ（回転が速い） */
    const both = F.tableTraits(mk([['table', 8, 8], ['sofa', 15, 8]]), [0])[0];
    ok(both.dwellMul < 1 && both.evictRank === 0, '入口席は他が何であれ回転が速い');
    eq(both.tip, F.TIP_PER_GUEST, 'それでもソファのチップは入る');
  }
}

/* ============================================================
   コンボが帳簿に効く範囲（§5.3・§6）
   ============================================================ */
{
  global.STYLES = global.STYLES || { a: 1 };
  global.JANDOLS = global.JANDOLS || [];
  global.FREE_AGENTS = global.FREE_AGENTS || [];
  const { Jansou } = require('../src/jansou.js');
  const F = JansouFloor, G = JansouGuests;
  function seeded(seed) {
    let x = (seed | 0) || 1;
    return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x |= 0; return ((x >>> 0) % 100000) / 100000; };
  }
  const fees = Jansou.SLOTS.map((s) => s.fee);
  const cfgs = [
    ['中盤', { tables: 4, interior: 4, auto: 2, sign: 2, rep: 40, slotPop: [150, 200, 260], slotWorkers: [3, 4, 6] }, [0, 1, 2, 3]],
    ['終盤', { tables: 8, interior: 5, auto: 3, sign: 3, rep: 85, slotPop: [300, 400, 500], slotWorkers: [8, 10, 12] }, [0, 1, 2, 3, 4, 5, 6, 7]],
  ];

  cfgs.forEach(([name, cfg, tableIdx]) => {
    const fl = F.autoPlace({ tables: cfg.tables, interior: cfg.interior });
    const traits = F.tableTraits(fl, tableIdx);
    for (let seed = 1; seed <= 20; seed++) {
      const day = Jansou.computeDay(cfg, seeded(seed));
      const base = { fees, tableIdx, slotStaff: [[1], [1, 2], [1, 2, 3]] };
      const plain = F.build(day, base, seeded(seed * 31));
      const withC = F.build(day, Object.assign({ tables: traits }, base), seeded(seed * 31));
      const tag = name + ' seed' + seed;

      /* --- **guests と sales は動かない。**ここが崩れたら全部やり直し --- */
      for (let si = 0; si < 3; si++) {
        const cnt = withC.timeline.filter((e) => e.kind === 'arrive' && e.slot === si).reduce((a, e) => a + e.count, 0);
        const pay = withC.timeline.filter((e) => e.kind === 'pay' && e.slot === si).reduce((a, e) => a + e.amount, 0);
        eq(cnt, day.slots[si].guests, tag + ' 帯' + si + ' コンボ有りでも Σcount=guests');
        eq(pay, day.slots[si].sales, tag + ' 帯' + si + ' コンボ有りでも Σpay=sales');
      }
      eq(withC.timeline.filter((e) => e.kind === 'arrive').length,
         plain.timeline.filter((e) => e.kind === 'arrive').length, tag + ' 到着の件数は変わらない');

      /* --- チップは臨時収入。**場代には1円も混ざらない** --- */
      const tipEv = withC.timeline.filter((e) => e.kind === 'bonus' && e.label === 'チップ');
      eq(tipEv.reduce((a, e) => a + e.amount, 0), withC.summary.tips, tag + ' チップの合計が summary と一致');
      const tipTables = new Set(traits.filter((t) => t.tip > 0).map((t) => t.idx));
      tipEv.forEach((e) => {
        ok(tipTables.has(e.table), tag + ' チップはくつろぎ席からだけ', e.table);
        ok(e.amount % F.TIP_PER_GUEST === 0, tag + ' チップは一人あたり定額', e.amount);
      });
      if (!tipTables.size) eq(withC.summary.tips, 0, tag + ' くつろぎ席が無ければチップも無い');

      /* --- 追い出しは evictRank の低い席から。**席で見る**（群は卓をまたぐことがある） --- */
      const rank = {};
      traits.forEach((t) => { rank[t.idx] = t.evictRank; });
      const held = new Map();          // guestId -> [{table,seat}]
      const seatKey = (x) => x.table + ':' + x.seat;
      const taken = new Map();         // 'table:seat' -> rank
      let batchT = -1, freedRanks = [];
      const checkBatch = (tag2) => {
        if (!freedRanks.length) return;
        let minLeft = Infinity;
        taken.forEach((r) => { if (r < minLeft) minLeft = r; });
        const worst = Math.max.apply(null, freedRanks);
        ok(minLeft >= worst, tag2 + ' 追い出しは先に立つ席から',
          worst + ' を出したのに ' + minLeft + ' が残っている');
        freedRanks = [];
      };
      withC.timeline.forEach((e) => {
        if (e.kind === 'arrive') {
          /* **座らせる前に見る。**同じ時刻の到着を入れてしまうと、
             追い出した席にその客が座っただけで「残っている」に見える */
          checkBatch(tag);
          held.set(e.guestId, e.seats);
          e.seats.forEach((x) => taken.set(seatKey(x), rank[x.table]));
          return;
        }
        if (e.kind !== 'leave') return;
        if (e.t !== batchT) { checkBatch(tag); batchT = e.t; }
        const mine = held.get(e.guestId) || [];
        /* **群は丸ごと出る**（卓をまたぐことがある）。選ばれた理由はその客の
           いちばん先に立つ席なので、客ごとに最小の rank で見る */
        if (e.evicted && mine.length) {
          freedRanks.push(Math.min.apply(null, mine.map((x) => rank[x.table])));
        }
        mine.forEach((x) => taken.delete(seatKey(x)));
        held.delete(e.guestId);
      });
      checkBatch(tag);

      /* --- 好みの席：空いていれば必ずそこに座る --- */
      const prefTable = {};
      traits.forEach((t) => { if (t.prefer) prefTable[t.prefer] = prefTable[t.prefer] != null ? prefTable[t.prefer] : t.idx; });
      const occ = new Map();
      withC.timeline.forEach((e) => {
        if (e.kind === 'leave') { occ.delete(e.guestId); return; }
        if (e.kind !== 'arrive') return;
        const type = G.BY_KEY[e.typeKey];
        const want = type.cat === 'joukyaku' ? 'joukyaku' : type.cat === 'tokubetsu' ? 'tokubetsu' : null;
        const target = want != null ? prefTable[want] : undefined;
        if (target != null && !e.evict) {
          let used = 0;
          occ.forEach((v) => { if (v.table === target) used += v.count; });
          if (4 - used >= e.count) eq(e.table, target, tag + ' 好みの席が空いていれば座る ' + e.typeKey);
        }
        occ.set(e.guestId, { table: e.table, count: e.count });
      });
    }
  });

  /* --- 滞在の長さが効いている：入口席は回転が速く、くつろぎ席は遅い --- */
  {
    const fl = F.autoPlace({ tables: 8, interior: 5 });
    const tableIdx = [0, 1, 2, 3, 4, 5, 6, 7];
    const traits = F.tableTraits(fl, tableIdx);
    const door = traits.filter((t) => t.evictRank === 0).map((t) => t.idx);
    const relax = traits.filter((t) => t.evictRank === 2).map((t) => t.idx);
    ok(door.length && relax.length, '卓8の既定の配置に入口席とくつろぎ席がある');
    const seen = {};
    for (let seed = 1; seed <= 40; seed++) {
      const day = Jansou.computeDay(cfgs[1][1], seeded(seed));
      const { timeline } = F.build(day, { fees, tableIdx, tables: traits,
        slotStaff: [[1], [1, 2], [1, 2, 3]] }, seeded(seed * 17));
      timeline.forEach((e) => { if (e.kind === 'arrive') seen[e.table] = (seen[e.table] || 0) + e.count; });
    }
    const per = (arr) => arr.reduce((a, i) => a + (seen[i] || 0), 0) / arr.length;
    ok(per(door) > per(relax), '入口席のほうが客が入れ替わる',
      Math.round(per(door)) + '人 対 ' + Math.round(per(relax)) + '人');
  }

  /* --- **スキップと通常再生で、帳簿に入る数が完全に一致する**（§1・§13） ---
     再生層は乱数を引かず、タイムラインを順に消化するだけ。
     スキップは時計を終端に進めて一気に消化する。ここではその二つを模して比べる */
  {
    const fl = F.autoPlace({ tables: 8, interior: 5 });
    const tableIdx = [0, 1, 2, 3, 4, 5, 6, 7];
    const traits = F.tableTraits(fl, tableIdx);
    function consume(timeline, step) {
      const acc = { sales: 0, extra: 0, order: [] };
      const apply = (e) => {
        acc.order.push(e.kind + (e.guestId || '') + '@' + e.t.toFixed(4));
        if (e.kind === 'pay') acc.sales += e.amount;
        if (e.kind === 'bonus') acc.extra += e.amount;
      };
      let idx = 0;
      if (step > 0) {
        const dur = timeline.length ? timeline[timeline.length - 1].t : 0;
        for (let clock = 0; clock <= dur + step; clock += step) {
          while (idx < timeline.length && timeline[idx].t <= clock) apply(timeline[idx++]);
        }
      }
      while (idx < timeline.length) apply(timeline[idx++]);   // 取りこぼしを消化
      return acc;
    }
    for (let seed = 1; seed <= 30; seed++) {
      const day = Jansou.computeDay(cfgs[1][1], seeded(seed));
      const { timeline, summary } = F.build(day,
        { fees, tableIdx, tables: traits, slotStaff: [[1], [1, 2], [1, 2, 3]],
          bonuses: [{ slot: 2, amount: 5000, label: '祝儀' }] }, seeded(seed * 13));
      const skip = consume(timeline, 0);                    // スキップ＝一気に消化
      const x1 = consume(timeline, 1 / 60);                 // ×1
      const x4 = consume(timeline, 4 / 60);                 // ×4
      const tag = 'seed' + seed;
      eq(x1.sales, skip.sales, tag + ' スキップと×1で場代が一致');
      eq(x4.sales, skip.sales, tag + ' スキップと×4で場代が一致');
      eq(x1.extra, skip.extra, tag + ' スキップと×1で臨時収入が一致');
      eq(x4.extra, skip.extra, tag + ' スキップと×4で臨時収入が一致');
      eq(x1.order.join('|'), skip.order.join('|'), tag + ' 消化の順まで一致');
      eq(x4.order.join('|'), skip.order.join('|'), tag + ' ×4でも消化の順まで一致');
      eq(skip.sales, day.sales, tag + ' 場代の合計は computeDay と一致');
      /* settle が足すのは summary.tips。再生の臨時収入と食い違わないこと */
      const tipSum = timeline.filter((e) => e.kind === 'bonus' && e.label === 'チップ')
        .reduce((a, e) => a + e.amount, 0);
      eq(tipSum, summary.tips, tag + ' settle が足す額と再生で見える額が一致');
      eq(skip.extra, tipSum + 5000, tag + ' 臨時収入はチップと祝儀のぶんだけ');
    }
  }

  /* --- ラウンジとカウンター席は、ボトルの格と挑戦のしやすさに効く --- */
  {
    const faces = [{ id: 'shachou#2', typeKey: 'shachou', combo: [] }];
    const facesC = [{ id: 'shachou#2', typeKey: 'shachou', combo: ['counter'] }];
    let plain = 0, counter = 0;
    for (let i = 1; i <= 400; i++) {
      if (G.pickChallenge(faces, {}, { rep: 50 }, seeded(i))) plain++;
      if (G.pickChallenge(facesC, {}, { rep: 50 }, seeded(i))) counter++;
    }
    ok(counter > plain, 'カウンター席の客のほうが挑んでくる', plain + '→' + counter);
    let up = 0, same = 0;
    for (let i = 1; i <= 200; i++) {
      const a = G.pickChallenge(faces, {}, { rep: 50 }, seeded(i));
      const b = G.pickChallenge(faces, {}, { rep: 50, lounge: true }, seeded(i));
      if (!a || !b) continue;
      if (b.tier === Math.min(6, a.tier + 1)) up++; else same++;
    }
    ok(up > 0 && same === 0, 'ラウンジがあると格が一段上がる', up + '/' + same);
    ok(G.pickChallenge([{ id: 'shachou#9', typeKey: 'shachou', combo: [] }], { 'shachou#9': { typeKey: 'shachou', visits: 40 } },
      { rep: 50, lounge: true }, seeded(3)).tier <= 6, '上限は6（タワー）');
  }
}

/* ============================================================
   客タイプ24種
   ============================================================ */
{
  const T = JansouGuests.TYPES;
  eq(T.length, 24, '客タイプは24種');

  const keys = new Set(T.map((t) => t.key));
  eq(keys.size, 24, 'key が重複していない');

  const cats = {};
  T.forEach((t) => { cats[t.cat] = (cats[t.cat] || 0) + 1; });
  eq(cats.ippan, 7, '一般客は7種');
  eq(cats.joukyaku, 4, '上客は4種');
  eq(cats.yakkai, 6, '厄介は6種');
  eq(cats.tokubetsu, 7, '特別は7種');

  T.forEach((t) => {
    ok(!!JansouGuests.CAT[t.cat], t.name + ' のカテゴリが定義されている', t.cat);
    ok(!!JansouGuests.DECO[t.deco], t.name + ' の deco が定義されている', t.deco);
    ok(Array.isArray(t.slots) && t.slots.length > 0, t.name + ' に出る時間帯がある');
    ok(t.slots.every((s) => s >= 0 && s <= 2), t.name + ' の時間帯が0〜2');
    ok(typeof t.alias === 'string' && t.alias.length > 0, t.name + ' に通称がある');
    ok(typeof t.talk === 'string' && t.talk.length > 0, t.name + ' にセリフがある');

    /* スプライトは 12×16。ここが崩れると <use> の位置が全部ずれる */
    [0, 1].forEach((f) => {
      const g = JansouGuests.grid(t.key, f);
      eq(g.length, 16, t.name + ' のスプライトは16行 frame' + f);
      ok(g.every((line) => line.length === 12), t.name + ' のスプライトは12列 frame' + f);
    });
  });

  /* 荒らしは pickEvent が唯一の発生源。抽選に混ぜない（spec.md §9.4） */
  eq(JansouGuests.BY_KEY.arashi.weight, 0, '荒らしは抽選の重み0');
  eq(JansouGuests.BY_KEY.nushi.weight, 0, '常連の主は抽選の重み0');
}

/* ============================================================
   名前と常連の段階（spec.md §7）
   ============================================================ */
{
  const G = JansouGuests;
  eq(G.SEI.length, 40, '姓は40');
  eq(G.MEI_M.length, 20, '男名は20');
  eq(G.MEI_F.length, 20, '女名は20');
  eq(G.NIJINA.length, 10, '二つ名は10');

  /* 段階の境目 */
  eq(G.stageOf(0), 0, '0回は一見さん');
  eq(G.stageOf(2), 0, '2回はまだ一見さん');
  eq(G.stageOf(3), 1, '3回で顔なじみ');
  eq(G.stageOf(9), 1, '9回はまだ顔なじみ');
  eq(G.stageOf(10), 2, '10回で常連');
  eq(G.stageOf(29), 2, '29回はまだ常連');
  eq(G.stageOf(30), 3, '30回で主');

  /* 表示名が段階ごとの形式になっている */
  const rng = () => 0.5;
  const g = G.makeGuest('kaisha', rng);
  const t = G.BY_KEY.kaisha;

  g.visits = 1;
  eq(G.displayName(g), t.alias, '段階0はタイプ由来の通称');
  g.visits = 3;
  eq(G.displayName(g), g.sei + 'さん', '段階1は名字だけ');
  g.visits = 10;
  eq(G.displayName(g), g.sei + g.mei, '段階2はフルネーム');
  g.visits = 30;
  eq(G.displayName(g), g.nijina + g.sei + g.mei, '段階3は二つ名つき');

  /* 昇格の通知 */
  g.visits = 2;
  eq(G.bumpVisit(g).promoted, 1, '3回目で段階1に上がる');
  eq(G.bumpVisit(g).promoted, null, '4回目は上がらない');

  /* 性別の傾向。マダムは女性、社長は男性 */
  for (let i = 0; i < 40; i++) {
    const r = () => Math.random();
    eq(G.makeGuest('madam', r).sex, 'female', 'マダムは女性');
    eq(G.makeGuest('shachou', r).sex, 'male', '社長は男性');
    ok(G.MEI_F.indexOf(G.makeGuest('madam', r).mei) >= 0, 'マダムの名は女名から');
  }

  /* 上限200を超えたら訪問回数の少ない順に落ちる */
  const reg = {};
  for (let i = 0; i < 260; i++) reg['g' + i] = { visits: i + 1 };
  const trimmed = G.trim(reg);
  eq(Object.keys(trimmed).length, 200, '常連は200人まで');
  ok(!trimmed.g0, '訪問の少ないほうが落ちる');
  ok(!!trimmed.g259, '訪問の多いほうが残る');
  ok(G.trim({ a: { visits: 1 } }).a, '200人以下ならそのまま');
}

/* ============================================================
   スプライトの矩形化（横に続く同じ色をまとめる）
   ============================================================ */
{
  /* gridRects は document を使うので、最小限の偽物を差しておく */
  const made = [];
  global.document = {
    createElementNS: () => {
      const attrs = {};
      made.push(attrs);
      return { setAttribute: (k, v) => { attrs[k] = v; } };
    },
  };
  const rects = JansouFloor.gridRects(['aabb.', '.....', 'aaaaa'], (ch) => (ch === '.' ? null : ch));
  eq(rects.length, 3, '連続する同じ色はひとつの矩形にまとまる');
  eq(made[0].width, 2, '最初のランは2幅');
  eq(made[2].width, 5, '3行目は5幅');
  delete global.document;
}

/* ============================================================
   帳簿層（タイムライン生成）— spec.md §5.4 / §13
   ============================================================ */
{
  global.STYLES = global.STYLES || { a: 1 };
  global.JANDOLS = global.JANDOLS || [];
  global.FREE_AGENTS = global.FREE_AGENTS || [];
  const { Jansou } = require('../src/jansou.js');
  const F = JansouFloor, G = JansouGuests;

  function seeded(seed) {
    let x = (seed | 0) || 1;
    return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x |= 0; return ((x >>> 0) % 100000) / 100000; };
  }
  const fees = Jansou.SLOTS.map((s) => s.fee);
  const starts = F.slotStartTimes();

  /* 序盤・中盤・終盤（引き継ぎ書 §4 の3点）＋ joinNight の序盤 */
  const cases = [
    ['序盤', { tables: 2, interior: 1, auto: 1, sign: 1, rep: 10, slotPop: [0, 0, 120], slotWorkers: [0, 0, 3] }, [0, 1]],
    ['序盤・自分の卓', { tables: 2, interior: 1, auto: 1, sign: 1, rep: 10, slotPop: [0, 0, 120], slotWorkers: [0, 0, 3], playerNight: true }, [0]],
    ['中盤', { tables: 4, interior: 2, auto: 2, sign: 2, rep: 40, slotPop: [150, 200, 260], slotWorkers: [3, 4, 6] }, [0, 1, 2, 3]],
    ['終盤', { tables: 8, interior: 5, auto: 3, sign: 3, rep: 85, slotPop: [300, 400, 500], slotWorkers: [8, 10, 12] }, [0, 1, 2, 3, 4, 5, 6, 7]],
  ];

  cases.forEach(([name, cfg, tableIdx]) => {
    for (let seed = 1; seed <= 25; seed++) {
      const day = Jansou.computeDay(cfg, seeded(seed));
      const opts = { fees, tableIdx, slotStaff: [[1], [1, 2], [1, 2, 3]],
        bonuses: [{ slot: 2, amount: 5000, label: '祝儀' }],
        interrupts: [{ slot: 2, at: 6, node: { kind: 'test' } }] };
      const { timeline: tl, summary } = F.build(day, opts, seeded(seed * 31));
      const tag = name + ' seed' + seed;
      const seats = tableIdx.length * F.SEATS_PER_TABLE;

      /* --- 帯ごとの厳密一致 --- */
      for (let si = 0; si < 3; si++) {
        const cnt = tl.filter((e) => e.kind === 'arrive' && e.slot === si).reduce((a, e) => a + e.count, 0);
        eq(cnt, day.slots[si].guests, tag + ' 帯' + si + ' Σcount=guests');
        const pay = tl.filter((e) => e.kind === 'pay' && e.slot === si).reduce((a, e) => a + e.amount, 0);
        eq(pay, day.slots[si].sales, tag + ' 帯' + si + ' Σpay=sales');
        /* 帯の到着は帯の中に居る */
        tl.filter((e) => e.kind === 'arrive' && e.slot === si).forEach((e) => {
          ok(e.t >= starts[si] && e.t <= starts[si] + F.SLOT_SEC[si], tag + ' 帯' + si + ' 到着が帯の中', e.t);
        });
        /* 満卓の札は full の帯にだけ、1回まで */
        const fulls = tl.filter((e) => e.kind === 'full' && e.slot === si).length;
        ok(fulls <= 1 && (fulls === 0 || day.slots[si].full), tag + ' 帯' + si + ' 満卓札', fulls);
      }

      /* --- 時刻が昇順、全部が一日の中 --- */
      for (let i = 1; i < tl.length; i++) ok(tl[i].t >= tl[i - 1].t, tag + ' 時刻昇順 ' + i);
      ok(tl.every((e) => e.t >= 0 && e.t <= summary.duration), tag + ' 一日の中');
      eq(tl[0].kind, 'slotStart', tag + ' 先頭は開店');
      eq(tl[tl.length - 1].kind, 'dayEnd', tag + ' 末尾は閉店');

      /* --- 到着1つに退店1つ・支払い1つ。支払いは到着の帯に付く --- */
      const arrives = tl.filter((e) => e.kind === 'arrive');
      const leaves = tl.filter((e) => e.kind === 'leave');
      const pays = tl.filter((e) => e.kind === 'pay');
      eq(leaves.length, arrives.length, tag + ' 到着と退店が同数');
      eq(pays.length, arrives.length, tag + ' 到着と支払いが同数');
      const bySlot = {};
      arrives.forEach((a) => { bySlot[a.guestId] = a.slot; });
      pays.forEach((p) => eq(p.slot, bySlot[p.guestId], tag + ' 支払いの帯 ' + p.guestId));

      /* --- 群の人数はその型の val 以下。群でなければ1 --- */
      arrives.forEach((a) => {
        const t = G.BY_KEY[a.typeKey];
        const isGroup = t.effect && t.effect.kind === 'group';
        ok(isGroup ? a.count >= 1 && a.count <= t.effect.val : a.count === 1, tag + ' 群の人数 ' + a.typeKey, a.count);
      });

      /* --- 席を模擬して、占有≤席数・歩行≤MAX_WALK・swapの条件 を見る --- */
      const seated = new Map();     // guestId -> count
      const walking = [];           // {until}
      let bad = 0, evictedAt = 0, evictedT = -1;
      tl.forEach((e) => {
        if (e.kind === 'leave') {
          seated.delete(e.guestId);
          /* 追い出しの退店は到着が原因。到着側の判定では「まだ座っていた」として扱う */
          if (e.evicted) { if (e.t !== evictedT) { evictedT = e.t; evictedAt = 0; } evictedAt += e.count; }
        }
        if (e.kind !== 'arrive') return;
        const used = Array.from(seated.values()).reduce((a, b) => a + b, 0);
        const freeNow = seats - used;
        const freeBefore = e.evict && e.t === evictedT ? freeNow - evictedAt : freeNow;
        if (e.evict) evictedAt = 0;
        const walkers = walking.filter((w) => w.until > e.t).length;
        if (e.mode === 'walk') {
          ok(!e.evict && freeBefore >= e.count, tag + ' walk は空席があるとき ' + e.guestId, freeBefore);
          ok(walkers < F.MAX_WALK, tag + ' 歩行中が上限未満 ' + e.guestId, walkers);
          walking.push({ until: e.t + F.WALK_SEC });
        } else {
          ok(freeBefore < e.count || walkers >= F.MAX_WALK,
            tag + ' swap は満席か歩行枠が埋まっているときだけ ' + e.guestId, freeBefore + '/' + walkers);
          if (e.evict) ok(freeBefore < e.count, tag + ' 追い出しは満席のときだけ ' + e.guestId, freeBefore);
        }
        seated.set(e.guestId, e.count);
        const now = Array.from(seated.values()).reduce((a, b) => a + b, 0);
        if (now > seats) bad++;
      });
      eq(bad, 0, tag + ' 占有が席数を超えない');

      /* --- 同時刻は 退店 → 到着 の順 --- */
      for (let i = 1; i < tl.length; i++) {
        if (tl[i].t === tl[i - 1].t && tl[i - 1].kind === 'arrive' && tl[i].kind === 'leave') {
          ok(false, tag + ' 同時刻で到着が退店より先に来ている ' + i);
        }
      }

      /* --- 臨時収入と割り込みが置かれている --- */
      eq(tl.filter((e) => e.kind === 'bonus').length, 1, tag + ' 臨時収入');
      eq(tl.filter((e) => e.kind === 'interrupt').length, 1, tag + ' 割り込み');
    }

    /* --- 種を固定すると同じタイムライン --- */
    const day = Jansou.computeDay(cfg, seeded(99));
    const opts = { fees, tableIdx, slotStaff: [[1], [1, 2], [1, 2, 3]] };
    const a = F.build(day, opts, seeded(5)).timeline;
    const b = F.build(day, opts, seeded(5)).timeline;
    eq(JSON.stringify(a), JSON.stringify(b), name + ' 種が同じなら同じタイムライン');
    const c = F.build(day, opts, seeded(6)).timeline;
    ok(JSON.stringify(a) !== JSON.stringify(c), name + ' 種が違えば変わる');
  });

  /* 密度の実測を表示しておく（数値の検証ではなく、目で見るため） */
  const cfgL = cases[3][1];
  let w = 0, s = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const r = F.build(Jansou.computeDay(cfgL, seeded(seed)), { fees, tableIdx: cases[3][2] }, seeded(seed));
    r.summary.perSlot.forEach((p) => { w += p.walks; s += p.swaps; });
  }
  console.log('  終盤の演出モード: 歩く ' + Math.round(100 * w / (w + s)) + '% / 席で入れ替わる ' + Math.round(100 * s / (w + s)) + '%');
}

/* ============================================================
   第3段階：顔の池・常連の登録・推しファンの条件・来訪者・帯のスタッフ
   ============================================================ */
{
  const G = JansouGuests, F = JansouFloor;
  const { Jansou } = require('../src/jansou.js');
  function seeded(seed) {
    let x = (seed | 0) || 1;
    return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x |= 0; return ((x >>> 0) % 100000) / 100000; };
  }

  /* --- 顔の id --- */
  eq(G.typeOfFace(G.faceId('kaisha', 7)), 'kaisha', '顔の id からタイプが戻る');
  ok(G.pickFace('madam', {}, {}, seeded(3)).indexOf('madam#') === 0, '池から引いた顔は同じタイプ');
  eq(G.pickFace('madam', {}, {}, seeded(3)), G.pickFace('madam', {}, {}, seeded(3)), '種が同じなら同じ顔');
  /* 知っている顔が居ればそちらが混ざる（100回引いて一度も出ないことはない） */
  {
    const rng = seeded(9); let hit = 0;
    for (let i = 0; i < 100; i++) if (G.pickFace('kaisha', { 'kaisha#3': { visits: 5 } }, {}, rng) === 'kaisha#3') hit++;
    ok(hit > 20 && hit < 90, '知っている顔は再訪しやすい', hit);
  }

  /* --- 常連の登録（純関数） --- */
  const names = { 'kaisha#1': { sei: '佐藤', mei: '健一', nijina: '速攻の', sex: 'male' } };
  const meta = { 'kaisha#1': { typeKey: 'kaisha', favTalent: null } };
  let r = G.bumpRegulars({}, {}, ['kaisha#1'], names, meta);
  eq(r.seen['kaisha#1'], 1, '1回目は seen に回数だけ');
  ok(!r.regulars['kaisha#1'], '1回目は常連にならない');
  r = G.bumpRegulars(r.regulars, r.seen, ['kaisha#1', 'kaisha#1'], names, meta);
  eq(r.seen['kaisha#1'], 2, '同じ日に二度居ても1回と数える');
  ok(!r.regulars['kaisha#1'], '2回目もまだ一見さん');
  r = G.bumpRegulars(r.regulars, r.seen, ['kaisha#1'], names, meta);
  ok(!!r.regulars['kaisha#1'], '3回目で常連に登録される');
  eq(r.regulars['kaisha#1'].sei, '佐藤', '登録された名前は先に用意したもの');
  eq(r.regulars['kaisha#1'].visits, 3, '登録時の回数は3');
  ok(!('kaisha#1' in r.seen), '登録されたら seen から外れる');
  eq(r.promoted.length, 1, '昇格の通知が1件');
  eq(G.displayName(r.regulars['kaisha#1']), '佐藤さん', '3回目の表示は名字だけ');
  /* 名前が用意されていない顔は登録されない（一見さんのまま） */
  const r2 = G.bumpRegulars({}, { 'inkyo#2': 2 }, ['inkyo#2'], {}, {});
  ok(!r2.regulars['inkyo#2'] && r2.seen['inkyo#2'] === 3, '名前が無ければ登録しない');
  /* 常連の回数が進み、10回でフルネーム、30回で二つ名 */
  let reg = { 'madam#4': { typeKey: 'madam', visits: 9, sei: '井上', mei: '恵子', nijina: '三色の', sex: 'female' } };
  r = G.bumpRegulars(reg, {}, ['madam#4'], {}, {});
  eq(G.displayName(r.regulars['madam#4']), '井上恵子', '10回でフルネーム');
  eq(r.promoted[0] && r.promoted[0].stage, 2, '常連への昇格通知');
  reg = { 'madam#4': { typeKey: 'madam', visits: 29, sei: '井上', mei: '恵子', nijina: '三色の', sex: 'female' } };
  r = G.bumpRegulars(reg, {}, ['madam#4'], {}, {});
  eq(G.displayName(r.regulars['madam#4']), '三色の井上恵子', '30回で二つ名つき');
  /* 上限。seen は200、regulars は200 */
  const bigSeen = {}; for (let i = 0; i < 230; i++) bigSeen['gakusei#' + i] = 1 + (i % 2);
  eq(Object.keys(G.trimSeen(bigSeen)).length, 200, 'seen は200件まで');
  const bigReg = {}; for (let i = 0; i < 205; i++) bigReg['kaisha#' + i] = { visits: 3 + i };
  const r3 = G.bumpRegulars(bigReg, {}, [], {}, {});
  eq(Object.keys(r3.regulars).length, 200, 'regulars は200人まで');
  ok(!r3.regulars['kaisha#0'] && !!r3.regulars['kaisha#204'], '落ちるのは回数の少ないほう');

  /* --- ビルダー：推しファン・来訪者・帯のスタッフ・同じ人は一日に一度 --- */
  const fees = Jansou.SLOTS.map((s) => s.fee);
  const cfg = { tables: 8, interior: 5, auto: 3, sign: 3, rep: 85, slotPop: [300, 400, 500], slotWorkers: [8, 10, 12] };
  for (let seed = 1; seed <= 15; seed++) {
    const day = Jansou.computeDay(cfg, seeded(seed));
    const tl = F.build(day, { fees, tableIdx: [0, 1, 2, 3, 4, 5, 6, 7],
      slotStaff: [[], [7, 8], [7, 8, 9]],
      visitor: { slot: 2, at: 6, typeKey: 'arashi', name: '流しの辰巳', stay: 6 } }, seeded(seed * 7)).timeline;
    /* 昼はスタッフが居ないので推しファンは来ない */
    ok(!tl.some((e) => e.kind === 'arrive' && e.slot === 0 && e.typeKey === 'oshifan'), 'seed' + seed + ' 推しになれる子が居ない帯に推しファンは来ない');
    tl.filter((e) => e.kind === 'arrive' && e.typeKey === 'oshifan').forEach((e) => {
      ok([7, 8, 9].indexOf(e.favTalent) >= 0, 'seed' + seed + ' 推しファンの推しは出勤している子', e.favTalent);
    });
    /* 来訪者は帳簿に載らない */
    eq(tl.filter((e) => e.kind === 'visitor').length, 1, 'seed' + seed + ' 来訪者が1回');
    eq(tl.filter((e) => e.kind === 'visitorLeave').length, 1, 'seed' + seed + ' 来訪者が去る');
    for (let si = 0; si < 3; si++) {
      const cnt = tl.filter((e) => e.kind === 'arrive' && e.slot === si).reduce((a, e) => a + e.count, 0);
      eq(cnt, day.slots[si].guests, 'seed' + seed + ' 帯' + si + ' 来訪者を数えても Σcount=guests');
    }
    /* slotStart が帯のスタッフを持つ */
    const starts = tl.filter((e) => e.kind === 'slotStart');
    eq(JSON.stringify(starts.map((e) => e.staff)), JSON.stringify([[], [7, 8], [7, 8, 9]]), 'seed' + seed + ' 帯ごとの出勤者');
    /* 同じ人は一日に一度 */
    const ids = tl.filter((e) => e.kind === 'arrive').map((e) => e.guestId);
    eq(new Set(ids).size, ids.length, 'seed' + seed + ' 同じ客が一日に二度来ない');
    /* 到着の amount は支払いと同じ額 */
    const pays = {}; tl.filter((e) => e.kind === 'pay').forEach((e) => { pays[e.guestId] = e.amount; });
    tl.filter((e) => e.kind === 'arrive').forEach((e) => eq(pays[e.guestId], e.amount, 'seed' + seed + ' 到着の額＝支払い ' + e.guestId));
  }
  /* 主（段階3）の常連は nushi の姿で来る */
  {
    const day = Jansou.computeDay(cfg, seeded(2));
    const regs = {}; for (let n = 0; n < 40; n++) regs['kaisha#' + n] = { typeKey: 'kaisha', visits: 31, sei: 'a', mei: 'b', nijina: 'c' };
    const tl = F.build(day, { fees, tableIdx: [0, 1, 2, 3], slotStaff: [[1], [1], [1]], regulars: regs }, seeded(4)).timeline;
    const ks = tl.filter((e) => e.kind === 'arrive' && e.typeKey === 'kaisha' && !e.transient);
    ok(ks.length > 0 && ks.every((e) => e.look === 'nushi'), '30回通った会社帰りは主の姿', ks.length);
  }
}

/* ============================================================
   第4段階：ボトル勝負（spec.md §9）
   ============================================================ */
{
  const G = JansouGuests, F = JansouFloor;
  function seeded(seed) {
    let x = (seed | 0) || 1;
    return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x |= 0; return ((x >>> 0) % 100000) / 100000; };
  }

  /* --- 6段階の値段は §9.2 のとおり --- */
  eq(G.BOTTLES.length, 6, 'ボトルは6段階');
  eq(G.BOTTLES.map((b) => b.price).join(','), '12000,30000,60000,120000,300000,800000', '売値は §9.2 のとおり');
  G.BOTTLES.forEach((b) => ok(b.cost < b.price, b.name + ' の仕入れ値は売値より安い'));
  ok(G.BOTTLE_SPRITE.length === 14 && G.BOTTLE_SPRITE.every((l) => l.length === 8), '瓶の絵は8×14');

  /* --- 荒らしの言い値は段階3〜4（10万円と桁が揃う） --- */
  for (let i = 1; i <= 50; i++) { const t = G.arashiTier(seeded(i)); ok(t === 3 || t === 4, '荒らしの言い値は3か4', t); }

  /* --- 挑戦者の抽選：一日に多くて一組、卓ごとの段階の範囲 --- */
  const regs = { 'kaisha#1': { typeKey: 'kaisha', visits: 35 }, 'shachou#2': { typeKey: 'shachou', visits: 12 },
                 'shachou#3': { typeKey: 'shachou', visits: 31 } };
  const faces = [{ id: 'kaisha#1', typeKey: 'kaisha' }, { id: 'uchishi#4', typeKey: 'uchishi' },
                 { id: 'shachou#2', typeKey: 'shachou' }, { id: 'shachou#3', typeKey: 'shachou' }, { id: 'inkyo#9', typeKey: 'inkyo' }];
  const seenKinds = {};
  for (let i = 1; i <= 300; i++) {
    const c = G.pickChallenge(faces, regs, { rep: 50 }, seeded(i));
    if (!c) continue;
    seenKinds[c.kind] = (seenKinds[c.kind] || 0) + 1;
    ok(['nushi', 'uchishi', 'shachou'].indexOf(c.kind) >= 0, '挑戦の種類', c.kind);
    ok(c.kind !== 'arashi', '荒らしは抽選から出ない（pickEvent が唯一の発生源）');
    if (c.kind === 'nushi') { eq(c.tier, 1, '主はビール'); eq(c.guestId, 'kaisha#1', '主は段階3の常連'); }
    if (c.kind === 'uchishi') ok(c.tier === 2 || c.tier === 3, '打ち師はハウス〜日本酒', c.tier);
    if (c.kind === 'shachou') {
      ok(c.tier >= 4 && c.tier <= 6, '社長はワイン〜タワー', c.tier);
      if (c.guestId === 'shachou#2') ok(c.tier === 5, '常連（段階2）の社長はシャンパン', c.tier);
      if (c.guestId === 'shachou#3') ok(c.tier === 5 || c.tier === 6, '主の社長はシャンパンかタワー', c.tier);
    }
  }
  ok(seenKinds.nushi && seenKinds.uchishi && seenKinds.shachou, '三種とも出る', JSON.stringify(seenKinds));
  ok(!G.pickChallenge([{ id: 'inkyo#1', typeKey: 'inkyo' }], {}, { rep: 50 }, seeded(1)), '挑まない客だけなら無し');
  ok(!G.pickChallenge([{ id: 'uchishi#1', typeKey: 'uchishi' }], {}, { rep: 10 }, seeded(1)), '評判30未満に打ち師は挑まない');

  /* --- 結果：金は賭けない。負けたほうがボトルを入れる --- */
  let r = G.resolveBottle('shachou', 5, 'win', 0, {});
  eq(r.extraMoney, 300000, '勝てば客が入れる（+売値）'); eq(r.bottleDelta, 0, '勝ったとき在庫は減らない');
  r = G.resolveBottle('shachou', 5, 'lose', 3, {});
  eq(r.extraMoney, 0, '在庫があれば負けても金は動かない'); eq(r.bottleDelta, -1, '負ければ店がおごる（在庫 −1）');
  r = G.resolveBottle('shachou', 5, 'lose', 0, {});
  eq(r.extraMoney, -100000, '在庫が無ければ仕入れ費を引く'); eq(r.bottleDelta, 0, '在庫はマイナスにならない');
  r = G.resolveBottle('shachou', 6, 'win', 0, {});
  ok(r.buffs.length === 1 && r.buffs[0].kind === 'pull', 'タワーは翌日以降の客足が増える');
  r = G.resolveBottle('nushi', 1, 'lose', 0, {});
  eq(r.extraMoney + r.bottleDelta + r.repDelta, 0, '主に負けても失うものなし');
  r = G.resolveBottle('nushi', 1, 'win', 0, {});
  eq(r.visitsBonus, 2, '主に勝つと忠誠が上がる');
  eq(G.resolveBottle('uchishi', 2, 'refuse', 0, {}).repDelta, -1, '断って評判が下がるのは果たし状だけ');
  eq(G.resolveBottle('shachou', 4, 'refuse', 0, {}).repDelta, 0, '社長を断っても評判は下がらない');
  eq(G.resolveBottle('nushi', 1, 'refuse', 0, {}).repDelta, 0, '主を断っても評判は下がらない');
  /* 荒らし：打たない解決策 */
  eq(G.resolveBottle('arashi', 3, 'guard', 0, {}).extraMoney, -30000, '用心棒は3万円');
  eq(G.resolveBottle('arashi', 3, 'police', 0, {}).repDelta, -2, '警察は評判 −2');
  ok(G.resolveBottle('arashi', 3, 'nushiShoo', 0, {}).evicted, '主が追い返す');
  r = G.resolveBottle('arashi', 4, 'lose', 0, { nightSales: 100000 });
  eq(r.extraMoney, -40000 - 10000, '荒らしに負けると仕入れ費と夜の売上の1割');
  ok(G.resolveBottle('arashi', 4, 'win', 0, {}).extraMoney === 120000, '荒らしに勝てば言い値のボトルが入る');

  /* --- タイムラインへの差し込みが順を保つ --- */
  const tl = [{ t: 1, kind: 'arrive' }, { t: 3, kind: 'leave' }, { t: 3, kind: 'arrive' }, { t: 5, kind: 'slotEnd' }];
  F.insertEvent(tl, { t: 3, kind: 'interrupt' });
  eq(tl.map((e) => e.t + e.kind).join(' '), '1arrive 3leave 3arrive 3interrupt 5slotEnd', '同時刻でも種類の順を保って差さる');
}

/* ============================================================
   第5段階：内装・卓の型・宣伝の段階（spec.md §10）
   ============================================================ */
{
  global.STYLES = global.STYLES || { a: 1 };
  const { Jansou } = require('../src/jansou.js');

  /* --- **数値は変えない。**引き継ぎ書 §4 の実測がこれに乗っている --- */
  eq(Jansou.INTERIOR.map((x) => x.mul).join(','), '1,1.12,1.26,1.42,1.6', '内装の mul は据え置き');
  eq(Jansou.INTERIOR.map((x) => x.cost).join(','), '0,400000,1000000,2500000,6000000', '内装の cost は据え置き');
  eq(Jansou.AUTO.map((x) => x.rot).join(','), '1,1.25,1.5', '卓の型の rot は据え置き');
  eq(Jansou.SIGN.map((x) => x.pull).join(','), '0,0.1,0.22', '宣伝の pull は据え置き');
  eq(Jansou.SIGN.map((x) => x.ev).join(','), '0.2,0.28,0.36', '宣伝の ev は据え置き');
  [Jansou.INTERIOR, Jansou.AUTO, Jansou.SIGN].forEach((arr, i) => {
    arr.forEach((x) => ok(typeof x.see === 'string' && x.see.length > 0,
      ['内装', '卓の型', '宣伝'][i] + ' ' + x.lv + ' に「見えるもの」がある'));
  });

  /* --- 段階を上げると絵が増える（矩形の数で見る） --- */
  const F = JansouFloor;
  const made = [];
  global.document = {
    createElementNS: () => {
      const n = { attrs: {}, children: [], setAttribute: (k, v) => { n.attrs[k] = v; },
        appendChild: (c) => { n.children.push(c); made.push(c); return c; } };
      return n;
    },
  };
  function countRoom(parlor) {
    made.length = 0;
    const g = global.document.createElementNS();
    const fl = F.autoPlace({ tables: 2, interior: parlor.interior });
    F.drawWall(g, parlor); F.drawCarpet(g, parlor); F.drawFixtures(g, fl, parlor);
    return g.children.length;
  }
  const base = { interior: 1, auto: 1, sign: 1 };
  const counts = [1, 2, 3, 4, 5].map((lv) => countRoom(Object.assign({}, base, { interior: lv })));
  for (let i = 1; i < counts.length; i++) {
    ok(counts[i] > counts[i - 1], '内装' + (i + 1) + 'で絵が増える', counts[i - 1] + '→' + counts[i]);
  }
  /* 看板は段階1で「貼り紙」を描くので、数ではなく**灯りの色**で見る。
     1 貼り紙だけ（灯らない）／2 GIRLS が桃色に灯る／3 ★ MAHJONG の水色とLEDが入る */
  /* 内装1で見る。内装3以上だと指名パネルの色（水色・黄・緑）が混ざって、
     看板が灯ったのかパネルの色なのか区別できない */
  function wallColors(sign) {
    made.length = 0;
    const g = global.document.createElementNS();
    F.drawWall(g, { interior: 1, sign });
    return new Set(made.map((r) => r.attrs.fill));
  }
  const c1 = wallColors(1), c2 = wallColors(2), c3 = wallColors(3);
  ok(!c1.has(F.PAL.neonPink), '宣伝1では看板が灯らない');
  ok(c1.has('#e8dcc8'), '宣伝1は貼り紙が貼ってある');
  ok(c2.has(F.PAL.neonPink), '宣伝2で GIRLS が灯る');
  ok(!c2.has(F.PAL.neonCyan), '宣伝2ではまだ MAHJONG は灯らない');
  ok(c3.has(F.PAL.neonCyan) && c3.has(F.PAL.neonYellow), '宣伝3で ★ MAHJONG が灯る');
  ok(c3.has(F.PAL.neonGreen), '宣伝3で壁の下端にLEDが入る');
  /* 卓の型で卓の絵が増える */
  const tcount = [1, 2, 3].map((lv) => {
    made.length = 0;
    const g = global.document.createElementNS();
    F.drawTable(g, { x: 10, y: 60 }, 'normal', lv);
    return g.children.length;
  });
  for (let i = 1; i < tcount.length; i++) {
    ok(tcount[i] > tcount[i - 1], '卓の型' + (i + 1) + 'で卓の絵が増える', tcount[i - 1] + '→' + tcount[i]);
  }
  /* どの組み合わせでも描けて、矩形が床からはみ出さない */
  for (let iv = 1; iv <= 5; iv++) for (let au = 1; au <= 3; au++) for (let sg = 1; sg <= 3; sg++) {
    made.length = 0;
    const g = global.document.createElementNS();
    const parlor = { interior: iv, auto: au, sign: sg };
    const fl = F.autoPlace({ tables: 8, interior: iv });
    F.drawWall(g, parlor); F.drawCarpet(g, parlor); F.drawFixtures(g, fl, parlor);
    F.tablesOf(fl).forEach((t) => F.drawTable(g, t, 'normal', au));
    const tag = `内装${iv}/卓${au}/宣伝${sg}`;
    ok(g.children.length > 0, tag + ' が描ける');
    let out = 0;
    made.forEach((r) => {
      const a = r.attrs;
      if (a.x == null) return;
      if (+a.x < 0 || +a.x + (+a.width || 0) > F.FLOOR_W || +a.y < 0 || +a.y + (+a.height || 0) > F.FLOOR_H) out++;
    });
    eq(out, 0, tag + ' の絵が床からはみ出さない');
  }
  delete global.document;
}

/* ============================================================
   月末決算・月報（monthly.md §7 の検算）
   ============================================================ */
{
  const M = Jansou.MONTH_DAYS;
  eq(M, 30, 'ひと月は30日（wageOf の割る数と対）');

  /* wageOf が MONTH_DAYS で割っている。**値は30のままで実測が動いていない** */
  eq(Jansou.wageOf({ salary: 300000 }), 4000 + 10000, 'wageOf は月給の三十分割を乗せる');
  eq(Jansou.wageOf({}), 4000, 'salary が無ければ底だけ');

  /* ---- 決定的な「一日」を作る。乱数は使わない ---- */
  function fakeDay(seed) {
    const g = [8 + (seed % 5), 14 + (seed % 7), 22 + (seed % 3)];
    return {
      slots: [{ guests: g[0], sales: g[0] * 1600 },
              { guests: g[1], sales: g[1] * 2100 },
              { guests: g[2], sales: g[2] * 2600 }],
      wages: 40000 + seed * 100,
      util: 8000 + 4 * 1500,
      extraBottle: seed % 4 === 0 ? 30000 : 0,
      extraTip: (seed % 3) * 300,
      extraOther: seed % 7 === 0 ? -50000 : 0,
      full: seed % 5 === 0,
      profit: 0,
      events: { bottle: seed % 4 === 0 ? 1 : 0, arashi: seed % 9 === 0 ? 1 : 0 },
      work: { 11: 2, 12: 1 },
      nominate: seed % 2 === 0 ? { 11: 1 } : {},
      grow: { 11: 0.12, 12: 0.07 },
      promo: { stage1: seed % 6 === 0 ? 1 : 0, stage2: 0, stage3: 0 },
    };
  }
  /* profit はその日の確定式（settle と同じ）。整数だけで組む */
  function withProfit(d) {
    const fee = d.slots.reduce((a, s) => a + s.sales, 0);
    const extra = d.extraBottle + d.extraTip + d.extraOther;
    return Object.assign({}, d, { profit: fee + extra - d.wages - d.util });
  }

  let month = Jansou.blankMonth(60, 38, [2, 1, 0, 0, 0, 0]);
  const days = [];
  for (let i = 0; i < M; i++) { const d = withProfit(fakeDay(i)); days.push(d); month = Jansou.accrue(month, d); }

  eq(month.days, M, '30日ぶん積んだ');
  eq(month.profits.length, M, '日ごとの profit が30件');

  const ctx = { no: 3, toDay: 90, rep: 52, bottles: [3, 2, 1, 0, 0, 0],
                regulars: { s1: 34, s2: 12, s3: 3 },
                names: { 11: { name: '桐生ひかり', pop: 92 }, 12: { name: '白鳥さくら', pop: 78 } },
                promotedNames: { 12: 'C' } };
  const rep = Jansou.closeMonth(month, null, ctx);

  /* ---- §7 の検算その1：帯の合計が場代に厳密一致 ---- */
  eq(rep.bands.reduce((a, b) => a + b.sales, 0), rep.fee, '帯の合計が場代に厳密一致（一円まで）');
  eq(rep.bands.reduce((a, b) => a + b.guests, 0), rep.guests, '帯の人数の合計が客数に一致');
  /* 帯は month.slots からしか来ていない（平均や割合が混ざっていない） */
  eq(rep.fee, month.slots.reduce((a, s) => a + s.sales, 0), '場代は帯の合計として定義されている');

  /* ---- §7 の検算その2：収支の整合 ---- */
  eq(rep.fee + rep.extra.total - rep.wages - rep.util, rep.profit, '収支の帯 四本の合計が収支に一致');
  eq(month.profits.reduce((a, n) => a + n, 0), rep.profit, '月の収支が Σ（その日の profit）に一致');
  eq(rep.extra.bottle + rep.extra.tip + rep.extra.other, rep.extra.total, '臨時収入の内訳の合計が臨時収入に一致');

  /* ---- §7 の検算その3：closeMonth は純関数（二度通して同じ） ---- */
  const rep2 = Jansou.closeMonth(month, null, ctx);
  eq(JSON.stringify(rep2), JSON.stringify(rep), 'closeMonth を二度通すと深く等しい（乱数も Date も引かない）');
  /* accrue も月を壊さない（新しい月を返す） */
  const before = JSON.stringify(month);
  Jansou.accrue(month, withProfit(fakeDay(99)));
  eq(JSON.stringify(month), before, 'accrue は渡された月を書き換えない');

  /* ---- 中身の妥当性 ---- */
  eq(rep.avgGuests, Math.round(rep.guests / M), '一日平均は客数と日数から');
  eq(rep.top[0].name, '桐生ひかり', '人気×出勤日数の一位');
  eq(rep.top[0].days, M, '出勤日数が30日');
  eq(rep.rep.from, 38, '期首の評判');
  eq(rep.rep.to, 52, '期末の評判');
  eq(rep.rep.delta, 14, '評判の差');
  eq(rep.bottles.fromTotal, 3, 'ボトル在庫の期首の本数');
  eq(rep.bottles.nowTotal, 6, 'ボトル在庫の期末の本数');
  eq(rep.vs, null, '前期が無ければ差分を出さない（「±0」も出さない）');
  ok(rep.bands.every((b) => b.pct >= 0 && b.pct <= 100), '帯の長さは0〜100%');
  eq(rep.bands.reduce((a, b) => Math.max(a, b.pct), 0), 100, 'いちばん長い帯が100%');
  eq(rep.grow.find((g) => g.name === '白鳥さくら').promoted, 'C', '昇格が月報に載る');

  /* ---- 前期との比較 ---- */
  const prev = Object.assign({}, rep, { fee: 10000000, profit: 5000000, guests: 4000,
                                        regulars: { s1: 28, s2: 9, s3: 2 } });
  const rep3 = Jansou.closeMonth(month, prev, ctx);
  eq(rep3.vs.fee, rep.fee - 10000000, '前期比（場代の差）');
  eq(rep3.vs.profit, rep.profit - 5000000, '前期比（収支の差）');
  eq(rep3.vs.regulars, (34 + 12 + 3) - (28 + 9 + 2), '前期比（常連の差）');
  eq(rep3.vs.feePct, Math.round(((rep.fee - 10000000) / 10000000) * 100), '前期比（％）');
  const rep4 = Jansou.closeMonth(month, Object.assign({}, prev, { fee: 0, profit: 0, guests: 0 }), ctx);
  eq(rep4.vs.feePct, null, '前期がゼロなら％を出さない（ゼロ除算しない）');

  /* ---- §7 の検算その4：renderMonth は report を読むだけ（二回描画して文字列一致） ---- */
  const h1 = Jansou.renderMonth(rep);
  const h2 = Jansou.renderMonth(rep);
  eq(h1, h2, 'renderMonth を二回通すと文字列が完全一致（中で計算していない）');
  /* 締めたときと読み返したときで同じものが出る。closeMonth を通し直しても同じ */
  eq(Jansou.renderMonth(Jansou.closeMonth(month, null, ctx)), h1,
     '締めたときと読み返したときで月報が一致する');
  /* 月報に出る額が report の値そのままであること（描画側で作っていない） */
  ok(h1.indexOf(Math.round(rep.fee).toLocaleString('ja-JP')) >= 0, '場代が月報に出ている');
  ok(h1.indexOf(Math.round(rep.profit).toLocaleString('ja-JP')) >= 0, '収支が月報に出ている');
  ok(h1.indexOf('data-pct="100"') >= 0, 'いちばん長い帯が100%で描かれる');
  ok(h1.indexOf('<canvas') < 0, '月報に canvas を使っていない（表紙の一枚だけ）');
  /* **月報は <p class="jnPopText"> の中に入る。**div を混ぜるとパーサが p を閉じ、
     以降が p の外に出て text-align も継承も壊れる（日報が span で組んでいるのと同じ理由）。
     見た目だけ崩れて数字は合っているので、気づきにくい */
  ok(h1.indexOf('<div') < 0, '月報は span だけで組む（p の中に入るので div を混ぜない）');
  ok(h1.indexOf('<p') < 0, '月報に p を入れない（同上）');
  /* 名前は esc を通している（プレイヤー名と同じ経路。HANDOVER §4） */
  const evil = Jansou.closeMonth(month, null, Object.assign({}, ctx,
    { names: { 11: { name: '<img src=x onerror=alert(1)>', pop: 92 }, 12: ctx.names[12] } }));
  ok(Jansou.renderMonth(evil).indexOf('<img src=x') < 0, '名前は esc を通してから埋める');

  /* ---- 空の月でも壊れない（開店初日に月報を開いた場合） ---- */
  const empty = Jansou.closeMonth(Jansou.blankMonth(0, 10, [0, 0, 0, 0, 0, 0]), null,
    { no: 1, toDay: 0, rep: 10, bottles: [0, 0, 0, 0, 0, 0], regulars: { s1: 0, s2: 0, s3: 0 },
      names: {}, promotedNames: {} });
  eq(empty.fee, 0, '空の月でも場代は0');
  eq(empty.avgGuests, 0, '空の月で一日平均がゼロ除算にならない');
  eq(empty.bands[0].pct, 0, '空の月で帯の長さが0');
  ok(Jansou.renderMonth(empty).length > 0, '空の月でも月報が描ける');
}

/* ============================================================
   normalize：月を落とさない（monthly.md §9 の重大な罠）
   ============================================================ */
{
  /* **これが落ちると「月報は出るが全部0」になる。**normalize は既知のキーだけで
     組み直すので、month を書き忘れると毎日の集計が消える */
  let p = Jansou.normalize({ open: true, day: 47 });
  ok(p.month != null, 'normalize が month を返す');
  ok(Array.isArray(p.months), 'normalize が months を返す');
  eq(p.month.from, 47, '既存セーブは month.from に「今日」が入る（初回も30日ぶんになる）');
  eq(p.month.days, 0, '既存セーブの集計はゼロから');
  eq(p.month.repFrom, 10, '期首の評判が控えられる');

  /* 積んだ月が normalize を通しても消えない（毎日の store.set を模す） */
  let m = Jansou.blankMonth(47, 10, [0, 0, 0, 0, 0, 0]);
  m = Jansou.accrue(m, { slots: [{ guests: 1, sales: 1600 }, { guests: 2, sales: 4200 }, { guests: 3, sales: 7800 }],
                         wages: 4000, util: 14000, extraBottle: 0, extraTip: 300, extraOther: 0,
                         full: false, profit: 1600 + 4200 + 7800 + 300 - 4000 - 14000,
                         events: {}, work: { 5: 1 }, nominate: {}, grow: {}, promo: {} });
  for (let i = 0; i < 5; i++) {
    const round = Jansou.normalize({ open: true, day: 48, month: m, months: [] });
    eq(round.month.days, 1, 'normalize を' + (i + 1) + '回通しても集計が消えない');
    eq(round.month.slots[2].sales, 7800, 'normalize を通しても帯が消えない');
    m = round.month;
  }

  /* months は直近12期だけ残す（セーブが無限に伸びない） */
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ no: i + 1 });
  eq(Jansou.normalize({ months: many }).months.length, Jansou.MONTHS_KEPT, 'months は直近12期だけ残す');
  eq(Jansou.normalize({ months: many }).months[0].no, 9, '古い期から落ちる');

  /* **期の番号は months.length から出せない。**上限12で打ち切るので、
     13期目以降ずっと「第13期」になってしまう。直前の月報から進める */
  eq(Jansou.nextMonthNo({ months: [] }), 1, '月報が無ければ第1期');
  eq(Jansou.nextMonthNo({ months: [{ no: 1 }, { no: 2 }] }), 3, '直前の次が今期');
  const trimmed = Jansou.normalize({ months: many }).months;   // no 9〜20 の12件
  eq(trimmed.length, 12, '打ち切られて12件');
  eq(Jansou.nextMonthNo({ months: trimmed }), 21, '打ち切られても番号は進む（length+1 なら13で止まる）');

  /* 壊れたセーブを読んでも作り直す */
  eq(Jansou.normalize({ day: 3, month: { slots: 'こわれている' } }).month.days, 0, '壊れた month は作り直す');
  eq(Jansou.normalize({ day: 3, month: null }).month.from, 3, 'month が null でも from が入る');
}

/* ============================================================
   月末の判定は month.from からの経過で見る（day % 30 にしない）
   ============================================================ */
{
  const M = Jansou.MONTH_DAYS;
  /* from は「この期が始まる前に済んでいる日数」。d はいま終えた日の番号
     （settle での parlor.day + 1）。差がちょうど30になったら締める */
  const isEnd = (d, from) => (d - from) >= M;

  /* 新しいセーブ（from = 0）は 30 / 60 / 90 日目で締まる */
  ok(!isEnd(29, 0), '新しいセーブの29日目はまだ締まらない');
  ok(isEnd(30, 0), '新しいセーブは30日目で締まる');
  ok(isEnd(60, 30), '第2期は60日目で締まる');

  /* 47日目まで打った既存セーブ（from = 47）。第1期は48〜77日目 */
  ok(!isEnd(48, 47), '既存セーブの初日はまだ締まらない');
  ok(!isEnd(76, 47), '29日目はまだ締まらない');
  ok(isEnd(77, 47), '30日目で締まる');
  eq(77 - (47 + 1) + 1, M, '既存セーブの第1期もまるまる30日ぶん（48〜77日目）');

  /* closeMonth が出す期間の表示も 48〜77 になる */
  const r = Jansou.closeMonth(Jansou.blankMonth(47, 10, [0, 0, 0, 0, 0, 0]), null,
    { no: 1, toDay: 77, rep: 10, bottles: [0, 0, 0, 0, 0, 0],
      regulars: { s1: 0, s2: 0, s3: 0 }, names: {}, promotedNames: {} });
  eq(r.fromDay, 48, '月報の初日は from の翌日');
  eq(r.toDay, 77, '月報の最終日');

  /* day % 30 だと、47日目のプレイヤーの初回は14日ぶんで「一ヶ月」を名乗る */
  eq(60 % M, 0, 'day%30 なら60日目で締まってしまい');
  eq(60 - (47 + 1) + 1, 13, '13日ぶりしか入っていない（だから % は使わない）');
}

/* ============================================================
   ポップアップの下に押せる釦を残さない（monthly.md §13）
   ============================================================ */
{
  const H = JansouFloor.skipHidden;

  ok(!H({ playing: true }), '再生中はスキップが出る');
  ok(H({ playing: false }), '再生していなければ出ない');
  ok(H({ playing: true, skipping: true }), 'スキップ済みなら出ない');

  /* ここが本題。**割り込みと客カードで止まっている間は消す。**
     ポップアップは画面ぜんぶを覆うので、押せない釦が見えていると
     自動で回すときクリックが覆いに吸われ、ページが固まったように見える */
  ok(H({ playing: true, waiting: true }), '割り込み中はスキップを消す');
  ok(H({ playing: true, paused: true }), '客カードで止めている間もスキップを消す');
  ok(H({ playing: true, waiting: true, paused: true }), '両方でも消す');

  /* 割り込みが終われば戻る（waiting は finally で false に戻る） */
  ok(!H({ playing: true, waiting: false, paused: false }), '割り込みが終われば戻る');

  /* 引数が無くても落ちない（描画の途中で呼ばれる） */
  ok(H(), '引数なしは隠す');
  ok(H({}), '空でも隠す');
}

/* ============================================================ */
console.log('通過 ' + pass + ' 件');
if (fails.length) {
  console.error('\n失敗 ' + fails.length + ' 件:');
  fails.slice(0, 40).forEach((f) => console.error('  - ' + f));
  if (fails.length > 40) console.error('  … ほか ' + (fails.length - 40) + ' 件');
  process.exit(1);
}
console.log('すべて通過');
