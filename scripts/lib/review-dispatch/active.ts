// Start-small active mode (Issue #50 W4; owner decision start-small, issuecomment-5977629581):
// one target PR, one required reviewer, automatic launch of Claude only (Codex stays disabled),
// fixes by hand, merges by the owner. Each cycle launches at most one job:
//   Ready -> faultfinding job (red-team record, same head/base) -> review job (native Review).
// The owner's install record, the doctor's capability (bound to the exact plan), the materials and the
// Claude runner (through tools/review_dispatch/supervisor.py run-worker) are here.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { GhReader, object, EvidenceError } from "./github.ts";
import {
  argvTemplateHash,
  buildAuthStatus,
  buildLaunch,
  canonicalPath,
  RESULT_SCHEMA_JSON,
  within,
  type LaunchInstall,
  type LaunchOptions,
  type LaunchPlan,
  type LaunchRun,
} from "./launcher.ts";
import { keyOf, type Job, type Policy, type Snapshot } from "./model.ts";
import {
  parseRunKeyLine,
  parseSignedResult,
  provenanceOf,
  runBinding,
  RunVerifier,
} from "./provenance.ts";
import { capabilityReady, Dispatcher, type Capability, type Runner } from "./runtime.ts";
import { parseResult, type ReviewBroker } from "./broker.ts";
import type { ClaudeBrokerInstall } from "./claude-broker.ts";
import {
  createSyntheticKeychain,
  measureCli,
  measurementRecord,
  profileHash,
  removeSyntheticKeychain,
  runDoctor,
  type CliExecutor,
  type DoctorResult,
  type Measurement,
  type SandboxHost,
  type TrapLayout,
} from "./doctor.ts";
import { Store } from "./store.ts";

export class ActiveError extends Error {
  constructor(reason: string) {
    // Fixed reason IDs only: never a path, token or PR text.
    super(`active refused: ${reason}`);
  }
}
const refuse = (reason: string): never => {
  throw new ActiveError(reason);
};

// ---- Policy shape for start-small ----

export function startSmall(p: Policy): { pr: number; actor: number; key: string } {
  if (p.mode !== "active") refuse("mode-not-active");
  return startSmallShape(p);
}
// The same shape without the mode (the doctor and the measurement run before switching to active).
export function startSmallShape(p: Policy): { pr: number; actor: number; key: string } {
  if (p.targets.length !== 1) refuse("start-small-one-target");
  const t = p.targets[0]!;
  if (t.reviewers.length !== 1) refuse("start-small-one-reviewer");
  const a = p.actors.find((x) => x.id === t.reviewers[0]);
  // Codex automatic launch is deferred (owner decision 5977523656); a human reviewer gets no AI job.
  if (a?.kind !== "ai" || a.executor !== "claude") refuse("start-small-claude-only");
  return { pr: t.pr, actor: a!.id, key: keyOf(p, t.pr) };
}

// ---- Owner install record (outside the repository; read with the same checks as the policy) ----

export type ActiveInstall = {
  schema: 1;
  claude: LaunchInstall;
  broker: ClaudeBrokerInstall;
  python: string; // absolute python3
  supervisor: string; // <trusted copy>/tools/review_dispatch/supervisor.py
  runs: string; // owner-only (0700) directory for per-run areas, outside the dispatcher root
  home: string; // the owner's account home (the Broker's token wrapper reads its keychain item)
  workerTimeoutSeconds: number;
};
const INSTALL_KEYS = "broker,claude,home,python,runs,schema,supervisor,workerTimeoutSeconds";
const COPY_SUFFIX = "/tools/review_dispatch/supervisor.py";
export function parseInstall(raw: string, root: string): ActiveInstall {
  let v: ActiveInstall;
  try {
    v = JSON.parse(raw) as ActiveInstall;
  } catch {
    return refuse("install-unreadable");
  }
  if (!v || typeof v !== "object" || Object.keys(v).sort().join() !== INSTALL_KEYS || v.schema !== 1)
    refuse("install-shape");
  if (
    ![v.python, v.supervisor, v.runs, v.home].every(canonicalPath) ||
    !v.supervisor.endsWith(COPY_SUFFIX) ||
    !Number.isInteger(v.workerTimeoutSeconds) ||
    v.workerTimeoutSeconds < 60 ||
    v.workerTimeoutSeconds > 4 * 3600
  )
    refuse("install-paths");
  const copy = v.supervisor.slice(0, -COPY_SUFFIX.length);
  // Supervisor, token wrapper and relay come from the same trusted copy.
  if (!v.broker || v.broker.wrapper !== `${copy}/scripts/github-app-token.ts`) refuse("install-copy");
  if (!v.claude || v.claude.backend !== "claude") refuse("install-claude-only");
  // Worker areas never overlap the dispatcher root, and the root is a protected root of the launcher.
  if (within(v.runs, root) || within(root, v.runs)) refuse("runs-overlap-root");
  if (!Array.isArray(v.claude.protectedRoots) || !v.claude.protectedRoots.some((p) => within(root, p)))
    refuse("root-not-protected");
  return structuredClone(v);
}

