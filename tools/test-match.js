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

/* ---------------- 結果 ---------------- */
console.log('対局まわりの純関数テスト');
console.log('通過 ' + pass + ' 件' + (fails.length ? ' / 失敗 ' + fails.length + ' 件' : ''));
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('すべて通過');
