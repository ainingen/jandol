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
   配置（spec.md §6.3）— 第二段
   **配置は変更するまで継続する。**既定は「店」。
   ============================================================ */
{
  const a = JANDOLS[0], b = JANDOLS[1], c = JANDOLS[2];
  const base = { contracted: [a.id, b.id, c.id], team: [], comp: {} };

  /* 既定 */
  eq(Office.assignFor({}, a.id), 'parlor', '配置の既定は店');
  eq(Office.assignFor(base, a.id), 'parlor', 'assign が無ければ全員が店');
  const all = Office.assignOf(base);
  eq(Object.keys(all).length, 3, '所属ぜんぶの配置が埋まった表を返す');
  ok(Object.values(all).every((v) => v === 'parlor'), '既定はみんな店');

  /* 書ける値 */
  eq(Office.assignFor({ assign: { [a.id]: 'rest' } }, a.id), 'rest', '休みは休み');
  eq(Office.assignFor({ assign: { [a.id]: 'parlor' } }, a.id), 'parlor', '店は店');

  /* **知らない値は店に落とす**（前方互換。あとから配置の種類が増えても、
     古いコードが読んだときに誰かが永久に出勤しなくなったりしない） */
  eq(Office.assignFor({ assign: { [a.id]: 'nowhere' } }, a.id), 'parlor', '知らない値は店に落ちる');
  eq(Office.assignFor({ assign: { [a.id]: 42 } }, a.id), 'parlor', '文字列でなければ店');
  eq(Office.assignFor({ assign: { [a.id]: null } }, a.id), 'parlor', 'null でも店');

  /* §13：遠征中に `trip` を消したセーブで、`assign` の `trip` が `parlor` に戻る */
  eq(Office.assignFor({ assign: { [a.id]: 'trip' }, trip: { pref: 'osaka' } }, a.id), 'trip',
    'trip があるあいだは遠征中');
  eq(Office.assignFor({ assign: { [a.id]: 'trip' } }, a.id), 'parlor',
    'trip が無いのに assign が trip なら店に戻す（§7.5）');
  eq(Office.assignFor({ assign: { [a.id]: 'trip' }, trip: null }, a.id), 'parlor',
    'trip が null でも店に戻す');

  /* 依頼も同じ。受けていない依頼の途中で止まっていたら戻す（第四段の下ごしらえ） */
  eq(Office.assignFor({ assign: { [a.id]: 'job:x' }, offerAccepted: ['x'] }, a.id), 'job:x',
    '受けた依頼のあいだは依頼中');
  eq(Office.assignFor({ assign: { [a.id]: 'job:x' } }, a.id), 'parlor',
    '受けていない依頼なら店に戻す');

  /* 出勤可能者。**遠征中・依頼中・休みは外れる**（§6.3） */
  const st = Object.assign({}, base, { assign: { [b.id]: 'rest' } });
  const duty = Office.parlorRoster(st);
  eq(duty.length, 2, '休みの子は出勤可能者から外れる');
  ok(!duty.some((x) => x.id === b.id), '外れたのは休みにした子');
  eq(Office.parlorRoster(base).length, 3, '既定なら全員が出勤可能');
  const st2 = Object.assign({}, base, { assign: { [a.id]: 'trip' }, trip: { pref: 'osaka' } });
  eq(Office.parlorRoster(st2).length, 2, '遠征中の子も外れる');

  /* 書き込み。知らないキーを残す（§10） */
  let w = { contracted: [a.id], assign: { [b.id]: 'rest' }, somethingFuture: 'のこす' };
  const store = { get: () => w, set: (patch) => { w = Object.assign({}, w, patch); } };
  Office.setAssign(store, a.id, 'rest');
  eq(w.assign[a.id], 'rest', '書いた配置が入る');
  eq(w.assign[b.id], 'rest', '他の子の配置は消えない');
  eq(w.somethingFuture, 'のこす', '知らないキーが残る');
}

