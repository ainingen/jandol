#!/usr/bin/env python3
"""
生成した音源を切り出して整形し、audio/ へ書く（docs/design/match/spec.md §2.1）

  python3 tools/prep-sfx.py                 audio_raw/ から audio/ を作り直す
  python3 tools/prep-sfx.py --report        書かずに数値だけ出す
  python3 tools/prep-sfx.py --json PATH     測った数値を JSON で落とす（確認の絵を描く用）

**手作業でやらないこと。**同じ経路を他の8種類（ツモ・鳴き・リーチ…）も通す。
足すときは下の SOURCES と GROUPS に行を書くだけ。

--------------------------------------------------------------------
素材
--------------------------------------------------------------------
`audio_raw/` に置く。**このフォルダはコミットしない**（.gitignore）。
コミットするのは整形後の audio/ だけ。出どころは audio/LICENSE.txt が正。

--------------------------------------------------------------------
処理（この順で通す）
--------------------------------------------------------------------
1. 単発に切り出す（end_ms。2発入りの素材は谷で切る）
2. 頭を切る。**主ピークの 8ms 手前から。**
   **「-50dBFS を最初に超えた位置」は使わない。**この素材は主ピークの
   20〜30ms 前から低い助走が入っていて、その基準だと助走ごと残り、
   押してから音が出るまで遅れる（実測：src3 はピークの 25ms 前から
   包絡が 0.003 → 0.012 と上がっていく）
   **例外は先行打**（anchor='prehit'）。跳ね返りで主ピークの手前にもう一発ある
   ものは、その先行打の 8ms 手前から切る。**でないと一発目が消える**
3. モノラルにする（左右の平均）
4. 尾を切る（tail_db。既定 -60dB）＋ 末尾 20ms をフェードアウト
4.5 頭に 1ms のフェードイン。**切った位置が波形の途中だと段差が残り、
   小さく「プチ」と鳴る**（src4 は切った瞬間の値がピークの 2.7% あった）。
   主ピークは 8ms 先なので、**1ms では立ち上がりは鈍らない**
   ——この区間の包絡はまだピークの 1〜3% しかない
5. **聞こえの大きさを揃える。**ピークではなく **A特性で重み付けした RMS**
   （オンセットから 150ms）をグループ内で揃える。
   **ピークを揃えると中域寄りのものだけ大きく聞こえる**——この4本は
   1k-4k が 79% のものと 300Hz 以下が 55% のものが混ざっている。
   揃えたあと、**ピークが -3dBFS を超えないようグループ全体を下げる**
   （下げ幅は全員同じ。でないと揃えた意味が消える）
6. サンプルレートは変換しない（48kHz のまま）。16bit PCM WAV で書く

依存：標準ライブラリだけ（numpy を要らないようにしてある）。
"""
import argparse
import cmath
import json
import math
import os
import struct
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, '..', 'audio_raw')
OUT = os.path.join(HERE, '..', 'audio')

HEAD_MS = 8.0        # 主ピーク（または先行打）の何ms手前から残すか
HEAD_FADE_MS = 1.0   # 頭の段差消し（下の「4.5」を見ること）
FADE_MS = 20.0       # 末尾のフェードアウト
LOUD_MS = 150.0      # 聞こえの大きさを測る窓（オンセットから）
TAIL_DB = -60.0      # 尾を切る位置（ピークからの落ち）
PEAK_CEIL_DB = -3.0  # 揃えたあとの上限

# 先行打の見つけかた。**主ピークの直前は見ない**——同じ一発の立ち上がりを
# 別の打だと思ってしまう（src2 はピークの 5ms 前で既に 30% まで来ている）
PRE_FROM_MS = 60.0   # ここから
PRE_TO_MS = 10.0     # ここまでの間を見る
PRE_RATIO = 0.25     # 包絡がピークのこの割合を超えていたら「別の一発」

