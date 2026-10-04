# レビュー受付の実装と導入前の確認

Issue #45の基盤です。**既定はoff、実AI・本番通知・修正pushは無効**です。現行の5分確認を置き換えません。仕組みと認可の正本は[受付設計](review-dispatch-design.md)、現在のマージ条件は[運用規約](github-agent-operations.md#merge-conditions)です。

## 今回使える部分

- `scripts/lib/review-dispatch/`: 人・AI共通の判定、SQLiteのInbox/世代/PR排他/Job/Outbox、署名受付、gh取得、固定身元のReview Broker、実行境界。
- `scripts/review-dispatch.ts`: offと、owner管理policyを使った一度のshadow照合。shadowは取得・記録だけで、AI・投稿は0件です。
- `tools/review_dispatch/supervisor.py`: POSIXの受付排他、合成workerの独立監督・取消・同一runの状態確認。Windowsで起動すると副作用前に拒否します。

実AIを起動するCLIは提供しません。`fixtureCycle`は合成runner専用です。Review Brokerのnative APIアダプタは、独立レビュー後の固定版と身元ごとの縮小tokenを使う境界です。このPRから実鍵を使って起動・投稿しないでください。

### 結果の署名と投稿

Issue #50 W2の部分です。Brokerの身元と隔離の規則は[受付設計](review-dispatch-design.md)の§6・§7が正本です。

- supervisorがrunごとに一度きりの鍵（SHA-256のLamport署名）で結果に署名します。鍵はsupervisorのメモリにだけ置きます。
- supervisorは鍵の約束値を、workerの起動前に自分の標準出力で受付へ渡します。受付はmanifestやroot内のファイルの値を使いません。
- 受付とBrokerは`provenance.ts`の`RunVerifier`で検証だけを行います。封ができる`RunChannel`は`tests/fixtures/`だけに置きます。
- Claude Broker（`claude-broker.ts`と中継`scripts/review-dispatch-claude-broker.ts`）は、token wrapperを`--agent claude --purpose review`に固定します。submitごとに1回起動して閉じ、POSTは1回までです。

公開前の検査（`publication.ts`）は緩和で、保証ではありません。秘密を読めないことの保証はW1の否定試験（`deny-supervisor`を含む）が担います。

| 項目 | 内容 |
| --- | --- |
| 検査する場所 | `parseResult`、DBへの保存の前、投稿直前の本文 |
| 拒否するもの | `check-public`の規則、鍵・tokenの形、長い不透明な文字列、ローカルの絶対パス、github.com以外のリンク、%符号化、書式文字（`\p{Cf}`）。NFKCの後に検査する |
| 許すID | 受付・Brokerが取り直したsnapshotのhead/baseとrun IDだけ |
| evidence | `actions/runs/<数字>`、`pull/<n>#pullrequestreview-<数字>`、PRのcommitへの`commit/<SHA>`だけ |

`blocked`は持続するneeds-ownerです。

- 検査に当たった結果と、`parseResult`が内容で拒否した結果が対象です。形の不正は`uncertain`のままです。
- 受付は投稿もOutboxの行も作らず、DBには結果のhashだけを残し、ownerへ1回通知します。
- 受付はleaseを保持し、ownerが解除するまで同じPRで起動しません。
- 受付はRunnerの`redact`で署名済み封筒をhashと署名だけにします（形の不正でも行う）。fixture以外のRunnerでは`redact`が必須です。失敗したらownerへ通知します。

## offとshadow

対応Nodeで次を実行できます。

```sh
node scripts/review-dispatch.ts
node scripts/review-dispatch.ts --help
```

offはpolicy・DB・認証を読みません。shadowの前に、repo外の専用ディレクトリとowner管理policyを用意します。製品DBと共有せず、symlinkや別名のルートを使いません。policyの型は[model.ts](../scripts/lib/review-dispatch/model.ts)を正本とし、repo/installation ID・身元・同一人物対応・担当・revision・その変更を区切るserver時刻`readyAfter`・mode・実行先枠を指定します。値はrepoへ保存しません。

