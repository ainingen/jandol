#!/usr/bin/env python3
"""
効果音を合成して audio/ に書く（docs/design/match/spec.md §2.1）

  python3 tools/make-sfx.py            audio/discard.wav（控えの一本）だけを書き直す

**この道具が書くのは discard.wav 一本だけになった**（2026年9月4日）。
9本とも合成音だったが、13本すべてを ElevenLabs で生成したものへ差し替えたため。
いま audio/ を作るのは `tools/prep-sfx.py`（`audio_raw/` から切り出して整形する）。
残っている discard.wav は、**discard1〜4 が一本も読めなかったときの控え**
（`src/sound.js` の落とし先）で、生成音の側には対応するものが無い。

**下の9つの関数は消していない。**合成でどう作っていたかの記録であり、
素材が無い環境でも音を鳴らせる最後の道でもある。ただし**呼ばない**
——`main()` は `WRITES` に書いた名前しか書かず、しかも `prep-sfx.py` が
持っている名前は書こうとした時点で止める（下の `owned_by_prep`）。
**ここに名前を足して回すと、生成音が合成音で黙って潰れる。**

なぜ合成だったか：
  他所のゲームから採らない、という決めごと（§2.1）。CC0 の素材を集めるか
  実際に牌を録るのが本筋だが、どちらも手元に無いときに空のままにしないため、
  ここで全部を自前で作った。出典が自分なので `audio/LICENSE.txt` は迷わない。
  **差し替えるときは同じ名前で上書きするだけ**でよい（`src/sound.js` は名前しか見ない）。

作り：
  打楽器の音は「短いノイズ（当たり）」＋「減衰する正弦波（胴の共鳴）」の足し算で
  ほぼ出せる。牌の音は硬い樹脂が硬い卓に当たる音なので、共鳴は高め・短めにする。
  和了・放銃・流局だけ音程を持つ。

  22050Hz・16bit・モノラル。全部で 330KB ほど。index.html の500KB制限とは無関係。


依存：標準ライブラリだけ（numpy を要らないようにしてある）。
"""
import importlib.util
import math
import os
import random
import struct
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'audio')

# **この道具が書いてよい名前。**ここに足すときは、その名前を prep-sfx.py が
# 持っていないことを確かめること（持っていれば下の錠が止める）
WRITES = ['discard']
SR = 22050
rng = random.Random(20260904)      # 種を固定。回すたびに音が変わらないように


# ---------- 部品 ----------
def buf(sec):
    return [0.0] * int(SR * sec)


def add(dst, src, at=0.0, gain=1.0):
    """dst の at 秒の位置に src を足し込む"""
    o = int(at * SR)
    for i, v in enumerate(src):
        j = o + i
        if j >= len(dst):
            break
        dst[j] += v * gain
    return dst


def sine(freq, sec, decay, gain=1.0, phase=0.0, sweep=None):
    """減衰する正弦波。decay は振幅が 1/e になる秒数。sweep=(f0,f1) で音程を滑らせる"""
    n = int(SR * sec)
    out = []
    ph = phase
    for i in range(n):
        t = i / SR
        f = freq if sweep is None else sweep[0] + (sweep[1] - sweep[0]) * (t / sec)
        ph += 2 * math.pi * f / SR
        out.append(math.sin(ph) * math.exp(-t / decay) * gain)
    return out


def noise(sec, decay, gain=1.0, lp=0.0):
    """減衰するノイズ。lp（0〜1）を上げるほど丸い音になる（一次のローパス）"""
    n = int(SR * sec)
    out = []
    y = 0.0
    for i in range(n):
        t = i / SR
        x = rng.uniform(-1, 1)
        y = y + (x - y) * (1.0 - lp)
        out.append(y * math.exp(-t / decay) * gain)
    return out


def attack(src, sec):
    """先頭を sec 秒かけて立ち上げる（音程のある音がプツッと始まらないように）"""
    n = max(1, int(SR * sec))
    for i in range(min(n, len(src))):
        src[i] *= i / n
    return src


