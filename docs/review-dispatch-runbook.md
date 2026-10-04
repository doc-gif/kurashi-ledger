# レビュー受付の導入手順（start-small）

所有者がMacで、レビュー受付をstart-smallのactiveにする手順。

**範囲（[所有者決定 start-small](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5977629581)）:** 対象のPRは1件、必要なreviewerはClaudeの1者、修正は手動、マージは所有者。[18](#18-広げる前に測る)の値を見てから広げる。

規則の正本: 切替とrollbackは[PR書式](pr-review-loop.md#受付がactiveのpr)、マージは[運用規約](github-agent-operations.md#dispatch-active)、部品は[実装](review-dispatch-implementation.md)、隔離の層は[設計§7](review-dispatch-design.md#7-workerの隔離と往復上限)。

コマンドは`zsh -i`に貼る。`(`〜`)`の中の確認行は、条件が欠ければ理由を表示してそのブロックを止める。Nodeの`ExperimentalWarning`の行は無視してよい。

## 0. 変数

毎回、最初に貼る。編集するのは最初の3行だけ。

```zsh
setopt interactive_comments
cd "$HOME"
target_pr=0     # 対象のPR番号。Codexが実装したPR（Claudeがレビューする）
port=8787       # 受け口のport。1024〜65535で443以外
tunnel_host=''  # 10のB（名前付きトンネル）を選んだときのホスト名。Aなら空
repo_slug=doc-gif/kurashi-ledger
base="$HOME/.local/share/kurashi-dispatch"
root="$base/root" etc="$base/etc" secrets="$base/secrets" runs="$base/runs" config="$base/claude-config" logs="$base/log"
policy="$etc/policy.json" install="$etc/install.json"
token_file="$secrets/claude-token" secret_file="$secrets/webhook-secret"
sha="$(cat "$etc/copy-sha" 2>/dev/null)"
copy="$base/copy-${sha}"
node_bin="$(cd "$copy" 2>/dev/null && mise which node 2>/dev/null)"
python_bin="$(cd "$copy" 2>/dev/null && mise which python 2>/dev/null)"
gh_bin="$(command -v gh)"
claude_exe="$(command -v claude)"; claude_exe="${claude_exe:A}"
claude_ver="$("$claude_exe" --version 2>/dev/null | awk '{print $1}')"
agents="$HOME/Library/LaunchAgents" label=local.kurashi-ledger.dispatch gui="gui/$(id -u)"
dispatch=("$node_bin" "$copy/scripts/review-dispatch.ts")
daemon=("$python_bin" "$copy/tools/review_dispatch/supervisor.py" daemon --root "$root" --)
kl_mode() { "$node_bin" -e 'const fs = require("fs"); const [f, mode] = process.argv.slice(1); const p = JSON.parse(fs.readFileSync(f, "utf8")); p.mode = mode; p.revision = "start-small-" + Date.now(); p.readyAfter = Date.now(); fs.writeFileSync(f + ".new", JSON.stringify(p, null, 1) + "\n", { mode: 0o600, flag: "wx" }); fs.renameSync(f + ".new", f); console.log(p.mode, p.revision);' "$policy" "$1"; }
print -r -- "PR=${target_pr} 写し=${sha:-未作成} node=${node_bin:-なし} python=${python_bin:-なし} claude=${claude_ver:-なし}"
```

期待: 1行。手順2の前は`写し=未作成`、`node=なし`。

## 1. 前提を確かめる

```zsh
(
  autoload -Uz is-at-least
  command -v mise >/dev/null || { echo "miseがない（docs/development.md）"; exit 1; }
  [[ -n $gh_bin ]] || { echo "ghがない"; exit 1; }
  command -v cloudflared >/dev/null || { echo "cloudflaredがない: brew install cloudflared"; exit 1; }
  xcode-select -p >/dev/null 2>&1 || { echo "Command Line Toolsがない: xcode-select --install"; exit 1; }
  [[ -n $claude_exe && $claude_exe != *' '* ]] || { echo "Claude Codeのネイティブ版を、空白のないパスに入れる"; exit 1; }
  file -b "$claude_exe" | grep -q Mach-O || { echo "claudeが実行ファイルでない（npm版は使えない）"; exit 1; }
  is-at-least 2.1.268 "$claude_ver" || { echo "Claude Codeが古い: ${claude_ver}"; exit 1; }
  [[ -n $KL_GITHUB_APP_ID_CODEX && -n $KL_GITHUB_APP_INSTALLATION_ID_CODEX && -n $KL_GITHUB_APP_ID_CLAUDE && -n $KL_GITHUB_APP_INSTALLATION_ID_CLAUDE ]] || { echo "AppのIDの環境変数がない（docs/github-apps.md）"; exit 1; }
  echo "前提OK"
)
```

期待: `前提OK`。

## 2. 専用の場所と信頼した写しを作る

[信頼した写し](github-apps.md#信頼した写しprのcheckoutから実行しない)と同じ規則で、木全体をrepoの外へ取り出す。

```zsh
(
  umask 077
  mkdir -p "$root" "$etc" "$secrets" "$runs" "$config" "$logs" && chmod 700 "$base" "$root" "$etc" "$secrets" "$runs" "$config" "$logs" || exit 1
  src="$(mktemp -d)"; trap 'rm -rf "$src"' EXIT
  git clone --quiet --no-checkout "https://github.com/${repo_slug}.git" "$src/repo" || exit 1
  new="$(git -C "$src/repo" rev-parse origin/main)"
  git -C "$src/repo" merge-base --is-ancestor dbf17492bb276d5102c50b3e4f04e1b14871e7d1 "${new}" || { echo "mainに#56がない"; exit 1; }
  git -C "$src/repo" cat-file -e "${new}:tools/review_dispatch/launchd/cycle.plist.in" 2>/dev/null || { echo "mainにlaunchdの雛形がない"; exit 1; }
  test -e "$base/copy-${new}" || { mkdir "$base/copy-${new}" && git -C "$src/repo" archive "${new}" | tar -x -C "$base/copy-${new}" && chmod -R go-rwx "$base/copy-${new}"; } || exit 1
  (cd "$base/copy-${new}" && mise install --quiet) || exit 1
  print -r -- "${new}" > "$etc/copy-sha"
  echo "写し: ${new}"
)
```

期待: `写し:`と40文字のSHA。続けて0を貼り直し、`node=`と`python=`にパスが出ることを確かめる。

## 3. setup-tokenを置く

Claudeの購読の長期トークン（1年）を作る。ブラウザでログインする。

```zsh
claude setup-token
```

期待: 長いトークンが表示される。次で貼り付ける（入力は表示されない）。

```zsh
(
  umask 077
  IFS= read -rs 'tok?トークンを貼り付けてEnter: ' || exit 1
  print -r -- "$tok" > "$token_file" && echo && ls -le "$token_file"
)
```

期待: `-rw-------`の1行で、ACLの行がない。⌘Kで画面のトークンを消す。期限が切れたら、この手順をやり直す。

## 4. policyを作る（shadow）

所有者だけが書けるrepo外のファイル。形は[model.ts](../scripts/lib/review-dispatch/model.ts)の`Policy`が正本。

```zsh
(
  umask 077
  (( target_pr > 0 )) || { echo "0のtarget_prを直す"; exit 1; }
  test -e "$policy" && { echo "policyは作成済み"; exit 1; }
  repo_id="$(gh api "repos/${repo_slug}" --jq .id)" && owner_id="$(gh api users/doc-gif --jq .id)" || exit 1
  codex_id="$(gh api 'users/kurashi-ledger-codex[bot]' --jq .id)" && claude_id="$(gh api 'users/kurashi-ledger-claude[bot]' --jq .id)" || exit 1
  cat > "$policy" <<EOF
{
 "revision": "start-small-1",
 "readyAfter": $(date +%s)000,
 "mode": "shadow",
 "repo": "${repo_slug}",
 "repoId": ${repo_id},
 "installationId": ${KL_GITHUB_APP_INSTALLATION_ID_CODEX},
 "receiveAppId": ${KL_GITHUB_APP_ID_CODEX},
 "owners": [${owner_id}],
 "actors": [
  {"id": ${owner_id}, "person": "owner", "kind": "human", "executor": "manual"},
  {"id": ${codex_id}, "person": "codex", "kind": "ai", "executor": "codex"},
  {"id": ${claude_id}, "person": "claude", "kind": "ai", "executor": "claude"}
 ],
 "targets": [{"pr": ${target_pr}, "implementer": ${codex_id}, "reviewers": [${claude_id}]}],
 "maxConcurrent": 1,
 "executorLimits": {"claude": 1, "codex": 1}
}
EOF
  "$node_bin" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$policy" && ls -l "$policy"
)
```

期待: `-rw-------`の1行。

注意（[指摘の規則](review-dispatch-implementation.md#未解消の指摘pr48-r007)）: `person`を実装担当と同じにした人の指摘は数えない（取り違えると指摘が落ちる）。登録した人の行コメントと編集は、その人が今のheadをAPPROVEするまで未解消で、自動のAPPROVEを`needs-owner`のCOMMENTにする。

## 5. install記録を作る

起動器・Broker・supervisorの場所。policyと同じ検査を受ける。

```zsh
(
  umask 077
  test -e "$install" && { echo "install記録は作成済み"; exit 1; }
  [[ -n $sha && -n $node_bin && -n $python_bin && -n $claude_ver ]] || { echo "0を貼り直す"; exit 1; }
  claude_id="$(gh api 'users/kurashi-ledger-claude[bot]' --jq .id)" || exit 1
  cat > "$install" <<EOF
{
 "schema": 1,
 "claude": {
  "backend": "claude",
  "executable": "${claude_exe}",
  "version": "${claude_ver}",
  "runtime": "${claude_exe:h}",
  "cliProfile": "${copy}/tools/review_dispatch/seatbelt/cli.sb",
  "configDir": "${config}",
  "tokenFile": "${token_file}",
  "protectedRoots": ["${root}", "${etc}", "${secrets}", "${logs}", "$HOME/.ssh", "$HOME/.config/gh", "$HOME/.codex", "$HOME/.cloudflared", "$HOME/Library/Keychains", "$HOME/.local/share/kurashi-ledger-app-token"]
 },
 "broker": {
  "node": "${node_bin}",
  "wrapper": "${copy}/scripts/github-app-token.ts",
  "relay": "${copy}/scripts/review-dispatch-claude-broker.ts",
  "gh": "${gh_bin}",
  "appId": "${KL_GITHUB_APP_ID_CLAUDE}",
  "installationId": "${KL_GITHUB_APP_INSTALLATION_ID_CLAUDE}",
  "repo": "${repo_slug}",
  "actor": ${claude_id}
 },
 "python": "${python_bin}",
 "supervisor": "${copy}/tools/review_dispatch/supervisor.py",
 "runs": "${runs}",
 "home": "$HOME",
 "workerTimeoutSeconds": 1800
}
EOF
  "$node_bin" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$install" && ls -l "$install"
)
```

期待: `-rw-------`の1行。

## 6. 専用DBを作る

```zsh
"${daemon[@]}" "${dispatch[@]}" init --root "$root" --policy "$policy"
```

期待: `専用DBを初期化しました（実AI・投稿なし）。`

## 7. 権限とACLを確かめる

受付のhost検査はmacOSのACLを見ない（[host検査](review-dispatch-implementation.md#host検査pr48-r009r011)）。

```zsh
ls -led "$base" "$root" "$etc" "$secrets" "$runs" "$config" "$logs" "$policy" "$install" "$token_file" "$root"/dispatch.sqlite*(N) "$base"/.kurashi-dispatch-*.lock(N)
```

期待: すべて`drwx------`か`-rw-------`。`0: … allow …`のようなACLの行がない。

## 8. 実CLIで測る（measure）

実際のClaudeを、閉じ込めた状態で数回起動する（購読の利用枠を使う。数分かかる）。#56より前の測定は使えない（9で`measurement-stale`）。

```zsh
"${dispatch[@]}" measure --root "$root" --policy "$policy" --install "$install" --out "$etc/measurement-$(date +%Y%m%d%H%M%S).json"
```

期待: `測定:`の1行で、10項目（`deny-…`と`tool-child-confined`。中身は[設計§7](review-dispatch-design.md#claudeの起動の層o2)の否定試験）がすべて`denied`、`schema=true`、`descendantLock=true`。`allowed`なら止める。`inconclusive`・`false`なら原因を調べる。どちらもcli.sbを手で変えず、出力をIssue #50に記録する。

## 9. 否定試験（doctor）

合成のprobe（App鍵・keychain・DB・policy・network・supervisor・ほかのprocessの環境）と、8の測定・認証・config dirを確かめ、合格ならcapabilityを記録する。

```zsh
(
  latest=( "$etc"/measurement-*.json(N.om[1]) )
  (( $#latest )) || { echo "8を先に行う"; exit 1; }
  "${daemon[@]}" "${dispatch[@]}" doctor --root "$root" --policy "$policy" --install "$install" --measurement "${latest[1]}"
)
```

期待: `doctor: verified`。ほかは`doctor: unverified（理由）`か`disabled（理由）`で、capabilityは記録しない。

| 理由 | 行うこと |
| --- | --- |
| 理由なしのunverified、`measurement-missing`・`-stale`・`-invalid` | 8をやり直す（`schema`・`descendantLock`がfalseの測定も含む） |
| `control-failed:…`・`explicit-deny-unproven:…` | 合成のprobeが比較のための許可の実行で失敗した。`process-env`なら1のCommand Line Toolsを入れる。ほかは記録して止める |
| `auth-status-missing`・`auth-not-setup-token`・`auth-config-dir-mismatch` | 3をやり直す |
| `config-dir:…` | `$config`から、理由に出たファイルを除く |
| `managed-settings-present` | Claude Codeの管理設定を外す。外せなければ止める |
| `bound-file-changed` | 試験中にcli.sbか実行ファイルが変わった。やり直す |
| `plan:…`・`argv-hash-mismatch`・`no-launch-plan` | install記録が起動器の検査に通らない。5を見直す |
| `probe-allowed:…`・`measured-allowed:…`・`profile:…`・`sandbox-unavailable` | 隔離が効いていない。止めてIssue #50に記録する |

## 10. 公開HTTPSの経路を選ぶ

どちらも`127.0.0.1:${port}`の受け口へ転送する。URLはrepoに書かない。

| | A. クイックトンネル | B. 名前付きトンネル |
| --- | --- | --- |
| 要るもの | なし（アカウント不要） | Cloudflareのアカウントと、DNSをCloudflareに置いたドメイン |
| 費用 | 無料 | Tunnelは無料。ドメインの登録料（年額） |
| URL | 起動のたびに変わる。毎回Appの設定を直す | 固定 |
| 転送するpath | すべて（受け口は`POST /webhook`以外に404） | `/webhook`だけ |
| 向く用途 | shadowの試し。稼働の保証なし（[Cloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)） | 常用 |

**A.** 別のターミナルで動かし続ける。

```zsh
cloudflared tunnel --url "http://127.0.0.1:${port}"
```

期待: `https://…trycloudflare.com`の行。そのURLに`/webhook`を付けたものが11のURL。

**B.** 1回だけ行う。ブラウザでドメインを選ぶ。

```zsh
cloudflared tunnel login && cloudflared tunnel create kurashi-dispatch && cloudflared tunnel route dns kurashi-dispatch "$tunnel_host"
```

期待: tunnelのIDと、DNSの記録を作った旨の表示。次に設定を書いて確かめる。

```zsh
(
  umask 077
  [[ -n $tunnel_host ]] || { echo "0のtunnel_hostを入れる"; exit 1; }
  tid="$(cloudflared tunnel list | awk '$2 == "kurashi-dispatch" {print $1}')"
  test -f "$HOME/.cloudflared/${tid}.json" || { echo "tunnelの資格情報がない。Bの1つ目をやり直す"; exit 1; }
  cat > "$etc/tunnel.yml" <<EOF
tunnel: ${tid}
credentials-file: $HOME/.cloudflared/${tid}.json
ingress:
  - hostname: ${tunnel_host}
    path: ^/webhook$
    service: http://127.0.0.1:${port}
  - service: http_status:404
EOF
  cloudflared tunnel --config "$etc/tunnel.yml" ingress validate && cloudflared tunnel --config "$etc/tunnel.yml" ingress rule "https://${tunnel_host}/webhook"
)
```

期待: `OK`と、`http://127.0.0.1:`のportに当たった規則の表示。11のURLは`https://${tunnel_host}/webhook`。

## 11. Webhookの秘密と購読（CodexのApp）

受信はCodexのAppだけ（[設計§3](review-dispatch-design.md#3-配置とgithubの身元)）。秘密を作り、クリップボードへ入れる。

```zsh
(
  umask 077
  test -e "$secret_file" && { echo "作成済み"; exit 1; }
  openssl rand -hex 32 > "$secret_file" && tr -d '\n' < "$secret_file" | pbcopy && ls -le "$secret_file"
)
```

期待: `-rw-------`の1行で、ACLの行がない。

GitHubの画面で、CodexのAppの設定を開く（Settings → Developer settings → GitHub Apps）。

1. General → Webhook: Activeに印、Webhook URLに10のURL、Webhook secretに⌘V。Save changes。
2. Permissions & events → Subscribe to events: Pull request、Pull request review、Pull request review comment、Issue comment、Issues、Check run、Check suite、Workflow run、Push。Save changes。

期待: 保存できる。ClaudeのAppにはWebhookを設定しない。保存したら`pbcopy < /dev/null`でクリップボードを空にする。

## 12. launchdに登録する

雛形（[tools/review_dispatch/launchd/](../tools/review_dispatch/launchd/)）を展開する。Bを選んだときはトンネルも登録する。

```zsh
(
  [[ -n $sha && -n $node_bin && -n $python_bin ]] || { echo "0を貼り直す"; exit 1; }
  names=(serve cycle); [[ -n $tunnel_host ]] && names+=(tunnel)
  mkdir -p "$agents"
  for n in $names; do
    sed -e "s|@LABEL@|${label}|g" -e "s|@NODE@|${node_bin}|g" -e "s|@PYTHON@|${python_bin}|g" -e "s|@COPY@|${copy}|g" \
      -e "s|@ROOT@|${root}|g" -e "s|@POLICY@|${policy}|g" -e "s|@INSTALL@|${install}|g" -e "s|@SECRET@|${secret_file}|g" \
      -e "s|@PORT@|${port}|g" -e "s|@GH@|${gh_bin}|g" -e "s|@LOGS@|${logs}|g" -e "s|@HOME@|${HOME}|g" \
      -e "s|@CODEX_APP_ID@|${KL_GITHUB_APP_ID_CODEX}|g" -e "s|@CODEX_INSTALLATION_ID@|${KL_GITHUB_APP_INSTALLATION_ID_CODEX}|g" \
      -e "s|@CLOUDFLARED@|$(command -v cloudflared)|g" -e "s|@TUNNEL_CONFIG@|${etc}/tunnel.yml|g" \
      "$copy/tools/review_dispatch/launchd/${n}.plist.in" > "$agents/${label}.${n}.plist" && plutil -lint "$agents/${label}.${n}.plist" || exit 1
  done
  for n in $names; do launchctl bootstrap "$gui" "$agents/${label}.${n}.plist" || exit 1; done
  sleep 5; curl -s -o /dev/null -w '受け口: %{http_code}\n' -X POST "http://127.0.0.1:${port}/webhook"
)
```

期待: 各plistが`OK`、`受け口: 401`（署名がないので拒否）。`serve`は常駐し、`cycle`は15分ごとと、配送を保存したとき（`$root/trigger`）に動く。

## 13. 最初のshadow

前提: W4c（PR番号は後で）がマージ済み（R013・R016、[所有者決定](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5980478517)）。写しがそれより古ければ「[更新したとき](#更新したとき)」の写しの行を行う。

1. CodexのAppの設定 → Advanced → Recent Deliveriesで、`ping`をRedeliverする。期待: 応答`400`（秘密は一致し、`ping`は受け付けない種類）。`401`なら秘密が違う。
2. cycleを1回動かす。

   ```zsh
   launchctl kickstart "$gui/${label}.cycle"; sleep 60; grep -c -e 'トークンを発行できなかった' -e 'コマンドを実行できなかった' -e '保留しました' "$logs/cycle.err"
   ```

   期待: `0`（launchdからkeychainのApp鍵を読み、照合が終わった）。1以上なら`tail "$logs/cycle.err"`で読む。
3. 状態を見る（[15](#15-statusの読み方)）。

   ```zsh
   "${daemon[@]}" "${dispatch[@]}" status --root "$root" --policy "$policy"
   ```

   期待: `PR #…`の行が`未観測`でない。Jobの行がない（shadowはAIを起動しない）。`capability(claude): 記録あり`。
4. 1日以上動かし、Recent Deliveriesの応答が`202`で5秒以内か、配送のあと1分以内に`cycle.log`の時刻が変わるか（`ls -l "$logs"`）を確かめる。結果をIssue #50に記録する（PR48-R006・R011、I003の実測）。

## 14. 1件のPRをactiveにする

前提: W4c（PR番号は後で）がマージ済み（R015、[所有者決定](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5980478517)）で、写しがそれを含む。

[切替（PRごと）](pr-review-loop.md#切替prごと)の1〜6に従う。コマンドが要るのは2と3。

2の`OWNER_MERGE_ONLY`（所有者のghで行う）:

```zsh
(
  cur="$(gh variable get OWNER_MERGE_ONLY --repo "$repo_slug")" || exit 1
  list=",${${cur//$'\n'/,}// /},"
  [[ $list == *",${target_pr},"* ]] && { echo "既にある: ${cur}"; exit 0; }
  [[ $cur == none ]] && new="${target_pr}" || new="${cur},${target_pr}"
  gh variable set OWNER_MERGE_ONLY --repo "$repo_slug" --body "$new" && gh variable get OWNER_MERGE_ONLY --repo "$repo_slug"
)
```

期待: 対象のPR番号を含む一覧。

3のpolicy。変数とcapabilityを確かめてから切り替える。

```zsh
(
  cur="$(gh variable get OWNER_MERGE_ONLY --repo "$repo_slug")" || exit 1
  [[ ",${${cur//$'\n'/,}// /}," == *",${target_pr},"* ]] || { echo "OWNER_MERGE_ONLYにPRがない。2を行う"; exit 1; }
  "${daemon[@]}" "${dispatch[@]}" status --root "$root" --policy "$policy" 2>/dev/null | grep -q 'capability(claude): 記録あり' || { echo "capabilityがない。9を行う"; exit 1; }
  kl_mode active && launchctl kickstart -k "$gui/${label}.serve"
)
```

期待: `active start-small-…`。6の実装担当のReadyのあと、数分で粗探しのCOMMENT、次のcycleでレビューが`kurashi-ledger-claude[bot]`から出る。

## 15. statusの読み方

13の3のコマンドで見る。cycleの実行中は排他で`保留しました`になるので、1分後にやり直す。

| 行 | 読み方 |
| --- | --- |
| `PR #N: 状態（理由、世代G）` | 状態は`waiting`・`eligible`・`finished`。主な理由: `draft`、`new-ready-required`（新しいDraft→Readyが要る）、`ci-not-proven`、`base-not-incorporated`（mainを取り込む）、`unknown-identity`（branchの作成から身元を証明できない。新しいPRにするか、[shadowの照合](review-dispatch-implementation.md#shadowの照合)の`identity`を設定する）、`unknown-evidence`（取得の欠け、[CIの信頼](review-dispatch-implementation.md#workflowの信頼pr48-r008)の未記録）、`paused`、`blocked-owner-required`、`quota-owner-required` |
| `blocked` | 公開前の検査で止めた結果。内容を確かめ、PRに`review:paused`を付けてから外すと消える |
| `上限での停止` | 24時間に6回の起動の上限。原因を確かめ、`review:paused`の付け外しで解く |
| `未処理の編集の印` | 指摘の編集・削除の配送。次のcycleの照合で消える |
| `不明な投稿` | 0でなければ、GitHubで投稿を確かめるまでreleaseもrollbackもしない |
| Jobの行 `種類 世代G 状態 run ID` | 新しい順に20件まで。状態は`launching`・`running`・`result-ready`・`posted`・`finished`・`uncertain` |
| `capability(claude)` | `なし`なら起動しない。8と9をやり直す |

`review:paused`を外すと、そのPRは新しいDraft→Readyが要る。

## 16. release

runが終わったのにleaseが残る（Macの再起動のあと等）ときだけ使う。対象のrunを求める。

```zsh
run_id="$("${daemon[@]}" "${dispatch[@]}" status --root "$root" --policy "$policy" 2>/dev/null | awk '$1 ~ /^(faultfinding|review)$/ && $3 ~ /^(launching|running|uncertain)$/ {print $5; exit}')"; print -r -- "run=${run_id:-なし}"
```

期待: `run=`とID。`なし`なら外すものはない（15のstatusで確かめる）。

実行中のrunを止めるときだけ、取り消しの印を置き、1分待つ。

```zsh
[[ -n $run_id ]] && : > "$root/cancel-${run_id}"
```

期待: 表示なし。leaseを外す。

```zsh
[[ -n $run_id ]] && "${daemon[@]}" "${dispatch[@]}" release --root "$root" --policy "$policy" --install "$install" --run "$run_id"
```

期待: `run …のleaseを外しました`。終了コード4は不明な投稿がある。`保留しました`は終了を証明できない。どちらも外さずに待つ。

## 17. rollback

手順の正本は[rollback](pr-review-loop.md#rollbackprごとまたは全体)。

PRを戻す（受付は照合だけを続ける）:

```zsh
kl_mode shadow && launchctl kickstart -k "$gui/${label}.serve"
```

期待: `shadow start-small-…`。続けて15のstatusで、Jobの行に`launching`・`running`・`result-ready`・`uncertain`がなく、`不明な投稿: 0件`。残れば16。

全体を止める（serveはoffで起動しないので、先に外す）:

```zsh
for n in cycle serve tunnel; do launchctl bootout "$gui/${label}.${n}" 2>/dev/null; done; kl_mode off
```

期待: `off start-small-…`。CodexのAppのWebhookのActiveを外す。

## 18. 広げる前に測る

対象のPRで、受付が起動した回数、同じhead/baseでの重複起動、Readyから結果までの時間を測る。粗探しもReviewのCOMMENTで出るので、Reviewを1回取得して本文の印で分ける。

```zsh
gh api --paginate "repos/${repo_slug}/issues/${target_pr}/timeline" --jq '.[] | select(.event == "ready_for_review") | "ready\t\(.created_at)"'
gh api --paginate "repos/${repo_slug}/pulls/${target_pr}/reviews" --jq '.[] | select(.user.login == "kurashi-ledger-claude[bot]") | "\(if (.body | contains("<!-- kurashi-ledger:red-team:v1 -->")) then "red-team" else "review" end)\t\(.submitted_at)\t\(.commit_id[0:7])\t\(.state)"'
```

期待: 時刻順に読む。起動回数は`red-team`と`review`の行数（投稿のない起動は15のJobの行で数える）。同じ種類で同じheadの行が2つあれば重複起動。各`ready`から次の`red-team`・`review`までが待ち時間。値と旧巡回との比較をIssue #50に記録し、所有者が広げるかを決める。

## 更新したとき

| 変えたもの | やり直す手順 |
| --- | --- |
| Claude Code（自動更新を含む。`ls "$claude_exe"`が失敗するか、cycleのログに`capability-version`・`capability-executable`が出たら） | 0、`rm "$install"`のあと5、8、9 |
| 写し（新しいmain） | 17の「全体を止める」の1行目、2、0、`rm "$install"`のあと5、8、9、12 |
| setup-token（期限） | 3、9 |
| policy | `kl_mode`か手で変え、revisionを上げ、`launchctl kickstart -k "$gui/${label}.serve"`で受け口を再起動する。Readyのやり直しが要る |
