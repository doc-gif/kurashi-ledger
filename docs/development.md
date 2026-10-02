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

## 初めて使うとき

macOSはターミナル、WindowsはPowerShellで行う。Windowsでは実行ポリシーを変えず、`npm`の代わりに`npm.cmd`を使う（ADR-0002）。

1. Gitと、上の版のNode.jsを入れる（公式インストーラ、またはnvm等のバージョン管理ツール）。
2. 作業用のworktree（下の「branchとworktree」）で`npm run setup`を実行する。中で`npm ci`を実行し、成功したときだけ依存の導入の記録を書く。
3. `npm run typecheck`、`npm test`、`npm run check:public`が通ることを確かめる。

新しいcloneでも同じ手順で動く。記録は`node_modules`の中にあるので、worktreeやcloneごとに`npm run setup`を実行する。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run setup` | 依存を導入する。既存の記録を削除し、`npm ci --ignore-scripts`が成功したときだけ記録を書く（ADR-0008） |
| `npm run check:install` | 記録が、いまの`package-lock.json`とNode.jsの版・OS・CPUに一致するかを確かめる |
| `npm run build` | 記録を確かめる。一致しなければ止まって`npm run setup`を案内する。UIのビルドと配信物のmanifestはT08で加える（いまはビルドする対象がない） |
| `npm run typecheck` | `tsc --noEmit`による型検査だけを行う。JavaScriptは出力しない |
| `npm test` | Node.js標準の試験（`node --test`）で、`scripts/`の試験を実行する |
| `npm run check:public` | 公開検査。`-- --staged`でcommitしようとしている変更だけを見る（[公開範囲と公開前の点検](public-data.md)） |

`npm ci`や`npm install`を直接実行しても記録は書かれない。`npm run build`（T09以降は`start:real`と`:real`の保守コマンドも）が止まるので、`npm run setup`をやり直す。branchやタグを切り替えてlockfileが変わったとき、Node.jsを入れ替えたとき（パッチ版を含む）も同じ。

## npmの設定（`.npmrc`）

- `ignore-scripts=true`: 依存のインストールスクリプトを動かさない（ADR-0002）。npmの仕様で、`npm run`で指定したスクリプトは動くが、`prebuild`のようなpre/postスクリプトは動かない。`package.json`のscriptsにpre/postを使わず、必要な確認はスクリプトの中で行う。スクリプトが必要な依存を入れる場合は、理由を確かめてから個別に扱う（ADR-0002）。
- `save-exact=true`: 依存を追加したときに、範囲ではなく正確な版で`package.json`に書く。

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
| コミット前のGitのhook（公開検査） | 不採用 | hookの設定はworktreeの間で共有され、ほかの担当の作業に影響する。手動で`npm run check:public -- --staged`を実行する手順にした |
| CIのworkflow | 不採用（T05） | CIはT05の範囲。`npm run setup`ではなく`npm ci`を直接使っていて、Node.jsの版も24系の範囲でしか指定していない。T05はADR-0002・ADR-0008に沿って作る |
| 依存の自動更新の設定 | 不採用 | 自動のPRがlockfile（共有資源）を変え、担当の割当の外で作業が生まれる。依存の更新の頻度はT25で決める |
| エディタの設定、改行の正規化の設定 | 不採用 | T02の受入条件に不要。改行の扱いで問題が出たら、T05で判断する |
| 金額の状態を表すドメインの型とその試験 | 不採用 | 金額の状態（unknown・not-stated・not-applicable・known）の定義はT01の契約、実装はT06の範囲。T06は確定した契約から書き起こす |
| 制度データ・application層の説明文 | 不採用 | 制度データはT14、層の方針は[architecture.md](architecture.md)にある。置き場所は各タスクで作る |

試作の中に、実データ・秘密情報は見当たらなかった。
