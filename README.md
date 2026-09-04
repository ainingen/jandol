# 雀ドル発掘放浪記

全国の雀荘で「雀ドル」を発掘してスカウトし、事務所を大きくしながら、
大会とリーグで賞金と名声を得ていくブラウザゲーム。
最終目標は最強の八人「雀エイト」を自事務所で独占すること。
麻雀そのものは本格派（イカサマなし・牌操作なし）。

収集・経営・育成・本格麻雀の四本柱。

**遊ぶ** → `index.html` を開く（GitHub Pages を有効にすればそのURLでも遊べる）

このリポジトリは**そのまま上げれば動く**。画像・フォント・牌の絵まで全部入っている。
ビルド済みの `index.html` も入れてあるので、上げてすぐ遊べる。

---

## GitHubに上げる

1. GitHubで空のリポジトリを作る（READMEなどのチェックは入れない）
2. このフォルダの**中身**を全部アップロードする（フォルダごとではなく中身）。
   `index.html` がリポジトリの直下に来ていれば正しい
3. Settings → Pages → Source を「Deploy from a branch」、
   Branch を `main` / `(root)` にして Save
4. 数分待つと `https://ユーザー名.github.io/リポジトリ名/` で開く

`.gitignore` は先頭がドットなので、Windowsだと隠しファイル扱いで
アップロードから漏れることがある。無くても動く。

コマンドを使う場合：

```
git init
git add .
git commit -m "雀ドル発掘放浪記"
git branch -M main
git remote add origin https://github.com/<ユーザー名>/<リポジトリ名>.git
git push -u origin main
```

## 動かす

`index.html` は単一ファイルで、CSSもJSもキャラクターデータも全部入っている。
ダブルクリックで開けばそのまま動く。`img/` が隣にあれば顔が表示され、
無ければシルエットのまま最後まで遊べる。

セーブは `localStorage` に入る。使えない環境では毎回最初からになり、
画面上部に「この環境では保存できません」と出る。

## PLiCyの500KB制限と、外部ファイル

**PLiCyには index.html が500KBまでという制限がある。**
公式FAQには載っていないが、実際に何度も弾かれている（実証済み）。

この制限は index.html だけに掛かる。ZIP全体は2GBまで許される。
そこで2026年9月に、CSSとJSを `src/` に置いたまま
`<link>` と `<script>` で読む形にした。

```
python3 build.py            index.html は約13KB
```

**PLiCyで外部のCSS・JSが読めることは確認済み（2026年9月・ゆう）。**
表紙が正しく描画され、サムネイルも撮れている。
これを確かめたので、以前あった一枚版（`--single`）は廃止した。
`index.html` は shell.html にタグを差し込むだけになり、
以後どれだけ足しても上限には掛からない。

**ZIPには `src/` を必ず含めること。** `src/*.js` と `src/*.css` を
読みに行く。含め忘れると真っ白な画面になる。

**逆に、開発用の2つは外すこと。**`debug.html` と `src/debug.js` は
`build.py` が読んでいないので `index.html` には入らないが、
ZIPに混ぜるとURLを知っている人には届いてしまう。

```
zip -r jandol.zip . -x '.git/*' 'debug.html' 'src/debug.js' 'tools/*' 'docs/*'
# audio/（効果音）と tiles/（牌の絵）と img/ と fonts/ は入れること
```

## 直したあと

`src/` を編集したら、リポジトリ直下で

```
python3 build.py
```

`index.html` が作り直される。**`index.html` を直接編集しないこと**（次のビルドで消える）。

画面ごとに単体で確認したいときは、直下の `office.html` `meikan.html` `team.html`
`taikai.html` `scout.html` を開く。ビルド不要で `src/` を直に読む。
動作確認用のボタン（所持金を足す、全員発見にする、など）が下に付いている。

## 中身

