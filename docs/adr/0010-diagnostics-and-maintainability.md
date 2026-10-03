# ADR-0010: 不具合調査の基盤（診断ログ・エラーコード・診断の束）と保守の仕組み

- 状態: Proposed（このPRがmainに統合された時点でAcceptedとみなす）
- 日付: 2026-10-03
- 関連: Issue #35、ADR-0002（起動・更新、G6）、ADR-0003（11のログ、9の外部通信）、ADR-0006（1のデータルートと`logs/`、「影響」のログの規則）、ADR-0007（適用表。この節で診断の操作を加える）、ADR-0008（依存の導入の記録）。実装はT29〜T32（[タスク台帳](../implementation-tasks.md)）。ログのファイルをデータルートにつなぐのはT09。
- 番号: 0009は、T26のPR #25（ローカルHTTPの実装の詳細）が使っている。

## 背景

### 所有者の依頼

2026-10-03に、所有者が実装側のチャットで次を依頼した（調整係が中継。記録はIssue #35）。

> システムを使っていて不具合がでた時に不具合調査をしやすい基盤を作って欲しい。ロガーとか。他にも保守をしやすくなる仕組みがあれば探して導入してください

調整係の提案（ロガー、エラーコード、診断の束、保守の仕組み、Dependabot）に、所有者は「設計をCodexとCopilotにもレビューしてもらう」「なぜ導入したいかの背景も入れる」を条件に承認した。そこで2段階で進める。このADR（設計）をレビューで受け入れてから、台帳のT29〜T32で実装する。`.github/dependabot.yml`だけは、所有者の承認によりこのADRと同じPRで加える。

### いまの状態と困ること

- このアプリは所有者のPCだけで動く（ADR-0002）。外部へ通信しない（ADR-0003の9）ので、クラッシュの報告やテレメトリは使えない。不具合を調べる材料は、利用者（所有者）が手で渡すものだけになる。
- 調べるのは、多くの場合AI（Claude・Codex）で、やり取りは公開のIssue・PRで行う。利用者が貼った内容は、そのまま公開される。したがって、**渡す材料そのものが、実データを含まないことを構造で保証していなければならない**。伏せ字（redact）は、書き忘れた項目がそのまま出るので頼れない（ADR-0003の11、ADR-0006の「影響」、T25の「診断ログに実明細を出さない」）。
- いまある出力は、T26（PR #25）の要求ログ（自由な文字列を標準出力へ）と、各スクリプトのエラー文だけ。ターミナルを閉じると消える。文の言い回しは変わるので、ログやコードを検索する手掛かりにならない。

### 想定する不具合の場面

以下の仕組みは、それぞれ次の場面のどれに効くかで説明する。

| ID | 場面 | 調べるのに要るもの |
| --- | --- | --- |
| S1 | 更新のあと`npm run start:real`が起動しない | G1〜G6のどの確認で止まったか、Node.jsと依存の記録、タグ・作業ツリーの状態 |
| S2 | バックアップの作成が途中で失敗する | どの段階で、OSのどのエラー（`ENOSPC`・`EACCES`等）か |
| S3 | 画面の操作で「失敗しました」と出る | どのユースケースの、どの例外か。画面の表示とログの行の対応 |
| S4 | 翌日以降に気付いた不具合 | ターミナルを閉じたあとも残る記録 |
| S5 | 復元・rollbackが途中で止まった | 状態ファイルの有無と段階、直前の事象 |
| S6 | Windowsだけで起きる | OS・CPU・Node.jsの版、パスの種類（日本語・長いパス等。パスそのものではない） |

## 決定

### 1. 診断ログ（採用。T29）

**背景:** S1〜S6のすべてで、「いつ・どの操作で・何が起きたか」を後から検索できる記録が要る。記録は、公開の場へ渡しても実データが出ないものでなければならない。

**決定:**

