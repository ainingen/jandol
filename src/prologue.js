/* ============================================================
   プロローグ — 表紙と「あなたのこと」のあいだ
   仕様：docs/design/title/prologue-spec.md
   依存：prologue.css（--mincho / --ivory / --kin は style.css と theme.css）

   使い方：
     Prologue.play(done)   覆いを body に足して、読み終わったら done()

   **画面ではなく覆い。**`title.js` の `screen` は 'top' | 'setup' のまま
   （spec §4）。`data-act="new"` を押した直後に挟まり、閉じたら
   `renderSetup()` へ進む。

   触ってはいけないもの（spec §4）：
     - `#cover` の canvas … DOM から外さない・display:none にしない・
       中身を消さない。**上に覆いを重ねるだけなら撮影には影響しない**
       （`.popup` が既に全画面を覆っていて、サムネイルは撮れている）
     - `fitTop()` と `body.onTitle` … 別の層なので、そもそも関係しない

   **localStorage にも Sound にも触らない**（spec §5・§10）。
   「見たか」は覚えない——押した経路で決まるので、覚える必要が無い。
   音を鳴らすと `Sound.init()` の入口が二つになる。
   ============================================================ */

/* 本文。**一画面＝一つの配列、一行＝一つの文字列。**

   直すときの決めごと（spec §2）：
     - 名前を出さない（設定画面はこのあとなので、名前はまだ決まっていない）
     - **人数を書かない。**題字と副題と同じ（引き継ぎ書 §7）。
       **「八人」だけは雀エイトの定義なので固定**
     - **最後の一行は `Title.SUBTITLE` と対。**片方だけ動かさないこと
       （`tools/test-prologue.js` が落ちる。比べるのは句点を落とした形）
     - **一画面は5行まで。**334px（iOS の横持ち）で読める上限
     - 一行は句点か読点で切る。折り返しに任せると、狭い画面で
       意味の切れ目と違うところで折れる

   **`tools/make-font.py` を回すと、ここの字が `maru-ui.woff2` に入る**
   （`source_chars()` が `src/*.js` を丸ごと拾うため）。本文は
   `--mincho`（端末の明朝）で出しているので**丸ゴは要らない。**
   woff2 が太ったら、拾う側で外すこと（spec §6「本文のために焼き直さない」）。 */
const PROLOGUE = [
  ['最後の牌を、河に置いた。',
   '勝った。',
   'グラスの氷が、ひとつ崩れた。',
   '窓の外は、六本木の夜だった。'],

  ['卓の四隅に、知らない顔は、ひとつも無かった。',
   'ヒールのまま、タクシーを拾って、',
   '行き先は、東京駅とだけ告げた。'],

  ['新幹線を降りて、在来線に乗り換えて、',
   'それでもまだ足りなくて、歩いた。',
   '潮の匂いのする港町の、看板の字が半分消えた店。',
   '雨の商店街の奥、シャッターの隙間から漏れる、牌を混ぜる音。',
   '灯りの数だけ、卓があった。'],

  ['卓の数だけ、まだ誰も知らない手があった。',
   '牌を切る指が、きれいだった。',
   '振り込んでも、眉ひとつ動かさない子。',
   'ツモった刹那にだけ、ほどける口もと。',
   'スマホを伏せて、誰も、見ていない。'],

  ['──それが、いちばん惜しかった。',
   '麻雀は、四人にしか見えない。',
   'だから、見せる人が要る。',
   '見つけて、口説いて、育てて、灯りの下に立たせる人が。',
   '帰りの切符は、もう、買っていなかった。'],

  ['頂に、八人がいる。',
   '人は「雀エイト」と呼ぶ。',
   'いつか、あの八つの灯りを、ひとつの看板の下に並べる。',
   'まずは、看板を出すところから。'],

  ['その雀荘に、まだ見ぬ雀ドルがいる。'],
];

