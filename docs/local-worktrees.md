# 同じローカル環境でのworktree運用

2026-10-02。AIごとに「別worktree＋別branch」。同じcheckoutを共同編集しない。レビュー側は原則GitHub APIで差分を読み、実装側worktreeへ手を加えない。

## 配置例

```text
IdeaProjects/
  kurashi-ledger/                    # 取得元。既存の未追跡試作コードに触らない
  kurashi-ledger-worktrees/
    t00-claude/                      # task/t00-claude
    t04-designer/                    # task/t04-designer（割当後に作成）
```

これは配置例であり、現時点で各worktreeを作成したわけではない。初期の元checkoutには未公開の試作コードが残っている。新worktreeは最新origin/mainから作り、それらのファイルをコピーしない。

## 着手時の確認と作成例

元checkoutで次を確認する。dirtyでも消去・stashしない。branch名とパスは担当ごとに一意にし、既に存在すれば担当と状態を調べる。

```sh
git remote -v
git status --short
git worktree list
git fetch origin --prune
git rev-parse origin/main
git branch --list task/t00-claude
```

originが対象repoで、mainの規約・担当・依存を確認し、同名branch/worktreeがない場合にだけ作る。

```sh
mkdir -p ../kurashi-ledger-worktrees
git worktree add -b task/t00-claude ../kurashi-ledger-worktrees/t00-claude origin/main
```

以後は作成先をIDE・AIツールの作業ディレクトリにする。各workerでbranch、HEAD、作業ディレクトリを確認してから編集する。起動用に使った元checkoutへ戻って編集しない。

認証やSSH接続に失敗した場合はまず原因を確認し、失敗を無視して古いmainから着手しない。既存のSSH設定・資格情報を勝手に書き換えない。

## 共有されるもの・分けるもの

Git worktreeは作業ファイルとindexを分けるが、repo設定、remoteの参照、object database等は共有する。branchの削除、強制更新、共通hook設定、認証設定、破壊的なGit保守を各AIが勝手に行わない。

node_modules、build生成物、作業用DB、証憑用の合成データ、テスト一時領域、開発サーバーportはworktree/runごとに分ける。共通の実データDBへ接続しない。branchが違っても実行時データやportの衝突は防げない。

mainの更新はfetchで把握し、取り込みが必要ならそのbranchの担当だけが行う。レビュー中に取り込む場合もworkingへの変更、再検証、新SHAの引継ぎが必要。別AIが同じbranchを自動更新しない。

## 中断と終了

実行セッション・担当タスク・branch・worktree・head/base・未保存変更・検証状況を残す。定期実行は担当ごとに1つとし、前runがまだ動いていれば次runは新しい作業を開始しない。

マージ前・未commit・未pushの変更があるworktreeは削除しない。整理は担当終了、必要な変更の保存、PRの状態を確認してから所有者または調整係が行う。git clean、強制branch削除、他担当のworktree removeで片付けない。
