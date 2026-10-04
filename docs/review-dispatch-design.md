# 人・AI共通のレビュー受付（設計案）

状態: **設計受入済み。default-offの[実装と導入前チェック](review-dispatch-implementation.md)を追加し、独立レビュー待ち**。[Issue #45](https://github.com/doc-gif/kurashi-ledger/issues/45)は、default-offの基盤実装・検証・Claudeの独立レビューで完了する。本導入は所有者の設定後に分ける。Codexが設計から実装まで担当し、設計acceptedのあとに実装PRへ進む。設計PR #46は完了。最後の実装PRだけでIssueを閉じる。

通常のプログラムがGitHubの状態・認可・重複を判定し、条件が揃った仕事だけを人・AIへ渡す。Webhookを入口、15分ごとの照合を取りこぼし対策にする案。導入までは現在の5分確認と[PR書式](pr-review-loop.md)を使う。以下のactive規則はまだ現行規約を置き換えない。

## 1. 標準操作と認可

所有者管理のrepo外policyで、repo ID、許可PR/Issue、owner・implementer・reviewerのGitHub user/App ID、同一人物の対応、実行先、予算、modeを固定する。slug・本文のrole・ラベル・AIの転記は権限を発行しない。人とAIの役割を入れ替えても同じ表を使う。

| 操作 | 許可する身元 | 正本の証跡と動作 |
| --- | --- | --- |
| 非Draft作成、Draft→Ready | そのPRのimplementerまたはowner | PR作成者/作成時刻、timelineのready_for_review ID・actor・時刻。§2でpairへ結び付ける |
| Request/Re-request review | implementerまたはowner | timelineの依頼actorとreviewer。準備・CIが未完了なら保留 |
| Draftへ戻す | policyの許可参加者 | timelineのconvert_to_draft。安全側にReadyと進行中の結果を無効化 |
| review:pausedを付ける | policyの許可参加者 | timelineのlabeled actor。起動・結果採用・投稿を停止 |
| pauseを解除する、担当/policyを変える | ownerだけ | timelineのunlabeled actorとowner管理設定のrevision。解除だけではReadyにならない |
| Review・行指摘を修正入力にする | policyのreviewer集合に属する独立参加者 | 再取得したReview/コメントのuser IDとcommit。第三者のCOMMENTは参考の不信データとして分け、修正Jobを起動しない |

Webhook経由では署名済みpayloadのsender.idと、再取得した対応eventのactorを照合する。食い違いは拒否する。照合だけの回復ではAPIの認証済み履歴と保存済み証跡を使い、Webhookの存在を必須にしない。観測したDraft/pauseはactor不明でも安全側に停止するが、解除・Ready・起動の許可は作らない。不正なラベル解除後もローカルpauseを維持する。

人はDraft→Ready、レビュー依頼、Approve/Request changesという標準操作を使う。SHAやAIテンプレートの転記は不要。検証はCI、意図・残件はPR本文で共有する。一般コメントの「完了」や依頼だけをReadyにしない。Appは身元であり役割ではない。App botへの標準Request reviewが使えない場合は、ownerが指定したApp実行先へReadyを配信する。人にAIのJobを起動しない。

## 2. 対象とReadyの証明

**baseは対象固定時のmain先端SHA**、headは再取得したPR先端SHA。PR APIのbase.shaやmerge-baseをbaseの代わりに使わない。base branchがmain以外・retarget中なら拒否する。main、PR、compare、必要履歴を一組として取得し、compareのmerge_base_commitがbaseで、headがbaseを含むことを確認する。取得の前後でpairが変われば固定をやり直す。

Ready証跡はevent ID・actor・GitHubのserver時刻・head/base・policy revision・generation。作成はPR ID＋created_atを識別子にする。署名配送は取得のきっかけであり、payloadの一致だけでReadyを発行しない。

Readyは最後のhead変更、convert_to_draft、担当変更、pause解除より後でなければならない。mainの更新は保存済みpairを失効させ、取り込み後の新しいReadyを要求する。非Draft作成も作成者の認可と作成時pairを証明できる場合だけ初回Readyにする。

- 受付はpush/force-push・Draft/Ready・pauseのserver側履歴と、再取得したrevision遷移を永続化する。commitのauthor/committer日付や受信順から操作順を推測しない。同時刻・遅延・履歴の欠落で順序が確定しなければunknown。
- 照合はtimelineを全必要ページ取得し、保存したrevision遷移と照らして未処理のReadyを回復する。保存済み境界以降の履歴が揃い、そのeventのpairが一意に確定する範囲だけ回復する。timelineにhead/baseが無い場合、現在のheadを過去eventへ付け直さない。
- 初回導入・停止中のpushなどでpairや順序を証明できなければ、認可された人/実装者へ新しいDraft→Readyを案内する。照合は欠落の検出と回復を行うが、欠落を推測で埋めない。
- 消費済みReady IDとdelivery IDはpayload削除後もtombstoneとして保持する。pause解除後に古いReadyを再配送しても復活させない。

CIはQuality gateと支持ジョブ、試験mergeの親/head/base・treeを確認する。名前だけ、古いgreen、未完了、失敗、理由不明のskip、取得途中の欠落は合格にしない。PR側のworkflow変更は独立レビューの対象であり、CI成功だけでは信頼できるpolicyにならない。

## 3. 配置とGitHubの身元

初期の配置案は**所有者のMac上のNode.js受付、独立run supervisor、専用SQLite**。製品DB/HTTPサーバーとは分け、レビュー済みmainの固定版から起動する。macOSサービスの有効化はowner作業。クラウド受付・GitHub ActionsでのAI起動は初期案に含めない。Nodeはrepo対応版、SQLiteはnode:sqliteを実装で検証し、WAL/トランザクションを使う。DBを複数ホストで共有しない。

| 経路 | 初期構成で固定する身元・権限 |
| --- | --- |
| 照合/取得 | Codex Appの新しいdispatch-read用途。contents/PR/issues/actions/checks/statuses/metadataをreadに限定 |
| Webhook受信 | Codex Appだけ。Claude Appでは同じ受付へ購読しない。現在offのWebhookはowner導入まで有効化しない |
| Review投稿 | 割り当てられたreviewerのApp専用Broker。§6のrun/結果一致が必要 |
| 修正push/Ready/返信 | implementerのApp専用Broker。reviewerのAppでは行わない |
| 人への案内 | Codex Appの通知Broker。Reviewのdecisionを生成する権限は持たせない |

dispatch-readの追加は[App手順](github-apps.md)の用途/権限制御の変更として独立レビューする。1回の取得batchの間だけ縮小tokenを再利用し、全必要ページを同じ子プロセスで読む。期限を超えるbatchは破棄して再取得し、終了時に失効する。JWT/キーチェーン読取りをAPI要求ごとに繰り返さず、batch間でtokenを保存しない。

GitHub通信はgh apiだけ。縮小tokenの取得・範囲検証が失敗したらghを呼ばない。GH_CONFIG_DIRとHOMEを専用の空領域へ向け、環境をallowlistで作り直す。doc-gifの保存認証、別App、広いtokenへ戻らない（PR42-R001/R004/R006）。ownerが将来読取り専用受付Appを選ぶ場合は設定を置換し、同時受信しない。誤って両Appから届いても仕事キーで重複を排除する。

受信はlocalhost endpointとowner承認のHTTPS到達経路を分ける。raw bodyのHMAC-SHA256を定時間比較し、body上限・repo/install/eventを許可リストで確認する。永続Inboxへ保存後に2xx、保存失敗は非2xx、過大bodyは413。署名は配送元の証明であり操作権限ではない。公開URL・トンネル・費用・実配送は導入チェックリストへ残す。

## 4. 記録・排他・復旧

GitHubは差分・Review・CIの正本。ローカルDBは配信/実行制御の正本で、secretを保存しない。

| 記録 | 必須フィールド/制約 |
| --- | --- |
| Policy | repo/許可PR、参加者IDと同一人物対応、必要reviewer集合、実行先、予算、revision、mode |
| Inbox | receive App ID＋delivery ID unique、event、受信時刻、payload、処理状態。削除後もID保持 |
| Target | repo/PR/head/main-base、Ready event参照、履歴境界、policy revision、generation、pause |
| PR lease | repo＋PR unique。全Job種類をまたぐrun所有権、generation、実行状態 |
| Job | Target＋generation＋担当ID＋種類 unique、run ID、launch状態、supervisor/process group、PID開始時刻、結果参照 |
| Outbox | Job＋投稿種類 unique、投稿身元、run ID、worker結果hash/schema/decision出所、head/base/generation、本文hash、marker、GitHub ID、状態 |
| Acceptance | Review ID/actor/state、成立時pairと証跡、取り消し/stale状態 |

payloadは7日、完了Job詳細は30日で削除/要約する。consumed event/delivery IDs、generation、quota、投稿ID/hash、未解消指摘、実行中/uncertain記録は削除しない。停止して履歴をarchiveするowner操作以外で、再生防止記録を消さない。移行は停止・バックアップ後、未知schemaは書き込まない。

状態はwaiting→queued→launching→running→result-ready→posted。GitHub上の投稿を再取得して初めてposted。対象変更はstale、閉鎖はfinished、pauseは横断状態。再試行は副作用のない取得に限り上限を設ける。

### 単一実行と生存

- 受付はDB directoryのOS排他lockを起動から終了まで保持する。初期macOS backendはPython3のfcntl.flockを使う小さいtrusted wrapper。launchdと手動/旧版の二重起動はDBを開く前に拒否する。WALを起動排他の代わりにしない。
- claimは一つのDB transactionでgeneration、PR lease、全体枠、実行先枠、quotaを確保する。同じPRのreview/faultfinding/fixは同時に1つ。複数reviewerは順番、他PRは並行、AI review/faultfindingは全体最大10。人の標準操作は枠を使わない。
- run supervisorは受付とは別プロセスで、runごとのwrapperがdurable manifestを作り、run IDのOS lockを保持してからworkerを起動する。process groupで子孫を停止する。PIDだけで生存を判断せず、lock・supervisorのrun情報・PID開始時刻を照合する。
- 受付だけが落ちた場合は同じsupervisor/runへ制御接続を戻す。AIの会話resumeは使わない。新しい会話/Jobは以前の未起動またはprocess tree終了を確認した後だけ。heartbeat期限切れではleaseを奪わない。
- wrapper故障時、lockが取れても孤児process treeが残りうる。lock取得は必要条件であり、子孫終了の証明と合わせてleaseを解放する。spawnとmanifest更新の間などで終了を証明できなければuncertainに止め、再起動しない。

### 対象変更と投稿不明

pause/交代/push/main更新では結果を採用せず、取消→process tree終了確認→generation更新の順。部分変更はimplementer worktreeに残す。投稿直前に最新pair・Ready・CI・参加者・policy revisionを再取得する。過去のApproveを現在のbaseへ付け直さない。

POST応答が不明なら全必要ページからmarker、actor、commit、本文hashを照合する。1件確認ならposted、重複なら停止/報告、確認不能ならuncertain。成功した可能性のあるPOSTを再送しない。署名配送、別delivery ID、reconcileが同じ対象を示してもJob/Outboxのunique制約を通す。

## 5. 判定と現行運用との切替

起動はowner許可、操作認可、独立性、Open/non-Draft、exact-pair Ready、最新main取り込み、必要CI、未処理依頼、枠/予算が全て揃った時だけ。Copilotレビューは[現行マージ条件](github-agent-operations.md#merge-conditions)で任意としたため、応答・利用枠不足の証拠を起動条件にしない。

提出前の別担当のdesign-faultfinding Job/人の証跡とexact-pair acceptedを常に必要とし、未解消設計指摘があれば止める。AIの粗探しもreview quota/PR leaseに含める。Copilotの後着指摘は独立に評価・対応し、重大な欠陥なら独立受入を再確認する。無応答や指摘の未対応表示だけでacceptedを取り消さず、通常コメントへの返信で再レビューを仮定しない。

| 項目 | off | shadow | active（移行後のみ） |
| --- | --- | --- | --- |
| Ready/accepted | 現行正本のhandoff・exact-pair decision。COMMENT可 | 現行判定が効力を持つ。標準Ready/native Reviewとの差を記録 | §1/2のReady、独立APPROVEとpair証跡。旧COMMENTを正式承認へ変換しない |
| Copilot/粗探し | Copilot任意・粗探し必須（現行条件） | 同じ条件との差を記録 | Copilotは補助情報、粗探しJobと人の証跡を判定へ集約 |
| 判定/通知 | 現行手順/T23の担当 | 現行側だけ投稿。新受付は判定記録のみ | Issue45受付/Brokerだけ。T23の重複判定/通知を委譲 |
| T24/既存巡回 | 現行方式 | 現行方式、AIの二重起動なし | 移行したPRだけ新Job管理へ。旧workerの停止を確認してから切替 |

activeの前提は**owner承認の別の正本移行PR**。pr-review-loop、github-agent-operations、T23/T24の台帳を一括で整合し、Ready/accepted/Copilot/粗探しの正本、唯一の判定/通知担当、移行対象を確定する。T23のCI-policy保護責務は残す。未マージ#38/#44のコードを取り込まず、再開もしない。Issue45実装はmerged-mainのAPIとdefault-offのpolicy adapterを用意するだけで、promptから現行規約を上書きしない。

activeのReviewはAPPROVEが候補、CHANGES_REQUESTEDは修正待ち、COMMENTED/行指摘は認可済みの参考/指摘、DISMISSED/編集は集合を再計算する。複数reviewerは必要集合/人数を満たし、重大未解消指摘やRequest changesを多数決で無視しない。人のApproveもReview commitと成立時pairを証明できなければ保留する。状態変化後の投稿はstaleとして履歴に残す。

受付はマージしない。実装担当が最新pair/CI/独立accepted/粗探し/競合を再確認し、match-head付きmerge commitとfirst-parent検証を行う。repo保護設定の変更は別のowner作業。

## 6. 身元を結ぶBrokerと通知

workerは結果schemaだけを返し、GitHubへ直接書き込まない。Brokerはidentityごとに固定し、その鍵だけを管理する。受付/workerがAppや鍵を選ぶ引数を設けない。Claudeの鍵はClaudeのBrokerだけが管理し、Codexによる実装・検証はfake Brokerで行う。

Jobの割当を固定したrun manifestと結果hashをBrokerが照合する。固定した接続先と認証したrun endpointから結果を受け、別run/actorの結果を拒否する。投稿身元＝Job reviewer＝実際のrun actor、現行generation/pairであり、PR作者・push/実装参加者でないことを投稿直前に再確認する。identity履歴不明も拒否。Outboxのdecisionはworker schema由来で、受付がacceptedを合成しない。

| worker decision | BrokerのGitHub event |
| --- | --- |
| accepted | APPROVE |
| changes-requested | REQUEST_CHANGES |
| needs-owner | COMMENT |

本文は[現行v1書式](pr-review-loop.md)のmarker、role、agent_id、head_sha、base_sha、decisionと、短い結論・指摘ID・検証リンク・未検証範囲を保持する。運用移行前のCOMMENT acceptedは現行判定だけで扱い、activeへ移植しない。

fixのpush/Ready/返信はimplementerに固定したBrokerだけ。ownerが明示的にauto-fixを有効にしたPRに限る。push後に実際のGitHub activity actorとheadを確認し、確認不能ならReadyにしない。レビューBrokerからpushした結果を同じ身元で承認しない。token/GitHub認証をworkerに渡さず、local commit案をBrokerが検査して送る。

人への案内はPRコメントを使い、通知Brokerの固定Codex Appで投稿する。keyはrepo/PR/通知種別/head/base/generation＋障害fingerprint、markerはkurashi-ledger:dispatch-notice:v1。対象状態ごとに1回、変化なし0件。通常レビュー依頼は人への標準Request reviewも使えるが、同じkeyで重複依頼しない。自分の通知/Review・一般コメントからAI Jobを起動しない。通知のPOST不明も§4で止める。GitHubへ接続できない障害はlocalの状態記録で1回知らせる。

## 7. workerの隔離と往復上限

| 実行先 | 固定する接口・制約 |
| --- | --- |
| Codex CLI | 固定absolute path/版、codex exec --json、結果schema、--sandbox read-only。agent toolのnetworkは禁止 |
| Claude CLI | 固定absolute path/版、claude -p --output-format json、結果schema。Read系toolだけ許可し、Bash/Write/Web・MCP/hooksを禁止 |
| 人 | GitHub操作/通知のみ。AI起動なし |
| デスクトップチャット | 初期の自動起動対象外。既存巡回はownerの切替手順で扱う |

shell文字列ではなく固定実行ファイル＋argvで起動する。cwdは取得資料だけの使い捨て領域。envはallowlistから作り、GH_TOKEN、KL_*、継承したGitHub/別AI資格情報を除く。PR checkout、個人設定、hooks/MCP、AGENTSを自動ロードしない。短い英語Jobにはpair・種類・指摘ID・必要証跡を渡し、diffは不信データと明示する。結果要約は日本語。

read-only flagはキーチェーン読取りの隔離ではない。初期macOS backendはsystemのsandbox-execで固定Seatbelt profileを適用し、資料/必要runtime以外の読取り、policy/DB書込み、security/keychain access、許可外process/通信を拒否する。CLI全体のprofileとtool子processのprofileを分け、後者は資格情報領域を一切読めずnetworkも使えない設定にする。実装で両profileの適用を証明できないCLI版や、OS機構が無い環境は起動不可。Codexのtool用sandboxにはnetworkを許さず、モデル通信はtrusted clientのAIサービス認証/接続だけに分ける。Claudeもtool allowlistとOS境界を併用する。必要なモデル通信まで止める設定を「動作確認済み」としない。

doctorは固定版/config/機能に加え、同じ境界内でfixture鍵/資格情報への読取り、policy/DB書込み、tool network、hooks/MCPロードを試す否定試験を行う。期待どおり拒否できないCLI/OS/configは起動不可。単なるhelp確認を隔離の証拠にしない。実行機構を結合できない環境でもfake runnerとdefault-off基盤の受入は可能だが、実起動capabilityはunverified/disabledのまま残す。

同じOSユーザーの悪意あるhost processや管理者に対する強い分離ではなく、取り違え/不信入力の被害を減らす機構。別ユーザーによる強化は導入判断。implementer Jobは許可worktreeでPRコードを検証するため、現行手作業と同じ実行リスクが残る。未隔離の実装Jobを自動で起動しない。

Claudeの--bareはAPI認証が必要で、既存購読認証を使えるとは仮定しない。購読方式は設定/認証だけを分離した領域と否定試験を必要とする。新しいAPI費用、CLI/認証不足時の別サービスへの切替はowner承認が必要。自動では切り替えない。

**IDと原因の言い換えでも戻らない上限**をDBに持つ。ownerの一つのauto-fix許可につき最大2修正、PRごとrolling 24時間にAI review/faultfinding起動最大6回。launch前に予約し、起動不明も消費扱い。ID/世代/再起動/手動pushでリセットしない。上限でpause/needs-owner、ownerが原因/方針を確認して再許可するまで解除しない。通常の取得はAI回数に数えない。現行の「同原因2回の不成功→設計見直し→残ればneeds-owner」も保持し、各修正前に指摘全体と回帰原因を照合する。

## 8. 実装・移行・完了

1. 設計PR #46はClaudeの独立レビューを経てマージ済み。仕様の追加・変更は実装の差分と一緒に独立レビューする。
2. accepted後の実装PRでpure reducer、SQLite Inbox/lease/Job/Outbox、gh取得、署名HTTP、通知/Broker boundary、supervisor/CLI capabilityを実装する。合成イベント・fake runnerを必須にし、実AI/App呼出しはdefault off。コードの配置・言語・CI jobは実装計画へ先に記録する。
3. default-off実装と検証/独立acceptedでIssue45を完了し、残る担当レビューを既存chat/jobで再開する。本導入待ちで他タスクを止めない。
4. ownerが正本移行PR、URL/購読/秘密、CLI/認証/費用、隔離と許可範囲を確認してから導入する。shadowでは起動・投稿0。15分照合の遅延を現行5分と比較し、許可なく既存確認頻度を変えない。

切替は旧worker停止確認→現行pair/Ready/指摘の再取得→移行したPRだけactive。rollbackも新worker終了とuncertain Outboxを確認してから旧方式へ戻す。capability不足では人へ案内し、旧巡回を勝手に起動せずownerの切替設定に従う。停止中PRの一括再開はしない。

導入前のowner判断は、O1:到達経路と受付App（将来の専用read-only Appを推奨）、O2:ClaudeのAPI費用/購読認証、O3:別OSユーザー分離。これらは設計受入を止めず、default-offのまま未検証事項として管理する。

## 9. 受入試験と導入チェックリスト

以下は実装PRの受入条件で、この設計PRで試験済みとはしない。

| ID | 入力/故障 | 独立した期待結果 |
| --- | --- | --- |
| D01 | 人↔AI、Codex↔Claude、複数reviewer | 同じ認可/Ready/CI/独立性。人にSHA転記不要 |
| D02 | 二重配送、両App/違うdelivery ID、逆順、pause後7日超の再配送 | 同じ仕事/投稿は1件。payload削除でも古いReadyを復活させない |
| D03 | dispatcherだけ落下し子が生存、spawn/manifest間の故障、PID再利用、POST不明 | supervisorへ制御再接続。子孫終了不明はlease保持・再起動/再POSTなし |
| D04 | main更新、push/force-push、retarget、Ready/Review競合、履歴欠落 | 最新mainの祖先証明と試験merge親照合。unknownに旧pairを付け直さず新Ready要求 |
| D05 | CI pending/失敗/skip、必須証拠のAPI途中失敗、Copilot遅延/後着/枠不足 | CI/必須証拠が不明なら起動0。Copilot無応答/枠不足だけでは止めず、後着の重大欠陥は独立受入を再確認。粗探し証跡を省略しない |
| D06 | wrong Ready actor、第三者COMMENT、他run/identityの結果、自分のpush承認、dismissal | 認可外の起動/修正入力/承認0。pause解除はownerだけ |
| D07 | 偽署名/別repo/install/body過大、token不在、管理者fallback、鍵/DB/network否定試験 | 副作用/秘密出力0。ghまたはworkerを起動しない |
| D08 | 自分の投稿/通知、指摘ID振り直し、世代更新、再起動で修正往復 | noticeからAI起動0、persisted quotaを越えずowner pause |
| D09 | daemon二重起動、種類違いJob、10枠超、交代/pause/切替/rollback/Mac再起動 | singleton/PR lease/generationを保持。旧担当終了前の二重起動なし |
| D10 | 変更なし、CLI不存在/版変更/認証不足、費用、schema不正 | AI0または明示失敗。未検証/新費用を隠さず通知は状態ごと1回 |

PR46-I001〜I007は次へ引き継ぐ。

| 指摘ID | 実装受入/導入前に残す確認 |
| --- | --- |
| I001 | CLI絶対パス/版変更、schema/結果actor、Claude --bare/API制約、購読隔離、capability失敗時の人/旧方式へのowner制御切替 |
| I002 | 対応Nodeのsqlite安定度、途中終了/WAL/移行/バックアップ/未知schema。repo外の合成DBで3 OS試験 |
| I003 | 10秒以内のHTTP応答、body上限、Appの配送失敗は自動再送に頼らず照合回復。issues等の購読要否、実配送/redelivery IDは導入実測 |
| I004 | 全ページ/ETag/rate limit、shadowの15分照合と現行5分の遅延/呼出し数比較 |
| I005 | base≠main/retarget/force-push、試験mergeの親とtree |
| I006 | D001〜D009の全反例を合成イベント/fake adapterで試験。実OS lock/process tree/隔離は対応backendの結合試験 |
| I007 | dispatcher/Broker/policy adapter/PURPOSESを権限制御変更として独立レビュー。固定版更新はownerだけ。正本移行でT23のpolicy_pathsへ加える |

pure testsは3 OS、SQLiteは実一時DB、macOSのrun lock/process groupは実fixture workerで検証する。実CLI/App/署名配送、host隔離、公開到達経路はownerが許可した導入試験として別記する。未検証backendはdisabledであり、default-off実装の合格を実導入の証拠にしない。受信/判定/AI起動/重複/修正往復を測り、指摘数削減を品質指標にしない。

## 10. 正本と資料

- 範囲: [Issue45](https://github.com/doc-gif/kurashi-ledger/issues/45)。現在の権限/マージ条件: [運用規約](github-agent-operations.md)、[PR書式](pr-review-loop.md)。今回の機構の正本はこの文書。入口へ詳細を複製しない。
- 認証: [App手順](github-apps.md)。[Webhook](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)、[Review API](https://docs.github.com/en/rest/pulls/reviews)、[署名検証](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)。購読候補はpull_request、pull_request_review、pull_request_review_comment、check_run/check_suite、workflow_run、push、issues。実権限/購読は導入確認。
- [Claude CLI](https://code.claude.com/docs/en/headless)、[flags](https://code.claude.com/docs/en/cli-reference)。この作業環境ではClaude CLI未確認。Codexのexec/helpは確認したが、版・隔離・実起動の証明ではない。
- [Node.js 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。実行版は実装で固定・検証する。
