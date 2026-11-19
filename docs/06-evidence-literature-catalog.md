# 初期エビデンス文献カタログと標準スキーマ

[プロダクト仕様のPillar 4](./02-product-design.md#pillar-4-最新文献エビデンス統計ベンチマーク比較)に沿い、野球投球8件、ランニング6件、跳躍・着地9件、共通手法3件の査読文献を登録した。Phase 0では書誌、対象集団、指標との対応、比較上の制約を管理する。全26件の `extraction_status` は `cataloged_pending_fulltext` で、`normative_metrics` は空配列とする。

[機械可読カタログ](./evidence/initial-literature-catalog.json) · [Evidence Registryスキーマ](./evidence/evidence-record.schema.json) · [MVPの対象動作と計測・検証仕様](./05-mvp-sports-and-validation.md)

## 文献と比較候補

`metrics_covered` は関連指標と方法上の参照先を示す。比較に採用するかは集団、計測法、イベントと指標定義を照合して決める。

### 野球投球（速球）

| 文献 | MVPで参照する内容 | 原典 |
| :--- | :--- | :--- |
| Fleisig ら（1999） | 競技レベル別の肩・肘角、骨盤・胸郭と上肢の角速度。ピーク時刻の起終点に差がある。 | [DOI](https://doi.org/10.1016/s0021-9290%2899%2900127-x) |
| Escamilla ら（1998） | 球種別の肩・肘角と角速度。比較候補は速球群。 | [DOI](https://doi.org/10.1123/jab.14.1.1) |
| Werner ら（2002） | 試合中の肩外旋・肘屈曲と肘外反負荷。角度と負荷の区別に使う。 | [DOI](https://doi.org/10.1067/mse.2002.121481) |
| Stodden ら（2005） | 骨盤・胸郭の角速度とピーク時刻、肩・肘運動。投手内の反復試技。 | [DOI](https://doi.org/10.1123/jab.21.1.44) |
| Aguinaldo・Chambers（2009） | 胸郭回旋開始、肩外旋、肘屈曲と肘外反負荷。回旋開始と角速度ピークを区別する。 | [DOI](https://doi.org/10.1177/0363546509336721) |
| Escamilla ら（2018） | 腕の振り方別の骨盤角速度、肩外旋と接地時の肘屈曲。 | [DOI](https://doi.org/10.1123/jab.2017-0211) |
| Slowik ら（2019） | 球速と肘内反トルクの力学的背景。MVP指標への直接対応なし。 | [DOI](https://doi.org/10.4085/1062-6050-558-17) |
| McCutcheon ら（2025） | 接地時の骨盤・胸郭・上肢角と角速度。肘内反トルクによる群分けを考慮する。 | [DOI](https://doi.org/10.1177/23259671241300560) |

### ランニング（地上・トレッドミル）

| 文献 | MVPで参照する内容 | 原典 |
| :--- | :--- | :--- |
| Novacheck（1998） | 走行周期、下肢波形と速度の影響を整理したナラティブレビュー。 | [DOI](https://doi.org/10.1016/s0966-6362%2897%2900038-6) |
| Ferber ら（2003） | レクリエーション走者の立脚期の股関節内転角。性別集計を照合する。 | [DOI](https://doi.org/10.1016/s0268-0033%2803%2900025-1) |
| Souza（2016） | 2D走行動画の観察法。投影角と3D角を区別する。 | [DOI](https://doi.org/10.1016/j.pmr.2015.08.006) |
| Fukuchi ら（2017） | トレッドミルの速度別波形と公開データ。ベルト速度は比較条件。 | [DOI](https://doi.org/10.7717/peerj.3298) |
| Bramah ら（2018） | 立脚中の骨盤側方傾斜と、接地時の膝・足関節角。傷害群と対照群の比較。 | [DOI](https://doi.org/10.1177/0363546518793657) |
| Preece ら（2019） | 競技レベル別の地上走。膝屈伸、ストライド長と走行速度の定義を照合する。 | [DOI](https://doi.org/10.1080/17461391.2018.1554707) |

### 垂直跳び・ドロップ垂直跳び

| 文献 | MVPで参照する内容 | 原典 |
| :--- | :--- | :--- |
| Bobbert ら（1986） | ドロップジャンプとCMJの押し返し動作。台高と屈曲の大きさを照合する。 | [DOI](https://doi.org/10.1007/BF00943342) |
| Ford ら（2003） | 高校バスケットボール選手のDVJ初回着地時の膝外反。左右とピークの定義を照合する。 | [DOI](https://doi.org/10.1249/01.MSS.0000089346.85744.D9) |
| Hewett ら（2005） | 女子選手の膝外反とACL傷害に関する前向き研究。角度とモーメントを区別する。 | [DOI](https://doi.org/10.1177/0363546504269591) |
| Vanezis・Lees（2005） | 成績別のCMJ跳躍高。高さの起点と腕振りを照合する。 | [DOI](https://doi.org/10.1080/00140130500101262) |
| Padua ら（2009） | 股・膝・足関節の着地所見。2D動画のLESSを3D計測と比較。 | [DOI](https://doi.org/10.1177/0363546509343200) |
| McErlain-Naylor ら（2014） | CMJ跳躍高の定義。立位基準の報告値を離地基準へ移すには離地時の重心高が必要。 | [DOI](https://doi.org/10.1080/02640414.2014.924055) |
| Krosshaug ら（2016） | DVJ初回接地の膝外反角と膝屈曲ピーク。女子エリート選手でのACLスクリーニング性能は低かった。 | [DOI](https://doi.org/10.1177/0363546515625048) |
| Leppänen ら（2017） | DVJ初回接地の股・足関節角と可動域。可動域、イベント角、関節モーメントを区別する。 | [DOI](https://doi.org/10.1177/2325967117745487) |
| Cronström ら（2020） | 膝外転の系統的レビュー。初回接地・ピークの膝外転角によるACL傷害予測を支持しなかった。 | [DOI](https://doi.org/10.1186/s12891-020-03552-3) |

### 共通の座標規約・スマホ計測

| 文献 | MVPで参照する内容 | 原典 |
| :--- | :--- | :--- |
| Wu ら（2002） | ISB勧告。股関節と足関節の局所座標系。 | [DOI](https://doi.org/10.1016/S0021-9290%2801%2900222-6) |
| Wu ら（2005） | ISB勧告。肩の軸回旋と肘屈曲の座標系。 | [DOI](https://doi.org/10.1016/j.jbiomech.2004.05.042) |
| Uhlrich ら（2023） | OpenCapの2台撮影の妥当性。ドロップジャンプ等を光学式マーカーと床反力計に照合。 | [DOI](https://doi.org/10.1371/journal.pcbi.1011462) |

## MVP指標とイベント

[MVP計測仕様の優先3D指標](./05-mvp-sports-and-validation.md#2-動作別計測仕様)に対応する識別子を定義する。各統計行には `metric_id`、`event_id`、単位、面または軸、対象集団と計測条件を記録する。

| 動作 | 指標 | `metric_id` | 単位 | 比較条件 |
| :--- | :--- | :--- | :--- | :--- |
| 野球投球 | 骨盤・胸郭の回旋角 | `pitch_pelvis_rotation_angle`<br>`pitch_thorax_rotation_angle` | `deg` | 水平面。軸、符号と採取イベントを合わせる。 |
| 野球投球 | 骨盤・胸郭の最大回旋角速度 | `pitch_pelvis_peak_rotation_angular_velocity`<br>`pitch_thorax_peak_rotation_angular_velocity` | `deg_per_s` | 実時間で算出。ピーク探索区間を合わせる。 |
| 野球投球 | 骨盤・胸郭の回旋ピーク時刻 | `pitch_pelvis_peak_rotation_timing`<br>`pitch_thorax_peak_rotation_timing` | `dimensionless` | 脚上げからMIRまでの割合。0〜1で格納し、0〜100%で表示。 |
| 野球投球 | 肩の内外旋角・最大内旋角速度 | `pitch_shoulder_axial_rotation_angle`<br>`pitch_shoulder_peak_internal_rotation_angular_velocity` | `deg`、`deg_per_s` | 胸郭に対する上腕の局所軸回旋。 |
| 野球投球 | 肘の屈曲角・最大伸展角速度 | `pitch_elbow_flexion_angle`<br>`pitch_elbow_peak_extension_angular_velocity` | `deg`、`deg_per_s` | 屈曲角は足接地、MER、リリースで取得。 |
| ランニング | 股・膝の屈伸角、足関節の背屈・底屈角 | `run_hip_flexion_extension_angle`<br>`run_knee_flexion_extension_angle`<br>`run_ankle_dorsiflexion_plantarflexion_angle` | `deg` | 矢状面。同側接地間の波形。 |
| ランニング | 骨盤側方傾斜・股関節内転角 | `run_pelvic_obliquity_angle`<br>`run_hip_adduction_angle` | `deg` | 前額面。立脚期のイベントまたは区間を合わせる。 |
| ランニング | ストライド長・平均進行速度 | `run_stride_length`<br>`run_mean_forward_speed` | `m`、`m_per_s` | 地上走の進行方向を `local_axis` で表す。速度は同側接地点間距離を周期秒で割る。 |
| ランニング | ケイデンス | `run_cadence` | `spm` | 左右を合わせた1分あたりの歩数。 |
| CMJ・DVJ | 着地の股・膝屈曲角、足関節背屈角と膝外転角 | `jump_landing_hip_flexion_angle`<br>`jump_landing_knee_flexion_angle`<br>`jump_landing_ankle_dorsiflexion_angle`<br>`jump_landing_knee_abduction_angle` | `deg` | 着地時と着地屈曲ピーク時に左右別で取得。膝外転は前額面。 |
| CMJ・DVJ | 重心上昇量・離地時の鉛直重心速度 | `jump_com_rise`<br>`jump_takeoff_vertical_com_velocity` | `m`、`m_per_s` | 上昇量は離地から頂点まで。DVJは反発跳躍を対象にする。 |

離地時の鉛直重心速度は、対応する原著の記載の確認をPhase 3に持ち越す。

イベントの接頭辞は投球が `pitch_`、ランニングが `run_`、跳躍が `cmj_` または `dvj_`。波形の区間IDは次の起終点を参照する。

| 区間ID | 0% | 100% |
| :--- | :--- | :--- |
| `pitch_cycle` | 脚上げ `pitch_leg_lift` | リリース後の最大内旋 `pitch_mir` |
| `run_stride` | 接地 `run_initial_contact` | 次の同側接地 `run_next_initial_contact` |
| `run_stance` | 接地 `run_initial_contact` | 離地 `run_toe_off` |
| `cmj_cycle` | 重心下降開始 `cmj_initiation` | 着地屈曲ピーク `cmj_peak_landing_flexion` |
| `dvj_cycle` | 台からの初回着地 `dvj_initial_landing_contact` | 反発跳躍の離地 `dvj_takeoff` |

`run_stance` は立脚内比較に使う。MVPの走行周期は `run_stride`。DVJの反発後着地は `dvj_rebound_landing_contact` として記録する。

## 統計比較と表示

- **指標カード**　同じ指標・イベント・単位・計測条件の参照集団で、平均 `μ` と標準偏差 `σ > 0` が確認できる場合は `z = (x − μ) / σ` を計算する。パーセンタイルには原データの経験分布または原著の分位点を使う。正規分布で近似する場合は分布適合の根拠と推定値であることを表示する。中央値とIQRしか得られない場合は四分位での位置を示す。
- **波形**　同じ起終点を実時間で0〜100%に線形写像し、共通の時間格子上で `μ(t) ± SD(t)` を表示する。波形点の時刻は `normalized_time_fraction` に0〜1で保持する。角速度は正規化前の実時間から算出する。点ごとの分散、イベント、起終点のいずれかが確認できない場合はバンドを表示しない。
- **計測法の照合**　光学式マーカーでは体表のずれや関節中心推定、単眼スマホ3Dでは奥行き・スケール・遮蔽・撮影時刻が比較に影響する。2D投影角、2台撮影での検証結果、3D関節角は各計測条件で扱う。同じ課題を両方式で撮影して系統差とばらつきを評価し、指標の比較可能性を確認する。座標規約はWuら、スマホの検証条件はUhlrichらを参照する。[ISB 上肢座標系](https://doi.org/10.1016/j.jbiomech.2004.05.042)・[OpenCap](https://doi.org/10.1371/journal.pcbi.1011462)
- **表示用途**　比較カード、波形、共有レポートに文献、対象集団、サンプル数、計測法と免責文を表示する。比較条件を満たせない場合は規範比較を表示しない。膝外反・肘負荷の観察所見は指導に使い、ACL傷害予測や診断閾値への転用を禁止する。[Krosshaug ら](https://doi.org/10.1177/0363546515625048)・[Cronström ら](https://doi.org/10.1186/s12891-020-03552-3)

> 用途はコーチングと動作分析の支援に限ります。医療診断や個人の傷害リスク判定への使用はできません。

## Phase 3の全文抽出

1. DOIから原著と補足資料を入手し、表・図・ページ、対象集団、動作条件、計測機器、座標系、イベント判定、集計単位を記録する。入手できない全文は保留する。
2. 指標・イベント・単位・条件が一致した行ごとに、原著で確認した平均とSD、中央値と四分位点、または指導用範囲を転記する。サンプル数は該当集計の独立観測数とし、選手数と試技数を区別する。図から読み取った推定値や由来を確かめられない値は保留する。
3. 原著の記載箇所を `source_locator`、集団・条件と集計単位を `cohort_notes` に保存し、`source_doi` を登録済み文献に結び付ける。先行して指標行を作る場合は `status` を `pending_fulltext_extraction`、数値と根拠欄を `null` とする。
4. 別の確認者が原著、転記と変換、比較可能性を照合する。承認済みの指標行と出典研究を `verified_normative` に更新し、`non_diagnostic_flag: true` を保持する。レジストリ版を更新し、比較レポートに使用版を保存する。

カタログの件数・ID・DOI・指標と出典の対応は [PowerShell検証スクリプト](../scripts/test-evidence-catalog.ps1) で確認できる。
