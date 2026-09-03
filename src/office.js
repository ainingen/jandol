/* ============================================================
   事務所ハブ — office.js
   依存：characters.js / geo.js / jansou.js（営業の入口）/ title.js（顔）

   使い方：
     Office.mount(root, store, opts) -> controller
     store は { get, set } のほか、任意で
       go(name, opts)   … 他の画面へ送る（shell.html が入れる）
       startDay()       … 昼（雀荘の営業）へ送る（shell.html が入れる）
     を持つ。単体ページ（office.html）にはどちらも無いので、
     **無ければ釦を出さない**（他の画面と同じ作法）。

     opts.phase === 'night' で夜（日報）から始まる。既定は朝。

   設計は docs/design/office/spec.md。第一段（§14 の 1）の範囲：
   **ハブと日の一本化だけ。**配置（assign）・遠征（trip）・依頼（offers）は
   まだ無い。大会とスカウトは従来どおり回数制で、日を消費しない。

   ------------------------------------------------------------
   一日の形（spec.md §6.1）
   ------------------------------------------------------------
     朝（事務所）  所属を見る → 「今日を始める」
     昼（店があれば）雀荘のフロアで一日が流れる（既存の再生。一行も動かしていない）
       （店が無ければ）雀荘へ委譲しない。事務所の中で一行出して夜へ
     夜（事務所）  日報 → 「明日へ」→ 朝

   **`parlor.day` を進めるのは `Jansou` の `settle()` の中。**
   ここは純関数で、「スキップしても再生しても完全一致」（jansou/spec.md §16）が
   乗っている場所なので触らない。だから
   **「明日へ」は日を進めない。夜を畳んで朝へ戻すだけ。**

   **日は店の有無に関係なく進む**（office/spec.md §1.2）。
   開店資金50万を貯めているあいだも「今日を始める」で一日が過ぎ、
   所属の日当は出ていく。**弱小事務所なので最初は店を持てない**が、
   「まず店を持つ」が序盤の最初の節目になる。
   店が無い日は `Jansou.runClosedDay()` が卓0で同じ締めを通す——
   客0・売上0・家賃0で、日当だけが引かれる。

   ------------------------------------------------------------
   セーブ（spec.md §10）
   ------------------------------------------------------------
   **最上位に持つ。`parlor` の下ではない**（`Jansou.normalize()` は
   知らないキーを捨てるため。引き継ぎ書 §5）。既定値は `shell.html` の
   `blankState()` / `loadState()` にある。ここでは読むときに必ず埋め直す。

     officeName  事務所名（プレイヤーの入力がそのまま入る。**必ず esc()**）
     officePref  本拠地の県 key。無ければ一度だけ選ばせる（§5）
   ============================================================ */

