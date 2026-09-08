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
   §4.1 罠 — `root` の `data-tier` と大会選択の釦が同じ名前
------------------------------------------------------------ */
ok(/closest\('button\[data-tier\]'\)/.test(BODY),
  'click は button[data-tier] で拾う（§4.1。root に当たると start が走る）');
ok(!/closest\('\[data-tier\]'\)/.test(BODY), "closest('[data-tier]') が残っていない");
ok(/root\.dataset\.tier = prepared\.tierId/.test(BODY), '出走表に data-tier が付く');
ok((BODY.match(/root\.dataset\.tier = run\.tierId/g) || []).length === 2,
  '進行と結果の二画面にも data-tier が付く（§4）');
ok(/delete root\.dataset\.tier/.test(BODY), '大会選択に戻るときは data-tier を外す');

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
const prizeBig = (CSS.match(/\.tkPrizeBig b\{[^}]*\}/) || [''])[0];
ok(/var\(--gold\)/.test(prizeBig), '賞金は var(--gold)', prizeBig);
ok(!/--tk-accent/.test(prizeBig), '賞金に --tk-accent を使っていない', prizeBig);

/* ------------------------------------------------------------
   §8 触らないもの／新しいクラスは tk で始める
------------------------------------------------------------ */
['.tkGroup{', '.tkGroupT{', '.tkNames{', '.tkName{'].forEach((sel) => {
  ok(CSS.indexOf(sel) >= 0, '⑤ の ' + sel + ' が残っている');
});
{
  /* `taikai.css` が定義するクラスは全部 `tk` で始まること
     （CSSはページ全体で一つの名前空間しかない） */
  const bad = Array.from(new Set((CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/\.[A-Za-z_][\w-]*/g) || []).map((s) => s.slice(1))))
    .filter((c) => !/^tk/.test(c) && !/^(last|mine|own|locked|p[1-4])$/.test(c));
  same(bad, [], '新しいクラスは全部 tk で始まる');
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
