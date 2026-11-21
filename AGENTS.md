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
0. Track     : 対応する GitHub Issue を確認し、大きければ GitHub Sub-issues で Verifiable Units へ分解。対象 Issue/Sub-issue の Project ステータスを In Progress に更新し、`scripts/worktree.ps1 start` で専用 Worktree & ブランチを作成する（Orca IDE では実装 `codex` と独立レビュー/検証 `antigravity` の2セッションを必須とする）。
1. Plan      : 問題を自分の言葉で整理し、対象プレイブックを選択。境界・型・検証方法を先に決める。
2. Implement : Laziness Protocol に従い、対象 Worktree の `codex` セッションで最小限かつ検証可能な単位を実装する（主実行役: `codex exec -m gpt-6.2-sol`）。
3. Review    : 同一 Worktree に紐付けた独立 `antigravity` セッションで批判的レビュー（物理破綻・境界違反・セキュリティ・Slop除去）を行う。
4. Verify    : `antigravity` セッションで静的チェックだけでなく実実行・テスト・Evalによる動作と数値を証明し、PR作成（`Closes #<num>` + 証跡テーブル）・マージ後に `scripts/worktree.ps1 finish` で Worktree を整理、Project ステータスを更新する。
```

## エージェント役割分担（マルチエージェント運用）
- **Orca Worktree 2セッション原則（必須）**: Orca IDE に登録済みのすべての Issue Worktree では、必ず以下の2つの紐付けセッションを稼働させる。
  1. **Implementation Worker（`codex`）**: 実装・プロトタイプ作成・テスト実装・リファクタリングを担う。
     - `./scripts/worktree.ps1 launch -Issue <num> -Agent codex -Model gpt-6.2-sol -Effort high -Activate -Prompt "<明確なIntent・境界・検証コマンド>"`
  2. **Gemini / Antigravity Reviewer & Verifier（`antigravity`）**: 独立批判的レビュー・実行時検証（Prove It Works）・品質ゲート判定を担う。
     - `./scripts/worktree.ps1 launch -Issue <num> -Agent antigravity -Activate -Prompt "<レビュー対象・検証コマンド・完了条件>"`
- **Orchestrator / Architect**: 設計・仕様策定・GitHub Projects/Issues/Sub-issues管理・タスク分割・Worktree割り当て・最終マージ判断を担う。
- **Worktree 作成 / 非Orca フォールバック**:
  - Worktree 新規作成: `./scripts/worktree.ps1 start -Issue <num> -Type feat -Slug <slug> -Agent codex -Model gpt-6.2-sol -Prompt "<明確なIntent・境界・検証コマンド>"`
  - 非Orca 環境では `./scripts/worktree.ps1 start -Issue <num> -Type feat -Slug <slug> -NoOrca` で Worktree を作成し、非対話の Codex CLI は `"<明確なIntent・境界・検証コマンド>" | codex exec -m gpt-6.2-sol -s workspace-write -C "<worktree-path>" -` のようにパイプ経由で stdin を閉じる。
  - 実装完了後は必ず別セッション（`antigravity` / Orchestrator 側）で独立レビューおよび実測検証を行う（実装ワーカー内部からネストして `codex review` を起動しない）。

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
- **現在地**: Phase 3（MVP コア機能開発 V1.0）
- **現在の Trust Level**: Level 2（Bounded Parallel — 境界分離された最大2並列 Worktree、各 Worktree で `codex`＋`antigravity` 2セッション必須）
- **ローカル検証コマンド**（リポジトリルートで実行）
  - `uv run --no-project --with jsonschema python scripts/test-contracts.py`
  - `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-evidence-catalog.ps1`（Windows。Linux では `pwsh -NoProfile -File scripts/test-evidence-catalog.ps1`）
  - `uv run --project services/motion-engine --frozen mypy services/motion-engine/src`
  - `uv run --project services/motion-engine --frozen ruff check services/motion-engine/src evals/biomechanics scripts/test-license-gate.py`
  - `uv run --project services/motion-engine --frozen pytest evals/biomechanics/tests`
  - `uv run --project services/motion-engine --frozen python evals/biomechanics/run_eval.py`
  - `uv run --project services/motion-engine --frozen python scripts/test-license-gate.py --self-test`
  - `pnpm install --frozen-lockfile`（Node.js 22。PowerShell でスクリプト実行が制限されている場合は `pnpm.cmd` を使用）
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `pnpm run check:boundaries`
  - `pnpm run check:boundaries:self-test`
  - `pnpm run test:contracts`
  - `pnpm run test:g3`
  - `pnpm run test:evidence`
  - `pnpm run test:export`
  - `pnpm run test:editing`
  - `pnpm run test:vertical-slice`
  - `pnpm run verify:lifecycle`
  - `pnpm exec playwright install --only-shell chromium`（共有ビュー・Walking Skeleton E2E 検証の初回のみ）
  - `pnpm run verify:access-policy`
  - `pnpm run test:walking-skeleton-e2e`
  - `pnpm run test`
