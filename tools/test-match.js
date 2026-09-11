#!/usr/bin/env node
/*
  対局まわりの純関数テスト

    node tools/test-match.js

  ここに書くのは **DOMに触らない関数だけ**（tools/test-jansou.js と同じ方針）。
  卓の絵・牌の動き・音はブラウザ検証（tools/drive-match.js）で見る。

  **なぜ要るか。**対局側だけ錠が一本も無かった。`test-jansou` が71,534件、
  `test-office` が654件あるのに、対局は「人が押して確かめる」だけで、
  正しさの記録がどこにも残っていない。**いま正解が分かっているうちに固定する**
  ——一週間経つと「どれが正しかったか」を思い出すところから始まる。

  見るのは三つ。

    1. meldHTML の分岐（agari-spec.md §C-1）
       鳴いた牌を横に倒す位置＝上家は左端・対面は真ん中・下家は右端。
       加槓は末尾から二番目が鳴いた牌で、末尾はその上に重ねる。暗槓は倒さない
    2. UI.endKind / UI.endDeltas の四分岐（agari-spec.md §1・§2）
       自分がツモ／自分がロン／自分が振り込み／他家同士。増減は payments から組む
    3. RULES_DEFAULT の前方互換（BACKLOG「ローカルルール」）
       渡さない・undefined・null・部分指定のどれでも既定に落ちること
    4. SERIFU の `call` に鳴きの種類が入っていないこと
       ——`call` はポン・チー・カンで共有する一つの場面。人が気づけるのは
       実際に鳴かれた瞬間だけで、それも「チーなのにポンと言った」と
       分かる人に限られる。**機械に見張らせる**
    5. 締めの帯の下に、押せるものを置かないこと（2026年9月5日）
       ——四人卓の #topbar が帯の真下にあり、帯を叩いた指の click が
       「おまかせ」へ落ちうる形になっていた。形だけを機械的に見る
*/
'use strict';

const Engine = require('../src/engine.js');
/* ブラウザでは <script> が並ぶだけなので、グローバルに置くのがそのままの姿。
   ui.js は kindOf と Engine を**呼び出し時に**しか見ないが、先に置いておく */
global.Engine = Engine;
global.kindOf = Engine.kindOf;

const { UI, meldHTML } = require('../src/ui.js');
const { Game, RULES_DEFAULT } = require('../src/game.js');
const { SERIFU } = require('../src/serifu.js');

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
   1. meldHTML — 鳴いた牌を横に倒す（agari-spec.md §C-1）
   ============================================================ */

/* 牌の id は kind*4+n。ここでは種類だけ合っていればよいので下位2bitは 0 で作る */
const T = (kind, n = 0) => kind * 4 + n;

/* 倒した牌より左に、ふつうの牌が何枚あるか。
   `.meldSide` の開始タグより前に出てくる `class="tile ` の数を数えるだけ
   ——倒した牌そのものは `.meldSide` の**中**なので、この数え方だと混ざらない */
