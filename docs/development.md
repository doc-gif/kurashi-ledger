# 開発環境と作業の規約

T02（[Issue #9](https://github.com/doc-gif/kurashi-ledger/issues/9)）の成果物。実行方式と版の方針は[ADR-0002](adr/0002-runtime-and-distribution.md)、依存の導入の記録は[ADR-0008](adr/0008-install-record.md)、公開範囲は[公開範囲と公開前の点検](public-data.md)。

いまあるのは開発用の設定とスクリプトだけで、アプリの起動（T26）、UIのビルド（T08）、CI（T05）はまだない。

## Node.jsの版

| 項目 | 値 |
| --- | --- |
| 固定するメジャー | Node.js 24（LTS、Krypton） |
| 下限 | 24.15.0（`package.json`の`devEngines.runtime`と`engines`は`>=24.15.0 <25`） |
| `.nvmrc` | `24`（nvmは範囲を書けないので、メジャーだけを書く。下限より古い24.xを選ぶとnpmが止まる） |

選んだ理由（確認日: 2026-10-03）:

- ADR-0002は、T02の着手時に利用可能なLTSのうち、型除去がStable（24.12.0以上）で`node:sqlite`がRelease candidate（24.15.0以上）である版を固定すると決めた。
- Node 26はまだCurrentで、LTS入りは2026-10-28の予定。Node 24はActive LTSで、2026-10-20に保守期間（Maintenance LTS）へ移り、2028-04-30に終了する。24系の最新は24.21.0（2026-09-07）。
- そのため、Node 24の24.15.0以上に固定する。Node 26への更新は、LTS入りのあとにT28（Node.jsのメジャー更新）で行う。

出典: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json 、https://nodejs.org/dist/index.json 、https://nodejs.org/docs/latest-v24.x/api/typescript.html 、https://nodejs.org/docs/latest-v24.x/api/sqlite.html

版が合わないと、npmは`npm ci`・`npm run`の前に`EBADDEVENGINES`で止まる。`--force`で検査を外さない（`npm run setup`は`--force`を拒む）。

既知の制約: T02の作業環境のMac（Node.js 24.14.0）では、この版の検査でnpmのスクリプト（`npm run setup`等）が止まる。Node.jsを24.15.0以上に更新するまで続く。所有者は当面更新しないと決め、固定した版での確認はT05のCIで行う（下の「所有者の決定」の1）。

## 初めて使うとき

macOSはターミナル、WindowsはPowerShellで行う。Windowsでは実行ポリシーを変えず、`npm`の代わりに`npm.cmd`を使う（ADR-0002）。

1. Gitと、上の版のNode.jsを入れる（公式インストーラ、またはnvm等のバージョン管理ツール）。
2. 作業用のworktree（下の「branchとworktree」）で`npm run setup`を実行する。中で`npm ci`を実行し、成功したときだけ依存の導入の記録を書く。
3. `npm run typecheck`、`npm test`、`npm run check:public`が通ることを確かめる。

新しいcloneでも同じ手順で動く。記録は`node_modules`の中にあるので、worktreeやcloneごとに`npm run setup`を実行する。`node_modules`をほかの場所へのリンク（symlink・junction）にして共有することはできない（`npm run setup`等が何も変えずに止まる。ADR-0008）。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run setup` | 依存を導入する。既存の記録を削除し、repoの`.npmrc`と決めた引数だけで`npm ci`を実行し（利用者のnpmrcや`npm_config_`の環境変数は使わない）、成功して導入した木がlockfileと合うときだけ記録を書く（ADR-0008） |
| `npm run check:install` | 記録が、いまの`package-lock.json`・`package.json`・`.npmrc`とNode.jsの版・OS・CPUに一致し、導入した依存と実行ファイルの本体・リンクが`node_modules`の中の通常のファイルとしてそろっているかを確かめる（ファイルの中身の改ざんまでは確かめない。ADR-0008） |
| `npm run build` | 記録を確かめる。一致しなければ止まって`npm run setup`を案内する。UIのビルドと配信物のmanifestはT08で加える（いまはビルドする対象がない） |
| `npm run typecheck` | `tsc --noEmit`による型検査だけを行う。JavaScriptは出力しない |
| `npm test` | Node.js標準の試験（`node --test`）で、`scripts/`の試験を実行する |
| `npm run check:public` | 公開検査。`-- --staged`でcommitしようとしている変更だけを見る（[公開範囲と公開前の点検](public-data.md)） |

`npm run setup`は、worktreeの直下に作業中の印`.kurashi-ledger-setup.lock`を作ってから導入し、終わったら消す。同じworktreeで2つ目を起動すると、依存を変えずに止まる。

Ctrl+C（WindowsはCtrl+Breakも）や終了のシグナル（macOSの`SIGTERM`・`SIGHUP`）で止めると、新しい手順を始めず、動いている`npm ci`の終了を待ってから、記録と書きかけのファイルと自分の印を消して終える（終了コードはCtrl+Cで130。数秒かかることがある）。記録が残らないので、`npm run setup`をやり直す。Ctrl+Cを重ねても片付けは飛ばさない。

印が残るのは、setupを強制終了したとき（macOS: `kill -9`やアクティビティモニタの「強制終了」、Windows: タスク マネージャーでの終了やコンソールを閉じたとき、電源断）と、片付けで記録や印を消せなかったとき（そう表示する）だけ。印が残っていると、次のsetupと照合（`check:install`・`build`）が止まり、印に書いたプロセス番号と開始時刻を表示する。次の手順で消す（印は自動では消さない。ADR-0008）。

1. 動いているsetupがないことを確かめる（macOS: `ps -p <番号>`やアクティビティモニタ、Windows: タスク マネージャー）。番号は別のプロセスに再利用されうるので、開始時刻も見る。
2. 印を消す（macOS: `rm .kurashi-ledger-setup.lock`、WindowsのPowerShell: `Remove-Item .kurashi-ledger-setup.lock`）。片付けで記録を消せなかったと表示された場合は、原因（権限等）を直してから、記録`node_modules/.kurashi-ledger-install.json`も消す。
3. `npm run setup`をやり直す。

依存の導入は`npm run setup`だけで行い、`npm ci`や`npm install`を直接実行しない（記録は書かれない）。`npm ci`を直接実行すると、`node_modules`と一緒に記録が消えるので、`npm run build`（T09以降は`start:real`と`:real`の保守コマンドも）が止まる。`npm install`は記録を消さない。導入が最後まで進めば、npmが書き直すhidden lockfileが変わるので照合で止まるが、途中で止まった場合（hidden lockfileが変わらない）は見抜けないことがある（ADR-0008の「見抜けないこと」）。どちらも、実行したら`npm run setup`をやり直す。`package-lock.json`・`package.json`（scriptsだけの変更を含む）・`.npmrc`が変わったとき（branchやタグの切り替えを含む）、Node.jsを入れ替えたとき（パッチ版を含む）も同じ。

### 環境によって飛ばす試験

`npm test`は、試験の中で再現できない環境では、次の試験を理由を出して飛ばす（`node --test`の出力に`# SKIP`と理由が出る）。飛ばした分は、T05の受入条件の手での確認（[タスク台帳](implementation-tasks.md)のT05）で確かめる。飛ばす試験を増やすときは、この表とT05の手での確認を同じPRで直す。想定と違う件数のskipは、成功として扱わない。

| 環境 | 飛ばす試験（件数） | 理由 | 代わりの確認（T05） |
| --- | --- | --- | --- |
| Windows | `scripts/setup-lock.test.ts`の実際のシグナルの3件（setupだけへの`SIGINT`、プロセスグループへの`SIGINT`、`SIGTERM`・`SIGHUP`）、`scripts/setup.test.ts`の実際のnpmでのCtrl+C相当の1件 | Node.jsは、Windowsでほかのプロセスへコンソールの制御イベント（Ctrl+C・Ctrl+Break）を送れない（`kill`は強制終了になる）。`SIGTERM`・`SIGHUP`は、Windowsのsetupが受けるシグナルではない | 実機のコンソールで、`npm ci`の最中にCtrl+C（130）とCtrl+Break（149）を押し、記録も作業中の印も残らず、続けて`npm run setup`が進むこと |
| Windows | `scripts/install-record.test.ts`の、印を消せないときの1件 | 印の削除だけを失敗させるPOSIXの方法（ディレクトリの書込み禁止）が使えず、読取り専用の属性はNode.jsが外して消すので、試験の中で確実に再現できない | 別のPowerShellで印を削除できない共有の指定で開いたまま（`$f = [System.IO.File]::Open("$PWD\.kurashi-ledger-setup.lock", 'Open', 'Read', 'Read')`）、`npm ci`の最中にCtrl+Cを押し、130で終わり、印が残ったことと消し方が表示されること。`$f.Close()`のあと印を消すと、`npm run setup`が進むこと |
| macOS・Linuxのroot | `scripts/install-record.test.ts`の、印を消せないときの1件 | rootは書込み禁止のディレクトリからもファイルを消せるので、失敗を再現できない | CIの試験を一般のユーザーで実行し、skipの件数を記録する（GitHubのhosted runnerは一般のユーザー） |

件数は、macOS・Linuxの一般のユーザーで0件、Windowsで5件、macOS・Linuxのrootで1件になる。件数と一覧の正本はこの表で、台帳のT05とADR一覧からはこの表を参照する（件数を書き写さない）。

飛ばさずに弱めて確かめる箇所が1つある: `scripts/install-record.test.ts`で、`node_modules`の外の通常のファイルを指す実行ファイルのリンクを、Windowsでファイルのsymlinkを作る権限がない（開発者モードでも管理者でもない）ときは、リンクがない場合として確かめ、その旨を試験の出力（diagnostic）に残す。T05のWindowsのCIでは、出力にこの旨が出たかを記録する。

## npmの設定（`.npmrc`）

- `ignore-scripts=true`: 依存のインストールスクリプトを動かさない（ADR-0002）。npmの仕様で、`npm run`で指定したスクリプトは動くが、`prebuild`のようなpre/postスクリプトは動かない。`package.json`のscriptsにpre/postを使わず、必要な確認はスクリプトの中で行う。スクリプトが必要な依存を入れる場合は、理由を確かめてから個別に扱う（ADR-0002）。
- `save-exact=true`: 依存を追加したときに、範囲ではなく正確な版で`package.json`に書く。
- `npm run setup`は、利用者のnpmrc（`~/.npmrc`等）と`npm_config_`で始まる環境変数を使わない（ADR-0008）。プロキシが必要な環境では、`HTTPS_PROXY`・`HTTP_PROXY`・`NO_PROXY`の環境変数で渡す。所有者はこの扱いを受け入れた（下の「所有者の決定」の4）。

## TypeScript

- 型検査だけに使う（`typescript` 7.0.2、Apache-2.0）。サーバー側の`.ts`はNode.jsの型除去でそのまま実行する。
- `tsconfig.json`の主な設定: `noEmit`、`erasableSyntaxOnly`（enum、実行時コードを持つnamespace、parameter properties等を使わない）、`allowImportingTsExtensions`と`module: nodenext`（importには`.ts`の拡張子を書く）、`verbatimModuleSyntax`（型だけのimportには`type`を付ける）、`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。`paths`は使わない（Node.jsは`tsconfig.json`を読まない）。
- Node.jsのAPIの型は`@types/node`（24系、MIT）。Node.jsのメジャーと合わせる。
- 型検査の対象は`scripts/`・`src/`・`tests/`の`.ts`。UIの`.tsx`はT08で加える。

## 依存の追加

`package.json`とlockfileは共有資源で、T02→T05（Playwright）→T26（起動のscripts）→T08（React・Vite）の順に1つずつ変える（[実装計画](implementation-plan.md)）。依存を加えるタスクは、着手時に共有資源として申告する。

1. `npm install --save-dev <名前>@<版>`等で`package.json`とlockfileを更新する（これは記録を書かない）。
2. `npm run setup`で導入し直す。
3. 依存のライセンス・サポート・インストールスクリプトの有無を確かめ、PRに書く。lockfileの`resolved`が`https://registry.npmjs.org/`以外を指していないことも確かめる。

## branchとworktree

[worktree運用](local-worktrees.md)に加えて、次を守る。

- branch名は`task/<タスクID>-<担当名>`（例: `task/T02-claude`）。1タスクにつき実装担当1名・branch 1本。
- 大文字と小文字だけが違うbranch名を作らない。MacとWindowsのファイルシステムでは、同じ名前として衝突する。
- worktreeごとに`npm run setup`を実行する。`node_modules`と記録はworktreeごとに別で、ほかのworktreeのものを使い回さない。
- 試験や開発で使うデータは合成データだけ。実データのデータルート（ADR-0006）を開かない。

## commit・Issue・PR・引継ぎ

- 新しい作業とレビューの指摘の修正の前に、[修正前の整合確認](review-prevention.md)の計画（`.review/plans/<タスクID>.json`）を作るか確かめる（[AGENTS.md](../AGENTS.md)）。
- stageするファイルを明示し（`git add .`を使わない）、`git diff --cached`で差分を読み、`npm run check:public -- --staged`を実行してからcommitする（[公開範囲と公開前の点検](public-data.md)）。Gitのhookは自動では入れない（理由は同じ資料）。
- Issueは`.github/ISSUE_TEMPLATE/task.md`の項目で作る（GitHubの画面では「タスク」の雛形）。Issue番号を推測で書かない。
- PRは`.github/PULL_REQUEST_TEMPLATE.md`に沿って書き、作業中はDraftにする。完了したら[PRレビューのループ](pr-review-loop.md)の形式で、40文字のhead/baseのSHAを再取得して引継ぎコメントを書く。
- レビュー・指摘対応・マージの扱いは、[AGENTS.md](../AGENTS.md)と[GitHub・複数AIの運用](github-agent-operations.md)に従う。

## ライセンス

ライセンスは所有者が選んでいない（未選択）。publicであることは、OSSとして再利用を許諾することではない。所有者が選ぶまで、このプロジェクトをOSSと呼ばず、`package.json`にも`license`欄を書かない。選んだときは、所有者の決定として`README.md`と`docs/project-status.md`に記録し、ライセンスのファイルを加える。

## 元checkoutの未公開の試作の棚卸し

T00の棚卸し（[ADR一覧](adr/README.md)の「既存設定の棚卸し」）で、T02に回した項目。2026-10-03に、元checkoutにある未追跡の試作を読んで評価した。試作のファイルはコピー・公開していない。T02で採用したものも、ADRとこの資料に合わせて書き直した。

| 試作の項目 | 判断 | 理由・引継ぎ |
| --- | --- | --- |
| Node.jsの版の指定（`.nvmrc`、`engines`） | 書き直して採用 | 下限が24.0.0で、`node:sqlite`のRelease candidate（24.15.0）を満たさない。`devEngines`もなかった。上の「Node.jsの版」のとおり作り直した |
| `package.json`と`package-lock.json` | 書き直して採用 | 型検査・試験・公開検査のscriptsの考え方を引き継ぎ、`npm run setup`・記録の確認を加えた。lockfileは新しく作った |
| `tsconfig.json` | 書き直して採用 | 型検査だけ、`erasableSyntaxOnly`等の方針はADR-0002と合っていた |
| 公開検査のスクリプトとその試験 | 書き直して採用 | 秘密情報や個人のパスを探す考え方を引き継いだ。`evidence`等の名前をどの階層でも拒んでソースの置き場所と衝突する点、合成データの置き場所の例外がない点、`*.age`がない点を直した |
| コミット前のGitのhook（公開検査） | 不採用（所有者の決定の3） | hookの設定はworktreeの間で共有され、ほかの担当の作業に影響する。手動で`npm run check:public -- --staged`を実行する手順にした |
| CIのworkflow | 不採用（T05） | CIはT05の範囲。`npm run setup`ではなく`npm ci`を直接使っていて、Node.jsの版も24系の範囲でしか指定していない。T05はADR-0002・ADR-0008に沿って作る |
| 依存の自動更新の設定 | 不採用（所有者の決定の3） | 自動のPRがlockfile（共有資源）を変え、担当の割当の外で作業が生まれる。依存の更新の運用はT25で決める |
| エディタの設定、改行の正規化の設定 | 不採用 | T02の受入条件に不要。改行の扱いで問題が出たら、T05で判断する |
| 金額の状態を表すドメインの型とその試験 | 不採用 | 金額の状態（unknown・not-stated・not-applicable・known）の定義はT01の契約、実装はT06の範囲。T06は確定した契約から書き起こす |
| 制度データ・application層の説明文 | 不採用 | 制度データはT14、層の方針は[architecture.md](architecture.md)にある。置き場所は各タスクで作る |

試作の中に、実データ・秘密情報は見当たらなかった。元checkoutの試作と、その`node_modules`は、所有者の決定（下の2）により当面残す。

## 所有者の決定（2026-10-02）

T02で所有者の判断を求めた事項について、所有者が2026-10-02に、実装側のセッションのチャットで次のとおり決めた（PR #12で記録）。

| # | 事項 | 決定 |
| --- | --- | --- |
| 1 | 固定した版（24.15.0以上）とWindowsでの確認 | ローカルのNode.jsは当面24.14.0のままにする。固定した範囲（`>=24.15.0 <25`）とWindowsでの確認（`npm run setup`・`npm run typecheck`・`npm test`・`npm run build`）は、T05の受入条件に移す（[タスク台帳](implementation-tasks.md)のT05）。T02では、固定した版とWindowsで一度も実行していない |
| 2 | 元checkoutの未追跡の試作と`node_modules` | 当面残す。T02の統合後に扱いを見直す。削除しない |
| 3 | Gitのhookと依存の自動更新（Dependabot） | いまは入れない。依存の更新の運用はT25で決める |
| 4 | `npm run setup`が利用者の`~/.npmrc`を読まないこと | 受け入れる（プロキシや独自のregistryは使っていない）。プロキシが必要になったら、`HTTPS_PROXY`等の環境変数で渡す（上の「npmの設定」） |
