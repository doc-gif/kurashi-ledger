import { fstatSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatePolicy, hash } from "./lib/review-dispatch/model.ts";
import {
  Store,
  canonicalRoot,
  CLOCK_SKEW_MS,
} from "./lib/review-dispatch/store.ts";
import { checkLockFile, readOwnerPolicy } from "./lib/review-dispatch/host.ts";
import { EVENTS } from "./lib/review-dispatch/webhook.ts";
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
// The trusted copy this file runs from. A policy inside it (or inside any repo/worktree) is refused.
const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function main(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  log: (s: string) => void,
  clock: () => number = Date.now,
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
  // PR48-R010: owner-only policy outside repo/worktree, read from the checked descriptor.
  const root = canonicalRoot(values.get("--root") ?? ""),
    policy = validatePolicy(
      JSON.parse(readOwnerPolicy(values.get("--policy") ?? "", CODE_ROOT)),
    );
  if (policy.mode === "active") throw new Error("Live activation deferred");
  const fd = Number(env["KL_DISPATCH_LOCK_FD"]);
  if (!Number.isInteger(fd) || fd < 3)
    throw new Error("Lifetime supervisor lock required");
  const lockPath = join(dirname(root), `.kurashi-dispatch-${hash(root)}.lock`);
  checkLockFile(lockPath);
  const lock = fstatSync(fd),
    path = statSync(lockPath);
  if (lock.dev !== path.dev || lock.ino !== path.ino)
    throw new Error("Wrong lifetime lock");
  const store = new Store(root, args[0] === "init");
  try {
    // PR48-R009: do not run (or add workers) while the OS clock is behind the stored clock.
    // Wait until it catches up; never move the stored clock back.
    const behind = store.clockBehind(clock());
    if (behind > CLOCK_SKEW_MS) {
      log(
        `時計が保存時刻より約${Math.ceil(behind / 1000)}秒戻っています。workerを増やさず、時計を確認して追いつくまで待ってください（DBの時刻は戻しません）。`,
      );
      return 3;
    }
    store.tick(clock());
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
    // PR48-R011: report lost oversized deliveries once (event names from the allow-list, counts only).
    const lost = new Map<string, number>();
    for (const raw of store.drainOversized()) {
      const event = EVENTS.has(raw) ? raw : "unknown"; // DB values are re-checked, not echoed.
      lost.set(event, (lost.get(event) ?? 0) + 1);
    }
    for (const [event, n] of [...lost].sort())
      log(
        `大きすぎて保存できない配送がありました（${event}、${n}件）。照合で回復できなければ、新しいDraft→Readyが必要です。`,
      );
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
