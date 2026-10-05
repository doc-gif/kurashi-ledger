import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import {
  Store,
  canonicalRoot,
  ClockRollbackError,
  CLOCK_SKEW_MS,
} from "./store.ts";
import { assess } from "./reducer.ts";
import { checkDispatchRoot, HostCheckError } from "./host.ts";
import {
  database,
  claim,
  policy,
  snapshot,
} from "../../../tests/fixtures/review-dispatch.ts";

test("D02 real SQLite WAL survives reopening and payload TTL retains tombstones", () => {
  const d = database();
  try {
    assert.equal(
      d.store.inbox(3, "delivery", "pull_request", "synthetic", 0, "p1"),
      true,
    );
    d.store.processed(3, "delivery");
    d.store.retain(8 * 86400000);
    assert.equal(
      d.store.inbox(3, "delivery", "pull_request", "replay", 8 * 86400000, "p1"),
      false,
    );
    assert.equal(d.store.pendingInbox().length, 0);
    const second = new Store(d.root);
    assert.equal(
      second.inbox(3, "delivery", "pull_request", "replay", 8 * 86400000, "p1"),
      false,
    );
    second.close();
  } finally {
    d.cleanup();
  }
});
test("D09 one PR lease across kinds; unknown launch cannot be stolen", () => {
  const d = database();
  try {
    const p = policy(),
      s = snapshot(),
      j = claim(d.store);
    assert.equal(d.store.claim(p, s, 30, "faultfinding", 101), null);
    d.store.uncertain(j);
    assert.equal(d.store.claim(p, s, 30, "review", 86400100), null);
    assert.throws(() =>
      d.store.release(j, {
        run: j.run,
        neverStarted: false,
        treeEnded: false,
        uncertain: true,
      }),
    );
    assert.equal(d.store.job(j.id)?.status, "uncertain");
  } finally {
    d.cleanup();
  }
});
test("D09 invalidation cancels first; generation advances only after proven tree end", () => {
  const d = database();
  try {
    const p = policy(),
      s = snapshot(),
      j = claim(d.store),
      old = d.store.target(j.key)!;
    s.pair = { ...s.pair, head: "d".repeat(40) };
    s.finalPair = s.pair;
    const next = assess(p, s, old);
    assert.equal(d.store.observe(next), false);
    assert.equal(d.store.target(j.key)!.generation, 1);
    assert.equal(d.store.job(j.id)?.cancel, true);
    assert.throws(() => d.store.result(j, "{}"));
    d.store.release(j, {
      run: j.run,
      neverStarted: false,
      treeEnded: true,
      uncertain: false,
    });
    assert.equal(d.store.target(j.key)!.generation, 2);
  } finally {
    d.cleanup();
  }
});
test("D09 ten global leases and executor limit enforced atomically", () => {
  const d = database();
  try {
    const p = policy();
    for (let n = 1; n <= 11; n++) {
      const s = snapshot();
      s.pr = n;
      if (n > 1) p.targets.push({ pr: n, implementer: 20, reviewers: [30] });
      d.store.observe(assess(p, s, null));
      assert.equal(d.store.claim(p, s, 30, "review", n) !== null, n <= 10);
    }
  } finally {
    d.cleanup();
  }
  const e = database();
  try {
    const p = policy();
    p.executorLimits["claude"] = 1;
    claim(e.store, p);
    const s = snapshot();
    s.pr = 2;
    p.targets.push({ pr: 2, implementer: 20, reviewers: [30] });
    e.store.observe(assess(p, s, null));
    assert.equal(e.store.claim(p, s, 30, "review", 101), null);
  } finally {
    e.cleanup();
  }
});
test("D08 six starts per PR persists across generations and restarts, no clock reset", () => {
  const d = database(),
    T0 = 10_000_000;
  try {
    const p = policy();
    for (let n = 1; n <= 7; n++) {
      const s = snapshot();
      s.pair.head = n.toString().repeat(40);
      s.finalPair = s.pair;
      s.testedParents = [s.pair.base, s.pair.head];
      s.history[1]!.id = "ready" + n;
      s.history[1]!.pair = s.pair;
      const prior = d.store.target("1:1");
      d.store.observe(assess(p, s, prior));
      const j = d.store.claim(p, s, 30, "review", T0 + n);
      if (n <= 6) {
        assert.ok(j);
        d.store.release(j, {
          run: j.run,
          neverStarted: true,
          treeEnded: false,
          uncertain: false,
        });
      } else assert.equal(j, null);
    }
    // A rollback beyond the tolerance refuses; one within it keeps the stored time. Neither resets quota.
    assert.throws(
      () => d.store.claim(p, snapshot(), 30, "review", 1),
      ClockRollbackError,
    );
    assert.equal(d.store.claim(p, snapshot(), 30, "review", T0 + 7 - CLOCK_SKEW_MS), null);
    assert.equal(d.store.clockBehind(T0), 7);
  } finally {
    d.cleanup();
  }
});
test("D03 outbox uncertainty is committed before POST and is not retried", () => {
  const d = database();
  try {
    const j = claim(d.store),
      id = d.store.outbox(j, "review", "fixed");
    d.store.sending(id);
    assert.equal(d.store.outboxState(id), "uncertain");
    assert.throws(() => d.store.sending(id));
    assert.throws(() => d.store.outbox(j, "review", "changed"));
    d.store.posted(id, "r1");
    assert.equal(d.store.outboxState(id), "posted");
  } finally {
    d.cleanup();
  }
});
test("D08 notice once; transaction crash rolls back ownership", () => {
  const d = database();
  try {
    assert.equal(d.store.notice("state"), true);
    assert.equal(d.store.notice("state"), false);
    assert.throws(() =>
      d.store.atomic(() => {
        d.store.db.prepare("INSERT INTO notices VALUES('rollback')").run();
        throw new Error("fault");
      }),
    );
    assert.equal(
      d.store.db.prepare("SELECT 1 FROM notices WHERE id='rollback'").get(),
      undefined,
    );
  } finally {
    d.cleanup();
  }
});
test("I002 unknown schema rejected without write; quiesced backup restores replay state", async () => {
  const d = database();
  try {
    d.store.inbox(3, "delivery", "pull_request", "synthetic", 0, "p1");
    const copy = join(d.root, "backup.sqlite");
    await d.store.backup(copy);
    const read = new DatabaseSync(copy, { readOnly: true });
    assert.equal(
      read.prepare("SELECT count(*) AS n FROM inbox").get()!["n"],
      1,
    );
    read.close();
    const j = claim(d.store);
    await assert.rejects(d.store.backup(join(d.root, "blocked.sqlite")));
    d.store.release(j, {
      run: j.run,
      neverStarted: true,
      treeEnded: false,
      uncertain: false,
    });
    d.store.db.exec("PRAGMA user_version=99");
    const before = readFileSync(join(d.root, "dispatch.sqlite"));
    assert.throws(() => new Store(d.root));
    assert.deepEqual(readFileSync(join(d.root, "dispatch.sqlite")), before);
  } finally {
    d.cleanup();
  }
});
test("I002 unsafe/noncanonical roots rejected", () => {
  assert.throws(() => canonicalRoot("relative"));
  const d = database();
  try {
    assert.throws(() => canonicalRoot(d.root + "/.."));
  } finally {
    d.cleanup();
  }
});

