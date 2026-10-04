import { DatabaseSync, backup } from "node:sqlite";
import { lstatSync, realpathSync, chmodSync } from "node:fs";
import { checkDispatchRoot, present } from "./host.ts";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  hash,
  keyOf,
  samePair,
  type Job,
  type JobKind,
  type Policy,
  type Snapshot,
  type Target,
} from "./model.ts";
import { assess, reviewerEligible } from "./reducer.ts";
import { runBinding, type RunKey } from "./provenance.ts";

export function canonicalRoot(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("Canonical absolute dispatcher root required");
  for (let p = path; ; p = dirname(p)) {
    if (
      present(join(p, ".git")) ||
      !lstatSync(p).isDirectory() ||
      lstatSync(p).isSymbolicLink()
    )
      throw new Error("Unsafe dispatcher root");
    if (dirname(p) === p) break;
  }
  if (realpathSync(path) !== path) throw new Error("Aliased dispatcher root");
  return path;
}
// Schema 4 (Issue #50 W4): blocked, run_keys, capability, marks, run_materials and jobs.origin. Schema 3 was
// an unreleased draft of this PR. Older DBs are not migrated implicitly; they are refused like any unknown
// schema and the owner initializes a new root.
const SCHEMA = 4;
// PR48-R009: a small step back (NTP) keeps using the stored time; the stored clock never moves back.
export const CLOCK_SKEW_MS = 5000;
export class ClockRollbackError extends Error {
  readonly behindMs: number;
  constructor(behindMs: number) {
    super("Clock moved backwards; wait for the stored time before launch");
    this.behindMs = behindMs;
  }
}
const posix = process.platform !== "win32";
type Row = Record<string, string | number | null>;
export class Store {
  readonly db: DatabaseSync;
  private closed = false;
  // Lifetime singleton wrapper must hold the directory lock before this constructor.
  constructor(root: string, initialize = false) {
    const file = join(canonicalRoot(root), "dispatch.sqlite");
    // PR48-R010: refuse a root/DB/WAL/SHM with the wrong owner or permissions; never chmod them silently.
    if (posix) checkDispatchRoot(root);
    const created = !present(file);
    for (const path of [file, file + "-wal", file + "-shm"])
      if (present(path)) {
        const st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)
          throw new Error("Unsafe database/journal");
      }
    if (present(file)) {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
        throw new Error("Unsafe database");
      const read = new DatabaseSync(file, { readOnly: true });
      try {
        if (
          (read.prepare("PRAGMA user_version").get() as Row)["user_version"] !==
          SCHEMA
        )
          throw new Error("Unknown database schema; stop before writing");
      } finally {
        read.close();
      }
    } else if (!initialize)
      throw new Error("Initialize dispatcher database explicitly");
    this.db = new DatabaseSync(file, { timeout: 2000 });
    try {
      // Only a file this constructor just created inside the owner-only root is narrowed here.
      if (posix && created) chmodSync(file, 0o600);
      // W4 row 7: overwrite freed pages, so a replaced plaintext result is not left in free space.
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;",
      );
      if (
        (this.db.prepare("PRAGMA user_version").get() as Row)[
          "user_version"
        ] === 0
      )
        this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE targets(key TEXT PRIMARY KEY, value TEXT NOT NULL, pending TEXT);
        CREATE TABLE inbox(app INTEGER, delivery TEXT, event TEXT, received INTEGER, payload TEXT, processed INTEGER DEFAULT 0, PRIMARY KEY(app,delivery));
        CREATE TABLE consumed(id TEXT PRIMARY KEY);
        CREATE TABLE jobs(id TEXT PRIMARY KEY,key TEXT,generation INTEGER,actor INTEGER,kind TEXT,executor TEXT,run TEXT UNIQUE,value TEXT,status TEXT,started INTEGER,result TEXT,origin TEXT, UNIQUE(key,generation,actor,kind));
        CREATE TABLE leases(key TEXT PRIMARY KEY,job TEXT UNIQUE REFERENCES jobs(id),cancel INTEGER DEFAULT 0);
        CREATE TABLE outbox(id TEXT PRIMARY KEY,job TEXT,kind TEXT,value TEXT,state TEXT,github TEXT, UNIQUE(job,kind));
        CREATE TABLE notices(id TEXT PRIMARY KEY);
        CREATE TABLE clock(id INTEGER PRIMARY KEY CHECK(id=1),now INTEGER);
        CREATE TABLE acceptance(id TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE evidence(id TEXT PRIMARY KEY,key TEXT,value TEXT NOT NULL);
        CREATE TABLE quota_pause(key TEXT PRIMARY KEY,at INTEGER NOT NULL,owner_clear TEXT);
        CREATE TABLE shadow(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE blocked(key TEXT PRIMARY KEY,run TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL,owner_clear TEXT);
        CREATE TABLE run_keys(run TEXT PRIMARY KEY,job TEXT NOT NULL UNIQUE REFERENCES jobs(id),binding TEXT NOT NULL,key TEXT NOT NULL UNIQUE,at INTEGER NOT NULL);
        CREATE TABLE capability(backend TEXT PRIMARY KEY,value TEXT NOT NULL,at INTEGER NOT NULL);
        CREATE TABLE marks(app INTEGER NOT NULL,delivery TEXT NOT NULL,key TEXT NOT NULL,PRIMARY KEY(app,delivery));
        CREATE TABLE run_materials(run TEXT PRIMARY KEY,value TEXT NOT NULL);
        PRAGMA user_version=4; COMMIT;
      `);
      if (posix) checkDispatchRoot(root); // WAL/SHM exist now; SQLite copies the DB file mode.
    } catch {
      this.db.close();
      throw new Error("Dispatcher storage initialization failed");
    }
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private time(now: number): number {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid clock");
    const stored = this.storedClock();
    if (stored !== null && stored - now > CLOCK_SKEW_MS)
      throw new ClockRollbackError(stored - now);
    const at = stored === null ? now : Math.max(stored, now);
    this.db
      .prepare(
        "INSERT INTO clock VALUES(1,?) ON CONFLICT(id) DO UPDATE SET now=excluded.now",
      )
      .run(at);
    return at;
  }
  private storedClock(): number | null {
    const row = this.db.prepare("SELECT now FROM clock WHERE id=1").get() as
      | Row
      | undefined;
    return row ? Number(row["now"]) : null;
  }
  // Records the current time (monotonic) and returns the time to use. Throws ClockRollbackError.
  tick(now: number): number {
    return this.atomic(() => this.time(now));
  }
  // Read-only: how far the OS clock is behind the stored clock (0 when it is not).
  clockBehind(now: number): number {
    const stored = this.storedClock();
    return stored === null ? 0 : Math.max(0, stored - now);
  }
  // `mark` (W4 row 8): the target key of an edit/delete/dismiss delivery. It is stored in the same
  // transaction and stops launches and posts for that PR until a reconcile has processed the delivery.
  inbox(
    app: number,
    delivery: string,
    event: string,
    payload: string,
    now: number,
    mark: string | null = null,
  ): boolean {
    return this.atomic(() => {
      const at = this.time(now);
      const stored =
        Number(
          this.db
            .prepare(
              "INSERT OR IGNORE INTO inbox(app,delivery,event,received,payload) VALUES(?,?,?,?,?)",
            )
            .run(app, delivery, event, at, payload).changes,
        ) === 1;
      if (stored && mark !== null)
        this.db
          .prepare("INSERT OR IGNORE INTO marks(app,delivery,key) VALUES(?,?,?)")
          .run(app, delivery, mark);
      return stored;
    });
  }
  // An unprocessed edit/delete/dismiss delivery for this PR (W4 row 8).
  marked(key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM marks WHERE key=?").get(key);
  }
  // PR48-R011: a signed delivery too large to keep. Only its ID and event are kept (payload NULL,
  // processed 0); it never binds Ready/Review. Reconcile is the recovery path.
  oversized(app: number, delivery: string, event: string, now: number): boolean {
    return this.atomic(() => {
      const at = this.time(now);
      return (
        Number(
          this.db
            .prepare(
              "INSERT OR IGNORE INTO inbox(app,delivery,event,received,payload) VALUES(?,?,?,?,NULL)",
            )
            .run(app, delivery, event, at).changes,
        ) === 1
      );
    });
  }
  // Returns the events of unreported oversized deliveries once and marks them reported.
  drainOversized(): string[] {
    return this.atomic(() => {
      const rows = this.db
        .prepare(
          "SELECT event FROM inbox WHERE payload IS NULL AND processed=0 ORDER BY received,delivery",
        )
        .all() as Row[];
      this.db
        .prepare("UPDATE inbox SET processed=1 WHERE payload IS NULL AND processed=0")
        .run();
      return rows.map((r) => String(r["event"]));
    });
  }
  pendingInbox(): Row[] {
    return this.db
      .prepare(
        "SELECT * FROM inbox WHERE processed=0 AND payload IS NOT NULL ORDER BY received,delivery",
      )
      .all() as Row[];
  }
  // Immutable event establishment evidence survives payload TTL. Never rebind an old ID to a new pair.
  evidence<T>(key: string, kind: string): T[] {
    return (
      this.db
        .prepare("SELECT value FROM evidence WHERE key=? AND id LIKE ?")
        .all(key, kind + ":%") as Row[]
    ).map((r) => JSON.parse(String(r["value"])) as T);
  }
  saveEvidence(key: string, kind: string, id: string, value: unknown): void {
    const identity = `${kind}:${key}:${id}`,
      raw = JSON.stringify(value);
    const old = this.db
      .prepare("SELECT value FROM evidence WHERE id=?")
      .get(identity) as Row | undefined;
    if (old && old["value"] !== raw)
      throw new Error("Event establishment evidence changed");
    this.db
      .prepare("INSERT OR IGNORE INTO evidence VALUES(?,?,?)")
      .run(identity, key, raw);
    if (kind === "review")
      this.db
        .prepare("INSERT OR IGNORE INTO acceptance VALUES(?,?)")
        .run(
          identity,
          JSON.stringify({ ...(value as object), key, stale: false }),
        );
  }
  observation<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value FROM shadow WHERE key=?")
      .get(key) as Row | undefined;
    return row ? (JSON.parse(String(row["value"])) as T) : null;
  }
  saveObservation(key: string, value: unknown): void {
    const raw = JSON.stringify(value);
    this.saveEvidence(key, "observation", hash(raw), value);
    this.db
      .prepare(
        "INSERT INTO shadow VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, raw);
  }
  processed(app: number, delivery: string): void {
    this.db
      .prepare("UPDATE inbox SET processed=1 WHERE app=? AND delivery=?")
      .run(app, delivery);
    this.db
      .prepare("DELETE FROM marks WHERE app=? AND delivery=?")
      .run(app, delivery);
  }
  consumed(): Set<string> {
    return new Set(
      (this.db.prepare("SELECT id FROM consumed").all() as Row[]).map((r) =>
        String(r["id"]),
      ),
    );
  }
  target(key: string): Target | null {
    const r = this.db
      .prepare("SELECT value FROM targets WHERE key=?")
      .get(key) as Row | undefined;
    return r ? (JSON.parse(String(r["value"])) as Target) : null;
  }
  observe(t: Target): boolean {
    return this.atomic(() => {
      if (this.quotaPaused(t.key))
        t = {
          ...t,
          paused: true,
          status: "waiting",
          reason: "quota-owner-required",
        };
      else if (this.blocked(t.key))
        t = {
          ...t,
          paused: true,
          status: "waiting",
          reason: "blocked-owner-required",
        };
      const prior = this.target(t.key),
        lease = this.db
          .prepare("SELECT job FROM leases WHERE key=?")
          .get(t.key);
      if (
        lease &&
        prior &&
        (t.generation !== prior.generation ||
          t.status !== "eligible" ||
          t.paused ||
          t.ready !== prior.ready)
      ) {
        this.db
          .prepare("UPDATE targets SET pending=? WHERE key=?")
          .run(JSON.stringify(t), t.key);
        this.db.prepare("UPDATE leases SET cancel=1 WHERE key=?").run(t.key);
        this.db
          .prepare(
            "UPDATE jobs SET status='uncertain' WHERE id=(SELECT job FROM leases WHERE key=?)",
          )
          .run(t.key);
        return false; // Do not advance generation while an old process tree may still live.
      }
      this.db
        .prepare(
          "INSERT INTO targets(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,pending=NULL",
        )
        .run(t.key, JSON.stringify(t));
      for (const r of this.db
        .prepare("SELECT id,value FROM acceptance")
        .all() as Row[]) {
        const a = JSON.parse(String(r["value"])) as {
          key: string;
          pair: { head: string; base: string };
          stale: boolean;
        };
        if (
          a.key === t.key &&
          (!samePair(a.pair, t.pair) || t.status !== "eligible")
        )
          this.db
            .prepare("UPDATE acceptance SET value=? WHERE id=?")
            .run(JSON.stringify({ ...a, stale: true }), String(r["id"]));
      }
      return true;
    });
  }
  quotaPaused(key: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM quota_pause WHERE key=? AND owner_clear IS NULL")
      .get(key);
  }
  // Owner holds (quota pause, blocked) end only by an owner's removal of review:paused after the hold.
  clearQuota(p: Policy, s: Snapshot): void {
    for (const table of ["quota_pause", "blocked"] as const) {
      const row = this.db
        .prepare(`SELECT at FROM ${table} WHERE key=? AND owner_clear IS NULL`)
        .get(keyOf(p, s.pr)) as Row | undefined;
      if (!row || !s.complete || !s.historyComplete) continue;
      const event = s.history
        .filter(
          (e) =>
            e.kind === "unpause" &&
            p.owners.includes(e.actor) &&
            e.at > Number(row["at"]),
        )
        .at(-1);
      if (event)
        this.db
          .prepare(`UPDATE ${table} SET owner_clear=? WHERE key=?`)
          .run(event.id, keyOf(p, s.pr));
    }
  }
  // W4 row 1: blocked is a durable per-PR needs-owner state. It outlives the job's lease (an owner may
  // release the ended run) and clears only through clearQuota (an owner's later unpause).
  blocked(key: string): { run: string; reason: string; at: number } | null {
    const r = this.db
      .prepare("SELECT run,reason,at FROM blocked WHERE key=? AND owner_clear IS NULL")
      .get(key) as Row | undefined;
    return r
      ? { run: String(r["run"]), reason: String(r["reason"]), at: Number(r["at"]) }
      : null;
  }
  block(j: Job, reason: string, now: number): void {
    if (!/^[a-z-]{1,40}$/.test(reason)) throw new Error("Invalid block reason");
    this.atomic(() => {
      const at = this.time(now);
      this.db
        .prepare(
          "INSERT INTO blocked VALUES(?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET run=excluded.run,reason=excluded.reason,at=excluded.at,owner_clear=NULL",
        )
        .run(j.key, j.run, reason, at);
      this.db
        .prepare("UPDATE jobs SET status='uncertain' WHERE id=?")
        .run(j.id);
    });
  }
  claim(
    p: Policy,
    s: Snapshot,
    actor: number,
    kind: JobKind,
    now: number,
  ): Job | null {
    return this.atomic(() => {
      now = this.time(now);
      this.clearQuota(p, s);
      if (
        this.quotaPaused(keyOf(p, s.pr)) ||
        this.blocked(keyOf(p, s.pr)) ||
        this.marked(keyOf(p, s.pr))
      )
        return null;
      const t = this.target(keyOf(p, s.pr)),
        fresh = assess(p, s, t, this.consumed()),
        a = p.actors.find((x) => x.id === actor);
      if (
        p.mode !== "active" ||
        !t ||
        fresh.status !== "eligible" ||
        fresh.generation !== t.generation ||
        t.status !== "eligible" ||
        t.paused ||
        t.policy !== p.revision ||
        !samePair(t.pair, s.pair) ||
        a?.kind !== "ai" ||
        kind === "fix" ||
        !reviewerEligible(p, s, actor)
      )
        return null; // Auto-fix remains disabled until owner rollout.
      if (this.db.prepare("SELECT 1 FROM leases WHERE key=?").get(t.key))
        return null;
      const count = Number(
        (this.db.prepare("SELECT count(*) AS n FROM leases").get() as Row)["n"],
      );
      const local = Number(
        (
          this.db
            .prepare(
              "SELECT count(*) AS n FROM leases l JOIN jobs j ON j.id=l.job WHERE executor=?",
            )
            .get(a.executor) as Row
        )["n"],
      );
      if (
        count >= p.maxConcurrent ||
        local >= (p.executorLimits[a.executor] ?? 0)
      )
        return null;
      const used = Number(
        (
          this.db
            .prepare(
              "SELECT count(*) AS n FROM jobs WHERE key=? AND kind IN ('review','faultfinding') AND started>?",
            )
            .get(t.key, now - 86400000) as Row
        )["n"],
      );
      if (used >= 6) {
        this.db
          .prepare(
            "INSERT INTO quota_pause VALUES(?,?,NULL) ON CONFLICT(key) DO UPDATE SET at=excluded.at,owner_clear=NULL",
          )
          .run(t.key, now);
        this.db
          .prepare("UPDATE targets SET value=? WHERE key=?")
          .run(
            JSON.stringify({
              ...t,
              paused: true,
              status: "waiting",
              reason: "quota-owner-required",
              generation: t.generation + 1,
            }),
            t.key,
          );
        this.notice(`${t.key}:quota:${now}`);
        return null;
      }
      if (
        this.db
          .prepare(
            "SELECT 1 FROM jobs WHERE key=? AND generation=? AND actor=? AND kind=?",
          )
          .get(t.key, t.generation, actor, kind)
      )
        return null;
      const j: Job = {
        id: randomUUID(),
        key: t.key,
        generation: t.generation,
        actor,
        kind,
        run: randomUUID(),
        pair: t.pair,
        policy: t.policy,
      };
      this.db
        .prepare(
          "INSERT INTO jobs(id,key,generation,actor,kind,executor,run,value,status,started) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          j.id,
          j.key,
          j.generation,
          j.actor,
          j.kind,
          a.executor,
          j.run,
          JSON.stringify(j),
          "launching",
          now,
        );
      this.db
        .prepare("INSERT INTO leases(key,job) VALUES(?,?)")
        .run(j.key, j.id);
      if (t.ready)
        this.db
          .prepare("INSERT OR IGNORE INTO consumed VALUES(?)")
          .run(t.ready);
      return j;
    });
  }
  job(id: string): {
    job: Job;
    status: string;
    cancel: boolean;
    resultHash: string | null;
  } | null {
    const r = this.db
      .prepare(
        "SELECT j.value,j.status,j.result,l.cancel FROM jobs j LEFT JOIN leases l ON j.id=l.job WHERE j.id=?",
      )
      .get(id) as Row | undefined;
    return r
      ? {
          job: JSON.parse(String(r["value"])) as Job,
          status: String(r["status"]),
          cancel: r["cancel"] === 1,
          resultHash: r["result"] === null ? null : hash(String(r["result"])),
        }
      : null;
  }
  // `origin` is the run's verified provenance (signature): kept so a deferred post can be retried by a later
  // cycle and verified again by the Broker (PR #56 red team P2).
  result(j: Job, result: string, origin: unknown = null): void {
    this.atomic(() => {
      const current = this.job(j.id);
      if (
        !current ||
        current.cancel ||
        current.status !== "running" ||
        JSON.stringify(current.job) !== JSON.stringify(j)
      )
        throw new Error("Stale or unowned result");
      this.db
        .prepare("UPDATE jobs SET status='result-ready',result=?,origin=? WHERE id=?")
        .run(result, origin === null ? null : JSON.stringify(origin), j.id);
    });
  }
  running(j: Job): void {
    if (
      Number(
        this.db
          .prepare(
            "UPDATE jobs SET status='running' WHERE id=? AND status='launching'",
          )
          .run(j.id).changes,
      ) !== 1
    )
      throw new Error("Uncertain launch");
  }
  uncertain(j: Job): void {
    this.db.prepare("UPDATE jobs SET status='uncertain' WHERE id=?").run(j.id);
  }
  // Only supervisor's authenticated termination report permits releasing ownership; never timeout/PID alone.
  release(
    j: Job,
    proof: {
      run: string;
      neverStarted: boolean;
      treeEnded: boolean;
      uncertain: boolean;
    },
  ): void {
    if (
      proof.run !== j.run ||
      proof.uncertain ||
      (!proof.neverStarted && !proof.treeEnded)
    )
      throw new Error("Termination not proven");
    this.atomic(() => {
      this.db
        .prepare("DELETE FROM leases WHERE key=? AND job=?")
        .run(j.key, j.id);
      const r = this.db
        .prepare("SELECT pending FROM targets WHERE key=?")
        .get(j.key) as Row | undefined;
      if (r?.["pending"])
        this.db
          .prepare("UPDATE targets SET value=pending,pending=NULL WHERE key=?")
          .run(j.key);
      this.db
        .prepare(
          "UPDATE jobs SET status=CASE WHEN status='posted' THEN status ELSE 'finished' END WHERE id=?",
        )
        .run(j.id);
    });
  }
  outbox(j: Job, kind: string, value: string): string {
    const id = hash(`${j.id}:${kind}`);
    this.atomic(() => {
      const row = this.db
        .prepare("SELECT value FROM outbox WHERE id=?")
        .get(id) as Row | undefined;
      if (row && row["value"] !== value) throw new Error("Outbox body changed");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO outbox(id,job,kind,value,state) VALUES(?,?,?,?,'prepared')",
        )
        .run(id, j.id, kind, value);
    });
    return id;
  }
  outboxState(id: string): string {
    const r = this.db.prepare("SELECT state FROM outbox WHERE id=?").get(id) as
      | Row
      | undefined;
    if (!r) throw new Error("Missing outbox");
    return String(r["state"]);
  }
  sending(id: string): void {
    if (
      Number(
        this.db
          .prepare(
            "UPDATE outbox SET state='uncertain' WHERE id=? AND state='prepared'",
          )
          .run(id).changes,
      ) !== 1
    )
      throw new Error("Do not repeat uncertain POST");
  }
  posted(id: string, github: string): void {
    this.atomic(() => {
      this.db
        .prepare("UPDATE outbox SET state='posted',github=? WHERE id=?")
        .run(github, id);
      this.db
        .prepare(
          "UPDATE jobs SET status='posted' WHERE id=(SELECT job FROM outbox WHERE id=?)",
        )
        .run(id);
    });
  }
  notice(key: string): boolean {
    return (
      Number(
        this.db
          .prepare("INSERT OR IGNORE INTO notices VALUES(?)")
          .run(hash(key)).changes,
      ) === 1
    );
  }
  retain(now: number): void {
    this.atomic(() => {
      now = this.time(now);
      this.db
        .prepare(
          "UPDATE inbox SET payload=NULL WHERE processed=1 AND received<?",
        )
        .run(now - 7 * 86400000);
      this.db
        .prepare(
          "UPDATE jobs SET result=NULL WHERE status IN ('finished','posted') AND started<? AND id NOT IN (SELECT job FROM leases) AND id NOT IN (SELECT job FROM outbox WHERE state='uncertain')",
        )
        .run(now - 30 * 86400000);
    });
  }
  // W4 row 7: replaces a stored plaintext result with its hash-only form (publication.ts redactedResult),
  // then truncates the WAL so the old value is not left in the journal either. Exact job and value only.
  // A checkpoint that another connection keeps busy is retried; if it still fails the owner is told once.
  redactResult(j: Job, raw: string, redacted: string): boolean {
    const changed =
      Number(
        this.db
          .prepare("UPDATE jobs SET result=?,origin=NULL WHERE id=? AND run=? AND result=?")
          .run(redacted, j.id, j.run, raw).changes,
      ) === 1;
    if (!this.checkpoint()) this.notice(`${j.key}:checkpoint-busy:${j.run}`);
    return changed;
  }
  checkpoint(): boolean {
    for (let n = 0; n < 5; n++) {
      const r = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as Row | undefined;
      if (r && Number(r["busy"]) === 0) return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    return false;
  }
  // The dispatcher's own record of a run's materials (plan path, ledger causes); written once by the runner.
  saveRunMaterials(run: string, value: { planPath: string | null; ledger: string[]; previousRts: string[]; guard?: "ok" | "unavailable" | "none" }): void {
    this.db.prepare("INSERT INTO run_materials VALUES(?,?)").run(run, JSON.stringify(value));
  }
  runMaterials(run: string): { planPath: string | null; ledger: string[]; previousRts: string[]; guard?: "ok" | "unavailable" | "none" } | null {
    const r = this.db.prepare("SELECT value FROM run_materials WHERE run=?").get(run) as Row | undefined;
    return r ? (JSON.parse(String(r["value"])) as { planPath: string | null; ledger: string[]; previousRts: string[]; guard?: "ok" | "unavailable" | "none" }) : null;
  }
  // A leased job whose result waits for its post (Broker "deferred"): the next cycle retries the same job.
  deferred(key: string): { job: Job; result: string; origin: unknown } | null {
    const r = this.db
      .prepare(
        "SELECT j.value,j.result,j.origin FROM leases l JOIN jobs j ON j.id=l.job WHERE l.key=? AND l.cancel=0 AND j.status='result-ready' AND j.result IS NOT NULL AND j.origin IS NOT NULL",
      )
      .get(key) as Row | undefined;
    return r
      ? {
          job: JSON.parse(String(r["value"])) as Job,
          result: String(r["result"]),
          origin: JSON.parse(String(r["origin"])) as unknown,
        }
      : null;
  }
  // W4 row 2: the public commitment the supervisor announced before the worker started. Persisted before
  // the supervisor is allowed to start the worker, so a restarted dispatcher can still verify the run.
  // Never replaced, never moved to another job, and a key is never reused.
  saveRunKey(j: Job, record: RunKey, now: number): void {
    if (
      record.run !== j.run ||
      record.binding !== runBinding(j) ||
      !/^[a-f0-9]{64}$/.test(record.key)
    )
      throw new Error("Run key rejected");
    this.atomic(() => {
      const at = this.time(now);
      const owned = this.job(j.id);
      if (!owned || JSON.stringify(owned.job) !== JSON.stringify(j))
        throw new Error("Run key for an unknown job");
      this.db
        .prepare("INSERT INTO run_keys(run,job,binding,key,at) VALUES(?,?,?,?,?)")
        .run(record.run, j.id, record.binding, record.key, at);
    });
  }
  runKeys(): { job: Job; record: RunKey }[] {
    return (
      this.db
        .prepare(
          "SELECT k.run,k.binding,k.key,j.value FROM run_keys k JOIN jobs j ON j.id=k.job ORDER BY k.at,k.run",
        )
        .all() as Row[]
    ).map((r) => ({
      job: JSON.parse(String(r["value"])) as Job,
      record: {
        run: String(r["run"]),
        binding: String(r["binding"]),
        key: String(r["key"]),
      },
    }));
  }
  // The doctor's capability record (W4: bound to the launch plan by active.ts). null removes it.
  saveCapability(backend: string, value: unknown, now: number): void {
    if (!/^[a-z]{1,20}$/.test(backend)) throw new Error("Invalid backend");
    this.atomic(() => {
      const at = this.time(now);
      if (value === null)
        this.db.prepare("DELETE FROM capability WHERE backend=?").run(backend);
      else
        this.db
          .prepare(
            "INSERT INTO capability VALUES(?,?,?) ON CONFLICT(backend) DO UPDATE SET value=excluded.value,at=excluded.at",
          )
          .run(backend, JSON.stringify(value), at);
    });
  }
  capability(backend: string): unknown {
    const r = this.db
      .prepare("SELECT value FROM capability WHERE backend=?")
      .get(backend) as Row | undefined;
    return r ? (JSON.parse(String(r["value"])) as unknown) : null;
  }
  // Faultfinding evidence for the current pair and policy revision: the latest red-team record this
  // dispatcher posted itself (Outbox posted = found on GitHub by marker, actor, commit and body hash).
  faultfinding(
    key: string,
    pair: { head: string; base: string },
    policy: string,
  ): Snapshot["faultfinding"] {
    for (const r of this.db
      .prepare(
        "SELECT o.value AS outbox, j.value AS job FROM outbox o JOIN jobs j ON j.id=o.job WHERE o.state='posted' AND o.kind='faultfinding' AND j.key=? ORDER BY j.started DESC, o.rowid DESC",
      )
      .all(key) as Row[]) {
      const j = JSON.parse(String(r["job"])) as Job,
        v = JSON.parse(String(r["outbox"])) as {
          actor: number;
          decision: string;
          findings?: string[];
        };
      if (j.kind !== "faultfinding" || j.policy !== policy || !samePair(j.pair, pair))
        continue;
      const findings = Array.isArray(v.findings) ? v.findings.map(String) : [];
      return {
        actor: j.actor,
        pair: { ...j.pair },
        unresolved:
          v.decision === "accepted"
            ? findings
            : findings.length
              ? findings
              : [`faultfinding:${v.decision}`],
      };
    }
    return null;
  }
  hasJob(key: string, generation: number, kind: JobKind): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM jobs WHERE key=? AND generation=? AND kind=?")
      .get(key, generation, kind);
  }
  jobByRun(run: string): Job | null {
    const r = this.db.prepare("SELECT value FROM jobs WHERE run=?").get(run) as
      | Row
      | undefined;
    return r ? (JSON.parse(String(r["value"])) as Job) : null;
  }
  // Read-only owner summary (status CLI): IDs and states only.
  status(key: string): {
    target: Target | null;
    blocked: { run: string; reason: string; at: number } | null;
    quota: boolean;
    marked: boolean;
    jobs: { kind: string; run: string; status: string; generation: number }[];
    uncertainOutbox: number;
  } {
    return {
      target: this.target(key),
      blocked: this.blocked(key),
      quota: this.quotaPaused(key),
      marked: this.marked(key),
      jobs: (
        this.db
          .prepare(
            "SELECT kind,run,status,generation FROM jobs WHERE key=? ORDER BY started DESC LIMIT 20",
          )
          .all(key) as Row[]
      ).map((r) => ({
        kind: String(r["kind"]),
        run: String(r["run"]),
        status: String(r["status"]),
        generation: Number(r["generation"]),
      })),
      uncertainOutbox: Number(
        (
          this.db
            .prepare(
              "SELECT count(*) AS n FROM outbox o JOIN jobs j ON j.id=o.job WHERE j.key=? AND o.state='uncertain'",
            )
            .get(key) as Row
        )["n"],
      ),
    };
  }
  async backup(destination: string): Promise<void> {
    if (
      this.db.prepare("SELECT 1 FROM leases").get() ||
      this.db.prepare("SELECT 1 FROM outbox WHERE state='uncertain'").get()
    )
      throw new Error("Quiesce and reconcile before backup");
    if (present(destination)) throw new Error("Backup destination exists");
    await backup(this.db, destination);
  }
}
