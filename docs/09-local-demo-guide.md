# ローカル全スタックデモ

Node.js 22 以上、pnpm 10、uv、Python 3.12 以上を用意します。Python 環境は既定で OS の一時ディレクトリに作成されます。外部データベースやクラウドアカウントは不要です。

リポジトリのルートで実行します。

```sh
pnpm install --frozen-lockfile
pnpm run dev:demo
```

PowerShell で `pnpm` の実行が制限されている場合は `pnpm.cmd` を使います。初回は TypeScript のビルド、Expo Web の書き出し、Python 環境のセットアップが行われます。API が合成ランニング試技2本を校正済み2カメラの入力から3D解析し、共有リンクを発行してから起動情報を表示します。

| 起動時に表示する URL | 確認できる内容 |
| --- | --- |
| Mobile Web（既定 `http://127.0.0.1:4030/`） | Capture（撮影）、Editing（編集）、Comparison（比較）、TeamDashboard（チーム）、Share（共有）の5画面。Expo の内蔵デモデータで操作できます。 |
| Share Web 3D（`/share/<id>?token=…`） | 署名付きリンクで3D骨格ビューアとキネマティクスレポートを開きます。 |
| LINE SVG Card（`/share/<id>/card.svg?token=…`） | 1200 × 630 の共有用サマリーカードを表示します。 |
| Compare Trials（既定 `http://127.0.0.1:4020/demo/compare`） | 接地イベントで正規化された2試技の波形を注釈とコメント付きで比較できます。 |
| API Trial（既定 `http://127.0.0.1:4010/teams/demo-team/trials/demo-run-current`） | 起動時に表示された Bearer トークンで試技 JSON を取得できます。 |

```sh
curl -H "Authorization: Bearer <表示されたトークン>" http://127.0.0.1:4010/teams/demo-team/trials/demo-run-current
```

PowerShell では `curl.exe` を使います。各サーバーは `127.0.0.1` で待ち受けます。分析結果はコーチングと動作分析の支援向けです。終了するには `Ctrl+C` を押すか、`quit` と入力して Enter を押します。

## 起動オプション

例 `pnpm run dev:demo --state-dir ./demo-state --port-mobile 4130`

| オプション | 動作 |
| --- | --- |
| `--port-api <n>`、`--port-share <n>`、`--port-mobile <n>` | API・共有 Web・モバイル Web のポートを指定します。既定は順に `4010`、`4020`、`4030` です。 |
| `--ephemeral-ports` | 3つのポートを OS に割り当てさせます。 |
| `--state-dir <path>` | 指定先に状態を保存し、次回起動時に再利用します。Bearer トークンと共有リンクは起動ごとに発行され、その実行中に使えます。省略時は終了時に一時状態を削除します。 |
| `--json-ready` | 起動完了時に `DEMO_READY_JSON=…` を標準出力に1行出します。 |
| `--no-build` | TypeScript のビルド確認を省略します。事前に `pnpm -r run build` を済ませてください。 |
| `--rebuild-mobile` | `apps/mobile/dist/index.html` が存在しても Expo Web を再エクスポートします。 |

## スモークテスト

```sh
pnpm run test:dev-demo
```

API の認証、共有リンクと改ざん拒否、比較画面、Expo Web の HTML と JavaScript、`quit` 後の終了コードと一時状態の削除を検証します。