```
index.html          ビルド結果。これを配布する（500KB以下に保つこと）
shell.html          外枠。表紙・タブ・セーブ。ビルド時にCSS/JSが差し込まれる
build.py            index.html を組み立てる（約13KB。CSS/JSは src/ のまま読む）
tools/make-font.py  表紙の丸ゴシックを作り直す
tools/make-sfx.py   控えの discard.wav だけを合成して書く（鳴る12本は書かない）
tools/prep-sfx.py   生成した音源（audio_raw/）を切り出して整形し audio/ に書く（鳴る12本）
tools/check-sound.js 打牌の鳴らし分けをブラウザで確かめる（音源を差し替えたら回す）
tools/drive-match.js 対局画面をブラウザで回す。配牌・鳴き・河3段・終局を撮り、--video で録画

office.html         ┐
meikan.html         │
team.html           │ 画面ごとの単体ページ（開発用）
taikai.html         │
scout.html          │
jansou.html         │
match.html          ┘ 対局画面だけを開く（?seed ?dealer ?auto ?speed ?discard で固定できる）

src/
  engine.js         麻雀エンジン（シャンテン・和了判定・役・符・点数）テスト35件合格
  ai.js             CPU思考（牌効率・危険度読み・押し引き・打ち筋の係数）
  game.js           対局進行（鳴き・リーチ・流局・連荘）
  ui.js             対局画面。牌はすべてSVG（『忍雀』のイカサマ部分は外した）
  match.js/.css     実対局の入口。卓のDOMを組んでGameを走らせ、着順を返す。
                    四人卓（横持ち・回転表示）と列レイアウト（縦持ち）の両方の CSS
  sound.js          効果音（WebAudio）。論理名9つを読む（打牌だけ四本から選ぶ）。鳴らすのは ui.js からだけ
  style.css         対局画面のスタイルと配色トークン

  characters.js     雀ドル73人＋打ち筋20種＋地域＋契約条件
  serifu.js         セリフ323本（性格19種 × 8場面）
  tournament.js     育成（完成度と伸びしろ）と大会（組み合わせ・自動処理）

  geo.js            47都道府県（座標・規模・所属地方）、距離と遠さの段階
  office.js/.css    事務所ハブ。朝と夜、本拠地の選択、所属一覧、配置、遠征、依頼
  offers.js         届く依頼15件（大会5・契約イベント6・アイドル案件4）と発火判定
  scoutshop.js      遠征先の雀荘（型4種・パレット・誰がいるか）

  theme.css         全画面に効く「華」の層（金箔・漆・朱）
  maru.css          丸ゴシックの読み込み定義（tools/make-font.py が生成）
  title.js/.css     表紙とプレイヤー設定（名前と顔）
  meikan.js/.css    名鑑
  team.js/.css      チーム編成
  taikai.js/.css    大会
  scout.js/.css     スカウト
  jansou.js/.css    直営雀荘（シフト・設備・イベント・営業の収支・模様替え）
  jansou-floor.js   フロアのマス目と設置物、タイムライン生成、一日の再生
  jansou-floor.css  フロアと客カード・ボトル・模様替えのスタイル
  jansou-guests.js  客タイプ24種、名前と常連、ボトル勝負の判定

fonts/              maru-ui.woff2（本文・568KB）／ maru-title.woff2（題字・4KB）
tiles/              牌の絵39枚（SVG・770KB）。出典は tiles/LICENSE.txt
img/                001.webp 〜 073.webp（雀ドル73人）
                    p01.webp 〜 p12.webp（プレイヤーの顔・十二人から選ぶ）
docs/HANDOVER.md    設計の経緯、決めごと、ハマった罠
docs/ROADMAP.md     これからの構想と順番を一枚に（なぜこの順か・再測をいつやるか）
docs/design/jansou/ 直営雀荘の設計一式（spec.md ＝リニューアル、
                    placement.md ＝卓の自由配置と隣接コンボ、
                    monthly.md ＝月末決算と月報）
docs/design/office/ 事務所ハブと日進行の統一（spec.md ＝全5段階）
tools/test-office.js 事務所の純関数テスト（node tools/test-office.js）
tools/test-scout.js  遠征先の店の純関数テスト（node tools/test-scout.js）
tools/measure-jansou.js 直営店の経済を測る（HANDOVER §4 の表を作り直す）
tools/measure-office.js 遠征と日進行の釣り合いを測る（spec.md §11 の A3）
tools/test-jansou.js 雀荘の純関数テスト（node tools/test-jansou.js）
tools/drive-jansou.js 雀荘をブラウザで自動で回す（node tools/drive-jansou.js --help）
debug.html          開発用の入口。遊べる状態を作って本編へ入る（配布から外す）
src/debug.js        その中身。build.py は読まない（配布から外す）
```

