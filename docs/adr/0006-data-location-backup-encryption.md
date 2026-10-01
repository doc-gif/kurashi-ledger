# ADR-0006: データ保管先・バックアップ・暗号化・同期の扱い

- 状態: Proposed（このPRがmainに統合された時点でAcceptedとみなす）
- 日付: 2026-10-02
- 関連: T00（Issue #1）、ADR-0002、ADR-0003、ADR-0005。実装はT07・T12、検証はT13・T25。

## 背景

実データ（給与明細、銀行入金、通知書、証憑のPDF・画像）はこのpublic repoのcheckoutに置けない。`.gitignore`は追加の防御にすぎない（[SECURITY.md](../../SECURITY.md)、[architecture.md](../architecture.md)）。さらに、開発用のworktreeとAIも所有者と同じPCで動くため、開発・試験の実行が実データのDBを開かないようにする必要がある（[AGENTS.md](../../AGENTS.md)、[worktree運用](../local-worktrees.md)）。T00では保管先、バックアップ、暗号化と鍵、Mac/Windowsの二台間同期について、扱う範囲と扱わない範囲を決める。

## 決定

### 1. データルート

アプリの全データを1つの「データルート」に置く。

| OS | 実データの既定のデータルート |
| --- | --- |
| macOS | `~/Library/Application Support/KurashiLedger/` |
| Windows | `%LOCALAPPDATA%\KurashiLedger\`（ローミングしない、そのPC専用の領域） |

- パスは決め打ちせず、OSのホームディレクトリや`%LOCALAPPDATA%`から求める。
- この2つは、OneDriveの既知フォルダー移動（デスクトップ、ドキュメント、ピクチャ等）とiCloudの「デスクトップと書類」の同期対象外。macOSでファイルアクセスの許可を求められる場所（書類、デスクトップ、ダウンロード、iCloud Drive等）にも当たらない。
- 環境変数`KURASHI_LEDGER_HOME`（または起動時の引数）で別の場所を指定できる。指定先も同じ規則で検査する。

**実データと合成データの分離:**

- データルートは作成時に種別（`real`または`synthetic`）を記録したマーカーファイルを持つ。
- 実利用の起動（ADR-0002の`npm start`）だけが既定のデータルートを使える。開くのは`real`のデータルートに限る。
- 開発サーバー、試験、E2E、AIの作業は、必ず`KURASHI_LEDGER_HOME`等で明示した`synthetic`のデータルート（試験ごとの一時ディレクトリを含む）を使う。既定のデータルートと`real`のデータルートは開かずに終了する。
- 実利用は、開発用のworktreeとは別の利用専用のcloneから、リリースタグで起動する（ADR-0002）。

**起動時の検査:** 次のどれかに当たれば、DBを開かずに理由を表示して終了する。判定は既知のパスやOSの情報による発見的なものなので、`.gitignore`と同じく追加の防御として扱う。

- データルートがGitの作業ツリー内（上位にリポジトリのメタデータがある）またはアプリのcheckout内にある。
- データルートがクラウド同期フォルダ内（iCloud Drive、OneDrive、Dropbox、Google Drive等）にある。
- データルートがネットワークドライブ上にある（WindowsのUNCパスと割り当てたネットワークドライブ、macOSのネットワークボリューム。判定できる範囲で）。
- 種別のマーカーが起動方法と合わない（上の分離の規則）。

デスクトップ・書類（ドキュメント）配下は、OSの設定次第でクラウドへ同期される。利用者が明示的に確認しない限り使わない。

**構成（案。T07・T12で確定）:** `db/`（SQLite）、`evidence/`（証憑の複製）、`snapshots/`（migration前の自動退避）、`tmp/`（スナップショットやアーカイブの作業用）、`config/`、`logs/`、種別のマーカー、単一起動用のlockファイル。

- 一時ファイルはOSの一時フォルダではなく、データルートの`tmp/`に置き、失敗時にも削除する。
- 証憑は元ファイルの場所を参照せず、データルート内へ複製する。DBにはハッシュ、元のファイル名、取込日時を記録する。ファイル名に個人情報が入りうるので、保存名はハッシュ等に基づく名前にする。

### 2. 暗号化と鍵

**保存中のDBと証憑:** アプリ独自の暗号化は初期範囲に含めない。OSの全ディスク暗号化を、実データを扱う前提条件とする。アプリから有効かどうかを確実には判定できないため、起動手順の確認項目として扱う。前提を満たせない環境では実データを扱わない。

- macOS: FileVaultを有効にする。Apple siliconやT2のMacは常に暗号化しているが、FileVaultを有効にして初めて、復号にログインパスワードが必要になる。
- Windows: Pro以上はBitLocker、Homeは「デバイスの暗号化」を使う。デバイスの暗号化は、Microsoftアカウント等でサインインしていないと（ローカルアカウントだけでは）、データが暗号化されていても保護されていない状態になる。手順書で注意する。
- ディスク暗号化の回復キーを失うと、PCのデータ全体を失う。アプリのバックアップ（3）とは別に管理する。
- OS全体のバックアップにも注意する。macOSのTime MachineはmacOSに付属しないファイルをバックアップするので、対象から外さない限りデータルートも含まれる。暗号化したバックアップディスクを使うか、データルートを対象から外す。ほかの全体バックアップの道具も同様に扱う。

**アプリのバックアップ:** 外付けドライブやクラウドフォルダなど、PCの外へ持ち出されるので、必ず暗号化する。

**鍵（パスフレーズ）:**

- 既定では、アプリが十分な長さのランダムなパスフレーズを生成して提示する。利用者が自分で決める場合は最低の長さを設け、短いものは受け付けない（長さはT12で決める）。クラウドフォルダに置いたアーカイブは、オフラインで総当たりされうるため。
- パスフレーズはアプリ・DB・設定ファイル・repo・ログに保存しない。パスワードマネージャー等で利用者が管理する。
- **パスフレーズを失うと、そのバックアップは復元できない。** これを手順書と画面に明記する。パスフレーズを変えても既存のバックアップは再暗号化しない（古いパスフレーズが引き続き必要）。

**暗号形式:** 独自の暗号形式は作らない。公開仕様があり、相互運用できる実装を持つ形式として、**age形式**を使う。パスフレーズモードはscryptで鍵を導出し、本体はChaCha20-Poly1305で暗号化する。

- 公式のコマンドラインツール`age`（Go、BSD-3-Clause）でも復号できる。このアプリが動かなくなってもバックアップを取り出せる。
- アプリから使う実装は、公式のTypeScript実装typage（npmの`age-encryption`、BSD-3-Clause）を第一候補にする。2026-10-02時点で0.3系（1.0前）で、監査の有無は確認できていない。T12で、公式`age`との相互復号、scryptの作業係数、ストリーム処理を試験してから確定する。

### 3. バックアップと復元

**中身:**

- DBの一貫したスナップショット（`node:sqlite`の`backup()`または`VACUUM INTO`。使用中のDBファイルをそのままコピーしない。ADR-0005）。
- 証憑。
- 制度データ（rules）とそのmanifest。
- manifest（フォーマット版、アプリ版（commit）、スキーマ版、制度データ版、計算エンジン版、各ファイルのハッシュ、作成日時）。計算エンジンのコードは、記録したcommitのリリースタグから取得する。
- `snapshots/`、`tmp/`、`logs/`は含めない。

**形式:**

- 中身をtar形式にまとめ、age形式で暗号化する。公式の`age`で復号すれば、macOSとWindows（Windows 10の2018年以降の版）に標準で入っている`tar`で展開できる。
- tarを作るライブラリの選定とライセンスの確認はT12で行う。

**作成:**

- 保存先は利用者が設定するデータルート外のディレクトリ。ブラウザはサーバーにファイルシステムのパスを渡せないので、設定画面のパス入力か設定ファイルで指定し、サーバー側で検査する。repo内とデータルート内は拒否する。暗号化済みなので、外付けドライブもクラウドフォルダも可。
- 作成は利用者の操作（画面またはコマンド）で行う。前回から一定期間が過ぎたら起動時に促す。
- 作成直後に、まだ手元にあるパスフレーズで復号してハッシュを照合する。成功したものを「検証済み」としてデータルートに記録する。
- 世代管理の初期値は「直近10世代と、各月末の最新を12か月分」。削除するのは、アプリが作成して記録したファイルだけ。最新の検証済みバックアップは自動では消さない。

**migration前の退避:** スキーマを更新する前に、自動で`snapshots/`へ非暗号のスナップショットを作る（DBと同じくディスク暗号化で保護）。直近3世代を残す。migrationの一部としてT07で実装する。

**復元とrollback:**

- アプリを停止した状態で、コマンドで行う。ブラウザからは行わない。
- 新しい空の作業ディレクトリへ展開し、ハッシュ、`PRAGMA integrity_check`、`application_id`、`user_version`を検証する。
- 成功したら、現在のデータルートを`<データルート>.before-restore-<日時>`へ名前変更して残し（削除しない）、作業ディレクトリをデータルートの位置へ移す。
- 検証や移動に失敗した場合、現在のデータルートは変更しない。
- migration前の退避（`snapshots/`）からのrollbackも同じ手順で行う。

**CSV/JSON出力:**

- データ交換用で、バックアップの代わりにならない。
- 平文なので、出力先は利用者が都度指定する。repo内は拒否し、暗号化されないことを画面で示す。

### 4. 二台間同期を扱わない

- MacとWindowsの間、または同じOSの複数台の間で、同じDBを同期・共有する機能は**提供しない**。データルートをクラウド同期フォルダやネットワークドライブに置く使い方もサポートせず、1の起動時検査で拒否する。
- 別のPCへ移るときは「バックアップ→移行先で復元」の一方向の移行とする。移行後は移行元を使わない運用を手順書で求める。
- 2台で別々に記録した場合は、それぞれ別の台帳として扱う。統合（マージ）機能は作らない。

## 検討した候補

| 論点 | 候補 | 判断 |
| --- | --- | --- |
| DBの置き場所 | OSのユーザー別アプリデータ領域（採用） / checkout内の`data/` / ブラウザのストレージ（OPFS等） / クラウド同期フォルダ | checkout内は誤ってcommitされうる。ブラウザのストレージはプロファイル削除や容量逼迫で消えうるうえ、外からバックアップしにくい。クラウド同期はSQLiteの破損原因になる |
| 実データと開発の分離 | データルートの種別マーカー＋起動方法による検査（採用） / 運用ルールのみ | 開発・試験・AIが同じPCで動くので、ルールだけでは誤って実データを開きうる |
| 保存中の暗号化 | OSの全ディスク暗号化（採用） / SQLCipher等のDB暗号化 | ADR-0005のドライバでは使えず、ネイティブ依存とライセンスの確認が増える。紛失・盗難にはディスク暗号化で対応でき、ログイン中のマルウェアにはどちらも効かない |
| バックアップの暗号化 | age形式（採用） / Node標準cryptoで独自形式 / 7-Zip・ZIPのAES | 独自形式は検証が難しく、ほかの道具で復号できない。Node標準のAES-GCMは、ストリームで復号すると認証タグの確認前に平文が出てくるため、扱いを誤りやすい。外部コマンドへの依存はWindows・Macでの導入手順を増やす |
| 同期 | 対応しない（採用） / クラウドフォルダに置く / 独自の同期 | 競合解決と履歴保持の設計が大きく、初期範囲外（[実装計画](../implementation-plan.md)） |

## 影響

- 利用者は、OSのディスク暗号化、OS全体のバックアップの設定、パスフレーズの管理が必要。手順書（ADR-0002）に含める。
- 開発・試験のコマンドは、合成データのデータルートを明示しないと動かない。
- ログに金額・勤務先・氏名等を出さない。

## 担当と別タスクで行う検証

- T07: データルートの検査（Git作業ツリー、クラウド同期フォルダ、ネットワークドライブ、種別マーカー）、lock、migration前の退避。Windowsの長いパス、日本語パス、OneDriveのフォルダリダイレクトを含めて試験する。
- T12: アーカイブ（tar＋age）、パスフレーズの生成と最低長、作成直後の検証、世代管理、復元とrollbackのコマンド。壊れたアーカイブ、未知のフォーマット版、復元の途中失敗、同名の証憑、公式`age`と`tar`での手動復元を試験する。
- 未割当（所有者に確認）: バックアップの設定・作成の画面と、起動時の催促。T12の範囲はinfrastructureと復元手順で、UIを含まないため。
- T13・T25: 新規環境と別OS（Mac→Windows、Windows→Mac）への復元。パスフレーズを失った場合の限界の説明。

## 出典

確認日はすべて2026-10-02。

- macOSのApplication Support: https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html 、https://developer.apple.com/documentation/foundation/url/applicationsupportdirectory
- Windowsの既知フォルダ（LocalAppData・RoamingAppData）: https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid
- OneDriveの既知フォルダー移動: https://learn.microsoft.com/en-us/sharepoint/redirect-known-folders
- iCloudの「デスクトップと書類」とストレージ最適化: https://support.apple.com/en-us/109344 、https://support.apple.com/guide/mac-help/optimize-storage-space-sysp4ee93ca4/mac
- macOSのファイルアクセスの許可: https://support.apple.com/guide/security/controlling-app-access-to-files-secddd1d86a6/web
- FileVault: https://support.apple.com/guide/mac-help/protect-data-on-your-mac-with-filevault-mh11785/mac 、https://support.apple.com/guide/security/volume-encryption-with-filevault-sec4c6dc1b6e/web
- BitLockerとデバイスの暗号化: https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/ 、https://support.microsoft.com/en-us/windows/device-encryption-in-windows-cf7e2b6f-3e70-4882-9532-18633605b7df
- SQLiteの破損原因と一貫したスナップショット: https://sqlite.org/howtocorrupt.html 、https://sqlite.org/backup.html 、https://sqlite.org/lang_vacuum.html#vacuuminto
- ブラウザのストレージの退避: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- age形式の仕様と実装: https://github.com/C2SP/C2SP/blob/main/age.md 、https://github.com/FiloSottile/age 、https://github.com/FiloSottile/typage
- Node.jsのcrypto（scrypt、GCM）: https://nodejs.org/api/crypto.html
- Time Machineの対象と暗号化: https://support.apple.com/guide/mac-help/back-up-your-mac-with-time-machine-mh35860/mac 、https://support.apple.com/guide/mac-help/choose-a-backup-disk-set-encryption-options-mh11421/mac
- Windowsの`tar`: https://devblogs.microsoft.com/commandline/tar-and-curl-come-to-windows/

クラウド同期フォルダにDBを置くと壊れうるという点は、使用中のコピーやロックの不備で破損するというSQLiteの資料からの推論。SQLiteの資料がクラウド同期を名指ししているわけではない。