function cellsBeforeSide(html) {
  const at = html.indexOf('meldSide');
  if (at < 0) return -1;
  return (html.slice(0, at).match(/class="tile /g) || []).length;
}
const countSide = (html) => (html.match(/class="tile [^"]*\bside\b/g) || []).length;
const countAdd = (html) => (html.match(/class="tile [^"]*\badd\b/g) || []).length;
const countBack = (html) => (html.match(/hidden-back/g) || []).length;
const countTile = (html) => (html.match(/class="tile /g) || []).length;

{
  /* --- ポン。自分（席0）が鳴いた。used 2枚 ＋ 鳴いた牌1枚 --- */
  const pon = (from) => ({ type: 'pon', tile: 5, tiles: [T(5), T(5, 1), T(5, 2)], from });

  /* 上家＝左端 / 対面＝真ん中 / 下家＝右端。dir = (from - seat + 4) % 4 */
  eq(cellsBeforeSide(meldHTML(pon(3), 'tiny', 0)), 0, 'ポン：上家から鳴いたら左端に倒す');
  eq(cellsBeforeSide(meldHTML(pon(2), 'tiny', 0)), 1, 'ポン：対面から鳴いたら真ん中に倒す');
  eq(cellsBeforeSide(meldHTML(pon(1), 'tiny', 0)), 2, 'ポン：下家から鳴いたら右端に倒す');

  /* 席がずれても「相対の向き」で決まること（席2が席1から鳴く＝上家） */
  eq(cellsBeforeSide(meldHTML({ ...pon(1), from: 1 }, 'tiny', 2)), 0,
    '席2が席1から鳴いたら上家なので左端');

  /* 席を渡さなければ位置を決めない（右端に置く） */
  eq(cellsBeforeSide(meldHTML(pon(3), 'tiny')), 2, '席を渡さなければ右端（既定）');

  eq(countSide(meldHTML(pon(1), 'tiny', 0)), 1, 'ポンで倒す牌は一枚');
  eq(countTile(meldHTML(pon(1), 'tiny', 0)), 3, 'ポンは三枚');
}

{
  /* --- チー。used 2枚 ＋ 鳴いた牌。チーは必ず上家から --- */
  /* T(4) は id 16 ＝ **赤5萬**（engine.js の RED_IDS）。絵が Man5-Dora.svg になるので、
     並び順を見るここでは赤でない5萬（T(4,1)）を使う */
  const chi = { type: 'chi', tile: 3, tiles: [T(4, 1), T(5), T(3)], from: 3 };
  const h = meldHTML(chi, 'tiny', 0);
  eq(cellsBeforeSide(h), 0, 'チーは上家からなので左端に倒す');
  eq(countSide(h), 1, 'チーで倒す牌は一枚');
  eq(countTile(h), 3, 'チーは三枚');
  /* 倒すのは「鳴いた牌」＝ tiles の末尾（3萬）。残りの2枚は種類順に並ぶ */
  const rest = [...h.matchAll(/tiles\/(Man\d)\.svg/g)].map((m) => m[1]);
  eq(JSON.stringify(rest), JSON.stringify(['Man4', 'Man5', 'Man6']),
    'チー：倒した3萬が先頭（上家）で、残りは種類順');
}

{
  /* --- 明槓。used 3枚 ＋ 鳴いた牌 --- */
  const minkan = { type: 'minkan', tile: 7, tiles: [T(7), T(7, 1), T(7, 2), T(7, 3)], from: 2 };
  const h = meldHTML(minkan, 'tiny', 0);
  eq(countTile(h), 4, '明槓は四枚');
  eq(countSide(h), 1, '明槓で倒す牌は一枚');
  eq(countAdd(h), 0, '明槓に重ねる牌は無い');
  eq(cellsBeforeSide(h), 1, '明槓：対面から鳴いたら真ん中');
}

{
  /* --- 加槓。ポン（used2 ＋ 鳴いた牌）のあとに一枚 push されている。
         **末尾から二番目が鳴いた牌**で、末尾はその上に重ねる --- */
  const kakan = { type: 'kakan', tile: 9, tiles: [T(9), T(9, 1), T(9, 2), T(9, 3)], from: 1 };
  const h = meldHTML(kakan, 'tiny', 0);
  eq(countTile(h), 4, '加槓は四枚');
  eq(countSide(h), 2, '加槓は二枚とも倒す（鳴いた牌と、重ねた牌）');
  eq(countAdd(h), 1, '重ねた牌にだけ add が付く');
  eq(cellsBeforeSide(h), 2, '加槓：下家から鳴いたポンなので右端');
  /* 重ねる牌は倒した牌の**あと**に出る（CSS が上へ積む） */
  ok(h.indexOf('add') > h.indexOf('meldSide'), '重ねる牌は meldSide の中');
}

{
  /* --- 暗槓。倒さない。両端が裏 --- */
  const ankan = { type: 'ankan', tile: 12, tiles: [T(12), T(12, 1), T(12, 2), T(12, 3)], from: 0 };
  const h = meldHTML(ankan, 'tiny', 0);
  eq(countSide(h), 0, '暗槓は倒さない');
  eq(h.indexOf('meldSide'), -1, '暗槓に meldSide は出ない');
  eq(countBack(h), 2, '暗槓は両端が裏');
  eq(countTile(h), 4, '暗槓は四枚');
}

{
  /* --- 席を渡しても暗槓の形は変わらない（from が自分なので向きが無い） --- */
  const ankan = { type: 'ankan', tile: 12, tiles: [T(12), T(12, 1), T(12, 2), T(12, 3)], from: 2 };
  eq(countSide(meldHTML(ankan, 'tiny', 2)), 0, '暗槓は席を渡しても倒さない');
}

{
  /* --- 大きさの指定がそのまま入ること（帯は 'small'、卓の上は 'tiny'） --- */
  const pon = { type: 'pon', tile: 5, tiles: [T(5), T(5, 1), T(5, 2)], from: 1 };
  ok(meldHTML(pon, 'small', 0).includes('class="tile small'), '大きさ small が入る');
  ok(meldHTML(pon, 'tiny', 0).includes('class="tile tiny'), '大きさ tiny が入る');
}

{
  /* --- 元のデータを書き換えないこと（render は毎フレーム呼ばれる） --- */
  const tiles = [T(4, 1), T(5), T(3)];
  const chi = { type: 'chi', tile: 3, tiles, from: 3 };
  const before = tiles.slice();
  meldHTML(chi, 'tiny', 0);
  eq(JSON.stringify(tiles), JSON.stringify(before), 'meldHTML は m.tiles を並べ替えない');
}

/* ============================================================
   2. 局の締めの四分岐（agari-spec.md §1・§2）
   ============================================================ */

const P = (seat, name) => ({ seat, name: name || ('席' + seat) });
const winData = (winnerSeat, loserSeat, total, payments, sticks) => ({
  type: 'win',
  winner: P(winnerSeat),
  loser: loserSeat === null || loserSeat === undefined ? null : P(loserSeat),
  result: { score: { total }, fu: 30, han: 2, yaku: [] },
  payments,
  sticks: sticks || 0,
});

{
  /* --- endKind。**色替えではなく四つの別の画面**なので、ここがずれると全部ずれる --- */
  eq(UI.endKind(winData(0, null, 2000, [])), 'tsumo', '自分がツモ');
  eq(UI.endKind(winData(0, 2, 3900, [])), 'ron', '自分がロン');
  eq(UI.endKind(winData(2, 0, 12000, [])), 'dealin', '自分が振り込み');
  eq(UI.endKind(winData(2, 1, 8000, [])), 'other', '他家が他家からロン');
  eq(UI.endKind(winData(2, null, 8000, [])), 'other', '他家のツモも他家同士');
  eq(UI.endKind({ type: 'draw', reason: '流局', tenpai: [true, false, false, false] }), 'draw', '流局');
  eq(UI.endKind({ type: 'draw', reason: '四風連打', tenpai: null }), 'draw', '途中流局も流局');
}

{
  /* --- endDeltas。**payments は「誰がいくら払ったか」で、和了った人は入っていない** --- */
  /* 自分のロン。席2が 3900 払う */
  const d = UI.endDeltas(winData(0, 2, 3900, [{ seat: 2, amount: -3900 }]));
  eq(d[0], 3900, 'ロン：自分に +3900');
  eq(d[2], -3900, 'ロン：振り込んだ席に -3900');
  eq(d[1], 0, 'ロン：関係ない席は 0');
  eq(d.reduce((a, b) => a + b, 0), 0, 'ロン：供託が無ければ合計は 0');
}

{
  /* --- 供託（リーチ棒）は和了った人に乗る。**場から出るので合計は 0 にならない** --- */
  const d = UI.endDeltas(winData(0, 2, 3900, [{ seat: 2, amount: -3900 }], 1));
  eq(d[0], 4900, 'ロン：供託1本ぶん +1000 が乗る');
  eq(d.reduce((a, b) => a + b, 0), 1000, '供託があるぶん合計は +1000（場から出た）');
}

{
  /* --- 自分のツモ。三人から集める --- */
  const d = UI.endDeltas(winData(0, null, 4000, [
    { seat: 1, amount: -1000 }, { seat: 2, amount: -2000 }, { seat: 3, amount: -1000 },
  ]));
  eq(d[0], 4000, 'ツモ：自分に +4000');
  eq(d[2], -2000, 'ツモ：親のぶんが多い');
  eq(d.reduce((a, b) => a + b, 0), 0, 'ツモ：合計は 0');
}

{
  /* --- 振り込み。**自分の増減が負になること**が四分岐の要（§2） --- */
  const d = UI.endDeltas(winData(2, 0, 12000, [{ seat: 0, amount: -12000 }]));
  eq(d[0], -12000, '振り込み：自分に -12000');
  eq(d[2], 12000, '振り込み：和了った席に +12000');
  ok(d[0] < 0, '振り込みでは自分の増減が負');
}

{
  /* --- 他家同士。自分は動かない --- */
  const d = UI.endDeltas(winData(2, 1, 8000, [{ seat: 1, amount: -8000 }]));
  eq(d[0], 0, '他家同士：自分は ±0');
  /* 他家のツモは自分も払う（ツモ被り） */
  const t = UI.endDeltas(winData(2, null, 4000, [
    { seat: 0, amount: -1000 }, { seat: 1, amount: -1000 }, { seat: 3, amount: -2000 },
  ]));
  eq(t[0], -1000, '他家のツモ：自分もツモ被りで -1000');
}

{
  /* --- 流局。**payments に全員ぶんが入っている**（game.js の exhaustiveDraw） --- */
  const d = UI.endDeltas({
    type: 'draw', reason: '流局', tenpai: [true, false, true, false],
    payments: [{ seat: 0, amount: 1500 }, { seat: 1, amount: -1500 },
      { seat: 2, amount: 1500 }, { seat: 3, amount: -1500 }],
  });
  eq(d[0], 1500, '流局：テンパイに +1500');
  eq(d[1], -1500, '流局：ノーテンに -1500');
  eq(d.reduce((a, b) => a + b, 0), 0, '流局：合計は 0');
}

{
  /* --- payments が無い流局（途中流局・全員テンパイ・全員ノーテン） --- */
  const d = UI.endDeltas({ type: 'draw', reason: '四風連打', tenpai: null });
  eq(JSON.stringify(d), JSON.stringify([0, 0, 0, 0]), 'payments が無ければ全員 0');
  const e = UI.endDeltas({ type: 'draw', reason: '流局', tenpai: [true, true, true, true], payments: [] });
  eq(JSON.stringify(e), JSON.stringify([0, 0, 0, 0]), '全員テンパイなら誰も動かない');
}

{
  /* --- 元のデータを書き換えないこと --- */
  const payments = [{ seat: 2, amount: -3900 }];
  const data = winData(0, 2, 3900, payments, 1);
  const before = JSON.stringify(data);
  UI.endDeltas(data);
  eq(JSON.stringify(data), before, 'endDeltas は data を書き換えない');
}

{
  /* --- 送り。**四分岐すべてタップ待ち**（agari-spec.md §1）。
         初版は「他家同士」だけ自動で送っていて、実機で「何が起きたか分からないまま
         次の局へ流れる」となった。**他家のツモでは自分が払っている**し、
         他家の和了は順位にも打ち方の読みにも効く。
         ここが `other` だけ falls through する形に戻らないように固定する --- */
  const KINDS = ['tsumo', 'ron', 'dealin', 'other', 'draw'];
  KINDS.forEach((k) => {
    eq(UI.endAutoMs(k, false, 520), 0, k + '：人が見ているときはタップを待つ');
    eq(UI.endAutoMs(k, false, 900), 0, k + '：速さを変えてもタップを待つ');
    eq(UI.endAutoMs(k, false, 200), 0, k + '：速いでもタップを待つ');
  });
  /* 四つとも同じ扱い＝ kind で分かれていないこと */
  eq(new Set(KINDS.map((k) => UI.endAutoMs(k, false, 520))).size, 1,
    '送りかたが kind で分かれていない');
  /* 自動で送るのは人が見ていないときだけ */
  KINDS.forEach((k) => {
    ok(UI.endAutoMs(k, true, 520) > 0, k + '：おまかせなら自動で送る');
    ok(UI.endAutoMs(k, false, 0) > 0, k + '：最速なら自動で送る');
  });
}

{
  /* --- 立ち絵を出す側。**カットイン（say）と同じ式**でなければならない
         ——同じ人が会話と締めで左右に飛ぶ（agari-spec.md §10） --- */
  eq(UI.endSide(0), 'left', '自分は左');
  eq(UI.endSide(3), 'left', '上家は左');
  eq(UI.endSide(1), 'right', '下家は右');
  eq(UI.endSide(2), 'right', '対面は右');
}

{
  /* --- 一番大きい数字の書きかた（§2） --- */
  eq(UI.yenSigned(3900), '+3900', '増えたら +');
  eq(UI.yenSigned(-12000), '−12000', '減ったら −（全角のマイナス）');
  eq(UI.yenSigned(0), '±0', '動かなければ ±0');
  eq(UI.yenSigned(1499.6), '+1500', '端数は丸める（数えている途中の値が入る）');
}

/* ============================================================
   3. ローカルルールの前方互換（docs/BACKLOG.md「ローカルルール」）
   ============================================================ */
{
  const io = {};
  const same = (g) => JSON.stringify(g.rules) === JSON.stringify(RULES_DEFAULT);
  ok(same(new Game(io)), '渡さなければ既定');
  ok(same(new Game(io, { rules: undefined })), 'undefined なら既定');
  ok(same(new Game(io, { rules: null })), 'null なら既定');

  /* **部分指定は浅くマージ**——将来 state にルール設定が乗ったとき、
     書かれていないキーが既定に落ちないと古いセーブが壊れる */
  const g = new Game(io, { rules: { kuitan: false } });
  eq(g.rules.kuitan, false, '部分指定：書いたキーは効く');
  eq(g.rules.aka, RULES_DEFAULT.aka, '部分指定：書かなかったキーは既定のまま');
  eq(g.rules.ura, RULES_DEFAULT.ura, '部分指定：知らないキーが増えても既定に落ちる');

  eq(RULES_DEFAULT.kuitan, true, '元の RULES_DEFAULT を書き換えていない');

  /* **既定は「理想値」ではなく、いまの engine.js の振る舞い。**
     ここがずれたら、分岐を入れた瞬間に既定のまま挙動が変わる */
  eq(RULES_DEFAULT.aka, 3, '赤は3枚（engine.js の RED_IDS）');
  eq(Engine.isRed(16) && Engine.isRed(52) && Engine.isRed(88), true, 'RED_IDS は 16/52/88');
  eq(RULES_DEFAULT.kuitan, true, '喰いタンあり（断幺九は menzen を見ていない）');
  eq(RULES_DEFAULT.wareme, false, '割れ目は実装していない');

  /* **分岐はまだ一つも無い。**this.rules を読んでいる場所が増えたら、
     そのときこのテストに分岐の錠を足すこと */
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/game.js'), 'utf8');
  const reads = (src.match(/this\.rules\./g) || []).length;
  eq(reads, 0, 'game.js はまだ rules を読んでいない（読み始めたらここに錠を足す）');
}

/* ============================================================
   4. セリフの `call` に鳴きの種類を書かない（src/serifu.js）
   ============================================================ */
{
  /* `call` は**ポン・チー・カンで共有する一つの場面**。種類を名指しすると、
     チーやカンでも「ポン」と言う（実機で出た）。種類は帯（#toast）が出している
     ——情報は帯が持ち、セリフが持つのは人格。二重に言う必要がない。

     `pon` / `chi` / `kan` に分けないこと。19種×3場面ぶん書き足すことになり、
     しかも**チーは上家からしかできない**ので下家と対面のチーは一生使われない */
  const NG = /ポン|チー|カン|槓/;
  const tables = Object.entries(SERIFU.LINES).concat([['（代表）', SERIFU.PLAYER_LINES]]);
  let lines = 0;
  const bad = [];
  tables.forEach(([chara, v]) => {
    ok(Array.isArray(v.call) && v.call.length >= 2, chara + ' の call が二つ以上ある');
    (v.call || []).forEach((t) => { lines++; if (NG.test(t)) bad.push(chara + '「' + t + '」'); });
  });
  eq(bad.length, 0, 'call に鳴きの種類（ポン・チー・カン）が入っていない', bad.join(' / '));
  ok(lines >= 40, 'call の行が数えられている（' + lines + '行）');
  /* 場面を pon / chi / kan に割らないこと（上の理由） */
  tables.forEach(([chara, v]) => {
    ok(!v.pon && !v.chi && !v.kan, chara + ' に pon / chi / kan の場面を作っていない');
  });
}

/* ============================================================
   5. 締めの帯の下に、押せるものを置かない（src/match.css・src/ui.js）
   ============================================================ */
{
  /* **締めの帯の下に、押せるものを置かない**（2026年9月5日）。
     「実機で東1局から対局の最初に戻る」を追っていて見つけた重なり。
     **あの症状の原因ではなかった**（実体は iOS Chrome の再読み込み。BACKLOG.md）が、
     測ってみると踏める形になっていたので直した。

       - 四人卓では #topbar（おまかせ／横画面にする）を**右下**に置いていた
       - 締めの帯は画面の下 132px を覆う。**「おまかせ」は帯の真下にいた**
       - 送りは pointerdown で受けるので、指が離れる前に帯が畳まれる。
         iOS Safari は「押した相手が消えていたら**離した場所にいる相手**」へ
         click を出すので、そのまま「残りをおまかせにしますか」が開き、
         次の一叩きで「早送りで終わらせる」が押される
       - 残りの局が一瞬で消化されて対局が終わる。**一局で終わったように見える**

     直しは二重。**#topbar を上へ**（帯と重ならない）と、
     **送ったあとの click を一回だけ飲む**（ui.js の eatGhostClick）。
     どちらか片方だけにしないこと——上に逃がしても帯の下には手牌が残るし、
     飲むだけでは「見えない釦が下にいる」という形そのものは残る。

     ここで見るのは形だけ。実際に叩いて確かめるのは
     `node tools/drive-match.js --play --width 844 --height 334`（局数と giveUp の錠）。 */
  const fs = require('fs'), path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '../src/match.css'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8');

  const m = css.match(/body\.inMatch\.four #topbar\{([^}]*)\}/);
  ok(!!m, '四人卓の #topbar の置き場所が match.css にある');
  if (m) {
    ok(/top:/.test(m[1]), '四人卓の #topbar は上に着けている（' + m[1].trim() + '）');
    ok(!/bottom:/.test(m[1]),
      '四人卓の #topbar を下に着けていない（帯の真下に「おまかせ」が来る）', m[1].trim());
  }
  ok(/#app\.ending #topbar\{[^}]*pointer-events:none/.test(css),
    '締めのあいだ #topbar は押せない');

  ok(/eatGhostClick\s*\(/.test(ui), 'ui.js に eatGhostClick がある');
  /* 送り（_endAdvance）と同じ行で呼んでいること。呼ばなくなったら幽霊が戻る */
  ok(/this\._endAdvance\(\);\s*this\.eatGhostClick\(\)/.test(ui),
    '帯を送ったら、そのあとの click を一回飲む');
  ok(/document\.addEventListener\('click', eat, true\)/.test(ui),
    '飲むのは capture で受けた click（釦へ届く前に止める）');
}

/* ============================================================
   6. 顔の置き場所（サムネイル。BACKLOG「対局画面のサムネイル化」）

   **大きさで置き場所が分かれる。**24〜36px の丸に 768×1024 を読ませない
   ——展開すると1枚 約3.1MB で、四人卓では顔が最大6枚出る。
   **立ち絵だけは `img/` のまま**（150×196 なので DPR 3 で 450×588 が要る）。

   二本立て（自分は `p01`〜、雀ドルは3桁）を書くのは `faceName` の一行だけ。
   **ここが割れると、自分の顔だけ出なくなる**（前からの錠）
   ============================================================ */
{
  const fs = require('fs'), path = require('path');
  const mj = fs.readFileSync(path.join(__dirname, '../src/match.js'), 'utf8');
  const uj = fs.readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8');
  /* 数えるのは**コメントを外した本文**（仕様の引用に釣られないため。
     `test-scout.js` と同じ作法） */
  const ujBody = uj.replace(/\/\*[\s\S]*?\*\//g, '');

  /* 二本立ては一箇所だけ */
  const name = (mj.match(/const faceName = \(c\) => \([\s\S]*?\);/) || [''])[0];
  ok(/'p01'/.test(name) && /padStart\(3, '0'\)/.test(name),
    'faceName に二本立て（p01〜／3桁）がある', name.replace(/\s+/g, ' '));
  ok((mj.match(/'p01'/g) || []).length === 1,
    "match.js に 'p01' は一度しか出てこない（写していない）");

  /* 小さい版と大きい版 */
  ok(/const faceOf = \(c\) => `img\/\$\{faceName\(c\)\}\.webp`/.test(mj),
    'faceOf は img/（大きく出す場所）');
  ok(/const thumbOf = \(c\) => `thumb\/\$\{faceName\(c\)\}\.webp`/.test(mj),
    'thumbOf は thumb/（小さく出す場所）');

  /* 席とカットインは小さい版、立ち絵だけ大きい版 */
  ok(/g\.players\[i\]\.face = thumbOf\(c\);/.test(mj),
    '席へ配るのは thumbOf（席プレート・カットインが読む）');
  ok(/g\.players\[i\]\.faceBig = faceOf\(c\);/.test(mj),
    '大きい版は faceBig に別で持たせる');
  ok(/class="mzFace"><img src="\$\{esc\(thumbOf\(c\)\)\}"/.test(mj),
    '対局終了の順位表（34px）は thumbOf');
  ok(!/class="mzFace"><img src="\$\{esc\(faceOf\(c\)\)\}"/.test(mj),
    '順位表に faceOf が残っていない');

  /* ui.js 側 */
  ok(/sp\.faceBig \|\| sp\.face/.test(uj),
    '締めの立ち絵だけが faceBig を読む（無ければ face に落ちる）');
  ok((ujBody.match(/faceBig/g) || []).length === 1,
    'ui.js で faceBig を読むのは一箇所だけ（立ち絵）',
    String((ujBody.match(/faceBig/g) || []).length));
  const plate = (ujBody.match(/<span class="bust">[^`]*/) || [''])[0];
  ok(/p\.face \?/.test(plate) && !/faceBig/.test(plate),
    '席プレートは face（小さい版）のまま', plate.replace(/\s+/g, ' ').slice(0, 90));

  /* **再取得を足さないこと。**onerror は消すだけ（--sil-img の影絵に落ちる） */
  ['bust', 'mzFace'].forEach((k) => {
    const src = k === 'bust' ? uj : mj;
    const tag = (src.match(new RegExp('class="' + k + '"><img src="[^>]*>')) || [''])[0]
      || (src.match(new RegExp('class="' + k + '">\\$\\{[^}]*\\}?[^>]*>')) || [''])[0];
    if (tag) {
      ok(/onerror="this\.remove\(\)"/.test(tag), k + ' の img は onerror で消すだけ', tag);
      ok(!/this\.src/.test(tag), k + ' の onerror は src を入れ直さない（再取得しない）', tag);
    }
  });
}

/* ============================================================
   7. おまかせは切り替え（`giveUp` ↔ `takeOver`）

   **入るのに出られない一方通行にしないこと。**おまかせは長い大会を
   流すための機能なのに、押した瞬間にその半荘を手放すことになると
   怖くて押せない。**入るときは確認あり、出るときは確認なし**
   ——出るのは取り上げられた操作を返すだけなので、間違って押しても害が無い
   ============================================================ */
{
  const fs = require('fs'), path = require('path');
  const uj = fs.readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8');
  const mj = fs.readFileSync(path.join(__dirname, '../src/match.js'), 'utf8');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
  const ub = strip(uj), mb = strip(mj);

  /* 逆向きがあること */
  ok(/takeOver\(\)\s*\{/.test(ub), 'ui.js に takeOver がある（おまかせの逆向き）');
  const to = (ub.match(/takeOver\(\)\s*\{[\s\S]*?\n  \},/) || [''])[0];
  ok(/this\.auto = false/.test(to), 'takeOver は auto を倒す');
  ok(/g\.players\[0\]\.isAI = false/.test(to), 'takeOver は players[0].isAI を倒す');
  ok(/if \(!g \|\| !this\.auto\) return/.test(to),
    'おまかせに入っていなければ何もしない', to.replace(/\s+/g, ' ').slice(0, 80));

  /* **速さを戻すこと。**0（早送り）のままだと endAutoMs が 400 を返して
     締めの帯が勝手に流れる（手打ちに戻したのに読む間が無い） */
  const gu = (ub.match(/giveUp\(speed\)\s*\{[\s\S]*?\n  \},/) || [''])[0];
  ok(/this\._preAutoSpeed = this\.speed/.test(gu), 'giveUp は前の速さを控える');
  ok(/this\._preAutoSpeed/.test(to) && /this\.speed = this\._preAutoSpeed/.test(to),
    'takeOver は控えた速さを復す');
  ok(/this\._preAutoSpeed = null/.test(to), 'takeOver は控えを空にする');
  ok(/UI\._preAutoSpeed = null/.test(mb),
    'match.js は対局ごとに控えを空にする（前の半荘の速さを復さない）');

  /* **タイマーを追いかけないこと。**掴んで消す仕掛けを足すと、
     送りの経路が二本になる（M-3） */
  ok(!/clearTimeout/.test(to), 'takeOver は waitEnd のタイマーを掴まない');

  /* 釦は切り替え。消さない */
  ok(!/giveBtn\.remove\(\)/.test(mb), 'おまかせの釦を消していない（切り替えにする）');
  ok(/UI\.auto \? '手打ちに戻る' : 'おまかせ'/.test(mb), '釦の文言が auto で切り替わる');
  ok(/if \(UI\.auto\) \{ UI\.takeOver\(\); syncGive\(\); return; \}/.test(mb),
    '押したら takeOver。**確認のモーダルを挟まない**');
  /* 入るときの確認は残す */
  ok(/おまかせにしますか/.test(mj), '入るときの確認は残っている');
  ok(!/途中でやめることはできません/.test(mj),
    '「途中でやめることはできません」が残っていない（戻せるようになった）');

  /* **`auto` は半荘をまたいで残らない**（match.js が毎回倒す） */
  ok(/UI\.auto = false/.test(mb), 'Match.play の頭で UI.auto を倒す（半荘をまたがない）');

  /* **幽霊クリックの守りがこの経路にも効くこと**（M-2）。
     `eatGhostClick` は capture で document に付いて `stopPropagation` するので、
     `#overlay` の外にある釦には**向きに関係なく**届かない */
  const eat = (ub.match(/eatGhostClick\(ms\)\s*\{[\s\S]*?\n  \},/) || [''])[0];
  ok(/addEventListener\('click', eat, true\)/.test(eat), '幽霊は capture で受ける');
  ok(/e\.stopPropagation\(\)/.test(eat), '幽霊は釦へ届く前に止める');
  ok(/closest\('#overlay'\)/.test(eat) && !/giveup/.test(eat),
    '通すのは #overlay だけ（釦は素通ししない）');
}

/* ============================================================
   8. 卓の寸法は「要るときだけ」測る（`docs/design/match/crash-spec.md` §8）

   **`setInterval` で測り直さないこと。**四人卓のあいだ `--side` /
   `--side-w` / `--felt-y` を毎秒144回書き換えていて、iOS が WebContent を
   落としてページを読み直していた（2026年9月10日・実機で確定）。
   ここは**その見張りが戻ってこないための錠。**
   ============================================================ */
{
  const fs = require('fs'), path = require('path');
  const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const mj = rd('src/match.js'), uj = rd('src/ui.js');
  const mb = strip(mj), ub = strip(uj);

  /* **見張りが無いこと。**`match.js` に `setInterval` を書かない */
  ok(!/setInterval/.test(mb), 'match.js に setInterval が無い（見張りを張らない）');
  ok(!/clearInterval/.test(mb), 'match.js に clearInterval が無い（飲む相手が無い）');

  /* **測り直しは `scheduleFit` を通し、rAF で一フレームへ畳む** */
  ok(/function scheduleFit\(/.test(mb), 'scheduleFit がある');
  const sf = (mb.match(/function scheduleFit\([\s\S]*?\n  \}/) || [''])[0];
  ok(/requestAnimationFrame/.test(sf), 'scheduleFit は requestAnimationFrame を通す');
  ok(/fitRAF !== null\) return/.test(sf), '同じフレームに二本来ても測るのは一度');
  ok(/function cancelFit\(/.test(mb) && /cancelFit\(\)/.test(mb),
    '対局を出るときに畳みかけを捨てる（cancelFit）');

  /* **直に `fitTable()` を呼ぶ所を増やさない。**定義そのものと `scheduleFit`
     の中の一回だけ。ここが増えたら、また連打の形に戻りうる */
  const direct = (mb.match(/(?<!function )\bfitTable\(\)/g) || []).length;
  ok(direct === 1, 'fitTable() を直に呼ぶのは scheduleFit の中だけ（' + direct + '箇所）');

  /* **`ui.js` は `render()` の末尾で `onLayout` を一度だけ呼ぶ。**
     何を測るかは知らない（`match.js` の持ち物） */
  const calls = (ub.match(/this\.onLayout\(/g) || []).length;
  ok(calls === 1, 'ui.js が onLayout を呼ぶのは一箇所（' + calls + '箇所）');
  ok(/this\.onLayout\(\{ changed, kyokuChanged: !sameKyoku, platesChanged \}\)/.test(ub),
    'onLayout に渡すのは changed / kyokuChanged / platesChanged');
  ok(/const sameKyoku =/.test(ub) && /const changed =/.test(ub),
    'changed と sameKyoku は render がもう数えている値（新しく数えない）');
  const render = (ub.match(/\n  render\(\) \{[\s\S]*?\n  \},\n/) || [''])[0];
  ok(/this\.onLayout\(/.test(render), 'onLayout は render() の中にある');
  ok(render.indexOf('this.onLayout(') > render.indexOf('this.pruneNodes('),
    'onLayout は reconcile と pruneNodes のあと（末尾）');
  ok(!/fitTable|scheduleFit|--side/.test(ub), 'ui.js は寸法を知らないまま（何を測るかは match.js）');

  /* **`UI.onLayout` は `handStart` と同じ作法**——頭で入れて終わりで戻す */
  ok(/UI\.onLayout = function/.test(mb), 'match.js が play の頭で UI.onLayout を入れる');
  ok(/UI\.onLayout = null/.test(mb), 'match.js が終わりで UI.onLayout を戻す');
  const hook = (mb.match(/UI\.onLayout = function[\s\S]*?\n    \};/) || [''])[0];
  ok(/kyokuChanged/.test(hook) && /scheduleFit\(\)/.test(hook), '局の変わり目で測り直す');
  ok(/contains\('four'\)[\s\S]*?return;\n      \}\n      if \(info\.changed\) scheduleFit\(\);/.test(hook),
    '並びの変化で測るのは列レイアウトだけ（四人卓の fitFour は河に依存しない）');

  /* ---- 五つ目の機会：席プレートの幅（段B・2026年9月10日） ----

     `fitFour` は左右の席プレートの位置で卓面の幅を縛る。**プレートの幅を
     変えうるものが増えたら、ここで数え漏らしが言われること**——
     `ResizeObserver` のような機構は採らなかったので（「数え上げた機会」と
     「観測されたら」の二本立てになる／`fitFour` が `--side` を書いて
     また観測される形になる）、**数え漏らしを言うのはテストの仕事** */
  ok(/platesChanged/.test(ub), 'ui.js が platesChanged を出す');
  ok(/platesChanged/.test(mb), 'match.js が platesChanged を受ける');
  const sig = (ub.match(/const plateSigs = \[\];[\s\S]*?\n    \}\);/) || [''])[0];
  ok(sig.length > 60, '席プレートの控えが読めた', String(sig.length));
  /* **幅を変えうる印は、控えの元（`plateHTML` の出す HTML）に入っていること。**
     ここに一つ足したら、この行に足すこと */
  const plate = (ub.match(/const plateHTML = \(p\) => `[\s\S]*?`;/) || [''])[0];
  ['rc', 'susp', 'tp', 'pt', 'nm'].forEach((k) => {
    ok(new RegExp('class="' + k).test(plate),
      '幅を変えうる ' + k + ' が席プレートの中にある（控えに入る）');
  });
  const push = (sig.match(/plateSigs\.push\([^\n]*\);/) || [''])[0];
  ok(/plateSigs\.push\(html/.test(push), '控えは plateHTML の出力そのもの（印を数え直さない）');
  ok(/dealer/.test(push), '親の印も控えに入る');
  /* **毎巡・毎セリフで変わるものは入れないこと。**入れると打牌のたびに
     卓を測り直すことになり、消した見張りと同じ形に戻る */
  ['turn', 'talking', 'star'].forEach((k) => {
    ok(!new RegExp(k).test(push), k + ' は控えに入れない（幅を動かさず、毎巡変わる）');
  });
  const hook2 = (mb.match(/UI\.onLayout = function[\s\S]*?\n    \};/) || [''])[0];
  ok(/platesChanged/.test(hook2) && /contains\('four'\)/.test(hook2),
    'プレートの変化で測るのは四人卓だけ');

  /* ---- 装飾の transform を寸法として読まないこと（段B） ----

     `.seat.talking` は `transform:scale(1.07)` の跳ね。`getBoundingClientRect` で
     測ると 1.07 倍に膨らんだ見かけを拾い、セリフのたびに卓が縮んで戻る */
  const four = (mb.match(/function fitFour\([\s\S]*?\n  \}/) || [''])[0];
  const roomFn = (four.match(/const room = \(\)[\s\S]*?\n    \}\);/) || [''])[0];
  ok(roomFn.length > 20, 'room() が読めた', String(roomFn.length));
  ok(/offsetLeft/.test(roomFn) && /offsetWidth/.test(roomFn),
    'room() は席プレートをレイアウト箱で測る（offsetLeft / offsetWidth）');
  ok(!/getBoundingClientRect/.test(roomFn),
    'room() は getBoundingClientRect を使わない（装飾の跳ねを拾う）');
  ok(/function layoutSpan\(/.test(mb) && /layoutSpan\(felt, t\)/.test(mb),
    '卓面のほうは実測のまま（layoutSpan。3D で offsetWidth では測れない）');
  ok(/rotated/.test((mb.match(/function layoutSpan\([\s\S]*?\n  \}/) || [''])[0]),
    'layoutSpan は回転表示で軸を読み替える');

  /* **向き・寸法の経路は残っていること**（見張りを消すだけにしない） */
  ok(/addEventListener\('resize', onOrientationChange\)/.test(mb), 'resize は購読したまま');
  ok(/visualViewport\.addEventListener\('resize', onOrientationChange\)/.test(mb),
    'visualViewport の resize も購読したまま');
  const orient = (mb.match(/function onOrientationChange\([\s\S]*?\n  \}/) || [''])[0];
  ok(/scheduleFit\(\{ toTop: true \}\)/.test(orient), 'onOrientationChange も scheduleFit を通す');
  ok((orient.match(/scheduleFit/g) || []).length === 3,
    '+120ms / +400ms の追い掛けも残っている（そこでしか正しい寸法が返らない端末がある）');
}

/* ============================================================
   9. 右上に置くものは、右側のカットインと重ならないこと
      （docs/design/match/spec.md・2026年9月10日）

   「右上は空いている」は **左側のカットインしか見ていなかった。**
   カットインは `data-side="right"` のとき同じ角に出て、立ち絵のカードは
   `--cw`（縦が広いほど太る）で PC の広い窓では 96px まで育つ。
   **844×334 で釦の高さの92%、1280×800 では 100% を覆っていた。**
   `pointer-events:none` なので押せてはいるが、**そこに釦があると分からない。**

   直しは二重。**釦をカットインより上の層へ**（z-index）と、
   **カットインを釦の下端まで下げる**（top）。片方だけにしないこと
   ——上げるだけだと釦が顔写真の上に乗り、下げるだけだと
   `--cw` が育つ窓で吹き出しが釦へ戻ってくる。

   ここで見るのは形だけ。実際の重なりは
   `node tools/drive-match.js --play --width 844 --height 334` と実機。
   ============================================================ */
{
  const fs = require('fs'), path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '../src/match.css'), 'utf8');

  const zOf = (sel) => {
    const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}'));
    const z = m && m[1].match(/z-index:\s*(-?\d+)/);
    return z ? +z[1] : null;
  };
  const cut = css.match(/body\.inMatch\.four \.cutin\{([^}]*)\}/);
  ok(!!cut, '四人卓の .cutin の置き場所が match.css にある');
  const zTop = zOf('body.inMatch.four #topbar');
  const zCut = cut ? (cut[1].match(/z-index:\s*(-?\d+)/) || [])[1] : null;
  ok(zTop !== null && zCut != null, '#topbar と .cutin のどちらにも z-index がある');
  ok(zTop > +zCut,
    '#topbar はカットインより上の層（topbar ' + zTop + ' > cutin ' + zCut + '）');
  /* #toast（z-index:15）より下であること——おまかせが見出しの上に出ると読めない */
  ok(zTop < 15, '#topbar は #toast（15）より下');

  /* **押せるものは常にカットインより上**（段D・2026年9月10日）。
     鳴きの釦（#actions）も同じ右端を上へ伸びるので、釦が4つを超えると
     カットインの高さに届く。**段Aより前から丸ごと隠れていた**（`spec.md` §6.5 の段D）。
     実際に隠れていないかは `tools/check-auto.js` が画素で見る */
  const zAct = zOf('body.inMatch.four #actions');
  ok(zAct !== null, '四人卓の #actions に z-index がある');
  ok(zAct > +zCut, '#actions はカットインより上の層（actions ' + zAct + ' > cutin ' + zCut + '）');
  ok(zAct < 15, '#actions は #toast（15）より下');
  /* **下へ戻さないこと**——締めの帯の下は「叩いた指の click が落ちる土地」 */
  const act = css.match(/body\.inMatch\.four #actions\{([^}]*)\}/);
  ok(!!act && /bottom:calc\(100% \+ 8px\)/.test(act[1]),
    '#actions は手牌の帯の上に置いたまま（締めの帯の下へ戻さない）', act && act[1].trim());

  const px = (s, k) => { const m = s.match(new RegExp(k + ':\\s*(\\d+(?:\\.\\d+)?)px')); return m ? +m[1] : null; };
  const bar = css.match(/body\.inMatch\.four #topbar\{([^}]*)\}/);
  const barTop = bar ? px(bar[1], 'top') : null;
  const cutTop = cut ? px(cut[1], 'top') : null;
  /* 釦の実測は高さ25px（font-size:11.5px ＋ padding:5px 12px）。
     カードは rotate(2.5deg) で上へ2pxはみ出す。**釦の下端＋2px より下**にいること */
  ok(barTop !== null && cutTop !== null, '#topbar と .cutin の top が px で書いてある');
  ok(cutTop >= barTop + 25 + 2,
    'カットインは「おまかせ」の下端より下から始まる（topbar ' + barTop
    + '+25 / cutin ' + cutTop + '）');

  /* 下げたぶんはカードの高さで返す。左右のプレート（#table の56%）に掛からないよう、
     --cw は画面の高さから引いた値であること。**23vh のままだと 812×320 で食い込む** */
  ok(/--cw:\s*clamp\([^)]*vh/.test(cut ? cut[1] : ''),
    '--cw は画面の高さから作る（clamp に vh が入っている）', cut && cut[1].trim());
  ok(/56vh - 103px/.test(cut ? cut[1] : ''),
    '--cw の高さの budget はプレートの上端から引いてある（56vh − 103px）');

  /* 列レイアウトの .cutin は置き場所が別。四人卓の値を持ち込んでいないこと */
  const col = css.match(/body\.inMatch:not\(\.four\) \.cutin\{([^}]*)\}/);
  ok(!!col && !/position:absolute/.test(col[1]),
    '列レイアウトのカットインは絶対配置にしていない（卓と手牌のあいだの流し込み）');
}

/* ============================================================
   10. 卓の外へ落とす影は、手牌に届かないこと
       （docs/design/match/agari-spec.md §2 の追補・2026年9月10日）

   `#myarea`（手牌の帯）は z-index を持たないので **#table（z-index:3）より下**に
   描かれる。つまり `#felt::before` の外側の影は**手牌の上に塗られる。**
   卓の底と手牌の上端の隙間は **8px（844×334）／9px（1280×800）**しかないのに、
   影は `0 28px 44px` だったので、裾が手牌を丸ごと覆っていた
   （手牌の帯の平均輝度が 21% / 34% 落ちる。実測）。

   ここで見るのは **`落とす量 + ぼかし/2 ≤ 8px`** だけ。
   明るさそのものは `tools/drive-match.js --shots` で撮って測る。
   ============================================================ */
{
  const fs = require('fs'), path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '../src/match.css'), 'utf8');
  const m = css.match(/body\.inMatch\.four #felt::before\{([^}]*)\}/);
  ok(!!m, '四人卓の #felt::before が match.css にある');
  const sh = m ? (m[1].match(/box-shadow:([^;]*);/) || [])[1] : null;
  ok(!!sh, '#felt::before に box-shadow がある');
  if (sh) {
    /* 影は「,」区切り。inset の付いたものは中の縁なので外へは落ちない */
    const outs = sh.split(',')
      .map((t) => t.trim())
      .filter((t) => t && !/^inset/.test(t) && /px/.test(t));
    /* 最後の一本＝外へ落とす影。`0 0 0 3px var(--line)` は枠線（落とす量0） */
    let worst = 0, worstT = '';
    outs.forEach((t) => {
      /* `0 3px 10px` の先頭のように **単位の無い 0** が混じるので、
         `px` で拾わずに空白で割って数だけを順に取る */
      const n = t.split(/\s+/).filter((wd) => /^-?[.\d]/.test(wd)).map(parseFloat);
      if (n.length < 2) return;
      const reach = n[1] + (n[2] || 0) / 2 + (n[3] || 0);  /* 落とす量 ＋ ぼかし/2 ＋ 広げ */
      if (reach > worst) { worst = reach; worstT = t; }
    });
    ok(worst <= 8,
      '外へ落とす影は手牌に届かない（落とす量＋ぼかし/2 ＝ ' + worst + 'px ≤ 8px）', worstT);
    /* 消してしまっていないこと——卓の浮きはこの影が作っている */
    ok(worst > 0, '外へ落とす影を消していない（卓が浮かなくなる）');
    /* 中の縁と枠線は残っていること */
    ok(/inset 0 0 0 7px var\(--rail\)/.test(sh), '内側の縁（rail）は触っていない');
    ok(/inset 0 0 0 10px var\(--line\)/.test(sh), '内側の輪郭は触っていない');
    ok(/inset 0 0 34px/.test(sh), '内側の落ち込みは触っていない');
    ok(/[^t] 0 0 0 3px var\(--line\)/.test(sh), '枠線（0 0 0 3px var(--line)）は触っていない');
  }
  /* 列レイアウトの #felt は display:contents（箱を持たない）ので影も落ちない。
     **この影の話は四人卓だけ**——ここが崩れたら縦持ちも見直すこと */
  ok(/body\.inMatch:not\(\.four\) #felt,[\s\S]{0,120}?\{display:contents\}/.test(css),
    '列レイアウトの #felt は display:contents（影の落ちる箱を持たない）');
}

/* ============================================================
   11. 右は数字、左は言葉（docs/design/match/agari-spec.md §2 の追補・2026年9月10日）

   役名（`.ebYaku`）は `.ebRight`（四人卓で 196px）に増減・合計点と一緒に
   積んでいて、10.5px ＋ `max-height:28px` ＋ `overflow:hidden` だったので、
   **役が多いと黙って切れていた**（混一色ドラ4 で 14px ぶん＝六つのうち三つ）。
   幅の余っている `.ebLeft` へ移して 15px（符の行 16px）にした。

   **溢れたら畳む。**`overflow` で隠すと隠れていることが見えないので、
   三つを超えたら `showEnd` が「ほか N」を置く。**組むのはそこ一箇所。**
   ============================================================ */
{
  const fs = require('fs'), path = require('path');
  const mj = fs.readFileSync(path.join(__dirname, '../src/match.js'), 'utf8');
  const uj = fs.readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/match.css'), 'utf8');

  /* ---- 並び（TABLE_HTML） ---- */
  const left = (mj.match(/<div class="ebLeft">([\s\S]*?)<\/div>\s*<div class="ebRight">/) || [])[1] || '';
  const right = (mj.match(/<div class="ebRight">([\s\S]*?)\n        <\/div>/) || [])[1] || '';
  ok(/class="ebYaku"/.test(left), '.ebYaku は .ebLeft の中（言葉の側）');
  ok(!/class="ebYaku"/.test(right), '.ebRight に .ebYaku を残していない');
  ok(/class="ebDelta"/.test(right) && /class="ebScore"/.test(right),
    '.ebRight は数字だけ（.ebDelta と .ebScore）');
  ok(!/class="ebDelta"/.test(left) && !/class="ebScore"/.test(left),
    '数字を .ebLeft へ持ち込んでいない');

  /* ---- 畳むのは showEnd の一箇所だけ ---- */
  ok((uj.match(/ほか /g) || []).length === 1, '「ほか N」を組むのは ui.js の一箇所だけ');
  ok(!/ほか /.test(mj), 'match.js（TABLE_HTML）には書かない');
  ok(!/content:[^;]*ほか/.test(css), 'match.css の content: で足していない（数が出せない）');
  const se = (uj.match(/showEnd\(kind, data\) \{[\s\S]*?\n  \},/) || [''])[0];
  ok(/ほか /.test(se), '「ほか N」を組んでいるのは showEnd の中');
  ok(/YAKU_SHOWN/.test(se) && /slice\(0, YAKU_SHOWN\)/.test(se),
    '出す数は名前の付いた定数（YAKU_SHOWN）で切っている');
  ok(/const YAKU_SHOWN = 3;/.test(se), '出すのは三つまで');
  /* **並べ替えないこと**——何が畳まれたかが読めなくなる */
  ok(!/yaku\.slice\(\)\.sort|yaku\.sort/.test(uj), '役を並べ替えていない（game.js の順のまま）');

  /* ---- CSS ---- */
  const yk = (css.match(/\nbody\.inMatch \.ebYaku\{([^}]*)\}/) || [])[1] || '';
  const fs2 = (yk.match(/font-size:\s*(\d+(?:\.\d+)?)px/) || [])[1];
  ok(+fs2 >= 14, '役名は 14px 以上（10.5px では読めなかった）', fs2 + 'px');
  const fu = (css.match(/body\.inMatch \.ebYaku \.fu\{([^}]*)\}/) || [])[1] || '';
  ok(!/width:\s*100%/.test(fu),
    '符と翻に width:100% を持たせない（一行に収めて .ebLeft の縦を空ける）');
  /* **`--maru` にしないこと**——役名には `槓` が出るが丸ゴシックに収録が無い */
  ok(!/font-family/.test(yk) && !/font-family/.test(fu),
    '役名の書体を --maru にしていない（槓 が丸ゴシックに無い）');
  /* .ebRight の中の並び（order）は .ebScore と .ebDelta だけの話 */
  ok(!/scoreLead \.ebYaku\{[^}]*order/.test(css),
    'scoreLead に .ebYaku の order を残していない（もう .ebRight の子ではない）');
  ok(/scoreLead \.ebScore\{[^}]*order:1/.test(css) && /scoreLead \.ebDelta\{[^}]*order:2/.test(css),
    'scoreLead の並び（合計点が先、増減が後）は残っている');
  /* **言葉は縮ませない。**縮んでよいのは牌の並びだけ */
  ok(/body\.inMatch \.ebHead,body\.inMatch \.ebLine,body\.inMatch \.ebDora,body\.inMatch \.ebYaku\{flex:none\}/.test(css),
    '見出し・セリフ・ドラ・役名は縮まない（flex:none）');
  /* **--ebh は変えない**（高くすると卓が縮む） */
  ok(/--ebh:132px/.test(css) && /body\.inMatch:not\(\.four\)\{--ebh:168px\}/.test(css),
    '--ebh は 132px / 168px のまま');
}

