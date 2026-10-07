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
funnel_host=''  # 10のB（Tailscale Funnel）のホスト名<host>.<tailnet>.ts.net。Aなら空
repo_slug=doc-gif/kurashi-ledger
base="$HOME/.local/share/kurashi-dispatch"
root="$base/root" etc="$base/etc" secrets="$base/secrets" runs="$base/runs" logs="$base/log"
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
kl_mode() { local d; d="$(gh api -i /zen 2>/dev/null | sed -n 's/^[Dd]ate: //p' | tr -d '\r')"; [[ -n $d || $1 != active ]] || { echo "GitHubの時刻を取れない。policyを変えない"; return 1; }; "$node_bin" -e 'const fs = require("fs"); const [f, mode, date] = process.argv.slice(1); let g = Date.parse(date); if (!Number.isFinite(g)) { if (mode === "active") { console.error("GitHubの時刻が読めない。policyを変えない"); process.exit(1); } console.error("GitHubの時刻を取れないので、Macの時刻を使う"); g = 0; } const t = Math.max(Date.now(), g + 1000); const p = JSON.parse(fs.readFileSync(f, "utf8")); p.mode = mode; p.revision = "start-small-" + t; p.readyAfter = t; fs.writeFileSync(f + ".new", JSON.stringify(p, null, 1) + "\n", { mode: 0o600, flag: "wx" }); fs.renameSync(f + ".new", f); console.log(p.mode, p.revision);' "$policy" "$1" "$d"; }
kl_stopped() { local st; st="$("${daemon[@]}" "${dispatch[@]}" status --root "$root" --policy "$policy" 2>/dev/null)" || { run_id=; echo "statusが失敗した（cycleの実行中なら1分後に）。停止は未確認"; return 1; }; run_id="$(print -r -- "$st" | awk '$1 ~ /^(faultfinding|review)$/ && $3 ~ /^(launching|running|result-ready|uncertain)$/ {print $5; exit}')"; [[ -z $run_id && $st == *"不明な投稿: 0件"* && $st != *"不明な投稿: "[1-9]* ]] && { echo "停止を確認"; return 0; }; echo "停止していない（run=${run_id:-なし}、不明な投稿あり、のどちらか）。16を行う"; return 1; }
kl_svc() { local o; o="$(launchctl print "$gui/${label}.$1" 2>&1)"; case $? in 0) [[ $o == *"state = "* ]] && echo loaded || echo unknown;; 113) [[ $o == *"Could not find service \"${label}.$1\""* ]] && echo absent || echo unknown;; *) echo unknown;; esac; }
kl_cycle_once() { local o r0 n st c g i; o="$(launchctl print "$gui/${label}.cycle" 2>/dev/null)" || { echo unknown; return 1; }; r0="$(print -r -- "$o" | awk -F' = ' '$1 == "\truns" {print $2}')"; [[ $r0 == <-> ]] && launchctl kickstart "$gui/${label}.cycle" >/dev/null 2>&1 || { echo unknown; return 1; }; for i in {1..120}; do sleep 5; o="$(launchctl print "$gui/${label}.cycle" 2>/dev/null)" || continue; IFS='|' read -r n st c g <<< "$(print -r -- "$o" | awk -F' = ' '$1 == "\truns" {r = $2} $1 == "\tstate" {s = $2} $1 == "\tlast exit code" {c = $2} $1 == "\tlast terminating signal" {g = "signal"} END {print r "|" s "|" c "|" g}')"; [[ $n == <-> ]] && (( n > r0 )) && [[ $st == "not running" ]] || continue; [[ $c == 0 && -z $g ]] && { echo ok; return 0; }; echo "failed（終了コード${c:-なし}${g:+、signal}）"; return 1; done; echo unknown; return 1; }
kl_funnel() { local s m; [[ -n $funnel_host ]] || { echo "0のfunnel_hostを入れる"; return 1; }; s="$(tailscale funnel status 2>&1)" || { echo "funnelの状態を読めない"; return 1; }; m=( "${(@f)$(print -r -- "$s" | grep -E '^\|-- ')}" ); [[ $#m == 1 && ${m[1]} == "|-- /webhook proxy http://127.0.0.1:${port}/webhook" && $s == *"https://${funnel_host} (Funnel on)"* ]] && return 0; print -r -- "$s"; echo "Funnelの取付けが/webhookの1つだけでない"; return 1; }
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
  mkdir -p "$root" "$etc" "$secrets" "$runs" "$logs" && chmod 700 "$base" "$root" "$etc" "$secrets" "$runs" "$logs" || exit 1
  src="$(mktemp -d)"; trap 'rm -rf "$src"' EXIT
  git clone --quiet --no-checkout "https://github.com/${repo_slug}.git" "$src/repo" || exit 1
  new="$(git -C "$src/repo" rev-parse origin/main)" && (( ${#new} == 40 )) || exit 1
  git -C "$src/repo" merge-base --is-ancestor bea1f658f106c9b7810457634927eff595743c60 "${new}" || { echo "mainに#58がない"; exit 1; }
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
  umask 077; trap 'pbcopy < /dev/null' EXIT
  IFS= read -rs 'tok?トークンを貼り付けてEnter: ' || exit 1
  print -r -- "$tok" > "$token_file" && echo && ls -le "$token_file"
)
```

期待: `-rw-------`の1行で、ACLの行がない。成功でも失敗でもクリップボードは空になる。⌘Kで画面のトークンを消す。期限が切れたら、この手順をやり直す。

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

起動器・Broker・supervisorの場所。policyと同じ検査を受ける。Claudeの設定dirは置かない（`configDir`は`null`。runごとに`$runs`の中へ新しく作る）。前に作った記録に設定dirのパスがあれば、`rm "$install"`のあとこの手順をやり直す。

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
  "configDir": null,
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
ls -led "$base" "$root" "$etc" "$secrets" "$runs" "$logs" "$policy" "$install" "$token_file" "$root"/dispatch.sqlite*(N) "$base"/.kurashi-dispatch-*.lock(N)
```

期待: すべて`drwx------`か`-rw-------`。`0: … allow …`のようなACLの行がない。

## 8. 実CLIで測る（measure）

実際のClaudeを、閉じ込めた状態で数回起動する（購読の利用枠を使う。数分かかる）。W5eより前の測定は使えない（9で`measurement-invalid`か`measurement-missing`）。

```zsh
"${dispatch[@]}" measure --root "$root" --policy "$policy" --install "$install" --out "$etc/measurement-$(date +%Y%m%d%H%M%S).json"
```

期待: `測定:`の1行で、11項目（`deny-…`・`tool-child-confined`・`config-holds-no-secret`。中身は[設計§7](review-dispatch-design.md#claudeの起動の層o2)の否定試験。括弧は根拠の種類）のうち、`情報`の印のない4項目が`denied`、`schema=true`、`groupEnded=true`。`情報`の印の項目は、モデルが試したかで毎回変わるので合否に使わない（`inconclusive`でもよい。同じ対象は9の合成のprobeか`config-holds-no-secret`が確かめる）。続く`子processにも許す`の行は、共有profileで許す操作で、拒否の結果ではない。`allowed`なら止める。`inconclusive`・`false`なら、続く`診断`の行（測定fileの`diagnostics`と同じ。run A・A2・B・benignごとの終了コード・initの道具・`result`・benignの失敗段階）で原因を調べる。どちらもcli.sbを手で変えず、出力をIssue #50に記録する。

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
| 理由なしのunverified、`measurement-missing`・`-stale`・`-invalid` | 8をやり直す（`schema`・`groupEnded`がfalseの測定も含む） |
| `control-failed:…`・`explicit-deny-unproven:…` | 合成のprobeが比較のための許可の実行で失敗した。`process-env`なら1のCommand Line Toolsを入れる。ほかは記録して止める |
| `auth-status-missing`・`auth-not-setup-token`・`auth-config-dir-mismatch` | 3をやり直す |
| `config-dir:…` | doctorのrunの新しい設定dirにファイルがあった。止めてIssue #50に記録する |
| `managed-settings-present` | Claude Codeの管理設定を外す。外せなければ止める |
| `bound-file-changed` | 試験中にcli.sbか実行ファイルが変わった。やり直す |
| `plan:…`・`argv-hash-mismatch`・`no-launch-plan` | install記録が起動器の検査に通らない。5を見直す |
| `probe-allowed:…`・`measured-allowed:…`・`profile:…`・`sandbox-unavailable` | 隔離が効いていない。止めてIssue #50に記録する |
| `coverage-gap:…` | run Bの対象に対応する合成のprobeがない（コードの誤り）。止めてIssue #50に記録する |

## 10. 公開HTTPSの経路を選ぶ

どちらも`127.0.0.1:${port}`の受け口へ転送する。URLはrepoに書かない。

| | A. クイックトンネル | B. Tailscale Funnel |
| --- | --- | --- |
| 要るもの | なし（アカウント不要） | このMacでログインしたTailscaleのアプリ |
| 費用 | 無料 | 無料 |
| URL | 起動のたびに変わる。毎回Appの設定を直す | 固定（`<host>.<tailnet>.ts.net`） |
| 転送するpath | すべて | `/webhook`とその下（ほかはFunnelが404。下のpathは受け口に届き、受け口が404。[設計§3](review-dispatch-design.md#3-配置とgithubの身元)） |
| 使える段階 | shadow のみ。残る危険（全pathが受け口に届く。受け口の404と署名で守る）（[所有者決定](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5993511406)）。稼働の保証なし（[Cloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)） | shadowとactive。14の前に必須。アプリが起動・ログイン中でMacが起きている間だけ動く（設定は再起動後も残る） |

**A.** 別のターミナルで動かし続ける。

```zsh
cloudflared tunnel --url "http://127.0.0.1:${port}"
```

期待: `https://…trycloudflare.com`の行。そのURLに`/webhook`を付けたものが11のURL。

**B.** 1回だけ行う。App Store版のTailscaleでは、CLIは`/Applications/Tailscale.app/Contents/MacOS/Tailscale`（aliasか`/usr/local/bin`のlauncherで`tailscale`として呼ぶ）。証明書の発行で、ホスト名とtailnet名がCertificate Transparencyの公開ログに載り、消せない。実名などを含まない機器名に変えてから行う。URLは秘密ではなく、守りは署名（設計§3）。

```zsh
tailscale funnel --bg --set-path /webhook "http://127.0.0.1:${port}/webhook"
```

期待: `https://<host>.<tailnet>.ts.net/webhook`の表示。初回はtailnetでFunnelを有効にするリンクが出るので、ブラウザで有効にし、URLが出なければやり直す。表示のホスト名を0の`funnel_host`に入れ、0を貼り直す。11のURLは`https://${funnel_host}/webhook`。443番だけを使う（[Funnel](https://tailscale.com/kb/1223/funnel)、[serve](https://tailscale.com/kb/1242/tailscale-serve)）。

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

雛形（[tools/review_dispatch/launchd/](../tools/review_dispatch/launchd/)）を展開する。登録済み（`loaded`）は飛ばし、状態不明なら止まるので、やり直してよい。

```zsh
(
  [[ -n $sha && -n $node_bin && -n $python_bin ]] || { echo "0を貼り直す"; exit 1; }
  names=(serve cycle)
  mkdir -p "$agents"
  for n in $names; do
    case "$(kl_svc $n)" in loaded) continue;; absent) ;; *) echo "状態不明: ${n}"; exit 1;; esac
    sed -e "s|@LABEL@|${label}|g" -e "s|@NODE@|${node_bin}|g" -e "s|@PYTHON@|${python_bin}|g" -e "s|@COPY@|${copy}|g" \
      -e "s|@ROOT@|${root}|g" -e "s|@POLICY@|${policy}|g" -e "s|@INSTALL@|${install}|g" -e "s|@SECRET@|${secret_file}|g" \
      -e "s|@PORT@|${port}|g" -e "s|@GH@|${gh_bin}|g" -e "s|@LOGS@|${logs}|g" -e "s|@HOME@|${HOME}|g" \
      -e "s|@CODEX_APP_ID@|${KL_GITHUB_APP_ID_CODEX}|g" -e "s|@CODEX_INSTALLATION_ID@|${KL_GITHUB_APP_INSTALLATION_ID_CODEX}|g" \
      "$copy/tools/review_dispatch/launchd/${n}.plist.in" > "$agents/${label}.${n}.plist" && plutil -lint "$agents/${label}.${n}.plist" && launchctl bootstrap "$gui" "$agents/${label}.${n}.plist" || exit 1
  done
  sleep 5; curl -s -o /dev/null -w '受け口: %{http_code}\n' -X POST "http://127.0.0.1:${port}/webhook"
)
```

期待: 新しく登録したplistが`OK`、`受け口: 401`（署名がないので拒否）。`serve`は常駐し、`cycle`は15分ごとと、配送を保存したとき（`$root/trigger`）に動く。

Bのときは、Funnelの取付けと受け口の応答を確かめる。このMacではホスト名がMagicDNSでtailnetのアドレスになり、curlは公開の入口を通らない。確かめるのは取付けだけで、公開経路の到達は「Bへ移る」の5のGitHubの配送で確かめる。

```zsh
(
  kl_funnel || exit 1
  w="$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://${funnel_host}/webhook")"
  o="$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://${funnel_host}/other")"; e="$(curl -s -o /dev/null -w '%{http_code}' -X POST "https://${funnel_host}/webhook/extra")"
  print -r -- "webhook=${w} other=${o} extra=${e}"
  [[ $w == 401 && $o == 404 && $e == 404 ]] && echo "取付け確認"
)
```

期待: `webhook=401 other=404 extra=404`と`取付け確認`。`/other`はFunnelが、`/webhook/extra`は受け口が404を返す（設計§3）。`kl_funnel`が止めたら、表示の取付けを`tailscale funnel`で直す。

## 13. 最初のshadow

1. CodexのAppの設定 → Advanced → Recent Deliveriesで、`ping`をRedeliverする。期待: 応答`400`（秘密は一致し、`ping`は受け付けない種類）。`401`なら秘密が違う。
2. cycleを1回動かし、今回の起動が終了コード0で終わったことを確かめる。

   ```zsh
   kl_cycle_once
   ```

   期待: `ok`。`failed`・`unknown`なら13は未完了（`tail "$logs/cycle.err"`で読む）。終了コード4は[policyの更新](review-dispatch-implementation.md#policyの更新と受け口の503)、125はApp鍵を読めない（launchdからkeychain）。
3. 状態を見る（[15](#15-statusの読み方)）。

   ```zsh
   "${daemon[@]}" "${dispatch[@]}" status --root "$root" --policy "$policy"
   ```

   期待: `PR #…`の行が`未観測`でない。Jobの行がない（shadowはAIを起動しない）。`capability(claude): 記録あり`。
4. 実配送の結合を確かめる（PR48-R006）。mainが動かない間に、対象のPRを実装担当か所有者がDraft→Readyにし、2を行ってから:

   ```zsh
   (
     rm -f "$etc/r006-ok"
     gh api --paginate "repos/${repo_slug}/issues/${target_pr}/timeline" --jq '.[] | select(.event == "ready_for_review") | "\(.id)\t\(.created_at)\t\(.actor.id)"' > "$etc/r006-timeline.tsv" || exit 1
     main_sha="$(gh api "repos/${repo_slug}/commits/main" --jq .sha)" && head_sha="$(gh api "repos/${repo_slug}/pulls/${target_pr}" --jq .head.sha)" && (( ${#main_sha} == 40 && ${#head_sha} == 40 )) || exit 1
     "$node_bin" -e 'try {
       const fs = require("fs"); const { DatabaseSync } = require("node:sqlite");
       const [db, pol, pr, main, head, tlf, out] = process.argv.slice(1);
       const p = JSON.parse(fs.readFileSync(pol, "utf8")); const key = p.repoId + ":" + pr;
       const tl = fs.readFileSync(tlf, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
       const d = new DatabaseSync(db, { readOnly: true });
       const ev = d.prepare("SELECT value FROM evidence WHERE id = ?");
       let ok = "";
       for (const r of d.prepare("SELECT delivery, policy, payload FROM inbox WHERE event = ? AND payload IS NOT NULL").all("pull_request")) {
         const b = JSON.parse(r.payload), x = b.pull_request;
         if (b.action !== "ready_for_review" || String(x.number) !== pr) continue;
         const m = tl.filter(([, at, actor]) => Date.parse(at) === Date.parse(x.updated_at) && Number(actor) === b.sender.id);
         const row = m.length === 1 ? ev.get("ready:" + key + ":timeline:" + m[0][0]) : undefined;
         const v = row ? JSON.parse(row.value) : null;
         const c = { revision: r.policy === p.revision, updated_at: m.length === 1, head: x.head.sha === head, base: x.base.sha === main,
           bound: !!v && v.id === "timeline:" + m[0][0] && v.policy === p.revision && v.at > p.readyAfter && v.actor === b.sender.id && v.pair.head === x.head.sha && v.pair.base === x.base.sha };
         console.log(r.delivery, JSON.stringify(c));
         if (Object.values(c).every((y) => y === true)) ok = r.delivery;
       }
       if (ok) fs.writeFileSync(out, ok + "\n", { mode: 0o600 });
       console.log(ok ? "R006 完了" : "R006 未完了"); process.exit(ok ? 0 : 1);
     } catch { console.log("R006 未完了（読取り・解析の失敗）"); process.exit(1); }' "$root/dispatch.sqlite" "$policy" "$target_pr" "$main_sha" "$head_sha" "$etc/r006-timeline.tsv" "$etc/r006-ok"
   )
   ```

   期待: 配送ごとの比較（revision・updated_at＝timelineの時刻・head・base＝main・結合＝今のrevisionで`readyAfter`より後、この配送のpair・actor・ID）が1行ずつと、`R006 完了`。読取り・解析の失敗では印を作らない。`R006 未完了`なら結合の規則を独立レビューで直すまでactiveにしない（14の3が止める）。比較の行をIssue #50に記録する。
5. 1日以上動かし、Recent Deliveriesの応答が`202`で5秒以内か、配送のあと1分以内に`cycle.log`の時刻が変わるか（`ls -l "$logs"`）を確かめ、Issue #50に記録する（PR48-R011、I003）。

## Bへ移る

activeの前に、Aで動かしているshadowをBへ移す（[所有者決定](https://github.com/doc-gif/kurashi-ledger/issues/50#issuecomment-5993511406)）。

旧B（名前付きトンネル）を作っていたら、先に`launchctl bootout "$gui/${label}.tunnel"; rm -f "$agents/${label}.tunnel.plist" "$etc/tunnel.yml" "$etc/tunnel-b-ok"`で外す。

1. 10のBを行う（0の`funnel_host`を入れて貼り直すまで）。
2. 12のBの確認を行う。期待: `取付け確認`。
3. 11の1で、Webhook URLだけを`https://${funnel_host}/webhook`に変える（秘密は変えない）。
4. Aのターミナルで、Ctrl-Cでクイックトンネルを止める。
5. 次の配送（またはRecent Deliveriesで直近の`ping`以外のRedeliver）の応答が`202`であることを確かめ、`: > "$etc/tunnel-b-ok"`で印を作る。公開経路の到達の証拠はこのGitHubの配送だけ（`ping`のRedeliverが署名の検査の後の`400`でもよい）。
6. 13の5を、Bの経路でやり直す。

## 14. 1件のPRをactiveにする

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
  test -s "$etc/r006-ok" || { echo "R006が未完了。13の4を行う"; exit 1; }
  test -e "$etc/tunnel-b-ok" && kl_funnel || { echo "BのFunnelでない。「Bへ移る」を行う"; exit 1; }
  pgrep -f 'cloudflared tunnel --url' >/dev/null; pg=$?; (( pg == 1 )) || { echo "クイックトンネルが動いているか、確かめられない（pgrep ${pg}）"; exit 1; }
  kl_mode active
)
```

期待: `active start-small-…`。6の実装担当のReadyのあと、数分で粗探しのCOMMENT、次のcycleでレビューが`kurashi-ledger-claude[bot]`から出る。

## 15. statusの読み方

13の3のコマンドで見る。cycleの実行中は排他で`保留しました`になるので、1分後にやり直す。

| 行 | 読み方 |
| --- | --- |
| `PR #N: 状態（理由、世代G）` | 状態は`waiting`・`eligible`・`finished`。主な理由: `draft`、`new-ready-required`（新しいDraft→Readyが要る）、`ci-not-proven`、`base-not-incorporated`（mainを取り込む）、`unknown-identity`（branchの作成から身元を証明できない。新しいPRにするか、[shadowの照合](review-dispatch-implementation.md#shadowの照合)の`identity`を設定する）、`unknown-evidence`（取得の欠け、[CIの信頼](review-dispatch-implementation.md#workflowの信頼pr48-r008)の未記録）、`paused`、`blocked-owner-required`、`quota-owner-required` |
| `blocked` | 公開前の検査で止めた結果（`publication`）か、消せなかったrun領域（`run-area-not-removed`。18の確認を行う）。内容を確かめ、PRに`review:paused`を付けてから外すと消える |
| `上限での停止` | 24時間に6回の起動の上限。原因を確かめ、`review:paused`の付け外しで解く |
| `停止の時刻が未確定` | 出ているあいだの`review:paused`の解除は数えない。消えてから付け外しする（[R015](review-dispatch-implementation.md#pr48-r013r016w4c58)） |
| `未処理の編集の印` | 指摘の編集・削除の配送。次のcycleの照合で消える |
| `不明な投稿` | 0でなければ、GitHubで投稿を確かめるまでreleaseもrollbackもしない |
| Jobの行 `種類 世代G 状態 run ID` | 新しい順に20件まで。状態は`launching`・`running`・`result-ready`・`posted`・`finished`・`uncertain` |
| `capability(claude)` | `なし`なら起動しない。8と9をやり直す |

`review:paused`を外すと、そのPRは新しいDraft→Readyが要る。

## 16. release

未完了のJob（`launching`・`running`・`result-ready`・`uncertain`）を、終了を証明して外す。

```zsh
kl_stopped
```

期待: `停止を確認`なら終わり。`停止していない（run=…）`ならIDが`run_id`に入る。`statusが失敗した`なら停止は未確認のまま待つ。

実行中のrunだけ、取り消しの印を置き、1分待つ。

```zsh
[[ -n $run_id ]] && : > "$root/cancel-${run_id}"
```

期待: 表示なし。leaseを外す。

```zsh
[[ -n $run_id ]] && "${daemon[@]}" "${dispatch[@]}" release --root "$root" --policy "$policy" --install "$install" --run "$run_id"
```

期待: `run …のleaseを外しました`。終了コード4は不明な投稿がある（GitHubで投稿を確かめる）。`保留しました`は終了を証明できない。どちらも外さずに待つ。外したら最初の`kl_stopped`に戻り、`停止を確認`まで繰り返す。

## 17. rollback

手順の正本は[rollback](pr-review-loop.md#rollbackprごとまたは全体)。

PRを戻す（受付は照合だけを続ける）:

```zsh
kl_mode shadow
```

期待: `shadow start-small-…`。続けて16の`kl_stopped`が`停止を確認`になるまで16を行う。

全体を止める。まずlaunchdから外す（serveはoffで起動しないので、先に外す）:

```zsh
(
  for n in cycle serve; do launchctl bootout "$gui/${label}.${n}" 2>/dev/null; done
  for i in {1..12}; do left=(); for n in cycle serve; do v="$(kl_svc $n)"; [[ $v == absent ]] || left+=("${n}=${v}"); done; (( $#left )) || break; sleep 5; done
  echo "全体を止めるときは、次に必ずkl_mode offを行う"
  (( $#left )) && { echo "外れていない: ${left}（写しの更新はしない）"; exit 1; }; echo "外した"
)
```

期待: `外した`。`外れていない: …`なら、`kl_mode off`のあとでこのブロックをやり直す。クイックトンネルはそのターミナルでCtrl-Cで、BのFunnelは`tailscale funnel --https=443 off`で止め、`tailscale funnel status`にFunnelが残っていないことを確かめる。次にpolicyをoffにする:

```zsh
kl_mode off
```

期待: `off start-small-…`。16の`kl_stopped`が`停止を確認`になるまで16を行う。CodexのAppのWebhookのActiveを外す。

## 18. 広げる前に測る

対象のPRで、受付が起動した回数、同じhead/baseでの重複起動、Readyから結果までの時間を測る。粗探しもReviewのCOMMENTで出るので、Reviewを1回取得して本文の印で分ける。

```zsh
gh api --paginate "repos/${repo_slug}/issues/${target_pr}/timeline" --jq '.[] | select(.event == "ready_for_review") | "ready\t\(.created_at)"'
gh api --paginate "repos/${repo_slug}/pulls/${target_pr}/reviews" --jq '.[] | select(.user.login == "kurashi-ledger-claude[bot]") | "\(if (.body | contains("<!-- kurashi-ledger:red-team:v1 -->")) then "red-team" else "review" end)\t\(.submitted_at)\t\(.commit_id[0:7])\t\(.state)"'
```

期待: 時刻順に読む。起動回数は`red-team`と`review`の行数（投稿のない起動は15のJobの行で数える）。同じ種類で同じheadの行が2つあれば重複起動。各`ready`から次の`red-team`・`review`までが待ち時間。値と旧巡回との比較をIssue #50に記録し、所有者が広げるかを決める。

最初の1PRでは、Jobが終わるたびに（15のJobの行が`running`でないとき）、受付のrunが残したかもしれないprocessと資源を**表示**する（[残余リスク](review-dispatch-design.md#groupを離れた子残余リスク)）。判断は所有者が行う。候補は2種類: (a) cwdか開いたfileが`$runs`の下にあるprocess、(b) 消したrun領域のfile（削除済み）を開いたままのprocess（`lsof +L1`）。どちらも、この関数が自分で起こした対照のprocessを見つけたときだけ結果を信じる。`lsof +D`は見つけたときも終了1を返すので使わない。次の関数を貼り、`kl_left`を実行する。

```zsh
kl_left() {
  local d="$runs/.kl-control" a b all del pa pb s1 s2 s3 s4 s5 bad=""
  mkdir -p "$d" && : > "$d/held" || { echo "確認できない（対照を作れない）"; return 2; }
  (cd "$d" && exec /bin/sleep 60) &! a=$!
  (exec /bin/sleep 60 < "$d/held") &! b=$!
  sleep 1; rm "$d/held"
  all="$(lsof -nP -F pn)"; s1=$?
  del="$(lsof -nP -F pn +L1)"; s2=$?
  kill $a $b; rmdir "$d"
  kl_pick() { print -r -- "$1" | awk -v r="$runs" '/^p[0-9]+$/ {p = substr($0, 2); next} /^f/ {next} /^n/ {n = substr($0, 2); if (n == r || index(n, r "/") == 1) print p; next} {bad = 1} END {exit bad}'; }
  pa="$(kl_pick "$all")"; s3=$?
  pb="$(kl_pick "$del")"; s4=$?
  du -sk "$runs"; s5=$?
  (( s1 )) && bad+=" lsof=$s1"; (( s2 )) && bad+=" lsof+L1=$s2"; (( s3 || s4 )) && bad+=" 出力の形"; (( s5 )) && bad+=" du=$s5"
  [[ $'\n'"$pa"$'\n' == *$'\n'"$a"$'\n'* ]] || bad+=" 対照(a)なし"
  [[ $'\n'"$pb"$'\n' == *$'\n'"$b"$'\n'* ]] || bad+=" 対照(b)なし"
  [[ -z $bad ]] || { echo "確認できない（${bad# }）"; return 2; }
  pa=( ${(u)${(f)pa}} ); pb=( ${(u)${(f)pb}} ); pa=( ${pa:#($a|$b)} ); pb=( ${pb:#($a|$b)} )
  (( $#pa + $#pb )) || { echo "候補なし（全子孫の終了の証明ではない）"; return 0; }
  echo "候補 (a) cwdか開いたfileが\$runsの下: ${pa:-なし}"; echo "候補 (b) 消したrun領域のfileを開いたまま: ${pb:-なし}"
  local both=( $pa $pb )
  ps -o pid=,pgid=,%cpu=,rss=,etime=,comm= -p "${(j:,:)${(u)both}}" || { echo "確認できない（ps=$?）"; return 2; }
  return 1
}
kl_left; echo "戻り値 $?"
```

期待: `$runs`の大きさ（`du`の行）と`候補なし（全子孫の終了の証明ではない）`、`戻り値 0`。これは候補が見えないことだけを示す。戻り値ごとに分ける。

- **0**: `$runs`の大きさが0なら、次のJobへ進んでよい。0でなければ1と同じに扱う。
- **1**（候補あり）: `kl_mode shadow`で新しい起動を止める。出たPIDとCPU・RSS・経過時間を確かめ、所有者が`kill -TERM <PID>`で止める（残れば`kill -KILL <PID>`）。`kl_left`をやり直し、0になるまで再開しない。16の`kl_stopped`が`停止を確認`になるまで16を行い、空でない`$runs`のrun領域は、processが無くなってから消す。出た行と原因をIssue #50に記録する。再開（14の3）は所有者が決める。
- **2**（確認できない）: `kl_mode shadow`で止め、表示をIssue #50に記録する。signalは送らず、再開しない。8の測定もしない。

## 更新したとき

| 変えたもの | やり直す手順 |
| --- | --- |
| Claude Code（自動更新を含む。`ls "$claude_exe"`が失敗するか、cycleのログに`capability-version`・`capability-executable`が出たら） | 0、`rm "$install"`のあと5、8、9 |
| 写し（新しいmain） | 17のlaunchdから外すブロックで`外した`まで（`kl_mode off`はしない）、2、0、`rm "$install"`のあと5、8、9、12。modeとrevisionは変えない。新しい写しで古いDBが拒否されたら（schemaの変更）、新しいrootで手順6のinitからやり直し、そのときだけ今のmodeで`kl_mode`を実行する（shadowなら`kl_mode shadow`、activeなら14の3） |
| setup-token（期限） | 3、9 |
| policy | `kl_mode`（revisionと`readyAfter`を新しくする）か手で変える。手で変えるときも`readyAfter`を切替の時刻にする。受け口は配送ごとに読み直すので再起動は要らない。Readyのやり直しが要る |
| cycleが終了コード4、受け口が503を返し続ける | [policyの更新と受け口の503](review-dispatch-implementation.md#policyの更新と受け口の503) |
