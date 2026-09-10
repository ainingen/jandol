#!/usr/bin/env node
/*
  出走表（`docs/design/taikai/field-spec.md`）の錠

    node tools/test-taikai-field.js

  ここに書くのは **DOMに触らない側だけ**。`renderField()` そのものは
  ブラウザで確かめる（§9 の各段のスクリーンショット）。
  見るのは純関数二つ（`ladderOf` / `pickSpotlight`）と、
  **本文を機械的に読んで固定する錠**（§10）。
*/
'use strict';

const fs = require('fs');
const path = require('path');
const chars = require('../src/characters.js');
Object.assign(global, {
  JANDOLS: chars.JANDOLS, FREE_AGENTS: chars.FREE_AGENTS, STYLES: chars.STYLES,
  PLAYER: chars.PLAYER, REGIONS: chars.REGIONS, RANK_INFO: chars.RANK_INFO,
  CONTRACTS: chars.CONTRACTS, popOf: chars.popOf,
});
const T = require('../src/tournament.js');
Object.assign(global, T);
const Taikai = require('../src/taikai.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'taikai.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'taikai.css'), 'utf8');
/* 錠は**コメントを外した本文**で見る。仕様の引用がコメントに入っているので、
   そのまま探すと「書いてある」ことになってしまう（`test-scout.js` と同じ作法） */
const BODY = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  … ' + detail : ''));
}
const J = (v) => JSON.stringify(v);
function same(a, b, name) { ok(J(a) === J(b), name, 'got ' + J(a) + ' / want ' + J(b)); }

/* ------------------------------------------------------------
   §5 勝ち上がりの梯子 — **人数から作る**
------------------------------------------------------------ */
same(Taikai.ladderOf(16), ['16名', '4卓', '決勝卓'], '梯子 16人');
same(Taikai.ladderOf(64), ['64名', '16卓', '4卓', '決勝卓'], '梯子 64人');
same(Taikai.ladderOf(4), ['4名', '決勝卓'], '梯子 4人（もう決勝卓）');
same(Taikai.ladderOf(256), ['256名', '64卓', '16卓', '4卓', '決勝卓'], '梯子 256人');

/* いま定義されている五つの大会が、全部まっとうな梯子になること
   ——`size` を変えたときにここで落ちる */
Object.keys(global.TOURNAMENTS).forEach((id) => {
  const t = global.TOURNAMENTS[id];
  const l = Taikai.ladderOf(t.size);
  ok(l[0] === t.size + '名', '梯子の頭が人数（' + id + '）', J(l));
  ok(l[l.length - 1] === '決勝卓', '梯子の尻が決勝卓（' + id + '）', J(l));
  ok(l.every((s) => !/\./.test(s)), '卓数に端数が出ない（' + id + '）', J(l));
  /* 卓数は「一つ前の人数 ÷ 4」。**書き写していないこと**を数で見る */
  ok(l.length === Math.round(Math.log(t.size) / Math.log(4)) + 1,
    '段数が人数から出ている（' + id + '）', J(l));
});

