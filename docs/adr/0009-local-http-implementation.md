# ADR-0009: ローカルHTTPの境界の実装の詳細（起動の識別子、トークンの交換、本人専用の一時ファイル）

- 状態: Proposed（このPRがmainに統合された時点でAcceptedとみなす）
- 日付: 2026-10-03
- 関連: T26（Issue #24）、ADR-0003（ローカルHTTPの安全境界。ADR-0007のG7の定義の場所）、ADR-0002（起動と終了）、ADR-0006（データルートの`tmp/`と権限）、ADR-0007。使うのはT08（Viteの組込み）、T09（データルートの検査とつなぎ込み、記録のAPI）、T07（権限の判定の基準）。

## 背景

ADR-0003は境界の方式を決め、起動の識別子の「ヘッダの名前と形式、注入の方法」をT26で決めるとした（14）。ADR-0006の1「権限」は、Windowsの本人だけに許可するACLの判定をT07で決め、ADR-0003の一時ファイルと同じ基準にするとした。T26は、T07より先に一時ファイルとその置き場所の権限を確かめる必要がある。このADRは、T26で決めた実装の詳細を書く。ADR-0003の決定は変えない。食い違えばADR-0003を正とし、このADRを直す。

## 決定

### 1. 起動の識別子（ADR-0003の14）

- 値: 起動ごとに作る16バイトの暗号論的乱数のbase64url（22文字。`[A-Za-z0-9_-]{22}`）。秘密ではなく、認証（cookie）の代わりにしない。
- HTMLへの注入: サーバーが、配信するHTML（交換用のページ、配信ルートのHTML、案内ページ）の最初の`<head>`の直後に`<meta name="kurashi-ledger-launch-id" content="<識別子>">`を入れる。scriptではないのでCSPに影響しない。`<head>`がないHTMLと、すでに同じ名前の`<meta>`を含むHTMLは、識別子があいまいになるので配信しない（500）。開発時にViteが配信するHTMLへの注入はT08で行い、サーバーは開発時の口に渡した要求ごとに識別子を渡す（`devRequestContext`）。
- API要求: UIは`<meta>`から読み、すべてのAPI要求（トークンの交換を含む）に`Kurashi-Ledger-Launch-Id`ヘッダで付ける。カスタムのヘッダなので、別のoriginからの要求は事前確認（preflight）になり、CORSを返さないサーバーは通さない（追加の防御）。
- 拒否: ヘッダのない要求と、同じヘッダが2つ以上ある要求は403（`launch-id-required`等）。形の違う・いまの起動と違う値（前の起動のものを含む）は409（`launch-id-mismatch`）で、UIは再読み込みを促す。HMRのWebSocketには付けない（ADR-0003の14）。

### 2. トークンとcookieの交換（ADR-0003の4）

- トークン: 起動ごとに32バイト（256bit）の暗号論的乱数のbase64url。メモリにだけ置き、1回だけ交換できる。比較は一定時間で行う。
- 交換用のページ: `GET /launch`（HTML）と`GET /launch.js`（同じoriginの外部スクリプト）。データを含まない。スクリプトは、フラグメントのトークンを読み、`history.replaceState`で`/launch`に置き換え、`POST /api/session`（本文`{"token":"…"}`、`Content-Type: application/json`、起動の識別子のヘッダ）で交換し、成功（204）なら`location.replace('/')`で画面へ移る。失敗すれば、使用済み・無効・起動し直しの案内を表示する。
- 交換のエンドポイント`POST /api/session`: Host、`Sec-Fetch-Site`・`Origin`、`Content-Type`、起動の識別子をほかのAPIと同じに確かめ、cookieの代わりにトークンを確かめる。本文の上限は1KiB。無効・使用済み・別の起動のトークンは403（`token-rejected`）。成功すると、トークンとは別の32バイトの乱数をセッションの値にし、`Set-Cookie: kl_session_<ポート>=<値>; Path=/; HttpOnly; SameSite=Strict`を返す（本文なしの204）。交換が済んだら一時ファイルを消す。
- ほかのAPIは、いまの起動のセッションの値を持つcookieのない要求を401（`session-required`）で拒否する。セッションはメモリにだけあり、終了で無効になる。

### 3. 起動用の一時ファイル（ADR-0003の4）

- 置き場所: 起動処理から渡された本人専用のディレクトリだけを使う。HTTPの部品は、ディレクトリを作らない・権限を変えない。`lstat`でリンク（symlink・junction）でないこと、ディレクトリであること、下の「本人だけの権限」を満たすことを確かめてから、実体パスを固定する。T26の段階の`npm start`では`--token-dir`で明示したディレクトリ（なければ起動しない。repoの中は拒否する）、T09からは検査に通ったデータルートの`tmp/`。
- 作り方: 名前は起動ごとの乱数（`launch-<24桁の16進>.html`）。名前に既存のファイル・リンク（壊れたリンクを含む）があれば作らない（先に`lstat`で確かめ、`O_CREAT|O_EXCL`（POSIXは`O_NOFOLLOW`も）で作る）。作ったら本人だけの権限にして確かめ、開いたファイルと同じもの（`dev`と`ino`）であることを確かめてから、トークンを書いて反映する。
- 中身: 交換用のページのURL（`http://127.0.0.1:<port>/launch#<トークン>`）へ移る`<meta http-equiv="refresh">`と、手で開くためのリンクだけのHTML。`<meta name="referrer" content="no-referrer">`を付ける。
- 消し方: 交換が済んだときと終了時に、作ったときと同じ通常のファイル（`dev`と`ino`が一致し、リンクでない）であることを確かめてから`unlink`だけで消す。置き換わっていれば消さない。強制終了で残ったファイルのトークンは、プロセスと一緒に無効。

