/* ============================================================
   事務所に届く依頼 — offers.js
   依存：characters.js / tournament.js / geo.js（読むのは when の中だけ）

   使い方：
     Offers.TABLE            定義データ（下の表）
     Offers.byId(id)         id から一件
     Offers.fire(st, roster) 今日あたらしく届くものを返す（純関数）
     Offers.textOf(o, st)    文面（依頼によって相手の名前が入る）

   設計は docs/design/office/spec.md §8。

   ------------------------------------------------------------
   なぜ「依頼」に寄せるのか
   ------------------------------------------------------------
   大会・契約イベント・アイドル案件は、遊びとしては別物だが、
   **プレイヤーから見ると「事務所に話が来て、受けるか見送るかを決める」**
   という一つの形に収まる。同じ表に載せておけば、
   **リリース後に足すのは表の一行だけ**で済む（§1.3 の運営型）。

   ------------------------------------------------------------
   発火条件に日付を書かないこと（§1.3・§8.1）
   ------------------------------------------------------------
   `when` が見ていいのはプレイヤーの状態だけ。
   「所属が5人を超えた」「誰かの好感度が80を超えた」のように書く。
   **`parlor.day` を見ない。**日付で発火させると、あとから足した依頼が
   100日進めた人には二度と届かなくなる。

   ------------------------------------------------------------
   一件の形（§8.1）
   ------------------------------------------------------------
     id       文字列。**セーブに残るので変えないこと**
     kind     'tournament' | 'contract' | 'idol' | 'quest'
     slot     同じ枠を奪い合う印（省くと id そのもの）。`push` が見る
     when     (st, roster) => boolean
     once     一度きりか（true なら st.offerFired を見る）
     prio     1〜9。同じ日に複数届いたときの並び（大きいほど上）
     days     拘束日数。0 なら日を消費しない
     members  { min, max } 何人送るか
     text     事務所に届く文面
     payload  kind ごと（大会id・雀ドルid・案件の効き目）
   ============================================================ */

