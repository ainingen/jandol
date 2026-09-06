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
0. 切り出す範囲が決まっているものは `cut=(始まり, 終わり)`（元ファイルの先頭からのms）。
   **この指定があるときは 1〜2 と 4 の自動の切り出しを通さない**——測って決めた位置が正で、
   道具が勝手にずらさない。指定が無いものは下の 1〜4 で自動で切る
1. 単発に切り出す（end_ms。2発入りの素材は谷で切る）
2. 頭を切る。**主ピークの 8ms 手前から。**
   **「-50dBFS を最初に超えた位置」は使わない。**この素材は主ピークの
   20〜30ms 前から低い助走が入っていて、その基準だと助走ごと残り、
   押してから音が出るまで遅れる（実測：src3 はピークの 25ms 前から
   包絡が 0.003 → 0.012 と上がっていく）
   **anchor='prehit' を渡すと例外**になり、主ピークの手前にある山（跳ね返り）の
   8ms 手前から切る。**いまこれを使っている素材は無い**——src1 の 370ms の山は
   包絡が主ピークの 59% あり、跳ね返りというより 2発目に近かったので、
   他の3本と同じ「主ピークの 8ms 手前」にそろえた（＝先行打は落とす）。
   本当の跳ね返り（主ピークより明らかに小さい残響）が来たときのために残してある
3. モノラルにする（左右の平均）
4. 尾を切る（tail_db。既定 -60dB）＋ 末尾 20ms をフェードアウト
4.5 頭に 1ms のフェードイン。**切った位置が波形の途中だと段差が残り、
   小さく「プチ」と鳴る**（src4 は切った瞬間の値がピークの 2.7% あった）。
   主ピークは 8ms 先なので、**1ms では立ち上がりは鈍らない**
   ——この区間の包絡はまだピークの 1〜3% しかない
4.7 `compress` があるものだけ、軽く均す（**いまは ryuukyoku だけ**）。
   連続音は大きい当たりだけが飛び出して「途切れた洗牌」に聞こえるので、
   20ms ごとの RMS の振れ幅が 12dB 以内に収まるまで均す。
   **踏む・戻す型では届かない**（下の compress の説明）。中心窓で測って、
   掛ける減衰そのものを平らにならす。
   **単発の音には掛けないこと**——立ち上がりが命で、潰すと打鍵感が消える
5. **聞こえの大きさを合わせる。**ピークではなく **A特性で重み付けした RMS**
   （オンセットから 150ms）で測る。**ピークを揃えると中域寄りのものだけ大きく聞こえる。**
   合わせかたは二通り：
     ・`target_db` … その一本を絶対値で置く（場面ごとに前に出す・引っ込める）
     ・`GROUPS` … 組の中で互いに揃える（打牌の四本。鳴り替わるので互いが揃っていることが要る）
   合わせたあと **ピークが -3dBFS を超えたら下げる。**
   `target_db` の一本は**その一本だけ**、組は**組ごと同じだけ**（でないと揃えた意味が消える）
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
    'discard1': dict(src='discard/src1.wav',
                     note='主ピーク 398ms。370ms の先行打は落とす（単発にそろえる）'),
    'discard2': dict(src='discard/src2.wav',
                     note='主ピーク 509ms。単発'),
    'discard3': dict(src='discard/src3.wav',
                     note='主ピーク 約400ms。単発'),
    'discard4': dict(src='discard/src4.wav', end_ms=218,
                     note='2発入り。144ms の1発目だけ使う（218ms の谷で切る）'),

    # ---- 残りの8つ。切り出す範囲は測って決めたもの（audio_raw/sfx/README.txt）----
    # **音の大きさは場面ごとに変える。**打牌（-30.1dB）を基準に、
    # 局が終わる音は前へ、よく鳴る音は後ろへ置く
    'draw': dict(src='sfx/draw-src.wav', cut=(241, 400), target_db=-36.0,
                 note='主ピーク 249ms。269ms の二打目は同じ動作なので残す。'
                      '一局で17回鳴るので打牌より控えめに'),
    'call': dict(src='sfx/call-src.wav', cut=(455, 580), target_db=-29.0,
                 note='**指定は459ms。456ms の一発目を残すため 4ms 早めた**'
                      '（459 だと三つ重なる塊の頭が欠ける）'),
    'riichi': dict(src='sfx/riichi-src.wav', cut=(11, 310), target_db=-28.0,
                   note='跳ねる音が6発（19/87/125/160/197/235ms）。全部残す'),
    'agari': dict(src='sfx/agari-src.wav', cut=(129, 250), target_db=-25.0,
                  note='主ピーク 137ms、167ms に続き。460ms の残りは捨てる。'
                       '局が終わるので一番派手にしてよい'),
    'deal': dict(src='sfx/deal-src.wav', cut=(28, 150), target_db=-27.0,
                 note='主ピーク 36ms。203ms の二発目は捨てる'),
    'dora': dict(src='sfx/dora-src.wav', cut=(305, 470), target_db=-33.0,
                 note='擦れ（316ms）＋着地（385ms）の組。'
                      '**指定は308ms。擦れの頭が切り口に掛かるので 3ms 早めた**'),
    'ryuukyoku': dict(src='sfx/ryuukyoku-src.wav', cut=(30, 800), target_db=-32.0,
                      fade_in_ms=10.0, fade_out_ms=120.0,
                      compress=dict(thresh_db=-60.0, ratio=3.6,
                                    det_ms=15.0, smooth_ms=15.0),
                      note='連続音。**この一本だけ均す**——大きい当たりだけが飛び出して'
                           '「途切れた洗牌」に聞こえるため。連続音なので前に出しすぎない'),
    'tap': dict(src='sfx/tap-src.wav', cut=(1287, 1380), target_db=-36.0,
                note='主ピーク 1295ms。1424ms の二発目は捨てる'),
}

