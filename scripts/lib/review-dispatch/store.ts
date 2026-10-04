import { DatabaseSync, backup } from "node:sqlite";
import { existsSync, lstatSync, realpathSync, chmodSync } from "node:fs";
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

export function canonicalRoot(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error("Canonical absolute dispatcher root required");
  for (let p = path; ; p = dirname(p)) {
    if (
      existsSync(join(p, ".git")) ||
      !lstatSync(p).isDirectory() ||
      lstatSync(p).isSymbolicLink()
    )
      throw new Error("Unsafe dispatcher root");
    if (dirname(p) === p) break;
  }
  if (realpathSync(path) !== path) throw new Error("Aliased dispatcher root");
  return path;
}
const SCHEMA = 2;
type Row = Record<string, string | number | null>;
export class Store {
  readonly db: DatabaseSync;
  private closed = false;
  // Lifetime singleton wrapper must hold the directory lock before this constructor.
  constructor(root: string, initialize = false) {
    const file = join(canonicalRoot(root), "dispatch.sqlite");
    for (const path of [file, file + "-wal", file + "-shm"])
      if (existsSync(path)) {
        const st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)
          throw new Error("Unsafe database/journal");
      }
    if (existsSync(file)) {
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
    if (process.platform !== "win32") chmodSync(file, 0o600);
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
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
        CREATE TABLE jobs(id TEXT PRIMARY KEY,key TEXT,generation INTEGER,actor INTEGER,kind TEXT,executor TEXT,run TEXT UNIQUE,value TEXT,status TEXT,started INTEGER,result TEXT, UNIQUE(key,generation,actor,kind));
        CREATE TABLE leases(key TEXT PRIMARY KEY,job TEXT UNIQUE REFERENCES jobs(id),cancel INTEGER DEFAULT 0);
        CREATE TABLE outbox(id TEXT PRIMARY KEY,job TEXT,kind TEXT,value TEXT,state TEXT,github TEXT, UNIQUE(job,kind));
        CREATE TABLE notices(id TEXT PRIMARY KEY);
        CREATE TABLE clock(id INTEGER PRIMARY KEY CHECK(id=1),now INTEGER);
        CREATE TABLE acceptance(id TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE evidence(id TEXT PRIMARY KEY,key TEXT,value TEXT NOT NULL);
        CREATE TABLE quota_pause(key TEXT PRIMARY KEY,at INTEGER NOT NULL,owner_clear TEXT);
        CREATE TABLE shadow(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        PRAGMA user_version=2; COMMIT;
      `);
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
  private time(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid clock");
    const previous = this.db
      .prepare("SELECT now FROM clock WHERE id=1")
      .get() as Row | undefined;
    if (previous && Number(previous["now"]) > now)
      throw new Error("Clock moved backwards; reconcile before launch");
    this.db
      .prepare(
        "INSERT INTO clock VALUES(1,?) ON CONFLICT(id) DO UPDATE SET now=excluded.now",
      )
      .run(now);
  }
  inbox(
    app: number,
    delivery: string,
    event: string,
    payload: string,
    now: number,
  ): boolean {
    return this.atomic(() => {
      this.time(now);
      return (
        Number(
          this.db
            .prepare(
              "INSERT OR IGNORE INTO inbox(app,delivery,event,received,payload) VALUES(?,?,?,?,?)",
            )
            .run(app, delivery, event, now, payload).changes,
        ) === 1
      );
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
  clearQuota(p: Policy, s: Snapshot): void {
    const row = this.db
      .prepare("SELECT at FROM quota_pause WHERE key=? AND owner_clear IS NULL")
      .get(keyOf(p, s.pr)) as Row | undefined;
    if (!row || !s.complete || !s.historyComplete) return;
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
        .prepare("UPDATE quota_pause SET owner_clear=? WHERE key=?")
        .run(event.id, keyOf(p, s.pr));
  }
  claim(
    p: Policy,
    s: Snapshot,
    actor: number,
    kind: JobKind,
    now: number,
  ): Job | null {
    return this.atomic(() => {
      this.time(now);
      this.clearQuota(p, s);
      if (this.quotaPaused(keyOf(p, s.pr))) return null;
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
  result(j: Job, result: string): void {
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
        .prepare("UPDATE jobs SET status='result-ready',result=? WHERE id=?")
        .run(result, j.id);
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
      this.time(now);
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
  async backup(destination: string): Promise<void> {
    if (
      this.db.prepare("SELECT 1 FROM leases").get() ||
      this.db.prepare("SELECT 1 FROM outbox WHERE state='uncertain'").get()
    )
      throw new Error("Quiesce and reconcile before backup");
    if (existsSync(destination)) throw new Error("Backup destination exists");
    await backup(this.db, destination);
  }
}
