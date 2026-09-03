#!/usr/bin/env node
/*
  遠征と日進行の釣り合いを測る — 一度目の再測（A3）

    node tools/measure-office.js
    node tools/measure-office.js --days 2000

  `docs/design/office/spec.md` §11 の A3 の四項目を出す。
  **数字を動かす前に、いまどうなっているかを見るための道具。**

    1. 遠征一回の費用が、日数ぶんの店の利益と釣り合っているか
    2. 遠征中の店がどれだけ落ちるか（出勤者が減り、joinNight が効かない）
    3. 大会が日を消費するようになると何日相当になるか
    4. 開店前の日当（店が無い期間に、開店資金50万まで何日かかるか）
    5. 一回の遠征の実り（A4.5 の再測。scout/spec.md §7）
       声をかけた数・見つかった数・そのうち条件が揃っている数を、
       県の規模 1／3／5 × 滞在 2／4／7日で。種を固定して各100回

  店の側の三局面は `tools/measure-jansou.js` と同じ組み方。
  **どちらも `computeDay` を回しているだけで、経済には触れていない。**
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
const { Jansou } = require('../src/jansou.js');
global.Jansou = Jansou;
global.JansouGuests = require('../src/jansou-guests.js').JansouGuests;
const { ScoutShop } = require('../src/scoutshop.js');
global.ScoutShop = ScoutShop;
const { Office } = require('../src/office.js');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DAYS = Math.max(1, parseInt(arg('days', '2000'), 10) || 2000);
const SEED = parseInt(arg('seed', '1'), 10) || 1;

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const man = (n) => (n / 10000).toFixed(1) + '万円';
const yen = (n) => Math.round(n).toLocaleString('ja-JP') + '円';

/* HANDOVER §4 の三局面。measure-jansou.js と同じ組み方 */
const PHASES = [
  { name: '序盤', tables: 2, interior: 1, auto: 1, sign: 1, rep: 10,
    roster: chars.FREE_AGENTS.slice(0, 3), shifts: [[], [], [0, 1, 2]] },
  { name: '中盤', tables: 4, interior: 2, auto: 2, sign: 1, rep: 40,
    roster: chars.JANDOLS.slice(0, 6), shifts: [[0, 1], [2, 3], [0, 1, 2, 3, 4, 5]] },
  { name: '終盤', tables: 8, interior: 5, auto: 3, sign: 3, rep: 85,
    roster: chars.JANDOLS.slice(0, 12),
    shifts: [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]] },
];

/* away … 遠征中（同行者を出勤から外し、joinNight を切る）
   joinNight … 夜に代表の卓を出す（HANDOVER §4 が別に測っている条件） */
function run(ph, opts) {
  opts = opts || {};
  const away = opts.away | 0;
  /* 同行者は先頭から連れて行く。**遠征中はシフトから外れる**（§6.3） */
  const gone = new Set(ph.roster.slice(0, away).map((c) => c.id));
  const slotWorkers = ph.shifts.map((idx) =>
    idx.map((i) => ph.roster[i]).filter((c) => !gone.has(c.id)));

  const cfg = {
    tables: ph.tables, interior: ph.interior, auto: ph.auto, sign: ph.sign, rep: ph.rep,
    slotPop: slotWorkers.map((w) => w.reduce((a, c) => a + (c.pop || 0), 0)),
    slotWorkers: slotWorkers.map((w) => w.length),
    pullBonus: 0, closedTables: 0,
    playerNight: !!opts.joinNight,
  };
  const rng = seeded(SEED);
  let guests = 0, sales = 0;
  for (let d = 0; d < DAYS; d++) {
    const day = Jansou.computeDay(cfg, rng);
    guests += day.guests; sales += day.sales;
  }
  /* 日当は契約基準。**遠征に出ていても払う**ので、母数は所属の全員 */
  const wages = ph.roster.reduce((a, c) => a + Jansou.wageOf(c), 0);
  const util = Jansou.utilOf(ph.tables);
  return { guests: guests / DAYS, sales: sales / DAYS, profit: sales / DAYS - wages - util };
}

