# ADR-0002: 実行方式・ランタイム・配布と起動・更新の手順

- 状態: Proposed（このPRがmainに統合された時点でAcceptedとみなす）
- 日付: 2026-10-02
- 関連: T00（Issue #1）、ADR-0001（[architecture.md](../architecture.md)）、ADR-0003〜0006。

## 背景

利用者は1人で、MacとWindowsで使う。常時稼働のサーバーや複数のサービスを必要とする構成にしない（[実装計画](../implementation-plan.md)）。[architecture.md](../architecture.md)ではTypeScriptの単一アプリケーションを提案している。T00では、実行方式、ランタイム、起動、配布、更新を決める。

## 決定

### 実行方式

**ローカルブラウザアプリ**とする。1つのNode.jsプロセスが`127.0.0.1`でHTTPを提供し（ADR-0003）、ビルド済みのUI（ADR-0004）とAPIを配信する。利用者は普段のブラウザで開く。SQLiteのDB（ADR-0005）と証憑はrepo外のデータルートに置く（ADR-0006）。プロセスは使うときだけ起動し、終了すれば何も常駐しない。

### ランタイム

- 言語はTypeScript。ADR-0001の方向性を確定する。
- ランタイムはNode.jsの**LTS版のうち1つのメジャーに固定**する。目標とする版は、最も長くサポートされる**Node.js 26**とする。
  - 2026-10-02時点で、Node 26はCurrent。LTS入りは2026-10-28の予定で、サポート終了は2029-04-30。Node 24は2026-10-20に保守期間（Maintenance LTS）へ移り、2028-04-30に終了する。Node 22は2027-04-30に終了する。
  - Node 26は、2026年3月に発表されたリリース周期変更（27以降は年1回のメジャーで、全版がLTSになる）より前の方式による最後の系列。27以降への移行はT28（Node.jsのメジャー更新）で行う。
  - 本番の利用はActive LTSかMaintenance LTSに限る、というNode.jsの方針に従う。**T02の着手時に、利用可能なLTSのうち下の必要機能を満たす版を確認して固定する。** 2026-10-28以降ならNode 26、それより前ならNode 24（24.15.0以上）になる見込み。将来のLTSを待つことはT02の開始条件にしない（2026-10-02の所有者決定）。
  - メジャー更新は、版の指定・lockfile・CI設定という共有資源を変えるので、T28（Node.jsのメジャー更新）として別に行う。
  - 必要な機能は、型除去（TypeScriptの直接実行）がStable（24.12.0以上・26）であることと、`node:sqlite`がRelease candidate（24.15.0以上・26）であること。
- 版は`package.json`の`devEngines.runtime`（npmが`install`・`ci`・`run`の前に検査する）と`engines`で宣言する。`.nvmrc`はnvm利用者向けの補助として置く（nvmはWindowsに対応していない）。依存は`package-lock.json`で固定し、`npm ci`で導入する。Corepackと`packageManager`欄は使わない（Corepackは25.0.0からNode.jsに同梱されていない）。
- 実データのあるPCで依存のインストールスクリプトが動かないように、repoの`.npmrc`で`ignore-scripts=true`にする。スクリプトが必要な依存は、理由を確認してから個別に扱う。
- 以上の設定はT02で作る（T02の範囲の「開発設定」と「依存lockfile」）。
- **TypeScriptの実行:** サーバー側（domain・application・infrastructure）はNode.jsの型除去で、ビルドせずに`.ts`を直接実行する。そのため、enum、実行時コードを持つnamespace、constructorのparameter properties、import alias、decoratorを使わず（`erasableSyntaxOnly`）、`tsconfig`の`paths`にも頼らない。UI（`.tsx`）は型除去の対象外なので、ADR-0004のViteでビルドする。
- **型検査:** TypeScript（`typescript`パッケージ）の`tsc --noEmit`で行う。2026-10-02時点の最新はGoで書き直された7.0系。`erasableSyntaxOnly`（5.8で追加）を使える。7.0には安定したプログラム用APIがまだないため、それを必要とする道具（lintの型連携等）を入れる場合は、T02・T05でTypeScript 6の併用を判断する。