### 4. 本人だけの権限（ADR-0003の4、ADR-0006の1「権限」）

T07のデータルートの権限も、この基準を使う。基準を変えるときは、このADRと、T26・T07の試験を同じPRで直す。

- macOS・Linux: `lstat`で調べ、所有者が実行中のユーザーで、グループとほかのユーザーの権限のbit（`0o077`）がないこと。作るものは、ファイル`0600`・ディレクトリ`0700`に設定してから確かめる。
- Windows: 所有者が実行中のユーザーのSIDで、DACLがあり（NULLのDACLは拒否）、Allowのエントリ（継承専用を含む）がすべて実行中のユーザーのSIDで、Allow・Deny以外の種類のエントリがないこと。SYSTEM・Administrators・CREATOR OWNER等の許可も拒否する（管理者は特権で読めるので、外しても本人の利用は変わらない）。作るものは、所有者を実行中のユーザーにし（管理者の権限で動くと、作ったものの所有者がAdministratorsになることがあるため）、継承を切って実行中のユーザーだけにFullControlを許可するDACLに置き換えてから確かめる。表示名はロケールで変わるので使わず、セキュリティ記述子の2進の形から取り出した所有者とDACLのエントリのSIDで判定する（SDDLの文字列は、組込みのAdministrator等を別名で書くので使わない）。読み書きは、Windowsに同梱のWindows PowerShell 5.1（`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`）で.NETのACLのAPIを呼び、パスは環境変数で渡す（コマンドの文字列に埋め込まない。実行ポリシーは変えない）。
- 見ないもの: POSIXの拡張ACL（macOSのACL、LinuxのPOSIX ACL）。モードのbitが本人だけでも、拡張ACLでほかのユーザーに許可されていれば見抜けない。T26のディレクトリは利用者または起動処理が作ったものなので、この限界を受け入れる。T07で必要なら見直す。

### 5. 待受・ポート・応答

- 待受: `127.0.0.1`だけ（`listen`のhostを明示）。既定のポートは`48720`（`npm start`の`--port`で変えられる。0はOSが選ぶ、試験用）。使用中なら別のポートへ移らず、理由を表示して終了する（終了コード1）。一時ファイルは、待受に成功してから作る。
- Host: `127.0.0.1:<port>`と完全に一致し、ちょうど1つであること。静的ファイルを含むすべての要求に適用する（403、`host-mismatch`）。要求の対象が`/`で始まらない要求（絶対形式等）は400。
- 状態を変える要求（GET/HEAD以外）: `Sec-Fetch-Site`があれば`same-origin`、`Origin`があれば`http://127.0.0.1:<port>`と完全一致、どちらもなければ拒否（403）。GETのAPIでも、これらのヘッダがあれば同じ条件を求める（追加の防御）。`Content-Type`は`application/json`（charsetは`utf-8`だけ）。`application/octet-stream`は、本文の上限を決めて宣言したエンドポイントだけで受け付ける（ほかは415）。JSONの本文の上限は既定で64KiB（413）。UTF-8・JSONとして読めない本文は400。
- 応答の出口: すべての応答で、書き出す直前（`writeHead`）に、`Content-Security-Policy`（ADR-0003の7の初期値）、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`Cross-Origin-Resource-Policy: same-origin`、`X-Frame-Options: DENY`を付け直し、`Access-Control-*`を取り除く。APIの処理や開発時のmiddlewareが変えようとしても外れない。APIの応答は`application/json`だけ。拒否の応答には、理由の符号（`X-Kurashi-Ledger-Reason`）を付ける（データを含まない）。
- 静的配信: 起動時に配信ルートの実体パスを固定する。URLのパスは、生のままでバックスラッシュと`%2F`・`%5C`を拒否し、1回だけデコードしてから、`%`（二重エンコード）・バックスラッシュ・制御文字（NULを含む）・`:`（ドライブ指定・ストリーム）・`.`と`..`のセグメント・末尾の`.`と空白・Windowsの予約名（`CON`等）を拒否する（400）。空のセグメント（ディレクトリの要求）と`.`で始まる名前は返さない（404）。候補の実体パスが配信ルートの実体パスの配下の通常のファイルのときだけ返す。読み出し元は差し替えられ、T09はmanifestで確かめた内容をメモリから返す読み出し元に替える（ADR-0002）。`npm start`（T26の段階）は配信ルートを渡さず、`/`でデータを含まない案内ページだけを返す。
- ログ: 要求ごとに「方法 クエリを除いたパス 状態 理由の符号」だけを出す（印字できない文字は置き換え、長さを制限する）。トークン・cookieの値・クエリ・本文・Hostの値を出さない。`npm start`は、標準出力が端末のときだけ1回だけ使えるトークン付きURLを表示し、端末でないとき（リダイレクト・パイプ）は一時ファイルのURLだけを表示する（ADR-0003の4の「ターミナルにも同じURLを表示し」を、ログに残さない形で行う）。
- ブラウザを開く: OSの既定の処理（macOS `/usr/bin/open`、Windows `explorer.exe`、Linux `xdg-open`）に一時ファイルのパスだけを渡す（トークンをコマンドラインに出さない）。`--no-open`で開かない。専用のブラウザのプロファイルで開く設定は、T13・T25の手順で扱う。

