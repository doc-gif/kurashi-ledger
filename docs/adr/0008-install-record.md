# ADR-0008: 依存の導入の記録の形式と照合の方法

- 状態: Proposed（このPRがmainに統合された時点でAcceptedとみなす）
- 日付: 2026-10-03
- 関連: T02（Issue #9）、ADR-0002（「依存の導入とリリースの対応」。ADR-0007のG6の定義の場所）、ADR-0007。記録を使うのはT08（`npm run build`）、T09（`npm run start:real`）、T12（`:real`の付いた保守コマンド）。

## 背景

ADR-0002は、依存の導入が、いまの`package-lock.json`と実行環境（Node.jsの版、OS、CPU）に対して成功したことを記録し、`npm run build`・`start:real`・`:real`の保守コマンドがそれを確かめると決めた。導入は専用のコマンド`npm run setup`で行い、既存の記録を削除してから`npm ci`を実行し、成功したときだけ記録を書く。記録の形式と照合の方法（`npm ls`等の併用を含む）と、配信物のmanifestで使うNode.jsの版の比べ方は、T02で決めるとした。

## 決定

### この記録が示すこと・示さないこと

- 示すこと: 記録に結び付けた入力（`package-lock.json`、`package.json`、`.npmrc`、Node.jsの版、OS、CPU）で、`npm run setup`の`npm ci`が最後まで成功し、導入した木がlockfileと合ったこと。照合の時点で、入力が変わっておらず、npmがその導入で書いたhidden lockfileもそのままで、各パッケージ（`package.json`）と実行ファイルのリンクがそろっていること。
- 示さないこと: `node_modules`のファイルの中身が導入の時点のままであること。記録のあとで中身が書き換えられても（意図的でも偶然でも）、構造が保たれていれば一致と判定する。同じOSユーザーとして動くプロセスは、`node_modules`も記録自身も書き換えられるので、ハッシュを増やしても改ざんは防げない（ADR-0002・ADR-0003の「この境界で守らないもの」と同じ扱い）。この記録は改ざんの検出ではなく、導入の省略・中断・古い導入・欠けた導入といった誤りを止めるためのもの。

### 置き場所

記録は`node_modules/.kurashi-ledger-install.json`に置く。

`npm ci`は、導入を始める前に`node_modules`の中身を消す（npmの公式資料。npm 11.9.0で、`.`で始まるファイルも消えることを試験で確かめた）。記録を`node_modules`の中に置けば、`npm ci`を直接実行した場合は、成功しても途中で止まっても前の記録が残らない。repo直下など`node_modules`の外に置くと、`npm ci`を直接実行して途中で止まったときに古い記録が残り、壊れた`node_modules`を「一致」と判定してしまう。`node_modules`は`.gitignore`の対象で、worktreeごとに別にある。

**リンクを拒む:** `node_modules`が、ほかの場所（共有のディレクトリ、別のworktree等）へのリンク（symlink、Windowsのjunction）だと、記録を消す・書く処理がリンクをたどり、リポジトリの外の記録やファイルを変えてしまう。`npm ci`も、リンク先の中身を消す。そこで、記録を消す・書く・照合する前に、必ず次を確かめ、当たれば何も変えずに止める（`npm run setup`は`npm ci`も始めない）。

- `node_modules`を`lstat`で調べ（リンクをたどらない）、リンクでない通常のディレクトリであること。実体パスが、リポジトリの実体パスの直下の`node_modules`と一致すること。まだなければ、書くときだけ通常のディレクトリとして作る。
- 記録の名前（`node_modules/.kurashi-ledger-install.json`）も`lstat`で調べ、ないか、通常のファイルであること。
- 消すときは、確かめた通常のファイルだけを`unlink`で消す（`rm`のように再帰しない）。一時ファイルは排他的に作り（同じ名前のファイルやリンクがあれば失敗する）、失敗したときの後始末も`unlink`だけで行う。

共有の`node_modules`は使えない。リンクになっている場合は、リンク自身だけを外して（リンク先の中身は消さない）から`npm run setup`を実行する。

