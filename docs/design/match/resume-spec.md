# 対局の復帰（局の頭から再開する）

`docs/design/match/resume-spec.md`
2026年9月7日。対象は **`match.html` だけ**（本編 `index.html` は別の段で扱う。§9）。

---

## §0 なぜ作るか

iPhone の実機で、四人卓（`body.inMatch.four`）のときだけ、対局中にページが再読み込みされる。
Safari も Chrome も落ちる。縦持ちの列レイアウトでは落ちない。落ちるまでの打牌数はばらつく。

**原因は未特定。**以下は潰した。

| 試したこと | 道具 | 結果 |
|---|---|---|
| 3D（`perspective` / `rotateX` / `preserve-3d` / 牌の厚み）を全部外す | `match.html?flat=3` | **落ちた** |
| `fitFour()` の 500ms 常時実行を止める | `match.html?nofit=1` | **落ちた** |
| CPU だけで打たせる（指を触れない） | `?auto=1` | **落ちた** |

削っても落ちるまでの時間が伸びない。「どこか一箇所の重い処理」を探す方針では当たらないと判断した。

**そこで、落ちる理由に依存しない対処にする。**落ちてもいいから、局の頭から続きを打てるようにする。
原因の追跡はやめない（`docs/BACKLOG.md`）。これは応急処置で、落ちること自体は残る。

---

## §1 決めたこと

- **戻る先は「局の頭」。**打牌の直前まで戻すのは復帰ではなく作り直しになる（山の順序まで保存が要り、`game.js` の構造に手が入る）。麻雀は局が単位なので、区切りとして自然。**その局の手は消える。配牌は引き直し。**
- **プレイヤーに一言出す。**黙って手牌が変わると「バグった」と受け取られる。断りがあれば「そういう仕様」として飲み込める。
- **「通信」という言葉は使わない。**原因は端末側で、回線ではない。通信のせいだと思った人は Wi-Fi を疑って無駄に時間を使う。
- **まず `match.html` だけ。**仕組みを作って動くことを確かめてから本編へ移す。

---

## §2 保存するもの

局の頭で書き出せる状態は、`Game` インスタンス直下にすべてある（`game.js:41-72`）。
**局中の状態（山・手牌・河・副露・ドラ）は保存しない。**`deal()` が作り直す。

```js
{
  v: 1,                       // 形式の版。読むときに合わなければ捨てる
  at: 1757200000000,          // Date.now()。古すぎるものは捨てる（§5）
  seats: [0, 114, 23, 194],   // キャラID。Match.play の seats と同じ順（自分が先頭に回転済み）
  kyoku: 2,                   // g.kyoku（1始まりの通し番号）
  honba: 1,                   // g.honba
  riichiSticks: 0,            // g.riichiSticks（本数）
  scores: [25000, 26000, 24000, 25000],  // g.players[i].score。seats と同じ添字
  startDealer: 3,             // g.startDealer
  opts: { length:'hanchan', speed:520, showHints:true, discardMode:'single', title:'単体の対局' }
}
```

**派生できるので保存しない。**

- `bakaze` … `kyoku > 4` なら 28、それ以外 27（`game.js:686` と同じ式）
- `dealer` … `(startDealer + kyoku - 1) % 4`。**連荘では `kyoku` も `dealer` も動かない**（`game.js:677-681`）ので、この式で必ず合う

**キャラIDは `Game` のどこにも無い。**`g.players[i]` は `face`（画像パス）と `styleName` を持つだけで、数値の `c.id` は入らない（`match.js:370` で `faceOf(c)` に変換される）。
持っているのは `Match.play` のローカル変数 `seats` だけ。**保存は `Game` の外、`match.js` でやる。**

---

## §3 いつ保存するか

`Game.playHand()` の `deal()` 直後（`game.js:213-215`）。
局中の状態が作り直され、最初のツモの前。**ここが局の頭の唯一の同期点。**

`Game` に `io` の新しい口を一つ足す。

```js
async playHand() {
  this.deal();
  this.io.handStart?.(this);      // ← 追加。無ければ何もしない
  this.io.update();
  …
```

**`?.` は必須。**`io` は `UI` だけではない。`tools/measure-fatigue.js` は `Game` を直接使うし、ヘッドレスの `io` は `handStart` を持たない。

**`Game` は `localStorage` を知らない。**`game.js` は Node.js でヘッドレス実行されるので、ブラウザAPIを直接参照しない（`CLAUDE.md`）。`Game` がやるのは `io.handStart(this)` を呼ぶことだけ。

