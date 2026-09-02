# -*- coding: utf-8 -*-
"""客の名前生成。段階が3つある:
   0 一見さん → 通称のみ（タイプ由来）
   1 顔なじみ → 姓のみ（「〜さん」）
   2 常連     → フルネーム
   3 主       → フルネーム＋二つ名
"""
import random

SEI = ['佐藤','鈴木','高橋','田中','伊藤','渡辺','山本','中村','小林','加藤',
       '吉田','山田','佐々木','山口','松本','井上','木村','林','斎藤','清水',
       '山崎','阿部','森','池田','橋本','石川','前田','藤田','後藤','岡田',
       '長谷川','村上','近藤','石井','遠藤','青木','坂本','福田','太田','西村']
MEI_M = ['健一','浩二','誠','隆','拓也','大輔','翔太','和彦','正雄','雄一',
         '直樹','智也','剛','光男','将','敏夫','裕介','俊','悟','勝']
MEI_F = ['美咲','恵子','由紀','さくら','陽子','千夏','愛','裕子','麻衣','綾',
         '真理','久美','静香','琴音','七海','和美','里奈','あかり','桃子','詩織']
NIJINA = ['ラス回避の','三色の','面前一直線の','鳴き上手の','ベタオリの',
          '一発逆転の','リーチ一直線の','国士狙いの','手役師','速攻の']

# タイプ別の通称（一見さんのとき表示）
TSUUSHOU = {
 'student':'学生っぽい子','salaryman':'スーツの人','inkyo':'常連っぽいご老人',
 'couple':'カップルの片割れ','madam':'品のいいご婦人','tourist':'旅行者らしき人',
 'otaku':'うちわを持った人','shachou':'羽振りのよさそうな人','yopparai':'できあがった人',
 'arashi':'柄の悪い男','hikinuki':'黒スーツの男','pro':'ただ者でない打ち手',
 'nushi':'いつもの人','kisha':'メモを取る人','shishou':'白髪の老人',
 'seito':'教室の生徒さん','circle':'学生の集団','mamatomo':'買い物帰りの人',
 'gypsy':'見慣れない客','haishin':'撮影している人','moto':'マスクの女性',
 'kyokai':'紋付の紳士','kanyu':'営業の人','rival':'値踏みする男',
}
# 性別の傾向（見た目に合わせる。50%は指定なし＝どちらも）
GENDER = {'madam':'f','mamatomo':'f','moto':'f','couple':None,'inkyo':'m',
          'shachou':'m','arashi':'m','hikinuki':'m','kyokai':'m','shishou':'m',
          'rival':'m','yopparai':'m'}

def make_name(type_key, stage, rng=random):
    if stage <= 0:
        return TSUUSHOU.get(type_key, 'お客さん')
    sei = rng.choice(SEI)
    if stage == 1:
        return sei + 'さん'
    g = GENDER.get(type_key) or rng.choice(['m','f'])
    mei = rng.choice(MEI_M if g=='m' else MEI_F)
    full = sei + mei
    if stage >= 3:
        return rng.choice(NIJINA) + full
    return full
