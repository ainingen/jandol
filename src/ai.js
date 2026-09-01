/* ============================================================
   CPU思考ルーチン
   ・受け入れ枚数（ウケ入れ）ベースの牌効率
   ・現物/筋/壁/字牌残り枚数による危険度読み
   ・シャンテン数と打点による押し引き
   ============================================================ */

const AI = (() => {
  const K = Engine.KINDS;
  const kindOf = Engine.kindOf;

  /* ============================================================
     打ち筋の係数
     tournament.js の paramsOf(chara) が作った値を、対局前に
     p.ai へ入れておくと、その人の判断がそのぶん変わる。
     入っていなければ NEUTRAL が使われ、以前と同じ打ち方になる。

     ここでやるのは「強くする」ことではなく「判断の傾きを変える」こと。
     未熟なうちは押しすぎ・守りが甘い係数が入り、完成度が上がるほど
     打ち筋どおりの正確な判断に近づく（引き継ぎ書の育成方針）。
     ============================================================ */
  const NEUTRAL = {
    push: 0.5, call: 0.5, riichi: 0.5, defense: 0.5,
    speed: 0.5, value: 0.5, variance: 0, endgame: 0.5,
    skill: 1,          // 判断の正確さ。1で最善手を選ぶ
  };

  /* ムラは「局ごとに係数が揺れる幅」。打牌ごとに振ると挙動が壊れるので、
     局が変わったときに一度だけ振り直して、その局のあいだは固定する */
  function paramsOf(p, g) {
    const base = p && p.ai;
    if (!base) return NEUTRAL;
    const v = base.variance || 0;
    if (v <= 0) return base;
    const key = g ? (g.kyoku + '-' + g.honba + '-' + g.bakaze) : '0';
    if (p._aiKey !== key) {
      p._aiKey = key;
      const jitter = {};
      for (const k of ['push', 'call', 'riichi', 'defense', 'speed', 'value', 'endgame']) {
        const d = (Math.random() * 2 - 1) * v * 0.5;
        jitter[k] = Math.max(0, Math.min(1, (base[k] === undefined ? 0.5 : base[k]) + d));
      }
      jitter.variance = v;
      /* skill（判断の正確さ）は揺らさずそのまま引き継ぐ。
         ここで落とすと未熟なキャラも最善手を打ってしまう */
      jitter.skill = base.skill === undefined ? 1 : base.skill;
      p._aiRolled = jitter;
    }
    return p._aiRolled || base;
  }

  /* 終盤の条件戦。最終局で、順位に応じて押し引きを傾ける。
     endgame が高いほど正確に傾き、低いと何も見ずに打つ */
  function endgameShift(g, p, a) {
    if (!g || g.kyoku < (g.maxKyoku || 4)) return 0;
    const scores = g.players.map((x) => x.score);
    const mine = p.score;
    const top = Math.max(...scores);
    const rank = scores.filter((s) => s > mine).length + 1;
    const gap = top - mine;
    let shift;
    if (rank === 1) shift = -0.35;                       // 逃げ切り。降りる
    else if (gap > 8000) shift = 0.45;                   // 離された。押す
    else shift = 0.2;                                    // 射程内。少し押す
    return shift * (a.endgame === undefined ? 0.5 : a.endgame);
  }

  /* ---- 場に見えている牌から残り枚数を数える ---- */
  function remaining(g, p) {
    const rem = new Array(K).fill(4);
    const sub = (k) => { if (rem[k] > 0) rem[k]--; };
    for (const id of p.hand) sub(kindOf(id));
    for (const pl of g.players) {
      for (const m of pl.melds) for (const id of m.tiles) sub(kindOf(id));
      for (const d of pl.discards) sub(kindOf(d.id));
    }
    for (const id of g.doraIndicators) sub(kindOf(id));
    return rem;
  }

  /* ---- 見えている枚数（危険度用） ---- */
  function visibleCount(g, p, kind) {
    let n = 0;
    for (const id of p.hand) if (kindOf(id) === kind) n++;
    for (const pl of g.players) {
      for (const m of pl.melds) for (const id of m.tiles) if (kindOf(id) === kind) n++;
      for (const d of pl.discards) if (kindOf(d.id) === kind) n++;
    }
    for (const id of g.doraIndicators) if (kindOf(id) === kind) n++;
    return n;
  }

  /* ---- 受け入れ ---- */
  function ukeire(counts, melds, rem) {
    const sh = Engine.shanten(counts, melds);
    let total = 0;
    const tiles = [];
    for (let k = 0; k < K; k++) {
      if (rem[k] <= 0 || counts[k] >= 4) continue;
      counts[k]++;
      const s2 = Engine.shanten(counts, melds);
      counts[k]--;
      if (s2 < sh) { total += rem[k]; tiles.push(k); }
    }
    return { shanten: sh, total, tiles };
  }

  /* ---- 相手の脅威度 0〜1 ---- */
  function threatLevel(g, o) {
    if (o.riichi) return 1;
    let t = 0;
    const melds = o.melds.filter((m) => m.type !== 'ankan');
    if (melds.length >= 1) {
      t += 0.12 * melds.length;
      for (const m of o.melds) {
        const k = m.tile;
        if (k >= 31 || k === g.bakaze || k === o.jikaze) t += 0.15;
        for (const id of m.tiles) if (isDoraTile(g, id)) t += 0.1;
      }
    }
    if (o.discards.length >= 12) t += 0.1;
    // 染め手読み：序盤に他色を大量に切っている
    const suitDiscards = [0, 0, 0];
    for (const d of o.discards) { const k = kindOf(d.id); if (k < 27) suitDiscards[Math.floor(k / 9)]++; }
    const totalSuit = suitDiscards.reduce((a, b) => a + b, 0);
    if (totalSuit >= 8 && o.melds.length >= 1) {
      const minSuit = Math.min(...suitDiscards);
      if (minSuit <= 1) t += 0.2;
    }
    return Math.min(0.75, t);
  }

  function isDoraTile(g, id) {
    if (Engine.isRed(id)) return true;
    const k = kindOf(id);
    return g.doraIndicators.some((ind) => Engine.doraFromIndicator(kindOf(ind)) === k);
  }

  /* ---- 現物集合 ---- */
  function safeTilesAgainst(g, o) {
    const set = new Set();
    for (const d of o.discards) set.add(kindOf(d.id));
    if (o.riichiTurn !== null && o.riichiTurn !== undefined) {
      for (const pl of g.players) {
        if (pl === o) continue;
        for (const d of pl.discards) {
          if (d.globalTurn >= o.riichiTurn) set.add(kindOf(d.id));
        }
      }
    }
    for (const m of o.passedTiles || []) set.add(m);
    return set;
  }

  /* ---- 1人に対する生の危険度 ---- */
  function rawDanger(g, p, o, kind, safe, rem, visCache) {
    if (safe.has(kind)) return 0;
    if (kind >= 27) {
      const vis = visCache ? visCache[kind] : visibleCount(g, p, kind);
      if (vis >= 3) return 0.5;
      if (vis === 2) return 3;
      return 8;
    }
    const num = kind % 9;
    const suit = Math.floor(kind / 9);
    const base = [8, 10, 12, 14, 14, 14, 12, 10, 8][num];
    let d = base;

    // 筋
    const has = (n) => n >= 0 && n <= 8 && safe.has(suit * 9 + n);
    let sujiCut = false;
    if (num <= 2) sujiCut = has(num + 3);
    else if (num >= 6) sujiCut = has(num - 3);
    else sujiCut = has(num - 3) && has(num + 3);
    if (sujiCut) d *= 0.5;

    // 壁（ノーチャンス / ワンチャンス）
    const cnt = (n) => (n < 0 || n > 8 ? 0 : rem[suit * 9 + n]);
    if (num >= 2 && num <= 6) {
      const left = cnt(num - 2), right = cnt(num + 2);
      if (left === 0 && right === 0) d *= 0.45;
      else if (left <= 1 && right <= 1) d *= 0.75;
    }
    if (cnt(num - 1) === 0 && cnt(num + 1) === 0) d *= 0.6; // 嵌張・両面の受けが薄い
    return d;
  }

  function makeThreatCache(g, p) {
    const rem = remaining(g, p);
    const vis = new Array(K).fill(0);
    for (let k = 0; k < K; k++) vis[k] = 4 - rem[k];
    const opps = [];
    for (const o of g.players) {
      if (o === p) continue;
      const th = threatLevel(g, o);
      if (th <= 0.05) continue;
      opps.push({ o, th, safe: safeTilesAgainst(g, o) });
    }
    return { rem, vis, opps };
  }

  function totalDanger(g, p, kind, cache) {
    const c = cache || makeThreatCache(g, p);
    let sum = 0;
    for (const e of c.opps) sum += e.th * rawDanger(g, p, e.o, kind, e.safe, c.rem, c.vis);
    return sum;
  }

  /* ---- 手の価値（翻数のざっくり見積り） ---- */
  function handValue(g, p, ignoreMenzen) {
    let v = 1;
    for (const id of p.hand) if (isDoraTile(g, id)) v += 1;
    for (const m of p.melds) for (const id of m.tiles) if (isDoraTile(g, id)) v += 1;
    const menzen = p.melds.every((m) => m.type === 'ankan');
    if (menzen && !ignoreMenzen) v += 1.5;
    for (const m of p.melds) {
      if (m.tile >= 31 || m.tile === g.bakaze || m.tile === p.jikaze) v += 1;
    }
    // 染め手気配
    const counts = Engine.countsFromIds(p.hand);
    const suitTotal = [0, 0, 0];
    for (let k = 0; k < 27; k++) suitTotal[Math.floor(k / 9)] += counts[k];
    if (Math.max(...suitTotal) >= 9) v += 2;
    return v;
  }

  /* ---- 打牌選択 ---- */
  function chooseDiscard(g, p, forbid) {
    const a = paramsOf(p, g);
    const rem = remaining(g, p);
    const menzen = p.melds.every((m) => m.type === 'ankan');
    const maxThreat = Math.max(0, ...g.players.filter((o) => o !== p).map((o) => threatLevel(g, o)));
    const baseCounts = Engine.countsFromIds(p.hand);
    const curShanten = Engine.shanten(baseCounts, p.melds);
    const value = handValue(g, p);

    // 押し引き係数。a.push が高いほど遠い手でも押す
    let push;
    if (curShanten <= 0) push = 1;
    else if (curShanten === 1) push = 0.5;
    else if (curShanten === 2) push = 0.2;
    else push = 0.08;
    push = Math.min(1, push * (0.6 + value / 4));
    push = Math.max(0, Math.min(1, push * (0.55 + a.push * 0.9) + endgameShift(g, p, a)));

    // 危険度をどれだけ重く見るか。a.defense が高いほど降りる
    const riskWeight = maxThreat * 26 * (1 - push) * (0.35 + a.defense * 1.3);

    const cache = makeThreatCache(g, p);
    const seen = new Set();
    const cands = [];
    for (const id of p.hand) {
      const k = kindOf(id);
      if (forbid && forbid.has(k)) continue;
      if (seen.has(k)) continue;
      seen.add(k);

      const c = baseCounts.slice();
      c[k]--;
      const u = ukeire(c, p.melds, rem);
      // a.speed が高いほど受け入れ枚数を、a.value が高いほど打点を優先する
      let eff = -u.shanten * 120 * (0.75 + a.speed * 0.5)
              + Math.min(u.total, 40) * 2.2 * (0.5 + a.speed * 1.0);

      // ドラ・赤は残す
      if (isDoraTile(g, id)) eff -= 14 * (0.4 + a.value * 1.2);
      // 役牌の対子は残す
      if (k >= 27 && baseCounts[k] >= 2) eff -= 8;
      if (k >= 27 && baseCounts[k] === 1 && rem[k] >= 2 && (k >= 31 || k === g.bakaze || k === p.jikaze)) eff -= 3;
      // 孤立字牌は早めに整理
      if (k >= 27 && baseCounts[k] === 1) eff += 4;
      // 端寄りの孤立牌から
      if (k < 27) {
        const n = k % 9;
        eff += (4 - Math.abs(4 - n)) * 0.3;
      }
      // テンパイなら和了役の有無を軽く見る
      if (u.shanten === 0 && !menzen) {
        const wins = Engine.winningTiles(c, p.melds);
        const hasYaku = wins.some((w) => {
          const test = c.slice(); test[w]++;
          return quickYakuCheck(g, p, test, w);
        });
        if (!hasYaku) eff -= 90;
      }

      const risk = totalDanger(g, p, k, cache);
      const score = eff - risk * riskWeight;
      cands.push({ id, score, eff, risk, shanten: u.shanten });
    }
    if (!cands.length) return null;
    cands.sort((x, y) => y.score - x.score);

    /* 未熟なうちは最善でない牌を選ぶ。
       係数の傾きだけでは打牌の順位がほとんど変わらず、完成度を上げても
       強くならなかったため、ここで直接「判断の正確さ」を効かせる。
       skill=1 なら常に最善、低いほど二番手・三番手に落ちる */
    const skill = a.skill === undefined ? 1 : a.skill;
    const slip = (1 - skill) * 0.55;
    if (cands.length > 1 && Math.random() < slip) {
      const n = Math.min(cands.length - 1, Math.random() < 0.65 ? 1 : 2);
      return cands[n];
    }
    return cands[0];
  }

  // 副露手が役ありで和了れるかの簡易チェック
  function quickYakuCheck(g, p, counts, winTile) {
    const ids = [];
    const used = {};
    for (let k = 0; k < K; k++) for (let i = 0; i < counts[k]; i++) {
      used[k] = (used[k] || 0) + 1;
      ids.push(k * 4 + (used[k] - 1));
    }
    const res = Engine.evaluateHand({
      handIds: ids, melds: p.melds, winTile, tsumo: true,
      bakaze: g.bakaze, jikaze: p.jikaze, isDealer: p.seat === g.dealer,
      doraIndicators: g.doraIndicators.map(kindOf), uraIndicators: [],
    });
    if (!res) return false;
    return res.yaku.some((y) => !['ドラ', '赤ドラ', '裏ドラ'].includes(y.name));
  }

  /* ---- リーチ判断 ---- */
  function shouldRiichi(g, p, discardId) {
    const a = paramsOf(p, g);
    const value = handValue(g, p);
    const c = Engine.countsFromIds(p.hand);
    c[kindOf(discardId)]--;
    const wins = Engine.winningTiles(c, p.melds);
    const rem = remaining(g, p);
    const waitCount = wins.reduce((s, k) => s + rem[k], 0);
    if (waitCount === 0) return false;
    if (g.wall.length < 6) return waitCount >= 4;

    // a.riichi が高いほど、待ちが悪くても打点が高くてもかける。
    // 低いと黙聴に寄る（門前高打点型・仕掛け重視型など）
    const minWait = a.riichi >= 0.85 ? 1 : a.riichi >= 0.65 ? 2 : a.riichi >= 0.45 ? 3 : 4;
    if (waitCount < minWait) return false;
    const damaValue = 4 + a.riichi * 6;      // これ以上の打点なら黙聴を選ぶ
    if (waitCount <= 2 && value >= damaValue) return false;

    // 押し引きの延長。危険なときに無理にかけない
    const maxThreat = Math.max(0, ...g.players.filter((o) => o !== p).map((o) => threatLevel(g, o)));
    if (maxThreat >= 0.9 && a.defense > 0.75 && waitCount <= 3) return false;
    return true;
  }

  /* ---- 鳴き判断 ---- */
  function shouldCall(g, p, tileId, type, candidateTiles) {
    const a = paramsOf(p, g);
    const k = kindOf(tileId);
    const before = Engine.shanten(Engine.countsFromIds(p.hand), p.melds);
    const rest = p.hand.filter((id) => !candidateTiles.includes(id));
    const newMelds = p.melds.concat([{ type, tile: k, tiles: candidateTiles.concat([tileId]) }]);
    const after = Engine.shanten(Engine.countsFromIds(rest), newMelds);
    if (after > before) return false;

    const maxThreat = Math.max(0, ...g.players.filter((o) => o !== p).map((o) => threatLevel(g, o)));
    if (maxThreat >= 1 && after > 0) return false;   // 他家リーチ中はテンパイになる鳴きだけ

    const isYakuhai = k >= 31 || k === g.bakaze || k === p.jikaze;
    const value = handValue(g, p, true);

    // a.call が低いほど鳴かない（門前高打点型・変則手型など）
    if (a.call < 0.2 && !(type === 'pon' && isYakuhai && after <= 0)) return false;

    // 役牌ポンは横ばいでも価値がある
    if (type === 'pon' && isYakuhai) {
      if (after < before) return true;
      return before <= 1 + Math.round(a.call * 3);
    }
    if (after >= before) return false;

    // 役の見込みを確認
    const counts = Engine.countsFromIds(rest);
    const allKinds = [];
    for (let i = 0; i < K; i++) for (let j = 0; j < counts[i]; j++) allKinds.push(i);
    for (const m of newMelds) for (const id of m.tiles) allKinds.push(kindOf(id));
    const tanyaoOK = allKinds.every((x) => !Engine.isYaochu(x));
    const suits = new Set(allKinds.filter((x) => x < 27).map((x) => Math.floor(x / 9)));
    const honitsuOK = suits.size <= 1;
    const yakuhaiHeld = newMelds.some((m) => m.tile >= 31 || m.tile === g.bakaze || m.tile === p.jikaze)
      || [31, 32, 33, g.bakaze, p.jikaze].some((y) => counts[y] >= 2);
    const toitoiOK = newMelds.every((m) => m.type !== 'chi')
      && Object.values(counts).filter((n) => n >= 2).length >= 3;
    if (!tanyaoOK && !honitsuOK && !yakuhaiHeld && !toitoiOK) return false;

    // 安手・遠い仕掛けは避ける。a.call が高いほど許容が広い
    const farLimit = 1 + Math.round(a.call * 2.6);        // 0.1→1  0.95→4
    if (after >= farLimit) return false;
    if (after === 2 && value < 4 - a.call * 2) return false;
    if (type === 'chi' && after >= 1 && value < 3 - a.call * 2) return false;
    return true;
  }

  function shouldKan(g, p, type) {
    const a = paramsOf(p, g);
    const maxThreat = Math.max(0, ...g.players.filter((o) => o !== p).map((o) => threatLevel(g, o)));
    if (maxThreat >= 0.9 - a.push * 0.3) return false;
    if (p.riichi) return true; // 待ちが変わらない暗槓のみ呼ばれる
    const sh = Engine.shanten(Engine.countsFromIds(p.hand), p.melds);
    if (type === 'ankan') return sh <= 2;
    return sh <= 1 && handValue(g, p) >= 3;
  }

  return {
    remaining, ukeire, threatLevel, totalDanger, safeTilesAgainst,
    handValue, chooseDiscard, shouldRiichi, shouldCall, shouldKan, isDoraTile,
    paramsOf, NEUTRAL,
  };
})();
if (typeof module !== 'undefined') module.exports = AI;
