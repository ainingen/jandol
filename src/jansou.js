/* ============================================================
   直営雀荘 — jansou.js
   依存：characters.js / tournament.js / theme.css / jansou.css
        （実対局に出るときは match.js 一式。無ければ数値処理に落ちる）

   使い方：
     Jansou.mount(root, store)

   事務所直営の雀荘。所属雀ドル全員に働き口を作り、
   年俸（salary の日割り）の支払い先にし、人気(pop)を
   「客を呼ぶ力」として生かす。夜は自分も卓に着ける。

   state に足すもの：
     parlor  店の状態ひとまとまり（normalize() が既定値を埋める）
     favor   ゲスト来店イベントで上がる好感度（meikan.js が枠だけ
             確保していたものを、ここで初めて使う）

   経済の計算は computeDay() に集約した純関数。node から回して
   数値を決めている（根拠は docs/HANDOVER.md §4）。
   ============================================================ */

const Jansou = (() => {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const pad3 = (id) => String(id).padStart(3, '0');
  const yen = (n) => Math.round(n).toLocaleString('ja-JP') + '円';
  const signedYen = (n) => (n >= 0 ? '+' : '−') + Math.abs(Math.round(n)).toLocaleString('ja-JP') + '円';

  /* ---------- 店の数値 ----------
     触るときは docs/HANDOVER.md §4「直営店の経済」を先に読むこと。
     初日の黒字は2〜3万円、満杯の夜で15万円前後になるよう合わせてある */
  const OPEN_COST = 500000;          // 開店資金

  /* 時間帯。base は「席がどれだけ埋まるか」の素の率、
     turns はその時間帯で客が何回転するか、fee は一人あたりの場代 */
  const SLOTS = [
    { key: 0, name: '昼', hours: '12〜17時', base: 0.42, turns: 1.5, fee: 1600 },
    { key: 1, name: '夕', hours: '17〜21時', base: 0.62, turns: 1.4, fee: 2100 },
    { key: 2, name: '夜', hours: '21〜26時', base: 0.90, turns: 1.7, fee: 2600 },
  ];

  const TABLE_MAX = 8;
  const TABLE_COST = { 3: 300000, 4: 500000, 5: 800000, 6: 1200000, 7: 1800000, 8: 2500000 };

  const INTERIOR = [
    { lv: 1, name: '中古の椅子と蛍光灯', mul: 1.00, cost: 0 },
    { lv: 2, name: '落ち着いた照明',     mul: 1.12, cost: 400000 },
    { lv: 3, name: '革張りの椅子',       mul: 1.26, cost: 1000000 },
    { lv: 4, name: '金屏風の個室',       mul: 1.42, cost: 2500000 },
    { lv: 5, name: '業界人が通う名店',   mul: 1.60, cost: 6000000 },
  ];
  const AUTO = [
    { lv: 1, name: '手積み',             rot: 1.00, cost: 0 },
    { lv: 2, name: '全自動卓',           rot: 1.25, cost: 600000 },
    { lv: 3, name: '点数表示付き全自動卓', rot: 1.50, cost: 1800000 },
  ];
  const SIGN = [
    { lv: 1, name: '手書きの貼り紙', pull: 0.00, ev: 0.20, cost: 0 },
    { lv: 2, name: '通りに看板',     pull: 0.10, ev: 0.28, cost: 250000 },
    { lv: 3, name: '雑誌に広告',     pull: 0.22, ev: 0.36, cost: 900000 },
  ];

  const BASE_WAGE = 4000;                                   // 出勤一人あたりの日当の底
  const wageOf = (c) => BASE_WAGE + Math.round((c.salary || 0) / 30);  // 月給の日割りを乗せる
  const utilOf = (tables) => 8000 + tables * 1500;          // 家賃・光熱の日割り

  /* ---------- セーブの既定値 ---------- */
  function normalize(p) {
    p = p || {};
    return {
      open: !!p.open,
      day: p.day | 0,
      tables: Math.min(TABLE_MAX, Math.max(2, p.tables | 0 || 2)),
      interior: Math.min(5, Math.max(1, p.interior | 0 || 1)),
      auto: Math.min(3, Math.max(1, p.auto | 0 || 1)),
      sign: Math.min(3, Math.max(1, p.sign | 0 || 1)),
      rep: Math.min(100, Math.max(0, typeof p.rep === 'number' ? p.rep : 10)),
      shifts: p.shifts || {},          // id -> [昼,夕,夜] の真偽値
      joinNight: !!p.joinNight,        // 夜、自分も卓に着くか
      buffs: Array.isArray(p.buffs) ? p.buffs : [],
      log: Array.isArray(p.log) ? p.log : [],
      total: Object.assign({ days: 0, sales: 0, profit: 0, guests: 0 }, p.total || {}),
    };
  }

  /* ---------- 一日の売上（純関数） ----------
     cfg = { tables, interior, auto, sign, rep, slotPop:[昼,夕,夜の出勤popの合計],
             slotWorkers:[人数], pullBonus, closedTables, playerNight }
     rng は 0〜1 を返す関数（テストで固定できるように注入する） */
  function computeDay(cfg, rng) {
    rng = rng || Math.random;
    const interior = INTERIOR[cfg.interior - 1];
    const auto = AUTO[cfg.auto - 1];
    const sign = SIGN[cfg.sign - 1];
    const tables = Math.max(1, cfg.tables - (cfg.closedTables || 0));
    const repMul = 0.85 + (cfg.rep || 0) / 200;             // 評判0で0.85、100で1.35

    const slots = SLOTS.map((s) => {
      let seats = tables * 4;
      /* 夜に自分の卓を出すと、その卓は貸せない */
      if (s.key === 2 && cfg.playerNight) seats = Math.max(0, seats - 4);
      const pop = (cfg.slotPop || [0, 0, 0])[s.key] || 0;
      const popMul = 1 + Math.min(1.0, pop / 350);          // 出勤者の人気が客を呼ぶ
      const noise = 0.82 + rng() * 0.36;                    // ±18%のぶれ
      const demand = seats * s.base * interior.mul *
        (1 + sign.pull + (cfg.pullBonus || 0)) * popMul * repMul * noise;
      const capacity = seats * s.turns * auto.rot;          // 回転の上限
      const guests = Math.round(Math.min(capacity, demand * s.turns * auto.rot));
      const sales = guests * s.fee;
      return { key: s.key, name: s.name, guests, capacity: Math.round(capacity), sales,
               workers: (cfg.slotWorkers || [0, 0, 0])[s.key] || 0, full: guests >= Math.round(capacity) };
    });

    return {
      slots,
      guests: slots.reduce((a, s) => a + s.guests, 0),
      sales: slots.reduce((a, s) => a + s.sales, 0),
    };
  }

  /* ---------- イベント ---------- */
  const ARASHI_NAMES = ['流しの辰巳', '代打ちの梶', '鬼鳴きの巳代', '無敗を名乗る男'];
  const ARASHI_STAKE = 100000;

  function makeArashi(rep, rng) {
    rng = rng || Math.random;
    return {
      id: 9100, name: ARASHI_NAMES[Math.floor(rng() * ARASHI_NAMES.length)],
      rank: 'A', style: ['perfect', 'read', 'top'][Math.floor(rng() * 3)],
      comp: 55 + Math.min(35, rep * 0.35) + rng() * 10, pop: 0, salary: 0,
      guest: true,
    };
  }
  function makeRegular(n, rng) {
    rng = rng || Math.random;
    const keys = Object.keys(STYLES);
    return {
      id: 9000 + n, name: '常連の客', rank: 'D',
      style: keys[Math.floor(rng() * keys.length)],
      comp: 25 + rng() * 20, pop: 0, salary: 0, guest: true,
    };
  }

  /* 発生させるイベントを選ぶ。null なら何も無い日 */
  function pickEvent(st, parlor, dayWorkers, rng) {
    rng = rng || Math.random;
    const sign = SIGN[parlor.sign - 1];
    if (rng() > sign.ev + parlor.rep / 400) return null;

    const popSum = dayWorkers.reduce((a, c) => a + (c.pop || 0), 0);
    const contractedSet = new Set((st.contracted || []).concat(st.team || []));
    const guestPool = (st.discovered || [])
      .filter((id) => id !== 0 && !contractedSet.has(id))
      .map((id) => JANDOLS.concat(FREE_AGENTS).find((c) => c.id === id))
      .filter(Boolean);

    const cand = [];
    if (guestPool.length) cand.push({ kind: 'guest', w: 30 });
    cand.push({ kind: 'arashi', w: 16 });
    cand.push({ kind: 'shugi', w: 14 });
    cand.push({ kind: 'kosho', w: 12 });
    if (popSum >= 220) cand.push({ kind: 'shuzai', w: 12 });
    cand.push({ kind: 'oshinobi', w: 8 });

    let total = cand.reduce((a, c) => a + c.w, 0);
    let r = rng() * total;
    let kind = cand[cand.length - 1].kind;
    for (const c of cand) { r -= c.w; if (r <= 0) { kind = c.kind; break; } }

    if (kind === 'guest') {
      const g = guestPool[Math.floor(rng() * guestPool.length)];
      return { kind, chara: g };
    }
    if (kind === 'arashi') return { kind, chara: makeArashi(parlor.rep, rng) };
    return { kind };
  }

  /* ============================================================
     画面
     ============================================================ */
  function ensureSilVar() {
    if (document.documentElement.style.getPropertyValue('--sil-img')) return;
    const svg = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<g fill="#0d1f1a"><circle cx="50" cy="30" r="17"/>' +
      '<path d="M14 100 C17 66 36 54 50 54 C64 54 83 66 86 100 Z"/></g></svg>'
    );
    document.documentElement.style.setProperty('--sil-img', `url("data:image/svg+xml,${svg}")`);
  }

  function mount(root, store) {
    ensureSilVar();
    root.innerHTML = '';
    root.classList.add('jnRoot');

    const ALL = () => JANDOLS.concat(FREE_AGENTS);

    /* 働ける子＝チーム＋契約済み。現在の完成度と段位を写して返す */
    function roster() {
      const st = store.get();
      const ids = Array.from(new Set((st.team || []).concat(st.contracted || [])));
      return ids.map((id) => {
        const base = ALL().find((c) => c.id === id);
        if (!base) return null;
        return Object.assign({}, base, {
          comp: (st.comp || {})[id] != null ? st.comp[id] : base.comp,
          compMax: (st.compMax || {})[id],
          rank: (st.grades || {})[id] || base.rank,
        });
      }).filter(Boolean);
    }

    function playerCard() {
      const st = store.get();
      const strengths = (typeof Taikai !== 'undefined' && Taikai.PLAYER_STRENGTH) ||
        { D: 46, C: 54, B: 62, A: 70, S: 78 };
      return Object.assign({}, PLAYER, {
        name: st.playerName || PLAYER.name,
        face: (typeof Title !== 'undefined' && Title.normalizeFace)
          ? Title.normalizeFace(st.playerFace) : 'p01',
        isPlayer: true,
        rank: st.playerRank || 'D',
        playerStrength: strengths[st.playerRank || 'D'] || 50,
      });
    }

    function parlorOf(st) { return normalize(st.parlor); }
    function setParlor(patch) {
      const st = store.get();
      store.set({ parlor: Object.assign(parlorOf(st), patch) });
    }

    /* ---------- 開店前 ---------- */
    function renderClosed() {
      const st = store.get();
      const can = (st.money || 0) >= OPEN_COST;
      root.innerHTML = `
        <h1 class="jnTitle">直営雀荘</h1>
        <p class="jnLead">事務所の一階に、自前の雀荘を出せます。
        所属の子たち全員に働き口ができて、月給の日割りを払いながら
        場代を稼げます。人気のある子が居る店には客が集まります。
        夜はあなたも卓に着けます。</p>
        <div class="jnOpenBox">
          <div class="jnOpenCost">開店資金 <b>${yen(OPEN_COST)}</b></div>
          <div class="jnOpenNote">卓2つ・中古の椅子からのスタートです。</div>
          <button type="button" class="jnOpenBtn" id="jnOpen" ${can ? '' : 'disabled'}>
            雀荘を開く</button>
          ${can ? '' : `<div class="jnOpenLack">あと ${yen(OPEN_COST - (st.money || 0))} 必要です。</div>`}
        </div>`;
      root.querySelector('#jnOpen').addEventListener('click', () => {
        const s = store.get();
        if ((s.money || 0) < OPEN_COST) return;
        store.set({ money: s.money - OPEN_COST });
        setParlor({ open: true });
        render();
      });
    }

    /* ---------- シフトの読み書き ---------- */
    function shiftOf(parlor, id) {
      const v = parlor.shifts[id];
      return Array.isArray(v) ? v.slice(0, 3) : [false, false, true];   // 既定は夜だけ
    }

    /* ---------- 営業中の画面 ---------- */
    function render() {
      const st = store.get();
      const parlor = parlorOf(st);
      if (!parlor.open) { renderClosed(); return; }

      const list = roster();
      const interior = INTERIOR[parlor.interior - 1];
      const auto = AUTO[parlor.auto - 1];
      const sign = SIGN[parlor.sign - 1];

      /* シフト表 */
      const rows = list.map((c) => {
        const sh = shiftOf(parlor, c.id);
        const chips = SLOTS.map((s) =>
          `<button type="button" class="jnChip${sh[s.key] ? ' on' : ''}"
             data-shift="${c.id}" data-slot="${s.key}">${s.name}</button>`).join('');
        return `<div class="jnRow">
          <span class="mkFace sil"><img src="img/${pad3(c.id)}.webp" alt="" loading="lazy"
            onerror="this.remove()"></span>
          <span class="jnRowBody">
            <span class="jnRowName">${esc(c.name)}</span>
            <span class="jnRowSub">${esc(c.rank)}級　人気${c.pop}　日当 ${yen(wageOf(c))}</span>
          </span>
          <span class="jnChips">${chips}</span>
        </div>`;
      }).join('');

      /* 設備 */
      const nextTable = parlor.tables < TABLE_MAX ? TABLE_COST[parlor.tables + 1] : null;
      const nextInt = INTERIOR[parlor.interior];       // undefined なら最大
      const nextAuto = AUTO[parlor.auto];
      const nextSign = SIGN[parlor.sign];
      const facil = [
        { key: 'tables', label: `卓 ${parlor.tables}つ`,
          now: `${parlor.tables * 4}席`, next: nextTable != null ? `増設 → ${parlor.tables + 1}つ` : null,
          cost: nextTable },
        { key: 'interior', label: `内装「${interior.name}」`,
          now: `客足 ×${interior.mul.toFixed(2)}`,
          next: nextInt ? `「${nextInt.name}」 ×${nextInt.mul.toFixed(2)}` : null,
          cost: nextInt ? nextInt.cost : null },
        { key: 'auto', label: `卓の型「${auto.name}」`,
          now: `回転 ×${auto.rot.toFixed(2)}`,
          next: nextAuto ? `「${nextAuto.name}」 ×${nextAuto.rot.toFixed(2)}` : null,
          cost: nextAuto ? nextAuto.cost : null },
        { key: 'sign', label: `宣伝「${sign.name}」`,
          now: `新規客 +${Math.round(sign.pull * 100)}%`,
          next: nextSign ? `「${nextSign.name}」 +${Math.round(nextSign.pull * 100)}%` : null,
          cost: nextSign ? nextSign.cost : null },
      ].map((f) => `<div class="jnFacil">
          <span class="jnFacilBody"><span class="jnFacilName">${esc(f.label)}</span>
          <span class="jnFacilNow">${esc(f.now)}</span></span>
          ${f.next ? `<button type="button" class="jnUp" data-up="${f.key}"
              ${(st.money || 0) >= f.cost ? '' : 'disabled'}>
              ${esc(f.next)}<b>${yen(f.cost)}</b></button>`
            : `<span class="jnFacilMax">これ以上はありません</span>`}
        </div>`).join('');

      const recent = parlor.log.slice(-5).reverse().map((l) =>
        `<div class="jnLogRow"><span>${l.day}日目</span><span>${l.guests}人</span>
         <b class="${l.profit >= 0 ? 'plus' : 'minus'}">${signedYen(l.profit)}</b></div>`).join('');

      root.innerHTML = `
        <h1 class="jnTitle">直営雀荘 <span class="jnDay">${parlor.day}日目</span></h1>
        <div class="jnStats">
          <span class="jnStat">評判 <span class="jnRepTrack"><span class="jnRepFill"
            style="width:${parlor.rep}%"></span></span> <b>${Math.round(parlor.rep)}</b></span>
          <span class="jnStat">通算 <b class="${parlor.total.profit >= 0 ? 'plus' : 'minus'}">
            ${signedYen(parlor.total.profit)}</b></span>
        </div>

        <div id="jnFloorHost"></div>

        <h2 class="jnSecT">今日のシフト</h2>
        ${list.length ? `<div class="jnShift">${rows}</div>`
          : `<p class="jnEmpty">働ける子がいません。チームを組むか、スカウトで契約してください。</p>`}

        <h2 class="jnSecT">設備</h2>
        <div class="jnFacils">${facil}</div>

        <div class="jnRun">
          <label class="jnJoin"><input type="checkbox" id="jnJoin" ${parlor.joinNight ? 'checked' : ''}>
            夜、自分も卓に着く（東風戦・卓をひとつ使う）</label>
          <button type="button" class="jnRunBtn" id="jnRun" ${list.length ? '' : 'disabled'}>
            今日の営業をはじめる</button>
        </div>

        ${recent ? `<h2 class="jnSecT">最近の営業</h2><div class="jnLog">${recent}</div>` : ''}
      `;

      /* シフトの切り替え */
      root.querySelectorAll('[data-shift]').forEach((b) => {
        b.addEventListener('click', () => {
          const id = +b.dataset.shift, slot = +b.dataset.slot;
          const p = parlorOf(store.get());
          const sh = shiftOf(p, id);
          sh[slot] = !sh[slot];
          p.shifts = Object.assign({}, p.shifts, { [id]: sh });
          setParlor({ shifts: p.shifts });
          b.classList.toggle('on', sh[slot]);
        });
      });

      /* 設備投資 */
      root.querySelectorAll('[data-up]').forEach((b) => {
        b.addEventListener('click', () => {
          const s = store.get();
          const p = parlorOf(s);
          const key = b.dataset.up;
          let cost = null, patch = {};
          if (key === 'tables' && p.tables < TABLE_MAX) {
            cost = TABLE_COST[p.tables + 1]; patch = { tables: p.tables + 1 };
          } else if (key === 'interior' && INTERIOR[p.interior]) {
            cost = INTERIOR[p.interior].cost; patch = { interior: p.interior + 1 };
          } else if (key === 'auto' && AUTO[p.auto]) {
            cost = AUTO[p.auto].cost; patch = { auto: p.auto + 1 };
          } else if (key === 'sign' && SIGN[p.sign]) {
            cost = SIGN[p.sign].cost; patch = { sign: p.sign + 1 };
          }
          if (cost == null || (s.money || 0) < cost) return;
          store.set({ money: s.money - cost });
          setParlor(patch);
          render();
        });
      });

      root.querySelector('#jnJoin').addEventListener('change', (e) => {
        setParlor({ joinNight: e.target.checked });
      });
      root.querySelector('#jnRun').addEventListener('click', () => { runDay(); });

      mountFloor(root.querySelector('#jnFloorHost'), parlor, list);
    }

    /* ---------- フロア（第一段：静止画） ----------
       docs/design/jansou/spec.md §14 の第1段階。
       いまは「店内のようす」を見せるだけで、再生は第二段で入れる。
       客の並びは日ごとに決まる見た目だけのもので、収支には一切触らない */
    let floorCtl = null;

    function mountFloor(host, parlor, list) {
      if (!host || typeof JansouFloor === 'undefined' || typeof JansouGuests === 'undefined') return;
      if (floorCtl) { floorCtl.destroy(); floorCtl = null; }

      floorCtl = JansouFloor.mount(host, {
        onSpeed: (v) => { setParlor({ speed: v }); floorCtl.render(previewState(parlor, list)); },
      });
      floorCtl.render(previewState(parlor, list));
    }

    /* 見た目だけの並びを作る。日をまたぐと変わるが、同じ日なら同じ絵になる */
    function previewState(parlor, list) {
      const rng = seeded(parlor.day * 7919 + parlor.tables * 31 + parlor.interior);
      let closedTables = 0;
      parlor.buffs.forEach((b) => { if (b.kind === 'closed') closedTables += b.val; });

      const count = JansouFloor.layout(parlor.tables, 200).length;
      const usable = Math.max(0, count - closedTables);
      const myTable = parlor.joinNight && usable > 0 ? usable - 1 : -1;

      /* 夜の時間帯に出る客から、評判に応じた入りぐあいで席を埋める */
      const pool = JansouGuests.TYPES.filter((t) => t.weight > 0 && t.slots.indexOf(2) >= 0);
      const fill = 0.45 + Math.min(0.45, parlor.rep / 200);
      const guests = [];
      for (let i = 0; i < usable; i++) {
        if (i === myTable) continue;
        for (let s = 0; s < 4; s++) {
          if (rng() > fill) continue;
          guests.push({ table: i, seat: s, typeKey: weighted(pool, rng).key });
        }
      }

      /* 夜に出勤している子をフロアに立たせる */
      /* 夜に出勤している子は全員フロアに出す（席が足りなければ通路に立つ） */
      const night = list.filter((c) => shiftOf(parlor, c.id)[2]).slice(0, 6);
      const staff = night.map((c, i) => ({ id: c.id, name: c.name, at: i, nominated: i === 0 }));

      const lastLog = parlor.log[parlor.log.length - 1];
      return {
        parlor, guests, staff, closedTables, myTable,
        slotName: '夜', progress: 0,
        headNote: parlor.day + '日目・開店前（夜のようす）',
        sales: lastLog ? lastLog.sales : 0, extra: 0,
        fullSlot: false,
        ticker: night.length
          ? night[0].name + ' たちが出勤しています'
          : '夜のシフトに誰も入っていません',
      };
    }

    function weighted(arr, rng) {
      let total = arr.reduce((a, t) => a + t.weight, 0);
      let r = rng() * total;
      for (const t of arr) { r -= t.weight; if (r <= 0) return t; }
      return arr[arr.length - 1];
    }

    /* 同じ日なら同じ絵になるように、種から回す小さな乱数 */
    function seeded(seed) {
      let x = (seed | 0) || 1;
      return () => {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x |= 0;
        return ((x >>> 0) % 100000) / 100000;
      };
    }

    /* ---------- 汎用の選択ポップアップ ---------- */
    function ask(o) {
      return new Promise((resolve) => {
        const ov = document.createElement('div');
        ov.className = 'popup';
        const photo = o.photoId != null
          ? `<div class="popupPhoto"><div class="mkFace sil">
               <img src="img/${pad3(o.photoId)}.webp" alt="" onerror="this.remove()"></div></div>` : '';
        ov.innerHTML = `<div class="popupBox jnPopBox" role="dialog" aria-modal="true"
            aria-label="${esc(o.title)}">
          ${photo}
          <div class="popupBody">
            <div class="jnPopTitle">${esc(o.title)}</div>
            <p class="jnPopText">${o.html || esc(o.text || '')}</p>
            <div class="jnPopChoices">${o.choices.map((c) =>
              `<button type="button" class="jnPopBtn" data-key="${c.key}" ${c.disabled ? 'disabled' : ''}>
                 ${esc(c.label)}${c.note ? `<span>${esc(c.note)}</span>` : ''}</button>`).join('')}
            </div>
          </div>
        </div>`;
        document.body.appendChild(ov);
        ov.addEventListener('click', (e) => {
          const b = e.target.closest('[data-key]');
          if (!b) return;
          ov.remove();
          resolve(b.dataset.key);
        });
      });
    }

    /* ---------- 実対局か数値処理か ---------- */
    async function playOrSimulate(table, title) {
      if (typeof store.playRealMatch === 'function') {
        const r = await store.playRealMatch(table, { tier: { name: '直営店' }, name: title });
        if (r) return r;
      }
      return simulateTable(table, STYLES);
    }

    /* ---------- 一日の営業 ---------- */
    async function runDay() {
      const st0 = store.get();
      const parlor = parlorOf(st0);
      const list = roster();

      /* 出勤の集計 */
      const slotWorkers = [[], [], []];
      list.forEach((c) => {
        const sh = shiftOf(parlor, c.id);
        sh.forEach((on, i) => { if (on) slotWorkers[i].push(c); });
      });
      const dayWorkers = list.filter((c) => shiftOf(parlor, c.id).some(Boolean));

      /* 続く効果（取材・故障）を拾う */
      let pullBonus = 0, closedTables = 0;
      parlor.buffs.forEach((b) => {
        if (b.kind === 'pull') pullBonus += b.val;
        if (b.kind === 'closed') closedTables += b.val;
      });

      const day = computeDay({
        tables: parlor.tables, interior: parlor.interior, auto: parlor.auto, sign: parlor.sign,
        rep: parlor.rep,
        slotPop: slotWorkers.map((w) => w.reduce((a, c) => a + (c.pop || 0), 0)),
        slotWorkers: slotWorkers.map((w) => w.length),
        pullBonus, closedTables,
        playerNight: parlor.joinNight,
      });

      const wages = dayWorkers.reduce((a, c) => a + wageOf(c), 0);
      const util = utilOf(parlor.tables);
      let extraMoney = 0, repDelta = 0;
      let eventLines = [];
      const favor = Object.assign({}, st0.favor || {});

      /* ---------- イベント ---------- */
      const ev = pickEvent(st0, parlor, dayWorkers, Math.random);
      if (ev && ev.kind === 'guest') {
        const g = ev.chara;
        const canTreat = (st0.money || 0) >= 30000;
        const k = await ask({
          title: `${g.name} が客として来ました`,
          photoId: g.id,
          text: `${g.rank}級「${g.name}」がお忍びで一卓打ちに来ています。`,
          choices: [
            { key: 'treat', label: '一席用意してもてなす', note: '30,000円　好感度が大きく上がる', disabled: !canTreat },
            { key: 'normal', label: 'ふつうに接客する', note: '好感度が少し上がる' },
          ],
        });
        if (k === 'treat') {
          extraMoney -= 30000;
          favor[g.id] = Math.min(100, (favor[g.id] || 0) + 15);
          repDelta += 2;
          eventLines.push(`${g.name} をもてなした（好感度 +15）`);
        } else {
          favor[g.id] = Math.min(100, (favor[g.id] || 0) + 4);
          eventLines.push(`${g.name} が来店（好感度 +4）`);
        }
      } else if (ev && ev.kind === 'arashi') {
        const a = ev.chara;
        const best = dayWorkers.slice().sort((x, y) => strengthOf(y, STYLES) - strengthOf(x, STYLES))[0];
        const k = await ask({
          title: '雀荘荒らしが現れた',
          text: `「${a.name}」と名乗る打ち手が ${yen(ARASHI_STAKE)} を賭けろと騒いでいます。`,
          choices: [
            { key: 'me', label: '自分が受けて立つ', note: '実際に打つ' },
            { key: 'ace', label: best ? `${best.name} に任せる` : 'エースに任せる',
              note: '結果は自動処理', disabled: !best },
            { key: 'no', label: '丁重にお引き取り願う', note: '評判が少し下がる' },
          ],
        });
        if (k === 'me') {
          const mates = dayWorkers.slice(0, 2);
          const table = [playerCard(), a].concat(mates);
          while (table.length < 4) table.push(makeRegular(table.length, Math.random));
          const rank = await playOrSimulate(table, `${a.name} との腕試し`);
          const mine = rank.find((r) => r.chara.id === 0);
          const his = rank.find((r) => r.chara.id === a.id);
          if (mine && his && mine.place < his.place) {
            extraMoney += ARASHI_STAKE; repDelta += 6;
            eventLines.push(`${a.name} を返り討ちにした（${signedYen(ARASHI_STAKE)}・評判 +6）`);
          } else {
            extraMoney -= ARASHI_STAKE; repDelta -= 3;
            eventLines.push(`${a.name} に打ち負けた（${signedYen(-ARASHI_STAKE)}・評判 −3）`);
          }
        } else if (k === 'ace' && best) {
          const others = dayWorkers.filter((c) => c.id !== best.id).slice(0, 2);
          const table = [best, a].concat(others);
          while (table.length < 4) table.push(makeRegular(table.length, Math.random));
          const rank = simulateTable(table, STYLES);
          const hers = rank.find((r) => r.chara.id === best.id);
          const his = rank.find((r) => r.chara.id === a.id);
          if (hers.place < his.place) {
            extraMoney += ARASHI_STAKE; repDelta += 4;
            eventLines.push(`${best.name} が ${a.name} を退けた（${signedYen(ARASHI_STAKE)}・評判 +4）`);
          } else {
            extraMoney -= ARASHI_STAKE; repDelta -= 3;
            eventLines.push(`${best.name} が ${a.name} に敗れた（${signedYen(-ARASHI_STAKE)}・評判 −3）`);
          }
        } else {
          repDelta -= 1;
          eventLines.push(`${a.name} を追い返した（評判 −1）`);
        }
      } else if (ev && ev.kind === 'shugi') {
        const bonus = day.guests * 500;
        extraMoney += bonus;
        eventLines.push(`常連たちが祝儀をはずんだ（${signedYen(bonus)}）`);
      } else if (ev && ev.kind === 'kosho') {
        const k = await ask({
          title: '卓がひとつ壊れた',
          text: '古い卓の山が上がらなくなりました。',
          choices: [
            { key: 'fix', label: 'すぐ修理する', note: '50,000円', disabled: (st0.money || 0) < 50000 },
            { key: 'leave', label: '明日は一卓閉める', note: '評判 −2' },
          ],
        });
        if (k === 'fix') { extraMoney -= 50000; eventLines.push('壊れた卓を修理した（−50,000円）'); }
        else {
          parlor.buffs.push({ kind: 'closed', val: 1, days: 1 });
          repDelta -= 2;
          eventLines.push('明日は一卓閉めることにした（評判 −2）');
        }
      } else if (ev && ev.kind === 'shuzai') {
        repDelta += 8;
        parlor.buffs.push({ kind: 'pull', val: 0.15, days: 3 });
        eventLines.push('雑誌の取材が入った（評判 +8・三日間 客足が伸びる）');
      } else if (ev && ev.kind === 'oshinobi') {
        const bonus = Math.round(day.slots[2].sales * 0.2);
        extraMoney += bonus; repDelta += 4;
        eventLines.push(`有名人がお忍びで来店（${signedYen(bonus)}・評判 +4）`);
      }

      /* ---------- 夜、自分も卓に着く ---------- */
      let myLine = null;
      if (parlor.joinNight) {
        const night = slotWorkers[2].slice().sort((a, b) => (b.pop || 0) - (a.pop || 0));
        const mates = night.slice(0, 3);
        const table = [playerCard()].concat(mates);
        while (table.length < 4) table.push(makeRegular(table.length, Math.random));
        const rank = await playOrSimulate(table, '店の卓で一局');
        const mine = rank.find((r) => r.chara.id === 0);
        if (mine && mine.place === 1) {
          extraMoney += 20000; repDelta += 2;
          myLine = 'あなたのトップに祝儀が飛んだ（+20,000円・評判 +2）';
        } else if (mine) {
          myLine = `店の卓で${mine.place}着だった`;
        }
        /* 同卓した子には実戦のぶんも経験が入る */
        rank.forEach((r) => { if (!r.chara.guest && r.chara.id !== 0) r.chara._extraPlace = r.place; });
      }

      /* ---------- 成長 ----------
         compMax は必ず保存する（引き継ぎ書 §5 の罠）。 */
      const st1 = store.get();
      const comp = Object.assign({}, st1.comp);
      const compMax = Object.assign({}, st1.compMax || {});
      const grades = Object.assign({}, st1.grades || {});
      const growth = [];
      const placeRoll = () => {
        const r = Math.random();
        return r < 0.08 ? 1 : r < 0.30 ? 2 : r < 0.65 ? 3 : 4;
      };
      dayWorkers.forEach((c) => {
        const slots = shiftOf(parlor, c.id).filter(Boolean).length;
        const target = Object.assign({}, c, {
          comp: comp[c.id] != null ? comp[c.id] : c.comp,
          compMax: compMax[c.id],
          rank: grades[c.id] || c.rank,
        });
        const before = target.comp;
        let promoted = null;
        for (let i = 0; i < slots; i++) {
          const res = addExp(target, placeRoll(), 'practice');
          if (res.promoted) promoted = res.promoted;
        }
        if (c._extraPlace) {
          const res = addExp(target, c._extraPlace, 'practice');
          if (res.promoted) promoted = res.promoted;
        }
        comp[c.id] = target.comp;
        compMax[c.id] = target.compMax;
        grades[c.id] = target.rank;
        if (target.comp - before >= 0.05 || promoted) {
          growth.push({ name: c.name, gain: target.comp - before, promoted });
        }
      });

      /* ---------- 締め ---------- */
      const profit = day.sales + extraMoney - wages - util;
      let rep = parlor.rep + repDelta;
      if (profit > 0) rep += 1;
      if (day.slots.some((s) => s.full)) rep += 1;
      rep = Math.min(100, Math.max(0, rep));

      const buffs = parlor.buffs
        .map((b) => Object.assign({}, b, { days: b.days - 1 }))
        .filter((b) => b.days > 0);

      const log = parlor.log.concat({
        day: parlor.day + 1, guests: day.guests, sales: day.sales, profit,
      }).slice(-7);

      const stNow = store.get();
      store.set({
        money: (stNow.money || 0) + profit,
        comp, compMax, grades, favor,
        parlor: Object.assign(parlorOf(stNow), {
          day: parlor.day + 1, rep, buffs, log,
          total: {
            days: parlor.total.days + 1,
            sales: parlor.total.sales + day.sales,
            profit: parlor.total.profit + profit,
            guests: parlor.total.guests + day.guests,
          },
        }),
      });

      /* ---------- 結果 ---------- */
      const slotRows = day.slots.map((s) =>
        `<div class="jnRepRow"><span>${s.name}<i>${SLOTS[s.key].hours}</i></span>
         <span>${s.guests}人${s.full ? '<em>満卓</em>' : ''}</span>
         <b>${yen(s.sales)}</b></div>`).join('');
      const growthHTML = growth.length
        ? `<div class="jnRepGrowth">${growth.map((g) =>
            `<span>${esc(g.name)} +${g.gain.toFixed(1)}${g.promoted ? `　<em>${g.promoted}級に昇格</em>` : ''}</span>`
          ).join('')}</div>` : '';
      const evHTML = eventLines.concat(myLine ? [myLine] : []).map((l) =>
        `<div class="jnRepEv">${esc(l)}</div>`).join('');

      await ask({
        title: `${parlor.day + 1}日目の営業`,
        html: `<span class="jnRepWrap">${slotRows}
          <span class="jnRepRow line"><span>日当（${dayWorkers.length}人）</span><span></span>
            <b>−${yen(wages)}</b></span>
          <span class="jnRepRow"><span>家賃・光熱</span><span></span><b>−${yen(util)}</b></span>
          ${evHTML}
          <span class="jnRepRow total"><span>今日の収支</span><span></span>
            <b class="${profit >= 0 ? 'plus' : 'minus'}">${signedYen(profit)}</b></span>
          ${growthHTML}</span>`,
        choices: [{ key: 'ok', label: '閉店する' }],
      });
      render();
    }

    render();
  }

  return { mount, computeDay, normalize, pickEvent, wageOf, utilOf,
           OPEN_COST, SLOTS, TABLE_COST, INTERIOR, AUTO, SIGN };
})();

if (typeof module !== 'undefined') {
  module.exports = { Jansou };
}
