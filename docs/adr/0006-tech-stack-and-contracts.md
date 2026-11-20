# ADR-0006 技術スタックと共有データ契約

## Status

**Accepted**（2026-11-20、関連 Issue [#6](https://github.com/manabukosaka/sports-motion-app/issues/6)、[#7](https://github.com/manabukosaka/sports-motion-app/issues/7)、[#8](https://github.com/manabukosaka/sports-motion-app/issues/8)、[#26](https://github.com/manabukosaka/sports-motion-app/issues/26)）

## Context

座標編集、3D 再計算、LINE 共有を複数の実行環境にまたがって提供する。各環境で座標系、単位、欠測、解析版を同じ意味で扱い、発行済みのレポートに当時の解析結果と文献比較を表示できるようにする。[プロダクトデザイン仕様](../02-product-design.md) · [対象動作と計測仕様](../05-mvp-sports-and-validation.md) · [ADR-0003](./0003-versioning-strategy.md)

## Decision

| 境界 | 採用する技術 |
| :--- | :--- |
| モバイルクライアント（iOS／Android） | React Native と Expo の開発ビルドを採用する。240 fps 撮影に必要なネイティブカメラ連携と、ルーペ・骨格オーバーレイの描画性能を Spike #6 の実機で確認する。 |
| LINE 共有 Web ビューア | Next.js の SSR で OGP メタタグを返す。Three.js／WebGL の軽量な 3D 骨格を動画とグラフの再生時刻に同期させる。Spike #7 でモバイルの LINE アプリ内ブラウザにおける初期表示 3 秒以内を確認する。 |
| アプリケーション API・データ | TypeScript の REST API を OpenAPI と JSON Schema で検証する。組織・チーム・選手・試技・リビジョン・共有リンクは PostgreSQL でテナントの境界を保って管理する。動画・3D JSON・要約画像カードは S3 互換のオブジェクトストレージに置き、認可後に署名付き URL を発行する。 |
| 3D 動作解析ワーカー | Python 3.12 以上を uv で管理し、Pydantic の strict モード、NumPy、SciPy、OpenCV を使う。標準構成は Tier A の MediaPipe Pose Landmarker Full とし、研究用プラグインは隔離されたローダーを使う。[ADR-0002](./0002-3d-motion-engine-selection.md) |
| 共有データ契約 | [`packages/contracts/schemas/`](../../packages/contracts/schemas/) の JSON Schema Draft 2020-12 を唯一の定義元とする。Phase 2 で TypeScript の strict／ブランド型と Python の Pydantic strict モデルを同じスキーマから生成し、共通フィクスチャで言語間の往復を検証する。 |

2D 観測は視点ごとの `Image2D`（px）で保持する。編集は `CoordinateRevision` の差分を追記し、Undo／Redo も新しいリビジョンとして確定する。3D は実寸校正済みの `CalibratedWorld3D` と腰中心の推定 `HipRelative3D` を区別する。共有時は解析版・エビデンス版・比較結果・非診断の注意文を固定する。承認済みで比較可能な文献統計がなければ、共有スナップショットの `evidence_comparisons` は空にする。[ADR-0002](./0002-3d-motion-engine-selection.md) · [文献カタログ](../06-evidence-literature-catalog.md)

### 検討した代替案

- **Flutter** は、モバイルと共有 Web で TypeScript の契約型と WebGL 周辺の実装を共有しにくくなるため見送る。
- **初期から Swift と Kotlin でフルネイティブ開発**する案は、小規模チームでクライアントの実装・検証を二重に担うため見送る。
- **Protobuf のみで契約を定義**する案は、JSON Schema と OpenAPI に比べ、研究者によるデータ確認と共有 Web のペイロード調査に手間がかかるため見送る。

## Consequences

モバイル・Web・API・解析ワーカーは、契約とフィクスチャを共有できる。契約版ごとに厳格な検証を行い、同じ MAJOR の将来版を旧クライアントが読む際は、既知のフィールドを取り出す互換読み取り経路を設ける。Expo のネイティブ拡張と LINE の iOS／Android 両環境を継続して検証する。[ADR-0003](./0003-versioning-strategy.md) · [ADR-0005](./0005-testing-strategy.md)

## Verification & Enforcement

- リポジトリルートで `uv run --no-project --with jsonschema python scripts/test-contracts.py` を実行する。Draft 2020-12 のメタスキーマ、正常・異常フィクスチャ、Evidence Registry と初期カタログを検証する。フレーム番号と撮影時刻の単調増加、校正視点の一意性、共有の解析版と日時の整合は検証器で追加確認する。[検証スクリプト](../../scripts/test-contracts.py) · [フィクスチャ](../../packages/contracts/fixtures/)
- スキーマの `$id` をローカルレジストリに登録する。文献の指標・イベント・統計値の定義は既存の Evidence Registry から参照し、`https://sports-motion-app.invalid/evidence/evidence-record.schema.json` にそのファイルを割り当てる。フィクスチャのファイル名は `<契約>.<ケース>.json` または `<契約>.json` とし、契約とスキーマの対応は検証スクリプトの `ENTRY_POINTS` で定める。[Evidence Registry スキーマ](../evidence/evidence-record.schema.json)
- [#27](https://github.com/manabukosaka/sports-motion-app/issues/27) でこの検証コマンドを PR の必須 CI に組み込む。[#28](https://github.com/manabukosaka/sports-motion-app/issues/28) で Raw の不変性、編集競合、テナント分離と共有認可を実装境界で検証する。[#29](https://github.com/manabukosaka/sports-motion-app/issues/29) で再構成・運動学の数値を回帰評価する。[形式・機械的検証モデル](../07-formal-verification-models.md) · [ADR-0005](./0005-testing-strategy.md)
- Phase 2 の基盤を凍結する前に、Spike #6 で候補端末の 240 fps 撮影、ルーペ・オーバーレイの 60 fps 描画、編集の確定から再計算結果の表示まで 5 秒以内を確認する。Spike #7 は iOS／Android の LINE 内で OGP と 3D 描画を確認し、動画・グラフとの同期ずれが 1 フレーム以内、初期表示が 3 秒以内であることを計測する。両 Spike の判定に端末・OS・素材・計測条件を記録する。[計測・検証仕様](../05-mvp-sports-and-validation.md) · [開発プロセス](../03-development-process.md)