### 内容（形式1）

記録は、導入した木（`node_modules`）を決める入力のすべてと、導入した木そのものに結び付ける。入力は、repoの中のファイル（`package-lock.json`、`package.json`、`.npmrc`）と実行環境（Node.jsの版、OS、CPU）。repoの外にあるnpmの設定（利用者・全体のnpmrc、`npm_config_`で始まる環境変数、`npm run setup`に付けた引数）は、`npm ci`へ渡さない（下の「書き方」の3）。

JSONで、次の欄だけを持つ。日時、利用者名、パスは記録しない。

| 欄 | 内容 | 照合 |
| --- | --- | --- |
| `format` | 記録の形式の版。いまは`1` | 違えば不一致。欄が欠けた記録も不一致 |
| `lockfileSha256` | `package-lock.json`のバイト列（改行を正規化しない）のSHA-256 | 一致 |
| `packageJsonSha256` | `package.json`のバイト列のSHA-256。依存の宣言だけでなく、scripts等を変えても違うと判定する | 一致 |
| `npmrcSha256` | `.npmrc`のバイト列のSHA-256。なければ`null` | 一致 |
| `installedTreeSha256` | npmが導入の最後に書く`node_modules/.package-lock.json`（hidden lockfile）のSHA-256。なければ`null` | 一致 |
| `node` | `process.version`（例: `v24.21.0`） | 文字列の完全一致 |
| `platform` | `process.platform`（`darwin`、`win32`等） | 一致 |
| `arch` | `process.arch`（`arm64`、`x64`等） | 一致 |

### 書き方（`npm run setup`）

1. `node_modules`と記録の名前がリンクでないことを確かめてから（上の「リンクを拒む」）、既存の記録を削除し、消えたことを確かめる。リンクだったり削除できなかったりすれば、何も変えずに終え、導入を始めない。
2. `package-lock.json`・`package.json`・`.npmrc`のハッシュを求める。lockfileかpackage.jsonを読めなければ終える。
3. `npm ci`を起動する。npmは`npm run`が環境変数`npm_execpath`で渡すもの（`npm-cli.js`）を使い、setupを実行しているNode.js（`process.execPath`）で直接起動する。シェルを通さないので、MacとWindowsで同じ動きになる。子のnpmが読む設定は、次のものだけにする。
   - 環境変数から、`npm_`で始まるもの（`npm_config_*`の設定と、`npm run`が渡す値）をすべて外す。
   - 利用者・全体のnpmrcは、`--userconfig`・`--globalconfig`で、OSの一時ディレクトリに作った空のファイル（それぞれ別のもの。npmは同じファイルを両方に使うと止まる）に差し替える。終わったら消す。
   - 残る設定は、repoの`.npmrc`（記録に結び付け、PRでレビューする）、npm自身の組込みの設定（npmの導入先のnpmrc）、引数だけになる。引数では、主な既定の値も明示し、組込みの設定やrepoの`.npmrc`の誤りで変わらないようにする: `--ignore-scripts`、`--dry-run=false`、`--include=dev --include=optional --include=peer`（`NODE_ENV=production`による`omit`の既定を打ち消す。npmは`include`と`omit`の両方にある種類を入れる）、`--install-strategy=hoisted`、`--bin-links=true`、`--os=<process.platform>`、`--cpu=<process.arch>`。
