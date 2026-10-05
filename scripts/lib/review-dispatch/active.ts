// Start-small active mode (Issue #50 W4; owner decision start-small, issuecomment-5977629581):
// one target PR, one required reviewer, automatic launch of Claude only (Codex stays disabled),
// fixes by hand, merges by the owner. Each cycle launches at most one job:
//   Ready -> faultfinding job (red-team record, same head/base) -> review job (native Review).
// The owner's install record, the doctor's capability (bound to the exact plan), the materials and the
// Claude runner (through tools/review_dispatch/supervisor.py run-worker) are here.
import { spawnSync } from "node:child_process";
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
// `guard`: the trusted guard check accepted the PR's plan ("ok": exit 0 with its JSON result), refused it
// ("refused": exit 1), could not give a verdict ("unavailable"), or there is no single plan to check
// ("none"). "refused" and "unavailable" keep the red team unresolved (red team rounds 4 and 6).
export type GuardState = "ok" | "refused" | "unavailable" | "none";
export type MaterialsMeta = {
  planPath: string | null;
  ledger: string[];
  previousRts: string[];
  guard: GuardState;
};
// The trusted guard check (tools/review_guard/guard.py from the trusted copy). The plan is placed under its own
// repository path inside `cwd` (`.review/plans/<name>`), so guard.py's file name check and its `--plan` versus
// changed-path comparison see the same path as in the PR (red team round 6 RT-1).
export type GuardCheck = (input: {
  cwd: string;
  plan: string; // repository-relative, resolved against cwd
  paths: string;
  base: string;
  catalog: string;
  ledger: string;
}) => { state: "ok" | "refused" | "unavailable"; output: string };
// A red-team record starts with its marker (any spacing) on the first non-empty line. A comment that only
// quotes or mentions the marker further down is not a record (red team round 5).
export const RED_TEAM_MARK = /^\s*<!--\s*kurashi-ledger:red-team:v1\s*-->[ \t]*(?:\r?\n|$)/;
// Every RT ID anywhere in a record (bullets, tables, "[RT-1][P2]", prose), not only "RT-1:" at a line start.
export const RT_ID = /\bRT-([1-9][0-9]{0,2})\b/g;
// Every cause of the base ledger, as `invariant_id/cause_key` (the red-team table's rows).
export function ledgerCauses(raw: Buffer | null): string[] {
  if (!raw) return refuse("materials-incomplete");
  let v: { findings?: unknown };
  try {
    v = JSON.parse(raw.toString("utf8")) as { findings?: unknown };
  } catch {
    return refuse("materials-incomplete");
  }
  if (!Array.isArray(v.findings)) refuse("materials-incomplete");
  const out = new Set<string>();
  for (const f of v.findings as Record<string, unknown>[]) {
    const id = f?.["invariant_id"],
      cause = f?.["cause_key"];
    if (typeof id !== "string" || typeof cause !== "string") refuse("materials-incomplete");
    out.add(`${id as string}/${cause as string}`);
  }
  return [...out].sort();
}
export async function buildMaterials(
  reader: GhReader,
  s: Pick<Snapshot, "pr" | "pair" | "reviews" | "openFindings">,
  dir: string,
  guard: GuardCheck | null = null,
  // Policy participants: only their earlier red-team records are materials and evidence (Codex PR56-R004).
  registered: readonly number[] = [],
): Promise<{ files: number; bytes: number } & MaterialsMeta> {
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
  const changed = new Set<string>();
  const plans: { path: string; bytes: Buffer }[] = [];
  for (const [i, value] of files.entries()) {
    const f = object(value),
      path = f["filename"],
      status = f["status"];
    if (typeof path !== "string" || typeof status !== "string") throw new EvidenceError();
    changed.add(path);
    const n = String(i + 1).padStart(3, "0");
    const entry: Record<string, unknown> = { n, path, status, diff: null, head: null };
    if (typeof f["previous_filename"] === "string") {
      entry["previous"] = f["previous_filename"];
      changed.add(f["previous_filename"]);
    }
    // PR #56 red team P2: a file without its diff, or a kept file without its content, is a gap the
    // reviewer cannot see. Such a job never starts (only a pure rename has no diff).
    if (typeof f["patch"] === "string") {
      write(`pr/diff-${n}.patch`, f["patch"]);
      entry["diff"] = `pr/diff-${n}.patch`;
    } else if (!(status === "renamed" && f["changes"] === 0)) refuse("materials-incomplete");
    if (status !== "removed") {
      const c = await content(reader, path, s.pair.head);
      if (!c.bytes) refuse("materials-incomplete");
      write(`pr/head-${n}.txt`, c.bytes!);
      entry["head"] = `pr/head-${n}.txt`;
      if (/^\.review\/plans\/[^/]+\.json$/.test(path)) plans.push({ path, bytes: c.bytes! });
    }
    index.push(entry);
  }
  write("pr/index.json", `${JSON.stringify({ head: s.pair.head, base: s.pair.base, files: index }, null, 1)}\n`);
  // Others' change requests and unresolved findings (PR #56 red team P2): a review sees what blocks approval.
  const requests = [...new Map(s.reviews.filter((r) => r.state !== "COMMENTED").map((r) => [r.actor, r])).values()]
    .filter((r) => r.state === "CHANGES_REQUESTED")
    .map((r) => ({ actor: r.actor, review: r.id }));
  write("pr/open-findings.json", `${JSON.stringify({ changesRequested: requests, findings: s.openFindings ?? [] }, null, 1)}\n`);
  // Earlier red-team records of this PR (conversation comments and Reviews) by registered participants, for
  // the RT re-check. A record by anyone else is neither material nor evidence.
  const earlier: string[] = [];
  const previousRts = new Set<string>();
  for (const [kind, path] of [
    ["comment", `issues/${s.pr}/comments?per_page=100`],
    ["review", `pulls/${s.pr}/reviews?per_page=100`],
  ] as const)
    for (const v of await reader.pages(path)) {
      const o = object(v);
      const user = o["user"] && typeof o["user"] === "object" ? (o["user"] as Record<string, unknown>)["id"] : null;
      if (
        typeof o["body"] !== "string" ||
        !RED_TEAM_MARK.test(o["body"]) ||
        !Number.isSafeInteger(user) ||
        !registered.includes(Number(user))
      )
        continue;
      earlier.push(`## record-${kind}-${String(o["id"])}\n\n${o["body"]}\n`);
      const body = o["body"].normalize("NFKC");
      const ids = [...body.matchAll(RT_ID)].map((m) => `RT-${m[1]}`);
      for (const id of ids) previousRts.add(id);
      // Every record is also re-checked as a whole (red team round 6 RT-2): finding formats vary, and a
      // finding without an RT ID must not be skipped.
      previousRts.add(`record-${kind}-${String(o["id"])}`);
    }
  write("pr/previous-redteam.md", earlier.length ? earlier.join("\n") : "なし\n");
  const base: Record<string, Buffer | null> = {};
  for (const [path, name] of CONTEXT_FILES) {
    const c = await content(reader, path, s.pair.base);
    base[path] = c.bytes;
    if (c.bytes) write(`context/${name}`, c.bytes);
  }
  const ledger = ledgerCauses(base[".review/findings.json"] ?? null);
  const plan = plans.length === 1 ? plans[0]! : null;
  let guardOut = JSON.stringify({ result: plans.length ? "multiple-plans" : "no-plan" });
  let guardState: GuardState = plans.length ? "unavailable" : "none";
  if (plan && guard && base[".review/invariants.json"]) {
    const work = join(dir, "context", "guard-input");
    mkdirSync(join(work, ".review", "plans"), { recursive: true, mode: 0o700 });
    const input = (name: string, data: Buffer | string) => {
      writeFileSync(join(work, name), data, { mode: 0o600, flag: "wx" });
      return join(work, name);
    };
    // The plan keeps its repository path (only .review/plans/<name>.json reaches here; the name has no "/").
    input(plan.path, plan.bytes);
    const g = guard({
      cwd: work,
      plan: plan.path,
      paths: input("paths.json", JSON.stringify([...changed].sort())),
      base: s.pair.base,
      catalog: input("invariants.json", base[".review/invariants.json"]!),
      ledger: input("findings.json", base[".review/findings.json"]!),
    });
    guardOut = g.output;
    guardState = g.state;
  }
  write("context/guard-check.json", `${guardOut.trim()}\n`);
  return {
    files: index.length,
    bytes: total,
    planPath: plan?.path ?? null,
    ledger,
    previousRts: [...previousRts].sort(),
    guard: guardState,
  };
}
// guard.py check from the trusted copy: fixed interpreter and argv, no shell, minimal env, bounded time.
export function trustedGuard(python: string, guardPy: string): GuardCheck {
  return (i) => {
    const r = spawnSync(
      python,
      [guardPy, "check", "--plan", i.plan, "--paths-file", i.paths, "--base-sha", i.base, "--catalog", i.catalog, "--ledger", i.ledger],
      { cwd: i.cwd, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } },
    );
    // "ok" only for exit 0 with the JSON check output; exit 1 is guard.py's refusal; anything else has no verdict.
    let state: "ok" | "refused" | "unavailable" = "unavailable";
    if (!r.error && r.signal === null && r.status === 0) {
      try {
        const v = JSON.parse(r.stdout) as Record<string, unknown>;
        if (v && typeof v === "object" && typeof v["result"] === "string") state = "ok";
      } catch {
        state = "unavailable";
      }
    } else if (!r.error && r.signal === null && r.status === 1) state = "refused";
    return {
      state,
      output: JSON.stringify(
        state === "unavailable"
          ? { result: "guard-unavailable" }
          : { exit: r.status, stdout: r.stdout, stderr: r.stderr },
      ),
    };
  };
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
type Supervised = {
  keyed: boolean;
  signed: string | null;
  treeEnded: boolean;
  neverStarted: boolean;
  uncertain: boolean;
  descendants?: Descendants;
};
export type SupervisorCommand = { python: string; supervisor: string; root: string; spawn: SpawnSupervisor };
const supervisor = (c: SupervisorCommand, mode: string, extra: string[]) =>
  c.spawn(c.python, [c.supervisor, mode, "--root", c.root, ...extra], { ...SUPERVISOR_ENV });
