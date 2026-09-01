/* ============================================================
   麻雀エンジン — 牌表現・シャンテン・和了判定・役・符・点数
   牌種(kind) 0-8:萬 9-17:筒 18-26:索 27-33:東南西北白發中
   牌ID(id)   kind*4 + copy (0-135)、赤5は id 16 / 52 / 88
   ============================================================ */

const KINDS = 34;
const RED_IDS = new Set([16, 52, 88]);

const kindOf = (id) => id >> 2;
const isRed = (id) => RED_IDS.has(id);
const isHonor = (k) => k >= 27;
const isTerminal = (k) => k < 27 && (k % 9 === 0 || k % 9 === 8);
const isYaochu = (k) => isHonor(k) || isTerminal(k);
const isGreen = (k) => [19, 20, 21, 23, 25, 32].includes(k); // 23s46s8s + 發

const TILE_NAMES = (() => {
  const n = [];
  const suits = ['m', 'p', 's'];
  for (const s of suits) for (let i = 1; i <= 9; i++) n.push(i + s);
  return n.concat(['東', '南', '西', '北', '白', '發', '中']);
})();

function countsFromKinds(kinds) {
  const c = new Array(KINDS).fill(0);
  for (const k of kinds) c[k]++;
  return c;
}
function countsFromIds(ids) {
  return countsFromKinds(ids.map(kindOf));
}

/* ---------------- シャンテン数 ---------------- */

function shantenStandard(counts, meldCount) {
  const c = counts.slice();
  let best = 8;
  let sets = 0, partials = 0, pair = 0;

  function record() {
    let p = partials;
    let blocks = sets + meldCount + p + pair;
    if (blocks > 5) p -= blocks - 5;
    let s = 8 - 2 * (sets + meldCount) - p - pair;
    if (sets + meldCount + p + pair === 5 && pair === 0) s += 1;
    if (s < best) best = s;
  }

  function dfs(i) {
    while (i <= 33 && c[i] === 0) i++;
    if (i > 33) { record(); return; }
    if (sets + meldCount + partials + pair > 5) { record(); return; }

    if (c[i] >= 3) { c[i] -= 3; sets++; dfs(i); sets--; c[i] += 3; }
    if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--; sets++; dfs(i); sets--; c[i]++; c[i + 1]++; c[i + 2]++;
    }
    if (c[i] >= 2 && pair === 0) { c[i] -= 2; pair = 1; dfs(i); pair = 0; c[i] += 2; }
    if (c[i] >= 2) { c[i] -= 2; partials++; dfs(i); partials--; c[i] += 2; }
    if (i < 27 && i % 9 <= 7 && c[i + 1] > 0) {
      c[i]--; c[i + 1]--; partials++; dfs(i); partials--; c[i]++; c[i + 1]++;
    }
    if (i < 27 && i % 9 <= 6 && c[i + 2] > 0) {
      c[i]--; c[i + 2]--; partials++; dfs(i); partials--; c[i]++; c[i + 2]++;
    }
    c[i]--; dfs(i); c[i]++;
  }
  dfs(0);
  return best;
}

function shantenChiitoi(counts) {
  let pairs = 0, kinds = 0;
  for (let i = 0; i < KINDS; i++) {
    if (counts[i] >= 1) kinds++;
    if (counts[i] >= 2) pairs++;
  }
  return 6 - pairs + Math.max(0, 7 - kinds);
}

function shantenKokushi(counts) {
  let kinds = 0, hasPair = 0;
  for (let i = 0; i < KINDS; i++) {
    if (!isYaochu(i)) continue;
    if (counts[i] >= 1) kinds++;
    if (counts[i] >= 2) hasPair = 1;
  }
  return 13 - kinds - hasPair;
}

// melds: 副露の配列（長さが副露数）。門前なら []
function shanten(counts, melds) {
  const m = melds.length;
  let s = shantenStandard(counts, m);
  if (m === 0) {
    s = Math.min(s, shantenChiitoi(counts), shantenKokushi(counts));
  }
  return s;
}

/* ---------------- 手牌の分解（4面子1雀頭） ---------------- */