const Prologue = (() => {
  'use strict';

  /* spec §7。行は下から 8px ぶん持ち上げながら 520ms で入れ、
     行ごとに 260ms ずらす。画面が替わるときは 180ms で消す。
     **520ms は CSS 側（`.plLine` の transition）にある。**
     ここが持つのは「次の行をいつ出すか」だけなので、
     揺れても字が消えることはない */
  const STAGGER_MS = 260;
  const FADE_MS = 180;

  /* 最後の画面で出す釦。**最後だけは押しても進まない**（spec §3）
     ——誤爆でプロローグが終わるのを、そこだけは防ぐ */
  const GO_LABEL = 'はじめる';

  /* **最初から出しておく**（spec §3）。あとから出すと、
     飛ばしたい人が飛ばせない時間ができる */
  const SKIP_LABEL = 'とばす';

  /* 動きを減らす設定（spec §3）。**押した時点で一画面ぶんを全部出す。**
     進みかたは変えない——画面の数も、押して次へ進むことも同じ。
     **毎回引くこと。**play() の一度きりで見ると、途中で端末の設定を
     変えた人に効かない */
  function reduced() {
    try {
      return !!(window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  function play(done) {
    const finish = (typeof done === 'function') ? done : function () {};
    /* 単体ページは prologue.js を読まないので、ここへは来ない。
       それでも本文が空なら何も出さずに通す（spec §4） */
    if (!Array.isArray(PROLOGUE) || !PROLOGUE.length) { finish(); return null; }

    const root = document.createElement('div');
    root.className = 'plRoot';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'プロローグ');

    /* **釦は本文より前、流れの中に置く**（絶対配置にしない）。
       `.plRoot` は入りきらないときに流れるので、絶対配置だと
       長い画面で画面の外へ送られる。流れの中なら場所を取るぶん、
       本文の中央寄せもそのぶんを見込んで決まる */
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'plSkip';
    skip.textContent = SKIP_LABEL;
    root.append(skip);

    const text = document.createElement('div');
    text.className = 'plText';
    root.append(text);

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'plGo';
    go.textContent = GO_LABEL;
    go.hidden = true;
    root.append(go);

    /* 進みぐあいの点。画面数ぶん（spec §3） */
    const dots = document.createElement('div');
    dots.className = 'plDots';
    dots.setAttribute('aria-hidden', 'true');
    PROLOGUE.forEach(() => {
      const d = document.createElement('span');
      d.className = 'plDot';
      dots.append(d);
    });
    root.append(dots);

    document.body.append(root);

    let page = -1;
    let timers = [];
    let filling = false;      // まだ浮かび上がっている途中か
    let closed = false;

    function clearTimers() { timers.forEach(clearTimeout); timers = []; }
    function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

    function lines() { return root.querySelectorAll('.plLine'); }

    /* 一画面ぶんを組んで、上から順に浮かび上がらせる */
    function showPage(n) {
      page = n;
      const last = (n === PROLOGUE.length - 1);
      text.textContent = '';
      go.hidden = true;
      go.classList.remove('on');

      PROLOGUE[n].forEach((s, i) => {
        const p = document.createElement('p');
        p.className = 'plLine';
        /* **textContent で入れること。**本文は地の文なので、
           innerHTML で組むと記号を足したときに黙って壊れる */
        p.textContent = s;
        /* 最後の一行だけ金。副題と揃える（spec §7） */
        if (last && i === PROLOGUE[n].length - 1) p.classList.add('plKin');
        text.append(p);
      });

      Array.prototype.forEach.call(dots.children,
        (d, i) => d.classList.toggle('on', i === n));

      /* 動きを減らす設定のときは、浮かび上がらせずに最初から全部出す */
      if (reduced()) { fillAll(); return; }

      filling = true;
      const ns = lines();
      ns.forEach((p, i) => later(() => {
        p.classList.add('on');
        if (i === ns.length - 1) { filling = false; afterFill(); }
      }, i * STAGGER_MS));
    }

    /* 途中で押されたとき。**飛ばすのではなく、その画面を全部出す**
       （spec §3。読み終える前に次へ行ってしまうのがいちばん困る） */
    function fillAll() {
      clearTimers();
      lines().forEach((p) => p.classList.add('on'));
      filling = false;
      afterFill();
    }

    function afterFill() {
      if (page !== PROLOGUE.length - 1) return;
      go.hidden = false;
      /* 一拍おいてから灯す。行と同じ入りかたにする */
      later(() => go.classList.add('on'), 40);
    }

    function next() {
      clearTimers();
      text.classList.add('out');
      later(() => {
        text.classList.remove('out');
        showPage(page + 1);
      }, FADE_MS);
    }

    function close() {
      if (closed) return;
      closed = true;
      clearTimers();
      root.remove();
      finish();
    }

    root.addEventListener('click', (e) => {
      if (e.target.closest('.plGo')) { close(); return; }
      /* **とばすは即 done()。**読み終わったのと同じ出口を通る */
      if (e.target.closest('.plSkip')) { close(); return; }
      if (filling) { fillAll(); return; }
      /* **最後の画面は押しても進まない**（spec §3）。釦を押させる */
      if (page < PROLOGUE.length - 1) next();
    });

    showPage(0);
    return { close: close };
  }

  return { play, reduced, STAGGER_MS, FADE_MS, GO_LABEL, SKIP_LABEL };
})();

if (typeof module !== 'undefined') module.exports = { PROLOGUE, Prologue };
