# ADR-0002 3D動作解析エンジンの選定・パイプライン構成・商用ライセンス管理

## 状態

**Accepted**（2026-11-20、関連 Issue [#5](https://github.com/manabukosaka/sports-motion-app/issues/5)、[#35](https://github.com/manabukosaka/sports-motion-app/issues/35)、[#36](https://github.com/manabukosaka/sports-motion-app/issues/36)、[#37](https://github.com/manabukosaka/sports-motion-app/issues/37)）

## 背景

現場のコーチ・選手は、専門知識なしで撮影直後に結果を確認し、信頼度の低い点を案内に沿って修正し、文献との比較を理解して動画や結果を LINE で共有できる必要がある。Progressive Disclosure に従い、既定の現場モードでは専門用語や解析パラメータを表示せず、Pro／研究モードで DLT、マーカー追跡、ISB 関節運動学の設定とプラグイン追加を扱う。商用配布の可否は、コードに加えてモデル重み・学習データの利用条件で判断する。[現場ヒアリング #2](https://github.com/manabukosaka/sports-motion-app/issues/2#issuecomment-7018688910)、[プロダクトデザイン仕様](../02-product-design.md)

## 決定

### 交換可能なパイプライン

同期・校正情報を入力とし、以下のステージを共通の入出力スキーマで接続する。

| ステージ | 境界契約 |
| :--- | :--- |
| `Tracker2D` | 各視点のフレームから `Image2D` の観測点、信頼度、欠測状態を返す。単眼のモデル由来 3D は観測点と区別した補助出力とする。 |
| `CoordinateRevision` | 観測点と手動・マーカーによる修正差分を受け取り、Raw を保持したままリビジョン付きの座標を返す。2D 上で補間した点は補間済みと記録する。 |
| `Reconstructor3D` | 編集済みの同期観測と校正情報から `World3D` を再構成する。単眼ではモデル由来 3D を腰中心の推定座標として返す。 |
| `FilterAndKinematics` | 3D 時系列の補間・平滑化と関節角度・角速度の算出を担い、補間箇所と算出不能な指標を明示する。 |

全境界で座標系（`Image2D`、`Camera3D`、校正済み `World3D`、腰中心の推定 3D）、原点・軸、単位（`px`、`m`、`deg`／`rad` など）を型とスキーマで区別する。`Image2D` には視点とレンズ歪み補正の有無を記録する。時刻は元のフレーム番号と単調増加する撮影タイムスタンプ（秒）を保持し、多眼では共通時間軸への対応を記録する。欠測は理由付きで表し、観測・手動修正・補間を識別する。座標系や単位の変換は明示し、境界の不一致は拒否する。

各ステージの出力に `pipeline_version`、使用モデルの `model_hash`（モデル不使用時は明示的に該当なし）、`license_tier` を必須とする。解析結果にはこれらの履歴に加え、ステージと設定、校正の識別子と誤差（該当時）、編集リビジョンを記録し、同一条件の再計算を再現できるようにする。

### 商用 MVP V1.0 の標準構成（Tier A のみ）

- **単眼の現場モード**は MediaPipe Pose Landmarker Full の 2D と腰中心の 3D World Landmarks を使う。UI と共有結果では「腰を基準にした推定 3D」と「校正した実寸 3D（m）」を区別する。2D 修正は 2D 表示と指標に反映する。修正箇所の単眼 3D はモデル推定のままであることを示し、信頼度が不足する指標は欠測とする。
- **校正済み 2 カメラモード**は MediaPipe の 2D を使い、手動修正・マーカー座標を同じ編集経路で扱う。校正と三角測量ではレンズ歪み補正を必須とし、補正後の座標と投影モデルをそろえる。非共面制御点を配置したコントロールポールによる 3D-DLT と、ChArUco／チェッカーボードのステレオ校正による三角測量を採用する。同期した観測を共通の実寸 `World3D` に復元し、校正に使っていない確認点で精度を検証する。
- **フィルタ・関節運動学**は、補間可能な欠損を 3 次スプラインで補完し、4 次ゼロ位相 Butterworth ローパスを適用する。高速上肢と体幹・下肢で残差分析とカットオフ選定を分ける。算出可能な関節角は ISB の関節座標系に準拠し、軸・回転順序・符号を記録する。Pose2Sim の三角測量・フィルタコアと OpenSim Core の逆運動学に互換のアダプターを設ける。上腕の軸回旋など、入力から識別できない指標は欠測とする。[対象動作と計測仕様](../05-mvp-sports-and-validation.md)

### 研究・拡張プラグイン

Tier B/C のコード・重み・依存物は商用標準アプリとサーバーイメージから除外する。Pro／研究モードで、ユーザーが用意したプラグインを標準の実行環境から隔離して読み込む。読み込みには、対象ステージ、プラグイン版、契約互換版、`model_hash`、`license_tier` を含む明示的なバージョン付きマニフェストと、用途に応じた権利の証跡を伴うライセンス宣誓を必須とする。Tier B の商用利用には対象重み・学習データの権利確認、または利用条件を満たすデータでの再学習が必要。Tier C の利用は各ライセンスが許す研究・ユーザー提供の用途に限る。

## 検討した代替案

- **WHAM、MotionBERT、RTMPose-m Halpe26 の標準同梱**は却下する。WHAM は SMPL 系・3DPW の非商用条件、MotionBERT は Human3.6M の学術利用条件、RTMPose-m Halpe26 は Body8 学習設定で使う COCO-WholeBody の非商用条件に抵触する。[Spike 1b ライセンス監査](https://github.com/manabukosaka/sports-motion-app/issues/36#issuecomment-7019553426)
- **レンズ歪み補正なしの DLT** は、低ノイズ確認点の再投影誤差が 4.21807 px となり、Gate 1 の基準を満たさないため却下する。[Spike 1a 実測結果](https://github.com/manabukosaka/sports-motion-app/issues/35#issuecomment-7018942109)

## 影響

現場では単眼のプリセットから解析を始められ、校正済みの計測や研究向け手法を必要に応じて選べる。2 カメラ計測には同期と校正が必要になる。ステージ差し替え後も結果を追跡できるよう、契約の互換性とモデル・校正・フィルタ設定の履歴を維持する。プラグインや重みの変更ごとに、利用・再配布の条件を確認する。

## 検証と強制

### Spike 1a の合成ベンチマーク

合成 3 動作・2 カメラ。Ryzen 7 7800X3D、Python 3.14.4、OpenCV 5.1.0、seed 35。不変条件テストは 13/13 PASS。再計算の計測経路は 2D 欠損の補間、3D 再構成、フィルタと関節運動学の算出を含む。[Spike 1a 実測結果](https://github.com/manabukosaka/sports-motion-app/issues/35#issuecomment-7018942109)

| 手法 | 低ノイズ確認点の再投影（px） | 確認距離 RMSE（m） | 最悪角度 RMSE（deg） | 低ノイズでのゼロ位相検証（フレームずれ） | 720 フレーム再計算（ms） |
| :--- | ---: | ---: | ---: | ---: | ---: |
| 歪み補正なし DLT | 4.21807（FAIL） | 0.01799 | 2.94 | — | 47.1 |
| 歪み補正あり DLT（非共面制御点 16 点） | 0.00002（PASS） | 0.00831 | 2.92（PASS） | 0 | 59.6（PASS） |
| チェッカーボードステレオ（OpenCV `calibrateCamera`／`stereoCalibrate`） | 0.00010（PASS） | 0.00829 | 2.88（PASS） | 0 | 70.9 |

Gate 1 の再投影誤差 `< 2.0 px` は低ノイズの校正確認点に適用する。独立した 2D ノイズが `σ = 2 px` のとき、理論下限は `√2 × σ ≈ 2.83 px`。角度 RMSE の基準は `< 5 deg`、座標編集後の再計算目標は `5000 ms`。ステレオの表はチェッカーボードの実測値であり、ChArUco は Phase 2／3 で検証する。[開発プロセス](../03-development-process.md)、[Spike 1a 実測結果](https://github.com/manabukosaka/sports-motion-app/issues/35#issuecomment-7018942109)

投球の上腕軸回旋の真値ピーク `6720 deg/s` は、全身をまとめた Winter 残差分析のカットオフ `11.9 Hz` で約 `5600–5718 deg/s` に減衰し、無平滑の生値はノイズで約 `11900 deg/s` に増幅した。部位別カットオフはピーク振幅と時刻の両方で検証する。[Spike 1a 実測結果](https://github.com/manabukosaka/sports-motion-app/issues/35#issuecomment-7018942109)

### Spike 1b の監査とローカルベンチマーク

17 候補の監査（Tier A 6 件、Tier B 2 件、Tier C 9 件）で、MediaPipe Full と MoveNet Lightning TFLite（ともに Apache-2.0）、OpenCV Zoo BlazePose ONNX ペア（Apache-2.0、ONNX Runtime は MIT）、Pose2Sim の三角測量・フィルタコア（BSD-3-Clause）、OpenSim Core IK（Apache-2.0）が Tier A。同梱判定は監査対象の成果物単位で行う。Tier B は RTMPose-s COCO17（`8edcf0d7`）と RTMLib Body balanced（`e48f03d0`）。Tier C には標準同梱を見送った上記のモデルのほか、RTMPose COCO-WholeBody／RTMW Cocktail14、ViTPose-B／++、Ultralytics YOLO11 Pose（AGPL-3.0）、PoseFormerV2、VideoPose3D、SMPLer-X が含まれる。[Spike 1b ライセンス監査](https://github.com/manabukosaka/sports-motion-app/issues/36#issuecomment-7019553426)

ローカル計測は 12,000 フレーム。Ryzen 7 7800X3D、RTX 4070 Ti SUPER 16 GB、Python 3.12.13。読込・推論 P95 は 600 フレーム（60 fps で 10 秒）のクリップ単位。角度精度は合成矢状面の代理評価。[Spike 1b 実測結果](https://github.com/manabukosaka/sports-motion-app/issues/36#issuecomment-7019553426)

| 手法 | 読込＋推論 P95（s） | FPS | 合成矢状面での結果 |
| :--- | ---: | ---: | :--- |
| MediaPipe Full 3D World Landmarks（CPU） | 7.560 | 80.97 | 右膝 600/600、r=0.9952、RMSE 4.97 deg。右肘 561/600、r=0.9772、RMSE 6.62 deg。両関節で Gate 1 の参考基準を満たした。 |
| MoveNet Lightning（CPU） | 11.361 | 55.48 | 有効な右肘は 0/600。 |
| OpenCV Zoo BlazePose ONNX（CUDA） | 5.191 | 118.38 | 右膝 305/600、RMSE 18.35 deg。 |

MediaPipe Full のフレーム単位 P95 は 12.79 ms。[Spike 1b 実測結果](https://github.com/manabukosaka/sports-motion-app/issues/36#issuecomment-7019553426)

### Phase 2／3 の検証と CI

- **Phase 2 の Biomechanics Eval Harness** で、座標・単位・時間・欠測の契約、校正の再投影と既知距離、角度誤差、骨長、フィルタ位相、編集後の再計算の決定性を合成真値データで回帰検証する。CI で `biomech-eval` を必須とする。
- **Phase 2／3 の実写・実機 Eval** で、投球・ランニング・CMJ／DVJ の実写映像を同期した基準計測と比較する。遮蔽・高速ブレ・視点差を含めて有効率、角度と速度ピークの誤差、イベント時刻を測る。スマホの動画デコード単体とデコード込み解析の P95、および編集確定から結果表示までの時間を実機で計測する。合成データと PC の測定値はそれぞれの Spike 条件での証跡とする。[対象動作と計測仕様](../05-mvp-sports-and-validation.md)
- **CI ライセンスゲート**は商用アプリとサーバーイメージの実際の配布物を、承認済み Tier A の許可リストと照合する。モデル重みのハッシュ、推移依存、ライセンス・学習データの根拠、配布時の通知義務を確認し、Tier B/C や未承認・証跡不足の成果物が含まれるビルドを拒否する。プラグインの読み込み境界はマニフェスト、版互換性、ハッシュ、宣誓の欠落・不一致を契約テストで検証する。
