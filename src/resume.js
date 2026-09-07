/* ============================================================
   対局の復帰 — resume.js
   依存：characters.js（JANDOLS / FREE_AGENTS / PLAYER）・game.js（Game.maxKyokuOf）

   `docs/design/match/resume-spec.md`。**局の頭の状態だけを控える。**
   落ちても、その局の頭から打ち直せるようにするための応急処置（§0）。
   落ちること自体は残る——原因の追跡は `docs/BACKLOG.md`。

   使い方（`match.js` が呼ぶ）：

     UI.handStart = (g) => Resume.save(g, seats, opts);   // g.run() の前
     await g.run();
     UI.handStart = null;
     Resume.clear();                                      // showResult の前（§4）

     const rec = Resume.load();   // 開いたとき。無ければ null（§5）

   **`game.js` には置かない。**`game.js` は node でヘッドレス実行されるので
   ブラウザAPIを知らない（`CLAUDE.md`）。`Game` がやるのは
   `io.handStart?.(this)` を呼ぶことだけで、書き出すのはこちら。

   **いまは `match.html` だけが読み込む**（§1）。`build.py` の JS リストには
   入れていないので、本編（`index.html`）では `Resume` が undefined のまま。
   `match.js` はそれを見て黙って何もしない——**本編の振る舞いは変わらない。**
   本編へ移すときに決めることは §9 にある。
   ============================================================ */

