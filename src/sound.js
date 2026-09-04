/* ============================================================
   効果音 — sound.js
   依存：なし（audio/*.wav を読むだけ）

   docs/design/match/spec.md §2。WebAudio で AudioBuffer に decode して持つ。
   new Audio() の使い回しは打牌の連打で遅延と取りこぼしが出るので使わない。

     Sound.init()        AudioContext を作る（ユーザー操作の中で呼ぶこと）
     Sound.load()        音源を decode して持つ。失敗しても対局は続ける
     Sound.play(name)    鳴らす。未初期化・音量0なら黙って何もしない
     Sound.volume(v)     0〜1

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
  const banks = {};           // { 論理名: [AudioBuffer, ...] } 読めたものだけ入る
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

  /* 一本読んで、その論理名の束に足す。**失敗は黙って捨てる**
     （その一本が無いだけで、他が読めていれば鳴る） */
  function loadOne(name, file) {
    return fetch(BASE + file + '.wav')
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then((ab) => new Promise((res, rej) => {
        /* Safari の古い版は Promise を返さない。コールバック形で受ける */
        const p = ctx.decodeAudioData(ab, res, rej);
        if (p && p.then) p.then(res, rej);
      }))
      .then((buf) => { (banks[name] = banks[name] || []).push(buf); })
      .catch(() => { /* 音は無くても打てる */ });
  }

  /* 全部読む。読めなかったものは黙って抜ける（その音だけ鳴らない）。
     **一本も読めなかった論理名は、束ねる前の一本（name.wav）に落ちる。**
     コードを入れてから音源を差し替えるまでの間、打牌が無音になるのを避けるため */
  function load() {
    if (loading) return loading;
    if (!ctx) init();
    if (!ctx || typeof fetch !== 'function') return Promise.resolve();
    const jobs = [];
    NAMES.forEach((name) => filesFor(name).forEach((file) => jobs.push(loadOne(name, file))));
    loading = Promise.all(jobs).then(() => {
      const fallback = NAMES.filter((name) =>
        !(banks[name] && banks[name].length) && filesFor(name)[0] !== name);
      return Promise.all(fallback.map((name) => loadOne(name, name)));
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

  /* 鳴らす。opts.rate で速さ（音程）を、opts.gain で大きさを振れる。
     **打牌の ±3% の揺らぎ（ui.js）はこの上に乗る**——本数の選び分けとは別の話で、
     二つ重ねると同じ一本でも毎回わずかに違って聞こえる */
  function play(name, opts) {
    if (!ctx || vol <= 0) return;
    const bank = banks[name];
    if (!bank || !bank.length) return;
    const i = pickIndex(name, bank.length);
    last[name] = i;
    const buf = bank[i];
    if (!buf) return;
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
    } catch (e) { /* 鳴らなくても続ける */ }
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

  return { init, load, play, volume, ready, loaded, NAMES, FILES, DEFAULT_VOLUME,
    get volumeValue() { return vol; } };
})();

if (typeof module !== 'undefined') module.exports = Sound;