/* ------------------------------------------------------------
   §3 注目の三人 — 因縁 → 強さ
------------------------------------------------------------ */
{
  const pool = global.JANDOLS.concat(global.FREE_AGENTS);
  const pick = (ids) => ids.map((id) => pool.find((c) => c.id === id));
  const byStrength = (list) => list.slice()
    .sort((a, b) => (global.strengthOf(b, global.STYLES) - global.strengthOf(a, global.STYLES))
      || (a.id - b.id));
  const ids = (r) => r.map((x) => x.chara.id);
  const whys = (r) => r.map((x) => x.why);

  /* 顔ぶれ。自分（0）＋仲間3人＋よそ10人 */
  const team = [67, 70, 73];
  const others = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const field = [Object.assign({}, global.PLAYER)].concat(pick(team)).concat(pick(others));

  /* --- 因縁が三人いるとき --- */
  {
    const st = { team, recent: [5, 3, 9, 1], beaten: [] };
    const r = Taikai.pickSpotlight(field, st);
    same(ids(r), [5, 3, 9], '因縁が三人 … recent の先頭から三人');
    same(whys(r), ['grudge', 'grudge', 'grudge'], '因縁が三人 … 三人とも因縁枠');
  }
  /* --- 因縁が一人だけのとき（残りは強さ順で埋まる） --- */
  {
    const st = { team, recent: [7], beaten: [] };
    const r = Taikai.pickSpotlight(field, st);
    ok(r[0].chara.id === 7 && r[0].why === 'grudge', '因縁が一人 … 先頭は因縁枠', J(ids(r)));
    same(whys(r), ['grudge', 'strong', 'strong'],
      '因縁が一人 … 残りは強さ枠（大本命は付かない）');
    const rest = byStrength(pick(others).filter((c) => c.id !== 7)).slice(0, 2).map((c) => c.id);
    same(ids(r).slice(1), rest, '因縁が一人 … 残りは強さの降順');
  }
  /* --- 因縁が一人もいないとき（初回） --- */
  {
    const r = Taikai.pickSpotlight(field, { team, recent: [], beaten: [] });
    /* **一人目だけ「大本命」。**「優勝候補」が三つ並ぶと平らに見えて、
       目が止まる場所が無い（実機で見た） */
    same(whys(r), ['top', 'strong', 'strong'], '因縁ゼロ … 一人目だけ大本命');
    same(ids(r), byStrength(pick(others)).slice(0, 3).map((c) => c.id),
      '因縁ゼロ … 強さの降順（並びは変わらない）');
  }
  /* --- 因縁が一人でもいれば「大本命」は付けない --- */
  {
    const r = Taikai.pickSpotlight(field, { team, recent: [7], beaten: [] });
    ok(whys(r).indexOf('top') < 0,
      '因縁が一人でもいれば大本命は付けない（強い言葉を二つ出さない）', J(whys(r)));
  }
  {
    const r = Taikai.pickSpotlight(field, { team, recent: [5, 3, 9], beaten: [] });
    ok(whys(r).indexOf('top') < 0, '因縁が三人なら大本命は付けない', J(whys(r)));
  }
  /* --- 相手が一人しかいなくても落ちない --- */
  {
    const one = [Object.assign({}, global.PLAYER)].concat(pick([1]));
    same(whys(Taikai.pickSpotlight(one, { team: [] })), ['top'], '一人だけなら大本命');
    same(Taikai.pickSpotlight([], { team: [] }), [], '誰もいなければ空のまま');
  }
  /* --- 一度勝った相手は因縁枠にしない（beaten は消えない） --- */
  {
    const st = { team, recent: [5, 3, 9], beaten: [5, 9] };
    const r = Taikai.pickSpotlight(field, st);
    ok(r[0].chara.id === 3 && r[0].why === 'grudge',
      'beaten の相手は因縁枠にしない', J(ids(r)));
    ok(ids(r).slice(1).indexOf(5) < 0 || whys(r)[ids(r).indexOf(5)] === 'strong',
      'beaten の相手が因縁枠で戻ってこない', J(whys(r)));
  }
  /* --- 自事務所は入れない --- */
  {
    const st = { team, recent: [67, 0, 70, 5], beaten: [] };
    const r = Taikai.pickSpotlight(field, st);
    ok(r.every((x) => [0, 67, 70, 73].indexOf(x.chara.id) < 0),
      '自事務所は注目に入れない', J(ids(r)));
    ok(r[0].chara.id === 5, '自事務所を飛ばして次の因縁が来る', J(ids(r)));
  }
  /* --- 出走していない相手は因縁枠にならない --- */
  {
    const st = { team, recent: [999, 5], beaten: [] };
    const r = Taikai.pickSpotlight(field, st);
    ok(r[0].chara.id === 5, '出走表にいない recent は飛ばす', J(ids(r)));
  }
  /* --- 同じ子を二度入れない（recent が重複していても） --- */
  {
    const st = { team, recent: [5, 5, 5], beaten: [] };
    const r = Taikai.pickSpotlight(field, st);
    same(ids(r).filter((id) => id === 5).length, 1, 'recent の重複で二枠を食わない');
    same(r.length, 3, '重複しても三人そろう');
  }
  /* --- field の重複（buildField の dup）で二重にならない --- */
  {
    const dup = field.concat(pick([5]).map((c) => Object.assign({}, c, { dup: true })));
    const r = Taikai.pickSpotlight(dup, { team, recent: [], beaten: [] });
    same(ids(r).length, new Set(ids(r)).size, 'field の dup で同じ子が二枠に出ない');
  }
  /* --- n を超えない／n を変えられる --- */
  same(Taikai.pickSpotlight(field, { team }, 1).length, 1, 'n = 1');
  same(Taikai.pickSpotlight(field, { team }, 5).length, 5, 'n = 5');
  same(Taikai.pickSpotlight(field, { team }).length, 3, 'n の既定は 3');
  /* --- 人数が足りないときは足りないなりに返す --- */
  {
    const tiny = [Object.assign({}, global.PLAYER)].concat(pick([1, 2]));
    same(Taikai.pickSpotlight(tiny, { team: [] }).length, 2, '相手が二人しかいなければ二人');
    same(Taikai.pickSpotlight([], { team: [] }).length, 0, '相手がいなければ空');
  }
  /* --- st が空でも落ちない（単体ページ・新規セーブ） --- */
  {
    const r = Taikai.pickSpotlight(field, {});
    same(r.length, 3, 'st が空でも三人');
    ok(r.every((x) => x.chara.id !== 0), 'st が空でも自分は入らない', J(ids(r)));
    same(Taikai.pickSpotlight(field, null).length, 3, 'st が null でも落ちない');
    same(Taikai.pickSpotlight(null, {}).length, 0, 'field が null でも落ちない');
  }
  /* --- 同じ入力なら同じ並び（強さが同じなら id で固定） --- */
  {
    const st = { team, recent: [], beaten: [] };
    const a = ids(Taikai.pickSpotlight(field, st));
    const b = ids(Taikai.pickSpotlight(field.slice().reverse(), st));
    same(a, b, '並べ替えても同じ三人（同点は id で固定）');
  }
}

