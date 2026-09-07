# 大会の復帰（本編で落ちても、大会の続きから）

`docs/design/taikai/resume-spec.md`
2026年9月7日。前提は `docs/design/match/resume-spec.md`（対局を局の頭から再開する仕組み。`match.html` で動作確認済み）。

---

## §0 なぜ大会だけか

四人卓の再読み込みは本編でも起きる。`index.html` は表紙に戻り、対局は跡形もない。

本編で `Match.play` を呼ぶのは `shell.html` の `store.playRealMatch` 一つだが、そこへ入る道は5本ある。落ちたときに失うものは道ごとに違う。

| 経路 | 落ちると | 状態は壊れるか |
|---|---|---|
| 1 大会 | **賞金・成長・段位・戦績を失う。依頼も消える** | 壊れない |
| 2・3 雀荘（ボトル勝負／代表の夜の卓） | その日を打ち直し | 壊れない |
| 4 遠征の交渉 | **同じ遠征日が二度締まる** | **壊れる**（§1） |
| 5 遠征先の誘い | 声かけ回数が戻る | 壊れない |

**大会だけが「やり直せない」。**依頼が消えるので同じ大会に再挑戦できず、賞金・成長・戦績がまとめて消える。雀荘は打ち直せばよく、遠征の交渉は翌日もう一度できる。

**そこで復帰は大会に絞る。**残る経路は「やり直し」のままにして、`docs/BACKLOG.md` に「必要になったら足す」と書く。

---

## §1 先に直すもの：遠征の二重締め（復帰とは独立）

`office.js` の `runTripDay` は

```
runAwayDay / runClosedDay   ← settle。parlor.day が進み、金が動く
→ say(「打つ」)
→ playOrSimulate            ← 対局
→ store.set({ trip: { dayLeft: left, … } })   ← 日数の減算
```

の順なので、対局中に落ちると**締めだけが残り、`trip.dayLeft` は減らない。**次に開くと同じ遠征日がもう一度回り、日が余計に進んで日当が二重に引かれる。

**直しかた：`trip.dayLeft` の減算を、締めと同じ `store.set` に入れる。**対局の前に。その日の交渉は失われるが、日は正しく進む。`trip.dayLeft` を減らしたあとの分岐（滞在が終わるか）はいまの位置のままでよい——値を読む側なので。

**これは復帰の有無に関係なく本編に入っているバグ。**復帰より先に、単独で入れる（§7 段0）。

---

## §2 決めたこと

- **戻る先は「その回戦の、その対局の、局の頭」。**打ち終わった回戦は打ち直さない。他卓の結果も変えない
- **一言を出す。**場所は出走表の画面（「卓に着く」を押すまで進まない一枚がある）。「通信」は書かない
- **諦める道を必ず残す。**復帰に失敗する控えが残ると、表紙から先へ進めなくなる
- **控えを消すのは、結果を `store.set` まで書き終えた側。**`Match.play` は消さない（§3）
- **控えは二種類。**対局の控え（`Resume`。既存）と、大会の進行の控え（`st.pendingTaikai`。新規）。役目が違うので分ける

---

## §3 `Match.play` は控えを消さず、`done` を書く

いまは `Match.play` が `g.run()` の直後に `Resume.clear()` を呼ぶ（`match.js:472`）。本編ではその**あと**に `taikai.js` の `finish()` が賞金を書くので、**結果の表示中に落ちると、控えは消えているのに賞金も入らない。**

変更：

```
g.run() が返る
→ Resume.markDone(rank)       // 控えに done: [{seat, place}, …] を書く。消さない
→ showResult
→ return rank
```

**消すのは呼び出し元。**

- `match.html` … `await p` のあとに `Resume.clear()`
- 本編（大会）… `finish()` の `store.set` のあと（§5）

**`done` の付いた控えを見つけた側の振る舞い。**

- 本編（大会）… 打たずに `done` を結果として使う（§5）
- `match.html` … **黙って消す。**結果画面を再現する価値は無い。一言も出さない

`docs/design/match/resume-spec.md` §4 を書き換えること。「`g.run()` が返った直後に消す」→「`g.run()` が返った直後に `done` を書く。消すのは呼び出し元」。§9 の「結果の表示中に落ちた場合」も、これで塞がったと書く。

`tools/test-resume.js` / `tools/drive-resume.js` の「順位が出ている時点でもう消えている」は、「順位が出ている時点で `done` が書かれている」「`match.html` は `await` のあとに消す」に差し替える。

---

## §4 大会の進行の控え：`st.pendingTaikai`

`runTournament` はメモリだけで回る。控えるのはこれ。**キャラは id で持ち、カードは復帰時に作り直す**（`st` は大会中に一切書かれないので、同じものができる）。

