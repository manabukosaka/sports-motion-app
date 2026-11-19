# ADR-0001 ブランチと Issue 連動 Worktree の運用

## 状態

**Accepted**（2026-11-20、関連 Issue [#8](https://github.com/manabukosaka/sports-motion-app/issues/8)、[#22](https://github.com/manabukosaka/sports-motion-app/issues/22)）

## 背景

人間 1〜3 名と AI エージェントで開発する。`gpt-6.2-sol` のワーカーが実装し、オーケストレーターが作業の分割・割り当てと品質ゲートの判定を担う。Lauren Tan の `pstack` に沿って、検証基盤への信頼に応じて並列度を引き上げる。ブランチの長期分岐による統合コスト、生成差分への不要な変更（AI Slop）の混入、使い捨ての Spike コードの `main` への流入を抑える。[開発プロセス §4.5・§5](../03-development-process.md)、[エージェントハーネス設計 §2・§3](../04-agent-harness-design.md)

## 決定

- **Trunk-Based Development** を採用する。`main` を常時グリーンに保ち、変更は短命ブランチから取り込む。長命の `develop` ブランチは設けない。
- **作業単位**は `1 Sub-issue（Verifiable Unit）= 1 隔離 Worktree = 1 短命ブランチ = 1 PR` とする。単体 Issue にも同じ運用を適用する。Orca に登録済みのリポジトリでは、新規ブランチの Worktree を Orca CLI で作成し、GitHub Issue を紐付ける。`-NoOrca`、Orca CLI を利用できない環境、未登録のリポジトリ、既存ローカルブランチの再利用では Git を使い、`../sports-motion-app.worktrees/issue-<num>-<slug>` に配置する。
- **命名**は `<type>/<issue>-<slug>` とする。`<type>` は `feat`、`fix`、`spike`、`harness`、`docs` のいずれか。`start` は slug を小文字化し、ASCII 英数字以外の連続部分を `-` に置換して前後の `-` を除く。
- **統合**は Squash Merge に統一する。各 PR に `Closes #<num>` を記載し、実行した検証コマンドと結果を証跡テーブルに残す。[PR テンプレート](../../.github/pull_request_template.md)
- **Spike** の `spike/<num>-<slug>` ブランチは `main` へのマージを禁止する。知見を `docs/adr/` の ADR やテストフィクスチャに抽出し、成果物用のブランチの PR で取り込む。使い捨てコードは破棄する。

### Worktree のライフサイクル

着手時に GitHub Project の対象 Issue を `In Progress` に更新し、完了時に `Done` にする。Worktree の操作は主チェックアウトのルートで実行する。[scripts/worktree.ps1](../../scripts/worktree.ps1)

| コマンド | 用途 |
| :--- | :--- |
| `./scripts/worktree.ps1 start -Issue <num> -Type <type> -Slug <slug>` | Worktree を作成し、パス、ブランチ名、`ORCA_MANAGED` を出力する。起点は既定で `main`。Orca で作成するときは `-Agent codex` でセッションも起動できる。 |
| `./scripts/worktree.ps1 launch -Issue <num>` | 対象の Orca Worktree にエージェントを起動する。既定は `codex`。パス、エージェント名、Orca が返したセッション ID を出力する。 |
| `./scripts/worktree.ps1 path -Issue <num>` | 対象 Issue の Worktree の絶対パスを取得する。 |
| `./scripts/worktree.ps1 list` | Issue 番号、ブランチ、パス、変更の有無を確認する。 |
| `./scripts/worktree.ps1 finish -Issue <num>` | PR のマージ後または Spike の知見抽出後に、クリーンな Worktree を削除する。Orca の一覧にある Worktree は Orca CLI 経由で削除する。`-DeleteBranch` を付けるとローカルブランチの削除も試みる。 |

`start -Agent` と `launch` では `-Model`、`-Effort`、`-Prompt`、`-Surface chat|terminal` を指定できる。`-Effort` には `-Model` が必要。`-Activate` を付けると Orca で作成した Worktree または起動したセッションを表示する。

Windows では、`finish` は削除対象の Worktree の外から実行する。`-DeleteBranch` の処理を Git が行う場合は既定で `git branch -d` を使う。Squash Merge 後に Git が未マージと判定してブランチが残った場合は、成果物が `main` に取り込まれたことを確認してからローカルブランチを削除する。

## 検討した代替案

- **GitFlow** は見送る。長命ブランチへの二重統合が発生し、並列エージェントの変更が分岐するほど競合解消の負担が増える。
- **`main` への直接コミット** は初期ベースライン確立後の運用として却下する。PR レビューと CI の品質ゲートを経由できず、変更と検証証跡を追いにくい。

## 影響

Sub-issue と Squash Merge 後のコミットが PR で結び付き、変更単位でレビュー・追跡・巻き戻しがしやすくなる。大きな作業は独立に検証できる単位へ分割し、依存する PR の統合順を管理する。

## 検証と強制

Inverted Pyramid of Trust に沿って、命名と Issue 番号の重複作成防止は `worktree.ps1` で機械化する。PR テンプレートに実行時の証跡を記録し、レビューで Issue の紐付け、差分の範囲、Spike コードの隔離を確認する。

Phase 2 で GitHub の `main` ブランチ保護を設定し、PR 経由、必須 CI ゲートの通過、線形履歴を強制し、force push を禁止する。保護の適用後に、直接 push と必須チェック未通過の PR のマージが拒否されることを確認する。
