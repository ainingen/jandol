#!/usr/bin/env node
/*
  ブラックボックス（`match.html` の `?bb=1`。docs/design/match/crash-spec.md §3）

    node tools/check-bb.js

  **ブラウザで実際に回す。**書けているか・欄が揃っているか・閉じているかは、
  `localStorage` を読まないと分からない（`check-auto.js` と同じ理由）。

  見るのは三つ。

    1. `?bb=1` で対局を回すと `jandol.bb` に走行が一つでき、
       欄が全部あり、**最後の行が `w:'end'`**（＝閉じた走行）になること。
       `g` と `sp` が0でない行があること——四人卓で `fitFour` が動いた証
    2. **旗が無ければ何も仕込まない**こと。`jandol.bb` が書かれず、
       右下の印（`#flatBadge`）も出ない
    3. 読み直したとき、閉じていない走行があれば `.dbgBB` に直近5行が出ること
    4. **段2（`?fourjs=0`）が効いている**こと。初回の `fitFour` のあと
       **`resize` が届いた秒に `sp` が増えない**——イベント駆動の経路が
       止まっている（500ms の見張りは 2026年9月10日に消えたので数に入らない。
       局の変わり目や席プレートの変化で立つぶんは `onLayout` の側で、この旗とは無関係）。
       **`page.setViewportSize` で揺すっても増えない**のがイベント駆動の側の証
    5. **寸法の見張りが無い**こと（2026年9月10日に読み替えた）。もとは
       「包みが二戦目でも効いているか」を見ていたが、**見張りそのものが
       `src/match.js` から消えた**ので、見る向きが逆になった。
       `?bb=1` だけ（`nofit` 無し）で読み直さず二戦回し、**`sp` が
       「立ち続けて」いないこと**——見張りは毎秒とぎれずに立てるが、
       イベント駆動はとびとびの秒にしか立たない（`spShape` のコメントに実測）。
       `?nofit=1` の走行は**判定が同じになる**ことだけ見る。
       **見張りを戻すとここが落ちる**——それがこの錠の役目
*/
'use strict';
const path=require('path'),http=require('http'),fs=require('fs');
const ROOT='/home/user/jandol';
function lp(){const t=['playwright','playwright-core'];try{const g=require('child_process').execSync('npm root -g',{stdio:['ignore','pipe','ignore']}).toString().trim();if(g)t.push(path.join(g,'playwright'));}catch(e){}
for(const x of t){try{return require(x);}catch(e){}}process.exit(1);}
const {chromium}=lp();
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.webp':'image/webp','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.wav':'audio/wav'};
function serve(){return new Promise((res)=>{const srv=http.createServer((rq,rs)=>{const f=path.join(ROOT,decodeURIComponent(rq.url.split('?')[0]));
fs.readFile(f,(e,b)=>{if(e){rs.writeHead(404);rs.end('');return;}rs.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});rs.end(b);});});
srv.listen(0,'127.0.0.1',()=>res({srv,port:srv.address().port}));});}
let pass=0; const fails=[];
const ok=(c,n,d)=>{if(c){pass++;console.log('  ok  '+n);}else{fails.push(n);console.log('  NG  '+n+(d?' … '+d:''));}};
const eq=(a,b,n)=>ok(JSON.stringify(a)===JSON.stringify(b),n,'got '+JSON.stringify(a)+' / want '+JSON.stringify(b));

/* `sp` は `--side` / `--side-w` / `--felt-y` を書き換えた回数（毎秒ごと）。
   **見張りが戻ったかを見分けるのは「立つかどうか」ではなく「立ち続けるかどうか」。**

   500ms の見張りは**毎秒とぎれずに** `sp` を立てる（秒あたり 144＝`fitFour` 二回）。
   イベント駆動で立つのは、局の変わり目と席プレートの幅が変わったとき
   （リーチの札・テンパイの札・点数）だけなので、**とびとびの秒**にしか立たない。
   実測（2026年9月10日・東風一戦）：

     見張りを戻した … 立った秒が 47/60、連続 8・11・4・7・9・7 秒
     イベント駆動   … 立った秒が 11/43、連続は最大 2 秒

   **「立った秒の割合」では分けないこと。**イベント駆動でも 46% の秒で立つ
   （局が8つ・リーチが数回あり、`requestAnimationFrame` のずれで隣の秒にも乗る）。
   見張りの 78% との差が小さすぎて、走行ごとの揺れに埋もれる。

   分けるのは**秒あたりの平均**。`fitFour` 一回が 72 なので、

     見張りを戻した … 平均 113/秒（毎秒 144 が並ぶ）・最長の連続 11秒
     イベント駆動   … 平均  33/秒（立つ秒でも 72 が一回）・最長の連続 3秒

   **平均 72（＝毎秒 `fitFour` 一回）を超えたら見張り**とする。どちらからも
   二倍前後の余裕がある。連続の長さも併せて見る（上限6秒。同じく二倍弱の余裕） */
