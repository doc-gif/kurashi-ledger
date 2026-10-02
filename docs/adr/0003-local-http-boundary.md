# ADR-0003: ローカルHTTPの安全境界

- 状態: Proposed（このPRがmainに統合された時点でAcceptedとみなす）
- 日付: 2026-10-02
- 関連: T00（Issue #1）、ADR-0002、ADR-0004。実装と試験は主にT26で行う（開発時の構成はT08、データルートの検査とlockの組込みはT09）。

## 背景

ADR-0002では、Node.jsのプロセスがloopbackでHTTPを提供し、利用者の普段のブラウザでUIを開く方式を採る。同じブラウザで開いている他サイトや同じPC上の他プロセスから、このサーバーに要求が届きうる。localhostで動くサービスは、DNS rebindingやクロスサイト要求で操作されたり情報を読み取られたりしやすい。[実装計画](../implementation-plan.md)では、loopback限定やOrigin検証など、他サイトから操作されない境界をT00で決めることにしていた。

## 決定

1. **待受先:** `127.0.0.1`を明示してbindする。Node.jsの`listen()`はhostを省略すると`::`（多くのOSでは`0.0.0.0`も兼ねる）で待ち受け、LANから届いてしまう。名前解決の結果がIPv4/IPv6で揺れる`localhost`も使わない。LANから接続できる設定は作らない。
2. **ポート:** 既定値を固定し、設定で変更できるようにする。使用中なら別のポートへ自動で移らず、理由を表示して終了する。同じデータルートでの二重起動はlockで防ぐ（ADR-0006）。
3. **Hostヘッダ:** `127.0.0.1:<port>`と完全一致しない要求は、静的ファイルを含めすべて拒否する（DNS rebinding対策）。
4. **起動ごとの秘密トークン:**
   - 起動のたびに256bitの暗号論的乱数でトークンを作る。
   - ブラウザへは、利用者本人だけが読める一時ファイル（HTML）を開いて渡す。トークン付きURLをコマンドライン引数でブラウザに渡すと、他のプロセスから見えるため。一時ファイルは交換が済んだら削除する。ターミナルにも同じURLを表示し、自動で開けない場合に使う。
   - 一時ファイルは、OSの共有の一時領域ではなく、本人専用のディレクトリ（実行時は、検査に通ったデータルートの`tmp/`。HTTPの部品（T26）は渡されたディレクトリだけを扱い、つなぎ込みはT09）に、既存のファイルやリンクがあれば失敗する排他的な作成で作る。権限は、macOSではファイル`0600`・ディレクトリ`0700`、Windowsでは本人だけに許可するACLとする。作成後に、権限とリンクでないことを確かめてから使う。
   - トークンは、交換用のページのURLのフラグメント（`http://127.0.0.1:<port>/launch#<トークン>`）に置く。フラグメントはサーバーへの要求にも`Referer`にも含まれない。
   - 交換用のページは、データを含まない静的ページで、同じoriginの外部スクリプトだけを使う（CSPでインラインscriptを禁止しているため）。ページは次の順に処理する。
     1. フラグメントからトークンを読む。
     2. `history.replaceState`で、トークンを除いたURLに履歴エントリを置き換える。
     3. 同じoriginへのPOST（5の検査の対象）でトークンをcookieへ交換する。トークンは1回だけ使える。
     4. `location.replace`で画面へ移動する。戻る操作でトークン付きのURLに戻らない。同じoriginのページから始まる移動なので、`SameSite=Strict`のcookieが送られる（一時ファイル（`file://`）から始まった移動やその続きのリダイレクトでは送られない）。
   - cookieは`HttpOnly`・`SameSite=Strict`・`Path=/`とする。cookie名にはポート番号を含め、実利用と開発用など複数の起動が同じ`127.0.0.1`のcookieを上書きし合わないようにする。
   - すべての応答に`Referrer-Policy: no-referrer`を付ける。
   - トークンとcookieの値は、ログ・履歴・URLのクエリに残さない。
   - データを含まない静的ファイル（UIのビルド成果物と交換用のページ）はcookieなしでも返す。データはAPIからだけ返し、API（将来WebSocketを使う場合はそのupgradeも含む）はcookieのない要求を拒否する。cookieは起動ごとに無効になる。
   - 例外は、トークン交換のエンドポイント（3のPOST）だけ。ここはcookieを発行する前なので、cookieの代わりに、有効な1回限りのトークンを認証として受け付ける。Host・`Sec-Fetch-Site`・`Origin`・`Content-Type`の検査（5）は、ほかのAPIと同じように行う。トークンが無効・使用済み・別の起動のものなら拒否する。交換のエンドポイントはデータを返さない。