def tone(freq, sec, decay, gain=1.0, harmonics=((1, 1.0), (2, .35), (3, .18), (4, .08))):
    """倍音を重ねた音程のある音。木琴のような硬い響き"""
    out = buf(sec)
    for k, g in harmonics:
        add(out, sine(freq * k, sec, decay / math.sqrt(k), gain * g))
    return out


def click(bright=1.0, size=1.0, gain=1.0, sec=0.16):
    """牌が卓に当たる一発。bright で高い成分、size で胴の低い成分を振る。
       sec は長さ。打牌の四本（下の DISCARDS）はここを少しずつ変えて別の一本にする"""
    out = buf(sec)
    add(out, noise(0.006, 0.0015, 0.9 * bright))                 # 当たりの瞬間
    add(out, sine(2600 * bright, 0.05, 0.007, 0.55 * bright))     # 樹脂の硬い鳴り
    add(out, sine(1350, 0.08, 0.012, 0.5))
    add(out, sine(640, 0.12, 0.022, 0.35 * size))                 # 卓の胴
    add(out, sine(190, 0.14, 0.035, 0.28 * size))                 # 卓を叩いた低い音
    return [v * gain for v in out]


def write(name, data, peak=0.9):
    m = max(1e-9, max(abs(v) for v in data))
    k = peak / m
    frames = bytearray()
    for v in data:
        x = max(-1.0, min(1.0, v * k))
        # 少し丸める（ソフトクリップ）。大きい音の角を取る
        x = math.tanh(x * 1.2) / math.tanh(1.2)
        frames += struct.pack('<h', int(x * 32767))
    path = os.path.join(OUT, name + '.wav')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(frames))
    print('%-10s %5.2f秒 %6.1fKB' % (name, len(data) / SR, os.path.getsize(path) / 1024))


# ---------- 9つ（記録。書くのは discard だけ） ----------
# ---- 下の9つのうち、いま書いているのは discard だけ（上の WRITES）----
def discard():
    """打牌。一番よく鳴るので、短く・硬く・後を引かない。

       **これは discard1〜4 が一本も読めなかったときの控え。**
       ふだん鳴るのは生成音の四本のほう（src/sound.js の FILES を見ること）。
       控えを消さないこと——音源を差し替える途中で打牌が無音になる"""
    return click(bright=1.0, size=1.0)


def draw():
    """ツモ。牌を手元に引く。打牌より小さく軽く、当たりを丸める"""
    out = buf(0.11)
    add(out, noise(0.03, 0.008, 0.5, lp=0.6))
    add(out, sine(1900, 0.05, 0.006, 0.22))
    add(out, sine(900, 0.08, 0.014, 0.25))
    return [v * 0.55 for v in out]


def call():
    """ポン・チー・カン。晒した二枚を続けて置く。二発目を少し低く"""
    out = buf(0.36)
    add(out, click(bright=1.05, size=0.9), 0.0)
    add(out, click(bright=0.9, size=1.2), 0.085)
    add(out, sine(150, 0.2, 0.06, 0.3), 0.09)          # 二枚まとめて置いた重さ
    return out


def riichi():
    """リーチ。宣言牌を横に置いて、千点棒を出す。
       棒が卓を転がる音は、小さな当たりを間隔を詰めながら並べる"""
    out = buf(0.7)
    add(out, click(bright=1.1, size=1.0), 0.0)
    t = 0.14
    gap = 0.075
    g = 0.5
    for _ in range(7):
        add(out, noise(0.004, 0.0012, 0.8), t)
        add(out, sine(3200, 0.03, 0.005, 0.4), t)
        add(out, sine(2100, 0.04, 0.007, 0.3), t)
        add(out, [v * g for v in sine(520, 0.06, 0.012, 0.3)], t)
        t += gap
        gap *= 0.8
        g *= 0.85
    add(out, sine(420, 0.12, 0.03, 0.25), t)            # 転がり終わって止まる
    return out