# 素材 → 出力名。**足すときはここに書く**
SOURCES = {
    'discard1': dict(src='discard/src1.wav', anchor='prehit',
                     note='主ピーク 398ms。370ms に軽い先行打（跳ね返り）。両方残す'),
    'discard2': dict(src='discard/src2.wav',
                     note='主ピーク 509ms。単発'),
    'discard3': dict(src='discard/src3.wav',
                     note='主ピーク 約400ms。単発'),
    'discard4': dict(src='discard/src4.wav', end_ms=218,
                     note='2発入り。144ms の1発目だけ使う（218ms の谷で切る）'),
}

# 聞こえの大きさを揃える単位。**同じ場面で鳴り替わるものを一つの組にする**
GROUPS = {'discard': ['discard1', 'discard2', 'discard3', 'discard4']}


# ---------------- 読み書き ----------------
def read_wav(path):
    w = wave.open(path)
    n, ch, sw, sr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
    if sw != 2:
        raise SystemExit('16bit PCM だけ扱う: ' + path)
    d = struct.unpack('<%dh' % (n * ch), w.readframes(n))
    w.close()
    if ch == 2:
        # モノラルにする（左右の平均）
        x = [(d[i * 2] + d[i * 2 + 1]) / 2.0 / 32768.0 for i in range(n)]
    else:
        x = [v / 32768.0 for v in d]
    return x, sr


def write_wav(path, x, sr):
    frames = bytearray()
    for v in x:
        frames += struct.pack('<h', int(max(-1.0, min(1.0, v)) * 32767))
    w = wave.open(path, 'wb')
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(bytes(frames))
    w.close()


# ---------------- 測る ----------------
def envelope(x, sr, ms=2.0):
    """全波整流 → 移動平均。立ち上がりを探すのに使う"""
    w = max(1, int(sr * ms / 1000))
    out = []
    s = 0.0
    for i, v in enumerate(x):
        s += abs(v)
        if i >= w:
            s -= abs(x[i - w])
        out.append(s / min(i + 1, w))
    return out


