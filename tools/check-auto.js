#!/usr/bin/env node
/*
  おまかせ ↔ 手打ちに戻る（`ui.js` の `giveUp` / `takeOver`）

    node tools/check-auto.js

  **ブラウザで実際に押す。**`test-match.js` は形（本文の錠）しか見られない
  ——釦の文言が切り替わるか、倒したあと**本当に手番が返ってくるか**は、
  `game.js` を一局まわさないと分からない（`check-hand.js` と同じ理由）。

  見るのは五つ。

    1. 入る前は「おまかせ」で、自分の手番で止まっていること
    2. おまかせ（早送り）に入ると、釦が「手打ちに戻る」に変わり、
       **消えていない**こと。入る前の速さを控えていること
    3. 戻すと auto / isAI が倒れ、**速さが復る**こと
       ——0（早送り）のままだと `endAutoMs` が 400 を返して締めの帯が勝手に流れる
    4. **手番が返ってくる**こと（次の判断から `askTurn` に入る）
    5. 往復できること（二度目も入れて、二度目も戻れる）

  幽霊クリックの側は `tools/drive-match.js --play --width 844 --height 334`
  （`takeOver` が呼ばれていないことを数えている）。

  **六つめ：カットインに覆われていないこと**（2026年9月10日）。
  右側のカットイン（`data-side="right"`）は「おまかせ」と同じ右上の角へ出る。
  `pointer-events:none` なので**押せてはいる**——だから click だけでは捕まらない。
  **見えているか**は箱の重なりで見るしかないので、ここでは矩形で測る。
  `--cw` は縦が広いほど太るので、**844×334 と 1280×800 の両方**で見る
  （1280×800 は 96px まで育ち、直す前は釦を 100% 覆っていた側）。
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
const state=(p)=>p.evaluate(()=>({
  auto: !!UI.auto, isAI: !!(UI.game && UI.game.players[0].isAI), speed: UI.speed,
  pre: UI._preAutoSpeed === undefined ? 'undef' : UI._preAutoSpeed,
  label: (document.querySelector('#giveup')||{}).textContent,
  pending: UI.pending ? UI.pending.type : null,
}));
(async()=>{const {srv,port}=await serve();const br=await chromium.launch();
const ctx=await br.newContext({viewport:{width:844,height:334}});const p=await ctx.newPage();
p.on('pageerror',(e)=>{fails.push('PAGEERROR '+e.message);console.log('  NG  PAGEERROR '+e.message);});
await p.goto('http://127.0.0.1:'+port+'/match.html?start=1&speed=520&sfx=0&seed=20260910');
await p.waitForSelector('#giveup',{timeout:15000});
await p.waitForFunction(()=>UI.pending,null,{timeout:20000});

console.log('\n[入る前]');
let s=await state(p);
eq(s.label,'おまかせ','釦は「おまかせ」');
eq([s.auto,s.isAI,s.speed],[false,false,520],'auto / isAI / speed');
ok(s.pending!==null,'自分の手番で止まっている（手打ち）');

console.log('\n[おまかせ（早送り）に入る]');
await p.click('#giveup');
await p.waitForSelector('#overlay.show [data-v]',{timeout:5000});
await p.click('[data-v="fast"]');
await p.waitForTimeout(400);
s=await state(p);
eq(s.label,'手打ちに戻る','釦が「手打ちに戻る」に変わる');
eq([s.auto,s.isAI,s.speed],[true,true,0],'auto / isAI / speed（早送り）');
eq(s.pre,520,'入る前の速さを控えている');
ok(!!(await p.$('#giveup')),'**釦が消えていない**（一方通行にしない）');
await p.waitForTimeout(1200);
ok((await state(p)).pending===null,'おまかせのあいだは入力待ちにならない');

console.log('\n[手打ちに戻る]');
await p.click('#giveup');
await p.waitForTimeout(150);
s=await state(p);
eq(s.label,'おまかせ','釦が「おまかせ」に戻る');
eq([s.auto,s.isAI],[false,false],'auto / isAI が倒れる');
eq(s.speed,520,'**速さが復る**（0 のままだと帯が勝手に流れる）');
eq(s.pre,null,'控えが空になる');
console.log('  …次の手番を待つ');
await p.waitForFunction(()=>!!UI.pending,null,{timeout:30000}).then(
  ()=>ok(true,'**手番が返ってきた**（次の判断から askTurn に入る）'),
  ()=>ok(false,'手番が返ってこない'));

console.log('\n[もう一度おまかせ→戻す（往復できる）]');
await p.click('#giveup');
await p.waitForSelector('#overlay.show [data-v]',{timeout:5000});
await p.click('[data-v="auto"]');
await p.waitForTimeout(300);
eq((await state(p)).label,'手打ちに戻る','二度目も入れる');
await p.click('#giveup');
await p.waitForTimeout(150);
s=await state(p);
eq([s.label,s.auto,s.speed],['おまかせ',false,520],'二度目も戻れる（速さも 520 のまま）');

console.log('\n[右側のカットインに覆われていないこと]');
/* カットインは pointer-events:none なので、click では「押せる」としか分からない。
   **見えているか**は箱の重なりでしか測れない */
