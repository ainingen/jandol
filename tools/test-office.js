#!/usr/bin/env node
/*
  事務所ハブの純関数テスト

    node tools/test-office.js

  ここに書くのは **DOMに触らない関数だけ**（tools/test-jansou.js と同じ方針）。
  朝・夜の画面そのものはブラウザ検証（docs/design/office/spec.md §13）で見る。

  第一段の範囲（spec.md §14 の 1）：
    - Geo（47県のデータ、距離、遠さの段階）
    - Office.defaultName / nameOf / prefOf / rosterOf（セーブの読み）
    - セーブの前方互換（新しいキーが一つも無くても壊れない・書き戻しで残る）

  第三段で `Office.planTrip` / `Office.deputyOf`、第四段で `Offers.fire` が
  入ったら、spec.md §13 の残りをここに足すこと。
*/
'use strict';

const { Geo } = require('../src/geo.js');
const { REGIONS, JANDOLS, FREE_AGENTS } = require('../src/characters.js');

/* office.js は Geo / REGIONS / JANDOLS / FREE_AGENTS をグローバルから読む
   （ブラウザでは <script> が並ぶだけなので、これがそのままの姿） */
global.Geo = Geo;
global.REGIONS = REGIONS;
global.JANDOLS = JANDOLS;
global.FREE_AGENTS = FREE_AGENTS;
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

/* ============================================================
   Geo — 県と地方（spec.md §4）
   ============================================================ */
{
  eq(Geo.PREFS.length, 47, '47県ある');

  const keys = Geo.PREFS.map((p) => p.key);
  eq(new Set(keys).size, 47, 'key が重複していない');
  ok(keys.every((k) => /^[a-z]+$/.test(k)), 'key は英数字だけ（引き継ぎ書 §5 の日本語識別子の罠）');

  const names = Geo.PREFS.map((p) => p.name);
  eq(new Set(names).size, 47, '県名が重複していない');

  /* **これが本体。**指示書は当初「近畿」と書いていたが、
     characters.js は「関西」。ずれると prefsOf が空を返して
     地方ごとの区切りが消える（そして誰も気づかない） */
  const bad = Geo.PREFS.filter((p) => REGIONS.indexOf(p.region) < 0);
  eq(bad.length, 0, '47県すべての region が REGIONS のいずれかに一致する',
    bad.map((p) => p.name + '=' + p.region).join(','));

  /* 逆向き。地方が一つでも空だと、選択画面にその地方の欄だけが出ない */
  const empty = REGIONS.filter((r) => Geo.prefsOf(r).length === 0);
  eq(empty.length, 0, '六地方すべてに県がある', empty.join(','));
  eq(REGIONS.reduce((a, r) => a + Geo.prefsOf(r).length, 0), 47,
    '地方ごとに数えても47になる（どの県も一つの地方にだけ属す）');

  ok(Geo.PREFS.every((p) => p.scale >= 1 && p.scale <= 5), 'scale は1〜5');
  ok(Geo.PREFS.every((p) => p.note && p.note.length > 0), '全県に一行紹介がある');
  /* §5.1：規模の小さい県を「弱い」と書かない */
  ok(!Geo.PREFS.some((p) => /候補が少な|客が少な|弱い/.test(p.note)),
    '紹介文に「候補が少ない」「客が少ない」「弱い」を書いていない');

  eq(Geo.prefOf('kyoto').name, '京都', 'prefOf が引ける');
  eq(Geo.prefOf('nowhere'), null, '知らない key は null');
}