4. 終了コードが0でない、シグナルで止まった、起動できなかった場合は、記録を書かずに失敗で終える。
5. 2の3つのハッシュが変わっていないことを確かめる（導入の途中で変わっていれば書かない）。
6. 導入した木を確かめる。hidden lockfileに、`package-lock.json`の必須の依存と、このOS・CPUに当たる任意の依存（`optional`）がすべて、同じ`version`・`integrity`・`resolved`で入っていて、lockfileにないものが入っていないこと。入った依存がlockfileの`bin`欄に実行ファイルを持つなら、そのリンクが`node_modules/.bin`等にあること（Windowsでは`.cmd`のshimでもよい。hidden lockfileにはリンクの有無が表れないので、ディスクで確かめる）。任意の依存は、取得に失敗してもnpm ciが成功を返すため、このOS・CPU向けのもの（例: TypeScriptのOS別の実行ファイル）が欠けたまま記録を書かないようにする。`libc`を指定した任意の依存（Linuxのみ）は、当たるかを判定しないので、欠けていてもよい。合わなければ記録を書かずに失敗で終える。
7. `node_modules`の中に一時名で排他的に作り、書き終えてディスクへ反映してから、1回の名前変更で記録の名前にする。途中で止まっても、記録の名前に不完全なファイルは残らない。`node_modules`がリンクであれば書かない。名前変更のあとのディレクトリの反映（POSIXのfsync）に失敗した場合は、置いた記録を消してから失敗で終える。
8. 書いた記録を照合し直し、一致しなければ削除して失敗で終える。

`npm run setup`は`npm run`の経由でだけ動く（`npm_execpath`がなければ終える）。`--force`を付けた実行は拒む。`--force`はdevEnginesによるNode.jsの版の検査を外すため。

### 照合

- 記録を読む前に、`node_modules`と記録の名前がリンクでないことを確かめ、リンクなら不一致とする（上の「リンクを拒む」）。
- 記録がない、読めない、形式が違う、欄のどれかが違う場合は不一致とし、理由と「`npm run setup`を実行する」案内を出す。照合は`scripts/lib/install-record.ts`の`verifyInstallRecord`で行い、T08・T09・T12は同じ関数を呼ぶ。
- 欄がすべて一致したら、続けて書き方の6と同じ構造の確認（hidden lockfileとlockfileの対応、各パッケージの`package.json`と実行ファイルのリンクがディスクにあること）を行い、欠けていれば不一致とする。記録のあとで手で消した等の誤りを止めるため。ファイルの数だけ`lstat`するだけで、中身は読まない。
- **Node.jsの版は完全一致で比べる。** パッチ版を更新しただけでも、`npm run setup`と`npm run build`をやり直す。依存の配布物の選択や同梱のSQLite（ADR-0005）はNode.jsの版で変わりうる。範囲（同じメジャー等）で比べると、どの版で確かめたかが記録から分からなくなる。やり直しの手間は小さい。
- 配信物のmanifest（T08）のNode.jsの版も、同じく`process.version`の完全一致で比べる（ADR-0002）。
- `package-lock.json`のハッシュは改行を正規化しない。同じPCの同じcheckoutの中で比べるので、改行が変わった場合も「違う」と判定して導入をやり直させるだけで、安全側に倒れる。
- `package.json`を記録に結び付けるので、依存の宣言を変えたあとに`npm ci`を直接実行し、lockfileとの不一致で`node_modules`を消す前に失敗した場合（前の記録とhidden lockfileが残る）も、不一致と判定する。
- **repoの外のnpmの設定を1つずつ固定する方法は取らない。** 木を変えうる設定（`omit`、`install-strategy`、`bin-links`、`install-links`、`os`・`cpu`等）は多く、npmの版で増える。名前を数えて引数で固定すると、数え漏らした設定で木が変わっても記録が有効になる（レビューで、`bin-links=false`で実行ファイルのリンクが作られない例が見つかった）。そこで、子のnpmにrepoの外の設定を渡さないことで、設定の種類によらずまとめて塞ぐ。6の木の確認は、設定以外の原因（任意の依存の取得失敗等）で木が欠けた場合のためにも残す。
- 利用者のnpmrcを読まないので、そこに書いたプロキシ・証明書・認証・キャッシュの場所は、`npm run setup`では使われない。プロキシは、npmが参照する環境変数（`HTTPS_PROXY`・`HTTP_PROXY`・`NO_PROXY`。`npm_`で始まらない）で渡せる。依存は公開のregistryから取得するので、認証は要らない。CI（T05）でも、利用者のnpmrcを指定する環境変数（`NPM_CONFIG_USERCONFIG`等）は使われない。
- npmの版は記録しない。導入した木は6でlockfileと照らし合わせ、そのhidden lockfileのハッシュを記録するので、記録のあとでnpmを入れ替えても、木といまの入力の対応は変わらない。
- `npm ls`は使わない。`npm ls --all`は各パッケージのpackage.jsonの版を確かめるが、展開の途中で止まった中身は見抜けない。npmを起動し直す手間（Windowsでのシェルの扱いを含む）も増える。代わりに、npmが導入の最後に書くhidden lockfileのハッシュで、記録のあとに`npm install`等で導入し直したことを見抜く。