test("I002 cold SQLite backup into an empty root preserves replay state; existing DB is not replaced", async () => {
  const d = database(),
    e = database();
  try {
    d.store.inbox(3, "retained", "pull_request", "synthetic", 0, "p1");
    const path = join(e.root, "copy.sqlite");
    await d.store.backup(path);
    await assert.rejects(d.store.backup(path));
    const read = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      read.prepare("SELECT delivery FROM inbox").get()!["delivery"],
      "retained",
    );
    assert.equal(read.prepare("PRAGMA user_version").get()!["user_version"], 5); // schema 5 (W4c)
    read.close();
  } finally {
    d.cleanup();
    e.cleanup();
  }
});

test("R002 quota pause survives the rolling window, generation changes and reopen; only owner unpause plus new Ready restores eligibility", () => {
  const d = database(),
    p = policy(),
    s = snapshot();
  try {
    for (let n = 1; n <= 7; n++) {
      s.pair.head = n.toString(16).repeat(40);
      s.finalPair = { ...s.pair };
      s.testedParents = [s.pair.base, s.pair.head];
      s.history[1]!.id = "quota-ready" + n;
      s.history[1]!.pair = { ...s.pair };
      d.store.observe(assess(p, s, d.store.target("1:1")));
      const j = d.store.claim(p, s, 30, "review", 100 + n);
      if (n <= 6) {
        assert.ok(j);
        d.store.release(j, {
          run: j.run,
          neverStarted: true,
          treeEnded: false,
          uncertain: false,
        });
      } else assert.equal(j, null);
    }
    assert.equal(d.store.quotaPaused("1:1"), true);
    d.store.settleHolds("1:1", 107, d.store.unsettledHolds()); // a later reconcile's server time (PR48-R015)
    d.store.close();
    const resumed = new Store(d.root);
    try {
      const later = 86400200;
      resumed.observe(assess(p, s, resumed.target("1:1")));
      assert.equal(resumed.claim(p, s, 30, "review", later), null);
      s.history.push({
        id: "wrong-unpause",
        kind: "unpause",
        actor: 20,
        at: later,
        pair: null,
      });
      resumed.clearQuota(p, s);
      assert.equal(resumed.quotaPaused("1:1"), true);
      s.history.push({
        id: "owner-unpause",
        kind: "unpause",
        actor: 10,
        at: later + 1,
        pair: null,
      });
      resumed.clearQuota(p, s);
      resumed.observe(assess(p, s, resumed.target("1:1")));
      assert.equal(resumed.claim(p, s, 30, "review", later + 2), null);
      s.history.push({
        id: "new-ready",
        kind: "ready",
        actor: 20,
        at: later + 3,
        pair: { ...s.pair },
        policy: p.revision,
      });
      resumed.observe(assess(p, s, resumed.target("1:1")));
      const j = resumed.claim(p, s, 30, "review", later + 4);
      assert.ok(j);
      resumed.release(j, {
        run: j.run,
        neverStarted: true,
        treeEnded: false,
        uncertain: false,
      });
    } finally {
      resumed.close();
    }
  } finally {
    d.cleanup();
  }
});

