/* ============================================================
   対局進行
   ============================================================ */

const KAZE = ['東', '南', '西', '北'];
const SEAT_LABEL = ['自分', '下家', '対面', '上家'];

class Game {
  constructor(io, opts = {}) {
    this.io = io;
    this.opts = Object.assign({ length: 'tonpuu', startScore: 25000 }, opts);
    this.players = [0, 1, 2, 3].map((i) => ({
      seat: i, isAI: opts.spectate ? true : i !== 0, score: this.opts.startScore,
      hand: [], melds: [], discards: [], riichi: false, riichiTurn: null,
      ippatsu: false, doubleRiichi: false, furiten: false, passedTiles: [],
      jikaze: 27, name: (opts.foes && i > 0) ? opts.foes[i - 1] : SEAT_LABEL[i],
    }));
    this.bakaze = 27;
    this.dealer = 0;
    this.kyoku = 1;
    this.honba = 0;
    this.riichiSticks = 0;
    this.finished = false;
  }

  get maxKyoku() {
    if (this.opts.length === 'hanchan') return 8;
    if (this.opts.length === 'ikkyoku') return 1;
    return 4;
  }

  /* ---------- 配牌 ---------- */
  deal() {
    const ids = [];
    for (let i = 0; i < 136; i++) ids.push(i);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    this.deadWall = ids.slice(0, 14);
    this.wall = ids.slice(14);
    this.doraIndicators = [this.deadWall[4]];
    this.uraIndicators = [this.deadWall[5]];
    this.kanCount = 0;
    this.rinshanIndex = 0;
    this.globalTurn = 0;
    this.lastDiscard = null;
    this.noCallsYet = true;
    this.currentDraw = null;

    for (const p of this.players) {
      p.hand = []; p.melds = []; p.discards = [];
      p.riichi = false; p.riichiTurn = null; p.ippatsu = false;
      p.doubleRiichi = false; p.furiten = false; p.passedTiles = [];
      p.jikaze = 27 + ((p.seat - this.dealer + 4) % 4);
      p.tenpaiAtDraw = false;
    }
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 4; i++) {
        const p = this.players[(this.dealer + i) % 4];
        for (let n = 0; n < 4; n++) p.hand.push(this.wall.shift());
      }
    }
    for (let i = 0; i < 4; i++) {
      this.players[(this.dealer + i) % 4].hand.push(this.wall.shift());
    }
    for (const p of this.players) this.sortHand(p);
    if (this.cheat) {
      Cheat.resetHand(this);
      if ((this.perks || []).includes('kubari') && this.cheat.hand.length < Cheat.handLimit(this)) {
        this.cheat.hand.push(CHEATS[Math.floor(Math.random() * CHEATS.length)].id);
      }
    }
  }

  sortHand(p) {
    p.hand.sort((a, b) => (Engine.kindOf(a) - Engine.kindOf(b)) || a - b);
  }

  drawTile(fromDead = false, seat = null) {
    const c = this.cheat;
    if (c && seat !== null && !fromDead) {
      if (c.skipDraw) { c.skipDraw = false; if (this.wall.length > 1) this.wall.push(this.wall.shift()); }
      if (c.kingDraw) { c.kingDraw = false; fromDead = true; }
      else if (c.rigged[seat] !== undefined) {
        const want = c.rigged[seat];
        delete c.rigged[seat];
        const i = this.wall.findIndex((id) => Engine.kindOf(id) === want);
        if (i > 0) { const t = this.wall.splice(i, 1)[0]; this.wall.unshift(t); }
      } else if (c.doubleDraw) {
        c.doubleDraw = false;
        const a = this.wall.shift(), b = this.wall.shift();
        const p = this.players[seat];
        const score = (id) => {
          const cc = Engine.countsFromIds(p.hand.concat([id]));
          return Engine.shanten(cc, p.melds) * 10 - (AI.isDoraTile(this, id) ? 1 : 0);
        };
        const keep = score(a) <= score(b) ? a : b;
        const back = keep === a ? b : a;
        this.wall.push(back);
        return keep;
      }
    }
    if (fromDead) {
      // 嶺上牌は王牌の端から。ドラ表示牌の位置(4,6,8,10,12)は動かさない
      const t = this.deadWall[this.rinshanIndex++];
      if (this.wall.length) this.deadWall.push(this.wall.pop());
      return t;
    }
    return this.wall.shift();
  }

  addKanDora() {
    this.kanCount++;
    const idx = 4 + this.kanCount * 2;
    if (this.deadWall[idx] !== undefined) {
      this.doraIndicators.push(this.deadWall[idx]);
      this.uraIndicators.push(this.deadWall[idx + 1]);
    }
  }

  isMenzen(p) { return p.melds.every((m) => m.type === 'ankan'); }

  handCounts(p) { return Engine.countsFromIds(p.hand); }

  waits(p) {
    const c = this.handCounts(p);
    if (p.hand.length % 3 !== 1) return [];
    return Engine.winningTiles(c, p.melds);
  }

  updateFuriten(p) {
    const w = this.waits(p);
    const own = new Set(p.discards.map((d) => Engine.kindOf(d.id)));
    p.furitenPermanent = w.some((k) => own.has(k));
    p.furiten = p.furitenPermanent || p.passedTiles.some((k) => w.includes(k));
  }

  canWin(p, winKind, winId, ctxExtra) {
    const hand = p.hand.concat([winId]);
    const ctx = Object.assign({
      handIds: hand, melds: p.melds, winTile: winKind, winId,
      tsumo: false, riichi: p.riichi && !p.doubleRiichi, doubleRiichi: p.doubleRiichi,
      ippatsu: p.ippatsu, bakaze: this.bakaze, jikaze: p.jikaze,
      isDealer: p.seat === this.dealer,
      doraIndicators: this.doraIndicators.map(Engine.kindOf),
      uraIndicators: this.uraIndicators.map(Engine.kindOf),
      honba: this.honba,
    }, ctxExtra || {});
    const res = Engine.evaluateHand(ctx);
    if (!res) return null;
    const c = this.cheat;
    if (c && p.seat === 0 && (c.bonusHan || c.bonusUra) && !res.yakuman) {
      if (c.bonusHan) res.yaku.push({ name: '秘技 数え上げ', han: c.bonusHan });
      if (c.bonusUra) res.yaku.push({ name: '秘技 裏乗せ', han: c.bonusUra });
      res.han += c.bonusHan + c.bonusUra;
      res.score = Engine.calcScore(res.han, res.fu, ctx.isDealer, ctx.tsumo, 0, this.honba);
    }
    const real = res.yaku.filter((y) => !['ドラ', '赤ドラ', '裏ドラ'].includes(y.name));
    if (real.length === 0) return null;
    return res;
  }

  /* ---------- 1局 ---------- */
  async playHand() {
    this.deal();
    this.io.update();
    await this.io.event(`${KAZE[this.bakaze - 27]}${((this.kyoku - 1) % 4) + 1}局 ${this.honba}本場`, 900,
      { seat: this.dealer, kind: 'start' });

    let turn = this.dealer;
    let firstRound = true;
    let turnState = 'draw';       // 'draw' | 'kan' | 'call'
    let forbid = null;            // 喰い替え禁止牌

    while (true) {
      const p = this.players[turn];
      let drawnId = null;

      if (turnState === 'draw' || turnState === 'kan') {
        if (turnState === 'draw' && this.wall.length === 0) return await this.exhaustiveDraw();
        drawnId = this.drawTile(turnState === 'kan', turn);
        p.passedTiles = [];
        this.updateFuriten(p);
      }
      const isHaitei = this.wall.length === 0;
      const rinshan = turnState === 'kan';
      this.currentDraw = drawnId === null ? null : { seat: turn, id: drawnId };
      this.io.update();

      if (p.isAI && this.cheat) {
        const tell = Cheat.aiMaybeCheat(this, p);
        if (tell && tell.noticed) await this.io.aiTell(tell);
      }
      if (drawnId !== null) { p.hand.push(drawnId); this.sortHand(p); }

      const calcTsumo = () => {
        if (drawnId === null) return null;
        const view = Object.assign({}, p, { hand: p.hand.filter((x) => x !== drawnId) });
        return this.canWin(view, Engine.kindOf(drawnId), drawnId, {
          tsumo: true, rinshan, haitei: isHaitei && !rinshan,
          tenhou: firstRound && turn === this.dealer && this.noCallsYet && p.discards.length === 0,
          chihou: firstRound && turn !== this.dealer && this.noCallsYet && p.discards.length === 0,
        });
      };

      const buildOptions = (tsumoRes) => {
        const options = {
          discard: true, tsumo: !!tsumoRes, riichi: false,
          ankan: [], kakan: [], kyuushu: false, forbid,
        };
        const menzen = this.isMenzen(p);
        if (drawnId !== null && !p.riichi && menzen && p.score >= 1000 && this.wall.length >= 4) {
          const c = Engine.countsFromIds(p.hand);
          for (let k = 0; k < 34; k++) {
            if (c[k] === 0) continue;
            c[k]--;
            const ok = Engine.shanten(c, p.melds) === 0 && Engine.winningTiles(c, p.melds).length > 0;
            c[k]++;
            if (ok) { options.riichi = true; break; }
          }
        }
        if (drawnId !== null && this.wall.length > 0) {
          const c = Engine.countsFromIds(p.hand);
          for (let k = 0; k < 34; k++) {
            if (c[k] !== 4) continue;
            if (p.riichi) {
              if (Engine.kindOf(drawnId) !== k) continue;
              const rest13 = p.hand.filter((x) => x !== drawnId);
              const before = Engine.winningTiles(Engine.countsFromIds(rest13), p.melds).join();
              const rest = p.hand.filter((id) => Engine.kindOf(id) !== k);
              const after = Engine.winningTiles(
                Engine.countsFromIds(rest), p.melds.concat([{ type: 'ankan', tile: k, tiles: [] }])
              ).join();
              if (before === after && before !== '') options.ankan.push(k);
            } else options.ankan.push(k);
          }
          if (!p.riichi) {
            for (const m of p.melds) {
              if (m.type === 'pon' && p.hand.some((id) => Engine.kindOf(id) === m.tile)) options.kakan.push(m.tile);
            }
          }
        }
        if (firstRound && this.noCallsYet && p.melds.length === 0 && p.discards.length === 0 && drawnId !== null) {
          const kinds = new Set(p.hand.map(Engine.kindOf).filter(Engine.isYaochu));
          if (kinds.size >= 9) options.kyuushu = true;
        }
        return options;
      };

      let action, tsumoRes, options;
      do {
        tsumoRes = calcTsumo();
        options = buildOptions(tsumoRes);
        if (p.isAI) {
          await this.io.aiPause();
          action = this.aiTurnAction(p, options, drawnId, tsumoRes);
        } else {
          action = await this.io.askTurn(p, options, drawnId);
        }
        if (action.type === 'accuse') {
          const r = Cheat.accuse(this);
          await this.io.accuseResult(r);
          if (r.chombo) {
            const culprit = r.hit ? this.players[r.seat] : this.players[0];
            this.payChombo(culprit);
            return await this.abortiveDraw(`${culprit.name}のイカサマ露見`);
          }
        }
      } while (action.type === 'accuse' || action.type === 'cheat');

      if (action.type === 'chombo') {
        this.payChombo(p);
        return await this.abortiveDraw('イカサマ露見');
      }

      if (action.type === 'tsumo') {
        p.hand = p.hand.filter((id) => id !== drawnId);
        return await this.finishWin(p, drawnId, tsumoRes, null);
      }
      if (action.type === 'kyuushu') {
        return await this.abortiveDraw('九種九牌');
      }
      if (action.type === 'ankan' || action.type === 'kakan') {
        const k = action.tile;
        if (action.type === 'ankan') {
          const tiles = p.hand.filter((id) => Engine.kindOf(id) === k);
          p.hand = p.hand.filter((id) => Engine.kindOf(id) !== k);
          p.melds.push({ type: 'ankan', tile: k, tiles, from: p.seat });
          for (const q of this.players) q.ippatsu = false;
          await this.io.event(`${p.name} 暗槓`, 700, { seat: p.seat, kind: 'call' });
          this.addKanDora();
        } else {
          const meld = p.melds.find((m) => m.type === 'pon' && m.tile === k);
          const id = p.hand.find((x) => Engine.kindOf(x) === k);
          p.hand = p.hand.filter((x) => x !== id);
          meld.type = 'kakan'; meld.tiles.push(id);
          await this.io.event(`${p.name} 加槓`, 700, { seat: p.seat, kind: 'call' });
          const ron = await this.checkChankan(p, id);
          if (ron) return ron;
          for (const q of this.players) q.ippatsu = false;
          this.addKanDora();
        }
        if (this.totalKans() >= 4 && this.kanPlayers() >= 2) return await this.abortiveDraw('四開槓');
        turnState = 'kan'; forbid = null;
        this.io.update();
        continue;
      }

      const discardId = action.tile;
      const declaringRiichi = action.type === 'riichi';
      if (declaringRiichi) {
        p.riichi = true;
        p.riichiTurn = this.globalTurn;
        p.doubleRiichi = firstRound && this.noCallsYet;
        p.score -= 1000;
        this.riichiSticks++;
        await this.io.event(`${p.name} リーチ`, 800, { seat: p.seat, kind: 'riichi' });
      }
      p.hand = p.hand.filter((id) => id !== discardId);
      this.sortHand(p);
      p.discards.push({
        id: discardId, tsumogiri: discardId === drawnId,
        riichi: declaringRiichi, globalTurn: this.globalTurn,
      });
      this.lastDiscard = { seat: turn, id: discardId };
      this.currentDraw = null;
      this.globalTurn++;
      if (declaringRiichi) p.ippatsu = true;
      else p.ippatsu = false;
      this.updateFuriten(p);
      this.io.update();

      if (firstRound && this.globalTurn === 4 && this.noCallsYet) {
        const first = this.players.map((q) => q.discards[0]).filter(Boolean);
        if (first.length === 4) {
          const kinds = first.map((d) => Engine.kindOf(d.id));
          if (kinds.every((k) => k >= 27 && k <= 30 && k === kinds[0])) {
            return await this.abortiveDraw('四風連打');
          }
        }
      }
      if (this.players.every((q) => q.riichi)) return await this.abortiveDraw('四家立直');

      const resp = await this.resolveDiscard(turn, discardId, isHaitei);
      if (resp && resp.type === 'ron') return resp.result;
      if (resp && resp.type === 'call') {
        turn = resp.seat;
        turnState = resp.kan ? 'kan' : 'call';
        forbid = resp.forbid || null;
        firstRound = false;
        this.noCallsYet = false;
        if (resp.kan) {
          if (this.totalKans() >= 4 && this.kanPlayers() >= 2) return await this.abortiveDraw('四開槓');
          this.addKanDora();
        }
        continue;
      }

      if (this.wall.length === 0) return await this.exhaustiveDraw();
      turn = (turn + 1) % 4;
      if (turn === this.dealer) firstRound = false;
      turnState = 'draw';
      forbid = null;
    }
  }

  payChombo(culprit) {
    const isOya = culprit.seat === this.dealer;
    for (const q of this.players) {
      if (q === culprit) continue;
      const amt = isOya ? 4000 : (q.seat === this.dealer ? 4000 : 2000);
      q.score += amt;
      culprit.score -= amt;
    }
    if (this.cheat) {
      // 罰符を払えば一度は帳消し。ただし目は付いたまま
      if (culprit.seat === 0) { this.cheat.hand = []; this.cheat.suspicion = 1; }
      else culprit.suspicion = 1;
    }
  }

  totalKans() {
    return this.players.reduce(
      (a, q) => a + q.melds.filter((m) => ['ankan', 'minkan', 'kakan'].includes(m.type)).length, 0);
  }
  kanPlayers() {
    return this.players.filter(
      (q) => q.melds.some((m) => ['ankan', 'minkan', 'kakan'].includes(m.type))).length;
  }

  /* ---------- CPUの手番行動 ---------- */
  aiTurnAction(p, options, drawnId, tsumoRes) {
    if (options.tsumo) return { type: 'tsumo' };
    if (options.kyuushu && Engine.shanten(Engine.countsFromIds(p.hand), p.melds) >= 3) {
      return { type: 'kyuushu' };
    }
    if (options.ankan.length && AI.shouldKan(this, p, 'ankan')) {
      return { type: 'ankan', tile: options.ankan[0] };
    }
    if (options.kakan.length && AI.shouldKan(this, p, 'kakan')) {
      return { type: 'kakan', tile: options.kakan[0] };
    }
    if (p.riichi) return { type: 'discard', tile: drawnId };

    const best = AI.chooseDiscard(this, p, options.forbid);
    if (options.riichi && best) {
      // リーチ可能な打牌の中から選ぶ
      const c = Engine.countsFromIds(p.hand);
      const cands = [];
      const seen = new Set();
      for (const id of p.hand) {
        const k = Engine.kindOf(id);
        if (seen.has(k)) continue; seen.add(k);
        c[k]--;
        if (Engine.shanten(c, p.melds) === 0) cands.push(id);
        c[k]++;
      }
      if (cands.length) {
        let pick = cands.includes(best.id) ? best.id : null;
        if (!pick) {
          let bestCount = -1;
          for (const id of cands) {
            const cc = Engine.countsFromIds(p.hand); cc[Engine.kindOf(id)]--;
            const rem = AI.remaining(this, p);
            const n = Engine.winningTiles(cc, p.melds).reduce((a, k) => a + rem[k], 0);
            if (n > bestCount) { bestCount = n; pick = id; }
          }
        }
        if (AI.shouldRiichi(this, p, pick)) return { type: 'riichi', tile: pick };
      }
    }
    return { type: 'discard', tile: best ? best.id : p.hand[p.hand.length - 1] };
  }

  /* ---------- 打牌に対する反応 ---------- */
  async resolveDiscard(from, tileId, isHaitei) {
    const kind = Engine.kindOf(tileId);
    const cands = [];
    for (let i = 1; i <= 3; i++) {
      const seat = (from + i) % 4;
      const p = this.players[seat];
      const opt = { ron: null, pon: null, kan: null, chi: [] };

      this.updateFuriten(p);
      const cc = this.cheat;
      const furitenOK = (!p.furiten && !p.furitenPermanent)
        || (p.seat === 0 && cc && cc.ignoreFuriten);
      if (furitenOK) {
        const res = this.canWin(p, kind, tileId, {
          tsumo: false, houtei: isHaitei,
        });
        if (res) opt.ron = res;
      }
      if (!p.riichi && this.wall.length > 0 && !(cc && cc.noCall.has(seat))) {
        const same = p.hand.filter((id) => Engine.kindOf(id) === kind);
        if (same.length >= 2) opt.pon = same.slice(0, 2);
        if (same.length >= 3) opt.kan = same.slice(0, 3);
        if (i === 1 && kind < 27) {
          const n = kind % 9, base = kind - n;
          const pick = (a, b) => {
            const x = p.hand.find((id) => Engine.kindOf(id) === base + a);
            const y = p.hand.find((id) => Engine.kindOf(id) === base + b);
            return x !== undefined && y !== undefined ? [x, y] : null;
          };
          if (n >= 2) { const t = pick(n - 2, n - 1); if (t) opt.chi.push(t); }
          if (n >= 1 && n <= 7) { const t = pick(n - 1, n + 1); if (t) opt.chi.push(t); }
          if (n <= 6) { const t = pick(n + 1, n + 2); if (t) opt.chi.push(t); }
        }
      }
      if (opt.ron || opt.pon || opt.kan || opt.chi.length) cands.push({ seat, p, opt });
    }
    if (!cands.length) return null;

    // ロン優先（頭ハネ）
    const decisions = [];
    for (const c of cands) {
      let act;
      if (c.p.isAI) act = this.aiCallAction(c.p, c.opt, tileId);
      else { this.io.update(); act = await this.io.askCall(c.p, c.opt, tileId, from); }
      decisions.push({ ...c, act });
    }
    const ronDec = decisions.filter((d) => d.act.type === 'ron');
    if (ronDec.length && this.cheat && this.cheat.voidDealIn && from === 0) {
      this.cheat.voidDealIn = false;
      await this.io.event('なかったこと', 900);
      return { type: 'ron', result: await this.abortiveDraw('見なかったことに') };
    }
    if (ronDec.length) {
      ronDec.sort((a, b) => ((a.seat - from + 4) % 4) - ((b.seat - from + 4) % 4));
      const d = ronDec[0];
      return { type: 'ron', result: await this.finishWin(d.p, tileId, d.opt.ron, this.players[from]) };
    }
    for (const d of decisions) {
      if (d.act.type === 'pass' && d.opt.ron) {
        d.p.passedTiles.push(kind);
        this.updateFuriten(d.p);
      }
    }
    const call = decisions.find((d) => ['pon', 'kan'].includes(d.act.type))
      || decisions.find((d) => d.act.type === 'chi');
    if (!call) return null;

    const p = call.p;
    const used = call.act.tiles;
    p.hand = p.hand.filter((id) => !used.includes(id));
    const type = call.act.type === 'kan' ? 'minkan' : call.act.type;
    p.melds.push({ type, tile: kind, tiles: used.concat([tileId]), from });
    this.players[from].discards.pop();
    this.lastCall = { seat: p.seat, type };
    const forbid = new Set([kind]);
    if (type === 'chi') {
      const ks = used.map(Engine.kindOf).sort((a, b) => a - b);
      if (ks[0] === kind + 1 && ks[1] === kind + 2 && kind % 9 <= 5) forbid.add(kind + 3);
      if (ks[0] === kind - 2 && ks[1] === kind - 1 && kind % 9 >= 3) forbid.add(kind - 3);
    }
    for (const q of this.players) q.ippatsu = false;
    const label = { pon: 'ポン', chi: 'チー', minkan: 'カン' }[type];
    await this.io.event(`${p.name} ${label}`, 700, { seat: p.seat, kind: 'call' });
    this.io.update();
    return { type: 'call', seat: p.seat, kan: type === 'minkan', forbid };
  }

  aiCallAction(p, opt, tileId) {
    if (opt.ron) return { type: 'ron' };
    if (opt.kan && AI.shouldKan(this, p, 'minkan')) return { type: 'kan', tiles: opt.kan };
    if (opt.pon && AI.shouldCall(this, p, tileId, 'pon', opt.pon)) return { type: 'pon', tiles: opt.pon };
    for (const t of opt.chi) {
      if (AI.shouldCall(this, p, tileId, 'chi', t)) return { type: 'chi', tiles: t };
    }
    return { type: 'pass' };
  }

  async checkChankan(kanPlayer, tileId) {
    const kind = Engine.kindOf(tileId);
    for (let i = 1; i <= 3; i++) {
      const p = this.players[(kanPlayer.seat + i) % 4];
      this.updateFuriten(p);
      if (p.furiten || p.furitenPermanent) continue;
      const res = this.canWin(p, kind, tileId, { tsumo: false, chankan: true });
      if (!res) continue;
      let act;
      if (p.isAI) act = { type: 'ron' };
      else act = await this.io.askCall(p, { ron: res, pon: null, kan: null, chi: [] }, tileId, kanPlayer.seat);
      if (act.type === 'ron') {
        const meld = kanPlayer.melds.find((m) => m.type === 'kakan' && m.tile === kind);
        meld.type = 'pon';
        meld.tiles = meld.tiles.filter((x) => x !== tileId);
        return await this.finishWin(p, tileId, res, kanPlayer);
      }
      p.passedTiles.push(kind);
    }
    return null;
  }

  /* ---------- 和了処理 ---------- */
  async finishWin(winner, winId, result, loser) {
    const payments = [];
    const isDealer = winner.seat === this.dealer;
    const s = result.score;
    if (!loser) {
      for (const p of this.players) {
        if (p === winner) continue;
        const amt = isDealer ? s.each : (p.seat === this.dealer ? s.oya : s.ko);
        p.score -= amt;
        payments.push({ seat: p.seat, amount: -amt });
      }
      winner.score += s.total;
    } else {
      let payer = loser;
      if (this.cheat && loser.seat === 0 && this.cheat.scapegoat !== null
          && this.cheat.scapegoat !== undefined && this.cheat.scapegoat !== winner.seat) {
        payer = this.players[this.cheat.scapegoat];
        this.cheat.scapegoat = null;
      }
      payer.score -= s.total;
      winner.score += s.total;
      payments.push({ seat: payer.seat, amount: -s.total });
    }
    winner.score += this.riichiSticks * 1000;
    const sticks = this.riichiSticks;
    this.riichiSticks = 0;

    await this.io.result({
      type: 'win', winner, loser, result, winId, payments, sticks,
      hand: winner.hand.slice(), melds: winner.melds.slice(),
      doraIndicators: this.doraIndicators.slice(),
      uraIndicators: (winner.riichi ? this.uraIndicators.slice(0, this.doraIndicators.length) : []),
    });

    const renchan = winner.seat === this.dealer;
    return this.nextKyoku(renchan, false);
  }

  async exhaustiveDraw() {
    const tenpai = [];
    for (const p of this.players) {
      const st = Engine.shanten(this.handCounts(p), p.melds);
      const isTenpai = st === 0 && Engine.winningTiles(this.handCounts(p), p.melds).length > 0;
      p.tenpaiAtDraw = isTenpai;
      if (isTenpai) tenpai.push(p);
    }
    const n = tenpai.length;
    if (n > 0 && n < 4) {
      const gain = 3000 / n, loss = 3000 / (4 - n);
      for (const p of this.players) p.score += p.tenpaiAtDraw ? gain : -loss;
    }
    await this.io.result({ type: 'draw', reason: '流局', tenpai: this.players.map((p) => p.tenpaiAtDraw) });
    const dealerTenpai = this.players[this.dealer].tenpaiAtDraw;
    return this.nextKyoku(dealerTenpai, true);
  }

  async abortiveDraw(reason) {
    await this.io.result({ type: 'draw', reason, tenpai: null });
    return this.nextKyoku(true, true);
  }

  nextKyoku(renchan, isDraw) {
    if (this.players.some((p) => p.score < 0)) { this.finished = true; return 'end'; }
    if (renchan) {
      this.honba++;
      if (this.kyoku > this.maxKyoku) { this.finished = true; return 'end'; }
      return 'continue';
    }
    this.honba = isDraw ? this.honba + 1 : 0;
    this.kyoku++;
    this.dealer = (this.dealer + 1) % 4;
    if (this.kyoku > this.maxKyoku) { this.finished = true; return 'end'; }
    if (this.kyoku > 4) this.bakaze = 28;
    return 'continue';
  }

  async run() {
    while (!this.finished) {
      const r = await this.playHand();
      if (r === 'end') break;
    }
    await this.io.gameOver(this.rankings());
  }

  rankings() {
    return this.players
      .map((p) => ({ seat: p.seat, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }
}
if (typeof module !== 'undefined') module.exports = { Game, KAZE, SEAT_LABEL };
