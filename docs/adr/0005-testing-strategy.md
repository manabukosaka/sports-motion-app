# ADR-0005 5層テスト戦略と実行時検証

## Status

**Accepted**（2026-11-20、関連 Issue [#8](https://github.com/manabukosaka/sports-motion-app/issues/8)、[#23](https://github.com/manabukosaka/sports-motion-app/issues/23)、[#27](https://github.com/manabukosaka/sports-motion-app/issues/27)、[#28](https://github.com/manabukosaka/sports-motion-app/issues/28)、[#29](https://github.com/manabukosaka/sports-motion-app/issues/29)）

## Context

座標軸や物理単位の取り違え、フィルタによるピーク時刻のずれは、3D 表示が正常に見えても計測結果を変える。通常の単体テストだけでは、TypeScript と Python の契約のずれ、商用配布物への未承認の重みや依存物の混入、LINE アプリ内ブラウザの回帰も見逃す。Lauren Tan の Inverted Pyramid of Trust に従って制約を機械強制できる最も下位の層に置き、Prove It Works に従って実行結果と計測値を証跡にする。[ハーネス設計](../04-agent-harness-design.md) · [行動原則](../../.agent/rules/principles.md)

## Decision

[開発プロセス §4.5](../03-development-process.md#45-横断的エンジニアリング戦略検討強制フェーズ対応表) に沿って、以下の5層を採用する。

### Layer 1 静的型・スキーマ・アーキテクチャ境界

- TypeScript の `strict` とブランド型で `deg`／`rad`、`m`／`px`、秒／フレーム番号、World／Camera／Image 座標系を区別する。Python は mypy の strict モードで型を検査し、受信時は Pydantic の strict モードで暗黙の型変換を拒否する。`packages/contracts` の共有 JSON Schema と [Evidence Registry スキーマ](../evidence/evidence-record.schema.json) で境界データと文献出典の必須項目を検証する。
- カスタム境界 Lint でモジュール間の内部実装への直接参照と循環依存を禁止する。CI で商用アプリとサーバーイメージの実配布物を Tier A 許可リストと照合し、コードと推移依存の利用・再配布条件、モデル重みのハッシュ、学習データの権利根拠を確認する。Tier B/C や未承認・証跡不足の成果物があればビルドを拒否する。[ADR-0002](./0002-3d-motion-engine-selection.md)

### Layer 2 振る舞いの単体・プロパティベース・機械的検証

Test Behavior, Not Implementation に従い、公開境界の入出力、状態変化、副作用を検証する。内部関数の呼び出し順や回数に依存するモックテストは禁止する。[行動原則 P8](../../.agent/rules/principles.md)

| 必須チェック | 検証する性質と手段 |
| :--- | :--- |
| `verify-lifecycle` | S1–S4・L1。TypeScript の有限状態機械（FSM）を探索し、モデルベーステスト（MBT）でイベント列を公開境界に再生する。撮影・送信キューの保全、非破壊編集、再計算の競合、再試行の冪等性、有界進行性を検証する。 |
| `verify-geometry` | G1–G6。Python の Hypothesis で座標往復、回転・骨長、ゼロ位相、時間微分、編集と再計算の不変条件を検証する。G3 は TypeScript の型テストと fast-check で単位・座標系・視点の不正な組合せの拒否を検証する。 |
| `verify-access-policy` | A1–A3。TypeScript のポリシー検証器で許可行列とガードの組合せを全列挙し、API でテナント分離とトークン境界、Playwright で公開レポートの固定を照合する。 |

反例には性質 ID と、再現用のイベント列・仮想時刻、縮小済み入力・seed、または失敗した認可条件を記録する。性質ごとの入力領域・許容差・失敗条件は対象モデルに従う。[形式・機械的検証の対象モデル](../07-formal-verification-models.md)

既知の期待値で z スコアとパーセンタイルを単体検証する。Evidence Registry の新バージョンを取り込んでも、保存済みの `evidence_registry_version`、評価済み規範値スナップショット、比較結果が変わらないことを検証する。[ADR-0003](./0003-versioning-strategy.md)

### Layer 3 言語間の契約と後方互換性

- TypeScript（モバイル、共有 Web、API）と Python（Motion Engine）で同一契約版の JSON フィクスチャを共有する。両方向で読み込みと再書き出しを行い、値・単位・座標系・欠測表現を含む JSON のデータ構造が往復前後で一致することを検証する。
- MINOR 更新ごとに、新版の読み手が旧版のペイロードを読めることと、同一 MAJOR の旧版の読み手が新版の未知の任意フィールドを無視し、既存フィールドを同じ意味で読めることを固定フィクスチャで検証する。[ADR-0003](./0003-versioning-strategy.md)
- プラグインの読み込み境界で、必須マニフェストの欠落、ステージ・契約互換版・モデルハッシュ・ライセンス区分の不一致、権利の証跡を伴うライセンス宣誓の欠落を拒否することを検証する。[ADR-0002](./0002-3d-motion-engine-selection.md)

### Layer 4 バイオメカニクス回帰評価（`biomech-eval`）

- Spike 1a の合成3D真値を CI 用の回帰フィクスチャに発展させる。再投影誤差（px）、既知距離の誤差（m）、関節角度 RMSE（deg）、骨長のフレーム間変動、ゼロ位相（ピークのフレーム差）、座標編集後の再計算時間を固定ベースラインと許容差に照合する。[ADR-0002](./0002-3d-motion-engine-selection.md)
- Phase 2／3 では実写スポーツ動画（投球、ランニング、跳躍・着地）を同期した基準計測と比較し、有効率、関節角度の RMSE・相関、速度とイベント時刻の誤差、デコード込みの解析時間を回帰評価する。Explain the Number に従い、データセット名と版、サンプル数、撮影条件、端末または CPU／GPU と実行環境、パイプライン・モデル・設定、再現コマンドを測定値とともに保存する。[計測・検証仕様](../05-mvp-sports-and-validation.md) · [行動原則 P6](../../.agent/rules/principles.md)

### Layer 5 実行時 E2E・現場受入検証

- Playwright のモバイルビューポートで LINE 共有 Web ビューアを開き、3D 描画、動画・グラフ同期（ずれ1フレーム以内）、HTML の OGP タグ、リンクを開いてからレポートの初期表示まで3秒以内、非診断の注意文の表示を検証する。初期表示の証跡にブラウザ・端末プロファイル・回線条件を残す。A3 は、再解析・Evidence Registry 更新・契約版移行の前後で同じ有効リンクを開き、解析版 ID、規範値スナップショット、レジストリ版、比較結果、非診断の注意文の一致を検証する。[開発プロセス](../03-development-process.md) · [形式・機械的検証の対象モデル](../07-formal-verification-models.md)
- API 統合テストでは、別チームへの参照・一覧・更新・共有操作を拒否し、結果や件数の漏えいと副作用がないことを確認する。署名付き共有トークンは有効期限に達した時点と取り消し後の再取得で拒否することを確かめる。[形式・機械的検証の対象モデル](../07-formal-verification-models.md)
- β配信・一般リリース前に iOS／Android 実機で、撮影、オフライン撮影後の再起動・再接続時のキュー復旧、ルーペを使った座標編集と再計算結果への反映をスモークテストする。実機の LINE で OGP プレビューとアプリ内ブラウザの初期表示・3D 描画・同期再生を確認する。端末、OS、アプリ／LINE の版、回線条件、ログまたは画面録画を記録する。

### CI の実行頻度と不安定なテストへの対応

- **全 PR**。Layer 1〜3、Layer 4 の合成 `biomech-eval`、Layer 5 の Web／API を実行する。`main` のブランチ保護で必須チェックに設定し、失敗・未実行・異常終了時はマージを止める。
- **夜間および β配信・一般リリース前**。Layer 4 の実写回帰 Eval と Layer 5 の実機スモーク全件を実行する。配信前は候補ビルドで全件の合格を必須とする。
- **Failure-to-Constraint**。すべてのバグ修正で、まず修正前に失敗する再現テストを追加する（Red）。根本原因の修正後に同じテストを通し（Green）、再発防止を型・スキーマ、境界 Lint、テスト・Eval の順で適用可能な最も下位の層に置く。不安定なテストは即時修正または隔離し、原因と再現条件を記録する。再実行での一時的な通過を合格にせず、必須の性質は決定論的な代替検証が通るか、元のテストを修正して復帰させるまで、該当のマージ・配信を止める。[Failure-to-Constraint Loop](../04-agent-harness-design.md#5-failure-to-constraint-loop失敗をハーネスへ昇格させる仕組み)

### 検討した代替案

- **UI E2E 中心のテストピラミッド**は見送る。実行時間と画面変更への追従コストが大きく、座標変換や信号処理のサイレントバグを検出しにくい。
- **単体テストのカバレッジだけを合格基準にする案**は見送る。高い行カバレッジでも、物理不変条件、言語間の実データ互換性、実機上の動作は証明できない。

## Consequences

型・契約・数値・製品上の振る舞いそれぞれに合否基準が付き、失敗時に調べる境界が分かる。契約版ごとのフィクスチャ、モデルと実装の同期、計測ベースラインと実機環境の維持に運用工数がかかる。

## Verification & Enforcement

| Phase 2 Sub-issue | 実装と証跡 |
| :--- | :--- |
| [#27](https://github.com/manabukosaka/sports-motion-app/issues/27) | 型・境界 Lint・単体・契約の CI を構築し、機械的検証・合成 Eval・Web／API の PR チェックを `main` の必須ステータスに組み込む。CI ログと必須チェック失敗時のマージ拒否を記録する。 |
| [#28](https://github.com/manabukosaka/sports-motion-app/issues/28) | `verify-lifecycle`、`verify-geometry`、`verify-access-policy` を実装し、S1–S4・L1、G1–G6、A1–A3 の検証結果と反例の再現情報を CI に残す。 |
| [#29](https://github.com/manabukosaka/sports-motion-app/issues/29) | `biomech-eval` の合成真値とゴールデンデータによる回帰評価を構築し、基準値・許容差・実測値・測定条件・再現コマンドをレポートに残す。 |

- **Gate 2（Phase 2 の出口）**。PR 必須チェックの自動実行とマージ拒否、3領域の機械的検証、4軸バージョン戦略のスキーマ・出力メタデータへの反映を確認する。iOS／Android 双方で Walking Skeleton（撮影／選択 → 解析 → 3D 表示 → 共有リンク発行）を通し、ログまたは動画を残す。エージェント作業ループの自立（Trust Level 2）も判定する。[開発プロセス Phase 2](../03-development-process.md#phase-2-基盤ハーネス構築--垂直スライスfoundation-harness--walking-skeleton)
- **Gate 3（β移行前）**。MVP 全ストーリーの実機・Web E2E とゴールデンデータの角度・速度回帰全件合格を確認する。座標編集は修正点の反映と骨長・フィルタ制約違反ゼロを確認し、再計算5秒以内の目標を計測する。全エビデンスの出典と統計式、10秒・60 fps の単眼解析 P95（目標60秒以内）、ワーカーのリトライ・エラー表示・オフライン保全を検証する。共有 URL の認可テスト全件合格と、認証・動画署名付き URL・個人情報削除フローのセキュリティ確認を記録する。[開発プロセス Phase 3](../03-development-process.md#phase-3-コア機能開発mvp構築mvp-build--biomechanical-validation)
