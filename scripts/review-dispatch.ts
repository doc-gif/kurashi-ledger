import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  futimesSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatePolicy, hash, keyOf, type Policy } from "./lib/review-dispatch/model.ts";
import {
  Store,
  canonicalRoot,
  CLOCK_SKEW_MS,
  ReadyAfterError,
} from "./lib/review-dispatch/store.ts";
import { checkLockFile, readOwnerPolicy } from "./lib/review-dispatch/host.ts";
import { EVENTS, serve, receiverPort } from "./lib/review-dispatch/webhook.ts";
import { Dispatcher } from "./lib/review-dispatch/runtime.ts";
import { GhReader, ghTransport, type Transport } from "./lib/review-dispatch/github.ts";
import { reconcile } from "./lib/review-dispatch/evidence.ts";
import { readTokenFile } from "./lib/review-dispatch/launcher.ts";
import {
  activeStep,
  boundCapability,
  buildMaterials,
  claudeRunner,
  doctorCommand,
  fileDigest,
  inspectRun,
  loadVerifier,
  measureCommand,
  nextKind,
  parseInstall,
  postOnlyRunner,
  startSmall,
  trapLayout,
  trustedGuard,
  type ActiveInstall,
  type SpawnSupervisor,
  type SupervisorChild,
} from "./lib/review-dispatch/active.ts";
import { createClaudeReviewBroker, type SpawnRelay } from "./lib/review-dispatch/claude-broker.ts";
import { createHash } from "node:crypto";
import type { LaunchOptions } from "./lib/review-dispatch/launcher.ts";
import {
  inspectConfigDir,
  managedSettingsPresent,
  seatbeltHost,
  spawnExecutor,
} from "./lib/review-dispatch/doctor.ts";

export const HELP = `レビュー受付（初期状態はoff）
  node scripts/review-dispatch.ts                 off: 読取り・起動・投稿なし
  node scripts/review-dispatch.ts --help          この説明
  python3 tools/review_dispatch/supervisor.py daemon --root <専用ルート> -- <絶対Node> <信頼した写し>/scripts/review-dispatch.ts init --root <専用ルート> --policy <owner管理JSON>
  <絶対Node> <信頼した写し>/scripts/github-app-token.ts --agent codex --purpose dispatch-read --app-id <ID> --installation-id <ID> -- <絶対Python> <信頼した写し>/tools/review_dispatch/supervisor.py daemon --root <専用ルート> -- <絶対Node> <信頼した写し>/scripts/review-dispatch.ts shadow --root <専用ルート> --policy <owner管理JSON> --gh <絶対gh>
shadowは取得・判定・記録だけ。GH_TOKENはレビュー済みdispatch-read wrapperから渡す。

start-small（Issue #50 W4）。手順はownerの導入手順書。init・cycle・doctor・status・releaseはsupervisor.py daemon、serveはsupervisor.py receiverの下で動かす:
  cycle   --root --policy --gh [--install]          照合（shadow）。policyのmodeがactiveなら、粗探しかレビューのJobを1つまで（Claudeだけ）
  serve   --root --policy --secret-file --port      Webhookの受け口（127.0.0.1、1024〜65535で443以外）
  doctor  --root --policy --install --measurement   否定試験。verifiedのときだけcapabilityを記録する
  measure --root --policy --install --out           実CLIでの測定（ownerだけ。実AIを起動する。DBは開かない）
  status  --root --policy                           PRごとの状態（IDと件数だけ）
  release --root --policy --install --run           supervisorの証明で、終わったrunのleaseを外す
Codexの自動起動・修正push・マージはしない。
`;
// The trusted copy this file runs from. A policy inside it (or inside any repo/worktree) is refused.
const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Command = { required: string[]; optional: string[]; lock: "daemon" | "receiver" | null };
const COMMANDS: Record<string, Command> = {
  init: { required: ["--root", "--policy"], optional: [], lock: "daemon" },
  shadow: { required: ["--root", "--policy"], optional: ["--gh"], lock: "daemon" },
  cycle: { required: ["--root", "--policy", "--gh"], optional: ["--install"], lock: "daemon" },
  serve: { required: ["--root", "--policy", "--secret-file", "--port"], optional: [], lock: "receiver" },
  doctor: { required: ["--root", "--policy", "--install", "--measurement"], optional: [], lock: "daemon" },
  measure: { required: ["--root", "--policy", "--install", "--out"], optional: [], lock: null },
  status: { required: ["--root", "--policy"], optional: [], lock: "daemon" },
  release: { required: ["--root", "--policy", "--install", "--run"], optional: [], lock: "daemon" },
};
// Test seams only. The CLI uses the real gh transport, the real spawn and the real files.
export type Deps = {
  transport?: (token: string, gh: string) => Transport;
  spawn?: SpawnSupervisor;
  digest?: (path: string) => string;
  readBytes?: (path: string) => Buffer;
  relaySpawn?: SpawnRelay;
  launch?: LaunchOptions;
  platform?: NodeJS.Platform;
};
// A file of the trusted copy the supervisor runs from (install.supervisor ends in tools/review_dispatch/supervisor.py).
const trustedCopyFile = (install: ActiveInstall, rel: string): string =>
  `${install.supervisor.slice(0, -"/tools/review_dispatch/supervisor.py".length)}/${rel}`;