// ---- Capability bound to the plan (W1 PR checklist: "doctorのhashを、起動する計画に結び付ける") ----

export function fileDigest(path: string): string {
  const h = createHash("sha256"),
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    buffer = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n <= 0) break;
      h.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}
// The doctor's record launches only if the version, the executable's sha256, the cli.sb text and the
// argv template it measured are exactly what this launch uses. Codex never passes (capabilityReady).
export function boundCapability(
  value: unknown,
  install: LaunchInstall,
  profileText: string,
  executableDigest: string,
): { capability: Capability | null; reason: string } {
  const c = value as Capability | null;
  if (!c || typeof c !== "object") return { capability: null, reason: "capability-missing" };
  if (c.backend !== "claude" || !capabilityReady(c)) return { capability: null, reason: "capability-not-ready" };
  if (c.version !== install.version) return { capability: null, reason: "capability-version" };
  if (c.codeHash !== executableDigest) return { capability: null, reason: "capability-executable" };
  if (c.profileHash !== profileHash(profileText)) return { capability: null, reason: "capability-profile" };
  if (c.argvHash !== argvTemplateHash(install)) return { capability: null, reason: "capability-argv" };
  return { capability: c, reason: "bound" };
}

// ---- Materials (untrusted data with neutral names; launcher.ts refuses CLI configuration names) ----

const MAX_FILES = 299; // compare lists at most 300 files
const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
// Repository rules for the reviewer, from the base. Renamed: AGENTS.md is never a material name.
export const CONTEXT_FILES: readonly [string, string][] = [
  ["AGENTS.md", "agent-rules.md"],
  [".review/findings.json", "findings.json"],
  [".review/invariants.json", "invariants.json"],
  ["docs/pr-review-loop.md", "review-loop.md"],
  ["docs/review-prevention.md", "review-prevention.md"],
];
const encodePath = (path: string): string => {
  if (!path || path.split("/").some((s) => !s || s === "." || s === ".."))
    throw new EvidenceError();
  return path.split("/").map(encodeURIComponent).join("/");
};
type Content = { bytes: Buffer | null; note: string | null };
async function content(reader: GhReader, path: string, ref: string): Promise<Content> {
  const v = await reader.object(`contents/${encodePath(path)}?ref=${ref}`);
  if (v["type"] !== "file") return { bytes: null, note: "not-a-file" };
  if (v["encoding"] !== "base64" || typeof v["content"] !== "string")
    return { bytes: null, note: "too-large" };
  const bytes = Buffer.from(v["content"], "base64");
  return bytes.length > MAX_FILE ? { bytes: null, note: "too-large" } : { bytes, note: null };
}
export async function buildMaterials(
  reader: GhReader,
  s: Pick<Snapshot, "pr" | "pair">,
  dir: string,
): Promise<{ files: number; bytes: number }> {
  let total = 0;
  const write = (rel: string, data: Buffer | string) => {
    const size = Buffer.byteLength(data);
    total += size;
    if (total > MAX_TOTAL) refuse("materials-too-large");
    writeFileSync(join(dir, rel), data, { mode: 0o600, flag: "wx" });
  };
  for (const d of ["pr", "context"]) mkdirSync(join(dir, d), { mode: 0o700 });
  const pr = await reader.object(`pulls/${s.pr}`);
  const title = typeof pr["title"] === "string" ? pr["title"] : "",
    body = typeof pr["body"] === "string" ? pr["body"] : "";
  write("pr/description.txt", `${title}\n\n${body}\n`);
  const compare = await reader.object(`compare/${s.pair.base}...${s.pair.head}`);
  const files = compare["files"];
  if (!Array.isArray(files)) throw new EvidenceError();
  if (files.length > MAX_FILES) refuse("materials-too-many-files");
  const index: Record<string, unknown>[] = [];
  for (const [i, value] of files.entries()) {
    const f = object(value),
      path = f["filename"],
      status = f["status"];
    if (typeof path !== "string" || typeof status !== "string") throw new EvidenceError();
    const n = String(i + 1).padStart(3, "0");
    const entry: Record<string, unknown> = { n, path, status, diff: null, head: null, note: null };
    if (typeof f["previous_filename"] === "string") entry["previous"] = f["previous_filename"];
    if (typeof f["patch"] === "string") {
      write(`pr/diff-${n}.patch`, f["patch"]);
      entry["diff"] = `pr/diff-${n}.patch`;
    } else entry["note"] = "no-patch";
    if (status !== "removed") {
      const c = await content(reader, path, s.pair.head);
      if (c.bytes) {
        write(`pr/head-${n}.txt`, c.bytes);
        entry["head"] = `pr/head-${n}.txt`;
      } else entry["note"] = c.note;
    }
    index.push(entry);
  }
  write("pr/index.json", `${JSON.stringify({ head: s.pair.head, base: s.pair.base, files: index }, null, 1)}\n`);
  for (const [path, name] of CONTEXT_FILES) {
    const c = await content(reader, path, s.pair.base);
    if (c.bytes) write(`context/${name}`, c.bytes);
  }
  return { files: index.length, bytes: total };
}

