#!/usr/bin/env node
/*
  プロローグの錠（`docs/design/title/prologue-spec.md` §9）

    node tools/test-prologue.js

  ここに書くのは **DOMに触らない側だけ**。覆いの振る舞い（出る／出ない、
  押したら進む、とばす、閉じたあと canvas が生きている）は
  `tools/drive-prologue.js` がブラウザで見る。

  §9 の 1〜3 が本体：

    1. `PROLOGUE` が空でない配列の配列で、**どの画面も5行以下**
    2. **最後の画面の最後の行が `Title.SUBTITLE` と対**
    3. 本文に**算用数字が無い**（人数を書かないの機械的な確認）

  そのうえで、仕様が「やらない」と決めたことを本文から機械的に見る
  （§5・§10）——`localStorage` も `Sound` も触らないこと、
  行を `innerHTML` で組まないこと、`title.js` がセーブに
  「見たか」を書いていないこと、`build.py` に並んでいること。
*/
'use strict';

const fs = require('fs');
const pathm = require('path');
const rd = (f) => fs.readFileSync(pathm.join(__dirname, '..', f), 'utf8');
/* 錠は**コメントを外した本文**で見る（仕様の引用に釣られないため。
   `test-taikai-round.js` と同じ作法） */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const { PROLOGUE, Prologue } = require('../src/prologue.js');
const Title = require('../src/title.js');

const PL = strip(rd('src/prologue.js'));
const PLCSS = rd('src/prologue.css');
const TT = strip(rd('src/title.js'));
const BUILD = rd('build.py');
const SHELL = rd('shell.html');

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  … ' + detail : ''));
}
const J = (v) => JSON.stringify(v);
function eq(a, b, name) { ok(a === b, name, 'got ' + J(a) + ' / want ' + J(b)); }

/* ============================================================
   1. 形（§9-1）
   ============================================================ */
ok(Array.isArray(PROLOGUE), 'PROLOGUE は配列');
ok(PROLOGUE.length > 0, 'PROLOGUE は空でない');
PROLOGUE.forEach((page, i) => {
  ok(Array.isArray(page), '第' + (i + 1) + '画面は配列');
  ok(page.length > 0, '第' + (i + 1) + '画面は空でない');
  /* **一画面は5行まで。**334px（iOS の横持ち）で読める上限。
     spec §6 の高さの実測がこの前提で立っている */
  ok(page.length <= 5, '第' + (i + 1) + '画面は5行以下',
    page.length + '行');
  page.forEach((line, j) => {
    ok(typeof line === 'string' && line.length > 0,
      '第' + (i + 1) + '画面の' + (j + 1) + '行目は空でない文字列');
  });
});

/* ============================================================
   2. 最後の一行は副題と対（§9-2 / §2）
   ============================================================ */
const lastPage = PROLOGUE[PROLOGUE.length - 1];
const lastLine = lastPage[lastPage.length - 1];
/* **完全一致で見る。**対にしているのは「副題を変えたらここも変わる」を
   機械で捕まえるためなので、比較に例外を置かない——例外の幅だけ
   捕まえ損ねる。**本文でここだけ句点を打たない**のはそのため
   （副題は看板なので句点を持たない）。
   本文を直すときは `Title.SUBTITLE` も一緒に動かすこと（spec §2）。 */
eq(lastLine, Title.SUBTITLE, '最後の一行は副題と一致する');

/* ============================================================
   3. 本文に算用数字が無い（§9-3 / §2「人数を書かない」）
   ============================================================ */
const body = PROLOGUE.map((p) => p.join('')).join('');
const digits = body.match(/[0-9０-９]/g) || [];
eq(digits.join(''), '', '本文に算用数字が無い');
/* 「八人」は漢数字なので通る。雀エイトの定義なので、これだけは固定 */
ok(body.indexOf('八人') >= 0, '「八人」は残っている（雀エイトの定義）');

/* ============================================================
   4. 名前を出さない（§2）
   ============================================================ */
/* 設定画面はこのあとなので、名前はまだ決まっていない。
   既定の名前がそのまま出ていないことだけ、機械的に見る */
ok(body.indexOf(Title.DEFAULT_NAME) < 0, '本文に既定の名前が出てこない');

/* ============================================================
   5. やらないと決めたこと（§5・§10）
   ============================================================ */
ok(!/localStorage/.test(PL), 'prologue.js は localStorage に触らない');
ok(!/\bSound\b/.test(PL), 'prologue.js は Sound に触らない');
ok(!/getContext|canvas/i.test(PL), 'prologue.js は canvas に触らない');
/* 行は textContent で入れる。innerHTML で組むと、記号を足したときに黙って壊れる */
ok(/textContent\s*=/.test(PL), 'prologue.js は textContent で行を入れる');
ok(!/innerHTML/.test(PL), 'prologue.js は innerHTML を使わない');
/* 閉じるときは覆いを remove()（`.popup` と同じ形。spec §4） */
ok(/\.remove\(\)/.test(PL), 'prologue.js は覆いを remove() する');
ok(/module\.exports/.test(rd('src/prologue.js')),
  'prologue.js は module.exports を持つ（テストから読むため）');

