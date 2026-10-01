# PRの引継ぎとレビューのループ

2026-10-02。実装側はPRまで、Codex側は内容レビューまで。マージは所有者の明示指示まで待つ。製品実装は現在停止中。

## 1. 実装側の完了報告

PRは途中ならDraftで作成する。完了後はOpenへ切り替えることを推奨するが、Draftのままでも下記の明示的な引継ぎがあればCodexレビューを依頼できる。CopilotのrepoルールはDraftを自動レビューしない設定。

次の形式をPRコメントに記載する。山括弧は実値へ置き換え、head/baseは40文字の実際のcommit SHAを記入する。現在のmainを取得し、CI・検証がどのbase/headを対象にしたか確認する。

```text
<!-- kurashi-ledger:handoff:v1 -->
role: implementer
agent_id: <実装セッションID>
task_id: <T番号と関連Issue>
spec_revision: <承認仕様の版>
worker_status: ready-for-review
head_sha: <PRの最新head SHA>
base_sha: <確認したmain SHA>

変更内容:
受入条件ごとの確認結果:
実行した検証・対象commit・CIへのリンク:
未対応事項・確認してほしい点:
```

この報告以降は差分を変更せずレビューを待つ。修正を再開する前にworker_status=workingを明記し、可能ならDraftへ戻す。新しいpush後は古い完了報告を流用せず、新head/baseと検証結果で引き継ぐ。

## 2. レビュー開始の条件

- 最新mainの許可範囲と担当が確認できる。
- head/baseに対応するready-for-review報告があり、その後にworkingや取消がない。
- 実装者の主張だけでなく、差分・受入条件・検証証跡が確認できる。
- 必要CIが完了している。失敗なら修正待ち、未完了なら待つ。文書のみでCI自体が未導入の場合は、CI未導入と明示して文書検証へ進める。

更新が止まった時間、Open状態、古いCI成功だけでは完了とみなさない。baseだけ変わった場合も新しい確認報告を求める。開始条件の不足は同じheadに一度だけ知らせる。

## 3. Codex側のレビュー

受入条件、データの意味、unknownと0、二重計上、履歴、制度の適用範囲・出典・丸め、テスト期待値、UIの表示、秘密情報を確認する。Copilot指摘も読み、妥当性と対応状況を独立に評価する。

実装者とGitHubアカウントが同じ場合はCOMMENTとして記録する。自分で作成した変更を独立レビュー済みと扱わない。投稿直前にhead/baseとworker状態を再取得し、途中で変わった場合は完了レビューを投稿しない。

```text
<!-- kurashi-ledger:review:v1 -->
role: codex-reviewer
head_sha: <対象head SHA>
base_sha: <対象base SHA>
decision: changes-requested | accepted | needs-owner

確認した範囲・検証証跡:
未検証の範囲:
R-001: <箇所・問題・影響・直してほしい条件>
R-002: <同上>
```

指摘があるときだけR番号を付ける。同じ指摘は修正後も同じIDで追跡する。decisionと指摘IDは運用記録であり、GitHubの正式Approveに相当するものではない。acceptedにも対象SHAと検証の限界を記載する。

## 4. 実装側の次の巡回

自分の未完了PRを先に確認し、Codex・Copilot・人の指摘を取得する。修正するときは同じbranch/PRを使い、指摘IDごとに「修正したcommitと検証」「対応不要の理由」「仕様判断待ち」を記録する。

他者のレビューthreadを、コメントに返信しただけで勝手にresolveしない。解消確認は原則レビュワーが行う。新push後は検証と新しい引継ぎを作り、再レビューを待つ。Copilotから同じ指摘が繰り返された場合も、既存指摘と対応付けて重複作業を避ける。

自分のPRがreviewingなら待つ。accepted-awaiting-ownerなら実装作業は完了しているが、依存タスクの完了条件はまだ満たさない。所有者のマージ後に依存を解放する。

## 5. 重複防止と止めどころ

レビュー記録はPR番号・head・base・role・decisionで照合し、同じ対象・同じ結果を繰り返し投稿しない。新たな重大情報がある場合だけ追加する。API取得失敗を「指摘なし」とみなさない。

仕様変更、レビュー間の対立、2回の修正で解決しない同一問題、利用枠不足、完了報告の出し方が不明な場合はneeds-ownerにまとめる。外部AI同士の無制限な往復や、承認の自己生成を避ける。