// ---- Claude runner through supervisor.py run-worker ----

export type SupervisorChild = {
  stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", f: () => void): unknown };
  stdout: { on(event: "data", f: (chunk: Buffer) => void): unknown };
  once(event: "close", f: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};
export type SpawnSupervisor = (file: string, args: string[], env: Record<string, string>) => SupervisorChild;
export const SUPERVISOR_ENV: Readonly<Record<string, string>> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };

// Collects a child's stdout as lines; resolves on close with the exit code. A line limit stops a flood.
function lines(child: SupervisorChild, limit: number, onLine: (line: string, index: number) => void) {
  return new Promise<number | null>((resolve) => {
    let buffer = "",
      count = 0,
      size = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        child.kill("SIGTERM");
        return;
      }
      buffer += chunk.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        onLine(line, count++);
      }
    });
    child.once("close", (code) => {
      if (buffer) onLine(buffer, count++);
      resolve(code);
    });
  });
}
const OUTPUT_LIMIT = 2 * 1024 * 1024;

// A fresh per-run area under the owner's runs directory (materials, the CLI's HOME and TMP).
export function newRunArea(runs: string, name: string): { area: string; run: LaunchRun } {
  const st = lstatSync(runs);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    (process.getuid && st.uid !== process.getuid()) ||
    (st.mode & 0o077) !== 0
  )
    refuse("runs-directory");
  const area = join(runs, name);
  mkdirSync(area, { mode: 0o700 }); // a new area: an existing one is never reused
  const run: LaunchRun = {
    materials: join(area, "materials"),
    home: join(area, "home"),
    tmp: join(area, "tmp"),
    schemaFile: join(area, "tmp", "result-schema.json"),
  };
  for (const dir of [run.materials, run.home, run.tmp]) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(run.schemaFile, RESULT_SCHEMA_JSON, { mode: 0o600, flag: "wx" });
  return { area, run };
}
// Removes only this run's own directory, checked not to be a link.
export function removeRunArea(area: string): void {
  const st = lstatSync(area);
  if (st.isDirectory() && !st.isSymbolicLink()) rmSync(area, { recursive: true, force: true });
}
type Supervised = { keyed: boolean; signed: string | null; treeEnded: boolean; uncertain: boolean };
export type SupervisorCommand = { python: string; supervisor: string; root: string; spawn: SpawnSupervisor };
const supervisor = (c: SupervisorCommand, mode: string, extra: string[]) =>
  c.spawn(c.python, [c.supervisor, mode, "--root", c.root, ...extra], { ...SUPERVISOR_ENV });
