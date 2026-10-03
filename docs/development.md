# 開発環境と作業の規約

T02（[Issue #9](https://github.com/doc-gif/kurashi-ledger/issues/9)）の成果物。CIとブラウザ試験の基盤は、T05（[Issue #17](https://github.com/doc-gif/kurashi-ledger/issues/17)）で、ローカルHTTPサーバーの骨格（`npm start`）は、T26（[Issue #24](https://github.com/doc-gif/kurashi-ledger/issues/24)）で加えた。実行方式と版の方針は[ADR-0002](adr/0002-runtime-and-distribution.md)、依存の導入の記録は[ADR-0008](adr/0008-install-record.md)、公開範囲は[公開範囲と公開前の点検](public-data.md)。

いまあるのは、開発用の設定・スクリプトとその試験、ブラウザ試験の基盤、CI、ローカルHTTPサーバーの骨格とその安全境界の試験（T26。下の「ローカルHTTPサーバー」）。画面（UI）とそのビルド（T08以降）、記録のAPIとDB・データルート（T09以降）はまだない。

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

既知の制約: T02の作業環境のMac（Node.js 24.14.0）では、この版の検査でnpmのスクリプト（`npm run setup`等）が止まる。Node.jsを24.15.0以上に更新するまで続く。所有者は当面更新しないと決め、固定した版での確認はT05のCIで行う（下の「所有者の決定」の1と「CI」）。

## 初めて使うとき

macOSはターミナル、WindowsはPowerShellで行う。Windowsでは実行ポリシーを変えず、`npm`の代わりに`npm.cmd`を使う（ADR-0002）。

1. Gitと、上の版のNode.jsを入れる（公式インストーラ、またはnvm等のバージョン管理ツール）。
2. 作業用のworktree（下の「branchとworktree」）で`npm run setup`を実行する。中で`npm ci`を実行し、成功したときだけ依存の導入の記録を書く。
3. `npm run typecheck`、`npm test`、`npm run check:public`が通ることを確かめる。ブラウザ試験を手元で動かすときは、下の「ブラウザ試験」。

新しいcloneでも同じ手順で動く。記録は`node_modules`の中にあるので、worktreeやcloneごとに`npm run setup`を実行する。`node_modules`をほかの場所へのリンク（symlink・junction）にして共有することはできない（`npm run setup`等が何も変えずに止まる。ADR-0008）。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run setup` | 依存を導入する。既存の記録を削除し、repoの`.npmrc`と決めた引数だけで`npm ci`を実行し（利用者のnpmrcや`npm_config_`の環境変数は使わない）、成功して導入した木がlockfileと合うときだけ記録を書く（ADR-0008） |
| `npm run check:install` | 記録が、いまの`package-lock.json`・`package.json`・`.npmrc`とNode.jsの版・OS・CPUに一致し、導入した依存と実行ファイルの本体・リンクが`node_modules`の中の通常のファイルとしてそろっているかを確かめる（ファイルの中身の改ざんまでは確かめない。ADR-0008） |
| `npm start -- --token-dir <ディレクトリ>` | ローカルHTTPサーバーの骨格を起動する（T26の段階。画面・記録・DBはない。下の「ローカルHTTPサーバー」） |
| `npm run build` | 記録を確かめる。一致しなければ止まって`npm run setup`を案内する。UIのビルドと配信物のmanifestはT08で加える（いまはビルドする対象がない） |
| `npm run typecheck` | `tsc --noEmit`による型検査だけを行う（ルートの`tsconfig.json`と、ブラウザ試験の`e2e/tsconfig.json`の2つ。下の「TypeScript」）。JavaScriptは出力しない |
| `npm test` | Node.js標準の試験（`node --test`）で、`scripts/`・`src/`・`tests/`の`*.test.ts`を実行する（開発用のスクリプトの試験と、`src/`のHTTPの境界の試験） |
| `npm run test:browser:install` | このOSのブラウザ試験に要るブラウザを入れる（下の「ブラウザ試験」） |
| `npm run test:browser` | Playwrightのブラウザ試験（`e2e/`の`*.spec.ts`）を実行する |
| `npm run check:test-skips -- <ファイル>` | CIで使う。保存した`npm test`の出力のskipを、下の「環境によって飛ばす試験」の表とこのOSで照合し、結果を表示する（下の「CI」） |
| `npm run check:public` | 公開検査。`-- --staged`でcommitしようとしている変更だけを見る（[公開範囲と公開前の点検](public-data.md)） |

`npm run setup`は、worktreeの直下に作業中の印`.kurashi-ledger-setup.lock`を作ってから導入し、終わったら消す。同じworktreeで2つ目を起動すると、依存を変えずに止まる。

Ctrl+C（WindowsはCtrl+Breakも）や終了のシグナル（macOSの`SIGTERM`・`SIGHUP`）で止めると、新しい手順を始めず、動いている`npm ci`の終了を待ってから、記録と書きかけのファイルと自分の印を消して終える（終了コードはCtrl+Cで130。数秒かかることがある）。記録が残らないので、`npm run setup`をやり直す。Ctrl+Cを重ねても片付けは飛ばさない。

印が残るのは、setupを強制終了したとき（macOS: `kill -9`やアクティビティモニタの「強制終了」、Windows: タスク マネージャーでの終了やコンソールを閉じたとき、電源断）と、片付けで記録や印を消せなかったとき（そう表示する）だけ。印が残っていると、次のsetupと照合（`check:install`・`build`）が止まり、印に書いたプロセス番号と開始時刻を表示する。次の手順で消す（印は自動では消さない。ADR-0008）。

1. 動いているsetupがないことを確かめる（macOS: `ps -p <番号>`やアクティビティモニタ、Windows: タスク マネージャー）。番号は別のプロセスに再利用されうるので、開始時刻も見る。
2. 印を消す（macOS: `rm .kurashi-ledger-setup.lock`、WindowsのPowerShell: `Remove-Item .kurashi-ledger-setup.lock`）。片付けで記録を消せなかったと表示された場合は、原因（権限等）を直してから、記録`node_modules/.kurashi-ledger-install.json`も消す。
3. `npm run setup`をやり直す。

依存の導入は`npm run setup`だけで行い、`npm ci`や`npm install`を直接実行しない（記録は書かれない）。`npm ci`を直接実行すると、`node_modules`と一緒に記録が消えるので、`npm run build`（T09以降は`start:real`と`:real`の保守コマンドも）が止まる。`npm install`は記録を消さない。導入が最後まで進めば、npmが書き直すhidden lockfileが変わるので照合で止まるが、途中で止まった場合（hidden lockfileが変わらない）は見抜けないことがある（ADR-0008の「見抜けないこと」）。どちらも、実行したら`npm run setup`をやり直す。`package-lock.json`・`package.json`（scriptsだけの変更を含む）・`.npmrc`が変わったとき（branchやタグの切り替えを含む）、Node.jsを入れ替えたとき（パッチ版を含む）も同じ。

### 環境によって飛ばす試験

`npm test`は、試験の中で再現できない環境では、次の試験を理由を出して飛ばす（`node --test`の出力に`# SKIP`と理由が出る）。飛ばす試験を増やす・変えるときは、この表と代わりの確認を同じPRで直す。表にない試験のskipや、表にある試験が飛ばされないことは、成功として扱わない。

CI（下の「CI」）は、OSごとに、`npm test`の出力のskipした試験をファイルに結び付け、ファイルごとに、この表に名前を書いた試験の集合と過不足なく一致するかを照合する（`npm run check:test-skips`。件数が同じでも、別の試験とのすり替えは不一致）。skipごとに理由の文字列があることも確かめ、理由とdiagnosticをrunのSummaryに記録する。理由の文字列の正本は試験のファイルで、照合の期待値には含めない（妥当かどうかは、レビューでこの表の「理由」と読み合わせる）。照合は試験を名前で突き合わせるので、表の試験とskipした試験の名前は、実行の結果の中で一意でなければならない（2回以上現れれば失敗。node:testは同じファイルの中でも同じ名前の試験を許し、出力に場所が出ないため、一意でないと同じ名前の試験の間のすり替えを見分けられない）。照合は別の一覧を持たず、この表の2つ目の列（「`ファイル`のN件（「試験の名前」…）」の形）と、表の下の件数の文を読む（件数と名前の数、表と文の合計が食い違っても失敗）。表の書き方を変えるときは、`scripts/lib/test-skips.ts`とその試験を同じPRで直す。

| 環境 | 飛ばす試験（ファイル・件数・試験の名前） | 理由 | 代わりの確認 |
| --- | --- | --- | --- |
| Windows | `scripts/setup-lock.test.ts`の3件（「実際のSIGINTをsetupだけに送ると、npmへ転送して終了を待ち、記録も印も残さず130で終える」「Ctrl+Cと同じくプロセスグループ全体にSIGINTを送っても、記録も印も残さず130で終える」「SIGTERMとSIGHUPでも、記録も印も残さず128+番号で終える」）、`scripts/setup.test.ts`の1件（「Ctrl+Cと同じくプロセスグループにSIGINTを送ると、npm ciの終了を待ってから、記録も作業中の印も残さずに終える」） | Node.jsは、Windowsでほかのプロセスへコンソールの制御イベント（Ctrl+C・Ctrl+Break）を送れない（`kill`は強制終了になる）。`SIGTERM`・`SIGHUP`は、Windowsのsetupが受けるシグナルではない | Windowsの実機のコンソールでのCtrl+CとCtrl+Breakの確認（[#19](https://github.com/doc-gif/kurashi-ledger/issues/19)） |
| Windows | `scripts/install-record.test.ts`の1件（「印を消せなくても例外にせず、中断は128+番号のまま、成功は記録を残したまま終え、残った印と消し方を案内する」） | 印の削除だけを失敗させるPOSIXの方法（ディレクトリの書込み禁止）が使えず、読取り専用の属性はNode.jsが外して消すので、試験の中で確実に再現できない | Windowsの実機での、印を消せないときのCtrl+Cの確認（[#19](https://github.com/doc-gif/kurashi-ledger/issues/19)） |
| Windows | `src/start.test.ts`の1件（「実際のSIGINT・SIGTERMで、待受を止め、一時ファイルを消して0で終わる」） | Node.jsは、Windowsでほかのプロセスへコンソールの制御イベント（Ctrl+C）を送れない（`kill`は強制終了になる）。`SIGTERM`は、Windowsの`npm start`が受けるシグナルではない | 同じ終了の処理をプロセスの中から呼ぶ試験（`src/start.test.ts`の「終了の処理（Ctrl+C等のシグナルで呼ぶもの）は…」。すべてのOSで実行）と、Windowsの実機での起動・終了の実施記録（T13。ADR-0002の「別タスクで行う検証」） |
| macOS・Linuxのroot | `scripts/install-record.test.ts`の1件（「印を消せなくても例外にせず、中断は128+番号のまま、成功は記録を残したまま終え、残った印と消し方を案内する」） | rootは書込み禁止のディレクトリからもファイルを消せるので、失敗を再現できない | CIの試験を一般のユーザーで実行し、skipを照合する（GitHubのhosted runnerは一般のユーザー。下の「CI」） |

件数は、macOS・Linuxの一般のユーザーで0件、Windowsで6件、macOS・Linuxのrootで1件になる。飛ばしてよい試験の名前と件数の正本はこの表で、台帳のT05とADR一覧からはこの表を参照する（書き写さない）。Windowsの実機での確認の手順・期待する結果・記録の様式の正本は[#19](https://github.com/doc-gif/kurashi-ledger/issues/19)にある。2026-10-03の所有者決定（所有者本人の確認: PR #18のCodexの記録5965890988）でT05の受入条件から分けたもので、どのタスクにも依存せず、T26・T28をブロックしない。CIでは確かめていない。

飛ばさずに弱めて確かめる箇所が1つある: `scripts/install-record.test.ts`で、`node_modules`の外の通常のファイルを指す実行ファイルのリンクを、Windowsでファイルのsymlinkを作る権限がない（開発者モードでも管理者でもない）ときは、リンクがない場合として確かめ、その旨を試験の出力（diagnostic）に残す。CIは、試験の出力のdiagnosticをrunのSummaryに記録するので、WindowsのCIでこの旨が出たかをそこで確かめる。T26のHTTPの境界の試験（`src/infrastructure/http/launch-file.test.ts`・`static-files.test.ts`）も同じ扱いで、Windowsでファイルのsymlinkを作れないときは、一時ファイルの名前に置くリンクをjunctionで確かめ、配信ルートの外を指すリンクをjunction（ディレクトリ）だけで確かめて、その旨をdiagnosticに残す（GitHubのWindowsのrunnerはsymlinkを作れるので、CIでは弱めない）。

## npmの設定（`.npmrc`）

- `ignore-scripts=true`: 依存のインストールスクリプトを動かさない（ADR-0002）。npmの仕様で、`npm run`で指定したスクリプトは動くが、`prebuild`のようなpre/postスクリプトは動かない。`package.json`のscriptsにpre/postを使わず、必要な確認はスクリプトの中で行う。スクリプトが必要な依存を入れる場合は、理由を確かめてから個別に扱う（ADR-0002）。
- `save-exact=true`: 依存を追加したときに、範囲ではなく正確な版で`package.json`に書く。
- `npm run setup`は、利用者のnpmrc（`~/.npmrc`等）と`npm_config_`で始まる環境変数を使わない（ADR-0008）。プロキシが必要な環境では、`HTTPS_PROXY`・`HTTP_PROXY`・`NO_PROXY`の環境変数で渡す。所有者はこの扱いを受け入れた（下の「所有者の決定」の4）。

## TypeScript

- 型検査だけに使う（`typescript` 7.0.2、Apache-2.0）。サーバー側の`.ts`はNode.jsの型除去でそのまま実行する。
- `tsconfig.json`の主な設定: `noEmit`、`erasableSyntaxOnly`（enum、実行時コードを持つnamespace、parameter properties等を使わない）、`allowImportingTsExtensions`と`module: nodenext`（importには`.ts`の拡張子を書く）、`verbatimModuleSyntax`（型だけのimportには`type`を付ける）、`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。`paths`は使わない（Node.jsは`tsconfig.json`を読まない）。
- Node.jsのAPIの型は`@types/node`（24系、MIT）。Node.jsのメジャーと合わせる。
- 型検査の対象は`scripts/`・`src/`・`tests/`の`.ts`。ブラウザ試験（`e2e/`と`playwright.config.ts`）は、Playwrightの型がDOMの型を要るので、`e2e/tsconfig.json`（ルートの設定を継ぎ、`lib`に`dom`を加える）で別に検査する。サーバー側の型検査にDOMの型を入れないため。`npm run typecheck`は両方を行う。UIの`.tsx`はT08で加える。

## 依存の追加

`package.json`とlockfileは共有資源で、T02→T05（Playwright）→T26（起動のscripts）→T08（React・Vite）の順に1つずつ変える（[実装計画](implementation-plan.md)）。依存を加えるタスクは、着手時に共有資源として申告する。

1. `npm install --save-dev <名前>@<版>`等で`package.json`とlockfileを更新する（これは記録を書かない）。
2. `npm run setup`で導入し直す。
3. 依存のライセンス・サポート・インストールスクリプトの有無を確かめ、PRに書く。lockfileの`resolved`が`https://registry.npmjs.org/`以外を指していないことも確かめる。

T05で`@playwright/test` 1.63.0を加えた（下の「ブラウザ試験」）。T26は`package.json`のscriptsに`start`を加えただけで、依存とlockfileは変えていない。次に`package.json`とlockfileを変えるのはT08。

## ブラウザ試験（Playwright）

T05で、ブラウザ試験の基盤としてPlaywrightを入れた（ADR-0004）。`@playwright/test` 1.63.0（Apache-2.0）と、その依存の`playwright`・`playwright-core`（同じ版、Apache-2.0）。どれもインストールスクリプトはなく、`resolved`は`https://registry.npmjs.org/`。

- 試験は`e2e/`の`*.spec.ts`に置く。`node --test`の試験（`*.test.ts`）とは別で、`npm test`では実行しない。
- ブラウザは`e2e/browsers.ts`の1か所で決める。ChromiumをmacOS・Windows・Linux、WebKitをmacOSで実行する（PlaywrightのWindows・LinuxのWebKitはSafariの代わりにならない）。Firefoxは必須の対象に含めない（ADR-0004）。
- 手元で動かすとき: `npm run setup`のあと、`npm run test:browser:install`でこのOSに要るブラウザを入れてから、`npm run test:browser`を実行する。ブラウザはPlaywrightの配布元から取得し、Playwrightの既定の場所（利用者のキャッシュ。macOSは`~/Library/Caches/ms-playwright`、Windowsは`%LOCALAPPDATA%\ms-playwright`、Linuxは`~/.cache/ms-playwright`）に入る。`node_modules`の外なので、依存の導入の記録には影響しない。Linuxで足りないOSのライブラリも入れるときは`npm run test:browser:install -- --with-deps`（管理者の権限を使う）。
- 照合（`e2e/strict-reporter.ts`、分類は`scripts/lib/browser-outcomes.ts`）: 成功として数えるのは、成功を期待して（`expectedStatus`がpassed）実際に合格した試験だけ。Playwrightは`test.fail()`で期待どおり失敗した試験も「期待どおり」（`outcome()`がexpected）として全体をpassedにするが、照合ではこれを成功にしない。期待した失敗、skip、再試行で通った試験（flaky）、中断、時間切れ、未実行、失敗のどれかがある、このOSで必要なブラウザのどれかで成功した試験が0件、またはPlaywright全体の結果がpassedでなければ、全体を失敗にする。この境界は`scripts/browser-outcomes.test.ts`が、分類の単体試験と、実際のPlaywrightで`e2e/reporter-fixtures/`の合成の試験（ブラウザを使わない。`npm test`で全OSで実行）を流して確かめる。いまブラウザ試験で飛ばしてよい試験も、失敗を期待してよい試験もない。加えるときは、照合とこの資料を同じPRで直す。`retries`は0で、CIでは`test.only`を拒む（`forbidOnly`）。試験を集めるだけ（`--list`）のときは、CIの外でだけ照合しない。
- 設定（`playwright.config.ts`）では、ブラウザの安全上の既定の動き（CSP、HTTPSの検査、要求のヘッダ、権限、プロキシ）を変える設定（`bypassCSP`、`ignoreHTTPSErrors`、`extraHTTPHeaders`等）を使わない。T26のcookieの交換・Origin・`Sec-Fetch-Site`・CSPの試験を、実際のブラウザの動きのまま確かめるため。trace・screenshot・videoは作らない。出力先の`test-results/`は`.gitignore`の対象。
- いまの試験（`e2e/browser-base.spec.ts`）は、基盤が各ブラウザで動くことの確認だけ（日本語のページの表示と、試験の中で127.0.0.1に立てた一時のサーバーとのcookieの往復。合成の固定の文字列だけ）。アプリのサーバーと境界の試験は`e2e/http-boundary.spec.ts`（T26。下の「ローカルHTTPサーバー」）、UIのE2EはT08以降が加える。実機のSafariでの確認は、ADR-0004のとおりリリースの前に手で行う。

## ローカルHTTPサーバー（T26）

[ADR-0003](adr/0003-local-http-boundary.md)の境界（ADR-0007のG7）を、Node.js標準の`node:http`だけで`src/infrastructure/http/`に実装した。実装の詳細（起動の識別子のヘッダ、トークンの交換、一時ファイル、本人だけの権限の基準、拒否の応答）は[ADR-0009](adr/0009-local-http-implementation.md)。

いまの`npm start`は、境界の骨格を動かすだけで、画面（UI）・記録のAPI・DBはなく、データルートも開かない。

1. トークンの一時ファイルを置く、本人だけが使えるディレクトリを、repoの外に用意する。macOS・Linuxは`mkdir -m 700 <ディレクトリ>`。WindowsのPowerShellは、ディレクトリを作ってから`icacls <ディレクトリ> /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"`（継承を切り、本人だけに許可する）。アプリはこのディレクトリを作らず、権限も変えない。リンク・権限の広いディレクトリ・repoの中は拒否する。
2. `npm start -- --token-dir <ディレクトリ>`（WindowsのPowerShellは`npm.cmd start -- --token-dir <ディレクトリ>`）。既定のポートは48720で、`--port <番号>`で変えられる。使用中なら別のポートへ移らずに終了する。`--no-open`でブラウザを自動で開かない。
3. 起動用の一時ファイル（本人だけが読めるHTML）がブラウザで開き、トークンをcookieに交換して`/`へ移る。いまの`/`は、画面がまだないことを示す案内ページ。自動で開かないときは、表示された起動用のファイルのURLを開く（端末のときは、1回だけ使えるURLも表示する。端末でないときは、ログに残さないためにトークンを表示しない）。
4. 終了するには、ターミナルでCtrl+Cを押す。待受を止め、一時ファイルを消す。

T09で、`npm start`にデータルートの検査（ADR-0007のG1〜G5）を組み込み、`--token-dir`の代わりに検査に通ったデータルートの`tmp/`を使う。T08で、ビルドしたUIの配信と、開発時のViteの組込み（ADR-0009の6の口）を加える。

試験: `src/infrastructure/http/`と`src/start.ts`の`*.test.ts`（`npm test`）と、`e2e/http-boundary.spec.ts`（`npm run test:browser`）。ADR-0003の「別タスクで行う検証」のうちT26の項目（開発時の構成と二重起動を除く）を確かめる。Windowsで実際のCtrl+Cを送れない試験は、上の「環境によって飛ばす試験」に登録した。

## CI

T05で`.github/workflows/ci.yml`を加えた。PR（baseのbranchを問わない）と、mainへのpushで動く。

| ジョブ | OS | 内容 |
| --- | --- | --- |
| `checks` | Linux・Windows・macOS | `package.json`の`devEngines.runtime`の範囲で最新のNode.jsを入れ（`actions/setup-node`の`node-version-file`。npm自身もdevEnginesで版を検査する）、`npm run setup`→`check:install`→`typecheck`→`npm test`→skipの照合（`check:test-skips`）→`build`と、`check:public`を実行する |
| `browser` | Linux・Windows・macOS | `npm run setup`→`test:browser:install`→`test:browser`（ChromiumをすべてのOS、WebKitをmacOS） |
| `review tools` | Linux・Windows・macOS | Python 3.11（検査器が対応する最も古い版）で、`guard.py validate`と、レビュー運用ツールの試験（`tools/review_guard/tests`、`.review/tests`）。unittestは0件・skip・期待した失敗でも0で終わるので、要約の行にそれらがあれば失敗にする |
| `review plan` | Linux（PRのときだけ） | PRの計画の検査。baseのcheckoutにある検査器（`changed_paths.py`・`ci.py`）だけを実行し、PRのコードを実行しない（[CLI手順](../tools/review_guard/README.md)のテンプレートを配置したもの）。計画のないPRや、baseを取り込んでいないPRでは失敗する。Quality gateに含めることは、2026-10-03の所有者決定で承認された（所有者本人の確認: PR #18のCodexの記録5965890988） |
| `Quality gate` | Linux | 上のすべてのジョブの結果をまとめる。どれかが失敗・中断・skip（欠けた）なら失敗にする（pushのときは、`review plan`がskipであることを求める）。PRでは、試験したmerge commitの親が、PRのbaseとheadのSHAであることを確かめる |

- 結果の読み方: 各runのSummaryに、`npm test`の件数とskipした試験・理由・diagnostic・表との照合（OSごと、Node.jsの版つき）、ブラウザごとの結果、Quality gateの判定と、試験したcommit・PRのhead・baseのSHAが出る。レビューでは、最新のheadとbaseに対応するrunかを、このSHAで確かめる。runのあとでbaseが進んだ場合、その結果は古いbaseに対するものなので、baseを取り込んでやり直す。
- 失敗・中断・skipの扱い: `npm test`の失敗・中断・todo・0件、失敗を期待した試験（`expectFailure`。要約ではpassに数えられる）、再実行で合格した試験と、表と違うskip（表にない試験のskip、表にある試験が飛ばされないこと、理由のないskip）は、`check:test-skips`が失敗にする。ブラウザ試験は上の照合。ジョブの失敗・中断・skipはQuality gateが失敗にする。一部のジョブの成功だけで、検証が済んだとは扱わない。
- 安全: 標準のhosted runner（`ubuntu-latest`・`windows-latest`・`macos-latest`）だけを使う。権限は`contents: read`だけで、secretsを使わず、checkoutの資格情報を残さない（`persist-credentials: false`）。actionはcommitのSHAで固定する。artifactをuploadしない。`pull_request_target`を使わないので、forkからのPRにも、secretsも書込みの権限も渡らない。
- 時間の上限: `checks`・`browser`は20分、`review tools`は10分、`review plan`・`Quality gate`は5分。同じPRの新しいpushで、古いrunは取り消す（mainへのpushは取り消さない）。
- 限界: `pull_request`のworkflowはPR自身が変えられるので、CIの合格は迂回を防がない（[修正前の整合確認](review-prevention.md)）。workflow・`scripts/`・`e2e/`・検査器・条件を変えるPRは、別の担当が内容をレビューする。CIの合格は、独立した内容レビュー・所有者の判断・マージの条件（[AGENTS.md](../AGENTS.md)）の代わりにならない。repoの設定は、必須のstatus checkを`Quality gate`だけにすることと、「Require branches to be up to date before merging」を有効にすることは、2026-10-03の所有者決定（所有者本人の確認: PR #18のCodexの記録5965890988）で、T05のマージのあとに実装側（mainのセッション）が設定する（T05のPRでは変えていない）。workflow・検査器・条件・原因台帳の変更に独立レビューを必須にする保護と、その迂回試験は、T23で扱う。必須のcheckにしても、workflowをPRで変えられる限界は変わらない。
- CIで確かめないもの: Intel Mac・Windows（arm64）、公式のインストーラ（macOSの`.pkg`、Windowsの`.msi`）で入れたNode.js（CIは`actions/setup-node`の配布物を使う。ADR-0008の「見抜けないこと」のnpmの組込みの設定は、インストーラでは未確認のまま）、実機のSafari、Windowsのコンソールの制御イベント（[#19](https://github.com/doc-gif/kurashi-ledger/issues/19)）。
- 後続タスクの試験: `scripts/`・`src/`・`tests/`に`*.test.ts`を加えれば`npm test`で、`e2e/`に`*.spec.ts`を加えれば`npm run test:browser`で、3つのOSのCIで実行される。

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
