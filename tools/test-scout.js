#!/usr/bin/env node
/*
  遠征先の店の純関数テスト（A4.5-1）

    node tools/test-scout.js

  ここに書くのは **DOMに触らない関数だけ**（test-jansou.js / test-office.js と同じ方針）。
  絵そのものはブラウザ検証（docs/design/scout/spec.md §9）。

  A4.5-2（癖）と A4.5-3（交渉）が入ったら、spec.md §9 の残りをここに足すこと。
*/
'use strict';

const chars = require('../src/characters.js');
Object.assign(global, {
  JANDOLS: chars.JANDOLS, FREE_AGENTS: chars.FREE_AGENTS, STYLES: chars.STYLES,
  PLAYER: chars.PLAYER, REGIONS: chars.REGIONS, RANK_INFO: chars.RANK_INFO,
  CONTRACTS: chars.CONTRACTS,
});
Object.assign(global, require('../src/tournament.js'));
const { Geo } = require('../src/geo.js');
global.Geo = Geo;
global.Scout = require('../src/scout.js');
global.JansouGuests = require('../src/jansou-guests.js').JansouGuests;
/* **これを忘れると `palOf` が空を返し、パレットのテストが素通りする**
   （`palOf` は `JansouFloor.PAL` をグローバルから読む） */
global.JansouFloor = require('../src/jansou-floor.js').JansouFloor;
global.Jansou = require('../src/jansou.js').Jansou;
global.Offers = require('../src/offers.js').Offers;
const { ScoutShop } = require('../src/scoutshop.js');
global.ScoutShop = ScoutShop;
const { Office } = require('../src/office.js');

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  … ' + detail : ''));
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' / want ' + JSON.stringify(b));
}

const blank = () => ({ discovered: [], contracted: [], comp: {}, agency: 1,
                       officePref: 'kyoto', money: 1000000 });
/* store のふり。`shell.html` の store.set と同じ形（知らないキーを残す） */
function fakeStore(st) {
  let s = st;
  return { get: () => s, set: (patch) => { s = Object.assign({}, s, patch); } };
}

/* ============================================================
   店の型（spec.md §3.2）
   ============================================================ */
{
  eq(ScoutShop.SHOP_TYPES.length, 4, '型は四つ');
  const keys = ScoutShop.SHOP_TYPES.map((t) => t.key);
  eq(new Set(keys).size, 4, 'key が重複していない');
  ok(keys.every((k) => /^[a-z]+$/.test(k)), 'key は英数字だけ');
  ok(ScoutShop.SHOP_TYPES.every((t) => t.w.length === 5), '重みは scale 1〜5 の5つ');
  ok(ScoutShop.SHOP_TYPES.every((t) => t.tables[0] <= t.tables[1]), '卓の幅が逆になっていない');
  ok(ScoutShop.SHOP_TYPES.every((t) => t.tables[1] <= 6),
    '卓は6まで（8卓は自分の店の終盤の絵。よその店に出すと格が壊れる）');

  /* **`scale 1` の県では高級店が出ない**（重み0） */
  eq(ScoutShop.TYPE_BY_KEY.lux.w[0], 0, 'scale 1 での高級店の重みは0');
  let lux = 0;
  for (let i = 1; i <= 400; i++) if (ScoutShop.pickType(1, ScoutShop.seeded(i)) === 'lux') lux++;
  eq(lux, 0, 'scale 1 の県では高級店が一度も出ない');

  /* 大きい県ほど高級店が出やすい */
  const rate = (scale) => {
    let n = 0;
    for (let i = 1; i <= 400; i++) if (ScoutShop.pickType(scale, ScoutShop.seeded(i)) === 'lux') n++;
    return n / 400;
  };
  ok(rate(5) > rate(3) && rate(3) > rate(1), '規模が大きいほど高級店が出やすい');

  /* 同じ種なら同じ型（朝に一度引くだけ、があとから変わらない） */
  eq(ScoutShop.pickType(3, ScoutShop.seeded(42)), ScoutShop.pickType(3, ScoutShop.seeded(42)),
    '同じ種なら同じ型');

  /* **種はそのまま渡さない**（線形合同法の一手目は隣の種とほとんど同じ）。
     隣り合う種で型がばらけることを確かめる——ここが崩れると
     日ごとに引いても毎日同じ店が出る（実際に出た） */
  const near = new Set();
  for (let d = 1; d <= 30; d++) near.add(ScoutShop.pickType(4, ScoutShop.seeded(d)));
  ok(near.size >= 3, '隣り合う種でも型がばらける（seeded が種を散らしている）',
    Array.from(near).join(','));
}