DB初期化と照合は、絶対パスの固定Node・レビュー済みの写しをPOSIX wrapperから起動します（`--help`に書式があります）。直接起動は寿命lockがないため拒否します。shadowは**token wrapper → supervisor daemon → Node受付**の順で、`--help`のshadow書式を使います。wrapperの`--app-id`と`--installation-id`は値を引数で渡し、受付には固定した絶対パスの`--gh`が必須です。shadowのtokenは[App手順](github-apps.md)の`dispatch-read`用途から渡します。daemonは縮小`GH_TOKEN`だけを子の受付へ明示して通し、workerの`run-fixture`には認証を通しません。candidateのトークンスクリプトを実鍵で試してはいけません。

shadowは署名Inboxの未処理分を再取得したtimeline/Reviewへ結び、成立pairと配送tombstoneを同じtransactionで保存します。APIのactivity連鎖がbranch作成から現在headまで揃う場合だけ、pushした身元を証明します。古い履歴が欠ける移行では、ownerがpolicyの担当欄`identity`へ検証済みactivity ID・head・server時刻・過去push参加者を指定し、APIにもそのanchorが残ることを照合します。commitのauthorや日付で補完しません。

Webhook欠落は、保存した観測より後のReady/Reviewを、同じpolicy・pair・完全なactivity履歴・pushのない観測区間でのみ回復します。初回観測・base更新・履歴欠落では過去eventへ現在のSHAを付け直さず、新しいDraft→Readyを要求します。観測区間・成立pair・世代変更の証跡を保存し、現行v1引継ぎとの差も`shadow`表へ記録します。この比較は起動の許可になりません。

署名受付は`serve`のlocalhost/shadow用APIです。raw body上限、HMAC、repo/install/eventを検査し、SQLite保存後に202を返します。外部URL、購読、秘密の設定はownerの導入作業です。公開endpointを起動しません。

## 故障時

launch/POST不明は`uncertain`に残し、期限切れで再起動・再送しません。Outboxは全ページから身元・commit・marker・本文hashが一致する1件を確認して初めてpostedになります。複数一致はownerへ保留します。

`supervisor.py inspect --root <専用ルート> --run <run ID>`は既存runの状態確認だけで、会話を再開しません。lockが取れるだけ、PIDが存在しないだけではleaseを解放しません。合成backendでも途中のmanifest/起動境界は不明として保持します。実CLIの子孫へのFD継承は導入前の実測が必要です。

DBはWAL/FULL同期、schema 2です。schema 1からの暗黙の変換はせず、停止状態のbackupと独立レビューを受けた移行が必要です。未知schemaは書き込まず停止します。`Store.backup`はleaseと不明Outboxがない停止状態でSQLiteの整合したコピーを作り、既存コピーを上書きしません。ライブDB単体のコピー、稼働中の復元、暗黙のmigrationは提供しません。復元・版更新は全worker停止と不明副作用の解決後に、コピーを別の専用ルートで確認してownerが切り替えます。以前のDBを消さず、古い配送ID・quota・投稿hashを保ちます。

## 検証の読み方

| 設計の条件 | 自動検査 |
| --- | --- |
| D01/D04/D05/D06 | reducer: 役割入替え、複数reviewer、base/Ready/履歴、試験mergeの親/tree、CI・独立性・dismissal |
| D02/D03/D08/D09 | 実SQLite: tombstone、transaction、全種類PR lease、10枠/実行先枠、24時間6回とowner解除まで保持するquota pause、世代の取消、不明POST・通知の重複 |
| D03/D09/I009 | POSIX fixture: supervisor死亡、setsid子孫の継承lock、取消、同一runへの再接続。Windowsは未対応を検査しskipしない |
| D05/D07/I003/I004 | fake ghの全ページ/ETag/rate limit/部分失敗、Inbox結合のatomic rollback・欠落回復・activity身元・shadow差分、raw署名、body上限、localhost HTTP、durable保存失敗 |
| D06/D07/D10 | run/身元/pair/結果hashの照合、supervisor署名の相互試験ベクトルと改ざんの拒否、公開前の検査、厳格な結果schema・protocol/mention偽装拒否、固定Broker、環境allowlist、未確認capability・active拒否 |
| I007 | `dispatch-read`の正確なread-only grant、追加write/missing grantではgh起動0 |

TypeScriptは`npm test`、Pythonは`.review/tests/test_dispatch_supervisor.py`を既存CIで実行します。秘密・実AI・実Appをfixtureへ渡しません。実AIのRead/Grep/Glob/shellでの否定試験を、環境変数の単体試験で「合格」とは扱いません。