### 6. 開発時の口（ADR-0003の7・10。組込みはT08）

- `dev.middleware`（Viteの`server.middlewares`等、Connectの形）: Hostの検査を通ったGET/HEADの要求（APIと交換用のページを除く）だけを渡す。その応答には、応答ごとの新しいnonce（16バイトの乱数のbase64）を`script-src`・`style-src`に加え、`connect-src`に`ws://127.0.0.1:<port>`を加えた開発時のCSPを付ける。nonceと起動の識別子は`devRequestContext(req)`で受け取り、T08がViteのHTMLに入れる。本番の応答（口を使わないとき、交換用のページ、API）のCSPにはnonceを含めない。
- `dev.upgrade`（HMRのWebSocket）: Host、`Origin`（必須で完全一致）・`Sec-Fetch-Site`（あれば`same-origin`）、cookieの検査を通ったupgradeだけを渡す。口がなければ、すべてのupgradeを拒否する。ViteにはこのサーバーのHTTPの`server`を直接渡さない（Viteが自分でupgradeを受けて検査を迂回するため）。
- 配信ルートと開発時の口は同時に使えない。開発時だけ検査を外す設定はない。

### 7. 終了（ADR-0002の「起動と終了」）

`npm start`は、Ctrl+C（SIGINT）・SIGTERM・SIGHUP（WindowsはSIGBREAKも）で、待受を止め、接続を閉じ、一時ファイルを消して、終了コード0で終わる。終了の処理の途中でもう一度受けたら、待たずに1で終わる。lockの解放とDBを閉じることはT09で加える。

## 検討した候補

| 候補 | 判断 |
| --- | --- |
| 識別子を`<meta>`に入れ、カスタムのヘッダで送る（採用） | CSPに影響せず、前の起動のタブを確実に拒否できる。別のoriginからは事前確認になる |
| 識別子をcookieに入れる | cookieはoriginごとに共有されるので、前の起動のタブも新しい値を送ってしまう（ADR-0003の14の理由） |
| HTMLのプレースホルダーを置き換える | UIの作り手がプレースホルダーを書き忘れると識別子のないHTMLになる。`<head>`の直後に入れ、入れられないHTMLは配信しない方が確実 |
| トークンをそのままcookieの値にする | 一時ファイルのトークンとcookieが同じ値になり、どちらかが漏れたときの影響が重なる。別の乱数にした |
| WindowsのACLを`icacls`の出力やSDDLの文字列で判定する | `icacls`の出力のアカウント名と文言はロケールで変わり、SDDLの文字列は組込みのアカウントを別名（`LA`等）で書く。2進の形から取り出したSIDにした |
| 一時ファイルの名前を固定にする | 強制終了で残ったファイルが次の起動を止める。乱数の名前にした（排他的な作成は同じ） |
| ポート使用中なら空いているポートへ移る | ADR-0003の2で採らない（cookieの名前とブックマークが変わり、利用者が気づかない） |

## 影響

- T08は、Viteをmiddlewareモードで`dev.middleware`に、HMRを`dev.upgrade`に載せ、`devRequestContext`のnonceと識別子をViteのHTMLに入れる。Viteの`server.hmr.server`にこのサーバーを渡さない。
- T09は、起動処理でデータルートを検査し、`tmp/`を`tokenDirectory`として渡し、`--token-dir`を置き換える。記録のAPIは`api`の口に載せる。`start:real`は、manifestで確かめた内容の読み出し元を渡す。
- T07は、データルートの権限の判定にこのADRの4の基準を使う（判定の部品は`src/infrastructure/http/owner-only.ts`。T07で共通の場所へ移してよい）。

## 別タスクで行う検証

- T26（このADR）: `src/infrastructure/http/`と`src/start.ts`の`*.test.ts`（node:test）と、`e2e/http-boundary.spec.ts`（Playwright）。CIでLinux・Windows・macOSで実行する。WindowsでCtrl+Cを試験から送れない1件は[開発環境](../development.md)の「環境によって飛ばす試験」に登録した。
- T08: Viteを組み込んだ開発時の構成で、交換・API・HMRのWebSocket・nonceを試験する（ADR-0003）。
- T09: データルートの`tmp/`を渡したときの一時ファイル、二重起動、記録のAPI。
- T13: 新規のMac/Windows環境での起動・終了（WindowsのCtrl+Cを含む）の実施記録。
