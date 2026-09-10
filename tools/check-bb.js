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
       `sp` が一度も増えない——寸法を測り直す経路が二本とも
       （500ms の見張りも、イベント駆動も）止まっている。
       **`page.setViewportSize` で揺すっても増えない**のがイベント駆動の側の証
    5. **二戦目でも効いている**こと（段2.5）。`Match.play` は対局ごとに
       500ms の見張りを登録し直すので、**包みが「一本飲んだら元に戻す」だと
       二戦目から復活する**（実機の3本目で踏んだ）。読み直さずに
       `startMatch` を二回続けて呼び、**二戦目の `t >= 2` の行の `sp` が
       全部0**であることを `?nofit=1` と `?fourjs=0` の両方で見る
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
await p4.setViewportSize({width:812,height:334});
await p4.waitForTimeout(1600);
await p4.setViewportSize({width:844,height:334});
await p4.waitForTimeout(1600);
if(SHOTS){await p4.screenshot({path:path.join(SHOTS,'bb-fourjs.png')});}
const r4=await read(p4);
const e4=(r4&&r4.entries)||[];
ok(e4.length>=4,'entries が4行以上（'+e4.length+'行）');
const late=e4.filter((e)=>e.t>=2);
ok(late.length>=1,'`t >= 2` の行がある（'+late.length+'行）');
eq(late.filter((e)=>e.sp>0).map((e)=>e.t+':'+e.sp),[],'**`t >= 2` の行の sp が全部0**（初回の fitFour のあと一度も走っていない）');
ok(e4.some((e)=>e.ev[0]>0),'resize は来ている（弾いているのは登録であってイベントではない）');
await p4.close();

/* ---- [5] 二戦目でも効いている（段2.5） ----
   **`Match.play` は対局ごとに見張りを登録し直す。**包みが一本飲んで元に戻すと、
   二戦目から `sp` が 0 → 144 に戻る（実機の3本目で踏んだ）。
   `?start=1` は一戦しか始めないので、**`startMatch` を自分で二回呼ぶ。** */
async function twice(flag){
  console.log('\n[5] 二戦目でも効いている（?'+flag+'・段2.5）');
  const pg=await (await newCtx()).newPage();
  pg.on('pageerror',(e)=>{fails.push('PAGEERROR(5 '+flag+') '+e.message);console.log('  NG  PAGEERROR '+e.message);});
  await pg.goto(base+'?bb=1&'+flag+'&sfx=0&seed=1');       // start=1 は付けない
  const play=()=>pg.evaluate(()=>{window.startMatch(true,0,'ikkyoku');});
  const late=(r)=>((r&&r.entries)||[]).filter((e)=>e.t>=2);

  await play();                                             // 一戦目
  await pg.waitForFunction(()=>document.body.classList.contains('inMatch'),null,{timeout:20000});
  await pg.waitForSelector('#overlay.show [data-v]',{timeout:120000});
  const one=late(await read(pg));
  ok(one.length>=1,'一戦目に `t >= 2` の行がある（'+one.length+'行）');
  eq(one.filter((e)=>e.sp>0).map((e)=>e.t+':'+e.sp),[],'一戦目の sp が全部0');

  await pg.click('#overlay.show [data-v]');                 // 打ち切って二戦目へ
  await pg.waitForFunction(()=>!document.body.classList.contains('inMatch'),null,{timeout:20000});
  await play();                                             // **二戦目。読み直していない**
  await pg.waitForFunction(()=>document.body.classList.contains('inMatch'),null,{timeout:20000});
  await pg.waitForTimeout(3400);
  const r2=await read(pg);
  const two=late(r2);
  ok(((r2&&r2.entries)||[]).length>=1,'二戦目の走行に差し替わっている');
  ok(two.length>=1,'二戦目に `t >= 2` の行がある（'+two.length+'行）');
  eq(two.filter((e)=>e.sp>0).map((e)=>e.t+':'+e.sp),[],
    '**二戦目の sp も全部0**（一本飲んで元に戻すと 144 が返ってくる）');
  await pg.close();
}
await twice('nofit=1');
await twice('fourjs=0');

console.log('\n通過 '+pass+' 件'+(fails.length?' / 失敗 '+fails.length+' 件':''));
if(fails.length){fails.forEach((f)=>console.log('  ✗ '+f));process.exitCode=1;}
else console.log('すべて通過');
await br.close();srv.close();})();