### 配布

- 初期はGitのタグ付きリリースから**ソースのまま実行**する。インストーラ、署名付きの実行ファイル、自動更新は作らない。
- リリースタグは、mainにあり必要なCIとレビューを通ったcommitに、所有者の承認を得て付ける注釈付きタグとする。最初のタグはT13で付け、手順はT25で正式化する。
- 単一実行ファイル化（Node.jsのSingle Executable Applications）やデスクトップシェル（Electron、Tauri）は、T13（記録版の統合）後に必要性を確認してから別ADRで再評価する。
- 公証済みの公式Node.js（macOS版はNode.js Foundationの署名付き）の上でソースを実行するので、アプリ側で署名が必要な実行ファイルを作らない。

## 検討した候補

### 実行方式・配布

| 候補 | 長所 | 短所 | 判断 |
| --- | --- | --- | --- |
| ローカルブラウザアプリ（Node.js＋loopback HTTP、ソース実行） | 依存が最小。署名・公証が不要。TypeScriptだけで完結する | GitとNode.jsの導入が必要。HTTPの境界を自分で守る必要がある（ADR-0003） | **採用** |
| Electron | 1つのアプリとして配れる。HTTPを使わずIPCで済む | 実行環境だけで約130〜160MB（v44の配布zip）。サポートは直近3メジャー（約6か月ごとに更新が必要）。macOSの自動更新には署名が必須で、公証には有料のApple Developer Programが必要 | 見送り。T13後に再評価 |
| Tauri v2 | 配布物が小さい。OSのWebViewを使う | ビルドにRustとWindowsではMSVC Build Toolsが必要（追加のランタイム）。WebViewがOSによって異なる（WKWebView / WebView2）。公証には有料アカウントが必要。v3がalpha | 見送り |
| Node.jsのSingle Executable Applications | Node.jsの導入が不要になる | Stability 1.1（Active development）。Intel Macは試験対象外。生成物の再署名が必要。ネイティブアドオンは回避策が要る | 見送り。T13後に再評価 |
| ブラウザだけで動くアプリ（SQLite WASM＋OPFS） | サーバーなし | データがブラウザのプロファイルに閉じ込められ、外部からのバックアップや証憑の扱いが難しい（ADR-0006） | 見送り |

署名のない実行ファイルを配ると、macOSでは「このまま開く」の手動許可が必要になり、WindowsではSmartScreenの警告やSmart App Controlによるブロックの対象になる。ソース実行ならこの問題を避けられる。

### ランタイムの版

| 候補 | 判断 |
| --- | --- |
| Node 26（2026-10-28にLTS予定、2029-04-30まで） | **採用**。初回利用（T13）時点で最も長く使える |
| Node 24（Active LTS、2026-10-20から保守、2028-04-30まで） | T02の着手時にNode 26がまだLTSでない場合に使う。Node 26への更新はT28で行う |
| Node 22（Maintenance LTS、2027-04-30まで） | 見送り。`node:sqlite`がStability 1.1で、終了が近い |
| Bun、Deno | 見送り。追加のランタイムを入れる理由が今はない（ADR-0001） |

Node 26では、Intel Mac（x64）がTier 2（2028年初めまで）、Windows arm64がTier 2。どちらも公式の配布物はある。

### 採用する依存のライセンスとサポート

| 依存 | ライセンス | 版（2026-10-02） | サポート |
| --- | --- | --- | --- |
| Node.js | MIT | 26.10.0（Current。2026-10-28にLTS予定） | LTSは2029-04-30まで（上記） |
| TypeScript | Apache-2.0 | 7.0.2 | 型検査だけに使い、実行時の依存にしない |

React・Vite・PlaywrightはADR-0004、`node:sqlite`はADR-0005、age形式の実装はADR-0006に記載する。

## 新規環境からの手順

実装前の設計。各コマンドは後続タスクで実装し、T13・T25で新しいMac/Windows環境での実施記録を残す。macOSはターミナル、WindowsはPowerShellで行う。Windowsでは実行ポリシーを変更せず、`npm`の代わりに`npm.cmd`を使う（既定の実行ポリシーではPowerShell用の`npm.ps1`が動かないため）。