const Resume = (() => {
  'use strict';

  /* 形式の版。**中身の意味を変えたら上げること**——古い保存は §5 が黙って捨てる */
  const V = 1;
  const KEY = 'jandol_match_resume_v1';
  /* 古すぎる保存は捨てる（§5）。半日前の対局を「再開しますか」と聞かれても、
     何の局だったか本人が覚えていない */
  const MAX_AGE = 24 * 60 * 60 * 1000;

  /* 控える `opts` は**この5つだけ**（§2）。`Match.play` の opts には
     復帰そのものの値（`kyoku` など）も乗るので、丸ごと控えると
     最上位のキーと二重になり、片方を直したときに必ずずれる */
  const OPT_KEYS = ['length', 'speed', 'showHints', 'discardMode', 'title'];

  /* ---------- localStorage。**全部 try/catch**（§8 段2） ----------
     Safari のプライベートモードは `setItem` で投げる。
     iframe（PLiCy）で読めないこともある（§9）。
     **保存に失敗しても対局は続くこと**——ここで投げると、
     落ちるのを防ぐための仕掛けが、落ちる原因そのものになる */
  function read() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function write(s) {
    try { localStorage.setItem(KEY, s); return true; } catch (e) { return false; }
  }
  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) { /* 消せなくても続ける */ }
  }

  /* ---------- キャラを id から引く（§5 の最後の条件） ----------
     見つからなければ null。**キャラの削除・改番のあと**、
     古い保存で座らせようとすると席が空く。

     探す先に `FREE_AGENTS` を入れてあるのは、`JANDOLS` と id の帯が
     重なっていない（64〜73）ためで、`match.html` の卓には出てこない
     ——**入れても `match.html` の振る舞いは変わらず**、本編へ移したとき
     （契約したフリーの子が卓にいる）に落ちないぶんだけ得をする */
  function charaOf(id) {
    if (typeof PLAYER !== 'undefined' && PLAYER && PLAYER.id === id) return PLAYER;
    const pools = [
      typeof JANDOLS !== 'undefined' ? JANDOLS : null,
      typeof FREE_AGENTS !== 'undefined' ? FREE_AGENTS : null,
    ];
    for (const pool of pools) {
      if (!pool) continue;
      const c = pool.find((x) => x && x.id === id);
      if (c) return c;
    }
    return null;
  }

  /* 長さから決まる最大の局数。**`Game` の式をここに書き写さない**
     ——同じ規則が二か所に散る（`RULES.event` で通った話）。
     `game.js` が無い場面（試験だけを読む）でも壊れないように受け身で引く */
  function maxKyokuOf(length) {
    if (typeof Game !== 'undefined' && Game && typeof Game.maxKyokuOf === 'function') {
      return Game.maxKyokuOf(length);
    }
    return null;
  }

  const whole = (v) => Number.isInteger(v);

  /* ---------- 控える（§3。局の頭で毎回） ----------
     `g` は `Game` そのもの。`deal()` の直後に呼ばれるので、
     ここで読める `kyoku` / `honba` / `riichiSticks` / 持ち点が「局の頭」。

     **`bakaze` と `dealer` は控えない**（§2）。`kyoku` から派生する。
     **局中の状態（山・手牌・河・副露・ドラ）も控えない**——`deal()` が作り直す。

     返すのは書けたかどうか。**呼ぶ側は見なくてよい** */
  function save(g, seats, opts) {
    if (!g || !Array.isArray(seats) || seats.length !== 4) return false;
    const ids = seats.map((c) => (c && typeof c.id === 'number' ? c.id : null));
    /* 誰が座っているか言えないなら控えない。書いても §5 が捨てるだけ */
    if (ids.some((id) => id === null)) return false;

    const keep = {};
    OPT_KEYS.forEach((k) => {
      if (opts && opts[k] !== undefined) keep[k] = opts[k];
    });

    const rec = {
      v: V,
      at: Date.now(),
      seats: ids,
      kyoku: g.kyoku,
      honba: g.honba,
      riichiSticks: g.riichiSticks,
      scores: g.players.map((p) => p.score),
      startDealer: g.startDealer,
      opts: keep,
    };
    let s;
    try { s = JSON.stringify(rec); } catch (e) { return false; }
    return write(s);
  }

  /* ---------- 読む（§5） ----------
     **捨てる条件はここに全部ある。**当たったら黙って消して null を返す
     ——古い保存を「再開しますか」と聞かれても意味が分からない（§5）。

     通ったものは **そのまま `Game` に渡して投げないこと**が約束（§7）。
     `Game` は範囲外で throw するので、丸めや例外の握り潰しはここではやらない
     ——弾くのはこちら側の仕事。

     返すのは控えた記録そのものに `charas`（引き直した4人）を添えたもの。
     どうせ §5 の確認で引いているので、呼ぶ側（§6-3）が引き直さなくてよい */
  function load() {
    const raw = read();
    if (!raw) return null;

    let rec;
    try { rec = JSON.parse(raw); } catch (e) { clear(); return null; }
    if (!rec || typeof rec !== 'object') { clear(); return null; }

    const bad = () => { clear(); return null; };

    if (rec.v !== V) return bad();
    if (!whole(rec.at) || Date.now() - rec.at > MAX_AGE) return bad();
    /* 未来の日付。端末の時計が動いたか、書き換えられたもの */
    if (rec.at > Date.now() + 60 * 1000) return bad();

    if (!Array.isArray(rec.seats) || rec.seats.length !== 4) return bad();
    if (!Array.isArray(rec.scores) || rec.scores.length !== 4) return bad();
    if (!rec.scores.every((v) => Number.isFinite(v))) return bad();

    const opts = (rec.opts && typeof rec.opts === 'object') ? rec.opts : {};
    const max = maxKyokuOf(opts.length);
    if (!whole(rec.kyoku) || rec.kyoku < 1) return bad();
    if (max !== null && rec.kyoku > max) return bad();

    if (!whole(rec.honba) || rec.honba < 0) return bad();
    if (!whole(rec.riichiSticks) || rec.riichiSticks < 0) return bad();
    if (!whole(rec.startDealer) || rec.startDealer < 0 || rec.startDealer > 3) return bad();

    /* キャラの削除・改番のあと。一人でも引けなければ捨てる */
    const charas = rec.seats.map(charaOf);
    if (charas.some((c) => !c)) return bad();
    /* 人間（id 0）がいない卓は `Match.play` が座らせられない */
    if (!rec.seats.includes(0)) return bad();

    return Object.assign({}, rec, { opts, charas });
  }

  /* 局名（§6 の一言で使う）。**表示は `((kyoku-1)%4)+1`、`kyoku>4` なら南**
     ——`game.js` の帯と同じ式。段3 の画面がこれを読む */
  function kyokuName(kyoku, honba) {
    const ba = kyoku > 4 ? '南' : '東';
    return ba + (((kyoku - 1) % 4) + 1) + '局 ' + honba + '本場';
  }

  return { save, load, clear, charaOf, kyokuName, KEY, V, MAX_AGE, OPT_KEYS };
})();

if (typeof module !== 'undefined') module.exports = Resume;
