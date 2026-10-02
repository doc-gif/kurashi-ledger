# AIエージェントの作業規約

## 最初に読む

1. [現在の状態と実装可否](docs/project-status.md)
2. [実装計画・依存関係](docs/implementation-plan.md)
3. [タスク台帳・受入条件](docs/implementation-tasks.md)
4. [GitHub・複数AIの運用設計](docs/github-agent-operations.md)、[PR引継ぎ・レビュー](docs/pr-review-loop.md)
5. [アーキテクチャ](docs/architecture.md)、[テスト方針](docs/testing.md)、[公開・運用方針](SECURITY.md)

**現在は設計段階で実装停止中。** Issue原稿や予定があることを着手許可と解釈しない。所有者が実装再開を明示した場合はその指示を優先し、状態資料へ反映して進める。同じ許可を再度要求する必要はない。

## GitHubから最新状態を確認する

- 会話履歴、古いclone、以前の引継ぎだけを根拠に着手しない。remoteの接続先を確認し、`git fetch origin --prune`で最新情報を取得する。現在のbranch、未コミット変更、最新の`origin/main`のSHAを確認する。
- 最新mainの本規約・状態・関連仕様を読み直す。関連Issueとopen PR、依存タスクの成果物、担当中の作業を確認する。一覧がページ分割される場合は必要な全ページを読む。
- 通信・認証の失敗で最新状態が確認できなければ、ローカル調査と設計整理に留め、競合し得る新規着手やマージをしない。
- 他者のcheckoutに対して勝手にpull、reset、stash、clean、branch切替をしない。dirtyな作業を消さない。
- 実装時は最新`origin/main`からタスク専用branch・worktreeを作る。[ローカルworktree運用](docs/local-worktrees.md)に従い、元checkoutの未追跡ファイルをコピーしない。例: `git worktree add -b task/T06-records ../kurashi-ledger-T06 origin/main`。既存branch・worktreeがある場合は状態と担当を調べ、上書きしない。

## 担当と作業範囲

- 新規実装・レビュー修正の前に[過去の指摘との整合確認](docs/review-prevention.md)を行う。変更予定パスから関連する不変条件・原因・操作全体のシナリオを取り出し、新規計画または必要な更新を先に記録する。既存計画に変更がなければ再確認結果だけを引継ぎに書く。矛盾があれば局所修正へ進まず方針を見直す。構造検査の成功を独立レビューや着手許可にしない。
- 実装再開後にIssueを作成・割当し、タスクID、仕様revision、agent/session ID、branch、base SHA、変更予定範囲、共有資源、受入条件を明記する。運用システム未実装の間は所有者または指定調整係の直接割当を使う。
- 1タスクにつき実装担当1名。初期は所有者・単一調整係が割当し、T24で外部AIの定期確認・指摘対応を整える。単なるラベルやロックIssueを原子的な排他とみなさない。
- データ契約、migration、lockfile、共通トークン、Figmaマスター、CI権限は同時編集を避ける。範囲の追加や契約変更は先に調整する。
- AIごとに専用worktreeと合成DBを使う。別担当のbranchへpushしない。期限切れclaimは、元workerの停止・終了を確認するまで奪わない。
- 新機能や仕様変更は候補Issueへ分ける。承認済み範囲の不具合修正は同じタスクで進める。

## データ・設計の不変条件

- 公開領域には合成データのみ。実際の給与明細・金額・勤務先・個人パス・資格情報・会話の私的内容を、Git、Issue、PR、ログ、artifactへコピーしない。private repoの具体的な監査資料やコードも転載しない。
- 未知値は0ではない。銀行入金は総給与でも課税給与でもない。年間資料と月次明細を足して二重計上しない。
- 実績・見込み・正式通知を分け、適用期間・把握日・記録日・改訂履歴を保持する。過去の計算runを黙って書き換えない。
- UI、application、domain、infrastructureを分け、保存・時刻・制度取得等の境界へ依存を注入する。初期から汎用DSLやDIコンテナを増やさない。
- 税・保険は対象年・地域・適用範囲・原典・丸めと、独立して確認した期待値が必要。実装が返した数値をそのまま正解にしない。期待値の変更は理由と根拠を残す。
- OpenFiscaは評価候補。未承認の導入や計算器の暗黙fallbackをしない。

## 検証・公開・レビュー

- 製品の実行可能なテストは未導入。レビュー運用ツールだけは`python3 -m unittest discover -s tools/review_guard/tests -v`と`python3 -m unittest discover -s .review/tests -v`で検査する。専用CIはテンプレートを用意済みで、まだ有効化していない。文書変更はリンク、仕様整合、タスク依存、公開差分を確認する。運用ツールの成功を製品の検証済みと報告しない。
- 実装開始後はT05で決めた検証を実行する。テスト失敗を隠す、判定を弱める、skipで見かけ上成功させる変更は禁止。
- stageするファイルを明示し、公開対象の差分を読む。元のローカル環境に未追跡の試作コードがあっても、`git add .`等で一緒に公開しない。
- PRには関連Issue、変更理由、受入条件に対する証跡、対象SHA、検証、未対応範囲を記載する。1タスクに複数PRがある場合、最後まで完了するPRだけでIssueを閉じる。
- 最新head/baseのCI成功と、別担当の内容レビューを別々に確認する。CI成功だけのBot APPROVEをレビューの代用にしない。
- 実装担当はDraft/Open PRと対象head/base付きの完了報告で止める。内容レビュー・修正確認は差分を作成していない別担当が行う。Claude実装はCodex、Codex実装はClaude等が確認し、自己承認しない。担当済みPRの指摘対応はその実装者が行う。
- 自動マージ案は撤回し、auto-mergeは無効のまま維持する。acceptedはマージ許可ではない。所有者が明示指示するまで、いずれのAIもマージ・デプロイしない。
- Open状態や無更新の時間だけで完成と判断しない。最新head/baseに一致するready-for-review報告を確認し、投稿直前に再取得する。新push・base変更・working報告で古い引継ぎは失効する。
- 同一GitHubアカウントではCOMMENTにroleとdecisionを明示する。Copilotの指摘を独立評価し、返信だけで再レビューされるとは仮定しない。レビュー側はPR由来のコードを資格情報のある環境で実行しない。
- Actionsは最小権限、標準hosted runner、合成データ、reviewed commit SHA固定を基本とする。権限付きworkflowからPRの未信頼コードを実行しない。

## 終了・中断時の引継ぎ

タスクID・Issue/PR、仕様revision、branch/head/base、変更範囲、実行した検証と結果、残りの作業、次の最小手順、claimとworkerの状態を記録する。PR作成だけで完了にしない。中断時に他のAIが触ってよいかを明記し、秘密や実データは含めない。
