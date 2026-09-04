#!/usr/bin/env node
/*
  対局画面をブラウザで回す（match.html のブラウザ検証。docs/design/match/spec.md）

    node tools/drive-match.js                          おまかせで一戦（780×392・最速）
    node tools/drive-match.js --shots /tmp/m --speed 200
    node tools/drive-match.js --video /tmp/m --seconds 25 --speed 520 --play
    node tools/drive-match.js --width 392 --height 780  縦持ち（列レイアウト）

  なぜ要るか：
    牌の移動・音・卓の絵は静止画では確かめられない箇所が多い。
    `tools/test-*.js` は DOM に触らないので、実際に押して録る道具を置く。

  --play         自分の席を人間のまま、スクリプトが牌を押して切る
                 （FLIP と一度押し・二度押しの経路を通す）。無ければ「おまかせ」
  --shots DIR    配牌直後（deal）・誰かが鳴いた直後（call）・河が3段に伸びた（late）・
                 終局（end）の四枚を撮る（spec.md §4.6）
  --video DIR    録画する。--seconds で長さ（既定 20）
  --seed N       Math.random を固定（match.html の ?seed）
  --dealer N     起家を固定（?dealer）
  --rotate       縦持ちの回転表示を入れる（段7）
  --stall SEC    この秒数だけ進みが無ければ止まったとみなす（既定 60）
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\n/, ''));
  process.exit(0);
}
const ROOT = path.resolve(opt('root', path.join(__dirname, '..')));
const WIDTH = +opt('width', 780);
const HEIGHT = +opt('height', 392);
const SPEED = +opt('speed', 0);
const LENGTH = opt('length', 'tonpuu');
const SHOTS = opt('shots', null);
const VIDEO = opt('video', null);
const SECONDS = +opt('seconds', 20);
const SEED = opt('seed', null);
const DEALER = opt('dealer', null);
const PLAY = flag('play');
const ROTATE = flag('rotate');
const STALL = +opt('stall', 60);
const SCALE = +opt('scale', 2);

function loadPlaywright() {
  const tries = ['playwright', 'playwright-core',
    '/usr/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright',
    '/opt/node22/lib/node_modules/playwright'];
  try {
    const g = require('child_process').execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (g) tries.push(path.join(g, 'playwright'));
  } catch (e) { /* npm が無くてもよい */ }
  for (const t of tries) { try { return require(t); } catch (e) { /* 次 */ } }
  console.error('playwright が見つからない。npm i -g playwright');
  process.exit(1);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };
function serve(root) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(root, rel);
      if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { process.stdout.write(a.join(' ') + '\n'); };