# 聞こえの大きさを揃える単位。**同じ場面で鳴り替わるものを一つの組にする**
# （打牌の四本は鳴り替わるので、互いが揃っていることのほうが絶対値より大事）。
# **この組の結果（-30.1dBFS）が、他の8つの target_db の基準になっている。**
# 素材を採り直して組の音量が動いたら、8つの目標も見直すこと
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


def block_rms_db(x, sr, ms=20.0, skip_head=0, skip_tail=0):
    """20ms ごとの RMS（dBFS）。**むらの大きさを測るのに使う。**
       フェードの掛かっている端は外す（そこは意図して小さいので、むらではない）"""
    n = int(sr * ms / 1000)
    a = int(sr * skip_head / 1000)
    b = len(x) - int(sr * skip_tail / 1000)
    out = []
    i = a
    while i + n <= b:
        seg = x[i:i + n]
        out.append(db(math.sqrt(sum(v * v for v in seg) / n)))
        i += n
    return out


def compress(x, sr, thresh_db, ratio, det_ms, smooth_ms):
    """軽く均す。**連続音だけに掛ける**（単発は立ち上がりが命なので掛けない）。

       **踏む・戻す（attack / release）の形にしないこと。**最初はそれで書いたが、
       **むらが縮まらない**（35.7dB → 28.9dB。目標は12dB以内）。理由は、
       大きい当たりで踏んだ減衰が release で戻りきる前に次の谷が来て、
       **谷だけをさらに深く掘る**ため——上を下げたぶん下も下がるので差が残る。
       release を 3ms まで詰めると数字は追いつくが、波形の周期に乗って歪む。

       いまの形：**中央に構えた窓で測り、掛ける減衰そのものを平らにならす。**
       - 検出は det_ms の**中心窓** RMS（前後を同じだけ見る。遅れが出ない）
       - 減衰量を smooth_ms の中心窓で平均（切り替わりの角を取る。
         結果として当たりの 7ms 手前から踏み始める＝先読みと同じ効き）
       これで 20ms ごとに測ったむらが、ほぼ **もとの振れ幅 ÷ ratio** に落ちる。

       **閾値は谷（-50dBFS）より下に置く。**上に置くと静かなところが素通しになり、
       そこだけ元のままなので振れ幅が縮まらない。下に置けば全体が同じ比で潰れる。
       絶対値はこのあとの A特性RMS 合わせが決めるので、閾値の高さ自体は効かない。
       makeup はしない"""
    n = len(x)

    def win_mean(v, ms):
        """中心窓の平均（累積和で一度に）"""
        w = max(1, int(sr * ms / 1000))
        h = w // 2
        acc = [0.0] * (n + 1)
        for i in range(n):
            acc[i + 1] = acc[i] + v[i]
        out = [0.0] * n
        for i in range(n):
            lo = max(0, i - h)
            hi = min(n, i - h + w)
            out[i] = (acc[hi] - acc[lo]) / max(1, hi - lo)
        return out

    det = win_mean([v * v for v in x], det_ms)
    want = []
    for d in det:
        lv = db(math.sqrt(d))
        want.append(min(0.0, -(lv - thresh_db) * (1.0 - 1.0 / ratio)) if lv > thresh_db else 0.0)
    g = win_mean(want, smooth_ms)
    return [x[i] * (10 ** (g[i] / 20.0)) for i in range(n)]


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
    pre_i = None
    raw_spread = None

    if cfg.get('cut'):
        # 0. 範囲が決まっているもの。**道具が勝手にずらさない**
        a, b = cfg['cut']
        start = int(sr * a / 1000)
        y = x[start:int(sr * b / 1000)]
        ee = envelope(y, sr)
        pk = max(range(len(ee)), key=lambda i: ee[i])
    else:
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

    fade_in = cfg.get('fade_in_ms', HEAD_FADE_MS)
    fade_out = cfg.get('fade_out_ms', FADE_MS)

    # 4.7 均す（掛けるものだけ）。フェードの前に掛ける——端は意図して小さいので、
    #     そこを均すと逆にフェードを持ち上げてしまう
    if cfg.get('compress'):
        raw_spread = block_rms_db(y, sr, skip_head=fade_in, skip_tail=fade_out)
        y = compress(y, sr, **cfg['compress'])
    # 末尾をフェードアウト（既定 20ms。連続音は長め）
    fn = min(len(y), int(sr * fade_out / 1000))
    for i in range(fn):
        y[len(y) - fn + i] *= 1.0 - (i + 1) / fn
    # 頭をフェードイン（段差消し。既定 1ms）
    head0 = abs(y[0]) if y else 0.0
    hn = min(len(y), int(sr * fade_in / 1000))
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
        target_db=cfg.get('target_db'),
        cut=cfg.get('cut'),
        fade=(fade_in, fade_out),
        raw_spread=raw_spread,
        spread=(block_rms_db(y, sr, skip_head=fade_in, skip_tail=fade_out)
                if cfg.get('compress') else None),
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

    ceil = 10 ** (PEAK_CEIL_DB / 20.0)

    def finish(name, gain, trim):
        i = done[name][2]
        i['gain_db'] = db(gain)
        i['trim_db'] = db(trim)
        i['out_peak'] = max(abs(v) for v in done[name][0])
        i['out_arms'] = a_rms(done[name][0], done[name][1], 0)

    # 5a. 組の中で互いに揃える（打牌の四本）。**絶対値では置かない**
    #     ——鳴り替わるので、互いが揃っていることのほうが大事
    grouped = set()
    for gname, members in GROUPS.items():
        members = [m for m in members if m in done]
        if not members:
            continue
        grouped.update(members)
        target = sum(done[m][2]['arms'] for m in members) / len(members)
        gains = {}
        for m in members:
            g = target / done[m][2]['arms'] if done[m][2]['arms'] else 1.0
            done[m][0] = [v * g for v in done[m][0]]
            gains[m] = g
        # 揃えたあと、**組ごと同じだけ**下げてピークを -3dBFS 以下にする
        top = max(max(abs(v) for v in done[m][0]) for m in members)
        trim = min(1.0, ceil / top) if top else 1.0
        for m in members:
            done[m][0] = [v * trim for v in done[m][0]]
            finish(m, gains[m], trim)

    # 5b. 一本ずつ絶対値で置く（場面ごとに前へ・後ろへ）。
    #     **ピークが超えたらその一本だけ下げる**（他を巻き込むと目標が崩れる）
    for name in done:
        if name in grouped:
            continue
        i = done[name][2]
        if i['target_db'] is None:
            finish(name, 1.0, 1.0)
            continue
        want = 10 ** (i['target_db'] / 20.0)
        g = want / i['arms'] if i['arms'] else 1.0
        done[name][0] = [v * g for v in done[name][0]]
        top = max(abs(v) for v in done[name][0])
        trim = min(1.0, ceil / top) if top else 1.0
        if trim < 1.0:
            done[name][0] = [v * trim for v in done[name][0]]
        finish(name, g, trim)

    print('素材 → audio/（tools/prep-sfx.py）\n')
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
        where = ('%d〜%dms' % i['cut']) if i['cut'] else ('頭を %.0fms で切る' % i['cut_ms'])
        tgt = ('目標 %.1fdB' % i['target_db']) if i['target_db'] is not None else '組で揃える'
        print('  %-10s %-20s %s%s（%s／%+.1fdB 合わせ%s）'
              % (name, i['src'], pre, where, tgt, i['gain_db'],
                 ('／**%+.1fdB 下げ**' % i['trim_db']) if i['trim_db'] < -0.05 else ''))

    # 均した一本は、むらがどれだけ収まったかを出す
    for name in sorted(done):
        i = done[name][2]
        if not i['spread']:
            continue
        b4, af = i['raw_spread'], i['spread']
        print('\n  %s の 20ms ごとの RMS（フェードの外だけ・%d区間）' % (name, len(af)))
        print('    前 %.1f 〜 %.1f dBFS（振れ幅 %.1fdB）'
              % (min(b4), max(b4), max(b4) - min(b4)))
        print('    後 %.1f 〜 %.1f dBFS（振れ幅 %.1fdB）※音量合わせの前の値'
              % (min(af), max(af), max(af) - min(af)))

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
