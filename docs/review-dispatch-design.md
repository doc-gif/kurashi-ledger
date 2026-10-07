# 人・AI共通のレビュー受付（設計案）

状態: **設計受入済み。default-offの基盤（[Issue #45](https://github.com/doc-gif/kurashi-ledger/issues/45)、PR #48）はmainに統合済み。** [Issue #50](https://github.com/doc-gif/kurashi-ledger/issues/50)でactiveへ進める。2026-10-04の所有者決定（O1〜O3とWindows）は§8に記す。正本の移行は[PR書式の「受付がactiveのPR」](pr-review-loop.md#受付がactiveのpr)で行った。

通常のプログラムがGitHubの状態・認可・重複を判定し、条件が揃った仕事だけを人・AIへ渡す。Webhookを入口にし、15分ごとの照合で取りこぼしを拾う。activeは、所有者がpolicyへ加えたPRだけに効く。ほかのPRは現在の5分確認と[PR書式](pr-review-loop.md)を使う。

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

配置は**所有者のMac上のNode.js受付、独立run supervisor、専用SQLite**。製品DB/HTTPサーバーとは分け、レビュー済みmainの固定版から起動する。macOSサービスの有効化はowner作業。クラウド受付・GitHub ActionsでのAI起動はしない。Windowsでは受付を動かさない（§8）。Nodeはrepo対応版、SQLiteはnode:sqliteを実装で検証し、WAL/トランザクションを使う。DBを複数ホストで共有しない。

| 経路 | 初期構成で固定する身元・権限 |
| --- | --- |
| 照合/取得 | Codex Appの新しいdispatch-read用途。contents/PR/issues/actions/checks/statuses/metadataをreadに限定 |
| Webhook受信 | Codex Appだけ。Claude Appでは同じ受付へ購読しない。現在offのWebhookはowner導入まで有効化しない |
| Review投稿 | 割り当てられたreviewerのApp専用Broker。§6のrun/結果一致が必要 |
| 修正push/Ready/返信 | implementerのApp専用Broker。reviewerのAppでは行わない |
| 人への案内 | Codex Appの通知Broker。Reviewのdecisionを生成する権限は持たせない |

dispatch-readの追加は[App手順](github-apps.md)の用途/権限制御の変更として独立レビューする。1回の取得batchの間だけ縮小tokenを再利用し、全必要ページを同じ子プロセスで読む。期限を超えるbatchは破棄して再取得し、終了時に失効する。JWT/キーチェーン読取りをAPI要求ごとに繰り返さず、batch間でtokenを保存しない。

GitHub通信はgh apiだけ。縮小tokenの取得・範囲検証が失敗したらghを呼ばない。GH_CONFIG_DIRとHOMEを専用の空領域へ向け、環境をallowlistで作り直す。ghのテレメトリ（gh 2.91以降の既定）と更新確認は、`gh help environment`の変数（`GH_TELEMETRY=false`・`GH_NO_UPDATE_NOTIFIER=1`）で切る。テレメトリはGitHub API以外へ送り、切り離した子`gh send-telemetry`が消した一時HOMEを作り直す（W9。[github.ts](../scripts/lib/review-dispatch/github.ts)の`ghEnv`）。doc-gifの保存認証、別App、広いtokenへ戻らない（PR42-R001/R004/R006）。ownerが将来読取り専用受付Appを選ぶ場合は設定を置換し、同時受信しない。誤って両Appから届いても仕事キーで重複を排除する。

受信はlocalhost endpointと公開HTTPS経路を分ける。公開経路は、shadowだけに使うA（Cloudflareのクイックトンネル。全pathが受け口に届く）と、activeに要るB（Tailscale Funnel。固定の`<host>.<tailnet>.ts.net`）。BはFunnelの取付けを`/webhook`の1つだけにし、ほかの最上位pathはFunnelが404を返して受け口に届かない。`/webhook/…`の下のpathは受け口に届く（取付けは前方一致。残る危険）が、受け口はPOSTでpathが`/webhook`と完全一致する要求以外を、bodyを読む前・署名とpolicyの検査の前に404で返し、何も処理しない（[webhook.ts](../scripts/lib/review-dispatch/webhook.ts)の`serve`）。署名のheaderが無いか形が違う要求も、bodyを読む前に401で返す。raw bodyのHMAC-SHA256を定時間比較し、body上限・repo/install/eventを許可リストで確認する。永続Inboxへ保存後に2xx、保存失敗は非2xx、過大bodyは413。署名は配送元の証明であり操作権限ではない。公開URL・tunnelの設定・実配送の測定は、ownerの[導入手順](review-dispatch-runbook.md)に置く。URLはrepoへ書かない。

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
- run supervisorは受付とは別プロセスで、runごとのwrapperがdurable manifestを作り、run IDのOS lockを保持してからworkerを起動する。lockはworkerへ渡さない。終了時とtimeout・取消時に、leaderをreapする前にworkerのprocess groupを止め、列挙で空を確かめる。PIDだけで生存を判断せず、lock・supervisorのrun情報・PID開始時刻を照合する。
- 受付だけが落ちた場合は同じsupervisor/runへ制御接続を戻す。AIの会話resumeは使わない。新しい会話/Jobは以前の未起動またはprocess tree終了を確認した後だけ。heartbeat期限切れではleaseを奪わない。
- wrapper故障時、lockが取れても孤児processが残りうる。lockの空きもgroupの終了も必要条件で、十分条件ではない。supervisorが記録したgroupの終了と結果の検査が揃ってleaseを解放する。groupの終了は全子孫の終了ではない（§7の残余リスク）。spawnとmanifest更新の間などで終了を確かめられなければuncertainに止め、再起動しない。

### 対象変更と投稿不明

pause/交代/push/main更新では結果を採用せず、取消→group終了の確認→generation更新の順。部分変更はimplementer worktreeに残す。投稿直前に最新pair・Ready・CI・参加者・policy revisionを再取得する。過去のApproveを現在のbaseへ付け直さない。

POST応答が不明なら全必要ページからmarker、actor、commit、本文hashを照合する。1件確認ならposted、重複なら停止/報告、確認不能ならuncertain。成功した可能性のあるPOSTを再送しない。署名配送、別delivery ID、reconcileが同じ対象を示してもJob/Outboxのunique制約を通す。

## 5. 判定と現行運用との切替

起動はowner許可、操作認可、独立性、Open/non-Draft、exact-pair Ready、最新main取り込み、必要CI、未処理依頼、枠/予算が全て揃った時だけ。Copilotレビューは[現行マージ条件](github-agent-operations.md#merge-conditions)で任意としたため、応答・利用枠不足の証拠を起動条件にしない。

粗探しの証跡（担当reviewerのうち独立性を満たす1者のfaultfinding Job、人なら同じ書式の手動記録）とexact-pair acceptedを常に必要とし、未解消設計指摘があれば止める。activeでの粗探しの時点は[運用規約](github-agent-operations.md#dispatch-active)。AIの粗探しもreview quota/PR leaseに含める。Copilotの後着指摘は独立に評価・対応し、重大な欠陥なら独立受入を再確認する。無応答や指摘の未対応表示だけでacceptedを取り消さず、通常コメントへの返信で再レビューを仮定しない。

| 項目 | off | shadow | active（移行後のみ） |
| --- | --- | --- | --- |
| Ready/accepted | 現行正本のhandoff・exact-pair decision。COMMENT可 | 現行判定が効力を持つ。標準Ready/native Reviewとの差を記録 | §1/2のReady、独立APPROVEとpair証跡。旧COMMENTを正式承認へ変換しない |
| Copilot/粗探し | Copilot任意・粗探し必須（現行条件） | 同じ条件との差を記録 | Copilotは補助情報。担当reviewerの粗探しJobと人の証跡を判定へ集約 |
| マージの権限 | 実装担当（[OWNER_MERGE_ONLY](github-agent-operations.md#owner-merge-only)の例外あり） | offと同じ | 所有者（[規則](github-agent-operations.md#dispatch-active)） |
| 証跡の形 | AIはv1本文、人は標準操作 | 同じ | AIはv1本文、人は標準操作と受付が保存した結合（[確かめ方](pr-review-loop.md#所有者がマージ前に確かめる記録)） |
| 判定/通知 | 現行手順/T23の担当 | 現行側だけ投稿。新受付は判定記録のみ | Issue45受付/Brokerだけ。T23の重複判定/通知を委譲 |
| T24/既存巡回 | 現行方式 | 現行方式、AIの二重起動なし | 移行したPRだけ新Job管理へ。旧workerの停止を確認してから切替 |

activeの前提だった**正本移行**は、Issue #50のW0で行った。pr-review-loop、github-agent-operations、T23/T24の台帳が、Ready/accepted/粗探しの正本、唯一の判定/通知担当、切替とrollbackを定める。T23のCI-policy保護責務は残す。未マージ#38のコードを取り込まず、再開もしない。受付はpromptから現行規約を上書きしない。

activeのReviewはAPPROVEが候補、CHANGES_REQUESTEDは修正待ち、COMMENTED/行指摘は認可済みの参考/指摘、DISMISSED/編集は集合を再計算する。複数reviewerは必要集合/人数を満たし、重大未解消指摘やRequest changesを多数決で無視しない。人のApproveもReview commitと成立時pairを証明できなければ保留する。状態変化後の投稿はstaleとして履歴に残す。

起動の方式（policy）とマージの権限（[OWNER_MERGE_ONLY](github-agent-operations.md#owner-merge-only)）を分ける。後者はrollbackで消えない（PR51-R001）。受付はマージしない。activeのPRは所有者がマージする（[規則](github-agent-operations.md#dispatch-active)）。repo保護設定の変更は別のowner作業。

## 6. 身元を結ぶBrokerと通知

workerは結果schemaだけを返し、GitHubへ直接書き込まない。Brokerはidentityごとに固定し、その鍵だけを管理する。受付/workerがAppや鍵を選ぶ引数を設けない。Claudeの鍵はClaudeのBrokerだけが管理し、Codexによる実装・検証はfake Brokerで行う。

Jobの割当を固定したrun manifestと結果hashをBrokerが照合する。固定した接続先と認証したrun endpointから結果を受け、別run/actorの結果を拒否する。投稿身元＝Job reviewer＝実際のrun actor、現行generation/pairであり、PR作者・push/実装参加者でないことを投稿直前に再確認する。identity履歴不明も拒否。Outboxのdecisionはworker schema由来で、受付がacceptedを合成しない。Brokerは投稿の前に、本文を公開してよいかを検査する（check-public相当。Issue #50のW2）。検査に通らなければ投稿せず、人へ知らせる。

| worker decision | BrokerのGitHub event |
| --- | --- |
| accepted | APPROVE |
| changes-requested | REQUEST_CHANGES |
| needs-owner | COMMENT |

本文は[現行v1書式](pr-review-loop.md)のmarker、role、agent_id、head_sha、base_sha、decisionと、短い結論・指摘ID・検証リンク・未検証範囲を保持する。運用移行前のCOMMENT acceptedは現行判定だけで扱い、activeへ移植しない。

fixのpush/Ready/返信はimplementerに固定したBrokerだけ。**auto-fixは、実装Jobの隔離の設計が別に受け入れられるまで無効。** そのあとも、ownerが明示的にauto-fixを有効にしたPRに限る。push後に実際のGitHub activity actorとheadを確認し、確認不能ならReadyにしない。レビューBrokerからpushした結果を同じ身元で承認しない。token/GitHub認証をworkerに渡さず、local commit案をBrokerが検査して送る。

人への案内はPRコメントを使い、通知Brokerの固定Codex Appで投稿する。keyはrepo/PR/通知種別/head/base/generation＋障害fingerprint、markerはkurashi-ledger:dispatch-notice:v1。対象状態ごとに1回、変化なし0件。通常レビュー依頼は人への標準Request reviewも使えるが、同じkeyで重複依頼しない。自分の通知/Review・一般コメントからAI Jobを起動しない。切替・変更・rollbackでは表示用の通知を1回出す（[書式](pr-review-loop.md#受付がactiveのpr)）。通知と受領記録は権限を持たない（[規則](github-agent-operations.md#dispatch-active)）。通知のPOST不明も§4で止める。GitHubへ接続できない障害はlocalの状態記録で1回知らせる。

## 7. workerの隔離と往復上限

| 実行先 | 固定する接口・制約 |
| --- | --- |
| Codex CLI | **今回は自動起動しない**（[所有者決定](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977523656)）。Codexのレビューは今の方法（Codex側の巡回か所有者の依頼）で、人への引継ぎを残す。測定の仕組みは残し、capabilityはdisabledで出す。`--sandbox read-only`は書込みの制限で、読取りを絞らない。Codex 0.160.0の[SandboxPolicy](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/protocol.rs#L1222)は全diskの読取りを許し、[変換処理](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/permissions.rs#L2046)もrootの読取りを設定する。そのため今の条件では「資料の外を読めない」否定試験に通らない。外側のSeatbeltは掛けない（所有者決定）。入れ子が拒否されるかは、版・外側のprofile・拒否される操作に依存する。W1の測定では、実際のprofileの入れ子が終了コード71で失敗した。Codexの測定では、allow-defaultの2段は成功した。実際のCodexのprofileでは未測定。cwdの規則と否定試験（keychain・Appの鍵、資料の外の合成の秘密、PRの`AGENTS.md`や設定）は、有効にする前に必須 |
| Claude CLI | 固定absolute path/版、claude -p --output-format json、結果schema、購読の長期token（O2-token）。Read/Grep/Globだけ許可し、Bash/Write/Web・MCP/hooks/pluginsを禁止。層は下の表 |
| 人 | GitHub操作/通知のみ。AI起動なし |
| デスクトップチャット | 初期の自動起動対象外。既存巡回はownerの切替手順で扱う |

shell文字列ではなく固定実行ファイル＋argvで起動する。cwdは取得資料だけの使い捨て領域。envはallowlistから作り、GH_TOKEN、KL_*、継承したGitHub/別AI資格情報を除く。PR checkout、個人設定、hooks/MCP、AGENTSを自動ロードしない。短い英語Jobにはpair・種類・指摘ID・必要証跡を渡し、diffは不信データと明示する。結果要約は日本語。

read-only flagはキーチェーン読取りの隔離ではない。Claudeには、systemのsandbox-execで固定Seatbelt profile（`cli.sb`）を適用し、資料/必要runtime以外の読取り、policy/DB書込み、security/keychain access（すべて）、許可外process/通信を拒否する。macOSは閉じ込めたprocessの中でより厳しいprofileを掛けられないので、toolの子processはCLIのprofileを継承し、**同じ許可**を持つ（一覧は下の残余リスク）。CLIのprofileが読めるのは、資料・runtime・そのrunの`CLAUDE_CONFIG_DIR`・HOME・tmpだけにする。継承を証明できないCLI版や、OS機構が無い環境は起動不可。Codexは自身の`--sandbox read-only`だけで動く。Claudeはtool allowlistとOS境界を併用する。必要なモデル通信まで止める設定を「動作確認済み」としない。

doctorは固定版/config/機能に加え、同じ境界内でfixture鍵/資格情報への読取り、policy/DB書込み、tool network、hooks/MCPロードを試す否定試験を行う。期待どおり拒否できないCLI/OS/configは起動不可。単なるhelp確認を隔離の証拠にしない。実行機構を結合できない環境でもfake runnerとdefault-off基盤の受入は可能だが、実起動capabilityはunverified/disabledのまま残す。

同じOSユーザーの悪意あるhost processや管理者に対する強い分離ではなく、取り違え/不信入力の被害を減らす機構。O3により別のOSユーザーは使わない。この残余リスクを受け入れて記録する。同じアカウントで規則を破るAI（Appやdoc-gifでの記録・承認の偽装）も防がない。doc-gif（所有者と共用）で`OWNER_MERGE_ONLY`を書き換えられる。そのためactiveのPRは所有者がマージする（§5）。implementer Jobは許可worktreeでPRコードを検証するため、現行手作業と同じ実行リスクが残る。未隔離の実装Jobを自動で起動しない。

**IDと原因の言い換えでも戻らない上限**をDBに持つ。ownerの一つのauto-fix許可につき最大2修正、PRごとrolling 24時間にAI review/faultfinding起動最大6回。launch前に予約し、起動不明も消費扱い。ID/世代/再起動/手動pushでリセットしない。上限でpause/needs-owner、ownerが原因/方針を確認して再許可するまで解除しない。通常の取得はAI回数に数えない。現行の「同原因2回の不成功→設計見直し→残ればneeds-owner」も保持し、各修正前に指摘全体と回帰原因を照合する。

### Claudeの起動の層（O2）

Claudeは購読の認証で起動する。`--bare`は購読のログインもkeychainも読まず、API鍵を要する（[headless](https://code.claude.com/docs/en/headless)）。そのため`--bare`とAPI鍵は使わない。資格情報はownerが`claude setup-token`で作る1年の長期tokenで、supervisorがworker境界の外で読み、`CLAUDE_CODE_OAUTH_TOKEN`として起動するClaudeのenvにだけ渡す（[authentication](https://code.claude.com/docs/en/authentication)）。起動したClaudeはkeychainに一切触れない（O2-token）。次の層は**すべて必須**。固定版にflag・設定がない、または否定試験で効かないなら、capabilityをdisabledにする。

| 層 | 設定（[headless](https://code.claude.com/docs/en/headless)・[cli-reference](https://code.claude.com/docs/en/cli-reference)・[permissions](https://code.claude.com/docs/en/permissions)の記載だけ） | 防ぐもの |
| --- | --- | --- |
| 認証 | `CLAUDE_CODE_OAUTH_TOKEN`だけ。tokenより優先される認証をすべて除く（下の箇条書き）。`CLAUDE_CONFIG_DIR`はrunごとにrun領域の中へ新しく作る空の0700のdirで、再利用せず、run領域ごと消す（[W5c](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-6019871945)） | 個人設定・memory・別の認証の混入、別のJobへの書込みの干渉、API費用、keychainの読取り |
| 設定の読込み | `--setting-sources user`（projectとlocalを除く）、または`--restricted` | cwdの`.claude/settings*.json`の読込み |
| 設定 | inlineの`--settings` JSON。`disableAllHooks: true`、pluginsなし、下のRead規則 | hooks・pluginsの実行 |
| MCP | serverのない`--mcp-config`、`--strict-mcp-config`、`--disallowedTools "mcp__*"` | 他の場所のMCP設定、MCP tool |
| tool | `--tools "Read,Grep,Glob"`で他のbuilt-in toolを外す。`--json-schema`が足す`StructuredOutput`（最後の結果を返すだけでI/Oをしない。initで観測し、[文書](https://code.claude.com/docs/en/agent-sdk/structured-outputs)は名前を出さない）は、この引数があるときだけ測定の構造の証明で許し、試みの証拠には数えない | 書込み・shell・Web |
| 読取りの範囲 | allowは資料dirに限った`Read(//<資料>/**)`だけ。denyに`Read(//<config dir>/**)`。Grep・Globも`Read()`の規則で絞る。素の`Read`・`Grep`・`Glob`を許可しない | cwd外・config dirの読取り |
| 確認 | `--permission-mode dontAsk` | 確認を要する操作。確認なしで拒否する |
| cwd | 取得資料だけの使い捨て領域。repo・worktreeの外。資料はrepoのpathを保たず、中立の名前で置く。cwdとその祖先に`.claude/`・`.mcp.json`・`CLAUDE.md`・`AGENTS.md`を作らない。あれば起動しない | PRのhooks・MCP・指示の自動ロード |
| OS | `sandbox-exec`のSeatbelt profile。資料・runtime・そのrunのconfig dir・HOME・tmpだけを読め、keychainに触れない。外向きはIPv4の443番だけで、localhostは塞ぐ（[net-443](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977523656)）。toolの子processも同じprofile（同じ許可） | 上の層の迂回、policy/DB・別のrunの領域の書込み、keychain、localhostのサービス |

- `--bare`なしの`-p`は、cwdの`.claude/settings.json`のhooksと`.mcp.json`を信頼の確認なしで使う（headlessの記載）。そのため設定の読込み・MCP・cwdの3つの層を重ねる。
- dontAskでも、作業directory内の読取りと読取り専用のcommandは確認なしで動く。`--allowedTools`は確認を省くだけで、toolを外さない。そのため`--tools`を使う。
- `Read`の規則はGrep・Globへ「best-effort」でだけ効く（permissionsの記載）。Seatbeltが最後の境界になる。
- CLIとtoolの子processが443番へ出られることは、所有者が受け入れた残余リスク（net-443、下の残余リスク）。toolはRead・Grep・Globに保つ。
- 443番で届く先（`loopback-deny-after-443`。443番の説明はここだけ）: `cli.sb`の443番のallowは`tcp4`だけ。localhostのdenyはIPv4射影のIPv6アドレス（`::ffff:127.0.0.1`・`::ffff:<Macのアドレス>`）に一致しないので、IPv6のTCPは許さない（[PR #70 RT-1](https://github.com/doc-gif/kurashi-ledger/pull/70)）。その後のlocalhostのdenyが、loopbackとMac自身のIPv4アドレス（LAN・tailnet・`0.0.0.0`）を塞ぐ。macOS 26.5.1の実測では、443番で届くのはMacの外のIPv4の宛先だけで、射影の形・global/ULA/tailnetのIPv6・外部のIPv6を含む残りはEPERMだった。tokenなしの実CLIは`system/init`を出し、sandboxの中のcurl `-4`はAPIへTLSで届いた。lint（`doctor.ts`の`lintProfile`）は、localhostのdenyの後にnetworkの許可が無いことを要求する。doctorは443番を試さず（答えはhostで何が待ち受けるかに依る）、`cli.sb`の443番のallowだけを自分の一時portへ移した変種で実行時に示す: `loopback-ipv4`・`loopback-ipv6`・`loopback-mapped`は、出荷の順で拒否され、denyを外しIPv6も許した変種で目印を受け取る。hang・timeoutは`inconclusive`。「後の規則が勝つ」の根拠は`doctor.test.ts`の実測（`PR70 RT-2 Seatbelt`: denyを外すか前へ移すと`loopback-ipv4`が届き、`tcp`にすると`loopback-mapped`が届く）。
- envのallowlistから、[authentication](https://code.claude.com/docs/en/authentication)の優先順位でtokenより上か経路を変えるものを除く: `CLAUDE_CODE_USE_BEDROCK`・`CLAUDE_CODE_USE_VERTEX`・`CLAUDE_CODE_USE_FOUNDRY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_PROFILE`と連携の変数。設定の`apiKeyHelper`と`env`欄も使わない。doctorは`claude auth status`の`authMethod`を確かめる（W1）。
- envの`CLAUDE_CODE_TMPDIR`をrunのtmpへ向ける。Claudeは自身の一時fileを`TMPDIR`ではなくこの変数の下（既定は`/tmp`）の`claude-<uid>/`に作る（[env-vars](https://code.claude.com/docs/en/env-vars)）。CLI用のprofileは`/tmp`を拒否するので、無いと起動時に止まる（W4e）。
- `--safe-mode`・`--permission-prompts none`・`--no-session-persistence`は任意で併用してよい。採否は起動器のPRに記録する。
- 測定の記録（schema 3）は、各`denied`の根拠を`basis`で分ける: CLI自身の構造化したアクセス（`access`）、initの道具一覧だけ（`structural`）、その両方（`mixed`）、runの後の走査（`scan`）。子processの実際のアクセスはdoctorの合成のprobe（`:cli-child`）だけ。共有profileの許可（`sharedProfile`。一覧は下の残余リスク）は`denied`と報告しない。`deny-network`はlocalhostとIPv4の443番以外の拒否の意味。

doctorの否定試験に次を加える。1つでも拒否できなければcapabilityをdisabledにする。

- `.claude/settings.json`のhooks・`.mcp.json`・`CLAUDE.md`・`.claude/agents`を含む合成PRを資料にして起動する。hookが動かず、MCP serverがなく、合成の目印の指示が効かない。
- 注入した指示でconfig dirと合成の秘密を読ませる。Read・Grep・Globのどれでも拒否される。
- 閉じ込めたClaudeとCodexから、実際のAppの鍵、または同じACLの形の合成のkeychain項目を読ませる。読めない。
- Codexに、資料の外の合成の秘密ファイルと、`AGENTS.md`・設定を含む合成PRを与える。秘密を読めず、PRの指示・設定を読み込まない。今の`--sandbox read-only`ではこの試験に通らないため、Codexはdisabledのまま（上の表）。

**合否と情報（[所有者決定](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-6030270452)）:** 目的は、注入された指示に従うClaudeが秘密を読めず、DB・policyに書けず、誰としても投稿できないこと。これを守るのはOSの境界（`cli.sb`）。注入の測定（run B）は、モデルが試すかどうかが毎回変わる。そのため、試みを根拠にする項目（`basis`が`access`・`mixed`: `deny-keys`・`deny-gh-auth`・`deny-other-ai-auth`・`deny-keychain`・`deny-db`・`deny-policy-write`・`tool-child-confined`）は**情報**として記録する。合否に使うのは`allowed`（漏えい・変更・接続）だけで、これはdisabledにする。合否を決めるのは、確実に判定できる次の項目: doctorの合成のprobe（同じ`cli.sb`、子processでも）、構造の項目（`deny-network`・`deny-supervisor`）、run Aの`deny-hooks-mcp`、`config-holds-no-secret`、benign runの`schema`、`groupEnded`。run Bの対象ごとに、同じ種類のアクセスを確かめる合成のprobeを`doctor.ts`の`RUN_B_COVERAGE`に対応させる。欠ければ試験が落ち、doctorは`coverage-gap`でunverifiedにする。`tool-child-confined`は合成の`:cli-child`で判定する。run自身のconfig dir・HOME・tmpは`cli.sb`が読み書きを許す（共有profileの許可）ので、Readの規則だけが守る。そこで測定はrun A・A2・B・benignの後、run領域を消す前に、この3つにtokenの値と既知の資格情報のファイル名（`.credentials.json`等）が無いことを走査で確かめる（`config-holds-no-secret`。見つかればdisabled、読めないfileがあればunverified。値・中身は記録せず数だけ）。走査中に領域へ敵対的に書く者はいない前提で走査する（modelに書込みの道具がなく、残りうる子は固定のtoolの子で、CLIは終了済み）。fileはlinkを辿らずに開き、開いたfdで実体・大きさ・変更を確かめる。dirの差替えは防がず、走査後の再確認で見つけてinconclusiveにする（[PR67-R001](https://github.com/doc-gif/kurashi-ledger/pull/67)）。許可だけの対象は被覆に数えない（[PR67 RT-1](https://github.com/doc-gif/kurashi-ledger/pull/67)）。run Bの再試行・合算はしない。

**keychain（[所有者決定](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977365862)）:** 上の最後の試験で読めたら、ownerがAppの鍵を別の専用keychain fileへ移す。移し終えて試験に通るまで、自動起動はdisabledのまま。鍵の移動は[App手順](github-apps.md)の変更なので、別のPRで独立レビューを受ける。

- ログインが無効・期限切れなら起動しない。人へ1回知らせる。API鍵・別サービスへ自動で切り替えない。新しいAPI費用はowner承認が要る。購読の認証であることの確かめ方と、config dirに残る設定の検査は起動器（W1）で決める。tokenはenvにあるので、同じOSユーザーの`ps`から見えうる（O3の残余リスク）。
- 注入でPRの内容が粗探しとレビューの両方を通る危険は、手動のときと同じ残余リスクとして残る。Brokerの公開の検査（§6）は流出を減らすが、判断の誤りは防がない。

### groupを離れた子（残余リスク）

所有者が[2026-10-07に受け入れた](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-6019871945)残余リスク（Codexの[ISSUE50-P001〜P003](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-6019834396)）。supervisorはworkerのprocess groupを止めて空を確かめるが（§4）、全子孫の終了は証明しない。

- groupを離れた子（setsid等）は、`cli.sb`のallow規則の**すべて**を持ったまま残りうる（`doctor.ts`の`PROFILE_ALLOWS`が規則ごとの一覧の正本で、試験が規則と突き合わせる）。runに閉じないのは、外向きのIPv4のTCP 443、名前を限らないPOSIX共有メモリの作成・読み書き（次のrunのprocessと共有しうる）、`signal (target same-sandbox)`（別の`sandbox-exec`起動へ届くかは未証明）、`notification_center`等のmach-lookup、任意のpathのmetadataの読取り。runに閉じるのは、そのrunのconfig dir・HOME・tmpの読み書きと資料・runtimeの読取り。寿命・個数・CPU・メモリ・開いたfile・diskの上限は証明しない。runのtimeoutも効かない。run領域を消しても、開いたままのfileの領域は最後の参照が閉じるまで残る。
- Tailscale Funnelが`*:443`で待ち受けても、Mac自身のアドレスの443番は上の規則で拒否される（「443番で届く先」）。CLIとその子が届くのは、インターネットの誰とも同じく、Funnelの公開URLだけ。そこでは受け口が`/webhook`へのPOST以外を404にし（[webhook.ts L209-L212](../scripts/lib/review-dispatch/webhook.ts#L209-L212)）、署名が合わなければpolicyも読まずに401にする（headerの形は[L213-L222](../scripts/lib/review-dispatch/webhook.ts#L213-L222)、HMACは[L256-L264](../scripts/lib/review-dispatch/webhook.ts#L256-L264)。経路は§3）。HMACの秘密なしには何も保存できない（[Issue #50 W8](https://github.com/doc-gif/kurashi-ledger/issues/50)）。
- 形だけ正しい偽の署名header（`sha256=`と64桁の16進）は早い401を通り、HMACの検査で401になるまで、最大25 MiBを最大5秒受信させる（memoryは`MAX_BODY`で頭打ち。接続数の上限はない）。これが受け口に残るDoSの費用（W9）。
- 起動回数の上限（§7のquota）は、残るprocessの数の上限ではない。
- この受入れは次の範囲に限る: 対象のPRは1件、toolはRead・Grep・Globだけ、hooks・MCP・pluginsなし、CLIの実行ファイルと版を固定し、版が変われば測り直す。任意の子processやauto-fixへ広げない。
- 最初の1PRで、所有者が資源の消費を確かめる。異常なら受付をpauseして手で戻す（[導入手順の18](review-dispatch-runbook.md#18-広げる前に測る)）。残るprocessがありうる間は、測り直しや連続の起動をしない。

## 8. 実装・移行・完了

1. 設計PR #46と基盤PR #48はマージ済み（Issue #45は完了）。仕様の追加・変更は実装の差分と一緒に独立レビューする。
2. Issue #50でactiveの部品を作る。W0は正本の移行（この文書と[PR書式](pr-review-loop.md#受付がactiveのpr)）。W1は起動器・Seatbelt・doctor、W2は実行結果の署名（PR48-R003）と実Broker、W3はhost検査とR007/R008、W4はactiveのCLI・Webhookの受け口・launchd・ownerの導入手順。
3. ownerが[導入手順](review-dispatch-runbook.md)でdoctorとhost検査の合格、URL・購読・秘密の設定を確かめる。shadowでは起動・投稿0。15分照合の遅延を現行5分と比べ、許可なく既存確認頻度を変えない。
4. ownerがPRごとにactiveへ切り替える。手順とrollbackは[PR書式](pr-review-loop.md#受付がactiveのpr)が正本。capability不足では人へ案内し、旧巡回を勝手に起動しない。停止中PRの一括再開はしない。

2026-10-04の所有者決定。調整係が受けた所有者の指示の受領記録（Issue #50の[1](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977365862)・[2](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977404200)・[3](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977430810)・[4](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977523656)・[5](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977629581)・[6](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977666899)・[7](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977715281)）が正本:

| ID | 所有者の決定 | 設計の提案（決定ではない） | 反映先 |
| --- | --- | --- | --- |
| O1 | Webhookで受ける。公開HTTPS経路と15分の照合を併用する | 受付Appは§3のCodex App | §3 |
| O1-route | 公開経路のB（activeに要る）はTailscale Funnel（無料、固定URL。[受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-6032842834)）。Aのクイックトンネルはshadowだけ | — | §3 |
| O2 | Claudeは購読の認証で起動する。APIキーと`--bare`は使わない | 隔離の層と具体的なflag（§7の表） | §7 |
| O2-token | 購読の資格情報は`claude setup-token`の長期tokenで渡す。閉じ込めたClaudeはkeychainに一切触れない | supervisorが`CLAUDE_CODE_OAUTH_TOKEN`で渡す | §7 |
| Codex | 外側のSeatbeltを掛けず、Codex自身の`--sandbox read-only`だけで起動する。keychainとAppの鍵に届かないことを実機で確かめる | `codex exec --json` | §7 |
| Codex-auto | 今回はCodexを自動起動しない。受付が自動起動するのはClaudeだけ。Codexのレビューは今の方法のまま。測定の仕組みは残し、disabledで出す（[受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977523656)） | — | §7 |
| net-443 | 閉じ込めたClaudeが443番へ出られることを残る危険として受け入れる。localhostは塞ぐ。toolはRead・Grep・Glob（[受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977523656)） | — | §7 |
| O3 | 別のOSユーザーでの分離は見送る | 残余リスクとして記録する | §7 |
| Windows | 受付はMacだけで動かす。Windowsでは現行の手動レビュー手順を使う | Windowsのbackendは作らない | §3、[PR書式](pr-review-loop.md#受付がactiveのpr) |
| active-merge | 受付がactiveのPRはAIがマージせず、所有者が画面でマージする。受領記録と通知は表示だけ（[受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977430810)） | — | [運用規約](github-agent-operations.md#dispatch-active) |
| 粗探しの時点 | activeのPRでは、粗探しをReadyのあと・レビューJobの前に同じhead/baseで行う | — | [運用規約](github-agent-operations.md#dispatch-active) |
| keychain | 閉じ込めたAIからAppの鍵（または同じACLの合成項目）が読めたら、Appの鍵を専用keychain fileへ移す。それまで自動起動は無効 | 移動はApp手順の変更として別PR | §7 |
| owner-merge-only | 全PRで、AIは`OWNER_MERGE_ONLY`にあるか読めないPRをマージしない。値はリポジトリ変数の1か所だけ（[受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977666899)）。AIは自分のAppで読み、doc-gifでは読まない（[受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977715281)） | 読取りは`merge-check`用途（[#55](https://github.com/doc-gif/kurashi-ledger/pull/55)） | [運用規約](github-agent-operations.md#owner-merge-only) |
| start-small | 初期運用は、対象PR 1件、必要なreviewer 1者、自動起動は実機で証明したbackend（Claude）だけ、修正は手動、マージは所有者。AIの起動回数・重複起動・Readyから結果までの時間を測り、効果が出てから広げる（[受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977629581)） | — | [PR書式](pr-review-loop.md#切替prごと) |
| R009 | 時計の後退を許す幅は5秒 | — | [host検査](review-dispatch-implementation.md#host検査pr48-r009r011) |
| group-end | 子孫の終了の証明（fdの継承）をやめ、process groupを止めて空を確かめる。空は必要条件で十分条件ではない。groupを離れた子の残余リスクをstart-smallで受け入れ、`CLAUDE_CONFIG_DIR`はrunごと（[受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-6019871945)） | — | §4、§7の残余リスク |
| R008 | workflowの信頼を記録する単位は、CIの判定を決めるファイル: `.github`全体、`package.json`、`tools/review_guard/`、`scripts/check-test-skips.ts`とその読む部品、`.npmrc`（[追加の受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977523656)、W4で実装）。試験の中身は含めず、独立した内容レビューで守る（[置換の受領記録](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977404200)） | — | [workflowの信頼](review-dispatch-implementation.md#workflowの信頼pr48-r008) |

## 9. 受入試験と導入チェックリスト

以下は実装PRの受入条件で、この設計PRで試験済みとはしない。

| ID | 入力/故障 | 独立した期待結果 |
| --- | --- | --- |
| D01 | 人↔AI、Codex↔Claude、複数reviewer | 同じ認可/Ready/CI/独立性。人にSHA転記不要 |
| D02 | 二重配送、両App/違うdelivery ID、逆順、pause後7日超の再配送 | 同じ仕事/投稿は1件。payload削除でも古いReadyを復活させない |
| D03 | dispatcherだけ落下し子が生存、spawn/manifest間の故障、PID再利用、POST不明 | supervisorへ制御再接続。group終了の不明はlease保持・再起動/再POSTなし |
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
| I001 | CLI絶対パス/版変更、schema/結果actor、Claudeの購読ログインと§7の層、capability失敗時の人/旧方式へのowner制御切替 |
| I002 | 対応Nodeのsqlite安定度、途中終了/WAL/移行/バックアップ/未知schema。repo外の合成DBで3 OS試験 |
| I003 | 10秒以内のHTTP応答、body上限、Appの配送失敗は自動再送に頼らず照合回復。issues等の購読要否、実配送/redelivery IDは導入実測 |
| I004 | 全ページ/rate limit、shadowの15分照合と現行5分の遅延/呼出し数比較 |
| I005 | base≠main/retarget/force-push、試験mergeの親とtree |
| I006 | D001〜D009の全反例を合成イベント/fake adapterで試験。実OS lock/process tree/隔離は対応backendの結合試験 |
| I007 | dispatcher/Broker/policy adapter/PURPOSESを権限制御変更として独立レビュー。固定版更新はownerだけ。正本移行でT23のpolicy_pathsへ加える |

pure testsは3 OS、SQLiteは実一時DB、macOSのrun lock/process groupは実fixture workerで検証する。実CLI/App/署名配送、host隔離、公開到達経路はownerが許可した導入試験として別記する。未検証backendはdisabledであり、default-off実装の合格を実導入の証拠にしない。受信/判定/AI起動/重複/修正往復を測り、指摘数削減を品質指標にしない。

## 10. 正本と資料

- 範囲: [Issue45](https://github.com/doc-gif/kurashi-ledger/issues/45)。現在の権限/マージ条件: [運用規約](github-agent-operations.md)、[PR書式](pr-review-loop.md)。今回の機構の正本はこの文書。入口へ詳細を複製しない。
- 認証: [App手順](github-apps.md)。[Webhook](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)、[Review API](https://docs.github.com/en/rest/pulls/reviews)、[署名検証](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)。購読候補はpull_request、pull_request_review、pull_request_review_comment、check_run/check_suite、workflow_run、push、issues。実権限/購読は導入確認。
- [Claude CLI](https://code.claude.com/docs/en/headless)、[flags](https://code.claude.com/docs/en/cli-reference)。§7のflagは2026-10-04にこの文書で確かめた。文書の確認は実行の証明ではない。固定版でのdoctorの否定試験が実起動のcapabilityを決める。Codexのexec/helpも同じ扱い。
- [Node.js 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。実行版は実装で固定・検証する。
