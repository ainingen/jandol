/* ============================================================
   釦の音 — ui-sound.js
   依存：Sound（あれば使う）。無ければ何もしない

   docs/design/match/spec.md §2.7。**対局の外の画面ぜんぶに釦の音を通す。**
   表紙・事務所・雀荘・大会・遠征・名鑑・名簿——どれも押しても無音だった。

   **画面ごとに Sound.play('tap') を書き足さないこと。**
   `document` に**一つだけ**委譲の listener を置いて、押されたものが釦なら鳴らす。
   散らすと、押し忘れと、Node で落ちる危険の両方が出る。

   **なぜ ui.js ではなく別の一本か**
   `src/ui.js` は `tools/test-match.js` / `check-hand.js` / `drive-resume.js` が
   **Node で require している。**読み込みの途中で `document` を触ると
   ヘッドレスでその場で落ちる。`typeof document` で守ることはできるが、
   そもそも `ui.js` は対局の io 層で、画面ぜんぶに掛かる listener の置き場所ではない。
   **このファイルはどの tools/*.js からも require されていない。**
   ——Node から読まれないことが、`document` を直に触ってよい根拠になっている。
   足すときは `grep -l ui-sound tools/` が空のままであることを確かめること。

   **必ず守ること**
   - **`Sound.play('tap')` を書くのはこのファイルの一行だけ。**
     他にあるのは `ui.js` の `UI.buttons`（対局中の釦。下の muted() で避ける）と
     `taikai.js` の音量の見本（つまみを動かした音）の二つだけで、
     どちらも「対局の外の釦」ではない
   - **除きかたは `muted()` 一つで決める。**画面ごとに条件を増やさない
   - AudioContext は一つだけ（`Sound.init()` は二度目から何もしない）
   ============================================================ */

(() => {
  'use strict';

  /* 押せるもの。**いまは全部 `<button>`**（src/*.js に role="button" は無い）。
     将来 `<button>` でない押しものを足したら、ここに一行足す */
  const HIT = 'button,[role="button"]';

  /* 鳴らさない場所。**ここ一箇所で決める**（画面ごとに分岐を散らさない）。

     - `body.inMatch` … 対局中。牌は `<span>` なので元より引っかからないが、
       鳴きやリーチの釦は `UI.buttons` が自分で `tap` を鳴らしている。
       ここで鳴らすと二重になる。**対局の音は ui.js の持ち物**（spec.md §2.3）
     - `[data-nosound]` … 個別に黙らせる逃げ道。自分か先祖に付いていれば鳴らない */
  function muted(el) {
    if (document.body && document.body.classList.contains('inMatch')) return true;
    return !!el.closest('[data-nosound]');
  }

  /* 最初の pointerdown で初期化する。**いままでは大会の「卓に着く」だけが解除の口**
     だったので、表紙から入って事務所を触っても AudioContext が無かった。
     ここで前に出す。**二度目からは呼ばない**（`Sound.load()` は
     読み込み中の Promise を使い回すが、init/volume を毎回叩く理由が無い） */
  let started = false;
  function ensure() {
    if (started) return;
    started = true;
    Sound.init();
    Sound.load();
  }

  document.addEventListener('pointerdown', (e) => {
    if (typeof Sound === 'undefined') return;
    const t = e.target;
    if (!t || !t.closest) return;
    /* **初期化は釦かどうかに関わらず、最初の一押しで。**
       釦以外を先に触った人が、次の釦で無音になるのを避ける */
    ensure();
    const hit = t.closest(HIT);
    if (!hit || hit.disabled) return;
    if (muted(hit)) return;
    /* 音量0なら Sound.play が黙って何もしない（sound.js の `vol <= 0`） */
    Sound.play('tap');
  }, { passive: true, capture: true });
})();
