# Review guard

Python 3.11以上、外部パッケージ不要。Macでは版を確認した`python3`、Windowsでは`py -3.11`等を使用する。起動時に3.11未満を拒否する。Pythonはレビュー運用の開発ツール用で、製品ランタイムではない。未導入なら別途準備が必要。この変更ではインストールしない。

リポジトリのrootで実行する。方針は[修正前確認](../../docs/review-prevention.md)に従う。

```sh
python3 tools/review_guard/guard.py validate
python3 -m unittest discover -s tools/review_guard/tests -v
python3 -m unittest discover -s .review/tests -v
```

汎用試験は`tools/review_guard/tests`、このrepo固有のルーティング試験は`.review/tests`。別repoへ検査器を移すときは汎用試験だけを同梱し、固有試験は条件・履歴とともにこちらへ残す。

## 計画を作る

予定パスをUTF-8のJSON配列に保存する（例: `["src/infrastructure/storage/root.ts"]`）。renameは旧・新双方を含める。repo相対表記・大小文字を区別する。パターンは`fnmatchcase`で、`*`は`/`も含む。否定・除外パターンは提供しない。

```sh
python3 tools/review_guard/guard.py prepare --paths-file planned-paths.json --base-sha <40文字のbaseSHA> --output .review/plans/T07-storage.json
```

`--output`はUTF-8で新しいファイルを作り、既存ファイルは上書きしない。更新は既存の計画を編集するか、別の一時ファイルへprepareして差分を取り込む。PowerShellの`>`を使わない。標準出力もASCIIエスケープされたJSONなので、旧Windowsのコンソールで日本語のエンコードに失敗しない。入力はUTF-8（BOMありも可）。UTF-16は未対応。

### 書式

| 項目 | 記入内容 |
| --- | --- |
| `schema_version` | `1` |
| `task_id` | 台帳上のID（例: `T07`、`OPS-REVIEW`）。Issue番号はPR/引継ぎに記す |
| `base_sha` | 検討した最新mainの40文字SHA |
| `planned_paths` | このPRの予定パス（削除・rename旧名も含む）。計画自身のパスは省略可 |
| `assessments[].id` | 不変条件ID |
| `disposition` | `preserve`（維持）、`not-applicable`（非該当）、`change-proposed`（条件変更） |
| `reason` | 方針の理由。非該当にも具体的な根拠が必要 |
| `checks` | 各シナリオの`id`、確認方法`method`、独立した期待結果`expected`。実行済み証跡ではない |
| `decision_references` | `change-proposed`では必須の非空配列。ADRのパス、公開できる決定記録のリンク等。参照先の実在・内容・権限は別担当が確認する |
| `conflicts` | 衝突がなければ`[]`。あれば下記の形。未解決ならcheckは失敗する |
| `context` | 読解用の抜粋。判定根拠は指定したcatalog/ledgerなので、更新時は差分も読み直す |

```json
{"description":"設計間の矛盾と影響","state":"resolved","resolution":"採用する整合した方針と根拠"}
```

未解決の衝突は`state: "open"`等で残してよいが、実装前に解決する。条件変更を非該当と偽らない。`change-proposed`は決定参照を付ければ構造検査を通せるが、出力の`decisions_to_review`を別担当が評価する。自己申告の参照は所有者の承認を証明しない。

ファイル名は`<task_id>.json`、同じタスクを複数PRに分けるときは`<task_id>-<part>.json`（例: `T07-storage.json`、`T07-migrations.json`）とする。各PRは自分の計画を1つだけ追加・変更する。local CLIとCIは計画のファイル名が`task_id.json`または`task_id-part.json`に一致することも検査する。CLIの`check`も、複数の計画変更をカバレッジ判定から除外する前に拒否する。変更計画がある場合、`--plan`はそのファイル自身を指す必要があり、同じタスクの別partや別ディレクトリの同名ファイルは拒否する。repo rootを基準に解決した実パスを照合するので、同じファイルの相対・絶対表記は利用できる。変更計画がない場合は既存計画の再検査が可能。CIは変更パスから選んだ計画自身を読み込む。既存の他PRの計画を流用して編集しない。1PRに複数タスクを混在させない。計画の履歴はGitに残す。

