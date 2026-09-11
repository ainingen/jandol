#!/usr/bin/env python3
"""
雀ドル発掘放浪記 — index.html を組み立てる

  python3 build.py

前提：リポジトリの直下で実行すること。
  shell.html      … 外枠。ここに <link> と <script> を差し込む
  src/*.css *.js  … 各画面
出力は index.html。GitHub Pages がそのまま拾う名前にしてある。

--------------------------------------------------------------------
なぜ分割するのか
--------------------------------------------------------------------
**PLiCyには index.html が500KBまでという制限がある。**
公式FAQには載っていないが、実際に何度も弾かれている（ゆう・実証済み）。

ただしこの制限は index.html だけに掛かる。ZIP全体は2GBまで許される。
そこで CSS と JS を `src/` に置いたまま `<link>` と `<script>` で読む形にした。
index.html は約30KBで、以後どれだけ足しても上限には掛からない。

**PLiCyで外部のCSS・JSが読めることは確認済み（2026年9月・ゆう）。**
表紙が正しく描画され、サムネイルも撮れている。
以前あった一枚版（--single）は役目を終えたので廃止した。

--------------------------------------------------------------------
注意
--------------------------------------------------------------------
・読み込み順は下の CSS / JS のリストの順。依存がある（例：ui.js は
  engine.js を前提にする）ので、並べ替えるときは依存を確認すること。
  scriptタグに defer は付けない。付けるなら全部に付ける。
  混ぜると順序が崩れる。

・**ZIPには src/ を必ず含めること。** 含め忘れると真っ白な画面になる。

・url(../fonts/) は書き換えない。CSSは src/ に置いたまま読むので、
  src/ から見た ../fonts/ が正しく解決される。

・module.exports は削らない。typeof で守られているのでブラウザでは
  無視される（node のテストから読むために置いてある）。

--------------------------------------------------------------------
版付け（?v=）
--------------------------------------------------------------------
<link> と <script> に ?v=<内容のハッシュ8桁> を付ける。付けないと、
更新のあとに **新しい index.html と古い src/*.js** が混ざりうる。
GitHub Pages の期限は10分ほどだが、**iOS Safari は再読み込みでも
古い JS を動かし続ける**（HANDOVER.md §5 で二度踏んだ）。

**版はファイルごとの内容ハッシュ。ビルド時刻でもコミットハッシュでもない。**
そうしないと、**中身が変わっていないファイルの版まで毎回動き**、
更新のたびに全部を落とし直させることになる。
同じ入力からは同じ index.html が出る（2回続けて回しても差分は出ない）。

**単体ページ（match.html / jansou.html など）には付かない。**
あれらは build.py を通らず、手元で開くものなので、それでよい。
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')

# 読み込み順。並べ替えるときは依存を確認すること
CSS = ['style.css', 'theme.css', 'maru.css', 'title.css', 'prologue.css', 'meikan.css',
       'team.css', 'taikai.css', 'scout.css', 'office.css',
       'jansou.css', 'jansou-floor.css', 'office-room.css', 'match.css']
# jansou.js は jansou-guests.js / jansou-floor.js を参照するので、必ず後ろに置く。
# geo.js は office.js と title.js（本拠地の選択）より前に置く。
# office.js は Jansou.normalize を「呼ぶとき」にだけ参照するので、
# jansou.js より前でも構わない（読み込み時には触らない）。
# office-room.js（事務所の部屋）は JansouFloor の描画の道具を読み込み時に借りるので、
# jansou-floor.js より後ろに置く（office/room.md §3.1）
# sound.js は ui.js が「あれば使う」（読み込み時には触らない）。audio/ は ZIP に含めること
# resume.js は match.js より前に置く。match.js が `typeof Resume` で見るのは
# 呼ぶときだけなので順序は効かないが、taikai.js も読むので依存を先に並べておく
# prologue.js は title.js より前。title.js は `typeof PROLOGUE` で
# 「呼ぶときにだけ」見るので順序は効かないが、依存を先に並べる慣わしに合わせる
# （docs/design/title/prologue-spec.md §5）
JS = ['engine.js', 'ai.js', 'game.js', 'sound.js', 'ui.js', 'resume.js', 'match.js',
      'characters.js', 'geo.js', 'tournament.js', 'offers.js', 'office.js',
      'prologue.js', 'title.js', 'meikan.js',
      'team.js', 'taikai.js', 'scout.js',
      'jansou-guests.js', 'jansou-floor.js', 'office-room.js', 'jansou.js', 'scoutshop.js', 'serifu.js']

# 開発用。**ここに足さないこと。**足すと本番の index.html に入り、
# 普通のプレイヤーにデバッグの入口が見えてしまう。
# 配布ZIPを作るときも、この2つは外すこと（README.md の配布の手順）。
DEV_ONLY = ['debug.html', 'src/debug.js']

LIMIT = 500 * 1024          # PLiCyの上限。分割版では掛からないはずの保険

# 絵と音は index.html に入らない（ZIP に同梱するだけ）ので、build.py は
# 組み立てない。**ただし thumb/ だけは数えて出す。**
# 大会のカード（`taikai.js` の `faceOf`）と、対局画面の席プレート・
# カットイン・順位表（`match.js` の `thumbOf`）が `thumb/` を読んでいて、
# **無いと顔が全部シルエットに落ちる**——しかも画面は普通に動くので、
# 目では気づけない（`debug.js` の混入を毎回確かめているのと同じ理由）。
# 焼くのは tools/make-thumbs.py。**ここでは焼かない**
# （ビルドに Pillow を要求しないため）
THUMB = 'thumb'


def read(name, base=SRC):
    with open(os.path.join(base, name), encoding='utf-8') as f:
        return f.read()


def ver(name):
    """src/<name> の内容ハッシュ（sha256 の先頭8桁）。

    **内容だけから作ること。**ビルド時刻やコミットハッシュを混ぜると、
    中身が変わっていないファイルの版まで毎回動き、更新のたびに
    全部を落とし直させることになる。
    """
    with open(os.path.join(SRC, name), 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()[:8]


def build_styles():
    return '\n'.join('<link rel="stylesheet" href="src/%s?v=%s">' % (n, ver(n))
                     for n in CSS)


def build_scripts():
    return '\n'.join('<script src="src/%s?v=%s"></script>' % (n, ver(n))
                     for n in JS)


def main():
    missing = [n for n in CSS + JS if not os.path.exists(os.path.join(SRC, n))]
    if not os.path.exists(os.path.join(HERE, 'shell.html')):
        missing.append('shell.html')
    if missing:
        print('見つからないファイル:', ', '.join(missing), file=sys.stderr)
        return 1

    shell = read('shell.html', HERE)
    for mark in ('<!--__STYLES__-->', '<!--__SCRIPTS__-->'):
        if mark not in shell:
            print('shell.html に %s がありません' % mark, file=sys.stderr)
            return 1

    out = (shell
           .replace('<!--__STYLES__-->', build_styles())
           .replace('<!--__SCRIPTS__-->', build_scripts()))

    path = os.path.join(HERE, 'index.html')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(out)

    size = len(out.encode('utf-8'))
    print('%s  %.0fKB' % (path, size / 1024))

    if size > LIMIT:
        print('index.html が %.0fKB あります。PLiCyの上限は500KBです。'
              % (size / 1024), file=sys.stderr)
        print('shell.html に直接書いたものが増えすぎていないか確認してください。',
              file=sys.stderr)
        return 1

    total = sum(os.path.getsize(os.path.join(SRC, n)) for n in CSS + JS)
    print('  src/ の %d 個（%.0fKB）を読みに行く。ZIPには src/ を必ず含めること'
          % (len(CSS + JS), total / 1024))

    # 開発用の入口が本番に混ざっていないことを、毎回ここで確かめる。
    # 混ざっても画面は普通に動いてしまうので、目では気づけない。
    # 照合はファイル名だけなので、?v= が付いていても引っかかる
    # （src/debug.js?v=... の中に debug.js がある）
    leaked = [n for n in DEV_ONLY if os.path.basename(n) in out]
    if leaked:
        print('本番の index.html に開発用が入っています: %s' % ', '.join(leaked),
              file=sys.stderr)
        print('build.py の JS / CSS のリストから外すこと。', file=sys.stderr)
        return 1
    present = [n for n in DEV_ONLY if os.path.exists(os.path.join(HERE, n))]
    if present:
        print('  開発用（index.html には入っていない。配布ZIPからは外すこと）: %s'
              % ', '.join(present))

    # カード用のサムネイル。**組み立てはしない。数えて言うだけ。**
    tdir = os.path.join(HERE, THUMB)
    imgs = os.path.join(HERE, 'img')
    if not os.path.isdir(tdir):
        print('  %s/ がありません。大会のカードと対局画面の顔が'
              '全部シルエットになります。' % THUMB, file=sys.stderr)
        print('  python3 tools/make-thumbs.py で焼くこと。', file=sys.stderr)
    else:
        n = len([f for f in os.listdir(tdir) if f.endswith('.webp')])
        size = sum(os.path.getsize(os.path.join(tdir, f))
                   for f in os.listdir(tdir) if f.endswith('.webp'))
        print('  %s/ の %d枚（%.1fMB）を大会のカードと対局画面が読みに行く。'
              'ZIPには %s/ も含めること' % (THUMB, n, size / 1048576.0, THUMB))
        if os.path.isdir(imgs):
            m = len([f for f in os.listdir(imgs) if f.endswith('.webp')])
            if n < m:
                print('  img/ は %d枚あるのに %s/ は %d枚です。'
                      'python3 tools/make-thumbs.py を回すこと。'
                      % (m, THUMB, n), file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
