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

  /* ui.js が触るidを全部そろえた卓（docs/design/match/spec.md §4）。

     #felt が卓面。四人卓（body.four）では rotateX で寝かせ、河と他家の手牌は
     その中に置く。河は .rslot（中心に置いたゼロサイズの点）を回して外へ押し出し、
     そこから外向きに伸ばす——端（left/right）で決めると回転前の箱に効いて、
     左右の家だけ内側へ引き込まれる（§4.3）。data-angle は ui.js が FLIP の向きを
     卓の座標に直すために読む。
     席プレート（#plate-*）は卓面の外。列レイアウト（縦持ち）では
     #felt / #center / .rslot を display:contents にして、同じ DOM を格子に並べ直す */
  /* 顔の置き場所。プレイヤーは p01〜p12、雀ドルは3桁の番号。
     **席プレートと対局終了の順位表が同じ式を通ること**——書き写すと片方だけ古びる */
  const faceOf = (c) => (c && c.id === 0
    ? `img/${c.face || 'p01'}.webp`
    : `img/${String(c.id).padStart(3, '0')}.webp`);

  const TABLE_HTML = `
    <div id="app">
      <div id="topbar">
        <button type="button" id="rotateBtn" aria-pressed="false">横画面にする</button>
        <button type="button" id="giveup">おまかせ</button>
      </div>
      <div id="table">
        <div id="felt">
          <div id="top" class="opp" data-angle="180"></div>
          <div id="left" class="opp vert" data-angle="90"></div>
          <div id="right" class="opp vert" data-angle="-90"></div>
          <div id="center">
            <div class="rslot rs-top" data-angle="180"><div id="river-top" class="river"></div></div>
            <div class="rslot rs-left" data-angle="90"><div id="river-left" class="river side"></div></div>
            <div id="info"></div>
            <div class="rslot rs-right" data-angle="-90"><div id="river-right" class="river side"></div></div>
            <div class="rslot rs-bottom" data-angle="0"><div id="river-bottom" class="river"></div></div>
          </div>
        </div>
        <div id="plate-top" class="seat s-top"></div>
        <div id="plate-left" class="seat s-left"></div>
        <div id="plate-right" class="seat s-right"></div>
        <div id="plate-bottom" class="seat s-bottom mine"></div>
      </div>
      <div id="cutin" class="cutin" data-side="left" aria-live="polite">
        <div class="card"><span class="tape"></span><img alt=""></div>
        <div class="bubble"><span class="who"></span><span class="line"></span></div>
      </div>
      <div id="myarea">
        <div id="melds-row"></div>
        <div id="handrow"></div>
        <div id="hintbox"></div>
        <div id="actions"></div>
      </div>
      <!-- 局の締め（agari-spec.md）。箱ではなく帯。**卓には掛からない**
           ——#myarea のぶんだけを下から覆う。立ち絵は左右の端で帯の上端に立つ -->
      <div id="endbust" class="endbust" hidden><img alt="">
        <span class="ebWho"><span class="kz"></span><span class="nm"></span></span></div>
      <div id="endband" class="endband" hidden>
        <div class="ebLeft">
          <div class="ebHead"></div>
          <div class="ebLine"></div>
          <div class="ebTiles"></div>
          <div class="ebDora"></div>
        </div>
        <div class="ebRight">
          <div class="ebDelta"></div>
          <div class="ebScore"></div>
          <div class="ebYaku"></div>
        </div>
      </div>
      <!-- 冷たくする膜（§4）。filter を使わない——#felt の 3D が潰れる -->
      <div class="endTint" hidden></div>
      <div id="sticks" class="sticks-fly"></div>
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
  /* 回転表示（§7.2）。縦持ちのままラッパー（.matchHost）を 90 度回して横画面にする。
     OS 側の画面回転ロックを入れている人にも横画面が届く。
     **強制ではなくトグル。**持ち方を変えていないのに横倒しになると、普通にバグだと思われる。
     対局をまたいで覚えておく（同じ大会のあいだに毎回押させない） */
  let rotated = false;

  function isPortrait() {
    return window.matchMedia('(orientation:portrait)').matches;
  }

  /* 列レイアウトにしてから縦でも問題なく読めるようになったので、
     横持ちの誘導は出さない。仕組みは残してあるので、
     出したくなったら needRotate を付ける条件を戻すだけでよい */
  function updateRotate() {
    const body = document.body;
    body.classList.remove('needRotate');
    const portrait = isPortrait();
    /* 回転の釦は縦持ちのときだけ。横持ちの端末で回すと縦になってしまう */
    body.classList.toggle('canRotate', portrait);
    body.classList.toggle('rotated', portrait && rotated);
    const btn = document.getElementById('rotateBtn');
    if (btn) {
      btn.setAttribute('aria-pressed', String(portrait && rotated));
      btn.textContent = portrait && rotated ? '縦に戻す' : '横画面にする';
    }
    /* 横持ち、または回転表示なら四人卓（body.four）。縦持ちで回さないなら列レイアウト（§4・§7.4）。
       media query ではなく class にしてあるのはこのため——回転表示は
       縦持ちのまま .matchHost を回すので、orientation は portrait のまま */
    body.classList.toggle('four', !portrait || rotated);
    fitTable();
    clampTableScroll();
  }

  /* 回転表示のあいだ getBoundingClientRect は 90 度回った箱を返す。
     レイアウト上の「上・下・幅」に読み替える（rotate(90deg) は 下 → 画面の左） */
  function layoutBox(el, ref) {
    const r = el.getBoundingClientRect();
    const t = ref.getBoundingClientRect();
    if (!document.body.classList.contains('rotated')) {
      return { top: r.top - t.top, bottom: t.bottom - r.bottom, width: r.width };
    }
    return { top: t.right - r.right, bottom: r.left - t.left, width: r.height };
  }

  /* 四人卓の辺長。画面の高さから手牌ぶんを引いた残りに収まる正方形（§4.2）。
     rotateX で寝かせるので、見た目の高さは辺長より短い。
     CSS だけでは「回した後の高さ」が測れないので、候補を入れて測って詰める。
     上端（対面の手牌）が切れないこと、上のプレートと重ならないことを見る */
  function fitFour() {
    const t = document.getElementById('table');
    const felt = document.getElementById('felt');
    const body = document.body;
    if (!t || !felt) return;
    const W = t.clientWidth, H = t.clientHeight;
    if (!W || !H) return;
    /* 上のプレートは卓面の遠い縁に少し掛かってよい（モックがそうなっている）。
       掛かってはいけないのは対面の手牌のほうで、それは縁より内側にある */
    const plateTop = document.getElementById('plate-top');
    const topPad = plateTop ? Math.max(0, plateTop.offsetTop + plateTop.offsetHeight - 10) : 36;
    const botPad = 4;
    const maxW = W - 24;
    let side = Math.min(maxW, H * 1.3);
    for (let i = 0; i < 24; i++) {
      body.style.setProperty('--side', Math.round(side) + 'px');
      const b = layoutBox(felt, t);
      const okTop = b.top >= topPad;
      const okBottom = b.bottom >= botPad;
      const okWide = b.width <= maxW;
      if (okTop && okBottom && okWide) break;
      side *= 0.95;
    }
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
    if (body.classList.contains('four')) {
      body.style.removeProperty('--rw-fit');
      body.classList.remove('tableScroll');
      fitFour();
      return;
    }
    body.style.removeProperty('--side');

    /* scrollHeight は四隅の飾りなども拾ってしまうので、
       一番下の行（自分の捨て牌）が卓の底より下に出ているかで判定する */
    const overflow = () =>
      last.getBoundingClientRect().bottom - t.getBoundingClientRect().bottom;

    body.style.setProperty('--rw-fit', '1');
    body.classList.remove('tableScroll');
    if (overflow() <= 1) { body.style.removeProperty('--rw-fit'); return; }
    for (let f = 0.94; f >= 0.48; f -= 0.06) {
      body.style.setProperty('--rw-fit', f.toFixed(2));
      if (overflow() <= 1) return;
    }
    /* ここまで縮めても収まらない端末では、卓のスクロールで見てもらう。
       普段は overflow を切らない（牌が卓の外から飛んでくるので）。
       スクロールが要るときだけ立てる */
    body.classList.add('tableScroll');
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
      g.players[i].face = faceOf(c);
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
    /* UI は対局をまたいで使い回すので、カットインまわりの覚えを戻す。
       _cutinSeat / _sayAt が残っていると、次の対局の一局目で
       前の対局の一言が引っ込む前提で動き、プレートの光りが取り違えられる。
       _idleSeat / _idleKyoku も同じ性質で、残っていると
       二戦目の一局目で席がたまたま一致したとき雑談が一度飛ぶ */
    UI._cutinSeat = null;
    UI._idleSeat = null;
    UI._idleKyoku = null;
    UI._sayAt = null;
    /* 牌のノードも対局ごと。前の卓の DOM は host ごと消えているので、
       Map だけ残っていると外れたノードを使い回そうとする */
    UI._nodes = null;
    UI._seq = null;
    UI._seqKyoku = null;
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
    /* 回転表示のトグル。押した瞬間に卓を組み替えるので、牌は動かさず位置だけ確定させる */
    host.querySelector('#rotateBtn').addEventListener('click', () => {
      rotated = !rotated;
      updateRotate();
      setTimeout(fitTable, 60);
      UI.render();
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
    UI.discardMode = opts.discardMode === 'double' ? 'double' : 'single';   // 無ければ一度押し

    await g.run();
    const rank = UI._lastRank || g.rankings();

    /* 結果を見せてから片付ける */
    await showResult(rank, seats, opts);

    clearInterval(watch);
    document.body.style.removeProperty('--rw-fit');
    document.body.style.removeProperty('--side');
    document.body.classList.remove('tableScroll', 'four', 'rotated', 'canRotate');
    window.removeEventListener('resize', onOrientationChange);
    if (screen.orientation) screen.orientation.removeEventListener('change', onOrientationChange);
    document.body.classList.remove('needRotate');
    releaseLock();
    host.remove();
    UI.game = null;

    return rank.map((r, i) => ({ chara: seats[r.seat], place: i + 1 }));
  }

  /* 半荘の締め（agari-spec.md §7）。**局の締め（帯）より重くてよい。**
     四人の顔・順位・最終点・素点の増減を並べ、一位だけ演出を分ける。

     見出しに opts.title を出さないこと——単体ページでは「単体の対局」、
     大会からは大会名が入ってしまい、**何の画面か言っていない**見出しになる。
     どこから来たかは小さく添える */
  async function showResult(rank, seats, opts) {
    const START = 25000;
    const rows = rank.map((r, i) => {
      const c = seats[r.seat] || {};
      const mine = r.seat === 0;
      const diff = r.score - START;
      return `<div class="mzRow${mine ? ' mine' : ''}${i === 0 ? ' top' : ''}">
        <span class="mzR">${i + 1}<i>位</i></span>
        <span class="mzFace"><img src="${esc(faceOf(c))}" alt="" onerror="this.remove()"></span>
        <span class="mzName">${esc(c.name || r.name)}</span>
        <span class="mzPt">${r.score}</span>
        <span class="mzDiff" data-dir="${diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'}">${
          (diff > 0 ? '+' : diff < 0 ? '−' : '±') + Math.abs(diff)}</span>
      </div>`;
    }).join('');
    const where = opts.title ? `<span class="mzWhere">${esc(opts.title)}</span>` : '';
    await UI.modal(
      `<h2 class="mzHead">対局終了</h2>${where}<div class="mzList">${rows}</div>`,
      [{ v: 'x', label: '結果へ', primary: true }]
    );
  }

  return { play, TABLE_HTML };
})();

if (typeof module !== 'undefined') module.exports = Match;
