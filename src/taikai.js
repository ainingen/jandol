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

  /* 顔の落とし方（`field-spec.md` §7）。**二本立てを崩さないこと**——
     自分は `p01`〜、雀ドルは3桁。`match.js` の `faceOf` と同じ式で、
     片方だけ直すと自分の顔だけ出なくなる。
     画像が無い id（`PORTRAIT_MAX_ID` の先）は `onerror` で消して、
     CSS の影絵（`ensureSilVar` が入れる `--sil-img`）が下から出る */
  const faceOf = (c) => (c && c.id === 0
    ? `img/${c.face || 'p01'}.webp`
    : `img/${pad3(c.id)}.webp`);

  /* 注目の三人（`field-spec.md` §3）。**因縁 → 強さ の順に三人まで。**

     1. **因縁枠**——`st.recent` に入っていて、`st.beaten` に**入っていない**相手
        （＝前に当たったが、まだ勝てていない相手）。`recent` は新しい順なので先頭から
     2. **強さ枠**——残りを `strengthOf` の降順で埋める
     3. 自事務所（`[0].concat(st.team)`）は入れない
     4. 同じ子を二度入れない

     `st.beaten` は一度勝てば積み上がったまま消えないので、因縁枠は
     **「取りこぼしたまま」の相手だけ**になり、倒すと自然に卒業していく。
     初回は `recent` が空なので三人とも強さ枠になる。それも正しい姿。

     **強さが同じなら id で固定する**——雀エイト表と同じ理由で、
     開くたびに並びが揺れると表として読めなくなる。

     返すのは `[{ chara, why }]`。`why` は 'grudge'（因縁）か 'strong'（強さ）で、
     **見出し語の文面は画面側が持つ**（ここは選ぶだけ） */
  function pickSpotlight(field, st, n) {
    st = st || {};
    n = n == null ? 3 : n;
    const own = new Set([0].concat(st.team || []));
    const beaten = new Set(st.beaten || []);
    /* `buildField` は人数が足りないとプールを使い回す（`dup`）ので、
       **id で畳んでから**選ぶ。畳まないと同じ子が二枠を食う */
    const byId = new Map();
    (field || []).forEach((c) => {
      if (c && !own.has(c.id) && !byId.has(c.id)) byId.set(c.id, c);
    });

    const out = [];
    const taken = new Set();
    const add = (c, why) => {
      if (!c || taken.has(c.id) || out.length >= n) return;
      taken.add(c.id);
      out.push({ chara: c, why });
    };
    (st.recent || []).forEach((id) => { if (!beaten.has(id)) add(byId.get(id), 'grudge'); });
    Array.from(byId.values())
      .filter((c) => !taken.has(c.id))
      .sort((a, b) => (strengthOf(b, STYLES) - strengthOf(a, STYLES)) || (a.id - b.id))
      .forEach((c) => add(c, 'strong'));
    return out;
  }

  /* 勝ち上がりの梯子（`field-spec.md` §5）。**人数から作る。**
     卓数を書き写すと、大会の `size` を変えたときに必ずずれる。
     16人 → ['16名','4卓','決勝卓'] / 64人 → ['64名','16卓','4卓','決勝卓']

     `roundName()` は使わない——あれは「残り人数 → 回戦名」で、
     ここが欲しいのは卓数 */
  function ladderOf(size) {
    const out = [size + '名'];
    let n = size;
    while (n > 4) { out.push((n / 4) + '卓'); n = n / 4; }
    out.push('決勝卓');
    return out;
  }

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

  /* ------------------------------------------------------------
     大会の進行の控え（`docs/design/taikai/resume-spec.md` §4・§5）— 段2

     `runTournament` はメモリだけで回るので、対局中に落ちると
     **賞金・成長・段位・戦績がまとめて消え、依頼も戻らない。**
     控えを外へ出す口（`onProgress`）と、控えから続ける口（`progress`）を足す。

     **`while` の中身は変えない**（§8）。足したのは
     「卓割りと結果を控えから取れるなら取る」という**差し替えだけ**で、
     勝ち上がりの集計（`lastPlace` / `eliminatedAt` / `alive`）も
     `recordBeaten` も `met` も、**控えから戻した結果に対して同じ行が走る。**
     復帰の側に集計を書き写すと、片方を直したときに必ずずれる。
  ------------------------------------------------------------ */
  const PROGRESS_V = 1;

  /* 控えの卓割り・結果はキャラIDで持つ（§4）。戻すのは `field` から引き直す
     ——`st` は大会中に一切書かれないので、同じカードができる */
  const idsOf = (list) => list.map((c) => c.id);

  /* 同じ卓か。**id の集合で見る**（§5）——`Match.play` は自分を先頭に
     回転させるので、並び順は当てにならない */
  function sameSeats(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const s = new Set(a);
    return b.every((id) => s.has(id)) && s.size === b.length;
  }

  /* 組んだ枠で実際に勝ち上がりを進める。

       opts.playRealMatch … 自分の卓を実際に打つ口（無ければ全部 simulateTable）
       opts.progress      … 控え（`st.pendingTaikai`）。無ければ最初から
       opts.onProgress    … (progress) => void。控えを書き出す口。無ければ何もしない
       opts.offerId       … 依頼の id。控えにそのまま載せる（`onDone` が要る） */
  async function runTournament(prepared, opts) {
    const { tier, tierId, field, team } = prepared;

    const teamIds = new Set(team.map((c) => c.id));
    const rounds = [];
    let alive = field.slice();
    const eliminatedAt = new Map();         // id → 敗退したラウンド番号
    const lastPlace = new Map();            // id → 最後に打った卓での着順（育成に使う）
    const met = new Set();                  // 当たった相手（次回の抑制に使う）
    const beaten = new Set();               // 同じ卓で自分より下だった相手（契約条件に使う）

    /* ---------- 控え（§4・§5） ---------- */
    const byId = new Map(field.map((c) => [c.id, c]));
    const charaOf = (id) => byId.get(id) || null;
    const old = (opts.progress && typeof opts.progress === 'object') ? opts.progress : null;
    const emit = typeof opts.onProgress === 'function' ? opts.onProgress : null;

    const prog = {
      v: PROGRESS_V,
      tierId,
      offerId: old ? (old.offerId != null ? old.offerId : null)
        : (opts.offerId != null ? opts.offerId : null),
      fieldIds: idsOf(field),
      rounds: [],
      ri: 0,
    };
    const push = () => { if (emit) emit(prog); };

    /* その回戦の控え。**壊れていたら無いものとして扱う**——
       捨てる条件は呼ぶ側が持つ（§7）ので、ここでは黙って最初から組み直す */
    const recOf = (i) => {
      const r = old && Array.isArray(old.rounds) ? old.rounds[i] : null;
      return (r && typeof r === 'object') ? r : null;
    };
    /* 控えの卓割り。**一人でも引けなければ使わない**（キャラの改番のあと） */
    function tablesFrom(rec) {
      if (!rec || !Array.isArray(rec.tables) || !rec.tables.length) return null;
      const out = [];
      for (const ids of rec.tables) {
        if (!Array.isArray(ids) || !ids.length) return null;
        const t = ids.map(charaOf);
        if (t.some((c) => !c)) return null;
        out.push(t);
      }
      return out;
    }
    /* 控えの結果。`t` と顔ぶれが合っているものだけ戻す */
    function resultFrom(rec, k, t) {
      const rows = rec && Array.isArray(rec.results) ? rec.results[k] : null;
      if (!Array.isArray(rows) || rows.length !== t.length) return null;
      const out = rows.map((x) => (x && charaOf(x.id)
        ? { chara: charaOf(x.id), place: x.place } : null));
      if (out.some((x) => !x)) return null;
      if (!sameSeats(out.map((x) => x.chara.id), idsOf(t))) return null;
      return out;
    }

    /* ---------- 落ちた対局の控え（`match/resume-spec.md`）----------
       **`progress` があるときだけ読む。**最初から始めるときに古い控えを
       拾うと、関係のない卓を復帰させてしまう。
       使ったら手放す（同じ控えを二つの卓に使わない） */
    let saved = null;
    if (old && typeof Resume !== 'undefined' && Resume && typeof Resume.load === 'function') {
      try { saved = Resume.load(); } catch (e) { saved = null; }
    }
    /* 自分の卓を控えから片づける（§5 の 4）。返すのは
         { result }  … `done` 付き。**打たずに結果にする**
         { resume }  … `done` 無し。`playRealMatch` に渡して局の頭から
         null        … 席が一致しない／控えが無い。いままでどおり東1局から */
    function resumeFor(t) {
      if (!saved) return null;
      if (!sameSeats(saved.seats, idsOf(t))) return null;
      const rec = saved;
      saved = null;                                   // 一度きり
      if (Array.isArray(rec.done)) {
        const out = rec.done.map((d) => {
          const c = charaOf(rec.seats[d.seat]);
          return c ? { chara: c, place: d.place } : null;
        });
        if (out.some((x) => !x)) return null;
        out.sort((a, b) => a.place - b.place);
        return { result: out };
      }
      return { resume: rec };
    }

    let ri = 0;
    while (alive.length > 4) {
      const rec = recOf(ri);
      /* **控えに卓割りがあれば `makeTables` を呼ばない**（§5 の 2）。
         呼ぶと乱数で割り直されて、控えた結果と噛み合わなくなる */
      const tables = tablesFrom(rec) || makeTables(alive);
      prog.ri = ri;
      prog.rounds[ri] = { name: roundName(alive.length), size: alive.length,
                          tables: tables.map(idsOf),
                          results: tables.map((t, k) => {
                            const r = resultFrom(rec, k, t);
                            return r ? r.map((x) => ({ id: x.chara.id, place: x.place })) : null;
                          }) };
      push();                                          // 卓割りが決まった（§4 の 2）
      const results = [];
      for (let k = 0; k < tables.length; k++) {
        const t = tables[k];
        const hasPlayer = t.some((c) => c.id === 0);
        if (hasPlayer) t.forEach((c) => { if (c.id !== 0) met.add(c.id); });
        /* 実対局が用意されていない、または「自動で処理する」設定のときは
           playRealMatch が何も返さないので、そのまま数値処理に落とす */
        let r = resultFrom(rec, k, t);                 // **控えにあれば打ち直さない**（§5 の 3）
        if (!r && hasPlayer && opts.playRealMatch) {
          const back = resumeFor(t);
          if (back && back.result) r = back.result;    // `done` 付き＝もう打ち終わっている
          else {
            r = await opts.playRealMatch(t, { round: ri, tier, name: roundName(alive.length),
              resume: back ? back.resume : null });
          }
        }
        if (!r) r = simulateTable(t, STYLES);
        if (hasPlayer) recordBeaten(r, beaten);
        results.push({ table: t, result: r, hasPlayer, hasTeam: t.some((c) => teamIds.has(c.id)) });
        prog.rounds[ri].results[k] = r.map((x) => ({ id: x.chara.id, place: x.place }));
        push();                                        // 卓ごとに結果が出た（§4 の 3）
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

    /* 決勝卓。**上の回戦と同じ扱い**（§4 の 4） */
    const finRec = recOf(ri);
    const finTables = tablesFrom(finRec);
    const finalTable = (finTables && finTables[0]) || alive;
    const hasPlayer = finalTable.some((c) => c.id === 0);
    if (hasPlayer) finalTable.forEach((c) => { if (c.id !== 0) met.add(c.id); });
    prog.ri = ri;
    prog.rounds[ri] = { name: '決勝卓', size: 4, isFinal: true,
                        tables: [idsOf(finalTable)], results: [null] };
    push();
    let finalResult = resultFrom(finRec, 0, finalTable);   // 控えにあれば打ち直さない
    if (!finalResult && hasPlayer && opts.playRealMatch) {
      const back = resumeFor(finalTable);
      if (back && back.result) finalResult = back.result;
      else {
        finalResult = await opts.playRealMatch(finalTable, {
          round: ri, tier, name: '決勝卓', isFinal: true,
          resume: back ? back.resume : null,
        });
      }
    }
    if (!finalResult) finalResult = simulateTable(finalTable, STYLES);
    if (hasPlayer) recordBeaten(finalResult, beaten);
    prog.rounds[ri].results[0] = finalResult.map((x) => ({ id: x.chara.id, place: x.place }));
    push();
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
       resume  … `st.pendingTaikai`（`taikai/resume-spec.md` §6）。
                 大会の途中で落ちたとき、表紙の「続きから」がこれを持って来る。
                 **捨てる条件（§7）はここで見る**——当たれば黙って消して事務所へ

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
      /* 大会の色は大会の中だけ（§4）。選ぶ画面では外す */
      delete root.dataset.tier;
      root.classList.remove('tkEnter', 'tkSkip');
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
            <span class="tkSetLabel">打牌の操作</span>
            <span class="tkSeg">
              <button type="button" data-set="discard:single" aria-pressed="${st.discardMode !== 'double'}">一度押し</button>
              <button type="button" data-set="discard:double" aria-pressed="${st.discardMode === 'double'}">二度押し</button>
            </span>
          </div>
          <div class="tkSetRow">
            <span class="tkSetLabel">効果音</span>
            <span class="tkSeg">
              ${[[1, 'ふつう'], [0.5, '小さく'], [0, '消す']].map(([v, n]) =>
                `<button type="button" data-set="sfx:${v}"
                  aria-pressed="${(st.sfxVolume === undefined ? 1 : st.sfxVolume) === v}">${n}</button>`).join('')}
            </span>
          </div>
          <!-- **iOS の Safari は WebAudio を本体の消音スイッチで黙らせる。**
               実装が正しくても鳴らないので、遊ぶ人は「音が無いゲーム」だと思う（実際にそうなった）。
               常時出す小さな注記。警告として目立たせない——音量を触りにきた人の目に入れば足りる -->
          <p class="tkSetNote">音が出ないときは、端末のマナーモードを確認してください</p>
          <!-- **四人卓のときだけ、対局中に再読み込みされる**（docs/BACKLOG.md。原因は未特定）。
               縦持ちの列レイアウトでは起きない。落ちても局の頭から続けられるようにはしてあるが
               （docs/design/taikai/resume-spec.md）、**避けられる道があることは言っておく。**
               **警告にしない**——マナーモードの注記と同じ大きさ・同じ色で、
               困った人の目に入れば足りる。起きていない人を不安にさせない。
               **この注記に逆引用符を入れないこと**——ここはテンプレート文字列の中で、
               入れた瞬間に文字列が切れる（実際に切った） -->
          <p class="tkSetNote">画面が途中で止まることがあるときは、縦持ちでお試しください</p>
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
            シャンテン数と危険度の目安が補助表示です。
            打牌は牌を上へはらっても切れます。</p>
        </section>`;
    }

    /* ---------- 出走表 ---------- */
    /* 調子（`field-spec.md` §6.3）。**`Office` があるときだけ。**
       単体ページ（`taikai.html`）では office.js が読まれていないので何も出ない。
       **`st.cond` にその子の目が入っているときだけ出す**——`Office.condOf` は
       知らない id に 0 を返すので、有無を見ずに出すと**まだ引いていない朝でも
       全員が「ふつう」と言う。**既定値をここに書かない（二か所に持つと片方が古びる） */
    function condHTML(c) {
      if (typeof Office === 'undefined' || !Office.condOf || !Office.condLabel) return '';
      const st = store.get();
      if (!st.cond || typeof st.cond[c.id] !== 'number') return '';
      const v = Office.condOf(st, c.id);
      /* **二行に割って書く**（値の行と言葉の行）。88px のカードでは
         一行に入らず、任せると「調 子 +1 悪くな い」と**語の途中で折れる** */
      return `<span class="tkCond c${v >= 0 ? 'p' : 'm'}${Math.abs(v)}"
        ><i>調子 ${v > 0 ? '+' : ''}${v}</i><b>${esc(Office.condLabel(v))}</b></span>`;
    }

    /* 入場の演出（`field-spec.md` §6）。**三つとも満たしたときだけ。**

       - `tier.stage` が 'title' か 'final'（タイトル戦・雀エイト選抜戦）
       - `resume` が無い（続きを待っている人に演出は見せない）
       - `prefers-reduced-motion` が reduce でない

       大会は依頼から何度も入る画面なので、日常の大会で毎回止まると
       三回目には邪魔になる。**音は鳴らさない**——出走表で `Sound.init()` を
       呼ぶと、「卓に着く」で初期化するいまの一本道が二本になる。

       **段はCSSだけで組む**（JSのタイマーで組まない）。
       触ったら `.tkSkip` を足して `animation:none` にするだけ——
       **地の状態＝終端の状態**にしてあるので、それで終端へ飛ぶ */
    let skipEnter = null;
    function playEntrance() {
      if (skipEnter) { root.removeEventListener('pointerdown', skipEnter); skipEnter = null; }
      root.classList.remove('tkEnter', 'tkSkip');
      if (resume) return;
      const stage = prepared.tier.stage;
      if (stage !== 'title' && stage !== 'final') return;
      if (typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      root.classList.add('tkEnter');
      skipEnter = () => {
        root.classList.add('tkSkip');
        root.removeEventListener('pointerdown', skipEnter);
        skipEnter = null;
      };
      root.addEventListener('pointerdown', skipEnter);
    }

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

      /* 復帰の一言（§6）。**`resume` があるときだけ。**
         「卓に着く」は出さない——「続ける」がその代わり。

         **「通信」とは書かない**（`match/resume-spec.md` §1）。
         原因は端末の側で回線ではないので、通信のせいだと思った人は
         Wi-Fi を疑って無駄に時間を使う */
      let notice = '';
      if (resume) {
        const rec = (typeof Resume !== 'undefined') ? Resume.load() : null;
        const rd = (resume.rounds || [])[resume.ri || 0];
        const where = esc(prepared.tier.name) + ' ' + esc((rd && rd.name) || '一回戦');
        /* 局名は控えから。**無ければ東1局**（まだ一局も打っていない）。
           **`done` 付きは局名を出さない**——その対局はもう終わっていて、
           戻る先が局の頭ではなく「結果」なので、局名を出すと打ち直すように読める */
        const tail = (rec && Array.isArray(rec.done))
          ? 'の対局は終わっていました。結果から続けます'
          : 'を ' + esc(rec ? Resume.kyokuName(rec.kyoku, rec.honba) : '東1局')
            + ' の最初から再開します';
        notice = `<div class="tkResume">
          <h2>この大会をやり直します</h2>
          <p>一時的に画面が止まったため、${where} ${tail}</p>
          <div class="tkResumeBtns">
            <button type="button" class="tkGo" data-act="resume">続ける</button>
            <button type="button" class="tkGhost" data-act="abandon">この大会を諦める</button>
          </div>
        </div>`;
      }

      /* ③ カード一枚（§2）。③と④で同じものを使う——載せるものは同じで、
         違うのは見出し語（`why`）と縁の色だけ。
         **顔は七枚まで**（§7）——四人＋三人。⑤の全員一覧には出さない */
      const cardHTML = (c, o) => {
        o = o || {};
        const isMe = c.id === 0;
        /* 段位は**自分は `st.playerRank`、仲間は完成度から**（§2③）。
           完成度は `prepared.field` の値をそのまま使う——`teamCards()` を
           引き直すと、疲労と調子のぶんだけ下の一覧と食い違う */
        const comp = c.comp != null ? c.comp : compFromRank(c.rank);
        const grade = isMe ? (st.playerRank || 'D') : gradeOf(comp);
        const style = (!isMe && STYLES[c.style]) ? STYLES[c.style].name : '';
        return `<div class="tkCard${o.mine ? ' mine' : ''}">
          ${o.why ? `<span class="tkWhy">${esc(o.why)}</span>` : ''}
          <span class="tkFace"><img src="${esc(faceOf(c))}" alt=""
            decoding="async" onerror="this.remove()"></span>
          <span class="tkCardName">${esc(c.name)}</span>
          <span class="tkCardSub"><b>${esc(grade)}級</b>${
            style ? `<span class="tkCardStyle">${esc(style)}</span>` : ''}</span>
          ${isMe ? '' : `<span class="tkTrack"><span class="tkFill"
            style="width:${Math.round(Math.max(0, Math.min(100, comp)))}%"></span></span>`}
          ${condHTML(c)}
        </div>`;
      };

      /* ③ あなたの事務所（§2）。順序は**自分が先頭**、あとは `st.team` の順。
         中身は `prepared.field` から引く——上のカードと下の一覧が
         同じ数字を見るため（§2③） */
      const inField = new Map();
      prepared.field.forEach((c) => { if (!inField.has(c.id)) inField.set(c.id, c); });
      const ours = teamCards().map((c) => inField.get(c.id) || c);
      const oursHTML = `<section class="tkFieldSec">
        <h2 class="tkSecT">あなたの事務所</h2>
        <div class="tkCards">${ours.map((c) =>
          cardHTML(c, { mine: c.id === 0 })).join('')}</div>
      </section>`;

      /* ④ 注目の雀ドル（§2・§3）。**「この中の誰かと当たります」とは書かない**
         ——卓割りはまだ決まっていない。一回戦で当たらないことも、
         決勝まで一度も当たらないこともある。

         **注目に出した子を⑤の全員一覧から消さないこと**（§1）。
         上で見た名前を下で探して見つからないと、壊れて見える。二か所に出てよい */
      const WHY = { grudge: '前に当たって、勝てなかった相手', strong: '優勝候補' };
      const spot = pickSpotlight(prepared.field, st);
      const spotHTML = spot.length ? `<section class="tkFieldSec">
        <h2 class="tkSecT">注目の雀ドル</h2>
        <div class="tkCards tkCardsSpot">${spot.map((x) =>
          cardHTML(x.chara, { why: WHY[x.why] })).join('')}</div>
      </section>` : '';

      /* ② 賞金と梯子（§2・§5）。**賞金は大会によらず金**（`--gold`）——
         金は「お金の色」として既に働いているので、大会ごとに変えると意味が壊れる。
         梯子は `prepared.field.length` から作る。①の「N名」と同じ数から出すので、
         二つが食い違いようがない */
      const ladder = ladderOf(prepared.field.length).map((s2, i, a) =>
        `<li${i === a.length - 1 ? ' class="last"' : ''}>${esc(s2)}</li>`).join('');
      const stakes = `<div class="tkStakes">
        <div class="tkPrizeBig"><span class="tkPrizeBigL">優勝</span>
          <b>${yen(prepared.tier.prize)}</b></div>
        <ol class="tkLadder">${ladder}</ol>
      </div>`;

      /* **大会の格を色で言う**（§4）。`renderSelect` に戻るときに外す。
         **`root` に付くので、click の拾い口は `button[data-tier]` に狭めてある**
         ——`[data-tier]` のままだと、出走表のどこを押しても `closest` が
         `root` に当たって `start()` が走り、顔ぶれが引き直される（§4.1） */
      root.dataset.tier = prepared.tierId;
      root.innerHTML = `
        <div class="tkHead tkFieldHead"><h1 class="tkTitle">${esc(prepared.tier.name)}　出走表</h1>
          <div class="tkStatus"><span class="tkStat">${prepared.field.length}名</span></div></div>
        ${notice}
        ${stakes}
        ${oursHTML}
        ${spotHTML}
        <p class="tkHint">金色があなたの事務所の四人です。</p>
        ${groups}
        ${resume ? '' : '<button type="button" class="tkGo" data-act="start">卓に着く</button>'}`;
      playEntrance();
    }

    /* ---------- 進行 ---------- */
    function renderRounds() {
      root.classList.remove('tkEnter', 'tkSkip');
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

      root.dataset.tier = run.tierId;
      root.innerHTML = `
        <div class="tkHead"><h1 class="tkTitle">${esc(run.tier.name)}</h1></div>
        ${blocks}
        <button type="button" class="tkGo" data-act="result">結果を見る</button>`;
    }

    /* ---------- 結果 ---------- */
    function renderResult() {
      root.classList.remove('tkEnter', 'tkSkip');
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
      root.dataset.tier = run.tierId;
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
    /* 復帰の控え（§6）。**`renderField` が一言を出すかどうかもこれで決まる** */
    let resume = null;

    /* **枠を組むときだけ疲労と調子を乗せる**（`office/spec.md` §9）。
       `teamCards()` そのものは素のまま——`finish()` の育成が
       `st.comp` を読み直すので二重に効かないが、表示にも使われているため。
       `Office` は「あれば使う」（単体ページでは素の子が出る） */
    function cardedOf(st) {
      return (c) => (typeof Office !== 'undefined' && Office.tableCardOf)
        ? Office.tableCardOf(st, c) : c;
    }

    function start(tierId) {
      const st = store.get();
      const carded = cardedOf(st);
      prepared = prepare(tierId, {
        team: teamCards().map((c) => (c.id === 0 ? c : carded(c))), pool: poolCards(),
        region: st.region || (teamCards()[1] || {}).region || null,
        recent: st.recent || [],
      });
      run = null;
      screen = 'field';
      renderField();
    }

    /* ---------- 復帰（`taikai/resume-spec.md` §6・§7） ----------
       **`prepare()` は呼ばない。**あれは乱数で `field` を組むので、
       呼ぶたびに違う顔ぶれになる。控えた `fieldIds` から引き直す
       ——`st` は大会中に一切書かれないので、**同じカードができる** */
    function rebuild(p) {
      const st = store.get();
      const carded = cardedOf(st);
      const byId = new Map();
      poolCards().forEach((c) => byId.set(c.id, c));
      /* チームは後から被せる（`start` と同じ——自分だけ素のまま） */
      teamCards().forEach((c) => byId.set(c.id, c.id === 0 ? c : carded(c)));
      const field = p.fieldIds.map((id) => byId.get(id) || null);
      if (field.some((c) => !c)) return null;
      return { tierId: p.tierId, tier: TOURNAMENTS[p.tierId], field, team: teamCards() };
    }

    /* **捨てる条件**（§7）。どれか一つでも当たれば false。
       当たったら黙って消して事務所へ——一言は出さない */
    function progressOk(p) {
      if (!p || typeof p !== 'object') return false;
      if (p.v !== 1) return false;
      if (!p.tierId || !TOURNAMENTS[p.tierId]) return false;
      if (!Array.isArray(p.fieldIds) || !p.fieldIds.length) return false;
      const all = new Set(ALL().map((c) => c.id).concat([0]));
      if (!p.fieldIds.every((id) => all.has(id))) return false;
      /* 自分と、いまのチーム全員が出走表にいること */
      const st = store.get();
      const ids = new Set(p.fieldIds);
      if (!ids.has(0)) return false;
      if (!(st.team || []).every((id) => ids.has(id))) return false;
      /* 回戦の形 */
      if (!Array.isArray(p.rounds)) return false;
      for (const r of p.rounds) {
        if (!r || typeof r !== 'object') return false;
        if (!Array.isArray(r.tables) || !r.tables.length) return false;
        if (!Array.isArray(r.results) || r.results.length !== r.tables.length) return false;
        for (const t of r.tables) {
          if (!Array.isArray(t) || !t.length) return false;
          if (!t.every((id) => ids.has(id))) return false;
        }
      }
      return true;
    }

    /* 控えを捨てて事務所へ（§6 の「諦める」と §7）。
       **`onDone` は通さない**——あれは大会が終わったことにして日数を消化するので、
       打っていないのに一日が過ぎる。ここは朝の事務所へ戻すだけ */
    function abandon() {
      store.set({ pendingTaikai: null });
      if (typeof Resume !== 'undefined') Resume.clear();
      resume = null;
      if (typeof store.go === 'function') { store.go('office'); return; }
      screen = 'select'; renderSelect();
    }

    /* 控えから始める。**「続ける」を押すまで進まない**（§6） */
    function startResume(p) {
      const built = rebuild(p);
      if (!built) { abandon(); return; }
      prepared = built;
      resume = p;
      run = null;
      screen = 'field';
      renderField();
    }

    /* 「卓に着く」を押してから対局に入る。
       自分の卓は実対局、他の卓は数値処理（taikai の runTournament が振り分ける） */
    async function playRounds() {
      root.innerHTML = `<p class="tkQuiet tkLoading">卓が立ちました…</p>`;
      /* **卓割りと結果が出るたびに控える**（§4 の 1〜4）。
         `store.set` は localStorage への同期の書き込みなので、
         次の対局に入る前に必ず残っている。
         `offerId` は控えに載せるだけ——`onDone` が事務所へ返すときに要る */
      const offerId = resume ? resume.offerId : (opts.offerId != null ? opts.offerId : null);
      run = await runTournament(prepared, {
        playRealMatch: store.playRealMatch,
        progress: resume || null,
        offerId,
        onProgress: (p) => { store.set({ pendingTaikai: p }); },
      });
      resume = null;               // ここから先は「続き」ではない
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
        /* **大会は終わった。控えは用済み**（§4・§5）。
           賞金を書いたのと**同じ `store.set`** で落とすこと——
           別々に書くと、あいだで落ちたときに「控えはあるが賞金は入っている」
           という、もう一度打てる状態が残る */
        pendingTaikai: null,
      });
      /* `Resume` の控えは別の localStorage キーなので、続けて落とす（§5） */
      if (typeof Resume !== 'undefined') Resume.clear();
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
        if (key === 'discard') store.set({ discardMode: val === 'double' ? 'double' : 'single' });
        if (key === 'sfx') {
          store.set({ sfxVolume: Number(val) });
          /* 設定の釦そのものが音の口。押した瞬間に試し鳴りする */
          if (typeof Sound !== 'undefined') {
            Sound.init(); Sound.volume(Number(val)); Sound.load().then(() => Sound.play('tap'));
          }
        }
        renderSelect();
        return;
      }
      /* **`button` に狭めること**（`field-spec.md` §4.1）。`root` 自身が
         `data-tier` を持つので、`[data-tier]` のままだと出走表のどこを押しても
         ここに落ち、`start()` が走って顔ぶれが引き直される */
      const tier = e.target.closest('button[data-tier]');
      if (tier && !tier.disabled) { start(tier.dataset.tier); return; }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'start') {
        /* 音の初期化はユーザー操作の中で（spec.md §2.2）。「卓に着く」がその口。
           Sound は index.html にしか無いので、あれば使う */
        if (typeof Sound !== 'undefined') {
          Sound.init(); Sound.volume(store.get().sfxVolume); Sound.load();
        }
        playRounds();
      }
      else if (act.dataset.act === 'resume') {
        /* 復帰の「続ける」（§6）。音の初期化は「卓に着く」と同じ扱い */
        if (typeof Sound !== 'undefined') {
          Sound.init(); Sound.volume(store.get().sfxVolume); Sound.load();
        }
        playRounds();
      }
      else if (act.dataset.act === 'abandon') abandon();
      else if (act.dataset.act === 'result') finish();
      else if (act.dataset.act === 'back') {
        /* 依頼から入ったときは、戻る先が事務所（大会選択の画面は無い） */
        if (opts.onDone) { opts.onDone(lastRun); return; }
        screen = 'select'; renderSelect();
      }
    });

    /* **落ちた大会の続き**（`taikai/resume-spec.md` §6・§7）。
       捨てる条件に当たったら**黙って消して事務所へ**——一言は出さない。
       古い控えを「再開しますか」と聞かれても意味が分からない */
    if (opts.resume) {
      if (progressOk(opts.resume)) startResume(opts.resume);
      else abandon();
    }
    /* 依頼から直行するときは、大会を選ぶ画面を出さない（§8.2） */
    else if (opts.tierId && TOURNAMENTS[opts.tierId]) start(opts.tierId);
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

  return { mount, prepare, runTournament, prizeFor, canEnter, ladderOf, pickSpotlight,
           PAYOUT, PLAYER_STRENGTH };
})();

if (typeof module !== 'undefined') module.exports = Taikai;
