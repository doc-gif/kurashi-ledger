# Review guard

Python 3.11以上、外部パッケージ不要。Macでは版を確認した`python3`、Windowsでは`py -3.11`等を使用する。起動時に3.11未満を拒否する。Pythonはレビュー運用の開発ツール用で、製品ランタイムではない。未導入なら別途準備が必要。この変更ではインストールしない。

リポジトリのrootで実行する。方針は[修正前確認](../../docs/review-prevention.md)に従う。

```sh
python3 tools/review_guard/guard.py validate --catalog .review/causes/invariants.json --ledger .review/causes/findings.json --global-ids .review/mekiki/global-ids.json --config .review/config.toml
python3 -m unittest discover -s tools/review_guard/tests -v
python3 -m unittest discover -s .review/tests -v
```

汎用試験は`tools/review_guard/tests`、このrepo固有のルーティング試験は`.review/tests`。別repoへ検査器を移すときは汎用試験だけを同梱し、固有試験は条件・履歴とともにこちらへ残す。`test_stage4_*.py`は合成の入力`tests/stage4/fixtures.py`を読む。`guard.py`・`ci.py`・`changed_paths.py`・`plan_rewrites.py`と汎用試験はmekikiの写しで、出どころは`.review/mekiki/SOURCE.json`に書く。台帳は今2組ある（[2段の台帳と段4の移行](#2段の台帳と段4の移行)）。

`.review/config.toml`があると、`guard.py`は`--config`を付けなくてもそれを読む。その`[causes.paths]`は共通のIDを指すので、`--global-ids`を付けないと終了コード1になる。このrepoのファイルを読むコマンドには、`--catalog`・`--ledger`・`--global-ids`を付ける。

## 計画を作る

予定パスをUTF-8のJSON配列に保存する（例: `["src/infrastructure/storage/root.ts"]`）。renameは旧・新双方を含める。repo相対表記・大小文字を区別する。パターンは`fnmatchcase`で、`*`は`/`も含む。否定・除外パターンは提供しない。

```sh
python3 tools/review_guard/guard.py prepare --catalog .review/causes/invariants.json --ledger .review/causes/findings.json \
  --global-ids .review/mekiki/global-ids.json --global-catalog <共通のinvariants> --global-ledger <共通のfindings> \
  --private-output <repoの外のファイル> --paths-file planned-paths.json --base-sha <40文字のbaseSHA> --output .review/plans/T07-storage.json
```

共通の台帳の本文（条件・質問・教訓・出典）は非公開のmekikiにだけある。`prepare`はその本文を`--private-output`（repoの外）にだけ書き、公開する計画の`context`には固有の不変条件だけを入れる。共通の不変条件は、計画ではIDだけで書く。

`--output`はUTF-8で新しいファイルを作り、既存ファイルは上書きしない。更新は既存の計画を編集するか、別の一時ファイルへprepareして差分を取り込む。PowerShellの`>`を使わない。標準出力もASCIIエスケープされたJSONなので、旧Windowsのコンソールで日本語のエンコードに失敗しない。入力はUTF-8（BOMありも可）。UTF-16は未対応。

### 書式

| 項目 | 記入内容 |
| --- | --- |
| `schema_version` | `2`。`1`は版2の導入前に作った計画だけ（[移行](../../docs/review-prevention.md#いたちごっこを止める3つの施策)） |
| `task_id` | 台帳上のID（例: `T07`、`OPS-REVIEW`）。Issue番号はPR/引継ぎに記す |
| `base_sha` | 検討した最新mainの40文字SHA |
| `planned_paths` | このPRの予定パス（削除・rename旧名も含む）。計画自身のパスは省略可 |
| `assessments[].id` | 不変条件ID |
| `disposition` | `preserve`（維持）、`not-applicable`（非該当）、`change-proposed`（条件変更） |
| `reason` | 方針の理由。非該当にも具体的な根拠が必要 |
| `checks` | 各シナリオの`id`、確認方法`method`、独立した期待結果`expected`。実行済み証跡ではない |
| `decision_references` | `change-proposed`では必須の非空配列。ADRのパス、公開できる決定記録のリンク等。参照先の実在・内容・権限は別担当が確認する |
| `conflicts` | 衝突がなければ`[]`。あれば下記の形。未解決ならcheckは失敗する |
| `boundaries` | 版2で必須。変更が触れる入口・出口の一覧（信頼の度合いと制御）。書き方は[計画の表](../../docs/review-prevention.md#いたちごっこを止める3つの施策) |
| `variant_analysis` | 版2で必須。関係する不変条件・原因ごとの、確かめた箇所と結果。同上 |
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
python3 tools/review_guard/guard.py check --plan .review/plans/T07-storage.json --paths-file actual-paths.json --base-sha <最新baseSHA> --catalog <base-checkout>/.review/causes/invariants.json --ledger <base-checkout>/.review/causes/findings.json --global-ids <base-checkout>/.review/mekiki/global-ids.json --config <base-checkout>/.review/config.toml
```

## 原因の照合と結果の意味

```sh
python3 tools/review_guard/guard.py triage --catalog .review/causes/invariants.json --ledger .review/causes/findings.json \
  --global-ids .review/mekiki/global-ids.json --config .review/config.toml --candidates candidates.json
```

段5までは、原因を古い台帳に足す（[段5までの扱い](#段5までの扱い)）。足す前に既存のIDを古い台帳で照合するときは、`--catalog .review/invariants.json --ledger .review/findings.json`を付け、`--config`には存在しないpath（例: `.review/none.toml`）を渡す。`[causes.paths]`は共通のIDを指すので、目録なしの古い台帳とは一緒に読めない。

候補JSONは`invariant_id`・`cause_key`・`evidence`を持つオブジェクトの配列。台帳のIDは`C-0001`形式（`C-`と0で4桁にそろえた正の10進数。10000以上はそのままの桁。ASCII数字）。`--global-ids`なしの1段の台帳だけは、分割前の`PR2-R007`形式（`PR<正整数>-R<3桁以上の正の番号>`、PR番号の先頭ゼロなし）も受理する。台帳・候補の`cause_key`に前後空白がある入力は拒否する。 同じバッチ内の`(invariant_id, cause_key)`重複は、台帳に登録済みかどうかを問わず入力全体を拒否し、結果を出力しない。同じ原因の証拠は1候補にまとめてから入力する。異なる条件で同じ原因キーを使う候補は別候補として扱う。過去コメントの`R-007`はそのPR番号と組み合わせた同じIDで、新規指摘ではない。原因の意味の照合・投稿の重複防止・解消判断は担当レビュワーが行う。

成功時exit 0は記入の充足のみ。入力不備・未記入・未解決の衝突・古いbase・未計画パスはexit 1。未知の版、重複キー・ID、参照不明IDも拒否する。方針の自動修正・承認・ネットワーク操作は行わない。

## 2段の台帳と段4の移行

mekikiの段4（設計8節）で、原因の台帳を共通と固有に分けた。所有者の決定（2026-10-12、非公開のmekikiで記録）で、段5までは次の2組を並べて置く。

- 新しい組は、固有の台帳`.review/causes/invariants.json`・`findings.json`・`origins.json`（各原因の元の指摘）と、共通のID目録`.review/mekiki/global-ids.json`と、`.review/config.toml`の`[causes.paths]`だ。IDは`C-NNNN`。CIの`validate`はこの組を検査する。baseに`.review/causes/`があれば、`ci.py`は計画をこの組で検査する。
- 古い組は`.review/invariants.json`・`.review/findings.json`だ。IDは`PR<N>-R<NNN>`。今の受付（`scripts/lib/review-dispatch/`）がbaseから読むので、段5まで消さない。`.review/tests`が古い組も検査し、どちらの組でも同じpathが同じ不変条件を選ぶことを確かめる。
- 目録は、`condition`・`question`・`lesson`・`sources`を持たない。不変条件のID・paths・related・scenarioのIDと、原因のIDとhashだけを持つ。原因のhashは`sha256(invariant_id + "\n" + cause_key)`で、計画の`cause_key`も同じ式で照合する。
- 固有と共通でIDや原因が重なる、共通の`related`が固有を指す、目録の形が違う、のどれでも終了コード1。固有のfindingは`cause_key`を持ち、`cause_key_hash`を書けない。
- 目録を使う`check`は、`context`に共通のIDを持つ計画を拒否する。出力の`empty_global_paths`は、どのpathも選ばない共通の不変条件の一覧だ。
- `[causes.paths]`は、共通の不変条件のIDにglobの配列を足す。目録の`paths`に足すだけで、狭めない。目録にないID、固有のID、配列でない値は終了コード1。`ci.py`はbaseの設定で選び、candidateの設定は形だけ確かめる。`ci.py`は目録もbaseの写しだけを読む。

### 段5までの扱い

- 新しい原因は、今までどおり古い台帳（`.review/findings.json`、IDは`PR<N>-R<番号>`）にだけ足す。`.review/causes/`と目録は手で直さない。だから段5までに足した原因は、CIの計画の検査には出ない。粗探しは、受付が渡す古い台帳で全部の原因を見る。
- 段5の前に、その時点のmainの古い台帳と計画から、mekikiで分割を作り直す（C-NNNNはmekikiが振る）。そのPRで、`.review/causes/`、`.review/mekiki/global-ids.json`、`.review/mekiki/SOURCE.json`を作り直す。
- そのPRでは、`SOURCE.json`の`split.input.commit`が、そのPRの`base_sha`と同じことを確かめる。違えば、2つのcommitの間で`.review/invariants.json`・`.review/findings.json`が変わっていないことを`git diff`で確かめる。変わっていれば作り直す。
- `ci.py`の`policy_changes_to_review`と`ledger_changed`は、`.review/causes/`の変更だけを出す。`.review/mekiki/global-ids.json`、`.review/config.toml`、古い台帳、書き換えの一覧（`.review/mekiki/plan-rewrites.json`）と分割の対応の表（`.review/mekiki/split-map.json`）の変更は出さない。段5まで、これらを変えるPRは、レビューの担当が差分を読んで確かめる。
- 古い台帳の原因のうち次の17件は、分割で新しい共通の不変条件（INV-DATA-DURABILITY・INV-DESIGN-IMPL・INV-DEV-BOUNDARY・INV-FAIL-CLOSED・INV-FS-BOUNDARY・INV-SPEC-COHERENCE）へ移った。この6つは目録の`paths`が空で、`[causes.paths]`にも`related`にもないので、新しい組の`check`は選ばず、`causes_not_analyzed`にも出さない。所有者の決定（[PR #83の案B](https://github.com/doc-gif/kurashi-ledger/pull/83#issuecomment-6110696598)）で、段5まではこの17件を新しい組の計画の検査から外したままにする（粗探しは古い台帳で見る）。6つにpathを足すのは、段5の後の別のPRで行う。
  - PR2-R001（C-0001）、PR2-R002（C-0002）、PR2-R004（C-0004）、PR2-R005（C-0005）、PR2-R006（C-0006）、PR2-R007（C-0007）
  - PR10-R001（C-0057）、PR10-R002（C-0058）、PR10-R003（C-0059）
  - PR11-R009（C-0034）、PR11-R105（C-0046）、PR11-R107（C-0049）、PR11-R110（C-0054）、PR11-R111（C-0055）
  - PR12-R101（C-0066）、PR12-R103（C-0069）、PR12-R104（C-0070）

## 既存の計画の書き換え（mekiki Issue #46）

mekikiの`node scripts/ledger.ts rewrite-plans`（hostで動かす）で書き換えた既存の計画は、baseの一覧に載っていれば、1つのPRでまとめて変えられる。一覧は`<review-dir>/mekiki/plan-rewrites.json`に置く。

```json
{"schema_version": 1, "split_map_sha256": "<split-map.jsonのbytesのSHA-256>",
 "plans": [{"path": ".review/plans/OPS-LEDGER-PR10-PR12.json", "editable_text": ["/conflicts/5/resolution"]}]}
```

- 権限はbaseの一覧だけが持つ。candidateの一覧は形だけを確かめ、その中身は効かない。
- 一覧のファイルがあれば、中身が`null`でも一覧として扱う（mekiki PR #49のPR49-R001）。形が違えば、baseでもcandidateでも終了コード1。
- 一覧の計画を変えるPRでは、`ci.py`は`<review-dir>/mekiki/split-map.json`をcandidateから読む（無ければbaseから）。そのbytesのSHA-256がbaseの一覧の`split_map_sha256`と違えば、終了コード1。
- 一覧に載り、baseとcandidateの両方にある計画だけを、「変える計画は1つ」と「`base_sha`がPRのbase」の検査から外す。新しい計画と消した計画は外さない。
- 外した計画で許す変更は次の4つだけだ。ほかの変更が1つでもあれば、終了コード1。
  - `context`から共通の不変条件のキーを外す。共通とは、`split-map.json`の`new_invariants`と`scope: global`の移す先、baseの目録の不変条件だ。
  - 残す`context`の`history`を、baseの固有の台帳の行に置き換える（所有者の決定、mekiki Issue #46のI46-R002）。元の並びのまま、各項目を、`split-map.json`がその項目のIDに付けた`scope: project`の行（`both`なら固有の側）のIDで、baseの台帳から引いた行そのものにする。共通の側にだけ移した項目は外す。対応が1つに決まらない項目や、baseの台帳に無い行があれば、置き換えられない。`history`を元のまま残すこともできる。`history`以外の固有のキーは変えない。
  - `variant_analysis`の移した原因のキーを、`split-map.json`のとおりに置き換える。`both`のキー、行の順、キー以外の項目は変えない。元の不変条件をguardが選び、それを名指す行が無くなるときは、移した行の`invariant_id`・`pattern`・`places`だけの行をちょうど1つ足す（mekiki Issue #44のB）。
  - `editable_text`がJSON Pointerで名指した`conflicts`の`description`・`resolution`の文字列を言い換える。`state`と判定の項目（`disposition`・`reason`・`checks`）は、名指しても変えられない。項目の追加・削除もできない。
- 外した計画も、baseの台帳・目録・設定で`check`する。`base_sha`はその計画自身の値で、pathはその計画だけだ。
- 一覧に無い計画は今までどおりだ。外した計画を除いて1つまでで、PRのbaseで`check`する。外した計画だけのPRは、ほかに`split-map.json`と一覧の削除しか変えられない。
- 一覧の計画を書き換えるPRは、一覧を消す（所有者の決定、mekiki PR #49）。candidateに一覧が残れば、中身が同じでも終了コード1。一覧が残ると、後のPRでも名指しした自由文を言い換えられるためだ。
- 自由文の公開前の検査は、pushの前にhostの`rewrite-plans`がかける。CIは名指しした場所だけが変わったことを確かめ、共通の本文を持たない。
- この規則の試験は、APIの試験（`test_plan_rewrites.py`）だけを写した。実際の`ci.py`を通す試験の2ファイル（`test_plan_rewrites_ci.py`の16件と`test_plan_rewrites_null_list.py`の5件）は写していない。`test_plan_rewrites_ci.py`は、hostの`scripts/ledger.ts`を使う2件と、`guard.py`・`ci.py`だけで動く14件が同じファイルにある。`test_plan_rewrites_null_list.py`は、そのファイルを読み込む。そのため今は、`ci.py`の書き換えの経路（`check_with_rewrites`）をkurashiの試験は通らない。19件は、mekikiで同じコードに対して流している。mekikiでhostの2件を別のファイルに分けたあと、19件をここへ写す。

## CIの配置前提

`adapters/github-actions.yml`はテンプレート。このrepoでは、T05で同じ内容を`.github/workflows/ci.yml`の`review plan`・`review tools`のジョブとして配置した（actionの版と`setup-python`を合わせ、3つのOSで試験する）。ほかのrepoへ移すときは、このテンプレートから配置する。テンプレートはmekikiの写しのまま変えておらず、`guard.py validate`に引数がない。`.review/config.toml`を置くrepoでは、`ci.yml`と同じく`--catalog`・`--ledger`・`--global-ids`・`--config`を付けて配置する。

**このテンプレート単独では、PRによる検査の迂回を防げない。** `pull_request`のworkflow自体をPRで変更できるため、base側の検査器を呼ぶstepを削除されれば保証はない。このrepoでは、必須のstatus checkを`Quality gate`だけにすることと、「Require branches to be up to date before merging」を有効にすることは、2026-10-03の所有者決定（所有者本人の確認: PR #18のCodexの記録5965890988）で、T05のマージのあとに実装側が設定する。workflow・検査器・条件・原因台帳の変更に独立レビューを必須にする保護と、その迂回試験は、T23で扱う。その保護と迂回試験を確認するまでは、必須ゲートとして扱わない。CODEOWNERSファイルだけでは強制にならず、同一アカウントのCOMMENTもGitHub上の独立承認に数えない。今回は権限付きイベントへの切替えや保護設定をしない。

baseの検査器がない初回導入はexit 1で停止し、合格を偽装しない。まずツールを独立レビューでmainへ導入し、その後の別PRでテンプレートを配置する。テンプレートは標準runner・read-only token・秘密なし。製品CIを代用しない。Windows/Actionsの実動作は配置時に確認する。
