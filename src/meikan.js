/* ============================================================
   雀ドル名鑑 — meikan.js
   依存：characters.js（JANDOLS / FREE_AGENTS / STYLES / REGIONS /
        CONTRACTS / RANK_INFO）と meikan.css

   使い方：
     Meikan.mount(rootElement, store)
     store は { get() → state, set(patch) } を持つオブジェクト。
     state はすべて id で持つ（引き継ぎ書 §5 のセーブ方針）：
       discovered : number[]  発見済みの雀ドルid
       contracted : number[]  契約済みの雀ドルid
       comp       : { [id]: 0-100 }  完成度（契約済みのみ意味を持つ）
       favor      : { [id]: 0-100 }  好感度（未使用。枠だけ確保）

   画像は img/<3桁>.webp。読めない場合はシルエットに自動で落ちる。
   ============================================================ */

const Meikan = (() => {
  'use strict';

  const ALL = () => JANDOLS.concat(FREE_AGENTS);

  /* プレイヤー本人。雀ドルと番号がぶつからないよう id 0、画像は img/p01.webp など */
  function playerEntry(st) {
    return {
      id: 0,
      name: st.playerName || 'あなた',
      face: Title.normalizeFace(st.playerFace),
      rank: st.playerRank || 'D',
      region: '—',
      isPlayer: true,
    };
  }
  const pad3 = (id) => String(id).padStart(3, '0');
  /* プレイヤーは番号ではなく face キーで画像を引く */
  const imgSrc = (c) => (c && c.isPlayer) ? `img/${c.face}.webp` : `img/${pad3(c.id != null ? c.id : c)}.webp`;

  /* 段位。tournament.js の閾値と同じ（D:0-19 C:20-39 B:40-64 A:65-84 S:85-100） */
  function gradeOfComp(comp) {
    if (comp >= 85) return 'S';
    if (comp >= 65) return 'A';
    if (comp >= 40) return 'B';
    if (comp >= 20) return 'C';
    return 'D';
  }

  /* 打ち筋バーの表示項目 */
  const BAR_KEYS = [
    ['push', '押し'], ['defense', '守備'],
    ['speed', '速度'], ['value', '打点'],
    ['call', '鳴き'], ['riichi', '立直'],
    ['endgame', '終盤'], ['variance', 'ムラ'],
  ];

  /* シルエット（胸像）。CSS変数として1回だけ注入する */
  const SIL_SVG = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<g fill="#0d1f1a">' +
    '<circle cx="50" cy="30" r="17"/>' +
    '<path d="M14 100 C17 66 36 54 50 54 C64 54 83 66 86 100 Z"/>' +
    '</g></svg>'
  );
  function injectSilVar() {
    document.documentElement.style.setProperty('--sil-img', `url("data:image/svg+xml,${SIL_SVG}")`);
  }

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  const yen = (n) => n > 0 ? `${n.toLocaleString('ja-JP')}円` : 'なし';

  /* tournament.js が読まれていない単体ページでも落ちないようにする */
  function tierName(key) {
    return (typeof TOURNAMENTS !== 'undefined' && TOURNAMENTS[key]) ? TOURNAMENTS[key].name : key;
  }

  /* ------------------------------------------------------------
     マウント
  ------------------------------------------------------------ */
  function mount(root, store) {
    injectSilVar();

    const view = { show: 'all', rank: 'all', region: 'all' };
    let openId = null;

    root.innerHTML = '';
    root.classList.add('mkRoot');

    const head = document.createElement('div');
    const filters = document.createElement('div');
    const grid = document.createElement('div');
    head.className = 'mkHead';
    filters.className = 'mkFilters';
    grid.className = 'mkGrid';
    root.append(head, filters, grid);

    /* ---------- 見出し ---------- */
    function renderHead() {
      const st = store.get();
      const total = ALL().length;
      head.innerHTML =
        `<h1 class="mkTitle">雀ドル名鑑<small>全国${total}名</small></h1>` +
        `<div class="mkCounts">` +
        `<span class="mkCount">発見 <b>${st.discovered.length}</b>／${total}</span>` +
        `<span class="mkCount">契約 <b>${st.contracted.length}</b></span>` +
        `</div>`;
    }

    /* ---------- 絞り込み ---------- */
    function chip(label, pressed, onTap) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mkChip';
      b.textContent = label;
      b.setAttribute('aria-pressed', pressed);
      b.addEventListener('click', onTap);
      return b;
    }
    function renderFilters() {
      filters.innerHTML = '';
      [['all', 'すべて'], ['found', '発見済み'], ['signed', '契約済み']].forEach(([k, label]) => {
        filters.append(chip(label, view.show === k, () => { view.show = k; refresh(); }));
      });
      const sep = document.createElement('span');
      sep.className = 'mkSep';
      filters.append(sep);

      ['all', 'S', 'A', 'B', 'C', 'D'].forEach((r) => {
        filters.append(chip(r === 'all' ? '全級' : r + '級', view.rank === r,
          () => { view.rank = r; refresh(); }));
      });

      const sel = document.createElement('select');
      sel.className = 'mkSelect';
      sel.setAttribute('aria-label', '地域で絞り込む');
      sel.innerHTML = '<option value="all">全地域</option>' +
        REGIONS.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
      sel.value = view.region;
      sel.addEventListener('change', () => { view.region = sel.value; refresh(); });
      filters.append(sel);
    }

    /* ---------- 一覧 ---------- */
    function faceHTML(c, discovered) {
      if (!discovered) return `<div class="mkFace sil"></div>`;
      /* 画像が読めなければ img を消してシルエットが残る */
      return `<div class="mkFace sil"><img src="${imgSrc(c)}" alt="" loading="lazy"
        onerror="this.remove()"></div>`;
    }

    function cardHTML(c, st) {
      const discovered = c.isPlayer || st.discovered.includes(c.id);
      const signed = !c.isPlayer && st.contracted.includes(c.id);
      const cls = ['mkCard'];
      if (!discovered) cls.push('unknown');
      if (signed) cls.push('signed');

      let inner = faceHTML(c, discovered) +
        `<span class="mkNo">${c.isPlayer ? '自分' : 'No.' + pad3(c.id)}</span>`;
      if (discovered) {
        inner +=
          `<span class="mkRank rk-${c.rank}">${c.rank}</span>` +
          `<span class="mkBar"><span class="mkName">${esc(c.name)}</span>` +
          `<span class="mkStyle">${c.isPlayer ? '事務所の主' : esc(STYLES[c.style].name)}</span></span>`;
        if (signed) inner += `<span class="mkSeal">契<br>約</span>`;
      } else {
        inner += `<span class="mkQ">？</span>`;
      }
      const label = discovered ? `${c.name}の詳細` : `未発見 No.${pad3(c.id)}`;
      return `<button type="button" class="${cls.join(' ')}" data-id="${c.id}" aria-label="${esc(label)}">${inner}</button>`;
    }

    function filtered(st) {
      const me = playerEntry(st);
      const showMe = (view.show !== 'signed')
        && (view.rank === 'all' || view.rank === me.rank)
        && (view.region === 'all');
      const rest = ALL().filter((c) => {
        const d = st.discovered.includes(c.id);
        const s = st.contracted.includes(c.id);
        if (view.show === 'found' && !d) return false;
        if (view.show === 'signed' && !s) return false;
        if (view.rank !== 'all' && (!d || c.rank !== view.rank)) return false;
        if (view.region !== 'all' && (!d || c.region !== view.region)) return false;
        return true;
      });
      return showMe ? [me].concat(rest) : rest;
    }

    function renderGrid() {
      const st = store.get();
      const list = filtered(st);
      grid.innerHTML = list.length
        ? list.map((c) => cardHTML(c, st)).join('')
        : `<div class="mkEmpty">この条件に当てはまる雀ドルはまだいません</div>`;
    }

    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.mkCard');
      if (btn) openDetail(Number(btn.dataset.id));
    });

    /* ---------- 詳細 ---------- */
    function barsHTML(styleKey) {
      const s = STYLES[styleKey];
      return `<div class="mkBars">` + BAR_KEYS.map(([k, label]) =>
        `<div class="mkBarRow"><span>${label}</span>` +
        `<span class="mkTrack"><span class="mkFill" style="width:${Math.round(s[k] * 100)}%"></span></span></div>`
      ).join('') + `</div>`;
    }

    function detailHTML(c, st) {
      const discovered = c.isPlayer || st.discovered.includes(c.id);
      const signed = !c.isPlayer && st.contracted.includes(c.id);

      /* プレイヤーは打ち筋の係数を持たない（人間なので実際の打牌で決まる） */
      if (c.isPlayer) {
        const wins = st.playerWins || 0;
        const recs = Object.entries(st.records || {});
        return `<div class="mkPortrait"><div class="mkFace sil">
            <img src="${imgSrc(c)}" alt="${esc(c.name)}" onerror="this.remove()"></div></div>
          <div class="mkBody">
            <div class="mkNameRow"><span class="mkBigNo">事務所の主</span>
              <span class="mkBigName">${esc(c.name)}</span></div>
            <p class="mkCopy">――「ここから八人を揃える」</p>
            <div class="mkTags"><span class="mkTag rank">${esc(c.rank)}級</span>
              <span class="mkTag">所属 ${(st.contracted || []).length}人</span></div>
            <h2 class="mkSecT">成績</h2>
            <dl>
              <div class="mkRow"><dt>段位</dt><dd>${esc(c.rank)}級</dd></div>
              <div class="mkRow"><dt>次の段位まで</dt><dd>あと${Math.max(0, ({D:2,C:3,B:4,A:6}[c.rank] || 0) - wins)}回優勝</dd></div>
            </dl>
            ${recs.length ? '<h2 class="mkSecT">大会</h2>' + recs.map(([k, r]) =>
              `<div class="mkRow"><dt>${esc(tierName(k))}</dt>
               <dd>${r.entries}回出場　最高 ${esc(r.best)}</dd></div>`).join('')
              : '<p class="mkQuiet">まだ大会に出ていません。</p>'}
            <p class="mkQuiet">あなたの打ち筋は決まっていません。実際に打った牌がそのまま結果になります。</p>
          </div>`;
      }

      if (!discovered) {
        return `<div class="mkPortrait"><div class="mkFace sil" style="filter:brightness(.55) saturate(.6)"></div>
          <span class="mkQ">？</span></div>
          <div class="mkBody">
            <div class="mkNameRow"><span class="mkBigNo">No.${pad3(c.id)}</span>
            <span class="mkBigName">？？？</span></div>
            <p class="mkQuiet">まだ出会っていない雀ドル。<br>【${esc(c.region)}】の雀荘で噂されている。</p>
          </div>`;
      }

      const info = RANK_INFO[c.rank];
      const comp = st.comp[c.id];
      const compRow = signed && comp != null
        ? `<h2 class="mkSecT">育成</h2>
           <div class="mkComp"><span class="mkGrade">${gradeOfComp(comp)}段位</span>
           <span class="mkTrack"><span class="mkFill" style="width:${comp}%"></span></span>
           <span>完成度 ${comp}</span></div>
           <p class="mkQuiet">伸びしろ ${c.pot} ｜ 上限 ${Math.min(100, comp + c.pot)}</p>`
        : '';

      return `<div class="mkPortrait"><div class="mkFace sil">
          <img src="${imgSrc(c)}" alt="${esc(c.name)}" onerror="this.remove()"></div>
          ${signed ? '<span class="mkSealBig">契約</span>' : ''}</div>
        <div class="mkBody">
          <div class="mkNameRow">
            <span class="mkBigNo">No.${pad3(c.id)}</span>
            <span class="mkBigName">${esc(c.name)}</span>
            <span class="mkKana">${esc(c.kana)}</span>
          </div>
          <p class="mkCopy">――「${esc(c.copy)}」</p>
          <div class="mkTags">
            <span class="mkTag rank">${info.name}・${info.label}</span>
            <span class="mkTag">${esc(c.region)}</span>
            <span class="mkTag">${c.age}歳</span>
            <span class="mkTag">${esc(c.sell)}</span>
          </div>

          <h2 class="mkSecT">打ち筋 ─ ${esc(STYLES[c.style].name)}</h2>
          ${barsHTML(c.style)}

          <h2 class="mkSecT">人物</h2>
          <dl>
            <div class="mkRow"><dt>性格</dt><dd>${esc(c.chara)}</dd></div>
            <div class="mkRow"><dt>成長タイプ</dt><dd>${esc(c.growth)}</dd></div>
            <div class="mkRow"><dt>人気</dt><dd>${c.pop}</dd></div>
          </dl>

          ${compRow}

          <h2 class="mkSecT">契約</h2>
          <dl>
            <div class="mkRow"><dt>条件</dt><dd>${esc(CONTRACTS[c.contract])}</dd></div>
            <div class="mkRow"><dt>契約金の目安</dt><dd>${yen(info.scoutCost)}</dd></div>
            <div class="mkRow"><dt>年俸</dt><dd>${yen(c.salary)}</dd></div>
          </dl>
          <div class="mkExtra" data-extra="${c.id}"></div>
        </div>`;
    }

    function openDetail(id) {
      const st0 = store.get();
      const c = id === 0 ? playerEntry(st0) : ALL().find((x) => x.id === id);
      if (!c) return;
      openId = id;

      const overlay = document.createElement('div');
      overlay.className = 'mkOverlay';
      const st = store.get();
      const signed = id !== 0 && st.contracted.includes(id);
      overlay.innerHTML =
        `<div class="mkSheet${signed ? ' signed' : ''}" role="dialog" aria-modal="true" aria-label="${esc(c.name || '未発見')}">
          <button type="button" class="mkClose" aria-label="閉じる">✕</button>
          ${detailHTML(c, st)}
        </div>`;

      function close() {
        overlay.remove();
        openId = null;
        document.removeEventListener('keydown', onKey);
      }
      function onKey(e) { if (e.key === 'Escape') close(); }

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('.mkClose')) close();
      });
      document.addEventListener('keydown', onKey);
      document.body.append(overlay);
      overlay.querySelector('.mkClose').focus();

      /* 呼び出し側が詳細にボタン等を差し込める（デバッグや契約処理用） */
      if (typeof store.onDetailOpen === 'function') {
        store.onDetailOpen(c, overlay.querySelector(`[data-extra="${id}"]`), refresh);
      }
    }

    /* ---------- 再描画 ---------- */
    function refresh() {
      renderHead();
      renderFilters();
      renderGrid();
    }
    refresh();

    return {
      refresh,
      get openId() { return openId; },
    };
  }

  return { mount, gradeOfComp, pad3, imgSrc };
})();

if (typeof module !== 'undefined') module.exports = Meikan;
