# 外部AIに渡す実装・修正の定期確認指示

2026-10-02。Claude Code等の別ツール用。このファイルを置くだけでは定期実行は始まらない。実装の可否と担当は[現在の状態](project-status.md)で確認し、所有者が割り当てた担当Issueから始める。[T00の開始プロンプト](first-worker-prompt.md)はT00専用の記録で、新しい担当の着手許可としては使わない。

## 最初に渡す文章

> GitHubのdoc-gif/kurashi-ledgerを担当してください。まず最新mainを取得し、AGENTS.md、docs/project-status.md、docs/implementation-tasks.md、docs/github-agent-operations.md、docs/pr-review-loop.mdを読んでください。実装停止中なら実装せず、許可された調査・設計だけに留めてください。実装再開後は所有者から割り当てられた承認済みIssueを専用branch/worktreeで進め、Draft/Open PRまで作成してください。マージ、auto-merge有効化、デプロイはしないでください。レビュー依頼時はOpenへ切り替え、docs/pr-review-loop.mdの形式でhead/base付き引継ぎを残してください。
>
> 10分ごとの確認では、自分の既存PRのCI・差分を作成していない別担当のレビュー・Copilot指摘を新規タスクより優先してください。必要な修正は同じPRへcommitし、検証結果と指摘ごとの対応理由、新head/baseの引継ぎを残してください。指摘が妥当でない場合は根拠を示し、無条件で変更しないでください。レビュー待ちや変更なしなら投稿しません。未担当のIssueを勝手に取得したり、既存担当の作業を奪ったりしないでください。実装・レビュー双方の停止状態、仕様revision、依存PRのmain統合を毎回確認してください。
>
> 秘密情報や実際の給与資料を公開領域へ送らず、合成データを使ってください。利用できる実行環境と上限を確認し、未知の有料サービスを契約しないでください。新規作業・仕様拡大・指摘の矛盾は候補やneeds-ownerとして残してください。同じGitHubアカウントを他AIと共有する場合は、agent/session IDとbranchを明示してください。

## Claude Codeでの登録例

対話中のセッションを使うなら、上の文章を渡した後に次を依頼する。

```text
/loop 10m 最新mainのAGENTS.mdとdocs/project-status.md、docs/external-worker.mdに従い、担当PRのレビュー指摘対応または承認済み担当タスクの次の作業を確認してください。実装停止中は実装せず、PR作成までに留め、マージしないでください。変更がなければ投稿不要です。
```

既に1時間ごとのジョブがある場合は、既存ジョブを10分ごとへ変更する。新旧2本を同時に動かさず、変更できない場合は旧ジョブを停止してから登録する。前runがまだ作業中なら新しいrunを重ねない。

これはユーザーがClaude Codeのセッションで登録するための例であり、現在起動済みのジョブではない。実行環境の画面でジョブIDと頻度を確認してから「稼働中」と扱う。

`/loop`は開いているローカルセッション向け。公式資料では繰り返しtaskに有効期限があり、長期運用にはDesktopのscheduled taskまたはCloud Routinesを使う。常時PCを動かすか、fresh cloneのクラウドで作業するかで選ぶ。クラウドではローカルファイルやFigma環境を使えるとは仮定しない。[Claude Codeのスケジュール比較](https://code.claude.com/docs/en/scheduled-tasks)

10分間隔でセッション外でも継続したい場合は、Claude Code Desktopのscheduled taskを検討する。Cloud Routinesは公式資料上の最短間隔が1時間のため、同じ10分設定にはできない。利用プラン・接続repo・branch権限・ネットワーク・費用上限はその環境で確認する。[スケジュール比較](https://code.claude.com/docs/en/scheduled-tasks)

## 現在の状態

外部AIの定期実行は、ユーザーがClaude Code等の実行環境で、担当ごとに1本登録する方針。Codex側では外部ジョブを登録・起動していない。開始するAIツール側で本指示を登録し、担当Issueと実行IDを、担当のIssue・PRの引継ぎで共有する。Codex側のPR確認とは独立したジョブである。