1. **型付きの事象だけを記録する。** ログの1行は、事象の一覧（catalog）に登録した名前（例: `http.request`、`root.check.failed`、`backup.stage.failed`）と、その事象に登録した項目だけを持つ。一覧にない事象・項目は書かずに捨て、捨てた件数を別の事象で数える。一覧は1つのファイル（`src/application/diagnostics/events.ts`）に置き、変更はレビューで読む。
2. **項目の種類を許可した種類に限る。** 自由な文字列の種類を作らない。金額・勤務先・氏名・パス・トークン・cookie・利用者が入力した文・例外のメッセージを入れられる種類が、そもそもない。

   | 種類 | 値 | 例（合成） |
   | --- | --- | --- |
   | 列挙 | 事象ごとに一覧で決めた固定の文字列のどれか | `reason: "host-mismatch"`、`stage: "verify"` |
   | エラーコード | 2のエラーコードの一覧にある値 | `code: "E2003"` |
   | 件数・時間・大きさ | 上限のある0以上の整数 | `retries: 2`、`durationMs: 315` |
   | 真偽 | `true`・`false` | `stateFilePresent: true` |
   | 不透明なID | アプリが乱数で作ったID（形式を検査する） | 起動・操作・計算runのID |
   | OSのエラーの種類 | `^[A-Z][A-Z0-9_]{1,31}$`に合うもの | `ENOSPC`、`SQLITE_BUSY` |
   | 例外の名前 | 許可した名前の一覧（`TypeError`等）のどれか。ほかは`other` | `errorName: "RangeError"` |
   | 版 | semverか40文字のcommitのSHA | `node: "24.21.0"` |
   | スタック | 下の消毒の関数だけが作れる型 | `src/application/records/save.ts:42:7 saveRecord` |

   - 整数の種類は、型では「金額を件数の項目に入れる」誤用を防げない。この限界を認め、整数の項目は名前で数えるもの（`records`、`retries`等）を示し、一覧の変更をレビューで確かめる。T29で、レビュー運用の台帳（`.review/invariants.json`）に、一覧のファイルを対象にした確認の観点を足す。
   - 記録のIDを記録するかは、T29で契約（[docs/contracts/](../contracts/README.md)）のIDの形式を確かめて決める。人が付けた名前を含みうる値は入れない。
   - スタックは、アプリのcheckoutの中のフレームだけを、checkoutからの相対パス・行・列・関数名（識別子の形に合うものだけ）で残し、ほかのフレームは`<external>`にする。例外のメッセージは捨てる（OSのエラーのメッセージにはパスが入る）。checkoutの外のパスにはOSの利用者名が入りうるので、残さない。
3. **画面・ターミナルにだけ出す詳細を分ける。** 利用者が手元で直すためにパスを見せる必要はある（たとえばADR-0006の、残った`<データルート>.create-*`のパスの表示）。そのような詳細は、ターミナルや画面への表示にだけ渡し、ログと診断の束には入らない型にする。
4. **形式:** JSON Lines。1行に、形式の版、UTCの時刻（ISO 8601）、レベル、事象の名前、起動のID、操作のID、プロセスの中の連番、事象の項目を入れる。順序は連番で決め、時刻で並べ替えない（時計は戻りうる。PR11-R111）。

   ```json
   {"v":1,"t":"2026-10-03T00:00:00.000Z","lvl":"warn","ev":"http.request","launch":"q3Xr0Lw9","op":"Zk2v8Pq1","seq":12,"route":"api.records.save","status":409,"reason":"revision-conflict","durationMs":8}
   ```

5. **レベル:** `error`・`warn`・`info`・`debug`。既定は`info`。`debug`も同じ一覧と種類の規則に従い、緩めない。
6. **相関のID:** 起動ごとの`launch`、操作ごとの`op`（HTTPの要求、ユースケース、保守コマンド）、計算runのID。T26の起動の識別子（ADR-0003の14）とは別の値にし、G7に依存しない。HTTPのエラーの応答には、エラーコードと`op`を返し、画面に「問い合わせ番号」として表示する（S3）。
7. **HTTPの要求ログ:** ADR-0003の11とT26（PR #25のADR-0009の「ログ」）より厳しくし、生のパスの代わりに、登録した経路のID（例: `api.records.save`。静的ファイルは`static`、どれにも当たらなければ`unmatched`）を記録する。T26のファイルはこのPRで変えず、T29でT26のlogの口を型付きの事象へ移す。
8. **依存を注入する。** `createDiagnostics({ clock, sinks, level })`で作り、起動処理（composition root）から各部品へ引数で渡す。DIコンテナや大域の状態を使わない（[architecture.md](../architecture.md)）。domainはログを書かず、型付きの結果とエラーコードを返す。applicationは、ログの口（port）の型を`src/application/diagnostics/`から受け取る。出力先（sink）の実装は`src/infrastructure/diagnostics/`に置く。
9. **出力先:**
   - 標準エラー: 人が読む短い行（エラーコード、一覧の文、`op`）。
   - ファイル: データルートの固定の子`logs/`（ADR-0006の1）。データルートの検査（G1〜G5）に通ったあとだけ書く。それより前はターミナルだけに出す（検査の前にデータルートへ書かない。トークンの一時ファイルと同じ考え方。ADR-0003の4）。そのため、検査の前で止まった起動（S1の多く）はファイルに残らない。この場合は、`doctor`（3）が同じ確認を再現して理由を示す。書く前に、G2の固定の子の検査（リンクでないこと、実体パスが配下にあること）を行う。ファイルは本人だけの権限（macOSは`0600`、Windowsは本人だけのACL。ADR-0006の1「権限」）で、既存のファイルやリンクがあれば失敗する排他的な作成で作る。名前は`kurashi-ledger-<UTCの日付>-<launch>.jsonl`。1行ずつ同期的に追記し、異常終了しても完全な行が残るようにする（読む側は最後の欠けた行を捨てる）。
   - 回転と保持: 1ファイル5 MiBで次のファイル（`-2`等）に移る。起動時（lockを持っている間）に、30日より古いファイルを消し、合計が50 MiBを超えれば古い順に消す。消すのは`logs/`の直下の、名前の規則に合う通常のファイルだけで、リンクをたどらない（PR12-R104）。30日は、月ごとの給与・入金の周期で気付く不具合（S4）を1周期は追えるように選んだ。
   - 書き手: lockを持つアプリ・保守コマンドの1プロセスだけ（ADR-0006の単一起動のlock）。複数のプロセスが同じファイルへ書かない。
   - ログへの書込みの失敗（容量不足等）で、操作を止めない。ファイルへの出力を止め、標準エラーに1回だけ知らせる。
   - 試験用に、メモリの出力先を用意する。
   - `logs/`はバックアップに含めない（ADR-0006の3のまま）。
