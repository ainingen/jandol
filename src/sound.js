/* ============================================================
   効果音 — sound.js
   依存：なし（audio/*.wav を読むだけ）

   docs/design/match/spec.md §2。WebAudio で AudioBuffer に decode して持つ。
   new Audio() の使い回しは打牌の連打で遅延と取りこぼしが出るので使わない。

     Sound.init()        AudioContext を作る（ユーザー操作の中で呼ぶこと）
     Sound.load()        9つを decode して持つ。失敗しても対局は続ける
     Sound.play(name)    鳴らす。未初期化・音量0なら黙って何もしない
     Sound.volume(v)     0〜1

   **必ず守ること**
   - AudioContext は一つだけ。対局ごとに作ると端末が音を出さなくなる
   - 初期化はユーザー操作の中で（iframe の自動再生制限）。
     taikai.js の「卓に着く」が自然な解除の口。
     それ以外の入口（雀荘の夜・遠征の一局）から入ったときのために、
     最初のタップで resume する保険も掛けてある
   - 読み込みに失敗しても対局を止めない。音は無くても打てる
   - **game.js からは呼ばない。**Node の経済シミュレーションから読まれるので、
     Sound を参照した瞬間にヘッドレスで落ちる。鳴らすのは ui.js（io 層）だけ
   ============================================================ */

const Sound = (() => {
  'use strict';

  const NAMES = ['discard', 'draw', 'call', 'riichi', 'agari', 'deal', 'dora', 'ryuukyoku', 'tap'];
  /* 素材の置き場所。index.html も単体ページもリポジトリ直下にあるので相対でよい */
  const BASE = 'audio/';
  const DEFAULT_VOLUME = 1;

  let ctx = null;             // 一つだけ
  let master = null;
  let vol = DEFAULT_VOLUME;
  const buffers = {};
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

  /* 9つを読む。失敗したものは黙って抜ける（その音だけ鳴らない） */
  function load() {
    if (loading) return loading;
    if (!ctx) init();
    if (!ctx || typeof fetch !== 'function') return Promise.resolve();
    loading = Promise.all(NAMES.map((name) =>
      fetch(BASE + name + '.wav')
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then((ab) => new Promise((res, rej) => {
          /* Safari の古い版は Promise を返さない。コールバック形で受ける */
          const p = ctx.decodeAudioData(ab, res, rej);
          if (p && p.then) p.then(res, rej);
        }))
        .then((buf) => { buffers[name] = buf; })
        .catch(() => { /* 音は無くても打てる */ })
    )).then(() => {});
    return loading;
  }

  /* 鳴らす。opts.rate で速さ（音程）を、opts.gain で大きさを振れる */
  function play(name, opts) {
    if (!ctx || vol <= 0) return;
    const buf = buffers[name];
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

  function ready() { return !!ctx && Object.keys(buffers).length > 0; }

  return { init, load, play, volume, ready, NAMES, DEFAULT_VOLUME, get volumeValue() { return vol; } };
})();

if (typeof module !== 'undefined') module.exports = Sound;