変更された計画ファイル1つは、自己記入を避けるため、未計画パス判定と不変条件のパス選択から除外する。計画だけを変更するPRは、`planned_paths`が空なら選択条件も空となり、名前・task_id・base・書式・衝突の検査を満たせば`metadata-complete`になりうる。これは計画の意味が正しいという判定ではなく、独立した内容レビューが必要。他の`.review/**`（条件・原因台帳・固有試験など）の変更は除外せず、通常どおり条件を選択する。全PRが計画を含むだけでレビュー運用条件を一律に課す設計にはしない。

新規作業では計画を先にcommitする。指摘修正では毎回既存計画を確認するが、base・範囲・前提・方針・検証方法が変わらなければ計画ファイルの書換えは不要。PR全体では最初の計画の差分があるため「変更した計画が1つ」を満たす。変更が必要なときだけ同じ計画を先に更新・commitする。引継ぎには計画のパス、計画commit、今回再確認した結果を書く。

## 差分とbaseを再確認する

最新baseをbranchへ取り込み、影響を確認する。baseだけ進んだ場合、既存の理由・確認方法を全面的に書き直す必要はない。baseの条件や仕様の差分を読み、影響分だけ直して`base_sha`を更新する。prepareは新しい一時ファイルへ出して比較できる。

次のGitアダプタは**baseの信頼したcheckoutから**実行する。baseがheadの祖先でない／履歴不足なら「baseを取り込んで再確認」と停止する。三点diffでPRのパスを取り、他PRのファイルを計画へ加えない。引数の`<...>`は実際の値へ置き換える。

```sh
python3 <base-checkout>/tools/review_guard/changed_paths.py --repository <candidate-checkout> --base-sha <最新baseSHA> --head-sha <headSHA> --output actual-paths.json
python3 <base-checkout>/tools/review_guard/ci.py --candidate <candidate-checkout> --paths-file actual-paths.json --base-sha <最新baseSHA>
```

`ci.py`はbase自身の検査器・catalog・ledgerを使用し、候補のコードを実行しない。候補catalogの構造を検査し、baseとの差分（条件の追加・削除、文面、paths、関連条件、シナリオ）と台帳変更の有無を先に1行のJSONで報告する。その後、計画検査の結果JSONを出す。削除・縮小の報告があっても計画の記入が揃えばexit 0になりうる。将来のbaseへ採用してよいかは必ず別担当が判断する。

手元で指定した条件への構造検査だけを行う場合:

```sh
python3 tools/review_guard/guard.py check --plan .review/plans/T07-storage.json --paths-file actual-paths.json --base-sha <最新baseSHA> --catalog <base-checkout>/.review/invariants.json --ledger <base-checkout>/.review/findings.json
```

## 原因の照合と結果の意味

```sh
python3 tools/review_guard/guard.py triage --candidates candidates.json
```

候補JSONは`invariant_id`・`cause_key`・`evidence`を持つオブジェクトの配列。台帳のIDは`PR2-R007`形式（`PR<正整数>-R<3桁以上の正の番号>`、ASCII数字、PR番号の先頭ゼロなし）だけを受理する。台帳・候補の`cause_key`に前後空白がある入力は拒否する。 同じバッチ内の`(invariant_id, cause_key)`重複は、台帳に登録済みかどうかを問わず入力全体を拒否し、結果を出力しない。同じ原因の証拠は1候補にまとめてから入力する。異なる条件で同じ原因キーを使う候補は別候補として扱う。過去コメントの`R-007`はそのPR番号と組み合わせた同じIDで、新規指摘ではない。原因の意味の照合・投稿の重複防止・解消判断は担当レビュワーが行う。

成功時exit 0は記入の充足のみ。入力不備・未記入・未解決の衝突・古いbase・未計画パスはexit 1。未知の版、重複キー・ID、参照不明IDも拒否する。方針の自動修正・承認・ネットワーク操作は行わない。

## PRの巡回の判定（patrol）

T23で加えた。[PRの引継ぎとレビューのループ](../../docs/pr-review-loop.md)の「レビュー開始の条件」を、開いているPRごとに機械で判定し、報告を出すだけの読取りの補助。判定は承認でもマージの許可でもない。GitHubへは書き込まない（2026-10-04の所有者決定で、通知の投稿と重複の防止はIssue #45の受付の担当。[レビューの配車の設計](../../docs/review-dispatch-design.md)の5）。

```sh
python3 tools/review_guard/github_source.py                 # 開いているPRを読み、判定を表示する（投稿しない）
python3 tools/review_guard/github_source.py --pr 25         # PRを絞る（複数指定できる）
python3 tools/review_guard/github_source.py --snapshot-out snap.json
python3 tools/review_guard/patrol.py judge --snapshot snap.json   # 保存したデータを、ネットワークなしで判定し直す
```

