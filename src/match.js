/* ============================================================
   実対局 — match.js
   依存：engine.js / ai.js / game.js / ui.js / style.css
        characters.js / tournament.js（打ち筋の係数）

   ui.js は『忍雀』の画面をそのまま使っているので、卓のDOMを
   自分で組んでから UI に渡す。ここが対局の入口と後始末を持つ。

   使い方：
     const rank = await Match.play(root, seats, opts);

     seats … 4人の配列。席順そのまま。プレイヤーは { id:0 } を含む。
             それぞれ characters.js の雀ドル（style と comp を持つ）
     rank  … [{ chara, place }, ...] を place 順で返す

   大会から呼ぶときは taikai.js の playRealMatch がこれを包む。
   ============================================================ */

const Match = (() => {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  /* ui.js が触るidを全部そろえた卓。style.css の指定に合わせてある */
  const TABLE_HTML = `
    <div id="app">
      <button type="button" id="giveup">おまかせ</button>
      <div id="table">
        <div id="top" class="opp"></div>
        <div id="left" class="opp vert"></div>
        <div id="right" class="opp vert"></div>
        <div id="center">
          <div id="river-top" class="river"></div>
          <div id="river-left" class="river side"></div>
          <div id="info"></div>
          <div id="river-right" class="river side"></div>
          <div id="river-bottom" class="river"></div>
        </div>
      </div>
      <div id="tachie" aria-hidden="true">
        <div class="tcRow"></div>
        <div class="tcBubble"></div>
      </div>
      <div id="myarea">
        <div id="melds-row"></div>
        <div id="handrow"></div>
        <div id="hintbox"></div>
        <div id="actions"></div>
      </div>
    </div>
    <div id="toast"></div>
    <div id="overlay"><div class="panel"></div></div>
    <div id="rotateHint">
      <div class="rotateBox">
        <div class="rotateIcon"></div>
        <div class="rotateText">横にしてください</div>
        <p class="rotateSub">牌が大きくなり、卓が見やすくなります。<br>
          縦のままでも打てます。</p>
        <button type="button" class="rotateGo">このまま縦で打つ</button>
      </div>
    </div>`;

  /* ------------------------------------------------------------
     画面の向き

     Webでは向きを固定できない。screen.orientation.lock() は
     フルスクリーン中のAndroid Chromeでしか効かず、iOS Safari は非対応。
     PLiCyはiframeで動くのでフルスクリーン権限も取れない。
     そこで「試すだけ試して、駄目なら横にしてもらう」形にしてある。
     縦でも打てるので、閉じる道は必ず残すこと。
  ------------------------------------------------------------ */
  let dismissed = false;

  function isPortrait() {
    return window.matchMedia('(orientation:portrait)').matches;
  }

  /* 列レイアウトにしてから縦でも問題なく読めるようになったので、
     横持ちの誘導は出さない。仕組みは残してあるので、
     出したくなったら needRotate を付ける条件を戻すだけでよい */
  function updateRotate() {
    document.body.classList.remove('needRotate');
    fitTable();
    clampTableScroll();
  }

  /* 向きが変わると卓の中身の高さが変わる。
     横持ちでスクロールした位置がそのまま残ると、縦にしたときに
     一番上の家が隠れたまま戻せなくなる（縦は余白が余っていて戻せない）。
     行きすぎを詰めるだけでは足りないことがあるので、
     向きが変わったときは必ず先頭に戻す。 */
  /* 端末の寸法は千差万別で、余白を詰めても収まらないことがある。
     はみ出していたら河を少しずつ縮めて、卓の中に収める。
     前の値から増減させると縮んだまま戻らなくなるので、毎回1から測り直す。 */
  function fitTable() {
    const t = document.getElementById('table');
    const last = document.getElementById('river-bottom');
    if (!t || !last) return;
    const body = document.body;

    /* scrollHeight は四隅の飾りなども拾ってしまうので、
       一番下の行（自分の捨て牌）が卓の底より下に出ているかで判定する */
    const overflow = () =>
      last.getBoundingClientRect().bottom - t.getBoundingClientRect().bottom;

    body.style.setProperty('--rw-fit', '1');
    if (overflow() <= 1) { body.style.removeProperty('--rw-fit'); return; }
    for (let f = 0.94; f >= 0.48; f -= 0.06) {
      body.style.setProperty('--rw-fit', f.toFixed(2));
      if (overflow() <= 1) return;
    }
    /* ここまで縮めても収まらない端末では、卓のスクロールで見てもらう */
  }

  function clampTableScroll(toTop) {
    const t = document.getElementById('table');
    if (!t) return;
    if (toTop) { t.scrollTop = 0; return; }
    const max = Math.max(0, t.scrollHeight - t.clientHeight);
    if (t.scrollTop > max) t.scrollTop = max;
  }

  function onOrientationChange() {
    updateRotate();
    /* 回り終わって寸法が確定してからもう一度戻す。
       端末によっては change の時点でまだ古い寸法が返る */
    clampTableScroll(true);
    setTimeout(function () { fitTable(); clampTableScroll(true); }, 120);
    setTimeout(function () { fitTable(); clampTableScroll(true); }, 400);
  }

  async function tryLockLandscape() {
    try {
      const el = document.documentElement;
      if (el.requestFullscreen) await el.requestFullscreen();
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape');
        return true;
      }
    } catch (e) { /* 効かない環境のほうが多い。黙って諦める */ }
    return false;
  }

  function releaseLock() {
    try {
      if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen();
    } catch (e) { /* 何もしない */ }
  }

  /* ------------------------------------------------------------
     一半荘（東風戦）を実際に打つ
  ------------------------------------------------------------ */
  async function play(root, seats, opts) {
    opts = opts || {};

    /* ui.js と game.js は「人間＝seat 0」を前提にしている。
       大会の卓割りはプレイヤーが何番目に来るか分からないので、
       ここで席順を回してプレイヤーを先頭に持ってくる。
       返す着順もこの並びで作るため、呼び出し側は気にしなくてよい */
    const at = seats.findIndex((c) => c && c.id === 0);
    if (at > 0) seats = seats.slice(at).concat(seats.slice(0, at));

    /* ui.js は document 直下のidを見るので、卓は body 直下に置く。
       #overlay や #toast が position:fixed なのも同じ理由 */
    const host = document.createElement('div');
    host.className = 'matchHost';
    host.innerHTML = TABLE_HTML;
    (root || document.body).append(host);

    const g = new Game(UI, {
      length: opts.length || 'tonpuu',
      foes: seats.slice(1).map((c) => c.name),
    });

    /* 打ち筋の係数を配る。人間（id 0）には入れない。
       入れなければ従来どおりの打ち方になる */
    seats.forEach((c, i) => {
      if (!c) return;
      /* 顔。プレイヤーは p01〜p12、雀ドルは3桁の番号 */
      g.players[i].face = c.id === 0
        ? `img/${c.face || 'p01'}.webp`
        : `img/${String(c.id).padStart(3, '0')}.webp`;
      if (c.id === 0) return;
      g.players[i].name = c.name;
      g.players[i].styleName = (STYLES[c.style] || {}).name || '';
      g.players[i].chara = c.chara || '';
      if (typeof paramsOf === 'function' && c.style) {
        g.players[i].ai = paramsOf(c, STYLES);
      }
    });

    /* おまかせ。以降は自分の席もCPUが打つ。
       着順はごまかさず、そのまま結果になる                        */
    UI.auto = false;
    /* UI は対局をまたいで使い回すので、立ち絵まわりの覚えを戻す。
       _tachieSeat が残っていると次の対局の一枚目で差し替えが飛ばされ、
       前の対局の顔がそのまま出る。
       _idleSeat / _idleKyoku も同じ性質で、残っていると
       二戦目の一局目で席がたまたま一致したとき雑談が一度飛ぶ */
    UI._tachieSeat = null;
    UI._idleSeat = null;
    UI._idleKyoku = null;
    UI._sayAt = null;
    UI._tachieReady = false;      // 顔の並びは対局ごとに組み直す
    const giveBtn = host.querySelector('#giveup');
    giveBtn.addEventListener('click', async () => {
      const v = await UI.modal(
        '<h2>残りをおまかせにしますか</h2>' +
        '<p class="mdNote">ここから先は自分の手もCPUが打ちます。' +
        '着順はそのまま結果になります。<br>途中でやめることはできません。</p>',
        [{ v: 'fast', label: '早送りで終わらせる', primary: true },
         { v: 'auto', label: '見ながら自動で進める' },
         { v: 'x', label: '自分で打つ', ghost: true }]
      );
      if (v === 'x') return;
      giveBtn.remove();
      UI.giveUp(v === 'fast' ? 0 : UI.speed);
    });

    /* 向きの誘導。閉じたら二度と出さない（局ごとに出ると邪魔） */
    dismissed = false;
    host.querySelector('.rotateGo').addEventListener('click', () => {
      dismissed = true;
      updateRotate();
    });
    await tryLockLandscape();
    updateRotate();
    window.addEventListener('resize', onOrientationChange);
    if (screen.orientation) screen.orientation.addEventListener('change', onOrientationChange);

    /* 局が変わると河が空になり、卓の中身が縮む。
       そのときも取り残されたスクロールを詰める */
    const watch = setInterval(function () { fitTable(); clampTableScroll(false); }, 500);

    UI.game = g;
    UI._lastRank = null;
    UI.speed = opts.speed === undefined ? 520 : opts.speed;
    UI.showHints = opts.showHints !== false;

    await g.run();
    const rank = UI._lastRank || g.rankings();

    /* 結果を見せてから片付ける */
    await showResult(rank, seats, opts);

    clearInterval(watch);
    document.body.style.removeProperty('--rw-fit');
    window.removeEventListener('resize', onOrientationChange);
    if (screen.orientation) screen.orientation.removeEventListener('change', onOrientationChange);
    document.body.classList.remove('needRotate');
    releaseLock();
    host.remove();
    UI.game = null;

    return rank.map((r, i) => ({ chara: seats[r.seat], place: i + 1 }));
  }

  async function showResult(rank, seats, opts) {
    const rows = rank.map((r, i) => {
      const c = seats[r.seat] || {};
      const mine = r.seat === 0;
      return `<div class="rank-row"${mine ? ' style="color:var(--gold)"' : ''}>
        <span class="r">${i + 1}位</span>
        <span>${esc(c.name || r.name)}</span>
        <span>${r.score}</span>
      </div>`;
    }).join('');
    await UI.modal(
      `<h2>${esc(opts.title || '対局終了')}</h2>${rows}`,
      [{ v: 'x', label: '結果へ', primary: true }]
    );
  }

  return { play, TABLE_HTML };
})();

if (typeof module !== 'undefined') module.exports = Match;