const MAX_MEAN = 72;        // 秒あたりの平均。fitFour 一回ぶんを超えたら見張り
const MAX_RUN = 6;          // 立ち続けた秒数の上限
function spShape(entries) {
  const late = entries.filter((e) => e.t >= 2);
  const runs = []; let cur = 0;
  late.forEach((e) => {
    if (e.sp > 0) cur++;
    else { if (cur) runs.push(cur); cur = 0; }
  });
  if (cur) runs.push(cur);
  const hot = late.filter((e) => e.sp > 0).length;
  const total = late.reduce((a, e) => a + e.sp, 0);
  return { n: late.length, hot, total, mean: late.length ? total / late.length : 0,
    maxRun: runs.length ? Math.max.apply(null, runs) : 0, runs };
}
const shapeOK = (sh) => sh.mean <= MAX_MEAN && sh.maxRun <= MAX_RUN;
const shapeStr = (sh) => '平均 ' + Math.round(sh.mean) + '/秒（上限 ' + MAX_MEAN
  + '）・立った秒 ' + sh.hot + '/' + sh.n + '・最長の連続 ' + sh.maxRun + '秒';

/* §3.1 の欄。**一つでも欠けたら読めない記録になる** */
const COLS=['t','k','d','n','img','tn','g','sp','r','ev','lag','w','ph','vv','mem'];
const read=(p)=>p.evaluate(()=>{
  try{return JSON.parse(localStorage.getItem('jandol.bb')||'null');}catch(e){return null;}
});
const SHOTS=(()=>{const i=process.argv.indexOf('--shots');return i>0?process.argv[i+1]:null;})();