export type Descendants = {
  seen: number;
  checked: number;
  holding: number;
  pending: number;
  failed: number;
  blind: number; // failed group enumerations (unobserved intervals)
  proven: boolean;
};
export async function inspectRun(
  c: SupervisorCommand,
  run: string,
): Promise<{ treeEnded: boolean; neverStarted: boolean; uncertain: boolean; descendants?: Descendants }> {
  let out = "";
  const code = await lines(supervisor(c, "inspect", ["--run", run]), 64 * 1024, (l) => (out += l));
  try {
    const v = JSON.parse(out) as Record<string, unknown>;
    if (code === 0 && v["run"] === run) {
      const d = v["descendants"] as Record<string, unknown> | undefined;
      return {
        treeEnded: v["treeEnded"] === true,
        neverStarted: v["neverStarted"] === true,
        uncertain: v["uncertain"] !== false,
        ...(d &&
        ["seen", "checked", "holding", "pending", "failed", "blind"].every((k) => Number.isSafeInteger(d[k])) &&
        typeof d["proven"] === "boolean"
          ? {
              descendants: {
                seen: Number(d["seen"]),
                checked: Number(d["checked"]),
                holding: Number(d["holding"]),
                pending: Number(d["pending"]),
                failed: Number(d["failed"]),
                blind: Number(d["blind"]),
                proven: d["proven"] === true,
              },
            }
          : {}),
      };
    }
  } catch {
    // Unknown state stays uncertain.
  }
  return { treeEnded: false, neverStarted: false, uncertain: true };
}
export function descendantsProven(d: Descendants | undefined): boolean {
  return (
    !!d &&
    d.proven === true &&
    d.seen >= 1 &&
    d.holding === d.seen &&
    d.checked === d.seen &&
    d.pending === 0 &&
    d.failed === 0 &&
    d.blind === 0
  );
}
// The files the doctor measured, re-checked by the supervisor immediately before the worker starts.
export type BoundFiles = { profile: string; profileSha256: string; executable: string; executableSha256: string };
// supervisor.py run-worker: the plan (with the setup-token) goes only through the pipe, never argv, files
// or logs. `onKey` must persist the commitment; only then the supervisor gets "ack" and starts the worker.
export async function superviseRun(
  c: SupervisorCommand,
  j: Job,
  plan: ReturnType<typeof buildLaunch>,
  timeoutSeconds: number,
  bound: BoundFiles,
  onKey: (record: ReturnType<typeof parseRunKeyLine>) => void,
  probe = false,
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
    "--profile",
    bound.profile,
    "--profile-sha256",
    bound.profileSha256,
    "--executable",
    bound.executable,
    "--executable-sha256",
    bound.executableSha256,
    ...(probe ? ["--probe-descendants"] : []),
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
  // PR #56 red team P3: the supervisor starts the worker only after "ack", which is sent only after the key
  // was stored. Without it the worker provably never started, whatever the manifest says.
  if (!keyed) return { keyed, signed: null, treeEnded: false, neverStarted: true, uncertain: false };
  const state = await inspectRun(c, j.run);
  return { keyed, signed, ...state };
}

