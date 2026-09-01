/* ============================================================
   スカウト — scout.js
   依存：characters.js / tournament.js / meikan.css / scout.css

   使い方：
     Scout.mount(root, store)

   やること二つ：
     探す   … 地域を選んで足を運び、未発見の雀ドルを見つける
     口説く … 発見済みの雀ドルの契約条件を判定して、満たしていれば契約する

   契約条件（characters.js の CONTRACTS）の判定はすべて
   evaluate() に集約してある。純粋関数なのでテストできる。

   state に足すもの：
     agency   事務所ランク 1〜5（定員と、契約できる相手が広がる）
     beaten   同じ卓で自分より下だった相手のid（taikai.js が記録する）
     scouted  この画面で使った探索回数（地域ごと）
   ============================================================ */

const Scout = (() => {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const pad3 = (id) => String(id).padStart(3, '0');
  const yen = (n) => n.toLocaleString('ja-JP') + '円';
  const RANK_ORDER = ['D', 'C', 'B', 'A', 'S'];

  /* ---------- 事務所 ---------- */
  /* 賞金の使い道であり、上位の雀ドルに手が届くようになる段階でもある */
  const AGENCY = [
    { lv: 1, name: '雑居ビルの一室', capacity: 4,  cost: 0 },
    { lv: 2, name: '駅前の小さな事務所', capacity: 6,  cost: 3000000 },
    { lv: 3, name: '看板を出せる事務所', capacity: 8,  cost: 9000000 },
    { lv: 4, name: '一棟借りの事務所',   capacity: 11, cost: 25000000 },
    { lv: 5, name: '業界に名の通った事務所', capacity: 14, cost: 60000000 },
  ];
  const agencyOf = (lv) => AGENCY[Math.max(0, Math.min(AGENCY.length - 1, (lv || 1) - 1))];

  /* ---------- 探索 ---------- */
  const SCOUT_COST = 30000;         // 一度足を運ぶ費用

  /* ---------- 契約条件の判定 ----------
     返り値 { ok, label, detail }
     ok=false のときは detail に「あと何が足りないか」を入れる     */
  function evaluate(chara, st, roster) {
    const info = RANK_INFO[chara.rank];
    const agency = st.agency || 1;
    const money = st.money || 0;

    /* 共通の前提：事務所ランクと定員 */
    if (agency < info.minAgency) {
      return { ok: false, label: '事務所が小さい',
        detail: `${chara.rank}級と契約するには事務所ランク${info.minAgency}が必要です。`, cost: null };
    }
    if (roster.length >= agencyOf(agency).capacity) {
      return { ok: false, label: '定員いっぱい',
        detail: `いまの事務所は${agencyOf(agency).capacity}人までです。`, cost: null };
    }

    const cost = costOf(chara);
    const rule = RULES[chara.contract];
    const res = rule ? rule(chara, st, roster) : { ok: true, detail: '' };
    if (!res.ok) return { ok: false, label: CONTRACTS[chara.contract], detail: res.detail, cost };
    if (money < cost) {
      return { ok: false, label: '資金が足りない',
        detail: `あと ${yen(cost - money)} 必要です。`, cost };
    }
    return { ok: true, label: res.detail || CONTRACTS[chara.contract], detail: '', cost };
  }

  /* 契約金。free は「条件なし」であって「ただ」ではない。
     0円にすると cheap（半額）より安くなって逆転する */
  function costOf(chara) {
    const base = RANK_INFO[chara.rank].scoutCost;
    if (chara.contract === 'cheap') return Math.round(base * 0.5);
    if (chara.contract === 'money') return base * 2;
    return base;
  }

  /* 条件ごとの判定。数値は後から触りやすいよう一か所にまとめてある */
  const POP_NEEDED = { S: 480, A: 320, B: 190, C: 90, D: 40 };
  const RESULT_NEEDED = { S: 'eight', A: 'title', B: 'open', C: 'local', D: 'rookie' };

  const RULES = {
    free:  () => ({ ok: true, detail: '相場どおりで契約できます' }),
    cheap: () => ({ ok: true, detail: '低額で契約できます' }),
    money: () => ({ ok: true, detail: '相場の倍を要求されています' }),

    rank: (c, st) => {
      const need = RANK_INFO[c.rank].minAgency;
      return (st.agency || 1) >= need
        ? { ok: true, detail: `事務所ランク${need}を満たしています` }
        : { ok: false, detail: `事務所ランク${need}が必要です。` };
    },

    result: (c, st) => {
      const tierId = RESULT_NEEDED[c.rank];
      const rec = (st.records || {})[tierId];
      const won = rec && rec.best === '優勝';
      return won
        ? { ok: true, detail: `${TOURNAMENTS[tierId].name}の優勝を認めています` }
        : { ok: false, detail: `${TOURNAMENTS[tierId].name}で優勝すると話を聞いてもらえます。` };
    },

    pop: (c, st, roster) => {
      const need = POP_NEEDED[c.rank];
      const have = roster.reduce((a, x) => a + (x.pop || 0), 0);
      return have >= need
        ? { ok: true, detail: `事務所の人気${have}が届いています` }
        : { ok: false, detail: `事務所の人気が${need}必要です（いま${have}）。` };
    },

    aisho: (c, st, roster) => {
      const same = roster.find((x) => x.region === c.region);
      return same
        ? { ok: true, detail: `同郷の${same.name}が話をつけてくれました` }
        : { ok: false, detail: `${c.region}の雀ドルが事務所にいると話が早くなります。` };
    },

    rival: (c, st) => {
      const beaten = st.beaten || [];
      return beaten.includes(c.id)
        ? { ok: true, detail: '直接倒した相手です' }
        : { ok: false, detail: '大会で同じ卓に着き、自分より下の着順に沈めてください。' };
    },

    area: (c, st, roster) => {
      const covered = new Set(roster.map((x) => x.region));
      const missing = REGIONS.filter((r) => !covered.has(r));
      return missing.length === 0
        ? { ok: true, detail: '全六地域に雀ドルを抱えています' }
        : { ok: false, detail: `未着手の地域があと${missing.length}（${missing[0]}ほか）。` };
    },

    /* イベントはまだ作っていない。条件が来ていないことをそのまま出す */
    event: () => ({ ok: false, detail: 'この雀ドルには専用の話があります。まだ用意できていません。' }),
  };

  /* ---------- 探索の抽選 ---------- */
  /* 事務所が小さいうちは上位が見つかりにくい */
  function discoverWeights(rank, agency) {
    const gap = RANK_INFO[rank].minAgency - agency;
    if (gap >= 3) return 0.05;
    if (gap === 2) return 0.3;
    if (gap === 1) return 0.8;
    return 1.6;
  }

  function findCandidates(region, st) {
    const found = new Set(st.discovered || []);
    return JANDOLS.filter((c) => !found.has(c.id) && (!region || c.region === region));
  }

  function drawOne(region, st) {
    const pool = findCandidates(region, st);
    if (!pool.length) return null;
    const weighted = pool.map((c) => ({ c, w: discoverWeights(c.rank, st.agency || 1) }));
    const total = weighted.reduce((a, x) => a + x.w, 0);
    let r = Math.random() * total;
    for (const x of weighted) { r -= x.w; if (r <= 0) return x.c; }
    return weighted[weighted.length - 1].c;
  }

  /* ------------------------------------------------------------
     画面
  ------------------------------------------------------------ */
  function mount(root, store) {
    ensureSilVar();
    root.innerHTML = '';
    root.classList.add('scRoot');

    let region = 'all';
    let flash = null;          // 直前の探索結果

    const ALL = () => JANDOLS.concat(FREE_AGENTS);
    function roster() {
      const st = store.get();
      return (st.contracted || []).map((id) => ALL().find((c) => c.id === id)).filter(Boolean);
    }

    function render() {
      const st = store.get();
      const ag = agencyOf(st.agency || 1);
      const list = roster();
      const next = AGENCY[(st.agency || 1)];      // 次の段階（なければ undefined）

      const found = (st.discovered || [])
        .map((id) => ALL().find((c) => c.id === id))
        .filter((c) => c && !(st.contracted || []).includes(c.id))
        .filter((c) => region === 'all' || c.region === region)
        .sort((a, b) => RANK_ORDER.indexOf(b.rank) - RANK_ORDER.indexOf(a.rank) || a.id - b.id);

      const cards = found.map((c) => {
        const v = evaluate(c, st, list);
        return `<div class="scCard${v.ok ? ' ready' : ''}">
          <div class="scFace"><span class="mkFace sil"><img src="img/${pad3(c.id)}.webp"
            alt="" loading="lazy" onerror="this.remove()"></span>
            <span class="mkRank rk-${c.rank}">${c.rank}</span></div>
          <div class="scBody">
            <div class="scName">${esc(c.name)}<span class="scRegion">${esc(c.region)}</span></div>
            <div class="scStyle">${esc(STYLES[c.style].name)}　伸びしろ ${c.pot}</div>
            <div class="scCopy">「${esc(c.copy)}」</div>
            <div class="scCond${v.ok ? ' ok' : ''}">${esc(v.label)}</div>
            ${v.detail ? `<div class="scDetail">${esc(v.detail)}</div>` : ''}
            <div class="scFoot">
              <span class="scCost">${v.cost === null ? '—' : (v.cost ? '契約金 ' + yen(v.cost) : '契約金なし')}</span>
              <span class="scSalary">年俸 ${c.salary ? yen(c.salary) : 'なし'}</span>
              <button type="button" class="scSign" data-sign="${c.id}" ${v.ok ? '' : 'disabled'}>契約する</button>
            </div>
          </div>
        </div>`;
      }).join('');

      root.innerHTML = `
        <div class="scHead">
          <h1 class="scTitle">スカウト</h1>
          <div class="scStatus">
            <span class="scStat money">所持金 <b>${yen(st.money || 0)}</b></span>
            <span class="scStat">所属 <b>${list.length}</b>／${ag.capacity}</span>
          </div>
        </div>

        <section class="scAgency">
          <div class="scAgencyName">事務所ランク${ag.lv}　${esc(ag.name)}</div>
          <div class="scAgencyNote">定員${ag.capacity}人。${next ? 'ランクが上がると上位の雀ドルと契約できます。' : 'ここが上限です。'}</div>
          ${next ? `<button type="button" class="scUpgrade" data-upgrade="1"
              ${(st.money || 0) >= next.cost ? '' : 'disabled'}>
              ${esc(next.name)}へ　${yen(next.cost)}</button>` : ''}
        </section>

        <h2 class="scSecT">探す</h2>
        <div class="scRegions">
          ${['all'].concat(REGIONS).map((r) => `<button type="button" class="scChip"
            data-region="${esc(r)}" aria-pressed="${region === r}">${r === 'all' ? '全国' : esc(r)}</button>`).join('')}
        </div>
        <button type="button" class="scGo" data-scout="1"
          ${(st.money || 0) >= SCOUT_COST ? '' : 'disabled'}>
          ${region === 'all' ? '全国' : esc(region)}の雀荘をまわる　${yen(SCOUT_COST)}</button>
        ${flash ? `<div class="scFlash${flash.found ? '' : ' miss'}">${esc(flash.text)}</div>` : ''}

        <h2 class="scSecT">口説く<span>${found.length}人</span></h2>
        ${cards || '<p class="scQuiet">この地域に、まだ声をかけられる雀ドルはいません。雀荘をまわって探してください。</p>'}`;
    }

    root.addEventListener('click', (e) => {
      const st = store.get();

      const chip = e.target.closest('[data-region]');
      if (chip) { region = chip.dataset.region; flash = null; render(); return; }

      const up = e.target.closest('[data-upgrade]');
      if (up && !up.disabled) {
        const next = AGENCY[(st.agency || 1)];
        if (next && (st.money || 0) >= next.cost) {
          store.set({ money: st.money - next.cost, agency: next.lv });
          flash = { found: true, text: `${next.name}に移りました。定員が${next.capacity}人になります。` };
          render();
        }
        return;
      }

      const go = e.target.closest('[data-scout]');
      /* 演出が出ているあいだは次の探索を受け付けない（重なって出てしまう） */
      if (go && !go.disabled && !document.querySelector('.scReveal')) {
        const hit = drawOne(region === 'all' ? null : region, st);
        const money = (st.money || 0) - SCOUT_COST;
        if (hit) {
          store.set({ money, discovered: (st.discovered || []).concat(hit.id) });
          flash = null;
          render();
          showReveal(hit);
        } else {
          store.set({ money });
          flash = { found: false, text: 'めぼしい雀ドルはいませんでした。' };
          render();
        }
        return;
      }

      const sign = e.target.closest('[data-sign]');
      if (sign && !sign.disabled) {
        const c = ALL().find((x) => x.id === Number(sign.dataset.sign));
        const v = evaluate(c, st, roster());
        if (!v.ok) { render(); return; }
        const comp = Object.assign({}, st.comp);
        if (comp[c.id] == null) comp[c.id] = compFromRank(c.rank);
        store.set({
          money: (st.money || 0) - v.cost,
          contracted: (st.contracted || []).concat(c.id),
          comp,
        });
        flash = { found: true, text: `${c.name}と契約しました。` };
        render();
        if (typeof store.onSigned === 'function') store.onSigned(c);
      }
    });

    /* ---------- 発掘の演出 ---------- */
    function showReveal(c) {
      const ov = document.createElement('div');
      ov.className = 'scReveal';
      ov.innerHTML = `<div class="scRevealBox" role="dialog" aria-modal="true"
          aria-label="${esc(c.name)}を見つけました">
        <span class="scRevealShine"></span>
        <div class="scRevealPhoto">
          <span class="mkFace sil"><img src="img/${pad3(c.id)}.webp" alt=""
            onerror="this.remove()"></span>
          <span class="scRevealRank mkRank rk-${c.rank}">${c.rank}</span>
          <span class="scRevealCap">見つけた</span>
          <span class="scRevealName">${esc(c.name)}</span>
        </div>
        <div class="scRevealBody">
          <div class="scRevealMeta">${esc(c.region)}　${esc(STYLES[c.style].name)}　伸びしろ ${c.pot}</div>
          <div class="scRevealCopy">「${esc(c.copy)}」</div>
          <button type="button" class="scRevealClose">名鑑に加える</button>
        </div>
      </div>`;
      function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
      function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') close(); }
      ov.addEventListener('click', () => close());
      document.addEventListener('keydown', onKey);
      document.body.append(ov);
      ov.querySelector('.scRevealClose').focus();
    }

    render();
    return { refresh: render };
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

  return { mount, evaluate, costOf, drawOne, AGENCY, agencyOf, SCOUT_COST, RULES };
})();

if (typeof module !== 'undefined') module.exports = Scout;
