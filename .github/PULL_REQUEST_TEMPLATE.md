## 対象

- Task ID / 関連Issue:
- 承認仕様revision:
- 実装agent/session ID:

## 変更と非対象

- 変更前の計画: `.review/plans/<task-id>[-<part>].json` / 計画commit:
- 今回の修正前の再確認結果／計画更新点:
- 関連する不変条件・既存の指摘ID:
- 既存仕様との矛盾と解消方針（なければ根拠）:

## 受入条件と検証

- 対象head/base:
- 実施した検証と結果・CIリンク:
- 未検証・未対応事項:
- 操作全体の確認結果（初回・更新・復元・途中終了等の該当シナリオ）:
- 公開差分に実データ・秘密情報が含まれないことの確認:

## レビューへの引継ぎ

作業中はDraftにしてください。レビューを依頼するときはOpenへ切り替え、docs/pr-review-loop.mdの形式で対象head/baseとworker_status=ready-for-reviewをPRコメントへ記載してください。このテンプレートを埋めるだけでは完了報告になりません。

レビュー中は差分を変更せず、修正再開時はworkingを明記してください。マージは、[正本の条件](https://github.com/doc-gif/kurashi-ledger/blob/main/docs/github-agent-operations.md#merge-conditions)を満たしたあとで、自分のPRに限り実装担当が`--match-head-commit`付きのマージコミットで行います。
