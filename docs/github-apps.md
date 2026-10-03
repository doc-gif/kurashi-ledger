# AIのGitHub App（CodexとClaudeの身元）

2026-10-03の所有者決定（実装側のチャット。記録は[Issue #41](https://github.com/doc-gif/kurashi-ledger/issues/41)）。CodexとClaudeに、それぞれ1つずつGitHub Appを用意し、AIごとの別のGitHubの身元にした（2つとも、同じ日に所有者が作成・インストール済み）。トークンは自作のスクリプト`scripts/github-app-token.ts`で発行する。rulesetの変更は、Appが動くことを確かめたあとで所有者が確認する（下の「rulesetの提案」。**まだ設定していない**）。

## 背景

- いまは所有者とAIが同じGitHubアカウント（doc-gif）を使う。レビューはCOMMENTの記録（`decision: accepted`等）で、GitHub上の承認ではない。作者自身は自分のPRを承認できないので、承認を必須にすると誰もマージできない（[修正前の整合確認](review-prevention.md)）。
- 所有者は、2つ目のユーザーアカウントではなく、GitHub Appを選んだ。Appの承認は別の身元からのGitHubの正式な承認になるので、将来rulesetで「作者と別の身元による最新のpushの承認」を必須にし、レビューの分離を手続きだけでなくGitHubに強制させられる。
- ClaudeとCodexのどちらも、実装とレビューの両方を行う（例: PR #4はCodexが実装し、Claudeがレビューした）。そのため、Appは**役割ではなくAIの身元**を表す。分離は身元で行う: **AIは、自分が実装したPRや、自分がpushしたPRを承認しない**（[現在の状態](project-status.md)の「レビュー」、[PRレビューのループ](pr-review-loop.md)）。
- トークンの発行は、第三者のgh拡張ではなく、依存を加えない自作のスクリプトで行う（所有者の決定）。

## 所有者が用意したもの（2026-10-03）

IDと鍵はrepoに置かない。下の`<...>`は、実行するときに実際の値に置き換えるプレースホルダ。

| 項目 | Codex | Claude |
| --- | --- | --- |
| App | `<codexのAppの名前>`（作成済み） | `<claudeのAppの名前>`（作成済み） |
| インストール先 | このrepoだけ | このrepoだけ |
| App ID・Installation ID | 環境変数`KL_GITHUB_APP_ID_CODEX`・`KL_GITHUB_APP_INSTALLATION_ID_CODEX` | 環境変数`KL_GITHUB_APP_ID_CLAUDE`・`KL_GITHUB_APP_INSTALLATION_ID_CLAUDE` |
| 秘密鍵の置き場所 | macOSのログインキーチェーンの汎用パスワード。service `kurashi-ledger-codex-reviewer`、account `$USER`、値はPEMのbase64 | 同じ形。service `kurashi-ledger-claude-implementer` |

serviceの名前に入っている`reviewer`・`implementer`は、所有者が最初に登録したときの名前で、役割の意味を持たない。鍵を登録し直さずに使うため、スクリプトの既定にした（`--keychain-service`で変えられる）。

### Appの権限（2つとも同じ）

| 権限 | 水準 | 使う場面 |
| --- | --- | --- |
| Contents | Read and write | branchのpush、マージ |
| Pull requests | Read and write | PRの作成、レビュー（APPROVE等）、PRへのコメント |
| Issues | Read and write | Issueの作成・コメント |
| Actions | Read-only | CIの結果の確認 |
| Workflows | Read and write | `.github/workflows/`を変えるPRのpush |
| Metadata | Read-only | 必須（GitHubが自動で付ける） |
| Administration | **なし** | rulesetとrepoの設定を変えられないようにする |

webhookは使わない。インストールできるのは所有者のアカウントだけ（「Only on this account」）。

### 所有者が行ったこと

2026-10-03に、所有者が次を済ませた。

1. CodexのAppを作り、このrepoだけにインストールした。最初は Pull requests R/W・Contents R・Actions R・Metadata R で作り、そのあと上の表の権限に広げ（Settings → Permissions & events で Contents・Issues・Workflows を Read and write）、インストール先で権限の変更を承認し直した（Installed GitHub Apps → Configure → Review request）。
2. ClaudeのAppを、上の表と同じ権限・webhookなし・このアカウントだけにインストールできる、で作り、このrepoだけにインストールした。
3. 2つの秘密鍵を、キーチェーンのservice `kurashi-ledger-codex-reviewer`・`kurashi-ledger-claude-implementer`に登録し（下の「鍵の保管」）、2つのApp IDとInstallation IDを控えた（repoには書かない）。

残っているのは、下の「実際の鍵での確認」と「移行の計画」の2以降、rulesetの確認（所有者の確認待ち）。権限を変えるときは、上の1と同じく、インストール先での承認し直しが要る。

## 鍵の保管・再発行・失効

- 秘密鍵は、ログインキーチェーンの汎用パスワードにだけ置く。ダウンロードした`.pem`は、キーチェーンに登録したら消す。repo・worktree・クラウド・チャット・Issueに置かない。**鍵の控え（バックアップ）は要らない。** なくしたら、Appの設定で新しい鍵を作ればよい。
- 登録の例（所有者が手で行う。値は対話で入力し、コマンドの引数に鍵を書かない）: `base64 -i <ダウンロードした.pem>`の出力をコピーし、`security add-generic-password -U -s <service> -a "$USER" -w`を実行して、表示される入力欄に貼り付ける。そのあとクリップボードを消し、`.pem`を消す。
- **再発行（rotation）:** AppのSettings → General → Private keys → Generate a private key で新しい鍵を作り、上の手順でキーチェーンの値を置き換え（`-U`）、下の「実際の鍵での確認」で動くことを確かめてから、古い鍵を同じ画面で消す（Delete）。
- **失効:** 鍵が漏れた、または漏れた疑いがあれば、すぐにAppの設定で、その鍵を消す（消した鍵ではJWTを作れなくなる）。発行済みのinstallation access tokenは最長1時間有効なので、急ぐ場合はインストールを一時停止する（Installed GitHub Apps → Configure → Suspend）。漏れた鍵をIssue等に貼り直さない（[公開範囲と公開前の点検](public-data.md)の「誤って公開したとき」）。
- キーチェーンの項目は、作った`/usr/bin/security`に読取りを許すので、同じmacOSユーザーのプロセスは確認なしで読める（下の「限界」）。読まれたときに気づきたい場合は、キーチェーンアクセスで項目の「アクセス制御」を「キーチェーンのパスワードを要求」にできる。そのかわり、無人の定期実行は止まる。

## トークンの発行（scripts/github-app-token.ts）

```sh
GH_TOKEN="$(node scripts/github-app-token.ts --agent <codex|claude> --purpose <review|implement>)" gh <コマンド>
```

- `--agent`（必須）: どのAIのAppか。キーチェーンのserviceの既定と、IDを読む環境変数（上の表）を決める。IDは`--app-id`・`--installation-id`でも渡せる（環境変数より優先）。数字だけを受け付ける。
- `--purpose`（必須）: トークンを縮小する権限。Appがより多くの権限を持っていても、トークンは用途の分だけにする（最小権限）。どちらも`repositories: ["kurashi-ledger"]`に縮小する。

  | 用途 | 権限 | 使う場面 |
  | --- | --- | --- |
  | `review` | pull_requests:write、contents:read、actions:read | レビューの投稿（APPROVE・REQUEST_CHANGES・COMMENT）、PRへのコメント、差分とCIの確認 |
  | `implement` | contents:write、pull_requests:write、issues:write、actions:read、workflows:write | push、PR・Issue・コメントの作成、マージ |

  `review`にissues:writeを入れない理由: PRへのコメント（Issueのタイムラインのコメント）とレビューはpull_requests:writeで書ける。Issueへの書込みが要る作業は`implement`で行う。PRへのコメントがこの権限で拒否されることが分かったら、表（`scripts/lib/github-app-token.ts`の`PURPOSES`）を直すPRを出す（下の「確かめていないこと」）。
- 鍵の取り出し方（どれか1つ）: 既定はmacOSのキーチェーン（`/usr/bin/security find-generic-password -s <service> -a <ユーザー> -w`をシェルなしで呼び、base64をメモリの中で戻す）。`--keychain-service <名前>`でserviceを変えられる。`--key-file <パス>`はPEMのファイルで、macOS・Linuxでは所有者だけが読める権限（`chmod 600`）で所有者が実行中のユーザーでなければ拒み、symlinkも拒む。Windowsでは権限のビットがNTFSのACLを表さないので確かめず、注意を出す（ACLを所有者だけにしておく）。`--key-stdin`は標準入力からPEM（またはそのbase64）を読む（端末からは読まない）。
- 動き: RS256のJWT（`iat`=いま−60秒、`exp`=いま+9分、`iss`=App ID）を`node:crypto`で作り、`POST https://api.github.com/app/installations/<Installation ID>/access_tokens`で発行する。応答の権限とrepoが要求どおりか確かめる。さらに、発行したトークンで`GET /installation/repositories`を呼び、触れるrepoがこのrepoの1件だけかを確かめる。どれかが違う、または確かめられない（応答にrepoの一覧がない、HTTPや通信の失敗等）ときは、トークンを出さずに失効させ（`DELETE /installation/token`）、終了コード1で終える。
- 出力: 標準出力には、成功したときのトークンと改行だけを出す。エラーは標準エラーに、HTTPの状態とGitHubのメッセージを出す。鍵・JWT・トークンは出さない（既知の値と、数字を含む長い英数字の並びを伏せる）。終了コードは、成功0・発行の失敗1・引数の誤り2。
- 時間の上限: GitHubへの要求は15秒、キーチェーンは60秒（許可のダイアログに答える時間）。ディスクに書かない。依存は使わない（Node.jsの組込みだけ）。
- npm scriptにしない: `npm run`は標準出力に見出しを出すので、`$(...)`で受けるとトークンに混ざる。`node scripts/...`で直接実行する。
- トークンは1時間で失効する。シェルの設定ファイル・`.env`・ファイルに保存しない。続けて使うときはサブシェルで閉じる: `( export GH_TOKEN="$(node scripts/github-app-token.ts --agent codex --purpose review)"; gh ...; gh ... )`。
- 試験は`scripts/github-app-token.test.ts`（`npm test`）。試験の中で作ったRSA鍵と番兵の値だけを使い、ネットワークとキーチェーンを使わない。

## レビューの投稿（AppのトークンでGitHubのレビューにする）

本文は、いまの書式（[PRレビューのループ](pr-review-loop.md)の3）のまま。1行目は`<!-- kurashi-ledger:review:v1 -->`、`role:`は自分のAIのもの（Codexは`codex-reviewer`、Claudeは`claude-reviewer`）。**`role`のAIと、投稿したAppのAIが一致すること。**

| decision | GitHubのレビューの種類 |
| --- | --- |
| `accepted` | `APPROVE`。レビューしたheadの40文字のSHAを`commit_id`に指定する |
| `changes-requested` | `REQUEST_CHANGES`（または`COMMENT`） |
| `needs-owner` | `COMMENT` |

承認は、レビューしたheadにだけ行う。`gh pr review --approve`は、実行した時点のheadを承認するので、確認と承認の間にpushがあると、レビューしていないheadを承認しうる。そのため、`commit_id`を指定してAPIで送る。

```sh
( export GH_TOKEN="$(node scripts/github-app-token.ts --agent codex --purpose review)"
  gh api repos/doc-gif/kurashi-ledger/pulls/<番号> --jq '.head.sha + " " + .base.sha'   # 直前に再取得して、レビューしたhead/baseと同じか確かめる
  gh api -X POST repos/doc-gif/kurashi-ledger/pulls/<番号>/reviews -f commit_id=<レビューしたheadのSHA> -f event=APPROVE -F body=@<本文のファイル> --jq '.commit_id + " " + .state' )
```

応答の`commit_id`がレビューしたheadで、`state`が`APPROVED`であることを確かめる。違えば、そのレビューを`decision`の記録として使わない。`changes-requested`・`needs-owner`は、`event=REQUEST_CHANGES`・`event=COMMENT`で同じように送る（`gh pr review <番号> --comment --body-file <ファイル>`でもよい）。本文のファイルは、作業ディレクトリの外の一時の場所に置き、送ったら消す。

- **自分が実装した、または自分のAppでpushしたPRを承認しない。** GitHubは、PRの作者による承認を受け付けない。rulesetの「最新のpushの承認」は、最後にpushした身元の承認を数えない。それでも、規則として、AIは自分の差分を承認しない。
- rulesetを設定するまでは、Appの承認もマージの必須条件ではない。マージの条件は[AGENTS.md](../AGENTS.md)・[現在の状態](project-status.md)のまま（実装していない別の担当の`decision: accepted`等）。

## 実装側の操作（push・PR・コメント・マージ）

`--purpose implement`のトークンを使う。トークンを`.git/config`・remoteのURL・ファイルに書かない。

**push:** remoteはSSH（`git@github.com:...`）なので、そのまま`git push`すると所有者のSSHの鍵（doc-gif）でpushされる。Appの身元でpushするときは、HTTPSのURLを直接指定し、そのコマンドだけの資格情報のhelperでトークンを渡す。

```sh
GH_TOKEN="$(node scripts/github-app-token.ts --agent claude --purpose implement)" GIT_TERMINAL_PROMPT=0 \
  git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \
  push https://github.com/doc-gif/kurashi-ledger.git HEAD:refs/heads/<branch>
```

- 1つ目の`-c credential.helper=`で、macOSのキーチェーン等の既存のhelperを外す（トークンを保存させない）。helperは単一引用符で囲み、`$GH_TOKEN`をhelperの実行時に展開させる。
- URLを直接指定したpushは、`origin/<branch>`の追跡の参照を更新しないので、続けて`git fetch origin --prune`を実行する。

**PR・コメント・マージ:** ghは環境変数`GH_TOKEN`を優先する。

```sh
( export GH_TOKEN="$(node scripts/github-app-token.ts --agent claude --purpose implement)"
  gh pr create --draft --head <branch> --base main --title <タイトル> --body-file <本文のファイル>
  gh pr comment <番号> --body-file <引継ぎのファイル> )
```

マージも同じトークンで、AGENTS.mdの条件と`--match-head-commit`を守る（`gh pr merge <番号> --merge --match-head-commit <SHA>`）。`gh pr create`はpushしていないbranchをpushしようとするので、先に上の手順でpushしておく。

**commitの作者（任意。所有者が決める）:** 既定は変えない（いまのgitの設定のまま）。Appの身元を作者にしたい場合は、そのcommitだけ`git -c user.name='<appの名前>[bot]' -c user.email='<botのユーザーID>+<appの名前>[bot]@users.noreply.github.com' commit ...`とする。botのユーザーIDは`gh api 'users/<appの名前>[bot]' --jq .id`で分かる（App IDとは別）。

## 限界（強い隔離ではない）

- CodexとClaudeは同じmacOSユーザーで動く。2つのキーチェーンの項目、所有者のdoc-gifの資格情報（`gh auth`の管理者のトークン、SSHの鍵）は、同じユーザーのどのプロセスからも読める。AIは、自分のAppのトークンだけを使い、**ほかのAIの鍵を読まない**（実装担当がレビュー側の鍵を読まない、を含む）。doc-gifの資格情報を、Appのトークンの代わりに使わない（移行のあと）。
- そのため、これは**取り違えを防ぐもの**で、悪意や誤動作からの隔離ではない。AIが規則に反してほかの鍵や管理者の資格情報を使えば、GitHubはそれを止めない（doc-gifは管理者なので、rulesetそのものを変えられる）。
- より強くするには: AIごとに別のmacOSユーザー（キーチェーンとホームを分ける）で動かす、鍵を使う処理をクラウドの秘密の保管庫（GitHub Actionsのsecrets等）に移す、AIの環境からdoc-gifの管理者の資格情報を外す。どれも所有者の判断。
- CODEOWNERSの所有者にはAppを指定できない。下の提案は、Code Ownersのレビューではなく、承認の件数と最新のpushの承認で分離する。

## rulesetの提案（所有者の確認待ち）

**状態: 提案。どの設定も変えていない。** Appが実際に動くことを確かめたあとで、所有者が確認する。T23の「独立レビューを必須にする保護」（[修正前の整合確認](review-prevention.md)。PR #38で提案）の、別アカウントとCODEOWNERSの代わりになる形。

mainのbranch rulesetの「Require a pull request before merging」で:

1. Required approvals: **1**
2. Dismiss stale pull request approvals when new commits are pushed: **有効**
3. Require approval of the most recent reviewable push: **有効**
4. Bypass list: **空**（Repository adminも入れない）

必須のstatus check（`Quality gate`）と最新のbaseを求める設定は、T05の決定どおり別に扱う。

こうすると: PRの作者（実装したAIのApp）は自分のPRを承認できない。最後にpushした身元の承認は数えない。そのため、承認できるのは、もう一方のAIのApp（または所有者）だけになる。2つのAppはAdministrationを持たないので、Appのトークンではrulesetを変えられない。

### 迂回試験（設定したあとに行う）

合成の変更だけを使い、マージしない。各手順のコマンド・エラーの文・判定をIssue #41（またはその後継）に記録する。どれかが期待と違えば、強制ゲートとして扱わず、設定を直して1からやり直す。

1. mainから試験用のbranchを作り、文書の1行を変える合成のcommitを、ClaudeのApp（`--purpose implement`）でpushし、同じトークンでPRを作る。期待: PRの作者がClaudeのbotになる（`gh pr view <番号> --json author`）。
2. ClaudeのAppのトークンで`gh pr merge <番号> --merge`を実行する。期待: 承認がないので拒否される。
3. ClaudeのAppのトークンで、自分のPRを承認する（`commit_id`付きのAPI）。期待: 作者なので拒否される。
4. doc-gifの資格情報で`gh pr merge <番号> --merge --admin`を試す。期待: 迂回の一覧が空なので拒否される。
5. 両方のAppのトークン（`implement`と`review`）で、rulesetの変更（`gh api repos/doc-gif/kurashi-ledger/rulesets`の1件への`PATCH`）を試す。期待: 403等で拒否される。
6. CodexのAppで、レビューしたheadを承認する。期待: `reviewDecision`が`APPROVED`になる（`gh pr view <番号> --json reviewDecision,mergeStateStatus`）。**この手順で、Appの承認が必須の承認に数えられることを確かめる**（下の「確かめていないこと」）。
7. そのあと、ClaudeのAppで新しいcommitをpushする。期待: 承認が取り消され、再び拒否される。
8. CodexのAppで新しいcommitをpushし、CodexのAppで承認する。期待: 最新のpushをした身元なので、承認として数えられない。ClaudeのAppの承認で数えられる。
9. rulesetの「Rule insights」で、試験の間に迂回が記録されていないことを確かめる。PRは閉じ、試験用のbranchの削除は所有者が判断する。

## 確かめていないこと（推測しない）

次は、実際のAppで確かめるまで分からない。確かめたら、結果をIssue #41に書き、この節を直す。

- Appの承認が、rulesetの必須の承認に数えられるか（AppのContentsがRead and writeのとき）。上の迂回試験の6。
- Appが作者のPRで、Copilotの自動レビューのrulesetが動くか。
- Appのトークンで、Copilotのレビューを依頼できるか（`gh pr edit <番号> --add-reviewer @copilot`、またはAPIの`requested_reviewers`）。
- botが書いたコメント・レビューの`author_association`の値（`NONE`等になりうる）。
- T23の巡回（`tools/review_guard/patrol.py`、PR #38）の役割の判定への影響。巡回は`author_association`がOWNER・MEMBER・COLLABORATORの記録だけを読むので、botの記録を読まないおそれがある。
- `review`の権限（issues:writeなし）で、PRへのコメントを書けるか。
- Appがpushしたbranchで、CIが動くか（Appのトークンのpushはworkflowを起動するはずだが、未確認）。
- トークンの発行の応答に、縮小したrepoの一覧（`repositories`）が入るか。入らなければ、スクリプトは安全側に失敗する（トークンを出さない）。そのときは、一覧の代わりに`GET /installation/repositories`だけで確かめる形に直すPRを出す。

## 移行の計画

1. **実際の鍵で確かめる。** 所有者・Codex・Claudeが、下の「実際の鍵での確認」を、自分のAppで実行する。この文書を作った担当は、実際の鍵を読まず、実際のAppを呼んでいない。
2. **Claude側の作業を、ClaudeのAppのトークンに切り替える**（push・PR・コメント・マージ）。Codex側のレビューを、CodexのAppのトークンに切り替える。Claude側のレビューは、ClaudeのAppの`review`のトークンで行う。
3. **rulesetを所有者が確認して設定し、迂回試験を行う**（上の「rulesetの提案」）。
4. **T23の巡回の設定を、2つのbotのloginに合わせる**（[タスク台帳](implementation-tasks.md)のT23の後続）。`.review/patrol.json`で2つのbotのloginをAIに対応付け（コードに書かない）、役割は本文の印の`role:`から決めたまま、印のAIと投稿したbotのAIが一致するかを確かめ、違えば警告する。botの`author_association`の扱いも決める。

## 実際の鍵での確認

所有者またはそのAI自身が行う（この文書の担当は行っていない）。IDはプレースホルダを置き換える。トークンは表示しない。

```sh
GH_TOKEN="$(KL_GITHUB_APP_ID_CODEX=<CodexのApp ID> KL_GITHUB_APP_INSTALLATION_ID_CODEX=<CodexのInstallation ID> node scripts/github-app-token.ts --agent codex --purpose review)" gh api repos/doc-gif/kurashi-ledger --jq .full_name
```

`doc-gif/kurashi-ledger`と表示されれば、発行と縮小が動いている。Claudeは`--agent claude`と`KL_GITHUB_APP_ID_CLAUDE`・`KL_GITHUB_APP_INSTALLATION_ID_CLAUDE`で同じことを行い、`--purpose implement`でも確かめる。
