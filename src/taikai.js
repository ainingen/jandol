/* ============================================================
   大会 — taikai.js
   依存：characters.js / tournament.js / meikan.css / taikai.css

   使い方：
     Taikai.mount(root, store)
     store = {
       get() → state, set(patch),
       playRealMatch?(table, ctx) → Promise<[{chara, place}, ...]>
     }

   自分が座る卓だけ実対局、他の卓は simulateTable で確率処理する
   （引き継ぎ書 §3）。store.playRealMatch を渡さなければ自分の卓も
   simulateTable で処理するので、実対局を繋ぐ前でも大会の流れは通る。

   実対局を繋ぐときは playRealMatch を次の形で書く：

     async playRealMatch(table, ctx) {
       const g = new Game(UI, { length: 'tonpuu' });
       // 席順は table のとおり。自分（id 0）を seat 0 に置く
       table.forEach((c, i) => {
         if (c.id === 0) return;                       // 人間は係数を持たない
         g.players[i].ai = paramsOf(c, STYLES);        // ← これで打ち筋が反映される
         g.players[i].name = c.name;
       });
       await g.run();
       return g.rankings().map((r, i) => ({ chara: table[r.seat], place: i + 1 }));
     }

   p.ai を入れないと従来どおりの打ち方になる（全員同じ）。

   state（すべてidで保存）：
     money        所持金
     playerRank   プレイヤーの段位（出られる大会が広がる）
     team         仲間3人のid
     comp         { id: 完成度 }
     recent       直近の大会で当たった相手のid（再戦しにくくする）
     records      { tierId: { entries, best } }
   ============================================================ */

