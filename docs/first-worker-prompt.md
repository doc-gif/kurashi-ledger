# 最初の実装側AIへ渡すプロンプト

**T00専用の記録。** T00は2026-10-02にこのプロンプトで着手した（Issue #1、PR #2）。新しい担当の着手許可としては使わない。次の担当には、所有者が担当Issueと許可範囲を示して依頼する（[現在の状態](project-status.md)、[外部AIの定期確認](external-worker.md)）。

以下をユーザーからClaude Code等へ送る。文書が存在するだけでは着手許可にならない。今回はT00の設計作業を最初の担当とし、製品コードの実装開始とは分ける。

```text
Kurashi Ledgerの実装側担当として作業してください。
対象repoは https://github.com/doc-gif/kurashi-ledger です。
この依頼をT00「実行環境と技術構成をADRに確定」の着手許可とします。
既存の製品実装停止を全面解除するものではありません。

1. 最新origin/mainを取得し、AGENTS.md、docs/project-status.md、
   docs/implementation-plan.md、docs/implementation-tasks.md、
   docs/local-worktrees.md、docs/pr-review-loop.mdを読んでください。
2. 既存のT00 Issue・PR・担当を確認し、重複がなければT00のIssueを作成して
   担当agent/sessionとbranchを記録してください。別担当がいれば作業を奪わず知らせてください。
3. 元checkoutには未公開試作コードがあります。コピー・整理・公開せず、
   最新origin/mainから専用worktree＋task/t00-claude等の専用branchを作ってください。
   同名があれば上書きせず担当と状態を確認してください。
4. T00の成果物と受入条件に従って、Mac/Windowsでの実行方式、UI、保存、
   配布、privateデータの置き場所、バックアップ方針のADRを作成してください。
   現在の設計を読み、必要な一次資料を調べて推奨案と理由を示してください。
   アプリ・税計算・DB・Actionsの実装や新規有料サービス契約は行わないでください。
5. 変更は担当worktreeの許可範囲だけに行い、文書整合・リンク・公開差分を検証し、
   commit/pushしてDraft PRを作成してください。このIssueとPRの作成は許可します。
   完了したらOpenにし、docs/pr-review-loop.mdの形式で最新head/baseと検証結果を
   コメントしてください。未対応事項も明記してください。
6. マージ・auto-merge有効化・デプロイはしないでください。
   Codex側が定期的にレビューします。Copilotの指摘も確認し、妥当性を評価してください。
7. 指摘があればworkingと報告して同じPRで修正・検証し、新しいhead/baseで
   再度ready-for-reviewを報告してください。仕様変更や矛盾はneeds-ownerにまとめてください。
8. acceptedでも勝手にマージしないでください。T01/T02へは、T00がmainへ統合され、
   次の担当と許可範囲が決まってから進んでください。
```

ローカルの元checkoutの場所はユーザーの環境で指定する。実行が始まったらIssue URL、branch、worktree、agent/sessionを控える。

継続確認には [外部AIの定期確認](external-worker.md) の`/loop 30m`例を使う。定期登録は初回指示とは別にClaude Code側で行い、job IDを確認する。
