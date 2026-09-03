/* ============================================================
   トップページとプレイヤー設定 — title.js
   依存：characters.js / theme.css / meikan.css / title.css

   使い方：
     Title.mount(root, store)
     store は { get, set, onStart(), onContinue() } を持つ。

   プレイヤーも女性の雀士。開始時に名前と顔を決める。
   顔は img/p1.webp 〜 p4.webp を読む。無ければシルエットに落ちるので、
   画像が届く前でも最後まで通る。

   state に足すもの：
     playerName  プレイヤーの名前
     playerFace  'p01'〜'p12'（画像のファイル名。idではないので雀ドルの番号と衝突しない）
     officeName  事務所名（12文字まで。**入力がそのまま入るので必ず esc()**）
     officePref  本拠地の県 key（`geo.js` の PREFS。一度きりの選択）

   事務所名と本拠地は `docs/design/office/spec.md` §5。
   **県を選ぶ部品は `office.js` の `Office.prefPickerHtml` / `bindPicker` を借りる。**
   単体ページ（team.html / taikai.html / meikan.html）は `geo.js` も `office.js` も
   読んでいないので、**無ければその二つの欄を出さない**。名前と顔だけで通る。
   ============================================================ */

const Title = (() => {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const pad3 = (id) => String(id).padStart(3, '0');
  const yen = (n) => n.toLocaleString('ja-JP') + '円';

  /* 顔の候補。増やすときはここに足して img/<key>.webp を置くだけ */
  const FACES = [
    { key: 'p01', note: '黒髪のボブ・黒いニット' },
    { key: 'p02', note: '黒髪のロング・トレンチコート' },
    { key: 'p03', note: '茶髪のショート・グレーの上着' },
    { key: 'p04', note: '黒髪のポニーテール・白いシャツ' },
    { key: 'p05', note: '黒髪のボブ・黒いリブ' },
    { key: 'p06', note: '黒髪のボブ・振り返り' },
    { key: 'p07', note: '黒髪のロング・正面' },
    { key: 'p08', note: '黒髪のロング・やわらかい表情' },
    { key: 'p09', note: '茶髪のショート・微笑み' },
    { key: 'p10', note: '茶髪のまとめ髪・微笑み' },
    { key: 'p11', note: 'ポニーテール・腕時計' },
    { key: 'p12', note: 'ポニーテール・腕組み' },
  ];
  const DEFAULT_FACE = 'p01';

  const DEFAULT_NAME = '沢渡 ちはる';

  /* 表紙の題字。PLiCyのサムネイルはcanvasの中身だけを撮るので、
     表紙の絵はDOMではなくcanvasに描く（公式FAQ：
     「スクリーンショットにはCanvas以外の内容は撮影されません」）。
     canvasは常にDOMに置いたままにして、いつ撮影されても絵が出るようにする。 */
  const TITLE = '雀ドル発掘放浪記';
  const SUBTITLE = 'その雀荘に、まだ見ぬ雀ドルがいる';

  /* 4:3。サムネイルの縦横比がそのままこの比率になる */
  const COVER_W = 1200, COVER_H = 900;
  const COVER_COLS = 6, COVER_ROWS = 3;

  function loadImage(src) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = src;
    });
  }

  async function drawCover(canvas, ids) {
    const g = canvas.getContext('2d');
    canvas.width = COVER_W; canvas.height = COVER_H;

    /* 下地。画像が一枚も読めなくても成立するように先に塗る */
    g.fillStyle = '#0d1f1a';
    g.fillRect(0, 0, COVER_W, COVER_H);

    const cw = COVER_W / COVER_COLS, ch = COVER_H / COVER_ROWS;
    const imgs = await Promise.all(ids.slice(0, COVER_COLS * COVER_ROWS).map(loadImage));

    imgs.forEach((im, n) => {
      const x = (n % COVER_COLS) * cw, y = Math.floor(n / COVER_COLS) * ch;
      if (!im) { g.fillStyle = '#164236'; g.fillRect(x, y, cw, ch); return; }
      /* cover 相当。顔が上寄りなので少し上を残して切る */
      const s = Math.max(cw / im.width, ch / im.height);
      const dw = im.width * s, dh = im.height * s;
      g.drawImage(im, x + (cw - dw) / 2, y + (ch - dh) * 0.12, dw, dh);
    });

    /* 上下から漆をかけて題字を乗せる場所を作る */
    const veil = g.createLinearGradient(0, 0, 0, COVER_H);
    veil.addColorStop(0, 'rgba(8,16,16,.30)');
    veil.addColorStop(0.24, 'rgba(8,16,16,.04)');
    veil.addColorStop(0.52, 'rgba(8,16,16,.42)');
    veil.addColorStop(0.78, 'rgba(8,16,16,.90)');
    veil.addColorStop(1, '#081010');
    g.fillStyle = veil;
    g.fillRect(0, 0, COVER_W, COVER_H);

    /* 看板の灯り */
    const glow = g.createRadialGradient(COVER_W / 2, COVER_H * 0.76, 10,
                                        COVER_W / 2, COVER_H * 0.76, COVER_W * 0.46);
    glow.addColorStop(0, 'rgba(255,58,140,.24)');
    glow.addColorStop(1, 'rgba(255,58,140,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, COVER_W, COVER_H);

    const glow2 = g.createRadialGradient(COVER_W / 2, COVER_H * 0.90, 10,
                                         COVER_W / 2, COVER_H * 0.90, COVER_W * 0.34);
    glow2.addColorStop(0, 'rgba(60,220,255,.14)');
    glow2.addColorStop(1, 'rgba(60,220,255,0)');
    g.fillStyle = glow2;
    g.fillRect(0, 0, COVER_W, COVER_H);

    /* 題字。ネオン管に見えるよう、外側から内側へ重ねて描く */
    const fam = '"Maru","Hiragino Maru Gothic ProN","M PLUS Rounded 1c",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';

    g.font = '800 118px ' + fam;
    const ty = COVER_H * 0.76;
    [[26, 'rgba(255,58,140,.95)'], [16, 'rgba(255,58,140,1)'], [6, '#ffffff']]
      .forEach(([blur, color]) => {
        g.shadowColor = color; g.shadowBlur = blur;
        g.fillStyle = '#ffe9f3';
        g.fillText(TITLE, COVER_W / 2, ty);
      });
    g.shadowBlur = 0;

    /* 副題は水色。看板の桃色に対して、店内の緑と反対側の色を当てる */
    g.font = '700 44px ' + fam;
    [[20, 'rgba(60,220,255,.95)'], [10, 'rgba(60,220,255,1)']].forEach(([blur, color]) => {
      g.shadowColor = color; g.shadowBlur = blur;
      g.fillStyle = '#c9f6ff';
      g.fillText(SUBTITLE, COVER_W / 2, ty + 74);
    });
    g.shadowBlur = 0;
  }

  /* 埋め込みフォントが届く前に描くと、丸ゴにならない */
  async function readyFont() {
    if (!document.fonts || !document.fonts.load) return;
    try {
      await Promise.all([
        document.fonts.load('800 118px Maru', TITLE),
        document.fonts.load('700 34px Maru', SUBTITLE),
      ]);
      await document.fonts.ready;
    } catch (e) { /* 読めなくても既定の書体で描く */ }
  }

  /* 外枠から呼ぶ。canvasは画面を移っても消さない */
  async function paintCover(canvas, st) {
    const ids = wallIds(st || {}, COVER_COLS * COVER_ROWS);
    await readyFont();
    await drawCover(canvas, ids.map((id) => `img/${pad3(id)}.webp`));
  }

  /* 表紙に並べる顔。発見済みがいればそこから、いなければ全員から選ぶ */
  function wallIds(st, n) {
    const found = (st.discovered || []).filter((id) => id <= 73);
    const pool = found.length >= n ? found : JANDOLS.map((c) => c.id);
    const out = [];
    const bag = pool.slice();
    while (out.length < n && bag.length) {
      out.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
    }
    return out;
  }

  function faceSrc(key) { return `img/${normalizeFace(key)}.webp`; }

  /* 雀ドルの総数。characters.js に足せば自動で追随する。
     題字と副題に数を入れていないのも同じ理由（増やすたびに嘘になるうえ、
     埋め込みフォントは使う文字だけを切り出しているので数字を足すと崩れる） */
  function TOTAL() { return JANDOLS.length + FREE_AGENTS.length; }

  /* 候補を4枚から12枚に増やしたとき、古いセーブの p1〜p4 が
     別人を指してしまうので、知らないキーは既定に寄せる */
  function normalizeFace(key) {
    return FACES.some((f) => f.key === key) ? key : DEFAULT_FACE;
  }

  /* ------------------------------------------------------------
     マウント
  ------------------------------------------------------------ */
  /* いま張ってある resize の後始末用。mount は表紙に戻るたび呼ばれる */
  let mounted = null;

  function mount(root, store) {
    ensureSilVar();
    root.innerHTML = '';
    root.classList.add('ttRoot');

    let screen = 'top';
    let name = store.get().playerName || DEFAULT_NAME;
    let face = normalizeFace(store.get().playerFace);
    /* 事務所は office.js が居るときだけ聞く（単体ページには無い） */
    const hasOffice = typeof Office !== 'undefined' && typeof Geo !== 'undefined';
    let office = String(store.get().officeName || '').trim();
    let officeTouched = !!office;      // 触るまでは名前に追従させる
    let pref = store.get().officePref || null;

    /* ---------- 表紙 ---------- */
    function renderTop() {
      const st = store.get();
      const started = !!st.teamDecided;
      let state = '';
      if (started) {
        const mates = (st.contracted || []).slice(0, 5);
        state = `<div class="ttState">
          <div class="ttStateT">事務所の様子</div>
          <div class="ttStateRow">
            <span class="ttStateItem">所属 <b>${(st.contracted || []).length}</b>人</span>
            <span class="ttStateItem">所持金 <b>${yen(st.money || 0)}</b></span>
            <span class="ttStateItem">段位 <b>${st.playerRank || 'D'}</b></span>
            <span class="ttStateItem">発見 <b>${(st.discovered || []).length}</b>／${TOTAL()}</span>
          </div>
          <div class="ttRoster">${mates.map((id) =>
            `<span><img src="img/${pad3(id)}.webp" alt="" onerror="this.remove()"></span>`).join('')}</div>
        </div>`;
      }

      /* 表紙の絵は #cover のcanvasが受け持つ。ここには文字を置かない */
      root.innerHTML = `
        <div class="ttBody">
          ${state}
          <p class="ttLead">全国の雀荘を歩いて雀ドルを見つけ、口説き、育てて、大会に出す。
            最後は最強の八人「雀エイト」を、あなたの事務所で独占する。</p>
          <div class="ttActions">
            ${started ? `<button type="button" class="ttBtn" data-act="continue">続きから</button>` : ''}
            <button type="button" class="ttBtn${started ? ' ghost' : ''}" data-act="new">
              ${started ? '最初からはじめる' : 'はじめる'}</button>
          </div>
          <p class="ttFoot">本格麻雀。イカサマなし、牌操作なし。</p>
        </div>`;
      fitTop();
    }

    /* 表紙が画面に収まるか実測して、はみ出すぶんだけ中身を落とす。

       表紙の高さは title.css が max-height で詰めるが、下限（150px）を
       割ると題字が読めなくなる。そこから先は中身のほうを落とす。
       **落とす順は あらすじ → ロスター。**題字は表紙でしか見せられないが、
       あらすじは他でも読ませられるので、優先順位は題字が上。

       メディアクエリではなく実測にしてあるのは、**同じ画面の高さでも
       セーブの進み具合で中身の高さが変わる**ため。新規のセーブは
       ボタンが1つで「事務所の様子」も無いので余裕があり、あらすじを
       消す必要がない。あらすじは新規のプレイヤーにこそ要る文章なので、
       消さずに済むなら残す。書体が代替に落ちて行数が増えた場合にも効く。 */
    const FIT_MARGIN = 8;         // 端ぎりぎりに置かない

    /* **スクロール位置に依存しない測り方をすること。**
       getBoundingClientRect は見えている枠が基準なので、#scroll が下に
       送られたまま測ると、ボタンが上にあるように見えて「収まっている」と
       誤判定する（設定から戻ったときに実際そうなった）。
       枠の中身の座標に直してから、枠の見える高さと比べる。
       単体ページには #scroll が無いので、そのときは文書全体で測る。 */
    function fitsInView() {
      const btns = root.querySelectorAll('.ttBtn');
      const last = btns[btns.length - 1];
      if (!last) return true;
      const host = document.getElementById('scroll') || document.documentElement;
      const bottom = last.getBoundingClientRect().bottom
        - host.getBoundingClientRect().top + host.scrollTop;
      return bottom <= host.clientHeight - FIT_MARGIN;
    }

    function fitTop() {
      if (screen !== 'top') return;
      root.classList.remove('noLead', 'noRoster');
      if (fitsInView()) return;
      root.classList.add('noLead');
      if (fitsInView()) return;
      root.classList.add('noRoster');
    }

    /* ---------- プレイヤー設定 ---------- */
    function renderSetup() {
      root.innerHTML = `
        <div class="ttSetup">
          <h1 class="ttSetupT">あなたのこと</h1>
          <p class="ttNote">事務所を開くのはあなたです。名前と顔を決めてください。あとから変えられます。</p>

          <div class="ttField">
            <label class="ttLabel" for="ttName">名前</label>
            <input class="ttInput" id="ttName" type="text" maxlength="12" value="${esc(name)}"
              autocomplete="off" spellcheck="false">
            <p class="ttNote">名鑑や大会の着順表にこの名前で出ます。</p>
          </div>

          <div class="ttField">
            <span class="ttLabel">顔</span>
            <div class="ttFaces">
              ${FACES.map((f) => `<button type="button" class="ttFace sil" data-face="${f.key}"
                  aria-pressed="${face === f.key}" aria-label="${esc(f.note)}">
                <img src="${faceSrc(f.key)}" alt="" onerror="this.remove()"></button>`).join('')}
            </div>
            <p class="ttNote">押すと大きく見られます。十二人から選べます。あとから変えられます。</p>
          </div>

          ${hasOffice ? `
          <div class="ttField">
            <label class="ttLabel" for="ttOffice">事務所の名前</label>
            <input class="ttInput" id="ttOffice" type="text" maxlength="${Office.NAME_MAX}"
              value="${esc(officeName())}" autocomplete="off" spellcheck="false">
            <p class="ttNote">${Office.NAME_MAX}文字まで。空のままにすると名前から作ります。</p>
          </div>

          <div class="ttField">
            <span class="ttLabel">本拠地</span>
            <p class="ttNote">遠征の起点になります。<b>あとから変えられません。</b></p>
            ${Office.prefPickerHtml(pref)}
          </div>` : ''}

          <hr class="kinsen">
          <button type="button" class="ttBtn" data-act="go"
            ${hasOffice && !pref ? 'disabled' : ''}>この人ではじめる</button>
          <button type="button" class="ttBtn ghost" data-act="back" style="margin-top:8px">戻る</button>
        </div>`;
      const input = root.querySelector('#ttName');
      input.addEventListener('input', () => {
        name = input.value;
        /* 事務所名を触っていないあいだは、名前に追従させる */
        if (!officeTouched) {
          const oi = root.querySelector('#ttOffice');
          if (oi) oi.value = officeName();
        }
      });
      const oin = root.querySelector('#ttOffice');
      if (oin) oin.addEventListener('input', () => {
        office = oin.value;
        officeTouched = true;
      });
      if (hasOffice) Office.bindPicker(root, (key) => {
        pref = key;
        renderSetup();
        /* 描き直したので、入力中の値を書き戻す */
        const ni = root.querySelector('#ttName'); if (ni) ni.value = name;
        const oi = root.querySelector('#ttOffice'); if (oi) oi.value = officeName();
      });
    }

    /* いま出す事務所名。触っていなければ「{名前の先頭語}事務所」（spec.md §5） */
    function officeName() {
      if (officeTouched) return office;
      return hasOffice ? Office.defaultName((name || '').trim() || DEFAULT_NAME) : '';
    }

    /* ---------- 操作 ---------- */
    /* 一覧の顔は小さいので、押したら大きく見てから決められるようにする */
    function showFace(key) {
      const info = FACES.find((f) => f.key === key) || FACES[0];
      const ov = document.createElement('div');
      ov.className = 'popup';
      ov.innerHTML = `<div class="popupBox" role="dialog" aria-modal="true"
          aria-label="${esc(info.note)}">
        <button type="button" class="popupClose" aria-label="閉じる">✕</button>
        <div class="popupPhoto">
          <span class="mkFace sil"><img src="${faceSrc(key)}" alt="" onerror="this.remove()"></span>
        </div>
        <div class="popupBody">
          <div class="popupNote">${esc(info.note)}</div>
          <button type="button" class="ttBtn" data-take="${key}">この顔にする</button>
        </div>
      </div>`;

      function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
      function onKey(e) { if (e.key === 'Escape') close(); }
      ov.addEventListener('click', (e) => {
        if (e.target === ov || e.target.closest('.popupClose')) { close(); return; }
        const take = e.target.closest('[data-take]');
        if (take) {
          face = take.dataset.take;
          root.querySelectorAll('[data-face]').forEach((b) =>
            b.setAttribute('aria-pressed', b.dataset.face === face));
          close();
        }
      });
      document.addEventListener('keydown', onKey);
      document.body.append(ov);
      ov.querySelector('[data-take]').focus();
    }

    root.addEventListener('click', (e) => {
      const f = e.target.closest('[data-face]');
      if (f) { showFace(f.dataset.face); return; }
      const act = e.target.closest('[data-act]');
      if (!act) return;

      if (act.dataset.act === 'continue') {
        if (typeof store.onContinue === 'function') store.onContinue();
      } else if (act.dataset.act === 'new') {
        screen = 'setup';
        renderSetup();
        toTop();
      } else if (act.dataset.act === 'back') {
        screen = 'top';
        renderTop();
        toTop();
      } else if (act.dataset.act === 'go') {
        if (hasOffice && !pref) return;              // 本拠地は必ず選ばせる
        const clean = (name || '').trim() || DEFAULT_NAME;
        const patch = { playerName: clean, playerFace: face };
        if (hasOffice) {
          /* **入力された文字がそのまま入る。**出すときは必ず esc() を通すこと */
          const on = (officeTouched ? office : Office.defaultName(clean)).trim();
          patch.officeName = (on || Office.defaultName(clean)).slice(0, Office.NAME_MAX);
          patch.officePref = pref;
        }
        store.set(patch);
        if (typeof store.onStart === 'function') store.onStart(clean, face);
      }
    });

    /* 流れるのは shell.html の #scroll。単体ページにはそれが無い */
    function toTop() {
      const sc = document.getElementById('scroll');
      if (sc) sc.scrollTop = 0; else window.scrollTo(0, 0);
    }

    /* 画面の高さが変わったら測り直す。
       mount は表紙に戻るたび呼ばれるので、前の分を必ず外してから足す */
    if (mounted) window.removeEventListener('resize', mounted);
    mounted = () => fitTop();
    window.addEventListener('resize', mounted);

    renderTop();
    return {
      refresh: function () { if (screen === 'top') renderTop(); else renderSetup(); },
    };
  }


  function ensureSilVar() {
    if (document.documentElement.style.getPropertyValue('--sil-img')) return;
    const svg = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<g fill="#0d1f1a"><circle cx="50" cy="30" r="17"/>' +
      '<path d="M14 100 C17 66 36 54 50 54 C64 54 83 66 86 100 Z"/></g></svg>'
    );
    document.documentElement.style.setProperty('--sil-img', `url("data:image/svg+xml,${svg}")`);
  }

  return {
    mount, FACES, DEFAULT_NAME, DEFAULT_FACE, faceSrc, normalizeFace,
    TITLE, SUBTITLE, paintCover, COVER_W, COVER_H,
  };
})();

if (typeof module !== 'undefined') module.exports = Title;