const Offers = (() => {
  'use strict';

  /* 大会の拘束日数。**16人は一日、64人は二日。**
     出走表を見て打って結果を見るまでを一日、
     64人（三回戦）はもう一日かかる、という理屈 */
  const DAYS_BY_SIZE = { 16: 1, 64: 2 };

  const all = () => JANDOLS.concat(FREE_AGENTS);
  const findChara = (id) => all().find((c) => c.id === id) || null;

  /* 受けた依頼か（`RULES.event` もこれを見る） */
  function accepted(st, id) {
    return (st.offerAccepted || []).indexOf(id) >= 0;
  }

  /* ------------------------------------------------------------
     大会（§8.2）— 既存の5大会を「届く招待」にする
     `when` は出場資格（段位が band に届いているか）。
     **一度きりではない。**条件を満たしているかぎり、また来る
  ------------------------------------------------------------ */
  const RANK_ORDER = ['D', 'C', 'B', 'A', 'S'];
  /* **出場資格は `tournament.js` の `canEnter` が正。ここに書かない。**
     以前ここに簡略版（`band` の一番下以上なら誰でも）があり、`strict` を
     見ていなかった。大会のタブが招待の一覧になったことで、
     **S級に新人戦（C級以下だけ）の招待が届いて押せない札として並ぶ**形が
     表に出た。判定を一本にして直してある */

  const TOURNAMENT_OFFERS = Object.keys(TOURNAMENTS).map((tierId) => {
    const t = TOURNAMENTS[tierId];
    return {
      id: 'taikai-' + tierId,
      kind: 'tournament',
      once: false,
      prio: 5 + RANK_ORDER.indexOf(t.band[0]),      // 格の高い大会ほど上に出す
      days: DAYS_BY_SIZE[t.size] || 1,
      members: { min: 3, max: 3 },                  // 既存のチーム編成をそのまま送る
      when: (st, roster) => canEnter(tierId, st.playerRank || 'D')
        && (st.team || []).length >= 3 && roster.length >= 3,
      text: `${t.name}の招待が届いた。${t.note}。優勝賞金 ${t.prize.toLocaleString('ja-JP')}円。`,
      payload: { tierId },
    };
  });

  /* ------------------------------------------------------------
     契約イベント（§8.2）— `contract === 'event'` の6人
     **天城リオ No.001 はここで解放される。**

     条件は HANDOVER §3 の推奨どおり三段：**好感度 ＋ 事務所ランク ＋ 大会実績**。
     好感度は雀荘の「ゲスト来店」と遠征で貯まるので、
     「通わせる理由」と「図鑑の解放」が一本の線で繋がる。

     受けると `offerAccepted` に id が入り、**`RULES.event` がそれだけを見る**。
     あとは遠征の「口説く」で現地に会いに行けば契約できる（§7.3）。
     **依頼を受けただけでは契約にならない。**会いに行って勝つところまでが要る。
  ------------------------------------------------------------ */
  const CONTRACT_OFFERS = [
    { id: 'event-001', charaId: 1, favor: 80, agency: 5, tier: 'eight',
      text: '「天城リオが会ってもいいと言っている」と、古い知り合いから連絡があった。' +
            '雀エイトの頂に立つ女が、あなたの事務所を見ている。' },
    { id: 'event-008', charaId: 8, favor: 70, agency: 4, tier: 'title',
      text: '朧ゆかりの付き人から便りが来た。「一度、勝ってから来てください」と言われていた件です。' },
    { id: 'event-016', charaId: 16, favor: 60, agency: 3, tier: 'open',
      text: '真壁きょうかが「事務所を移るか迷っている」と漏らしていたらしい。話を聞きに行くなら今。' },
    { id: 'event-018', charaId: 18, favor: 50, agency: 3, tier: 'open',
      text: '白鷺香澄の名前が地方紙に載った。囲まれる前に、こちらから訪ねる手がある。' },
    { id: 'event-042', charaId: 42, favor: 40, agency: 2, tier: 'local',
      text: '緋田ましろが「あの事務所の人にまた会いたい」と言っていた、と店の常連から聞いた。' },
    { id: 'event-054', charaId: 54, favor: 45, agency: 2, tier: 'local',
      text: '神保ちとせが所属を探している。うちの名前を出したら、悪くない顔をしたそうだ。' },
  ].map((e) => ({
    id: e.id,
    kind: 'contract',
    once: true,                 // 一度届けば十分。受けたら RULES.event が開く
    prio: 9,                    // **規模に依らず、条件だけで必ず届く**（§8.3）
    days: 0,                    // 受けるだけなら日は消費しない。会いに行くのは遠征
    members: { min: 0, max: 0 },
    when: (st) => ((st.favor || {})[e.charaId] || 0) >= e.favor
      && (st.agency || 1) >= e.agency
      && !!(((st.records || {})[e.tier] || {}).best === '優勝')
      && (st.contracted || []).indexOf(e.charaId) < 0,
    text: e.text,
    payload: { charaId: e.charaId, favor: e.favor, agency: e.agency, tier: e.tier },
  }));

  /* ------------------------------------------------------------
     アイドル活動（§8.2）— `pop` の供給源
     代表は要らない。**演出は作らない。日報一行とセリフだけ。**
     `chara`（性格19種。`characters.js` の値そのまま）で向き不向きを付ける。
     向いていれば伸びが大きい。**新しいパラメータは足さない**——
     セリフと同じで、既にある `chara` を分類に使い回す（HANDOVER §4）。

     `match` が真の案件は対局付き（テレビ対局・ファン対局会）。
     送った子が `simulateTable` で打ち、勝てば `pop` が跳ねる。
  ------------------------------------------------------------ */
  const IDOL_OFFERS = [
    { id: 'idol-local-tv', name: '地方局の深夜番組', days: 1, min: 1, max: 2,
      pop: 2, pay: 30000, favor: 2, fit: ['明るい元気娘', 'ギャル', 'さばさば姉御', '小悪魔'],
      text: '地方局から「雀荘特集に出てほしい」と話が来た。深夜の三十分。',
      res: {
        hit:  { head: '深夜なのに反響があった', line: 'カメラ、思ったより怖くないですね' },
        miss: { head: '無難にこなした', line: '……何を喋ればいいのか、分からなくて' },
      } },
    { id: 'idol-photo', name: '雑誌のグラビア', days: 1, min: 1, max: 1,
      pop: 3, pay: 80000, favor: 3, fit: ['クール', 'ミステリアス', 'お嬢様', 'お姉さん系'],
      text: '麻雀雑誌の巻頭を一枚。「顔が知られていない子のほうがいい」とのこと。',
      res: {
        hit:  { head: '巻頭に載った', line: '写真の人、私じゃないみたい' },
        miss: { head: '隅に一枚だけ載った', line: '……あれ、本当に載るんですか' },
      } },
    { id: 'idol-event', name: 'ファン対局会', days: 1, min: 2, max: 3,
      pop: 4, pay: 50000, favor: 4, match: true, fit: ['明るい元気娘', '庶民派努力家', 'おっとり', '天然'],
      text: 'デパートの催事場でファンと打つ会。勝てば話題になる。',
      res: {
        hitWin:  { head: '会場がどよめいた', line: 'いちばん楽しい卓でした' },
        hit:     { head: '列が途切れなかった', line: 'また打ちましょうね' },
        missWin: { head: '勝ってしまった', line: '勝つ気は、無かったんですけど' },
        miss:    { head: '握手だけして帰った', line: '人が多いのは、少し苦手です' },
      } },
    { id: 'idol-tv-match', name: 'テレビ対局', days: 2, min: 1, max: 1,
      pop: 8, pay: 200000, favor: 5, match: true, fit: ['負けず嫌い', '真面目委員長', '職人肌', '無口だけど熱い'],
      /* **条件を足した（2026年9月11日・段B の直し）。**
         足す前は `roster.length >= 2` だけで、**いちばん大きい案件が序盤から来ていた**
         ——当たりくじがこれ一つに偏る。

         **写真集とは別の軸で見ること。**あちらは `pop` ＋ `favor`（**人**の軸）。
         こちらは**事務所の格**＝所属の人数・事務所ランク・大会に出た実績。
         同じ条件にすると二つ同時に解禁されて、また偏る。
         `records[tier].entries` は「出たことがあるか」で、`best` は見ない
         ——勝てとは言っていない（勝ちを要求するのは契約イベントの役目）。
         **id は変えない**（セーブに残る・§8.1） */
      when: (st, roster) => roster.length >= 3 && (st.agency || 1) >= 2
        && Object.keys(st.records || {}).some((k) => ((st.records[k] || {}).entries | 0) > 0),
      text: 'ケーブルの対局番組から指名が来た。全国に流れる。',
      res: {
        hitWin:  { head: '全国に顔が出た', line: '見ていましたか。次も出ます' },
        hit:     { head: '全国に流れた', line: '思ったより、静かな卓でした' },
        missWin: { head: '番狂わせと書かれた', line: '……たまたまです' },
        miss:    { head: '名前だけ覚えられた', line: 'カメラの前は、もういいです' },
      } },

    /* ---- ここから6件は 2026年9月11日に足したぶん（段B） ----
       4件しか無いと同じものが何度も来る。**足すのは表の一行だけ**という
       設計（§1.3 の運営型）をそのまま使う。

       **見出しの語彙を既存とかぶらせないこと。**「話題になった」「顔が売れた」
       の類が10件に散ると、増やしたのに同じに見える。案件ごとの固有名詞
       （ハガキ・黒板・同時視聴・大将戦・スタジオ・平積み）を見出しに入れて分ける。

       **`fit` は19種が偏らないように配り直した。**足す前は
       人見知り・生意気な後輩・毒舌・中二病気質の4種に出番が無かった。
       10件で 19種が2件ずつ（明るい元気娘とおっとりだけ3件）になる。 */

    { id: 'idol-radio', name: 'ラジオのゲスト', days: 1, min: 1, max: 2,
      pop: 2, pay: 30000, favor: 3,
      /* **声だけの仕事。**人前が苦手な子に最初の出番が来る */
      fit: ['人見知り', '毒舌', '天然', 'さばさば姉御'],
      text: '深夜ラジオから「三十分だけ喋ってほしい」と話が来た。顔は映らない。',
      res: {
        hit:  { head: 'ハガキが読み切れなかった', line: 'しゃべるだけなら、まだ平気です' },
        miss: { head: '相槌だけで終わった', line: '……間が持たなくて、すみません' },
      } },
    { id: 'idol-school', name: '麻雀教室の講師', days: 1, min: 1, max: 2,
      /* **人気より好感度が伸びる。**派手ではないが、続けると効く */
      pop: 2, pay: 40000, favor: 6,
      fit: ['真面目委員長', '職人肌', 'お姉さん系', 'おっとり'],
      when: (st, roster) => roster.length >= 3,
      text: 'カルチャーセンターの麻雀教室から、講師をひとり貸してほしいと頼まれた。',
      res: {
        hit:  { head: '生徒が次も申し込んだ', line: '教えるのは、打つのと別の頭を使いますね' },
        miss: { head: '黒板の前で固まった', line: '……何から話せばいいのか' },
      } },
    { id: 'idol-stream', name: 'ネット配信の対局', days: 1, min: 1, max: 1,
      pop: 3, pay: 40000, favor: 3, match: true,
      fit: ['生意気な後輩', '中二病気質', 'ギャル', '小悪魔'],
      text: '配信者から共演の打診。打ちながら喋れる子がいい、とのこと。',
      res: {
        hitWin:  { head: '同時視聴が跳ねた', line: 'コメント、追いつかないんだけど' },
        hit:     { head: 'コメントが流れ続けた', line: '負けたのに伸びるの、なんでだろ' },
        missWin: { head: '切り抜きが回った', line: '……配信、向いてないと思ってました' },
        miss:    { head: '静かな配信だった', line: 'しゃべりながら打つのは、無理です' },
      } },
    { id: 'idol-team', name: '団体戦のゲスト参加', days: 2, min: 2, max: 3,
      pop: 5, pay: 120000, favor: 4, match: true,
      fit: ['負けず嫌い', '無口だけど熱い', '庶民派努力家', '明るい元気娘'],
      /* **人数が要る仕事。**所属が増え、事務所が二段目に上がってから */
      when: (st, roster) => roster.length >= 4 && (st.agency || 1) >= 2,
      text: '企業チームの団体戦に、助っ人として席が空いている。二日がかり。',
      res: {
        hitWin:  { head: '大将戦を取った', line: 'チームで打つの、悪くないですね' },
        hit:     { head: '副将まで繋いだ', line: '次は私が決めます' },
        missWin: { head: '助っ人が大将を倒した', line: '……勝ってしまいました' },
        miss:    { head: '一本も取れなかった', line: '団体戦は、間合いが違いますね' },
      } },
    { id: 'idol-cm', name: 'CM 撮影', days: 1, min: 1, max: 1,
      pop: 6, pay: 150000, favor: 3,
      fit: ['クール', 'お嬢様', 'ミステリアス', '毒舌'],
      /* **人気のある子がいて初めて話が来る。**序盤には届かない。
         `roster` の `pop` は `rosterOf` が `popOf` で作った値
         ——**ここで式を書き写さない**（§8.2） */
      when: (st, roster) => roster.length >= 3 && roster.some((c) => (c.pop || 0) >= 70),
      text: '飲料メーカーから十五秒のCMの話。「顔で選びたい」と言われた。',
      res: {
        hit:  { head: 'スタジオで一発だった', line: 'はい、と言うだけで半日でした' },
        miss: { head: '十五秒に半日かかった', line: '……立っているだけなのに、疲れます' },
      } },
    { id: 'idol-photobook', name: '写真集', days: 2, min: 1, max: 1,
      /* **報酬はここがいちばん大きい。**`pop` はテレビ対局と同じ8だが、
         あちらは勝てば倍になる（`match`）ので、伸びの天井は向こうが上 */
      pop: 8, pay: 220000, favor: 5,
      /* **普段は撮られない子ほど売れる**——グラビアの
         「顔が知られていない子のほうがいい」と同じ筋を、大きいほうで回収する */
      fit: ['人見知り', '生意気な後輩', '中二病気質', 'おっとり'],
      /* **人気と好感度の両方。**いちばん大きい案件なので、いちばん奥に置く */
      when: (st, roster) => roster.some((c) => (c.pop || 0) >= 78 && (c.favor || 0) >= 60),
      text: '出版社から一冊まるごとの話が来た。二日かけて撮る。',
      res: {
        hit:  { head: '書店で平積みになった', line: 'この一冊は、残るんですね' },
        miss: { head: '初版だけで止まった', line: '……私の本、誰が買うんでしょう' },
      } },
  ].map((e) => ({
    id: e.id,
    kind: 'idol',
    once: false,
    /* **条件の付いた大きい案件は上に出す**（`prio` 4）。
       めったに来ないものが routine の下に埋もれないように */
    prio: e.when ? 4 : 3,
    days: e.days,
    members: { min: e.min, max: e.max },
    /* **所属が2人を超えてから。**初期の3人しかいないうちは店を回すので手一杯。
       大きい案件は自分の `when` を持つ（上の表）。
       **どれも `parlor.day` を見ない**（§8.1）——日付で発火させると、
       あとから足した依頼が100日進めた人には二度と届かなくなる */
    when: e.when || ((st, roster) => roster.length >= 2),
    text: e.text,
    payload: { name: e.name, pop: e.pop, pay: e.pay, favor: e.favor,
               match: !!e.match, fit: e.fit || [], res: e.res },
  }));

  /* ------------------------------------------------------------
     課題（`scout/spec.md` §5.2）— A4.5-3

     遠征で口説きに行って**勝ったのに条件が足りなかった**とき、
     その場で積む。空手で帰らせないための器。

     **`when` は常に偽。`fire()` は引かない。**発火の理由が
     プレイヤーの状態ではなく「その相手に会って勝った」という
     **出来事**だから。§8.1 の「発火条件に日付を書かない」には
     触れていない（日付は見ていない）。積むのは `push()`。

     **相手ごとに一枠**（`slot`）。二度失敗しても二件にならず、
     新しいものが古いものを置き換える（§5.2）。

     **文面をここに持たない。**条件は `Scout.evaluate` の `detail` が正で、
     `textOf` がそのつど引く。ここに書くと二重になり、
     片方を直したときに必ずずれる（`RULES.event` で一度通った話）。
  ------------------------------------------------------------ */
  const QUEST_OFFERS = all().map((c) => ({
    id: 'quest-' + c.id,
    kind: 'quest',
    slot: 'quest:' + c.id,
    when: () => false,
    once: false, prio: 8, days: 0, members: { min: 0, max: 0 },
    text: '',
    payload: { charaId: c.id },
  }));

  const TABLE = TOURNAMENT_OFFERS.concat(CONTRACT_OFFERS, IDOL_OFFERS, QUEST_OFFERS);
  const BY_ID = {};
  TABLE.forEach((o) => { BY_ID[o.id] = o; });
  function byId(id) { return BY_ID[id] || null; }

  /* ------------------------------------------------------------
     発火（§8.1）— 朝に一度だけ呼ぶ
     `when` が真で、まだ届いていないものを返す。
     `once` のものは `offerFired` に入っていたら二度と返さない。

     **その日届く数は本拠地の `scale` で重みづける**（都市は多い・§8.3）。
     ただし **`once` の契約イベントは規模に依らず条件だけで届く**。

     rng を注入できるようにしてあるのは、テストで固定するため。
     **朝に一度引くだけで、再生層では引かない**（jansou/spec.md §1 と同じ作法）
  ------------------------------------------------------------ */
  const MAX_OPEN = 6;             // 事務所に溜めておける件数

  function fire(st, roster, rng) {
    rng = rng || Math.random;
    const open = (st.offers || []).slice();
    const openIds = new Set(open.map((o) => o.id));
    const fired = new Set(st.offerFired || []);

    const ready = TABLE.filter((o) => {
      if (openIds.has(o.id)) return false;              // もう届いている
      if (o.once && fired.has(o.id)) return false;      // 一度きりで発火済み
      let ok = false;
      try { ok = !!o.when(st, roster || []); } catch (e) { ok = false; }
      return ok;
    });

    /* **条件だけで必ず届くもの**（once の契約イベント）は先に通す */
    const must = ready.filter((o) => o.once);
    const rest = ready.filter((o) => !o.once);

    /* 残りは本拠地の規模で数を決める。scale 1 なら1件、5 なら3件まで */
    const pref = typeof Geo !== 'undefined' && st.officePref
      ? Geo.prefOf(st.officePref) : null;
    const scale = pref ? pref.scale : 3;
    const room = Math.max(0, MAX_OPEN - open.length - must.length);
    const want = Math.min(room, Math.max(1, Math.round(scale / 2)));

    const pick = [];
    const pool = rest.slice();
    for (let i = 0; i < want && pool.length; i++) {
      pick.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    }

    return must.concat(pick)
      .sort((a, b) => b.prio - a.prio || (a.id < b.id ? -1 : 1))
      .map((o) => ({ id: o.id, kind: o.kind }));
  }

  /* 課題を直接積む（`fire` を通さない。§5.2）。
     **同じ `slot` の古いものを落として置き換える。**
     返すのは新しい `offers` の配列（純関数。書くのは呼ぶ側） */
  function push(st, id) {
    const def = byId(id);
    const open = (st.offers || []).slice();
    if (!def) return open;
    const slot = def.slot || def.id;
    const kept = open.filter((o) => {
      const d = byId(o.id);
      return !d || (d.slot || d.id) !== slot;
    });
    return kept.concat([{ id: def.id, kind: def.kind }]);
  }

  /* その相手の課題の定義。無ければ null */
  function questFor(charaId) { return byId('quest-' + charaId); }

  /* 文面。契約イベントは相手の名前と条件を添える。
     **課題は条件を持たない。**`Scout.evaluate` の `detail` をそのつど引く
     （§5.4。条件文を二か所に書かないため）。`roster` は evaluate が要る */
  function textOf(o, st, roster) {
    const def = byId(o.id || o);
    if (!def) return '';
    if (def.kind === 'quest') {
      const c = findChara(def.payload.charaId);
      if (!c) return '';
      let v = null;
      if (typeof Scout !== 'undefined') {
        try { v = Scout.evaluate(c, st || {}, roster || []); } catch (e) { v = null; }
      }
      const who = `${c.name}（${c.rank}級・${c.region}）`;
      if (v && v.ok) return `${who}の条件は満たしている。もう一度会いに行けば契約できる。`;
      return `${who}に会ってきた。` + (v && v.detail ? `いまは「${v.detail}」` : '');
    }
    if (def.kind !== 'contract') return def.text;
    const c = findChara(def.payload.charaId);
    return def.text + (c ? `（${c.name}・${c.rank}級・${c.region}）` : '');
  }

  /* 依頼の見出し。一覧に並べるとき使う */
  function titleOf(o) {
    const def = byId(o.id || o);
    if (!def) return '';
    if (def.kind === 'tournament') return TOURNAMENTS[def.payload.tierId].name + 'の招待';
    if (def.kind === 'idol') return def.payload.name;
    const c = findChara(def.payload.charaId);
    if (def.kind === 'quest') return (c ? c.name : '') + 'の課題';
    return (c ? c.name : '') + 'の話';
  }

  return { TABLE, byId, fire, push, questFor, textOf, titleOf, accepted, canEnter,
           DAYS_BY_SIZE, MAX_OPEN };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Offers };
}
