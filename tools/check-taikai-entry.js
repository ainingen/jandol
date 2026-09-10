#!/usr/bin/env node
/*
  大会の入口（`office/spec.md` §8.2）— **タブは「いま受けている招待の一覧」**

    node tools/check-taikai-entry.js

  **`index.html` で回す。**`taikai.html` は `offers.js` を読まないので、
  そちらはいままでどおり五つ並ぶ（開発用の入口はそのまま残す作法）。
  つまり**新しい振る舞いは本編でしか出ない**ので、ここは本編を開く。

  見るのは五つ。

    1. 招待がゼロの日は札が一枚も出ず、一言だけ出ること。
       **設定（`.tkSettings`）は残っていること**
    2. 並ぶのは `offerAccepted` の大会だけで、札が `data-offer` を持つこと
    3. 押すと**依頼と同じ経路**（`store.goTaikai` → `onDone`）に入り、
       **日が進む**こと（16人＝1日／64人＝2日）。
       店もその日数ぶん回っていること（`parlor.total.days`）
    4. **招待を消費すること。**同じ招待で二度出られないこと
    5. 単体ページ（`taikai.html`）はいままでどおり五つ並ぶこと

  **`playerRank` は `C` で回す。**新人戦と地方リーグは `strict` なので、
  S級では出場資格が無い（`tournament.js` の `canEnter`）。
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

const KEY='jandol_save_v1';
const save=(accepted)=>({
  discovered:[67,70,73,5,12], contracted:[67,70,73,5,12],
  comp:{67:60,70:55,73:70,5:65,12:62}, compMax:{}, grades:{}, favor:{},
  team:[67,70,73], teamDecided:true, money:5000000,
  playerName:'テスト事務所', playerFace:'p01', playerRank:'C', records:{}, recent:[], beaten:[],
  agency:3, autoMatch:true, matchSpeed:0, showHints:true,
  officePref:'tokyo', offers:[], offerAccepted:accepted.slice(), offerFired:[], mailRead:[],
  fatigue:{}, cond:{}, popUp:{}, local:{}, wins:{},
  parlor:{ open:true, day:40, rep:45, tables:4, interior:3, auto:1, sign:1, speed:1,
    joinNight:false, shifts:{}, bottles:[], regulars:[], seen:{}, buffs:[], log:[],
    total:{days:40,sales:0,profit:0,guests:0} },
});
const peek=(p)=>p.evaluate((k)=>{const s=JSON.parse(localStorage.getItem(k)||'{}');
  return { day:(s.parlor||{}).day, total:((s.parlor||{}).total||{}).days, money:s.money,
           accepted:(s.offerAccepted||[]).slice(),
           records:Object.keys(s.records||{}), offers:(s.offers||[]).map((o)=>o.id) };},KEY);
const view=(p)=>p.evaluate(()=>({
  tiers: Array.from(document.querySelectorAll('.tkTiers button.tkTier')).map((b)=>({
    tier:b.dataset.tier, offer:b.dataset.offer||null,
    name:(b.querySelector('.tkTierName')||{}).textContent })),
  empty: !!document.querySelector('.tkEmpty'),
  settings: !!document.querySelector('.tkSettings'),
}));

(async()=>{const {srv,port}=await serve();const BASE='http://127.0.0.1:'+port;
const br=await chromium.launch();
const open=async(acc)=>{const ctx=await br.newContext({viewport:{width:392,height:780}});
  const p=await ctx.newPage();
  p.on('pageerror',(e)=>{fails.push('PAGEERROR '+e.message);console.log('  NG  PAGEERROR '+e.message);});
  await p.goto(BASE+'/index.html');
  await p.evaluate(([k,s])=>localStorage.setItem(k,JSON.stringify(s)),[KEY,save(acc)]);
  await p.reload();
  /* 表紙 → 続きから → 事務所 */
  await p.waitForSelector('[data-act="continue"]',{timeout:15000});
  await p.click('[data-act="continue"]');
  await p.waitForSelector('#ofRoomHost, #ofShopHost',{timeout:15000});
  return p;};

/* ---------------- 1. 招待がゼロ ---------------- */
console.log('\n[招待がゼロの日]');
{ const p=await open([]);
  await p.click('#nav button[data-go="taikai"]'); await p.waitForTimeout(300);
  const v=await view(p);
  eq(v.tiers.length,0,'大会の札が一枚も出ない（TOURNAMENTS を全部並べない）');
  ok(v.empty,'「今日は招待がありません」が出る');
  ok(v.settings,'**設定（.tkSettings）は残っている**');
  await p.context().close(); }