## できていること

- 表紙 … 顔を敷き詰めた表紙、続きから／最初から、事務所の様子
- プレイヤー設定 … 名前と顔を選ぶ。プレイヤーも女性の雀士
- 麻雀エンジンとCPU思考（別作品として完成済み。テスト済み）
- 名鑑 … 未発見はシルエット、発見済みは顔とランクと打ち筋、契約済みは金枠と契約印
- チーム編成 … 初期メンバー10人から3人選ぶ。組み合わせで講評が変わる
- 大会 … 5種の大会、出走表、卓割り、勝ち上がり、賞金、育成、昇段
- スカウト … 契約条件10種の判定、事務所の拡張。
  **発掘は事務所からの遠征になった**（下記）
- **おまかせ** … 対局中いつでも降りられる。押すと以降は自分の手もCPUが打つ。
  「早送り」と「見ながら自動」の二択。着順はごまかさずそのまま結果になる
- **顔とセリフ** … 四人ぶんの顔を並べ、喋った人だけ大きくする。吹き出しは
  四回捨てられるまで残る。縦持ちは卓の下の余りに横並び、横持ちの広い画面
  （900px以上）では右の余白に縦積み
- **実対局** … 大会で自分が座る卓は実際に打つ。他の卓は結果だけ。
  対局の設定（自分で打つ／自動、速さ、補助表示）は大会画面の下にある
- **直営雀荘** … 開店資金50万で開く。所属全員にシフト（昼・夕・夜）を組み、
  一日単位で営業する。出勤者の人気(pop)が客を呼び、月給の日割り（日当）を払う。
  設備投資4種（卓・内装・卓の型・宣伝）、イベント6種、夜は自分も卓に着ける。
  一日の営業はフロアで流れる（スキップ・倍速。**スキップしても結果は同一**）
- **月末決算** … 30日で締めて月報が出る。時間帯別の場代、収支、客数と常連の育ち、
  いちばん客を呼んだ子、できごと、評判の推移。あとから読み返せる。
  **見せるだけで、経済には触れていない**
- **模様替え** … 卓と設備を 8px のマス目に自分で置ける。卓は席4つぶんの
  広さを使う。隣り合わせで**コンボ**（くつろぎ席・カウンター席・入口席・
  静かな席・花道・ラウンジ）が付き、誰が座るか・どれだけ居るか・
  誰から立つか・チップ・ボトルの格が変わる。**客数と売上は変わらない**
- **事務所ハブ** … 表紙から入ると事務所に着き、一日が朝→昼→夜→朝と回る。
  新規開始で事務所名と本拠地の県（47から一つ）を決める。
  **営業開始の入口は事務所だけ**で、雀荘は設備とシフトを整える場所になった。
  所属一覧に人気(`pop`)と好感度(`favor`)が出る。
  **店が無い日も日は進み、所属の日当は出ていく**ので、
  「まず店を持つ」が序盤の最初の目標になる。
  所属の一人ずつに**配置**（店・休み・遠征）を持たせ、
  **雀荘のシフト（昼・夕・夜）もここで組む**（保存先は雀荘のまま）。
  設計は `docs/design/office/spec.md`（全5段階のうち第三段まで）
- **届く依頼** … 大会の招待・契約イベント・アイドル案件が、すべて
  「事務所に届いて、受けるか見送るかを決める」一つの形に載っている。
  **発火するのは条件だけで、日付を見ない**ので、あとから足しても
  新規にも古参にも同じように届く。大会も依頼から入り、日を消費する