10. **担当:** T29で、ロガー・事象の一覧・出力先・回転を作り、渡されたディレクトリへ書く形で試験する（G7がトークンの一時ディレクトリを渡されるのと同じ。ADR-0007の4）。データルートの`logs/`へつなぐのはT09（データルートの検査を起動処理へ組み込むタスク）。新しい操作を作るタスクは、その操作の事象とエラーコードを同じPRで一覧へ足す。

**検討した候補:**

| 候補 | 長所 | 短所 | 判断 |
| --- | --- | --- | --- |
| 小さな型付きの自作ロガー（採用） | 許可した項目だけを型と実行時の検査で強制できる。依存を増やさない | 回転・同期の追記・権限を自分で試験する必要がある | **採用** |
| pino（10.4.0、MIT） | 速く、JSON Lines、広く使われる | 実行時の依存が11個（sonic-boom、thread-stream等）。秘匿は伏せ字（パスの指定）で、書き忘れた項目は出る。ファイルの回転は別のパッケージとworker threadが要る。実行時の依存をまだ1つも持たないアプリに入れる理由が弱い（ADR-0002） | 不採用 |
| winston | 出力先が多い | 依存が多く、秘匿は同じく伏せ字の方式 | 不採用 |
| `console.*`と自由な文字列（いまのT26） | 依存なし | 構造がなく検索できず、何でも出せる | 不採用（T29で置き換える） |
| `node:util`の`debuglog`、`node:diagnostics_channel` | 組み込み | 形式・保存・回転を持たない。`diagnostics_channel`は事象を配る仕組みで、保存は別に要る | 内部で事象を配るのに使うかはT29で判断（必須にしない） |
| OpenTelemetry | 標準の形式 | 外部の収集先へ送る前提で、ADR-0003の9と合わない。依存が大きい | 不採用 |

### 2. エラーコード（採用。T29）

**背景:** S1・S2・S5では、利用者が見る文、ログの行、コードの箇所、直し方の説明を、同じ手掛かりで結ぶ必要がある。文の言い回しは変わるので、検索の鍵にならない。利用者には「次に何をすればよいか」も要る。

**決定:**

- 形式は`E`と4桁の数字。最初の桁で領域を分ける。

  | 範囲 | 領域 |
  | --- | --- |
  | `E1xxx` | 起動・実行環境（Node.jsの版、依存の導入の記録、配信物のmanifest、承認済みリリース。G5・G6） |
  | `E2xxx` | データルートと保存（パス、構造、lock、状態ファイル、DB。G1〜G4） |
  | `E3xxx` | ローカルHTTP（G7） |
  | `E4xxx` | 記録・照合のユースケース |
  | `E5xxx` | バックアップ・復元・出力 |
  | `E6xxx` | 計算 |
  | `E9xxx` | 想定外の内部エラー |

