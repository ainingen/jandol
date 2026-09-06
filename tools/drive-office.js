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
  `--far` … 遠征先をいちばん遠い県にする（滞在が `2 + far` 日になる）

  **事務所の画面は縦（既定の 380×740）で回すこと。**844×334（横持ち）にすると、
  遠征先の店の当たり判定が**下のタブ帯に隠れて**、客を叩いたつもりが
  「チーム」に飛ぶ。横持ちは対局の中だけの姿勢なので、事務所の絵は縦が正。
  `--real` の対局が四人卓になるかを見たいときだけ 844×334 で回す
  （対局そのものは横でも問題なく通る）。

  `--real` … **実対局に入る**（`autoMatch` を立てない）。雀荘の夜のボトル勝負と、
             遠征先で誘われた一局が、`store.playRealMatch` を通って本当に打てるかを見る。
             遠征中の朝は客を叩いて誘いを引く（一日3回まで）。
             **これが無いと `playRealMatch` の経路を一度も通らない**
             ——ふだんは `autoMatch: true` で数値処理に落としているため。
             `--matchspeed N` で対局の速さ（既定 200。**0 にしないこと**——
             0 にすると締めの帯が自動で送られ、タップの経路を通らない）

  ---------------------------------------------------------------
  **押す順は「ポップアップが先、シートが次、スキップは後」。**
  ---------------------------------------------------------------
  覆いの下にある釦を実クリックしようとすると、Playwright は覆いが退くまで
  待ち続けて返らない（monthly.md §13 で一度追いかけた罠）。
  夜は日報のシートが開いた状態で出るので、「明日へ」は**シートの中の釦**を押す。
  朝の「今日を始める」は下の帯にあり、シートが開いていれば先に閉じる。

  - **`pkill -f <スクリプト名>` を使わない。** 自分の引数にも当たって自分が死ぬ
  - セーブは `debug.html` の「遊べる状態」（8人・卓4・評判45）に `autoMatch: true` を
    足したもの。実対局に入ると誰も打たずに止まって見えるため（CLAUDE.md）。
    **`--real` のときだけ立てない**——代わりにこの道具が牌を押して打つ
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
const REAL = flag('real');
const MATCH_SPEED = +opt('matchspeed', 200);
/* 遠征先を遠くにする（滞在が `2 + far` 日になるので、誘いを引く機会が増える）。
   `--real` で遠征先の一局を通したいときに使う */
