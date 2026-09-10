# 四人卓で落ちる件の追跡 ／ docs/design/match/crash-spec.md

作成 2026年9月10日。対象は `BACKLOG.md`「四人卓のときだけ、対局中に再読み込みされる」。
**これは直す仕様書ではなく、原因を特定するための道具の仕様書。**
直しかたは原因が出てから別に書く。

---

## 0. いま分かっていること・分かっていないこと

**分かっていること**（`BACKLOG.md`・コミット `904bca7`）

- iPhone の実機で、`body.inMatch.four` のときだけ対局中にページが読み直される。
  Safari も Chrome も。縦持ちの列レイアウトでは落ちない。縦持ちのまま回転表示で
  四人卓にしても落ちる——**端末の向きではなく `.four` が持ち込む何か**
- 落ちるまでの打牌数はばらつく
- 外したもの（**それぞれ単独で**）：3D 一式（`?flat=3`）、`fitFour()` の 500ms の見張り
  （`?nofit=1`）、指の操作（`?auto=1`）、顔の画像の寸法（`thumb/`）。
  **どれを外しても落ちるまでの時間が伸びなかった**

**分かっていないこと**

- **落ちる直前に何が起きていたか。**これを一度も見ていない。
  iOS は再読み込みの理由を教えないし、実機では開発者ツールが使えない
- **メモリで殺されたのか、主スレッドが止まって殺されたのか。**iOS が WebContent を
  落として読み直すのは、**メモリを取り上げたとき**だけではない——
  **主スレッドが一定時間応答しないとき**も同じ症状になる。
  見え方が同じなので、どちらかを決めないまま「重い処理」を探していた
- **原因が一つなのか複数なのか。**三つを別々に外して駄目だったが、
  **三つを同時に外した走行は無い。**原因が二つあって片方ずつ外していたなら、
  いまの表は何も否定していない

**これまでの表で外れていなかったもの**（`match.js` / `match.css` を読み直した結果）

| 分岐 | 何をしているか |
| --- | --- |
| `fitFour()` の**イベント駆動**の実行 | `?nofit=1` は `setInterval` を握り潰すだけ。`resize` / `orientationchange` / `visualViewport` の `resize`・`scroll` から `onOrientationChange` → `updateRotate` → `fitTable` → `fitFour` が走り、さらに +120ms・+400ms でもう二回走る。1回あたり `getBoundingClientRect` 166回＋`body.style.setProperty`（`--side` `--side-w` `--felt-y`）約100回で、**この三つは全ツリーが参照する変数**なので毎回スタイルの再計算になる |
| `#felt::before` の `box-shadow: 0 28px 44px` と `::after` の網点 | 44px のぼかしを持つ大きな影。`flat=3` は transform だけ外して、これは残る |
| 河の構造（0×0 の `.rslot` の中に `display:grid; width:max-content`） | 列レイアウトは flex で、四人卓だけこの形 |
| `.rslot` `#top` `#left` `#right` の 2D 回転（`rotate(90/180/-90deg)`） | `flat=3` は `transform-style` と `perspective` を外すだけで、2D の回転は残る |
| `UI.localDelta()` | FLIP の差分を 36° と席の角度で回す算術。低いが、四人卓だけ通る |
| `--tw` の `13dvh`、`.cutin` の `23vh`、回転表示の `100dvh` / `100dvw` | iOS ではバーの出入りで値が動く |

**両レイアウトに共通で、四人卓固有ではないもの**（念のため書いておく。疑うのは後）：
`#app::before` の 1200×1200 の conic-gradient、`::after` の mask、`#toast` の text-stroke、
`.endTint` の `mix-blend-mode`、`requestFullscreen` / `orientation.lock` の試行、SVG 牌の `<img>` の数。

## 1. 方針

**削る前に、見る。**落ちる直前の状態を毎秒書き残し、読み直したときにそれを見せる。
これが一本入れば、「メモリか、ハングか」「積み上がりか、瞬間か」「何の最中か」が
一回の走行で分かる。**削る実験はそのあと**、記録が指した方へ。