export async function inspectRun(
  c: SupervisorCommand,
  run: string,
): Promise<{ treeEnded: boolean; neverStarted: boolean; uncertain: boolean }> {
  let out = "";
  const code = await lines(supervisor(c, "inspect", ["--run", run]), 64 * 1024, (l) => (out += l));
  try {
    const v = JSON.parse(out) as Record<string, unknown>;
    if (code === 0 && v["run"] === run)
      return {
        treeEnded: v["treeEnded"] === true,
        neverStarted: v["neverStarted"] === true,
        uncertain: v["uncertain"] !== false,
      };
  } catch {
    // Unknown state stays uncertain.
  }
  return { treeEnded: false, neverStarted: false, uncertain: true };
}
// supervisor.py run-worker: the plan (with the setup-token) goes only through the pipe, never argv, files
// or logs. `onKey` must persist the commitment; only then the supervisor gets "ack" and starts the worker.
export async function superviseRun(
  c: SupervisorCommand,
  j: Job,
  plan: ReturnType<typeof buildLaunch>,
  timeoutSeconds: number,
  onKey: (record: ReturnType<typeof parseRunKeyLine>) => void,
): Promise<Supervised> {
  const child = supervisor(c, "run-worker", [
    "--run",
    j.run,
    "--binding",
    runBinding(j),
    "--extract",
    "claude-json",
    "--timeout",
    String(timeoutSeconds),
  ]);
  child.stdin.on("error", () => {});
  let signed: string | null = null,
    keyed = false;
  const exit = lines(child, OUTPUT_LIMIT, (line, index) => {
    if (index === 0) {
      // Any failure: no ack, so the supervisor never starts the worker.
      try {
        onKey(parseRunKeyLine(line));
        keyed = true;
        child.stdin.write("ack\n");
      } catch {
        keyed = false;
      } finally {
        child.stdin.end();
      }
    } else signed = line;
  });
  child.stdin.write(
    `${JSON.stringify({ file: plan.file, args: plan.args, env: plan.env, cwd: plan.cwd, stdin: plan.stdin })}\n`,
  );
  await exit;
  const state = await inspectRun(c, j.run);
  return { keyed, signed, treeEnded: state.treeEnded, uncertain: state.uncertain };
}

export type ClaudeRunnerDeps = {
  policy: Policy;
  store: Store;
  root: string;
  install: ActiveInstall;
  capability: Capability;
  verifier: RunVerifier;
  materials: (j: Job, dir: string) => Promise<void>;
  spawn: SpawnSupervisor;
  now: () => number;
  launch?: LaunchOptions; // tests only (platform, token reader)
};
export function claudeRunner(d: ClaudeRunnerDeps): Runner {
  const command: SupervisorCommand = {
    python: d.install.python,
    supervisor: d.install.supervisor,
    root: d.root,
    spawn: d.spawn,
  };
  return {
    capability: { ...d.capability, backend: "claude" },
    async run(j) {
      const { area, run } = newRunArea(d.install.runs, j.run);
      try {
        let plan: ReturnType<typeof buildLaunch>;
        try {
          await d.materials(j, run.materials);
          plan = buildLaunch(d.policy, j, d.install.claude, run, d.launch ?? {});
        } catch {
          // Refused before any process started (too many files, a CLI configuration name, an unreadable
          // token): the job is proven never started.
          return { result: "", treeEnded: false, uncertain: false, neverStarted: true, origin: null };
        }
        // Persist the commitment before the supervisor may start the worker (W4 row 2).
        const r = await superviseRun(command, j, plan, d.install.workerTimeoutSeconds, (record) => {
          d.store.saveRunKey(j, record, d.now());
          d.verifier.register(j, record);
        });
        if (!r.keyed || r.signed === null || !r.treeEnded || r.uncertain)
          return { result: "", treeEnded: r.treeEnded, uncertain: true, origin: null };
        const { raw, origin } = provenanceOf(j, parseSignedResult(r.signed));
        return { result: raw, treeEnded: true, uncertain: false, origin };
      } finally {
        removeRunArea(area);
      }
    },
    async redact(j, resultHash) {
      const code = await lines(
        supervisor(command, "redact", ["--run", j.run, "--result-hash", resultHash]),
        64 * 1024,
        () => {},
      );
      if (code !== 0) throw new ActiveError("redact-failed");
    },
  };
}
// Verifier with every persisted commitment (a restarted dispatcher verifies runs it did not start).
export function loadVerifier(store: Store): RunVerifier {
  const v = new RunVerifier();
  for (const { job, record } of store.runKeys()) v.register(job, record);
  return v;
}

// ---- One start-small step ----