def agari():
    """和了。一番派手にしてよい。明るい分散和音を駆け上がる"""
    out = buf(1.4)
    notes = [523.25, 659.25, 783.99, 1046.5]            # C5 E5 G5 C6
    for i, f in enumerate(notes):
        add(out, attack(tone(f, 1.1 - i * 0.12, 0.28, 0.55), 0.004), i * 0.085)
    add(out, attack(tone(1318.5, 0.8, 0.22, 0.3), 0.004), 0.34)      # E6 で締める
    add(out, attack(tone(2093.0, 0.9, 0.35, 0.16, ((1, 1.0), (2, .2))), 0.01), 0.36)  # きらめき
    add(out, noise(0.02, 0.004, 0.35), 0.0)              # 手牌を倒す当たり
    return out


def deal():
    """放銃。和了と対にして、沈む。下がる音程に低い胴を重ねる"""
    out = buf(0.95)
    add(out, attack(sine(0, 0.7, 0.32, 0.7, sweep=(330, 110)), 0.01), 0.0)
    add(out, attack(sine(0, 0.7, 0.30, 0.35, sweep=(660, 220)), 0.01), 0.0)
    add(out, attack(sine(0, 0.6, 0.25, 0.22, sweep=(990, 330)), 0.01), 0.0)
    add(out, sine(75, 0.8, 0.22, 0.6), 0.06)             # 胸に落ちる低い音
    add(out, noise(0.03, 0.01, 0.3, lp=0.7), 0.0)
    return out


def dora():
    """ドラめくり。牌を裏返す。軽い擦れのあと、置く当たり"""
    out = buf(0.3)
    add(out, noise(0.07, 0.03, 0.45, lp=0.85), 0.0)      # 指で牌を起こす擦れ
    add(out, attack(sine(0, 0.06, 0.03, 0.2, sweep=(600, 1100)), 0.005), 0.02)
    add(out, click(bright=0.9, size=0.6, gain=0.7), 0.1)
    return out


def ryuukyoku():
    """流局。二つの音が下がって終わる。鈍い響きにして、和了と混ざらないように"""
    out = buf(1.05)
    soft = ((1, 1.0), (2, .15), (3, .05))
    add(out, attack(tone(392.0, 0.6, 0.22, 0.6, soft), 0.02), 0.0)     # G4
    add(out, attack(tone(293.7, 0.8, 0.30, 0.6, soft), 0.02), 0.32)    # D4
    add(out, sine(98, 0.8, 0.3, 0.25), 0.32)
    return out


def tap():
    """ボタン。ごく短く。対局以外でも使う"""
    out = buf(0.06)
    add(out, noise(0.003, 0.001, 0.7))
    add(out, sine(2000, 0.03, 0.006, 0.5))
    add(out, sine(1000, 0.05, 0.01, 0.3))
    return [v * 0.6 for v in out]


def owned_by_prep():
    """prep-sfx.py が audio/ に書く名前。**そこと重なったら書かない**。
       名前を数え直さずに向こうの表から読む——書き写すと、片方を直したときにずれる"""
    src = os.path.join(HERE, 'prep-sfx.py')
    spec = importlib.util.spec_from_file_location('prep_sfx', src)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return set(mod.SOURCES)


def main():
    os.makedirs(OUT, exist_ok=True)
    taken = owned_by_prep() & set(WRITES)
    if taken:
        raise SystemExit('prep-sfx.py が作っている音を上書きしようとしている: '
                         + ' '.join(sorted(taken))
                         + '\nWRITES から外すこと（回すと生成音が合成音で潰れる）')
    # 正規化の頭。打牌を 1 として、ツモとボタンはそれより小さく（§2.1「discard より小さく、軽く」）
    peaks = {'draw': 0.5, 'tap': 0.55, 'dora': 0.75, 'agari': 0.95, 'deal': 0.9}
    made = dict(discard=discard, draw=draw, call=call, riichi=riichi, agari=agari,
                deal=deal, dora=dora, ryuukyoku=ryuukyoku, tap=tap)
    for name in WRITES:
        write(name, made[name](), peaks.get(name, 0.9))
    print('\n書いたのは控えの discard.wav だけ。'
          'ほかの12本は生成音で、tools/prep-sfx.py が audio_raw/ から作る')


if __name__ == '__main__':
    main()