test("R009 clock rollback beyond tolerance refuses inbox/claim/retain atomically; stored clock never moves back", () => {
  const d = database(),
    T0 = 50_000_000;
  try {
    assert.equal(d.store.tick(T0), T0);
    // Within tolerance: the stored (later) time is used and kept.
    assert.equal(d.store.tick(T0 - CLOCK_SKEW_MS), T0);
    assert.equal(d.store.inbox(3, "inside", "pull_request", "synthetic", T0 - 1, "p1"), true);
    assert.equal(
      d.store.db.prepare("SELECT received FROM inbox WHERE delivery='inside'").get()!["received"],
      T0,
    );
    // Beyond tolerance: refused, nothing written, the stored clock is unchanged.
    const behind = T0 - CLOCK_SKEW_MS - 1;
    assert.throws(() => d.store.tick(behind), ClockRollbackError);
    assert.throws(() => d.store.inbox(3, "behind", "pull_request", "synthetic", behind, "p1"), ClockRollbackError);
    assert.throws(() => d.store.oversized(3, "behind-big", "pull_request", behind), ClockRollbackError);
    assert.throws(() => d.store.retain(behind), ClockRollbackError);
    assert.throws(() => claim(d.store, policy(), snapshot(), behind), ClockRollbackError);
    assert.equal(d.store.db.prepare("SELECT count(*) AS n FROM inbox").get()!["n"], 1);
    assert.equal(d.store.db.prepare("SELECT count(*) AS n FROM jobs").get()!["n"], 0);
    assert.equal(d.store.clockBehind(behind), CLOCK_SKEW_MS + 1);
    assert.equal(d.store.db.prepare("SELECT now FROM clock").get()!["now"], T0);
    // After the OS clock catches up, work resumes; no API moves the stored clock back.
    assert.ok(claim(d.store, policy(), snapshot(), T0 + 1));
    assert.equal(d.store.clockBehind(T0 + 1), 0);
  } finally {
    d.cleanup();
  }
});
test("R010 Store refuses a root/DB/WAL/SHM with wrong permissions or links and never fixes them silently", () => {
  if (process.platform === "win32") {
    // The dispatcher is Mac-only: host checks refuse on Windows instead of passing silently.
    assert.throws(() => checkDispatchRoot("C:\\synthetic"), HostCheckError);
    return;
  }
  const d = database();
  try {
    const file = join(d.root, "dispatch.sqlite");
    for (const path of [file, file + "-wal", file + "-shm"])
      assert.equal(lstatSync(path).mode & 0o077, 0, path);
    assert.equal(lstatSync(d.root).mode & 0o077, 0);
    for (const path of [d.root, file, file + "-wal", file + "-shm"]) {
      const mode = lstatSync(path).mode & 0o7777;
      chmodSync(path, mode | 0o040);
      assert.throws(() => new Store(d.root), HostCheckError);
      assert.equal(lstatSync(path).mode & 0o7777, mode | 0o040, "not chmod-ed back");
      chmodSync(path, mode);
    }
    const second = new Store(d.root);
    second.close();
    // A dangling symlink as a journal is refused instead of being followed by SQLite.
    d.store.close();
    for (const suffix of ["-wal", "-shm"]) rmSync(file + suffix, { force: true });
    symlinkSync(join(d.root, "elsewhere"), file + "-wal");
    assert.throws(() => new Store(d.root), HostCheckError);
    assert.equal(existsSync(join(d.root, "elsewhere")), false);
  } finally {
    d.cleanup();
  }
});
test("R011 a signed oversized delivery leaves only a marker that binds nothing and is reported once", () => {
  const d = database();
  try {
    assert.equal(d.store.oversized(3, "big", "pull_request", 10), true);
    assert.equal(d.store.oversized(3, "big", "pull_request", 11), false);
    assert.equal(d.store.pendingInbox().length, 0);
    d.store.retain(8 * 86400000);
    assert.deepEqual(d.store.drainOversized(), ["pull_request"]);
    assert.deepEqual(d.store.drainOversized(), []);
    assert.equal(d.store.oversized(3, "big", "pull_request", 8 * 86400000), false);
  } finally {
    d.cleanup();
  }
});