```js
st.pendingTaikai = {
  v: 1,
  tierId: 'open',
  offerId: 'taikai-open-3',          // 依頼の id。onDone が事務所へ返すときに要る
  fieldIds: [0, 12, 37, …],          // 出走表の顔ぶれ。順序ごと
  rounds: [                          // runTournament の rounds[] と同じ形。キャラは id
    { name: '一回戦', size: 16,
      tables: [[0, 12, 37, 88], [5, 6, 7, 8], …],       // 卓割り。回戦の頭で確定
      results: [ [{id:0,place:1},{id:12,place:2},…], null, … ] },  // 卓ごと。まだなら null
    …
  ],
  ri: 1,                             // いま何回戦目か（0始まり）
};
```

**書くタイミング**（すべて `store.set({ pendingTaikai })`）：

1. 「卓に着く」を押したとき（`fieldIds`・`rounds: []`・`ri: 0`）
2. 回戦の頭で卓割りが決まったとき（`rounds[ri].tables`）
3. **卓ごとに結果が出たとき**（`rounds[ri].results[k]`）。自分の卓も他卓も
4. 決勝卓も同じ

**消すタイミング**：`finish()` の `store.set` のあと（§5）。`Resume` の控えも同時に消す。

**`st` に載せるので、`blankState()` / `loadState()` に入れること。**「最初からはじめる」で消える。`Resume` の控えは別の `localStorage` キーなので、**`onStart` / `appReset` から `Resume.clear()` も呼ぶ**。

---

## §5 `runTournament` を控えから続けられる形に

いまの `runTournament(prepared, opts)` の中身は変えない。**入口と、結果が出るたびの一手だけ足す。**

```js
runTournament(prepared, {
  playRealMatch,
  progress,        // st.pendingTaikai。無ければ最初から
  onProgress,      // (progress) => void。控えを書く口。無ければ何もしない
})
```

**復帰の手順（`progress` があるとき）**

1. `progress.rounds` のうち結果が揃っている回戦を読み、`eliminatedAt` `lastPlace` `met` `beaten` `alive` を組み直す（いまの while の中でやっていることと同じ計算）
2. `progress.rounds[ri]` に `tables` があれば `makeTables` を呼ばず、それを使う
3. その回戦の `results[k]` が入っている卓は飛ばす
4. 自分の卓（`results[k]` が `null` で `hasPlayer`）：
   - `Resume.load()` が `done` を持ち、席の id が卓と一致 → **打たずに `done` を結果にする**
   - `Resume.load()` が `done` 無しで、席の id が卓と一致 → `playRealMatch(t, ctx)` に控えを渡し、**局の頭から**
   - 一致しない／控えが無い → いままでどおり東1局から
5. 以降はいまの while と同じ

**席の一致は id の集合で見る。**`Match.play` は自分を先頭に回転させるので、順序は比べない。

**結果が出るたびに `onProgress` を呼ぶ**（§4 の 2〜4）。

**`ctx` に `resume` を足す。**`playRealMatch(t, { round, tier, name, isFinal, resume })`。`shell.html` の `playRealMatch` は `ctx.resume` があればその `kyoku` `honba` `riichiSticks` `scores` `startDealer` を `Match.play` の `opts` に渡す。

**`finish()`**：いまの `store.set` に `pendingTaikai: null` を足し、続けて `Resume.clear()`。

---

## §6 入口：表紙の「続きから」

`shell.html` の `onContinue` は事務所へ行く。**`st.pendingTaikai` があれば大会へ。**依頼を受けたときと同じ `goTaikai` の経路を通し、`onDone` が事務所の夜へ返す処理はそのまま使う（`offerId` はこのため）。

**出走表の画面に一言を足す**（`renderField`）。`opts.resume` があるときだけ。

```
この大会をやり直します
一時的に画面が止まったため、全国オープン 準決勝 を 東2局 1本場 の最初から再開します

［続ける］    ［この大会を諦める］
```

- 局名は `Resume.load()` から（無ければ「東1局」。`done` があれば「前回の対局は終わっています。結果から続けます」）
- **「続ける」を押すまで進まない。**押すと `playRounds` → `runTournament(prepared, { progress })`
- **「諦める」**は `pendingTaikai` と `Resume` を消して事務所へ。大会は失われる（いまと同じ）。依頼は戻さない
- 「卓に着く」の釦はこの画面では出さない（「続ける」が代わり）

**`prepared` の作り直し。**`prepare()` は乱数で `field` を組むので呼ばない。`fieldIds` から `teamCards()` と `poolCards()` を引いて（`Office.tableCardOf` も同じく掛けて）`{ tierId, tier, field, team }` を組む。**`st` は大会中に動かないので、同じカードになる。**

