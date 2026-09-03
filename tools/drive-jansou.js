#!/usr/bin/env node
/*
  直営雀荘をブラウザで自動で回す（jansou.html のブラウザ検証）

    node tools/drive-jansou.js --days 30
    node tools/drive-jansou.js --days 30 --shot docs/design/jansou/month-report.png
    node tools/drive-jansou.js --old --days 20
    node tools/drive-jansou.js --old --days 12 --noskip
    node tools/drive-jansou.js --root ../base-worktree --old --days 20

  なぜ要るか：
    `tools/test-jansou.js` は DOM に触らない関数だけを見る。
    「30日回すと本当に月報が出るか」「割り込みで詰まらないか」は
    実際に押してみるしかない。手で30回押すのは現実的でないので、
    ここに置く（docs/design/jansou/monthly.md §13）。

  Playwright が要る（`node_modules` でも `npm i -g playwright` でもよい）。
  ブラウザ本体は入っているものを使う。

  ---------------------------------------------------------------
  **押す順は「ポップアップが先、スキップは後」。逆にすると止まる。**
  ---------------------------------------------------------------
  割り込み（卓の故障・ボトル勝負・客カード）のポップアップは画面ぜんぶを
  覆う。覆いの下にある釦を実クリックしようとすると、Playwright は
  「覆いが退くまで」待ち続け、いつまでも返らない。
  ページのJSは動いているのに、**外からは無限ループと見分けがつかない**
  （CPUは再生の requestAnimationFrame で回りっぱなしになる）。
  一度これを追いかけたので、順番はここで固定する。

  スキップ釦は割り込み中に `hidden` になる（`JansouFloor.skipHidden`）ので、
  順番を守っていれば覆いに吸われることはない。

  そのほかの罠（同 §13）：
  - **配信するツリーを取り違えない。** このスクリプトは自前で静的サーバを
    立て、配信するディレクトリと `dbgOld` の有無を毎回出す。
    手で `python3 -m http.server` を立てるときは、`cd` した先を
    `curl -s localhost:PORT/jansou.html | grep -c dbgOld` で確かめること
  - **出力を `| tail` に通さない。** 溜め込まれて、止めたときに何も見えない
  - **`pkill -f <スクリプト名>` を使わない。** 自分の引数にも当たって自分が死ぬ
*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

/* ---------- 引数 ---------- */
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
const OLD = flag('old');                       // 47日目・評判38（月の概念なし）から
const SEED = +opt('seed', 0);                  // 0 なら固定しない
const SHOT = opt('shot', null);                // 月報が出たら撮る
const WIDTH = +opt('width', 420);
const HEIGHT = +opt('height', 2400);           // 月報は縦に長い。切れないように
const STALL_SEC = +opt('stall', 45);           // これだけ進まなければ調べて止まる
/* スキップを押さずに等速（×4）で最後まで見る。一日15秒ほど掛かるが、
   **割り込みが「スキップ済み」でない状態で開く**ので、
   覆いの下に押せる釦が残っていないかを取りこぼさずに見られる。
   スキップを押すと live.skipping で釦が消え、その日の検査は意味が無くなる */
const NOSKIP = flag('noskip');

/* ---------- Playwright を探す ---------- */
function loadPlaywright() {
  const tries = ['playwright', 'playwright-core',
    '/usr/lib/node_modules/playwright', '/usr/local/lib/node_modules/playwright'];
  try {
    const g = require('child_process').execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (g) tries.push(path.join(g, 'playwright'));
  } catch (e) { /* npm が無くてもよい */ }
  for (const t of tries) {
    try { return require(t); } catch (e) { /* 次を試す */ }
  }
  console.error('Playwright が見つからない。`npm i -g playwright` か、'
    + 'このリポジトリで `npm i playwright` を実行すること。');
  process.exit(1);
}