export type NextKind = "faultfinding" | "review";
// Faultfinding first (same head/base, after Ready; owner decision RT-timing), then the review, at most
// once each per generation. Open RTs, an unprocessed edit/delete mark or a non-eligible target: nothing.
export function nextKind(store: Store, p: Policy, s: Snapshot): { kind: NextKind | null; reason: string } {
  const key = keyOf(p, s.pr),
    t = store.target(key);
  if (store.blocked(key)) return { kind: null, reason: "blocked-owner-required" };
  if (store.quotaPaused(key)) return { kind: null, reason: "quota-owner-required" };
  if (!t || t.status !== "eligible" || t.paused) return { kind: null, reason: t?.reason ?? "unknown" };
  if (store.marked(key)) return { kind: null, reason: "edit-mark-pending" };
  if (!s.faultfinding)
    return store.hasJob(key, t.generation, "faultfinding")
      ? { kind: null, reason: "faultfinding-without-record" }
      : { kind: "faultfinding", reason: "ready" };
  if (s.faultfinding.unresolved.length) return { kind: null, reason: "faultfinding-open" };
  return store.hasJob(key, t.generation, "review")
    ? { kind: null, reason: "review-done" }
    : { kind: "review", reason: "faultfinding-clear" };
}
export async function activeStep(d: {
  policy: Policy;
  store: Store;
  snapshot: Snapshot;
  runner: Runner;
  broker: Pick<ReviewBroker, "submit">;
  fresh: () => Promise<Snapshot>;
  now: number;
}): Promise<string> {
  const { actor } = startSmall(d.policy);
  const next = nextKind(d.store, d.policy, d.snapshot);
  if (!next.kind) return `idle:${next.reason}`;
  const outcome = await new Dispatcher(d.policy, d.store).activeCycle(
    d.snapshot,
    actor,
    next.kind,
    d.runner,
    d.broker,
    d.fresh,
    d.now,
  );
  return `${next.kind}:${outcome}`;
}

// A synthetic job for the doctor and the owner's measurement (never claimed, never posted).
export function measurementJob(p: Policy, kind: "review" | "faultfinding" = "review"): Job {
  const { actor, key } = startSmallShape(p);
  return {
    id: randomUUID(),
    key,
    generation: 0,
    actor,
    kind,
    run: randomUUID(),
    pair: { head: "0".repeat(40), base: "0".repeat(40) },
    policy: p.revision,
  };
}
export const readText = (path: string): string => readFileSync(path, "utf8");

// ---- Owner tools: measurement record and doctor (real CLI and real Seatbelt; never in CI) ----

// The owner's measurement file (measure CLI): the measured probe outcomes bound to the hashes, plus the
// two pieces of evidence the doctor takes from outside (result schema, descendant lock).
export type MeasurementFile = {
  schema: 1;
  measurement: Measurement;
  external: { schema: boolean; descendantLock: boolean };
};
export function parseMeasurementFile(raw: string | null): MeasurementFile | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as MeasurementFile;
    if (
      !v ||
      Object.keys(v).sort().join() !== "external,measurement,schema" ||
      v.schema !== 1 ||
      !v.external ||
      Object.keys(v.external).sort().join() !== "descendantLock,schema" ||
      typeof v.external.schema !== "boolean" ||
      typeof v.external.descendantLock !== "boolean"
    )
      return null;
    return v;
  } catch {
    return null;
  }
}
// Runs the doctor for the installed Claude and stores its capability. Anything but "verified" removes the
// stored capability, so an older pass is never used with a changed CLI, profile, flags or measurement.
export async function doctorCommand(d: {
  policy: Policy;
  store: Store;
  install: ActiveInstall;
  measurement: string | null;
  host: SandboxHost;
  authStatus: (plan: LaunchPlan) => Promise<unknown>;
  configProblems: string[];
  managedSettings: boolean;
  profileText: string;
  executableDigest: string;
  now: number;
  launch?: LaunchOptions;
}): Promise<DoctorResult> {
  const job = measurementJob(d.policy);
  const { area, run } = newRunArea(d.install.runs, `doctor-${job.run}`);
  try {
    const plan = buildLaunch(d.policy, job, d.install.claude, run, d.launch ?? {});
    const file = parseMeasurementFile(d.measurement);
    const result = await runDoctor({
      backend: "claude",
      version: d.install.claude.version,
      codeHash: d.executableDigest,
      profileHash: profileHash(d.profileText),
      launch: { plan, install: d.install.claude, run, argvHash: argvTemplateHash(d.install.claude) },
      measurement: file?.measurement ?? null,
      external: file?.external ?? { schema: false, descendantLock: false },
      host: d.host,
      claude: {
        authStatus: await d.authStatus(buildAuthStatus(d.install.claude, run, d.launch ?? {})),
        configDir: d.install.claude.configDir,
        configProblems: d.configProblems,
        managedSettings: d.managedSettings,
      },
      profileText: d.profileText,
    });
    d.store.saveCapability("claude", result.state === "verified" ? result.capability : null, d.now);
    return result;
  } finally {
    removeRunArea(area);
  }
}

