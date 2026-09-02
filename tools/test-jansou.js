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
  }
}

/* ============================================================
   卓の配置（卓2〜8が床に収まり、重ならない）
   ============================================================ */
{
  const W = JansouFloor.TABLE_W, H = JansouFloor.TABLE_H;
  [160, 175, 190, 200].forEach((floorW) => {
    for (let n = 2; n <= 8; n++) {
      const ts = JansouFloor.layout(n, floorW);
      eq(ts.length, n, '卓の数 卓' + n + ' 幅' + floorW);

      ts.forEach((t, i) => {
        ok(t.x >= 0 && t.x + W <= floorW, '卓が横にはみ出さない 卓' + n + '/' + i + ' 幅' + floorW, t.x);
        ok(t.y >= JansouFloor.CARPET_Y && t.y + H <= JansouFloor.FLOOR_H,
          '卓が縦にはみ出さない 卓' + n + '/' + i, t.y);
      });

      /* 卓どうしが重ならない */
      for (let a = 0; a < ts.length; a++) {
        for (let b = a + 1; b < ts.length; b++) {
          const hit = Math.abs(ts[a].x - ts[b].x) < W && Math.abs(ts[a].y - ts[b].y) < H;
          ok(!hit, '卓が重ならない 卓' + n + ' ' + a + '-' + b + ' 幅' + floorW);
        }
      }

      /* 席も床の中に居ること。壁にめり込むと客が消える */
      ts.forEach((t) => {
        JansouFloor.seatsOf(t).forEach((s, si) => {
          ok(s.x >= -1 && s.x + JansouFloor.SEAT_W <= floorW + 1,
            '席が横にはみ出さない 卓' + n + ' 席' + si + ' 幅' + floorW, s.x);
          ok(s.y >= JansouFloor.CARPET_Y - JansouFloor.SEAT_H,
            '席が壁にめり込まない 卓' + n + ' 席' + si, s.y);
        });
      });
    }
  });
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

/* ============================================================ */
console.log('通過 ' + pass + ' 件');
if (fails.length) {
  console.error('\n失敗 ' + fails.length + ' 件:');
  fails.slice(0, 40).forEach((f) => console.error('  - ' + f));
  if (fails.length > 40) console.error('  … ほか ' + (fails.length - 40) + ' 件');
  process.exit(1);
}
console.log('すべて通過');