保存は `Match.play` が `UI.handStart` を差し込んでやる（`UI.game = g` と同じ作法、`match.js:439`）。

```js
UI.handStart = (g) => Resume.save(g, seats, opts);   // g.run() の前
await g.run();
UI.handStart = null;                                  // 終わったら外す
```

`localStorage.setItem` は同期なので、`deal()` の直後に書けば、その後で落ちても残っている。

---

## §4 いつ消すか

**2026年9月7日に変えた**（`docs/design/taikai/resume-spec.md` §3）。以前は「`g.run()` が返った直後に `Match.play` が消す」だった。

**いまは `Match.play` は消さない。`done` を書くだけ。消すのは呼び出し元。**

```
g.run() が返る
→ Resume.markDone(done)     // 控えに done: [{seat, place}, …] を書く。消さない
→ showResult
→ return
```

`done` は「その対局はもう終わっている」の印。`seat` は控えた `seats` と同じ添字で、`place` は 1〜4。**順位を作る規則（素点順の並びの何番目か）は `Match.play` が持つ**——`Resume` に書き写すと二か所に散る。

**消すのは呼び出し元。**

| 呼び出し元 | いつ消すか |
|---|---|
| `match.html` | `await` が返ったあと（`start` と `resume` の両方） |
| 本編（大会） | `finish()` の `store.set` のあと（`taikai/resume-spec.md` §5） |

**なぜ移したか。**`Match.play` が消していたころは、本編で `Match.play` のあとに `taikai.js` の `finish()` が賞金を書くので、**結果の表示中に落ちると控えは消えているのに賞金も入らない。**`done` を残しておけば、開き直した側が「打ち終わっている」と分かり、打ち直さずに結果を使える。

**`done` の付いた控えを見つけた側の振る舞い。**

- `match.html` … **黙って消す。**結果画面を再現する価値は無い。一言も出さない
- 本編（大会）… 打たずに `done` を結果として使う（`taikai/resume-spec.md` §5）

`UI.giveUp`（おまかせ／早送り）は対局を最後まで進めるので、通常の終了と同じ経路で `done` が付く。特別扱いは要らない。

---

## §5 いつ読むか・いつ捨てるか

`match.html` を開いたとき。

**捨てる条件。**どれか一つでも当たれば黙って消す。

- `v` が合わない
- `at` から **24時間**を超えている
- `seats` が4つでない／`scores` が4つでない
- `kyoku` が 1 未満、または `length` から決まる `maxKyoku` を超えている
- `seats` のIDが `JANDOLS` / `PLAYER` に見つからない（キャラの削除・改番の後）
- `done` が付いていて、その形が壊れている（4人ぶんでない／席が 0〜3 でだぶる／順位が 1〜4 でだぶる）。**付いていないのは正常**——打ち切る前の控えなので

**捨てるときは何も表示しない。**古い保存を「再開しますか」と聞かれても意味が分からない。

---

## §6 復帰するときの流れ（`match.html`）

1. 開いたとき保存を読む。無ければ従来どおり
2. あれば、`.dbg` の位置に**一言と釦二つ**を出す

   > **この局をやり直します**
   > 一時的に画面が止まったため、東2局 1本場 の最初から再開します
   >
   > ［再開する］ ［破棄する］

   局名は保存の `kyoku` / `honba` から組む（表示は `((kyoku-1)%4)+1`、`kyoku>4` なら南）。
   **「通信」は書かない**（§1）。

3. ［再開する］ → 保存の `seats` からキャラを引き直し、`opts` に復帰用の値を足して `Match.play`
4. ［破棄する］ → 保存を消して従来の画面
5. **`?start=1` が付いていても、保存があれば自動で始めない。**落ちて読み直されたとき `start=1` が残っているので、放っておくと断りが見えないまま始まる

`?start=1` は撮影用の口なので、保存があるときに止まっても困らない。

---

## §7 `Game` と `Match.play` に足す口

### `Game` の `opts`（`game.js` コンストラクタ）

いまは `kyoku` / `honba` / `riichiSticks` がリテラル初期化で `opts` を見ていない（`game.js:56, 68-70`）。持ち点は `startScore` で4人一律（`game.js:50`）。

| 追加 | 型 | 既定 | 適用 |
|---|---|---|---|
| `opts.kyoku` | 整数 | 1 | `this.kyoku`。**`bakaze` と `dealer` をここから派生させる**（§2） |
| `opts.honba` | 整数 | 0 | `this.honba` |
| `opts.riichiSticks` | 整数 | 0 | `this.riichiSticks` |
| `opts.scores` | 長さ4の配列 | なし | `this.players[i].score`。**あれば `startScore` より優先** |

