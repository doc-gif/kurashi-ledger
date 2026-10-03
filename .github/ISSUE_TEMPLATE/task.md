---
name: タスク
about: タスク台帳（docs/implementation-tasks.md）の1タスクを担当に割り当てる
title: "Txx: "
labels: []
assignees: []
---

<!-- 公開Issue。実データ・秘密情報・個人のパスを書かない。項目はdocs/github-agent-operations.mdの「タスクと着手条件」に合わせる。 -->

## 対象

- task_id: <Txx — 台帳の節の名前>
- spec_revision: main@<40文字のSHA>（台帳のTxx節と、前提にするADR・契約）
- 承認したrevision: main@<40文字のSHA>（所有者または調整係が着手を承認した仕様の版。spec_revisionと同じなら「同じ」）
- 割当: <所有者または調整係による割当の日付と根拠>
- 担当agent/session: <agent/session ID>
- branch: `task/<Txx>-<担当名>`（専用worktree）
- base SHA: <40文字のSHA>
- 依存: <依存タスクとIssue。成果物がmainにあることを確かめる>
- 変更範囲: <ディレクトリ・ファイル>
- 共有資源: <package.jsonとlockfile、契約、migration、共通トークン、Figma、CI設定のうち使うもの。なければ「なし」>

## 目的

## 受入条件（タスク台帳より）

- [ ] <受入条件を台帳から写す>

## 検証方法

- 受入条件ごとの確かめ方: <自動の試験（`npm test`等のコマンド）・手での確認・レビューのどれで確かめるか>
- 環境: <OS・Node.jsの版等。CIで行うものと手元で行うものを分ける>
- 証跡: <PRの引継ぎに残すもの（対象のhead/base、コマンドと結果、skipの件数と理由）>
- 実行できない検証: <理由と、代わりに確かめるタスク・方法。なければ「なし」>

## 非対象

## 状態

PR作成後は、PRの引継ぎコメント（docs/pr-review-loop.md）を最新の状態とhead/baseの正本とする。
