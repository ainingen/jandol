#!/usr/bin/env node
/*
  直営店の経済を測る — 三局面の 客／一日の利益

    node tools/measure-jansou.js
    node tools/measure-jansou.js --days 2000 --seed 1
    node tools/measure-jansou.js --wage shift     旧（出勤基準）と見比べる

  `docs/HANDOVER.md` §4「直営店の経済」の表を作り直すための道具。
  いままで手元の使い捨てスクリプトで測っていたのを、
  **同じ手順を誰でも踏めるように**リポジトリに置いた。

  ------------------------------------------------------------
  測っているもの
  ------------------------------------------------------------
  `Jansou.computeDay()` を `--days` 日ぶん回して、客と場代の平均を出す。
  一日の利益は `settle` と同じ式で組む：

      利益 ＝ 場代 ＋ 臨時収入 − 日当 − 家賃

  **臨時収入は入れていない。**イベントもチップもボトルも乱数で、
  局面の比較には効かない。HANDOVER §4 の数字も場代だけで取ってある。

  ------------------------------------------------------------
  日当の基準（2026年9月3日に変えた）
  ------------------------------------------------------------
  **日当は契約基準。**出勤の有無に関係なく、所属の全員に毎日払う。
  以前は `dayWorkers`（シフトが一つでも入っている子）の合計だった。

  `office/spec.md` §7.2 が「日当は既に毎日払われているので、遠征中の
  人件費は何も足さずに自動でかかる」と書いており、それには契約基準で
  ないと辻褄が合わない。店が無い日（§1.2）もすでに全員ぶん払っている。

  **三局面はどれも全員が出勤しているので、この変更で数字は動かない。**
  それを確かめるために `--wage shift` で旧基準も出せるようにしてある。
*/
'use strict';

/* characters.js / tournament.js はブラウザ用のスクリプトなので、
   グローバルに置いてから jansou.js を読む（test-office.js と同じ形） */
const chars = require('../src/characters.js');
global.JANDOLS = chars.JANDOLS;
global.FREE_AGENTS = chars.FREE_AGENTS;
global.STYLES = chars.STYLES;
global.PLAYER = chars.PLAYER;
const { Jansou } = require('../src/jansou.js');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DAYS = Math.max(1, parseInt(arg('days', '2000'), 10) || 2000);
const WAGE_BASIS = arg('wage', 'contract');       // contract | shift
const SEED = parseInt(arg('seed', '1'), 10) || 1;

/* **乱数は種を固定する。**前後で同じ数字が出ることを「だいたい同じ」ではなく
   **完全一致**で確かめられるようにするため。`jansou.js` の `seeded` と同じ式 */
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* ------------------------------------------------------------
   三局面（HANDOVER §4 の表と同じ設定）
   workers は [昼, 夕, 夜] の出勤者。roster は所属の人数（日当の母数）