5. **状態を変える要求:** GET/HEAD以外はすべて、次をすべて満たさなければ拒否する。GETで状態を変えない。
   - `Sec-Fetch-Site`があれば`same-origin`であること。`cross-site`だけを拒否するのでは足りない。siteの判定はポートを無視するので、同じPCの別ポートのページからの要求は`same-site`になる。
   - `Sec-Fetch-Site`がなければ、`Origin`が`http://127.0.0.1:<port>`と完全一致すること。どちらもなければ拒否する。
   - `Content-Type: application/json`であること。例外は証憑の取込のように中身がファイルそのものの要求で、専用のエンドポイントに限って`application/octet-stream`を受け付ける。この場合も上の2つとcookieの検査は同じに行い、サイズの上限を設ける。
   - バックアップからの復元はHTTPでは受け付けない（ADR-0006のとおりアプリを停止してコマンドで行う）。
6. **CORS:** CORSヘッダを一切返さない（`Access-Control-Allow-Origin: *`が、Viteの開発サーバーの脆弱性CVE-2025-24010の原因の1つだった）。JSONPや`text/plain`でのデータ返却もしない。APIの応答には`Content-Type: application/json`、`X-Content-Type-Options: nosniff`、`Cache-Control: no-store`を付け、金額等をブラウザのディスクキャッシュに残さない。
7. **画面の制限:** CSPはHTTPヘッダで返す（`frame-ancestors`は`<meta>`では効かない）。初期値は`default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`。インラインscriptや`eval`を許可しない。外部のスクリプト・フォント・画像・解析タグを読み込まず、依存はビルド時に同梱する。
   - 開発時（10）だけは、ViteのCSSの差し替えやReact Refreshがinlineのstyle・scriptを使うので、nonceで許可する。Viteの`html.cspNonce`にプレースホルダーを設定し、サーバーはHTMLを返すたびに、予測できない新しい値（暗号論的乱数）でプレースホルダーを置き換える。同じ値を、その応答のCSPの`script-src`と`style-src`に`'nonce-<値>'`として加える。Viteは`<meta property="csp-nonce">`の値を、HMRで挿入するstyleやscriptにも使う。HMRのWebSocketのため、開発時の`connect-src`には同じoriginの`ws://127.0.0.1:<port>`を加える。
   - 固定のnonce、`'unsafe-inline'`、`'unsafe-eval'`は、開発時にも使わない。nonceを加えるのは開発時の応答だけで、本番のCSPには含めない。
8. **HTTPS:** loopbackでは使わない。`127.0.0.0/8`はブラウザで「潜在的に信頼できる」origin（secure context）として扱われるため、自己署名証明書の導入手順を利用者に課さない。
9. **外部通信:** サーバーは利用者の操作なしに外部へ通信しない（テレメトリ、更新確認、CDNなし）。制度データ等の取得を将来加える場合は別のADRで決める。
10. **開発時の構成:** 開発時も、ブラウザから見えるoriginは本番と同じ`http://127.0.0.1:<port>`の1つにする。
    - Node.jsのプロセス（T26のサーバー）を唯一の入口にする。Viteはmiddlewareモードでこのプロセスに組み込み、UIを配信する。HMRのWebSocketも同じHTTPサーバーに載せる。Viteの単独の開発サーバー（別のポート）は、ブラウザから使わない。
    - トークン交換、API、HMRのWebSocketのupgradeは、本番と同じ検査（Host、`Sec-Fetch-Site`・`Origin`、cookie）を通る。別のoriginや別のポートからの直接の要求は、本番と同じく拒否する。
    - CORSや認証、Host・Originの検査を、開発時だけ無効にしない（試験用にトークンを注入できるようにはする）。
    - Viteの設定で外部へ公開しない（`server.host`の指定や`server.allowedHosts: true`を使わない）。Viteは既知の脆弱性を修正した版以上に固定する。
    - 本番の起動では、Node.jsのプロセスがビルド済みの静的ファイルを配信し、Viteを読み込まない。開発環境では合成データのデータルートだけを使い、実データのデータルートで起動しない。