- 一覧（`src/application/diagnostics/error-codes.ts`）を正本にする。各コードに、短い識別名（例: `E2003 root-in-git-worktree`）、領域、既定のレベル、利用者向けの文（日本語）、次の手順、関係するADR・部品（G1〜G7）を持たせる。利用者向けの文に値を埋め込まない（手元だけの詳細は1の3）。
- コードは使い回さない。使わなくなったコードは、一覧に予約として残す。
- 一覧から`docs/error-codes.md`を生成し、生成した内容と一覧が一致することを`npm test`で確かめる（手で書き写すとずれる。PR11-R108）。
- **捕まえていない例外:** `uncaughtException`と`unhandledRejection`を、起動処理で1か所だけ受ける。事象（`E9001`・`E9002`、例外の名前、消毒したスタック、`op`があればそれ）を記録し、標準エラーにコードと次の手順を出して、終了コード70で終える。Node.jsの文書のとおり、捕まえていない例外のあとで処理を続けない。lockはOSが解放する（ADR-0006）。`warning`の事象は、名前とコードだけを記録する。HTTPの処理の中の想定外の例外は、500と`E9003`・`op`だけを返し、スタックをブラウザへ返さない。T26の終了とシグナルの処理（Ctrl+C）とは、T29で1つにまとめる。

**検討した候補:**

| 候補 | 判断 |
| --- | --- |
| `E`と4桁と、一覧の識別名（採用） | 言語に依存せず短い。ログには数字だけを書き、コードでは識別名で読める |
| 文だけでコードを持たない | 検索できず、翻訳・言い換えで手掛かりが消える。不採用 |
| Node.jsのような英字のコード（`ERR_ROOT_IN_WORKTREE`）だけ | 読みやすいが長く、利用者に伝えにくい。識別名として一覧に持たせる |
| HTTPの状態コードだけ | 起動・保守コマンドに使えず、粒度が粗い。不採用 |

### 3. 自己診断と診断の束（採用。T30）

**背景:** いまは、不具合を相談するときに利用者がターミナルの出力を手で写す。写す範囲を誤ると実データやパスが混ざり（S3）、逆に版や状態（S1・S6）が抜けて往復が増える。渡すものを決まった形で作り、利用者が中身を確かめてから渡せるようにする。

**決定:**

- **`npm run doctor`（自己診断）:** データルートを開かずに、実行環境を確かめて、項目ごとに「合格・不合格・未確認」と、エラーコード・次の手順を表示する。いまの`npm run check:install`（ADR-0008）を置き換えず、同じ照合の関数を呼んで報告に含める（CIは`check:install`を使い続ける）。項目: Node.jsの版と`devEngines`、依存の導入の記録、配信物のmanifest（T08・T09で作るもの。なければ「なし」）、Gitの状態（HEADのタグ、作業ツリーの変更の有無、originが信頼するリポジトリか、承認済みリリースの条件。G5の確認を報告だけの形で行う。originとの照合ができなければ「未確認」）。
- **`npm run diagnose`・`npm run diagnose:real`（診断の束）:** 自己診断の結果に、データルートの状態と最近のログを加えた1つのJSONを作る。
  - 含めるもの: アプリの版（タグ・commitのSHA）、Node.jsの版、OS・版・CPUのアーキテクチャ、自己診断の結果、データルートの状態（あるか、種別、構造の版、固定の子がそろっているか・リンクでないか・権限が本人だけか、状態ファイルの有無と種類。どれも真偽か列挙で、パスは含めない）、DBのスキーマ版（アプリが起動時に記録した事象から読む。なければ「不明」）、最近のログ（7日以内、最大2000行・1 MiB）。
  - 含めないもの: DB、証憑、出力したCSV/JSON、バックアップ、`config/`、パス（データルート・checkout・ホームディレクトリ）、環境変数、ホスト名、OSの利用者名、トークン・cookie・パスフレーズ・秘密。
  - ログの行は、束に入れる前に、書くときと同じ一覧と種類の検査にもう一度通し、通らない行は捨てて件数だけを数える（古い形式の行や、手で書き換えられた行が混ざっても、束に自由な文字列が入らないようにする）。
  - 既定では標準出力に出し、利用者が画面で読む。`--out <ディレクトリ>`を指定したときだけファイルに書く。書く先の検査はCSV/JSONの出力先と同じ（G1。repo内とデータルート内を拒否し、排他的な作成、本人だけの権限。ADR-0006の1「保存先と出力先」）。
  - 送信しない（ADR-0003の9）。コマンドの最後に、含めたものの一覧と、「共有の前に中身を読み、公開のIssueに貼るのはこの束だけにする」案内を表示する。
