/* ============================================================
   雀ドルを探せ — 育成と大会
   ・完成度(comp) 0〜100 が実際のCPUの打ち筋を決める
   ・大会は毎回64人。プレイヤーチーム4人＋抽選60人
   ============================================================ */

/* ---------- 完成度と段位 ---------- */
const GRADE_TABLE = [
  { rank: 'D', min: 0 }, { rank: 'C', min: 20 }, { rank: 'B', min: 40 },
  { rank: 'A', min: 65 }, { rank: 'S', min: 85 },
];
function gradeOf(comp) {
  let r = 'D';
  for (const g of GRADE_TABLE) if (comp >= g.min) r = g.rank;
  return r;
}

/* 成長タイプごとの伸び方。同じ経験値でも曲線が違う */
const GROWTH_CURVE = {
  '早熟型':            (c) => c < 45 ? 1.6 : c < 70 ? 0.7 : 0.35,
  '晩成型':            (c) => c < 35 ? 0.5 : c < 65 ? 1.0 : 1.5,
  '安定成長型':        () => 1.0,
  '爆発成長型':        (c) => (Math.random() < 0.25 ? 3.0 : 0.6),
  '守備特化成長':      () => 1.0,
  '攻撃特化成長':      () => 1.0,
  '対局経験で伸びる型': () => 1.0,   // 対局数ボーナスは addExp 側で加算
  '大舞台で伸びる型':  () => 1.0,   // 大会補正は addExp 側で加算
  '人気先行型':        (c) => c < 50 ? 1.1 : 0.6,
  '伸び悩み型':        (c) => c < 40 ? 1.2 : 0.4,
  '完成型':            () => 0.15,
};

/* 対局後の成長。stage は 'practice' | 'league' | 'title' | 'final' */
function addExp(chara, place, stage) {
  if (chara.comp === undefined) chara.comp = compFromRank(chara.rank);
  const base = { 1: 3.2, 2: 2.0, 3: 1.2, 4: 0.8 }[place] || 1;
  const stageMul = { practice: 0.6, league: 1.0, title: 1.4, final: 2.0 }[stage] || 1;
  const curve = (GROWTH_CURVE[chara.growth] || (() => 1))(chara.comp);
  let gain = base * stageMul * curve * 0.55;
  if (chara.growth === '対局経験で伸びる型') gain *= 1.25;
  if (chara.growth === '大舞台で伸びる型' && (stage === 'title' || stage === 'final')) gain *= 1.8;
  // 伸びしろは「今からどれだけ伸びるか」。初期値に加算した位置が天井
  if (chara.compMax === undefined) {
    chara.compMax = Math.min(100, chara.comp + (chara.pot === undefined ? 40 : chara.pot));
  }
  const ceiling = chara.compMax;
  if (chara.comp >= ceiling - 8) gain *= 0.3;
  const before = gradeOf(chara.comp);
  chara.comp = Math.min(ceiling, chara.comp + gain);   // 伸びしろが天井
  const after = gradeOf(chara.comp);
  chara.rank = after;
  return { gain, promoted: before !== after ? after : null };
}

function compFromRank(rank) {
  return { D: 12, C: 28, B: 52, A: 74, S: 90 }[rank] || 12;
}

/* ---------- 完成度からCPUの係数を作る ---------- */
/* 未熟なうちは「押しすぎる・守りが甘い・終盤が雑・ムラが大きい」 */
function rawParams(ideal) {
  return {
    push: Math.min(1, ideal.push * 0.55 + 0.42),
    call: ideal.call * 0.5 + 0.32,
    riichi: ideal.riichi * 0.5 + 0.28,
    defense: ideal.defense * 0.32,
    speed: ideal.speed * 0.72,
    value: ideal.value * 0.7 + 0.08,
    variance: Math.min(0.85, ideal.variance + 0.38),
    endgame: ideal.endgame * 0.22,
  };
}

function paramsOf(chara, STYLES) {
  const ideal = STYLES[chara.style];
  if (!ideal) return null;
  const raw = rawParams(ideal);
  const t = Math.max(0, Math.min(1, (chara.comp === undefined ? compFromRank(chara.rank) : chara.comp) / 100));
  const out = {};
  for (const k of ['push', 'call', 'riichi', 'defense', 'speed', 'value', 'variance', 'endgame']) {
    out[k] = raw[k] + (ideal[k] - raw[k]) * t;
  }
  /* 判断の正確さ。係数の傾きだけでは打牌の順位がほとんど変わらず、
     完成度を上げても強くならなかったので、完成度そのものを渡す。
     ai.js はこれを使って、未熟なほど最善でない牌を選ぶ */
  out.skill = t;
  return out;
}

/* 実力の目安。組み合わせ抽選と自動卓の結果に使う */
function strengthOf(chara, STYLES) {
  const p = paramsOf(chara, STYLES);
  if (!p) return 50;
  const comp = chara.comp === undefined ? compFromRank(chara.rank) : chara.comp;
  const judge = p.defense * 30 + p.endgame * 25 + (1 - p.variance) * 15;
  return comp * 0.42 + judge * 0.45;
}

/* ---------- 子ごとの大会戦績（office/spec.md §9.1）----------
   **記録は今から始める。**後から始めるほど過去が空白になる。
   置き場所はセーブの最上位 `st.wins`（`comp` と同じ `{ [id]: ... }` の形）。

     st.wins = { [charaId]: { [tierId]: { entries, win, place } } }

   `place`（入賞）は優勝・準優勝・決勝卓まで。`PAYOUT` の上位三つ。
   **ここは貯めるだけ。**点にするのは `office.js`（雀エイト表）の側で、
   重みを二か所に書かないため。
   ---------------------------------------------------------- */
