# Kurashi Ledger

複数勤務先の給与・銀行入金、税金・社会保険の記録と見通しを管理する個人向けアプリの設計プロジェクトです。

**2026-10-02に製品の実装を始めました。** このリポジトリは設計資料とAIエージェント向けの作業規約を共有します。利用できるアプリ、税・保険の計算、製品CIはまだありません。実装側AIはPRまで進め、実装していない別のAIが内容レビューを担当します。マージは、条件を満たした自分のPRだけを実装側が手動で行い、自動マージは行いません。

## 別のAIが作業を引き継ぐとき

最初に [AGENTS.md](AGENTS.md) と [現在の状態](docs/project-status.md) を読んでください。最新mainと関連Issue・PRを確認し、実装の許可・担当・依存関係が揃ってからタスク専用worktreeで着手します。古い会話やcloneの状態だけで進めません。

## 設計資料

- [実装順序・並行作業](docs/implementation-plan.md)
- [タスク台帳 — T00–T28と任意評価E01](docs/implementation-tasks.md)
- [技術構成の決定（ADR）](docs/adr/README.md)
- [実装AIとレビューAIの役割分担](docs/github-agent-operations.md)
- [PRの完了報告・指摘対応・再レビュー](docs/pr-review-loop.md)
- [Claude Code等へ渡す定期確認の指示](docs/external-worker.md)
- [最初の担当へ渡すプロンプト（T00）](docs/first-worker-prompt.md)
- [ローカルのworktree・branch運用](docs/local-worktrees.md)
- [アーキテクチャ](docs/architecture.md)
- [テスト方針](docs/testing.md)
- [公開・運用方針](SECURITY.md)
- [OpenFiscaの検証項目](experiments/openfisca/README.md)

Copilotの自動レビュー用repoルールは設定済みです。Draftはrepo側の自動レビュー対象外、新しいpushは再レビュー対象です。作成者の利用権・利用枠に依存するため、初回PRで実動作を確認します。Claude Code用の入口は[CLAUDE.md](CLAUDE.md)です。

タスクIDはGitHub Issue番号ではありません。T00は[#1](https://github.com/doc-gif/kurashi-ledger/issues/1)です。ほかのタスクのIssueは、実装再開と担当割当のあとに対応付けます。

## 初期の機能範囲

給与明細と銀行入金をソース別に手入力し、内訳が不明な記録も残します。年間資料との照合、二重計上の防止、訂正履歴、CSV/JSON出力、バックアップと復元を先に作ります。その後に、根拠と制度版を持つ税・保険の試算、支払予定、ふるさと納税、確定申告の準備へ進みます。

画面は白・グレーに少量の青緑を使う落ち着いた方向性。Figmaの基礎と部品を先に設計し、それに沿ってUIを実装します。Mac/Windowsを主な利用環境とし、実行方式・UI・DBドライバ・配布方法・データの保管先はT00で決めました（[ADR](docs/adr/README.md)）。OpenFiscaは未採用の評価候補です。

## 公開範囲

コードを追加するときも、一般化した仕様と合成データのみを使用します。実際の明細、金額、勤務先、住所、口座情報、通知書、秘密情報は保存しません。実データは将来のアプリでリポジトリ外に保存する設計です。

ライセンスは未選択です。publicであることと、OSSとして再利用を許諾することは別です。