`startDealer` は既にある（`game.js:61`）。

**適用の順序。**既存のリテラル初期化のあとに上書きする形にする。`dealer` は `startDealer` を決めたあとに `(startDealer + kyoku - 1) % 4` で置く。既定値のときは今と同じ結果になること（`kyoku=1` なら `dealer = startDealer`）。

**範囲外は例外を投げる。**`kyoku` が `maxKyoku` を超えていたら、黙って丸めずに `throw`。読む側（§5）で先に弾くので、ここに来るのは実装ミス。

### `Match.play`（`match.js:361-364`）

いまは `Game` に `length` と `foes` の2つしか渡していない。**`startDealer` も渡していないので、`match.html` の `?dealer=` は効いていない。**

`opts` のうち `startDealer` `kyoku` `honba` `riichiSticks` `scores` を **そのまま `Game` に転送する。**これで `?dealer=` も直る。

---

## §8 段の分け方

### 段1：`Game` の口

- §7 の `opts` 4つを足す
- `playHand()` に `io.handStart?.(this)` を足す（§3）
- **ヘッドレスの試験** `tools/test-resume.js`
  - `opts` を渡して `new Game` → `kyoku` `honba` `riichiSticks` `scores` `dealer` `bakaze` が期待どおりか
  - `kyoku=5, length='hanchan'` で `bakaze === 28`、`dealer === (startDealer+4)%4`
  - `kyoku=1` の既定で今までと同じ結果か（`dealer === startDealer`）
  - 範囲外で `throw` するか
  - `io.handStart` が無い `io` でも `playHand` が動くか
- 既存の `tools/test-*.js` が全部通ること

### 段2：`Match.play` の保存と消去

- `opts` の転送（§7）
- `UI.handStart` の差し込みと外し（§3）
- `g.run()` の直後に消す（§4）
- `Resume` の実体（`save` / `load` / `clear` / 捨てる条件 §5）。置き場所は **`src/resume.js`**（新規）。`game.js` には置かない
- **`localStorage` は `try/catch` で包む。**Safari のプライベートモードは `setItem` で投げる。保存に失敗しても対局は続くこと
- PC の Puppeteer で：局が始まるたびに `localStorage` の中身が更新されるか。半荘を打ち切ったら消えているか

### 段3：`match.html` の復帰画面

- §6 の一言と釦二つ
- `?start=1` を止める条件（§6-5）
- `?dealer=` が効くようになったことを確認（副産物）
- PC で：保存を手で置いて `match.html` を開く → 一言が出る → 再開 → 表示の局名・持ち点・親が保存どおりか

### 段4：実機

- iPhone・横持ち・四人卓で打つ。落ちる → 読み直される → 一言が出る → 再開 → **局・本場・持ち点・親が合っているか**
- 縦持ち（落ちない）で最後まで打ち切る → 保存が消えていること
- `?nofit=1` `?flat=3` の診断用クエリは**まだ消さない**（原因追跡で使う）

---

## §9 決めていないこと（本編へ移すときに決める）

- **本編で落ちたとき、対局の外の進行（日付・所持金・契約）がどうなるか。**本編のセーブの仕組みを先に調べる。対局の復帰だけでは中途半端になる可能性がある
- **PLiCy の iframe で `localStorage` が使えるか。**使えない場合の道。`match.html` の段では確かめられない
- **一言の見せ方。**`match.html` では `.dbg` の位置に釦で出すが、本編では対局画面の作法（帯／カットイン）に合わせる必要がある。絵の判断
- ~~**結果の表示中に落ちた場合**（§4）~~ **→ 塞がった（2026年9月7日）。**`Match.play` が消すのをやめて `done` を書くようにし、消す役目を呼び出し元へ移した（§4）。結果の表示中に落ちても、控えは `done` 付きで残る——`match.html` は黙って消し、本編の大会は打ち直さずに結果として使う（`taikai/resume-spec.md` §3・§5）

---

## §10 触らないもの

- `deal()` の中身。局中の状態の作り方は変えない
- `nextKyoku()`。局の進め方は変えない
- `UI.update` / `UI.render`。フックは `handStart` として別に足す（`update` は局中に何十回も呼ばれるので、そこに保存を乗せない）
- `?flat=` `?nofit=` の診断用コード
