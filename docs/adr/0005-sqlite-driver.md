# ADR-0005: SQLiteドライバ

- 状態: Proposed（このPRがmainに統合された時点でAcceptedとみなす）
- 日付: 2026-10-02
- 関連: T00（Issue #1）、ADR-0002、ADR-0006。スキーマ・migration・Repositoryの実装はT07、バックアップ・復元はT12。

## 背景

記録・改訂・参照を1つのtransactionで保存し（T07）、使用中のDBから一貫したバックアップを取り、空の環境へ復元する（T12）必要がある。利用者はMacとWindowsで使い、WindowsでC++のビルドツールを入れずに導入できることが望ましい。ADR-0002で、Node.jsはLTSの1メジャーに固定する（目標はNode 26。T02の着手時にLTSでなければNode 24の24.15.0以上）。

## 決定

- **ドライバ:** Node.js組み込みの`node:sqlite`（同期API `DatabaseSync`）を使う。npmの依存とネイティブアドオンを追加しない。
- **代替:** `node:sqlite`で解決できない問題（API不足、重大な不具合、Release candidateからの後退）がT07で見つかった場合に限り、better-sqlite3（13.0.2以上）へ切り替える。切り替えるときは本ADRを置き換えるADRを書く。
- **境界:** ドライバを直接使うのは`src/infrastructure/storage/`だけにする。domainとapplicationはユースケース単位のRepositoryに依存し、SQLやドライバの型を知らない（[architecture.md](../architecture.md)）。これにより代替への切り替えを局所化する。
- **初期設定（T07で試験して確定）:**
  - `timeout`（busy timeout）を明示する。既定値は0。
  - 拡張の読込を許可しない（`allowExtension`を指定しない）。
  - `defensive`を有効のままにする（Node 24.14.0以上・26では既定で有効）。DBファイルを壊しうるSQL機能を禁止する。
  - `PRAGMA foreign_keys=ON`。`PRAGMA application_id`でこのアプリのDBであることを、`PRAGMA user_version`でスキーマ版を示す。
  - transactionの補助関数はないので、`BEGIN`・`COMMIT`・`ROLLBACK`を確実に対にする小さな関数をinfrastructureに作る。
  - journal modeの初期値はrollback journal（DELETE）。WALに変える場合は、`-wal`・`-shm`ファイルの扱いと復元時の切替手順をT07・T12で試験してから決める。
  - DBファイルを移動・入れ替える処理では、対応するjournal（WALなら`-wal`・`-shm`）を必ず一式で扱う。`db/`にはDBとjournal類だけを置き、入れ替えはディレクトリの名前変更で行う（ADR-0006のrollback手順）。
- **整数:** 金額は円単位の整数とする。`node:sqlite`は安全な整数の範囲を超える値を読むと`ERR_OUT_OF_RANGE`で失敗する（黙って精度を失わない）。この挙動を前提に、範囲の検証はdomainで行う（T06）。
- **バックアップ:** `node:sqlite`の`backup()`、または`VACUUM INTO`でデータルートの`tmp/`へ書き出し（OSの一時フォルダは使わない）、`PRAGMA integrity_check`・`application_id`・`user_version`を確認してから使う。使用中のDBファイルや`-journal`・`-wal`ファイルを直接コピーしない（ADR-0006）。

## 検討した候補