- **遠征先の雀荘** … 滞在中の朝、その日の店が**静止した一枚**で出る。
  型が四つ（古い雀荘／場末の店／街のガールズ雀荘／高級店）あり、
  県の規模で出やすさが変わる。客の中に雀ドルが混じっていて、
  **タップして声をかけると発見**。声をかけられるのは一日3回まで、観察はただ。
  **誰もいない日もある**
- **遠征** … 行き先の県・目的（探す／口説く）・同行者0〜3人を決めて出る。
  日数と費用は本拠地からの遠さで決まり、**遠いほど長く居られるぶん多く探せる**。
  口説くなら現地で一局打ち、**勝てば契約の話**に進む（負けても好感度は積まれる）。
  代表が出ているあいだ店は留守番が守り、帰った日の夜にまとめて結果が出る

この四つが繋がって、**発掘 → スカウト → 所属 → 大会 → 賞金 → 事務所強化** の
一周が閉じている。
**入口はすべて事務所**で、一日は事務所で始まり事務所で終わる。

## まだできていないこと

- **疲労・調子・雀エイト表**。第五段（`docs/design/office/spec.md` §14 の 5）。
- トップページ、発掘の演出、全国マップ、団体戦。

## 決めごと

数値を触るときの置き場所。

| 何を | どこ |
| --- | --- |
| 大会の定員・賞金・出場資格 | `src/tournament.js` の `TOURNAMENTS` |
| 賞金の配分（優勝100%〜一回戦0.8%） | `src/taikai.js` の `PAYOUT` |
| 段位に必要な優勝回数 | `src/taikai.js` の `WINS_TO_PROMOTE` |
| 事務所のランク・定員・拡張費 | `src/scout.js` の `AGENCY` |
| 契約条件の判定 | `src/scout.js` の `RULES` |
| 打ち筋20種の係数 | `src/characters.js` の `STYLES` |
| 係数がCPUに効く強さ | `src/ai.js` の `chooseDiscard` `shouldRiichi` `shouldCall` |
| 未熟さ（最善でない牌を選ぶ率） | `src/ai.js` の `slip` |
| 配色・明るさ・字体 | `src/theme.css` |
| カットインの大きさ・置き場所 | `src/match.css` の `.cutin`（四人卓は上の角、列レイアウトは卓と手牌のあいだ） |
| 吹き出しが残る長さ | `src/ui.js` の `BUBBLE_TURNS`（捨て牌の数） |
| 吹き出しの地を差し色にする場面 | `src/ui.js` の `HOT_KINDS`（リーチ・ツモ・ロン） |
| 卓の傾き・牌の厚み・河と手牌の押し出し | `src/match.css` の `rotateX(36deg)` `--th` `.rslot` `.413`/`.186` |
| 牌の移動の速さ | `src/match.css` の `.tile.moving`（.24s） |
| 効果音の音量の既定・素材 | `src/sound.js` の `DEFAULT_VOLUME`、`audio/*.wav`（`tools/prep-sfx.py`） |
| どの名前が何本の音源を持つか | `src/sound.js` の `FILES`（打牌だけ四本） |
| 音を耳で確かめる場所 | `debug.html` の「音」の区画（`src/debug.js` の `soundPanel`） |
| 生成音の切り出しと音量合わせ | `tools/prep-sfx.py` の `SOURCES` `GROUPS`、`HEAD_MS` `LOUD_MS` `PEAK_CEIL_DB` |
| 場面ごとの音の大きさ | `tools/prep-sfx.py` の `SOURCES` の `target_db`（和了 −25 … ツモ・ボタン −36） |
| 打牌の操作の既定（一度押し） | `src/ui.js` の `discardMode`、スワイプの長さは `SWIPE_PX` |
| セリフ | `src/serifu.js` の `LINES`（性格名が鍵） |
| 雑談が出る確率 | `src/ui.js` の `maybeIdle` の `0.18` |
| おまかせの動き | `src/ui.js` の `giveUp` と `src/match.js` の `#giveup` |
| 題字・副題と表紙の絵 | `src/title.js` の `TITLE` `SUBTITLE` `drawCover` |
| 表紙の制作タグ（ハンコ調） | `src/title.js` の `CREDIT_LABEL` `CREDIT_NAME` `drawCredit` |
| プレイヤーの顔の候補 | `src/title.js` の `FACES` |
| 成長曲線 | `src/tournament.js` の `GROWTH_CURVE` |
| 雀荘の開店資金・場代・回転 | `src/jansou.js` の `OPEN_COST` `SLOTS` |
| 雀荘の設備（卓・内装・卓の型・宣伝） | `src/jansou.js` の `TABLE_COST` `INTERIOR` `AUTO` `SIGN` |
| 雀荘の日当・家賃 | `src/jansou.js` の `BASE_WAGE` `wageOf` `utilOf`（日当は**契約基準**。所属の全員に毎日払う） |
| 雀荘のイベントの重みと発生率 | `src/jansou.js` の `pickEvent` と `SIGN` の `ev` |
| ひと月の日数（`wageOf` の割る数と対） | `src/jansou.js` の `MONTH_DAYS` |
| 月報を残す期の数 | `src/jansou.js` の `MONTHS_KEPT` |
| 雀荘の観葉植物の値段 | `src/jansou.js` の `PLANT_COST` |
| 雀荘のマス目と設置物の大きさ | `src/jansou-floor.js` の `GRID` `COLS` `ROWS` `KINDS` `DOOR` |
| 雀荘の自動配置（既存セーブの再現） | `src/jansou-floor.js` の `ROWS_FOR` `SOFA_SPOTS` `COUNTER_SPOTS` |
| 雀荘の隣接コンボと効き目 | `src/jansou-floor.js` の `COMBOS` `TIP_PER_GUEST` `DWELL_RELAX` `DWELL_DOOR` `tableTraits` |
| 47都道府県の座標・規模・所属地方・紹介文 | `src/geo.js` の `PREFS` |
| 遠さの段階（遠征の日数と費用のもと） | `src/geo.js` の `FAR_KM` |
| 事務所名の文字数 | `src/office.js` の `NAME_MAX` |
| 配置の種類（店・遠征・休み） | `src/office.js` の `ASSIGN_KINDS` |
| 遠征の日数と費用 | `src/office.js` の `planTrip`（一回の費用の正は `Scout.SCOUT_COST`） |
| 遠征先の店の型・色・卓数 | `src/scoutshop.js` の `SHOP_TYPES` `PALETTES` |
| 雀ドルがその日いる確率 | `src/scoutshop.js` の `ANY_CHANCE` `TWO_CHANCE` |
| 一日に声をかけられる回数 | `src/scoutshop.js` の `CALLS_PER_DAY` |
| 依頼の中身と発火条件 | `src/offers.js` の `TABLE`（大会・契約イベント・アイドル案件） |
| 事務所に溜まる依頼の上限 | `src/offers.js` の `MAX_OPEN` |
| 遠さの段階ごとの距離 | `src/geo.js` の `FAR_KM` |