/* ---------- パレット（spec.md §3.3） ---------- */
{
  const base = ScoutShop.palOf('girls');
  ok(Object.keys(base).length > 15, 'PAL が読めている（読めないと以下が素通りする）',
    String(Object.keys(base).length));
  /* girls は差し替え無し＝自分の店と同じ絵 */
  eq(JSON.stringify(ScoutShop.PALETTES.girls), '{}',
    'ガールズ雀荘は差し替え無し（自分の店と同じ系統）');

  ScoutShop.SHOP_TYPES.forEach((t) => {
    const p = ScoutShop.palOf(t.key);
    /* **浅いマージで欠けない。**PAL の全キーが埋まっていること */
    const missing = Object.keys(base).filter((k) => p[k] == null);
    eq(missing.length, 0, t.key + ' … PAL の全キーが埋まる（浅いマージ）', missing.join(','));
    /* **ネオンと金は触らない**（§3.3） */
    ['neonPink', 'neonCyan', 'neonYellow', 'neonGreen', 'gold', 'goldHi',
     'staffCloth', 'staffTrim', 'ink'].forEach((k) => {
      eq(p[k], base[k], t.key + ' … ' + k + ' は差し替えない');
    });
    /* 色は #rrggbb の形（打ち間違いで壊れていないこと） */
    const bad = Object.keys(ScoutShop.PALETTES[t.key])
      .filter((k) => !/^#[0-9a-f]{6}$/.test(ScoutShop.PALETTES[t.key][k]));
    eq(bad.length, 0, t.key + ' … 色はすべて #rrggbb', bad.join(','));
  });

  /* **自分の店の絵が変わらないことの錠。**
     `night` / `lamp` / `signOff` は、もともと `drawLight` と `drawWall` に
     直書きしてあった値。パレットに出したのは遠征先の店のためなので、
     **既定はその値のままでなければならない**（変えると自分の店の絵が動く） */
  eq(base.night, '#301634', 'PAL.night は drawLight の直書きと同じ');
  eq(base.lamp, '#ff56b2', 'PAL.lamp は drawLight の直書きと同じ');
  eq(base.signOff, '#4a2a44', 'PAL.signOff は drawWall の直書きと同じ');
  eq(base.signOffLow, '#3a2036', 'PAL.signOffLow は drawWall の直書きと同じ');

  /* 灯りと看板も型ごとに変わる（壁と卓だけだと、どの店も同じに見えた） */
  ['old', 'back', 'lux'].forEach((k) => {
    const p = ScoutShop.palOf(k);
    ok(p.lamp !== base.lamp, k + ' … 夜の灯りが変わる');
    eq(p.signOff, p.wall, k + ' … 消えたネオンは壁に溶かす（GIRLS の看板を出さない）');
  });

  /* 差し替える三系統は、girls 以外では実際に変わっていること */
  ['old', 'back', 'lux'].forEach((k) => {
    const p = ScoutShop.palOf(k);
    ok(p.wall !== base.wall, k + ' … 壁が変わる');
    ok(p.felt !== base.felt, k + ' … ラシャが変わる');
  });
}

/* ============================================================
   その日の店を組む（spec.md §6・§3.5・§3.6）
   ============================================================ */
{
  const st = blank();
  const trip = { pref: 'fukuoka', days: 5, dayLeft: 5 };

  /* 四つの型それぞれで擬似 parlor が組めて、autoPlace が卓を置く */
  const JF = global.JansouFloor;
  ScoutShop.SHOP_TYPES.forEach((t) => {
    /* 型を狙い撃ちできないので、擬似 parlor を型の定義から直に組んで見る */
    const parlor = { tables: t.tables[0], interior: t.interior, auto: t.auto, sign: t.sign, floor: null };
    const floor = JF.reconcile(parlor.floor, { tables: parlor.tables, interior: parlor.interior });
    const tables = JF.tablesOf(floor);
    eq(tables.length, parlor.tables, t.key + ' … autoPlace が卓を ' + parlor.tables + ' 置く');
    tables.forEach((tb) => {
      eq(JF.seatsOf(tb).length, 4, t.key + ' … 置けた卓には必ず4席がある');
    });
  });

  /* 席が重複しない */
  for (let i = 1; i <= 60; i++) {
    const shop = ScoutShop.buildShop(st, trip, ScoutShop.seeded(i));
    const keys = shop.seats.map((s) => s.table + ':' + s.seat);
    if (new Set(keys).size !== keys.length) { ok(false, '席が重複しない'); break; }
    if (i === 60) ok(true, '席が重複しない');
  }

  /* 擬似 parlor は Jansou.normalize を通っていない
     （通すと tables が最低2に丸められるなど、自分の店の決めごとが混ざる） */
  const shop = ScoutShop.buildShop(st, trip, ScoutShop.seeded(3));
  eq(shop.parlor.floor, null, '擬似 parlor の floor は null（描くときに autoPlace が組む）');
  ok(shop.parlor.month === undefined, '擬似 parlor は月報を持たない（normalize を通していない）');
  ok(shop.name.indexOf('雀荘') === 0, '店の名前が付く');
  eq(shop.calls, ScoutShop.CALLS_PER_DAY, '声をかけられる回数は CALLS_PER_DAY から');
  eq(shop.met.length, 0, 'まだ誰にも声をかけていない');

  /* 未契約・未発見の子だけが混じる */
  const st2 = Object.assign(blank(), { discovered: [1, 2, 3], contracted: [1] });
  for (let i = 1; i <= 80; i++) {
    const sh = ScoutShop.buildShop(st2, trip, ScoutShop.seeded(i));
    const ids = sh.seats.map((s) => s.charaId).filter((x) => x != null);
    if (ids.some((id) => st2.discovered.indexOf(id) >= 0)) {
      ok(false, '発見済みの子は混じらない', String(ids)); break;
    }
    if (i === 80) ok(true, '発見済み・契約済みの子は混じらない');
  }

  /* その県の地方から引く（§4.4。雀ドルはまだ県を持たない） */
  const all = JANDOLS.concat(FREE_AGENTS);
  let wrong = 0;
  for (let i = 1; i <= 80; i++) {
    const sh = ScoutShop.buildShop(st, { pref: 'okinawa' }, ScoutShop.seeded(i));
    sh.seats.forEach((s) => {
      if (s.charaId == null) return;
      const c = all.find((x) => x.id === s.charaId);
      if (!c || c.region !== '九州・沖縄') wrong++;
    });
  }
  eq(wrong, 0, '沖縄では九州・沖縄の子しか出ない');
}

/* ---------- 雀ドルがゼロの日が起こりうる（§3.5） ---------- */
{
  const st = blank();
  const count = (pref, n) => {
    let zero = 0;
    for (let i = 1; i <= n; i++) {
      const sh = ScoutShop.buildShop(st, { pref }, ScoutShop.seeded(i));
      if (!sh.seats.some((s) => s.charaId != null)) zero++;
    }
    return zero / n;
  };
  const small = count('tottori', 300);      // scale 1
  const big = count('tokyo', 300);          // scale 5
  ok(small > 0, '**雀ドルが一人もいない日が起こりうる**（規模の小さい県）');
  ok(big > 0, '大きい県でも空振りの日はある');
  ok(small > big, '規模の小さい県ほど空振りが多い',
    '小 ' + Math.round(small * 100) + '% / 大 ' + Math.round(big * 100) + '%');
  ok(small > 0.5, 'scale 1 の県は半分以上が空振り', Math.round(small * 100) + '%');
  ok(big < 0.5, 'scale 5 の県は半分以上で誰かいる', Math.round(big * 100) + '%');

  /* jandolCount そのもの */
  ok([0, 1, 2].indexOf(ScoutShop.jandolCount(3, () => 0.99)) >= 0, '人数は 0〜2');
  eq(ScoutShop.jandolCount(1, () => 0.99), 0, '外れたら0人');
  eq(ScoutShop.jandolCount(5, () => 0.0), 2, '当たり続ければ2人');
}

/* ---------- 声をかけなかった子が、翌日の母集団に残っている（§3.6） ---------- */
{
  const st = blank();
  /* ある日いた子を集め、その子が別の日にも出うることを見る。
     **`buildShop` は「昨日いた子」を除外しない** */
  const seen = new Set();
  for (let i = 1; i <= 200; i++) {
    ScoutShop.buildShop(st, { pref: 'fukuoka' }, ScoutShop.seeded(i))
      .seats.forEach((s) => { if (s.charaId != null) seen.add(s.charaId); });
  }
  /* 何度も引けば、同じ子が別の日にも現れる（母集団から消えていない） */
  const twice = {};
  let repeat = 0;
  for (let i = 1; i <= 200; i++) {
    ScoutShop.buildShop(st, { pref: 'fukuoka' }, ScoutShop.seeded(i))
      .seats.forEach((s) => {
        if (s.charaId == null) return;
        twice[s.charaId] = (twice[s.charaId] || 0) + 1;
        if (twice[s.charaId] === 2) repeat++;
      });
  }
  ok(repeat > 0, '**声をかけなかった子が、別の日にまた出る**（母集団から消えない）');

  /* 発見すれば母集団から抜ける（`findCandidates` が未発見だけを返すため） */
  const one = Array.from(seen)[0];
  const st3 = Object.assign(blank(), { discovered: [one] });
  let still = 0;
  for (let i = 1; i <= 200; i++) {
    if (ScoutShop.buildShop(st3, { pref: 'fukuoka' }, ScoutShop.seeded(i))
      .seats.some((s) => s.charaId === one)) still++;
  }
  eq(still, 0, '発見した子は、以後その店に出ない');
}

/* ============================================================
   朝に一度だけ引く（spec.md §6.2）— Office.ensureShop
   ============================================================ */
{
  const trip = { pref: 'fukuoka', days: 5, dayLeft: 5, log: [], found: [], signed: [],
                 store: { days: 0, guests: 0, sales: 0, profit: 0 } };
  const store = fakeStore(Object.assign(blank(), { trip, somethingFuture: 'のこす' }));

  eq(Office.ensureShop(store, store.get().trip, 10), true, '最初は引く');
  const a = store.get().trip.shop;
  eq(a.day, 10, '引いた日が印として入る');

  /* **同じ朝に二度引いても顔ぶれが変わらない** */
  eq(Office.ensureShop(store, store.get().trip, 10), false, '同じ朝は引き直さない');
  const b = store.get().trip.shop;
  eq(JSON.stringify(a.seats), JSON.stringify(b.seats), '同じ朝なら顔ぶれが変わらない');
  eq(a.name, b.name, '同じ朝なら店も変わらない');

  /* **滞在日が進むと引き直される** */
  eq(Office.ensureShop(store, store.get().trip, 11), true, '日が変われば引き直す');
  const c = store.get().trip.shop;
  eq(c.day, 11, '新しい日の印になる');
  eq(c.calls, ScoutShop.CALLS_PER_DAY, '声をかけられる回数は日ごとに戻る');
  eq(c.met.length, 0, '声をかけた記録も日ごとに戻る');

  eq(store.get().somethingFuture, 'のこす', '知らないキーが残る');

  /* 日と県から種を作っているので、県が違えば別の店になりうる */
  const t2 = Object.assign({}, trip, { pref: 'okinawa' });
  const s2 = fakeStore(Object.assign(blank(), { trip: t2 }));
  Office.ensureShop(s2, s2.get().trip, 10);
  ok(s2.get().trip.shop.name !== a.name || s2.get().trip.shop.type !== a.type,
    '県が違えば別の店になる');
}

/* ---------- 声をかける（§4.2）— Office.callOn ---------- */
{
  const trip = { pref: 'fukuoka', days: 5, dayLeft: 5, log: [], found: [], signed: [],
                 store: { days: 0, guests: 0, sales: 0, profit: 0 } };
  const store = fakeStore(Object.assign(blank(), { trip }));
  Office.ensureShop(store, store.get().trip, 10);

  const shop0 = store.get().trip.shop;
  ok(shop0.seats.length > 3, '席に何人か座っている（試すのに足りる）');

  /* 一回ずつ減る */
  let r = Office.callOn(store, 0);
  ok(r, '声をかけられる');
  eq(r.calls, ScoutShop.CALLS_PER_DAY - 1, '一回使うと減る');
  eq(store.get().trip.shop.met.length, 1, '声をかけた相手が残る');

  /* 同じ相手に二度はかけられない（回数も減らない） */
  const before = store.get().trip.shop.calls;
  eq(Office.callOn(store, 0), null, '同じ相手には二度かけられない');
  eq(store.get().trip.shop.calls, before, '空振りで回数が減らない');

  /* **上限に達したら押せない** */
  Office.callOn(store, 1);
  Office.callOn(store, 2);
  eq(store.get().trip.shop.calls, 0, '3回で打ち止め');
  eq(Office.callOn(store, 3), null, '上限に達したら null');
  eq(store.get().trip.shop.met.length, 3, '記録は3件のまま');

  /* 雀ドルに声をかければ発見される */
  const st2 = Object.assign(blank(), { trip: Object.assign({}, trip) });
  const s2 = fakeStore(st2);
  Office.ensureShop(s2, s2.get().trip, 10);
  const sh = s2.get().trip.shop;
  const idx = sh.seats.findIndex((x) => x.charaId != null);
  if (idx >= 0) {
    const res = Office.callOn(s2, idx);
    ok(res && res.found, '雀ドルに声をかければ見つかる');
    ok((s2.get().discovered || []).indexOf(sh.seats[idx].charaId) >= 0,
      '発見が discovered に入る');
  } else {
    ok(true, '（この種では雀ドルが居なかった。空振りの日は起こりうる・§3.5）');
  }

  /* ただの客に声をかけても、何も見つからないが回数は減る */
  const st3 = Object.assign(blank(), { trip: Object.assign({}, trip) });
  const s3 = fakeStore(st3);
  Office.ensureShop(s3, s3.get().trip, 10);
  const plain = s3.get().trip.shop.seats.findIndex((x) => x.charaId == null);
  if (plain >= 0) {
    const res = Office.callOn(s3, plain);
    ok(res && !res.found, 'ただの客なら何も見つからない');
    eq(res.calls, ScoutShop.CALLS_PER_DAY - 1, 'それでも回数は減る');
    eq((s3.get().discovered || []).length, 0, 'discovered は増えない');
  }
}

/* ---------- 既存のセーブが壊れない（前方互換） ---------- */
{
  /* `trip` に `shop` が無いセーブ（第三段までのもの） */
  const old = { pref: 'osaka', days: 2, dayLeft: 1, log: ['むかしの記録'], found: [], signed: [],
                store: { days: 1, guests: 10, sales: 100, profit: 5 } };
  const store = fakeStore(Object.assign(blank(), { trip: old, somethingFuture: 'のこす' }));
  ok(Office.tripOf(store.get()) !== null, 'shop が無い trip も生きている遠征として読める');
  eq(Office.callOn(store, 0), null, 'shop が無ければ声をかけられない（落ちない）');
  eq(Office.ensureShop(store, store.get().trip, 7), true, '朝に引けば shop が入る');
  eq(store.get().trip.log[0], 'むかしの記録', '既存の記録が残る');
  eq(store.get().trip.store.guests, 10, '留守中の合計も残る');
  eq(store.get().somethingFuture, 'のこす', '知らないキーが残る');

  /* 遠征していないセーブ */
  const none = fakeStore(blank());
  eq(Office.callOn(none, 0), null, '遠征していなければ声をかけられない');

  /* **`shop` は `parlor` の下ではない**（Jansou.normalize が知らないキーを捨てる） */
  const p = Jansou.normalize({ day: 3, shop: { type: 'lux' } });
  ok(p.shop === undefined, 'normalize は parlor の下の shop を捨てる（だから置かない）');
  ok(store.get().trip.shop, 'shop は trip の下にある');
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