/* ------------------------------------------------------------
   §4.1 罠 — `root` の `data-tier` と大会選択の釦が同じ名前
------------------------------------------------------------ */
ok(/closest\('button\[data-tier\]'\)/.test(BODY),
  'click は button[data-tier] で拾う（§4.1。root に当たると start が走る）');
ok(!/closest\('\[data-tier\]'\)/.test(BODY), "closest('[data-tier]') が残っていない");
ok(/root\.dataset\.tier = prepared\.tierId/.test(BODY), '出走表に data-tier が付く');
ok((BODY.match(/root\.dataset\.tier = run\.tierId/g) || []).length === 2,
  '進行と結果の二画面にも data-tier が付く（§4）');
ok(/delete root\.dataset\.tier/.test(BODY), '大会選択に戻るときは data-tier を外す');

/* `why` の三つに、画面側の文面が揃っていること。
   **足したのに文面を足し忘れると、札が空で出る** */
{
  const why = (BODY.match(/const WHY = \{[\s\S]*?\};/) || [''])[0];
  ['grudge', 'top', 'strong'].forEach((k) => {
    ok(new RegExp(k + ':').test(why), 'WHY に ' + k + ' の文面がある', why);
  });
  ok(/大本命/.test(why), '大本命の札がある', why);
  ok(!/当たります/.test(BODY),
    '「この中の誰かと当たります」とは書かない（卓割りはまだ決まっていない）');
}

/* ------------------------------------------------------------
   §6 入場の演出 — 後片づけは一箇所（`clearEntrance`）
------------------------------------------------------------ */
/* **札を落とすだけの行を残さないこと。**`pointerdown` の見張りも一緒に
   外さないと、大会選択へ戻ってから最初のタップで `.tkSkip` が付く */
ok(/function clearEntrance\(\)/.test(BODY), '演出の後片づけは clearEntrance 一つ');
ok(/removeEventListener\('pointerdown', skipEnter\)/.test(
  (BODY.match(/function clearEntrance\(\)\s*\{[\s\S]*?\n    \}/) || [''])[0]),
  'clearEntrance が見張りも外す');
{
  /* 出走表を出る三つの画面が、全部 `clearEntrance()` を通っていること */
  ['renderSelect', 'renderRounds', 'renderResult'].forEach((fn) => {
    const body = (BODY.match(new RegExp('function ' + fn
      + '\\(\\)\\s*\\{[\\s\\S]*?\\n      const ')) || [''])[0];
    ok(/clearEntrance\(\)/.test(body), fn + ' が clearEntrance を通る');
  });
  /* 生の `classList.remove` が残っていないこと（外し忘れの再発を止める） */
  const bare = (BODY.match(/root\.classList\.remove\('tkEnter'/g) || []).length;
  ok(bare === 1, "classList.remove('tkEnter') は clearEntrance の中だけ", String(bare));
}

/* ------------------------------------------------------------
   §4 大会ごとの色 — 五つとも変数がある／賞金は金のまま
------------------------------------------------------------ */
Object.keys(global.TOURNAMENTS).forEach((id) => {
  ok(new RegExp('\\.tkRoot\\[data-tier="' + id + '"\\]').test(CSS),
    '--tk-accent が定義されている（' + id + '）');
});
ok(/\.tkRoot\{--tk-accent:/.test(CSS), '既定の --tk-accent が .tkRoot にある');
/* **賞金は大会によらず金**（§4）。`.tkPrizeBig b` の色が accent だと、
   お金の色という意味が壊れる */
/* **見出し帯のバッジも大会の色**（§4）。罫だけ変えると同じ帯の中で
   二つの色が別のことを言う */
const stat = (CSS.match(/\.tkStat\{[^}]*\}/) || [''])[0];
ok(/border:1px solid var\(--tk-accent-dim\)/.test(stat), 'バッジの枠は --tk-accent-dim', stat);
ok(!/--gold/.test(stat), 'バッジに --gold の直書きが残っていない', stat);
/* **釦は金のまま**（動作の色。大会の格とは別の軸） */
const goBtn = (CSS.match(/\.tkGo\{[^}]*\}/) || [''])[0];
ok(/var\(--gold\)/.test(goBtn), '釦は var(--gold) のまま', goBtn);
ok(!/--tk-accent/.test(goBtn), '釦に --tk-accent を使っていない', goBtn);