### 1. 準備（初回のみ）

1. OSの全ディスク暗号化を有効にする（macOS: FileVault、Windows: BitLockerまたはデバイスの暗号化）。macOSでTime Machineを使っている場合は、バックアップディスクを暗号化するか、データルートを対象から外す（ADR-0006）。
2. 拡張機能を入れていない専用のブラウザプロファイルを用意する（ADR-0003）。
3. Gitと、`package.json`の`devEngines`で指定した版のNode.js（公式インストーラ、またはバージョン管理ツール）を入れる。macOSは公式の`.pkg`、Windowsは公式の`.msi`（x64・arm64）を使える。
4. 実利用専用のcloneを作り、最新のリリースタグをcheckoutする。開発用のworktreeとは分け、クラウド同期フォルダの外に置く。
5. `npm ci`で依存を導入し（インストールスクリプトは`.npmrc`で無効）、`npm run build`でUIをビルドする。

### 2. 起動と終了

1. 実利用モードのコマンド`npm run start:real`を実行する。リリースタグをそのままcheckoutしていること（変更がないこと）を確認してから起動する。初回は確認のうえ、既定のデータルートを種別`real`で作る（作成の順序はADR-0006の「新規作成の手順」）。データルートの検査に通らなければ、理由を表示して終了する。
2. 起動ごとのトークン付きURL（ADR-0003）が、専用プロファイルのブラウザで開く。自動で開かない場合は、ターミナルに表示されたURLを開く。
3. 終了するにはターミナルでCtrl+Cを押す。lockを解放し、DBを閉じる。

`npm start`等のほかの起動は合成データモードで、`KURASHI_LEDGER_HOME`で合成データのデータルートを指定しないと起動しない。開発・試験・AIの作業はこちらを使う（ADR-0006）。データルートや保存先にWindowsの長いパスや日本語を含む場合の注意は、T13で確認する。

### 3. 更新

1. アプリを終了する。
2. リリースノートでmigrationの有無を確認し、バックアップを作る（4の1）。
3. `git fetch --tags`のあと、新しいリリースタグをcheckoutする。指定のNode.jsの版が変わっていればNode.jsを入れ替える。版が合わなければnpmが止まる。
4. `npm ci`と`npm run build`を実行する。
5. `npm run start:real`を実行する。スキーマの更新があれば、アプリがmigrationの前に`snapshots/`へ自動で退避してからmigrationする。
6. 戻すときは、前のタグをcheckoutして4を実行する。そのあと、アプリを止めたまま、実利用モードの専用コマンド（`:real`の付いたもの）で戻す。migration前の退避からはDBファイルだけを、バックアップからはデータルート全体を入れ替える（ADR-0006）。アプリは、スキーマ版が自分より新しいDBを開かない。

### 4. バックアップと復元

1. 設定画面（または設定ファイル）でバックアップの保存先を指定し、画面またはコマンドでバックアップを作る。保存先はデータルートとrepoの外。パスフレーズは既定でアプリが生成して表示するので、パスワードマネージャー等に保管する。作成直後にアプリが復号して検証する。
2. 復元は、アプリを止めた状態で、実利用モードの専用コマンド（`restore:real`等。リリースタグをそのままcheckoutした状態でだけ動く）から行う。アーカイブの全エントリを検査してから同じボリュームの作業ディレクトリへ展開し、検証する。成功したら、現在のデータルートを名前変更して残したうえで入れ替える。入れ替えに失敗した場合は元の名前に戻す（ADR-0006）。
3. 別のPCへ移るときは、移行元でバックアップを作る。移行先では1の準備のあと、2で復元する。二台間の同期はしない（ADR-0006）。
4. アプリが動かない場合でも、公式の`age`で復号し、OS標準の`tar`で展開すれば中身を取り出せる。

## 影響