- **モードと安全確認（ADR-0007の適用表に加える）:**
  - `doctor`はデータルートを開かない。G1〜G4・G7は対象外。G5・G6は報告するだけで、結果によって止まらない。
  - `diagnose`は合成データのデータルートだけを、`diagnose:real`は実データのデータルートを読む（ADR-0006の起動モードの規則）。`diagnose:real`には承認済みリリースの確認（G5）を適用する。G5で止まった場合は、`doctor`がその理由を示す。
  - 読み取りだけで、DBを開かず、データルートに書かない。アプリの起動中でも使えるように、lock（G3）を取らない。状態ファイル（G4）があっても止まらず、その有無と種類を報告する（S5で最も要る場面なので。ADR-0007の背景にある「止める規則が復旧の調査まで止める」回帰を避ける）。欠けた子やデータルートを作らない。`logs/`がリンクなら読まない（G2の固定の子の検査）。権限が広いことは、止まらずに報告する（G2の権限の確認は、開いて使う操作を止めるためのもので、書かない診断では理由を示すほうが役に立つ）。
  - G6（実行物の一致）は対象外にする。そのかわり、診断のコマンドが`node:`の組み込みとこのrepoのソースだけを読み込み、`node_modules`の依存を読み込まないことを試験で確かめる（依存の導入が壊れているときにも動く必要があるため）。
- 画面からの診断の束の作成は延期する（コマンドで足りるか、T13のあとに確かめる）。

**検討した候補:**

| 候補 | 判断 |
| --- | --- |
| 決まった形の束をコマンドで作り、利用者が読んでから渡す（採用） | 中身が型で決まり、送る前に確かめられる |
| いまのまま、ターミナルの出力を手で写す | 実データ・パスが混ざりやすく、版や状態が抜ける。不採用 |
| DBの写しを匿名化して渡す | 名前を消すだけでは勤務先・日付・金額から人が特定されうる（[テスト方針](../testing.md)）。不採用 |
| クラッシュの自動送信（Sentry等） | 外部通信をしない決定（ADR-0003の9）と合わない。不採用 |
| `check:install`を広げて`doctor`にする | CIの照合と利用者向けの報告の目的が違う。`check:install`は変えず、同じ関数を`doctor`から呼ぶ |

### 4. 保守の仕組み

| 仕組み | 判断 | 担当 |
| --- | --- | --- |
| 層の境界のimportの検査 | 採用 | T31 |
| 組み込みのカバレッジの報告 | 採用（閾値なし） | T31 |
| 未使用の変数・引数の検出（`tsc`） | 採用 | T31 |
| 未使用のファイル・export・依存の検出（Knip） | 延期 | — |
| lint（Biome） | 採用 | T32 |
| 書式の統一（Biomeのformatter） | 延期 | — |
| Dependabot | 採用（このPRで設定を加える） | このPR、採用の運用は`docs/development.md` |
| CIでの`npm audit` | 不採用 | — |
| 改行の正規化（`.gitattributes`） | 延期 | — |

#### 4.1 層の境界のimportの検査（採用。T31）

**背景:** [architecture.md](../architecture.md)は、domainがDB・HTTP・時計・UIをimportしないこと、applicationが依存を引数で受け取ることを決めている。いまはレビューで読むだけで、PRが大きいと見落とす（T06・T26のPRは数千行）。domainが`node:fs`等を読むと、試験で時計や保存を差し替えられなくなり、決定的な出力（T06の受入）も崩れる。

**決定:** 依存のない小さなスクリプト（`scripts/check-boundaries.ts`）と、その試験を作り、`npm test`の中で実行する（CIの3つのOSで動き、workflowを変えずに済む）。

- `src/domain/**`: `src/domain/**`だけをimportできる。`node:`のモジュールとnpmのパッケージは使わない（例外が要れば理由とともにスクリプトの許可の一覧に書く）。
- `src/application/**`: domainとapplicationだけ。`src/infrastructure/**`・`src/ui/**`と、I/Oを行う`node:`のモジュール（`fs`・`http`・`net`・`sqlite`・`child_process`等）を使わない。
- `src/infrastructure/**`: `src/ui/**`をimportしない。
- `src/ui/**`: `src/infrastructure/**`と`node:`のモジュールを使わない。domain・applicationからは型だけ（`import type`）。
- 起動処理（composition root。T26の`src/start.ts`）はすべてをimportできる。
- 静的な`import`・`export … from`・`import()`・`require()`を読む。`import()`の引数が文字列の定数でなければ失敗にする。違反は、ファイル・行・規則を出して失敗する。

**候補:** dependency-cruiser、eslint-plugin-boundaries（ESLintが要る。4.4）、Biomeの`noRestrictedImports`（ディレクトリごとの規則を書くには設定が長くなり、型だけのimportの区別が粗い）。依存を増やさず規則をこのrepoの言葉で書けるスクリプトを採る。

#### 4.2 組み込みのカバレッジの報告（採用。T31）

**背景:** 計算や照合の分岐（未知値・0・境界）に試験のない箇所があると、テスト方針の「意図的な変異を検出できること」を確かめにくい。レビューで「この分岐は試験されているか」を毎回読み解くのは往復を増やす。

