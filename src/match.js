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

   局の頭からの復帰（docs/design/match/resume-spec.md）は、
   `src/resume.js` を読み込んでいるページでだけ効く（いまは match.html）。
   opts に kyoku / honba / riichiSticks / scores / startDealer を足すと
   そこから始まる（§7）。
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
     **二本立て（自分は `p01`〜、雀ドルは3桁）を書くのは `faceName` の一行だけ。**
     席プレートも順位表も立ち絵もここを通る——書き写すと片方だけ古びる。

     **大きさで置き場所が分かれる**（`BACKLOG.md`「対局画面のサムネイル化」）。

     | 出る場所 | 表示px（四人卓 844×334） | 読む先 |
     | --- | --- | --- |
     | 席プレートの丸 | 24〜36px | `thumb/` |
     | カットインの札 | 82×119 | `thumb/` |
     | 対局終了の順位表 | 34px | `thumb/` |
     | **局の締めの立ち絵** | **150×196** | **`img/`** |

     `thumb/` は 176×234 なので、DPR 3 の実機でも 24〜36px の丸には十分。
     **立ち絵だけは足りない**（DPR 3 で 450×588 が要る）ので `img/` のまま。
     焼くのは `tools/make-thumbs.py`。**大会のカードと同じ絵を使う** */
  const faceName = (c) => (c && c.id === 0
    ? (c.face || 'p01')
    : String(c.id).padStart(3, '0'));
  const faceOf = (c) => `img/${faceName(c)}.webp`;      // 大きく出す場所
  const thumbOf = (c) => `thumb/${faceName(c)}.webp`;   // 小さく出す場所

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
        <!-- **左は言葉、右は数字**（agari-spec.md §2 の追補）。
             役名（.ebYaku）は幅の余っている左に置く——右の 196px に
             10.5px で積んでいたころは、役が多いと黙って切れていた -->
        <div class="ebLeft">
          <div class="ebHead"></div>
          <div class="ebLine"></div>
          <div class="ebTiles"></div>
          <div class="ebDora"></div>
          <div class="ebYaku"></div>
        </div>
        <div class="ebRight">
          <div class="ebDelta"></div>
          <div class="ebScore"></div>
        </div>
        <!-- 演出が終わってから出す。**押せると分からなければ、ユーザーは待つだけになる** -->
        <div class="ebNext" hidden>タップで次へ</div>
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
    /* **直に測らない。**`updateRotate` は向きが変わるたびに呼ばれ、
       `resize` と `visualViewport` の両方から同じフレームに来る。
       `scheduleFit` に渡して一回へ畳む（`crash-spec.md` §8） */
    scheduleFit();
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

  /* 同じ読み替えの**横方向**。`ref` の左端からの左右を返す。
     `layoutBox` が「レイアウトの上下」を出すのと対（rotate(90deg) では
     レイアウトの横が画面の縦になるので、`top` / `bottom` から取る）。

     **卓面（`#felt`）はここで測る。**36度倒したうえに透視が掛かっていて、
     `offsetWidth` では描かれた幅が分からない——`fitFour` が実測しているのは
     そのため。**席プレートのほうは実測しない**（下の `room`） */
  function layoutSpan(el, ref) {
    const r = el.getBoundingClientRect();
    const t = ref.getBoundingClientRect();
    if (!document.body.classList.contains('rotated')) {
      return { left: r.left - t.left, right: r.right - t.left };
    }
    return { left: r.top - t.top, right: r.bottom - t.top };
  }

  /* 四人卓の辺長。画面の高さから手牌ぶんを引いた残りに収まる正方形（§4.2）。
     rotateX で寝かせるので、見た目の高さは辺長より短い。
     CSS だけでは「回した後の高さ」が測れないので、候補を入れて測って詰める。
     上端（対面の手牌）が切れないこと、上のプレートと重ならないことを見る */
  /* 卓面をいっぱいまで大きくする。

     **数値を決め打ちしないこと。**36度倒したうえに透視（perspective:820px）が
     掛かっているので、手前側が広がって `cos(36°)` の計算値とは合わない。
     `--side` を入れて**実際に描かれた外接矩形を測り**、収まる最大を二分探索で探す。

     縛っているのは三つ。
       ・幅が卓に収まること
       ・下の縁が卓の底より内側にいること
       ・**対面の手牌が上のプレートに隠れないこと**
     上のプレートが卓面の遠い縁に少し掛かるのはよい（モックがそうなっている）。
     掛かってはいけないのは対面の手牌のほうで、それは縁より内側にある
     ——**プレートの高さで卓を縛ると、その半分ぶん卓が小さくなる**（実測で50px近い） */
  function fitFour() {
    const t = document.getElementById('table');
    const felt = document.getElementById('felt');
    const body = document.body;
    if (!t || !felt) return;
    const W = t.clientWidth, H = t.clientHeight;
    if (!W || !H) return;
    const plateTop = document.getElementById('plate-top');
    const plateBottom = plateTop ? plateTop.offsetTop + plateTop.offsetHeight : 52;
    const backs = document.querySelector('#top .backs');
    const maxW = W - 24;
    const botPad = 4;

    /* **卓面を卓に重ねない。**対面のプレートの下から始める（プレート側を
       小さくしてあるので、これでも卓は縮まない）。実機で「名前が牌にかぶる」が出た */
    const fits = (side) => {
      body.style.setProperty('--side', Math.round(side) + 'px');
      const b = layoutBox(felt, t);
      if (b.width > maxW) return false;
      if (b.bottom < botPad) return false;
      return b.top >= plateBottom;
    };

    /* 高さを決める。**下だけが余ることがある**（実機 844×334 で 17px）ので、
       余っているぶん卓面を下げてから探し直す。下げれば上の縛りが緩む */
    let side = 120;
    const search = () => {
      let lo = 120, hi = Math.min(maxW, H * 2.4);
      if (fits(hi)) { side = hi; return; }
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid; else hi = mid;
      }
      side = Math.floor(lo);
      body.style.setProperty('--side', side + 'px');
    };
    body.style.setProperty('--felt-y', '0px');
    let shift = 0;
    for (let pass = 0; pass < 4; pass++) {
      search();
      const slack = layoutBox(felt, t).bottom - botPad;
      if (slack <= 1) break;
      shift += slack / 2;                     // 中心を下げるので、効くのは半分
      body.style.setProperty('--felt-y', Math.round(shift) + 'px');
    }
    search();

    /* 幅を決める。**正方形にしない。**画面は横に2.5倍長いので、正方形だと
       幅の3割しか使わずフェルトの下半分が緑のまま空く。
       左右の席プレートに掛からないところまで広げる（測って決める） */
    const pl = document.getElementById('plate-left');
    const pr = document.getElementById('plate-right');
    /* **席プレートはレイアウト箱で測る**（`offsetLeft` / `offsetWidth`）。
       `getBoundingClientRect` で測っていたころは、
       `body.inMatch.four .seat.talking{transform:scale(1.07)}` の**跳ねを
       寸法として読んで**いた——セリフのあいだだけ卓が縮み、終わると戻る。
       実測で `--side-w` が30秒に10回・7つの値を行き来していた（段B・2026年9月10日）。
       **装飾の transform を寸法として読まないこと**（`HANDOVER.md` §5）。

       `offsetLeft` は `offsetParent`（四人卓では `position:relative` の `#table`）の
       内側で数えるので、**回転表示でも軸が入れ替わらない**
       ——レイアウト座標そのものなので、`layoutSpan` の側だけを読み替えればよい。
       `#table` は四人卓では `padding:0` / `border:0` なので、
       パディング箱と枠箱が一致する（`layoutSpan` の原点と揃う） */
    const room = () => ({
      l: pl ? pl.offsetLeft + pl.offsetWidth + 8 : 12,
      r: pr ? pr.offsetLeft - 8 : W - 12,
    });
    const wideFits = (w) => {
      body.style.setProperty('--side-w', Math.round(w) + 'px');
      const f = layoutSpan(felt, t);
      const g = room();
      return f.left >= g.l && f.right <= g.r;
    };
    let wlo = side, whi = side * 2.2;         // 極端に横長にはしない
    if (!wideFits(whi)) {
      for (let i = 0; i < 14; i++) {
        const mid = (wlo + whi) / 2;
        if (wideFits(mid)) wlo = mid; else whi = mid;
      }
      body.style.setProperty('--side-w', Math.floor(wlo) + 'px');
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

  /* 測り直しは**必ずここを通す**（`docs/design/match/crash-spec.md` §8）。

     **500ms の見張りは 2026年9月10日に消えた。**四人卓のあいだ
     `--side` / `--side-w` / `--felt-y` を毎秒144回書き換えていて、
     **iOS が WebContent を落としてページを読み直していた**（実機で確定）。
     JS 側には兆候が出ないので、原因の機構そのものは確定していない
     ——確かなのは「見張りが動いている走行だけが落ちた」ところまで。

     **測るのは四つの機会だけ**（向き・寸法／最初の描画のあと／局の変わり目／
     列レイアウトで並びが変わったとき）。どれも**まれにしか来ない**が、
     同じフレームに何本も重なりうる（`onOrientationChange` は
     `resize` と `visualViewport` の二つから同時に来る）。
     **`requestAnimationFrame` で一フレームに一回へ畳む**
     ——`fitFour` 一回で `getBoundingClientRect` 166回・`setProperty` 約72回なので、
     連打させると見張りを戻したのと同じことになる。

     `toTop` は**畳むときに OR を取る**。一本でも「先頭へ戻せ」と言っていれば戻す
     ——向きが変わったのに前のスクロール位置が残ると、一番上の家が隠れる */
  let fitRAF = null;
  let fitToTop = false;
  function scheduleFit(opts) {
    if (opts && opts.toTop) fitToTop = true;
    if (fitRAF !== null) return;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    fitRAF = raf(() => {
      fitRAF = null;
      const toTop = fitToTop;
      fitToTop = false;
      fitTable();
      clampTableScroll(toTop);
    });
  }
  /* 対局を出るときに捨てる。**残すと卓が消えたあとに一度走る** */
  function cancelFit() {
    if (fitRAF === null) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(fitRAF);
    else clearTimeout(fitRAF);
    fitRAF = null;
    fitToTop = false;
  }

  /* **画面の高さは `visualViewport.height` で取る。**`innerHeight` は
     iOS Safari の上下バーを含んだ値を返すことがあり、実機で 390 と答えるのに
     実際に見えているのは 334（バーが 56px 食っている）。**その 56px ぶん、
     卓が小さく計算される。**しかもスクロールでバーが出入りするので、
     高さは対局中に変わる——`visualViewport` の resize / scroll も購読する */
  function applyViewportHeight() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    if (h) document.body.style.setProperty('--vvh', Math.round(h) + 'px');
  }

  function onOrientationChange() {
    applyViewportHeight();
    updateRotate();
    /* 回り終わって寸法が確定してからもう一度戻す。
       端末によっては change の時点でまだ古い寸法が返る。
       **+120ms / +400ms の追い掛けは残す**（そこでしか正しい寸法が返らない端末がある）。
       ただし**そちらも `scheduleFit` を通す**——四つの listener から来た
       同じフレームのぶんが、ここで一回に畳まれる（`crash-spec.md` §8） */
    scheduleFit({ toTop: true });
    setTimeout(function () { scheduleFit({ toTop: true }); }, 120);
    setTimeout(function () { scheduleFit({ toTop: true }); }, 400);
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

    /* 局の頭の状態をそのまま `Game` へ渡す（`resume-spec.md` §7）。
       **どれも undefined なら既定に落ちる**ので、ふつうの対局では
       いままでと1ビットも変わらない（`tools/test-resume.js` が固定している）。
       `startDealer` はもともと `Game` にあったのに転送していなかったため、
       **`match.html` の `?dealer=` はここまで届いていなかった。**これで効く */
    const g = new Game(UI, {
      length: opts.length || 'tonpuu',
      foes: seats.slice(1).map((c) => c.name),
      startDealer: opts.startDealer,
      kyoku: opts.kyoku,
      honba: opts.honba,
      riichiSticks: opts.riichiSticks,
      scores: opts.scores,
    });

    /* 打ち筋の係数を配る。人間（id 0）には入れない。
       入れなければ従来どおりの打ち方になる */
    seats.forEach((c, i) => {
      if (!c) return;
      /* **`face` は小さい版、`faceBig` は大きい版。**席プレートと
         カットインは `face`、局の締めの立ち絵だけが `faceBig` を読む
         （`ui.js`）。一本にすると、24pxの丸のために 768×1024 を
         展開することになる */
      g.players[i].face = thumbOf(c);
      g.players[i].faceBig = faceOf(c);
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
    /* おまかせに入る前の速さ。**`UI.auto` と対で戻すこと**
       ——残っていると、次の対局で `takeOver` が前の半荘の速さを復す */
    UI._preAutoSpeed = null;

    /* 釦は**切り替え**。消さない（`ui.js` の `giveUp` / `takeOver`）。
       おまかせは長い大会を流すための機能なのに、押した瞬間に
       その半荘を手放すことになると、怖くて押せない。
       **入るときは確認あり、出るときは確認なし**——出るのは
       取り上げられた操作を返すだけなので、間違って押しても害が無い。
       **場所は変えない**（右上。帯の下に置かないため。`match.css`） */
    const giveBtn = host.querySelector('#giveup');
    const syncGive = () => { giveBtn.textContent = UI.auto ? '手打ちに戻る' : 'おまかせ'; };
    syncGive();
    giveBtn.addEventListener('click', async () => {
      if (UI.auto) { UI.takeOver(); syncGive(); return; }
      const v = await UI.modal(
        '<h2>残りをおまかせにしますか</h2>' +
        '<p class="mdNote">ここから先は自分の手もCPUが打ちます。' +
        '着順はそのまま結果になります。<br>同じ釦で手打ちに戻せます。</p>',
        [{ v: 'fast', label: '早送りで終わらせる', primary: true },
         { v: 'auto', label: '見ながら自動で進める' },
         { v: 'x', label: '自分で打つ', ghost: true }]
      );
      if (v === 'x') return;
      UI.giveUp(v === 'fast' ? 0 : UI.speed);
      syncGive();
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
      setTimeout(function () { scheduleFit(); }, 60);
      UI.render();
    });
    await tryLockLandscape();
    updateRotate();
    window.addEventListener('resize', onOrientationChange);
    if (screen.orientation) screen.orientation.addEventListener('change', onOrientationChange);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onOrientationChange);
      window.visualViewport.addEventListener('scroll', onOrientationChange);
    }
    applyViewportHeight();

    /* 測り直しの合図（`crash-spec.md` §8）。**`UI.handStart` と同じ作法**——
       `ui.js` は `render()` の末尾で `onLayout` を呼ぶだけで、何を測るかは知らない。
       **ここで重いことをしない。**`scheduleFit` に渡して一フレームへ畳む。

       - **`kyokuChanged`** … 局が変わって河が空になり、卓の中身が縮んだ。
         **最初の描画もここに入る**（`_seqKyoku` が空なので一度目は必ず真）
         ——`updateRotate()` は `g.run()` より前に走るので、席プレートが空のまま
         一度目を測っている。`plateTop.offsetHeight` が違う。
         **500ms の見張りが直していたのはこれ。**落とすと初回の寸法が狂う
       - **`changed`（列レイアウトだけ）** … 河が伸びて卓からはみ出したら
         `--rw-fit` で縮める。**四人卓では呼ばない**——`fitFour` が測る
         `#felt` の外接矩形は河の中身に依存しない。ここで四人卓も拾うと、
         打牌のたびに `--side` を書き換えることになって見張りを戻したのと同じになる
       - **`platesChanged`（四人卓だけ）** … 五つ目の機会（段B・2026年9月10日）。
         `fitFour` は**左右の席プレートの位置で卓面の幅を縛る**ので、
         プレートが広がったら測り直しが要る。広げるのは
         立（`.rc`）・疑（`.susp`）・テンパイ札（`.tp`）・点数・名前で、
         **リーチの札は局の終わりまで残る**——拾わないと、その局のあいだずっと
         卓面が名前に食い込む（実測で最大25px）。
         `.turn` / `.talking` / `.star` は `ui.js` の側で除いてある（幅を動かさない）。
         **列レイアウトでは要らない**——`--rw-fit` は河の高さで決まり、
         プレートの幅を見ていない（流局のテンパイ札は `changed` の側で拾う） */
    UI.onLayout = function (info) {
      if (info.kyokuChanged) { scheduleFit(); return; }
      if (document.body.classList.contains('four')) {
        if (info.platesChanged) scheduleFit();
        return;
      }
      if (info.changed) scheduleFit();
    };

    UI.game = g;
    UI._lastRank = null;
    UI.speed = opts.speed === undefined ? 520 : opts.speed;
    UI.showHints = opts.showHints !== false;
    UI.discardMode = opts.discardMode === 'double' ? 'double' : 'single';   // 無ければ一度押し

    /* 局の頭ごとに控える（`resume-spec.md` §3）。**`UI.game = g` と同じ作法。**
       `Game` は `deal()` の直後に `io.handStart?.(this)` を呼ぶだけで、
       ブラウザAPIを知らない——書き出すのはこちら側。

       **`src/resume.js` を読み込んでいるページだけで効く。**いまは
       `match.html` だけ（§1）で、本編（`index.html`）は `build.py` の
       JS リストに入れていないので `Resume` が無く、ここは何もしない。
       本編へ移すときに決めることは §9 にある */
    const store = (typeof Resume !== 'undefined') ? Resume : null;
    UI.handStart = store ? ((game) => store.save(game, seats, opts)) : null;

    await g.run();
    /* **控えは消さない。`done` を書くだけ**（`taikai/resume-spec.md` §3）。
       消していたころは、本編（大会）で `Match.play` のあとに `finish()` が
       賞金を書くので、**結果の表示中に落ちると控えは消えているのに賞金も入らない。**
       `done` を残せば、開き直した側が「その対局はもう終わっている」と分かる。

       **消すのは呼び出し元**——`match.html` は `await` のあと、
       本編（大会）は `finish()` の `store.set` のあと */
    UI.handStart = null;

    const rank = UI._lastRank || g.rankings();
    /* 素点順の並びから順位を作る。**この式は一度だけ**
       ——下の `return` もこれを使う（二か所に書くと片方だけ古びる） */
    const done = rank.map((r, i) => ({ seat: r.seat, place: i + 1 }));
    if (store) store.markDone(done);

    /* 結果を見せてから片付ける */
    await showResult(rank, seats, opts);

    UI.onLayout = null;
    cancelFit();
    document.body.style.removeProperty('--rw-fit');
    document.body.style.removeProperty('--side');
    document.body.classList.remove('tableScroll', 'four', 'rotated', 'canRotate');
    window.removeEventListener('resize', onOrientationChange);
    if (screen.orientation) screen.orientation.removeEventListener('change', onOrientationChange);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', onOrientationChange);
      window.visualViewport.removeEventListener('scroll', onOrientationChange);
    }
    document.body.style.removeProperty('--vvh');
    document.body.classList.remove('needRotate');
    releaseLock();
    host.remove();
    UI.game = null;

    return done.map((r) => ({ chara: seats[r.seat], place: r.place }));
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
        <span class="mzFace"><img src="${esc(thumbOf(c))}" alt="" onerror="this.remove()"></span>
        <span class="mzName">${esc(c.name || r.name)}</span>
        <span class="mzPt">${r.score}</span>
        <span class="mzDiff" data-dir="${diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'}">${
          (diff > 0 ? '+' : diff < 0 ? '−' : '±') + Math.abs(diff)}</span>
      </div>`;
    }).join('');
    const where = opts.title ? `<span class="mzWhere">${esc(opts.title)}</span>` : '';
    /* 釦の文言は**外から渡す**（`taikai/round-spec.md` §6）。既定は `'結果へ'`。
       大会の通常の回戦では行く先が次の半荘なので、「結果へ」だと嘘になる。
       **ここで大会かどうかを数えないこと**——`match.js` は自分がどこから
       呼ばれたかを知らないままにしておく。見分けるのは呼び出し元
       （`shell.html` の `playRealMatch`）の仕事で、練習対局や雀荘は
       何も渡さないので既定のままになる */
    await UI.modal(
      `<h2 class="mzHead">対局終了</h2>${where}<div class="mzList">${rows}</div>`,
      [{ v: 'x', label: opts.doneLabel || '結果へ', primary: true }]
    );
  }

  return { play, TABLE_HTML };
})();

if (typeof module !== 'undefined') module.exports = Match;