/* ---------- 距離と遠さ（spec.md §4.2） ---------- */
{
  const d = (a, b) => Math.round(Geo.distKm(a, b));

  eq(d('kyoto', 'osaka'), d('osaka', 'kyoto'), 'distKm は対称');
  eq(d('tokyo', 'okinawa'), d('okinawa', 'tokyo'), 'distKm は対称（遠いほうでも）');
  eq(d('kyoto', 'kyoto'), 0, '同じ県は0km');
  eq(Geo.distKm('kyoto', 'nowhere'), 0, '知らない県は0km（落ちない）');

  /* 指示書 §4.2 が明示している目安。京都から見て
     大阪0・名古屋1・東京2・福岡3・札幌4・那覇5 */
  eq(Geo.farBetween('kyoto', 'osaka'), 0, '京都→大阪は far 0');
  eq(Geo.farBetween('kyoto', 'aichi'), 1, '京都→名古屋は far 1');
  eq(Geo.farBetween('kyoto', 'tokyo'), 2, '京都→東京は far 2');
  eq(Geo.farBetween('kyoto', 'fukuoka'), 3, '京都→福岡は far 3');
  eq(Geo.farBetween('kyoto', 'hokkaido'), 4, '京都→札幌は far 4');
  eq(Geo.farBetween('kyoto', 'okinawa'), 5, '京都→那覇は far 5');

  eq(Geo.farOf(0), 0, 'farOf(0) は 0');
  eq(Geo.farOf(80), 0, '境目の80kmは 0（以下で切る）');
  eq(Geo.farOf(80.1), 1, '80kmを越えたら 1');
  eq(Geo.farOf(1200), 4, '境目の1200kmは 4');
  eq(Geo.farOf(99999), 5, '上は5で頭打ち');

  /* far は距離の単調増加でなければならない。段の順序が入れ替わると
     「遠いほうが安い」が起きる */
  let mono = true;
  for (let km = 0; km < 2000; km += 7) {
    if (Geo.farOf(km) > Geo.farOf(km + 7)) mono = false;
  }
  ok(mono, 'far は距離について単調に増える');

  /* 自分自身は必ず far 0。本拠地からの遠征でここが1になると、
     地元へ行くのに費用が乗る */
  ok(Geo.PREFS.every((p) => Geo.farBetween(p.key, p.key) === 0), 'どの県も自分自身は far 0');
}

/* ============================================================
   Office — 事務所名（spec.md §5）
   ============================================================ */
{
  eq(Office.defaultName('沢渡 ちはる'), '沢渡事務所', '名前の先頭語 ＋ 事務所');
  eq(Office.defaultName('沢渡　ちはる'), '沢渡事務所', '全角の空白でも切れる');
  eq(Office.defaultName('ちはる'), 'ちはる事務所', '切れなければ名前全体');
  eq(Office.defaultName('  沢渡  ちはる  '), '沢渡事務所', '前後の空白を落とす');
  eq(Office.defaultName(''), '事務所', '空でも落ちない');
  eq(Office.defaultName(undefined), '事務所', 'undefined でも落ちない');

  eq(Office.nameOf({ playerName: '沢渡 ちはる' }), '沢渡事務所', '保存が無ければ既定で埋める');
  eq(Office.nameOf({ playerName: '沢渡 ちはる', officeName: '雀友荘' }), '雀友荘', '保存があればそれ');
  eq(Office.nameOf({ playerName: '沢渡 ちはる', officeName: '   ' }), '沢渡事務所',
    '空白だけの事務所名は既定に落とす');
  eq(Office.nameOf({ officeName: 'あ'.repeat(30) }).length, Office.NAME_MAX,
    '事務所名は NAME_MAX 文字で切る');

  /* **入力された文字がそのまま入る。**出す側が esc() を通すのが決まりなので、
     ここでは中身をいじらないことを確かめる（勝手に消すと名前が化ける） */
  eq(Office.nameOf({ officeName: '<b>事務所</b>' }), '<b>事務所</b>',
    'nameOf は中身をいじらない（esc は出す側の仕事）');
}

/* ---------- 本拠地（spec.md §5・§10） ---------- */
{
  eq(Office.prefOf({}), null, '本拠地が無ければ null（既定を勝手に決めない）');
  eq(Office.prefOf({ officePref: null }), null, 'null もそのまま null');
  eq(Office.prefOf({ officePref: 'nowhere' }), null, '知らない key は null');
  eq(Office.prefOf({ officePref: 'kyoto' }).name, '京都', 'key から県が引ける');
}

/* ---------- 所属一覧（spec.md §6.2。pop と favor の初出） ---------- */
{
  const a = JANDOLS[0], b = JANDOLS[1];
  const st = {
    team: [a.id], contracted: [b.id, a.id],       // 重複してもよい
    comp: { [a.id]: 77 }, grades: { [b.id]: 'A' }, favor: { [b.id]: 42 },
  };
  const list = Office.rosterOf(st);
  eq(list.length, 2, 'チームと契約済みを合わせて重複を落とす');

  const ra = list.find((c) => c.id === a.id);
  const rb = list.find((c) => c.id === b.id);
  eq(ra.comp, 77, 'セーブの完成度を写す');
  eq(rb.comp, b.comp, 'セーブに無ければ元の完成度');
  eq(rb.rank, 'A', 'セーブの段位を写す');
  eq(ra.rank, a.rank, 'セーブに無ければ元の段位');
  eq(rb.favor, 42, '好感度を写す');
  eq(ra.favor, 0, '好感度が無ければ0');
  ok(typeof ra.pop === 'number', '人気はキャラの値をそのまま持つ');

  eq(Office.rosterOf({}).length, 0, '空のセーブでも落ちない');
  eq(Office.rosterOf({ contracted: [99999] }).length, 0, '知らない id は落とす');

  /* 元のデータを書き換えていないこと（Object.assign の写し忘れ） */
  eq(JANDOLS[0].comp, a.comp, 'rosterOf は JANDOLS を書き換えない');
}

