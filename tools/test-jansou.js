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

/* ============================================================ */
console.log('通過 ' + pass + ' 件');
if (fails.length) {
  console.error('\n失敗 ' + fails.length + ' 件:');
  fails.slice(0, 40).forEach((f) => console.error('  - ' + f));
  if (fails.length > 40) console.error('  … ほか ' + (fails.length - 40) + ' 件');
  process.exit(1);
}
console.log('すべて通過');
