# AGENTS.md

本リポジトリは **スマートフォン向け3次元動作解析・コーチング支援アプリ** の開発プロジェクトである。
すべてのAIエージェントは **Lauren Tan（`@poteto` / `pstack`）** のエージェント駆動開発手法に基づき、**「信頼が先、並列化は後（Trust First, Parallelism Second）」** および **「実行時検証を第一級とする（Evidence before confidence）」** を徹底して作業する。

## 必須参照ドキュメント（Single Source of Truth）
- 競合調査・差別化戦略: `docs/01-competitive-analysis.md`
- プロダクトデザイン仕様: `docs/02-product-design.md`
- 開発プロセス・品質ゲート: `docs/03-development-process.md`
- エージェントハーネス設計: `docs/04-agent-harness-design.md`
- 行動原則・ドメイン不変条件: `.agent/rules/principles.md`
- タスク別プレイブック: `.agent/playbooks/README.md`

## 標準実行ループ（必須）
コード変更・設計変更を行うすべてのタスクは、以下のループに従う。検証に失敗した場合は自動で修正へ戻る。

```text
0. Track     : 対応する GitHub Issue を確認し、大きければ GitHub Sub-issues で Verifiable Units へ分解。対象 Issue/Sub-issue の Project ステータスを In Progress に更新し、`scripts/worktree.ps1 start` で専用 Worktree & ブランチを作成する。
1. Plan      : 問題を自分の言葉で整理し、対象プレイブックを選択。境界・型・検証方法を先に決める。
2. Implement : Laziness Protocol に従い、対象 Worktree 上で最小限かつ検証可能な単位を実装する（主実行役: `codex exec -m gpt-6.2-sol`）。
3. Review    : 自己または別視点エージェントで批判的レビュー（物理破綻・境界違反・Slop除去）。
4. Verify    : 静的チェックだけでなく、実実行・テスト・Evalで動作と数値を証明し、PR作成（`Closes #<num>` + 証跡テーブル）・マージ後に `scripts/worktree.ps1 finish` で Worktree を整理、Project ステータスを更新する。
```

## エージェント役割分担（マルチエージェント運用）
- **Orchestrator / Architect / Reviewer**: 設計・仕様策定・GitHub Projects/Issues/Sub-issues管理・タスク分割・Worktree割り当て・批判的レビュー・最終品質ゲート判定を担う。
- **Implementation Worker（手を動かす実行役）**: ローカルの **Codex CLI（`codex exec -m gpt-6.2-sol`）** を実装・プロトタイプ作成・テスト実装・リファクタリングの主実行役として活用する。
  - Worktree 作成＆実行例（非対話時は必ずパイプ経由でstdinを閉じる）:
    1. `powershell -File scripts/worktree.ps1 start -Issue <num> -Type feat -Slug <slug>`
    2. `"<明確なIntent・境界・検証コマンド>" | codex exec -m gpt-6.2-sol -s workspace-write -C "<worktree-path>" -`
  - 実装後は必ず独立レビュー（`codex exec review` または別視点レビュー）および実測検証（Prove It Works）を行う。

## プロジェクトマネジメント（GitHub Projects / Issues / Sub-issues / Worktree）
- タスク管理の Single Source of Truth は GitHub リポジトリ `manabukosaka/sports-motion-app` の **Milestones / Issues / Sub-issues / GitHub Project（`Sports Motion App Roadmap`）** とする。
- 作業工程は GitHub ネイティブの **Sub-issues**（`POST /repos/manabukosaka/sports-motion-app/issues/{parent}/sub_issues`）で親子構造化し、1 Sub-issue = 1 Worktree = 1 PR（Verifiable Unit）を基本とする。
- ブランチ戦略は **Trunk-Based Development**（短命ブランチ `<type>/<issue>-<slug>`、Squash Merge、Spikeブランチは `main` 非マージ）。
- PR作成時は `.github/pull_request_template.md` に従い `Closes #<issue>` と実行時証跡を必ず添付する。

## 絶対ルール（要約）
- **Prove It Works**: コンパイル通過や推測で完了宣言しない。実測コマンド出力・Eval比較表・実行時証跡を必ず提示する。
- **Inverted Pyramid of Trust**: 制約を自然言語メモに逃げず、型・スキーマ契約・Lint・決定論的テスト・Evalへ押し下げる。
- **Fix Root Causes & Upgrade Harness**: バグ修正時は必ず修正前に失敗する再現テストを書き、再発防止制約をハーネスへ昇格させる。
- **No Slop / No Unnecessary Comments**: 冗長な説明コメント、デッドコード、スコープ外の過剰抽象化を入れない。
- **Physical & Biomechanical Invariants**: 物理単位（rad/deg, m/px）と座標系（World/Camera/Image）を素の数値で混在させない。エビデンス数値には必ず出典メタデータを紐付ける。
- **No Unchecked Parallelism**: 現在の Trust Level（`docs/04-agent-harness-design.md` §3）を超えた無秩序な並列実装を行わない。

## 現在の開発フェーズ
- **現在地**: Phase 0（価値探索）完了準備 → Phase 1（プロダクト設計・技術検証Spike）移行前
- **現在の Trust Level**: Level 0（Supervised）
- **次の必須マイルストーン**: Phase 0 のユーザー検証/対象競技確定、および Phase 1 の技術検証Spike（3D解析ベイクオフ・座標編集UX・LINE共有ビューア）とADR作成
