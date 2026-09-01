/* ============================================================
   チーム編成 — team.js
   依存：characters.js（FREE_AGENTS / STYLES / PLAYER）
        tournament.js（paramsOf / strengthOf / gradeOf）
        meikan.css（シルエットとランクバッジを共有）と team.css

   使い方：
     Team.mount(rootElement, store)
     store は { get() → state, set(patch), onDecided(ids) } を持つ。
     state.team … 選んだ仲間3人のid配列（順不同）

   初期メンバー10人（id 64〜73）から3人を選ぶ。全員D級・契約金なしで、
   打ち筋が全員違う。ここが実質のチュートリアルなので、
   「どれを選んでも間違いではないが、選び方で色が変わる」ことを見せる。
   ============================================================ */

const Team = (() => {
  'use strict';

  const SEATS = 3;                 // プレイヤー以外の枠
  const KAZE = ['東', '南', '西', '北'];

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const pad3 = (id) => String(id).padStart(3, '0');

  /* 講評メーター。
     打ち筋の完成形（STYLES）で測る。未熟な時点の係数(rawParams)は
     全員「押しすぎ・守り甘い」に寄るので、どの三人を選んでも同じ講評になる。
     ここで見せたいのは「この三人が育つとどういう事務所になるか」なので完成形を使う。 */
  const METERS = [
    ['攻め',   (p) => (p.push * 0.6 + p.value * 0.4)],
    ['守り',   (p) => p.defense],
    ['速さ',   (p) => (p.speed * 0.65 + p.call * 0.35)],
    ['終盤',   (p) => p.endgame],
    ['安定',   (p) => 1 - p.variance],
  ];

  function teamMeters(list) {
    if (!list.length) return METERS.map(([label]) => [label, 0]);
    return METERS.map(([label, fn]) => {
      const avg = list.reduce((a, c) => a + fn(STYLES[c.style]), 0) / list.length;
      return [label, Math.max(0, Math.min(1, avg))];
    });
  }

  /* 3人そろったときの講評。優劣ではなく「どういう色になったか」を返す。
     しきい値は120通り（10C3）の実分布の四分位で決めてある */
  function verdict(list) {
    const m = Object.fromEntries(teamMeters(list));
    const potAvg = list.reduce((a, c) => a + c.pot, 0) / list.length;
    const gap = m['攻め'] - m['守り'];

    let line, note;
    if (gap > 0.08) {
      line = '攻めに寄った布陣';
      note = '押し合いに強い代わりに、放銃が増えます。'
        + '大会は合計点の勝負なので、誰かが大きく沈むと取り返しが利きません。';
    } else if (gap < -0.18) {
      line = '守りに寄った布陣';
      note = '大負けしにくい代わりに、トップが遠くなります。'
        + '賞金は順位で決まるので、序盤は資金が伸び悩むかもしれません。';
    } else {
      line = '攻守の釣り合いが取れた布陣';
      note = '尖りがないぶん、どの大会でも形になります。'
        + '色は育成で後からいくらでも付けられます。';
    }

    const extra = [];
    if (potAvg >= 74.5) extra.push('伸びしろが大きい三人です。今は弱くても、育てば化けます。');
    else if (potAvg <= 70.5) extra.push('今すぐ戦える三人です。そのぶん天井は低めになります。');
    if (m['速さ'] >= 0.62) extra.push('仕掛けが速く、短期決戦向きです。');
    else if (m['速さ'] <= 0.45) extra.push('手が遅いぶん、和了ったときは大きい編成です。');
    if (m['安定'] >= 0.84) extra.push('ムラが小さく、成績が読みやすい編成です。');
    else if (m['安定'] <= 0.77) extra.push('ムラが大きく、大会ごとの上下が激しくなります。');
    if (m['終盤'] >= 0.67) extra.push('終盤の条件戦に強く、僅差の勝負で伸びます。');

    return { line, note: note + (extra.length ? '　' + extra.join('　') : '') };
  }

  /* ------------------------------------------------------------
     マウント
  ------------------------------------------------------------ */
  function mount(root, store) {
    /* シルエットのCSS変数は名鑑と共有。単体で開いたときのために念のため */
    if (typeof Meikan !== 'undefined' && !document.documentElement.style.getPropertyValue('--sil-img')) {
      Meikan.mount; // 参照だけ。実際の注入は下の fallback で行う
    }
    ensureSilVar();

    const picked = (store.get().team || []).slice(0, SEATS);

    root.innerHTML = '';
    root.classList.add('tmRoot');
    const head = document.createElement('div');
    head.className = 'tmHead';
    head.innerHTML =
      `<h1 class="tmTitle">チームを組む</h1>` +
      `<p class="tmLead">事務所を開いたばかりのあなたに、三人まで面倒を見る余裕があります。` +
      `全員D級・契約金なし。打ち筋は十人とも違うので、選んだ三人がそのまま事務所の色になります。` +
      `大会では四人が別々の卓に散り、合計点で勝ち上がります。</p>`;

    const table = document.createElement('div');
    table.className = 'tmTable';

    const secT = document.createElement('h2');
    secT.className = 'tmSecT';
    secT.textContent = '入所希望者　十名';

    const grid = document.createElement('div');
    grid.className = 'tmGrid';

    const hint = document.createElement('p');
    hint.className = 'tmHint';
    hint.textContent = 'カードを押すと大きく見られます。卓の×でも外せます。';

    root.append(head, table, secT, grid, hint);

    const byId = (id) => FREE_AGENTS.find((c) => c.id === id);

    /* ---------- 卓 ---------- */
    function renderTable() {
      const list = picked.map(byId).filter(Boolean);
      const me = store.get();
      const myName = me.playerName || 'あなた';
      const myFace = Title.normalizeFace(me.playerFace);
      const seats = [`<button type="button" class="tmSeat you" disabled>
          <span class="tmSeatKaze">${KAZE[0]}</span>
          <span class="mkFace sil"><img src="img/${myFace}.webp" alt="" onerror="this.remove()"></span>
          <span class="tmSeatBar"><span class="tmSeatName">${esc(myName)}</span>
          <span class="tmSeatStyle">あなた</span></span></button>`];

      for (let i = 0; i < SEATS; i++) {
        const c = list[i];
        if (!c) {
          seats.push(`<button type="button" class="tmSeat" disabled>
            <span class="tmSeatKaze">${KAZE[i + 1]}</span>
            <span class="tmSeatEmpty">空席</span></button>`);
        } else {
          seats.push(`<button type="button" class="tmSeat filled" data-drop="${c.id}"
              aria-label="${esc(c.name)}を外す">
            <span class="tmSeatKaze">${KAZE[i + 1]}</span>
            <span class="mkFace sil"><img src="img/${pad3(c.id)}.webp" alt=""
              onerror="this.remove()"></span>
            <span class="tmSeatDrop" aria-hidden="true">✕</span>
            <span class="tmSeatBar"><span class="tmSeatName" data-full="${esc(c.name)}"
              >${esc(c.name)}</span>
            <span class="tmSeatStyle">${esc(STYLES[c.style].name)}</span></span></button>`);
        }
      }

      const meters = teamMeters(list);
      const metersHTML = `<div class="tmMeters">` + meters.map(([label, v]) =>
        `<div class="tmMeterRow"><span>${label}</span>
         <span class="tmTrack"><span class="tmFill" style="width:${Math.round(v * 100)}%"></span></span></div>`
      ).join('') + `</div>`;

      let verdictHTML;
      if (list.length < SEATS) {
        verdictHTML = `<div class="tmVerdict">
          <div class="tmVerdictLine">あと${SEATS - list.length}人</div>
          <div class="tmVerdictNote">三人そろうと、この編成の講評が出ます。</div>
          ${metersHTML}</div>`;
      } else {
        const v = verdict(list);
        verdictHTML = `<div class="tmVerdict">
          <div class="tmVerdictLine">${esc(v.line)}</div>
          <div class="tmVerdictNote">${esc(v.note)}</div>
          ${metersHTML}</div>`;
      }

      table.innerHTML = `<div class="tmSeats">${seats.join('')}</div>${verdictHTML}
        <button type="button" class="tmGo" ${list.length < SEATS ? 'disabled' : ''}>この三人で始める</button>`;
    }

    /* ---------- 候補 ---------- */
    function renderCandidates() {
      grid.innerHTML = FREE_AGENTS.map((c) => {
        const on = picked.includes(c.id);
        const full = picked.length >= SEATS && !on;
        return `<button type="button" class="tmCand${on ? ' picked' : ''}${full ? ' dim' : ''}"
            data-id="${c.id}" aria-pressed="${on}">
          <span class="tmCandFace"><span class="mkFace sil"><img src="img/${pad3(c.id)}.webp"
            alt="" loading="lazy" onerror="this.remove()"></span></span>
          <span class="tmCandBody">
            <span class="tmCandName">${esc(c.name)}</span>
            <span class="tmCandStyle">${esc(STYLES[c.style].name)}</span>
            <span class="tmCandCopy">「${esc(c.copy)}」</span>
            <span class="tmCandMeta">
              <span class="tmMini">${esc(c.region)}</span>
              <span class="tmMini">${esc(c.growth)}</span>
              <span class="tmMini pot">伸びしろ ${c.pot}</span>
            </span>
          </span></button>`;
      }).join('');
    }

    function refresh() { renderTable(); renderCandidates(); }

    /* ---------- 操作 ---------- */
    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.tmCand');
      if (!btn) return;
      showCandidate(Number(btn.dataset.id));
    });

    /* 席に着ける／外す。ポップアップと卓の×から呼ぶ */
    function toggle(id) {
      const at = picked.indexOf(id);
      if (at >= 0) picked.splice(at, 1);
      else if (picked.length < SEATS) picked.push(id);
      store.set({ team: picked.slice() });
      refresh();
    }

    /* 札は小さいので、押したら大きく見てから決められるようにする */
    function showCandidate(id) {
      const c = byId(id);
      if (!c) return;
      const on = picked.includes(id);
      const full = picked.length >= SEATS && !on;
      const meters = METERS.map(([label, fn]) => {
        const v = Math.max(0, Math.min(1, fn(STYLES[c.style])));
        return `<div class="tmMeterRow"><span>${label}</span>
          <span class="tmTrack"><span class="tmFill" style="width:${Math.round(v * 100)}%"></span></span></div>`;
      }).join('');

      const ov = document.createElement('div');
      ov.className = 'popup';
      ov.innerHTML = `<div class="popupBox" role="dialog" aria-modal="true" aria-label="${esc(c.name)}">
        <button type="button" class="popupClose" aria-label="閉じる">✕</button>
        <div class="popupPhoto">
          <span class="mkFace sil"><img src="img/${pad3(c.id)}.webp" alt="" onerror="this.remove()"></span>
          <span class="tmPopName">${esc(c.name)}</span>
        </div>
        <div class="popupBody tmPopBody">
          <div class="tmPopStyle">${esc(STYLES[c.style].name)}</div>
          <div class="tmPopCopy">「${esc(c.copy)}」</div>
          <div class="tmCandMeta tmPopMeta">
            <span class="tmMini">${esc(c.region)}</span>
            <span class="tmMini">${esc(c.growth)}</span>
            <span class="tmMini pot">伸びしろ ${c.pot}</span>
          </div>
          <div class="tmMeters tmPopMeters">${meters}</div>
          ${full
            ? '<p class="tmPopFull">卓は三人まで。誰かを外してから声をかけてください。</p>'
            : `<button type="button" class="tmGo" data-take="${c.id}" style="margin-top:12px">${
                on ? '卓から外す' : '卓に着いてもらう'}</button>`}
        </div>
      </div>`;

      function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
      function onKey(e) { if (e.key === 'Escape') close(); }
      ov.addEventListener('click', (e) => {
        if (e.target === ov || e.target.closest('.popupClose')) { close(); return; }
        const take = e.target.closest('[data-take]');
        if (take) { close(); toggle(Number(take.dataset.take)); }
      });
      document.addEventListener('keydown', onKey);
      document.body.append(ov);
      const btn = ov.querySelector('[data-take]') || ov.querySelector('.popupClose');
      btn.focus();
    }

    table.addEventListener('click', (e) => {
      const drop = e.target.closest('[data-drop]');
      if (drop) { toggle(Number(drop.dataset.drop)); return; }
      const go = e.target.closest('.tmGo');
      if (go && !go.disabled) confirmTeam();
    });

    /* ---------- 確認 ---------- */
    function confirmTeam() {
      const list = picked.map(byId);
      const overlay = document.createElement('div');
      overlay.className = 'mkOverlay';
      overlay.innerHTML = `<div class="mkSheet" role="dialog" aria-modal="true" aria-label="チームの確認">
        <div class="mkBody">
          <h2 class="mkSecT">この三人で始めます</h2>
          <p class="mkQuiet">${list.map((c) => esc(c.name)).join('　／　')}</p>
          <p class="mkQuiet">選ばなかった七人は名鑑に残り、資金ができてから改めて契約できます。</p>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button type="button" class="tmGo" data-yes style="margin:0">始める</button>
            <button type="button" class="tmGo" data-no
              style="margin:0;background:transparent;color:var(--ivory-2);border-color:var(--gold-dim)">選び直す</button>
          </div>
        </div></div>`;
      overlay.addEventListener('click', (e) => {
        if (e.target.closest('[data-no]') || e.target === overlay) { overlay.remove(); return; }
        if (e.target.closest('[data-yes]')) {
          overlay.remove();
          decide();
        }
      });
      document.body.append(overlay);
      overlay.querySelector('[data-yes]').focus();
    }

    function decide() {
      const st = store.get();
      const comp = Object.assign({}, st.comp);
      picked.forEach((id) => {
        const c = byId(id);
        if (comp[id] == null) comp[id] = c.comp;
      });
      const contracted = (st.contracted || []).slice();
      picked.forEach((id) => { if (!contracted.includes(id)) contracted.push(id); });
      const discovered = (st.discovered || []).slice();
      picked.forEach((id) => { if (!discovered.includes(id)) discovered.push(id); });

      store.set({ team: picked.slice(), contracted, comp, discovered, teamDecided: true });
      if (typeof store.onDecided === 'function') store.onDecided(picked.slice());
    }

    refresh();
    return { refresh, get picked() { return picked.slice(); } };
  }

  /* 名鑑と同じシルエット。単体でも動くように自前で持つ */
  function ensureSilVar() {
    if (document.documentElement.style.getPropertyValue('--sil-img')) return;
    const svg = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<g fill="#0d1f1a"><circle cx="50" cy="30" r="17"/>' +
      '<path d="M14 100 C17 66 36 54 50 54 C64 54 83 66 86 100 Z"/></g></svg>'
    );
    document.documentElement.style.setProperty('--sil-img', `url("data:image/svg+xml,${svg}")`);
  }

  return { mount, verdict, teamMeters };
})();

if (typeof module !== 'undefined') module.exports = Team;
