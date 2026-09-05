/* ============================================================
   効果音 — sound.js
   依存：なし（audio/*.wav を読むだけ）

   docs/design/match/spec.md §2。WebAudio で AudioBuffer に decode して持つ。
   new Audio() の使い回しは打牌の連打で遅延と取りこぼしが出るので使わない。

     Sound.init()        AudioContext を作る（ユーザー操作の中で呼ぶこと）
     Sound.load()        音源を decode して持つ。失敗しても対局は続ける
     Sound.play(name)    鳴らす。未初期化・音量0なら黙って何もしない。
                         **鳴らしたファイル名を返す**（何も鳴らなければ null）
     Sound.volume(v)     0〜1

   確認のための入口（debug.html の「音」の区画が使う。本編は使わない）：

     Sound.sources(name) その名前で読めたファイル名の並び
     Sound.play(n,{file}) その一本を名指しで鳴らす（聴き比べ用。順番の記憶は動かさない）
     Sound.preview(file) audio/ の任意の一本を鳴らす（FILES に無い控えを聴くため）

   **一つの論理名が複数の音源を持てる**（下の FILES）。使っているのは打牌だけで、
   `discard` は `discard1.wav`〜`discard4.wav` から**毎回ちがう一本**を選ぶ。
   **呼ぶ側は何も変わらない。**`Sound.play('discard')` のままで、
   どのファイルを鳴らすかはここが決める（ui.js には一行も要らない）。

   **必ず守ること**
   - AudioContext は一つだけ。対局ごとに作ると端末が音を出さなくなる
   - 初期化はユーザー操作の中で（iframe の自動再生制限）。
     taikai.js の「卓に着く」が自然な解除の口。
     それ以外の入口（雀荘の夜・遠征の一局）から入ったときのために、
     最初のタップで resume する保険も掛けてある
   - 読み込みに失敗しても対局を止めない。音は無くても打てる。
     **音源は手で用意するので、4本が揃わないことがある。**読めたものだけで鳴らす
   - **`NAMES` は論理名9つのまま外へ公開する。**ファイル名の一覧は `FILES` に別に持つ。
     `tools/drive-match.js` が `NAMES`（＝ `Sound.play` に渡る名前）を見ているので、
     ここにファイル名を混ぜると計測ドライバの数え方が壊れる
   - **game.js からは呼ばない。**Node の経済シミュレーションから読まれるので、
     Sound を参照した瞬間にヘッドレスで落ちる。鳴らすのは ui.js（io 層）だけ
   ============================================================ */