**決定:** `node --test --experimental-test-coverage`（Node.js 24ではStability 1 - Experimental）で、CIのLinuxの1つのjobだけで行・分岐・関数の割合を集め、runのSummaryに表で出す。閾値（`--test-coverage-lines`等）は当面使わない。実験的な機能で数値が版により変わりうること、閾値は数字合わせの試験を招くことが理由。domainの割合が安定したら、閾値の導入をT25で判断する。lcovのファイルをartifactとしてuploadしない（CIの方針）。CI設定を変えるので、ほかのCIの変更（Issue #19のPR #33等）と同時に行わない。

**候補:** c8・istanbul（依存が増える。Node.jsの組み込みで足りる）。

#### 4.3 未使用の検出（`tsc`は採用。T31。Knipは延期）

**背景:** 使わなくなった変数・引数・exportは、レビューで「これは何のためか」の質問を生み、古い規則が残っているように見せる。

**決定:** `tsconfig.json`の`noUnusedLocals`と`noUnusedParameters`を有効にする（依存なし。TypeScript 7でも使える）。意図して使わない引数は`_`で始める。有効にした時点のmainとopen PRで違反を直す必要があるので、着手時にopen PRの担当と時期を調整する。

Knip（6.39.0、ISC）は、未使用のファイル・export・依存まで見られるが、実行時の依存が13個とネイティブのパーサーを持つ。いまの依存は3つで、手で確かめられる。依存が増えたら（T08のReact・Viteのあと）、T25で再評価する。

#### 4.4 lint（Biome。採用。T32）と書式（延期）

**背景:** レビューの指摘のうち、待たれないPromise、到達しないコード、`console`の消し忘れ等は、機械で見つけられる。人とAIのレビューの往復を、仕様の確認に使えるようにする。`console`の検出は、1の診断ログ以外への出力を防ぐのにも使う。

**決定:** Biome（2.5系、MIT OR Apache-2.0）のlinterを、推奨の規則から、誤検出の少ない正しさの規則（`suspicious`・`correctness`の推奨と、`noConsole`、`noFloatingPromises`）に絞って入れる。

- TypeScript 7には安定したプログラム用のAPIがまだない（ADR-0002）。ESLintの型連携（typescript-eslint）はそれに依存するので、TypeScript 6の併用（`@typescript/typescript6`等）が要る。Biomeは自前の解析で動き、TypeScriptのAPIに依存しない。
- Biomeは1つのパッケージと、OS・CPUごとの実行ファイルのoptionalな依存で配られ、インストールスクリプトを持たない（`ignore-scripts`のままで動く）。lockfileに全OSの依存が載るので、ADR-0008の記録と`check:install`が、このOSで入らないoptionalな依存を正しく扱うことをT32で確かめる。
- `package.json`とlockfileを変えるので、lockfileの順（T02→T05→T26→T08）のあとに置き、ほかのタスクと同時に変えない。
- **書式の統一は延期する。** 全ファイルを整形すると、進行中のPR（T06・T14・T26等）と全面的に衝突する。進行中のPRが少ない時期に、整形だけのPRとして行うかを、T32の完了後に所有者と決める。

**検討した候補:**

| 候補 | 判断 |
| --- | --- |
| Biome（採用） | 1つの依存で、TypeScript 7と並べて使える。型を使う規則は一部（`noFloatingPromises`はtypescript-eslintの一部の場合を検出する程度） |
| ESLint＋typescript-eslint＋Prettier | 規則が最も豊富。TypeScript 7では型連携が動かず、TypeScript 6の併用と多くの依存が要る。不採用（TypeScript 7.1でAPIが安定したら再評価） |
| oxlint | 速い。型を使う規則は別の道具（tsgolint）が要り、まだ若い。延期 |
| lintなし（いまのまま） | 機械で分かる指摘がレビューの往復を占める。不採用 |

#### 4.5 Dependabot（採用。このPRで`.github/dependabot.yml`を加える）

**背景:** 依存（TypeScript、`@types/node`、Playwright）とGitHub Actions（SHAで固定）は、固定したまま放っておくと、脆弱性の修正を取り込み損ね、まとめて上げるときに大きな差分になる。actionをSHAで固定しているので、新しい版は人が探さないと見つからない。一方、2026-10-02の所有者の決定（[開発環境](../development.md)の「所有者の決定」の3）では、自動のPRがlockfile（共有資源）を変え、割当の外で作業が生まれることを理由に、Dependabotを入れなかった。2026-10-03に所有者がDependabotを含めることを承認したので、その懸念に次の設計で答える。

**設定（`.github/dependabot.yml`）:**