console.log('遠征と日進行の釣り合い — ' + DAYS + '日の平均（種 ' + SEED + '）');
console.log('**数字はまだ動かしていない。いまどうなっているかを見るだけ。**\n');

/* ============================================================
   基準：店の一日の利益
   ============================================================ */
const base = PHASES.map((ph) => ({ ph, r: run(ph) }));
console.log('## 0. 基準（店の一日の利益）\n');
console.log('| 局面 | 客 | 一日の利益 |');
console.log('| --- | --- | --- |');
base.forEach(({ ph, r }) => {
  console.log('| ' + ph.name + '（所属' + ph.roster.length + '人・卓' + ph.tables + '） | '
    + Math.round(r.guests) + '人 | ' + (r.profit >= 0 ? '+' : '') + man(r.profit) + ' |');
});

/* ============================================================
   1. 遠征一回の費用は、日数ぶんの店の利益と釣り合うか
   ============================================================ */
console.log('\n## 1. 遠征の費用と、その日数ぶんの店の利益\n');
console.log('費用 = SCOUT_COST(' + yen(Scout.SCOUT_COST) + ') × (1+far) × (1+同行者数)、日数 = 2+far');
console.log('「日数ぶんの利益」は、その日数だけ店を回したときの利益。');
console.log('**遠征は店を止めないので、これは機会費用ではなく釣り合いの目安。**\n');
console.log('| 行き先（京都から） | far | 日数 | 費用（代表のみ） | 序盤の日数ぶん | 中盤 | 終盤 |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
const DESTS = [['osaka', '大阪'], ['aichi', '名古屋'], ['tokyo', '東京'],
               ['fukuoka', '福岡'], ['hokkaido', '札幌'], ['okinawa', '那覇']];
DESTS.forEach(([key, label]) => {
  const p = Office.planTrip({ officePref: 'kyoto' }, key, 'find', []);
  const cols = base.map(({ r }) => man(r.profit * p.days));
  console.log('| ' + label + ' | ' + p.far + ' | ' + p.days + '日 | ' + yen(p.cost)
    + ' | ' + cols.join(' | ') + ' |');
});
console.log('\n同行者を連れると費用だけが増える（日数は変わらない）:');
[0, 1, 2, 3].forEach((n) => {
  const p = Office.planTrip({ officePref: 'kyoto' }, 'fukuoka', 'find', new Array(n).fill(0));
  console.log('  福岡へ 同行' + n + '人 … ' + yen(p.cost) + '（' + p.days + '日）');
});

/* ============================================================
   2. 遠征中の店の落ち込み
   ============================================================ */
console.log('\n## 2. 遠征中の店の落ち込み\n');
console.log('同行者はシフトから外れ、`joinNight` が効かなくなる（§7.4）。');
console.log('日当は契約基準なので、遠征に出ていても払い続ける。\n');
console.log('| 局面 | 平常 | 同行1人 | 同行3人 | 夜に代表の卓を出していた場合 |');
console.log('| --- | --- | --- | --- | --- |');
base.forEach(({ ph, r }) => {
  const a1 = run(ph, { away: 1 });
  const a3 = run(ph, { away: 3 });
  const jn = run(ph, { joinNight: true });
  const d = (x) => (x.profit >= 0 ? '+' : '') + man(x.profit)
    + '（' + Math.round(x.guests) + '人'
    + (x.profit === r.profit ? '' : '・' + (x.profit - r.profit >= 0 ? '+' : '−')
       + man(Math.abs(x.profit - r.profit))) + '）';
  console.log('| ' + ph.name + ' | ' + (r.profit >= 0 ? '+' : '') + man(r.profit)
    + '（' + Math.round(r.guests) + '人） | ' + d(a1) + ' | ' + d(a3) + ' | ' + d(jn) + ' |');
});
console.log('\n※「夜に代表の卓」は遠征していない日の話。遠征中はこれが使えないので、');
console.log('  代表を出していたプレイヤーは、その差ぶんも落ちる。');

/* ============================================================
   3. 大会が日を消費するようになると何日相当か
   ============================================================ */
console.log('\n## 3. 大会の日数換算（第四段で日を消費するようになる）\n');
const TAIKAI_AVG = 100000;      // 新人戦の平均賞金。HANDOVER §4 の実測値
console.log('新人戦の平均賞金 ' + yen(TAIKAI_AVG) + '（HANDOVER §4 の実測。ここでは測り直していない）');
console.log('HANDOVER §4 は「120大会まわして所属8人・B級到達」と書いている。\n');
console.log('| 大会1回が | 120大会 | そのあいだの店の利益（序盤） | （中盤） | （終盤） |');
console.log('| --- | --- | --- | --- | --- |');
[1, 2, 3].forEach((d) => {
  const days = 120 * d;
  console.log('| ' + d + '日 | ' + days + '日 | '
    + base.map(({ r }) => man(r.profit * days)).join(' | ') + ' |');
});
console.log('\n大会1回の賞金 ' + yen(TAIKAI_AVG) + ' は、店の一日の利益の');
base.forEach(({ ph, r }) => {
  console.log('  ' + ph.name + ' … ' + (TAIKAI_AVG / r.profit).toFixed(1) + '日ぶん');
});

/* ============================================================
   4. 開店前の日当
   ============================================================ */
console.log('\n## 4. 開店前の日当（店が無い期間・§1.2）\n');
const START = chars.FREE_AGENTS.slice(0, 3);
const dayWage = START.reduce((a, c) => a + Jansou.wageOf(c), 0);
console.log('初期メンバー3人の日当 … ' + yen(dayWage) + '／日');
console.log('  ' + START.map((c) => c.name + '(' + yen(Jansou.wageOf(c)) + ')').join('・'));
console.log('開店資金 … ' + yen(Jansou.OPEN_COST));
console.log('\n大会だけで貯める場合（大会はまだ日を消費しない）:');
console.log('  大会1回で ' + yen(TAIKAI_AVG - 0) + ' 入り、そのあいだ日は進まない');
console.log('  → 開店資金だけなら ' + Math.ceil(Jansou.OPEN_COST / TAIKAI_AVG) + ' 大会');
console.log('\n大会が日を消費するようになったら（第四段）:');
[1, 2, 3].forEach((d) => {
  /* 一大会 d 日。1日あたり 賞金/d − 日当 だけ貯まる */
  const perDay = TAIKAI_AVG / d - dayWage;
  const n = perDay > 0 ? Math.ceil(Jansou.OPEN_COST / perDay) : Infinity;
  console.log('  大会1回が ' + d + '日なら … 一日あたり ' + (perDay >= 0 ? '+' : '')
    + yen(perDay) + ' 貯まり、開店まで ' + (n === Infinity ? '永久に届かない' : n + '日'));
});
console.log('\n※ 所持金に下限は無い（マイナスは「給料の遅配」として許す）。');
console.log('  離脱の警告に繋げるのは ROADMAP [C]。');


/* ============================================================
   5. 一回の遠征の実り（A4.5 の再測。`scout/spec.md` §7）

   **押しかたを二通り測る。**癖（A4.5-2）が効いているかは、
   この差にしか出ない。差が小さければ癖は飾りだし、
   差が開きすぎれば `CALLS_PER_DAY` の3が緩すぎる。

     無作為  … どこを押すか分からない人（癖を見ていない）
     癖を読む … 二拍の席から先に押す人（見えているものを使う）

   **数字は動かさない。**いまどうなっているかを見るだけ。
   ============================================================ */
console.log('\n## 5. 一回の遠征の実り（A4.5 の再測）\n');

const TRIPS = 100;                       // 各マスで回す遠征の数
const SCALES = [1, 3, 5];
const STAYS = [2, 4, 7];

/* 測るときのプレイヤー像。**全マスで同じ**にして、
   動く変数を「県の規模」と「滞在日数」だけに絞る */
function scoutState() {
  const roster = chars.JANDOLS.slice(0, 6);
  return {
    st: {
      agency: 3, money: 10000000,
      discovered: roster.map((c) => c.id),
      contracted: roster.map((c) => c.id),
      favor: {}, records: {}, beaten: [], comp: {},
      officePref: 'tokyo',
    },
    roster,
  };
}

/* その規模の県を一つ（PREFS の並び順で最初のもの。県ごとの差は測らない） */
function prefOfScale(scale) {
  return Geo.PREFS.find((p) => p.scale === scale) || Geo.PREFS[0];
}

/* 押す席を選ぶ。`smart` なら二拍 → 一拍 → 癖なしの順に、同点は乱数で */
function pickSeats(shop, calls, smart, rng) {
  const idx = shop.seats.map((s, i) => i);
  const key = smart
    ? (i) => -(shop.seats[i].quirk || []).length
    : () => 0;
  /* 乱数で崩してから安定ソート＝同点は無作為 */
  idx.sort(() => rng() - 0.5);
  idx.sort((a, b) => key(a) - key(b));
  return idx.slice(0, calls);
}

/* 遠征一回。**`Office.ensureShop` と同じ種の作りかた**を写す
   （あちらは store を触るので、ここでは buildShop を直に回す） */
function runTrip(scale, days, smart, seed0) {
  const { st, roster } = scoutState();
  const pref = prefOfScale(scale);
  const prefIdx = Geo.PREFS.findIndex((p) => p.key === pref.key);
  const trip = { pref: pref.key, purpose: 'find', days, dayLeft: days };
  const pick = seeded(seed0);
  let calls = 0, found = [];
  for (let d = 0; d < days; d++) {
    const day = seed0 + d;                       // 日ごとに引き直す（§6.2）
    const rng = ScoutShop.seeded(day * 7919 + (prefIdx + 1) * 613 + days);
    const shop = ScoutShop.buildShop(st, trip, rng);
    const seats = pickSeats(shop, ScoutShop.CALLS_PER_DAY, smart, pick);
    seats.forEach((i) => {
      const s = shop.seats[i];
      if (!s) return;
      calls++;
      if (s.charaId != null && st.discovered.indexOf(s.charaId) < 0) {
        st.discovered.push(s.charaId);
        found.push(s.charaId);
      }
    });
  }
  /* 見つけた子のうち、**いま条件が揃っている**のは何人か
     ＝もう一度「口説く」で行けば契約できる人数。
     `RULES.event` の6人は `Offers` が読めないと開かないので、ここでは通らない */
  const all = chars.JANDOLS.concat(chars.FREE_AGENTS);
  const ready = found.filter((id) => {
    const c = all.find((x) => x.id === id);
    if (!c) return false;
    let v = null;
    try { v = Scout.evaluate(c, st, roster); } catch (e) { v = null; }
    return !!(v && v.ok);
  });
  return { calls, found: found.length, ready: ready.length };
}

function avg(rows, key) { return rows.reduce((a, r) => a + r[key], 0) / rows.length; }

[false, true].forEach((smart) => {
  console.log('### ' + (smart ? '癖を読む（二拍の席から押す）' : '無作為（癖を見ていない）') + '\n');
  console.log('| 規模 | 滞在 | 声をかけた | 見つかった | うち条件が揃っている | 費用 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  SCALES.forEach((scale) => {
    STAYS.forEach((days) => {
      const rows = [];
      for (let i = 0; i < TRIPS; i++) rows.push(runTrip(scale, days, smart, SEED * 1009 + i * 31));
      /* 費用は `planTrip` と同じ形。滞在日数は `2 + far` なので、
         ここでは滞在から far を戻して掛ける（同行者なし） */
      const far = Math.max(0, days - 2);
      const cost = Scout.SCOUT_COST * (1 + far);
      console.log('| ' + scale + ' | ' + days + '日 | '
        + avg(rows, 'calls').toFixed(1) + ' | '
        + avg(rows, 'found').toFixed(2) + ' | '
        + avg(rows, 'ready').toFixed(2) + ' | ' + yen(cost) + ' |');
    });
  });
  console.log('');
});

console.log('※ 「うち条件が揃っている」は、その場で契約できる人数ではない。');
console.log('  探す遠征と口説く遠征は別なので、**もう一度行けば契約できる**人数。');
console.log('  契約条件が `event` の6人は、`Offers` を読まないこの道具では通らない。');
console.log('※ 声をかけた数が ' + (ScoutShop.CALLS_PER_DAY) + '×日数 に届かないのは、');
console.log('  席がその数だけ無い日があるため（規模の小さい県ほど起きる）。');