const Sound = (() => {
  'use strict';

  /* 論理名。**外に出るのはこれだけ。**ui.js が渡してくる名前でもある */
  const NAMES = ['discard', 'draw', 'call', 'riichi', 'agari', 'deal', 'dora', 'ryuukyoku', 'tap'];

  /* 論理名 → 音源ファイル（拡張子なし）。書いていない名前は同名の一本に落ちる。
     **打牌だけ複数持つ。**一番よく鳴るので、一本だと十七回で機械音に聞こえる。
     ここに足すときは audio/LICENSE.txt の出典欄も一緒に直すこと */
  const FILES = {
    discard: ['discard1', 'discard2', 'discard3', 'discard4'],
  };
  const filesFor = (name) => FILES[name] || [name];

  /* 素材の置き場所。index.html も単体ページもリポジトリ直下にあるので相対でよい */
  const BASE = 'audio/';
  const DEFAULT_VOLUME = 1;

  let ctx = null;             // 一つだけ
  let master = null;
  let vol = DEFAULT_VOLUME;
  /* { 論理名: [{file, buf}, ...] } 読めたものだけ、**FILES に書いた順**で入る。
     順を保つのは、名指しで鳴らす（聴き比べ）ときに毎回同じものが出るようにするため */
  const banks = {};
  const extra = {};           // { ファイル名: AudioBuffer } 論理名に紐づかない一本（確認用）
  const last = {};            // { 論理名: 直前に鳴らした添字 }
  let loading = null;
  let armed = false;

  function init() {
    if (ctx) { resume(); return ctx; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = vol;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null;
      return null;
    }
    resume();
    arm();
    return ctx;
  }

  /* 自動再生制限で suspended のまま作られることがある。
     ユーザー操作の中で resume すれば通る */
  function resume() {
    if (ctx && ctx.state === 'suspended' && ctx.resume) {
      ctx.resume().catch(() => {});
    }
  }

  /* 最初のタップで resume する保険。一度掛ければ十分 */
  function arm() {
    if (armed || typeof document === 'undefined') return;
    armed = true;
    const on = () => { resume(); };
    document.addEventListener('pointerdown', on, { passive: true });
    document.addEventListener('keydown', on, { passive: true });
  }

  /* 一本読んで decode する */
  function fetchBuffer(file) {
    return fetch(BASE + file + '.wav')
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((ab) => new Promise((res, rej) => {
        /* Safari の古い版は Promise を返さない。コールバック形で受ける */
        const p = ctx.decodeAudioData(ab, res, rej);
        if (p && p.then) p.then(res, rej);
      }));
  }

  /* 読んで枠に入れる。**添字で入れる**ので、束の順は FILES のとおりになる
     （並列に取ってくるので、着いた順に push すると毎回並びが変わる）。
     **失敗は黙って捨てる**（その一本が無いだけで、他が読めていれば鳴る） */
  function loadOne(into, name, file, slot) {
    return fetchBuffer(file)
      .then((buf) => { into[name][slot] = { file: file, buf: buf }; })
      .catch(() => { /* 音は無くても打てる */ });
  }

  /* 全部読む。読めなかったものは黙って抜ける（その音だけ鳴らない）。
     **一本も読めなかった論理名は、束ねる前の一本（name.wav）に落ちる。**
     コードを入れてから音源を差し替えるまでの間、打牌が無音になるのを避けるため */
  function load() {
    if (loading) return loading;
    if (!ctx) init();
    if (!ctx || typeof fetch !== 'function') return Promise.resolve();
    const slots = {};
    const jobs = [];
    NAMES.forEach((name) => {
      const files = filesFor(name);
      slots[name] = new Array(files.length);
      files.forEach((file, i) => jobs.push(loadOne(slots, name, file, i)));
    });
    const gather = (from, names) => names.forEach((name) => {
      const got = from[name].filter(Boolean);
      if (got.length) banks[name] = got;
    });
    loading = Promise.all(jobs).then(() => {
      gather(slots, NAMES);
      const fallback = NAMES.filter((name) =>
        !(banks[name] && banks[name].length) && filesFor(name)[0] !== name);
      const back = {};
      return Promise.all(fallback.map((name) => {
        back[name] = new Array(1);
        return loadOne(back, name, name, 0);
      })).then(() => gather(back, fallback));
    }).then(() => {});
    return loading;
  }

  /* どれを鳴らすか。**直前と同じものを続けて選ばない**
     ——4本あっても同じ音が二回続くと、そこだけ耳につく。
     外した残りから等しく引く（引き直すと運が悪いと何度も回る） */
  function pickIndex(name, n) {
    if (n <= 1) return 0;
    const prev = last[name];
    if (prev === undefined) return Math.floor(Math.random() * n);
    let i = Math.floor(Math.random() * (n - 1));
    if (i >= prev) i++;
    return i;
  }

  /* 一本を鳴らす。opts.rate で速さ（音程）を、opts.gain で大きさを振れる */
  function start(buf, opts) {
    if (!buf) return false;
    try {
      if (ctx.state === 'suspended') resume();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const rate = opts && opts.rate ? opts.rate : 1;
      src.playbackRate.value = rate;
      let node = src;
      if (opts && opts.gain !== undefined && opts.gain !== 1) {
        const g = ctx.createGain();
        g.gain.value = opts.gain;
        src.connect(g);
        node = g;
      }
      node.connect(master);
      src.start();
      return true;
    } catch (e) { return false; /* 鳴らなくても続ける */ }
  }

  /* 鳴らす。**鳴らしたファイル名を返す**（何も鳴らなければ null）。
     **打牌の ±3% の揺らぎ（ui.js）はこの上に乗る**——本数の選び分けとは別の話で、
     二つ重ねると同じ一本でも毎回わずかに違って聞こえる。

     opts.file を渡すとその一本を名指しで鳴らす（聴き比べ用）。
     **名指しのときは「直前に鳴らした添字」を動かさない**
     ——確認で押したぶんが、本編の鳴らし分けの順に混ざらないように */
  function play(name, opts) {
    if (!ctx || vol <= 0) return null;
    const bank = banks[name];
    if (!bank || !bank.length) return null;
    let i;
    if (opts && opts.file) {
      i = bank.findIndex((s) => s.file === opts.file);
      if (i < 0) return null;
    } else {
      i = pickIndex(name, bank.length);
      last[name] = i;
    }
    return start(bank[i].buf, opts) ? bank[i].file : null;
  }

  /* audio/ の任意の一本を鳴らす（確認用）。**FILES に無いものも鳴らせる**
     ——控えの discard.wav は普段どの束にも入らないので、これでしか聴けない。
     鳴る経路は play と同じ（同じ AudioContext・同じ master gain） */
  function preview(file, opts) {
    if (!ctx) init();
    if (!ctx) return Promise.resolve(null);
    if (extra[file]) return Promise.resolve(start(extra[file], opts) ? file : null);
    return fetchBuffer(file)
      .then((buf) => { extra[file] = buf; return start(buf, opts) ? file : null; })
      .catch(() => null);
  }

  function volume(v) {
    if (v === undefined || v === null || isNaN(v)) v = DEFAULT_VOLUME;
    vol = Math.max(0, Math.min(1, Number(v)));
    if (master) master.gain.value = vol;
    return vol;
  }

  function ready() { return !!ctx && Object.keys(banks).length > 0; }
  /* その論理名で何本読めたか。0 なら鳴らない。確認とデバッグのためだけ */
  function loaded(name) { return (banks[name] || []).length; }
  /* その名前で読めたファイル名の並び（FILES の順）。確認の一覧を組むのに使う */
  function sources(name) { return (banks[name] || []).map((s) => s.file); }

  return { init, load, play, preview, volume, ready, loaded, sources,
    NAMES, FILES, DEFAULT_VOLUME, get volumeValue() { return vol; } };
})();

if (typeof module !== 'undefined') module.exports = Sound;
