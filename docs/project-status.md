# 現在の状態

更新日: 2026-10-04。進捗の正本は各Issue・PR、定期実行の正本は各実行環境の設定。ここには公開範囲と所有者決定を記す。

## 実装の可否と所有者決定

- **実装フェーズ**。2026-10-02に製品停止を台帳全体で解除した。着手には所有者または調整係の担当割当が必要。[実装計画](implementation-plan.md)の依存成果物を確認する。予定・ラベル・AIの自己申告は許可ではない。
- T00はADR、README、状態資料、アーキテクチャ、台帳、計画の整合とT26–T28の設計まで含め、PR #2で完了した。T01/T02/T04はClaude側へ並行割当され、mainに統合済み。T03（#22）とT05（#17）も完了し、mainに統合済み。T05は統合済みT02の上でCIを整備した。
- 内容レビューは別担当が行う。Claude実装はCodex、Codex実装はClaudeへ回し、自分や自分のサブエージェントの差分をレビューしない。[マージ条件](github-agent-operations.md#merge-conditions)を満たした自分のPRだけを実装担当がマージする。T00もこの条件で統合した。
- 使い方・構成・運用変更ではREADMEも更新し、引継ぎに有無と理由を記す（[AGENTS](../AGENTS.md)）。設計段階の欠陥は同じPRで直し、実装時の確認は担当タスクの受入条件へ渡す。理由と解消の証跡をスレッドに記録し、別担当が確認する。Copilotは任意の補助レビューとし、[現行マージ条件](github-agent-operations.md#merge-conditions)に従う。両立しない要求は所有者判断へ戻す。
- 所有者の印と本人確認は[AGENTS](../AGENTS.md)に従う。印だけで権限を広げない。
- 2026-10-03の決定: 必須チェックはQuality gateのみ、最新base必須、計画検査をgateへ含める。Windows実機の確認3件はT05から[#19](https://github.com/doc-gif/kurashi-ledger/issues/19)へ分離し、T26/T28を止めない。[本人確認の記録](https://github.com/doc-gif/kurashi-ledger/pull/18#issuecomment-5965890988)。repo保護設定の実状態と、workflow等の自己変更による迂回の限界は[レビュー運用](review-prevention.md)を参照する。

## 公開済みの範囲

設計文書、AI指示、PRテンプレート、レビュー運用ツールと試験、開発用スクリプトと試験、CI・ブラウザ試験基盤を共有している。**利用できるアプリ、計算エンジン、製品の試験はまだない。** ローカルの未追跡試作を自動的に公開しない。

| 対象 | 正本・状態 |
|---|---|
| タスク | T00=#1、T01=#8、T02=#9、T03=#22、T04=#7、T05=#17は完了。Windows実機=#19。残りは割当時に対応付け、GitHub Issueを参照 |
| 設計 | [ADR](adr/README.md)、[台帳](implementation-tasks.md)、[計画](implementation-plan.md)。実行方式・UI・DB・配布・保管先・安全境界はT00で決定 |
| Figma | T04で基礎と3部品を作成。仕様・ID対応は[design](../design/README.md)。T08が利用。非公開URLは記載しない |
| 開発・CI | [開発環境](development.md)に版・コマンド・OS・ジョブ・証跡の読み方を集約。T02で未実施だった固定Node版と各OSの検証はT05で完了。手元の正確な版は[mise.toml](../mise.toml)、対応する範囲は`package.json`を正本とする（[#30](https://github.com/doc-gif/kurashi-ledger/issues/30)）。開発用試験の成功は製品の検証ではない |
| Codexレビュー | 受付とPR専用担当に分離。[所有者の直接指示の記録](https://github.com/doc-gif/kurashi-ledger/pull/40#issuecomment-5969756770)に基づき5分間隔・専用担当最大10件（受付を除く）。実際の登録・稼働は実行環境で確認 |
| 外部実装AI | 担当ごとに1ジョブ、所有者指定の10分を現在の基準とする。頻度・ID・状態はその環境を正本とし、引継ぎで共有。[起動指示](external-worker.md)だけでは起動しない |
| Copilot | main向け自動レビューruleset設定済み。repo設定はDraft対象外・新push対象。2026-10-04の所有者決定で任意の補助レビューとした。指摘は評価・対応するが、応答・利用枠不足・未対応指摘の有無は独立したマージ条件にしない。[正本](github-agent-operations.md#merge-conditions) |
| AIのGitHub App | 2026-10-03の所有者決定（[#41](https://github.com/doc-gif/kurashi-ledger/issues/41)）。CodexとClaudeに1つずつ、同じ権限（Administrationなし）のApp（AIの身元）を所有者が作成し、このrepoだけにインストールした。トークンは`scripts/github-app-token.ts`が発行してコマンドを実行する（表示しない）。mainのrulesetに削除の制限と強制pushの禁止を加えた。実際の鍵での確認・移行・承認の規則は所有者の確認待ち。手順は[AIのGitHub App](github-apps.md) |
| レビュー受付 | [Issue #45](https://github.com/doc-gif/kurashi-ledger/issues/45)・[#50](https://github.com/doc-gif/kurashi-ledger/issues/50)。基盤（#48）と、start-smallのactiveまでのPR（#51〜#56）はmainに統合済み。既定はoff。実機の測定・shadow・1件のactiveへの切替は所有者が[導入手順](review-dispatch-runbook.md)で行う（未実施）。activeのPRは所有者がマージする（[規則](github-agent-operations.md#dispatch-active)） |
| 診断と保守 | 設計は[ADR-0010](adr/0010-diagnostics-and-maintainability.md)（[Issue #35](https://github.com/doc-gif/kurashi-ledger/issues/35)）、実装は[台帳](implementation-tasks.md)のT29〜T32。依存の更新の提案（Dependabot、`.github/dependabot.yml`）を設定済み。Dependabotの提案のPRの取り込みは[開発環境](development.md)の「依存の更新（Dependabot）」 |
| 未決事項 | OpenFiscaは評価候補。ライセンス未選択で、publicだけではOSS再利用を許諾しない |

次の着手は計画の依存関係に従う。完了済みのT05はT26/T08が使う試験基盤を提供している。日々の作業一覧をここへ複製しない。作業中Draft、レビュー依頼Open、最新SHAの引継ぎと独立レビューは[PRループ](pr-review-loop.md)に従う。[T00開始プロンプト](first-worker-prompt.md)は歴史的記録で、新規担当への許可ではない。[worktree運用](local-worktrees.md)も確認する。