test("W4c schema 5: a schema 2, 3 or 4 database is refused before any write (no implicit migration)", () => {
  for (const version of [2, 3, 4]) {
    const d = database();
    const file = join(d.root, "dispatch.sqlite");
    try {
      assert.equal(d.store.db.prepare("PRAGMA user_version").get()!["user_version"], 5);
      d.store.db.exec(`PRAGMA user_version=${version}`);
      d.store.close();
      const before = readFileSync(file);
      assert.throws(() => new Store(d.root), /Dispatcher storage|Unknown database schema/, String(version));
      assert.deepEqual(readFileSync(file), before);
    } finally {
      d.cleanup();
    }
  }
});

test("W4 row 1: blocked survives reopen and the owner's lease release; only an owner's later unpause clears it", () => {
  const d = database(),
    p = policy(),
    s = snapshot();
  try {
    const j = claim(d.store, p, s, 100);
    d.store.running(j);
    d.store.block(j, "publication", 200);
    assert.equal(d.store.blocked(j.key)!.at, null); // pending until a reconcile settles it (PR48-R015)
    d.store.settleHolds(j.key, 200, d.store.unsettledHolds());
    assert.equal(d.store.job(j.id)!.status, "uncertain");
    d.store.close();
    const store = new Store(d.root);
    try {
      assert.deepEqual(store.blocked(j.key), { run: j.run, reason: "publication", at: 200 });
      // The owner releases the ended run (supervisor proof): the PR stays blocked.
      store.release(j, { run: j.run, neverStarted: false, treeEnded: true, uncertain: false });
      assert.equal(store.observe(assess(p, s, store.target(j.key))), true);
      assert.equal(store.target(j.key)!.reason, "blocked-owner-required");
      const fresh = snapshot();
      fresh.history[1]!.id = "ready-after-block";
      fresh.history[1]!.at = 300;
      assert.equal(store.claim(p, fresh, 30, "faultfinding", 301), null);
      // An unpause by a non-owner, or by the owner before the block, does not clear it.
      for (const [actor, at] of [[20, 400], [10, 150]] as const) {
        const other = snapshot();
        other.history.push({ id: `unpause-${actor}-${at}`, kind: "unpause", actor, at, pair: null });
        store.clearQuota(p, other);
        assert.ok(store.blocked(j.key), `${actor}@${at}`);
      }
      const owner = snapshot();
      owner.history.push({ id: "owner-unpause", kind: "unpause", actor: 10, at: 400, pair: null });
      store.clearQuota(p, owner);
      assert.equal(store.blocked(j.key), null);
    } finally {
      store.close();
    }
  } finally {
    d.cleanup();
  }
});