const Taikai = (() => {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const pad3 = (id) => String(id).padStart(3, '0');
  const yen = (n) => n.toLocaleString('ja-JP') + '円';

  /* プレイヤーの段位ごとの実力の目安。人間なので係数は動かせない（引き継ぎ書 §3）。
     自動処理される卓での扱いにだけ使う */
  const PLAYER_STRENGTH = { D: 46, C: 54, B: 62, A: 70, S: 78 };
  const RANK_ORDER = ['D', 'C', 'B', 'A', 'S'];
  /* 段位を上げるのに必要な優勝回数（D→C, C→B, B→A, A→S） */
  const WINS_TO_PROMOTE = [2, 3, 4, 6];

  /* 賞金の配分。tier.prize を優勝賞金として、そこからの割合。
     四人とも別々に出るので、一人ぶんの期待値を4倍した額が事務所の収入になる。
     負け残りを厚くすると出るだけで儲かってしまうので、下位は薄くしてある */
  const PAYOUT = [
    { key: 'win',    label: '優勝',   rate: 1.00 },
    { key: 'second', label: '準優勝', rate: 0.32 },
    { key: 'final',  label: '決勝卓', rate: 0.12 },
    { key: 'semi',   label: '準決勝', rate: 0.035 },
    { key: 'first',  label: '一回戦', rate: 0.008 },
  ];

  /* 出場資格。大会の band に自分の段位が入っていれば出られる */
  function canEnter(tierId, playerRank) {
    const t = TOURNAMENTS[tierId];
    if (!t.strict) {
      // 格上の大会は「band の一番下」から出られる
      const min = t.band.reduce((a, r) => Math.min(a, RANK_ORDER.indexOf(r)), 9);
      return RANK_ORDER.indexOf(playerRank) >= min;
    }
    return t.band.includes(playerRank);
  }

  /* ------------------------------------------------------------
     大会を1回まわす。画面を持たない純粋な進行なのでテストできる
  ------------------------------------------------------------ */
  /* 組み合わせだけ作る。出走表を見せてから打ち始めたいので、
     ここでは対局を進めない（実対局が出走表より先に始まってしまう） */
  function prepare(tierId, opts) {
    const tier = TOURNAMENTS[tierId];
    const field = buildField(tierId, opts.team, opts.pool, {
      STYLES, region: tier.byRegion ? opts.region : null, recent: opts.recent || [],
    });
    return { tierId, tier, field, team: opts.team };
  }

  /* 組んだ枠で実際に勝ち上がりを進める */
  async function runTournament(prepared, opts) {
    const { tier, tierId, field, team } = prepared;

    const teamIds = new Set(team.map((c) => c.id));
    const rounds = [];
    let alive = field.slice();
    const eliminatedAt = new Map();         // id → 敗退したラウンド番号
    const lastPlace = new Map();            // id → 最後に打った卓での着順（育成に使う）
    const met = new Set();                  // 当たった相手（次回の抑制に使う）
    const beaten = new Set();               // 同じ卓で自分より下だった相手（契約条件に使う）

    let ri = 0;
    while (alive.length > 4) {
      const tables = makeTables(alive);
      const results = [];
      for (const t of tables) {
        const hasPlayer = t.some((c) => c.id === 0);
        if (hasPlayer) t.forEach((c) => { if (c.id !== 0) met.add(c.id); });
        /* 実対局が用意されていない、または「自動で処理する」設定のときは
           playRealMatch が何も返さないので、そのまま数値処理に落とす */
        let r = null;
        if (hasPlayer && opts.playRealMatch) {
          r = await opts.playRealMatch(t, { round: ri, tier, name: roundName(alive.length) });
        }
        if (!r) r = simulateTable(t, STYLES);
        if (hasPlayer) recordBeaten(r, beaten);
        results.push({ table: t, result: r, hasPlayer, hasTeam: t.some((c) => teamIds.has(c.id)) });
      }
      rounds.push({ name: roundName(alive.length), size: alive.length, results });

      const next = [];
      for (const r of results) {
        for (const x of r.result) {
          lastPlace.set(x.chara.id, x.place);
          if (x.place === 1) next.push(x.chara);
          else eliminatedAt.set(x.chara.id, ri);
        }
      }
      alive = next;
      ri++;
    }

    /* 決勝卓 */
    const finalTable = alive;
    const hasPlayer = finalTable.some((c) => c.id === 0);
    if (hasPlayer) finalTable.forEach((c) => { if (c.id !== 0) met.add(c.id); });
    let finalResult = null;
    if (hasPlayer && opts.playRealMatch) {
      finalResult = await opts.playRealMatch(finalTable, {
        round: ri, tier, name: '決勝卓', isFinal: true,
      });
    }
    if (!finalResult) finalResult = simulateTable(finalTable, STYLES);
    if (hasPlayer) recordBeaten(finalResult, beaten);
    finalResult.forEach((x) => lastPlace.set(x.chara.id, x.place));
    rounds.push({
      name: '決勝卓', size: 4, isFinal: true,
      results: [{ table: finalTable, result: finalResult, hasPlayer, hasTeam: finalTable.some((c) => teamIds.has(c.id)) }],
    });

    /* 各人の最終成績を出す */
    const totalRounds = rounds.length;          // 決勝卓を含む
    function outcomeOf(id) {
      const fin = finalResult.find((x) => x.chara.id === id);
      if (fin) {
        if (fin.place === 1) return { key: 'win', label: '優勝', place: 1 };
        if (fin.place === 2) return { key: 'second', label: '準優勝', place: 2 };
        return { key: 'final', label: `決勝卓${fin.place}位`, place: fin.place };
      }
      const at = eliminatedAt.get(id);
      if (at === undefined) return null;
      // 最後から2番目のラウンドで敗退 → 準決勝敗退
      if (at === totalRounds - 2) return { key: 'semi', label: '準決勝敗退', place: null };
      return { key: 'first', label: `${rounds[at].name}敗退`, place: null };
    }

    const placeOf = (id) => lastPlace.get(id) || 4;
    return {
      tier, tierId, field, rounds, finalResult, outcomeOf, placeOf,
      met: [...met], beaten: [...beaten],
    };
  }

  /* 同じ卓で自分より着順が下だった相手を控えておく。
     「ライバル撃破が条件」の雀ドルの判定に使う */
  function recordBeaten(result, into) {
    const me = result.find((x) => x.chara.id === 0);
    if (!me) return;
    result.forEach((x) => { if (x.chara.id !== 0 && x.place > me.place) into.add(x.chara.id); });
  }

  /* 賞金。チーム全員ぶんを合算する */
  function prizeFor(run, team) {
    const rows = team.map((c) => {
      const o = run.outcomeOf(c.id);
      const rate = o ? (PAYOUT.find((p) => p.key === o.key) || {}).rate || 0 : 0;
      return { chara: c, outcome: o, amount: Math.round(run.tier.prize * rate) };
    });
    return { rows, total: rows.reduce((a, r) => a + r.amount, 0) };
  }

  /* ------------------------------------------------------------
     画面
  ------------------------------------------------------------ */
  /* opts（`shell.html` が渡す。単体ページ taikai.html には無い）
       tierId  … 大会選択の画面を出さず、その大会に直行する
                 （第四段で、大会は「事務所に届く依頼」から入るようになった。
                  office/spec.md §8.2）
       onDone  … 大会が終わったら呼ぶ（事務所の夜へ返す）

     **大会選択の画面は、事務所がいるときだけ外す。**入口を一本にするため。
     単体ページの store は `startDay` を持たないので、いままでどおり出る */
  function mount(root, store, opts) {
    opts = opts || {};
    const hub = typeof store.startDay === 'function';
    ensureSilVar();
    root.innerHTML = '';
    root.classList.add('tkRoot');

    let screen = 'select';
    let run = null, prize = null, growth = null, lastPromotion = null;
    /* 依頼から入ったとき、事務所へ返す結果（§8.2） */
    let lastRun = null;

    const ALL = () => JANDOLS.concat(FREE_AGENTS);

    function playerCard() {
      const st = store.get();
      return Object.assign({}, PLAYER, {
        name: st.playerName || PLAYER.name,
        face: Title.normalizeFace(st.playerFace),
        isPlayer: true,
        rank: st.playerRank || 'D',
        playerStrength: PLAYER_STRENGTH[st.playerRank || 'D'],
      });
    }
    function teamCards() {
      const st = store.get();
      const mates = (st.team || []).map((id) => {
        const base = ALL().find((c) => c.id === id);
        if (!base) return null;
        return Object.assign({}, base, {
          comp: st.comp[id] != null ? st.comp[id] : base.comp,
          compMax: (st.compMax || {})[id],
          rank: (st.grades || {})[id] || base.rank,
        });
      }).filter(Boolean);
      return [playerCard()].concat(mates);
    }
    function poolCards() {
      const st = store.get();
      const teamIds = new Set([0].concat(st.team || []));
      return ALL().filter((c) => !teamIds.has(c.id)).map((c) => {
        const comp = st.comp[c.id];
        return comp != null ? Object.assign({}, c, { comp }) : Object.assign({}, c);
      });
    }

    /* ---------- 大会を選ぶ ---------- */
    function renderSelect() {
      const st = store.get();
      const rank = st.playerRank || 'D';
      const team = teamCards();
      const ready = team.length === 4;

      const cards = Object.keys(TOURNAMENTS).map((id) => {
        const t = TOURNAMENTS[id];
        const ok = canEnter(id, rank);
        const rec = (st.records || {})[id];
        return `<button type="button" class="tkTier${ok ? '' : ' locked'}" data-tier="${id}"
            ${ok && ready ? '' : 'disabled'}>
          <span class="tkTierHead">
            <span class="tkTierName">${esc(t.name)}</span>
            <span class="tkTierSize">${t.size}人</span>
          </span>
          <span class="tkTierNote">${esc(t.note)}</span>
          <span class="tkTierFoot">
            <span class="tkPrize">優勝 ${yen(t.prize)}</span>
            <span class="tkBand">${t.band.join('・')}級${t.strict ? 'のみ' : '中心'}</span>
          </span>
          ${rec ? `<span class="tkRec">出場${rec.entries}回　最高 ${esc(rec.best)}</span>` : ''}
          ${ok ? '' : `<span class="tkLock">${t.band[0]}級から出場できます</span>`}
        </button>`;
      }).join('');

      root.innerHTML = `
        <div class="tkHead">
          <h1 class="tkTitle">${hub ? '大会' : '大会に出る'}</h1>
          <div class="tkStatus">
            <span class="tkStat money">所持金 <b>${yen(st.money || 0)}</b></span>
            <span class="tkStat">${esc(st.playerName || 'あなた')}の段位 <b>${rank}</b></span>
          </div>
        </div>
        ${ready ? '' : `<p class="tkWarn">先にチームを組んでください。あなたを含めて四人で出場します。</p>`}
        <div class="tkRoster">${team.map((c) => `<span class="tkChip">${esc(c.name)}</span>`).join('')}</div>
        <div class="tkTiers">${cards}</div>
        <section class="tkSettings">
          <h2 class="tkSecT">対局の設定</h2>
          <div class="tkSetRow">
            <span class="tkSetLabel">自分の卓</span>
            <span class="tkSeg">
              <button type="button" data-set="auto:0" aria-pressed="${!st.autoMatch}">自分で打つ</button>
              <button type="button" data-set="auto:1" aria-pressed="${!!st.autoMatch}">自動で処理</button>
            </span>
          </div>
          <div class="tkSetRow">
            <span class="tkSetLabel">進む速さ</span>
            <span class="tkSeg">
              ${[[900, 'ゆっくり'], [520, 'ふつう'], [200, '速い'], [0, '最速']].map(([v, n]) =>
                `<button type="button" data-set="speed:${v}"
                  aria-pressed="${(st.matchSpeed === undefined ? 520 : st.matchSpeed) === v}">${n}</button>`).join('')}
            </span>
          </div>
          <div class="tkSetRow">
            <span class="tkSetLabel">補助表示</span>
            <span class="tkSeg">
              <button type="button" data-set="hint:1" aria-pressed="${st.showHints !== false}">出す</button>
              <button type="button" data-set="hint:0" aria-pressed="${st.showHints === false}">出さない</button>
            </span>
          </div>
          <p class="tkHint">${st.autoMatch
            ? 'すべての卓を結果だけで処理します。'
            : '自分が座る卓だけ実際に打ちます。他の卓は結果だけが出ます。'}
            シャンテン数と危険度の目安が補助表示です。</p>
        </section>`;
    }

    /* ---------- 出走表 ---------- */
    function renderField() {
      const st = store.get();
      const teamIds = new Set([0].concat(st.team || []));
      const byRank = {};
      prepared.field.forEach((c) => {
        const r = c.id === 0 ? '—' : gradeOf(c.comp != null ? c.comp : compFromRank(c.rank));
        (byRank[r] = byRank[r] || []).push(c);
      });
      const order = ['S', 'A', 'B', 'C', 'D', '—'];
      const groups = order.filter((r) => byRank[r]).map((r) => `
        <div class="tkGroup">
          <div class="tkGroupT">${r === '—' ? 'あなた' : r + '級'}　<span>${byRank[r].length}名</span></div>
          <div class="tkNames">${byRank[r].map((c) =>
            `<span class="tkName${teamIds.has(c.id) ? ' own' : ''}">${esc(c.name)}</span>`).join('')}</div>
        </div>`).join('');

      root.innerHTML = `
        <div class="tkHead"><h1 class="tkTitle">${esc(prepared.tier.name)}　出走表</h1>
          <div class="tkStatus"><span class="tkStat">${prepared.field.length}名</span></div></div>
        <p class="tkHint">金色があなたの事務所の四人です。</p>
        ${groups}
        <button type="button" class="tkGo" data-act="start">卓に着く</button>`;
    }

    /* ---------- 進行 ---------- */
    function renderRounds() {
      const st = store.get();
      const teamIds = new Set([0].concat(st.team || []));

      const blocks = run.rounds.map((rd) => {
        /* 決勝卓は自事務所がいなくても必ず見せる。優勝者が分からなくなる */
        const own = rd.isFinal ? rd.results : rd.results.filter((r) => r.hasTeam);
        const ownHTML = own.map((r) => {
          const rows = r.result.map((x) => `
            <div class="tkSeatRow${teamIds.has(x.chara.id) ? ' own' : ''}">
              <span class="tkPlace p${x.place}">${x.place}位</span>
              <span class="tkSeatName">${esc(x.chara.name)}</span>
              <span class="tkSeatStyle">${x.chara.id === 0 ? '' : esc(STYLES[x.chara.style].name)}</span>
            </div>`).join('');
          const label = rd.isFinal
            ? (r.hasPlayer ? 'あなたの決勝卓' : '決勝卓')
            : (r.hasPlayer ? 'あなたの卓' : '仲間の卓');
          return `<div class="tkTable${r.hasPlayer ? ' mine' : ''}">
            <div class="tkTableT">${label}</div>${rows}</div>`;
        }).join('');

        const others = rd.results.length - own.length;
        return `<section class="tkRound">
          <h2 class="tkRoundT">${esc(rd.name)}<span>${rd.size}名 / ${rd.results.length}卓</span></h2>
          ${ownHTML || '<p class="tkQuiet">この回戦に残っている自事務所の雀ドルはいません。</p>'}
          ${others > 0 ? `<p class="tkQuiet">他 ${others}卓は同時に進行しました。</p>` : ''}
        </section>`;
      }).join('');

      root.innerHTML = `
        <div class="tkHead"><h1 class="tkTitle">${esc(run.tier.name)}</h1></div>
        ${blocks}
        <button type="button" class="tkGo" data-act="result">結果を見る</button>`;
    }

    /* ---------- 結果 ---------- */
    function renderResult() {
      const rows = prize.rows.map((r) => `
        <div class="tkPrizeRow">
          <span class="tkPrizeName">${esc(r.chara.name)}</span>
          <span class="tkPrizeOut">${r.outcome ? esc(r.outcome.label) : '不出場'}</span>
          <span class="tkPrizeYen">${r.amount ? yen(r.amount) : '—'}</span>
        </div>`).join('');

      const gr = growth.length ? `
        <h2 class="tkSecT">育成</h2>
        ${growth.map((g) => `
          <div class="tkGrowRow">
            <span class="tkGrowName">${esc(g.name)}</span>
            <span class="tkTrack"><span class="tkFill" style="width:${Math.round(g.after)}%"></span></span>
            <span class="tkGrowNum">完成度 ${g.before.toFixed(1)} → ${g.after.toFixed(1)}<span class="tkCeil">／上限 ${Math.round(g.ceiling)}</span></span>
          </div>
          ${g.promoted ? `<div class="tkPromote">${esc(g.name)} が ${g.promoted}級に上がりました</div>` : ''}
        `).join('')}` : '';

      const st = store.get();
      const promo = lastPromotion
        ? `<div class="tkPromote">あなたの段位が ${lastPromotion}級に上がりました。出られる大会が増えます。</div>`
        : '';
      root.innerHTML = `
        <div class="tkHead"><h1 class="tkTitle">${esc(run.tier.name)}　結果</h1></div>
        <div class="tkChampion">優勝　${esc(run.finalResult[0].chara.name)}</div>
        ${promo}
        <h2 class="tkSecT">賞金</h2>
        ${rows}
        <div class="tkPrizeTotal">合計 <b>${yen(prize.total)}</b>　／　所持金 ${yen(st.money || 0)}</div>
        ${gr}
        <button type="button" class="tkGo" data-act="back">${
          opts.onDone ? '事務所へ戻る' : '大会を選ぶ'}</button>`;
    }

    /* ---------- 進行の実処理 ---------- */
    let prepared = null;

    function start(tierId) {
      const st = store.get();
      /* **枠を組むときだけ疲労と調子を乗せる**（`office/spec.md` §9）。
         `teamCards()` そのものは素のまま——`finish()` の育成が
         `st.comp` を読み直すので二重に効かないが、表示にも使われているため。
         `Office` は「あれば使う」（単体ページでは素の子が出る） */
      const carded = (c) => (typeof Office !== 'undefined' && Office.tableCardOf)
        ? Office.tableCardOf(st, c) : c;
      prepared = prepare(tierId, {
        team: teamCards().map((c) => (c.id === 0 ? c : carded(c))), pool: poolCards(),
        region: st.region || (teamCards()[1] || {}).region || null,
        recent: st.recent || [],
      });
      run = null;
      screen = 'field';
      renderField();
    }

    /* 「卓に着く」を押してから対局に入る。
       自分の卓は実対局、他の卓は数値処理（taikai の runTournament が振り分ける） */
    async function playRounds() {
      root.innerHTML = `<p class="tkQuiet tkLoading">卓が立ちました…</p>`;
      run = await runTournament(prepared, { playRealMatch: store.playRealMatch });
      screen = 'rounds';
      renderRounds();
    }

    function finish() {
      const st = store.get();
      const team = teamCards();
      prize = prizeFor(run, team);

      /* 育成。仲間だけ（プレイヤーは係数を持たない）。
         compMax は必ず保存すること。毎回 comp + pot で計算し直すと
         天井が現在地に付いて回り、際限なく上がってしまう（引き継ぎ書 §4 の罠） */
      const comp = Object.assign({}, st.comp);
      const compMax = Object.assign({}, st.compMax || {});
      const grades = Object.assign({}, st.grades || {});
      /* **子ごとの大会戦績**（office/spec.md §9.1）。雀エイト表がこれを読む。
         プレイヤー（id 0）は `records` の側が持っているので入れない */
      let wins = st.wins && typeof st.wins === 'object' ? st.wins : {};
      growth = [];
      team.filter((c) => c.id !== 0).forEach((c) => {
        const o = run.outcomeOf(c.id);
        if (!o) return;
        wins = recordResult(wins, c.id, run.tierId, o.key);
        const target = Object.assign({}, c, {
          comp: comp[c.id] != null ? comp[c.id] : c.comp,
          compMax: compMax[c.id],
          rank: grades[c.id] || c.rank,
        });
        const before = target.comp;
        const res = addExp(target, run.placeOf(c.id), run.tier.stage);
        comp[c.id] = target.comp;
        compMax[c.id] = target.compMax;
        grades[c.id] = target.rank;
        growth.push({
          name: c.name, before, after: target.comp,
          ceiling: target.compMax, promoted: res.promoted,
        });
      });

      /* プレイヤーの段位。人間なので係数は動かせない（引き継ぎ書 §3）。
         優勝を重ねると上がり、出られる大会が広がる。
         優勝1回ごとに上げると四回でS級になってしまうので、段ごとに必要数を増やす */
      const mine = run.outcomeOf(0);
      let playerRank = st.playerRank || 'D';
      let playerWins = st.playerWins || 0;
      let promotedRank = null;
      if (mine && mine.key === 'win') {
        playerWins += 1;
        const i = RANK_ORDER.indexOf(playerRank);
        if (i < RANK_ORDER.length - 1 && playerWins >= WINS_TO_PROMOTE[i]) {
          playerRank = RANK_ORDER[i + 1];
          playerWins = 0;
          promotedRank = playerRank;
        }
      }

      const records = Object.assign({}, st.records || {});
      const rec = records[run.tierId] || { entries: 0, best: '—' };
      rec.entries += 1;
      const bestRank = (label) => PAYOUT.findIndex((p) => p.label === label);
      if (mine && (rec.best === '—' || PAYOUT.findIndex((p) => p.key === mine.key) < bestRank(rec.best))) {
        rec.best = (PAYOUT.find((p) => p.key === mine.key) || {}).label || rec.best;
      }
      records[run.tierId] = rec;

      /* 撃破した相手は積み上げる（一度勝てば条件は満たしたまま） */
      const beaten = Array.from(new Set((st.beaten || []).concat(run.beaten)));

      store.set({
        money: (st.money || 0) + prize.total,
        comp, compMax, grades, playerRank, playerWins, records, beaten, wins,
        recent: run.met.slice(0, 40),
      });
      lastPromotion = promotedRank;
      /* 依頼から入ったときは、結果を事務所へ持ち帰る（§8.2） */
      lastRun = { tierId: run.tierId, tierName: run.tier.name,
                  best: rec.best, prize: prize.total, promoted: promotedRank || null };
      screen = 'result';
      renderResult();
    }

    /* ---------- 操作 ---------- */
    root.addEventListener('click', (e) => {
      const set = e.target.closest('[data-set]');
      if (set) {
        const [key, val] = set.dataset.set.split(':');
        if (key === 'auto') store.set({ autoMatch: val === '1' });
        if (key === 'speed') store.set({ matchSpeed: Number(val) });
        if (key === 'hint') store.set({ showHints: val === '1' });
        renderSelect();
        return;
      }
      const tier = e.target.closest('[data-tier]');
      if (tier && !tier.disabled) { start(tier.dataset.tier); return; }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'start') { playRounds(); }
      else if (act.dataset.act === 'result') finish();
      else if (act.dataset.act === 'back') {
        /* 依頼から入ったときは、戻る先が事務所（大会選択の画面は無い） */
        if (opts.onDone) { opts.onDone(lastRun); return; }
        screen = 'select'; renderSelect();
      }
    });

    /* 依頼から直行するときは、大会を選ぶ画面を出さない（§8.2） */
    if (opts.tierId && TOURNAMENTS[opts.tierId]) start(opts.tierId);
    else renderSelect();
    return { refresh: () => { if (screen === 'select') renderSelect(); } };
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

  return { mount, prepare, runTournament, prizeFor, canEnter, PAYOUT, PLAYER_STRENGTH };
})();

if (typeof module !== 'undefined') module.exports = Taikai;