const realSpawn: SpawnSupervisor = (file, args, env) =>
  spawn(file, args, { env, shell: false, stdio: ["pipe", "pipe", "ignore"] }) as unknown as SupervisorChild;
export const lockPath = (root: string, kind: "daemon" | "receiver"): string =>
  join(dirname(root), `.kurashi-dispatch-${hash(root)}${kind === "receiver" ? ".receiver" : ""}.lock`);
// The cycle trigger (launchd WatchPaths). An empty owner-only regular file; only its time changes.
export function touchTrigger(root: string): void {
  const fd = openSync(join(root, "trigger"), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Trigger is not a file");
    const now = new Date();
    futimesSync(fd, now, now);
  } finally {
    closeSync(fd);
  }
}

export async function main(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  log: (s: string) => void,
  clock: () => number = Date.now,
  deps: Deps = {},
): Promise<number> {
  if (!args.length) {
    log("レビュー受付: off（副作用なし）");
    return 0;
  }
  if (args.length === 1 && args[0] === "--help") {
    log(HELP);
    return 0;
  }
  const command = Object.hasOwn(COMMANDS, args[0] ?? "") ? COMMANDS[args[0]!]! : null;
  if (!command) throw new Error("Live activation deferred");
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const k = args[i],
      v = args[i + 1];
    if (
      !k ||
      !v ||
      ![...command.required, ...command.optional].includes(k) ||
      values.has(k)
    )
      throw new Error("Invalid arguments");
    values.set(k, v);
  }
  if (command.required.some((k) => !values.has(k))) throw new Error("Invalid arguments");
  // PR48-R010: owner-only policy outside repo/worktree, read from the checked descriptor.
  const root = canonicalRoot(values.get("--root") ?? ""),
    policy = validatePolicy(
      JSON.parse(readOwnerPolicy(values.get("--policy") ?? "", CODE_ROOT)),
    );
  // The install record has the same owner-only checks as the policy.
  const readInstall = (): ActiveInstall =>
    parseInstall(readOwnerPolicy(values.get("--install") ?? "", CODE_ROOT), root);
  if (args[0] === "shadow" && policy.mode === "active")
    throw new Error("Live activation deferred"); // active runs through `cycle`
  if (command.lock === null) return await measure(policy, readInstall(), values, log, deps);
  const kind = command.lock;
  const fd = Number(env[kind === "receiver" ? "KL_RECEIVER_LOCK_FD" : "KL_DISPATCH_LOCK_FD"]);
  if (!Number.isInteger(fd) || fd < 3)
    throw new Error("Lifetime supervisor lock required");
  checkLockFile(lockPath(root, kind));
  const lock = fstatSync(fd),
    path = statSync(lockPath(root, kind));
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
    if (args[0] === "status") return status(policy, store, log);
    if (args[0] === "release")
      return await release(policy, store, root, readInstall(), values.get("--run") ?? "", log, deps);
    if (args[0] === "doctor") return await doctor(policy, store, readInstall(), values, log, clock, deps);
    if (policy.mode === "off") {
      log("レビュー受付: off（取得なし）");
      return 0;
    }
    if (args[0] === "serve") return await receive(policy, store, root, values, log, clock);
    // active needs the install record before any GitHub read (fail before side effects).
    const install = args[0] === "cycle" && policy.mode === "active" ? readInstall() : null;
    if (install) startSmall(policy);
    const token = env["GH_TOKEN"];
    if (!token) throw new Error("Reduced dispatch-read token required");
    const transport = (deps.transport ?? ghTransport)(token, values.get("--gh") ?? "");
    const dispatcher = new Dispatcher(policy, store);
    let results: Awaited<ReturnType<typeof reconcile>>;
    try {
      results = await reconcile(new GhReader(policy.repo, transport), policy, store);
    } catch (e) {
      if (!(e instanceof ReadyAfterError)) throw e;
      log(
        `policyのrevisionを変えたのに、readyAfterが前のrevisionの最後の観測（PR #${e.pr}、${new Date(e.observedAt).toISOString()}）より後になっていません。readyAfterを切替の時刻にしてください。照合しません。`,
      );
      return 4;
    }
    for (const result of results) {
      const r = dispatcher.observe(result.snapshot);
      if (r.notice) log(`PR #${result.pr}: ${r.status}`);
    }
    heldNotices(results, store, clock(), log);
    // PR48-R016: the design's retention after each reconcile (payload 7 days, finished job details 30 days).
    store.retain(clock());
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
    if (install) {
      const code = await active(policy, store, root, install, transport, results, log, clock, deps);
      await settleNow(policy, store, transport);
      return code;
    }
    return 0;
  } finally {
    store.close();
  }
}