/* ============================================================
   6. title.js 側（§4）
   ============================================================ */
ok(/typeof PROLOGUE === 'undefined'/.test(TT),
  'title.js は typeof PROLOGUE で見る（単体ページは prologue.js を読まない）');
ok(/playPrologue\(/.test(TT), 'title.js は playPrologue を通る');
/* **「見たか」をセーブに書かない**（spec §1）。書くと blankState /
   loadState / onStart の三箇所に項目が増える（引き継ぎ書 §5 の mailRead と同じ形）。
   出すかどうかは押した経路で決まるので、覚える必要が無い */
ok(!/prologue/i.test(SHELL), 'shell.html のセーブに「見たか」を持たない');
ok(!/prologueSeen|seenPrologue/i.test(TT), 'title.js も「見たか」を持たない');
/* `screen` は 'top' | 'setup' の二つのまま（§4） */
ok(!/screen\s*=\s*'prologue'/.test(TT), "screen に 'prologue' を足していない");
/* 表紙の実測の仕掛けに手を入れていない（§4） */
ok(/function fitTop\(\)/.test(TT), 'fitTop はそのまま残っている');

/* ============================================================
   7. クラス名は全部 pl で始まる（§8）
   ============================================================ */
/* CSSのクラス名は全画面で一つの名前空間（引き継ぎ書 §5）。
   `line` `text` `dots` のような一般名を裸で使わないこと */
/* **見るのは組の先頭に来るクラス**（`.plLine.on` の `on` のような
   状態の札は、単独では効かないので数えない。`test-taikai-field.js` と同じ作法）。
   コメントは先に外す——仕様の引用に釣られないため */
const CSSBODY = PLCSS.replace(/\/\*[\s\S]*?\*\//g, '');
const cls = (CSSBODY.match(/(^|[\s,>+~])\.([A-Za-z][\w-]*)/g) || [])
  .map((s) => s.replace(/^[\s,>+~]*\./, ''));
ok(cls.length > 0, 'prologue.css からクラスを拾えている');
const bad = Array.from(new Set(cls)).filter((c) => !/^pl/.test(c));
ok(bad.length === 0, 'prologue.css のクラスは全部 pl で始まる', J(bad));
/* 覆いの外の画面に、prologue.css が口を出していないこと */
ok(!/#cover|#view|#scroll|\.ttBody|\.ttBtn\b/.test(CSSBODY),
  'prologue.css は表紙の要素に触らない');
/* 書体は明朝。**丸ゴ（Maru）を使わないこと**（spec §6）——
   サブセットには本文の字が入っていないので、指定すると
   「入っている字だけ丸ゴ」という混ざりかたになる */
ok(/\.plLine\{[^}]*var\(--mincho\)/.test(PLCSS.replace(/\s+/g, '')),
  '本文の書体は var(--mincho)');
ok(!/\.plLine\{[^}]*var\(--maru\)/.test(PLCSS.replace(/\s+/g, '')),
  '本文に var(--maru) を使わない');
/* `[hidden]` は UA スタイルなので、クラスの display に負ける。
   打ち消しておかないと、釦のぶんだけ本文の中央寄せがずれる */
ok(/\.plGo\[hidden\]\{display:none\}/.test(PLCSS.replace(/\s+/g, '')),
  '.plGo[hidden] を打ち消してある');

/* ============================================================
   8. build.py（§5）
   ============================================================ */
ok(/'prologue\.css'/.test(BUILD), "build.py の CSS に prologue.css がある");
ok(/'prologue\.js'/.test(BUILD), "build.py の JS に prologue.js がある");
/* prologue.js は title.js より前（依存を先に並べる慣わし。§5） */
ok(BUILD.indexOf("'prologue.js'") < BUILD.indexOf("'title.js'"),
  'prologue.js は title.js より前に並ぶ');
/* 開発用の入口と同じ轍を踏まないための確認。CSS も本番に入っていること */
ok(BUILD.indexOf("'prologue.css'") < BUILD.indexOf("'meikan.css'"),
  'prologue.css は title.css の並びに入っている');

/* ============================================================
   9. 口（Prologue.play）
   ============================================================ */
eq(typeof Prologue.play, 'function', 'Prologue.play がある');
eq(typeof Prologue.reduced, 'function', 'Prologue.reduced がある');
/* 本文が空なら何も出さずに即 done()。**document に触らないこと**を
   ここで確かめる（node には document が無いので、触れば落ちる） */
{
  let called = 0;
  const saved = PROLOGUE.splice(0, PROLOGUE.length);
  let threw = null;
  try { Prologue.play(() => { called++; }); } catch (e) { threw = e; }
  Array.prototype.push.apply(PROLOGUE, saved);
  ok(threw === null, '本文が空でも play が投げない', threw && threw.message);
  eq(called, 1, '本文が空なら即 done() を呼ぶ');
}

console.log(pass + '件');
if (fails.length) {
  console.error('\n落ちた ' + fails.length + '件:');
  fails.forEach((f) => console.error('  ' + f));
  process.exit(1);
}
