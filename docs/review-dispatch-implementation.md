# レビュー受付の実装

Issue #45の基盤と、Issue #50のstart-smallのactive。**既定はoff。** 仕組みと認可の正本は[受付設計](review-dispatch-design.md)、マージの条件は[運用規約](github-agent-operations.md#merge-conditions)、所有者の導入と運用は[導入手順](review-dispatch-runbook.md)。

## 部品

- `scripts/lib/review-dispatch/`: 人・AI共通の判定、SQLiteのInbox・世代・PR排他・Job・Outbox、署名受付、gh取得、固定身元のReview Broker、起動器、doctor。
- `scripts/review-dispatch.ts`: CLI。引数なしはoffで、policy・DB・認証を読まない。`init`・`shadow`・`cycle`・`serve`・`doctor`・`measure`・`status`・`release`の書式は`--help`。直接起動は寿命lockがないので拒否する（`measure`を除く）。
- `tools/review_dispatch/supervisor.py`: POSIXの排他（`daemon`・`receiver`）、workerの監督（`run-worker`、macOSだけ）、状態確認（`inspect`）。Windowsでは副作用の前に拒否する。
- `tools/review_dispatch/`: `seatbelt/cli.sb`、`launchd/`の雛形、`ci-trust-digest.sh`。

実AIを起動するのは`cycle`だけ（下の表）。`fixtureCycle`は合成runner専用。

## start-smallのactive

[所有者決定 start-small](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977629581)の形だけを動かす。

