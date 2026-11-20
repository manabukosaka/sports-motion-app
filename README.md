# Sports Motion App（スマートフォン向け3次元動作解析・コーチング支援アプリ）

スマートフォンのカメラ動画から **3次元動作解析・キネマティクス分析** を行い、**最新文献エビデンスとの統計比較**、**手動座標編集（Human-in-the-Loop）**、**チーム/選手パフォーマンス管理**、および **LINE等でのワンタップレポート共有** を一貫して提供するモバイルアプリケーション開発プロジェクト。

## ドキュメント索引

| ドキュメント | 内容 |
| :--- | :--- |
| [01-competitive-analysis.md](./docs/01-competitive-analysis.md) | 国内外の競合アプリ・研究ツール調査、機能比較マトリクス、市場ギャップと差別化戦略 |
| [02-product-design.md](./docs/02-product-design.md) | プロダクトビジョン、ペルソナ、5本柱の機能設計、ユーザージャーニー、システムアーキテクチャ構想、段階的スコープ |
| [03-development-process.md](./docs/03-development-process.md) | 小規模開発における価値探索（Phase 0）〜リリース（Phase 5）の工程定義と定量品質ゲート（Exit Criteria） |
| [04-agent-harness-design.md](./docs/04-agent-harness-design.md) | Lauren Tan（`@poteto` / `pstack`）手法に基づくエージェント駆動開発ハーネス設計 |
| [05-mvp-sports-and-validation.md](./docs/05-mvp-sports-and-validation.md) | V1.0 対象動作、計測・撮影仕様、現場検証とモバイル技術スタックの作業仮説 |
| [06-evidence-literature-catalog.md](./docs/06-evidence-literature-catalog.md) | 26件の査読文献、MVP指標との対応、統計比較方針と規範値の抽出手順 |
| [07-formal-verification-models.md](./docs/07-formal-verification-models.md) | 試技・座標編集の状態遷移、幾何・物理不変条件、テナント・LINE共有認可と Phase 2 CI |
| [ADR 索引](./docs/adr/README.md) | アーキテクチャ決定記録と記載テンプレート |
| [ADR-0006](./docs/adr/0006-tech-stack-and-contracts.md) | 技術スタックと共有データ契約 |
| [packages/contracts/](./packages/contracts/) | 共有 JSON Schema と検証用フィクスチャ |

## エージェント駆動開発ハーネス

本リポジトリはエージェント駆動開発を前提に設計されている。作業前に以下を参照すること：
- エントリポイント: [AGENTS.md](./AGENTS.md)
- 行動原則・ドメイン不変条件: [.agent/rules/principles.md](./.agent/rules/principles.md)
- タスク別プレイブック: [.agent/playbooks/README.md](./.agent/playbooks/README.md)

## プロジェクト管理（GitHub Projects / Issues / Milestones）
- Roadmap Board: [Sports Motion App Roadmap](https://github.com/users/manabukosaka/projects/3)
- Issues & Milestones: [manabukosaka/sports-motion-app/issues](https://github.com/manabukosaka/sports-motion-app/issues) / [milestones](https://github.com/manabukosaka/sports-motion-app/milestones)

## プロジェクト現在地

- **Phase 0（価値探索・課題検証）**: 競合調査・プロダクトデザイン初版・開発プロセス・ハーネス設計を策定済み。
- **Next Action**:
  1. MVP（V1.0）の初期対象競技（2〜3競技）と代表動作の確定
  2. Phase 1 技術検証Spike（3D解析エンジン比較ベイクオフ / モバイル座標編集UX / LINE内ブラウザレポート検証）および技術スタックADRの策定
