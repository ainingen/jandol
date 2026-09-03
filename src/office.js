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
     assign      { [charaId]: 'parlor'|'trip'|'rest'|'job:<id>' }（§6.3）
     fatigue     { [charaId]: 0..100 }  **第五段で使う。いまは器だけ**
     cond        { [charaId]: -2..2 }   **第五段で使う。いまは器だけ**

   ------------------------------------------------------------
   配置（assign。spec.md §6.3）
   ------------------------------------------------------------
   全活動を同じ形に載せる器。**配置は変更するまで継続する**（毎朝聞かない）。

     parlor      店に立つ。既定。その内訳が雀荘のシフト（昼・夕・夜）
     rest        休み。シフトから外れる
     trip        遠征中（第三段）
     job:<id>    依頼中（第四段）

   **雀荘のシフトは `parlor.shifts` のまま。**事務所へ移したのはUIだけで、
   保存の形は変えていない（§6.3）。読み書きは `Jansou.shiftOf` /
   `Jansou.setShift` を通す。だから `Jansou.normalize()` には触れない。

   `assign` のほうは**最上位**（`parlor` の下ではない）。
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
        /* **人気は元データ + セーブの底上げ。**元データは書き換えない
           （アイドル活動で貯まる。§8.2） */
        pop: (base.pop || 0) + (((st.popUp || {})[id]) | 0),
      });
    }).filter(Boolean);
  }

  /* 雀荘の状態。`Jansou.normalize()` を通して読む（既定値をここで持たない） */
  function parlorOf(st) {
    return typeof Jansou !== 'undefined' ? Jansou.normalize(st.parlor) : null;
  }

  /* ------------------------------------------------------------
     配置（spec.md §6.3）— 純関数。テストの本体はここ
  ------------------------------------------------------------ */
  const ASSIGN_KINDS = ['parlor', 'trip', 'rest'];      // job:<id> は接頭辞で見る

  /* 一人ぶんの配置。**知らない値は `parlor` に落とす**（前方互換）。
     `trip` は `st.trip` が無ければ `parlor` に戻す——遠征の途中で
     セーブが壊れたり、遠征を実装する前のセーブを読んだときに、
     出勤者から永久に外れたままにならないように（§7.5・§13） */
  function assignFor(st, id) {
    const v = (st.assign || {})[id];
    if (typeof v !== 'string') return 'parlor';
    if (v.indexOf('job:') === 0) {
      /* 受けていない依頼の途中で止まっていたら戻す（第四段で offers が入る） */
      return (st.offerAccepted || []).indexOf(v.slice(4)) >= 0 ? v : 'parlor';
    }
    /* **生きている遠征かどうかで見る。**`st.trip` の有無だけで見ると、
       残り0日で置き去りになった trip が同行者を永久に出勤から外す */
    if (v === 'trip') return tripOf(st) ? 'trip' : 'parlor';
    return ASSIGN_KINDS.indexOf(v) >= 0 ? v : 'parlor';
  }

  /* 所属ぜんぶの配置。**必ず全員ぶんが埋まった表を返す**
     （呼ぶ側が「無ければ parlor」を各所で書かなくて済むように） */
  function assignOf(st) {
    const out = {};
    rosterOf(st).forEach((c) => { out[c.id] = assignFor(st, c.id); });
    return out;
  }

  /* 店に立てる子だけ。**遠征中・依頼中・休みは出勤可能者から外れる**（§6.3）。
     `jansou.js` の `prepareDay` がこれを通すので、出勤者が減れば
     `computeDay()` の入力が減る。**新しい項は足していない** */
  function parlorRoster(st, list) {
    return (list || rosterOf(st)).filter((c) => assignFor(st, c.id) === 'parlor');
  }

  /* 配置を書く。知らないキーは残す（§10） */
  function setAssign(store, id, kind) {
    const st = store.get();
    store.set({ assign: Object.assign({}, st.assign || {}, { [id]: kind }) });
  }

  /* ------------------------------------------------------------
     遠征（spec.md §7）— 純関数。テストの本体はここ
  ------------------------------------------------------------ */
  /* 日数と費用。**km ではなく遠さの段階（far）から出す**（§7.2）。
     数字を触るときはこの式一つで済む。第三段の終わりに再測して動かす。

       days = 2 + far                          2〜7日
       cost = SCOUT_COST × (1 + far) × (1 + 同行者数)

     京都から大阪へ代表ひとりなら SCOUT_COST（3万）・2日で、
     いままでの「一回3万」と桁が揃う。那覇へ同行3人なら 72万円・7日。

     **日数は移動ではなく滞在**（§4.3）。現実の移動時間に忠実にすると
     日本はどこでも1日で着いて距離の意味が消えるので、
     「その土地の雀荘をまわるのにかかる日数」と考える。

     **日当は別に足さない。**所属には毎日払っているので（契約基準・§6.3）、
     遠征が長引けばそのぶん自動でかかる。これが日数の本当のコスト（§7.2） */
  function planTrip(st, pref, purpose, members) {
    const home = st.officePref || null;
    const far = home && pref ? Geo.farBetween(home, pref) : 0;
    const n = (members || []).length;
    return {
      pref, purpose: purpose || 'find', far,
      days: 2 + far,
      /* **一回の費用の正は `Scout.SCOUT_COST` 一つだけ。**ここで数を書かない
         （README の対応表もそこを指している） */
      cost: Scout.SCOUT_COST * (1 + far) * (1 + n),
      members: (members || []).slice(),
    };
  }

  /* 留守を任せる子。**遠征中の子・休みの子は選ばない。**
     既定は「出勤者で comp 最大」（§7.4）。出勤者が一人もいなければ null。

     `exclude` は、これから遠征に連れて行く子（まだ assign に入っていない）。
     出発の画面で「同行者を選ぶ → 留守番が減る」を先に見せるために要る */
  function deputyOf(st, exclude) {
    const skip = new Set(exclude || []);
    const cand = parlorRoster(st).filter((c) => !skip.has(c.id));
    if (!cand.length) return null;
    return cand.slice().sort((a, b) => (b.comp || 0) - (a.comp || 0)
      || (b.pop || 0) - (a.pop || 0) || a.id - b.id)[0];
  }

  /* 遠征の状態。壊れていたら null（読む側が毎回これを通す） */
  function tripOf(st) {
    const t = st.trip;
    if (!t || typeof t !== 'object' || !t.pref || !Geo.prefOf(t.pref)) return null;
    if (!((t.dayLeft | 0) > 0)) return null;
    return t;
  }

  /* 遠征を組み立てる（まだセーブには書かない）。出発の釦が押せるかの判定つき */
  function tripStart(st, pref, purpose, members, target) {
    const p = planTrip(st, pref, purpose, members);
    const dep = deputyOf(st, members);
    return Object.assign(p, {
      target: target != null ? target : null,
      deputy: dep ? dep.id : null,
      dayLeft: p.days,
      log: [], found: [], signed: [],
      /* 留守中の店の合計。帰った日の夜にまとめて出す（§7.5） */
      store: { days: 0, guests: 0, sales: 0, profit: 0 },
    });
  }

  /* 発見の抽選。**雀ドルはまだ県を持たない**ので、当面その県の地方から引く
     （§4.4。200人に増員するときに県を振り、そこで絞る分岐を足す） */
  function regionOfPref(pref) {
    const p = Geo.prefOf(pref);
    return p ? p.region : null;
  }

  /* ------------------------------------------------------------
     届く依頼（spec.md §8）— 純関数の側
  ------------------------------------------------------------ */
  /* 朝に一度だけ発火させて `st.offers` に積む。**日付では発火しない**（§1.3）。
     `once` のものは `offerFired` に控えて二度と出さない。
     **戻り値は「積んだ件数」**。呼ぶ側は st を読み直すこと */
  function fireOffers(store, rng) {
    if (typeof Offers === 'undefined') return 0;
    const st = store.get();
    const add = Offers.fire(st, rosterOf(st), rng);
    if (!add.length) return 0;
    const fired = (st.offerFired || []).slice();
    add.forEach((o) => {
      const def = Offers.byId(o.id);
      if (def && def.once && fired.indexOf(o.id) < 0) fired.push(o.id);
    });
    store.set({ offers: (st.offers || []).concat(add), offerFired: fired });
    return add.length;
  }

  /* 見送る。**`once` でないものは、また条件を満たせば来る**（§8.1） */
  function dismissOffer(store, id) {
    const st = store.get();
    store.set({ offers: (st.offers || []).filter((o) => o.id !== id) });
  }

  /* その相手の課題を落とす。契約できたら用済み（`scout/spec.md` §5.2）。
     返すのは新しい `offers` の配列（純関数） */
  function dropQuest(st, charaId) {
    const q = typeof Offers !== 'undefined' ? Offers.questFor(charaId) : null;
    const open = (st.offers || []).slice();
    return q ? open.filter((o) => o.id !== q.id) : open;
  }

  /* 受ける。契約イベントは `offerAccepted` に入れるだけで、
     あとは遠征の「口説く」で会いに行く（§8.2）。
     大会とアイドル案件は、そのまま昼の仕事になる */
  function acceptOffer(store, id) {
    const st = store.get();
    const acc = (st.offerAccepted || []).slice();
    if (acc.indexOf(id) < 0) acc.push(id);
    store.set({ offerAccepted: acc, offers: (st.offers || []).filter((o) => o.id !== id) });
  }

  /* 人気の底上げ（アイドル活動で貯まる）。**元データは書き換えない。**
     `characters.js` の `pop` に、セーブの `popUp` を足して読む */
  function popOf(st, c) {
    return (c.pop || 0) + (((st.popUp || {})[c.id]) | 0);
  }

  /* アイドル案件の効き目（純関数・§8.2）。
     `chara`（性格19種）で向き不向き。向いていれば伸びが大きい。
     `match` の案件は、呼ぶ側が着順を渡す（`simulateTable` で確定させる） */
  function idolResult(def, members, places) {
    const p = def.payload;
    const out = { pay: p.pay, pop: {}, favor: {}, lines: [], won: false };
    members.forEach((c) => {
      const fits = p.fit.indexOf(c.chara) >= 0;
      let gain = fits ? p.pop : Math.max(1, Math.round(p.pop * 0.5));
      if (places && places[c.id] === 1) { gain += p.pop; out.won = true; }
      out.pop[c.id] = gain;
      out.favor[c.id] = p.favor;
      out.lines.push(`${c.name} … 人気 +${gain}${fits ? '（向いていた）' : ''}`
        + (places ? `・${places[c.id]}着` : ''));
    });
    /* 人数で割らない。**送った人数ぶん素直に伸びる**——
       少人数で回すか手広く出すかを、プレイヤーが選べるように */
    return out;
  }

  /* ------------------------------------------------------------
     遠征先の店（docs/design/scout/spec.md）— A4.5-1
  ------------------------------------------------------------ */
  /* その日の店を用意する。**朝に一度だけ引く**（`scout/spec.md` §6.2）。
     `shop.day !== parlor.day` を印にしているので、同じ朝を描き直しても
     顔ぶれは変わらない（依頼の発火が `firedFor` でやっているのと同じ形）。
     **滞在日ごとに引き直す**——同じ顔ぶれが5日続くと、一日目で見終わって
     残りが空になる。

     種は日と県から作る。**`ScoutShop.seeded` を通すこと**——
     線形合同法は隣り合う種の一手目がほとんど同じで、
     日をそのまま渡すと毎日同じ型の店が出る（実際に出た）。

     戻り値は「引き直したか」。呼ぶ側は st を読み直すこと */
  function ensureShop(store, trip, day) {
    if (typeof ScoutShop === 'undefined') return false;
    if (trip.shop && trip.shop.day === day) return false;
    const st = store.get();
    const prefIdx = Geo.PREFS.findIndex((p) => p.key === trip.pref);
    const rng = ScoutShop.seeded(day * 7919 + (prefIdx + 1) * 613 + (trip.days | 0));
    const shop = ScoutShop.buildShop(st, trip, rng);
    shop.day = day;
    store.set({ trip: Object.assign({}, trip, { shop }) });
    return true;
  }

  /* 声をかける（`scout/spec.md` §4.2）。
     **観察は無料、声をかけるのは一日3回まで。**
     残りが無ければ何もしない。ただの客に声をかけても回数は減る
     ——外したことが手応えとして返るように */
  function callOn(store, seatIdx) {
    const st = store.get();
    const trip = tripOf(st);
    const shop = trip && trip.shop;
    if (!shop || shop.calls <= 0) return null;
    const seat = shop.seats[seatIdx];
    if (!seat || shop.met.indexOf(seatIdx) >= 0) return null;

    const met = shop.met.concat(seatIdx);
    const calls = shop.calls - 1;
    let found = null;
    if (seat.charaId != null && (st.discovered || []).indexOf(seat.charaId) < 0) {
      found = JANDOLS.concat(FREE_AGENTS).find((c) => c.id === seat.charaId) || null;
    }
    const patch = { trip: Object.assign({}, trip, { shop: Object.assign({}, shop, { met, calls }) }) };
    if (found) patch.discovered = (st.discovered || []).concat(found.id);
    store.set(patch);
    return { found, calls, seat };
  }

  /* ------------------------------------------------------------
     雀エイト表（`office/spec.md` §9.1）— 第五段

     全国上位八人。**強さと人気の二軸**で、未契約の子も載る。
     自分の子を割り込ませていくのがゴール。

     **数値（疲労・調子）とは独立している。**ここは既にあるもの
     （`comp`・`pop`・`records`）を並べ替えて見せるだけで、
     新しいパラメータを作らない。だから第五段の中で先に作れる。
  ------------------------------------------------------------ */

  /* ライバル事務所。**地方ごとに一つ**（`REGIONS` と一対一）。
     引き抜きの主体として既に存在していることになっている（§9.1）ので、
     **雀ドルごとに所属を持たせない。**その子の地方の事務所に居ることにする。
     ——per-chara のデータを増やさずに「よそに居る」を出すための割り切り。
     移籍そのものの振る舞いは `ROADMAP.md` [F] */
  const RIVALS = {
    '北海道・東北': '雪原プロダクション',
    '関東': '銀座エイトプロ',
    '中部': '濃尾企画',
    '関西': '浪速麻雀社',
    '中国・四国': '瀬戸内エージェンシー',
    '九州・沖縄': '南風マネジメント',
  };
  /* フリー（`FREE_AGENTS`）はどこにも属さない。表では「フリー」と出す */
  function rivalOf(c) {
    if (typeof FREE_AGENTS !== 'undefined'
        && FREE_AGENTS.some((x) => x.id === c.id)) return 'フリー';
    return RIVALS[c.region] || 'フリー';
  }

  /* 大会実績の重み。**優勝だけを数える。**出ただけでは表に載らない */
  const TIER_POINT = { rookie: 5, local: 10, open: 18, title: 28, eight: 40 };
  const TITLE_CAP = 40;               // 事務所の実績が効く上限

  /* いまの級が背負っている実績。**NPC には戦績のデータが無い**ので、
     「すでにその級にいる」ことを実績の代わりに読む。
     `RANK_INFO` の label（S級＝雀エイト）と同じ考えかた */
  const RANK_TITLE = { S: 100, A: 72, B: 48, C: 28, D: 12 };

  /* 事務所が獲ったタイトル。**個々の子の戦績はセーブに無い**
     （`st.records` は事務所＝代表のもの）ので、所属は事務所の実績を共有する。
     子ごとの差は `comp` が付ける——**育てた子ほど上に来る**、という形 */
  function agencyTitle(st) {
    const rec = st.records || {};
    let p = 0;
    Object.keys(TIER_POINT).forEach((t) => {
      if (rec[t] && rec[t].best === '優勝') p += TIER_POINT[t];
    });
    /* 雀エイト級を大会で沈めた数も少しだけ */
    p += Math.min(8, (st.beaten || []).length) * 2;
    return Math.min(TITLE_CAP, p);
  }

  /* その子自身の大会戦績（`st.wins`。`office/spec.md` §9.1）。
     **記録があればこちらを優先する。**無ければ事務所単位に落ちる
     ——記録は A5 から始めたので、それ以前のセーブには何も無い */
  function charaTitle(st, id) {
    const w = (st.wins || {})[id];
    if (!w) return null;
    let p = 0;
    Object.keys(w).forEach((t) => {
      const pt = TIER_POINT[t];
      if (!pt) return;
      if (w[t].win > 0) p += pt;
      else if (w[t].place > 0) p += pt * 0.4;     // 入賞は優勝の四割
    });
    return Math.min(TITLE_CAP, p);
  }

  /* 実績の点。所属（と自分）だけが上乗せを持てる。
     **子ごとの記録があればそれを、無ければ事務所の実績を**（§9.1） */
  function titleScore(c, st, mine) {
    const base = RANK_TITLE[c.rank] || 12;
    if (!mine) return base;
    const own = (typeof Tournament !== 'undefined' && Tournament.hasRecord
      && Tournament.hasRecord(st.wins, c.id)) ? charaTitle(st, c.id) : null;
    return base + (own == null ? agencyTitle(st) : own);
  }

  /* 実力点。**`strengthOf`（comp と打ち筋）と実績の配合。**
     配合は 6:4。`strengthOf` だけで並べると A級が最初から
     S級を三人抜いてしまい、「S級＝雀エイト」（`RANK_INFO` の label）が
     初日から崩れる。実績を四割乗せると、**始まりは八人の S級**になる */
  const POWER_MIX = { strength: 0.6, title: 0.4 };
  function mightOf(c, st, mine) {
    const sOf = (typeof Tournament !== 'undefined' && Tournament.strengthOf)
      || (typeof strengthOf === 'function' ? strengthOf : null);
    const base = sOf ? sOf(compFor(c, st), typeof STYLES !== 'undefined' ? STYLES : {}) : 50;
    return base * POWER_MIX.strength + titleScore(c, st, mine) * POWER_MIX.title;
  }

  /* 雀エイトの順位。**強さと人気の二軸**（§9.1）。

     **足し算にしない。**足すと「強いが無名」「有名だが弱い」がどちらも
     入ってしまい、二軸である意味が消える。掛け合わせ（コブ＝ダグラス型）に
     すると**両方が要る**——人気0なら実力100でも0になる。

     指数は 6:4。実測で確かめた（`tools/test-office.js` が固定している）:
       0.6 / 0.4 … 始まりは S級八人。九位は人気85のA級（嵐山ことね）が僅差
       0.5 / 0.5 … **A級が二人入って S級八人が崩れる**
       0.7 / 0.3 … S級八人は保つが、人気の効きが薄くなる

     アイドル活動（`popUp`）がここに繋がる。**育てるだけでは八人に入れない。** */
  const FAME_MIX = { might: 0.6, fame: 0.4 };
  function powerOf(c, st, mine) {
    const might = mightOf(c, st, mine);
    const fame = popOf(st, c);
    if (might <= 0 || fame <= 0) return 0;
    return Math.pow(might, FAME_MIX.might) * Math.pow(fame, FAME_MIX.fame);
  }

  /* セーブの `comp` を被せた写し。**元データは書き換えない**
     （`popOf` が `pop` でやっているのと同じ作法） */
  function compFor(c, st) {
    const v = (st.comp || {})[c.id];
    return v == null ? c : Object.assign({}, c, { comp: v });
  }

  /* 雀エイト表（純関数）。強さの順に八人。
     **未契約の子も載る。**同点は id で固定して、毎朝並びが揺れないように */
  const EIGHT_N = 8;
  function eightTable(st) {
    const all = JANDOLS.concat(FREE_AGENTS);
    const mineSet = new Set((st.contracted || []));
    const rows = all.map((c) => {
      const mine = mineSet.has(c.id);
      const withComp = compFor(c, st);
      return {
        id: c.id, name: c.name, rank: c.rank, region: c.region,
        /* **二軸は別々に持つ。**表でも別の欄に出す（§9.1） */
        pop: popOf(st, c),
        might: mightOf(c, st, mine),
        comp: withComp.comp == null ? compFromRank(c.rank) : withComp.comp,
        power: powerOf(c, st, mine),
        mine,
        agency: mine ? nameOf(st) : rivalOf(c),
      };
    });
    rows.sort((a, b) => b.power - a.power || b.pop - a.pop || a.id - b.id);
    return rows.slice(0, EIGHT_N).map((r, i) => Object.assign(r, { place: i + 1 }));
  }

  /* 自分の所属のうち、表に載っていない先頭の子と、八位との差。
     **「あと何点で入れるか」**を出すため（表だけだと遠さが分からない） */
  function eightNext(st) {
    const table = eightTable(st);
    if (table.some((r) => r.mine)) return null;      // もう入っている
    const eighth = table[table.length - 1];
    const mine = (st.contracted || []).map((id) =>
      JANDOLS.concat(FREE_AGENTS).find((c) => c.id === id)).filter(Boolean);
    if (!mine.length || !eighth) return null;
    const best = mine.map((c) => ({ c, p: powerOf(c, st, true) }))
      .sort((a, b) => b.p - a.p)[0];
    return { name: best.c.name, gap: eighth.power - best.p };
  }

  /* ------------------------------------------------------------
     交渉（`scout/spec.md` §5）— A4.5-3
  ------------------------------------------------------------ */
  /* 会いに行った一回で積む好感度（§5.1 の 5）。
     **勝っても負けても積む。**空手で帰らせないため——
     負けが永久の失敗にならないのが第三段からの決めごと */
  const FAVOR_GAIN = { win: 12, lose: 5 };
  function favorGain(won) { return won ? FAVOR_GAIN.win : FAVOR_GAIN.lose; }

  /* 好感度を足した新しい表を返す（純関数）。上限100 */
  function addFavor(st, charaId, won) {
    const base = ((st.favor || {})[charaId]) | 0;
    return Object.assign({}, st.favor || {},
      { [charaId]: Math.min(100, base + favorGain(won)) });
  }

  /* 交渉の一行。**「性格の一言」＋「既存の `detail`」の合成**（§5.4）。

     **条件文をここに書かないこと。**「事務所ランク5が必要です」は
     `scout.js` の `RULES` が `detail` に持っている。ここに書き写すと
     二重になり、片方を直したときに必ずずれる
     （`RULES.event` で一度通った話。`office/spec.md` §8.2）。

     `line` は `SERIFU.pick(chara, 'scoutWin')`。無ければ空でよい */
  function negotiate(chara, verdict, line) {
    const v = verdict || {};
    return {
      name: chara ? chara.name : '',
      line: line || '',
      ok: !!v.ok,
      /* **`v.detail` をそのまま。**加工も言い換えもしない */
      detail: v.ok ? '' : (v.detail || ''),
      cost: v.cost != null ? v.cost : null,
    };
  }

  /* ------------------------------------------------------------
     疲労と調子（spec.md §9）— **第五段で数値を置く。いまは器だけ。**
     フィールドを先に切っておくのは、セーブの前方互換を保つため
     （あとから足しても、既存セーブは既定値の0で読める）
  ------------------------------------------------------------ */
  function fatigueOf(st, id) {
    const v = (st.fatigue || {})[id];
    return typeof v === 'number' ? Math.min(100, Math.max(0, v)) : 0;
  }
  function condOf(st, id) {
    const v = (st.cond || {})[id];
    return typeof v === 'number' ? Math.min(2, Math.max(-2, Math.round(v))) : 0;
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
    /* 遠征の下書き（出発するまでセーブに書かない） */
    let draft = null;
    /* 夜に出す、その日ぶんの控え。店が無い日だけ使う（日当の額）。
       `parlor.log` は {day, guests, sales, profit} しか持たないため */
    let night = null;
    /* 依頼を発火させた日の印（同じ朝を描き直しても増やさないため） */
    let firedFor = null;
    /* 遠征先の店。**画面を描き直すたびに作り直すので、前のを必ず止める**
       （`idle()` は rAF を回しっぱなしにする） */
    let shopCtl = null;
    let shopNote = '';
    /* 見つけた子の「癖はこの打ち筋だった」の一言（`scout/spec.md` §4.4 の末尾）。
       **観察の報酬を言葉にするためだけのもの**で、判定には効かない */
    let shopTell = '';
    /* 見つけた子。**シルエットが顔に変わるのはここ。**
       床のスプライトはドット絵なので、写真は札で出す */
    let shopFound = null;

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
      /* **朝の依頼発火（§8.1）。**日が変わったときに一度だけ引く。
         `parlor.day` を印にしているので、同じ朝を描き直しても増えない。
         **日付で発火条件を書いているわけではない**（§1.3）——
         「いつ引くか」の印であって、「何が届くか」は `when` が状態だけで決める */
      const p0 = parlorOf(store.get());
      const mark = (p0 ? p0.day : 0);
      if (firedFor !== mark) { firedFor = mark; fireOffers(store); }
      /* 遠征中なら、その日の店を用意する（scout/spec.md §6.2） */
      const t0 = tripOf(store.get());
      if (t0 && ensureShop(store, t0, mark)) { shopNote = ''; shopFound = null; shopTell = ''; }
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
         office.css の `.ofMate .mkFace` がそれを戻している。

         第二段で**配置（店・休み）とシフト（昼・夕・夜）を同じ行に**載せた
         （spec.md §6.3）。シフトの保存先は `parlor.shifts` のままで、
         書くのは `Jansou.setShift`。**データは移していない。** */
      const assign = assignOf(st);
      const trip = tripOf(st);

      /* 遠征先の店（scout/spec.md §3）。**静止した一枚。**
         一日を再生しない。動くのは乱数を使わない常時アニメだけ */
      const shop = trip && trip.shop;
      const shopHtml = shop ? `
        <h2 class="ofSecT">${esc(shop.name)}
          <span class="ofSecNote">${esc((ScoutShop.TYPE_BY_KEY[shop.type] || {}).name || '')}</span></h2>
        <p class="ofNote" style="margin:0 0 6px">
          見るのはただ。<b>声をかけられるのは今日あと ${shop.calls} 回。</b>
          客をタップすると声をかけます（外しても一回使います）。</p>
        <div id="ofShopHost" class="ofShop"></div>
        ${shopFound ? `
          <div class="ofShopFound">
            <span class="mkFace sil"><img src="img/${pad3(shopFound.id)}.webp" alt=""
              onerror="this.remove()"></span>
            <span class="ofShopFoundBody">
              <span class="ofShopFoundName">${esc(shopFound.name)}
                <i>${esc(shopFound.rank)}級</i></span>
              <span class="ofShopFoundSub">${esc(STYLES[shopFound.style].name)}　${esc(shopFound.region)}</span>
              ${shopTell ? `<span class="ofShopFoundTell">${esc(shopTell)}</span>` : ''}
              <span class="ofShopFoundCopy">「${esc(shopFound.copy)}」</span>
            </span>
          </div>` : ''}
        ${shopNote ? `<p class="ofNote ofShopNote">${esc(shopNote)}</p>` : ''}` : '';

      /* 雀エイト表（§9.1）。**事務所の壁に貼ってある**という体で、
         朝の画面に一枚だけ出す。押せるものは無い（見るだけ）。
         `eightTable` は純関数なので、ここは並べるだけ */
      const eight = eightTable(st);
      const next = eightNext(st);
      const eightHtml = `
        <h2 class="ofSecT">雀エイト<span class="ofSecNote">全国上位八人</span></h2>
        <div class="ofEight">${eight.map((r) => `
          <div class="ofEightRow${r.mine ? ' mine' : ''}">
            <span class="ofEightNo">${r.place}</span>
            <span class="mkFace sil"><img src="img/${pad3(r.id)}.webp" alt=""
              onerror="this.remove()"></span>
            <span class="ofEightBody">
              <span class="ofEightName">${esc(r.name)}<i>${esc(r.rank)}級</i></span>
              <span class="ofEightSub">${esc(r.agency)}</span>
            </span>
            <span class="ofEightNums">
              <span>実力 <b>${Math.round(r.might)}</b></span>
              <span>人気 <b>${r.pop}</b></span>
            </span>
          </div>`).join('')}</div>
        <p class="ofNote">${next
          ? `いちばん近いのは <b>${esc(next.name)}</b>。八位まであと ${Math.ceil(next.gap)} 点。`
              + '<b>実力と人気の両方</b>が要る——育てて大会で勝ち、'
              + 'アイドル活動で人気を上げること。'
          : eight.some((r) => r.mine)
            ? '<b>うちの子が入っている。</b>'
            : '所属が増えると、ここに割り込む相手が見えてくる。'}</p>`;

      /* 届いている依頼（§8）。遠征中は受けられない（代表が留守なので、
         大会も相談も動かせない）。見送るのはいつでもできる */
      const offers = (st.offers || []);
      const offersHtml = offers.length ? `
        <h2 class="ofSecT">届いている話<span class="ofSecNote">${offers.length}件</span></h2>
        <div class="ofOffers">${offers.map((o) => {
          const def = Offers.byId(o.id);
          if (!def) return '';
          const need = def.members.max
            ? `${def.members.min === def.members.max ? def.members.min
                : def.members.min + '〜' + def.members.max}人` : '人手は要らない';
          return `<div class="ofOffer k-${def.kind}">
            <div class="ofOfferHead">
              <span class="ofOfferT">${esc(Offers.titleOf(o))}</span>
              <span class="ofOfferMeta">${def.days ? def.days + '日' : '日は使わない'}・${need}</span>
            </div>
            <p class="ofOfferText">${esc(Offers.textOf(o, st, list))}</p>
            <div class="ofOfferBtns">
              ${def.kind === 'quest' ? '' : `
                <button type="button" class="ofTake" data-take="${o.id}"
                  ${trip ? 'disabled' : ''}>受ける</button>`}
              <button type="button" class="ofPass" data-pass="${o.id}">${
                def.kind === 'quest' ? '忘れる' : '見送る'}</button>
            </div>
            ${def.kind === 'quest'
              ? '<p class="ofNote" style="margin:4px 0 0">条件が揃ったら、もう一度会いに行くこと。</p>'
              : trip ? '<p class="ofNote" style="margin:4px 0 0">遠征から帰るまで受けられません。</p>' : ''}
          </div>`;
        }).join('')}</div>` : '';
      const mates = list.length ? list.map((c) => {
        const kind = assign[c.id];
        const at = kind === 'parlor';
        const sh = Jansou.shiftOf(parlor, c.id);
        /* 遠征中・依頼中は第三段・第四段。いまは店と休みだけが選べる */
        const busy = kind === 'trip' || kind.indexOf('job:') === 0;
        const chips = Jansou.SLOTS.map((sl) => `
          <button type="button" class="ofChip${at && sh[sl.key] ? ' on' : ''}"
            data-shift="${c.id}" data-slot="${sl.key}" ${at ? '' : 'disabled'}
            aria-pressed="${!!(at && sh[sl.key])}">${sl.name}</button>`).join('');
        return `
        <div class="ofMate${at ? '' : ' off'}">
          <span class="mkFace sil"><img src="img/${pad3(c.id)}.webp" alt="" loading="lazy"
            onerror="this.remove()"></span>
          <span class="ofMateBody">
            <span class="ofMateName">${esc(c.name)}</span>
            <span class="ofMateSub">${esc(c.rank)}級　完成度 ${c.comp}　日当 ${yen(Jansou.wageOf(c))}</span>
            <span class="ofMateShift">${busy
              ? `<span class="ofBusy">${kind === 'trip' ? '遠征中' : '依頼中'}</span>`
              : `<button type="button" class="ofWhere" data-where="${c.id}"
                   aria-pressed="${at}">${at ? '店' : '休み'}</button>${chips}`}</span>
          </span>
          <span class="ofMateNums">
            <span class="ofNum">人気 <b>${c.pop}</b></span>
            <span class="ofNum${c.favor ? ' on' : ''}">好感度 <b>${c.favor}</b></span>
          </span>
        </div>`;
      }).join('')
        : '<p class="ofEmpty">まだ誰も所属していません。チーム編成から始めてください。</p>';

      /* 出勤の人数。**配置が店で、なおかつシフトが一つでも入っている子**。
         `prepareDay` の `dayWorkers` と同じ数え方にすること（ずれると嘘になる） */
      const onDuty = list.filter((c) => assign[c.id] === 'parlor'
        && Jansou.shiftOf(parlor, c.id).some(Boolean));

      /* 昼の釦。**店が無くても日は進む**（office/spec.md §1.2）。
         店があれば雀荘へ降り、無ければ事務所の中で夜へ抜ける */
      const open = !!(parlor && parlor.open);
      const wages = list.reduce((a, c) => a + Jansou.wageOf(c), 0);
      let action;
      if (trip) {
        const p = Geo.prefOf(trip.pref);
        const dep = trip.deputy != null ? list.find((c) => c.id === trip.deputy) : null;
        action = `<button type="button" class="ofRunBtn" id="ofRun">今日を始める</button>
          <p class="ofNote"><b>${esc(p.name)}に遠征中。</b>あと ${trip.dayLeft} 日。
            ${trip.purpose === 'woo' ? '口説きに来ています。' : '雀荘をまわっています。'}<br>
            下の店を見て、めぼしい客に声をかけること。<br>
            ${open ? (dep ? `留守は ${esc(dep.name)} に任せています。` : '留守を任せた子がいません。')
              : '店はまだありません。'}
            ${open ? '<br>代表がいないので、夜に自分の卓は出せません。' : ''}</p>`;
      } else if (!list.length) {
        action = `<button type="button" class="ofRunBtn" disabled>今日を始める</button>
          <p class="ofNote">まだ誰も所属していません。チーム編成から始めてください。</p>`;
      } else if (open) {
        action = `<button type="button" class="ofRunBtn" id="ofRun" ${canRun ? '' : 'disabled'}>
            今日を始める</button>
          <p class="ofNote">${day + 1}日目の営業に降ります。
            出勤は ${onDuty.length} 人。設備は雀荘の画面から。</p>`;
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

        <h2 class="ofSecT">所属と今日の配置</h2>
        ${list.length ? `<p class="ofNote" style="margin:0 0 8px">
          <b>配置は変えるまで続きます。</b>毎朝きき直しません。
          ${open ? `いま店に立つのは ${onDuty.length} 人。` : ''}</p>` : ''}
        <div class="ofMates">${mates}</div>

        ${shopHtml}
        ${offersHtml}
        ${eightHtml}

        <h2 class="ofSecT">出かける</h2>
        ${trip ? '' : `<button type="button" class="ofRunBtn ghost" id="ofTrip"
          ${list.length ? '' : 'disabled'} style="margin-bottom:8px">遠征に出る</button>
          <p class="ofNote" style="margin:0 0 10px">全国の雀荘を歩いて見つけ、その場で口説く。
            出ているあいだ代表は店に降りられません。</p>`}
        <div class="ofDoors">
          ${door('jansou', '雀荘', '営業と設備、シフト')}
          ${door('scout', 'スカウト', '雀荘をまわって発掘する')}
          ${door('taikai', '大会', '賞金と名声を取りに行く')}
          ${door('team', 'チーム', '出場する三人を組む')}
          ${door('meikan', '名鑑', '見つけた雀ドルを見る')}
        </div>
        <p class="ofNote">スカウトと大会は、いまはまだ日を消費しません。</p>`;

      /* 配置の切り替え（店 ⇄ 休み）。遠征と依頼は第三段・第四段 */
      root.querySelectorAll('[data-where]').forEach((b) => {
        b.addEventListener('click', () => {
          const id = +b.dataset.where;
          setAssign(store, id, assignFor(store.get(), id) === 'parlor' ? 'rest' : 'parlor');
          render();
        });
      });
      /* シフトの切り替え。**書くのは `Jansou.setShift` 一つだけ。**
         雀荘の単体ページと同じ関数を通るので、既定値の解釈が割れない */
      root.querySelectorAll('[data-shift]').forEach((b) => {
        b.addEventListener('click', () => {
          const slot = +b.dataset.slot;
          const sh = Jansou.setShift(store, +b.dataset.shift, slot);
          b.classList.toggle('on', sh[slot]);
          b.setAttribute('aria-pressed', String(!!sh[slot]));
        });
      });

      /* 依頼を受ける／見送る（§8.1） */
      root.querySelectorAll('[data-pass]').forEach((b) => b.addEventListener('click', () => {
        dismissOffer(store, b.dataset.pass);
        render();
      }));
      root.querySelectorAll('[data-take]').forEach((b) => b.addEventListener('click', () => {
        if (b.disabled) return;
        takeOffer(b.dataset.take);
      }));

      mountShop(root, shop);

      const goTrip = root.querySelector('#ofTrip');
      if (goTrip) goTrip.addEventListener('click', () => {
        draft = { pref: null, purpose: 'find', members: [], target: null };
        screen = 'trip';
        render();
      });

      const run = root.querySelector('#ofRun');
      if (run) run.addEventListener('click', () => {
        /* 遠征中は昼を雀荘へ委譲しない。**日ごとの再生はしない**（§7.5）。
           留守の店を裏で回し、遠征の出来事を一つ進めて夜へ */
        if (trip) { runTripDay(); return; }
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

    /* ---------- 依頼を受ける（spec.md §8.2） ----------
       kind ごとに行き先が違う。

         contract  … `offerAccepted` に入れるだけ。**日は消費しない。**
                     あとは遠征の「口説く」で会いに行く（§7.3）
         tournament… 大会の画面へ降りる。終わったら日数ぶんを消化して夜へ
         idol      … 演出は作らない（§8.2）。裏で確定させて日報一行だけ

       **大会もアイドルも、そのあいだ代表は店に降りられない。**
       日数ぶんの店は `runAwayDay`（留守の日）で回す */
    async function takeOffer(id) {
      const def = Offers.byId(id);
      if (!def) return;
      const st0 = store.get();

      if (def.kind === 'contract') {
        acceptOffer(store, id);
        const c = JANDOLS.concat(FREE_AGENTS).find((x) => x.id === def.payload.charaId);
        night = { offer: { title: Offers.titleOf({ id }),
          lines: [c ? `${c.name}に会いに行けるようになった。` : '話を受けた。',
                  c ? `${c.region}へ遠征して「口説く」を選ぶこと。` : ''],
          noDay: true } };
        screen = 'night';
        render();
        return;
      }

      if (def.kind === 'tournament') {
        acceptOffer(store, id);
        /* 大会の画面へ降りる。終わったら `onDone` で戻ってくる */
        if (typeof store.goTaikai === 'function') {
          /* **結果は opts で受け取る。**画面を替えるとここは組み直されるので、
             閉包に控えた関数は宙に浮く（`shell.html` の goTaikai を見ること） */
          store.goTaikai(def.payload.tierId, id);
        } else {
          /* 単体ページには行き先が無いので、日数ぶんだけ消化する */
          afterTournament(def, null);
        }
        return;
      }

      /* --- アイドル案件（§8.2） --- */
      acceptOffer(store, id);
      const list = rosterOf(st0);
      /* 送るのは**向いている子から**。プレイヤーに選ばせる画面は作らない
         （演出を作らないのと同じ理由で、ここは軽く済ませる） */
      const p = def.payload;
      const cand = parlorRoster(st0, list).slice().sort((a, b) => {
        const fa = p.fit.indexOf(a.chara) >= 0 ? 1 : 0;
        const fb = p.fit.indexOf(b.chara) >= 0 ? 1 : 0;
        return fb - fa || (b.comp || 0) - (a.comp || 0);
      });
      const members = cand.slice(0, Math.max(def.members.min, Math.min(def.members.max, cand.length)));
      if (members.length < def.members.min) {
        night = { offer: { title: Offers.titleOf({ id }),
          lines: ['送れる子がいなかった。'], noDay: true } };
        screen = 'night';
        render();
        return;
      }

      /* 対局付きの案件は `simulateTable` で確定させる（§8.2） */
      let places = null;
      if (p.match) {
        const table = members.slice(0, 1);
        for (let i = table.length; i < 4; i++) {
          table.push({ id: 9600 + i, name: 'ファン', guest: true, comp: 30 + i * 6,
                       style: members[0].style, pop: 0, salary: 0, rank: 'D' });
        }
        places = {};
        simulateTable(table, STYLES).forEach((r) => { places[r.chara.id] = r.place; });
      }

      const res = idolResult(def, members, places);
      const st = store.get();
      const popUp = Object.assign({}, st.popUp || {});
      const favor = Object.assign({}, st.favor || {});
      Object.keys(res.pop).forEach((k) => { popUp[k] = (popUp[k] | 0) + res.pop[k]; });
      Object.keys(res.favor).forEach((k) => {
        favor[k] = Math.min(100, (favor[k] || 0) + res.favor[k]);
      });
      store.set({ money: (st.money || 0) + res.pay, popUp, favor });

      /* セリフを一言だけ（§8.2「日報一行とセリフだけ」） */
      const say = typeof LINES !== 'undefined'
        ? (LINES[members[0].chara] || {}) : {};
      const line = (say.idle || say.start || [])[0] || null;

      await runJobDays(def, res.lines.concat(
        [`報酬 ${yen(res.pay)}`, res.won ? '勝って話題になった' : null,
         line ? `${members[0].name}「${line}」` : null].filter(Boolean)),
        Offers.titleOf({ id }), members.map((c) => c.id));
    }

    /* 大会から帰ってきたところ。日数ぶんを消化して夜へ */
    function afterTournament(def, res) {
      const lines = res
        ? [`${res.tierName}：${res.best}`, `賞金 ${yen(res.prize)}`,
           res.promoted ? `${res.promoted}級に昇段した` : null].filter(Boolean)
        : ['大会に出た'];
      /* 大会に出るのは既存のチーム編成（§8.2）。そのあいだ店には立てない */
      runJobDays(def, lines, Offers.titleOf({ id: def.id }), (store.get().team || []).slice());
    }

    /* 依頼の拘束日数ぶん、店を回して日を進める。
       **代表は依頼に出ているので、留守の日として回す**（§7.4 と同じ扱い）。
       日ごとの再生はしない。夜にまとめて出す */
    async function runJobDays(def, lines, title, busyIds) {
      const acc = { days: 0, guests: 0, sales: 0, profit: 0 };
      const busy = busyIds || [];
      for (let i = 0; i < (def.days || 0); i++) {
        const st = store.get();
        const list = rosterOf(st);
        const parlor = parlorOf(st);
        if (parlor.open) {
          /* 仕事に出ている子は留守番にも選ばない */
          const dep = deputyOf(st, busy);
          const r = Jansou.runAwayDay(store, list, dep || null, busy);
          acc.days += 1;
          acc.guests += r.plan.day.guests;
          acc.sales += r.plan.day.sales;
          acc.profit += r.out.profit;
        } else {
          Jansou.runClosedDay(store, list);
          acc.days += 1;
        }
      }
      night = { offer: { title, lines, store: def.days ? acc : null, noDay: !def.days } };
      screen = 'night';
      render();
    }

    /* ---------- 遠征先の店を差し込む（scout/spec.md §3） ----------
       `JansouFloor` の描画をそのまま借りる。渡すのは

         title  店の名前
         bare   速度・スキップの帯を作らない（よその店に要らない）
         pal    壁・床・卓の三色だけ差し替えたパレット（**浅いマージ**）

       `render(state)` で一枚描き、`idle(hooks)` で時計だけ進める。
       **タイムラインは持たない。一日を再生しない**（§3.1）。 */
    function mountShop(host, shop) {
      const el = host.querySelector('#ofShopHost');
      if (!el || !shop || typeof JansouFloor === 'undefined') return;
      shopCtl = JansouFloor.mount(el, {
        title: shop.name, bare: true, pal: ScoutShop.palOf(shop.type),
      });
      shopCtl.render(ScoutShop.stateOf(shop, store.get()));
      shopCtl.idle({ onGuestTap: (g) => onShopTap(g) });
    }

    /* 客をタップ＝声をかける（§4.2）。
       **未発見の雀ドルなら発見**、ただの客なら何も起きない。
       どちらでも一回は使う——外したことが手応えとして返るように */
    function onShopTap(g) {
      const st = store.get();
      const trip = tripOf(st);
      const shop = trip && trip.shop;
      if (!shop) return;
      const seat = ScoutShop.seatOfGuestId(shop, g.guestId);
      if (!seat) return;
      const idx = shop.seats.indexOf(seat);
      if (shop.calls <= 0) {
        shopNote = '今日はもう声をかけられない。明日また来よう。';
        render();
        return;
      }
      if (shop.met.indexOf(idx) >= 0) {
        shopNote = 'その人にはもう声をかけた。';
        render();
        return;
      }
      const r = callOn(store, idx);
      if (!r) return;
      shopFound = r.found || null;
      shopTell = r.found ? tellOf(r.seat, r.found) : '';
      shopNote = r.found
        ? `${r.found.name} を見つけた。名鑑に載った。　あと ${r.calls} 回`
        : `ただの客だった。　あと ${r.calls} 回`;
      /* 見つけたら遠征の記録にも残す（帰った日の夜にまとめて出る） */
      if (r.found) {
        const st2 = store.get();
        const t2 = tripOf(st2);
        if (t2) {
          store.set({ trip: Object.assign({}, t2, {
            log: t2.log.concat(`${Geo.prefOf(t2.pref).name}の${shop.name}で ${r.found.name}（${r.found.rank}級）に声をかけた`),
            found: t2.found.concat(r.found.id),
          }) });
        }
      }
      render();
    }

    /* 「あの癖はこの打ち筋だった」の一言（`scout/spec.md` §4.4）。
       **札に出る打ち筋そのものは変えない。**観察が当たっていたことを
       言葉にして添えるだけ——見てから押した人にだけ意味が出る。

       先頭の癖が**打ち筋から来たほう**（`ScoutShop.quirksFor` が
       そう並べている）。二つめは系統を埋めるためのものなので使わない */
    function tellOf(seat, found) {
      const q = ((seat && seat.quirk) || [])[0];
      const def = q && ScoutShop.QUIRK_BY_KEY[q];
      const style = found && STYLES[found.style];
      if (!def || !style) return '';
      return `${def.tell}、${style.name}だったから。`;
    }

    /* ---------- 遠征に出る（spec.md §7.1） ---------- */
    function renderTrip() {
      const st = store.get();
      const list = rosterOf(st);
      const home = Geo.prefOf(st.officePref);
      const p = draft.pref ? planTrip(st, draft.pref, draft.purpose, draft.members) : null;
      const dep = deputyOf(st, draft.members);
      const money = st.money || 0;

      /* 口説く相手。**発見済みで未契約の子**だけ。当面はその県の地方から
         （雀ドルはまだ県を持たない。§4.4） */
      const region = draft.pref ? regionOfPref(draft.pref) : null;
      const all = JANDOLS.concat(FREE_AGENTS);
      const targets = (st.discovered || [])
        .filter((id) => !(st.contracted || []).includes(id))
        .map((id) => all.find((c) => c.id === id))
        .filter((c) => c && (!region || c.region === region));

      const chips = REGIONS.map((r) => `<div class="ofPrefGroup">
        <span class="ofPrefRegion">${esc(r)}</span>
        <div class="ofPrefChips">${Geo.prefsOf(r).map((q) => {
          const f = Geo.farBetween(st.officePref, q.key);
          return `<button type="button" class="ofPref${draft.pref === q.key ? ' on' : ''}"
            data-dest="${q.key}">${esc(q.name)}<i>${f}</i></button>`;
        }).join('')}</div></div>`).join('');

      const mates = list.filter((c) => assignFor(st, c.id) !== 'trip').map((c) => {
        const on = draft.members.indexOf(c.id) >= 0;
        const full = !on && draft.members.length >= 3;
        return `<button type="button" class="ofMateChip${on ? ' on' : ''}"
          data-mate="${c.id}" ${full ? 'disabled' : ''}>${esc(c.name)}</button>`;
      }).join('');

      root.innerHTML = `
        <div class="ofHead">
          <h1 class="ofTitle">遠征に出る</h1>
          <p class="ofSub">${esc(home ? home.name : '')} を出て、その土地の雀荘をまわる</p>
        </div>

        <h2 class="ofSecT">行き先</h2>
        <p class="ofNote" style="margin:0 0 8px">数字は本拠地からの遠さ（0〜5）。
          <b>遠いほど滞在が長く、費用も上がります。</b>
          長いぶん多く引けるのが遠くの利点です。</p>
        <div class="ofPrefs">${chips}</div>

        <h2 class="ofSecT">目的</h2>
        <div class="ofPrefChips">
          <button type="button" class="ofPref${draft.purpose === 'find' ? ' on' : ''}"
            data-purpose="find">探す</button>
          <button type="button" class="ofPref${draft.purpose === 'woo' ? ' on' : ''}"
            data-purpose="woo" ${targets.length ? '' : 'disabled'}>口説く</button>
        </div>
        ${draft.purpose === 'find'
          ? '<p class="ofNote">一日ひとりずつ、その地方の雀ドルを探します。</p>'
          : `<p class="ofNote">着いた日に現地で一局打ちます。
              <b>相手より上の着順で終われば勝ち。</b>勝てば契約の話に進み、
              負けても好感度は少し上がります。何度でも挑めます。</p>
            <div class="ofPrefChips">${targets.length ? targets.map((c) =>
              `<button type="button" class="ofPref${draft.target === c.id ? ' on' : ''}"
                data-target="${c.id}">${esc(c.name)}<i>${esc(c.rank)}</i></button>`).join('')
              : '<span class="ofNote">この地方に、声をかけられる雀ドルはいません。</span>'}</div>`}

        <h2 class="ofSecT">同行者<span class="ofSecNote">0〜3人。遠征中はシフトから外れます</span></h2>
        <div class="ofPrefChips">${mates || '<span class="ofNote">連れて行ける子がいません。</span>'}</div>

        <h2 class="ofSecT">留守番</h2>
        <p class="ofNote" style="margin:0">${dep
          ? `<b>${esc(dep.name)}</b> に任せます（出勤者で完成度がいちばん高い子）。
             代表戦は自動で処理され、夜に自分の卓は出せません。`
          : '任せられる子がいません。代表戦は警察を呼んで収めます。'}</p>

        <hr class="kinsen">
        <div class="ofRep">
          <div class="ofRepRow"><span>行き先</span><b>${p ? esc(Geo.prefOf(p.pref).name) : '—'}</b></div>
          <div class="ofRepRow"><span>日数</span><b>${p ? p.days + '日' : '—'}</b></div>
          <div class="ofRepRow${p && p.cost > money ? ' minus' : ''}">
            <span>費用</span><b>${p ? yen(p.cost) : '—'}</b></div>
          <div class="ofRepRow"><span>ほかに毎日</span><b>日当 ${yen(list.reduce((a, c) => a + Jansou.wageOf(c), 0))}</b></div>
        </div>
        <button type="button" class="ofBtn" id="ofGo" style="margin-top:12px"
          ${p && p.cost <= money && (draft.purpose === 'find' || draft.target != null) ? '' : 'disabled'}>
          出発する</button>
        <button type="button" class="ofRunBtn ghost" id="ofBack" style="margin-top:8px">やめる</button>`;

      root.querySelectorAll('[data-dest]').forEach((b) => b.addEventListener('click', () => {
        draft.pref = b.dataset.dest; draft.target = null; renderTrip();
      }));
      root.querySelectorAll('[data-purpose]').forEach((b) => b.addEventListener('click', () => {
        if (b.disabled) return;
        draft.purpose = b.dataset.purpose; renderTrip();
      }));
      root.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => {
        draft.target = +b.dataset.target; renderTrip();
      }));
      root.querySelectorAll('[data-mate]').forEach((b) => b.addEventListener('click', () => {
        if (b.disabled) return;
        const id = +b.dataset.mate;
        const i = draft.members.indexOf(id);
        if (i >= 0) draft.members.splice(i, 1); else draft.members.push(id);
        renderTrip();
      }));
      root.querySelector('#ofBack').addEventListener('click', () => {
        draft = null; screen = 'morning'; render();
      });
      const go = root.querySelector('#ofGo');
      if (go) go.addEventListener('click', () => {
        if (go.disabled) return;
        const s0 = store.get();
        const t = tripStart(s0, draft.pref, draft.purpose, draft.members, draft.target);
        if (t.cost > (s0.money || 0)) return;
        /* 同行者は遠征中シフトから外れる（§6.3）。`assign` に印を付ける */
        const assign = Object.assign({}, s0.assign || {});
        draft.members.forEach((id) => { assign[id] = 'trip'; });
        store.set({ money: (s0.money || 0) - t.cost, trip: t, assign });
        draft = null; screen = 'morning'; render();
      });
    }

    /* ---------- 遠征中の一日（§7.3・§7.4） ----------
       留守の店を裏で回して合計に積み、遠征の出来事を一つ進める。
       **フロアの再生はしない**（§7.5）。帰った日の夜にまとめて出す */
    async function runTripDay() {
      const st0 = store.get();
      const trip = tripOf(st0);
      if (!trip) { screen = 'morning'; render(); return; }
      const list = rosterOf(st0);
      const parlor = parlorOf(st0);
      const arrived = trip.dayLeft === trip.days;      // 着いた日

      /* --- 留守の店（開いていれば） --- */
      let dayLine = null;
      const acc = Object.assign({ days: 0, guests: 0, sales: 0, profit: 0 }, trip.store);
      if (parlor.open) {
        const dep = trip.deputy != null ? list.find((c) => c.id === trip.deputy) : null;
        const r = Jansou.runAwayDay(store, list, dep || null);
        acc.days += 1;
        acc.guests += r.plan.day.guests;
        acc.sales += r.plan.day.sales;
        acc.profit += r.out.profit;
        dayLine = r.out.lines[0] || null;
      } else {
        Jansou.runClosedDay(store, list);
        acc.days += 1;
      }

      /* --- 遠征の出来事 --- */
      const log = trip.log.slice();
      const found = trip.found.slice();
      const signed = trip.signed.slice();
      const prefName = Geo.prefOf(trip.pref).name;
      let st = store.get();

      if (trip.purpose === 'find') {
        /* **一日一回の `drawOne` はやめた**（A4.5-1）。
           発見は「店を見て、声をかける」に置き換わった（`scout/spec.md` §0）。
           自動で引くと、毎日ただで一人見つかってしまい、
           **一日3回の上限も、どこを押すかの判断も意味を失う。**
           この日の出来事は `onShopTap` が `trip.log` に積んでいる。
           何もしなかった日は、その一行を出す */
        const shop = trip.shop;
        if (shop && !shop.met.length) {
          log.push(`${prefName}の${shop.name}を覗いたが、誰にも声をかけなかった`);
        }
      } else if (arrived && trip.target != null) {
        /* **着いた日に現地で対局**（§7.3）。
           A4.5-3 で前後が厚くなった（`scout/spec.md` §5.1）——
           **対局の前に一言 → 対局 → 勝ったら交渉 → 足りなければ課題を届ける。**
           判定そのもの（`Scout.evaluate` と `RULES`）は一行も変えていない。
           変えたのは、判定の前後に何を見せるか */
        const all = JANDOLS.concat(FREE_AGENTS);
        const c = all.find((x) => x.id === trip.target);
        if (c) {
          const mates = list.filter((x) => (trip.members || []).indexOf(x.id) >= 0);

          /* --- 1. 会う。同行者に同郷の子がいれば場が和む（§5.1） ---
             **`RULES.aisho` と同じ考えかた**で `region` を見るだけ。
             文面は `ScoutShop.aishoLine`（性格ではなく関係の話なので serifu ではない） */
          const mate = mates.find((m) => m.region === c.region) || null;
          const meet = typeof SERIFU !== 'undefined'
            ? SERIFU.pick(c.chara, 'scoutMeet') : '';
          await say({
            id: c.id, name: c.name, rank: c.rank, line: meet,
            sub: mate && typeof ScoutShop !== 'undefined'
              ? ScoutShop.aishoLine(mate, c) : '',
            label: '打つ',
          });
          if (mate) log.push(`${mate.name}が同郷で、${c.name}との場が和んだ`);

          /* --- 2. 対局（第三段のまま） --- */
          const table = [playerCard(st), c].concat(mates.slice(0, 2));
          /* 卓が埋まらないぶんは相手と同格のCPUで埋める */
          for (let i = table.length; i < 4; i++) {
            table.push(Object.assign({}, c, { id: 9500 + i, name: '地元の常連', guest: true }));
          }
          const rank = await playOrSimulate(table, `${prefName}・${c.name}との一局`);
          const mine = rank.find((r) => r.chara.id === 0);
          const his = rank.find((r) => r.chara.id === c.id);
          const won = !!(mine && his && mine.place < his.place);

          /* --- 3. 好感度は勝っても負けても積む（§5.1 の 5。空手で帰らせない） --- */
          st = store.get();
          const base = (st.favor || {})[c.id] || 0;
          const gain = favorGain(won);
          const favor = addFavor(st, c.id, won);
          store.set({ favor });
          log.push(won ? `${c.name}に勝った（好感度 +${gain}）` : `${c.name}に負けた（好感度 +${gain}）`);

          if (!won) {
            const lose = typeof SERIFU !== 'undefined'
              ? SERIFU.pick(c.chara, 'scoutLose') : '';
            await say({ id: c.id, name: c.name, rank: c.rank, line: lose,
              note: `好感度 +${gain}（いま ${Math.min(100, base + gain)}）`, label: '引き上げる' });
          } else {
            /* --- 4. 勝ったら交渉。ここで初めて条件が明かされる（§5.1 の 3） --- */
            st = store.get();
            const v = Scout.evaluate(c, st, rosterOf(st));
            const winLine = typeof SERIFU !== 'undefined'
              ? SERIFU.pick(c.chara, 'scoutWin') : '';
            const n = negotiate(c, v, winLine);
            const enough = n.ok && (st.money || 0) >= (v.cost || 0);

            if (enough) {
              const comp = Object.assign({}, st.comp);
              if (comp[c.id] == null) comp[c.id] = compFromRank(c.rank);
              store.set({
                money: (st.money || 0) - (v.cost || 0),
                contracted: (st.contracted || []).concat(c.id),
                discovered: (st.discovered || []).includes(c.id)
                  ? st.discovered : (st.discovered || []).concat(c.id),
                comp,
                /* 契約できたら、その相手の課題は用済み（§5.2） */
                offers: dropQuest(store.get(), c.id),
              });
              signed.push(c.id);
              log.push(`${c.name}と契約した（${v.cost ? yen(v.cost) : '契約金なし'}）`);
              await say({ id: c.id, name: c.name, rank: c.rank, line: n.line,
                note: `契約した（${v.cost ? yen(v.cost) : '契約金なし'}）`, label: '連れて帰る' });
            } else {
              /* --- 5. 足りない。**空手で帰らせない**——課題として事務所に届ける（§5.2）。
                 **相手ごとに一枠。**二度失敗しても二件にならない */
              const short = !n.ok ? n.detail
                : `あと ${yen((v.cost || 0) - (st.money || 0))} 足りません。`;
              const q = typeof Offers !== 'undefined' ? Offers.questFor(c.id) : null;
              if (q) store.set({ offers: Offers.push(store.get(), q.id) });
              log.push(`${c.name}「${short}」`);
              if (q) log.push(`${c.name}の課題が事務所に届いた`);
              await say({ id: c.id, name: c.name, rank: c.rank, line: n.line,
                sub: short, note: q ? '事務所に課題として届きます' : '', label: '出直す' });
            }
          }
        }
      }

      /* --- 日を減らす。0になったら帰還 --- */
      st = store.get();
      const left = trip.dayLeft - 1;
      if (left > 0) {
        store.set({ trip: Object.assign({}, trip, { dayLeft: left, log, found, signed, store: acc }) });
        night = { trip: { pref: trip.pref, left, line: log[log.length - 1], dayLine } };
      } else {
        /* 帰還。同行者をシフトに戻す（§7.5） */
        const assign = Object.assign({}, st.assign || {});
        (trip.members || []).forEach((id) => { if (assign[id] === 'trip') assign[id] = 'parlor'; });
        store.set({ trip: null, assign });
        night = { back: { pref: trip.pref, days: trip.days, log, found, signed, store: acc } };
      }
      screen = 'night';
      render();
    }

    /* 実対局の卓に座る代表。`jansou.js` の playerCard と同じ形 */
    function playerCard(st) {
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

    /* 交渉の吹き出し（`scout/spec.md` §5）。相手の顔と一言を出して待つ。
       **`jansou.js` の `ask` と同じ作り**（`.popup` は `theme.css`）だが、
       選ぶことは無いので釦は一つ。読ませて閉じるだけ。

       `sub` は同郷の一言か、`RULES` の `detail`。**ここで条件を組み立てない**
       ——呼ぶ側が `negotiate()` から受け取ったものを渡す */
    function say(o) {
      return new Promise((resolve) => {
        const ov = document.createElement('div');
        ov.className = 'popup';
        ov.innerHTML = `<div class="popupBox ofSayBox" role="dialog" aria-modal="true"
            aria-label="${esc(o.name || '')}">
          <div class="popupPhoto"><div class="mkFace sil">
            <img src="img/${pad3(o.id)}.webp" alt="" onerror="this.remove()"></div></div>
          <div class="popupBody">
            <div class="ofSayName">${esc(o.name || '')}${o.rank
              ? `<i>${esc(o.rank)}級</i>` : ''}</div>
            ${o.line ? `<p class="ofSayLine">「${esc(o.line)}」</p>` : ''}
            ${o.sub ? `<p class="ofSaySub">${esc(o.sub)}</p>` : ''}
            ${o.note ? `<p class="ofSayNote">${esc(o.note)}</p>` : ''}
            <div class="ofSayBtns">
              <button type="button" class="ofSayBtn" data-key="ok">${esc(o.label || '……')}</button>
            </div>
          </div>
        </div>`;
        document.body.appendChild(ov);
        ov.addEventListener('click', (e) => {
          if (!e.target.closest('[data-key]')) return;
          ov.remove();
          resolve('ok');
        });
      });
    }

    /* 現地の対局。**`index.html` では実対局、単体ページでは `simulateTable`**
       （`jansou.js` の playOrSimulate と同じ作法。§7.3） */
    async function playOrSimulate(table, title) {
      if (typeof store.playRealMatch === 'function') {
        const r = await store.playRealMatch(table, { tier: { name: '遠征' }, name: title });
        if (r) return r;
      }
      return simulateTable(table, STYLES);
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
      const away = night && night.trip;
      const back = night && night.back;
      const job = night && night.offer;

      /* 日を使わない依頼（契約イベント）は、店の収支を出さない */
      const jobBody = job ? `
        <div class="ofRep">
          <div class="ofRepRow"><span>${esc(job.title)}</span>
            <b>${job.store ? job.store.days + '日' : '受けた'}</b></div>
          ${job.lines.map((l) => `<div class="ofRepEv">${esc(l)}</div>`).join('')}
          ${job.store ? `
            <div class="ofRepRow" style="margin-top:6px"><span>そのあいだの店</span>
              <b>客 ${job.store.guests}人</b></div>
            <div class="ofRepRow${job.store.profit >= 0 ? '' : ' minus'}"><span>収支</span>
              <b>${job.store.profit >= 0 ? '+' : '−'}${yen(Math.abs(job.store.profit))}</b></div>` : ''}
        </div>` : '';

      const body = (job && job.noDay) ? '' : last ? `
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

      /* 遠征中の夜。**店の細かい話はしない**（帰った日にまとめて出す・§7.5） */
      const tripBody = away ? `
        <div class="ofRep">
          <div class="ofRepRow"><span>${esc(Geo.prefOf(away.pref).name)}にて</span>
            <b>あと ${away.left} 日</b></div>
          ${away.line ? `<div class="ofRepEv">${esc(away.line)}</div>` : ''}
          ${away.dayLine ? `<div class="ofRepEv quiet">留守の店：${esc(away.dayLine)}</div>` : ''}
        </div>` : '';

      /* 帰還の日報（§7.5）。留守中の日数ぶんの店の結果をまとめて出す */
      const backBody = back ? `
        <div class="ofRep">
          <div class="ofRepRow"><span>${esc(Geo.prefOf(back.pref).name)}から帰った</span>
            <b>${back.days}日</b></div>
          ${back.log.map((l) => `<div class="ofRepEv">${esc(l)}</div>`).join('')}
          <div class="ofRepRow" style="margin-top:6px"><span>留守中の店（${back.store.days}日）</span>
            <b>客 ${back.store.guests}人</b></div>
          <div class="ofRepRow"><span>場代の合計</span><b>${yen(back.store.sales)}</b></div>
          <div class="ofRepRow${back.store.profit >= 0 ? '' : ' minus'}">
            <span>留守中の収支</span>
            <b>${back.store.profit >= 0 ? '+' : '−'}${yen(Math.abs(back.store.profit))}</b></div>
        </div>` : '';

      root.innerHTML = `
        <div class="ofHead">
          <h1 class="ofTitle">${back ? '帰ってきた'
            : (job && job.noDay) ? '話を受けた'
            : last ? `${last.day}日目の夜` : '夜'}</h1>
          <p class="ofSub">${esc(nameOf(st))}${closed ? '　まだ店は無い'
            : away ? '　遠征中' : ''}</p>
        </div>
        ${backBody}${tripBody}${jobBody}
        ${body ? `<div class="ofRep">${body}</div>` : ''}
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
      /* **前の床を必ず止める。**`idle()` の rAF は自分では終わらない。
         `wrap.isConnected` を見て自滅する保険も入れてあるが、
         画面を替えた瞬間に止めるのはこちらの仕事 */
      if (shopCtl) { shopCtl.destroy(); shopCtl = null; }
      if (screen === 'pick') renderPick();
      else if (screen === 'trip') renderTrip();
      else if (screen === 'night') renderNight();
      else renderMorning();
      root.scrollTop = 0;
    }

    /* 大会から帰ってきたところ（`shell.html` が opts で渡す）。
       **組み直されたあとのこの mount で日数を消化する** */
    if (opts.taikai && Offers.byId(opts.taikai.offerId)) {
      afterTournament(Offers.byId(opts.taikai.offerId), opts.taikai.res);
    } else {
      render();
    }
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

  return { mount, defaultName, nameOf, prefOf, rosterOf, prefPickerHtml, bindPicker, NAME_MAX,
           ASSIGN_KINDS, assignFor, assignOf, parlorRoster, setAssign, fatigueOf, condOf,
           planTrip, deputyOf, tripOf, tripStart, regionOfPref,
           fireOffers, dismissOffer, acceptOffer, dropQuest, popOf, idolResult,
           ensureShop, callOn, negotiate, favorGain, addFavor, FAVOR_GAIN,
           eightTable, eightNext, powerOf, mightOf, charaTitle, rivalOf, RIVALS,
           RANK_TITLE, TIER_POINT, POWER_MIX, FAME_MIX, agencyTitle, EIGHT_N };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Office };
}