test("W4 row 2: a run key is recorded once for its own job, never replaced or reused, and survives reopen", async () => {
  const { runBinding } = await import("./provenance.ts");
  const d = database();
  try {
    const j = claim(d.store);
    const record = { run: j.run, binding: runBinding(j), key: "c".repeat(64) };
    assert.throws(() => d.store.saveRunKey(j, { ...record, binding: "d".repeat(64) }, 101), /Run key rejected/);
    assert.throws(() => d.store.saveRunKey({ ...j, run: "other-run" }, record, 101), /Run key rejected/);
    d.store.saveRunKey(j, record, 101);
    assert.throws(() => d.store.saveRunKey(j, { ...record, key: "e".repeat(64) }, 102));
    d.store.close();
    const store = new Store(d.root);
    try {
      assert.deepEqual(store.runKeys(), [{ job: j, record }]);
    } finally {
      store.close();
    }
  } finally {
    d.cleanup();
  }
});

test("W4 row 8: an edit/delete mark stops claims until the delivery is processed", () => {
  const d = database(),
    p = policy(),
    s = snapshot();
  try {
    d.store.observe(assess(p, s, null));
    assert.equal(d.store.inbox(3, "edit-1", "issue_comment", "{}", 50, "p1", "1:1"), true);
    // A repeated delivery adds neither a row nor a second mark.
    assert.equal(d.store.inbox(3, "edit-1", "issue_comment", "{}", 51, "p1", "1:1"), false);
    assert.equal(d.store.marked("1:1"), true);
    assert.equal(d.store.claim(p, s, 30, "faultfinding", 100), null);
    d.store.processed(3, "edit-1");
    assert.equal(d.store.marked("1:1"), false);
    assert.ok(d.store.claim(p, s, 30, "faultfinding", 101));
  } finally {
    d.cleanup();
  }
});