---

## §7 捨てる条件（黙って消す）

`pendingTaikai` を読んだとき、どれか一つでも当たれば消して事務所へ。一言は出さない。

- `v` が合わない
- `tierId` が `TOURNAMENTS` に無い
- `fieldIds` に `PLAYER` / `JANDOLS` / `FREE_AGENTS` で引けない id がある
- `fieldIds` に自分（0）と `st.team` の全員が入っていない
- `rounds` の形が壊れている（`tables` の id が `fieldIds` の外、`results` の長さが `tables` と違う、など）

`Resume` の控えは `match/resume-spec.md` §5 の条件で捨てる。**加えて、席の id が `pendingTaikai` の自分の卓と一致しなければ無視する**（消さなくてよい。大会が進めば `finish()` で消える）。

---

## §8 触らないもの

- `runTournament` の while の中身（卓割り・勝ち上がり・`recordBeaten`）。足すのは入口と `onProgress` だけ
- `prepare()` / `buildField` / `makeTables` / `simulateTable`
- `finish()` の計算（賞金・育成・段位・戦績）。足すのは `pendingTaikai: null` と `Resume.clear()` だけ
- 経路 2〜5 の対局。復帰しない（§0）
- `match.html` の `?flat=` `?nofit=`

---

## §9 段の分け方

### 段0：遠征の二重締め（§1。復帰と独立。先に `main` へ）

- `runTripDay` の `trip.dayLeft` 減算を締めの `store.set` に移す
- `tools/test-office.js` に：締めの直後に `trip.dayLeft` が減っていること。対局を挟まずに二度 `runTripDay` を回しても日が一つしか進まないこと
- `drive-office.js --real` で遠征の交渉が通ること

### 段1：`done`（§3）

- `Match.play` の `Resume.clear()` → `Resume.markDone(rank)`
- `Resume.markDone` / `load()` が `done` を返すこと
- `match.html`：`await p` のあとに `clear()`。開いたとき `done` 付きの控えは黙って消す
- `match/resume-spec.md` §4・§9 の書き換え
- `test-resume.js` / `drive-resume.js` の差し替え。**`match.html` を実機で一度落として、復帰がいままでどおり動くこと**

### 段2：`runTournament` の控え（§4・§5。純関数側）

- `progress` / `onProgress` / `ctx.resume`
- `tools/test-taikai-resume.js`（新規）：
  - `playRealMatch` が2回戦で `throw` する stub で回す → `onProgress` に積まれた控えを渡して再度回す → **1回戦の結果が打ち直されず、`rounds` が同じ、最終的な `outcomeOf` が全員ぶん出る**
  - 控えの `tables` が使われ、`makeTables` が呼ばれないこと
  - `done` 付きの控えで、自分の卓が打たれずに結果が入ること
  - 控え無しでいままでと同じ結果になること（既存の `test-match.js` が通る）
- **`taikai.js` の画面は触らない**

### 段3：本編の配線（§4・§6・§7）

- `st.pendingTaikai` の `blankState` / `loadState`。`onStart` / `appReset` の `Resume.clear()`
- `playRounds` で `onProgress` → `store.set`
- `finish()` で消す
- `shell.html` の `onContinue` の分岐と、`playRealMatch` の `ctx.resume`
- `renderField` の一言と二つの釦。`prepared` の作り直し
- `build.py` の `JS` に `src/resume.js`（`index.html` は +49 バイトの見込み）
- 確認（PC・Playwright）：`pendingTaikai` と `Resume` を手で置いて `index.html` を開く → 表紙 → 続きから → **出走表に一言、局名が正しい** → 続ける → 1回戦が打ち直されない → 自分の卓が東2局から → 全回戦終わって `finish()` → **`pendingTaikai` と `Resume` が消えている**。「諦める」で事務所へ行き両方消えていること。§7 の捨てる条件それぞれで黙って事務所へ行くこと

### 段4：実機

- iPhone・横持ちで大会に出て、落ちるのを待つ → 表紙 → 続きから → 一言 → 続ける → 回戦・局・持ち点が合うか → 最後まで打って賞金が入るか
- 落ちずに終わった大会のあと、開き直して一言が出ないこと

---

## §10 決めていないこと

- **経路 2〜5 の復帰。**必要が出たら。雀荘は `playDay` の途中、遠征は `runTripDay` の中で、いずれも「呼び出し元」を控える設計がそれぞれ要る
- **`autoMatch` のとき。**実対局が無いので落ちる場所も無いが、`pendingTaikai` は同じ手順で書いてよい。害は無い