- npm（`/`）: 毎週月曜日の9時（Asia/Tokyo）。新しい版は公開から7日（メジャーは14日）待つ（cooldown。公開直後に乗っ取られた版が配られる事故を避ける）。minorとpatchを1つのPRにまとめ、メジャーは依存ごとのPRにする。版の更新のPRは同時に3件まで。`@types/node`のメジャーは、Node.jsのメジャー（T28）と合わせるので、版の更新から外す（`update-types`で絞り、セキュリティ更新は止めない）。セキュリティ更新は別のまとまりにする。
- github-actions（`/`。`.github/workflows/`）: 同じ曜日・時刻。7日のcooldown。すべてのactionを1つのPRにまとめる。SHAの固定と行末の版のコメントは、Dependabotがそのまま更新する。
- pip: 対象にしない。レビュー運用ツールはPythonの標準ライブラリだけで、依存の宣言のファイルがない。mise（PR #31の`mise.toml`）は、Dependabotの対象のecosystemにない（2026-10-03に一覧で確認）。
- 版の更新は、このファイルがmainにあるだけで始まる（repoの設定は要らない）。セキュリティ更新とalertは、repoの設定で有効にする（下の「所有者が確かめる設定」）。

**PRの計画の検査・マージの規則との両立:**

- Dependabotの提案のPRは、PRの計画（`.review/plans/`）を含まないので、`review plan`のjobが失敗し、`Quality gate`も失敗する。**これは意図した状態として残し、例外を作らない。** 提案のPRは、マージできる候補ではなく「更新があるという知らせ」として扱う。
- 例外を作らない理由: `github.actor`や作成者で`review plan`を飛ばすには、workflowを変える必要があり、PR自身がworkflowを変えられる限界（[修正前の整合確認](../review-prevention.md)、PR4-R001）を広げる。作成者による条件は、ほかの経路で同じ値になる場合があり、なりすましの余地がある。actionの更新はworkflowそのものを変えるので、むしろ内容のレビューが要る。
- **採用の手順**（詳細は[開発環境](../development.md)の「依存の更新（Dependabot）」）:
  1. 所有者または調整係が、採用の担当を割り当てる（タスクID`DEPS`）。セキュリティ更新は、版の更新より先に割り当てる。
  2. 担当は、最新のmainから自分のbranch（例: `task/deps-<日付>-<担当名>`）を作り、提案のPRのcommitをそのまま取り込む（lockfileを作り直さない）。Dependabotのbranchへはpushしない（ほかの担当のbranchへpushしない規約。Dependabotが自分のbranchを作り直すと、足した変更が消える）。
  3. 計画`.review/plans/DEPS-<日付>.json`を先にcommitする。npmなら`package.json`とlockfileが共有資源なので、ほかのタスク（T08等）が使っていないことを確かめる。
  4. 確かめること: 変更の内容（リリースノート）、lockfileの`resolved`が`https://registry.npmjs.org/`だけであること、新しくインストールスクリプトを持つ依存がないこと（lockfileの`hasInstallScript`）、ライセンス、`npm run setup`と3つのOSのCI。actionなら、新しいSHAが公式のリポジトリのタグを指すこと。
  5. Draft PR→別の担当（Codex側）の内容レビュー→AGENTS.mdのマージの条件、の通常の流れで進める。auto-merge・`@dependabot merge`・`@dependabot squash and merge`は使わない。
  6. 採用のPRがマージされたら、提案のPRにリンクを書いて閉じる。採用しない場合は、理由を書いて閉じる（同じ版はもう提案されない。必要なら`@dependabot ignore`の代わりに設定ファイルを変える）。
- Dependabotの提案のPRにも、Copilotのレビューが付きうる。指摘は採用のPRの計画とレビューで扱う。

**所有者が確かめる設定（このPRでは変えない。受け入れのあとに所有者が確かめる）:**

| 設定（Settings → Code security） | 提案 | 理由 |
| --- | --- | --- |
| Dependency graph | 有効のまま（publicのrepoでは既定で有効）を確かめる | alertとセキュリティ更新の前提 |
| Dependabot alerts | 有効にする | 既知の脆弱性を知らせる。PRは作らない |
| Dependabot security updates | 有効にする | 脆弱性の修正のPRを作る。採用は上の手順（計画つきの担当のPR） |
| Grouped security updates | 変えない | まとめ方は`.github/dependabot.yml`の`groups`（`applies-to: security-updates`）で決める |
| Allow auto-merge（Settings → General） | 無効のまま | auto-mergeを使わない規約 |

#### 4.6 そのほかに検討したもの

