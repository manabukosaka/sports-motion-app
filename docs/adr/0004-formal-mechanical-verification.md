# ADR-0004 高リスク領域の形式・機械的検証

## 状態

**Accepted**。関連 Issue [#8](https://github.com/manabukosaka/sports-motion-app/issues/8)、[#25](https://github.com/manabukosaka/sports-motion-app/issues/25)、[#28](https://github.com/manabukosaka/sports-motion-app/issues/28)。

## 背景

ACK 消失や遅延完了による撮影・解析結果の不整合、座標系や時間軸の混同、他チームのデータ開示は、正常系の E2E テストだけでは見つけにくい。[開発プロセス](../03-development-process.md) · [ハーネス設計](../04-agent-harness-design.md)

## 決定

3領域に軽量な検証を適用する。試技・編集・再計算は有限状態機械とモデルベーステスト、幾何・信号処理は型・契約とプロパティベーステスト、マルチテナント・LINE 共有は許可行列の全列挙と公開境界のテストで検証する。全コードベースの定理証明は、モデル保守と実装同期の負担に対し、今回の失敗条件を検出するための投資が大きいため見送る。[対象モデルと CI 対応表](../07-formal-verification-models.md)

## 影響と強制

Gate 1 で検証する性質と入力領域を確定する。Phase 2 の #28 で実装の挙動をモデルと照合し、Gate 2 で必須チェックとして強制する。仕様変更時はモデル・契約・反例フィクスチャを同時に更新する。
