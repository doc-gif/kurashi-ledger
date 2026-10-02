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

ファイル名は`<task_id>.json`、同じタスクを複数PRに分けるときは`<task_id>-<part>.json`（例: `T07-storage.json`、`T07-migrations.json`）とする。各PRは自分の計画を1つだけ追加・変更する。local CLIとCIは計画のファイル名が`task_id.json`または`task_id-part.json`に一致することも検査する。CLIの`check`も、複数の計画変更をカバレッジ判定から除外する前に拒否する。既存の他PRの計画を流用して編集しない。1PRに複数タスクを混在させない。計画の履歴はGitに残す。

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

候補JSONは`invariant_id`・`cause_key`・`evidence`を持つオブジェクトの配列。台帳のIDは`PR2-R007`形式。過去コメントの`R-007`はそのPR番号と組み合わせた同じIDで、新規指摘ではない。原因の意味の照合・投稿の重複防止・解消判断は担当レビュワーが行う。

成功時exit 0は記入の充足のみ。入力不備・未記入・未解決の衝突・古いbase・未計画パスはexit 1。未知の版、重複キー・ID、参照不明IDも拒否する。方針の自動修正・承認・ネットワーク操作は行わない。

## CIの配置前提

`adapters/github-actions.yml`は未稼働のテンプレート。認証にworkflow scopeがないため`.github/workflows/`へ配置していない。

**このテンプレート単独では、PRによる検査の迂回を防げない。** `pull_request`のworkflow自体をPRで変更できるため、base側の検査器を呼ぶstepを削除されれば保証はない。権限を持つ担当がT05/T23で、workflow・検査器・条件・原因台帳の変更の必須レビュー／ruleset等を別途設計・設定し、迂回試験まで確認してから必須ゲートとして扱う。CODEOWNERSファイルだけでは強制にならず、同一アカウントのCOMMENTもGitHub上の独立承認に数えない。今回は権限付きイベントへの切替えや保護設定をしない。

baseの検査器がない初回導入はexit 1で停止し、合格を偽装しない。まずツールを独立レビューでmainへ導入し、その後の別PRでテンプレートを配置する。テンプレートは標準runner・read-only token・秘密なし。製品CIを代用しない。Windows/Actionsの実動作は配置時に確認する。
