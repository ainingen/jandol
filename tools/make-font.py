#!/usr/bin/env python3
"""
src/maru.css を作り直す（表紙とプレイヤー設定で使う丸ゴシック）

  python3 tools/make-font.py

なぜ必要か：
  日本語の丸ゴシックはApple系にしか標準で入っていない。
  Windows/Androidでは普通のゴシックに落ちてしまうため、
  使う文字だけを切り出したフォントをCSSに埋め込んでいる。

  ただし「使う文字だけ」なので、**題字や副題の文言を変えたら
  必ずこれを実行し直すこと**。入っていない字はその一文字だけ
  別の書体で出て、すぐ分かるほど不格好になる。

必要なもの：
  pip install fonttools brotli
  ofl/mplusrounded1c の TTF（下の FONT_URL から取得）

ライセンス：
  M PLUS Rounded 1c は SIL Open Font License 1.1。
  埋め込み・再配布ともに可。著作権表記は maru.css の先頭に入れてある。
"""
import os
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'src', 'maru.css')
FONTDIR = os.path.join(ROOT, 'fonts')
WORK = os.path.join(HERE, '_fontwork')

FONT_URL = 'https://raw.githubusercontent.com/google/fonts/main/ofl/mplusrounded1c/'


# ---- 題字だけに使う文字（太いほう。ここは最小限でよい） ----
TITLE_STRINGS = [
    '雀ドル発掘放浪記',                 # 題字
    'その雀荘に、まだ見ぬ雀ドルがいる',    # 副題
]

# ---- 本文に使う文字 ----
# 画面に出る文字はソースから機械的に拾う。加えて、
# プレイヤーが自由に入力する名前のために常用漢字を丸ごと入れる。
# ここを削ると、入っていない字だけ別の書体で出る。
JOYO_URL = ('https://raw.githubusercontent.com/davidluzgouveia/'
            'kanji-data/master/kanji.json')

KANA_RANGES = [
    (0x0020, 0x007E),   # 英数と記号
    (0x3000, 0x303F),   # 句読点・括弧
    (0x3041, 0x309F),   # ひらがな
    (0x30A0, 0x30FF),   # カタカナ
    (0xFF01, 0xFF60),   # 全角英数と記号
]


def source_chars():
    """src/ と shell.html に実際に書かれている文字を拾う"""
    import glob
    text = ''
    for path in sorted(glob.glob(os.path.join(ROOT, 'src', '*.js')) +
                       glob.glob(os.path.join(ROOT, 'src', '*.css')) +
                       [os.path.join(ROOT, 'shell.html')]):
        with open(path, encoding='utf-8') as f:
            text += f.read()
    return {ch for ch in text if ord(ch) > 0x2000}


def joyo_chars():
    cache = os.path.join(WORK, 'kanji.json')
    if not os.path.exists(cache):
        print('常用漢字の一覧を取得')
        urllib.request.urlretrieve(JOYO_URL, cache)
    import json
    with open(cache, encoding='utf-8') as f:
        data = json.load(f)
    return {k for k, v in data.items() if v.get('grade')}


def ui_chars():
    out = set()
    for a, b in KANA_RANGES:
        out |= {chr(c) for c in range(a, b + 1)}
    return out | source_chars() | joyo_chars()


def title_chars():
    return set(''.join(TITLE_STRINGS))


def build_one(weight, ttf_name, chars, tag):
    """woff2 を fonts/ に書き出す。
    CSSに埋め込まないのは、PLiCyの index.html に容量の上限があるため。
    埋め込むと index.html が1MB近くになる。"""
    ttf = os.path.join(WORK, ttf_name)
    if not os.path.exists(ttf):
        print('取得 %s' % ttf_name)
        urllib.request.urlretrieve(FONT_URL + ttf_name, ttf)
    txt = os.path.join(WORK, 'chars-%s.txt' % tag)
    with open(txt, 'w', encoding='utf-8') as f:
        f.write(''.join(sorted(chars)))
    woff2 = os.path.join(WORK, 'maru-%s.woff2' % tag)
    subprocess.run([
        'pyftsubset', ttf, '--text-file=' + txt,
        '--output-file=' + woff2, '--flavor=woff2',
        '--layout-features=', '--no-hinting', '--desubroutinize',
        '--drop-tables+=DSIG',
    ], check=True)
    os.makedirs(FONTDIR, exist_ok=True)
    dest = os.path.join(FONTDIR, 'maru-%s.woff2' % tag)
    with open(woff2, 'rb') as fsrc, open(dest, 'wb') as fdst:
        fdst.write(fsrc.read())
    size = os.path.getsize(dest)
    print('  %s  %d文字 → fonts/maru-%s.woff2  %.0f KB' % (tag, len(chars), tag, size / 1024))
    return (weight, 'maru-%s.woff2' % tag)


def main():
    os.makedirs(WORK, exist_ok=True)
    faces = [
        # 本文。常用漢字まで入れるので大きいが、これがないと
        # プレイヤーの入力した名前だけ別の書体になる
        build_one('700', 'MPLUSRounded1c-Bold.ttf', ui_chars(), 'ui'),
        # 題字だけ。太いほうは表紙にしか使わないので最小限
        build_one('800', 'MPLUSRounded1c-ExtraBold.ttf', title_chars(), 'title'),
    ]

    css = HEAD
    for weight, filename in faces:
        css += FACE % (weight, filename)
    css += TAIL

    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(css)
    print('%s  %.0f KB' % (OUT, len(css) / 1024))
    print('このあと python3 build.py を実行すること')
    return 0


HEAD = """/* ============================================================
   maru.css — 表紙とプレイヤー設定で使う丸ゴシック
   ※ tools/make-font.py が生成する。直接編集しないこと

   M PLUS Rounded 1c（SIL Open Font License 1.1）
   Copyright 2016 The Rounded M+ Project Authors
   https://github.com/coz-m/MPLUS_FONTS

   日本語の丸ゴシックはApple系にしか標準で入っていないため、
   使う文字だけを切り出して fonts/ に置いてある。外部通信は不要。

   CSSに埋め込まないのは、PLiCyの index.html に容量の上限があるため。
   埋め込むと index.html だけで1MB近くになる。
   パスは src/ から見た ../fonts/ と書いてある。
   CSSのurl()はCSSファイルの位置から解決されるため、単体ページ（直下のhtml）から
   src/maru.css を読んだときにこれで正しく届く。
   build.py は index.html に取り込むときに fonts/ へ書き換える。

   題字や副題の文言を変えたら make-font.py を実行し直すこと。
   ============================================================ */

"""

FACE = """@font-face{
  font-family:'Maru';font-style:normal;font-weight:%s;font-display:swap;
  src:url(../fonts/%s) format('woff2');
}
"""

TAIL = """
:root{
  --maru:'Maru',"Hiragino Maru Gothic ProN","\u30d2\u30e9\u30ae\u30ce\u4e38\u30b4 ProN W4",
         "M PLUS Rounded 1c",var(--sans);
  --neon:#ff3a8c;
}
"""

if __name__ == '__main__':
    sys.exit(main())
