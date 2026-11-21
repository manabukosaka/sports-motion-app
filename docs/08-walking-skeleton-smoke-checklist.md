# Gate 2 Walking Skeleton 実機スモーク

対象は iOS と Android の Expo Dev Build。共有に同意したテスト選手、アップロードと共有リンク発行が可能なコーチ、端末から HTTPS で到達できる API と Share Web を用意する。受信側にも LINE を用意する。両 OS で各手順を行い、通過後にチェックする。端末が 240 fps 撮影に対応しない場合は理由を記録し、対応端末で 240 fps を検証する。

### Expo Dev Build の起動

リポジトリルートで `pnpm install --frozen-lockfile` と `pnpm --filter '@sports-motion/mobile...' run build` を実行する。Android SDK をセットアップした環境では `pnpm --filter @sports-motion/mobile exec expo run:android --device`、Xcode をセットアップした macOS では `pnpm --filter @sports-motion/mobile exec expo run:ios --device` で開発ビルドをインストールする。再起動時は `pnpm --filter @sports-motion/mobile run start --dev-client` を実行する。ブラウザでシェルを確認する場合は `pnpm --filter @sports-motion/mobile run start --web` を使う。

起動時はランニングのデモ試技を表示する。実データの検証では、`SportsMotionApp` に撮影キュー、対象試技の編集・比較コントローラー、選手の共有同意および認証済みの `WalkingSkeletonMobileClient` を設定する。対象の解析版とエビデンス版を控えてから次の順に進む。

| 画面 | 操作 |
| --- | --- |
| 撮影（`CaptureScreen`） | 3動作と1／2カメラを選択し、端末再起動後に保存済み `capture_id` とキュー状態を確認する。 |
| 座標修正（`EditingStudioScreen`） | 異常フレームを選択し、ルーペ、左右修正、補間、Undo／Redo、保存後の再計算表示を確認する。 |
| 比較（`ComparisonScreen`） | 同期スクラブと再生速度を確認する。コーチから研究者に切り替え、出典と解析条件が表示され、注意文が両方に残ることを確認する。 |
| チーム（`TeamDashboardScreen`） | 選手の試技と推移を確認する。研究者モードで CSV／MOT を出力し、未校正試技の TRC が無効になることを確認する。 |
| 共有（`ShareScreen`） | 同意なしで発行できないことを確認する。同意済み選手で期限を選び、固定された解析版・エビデンス版、サマリーカード、LINE 共有を確認する。 |

| 確認項目 | iOS | Android |
| --- | --- | --- |
| 同じ短い試技を校正済みの 2 視点で撮影または選択する。240 fps と 60 fps の入力で、保存後のフレームレート、フレーム数、両視点の同期を記録する。 | [ ] | [ ] |
| 機内モードで試技を保存する。アプリを強制終了してオフラインのまま再起動し、同じ `capture_id` とキュー状態が復旧することを確認する。再接続後、アップロードと解析が一度分だけ確定することを確認する。 | [ ] | [ ] |
| API 経由で Python Motion Engine の解析を完了する。`CalibratedWorld3D`、`is_metric_calibrated: true`、解析版 ID を記録し、端末上の 3D プレビューで骨格とフレーム移動を確認する。 | [ ] | [ ] |
| 署名付き URL を LINE で送信する。受信側のトーク画面で OGP プレビューを確認し、LINE アプリ内ブラウザで初期表示が 3 秒未満、非診断の注意文が表示され、回転とスクラブが動作することを確認する。骨格とグラフのずれは 1 フレーム以内とする。 | [ ] | [ ] |
| 改変したトークンと期限切れの URL を LINE で開き、どちらも 404 になりレポートが表示されないことを確認する。 | [ ] | [ ] |

### 証跡ログ

署名トークンや選手の個人情報をログや画面録画の共有前にマスクする。

| OS・端末 | OS・Expo ビルド・LINE 版 | 日付・回線 | 素材 ID・fps・フレーム数 | capture ID・解析版 | 初期表示 ms・最大ずれ | 結果・ログ／録画 |
| --- | --- | --- | --- | --- | --- | --- |
| iOS | — | — | — | — | — | 実機実施待ち |
| Android | — | — | — | — | — | 実機実施待ち |

`pnpm run test:walking-skeleton-e2e` は合成 60 fps の 2 視点素材を使い、モバイルクライアントから実 API・Python・SSR を通して、390 × 844 の Chromium で 3D 描画、同期、OGP、非診断表示、改変トークンの拒否を確認する。初期表示時間と同期差は CI の `walking-skeleton-e2e` ログに出力される。撮影、キュー復旧、実際の LINE WebView は上の実機手順で検証する。[自動 E2E](../scripts/test-walking-skeleton-e2e.mjs) · [CI](../.github/workflows/ci.yml)