def fft(a):
    n = len(a)
    if n & (n - 1):
        raise ValueError('2の冪だけ')
    a = list(a)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            a[i], a[j] = a[j], a[i]
    ln = 2
    while ln <= n:
        wl = cmath.exp(-2j * math.pi / ln)
        for i in range(0, n, ln):
            w = 1 + 0j
            for k in range(ln // 2):
                u = a[i + k]
                v = a[i + k + ln // 2] * w
                a[i + k] = u + v
                a[i + k + ln // 2] = u - v
                w *= wl
        ln <<= 1
    return a


def a_weight(f):
    """A特性の重み（倍率）。人の耳は 300Hz 以下と 6kHz 以上を小さく聞く"""
    if f <= 0:
        return 0.0
    f2 = f * f
    num = (12194.0 ** 2) * (f2 ** 2)
    den = ((f2 + 20.6 ** 2)
           * math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2))
           * (f2 + 12194.0 ** 2))
    r = num / den
    return 10 ** ((20 * math.log10(r) + 2.0) / 20.0)


def _pad_pow2(seg, n=8192):
    return list(seg[:n]) + [0.0] * max(0, n - len(seg))


def a_rms(x, sr, start, ms=LOUD_MS):
    """A特性で重み付けした RMS。**ピークではなくこれを揃える**"""
    L = int(sr * ms / 1000)
    seg = x[start:start + L]
    if not seg:
        return 0.0
    N = 8192
    sp = fft(_pad_pow2(seg, N))
    tot = 0.0
    for k in range(N):
        f = (k if k <= N // 2 else N - k) * sr / N
        tot += (abs(sp[k]) * a_weight(f)) ** 2
    # Parseval：sum|x|^2 = (1/N) sum|X|^2。
    # **割るのは窓の長さ（150ms）で、素材の長さではない。**
    # 素材の長さで割ると、短い一本ほど高く出て、長い一本が小さく揃う
    # （長いほうが実際にはエネルギーを多く持つので、耳では大きい）
    return math.sqrt(tot / N / L)


def bands(x, sr, start, ms=LOUD_MS):
    """帯域分布（<300 / 300-1k / 1k-4k / >4k の%）"""
    L = int(sr * ms / 1000)
    seg = x[start:start + L]
    N = 8192
    seg = _pad_pow2(seg, N)
    seg = [seg[i] * 0.5 * (1 - math.cos(2 * math.pi * i / (N - 1))) for i in range(N)]
    sp = fft(seg)
    edges = [0, 300, 1000, 4000, sr / 2.0]
    acc = [0.0] * 4
    tot = 0.0
    for k in range(1, N // 2):
        f = k * sr / N
        p = abs(sp[k]) ** 2
        tot += p
        for b in range(4):
            if edges[b] <= f < edges[b + 1]:
                acc[b] += p
                break
    return [100 * a / tot for a in acc] if tot else [0.0] * 4


def decay_ms(x, sr, pk, db):
    """包絡がピークから db だけ落ちるまでの時間"""
    e = envelope(x, sr)
    thr = e[pk] * (10 ** (db / 20.0))
    for i in range(pk, len(e)):
        if e[i] < thr:
            return (i - pk) / sr * 1000.0
    return None


def db(v):
    return 20 * math.log10(v) if v > 0 else float('-inf')


# ---------------- 切り出し ----------------
def find_anchor(x, sr, e, pk, anchor):
    """頭を切る位置のもとになる山を返す。既定は主ピーク"""
    if anchor != 'prehit':
        return pk, None
    lo = max(0, pk - int(sr * PRE_FROM_MS / 1000))
    hi = max(0, pk - int(sr * PRE_TO_MS / 1000))
    if hi <= lo:
        return pk, None
    i = max(range(lo, hi), key=lambda k: e[k])
    if e[i] >= e[pk] * PRE_RATIO:
        return i, i
    return pk, None


def prepare(name, cfg, sr_expect=None):
    path = os.path.join(RAW, cfg['src'])
    x, sr = read_wav(path)
    src_len = len(x) / sr * 1000.0

    # 1. 単発に切り出す
    if cfg.get('end_ms'):
        x = x[:int(sr * cfg['end_ms'] / 1000)]

    # 2. 頭を切る
    e = envelope(x, sr)
    pk = max(range(len(e)), key=lambda i: e[i])
    anchor_i, pre_i = find_anchor(x, sr, e, pk, cfg.get('anchor'))
    start = max(0, anchor_i - int(sr * HEAD_MS / 1000))
    y = x[start:]
    pk -= start

    # 4. 尾を切る（end_ms が指定されていればそちらが優先）
    if not cfg.get('end_ms'):
        ee = envelope(y, sr)
        thr = ee[pk] * (10 ** (cfg.get('tail_db', TAIL_DB) / 20.0))
        end = len(y)
        for i in range(pk, len(ee)):
            if ee[i] < thr:
                end = i
                break
        y = y[:max(end, pk + int(sr * 0.03))]
    # 末尾 20ms をフェードアウト
    fn = min(len(y), int(sr * FADE_MS / 1000))
    for i in range(fn):
        y[len(y) - fn + i] *= 1.0 - (i + 1) / fn
    # 頭 1ms のフェードイン（段差消し）
    head0 = abs(y[0]) if y else 0.0
    hn = min(len(y), int(sr * HEAD_FADE_MS / 1000))
    for i in range(hn):
        y[i] *= (i + 1) / hn

    info = dict(
        name=name, src=cfg['src'], sr=sr, note=cfg.get('note', ''),
        src_len_ms=src_len, src_peak_ms=pk_ms_of(x, sr),
        pre_ms=(pre_i / sr * 1000.0) if pre_i is not None else None,
        cut_ms=start / sr * 1000.0,
        len_ms=len(y) / sr * 1000.0,
        head_before=head0,
        to_peak_ms=pk / sr * 1000.0,
        peak=max(abs(v) for v in y),
        decay40=decay_ms(y, sr, pk, -40),
        decay60=decay_ms(y, sr, pk, -60),
        bands=bands(y, sr, 0),
        arms=a_rms(y, sr, 0),
    )
    return y, sr, info


def pk_ms_of(x, sr):
    e = envelope(x, sr)
    return max(range(len(e)), key=lambda i: e[i]) / sr * 1000.0


# ---------------- 走らせる ----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', action='store_true', help='書かずに数値だけ出す')
    ap.add_argument('--json', help='測った数値を JSON で落とす')
    args = ap.parse_args()

    done = {}
    for name, cfg in SOURCES.items():
        y, sr, info = prepare(name, cfg)
        done[name] = [y, sr, info]

    # 5. 聞こえの大きさを揃える（グループごと）
    for gname, members in GROUPS.items():
        members = [m for m in members if m in done]
        if not members:
            continue
        target = sum(done[m][2]['arms'] for m in members) / len(members)
        for m in members:
            g = target / done[m][2]['arms'] if done[m][2]['arms'] else 1.0
            done[m][0] = [v * g for v in done[m][0]]
            done[m][2]['gain_db'] = db(g)
        # 揃えたあと、**組ごと同じだけ**下げてピークを -3dBFS 以下にする
        top = max(max(abs(v) for v in done[m][0]) for m in members)
        ceil = 10 ** (PEAK_CEIL_DB / 20.0)
        trim = min(1.0, ceil / top) if top else 1.0
        for m in members:
            done[m][0] = [v * trim for v in done[m][0]]
            i = done[m][2]
            i['trim_db'] = db(trim)
            i['out_peak'] = max(abs(v) for v in done[m][0])
            i['out_arms'] = a_rms(done[m][0], done[m][1], 0)

    print('打牌の素材 → audio/（tools/prep-sfx.py）\n')
    head = ('名前', '長さ', 'ピークまで', '減衰-40dB', '減衰-60dB',
            '<300', '300-1k', '1k-4k', '>4k', 'A-RMS', 'ピーク')
    print('%-10s %8s %10s %10s %10s %7s %7s %7s %7s %9s %9s' % head)
    for name in sorted(done):
        i = done[name][2]
        print('%-10s %7.0fms %9.1fms %9s %9s %6.1f%% %6.1f%% %6.1f%% %6.1f%% %8.1fdB %8.1fdB' % (
            name, i['len_ms'], i['to_peak_ms'],
            ('%.0fms' % i['decay40']) if i['decay40'] else '—',
            ('%.0fms' % i['decay60']) if i['decay60'] else '—',
            i['bands'][0], i['bands'][1], i['bands'][2], i['bands'][3],
            db(i['out_arms']), db(i['out_peak'])))
    print()
    for name in sorted(done):
        i = done[name][2]
        pre = ('先行打 %.0fms を残す / ' % i['pre_ms']) if i['pre_ms'] else ''
        print('  %-10s %s  %s頭を %.0fms で切る（%+.1fdB 揃え %+.1fdB 下げ）'
              % (name, i['src'], pre, i['cut_ms'], i['gain_db'], i['trim_db']))

    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump({n: done[n][2] for n in done}, f, ensure_ascii=False, indent=1)
        print('\n数値 → ' + args.json)

    if args.report:
        print('\n--report なので書いていない')
        return 0

    os.makedirs(OUT, exist_ok=True)
    print()
    for name in sorted(done):
        y, sr, i = done[name]
        p = os.path.join(OUT, name + '.wav')
        write_wav(p, y, sr)
        print('書いた %-10s %6.1fKB  %dHz' % (name, os.path.getsize(p) / 1024, sr))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
