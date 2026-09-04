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
const chars = require('../src/characters.js');
const { REGIONS, JANDOLS, FREE_AGENTS } = chars;

/* office.js は Geo / REGIONS / JANDOLS / FREE_AGENTS をグローバルから読む
   （ブラウザでは <script> が並ぶだけなので、これがそのままの姿） */
global.Geo = Geo;
global.REGIONS = REGIONS;
global.JANDOLS = JANDOLS;
global.FREE_AGENTS = FREE_AGENTS;
global.STYLES = chars.STYLES;
global.PLAYER = chars.PLAYER;
global.RANK_INFO = chars.RANK_INFO;
global.CONTRACTS = chars.CONTRACTS;
Object.assign(global, require('../src/tournament.js'));
global.Tournament = require('../src/tournament.js');
global.Scout = require('../src/scout.js');
global.Jansou = require('../src/jansou.js').Jansou;
global.Offers = require('../src/offers.js').Offers;
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
  eq(Office.assignFor({ assign: { [a.id]: 'trip' },
    trip: { pref: 'osaka', dayLeft: 2 } }, a.id), 'trip', '遠征が生きているあいだは遠征中');
  eq(Office.assignFor({ assign: { [a.id]: 'trip' } }, a.id), 'parlor',
    'trip が無いのに assign が trip なら店に戻す（§7.5）');
  eq(Office.assignFor({ assign: { [a.id]: 'trip' }, trip: { pref: 'osaka', dayLeft: 0 } }, a.id),
    'parlor', '**残り0日で置き去りになった trip も店に戻す**（永久に外れたままにしない）');
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
  const st2 = Object.assign({}, base,
    { assign: { [a.id]: 'trip' }, trip: { pref: 'osaka', dayLeft: 2 } });
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
   届く依頼（spec.md §8）— 第四段
   ============================================================ */
{
  const Offers = global.Offers;
  /* **課題（A4.5-3）は雀ドル一人につき一件。**`fire` は引かないが表には載る
     （`byId` で引けないと `st.offers` から戻せない。`scout/spec.md` §5.2） */
  const CHARA_N = JANDOLS.concat(FREE_AGENTS).length;
  eq(Offers.TABLE.length, 15 + CHARA_N, '大会5・契約6・アイドル4 ＋ 課題は雀ドルの数だけ');
  const kinds = Offers.TABLE.reduce((a, o) => { a[o.kind] = (a[o.kind] || 0) + 1; return a; }, {});
  eq(kinds.tournament, 5, '大会は既存の5つ');
  eq(kinds.contract, 6, "契約イベントは contract === 'event' の6人ぶん");
  eq(kinds.idol, 4, 'アイドル案件は4種');
  eq(kinds.quest, CHARA_N, '課題は雀ドル一人につき一件（相手ごとに一枠）');

  eq(new Set(Offers.TABLE.map((o) => o.id)).size, Offers.TABLE.length, 'id が重複していない');
  ok(Offers.TABLE.every((o) => typeof o.when === 'function'), '全件に when がある');
  ok(Offers.TABLE.every((o) => o.prio >= 1 && o.prio <= 9), 'prio は1〜9');
  ok(Offers.TABLE.every((o) => o.members && o.members.max >= o.members.min),
    'members の min ≤ max');

  /* **発火条件に日付を書かない**（§1.3・§8.1）。
     when の中身を文字列にして、日付を見ていないことを機械的に確かめる */
  const bad = Offers.TABLE.filter((o) => /parlor|\bday\b|Date/.test(String(o.when)));
  eq(bad.length, 0, 'when が日付（parlor.day / Date）を見ていない',
    bad.map((o) => o.id).join(','));

  /* 契約イベントは JANDOLS の event 6人と一対一 */
  const evIds = JANDOLS.concat(FREE_AGENTS).filter((c) => c.contract === 'event')
    .map((c) => c.id).sort((a, b) => a - b);
  const offIds = Offers.TABLE.filter((o) => o.kind === 'contract')
    .map((o) => o.payload.charaId).sort((a, b) => a - b);
  eq(offIds.join(','), evIds.join(','),
    "contract === 'event' の6人すべてに依頼がある（天城リオ No.001 を含む）");
  ok(offIds.indexOf(1) >= 0, '天城リオ No.001 の依頼がある');
  ok(Offers.TABLE.filter((o) => o.kind === 'contract').every((o) => o.once),
    '契約イベントは一度きり');
  ok(Offers.TABLE.filter((o) => o.kind === 'contract').every((o) => o.days === 0),
    '契約イベントは受けるだけなら日を消費しない（会いに行くのは遠征）');

  /* アイドル案件の fit は、実在する chara（性格19種）だけ */
  const charas = new Set(JANDOLS.concat(FREE_AGENTS).map((c) => c.chara));
  const badFit = [];
  Offers.TABLE.filter((o) => o.kind === 'idol').forEach((o) => {
    o.payload.fit.forEach((f) => { if (!charas.has(f)) badFit.push(o.id + ':' + f); });
  });
  eq(badFit.length, 0, 'アイドル案件の向き不向きは実在する性格だけ', badFit.join(','));
}

