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
  --noghost      実機の「幽霊クリック」を真似ない（既定は真似る。下を読むこと）

  **幽霊クリック**（iOS Safari。2026年9月5日）:
    WebKit は、押した相手が指を離すまでに消えていると、**離した場所にいる相手**へ
    click を出す。Chromium は共通の祖先へ出すので **PC では再現しない。**
    締めの帯は pointerdown で畳まれるので、帯を叩いた指の click が
    **帯の下にあったもの**へ落ちる。ここではその WebKit の振る舞いだけを足して、
    実機と同じ経路を通す。**これを外すと、実機で起きることが PC で捕まらない。**

  **局数を数える錠**（2026年9月5日）:
    最後に「東風なら東4局まで通ったか」を局番号で確かめ、通っていなければ
    終了コード 2 で落ちる。**「完走したか」だけでは足りない**——一局で
    対局が終わっても、画面としては綺麗に終わって見える（実際にそれで見逃した）。
    あわせて **giveUp が呼ばれていないこと**も見る。帯を叩いた指が
    その下の「おまかせ」に当たると、残りが早送りで消化されて
    「一局で終わった」と同じ絵になるため。
    **四人卓（body.four）で通すこと。**縦の列レイアウトでは #topbar が上にあり、
    帯と重ならないので、この経路は通らない。
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
const GHOST = !flag('noghost');
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
  /* 実機（iOS Safari）の幽霊クリック。上の説明を読むこと */
  if (GHOST) {
    await page.addInitScript(() => {
      let down = null;
      addEventListener('pointerdown', (e) => { down = e.target; }, true);
      addEventListener('pointerup', (e) => {
        const gone = down && (!down.isConnected
          || (down.offsetParent === null && getComputedStyle(down).position !== 'fixed'));
        if (gone) {
          const el = document.elementFromPoint(e.clientX, e.clientY);
          if (el) {
            window.__ghost = (window.__ghost || 0) + 1;
            el.dispatchEvent(new MouseEvent('click',
              { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY }));
          }
        }
        down = null;
      }, true);
    });
  }
  await page.goto(url);
  await page.waitForSelector('#table', { timeout: 10000 });
  /* 通った局と、おまかせが呼ばれた回数を数える（下の錠で使う） */
  await page.evaluate(() => {
    window.__kyoku = [];
    window.__giveup = 0;
    const res = UI.result.bind(UI);
    UI.result = function (d) {
      const k = UI.game ? UI.game.kyoku : 0;
      if (!window.__kyoku.includes(k)) window.__kyoku.push(k);
      return res(d);
    };
    const gu = UI.giveUp.bind(UI);
    UI.giveUp = function (sp) { window.__giveup++; return gu(sp); };
  });
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
      /* 局の締めは帯になった（agari-spec.md）。**#next はもう無い。**
         送るのは「どこかを叩く」ことなので、帯が出ていたら叩く */
      band: vis('#endband.on'),
      /* 帯は「どこを叩いても送れる」が、**指が行くのは右下**（タップで次へ）。
         そこは四人卓では #topbar の真上なので、実機と同じ場所を叩く */
      bandAt: (() => {
        const e = document.querySelector('#endband.on');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.right - 26), y: Math.round(r.bottom - 14) };
      })(),
      four: document.body.classList.contains('four'),
      kyoku_seen: window.__kyoku ? window.__kyoku.slice() : [],
      giveup: window.__giveup || 0,
      bust: g.players.some((p) => p.score < 0),
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
  let bust = false;          // 飛び（ハコ下）で終わったか。局数の錠はこれを除く
  let sawFour = false;       // 四人卓を通ったか（錠は body.four で掛ける）
  let first = await snap();
  log('開始 ' + JSON.stringify(first));
  await shot('deal'); shots.deal = true;

  for (;;) {
    const st = await snap();
    if (VIDEO && Date.now() - t0 > SECONDS * 1000) { log('録画の長さに達した'); break; }
    if (st.over) { log('終局 ' + JSON.stringify(st.rank)); break; }
    maxNodes = Math.max(maxNodes, st.nodes);
    if (st.bust) bust = true;
    if (st.four) sawFour = true;
    const key = JSON.stringify([st.kyoku, st.discards, st.melds, st.pending, st.overlay, st.band]);
    if (key !== lastKey) { lastKey = key; lastChange = Date.now(); }
    else if (Date.now() - lastChange > STALL * 1000) {
      log('！進みが止まった ' + JSON.stringify(st)); process.exitCode = 2; break;
    }

    if (!shots.call && st.melds.some((n) => n > 0)) { await shot('call'); shots.call = true; }
    /* 河が3段に伸びた終盤（§4.6）。結果のオーバーレイが被っていない瞬間を撮る */
    if (!shots.late && st.discards.some((n) => n >= 13) && !st.overlay) { await shot('late'); shots.late = true; }

    if (st.next) { await page.click('#overlay.show #next').catch(() => {}); await sleep(120); continue; }
    /* 帯を送る。**一度目は演出を確定させるだけ**なので、二度叩く（ui.js の onTap）。
       おまかせのときは自動で送るが、自分で打つ経路（--play）はここが唯一の出口 */
    if (st.band) {
      /* **指と同じポインタ列で、帯の右下を叩く。**画面の真ん中を click で叩くと
         合成のクリックになり、**帯の下に何が来ているかを通らない**
         （それで「東1局で対局が終わる」を見逃した。2026年9月5日）。
         一度目は演出の確定、二度目で送り——一度ずつ叩いて、そのつど見直す */
      const at = st.bandAt || { x: Math.round(WIDTH / 2), y: Math.round(HEIGHT * 0.35) };
      await page.mouse.move(at.x, at.y).catch(() => {});
      await page.mouse.down().catch(() => {});
      await page.mouse.up().catch(() => {});
      await sleep(160);
      continue;
    }
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

  /* 局数の錠。**「完走したか」だけでは、一局で終わっても完走に見える** */
  const tally = await page.evaluate(() => ({
    kyoku: window.__kyoku || [], giveup: window.__giveup || 0, ghost: window.__ghost || 0,
  })).catch(() => ({ kyoku: [], giveup: 0, ghost: 0 }));
  const want = LENGTH === 'ikkyoku' ? 1 : (LENGTH === 'hanchan' ? 8 : 4);
  const got = Math.max(0, ...tally.kyoku);
  log('通った局 ' + JSON.stringify(tally.kyoku) + '（' + LENGTH + ' なので ' + want + '局まで要る）'
      + ' body.four=' + sawFour + ' giveUp=' + tally.giveup + ' 幽霊クリック=' + tally.ghost);
  if (PLAY && !sawFour && WIDTH > HEIGHT) {
    log('！四人卓（body.four）を通っていない。この錠は横持ちで掛けること');
    process.exitCode = 2;
  }
  if (got < want && !bust) {
    log('！東' + got + '局で終わっている。' + want + '局まで進んでいない');
    process.exitCode = 2;
  }
  if (PLAY && tally.giveup > 0) {
    log('！自分で打っているのに giveUp が呼ばれた（帯を叩いた指が、下の釦に当たっている）');
    process.exitCode = 2;
  }
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