## 実対局

大会で自分の卓に当たると `Match.play()` が呼ばれ、卓のDOMを組んで `Game` を走らせる。
終わると卓を片付けて着順を `taikai.js` に返す。

- **人間は必ず seat 0**。`game.js` と `ui.js` がそれを前提にしているので、
  `Match.play` が席順を回してプレイヤーを先頭に持ってくる。
  **起家は毎回ランダム**（`Game` が振る。`opts.startDealer` で固定できる）。
  以前は `dealer = 0` 固定で、プレイヤーが必ず東家から始まっていた
  （`docs/design/match/spec.md` §1）
- **卓は `#view` の外（`#matchRoot`）に置く。**`ui.js` は `document` 直下のidを見るため
- 「自動で処理」にすると `playRealMatch` が何も返さず、`taikai.js` が数値処理に落とす

### 効果音

`audio/` の音を `src/sound.js` が WebAudio で読んで鳴らす（`docs/design/match/spec.md` §2）。
**論理名は9つ**（打牌・ツモ・鳴き・リーチ・和了・放銃・ドラ・流局・ボタン）で、
**一つの名前が複数の音源を持てる。**いま複数なのは打牌だけ
（`discard1.wav`〜`discard4.wav`。一番よく鳴るので、一本だと一局十七回で機械音に聞こえる）。

