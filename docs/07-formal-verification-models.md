# 形式・機械的検証の対象モデル

Phase 1 の Gate 1 では下記の検証契約を確定する。Phase 2 の [#28](https://github.com/manabukosaka/sports-motion-app/issues/28) では、モデルに加えて実装の公開境界をテストし、Gate 2 の必須 CI に組み込む。[開発プロセス](./03-development-process.md) · [ADR-0004](./adr/0004-formal-mechanical-verification.md)

## 1. 試技・座標編集の状態遷移

### 状態と冪等性キー

同期・解析、編集セッション、リンクごとの共有を独立した状態として持つ。`EditingCoords` の間も解析の試行は進み、既存リンクは発行時の結果を参照する。

| キー | 一意性と再送時の処理 |
| :--- | :--- |
| `capture_id` | 端末が撮影時に採番し、契約版変換後も保持する。`(team_id, capture_id)` に対する Trial は高々1件。同じ撮影内容の再送には同じ Trial と受領 ACK を返し、異なる内容でのキー再利用は拒否する。 |
| `revision_id` | 試技内の編集・Undo・Redo 操作のキー。初回は不変の `CoordinateRevision` を追記し、同じ操作の再送には既存の版を返す。キーの照合を現在版の比較より先に行い、異なる操作での再利用は拒否する。確定した版の ID を `coordinate_revision_id` として参照する。 |
| `analysis_job_id` | 試技と固定入力に対応する論理ジョブのキー。初回解析は動画、再計算は Raw 観測を入力とし、各ジョブに `coordinate_revision_id`、校正、パイプライン・モデル・フィルタの版と設定を固定する。再試行ではキーと固定入力を再利用し、試行番号だけを進める。成功時の不変 `AnalysisRevision` はジョブごとに決定的な ID を持つ。 |

### 遷移

| 遷移 | ガードと効果 |
| :--- | :--- |
| 初期 → `LocalCaptured` → `QueuedOffline` | 動画と `capture_id`、撮影時の `contract_version` を端末に永続化し、送信項目を登録する。再起動時は永続化済みの未登録項目を同じキーで回収する。 |
| `QueuedOffline` → `Uploading` | 接続済みで送信可能な契約版を使える。アプリ更新待ちや接続断ではキュー内で待ち、契約版変換後も同じ撮影を再送する。 |
| `Uploading` → `Uploaded` | サーバーが動画、Trial、初回解析の予約を永続化した後、対応するチーム・撮影キー・Trial の受領 ACK を発行する。端末は照合済み ACK を永続化してから送信項目を取り除ける。 |
| `Uploaded` → `AnalysisQueued` → `Analyzing` | 永続化済みの予約を固定入力でキューに載せ、ワーカーが有効な試行番号を取得する。初回解析は編集差分なしの座標版を使う。 |
| `Analyzed` → `AnalysisQueued` | 解析条件の変更で固定入力が異なる場合は、新しいジョブを登録する。過去の `AnalysisRevision` は保持する。 |
| `Analyzed` / `Recalculating` → `EditingCoords` | 編集権限があり、現在の確定版を編集の基点として取得できる。編集セッションを開いても、実行中の再計算は継続する。 |
| `EditingCoords` → `Recalculating` | `expected_head == current_head` の場合に限り、編集・Undo・Redo の版の追記、現在版の更新、固定入力の再計算予約を原子的に行う。競合は拒否して現在版を返す。編集の破棄は確定版を保ったままセッションを閉じる。 |
| `Analyzing` / `Recalculating` → `Analyzed` | 有効な試行番号、現在の `analysis_job_id`、計算開始時の座標版が確定時にも一致する場合のみ、不変の `AnalysisRevision` を確定して現在結果を更新する。確認と更新は原子的に行う。未確定の編集内容は確定結果に混ぜない。 |
| `Uploading` / `Uploaded` / `AnalysisQueued` / `Analyzing` / `Recalculating` → `FailedRetryable` / `FailedTerminal` | 一時障害・タイムアウトは残り試行があれば `FailedRetryable`、恒久障害・試行上限到達は `FailedTerminal`。後継ジョブがある旧ジョブは `FailedTerminal`（後継に置換済み）とし、試技の現在状態を書き換えない。失効した試行の遅延完了も反映しない。 |
| `FailedRetryable` → `Uploading` / `AnalysisQueued` / `Recalculating` | 待機時間経過、実行可能条件、有限の試行上限を確認し、対応する経路を同じキーで再試行する。送信再開の前提が欠ける場合は `QueuedOffline` で待つ。`FailedTerminal` からの自動再試行は行わず、未 ACK の撮影は保持する。 |
| 未発行 → `ShareActive` | 発行権限と共有条件を満たし、確定済みの解析版に対応する同じ試技のエビデンススナップショットを指定する。推測困難なリンク ID を発行し、参照先と期限を固定する。 |
| `ShareActive` → `ShareRevoked` / `ShareExpired` | 権限のある取り消し、または `now >= expires_at` で閲覧を拒否する。終端から再有効化する遷移はなく、再共有は別リンクを発行する。 |

### 検証する性質

- **S1 データ消失防止**。`remove_from_queue(c) ⇒ persisted_matching_ack(c)`。ACK が失われた場合、アプリ更新、端末再起動、失敗状態を経ても動画と送信項目を復元できる。
- **S2 Raw の不変性**。編集前後で Raw のバイト列と既存リビジョンは同一。編集、Undo、Redo は新しい `CoordinateRevision` を追記する。Undo は操作履歴上の一つ前、Redo は直前の Undo で戻した位置の有効座標を復元する。Undo 後の新規編集で Redo の操作経路を閉じ、既存の版は保持する。
- **S3 編集と再計算の競合防止**。現在結果の公開時は `result.coordinate_revision_id == job.coordinate_revision_id == current_head`。`current_head` の版番号は Undo/Redo を含む全確定操作で単調増加する。新しい編集の確定後に旧結果を読む場合は、元の版の履歴としてのみ返す。
- **S4 再試行の冪等性**。同じ撮影キーの Trial と同じ論理ジョブの `AnalysisRevision` は各々高々1件。重複登録、ACK 消失後の再送、完了イベントの再配信でも件数・結果・版の対応が変わらない。
- **L1 有界進行性**。有効な送信試行は `Uploaded` または `Failed*` に、有効な解析・再計算の試行は `Analyzed` または `Failed*` に到達する。`Failed*` は `FailedRetryable` と `FailedTerminal` を指す。前提は、単調な仮想時計が進み、公平なスケジューラが期限処理を1周期以内に実行すること。解析の予約からワーカー取得までと、取得後の実行の両方に期限を設ける。検査上限は、送信では送信期限、解析・再計算では待ち行列期限と実行期限の和に、それぞれ1周期を加えた値とする。接続・アプリ更新待ち、未確定の対話編集、再試行の待機は試行開始前とする。

FSM の有限モデルを幅優先で探索し、同じイベント列を同期・ジョブ・編集の公開境界に再生する。少なくとも2撮影、同一試技の2編集者、2座標版の再計算、同一ジョブの2試行を区別する。ACK 消失、契約版移行、再起動、重複・順序逆転・タイムアウト後の完了、再計算中の失効／期限切れを含め、反例にはイベント列と仮想時刻を残す。

## 2. 幾何・物理・信号処理の不変条件

浮動小数点の合成フィクスチャは `float64` を用いる。原点・軸・視点・単位、および校正・モデル・パイプライン・フィルタの識別子は契約で保持する。[ADR-0002](./adr/0002-3d-motion-engine-selection.md) · [ADR-0003](./adr/0003-versioning-strategy.md)

- **G1 座標往復**。同じ時刻の真値 $X$ を校正済み `World3D`（m）から2台の `Camera3D`（m）に変換し、それぞれ `Undistorted Image2D`（px）へ投影する。補正後の投影モデルと両視点の観測を使って三角測量した $\hat X$ に対し、全点で $\lVert\hat X-X\rVert_2 < 10^{-6}\,\mathrm{m}$。無ノイズ・前方可視・非退化な点を生成する（深度 1–10 m、視線間角の正弦 ≥ 0.05）。退化入力は棄却または理由付き欠測とする。無ノイズ閾値の根拠は Spike 1a の合成2カメラ検証（seed `35`、`pytest spikes/spike-1a-dlt/test_invariants.py`、13件成功）。[Spike 1a 実測結果](https://github.com/manabukosaka/sports-motion-app/issues/35#issuecomment-7018942109)
- **G2 SO(3) と剛体リンク**。算出された全セグメントの回転行列 $R$ について、$R^\mathsf{T}R-I$ の全要素の絶対値と $\lvert\det R-1\rvert$ はそれぞれ $10^{-9}$ 以下。単位四元数 $q$ は $\lvert\lVert q\rVert_2-1\rvert\le 10^{-9}$。行列・四元数の許容差は無次元。既知の長さを持つ合成剛体リンク（0.1–2 m）の両端に同一の剛体変換を適用し、各フレームの長さが真値と $10^{-9}\,\mathrm{m}$ 以内で一致することも検証する。
- **G3 単位と座標系の型安全性**。加減算、距離計算、座標の代入は、期待する単位・座標系・必要な視点が一致する場合に限る。`deg` と `rad`、`m` と `px`、`HipRelative3D` と `CalibratedWorld3D` の混在を型検査とデシリアライズ境界で拒否する。明示的な変換には対応する単位変換、校正または投影モデルを要求する。腰中心の推定座標への単位ラベル付け替えだけで校正済み座標には変換できない。
- **G4 ゼロ位相フィルタ**。4次 Butterworth ローパスを `filtfilt` で往復適用する。等間隔の合成フィクスチャは中央 $k$ に単一最大値を持つ左右対称の raised-cosine パルス（振幅 $A$ は 0.25–1 m、半幅 6–24 フレーム、両端に各256フレームのゼロ区間、カットオフとサンプル周波数の比 $f_c/f_s$ は 0.05–0.20）。$\lvert y_{k-j}-y_{k+j}\rvert/A\le 10^{-9}$、最大値のフレーム差は厳密に0、全出力は有限で入力と同じ単位。フィルタのパディング条件を満たさない短系列は明示的に拒否するか理由付き欠測を返す。[Spike 1a 実測結果](https://github.com/manabukosaka/sports-motion-app/issues/35#issuecomment-7018942109)
- **G5 時間微分とイベント正規化の順序**。速度 $v=dx/dt$（m/s）と角速度 $\omega=d\theta/dt$（rad/s、表示時は明示変換で deg/s）は、単調増加する撮影時刻の $\Delta t$（秒）で計算する。その後、開始・終了イベント $t_0<t_1$ に対して $p=100(t-t_0)/(t_1-t_0)$ を計算し、指標を 0–100% 軸に線形補間する。非等間隔時刻の線形軌跡と線形角変位で解析解を参照し、速度・角速度はそれぞれ $10^{-9}$ m/s、$10^{-9}$ rad/s 以内で一致する。同じ変位・角変位で継続時間が2倍なら、同じ $p$ で速度・角速度は半分になる。微分の入力境界はパーセント軸、重複・逆順の時刻を拒否し、正規化は長さ0のイベント区間を拒否する。
- **G6 座標編集の可逆性と決定性**。Undo 後の新しい版 $U$ に対し $\operatorname{apply}(raw,U)=\operatorname{apply}(raw,rev_{k-1})$。Redo 後は $rev_k$ と同じ有効座標・欠測状態に戻る。同じ Raw、座標版、校正、`pipeline_version`、フィルタ仕様（モデルハッシュ・設定・実行環境も固定）を独立に再計算し、指標値・単位・欠測理由の完全一致を検証する。計算入力と比較する指標に紐付く出典の識別子を証跡に残す。

## 3. マルチテナント・LINE 共有認可

### 許可行列

`R` は個別参照、`L` は一覧、`W` はチーム・プロフィールの更新または試技の登録、`S` は共有リンクの発行・取り消し。空欄相当の `—` と未定義の組合せは拒否する。解析版とスナップショットの生成は許可済み操作からサーバーが追記する。不変レコードへの直接書き込みは全主体で拒否する。

| 主体 | `Team` | `AthleteProfile` | `TrialVideo` | `AnalysisRevision` | `EvidenceSnapshot` | `ShareLink` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `OrgAdmin` | R/L/W | R/L/W | R/L/W | R/L | R/L | R/L/S |
| `Coach` | R | R/L | R/L/W | R/L | R/L | R/L/S |
| `Athlete` | R | R（本人） | R/L/W（本人） | R/L（本人） | R/L（本人） | — |
| `Guardian` | — | R（紐付け選手） | R（紐付け選手） | R（紐付け選手） | R（紐付け選手） | — |
| `AnonymousShareViewer` | — | — | — | R（固定版） | R（固定版） | — |
| `Unauthenticated` | — | — | — | — | — | — |

組織管理者を含む認証主体の権限は、サーバーが確認した有効なチーム権限に限定する。一覧はチームと主体の範囲で行・件数を絞る。保護者閲覧は有効化済みで、同じチーム内の選手との閲覧関係が有効な場合に限る。共有の発行には対象の解析版とスナップショットの閲覧権限および共有同意を要求する。

### 検証する性質

- **A1 テナント分離**。チーム A として認可を受けた主体に対し、チーム B のリソースへの `R/L/W/S` は常に拒否する。リソースと親の所属は永続データで照合する。存在する別チーム ID、パス・クエリ・本文の組合せ、別チームの親子参照を与えても、結果や件数の漏えい、更新、リンク発行・取り消しが生じない。
- **A2 トークンの能力境界**。匿名共有経路の `R` は、トークンの暗号署名が有効で、署名対象の `(share_link_id, team_id, analysis_revision_id, evidence_snapshot_id, expires_at)` が保存済みの固定値と一致し、`now < expires_at` かつ未取り消しの場合に限り許可する。トークンの欠落・改変、期限到達・失効、指定先 ID と固定値の不一致は拒否する。有効なトークンでも固定の組だけを共有ビュー経由で読める。チーム API でのトークン利用、直接の `TrialVideo` 参照、他試技や名簿の一覧、書き込みは拒否する。共有用の同期映像などを返す場合も固定解析版の共有ビューに束縛し、各取得時に同じ条件を確認する。追加の閲覧条件が設定された共有は、その条件も満たす必要がある。
- **A3 共有時点の固定**。同一の有効リンクを解析の再実行・Evidence Registry の更新・契約版の移行の前後で取得し、固定した解析版 ID、スナップショットの内容、`evidence_registry_version`、比較結果が一致する。発行時と読み取り時に `non_diagnostic_flag == true` を要求し、画面には固定した非診断の注意文を表示する。[ADR-0003](./adr/0003-versioning-strategy.md) · [Evidence Registry スキーマ](./evidence/evidence-record.schema.json)

認可検証器は2チーム（同一組織内と組織をまたぐ場合）、本人・他人・紐付けの有無、全主体・リソース・操作、ID の一致・不一致、署名の有効・無効・欠落、期限の直前・一致・直後、失効の有無を有限集合として全列挙する。期待値は上の行列とガードから求め、実 API の個別・一覧・書き込み・共有経路の判定と結果に照合する。期限と失効は再取得でも検証する。

## Phase 2 CI 対応表（#28）

以下の3チェックを `main` の必須ステータスに設定する。対応する性質の失敗、検査の未実行、検証器自体の異常終了はマージを止める。反例には性質 ID と、イベント列・縮小済み入力と seed・失敗した認可条件のうち該当するものを記録する。

| 性質 | 検証ツール | 失敗条件 | Gate 2 必須チェック |
| :--- | :--- | :--- | :--- |
| S1 | TypeScript 有限状態機械＋モデルベーステスト（MBT） | 一致する永続 ACK 前に送信項目または撮影を失う | `verify-lifecycle` がマージをブロック |
| S2 | TypeScript FSM＋MBT | Raw／既存版への書き込み、追記の欠落、Undo/Redo の復元失敗 | `verify-lifecycle` がマージをブロック |
| S3 | TypeScript FSM＋MBT | 失効済み試行・旧ジョブの結果を現在結果として公開、または座標版の不一致 | `verify-lifecycle` がマージをブロック |
| S4 | TypeScript FSM＋MBT | 同じキーで重複生成、同じ要求に異なる結果、異なる要求のキー衝突を受理 | `verify-lifecycle` がマージをブロック |
| L1 | TypeScript FSM の全到達状態探索＋仮想時計 MBT | 公平性と時刻の前提下で、活性試行の行き止まりまたは検査上限超過 | `verify-lifecycle` がマージをブロック |
| G1 | Python Hypothesis | 無ノイズ有効点で誤差 ≥ `1e-6 m`、または退化入力が有効結果になる | `verify-geometry` がマージをブロック |
| G2 | Python Hypothesis | 直交性・行列式・四元数ノルム・剛体リンク長のいずれかが許容差を超える | `verify-geometry` がマージをブロック |
| G3 | TypeScript `tsc --strict` の型テスト＋fast-check の契約テスト | 禁止された単位・座標系・視点の組合せを型または公開入力境界が受理 | `verify-geometry` がマージをブロック |
| G4 | Python Hypothesis | ピークずれ、対称性の許容差超過、非有限値、または処理不能な短系列を有効結果として返す | `verify-geometry` がマージをブロック |
| G5 | Python Hypothesis | 実秒の解析解／継続時間の比と不一致、またはパーセント軸・不正な時刻を受理 | `verify-geometry` がマージをブロック |
| G6 | Python Hypothesis | Undo/Redo の有効座標・欠測状態、または同一入力の指標が不一致 | `verify-geometry` がマージをブロック |
| A1 | TypeScript 全列挙ポリシー検証器＋API 契約テスト | 別テナントへの許可、一覧・件数の漏えい、または拒否すべき操作に副作用 | `verify-access-policy` がマージをブロック |
| A2 | TypeScript 全列挙ポリシー検証器＋API 契約テスト | 無効トークンを許可、有効な固定組を拒否、または固定組以外へのアクセスを許可 | `verify-access-policy` がマージをブロック |
| A3 | TypeScript 全列挙ポリシー検証器＋Playwright | 固定データの差し替え、フラグ欠落・偽の受理、または非診断表示の欠落 | `verify-access-policy` がマージをブロック |

Quint による状態探索と Z3 による代数検査は、上記の反例解析に必要な場合に追加できる。必須チェックは有限モデルの範囲、合成入力の前提、公開境界での観測を証跡として残す。