| 候補 | 状態（2026-10-02） | 判断 |
| --- | --- | --- |
| `node:sqlite` | Node 24.15.0以上・26でStability 1.2（Release candidate）。フラグは不要。実験的機能の警告はRelease candidateへの変更時に削除された（Node 26.10.0のソースで確認。実行時の確認はT02）。同梱のSQLiteは3.53.4（v24.21.0・v26.10.0）。`backup()`、`timeout`、`defensive`、BigIntでの読込を備える。transactionの補助関数はない | **採用**。依存ゼロ。ネイティブアドオンのABIや導入の問題がない |
| better-sqlite3 13.x | MITライセンス。v13からN-APIで、Mac（x64・arm64）とWindows（x64・arm64）の構築済みバイナリをnpmパッケージに同梱。13.0.0・13.0.1にはWindowsでビルドが走る不具合があり、13.0.2で修正。`db.transaction()`あり。npmの保守者は1名 | 代替として保持 |
| sqlite3（node-sqlite3） | リポジトリがアーカイブ済みで、READMEに「保守されていない」と明記 | 見送り |
| @libsql/client | ネイティブパッケージの構築済みバイナリにWindows arm64がない。新機能は別製品（Turso）へ移行中 | 見送り |
| ブラウザ内のSQLite WASM＋OPFS | Worker内でのみ動く。ブラウザの片付けやストレージの退避でDBが消えうると公式資料が警告している | 見送り（ADR-0002・ADR-0006） |
| Node 22の`node:sqlite` | Stability 1.1で、実験的機能の警告が出る。2027-04-30に終了 | 見送り |

暗号化付きのSQLite（SQLCipher、SEE、SQLite3 Multiple Ciphers）は、公式のNode.jsに同梱されたSQLiteでは使えない。使うにはネイティブ依存や商用ライセンスが必要になる。保存中のデータはOSの全ディスク暗号化で守ると決めた（ADR-0006）。そのため、暗号化を理由にドライバを選ぶことはしない。

## 影響

- Node.jsの更新でSQLiteの版も変わる。Node.jsのメジャー更新時は、migrationとバックアップ・復元の試験をやり直す（T28）。
- `node:sqlite`はまだStable（Stability 2）ではない。Node 26の更新でAPIが変わった場合は、infrastructureの中だけで吸収する。
- 同期APIなので、重い処理はHTTP要求の処理を止める。単一利用者のローカルアプリでは許容し、問題があればT07で計測する。

## 別タスクで行う検証

- T02: 固定した版で`node:sqlite`を読み込んでも警告が出ないこと。Mac/Windows/Linuxでの動作確認。
- T07: migration前の退避（ADR-0006）、transaction、途中失敗時の巻き戻し、`timeout`、`defensive`、`foreign_keys`、`application_id`・`user_version`、スキーマ版が新しすぎるDBを開かないこと。
- T12: `backup()`と`VACUUM INTO`による退避、`integrity_check`、別環境への復元。

## 出典

確認日はすべて2026-10-02。

- `node:sqlite`（v22・v24・v26）: https://nodejs.org/docs/latest-v22.x/api/sqlite.html 、https://nodejs.org/docs/latest-v24.x/api/sqlite.html 、https://nodejs.org/docs/latest-v26.x/api/sqlite.html
- Release candidateへの変更と警告の削除: https://github.com/nodejs/node/pull/61262
- 同梱のSQLiteの版: https://github.com/nodejs/node/blob/v26.10.0/deps/sqlite/sqlite3.h 、https://sqlite.org/chronology.html
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0 、https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.2 、https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/docs/api.md 、https://unpkg.com/browse/better-sqlite3@13.0.3/prebuilds/
- sqlite3（node-sqlite3）: https://github.com/TryGhost/node-sqlite3
- libSQL: https://registry.npmjs.org/libsql 、https://github.com/tursodatabase/libsql
- SQLite WASMの永続化: https://sqlite.org/wasm/doc/trunk/persistence.md
- defensiveの意味: https://sqlite.org/c3ref/c_dbconfig_defensive.html
- 破損の原因（使用中のコピー、hot journal、ネットワークファイルシステム）: https://sqlite.org/howtocorrupt.html
- WAL: https://sqlite.org/wal.html
- Online Backup API、`VACUUM INTO`、PRAGMA: https://sqlite.org/backup.html 、https://sqlite.org/lang_vacuum.html#vacuuminto 、https://sqlite.org/pragma.html
- 暗号化付きSQLite: https://www.zetetic.net/sqlcipher/open-source/ 、https://sqlite.org/com/see.html 、https://github.com/utelle/SQLite3MultipleCiphers