**三つの決めごと**

1. **`match.html` のインラインだけで作る。`src/` には一行も足さない。**
   `?flat=` `?nofit=` と同じ理由（`src/*.css|js` は GitHub Pages が10分キャッシュする。
   `match.html` はクエリが付くので必ず新しく取れる）。**本番には入らない**
2. **旗が無ければ何もしない。印も出ない。**`?bb=1` を付けたときだけ動く。
   `drive-resume.js` `drive-match.js` `check-auto.js` は旗を付けないので、件数が動かない
3. **変数を一つずつ。**同じ走行で二つの旗を足すのは、**段0 の「全部重ねる」一回だけ**。
   あれは「複数原因か」を見る走行で、性質が違う

## 2. 段の切りかた

| 段 | 何を入れるか | 実機 |
| --- | --- | --- |
| 段1 | **ブラックボックス**（`?bb=1`）。§3 | 入れてから |
| 段2 | **JS か CSS かの切り分け**（`?fourjs=0`）。§4 | 段1 と同じ日 |
| 段0 | 旗を重ねた走行（`?bb=1&flat=3&nofit=1&auto=1`）。**コード変更なし** | 段1・段2 と同じ日 |
| 段3 | CSS の階段（`?fourcss=N`）。§5 | **段2 で「CSS」と出てから** |

段1 と段2 は互いに依存しないので、Claude Code には続けて入れさせ、
実機は一度の `git pull` で三通り（段1 素・段0・段2）を回す。**段3 はそのあと。**

## 3. 段1 ブラックボックス（`?bb=1`）

### 3.1 何を書くか

`?bb=1` のとき、**対局が始まってから毎秒一行**を `localStorage` に足す。
鍵は `jandol.bb`（`Resume` の鍵と別）。中身は一つの走行 `{ id, ua, flags, entries }` で、
`entries` は**直近60行の輪**（古いものから落とす。1分あれば十分——落ちる直前が要る）。

一行に入れるもの。**全部ただの数。**

| 欄 | 中身 | 何を見るためか |
| --- | --- | --- |
| `t` | 開始からの秒 | 横軸 |
| `k` | `kyoku:honba` | どの局か |
| `d` | 総打牌数（`UI.discardCount()`） | 「打牌数がばらつく」の打牌数 |
| `n` | `document.getElementsByTagName('*').length` | **DOM が育っているか**（メモリの仮説） |
| `img` | `<img>` の数 | 同上 |
| `tn` | `UI._nodes ? UI._nodes.size : 0` | keyed の Map が育っていないか |
| `g` | 直近1秒の `getBoundingClientRect` 回数 | **`fitFour` の代理指標**。166の倍数で跳ねればそれ |
| `sp` | 直近1秒の `setProperty('--side' \| '--side-w' \| '--felt-y')` 回数 | 同上（見張りが止まっていても、イベント駆動で走ったかが見える） |
| `r` | 直近1秒の `UI.render` 回数 | 描き直しの頻度 |
| `ev` | 直近1秒の `resize` / `orientationchange` / `visualViewport.resize` / `visualViewport.scroll` の回数（四つ並べる） | **イベントが暴れていないか** |
| `lag` | 直近1秒で、1秒のタイマーが**予定より何ms遅れたか**の最大 | **主スレッドが止まった長さ。**ハングの仮説はここに出る |
| `w` | 最後に入った関数名と、そこからの経過ms | 「何の最中か」 |
| `ph` | `#app` の class（`ending` / `end-*` / `bust-*`）と `body` の class（`four` / `rotated` / `flat*`） | 締めの最中か、どのレイアウトか |
| `vv` | `visualViewport.height` | バーの出入り |
| `mem` | `performance.memory.usedJSHeapSize`（あれば。Safari には無い） | Chrome での参考 |

