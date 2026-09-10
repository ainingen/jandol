#!/usr/bin/env python3
"""
雀ドル発掘放浪記 — カード用のサムネイルを焼く

  python3 tools/make-thumbs.py

`img/` の 001〜200 と p01〜p12（212枚・768×1024）を **176×234 の WebP** に
縮めて `thumb/` へ出す。読むのは**カードだけ**（`taikai.js` の `faceOf`）。

--------------------------------------------------------------------
なぜ要るのか
--------------------------------------------------------------------
**88px のカードに 768×1024 を流し込んでいた。**回線に載る量は小さい
（1枚の中央値 59KB）が、**効くのは寸法のほう**——768×1024 は展開すると
1枚 約3.1MB（RGBA）で、出走表の七枚なら 22MB が絵のためだけに要る。

実機（iOS Safari）で出ていた `H`（顔の取り込みが落ちる）は、
**「途中まではきちんと出て、大会を進めるほど落ちる」**という出かたで、
ファイル不在（なら最初から落ちる）でも回線（ならランダムに落ちる）でもなく、
**展開したぶんが積み上がって諦めている**形だった。寸法を落とすのが効く。

--------------------------------------------------------------------
決めごと
--------------------------------------------------------------------
・**別の置き場所にすること**（`thumb/`）。`img/` に 400 枚並ぶと、
  どちらが本物か分からなくなるし、ZIP に入れるとき外し忘れる
・**元の 768×1024 は捨てないこと。**名鑑と表紙は大きいまま使う
  （`title.js` の `PORTRAIT_MAX_ID` が読むのは `img/`）
・**二本立て（自分は `p01`〜、雀ドルは3桁）を崩さないこと。**
  `taikai.js` と `match.js` の `faceOf` が同じ式で、
  片方だけ直すと自分の顔だけ出なくなる
・**冪等。**二度走らせても同じものが出る（同じ入力・同じ設定なら
  WebP の出力は一致する）。走らせるたびに毎回全部を書き直すので、
  「変わった枚数」を最後に出す——0 でないのに絵を触っていないなら、
  下の設定か Pillow の版が動いている
・**品質はポートレートの書き出しと同じ 82**（`HANDOVER.md` §6）。
  揃えておかないと、カードと名鑑で肌の階調が食い違う

--------------------------------------------------------------------
寸法について
--------------------------------------------------------------------
元は 3:4（768×1024）、出すのは 176×234 で **0.28% だけ縦に詰まる**
（3:4 なら 234.67）。カードの `.tkFace` は `object-fit:cover` なので、
そのぶんは切り落とされて画面には出ない。**176 は 88px の 2倍**で、
DPR 2 の端末ならちょうど、DPR 3 でも溶けない。
**枠の寸法（176×234）を変えるときは、`.tkFace` の `aspect-ratio` と
カードの幅を先に測ること。**
"""

import os
import sys
import hashlib

try:
    from PIL import Image
except ImportError:                                     # pragma: no cover
    print('Pillow が要ります: python3 -m pip install Pillow', file=sys.stderr)
    sys.exit(1)

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, 'img')
OUT = os.path.join(HERE, 'thumb')

W, H = 176, 234
QUALITY = 82            # HANDOVER.md §6 の書き出し仕様と同じ
METHOD = 6              # WebP の符号化の手間。大きいほど小さくなる（遅いだけ）

# 焼く対象。**ここが `faceOf` の二本立てと対**（自分は p01〜、雀ドルは3桁）
NAMES = ['%03d' % i for i in range(1, 201)] + ['p%02d' % i for i in range(1, 13)]


def bake(name):
    """img/<name>.webp を 176×234 にして thumb/<name>.webp へ。

    返すのは ('made'|'same'|'skip', バイト数)。
    元が無ければ何も書かない——カードは `onerror` で影絵に落ちるので、
    **無いものを埋めないこと**（`--sil-img` の落とし口はそのまま）
    """
    src = os.path.join(SRC, name + '.webp')
    dst = os.path.join(OUT, name + '.webp')
    if not os.path.exists(src):
        return ('skip', 0)

    with Image.open(src) as im:
        im = im.convert('RGB')
        small = im.resize((W, H), Image.LANCZOS)

    before = None
    if os.path.exists(dst):
        with open(dst, 'rb') as f:
            before = hashlib.sha256(f.read()).hexdigest()

    small.save(dst, 'WEBP', quality=QUALITY, method=METHOD)

    with open(dst, 'rb') as f:
        blob = f.read()
    after = hashlib.sha256(blob).hexdigest()
    return ('same' if before == after else 'made', len(blob))


def main():
    if not os.path.isdir(SRC):
        print('img/ がありません', file=sys.stderr)
        return 1
    os.makedirs(OUT, exist_ok=True)

    made = same = 0
    total = 0
    missing = []
    for name in NAMES:
        how, size = bake(name)
        if how == 'skip':
            missing.append(name)
            continue
        total += size
        if how == 'made':
            made += 1
        else:
            same += 1

    n = made + same
    print('thumb/  %d枚  %.1fMB  （%dx%d / webp品質%d）'
          % (n, total / 1048576.0, W, H, QUALITY))
    print('  書き直した %d枚 / 前と同じ %d枚' % (made, same))
    if n:
        print('  1枚あたり平均 %.1fKB' % (total / 1024.0 / n))
    if missing:
        print('  img/ に無いので焼かなかった（カードは影絵に落ちる）: %s'
              % ', '.join(missing))
    print('  ZIPには thumb/ を必ず含めること'
          '（無いとカードの顔が全部シルエットになる）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