### pre/postスクリプトに頼らない

`.npmrc`の`ignore-scripts=true`のもとでは、`npm run`で指定したスクリプトは動くが、`prebuild`のようなpre/postスクリプトは動かない（npmの仕様）。記録の確認は、各コマンドのスクリプトの最初で行う（`npm run build`は`scripts/build.ts`の中で確かめる）。

### 見抜けないこと

- 記録を書いたあとで`npm install`等を実行し、それが途中で止まった場合（hidden lockfileは導入の最後に書かれるので変わらない）。日常の作業で`npm install`を使わず、依存を変えたら`npm run setup`をやり直す（[開発環境](../development.md)）。
- 記録のあとの`node_modules`のファイルの中身の変更（同じOSユーザーによる意図的な改変を含む）。構造（各パッケージの`package.json`と実行ファイルのリンクの有無）だけを確かめる（上の「この記録が示すこと・示さないこと」）。
- npm自身の組込みの設定（npmの導入先のnpmrc）のうち、引数で明示していないもの。公式の配布物の組込みの設定に、repoの中に導入する木を変えるものがないことは、T02の作業環境（macOS、nvmで入れた公式の配布物）では組込みの設定のファイルがないことを確かめた。公式のインストーラ（macOSの`.pkg`、Windowsの`.msi`）では未確認（T05のCI等で確かめる）。
- `npm run setup`を強制終了したとき、OSの一時ディレクトリに空のnpmrc（2つ）が残ることがある。中身は空で、害はない。
- リンクの確認と、そのあとの削除・書込みの間に、同じOSユーザーのプロセスが`node_modules`をリンクに差し替える場合（確認と使用の間の競合）。ADR-0002・ADR-0003と同じく対象外。共有の`node_modules`を誤って使う、といった誤りを止めるための確認である。
- Linuxのlibc（glibc・musl）の違い。記録せず、`libc`を指定した任意の依存は6で欠けていても通す。利用環境のMac・Windowsでは関係がなく、CIは毎回新しい環境で導入する。

## 検討した候補

| 候補 | 判断 |
| --- | --- |
| `node_modules`の中に置き、npm ciに消させる（採用） | `npm ci`の直接実行・途中停止で古い記録が残らない |
| repo直下（`.gitignore`の対象）に置く | `npm ci`を直接実行して途中で止まったときに古い記録が残る。見送り |
| `npm ls --all`を照合に併用する | 上のとおり、展開の途中で止まった中身を見抜けず、起動の手間が増える。見送り |
| `node_modules`の全ファイルのハッシュを記録して照合する | 中身の変更は見抜けるが、`npm run build`・`start:real`・`:real`の保守コマンドのたびに全ファイルを読む。React・Vite・Playwright（T05・T08）を入れると数万ファイルになる。同じOSユーザーは記録も書き換えられるので、改ざんの防止にはならない。誤りを止める目的には、構造の確認で足りる。見送り |
| Node.jsの版をメジャーだけで比べる | 上のとおり。見送り |
| `package.json`のうち依存の欄だけを比べる | scriptsの変更で導入をやり直さずに済むが、木に効く欄（`overrides`、`workspaces`、`bundleDependencies`等）を数え漏らすと古い記録が通る。ファイル全体を比べる。見送り |
| 利用者・全体のnpmの設定と環境変数を記録する | 木に効く設定を数え漏らしうるうえ、場所がPCごとに違う。見送り |
| 木を変えうる設定を1つずつ引数で固定する（前の版） | 設定の数え漏らしが残る（`bin-links`）。主な既定の値の明示としてだけ残し、repoの外の設定を子のnpmへ渡さない方法に変えた |
| 導入した木だけを確かめ、設定は制御しない | hidden lockfileに表れない違い（実行ファイルのリンク、ファイルの権限等）を見抜けない。設定の制御と組み合わせる |