// One start-small step after the reconcile. Every refusal is logged as an ID; nothing launches.
async function active(
  policy: Policy,
  store: Store,
  root: string,
  install: ActiveInstall,
  transport: Transport,
  results: Awaited<ReturnType<typeof reconcile>>,
  log: (s: string) => void,
  clock: () => number,
  deps: Deps,
): Promise<number> {
  const target = startSmall(policy);
  const current = results.find((r) => r.pr === target.pr);
  if (!current) return 0;
  const fresh = async () => {
    const again = (await reconcile(new GhReader(policy.repo, transport), policy, store)).find(
      (r) => r.pr === target.pr,
    );
    if (!again) throw new Error("Target vanished");
    return again.snapshot;
  };
  const broker = () =>
    createClaudeReviewBroker(policy, install.broker, store, loadVerifier(store), {
      platform: deps.platform ?? process.platform,
      home: install.home,
      ...(deps.relaySpawn ? { spawn: deps.relaySpawn } : {}),
    });
  // A post deferred by an edit mark is recovered first (Codex PR56-R003, red team round 4 RT-1). Posting a
  // result that was produced and signed earlier needs no launch proof: no capability match, no read of the
  // executable or cli.sb. The Broker verifies the stored signature again.
  if (store.deferred(target.key)) {
    const outcome = await activeStep({
      policy,
      store,
      snapshot: current.snapshot,
      runner: postOnlyRunner({ python: install.python, supervisor: install.supervisor, root, spawn: deps.spawn ?? realSpawn }),
      broker: broker(),
      fresh,
      now: clock(),
    });
    log(`PR #${target.pr}: ${outcome}`);
    return 0;
  }
  // Nothing due (not eligible, waiting for RTs, already reviewed): the status command shows why.
  if (!nextKind(store, policy, current.snapshot).kind) return 0;
  const digest = deps.digest ?? fileDigest;
  const executableSha256 = digest(install.claude.executable);
  // Codex PR56-R005: cli.sb is read once. The same bytes are matched with the capability and give the hash the
  // launch is bound to; a later change of the file means no launch (the runner and the supervisor re-check).
  const profileBytes = (deps.readBytes ?? ((p: string) => readFileSync(p)))(install.claude.cliProfile ?? "");
  const bound = boundCapability(
    store.capability("claude"),
    install.claude,
    profileBytes.toString("utf8"),
    executableSha256,
  );
  if (!bound.capability) {
    log(`PR #${target.pr}: 起動しません（${bound.reason}）。doctorを実行してください。`);
    return 0;
  }
  const verifier = loadVerifier(store);
  const runner = claudeRunner({
    policy,
    store,
    root,
    install,
    capability: bound.capability,
    verifier,
    materials: (j, dir) =>
      buildMaterials(
        new GhReader(policy.repo, transport, Date.now, 180000),
        { ...current.snapshot, pair: j.pair },
        dir,
        trustedGuard(install.python, trustedCopyFile(install, "tools/review_guard/guard.py")),
        policy.actors.map((a) => a.id),
      ),
    spawn: deps.spawn ?? realSpawn,
    now: clock,
    // Re-checked by the supervisor immediately before the worker starts (PR #56 red team P3).
    bound: {
      profile: install.claude.cliProfile ?? "",
      profileSha256: createHash("sha256").update(profileBytes).digest("hex"),
      executable: install.claude.executable,
      executableSha256,
    },
    digest,
    ...(deps.launch ? { launch: deps.launch } : {}),
  });
  const outcome = await activeStep({
    policy,
    store,
    snapshot: current.snapshot,
    runner,
    broker: createClaudeReviewBroker(policy, install.broker, store, verifier, {
      platform: deps.platform ?? process.platform,
      home: install.home,
      ...(deps.relaySpawn ? { spawn: deps.relaySpawn } : {}),
    }),
    fresh,
    now: clock(),
  });
  log(`PR #${target.pr}: ${outcome}`);
  return 0;
}
// PR48-R015: a hold made in this cycle has no time yet. One more reconcile settles it to a server time after
// its creation, so the owner's later unpause counts. A failure leaves it pending for the next reconcile.
export async function settleNow(policy: Policy, store: Store, transport: Transport): Promise<void> {
  if (!store.unsettledHolds().size) return;
  try {
    await reconcile(new GhReader(policy.repo, transport), policy, store);
  } catch {
    // The next cycle's reconcile settles it.
  }
}
// PR48-R013: a PR whose observation stays transiently incomplete for an hour is reported to the owner once.
export const HELD_NOTICE_MS = 3600000;
export function heldNotices(
  results: readonly { pr: number; heldSince: number | null }[],
  store: Store,
  now: number,
  log: (s: string) => void,
): void {
  for (const r of results)
    if (r.heldSince !== null && now - r.heldSince >= HELD_NOTICE_MS && store.notice(`held:${r.pr}:${r.heldSince}`))
      log(`PR #${r.pr}: 照合が1時間以上不完全のままです（取得の途中でPRかmainが変わり続けている等）。配送は保留しています。`);
}