| 部品 | 内容 |
| --- | --- |
| `cycle` | 照合（shadowと同じ）。policyのmodeがactiveなら、PRごとにJobを1つまで起動する。順は粗探し→レビューで、同じhead/base・同じ世代に各1回。粗探しの未解消のRT、未処理の編集の印、blocked、上限での停止のときは起動しない |
| 形 | 対象のPRは1件、必要なreviewerは1者で、Claude（`executor: claude`のAI）。Codexは`buildLaunch`と`capabilityReady`が常に拒否する |
| install記録 | ownerがrepoの外に置くJSON（policyと同じ検査）。起動器の設定、Claude Broker、python、supervisor、`runs`、`home`、workerの時間上限。supervisorとtoken wrapperは同じ信頼した写しから |
| capability | `doctor`がverifiedのときだけ記録する。起動の前に、版・実行ファイルのsha256・cli.sbのhash・argvの型のhashを今の値と照合し、どれかが違えば起動しない。cli.sbは1回だけ読み、そのbytesのhashを起動に結び付ける。受付とsupervisorが起動の直前にもう一度照合する。`doctor`と`measure`は試験のあとにhashを取り直し、変わっていればunverifiedにして何も記録しない |
| 資料 | PRの差分・headのファイル・本文、ほかの人の変更要求と未解消の指摘（`pr/open-findings.json`）、前の粗探しの記録、baseの規約（`AGENTS.md`は`agent-rules.md`へ改名）・原因台帳・書式、信頼した写しの`guard.py check`の出力。中立の名前で置く。差分も中身もないファイル（中身の変わらない改名を除く）、件数・大きさの上限超え、読めない原因台帳では起動しない（未起動として1回通知） |
| 粗探しの投稿 | [正本の書式](pr-review-loop.md#提出前の粗探し)のCOMMENT。次のどれかがあれば、レビューを起動しない: RT、未解消の前のRT、判定のない原因、「確認できない」とした原因、再確認していない前のRT、計画があるのに信頼した写しの`guard.py check`が合格しなかったこと（終了1は`guard-refused`、それ以外は`guard-unavailable`）、needs-owner |
| 前のRTの数え方 | policyに登録した参加者の記録の本文にある`RT-<番号>`をどこでも数え、記録ごとにも再確認する（`previous`のIDは`record-comment-<ID>`か`record-review-<ID>`で、その回の資料にある記録だけ）。印が1行目にない記録は記録として扱わない。未登録の人の記録は資料にも根拠にも入れない |
| APPROVEの前の確認 | `accepted()`と同じ止め方（[未解消の指摘](#未解消の指摘pr48-r007)と、登録したほかの参加者の最新のCHANGES_REQUESTED）に当たれば、`decision: needs-owner`のCOMMENTにし、止めたIDを本文に書く |
| 編集・削除の印 | Webhookの`pull_request_review`（edited・dismissed）、`pull_request_review_comment`・`issue_comment`（edited・deleted）のうち、登録した参加者（実装担当を除く）とownerの項目に、受信と同じtransactionで付く。投稿の前に印があれば照合をやり直し、3回で消えなければ結果とleaseを保ったまま`deferred`にして1回通知する。次の`cycle`は、新しい起動の判定より先に同じJobを投稿する（再起動しない。capabilityの照合より前） |
| 終了の証明 | supervisorは正常終了のあともprocess groupが空であることを確かめる。run-keyを受けていないかackを送っていないrun、manifestがなくrun lockが空いているrunは未起動として扱う |
| `serve` | Webhookの受け口（127.0.0.1、1024〜65535で443以外）。`supervisor.py receiver`の別のlockで1つだけ動き、inboxと印だけを書く。保存したら`<root>/trigger`の時刻を変える（launchdのWatchPaths用）。policyは署名を確かめた配送ごとに読み直す（[policyの更新](#policyの更新と受け口の503)） |
| `status`・`release` | 状態の表示（IDと件数）。`release`はsupervisorの`inspect`の証明で終わったrunのleaseを外す。不明な投稿があれば外さない |
| `measure`・`doctor` | ownerだけが実CLIで行う測定と否定試験。CIでは偽物の部品で試験する |

## 結果の署名と投稿

Brokerの身元と隔離の規則は[受付設計](review-dispatch-design.md)の§6・§7が正本。

- supervisorがrunごとに一度きりの鍵（SHA-256のLamport署名）で結果に署名する。鍵はsupervisorのメモリにだけ置く。
- supervisorは鍵の約束値を、workerの起動前に標準出力で受付へ渡す。受付は`run_keys`に保存してから`ack`を返し、supervisorは`ack`を受けてからworkerを起動する。再起動後は`loadVerifier`がDBから検証する。
- 受付とBrokerは`provenance.ts`の`RunVerifier`で検証だけを行う。封ができる`RunChannel`は`tests/fixtures/`だけに置く。
- `supervisor.py run-worker`は、cwd・HOME・TMPDIR・config dirがrootと重なれば拒否する。runごとの領域はinstall記録の`runs`に作り、終わったら消す。
- Claude Broker（`claude-broker.ts`と中継`scripts/review-dispatch-claude-broker.ts`）は、token wrapperを`--agent claude --purpose review`に固定する。submitごとに1回起動して閉じ、POSTは1回まで。
- Brokerは`canonicalBody` → 公開検査 → 本文hash → POSTの順に処理する。検査は投稿する正規化後の本文に掛ける。

公開前の検査（`publication.ts`）は緩和で、保証ではない。秘密を読めないことの保証はdoctorの否定試験（`deny-supervisor`を含む）が担う。

| 項目 | 内容 |
| --- | --- |
| 検査する場所 | `parseResult`、DBへの保存の前、投稿直前の本文 |
| 許すリンク | `https://`で、hostが次のどれかに完全一致し、user情報とportがないもの: github.com、docs.github.com、code.claude.com、nodejs.org、learn.chatgpt.com、playwright.dev、vite.dev、www.nta.go.jp、www.soumu.go.jp（[所有者決定](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5978676604)。github.com以外は、過去の公開本文が引いた公式文書） |
| 拒否するもの | `check-public`の規則、鍵・tokenの形、長い不透明な文字列、ローカルの私的な絶対パス（`/usr/bin`等のsystemのパスは許す）、許可一覧の外のリンク、%符号化、書式文字（`\p{Cf}`）。NFKCの後に検査する |
| 許すID | 受付・Brokerが取り直したsnapshotのhead/baseとrun IDだけ |
| evidence | `actions/runs/<数字>`、`pull/<n>#pullrequestreview-<数字>`、PRのcommitへの`commit/<SHA>`だけ |

過去の公開v1本文143件で、止まる本文は3件（`file://`の記述と`example.invalid`の試験用URL）。

`blocked`は持続するneeds-owner。

- 検査に当たった結果と、`parseResult`が内容で拒否した結果が対象。形の不正は`uncertain`のまま。
- 受付は投稿もOutboxの行も作らず、DBには結果のhashだけを残し、ownerへ1回通知する。
- leaseを外しても残り、ownerの`review:paused`の解除（blockより後）だけで消える。
- 受付はRunnerの`redact`で署名済み封筒をhashと署名だけにする（形の不正でも行う）。fixture以外のRunnerでは`redact`が必須。失敗したらownerへ通知する。

## 未解消の指摘（PR48-R007）

GitHubのREST APIにはスレッドの解決状態がなく、書込み権限のある人（実装AIのAppやownerを含む）はReviewのdismissやコメントの編集・削除ができる。そのため、入力を1つの規則にまとめて安全側に倒す。実装は[findings.ts](../scripts/lib/review-dispatch/findings.ts)。

- **挙げられる人:** policyに登録した参加者（ownerと、割り当てたreviewer以外も含む。そのPRの実装担当と同じ`person`の人は除く。[所有者決定](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5978984980)）。全員が同じ規則で挙げ（ownerのCOMMENTのReview・行コメント・会話コメントも数える）、だれもほかの人の指摘を解消できない。登録していない第三者のコメントは参考で、判定を変えない。`accepted()`、APPROVEの前の確認、Webhookの印は、この同じ範囲を使う。
- **Review本文:** 行頭の`PR<N>-R<3桁以上>`（このPRの番号だけ。`> `の引用行と文中の言及は除く）。IDのないCHANGES_REQUESTEDとDISMISSEDは`review:<ID>`。
- **行コメント:** すべて指摘（IDがなければ`comment:<ID>`）。編集されたものは、更新時刻に`comment:<ID>`も挙げる。
- **会話コメント（PRのconversation）:** 行頭ID。IDがなく、`decision:`の行の値が`accepted`以外なら`issue:<ID>`。編集されたものは`issue:<ID>`も挙げる。
- **観測の記録:** 項目ごとに、最初に観測した本文のhashと指摘IDを専用DBへ不変の記録として残す（重複排除に直前のhashを含め、前の内容へ戻した編集も見つける）。後で消えた項目は`deleted:<項目>`、本文が変わった項目は`edited:<項目>`を、その観測の時刻（行コメント・会話コメントは更新時刻）で挙げる。Review本文の編集はREST APIでは時刻が分からないので、この比較だけで見つける。照合の`observedAt`は応答のDateの最大値。最初の観測より前の削除は照合では見えず、Webhookの印で補う。
- **解消:** 同じ人の、より後の、**現在のheadのcommitへの**APPROVEDだけ。本文の「解消」、別の人、古いcommitへの承認、dismissは解消しない。同時刻や、承認したReview自身の指摘は解消しない。
- 未解消の指摘は、割り当てたreviewerの最新のReviewに付き（ほかの参加者とownerの指摘は全員のReviewに付く）、`accepted`を止める。shadowの観測にはIDだけを記録する。

## workflowの信頼（PR48-R008）

範囲は所有者の決定（[受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977404200)、`.npmrc`は[追加の受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977523656)）で、CIの判定を決めるファイル: `.github/`の全体、`.npmrc`、`package.json`、`tools/review_guard/`、`scripts/check-test-skips.ts`とそれが読む部品（`scripts/lib/test-skips.ts`と、飛ばしてよい試験の表がある`docs/development.md`）。試験の中身（`tests/`の下、`*.test.ts`、`test_*.py`）は含めず、独立した内容レビューで守る。範囲の正本は[github.ts](../scripts/lib/review-dispatch/github.ts)の定数`CI_TRUST_PATHS`と`CI_TRUST_EXCLUDED`で、広げる・狭めるときはここだけを変える。必須ジョブは`.github/workflows/ci.yml`のrunだけから数える（判定は固定11ジョブ。commit status・check runは補助）。

1. 範囲のファイルを変えるPRは、CIが成功してもunknown（`unknown-evidence`）で止まる。
2. ownerは差分の独立レビューを確かめ、mainとPRのheadで要約を求める。信頼した写しの`tools/review_dispatch/ci-trust-digest.sh`を使う（`git -c core.quotePath=false ls-tree -r -z`の行を範囲で絞り、パスのバイト順に並べたSHA-256。合成repoで`ciTrustDigest`と一致することを試験している）。`${copy}`は信頼した写し、`${repo}`はmainとPRのheadを取得したcheckout、`${base}`はmainの先端、`${head}`はPRのhead。

   ```sh
   main_digest="$(sh "${copy}/tools/review_dispatch/ci-trust-digest.sh" "${repo}" "${base}")"
   head_digest="$(sh "${copy}/tools/review_dispatch/ci-trust-digest.sh" "${repo}" "${head}")"
   print -r -- "{\"main\": \"${main_digest}\", \"head\": \"${head_digest}\"}"
   ```

3. owner管理のpolicyの`trustedCi`へその組を加え、`revision`を上げる。revisionが変わるので、**開いているすべてのPR**で新しいDraft→Readyが要る。信頼を記録する前に届いたReadyも、後から結び付けない。W3の`trustedCiDigests`（mainに結び付かない形）はpolicyの検査で拒否する。
4. 記録はmainに結び付く（[所有者決定](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5978676604)）。mainの範囲のファイルが変われば、同じheadの内容でも記録し直す。以前に信頼した古い設定へ戻すPRも、今のmainとの組がなければ通らない。不要になった組はpolicyから外す。

## host検査（PR48-R009〜R011）

実装は[host.ts](../scripts/lib/review-dispatch/host.ts)とstore.ts。同じOSユーザーの悪意あるprocessへの境界ではない（設計§7のO3）。

- **policyとroot（R010）:** POSIXで、policyはrepo・worktreeと信頼した写しの外、実行ユーザーの所有、group/otherが書けない、symlink・ハードリンクなしの場合だけ、検査したfdから読む。install記録・測定の記録も同じ。専用rootは実行ユーザーの所有で0700相当、DB/WAL/SHMと寿命lock（rootの親の`.kurashi-dispatch-*.lock`）は0600相当、祖先は本人かrootの所有で、他人が書けるならsticky。違えば権限を直さずに起動を拒否する。製品DBと共有せず、symlinkや別名のrootを使わない。**macOSのACLは見ない**ので、ownerが[導入手順の7](review-dispatch-runbook.md#7-権限とaclを確かめる)で確かめる。
- **時計の後退（R009）:** 許容幅は所有者決定の5秒。5秒以内は保存時刻を使い続け、DBの時刻は戻さない。超えると受信は503、claim・retainは拒否、CLIは待つ秒数を表示して終了コード3。ownerはworkerを増やさず、時計（NTP）を確かめて追いつくのを待つ。
- **時計の先への飛び:** その時刻が保存され、時計を戻した後は追いつくまで受付が止まる。24時間の起動上限の窓も先へ進む。誤った時刻で動いたと分かったら受付を止めて記録を確かめ、待てなければ停止状態のbackupと独立レビューした手順で切り替える。DBの時刻を手で戻さない。
- **大きな配送（R011）:** 256KiBを超える署名付き配送は本文を保持せず、HMACを流しながら確かめてdelivery IDとeventだけを残し、413を返す。照合のあとCLIがevent名と件数を一度だけ知らせる。Brokerは改行・行末空白・NFCを整えた本文だけを投稿し、同じmarkerでhashが違う投稿があればuncertainに保持して再送しない。

## policyの更新と受け口の503

- **policyの更新:** revisionを上げるときは`readyAfter`を切替の時刻にする。前のrevisionの最後の観測より後でなければ、照合は終了コード4で止まり、受け口は配送を503にする。受け口は署名を確かめた配送ごとにpolicyを読み直すので、再起動は要らない（repo・installation・App IDを変えるときは再起動する）。
- **受け口の503が続く:** 受け口のログの理由（`policy-unreadable`・`policy-identity-changed`・`ready-after-not-moved`、理由ごとに1回。配送を保存できれば次の失敗でまた出る）を見て、policyの権限・内容、またはreadyAfterを直す。直すまでの配送は保存されないので、GitHubのApp設定から再配送するか、新しいDraft→Readyにする。

## shadowの照合

shadowは取得・判定・記録だけで、AIの起動と投稿は0件。

- 署名Inboxの未処理分を再取得したtimeline/Reviewへ結び、成立pairと配送tombstoneを同じtransactionで保存する。PRの全commitの一覧（`Snapshot.commits`）も取り込む。
- APIのactivity連鎖がbranch作成から現在headまで揃う場合だけ、pushした身元を証明する。古い履歴が欠ける移行では、ownerがpolicyの担当欄`identity`へ検証済みactivity ID・head・server時刻・過去push参加者を指定し、APIにもそのanchorが残ることを照合する。commitのauthorや日付で補完しない。
- Webhook欠落は、保存した観測より後のReady/Reviewを、同じpolicy・pair・完全なactivity履歴・pushのない観測区間でのみ回復する。初回観測・base更新・履歴欠落では過去eventへ現在のSHAを付け直さず、新しいDraft→Readyを要求する。
- 観測区間・成立pair・世代変更の証跡を保存し、現行v1引継ぎとの差も`shadow`表へ記録する。この比較は起動の許可にならない。

## PR48-R013〜R016（W4c、[#58](https://github.com/doc-gif/kurashi-ledger/pull/58)）

| 指摘 | 内容 |
| --- | --- |
| R013 | 取得の途中でPR・その状態・mainが変わった、commitの一覧が足りないか件数を確かめられない、branchの履歴が不完全、のどれかでは、その対象の観測・結合・処理済みの印を保存せず配送を残し、後の照合で結び付けるか回復する。1時間続けば所有者に1回知らせる。配送には受けたときのpolicyのrevisionを記録し、同じrevisionで、かつ`readyAfter`より後のReady・Reviewだけを結び付ける。記録のない配送は結び付けない。恒久の原因（変わらないpairでのworkflowの未信頼、一覧の上限250件を超えるPR、repoの外のhead）なら処理し、結び付けない。件数のある一覧（workflow run・job・check run）は`total_count`がなければ取得失敗 |
| R014 | 受付自身の粗探しJobの記録を判定に使う（W4a）。観測にaccepted()と現行の`decision: accepted`の比較（`acceptedDiffers`）と、担当reviewerの人の手動の記録の読取り（`該当なし`以外の判定と、`解消`・理由付きの`対応不要`で閉じていないRTを未解消）がある。人の記録は、台帳の網羅・前の記録の確かめ直し・readyAfterをAI側とそろえるまで**比較だけ**に使い、判定の門を開けない |
| R015 | quotaの停止とblockedは時刻「未定」で作り、作った後に始まった照合（同じcycleで1回取り直す）のserver時刻で確定する。ownerの解除（timelineの時刻）は確定した時刻より後のものだけ数える。`status`に「停止の時刻が未確定」が出ていないことを確かめてから、`review:paused`を付けて外す。確定前の解除は数えないので、やり直す |
| R016 | 観測の履歴は時刻のほかが前回と同じなら足さず、PRごとに新しい200行まで残す。照合のあとに`retain`を呼び、設計の保持期限（payload 7日、完了Jobの詳細30日）を効かせる |

## 故障時

launch/POST不明は`uncertain`に残し、期限切れで再起動・再送しない。Outboxは全ページから身元・commit・marker・本文hashが一致する1件を確認して初めてpostedになる。複数一致はownerへ保留する。

`supervisor.py inspect --root <専用ルート> --run <run ID>`は既存runの状態確認だけで、会話を再開しない。lockが取れるだけ、PIDが存在しないだけではleaseを解放しない。途中のmanifest・起動境界は不明として保持する。正常終了のあとも、workerのprocess groupに残る子があればgroupごと止め、空になったことを確かめてから終了を証明する（setsidで抜けた子孫はrun lockの継承で見つける）。`measure`は子を作るrunで継承を実測し、観測した子のすべてで確かめられたときだけ`descendantLock`をtrueにする。1つでも未検査・失敗・処理中の子があるか、groupの列挙に1回でも失敗したか、子を観測できなければfalse。

DBはWAL/FULL同期、schema 5（W4で`blocked`・`run_keys`・`capability`・`marks`・`run_materials`とjobsの`origin`を足し、W4cでquota・blockedの時刻をserver時刻にし、`holds`とinboxの`policy`を足した）。`PRAGMA secure_delete`とcheckpointでWAL・空きページの旧値を消す。schema 1〜4からの暗黙の変換はせず（停止状態のbackupと独立レビューを受けた移行が要る）、未知schemaは書き込まず停止する。`Store.backup`はleaseと不明Outboxがない停止状態でSQLiteの整合したコピーを作り、既存コピーを上書きしない。ライブDB単体のコピー、稼働中の復元、暗黙のmigrationは提供しない。復元・版更新は全worker停止と不明副作用の解決後に、コピーを別の専用rootで確認してownerが切り替える。以前のDBを消さず、古い配送ID・quota・投稿hashを保つ。schema 5は実機のshadowの前の変更なので、残すべきschema 4のDBはない。あれば新しい専用rootをinitし、対象PRは新しいDraft→Readyにする（配送IDと使用済みの記録は引き継がない）。

## 検証の読み方

| 設計の条件 | 自動検査 |
| --- | --- |
| D01/D04/D05/D06 | reducer: 役割入替え、複数reviewer、base/Ready/履歴、試験mergeの親/tree、CI・独立性・dismissal |
| D02/D03/D08/D09 | 実SQLite: tombstone、transaction、全種類PR lease、10枠/実行先枠、24時間6回とowner解除まで保持するquota pause、世代の取消、不明POST・通知の重複 |
| D03/D09/I009 | POSIX fixture: supervisor死亡、setsid子孫の継承lock、取消、同一runへの再接続。Windowsは未対応を検査しskipしない |
| D05/D07/I003/I004 | fake ghの全ページ/ETag/rate limit/部分失敗、Inbox結合のatomic rollback・欠落回復・activity身元・shadow差分、raw署名、body上限、localhost HTTP、durable保存失敗 |
| D06/D07/D10 | run/身元/pair/結果hashの照合、supervisor署名の相互試験ベクトルと改ざんの拒否、公開前の検査、厳格な結果schema・protocol/mention偽装拒否、固定Broker、環境allowlist、未確認capability・active拒否 |
| I007 | `dispatch-read`の正確なread-only grant、追加write/missing grantではgh起動0 |
| PR48-R007〜R011 | 未解消の指摘の規則（会話コメント・owner・第三者・dismiss・編集/削除の観測記録・古いcommitの承認・同時刻）、CIの判定を決める範囲の要約とowner信頼・範囲の内外・ci.yml以外のrun、時計の後退、policy/root/DB/WAL/SHM/lockの所有者・権限・リンク、過大な配送の印、本文の正規形とhash不一致のuncertain |

TypeScriptは`npm test`、Pythonは`.review/tests/test_dispatch_supervisor.py`を既存CIで実行する。秘密・実AI・実Appをfixtureへ渡さない。実AIのRead/Grep/Glob/shellでの否定試験を、環境変数の単体試験で「合格」とは扱わない。

## 残り

| 項目 | 状態 |
| --- | --- |
| 実機の測定（I001/I008/O2のdoctor・measure、I003/I004/O1の配送と遅延、I009の子孫、PR48-R011の配送の大きさ・トンネル経由で5秒以内か・本文が変わるか） | ownerが[導入手順](review-dispatch-runbook.md)の8・9・13で行い、Issue #50に記録する |
| PR48-R006 / I003 | activeの前に、配送のbase.shaとtimeline・updated_atの実際の値を測る（[導入手順](review-dispatch-runbook.md)の13の4。未完了なら14の3が止める）。結合できなければunknownを保ち、結合の規則を独立レビューで直す |
| I010 | App作成PRのCopilotの応答は任意の補助情報。起動・マージの条件に戻さない |
| I011 | 共有された従来アカウントの身元移行。結合と照合のコードはある。実repoの`identity`の設定は未検証 |
| PR48-R014の`unresolvedDesign`の専用の取得元 | activeの前に作らない（[所有者決定](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5980777385)） |
| 通知Broker（Codex AppのPRコメント） | 作っていない。start-smallの周知は調整係の受領記録と受付のログで行う（[切替](pr-review-loop.md#切替prごと)の4はどちらかでよい）。作るときは同じ公開検査を掛ける |
| Codexの自動起動、auto-fix、旧workerとの自動の交代 | 無効（[設計§7](review-dispatch-design.md#7-workerの隔離と往復上限)）。受付はマージしない |
