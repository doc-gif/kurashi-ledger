## 対象

- Task ID / 関連Issue:
- 承認仕様revision:
- 実装agent/session ID:

## 変更と非対象

## 受入条件と検証

- 対象head/base:
- 実施した検証と結果・CIリンク:
- 未検証・未対応事項:
- 公開差分に実データ・秘密情報が含まれないことの確認:

## レビューへの引継ぎ

作業中はDraftを推奨します。完了したらdocs/pr-review-loop.mdの形式で対象head/baseとworker_status=ready-for-reviewをPRコメントへ記載してください。このテンプレートを埋めるだけでは完了報告になりません。

レビュー中は差分を変更せず、修正再開時はworkingを明記してください。マージは、AGENTS.mdの条件（実装していない別の担当のaccepted、Copilotの未対応の指摘なし、baseの変化と競合なし）を満たしたあとで、実装担当が`--match-head-commit`付きで行います。