async function receive(
  policy: Policy,
  store: Store,
  root: string,
  values: Map<string, string>,
  log: (s: string) => void,
  clock: () => number,
): Promise<number> {
  const port = receiverPort(Number(values.get("--port")));
  if (port === 0) throw new Error("Receiver port must be 1024-65535 and not 443");
  // Same checks as the setup-token file: owner-only, no link, fixed character set. 32 bytes or more.
  const secret = readTokenFile(values.get("--secret-file") ?? "");
  if (Buffer.byteLength(secret) < 32) throw new Error("Webhook secret too short");
  const file = values.get("--policy") ?? "";
  // PR58-R003 / red team round 4 RT-1: each signed delivery is taken with the owner's policy as it is now.
  const load = (): Policy => validatePolicy(JSON.parse(readOwnerPolicy(file, CODE_ROOT)));
  const server = serve(policy, store, Buffer.from(secret, "utf8"), clock, port, () => touchTrigger(root), load, log);
  log(`Webhookの受け口: 127.0.0.1:${port}（mode ${policy.mode}）`);
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  });
  return 0;
}

function status(policy: Policy, store: Store, log: (s: string) => void): number {
  for (const t of policy.targets) {
    const s = store.status(keyOf(policy, t.pr));
    log(
      [
        `PR #${t.pr}: ${s.target?.status ?? "未観測"}（${s.target?.reason ?? "-"}、世代${s.target?.generation ?? 0}）`,
        `  blocked: ${s.blocked ? `${s.blocked.reason}（run ${s.blocked.run}）` : "なし"}、上限での停止: ${s.quota ? "あり" : "なし"}、未処理の編集の印: ${s.marked ? "あり" : "なし"}、不明な投稿: ${s.uncertainOutbox}件`,
        ...(s.pending.length ? [`  停止の時刻が未確定（${s.pending.join("・")}）: 確定する前のreview:pausedの解除は数えません`] : []),
        ...s.jobs.map((j) => `  ${j.kind} 世代${j.generation} ${j.status} run ${j.run}`),
      ].join("\n"),
    );
  }
  log(`capability(claude): ${store.capability("claude") ? "記録あり" : "なし"}`);
  return 0;
}