(async()=>{const {srv,port}=await serve();const br=await chromium.launch();
const base='http://127.0.0.1:'+port+'/match.html';
/* **走行ごとに新しい context。**`localStorage` は origin ごとなので、
   使い回すと前の走行の `jandol.bb` が次の確認に混ざる（[2] がその場で嘘になる） */
const newCtx=()=>br.newContext({viewport:{width:844,height:334}});   // 四人卓の寸法
const p=await (await newCtx()).newPage();
p.on('pageerror',(e)=>{fails.push('PAGEERROR '+e.message);console.log('  NG  PAGEERROR '+e.message);});

console.log('\n[1] ?bb=1 で一戦まわす');
await p.goto(base+'?bb=1&auto=1&speed=0&length=ikkyoku&seed=1&sfx=0&start=1');
await p.waitForFunction(()=>document.body.classList.contains('inMatch'),null,{timeout:20000});
ok(await p.$('#flatBadge')!==null,'右下の印が出ている');
ok(await p.$('body.four')!==null,'四人卓（844×334）');
await p.waitForTimeout(2500);
const mid=await read(p);
ok(!!mid&&Array.isArray(mid.entries)&&mid.entries.length>0,'対局中にもう書かれている');
if(SHOTS){fs.mkdirSync(SHOTS,{recursive:true});await p.screenshot({path:path.join(SHOTS,'bb-badge.png')});}
const badge=await p.evaluate(()=>{const el=document.getElementById('flatBadge');return el?el.textContent:null;});
console.log('      印: '+badge);
ok(/^bb \d+s/.test(badge||''),'印が毎秒の一行になっている（bb <秒>s …）');
ok(/w:/.test(badge||''),'印に w が出ている');

/* 対局終了の画面（`match.js` の `showResult`）は `UI.modal` で待つ。
   押さないと `Match.play` が返らない＝走行が閉じない */
await p.waitForSelector('#overlay.show [data-v]',{timeout:120000});
await p.click('#overlay.show [data-v]');
await p.waitForFunction(()=>!document.body.classList.contains('inMatch'),null,{timeout:20000});
await p.waitForTimeout(200);
const run=await read(p);
ok(!!run,'走行が書かれている');
ok(typeof run.id==='number'&&typeof run.ua==='string'&&typeof run.flags==='string','走行の頭（id / ua / flags）');
const es=run.entries||[];
ok(es.length>=1,'entries が1行以上（'+es.length+'行）');
ok(es.length<=60,'entries は60行の輪を超えない');
const missing=[];
es.forEach((e,i)=>{COLS.forEach((c)=>{if(!(c in e))missing.push(i+':'+c);});});
eq(missing,[],'各行に §3.1 の欄が全部ある');
ok(es.every((e)=>Array.isArray(e.ev)&&e.ev.length===4),'ev は四つ並ぶ');
eq(es[es.length-1].w,'end','**最後の行が end**（閉じた走行）');
ok(es.some((e)=>e.g>0),'g が0でない行がある（getBoundingClientRect を数えている）');
ok(es.some((e)=>e.sp>0),'sp が0でない行がある（**四人卓で fitFour が動いた証**）');
ok(es.some((e)=>e.n>0&&e.tn>=0&&e.vv>0),'n / tn / vv が入っている');
ok(es.some((e)=>/four/.test(e.ph)),'ph に four が出ている');
ok(es.some((e)=>typeof e.w==='string'&&/^[a-zA-Z]+\+\d+$/.test(e.w)),'w が「関数名+経過ms」の形');
console.log('      最後の行: '+JSON.stringify(es[es.length-1]));

console.log('\n[2] 旗が無ければ何も仕込まない');
const p2=await (await newCtx()).newPage();
p2.on('pageerror',(e)=>{fails.push('PAGEERROR(2) '+e.message);console.log('  NG  PAGEERROR '+e.message);});
await p2.goto(base+'?auto=1&speed=0&length=ikkyoku&seed=1&sfx=0&start=1');
await p2.waitForFunction(()=>document.body.classList.contains('inMatch'),null,{timeout:20000});
await p2.waitForTimeout(2500);
ok(await p2.$('#flatBadge')===null,'#flatBadge が無い');
ok(await p2.evaluate(()=>localStorage.getItem('jandol.bb')===null),'jandol.bb が書かれていない');
ok(await p2.evaluate(()=>window.__bb===undefined),'__bb を仕込んでいない');
await p2.close();

console.log('\n[3] 読み直したとき、閉じていない走行が出る');
const p3=await (await newCtx()).newPage();
p3.on('pageerror',(e)=>{fails.push('PAGEERROR(3) '+e.message);console.log('  NG  PAGEERROR '+e.message);});
await p3.goto(base+'?bb=1&auto=1&speed=0&length=tonpuu&seed=1&sfx=0&start=1');
await p3.waitForFunction(()=>document.body.classList.contains('inMatch'),null,{timeout:20000});
await p3.waitForTimeout(3200);
await p3.reload();                       // **落ちたのと同じ形**（走行が閉じないまま読み直される）
await p3.waitForSelector('.dbgBB',{timeout:10000}).then(()=>ok(true,'.dbgBB が出る'),()=>ok(false,'.dbgBB が出ない'));
const lines=await p3.evaluate(()=>{const el=document.querySelector('.dbgBB pre');return el?el.textContent.split('\n'):[];});
ok(lines.length>=1&&lines.length<=5,'直近5行まで（'+lines.length+'行）');
ok(lines.every((l)=>{try{JSON.parse(l);return true;}catch(e){return false;}}),'一行ずつ読める');
if(SHOTS){await p3.screenshot({path:path.join(SHOTS,'bb-reload.png')});}
await p3.click('#dbgBBClear');
ok(await p3.$('.dbgBB')===null,'「消す」で消える');
ok(await p3.evaluate(()=>localStorage.getItem('jandol.bb')===null),'控えも消えている');
await p3.close();

console.log('\n[4] ?fourjs=0 が効いている（段2）');
const p4=await (await newCtx()).newPage();
p4.on('pageerror',(e)=>{fails.push('PAGEERROR(4) '+e.message);console.log('  NG  PAGEERROR '+e.message);});
await p4.goto(base+'?bb=1&fourjs=0&auto=1&speed=520&length=tonpuu&seed=1&sfx=0&start=1');
await p4.waitForFunction(()=>document.body.classList.contains('inMatch'),null,{timeout:20000});
ok(await p4.$('body.four')!==null,'`.four` は付いたまま（消しているのは JS 側だけ）');
eq(await p4.evaluate(()=>(document.getElementById('flatBadge')||{}).dataset.base),'fourjs=0 bb','印に fourjs=0 が出ている');
/* 素通しにした `UI.localDelta` は差分をそのまま返す（FLIP の向きは狂ってよい） */
eq(await p4.evaluate(()=>UI.localDelta(null,7,11)),[7,11],'UI.localDelta が素通しになっている');
await p4.waitForTimeout(2600);
/* **寸法を揺すってもイベント駆動の `fitFour` が走らないこと。**
   `onOrientationChange` の登録を弾いているので、`--side` 系は書き換わらない */
/* **高さを揺すって `--vvh` を見る。**`--vvh` を書くのは `applyViewportHeight` だけで、
   それを呼ぶのは `onOrientationChange`（と対局の頭の一回）。`?fourjs=0` はその
   登録を弾くので、**高さを変えても `--vvh` が凍ったまま**になる。
   `--side` では見分けられない——五つ目の機会（`UI.onLayout`）はこの旗の網に
   かからないので、局が変わればそこで測り直されて値が動く */
const vvhOf=(pg)=>pg.evaluate(()=>document.body.style.getPropertyValue('--vvh').trim());
const vvhAt334=await vvhOf(p4);
await p4.setViewportSize({width:844,height:300});
await p4.waitForTimeout(1600);
const vvhAt300=await vvhOf(p4);
await p4.setViewportSize({width:844,height:334});
await p4.waitForTimeout(1600);
if(SHOTS){await p4.screenshot({path:path.join(SHOTS,'bb-fourjs.png')});}
const r4=await read(p4);
const e4=(r4&&r4.entries)||[];
ok(e4.length>=4,'entries が4行以上（'+e4.length+'行）');
const late=e4.filter((e)=>e.t>=2);
ok(late.length>=1,'`t >= 2` の行がある（'+late.length+'行）');
/* **揺すっても寸法が追随しないこと。**`?fourjs=0` が落としているのは
   `onOrientationChange` の登録なので、**幅を変えても `--side` が凍ったまま**
   ——それがこの旗が効いている証。`sp` の数では見分けられない
   （局の変わり目や席プレートの変化でも立つ。そちらは `onLayout` の側で、
   この旗とは関係が無い）。値そのものを見るほうが確か */
ok(vvhAt300===vvhAt334,
  '**高さを 300 にしても --vvh が凍ったまま**（onOrientationChange が登録されていない）',
  '334 で '+vvhAt334+' / 300 で '+vvhAt300);
ok(e4.some((e)=>e.ev[0]>0),'resize は来ている（弾いているのは登録であってイベントではない）');
await p4.close();

/* **対照。**旗が無ければ `--vvh` は追随する。これが無いと上の錠は空証明になる
   （そもそも `--vvh` が動かないだけかもしれない） */
const p4b=await (await newCtx()).newPage();
await p4b.goto(base+'?bb=1&auto=1&speed=520&length=tonpuu&seed=1&sfx=0&start=1');
await p4b.waitForFunction(()=>document.body.classList.contains('inMatch'),null,{timeout:20000});
await p4b.waitForTimeout(1200);
const ctlA=await p4b.evaluate(()=>document.body.style.getPropertyValue('--vvh').trim());
await p4b.setViewportSize({width:844,height:300});
await p4b.waitForTimeout(1600);
const ctlB=await p4b.evaluate(()=>document.body.style.getPropertyValue('--vvh').trim());
ok(ctlA!==ctlB && !!ctlB,'旗が無ければ --vvh は追随する（上の錠が空証明でないこと）',
  '334 で '+ctlA+' / 300 で '+ctlB);
await p4b.close();

/* ---- [5] 見張りが**無い**こと（2026年9月10日に読み替えた） ----

   もとは「包みが二戦目でも効いているか」を見ていた（段2.5）。
   **見張りそのものが `src/match.js` から消えたので、見る向きが逆になった**
   ——いま確かめるのは「旗が無くても `sp` が立たない」ほう。
   ここが落ちたら、`src/` のどこかに寸法の見張りが生えている。

   **`sp` が 0 でなくてよいのは、局の変わり目だけ。**`UI.onLayout` が
   `kyokuChanged` で `scheduleFit` を呼ぶので、局が変わった秒に一回ぶん立つ。
   `requestAnimationFrame` で畳んでいる都合で**次の秒にずれ込むことがある**ので、
   「局が変わった秒」と「その次の秒」の二つを許す。局の変わり目は `k`
   （`kyoku:honba`）の変化で分かる。対局の切れ目（`k` が '' になる／戻る）も
   同じ扱いで拾える。

   **`?nofit=1` の走行は「同じ結果になる」ことだけ見る**——飲む相手が無いので、
   付けても付けなくても同じ表になるはず。差が出たら包みがまだ何かを飲んでいる */

/* 読み直さずに二戦。`?start=1` は一戦しか始めないので `startMatch` を自分で呼ぶ */
async function twoMatches(flag) {
  const label = flag ? '?' + flag : '?bb=1 だけ（旗なし）';
  console.log('\n[5] 見張りが無い（' + label + '）');
  const pg = await (await newCtx()).newPage();
  pg.on('pageerror', (e) => { fails.push('PAGEERROR(5 ' + label + ') ' + e.message); console.log('  NG  PAGEERROR ' + e.message); });
  await pg.goto(base + '?bb=1' + (flag ? '&' + flag : '') + '&sfx=0&seed=1');
  const play = () => pg.evaluate(() => { window.startMatch(true, 0, 'tonpuu'); });

  await play();                                             // 一戦目
  await pg.waitForFunction(() => document.body.classList.contains('inMatch'), null, { timeout: 20000 });
  await pg.waitForSelector('#overlay.show [data-v]', { timeout: 120000 });
  const one = ((await read(pg)) || {}).entries || [];
  const s1 = spShape(one);
  ok(s1.n >= 1, '一戦目に `t >= 2` の行がある（' + one.length + '行）');
  ok(shapeOK(s1), '一戦目：`sp` が立ち続けていない … ' + shapeStr(s1), JSON.stringify(s1.runs));
  ok(s1.hot > 0, '一戦目：`sp` が立つ秒はある（測る経路は生きている）');

  await pg.click('#overlay.show [data-v]');                 // 打ち切って二戦目へ
  await pg.waitForFunction(() => !document.body.classList.contains('inMatch'), null, { timeout: 20000 });
  await play();                                             // **二戦目。読み直していない**
  await pg.waitForFunction(() => document.body.classList.contains('inMatch'), null, { timeout: 20000 });
  await pg.waitForTimeout(4200);
  const two = ((await read(pg)) || {}).entries || [];
  const s2 = spShape(two);
  ok(two.length >= 1, '二戦目の走行に差し替わっている');
  ok(s2.n >= 1, '二戦目に `t >= 2` の行がある（' + two.length + '行）');
  ok(shapeOK(s2), '**二戦目も `sp` が立ち続けていない** … ' + shapeStr(s2), JSON.stringify(s2.runs));
  await pg.close();
  return { one: shapeOK(s1), two: shapeOK(s2) };
}
const bare = await twoMatches('');
const withNofit = await twoMatches('nofit=1');
/* **走行ごとに局の進みが違う**ので、立った秒の並びまでは揃わない。
   揃うのは**判定のほう**——どちらも「立ち続けていない」になること */
eq(withNofit, bare, '`?nofit=1` を付けても判定が変わらない（包みはもう何も飲まない）');

console.log('\n通過 '+pass+' 件'+(fails.length?' / 失敗 '+fails.length+' 件':''));
if(fails.length){fails.forEach((f)=>console.log('  ✗ '+f));process.exitCode=1;}
else console.log('すべて通過');
await br.close();srv.close();})();
