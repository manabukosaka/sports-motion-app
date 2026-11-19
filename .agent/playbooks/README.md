# Agent Playbooks（タスク種別ルーター ＆ 実行手順書）

Lauren Tan の `pstack` に基づき、タスクの種類に応じて以下から適切なプレイブックを選択して実行する。
すべてのプレイブックは **`Plan ➔ Implement ➔ Review ➔ Verify`** の反復ループに従う。

---

## タスクルーター

| タスク内容 | 適用プレイブック | 完了の必須証跡 |
| :--- | :--- | :--- |
| 新機能・画面・API・解析モジュール追加 | **1. Feature Playbook** | 契約テスト＋単体/E2E検証結果＋実動作証跡 |
| バグ調査・不具合修正 | **2. Bugfix Playbook** | 修正前に失敗した再現テスト＋修正後パス＋ハーネス強化内容 |
| 技術選定・UX分岐の検証 | **3. Prototype (Spike) Playbook** | 定量ベンチマーク結果＋ADR（使い捨てコードは破棄） |
| 3D精度・推論速度・UXレイテンシ改善 | **4. Hillclimb Playbook** | ベースライン対比の数値改善表＋不変条件回帰なし証明 |
| トラッキング/モデリング手法比較 | **5. Eval Bakeoff Playbook** | 同一ゴールデンデータセットでのブラインド比較表＋ライセンス確認 |
| 複数PRに跨る大規模設計・移行 | **6. Multi-Phase Plan Playbook** | 依存グラフ＋各PRのExit Criteria（承認前にコード変更しない） |
| PR提出・リリース前チェック | **7. Shipping Playbook** | 全CI/Eval緑＋`/unslop` 実施＋証跡テーブル |

---

## 各プレイブック手順

### 1. Feature Playbook
0. **Sub-issue & Worktree**: 親 Issue 配下に Verifiable Unit となる Sub-issue を紐付け、`scripts/worktree.ps1 start -Issue <num> -Type feat -Slug <slug>` で専用ワークツリーを作成する。
1. **Intent & Boundary**: 対象ストーリー、変更境界、変更しない範囲（Laziness Protocol）を明記。
2. **Domain & Contract First**: 必要なら `packages/contracts` の型・スキーマを先に定義。
3. **Verifiable Units**: 独立テスト可能な小単位へ分解しタスクリスト化。
4. **TDD / Implementation**: 対象 Worktree 上で振る舞いテストを書き、最小限の実装（`codex exec -m gpt-6.2-sol`）で通す。
5. **Adversarial Review**: エッジケース・単位/座標系ミス・権限漏れ・不要コメントを批判的に点検。
6. **Runtime Verification**: 実環境（シミュレータ/ブラウザ/CLI/Eval）で動作を証明。

### 2. Bugfix Playbook
1. **Explain in Own Words**: 現象・期待挙動・影響範囲を簡潔に言語化。
2. **Trace with Evidence**: 推測せず、エントリポイントからコードとログを追って根本原因を特定。
3. **Reproduce First (Red)**: 修正前に、バグを確実に再現し失敗する自動テストを作成する。
4. **Minimal Root-Cause Fix (Green)**: 根本原因のみを最小差分で修正し、再現テストと既存回帰テストを通す。
5. **Failure-to-Constraint Upgrade**: 再発を防ぐ最も下層の制約（型 > Lint > 回帰テスト/Eval > ルール）を追加する。

### 3. Prototype (Spike) Playbook
1. 机上で議論が割れた設計分岐に対し、検証したい問い（1〜3個）と合否基準を先に定義する。
2. 隔離ディレクトリ（例：`spikes/<topic>/`）で最小限の使い捨てプロトタイプを実装する。
3. 実測データ・操作感・限界を記録し、結論を `docs/adr/` へADRとして保存する。
4. プロトタイプコードは本体へ流用せず削除（またはアーカイブ）し、本番実装はFeature Playbookでクリーンに行う。

### 4. Hillclimb Playbook（精度・性能の反復最適化）
1. **Lock Baseline**: 対象指標（例：関節角度RMSE、再計算レイテンシ）と不変条件（骨長一貫性等）のベースラインを計測・固定する。
2. **One Hypothesis per Iteration**: 1イテレーションにつき1仮説のみ変更する。
3. **Measure & Gate**: 同一データセット・同一環境で再計測。不変条件を1つでも破る変更は指標改善しても即棄却する。
4. **Document & Keep/Revert**: 改善した場合のみ採用し、`Explain the Number` 原則に従い数値と条件を記録する。

### 5. Eval Bakeoff Playbook（モデル・手法比較）
1. 比較候補（例：RTMPose+MotionBERT vs WHAM vs 古典2カメラDLT）を同一インターフェースに適合させる。
2. 合成真値データ＋実撮影ベンチマーク動画の共通セットで一括評価する。
3. 精度（RMSE / r）、推論時間、メモリ/GPUコスト、遮蔽耐性、**商用ライセンス適合性** の比較マトリクスを作成しADR化する。

### 6. Multi-Phase Plan Playbook
1. コードを書く前に、全体目標を複数の独立PR（Verifiable Units）へ分割する。
2. 各PRの「依存関係・対象境界・検証コマンド・Exit Criteria」を一覧化する。
3. 人間の合意を得た後、1単位ずつ Feature Playbook で実行する。

### 7. Shipping Playbook
1. 不要なコメント、デッドコード、デバッグログを除去（`/unslop`）。
2. 全自動ゲート（`typecheck`, `lint`, `unit/contract tests`, `biomech-eval`, 必要に応じE2E）を実行し緑を確認。
3. `.github/pull_request_template.md` に従い `Closes #<issue>` と「Intent & Scope / Verification Commands & Results / Runtime Proof / Harness Upgrade」の証跡テーブルを記載しPRを作成する。
4. PRマージ後に `scripts/worktree.ps1 finish -Issue <num> -DeleteBranch` で Worktree とブランチを整理し、GitHub Issue / Sub-issues / Project（`Sports Motion App Roadmap`）のステータスを更新する。