async function release(
  policy: Policy,
  store: Store,
  root: string,
  install: ActiveInstall,
  run: string,
  log: (s: string) => void,
  deps: Deps,
): Promise<number> {
  const job = store.jobByRun(run);
  if (!job || !policy.targets.some((t) => keyOf(policy, t.pr) === job.key)) throw new Error("Unknown run");
  if (store.status(job.key).uncertainOutbox) {
    log("投稿が不明なOutboxがあります。GitHubで投稿を確かめてから、rollbackしてください（leaseは外しません）。");
    return 4;
  }
  const proof = await inspectRun(
    { python: install.python, supervisor: install.supervisor, root, spawn: deps.spawn ?? realSpawn },
    run,
  );
  store.release(job, { run, ...proof });
  log(`run ${run}のleaseを外しました（blockedは、ownerのreview:pausedの解除までそのままです）。`);
  return 0;
}

// cli.sb is read once and the executable hashed once; the probes run on that file, and the same hashes are
// checked again afterwards (round 4 RT-3). Returns the text and the bound hashes.
export function boundFiles(install: ActiveInstall, deps: Deps) {
  const digest = deps.digest ?? fileDigest;
  const profile = install.claude.cliProfile ?? "";
  const bytes = (deps.readBytes ?? ((p: string) => readFileSync(p)))(profile);
  const bound = {
    profile,
    profileSha256: createHash("sha256").update(bytes).digest("hex"),
    executable: install.claude.executable,
    executableSha256: digest(install.claude.executable),
  };
  const unchanged = () =>
    digest(bound.profile) === bound.profileSha256 && digest(bound.executable) === bound.executableSha256;
  return { text: bytes.toString("utf8"), bound, unchanged };
}

async function doctor(
  policy: Policy,
  store: Store,
  install: ActiveInstall,
  values: Map<string, string>,
  log: (s: string) => void,
  clock: () => number,
  deps: Deps,
): Promise<number> {
  const files = boundFiles(install, deps);
  const host = seatbeltHost({ cliProfile: install.claude.cliProfile ?? "" });
  try {
    const result = await doctorCommand({
      policy,
      store,
      install,
      measurement: readOwnerPolicy(values.get("--measurement") ?? "", CODE_ROOT),
      host,
      authStatus: async (plan) => {
        const r = await spawnExecutor(60000)(plan);
        try {
          return JSON.parse(r.stdout) as unknown;
        } catch {
          return null;
        }
      },
      configProblems: inspectConfigDir(install.claude.configDir),
      managedSettings: managedSettingsPresent(),
      profileText: files.text,
      executableDigest: files.bound.executableSha256,
      unchanged: files.unchanged,
      now: clock(),
    });
    log(`doctor: ${result.state}${result.reasons.length ? `（${result.reasons.join("、")}）` : ""}`);
    return result.state === "verified" ? 0 : 5;
  } finally {
    await host.close();
  }
}

async function measure(
  policy: Policy,
  install: ActiveInstall,
  values: Map<string, string>,
  log: (s: string) => void,
  deps: Deps,
): Promise<number> {
  const files = boundFiles(install, deps);
  const record = await measureCommand({
    policy,
    install,
    bound: files.bound,
    executableDigest: files.bound.executableSha256,
    profileText: files.text,
    unchanged: files.unchanged,
    executor: spawnExecutor(),
    spawn: deps.spawn ?? realSpawn,
    layout: trapLayout,
  });
  // Never overwrites an earlier record; owner-only.
  writeFileSync(values.get("--out") ?? "", `${JSON.stringify(record, null, 1)}\n`, { mode: 0o600, flag: "wx" });
  const outcomes = Object.entries(record.measurement.outcomes).map(([k, v]) => `${k}=${v}`);
  log(`測定: ${outcomes.join("、")}、schema=${record.external.schema}、descendantLock=${record.external.descendantLock}`);
  return 0;
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