const FAR = flag('far');

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
  /* 音は聞けないので、Sound.play が何を何回呼ばれたかを数える（--real の (c)） */
  await page.addInitScript(() => {
    window.__sfx = {};
    const hook = () => {
      if (typeof Sound === 'undefined' || Sound.__hooked) return;
      const orig = Sound.play;
      Sound.play = function (n, o) { window.__sfx[n] = (window.__sfx[n] || 0) + 1; return orig.call(Sound, n, o); };
      Sound.__hooked = true;
    };
    document.addEventListener('DOMContentLoaded', hook);
    setTimeout(hook, 400);
  });
  page.on('pageerror', (e) => log('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE error ' + m.text().slice(0, 300)); });

  const base = 'http://127.0.0.1:' + port + '/';
  /* ---------- 出発点：debug.html の「遊べる状態」＋ autoMatch ---------- */
  await page.goto(base + 'debug.html');
  await page.evaluate((a) => {
    JandolDebug.apply('asobu');
    const s = JSON.parse(localStorage.getItem('jandol_save_v1'));
    s.autoMatch = !a.real;                 // --real のときだけ実対局に入る
    if (a.real) s.matchSpeed = a.speed;    // 締めの帯はタップ待ちのまま（0 にしない）
    /* 本拠地は一度きりの選択なので debug は決めない。ここでは東京にしておく */
    if (!s.officePref) s.officePref = 'tokyo';
    localStorage.setItem('jandol_save_v1', JSON.stringify(s));
  }, { real: REAL, speed: MATCH_SPEED });
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
      /* 実対局に入っているか（--real）。誰が打つかの札もここで拾う */
      match: !!document.querySelector('#matchRoot #app'),
      game: (typeof UI !== 'undefined' && !!UI.game),
      bodyCls: document.body.className,
      pick: !!document.querySelector('.popup [data-pick]'),
      sfx: Object.assign({}, window.__sfx || {}),
    };
  });

  /* ---------- 実対局を打つ（--real） ----------
     雀荘の夜のボトル勝負と、遠征先で誘われた一局。どちらも `store.playRealMatch`
     （shell.html）を通って `Match.play` に入る。**大会と同じ経路**だが、
     入口が違うので詰まらないかは押してみるしかない。

     **締めの帯はタップで送る**（`speed` が 0 でなければ四分岐ともタップ待ち）。
     指と同じポインタ列で帯の右下を叩く——`drive-match.js` と同じ作法で、
     合成クリックだと帯の下に何が来ているかを通らない */
  const M = { matches: 0, kyoku: 0, taps: 0, four: 0, column: 0, speeds: [], sfxIn: 0, sfxOut: 0 };
  async function playMatch(where) {
    const t0 = Date.now();
    let last = '';
    let lastAt = Date.now();
    const before = await page.evaluate(() => {
      const o = window.__sfx || {};
      return Object.keys(o).reduce((a, k) => a + o[k], 0);
    });
    let maxKyoku = 0;
    let four = null;
    let taps = 0;
    for (;;) {
      const m = await page.evaluate(() => {
        const host = document.querySelector('#matchRoot #app');
        if (!host) return { gone: true };
        /* **`UI` は window の持ち物ではない**（ui.js の `const UI`）。
           `window.UI` で見ると永久に undefined で、対局が始まらないように見える */
        if (typeof UI === 'undefined' || !UI.game) return { gone: false, wait: true };
        const bd = document.querySelector('#endband.on');
        const bb = bd ? bd.getBoundingClientRect() : null;
        const tile = document.querySelector('#handrow .tile.selectable');
        const bx = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
        return {
          gone: false, kyoku: UI.game.kyoku, finished: UI.game.finished, speed: UI.speed,
          four: document.body.classList.contains('four'),
          band: bb ? { x: Math.round(bb.right - 26), y: Math.round(bb.bottom - 14) } : null,
          modal: !!document.querySelector('#overlay.show [data-v]'),
          btn: [...document.querySelectorAll('#actions button')].map((b) => b.textContent.trim()),
          tile: tile ? bx(tile) : null,
          pending: UI.pending ? UI.pending.type : null,
        };
      });
      if (m.gone) break;
      if (!m.wait) {
        /* 終わったあとの `kyoku` は最後の局＋1 になっている（nextKyoku が
           増やしてから打ち切るため）。**打った局として数えない** */
        if (!m.finished) maxKyoku = Math.max(maxKyoku, m.kyoku);
        if (four === null) { four = m.four; M.speeds.push(m.speed); }
      }
      const key = JSON.stringify(m);
      if (key !== last) { last = key; lastAt = Date.now(); }
      else if (Date.now() - lastAt > STALL_SEC * 1000) {
        log('！' + where + 'の対局が ' + STALL_SEC + '秒 進まない ' + JSON.stringify(m));
        process.exit(2);
      }
      if (m.band) {
        /* 指と同じポインタ列で帯の右下を叩く。一度目は演出の確定、二度目で送り */
        await page.mouse.move(m.band.x, m.band.y).catch(() => {});
        await page.mouse.down().catch(() => {});
        await page.mouse.up().catch(() => {});
        M.taps++; taps++;
        await sleep(170);
        continue;
      }
      if (m.modal) { await page.click('#overlay.show [data-v]').catch(() => {}); await sleep(150); continue; }
      if (m.btn && m.btn.length) {
        await page.evaluate(() => {
          const bs = [...document.querySelectorAll('#actions button')];
          (bs.find((b) => b.textContent.trim() === 'パス') || bs[0]).click();
        });
        await sleep(120);
        continue;
      }
      if (m.pending === 'turn' && m.tile) {
        await page.mouse.move(m.tile.x, m.tile.y).catch(() => {});
        await page.mouse.down().catch(() => {});
        await sleep(40);
        await page.mouse.up().catch(() => {});
        await sleep(120);
        continue;
      }
      await sleep(80);
    }
    const after = await page.evaluate(() => {
      const o = window.__sfx || {};
      return Object.keys(o).reduce((a, k) => a + o[k], 0);
    });
    M.matches++;
    M.kyoku += maxKyoku;
    M.sfxIn += after - before;
    if (four) M.four++; else M.column++;
    log('  ' + where + 'の対局：' + (four ? '四人卓' : '列レイアウト')
      + '　東' + maxKyoku + '局まで　帯を叩いた ' + taps + ' 回　'
      + '音 ' + (after - before) + ' 回　' + ((Date.now() - t0) / 1000).toFixed(1) + '秒');
  }

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
      const dest = await page.evaluate((far) => {
        const bs = [...document.querySelectorAll('[data-dest]')];
        bs.sort((a, b) => (+a.querySelector('i').textContent) - (+b.querySelector('i').textContent));
        return (far ? bs[bs.length - 1] : bs[0]).dataset.dest;
      }, FAR);
      await page.click('[data-dest="' + dest + '"]');
      await sleep(150);
      await page.click('#ofGo');
      await page.waitForSelector('#ofShopHost .jnFloor', { timeout: 8000 });
      cur = await snap();
      log('遠征に出た → ' + dest + ' ' + JSON.stringify(cur));
      if (!shots.trip) { await shot('trip'); shots.trip = true; }
    }

    /* 遠征中の朝。**客を叩いて誘いを引く**（一日3回まで）。
       誘われたら「打つ人」の札 → 一局（length: 'ikkyoku'）。
       見つける・話すだけの日もあるので、引けなくても止めない */
    if (REAL && cur.trip && cur.shop) {
      let tapped = 0;
      let seen = 0;
      for (let i = 0; i < 3; i++) {
        /* 床は毎フレーム描き直されるので、そのつど引き直す。
           印は付けない（付けても次の paint で消える）——順に選ぶ */
        const hit = await page.evaluate((n) => {
          const bs = [...document.querySelectorAll('#ofShopHost .jnFlHit[data-guest]')];
          if (!bs.length) return { n: 0 };
          const b = bs[n % bs.length];
          const r = b.getBoundingClientRect();
          return { n: bs.length, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }, i);
        seen = hit.n;
        if (!hit.n) break;
        tapped++;
        await page.mouse.click(hit.x, hit.y).catch(() => {});
        await sleep(300);
        let g = await snap();
        if (g.pick) { await page.click('.popup [data-pick]').catch(() => {}); await sleep(400); g = await snap(); }
        if (g.match) await playMatch('遠征先');
        /* 発見や話の札が出ていたら閉じる */
        await page.evaluate(() => {
          const b = document.querySelector('.popup [data-key]:not([disabled])');
          if (b) b.click();
        });
        await sleep(200);
      }
      log('  遠征先の店：客 ' + seen + ' 人　声をかけた ' + tapped + ' 回');
      cur = await snap();
    }

    if (!cur.run) { log('！朝の「今日を始める」が押せない ' + JSON.stringify(cur)); process.exit(2); }
    await page.click('#ofBand #ofRun');
    const t0 = Date.now();
    /* **「進みが無い」で測る。**日ぜんたいの時間で測ると、実対局に入った日
       （--real）が一戦75秒かかるだけで「止まった」と言われる。
       押すたびに更新する（ヘッダの --stall の説明どおりの意味にした） */
    let moved = Date.now();
    const pressed = [];
    let doneNight = false;
    let nPressed = 0;
    for (;;) {
      let st;
      try { st = await withTimeout(snap(), 8000, 'evaluate'); }
      catch (e) { log('！ページが応答しない（' + e.message + '）。押した順: ' + pressed.join(' | ')); process.exit(2); }

      if (st.match) {
        /* 雀荘の夜のボトル勝負。**受けて立つと、ここで本当に一戦打つ** */
        await playMatch('雀荘の夜');
        pressed.push('対局');
      } else if (st.pick) {
        await page.click('.popup [data-pick]').catch(() => {});
        pressed.push('打つ人');
      } else if (st.popup) {
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
      if (pressed.length !== nPressed) { nPressed = pressed.length; moved = Date.now(); }
      if (Date.now() - moved > STALL_SEC * 1000) {
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
  if (REAL) {
    const sfx = await page.evaluate(() => window.__sfx || {});
    const total = Object.keys(sfx).reduce((a, k) => a + sfx[k], 0);
    log('実対局 ' + M.matches + ' 戦（四人卓 ' + M.four + ' / 列 ' + M.column + '）　'
      + '通った局 ' + M.kyoku + '　帯を叩いた ' + M.taps + ' 回');
    log('  対局中の UI.speed = ' + JSON.stringify(M.speeds) + '（セーブの matchSpeed は ' + MATCH_SPEED + '）');
    log('  音 ' + JSON.stringify(sfx) + '　合計 ' + total + '（うち対局の中 ' + M.sfxIn + '）');
    if (!M.matches) { log('！実対局に一度も入らなかった。日数か --trip を増やすこと'); process.exitCode = 2; }
    if (M.speeds.some((v) => v !== MATCH_SPEED)) {
      log('！対局の速さがセーブの matchSpeed と違う'); process.exitCode = 2;
    }
    if (total !== M.sfxIn) {
      log('！対局の外で音が鳴っている（' + (total - M.sfxIn) + ' 回）'); process.exitCode = 2;
    }
  }
  await browser.close();
  srv.close();
})().catch((e) => { log('！' + (e && e.stack || e)); process.exit(1); });