test("W4 row 7: a redacted result leaves no plaintext in the database file or the WAL", () => {
  const d = database();
  const marker = "SYNTHETIC-PLAINTEXT-" + "q".repeat(40);
  try {
    const j = claim(d.store);
    d.store.running(j);
    d.store.result(j, marker);
    assert.equal(d.store.redactResult(j, marker, "hash-only"), true);
    assert.equal(d.store.redactResult(j, marker, "hash-only"), false); // exact value only
    for (const name of ["dispatch.sqlite", "dispatch.sqlite-wal"]) {
      const path = join(d.root, name);
      if (existsSync(path)) assert.equal(readFileSync(path).includes(marker), false, name);
    }
  } finally {
    d.cleanup();
  }
});

test("W4 capability records are replaced or removed, and faultfinding evidence is the posted red-team record of the same pair and revision", () => {
  const d = database(),
    p = policy(),
    s = snapshot();
  try {
    d.store.saveCapability("claude", { state: "verified" }, 10);
    assert.deepEqual(d.store.capability("claude"), { state: "verified" });
    d.store.saveCapability("claude", null, 11);
    assert.equal(d.store.capability("claude"), null);
    d.store.observe(assess(p, s, null));
    const j = d.store.claim(p, s, 30, "faultfinding", 100)!;
    const value = { actor: 30, decision: "changes-requested", findings: ["PR1-T001"] };
    const id = d.store.outbox(j, "faultfinding", JSON.stringify(value));
    assert.equal(d.store.faultfinding(j.key, s.pair, "p1"), null); // prepared, not posted
    d.store.sending(id);
    d.store.posted(id, "5001");
    assert.deepEqual(d.store.faultfinding(j.key, s.pair, "p1"), { actor: 30, pair: s.pair, unresolved: ["PR1-T001"] });
    assert.equal(d.store.faultfinding(j.key, { ...s.pair, head: "f".repeat(40) }, "p1"), null);
    assert.equal(d.store.faultfinding(j.key, s.pair, "p2"), null);
  } finally {
    d.cleanup();
  }
});

test("W4 a checkpoint kept busy by another reader is retried and then reported once", () => {
  const d = database();
  const marker = "SYNTHETIC-BUSY-" + "r".repeat(30);
  try {
    const j = claim(d.store);
    d.store.running(j);
    d.store.result(j, marker);
    const reader = new DatabaseSync(join(d.root, "dispatch.sqlite"), { readOnly: true });
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM jobs").get();
      assert.equal(d.store.checkpoint(), false);
      assert.equal(d.store.redactResult(j, marker, "hash-only"), true);
      assert.equal(d.store.notice(`${j.key}:checkpoint-busy:${j.run}`), false); // already reported
      reader.exec("COMMIT");
    } finally {
      reader.close();
    }
    assert.equal(d.store.checkpoint(), true);
  } finally {
    d.cleanup();
  }
});

test("Sweep: a posted red-team record without its finding list is unknown, never clear", () => {
  const d = database(),
    p = policy(),
    s = snapshot();
  try {
    d.store.observe(assess(p, s, null));
    const j = d.store.claim(p, s, 30, "faultfinding", 100)!;
    const id = d.store.outbox(j, "faultfinding", JSON.stringify({ actor: 30, decision: "accepted" }));
    d.store.sending(id);
    d.store.posted(id, "7001");
    assert.deepEqual(d.store.faultfinding(j.key, s.pair, "p1")!.unresolved, ["faultfinding-record-unknown"]);
  } finally {
    d.cleanup();
  }
});

