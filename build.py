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
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')

# 読み込み順。並べ替えるときは依存を確認すること
CSS = ['style.css', 'theme.css', 'maru.css', 'title.css', 'meikan.css',
       'team.css', 'taikai.css', 'scout.css', 'jansou.css', 'jansou-floor.css',
       'match.css']
# jansou.js は jansou-guests.js / jansou-floor.js を参照するので、必ず後ろに置く
JS = ['engine.js', 'ai.js', 'game.js', 'ui.js', 'match.js',
      'characters.js', 'tournament.js', 'title.js', 'meikan.js',
      'team.js', 'taikai.js', 'scout.js',
      'jansou-guests.js', 'jansou-floor.js', 'jansou.js', 'serifu.js']

# 開発用。**ここに足さないこと。**足すと本番の index.html に入り、
# 普通のプレイヤーにデバッグの入口が見えてしまう。
# 配布ZIPを作るときも、この2つは外すこと（README.md の配布の手順）。
DEV_ONLY = ['debug.html', 'src/debug.js']

LIMIT = 500 * 1024          # PLiCyの上限。分割版では掛からないはずの保険


def read(name, base=SRC):
    with open(os.path.join(base, name), encoding='utf-8') as f:
        return f.read()


def build_styles():
    return '\n'.join('<link rel="stylesheet" href="src/%s">' % n for n in CSS)


def build_scripts():
    return '\n'.join('<script src="src/%s"></script>' % n for n in JS)


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
    # 混ざっても画面は普通に動いてしまうので、目では気づけない
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
    return 0


if __name__ == '__main__':
    sys.exit(main())