11. **ログ:** 要求ログにURLのクエリ、cookie、要求本文、金額を出さない。
12. **URLと画面のタイトル:** ブラウザの履歴は同期されうるので、URLには不透明なIDだけを使い、金額・勤務先・氏名等を入れない。ページのタイトルも一般的な名前にする。
13. **静的ファイルの配信範囲:** 静的ファイルは、起動時に固定した1つの配信ルートの中からだけ返す。
    - 静的ファイルの応答（HTML、交換用のページ、JS・CSS等のアセット）にも`Cache-Control: no-store`を付け、ブラウザに再利用させない。originとportが同じままなので、キャッシュが残っていると、リリースを切り替えたあとに前の版のUIが新しいAPIと組み合わさり、ADR-0002の「配信物とリリースの対応」をブラウザ側で迂回してしまうため。ローカルの1人用アプリなので、毎回取得し直す負担は小さい。
    - URLのパスをデコードしてから正規化する。`..`のセグメント、エンコードされた区切り文字（`%2F`・`%5C`）、バックスラッシュ、NUL文字、ドライブ指定を含む要求は拒否する。
    - 候補のファイルの実体パス（symlinkやjunctionを解決したもの）が、配信ルートの実体パスの配下にあることを確かめてから返す。配下になければ拒否する。
    - ディレクトリの一覧は返さない。配信ルートにデータルートやrepoのほかの場所を指定させない。

### この境界で守らないもの

- 同じPCで、同じOSユーザーとして動く悪意あるプロセス。データルートのファイルを直接読めるので、HTTPの境界では守れない（ADR-0006）。
- cookieはポートで分離されない（RFC 6265 §8.5）。同じPCの`127.0.0.1`の別ポートで動くサービスは、ブラウザからこのcookieを受け取りうる。cookieの有効期間を1回の起動に限ることで影響を抑えるが、完全には防げない。開発中に信頼できないローカルサービスを同時に動かさない。
- 悪意のある、または権限の広いブラウザ拡張機能。ページの内容を読めるので、HTTPの境界では守れない。拡張機能を入れていない専用のブラウザプロファイルで使うことを手順書で勧める。

## 検討した候補

| 方式 | 判断 |
| --- | --- |
| loopback HTTP＋Host/Origin検証＋起動トークン（採用） | ブラウザ側の制限に頼らず、サーバー側だけで、cookieもトークンも持たない要求を拒否できる。他サイトのページ、DNS rebinding、起動出力を読めない他プロセスがこれに当たる。cookieを受け取りうる同じPCの別ポートのサービスと、同じOSユーザーで動く悪意あるプロセスは対象外（「この境界で守らないもの」） |
| loopback HTTPのみ（検証なし） | DNS rebindingやクロスサイト要求に弱い。採用しない |
| loopback HTTPS（自己署名証明書） | 証明書の導入と更新を利用者に課す。loopbackはsecure contextなので得るものが少ない |
| HTTPを使わないデスクトップシェル（Electron等のIPC） | ADR-0002で初期の配布方式として見送り。再評価するときはこのADRを置き換える |

ブラウザ側でも、公開サイトからloopbackへの要求を制限する仕組みが入りつつある。ChromeはLocal Network Accessの許可プロンプトを142から導入し、Firefoxにも企業向けポリシーがある。ただし、Chromeの対象にはWebSocketや、localhostからlocalhostへの要求が含まれていない。利用者が許可すれば通ってしまう点もある。そこで、本ADRの対策はブラウザ側の制限がなくても成り立つようにし、ブラウザ側の制限は追加の防御として扱う。

## 影響

- ブックマークしたURLだけでは開けない。起動時に開くURLを使う。cookieは起動ごとに無効になる。
- APIを同じoriginのUIからしか呼べないため、将来CLIや外部ツールから操作するには別の認証設計が必要。
- 開発時もトークン検査を無効化しない（テスト用に注入できるようにする）。

## 別タスクで行う検証

HTTPサーバーの骨格と境界検査は、T26（ローカルHTTPサーバーと安全境界）で実装する。T26は2026-10-02の所有者決定を受けて台帳に追加した（ADR README「所有者の決定」）。試験はT26で作り、T05で整えたCIとブラウザ試験の基盤（Playwright）で、Mac/Windows/Linuxの各OS上で実行する。ただし、開発時の構成（10）は、ViteをT26のサーバーに組み込むT08で試験する。T26は組み込み口（middlewareとWebSocketのupgradeを、同じ検査の後ろに載せる仕組み）を用意する。二重起動の防止（データルートのlock）は、起動処理にT07の成果物を組み込むT09で試験する。試験項目は次のとおり。

