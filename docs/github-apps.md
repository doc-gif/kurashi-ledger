# AIのGitHub App（CodexとClaudeの身元）

2026-10-03の所有者決定（実装側のチャット。記録は[Issue #41](https://github.com/doc-gif/kurashi-ledger/issues/41)）。CodexとClaudeに、それぞれ1つずつGitHub Appを用意し、AIごとの別のGitHubの身元にした（2つとも、同じ日に所有者が作成・インストール済み）。トークンは自作のスクリプト`scripts/github-app-token.ts`が発行し、そのトークンで1つのコマンドを子プロセスとして実行する（トークンは表示しない）。mainのrulesetの承認の規則は、Appが動くことを確かめたあとで所有者が確認する（下の「ruleset」。**承認の規則はまだ設定していない**）。

## 背景

- いまは所有者とAIが同じGitHubアカウント（doc-gif）を使う。レビューはCOMMENTの記録（`decision: accepted`等）で、GitHub上の承認ではない。作者自身は自分のPRを承認できないので、承認を必須にすると誰もマージできない（[修正前の整合確認](review-prevention.md)）。
- 所有者は、2つ目のユーザーアカウントではなく、GitHub Appを選んだ。Appの承認は別の身元からのGitHubの正式な承認になるので、将来rulesetで「作者と別の身元による最新のpushの承認」を必須にし、レビューの分離を手続きだけでなくGitHubに強制させられる。
- ClaudeとCodexのどちらも、実装とレビューの両方を行う（例: PR #4はCodexが実装し、Claudeがレビューした）。そのため、Appは**役割ではなくAIの身元**を表す。分離は身元で行う: **AIは、自分が実装したPRや、自分がpushしたPRを承認しない**（[現在の状態](project-status.md)の「レビュー」、[PRレビューのループ](pr-review-loop.md)）。
- トークンの発行は、第三者のgh拡張ではなく、依存を加えない自作のスクリプトで行う（所有者の決定）。トークンを標準出力に出して`GH_TOKEN="$(…)"`で受ける形は、発行に失敗したときにghが保存済みのdoc-gif（管理者）の資格情報へ黙って戻るので使わない（PR42-R004）。所有者の決定で、スクリプトがコマンドを実行する形にした。

## 所有者が用意したもの（2026-10-03）

IDと鍵はrepoに置かない。下の`<...>`は、実行するときに実際の値に置き換えるプレースホルダ。

| 項目 | Codex | Claude |
| --- | --- | --- |
| App | `<codexのAppの名前>`（作成済み） | `<claudeのAppの名前>`（作成済み） |
| インストール先 | このrepoだけ | このrepoだけ |
| App ID・Installation ID | 環境変数`KL_GITHUB_APP_ID_CODEX`・`KL_GITHUB_APP_INSTALLATION_ID_CODEX` | 環境変数`KL_GITHUB_APP_ID_CLAUDE`・`KL_GITHUB_APP_INSTALLATION_ID_CLAUDE` |
| 秘密鍵の置き場所 | macOSのログインキーチェーンの汎用パスワード。service `kurashi-ledger-codex-reviewer`、account はmacOSのログイン名、値はPEMのbase64 | 同じ形。service `kurashi-ledger-claude-implementer` |

serviceの名前に入っている`reviewer`・`implementer`は、所有者が最初に登録したときの名前で、役割の意味を持たない。鍵を登録し直さずに使うため、スクリプトの既定にした（`--keychain-service`で変えられる）。accountは、スクリプトが`os.userInfo()`で調べるmacOSのログイン名を使う（環境変数`USER`ではない。ふつうは同じ。`sudo`等で違うと「項目がない」になる）。

### Appの権限（2つとも同じ）

| 権限 | 水準 | 使う場面 |
| --- | --- | --- |
| Contents | Read and write | branchのpush、マージ |
| Pull requests | Read and write | PRの作成、レビュー（APPROVE等）、PRへのコメント |
| Issues | Read and write | Issueの作成・コメント |
| Actions | Read-only | CIの結果の確認 |
| Checks | Read-only | CIの結果の確認（check run） |
| Commit statuses | Read-only | CIの結果の確認（commit status） |
| Workflows | Read and write | `.github/workflows/`を変えるcommitのpush（その用途のトークンにだけ付ける） |
| Metadata | Read-only | 必須（GitHubが自動で付ける） |
| Administration | **なし** | rulesetとrepoの設定を変えられないようにする |

webhookは使わない。インストールできるのは所有者のアカウントだけ（「Only on this account」）。

### 所有者が行ったこと

2026-10-03に、所有者が次を済ませた。

1. CodexのAppを作り、このrepoだけにインストールした。最初は Pull requests R/W・Contents R・Actions R・Metadata R で作り、そのあと Contents・Issues・Workflows を Read and write に広げ（Settings → Permissions & events）、インストール先で権限の変更を承認し直した（Installed GitHub Apps → Configure → Review request）。
2. ClaudeのAppを、同じ権限・webhookなし・このアカウントだけにインストールできる、で作り、このrepoだけにインストールした。
3. 同じ日の所有者決定（読み取りだけ足す）で、2つのAppに Checks と Commit statuses の Read-only を加え、インストール先で承認し直した。
4. 2つの秘密鍵を、キーチェーンのservice `kurashi-ledger-codex-reviewer`・`kurashi-ledger-claude-implementer`に登録し（下の「鍵の保管」）、2つのApp IDとInstallation IDを控えた（repoには書かない）。

残っているのは、下の「実際の鍵での確認」と「移行の計画」、rulesetの承認の規則の確認（所有者の確認待ち）。Appの権限を変えるときは、毎回インストール先での承認し直しが要る。

## 鍵の保管・再発行・失効

- 秘密鍵の保管場所は、ログインキーチェーンの汎用パスワードだけ。`--key-file`・`--key-stdin`は、キーチェーンを使えない環境（macOS以外）での一時的な受け渡しのためで、鍵をファイルとして置いたままにしない。ダウンロードした`.pem`は、キーチェーンに登録したら消す。repo・worktree・クラウド・チャット・Issueに置かない。**鍵の控え（バックアップ）は要らない。** なくしたら、Appの設定で新しい鍵を作ればよい。
- 登録の例（所有者が手で行う。値は対話で入力し、コマンドの引数に鍵を書かない）: `base64 -i <ダウンロードした.pem>`の出力をコピーし、`security add-generic-password -U -s <service> -a "$(id -un)" -w`を実行して、表示される入力欄に貼り付ける。そのあとクリップボードを消し、`.pem`を消す。クリップボードの履歴を残すアプリや、ほかのAppleの機器と共有する「ユニバーサルクリップボード」を使っていると、コピーした鍵がそこに残る・送られるので、登録の間は止める。
- **再発行（rotation）:** AppのSettings → General → Private keys → Generate a private key で新しい鍵を作り、上の手順でキーチェーンの値を置き換え（`-U`）、下の「実際の鍵での確認」で動くことを確かめてから、古い鍵を同じ画面で消す（Delete）。
- **失効:** 鍵が漏れた、または漏れた疑いがあれば、すぐにAppの設定で、その鍵を消す（消した鍵ではJWTを作れなくなる）。発行済みのinstallation access tokenは最長1時間有効なので、急ぐ場合はインストールを一時停止する（Installed GitHub Apps → Configure → Suspend）。漏れた鍵をIssue等に貼り直さない（[公開範囲と公開前の点検](public-data.md)の「誤って公開したとき」）。
- 公開検査（`npm run check:public`）は、PEMの見出しの行とGitHubのトークンの形を見るが、**base64にしたPEMやJWTは見つけない**。キーチェーンの値（base64）やJWTを、ファイル・Issue・ログに貼らない。
- `--key-file`の権限の検査は、POSIXの権限のビット（`chmod 600`）と所有者だけを見る。macOSの拡張ACL（`chmod +a`。`ls -le`で見える）でほかの利用者に読取りを許していても見抜けない。Windowsでは権限を確かめない（ACLを所有者だけにしておく）。

## 信頼した写し（PRのcheckoutから実行しない）

**このスクリプトを、PRのcheckout（レビュー中・作業中のbranch）から実行しない。** PRで変えられたスクリプトは、鍵を読み、トークンを別の宛先へ送れる。レビュー済みのmainのSHAから、repoの外へ取り出した写しで実行する。取り出す前に、そのSHAがmainに含まれることを確かめる。

```sh
sha=<レビュー済みのmainの40文字のSHA>
repo=<この repo の checkout>
git -C "$repo" fetch origin --prune && git -C "$repo" merge-base --is-ancestor "$sha" origin/main && echo "mainに含まれる"
dir="$HOME/.local/share/kurashi-ledger-app-token/$sha"
mkdir -p "$dir/lib" && chmod 700 "$dir"
git -C "$repo" cat-file blob "$sha:scripts/github-app-token.ts" > "$dir/github-app-token.ts"
git -C "$repo" cat-file blob "$sha:scripts/lib/github-app-token.ts" > "$dir/lib/github-app-token.ts"
printf '{"type":"module"}\n' > "$dir/package.json"
```

3行目で「mainに含まれる」と表示されなければ、取り出さない。以下の例では、この写しのディレクトリを`KL_APP_TOKEN_DIR`（秘密ではない）とする。`NODE_OPTIONS`は、スクリプトより先にほかのコードを読み込ませられるので、例ではすべて`env -u NODE_OPTIONS`で外して実行する。ghを使う例は、PRのcheckoutの外（例えば`$HOME`）をカレントディレクトリにし、`--repo`やAPIのパスでrepoを指定する。写しを新しくするのは、スクリプトの変更が独立したレビューを経てmainに入ったときだけ。**このスクリプトと`PURPOSES`（用途ごとの権限）の変更は、権限の制御の変更**で、実装していない別の担当のレビューを受ける。

## 使い方（スクリプトがコマンドを実行する）

```sh
env -u NODE_OPTIONS node "$KL_APP_TOKEN_DIR/github-app-token.ts" --agent <codex|claude> --purpose <用途> -- <コマンド> [引数…]
```

- `--agent`（必須）: どのAIのAppか。キーチェーンのserviceの既定と、IDを読む環境変数（上の表）を決める。IDは`--app-id`・`--installation-id`でも渡せる（環境変数より優先）。数字だけを受け付ける。
- `--purpose`（必須）: トークンを縮小する権限。Appがより多くの権限を持っていても、トークンは用途の分だけにする（最小権限）。どれも`repositories: ["kurashi-ledger"]`に縮小する。

  | 用途 | 権限 | 使う場面 |
  | --- | --- | --- |
  | `review` | pull_requests:write、contents:read、actions:read、checks:read、statuses:read | レビューの投稿（APPROVE・REQUEST_CHANGES・COMMENT）、PRへのコメント、差分とCIの確認 |
  | `implement` | contents:write、pull_requests:write、issues:write、actions:read、checks:read、statuses:read | push、PR・Issue・コメントの作成、マージ、CIの確認 |
  | `implement-workflows` | `implement`＋workflows:write | `.github/workflows/`のファイルを変えるcommitをpushするとき（所有者決定: 必要なときだけ付ける）。自分で変えていなくても、workflowの変更を含むmainを取り込んだmerge commitのpushや、`.github/workflows/`の変更を含むPRのbranchの更新（update-branch）には要る（未確認。下の「確かめていないこと」） |

  `review`にissues:writeを入れない理由: PRへのコメントとレビューはpull_requests:writeで書ける。Issueへの書込みが要る作業は`implement`で行う。
- `--`のあとが、実行するコマンドとその引数（シェルを通さない。パイプやリダイレクトが要るときは、子の出力を親のシェルで受ける）。コマンドは、**発行の前に**絶対パスへ解決する（PATHのうち絶対パスの場所だけを探し、相対パスの指定は受け付けない）。見つからなければ、発行せずに127で終える。Windowsでは`.exe`・`.com`だけを探し、`.cmd`・`.bat`（`npm.cmd`等）は実行できない。`gh`・`git`は実行できる。
- 子に渡してはいけないコマンド: `env`・`printenv`、`gh auth token`、`gh auth status --show-token`等、環境変数やトークンを表示するもの。子の環境の`GH_TOKEN`は、子が動いている間、同じmacOSユーザーの`ps eww`等からも見える（下の「限界」）。
- 鍵の取り出し方（どれか1つ）: 既定はmacOSのキーチェーン（`/usr/bin/security find-generic-password -s <service> -a <ログイン名> -w`をシェルなしで呼び、base64をメモリの中で戻す）。`--keychain-service <名前>`でserviceを変えられる。`--key-file <パス>`はPEMのファイルで、通常のファイルでないもの（symlink・FIFO・ディレクトリ）を開く前に拒み、macOS・Linuxでは所有者だけが読める権限（`chmod 600`）で所有者が実行中のユーザーでなければ拒む。`--key-stdin`は標準入力からPEM（またはそのbase64）を読む（端末からは読まない。このときコマンドには標準入力を渡さない）。
- 動き:
  1. RS256のJWT（`iat`=いま−60秒、`exp`=いま+9分、`iss`=App ID）を`node:crypto`で作り、`POST https://api.github.com/app/installations/<Installation ID>/access_tokens`で発行する。
  2. 応答の権限が要求と完全に一致し（GitHubが必ず加える`metadata: read`のほかは、多くも少なくもない）、repoがこのrepoの1件だけかを確かめる。さらに、発行したトークンで`GET /installation/repositories`を呼び、触れるrepoがこのrepoの1件だけかを確かめる。どれかが違う、または確かめられないときは、トークンを失効させ（`DELETE /installation/token`）、**コマンドを実行せずに**終える。
  3. 確認がすべて済んだときだけ、コマンドを子プロセスとして実行する。トークンは子の環境の`GH_TOKEN`にだけ置く。子の環境は次のようにする（試験で確かめた範囲）。
     - 外す: `GITHUB_TOKEN`・`GH_ENTERPRISE_TOKEN`等の資格情報、`GH_HOST`、`GH_DEBUG`、gitの資格情報・SSH・設定・trace（`GIT_TRACE*`・`GIT_CURL_VERBOSE`）に関わる変数、`NODE_OPTIONS`。`GIT_TRACE_REDACT=1`にする。
     - ghには、空の一時の設定ディレクトリ（`GH_CONFIG_DIR`。所有者だけが使える権限）を渡す。`HOME`も同じディレクトリにする。gitのlibcurlは、資格情報のhelperより前に`HOME`の`.netrc`（`_netrc`）を読むので、利用者の`.netrc`に所有者の資格情報があっても使わない（127.0.0.1の合成のサーバーで、親の環境では送られ、子の環境では送られないことを確かめた）。
     - gitは、利用者・システムの設定を読まない（`GIT_CONFIG_GLOBAL`を一時のディレクトリの中の存在しないファイル、`GIT_CONFIG_NOSYSTEM=1`。macOSの`credential.helper=osxkeychain`や利用者の`url.*.insteadOf`を使わない）。repoの設定（`.git/config`）は読まれるので、資格情報のhelperの一覧を空に戻し、`https://github.com/`と`https://github.com/doc-gif/kurashi-ledger.git`の`http.*.extraheader`を空にし、`core.askPass`を空にする（一時のrepoの設定に置いた値が使われないことを、実際のgitで確かめた）。repoの設定の`url.*.insteadOf`は外せないので、pushの前に確かめる（下の「push」）。
     - SSHを使えない（`GIT_SSH_COMMAND=false`）。端末に聞かない（`GIT_TERMINAL_PROMPT=0`）。`https://github.com`への資格情報としてだけ、`GH_TOKEN`を返すhelperを使う。
  4. 子が終わったら、一時の設定ディレクトリを消し、トークンを失効させる（失敗したら標準エラーに伝える。トークンは1時間で失効する）。失効の応答の401は、すでに無効なので成功と同じに扱う。
- シグナル: 発行の直前から失効が終わるまで、SIGINT・SIGTERM・SIGQUIT・SIGHUP・SIGBREAK（OSが受けられるもの）を受ける。子が動いていれば同じシグナルを子へ送り（SIGINTも）、子の終了を待つ。発行や確認の要求は中断する。トークンがあれば失効させてから、128+番号で終える。SIGKILL・強制終了・電源断では失効できない（トークンは1時間で失効する）。発行の要求の途中で中断した場合、GitHubが発行したトークンを受け取れず失効できないことがある（同じく1時間で失効する）。
- 出力: このスクリプト自身は標準出力に何も書かない（子の出力はそのまま見える）。エラーは標準エラーに、HTTPの状態とGitHubのメッセージを出す。鍵・JWT・トークンは出さない（既知の値と、数字を含む長い英数字の並びを伏せる）。
- 終了コード: 子の終了コード（シグナルで終わったら128+番号）。このスクリプト自身の失敗（引数の誤り・発行や確認の失敗）は125で、そのときコマンドは実行していない。コマンドを実行できなければ126、見つからなければ127。
- 時間の上限: GitHubへの各要求（発行・確認・失効）は15秒、キーチェーンは60秒（許可のダイアログに答える時間。シグナルでは中断しない）、標準入力の鍵は10秒。`--key-file`は、FIFO等で待たないよう、開く前に通常のファイルかを確かめ、待たずに開く。子のコマンドには上限を置かない。
- ディスク: トークン・鍵・JWTを書かない。ghの一時の設定ディレクトリ（所有者だけが使える権限で作る）は、子が終わったら消す。依存は使わない（Node.jsの組込みだけ）。npm scriptにはしない。
- 試験は`scripts/github-app-token.test.ts`（`npm test`）。試験の中で作ったRSA鍵と番兵の値だけを使い、ネットワークとキーチェーンを使わない。

**reviewのトークンで行わないこと:** pull_requests:writeは、レビューの投稿のほかに、PRの本文・タイトル・baseの変更、PRを閉じる・開き直す、レビューのdismiss、レビュワーの依頼もできる。レビュー側はこれらを行わない（レビューとPRへのコメントだけ）。

## レビューの投稿（AppのトークンでGitHubのレビューにする）

本文は、いまの書式（[PRレビューのループ](pr-review-loop.md)の3）のまま。1行目は`<!-- kurashi-ledger:review:v1 -->`、`role:`は自分のAIのもの（Codexは`codex-reviewer`、Claudeは`claude-reviewer`）。**`role`のAIと、投稿したAppのAIが一致すること。**

| decision | GitHubのレビューの種類 |
| --- | --- |
| `accepted` | `APPROVE`。レビューしたheadの40文字のSHAを`commit_id`に指定する |
| `changes-requested` | `REQUEST_CHANGES`（または`COMMENT`） |
| `needs-owner` | `COMMENT` |

承認は、レビューしたheadにだけ行う。`gh pr review --approve`は、実行した時点のheadを承認するので、確認と承認の間にpushがあると、レビューしていないheadを承認しうる。そのため、`commit_id`を指定してAPIで送る。直前に、head/baseがレビューしたものと同じかを確かめる。

```sh
env -u NODE_OPTIONS node "$KL_APP_TOKEN_DIR/github-app-token.ts" --agent codex --purpose review -- gh api repos/doc-gif/kurashi-ledger/pulls/<番号> --jq '.head.sha + " " + .base.sha'
env -u NODE_OPTIONS node "$KL_APP_TOKEN_DIR/github-app-token.ts" --agent codex --purpose review -- gh api -X POST repos/doc-gif/kurashi-ledger/pulls/<番号>/reviews -f commit_id=<レビューしたheadのSHA> -f event=APPROVE -F body=@<本文のファイル> --jq '.user.login + " " + .commit_id + " " + .state'
```

2つ目の出力が`<codexのAppの名前>[bot] <レビューしたheadのSHA> APPROVED`であることを確かめる。投稿者が自分のAppのbotでない（doc-gif等）、`commit_id`が違う、のどれかなら、そのレビューを`decision`の記録として使わず、所有者に知らせる（自分で取り消そうとしない）。`changes-requested`・`needs-owner`は、`event=REQUEST_CHANGES`・`event=COMMENT`で同じように送り、同じく投稿者を確かめる。本文のファイルは、作業ディレクトリの外の一時の場所に置き、送ったら消す。ClaudeがレビューするときはClaudeのApp（`--agent claude --purpose review`）で行う。

- **自分が実装した、または自分のAppでpushしたPRを承認しない。** GitHubは、PRの作者による承認を受け付けない。rulesetの「最新のpushの承認」は、最後にpushした身元の承認を数えない。それでも、規則として、AIは自分の差分を承認しない（下の「ruleset」の前提を参照）。
- rulesetの承認の規則を設定するまでは、Appの承認もマージの必須条件ではない。マージの条件は[マージ条件の正本](github-agent-operations.md#merge-conditions)のまま（Copilotの利用枠不足のときの暫定条件も、そこに従う）。

## 実装側の操作（push・PR・コメント・マージ）

`--purpose implement`（`.github/workflows/`を変えるcommitのpushだけ`implement-workflows`）を使う。

**push:** 自分のworktree（PRのcheckoutではなく、自分が作業しているもの）をカレントディレクトリにして行う。remote `origin`はSSHなので、子の中では使えない（SSHはdoc-gifの鍵になるので、子では`GIT_SSH_COMMAND=false`で止める）。HTTPSのURL（利用者名なし）を直接指定する。repoの設定は子でも読まれるので、先に、子と同じ環境で、資格情報・URLの書換え・headerに関わる設定を表示して確かめる。

```sh
env -u NODE_OPTIONS node "$KL_APP_TOKEN_DIR/github-app-token.ts" --agent claude --purpose review -- git config --includes --get-regexp '^(url\.|http\..*extraheader|credential\.|core\.(sshcommand|askpass))'
env -u NODE_OPTIONS node "$KL_APP_TOKEN_DIR/github-app-token.ts" --agent claude --purpose implement -- git push https://github.com/doc-gif/kurashi-ledger.git HEAD:refs/heads/<branch>
env -u NODE_OPTIONS node "$KL_APP_TOKEN_DIR/github-app-token.ts" --agent claude --purpose implement -- gh api 'repos/doc-gif/kurashi-ledger/activity?ref=refs/heads/<branch>&per_page=1' --jq '.[0].actor.login + " " + .[0].after'
```

1つ目の出力が、スクリプトが設定した次の5行だけ（順は問わない）であることを確かめる: `credential.helper`（空）、`credential.https://github.com.helper !f() …`、`http.https://github.com/.extraheader`（空）、`http.https://github.com/doc-gif/kurashi-ledger.git.extraheader`（空）、`core.askpass`（空）。`url.`で始まる行や、ほかの値があれば、pushしない（repoの設定を直すか、所有者に知らせる）。
最後の出力が`<claudeのAppの名前>[bot] <pushしたcommitのSHA>`であることを確かめる（pushした身元の確認）。URLを直接指定したpushは`origin/<branch>`の追跡の参照を更新しないので、続けて`git fetch origin --prune`を実行する。

**PR・コメント・マージ:**

```sh
env -u NODE_OPTIONS node "$KL_APP_TOKEN_DIR/github-app-token.ts" --agent claude --purpose implement -- gh pr create --repo doc-gif/kurashi-ledger --draft --head <branch> --base main --title <タイトル> --body-file <本文のファイル>
env -u NODE_OPTIONS node "$KL_APP_TOKEN_DIR/github-app-token.ts" --agent claude --purpose implement -- gh pr view <番号> --repo doc-gif/kurashi-ledger --json author --jq .author.login
env -u NODE_OPTIONS node "$KL_APP_TOKEN_DIR/github-app-token.ts" --agent claude --purpose implement -- gh pr comment <番号> --repo doc-gif/kurashi-ledger --body-file <引継ぎのファイル>
```

PRの作者が自分のAppのbotであることを2つ目で確かめる。マージも同じ用途のトークンで、AGENTS.mdの条件と`--match-head-commit`を守る（`… -- gh pr merge <番号> --repo doc-gif/kurashi-ledger --merge --match-head-commit <SHA>`）。`gh pr create`はpushしていないbranchをpushしようとするので、先に上の手順でpushしておく。

**commitの作者（任意。所有者が決める）:** 既定は変えない（いまのgitの設定のまま。commitは子の外で作る）。Appの身元を作者にしたい場合は、そのcommitだけ`git -c user.name='<appの名前>[bot]' -c user.email='<botのユーザーID>+<appの名前>[bot]@users.noreply.github.com' commit ...`とする。botのユーザーIDは`gh api 'users/<appの名前>[bot]' --jq .id`で分かる（App IDとは別）。

## 限界（強い隔離ではない）

- CodexとClaudeは同じmacOSユーザーで動く。**同じユーザーで動くコード（試験、依存のパッケージ、手元で実行したPRのコード等）は、2つのキーチェーンの項目を確認なしで読める**（項目は`/usr/bin/security`に読取りを許しているため）。所有者のdoc-gifの資格情報（`gh auth`の管理者のトークン、SSHの鍵）も同じ。AIは、自分のAppだけを使い、**ほかのAIの鍵を読まない**。doc-gifの資格情報を、Appの代わりに使わない（移行のあと）。
- スクリプトは、起動したシェルの環境変数（`PATH`・`HOME`等）とカレントディレクトリを信頼する。同じユーザーのプロセスが環境やPATHの中身を変えれば、別のコマンドを実行させられる。子の環境の`GH_TOKEN`は、子が動いている間、同じユーザーの`ps eww`等で見える。
- そのため、これは**取り違えを防ぐもの**で、悪意や誤動作からの隔離ではない。AIが規則に反してほかの鍵や管理者の資格情報を使えば、GitHubはそれを止めない（doc-gifは管理者なので、rulesetそのものを変えられる）。
- このスクリプトと`PURPOSES`の変更は、権限の制御の変更で、独立したレビューを要する。T23の巡回の保護対象（`policy_paths`）に、このスクリプトを加えることを後続にした（[タスク台帳](implementation-tasks.md)のT23）。
- より強くする選択肢（所有者の判断。いまは採っていない）: AIごとに別のmacOSユーザーで動かす（キーチェーンとホームを分ける）、キーチェーンの項目のアクセス制御を「キーチェーンのパスワードを要求」にする（無人の定期実行は止まる）、AIの環境からdoc-gifの管理者の資格情報を外す。鍵をGitHub Actionsに置く場合は、repoのsecretsではなく、保護の規則（必須のレビュワー等）を付けたenvironmentのsecretsにする（PRのworkflowから読めないようにする）。
- CODEOWNERSの所有者にはAppを指定できない。下の提案は、Code Ownersのレビューではなく、承認の件数と最新のpushの承認で分離する。

## ruleset

**いまの設定（2026-10-03）:** mainのbranch ruleset（`Required CI for main`、id 24409165、対象はdefault branch、迂回の一覧は空）に、必須のstatus check（`Quality gate`）のほか、**削除の制限（deletion）と強制pushの禁止（non_fast_forward）**がある。後の2つは、所有者の承認（「今すぐ足す」）を受けて、同じ日に調整係が加えた。

**提案（所有者の確認待ち。まだ設定していない）:** 同じrulesetの「Require a pull request before merging」で:

1. Required approvals: **1**
2. Dismiss stale pull request approvals when new commits are pushed: **有効**
3. Require approval of the most recent reviewable push: **有効**
4. Bypass list: **空**のまま（Repository adminも入れない）

こうすると、PRの作者は自分のPRを承認できず、最後にpushした身元の承認は数えない。**ただし、「承認できるのはもう一方のAIのAppか所有者だけ」になるのは、AIのpushとPRの作成が、すべてそのAIのAppの身元で行われるときだけ。** AIがdoc-gifの資格情報（SSHの`origin`、保存済みの`gh auth`）でpushしたりPRを作ったりすると、作者と最後のpushはdoc-gifになり、同じAIのAppでも承認できてしまう（自分の差分の承認）。GitHubはこれを止めない。緩和策（所有者の選択肢）:

- 移行のあと、AIはpush・PRの作成を、この文書の子プロセスの形でだけ行う（規則）。
- AIのworktreeで、doc-gifの資格情報でのpushが失敗するようにする: 例えば、worktreeごとの設定（`extensions.worktreeConfig`。repoの設定を変えるので所有者が判断）で`remote.origin.pushurl`を資格情報のないHTTPSのURLにし、helperを空にする。
- T23の巡回で、作者や最後のpushがAppのbotでないPRと、作者や最後のpushと同じAIのAppの承認を、警告として出す（[タスク台帳](implementation-tasks.md)のT23の後続）。

2つのAppはAdministrationを持たないので、Appのトークンではrulesetを変えられない。

### 迂回試験（承認の規則を設定したあとに行う）

**mainへマージしない。mainのrulesetを変えない。** 試験は`ruleset-test/**`のbranchと、そのための**試験用のruleset**だけで行う: 所有者が、mainのrulesetと同じ規則（承認の規則を含む）で、対象を`ruleset-test/**`だけにしたbranch rulesetを別に作り、`ruleset-test/base`をmainから作る。手順の4・5（doc-gifの部分）・9・10（doc-gifの部分）は所有者が行う。合成のcommitで`.github/workflows/`を変えるときは、workflowを起動しない内容にする（`on:`のない、またはどのイベントにも当たらない合成のファイル）。試験のPRはすべて`ruleset-test/base`を対象にする。マージを試すときは`--match-head-commit`を付ける。rulesetの変更の試みは、APIが定める`PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}`で（このパスに定められたメソッドはGET・PUT・DELETEで、PATCHはない）、**試験用のruleset**に対して、GETで読んだ値と同じ内容を送る（読取り専用の項目を除いたbody）。PUTの前に、GETで読んだ内容で、対象のrulesetのidが24409165（mainのruleset）でなく、対象の条件が`ruleset-test/**`だけであることを確かめる。拒否されること（403）を確かめる。万一受け付けられても、同じ内容なので規則は変わらず、mainのrulesetには触れない。各手順のコマンド・エラーの文・判定をIssue #41（またはその後継）に記録する。どれかが期待と違えば、強制ゲートとして扱わず、設定を直して1からやり直す。

1. ClaudeのApp（`implement`）で、`ruleset-test/claude-1`に合成のcommit（文書の1行）をpushし、`ruleset-test/base`へのPRを作る。期待: 作者がClaudeのbot。
2. ClaudeのAppで`gh pr merge <番号> --merge --match-head-commit <SHA>`。期待: 承認がないので拒否。
3. ClaudeのAppで自分のPRを承認（`commit_id`付きのAPI）。期待: 作者なので拒否。
4. doc-gifで`gh pr merge <番号> --merge --admin --match-head-commit <SHA>`。期待: 迂回の一覧が空なので拒否。
5. 2つのApp（全用途）で、試験用のrulesetへの同じ内容のPUT（`… -- gh api -X PUT repos/doc-gif/kurashi-ledger/rulesets/<試験用のrulesetのid> --input <GETで読んだ同じ内容のファイル>`）。期待: 403。あわせて、doc-gifで同じPUTが200になることを確かめ（同じ内容なので変化なし）、403が権限の不足によるものだと分かるようにする。
6. CodexのApp（`review`）で、レビューしたheadを承認。期待: `reviewDecision`が`APPROVED`（`gh pr view <番号> --json reviewDecision,mergeStateStatus`）。**Appの承認が必須の承認に数えられることを、ここで確かめる。** マージはしない。
7. ClaudeのAppで新しいcommitをpush。期待: 承認が取り消され、再び拒否。
8. CodexのAppで新しいcommitをpushし、CodexのAppで承認。期待: 最新のpushをした身元なので数えられない。ClaudeのAppの承認なら数えられる。
9. **doc-gifでpushしてPRを作り、同じAI（例えばClaude）のAppで承認する。** 期待（前提の限界の確認）: GitHubは承認を数える。結果を記録し、上の緩和策を所有者が選ぶ材料にする。
10. 2つのAppとdoc-gifで、`ruleset-test/base`の削除（`git push <HTTPSのURL> --delete ruleset-test/base`）と強制push（`--force`）を試す。期待: 拒否。
11. 試験用のrulesetの「Rule insights」で、試験の間に迂回が記録されていないことを確かめる。PRは閉じる。片付けは所有者が、試験用のrulesetを先に、branchを後に消す（rulesetが削除を止めるため）。試験の結果をmainのrulesetへ当てはめるのは、2つのrulesetの規則が同じであることを、GETで読んだ内容で確かめてから。

## 確かめていないこと（推測しない）

次は、実際のAppで確かめるまで分からない。確かめたら、結果をIssue #41に書き、この節を直す。

- Appの承認が、rulesetの必須の承認に数えられるか（迂回試験の6）。
- Appが作者のPRで、Copilotの自動レビューのrulesetが動くか。Appのトークンで、Copilotのレビューを依頼できるか。
- botが書いたコメント・レビューの`author_association`の値（`NONE`等になりうる）と、T23の巡回（PR #38）の役割の判定への影響。巡回は`author_association`がOWNER・MEMBER・COLLABORATORの記録だけを読むので、botの記録を読まないおそれがある。
- `review`の権限（issues:writeなし）で、PRへのコメントを書けるか。
- `checks:read`・`statuses:read`で、`gh pr checks`等のCIの結果を読めるか。`actions:read`だけで足りるなら、表を縮める。
- GitHubが、要求していない権限を暗黙に加えることがあるか。加えた場合、スクリプトは完全一致の照合で失敗する（コマンドは実行しない）。そのときは表を直すか、所有者に判断を求める。
- トークンの形: installation tokenは不透明な資格情報として扱う。GitHubは2026-04-27から、従来の40文字の形に加えて、stateless の形（`ghs_<App ID>_<JWT>`。JWTの区切りの`.`を含み、長い）を段階的に導入している（[GitHubのdocsの説明](https://github.com/github/docs/blob/main/data/reusables/apps/ghs-stateless-token-format.md)、[トークンの形の一覧](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github#githubs-token-formats)）。スクリプトは、接頭辞`ghs_`、使う文字（英数字と`. _ -`）、長さ（40〜8192文字）だけを確かめる。この範囲を外れる形が実際に出たら、スクリプトは安全側に失敗する（コマンドを実行しない）。
- 発行の応答に、縮小したrepoの一覧（`repositories`）が入るか。入らなければ、スクリプトは安全側に失敗する。そのときは`GET /installation/repositories`だけで確かめる形に直すPRを出す。
- Appがpushしたbranchで、CIが動くか。
- Windowsの実機で、Ctrl+C・Ctrl+Breakを受けたときに子へ転送し、失効させてから終わるか（CIではWindowsでシグナルを送れないので、シグナルを注入した試験だけで確かめている）。
- statelessの形のトークンも、`DELETE /installation/token`で失効するか（下の「実際の鍵での確認」の失効の確認）。
- `implement`のトークン（workflowsなし）で、workflowの変更を含むmainを取り込んだmerge commitをpushできるか。`gh pr merge`・update-branch（`gh pr update-branch`、`PUT /pulls/{番号}/update-branch`）を、workflowの変更を含むPRで行えるか。
- `repos/…/activity`（pushした身元の確認）を、このトークンで読めるか。読めなければ、PRのtimelineで確かめる手順に直す。
- 権限の外の書込みが、bodyの検証より前に403で拒まれるか（下の「実際の鍵での確認」の否定の確認の前提）。

## 移行の計画

1. **実際の鍵で確かめる**（下の「実際の鍵での確認」。肯定と否定の両方）。この文書を作った担当は、実際の鍵を読まず、実際のAppを呼んでいない。
2. **Appが作者のPRに進む前に、次を済ませる:** (a) Appが作者の合成のDraft PR（マージしない）で、Copilotの自動レビューと依頼が動くかを確かめる。(b) T23の巡回の後続（[タスク台帳](implementation-tasks.md)のT23）を済ませる。
3. **作業をAppに切り替える。** Claude側のpush・PR・コメント・マージをClaudeのApp、Codex側の作業をCodexのAppで行い、レビューは各AIのAppの`review`で行う。
4. **rulesetの承認の規則を所有者が確認して設定し、迂回試験を行う**（上の「ruleset」）。

## 実際の鍵での確認

所有者またはそのAI自身が、信頼した写しで行う（この文書の担当は行っていない）。IDの環境変数を設定してから実行する。トークンは表示されない。

肯定（インストールのトークンでしか成功しない。repoはpublicなので、`repos/doc-gif/kurashi-ledger`の取得では確かめにならない）:

```sh
env -u NODE_OPTIONS node "$KL_APP_TOKEN_DIR/github-app-token.ts" --agent codex --purpose review -- gh api /installation/repositories --jq '.total_count, [.repositories[].full_name]'
```

期待: `1`と`["doc-gif/kurashi-ledger"]`。`--agent claude`、`--purpose implement`・`implement-workflows`でも同じ。

失効（statelessの形のトークンでも失効するか）。子の中で失効させてから、同じトークンで要求する:

```sh
env -u NODE_OPTIONS node "$KL_APP_TOKEN_DIR/github-app-token.ts" --agent codex --purpose review -- sh -c 'gh api -X DELETE /installation/token && gh api /installation/repositories'
```

期待: 2つ目の要求が`HTTP 401`で失敗する。スクリプト自身の失効は401（すでに無効）になり、注意を出さずに終える。

否定（権限の外の書込みが拒まれること。bodyをわざと無効にしてあるので、権限があっても何も作られず422になる。2xxが出たら、すぐに所有者に知らせる）:

| 確かめること | コマンドの`--`のあと | `review`で期待 | `implement`で期待 |
| --- | --- | --- | --- |
| contentsの書込み | `gh api -X POST repos/doc-gif/kurashi-ledger/git/refs -f ref=refs/heads/kl-app-token-negative-check -f sha=0000000000000000000000000000000000000000` | 403 | 422 |
| issuesの書込み | `gh api -X POST repos/doc-gif/kurashi-ledger/issues -f title=` | 403 | 422 |
| administration | `gh api -X POST repos/doc-gif/kurashi-ledger/rulesets -f name=` | 403 | 403 |

ghはHTTPの状態を標準エラーに出す（例: `HTTP 403`）。workflowsの有無（`implement`と`implement-workflows`の違い）は、`.github/workflows/`を変える合成のcommitを`ruleset-test/**`のbranchへpushして確かめる（`implement`では拒否、`implement-workflows`では成功）。
