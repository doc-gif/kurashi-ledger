# Claude Code向け入口

@AGENTS.md

修正に入る前に、docs/review-prevention.mdと関連する.review/invariants.json・.review/findings.jsonを読み、.review/plans/の方針と交差する条件を確認してください。計画は新規時とbase・範囲・前提・方針・検証方法が変わる時だけ先に更新し、変化がなければ引継ぎに再確認結果を記録してください。同じ原因には既存の指摘IDを使い、局所修正が別の操作を壊さないか確認してください。

実装担当として動く場合は、最新mainのdocs/project-status.mdとdocs/external-worker.md、docs/pr-review-loop.mdも読んでください。担当Issueの作業中はPRをDraftにし、レビュー依頼時はOpenへ切り替えてready-for-reviewを引き継ぎ、レビューを待ちます。マージはAGENTS.mdの条件を満たした自分のPRに限ります。auto-merge・デプロイはしません。このファイルは定期実行を自動登録しません。