- **鳴らすのは `ui.js` からだけ。**`game.js` は Node の測定からも読まれるので触らない
- **`AudioContext` は一つ。**初期化はユーザー操作の中（大会の「卓に着く」）。
  雀荘の夜・遠征の一局から入ったときは、最初のタップで `resume` する保険が効く
- 早送り（速さ 0）は無音、「速い」（200未満）は打牌とツモだけ間引く
- 音量は大会の設定（`st.sfxVolume`、0 / 0.5 / 1。無ければ 1）
- **`Sound.play('discard')` のまま。**どの一本を鳴らすかは `sound.js` が決める
  （`FILES`）。**直前と同じものは続けて選ばない。**`ui.js` は名前しか渡さない
- **`NAMES` は論理名9つのまま公開する。**ファイル名の一覧は `FILES` に別に持つ
  ——`tools/drive-match.js` は `NAMES` の側を数えている
- **四本そろっていなくてよい。**読めたものだけで鳴り、一本も無ければ `discard.wav`
  に落ちる（差し替えの途中で無音にならないため）
- **鳴る12本は全部 ElevenLabs の生成音**（2026年9月4日に差し替え終わり）。生成したままの WAV は
  `audio_raw/`（**コミットしない**）に置き、切り出しと整形は `tools/prep-sfx.py` が回す
  ——単発に切り、モノラル、頭1ms・末尾20msフェード、**A特性RMS**で聞こえを揃えて
  ピーク −3dBFS 以下。48kHz のまま。頭を切る位置は、打牌は**主ピークの8ms手前**を
  道具が自分で探し、残りの8つは**測って決めた範囲**（`SOURCES` の `cut`）
- **大きさは一本ずつ違えてある**（`target_db`）。局が終わる音は前へ、
  よく鳴る音は後ろへ。打牌の −30.1dB が基準
- **流局だけ均してある**（`compress`）。連続音なので、大きい当たりだけが飛び出すと
  「途切れた洗牌」に聞こえる。**単発の7本には掛けない**——立ち上がりが命
- **`tools/make-sfx.py` が書くのは控えの `discard.wav` 一本だけ。**
  `prep-sfx.py` が持っている名前を書こうとしたらその場で止まる
  ——回すと生成音を潰してしまうため
- 差し替えるときは同じ名前で上書きし、**`audio/LICENSE.txt` の出典欄を書き換えること。**
  差し替えたら `node tools/check-sound.js`
- **ZIP に `audio/` を含めること。**無くても対局は止まらないが、無音になる

### 牌の絵