設定は`.review/patrol.json`（repo、印の名前空間、必須のcheckの名前と、そのジョブが試験したmerge commitをログに出す環境変数の名前（`tested_commit_env`）、agent_idの先頭から系統（Codex側・Claude側）を決める表（`agent_sides`）、レビュー役のroleとその系統、信頼する作者の関係、追加で信頼するlogin（`trusted_logins`。GitHub Appのbot等。既定は空）、Copilotのアカウント、保護対象のパス）。開始条件の不足は、各PRの`gap`（`stale-handoff`・`ci-failed`・`ci-other-base`）として出す。終了コードは、0が判定済み、1が入力の不備、2が引数の誤り、3が未確認（どれかの取得に失敗した）。

### 分け方

| 状態 | 意味 | 条件 |
| --- | --- | --- |
| `ready-for-review` | 着手候補 | PRがOpenで、最新の引継ぎが`ready-for-review`で、そのhead/baseがPRのいまのheadとbaseのbranchの先端に一致し、そのheadの必須のcheck（`Quality gate`）の最新のrunが成功し、そのrunが試験したmerge commitの親が［baseの先端、head］で、引継ぎのあとに、このhead/baseへの別担当のレビュー記録がない |
| `awaiting-fixes` | 修正待ち | このhead/baseへの`changes-requested`、必須のcheckの失敗・中断・skip、必須のcheckの成功が古いbaseとのmerge commitのもの、または`ready-for-review`のあとのpush・baseの更新（引継ぎの出し直しが要る） |
| `awaiting-owner` | 判断待ち | このhead/baseへのレビューの`needs-owner`、または最新の引継ぎが`needs-owner` |
| `in-progress` | 作業中 | 引継ぎがない、最新の引継ぎが`working`等、最新の引継ぎが読めない（それより前の`ready-for-review`は使わない）、またはPRがDraft（`ready-for-review`や`accepted`があっても、Draftに戻したら作業中） |
| `waiting-ci` | CI待ち | 引継ぎは最新だが、必須のcheckがまだ終わっていない・見つからない |
| `accepted` | レビュー済み | このhead/baseへの、実装と反対の系統の`accepted`があり、必須のcheckが成功。マージの条件（[AGENTS.md](../../AGENTS.md)）は別に確かめる |
| `unconfirmed` | 未確認 | 取得の失敗・rate limit・ページの取り切れなさ・ファイル一覧の件数がPRの`changed_files`と合わない（上限の3,000件での打切りを含む）・baseの先端が読めない・引継ぎが名指しするIssueが読めない、最新の引継ぎと同じ秒に別の資源（issue commentとpull review）の記録がある、系統を決められないレビューがある、必須のcheckの成功が試験したmerge commitをログとcommitから確かめられない、または`ready-for-review`のあとに読めないレビュー役の記録（印のないもの、書式の誤り）がある |

