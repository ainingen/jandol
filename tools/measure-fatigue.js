#!/usr/bin/env node
/*
  疲労が着順にどれだけ効くかを測る — 第五段（A5）の四段目

    node tools/measure-fatigue.js
    node tools/measure-fatigue.js --tables 5000 --seed 7

  `docs/design/office/spec.md` §9。**数字を置く前に、効き目を着順で見る。**

  なぜ着順で測るか：
    `paramsOf` の係数の傾きだけでは打牌の順位がほとんど変わらず、
    完成度を上げても強くならなかった、という前例がある
    （`tournament.js` の `paramsOf` のコメント。だから `skill` を別に渡している）。
    同じ轍を踏まないため、「係数が動いた」ではなく「着順が動いた」で見る。

  測りかた：
    被験者一人（S級・comp 90）を、疲労 0／25／50／75／100 の五水準で
    `simulateTable` に座らせ、各 N 卓の平均着順と勝率（一着率）を出す。
    相手は二通り——同格（S級三人）と格下（A級三人）。
    `PULL` も 0.25 のほかに 0.15／0.35／0.50 を並べて、効きの傾きを見る。

  **`simulateTable` は `Math.random` を直に引く。**種を固定するため、
  この道具の中だけ `Math.random` を差し替える（ゲーム本体には触れない）。

  二つの経路：
    (1) `simulateTable`（自動卓・留守番・大会の他卓）は `strengthOf` だけを読む。
        速いので五水準 × 四つの PULL を一度に出す（既定）。
    (2) 実対局（`ai.js`）は `paramsOf()` の係数と `skill` を読む。
        `--real` で **`Game` を node で回して**測る。一卓 3〜4秒（東風）かかるので、
        条件を絞る（`--cond`）。三条件を別プロセスで並べて回すこと：

          node tools/measure-fatigue.js --real --cond base   # 疲労0
          node tools/measure-fatigue.js --real --cond comp   # 疲労100 を compEff で（係数も skill も動く）
          node tools/measure-fatigue.js --real --cond skill  # 疲労100 を skill だけで（係数は comp 90 のまま）

        `comp` と `skill` の差が「PULL ではなく skill 側に効かせる分岐」の答え。
*/
'use strict';

const chars = require('../src/characters.js');
Object.assign(global, {
  JANDOLS: chars.JANDOLS, FREE_AGENTS: chars.FREE_AGENTS, STYLES: chars.STYLES,
  PLAYER: chars.PLAYER, REGIONS: chars.REGIONS, RANK_INFO: chars.RANK_INFO,
  CONTRACTS: chars.CONTRACTS,
});
const Tournament = require('../src/tournament.js');
Object.assign(global, Tournament);
global.Tournament = Tournament;
const { Geo } = require('../src/geo.js');
global.Geo = Geo;
global.Scout = require('../src/scout.js');
global.Jansou = require('../src/jansou.js').Jansou;
global.Offers = require('../src/offers.js').Offers;
const { Office } = require('../src/office.js');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const TABLES = Math.max(100, parseInt(arg('tables', '2000'), 10) || 2000);
const SEED = parseInt(arg('seed', '1'), 10) || 1;
const REAL = process.argv.indexOf('--real') >= 0;
const GAMES = Math.max(10, parseInt(arg('games', '500'), 10) || 500);
const COND = arg('cond', 'base');
const LENGTH = arg('length', 'tonpuu');