## 影響

- `package-lock.json`・`package.json`・`.npmrc`が変わったとき（branchやタグの切り替え、依存の追加、scriptsの変更を含む）と、Node.jsを入れ替えたとき（パッチ版を含む）は、`npm run setup`をやり直す。`npm run build`・`start:real`・`:real`の保守コマンドは、やり直すまで止まる。
- CI（T05）も`npm run setup`で導入する（ADR-0002）。
- 形式を変えるときは`format`を上げる。前の形式の記録は不一致として扱い、`npm run setup`を案内する。

## 試験

T02で次の試験を作った。実行した環境と結果は、PR #12に記録する。固定した版のNode.jsとMac/Windows/Linuxでの実行は、2026-10-02の所有者決定でT05の受入条件にした（T02では固定版とWindowsで実行していない）。

- `scripts/install-record.test.ts`: npm ciの代わりに結果を決めた関数を渡し、失敗・シグナルでの中断・起動の失敗・導入中の入力の変化・導入した木の欠け（必須の依存、このOS・CPUの任意の依存、実行ファイルのリンク）や版の違い・余分な依存・名前変更のあとのディレクトリの反映の失敗で記録が残らないこと、各欄の違いを不一致と判定すること、記録のあとで消えたパッケージや実行ファイルのリンクを照合で見つけること（中身の書換えは見ないこと）、`node_modules`や記録の名前がリポジトリの外へのリンク（Windowsはjunction）のとき、setup・照合・書込みが止まり、リンク先が変わらないこと、npm ciに渡す引数と環境変数。
- `scripts/setup.test.ts`: 合成の依存を1つ持つ一時プロジェクトと127.0.0.1の合成のregistryで、実際のnpmを使う。`npm run setup`が記録を書き、インストールスクリプトを動かさないこと。`npm ci`を直接実行すると記録が消え、`npm run build`が止まって`npm run setup`を案内すること。依存の取得に失敗したとき、`npm ci`が`node_modules`を消す前に失敗したとき、`npm run setup`をCtrl+C相当で止めたとき（POSIXはプロセスグループへSIGINT、Windowsはプロセスツリーの強制終了）に、記録が残らないこと。`--force`を拒むこと。記録のあとで実行ファイルのリンクや依存を消すと、`npm run build`・`npm run check:install`が止まること。`node_modules`がリポジトリの外へのリンクのとき、`npm run setup`・`check:install`・`build`が止まり、リンク先（合成の別の記録と依存）が変わらないこと。package.jsonの依存の宣言を変えたあとに`npm ci`を直接実行して失敗した場合に、`npm run build`が止まること。実行ファイルを持つ合成の依存で、利用者のnpmrcと環境変数に`bin-links=false`・`omit=dev`・`install-strategy=nested`・`dry-run=true`、`NODE_ENV=production`があっても、`npm run setup`がdevの依存と実行ファイルのリンクを入れて記録すること（同じ設定の`npm ci`では木が変わることも確かめる）。

## 出典

確認日はすべて2026-10-03。

- `npm ci`（導入前に`node_modules`を消す、lockfileとpackage.jsonが合わなければ失敗する、lockfileを書き換えない）: https://docs.npmjs.com/cli/v11/commands/npm-ci
- `ignore-scripts`（pre/postスクリプトは動かない）、`force`、`include`と`omit`（両方にある種類は入れる。`omit`の既定は`NODE_ENV=production`のときdev）、`install-strategy`、`os`・`cpu`、`dry-run`: https://docs.npmjs.com/cli/v11/using-npm/config
- hidden lockfile: https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json
- スクリプトはパッケージのルートで実行される: https://docs.npmjs.com/cli/v11/using-npm/scripts
- `devEngines`、任意の依存（optionalDependencies。導入に失敗してもnpmは続ける）: https://docs.npmjs.com/cli/v11/configuring-npm/package-json
