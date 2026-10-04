# 開発環境と作業の規約

T02（[Issue #9](https://github.com/doc-gif/kurashi-ledger/issues/9)）の成果物。CIとブラウザ試験の基盤は、T05（[Issue #17](https://github.com/doc-gif/kurashi-ledger/issues/17)）で加えた。実行方式と版の方針は[ADR-0002](adr/0002-runtime-and-distribution.md)、依存の導入の記録は[ADR-0008](adr/0008-install-record.md)、公開範囲は[公開範囲と公開前の点検](public-data.md)。

いまあるのは開発用の設定・スクリプトとその試験、ブラウザ試験の基盤、CIだけで、アプリの起動（T26）、UIのビルド（T08）はまだない。

## Node.jsの版

| 項目 | 値 |
| --- | --- |
| 固定するメジャー | Node.js 24（LTS、Krypton） |
| 下限 | 24.15.0（`package.json`の`devEngines.runtime`と`engines`は`>=24.15.0 <25`） |
| `.nvmrc` | `24`（nvmは範囲を書けないので、メジャーだけを書く。下限より古い24.xを選ぶとnpmが止まる） |
| `mise.toml`（手元の正確な版） | Node.js `24.21.0`、Python `3.11.17`（下の「miseで版をそろえる」） |

選んだ理由（確認日: 2026-10-03）:

- ADR-0002は、T02の着手時に利用可能なLTSのうち、型除去がStable（24.12.0以上）で`node:sqlite`がRelease candidate（24.15.0以上）である版を固定すると決めた。
- Node 26はまだCurrentで、LTS入りは2026-10-28の予定。Node 24はActive LTSで、2026-10-20に保守期間（Maintenance LTS）へ移り、2028-04-30に終了する。24系の最新は24.21.0（2026-09-07）。
- そのため、Node 24の24.15.0以上に固定する。Node 26への更新は、LTS入りのあとにT28（Node.jsのメジャー更新）で行う。

出典: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json 、https://nodejs.org/dist/index.json 、https://nodejs.org/docs/latest-v24.x/api/typescript.html 、https://nodejs.org/docs/latest-v24.x/api/sqlite.html

版が合わないと、npmは`npm ci`・`npm run`の前に`EBADDEVENGINES`で止まる。`--force`で検査を外さない（`npm run setup`は`--force`を拒む）。

既知の制約: T02の作業環境のMac（Node.js 24.14.0）では、この版の検査でnpmのスクリプト（`npm run setup`等）が止まる。Node.jsを24.15.0以上に更新するまで続く。所有者は当面更新しないと決め、固定した版での確認はT05のCIで行う（下の「所有者の決定」の1と「CI」）。2026-10-03に所有者は、Node.jsとPythonの版をmiseで管理すると決めた（[#30](https://github.com/doc-gif/kurashi-ledger/issues/30)）。miseを入れて下の「miseで版をそろえる」を行えば、この制約はなくなる。

### 版の正本の役割

| 何を決めるか | 正本 | 検査 |
| --- | --- | --- |
| Node.jsの対応する範囲 | `package.json`の`devEngines.runtime`・`engines`（`>=24.15.0 <25`） | npmが`npm ci`・`npm run`の前に検査する（`EBADDEVENGINES`） |
| Pythonの対応する範囲 | 検査器（`tools/review_guard`）の起動時の検査（3.11以上） | 3.11未満なら起動しない |
| 手元で使う正確な版 | `mise.toml`（`[tools]`の`node`・`python`） | miseが入れて切り替える。範囲の外の版は書かない |
| CIで使う版 | `.github/workflows/ci.yml`。Node.jsは`package.json`の範囲の最新（`node-version-file: package.json`と`check-latest`）、Pythonは`'3.11'`（対応する最も古いマイナー） | runのSummaryとログに版が出る |

mise.tomlの版の理由（確認日: 2026-10-03）:

- Node.js `24.21.0`: いまのCIが`package.json`の範囲から入れる版（mainのrun [37111323603](https://github.com/doc-gif/kurashi-ledger/actions/runs/37111323603)で、Linux・Windows・macOSとも`v24.21.0`）。24系の最新（2026-09-07、Active LTS）で、下限の24.15.0以上。手元とCIを同じパッチ版にして、依存の導入の記録（Node.jsの版は完全一致で比べる。ADR-0008）とCIの結果を読み合わせやすくする。
- Python `3.11.17`: CIの`'3.11'`と同じマイナー（検査器が対応する最も古い版）で、3.11系の最新のセキュリティ修正版。miseは既定でビルド済みの配布物（python-build-standalone）を入れ、2026-10-01の配布物にmacOS（arm64）用の3.11.17がある。CIのパッチ版はrunnerのキャッシュで決まり、OSごとに違う（上のrunで、Linuxは3.11.16、macOS・Windowsは3.11.9）。検査器は標準ライブラリだけを使うので、パッチ版の違いは問題にしない。

CIは変えない。固定したSHAの`actions/setup-node`・`actions/setup-python`は`mise.toml`の形式を解釈しない（どちらも配布物のソースで確かめた。setup-nodeが解釈するのは`package.json`と1行に版を書くファイル（`.nvmrc`・`.tool-versions`等）、setup-pythonは`.tool-versions`・`pyproject.toml`・`Pipfile`と1行に版を書くファイル）。CIでmise.tomlを読むには、新しいaction（`jdx/mise-action`等）か版を取り出すstepが要り、workflowの変更が増える割に、上の範囲の検査は変わらないため。CIのNode.jsは範囲の最新を入れ続けるので、新しい24.xが出ると手元とCIのパッチ版がずれる。そのときは、CIのrunのSummaryの版を見て、`mise.toml`の`node`を同じ版へ上げるPRを出す（`package.json`の範囲は変えない）。メジャー更新はT28で、`mise.toml`もその範囲に含む。

`.nvmrc`は`24`のままにする。ADR-0002のとおりnvm利用者向けの補助で、正確な版を2か所に書くと更新漏れが増えるため。`nvm install 24`は24系の最新を入れるので下限を満たす。miseは既定で`.nvmrc`を読まず（mise.tomlを使う）、両方があっても衝突しない。

## miseで版をそろえる

[mise](https://mise.jdx.dev)は、ディレクトリごとに決めた版のツールを入れて切り替える。repoのルートの`mise.toml`に書いた版のNode.jsとPythonを使う。miseは任意で、公式のインストーラやnvm等で同じ範囲の版を入れてもよい（ADR-0002）。

### macOS

1. miseを入れる: `brew install mise`
2. シェルで有効にする（zshの例）: `echo 'eval "$(mise activate zsh)"' >> ~/.zshrc`を1回だけ実行し、新しいターミナルを開く（または`source ~/.zshrc`）。nvmも使っている場合は、この行がnvmの読込みより後になるようにする（`>>`で末尾に足せばそうなる）。
3. worktreeのルートで`mise install`を実行する。Node.js（公式の配布物）とPythonが、miseの置き場所（`~/.local/share/mise/installs`）に入る。repoの中には何も書かない。
4. 確かめる: そのworktreeの中で`node -v`が`v24.21.0`、`python --version`が`Python 3.11.17`になる（`python3`も同じ）。どこから動いているかは`mise ls --current`や`which node`で確かめる。
5. `npm run setup`を実行する（Node.jsを入れ替えたので、依存を導入し直す。ADR-0008）。

`mise.toml`の版が変わったとき（branchの切り替えやmainの取り込みを含む）は、`mise install`のあと`npm run setup`をやり直す。

`mise.toml`は`[tools]`の版の文字列だけを書いているので、miseの通常のモードでは`mise trust`は要らない。miseのparanoidモードを使っている場合は、ファイルを読んでから`mise trust`を実行する。env・tasks等を`mise.toml`に足すと、trustが要るようになるので足さない。個人の上書き（`mise.local.toml`等）や、シェルの設定はcommitしない。

### Windows

Windowsでは、ADR-0002のとおり公式のインストーラを勧める。Node.jsは`mise.toml`と同じ版の`.msi`を入れ、Pythonはpython.orgのインストーラで3.11以上を入れ、入れたマイナーを指定したランチャー（`py -3.11`、3.13を入れたなら`py -3.13`）で動かす。先にそのコマンドの`--version`で3.11以上であることを確かめてから、[CLI手順](../tools/review_guard/README.md)の`python3`をそのコマンドに読み替える。公式のインストーラで入れたNode.jsはCIでは確かめていない（下の「CI」）。

miseもWindowsに対応している（`winget install jdx.mise`）。ただし、PowerShellの`mise activate pwsh`はプロファイル（スクリプト）から読み込む必要があり、このrepoでは実行ポリシーを変えないので使わない。代わりにshimのディレクトリ（`%LOCALAPPDATA%\mise\shims`）を利用者のPATHに加える方法があるが、shimは`node.exe`・`npm.exe`等の実行ファイルで、この資料の`npm.cmd`の指示とどう組み合わさるかを含め、このrepoでは確かめていない（CIでも確かめていない）。使う場合は、`mise install`のあと`node -v`・`npm.cmd -v`（使えなければ`npm -v`）・`python --version`で版を確かめる。

### worktreeとの関係

miseは、いまのディレクトリから親へたどって`mise.toml`を探す。`mise.toml`はcommitしてあるので、最新の`origin/main`から作ったworktreeはどれも同じ版を使い、worktreeごとの設定は要らない。入れたNode.jsとPythonはmiseの置き場所に1つずつ入り、worktreeの間で共有される（`node_modules`と依存の導入の記録は、従来どおりworktreeごとに`npm run setup`で作る）。branchごとに`mise.toml`の版が違えば、そのworktreeではその版を使う（入っていなければ、そのworktreeで`mise install`を実行する）。

## 初めて使うとき

macOSはターミナル、WindowsはPowerShellで行う。Windowsでは実行ポリシーを変えず、`npm`の代わりに`npm.cmd`を使う（ADR-0002）。

1. Gitと、上の版のNode.jsを入れる（mise（上の「miseで版をそろえる」）、公式インストーラ、またはnvm等のバージョン管理ツール）。レビュー運用ツールを動かすときは、Python 3.11以上も入れる（miseなら一緒に入る）。
2. 作業用のworktree（下の「branchとworktree」）で`npm run setup`を実行する。中で`npm ci`を実行し、成功したときだけ依存の導入の記録を書く。
3. `npm run typecheck`、`npm test`、`npm run check:public`が通ることを確かめる。ブラウザ試験を手元で動かすときは、下の「ブラウザ試験」。

新しいcloneでも同じ手順で動く。記録は`node_modules`の中にあるので、worktreeやcloneごとに`npm run setup`を実行する。`node_modules`をほかの場所へのリンク（symlink・junction）にして共有することはできない（`npm run setup`等が何も変えずに止まる。ADR-0008）。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run setup` | 依存を導入する。既存の記録を削除し、repoの`.npmrc`と決めた引数だけで`npm ci`を実行し（利用者のnpmrcや`npm_config_`の環境変数は使わない）、成功して導入した木がlockfileと合うときだけ記録を書く（ADR-0008） |
| `npm run check:install` | 記録が、いまの`package-lock.json`・`package.json`・`.npmrc`とNode.jsの版・OS・CPUに一致し、導入した依存と実行ファイルの本体・リンクが`node_modules`の中の通常のファイルとしてそろっているかを確かめる（ファイルの中身の改ざんまでは確かめない。ADR-0008） |
| `npm run build` | 記録を確かめる。一致しなければ止まって`npm run setup`を案内する。UIのビルドと配信物のmanifestはT08で加える（いまはビルドする対象がない） |
| `npm run typecheck` | `tsc --noEmit`による型検査だけを行う（ルートの`tsconfig.json`と、ブラウザ試験の`e2e/tsconfig.json`の2つ。下の「TypeScript」）。JavaScriptは出力しない |
| `npm test` | Node.js標準の試験（`node --test`）で、`scripts/`・`src/`・`tests/`の`*.test.ts`を実行する |
| `npm run test:browser:install` | このOSのブラウザ試験に要るブラウザを入れる（下の「ブラウザ試験」） |
| `npm run test:browser` | Playwrightのブラウザ試験（`e2e/`の`*.spec.ts`）を実行する |
| `npm run check:test-skips -- <ファイル>` | CIで使う。保存した`npm test`の出力のskipを、下の「環境によって飛ばす試験」の表とこのOSで照合し、結果を表示する（下の「CI」） |
| `npm run check:public` | 公開検査。`-- --staged`でcommitしようとしている変更だけを見る（[公開範囲と公開前の点検](public-data.md)） |

`npm run setup`は、worktreeの直下に作業中の印`.kurashi-ledger-setup.lock`を作ってから導入し、終わったら消す。同じworktreeで2つ目を起動すると、依存を変えずに止まる。

Ctrl+C（WindowsはCtrl+Breakも）や終了のシグナル（macOSの`SIGTERM`・`SIGHUP`）で止めると、新しい手順を始めず、動いている`npm ci`の終了を待ってから、記録と書きかけのファイルと自分の印を消して終える（終了コードはCtrl+Cで130。数秒かかることがある。Windowsの`npm run setup`では、npmが先に1で戻り、そのあとも片付けが続くことがある。下の「Windowsのコンソールの中断の試験」）。記録が残らないので、`npm run setup`をやり直す。Ctrl+Cを重ねても片付けは飛ばさない。

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
| Windows | `scripts/github-app-token.test.ts`の2件（「実際のファイルで: 鍵ファイルへのsymlinkとFIFOを、開く前に拒む（FIFOで止まらない）」「実際のプロセスとシグナルで: 子の実行中のSIGINT・SIGTERMを子へ転送し、子の終了後に失効させて128+番号で終える」） | WindowsのファイルシステムにはFIFOがなく、ファイルのsymlinkの作成には開発者モードか管理者の権限が要るので、試験の中で確実に作れない。Node.jsは、Windowsでほかのプロセスへシグナルを送れない（`kill`は強制終了になる） | 鍵ファイルは、同じ判定（lstatで通常のファイルでないものを開く前に拒む、開いた後の置き換えを拒む）を、純粋な関数の試験（「鍵ファイルは、symlink・置き換え・…」）と、実際のディレクトリの試験で、すべてのOSで確かめる。Windowsでは`--key-file`より`--key-stdin`を勧める（[AIのGitHub App](github-apps.md)）。シグナルは、同じ転送・失効・終了コードを、シグナルを注入した試験（「発行から失効までにシグナルを受けたら…」「確認の途中でシグナルを受けたら…」）で、すべてのOSで確かめる。Windowsの実機でのCtrl+C・Ctrl+Breakの確認はまだ行っていない（[AIのGitHub App](github-apps.md)の「確かめていないこと」） |
| macOS・Linuxのroot | `scripts/install-record.test.ts`の1件（「印を消せなくても例外にせず、中断は128+番号のまま、成功は記録を残したまま終え、残った印と消し方を案内する」）、`scripts/setup-lock.test.ts`の1件（「実際のCtrl+Cで中断したときに印を消せなければ、130で終え、印が残ったことと消し方を表示し、印を消すと次のsetupが進む」）、`scripts/setup.test.ts`の1件（「印を消せないときにCtrl+Cでnpm run setupを止めると、印が残ったことと消し方を表示し、記録を残さず、印を消すと次のsetupと照合が通る」） | rootは書込み禁止のディレクトリからもファイルを消せるので、失敗を再現できない | CIの試験を一般のユーザーで実行し、skipを照合する（GitHubのhosted runnerは一般のユーザー。下の「CI」） |

件数は、macOS・Linuxの一般のユーザーで0件、Windowsで2件、macOS・Linuxのrootで3件になる。飛ばしてよい試験の名前と件数の正本はこの表で、台帳のT05とADR一覧からはこの表を参照する（書き写さない）。

Windowsでは、以前は飛ばしていた中断の5件の試験を、実際のコンソールの制御イベントで実行する（下の「Windowsのコンソールの中断の試験」）。

飛ばさずに弱めて確かめる箇所が1つある: `scripts/install-record.test.ts`で、`node_modules`の外の通常のファイルを指す実行ファイルのリンクを、Windowsでファイルのsymlinkを作る権限がない（開発者モードでも管理者でもない）ときは、リンクがない場合として確かめ、その旨を試験の出力（diagnostic）に残す。CIは、試験の出力のdiagnosticをrunのSummaryに記録するので、WindowsのCIでこの旨が出たかをそこで確かめる（管理者のrunnerの`checks (windows)`と、一般のユーザーの`checks (windows, standard user)`。下の「CI」）。2026-10-03の時点では、GitHubのWindowsのrunnerで、管理者でも一時の一般のユーザーでもファイルのsymlinkを作れた（この旨は出なかった）ので、弱めた経路はCIでは通っていない。一般のユーザーのジョブは、symlinkを作れたかをSummaryに出す。

### Windowsのコンソールの中断の試験

[#19](https://github.com/doc-gif/kurashi-ledger/issues/19)の3つの確認（`npm ci`の最中のCtrl+Cで130、Ctrl+Breakで149、印を消せないときのCtrl+C）は、手での確認をやめ、`npm test`の試験としてWindowsでも実行する（2026-10-03に所有者が実装側のチャットで「Windows環境で自動で確かめる試験を作る」と指示した）。

- 制御イベントの送り方（`tests/support/windows-console.ts`）: Node.jsは、Windowsでほかのプロセスへコンソールの制御イベントを送れない（`kill`は強制終了になる）。そこで、Windowsに同梱のWindows PowerShell 5.1から、.NETのP/InvokeでWin32のAPIを呼ぶ（依存を加えない。スクリプトは`-EncodedCommand`、設定は環境変数で渡すので、実行ポリシーは関係しない）。対象を新しい見えないコンソールで起動してジョブ オブジェクトに入れ、送るときは対象のコンソールに付いて、`GenerateConsoleCtrlEvent`でそのコンソールの全員に送る。端末でCtrl+C・Ctrl+Breakを押したときと同じく、setupも子のnpmも受け取る。試験を動かすプロセスやCIのシェルとはコンソールが別なので、そちらには届かない。対象の子・孫まで全部が終わるのを待ってから確かめる。
- 印を消せない状態（`tests/support/prevent-deletion.ts`）: Windowsでは、別のプロセスが削除の共有を許さずに印を開いたままにする（#19の手での手順と同じ方法。管理者かどうかに左右されない）。POSIXはこれまでどおり、worktreeの直下を書込み禁止にする。
- 対応する試験: `scripts/setup-lock.test.ts`（合成のnpmで、setupを直接起動する。setup自身の終了コード130・149と、印も記録も残らず次のsetupが進むこと、npmがCtrl+Cを無視して自分では止まらないときに、setupが猶予のあとでnpmを終わらせること、印を消せないときに130で終え、印が残ったことと消し方を表示し、印を消すと次のsetupが進むこと）、`scripts/setup.test.ts`（実際のnpmで`npm run setup`を、Ctrl+C、Ctrl+Break（POSIXはSIGTERM）、印を消せないときのCtrl+Cで止める。コンソールのすべてのプロセスが終わってから、setupの表示、記録・印の有無、照合、次のsetup（印を消せないときは印を消したあと）とその後の照合を確かめる。[PR #33](https://github.com/doc-gif/kurashi-ledger/pull/33)のPR33-R001）、`scripts/install-record.test.ts`（印を消せないときの片付け）。
- `npm run setup`の終了コード（Windows）: Windowsのnpmは、Ctrl+Cを受けると、スクリプトを動かすシェル（`cmd.exe`）を強制終了して、自分も1で終わる（npmの`@npmcli/run-script`の動き）。CIでは、`npm run setup`が1で戻った時点で、setupと子のnpmはまだ動いていて（ジョブの中に3つのプロセス）、そのあとsetupが片付けを終え（「SIGINT を受けたので中断した」と表示）、印も記録も残らなかった。印を消せないときのCtrl+Cも同じく1で、3つのプロセスが残っていた。Ctrl+Breakでは、npmはCtrl+Breakを扱わないので、OSの既定の処理で3221225786（0xC000013A）で終わり、その時点で1つのプロセスが残っていた。どの場合も、全部が終わったあとは、setupの表示どおり記録は残らなかった。つまり、Windowsで`npm run setup`をCtrl+Cで止めると、終了コードはsetupの130ではなくnpmの1で、プロンプトが戻ったあとも片付けが続くことがある（その間に次の`npm run setup`を始めると、印があるので「別の `npm run setup` が動いているか…」と表示して止まる。少し待ってからやり直す）。2026-10-03の所有者決定で、これをnpmの仕様として受け入れた（[PR #33の記録](https://github.com/doc-gif/kurashi-ledger/pull/33#issuecomment-5970070883)）。`npm run setup`経由の終了コードは0以外であればよく、保証するのは、setup自身の終了コード（Ctrl+Cで130、Ctrl+Breakで149）と、すべてのプロセスが終わったあとに記録と印が残らないこと（印を消せないときは、印が残ったことと消し方を表示すること）。setupの動きは変えない。`scripts/setup.test.ts`は、コンソールのすべてのプロセスが終わるのを待ってから確かめ、`npm run setup`の終了コードは0以外であることを確かめて、観測した終了コードと、npmが終わったときに残っていたプロセスの数を、3つの止め方ごとにdiagnosticに出す。
- 一般のユーザー: GitHubのWindowsのrunnerは管理者で動くので、CIの`checks (windows, standard user)`で、一時の一般のローカルユーザーとしても同じ試験を実行する（下の「CI」）。
- T26（[PR #25](https://github.com/doc-gif/kurashi-ledger/pull/25)）との関係: T26の`npm start`の実際のCtrl+C（Windowsで飛ばす`src/start.test.ts`の試験）は、T26の統合後に、この補助でコンソールへCtrl+Cを送る試験に変え、表の行を外す。T26の本人だけのACLの試験は`npm test`に含まれるので、統合後は`checks (windows, standard user)`で一般のユーザーとしても実行される。
- 手で残る確認: `npm.cmd`（バッチファイル）で起動したときに`cmd.exe`が出す「バッチ ジョブを終了しますか (Y/N)?」の表示と、Y・Nの答えによる終了コード。`cmd.exe`の対話の表示の確認で、setupの動き（記録・印・終了コード）は上の試験で確かめている。答えを自動で入れるにはコンソールの入力を擬似する必要があり、得られるのは`cmd.exe`の表示の確認だけなので、自動にしない。キーボードのCtrl+Cを制御イベントに変える部分は、OSとターミナルの機能で、試験では制御イベントを直接生成する。

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

T05で`@playwright/test` 1.63.0を加えた（下の「ブラウザ試験」）。次に`package.json`とlockfileを変えるのはT26。

## ブラウザ試験（Playwright）

T05で、ブラウザ試験の基盤としてPlaywrightを入れた（ADR-0004）。`@playwright/test` 1.63.0（Apache-2.0）と、その依存の`playwright`・`playwright-core`（同じ版、Apache-2.0）。どれもインストールスクリプトはなく、`resolved`は`https://registry.npmjs.org/`。

- 試験は`e2e/`の`*.spec.ts`に置く。`node --test`の試験（`*.test.ts`）とは別で、`npm test`では実行しない。
- ブラウザは`e2e/browsers.ts`の1か所で決める。ChromiumをmacOS・Windows・Linux、WebKitをmacOSで実行する（PlaywrightのWindows・LinuxのWebKitはSafariの代わりにならない）。Firefoxは必須の対象に含めない（ADR-0004）。
- 手元で動かすとき: `npm run setup`のあと、`npm run test:browser:install`でこのOSに要るブラウザを入れてから、`npm run test:browser`を実行する。ブラウザはPlaywrightの配布元から取得し、Playwrightの既定の場所（利用者のキャッシュ。macOSは`~/Library/Caches/ms-playwright`、Windowsは`%LOCALAPPDATA%\ms-playwright`、Linuxは`~/.cache/ms-playwright`）に入る。`node_modules`の外なので、依存の導入の記録には影響しない。Linuxで足りないOSのライブラリも入れるときは`npm run test:browser:install -- --with-deps`（管理者の権限を使う）。
- 照合（`e2e/strict-reporter.ts`、分類は`scripts/lib/browser-outcomes.ts`）: 成功として数えるのは、成功を期待して（`expectedStatus`がpassed）実際に合格した試験だけ。Playwrightは`test.fail()`で期待どおり失敗した試験も「期待どおり」（`outcome()`がexpected）として全体をpassedにするが、照合ではこれを成功にしない。期待した失敗、skip、再試行で通った試験（flaky）、中断、時間切れ、未実行、失敗のどれかがある、このOSで必要なブラウザのどれかで成功した試験が0件、またはPlaywright全体の結果がpassedでなければ、全体を失敗にする。この境界は`scripts/browser-outcomes.test.ts`が、分類の単体試験と、実際のPlaywrightで`e2e/reporter-fixtures/`の合成の試験（ブラウザを使わない。`npm test`で全OSで実行）を流して確かめる。いまブラウザ試験で飛ばしてよい試験も、失敗を期待してよい試験もない。加えるときは、照合とこの資料を同じPRで直す。`retries`は0で、CIでは`test.only`を拒む（`forbidOnly`）。試験を集めるだけ（`--list`）のときは、CIの外でだけ照合しない。
- 設定（`playwright.config.ts`）では、ブラウザの安全上の既定の動き（CSP、HTTPSの検査、要求のヘッダ、権限、プロキシ）を変える設定（`bypassCSP`、`ignoreHTTPSErrors`、`extraHTTPHeaders`等）を使わない。T26のcookieの交換・Origin・`Sec-Fetch-Site`・CSPの試験を、実際のブラウザの動きのまま確かめるため。trace・screenshot・videoは作らない。出力先の`test-results/`は`.gitignore`の対象。
- いまの試験（`e2e/browser-base.spec.ts`）は、基盤が各ブラウザで動くことの確認だけ（日本語のページの表示と、試験の中で127.0.0.1に立てた一時のサーバーとのcookieの往復。合成の固定の文字列だけ）。アプリのサーバーと境界の試験はT26、UIのE2EはT08以降が加える。実機のSafariでの確認は、ADR-0004のとおりリリースの前に手で行う。

## CI

T05で`.github/workflows/ci.yml`を加えた。PR（baseのbranchを問わない）と、mainへのpushで動く。

| ジョブ | OS | 内容 |
| --- | --- | --- |
| `checks` | Linux・Windows・macOS | `package.json`の`devEngines.runtime`の範囲で最新のNode.jsを入れ（`actions/setup-node`の`node-version-file`。npm自身もdevEnginesで版を検査する）、`npm run setup`→`check:install`→`typecheck`→`npm test`→skipの照合（`check:test-skips`）→`build`と、`check:public`を実行する |
| `checks (windows, standard user)` | Windows | GitHubのWindowsのrunnerは管理者で動くので、一時の一般のローカルユーザー（Usersだけに属する）を作り、`npm run setup`のあと、`npm test`と同じ試験（`package.json`のtestのscript）を、そのユーザーとしてログオンして（`Start-Process -Credential`、プロファイルを読み込む）実行する。トークンが管理者でないこと（整合性レベルがMedium、Administratorsを含まない）を確かめ、skipを照合し、そのユーザーがファイルのsymlinkを作れるかをSummaryに出す。最後にユーザーとプロファイルを消す（#19。上の「Windowsのコンソールの中断の試験」）。タスク スケジューラは、S4Uのタスクの登録が拒否され、パスワードのタスクは起動されなかったので使わない |
| `browser` | Linux・Windows・macOS | `npm run setup`→`test:browser:install`→`test:browser`（ChromiumをすべてのOS、WebKitをmacOS） |
| `review tools` | Linux・Windows・macOS | Python 3.11（検査器が対応する最も古い版）で、`guard.py validate`と、レビュー運用ツールの試験（`tools/review_guard/tests`、`.review/tests`）。unittestは0件・skip・期待した失敗でも0で終わるので、要約の行にそれらがあれば失敗にする |
| `review plan` | Linux（PRのときだけ） | PRの計画の検査。baseのcheckoutにある検査器（`changed_paths.py`・`ci.py`）だけを実行し、PRのコードを実行しない（[CLI手順](../tools/review_guard/README.md)のテンプレートを配置したもの）。計画のないPRや、baseを取り込んでいないPRでは失敗する。Quality gateに含めることは、2026-10-03の所有者決定で承認された（所有者本人の確認: PR #18のCodexの記録5965890988） |
| `Quality gate` | Linux | 上のすべてのジョブの結果をまとめる。どれかが失敗・中断・skip（欠けた）なら失敗にする（pushのときは、`review plan`がskipであることを求める）。PRでは、試験したmerge commitの親が、PRのbaseとheadのSHAであることを確かめる |

- 結果の読み方: 各runのSummaryに、`npm test`の件数とskipした試験・理由・diagnostic・表との照合（OSごと、Node.jsの版つき）、ブラウザごとの結果、Quality gateの判定と、試験したcommit・PRのhead・baseのSHAが出る。レビューでは、最新のheadとbaseに対応するrunかを、このSHAで確かめる。runのあとでbaseが進んだ場合、その結果は古いbaseに対するものなので、baseを取り込んでやり直す。
- 失敗・中断・skipの扱い: `npm test`の失敗・中断・todo・0件、失敗を期待した試験（`expectFailure`。要約ではpassに数えられる）、再実行で合格した試験と、表と違うskip（表にない試験のskip、表にある試験が飛ばされないこと、理由のないskip）は、`check:test-skips`が失敗にする。ブラウザ試験は上の照合。ジョブの失敗・中断・skipはQuality gateが失敗にする。一部のジョブの成功だけで、検証が済んだとは扱わない。
- 安全: 標準のhosted runner（`ubuntu-latest`・`windows-latest`・`macos-latest`）だけを使う。権限は`contents: read`だけで、secretsを使わず、checkoutの資格情報を残さない（`persist-credentials: false`）。actionはcommitのSHAで固定する。artifactをuploadしない。`pull_request_target`を使わないので、forkからのPRにも、secretsも書込みの権限も渡らない。
- 一時のローカルユーザー（`checks (windows, standard user)`）の扱い: パスワードはステップの中で暗号論的な乱数から作り、表示・ファイルへの保存・ログへの出力をせず、ユーザーの作成とそのユーザーでの起動に渡すだけにする。ユーザーはUsersだけに属する。このジョブで加える権限は、出力のディレクトリ（変更）とworkspace（読取りと実行）だけ。ジョブの最後に、成否にかかわらずユーザーとプロファイルを消す。runnerは使い捨てのVMで、ジョブのあとに破棄される。トレードオフ: このジョブはrunnerのVMのローカルアカウントとACLを変える（使い捨てなので後に残らない）。PRのコードは、ほかのジョブと同じくrunnerの管理者でも動く（`npm run setup`等）ので、ユーザーを作ることで、PRのコードに新しい権限やsecretsが渡ることはない（このジョブもsecretsを使わず、tokenの権限は`contents: read`だけ）。
- 時間の上限: `checks`・`browser`は20分、`checks (windows, standard user)`は30分、`review tools`は10分、`review plan`・`Quality gate`は5分。同じPRの新しいpushで、古いrunは取り消す（mainへのpushは取り消さない）。
- 限界: `pull_request`のworkflowはPR自身が変えられるので、CIの合格は迂回を防がない（[修正前の整合確認](review-prevention.md)）。workflow・`scripts/`・`e2e/`・検査器・条件を変えるPRは、別の担当が内容をレビューする。CIの合格は、独立した内容レビュー・所有者の判断・マージの条件（[AGENTS.md](../AGENTS.md)）の代わりにならない。repoの設定は、必須のstatus checkを`Quality gate`だけにすることと、「Require branches to be up to date before merging」を有効にすることは、2026-10-03の所有者決定（所有者本人の確認: PR #18のCodexの記録5965890988）で、T05のマージのあとに実装側（mainのセッション）が設定する（T05のPRでは変えていない）。workflow・検査器・条件・原因台帳の変更に独立レビューを必須にする保護と、その迂回試験は、T23で扱う。必須のcheckにしても、workflowをPRで変えられる限界は変わらない。
- CIで確かめないもの: Intel Mac・Windows（arm64）、公式のインストーラ（macOSの`.pkg`、Windowsの`.msi`）で入れたNode.js（CIは`actions/setup-node`の配布物を使う。ADR-0008の「見抜けないこと」のnpmの組込みの設定は、インストーラでは未確認のまま）、実機のSafari、`npm.cmd`（バッチファイル）で起動したときの`cmd.exe`の「バッチ ジョブを終了しますか (Y/N)?」の表示（上の「Windowsのコンソールの中断の試験」）。
- 後続タスクの試験: `scripts/`・`src/`・`tests/`に`*.test.ts`を加えれば`npm test`で、`e2e/`に`*.spec.ts`を加えれば`npm run test:browser`で、3つのOSのCIで実行される。

## branchとworktree

[worktree運用](local-worktrees.md)に加えて、次を守る。

- branch名は`task/<タスクID>-<担当名>`（例: `task/T02-claude`）。1タスクにつき実装担当1名・branch 1本。
- 大文字と小文字だけが違うbranch名を作らない。MacとWindowsのファイルシステムでは、同じ名前として衝突する。
- worktreeごとに`npm run setup`を実行する。`node_modules`と記録はworktreeごとに別で、ほかのworktreeのものを使い回さない。
- miseの`mise.toml`はrepoにあるので、どのworktreeでも同じ版のNode.jsとPythonを使う（上の「worktreeとの関係」）。
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

2026-10-03に所有者が実装側のチャットで、このrepoのNode.jsとPythonの版をmiseで管理すると決めた（[#30](https://github.com/doc-gif/kurashi-ledger/issues/30)）。上の1の「ローカルのNode.jsは当面24.14.0のまま」は、所有者がmiseを入れるまでの扱いになる。
