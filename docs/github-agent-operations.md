# Kurashi Ledger GitHub・複数AI運用設計

2026-10-02 / 自動運用の設計。リポジトリ自体は文書を共有するために公開するが、workflow、AI起動、定期実行、自動マージは未実装・未有効化。現在の運用状態は [project-status.md](project-status.md) を確認する。

ユーザーが選んだ到達点は **承認済みIssueを実装し、条件を満たせばマージまで自動で進めること**。この選択は、現在の「まだ実装しない」を解除しない。実装開始後も観察 → 割当 → 条件付きマージの順に導入する。

## 1. 役割

| 役割 | 行うこと | 行わないこと |
| --- | --- | --- |
| 所有者 | 目的・Issueの範囲・自動化方針・予算を承認 | 日々の全手順を手作業で回すことを前提にしない |
| 調整係（1つ） | 状態の再確認、割当、競合整理、停止、完了判定 | 製品機能の実装を同じ処理内で行わない |
| 実装AI | 割当Issueを専用worktreeで実装・検証しDraft PRを作る | 自分をレビュー済みにする、勝手に範囲を広げる |
| レビューAI／人 | 別の視点で仕様・差分・テスト・根拠を確認 | CI成功を読んだだけで承認する |
| マージ処理 | 信頼された条件と最新GitHub状態を照合し統合 | PRのコードや自由文を権限付きで実行する |

調整係・実装・レビューは論理的に分離する。AI製品は固定せず、起動・状態確認・停止・結果取得のAdapterを用意する。最初から全AIサービスの連携を作らず、利用する1つを選ぶ。

GitHub Actionsは巡回・CI・短い制御処理に使う。AI推論は必要なタスクがあるときだけ呼ぶ。一般のcron pollingで毎回LLMに全Issueを読ませない。

## 2. Issueを実行可能なタスクにする

Issueの必須項目:

- `task_id`、目的、完了後に変わる振る舞い、非対象。
- 受入条件と検証方法、契約・資料の版、前提の未確認事項。
- `depends_on`（タスクID＋Issue番号）、親Epic。依存循環・参照不存在はblocked。
- `write_scope`（変更するpath領域）、`resources`（Figma、schema、lockfileなど）、実行可能環境。
- `risk`、優先度、実行上限、期待する成果物。
- `spec_revision`または仕様hash、所有者が承認したrevision、`auto_implement`と`auto_merge`の適否。

状態は `backlog → ready → claimed → in-progress → in-review → merge-ready → done`。横断状態に`blocked`、`needs-owner`、`paused`、`failed`を用意する。状態ラベルは表示用で、着手判定は承認・依存・担当・PRの実データから再計算する。

`ready`は「誰かが付けたので実行してよい」ではない。自由文、外部コメント、AIが自身で付けた承認ラベルは権限付与に使わない。承認済みrevisionと異なる仕様変更があれば新規着手を止め、担当にも差分を渡す。

Issueを閉じた理由も確認する。取り下げ・重複・中止でclosedになった依存タスクは達成扱いにしない。ドキュメントだけの調査タスクは、受入済み成果物のcommitを完了証拠にする。

## 3. 同時実行と担当記録

初期提案は作業者2名、最大3名。1 Issueにつき実装担当は1名。レビュワーは同じIssueを別目的で読めるが、同じbranchへ同時pushしない。

担当記録には `task_id / spec_revision / agent_id / run_id / claim_id / generation / branch / base_sha / resources / acquired_at / heartbeat_at / expires_at` を持つ。`agent_id`はAIのセッション識別子であり、GitHubアカウント名だけで区別しない。

claimの発行・更新・再割当は**単一の調整係**だけが行う。Issueに「空いているか確認してからロックIssueを作る」だけでは原子的な排他にならない。初期構成は同じGitHub Actions concurrency groupに短い調整処理を集め、重複triggerをまとめて最新状態を再取得する。workerの長時間実行はこのgroupの外に出す。

