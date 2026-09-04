#!/usr/bin/env node
/*
  遠征先の店の純関数テスト（A4.5-1／A4.5-2）

    node tools/test-scout.js

  ここに書くのは **DOMに触らない関数だけ**（test-jansou.js / test-office.js と同じ方針）。
  絵そのものはブラウザ検証（docs/design/scout/spec.md §9）。

  A4.5-3（交渉）が入ったら、spec.md §9 の残りをここに足すこと。
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
global.SERIFU = require('../src/serifu.js').SERIFU;
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

/* ============================================================
   癖（spec.md §4.4）— A4.5-2
   ============================================================ */
{
  const Q = ScoutShop;
  eq(Q.QUIRKS.length, 6, '癖は6種');
  eq(new Set(Q.QUIRKS.map((q) => q.key)).size, 6, 'key が重複していない');
  eq(Q.BEATS.length + Q.MARKS.length, 6, '系統は beat と mark で尽きる');
  ok(Q.BEATS.length === 3 && Q.MARKS.length === 3, '系統は3つずつ');
  ok(Q.QUIRKS.every((q) => q.name && q.tell), '名前と一言がそろっている');

  /* --- 写像は関数で、全単射でない（§4.4） --- */
  const styles = Object.keys(STYLES);
  eq(styles.length, 20, '打ち筋は20種');
  ok(styles.every((k) => Q.quirkOf(k)), '打ち筋20種すべてが癖に写る');
  ok(styles.every((k) => Q.QUIRK_BY_KEY[Q.quirkOf(k)]), '写った先は6種のいずれか');
  ok(styles.every((k) => Q.quirkOf(k) === Q.quirkOf(k)), '写像は関数（一つの打ち筋に癖は一つ）');
  eq(new Set(styles.map((k) => Q.quirkOf(k))).size, 6, '6種すべてに誰かが写る');
  /* **ここが設計の要**。一対一だと観察が対応表を引く作業になる */
  ok(styles.length > 6, '20 → 6 なので全単射ではない');
  const per = {};
  styles.forEach((k) => { const q = Q.quirkOf(k); per[q] = (per[q] || 0) + 1; });
  ok(Object.keys(per).every((q) => per[q] >= 2), '癖ごとに打ち筋が2つ以上束なっている',
     JSON.stringify(per));
  eq(Q.quirkOf('しらない打ち筋'), null, '知らない打ち筋は null');

  /* --- 一席ぶんの配り（雀ドルは二拍・ただの客は一拍） --- */
  const kindOf = (k) => Q.QUIRK_BY_KEY[k].kind;
  styles.forEach((k) => {
    const q = Q.quirksFor(k, ScoutShop.seeded(k.length * 31 + 7));
    ok(q.length === 2, '雀ドルは二拍そろう（' + k + '）', JSON.stringify(q));
    eq(q[0], Q.quirkOf(k), '先頭は打ち筋から来た癖（' + k + '）');
    ok(kindOf(q[0]) !== kindOf(q[1]), '二つは別の系統（' + k + '）', JSON.stringify(q));
  });

  /* ただの客。**割合はここでは固定しない**（§8 で実機を見てから決める）。
     見るのは「0本か1本しか付かない」ことと「両方の系統が出る」ことだけ */
  {
    let none = 0, one = 0, other = 0;
    const seen = new Set();
    for (let i = 0; i < 4000; i++) {
      const q = Q.quirksFor(null, ScoutShop.seeded(i * 13 + 1));
      if (q.length === 0) none++;
      else if (q.length === 1) { one++; seen.add(q[0]); }
      else other++;
    }
    eq(other, 0, 'ただの客に二拍は付かない');
    ok(none > 0 && one > 0, '付かない客と付く客が両方いる');
    eq(seen.size, 6, 'ただの客の癖も6種すべて出る（雀ドル専用の癖を作らない）');
  }

  /* --- 店の中で（§4.3「癖がある＝雀ドル」にしない） --- */
  {
    const st = blank();
    st.discovered = [];
    const trip = { pref: 'fukuoka', purpose: 'find', days: 3, dayLeft: 3 };
    const shop = ScoutShop.buildShop(st, trip, ScoutShop.seeded(4242));
    ok(shop.seats.length > 0, '席がある');
    ok(shop.seats.every((s) => Array.isArray(s.quirk)), '全席が癖の配列を持つ（無しは空配列）');
    shop.seats.forEach((s) => {
      if (s.charaId != null) ok(s.quirk.length === 2, '雀ドルの席は二拍', JSON.stringify(s.quirk));
      else ok(s.quirk.length <= 1, 'ただの客の席は一拍か無し', JSON.stringify(s.quirk));
    });
    /* 雀ドルの癖の先頭は、その子の打ち筋から来ていること */
    const all = JANDOLS.concat(FREE_AGENTS);
    shop.seats.filter((s) => s.charaId != null).forEach((s) => {
      const c = all.find((x) => x.id === s.charaId);
      eq(s.quirk[0], ScoutShop.quirkOf(c.style), '先頭は打ち筋から（' + c.name + '）');
    });

    /* **同じ朝を描き直しても癖の配置が変わらない**（朝に一度だけ引く） */
    const again = ScoutShop.buildShop(st, trip, ScoutShop.seeded(4242));
    eq(JSON.stringify(again.seats), JSON.stringify(shop.seats), '同じ種なら席も癖も同じ');
    const other = ScoutShop.buildShop(st, trip, ScoutShop.seeded(4243));
    ok(JSON.stringify(other.seats) !== JSON.stringify(shop.seats), '種が違えば変わる');

    /* 床へ渡る形 */
    const state = ScoutShop.stateOf(shop, st);
    ok(state.guests.every((g) => Array.isArray(g.quirk)), '床には癖の配列が渡る');
    eq(state.guests.length, shop.seats.length, '席の数だけ渡る');
    /* 渡したあとに触っても店が変わらない（写しを渡している） */
    state.guests[0].quirk.push('fast');
    eq(shop.seats[0].quirk.length, state.guests[0].quirk.length - 1, '床へ渡すのは写し');
  }

  /* --- 男女（§4.4）。母集団を絞るための一手 --- */
  {
    const G = JansouGuests;
    /* 絵が男女で分かれる。**`sex` を渡さなければいままでどおり** */
    const plain = G.grid('kaisha', 0).join('|');
    eq(G.grid('kaisha', 0).join('|'), plain, 'sex 無しは何度呼んでも同じ');
    ok(G.grid('kaisha', 0, 'male').join('|') !== G.grid('kaisha', 0, 'female').join('|'),
       '男と女で絵が違う');
    ok(G.FEMALE_HAIR.every((h) => G.HAIR[h]), '女の髪型が全部ある');
    ok(G.MALE_HAIR.every((h) => G.HAIR[h]), '男の髪型が全部ある');
    eq(G.FEMALE_HAIR.filter((h) => G.MALE_HAIR.indexOf(h) >= 0).length, 0,
       '男女で髪型が重ならない');
    /* 髪型は typeKey から決まる＝描き直しても変わらない */
    eq(G.hairFor('kaisha', 'female'), G.hairFor('kaisha', 'female'), '同じ客なら同じ髪型');

    /* ---------- 服の色と裾（A7-1。`spec.md` §10.1） ----------
       **髪型だけでは実機で読めなかった。**色（紺／えんじ）と
       裾の形（ズボン／スカート）の二つを重ねる */
    const male0 = G.grid('kaisha', 0, 'male');
    const female0 = G.grid('kaisha', 0, 'female');
    const bare0 = G.grid('kaisha', 0);
    /* **`sex` 無しは裾が素のまま**（自分の店の絵。髪は元から型ごとに乗る） */
    eq(bare0.slice(-3).join('|'), G.BODY.slice(-3).join('|'), 'sex 無しは裾が素の体のまま');
    ok(male0.join('|') !== female0.join('|'), '男女で絵が違う');
    /* 裾。**女は広がり、男は割れる** */
    const hemW = (g) => g[g.length - 1].replace(/\./g, '').length;
    ok(hemW(female0) > hemW(male0), '女の裾のほうが広い',
       'female ' + hemW(female0) + ' / male ' + hemW(male0));
    eq(hemW(female0), 12, '女の裾は12幅');
    ok(/o\.+o/.test(male0[male0.length - 1]), '男の裾は割れている（足が二本）',
       male0[male0.length - 1]);
    /* 歩く絵でも裾が入る */
    ok(G.grid('kaisha', 1, 'female')[15].replace(/\./g, '').length === 12, '歩く絵にも裾が効く');
    /* 服の色。**癖の三色とぶつからない**（あちらは明るいネオンで箱の外） */
    const F2 = require('../src/jansou-floor.js').JansouFloor;
    const quirkCols = [F2.PAL.neonCyan, F2.PAL.neonYellow, F2.PAL.neonPink, F2.PAL.gold, F2.PAL.goldHi];
    ['male', 'female'].forEach((sx) => {
      const c = G.clothFor(sx);
      ok(c && c.cloth && c.clothDark, sx + ' の服の色がある');
      ok(quirkCols.indexOf(c.cloth) < 0, sx + ' の服は癖の色と別');
      /* 暗い色であること（明るいと床で沈む型が出る。癖の印で学んだこと） */
      const lum = parseInt(c.cloth.slice(1, 3), 16) * 0.3 + parseInt(c.cloth.slice(3, 5), 16) * 0.6
        + parseInt(c.cloth.slice(5, 7), 16) * 0.1;
      ok(lum < 110, sx + ' の服は暗い（床より沈まない）', String(Math.round(lum)));
    });
    ok(G.clothFor('male').cloth !== G.clothFor('female').cloth, '男女で服の色が違う');
    eq(G.clothFor(null), null, 'sex が無ければ服の色も無い');
    /* 四型の床のどれとも十分に離れている */
    ['old', 'back', 'girls', 'lux'].forEach((k) => {
      const pal = ScoutShop.palOf(k);
      ['male', 'female'].forEach((sx) => {
        const a = G.clothFor(sx).cloth, b = pal.plankA || pal.carpetA;
        const d = [1, 3, 5].reduce((acc, i) =>
          acc + Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)), 0);
        ok(d > 120, k + ' の床と ' + sx + ' の服が離れている', String(d));
      });
    });
    /* 床の描画が `sex` を色にも渡していること（渡さなければ型の色のまま） */
    const fsrc = require('fs').readFileSync(require('path').join(__dirname, '../src/jansou-floor.js'), 'utf8');
    ok(/function guestColor\(t, sex\)/.test(fsrc), 'guestColor が sex を受け取る');
    ok(/guestColor\(t, sex\)/.test(fsrc), '床のスプライトが sex を色に渡す');
    ok(/gridRects\(G\.grid\(t\.key, 0\), guestColor\(t\)\)/.test(fsrc),
       '客カード（自分の店）は sex を渡さない＝いままでどおり');

    /* タイプ自身の sex が決まっていればそれに従う */
    const always = () => 0;          // 必ず female 側に倒れる乱数
    const never = () => 0.99;
    eq(ScoutShop.sexFor('shachou', always), 'male', "sex:'male' のタイプは常に男");
    eq(ScoutShop.sexFor('shachou', never), 'male', '乱数によらず男');
    eq(ScoutShop.sexFor('motojandol', never), 'female', "sex:'female' のタイプは常に女");
    eq(ScoutShop.sexFor('kaisha', always), 'female', "sex:'both' は割合で振る（女）");
    eq(ScoutShop.sexFor('kaisha', never), 'male', "sex:'both' は割合で振る（男）");
    ok(ScoutShop.FEMALE_RATE > 0 && ScoutShop.FEMALE_RATE < 1, '割合は0と1のあいだ');

    /* 店の中で。**雀ドルは必ず女**、女は総当たりできない数 */
    let shops = 0, fem = 0, thin = 0;
    for (let d = 0; d < 60; d++) {
      const st = { discovered: [], contracted: [], comp: {}, agency: 2,
                   officePref: 'tokyo', money: 5000000 };
      const trip = { pref: 'fukuoka', purpose: 'find', days: 5, dayLeft: 5 };
      const shop = ScoutShop.buildShop(st, trip, ScoutShop.seeded(d * 7919 + 613));
      shops++;
      const f = shop.seats.filter((x) => x.sex === 'female');
      fem += f.length;
      if (f.length <= 1) thin++;
      shop.seats.forEach((x) => {
        ok(x.sex === 'male' || x.sex === 'female', '全席に男女がある');
        if (x.charaId != null) eq(x.sex, 'female', '**雀ドルは必ず女の見た目**');
      });
    }
    ok(fem / shops >= 3, '女は平均3人以上いる（' + (fem / shops).toFixed(1) + '）');
    ok(fem / shops > ScoutShop.CALLS_PER_DAY,
       '**女の数が一日の上限を超える**＝総当たりできない（だから癖を見る意味がある）');
    ok(thin / shops < 0.15, '女が0〜1人しかいない店は稀（' + Math.round(thin * 100 / shops) + '%）');

    /* 床へ渡る形 */
    const st2 = { discovered: [], contracted: [], comp: {}, agency: 2,
                  officePref: 'tokyo', money: 5000000 };
    const shop2 = ScoutShop.buildShop(st2, { pref: 'fukuoka', purpose: 'find', days: 3, dayLeft: 3 },
      ScoutShop.seeded(11));
    ok(ScoutShop.stateOf(shop2, st2).guests.every((g) => g.sex), '床には男女が渡る');
  }

  /* --- **自分の店の床には出さない**（§4） ---
     `jansou.js` は `guests` に `quirk` を入れない。入れた瞬間に
     自分の店の客にまで印が付くので、機械的に見て固定しておく
     （`test-office.js` が依頼の `when` を見ているのと同じ形） */
  {
    const src = require('fs').readFileSync(__dirname + '/../src/jansou.js', 'utf8');
    ok(!/quirk/.test(src), 'jansou.js は quirk を扱わない（自分の店の床には出ない）');
    /* **男女の出し分けも自分の店には持ち込まない。**
       `jansou.js` の `sex` は**名前を作るためのもの**（`names[f.id]`）で、
       床に渡す `guests` には入れない。入れた瞬間に自分の店の髪型が変わる。
       名前の側の用途と混ざらないよう、行ごと見て固定する */
    const sexLines = src.split('\n').filter((l) => /\bsex\b/.test(l));
    eq(sexLines.length, 1, 'jansou.js が sex に触るのは一行だけ');
    ok(/names\[/.test(sexLines[0]), 'その一行は名前を作るところ（床へは渡さない）',
       sexLines[0].trim());
    ok(!/guests[\s\S]{0,200}?\bsex:/.test(src), '床へ渡す guests に sex を入れていない');
  }

  /* --- ただの客にも癖が付いていること（複数の店で見る） ---
     ここが崩れると観察が完全情報になり、3回の上限が意味を失う（§4.3） */
  {
    let plainWithQuirk = 0, plainSeats = 0;
    for (let d = 0; d < 60; d++) {
      const st = blank();
      const trip = { pref: 'tokyo', purpose: 'find', days: 3, dayLeft: 3 };
      const shop = ScoutShop.buildShop(st, trip, ScoutShop.seeded(d * 7919 + 11));
      shop.seats.forEach((s) => {
        if (s.charaId != null) return;
        plainSeats++;
        if (s.quirk.length) plainWithQuirk++;
      });
    }
    ok(plainSeats > 100, 'ただの客の席がじゅうぶんある', String(plainSeats));
    ok(plainWithQuirk > 0, '**ただの客にも癖が付く**（癖がある＝雀ドルではない）');
    ok(plainWithQuirk < plainSeats, '全員に付くわけでもない');
  }
}

