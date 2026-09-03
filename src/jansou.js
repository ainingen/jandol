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
  const PLANT_COST = 20000;          // 観葉植物（模様替えで置く小物。placement.md §4）
  const TABLE_COST = { 3: 300000, 4: 500000, 5: 800000, 6: 1200000, 7: 1800000, 8: 2500000 };

  /* 内装・卓の型・宣伝。**数値（mul / rot / pull / ev）は変えないこと。**
     引き継ぎ書 §4 の実測がこれに乗っている。
     name と see はガールズ雀荘に合わせて改めたもので、
     see はその段階で**フロアに現れるもの**（§10。買った手応えを絵で見せる） */
  const INTERIOR = [
    { lv: 1, name: '裸電球と丸椅子',       see: '板張りの床',                 mul: 1.00, cost: 0 },
    { lv: 2, name: 'カーペットと間接照明', see: 'アイボリーのカーペット',     mul: 1.12, cost: 400000 },
    { lv: 3, name: 'ミラーボールと指名パネル', see: 'ミラーボール・指名ランキング', mul: 1.26, cost: 1000000 },
    { lv: 4, name: 'スタンド花とソファ席', see: 'スタンド花・ソファ席',       mul: 1.42, cost: 2500000 },
    { lv: 5, name: 'ドリンクカウンターの名店', see: 'カウンターとボトル棚',   mul: 1.60, cost: 6000000 },
  ];
  const AUTO = [
    { lv: 1, name: '手積み',             see: '木の卓',             rot: 1.00, cost: 0 },
    { lv: 2, name: '全自動卓',           see: '紫の全自動卓',       rot: 1.25, cost: 600000 },
    { lv: 3, name: '点数表示付き全自動卓', see: '点数表示の小窓つき', rot: 1.50, cost: 1800000 },
  ];
  const SIGN = [
    { lv: 1, name: '手書きの貼り紙', see: '貼り紙だけ',           pull: 0.00, ev: 0.20, cost: 0 },
    { lv: 2, name: '通りに看板',     see: 'GIRLS のネオン',       pull: 0.10, ev: 0.28, cost: 250000 },
    { lv: 3, name: '雑誌に広告',     see: '★ MAHJONG とLED',     pull: 0.22, ev: 0.36, cost: 900000 },
  ];

  /* ひと月の日数（monthly.md §2）。**恣意的な数ではない。**
     日当は最初から「月給の三十分割」なので、30日で締めると
     30日ぶんの日当の合計がちょうど月給一人分に一致する。
     **wageOf の割る数と対。片方だけ動かさないこと。** */
  const MONTH_DAYS = 30;
  const MONTHS_KEPT = 12;   // 月報は直近12期だけ残す。生涯累計は total が持っている

  const BASE_WAGE = 4000;                                   // 出勤一人あたりの日当の底
  const wageOf = (c) => BASE_WAGE + Math.round((c.salary || 0) / MONTH_DAYS);  // 月給の日割り
  const utilOf = (tables) => 8000 + tables * 1500;          // 家賃・光熱の日割り

  /* ---------- 月の集計（monthly.md §8） ----------
     **`log` から月を集計しないこと。**`log` は `.slice(-7)` で
     直近7日しか残らないので、30日ぶんを数えられない（monthly.md §9）。
     ここに独立して積む。 */
  function blankMonth(fromDay, rep, bottles) {
    return {
      from: fromDay | 0,
      days: 0,
      /* 帯の素。**場代の唯一の出どころ。**Σ slots[k].sales が月の場代になる */
      slots: [{ guests: 0, sales: 0 }, { guests: 0, sales: 0 }, { guests: 0, sales: 0 }],
      wages: 0, util: 0,
      /* 臨時収入の内訳。Σ が extra（ボトルの仕入れ費は負で other に入る） */
      extra: { bottle: 0, tip: 0, other: 0 },
      fullDays: 0,
      events: { bottle: 0, bottleWin: 0, arashi: 0, arashiWin: 0, guest: 0, treat: 0,
                shuzai: 0, kosho: 0, shugi: 0, oshinobi: 0 },
      work: {},        // id -> { days, slots }
      nominate: {},    // id -> 回数
      grow: {},        // id -> 完成度の伸び
      promo: { stage1: 0, stage2: 0, stage3: 0 },
      repFrom: typeof rep === 'number' ? rep : 10,
      bottlesFrom: Array.isArray(bottles) ? bottles.slice(0, 6).map((n) => n | 0) : [0, 0, 0, 0, 0, 0],
      profits: [],     // その日の profit。§7 の検算に使う
    };
  }

  /* 読んだ month を整える。壊れていたら作り直す（既存セーブ・手で触られたセーブ） */
  function normalizeMonth(m, fromDay, rep, bottles) {
    const b = blankMonth(fromDay, rep, bottles);
    if (!m || typeof m !== 'object' || !Array.isArray(m.slots) || m.slots.length !== 3) return b;
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
    return {
      from: num(m.from), days: num(m.days),
      slots: m.slots.map((s) => ({ guests: num(s && s.guests), sales: num(s && s.sales) })),
      wages: num(m.wages), util: num(m.util),
      extra: Object.assign({ bottle: 0, tip: 0, other: 0 }, m.extra || {}),
      fullDays: num(m.fullDays),
      events: Object.assign({}, b.events, m.events || {}),
      work: m.work && typeof m.work === 'object' ? m.work : {},
      nominate: m.nominate && typeof m.nominate === 'object' ? m.nominate : {},
      grow: m.grow && typeof m.grow === 'object' ? m.grow : {},
      promo: Object.assign({ stage1: 0, stage2: 0, stage3: 0 }, m.promo || {}),
      repFrom: num(m.repFrom),
      bottlesFrom: Array.isArray(m.bottlesFrom) ? m.bottlesFrom.slice(0, 6).map((n) => n | 0) : b.bottlesFrom,
      profits: Array.isArray(m.profits) ? m.profits.map(num) : [],
    };
  }

  /* 一日の**確定値**を月に足す。純関数（monthly.md §7）。
     渡ってくるのは settle が確定させた整数だけ。ここで乱数も Date も引かない。
     **平均や割合を渡さないこと。**帯に入れていいのは per-day の実額だけ */
  function accrue(month, d) {
    const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
    const m = {
      from: month.from,
      days: month.days + 1,
      slots: month.slots.map((s, i) => ({
        guests: s.guests + (d.slots[i].guests | 0),
        sales: s.sales + (d.slots[i].sales | 0),
      })),
      wages: month.wages + (d.wages | 0),
      util: month.util + (d.util | 0),
      extra: {
        bottle: month.extra.bottle + (d.extraBottle | 0),
        tip: month.extra.tip + (d.extraTip | 0),
        other: month.extra.other + (d.extraOther | 0),
      },
      fullDays: month.fullDays + (d.full ? 1 : 0),
      events: Object.assign({}, month.events),
      work: Object.assign({}, month.work),
      nominate: Object.assign({}, month.nominate),
      grow: Object.assign({}, month.grow),
      promo: {
        stage1: month.promo.stage1 + ((d.promo && d.promo.stage1) | 0),
        stage2: month.promo.stage2 + ((d.promo && d.promo.stage2) | 0),
        stage3: month.promo.stage3 + ((d.promo && d.promo.stage3) | 0),
      },
      repFrom: month.repFrom,
      bottlesFrom: month.bottlesFrom.slice(),
      profits: month.profits.concat(d.profit | 0),
    };
    Object.keys(d.events || {}).forEach((k) => { if (d.events[k]) add(m.events, k, d.events[k]); });
    Object.keys(d.work || {}).forEach((id) => {
      const w = m.work[id] || { days: 0, slots: 0 };
      m.work[id] = { days: w.days + 1, slots: w.slots + d.work[id] };
    });
    Object.keys(d.nominate || {}).forEach((id) => { add(m.nominate, id, d.nominate[id]); });
    Object.keys(d.grow || {}).forEach((id) => { add(m.grow, id, d.grow[id]); });
    return m;
  }

  /* 月を締めて月報（report）を一度に作る。純関数（monthly.md §7）。
     **描画側は report を読むだけ。四則演算を一切しない。**
     帯の長さの % までここで出して渡す。そうすれば「締めたとき」
     「読み返したとき」「演出の途中」で同じ数字が出ることが構造的に保証される。

     ctx = { no, toDay, rep, bottles, regulars, names, promotedNames } */
  function closeMonth(month, prev, ctx) {
    /* 場代は**独立して持たない。帯の合計として定義する**（monthly.md §7 / spec.md §5.3）。
       computeDay が sales: slots.reduce(...) と書いているのと同じ形 */
    const bands = month.slots.map((s, i) => ({
      name: SLOTS[i].name, hours: SLOTS[i].hours, guests: s.guests, sales: s.sales, pct: 0,
    }));
    const fee = bands.reduce((a, b) => a + b.sales, 0);
    const guests = bands.reduce((a, b) => a + b.guests, 0);
    const maxSales = bands.reduce((a, b) => Math.max(a, b.sales), 0);
    bands.forEach((b) => { b.pct = maxSales > 0 ? Math.round((b.sales / maxSales) * 100) : 0; });

    const extraTotal = month.extra.bottle + month.extra.tip + month.extra.other;
    const profit = fee + extraTotal - month.wages - month.util;
    const workerDays = Object.keys(month.work).reduce((a, id) => a + month.work[id].days, 0);

    const nameOf = (id) => (ctx.names[id] && ctx.names[id].name) || '';
    const popOf = (id) => (ctx.names[id] && ctx.names[id].pop) | 0;

    /* 「人気 × 出勤日数」は**月報を出すための表示上の指標**であって、
       computeDay に入れる値ではない（monthly.md §7） */
    const top = Object.keys(month.work)
      .filter((id) => ctx.names[id])
      .map((id) => ({ name: nameOf(id), pop: popOf(id), days: month.work[id].days,
                      score: popOf(id) * month.work[id].days }))
      .sort((a, b) => b.score - a.score).slice(0, 3);

    const nominate = Object.keys(month.nominate)
      .filter((id) => ctx.names[id])
      .map((id) => ({ name: nameOf(id), n: month.nominate[id] }))
      .sort((a, b) => b.n - a.n).slice(0, 3);

    const grow = Object.keys(month.grow)
      .filter((id) => ctx.names[id] && month.grow[id] >= 0.05)
      .map((id) => ({ name: nameOf(id), gain: Math.round(month.grow[id] * 10) / 10,
                      promoted: (ctx.promotedNames || {})[id] || null }))
      .sort((a, b) => b.gain - a.gain).slice(0, 5);

    const sum6 = (a) => a.reduce((x, n) => x + (n | 0), 0);
    const pctOf = (now, was) => (was > 0 ? Math.round(((now - was) / was) * 100) : null);
    /* 前期が無いときは差分を出さない。「−」や「±0」も出さない
       （前期が無いことと、変化が無いことは違う。monthly.md §3） */
    const vs = prev ? {
      fee: fee - prev.fee, feePct: pctOf(fee, prev.fee),
      profit: profit - prev.profit, profitPct: pctOf(profit, prev.profit),
      guests: guests - prev.guests, guestsPct: pctOf(guests, prev.guests),
      regulars: (ctx.regulars.s1 + ctx.regulars.s2 + ctx.regulars.s3)
              - (prev.regulars.s1 + prev.regulars.s2 + prev.regulars.s3),
      prevRegulars: prev.regulars,
    } : null;

    return {
      no: ctx.no, fromDay: month.from + 1, toDay: ctx.toDay, days: month.days,
      bands, fee,
      extra: { total: extraTotal, bottle: month.extra.bottle, tip: month.extra.tip, other: month.extra.other },
      wages: month.wages, util: month.util, workerDays,
      profit,
      guests, avgGuests: month.days > 0 ? Math.round(guests / month.days) : 0,
      fullDays: month.fullDays,
      regulars: ctx.regulars, promo: month.promo,
      top, nominate, grow,
      events: month.events,
      bottles: { from: month.bottlesFrom.slice(), now: ctx.bottles.slice(),
                 fromTotal: sum6(month.bottlesFrom), nowTotal: sum6(ctx.bottles) },
      rep: { from: Math.round(month.repFrom), to: Math.round(ctx.rep),
             delta: Math.round(ctx.rep) - Math.round(month.repFrom) },
      vs,
    };
  }

  /* いま集計している期の番号。**months.length では出せない**（上限12で打ち切るため） */
  function nextMonthNo(parlor) {
    const ms = parlor.months;
    return ms.length ? ms[ms.length - 1].no + 1 : 1;
  }

  /* ---------- 月報の描画（monthly.md §7） ----------
     **この関数の中で四則演算をしないこと。**帯の長さの % まで closeMonth が
     report に入れて渡している。ここでやるのは書式（カンマ区切り・符号）と
     並べることだけ。そうすれば「締めたとき」「読み返したとき」「演出の途中」で
     必ず同じ数字が出る。 */
  function renderMonth(r) {
    const num = (n) => Math.round(n).toLocaleString('ja-JP');
    const pct = (v) => (v > 0 ? `+${v}%` : `${v}%`);
    const ev = r.events;

    const bands = r.bands.map((b, i) => `
      <span class="jnMonBand" style="--i:${i}">
        <span class="jnMonBandName">${esc(b.name)}<i>${esc(b.hours)}</i></span>
        <span class="jnMonBandNum">${num(b.guests)}人</span>
        <b>${yen(b.sales)}</b>
        <span class="jnMonTrack"><span class="jnMonFill" data-pct="${b.pct}"></span></span>
      </span>`).join('');

    /* 収支の帯。**四本。**臨時収入の内訳は一段下げて添えるだけで、帯として数えない */
    const sub = (n) => (n >= 0 ? num(n) : `−${num(Math.abs(n))}`);
    const extraSub = [];
    if (r.extra.bottle) extraSub.push(`ボトル ${sub(r.extra.bottle)}`);
    if (r.extra.tip) extraSub.push(`チップ ${sub(r.extra.tip)}`);
    if (r.extra.other) extraSub.push(`祝儀ほか ${sub(r.extra.other)}`);

    const vsFee = r.vs && r.vs.feePct != null ? `<em>${pct(r.vs.feePct)}</em>` : '';
    const vsProfit = r.vs && r.vs.profitPct != null ? `<em>${pct(r.vs.profitPct)}</em>` : '';
    const vsGuests = r.vs && r.vs.guestsPct != null ? `<em>${pct(r.vs.guestsPct)}</em>` : '';

    const top = r.top.map((t, i) => `
      <span class="jnMonTop"><span class="jnMonRank">${['①', '②', '③'][i]}</span>
        <span class="jnMonTopName">${esc(t.name)}</span>
        <span class="jnMonTopSub">人気 ${num(t.pop)}　出勤 ${num(t.days)}日</span></span>`).join('');

    const nominate = r.nominate.length
      ? `<span class="jnMonLine">指名　${r.nominate.map((n) =>
          `${esc(n.name)} ${num(n.n)}回`).join(' ／ ')}</span>` : '';

    const grow = r.grow.length
      ? `<span class="jnMonGrow">${r.grow.map((g) =>
          `<span>${esc(g.name)} +${g.gain.toFixed(1)}${g.promoted
            ? `　<em>${esc(g.promoted)}級に昇格</em>` : ''}</span>`).join('')}</span>` : '';

    const evRows = [];
    if (ev.bottle) evRows.push(`ボトル勝負 ${num(ev.bottle)}回（${num(ev.bottleWin)}勝）`);
    if (ev.arashi) evRows.push(`雀荘荒らし ${num(ev.arashi)}回（${num(ev.arashiWin)}勝）`);
    if (ev.guest) evRows.push(`ゲスト来店 ${num(ev.guest)}回（うちもてなし ${num(ev.treat)}回）`);
    if (ev.shuzai) evRows.push(`雑誌の取材 ${num(ev.shuzai)}回`);
    if (ev.kosho) evRows.push(`卓の故障 ${num(ev.kosho)}回`);
    if (ev.shugi) evRows.push(`祝儀 ${num(ev.shugi)}回`);
    if (ev.oshinobi) evRows.push(`お忍び来店 ${num(ev.oshinobi)}回`);

    /* 常連。**新しく数えているのではなく、parlor.regulars を段階で数えただけ**（§3(4)） */
    const regVs = r.vs
      ? `<span class="jnMonRegVs">先期 ${num(r.vs.prevRegulars.s1)} / ${num(r.vs.prevRegulars.s2)} / ${num(r.vs.prevRegulars.s3)}</span>`
      : '';
    const promo = (r.promo.stage1 || r.promo.stage2 || r.promo.stage3)
      ? `<span class="jnMonLine">今期　顔なじみ +${num(r.promo.stage1)}　常連 +${num(r.promo.stage2)}　主 +${num(r.promo.stage3)}</span>` : '';

    return `<span class="jnMon">
      <span class="jnMonHead" style="--i:0">
        <span class="jnMonNo">第 ${num(r.no)} 期</span>
        <span class="jnMonKessan">決算</span>
        <span class="jnMonRange">${num(r.fromDay)}日目 〜 ${num(r.toDay)}日目</span>
      </span>

      <span class="jnMonSec" style="--i:1"><span class="jnMonH">場代</span>
        ${bands}
        <span class="jnMonRow total"><span>場代</span><b>${yen(r.fee)}</b>${vsFee}</span>
      </span>

      <span class="jnMonSec" style="--i:2"><span class="jnMonH">収支</span>
        <span class="jnMonRow"><span>場代</span><b class="plus">${signedYen(r.fee)}</b></span>
        <span class="jnMonRow"><span>臨時収入</span>
          <b class="${r.extra.total >= 0 ? 'plus' : 'minus'}">${signedYen(r.extra.total)}</b></span>
        ${extraSub.length ? `<span class="jnMonSub">${esc(extraSub.join(' ／ '))}</span>` : ''}
        <span class="jnMonRow"><span>日当（延べ ${num(r.workerDays)}人）</span>
          <b class="minus">−${yen(r.wages)}</b></span>
        <span class="jnMonRow"><span>家賃・光熱（${num(r.days)}日）</span>
          <b class="minus">−${yen(r.util)}</b></span>
        <span class="jnMonRow total"><span>今期の収支</span>
          <b class="${r.profit >= 0 ? 'plus' : 'minus'}">${signedYen(r.profit)}</b>${vsProfit}</span>
      </span>

      <span class="jnMonSec" style="--i:3"><span class="jnMonH">客と常連</span>
        <span class="jnMonRow"><span>のべ客数</span><b>${num(r.guests)}人</b>${vsGuests}</span>
        <span class="jnMonRow"><span>一日平均</span><b>${num(r.avgGuests)}人</b></span>
        <span class="jnMonRow"><span>満卓だった日</span><b>${num(r.fullDays)}日 / ${num(r.days)}日</b></span>
        <span class="jnMonRow"><span>常連</span>
          <b>顔なじみ ${num(r.regulars.s1)}　常連 ${num(r.regulars.s2)}　主 ${num(r.regulars.s3)}</b></span>
        ${regVs}${promo}
      </span>

      ${r.top.length ? `<span class="jnMonSec" style="--i:4"><span class="jnMonH">今期いちばん客を呼んだ子</span>
        ${top}${nominate}${grow}</span>` : ''}

      ${evRows.length ? `<span class="jnMonSec" style="--i:5"><span class="jnMonH">できごと</span>
        ${evRows.map((l) => `<span class="jnMonEv">${esc(l)}</span>`).join('')}
        <span class="jnMonEv">ボトル在庫 ${num(r.bottles.nowTotal)}本（期首 ${num(r.bottles.fromTotal)}本）</span>
      </span>` : ''}

      <span class="jnMonSec" style="--i:6"><span class="jnMonH">評判</span>
        <span class="jnMonRep">
          <span class="jnMonRepNum">${num(r.rep.from)}</span>
          <span class="jnMonTrack wide"><span class="jnMonFill rep" data-pct="${r.rep.to}"></span></span>
          <span class="jnMonRepNum">${num(r.rep.to)}</span>
          <b class="${r.rep.delta >= 0 ? 'plus' : 'minus'}">${r.rep.delta >= 0 ? '+' : ''}${num(r.rep.delta)}</b>
        </span>
      </span>
    </span>`;
  }

  /* 月報を出す。**表示だけ。何も起こさない**（ask を入れ子にしない・monthly.md §9）。
     帯は0から伸ばし、どこかを触ったら即座に最終形へ飛ぶ（spec.md §1 と同じ考え方）。
     **数字は最初のフレームの前に全部確定している。** */
  function showMonthReport(report) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'popup jnMonWrap';
      ov.innerHTML = `<div class="popupBox jnMonBox" role="dialog" aria-modal="true"
          aria-label="第${report.no}期の決算">
        <div class="popupBody">
          <p class="jnPopText">${renderMonth(report)}</p>
          <div class="jnPopChoices"><button type="button" class="jnPopBtn" data-key="ok">来月へ</button></div>
        </div>
      </div>`;
      document.body.appendChild(ov);

      /* 確定済みの値へ向かって伸ばすだけ。途中の値は計算しない */
      const fills = Array.prototype.slice.call(ov.querySelectorAll('.jnMonFill'));
      const finish = () => {
        ov.classList.add('done');
        fills.forEach((f) => { f.style.width = `${f.dataset.pct}%`; });
      };
      requestAnimationFrame(() => { requestAnimationFrame(() => {
        if (!ov.classList.contains('done')) fills.forEach((f) => { f.style.width = `${f.dataset.pct}%`; });
      }); });
      /* 触ったら飛ばす */
      ov.addEventListener('pointerdown', (e) => { if (!e.target.closest('[data-key]')) finish(); });

      ov.addEventListener('click', (e) => {
        if (!e.target.closest('[data-key]')) return;
        ov.remove();
        resolve('ok');
      });
    });
  }

  /* ---------- シフトの読み書き ----------
     `parlor.shifts` は { [charaId]: [昼, 夕, 夜] } の真偽値。
     **持っていない子の既定は「夜だけ」。**`normalize()` は
     `shifts` を素通しするので、既定はこの関数だけが知っている。
     事務所へUIを移すとき（office/spec.md §6.3）も、読み書きはここを通すこと */
  function shiftOf(parlor, id) {
    const v = parlor.shifts[id];
    return Array.isArray(v) ? v.slice(0, 3) : [false, false, true];
  }

  /* シフトの一枠を裏返して書き戻す。**UIがどこにあっても、書くのはここ一つ。**
     第二段でシフト表を事務所へ移したが（office/spec.md §6.3）、
     移したのはUIだけで保存の形は変えていない。雀荘の単体ページと
     事務所の両方がこの関数を通るので、既定値（夜だけ）の解釈が割れない */
  function setShift(store, id, slot) {
    const st = store.get();
    const parlor = normalize(st.parlor);
    const sh = shiftOf(parlor, id);
    sh[slot] = !sh[slot];
    parlor.shifts = Object.assign({}, parlor.shifts, { [id]: sh });
    store.set({ parlor });
    return sh;
  }

  /* 店に立てる子。**遠征中・依頼中・休みは出勤可能者から外れる**
     （office/spec.md §6.3）。判定の本体は `Office.parlorRoster`。
     `jansou.html` は office.js も読むが、無くても
     「全員が店に立つ」＝いままでどおりに落ちる */
  function parlorRoster(st, list) {
    return typeof Office !== 'undefined' && Office.parlorRoster
      ? Office.parlorRoster(st, list) : list;
  }

  /* ---------- セーブの既定値 ---------- */
  function normalize(p) {
    p = p || {};
    const out = {
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
      /* リニューアルで足したもの（spec.md §11）。既存セーブには無い */
      speed: [1, 2, 4].indexOf(p.speed | 0) >= 0 ? p.speed | 0 : 1,
      bottles: Array.isArray(p.bottles) && p.bottles.length === 6 ? p.bottles.map((n) => n | 0) : [0, 0, 0, 0, 0, 0],
      regulars: p.regulars && typeof p.regulars === 'object' ? p.regulars : {},
      seen: p.seen && typeof p.seen === 'object' ? p.seen : {},   // 一見さんの回数だけ（§7）
      challengedToday: !!p.challengedToday,
    };
    /* 卓の自由配置（placement.md §2）。**既存セーブには無い。**
       毎回ここで突き合わせる（冪等）。floor が無ければ、いままでと同じ絵を組む。
       模様替えをしていない店（auto）は、卓や内装が変わるたびに組み直す */
    out.floor = typeof JansouFloor !== 'undefined' && JansouFloor.reconcile
      ? JansouFloor.reconcile(p.floor, { tables: out.tables, interior: out.interior })
      : (p.floor || null);
    /* 月末決算（monthly.md §8・§10）。**ここに書き忘れると毎日消える。**
       この関数は既知のキーだけで out を組み直しているので、列挙し忘れた
       parlor のキーは次のセーブで落ちる。症状は「月報は出るが全部0」（§9）。
       既存セーブには month が無い。**from に「今日」を入れる**ことで、
       途中から始めたプレイヤーの第1期もまるまる30日ぶんになる（§10） */
    out.month = normalizeMonth(p.month, out.day, out.rep, out.bottles);
    out.months = Array.isArray(p.months) ? p.months.slice(-MONTHS_KEPT) : [];
    return out;
  }

  /* 自分の卓（夜に代表が着く卓）。placement.md §2.1 の floor.mine を優先し、
     指していなければ**いままでどおり最後の卓**にする */
  function myTableOf(parlor, usable) {
    if (!parlor.joinNight || usable <= 0) return -1;
    const m = parlor.floor && parlor.floor.mine;
    return Number.isInteger(m) && m >= 0 && m < usable ? m : usable - 1;
  }

  /* ---------- 一日の売上（純関数） ----------
     cfg = { tables, interior, auto, sign, rep, slotPop:[昼,夕,夜の出勤popの合計],
             slotWorkers:[人数], pullBonus, closedTables, playerNight }
     rng は 0〜1 を返す関数（テストで固定できるように注入する） */
  function computeDay(cfg, rng) {
    rng = rng || Math.random;
    /* **卓が無い日（＝まだ店を持っていない日）は、客も場代もゼロ。**
       下の `Math.max(1, ...)` は「閉鎖した卓が全部を食っても一卓は残す」ための
       クランプなので、そこへ落とすと卓0でも4席ぶんの客が湧いてしまう。
       ここで先に返す。**既存の呼び出しは通らない**——`normalize()` が
       `tables` を最低2に丸めるので、卓が0になるのは
       店を持っていない日（`runClosedDay`）だけ（office/spec.md §1.2） */
    if ((cfg.tables | 0) <= 0) {
      return {
        slots: SLOTS.map((sl) => ({ key: sl.key, name: sl.name, guests: 0, capacity: 0,
                                    sales: 0, full: false })),
        guests: 0, sales: 0,
      };
    }
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
  /* 荒らしの賭けは金ではなくボトル（§9）。言い値は段階3〜4＝6〜12万円で、
     以前の ARASHI_STAKE（10万円）と桁を揃えてある */

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
  /* ---------- 店が無い日（純関数の plan を組むだけ） ----------
     開店資金50万を貯めているあいだも、日は進む（office/spec.md §1.2）。
     **弱小事務所なので最初は店を持てない**が、所属の日当は毎日出ていく。
     「まず店を持つ」が序盤の最初の目標になる。

     やっているのは「営業しない日」を組んで、**既存の締めをそのまま通す**こと。
     卓0で `computeDay` を回すので客0・売上0。日が進み、日当が引かれ、
     月次の決算も（売上0で）出る。**日を進める場所を `settle` 以外に増やさない。**

       dayWorkers: []   … 誰も出勤していない。だから成長も月報の出勤も付かない
       wages           … **所属の全員**ぶん。出勤ではなく契約に対して払う
       util: 0         … 家賃は店のもの。店が無い日は掛からない

     roster は呼ぶ側が渡す（`mount` の閉包と同じ形を外から作らないため） */
  function closedDayPlan(st, list) {
    const parlor = normalize(st.parlor);
    return {
      st0: st, parlor, list, closed: true,
      slotWorkers: [[], [], []], dayWorkers: [],
      day: computeDay({ tables: 0, interior: parlor.interior, auto: parlor.auto,
                        sign: parlor.sign, rep: parlor.rep }),
      ev: null, rolls: {}, fillers: [], challenge: null, arashiTier: 0,
      closedTables: 0, myTable: -1, tableIdx: [],
      timeline: [], summary: null, faces: [], names: {}, tips: 0, combo: null,
      wages: list.reduce((a, c) => a + wageOf(c), 0),
      util: 0,
    };
  }

  /* 店が無い日の結果。割り込みも実対局も無いので、空の results でよい
     （形は `playDay` が作るものと同じ。増やしたら両方に足すこと） */
  function closedDayResults() {
    return { extraMoney: 0, repDelta: 0, lines: ['まだ店がない。今日は営業していない。'],
             favor: {}, buffsAdd: [], extraPlace: {}, myLine: null, bottleMoney: 0,
             treated: false, arashiFought: false, arashiWin: false,
             bottleFought: false, bottleWon: false, bottles: [0, 0, 0, 0, 0, 0] };
  }

  /* 店が無い一日を回してセーブに書く。事務所の昼から呼ばれる。
     戻り値は `settle` のものと同じなので、夜の日報が同じ形で読める */
  function runClosedDay(store, list) {
    const st = store.get();
    const plan = closedDayPlan(st, list || []);
    const out = settle(plan, closedDayResults(), st);
    store.set(out.patch);
    return out;
  }

  /* ---------- 一日の締め（純関数） ----------
     plan と results だけから、セーブへの書き込みを組み立てる。
     **`parlor.day` が進むのはここ一箇所だけ。**乱数も Date も引かない。
     こうしておくと「スキップしても再生しても完全一致」（spec.md §16）が
     構造として守られる。playDay に置くと壊れる。

     **閉包の外に置いてある。**mount の中にあったが、
     店が無い日の締め（`runClosedDay`）と node のテストが同じ関数を
     通れるように、モジュール層へ出した。閉包から借りていたのは
     `parlorOf` だけで、それは `normalize(st.parlor)` そのものだった。 */
  function settle(plan, results, stNow) {
    const { parlor, day, ev, dayWorkers, wages, util } = plan;
    let extraMoney = results.extraMoney, repDelta = results.repDelta;
    const lines = results.lines.slice();
    const buffs0 = parlor.buffs.concat(results.buffsAdd);

    /* くつろぎ席のチップ（placement.md §5.4）。**場代には触れていない。**
       タイムラインの bonus と同額で、スキップでも再生でも同じ値になる */
    if (plan.tips) {
      extraMoney += plan.tips;
      lines.push(`くつろぎ席でチップをもらった（${signedYen(plan.tips)}）`);
    }

    /* 選択の要らないイベントの効き目はここで */
    if (ev && ev.kind === 'shugi') {
      const bonus = day.guests * 500;
      extraMoney += bonus;
      lines.push(`常連たちが祝儀をはずんだ（${signedYen(bonus)}）`);
    } else if (ev && ev.kind === 'oshinobi') {
      const bonus = Math.round(day.slots[2].sales * 0.2);
      extraMoney += bonus; repDelta += 4;
      lines.push(`有名人がお忍びで来店（${signedYen(bonus)}・評判 +4）`);
    } else if (ev && ev.kind === 'shuzai') {
      repDelta += 8;
      buffs0.push({ kind: 'pull', val: 0.15, days: 3 });
      lines.push('雑誌の取材が入った（評判 +8・三日間 客足が伸びる）');
    }

    /* 成長。着順は plan で振ってある */
    const comp = Object.assign({}, stNow.comp);
    const compMax = Object.assign({}, stNow.compMax || {});
    const grades = Object.assign({}, stNow.grades || {});
    const growth = [];
    dayWorkers.forEach((c) => {
      const target = Object.assign({}, c, {
        comp: comp[c.id] != null ? comp[c.id] : c.comp,
        compMax: compMax[c.id],
        rank: grades[c.id] || c.rank,
      });
      const before = target.comp;
      let promoted = null;
      (plan.rolls[c.id] || []).forEach((place) => {
        const res = addExp(target, place, 'practice');
        if (res.promoted) promoted = res.promoted;
      });
      if (results.extraPlace[c.id]) {
        const res = addExp(target, results.extraPlace[c.id], 'practice');
        if (res.promoted) promoted = res.promoted;
      }
      comp[c.id] = target.comp;
      compMax[c.id] = target.compMax;
      grades[c.id] = target.rank;
      if (target.comp - before >= 0.05 || promoted) {
        growth.push({ id: c.id, name: c.name, gain: target.comp - before, promoted });
      }
    });

    const profit = day.sales + extraMoney - wages - util;
    let rep = parlor.rep + repDelta;
    if (profit > 0) rep += 1;
    if (day.slots.some((s) => s.full)) rep += 1;
    rep = Math.min(100, Math.max(0, rep));

    const buffs = buffs0
      .map((b) => Object.assign({}, b, { days: b.days - 1 }))
      .filter((b) => b.days > 0);
    const log = parlor.log.concat({
      day: parlor.day + 1, guests: day.guests, sales: day.sales, profit,
    }).slice(-7);

    /* 常連。今日来た顔を数え、3回目に達した顔だけ名前つきで登録する（§7）。
       「この客を覚える」で日中に登録されたぶんは stNow.parlor に入っている */
    const pNow = normalize(stNow.parlor);
    const meta = {};
    (plan.faces || []).forEach((f) => { meta[f.id] = { typeKey: f.typeKey, favTalent: f.favTalent }; });
    const reg = typeof JansouGuests !== 'undefined'
      ? JansouGuests.bumpRegulars(pNow.regulars, pNow.seen, (plan.faces || []).map((f) => f.id), plan.names || {}, meta)
      : { regulars: pNow.regulars, seen: pNow.seen, promoted: [] };
    reg.promoted.slice(0, 3).forEach((p) => {
      const nm = JansouGuests.displayName(p.guest);
      lines.push(p.stage === 1 ? `${nm} が顔なじみになった`
        : p.stage === 2 ? `${nm} が常連になった` : `${nm} がこの店の主になった`);
    });
    /* くつろぎ席に座った客は、その日のぶんが一つ多く進む（placement.md §5.2）。
       3回で顔なじみ、10回で常連。座り心地のいい席は覚えられやすい */
    (plan.faces || []).forEach((f) => {
      if (!f.combo || f.combo.indexOf('kutsurogi') < 0) return;
      if (reg.regulars[f.id]) {
        reg.regulars[f.id] = Object.assign({}, reg.regulars[f.id],
          { visits: (reg.regulars[f.id].visits || 0) + 1 });
      }
    });
    /* 主に勝つと忠誠が上がる（来店回数が進む）。§9.1 */
    Object.keys(results.visitsBonus || {}).forEach((id) => {
      if (reg.regulars[id]) reg.regulars[id] = Object.assign({}, reg.regulars[id],
        { visits: (reg.regulars[id].visits || 0) + results.visitsBonus[id] });
    });
    /* 常連の主は客を呼ぶ（§6.1）。既存の buffs（取材と同じ経路）で翌日の客足に +4%ずつ、三人まで */
    if (typeof JansouGuests !== 'undefined') {
      const nushis = (plan.faces || []).filter((f) => {
        const r = reg.regulars[f.id]; return r && JansouGuests.stageOf(r.visits || 0) >= 3;
      }).length;
      if (nushis) {
        buffs0.push({ kind: 'pull', val: 0.04 * Math.min(3, nushis), days: 1 });
        lines.push(`主が客を呼んでいる（明日の客足 +${4 * Math.min(3, nushis)}%）`);
      }
      /* 推しが辞めていたら乗り換える。今日の推し（出勤者から選ばれた子）に */
      const rosterIds = new Set((plan.list || []).map((c) => c.id));
      (plan.faces || []).forEach((f) => {
        const r = reg.regulars[f.id];
        if (!r || r.typeKey !== 'oshifan' || r.favTalent == null || rosterIds.has(r.favTalent)) return;
        if (f.favTalent != null && rosterIds.has(f.favTalent)) {
          reg.regulars[f.id] = Object.assign({}, r, { favTalent: f.favTalent });
          const nm = (plan.list.find((c) => c.id === f.favTalent) || {}).name || '';
          lines.push(`${JansouGuests.displayName(r)} の推しが ${nm} に変わった`);
        }
      });
    }
    /* ボトル在庫 */
    const bottles = pNow.bottles.map((n, i) => Math.max(0, (n | 0) + ((results.bottles || [])[i] | 0)));

    /* ---------- 月の集計（monthly.md §5） ----------
       **ここは settle の中＝純関数の中。**乱数も Date も引かない。
       こうしておくと「スキップしても再生しても完全一致」（spec.md §16）が
       自動的に守られる。playDay に置くと壊れる。
       積むのは day と results が**確定させた整数だけ**。平均も割合も入れない */
    const evKind = ev ? ev.kind : null;
    const dayEvents = {
      guest: evKind === 'guest' ? 1 : 0,
      treat: results.treated ? 1 : 0,
      arashi: evKind === 'arashi' ? 1 : 0,
      arashiWin: results.arashiWin ? 1 : 0,
      shuzai: evKind === 'shuzai' ? 1 : 0,
      kosho: evKind === 'kosho' ? 1 : 0,
      shugi: evKind === 'shugi' ? 1 : 0,
      oshinobi: evKind === 'oshinobi' ? 1 : 0,
      bottle: results.bottleFought ? 1 : 0,
      bottleWin: results.bottleWon ? 1 : 0,
    };
    const dayWork = {};
    dayWorkers.forEach((c) => { dayWork[c.id] = shiftOf(parlor, c.id).filter(Boolean).length; });
    const dayNominate = {};
    (plan.timeline || []).forEach((e) => {
      if (e.kind === 'nominate' && e.charaId != null) {
        dayNominate[e.charaId] = (dayNominate[e.charaId] || 0) + 1;
      }
    });
    const dayGrow = {};
    growth.forEach((g) => { if (g.id != null) dayGrow[g.id] = g.gain; });
    const dayPromo = { stage1: 0, stage2: 0, stage3: 0 };
    reg.promoted.forEach((pr) => {
      if (pr.stage >= 1 && pr.stage <= 3) dayPromo['stage' + pr.stage] += 1;
    });
    /* 臨時収入の内訳。**Σ が extraMoney に必ず一致する**ように other を引き算で出す
       （bottleMoney と tips は extraMoney の一部。二重に足さない） */
    const extraTip = plan.tips | 0;
    const extraBottle = results.bottleMoney | 0;
    const month = accrue(normalize(stNow.parlor).month, {
      slots: day.slots.map((s) => ({ guests: s.guests, sales: s.sales })),
      wages, util,
      extraBottle, extraTip, extraOther: extraMoney - extraBottle - extraTip,
      full: day.slots.some((s) => s.full),
      profit,
      events: dayEvents, work: dayWork, nominate: dayNominate, grow: dayGrow, promo: dayPromo,
    });

    /* 締め。**from からの経過で見る。**day % 30 にすると、途中から始めた
       既存セーブの初回が13日ぶんで「一ヶ月」を名乗る（monthly.md §10） */
    const newDay = parlor.day + 1;
    const months = pNow.months.slice();
    let report = null;
    if (newDay - month.from >= MONTH_DAYS) {
      const names = {};
      (plan.list || []).forEach((c) => { names[c.id] = { name: c.name, pop: c.pop || 0 }; });
      const promotedNames = {};
      growth.forEach((g) => { if (g.id != null && g.promoted) promotedNames[g.id] = g.promoted; });
      const counts = { s1: 0, s2: 0, s3: 0 };
      if (typeof JansouGuests !== 'undefined') {
        Object.keys(reg.regulars).forEach((id) => {
          const st = JansouGuests.stageOf(reg.regulars[id].visits || 0);
          if (st >= 3) counts.s3++; else if (st === 2) counts.s2++; else if (st === 1) counts.s1++;
        });
      }
      /* **期の番号は months.length から出さない。**months は直近12期で
         打ち切られるので、13期目以降ずっと「第13期」になってしまう。
         直前の月報の番号から進める（monthly.md §10） */
      const prev = months.length ? months[months.length - 1] : null;
      report = closeMonth(month, prev, {
        no: prev ? prev.no + 1 : 1, toDay: newDay, rep, bottles,
        regulars: counts, names, promotedNames,
      });
      months.push(report);
      if (months.length > MONTHS_KEPT) months.splice(0, months.length - MONTHS_KEPT);
    }

    const favor = Object.assign({}, stNow.favor || {}, results.favor);
    const patch = {
      money: (stNow.money || 0) + profit,
      comp, compMax, grades, favor,
      parlor: Object.assign(pNow, {
        day: parlor.day + 1, rep, buffs, log, challengedToday: false,
        regulars: reg.regulars, seen: reg.seen, bottles,
        /* 締めた月は空の入れ物に置き換える。**空にするのはここだけ。**
           評判・buffs・在庫・常連・配置は持ち越す（monthly.md §6） */
        month: report ? blankMonth(parlor.day + 1, rep, bottles) : month,
        months,
        total: {
          days: parlor.total.days + 1,
          sales: parlor.total.sales + day.sales,
          profit: parlor.total.profit + profit,
          guests: parlor.total.guests + day.guests,
        },
      }),
    };
    return { patch, profit, extraMoney, growth, lines, report };
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

  /* opts（`shell.html` が渡す。単体ページ jansou.html には無い）
       autoRun   … 開いた直後に今日の営業を回す（事務所の「今日を始める」から）
       onDayEnd  … 一日が終わったら呼ぶ（事務所の夜へ返す）

     **営業開始の釦は、事務所がいるときだけ消す。**入口を一本にするため
     （office/spec.md §6.1）。事務所がいるかどうかは `store.startDay` の有無で見る。
     単体ページの store はそれを持たないので、いままでどおり釦が出る。 */
  function mount(root, store, opts) {
    opts = opts || {};
    const hub = typeof store.startDay === 'function';
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

    /* ---------- 営業中の画面 ---------- */
    function render() {
      const st = store.get();
      const parlor = parlorOf(st);
      if (!parlor.open) { renderClosed(); return; }

      const list = roster();
      const interior = INTERIOR[parlor.interior - 1];
      const auto = AUTO[parlor.auto - 1];
      const sign = SIGN[parlor.sign - 1];

      /* シフト表。**事務所がいるときは事務所が持つ**（office/spec.md §6.3）。
         単体ページ（jansou.html）にはハブが無いので、ここに残す */
      const rows = hub ? '' : list.map((c) => {
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
          now: `客足 ×${interior.mul.toFixed(2)}　${interior.see}`,
          next: nextInt ? `「${nextInt.name}」 ×${nextInt.mul.toFixed(2)}` : null,
          cost: nextInt ? nextInt.cost : null,
          gain: nextInt ? nextInt.see : null },
        { key: 'auto', label: `卓の型「${auto.name}」`,
          now: `回転 ×${auto.rot.toFixed(2)}　${auto.see}`,
          next: nextAuto ? `「${nextAuto.name}」 ×${nextAuto.rot.toFixed(2)}` : null,
          cost: nextAuto ? nextAuto.cost : null,
          gain: nextAuto ? nextAuto.see : null },
        { key: 'sign', label: `宣伝「${sign.name}」`,
          now: `新規客 +${Math.round(sign.pull * 100)}%　${sign.see}`,
          next: nextSign ? `「${nextSign.name}」 +${Math.round(nextSign.pull * 100)}%` : null,
          cost: nextSign ? nextSign.cost : null,
          gain: nextSign ? nextSign.see : null },
      ].map((f) => `<div class="jnFacil">
          <span class="jnFacilBody"><span class="jnFacilName">${esc(f.label)}</span>
          <span class="jnFacilNow">${esc(f.now)}</span></span>
          ${f.next ? `<button type="button" class="jnUp" data-up="${f.key}"
              ${(st.money || 0) >= f.cost ? '' : 'disabled'}>
              ${esc(f.next)}${f.gain ? `<i>${esc(f.gain)}が出る</i>` : ''}<b>${yen(f.cost)}</b></button>`
            : `<span class="jnFacilMax">これ以上はありません</span>`}
        </div>`).join('');

      const tableItems = typeof JansouFloor !== 'undefined' ? JansouFloor.tablesOf(parlor.floor).length : parlor.tables;

      const recent = parlor.log.slice(-5).reverse().map((l) =>
        `<div class="jnLogRow"><span>${l.day}日目</span><span>${l.guests}人</span>
         <b class="${l.profit >= 0 ? 'plus' : 'minus'}">${signedYen(l.profit)}</b></div>`).join('');

      root.innerHTML = `
        <h1 class="jnTitle">直営雀荘 <span class="jnDay">${parlor.day}日目</span></h1>
        <div class="jnStats">
          <span class="jnStat">評判 <span class="jnRepTrack"><span class="jnRepFill"
            style="width:${parlor.rep}%"></span></span> <b>${Math.round(parlor.rep)}</b></span>
          <span class="jnStat">第${nextMonthNo(parlor)}期 <b>${parlor.day - parlor.month.from}
            / ${MONTH_DAYS}日</b></span>
          <span class="jnStat">通算 <b class="${parlor.total.profit >= 0 ? 'plus' : 'minus'}">
            ${signedYen(parlor.total.profit)}</b></span>
        </div>

        <div id="jnFloorHost"></div>

        <h2 class="jnSecT">今日のシフト</h2>
        ${hub ? `<p class="jnEmpty">シフトは<b>事務所</b>で組みます。
            配置（店・休み）と同じ場所にまとめました。</p>`
          : list.length ? `<div class="jnShift">${rows}</div>`
          : `<p class="jnEmpty">働ける子がいません。チームを組むか、スカウトで契約してください。</p>`}

        <h2 class="jnSecT">設備</h2>
        <div class="jnFacils">${facil}</div>
        <div class="jnFacilFoot">
          <button type="button" class="jnUp wide" id="jnEdit">模様替え<i>卓や設備を自分で置く（いま ${tableItems}つ）</i></button>
        </div>

        <h2 class="jnSecT">ボトル在庫 <span class="jnSecNote">負けたときに店がおごるぶん。無ければその場で仕入れる</span></h2>
        <div class="jnBottles">${JansouGuests.BOTTLES.map((b) => `<div class="jnBottleRow">
          <span class="jnBottleIcon" data-bottle-icon="${b.tier}"></span>
          <span class="jnBottleBody"><span class="jnBottleName">${esc(b.name)}<i>${esc(b.sub)}</i></span>
            <span class="jnBottleSub">売値 ${yen(b.price)}　在庫 <b>${parlor.bottles[b.tier - 1] | 0}</b>本</span></span>
          <button type="button" class="jnUp small" data-stock="${b.tier}" ${(st.money || 0) >= b.cost ? '' : 'disabled'}>
            仕入れる<b>${yen(b.cost)}</b></button>
        </div>`).join('')}</div>

        <div class="jnRun">
          <label class="jnJoin"><input type="checkbox" id="jnJoin" ${parlor.joinNight ? 'checked' : ''}>
            夜、自分も卓に着く（東風戦・卓をひとつ使う）</label>
          ${hub ? `<p class="jnRunNote">営業は事務所の「今日を始める」から。
            ここは設備とシフトを整える場所です。</p>`
          : `<button type="button" class="jnRunBtn" id="jnRun" ${list.length ? '' : 'disabled'}>
            今日の営業をはじめる</button>`}
        </div>

        ${recent ? `<h2 class="jnSecT">最近の営業</h2><div class="jnLog">${recent}</div>` : ''}
        ${parlor.months.length ? `<button type="button" class="jnMonBtn" id="jnMonLast">
          先月の決算を見る<span>第${parlor.months[parlor.months.length - 1].no}期</span></button>` : ''}
      `;

      /* シフトの切り替え */
      root.querySelectorAll('[data-shift]').forEach((b) => {
        b.addEventListener('click', () => {
          const slot = +b.dataset.slot;
          const sh = setShift(store, +b.dataset.shift, slot);
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

      /* ボトルの仕入れ */
      root.querySelectorAll('[data-stock]').forEach((b) => {
        b.addEventListener('click', () => {
          const s = store.get();
          const bt = JansouGuests.bottleOf(+b.dataset.stock);
          if ((s.money || 0) < bt.cost) return;
          const p = parlorOf(s);
          const bottles = p.bottles.slice();
          bottles[bt.tier - 1] = (bottles[bt.tier - 1] | 0) + 1;
          store.set({ money: s.money - bt.cost });
          setParlor({ bottles });
          render();
        });
      });
      root.querySelectorAll('[data-bottle-icon]').forEach((el) => {
        if (typeof JansouFloor !== 'undefined') el.appendChild(JansouFloor.bottleSvg(+el.dataset.bottleIcon, 2));
      });

      /* 読み返し。**保存済みの月報をそのまま開き直すだけで、数字は作り直さない**
         （monthly.md §4）。だから何度開いても同じものが出る */
      const lastBtn = root.querySelector('#jnMonLast');
      if (lastBtn) lastBtn.addEventListener('click', () => {
        const ms = parlorOf(store.get()).months;
        if (ms.length) showMonthReport(ms[ms.length - 1]);
      });

      root.querySelector('#jnJoin').addEventListener('change', (e) => {
        setParlor({ joinNight: e.target.checked });
      });
      const runBtn = root.querySelector('#jnRun');
      if (runBtn) runBtn.addEventListener('click', () => { runDay(); });
      const editBtn = root.querySelector('#jnEdit');
      if (editBtn) editBtn.addEventListener('click', () => { renderEdit(); });

      mountFloor(root.querySelector('#jnFloorHost'), parlor, list);
    }

    /* ---------- フロア（第一段：静止画） ----------
       docs/design/jansou/spec.md §14 の第1段階。
       いまは「店内のようす」を見せるだけで、再生は第二段で入れる。
       客の並びは日ごとに決まる見た目だけのもので、収支には一切触らない */
    let floorCtl = null;

    function mountFloor(host, parlor, list, editing) {
      if (!host || typeof JansouFloor === 'undefined' || typeof JansouGuests === 'undefined') return;
      if (floorCtl) { floorCtl.destroy(); floorCtl = null; }

      floorCtl = JansouFloor.mount(host, {
        onSpeed: (v) => { setParlor({ speed: v }); floorCtl.render(previewState(parlorOf(store.get()), list)); },
      });
      if (editing) { floorCtl.setEdit(true, editHooks()); return; }
      floorCtl.render(previewState(parlor, list));
    }

    /* ---------- 模様替え（placement.md §7。第二段） ----------
       専用の画面にする。シフトや設備の段と同じ画面に置くと、
       狭い幅で操作の段がフロアから離れてしまう */
    function renderEdit() {
      const st = store.get();
      const parlor = parlorOf(st);
      if (floorCtl) { floorCtl.destroy(); floorCtl = null; }
      root.innerHTML = `
        <h1 class="jnTitle">模様替え</h1>
        <p class="jnLead">卓と設備を自分で置けます。動かすたびに保存されます。
        卓は席4つぶんの広さを使うので、<b>点が打ってあるところ</b>が空いている場所です。
        置ける場所は緑、置けない場所は赤、<b>ものの上に重ねると水色（入れ替え）</b>になります。</p>
        <div id="jnFloorHost"></div>`;
      mountFloor(root.querySelector('#jnFloorHost'), parlor, roster(), true);
      scrollTop();
    }
    function scrollTop() {
      /* 画面を替えたら中身の先頭へ。window.scrollTo ではなく #scroll の中を戻す
         （docs/HANDOVER.md §5「表紙は画面の高さに収める」） */
      const sc = document.getElementById('scroll');
      if (sc) sc.scrollTop = 0;
    }

    /* 模様替えのあいだ、金の出し入れと保存はここが持つ。
       フロア側は「何をしたか」を渡してくるだけ（配置の判定はフロア側の純関数） */
    function editHooks() {
      const tablesNow = () => parlorOf(store.get()).tables;
      return {
        parlor: () => parlorOf(store.get()),
        money: () => store.get().money || 0,
        priceOf: (kind) => {
          if (kind === 'table') {
            const n = tablesNow();
            return n < TABLE_MAX ? { cost: TABLE_COST[n + 1] } : null;
          }
          if (kind === 'plant') return { cost: PLANT_COST };
          return null;
        },
        /* 撤去で戻るのは半額（placement.md §2.4）。卓はいまの卓数の増設費が基準 */
        refundOf: (kind) => {
          if (kind === 'table') return Math.round((TABLE_COST[tablesNow()] || 0) / 2);
          if (kind === 'plant') return Math.round(PLANT_COST / 2);
          return 0;
        },
        canSell: (kind) => (kind === 'table' ? tablesNow() > 2 : kind === 'plant'),
        commit: (floor, change) => {
          const s0 = store.get();
          const p = parlorOf(s0);
          const patch = { floor };
          let money = s0.money || 0;
          if (change.kind === 'buy') {
            money -= change.cost || 0;
            if (change.itemKind === 'table') patch.tables = Math.min(TABLE_MAX, p.tables + 1);
          } else if (change.kind === 'sell') {
            money += change.refund || 0;
            if (change.itemKind === 'table') patch.tables = Math.max(2, p.tables - 1);
          }
          store.set({ money });
          setParlor(patch);
        },
        onDone: () => { render(); },
      };
    }

    /* 見た目だけの並びを作る。日をまたぐと変わるが、同じ日なら同じ絵になる */
    function previewState(parlor, list) {
      const rng = seeded(parlor.day * 7919 + parlor.tables * 31 + parlor.interior);
      let closedTables = 0;
      parlor.buffs.forEach((b) => { if (b.kind === 'closed') closedTables += b.val; });

      const count = JansouFloor.tablesOf(parlor.floor).length;
      const usable = Math.max(0, count - closedTables);
      const myTable = myTableOf(parlor, usable);

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

    /* ---------- 一日の営業 ----------
       計算 → タイムライン → 再生 → 締め（spec.md §1・§5.4）。

       **乱数は prepareDay() で全部使い切る。** 客数・イベント・成長の着順・
       実対局の穴埋め・タイムラインまで先に決める。再生は演出だけで、
       スキップしても倍速でも結果が変わらない。

       割り込み（選択肢・実対局）は再生を止めて従来の流れを行い、
       結果を results に積む。締め（settle）は plan と results の純関数。
       ここが純関数なので、node から「同じ plan と results なら同じ書き込み」を
       確かめられる（tools/test-jansou.js）。 */
    async function runDay() {
      const plan = prepareDay(Math.random);
      const results = await playDay(plan);
      const out = settle(plan, results, store.get());
      store.set(out.patch);
      await showResult(plan, results, out);
      /* 締めは営業と地続き。日報の**次に**もう一枚（monthly.md §4）。
         入れ子にはしない。月報は表示だけで何も起こさない */
      if (out.report) await showMonthReport(out.report);
      /* 事務所から降りてきたときは、ここで夜へ返す。
         **`parlor.day` は上の `settle` の中でもう進んでいる**（office/spec.md §6.1）。
         事務所の「明日へ」は夜を畳むだけで、日を進めない */
      if (typeof opts.onDayEnd === 'function') { opts.onDayEnd(); return; }
      render();
    }

    const placeRoll = (rng) => {
      const r = rng();
      return r < 0.08 ? 1 : r < 0.30 ? 2 : r < 0.65 ? 3 : 4;
    };

    function prepareDay(rng) {
      const st0 = store.get();
      const parlor = parlorOf(st0);
      const list = roster();

      /* 出勤の集計。**遠征中・依頼中・休みの子は先に外す**
         （office/spec.md §6.3）。出勤者が減れば `computeDay()` の入力が
         減るぶんだけ客足が落ちる。**既存の式の範囲内で、新しい項は足していない** */
      const onDuty = parlorRoster(st0, list);
      const slotWorkers = [[], [], []];
      onDuty.forEach((c) => {
        shiftOf(parlor, c.id).forEach((on, i) => { if (on) slotWorkers[i].push(c); });
      });
      const dayWorkers = onDuty.filter((c) => shiftOf(parlor, c.id).some(Boolean));

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
      }, rng);

      const ev = pickEvent(st0, parlor, dayWorkers, rng);

      /* 成長の着順は先に振っておく（§1）。同卓のぶんは割り込みの結果で足す */
      const rolls = {};
      dayWorkers.forEach((c) => {
        const n = shiftOf(parlor, c.id).filter(Boolean).length;
        rolls[c.id] = [];
        for (let i = 0; i < n; i++) rolls[c.id].push(placeRoll(rng));
      });
      /* 実対局の穴埋め客も先に作る */
      const fillers = [1, 2, 3].map((n) => makeRegular(n, rng));

      /* 使える卓。閉鎖した卓は後ろから、自分の卓はその手前 */
      const usable = Math.max(1, parlor.tables - closedTables);
      const myTable = myTableOf(parlor, usable);
      const tableIdx = [];
      for (let i = 0; i < usable; i++) if (i !== myTable) tableIdx.push(i);

      /* 隣接コンボ。ボトルの格（ラウンジ）と結果の一行に使う */
      const combo = typeof JansouFloor !== 'undefined'
        ? JansouFloor.combos(parlor.floor) : { counts: {}, lounge: false, list: [], byId: {} };

      /* 臨時収入と割り込みの置き場所（帯と、帯の中の秒） */
      const bonuses = [], interrupts = [];
      if (ev && ev.kind === 'shugi') bonuses.push({ slot: 2, at: 9, amount: day.guests * 500, label: '祝儀' });
      if (ev && ev.kind === 'oshinobi') bonuses.push({ slot: 2, at: 11, amount: Math.round(day.slots[2].sales * 0.2), label: 'お忍び' });
      if (ev && ev.kind === 'guest') interrupts.push({ slot: 1, at: 5, node: { kind: 'guest' } });
      if (ev && ev.kind === 'arashi') interrupts.push({ slot: 2, at: 6, node: { kind: 'arashi' } });
      if (ev && ev.kind === 'kosho') interrupts.push({ slot: 0, at: 0.5, node: { kind: 'kosho' } });
      if (ev && ev.kind === 'shuzai') interrupts.push({ slot: 1, at: 8, node: { kind: 'shuzai' } });
      if (parlor.joinNight) interrupts.push({ slot: 2, at: 1, node: { kind: 'joinNight' } });

      let timeline = [], summary = null, faces = [], names = {};
      if (typeof JansouFloor !== 'undefined') {
        const built = JansouFloor.build(day, {
          fees: SLOTS.map((s) => s.fee), tableIdx,
          /* 隣接コンボ（placement.md §5）。卓ごとの性質だけを渡す。
             **guests と sales はここでは動かない**（§5.3 の厳密一致） */
          tables: JansouFloor.tableTraits(parlor.floor, tableIdx),
          slotStaff: slotWorkers.map((w) => w.map((c) => c.id)),
          bonuses, interrupts,
          regulars: parlor.regulars, seen: parlor.seen,
          /* 荒らしは pickEvent が唯一の発生源（§9.4）。客タイプ「荒らし」はその姿 */
          visitor: ev && ev.kind === 'arashi' ? { slot: 2, at: 6, typeKey: 'arashi', name: ev.chara.name, stay: 6 } : null,
        }, rng);
        timeline = built.timeline; summary = built.summary;
        faces = summary.faces || [];
        /* 今日来た顔の名前を**先に**作っておく（§1）。締めで3回目に達した顔だけが
           この名前で常連になる。使わなかった名前は捨てる */
        faces.forEach((f) => {
          if (parlor.regulars[f.id]) return;
          const g = JansouGuests.makeGuest(f.typeKey, rng);
          names[f.id] = { sei: g.sei, mei: g.mei, nijina: g.nijina, sex: g.sex };
        });
      } else {
        /* フロアが無い環境（テストなど）。割り込みだけ順に並べる */
        timeline = interrupts.map((x) => ({ t: 0, kind: 'interrupt', node: x.node }));
      }

      /* ---- ボトル勝負（§9）。誰が挑んでくるかも先に決める（§1） ----
         一日に多くて一組。荒らしは pickEvent が唯一の発生源で、言い値だけここで決める */
      let challenge = null;
      if (typeof JansouFloor !== 'undefined' && typeof JansouGuests !== 'undefined') {
        challenge = JansouGuests.pickChallenge(faces, parlor.regulars,
          { rep: parlor.rep, lounge: !!combo.lounge }, rng);
        if (challenge) {
          const arr = timeline.find((e) => e.kind === 'arrive' && e.guestId === challenge.guestId);
          if (arr) {
            const reg = parlor.regulars[challenge.guestId];
            const type = JansouGuests.BY_KEY[challenge.typeKey];
            challenge.slot = arr.slot;
            challenge.name = reg ? JansouGuests.displayName(reg) : type.alias;
            challenge.visits = reg ? reg.visits + 1 : 1;
            /* 実対局の相手。強さは卓の格に合わせる */
            const strength = { nushi: 42, uchishi: 68, shachou: 36 }[challenge.kind] || 40;
            challenge.chara = { id: 9300, name: challenge.name, guest: true, pop: 0, salary: 0,
              rank: challenge.kind === 'uchishi' ? 'A' : 'C',
              style: Object.keys(STYLES)[Math.floor(rng() * Object.keys(STYLES).length)],
              comp: strength + rng() * 8 };
            JansouFloor.insertEvent(timeline, { t: arr.t + 1.8, kind: 'interrupt',
              node: { kind: 'bottle', guestId: challenge.guestId } });
          } else challenge = null;
        }
      }
      const arashiTier = ev && ev.kind === 'arashi' && typeof JansouGuests !== 'undefined'
        ? JansouGuests.arashiTier(rng) : 0;
      /* チップの合計。**再生では1円も動かない。**タイムラインに入っている
         bonus の合計と必ず一致し、settle が臨時収入に足す（placement.md §5.4） */
      const tips = (summary && summary.tips) | 0;

      return {
        st0, parlor, list, slotWorkers, dayWorkers, day, ev, rolls, fillers, challenge, arashiTier,
        closedTables, myTable, tableIdx, timeline, summary, faces, names, tips, combo,
        wages: dayWorkers.reduce((a, c) => a + wageOf(c), 0),
        util: utilOf(parlor.tables),
      };
    }

    /* ---------- 再生 ---------- */
    async function playDay(plan) {
      const results = { extraMoney: 0, repDelta: 0, lines: [], favor: {}, buffsAdd: [],
                        extraPlace: {}, myLine: null,
                        /* bottleMoney は extraMoney の**内訳**（月報の帯を割るためだけ・monthly.md §3）。
                           収支には extraMoney しか使わない。二重に足さないこと */
                        bottleMoney: 0,
                        /* 月報の「できごと」を数えるための印（monthly.md §3(6)）。
                           収支には一切効かない */
                        treated: false, arashiFought: false, arashiWin: false,
                        bottleFought: false, bottleWon: false,
                        bottles: [0, 0, 0, 0, 0, 0], visitsBonus: {}, challenged: false, evicted: false };
      if (typeof JansouFloor === 'undefined') {
        for (const e of plan.timeline) if (e.kind === 'interrupt') await handleInterrupt(e.node, plan, results);
        return results;
      }
      if (floorCtl) { floorCtl.destroy(); floorCtl = null; }
      root.innerHTML = '<div id="jnPlay"></div>';
      const host = root.querySelector('#jnPlay');
      floorCtl = JansouFloor.mount(host, { onSpeed: (v) => setParlor({ speed: v }) });
      const el = floorCtl.el;
      await floorCtl.play(plan.timeline, {
        parlor: plan.parlor,
        staff: plan.dayWorkers.map((c) => ({ id: c.id, name: c.name })),
        closedTables: plan.closedTables, myTable: plan.myTable,
        speed: plan.parlor.speed || 1,
        onInterrupt: async (node) => {
          el.classList.add('paused');
          try { await handleInterrupt(node, plan, results); }
          finally { el.classList.remove('paused'); }
        },
        onGuestTap: (g) => showGuestCard(g, plan),
      });
      return results;
    }

    /* ---------- 割り込み（選択肢・実対局。§1 の例外） ---------- */
    async function handleInterrupt(node, plan, results) {
      const st0 = plan.st0, ev = plan.ev, dayWorkers = plan.dayWorkers;
      const R = results;
      if (node.kind === 'guest' && ev && ev.chara) {
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
        const base = (st0.favor || {})[g.id] || 0;
        if (k === 'treat') {
          R.extraMoney -= 30000; R.favor[g.id] = Math.min(100, base + 15); R.repDelta += 2;
          R.treated = true;
          R.lines.push(`${g.name} をもてなした（好感度 +15）`);
        } else {
          R.favor[g.id] = Math.min(100, base + 4);
          R.lines.push(`${g.name} が来店（好感度 +4）`);
        }
      } else if (node.kind === 'arashi' && ev && ev.chara) {
        /* 黙らせる一局。金は賭けない。負けたほうがボトルを入れる（§9.1）。
           打たない解決策（用心棒・警察・主）を必ず残す（§9.3） */
        await runBottle({ kind: 'arashi', tier: plan.arashiTier || 3, chara: ev.chara,
          name: ev.chara.name, visits: 0, slot: 2 }, plan, R);
      } else if (node.kind === 'bottle' && plan.challenge) {
        await runBottle(plan.challenge, plan, R);
      } else if (node.kind === 'kosho') {
        const k = await ask({
          title: '卓がひとつ壊れた',
          text: '古い卓の山が上がらなくなりました。',
          choices: [
            { key: 'fix', label: 'すぐ修理する', note: '50,000円', disabled: (st0.money || 0) < 50000 },
            { key: 'leave', label: '明日は一卓閉める', note: '評判 −2' },
          ],
        });
        if (k === 'fix') { R.extraMoney -= 50000; R.lines.push('壊れた卓を修理した（−50,000円）'); }
        else {
          R.buffsAdd.push({ kind: 'closed', val: 1, days: 1 });
          R.repDelta -= 2;
          R.lines.push('明日は一卓閉めることにした（評判 −2）');
        }
      } else if (node.kind === 'shuzai') {
        await ask({
          title: '雑誌の取材が入った',
          text: '記者が店の様子を書いていきました。しばらく客足が伸びます。',
          choices: [{ key: 'ok', label: 'ありがたい' }],
        });
      } else if (node.kind === 'joinNight') {
        const night = plan.slotWorkers[2].slice().sort((a, b) => (b.pop || 0) - (a.pop || 0));
        const table = [playerCard()].concat(night.slice(0, 3));
        for (let i = 0; table.length < 4; i++) table.push(plan.fillers[i]);
        const rank = await playOrSimulate(table, '店の卓で一局');
        const mine = rank.find((r) => r.chara.id === 0);
        if (mine && mine.place === 1) {
          R.extraMoney += 20000; R.repDelta += 2;
          R.myLine = 'あなたのトップに祝儀が飛んだ（+20,000円・評判 +2）';
        } else if (mine) {
          R.myLine = `店の卓で${mine.place}着だった`;
        }
        /* 同卓した子には実戦のぶんも経験が入る */
        rank.forEach((r) => { if (!r.chara.guest && r.chara.id !== 0) R.extraPlace[r.chara.id] = r.place; });
      }
    }

    /* ---------- ボトル勝負（§9）。ダイアログ → 実対局 → 結果 ----------
       金は賭けない。勝てば客が入れて売上、負ければ店がおごって在庫が減る。
       **代表が打てるのは1日1回**（§9.3）。二組目は「受けて立つ」が押せない */
    async function runBottle(ch, plan, R) {
      const G = JansouGuests;
      const bottle = G.bottleOf(ch.tier);
      const stock = parlorOf(store.get()).bottles[ch.tier - 1] | 0;
      const nushiHere = plan.faces.some((f) => {
        const r = plan.parlor.regulars[f.id];
        return r && G.stageOf(r.visits || 0) >= 3 && f.id !== ch.guestId;
      });
      const k = await askBottle(ch, bottle, stock, R.challenged, nushiHere);
      const night = plan.day.slots[2].sales;
      const apply = (outcome) => {
        const res = G.resolveBottle(ch.kind, ch.tier, outcome, stock, { nightSales: night });
        R.extraMoney += res.extraMoney; R.repDelta += res.repDelta;
        R.bottleMoney += res.extraMoney;          // 内訳のためだけに控える（収支は extraMoney）
        /* 月報の「できごと」（monthly.md §3(6)）。打った回と勝った回だけ数える。
           断った・用心棒・警察・主に任せたは「打っていない」ので数えない */
        if (outcome === 'win' || outcome === 'lose' || outcome === 'aceWin' || outcome === 'aceLose') {
          if (ch.kind === 'arashi') { R.arashiFought = true; if (outcome === 'win' || outcome === 'aceWin') R.arashiWin = true; }
          else { R.bottleFought = true; if (outcome === 'win') R.bottleWon = true; }
        }
        R.bottles[ch.tier - 1] += res.bottleDelta;
        R.buffsAdd = R.buffsAdd.concat(res.buffs);
        res.lines.forEach((l) => R.lines.push(l));
        if (res.visitsBonus && ch.guestId) R.visitsBonus[ch.guestId] = (R.visitsBonus[ch.guestId] || 0) + res.visitsBonus;
        if (res.evicted) R.evicted = true;
      };

      if (k === 'me') {
        R.challenged = true;
        setParlor({ challengedToday: true });
        const mates = plan.slotWorkers[ch.slot != null ? ch.slot : 2].slice(0, 2);
        const table = [playerCard(), ch.chara].concat(mates);
        for (let i = 0; table.length < 4; i++) table.push(plan.fillers[i]);
        const rank = await playOrSimulate(table, bottle.name + 'を賭けた一局');
        const mine = rank.find((r) => r.chara.id === 0);
        const his = rank.find((r) => r.chara.id === ch.chara.id);
        apply(mine && his && mine.place < his.place ? 'win' : 'lose');
      } else if (k === 'ace') {
        const best = plan.dayWorkers.slice().sort((x, y) => strengthOf(y, STYLES) - strengthOf(x, STYLES))[0];
        const table = [best, ch.chara].concat(plan.dayWorkers.filter((c) => c.id !== best.id).slice(0, 2));
        for (let i = 0; table.length < 4; i++) table.push(plan.fillers[i]);
        const rank = simulateTable(table, STYLES);
        const hers = rank.find((r) => r.chara.id === best.id);
        const his = rank.find((r) => r.chara.id === ch.chara.id);
        apply(hers.place < his.place ? 'aceWin' : 'aceLose');
      } else {
        apply(k);   // refuse / guard / police / nushiShoo
      }
    }

    function askBottle(ch, bottle, stock, challenged, nushiHere) {
      return new Promise((resolve) => {
        const G = JansouGuests;
        const C = G.CHALLENGES[ch.kind];
        const stars = '★'.repeat(bottle.stars);
        const isArashi = ch.kind === 'arashi';
        const buttons = [];
        buttons.push({ key: 'me', label: '受けて立つ', gold: true, disabled: challenged,
          note: challenged ? '今日はもう打ちました' : '実際に一半荘を打つ' });
        if (isArashi) {
          const best = roster()[0];
          buttons.push({ key: 'ace', label: 'エースに任せる', note: '結果は自動処理', disabled: !best });
          if (nushiHere) buttons.push({ key: 'nushiShoo', label: '主に任せる', note: '常連の主が追い返す' });
          buttons.push({ key: 'guard', label: '用心棒を呼ぶ', note: '30,000円', disabled: (store.get().money || 0) < 30000 });
          buttons.push({ key: 'police', label: '警察を呼ぶ', note: '評判 −2' });
        } else {
          buttons.push({ key: 'refuse', label: ch.kind === 'uchishi' ? '丁重に断る' : ch.kind === 'nushi' ? 'また今度に' : '丁重に断る',
            note: ch.kind === 'uchishi' ? '評判 −1' : '何も起きない' });
        }
        const ov = document.createElement('div');
        ov.className = 'popup jnBottleWrap';
        ov.innerHTML = `<div class="popupBox jnBottle" role="dialog" aria-modal="true" aria-label="${esc(C.title)}">
          <div class="jnBtHead"><span class="jnBtTitle">${esc(bottle.name)}を賭けた勝負</span>
            <span class="jnBtRank">格 ${stars}</span></div>
          <div class="jnBtBody">
            <div class="jnBtSub">${esc(C.title)}</div>
            <div class="jnBtTop">
              <div class="jnBtSprite"></div>
              <div class="jnBtWho">
                <div class="jnBtName">${esc(ch.name)}</div>
                <div class="jnBtMeta">${esc(C.who)}${ch.visits ? `・来店 ${ch.visits}回` : ''}</div>
                <div class="jnBtTalk">${esc(C.talk)}</div>
              </div>
            </div>
            <div class="jnBtStake">
              <div class="jnBtBottle"></div>
              <dl>
                <dt>賭けるもの</dt><dd class="big">${esc(bottle.name)}（${esc(bottle.sub)}）1本</dd>
                <dt>店のボトル在庫</dt><dd>${stock}本${stock ? '' : '（無ければ仕入れて出す）'}</dd>
                <dt>勝てば</dt><dd class="plus">客が入れる <b>+${bottle.price.toLocaleString('ja-JP')}円</b></dd>
                <dt>負ければ</dt><dd class="minus">${ch.kind === 'nushi' ? '失うものなし（主のおごり）'
                  : `店がおごる <b>在庫 −1本</b>${stock ? '' : `（仕入れ ${bottle.cost.toLocaleString('ja-JP')}円）`}`}</dd>
              </dl>
            </div>
            <div class="jnBtBtns">${buttons.map((b) =>
              `<button type="button" class="jnBtBtn${b.gold ? ' gold' : ''}" data-key="${b.key}" ${b.disabled ? 'disabled' : ''}>
                ${esc(b.label)}<span>${esc(b.note || '')}</span></button>`).join('')}</div>
            <div class="jnBtNotes">
              <div>※ 受けると実際に一半荘を打ちます。${ch.kind === 'uchishi' ? '断ると評判が少し下がります。' : '断っても評判は下がりません。'}</div>
              <div>※ 代表が打てるのは <b>1日1回</b> まで（${challenged ? '今日はもう打ちました' : '今日はまだ打っていません'}）</div>
            </div>
          </div>
        </div>`;
        ov.querySelector('.jnBtSprite').appendChild(JansouFloor.spriteSvg(
          ch.kind === 'nushi' ? 'nushi' : ch.kind === 'arashi' ? 'arashi' : ch.typeKey, 5));
        ov.querySelector('.jnBtBottle').appendChild(JansouFloor.bottleSvg(ch.tier, 6));
        document.body.appendChild(ov);
        ov.addEventListener('click', (e) => {
          const b = e.target.closest('[data-key]');
          if (!b || b.disabled) return;
          ov.remove();
          resolve(b.dataset.key);
        });
      });
    }

    /* ---------- 締め（純関数。store には触らない） ----------
       compMax は必ず保存する（引き継ぎ書 §5 の罠）。 */
    /* settle は**モジュール層に出してある**（下の「一日の締め」）。
       純関数なので閉包に置く必要が無く、外に出したことで
         ・`Jansou.settle` として node のテストから直に呼べる
         ・**店が無い日の締め**（`runClosedDay`）が同じ関数を通れる
       ようになった。**日を進める場所はここ一つだけ。** */

    /* ---------- 客カード（§8。customer-card.png が仕様） ----------
       タップで再生が止まり、閉じると再開する（止める・再開は floor 側）。
       「この客を覚える」は regulars への強制登録＝段階1へ */
    function showGuestCard(g, plan) {
      return new Promise((resolve) => {
        const G = JansouGuests;
        const type = G.BY_KEY[g.typeKey] || G.TYPES[0];
        const cat = G.CAT[type.cat];
        const pNow = parlorOf(store.get());
        const reg = pNow.regulars[g.guestId] || null;
        /* 今日の来店を1回に数えて見せる（締めで実際に加算される） */
        const visits = reg ? (reg.visits || 0) + 1 : (pNow.seen[g.guestId] || 0) + 1;
        const info = G.stageInfo(visits);
        const shown = reg ? G.displayName(Object.assign({}, reg, { visits })) : type.alias;
        const isNushi = reg && info.stage >= 3;
        const fav = g.favTalent != null ? (roster().find((c) => c.id === g.favTalent) || {}).name : null;
        const canRemember = !reg && !g.transient && plan.names && plan.names[g.guestId];

        const ov = document.createElement('div');
        ov.className = 'popup jnCardWrap';
        ov.innerHTML = `<div class="popupBox jnCard" role="dialog" aria-modal="true" aria-label="${esc(shown)}"
            style="--jnCat:${cat.color}">
          <div class="jnCardHead"><span class="jnCardType">${esc(isNushi ? '常連の主' : type.name)}</span>
            <span class="jnCardChip">${esc(type.personality)}</span></div>
          <div class="jnCardBody">
            <div class="jnCardTop">
              <div class="jnCardSprite"></div>
              <div class="jnCardWho">
                <div class="jnCardName">${esc(shown)}${g.count > 1 ? `<small>ほか${g.count - 1}人</small>` : ''}</div>
                <div class="jnCardStage">${esc(info.label)}</div>
                <div class="jnCardVisits">来店 <b>${visits}</b>回
                  <span class="jnCardTrack"><span class="jnCardFill" style="width:${Math.round(info.progress * 100)}%"></span></span></div>
                <div class="jnCardNext">${info.next
                  ? `あと${info.next.left}回で${esc(info.next.name)}（${esc(info.next.gain)}）` : 'この店の主'}</div>
              </div>
            </div>
            <dl class="jnCardRows">
              <dt>お目当て</dt><dd>${fav ? esc(fav) : '—'}</dd>
              <dt>今夜のお勘定</dt><dd>${yen(g.amount || 0)}</dd>
              <dt>この店の好み</dt><dd class="like">${esc(G.likeOf(type))}</dd>
            </dl>
            <div class="jnCardTalk">${esc(type.talk)}</div>
            <div class="jnCardBtns">
              ${canRemember ? '<button type="button" class="jnCardBtn gold" data-key="remember">この客を覚える</button>' : ''}
              <button type="button" class="jnCardBtn" data-key="close">とじる</button>
            </div>
          </div>
        </div>`;
        ov.querySelector('.jnCardSprite').appendChild(JansouFloor.spriteSvg(g.look || g.typeKey, 6));
        document.body.appendChild(ov);
        ov.addEventListener('click', (e) => {
          const b = e.target.closest('[data-key]');
          if (!b) return;
          if (b.dataset.key === 'remember' && canRemember) {
            const p = parlorOf(store.get());
            const regulars = Object.assign({}, p.regulars);
            regulars[g.guestId] = Object.assign({
              typeKey: g.typeKey, visits: Math.max(G.STAGE[1].visits, visits) - 1,   // 締めで+1される
              favTalent: g.favTalent != null ? g.favTalent : null,
            }, plan.names[g.guestId]);
            const seen = Object.assign({}, p.seen);
            delete seen[g.guestId];
            setParlor({ regulars: G.trim(regulars), seen });
          }
          ov.remove();
          resolve();
        });
      });
    }

    /* ---------- 結果。時間帯の内訳は再生で見せたので、締めだけ（§12） ---------- */
    async function showResult(plan, results, out) {
      const { day, dayWorkers, wages, util } = plan;
      const growthHTML = out.growth.length
        ? `<div class="jnRepGrowth">${out.growth.map((g) =>
            `<span>${esc(g.name)} +${g.gain.toFixed(1)}${g.promoted ? `　<em>${g.promoted}級に昇格</em>` : ''}</span>`
          ).join('')}</div>` : '';
      const evHTML = out.lines.concat(results.myLine ? [results.myLine] : []).map((l) =>
        `<div class="jnRepEv">${esc(l)}</div>`).join('');
      await ask({
        title: `${plan.parlor.day + 1}日目の営業`,
        html: `<span class="jnRepWrap">
          <span class="jnRepRow total"><span>今日の収支</span><span></span>
            <b class="${out.profit >= 0 ? 'plus' : 'minus'}">${signedYen(out.profit)}</b></span>
          <span class="jnRepRow"><span>場代（${day.guests}人）</span><span></span><b>${yen(day.sales)}</b></span>
          ${out.extraMoney ? `<span class="jnRepRow"><span>臨時</span><span></span>
            <b class="${out.extraMoney >= 0 ? 'plus' : 'minus'}">${signedYen(out.extraMoney)}</b></span>` : ''}
          <span class="jnRepRow"><span>日当（${dayWorkers.length}人）・家賃</span><span></span>
            <b>−${yen(wages + util)}</b></span>
          ${evHTML}
          ${growthHTML}</span>`,
        choices: [{ key: 'ok', label: '閉店する' }],
      });
    }

    render();
    /* 事務所の「今日を始める」から来たとき。画面を組んでから回す */
    if (opts.autoRun) runDay();
  }

  return { mount, shiftOf, setShift, parlorRoster, computeDay, normalize, pickEvent, wageOf, utilOf,
           settle, closedDayPlan, closedDayResults, runClosedDay,
           blankMonth, normalizeMonth, accrue, closeMonth, renderMonth, showMonthReport, nextMonthNo,
           OPEN_COST, SLOTS, TABLE_COST, INTERIOR, AUTO, SIGN, MONTH_DAYS, MONTHS_KEPT };
})();

if (typeof module !== 'undefined') {
  module.exports = { Jansou };
}
