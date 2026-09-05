#!/usr/bin/env node
/*
  打牌の操作をブラウザで確かめる（src/ui.js の bindHand。docs/design/match/spec.md §8）

    node tools/check-hand.js

  なぜ要るか：
    確定を「押した瞬間」から「離した瞬間」へ移した（2026年9月5日）。**指の接地は
    9〜10mm あり、牌幅より広い**ので、当たり判定を広げても隣が狭くなるだけだった。
    押している間は持ち上がる牌が指に追随し、離したところで切れる。

    この経路は pointerdown / pointermove / pointerup と pointer capture、
    それに `elementFromPoint` で成り立っていて、**node からは呼べない。**
    `tools/test-match.js` は DOM に触らない関数だけなので、ここは別に要る。

  見るのは五つ。**打牌まわりを触ったら回すこと。**

    1. 押した瞬間に持ち上がり、離すまで切れない。横へずらすと追随する
    2. 帯の外（下）で離したら取り消し
    3. 上へ払うのはいままでどおり切れる（設定に関係なく）
    4. 二度押しは二度目で切る（押している間はずらせる）
    5. `element.click()` の合成クリックでも切れる
       ——`tools/drive-match.js --play` がこれを使っている
*/
'use strict';
const http=require('http'),fs=require('fs'),path=require('path');
const {chromium}=require('/opt/node22/lib/node_modules/playwright');
const ROOT='/home/user/jandol';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.wav':'audio/wav','.webp':'image/webp','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg'};
const srv=http.createServer((q,r)=>{const rel=decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/,'')||'index.html';const f=path.join(ROOT,rel);fs.readFile(f,(e,b)=>{if(e){r.writeHead(404).end();return;}r.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'});r.end(b);});});
let pass=0, fail=0;
const ok=(c,n,d)=>{ if(c){pass++;console.log('  ✓ '+n);} else {fail++;console.log('  ✗ '+n+(d?'  '+d:''));} };

srv.listen(0,'127.0.0.1',async()=>{
  const port=srv.address().port; const br=await chromium.launch();
  async function fresh(mode){
    const page=await br.newPage({viewport:{width:844,height:390}});
    page.on('pageerror',e=>{console.log('PAGEERROR',e.message);fail++;});
    await page.goto(`http://127.0.0.1:${port}/match.html?seed=7&sfx=0&discard=${mode}`);
    await page.waitForFunction(()=>typeof UI!=='undefined');
    await page.evaluate(()=>{ startMatch(false,900,'tonpuu'); });
    await page.waitForFunction(()=>UI.pending&&UI.pending.type==='turn'
      &&document.querySelectorAll('#handrow .tile.selectable').length>=13,{timeout:30000});
    await page.waitForTimeout(250);
    return page;
  }
  const boxes=(page)=>page.evaluate(()=>[...document.querySelectorAll('#handrow .tile.selectable')]
    .map(t=>{const r=t.getBoundingClientRect();
      return {id:+t.dataset.id,cx:r.left+r.width/2,cy:r.top+r.height/2,bottom:r.bottom};}));
  const hand=(page)=>page.evaluate(()=>UI.game.players[0].hand.slice());

  console.log('打牌の操作 — 離して確定（一度押し）');
  {
    const page=await fresh('single');
    const b=await boxes(page); const before=await hand(page);
    /* 押す → 隣へずらす → 離す。切れるのは「離したときに指の下にある牌」 */
    await page.mouse.move(b[3].cx,b[3].cy); await page.mouse.down();
    await page.waitForTimeout(60);
    const lifted1=await page.evaluate(()=>UI._selected);
    ok(lifted1===b[3].id,'押した瞬間にその牌が持ち上がる');
    const hint1=await page.evaluate(()=>document.querySelector('#hintbox').textContent);
    ok(/指を離すと切る/.test(hint1),'掴んでいる牌の名前が出る','"'+hint1+'"');
    await page.mouse.move(b[5].cx,b[5].cy); await page.waitForTimeout(60);
    const lifted2=await page.evaluate(()=>UI._selected);
    ok(lifted2===b[5].id,'横へずらすと持ち上がる牌が追随する');
    const stillSame=JSON.stringify(await hand(page))===JSON.stringify(before);
    ok(stillSame,'離すまでは切れていない');
    await page.mouse.up(); await page.waitForTimeout(400);
    const after=await hand(page);
    ok(!after.includes(b[5].id),'離した牌が切れた');
    ok(after.includes(b[3].id),'最初に押した牌は切れていない');
    await page.close();
  }
  console.log('\n帯の外（下）で離すと取り消し');
  {
    const page=await fresh('single');
    const b=await boxes(page); const before=await hand(page);
    await page.mouse.move(b[2].cx,b[2].cy); await page.mouse.down();
    await page.waitForTimeout(50);
    await page.mouse.move(b[2].cx,b[2].bottom+70); await page.waitForTimeout(60);
    const liftedOut=await page.evaluate(()=>UI._selected);
    ok(liftedOut===null,'帯の外へ出すと持ち上がりが消える','got '+liftedOut);
    await page.mouse.up(); await page.waitForTimeout(400);
    ok(JSON.stringify(await hand(page))===JSON.stringify(before),'外で離しても切れない');
    await page.close();
  }
  console.log('\n上へ払うのはそのまま');
  {
    const page=await fresh('single');
    const b=await boxes(page); const before=await hand(page);
    await page.mouse.move(b[7].cx,b[7].cy); await page.mouse.down();
    await page.mouse.move(b[7].cx,b[7].cy-60,{steps:4}); await page.mouse.up();
    await page.waitForTimeout(400);
    const after=await hand(page);
    ok(before.length-after.length===1,'上へ払うと切れる');
    ok(!after.includes(b[7].id),'払った牌が切れた');
    await page.close();
  }
  console.log('\n二度押しは二度目で切る（押している間はずらせる）');
  {
    const page=await fresh('double');
    const b=await boxes(page); const before=await hand(page);
    await page.mouse.move(b[4].cx,b[4].cy); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(200);
    ok(JSON.stringify(await hand(page))===JSON.stringify(before),'一度目では切れない');
    ok(await page.evaluate(()=>UI._selected)===b[4].id,'一度目で選ばれたまま残る');
    const hint=await page.evaluate(()=>document.querySelector('#hintbox').textContent);
    ok(/もう一度たたくと切る/.test(hint),'二度押しの案内が出る','"'+hint+'"');
    await page.mouse.move(b[4].cx,b[4].cy); await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(400);
    ok(!(await hand(page)).includes(b[4].id),'二度目で切れた');
    await page.close();
  }
  console.log('\n合成クリック（element.click()）でも切れる — drive-match が使う');
  {
    const page=await fresh('single');
    const before=await hand(page);
    const id=await page.evaluate(()=>{const t=document.querySelector('#handrow .tile.selectable');
      t.click(); return +t.dataset.id;});
    await page.waitForTimeout(400);
    const after=await hand(page);
    ok(before.length-after.length===1 && !after.includes(id),'合成クリックで一枚切れる');
    await page.close();
  }
  await br.close(); srv.close();
  console.log('\n通過 '+pass+' 件'+(fail?' / 失敗 '+fail+' 件':''));
  process.exit(fail?1:0);
});