/* ============================================================
   セーブの前方互換（spec.md §10・§13）
   「新しいキーが一つも無いセーブを読んで壊れない。
     書き戻しで知らないキーが残る」
   ここでは shell.html の loadState / store.set と同じ形を再現して見る。
   ============================================================ */
{
  /* 事務所のキーを一つも持たない、いままでのセーブ */
  const old = {
    discovered: [1, 2], contracted: [1], comp: {}, money: 500000,
    playerName: '沢渡 ちはる', parlor: { day: 40, rep: 55 },
    somethingFuture: 'あとから足したキー',
  };

  /* loadState 相当。**Object.assign({}, s, {...}) の形にすること。**
     拾い直した項目だけを返すと、他の画面が保存した内容を消す（引き継ぎ書 §5） */
  function load(s) {
    return Object.assign({}, s, {
      officeName: typeof s.officeName === 'string' ? s.officeName : '',
      officePref: typeof s.officePref === 'string' ? s.officePref : null,
    });
  }

  const st = load(old);
  eq(st.officeName, '', '事務所名が無いセーブは空で埋まる');
  eq(st.officePref, null, '本拠地が無いセーブは null（＝一度だけ聞く）');
  eq(st.somethingFuture, 'あとから足したキー', '知らないキーが残る');
  eq(st.parlor.day, 40, 'parlor はそのまま素通しされる');

  /* 事務所名は既定で埋められる。**本拠地は勝手に決めない**（§5） */
  eq(Office.nameOf(st), '沢渡事務所', '事務所名は既定で埋まる');
  eq(Office.prefOf(st), null, '本拠地は勝手に決めない');

  /* 選んだあとは二度と聞かれない */
  const st2 = load(Object.assign({}, old, { officePref: 'kyoto', officeName: '沢渡事務所' }));
  eq(Office.prefOf(st2).key, 'kyoto', '一度選べば以後はそれ');

  /* store.set 相当の書き戻し */
  const written = Object.assign({}, st, { officePref: 'osaka' });
  eq(written.somethingFuture, 'あとから足したキー', '書き戻しでも知らないキーが残る');
  eq(written.parlor.day, 40, '書き戻しでも parlor が消えない');

  /* 二重に読んでも増えたり消えたりしない（冪等） */
  const twice = load(load(old));
  eq(JSON.stringify(twice), JSON.stringify(st), 'loadState を二度通しても同じ');
}

/* ============================================================
   雀荘のシフト（spec.md §6.3。第二段でUIを事務所へ移す下ごしらえ）
   **保存の形は変えない。**既定を知っているのは Jansou.shiftOf だけ
   ============================================================ */
{
  global.STYLES = global.STYLES || {};
  global.PLAYER = global.PLAYER || {};
  const { Jansou } = require('../src/jansou.js');

  ok(typeof Jansou.shiftOf === 'function', 'Jansou.shiftOf を外から呼べる');
  eq(JSON.stringify(Jansou.shiftOf({ shifts: {} }, 1)), '[false,false,true]',
    'シフトを持っていない子の既定は「夜だけ」');
  eq(JSON.stringify(Jansou.shiftOf({ shifts: { 1: [true, true, false] } }, 1)),
    '[true,true,false]', '保存があればそれを返す');
  eq(JSON.stringify(Jansou.shiftOf({ shifts: { 1: [true, true, false, true, true] } }, 1)),
    '[true,true,false]', '3つに切る');

  /* 返した配列を書き換えても保存は動かない（切り替えは setParlor を通す） */
  const p = { shifts: { 1: [true, false, false] } };
  Jansou.shiftOf(p, 1)[0] = false;
  eq(p.shifts[1][0], true, 'shiftOf が返す配列は控え。書き換えても保存に触れない');

  /* normalize が shifts を落とさない（引き継ぎ書 §5 の normalize の罠） */
  let n = { shifts: { 1: [true, false, true] }, day: 5 };
  for (let i = 0; i < 5; i++) n = Jansou.normalize(n);
  eq(JSON.stringify(n.shifts[1]), '[true,false,true]', 'normalize を5回通してもシフトが残る');
  eq(n.day, 5, 'normalize を5回通しても day が残る');
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
