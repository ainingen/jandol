/* ============================================================
   画面表示と入力
   ============================================================ */

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 名前は入力された文字がそのまま入る。innerHTML に混ぜる前に必ず通す。
   他の画面（team.js / meikan.js など）が持っているものと同じ */
const esc = (s) => String(s).replace(/[&<>"']/g,
  (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/* ---------- 牌の絵 ---------- */
const faceCache = {};

/* 牌の絵は tiles/ のSVGを読む。
   FluffyStuff / riichi-mahjong-tiles（CC0）。出典は tiles/LICENSE.txt。
   自前で描いていた頃より字も図柄も本物に近い。 */
const TILE_FILE = (() => {
  const names = [];
  for (const suit of ['Man', 'Pin', 'Sou']) {
    for (let i = 1; i <= 9; i++) names.push(suit + i);
  }
  return names.concat(['Ton', 'Nan', 'Shaa', 'Pei', 'Haku', 'Hatsu', 'Chun']);
})();
/* 赤5は専用の絵がある */
const RED_FILE = { 4: 'Man5-Dora', 13: 'Pin5-Dora', 22: 'Sou5-Dora' };

function tileFaceSVG(kind, red) {
  const key = kind + (red ? 'r' : '');
  if (faceCache[key]) return faceCache[key];
  const name = (red && RED_FILE[kind]) || TILE_FILE[kind];
  const html = `<img class="face" src="tiles/${name}.svg" alt="" draggable="false">`;
  faceCache[key] = html;
  return html;
}

function tileHTML(id, size = 'big', cls = '', data = '') {
  return `<span class="tile ${size} ${cls}" ${data}>${tileFaceSVG(kindOf(id), Engine.isRed(id))}</span>`;
}
function backHTML(size = 'small') {
  return `<span class="tile ${size} hidden-back"></span>`;
}

/* ---------- 表示 ---------- */
const UI = {
  game: null,
  pending: null,
  riichiSelect: false,
  showHints: true,
  speed: 520,
  /* 打牌の操作（spec.md §8）。'single' … 押した牌をそのまま切る（既定）。
     'double' … 一度目で選び、二度目で切る。上へスワイプはどちらでも常に効く */
  discardMode: 'single',

  /* ---------- 音 ----------
     鳴らすのは io 層（ここ）だけ。game.js には一行も足さない（spec.md §2.3）。
     早送り（speed 0）は無音。速い（200未満）は打牌とツモだけ間引く */
  sfx(name, opts) {
    if (typeof Sound === 'undefined') return;
    if (this.speed === 0) return;
    if ((name === 'discard' || name === 'draw') && this.speed < 200) return;
    Sound.play(name, opts);
  },
  /* 打牌音。同じ音が17回続くと機械音に聞こえるので、速さを毎回 ±3% 振る */
  sfxDiscard() { this.sfx('discard', { rate: 1 + (Math.random() * 2 - 1) * 0.03 }); },

  /* ツモとドラの音。render() は何度も呼ばれるので、**前回と比べて増えたときだけ**鳴らす。
     打牌の音は牌のノードの突き合わせ（reconcile）が「河に牌が増えた」瞬間に鳴らす
     ——アニメーションの開始と音の頭を揃えるため（spec.md §3.5） */
  soundDiff(g) {
    const key = g.kyoku + ':' + g.honba + ':' + g.dealer;
    if (this._sndKey !== key) {
      this._sndKey = key;
      this._sndDora = g.doraIndicators.length;
      this._sndDraw = null;
      return;
    }
    const draw = g.currentDraw ? g.currentDraw.seat + ':' + g.currentDraw.id : null;
    if (draw && draw !== this._sndDraw) this.sfx('draw');
    this._sndDraw = draw;
    if (g.doraIndicators.length > this._sndDora) this.sfx('dora');
    this._sndDora = g.doraIndicators.length;
  },

  /* ============================================================
     牌のノード（spec.md §3）

     手牌と四つの河だけ keyed にする。牌の id（0〜135）が鍵で、
     Map<id, HTMLElement> にノードを持ち、描画のたびに「あるべき並び」と
     突き合わせて、あるものは使い回し、無いものだけ作り、余ったものだけ外す。

     同じノードが手牌から河へ移るので、自分の打牌は FLIP で動かせる。
     他家の打牌は裏牌に元のノードが無いので、河に作ったノードを
     その家の手牌のあたりから飛ばし込む。

     席プレートも中央の情報も吹き出しも、今までどおり innerHTML で組み直す。
     他家の手牌（.backs）は個体差が無いので keyed にしない。
     ============================================================ */
  _nodes: null,               // Map<id, HTMLElement>
  _seq: null,                 // 前回の並び。変わったときだけ動かす

  tileNode(id) {
    if (!this._nodes) this._nodes = new Map();
    let el = this._nodes.get(id);
    if (!el) {
      el = document.createElement('span');
      el.dataset.id = String(id);
      el.innerHTML = tileFaceSVG(kindOf(id), Engine.isRed(id));
      this._nodes.set(id, el);
    }
    return el;
  },

  /* 飛んでいる最中（.moving）の印は残す。render() は飛んでいる途中にも呼ばれるので、
     className を丸ごと書くと transition と z-index が消えて、牌が立ち絵の裏に隠れる（実際に隠れた） */
  setTileClass(el, cls) {
    el.className = cls + (el.classList.contains('moving') ? ' moving' : '');
  },

  /* 河。container の子を items（{id, cls}）の並びに合わせる。
     返すのは「新しく河に入った id」——打牌の音と飛ばし込みの手掛かり */
  reconcileRiver(container, items, used) {
    const fresh = [];
    items.forEach((it, i) => {
      const el = this.tileNode(it.id);
      used.add(it.id);
      if (el.parentElement !== container) fresh.push(it.id);
      this.setTileClass(el, 'tile small ' + it.cls);
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
    });
    while (container.children.length > items.length) container.lastChild.remove();
    return fresh;
  },

  /* 手牌。牌ごとに .tilewrap で包む（危険度の帯を下に置くため）。
     包みは牌の親として付いてまわり、河へ移った牌の空の包みは末尾に押し出されて外れる */
  reconcileHand(container, items, used) {
    items.forEach((it, i) => {
      const el = this.tileNode(it.id);
      used.add(it.id);
      let w = el.parentElement;
      if (!w || !w.classList.contains('tilewrap') || w.parentElement !== container) {
        w = document.createElement('span');
        w.appendChild(el);
      }
      w.className = 'tilewrap' + (it.drawn ? ' drawn' : '');
      this.setTileClass(el, 'tile big ' + it.cls);
      const bar = w.querySelector('.hintbar');
      if (bar) bar.remove();
      if (it.bar) w.insertAdjacentHTML('beforeend', it.bar);
      if (container.children[i] !== w) container.insertBefore(w, container.children[i] || null);
    });
    while (container.children.length > items.length) container.lastChild.remove();
  },

  /* 使われなかったノードは捨てる。局をまたいで Map が育たないように */
  pruneNodes(used) {
    if (!this._nodes) return;
    for (const [id, el] of this._nodes) {
      if (used.has(id)) continue;
      if (el.parentElement) {
        const w = el.parentElement;
        el.remove();
        if (w.classList.contains('tilewrap')) w.remove();
      }
      this._nodes.delete(id);
    }
  },

  get reducedMotion() {
    if (this._rm === undefined) {
      this._rm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return this._rm;
  },
  /* 早送りと prefers-reduced-motion では動かさない。位置だけ即座に確定させる */
  get animates() { return this.speed !== 0 && !this.reducedMotion; },

  /* 位置と大きさの差分を逆向きに当ててから 0 へ遷移させる（FLIP）。
     transform は .picked や河の横向きが使うので、translate / scale の個別プロパティで動かす */
  snapRects() {
    const m = new Map();
    if (!this._nodes) return m;
    for (const [id, el] of this._nodes) {
      if (el.parentElement) m.set(id, el.getBoundingClientRect());
    }
    return m;
  },
  /* 画面上の差分を、その牌の座標系に直す（四人卓のとき）。
     左右の河は 90 度回っているので、画面の横の差は牌にとっては縦の差になる。
     卓面は rotateX で寝ているので、奥行きの差は cos ぶん詰まって見える。
     .rslot / .opp の data-angle と body.four から読む */
  localDelta(el, dx, dy) {
    const body = document.body;
    /* 回転表示（§7）のあいだは画面が 90 度回っているので、まず画面の差をレイアウトの差に戻す
       （rotate(90deg): レイアウトの (x,y) → 画面の (-y, x)。逆は (sy, -sx)） */
    if (body.classList.contains('rotated')) [dx, dy] = [dy, -dx];
    const slot = el.closest('[data-angle]');
    const four = body.classList.contains('four');
    if (!slot || !four) return [dx, dy];
    const a = (Number(slot.dataset.angle) || 0) * Math.PI / 180;
    const tilt = 36 * Math.PI / 180;
    const fx = dx, fy = dy / Math.cos(tilt);
    return [fx * Math.cos(a) + fy * Math.sin(a), -fx * Math.sin(a) + fy * Math.cos(a)];
  },
  flip(el, from, to) {
    let dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    let dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    const sx = to.width ? from.width / to.width : 1;
    const sy = to.height ? from.height / to.height : 1;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < .02 && Math.abs(sy - 1) < .02) return;
    [dx, dy] = this.localDelta(el, dx, dy);
    el.style.transition = 'none';
    el.style.translate = dx.toFixed(1) + 'px ' + dy.toFixed(1) + 'px';
    el.style.scale = sx.toFixed(3) + ' ' + sy.toFixed(3);
    el.classList.add('moving');
    void el.offsetWidth;                        // ここで一度描かせる
    el.style.transition = '';
    el.style.translate = '0px 0px';
    el.style.scale = '1 1';
    /* transitionend は transform（つまみ上げの戻り）や box-shadow でも飛んでくる。
       それで片づけると、飛んでいる途中で translate が消えて牌が瞬間移動する（実際にした）。
       translate / scale の終わりだけを見る */
    const done = (e) => {
      if (e && e.target !== el) return;
      if (e && e.propertyName !== 'translate' && e.propertyName !== 'scale') return;
      el.classList.remove('moving');
      el.style.translate = ''; el.style.scale = ''; el.style.transition = '';
      el.removeEventListener('transitionend', done);
      clearTimeout(timer);
    };
    el.addEventListener('transitionend', done);
    const timer = setTimeout(() => done(), 600);   // transitionend が来ない環境の保険
  },
  /* 他家の打牌。その家の手牌（.backs）の中心から河へ飛ばし込む */
  flyIn(el, fromEl) {
    if (!fromEl) return;
    const to = el.getBoundingClientRect();
    const f = fromEl.getBoundingClientRect();
    const from = { left: f.left + f.width / 2 - to.width * .35, top: f.top + f.height / 2 - to.height * .35,
      width: to.width * .7, height: to.height * .7 };
    this.flip(el, from, to);
  },

  render() {
    const g = this.game;
    if (!g) return;
    this.soundDiff(g);
    this._maxThreat = Math.max(0, ...g.players.slice(1).map((o) => AI.threatLevel(g, o)));
    const bySeat = (r) => g.players[r % 4];
    /* #info のテンプレートより前に置くこと。後ろに置くと TDZ で落ちる */
    const KAZE_CH = ['東', '南', '西', '北'];

    // 中央のコンパス（spec.md §4.4）。局・本場・残り・ドラ、四辺に各家の自風
    const kyokuLabel = `${KAZE[g.bakaze - 27]}${((g.kyoku - 1) % 4) + 1}局`;
    const turn = g.currentDraw ? g.currentDraw.seat
      : (g.lastDiscard ? g.lastDiscard.seat : g.dealer);
    const windAt = (seat, pos) => {
      const p = g.players[seat];
      return `<span class="wind w-${pos}${seat === g.dealer ? ' oya' : ''}${seat === 0 ? ' me' : ''}${
        seat === turn ? ' turn' : ''}">${KAZE_CH[p.jikaze - 27] || ''}</span>`;
    };
    $('#info').innerHTML = `
      <div class="kyoku">${kyokuLabel}</div>
      <div class="wall"><span>${g.honba}本場</span><span>残り${g.wall.length}枚</span></div>
      <div id="dora">${g.doraIndicators.map((d) => tileHTML(d, 'tiny')).join('')}</div>
      ${g.riichiSticks ? `<div class="sticks">${'<span class="riichi-stick"></span>'.repeat(Math.min(g.riichiSticks, 4))}</div>` : ''}
      ${g.cheat ? `<div class="cheatinfo">疑い ${'●'.repeat(g.cheat.suspicion) || '無'}
        ／ 技 ${g.cheat.hand.length}枚</div>` : ''}
      ${g.cheat && g.cheat.peek ? `<div class="peek">山 ${g.cheat.peek.map((id) => tileHTML(id, 'tiny')).join('')}</div>` : ''}
      ${windAt(0, 'b')}${windAt(1, 'r')}${windAt(2, 't')}${windAt(3, 'l')}`;

    // 席プレート（§4.5）。名前・自風・点数・顔。自分のぶん（#plate-bottom）は色を反転させてある
    const c = g.cheat;
    /* 局の締め（agari-spec.md §3・§6）。倒す手・当たり牌・テンパイの印。
       **イカサマの reveal と同じ経路に相乗りしている**——別の道を作らない */
    const end = this._end;
    const plateHTML = (p) => `
      <span class="kz">${KAZE_CH[p.jikaze - 27] || ''}</span>
      <span class="bust">${p.face ? `<img src="${esc(p.face)}" alt="" onerror="this.remove()">` : ''}</span>
      <span class="txt"><span class="nm">${esc(p.name)}</span><span class="pt">${p.score}</span></span>
      ${p.riichi ? '<span class="rc">立</span>' : ''}
      ${p.suspicion ? '<span class="susp">疑</span>' : ''}
      ${end && end.tenpai
        ? `<span class="tp${end.tenpai[p.seat] ? '' : ' no'}">${end.tenpai[p.seat] ? 'テンパイ' : 'ノーテン'}</span>`
        : ''}`;
    [['#plate-bottom', 0], ['#plate-right', 1], ['#plate-top', 2], ['#plate-left', 3]].forEach(([sel, seat]) => {
      const el = $(sel);
      if (!el) return;
      const p = bySeat(seat);
      el.innerHTML = plateHTML(p);
      el.classList.toggle('dealer', seat === g.dealer);
      el.classList.toggle('riichi', !!p.riichi);
      el.classList.toggle('turn', seat === turn);
      /* 締めのあいだはカットインを消しているので、喋っている印も出さない。
         代わりに主役の席へ .star を付けて、立ち絵と一組に見せる */
      el.classList.toggle('talking', !end && this._cutinSeat === seat);
      el.classList.toggle('star', !!end && end.star === seat);
    });

    // 他家の手牌（裏）と副露。プレートは別なので、ここは牌だけ
    const oppHTML = (p) => `
        <div class="backs${end && end.reveal.has(p.seat) ? ' shown' : ''}">${
          (c && c.reveal.has(p.seat)) || (end && end.reveal.has(p.seat))
            ? p.hand.slice().sort((a, b) => kindOf(a) - kindOf(b)).map((id) => tileHTML(id, 'tiny')).join('')
            : Array(Math.max(0, p.hand.length)).fill(backHTML('tiny')).join('')}</div>
        ${c && c.showWaits.has(p.seat) ? `<div class="waits">待${
          Engine.winningTiles(Engine.countsFromIds(p.hand), p.melds).map(jpName).join('') || '無'}</div>` : ''}
        <div class="melds">${p.melds.map((m) => meldHTML(m, 'tiny', p.seat)).join('')}</div>`;
    $('#top').innerHTML = oppHTML(bySeat(2));
    $('#left').innerHTML = oppHTML(bySeat(3));
    $('#right').innerHTML = oppHTML(bySeat(1));

    // 河と手牌（keyed。spec.md §3）
    const me = g.players[0];
    $('#melds-row').innerHTML = me.melds.map((m) => meldHTML(m, 'small', 0)).join('');
    const drawn = g.currentDraw && g.currentDraw.seat === 0 ? g.currentDraw.id : null;
    const hand = me.hand.filter((id) => id !== drawn);
    const selectable = this.pending && this.pending.type === 'turn';
    const allowed = this.allowedDiscards();
    const handItems = hand.concat(drawn !== null ? [drawn] : []).map((id) => {
      const ok = selectable && (!allowed || allowed.has(id));
      const isDrawn = id === drawn;
      return {
        id, drawn: isDrawn,
        cls: (this._selected === id ? 'picked ' : '') + (ok ? 'selectable ' : (selectable ? 'dim ' : ''))
          + (isDrawn ? 'drawn' : ''),
        bar: ok ? this.hintBar(id) : '',
      };
    });
    const riverItems = (p) => p.discards.map((d, i) => {
      const last = g.lastDiscard && g.lastDiscard.seat === p.seat && i === p.discards.length - 1;
      const hit = end && end.winId !== null && d.id === end.winId;
      return { id: d.id, cls: (d.riichi ? 'riichi ' : '') + (d.tsumogiri ? 'tsumogiri ' : '')
        + (hit ? 'hit ' : '') + (last ? 'last' : '') };
    });
    const rivers = [
      ['#river-bottom', bySeat(0)], ['#river-right', bySeat(1)], ['#river-top', bySeat(2)], ['#river-left', bySeat(3)],
    ].map(([sel, p]) => ({ el: $(sel), p, items: riverItems(p) }));

    /* 並びが変わったときだけ、動かす前の位置を控える。
       毎回の描画で animation を仕掛けると画面が痙攣する */
    const seq = handItems.map((it) => it.id).join(',') + '|' + rivers.map((r) => r.items.map((it) => it.id).join(',')).join('|');
    const changed = seq !== this._seq;
    const sameKyoku = this._seqKyoku === g.kyoku + ':' + g.honba + ':' + g.dealer;
    this._seq = seq;
    this._seqKyoku = g.kyoku + ':' + g.honba + ':' + g.dealer;
    const before = changed && sameKyoku && this.animates ? this.snapRects() : null;

    const used = new Set();
    this.reconcileHand($('#handrow'), handItems, used);
    const freshBySeat = rivers.map((r) => this.reconcileRiver(r.el, r.items, used));
    this.pruneNodes(used);

    /* 河に牌が増えた瞬間に鳴らす。局の頭（河が空になったところ）では鳴らない */
    if (changed && sameKyoku && freshBySeat.some((f) => f.length)) this.sfxDiscard();

    if (before) {
      for (const [id, el] of this._nodes) {
        if (!el.parentElement) continue;
        const prev = before.get(id);
        if (prev) { this.flip(el, prev, el.getBoundingClientRect()); continue; }
        /* 元のノードが無い＝他家の打牌。その家の手牌から飛ばし込む */
        const seat = freshBySeat.findIndex((f) => f.includes(id));
        if (seat > 0) this.flyIn(el, $(['#river-bottom', '#right', '#top', '#left'][seat] + ' .backs'));
      }
    }

    const handrow = $('#handrow');
    if (!handrow.onclick) {
      /* ポインタで片づけた直後の click は捨てる（実クリックは pointerup のあとに来る）。
         残してあるのは `element.click()` の合成クリックとポインタを持たない環境のため */
      handrow.onclick = (e) => {
        if (this._handledAt && Date.now() - this._handledAt < this.HANDLED_MS) return;
        const t = e.target.closest('.tile.selectable');
        if (t) this.onTileClick(+t.dataset.id);
      };
      this.bindHand(handrow);
    }
    this.renderCutin();
    this.renderHintText();
  },

  hintBar(id) {
    const forced = this.game.cheat && this.game.cheat.forceHints;
    if ((!this.showHints && !forced) || this._maxThreat < 0.5) return '';
    const g = this.game;
    const d = AI.totalDanger(g, g.players[0], kindOf(id));
    const c = d === 0 ? '#2e7d5b' : d < 2 ? '#b6a12e' : d < 5 ? '#c47b2a' : '#c0392b';
    return `<span class="hintbar" style="background:${c}"></span>`;
  },

  renderHintText() {
    const g = this.game, me = g.players[0];
    if (!this.pending || this.pending.type !== 'turn') { $('#hintbox').textContent = ''; return; }
    /* 掴んでいる牌の名前。**一度押しでも出す**——押している間に何を掴んだかが
       見えることが、離して確定する形の要（spec.md §8） */
    if (this._selected !== null && this._selected !== undefined) {
      $('#hintbox').textContent = jpName(kindOf(this._selected))
        + (this.discardMode === 'double' ? ' — もう一度たたくと切る' : ' — 指を離すと切る');
      return;
    }
    if (!this.showHints) { $('#hintbox').textContent = ''; return; }
    const c = Engine.countsFromIds(me.hand);
    const n = me.hand.length % 3 === 2 ? 1 : 0;
    let s;
    if (n) {
      let bestS = 9;
      for (let k = 0; k < 34; k++) { if (!c[k]) continue; c[k]--; bestS = Math.min(bestS, Engine.shanten(c, me.melds)); c[k]++; }
      s = bestS;
    } else s = Engine.shanten(c, me.melds);
    const label = s < 0 ? '和了' : s === 0 ? 'テンパイ' : `${s}シャンテン`;
    const threat = g.players.slice(1).some((p) => p.riichi) ? ' ・ 他家リーチ中' : '';
    const furiten = me.furiten || me.furitenPermanent ? ' ・ フリテン' : '';
    $('#hintbox').textContent = label + threat + furiten;
  },

  allowedDiscards() {
    if (!this.pending || this.pending.type !== 'turn') return null;
    const g = this.game, me = g.players[0], opts = this.pending.options;
    let set = null;
    if (this.riichiSelect) {
      set = new Set();
      const c = Engine.countsFromIds(me.hand);
      for (const id of me.hand) {
        const k = kindOf(id);
        c[k]--;
        if (Engine.shanten(c, me.melds) === 0 && Engine.winningTiles(c, me.melds).length) set.add(id);
        c[k]++;
      }
      return set;
    }
    if (me.riichi) {
      const drawn = g.currentDraw && g.currentDraw.seat === 0 ? g.currentDraw.id : null;
      return new Set(drawn === null ? [] : [drawn]);
    }
    if (opts.forbid && opts.forbid.size) {
      set = new Set(me.hand.filter((id) => !opts.forbid.has(kindOf(id))));
    }
    return set;
  },

  onTileClick(id, force) {
    if (!this.pending || this.pending.type !== 'turn') return;
    if (!this.game.players[0].hand.includes(id)) return;     // 河の牌は押せない
    const allowed = this.allowedDiscards();
    if (allowed && !allowed.has(id)) return;
    /* 二度押しの設定では一度目は選ぶだけ。スワイプ（force）は設定に関係なく切る */
    if (this.discardMode === 'double' && !force && this._selected !== id) {
      this._selected = id;
      this.render();
      return;
    }
    const type = this.riichiSelect ? 'riichi' : 'discard';
    this.riichiSelect = false;
    this._selected = null;
    this.resolve({ type, tile: id });
  },

  /* 打牌の操作（spec.md §8）。**確定は「押した瞬間」ではなく「離した瞬間」。**

     実機で出た問題：指の接地は 9〜10mm あり、**横持ちの牌幅（43px。SE では 30px、
     縦持ちは 26px）より広い。**当たり判定を広げても隣が狭くなるだけで直らない。
     いまは離した瞬間に初めて何を切ったか分かるので、気づいたときには終わっている。

     そこで、押している間は選び直せるようにした。

       pointerdown … 指の下の牌が持ち上がる（**切る前に何を掴んだか見える**）
       pointermove … 持ち上がる牌が指の下の牌に追随する（横へずらせば直せる）
       pointerup   … そのとき持ち上がっている牌を切る
       帯の外で離す … 取り消し（特に下方向）
       上へ払う     … いままでどおり即座に切る

     **一動作で切れる手触りは変わらない。**iOS のキーボードと同じ仕組み。
     `discardMode` の `single` / `double` の関係は変えていない——これは `single` の中身。
     `double` は「押している間は選び直せる」が乗るだけで、確定はいままでどおり二度目。

     #handrow に一度だけ仕掛ける（牌のノードは使い回されるので、牌ごとに付けると
     付け忘れが出る）。**click は残してある**——`element.click()` の合成クリック
     （`tools/drive-match.js` が使う）と、ポインタを持たない環境のため。
     ポインタで片づけた直後の click は `_handledAt` で捨てる */
  SWIPE_PX: 24,
  HANDLED_MS: 500,

  /* 指の下にある「切れる牌」。帯の外なら null。
     **座標から引くこと**——pointermove の e.target は最初に触れた牌のままになる */
  tileAt(x, y) {
    if (typeof document.elementFromPoint !== 'function') return null;
    const el = document.elementFromPoint(x, y);
    const t = el && el.closest ? el.closest('#handrow .tile.selectable') : null;
    return t ? +t.dataset.id : null;
  },

  bindHand(handrow) {
    if (handrow._handBound) return;
    handrow._handBound = true;
    let drag = null;

    const lift = (id) => {
      if (this._selected === id) return;
      this._selected = id;
      this.render();
    };

    handrow.addEventListener('pointerdown', (e) => {
      if (!this.pending || this.pending.type !== 'turn') { drag = null; return; }
      const id = this.tileAt(e.clientX, e.clientY);
      if (id === null) { drag = null; return; }
      /* **gesture の前に何が選ばれていたか**を控える。二度押しの判定に使う */
      drag = { pid: e.pointerId, x: e.clientX, y: e.clientY, was: this._selected, last: id };
      lift(id);
      try { handrow.setPointerCapture(e.pointerId); } catch (err) { /* 無くても動く */ }
    });

    handrow.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      const id = this.tileAt(e.clientX, e.clientY);
      if (id !== null) drag.last = id;
      lift(id);                       // 帯の外へ出たら null＝持ち上がりが消える
    });

    const finish = (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      const d = drag;
      drag = null;
      this._handledAt = Date.now();
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      /* 回転表示のあいだは画面の「上」がレイアウトの「右」になる（rotate(90deg)） */
      const up = document.body.classList.contains('rotated') ? dx : -dy;
      const side = document.body.classList.contains('rotated') ? Math.abs(dy) : Math.abs(dx);
      if (up >= this.SWIPE_PX && up > side) {
        this._selected = null;
        this.onTileClick(d.last, true);            // 上へ払う＝設定に関係なく切る
        return;
      }
      const over = this.tileAt(e.clientX, e.clientY);
      if (over === null) {                         // 帯の外で離した＝取り消し
        this._selected = d.was;
        this.render();
        return;
      }
      /* 二度押しは「この gesture の前から選ばれていた牌」でだけ確定する */
      if (this.discardMode === 'double' && d.was !== over) {
        this._selected = over;
        this.render();
        return;
      }
      this._selected = null;
      this.onTileClick(over, true);
    };
    handrow.addEventListener('pointerup', finish);
    handrow.addEventListener('pointercancel', (e) => {
      if (!drag || e.pointerId !== drag.pid) return;
      const was = drag.was;
      drag = null;
      this._handledAt = Date.now();
      this._selected = was;
      this.render();
    });
  },

  /* ============================================================
     セリフのカットイン（spec.md §6）

     喋った人の写真を上の角に出し、吹き出しを添える。
     左側の席（上家・自分）は左上、右側の席（下家・対面）は右上。
     同時に席プレートを光らせるので、誰が喋ったかは写真・名前・プレートの三つで分かる。

     吹き出しは「そこから四回捨てられるまで」残す。時間ではなく
     捨て牌の数で測るので、早送りでも自分の手番でも同じだけ残る。

     SERIFU 側は触らない。chara 19種を鍵にする仕組みも場面11種もそのまま。
     ============================================================ */
  BUBBLE_TURNS: 4,          // 吹き出しが残る長さ（捨て牌の数）
  HOT_KINDS: ['riichi', 'tsumo', 'ron'],   // 吹き出しの地を差し色にする場面
  PLATE_IDS: ['plate-bottom', 'plate-right', 'plate-top', 'plate-left'],

  /* 場に出ている捨て牌の総数。吹き出しを引っ込める目安に使う */
  discardCount() {
    const g = this.game;
    if (!g) return 0;
    let n = 0;
    for (const p of g.players) n += p.discards.length;
    return n;
  },

  /* 一言を出す。名前は入力された文字が入るので textContent で入れること */
  say(seat, kind, hold) {
    if (typeof SERIFU === 'undefined') return;
    const g = this.game;
    const box = $('#cutin');
    if (!g || !box) return;
    const p = g.players[seat];
    if (!p) return;
    const line = SERIFU.pick(p.chara, kind);
    if (!line) return;

    const img = box.querySelector('img');
    if (p.face) { img.src = p.face; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
    box.querySelector('.who').textContent = p.name || '';
    box.querySelector('.line').textContent = line;
    box.dataset.side = (seat === 0 || seat === 3) ? 'left' : 'right';
    box.classList.toggle('hot', this.HOT_KINDS.includes(kind));
    box.classList.add('on');
    /* 喋った人の席プレートも光らせる */
    this._cutinSeat = seat;
    document.querySelectorAll('#table .seat').forEach((el) => {
      el.classList.toggle('talking', el.id === this.PLATE_IDS[seat]);
    });
    /* 放銃の一言（hold）は長めに残す */
    this._sayAt = this.discardCount();
    this._sayFor = hold ? this.BUBBLE_TURNS + 3 : this.BUBBLE_TURNS;
    this._sayKyoku = g.kyoku;
  },

  /* 時間切れで引っ込める。四回捨てられたか、局が変わったら */
  renderCutin() {
    const g = this.game;
    const box = $('#cutin');
    if (!g || !box) return;
    if (this._sayAt !== null && this._sayAt !== undefined) {
      const past = this.discardCount() - this._sayAt;
      if (past >= this._sayFor || this._sayKyoku !== g.kyoku) {
        box.classList.remove('on', 'hot');
        this._sayAt = null;
        this._cutinSeat = null;
        document.querySelectorAll('#table .seat.talking').forEach((el) => el.classList.remove('talking'));
      }
    }
    const turn = g.currentDraw ? g.currentDraw.seat
      : (g.lastDiscard ? g.lastDiscard.seat : g.dealer);
    this.maybeIdle(turn);
  },

  /* 手番がまわってきたときだけ、たまに雑談させる。
     毎回だと喋りっぱなしでうるさい */
  maybeIdle(seat) {
    const g = this.game;
    if (!g || typeof SERIFU === 'undefined') return;
    if (this._idleSeat === seat && this._idleKyoku === g.kyoku) return;
    this._idleSeat = seat; this._idleKyoku = g.kyoku;
    /* 喋っている最中は割り込ませない */
    if (this._sayAt !== null && this._sayAt !== undefined) return;
    if (Math.random() < 0.18) this.say(seat, 'idle');
  },

  resolve(action) {
    this._selected = null;
    const p = this.pending;
    this.pending = null;
    $('#actions').innerHTML = '';
    this.render();
    if (p) p.resolve(action);
  },

  /* ---- おまかせ（対局を最後まで自動で進める） ----
     game.js はどの判断も p.isAI を見て分岐しているので、
     自分の席を isAI にすれば以降は全部CPUが打つ。
     いま入力待ちで止まっている一手だけは、ここで解いてやる必要がある。
     解かずに isAI にしても、待っている Promise は誰も解決しない  */
  giveUp(speed) {
    const g = this.game;
    if (!g || this.auto) return;
    this.auto = true;
    g.players[0].isAI = true;
    if (speed !== undefined) this.speed = speed;
    const pend = this.pending;
    if (!pend) return;
    const me = g.players[0];
    /* game.js の思考をそのまま借りる。自前で「ツモ切り」にすると、
       鳴いた直後（ツモ牌が無く drawnId が null）に打てない牌を選んでしまう */
    try {
      if (pend.type === 'turn') {
        this.resolve(g.aiTurnAction(me, pend.options, pend.drawnId, null));
      } else {
        this.resolve(g.aiCallAction(me, pend.opt, pend.tileId));
      }
    } catch (e) {
      /* 思考が転んでも対局は続ける。和了れるなら和了り、駄目なら見送る */
      if (pend.type === 'turn' && pend.options && pend.options.tsumo) this.resolve({ type: 'tsumo' });
      else if (pend.type === 'call' && pend.opt && pend.opt.ron) this.resolve({ type: 'ron' });
      else if (pend.type === 'call') this.resolve({ type: 'pass' });
      else this.resolve({ type: 'discard', tile: pend.drawnId !== null && pend.drawnId !== undefined
        ? pend.drawnId : me.hand[me.hand.length - 1] });
    }
  },

  buttons(list) {
    const bar = $('#actions');
    bar.innerHTML = '';
    for (const b of list) {
      const el = document.createElement('button');
      el.className = 'act' + (b.primary ? ' primary' : '') + (b.ghost ? ' ghost' : '');
      el.innerHTML = b.label;
      el.onclick = () => { this.sfx('tap'); b.onClick(); };
      bar.appendChild(el);
    }
  },

  /* ---- 手番の入力 ---- */
  askTurn(p, options, drawnId) {
    return new Promise((resolve) => {
      this.pending = { type: 'turn', options, resolve, drawnId };
      this.riichiSelect = false;
      this._selected = null;
      const btns = [];
      if (options.tsumo) btns.push({ label: 'ツモ', primary: true, onClick: () => this.resolve({ type: 'tsumo' }) });
      if (options.riichi) {
        btns.push({
          label: 'リーチ',
          onClick: () => {
            this.riichiSelect = true;
            this._selected = null;
            this.render();
            this.buttons([{ label: 'やめる', ghost: true, onClick: () => { this.riichiSelect = false; this.askTurnButtons(options); this.render(); } }]);
          },
        });
      }
      for (const k of options.ankan) btns.push({ label: '暗槓', onClick: () => this.resolve({ type: 'ankan', tile: k }) });
      for (const k of options.kakan) btns.push({ label: '加槓', onClick: () => this.resolve({ type: 'kakan', tile: k }) });
      if (options.kyuushu) btns.push({ label: '九種九牌', onClick: () => this.resolve({ type: 'kyuushu' }) });
      this._turnButtons = btns;
      this.buttons(btns);
      this.render();

      // リーチ後は自動でツモ切り
      if (p.riichi && !options.tsumo && !options.ankan.length) {
        setTimeout(() => {
          if (this.pending && this.pending.resolve === resolve) this.resolve({ type: 'discard', tile: drawnId });
        }, this.speed);
      }
    });
  },
  askTurnButtons(options) { this.buttons(this._turnButtons || []); },

  /* ---- 鳴き・ロンの入力 ---- */
  askCall(p, opt, tileId, from) {
    return new Promise((resolve) => {
      this.pending = { type: 'call', resolve, opt, tileId };
      const btns = [];
      if (opt.ron) btns.push({ label: 'ロン', primary: true, onClick: () => this.resolve({ type: 'ron' }) });
      if (opt.kan) btns.push({ label: 'カン', onClick: () => this.resolve({ type: 'kan', tiles: opt.kan }) });
      if (opt.pon) btns.push({ label: 'ポン', onClick: () => this.resolve({ type: 'pon', tiles: opt.pon }) });
      if (opt.chi.length === 1) {
        btns.push({ label: 'チー', onClick: () => this.resolve({ type: 'chi', tiles: opt.chi[0] }) });
      } else if (opt.chi.length > 1) {
        for (const t of opt.chi) {
          const label = 'チー ' + t.map((id) => jpName(kindOf(id))).join('');
          btns.push({ label, onClick: () => this.resolve({ type: 'chi', tiles: t }) });
        }
      }
      btns.push({ label: 'パス', ghost: true, onClick: () => this.resolve({ type: 'pass' }) });
      this.buttons(btns);
      this.render();
    });
  },

  async event(text, ms, who) {
    const t = $('#toast');
    t.textContent = text;
    /* 帯の色。**リーチは鳴きと分ける**——白はこの作品で「リーチ」を表す色
       （席プレートの枠・立の札・供託の棒）なので、帯だけ別の色だと二つになる */
    t.className = 'show' + (/リーチ/.test(text) ? ' riichi'
      : (/ポン|チー|カン|暗槓|加槓/.test(text) ? ' call' : ''));
    /* game.js が「誰が・何を」を添えてくる。添えて来ない呼び出しもあるので、
       あるときだけ喋らせる */
    if (who && who.kind) this.say(who.seat, who.kind);
    if (who && who.kind === 'riichi') this.sfx('riichi');
    else if (who && who.kind === 'call') this.sfx('call');
    await sleep(ms || 700);
    t.className = '';
    await sleep(120);
  },

  /* ============================================================
     局の締め（docs/design/match/agari-spec.md）

     箱で覆うのをやめて、**卓を残したまま下に帯を出す。**
     画面は四つある——自分がツモ／自分がロン／自分が振り込み／他家同士。
     一番大きい数字は**常にプレイヤー自身の増減**（§2）。
     和了った人の合計点ではない——放銃したときに相手の12000が大きく出て、
     負けたほうが派手に見えていた
     ============================================================ */

  /* 四分岐。**色替えではなく四つの別の画面**（§1） */
  endKind(data) {
    if (data.type !== 'win') return 'draw';
    if (data.winner.seat === 0) return data.loser ? 'ron' : 'tsumo';
    if (data.loser && data.loser.seat === 0) return 'dealin';
    return 'other';
  },

  /* 席ごとの増減。**payments は「誰がいくら払ったか」で、和了った人は入っていない**
     （game.js の finishWin）。流局は payments に全員ぶんが入っている（agari-spec.md §10） */
  endDeltas(data) {
    const d = [0, 0, 0, 0];
    (data.payments || []).forEach((pm) => { d[pm.seat] += pm.amount; });
    if (data.type === 'win') {
      d[data.winner.seat] += data.result.score.total + (data.sticks || 0) * 1000;
    }
    return d;
  },

  /* 主役の立ち絵を出す側。**カットイン（say）と同じ式**——
     同じ人が会話と締めで左右に飛ばないように */
  endSide(seat) { return (seat === 0 || seat === 3) ? 'left' : 'right'; },

  /* 帯を組む。**牌は再掲**で、卓の上に倒れている牌（keyed な _nodes）とは別物 */
  showEnd(kind, data) {
    const g = this.game;
    const band = $('#endband');
    const bust = $('#endbust');
    if (!band) return;
    const deltas = this.endDeltas(data);
    const me = deltas[0];

    /* --- 見出し --- */
    let head = '';
    if (kind === 'tsumo') head = '<b>ツモ和了</b>';
    else if (kind === 'ron') head = '<b>ロン和了</b>';
    else if (kind === 'dealin') head = `<b>放銃</b><i>${esc(data.winner.name)} に</i>`;
    else if (kind === 'other') {
      head = `<b>${esc(data.winner.name)}</b><i>${data.loser ? 'ロン ' + esc(data.loser.name) : 'ツモ'}</i>`;
    } else {
      const renchan = data.tenpai ? data.tenpai[g.dealer] : true;
      head = `<b>${esc(data.reason)}</b><i>${renchan ? '親は連荘' : '親が流れる'}</i>`;
    }
    band.querySelector('.ebHead').innerHTML = head;

    /* --- 和了手（誰の和了でも読める大きさで）。和了牌は離して光らせる --- */
    let tiles = '';
    if (data.type === 'win') {
      /* ツモは和了牌が data.hand に入っている。離して出すので手牌の側からは外す */
      const rest = data.hand.filter((id) => id !== data.winId).sort((a, b) => kindOf(a) - kindOf(b));
      tiles = rest.map((id) => tileHTML(id, 'small')).join('')
        + (data.melds.length ? `<span class="ebMeld">${data.melds.map((m) => meldHTML(m, 'small', data.winner.seat)).join('')}</span>` : '')
        + `<span class="ebWin">${tileHTML(data.winId, 'small', 'last')}</span>`;
    }
    band.querySelector('.ebTiles').innerHTML = tiles;

    /* --- ドラ表示・裏ドラ --- */
    let dora = '';
    if (data.type === 'win') {
      dora = `<span>ドラ ${data.doraIndicators.map((d) => tileHTML(d, 'tiny')).join('')}</span>`
        + (data.uraIndicators.length
          ? `<span>裏 ${data.uraIndicators.map((d) => tileHTML(d, 'tiny')).join('')}</span>` : '');
    } else if (data.tenpai) {
      const n = data.tenpai.filter(Boolean).length;
      dora = `<span>テンパイ ${n}人 ／ ノーテン ${4 - n}人</span>`;
    }
    band.querySelector('.ebDora').innerHTML = dora;

    /* --- 一番大きい数字＝自分の増減（§2）。ここだけは四分岐で色も向きも変わる --- */
    const d = band.querySelector('.ebDelta');
    d.dataset.dir = me > 0 ? 'up' : (me < 0 ? 'down' : 'flat');
    d.textContent = this.yenSigned(0);
    this._endTarget = me;

    /* --- 二番目：和了った人の合計。三番目：符と翻 --- */
    const r = data.result;
    band.querySelector('.ebScore').innerHTML = data.type === 'win'
      ? `<span class="who">${esc(data.winner.name)}</span><span class="v">${r.score.total}点</span>`
      : '';
    band.querySelector('.ebYaku').innerHTML = data.type === 'win'
      ? `<span class="fu">${r.fu}符 ${r.han}翻${r.score.name ? ' ' + esc(r.score.name) : ''}</span>`
        + r.yaku.map((y) => `<span class="y">${esc(y.name)}<i>${y.yakuman ? '役満' : y.han + '翻'}</i></span>`).join('')
      : '';

    /* --- 立ち絵。主役は §1 の表。振り込みの主役は「和了った相手」で、自分ではない --- */
    const star = data.type === 'win'
      ? (kind === 'dealin' || kind === 'other' ? data.winner.seat : 0)
      : g.dealer;
    const img = bust.querySelector('img');
    const sp = g.players[star];
    const face = sp ? sp.face : null;
    const app = $('#app');
    if (face) {
      img.src = face;
      /* **誰の顔かを名札で言う。**ロンの主役は自分、放銃の主役は相手で、
         立ち絵は同じ場所に出る。**顔だけでは一秒で分からない**（実際に分からなかった）。
         席プレートと同じ形の札（自風＋名前）を足元に置き、自分なら同じ桃色にする */
      const kz = ['東', '南', '西', '北'][sp.jikaze - 27] || '';
      bust.querySelector('.kz').textContent = kz;
      bust.querySelector('.nm').textContent = sp.name || '';
      bust.querySelector('.ebWho').classList.toggle('mine', star === 0);
      bust.dataset.side = this.endSide(star);
      if (app) app.classList.add('bust-' + this.endSide(star));
      bust.hidden = false;
    } else {
      bust.hidden = true;
    }
    /* 一言は帯の中に置く。**カットインは締めのあいだ消す**（§3）
       ——同じ隅で立ち絵とぶつかるのと、「専用の大きさで出す」ため。
       喋る人は立ち絵と同じ（主役）。SERIFU が無い環境では黙って空になる */
    let line = '';
    if (typeof SERIFU !== 'undefined' && sp) {
      const kindOfLine = data.type !== 'win' ? 'draw'
        : (star === data.winner.seat ? (data.loser ? 'ron' : 'tsumo') : 'deal');
      line = SERIFU.pick(sp.chara, kindOfLine) || '';
    }
    /* **自分（seat 0）には喋らせない。**この作品の主人公は事務所の側で、
       性格の一言を持っていない。自分が主役のときは、振り込んだ相手に喋らせる
       ——そこが唯一「人が出ている」ところなので、黙らせると締めから顔が消える */
    let sayer = sp;
    if (star === 0) {
      sayer = data.loser && data.loser.seat !== 0 ? g.players[data.loser.seat] : null;
      line = sayer && typeof SERIFU !== 'undefined' ? (SERIFU.pick(sayer.chara, 'deal') || '') : '';
    }
    band.querySelector('.ebLine').innerHTML = line && sayer
      ? `<span class="who">${esc(sayer.name)}</span><span class="say">${esc(line)}</span>` : '';

    band.dataset.kind = kind;
    /* 他家同士は「和了った人の点」を先頭にする（§B-1）。
       自分の増減は ±0 のとき消える——**何も起きていないことを大きく言わない** */
    band.classList.toggle('scoreLead', kind === 'other');
    band.hidden = false;
    /* 自分の席プレートが帯に食われる（点数が動くのはそこなので隠れてはいけない）。
       **帯の高さ − 手牌の帯の高さ**だけ持ち上げる。決め打ちにすると端末で食われる */
    const my = $('#myarea');
    if (app && my) {
      app.style.setProperty('--eb-lift',
        Math.max(0, band.offsetHeight - my.offsetHeight + 8) + 'px');
    }
    $('#app').classList.add('ending', 'end-' + kind);
    /* 冷たい膜は振り込みのときだけ。filter を使わない（3D が潰れる） */
    const tint = document.querySelector('.endTint');
    if (tint) tint.hidden = kind !== 'dealin';
    /* 帯と立ち絵を入れる。上がるか降りるかは CSS（.end-* が向きを持つ） */
    void band.offsetWidth;
    band.classList.add('on');
    if (!bust.hidden) bust.classList.add('on');
  },

  hideEnd() {
    const band = $('#endband');
    const bust = $('#endbust');
    if (band) { band.classList.remove('on'); band.hidden = true; }
    if (bust) { bust.classList.remove('on'); bust.hidden = true; }
    const tint = document.querySelector('.endTint');
    if (tint) tint.hidden = true;
    const app = $('#app');
    if (app) {
      app.style.removeProperty('--eb-lift');
      [...app.classList].forEach((c) => {
        if (c === 'ending' || c.startsWith('end-') || c.startsWith('bust-')) app.classList.remove(c);
      });
    }
    const host = $('#sticks');
    if (host) host.innerHTML = '';
    this._end = null;
    this._endTarget = 0;
  },

  yenSigned(v) { return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(Math.round(v)); },

  /* 席プレートの点数を書き換える。**render() を通さない**
     ——render は p.score（＝支払い後）を読むので、飛んでいる最中の値が消える */
  setPlateScore(seat, v) {
    const id = this.PLATE_IDS[seat];
    const el = id ? $('#' + id) : null;
    const pt = el && el.querySelector('.pt');
    if (pt) pt.textContent = String(Math.round(v));
  },

  /* 点棒を飛ばす（§5）。払う人のプレートから、受け取る人のプレートへ。
     供託のリーチ棒は中央（#info）から和了った人へ。
     **飛んでいる間にプレートの数字が動き、着地した瞬間に最終値になる。**

     最速（speed 0）と prefers-reduced-motion では飛ばさず、即座に確定させる。
     途中でどこかを押したら、その場で確定させる（this._endSettle） */
  async flyScores(data, deltas) {
    const g = this.game;
    const host = $('#sticks');
    /* 支払い後の値が届いているので、飛ばす前の値へ戻す（agari-spec.md §10） */
    const after = g.players.map((p) => p.score);
    const before = after.map((v, i) => v - deltas[i]);
    for (let i = 0; i < 4; i++) this.setPlateScore(i, before[i]);
    const band = $('#endband');
    const dband = band && band.querySelector('.ebDelta');

    const settle = () => {
      for (let i = 0; i < 4; i++) this.setPlateScore(i, after[i]);
      if (dband) dband.textContent = this.yenSigned(this._endTarget);
      if (host) host.innerHTML = '';
    };
    if (!this.animates || !host) { settle(); return; }

    /* 誰から誰へ。和了は payers → winner、流局は ノーテン → テンパイ の総当たり */
    const pairs = [];
    if (data.type === 'win') {
      (data.payments || []).forEach((pm) => {
        pairs.push({ from: pm.seat, to: data.winner.seat, oya: pm.seat === g.dealer });
      });
      for (let i = 0; i < Math.min(data.sticks || 0, 4); i++) {
        pairs.push({ from: null, to: data.winner.seat, kept: true });
      }
    } else {
      const pays = (data.payments || []).filter((pm) => pm.amount < 0);
      const gets = (data.payments || []).filter((pm) => pm.amount > 0);
      pays.forEach((a) => gets.forEach((b) => pairs.push({ from: a.seat, to: b.seat })));
    }
    if (!pairs.length) { settle(); return; }

    const hostRect = host.getBoundingClientRect();
    const at = (sel) => {
      const el = $(sel);
      if (!el) return [0, 0];
      const r = el.getBoundingClientRect();
      let x = r.left + r.width / 2 - (hostRect.left + hostRect.width / 2);
      let y = r.top + r.height / 2 - (hostRect.top + hostRect.height / 2);
      /* 回転表示中は画面が90度回っている。画面の差をレイアウトの差へ戻す（flip と同じ式） */
      if (document.body.classList.contains('rotated')) [x, y] = [y, -x];
      return [x, y];
    };
    const seatAt = (seat) => at('#' + this.PLATE_IDS[seat]);

    const nodes = pairs.map((pr) => {
      const el = document.createElement('span');
      el.className = 'ptStick' + (pr.oya ? ' oya' : '') + (pr.kept ? ' kept' : '');
      const [x0, y0] = pr.from === null ? at('#info') : seatAt(pr.from);
      const [x1, y1] = seatAt(pr.to);
      el.style.translate = x0.toFixed(1) + 'px ' + y0.toFixed(1) + 'px';
      host.appendChild(el);
      return { el, x1, y1 };
    });
    void host.offsetWidth;
    const ms = Math.max(320, Math.min(560, this.speed || 520));
    nodes.forEach((n) => {
      n.el.style.transition = `translate ${ms}ms cubic-bezier(.3,.9,.3,1), opacity ${ms}ms linear`;
      n.el.style.translate = n.x1.toFixed(1) + 'px ' + n.y1.toFixed(1) + 'px';
    });

    /* 数字を動かす。着地した瞬間に最終値 */
    await new Promise((res) => {
      const t0 = performance.now();
      let done = false;
      const fin = () => { if (done) return; done = true; settle(); this._endSettle = null; res(); };
      this._endSettle = fin;
      const step = (now) => {
        if (done) return;
        const t = Math.min(1, (now - t0) / ms);
        const e = 1 - Math.pow(1 - t, 3);
        for (let i = 0; i < 4; i++) this.setPlateScore(i, before[i] + deltas[i] * e);
        if (dband) dband.textContent = this.yenSigned(this._endTarget * e);
        if (t >= 1) fin(); else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  },

  /* 自動で送ってよいか。0 なら**タップを待つ**（agari-spec.md §1）。

     **四分岐すべてタップ待ち。**初版は「他家同士」だけ自動で送っていたが、
     実機で「何が起きたか分からないまま次の局へ流れる」となった（2026年9月5日）。
     二重に間違っていた——**他家のツモでは自分が払っている**（±0 ではない）し、
     他家の和了は「誰が何で上がったか・いくら動いたか・その人がどういう打ち手か」を
     知る唯一の機会で、順位も変わる。「自分に関係がない」という前提が誤りだった。

     自動で送るのは**人が見ていないときだけ**——おまかせ（giveUp）と最速（speed 0）。

     **kind で分けないこと。**引数に残してあるのは「分けない」ことを見せるため
     （`tools/test-match.js` が四分岐とも 0 になることを固定している） */
  endAutoMs(kind, auto, speed) {
    if (auto) return Math.max(700, speed * 2);
    if (speed === 0) return 400;
    return 0;
  },

  /* 送り。演出が終わってから「タップで次へ」を出す
     ——演出中に出すと、まだ動いているのに押させることになる */
  waitEnd(kind) {
    const band = $('#endband');
    const next = band && band.querySelector('.ebNext');
    return new Promise((res) => {
      let done = false;
      const go = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this._endAdvance = null;
        if (next) next.hidden = true;
        res();
      };
      this._endAdvance = go;
      const wait = this.endAutoMs(kind, this.auto, this.speed);
      if (!wait && next) next.hidden = false;   // 押せると分からなければ待つだけになる
      const timer = wait ? setTimeout(go, wait) : null;
    });
  },

  async result(data) {
    const g = this.game;
    const kind = this.endKind(data);
    /* 和了った人と、振り込んだ人の両方に一言。
       振り込みのほうを後にして、そちらを画面に残す */
    if (data.type === 'win' && data.winner) {
      this.say(data.winner.seat, data.loser ? 'ron' : 'tsumo');
      if (data.loser) this.say(data.loser.seat, 'deal', true);
      /* 自分が振ったときだけ沈む音。それ以外は和了の音 */
      this.sfx(kind === 'dealin' ? 'deal' : 'agari');
    } else if (data.type === 'draw') {
      this.say(g.dealer, 'draw');
      this.sfx('ryuukyoku');
    }

    /* 卓の上で見せるもの（§3・§6）。倒す手・当たり牌・テンパイの印。
       ここは render() が描く——帯の中の牌とは別物 */
    const reveal = new Set();
    if (data.type === 'win') reveal.add(data.winner.seat);
    else if (data.tenpai) data.tenpai.forEach((t, i) => { if (t) reveal.add(i); });
    /* 主役の席。**立ち絵と席プレートを一組に見せる**ための印（§A-1）。
       showEnd と同じ規則で選ぶこと——二か所で決めると顔と札がずれる */
    const starSeat = data.type === 'win'
      ? (kind === 'dealin' || kind === 'other' ? data.winner.seat : 0)
      : g.dealer;
    this._end = {
      reveal,
      star: starSeat,
      winId: data.type === 'win' ? data.winId : null,
      tenpai: data.type === 'draw' ? data.tenpai : null,
    };
    this.render();

    this.showEnd(kind, data);
    /* タップは**飛んでいる最中から**受ける（§5「タップで飛ばせること」）。
       一度目は演出を確定させるだけ、二度目で送る
       ——一度で消すと、飛ばした人には何が起きたか読めないまま画面が変わる */
    const onTap = () => {
      if (this._endSettle) { this._endSettle(); return; }
      if (this._endAdvance) this._endAdvance();
    };
    document.addEventListener('pointerdown', onTap, true);
    try {
      await this.flyScores(data, this.endDeltas(data));
      await this.waitEnd(kind);
    } finally {
      document.removeEventListener('pointerdown', onTap, true);
      this._endSettle = null;
      this._endAdvance = null;
    }
    this.hideEnd();
    this.render();
  },

  async aiPause() { await sleep(this.speed); },
  update() { this.render(); },
};

const JP_SUIT = ['萬', '筒', '索'];
function jpName(k) {
  if (k < 27) return (k % 9 + 1) + JP_SUIT[Math.floor(k / 9)];
  return ['東', '南', '西', '北', '白', '發', '中'][k - 27];
}

/* 副露（agari-spec.md §C-1）。**鳴いた牌は横に倒す。**
   `game.js` は `tiles` の**末尾**に鳴いた牌を入れ（`used.concat([tileId])`）、
   `from` に出した人の席を持っている。加槓は そのあとにもう一枚 push されるので、
   末尾から二番目が鳴いた牌になる。

   倒す位置は麻雀の作法どおり——**上家は左端・対面は真ん中・下家は右端。**
   `seat`（副露した人の席）を渡さなければ位置は決めず、右端に置く。

   暗槓は倒さない（両端が裏のまま）。 */
function meldHTML(m, size, seat) {
  if (m.type === 'ankan') {
    return `<span class="meld">${backHTML(size)}${tileHTML(m.tiles[1], size)}${tileHTML(m.tiles[2], size)}${backHTML(size)}</span>`;
  }
  const t = m.tiles.slice();
  const kakan = m.type === 'kakan';
  const calledAt = kakan ? t.length - 2 : t.length - 1;
  const called = t[calledAt];
  const added = kakan ? t[t.length - 1] : null;
  const rest = t.filter((_, i) => i !== calledAt && !(kakan && i === t.length - 1))
    .sort((a, b) => kindOf(a) - kindOf(b));
  const side = `<span class="meldSide">${tileHTML(called, size, 'side')}${
    added !== null ? tileHTML(added, size, 'side add') : ''}</span>`;
  const cells = rest.map((id) => tileHTML(id, size));
  /* 上家(3)=左端 / 対面(2)=真ん中 / 下家(1)=右端 */
  const dir = (seat === undefined || m.from === undefined) ? 1 : (m.from - seat + 4) % 4;
  const at = dir === 3 ? 0 : (dir === 2 ? Math.min(1, cells.length) : cells.length);
  cells.splice(at, 0, side);
  return `<span class="meld">${cells.join('')}</span>`;
}

/* ---------- 汎用モーダル ---------- */
UI.modal = function (html, buttons) {
  const panel = $('#overlay .panel');
  panel.innerHTML = html
    + `<div class="opt">${buttons.map((b) =>
      `<button class="act ${b.primary ? 'primary' : ''} ${b.ghost ? 'ghost' : ''}" data-v="${b.v}">${b.label}</button>`
    ).join('')}</div>`;
  $('#overlay').classList.add('show');
  return new Promise((res) => {
    panel.querySelectorAll('[data-v]').forEach((el) => {
      el.onclick = () => { UI.sfx('tap'); $('#overlay').classList.remove('show'); res(el.dataset.v); };
    });
  });
};

/* ---------- イカサマの操作 ---------- */
/* イカサマ（買う・使う・看破・気配）は『忍雀』の仕組みで、この作品にはない。
   game.js は g.cheat が無ければ一切呼ばないので、空の実装だけ残しておく。 */
UI.buyCard = async function () {};
UI.openCheatPanel = async function () {};
UI.aiTell = async function () {};
UI.accuseResult = async function () {};

/* 対局終了の画面は match.js の showResult（agari-spec.md §7）。
   ここは順位を控えるだけ。**UI 側に和了画面と別の実装を持たないこと**
   ——以前 ui.js に gameOver の中身があったが、この行に上書きされていて誰も呼んでいなかった */
UI.gameOver = async function (rank) { this._lastRank = rank; };

/* この先（ストーリー進行・タイトル画面の配線）は『忍雀』のものだったので外した。
   対局の開始と後始末は match.js が受け持つ。 */

/* meldHTML は tools/test-match.js が分岐を固定している（DOMに触らない純関数） */
if (typeof module !== 'undefined') module.exports = { UI, tileHTML, meldHTML, jpName };