**`w` の取りかた。**`UI.render` `UI.flip` `UI.flyIn` `UI.showEnd` `UI.flyScores`
`UI.result` `UI.event` `UI.say` `UI.modal` を**外から包む**（`UI` は global のオブジェクトなので
`match.html` から差し替えられる）。入口で名前と時刻を控えるだけ。
**戻りは控えない**——落ちるのは同期処理の途中か、直後の描画なので、「最後に入ったもの」で足りる。

**`g` `sp` の取りかた。**`src/` を読む**前に** `Element.prototype.getBoundingClientRect` と
`CSSStyleDeclaration.prototype.setProperty` を包んで数える（数えるだけ。値は素通し）。
`?nofit=1` の `setInterval` と同じ場所。

**`ev` の取りかた。**自前で同じイベントに listener を付けて数える。`match.js` の listener を
包む必要は無い。

### 3.2 いつ書くか

- **毎秒。**`setInterval(fn, 1000)`。`match.js` の 500 とは間隔が違うので `?nofit=1` に食われない
- **`pagehide` と `visibilitychange(hidden)` のとき**にも一行、`w` を `pagehide` / `hidden` にして書く。
  **落ちたときはこれが来ない**——来ていれば、それは落ちたのではなくバックグラウンドに回っただけ。
  いままで「落ちた」と数えていたものの中に、これが混ざっていないかも一緒に分かる
- **`Match.play` が返ったとき**に一行、`w` を `end` にして書き、走行を閉じる
- `localStorage` への書き込みは `try/catch`。投げても対局を止めない（`resume.js` と同じ作法）

### 3.3 どう見せるか

- **右下の印**（`#flatBadge`。既存）に `bb` を足し、**毎秒中身を一行で更新する**：
  `bb 123s 東2局 d47 n1834 g166 lag12 w:render`。実機で目で見えるので、
  落ちる瞬間に何が跳ねていたかを**その場で**読める
- **読み直したとき**、`jandol.bb` に閉じていない走行（最後の `w` が `end` でない）があれば、
  復帰の一言（`#dbgResume`）の**下**に `<pre>` で**直近5行**を出す。復帰の控えが無くても出す。
  「消す」の釦を一つ。**`?bb=1` が無くても出す**——落ちて読み直された URL には旗が残るが、
  手で開き直したときも読めるように
- 表示は monospace の一行ずつ。整形はしない

### 3.4 急所

- **`UI.update` に乗せないこと**（局中に何十回も呼ばれる。`BACKLOG.md`）。書くのはタイマーだけ
- **数える包みは `src/` より前に仕込み、旗が無ければ仕込まない。**`getBoundingClientRect` は
  対局中に毎秒何百回も呼ばれるので、包みが乗っているだけで測定そのものが誤差になる
- **`Math.random` に触らない。**`?seed=` と干渉させない
- **記録の中に文字列を増やさない。**名前や配列を入れ始めると一行が育ち、60行の輪で
  `localStorage` を食う。数と短い識別子だけ
- **輪を超えて残さない。**落ちたときの解析に要るのは直前1分で、全走行の履歴ではない
- **本編（`index.html`）には持ち込まない。**大会の中で見たくなったらそのとき別に決める

### 3.5 読みかた（実機のあと）

| 最後の数行が | 読み |
| --- | --- |
| `n` `img` `tn` が右肩上がり | **DOM の積み上がり。**どれが育っているかで犯人が絞れる（`img` なら顔かカットイン、`tn` なら keyed の Map、`n` だけなら innerHTML の組み直し） |
| `lag` が数百〜数千ms、直前に `g` `sp` が跳ねている | **ハング。**`fitFour` がイベント駆動で連打されている。`ev` にどのイベントが来ていたかが出る |
| `lag` は小さく `n` も平ら、`w` が特定の関数に偏る | その関数の中の**描画**（WebKit 側）。CSS の階段（段3）へ |
| 最後の行が `pagehide` / `hidden` | **落ちていない。**バックグラウンドに回っただけ。数え直し |
| `ph` に `ending` がある回が多い | 締めの帯の最中。立ち絵（`faceBig` = `img/`）と帯の transition が容疑に上がる |