const PLACE_KEYS = ['win', 'second', 'final'];

/* 一件ぶん積んだ新しい表を返す（純関数。元の表は書き換えない） */
function recordResult(wins, charaId, tierId, outcomeKey) {
  const out = Object.assign({}, wins || {});
  if (charaId == null || !tierId) return out;
  const forChara = Object.assign({}, out[charaId] || {});
  const cur = forChara[tierId] || { entries: 0, win: 0, place: 0 };
  forChara[tierId] = {
    entries: cur.entries + 1,
    win: cur.win + (outcomeKey === 'win' ? 1 : 0),
    place: cur.place + (PLACE_KEYS.indexOf(outcomeKey) >= 0 ? 1 : 0),
  };
  out[charaId] = forChara;
  return out;
}

/* その子に戦績があるか（無ければ読む側が事務所単位に落ちる） */
function hasRecord(wins, charaId) {
  const w = (wins || {})[charaId];
  return !!(w && Object.keys(w).length);
}

/* ---------- 大会の格 ---------- */
const TOURNAMENTS = {
  rookie: { name: '新人戦', size: 16, stage: 'practice', prize: 200000,
    band: ['D', 'C'], strict: true, note: 'C級以下だけの十六人' },
  local: { name: '地方リーグ', size: 16, stage: 'league', prize: 500000,
    band: ['D', 'C', 'B'], strict: true, byRegion: true, note: '地元の十六人' },
  open: { name: '全国オープン', size: 64, stage: 'league', prize: 1200000,
    band: ['C', 'B', 'A'], strict: false, note: '誰でも出られる六十四人' },
  title: { name: 'タイトル戦', size: 64, stage: 'title', prize: 3000000,
    band: ['B', 'A', 'S'], strict: false, note: '上位陣が本気で来る六十四人' },
  eight: { name: '雀エイト選抜戦', size: 64, stage: 'final', prize: 8000000,
    band: ['A', 'S'], strict: false, note: '八人の座を賭ける六十四人' },
};

/* ---------- 64人の枠を組む ---------- */
/* team は プレイヤー＋仲間3人 の配列。pool は残りの雀ドル全部 */
function buildField(tierId, team, pool, opts = {}) {
  const tier = TOURNAMENTS[tierId];
  const teamIds = new Set(team.map((c) => c.id));
  const candidates = pool.filter((c) => !teamIds.has(c.id));

  // 大会の格に合う相手を厚く、外れた相手も少しは混ぜる
  const rankOf = (c) => gradeOf(c.comp === undefined ? compFromRank(c.rank) : c.comp);
  let usable = candidates;
  if (tier.strict) {
    const inBand = candidates.filter((c) => tier.band.includes(rankOf(c)));
    const regional = (tier.byRegion && opts.region)
      ? inBand.filter((c) => c.region === opts.region) : inBand;
    // 出場資格を満たす者が足りるならその中だけで組む
    const needed = (tier.size || 64) - team.length;
    usable = regional.length >= needed ? regional
      : (inBand.length >= needed ? inBand : candidates);
  }
  const weighted = usable.map((c) => {
    let w = tier.band.includes(rankOf(c)) ? 12 : 1;
    if (!tier.strict) w *= 0.4 + strengthOf(c, opts.STYLES || {}) / 60;  // 格が上の大会ほど強者が集まる
    if (opts.region && c.region === opts.region) w *= 2.2;
    if (opts.recent && opts.recent.includes(c.id)) w *= 0.35;
    return { c, w: Math.max(0.05, w) };
  });

  const need = (tier.size || 64) - team.length;
  const picked = [];
  const bag = weighted.slice();
  while (picked.length < need && bag.length) {
    const total = bag.reduce((a, x) => a + x.w, 0);
    let r = Math.random() * total, idx = 0;
    for (let i = 0; i < bag.length; i++) { r -= bag[i].w; if (r <= 0) { idx = i; break; } }
    picked.push(bag.splice(idx, 1)[0].c);
  }
  // それでも足りなければプールを使い回す（人数が増えれば自然に解消する）
  let i = 0;
  while (picked.length < need && candidates.length) {
    const c = candidates[i % candidates.length];
    picked.push(Object.assign({}, c, { id: c.id, dup: true }));
    i++;
  }
  return team.concat(picked);
}

/* ---------- 卓割りと勝ち上がり ---------- */
/* 64人 → 16卓 → 各卓のトップだけ通過 → 4卓 → 決勝卓 */
function makeTables(field) {
  const shuffled = field.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const tables = [];
  for (let i = 0; i < shuffled.length; i += 4) tables.push(shuffled.slice(i, i + 4));
  return tables;
}

/* プレイヤーが座っていない卓は数字で処理する */
function simulateTable(table, STYLES) {
  const scored = table.map((c) => {
    const s = c.id === 0 ? (c.playerStrength || 55) : strengthOf(c, STYLES);
    // 麻雀の分散。実力差はあっても番狂わせは普通に起きる
    const noise = -Math.log(-Math.log(Math.random())) * 52;
    return { c, score: s + noise };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x, i) => ({ chara: x.c, place: i + 1 }));
}

function roundName(remaining) {
  return { 64: '一回戦', 16: '準決勝', 4: '決勝卓' }[remaining] || `${remaining}人`;
}

if (typeof module !== 'undefined') {
  module.exports = {
    gradeOf, compFromRank, addExp, paramsOf, strengthOf,
    PLACE_KEYS, recordResult, hasRecord,
    TOURNAMENTS, buildField, makeTables, simulateTable, roundName, GROWTH_CURVE,
  };
}