(async () => {
  const { chromium } = loadPlaywright();
  const { srv, port } = await serve(ROOT);
  const browser = await chromium.launch();
  const ctxOpts = { viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: SCALE };
  if (VIDEO) {
    fs.mkdirSync(VIDEO, { recursive: true });
    ctxOpts.recordVideo = { dir: VIDEO, size: { width: WIDTH, height: HEIGHT } };
  }
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); log('PAGEERROR ' + e.message); });
  page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE error ' + m.text().slice(0, 300)); });

  const q = new URLSearchParams({ start: '1', auto: PLAY ? '0' : '1', speed: String(SPEED), length: LENGTH });
  if (SEED !== null) q.set('seed', SEED);
  if (DEALER !== null) q.set('dealer', DEALER);
  const url = 'http://127.0.0.1:' + port + '/match.html?' + q.toString();
  /* 音は聞けないので、Sound.play が何を何回呼ばれたかを数える */
  await page.addInitScript(() => {
    window.__sfx = {};
    const hook = () => {
      if (typeof Sound === 'undefined' || Sound.__hooked) return;
      const orig = Sound.play;
      Sound.play = function (name, opts) { window.__sfx[name] = (window.__sfx[name] || 0) + 1; return orig.call(Sound, name, opts); };
      Sound.__hooked = true;
    };
    document.addEventListener('DOMContentLoaded', hook);
  });
  await page.goto(url);
  await page.waitForSelector('#table', { timeout: 10000 });
  if (ROTATE) {
    await page.waitForSelector('#rotateBtn', { timeout: 5000 });
    await page.click('#rotateBtn');
    await sleep(300);
  }

  const snap = () => page.evaluate(() => {
    const g = UI.game;
    const vis = (sel) => { const e = document.querySelector(sel); return !!e && e.offsetParent !== null; };
    if (!g) return { over: true, rank: window.lastRank && window.lastRank.map((r) => r.chara.name) };
    return {
      over: false, kyoku: g.kyoku, dealer: g.dealer, wall: g.wall.length,
      discards: g.players.map((p) => p.discards.length),
      melds: g.players.map((p) => p.melds.length),
      pending: UI.pending ? UI.pending.type : null,
      overlay: vis('#overlay.show'),
      next: vis('#overlay.show #next'),
      modal: vis('#overlay.show [data-v]'),
      nodes: UI._nodes ? UI._nodes.size : -1,
      jikaze: g.players.map((p) => p.jikaze - 27),
    };
  });

  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await sleep(350);
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
    log('撮った → ' + path.join(SHOTS, name + '.png'));
  };

  const shots = {};
  const t0 = Date.now();
  let lastChange = Date.now();
  let lastKey = '';
  let maxNodes = 0;
  let first = await snap();
  log('開始 ' + JSON.stringify(first));
  await shot('deal'); shots.deal = true;

  for (;;) {
    const st = await snap();
    if (VIDEO && Date.now() - t0 > SECONDS * 1000) { log('録画の長さに達した'); break; }
    if (st.over) { log('終局 ' + JSON.stringify(st.rank)); break; }
    maxNodes = Math.max(maxNodes, st.nodes);
    const key = JSON.stringify([st.kyoku, st.discards, st.melds, st.pending, st.overlay]);
    if (key !== lastKey) { lastKey = key; lastChange = Date.now(); }
    else if (Date.now() - lastChange > STALL * 1000) {
      log('！進みが止まった ' + JSON.stringify(st)); process.exitCode = 2; break;
    }

    if (!shots.call && st.melds.some((n) => n > 0)) { await shot('call'); shots.call = true; }
    /* 河が3段に伸びた終盤（§4.6）。結果のオーバーレイが被っていない瞬間を撮る */
    if (!shots.late && st.discards.some((n) => n >= 13) && !st.overlay) { await shot('late'); shots.late = true; }

    if (st.next) { await page.click('#overlay.show #next').catch(() => {}); await sleep(120); continue; }
    if (st.modal) { await page.click('#overlay.show [data-v]').catch(() => {}); await sleep(120); continue; }

    if (PLAY && st.pending === 'turn') {
      /* 人間の手番。ツモがあれば和了り、無ければ切れる牌を一枚押す。
         二度押しの設定なら二度押す */
      const done = await page.evaluate(() => {
        const tsumo = [...document.querySelectorAll('#actions .act')].find((b) => b.textContent === 'ツモ');
        if (tsumo) { tsumo.click(); return 'tsumo'; }
        const tiles = [...document.querySelectorAll('#handrow .tile.selectable')];
        if (!tiles.length) return null;
        const t = tiles[Math.floor(Math.random() * tiles.length)];
        t.click();
        /* 二度押しの設定（段8より前は常に二度押し）なら、同じ牌をもう一度 */
        if (UI.pending && UI.pending.type === 'turn') t.click();
        return 'discard';
      });
      if (done) await sleep(Math.max(120, SPEED));
      continue;
    }
    if (PLAY && st.pending === 'call') {
      await page.evaluate(() => {
        const bs = [...document.querySelectorAll('#actions .act')];
        const ron = bs.find((b) => b.textContent === 'ロン');
        const pon = bs.find((b) => b.textContent === 'ポン');
        (ron || (Math.random() < 0.5 && pon) || bs.find((b) => b.textContent === 'パス') || bs[0]).click();
      });
      await sleep(120);
      continue;
    }
    await sleep(80);
  }

  const last = await snap();
  await shot('end');
  log('最後 ' + JSON.stringify(last) + ' 最大ノード数 ' + maxNodes);
  const sfx = await page.evaluate(() => ({ played: window.__sfx, ready: typeof Sound !== 'undefined' && Sound.ready() }));
  log('効果音 ' + JSON.stringify(sfx));
  if (errors.length) { log('！ページのエラー ' + errors.length + '件'); process.exitCode = 2; }

  await page.close();
  await ctx.close();
  if (VIDEO) {
    const files = fs.readdirSync(VIDEO).filter((f) => f.endsWith('.webm'));
    log('録画 → ' + files.map((f) => path.join(VIDEO, f)).join(', '));
  }
  await browser.close();
  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
