#!/usr/bin/env python3
"""
雀ドルを探せ — 単一HTMLに束ねる

  python3 build.py            → index.html

前提：リポジトリの直下で実行すること。
  shell.html      … 外枠（ここに束ねたCSSとJSを差し込む）
  src/*.css *.js  … 各画面
出力は index.html。GitHub Pages がそのまま拾う名前にしてある。
img/ と fonts/ は同梱しない（index.html の隣にあれば読まれる）。

**index.html は 500KB を超えないこと。**PLiCyに上限がある。
フォントをCSSに埋め込むと一気に1MBを超えるので、fonts/ に外出ししてある。

注意：module.exports の除去は「最初に現れる if (typeof module から
ファイル末尾まで」を丸ごと落とす。引き継ぎ書 §4 にあるとおり、
正規表現に m フラグを付けると複数行の export ブロックを消しきれず、
閉じ括弧だけが残って構文エラーになる。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

SRC = os.path.join(HERE, 'src')

CSS = ['style.css', 'theme.css', 'maru.css', 'title.css', 'meikan.css', 'team.css', 'taikai.css', 'scout.css', 'match.css']
JS = ['engine.js', 'ai.js', 'game.js', 'ui.js', 'match.js',
      'characters.js', 'tournament.js', 'title.js', 'meikan.js', 'team.js', 'taikai.js', 'scout.js']


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


def main():
    missing = [n for n in CSS + JS if not os.path.exists(os.path.join(SRC, n))]
    if not os.path.exists(os.path.join(HERE, 'shell.html')):
        missing.append('shell.html')
    if missing:
        print('見つからないファイル:', ', '.join(missing), file=sys.stderr)
        return 1

    css = '\n'.join(f'/* ===== {n} ===== */\n{read(n)}' for n in CSS)
    # CSSは src/ にあるが、束ねた先の index.html は直下にある。
    # url() はCSSの位置から解決されるので、取り込むときにパスを詰める
    css = css.replace('url(../fonts/', 'url(fonts/')
    js = '\n'.join(f'/* ===== {n} ===== */\n{strip_exports(read(n))}' for n in JS)

    shell = read('shell.html', HERE)
    out = shell.replace('/*__CSS__*/', css).replace('/*__JS__*/', js)

    # 束ねたあとに export の残骸が無いか確認する
    if 'module.exports' in out:
        print('module.exports が残っています', file=sys.stderr)
        return 1

    path = os.path.join(HERE, 'index.html')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(out)

    size = len(out.encode('utf-8'))
    print(f'{path}  {size / 1024:.0f}KB')

    # PLiCyの上限。超えたら投稿できないので、ここで気づけるようにしておく
    limit = 500 * 1024
    if size > limit:
        print('index.html が %.0fKB あります。PLiCyの上限は500KBです。'
              % (size / 1024), file=sys.stderr)
        print('フォントをCSSに埋め込んでいないか確認してください'
              '（src/maru.css は fonts/ を参照する形が正しい）。', file=sys.stderr)
        return 1
    print('  上限500KBに対して残り %.0fKB' % ((limit - size) / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