test("Round 6 RT-3: a run materials record of the wrong shape is no record (the Broker reports ledger-incomplete)", async () => {
  const { redTeamOpen } = await import("./broker.ts");
  const { fixtureResult } = await import("./runtime.ts");
  const d = database();
  try {
    const good = { planPath: null, ledger: ["INV-LOCK/x"], previousRts: [], guard: "none" as const };
    d.store.saveRunMaterials("run-good", good);
    assert.deepEqual(d.store.runMaterials("run-good"), good);
    for (const [run, value] of [
      ["run-1", { planPath: null, ledger: "INV-LOCK/x", previousRts: [] }],
      ["run-2", { planPath: 3, ledger: [], previousRts: [] }],
      ["run-3", { planPath: null, ledger: [], previousRts: [7] }],
      ["run-4", { planPath: null, ledger: [], previousRts: [], guard: "maybe" }],
    ] as const) {
      d.store.db.prepare("INSERT INTO run_materials VALUES(?,?)").run(run, JSON.stringify(value));
      assert.equal(d.store.runMaterials(run), null, run);
    }
    d.store.db.prepare("INSERT INTO run_materials VALUES(?,?)").run("run-5", "{");
    assert.equal(d.store.runMaterials("run-5"), null);
    const j = { id: "j", key: "1:1", generation: 1, actor: 30, kind: "faultfinding" as const, run: "r", pair: { head: "a".repeat(40), base: "b".repeat(40) }, policy: "p1" };
    assert.ok(redTeamOpen({ ...fixtureResult(j), decision: "accepted", unverified: [] }, d.store.runMaterials("run-1")).includes("ledger-incomplete"));
  } finally {
    d.cleanup();
  }
});

test("PR48-R015 holds are timed on the server clock once settled: local skew, an earlier unpause or one before settling never clear them", () => {
  const S = 50_000_000; // GitHub server time
  for (const [skew, local] of [["behind", 100], ["ahead", S + 10 * 86400000]] as const) {
    const d = database(),
      p = policy(),
      s = snapshot();
    s.history.push({ id: "old-unpause", kind: "unpause", actor: 10, at: S - 1000, pair: null });
    try {
      for (let n = 1; n <= 7; n++) {
        s.pair.head = n.toString(16).repeat(40);
        s.finalPair = { ...s.pair };
        s.testedParents = [s.pair.base, s.pair.head];
        s.history[1]!.id = `skew-ready${n}`;
        s.history[1]!.at = S - 500;
        s.history[1]!.pair = { ...s.pair };
        d.store.observe(assess(p, s, d.store.target("1:1")));
        const j = d.store.claim(p, s, 30, "review", local + n);
        if (n <= 6) {
          assert.ok(j, `${skew} ${n}`);
          d.store.release(j, { run: j.run, neverStarted: true, treeEnded: false, uncertain: false });
        } else assert.equal(j, null, skew);
      }
      // Pending: no unpause counts, not even one after the pause.
      s.history.push({ id: "early-unpause", kind: "unpause", actor: 10, at: S + 1, pair: null });
      d.store.clearQuota(p, s);
      assert.equal(d.store.quotaPaused("1:1"), true, `${skew}: pending`);
      assert.deepEqual(d.store.status("1:1").pending, ["quota_pause"]);
      // Settled by a later reconcile at S + 5: unpauses at or before it still do not count.
      d.store.settleHolds("1:1", S + 5, d.store.unsettledHolds());
      d.store.clearQuota(p, s);
      assert.equal(d.store.quotaPaused("1:1"), true, `${skew}: before the settled time`);
      s.history.push({ id: "owner-unpause", kind: "unpause", actor: 10, at: S + 6, pair: null });
      d.store.clearQuota(p, s);
      assert.equal(d.store.quotaPaused("1:1"), false, `${skew}: a later owner unpause clears`);
    } finally {
      d.cleanup();
    }
  }
  // A hold made after a reconcile began is not settled by that reconcile.
  const d = database();
  try {
    const j = claim(d.store);
    d.store.running(j);
    const before = d.store.unsettledHolds();
    d.store.block(j, "publication", 101);
    d.store.settleHolds(j.key, S, before);
    assert.equal(d.store.blocked(j.key)!.at, null);
    d.store.settleHolds(j.key, S + 1, d.store.unsettledHolds());
    assert.equal(d.store.blocked(j.key)!.at, S + 1);
  } finally {
    d.cleanup();
  }
});