/* ============================================================
   交渉（spec.md §5）— A4.5-3
   ============================================================ */
{
  const all = JANDOLS.concat(FREE_AGENTS);

  /* --- セリフ。3場面 × 19種 × 2本が埋まっているか（§5.4） --- */
  {
    const SC = ['scoutMeet', 'scoutWin', 'scoutLose'];
    const keys = Object.keys(SERIFU.LINES);
    eq(keys.length, 19, 'chara は19種');
    let holes = [];
    keys.forEach((k) => SC.forEach((sc) => {
      const v = SERIFU.LINES[k][sc];
      if (!Array.isArray(v) || v.length < 2 || v.some((x) => typeof x !== 'string' || !x.trim())) {
        holes.push(k + '/' + sc);
      }
    }));
    eq(holes.length, 0, '3場面が19種すべて埋まっている（空文字なし）', holes.slice(0, 4).join(' '));
    SC.forEach((sc) => ok(Array.isArray(SERIFU.PLAYER_LINES[sc]) && SERIFU.PLAYER_LINES[sc].length,
      'FALLBACK にも ' + sc + ' がある（知らない chara で null にならない）'));
    /* **条件の文面をセリフに書かない**（§5.4）。`RULES` の detail が正 */
    const flat = JSON.stringify(SERIFU.LINES);
    ok(!/事務所ランク\d/.test(flat), 'セリフに「事務所ランク○」を書いていない');
    ok(!/必要です/.test(flat), 'セリフに条件文（「〜が必要です」）を書いていない');
  }

  /* --- 好感度の値引き（§5.3） --- */
  {
    const c = all.find((x) => x.contract === 'free') || all[0];
    const zero = { favor: {} };
    const full = { favor: { [c.id]: 100 } };
    const a0 = Scout.costOf(c, zero), a1 = Scout.costOf(c, full);
    eq(a1 * 2, a0, 'favor 0 と 100 で契約金が2倍違う（満額で半額）',
       a0 + ' / ' + a1);
    eq(Scout.costOf(c), a0, 'st を渡さなければ素の額');
    /* 途中の値も線形（favor/200） */
    eq(Scout.costOf(c, { favor: { [c.id]: 50 } }), Math.round(a0 * 0.75), 'favor 50 で 3/4');
    /* **緩むのは金だけ。**格の条件は動かない */
    const poor = { agency: 1, money: 0, favor: { [c.id]: 100 }, records: {}, beaten: [] };
    const v = Scout.evaluate(all.find((x) => x.rank === 'S'), poor, []);
    ok(!v.ok, '好感度が満額でも、事務所が小さければ通らない');
    ok(/事務所ランク/.test(v.detail), 'そのときの detail は格の話');
  }

  /* --- 交渉の一行は「性格の一言」＋「既存の detail」（§5.4） --- */
  {
    const c = all[0];
    const v = { ok: false, detail: 'ここが RULES の detail です。', cost: 1234 };
    const n = Office.negotiate(c, v, 'いいでしょう。話くらいは');
    eq(n.detail, v.detail, '交渉の文面は RULES の detail をそのまま持つ');
    eq(n.line, 'いいでしょう。話くらいは', '性格の一言はそのまま');
    eq(n.ok, false, 'ok はそのまま');
    eq(Office.negotiate(c, { ok: true, detail: '', cost: 0 }, 'x').detail, '',
       '満たしていれば条件文は出さない');
    /* **条件文を office.js に書き写していないこと。**
       書き写すと片方を直したときに必ずずれる（`RULES.event` で一度通った話） */
    /* **コメントは外して見る。**「条件文をここに書くな」という注意書き自体が
       条件文を例に挙げているので、素の本文で見ると必ず引っかかる */
    const code = require('fs').readFileSync(__dirname + '/../src/office.js', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    ok(!/事務所ランク/.test(code), 'office.js が「事務所ランク○」を書いていない');
    ok(!/で優勝すると/.test(code), 'office.js が大会の条件文を書いていない');
    ok(!/話が早くなります/.test(code), 'office.js が同郷の条件文を書いていない');
    ok(!/必要です/.test(code), 'office.js が「〜が必要です」を書いていない');
  }

  /* --- 好感度は勝っても負けても積む（§5.1 の 5） --- */
  {
    eq(Office.favorGain(true), Office.FAVOR_GAIN.win, '勝ったときの積み');
    eq(Office.favorGain(false), Office.FAVOR_GAIN.lose, '負けたときの積み');
    ok(Office.favorGain(false) > 0, '**負けても favor が積まれる**（空手で帰らせない）');
    ok(Office.favorGain(true) > Office.favorGain(false), '勝ったほうが積む');
    const st = { favor: { 7: 3 } };
    eq(Office.addFavor(st, 7, false)[7], 3 + Office.favorGain(false), '負けでも足される');
    eq(Office.addFavor({ favor: {} }, 7, true)[7], Office.favorGain(true), '無いところからでも積む');
    eq(Office.addFavor({ favor: { 7: 98 } }, 7, true)[7], 100, '上限は100');
    eq(st.favor[7], 3, '元の表は書き換えない（純関数）');
  }

  /* --- 課題は相手ごとに一枠（§5.2） --- */
  {
    const c = all[5];
    const q = Offers.questFor(c.id);
    ok(q, '相手ごとの課題がある');
    eq(q.kind, 'quest', "kind は 'quest'");
    eq(q.slot, 'quest:' + c.id, 'slot は相手ごと');
    eq(q.days, 0, '日は使わない');
    eq(q.when(), false, '**when は常に偽**（fire では届かない。積むのは push）');

    let st = { offers: [], favor: {}, agency: 1, money: 0, discovered: [], contracted: [] };
    st.offers = Offers.push(st, q.id);
    eq(st.offers.length, 1, '一度目で一件');
    st.offers = Offers.push(st, q.id);
    eq(st.offers.length, 1, '**二度失敗しても二件にならない**（slot で上書き）');
    eq(st.offers[0].id, q.id, '入っているのはその相手の課題');
    /* 別の相手なら増える */
    const c2 = all[6];
    st.offers = Offers.push(st, Offers.questFor(c2.id).id);
    eq(st.offers.length, 2, '別の相手の課題は別枠');

    /* 契約できたら落ちる */
    const after = Office.dropQuest(st, c.id);
    eq(after.length, 1, '契約した相手の課題は落ちる');
    eq(after[0].id, Offers.questFor(c2.id).id, '落ちるのはその相手のぶんだけ');

    /* `fire` は課題を引かない */
    const fired = Offers.fire({ offerFired: [], offers: [], officePref: 'tokyo',
      contracted: [], discovered: [], favor: {}, records: {}, agency: 1 }, [], () => 0.5);
    eq(fired.filter((o) => o.kind === 'quest').length, 0, 'fire は課題を引かない');

    /* 見出しと文面。**条件は evaluate から引く**（二か所に書かない） */
    eq(Offers.titleOf({ id: q.id }), c.name + 'の課題', '見出しは「○○の課題」');
    const poor = { agency: 1, money: 0, favor: {}, records: {}, beaten: [], contracted: [] };
    const v = Scout.evaluate(c, poor, []);
    const text = Offers.textOf({ id: q.id }, poor, []);
    ok(text.indexOf(c.name) >= 0, '文面に相手の名前が入る');
    if (!v.ok) ok(text.indexOf(v.detail) >= 0, '文面に RULES の detail がそのまま入る', text);
    /* 課題の定義に文面を持たせていない（持たせると二重になる） */
    eq(q.text, '', '課題の定義は文面を持たない');
    ok(!q.payload.detail, '課題の payload に detail を焼き込んでいない');
  }

  /* --- 課題を果たしたあとなら evaluate が通る（§5.1 の 3） ---
     条件は `RULES` のままで、変えたのは前後に見せるものだけ */
  {
    /* `rank` 条件の子で、事務所ランクを上げれば通ることを見る */
    const c = all.find((x) => x.contract === 'rank' && x.rank !== 'S');
    ok(c, "contract === 'rank' の子がいる");
    if (c) {
      const need = RANK_INFO[c.rank].minAgency;
      const before = { agency: 1, money: 99999999, favor: {}, records: {}, beaten: [],
                       contracted: [], discovered: [] };
      const v0 = Scout.evaluate(c, before, []);
      ok(!v0.ok, '課題の前は通らない');
      const after = Object.assign({}, before, { agency: need });
      const v1 = Scout.evaluate(c, after, []);
      ok(v1.ok, '**課題を果たしたあとは通る**', v1.detail);
      /* そのとき課題は用済み */
      const st = { offers: Offers.push({ offers: [] }, Offers.questFor(c.id).id) };
      eq(Office.dropQuest(st, c.id).length, 0, '契約できたら課題は落ちる');
    }
  }

  /* --- 同郷の一言（§5.1・§5.4） --- */
  {
    const c = all[0];
    const mate = { name: '同郷 のこ', region: c.region };
    const line = ScoutShop.aishoLine(mate, c, () => 0.1);
    ok(line.indexOf(mate.name) >= 0 || line.indexOf(c.name) >= 0, '同郷の一言に名前が入る');
    ok(ScoutShop.AISHO_LINES.length >= 2, '文面は複数ある');
    ok(ScoutShop.AISHO_LINES.length < 19, '**19本も持たない**（性格ではなく関係の話）');
    eq(ScoutShop.aishoLine(null, c), '', '同郷がいなければ空');
    /* 差し込みが残らない */
    ScoutShop.AISHO_LINES.forEach((t, i) => {
      const out = ScoutShop.aishoLine(mate, c, () => i / ScoutShop.AISHO_LINES.length);
      ok(!/\{(mate|name|region)\}/.test(out), '差し込みが残らない（' + i + '）', out);
    });
  }
}

/* ============================================================
   男に声をかける（A7-2。`spec.md` §10.2・§10.3）
   ============================================================ */
{
  const st = { discovered: [], contracted: [], comp: {}, agency: 2 };
  const trip = { pref: 'tokyo', purpose: 'find', days: 4, dayLeft: 4 };

  /* 誘われる見込み。**癖が付いた男は誘ってくる**——§4.3 の伏線の回収 */
  eq(ScoutShop.inviteChance(false, 0), 0.15, '無印の男は 0.15');
  eq(ScoutShop.inviteChance(true, 0), 0.5, '癖が付いていれば 0.50');
  ok(ScoutShop.inviteChance(true, 100) > ScoutShop.inviteChance(true, 0),
     '認められた度合いで上がる（A7-3）');
  ok(ScoutShop.inviteChance(true, 100) <= ScoutShop.INVITE_MAX, '上限を超えない');
  eq(ScoutShop.INVITE_LOCAL, 0.20, 'local の上乗せは 0.20');

  /* 分布。**癖の有無で倍以上ちがう**（押す前に見えているので判断になる） */
  const count = (hasQuirk) => {
    const rng = ScoutShop.seeded(7);
    const o = { none: 0, talk: 0, invite: 0 };
    for (let i = 0; i < 4000; i++) o[ScoutShop.replyFor(hasQuirk, 0, rng)] += 1;
    return o;
  };
  const plain = count(false), marked = count(true);
  ok(Math.abs(plain.invite / 4000 - 0.15) < 0.03, '無印の誘いは 15% 前後',
     String(plain.invite / 4000));
  ok(Math.abs(marked.invite / 4000 - 0.50) < 0.03, '癖ありの誘いは 50% 前後',
     String(marked.invite / 4000));
  ok(marked.invite > plain.invite * 2, '癖があると倍以上誘われる');
  ok(plain.talk > 0 && plain.none > 0, '三つとも起きる');

  /* 建てるときに決めてある（押した瞬間には引かない。癖と同じ作法） */
  const shop = ScoutShop.buildShop(st, trip, ScoutShop.seeded(11));
  const males = shop.seats.filter((x) => x.sex === 'male' && x.charaId == null);
  const females = shop.seats.filter((x) => x.sex === 'female');
  ok(males.length > 0, '男の客がいる');
  ok(males.every((x) => ['none', 'talk', 'invite'].indexOf(x.reply) >= 0),
     '男には返事が決めてある');
  ok(males.every((x) => x.hintSide === 'beat' || x.hintSide === 'mark'),
     'どちらの系統を言うかも決めてある');
  ok(females.every((x) => x.reply == null), '女には返事を持たせない（既存の二値のまま）');
  /* 同じ種なら同じ返事（再現する） */
  const again = ScoutShop.buildShop(st, trip, ScoutShop.seeded(11));
  eq(again.seats.map((x) => x.reply || '-').join(''),
     shop.seats.map((x) => x.reply || '-').join(''), '同じ種なら返事も同じ');

  /* ヒント。**癖の系統は片方だけ**——両方言うと二拍が特定できてしまう。
     `local` は「顔は知られた」帯（25〜59）で見る */
  const noJd = { seats: [{ charaId: null }] };
  ok(/見ない顔はいない/.test(ScoutShop.hintOf(noJd, { hintSide: 'beat' }, 30)),
     '雀ドルがいない日はそう言う');
  const withJd = { seats: [{ charaId: 1, quirk: ['slow', 'meld'] }] };
  const hb = ScoutShop.hintOf(withJd, { hintSide: 'beat' }, 30);
  const hm = ScoutShop.hintOf(withJd, { hintSide: 'mark' }, 30);
  ok(/長考/.test(hb), '頭の印の側を聞けば、頭の印を言う', hb);
  ok(/鳴く/.test(hm), '体の物の側を聞けば、体の物を言う', hm);
  ok(!/鳴く/.test(hb) && !/長考/.test(hm), '**両方は言わない**');
  ok(hb !== hm, '系統で中身が変わる');

  /* ---------- 認められた度合い（A7-3。§10.4） ---------- */
  /* 帯は三つだけ。**上がった瞬間が一度きりの出来事になるように** */
  eq(ScoutShop.LOCAL_BANDS.length, 3, '帯は三つ');
  eq(ScoutShop.localBand(0).key, 'yoso', '0 はよそ者');
  eq(ScoutShop.localBand(24).key, 'yoso', '24 まではよそ者');
  eq(ScoutShop.localBand(25).key, 'kao', '25 から顔は知られた');
  eq(ScoutShop.localBand(59).key, 'kao', '59 までは顔は知られた');
  eq(ScoutShop.localBand(60).key, 'joren', '60 から常連');
  eq(ScoutShop.localBand(100).key, 'joren', '100 も常連');
  /* 呼ばれかたが変わる。**一度言われれば覚える** */
  const h0 = ScoutShop.hintOf(withJd, { hintSide: 'beat' }, 0);
  const h1 = ScoutShop.hintOf(withJd, { hintSide: 'beat' }, 30);
  const h2 = ScoutShop.hintOf(withJd, { hintSide: 'beat' }, 80);
  ok(/兄ちゃん/.test(h0) && /兄ちゃん/.test(h1), 'よそ者と顔見知りは「兄ちゃん」');
  ok(/社長さん/.test(h2), '常連は「社長さん」', h2);
  /* **返す情報の量は増やさない。**よそ者には有無だけ、上の二段は系統を片方 */
  ok(!/長考/.test(h0), 'よそ者には癖を言わない', h0);
  ok(/長考/.test(h1) && /長考/.test(h2), '顔が知られたら癖の系統を片方だけ');
  ok(!/鳴く/.test(h2), '常連になっても両方は言わない');
  ok(h2.length > h1.length, '常連には一言多い（情報ではなく関係）');
  /* 雀ドルの出やすさ。**規模の小さい県ほど伸びしろが大きい** */
  eq(ScoutShop.anyChance(1, 0), ScoutShop.ANY_CHANCE[0], 'local 0 は素のまま');
  ok(ScoutShop.anyChance(1, 100) > ScoutShop.anyChance(1, 0), 'local で出やすくなる');
  eq(Math.round(ScoutShop.anyChance(1, 100) * 100) / 100, 0.55, '規模1は 0.35 → 0.55');
  ok(ScoutShop.anyChance(5, 100) <= ScoutShop.ANY_MAX, '上限を超えない');
  ok(ScoutShop.anyChance(1, 100) < ScoutShop.anyChance(5, 0),
     '**通っても大きい県には届かない**（規模の意味を消さない）');
  ok(ScoutShop.twoChance(3, 100) > ScoutShop.twoChance(3, 0), '二人目も出やすくなる');
  /* buildShop が `st.local` を読む */
  const stL = { discovered: [], contracted: [], comp: {}, agency: 2, local: { tokyo: 100 } };
  const cnt = (state, seed) => {
    let n = 0;
    for (let i = 0; i < 300; i++) {
      const sh = ScoutShop.buildShop(state, trip, ScoutShop.seeded(seed + i));
      n += sh.seats.filter((x) => x.charaId != null).length;
    }
    return n;
  };
  ok(cnt(stL, 500) > cnt(st, 500), 'local が高いほど雀ドルが出る',
     cnt(stL, 500) + ' vs ' + cnt(st, 500));

  /* Office 側：足し算は純関数、**減らない** */
  const O = require('../src/office.js').Office;
  eq(O.LOCAL_GAIN.win, 8, '勝ちは +8');
  eq(O.LOCAL_GAIN.lose, 3, '負けても +3（空手で帰らせない）');
  eq(O.LOCAL_GAIN.talk, 1, '話が返れば +1');
  eq(O.localOf({}, 'tokyo'), 0, '無ければ 0');
  eq(O.addLocal({}, 'tokyo', 'win').tokyo, 8, '勝つと上がる');
  eq(O.addLocal({ local: { tokyo: 96 } }, 'tokyo', 'win').tokyo, 100, '上限は100');
  eq(O.addLocal({ local: { tokyo: 40 } }, 'akita', 'win').tokyo, 40, '他の県は動かない');
  eq(Object.keys(O.addLocal({ local: { tokyo: 40 } }, null, 'win')).length, 1,
     '県が無ければ何も足さない');
  /* **契約金や条件は緩めない**（それは favor の役目。local は土地、favor は人） */
  const osrc0 = require('fs').readFileSync(require('path').join(__dirname, '../src/office.js'), 'utf8');
  ok(!/local[\s\S]{0,80}cost/.test(osrc0), 'local は契約金に触らない');
  const scsrc = require('fs').readFileSync(require('path').join(__dirname, '../src/scout.js'), 'utf8');
  /* `'local'` は大会の格（地方リーグ）の鍵なので、**セーブの `local` を
     読んでいないこと**を見る */
  ok(!/st\.local|localOf\(/.test(scsrc), 'scout.js（RULES と costOf）は認められた度合いを読まない');
  /* セーブの三箇所 */
  const sh2 = require('fs').readFileSync(require('path').join(__dirname, '../shell.html'), 'utf8');
  eq((sh2.match(/local: \{\}/g) || []).length + (sh2.match(/keep\.local = \{\}/g) || []).length, 2,
     'blankState と onStart に既定がある');
  ok(/local: s\.local && typeof s\.local === 'object'/.test(sh2), 'loadState が拾い直す');

  /* 癖 → 打ち筋。観察が対局にも効く（誘ってきた客の打ち筋になる） */
  ScoutShop.QUIRKS.forEach((q) => {
    const k = ScoutShop.styleForQuirk(q.key);
    ok(k && ScoutShop.STYLE_QUIRK[k] === q.key, q.key + ' から打ち筋が引ける');
  });
  ok(ScoutShop.QUIRKS.every((q) => q.hint), '癖ごとに「話す」の言いかたがある');

  /* office.js 側の配線（本文を機械的に見る） */
  const osrc = require('fs').readFileSync(require('path').join(__dirname, '../src/office.js'), 'utf8');
  ok(/length: 'ikkyoku'/.test(osrc), '常連との対局は一局（§10.3）');
  ok(/trip\.matched|t2\.matched|matched/.test(osrc), '打った子を trip.matched に控える');
  ok(/tripMatch: m\.indexOf/.test(osrc), '疲労は既存の tripMatch に乗せる');
  ok(!/dayLeft:\s*trip\.dayLeft\s*-\s*1[\s\S]{0,200}?inviteMatch/.test(osrc),
     '対局で日数を食わない');
  const shsrc = require('fs').readFileSync(require('path').join(__dirname, '../shell.html'), 'utf8');
  ok(/length: ctx\.length/.test(shsrc), 'shell が対局の長さを渡す');
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