const cover=async(pg)=>pg.evaluate(()=>{
  UI.say(1,'idle');
  const box=document.querySelector('#cutin');
  box.dataset.side='right'; box.classList.add('on');
  if(!box.querySelector('.line').textContent) box.querySelector('.line').textContent='ゆっくり、ゆっくり';
  const rc=(s)=>{const e=document.querySelector(s);const b=e.getBoundingClientRect();
    return {x:b.x,y:b.y,r:b.right,b:b.bottom};};
  const area=(a,b)=>Math.max(0,Math.min(a.r,b.r)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.b,b.b)-Math.max(a.y,b.y));
  const g=rc('#giveup');
  const whole=(g.r-g.x)*(g.b-g.y);
  return {
    card:Math.round(area(g,rc('#cutin .card'))/whole*100),
    bubble:Math.round(area(g,rc('#cutin .bubble'))/whole*100),
    cw:getComputedStyle(box).getPropertyValue('--cw').trim(),
    plate:Math.round(area(rc('#cutin .card'),rc('#plate-right'))),
  };
});
for(const [w,h] of [[844,334],[1280,800]]){
  const c2=await br.newContext({viewport:{width:w,height:h}});
  const p2=await c2.newPage();
  await p2.goto('http://127.0.0.1:'+port+'/match.html?start=1&speed=520&sfx=0&seed=20260910');
  await p2.waitForSelector('#giveup',{timeout:15000});
  await p2.waitForFunction(()=>!!UI.game,null,{timeout:20000});
  const c=await cover(p2);
  ok(c.card===0,w+'×'+h+'：立ち絵のカードが「おまかせ」に掛からない','覆い '+c.card+'% / --cw '+c.cw);
  ok(c.bubble===0,w+'×'+h+'：吹き出しが「おまかせ」に掛からない','覆い '+c.bubble+'%');
  /* 下げたぶんはカードを細くして返す。左右のプレート（点数）を隠さないこと */
  ok(c.plate===0,w+'×'+h+'：カードが右のプレートに掛からない','重なり '+c.plate+'px²');
  /* 覆われていないうえで、**本当に押せる**こと */
  await p2.click('#giveup');
  await p2.waitForSelector('#overlay.show [data-v]',{timeout:5000}).then(
    ()=>ok(true,w+'×'+h+'：カットインが出ていても「おまかせ」が押せる'),
    ()=>ok(false,w+'×'+h+'：カットインが出ていると「おまかせ」が押せない'));
  await c2.close();
}

console.log('\n通過 '+pass+' 件'+(fails.length?' / 失敗 '+fails.length+' 件':''));
if(fails.length){fails.forEach((f)=>console.log('  ✗ '+f));process.exitCode=1;}
else console.log('すべて通過');
await br.close();srv.close();})();