/* ---------- 静的サーバ（配信するツリーを取り違えないため自前で立てる） ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
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

  /* 配信するツリーを名指しで出す。**ここを取り違えると比較が全部無意味になる** */
  const page0 = fs.readFileSync(path.join(ROOT, 'jansou.html'), 'utf8');
  const { srv, port } = await serve(ROOT);
  log('配信 ' + ROOT + '  (dbgOld ' + (page0.includes('dbgOld') ? 'あり' : 'なし') + ')');

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  if (SEED) {
    /* 同じ日を base と head で見比べるとき用。ページのどのスクリプトより先に差し替える */
    await ctx.addInitScript(({ seed }) => {
      let a = seed >>> 0;
      Math.random = function () {
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }, { seed: SEED });
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE error ' + m.text().slice(0, 300)); });

  /* 固まったときに「どこで回っているか」を見るため（Playwright からは取れない） */
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Debugger.enable');
  let stack = null;
  cdp.on('Debugger.paused', (ev) => {
    stack = ev.callFrames.slice(0, 12).map((f) =>
      (f.functionName || '(無名)') + ' @ ' + f.url.split('/').pop() + ':' + (f.location.lineNumber + 1));
    cdp.send('Debugger.resume').catch(() => {});
  });

  const url = 'http://127.0.0.1:' + port + '/jansou.html';
  await page.goto(url);
  const reloadBy = async (sel) => { await Promise.all([page.waitForNavigation(), page.click(sel)]); };

  /* ---------- 出発点を作る ---------- */
  await reloadBy('#dbgReset');
  await reloadBy('#dbgMoney');                 // 1000万円
  await reloadBy('#dbgHire');                  // 5人契約
  await page.click('#jnOpen');                 // 開店（50万円）
  for (const k of ['tables', 'tables', 'interior', 'auto', 'sign']) {
    await page.click('[data-up="' + k + '"]');  // 卓4・内装2・全自動2・宣伝2
    await sleep(60);
  }
  if (await page.$('[data-speed="4"]')) await page.click('[data-speed="4"]');   // 速度×4
  if (OLD) {
    if (!page0.includes('dbgOld')) {
      log('このツリーに dbgOld が無い。localStorage を直に書く');
      await page.evaluate(() => {
        const s = JSON.parse(localStorage.getItem('jandol_save_v1'));
        const p = Jansou.normalize(s.parlor);
        p.open = true; p.day = 47; p.rep = 38; p.tables = 4;
        delete p.month; delete p.months;
        s.parlor = p;
        localStorage.setItem('jandol_save_v1', JSON.stringify(s));
      });
      await page.reload();
    } else await reloadBy('#dbgOld');
  }

  const snap = () => page.evaluate(() => {
    const skip = document.querySelector('[data-skip]');
    const pop = document.querySelector('.popup');
    const s = JSON.parse(localStorage.getItem('jandol_save_v1'));
    return {
      day: s.parlor.day, rep: s.parlor.rep, money: s.money,
      monthFrom: s.parlor.month && s.parlor.month.from,
      head: (document.querySelector('.jnFlDay') || {}).textContent || '',
      fill: ((document.querySelector('.jnFlFill') || {}).style || {}).width || '',
      /* **押せる釦だけを「ある」とする。**覆われた釦を押しに行かないため */
      skipVisible: !!skip && !skip.hidden,
      popup: pop ? { cls: pop.className,
        title: ((pop.querySelector('.jnPopTitle, .jnBtTitle, .jnMonNo') || {}).textContent || '').trim().slice(0, 30),
        month: pop.classList.contains('jnMonWrap') } : null,
      idle: !!document.querySelector('#jnRun'),
    };
  });

  let cur = await snap();
  log('出発 ' + JSON.stringify(cur));

  let shot = false;
  for (let d = 0; d < DAYS; d++) {
    await page.click('#jnRun');
    const t0 = Date.now();
    const pressed = [];
    for (;;) {
      let st;
      try { st = await withTimeout(snap(), 8000, 'evaluate'); }
      catch (e) {
        log('！ページが応答しない（' + e.message + '）。日 ' + (cur.day + 1) + ' 押した順: ' + pressed.join(' | '));
        await diagnose('メインスレッドが返らない');
        process.exit(2);
      }
      if (st.idle && st.day !== cur.day) { cur = st; break; }

      /* 覆いの下に押せる釦を残していないこと（monthly.md §13）。
         **ここが崩れると、外からは無限ループと見分けがつかなくなる。**
         DOMを見ないと分からないので、純関数テストではなくここで見る */
      if (st.popup && st.skipVisible) {
        log('！ポップアップが出ているのに、スキップ釦が押せる状態で残っている');
        log('  画面: ' + JSON.stringify(st));
        await diagnose('覆いの下に押せる釦がある');
        process.exit(3);
      }

      /* **ポップアップが先。**覆いの下の釦を押しに行かないこと（冒頭の説明） */
      if (st.popup) {
        if (st.popup.month && SHOT && !shot) {
          await sleep(900);                     // 帯が伸びきるのを待つ（二重 rAF で描く）
          const box = await page.$('.jnMonBox');
          fs.mkdirSync(path.dirname(path.resolve(SHOT)), { recursive: true });
          await (box || page).screenshot({ path: path.resolve(SHOT) });
          shot = true;
          log('月報を撮った → ' + SHOT);
        }
        try { await page.click('.popup [data-key]:not([disabled])', { timeout: 5000 }); }
        catch (e) { log('ポップアップの釦が押せない: ' + e.message.split('\n')[0]); }
        pressed.push('pop:' + st.popup.title);
      } else if (st.skipVisible && !NOSKIP) {
        try { await page.click('[data-skip]:not([hidden])', { timeout: 5000 }); }
        catch (e) { log('スキップが押せない: ' + e.message.split('\n')[0]); }
        pressed.push('skip');
      }

      if (Date.now() - t0 > (NOSKIP ? Math.max(STALL_SEC, 120) : STALL_SEC) * 1000) {
        log('！日 ' + (cur.day + 1) + ' が ' + STALL_SEC + '秒 進まない。押した順: ' + pressed.join(' | '));
        log('  画面: ' + JSON.stringify(st));
        await diagnose('進まない');
        process.exit(2);
      }
      await sleep(120);
    }
    log('日 ' + cur.day + '  評判 ' + cur.rep + '  所持金 ' + cur.money.toLocaleString('en-US')
      + '  ' + ((Date.now() - t0) / 1000).toFixed(1) + '秒  ' + pressed.join(' | '));
  }

  log('完走 ' + DAYS + '日');
  if (SHOT && !shot) log('！月報は出なかった（--days が30に足りないか、月の途中から始めている）');
  await browser.close();
  srv.close();

  async function diagnose(why) {
    log('--- 調べる（' + why + '） ---');
    /* JSが本当に詰まっているのか、覆いに吸われているだけなのかを分ける */
    let responsive = false;
    try { responsive = (await withTimeout(page.evaluate(() => 1 + 1), 3000, 'x')) === 2; } catch (e) { /* 詰まっている */ }
    log('  evaluate が返るか: ' + responsive + '（返るならJSは詰まっていない＝覆いか待ちの問題）');
    try {
      const cover = await withTimeout(page.evaluate(() => {
        const b = document.querySelector('[data-skip]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { hidden: b.hidden, 覆っているもの: el ? el.tagName + '.' + el.className : null };
      }), 3000, 'x');
      log('  スキップ釦: ' + JSON.stringify(cover));
    } catch (e) { /* 応答しないなら諦める */ }
    try { await withTimeout(cdp.send('Debugger.pause'), 5000, 'pause'); await sleep(1200); } catch (e) { /* 同上 */ }
    log(stack ? '  止まっている場所:\n    ' + stack.join('\n    ') : '  スタックは取れなかった');
    await page.screenshot({ path: 'drive-jansou-stall.png' }).catch(() => {});
    log('  画面を drive-jansou-stall.png に保存した');
    await browser.close();
    srv.close();
  }
})().catch((e) => { console.error('落ちた\n' + e.stack); process.exit(1); });
