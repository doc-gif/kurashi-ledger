# PRの引継ぎとレビューのループ

2026-10-02。実装側はOpenのPRと引継ぎを作成して別担当のレビューを待ち、実装していない別の担当は内容レビューと結果報告を行う。マージは、[マージ条件](github-agent-operations.md#merge-conditions)を満たした自分のPRに限り、実装側が行う。2026-10-02に製品実装の停止を解除した。

## コメントを短くする

結論と次の行動を短い日本語で先に書く。要約は3〜5行を目安とし、前回との差分を中心に、経緯・規約・ログの再掲はリンクへ置き換える。詳細な文章整理は[スキル](../.agents/skills/google-technical-writing/SKILL.md)を参照する。

marker・role・SHA・計画情報の行は下記の形式を維持する。全ての必要な指摘に固定ID・箇所・影響・完了条件を残し、解消済みIDは原則1行にまとめる。文字数のために欠陥や未検証範囲を隠さない。折り畳みだけではAI入力は減らない。

## 1. 実装側の完了報告

PRは途中ならDraftで作成する。レビューを依頼するときはOpenへ切り替え、下記の明示的な引継ぎを残す。CopilotのrepoルールはDraftを自動レビューしない設定。

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
plan_path: <このPRの計画パス>
plan_commit: <計画を記録・更新した40文字SHA>
plan_recheck: <今回の修正での再確認結果、または更新点>

結論・依頼: <今回確認してほしいこと>
変更内容: <前回との差分。指摘ID → 修正とcommit>
README: <更新したREADMEと内容、または「更新不要」と理由（AGENTS.md）>
受入条件ごとの確認結果: <条件ID → 結果／証跡リンク>
実行した検証・対象commit・CIへのリンク: <コマンド・環境・結果。詳細ログはリンク>
未対応事項・確認してほしい点: <残件。なければ「なし」>
```

この報告以降は差分を変更せずレビューを待つ。修正を再開する前にworker_status=workingを明記し、可能ならDraftへ戻す。新しいpush後は古い完了報告を流用せず、新head/baseと検証結果で引き継ぐ。

## 2. レビュー開始の条件

- 最新mainの許可範囲と担当が確認できる。
- head/baseに対応するready-for-review報告があり、その後にworkingや取消がない。
- 実装者の主張だけでなく、差分・受入条件・検証証跡が確認できる。
- 必要CIが完了している。失敗なら修正待ち、未完了なら待つ。文書のみでCI自体が未導入の場合は、CI未導入と明示して文書検証へ進める。

更新が止まった時間、Open状態、古いCI成功だけでは完了とみなさない。baseだけ変わった場合も新しい確認報告を求める。開始条件の不足は同じheadに一度だけ知らせる。

## 3. 別担当による内容レビュー

[修正前の整合確認](review-prevention.md)の計画と原因台帳を参照する。初回は操作全体を確認して指摘をまとめ、再レビューは修正と影響範囲を確認する。同じ原因は既存IDへ集約する。履歴の解消記録だけで最新headの回帰を無視しない。

受入条件、データの意味、unknownと0、二重計上、履歴、制度の適用範囲・出典・丸め、テスト期待値、UIの表示、秘密情報を確認する。Copilot指摘も読み、妥当性と対応状況を独立に評価する。

実装者とGitHubアカウントが同じ場合はCOMMENTとして記録する。自分で作成した変更を独立レビュー済みと扱わない。投稿直前にhead/baseとworker状態を再取得し、途中で変わった場合は完了レビューを投稿しない。

自分のAIのGitHub Appで投稿するときも、本文は下の書式のまま。`accepted`はレビューしたheadを`commit_id`に指定した`APPROVE`にし、投稿者が自分のAppのbotであることを確かめる。自分が実装・pushしたPRは承認しない。AppのAPPROVEはGitHubの承認だが、rulesetの承認の規則を設定するまではマージの必須条件ではない（マージの条件は[正本](github-agent-operations.md#merge-conditions)）。手順と、PRのcheckoutからスクリプトを実行しない規則は[AIのGitHub App](github-apps.md)の「レビューの投稿」。

```text
<!-- kurashi-ledger:review:v1 -->
role: codex-reviewer | claude-reviewer
agent_id: <レビューした担当のagent/session ID>
head_sha: <対象head SHA>
base_sha: <対象base SHA>
decision: changes-requested | accepted | needs-owner

結論・次の行動: <短い日本語で>
確認した範囲・検証証跡: <差分の範囲・CI runと試験対象commit。ローカル実行と区別>
未検証の範囲: <制約。なければ「なし」>
PR<N>-R001: <箇所・問題・影響・直してほしい条件>
PR<N>-R002: <同上>
```

新規指摘にはPR番号付きIDを付ける。既存のR-001等はそのPR番号と組み合わせてPR<N>-R001へ対応付け、再採番しない。role: reviewer（旧表記）もcodex-reviewer / claude-reviewerと同じ役割として読み、重複投稿しない。agent_idは協調用の表示で本人確認の証明ではない。同じ指摘は修正後も同じIDで追跡する。decisionと指摘IDは運用記録であり、GitHubの正式Approveに相当するものではない。acceptedにも対象SHAと検証の限界を記載する。

## 4. 実装側の次の巡回

自分の未完了PRを先に確認し、別担当（Codex側・Claude側）・Copilot・人の指摘を取得する。修正するときは同じbranch/PRを使い、[指摘全体と設計の再確認](review-prevention.md#変更前の手順)を先に行い、指摘IDごとに「修正したcommitと検証」「対応不要の理由」「仕様判断待ち」を記録する。

他者のレビューthreadを、コメントに返信しただけで勝手にresolveしない。解消確認は原則レビュワーが行う。新push後は検証と新しい引継ぎを作り、再レビューを待つ。Copilotから同じ指摘が繰り返された場合も、既存指摘と対応付けて重複作業を避ける。

自分のPRがreviewingなら待つ。acceptedでも、マージされるまでは依存タスクの完了条件を満たさない。[マージ条件](github-agent-operations.md#merge-conditions)とマージ後の第1親確認を満たしてから依存を解放する。

## 5. 重複防止と止めどころ

レビュー記録はPR番号・head・base・レビュワー識別・decision（旧role表記も同じ担当として正規化）で照合し、同じ対象・同じ結果を繰り返し投稿しない。新たな重大情報がある場合だけ追加する。API取得失敗を「指摘なし」とみなさない。

同じ原因で2回修正しても解決しなければ、局所修正を止めて[設計の整合確認](review-prevention.md)へ戻る。承認範囲内で方針を整理できる場合は一貫する案を検証する。設計を見直したあとも同じ原因で解決しなければneeds-ownerとして止める。試行回数をリセットして無制限に続けない。利用枠不足、完了報告の出し方が不明、仕様拡大、両立しない要求（解消済みの欠陥を再発させる要求を含む）、費用・権限など所有者の判断が必要な場合だけ、needs-ownerとして推奨案・選択肢・利点と欠点を短く示す。Copilotは[現行マージ条件](github-agent-operations.md#merge-conditions)で任意とした。Copilotの無応答・利用枠不足だけで停止したり、同じ所有者判断を再度求めたりしない。外部AI同士の無制限な往復や、承認の自己生成を避ける。レビューの長期化だけを理由に同じ許可を取り直さない。