/* ---------- 発火（§8.1・§8.3） ---------- */
{
  const Offers = global.Offers;
  const seeded = (n) => { let s = n >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
  /* **契約イベントの6人（id 1・8・16・18・42・54）と重ならない子を使う。**
     契約済みの相手には話が来ないので、重ねると when が偽になる */
  const a = JANDOLS[2], b = JANDOLS[3], c = JANDOLS[4];
  const roster = [a, b, c];

  /* 何も満たしていないセーブ … 大会は D級でも新人戦が来る（band[0] が D） */
  const st0 = { playerRank: 'D', team: [a.id, b.id, c.id], contracted: [a.id, b.id, c.id],
                officePref: 'kyoto', offers: [], offerFired: [], offerAccepted: [] };
  const got = Offers.fire(st0, roster, seeded(1));
  ok(got.length > 0, '条件を満たすものは届く');
  ok(got.every((o) => Offers.byId(o.id)), '返るのは表にある id だけ');

  /* **同じものは二度届かない**（もう事務所に出ているあいだは） */
  const st1 = Object.assign({}, st0, { offers: got });
  const again = Offers.fire(st1, roster, seeded(1));
  ok(again.every((o) => got.every((g) => g.id !== o.id)), 'すでに届いているものは重ねない');

  /* **once は二度発火しない**（§8.1） */
  const win = { eight: { entries: 1, best: '優勝' }, title: { entries: 1, best: '優勝' },
                open: { entries: 1, best: '優勝' }, local: { entries: 1, best: '優勝' } };
  const rich = Object.assign({}, st0, { playerRank: 'S', agency: 5, records: win,
    favor: { 1: 100, 8: 100, 16: 100, 18: 100, 42: 100, 54: 100 } });
  const ev1 = Offers.fire(rich, roster, seeded(2)).filter((o) => Offers.byId(o.id).once);
  eq(ev1.length, 6, '条件が揃えば契約イベント6件が一度に届く（規模に依らない・§8.3）');
  const ev2 = Offers.fire(Object.assign({}, rich,
    { offerFired: ev1.map((o) => o.id) }), roster, seeded(2))
    .filter((o) => Offers.byId(o.id).once);
  eq(ev2.length, 0, 'once は二度発火しない');

  /* **when が偽なら届かない** */
  const poor = Object.assign({}, st0, { favor: {}, agency: 1, records: {} });
  eq(Offers.fire(poor, roster, seeded(3)).filter((o) => Offers.byId(o.id).kind === 'contract').length,
    0, '条件を満たしていない契約イベントは届かない');

  /* 契約済みの相手には届かない（もう要らない） */
  const signed = Object.assign({}, rich, { contracted: rich.contracted.concat(1) });
  ok(!Offers.fire(signed, roster, seeded(4)).some((o) => o.id === 'event-001'),
    '契約済みの相手の話は届かない');

  /* 溜め込みすぎない */
  const many = Object.assign({}, st0, { offers: new Array(Offers.MAX_OPEN).fill(0)
    .map((_, i) => ({ id: 'x' + i, kind: 'idol' })) });
  eq(Offers.fire(many, roster, seeded(5)).filter((o) => !Offers.byId(o.id).once).length, 0,
    'MAX_OPEN まで溜まったら、once でないものは届かない');

  /* 並び順は prio の大きいほうが先 */
  const sorted = Offers.fire(rich, roster, seeded(6));
  for (let i = 1; i < sorted.length; i++) {
    ok(Offers.byId(sorted[i - 1].id).prio >= Offers.byId(sorted[i].id).prio,
      'prio の大きいほうが先に並ぶ');
  }

  /* 同じ種なら同じ結果（朝に一度引くだけで、あとから変わらない） */
  eq(JSON.stringify(Offers.fire(st0, roster, seeded(7))),
     JSON.stringify(Offers.fire(st0, roster, seeded(7))), '同じ種なら同じものが届く');
}

/* ---------- RULES.event は「依頼を受けたか」だけを見る（§8.2） ---------- */
{
  const Offers = global.Offers;
  const rio = JANDOLS.find((c) => c.id === 1);
  eq(rio.contract, 'event', '天城リオの契約条件は event');

  /* `evaluate` は事務所ランクと資金も見るので、そこは満たした状態で比べる */
  const ready = { agency: 5, money: 99999999, offerAccepted: [] };

  const before = Scout.evaluate(rio, ready, []);
  eq(before.ok, false, '依頼を受けていなければ契約できない');
  ok(/事務所に話が届く/.test(before.detail), '待てばよいと分かる文面になっている');

  const after = Scout.evaluate(rio, Object.assign({}, ready,
    { offerAccepted: ['event-001'] }), []);
  eq(after.ok, true, '**依頼を受ければ契約できる（天城リオがここで解ける）**');

  /* 6人すべてが同じ経路で開くこと */
  const stuck = JANDOLS.concat(FREE_AGENTS).filter((c) => c.contract === 'event')
    .filter((c) => {
      const o = Offers.TABLE.find((x) => x.kind === 'contract' && x.payload.charaId === c.id);
      return !o || !Scout.evaluate(c, Object.assign({}, ready,
        { offerAccepted: [o.id] }), []).ok;
    });
  eq(stuck.length, 0, 'event の6人すべてが依頼で開く', stuck.map((c) => c.name).join(','));

  /* **依頼を受けていない他の5人は開かない**（一件受けたら全部開く、にならないこと） */
  const leak = JANDOLS.concat(FREE_AGENTS).filter((c) => c.contract === 'event' && c.id !== 1)
    .filter((c) => Scout.evaluate(c, Object.assign({}, ready,
      { offerAccepted: ['event-001'] }), []).ok);
  eq(leak.length, 0, '受けた一件ぶんだけが開く', leak.map((c) => c.name).join(','));
}

/* ---------- アイドル案件の効き目（§8.2） ---------- */
{
  const Offers = global.Offers;
  const def = Offers.byId('idol-photo');
  const fit = Object.assign({}, JANDOLS[0], { id: 901, name: '向いてる子', chara: def.payload.fit[0] });
  const unfit = Object.assign({}, JANDOLS[0], { id: 902, name: '向いてない子', chara: '毒舌' });

  const r1 = Office.idolResult(def, [fit], null);
  const r2 = Office.idolResult(def, [unfit], null);
  eq(r1.pop[901], def.payload.pop, '向いていれば満額');
  ok(r2.pop[902] < r1.pop[901], '向いていなければ伸びが小さい');
  ok(r2.pop[902] >= 1, '向いていなくても0にはしない');
  eq(r1.pay, def.payload.pay, '報酬は案件のとおり');
  eq(r1.favor[901], def.payload.favor, '好感度も上がる');

  /* 対局付きは、勝てば跳ねる（§8.2） */
  const win = Office.idolResult(def, [fit], { 901: 1 });
  const lose = Office.idolResult(def, [fit], { 901: 4 });
  ok(win.pop[901] > lose.pop[901], '勝てば人気が跳ねる');
  ok(win.won, '勝ったことが分かる');
  ok(!lose.won, '負けたら won は立たない');

  /* 人数で割らない（送ったぶん素直に伸びる） */
  const two = Office.idolResult(Offers.byId('idol-event'), [fit, unfit], null);
  eq(Object.keys(two.pop).length, 2, '送った人数ぶん出る');
}

/* ---------- 人気の底上げは元データを書き換えない（§8.2） ---------- */
{
  const a = JANDOLS[0];
  const basePop = a.pop;
  eq(Office.popOf({}, a), basePop, '底上げが無ければ元の人気');
  eq(Office.popOf({ popUp: { [a.id]: 7 } }, a), basePop + 7, '底上げぶんが足される');
  eq(JANDOLS[0].pop, basePop, '**元データは書き換えない**');

  /* rosterOf も同じ読みかたをすること（雀荘の客足に効くので、ずれると嘘になる） */
  const st = { contracted: [a.id], comp: {}, popUp: { [a.id]: 5 } };
  eq(Office.rosterOf(st)[0].pop, basePop + 5, 'rosterOf も底上げを反映する');
}

/* ============================================================
   遠征（spec.md §7）— 第三段
   ============================================================ */
{
  const st = { officePref: 'kyoto', contracted: [], comp: {} };

  /* §13：京都→大阪・一人が SCOUT_COST・2日 */
  const a = Office.planTrip(st, 'osaka', 'find', []);
  eq(a.far, 0, '京都→大阪は far 0');
  eq(a.days, 2, '京都→大阪は2日');
  eq(a.cost, Scout.SCOUT_COST, '京都→大阪・代表ひとりは SCOUT_COST ちょうど');

  /* §7.2 が明示している、もう一つの目安 */
  const b = Office.planTrip(st, 'okinawa', 'find', [1, 2, 3]);
  eq(b.days, 7, '京都→那覇は7日');
  eq(b.cost, 720000, '京都→那覇・同行3人は72万円');

  /* days = 2 + far / cost = SCOUT_COST × (1 + far) × (1 + 同行者数) */
  for (let far = 0; far <= 5; far++) {
    const pref = ['osaka', 'aichi', 'tokyo', 'fukuoka', 'hokkaido', 'okinawa'][far];
    const p = Office.planTrip(st, pref, 'find', []);
    eq(p.days, 2 + far, 'far ' + far + ' の日数は 2+far');
    eq(p.cost, Scout.SCOUT_COST * (1 + far), 'far ' + far + ' の費用は 3万×(1+far)');
  }
  /* 同行者は費用にだけ効く。日数は変わらない（日数は「滞在」なので・§4.3） */
  const solo = Office.planTrip(st, 'tokyo', 'find', []);
  const three = Office.planTrip(st, 'tokyo', 'find', [1, 2, 3]);
  eq(three.days, solo.days, '同行者を増やしても日数は変わらない');
  eq(three.cost, solo.cost * 4, '同行者3人で費用は4倍');

  /* 本拠地が無ければ far 0 として組む（落ちない） */
  eq(Office.planTrip({}, 'okinawa', 'find', []).days, 2, '本拠地が無くても落ちない');
  eq(Office.planTrip(st, null, 'find', []).far, 0, '行き先が無ければ far 0');
}

/* ---------- 留守番（§7.4・§13） ---------- */
{
  const a = JANDOLS[0], b = JANDOLS[1], c = JANDOLS[2];
  const base = { officePref: 'kyoto', contracted: [a.id, b.id, c.id], comp: {} };

  /* **既定は出勤者で comp 最大** */
  const st = Object.assign({}, base, { comp: { [a.id]: 20, [b.id]: 90, [c.id]: 50 } });
  eq(Office.deputyOf(st).id, b.id, '出勤者で完成度がいちばん高い子');

  /* **休みの子は選ばない** */
  const st2 = Object.assign({}, st, { assign: { [b.id]: 'rest' } });
  eq(Office.deputyOf(st2).id, c.id, '休みの子は選ばない');

  /* **遠征中の子は選ばない** */
  const st3 = Object.assign({}, st, { assign: { [b.id]: 'trip' }, trip: { pref: 'osaka', dayLeft: 2 } });
  eq(Office.deputyOf(st3).id, c.id, '遠征中の子は選ばない');

  /* これから連れて行く子も外して数える（出発の画面で先に見せるため） */
  eq(Office.deputyOf(st, [b.id]).id, c.id, '同行者に選んだ子は留守番から外れる');
  eq(Office.deputyOf(st, [a.id, b.id, c.id]), null, '全員連れて行けば留守番はいない');

  /* **出勤者が一人もいなければ null** */
  eq(Office.deputyOf({ contracted: [], comp: {} }), null, '所属がいなければ null');
  eq(Office.deputyOf(Object.assign({}, base,
    { assign: { [a.id]: 'rest', [b.id]: 'rest', [c.id]: 'rest' } })), null,
    '全員が休みなら null');
}

/* ---------- 遠征の状態（§7.5） ---------- */
{
  eq(Office.tripOf({}), null, '遠征していなければ null');
  eq(Office.tripOf({ trip: null }), null, 'null もそのまま');
  eq(Office.tripOf({ trip: {} }), null, '行き先の無い trip は無効');
  eq(Office.tripOf({ trip: { pref: 'nowhere', dayLeft: 3 } }), null, '知らない県は無効');
  eq(Office.tripOf({ trip: { pref: 'osaka', dayLeft: 0 } }), null, '残り0日は無効');
  eq(Office.tripOf({ trip: { pref: 'osaka', dayLeft: 3 } }).pref, 'osaka', '生きている遠征は返る');

  /* §13：trip を消したセーブで assign の trip が parlor に戻る（配置の節で固定済み） */
  eq(Office.assignFor({ assign: { 1: 'trip' }, trip: { pref: 'osaka', dayLeft: 0 } }, 1), 'parlor',
    '終わった遠征なら assign も店に戻す');

  /* 出発の組み立て */
  const a = JANDOLS[0], b = JANDOLS[1];
  const st = { officePref: 'kyoto', contracted: [a.id, b.id], comp: { [a.id]: 90, [b.id]: 10 },
               money: 1000000 };
  const t = Office.tripStart(st, 'tokyo', 'woo', [b.id], a.id);
  eq(t.dayLeft, t.days, '出発した日は残り日数＝総日数');
  eq(t.days, 4, '京都→東京は far 2 なので4日');
  eq(t.cost, Scout.SCOUT_COST * 3 * 2, '費用は 3万×(1+2)×(1+1)');
  eq(t.deputy, a.id, '同行者を外した残りから留守番を決める');
  eq(t.target, a.id, '口説く相手を持つ');
  eq(t.store.days, 0, '留守中の店の合計は0から');
  eq(t.log.length, 0, '出来事はまだ無い');
}

/* ---------- 発見の抽選は当面その県の地方から（§4.4） ---------- */
{
  eq(Office.regionOfPref('osaka'), '関西', '大阪は関西');
  eq(Office.regionOfPref('hokkaido'), '北海道・東北', '北海道は北海道・東北');
  eq(Office.regionOfPref('nowhere'), null, '知らない県は null');
  /* 47県すべてが、REGIONS のいずれかに引ける（引けないと抽選が全国になる） */
  ok(Geo.PREFS.every((p) => REGIONS.indexOf(Office.regionOfPref(p.key)) >= 0),
    '47県すべてから地方が引ける');
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

/* ============================================================
   雀エイト表（spec.md §9.1）— 第五段
   ============================================================ */
{
  const all = JANDOLS.concat(FREE_AGENTS);
  const blank = () => ({ contracted: [], comp: {}, records: {}, beaten: [], popUp: {},
                         officeName: 'テスト事務所', officePref: 'tokyo' });

  /* --- 形 --- */
  {
    const t = Office.eightTable(blank());
    eq(t.length, 8, '八人');
    eq(t[0].place, 1, '順位が付く');
    eq(t[7].place, 8, '八位まで');
    ok(t.every((r) => r.name && r.rank && r.agency), '名前・級・所属が埋まっている');
    for (let i = 1; i < t.length; i++) ok(t[i - 1].power >= t[i].power, '強さの降順');
    eq(new Set(t.map((r) => r.id)).size, 8, '同じ子が二度載らない');
  }

  /* --- **始まりは八人の S級**（RANK_INFO の label と噛み合う） --- */
  {
    const t = Office.eightTable(blank());
    ok(t.every((r) => r.rank === 'S'), '最初は S級だけが載る',
       t.map((r) => r.name + r.rank).join(' '));
    eq(all.filter((c) => c.rank === 'S').length, 8, 'S級はちょうど八人');
    /* **`strengthOf` だけで並べると崩れる**——だから実績を配合している */
    const byStrength = all.map((c) => ({ c, s: strengthOf(c, STYLES) }))
      .sort((a, b) => b.s - a.s).slice(0, 8);
    ok(byStrength.some((x) => x.c.rank !== 'S'),
       '強さだけで並べると S級以外が入る（実績を混ぜる理由）');
  }

  /* --- 同じセーブなら並びが揺れない（毎朝ちらつかせない） --- */
  {
    const st = blank();
    eq(JSON.stringify(Office.eightTable(st)), JSON.stringify(Office.eightTable(st)),
       '同じセーブなら同じ表');
  }

  /* --- 育てて、大会で勝つと上がる --- */
  {
    const a = all.find((c) => c.rank === 'A');
    let st = Object.assign(blank(), { contracted: [a.id] });
    const p0 = Office.powerOf(a, st, true);
    st = Object.assign({}, st, { comp: { [a.id]: 100 } });
    const p1 = Office.powerOf(a, st, true);
    ok(p1 > p0, '育てると強さが上がる');
    st = Object.assign({}, st, { records: { title: { best: '優勝' } } });
    const p2 = Office.powerOf(a, st, true);
    ok(p2 > p1, '大会で勝つと上がる');
    /* 四冠まで獲れば表に入る */
    st = Object.assign({}, st, { records: {
      rookie: { best: '優勝' }, local: { best: '優勝' },
      open: { best: '優勝' }, title: { best: '優勝' } } });
    ok(Office.eightTable(st).some((r) => r.mine), '育てて四冠まで獲れば割り込める');
  }

  /* --- 実績は所属だけに乗る（NPC は級が背負っているぶんだけ） --- */
  {
    const a = all.find((c) => c.rank === 'A');
    const st = Object.assign(blank(), { records: { title: { best: '優勝' } } });
    ok(Office.powerOf(a, st, true) > Office.powerOf(a, st, false),
       '事務所の実績は所属にだけ乗る');
    ok(Office.agencyTitle(blank()) === 0, '何も獲っていなければ0');
    ok(Office.agencyTitle({ records: { rookie: { best: '出場' } } }) === 0,
       '**優勝だけを数える**（出ただけでは載らない）');
    const full = { records: { rookie: { best: '優勝' }, local: { best: '優勝' },
      open: { best: '優勝' }, title: { best: '優勝' }, eight: { best: '優勝' } },
      beaten: [1, 2, 3, 4, 5, 6, 7, 8] };
    ok(Office.agencyTitle(full) <= 40, '実績の上乗せには上限がある');
  }

  /* --- 元データを書き換えない（`popOf` と同じ作法） --- */
  {
    const a = all.find((c) => c.rank === 'A');
    const before = a.comp;
    Office.eightTable(Object.assign(blank(), { comp: { [a.id]: 100 }, contracted: [a.id] }));
    eq(a.comp, before, 'characters.js の comp を書き換えない');
  }

  /* --- ライバル事務所（引き抜きの主体として先に存在している） --- */
  {
    eq(Object.keys(Office.RIVALS).length, REGIONS.length, '地方の数だけ事務所がある');
    ok(REGIONS.every((r) => Office.RIVALS[r]), 'REGIONS の全部に事務所がある');
    eq(new Set(Object.values(Office.RIVALS)).size, REGIONS.length, '名前が重複していない');
    ok(FREE_AGENTS.every((c) => Office.rivalOf(c) === 'フリー'), 'フリーはどこにも属さない');
    const j = JANDOLS[0];
    eq(Office.rivalOf(j), Office.RIVALS[j.region], '雀ドルは地方の事務所に居る');
    /* 所属になったら自分の事務所の名前で出る */
    const st = Object.assign(blank(), { contracted: [j.id] });
    const row = Office.eightTable(st).find((r) => r.id === j.id);
    if (row) eq(row.agency, Office.nameOf(st), '所属は自分の事務所名で出る');
  }

  /* --- 「あと何点で入れるか」 --- */
  {
    eq(Office.eightNext(blank()), null, '所属がいなければ出さない');
    const d = all.find((c) => c.rank === 'D');
    const st = Object.assign(blank(), { contracted: [d.id] });
    const n = Office.eightNext(st);
    ok(n && n.gap > 0, '入っていなければ差が出る');
    eq(n.name, d.name, '所属のうちいちばん近い子');
    const inSt = Object.assign(blank(), { contracted: [all.find((c) => c.rank === 'S').id] });
    eq(Office.eightNext(inSt), null, 'もう入っていれば出さない');
  }

  /* --- 配合（実力＝強さ6：実績4／順位＝実力6：人気4）--- */
  {
    eq(Office.POWER_MIX.strength + Office.POWER_MIX.title, 1, '実力の配合は合わせて1');
    ok(Office.POWER_MIX.strength > Office.POWER_MIX.title, '強さのほうが重い');
    eq(Office.FAME_MIX.might + Office.FAME_MIX.fame, 1, '二軸の指数は合わせて1');
    ok(Office.FAME_MIX.might > Office.FAME_MIX.fame, '実力のほうが重い');
  }

  /* --- **二軸。掛け合わせなので両方が要る**（§9.1） --- */
  {
    const st = blank();
    const a = all.find((c) => c.rank === 'A');
    /* 人気0の子は、実力を最大まで上げても入らない */
    const noFame = Object.assign(blank(), {
      contracted: [a.id], comp: { [a.id]: 100 },
      popUp: { [a.id]: -(a.pop || 0) },              // 人気を0にする
      records: { rookie: { best: '優勝' }, local: { best: '優勝' },
                 open: { best: '優勝' }, title: { best: '優勝' } },
    });
    eq(Office.popOf(noFame, a), 0, '人気を0にできた');
    eq(Office.powerOf(a, noFame, true), 0, '人気0なら順位の点も0');
    ok(!Office.eightTable(noFame).some((r) => r.mine),
       '**人気0の子は comp 100 でも八人に入らない**');
    /* 逆に、人気だけ高くて実力が無い子も入らない */
    const d = all.find((c) => c.rank === 'D');
    const noMight = Object.assign(blank(), { contracted: [d.id], popUp: { [d.id]: 100 } });
    ok(Office.popOf(noMight, d) > 100, '人気を上げた');
    ok(!Office.eightTable(noMight).some((r) => r.mine),
       '人気だけ高くても、実力が無ければ入らない');
    /* 二軸が別々に出ている */
    const row = Office.eightTable(st)[0];
    ok(row.might > 0 && row.pop > 0, '表に実力と人気が別々に載る');
    ok(row.power !== row.might, '順位の点は実力そのものではない');
    /* **足し算にしていない**（掛け合わせの証拠）。片方を倍にすると
       同じ倍率では効かない */
    const base = Office.powerOf(a, Object.assign(blank(), { contracted: [a.id] }), true);
    const twice = Office.powerOf(a, Object.assign(blank(), {
      contracted: [a.id], popUp: { [a.id]: a.pop } }), true);
    ok(twice / base < 2, '人気を倍にしても点は倍にならない（掛け合わせ）');
    ok(twice > base, 'それでも人気は効く');
  }

  /* --- 子ごとの大会戦績（`st.wins`。A5 から記録を始めた） --- */
  {
    const a = all.find((c) => c.rank === 'A');
    /* 無いセーブでも壊れない */
    const noWins = Object.assign(blank(), { contracted: [a.id] });
    delete noWins.wins;
    ok(Office.powerOf(a, noWins, true) > 0, '`st.wins` が無いセーブを読んで壊れない');
    ok(Office.eightTable(noWins).length === 8, '表も出る');

    /* 記録があればそちらを優先する */
    const w = Tournament.recordResult({}, a.id, 'title', 'win');
    const withWins = Object.assign(blank(), { contracted: [a.id], wins: w });
    ok(Office.charaTitle(withWins, a.id) > 0, '子ごとの実績が点になる');
    /* 事務所の実績があっても、子ごとの記録が優先される */
    const both = Object.assign({}, withWins, {
      records: { rookie: { best: '優勝' }, local: { best: '優勝' },
                 open: { best: '優勝' }, title: { best: '優勝' } } });
    eq(Office.mightOf(a, both, true), Office.mightOf(a, withWins, true),
       '子ごとの記録があれば事務所の実績は使わない');
    /* 記録の無い子は事務所単位のまま */
    const other = all.find((c) => c.rank === 'B');
    const mix = Object.assign({}, both, { contracted: [a.id, other.id] });
    ok(Office.mightOf(other, mix, true) > Office.mightOf(other, withWins, true),
       '記録の無い子は事務所の実績に落ちる');
  }
}

/* ============================================================
   疲労と調子（spec.md §9）— 第五段
   ============================================================ */
{
  const all = JANDOLS.concat(FREE_AGENTS);
  const c = all.find((x) => x.rank === 'S');

  /* --- 既定値では何も動かない（第五段の入口の錠） --- */
  {
    const st = { comp: { [c.id]: 90 }, fatigue: {}, cond: {} };
    eq(Office.compEffOf(st, c), 90, '疲労0・調子0なら素の comp と一致する');
    eq(Office.tableCardOf(st, c).comp, 90, '卓に座らせる形でも一致する');
    /* `computeDay` の二つも、旗を立てなければ効かない */
    const cfg = { tables: 4, interior: 2, auto: 2, sign: 1, rep: 40,
      slotPop: [150, 140, 470], slotWorkers: [2, 2, 6] };
    const rngOf = () => { let i = 0; const xs = [0.5, 0.5, 0.5]; return () => xs[i++ % 3]; };
    const a = Jansou.computeDay(cfg, rngOf());
    const b = Jansou.computeDay(Object.assign({}, cfg, {
      slotFavor: [999, 999, 9999], baseSeats: 0 }), rngOf());
    eq(JSON.stringify(a), JSON.stringify(b),
       '**旗を立てなければ、好感度も出勤人数も1円も動かさない**');
  }

  /* --- 疲労100の S級（comp 90）は A級に落ち、B級には落ちない --- */
  {
    const st = { comp: { [c.id]: 90 }, fatigue: { [c.id]: 100 }, cond: {} };
    const e = Office.compEffOf(st, c);
    eq(gradeOf(90), 'S', '素は S級');
    eq(gradeOf(e), 'A', '疲労100 で A級に落ちる（' + e.toFixed(1) + '）');
    ok(gradeOf(e) !== 'B', 'B級までは落ちない');
    /* 途中は線形 */
    const half = Office.compEffOf({ comp: { [c.id]: 90 }, fatigue: { [c.id]: 50 } }, c);
    eq(Math.round(half), Math.round(90 * (1 - Office.FATIGUE_PULL * 0.5)), '疲労は線形に効く');
  }

  /* --- 調子は薄く効く --- */
  {
    const base = { comp: { [c.id]: 90 }, fatigue: {} };
    const up = Office.compEffOf(Object.assign({}, base, { cond: { [c.id]: 2 } }), c);
    const dn = Office.compEffOf(Object.assign({}, base, { cond: { [c.id]: -2 } }), c);
    eq(up - dn, 4 * Office.COND_SHIFT, '調子の幅は ±2 段ぶん');
    ok(up - dn < 90 * Office.FATIGUE_PULL, '疲労より薄い');
    eq(Office.compEffOf(Object.assign({}, base, { cond: { [c.id]: 0 } }), c), 90, '調子0なら動かない');
  }

  /* --- 一日の増減 --- */
  {
    eq(Office.fatigueDelta({ rest: true }), -15, '休みの子は一日で −15');
    eq(Office.fatigueDelta({ slots: 1 }), 1, '夜だけ出勤の子は +1');
    eq(Office.fatigueDelta({ slots: 3 }), 9, 'フル出勤は +9');
    eq(Office.fatigueDelta({}), Office.FATIGUE.night, '何もしない日は毎晩ぶんだけ抜ける');
    eq(Office.fatigueDelta({ trip: true }), 8, '遠征は +8');
    eq(Office.fatigueDelta({ trip: true, tripMatch: true }), 12, '現地で打つ日は上乗せ');
    ok(Office.fatigueDelta({ rest: true }) < 0, '**回復しきる方向**');
    /* 積む側 */
    const st = { fatigue: { 1: 10, 2: 0 } };
    const next = Office.stepFatigue(st, { 1: { rest: true }, 2: { slots: 3 } });
    eq(next[1], 0, '10 から休むと 0 で止まる（下限）');
    eq(next[2], 9, '0 からフル出勤で 9');
    eq(st.fatigue[1], 10, '元の表を書き換えない');
    eq(Office.stepFatigue({ fatigue: { 1: 98 } }, { 1: { taikai: true } })[1], 100, '上限は100');
    /* 満タンまでの日数（設計の根拠がそのまま出る） */
    eq(Math.ceil(100 / Office.fatigueDelta({ slots: 3 })), 12, 'フル出勤は12日で満タン');
    eq(Math.ceil(100 / Office.fatigueDelta({ trip: true })), 13, '遠征は13日ぶん');
  }

  /* --- 調子は同じ朝に二度引いても変わらない（`condDay` の印） --- */
  {
    const roster = JANDOLS.slice(0, 4).map((x) => x.id);
    let saved = { contracted: roster, comp: {}, fatigue: {}, popUp: {} };
    const store = { get: () => saved, set: (patch) => { saved = Object.assign({}, saved, patch); } };
    const seeded = (n) => { let s = n >>> 0;
      return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };

    eq(Office.ensureCond(store, 7, seeded(1)), true, '朝に一度引く');
    const first = JSON.stringify(saved.cond);
    eq(saved.condDay, 7, '引いた日が印として残る');
    eq(Office.ensureCond(store, 7, seeded(999)), false, '**同じ朝は引き直さない**');
    eq(JSON.stringify(saved.cond), first, '種を変えても二度目は動かない');
    eq(Office.ensureCond(store, 8, seeded(1)), true, '日が変われば引き直す');

    /* 種を固定すれば再現する */
    let s2 = { contracted: roster, comp: {}, fatigue: {}, popUp: {} };
    const st2 = { get: () => s2, set: (p) => { s2 = Object.assign({}, s2, p); } };
    Office.ensureCond(st2, 7, seeded(1));
    eq(JSON.stringify(s2.cond), first, '同じ種・同じ日なら同じ結果');
    ok(Object.keys(saved.cond).length === roster.length, '所属の全員ぶん引く');
    Object.values(saved.cond).forEach((v) => ok(v >= -2 && v <= 2, '調子は −2〜+2'));
  }

  /* --- 疲労が高いほど悪い目に寄る --- */
  {
    const w0 = Office.condWeights(0), w1 = Office.condWeights(100);
    eq(w0.length, 5, '五段');
    ok(Math.abs(w0.reduce((a, b) => a + b, 0) - 1) < 1e-9, '重みの合計は1（疲労0）');
    ok(Math.abs(w1.reduce((a, b) => a + b, 0) - 1) < 1e-9, '重みの合計は1（疲労100）');
    ok(w1[0] > w0[0], '疲労が高いと −2 が出やすい');
    ok(w1[4] < w0[4], '疲労が高いと +2 が出にくい');
    const mean = (w) => w.reduce((a, b, i) => a + b * (i - 2), 0);
    ok(mean(w1) < mean(w0), '期待値が下がる');
    ok(mean(w0) > 0, '疲労0では少し良いほうに寄る');
  }
}

/* ============================================================
   `computeDay` の第五段の二つ（旗を立てたとき）
   ============================================================ */
{
  const cfg = { tables: 8, interior: 5, auto: 3, sign: 3, rep: 85,
    slotPop: [296, 349, 943], slotWorkers: [4, 4, 12] };
  const flat = () => () => 0.5;

  /* --- openSeats は 8 + 人数×8 を超えない。workers 0 でも 8 --- */
  {
    const on = Object.assign({}, cfg, { staffing: true });
    const d = Jansou.computeDay(on, flat());
    d.slots.forEach((sl) => {
      const cap = Jansou.BASE_SEATS + sl.workers * Jansou.SEATS_PER_WORKER;
      ok(sl.seats <= cap, '開けられる席は 8 + 人数×8 を超えない（' + sl.name + '）');
      ok(sl.seats <= 32, '卓の数も超えない（' + sl.name + '）');
    });
    /* 終盤の顔ぶれなら、いまのシフトでは1席も削られない */
    const off = Jansou.computeDay(cfg, flat());
    eq(JSON.stringify(d.slots.map((x) => x.guests)), JSON.stringify(off.slots.map((x) => x.guests)),
       '**8/8 なら三局面は動かない**');
    /* workers 0 でも 8席は開く（代表が居る） */
    const none = Jansou.computeDay(Object.assign({}, cfg, {
      staffing: true, slotWorkers: [0, 0, 0], slotPop: [0, 0, 0] }), flat());
    none.slots.forEach((sl) => eq(sl.seats, Jansou.BASE_SEATS, 'workers 0 でも 8席（' + sl.name + '）'));
    /* baseSeats 0（代表が遠征中）なら閉まる */
    const away = Jansou.computeDay(Object.assign({}, cfg, {
      staffing: true, baseSeats: 0, slotWorkers: [0, 0, 0], slotPop: [0, 0, 0] }), flat());
    away.slots.forEach((sl) => eq(sl.guests, 0, '代表も人も居なければ客は来ない（' + sl.name + '）'));
  }

  /* --- 夜の単価は +15% を超えない --- */
  {
    const base = Jansou.computeDay(cfg, flat());
    const huge = Jansou.computeDay(Object.assign({}, cfg, {
      favorFee: true, slotFavor: [0, 0, 100000] }), flat());
    eq(huge.slots[2].guests, base.slots[2].guests, '単価は客数を動かさない');
    const ratio = huge.slots[2].sales / base.slots[2].sales;
    ok(ratio <= 1 + Jansou.FAVOR_FEE_CAP + 1e-6,
       '**Σfavor がいくら大きくても +15% を超えない**（' + ratio.toFixed(4) + '）');
    ok(ratio > 1.14, 'ちゃんと上限まで乗る');
    eq(huge.slots[0].sales, base.slots[0].sales, '昼の単価は動かさない');
    eq(huge.slots[1].sales, base.slots[1].sales, '夕の単価は動かさない');
    /* 途中の値。**上限に届くのは Σfavor 450**（0.15 × 3000）。
       そこを超えると平らになる——第五段の再測で見るべき点 */
    const mid = Jansou.computeDay(Object.assign({}, cfg, {
      favorFee: true, slotFavor: [0, 0, 150] }), flat());
    ok(Math.abs(mid.slots[2].sales / base.slots[2].sales - 1.05) < 0.01,
       'Σfavor 150 で +5%');
    const at = Jansou.FAVOR_FEE_CAP * Jansou.FAVOR_FEE_DIV;
    eq(at, 450, '上限に届く Σfavor は 450');
    const capped = Jansou.computeDay(Object.assign({}, cfg, {
      favorFee: true, slotFavor: [0, 0, at] }), flat());
    const over = Jansou.computeDay(Object.assign({}, cfg, {
      favorFee: true, slotFavor: [0, 0, at * 10] }), flat());
    eq(capped.slots[2].sales, over.slots[2].sales, '450 を超えると平らになる');
  }
}

/* ============================================================
   A5 で数字を置いたあとの錠（step 6）
   ============================================================ */
{
  const all = JANDOLS.concat(FREE_AGENTS);

  /* --- 疲労を進める口。朝に一度だけ --- */
  {
    const roster = JANDOLS.slice(0, 3);
    const ids = roster.map((c) => c.id);
    let saved = {
      contracted: ids, comp: {}, fatigue: {}, cond: {}, popUp: {},
      assign: {}, parlor: { shifts: {} },
    };
    const store = { get: () => saved, set: (p) => { saved = Object.assign({}, saved, p); } };

    /* 既定シフト（夜だけ）＝ +1 */
    eq(Office.ensureFatigue(store, 5), true, '朝に一度進む');
    eq(saved.fatigue[ids[0]], 1, '**夜だけ出勤の子は +1**');
    eq(saved.fatigueDay, 5, '進めた日が印として残る');
    eq(Office.ensureFatigue(store, 5), false, '**同じ朝は二度進まない**');
    eq(saved.fatigue[ids[0]], 1, '二度目で動かない');

    /* 休み ＝ −15 */
    saved = Object.assign({}, saved, { fatigue: { [ids[0]]: 40 },
      assign: { [ids[0]]: 'rest' } });
    Office.ensureFatigue(store, 6);
    eq(saved.fatigue[ids[0]], 25, '**休みの子は一日で −15**');

    /* 遠征5日で +40 前後 */
    let f = 0;
    for (let d = 0; d < 5; d++) f += Office.fatigueDelta({ trip: true });
    ok(f >= 35 && f <= 45, '**遠征5日で +40 前後**（' + f + '）');
    /* 着いた日は現地で一局打つぶん重い */
    const withMatch = f + Office.FATIGUE.tripMatch;
    ok(withMatch > f, '現地で打つ日は上乗せ');
  }

  /* --- きのう何をしていたかの読み（配置は変えるまで続く） --- */
  {
    const c = JANDOLS[0];
    const base = { parlor: { shifts: {} }, assign: {}, trip: null };
    eq(Office.actOf(base, c).slots, 1, '既定は夜だけの1帯');
    eq(Office.actOf(Object.assign({}, base, { assign: { [c.id]: 'rest' } }), c).rest, true, '休み');
    /* trip は「生きている遠征か」で見るので、assign だけでは店に落ちる */
    const tripSt = Object.assign({}, base, { assign: { [c.id]: 'trip' },
      trip: { pref: 'tokyo', dayLeft: 3 } });
    eq(Office.actOf(tripSt, c).trip, true, '遠征');
    const jobSt = Object.assign({}, base, { assign: { [c.id]: 'job:x' },
      offerAccepted: ['x'] });
    ok(Office.actOf(jobSt, c).job || Office.actOf(jobSt, c).slots >= 0, '依頼か店に落ちる');
    /* 三帯すべてに入っていれば +9 */
    const full = { parlor: { shifts: { [c.id]: [true, true, true] } }, assign: {}, trip: null };
    eq(Office.actOf(full, c).slots, 3, 'フル出勤は3帯');
    eq(Office.fatigueDelta(Office.actOf(full, c)), 9, 'フル出勤は +9');
  }

  /* --- 疲労 → 調子の順（調子の重みは疲労の高さで変わる） --- */
  {
    const roster = JANDOLS.slice(0, 2);
    let saved = { contracted: roster.map((c) => c.id), comp: {}, fatigue: {}, cond: {},
                  popUp: {}, assign: {}, parlor: { shifts: {} } };
    const store = { get: () => saved, set: (p) => { saved = Object.assign({}, saved, p); } };
    const seeded = (n) => { let s = n >>> 0;
      return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
    Office.ensureFatigue(store, 3);
    Office.ensureCond(store, 3, seeded(1));
    const snap = JSON.stringify({ f: saved.fatigue, c: saved.cond });
    /* 朝を二度描いても、どちらも動かない */
    Office.ensureFatigue(store, 3);
    Office.ensureCond(store, 3, seeded(77));
    eq(JSON.stringify({ f: saved.fatigue, c: saved.cond }), snap,
       '**朝を二度描いても疲労も調子も動かない**');
  }
}

/* ============================================================
   `computeDay` の新旧の基準（step 6 で本編の既定になった）
   ============================================================ */
{
  /* 三局面のうち中盤で、旗の有無が旧基準／新基準になること。
     `tools/measure-jansou.js` が出す数字と同じ組み立て */
  const cfg = { tables: 4, interior: 2, auto: 2, sign: 1, rep: 40,
    slotPop: [153, 143, 472], slotWorkers: [2, 2, 6] };
  const seeded = (n) => { let s = n >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
  const avg = (extra) => {
    const rng = seeded(1); let g = 0, sales = 0;
    for (let d = 0; d < 2000; d++) {
      const day = Jansou.computeDay(Object.assign({}, cfg, extra), rng);
      g += day.guests; sales += day.sales;
    }
    return { guests: Math.round(g / 2000), sales: Math.round(sales / 2000) };
  };
  const old = avg({});
  const now = avg({ staffing: true, favorFee: true, slotFavor: [80, 80, 240] });
  eq(old.guests, 82, '旧基準の中盤は 82人');
  eq(old.sales, 179251, '旧基準の中盤の場代');
  eq(now.guests, 82, '**新基準でも客数は動かない**');
  eq(now.sales, 186323, '新基準の中盤の場代（好感度が夜の単価に乗る）');
  ok(now.sales > old.sales, '効いているのは売上だけ');
}

/* ============================================================
   子ごとの大会戦績（tournament.js。office/spec.md §9.1）
   ============================================================ */
{
  const T = Tournament;
  eq(JSON.stringify(T.PLACE_KEYS), JSON.stringify(['win', 'second', 'final']),
     '入賞は決勝卓まで');

  let w = T.recordResult({}, 12, 'title', 'win');
  eq(w[12].title.entries, 1, '出場が数えられる');
  eq(w[12].title.win, 1, '優勝が数えられる');
  eq(w[12].title.place, 1, '優勝は入賞でもある');

  w = T.recordResult(w, 12, 'title', 'semi');
  eq(w[12].title.entries, 2, '二度目の出場');
  eq(w[12].title.win, 1, '準決勝では優勝は増えない');
  eq(w[12].title.place, 1, '準決勝は入賞ではない');

  w = T.recordResult(w, 12, 'title', 'second');
  eq(w[12].title.place, 2, '準優勝は入賞');

  w = T.recordResult(w, 12, 'open', 'win');
  eq(w[12].open.win, 1, '大会ごとに分かれる');
  eq(w[12].title.entries, 3, '別の大会は混ざらない（title は三回のまま）');

  /* 純関数。元の表を書き換えない */
  const before = T.recordResult({}, 5, 'rookie', 'win');
  const snap = JSON.stringify(before);
  T.recordResult(before, 5, 'rookie', 'win');
  eq(JSON.stringify(before), snap, '元の表を書き換えない');

  /* 壊れた入力で落ちない */
  eq(JSON.stringify(T.recordResult(null, 1, 'rookie', 'win')),
     JSON.stringify(T.recordResult({}, 1, 'rookie', 'win')), 'null を渡しても動く');
  eq(Object.keys(T.recordResult({}, null, 'rookie', 'win')).length, 0, 'id が無ければ何もしない');
  eq(Object.keys(T.recordResult({}, 1, null, 'win')).length, 0, '大会が無ければ何もしない');

  ok(!T.hasRecord({}, 1), '記録が無い');
  ok(!T.hasRecord(null, 1), 'null でも落ちない');
  ok(T.hasRecord(w, 12), '記録がある');
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
