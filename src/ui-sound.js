/* ============================================================
   釦の音 — ui-sound.js
   依存：Sound（あれば使う）。無ければ何もしない

   docs/design/match/spec.md §2.7。**対局の外の音は、ぜんぶここが持つ。**

     (A) 釦の音 … 表紙・事務所・雀荘・大会・遠征・名鑑・名簿。押しても無音だった
     (B) 営業中の店の牌の音 … 「客が打っている気配」。既存の discard / draw を
         **まばらに**鳴らす。新しい音源は足していない

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
   - **`setInterval` も rAF も持たない。**営業の音は店の進行に相乗りしている
     ——四人卓で落ちた件（毎秒の書き換えで描画側の資源が尽きた）と同じ土地なので、
     **音のために時計を増やさない。**相乗りしているから「止めかた」も要らない
     （店が止まれば合図が来なくなるだけ）
   ============================================================ */

const UiSound = (() => {
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

  /* ============================================================
     (B) 営業中の店の牌の音（spec.md §2.7）

     `jansou-floor.js` の再生層が、タイムラインの節目ごとに
     `UiSound.floor(kind, speed)` を呼ぶ（**あれば使う**の一行）。
     **あちらは Node から読まれている**（test-jansou / test-office / test-scout）
     ので、`Sound` を置くことはできない。**policy は全部こちら側。**

     当てたのは二つ。どちらも帳簿層が Σ で保証している節目なので、
     **賑わいがそのまま音の密度になる**（客が多い日は忙しく聞こえる）。

       arrive（客が入って卓に着く）→ draw   ツモ。軽い
       pay   （半荘が終わって場代を払う）→ discard  打牌。一番よく鳴る音

     **まばらに、が肝。**倍速とスキップがあるので、一律に鳴らすと
     倍速で機械銃になる。速さで割った上限で間引く。 */

  /* **一秒あたりの上限。ここ一箇所。**×1 で 3回/秒、×2 で 1.5回/秒、×4 で 0.75回/秒 */
  const FLOOR_MAX_PER_SEC = 3;
  /* 遠くの卓なので小さく。打牌の ±8% の揺らぎは本編（±3%）より広い
     ——何人も別々に打っているので、揃っていないほうが自然 */
  const FLOOR_GAIN = 0.34;
  const FLOOR_WOBBLE = 0.08;
  /* タイムラインの節目 → 論理名。**ここに無い節目では鳴らさない** */
  const FLOOR_SOUND = { arrive: 'draw', pay: 'discard' };

  let floorAt = 0;

  /* 呼ぶのは `jansou-floor.js` の再生層だけ。**鳴らしたら true** */
  function floor(kind, speed) {
    if (typeof Sound === 'undefined') return false;
    const name = FLOOR_SOUND[kind];
    if (!name) return false;
    /* タブが隠れているあいだは鳴らさない。戻っても溜まらない
       ——ここは「いま来た合図」しか見ていない（待ち行列を持たない） */
    if (typeof document !== 'undefined' && document.hidden) return false;
    const per = FLOOR_MAX_PER_SEC / Math.max(1, speed || 1);
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - floorAt < 1000 / per) return false;
    floorAt = now;
    return !!Sound.play(name, {
      gain: FLOOR_GAIN,
      rate: 1 + (Math.random() * 2 - 1) * FLOOR_WOBBLE,
    });
  }

  return { floor, FLOOR_MAX_PER_SEC, FLOOR_SOUND };
})();