const prizeBig = (CSS.match(/\.tkPrizeBig b\{[^}]*\}/) || [''])[0];
ok(/var\(--gold\)/.test(prizeBig), '賞金は var(--gold)', prizeBig);
ok(!/--tk-accent/.test(prizeBig), '賞金に --tk-accent を使っていない', prizeBig);

/* ------------------------------------------------------------
   §7 顔の置き場所（サムネイル）

   **カードは `thumb/`（176×234）を読む。**88px の枠に 768×1024 を
   流し込むと、展開したぶん（1枚 約3.1MB）が積み上がって実機で落ちる
   （`H`）。焼くのは `tools/make-thumbs.py`。
   **名鑑と表紙は `img/` のまま**——大きく出す場所なので縮めない
------------------------------------------------------------ */
{
  const face = (BODY.match(/const faceOf = \(c\) => \([^;]*;/) || [''])[0];
  ok(face.length > 20, 'faceOf が読めた', String(face.length));
  ok(!/img\//.test(face), 'カードの faceOf は img/ を読まない（thumb/ を読む）', face);
  same((face.match(/thumb\//g) || []).length, 2,
    'faceOf の二本（自分と雀ドル）が両方とも thumb/');
  /* **二本立てを崩さないこと**（自分は `p01`〜、雀ドルは3桁）。
     置き場所だけが `match.js` と違う */
  ok(/'p01'/.test(face) && /pad3\(c\.id\)/.test(face),
    '二本立て（p01〜／3桁）はそのまま', face);
  /* `taikai.js` が顔を出すのはカードだけ。ほかに `img/` を書き足していないこと */
  ok(!/img\/\$\{/.test(BODY), 'taikai.js の本文に img/ の直書きが無い');
  /* **再取得を足さないこと**（`--sil-img` の落とし口はそのまま）。
     `onerror` は「消す」だけで、別の src を入れ直さない */
  const imgTag = (SRC.match(/<img src="\$\{esc\(faceOf\(c\)\)\}"[^>]*>/) || [''])[0];
  ok(/onerror="this\.remove\(\)"/.test(imgTag), 'カードの img は onerror で消すだけ', imgTag);
  ok(!/this\.src/.test(imgTag), 'onerror で src を入れ直していない（再取得しない）', imgTag);
  /* **名鑑と表紙は `img/` のまま**（大きく出す場所） */
  const big = ['meikan.js', 'title.js'];
  big.forEach((n) => {
    const t = fs.readFileSync(path.join(__dirname, '..', 'src', n), 'utf8');
    ok(/img\//.test(t), n + ' は img/ を読んだまま（大きく出す場所）');
    ok(!/thumb\//.test(t), n + ' は thumb/ を読まない');
  });
}

/* ------------------------------------------------------------
   §8 触らないもの／新しいクラスは tk で始める
------------------------------------------------------------ */
['.tkGroup{', '.tkGroupT{', '.tkNames{', '.tkName{'].forEach((sel) => {
  ok(CSS.indexOf(sel) >= 0, '⑤ の ' + sel + ' が残っている');
});
{
  /* `taikai.css` の**組の先頭に来るクラスは全部 `tk` で始まる**こと。
     CSSはページ全体で一つの名前空間しかないので、`tk` の付かない名前を
     単独で使うと他の画面に漏れる。`.tkCond.cm2` のように **`tk` の付いた
     クラスに重ねる**のはよい——単独では効かないので漏れようがない
     （`office.css` の `.ofCond.cm2` と同じ作法）。
     見るのはコメントを外した本文（仕様の引用に釣られないため） */
  const cssBody = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const bad = Array.from(new Set(
    (cssBody.match(/(^|[\s,>+~(])\.[A-Za-z_][\w-]*/gm) || [])
      .map((s2) => s2.replace(/^[^.]*\./, ''))
  )).filter((c) => !/^tk/.test(c));
  same(bad, [], '組の先頭に来るクラスは全部 tk で始まる');
}

/* ------------------------------------------------------------ */
console.log('出走表（taikai/field-spec.md）');
if (fails.length) {
  console.log(pass + ' 件通過、' + fails.length + ' 件失敗');
  fails.forEach((f) => console.log('  × ' + f));
  process.exit(1);
}
console.log(pass + ' 件通過');
console.log('すべて通過');