## owner導入まで未検証・無効の部分

- I001/I008/O2/O3: 固定CLIの実版・認証・費用、実ツール経路からの鍵/gh認証/他AI認証/DB/ネットワーク拒否、host隔離・keychainの残余リスク。
- I003/I004/O1: 公開HTTPS経路、App購読・署名配送・redelivery、15分backstopの遅延/呼出し数比較。shadowは1回照合で、定期実行を変更しません。
- I009: 実AIの全子孫へのFD継承、取消・OS再起動・process tree終了の実測。未確認backendを有効にしません。
- I010: App作成PRのCopilot依頼・応答の実測は任意の補助情報です。応答や利用枠を起動/マージの条件に戻しません。
- I011: 共有された従来アカウントの身元移行。ownerがactivity anchorと過去push参加者を検証し、policyの同一人物対応・server境界を設定する。結合と照合のコードは今回追加済み。実repoのmigration設定は未検証。
- PR48-R003: [結果の署名と投稿](#結果の署名と投稿)で実装しました。実backendは、[W4で必ず行う項目](#w4で必ず行う項目)の1・2・5、W1の`deny-supervisor`、owner導入がそろうまで無効です。
- active、auto-fix、GitHub通知、実Broker接続、旧workerとの交代・rollbackはownerの設定と別の正本移行PR後。dispatcherはマージしません。

導入待ちはIssue #45の基盤受入と分けます。基盤のCIとClaudeの独立accepted後に完了を判定し、残る担当レビューを既存の設定で再開します。

### 独立レビューからの導入前チェック

| 指摘 | 必須の時期・確認 |
| --- | --- |
| PR48-R006 / I003 | 実Webhook接続前: payloadのbase.shaとtimeline/updated_atの実際の値を配送で測る。結合不能ならunknownを維持し、binding規則を独立レビューで直す |
| PR48-R007 | active前: 許可されたreviewerのCOMMENT・行スレッドの未解消指摘を構造化して判定へ接続する。現collectorの空findingsで受入を完了させない |
| PR48-R008 | active前: commit status/check runは補助取得、現判定は固定11ジョブ。workflow差分は意図的にunknownで停止し、独立レビュー済みworkflow信頼の移行手順を用意する |
| PR48-R009 | 実host shadow前: 時計の後退で503/claim拒否になる。workerを増やさず時計・記録を確認し、保存時刻へ追いついてから再開する。DB時刻を戻して回避しない |
| PR48-R010 / I008 | 実host shadow前: policyがrepo/worktree外でownerだけが書けること、専用root/DB/WAL/SHMの所有者・権限を検査し、不適切なら起動を拒否するhost検査を追加・試験する |
| PR48-R011 / I003 | 公開配送前: 256KiB上限を超えるイベントの扱いとGitHub本文の正規化を実測する。hash一致しないPOSTはuncertainに保持し、再送しない |

### W4で必ず行う項目

Issue #50 W2から引き継ぐ項目です。

| # | 項目 | 理由 | 時期 |
| --- | --- | --- | --- |
| 1 | `blocked`をPRごとの状態としてDBに持ち、ownerの解除だけで消す | 今はleaseの`uncertain`で止めるだけ。store.tsはW3が変更中 | active前 |
| 2 | 鍵の約束値をjobに永続化する | 受付の再起動後に検証できない（今は`uncertain`のまま） | 実runner接続前 |
| 3 | #52の`canonicalBody`の後に、検査と本文hashを掛ける | 正規化の前に検査すると素通りしうる | #52とW2を統合するとき |
| 4 | 通知Broker（Codex AppのPRコメント）にも同じ検査を掛ける | 通知も公開repoへ書く | 通知の実装時 |
| 5 | workerのHOME/TMPDIRをsupervisorのrootから分け、封筒と約束値をworkerから届かない場所へ移す。実backendの署名はmacOSに限る | 今のworkerはrootに書ける | 実runner接続前（W1と調整） |
| 6 | 過去の公開v1本文で誤検知を試験する | 正当なレビューを止めないため | active前 |
| 7 | PRの全commitの一覧をsnapshotへ取り込む | 今はpair・timelineにないcommitのリンクで止まる | active前 |
| 8 | SQLiteのWAL・空きページの旧値を消す（`PRAGMA secure_delete`、checkpoint） | 置き換え前の平文が残りうる | active前 |