`tiles/` の SVG を `<img>` で読む。
[FluffyStuff / riichi-mahjong-tiles](https://github.com/FluffyStuff/riichi-mahjong-tiles)、
**パブリックドメイン（CC0）**。無改変で置いてある。

- **図柄だけで、牌の面（象牙色の下地）は入っていない。**面はCSSで描き、その上に図柄を乗せる
- ファイル名は `Man1`〜`Sou9` `Ton` `Nan` `Shaa` `Pei` `Haku` `Hatsu` `Chun`、
  赤5は `Man5-Dora` `Pin5-Dora` `Sou5-Dora`。対応表は `ui.js` の `TILE_FILE` / `RED_FILE`
- **軽くしようとメタ情報を正規表現で削るとSVGが壊れる。**図形まで巻き込む。
  770KBのまま置くのが安全（`index.html` には影響しない）

### 画面の向き — 四人卓と列レイアウト

設計は `docs/design/match/spec.md`（全8段・2026年9月4日に完了）。
色と数値の正は `docs/design/match/table-mock.html`。

**Webでは向きを固定できない。** `screen.orientation.lock()` はフルスクリーン中の
Android Chromeでしか効かず、iOS Safariは非対応。PLiCyはiframeで動くので
フルスクリーン権限も取れない。そこで二つのレイアウトを持つ。

- **四人卓**（`body.four`）… 横持ち、または「横画面にする」の回転表示。
  卓面（`#felt`）を `rotateX(36deg)` で寝かせ、四方に人を置く。
  河は中心のゼロサイズの点（`.rslot`）を回して外へ押し出し、内側の端を固定する。
  手牌は中心基準。**端（left/right）で決めないこと**（`spec.md` §4.3）。
  辺長 `--side` は `match.js` の `fitFour()` が「回した後の高さ」を測って決める
- **列レイアウト**（`body.inMatch:not(.four)`）… 縦持ちで回さない人の道。
  各家を「プレート＋手牌」「河」の二行ずつ、上から積む（下家 → 対面 → 上家 → 自分）。
  同じ DOM を `display:contents` と grid で並べ直しているだけ。**消さないこと**
- **回転表示**は `.matchHost` ごと `rotate(90deg)`。トグルで、強制しない。
  OS の画面回転ロックを入れている人にも横画面が届く

`ui.js` の書き出し先は `#top` `#left` `#right` `#river-*` に加えて、
席プレート `#plate-*` とコンパス `#info`。**`#felt` の下の `#center` は block**
（`style.css` の grid のままだと、中の絶対配置が「そのマス」基準になってずれる）。

### 牌の移動と音

手牌と四つの河は **keyed**（`Map<id, node>`）。並びが変わったときだけ、
自分の打牌は FLIP、他家の打牌は手牌からの飛ばし込みで動く（`translate` / `scale` の
個別プロパティ。`transform` は横向きと つまみ上げ が使う）。
**`render()` は className を丸ごと書かず `.moving` を残すこと**、
**`transitionend` は `translate` / `scale` だけを見ること**——どちらも実際に踏んだ。

音は `src/sound.js`（上の「効果音」）。打牌の音は差分検出が「河に牌が増えた」瞬間に鳴らす。

### 確かめかた

`node tools/drive-match.js` が `match.html` を Playwright で回す。
`--shots DIR` で配牌・鳴き・河3段・終局、`--video DIR` で録画、
`--width 392 --height 780` で縦、`--rotate` で回転表示、`--play` で人間の席を
スクリプトが押す。撮ったものは `docs/design/match/shots/` と `rec/` にある。

- `ui.js` から『忍雀』のイカサマとストーリー進行は外したが、`g.cheat` で守られた分岐は
  残してある（`g.cheat` を立てなければ一切動かない）

出走表を見せてから打ち始めるため、`taikai.js` は組み合わせ作り（`prepare`）と
勝ち上がり（`runTournament`）を分けてある。**一緒にすると実対局が出走表より先に始まる。**

## 打ち筋がCPUに効く仕組み

対局前に `g.players[i].ai = paramsOf(chara, STYLES)` を入れると、その人の判断が変わる。
入れなければ全員が同じ打ち方（従来どおり）になる。

効くのは押し引き・危険度の重み・牌効率と打点の優先・リーチ判断・鳴き判断、
それに最終局の条件戦。ムラ（`variance`）は局が変わったときに一度だけ係数を振り直す。

**`skill`（完成度そのもの）が強さを決めている。**
係数の傾きだけでは打牌の順位がほとんど変わらず、完成度を上げても強くならなかった。
そこで `paramsOf` が `skill` を渡し、`ai.js` は未熟なほど最善でない牌を選ぶ。

実測（東風戦・balance型・60半荘）：

| 対戦 | 完成度100のトップ率 | 平均点 |
| --- | --- | --- |
| 対 完成度15×3 | 45% | 31,030 |
| 対 完成度50×3 | 27% | 25,807 |

`simulateTable` の調整目標（S級45%・D級17%）と一致している。
片方だけ触ると自分の卓と他の卓で勝率がずれるので、変えるときは両方見ること。

**罠：** ムラで係数を振り直すとき `skill` を引き継ぎ忘れると、
未熟なキャラも最善手を打つようになり、育成が完全に無効になる。
症状が「完成度を上げても勝率が変わらない」なので気づきにくい。

そのほかの設計判断とハマった罠は `docs/HANDOVER.md` にまとめてある。
特に **伸びしろの天井（`compMax`）は必ず保存すること**。
毎回 `現在の完成度 + pot` で計算し直すと天井が上がり続ける。

## セーブ

すべてidで持つ。キャラクターを増やしても壊れないように、
`src/characters.js` の末尾に足すだけにして、**既存のidは変えない**。

キー `jandol_save_v1`。項目は
`discovered` `contracted` `comp` `compMax` `grades` `team` `money`
`playerRank` `playerWins` `records` `recent` `agency` `beaten`
`playerName` `playerFace`。

各画面はセーブを読むとき、**自分が知らない項目もそのまま残すこと**。
拾い直した項目だけを返すと、他の画面が保存した内容を消してしまう。

## 表紙とサムネイル（PLiCyの制約）

**PLiCyのサムネイルはcanvasの中身しか撮らない。**
公式FAQに「スクリーンショットにはCanvas以外の内容は撮影されません」
「index.htmlに記載されている一番最初のcanvasをサムネイルとして利用します」とある。

そのため表紙の絵（顔の壁・題字・副題）はDOMではなく `#cover` のcanvasに描いている。
守ること：

- **タグとしてのcanvasはこの一枚だけにする。**複数あると撮影が乱れる
  （JSの中だけで使う、DOMに出さないcanvasは問題ない）
- **canvasをDOMから外さない。**画面を移っても残すことで、いつ撮影しても表紙が写る
- ローカルでファイルを直接開く（`file://`）と、画像を描いた時点でcanvasが汚染されて
  撮影できない。httpで開けば問題ない（GitHub PagesでもPLiCyでも本番は問題ない）

題字と副題に数を書かないこと。キャラを増やすと嘘になる。

右下の制作タグ（`produced by 夜中のBBQ`）も同じ理由でcanvasに描いてある
（`drawCredit`）。DOMに置くとサムネイルに写らない。枠の大きさは文字から
決めているので、文言を変えても枠は合う。**タグは 700 で描くこと。**
800（`maru-title.woff2`）は題字と副題の20文字しか入っていないので、
そちらで描くと文字が丸ごと代替書体に落ちる。

## 字体

本文も見出しも丸ゴシック（M PLUS Rounded 1c）。日本語の丸ゴシックはApple系にしか
標準で入っていないため、切り出したフォントを `fonts/` に置いてある。

- **maru-ui.woff2（700・本文）**… 画面に出る文字をソースから機械的に拾い、
  さらに常用漢字を丸ごと入れる。常用漢字まで入れているのは、
  プレイヤーが入力する名前のため。568KB
- **maru-title.woff2（800・題字）**… 表紙の題字と副題だけ。20文字で4KB

**CSSに埋め込まないこと。**埋め込むと `index.html` だけで1MB近くになり、
PLiCyの上限（500KB）を超える。`build.py` は超えたらエラーで止まる。

パスの都合が少しややこしい。`src/maru.css` は `../fonts/` と書いてあり、
単体ページから `src/maru.css` を読んだときにこれで届く。
`build.py` は `index.html` に取り込むとき `fonts/` に書き換える。

**文言を足したら `python3 tools/make-font.py` を実行し直すこと。**
入っていない字はその一文字だけ別の書体で出る。

## 公開

最終的には [PLiCy](https://plicy.net/) に出す。zipを投稿すると変換され、
ブラウザ上でサムネイルを撮って公開できる。

- **セーブはlocalStorageのままでよい。**PLiCyにはlocalStorageをクラウド保存する機能があり、
  公式にセーブデータのlocalStorage保存が推奨されている（IndexedDB/WebSQLはコピーされない）
- **`index.html` は500KB以下**。`build.py` が毎回確認して、超えたら止まる
- **`debug.html` と `src/debug.js` はZIPに入れない**（開発用の入口。上の zip の例を使う）
- 説明文に「下ネタ」「エッチ」などの語が入ると**無条件でR15**になる。雀ドルの紹介文に注意
- ファイル名は英数字のみにする（OSをまたぐと日本語名が文字化けする）
- zipを圧縮した端末からアップロードすること
- アップロードは1日10回まで
