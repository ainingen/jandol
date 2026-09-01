/* ============================================================
   画面表示と入力
   ============================================================ */

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  render() {
    const g = this.game;
    if (!g) return;
    this._maxThreat = Math.max(0, ...g.players.slice(1).map((o) => AI.threatLevel(g, o)));
    const bySeat = (r) => g.players[r % 4];

    // 中央情報
    const kyokuLabel = `${KAZE[g.bakaze - 27]}${((g.kyoku - 1) % 4) + 1}局`;
    $('#info').innerHTML = `
      <div class="kyoku">${kyokuLabel}</div>
      <div class="wall">${g.honba}本場 ・ 残り${g.wall.length}枚</div>
      <div id="dora">${g.doraIndicators.map((d) => tileHTML(d, 'tiny')).join('')}</div>
      ${g.riichiSticks ? `<div>${'<span class="riichi-stick"></span>'.repeat(Math.min(g.riichiSticks, 4))}</div>` : ''}
      ${g.cheat ? `<div class="cheatinfo">疑い ${'●'.repeat(g.cheat.suspicion) || '無'}
        ／ 技 ${g.cheat.hand.length}枚</div>` : ''}
      ${g.cheat && g.cheat.peek ? `<div class="peek">山 ${g.cheat.peek.map((id) => tileHTML(id, 'tiny')).join('')}</div>` : ''}
      <div class="scores">${[0, 1, 2, 3].map((i) => {
        const p = g.players[i];
        return `<div class="${i === 0 ? 'me' : ''} ${i === g.dealer ? 'dealer-dot' : ''}">
          ${i === 0 && p.face ? `<span class="oppFace"><img src="${p.face}" alt=""
            onerror="this.remove()"></span>` : ''}
          ${p.name} <b>${p.score}</b></div>`;
      }).join('')}</div>`;

    // 対局者
    const c = g.cheat;
    const KAZE_CH = ['東', '南', '西', '北'];
    const oppHTML = (p, vert) => `
      <div class="opp ${vert ? 'vert' : ''}">
        <div class="oppName">
          ${p.face ? `<span class="oppFace"><img src="${p.face}" alt=""
            onerror="this.remove()"></span>` : ''}
          <span class="oppKaze">${KAZE_CH[p.jikaze - 27] || ''}</span>
          <span class="oppWho">${p.name}</span>
          <span class="oppScore">${p.score}</span>
        </div>
        <div class="backs ${vert ? 'vert' : ''}">${
          c && c.reveal.has(p.seat)
            ? p.hand.map((id) => tileHTML(id, 'tiny')).join('')
            : Array(Math.max(0, p.hand.length)).fill(backHTML('tiny')).join('')}</div>
        ${c && c.showWaits.has(p.seat) ? `<div class="waits">待${
          Engine.winningTiles(Engine.countsFromIds(p.hand), p.melds).map(jpName).join('') || '無'}</div>` : ''}
        ${p.suspicion ? '<span class="susp">疑</span>' : ''}
        <div class="melds">${p.melds.map((m) => meldHTML(m, 'tiny')).join('')}</div>
        ${p.riichi ? '<span style="color:var(--vermilion)">立</span>' : ''}
      </div>`;
    $('#top').innerHTML = oppHTML(bySeat(2), false);
    $('#left').innerHTML = oppHTML(bySeat(3), true);
    $('#right').innerHTML = oppHTML(bySeat(1), true);

    // 河
    const riverHTML = (p, side) => p.discards.map((d, i) => {
      const last = g.lastDiscard && g.lastDiscard.seat === p.seat && i === p.discards.length - 1;
      const t = tileHTML(d.id, 'small',
        (d.riichi ? 'riichi ' : '') + (d.tsumogiri ? 'tsumogiri ' : '') + (last ? 'last' : ''));
      return side ? `<span class="cell ${d.riichi ? 'riichi' : ''}">${t}</span>` : t;
    }).join('');
    $('#river-bottom').innerHTML = riverHTML(bySeat(0), false);
    $('#river-right').innerHTML = riverHTML(bySeat(1), true);
    $('#river-top').innerHTML = riverHTML(bySeat(2), false);
    $('#river-left').innerHTML = riverHTML(bySeat(3), true);

    // 自分
    const me = g.players[0];
    $('#melds-row').innerHTML = me.melds.map((m) => meldHTML(m, 'small')).join('');
    const drawn = g.currentDraw && g.currentDraw.seat === 0 ? g.currentDraw.id : null;
    const hand = me.hand.filter((id) => id !== drawn);
    const selectable = this.pending && this.pending.type === 'turn';
    const allowed = this.allowedDiscards();
    const cell = (id, extra) => {
      const ok = selectable && (!allowed || allowed.has(id));
      const picked = this._selected === id ? 'picked ' : '';
      return tileHTML(id, 'big',
        picked + (ok ? 'selectable ' : (selectable ? 'dim ' : '')) + (extra || ''),
        `data-id="${id}"`) + (ok ? this.hintBar(id) : '');
    };
    $('#handrow').innerHTML = hand.map((id) => `<span class="tilewrap">${cell(id)}</span>`).join('')
      + (drawn !== null ? `<span class="tilewrap drawn">${cell(drawn, 'drawn')}</span>` : '');

    $('#handrow').querySelectorAll('.tile.selectable').forEach((el) => {
      el.onclick = () => this.onTileClick(+el.dataset.id);
    });
    this.renderTachie();
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
    if (this._selected !== null && this._selected !== undefined) {
      $('#hintbox').textContent = `${jpName(kindOf(this._selected))} — もう一度たたくと切る`;
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

  onTileClick(id) {
    if (!this.pending || this.pending.type !== 'turn') return;
    const allowed = this.allowedDiscards();
    if (allowed && !allowed.has(id)) return;
    if (this._selected !== id) {      // 一度目は選ぶだけ
      this._selected = id;
      this.render();
      return;
    }
    const type = this.riichiSelect ? 'riichi' : 'discard';
    this.riichiSelect = false;
    this._selected = null;
    this.resolve({ type, tile: id });
  },

  /* ---- セリフ ----
     立ち絵の主を seat に切り替えて、一言を吹き出しに出す。
     hold=true のときは、そのあと自動で消さない（放銃の顔を残す）  */
  say(seat, kind, hold) {
    if (typeof SERIFU === 'undefined') return;
    const g = this.game;
    const box = $('#tachie');
    if (!g || !box) return;
    const p = g.players[seat];
    if (!p) return;
    const line = SERIFU.pick(p.chara, kind);
    if (!line) return;
    this.showTachie(seat);
    /* 名前は showTachie の差分更新に任せず、ここで必ず書き直す。
       任せると「顔と名前は次の人・セリフは前の人」という取り違えが起きる */
    box.querySelector('.tcName').textContent = p.name || '';
    box.querySelector('.tcStyle').textContent = seat === 0 ? 'あなた' : (p.styleName || '');
    const b = box.querySelector('.tcBubble');
    b.textContent = line;
    box.classList.add('talk');
    clearTimeout(this._sayTimer);
    /* 吹き出しは自分からは消さない。次の誰かが喋るまで出しっぱなしにする。
       消してしまうと、狭い画面ではほとんどの時間ただの顔になり、
       セリフがあることに気づけない（スマホで「何も出ない」と見える） */
    this._talkUntil = Date.now() + (hold ? 2600 : Math.max(1600, (this.speed || 520) * 3));
  },

  /* ---- 立ち絵 ----
     卓の右の余白に、いま打っている人の絵を出す。
     毎回 src を入れ直すと画像が再読込されて点滅するので、
     席が変わったときだけ差し替える  */
  showTachie(seat) {
    const box = $('#tachie');
    const g = this.game;
    if (!box || !g) return;
    const p = g.players[seat];
    if (!p) return;
    if (this._tachieSeat !== seat) {
      this._tachieSeat = seat;
      /* 映す人が変わったら吹き出しは畳む。
         残すと「顔は次の人・セリフは前の人」になる。
         say() はこのあとで新しい一言を入れるので、消えるのは一瞬 */
      box.classList.remove('talk');
      box.querySelector('.tcBubble').textContent = '';
      const art = box.querySelector('.tcArt');
      const img = p.face || '';
      art.style.backgroundImage = img ? `url("${img}")` : 'none';
      box.querySelector('.tcName').textContent = p.name || '';
      box.querySelector('.tcStyle').textContent = seat === 0 ? 'あなた' : (p.styleName || '');
      /* 差し替えのたびに軽く出し直す。付け外ししないと二度目が動かない */
      box.classList.remove('in');
      void box.offsetWidth;
      box.classList.add('in');
    }
    box.classList.toggle('riichi', !!p.riichi);
    box.classList.toggle('me', seat === 0);
  },

  /* 立ち絵（横の広い画面）か、顔と吹き出しの帯（それ以外）か。
     CSS の切り替え条件と同じにしておくこと */
  bigArt() {
    try {
      return window.matchMedia('(orientation:landscape)').matches
        && window.innerWidth >= 900;
    } catch (e) { return false; }
  },

  renderTachie() {
    const g = this.game;
    if (!g || !$('#tachie')) return;
    /* 帯のときは手番を追いかけない。
       追うと顔だけ次の人に変わり、吹き出しが前の人のまま残って
       誰の発言か分からなくなる。帯は「最後に喋った人」を映しておく */
    if (!this.bigArt()) {
      if (this._tachieSeat === null || this._tachieSeat === undefined) {
        this.showTachie(g.dealer);
      }
      this.maybeIdle();
      return;
    }
    /* 立ち絵のときは手番を追う。ただし喋っている最中は動かさない */
    if (this._talkUntil && Date.now() < this._talkUntil) return;
    const seat = g.currentDraw ? g.currentDraw.seat
      : (g.lastDiscard ? g.lastDiscard.seat : g.dealer);
    const before = this._tachieSeat;
    this.showTachie(seat);
    if (before !== seat) this.maybeIdle(seat);
  },

  /* 手番がまわってきたときだけ、たまに雑談させる。
     毎回だと喋りっぱなしでうるさい */
  maybeIdle(seat) {
    const g = this.game;
    if (!g || typeof SERIFU === 'undefined') return;
    const now = g.currentDraw ? g.currentDraw.seat
      : (g.lastDiscard ? g.lastDiscard.seat : g.dealer);
    const s = seat === undefined ? now : seat;
    if (this._idleSeat === s && this._idleKyoku === g.kyoku) return;   // 同じ手番で二度言わない
    this._idleSeat = s; this._idleKyoku = g.kyoku;
    if (Math.random() < 0.18) this.say(s, 'idle');
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
      el.onclick = b.onClick;
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
    t.className = 'show' + (/ポン|チー|カン|リーチ|暗槓|加槓/.test(text) ? ' call' : '');
    /* game.js が「誰が・何を」を添えてくる。添えて来ない呼び出しもあるので、
       あるときだけ喋らせる */
    if (who && who.kind) this.say(who.seat, who.kind);
    await sleep(ms || 700);
    t.className = '';
    await sleep(120);
  },

  async result(data) {
    const g = this.game;
    const panel = $('#overlay .panel');
    /* 和了った人と、振り込んだ人の両方に一言。
       振り込みのほうを後にして、そちらを画面に残す */
    if (data.type === 'win' && data.winner) {
      this.say(data.winner.seat, data.loser ? 'ron' : 'tsumo');
      if (data.loser) this.say(data.loser.seat, 'deal', true);
    } else if (data.type === 'draw') {
      this.say(g.dealer, 'draw');
    }
    if (data.type === 'win') {
      const r = data.result;
      const yakuRows = r.yaku.map((y) =>
        `<div>${y.name}</div><div class="h">${y.yakuman ? '役満' : y.han + '翻'}</div>`).join('');
      const winTiles = data.hand.slice().sort((a, b) => kindOf(a) - kindOf(b));
      panel.innerHTML = `
        <h2>${data.loser ? 'ロン和了' : 'ツモ和了'} — ${data.winner.name}</h2>
        <div class="hand-view">
          ${winTiles.map((id) => tileHTML(id, 'small')).join('')}
          ${data.melds.map((m) => meldHTML(m, 'small')).join('')}
          <span class="win">${tileHTML(data.winId, 'small', 'last')}</span>
        </div>
        <div class="sub">ドラ表示 ${data.doraIndicators.map((d) => tileHTML(d, 'tiny')).join('')}
          ${data.uraIndicators.length ? ' ／ 裏 ' + data.uraIndicators.map((d) => tileHTML(d, 'tiny')).join('') : ''}</div>
        <div class="yaku-list">${yakuRows}</div>
        <div class="sub">${r.fu}符 ${r.han}翻 ${r.score.name}</div>
        <div class="total">${r.score.detail}</div>
        <div class="opt"><button class="act" id="next">次へ</button></div>`;
    } else {
      const rows = data.tenpai
        ? g.players.map((p, i) => `<div class="rank-row"><span class="r">${p.name}</span>
            <span>${data.tenpai[i] ? 'テンパイ' : 'ノーテン'}</span><span>${p.score}</span></div>`).join('')
        : '';
      panel.innerHTML = `<h2>${data.reason}</h2>${rows}
        <div class="opt"><button class="act" id="next">次へ</button></div>`;
    }
    $('#overlay').classList.add('show');
    /* おまかせ中は局の結果も自分で送る。押させると早送りの意味がない。
       早送り(speed 0)でも一瞬は見えるよう、最低限の間は置く */
    await new Promise((res) => {
      $('#next').onclick = res;
      if (this.auto) setTimeout(res, Math.max(700, this.speed * 2));
    });
    $('#overlay').classList.remove('show');
  },

  async gameOver(rank) {
    const panel = $('#overlay .panel');
    panel.innerHTML = `<h2>対局終了</h2>
      ${rank.map((r, i) => `<div class="rank-row"><span class="r">${i + 1}位</span>
        <span>${r.name}</span><span>${r.score}</span></div>`).join('')}
      <div class="opt"><button class="act primary" id="again">もう一度</button></div>`;
    $('#overlay').classList.add('show');
    await new Promise((res) => { $('#again').onclick = res; });
    location.reload();
  },

  async aiPause() { await sleep(this.speed); },
  update() { this.render(); },
};

const JP_SUIT = ['萬', '筒', '索'];
function jpName(k) {
  if (k < 27) return (k % 9 + 1) + JP_SUIT[Math.floor(k / 9)];
  return ['東', '南', '西', '北', '白', '發', '中'][k - 27];
}

function meldHTML(m, size) {
  if (m.type === 'ankan') {
    return `<span class="meld">${backHTML(size)}${tileHTML(m.tiles[1], size)}${tileHTML(m.tiles[2], size)}${backHTML(size)}</span>`;
  }
  const tiles = m.tiles.slice().sort((a, b) => kindOf(a) - kindOf(b));
  return `<span class="meld">${tiles.map((id) => tileHTML(id, size)).join('')}</span>`;
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
      el.onclick = () => { $('#overlay').classList.remove('show'); res(el.dataset.v); };
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

UI.gameOver = async function (rank) { this._lastRank = rank; };

/* この先（ストーリー進行・タイトル画面の配線）は『忍雀』のものだったので外した。
   対局の開始と後始末は match.js が受け持つ。 */

if (typeof module !== 'undefined') module.exports = { UI, tileHTML, jpName };