- **CIでの`npm audit`（不採用）:** Dependabot alertsと同じ情報を、ネットワークに依存する不安定なjobで重ねて得るだけになる。依存と関係のない新しい勧告でQuality gateが突然失敗し、無関係なPRを止める。
- **改行の正規化（`.gitattributes`。延期）:** WindowsのCIで改行の違いによる失敗があった（T03）。正規化を入れると既存のファイルの書き直しが起き、進行中のPRと衝突する。同じ種類の失敗が再び起きたら、進行中のPRが少ない時期に別のPRで行う。
- **Gitのhook（不採用のまま）:** 2026-10-02の所有者の決定の3のとおり。hookの設定はworktreeの間で共有され、ほかの担当に影響する。
- **CODEOWNERSとレビュー必須の保護:** T23の範囲。

## 影響

- ログ・エラーコード・診断の束で、S1〜S6の調査の材料が、実データを含まない形で決まる。T29の完了までは、いまの出力（T26の要求ログ等）のまま。
- 新しい操作を作るタスク（T07・T09・T12・T27等）は、その操作の事象とエラーコードを一覧へ足す。
- ADR-0007の適用表に、`doctor`と`diagnose`・`diagnose:real`の行を加えた。
- Dependabotの提案のPRは、計画がないのでCIが失敗したまま開く。採用は担当のPRで行う。
- lint・未使用の検出を有効にした時点で、既存のコードと進行中のPRに直しが要りうる。着手時に調整する。

## 別タスクで行う検証

- T29: 一覧にない事象・項目を捨てること。合成の金額・勤務先の名前・パス（試験の中で作る、macOS・Windowsのホームディレクトリの形の合成のパス）・トークン・例外のメッセージを渡しても、出力のどこにも現れないこと（ファイル・標準エラーの両方）。スタックの消毒（checkoutの外のフレームを残さない）。回転・保持（リンクの`logs/`や名前の規則に合わないファイルを消さないこと）、排他的な作成と本人だけの権限、書込みの失敗で操作が止まらないこと、異常終了のあとに完全な行が残ること。`uncaughtException`・`unhandledRejection`で、記録して70で終わること。エラーコードの一覧と`docs/error-codes.md`の一致、コードの重複の拒否。`src/`で、出力先の実装と起動処理のほかに`console.*`・`process.stdout.write`・`process.stderr.write`を使っていないこと。
- T09: データルートの検査（G1〜G5）に通る前に`logs/`へ書かないこと。通ったあとに書くこと。
- T30: 束に含めないものが含まれないこと（合成のデータルートに、合成のDB・証憑・`config/`・パスを置いて確かめる）。ログの再検査で、書き換えた行を捨てること。lockを取らず、状態ファイルがあっても動くこと。データルート・欠けた子を作らないこと。リンクの`logs/`を読まないこと。`diagnose`が実データのデータルートを開かないこと、`diagnose:real`がG5に通らなければ止まること。`node_modules`を消した状態でも`doctor`と`diagnose`が動くこと。`--out`の出力先の検査。
- T31: 層の規則ごとに、違反する合成のファイルで失敗し、許可するimportで通ること。カバレッジの表がSummaryに出ること。
- T32: Biomeの導入後に、3つのOSで`npm run setup`・`check:install`が通ること（このOSで入らないoptionalな依存の扱い）。
- このPRのあと: Dependabotの最初の実行で、npm（`devEngines`の版の検査を含む）とgithub-actionsの更新の確認が失敗しないこと。失敗した場合は、`devEngines`を緩めずに原因を調べる（Insightsの「Dependency graph」→「Dependabot」のログ）。

## 出典

確認日はすべて2026-10-03。

- Dependabotの設定（`groups`の`applies-to`、`cooldown`と既定の3日、対応するecosystem、`ignore`の`update-types`、`open-pull-requests-limit`はセキュリティ更新に効かないこと、`schedule`の`time`・`timezone`）: https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference
- Dependabotで依存を除外してもセキュリティ更新を止めない方法: https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/controlling-dependencies-updated
- Node.jsの試験のカバレッジ（`--experimental-test-coverage`、閾値の引数、lcov）: https://nodejs.org/docs/latest-v24.x/api/test.html
- Node.jsの`uncaughtException`のあとで処理を続けないこと: https://nodejs.org/docs/latest-v24.x/api/process.html#warning-using-uncaughtexception-correctly
- TypeScript 7のプログラム用のAPIと、typescript-eslintの対応: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ 、https://github.com/typescript-eslint/typescript-eslint/issues
- Biome（型を使うlint、`noFloatingPromises`）: https://biomejs.dev/blog/biome-v2/ 、npmの`@biomejs/biome`（2.5.15、MIT OR Apache-2.0、インストールスクリプトなし、OS・CPUごとのoptionalな依存）: https://registry.npmjs.org/@biomejs/biome/latest
- pino（10.4.0、MIT、依存）: https://registry.npmjs.org/pino/latest
- Knip（6.39.0、ISC、依存）: https://registry.npmjs.org/knip/latest
