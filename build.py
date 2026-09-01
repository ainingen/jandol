#!/usr/bin/env python3
"""
雀ドル発掘放浪記 — index.html を組み立てる

  python3 build.py            → 分割版（既定）。index.html は約25KB
  python3 build.py --single   → 一枚版。全部を index.html に埋め込む

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
fonts/ と img/ はもともと外部参照で問題なく動いているので、
CSSとJSも外に出せば index.html は約25KBまで落ちる。
以後どれだけ足しても、この制限に引っ掛かることはない。

--------------------------------------------------------------------
title.js と title.css だけ埋め込む理由（安全策）
--------------------------------------------------------------------
PLiCyのサムネイルは「index.html に書かれた最初のcanvas」を撮る。
canvasタグ自体は shell.html にあるので分割しても残るが、
表紙を描くコードまで外に出すのは念のため避けている。

**この判断は保険であって、必須ではない。**
撮影は投稿者が手で行うもので、そのときには読み込みはとっくに終わっている。
外に出しても動く可能性のほうが高い。25KBは充分に小さいので、
確かめる手間と釣り合わないと判断して埋め込みを残した。

--------------------------------------------------------------------
うまくいかなかったときの逃げ道
--------------------------------------------------------------------
PLiCyが外部JSを受け付けなかった場合は --single を使う。
従来どおり全部を index.html に埋め込んだ一枚版ができる。
**ただし500KBの制限が復活する**ので、その中で収める必要がある。

--------------------------------------------------------------------
注意
--------------------------------------------------------------------
・読み込み順は下の CSS / JS のリストの順。依存がある（例：ui.js は
  engine.js を前提にする）ので、並べ替えるときは依存を確認すること。
  scriptタグに defer は付けない。付けるなら全部に付ける。
  混ぜると順序が崩れる。

・url(../fonts/) の書き換えは**埋め込むCSSだけ**に行う。
  外部のままの src/*.css は src/ から見て ../fonts/ が正しく解決される。
  外部ぶんまで書き換えるとフォントが読めなくなる。

・module.exports の除去は「最初に現れる if (typeof module から
  ファイル末尾まで」を丸ごと落とす。正規表現に m フラグを付けると
  複数行の export ブロックを消しきれず、閉じ括弧だけが残って構文エラーに
  なる（引き継ぎ書 §4）。外部のままのファイルは削る必要がない。
  typeof で守られているのでブラウザでも安全に無視される。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')

# 読み込み順。並べ替えるときは依存を確認すること
CSS = ['style.css', 'theme.css', 'maru.css', 'title.css', 'meikan.css',
       'team.css', 'taikai.css', 'scout.css', 'jansou.css', 'match.css']
JS = ['engine.js', 'ai.js', 'game.js', 'ui.js', 'match.js',
      'characters.js', 'tournament.js', 'title.js', 'meikan.js',
      'team.js', 'taikai.js', 'scout.js', 'jansou.js', 'serifu.js']

# 分割版でも index.html に埋め込むもの（表紙まわり。上の「安全策」参照）
INLINE = {'title.css', 'title.js'}

LIMIT = 500 * 1024          # PLiCyの上限


def read(name, base=SRC):
    with open(os.path.join(base, name), encoding='utf-8') as f:
        return f.read()


def strip_exports(src):
    """末尾の module.exports を落とす。exports は必ずファイル末尾にある前提。"""
    marker = 'if (typeof module'
    i = src.find(marker)
    if i == -1:
        return src
    return src[:i].rstrip() + '\n'


def fix_font_path(css):
    """埋め込むCSSだけ。index.html は直下にあるので ../fonts/ が1段ずれる"""
    return css.replace('url(../fonts/', 'url(fonts/')


def build_styles(single):
    out = []
    for n in CSS:
        if single or n in INLINE:
            out.append('<style>\n/* ===== %s ===== */\n%s</style>'
                       % (n, fix_font_path(read(n))))
        else:
            out.append('<link rel="stylesheet" href="src/%s">' % n)
    return '\n'.join(out)


def build_scripts(single):
    out = []
    for n in JS:
        if single or n in INLINE:
            out.append('<script>\n/* ===== %s ===== */\n%s</script>'
                       % (n, strip_exports(read(n))))
        else:
            out.append('<script src="src/%s"></script>' % n)
    return '\n'.join(out)


def main():
    single = '--single' in sys.argv[1:]

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
           .replace('<!--__STYLES__-->', build_styles(single))
           .replace('<!--__SCRIPTS__-->', build_scripts(single)))

    # 埋め込んだぶんに export の残骸が無いか確認する
    if 'module.exports' in out:
        print('module.exports が index.html に残っています', file=sys.stderr)
        return 1

    path = os.path.join(HERE, 'index.html')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(out)

    size = len(out.encode('utf-8'))
    mode = '一枚版' if single else '分割版'
    print('%s  %s  %.0fKB' % (path, mode, size / 1024))

    if size > LIMIT:
        print('index.html が %.0fKB あります。PLiCyの上限は500KBです。'
              % (size / 1024), file=sys.stderr)
        if single:
            print('分割版（--single なし）にすれば約25KBになります。', file=sys.stderr)
        else:
            print('埋め込んでいるもの（build.py の INLINE）を減らしてください。',
                  file=sys.stderr)
        return 1
    print('  上限500KBに対して残り %.0fKB' % ((LIMIT - size) / 1024))

    if not single:
        ext = [n for n in CSS + JS if n not in INLINE]
        total = sum(os.path.getsize(os.path.join(SRC, n)) for n in ext)
        print('  外部ファイル %d 個（%.0fKB）。ZIPには src/ を必ず含めること'
              % (len(ext), total / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