const Office = (() => {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const pad3 = (id) => String(id).padStart(3, '0');
  const yen = (n) => Math.round(n).toLocaleString('ja-JP') + '円';

  const NAME_MAX = 12;

  /* 事務所名の既定。`playerName` を空白で切った先頭に「事務所」を付ける。
     切れなければ名前全体（spec.md §5）。全角の空白も切れ目として見る */
  function defaultName(playerName) {
    const head = String(playerName || '').trim().split(/[\s　]+/)[0];
    return (head || '') + '事務所';
  }

  /* 保存された事務所名。空なら既定で埋める。**出すときは必ず esc() を通す** */
  function nameOf(st) {
    const v = String(st.officeName || '').trim();
    return v ? v.slice(0, NAME_MAX) : defaultName(st.playerName);
  }

  /* 本拠地。未選択なら null（§5：既定を勝手に決めない。一度きりの選択なので） */
  function prefOf(st) {
    return (st.officePref && Geo.prefOf(st.officePref)) || null;
  }

  /* 働ける子＝チーム＋契約済み。完成度と段位はセーブのほうを写す
     （`jansou.js` の roster() と同じ形。あちらは mount の中の閉包なので借りられない） */
  function rosterOf(st) {
    const all = JANDOLS.concat(FREE_AGENTS);
    const ids = Array.from(new Set((st.team || []).concat(st.contracted || [])));
    return ids.map((id) => {
      const base = all.find((c) => c.id === id);
      if (!base) return null;
      return Object.assign({}, base, {
        comp: (st.comp || {})[id] != null ? st.comp[id] : base.comp,
        rank: (st.grades || {})[id] || base.rank,
        favor: (st.favor || {})[id] || 0,
      });
    }).filter(Boolean);
  }

  /* 雀荘の状態。`Jansou.normalize()` を通して読む（既定値をここで持たない） */
  function parlorOf(st) {
    return typeof Jansou !== 'undefined' ? Jansou.normalize(st.parlor) : null;
  }

  /* ------------------------------------------------------------
     画面
  ------------------------------------------------------------ */
  function mount(root, store, opts) {
    opts = opts || {};
    ensureSilVar();
    root.innerHTML = '';
    root.classList.add('ofRoot');

    /* 本拠地が無ければ、何をおいても先に選ばせる（§5）。
       新規開始では title.js が聞くので、ここに来るのは
       **`officePref` を持たない既存セーブだけ**。一度きり */
    let screen = prefOf(store.get()) ? (opts.phase === 'night' ? 'night' : 'morning') : 'pick';
    let pick = null;          // 本拠地の選択中の県 key
    /* 夜に出す、その日ぶんの控え。店が無い日だけ使う（日当の額）。
       `parlor.log` は {day, guests, sales, profit} しか持たないため */
    let night = null;

    const canGo = typeof store.go === 'function';
    const canRun = typeof store.startDay === 'function';

    /* ---------- 本拠地を選ぶ ---------- */
    function renderPick() {
      const st = store.get();
      root.innerHTML = `
        <div class="ofSetup">
          <h1 class="ofSetupT">本拠地はどこに</h1>
          <p class="ofNote">${esc(nameOf(st))} を置く県を決めます。
            ここが遠征の起点になります。<b>あとから変えられません。</b></p>
          ${prefPickerHtml(pick)}
          <hr class="kinsen">
          <button type="button" class="ofBtn" data-act="pick" ${pick ? '' : 'disabled'}>
            ここに事務所を構える</button>
        </div>`;
      bindPicker(root, (key) => { pick = key; renderPick(); });
      const go = root.querySelector('[data-act="pick"]');
      if (go) go.addEventListener('click', () => {
        if (!pick) return;
        store.set({ officePref: pick, officeName: nameOf(store.get()) });
        screen = 'morning';
        render();
      });
    }

    /* ---------- 朝 ---------- */
    function renderMorning() {
      const st = store.get();
      const pref = prefOf(st);
      const parlor = parlorOf(st);
      const list = rosterOf(st);
      /* **`parlor.day` は「終わった日数」。**これから回すのは day + 1 日目
         （雀荘の画面が「${parlor.day}日目」と出しているのは、そちらが
         済んだぶんを数えているため。朝はこれから始める日を出す） */
      const day = parlor ? parlor.day : 0;

      /* 所属一覧。**`pop` と `favor` はいままでどこにも出ていなかった**（引き継ぎ書 §3）。
         ここが初出。`.mkFace` を借りるので、親を position:relative にすること
         （引き継ぎ書 §5「顔写真の .mkFace を借りるときは position を上書きする」）。
         office.css の `.ofMate .mkFace` がそれを戻している */
      const mates = list.length ? list.map((c) => `
        <div class="ofMate">
          <span class="mkFace sil"><img src="img/${pad3(c.id)}.webp" alt="" loading="lazy"
            onerror="this.remove()"></span>
          <span class="ofMateBody">
            <span class="ofMateName">${esc(c.name)}</span>
            <span class="ofMateSub">${esc(c.rank)}級　完成度 ${c.comp}</span>
          </span>
          <span class="ofMateNums">
            <span class="ofNum">人気 <b>${c.pop}</b></span>
            <span class="ofNum${c.favor ? ' on' : ''}">好感度 <b>${c.favor}</b></span>
          </span>
        </div>`).join('')
        : '<p class="ofEmpty">まだ誰も所属していません。チーム編成から始めてください。</p>';

      /* 昼の釦。**店が無くても日は進む**（office/spec.md §1.2）。
         店があれば雀荘へ降り、無ければ事務所の中で夜へ抜ける */
      const open = !!(parlor && parlor.open);
      const wages = list.reduce((a, c) => a + Jansou.wageOf(c), 0);
      let action;
      if (!list.length) {
        action = `<button type="button" class="ofRunBtn" disabled>今日を始める</button>
          <p class="ofNote">まだ誰も所属していません。チーム編成から始めてください。</p>`;
      } else if (open) {
        action = `<button type="button" class="ofRunBtn" id="ofRun" ${canRun ? '' : 'disabled'}>
            今日を始める</button>
          <p class="ofNote">${day + 1}日目の営業に降ります。シフトは雀荘の画面から。</p>`;
      } else {
        action = `<button type="button" class="ofRunBtn" id="ofRun">今日を始める</button>
          <p class="ofNote">まだ店がありません。今日は営業しない一日になりますが、
            <b>日当 ${yen(wages)}</b> は出ていきます。<br>
            開店資金 ${yen(Jansou.OPEN_COST)} を貯めて、まず店を持つこと。</p>
          <button type="button" class="ofRunBtn ghost" data-go="jansou" ${canGo ? '' : 'disabled'}
            style="margin-top:10px">雀荘を開く</button>`;
      }

      root.innerHTML = `
        <div class="ofHead">
          <h1 class="ofTitle">${esc(nameOf(st))}</h1>
          <p class="ofSub">${pref ? esc(pref.name) : ''}　${day + 1}日目の朝</p>
        </div>

        <div class="ofBar">
          <span class="ofStat">所持金 <b>${yen(st.money || 0)}</b></span>
          <span class="ofStat">所属 <b>${list.length}</b>人</span>
          <span class="ofStat">段位 <b>${esc(st.playerRank || 'D')}</b></span>
          ${open ? `<span class="ofStat">評判 <b>${parlor.rep}</b></span>`
            : '<span class="ofStat">店 <b>まだ無い</b></span>'}
        </div>

        <div class="ofRun">${action}</div>

        <h2 class="ofSecT">所属</h2>
        <div class="ofMates">${mates}</div>

        <h2 class="ofSecT">出かける</h2>
        <div class="ofDoors">
          ${door('jansou', '雀荘', '営業と設備、シフト')}
          ${door('scout', 'スカウト', '雀荘をまわって発掘する')}
          ${door('taikai', '大会', '賞金と名声を取りに行く')}
          ${door('team', 'チーム', '出場する三人を組む')}
          ${door('meikan', '名鑑', '見つけた雀ドルを見る')}
        </div>
        <p class="ofNote">スカウトと大会は、いまはまだ日を消費しません。</p>`;

      const run = root.querySelector('#ofRun');
      if (run) run.addEventListener('click', () => {
        if (open) { if (canRun) store.startDay(); return; }
        /* **店が無い日の昼は、雀荘へ委譲しない。**ここで締めを通して夜へ。
           日を進めるのは `settle`（`runClosedDay` の中）一箇所のまま */
        night = { closed: true, wages };
        Jansou.runClosedDay(store, list);
        screen = 'night';
        render();
      });
      bindDoors(root);
    }

    function door(key, label, note) {
      return `<button type="button" class="ofDoor" data-go="${key}" ${canGo ? '' : 'disabled'}>
        <span class="ofDoorT">${label}</span><span class="ofDoorN">${note}</span></button>`;
    }

    function bindDoors(host) {
      host.querySelectorAll('[data-go]').forEach((b) => {
        b.addEventListener('click', () => { if (canGo) store.go(b.dataset.go); });
      });
    }

    /* ---------- 夜 ---------- */
    /* 詳しい日報は雀荘のポップアップ（`showResult`）が出しきっている。
       ここは一日を締める枠で、収支だけを一行で置いて朝へ返す。
       **数字は `parlor.log` の最後の一件から読む**（settle が書いたもの）。
       ここで計算し直さないこと。二重に持つと必ずずれる */
    function renderNight() {
      const st = store.get();
      const parlor = parlorOf(st);
      const last = parlor && parlor.log.length ? parlor.log[parlor.log.length - 1] : null;
      /* 店が無い日は、この画面が唯一の日報。日当の支出だけを載せる。
         店がある日の細かい日報は雀荘のポップアップが出しきっているので、
         ここは締めの枠として収支だけを置く */
      const closed = !!(night && night.closed);

      const body = last ? `
        ${closed
          ? `<div class="ofRepRow"><span>営業</span><b>していない</b></div>
             <div class="ofRepRow"><span>日当（${rosterOf(st).length}人）</span>
               <b>−${yen(night.wages)}</b></div>`
          : `<div class="ofRepRow"><span>客</span><b>${last.guests}人</b></div>
             <div class="ofRepRow"><span>場代</span><b>${yen(last.sales)}</b></div>`}
        <div class="ofRepRow${last.profit >= 0 ? '' : ' minus'}">
          <span>収支</span><b>${last.profit >= 0 ? '+' : '−'}${yen(Math.abs(last.profit))}</b></div>
        <div class="ofRepRow"><span>所持金</span><b>${yen(st.money || 0)}</b></div>`
        : '<p class="ofEmpty">今日の記録がありません。</p>';

      root.innerHTML = `
        <div class="ofHead">
          <h1 class="ofTitle">${last ? `${last.day}日目の夜` : '夜'}</h1>
          <p class="ofSub">${esc(nameOf(st))}${closed ? '　まだ店は無い' : ''}</p>
        </div>
        <div class="ofRep">${body}</div>
        <div class="ofRun">
          <button type="button" class="ofRunBtn" id="ofNext">明日へ</button>
          <p class="ofNote">日はもう進んでいます。畳んで朝に戻るだけの釦です。</p>
        </div>`;

      root.querySelector('#ofNext').addEventListener('click', () => {
        night = null;
        screen = 'morning';
        render();
      });
    }

    function render() {
      if (screen === 'pick') renderPick();
      else if (screen === 'night') renderNight();
      else renderMorning();
      root.scrollTop = 0;
    }

    render();
    return { refresh: render };
  }

  /* ------------------------------------------------------------
     本拠地の県を選ぶ部品 — title.js（新規開始）と office.js（既存セーブ）で共用
     地方ごとに区切って並べる。**全国地図は作らない**（spec.md §12）
  ------------------------------------------------------------ */
  function prefPickerHtml(selected) {
    const groups = REGIONS.map((r) => {
      const chips = Geo.prefsOf(r).map((p) =>
        `<button type="button" class="ofPref${selected === p.key ? ' on' : ''}"
           data-pref="${p.key}" aria-pressed="${selected === p.key}">${esc(p.name)}</button>`).join('');
      return `<div class="ofPrefGroup">
        <span class="ofPrefRegion">${esc(r)}</span>
        <div class="ofPrefChips">${chips}</div></div>`;
    }).join('');
    const sel = selected && Geo.prefOf(selected);
    return `<div class="ofPrefs">${groups}</div>
      <p class="ofPrefNote">${sel
        ? `<b>${esc(sel.name)}</b>　${esc(sel.note)}`
        : '県を選ぶと、その土地のことが出ます。'}</p>`;
  }

  /* 押されたら onPick(key)。呼ぶ側が描き直す（選択の状態を持たせない） */
  function bindPicker(host, onPick) {
    host.querySelectorAll('[data-pref]').forEach((b) => {
      b.addEventListener('click', () => onPick(b.dataset.pref));
    });
  }

  /* シルエットの変数は meikan.css が持っている。単体ページ用の保険
     （他の画面が持っているものと同じ） */
  function ensureSilVar() {
    if (document.getElementById('ofSilVar')) return;
    const s = document.createElement('style');
    s.id = 'ofSilVar';
    s.textContent = ':root{--sil:linear-gradient(160deg,#2a3a34,#16211d)}';
    document.head.appendChild(s);
  }

  return { mount, defaultName, nameOf, prefOf, rosterOf, prefPickerHtml, bindPicker, NAME_MAX };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Office };
}