/* 種つき乱数。`simulateTable` が `Math.random` を直に引くので差し替える */
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/* ------------------------------------------------------------
   顔ぶれ。**被験者は固定**（S級・comp 90・完成型）。
   相手は同格と格下の二通り。打ち筋は散らして、相性の偏りを避ける
------------------------------------------------------------ */
const SUBJECT = { id: 1, name: '被験者', rank: 'S', style: 'perfect', comp: 90, pop: 0 };
const PEERS = [
  { id: 2, name: '同格A', rank: 'S', style: 'read', comp: 90, pop: 0 },
  { id: 3, name: '同格B', rank: 'S', style: 'top', comp: 90, pop: 0 },
  { id: 4, name: '同格C', rank: 'S', style: 'wall', comp: 90, pop: 0 },
];
const LOWER = [
  { id: 5, name: '格下A', rank: 'A', style: 'read', comp: 70, pop: 0 },
  { id: 6, name: '格下B', rank: 'A', style: 'top', comp: 70, pop: 0 },
  { id: 7, name: '格下C', rank: 'A', style: 'wall', comp: 70, pop: 0 },
];

const LEVELS = [0, 25, 50, 75, 100];
const PULLS = [0.15, 0.25, 0.35, 0.50];

/* `Office.compEffOf` と同じ式だが、`PULL` を外から変えられるようにここで書く。
   **本体の式を変えるときは、ここも合わせること**（`FATIGUE_PULL` の定義を見る） */
function compEff(comp, fatigue, pull) {
  return Math.max(0, Math.min(100, comp * (1 - pull * fatigue / 100)));
}

function measure(opponents, fatigue, pull) {
  const me = Object.assign({}, SUBJECT, { comp: compEff(SUBJECT.comp, fatigue, pull) });
  const table = [me].concat(opponents);
  const saved = Math.random;
  Math.random = seeded(SEED * 7919 + fatigue * 31 + Math.round(pull * 100));
  let sum = 0, wins = 0, last = 0;
  try {
    for (let i = 0; i < TABLES; i++) {
      const r = Tournament.simulateTable(table, STYLES);
      const mine = r.find((x) => x.chara.id === SUBJECT.id).place;
      sum += mine;
      if (mine === 1) wins++;
      if (mine === 4) last++;
    }
  } finally {
    Math.random = saved;
  }
  return {
    comp: me.comp,
    grade: Tournament.gradeOf(me.comp),
    strength: Tournament.strengthOf(me, STYLES),
    avg: sum / TABLES,
    win: wins / TABLES,
    last: last / TABLES,
  };
}

const pct = (x) => (x * 100).toFixed(1) + '%';

/* ------------------------------------------------------------
   (2) 実対局。`Game` を node で回す（`io` は何もしない）。
   `match.js` / `taikai.js` と同じく `p.ai = paramsOf(chara)` を入れる。
   **`spectate: true` で四人とも AI。**人間席が無いので askTurn は呼ばれない
------------------------------------------------------------ */
async function measureReal(cond) {
  global.Engine = require('../src/engine.js');
  global.AI = require('../src/ai.js');
  const { Game } = require('../src/game.js');
  const io = { event: async () => {}, aiTell: async () => {}, aiPause: async () => {},
    update: () => {}, result: async () => {}, gameOver: async () => {}, accuseResult: async () => {},
    askTurn: async () => { throw new Error('askTurn'); }, askCall: async () => { throw new Error('askCall'); } };

  const pull = Office.FATIGUE_PULL;
  let me = Object.assign({}, SUBJECT);
  let skillOverride = null;
  if (cond === 'comp') me.comp = compEff(SUBJECT.comp, 100, pull);            // 係数も skill も動く
  if (cond === 'skill') skillOverride = (SUBJECT.comp / 100) * (1 - pull);    // skill だけ動く
  const table = [me].concat(PEERS);

  const saved = Math.random;
  Math.random = seeded(SEED * 104729 + (cond === 'comp' ? 1 : cond === 'skill' ? 2 : 0));
  let sum = 0, wins = 0, last = 0, scoreSum = 0;
  const t0 = Date.now();
  try {
    for (let i = 0; i < GAMES; i++) {
      /* 起家は 0 に固定する。段1（docs/design/match/spec.md §1）で
         Game が毎回振るようになったが、ここは種を固定して前後を比べる道具なので、
         乱数を一つ余分に引いて数字が動くことを避ける */
      const g = new Game(io, { spectate: true, length: LENGTH, startDealer: 0 });
      g.players.forEach((p, k) => {
        p.ai = Tournament.paramsOf(table[k], STYLES);
        if (k === 0 && skillOverride != null) p.ai = Object.assign({}, p.ai, { skill: skillOverride });
        p.name = table[k].name;
      });
      await g.run();
      const r = g.rankings();
      const place = r.findIndex((x) => x.seat === 0) + 1;
      sum += place; if (place === 1) wins++; if (place === 4) last++;
      scoreSum += r.find((x) => x.seat === 0).score;
      if ((i + 1) % 50 === 0) process.stderr.write('  ' + cond + ' ' + (i + 1) + '/' + GAMES + '\n');
    }
  } finally {
    Math.random = saved;
  }
  const p0 = Tournament.paramsOf(me, STYLES);
  return { cond, games: GAMES, length: LENGTH, comp: me.comp,
    skill: skillOverride != null ? skillOverride : p0.skill,
    avg: sum / GAMES, win: wins / GAMES, last: last / GAMES, score: scoreSum / GAMES,
    sec: (Date.now() - t0) / 1000 };
}