------------------------------------------------------------ */
const PHASES = [
  {
    name: '序盤', note: '卓2・初期3人が夜だけ・評判10',
    tables: 2, interior: 1, auto: 1, sign: 1, rep: 10,
    /* 初期メンバーは FREE_AGENTS の先頭3人（チーム編成で選ぶ10人の中） */
    roster: () => chars.FREE_AGENTS.slice(0, 3),
    shifts: [[], [], [0, 1, 2]],                  // 夜だけ、3人とも
  },
  {
    name: '中盤', note: '卓4・内装2・全自動・6人・評判40',
    tables: 4, interior: 2, auto: 2, sign: 1, rep: 40,
    roster: () => chars.JANDOLS.slice(0, 6),
    shifts: [[0, 1], [2, 3], [0, 1, 2, 3, 4, 5]], // 全員がどこかに入っている
  },
  {
    name: '終盤', note: '卓8・全部最大・12人・評判85',
    tables: 8, interior: 5, auto: 3, sign: 3, rep: 85,
    roster: () => chars.JANDOLS.slice(0, 12),
    shifts: [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
  },
];

/* ------------------------------------------------------------
   計測
------------------------------------------------------------ */
/* ------------------------------------------------------------
   第五段の旗（`office/spec.md` §11 の再測の三段目）

     --favor    夜の単価に好感度が乗る
     --short    出勤が足りなければ開けられる席が減る
     --away     さらに、代表が遠征中として `baseSeats` を 0 にする
     --all      三つ同時

   **一本ずつ立てて、寄与を分けて見るための旗。**
   旗を立てなければ、いままでどおりの基準が出る
------------------------------------------------------------ */
const has = (name) => process.argv.indexOf('--' + name) >= 0;
const FLAGS = {
  favor: has('favor') || has('all'),
  short: has('short') || has('away') || has('all'),
  away: has('away'),
};
/* 測るときの好感度。**全員が同じ値**にして、動く変数を旗だけに絞る */
const FAVOR_EACH = 40;

function measure(ph, days, basis) {
  const roster = ph.roster();
  const slotWorkers = ph.shifts.map((idx) => idx.map((i) => roster[i]));

  /* 日当の母数。**契約基準なら所属の全員、出勤基準ならシフトが入っている子** */
  const onShift = roster.filter((c, i) => ph.shifts.some((idx) => idx.indexOf(i) >= 0));
  const paid = basis === 'shift' ? onShift : roster;
  const wages = paid.reduce((a, c) => a + Jansou.wageOf(c), 0);
  const util = Jansou.utilOf(ph.tables);

  const cfg = {
    tables: ph.tables, interior: ph.interior, auto: ph.auto, sign: ph.sign, rep: ph.rep,
    slotPop: slotWorkers.map((w) => w.reduce((a, c) => a + (c.pop || 0), 0)),
    slotWorkers: slotWorkers.map((w) => w.length),
    pullBonus: 0, closedTables: 0, playerNight: false,
    /* 第五段の三つ。**旗が立っていなければ `computeDay` は見ない** */
    favorFee: FLAGS.favor,
    slotFavor: slotWorkers.map((w) => w.length * FAVOR_EACH),
    staffing: FLAGS.short,
    baseSeats: FLAGS.away ? 0 : undefined,
  };

  const rng = seeded(SEED);
  let guests = 0, sales = 0;
  for (let d = 0; d < days; d++) {
    const day = Jansou.computeDay(cfg, rng);
    guests += day.guests;
    sales += day.sales;
  }
  return {
    guests: guests / days,
    sales: sales / days,
    wages, util, paid: paid.length, onShift: onShift.length, roster: roster.length,
    profit: sales / days - wages - util,
  };
}

const man = (n) => (n / 10000).toFixed(1) + '万円';
const yen = (n) => Math.round(n).toLocaleString('ja-JP') + '円';

console.log('直営店の経済 — ' + DAYS + '日の平均'
  + '（日当は' + (WAGE_BASIS === 'shift' ? '出勤' : '契約') + '基準）\n');
const onFlags = Object.keys(FLAGS).filter((k) => FLAGS[k]);
console.log(onFlags.length
  ? '**第五段の旗: ' + onFlags.map((k) => '--' + k).join(' ') + '**（好感度は全員 ' + FAVOR_EACH + '）'
  : '第五段の旗は立っていない（いままでどおりの基準）');
console.log('| 局面 | 客 | 場代 | 日当 | 家賃 | 一日の利益 |');
console.log('| --- | --- | --- | --- | --- | --- |');
const rows = PHASES.map((ph) => {
  const r = measure(ph, DAYS, WAGE_BASIS);
  console.log('| ' + ph.name + '（' + ph.note + '） | ' + Math.round(r.guests) + '人 | '
    + yen(r.sales) + ' | ' + yen(r.wages) + '（' + r.paid + '人） | ' + yen(r.util)
    + ' | **' + (r.profit >= 0 ? '+' : '') + man(r.profit) + '** |');
  return { ph, r };
});

/* 誰で測ったかを残す。**ここを書き残さないと、あとから同じ数字を出せない。**
   HANDOVER §4 の表は「6人」「12人」としか書いておらず、
   中盤の再現ができなかった（誰の pop を足したのかが分からない） */
console.log('\n測った顔ぶれ（pop の合計が客足に効く）:');
PHASES.forEach((ph) => {
  const roster = ph.roster();
  console.log('  ' + ph.name + ' … ' + roster.map((c) => c.name + '(' + c.pop + ')').join('・')
    + '  合計pop ' + roster.reduce((a, c) => a + (c.pop || 0), 0));
});

/* 出勤基準との差。**三局面はどれも全員が出勤しているので、差は0のはず** */
console.log('\n日当の基準による差（契約 − 出勤）:');
rows.forEach(({ ph }) => {
  const a = measure(ph, 1, 'contract'), b = measure(ph, 1, 'shift');
  console.log('  ' + ph.name + ': 所属 ' + a.roster + '人 / 出勤 ' + b.onShift + '人 / '
    + '日当の差 ' + yen(a.wages - b.wages)
    + (a.wages === b.wages ? '  … 一致（全員が出勤しているので動かない）' : '  ← 動く'));
});
