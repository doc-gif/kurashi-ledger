import { readFileSync, fstatSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePolicy, hash } from "./lib/review-dispatch/model.ts";
import { Store, canonicalRoot } from "./lib/review-dispatch/store.ts";
import { Dispatcher } from "./lib/review-dispatch/runtime.ts";
import { GhReader, ghTransport } from "./lib/review-dispatch/github.ts";
import { reconcile } from "./lib/review-dispatch/evidence.ts";
export const HELP = `レビュー受付（初期状態はoff）
  node scripts/review-dispatch.ts                 off: 読取り・起動・投稿なし
  node scripts/review-dispatch.ts --help          この説明
  python3 tools/review_dispatch/supervisor.py daemon --root <専用ルート> -- <絶対Node> <信頼した写し>/scripts/review-dispatch.ts init --root <専用ルート> --policy <owner管理JSON>
  <絶対Node> <信頼した写し>/scripts/github-app-token.ts --agent codex --purpose dispatch-read --app-id <ID> --installation-id <ID> -- <絶対Python> <信頼した写し>/tools/review_dispatch/supervisor.py daemon --root <専用ルート> -- <絶対Node> <信頼した写し>/scripts/review-dispatch.ts shadow --root <専用ルート> --policy <owner管理JSON> --gh <絶対gh>
shadowは取得・判定・記録だけ。GH_TOKENはレビュー済みdispatch-read wrapperから渡す。
active/実AI/修正push/投稿のCLIは本導入の別レビュー・設定まで無効。
`;
export async function main(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  log: (s: string) => void,
): Promise<number> {
  if (!args.length) {
    log("レビュー受付: off（副作用なし）");
    return 0;
  }
  if (args.length === 1 && args[0] === "--help") {
    log(HELP);
    return 0;
  }
  if (!["init", "shadow"].includes(args[0] ?? ""))
    throw new Error("Live activation deferred");
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i],
      v = args[i + 1];
    if (
      !k ||
      !v ||
      !["--root", "--policy", "--gh"].includes(k) ||
      values.has(k)
    )
      throw new Error("Invalid arguments");
    values.set(k, v);
  }
  const root = canonicalRoot(values.get("--root") ?? ""),
    policy = validatePolicy(
      JSON.parse(readFileSync(values.get("--policy") ?? "", "utf8")),
    );
  if (policy.mode === "active") throw new Error("Live activation deferred");
  const fd = Number(env["KL_DISPATCH_LOCK_FD"]);
  if (!Number.isInteger(fd) || fd < 3)
    throw new Error("Lifetime supervisor lock required");
  const lock = fstatSync(fd),
    path = statSync(
      join(dirname(root), `.kurashi-dispatch-${hash(root)}.lock`),
    );
  if (lock.dev !== path.dev || lock.ino !== path.ino)
    throw new Error("Wrong lifetime lock");
  const store = new Store(root, args[0] === "init");
  try {
    if (args[0] === "init") {
      log("専用DBを初期化しました（実AI・投稿なし）。");
      return 0;
    }
    if (policy.mode === "off") {
      log("レビュー受付: off（取得なし）");
      return 0;
    }
    const token = env["GH_TOKEN"];
    if (!token) throw new Error("Reduced dispatch-read token required");
    const reader = new GhReader(
        policy.repo,
        ghTransport(token, values.get("--gh") ?? ""),
      ),
      dispatcher = new Dispatcher(policy, store);
    for (const result of await reconcile(reader, policy, store)) {
      const r = dispatcher.observe(result.snapshot);
      if (r.notice) log(`PR #${result.pr}: ${r.status}`);
    }
    return 0;
  } finally {
    store.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env, (s) =>
      console.log(s),
    );
  } catch {
    console.error(
      "レビュー受付を保留しました。設定・認証・証跡・排他を確認してください（詳細や秘密は表示しません）。",
    );
    process.exitCode = 2;
  }
}
