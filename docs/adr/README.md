# Architecture Decision Records

T00「実行環境と技術構成をADRに確定」の成果物。関連Issue: [#1](https://github.com/doc-gif/kurashi-ledger/issues/1)。

ADRには、決定とその理由、候補の比較、影響、出典を残す。決定を変えるときは既存のADRを書き換えず、新しいADRで置き換えて相互にリンクする。外部資料の確認日は各ADRの出典欄に書く。

## 状態の意味

| 状態 | 意味 |
| --- | --- |
| Proposed | PRでレビュー中。後続タスクはまだ前提にしない |
| Accepted | 所有者がmainへ統合した。後続タスクの前提にできる |
| Superseded | 新しいADRで置き換えた。置き換え先を記載する |

- レビューで受け入れられても、マージされるまではAcceptedにならない。
- 状態欄が「Proposed（このPRがmainに統合された時点でAcceptedとみなす）」のADRは、mainにあればAcceptedとして扱う。状態欄を書き換えるためだけのpushはしない。次にADRを変更するPRで、状態欄も合わせて直す。

## 一覧

| ADR | 決定 | 状態 |
| --- | --- | --- |
| 0001 | [小さなアプリと明示的な境界](../architecture.md)（既存の`docs/architecture.md`） | 提案済みの方向性。言語（TypeScript）と単一アプリの方針はADR-0002で確定する |
| [0002](0002-runtime-and-distribution.md) | 実行方式・ランタイム・配布・起動と更新の手順 | Proposed |
| [0003](0003-local-http-boundary.md) | ローカルHTTPの安全境界 | Proposed |
| [0004](0004-ui-and-browsers.md) | UI構成と対応ブラウザ | Proposed |
| [0005](0005-sqlite-driver.md) | SQLiteドライバ | Proposed |
| [0006](0006-data-location-backup-encryption.md) | データ保管先・バックアップ・暗号化・同期の扱い | Proposed |

`docs/architecture.md`の移動や状態欄の更新は、T00の変更範囲（`docs/adr/`）の外なのでこのPRでは行わない。E01（OpenFisca）など今後のADRは0007以降の番号を使う。

## T00の決定の要約

| 項目 | 決定 | ADR |
| --- | --- | --- |
| 実行方式 | ローカルブラウザアプリ。Node.jsの1プロセスが`127.0.0.1`でUIとAPIを配信する。使うときだけ起動し、常駐しない | 0002 |
| ランタイム | Node.js 26（2026-10-28にLTS入りの予定）。T02の着手時にNode 26がまだLTSでなければ、Node 24（24.15.0以上）で始め、26への移行は別タスクにする | 0002 |
| 言語・実行 | TypeScript。サーバー側は型除去でビルドせずに実行し（erasable syntaxのみ）、型検査は`tsc --noEmit`。UIはViteでビルドする | 0002、0004 |
| 起動手順 | 実利用専用のcloneで`npm ci`→`npm run build`→`npm start`。起動ごとのトークン付きURLをブラウザで開き、Ctrl+Cで終了する。インストールスクリプトは無効にする | 0002、0003 |
| 配布・更新 | Gitのタグ付きリリースをソースのまま実行する。インストーラ・署名付き実行ファイル・自動更新は作らない。更新はタグのcheckoutと`npm ci`・`npm run build`。migration前に自動で退避する | 0002 |
| ローカルHTTP | `127.0.0.1`へのbind、Hostの完全一致、1回だけ使える起動ごとのトークンとcookie、状態を変える要求での`Sec-Fetch-Site`/`Origin`/`Content-Type`の検査、CORSなし、`Cache-Control: no-store`、CSPはヘッダで返す、外部通信なし | 0003 |
| UI | React＋Vite、素のCSSとデザイントークン。部品の基盤（react-aria-components等）はT08で判断する | 0004 |
| 対応ブラウザ | Chrome・Edgeの最新安定版（Mac・Windows）、Safariの最新メジャー版（Mac）。Firefoxは可能な範囲で対応 | 0004 |
| SQLiteドライバ | 組み込みの`node:sqlite`。代替はbetter-sqlite3（13.0.2以上） | 0005 |
| データ保管先 | macOSは`~/Library/Application Support/KurashiLedger/`、Windowsは`%LOCALAPPDATA%\KurashiLedger\`。checkout内、クラウド同期フォルダ、ネットワークドライブでは起動しない。データルートに実データ／合成データの種別を記録し、開発・試験・AIは合成データのデータルートしか開けない | 0006 |
| 暗号化・鍵 | 保存中のデータはOSの全ディスク暗号化に任せる。バックアップはage形式でパスフレーズ暗号化する。パスフレーズは既定でアプリが生成し、アプリには保存しない。失うと復元できない | 0006 |
| バックアップ | DBのスナップショット、証憑、制度データ、manifestをtarにまとめ、age形式で暗号化する。保存先は利用者が設定する。復元はアプリを止めてコマンドで行い、別の作業ディレクトリで検証してから入れ替える | 0006 |
| 二台間同期 | 提供しない。PCの移行はバックアップと復元による一方向の移行 | 0006 |

## 受入条件との対応

| T00の受入条件・検証 | 対応箇所 |
| --- | --- |
| 新規環境から起動・更新・バックアップする手順を説明できる | ADR-0002「新規環境からの手順」、ADR-0006「バックアップと復元」 |
| 証憑とDBをrepo外に置く | ADR-0006「データルート」（checkout内では起動せず、開発・試験は実データのデータルートを開けない） |
| ローカルHTTPの境界が明記されている | ADR-0003 |
| 暗号化と鍵の境界が明記されている | ADR-0006「暗号化と鍵」 |
| 二台間同期を扱わないことが明記されている | ADR-0006「二台間同期を扱わない」 |
| 既存設定を暫定として棚卸ししている | 下の「既存設定の棚卸し」 |
| 採用する依存の公式資料、ライセンス、サポート状況、候補比較 | 各ADRの「検討した候補」と「出典」 |
| 必要な検証実装を別タスクに切り出す | 各ADRの「別タスクで行う検証」と下の一覧 |

## 既存設定の棚卸し

対象はmain（`a7cfc84`）で公開済みの設定。すべて暫定とし、T02で見直す。

| 設定 | 現状 | T00の判断・引継ぎ |
| --- | --- | --- |
| `.gitignore` | 実データ・出力・DB・鍵になりうるパターンを除外している | 追加の防御として残す。主な境界は「データルートをrepo外に置き、checkout内では起動しない」こと（ADR-0006）。T02で次の2点を直す |
| `.gitignore`のディレクトリ指定 | `data/`、`evidence/`、`exports/`、`backups/`は先頭に`/`がないので、どの階層にも当たる。たとえば`src/domain/evidence/`や`src/application/exports/`のソースコードも除外される（`git check-ignore`で確認済み） | T02でルート直下に限定する（`/data/`等）か、ソースの置き場所を例外にする |
| `.gitignore`の拡張子指定 | `*.csv`、`*.pdf`、`*.png`等により、合成データのfixture（T03）、合成の証憑（T12）、デザインのスクリーンショット（T04）も除外される。バックアップの`*.age`は除外されていない | T02で、合成データ・デザイン用の置き場所だけを例外にし、`*.age`を追加する。例外を作るときは、公開差分の点検手順も合わせて決める |
| `docs/architecture.md` | TypeScript、層の分離、repo外のデータ、CSVはバックアップではないこと、バックアップにDB・証憑・制度データ・版のmanifestを含めることを提案している | ADR-0002〜0006はこれと矛盾しない。状態欄（「T00で確定予定」）の更新は範囲外なので、マージ後の担当を所有者に確認する |
| `docs/testing.md`、`SECURITY.md` | CIはUbuntu・Windows・macOSで行う予定。実データはrepo外に置く | ADRと矛盾しない。CIで使うNode.jsの版はADR-0002に従う（T05） |
| `CLAUDE.md`、`.github/copilot-instructions.md`、`.github/PULL_REQUEST_TEMPLATE.md` | AIとPRの作業手順 | 実行環境や技術構成の設定は含まない。ADRと矛盾しないので変更しない |
| `package.json`、lockfile、Node.jsの版指定、tsconfig、workflow | mainには存在しない | T02でADR-0002・0004に沿って作る |
| 元checkoutにある未公開の試作コード | T00では読んでいない。コピー・公開もしていない | T02で採否を棚卸しする。確認する観点の例はNode.jsの版、依存、SQLiteドライバ、workflow。ADRと食い違えば、試作をADRに合わせるか、ADRを置き換える提案をする |

## 別タスクへ切り出す検証

T00では実装・検証コードを作っていない。必要な検証は次のタスクで行う。

| タスク | 検証 |
| --- | --- |
| T02 | Node 26のLTS入りの確認、`devEngines`・`engines`・lockfile・`.npmrc`（`ignore-scripts`）、`node:sqlite`の読込で警告が出ないこと、`.gitignore`の修正、試作コードの棚卸し |
| T05 | Mac/Windows/LinuxのCIで固定版のNode.jsを使うこと。各タスクが作った試験（ローカルHTTPの境界を含む）を実行し、UIが入ったときにE2Eを追加できる構成にすること |
| T07 | データルートの検査（Git作業ツリー、クラウド同期、ネットワークドライブ、種別マーカー）とlock、migration前の退避、`node:sqlite`の設定（timeout、defensive、foreign_keys、application_id、user_version）、transactionと途中失敗 |
| T08 | ReactとViteの導入（初回UI依存）、フォーム部品の基盤の選定、PlaywrightのChromium（全OS）とWebKit（Mac）、対応ブラウザでのキーボード操作・アクセシビリティ |
| T12 | tar＋age形式のアーカイブ、typageと公式`age`との相互復号、パスフレーズの生成と最低長、作成直後の検証、世代管理、復元とrollbackのコマンド、壊れたアーカイブ |
| T13 | 新規のMac/Windows環境で、起動・終了・バックアップ・復元の手順を実施して記録する |
| T25 | 更新とrollback、Node.jsのメジャー更新、別OSへの移行、パスフレーズを失った場合の限界 |

## 所有者に確認したいこと

台帳の範囲に合う担当が見つからなかったものは、どのタスクにも勝手に割り当てていない。

1. `npm start`で動くHTTPサーバーの骨格と、ADR-0003の境界検査の実装。台帳に該当するタスクがない。T09（入力ユースケースとそのAPIアダプタ）に含めるか、独立したタスクにするか。
2. バックアップの設定・作成の画面と、起動時の催促。T12の範囲はinfrastructureと復元手順で、UIを含まない。T12の範囲を広げるか、T13（統合）に含めるか、別タスクにするか。
3. T02の着手時にNode 26がまだLTSでなかった場合の、Node 24から26への移行（版の指定、lockfile、CI設定を変える）の担当。
4. マージ後に`docs/project-status.md`、`docs/architecture.md`、READMEの記載（「T00で決定予定」等）を更新する担当。T00の範囲外なので、T02に含めるか、所有者が直接行うか。
5. Firefoxを「可能な範囲」に留めてよいか。普段使うブラウザがFirefoxなら「対応」へ上げ、E2Eに加える。