## 4. 段2 JS か CSS か（`?fourjs=0`）

**`.four` のクラスは付けたまま、JS 側の分岐だけを消す。**落ちれば CSS、落ちなければ JS。

- `src/` より前に：`window.setInterval` の 500 を握り潰す（`?nofit=1` と同じ。
  **`fourjs=0` は `nofit` を含む**）。`window` / `screen.orientation` / `visualViewport` の
  `addEventListener` を包み、**listener の `name` が `onOrientationChange` のものだけ登録しない**
  （`match.js` は `function onOrientationChange` と名前付きで定義している。
  名前で拾うのは脆いが、`src/` に触らないならこれがいちばん浅い。名前が変わったら
  ここも直すこと——印が出ているのに `sp` が0でなければ効いていない、で気づける）
- `src/` のあとに：`UI.localDelta = (el, dx, dy) => [dx, dy]`。FLIP の向きが四人卓で
  狂う（左右の家の打牌が変な方向へ飛ぶ）。**絵は崩れてよい**
- **初回の `fitFour()` は一度だけ走る**（`updateRotate()` から）。以後は寸法が固定される。
  `?nofit=1` と同じ制約で、向きを変えると崩れる
- 印は `fourjs=0`。`?bb=1` と重ねられる（段2 の実機は必ず `bb` 付きで回す）

## 5. 段3 CSS の階段（`?fourcss=N`）— **段2 で CSS と出てから**

`?flat=` と同じ形（`<body>` に `fourcss1..N`、インラインの `<style>` で `!important`）。
**積み上げ式**で、N で止まればそこが犯人。順番は「外したとき絵の崩れが小さいもの」から。

| N | 外すもの |
| --- | --- |
| 1 | `#felt::before` の `box-shadow` と `::after` の網点（`display:none`） |
| 2 | `.river` を `display:flex; flex-wrap:wrap; width:auto` に（grid と max-content をやめる） |
| 3 | `.rslot` `#top` `#left` `#right` の 2D 回転を外す（河と手牌が全部同じ向きに並ぶ） |
| 4 | `* { transition:none; animation:none }`（帯・立ち絵・カットイン・`.talking` の scale） |
| 5 | `vh` / `dvh` を px に決め打ち（`--tw:36px`、`.cutin` の `--cw:80px`） |

N=5 でも落ちるなら、四人卓固有の CSS は全部外れたことになり、
`flat=3` と重ねて**共通部分（§0 の最後の段落）**へ疑いを移す。

## 6. 実機の手順（段1・段2 が入ったあと）

`BACKLOG.md`「実機で確認するときの手順」のとおり（`git pull` → `http.server` →
`?v=` を毎回変える・マナーモードを切る）。**横持ち・自分で打つ・東風**で、順に：

1. `?bb=1&v=…` … 素の状態。落ちたら読み直された画面の直近5行を**スクショ**
2. `?bb=1&flat=3&nofit=1&auto=1&v=…` … 段0。三つ重ねる
3. `?bb=1&fourjs=0&v=…` … 段2

**一回落ちたら次へ**（同じ条件を何度も回す必要は無い。落ちなかった条件だけ、
東風を二回打ってから「落ちない」と数える）。三つのスクショと、それぞれ
「落ちた／落ちなかった」「落ちるまでの打牌数（`d`）」を持ち帰る。

**暗槓が出たら撮る**（[G] の3か所。`BACKLOG.md`）。

## 7. 触らないもの

- `src/` 全部。`match.css` `match.js` `ui.js` に診断の分岐を書かない
- `?flat=` `?nofit=` `?seed=` `?dealer=` の既存の旗。壊さず、重ねられること
- `Resume`（`resume.js` と `jandol` の復帰の鍵）。`jandol.bb` は別の鍵で、`Resume.clear()` でも消えない
- `tools/drive-*.js` `check-*.js` の件数。旗が無ければ包みも仕込まないので動かないはず。
  **動いたら包みが漏れている**