// Synthetic trap layout for measureCli (doctor.ts): stand-in credentials outside every worker area, a
// loopback listener and a stand-in control socket that count connections, and an App-key-shaped keychain
// item. Nothing real is read.
export async function trapLayout(root: string): Promise<TrapLayout & { close(): Promise<void> }> {
  const dir = (...p: string[]) => {
    const d = join(root, ...p);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  };
  const secrets = dir("secrets"),
    targets = dir("targets");
  let hits = 0,
    control = 0;
  const web = createHttpServer((_req, res) => {
    hits++;
    res.end();
  });
  await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", () => resolve()));
  const address = web.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const socket = join(dir("control"), "control.sock");
  const sock = createNetServer((c) => {
    control++;
    c.end();
  });
  await new Promise<void>((resolve) => sock.listen(socket, () => resolve()));
  const keychain = createSyntheticKeychain(dir("keychain"));
  return {
    root,
    secretFiles: {
      key: join(secrets, "app-key.pem"),
      token: join(secrets, "setup-token"),
      gh: join(secrets, "gh-hosts.yml"),
      ssh: join(secrets, "id_synthetic"),
      otherAi: join(secrets, "other-ai.json"),
    },
    writeTargets: { db: join(targets, "dispatch.sqlite"), policy: join(targets, "policy.json") },
    keychain,
    network: { url: `http://127.0.0.1:${port}/probe`, hits: () => hits },
    supervisor: { socket, hits: () => control },
    async close() {
      if (keychain) removeSyntheticKeychain(keychain);
      await new Promise<void>((resolve) => web.close(() => resolve()));
      await new Promise<void>((resolve) => sock.close(() => resolve()));
    },
  };
}
// The owner's measurement (measure CLI). Real CLI, real Seatbelt, real setup-token: owner only.
// 1. measureCli (doctor.ts) through the production argv template.
// 2. One benign job through supervisor.py run-worker with the production plan: its structured result must
//    parse as this job's result (schema) and the supervisor must prove the whole tree ended (descendant lock).
export async function measureCommand(d: {
  policy: Policy;
  install: ActiveInstall;
  executableDigest: string;
  profileText: string;
  executor: CliExecutor;
  spawn: SpawnSupervisor;
  layout: (root: string) => Promise<TrapLayout & { close(): Promise<void> }>;
  launch?: LaunchOptions;
}): Promise<MeasurementFile> {
  const job = measurementJob(d.policy);
  const { area } = newRunArea(d.install.runs, `measure-${job.run}`);
  try {
    const layout = await d.layout(join(area, "trap"));
    let outcomes: Awaited<ReturnType<typeof measureCli>>;
    try {
      outcomes = await measureCli(d.policy, job, d.install.claude, layout, d.executor, d.launch ?? {});
    } finally {
      await layout.close();
    }
    // A throwaway supervisor root for the benign run (never the dispatcher root).
    const root = join(area, "supervisor");
    mkdirSync(root, { mode: 0o700 });
    const benign = newRunArea(area, "benign");
    writeFileSync(join(benign.run.materials, "readme.txt"), "Synthetic pull request for the owner's measurement.\n", { mode: 0o600 });
    const plan = buildLaunch(d.policy, job, d.install.claude, benign.run, d.launch ?? {});
    const verifier = new RunVerifier();
    const r = await superviseRun(
      { python: d.install.python, supervisor: d.install.supervisor, root, spawn: d.spawn },
      job,
      plan,
      d.install.workerTimeoutSeconds,
      (record) => verifier.register(job, record),
    );
    let schema = false;
    if (r.keyed && r.signed !== null && r.treeEnded && !r.uncertain) {
      try {
        const { raw, origin } = provenanceOf(job, parseSignedResult(r.signed));
        parseResult(raw, job);
        schema = verifier.verify(job, raw, origin);
      } catch {
        schema = false;
      }
    }
    return {
      schema: 1,
      measurement: measurementRecord(d.install.claude, d.executableDigest, profileHash(d.profileText), outcomes),
      external: { schema, descendantLock: r.treeEnded && !r.uncertain },
    };
  } finally {
    removeRunArea(area);
  }
}