export type ClaudeRunnerDeps = {
  policy: Policy;
  store: Store;
  root: string;
  install: ActiveInstall;
  capability: Capability;
  verifier: RunVerifier;
  materials: (j: Job, dir: string) => Promise<MaterialsMeta>;
  spawn: SpawnSupervisor;
  now: () => number;
  bound: BoundFiles;
  // Re-hash of the bound files just before anything starts (Codex PR56-R005). Defaults to fileDigest.
  digest?: (path: string) => string;
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
      const digest = d.digest ?? fileDigest;
      const unchanged = () => {
        try {
          return (
            digest(d.bound.profile) === d.bound.profileSha256 &&
            digest(d.bound.executable) === d.bound.executableSha256
          );
        } catch {
          return false;
        }
      };
      // The files the capability was matched with must still be the same, before and right before the launch.
      if (!unchanged())
        return { result: "", treeEnded: false, uncertain: false, neverStarted: true, reason: "bound-file-changed", origin: null };
      const { area, run } = newRunArea(d.install.runs, j.run);
      try {
        let plan: ReturnType<typeof buildLaunch>;
        try {
          d.store.saveRunMaterials(j.run, await d.materials(j, run.materials));
          plan = buildLaunch(d.policy, j, d.install.claude, run, d.launch ?? {});
        } catch (e) {
          // Refused before any process started (missing or too many materials, a CLI configuration name, an
          // unreadable token): the job is proven never started.
          const reason = e instanceof ActiveError ? e.message.replace("active refused: ", "") : "launch-refused";
          return { result: "", treeEnded: false, uncertain: false, neverStarted: true, reason, origin: null };
        }
        if (!unchanged())
          return { result: "", treeEnded: false, uncertain: false, neverStarted: true, reason: "bound-file-changed", origin: null };
        // Persist the commitment before the supervisor may start the worker (W4 row 2).
        const r = await superviseRun(command, j, plan, d.install.workerTimeoutSeconds, d.bound, (record) => {
          d.store.saveRunKey(j, record, d.now());
          d.verifier.register(j, record);
        });
        if (r.neverStarted && !r.uncertain)
          return { result: "", treeEnded: false, uncertain: false, neverStarted: true, reason: "not-acknowledged", origin: null };
        if (r.signed === null || !r.treeEnded || r.uncertain)
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
// For posting a deferred result only (red team round 4 RT-1): it never starts anything, and it can redact the
// stored envelope if the post is blocked. Its capability is a placeholder; activeCycle would refuse it.
export function postOnlyRunner(c: SupervisorCommand): Runner {
  return {
    capability: { backend: "claude", version: "", codeHash: "", profileHash: "", probes: {} },
    async run() {
      return { result: "", treeEnded: false, uncertain: false, neverStarted: true, reason: "post-only", origin: null };
    },
    async redact(j, resultHash) {
      const code = await lines(supervisor(c, "redact", ["--run", j.run, "--result-hash", resultHash]), 64 * 1024, () => {});
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
  if (store.deferred(key)) return { kind: null, reason: "deferred-post" };
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
  const { actor, key } = startSmall(d.policy);
  // A post deferred by an edit/delete mark is retried first, from the stored result (nothing relaunches).
  if (d.store.deferred(key)) {
    const outcome = await new Dispatcher(d.policy, d.store).resumeDeferred(d.snapshot, d.runner, d.broker, d.fresh, d.now);
    return `resume:${outcome ?? "none"}`;
  }
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
  // Round 4 RT-3: cli.sb and the executable are hashed from one read; after the probes both are hashed
  // again, and any change makes the result unverified with nothing recorded.
  unchanged: () => boolean;
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
    let changed = false;
    try {
      changed = !d.unchanged();
    } catch {
      changed = true;
    }
    if (changed) {
      const probes = Object.fromEntries(Object.keys(result.capability.probes).map((k) => [k, false]));
      const unverified: DoctorResult = {
        ...result,
        state: result.state === "disabled" ? "disabled" : "unverified",
        reasons: [...result.reasons, "bound-file-changed"],
        capability: { ...result.capability, probes },
      };
      d.store.saveCapability("claude", null, d.now);
      return unverified;
    }
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
  bound: BoundFiles;
  // Round 4 RT-3: re-hash after the measurement; a change means no record is written.
  unchanged: () => boolean;
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
    // PR #56 red team P1: the run must start a child (Grep runs ripgrep as a child process) so that the
    // supervisor's probe can see whether children inherit the run lock. Many files keep the search running.
    const benign = newRunArea(area, "benign");
    for (let n = 0; n < 400; n++)
      writeFileSync(join(benign.run.materials, `file-${String(n).padStart(3, "0")}.txt`), `Synthetic material ${n}.\n`.repeat(200), { mode: 0o600 });
    const base = buildLaunch(d.policy, job, d.install.claude, benign.run, d.launch ?? {});
    const plan = {
      ...base,
      stdin: `${base.stdin}\nMeasurement: use the Grep tool three times on the working directory (patterns: Synthetic, material 3, nothing-matches), then return the result object with decision needs-owner and no findings.\n`,
    };
    const verifier = new RunVerifier();
    const r = await superviseRun(
      { python: d.install.python, supervisor: d.install.supervisor, root, spawn: d.spawn },
      job,
      plan,
      d.install.workerTimeoutSeconds,
      d.bound,
      (record) => verifier.register(job, record),
      true,
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
    let same = false;
    try {
      same = d.unchanged();
    } catch {
      same = false;
    }
    if (!same) refuse("bound-file-changed");
    return {
      schema: 1,
      measurement: measurementRecord(d.install.claude, d.executableDigest, profileHash(d.profileText), outcomes),
      // Inheritance is proven only when EVERY observed child was seen holding the run lock (Codex PR56-R001):
      // one unchecked, failed or pending child, or none at all, is not proof. A normal exit proves nothing (I009).
      external: { schema, descendantLock: r.treeEnded && !r.uncertain && descendantsProven(r.descendants) },
    };
  } finally {
    removeRunArea(area);
  }
}