function decompose(counts, needSets = 4) {
  const c = counts.slice();
  const results = [];
  const cur = [];
  let head = -1;

  function dfs(i, sets) {
    while (i <= 33 && c[i] === 0) i++;
    if (i > 33) {
      if (sets === needSets && head >= 0) results.push({ sets: cur.slice(), pair: head });
      return;
    }
    if (c[i] >= 3) {
      c[i] -= 3; cur.push({ type: 'pon', tile: i, closed: true }); dfs(i, sets + 1);
      cur.pop(); c[i] += 3;
    }
    if (i < 27 && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 1]--; c[i + 2]--;
      cur.push({ type: 'chi', tile: i, closed: true }); dfs(i, sets + 1);
      cur.pop(); c[i]++; c[i + 1]++; c[i + 2]++;
    }
    if (c[i] >= 2 && head < 0) {
      c[i] -= 2; head = i; dfs(i, sets); head = -1; c[i] += 2;
    }
  }
  dfs(0, 0);
  // 重複除去
  const seen = new Set();
  return results.filter((r) => {
    const key = r.pair + '|' + r.sets.map((s) => s.type + s.tile).sort().join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isKokushiHand(counts) {
  let kinds = 0, pair = 0, total = 0;
  for (let i = 0; i < KINDS; i++) {
    total += counts[i];
    if (counts[i] === 0) continue;
    if (!isYaochu(i)) return false;
    kinds++;
    if (counts[i] === 2) pair++;
    else if (counts[i] > 2) return false;
  }
  return total === 14 && kinds === 13 && pair === 1;
}

function isChiitoiHand(counts) {
  let pairs = 0, total = 0;
  for (let i = 0; i < KINDS; i++) {
    total += counts[i];
    if (counts[i] === 2) pairs++;
    else if (counts[i] !== 0) return false;
  }
  return total === 14 && pairs === 7;
}

/* ---------------- 待ち（テンパイ時の和了牌） ---------------- */

function winningTiles(counts, melds) {
  const res = [];
  const c = counts.slice();
  for (let k = 0; k < KINDS; k++) {
    if (c[k] >= 4) continue;
    c[k]++;
    if (isComplete(c, melds)) res.push(k);
    c[k]--;
  }
  return res;
}

function isComplete(counts, melds) {
  if (melds.length === 0) {
    if (isKokushiHand(counts)) return true;
    if (isChiitoiHand(counts)) return true;
  }
  return decompose(counts, 4 - melds.length).length > 0;
}

/* ---------------- ドラ ---------------- */

function doraFromIndicator(k) {
  if (k < 27) {
    const suit = Math.floor(k / 9), num = k % 9;
    return suit * 9 + ((num + 1) % 9);
  }
  if (k <= 30) return 27 + ((k - 27 + 1) % 4); // 東南西北
  return 31 + ((k - 31 + 1) % 3); // 白發中
}

/* ---------------- 役判定 ----------------
   ctx: {
     handIds, melds:[{type:'chi'|'pon'|'ankan'|'minkan'|'kakan', tile, tiles:[ids], from}],
     winTile(kind), winId, tsumo, riichi, doubleRiichi, ippatsu, chankan,
     rinshan, haitei, houtei, bakaze, jikaze, doraIndicators, uraIndicators,
     tenhou, chihou
   }
------------------------------------------------------- */

const YAKUHAI_NAME = { 31: '役牌 白', 32: '役牌 發', 33: '役牌 中' };
const KAZE_NAME = { 27: '東', 28: '南', 29: '西', 30: '北' };

function evaluateHand(ctx) {
  const melds = ctx.melds || [];
  const menzen = melds.every((m) => m.type === 'ankan');
  const handKinds = ctx.handIds.map(kindOf);
  const counts = countsFromKinds(handKinds);

  // 手牌(counts)には和了牌を含む前提
  const candidates = [];

  if (menzen && isKokushiHand(counts)) {
    const thirteen = counts[ctx.winTile] === 2;
    candidates.push(makeResult(ctx, null, [
      thirteen
        ? { name: '国士無双十三面', han: 2, yakuman: 2 }
        : { name: '国士無双', han: 1, yakuman: 1 },
    ], 25, menzen));
  }
  if (menzen && isChiitoiHand(counts)) {
    const yaku = chiitoiYaku(ctx, counts, menzen);
    if (yaku) candidates.push(makeResult(ctx, null, yaku, 25, menzen));
  }
  for (const d of decompose(counts, 4 - melds.length)) {
    const parsed = buildParsed(ctx, d, melds);
    const yaku = standardYaku(ctx, parsed, menzen, counts);
    if (!yaku || yaku.length === 0) continue;
    const fu = calcFu(ctx, parsed, menzen, yaku);
    candidates.push(makeResult(ctx, parsed, yaku, fu, menzen));
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score.total - a.score.total || b.han - a.han || b.fu - a.fu);
  return candidates[0];
}

function buildParsed(ctx, d, melds) {
  // 手の内の面子 + 副露面子を統一形式に
  const sets = [];
  let winUsed = false;
  for (const s of d.sets) {
    sets.push({ type: s.type, tile: s.tile, open: false, kan: false });
  }
  for (const m of melds) {
    if (m.type === 'chi') sets.push({ type: 'chi', tile: Math.min(...m.tiles.map(kindOf)), open: true, kan: false });
    else if (m.type === 'pon') sets.push({ type: 'pon', tile: m.tile, open: true, kan: false });
    else if (m.type === 'ankan') sets.push({ type: 'pon', tile: m.tile, open: false, kan: true });
    else sets.push({ type: 'pon', tile: m.tile, open: true, kan: true });
  }
  return { sets, pair: d.pair, handSets: d.sets };
}

function chiitoiYaku(ctx, counts, menzen) {
  const y = [{ name: '七対子', han: 2 }];
  addCommonYaku(ctx, y, menzen);
  // 断幺九 / 混一色 / 清一色 / 字一色
  const kinds = [];
  for (let i = 0; i < KINDS; i++) if (counts[i]) kinds.push(i);
  if (kinds.every((k) => !isYaochu(k))) y.push({ name: '断幺九', han: 1 });
  if (kinds.every((k) => isHonor(k))) return [{ name: '字一色', han: 1, yakuman: 1 }];
  if (kinds.every((k) => isYaochu(k))) y.push({ name: '混老頭', han: 2 });
  const suits = new Set(kinds.filter((k) => k < 27).map((k) => Math.floor(k / 9)));
  const hasHonor = kinds.some(isHonor);
  if (suits.size === 1 && !hasHonor) y.push({ name: '清一色', han: 6 });
  else if (suits.size === 1 && hasHonor) y.push({ name: '混一色', han: 3 });
  return y;
}

function addCommonYaku(ctx, y, menzen) {
  if (ctx.doubleRiichi) y.push({ name: 'ダブル立直', han: 2 });
  else if (ctx.riichi) y.push({ name: '立直', han: 1 });
  if (ctx.ippatsu) y.push({ name: '一発', han: 1 });
  if (ctx.tsumo && menzen) y.push({ name: '門前清自摸和', han: 1 });
  if (ctx.rinshan) y.push({ name: '嶺上開花', han: 1 });
  if (ctx.chankan) y.push({ name: '槍槓', han: 1 });
  if (ctx.haitei) y.push({ name: '海底摸月', han: 1 });
  if (ctx.houtei) y.push({ name: '河底撈魚', han: 1 });
}

function standardYaku(ctx, parsed, menzen, counts) {
  const sets = parsed.sets;
  const y = [];
  const allKinds = [];
  for (const s of sets) {
    if (s.type === 'chi') allKinds.push(s.tile, s.tile + 1, s.tile + 2);
    else allKinds.push(s.tile, s.tile, s.tile);
  }
  allKinds.push(parsed.pair, parsed.pair);

  // ---- 役満 ----
  const yakuman = [];
  const triplets = sets.filter((s) => s.type === 'pon');
  const concealedTriplets = triplets.filter((s) => {
    if (s.kan) return !s.open;
    if (s.open) return false;
    // 手の内の刻子：ロン和了で完成した刻子は明刻扱い
    if (!ctx.tsumo && s.tile === ctx.winTile && isRonCompletedTriplet(ctx, parsed, s)) return false;
    return true;
  });
  const dragons = triplets.filter((s) => s.tile >= 31);
  const winds = triplets.filter((s) => s.tile >= 27 && s.tile <= 30);

  if (dragons.length === 3) yakuman.push({ name: '大三元', han: 1, yakuman: 1 });
  if (concealedTriplets.length === 4) {
    const tanki = parsed.pair === ctx.winTile && ctx.winTile !== undefined;
    yakuman.push(tanki
      ? { name: '四暗刻単騎', han: 2, yakuman: 2 }
      : { name: '四暗刻', han: 1, yakuman: 1 });
  }
  if (allKinds.every(isHonor)) yakuman.push({ name: '字一色', han: 1, yakuman: 1 });
  if (allKinds.every(isTerminal)) yakuman.push({ name: '清老頭', han: 1, yakuman: 1 });
  if (allKinds.every(isGreen)) yakuman.push({ name: '緑一色', han: 1, yakuman: 1 });
  if (winds.length === 4) yakuman.push({ name: '大四喜', han: 2, yakuman: 2 });
  else if (winds.length === 3 && parsed.pair >= 27 && parsed.pair <= 30) {
    yakuman.push({ name: '小四喜', han: 1, yakuman: 1 });
  }
  if (sets.filter((s) => s.kan).length === 4) yakuman.push({ name: '四槓子', han: 1, yakuman: 1 });
  if (menzen) {
    const ch = chuurenType(counts, ctx.winTile);
    if (ch === 2) yakuman.push({ name: '純正九蓮宝燈', han: 2, yakuman: 2 });
    else if (ch === 1) yakuman.push({ name: '九蓮宝燈', han: 1, yakuman: 1 });
  }
  if (ctx.tenhou) yakuman.push({ name: '天和', han: 1, yakuman: 1 });
  if (ctx.chihou) yakuman.push({ name: '地和', han: 1, yakuman: 1 });
  if (yakuman.length) return yakuman;

  // ---- 通常役 ----
  addCommonYaku(ctx, y, menzen);

  // 役牌
  for (const s of triplets) {
    if (s.tile >= 31) y.push({ name: YAKUHAI_NAME[s.tile], han: 1 });
    if (s.tile === ctx.bakaze) y.push({ name: '場風 ' + KAZE_NAME[s.tile], han: 1 });
    if (s.tile === ctx.jikaze) y.push({ name: '自風 ' + KAZE_NAME[s.tile], han: 1 });
  }
  // 平和
  if (menzen && isPinfu(ctx, parsed)) y.push({ name: '平和', han: 1 });
  // 断幺九
  if (allKinds.every((k) => !isYaochu(k))) y.push({ name: '断幺九', han: 1 });
  // 一盃口 / 二盃口
  if (menzen) {
    const runs = sets.filter((s) => s.type === 'chi').map((s) => s.tile).sort((a, b) => a - b);
    let iipeiko = 0;
    for (let i = 0; i < runs.length - 1; i++) {
      if (runs[i] === runs[i + 1]) { iipeiko++; i++; }
    }
    if (iipeiko === 2) y.push({ name: '二盃口', han: 3 });
    else if (iipeiko === 1) y.push({ name: '一盃口', han: 1 });
  }
  // 三色同順
  const runTiles = sets.filter((s) => s.type === 'chi').map((s) => s.tile);
  for (const t of runTiles) {
    if (t >= 27) continue;
    const num = t % 9;
    if (num > 6) continue;
    const need = [num, num + 9, num + 18];
    if (need.every((n) => runTiles.includes(n))) {
      y.push({ name: '三色同順', han: menzen ? 2 : 1 });
      break;
    }
  }
  // 一気通貫
  for (let suit = 0; suit < 3; suit++) {
    const base = suit * 9;
    if ([base, base + 3, base + 6].every((n) => runTiles.includes(n))) {
      y.push({ name: '一気通貫', han: menzen ? 2 : 1 });
      break;
    }
  }
  // 三色同刻
  const ponTiles = triplets.map((s) => s.tile);
  for (const t of ponTiles) {
    if (t >= 27) continue;
    const num = t % 9;
    const need = [num, num + 9, num + 18];
    if (need.every((n) => ponTiles.includes(n))) { y.push({ name: '三色同刻', han: 2 }); break; }
  }
  // 対々和 / 三暗刻 / 三槓子
  if (triplets.length === 4) y.push({ name: '対々和', han: 2 });
  if (concealedTriplets.length === 3) y.push({ name: '三暗刻', han: 2 });
  const kans = sets.filter((s) => s.kan).length;
  if (kans === 3) y.push({ name: '三槓子', han: 2 });
  // 小三元
  if (dragons.length === 2 && parsed.pair >= 31) y.push({ name: '小三元', han: 2 });
  // 混老頭
  const allYaochu = allKinds.every(isYaochu);
  if (allYaochu) y.push({ name: '混老頭', han: 2 });
  // 全帯幺 / 純全帯幺
  if (!allYaochu) {
    const blocks = sets.map((s) => (s.type === 'chi' ? [s.tile, s.tile + 1, s.tile + 2] : [s.tile]));
    blocks.push([parsed.pair]);
    const everyBlockHasYaochu = blocks.every((b) => b.some(isYaochu));
    if (everyBlockHasYaochu) {
      const anyHonor = allKinds.some(isHonor);
      if (anyHonor) y.push({ name: '混全帯幺九', han: menzen ? 2 : 1 });
      else y.push({ name: '純全帯幺九', han: menzen ? 3 : 2 });
    }
  }
  // 染め手
  const suits = new Set(allKinds.filter((k) => k < 27).map((k) => Math.floor(k / 9)));
  const hasHonor = allKinds.some(isHonor);
  if (suits.size === 1 && !hasHonor) y.push({ name: '清一色', han: menzen ? 6 : 5 });
  else if (suits.size === 1 && hasHonor) y.push({ name: '混一色', han: menzen ? 3 : 2 });

  return y;
}

function isRonCompletedTriplet(ctx, parsed, s) {
  // 和了牌が手の内の刻子に使われている場合、その刻子は明刻扱い（1組のみ）
  const inHand = parsed.handSets.some((h) => h.type === 'pon' && h.tile === s.tile);
  return inHand;
}

function chuurenType(counts, winTile) {
  for (let suit = 0; suit < 3; suit++) {
    const base = suit * 9;
    let ok = true, total = 0;
    for (let i = 0; i < KINDS; i++) {
      if (i >= base && i < base + 9) { total += counts[i]; continue; }
      if (counts[i] > 0) { ok = false; break; }
    }
    if (!ok || total !== 14) continue;
    const need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
    let extra = -1, valid = true;
    for (let i = 0; i < 9; i++) {
      const diff = counts[base + i] - need[i];
      if (diff < 0) { valid = false; break; }
      if (diff === 1) { if (extra >= 0) { valid = false; break; } extra = i; }
      else if (diff !== 0) { valid = false; break; }
    }
    if (valid && extra >= 0) {
      const pureWait = counts[winTile] - need[winTile - base] === 1 && base + extra === winTile;
      // 純正：和了前が 1112345678999 の形（＝和了牌がどの数でも9面待ち）
      return pureWait ? 2 : 1;
    }
  }
  return 0;
}

function isPinfu(ctx, parsed) {
  if (parsed.sets.some((s) => s.type !== 'chi')) return false;
  if (parsed.sets.some((s) => s.open || s.kan)) return false;
  const p = parsed.pair;
  if (p >= 31) return false;
  if (p === ctx.bakaze || p === ctx.jikaze) return false;
  // 両面待ちか
  return parsed.handSets.some((s) => {
    if (s.type !== 'chi') return false;
    const t = s.tile;
    if (ctx.winTile === t && (t % 9) !== 6) return true;       // 下側で受け＝両面
    if (ctx.winTile === t + 2 && (t % 9) !== 0) return true;   // 上側で受け＝両面
    return false;
  });
}

/* ---------------- 符計算 ---------------- */

function calcFu(ctx, parsed, menzen, yaku) {
  if (yaku.some((v) => v.name === '平和')) return ctx.tsumo ? 20 : 30;
  let fu = 20;
  if (!ctx.tsumo && menzen) fu += 10;
  if (ctx.tsumo) fu += 2;
  if (!menzen && !ctx.tsumo) {
    // 喰い平和形の30符固定は後段でチェック
  }
  let ronTripletUsed = false;
  for (const s of parsed.sets) {
    if (s.type === 'chi') continue;
    const yao = isYaochu(s.tile) ? 2 : 1;
    let concealed = !s.open;
    if (!ctx.tsumo && !s.open && !s.kan && s.tile === ctx.winTile && !ronTripletUsed) {
      const inHand = parsed.handSets.some((h) => h.type === 'pon' && h.tile === s.tile);
      if (inHand) { concealed = false; ronTripletUsed = true; }
    }
    if (s.kan) fu += (concealed ? 16 : 8) * yao;
    else fu += (concealed ? 4 : 2) * yao;
  }
  // 雀頭
  if (parsed.pair >= 31) fu += 2;
  if (parsed.pair === ctx.bakaze) fu += 2;
  if (parsed.pair === ctx.jikaze) fu += 2;
  // 待ち
  fu += waitFu(ctx, parsed);

  let total = Math.ceil(fu / 10) * 10;
  if (!menzen && total === 20) total = 30; // 喰い平和
  return total;
}

function waitFu(ctx, parsed) {
  if (parsed.pair === ctx.winTile) {
    const usedElsewhere = parsed.handSets.some(
      (s) => s.type === 'pon' && s.tile === ctx.winTile
    );
    if (!usedElsewhere) return 2; // 単騎
  }
  let bonus = 0;
  for (const s of parsed.handSets) {
    if (s.type !== 'chi') continue;
    const t = s.tile;
    if (ctx.winTile === t + 1) return 2; // 嵌張
    if (ctx.winTile === t && t % 9 === 6) bonus = 2; // 辺張(789の7待ち)
    if (ctx.winTile === t + 2 && t % 9 === 0) bonus = 2; // 辺張(123の3待ち)
  }
  return bonus;
}

/* ---------------- 点数 ---------------- */

function makeResult(ctx, parsed, yaku, fu, menzen) {
  const yakumanCount = yaku.reduce((a, v) => a + (v.yakuman || 0), 0);
  let han = yaku.reduce((a, v) => a + v.han, 0);
  const extras = [];

  if (!yakumanCount) {
    const dora = countDora(ctx);
    if (dora.dora) extras.push({ name: 'ドラ', han: dora.dora });
    if (dora.aka) extras.push({ name: '赤ドラ', han: dora.aka });
    if (dora.ura) extras.push({ name: '裏ドラ', han: dora.ura });
    han += extras.reduce((a, v) => a + v.han, 0);
  }
  const all = yaku.concat(extras);
  const score = calcScore(han, fu, ctx.isDealer, ctx.tsumo, yakumanCount, ctx.honba || 0);
  return { yaku: all, han, fu, score, yakuman: yakumanCount, menzen };
}

function countDora(ctx) {
  const tiles = ctx.handIds.slice();
  for (const m of ctx.melds || []) tiles.push(...m.tiles);
  let dora = 0, aka = 0, ura = 0;
  for (const ind of ctx.doraIndicators || []) {
    const d = doraFromIndicator(ind);
    dora += tiles.filter((t) => kindOf(t) === d).length;
  }
  if (ctx.riichi || ctx.doubleRiichi) {
    for (const ind of ctx.uraIndicators || []) {
      const d = doraFromIndicator(ind);
      ura += tiles.filter((t) => kindOf(t) === d).length;
    }
  }
  aka = tiles.filter(isRed).length;
  return { dora, aka, ura };
}

function limitName(han, yakumanCount) {
  if (yakumanCount >= 2) return { name: yakumanCount + '倍役満', base: 8000 * yakumanCount };
  if (yakumanCount === 1) return { name: '役満', base: 8000 };
  if (han >= 13) return { name: '数え役満', base: 8000 };
  if (han >= 11) return { name: '三倍満', base: 6000 };
  if (han >= 8) return { name: '倍満', base: 4000 };
  if (han >= 6) return { name: '跳満', base: 3000 };
  return null;
}

function calcScore(han, fu, isDealer, tsumo, yakumanCount, honba) {
  let base;
  const limit = limitName(han, yakumanCount);
  let name = limit ? limit.name : '';
  if (limit) base = limit.base;
  else {
    base = fu * Math.pow(2, 2 + han);
    if (base >= 2000) { base = 2000; name = '満貫'; }
  }
  const r = (x) => Math.ceil(x / 100) * 100;
  const out = { han, fu, name, tsumo, isDealer, honba };
  if (tsumo) {
    if (isDealer) {
      const each = r(base * 2);
      out.each = each + honba * 100;
      out.total = out.each * 3;
      out.detail = `${out.each}オール`;
    } else {
      const ko = r(base), oya = r(base * 2);
      out.ko = ko + honba * 100;
      out.oya = oya + honba * 100;
      out.total = out.ko * 2 + out.oya;
      out.detail = `${out.ko} / ${out.oya}`;
    }
  } else {
    const total = r(base * (isDealer ? 6 : 4)) + honba * 300;
    out.total = total;
    out.detail = `${total}点`;
  }
  return out;
}

const Engine = {
  KINDS, TILE_NAMES, kindOf, isRed, isHonor, isTerminal, isYaochu,
  countsFromKinds, countsFromIds, shanten, shantenStandard, shantenChiitoi,
  shantenKokushi, decompose, isComplete, winningTiles, doraFromIndicator,
  evaluateHand, calcScore, isKokushiHand, isChiitoiHand,
};
if (typeof module !== 'undefined') module.exports = Engine;
