/* ============================================================
   直営雀荘 — jansou-guests.js
   客タイプ24種の定義・スプライト・名前生成・常連の進行

   依存：なし（純粋なデータと関数だけ。DOMに触らない）
   使う側：jansou-floor.js（描画）／jansou.js（営業の進行）

   仕様は docs/design/jansou/spec.md §6「客タイプ24種」と
   §7「名前と常連システム」。絵は customer-types.png が正。

   ドット絵の作り方は §4.4 と §4.7。12×16のセルに、
   共通の3頭身の体を置いて、髪・服の色と deco（帽子・持ち物）を
   差し替える。色だけで分けると小さくて判別できないので、
   シルエット（髪型・帽子）＋色＋持ち物の3点で描き分ける。

   名前の元データは docs/design/jansou/names.py の移植。
   **姓名・二つ名はすべてリテラルで書くこと（§7）。**
   tools/make-font.py が src/*.js から文字を拾って書体を切り出すので、
   コードポイントから組み立てると拾われず、その字だけ別書体で出る。
   ============================================================ */

const JansouGuests = (() => {
  'use strict';

  /* ---------- パレット ----------
     §4.3 の配色と、§4.7 で実測したスプライトの色。
     1文字＝1ピクセルの添字。'.' は透明 */
  const INK = {
    o: '#3e2c24',   // アウトライン（全スプライト共通）
    s: '#ffd8ae',   // 肌
    S: '#e4ac80',   // あごの影
    w: '#ffffff',   // 目のハイライト
    e: '#2c2434',   // 目
    r: '#ffa89e',   // ほお紅
    m: '#e2786e',   // 口
    h: null,        // 髪（タイプごと）
    H: null,        // 髪の濃いほう
    c: null,        // 服
    C: null,        // 服の濃いほう
    d: null,        // 持ち物・帽子
    D: null,        // 持ち物の濃いほう
  };

  const SHADOW = '#b29e8c';   // 足元の楕円影。床が明るいので必ず敷く（§4.4）

  /* ---------- 体の共通形 ----------
     12列×16行。§4.7 の実測をそのまま起こしてある。
       行0〜1  帽子のための余白
       行2〜9  頭（輪郭・分け目・額・目2段・ほお紅と口・あご・首）
       行10〜15 体（肩・腕・胴・手・裾・輪郭）
     頭は8列（列2〜9）、体は10列（列1〜10）。体のほうが左右に1pxずつ広い。
     手は列0と列11に1pxだけ出す */
  const BODY = [
    '............',
    '............',
    '...oooooo...',
    '..osssssso..',
    '..osssssso..',
    '..oswsswso..',
    '..osesseso..',
    '..orsmmsro..',
    '..oSSSSSSo..',
    '..oooooooo..',
    '.occCCCCcco.',
    '.oCccccccCo.',
    '.occcccccco.',
    'soccccccccos',
    '.oCCCCCCCCo.',
    '.oooooooooo.',
  ];

  /* 歩行の2フレーム目。手を一段上げて腕を振らせる（§4.4） */
  const BODY_WALK = BODY.slice(0, 12).concat([
    'soccccccccos',
    '.occcccccco.',
    '.oCCCCCCCCo.',
    '..oooooooo..',
  ]);

  /* ---------- 髪型（style） ----------
     [行, 左列, 右列, 色] の範囲で顔に重ねる。'h' が髪、'H' が濃いほう。
     顔は列3〜8（6列）、目は列4と7、ほお紅は列3と8にある。

     **色だけで分けると小さくて判別できない（§4.4）。**
     シルエットで分ける要はここ。髪型・帽子・持ち物の3点で描き分ける */
  const HAIR = {
    short: [[3, 3, 8, 'h'], [4, 3, 3, 'H'], [4, 8, 8, 'H']],
    parted: [[3, 3, 4, 'h'], [3, 7, 8, 'h'], [4, 3, 3, 'H'], [4, 8, 8, 'H']],
    bob: [[3, 3, 8, 'h'], [4, 3, 3, 'h'], [4, 8, 8, 'h'], [5, 3, 3, 'H'], [5, 8, 8, 'H']],
    long: [[3, 3, 8, 'h'], [4, 3, 3, 'h'], [4, 8, 8, 'h'],
      [5, 3, 3, 'h'], [5, 8, 8, 'h'], [6, 3, 3, 'H'], [6, 8, 8, 'H']],
    bald: [[3, 3, 3, 'h'], [3, 8, 8, 'h'], [4, 3, 3, 'H'], [4, 8, 8, 'H']],
    bun: [[1, 5, 6, 'h'], [2, 4, 7, 'h'], [3, 3, 8, 'h'], [4, 3, 3, 'H'], [4, 8, 8, 'H']],
    spiky: [[1, 3, 3, 'h'], [1, 5, 5, 'h'], [1, 7, 7, 'h'], [2, 3, 8, 'h'],
      [3, 3, 8, 'h'], [4, 3, 3, 'H'], [4, 8, 8, 'H']],
    pony: [[3, 3, 8, 'h'], [4, 3, 3, 'H'], [4, 8, 8, 'H'],
      [4, 9, 9, 'h'], [5, 9, 9, 'h'], [6, 9, 9, 'H']],
  };

  /* ---------- 帽子・持ち物（deco） ----------
     [行, 左列, 右列, 色] の範囲で重ねる。
     **行文字列で持たない。**12文字の長さを数え間違えると絵が崩れる。
     'd' が deco の色、'D' が濃いほう */
  const DECO = {
    none: [],
    /* かぶりもの。頭の上（行0〜4）に重ねる */
    cap: [[1, 3, 8, 'd'], [2, 2, 9, 'd'], [3, 1, 10, 'D']],
    hat: [[0, 3, 8, 'd'], [1, 2, 9, 'd'], [2, 0, 11, 'D']],
    beret: [[1, 3, 7, 'd'], [2, 2, 8, 'd'], [2, 9, 9, 'D']],
    band: [[4, 3, 8, 'd']],
    visor: [[4, 2, 9, 'd'], [4, 10, 10, 'D']],
    megane: [[5, 3, 8, 'D']],
    /* 持ち物。体の脇（列0か列11）に出す */
    bag: [[11, 11, 11, 'D'], [12, 11, 11, 'd'], [13, 11, 11, 'd']],
    fan: [[9, 11, 11, 'D'], [10, 11, 11, 'd'], [11, 11, 11, 'd']],
    glass: [[11, 11, 11, 'd'], [12, 11, 11, 'D']],
    book: [[12, 11, 11, 'D'], [13, 11, 11, 'd'], [14, 11, 11, 'D']],
    cam: [[11, 0, 0, 'D'], [12, 0, 0, 'd']],
    mic: [[9, 11, 11, 'd'], [10, 11, 11, 'D'], [11, 11, 11, 'D']],
    card: [[12, 11, 11, 'd'], [13, 11, 11, 'd']],
    bottle: [[10, 11, 11, 'D'], [11, 11, 11, 'd'], [12, 11, 11, 'd'], [13, 11, 11, 'd']],
  };

  /* ---------- 客タイプ24種 ----------
     customer-types.png が仕様。4カテゴリ。
     feeMul は演出上の内訳（合計は day.slots[i].sales に合わせる。§5.3）。
     effect は第一段では定義だけ。有効なのは荒らし・常連の主・
     推しファン（見た目のみ）の3つ（§6.2） */
  const CAT = {
    ippan:  { name: '一般客', color: '#96ffb4', note: '店の土台。数で売上をつくる' },
    joukyaku: { name: '上客', color: '#ff56b2', note: '機嫌よく帰すと大きい' },
    yakkai: { name: '厄介', color: '#f05454', note: '放っておくと損をする' },
    tokubetsu: { name: '特別', color: '#60e8ff', note: 'ゲームが動く客' },
  };

  const TYPES = [
    /* ----- 一般客 ----- */
    { key: 'gakusei', name: '学生', cat: 'ippan', style: 'short', alias: 'リュックの人',
      hair: '#78502c', hairDark: '#5a3620', cloth: '#4e96e0', clothDark: '#2c68b0',
      deco: 'bag', decoColor: '#96d658', decoDark: '#5e9432',
      slots: [0], feeMul: 0.8, weight: 14, sex: 'both', personality: 'ねばる',
      talk: '「安いから助かります」', effect: { kind: 'stay', val: 1.4 } },
    { key: 'kaisha', name: '会社帰り', cat: 'ippan', style: 'parted', alias: 'スーツの人',
      hair: '#3e3430', hairDark: '#28201e', cloth: '#a8acb8', clothDark: '#787c8a',
      deco: 'none', decoColor: '#f05454', decoDark: '#b83c3c',
      slots: [1, 2], feeMul: 1.0, weight: 22, sex: 'both', personality: '安定',
      talk: '「一半荘だけ、いいですか」', effect: { kind: 'base' } },
    { key: 'inkyo', name: '隠居', cat: 'ippan', style: 'bald', alias: '毎日来る人',
      hair: '#c6bcb2', hairDark: '#9a9088', cloth: '#8a6a4a', clothDark: '#5e4630',
      deco: 'none', decoColor: '#8a6a4a', decoDark: '#5e4630',
      slots: [0], feeMul: 0.8, weight: 16, sex: 'male', personality: 'まいにち',
      talk: '「またいつもの席で」', effect: { kind: 'daily' } },
    { key: 'couple', name: 'カップル', cat: 'ippan', style: 'long', alias: 'ふたり連れ',
      hair: '#f0a85c', hairDark: '#c07c34', cloth: '#ff84a8', clothDark: '#d65a84',
      deco: 'none', decoColor: '#ff84a8', decoDark: '#d65a84',
      slots: [1], feeMul: 1.0, weight: 10, sex: 'both', personality: 'ふたり',
      talk: '「ふたりで打てる店、少なくて」', effect: { kind: 'group', val: 2 } },
    { key: 'mamatomo', name: 'ママ友', cat: 'ippan', style: 'bob', alias: 'おしゃべりな人',
      hair: '#8a5a3a', hairDark: '#603c24', cloth: '#f8f0e4', clothDark: '#d2c4b0',
      deco: 'bag', decoColor: '#ff84a8', decoDark: '#d65a84',
      slots: [0], feeMul: 1.0, weight: 9, sex: 'female', personality: 'おしゃべり',
      talk: '「ここ、きれいで居心地いいのよね」', effect: { kind: 'group', val: 3 } },
    { key: 'circle', name: 'サークル', cat: 'ippan', style: 'spiky', alias: '学生の集まり',
      hair: '#c8901e', hairDark: '#96680e', cloth: '#f0a020', clothDark: '#b87410',
      deco: 'cap', decoColor: '#48cec8', decoDark: '#2eb2ac',
      slots: [1], feeMul: 0.8, weight: 8, sex: 'both', personality: 'おおぜい',
      talk: '「4人そろったんで一卓ください」', effect: { kind: 'group', val: 4 } },
    { key: 'seito', name: '教室の生徒', cat: 'ippan', style: 'bob', alias: '習いに来た人',
      hair: '#5a4638', hairDark: '#3c2e24', cloth: '#a0d8e8', clothDark: '#6ea8bc',
      deco: 'book', decoColor: '#f8f0e4', decoDark: '#c0b4a4',
      slots: [0], feeMul: 0.8, weight: 7, sex: 'both', personality: 'ならいたい',
      talk: '「今日は鳴きを教わりたくて」', effect: { kind: 'teach' } },

    /* ----- 上客 ----- */
    { key: 'madam', name: 'マダム', cat: 'joukyaku', style: 'bun', alias: '品のいい人',
      hair: '#b07850', hairDark: '#845434', cloth: '#c86ab0', clothDark: '#94407e',
      deco: 'beret', decoColor: '#ffce50', decoDark: '#c89a24',
      slots: [0], feeMul: 1.6, weight: 7, sex: 'female', personality: 'ごきげん',
      talk: '「いい趣味のお店ね」', effect: { kind: 'tip', val: 1.5 } },
    { key: 'kankou', name: '観光客', cat: 'joukyaku', style: 'short', alias: 'カメラの人',
      hair: '#7a5a3a', hairDark: '#543c26', cloth: '#6ec8a0', clothDark: '#3e9670',
      deco: 'hat', decoColor: '#3e3430', decoDark: '#1e1a18',
      slots: [0, 1], feeMul: 1.6, weight: 6, sex: 'both', personality: '気まぐれ',
      talk: '「評判を見て来ました」', effect: { kind: 'repGate', val: 30 } },
    { key: 'oshifan', name: '推しファン', cat: 'joukyaku', style: 'short', alias: 'うちわを持った人',
      hair: '#4a3a30', hairDark: '#2e241e', cloth: '#4e96e0', clothDark: '#2c68b0',
      deco: 'fan', decoColor: '#ff56b2', decoDark: '#c82e86',
      slots: [2], feeMul: 2.0, weight: 8, sex: 'both', personality: '一途',
      talk: '「あの子が出てる日しか来ないんで」', effect: { kind: 'oshi' } },
    { key: 'shachou', name: '社長', cat: 'joukyaku', style: 'parted', alias: '羽振りのいい人',
      hair: '#2e2822', hairDark: '#1a1614', cloth: '#ffce50', clothDark: '#c89a24',
      deco: 'glass', decoColor: '#f8f0e4', decoDark: '#c0b4a4',
      slots: [2], feeMul: 3.0, weight: 4, sex: 'male', personality: 'ごうかい',
      talk: '「いい卓は空いてるかい」', effect: { kind: 'bottle', tier: 4 } },

    /* ----- 厄介 ----- */
    { key: 'yopparai', name: '酔っ払い', cat: 'yakkai', style: 'spiky', alias: '赤い顔の人',
      hair: '#6a4a30', hairDark: '#48301c', cloth: '#e0705a', clothDark: '#ac4834',
      deco: 'bottle', decoColor: '#96d658', decoDark: '#5e9432',
      slots: [2], feeMul: 1.4, weight: 7, sex: 'male', personality: 'うるさい',
      talk: '「まあまあ、もう一杯」', effect: { kind: 'drive', val: 2 } },
    { key: 'arashi', name: '荒らし', cat: 'yakkai', style: 'spiky', alias: '目つきの悪い人',
      hair: '#2a2420', hairDark: '#161210', cloth: '#4a4450', clothDark: '#2c2834',
      deco: 'visor', decoColor: '#4a4450', decoDark: '#2c2834',
      slots: [2], feeMul: -1.0, weight: 0, sex: 'male', personality: 'たちが悪い',
      talk: '「賭けねえなら打つ意味がねえだろ」', effect: { kind: 'arashi' } },
    { key: 'hikinuki', name: '引き抜き屋', cat: 'yakkai', style: 'parted', alias: '名刺を出す人',
      hair: '#3a322c', hairDark: '#221c18', cloth: '#2e3a4e', clothDark: '#182130',
      deco: 'card', decoColor: '#f8f0e4', decoDark: '#c0b4a4',
      slots: [2], feeMul: 0.0, weight: 5, sex: 'male', personality: 'ゆだんならぬ',
      talk: '「もっといい条件、出せますよ」', effect: { kind: 'poach' } },
    { key: 'kanyuu', name: '勧誘マン', cat: 'yakkai', style: 'short', alias: 'しつこい人',
      hair: '#4a3e34', hairDark: '#2e2620', cloth: '#7ab048', clothDark: '#4e7c2a',
      deco: 'book', decoColor: '#f0f0f0', decoDark: '#b8b8b8',
      slots: [1], feeMul: 0.0, weight: 5, sex: 'both', personality: 'しつこい',
      talk: '「ちょっとお話だけでも」', effect: { kind: 'block' } },
    { key: 'gypsy', name: '雀荘ジプシー', cat: 'yakkai', style: 'bob', alias: 'せっかちな人',
      hair: '#54463a', hairDark: '#362c24', cloth: '#6a6a72', clothDark: '#44444c',
      deco: 'none', decoColor: '#6a6a72', decoDark: '#44444c',
      slots: [1, 2], feeMul: 1.0, weight: 8, sex: 'both', personality: 'しびれをきらす',
      talk: '「待つくらいなら余所に行くよ」', effect: { kind: 'impatient' } },
    { key: 'tanomi', name: '他店の主', cat: 'yakkai', style: 'bald', alias: '値踏みする人',
      hair: '#3e3630', hairDark: '#241e1a', cloth: '#3e6a52', clothDark: '#244434',
      deco: 'hat', decoColor: '#3e6a52', decoDark: '#244434',
      slots: [2], feeMul: 1.0, weight: 4, sex: 'male', personality: '値踏み',
      talk: '「なるほどね、この造りか」', effect: { kind: 'rival' } },

    /* ----- 特別 ----- */
    { key: 'uchishi', name: '打ち師', cat: 'tokubetsu', style: 'parted', alias: '静かな人',
      hair: '#26221e', hairDark: '#141210', cloth: '#3a3446', clothDark: '#221e2c',
      deco: 'none', decoColor: '#3a3446', decoDark: '#221e2c',
      slots: [2], feeMul: 1.6, weight: 3, sex: 'both', personality: '手強い',
      talk: '「一局、お願いできますか」', effect: { kind: 'challenge', tier: 3 } },
    { key: 'nushi', name: '常連の主', cat: 'tokubetsu', style: 'bald', alias: 'いつもの人',
      hair: '#5e4a3a', hairDark: '#3e3024', cloth: '#a86a3a', clothDark: '#764620',
      deco: 'cap', decoColor: '#a86a3a', decoDark: '#764620',
      slots: [0, 1, 2], feeMul: 1.2, weight: 0, sex: 'both', personality: '主',
      talk: '「今日もやってるね」', effect: { kind: 'nushi', tier: 1 } },
    { key: 'kisha', name: '記者', cat: 'tokubetsu', style: 'short', alias: '手帳の人',
      hair: '#4a4038', hairDark: '#2c2620', cloth: '#5a6a8a', clothDark: '#384258',
      deco: 'megane', decoColor: '#3e3430', decoDark: '#1e1a18',
      slots: [1], feeMul: 1.0, weight: 3, sex: 'both', personality: 'めざとい',
      talk: '「少しお話うかがえますか」', effect: { kind: 'press' } },
    { key: 'shishou', name: '師匠', cat: 'tokubetsu', style: 'bald', alias: '風格のある人',
      hair: '#b8aca0', hairDark: '#8a8078', cloth: '#8a3a3a', clothDark: '#5c2020',
      deco: 'none', decoColor: '#8a3a3a', decoDark: '#5c2020',
      slots: [2], feeMul: 1.6, weight: 3, sex: 'male', personality: 'おしえたがり',
      talk: '「その切り方は、もったいないな」', effect: { kind: 'master' } },
    { key: 'haishin', name: '配信者', cat: 'tokubetsu', style: 'pony', alias: 'カメラを回す人',
      hair: '#e070b0', hairDark: '#a8447e', cloth: '#2e2a38', clothDark: '#1a1822',
      deco: 'mic', decoColor: '#f0f0f0', decoDark: '#a8a8a8',
      slots: [2], feeMul: 1.0, weight: 3, sex: 'both', personality: 'うつしたがり',
      talk: '「今日は配信させてもらいますね」', effect: { kind: 'stream' } },
    { key: 'motojandol', name: '元雀ドル', cat: 'tokubetsu', style: 'long', alias: 'わけありの人',
      hair: '#d8a0c8', hairDark: '#a8709c', cloth: '#f0c8dc', clothDark: '#c294ac',
      deco: 'none', decoColor: '#f0c8dc', decoDark: '#c294ac',
      slots: [2], feeMul: 1.6, weight: 2, sex: 'female', personality: 'わけあり',
      talk: '「昔は、こっち側にいたの」', effect: { kind: 'comeback' } },
    { key: 'kyoukai', name: '協会の人', cat: 'tokubetsu', style: 'parted', alias: 'かたい人',
      hair: '#38322c', hairDark: '#201c18', cloth: '#26304a', clothDark: '#141a2c',
      deco: 'megane', decoColor: '#26304a', decoDark: '#141a2c',
      slots: [1], feeMul: 1.6, weight: 2, sex: 'male', personality: 'おかたい',
      talk: '「規定に沿った運営ですな」', effect: { kind: 'invite' } },
  ];

  const BY_KEY = {};
  TYPES.forEach((t) => { BY_KEY[t.key] = t; });

  /* ---------- スプライトを組む ----------
     BODY に deco を重ねて、12×16の文字グリッドを返す。
     色の解決は描画側（jansou-floor.js）が INK と type を見て行う */
  function grid(typeKey, frame) {
    const t = BY_KEY[typeKey];
    const base = (frame === 1 ? BODY_WALK : BODY).slice();
    if (!t) return base;
    /* 髪 → 帽子・持ち物 の順。帽子は髪の上に乗る */
    const overlay = (HAIR[t.style] || HAIR.short).concat(DECO[t.deco] || []);
    overlay.forEach(([row, c0, c1, key]) => {
      if (row < 0 || row >= base.length) return;
      const line = base[row].split('');
      for (let c = c0; c <= c1 && c < line.length; c++) line[c] = key;
      base[row] = line.join('');
    });
    return base;
  }

  /* ---------- 名前 ----------
     names.py の移植（§7）。段階が4つある:
       0 一見さん → 通称（タイプ由来）
       1 顔なじみ → 姓のみ
       2 常連     → フルネーム
       3 主       → フルネーム＋二つ名 */
  const SEI = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤',
    '吉田', '山田', '佐々木', '山口', '松本', '井上', '木村', '林', '斎藤', '清水',
    '山崎', '阿部', '森', '池田', '橋本', '石川', '前田', '藤田', '後藤', '岡田',
    '長谷川', '村上', '近藤', '石井', '遠藤', '青木', '坂本', '福田', '太田', '西村'];
  const MEI_M = ['健一', '浩二', '誠', '隆', '拓也', '大輔', '翔太', '和彦', '正雄', '雄一',
    '直樹', '智也', '剛', '光男', '将', '敏夫', '裕介', '俊', '悟', '勝'];
  const MEI_F = ['美咲', '恵子', '由紀', 'さくら', '陽子', '千夏', '愛', '裕子', '麻衣', '綾',
    '真理', '久美', '静香', '琴音', '七海', '和美', '里奈', 'あかり', '桃子', '詩織'];
  const NIJINA = ['ラス回避の', '三色の', '面前一直線の', '鳴き上手の', 'ベタオリの',
    '一発逆転の', 'リーチ一直線の', '国士狙いの', '手役師', '速攻の'];

  const STAGE = [
    { visits: 0, label: 'まだ顔しか知らない' },
    { visits: 3, label: 'まだ名字しか知らない' },
    { visits: 10, label: '名前まで分かっている' },
    { visits: 30, label: 'この店の主' },
  ];
  const MAX_REGULARS = 200;

  const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

  function stageOf(visits) {
    let st = 0;
    for (let i = 0; i < STAGE.length; i++) if (visits >= STAGE[i].visits) st = i;
    return st;
  }

  /* タイプごとの性別の傾向（§7） */
  function sexOf(t, rng) {
    if (t.sex === 'male' || t.sex === 'female') return t.sex;
    return rng() < 0.5 ? 'male' : 'female';
  }

  function makeGuest(typeKey, rng) {
    rng = rng || Math.random;
    const t = BY_KEY[typeKey] || TYPES[0];
    const sex = sexOf(t, rng);
    return {
      typeKey: t.key,
      visits: 1,
      sex,
      sei: pick(SEI, rng),
      mei: pick(sex === 'female' ? MEI_F : MEI_M, rng),
      nijina: pick(NIJINA, rng),
    };
  }

  function displayName(guest) {
    const t = BY_KEY[guest.typeKey] || TYPES[0];
    switch (stageOf(guest.visits || 0)) {
      case 0: return t.alias;
      case 1: return guest.sei + 'さん';
      case 2: return guest.sei + guest.mei;
      default: return guest.nijina + guest.sei + guest.mei;
    }
  }

  /* 来店回数を進める。段階が上がったらその段階を返す */
  function bumpVisit(guest) {
    const before = stageOf(guest.visits || 0);
    guest.visits = (guest.visits || 0) + 1;
    const after = stageOf(guest.visits);
    return { promoted: after > before ? after : null, stage: after };
  }

  /* ---------- 顔の池 ----------
     同じ客が日をまたいで再訪できるように、タイプごとに FACES 人ぶんの
     「顔」を用意して、その中から来る人を選ぶ。顔の id は 'タイプ#番号'。
     一見さんの名前は保存しない。名前が要るのは段階1（3回目）から。

     来店回数は parlor.seen（id → 回数。段階0のあいだだけ、数だけ）で数え、
     3回目に達したときに初めて regulars に名前つきで登録する（§7）。
     seen は id と小さな整数だけなので、200件でも2KBに満たない */
  const FACES = 40;                 // タイプごとの顔の数。終盤の夜（82人）でも尽きにくい数
  const MAX_SEEN = 200;             // 段階0の回数を覚えておく上限

  function faceId(typeKey, n) { return typeKey + '#' + n; }
  function typeOfFace(id) { return String(id).split('#')[0]; }

  /* 来る顔を選ぶ。知っている顔（常連 → 顔なじみ候補）を優先して、
     残りは池から。知っている顔は再訪しやすくしないと常連が育たない */
  function pickFace(typeKey, regulars, seen, rng) {
    const known = [];
    Object.keys(regulars || {}).forEach((id) => { if (typeOfFace(id) === typeKey) known.push(id); });
    Object.keys(seen || {}).forEach((id) => { if (typeOfFace(id) === typeKey && !(regulars && regulars[id])) known.push(id); });
    if (known.length && rng() < 0.55) return known[Math.floor(rng() * known.length)];
    return faceId(typeKey, Math.floor(rng() * FACES));
  }

  /* この店の好み。タイプの性格から一言で */
  const LIKES = {
    stay: '長居できる席が好き', base: '駅から近いのが気に入っている', daily: '昼の静けさが気に入っている',
    group: 'にぎやかな卓が好き', teach: '教えてもらえるのがうれしい', tip: '内装が気に入っている',
    repGate: '評判を見て来た', oshi: '推しが出ている日しか来ない', bottle: 'いい卓と高い酒が好き',
    drive: '酒があれば満足', arashi: '賭けられる相手を探している', poach: '雀ドルを値踏みしている',
    block: '話を聞いてくれる人を探している', impatient: '待たされるのが嫌い', rival: '設備を見に来ている',
    challenge: '強い相手を探している', nushi: 'この店が居場所', press: 'ネタを探している',
    master: '教えたがっている', stream: '映える店が好き', comeback: '昔を思い出しに来ている',
    invite: '運営の堅さを見ている',
  };
  function likeOf(type) { return LIKES[(type.effect || {}).kind] || '居心地のいい店が好き'; }

  /* 段階の説明と、次の段階までの残り */
  function stageInfo(visits) {
    const st = stageOf(visits);
    const next = STAGE[st + 1] || null;
    const names = ['一見さん', '顔なじみ', '常連', '主'];
    const gains = ['名字が分かる', 'フルネームが分かる', '二つ名がつく', ''];
    return {
      stage: st, label: STAGE[st].label, name: names[st],
      next: next ? { visits: next.visits, left: next.visits - visits, name: names[st + 1], gain: gains[st] } : null,
      progress: next ? (visits - STAGE[st].visits) / (next.visits - STAGE[st].visits) : 1,
    };
  }

  /* 常連の記録。一見さん（段階0）は保存しない。
     上限200人、超えたら訪問回数の少ない順に落とす（§7） */
  function trim(regulars) {
    const keys = Object.keys(regulars);
    if (keys.length <= MAX_REGULARS) return regulars;
    keys.sort((a, b) => (regulars[a].visits || 0) - (regulars[b].visits || 0));
    const out = Object.assign({}, regulars);
    keys.slice(0, keys.length - MAX_REGULARS).forEach((k) => { delete out[k]; });
    return out;
  }

  /* 一日の来店を常連の記録に反映する（純関数。store には触らない）。
       ids   … 今日来た顔の id（同じ人は一日に一度だけ数える）
       names … 今日はじめて名前が要るかもしれない顔の名前（prepareDay で先に作る）
       meta  … id → {typeKey, favTalent}
     3回目に達した顔だけを regulars に登録し、seen から外す。
     一見さん（1〜2回）は seen に回数だけ残る（§7） */
  function bumpRegulars(regulars, seen, ids, names, meta) {
    regulars = Object.assign({}, regulars || {});
    seen = Object.assign({}, seen || {});
    const promoted = [];
    Array.from(new Set(ids)).forEach((id) => {
      if (regulars[id]) {
        const r = Object.assign({}, regulars[id]);
        const before = stageOf(r.visits || 0);
        r.visits = (r.visits || 0) + 1;
        if (stageOf(r.visits) > before) promoted.push({ id, stage: stageOf(r.visits), guest: r });
        regulars[id] = r;
        return;
      }
      seen[id] = (seen[id] || 0) + 1;
      if (seen[id] >= STAGE[1].visits && names && names[id]) {
        const m = (meta && meta[id]) || {};
        regulars[id] = Object.assign({ typeKey: m.typeKey || typeOfFace(id), visits: seen[id],
          favTalent: m.favTalent || null }, names[id]);
        promoted.push({ id, stage: 1, guest: regulars[id] });
        delete seen[id];
      }
    });
    return { regulars: trim(regulars), seen: trimSeen(seen), promoted };
  }

  /* seen も同じく上限で落とす（回数の少ない順） */
  function trimSeen(seen) {
    const keys = Object.keys(seen);
    if (keys.length <= MAX_SEEN) return seen;
    keys.sort((a, b) => (seen[a] || 0) - (seen[b] || 0));
    const out = Object.assign({}, seen);
    keys.slice(0, keys.length - MAX_SEEN).forEach((k) => { delete out[k]; });
    return out;
  }

  return {
    TYPES, BY_KEY, CAT, INK, SHADOW, BODY, HAIR, DECO, STAGE, MAX_REGULARS, MAX_SEEN, FACES,
    SEI, MEI_M, MEI_F, NIJINA,
    grid, makeGuest, displayName, bumpVisit, stageOf, stageInfo, trim, trimSeen,
    faceId, typeOfFace, pickFace, likeOf, bumpRegulars,
  };
})();

if (typeof module !== 'undefined') {
  module.exports = { JansouGuests };
}
