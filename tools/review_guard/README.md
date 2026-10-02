# Review guard

Python 3.11以上、外部パッケージ不要。Macでは`python3`、Windowsでは`py -3`を使用する。Pythonはレビュー運用の開発ツール用で、製品のランタイムには追加しない。Windowsを含めPythonがない環境では別途Python 3.11以上の準備が必要。この変更ではインストールしない。

リポジトリのrootで実行する。実装方針は[修正前確認](../../docs/review-prevention.md)に従う。

```sh
python3 tools/review_guard/guard.py validate
python3 -m unittest discover -s tools/review_guard/tests -v
```

予定するパスをJSON配列で保存する（例: `["src/infrastructure/storage/root.ts"]`）。renameは旧・新双方を含める。パスは大小文字を区別するrepo相対表記。パターンはPython `fnmatchcase`で、`*`は`/`も含む。この初期版はgitignore互換の否定・除外パターンを提供しない。

```sh
python3 tools/review_guard/guard.py prepare --paths-file planned-paths.json --base-sha <40文字のbaseSHA> > .review/plans/T07.json
```

出力されたTODOを埋める。`context`は読解用の抜粋で、検査の根拠は`--catalog`と`--ledger`。`task_id`、`planned_paths`、`assessments`、`conflicts`が検査対象。`assessments`の`id`は条件、`checks[].id`は確認シナリオを参照する。`method`は確認方法、`expected`は期待結果で、実行済み証跡ではない。結果は後でPRに別記する。

```sh
python3 tools/review_guard/guard.py check --plan .review/plans/T07.json --paths-file actual-paths.json --base-sha <最新baseSHA>
```

再現可能な検査には、そのbaseの検査器・catalog・ledgerを使用する。`--catalog`と`--ledger`に別checkoutのbase側JSONを指定できる。PR自身が変更したルールだけで合格させない。対象head/baseと検査器の版をPRへ記録する。base変更では、同じ計画を未確認のまま使わない。

原因の重複照合では候補JSONの配列を入力する。各候補は`invariant_id`、`cause_key`、`evidence`を持つ。既存IDの返却は再投稿を許可するものではない。異なる表現が同じ原因かの判断、head/baseの鮮度確認、GitHubへの投稿は担当レビュワーが行う。

```sh
python3 tools/review_guard/guard.py triage --candidates candidates.json
```

成功時exit 0、入力不備・未記入・未解決の衝突・古いbase・未計画パスはexit 1。JSONへ未対応の版を渡すと停止する。JSONの重複キー・重複ID・参照不明IDも拒否する。自動で方針を直す機能はない。

CI定義は`adapters/github-actions.yml`に用意したが、現在のGitHub認証に`workflow` scopeがないため、`.github/workflows/`への追加・有効化は行っていない。権限を持つ担当がレビュー後に配置する。テンプレートは検査器の単体試験と台帳の構造検査、baseの条件を使う計画の検査だけを実行する。製品の税計算やアプリの動作を検証するCIではない。初回導入はbaseに検査器がないため`bootstrap`を表示し、独立レビューが必要。
