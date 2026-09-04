#!/usr/bin/env node
/*
  事務所の部屋をブラウザで自動で回す（index.html のブラウザ検証。office/room.md §11）

    node tools/drive-office.js --days 30
    node tools/drive-office.js --days 8 --trip 3 --shots /tmp/shots
    node tools/drive-office.js --width 380 --height 740

  なぜ要るか：
    `tools/test-office.js` は DOM に触らない関数だけを見る。
    「朝 → 今日を始める → 雀荘 → 夜の部屋 → 日報 → 明日へ → 朝」が
    本当に30日回るか、シートが釦を覆って詰まらないかは押してみるしかない。
    `tools/drive-jansou.js` は jansou.html（事務所を通らない）を回すので、
    部屋の経路はこちらで見る。

  `--trip N` … N日目の朝に扉から遠征に出る（探す・同行者なし・いちばん近い県）。
               遠征中の朝（枠に滞在先の店）まで通ることを見る
  `--shots DIR` … 朝の部屋・夜の部屋・遠征中の朝を撮る（morning / night / trip）

  ---------------------------------------------------------------
  **押す順は「ポップアップが先、シートが次、スキップは後」。**
  ---------------------------------------------------------------
  覆いの下にある釦を実クリックしようとすると、Playwright は覆いが退くまで
  待ち続けて返らない（monthly.md §13 で一度追いかけた罠）。
  夜は日報のシートが開いた状態で出るので、「明日へ」は**シートの中の釦**を押す。
  朝の「今日を始める」は下の帯にあり、シートが開いていれば先に閉じる。

  - **`pkill -f <スクリプト名>` を使わない。** 自分の引数にも当たって自分が死ぬ
  - セーブは `debug.html` の「遊べる状態」（8人・卓4・評判45）に `autoMatch: true` を
    足したもの。実対局に入ると誰も打たずに止まって見えるため（CLAUDE.md）
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
const DAYS = +opt('days', 30);
const TRIP = +opt('trip', 0);
const SHOTS = opt('shots', null);
const WIDTH = +opt('width', 380);
const HEIGHT = +opt('height', 740);
const STALL_SEC = +opt('stall', 60);

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
  '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
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
const withTimeout = (p, ms, what) =>
  Promise.race([p, sleep(ms).then(() => { throw new Error('TIMEOUT:' + what); })]);
const log = (...a) => { process.stdout.write(a.join(' ') + '\n'); };

(async () => {
  const { chromium } = loadPlaywright();
  const { srv, port } = await serve(ROOT);
  log('配信 ' + ROOT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE error ' + m.text().slice(0, 300)); });

  const base = 'http://127.0.0.1:' + port + '/';
  /* ---------- 出発点：debug.html の「遊べる状態」＋ autoMatch ---------- */
  await page.goto(base + 'debug.html');
  await page.evaluate(() => {
    JandolDebug.apply('asobu');
    const s = JSON.parse(localStorage.getItem('jandol_save_v1'));
    s.autoMatch = true;
    /* 本拠地は一度きりの選択なので debug は決めない。ここでは東京にしておく */
    if (!s.officePref) s.officePref = 'tokyo';
    localStorage.setItem('jandol_save_v1', JSON.stringify(s));
  });
  await page.goto(base + 'index.html');
  await page.waitForSelector('[data-act="continue"]', { timeout: 10000 });
  await page.click('[data-act="continue"]');
  await page.waitForSelector('#ofRoomHost, #ofShopHost', { timeout: 10000 });

  const snap = () => page.evaluate(() => {
    const vis = (sel) => { const e = document.querySelector(sel); return !!e && !e.hidden && e.offsetParent !== null; };
    const s = JSON.parse(localStorage.getItem('jandol_save_v1'));
    const pop = document.querySelector('.popup');
    const skip = document.querySelector('[data-skip]');
    return {
      day: s.parlor ? s.parlor.day : 0, money: s.money, trip: !!(s.trip && s.trip.dayLeft > 0),
      popup: pop ? ((pop.querySelector('.jnPopTitle, .jnBtTitle, .jnMonNo, .ofSayName') || {}).textContent || '').trim().slice(0, 24) : null,
      skipVisible: !!skip && !skip.hidden,
      sheet: vis('.ofSheet'),
      run: vis('#ofBand #ofRun'),
      nextSheet: vis('.ofSheet #ofNext'),
      nextBand: vis('#ofBand #ofNext'),
      room: !!document.querySelector('#ofRoomHost .ofRoom'),
      shop: !!document.querySelector('#ofShopHost .jnFloor'),
    };
  });

  const shot = async (name) => {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await sleep(400);
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
    log('撮った → ' + path.join(SHOTS, name + '.png'));
  };

  let cur = await snap();
  log('出発 ' + JSON.stringify(cur));
  const shots = {};

  for (let d = 0; d < DAYS; d++) {
    /* 朝。シートが開いていれば閉じる */
    if (cur.sheet) { await page.click('.ofSheetClose'); await sleep(150); cur = await snap(); }
    if (!shots.morning && cur.room) { await shot('morning'); shots.morning = true; }

    /* 遠征に出る日。扉 → 遠征に出る → 行き先 → 出発 */
    if (TRIP && d + 1 === TRIP && cur.room && !cur.trip) {
      await page.click('[data-tap="door"]');
      await page.waitForSelector('#ofTrip', { timeout: 5000 });
      await page.click('#ofTrip');
      await page.waitForSelector('[data-dest]', { timeout: 5000 });
      /* いちばん近い県（far の小さいもの） */
      const dest = await page.evaluate(() => {
        const bs = [...document.querySelectorAll('[data-dest]')];
        bs.sort((a, b) => (+a.querySelector('i').textContent) - (+b.querySelector('i').textContent));
        return bs[0].dataset.dest;
      });
      await page.click('[data-dest="' + dest + '"]');
      await sleep(150);
      await page.click('#ofGo');
      await page.waitForSelector('#ofShopHost .jnFloor', { timeout: 8000 });
      cur = await snap();
      log('遠征に出た → ' + dest + ' ' + JSON.stringify(cur));
      if (!shots.trip) { await shot('trip'); shots.trip = true; }
    }

    if (!cur.run) { log('！朝の「今日を始める」が押せない ' + JSON.stringify(cur)); process.exit(2); }
    await page.click('#ofBand #ofRun');
    const t0 = Date.now();
    const pressed = [];
    let doneNight = false;
    for (;;) {
      let st;
      try { st = await withTimeout(snap(), 8000, 'evaluate'); }
      catch (e) { log('！ページが応答しない（' + e.message + '）。押した順: ' + pressed.join(' | ')); process.exit(2); }

      if (st.popup) {
        try { await page.click('.popup [data-key]:not([disabled])', { timeout: 5000 }); }
        catch (e) { log('ポップアップの釦が押せない: ' + e.message.split('\n')[0]); }
        pressed.push('pop:' + st.popup);
      } else if (st.nextSheet || st.nextBand) {
        /* 夜。日報のシートが開いていれば、その中の「明日へ」を押す */
        if (!shots.night && st.day !== cur.day) { await shot('night'); shots.night = true; }
        if (st.day === cur.day) { log('！夜なのに日が進んでいない ' + JSON.stringify(st)); process.exit(3); }
        await page.click(st.nextSheet ? '.ofSheet #ofNext' : '#ofBand #ofNext');
        pressed.push('next');
        doneNight = true;
      } else if (st.skipVisible) {
        try { await page.click('[data-skip]:not([hidden])', { timeout: 5000 }); }
        catch (e) { log('スキップが押せない: ' + e.message.split('\n')[0]); }
        pressed.push('skip');
      } else if (doneNight && (st.run || st.room || st.shop) && !st.sheet) {
        cur = st; break;
      }
      if (Date.now() - t0 > STALL_SEC * 1000) {
        log('！日 ' + (cur.day + 1) + ' が ' + STALL_SEC + '秒 進まない。押した順: ' + pressed.join(' | '));
        log('  画面: ' + JSON.stringify(st));
        process.exit(2);
      }
      await sleep(120);
    }
    log('日 ' + cur.day + '  所持金 ' + cur.money.toLocaleString('en-US') + (cur.trip ? '  遠征中' : '')
      + '  ' + ((Date.now() - t0) / 1000).toFixed(1) + '秒  ' + pressed.join(' | '));
  }
  log('完走 ' + DAYS + '日');
  await browser.close();
  srv.close();
})().catch((e) => { log('！' + (e && e.stack || e)); process.exit(1); });