/* ---------- 疲労と調子は器だけ（spec.md §9。第五段で数値を置く） ---------- */
{
  eq(Office.fatigueOf({}, 1), 0, '疲労の既定は0');
  eq(Office.condOf({}, 1), 0, '調子の既定は0');
  eq(Office.fatigueOf({ fatigue: { 1: 40 } }, 1), 40, '疲労は保存の値');
  eq(Office.condOf({ cond: { 1: -2 } }, 1), -2, '調子は保存の値');
  /* 範囲の外は丸める。**あとから数値を入れるときに、範囲だけは先に決めておく** */
  eq(Office.fatigueOf({ fatigue: { 1: 999 } }, 1), 100, '疲労は100で頭打ち');
  eq(Office.fatigueOf({ fatigue: { 1: -5 } }, 1), 0, '疲労は0が下限');
  eq(Office.condOf({ cond: { 1: 9 } }, 1), 2, '調子は+2で頭打ち');
  eq(Office.condOf({ cond: { 1: -9 } }, 1), -2, '調子は−2が下限');
  eq(Office.fatigueOf({ fatigue: { 1: 'x' } }, 1), 0, '数値でなければ0');
  eq(Office.condOf({ cond: { 1: null } }, 1), 0, '数値でなければ0');
}

/* ============================================================
   店が無い日も日は進む（spec.md §1.2）
   「店が無いセーブで『今日を始める』→ parlor.day が 1 進み、
     日当ぶん money が減る」
   ============================================================ */
{
  global.STYLES = global.STYLES || {};
  global.PLAYER = global.PLAYER || {};
  const { Jansou } = require('../src/jansou.js');

  /* 卓が無い日は客も場代もゼロ。**ここが `Math.max(1, ...)` に落ちると
     卓0でも4席ぶんの客が湧く**（早期返しでそれを止めてある） */
  const zero = Jansou.computeDay({ tables: 0, interior: 1, auto: 1, sign: 1, rep: 10 }, () => 0.5);
  eq(zero.guests, 0, '卓0なら客は0');
  eq(zero.sales, 0, '卓0なら場代は0');
  eq(zero.slots.length, 3, '帯の形は営業日と同じ（3本）');
  ok(zero.slots.every((sl) => sl.guests === 0 && sl.sales === 0 && !sl.full),
    '帯もすべて0で、満卓は立たない');

  /* 既存の呼び出しは通らないこと（normalize が tables を最低2に丸める） */
  eq(Jansou.normalize({ tables: 0 }).tables, 2, 'normalize は tables を最低2にする');
  ok(Jansou.computeDay({ tables: 2, interior: 1, auto: 1, sign: 1, rep: 10 }, () => 0.5).guests > 0,
    '卓が有れば客は出る（早期返しが営業日を巻き込んでいない）');

  /* 店が無いセーブで一日を回す */
  const a = JANDOLS[0], b = JANDOLS[1];
  const list = [a, b];
  const plan0Wages = (l) => Jansou.closedDayPlan({ parlor: {} }, l).wages;
  const wages = list.reduce((x, c) => x + Jansou.wageOf(c), 0);
  ok(wages > 0, '日当は0円ではない');

  let st = {
    money: 1000000, contracted: [a.id, b.id], team: [],
    comp: {}, compMax: {}, grades: {}, favor: {},
    parlor: { day: 0 },                      // **open が無い＝まだ店を持っていない**
    somethingFuture: 'あとから足したキー',
  };
  const store = { get: () => st, set: (patch) => { st = Object.assign({}, st, patch); } };

  eq(Jansou.normalize(st.parlor).open, false, '店はまだ無い');

  const out = Jansou.runClosedDay(store, list);
  eq(st.parlor.day, 1, '「今日を始める」で parlor.day が 1 進む');
  eq(st.money, 1000000 - wages, '日当ぶん money が減る');
  eq(out.profit, -wages, '収支は日当ぶんの赤字だけ');
  eq(st.parlor.log[st.parlor.log.length - 1].guests, 0, '日誌の客は0');
  eq(st.parlor.log[st.parlor.log.length - 1].sales, 0, '日誌の場代は0');
  eq(st.somethingFuture, 'あとから足したキー', '知らないキーが残る');

  /* **日当は契約基準**（spec.md §6.3・§7.2）。出勤の有無に関係なく
     所属の全員に払う。営業日も店が無い日も同じ式 */
  eq(plan0Wages(list), wages, '日当は所属の全員ぶん');

  /* **家賃は掛からない。**店が無いのだから */
  ok(Jansou.utilOf(2) > 0, '営業日には家賃が掛かる（前提の確認）');
  eq(out.profit + wages, 0, '家賃はゼロ（収支は日当だけ）');

  /* 成長も出勤も付かない。**誰も出勤していない日なので** */
  eq(out.growth.length, 0, '成長は付かない');
  eq(Object.keys(st.parlor.month.work).length, 0, '月報の出勤も付かない');
  eq(JSON.stringify(st.compMax), '{}', 'compMax を書き換えない（伸びしろの天井の罠）');
  eq(JSON.stringify(st.grades), '{}', 'grades を書き換えない');

  /* 評判は動かない（黒字ボーナスも満卓ボーナスも付かない） */
  eq(st.parlor.rep, Jansou.normalize({}).rep, '評判は動かない');

  /* 何日でも続く。月の集計も（売上0で）積まれる */
  for (let i = 0; i < 4; i++) Jansou.runClosedDay(store, list);
  eq(st.parlor.day, 5, '5日ぶん進む');
  eq(st.money, 1000000 - wages * 5, '5日ぶんの日当が引かれている');
  eq(st.parlor.month.days, 5, '月の日数も5日ぶん積まれる');
  eq(st.parlor.month.wages, wages * 5, '月の人件費も積まれる');
  eq(st.parlor.month.slots.reduce((x, sl) => x + sl.sales, 0), 0, '月の場代は0のまま');

  /* 所属が0人なら日当も0。日は進む */
  let st2 = { money: 100, contracted: [], team: [], comp: {}, parlor: { day: 7 } };
  const store2 = { get: () => st2, set: (patch) => { st2 = Object.assign({}, st2, patch); } };
  Jansou.runClosedDay(store2, []);
  eq(st2.parlor.day, 8, '所属0人でも日は進む');
  eq(st2.money, 100, '所属0人なら日当も0');

  /* 締めは settle 一箇所。plan と results から組むだけの純関数であること */
  const plan = Jansou.closedDayPlan(st, list);
  const r1 = Jansou.settle(plan, Jansou.closedDayResults(), st);
  const r2 = Jansou.settle(plan, Jansou.closedDayResults(), st);
  eq(JSON.stringify(r1.patch), JSON.stringify(r2.patch),
    '同じ plan と results なら同じ書き込み（settle は純関数）');
  eq(plan.util, 0, '店が無い日の家賃は0');
  eq(plan.dayWorkers.length, 0, '店が無い日は誰も出勤していない');
  eq(plan.wages, wages, '日当は出勤ではなく所属の全員ぶん');
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

  /* **UIを事務所へ移しても、書くのは同じ関数・同じ場所**（§6.3）。
     `Jansou.setShift` は `parlor.shifts` を裏返して書き戻すだけで、
     `normalize()` にも `assign` にも触れない */
  let ws = { parlor: { day: 3, shifts: {} }, somethingFuture: 'のこす' };
  const wstore = { get: () => ws, set: (patch) => { ws = Object.assign({}, ws, patch); } };
  eq(JSON.stringify(Jansou.setShift(wstore, 7, 0)), '[true,false,true]',
    '既定（夜だけ）から昼を足す');
  eq(JSON.stringify(ws.parlor.shifts[7]), '[true,false,true]', '保存に入る');
  eq(JSON.stringify(Jansou.setShift(wstore, 7, 2)), '[true,false,false]', '夜を外す');
  eq(ws.parlor.day, 3, 'シフトを触っても day は動かない');
  eq(ws.somethingFuture, 'のこす', '知らないキーが残る');
  eq(ws.assign, undefined, 'シフトは assign に触れない（データは移していない）');

  /* `jansou.js` は `Office.parlorRoster` を**あれば**通す。
     `jansou.html` は office.js も読むが、**無くても
     「全員が店に立つ」＝いままでどおり**に落ちること */
  const ra = JANDOLS[0], rb = JANDOLS[1];
  const rst = { contracted: [ra.id, rb.id], comp: {}, assign: { [rb.id]: 'rest' } };
  const had = global.Office;
  global.Office = undefined;
  eq(Jansou.parlorRoster(rst, [ra, rb]).length, 2,
    'Office が無ければ素通し（単体ページでもいままでどおり動く）');
  global.Office = Office;
  eq(Jansou.parlorRoster(rst, [ra, rb]).length, 1, 'Office があれば休みの子を外す');
  global.Office = had;

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