- 経過時間は判定に使わない（時計を読まない）。無更新のPRは、引継ぎがなければいつまでも`in-progress`。Openであることは完了の根拠にしない。Draftは作業中として扱う（[AGENTS.md](../../AGENTS.md)の作業中Draft・レビュー依頼Open）。
- 役割は、本文の印（`<!-- <名前空間>:handoff:v1 -->`・`<!-- <名前空間>:review:v1 -->`）と`role:`欄だけで決める。全員が同じGitHubアカウントで書くので、loginでは決めない。GitHubのレビューの状態（APPROVED等）やCOMMENTかどうかも使わない。印は**本文の1行目**（先頭の空行は除く）にあるものだけを読み、2行目以降の印（前置きのあとの例示、コードブロック、後置の書式例）は記録にしない（警告に出す）。`role: reviewer`（旧表記）も読む。
- 人のアカウントの記録は、作者の関係（`author_association`）が`trusted_associations`のときだけ読む。GitHub Appのbotの記録は`author_association`が`NONE`になるので、`trusted_logins`（botのloginから系統への対応。このrepoではCodexとClaudeのApp）に設定したbotのものだけを読む。知らないbot・`NONE`の人の記録は読まない。これは役割の識別ではなく、public repoで第三者が書いた印を除くため。botの記録は、印の系統（引継ぎは`agent_id`の先頭、レビューは`role`）とbotの系統を照合し、食い違えば数えずに未確認にする。
- 必須のcheckの成功は、そのrunが試験したmerge commitが、いまのbaseの先端とheadを親に持つときだけ数える。試験したcommitはジョブのログの`<tested_commit_env>: <SHA>`の行（このrepoではQuality gateの`TESTED_SHA`）から読み、commitのAPIで親を確かめる。PRやrunのAPIのbase.shaは更新が遅れるので使わない。
- レビューは、実装と反対の系統のものだけを数える（Claude側の実装はCodex側、Codex側の実装はClaude側。[現在の状態](../../docs/project-status.md)の「レビュー」）。実装の系統は引継ぎの`agent_id`の先頭、レビューの系統は`role`（`codex-reviewer`・`claude-reviewer`）で決める。旧表記の`role: reviewer`はレビューの`agent_id`の先頭で決める。`role`と`agent_id`の系統が食い違う、または決められないレビューは未確認にする。同じ系統の別のsubagentのレビューは数えない。`agent_id`は協調用の表示で、本人確認ではない（同じアカウントの間は、書いた本人を機械では確かめられない）。
- 前後は作成時刻で決める。同じ資源（issue comment同士、pull review同士）の同じ秒はIDで決めるが、別の資源の同じ秒はIDで決めない（前後を証明できないので未確認）。
- 保存したsnapshotで判定し直すときは、snapshotの`repository`が設定と一致しなければ拒否する。
- Copilotは補助。レビューの有無を表示するだけで、未実施・利用不可でも判定を変えず、承認にも数えない。未解決のスレッドは読まない（レビュー担当が確かめる）。
- 保護対象のパス（workflow・検査器・条件・原因台帳）を変えるPRは`policy_files`に一覧にする。判定は変えない。CIの合格は迂回を防がないので、独立レビューでその変更を確かめる（[修正前の整合確認](../../docs/review-prevention.md)の「独立レビューを必須にする保護」）。

### 信頼の境界

- `patrol.py`（判定の中核）は、ネットワーク・投稿・時計・プロセスの起動を使わない純粋な関数。試験は合成のfixtureで行う。
- `github_source.py`は、`gh api`を固定の引数の並びで呼ぶ（shellを使わない）。読取りはGETだけで、ghの既存のログインを使い、トークンを読まない・出力しない。次のページは`https://api.github.com/`のLinkだけをたどる。
- PRのコードをcheckout・build・実行しない。PRの本文・コメントは文字列として読むだけで、コマンドとして解釈しない。
- GitHub Actionsからは動かさない（定期実行やコメントの投稿をActionsに加えない。[GitHub・複数AIの運用](../../docs/github-agent-operations.md)の「定期実行」）。CIでは、この判定の試験（`tests/test_patrol.py`・`tests/test_github_source.py`）だけを、既存の`review tools`のジョブで実行する。定期的な巡回への組込みはT24で行う。

## CIの配置前提

`adapters/github-actions.yml`はテンプレート。このrepoでは、T05で同じ内容を`.github/workflows/ci.yml`の`review plan`・`review tools`のジョブとして配置した（actionの版と`setup-python`を合わせ、3つのOSで試験する）。ほかのrepoへ移すときは、このテンプレートから配置する。

**このテンプレート単独では、PRによる検査の迂回を防げない。** `pull_request`のworkflow自体をPRで変更できるため、base側の検査器を呼ぶstepを削除されれば保証はない。このrepoでは、必須のstatus checkを`Quality gate`だけにすることと、「Require branches to be up to date before merging」を有効にすることは、2026-10-03の所有者決定（所有者本人の確認: PR #18のCodexの記録5965890988）で、T05のマージのあとに実装側が設定する。workflow・検査器・条件・原因台帳の変更に独立レビューを必須にする保護と、その迂回試験は、T23で扱う。その保護と迂回試験を確認するまでは、必須ゲートとして扱わない。CODEOWNERSファイルだけでは強制にならず、同一アカウントのCOMMENTもGitHub上の独立承認に数えない。今回は権限付きイベントへの切替えや保護設定をしない。

baseの検査器がない初回導入はexit 1で停止し、合格を偽装しない。まずツールを独立レビューでmainへ導入し、その後の別PRでテンプレートを配置する。テンプレートは標準runner・read-only token・秘密なし。製品CIを代用しない。Windows/Actionsの実動作は配置時に確認する。