/* ---------------- 2. 招待が一つ（新人戦・16人＝1日） ---------------- */
console.log('\n[新人戦の招待が一つ（16人＝1日）]');
{ const p=await open(['taikai-rookie']);
  await p.click('#nav button[data-go="taikai"]'); await p.waitForTimeout(300);
  let v=await view(p);
  eq(v.tiers.map((t)=>t.tier),['rookie'],'並ぶのは受けている招待だけ');
  eq(v.tiers[0].offer,'taikai-rookie','札が data-offer を持つ（依頼の経路へ渡すため）');
  ok(!v.empty,'招待があるので空の一言は出ない');
  const b0=await peek(p);

  await p.click('.tkTiers button.tkTier'); await p.waitForTimeout(500);
  ok(!!(await p.$('[data-act="start"]')),'出走表が出た（招待から入れた）');
  await p.click('[data-act="start"]');
  await p.waitForSelector('[data-act="result"]',{timeout:60000});
  await p.click('[data-act="result"]');
  await p.waitForSelector('[data-act="back"]',{timeout:20000});
  eq(await p.$eval('[data-act="back"]',(e)=>e.textContent.trim()),'事務所へ戻る',
     '**onDone が付いている**（依頼と同じ経路に入っている）');
  await p.click('[data-act="back"]');
  await p.waitForTimeout(1200);

  const a0=await peek(p);
  eq(a0.day-b0.day,1,'**日が1日進んだ**（16人＝1日。runJobDays を通った）');
  ok(a0.money!==b0.money,'賞金が入った',b0.money+' → '+a0.money);
  ok(a0.records.indexOf('rookie')>=0,'records に載った',JSON.stringify(a0.records));
  eq(a0.accepted,[],'**招待を消費した**（offerAccepted から落ちている）');
  ok(!!(await p.$('.ofNight, .ofRepRow, .ofSheet')),'事務所の夜が出ている');
  /* **雀荘の客が催促してこないこと。**大会に出ているあいだ店は留守の日として
     回っているので、`parlor.total.days` も同じだけ進んでいる
     （進んでいなければ「その日がまだ来ていない」ことになる） */
  eq(a0.total-b0.total,1,'**店もその日数ぶん回っている**（留守の日として消化した）');
  const night=await p.$eval('#view',(e)=>e.textContent.replace(/\s+/g,' '));
  ok(night.indexOf('新人戦')>=0,'夜の日報に大会の名前が出ている',night.slice(0,90));

  /* 二度出られないこと */
  await p.click('#nav button[data-go="taikai"]'); await p.waitForTimeout(300);
  v=await view(p);
  eq(v.tiers.length,0,'**同じ招待で二度は出られない**（タブから消えている）');
  ok(v.empty,'空の一言に戻る');
  await p.context().close(); }

/* ---------------- 3. 64人＝2日 ---------------- */
console.log('\n[全国オープンの招待（64人＝2日）]');
{ const p=await open(['taikai-open']);
  await p.click('#nav button[data-go="taikai"]'); await p.waitForTimeout(300);
  eq((await view(p)).tiers.map((t)=>t.tier),['open'],'全国オープンだけ並ぶ');
  const b0=await peek(p);
  await p.click('.tkTiers button.tkTier'); await p.waitForTimeout(500);
  await p.click('[data-act="start"]');
  await p.waitForSelector('[data-act="result"]',{timeout:90000});
  await p.click('[data-act="result"]');
  await p.waitForSelector('[data-act="back"]',{timeout:20000});
  await p.click('[data-act="back"]');
  await p.waitForTimeout(1500);
  const a0=await peek(p);
  eq(a0.day-b0.day,2,'**日が2日進んだ**（64人＝2日）');
  eq(a0.total-b0.total,2,'店も2日ぶん回っている');
  eq(a0.accepted,[],'招待を消費した');
  await p.context().close(); }

/* ---------------- 4. 単体ページはいままでどおり ---------------- */
console.log('\n[単体ページ（offers.js を読まない）]');
{ const ctx=await br.newContext({viewport:{width:392,height:780}});
  const p=await ctx.newPage();
  p.on('pageerror',(e)=>{fails.push('PAGEERROR(taikai.html) '+e.message);console.log('  NG  '+e.message);});
  await p.goto(BASE+'/taikai.html');
  await p.evaluate(([k,s])=>localStorage.setItem(k,JSON.stringify(s)),[KEY,save([])]);
  await p.reload(); await p.waitForTimeout(500);
  const v=await view(p);
  eq(v.tiers.length,5,'**単体ページは五つ並んだまま**（Offers を読まないので）');
  ok(v.tiers.every((t)=>!t.offer),'単体ページの札は data-offer を持たない');
  ok(!v.empty,'空の一言は出ない');
  await ctx.close(); }

console.log('\n通過 '+pass+' 件'+(fails.length?' / 失敗 '+fails.length+' 件':''));
if(fails.length){fails.forEach((f)=>console.log('  ✗ '+f));process.exitCode=1;}
else console.log('すべて通過');
await br.close();srv.close();})();