- 利用者はGitとNode.jsを入れる必要がある。初期の利用者は所有者本人なので許容し、一般向けの配布は範囲外とする。
- 実行ファイルを配らないので、コード署名、macOSの公証、WindowsのSmartScreenへの対応が初期は不要。
- UIのビルドに開発用の依存（Vite等）が必要なので、実利用のcloneでも`npm ci`で開発用の依存を入れる。インストールスクリプトの無効化で、その危険を下げる。
- Node.jsのメジャー更新はT28で行い、更新後の手順の通し確認はT25で行う。

## 別タスクで行う検証

- T02: 着手時に利用可能なLTSと必要機能の確認、`devEngines`・`engines`・`.nvmrc`・lockfile・`.npmrc`（`ignore-scripts`）。依存がインストールスクリプトなしで動くこと。固定した版で`node:sqlite`を読み込んでも警告が出ないこと。元checkoutの未公開試作の棚卸し。
- T05: CIでMac/Windows/Linuxの固定版Node.jsを使い、型検査と試験を実行する。
- T26: HTTPサーバーの骨格と、ADR-0003の境界。
- T09: 起動モード（`npm run start:real`による実利用モードと、それ以外の合成データモード）の判別と、データルートの検査の組込み。
- T28: Node.jsのメジャー更新（必要時）。
- T13: 新規のMac/Windows環境で、この手順の起動・終了・バックアップ・復元を実施して記録する。
- T25: 更新とrollback、Node.jsのメジャー更新後の通し確認、別OSへの移行のリハーサル。

## 出典

確認日はすべて2026-10-02。

- Node.jsのリリース予定と各版の期間: https://github.com/nodejs/Release 、https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- 本番はLTSを使う方針: https://nodejs.org/en/about/previous-releases
- リリース周期の変更（2026-03-10発表）: https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule
- 型除去の安定度と制限: https://nodejs.org/docs/latest-v24.x/api/typescript.html 、https://nodejs.org/docs/latest-v26.x/api/typescript.html
- `node:sqlite`の安定度: https://nodejs.org/docs/latest-v22.x/api/sqlite.html 、https://nodejs.org/docs/latest-v26.x/api/sqlite.html
- Single Executable Applications: https://nodejs.org/docs/latest-v26.x/api/single-executable-applications.html
- 公式配布物と対応Tier: https://nodejs.org/dist/v24.21.0/ 、https://raw.githubusercontent.com/nodejs/node/v26.x/BUILDING.md
- Node.jsのライセンス: https://github.com/nodejs/node/blob/main/LICENSE
- TypeScriptの版・ライセンス、`erasableSyntaxOnly`、7.0: https://registry.npmjs.org/typescript/latest 、https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html 、https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- Windowsの実行ポリシーと`npm.ps1`: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-5.1 、https://github.com/npm/cli/blob/latest/bin/npm.ps1
- `npm ci`、`engines`、`devEngines`: https://docs.npmjs.com/cli/v11/commands/npm-ci 、https://docs.npmjs.com/cli/v11/using-npm/config 、https://raw.githubusercontent.com/npm/cli/latest/docs/lib/content/configuring-npm/package-json.md
- Corepackの同梱終了: https://nodejs.org/docs/latest-v24.x/api/corepack.html 、https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V25.md
- nvmの対応OS: https://github.com/nvm-sh/nvm
- Electronのサポート方針・署名・更新: https://www.electronjs.org/docs/latest/tutorial/electron-timelines 、https://www.electronjs.org/docs/latest/tutorial/code-signing 、https://www.electronjs.org/docs/latest/tutorial/updates
- Tauri v2の前提条件・WebView・署名: https://v2.tauri.app/start/prerequisites/ 、https://v2.tauri.app/reference/webview-versions/ 、https://v2.tauri.app/distribute/sign/macos/
- macOSの公証と「このまま開く」: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution 、https://support.apple.com/en-us/102445
- Windows SmartScreenとSmart App Control: https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/ 、https://support.microsoft.com/en-us/topic/what-is-smart-app-control-285ea03d-fa88-4d56-882e-6698afdb7003

未確認の事項: Windows向け公式配布物のコード署名の有無。`node:sqlite`の実験的機能の警告は、Node 26.10.0のソースでは出さないことを確認した（ADR-0005）。実行時の確認はT02で行う。