GitHubのconcurrencyは同時実行を制御するが、Issue更新のtransactionや永続的な仕事キューではない。失われたtriggerがあっても次の全体再確認で回復できるようにする。順序をdispatch順に依存させない。[公式仕様](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

workerが外部サービス上でまだ動いている間はclaimを保持する。期限切れは「生存不明」であり、自動で空きにはしない。実行基盤の状態を調べ、停止／終了を確認してからgenerationを進める。古いgenerationからの結果は担当完了やマージ判定に採用しない。停止できる保証がなければneeds-ownerにする。

FigmaはGitで分離できない。設計マスターを更新する担当は常に1名、他担当は下書きかコード側の作業へ移る。直接書込みの権限を持った古いworkerを止められない場合、leaseだけでは保護できない。Figma更新はローカル担当の逐次実行を初期方針とする。

Gitのworkerはclaim固有branchとworktree、合成の専用DBを使う。依存PRがmainへ入った後に新しいbaseから着手する。PRへmainを取り込む担当も1名にし、Botが実装中のbranchを無断更新しない。

## 4. 定期確認の流れ

初期の候補は**毎時17分、24時間**。正時の混雑を避ける。手動実行とIssue/PR/CIイベントでも同じ再確認処理を呼ぶ。時刻は運用表示上Asia/Tokyoで示す。実装時に利用環境のschedule仕様を確認して設定する。

1. 全体の実装停止／自動実装／自動マージの設定と予算を読む。
2. Issue、open PR、最新CI・レビュー、依存commit、担当記録をページ末尾まで取得する。API結果が不完全なら新規起動・マージを止める。
3. 既存作業の完了・失敗・生存不明を処理する。現在のPRを持つタスクを新規作業として起動しない。
4. 未解決レビュー・既存CI失敗の修正を新規機能より優先する。原因不明のインフラ失敗とコード失敗を分ける。
5. 依存完了、仕様承認、競合なし、予算内のIssueを優先度→依存を解放する効果→待機時間で選ぶ。
6. claimを確定後、起動直前にpauseと仕様revisionを再確認しworkerを起動する。起動応答が失われた場合は同じidempotency keyで確認し、別runを即座に増やさない。
7. レビュー待ちなら別担当へ渡す。merge-readyなら第6節を再検証する。
8. 意味のある状態変化だけを記録・通知する。同じ失敗や不足情報で毎時コメントを増やさない。

GitHub scheduleは遅延や欠落の可能性があり、default branch上のworkflowで動く。public repoでは無活動60日で自動無効化され得るため、厳密な時刻保証や24時間監視とは扱わない。手動復旧入口と最終成功時刻を残す。[公式のschedule仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

同じ停止したschedulerだけで「自分が停止した」と通知することはできない。厳密な死活監視が必要になった時点で外部監視を追加する。最初から別cronを重ねて二重起動する構成にはしない。

## 5. 追加作業をどこまで自動で進めるか

| 見つけたこと | 処理 |
| --- | --- |
| 担当Issueの受入条件に対する不具合・レビュー指摘 | 既存Issue/PRで修正。予算・回数上限内なら再開 |
| 依存完了によって既存の承認済みIssueが着手可能になった | 空き枠で割当 |
| 新機能、仕様変更、別制度・地域対応 | 根拠と受入条件案を付けた候補Issueを作成または既存に集約。承認まではbacklog |
| 想定より大きい改修、契約変更、予算不足 | scopeを勝手に広げずneeds-owner |
| mainで回帰を検出 | 新規の自動マージを止め、原因と影響を記録。既定の修正許可範囲を満たすタスクのみ再開 |

候補Issue作成は、関連task・原因・対象path等からfingerprintを作って重複を抑える。タイトル一致だけで判断せず、作成応答不明なら再取得する。初期は1巡回2件まで。自動作成IssueにAI自身が承認を付けない。

## 6. 条件付き自動マージ

実装再開後、所有者はIssueごとに何度も同じ確認をする代わりに、承認した仕様revisionと自動マージ対象範囲を登録する。通常の承認範囲内の変更は下記を満たせば自動で統合する。

必須条件:

1. 対象Issueの仕様revisionが承認済みで、`auto_merge`が許可され、変更が受入条件・write_scope・予算に収まる。
2. PRはDraftでなく、対象repo・branch・担当claimが一致する。衝突・未解決の変更要求がない。
3. 最新headと統合対象baseに対する必要CIが成功。過去run・異なるhead・取り消されたcheck・不明なskipを採用しない。
4. **実装担当とは別のレビュー担当**が対象差分を確認し、対象head/base、指摘、対応確認、残る制約を記録する。
5. privacy/security確認と、変更種別に必要な追加証拠が揃う。UIなら該当画面の目視とアクセシビリティ、計算なら独立した根拠付き期待値、保存処理ならmigration/復元試験。
6. 信頼されたMerge eligibility gateが上記を検証し、mainの保護を迂回しない。マージ直前にpause・承認取消・head/baseの変化を再確認する。

新しいpushでレビューは失効する。baseが変わった場合もCIと統合影響を再評価する。承認仕様の変更は自動マージを止める。マージは1件ずつ、次はmain側の必要検証完了後に進める。

コード所有者が1つのGitHubアカウントをAIと共有していると、別のAI名が付いていてもGitHub上の独立した承認にはならない。PR作者本人のApproveを必須にすると行き詰まる。**自動マージ導入時は、worker・レビュー結果の検証／マージを別の権限主体へ分ける**。短命のGitHub App token等を使い、workerにmain保護迂回・Merge gate発行の権限を渡さない。

AIレビューの結果はworkerが自由に編集できるJSONやコメントだけでは証明にならない。信頼された制御側がレビュー実行元、対象SHA、claim、結果を検証し、専用の発行主体によるrequired checkとして反映する。GitHubの承認レビューを代用するBotがCIを読んだだけでAPPROVEする方式は使わない。こうした分離を構成できない環境では、PR完成まで自動化し、マージのみ人が行う。

追加の所有者確認が必要となる提案範囲は、CI権限・承認ゲート自体の変更、破壊的migration・データ削除、秘密情報の扱い変更、ライセンス変更、既存の税計算の期待値や制度適用範囲の変更。最初の制度実装で承認済み仕様と独立期待値が揃っていれば、その通りの実装は通常条件で進められる。単純に「税計算ファイルだから毎回止める」運用にはしない。

GitHub標準auto-mergeを優先し、required checks・保護ルールで条件を表現する。public repoではGitHub Freeでもauto-mergeを利用できる。承認失効とマージの競合を防げることを検証してから採用し、条件をrequired checkに表せない間は常時予約せず、単一調整係による直前判定＋expected head SHA付きmergeを検討する。どちらも保護を迂回しない。[auto-mergeの公式説明](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository)

なお、標準auto-mergeとmerge queueは別機能。個人所有repoで組織向けmerge queueを前提にしない。自前の長時間ポーリング式キューも初期構成には入れない。[merge queueの提供範囲](https://docs.github.com/en/pull-requests/concepts/deploying-code)

## 7. 権限・費用・停止

- 巡回の収集部分はread-only、候補Issue・担当記録の書込み、AI起動、マージは必要な権限だけ別処理へ渡す。workflowや判定スクリプトは信頼されたdefault branchから読む。
- PRのコードを実行するCIに、マージ・外部AI・個人DBへの資格情報を渡さない。Issue/PR本文をshellや高権限AIの指示に直接展開しない。[GitHubの安全な運用](https://docs.github.com/en/actions/reference/security/secure-use)
- 実データ・給与明細・会話内容・私的レビュー報告をpublic Issue/PR・ログ・artifactへ送らない。AIによる実装も合成データで完結させる。
- GitHub標準hosted runnerはpublic repoで無料だが、larger runnerやAIモデルAPI等は別。無料ActionsだからAI実装も無料とは見積もらない。[GitHub Actionsの課金](https://docs.github.com/en/actions/concepts/billing-and-usage)
- 初期の提案上限は同時実装2件、1run最大60分、同じ失敗への自動修正2回、外部障害再試行2回、候補Issueは巡回2件。金額上限は使用AIの料金を確認して所有者設定を必須にし、未設定なら有料起動しない。実行中の費用＋予約費用を枠から差し引く。
- `implementation_enabled`、`dispatch_enabled`、`merge_enabled`を別々に持つ。全停止は新規起動だけでなく、動いているworkerの停止要求、auto-merge予約の解除、結果書込みの拒否まで伝播させる。停止確認できないworkerがあれば明示する。
- mainへのマージ後もmainチェックが失敗したら後続マージを止める。自動revertは別の権限・運用設計が必要なので初期非対応。修正候補と影響を通知する。

GITHUB_TOKENで作成・更新したPRに対するworkflowの起動には制約がある。通常のpushと同様に動くと仮定せず、選んだGitHub App token等で実際にCIが起動することをT24で検証する。高権限処理から未知のworkflowをまとめて承認する回避策は使わない。[公式のtokenとイベント仕様](https://docs.github.com/en/actions/concepts/security/github_token)

## 8. 運用データの所在

| 情報 | 正本 |
| --- | --- |
| 仕様・契約・制度manifest | レビューされたGit上の資料 |
| 実行対象の仕様revision・承認 | 信頼された承認記録＋Issueへの参照 |
| タスクとPRの進捗 | GitHubのIssue/PRとCI、確認済み成果物commit |
| 担当claim | 単一調整係が書く構造化記録。Issue上に表示する場合も発行主体を確認 |
| AI実行ID・予算・認証 | 実行基盤の制御領域。公開ログにtokenを出さない |
| 実際の給与・証憑・計算結果 | 利用者のprivateな保存領域 |

状態が食い違う場合、labelsより実PR・commit・実行基盤の状態を優先し、矛盾を未解決のまま新規起動しない。GitHub Issueコメントを全てイベントソーシング基盤に見立てるような大掛かりな仕組みは作らない。

## 9. T24で必須の異常系試験

| シナリオ | 期待結果 |
| --- | --- |
| 同じIssueが同時に2回着手候補になる | claimとworkerが各1つ |
| 起動成功後に応答だけ失われる | 実行IDを照会し二重起動しない |
| 前workerのheartbeatが切れる | 生存確認までは再割当しない |
| 旧workerが後から完了通知する | 古いgenerationを採用しない |
| PR作成後に担当の状態が消える | PRと実行情報を照合し新PRを増やさない |
| Issueがclosedだが依存成果物はない | 後続はblocked |
| 最新commit失敗・一つ前成功 | merge不可 |
| レビュー後にpush／base変更 | レビュー・CI・merge可否を再判定 |
| 正式通知や制度の出典が不足 | 計算仕様の候補へ戻し勝手に補完しない |
| 同じ追加作業を毎回見つける | 既存Issueを更新、重複作成しない |
| Issue本文が資格情報取得を指示 | データとして扱い、起動権限や目的を変更しない |
| workerがgateを成功と偽装する | 発行主体不一致で拒否 |
| マージ直前に全停止・承認取消 | 予約解除と再検証、mergeを実行しない |
| 予算上限・API部分取得・rate limit | 新規起動とmergeを保留し理由を記録 |
| merge成功後のmainで回帰 | 後続merge停止、同じ障害の通知は集約 |

## 10. 他のAIへの引継ぎの型

タスクID／Issue URL、承認仕様revision、現在のbranch・head・base、変更した範囲、実行した検証と結果、未解決事項、次の最小作業、claimの扱い、関連PRを残す。秘密・実データは書かない。

中断時は「完了」と書かず、buildが通るか、未保存作業があるか、他のAIが触ってよいかを明記する。直列引継ぎでも旧worker終了確認と新generation発行を行う。並行時だけの特別ルールにしない。