if (REAL) {
  measureReal(COND).then((r) => {
    console.log(JSON.stringify(r));
    console.log('# ' + r.cond + ': ' + r.games + '卓（' + r.length + '）'
      + ' comp ' + r.comp.toFixed(1) + ' skill ' + r.skill.toFixed(3)
      + ' → 平均着順 ' + r.avg.toFixed(3) + ' 一着率 ' + pct(r.win) + ' 四着率 ' + pct(r.last)
      + ' 平均点 ' + Math.round(r.score) + '（' + Math.round(r.sec) + '秒）');
  });
}

function mainSim() {
console.log('疲労が着順にどれだけ効くか — 各 ' + TABLES + ' 卓（種 ' + SEED + '）');
console.log('被験者: S級・comp 90・完成型。**数字はまだ置いていない。効き目を見るだけ。**\n');
console.log('本体の `Office.FATIGUE_PULL` = ' + Office.FATIGUE_PULL
  + '、`COND_SHIFT` = ' + Office.COND_SHIFT + '\n');

[['同格（S級三人・comp 90）', PEERS], ['格下（A級三人・comp 70）', LOWER]].forEach(([name, opp]) => {
  console.log('## 相手が' + name + '\n');
  PULLS.forEach((pull) => {
    const mark = pull === Office.FATIGUE_PULL ? '  ← 本体の値' : '';
    console.log('### PULL = ' + pull + mark + '\n');
    console.log('| 疲労 | 実効 comp | 級 | strengthOf | 平均着順 | 一着率 | 四着率 |');
    console.log('| --- | --- | --- | --- | --- | --- | --- |');
    const base = measure(opp, 0, pull);
    LEVELS.forEach((f) => {
      const r = measure(opp, f, pull);
      const d = r.avg - base.avg;
      console.log('| ' + f + ' | ' + r.comp.toFixed(1) + ' | ' + r.grade + ' | '
        + r.strength.toFixed(1) + ' | ' + r.avg.toFixed(3)
        + (f ? '（' + (d >= 0 ? '+' : '') + d.toFixed(3) + '）' : '')
        + ' | ' + pct(r.win) + ' | ' + pct(r.last) + ' |');
    });
    console.log('');
  });
});

console.log('※ 平均着順は 1.0〜4.0。四人卓の中立は 2.5。');
console.log('※ `simulateTable` は `strengthOf` だけを読む（`skill` は読まない）。');
console.log('  ここで着順が動かなければ、疑うのは `PULL` ではなく `strengthOf` の感度。');
console.log('  実対局（ai.js）の `skill` 側は `--real` で測る（頭のコメント）。');
}
if (!REAL) mainSim();