/* ============================================================
   §12 対局の外の音（`src/ui-sound.js`。spec.md §2.7）

   **画面ごとに `Sound.play` を書き足さないための錠。**
   対局の外はぜんぶ無音だったので、`document` に委譲の listener を
   一つだけ置いた。散らすと、押し忘れと、**Node で落ちる**危険が出る。

     (A) 釦の音 … `tap`。ブラウザで押す側は `tools/check-tap.js`
     (B) 営業中の店の牌の音 … `discard` / `draw` をまばらに。
         上限は `FLOOR_MAX_PER_SEC` **一箇所**。実測は `tools/check-floor-sound.js`

   ここは形だけ。
   ============================================================ */
{
  const fs = require('fs'), path = require('path');
  const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const us = rd('src/ui-sound.js');
  const ub = strip(us);

  /* **委譲は一本。**`document` に置く listener はここだけ */
  ok((ub.match(/document\.addEventListener\(/g) || []).length === 1,
    'ui-sound.js が document に置く listener は一つだけ');
  ok(/'pointerdown'/.test(ub), '拾うのは pointerdown（click ではない）');

  /* **`Sound.play('tap')` を書くのは一箇所。**
     `ui.js` の `UI.buttons`（対局中の釦）と `taikai.js` の音量の見本は
     「対局の外の釦」ではないので、別の口として数に入れない */
  ok((ub.match(/Sound\.play\('tap'\)/g) || []).length === 1,
    '**tap を鳴らすのは ui-sound.js の一行だけ**');
  /* 鳴らす口は二つだけ（釦の tap と、営業中の牌）。増やすときは spec に書くこと */
  ok((ub.match(/Sound\.play\(/g) || []).length === 2,
    'ui-sound.js が Sound.play を呼ぶのは二箇所（tap と 営業の牌）');

  /* ---- (B) 営業中の店の牌の音 ---- */
  /* **上限は一箇所の定数。**倍速で機械銃にならないための唯一の栓 */
  ok((ub.match(/FLOOR_MAX_PER_SEC/g) || []).length === 3,
    'FLOOR_MAX_PER_SEC は定義1・使用1・export1 の三回だけ（数を散らさない）');
  ok(/const FLOOR_MAX_PER_SEC = \d+;/.test(ub), 'FLOOR_MAX_PER_SEC は定数として一度だけ書く');
  const fl = (ub.match(/function floor\([\s\S]*?\n  \}/) || [''])[0];
  ok(/FLOOR_MAX_PER_SEC \/ Math\.max\(1, speed/.test(fl),
    '**倍速のときは減らす**（上限を速さで割る）');
  ok(/document\.hidden/.test(fl), 'タブが隠れているあいだは鳴らさない');
  ok(/FLOOR_SOUND\[kind\]/.test(fl) && /if \(!name\) return false/.test(fl),
    '表に無い節目では鳴らさない（FLOOR_SOUND がすべて）');
  /* **新しい音源は足していない。**使うのは既存の13本のうち二つだけ。
     **`src/sound.js` も `src/ui-sound.js` も require しない**
     ——ここで読むと下の SOUND_REFS の数え上げに自分で名前を足すことになる
     （`ui-sound.js` は読んだ瞬間に document を触って落ちる。実際に落とした） */
  const fs2 = strip(rd('src/sound.js'));
  const nm = (fs2.match(/const NAMES = \[([^\]]*)\]/) || [, ''])[1];
  ok(/'discard'/.test(nm) && /'draw'/.test(nm),
    '当てた二つは Sound.NAMES にある（新しい音源を足していない）');
  ok(/arrive: 'draw'/.test(ub) && /pay: 'discard'/.test(ub),
    '営業で鳴らすのは arrive→draw と pay→discard');
  ok(!/FLOOR_SOUND = \{[^}]*(agari|riichi|ryuukyoku|deal|dora|call|tap)/.test(ub),
    '営業に和了・リーチ・流局などを当てていない（音の性格が違う）');

  /* **時計を増やさない。**四人卓で落ちた件と同じ土地 */
  ok(!/setInterval|setTimeout|requestAnimationFrame/.test(ub),
    'ui-sound.js は時計を持たない（営業の進行に相乗りしている）');

  /* **除きかたは一箇所（`muted`）で決める。**画面ごとに条件を散らさない */
  ok(/function muted\(/.test(ub), '除きかたは muted() 一つ');
  const mu = (ub.match(/function muted\([\s\S]*?\n  \}/) || [''])[0];
  ok(/inMatch/.test(mu), 'muted() が body.inMatch を見る（tap と discard の二重を避ける）');
  ok(/data-nosound/.test(mu), 'muted() が [data-nosound] を見る（逃げ道）');
  ok((ub.match(/inMatch/g) || []).length === 1,
    'inMatch を見るのは muted() の中だけ（分岐を増やさない）');

  /* **初期化はここで前に出す。**いままでは大会の「卓に着く」だけが解除の口で、
     表紙から入って事務所を触っても AudioContext が無かった。**二度目は呼ばない** */
  ok(/Sound\.init\(\)/.test(ub) && /Sound\.load\(\)/.test(ub),
    '最初の pointerdown で init と load を呼ぶ');
  ok(/if \(started\) return;/.test(ub), '二度目からは呼ばない（started の錠）');

  /* ---- 呼ぶ側（`src/jansou-floor.js` の再生層） ----
     **あちらは Node から読まれている**ので、`Sound` を書いてはいけない。
     書けるのは `UiSound` を「あれば使う」一行だけ */
  const jf = strip(rd('src/jansou-floor.js'));
  ok(!/\bSound\b/.test(jf), '**jansou-floor.js に Sound の参照が無い**（Node で読まれる）');
  ok((jf.match(/UiSound\.floor\(/g) || []).length === 1,
    'UiSound.floor を呼ぶのは一箇所だけ');
  ok(/typeof UiSound !== 'undefined'/.test(jf), "UiSound は「あれば使う」（typeof で守る）");
  /* **スキップ中は合図も出さない。**skip は一フレームで残りを全部飲み干す */
  ok(/!live\.skipping && typeof UiSound !== 'undefined'/.test(jf),
    '**スキップ中は合図を出さない**（一フレームで数百本ぶんが飛ぶ）');
  ok(/UiSound\.floor\(e\.kind, live\.speed\)/.test(jf),
    '節目の種類と速さを渡す（policy は ui-sound.js 側）');

  /* **build.py に入っていること。**入れ忘れると index.html で一度も読まれない */
  const bp = rd('build.py');
  ok(/'ui-sound\.js'/.test(bp), "build.py の JS に 'ui-sound.js' がある");

  /* **音量は起動時に入れる。**落とすと、音量0にしていても釦だけ既定の1で鳴る */
  ok(/Sound\.volume\(state\.sfxVolume\)/.test(strip(rd('shell.html'))),
    'shell.html が起動時に Sound.volume(state.sfxVolume) を入れる');

  /* ------------------------------------------------------------
     **Node から読まれるモジュールに Sound の参照を増やさないこと。**
     `tools/*.js` が require している src は、参照した瞬間に
     ヘッドレスで落ちうる（`typeof` で守れば落ちないが、
     守り忘れが効くのは実行するまで分からない）。**数で固定する。**

     いま Sound を見てよいのは二つだけ。
       ui.js    … 対局の io 層（spec.md §2.3）
       taikai.js … 音量の設定と「卓に着く」の解除。どれも typeof で守ってある
     `ui-sound.js` は**どの tools からも require されていない**ので、
     この表に出てこないのが正しい
     ------------------------------------------------------------ */
  const SOUND_REFS = { 'ui.js': 2, 'taikai.js': 13 };
  const mods = new Set();
  fs.readdirSync(path.join(__dirname)).filter((f) => f.endsWith('.js')).forEach((f) => {
    const t = fs.readFileSync(path.join(__dirname, f), 'utf8');
    (t.match(/require\(['"]\.\.\/src\/[a-z-]+\.js['"]\)/g) || [])
      .forEach((m) => mods.add(m.match(/src\/([a-z-]+\.js)/)[1]));
  });
  ok(mods.size > 15, 'tools が require している src を数え上げられた（' + mods.size + '本）');
  ok(!mods.has('ui-sound.js'),
    '**ui-sound.js はどの tools からも require されていない**（document を直に触ってよい根拠）');
  [...mods].sort().forEach((m) => {
    const n = (strip(rd('src/' + m)).match(/\bSound\b/g) || []).length;
    ok(n === (SOUND_REFS[m] || 0),
      'Node から読まれる ' + m + ' の Sound の参照は ' + (SOUND_REFS[m] || 0) + '（got ' + n + '）');
  });
}

/* ---------------- 結果 ---------------- */
console.log('対局まわりの純関数テスト');
console.log('通過 ' + pass + ' 件' + (fails.length ? ' / 失敗 ' + fails.length + ' 件' : ''));
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('すべて通過');