- 不正なHost（rebinding想定の別名）、Originなし・別Origin・`null` Origin、`Sec-Fetch-Site`が`cross-site`・`same-site`（別ポート）の要求、JSON以外の`Content-Type`が拒否される。
- 一時ファイルの権限が本人だけに限られること（macOSは`0600`、Windowsは本人だけのACL）。作成先に既存のファイルやsymlinkを置いた場合に作成が失敗すること。
- トークン交換のエンドポイントだけが、cookieなしで有効な1回限りのトークンを受け付ける。ほかのAPIはcookieなしでは拒否される。
- トークンなし・使用済みのトークン・別起動のcookieが拒否される。トークンがログ・サーバーへの要求のURL・交換後のURLに残らず、一時ファイルが削除される。
- 一時ファイルから開いたときに、対応ブラウザでcookieの交換が成功する。
- 交換のあとで戻る操作をしても、トークン付きのURLに戻らない。同じoriginへの要求の`Referer`にトークンが含まれない（`Referrer-Policy: no-referrer`が付いている）。
- 証憑の取込用エンドポイント以外は、JSON以外の要求を拒否する。APIの応答に`Cache-Control: no-store`が付く。
- `0.0.0.0`やIPv6で待ち受けていないこと、ポート使用中・二重起動の扱い。
- CSPで外部資源の読み込みが禁止されていること。
- 開発時の入口（T26のサーバーとViteのmiddleware）から開いたUIで、トークン交換と、状態を変える要求が成功すること。Viteの単独の開発サーバーや別のポートから直接送った要求は拒否されること。HMRのWebSocketのupgradeも、Host・Origin・cookieの検査を通ること（T08）。
- 開発時に、実際のCSSの変更とReactのコンポーネントの変更がHMRで反映されること。nonceのない、または値の合わないinlineのscript・styleは拒否されること。nonceが応答ごとに変わり、本番の応答のCSPにnonceが含まれないこと（T08）。
- 静的配信で、`..`、エンコードされた区切り文字（`%2F`・`%5C`・二重エンコード）、バックスラッシュ、配信ルート外を指すsymlink・junctionによる範囲外のファイルの取得が拒否されること。
- 静的ファイル（HTML・交換用のページ・アセット）の応答に`Cache-Control: no-store`が付くこと（T26）。リリースを切り替えて起動し直したあと、ブラウザが前の版のUIを使わないこと（T13）。

## 出典

確認日はすべて2026-10-02。

- Node.jsの`listen()`の既定値と`localhost`の名前解決: https://nodejs.org/api/net.html 、https://nodejs.org/api/dns.html
- Viteの開発サーバー（`allowedHosts`、`cors`、`localhost`の注意、middlewareモード、`server.ws`）: https://vite.dev/config/server-options 、https://vite.dev/config/server-options#server-middlewaremode 、https://vite.dev/guide/ssr#setting-up-the-dev-server
- Viteの脆弱性（CVE-2025-24010ほか）: https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6 、https://github.com/vitejs/vite/security/advisories
- Jupyter Serverの前例（Host検査、トークン、リダイレクトファイル）: https://jupyter-server.readthedocs.io/en/latest/operators/security.html 、https://jupyter-server.readthedocs.io/en/latest/other/full-config.html
- `Sec-Fetch-Site`とsiteの定義: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site 、https://developer.mozilla.org/en-US/docs/Glossary/Site
- CSRF対策: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- cookieがポートで分離されないこと: https://www.rfc-editor.org/rfc/rfc6265#section-8.5
- `SameSite`の判定と、移動を始めた文書（`file://`は不透明なorigin）: https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis 、https://html.spec.whatwg.org/multipage/browsing-the-web.html 、https://html.spec.whatwg.org/multipage/browsers.html#same-site 。リダイレクトの扱いは仕様の読解による推論なので、各ブラウザでの挙動は実装時に試験する
- CSP: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP
- ViteのCSPへの対応と`html.cspNonce`: https://vite.dev/guide/features#content-security-policy-csp 、https://vite.dev/config/shared-options#html-cspnonce
- secure context: https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts
- ChromeのLocal Network Access: https://developer.chrome.com/blog/local-network-access
- FirefoxのLocalNetworkAccessポリシー: https://firefox-admin-docs.mozilla.org/reference/policies/localnetworkaccess/
