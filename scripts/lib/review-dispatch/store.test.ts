import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Store, canonicalRoot } from "./store.ts";
import { assess } from "./reducer.ts";
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
      d.store.inbox(3, "delivery", "pull_request", "synthetic", 0),
      true,
    );
    d.store.processed(3, "delivery");
    d.store.retain(8 * 86400000);
    assert.equal(
      d.store.inbox(3, "delivery", "pull_request", "replay", 8 * 86400000),
      false,
    );
    assert.equal(d.store.pendingInbox().length, 0);
    const second = new Store(d.root);
    assert.equal(
      second.inbox(3, "delivery", "pull_request", "replay", 8 * 86400000),
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
  const d = database();
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
      const j = d.store.claim(p, s, 30, "review", n + 100);
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
    assert.throws(() => d.store.claim(p, snapshot(), 30, "review", 1));
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
    d.store.inbox(3, "delivery", "pull_request", "synthetic", 0);
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
    d.store.inbox(3, "retained", "pull_request", "synthetic", 0);
    const path = join(e.root, "copy.sqlite");
    await d.store.backup(path);
    await assert.rejects(d.store.backup(path));
    const read = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      read.prepare("SELECT delivery FROM inbox").get()!["delivery"],
      "retained",
    );
    assert.equal(read.prepare("PRAGMA user_version").get()!["user_version"], 2);
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
