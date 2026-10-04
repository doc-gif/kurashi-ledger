import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Dispatcher,
  capabilityReady,
  workerEnvironment,
  fixtureResult,
  type Capability,
} from "./runtime.ts";
import { ReviewBroker, RunChannel } from "./broker.ts";
import {
  database,
  policy,
  snapshot,
} from "../../../tests/fixtures/review-dispatch.ts";
const capability: Capability = {
  backend: "fixture",
  version: "synthetic-1",
  codeHash: "a".repeat(64),
  profileHash: "b".repeat(64),
  probes: Object.fromEntries(
    [
      "deny-network",
      "deny-gh-auth",
      "deny-other-ai-auth",
      "deny-keys",
      "deny-db",
      "deny-policy-write",
      "schema",
      "descendant-lock",
    ].map((k) => [k, true]),
  ),
};
test("D08 complete fake-runner cycle posts once and ignores unchanged replay", async () => {
  const d = database();
  try {
    const p = policy(),
      s = snapshot(),
      engine = new Dispatcher(p, d.store);
    let launches = 0,
      posts = 0;
    const rows: { id: string; actor: number; head: string; body: string }[] =
      [];
    const broker = new ReviewBroker(
      30,
      {
        post: async (_pr, _event, head, body) => {
          posts++;
          rows.push({ id: "r1", actor: 30, head, body });
        },
        list: async () => rows,
      },
      d.store,
      new RunChannel(Buffer.alloc(32, 7)),
    );
    const runner = {
      capability,
      run: async (j: Parameters<typeof fixtureResult>[0]) => {
        launches++;
        return {
          result: JSON.stringify(fixtureResult(j)),
          treeEnded: true,
          uncertain: false,
        };
      },
    };
    assert.equal(
      await engine.fixtureCycle(s, 30, runner, broker, async () => s, 100),
      "posted",
    );
    assert.equal(
      await engine.fixtureCycle(s, 30, runner, broker, async () => s, 101),
      "waiting",
    );
    assert.equal(launches, 1);
    assert.equal(posts, 1);
  } finally {
    d.cleanup();
  }
});
test("D10 off/shadow and unverified real CLI start no workers or posts", async () => {
  for (const mode of ["off", "shadow", "active"] as const) {
    const d = database();
    try {
      const p = policy();
      p.mode = mode;
      const engine = new Dispatcher(p, d.store),
        s = snapshot(),
        broker = new ReviewBroker(
          30,
          { post: async () => assert.fail("POST"), list: async () => [] },
          d.store,
          new RunChannel(Buffer.alloc(32, 7)),
        );
      const result = await engine.fixtureCycle(
        s,
        30,
        {
          capability: { ...capability, backend: "claude" },
          run: async () => assert.fail("AI launch"),
        },
        broker,
        async () => s,
        100,
      );
      assert.equal(result, mode === "active" ? "capability-disabled" : mode);
    } finally {
      d.cleanup();
    }
  }
  assert.equal(capabilityReady({ ...capability, probes: {} }), false);
  assert.deepEqual(
    Object.keys(workerEnvironment("/synthetic", "/usr/bin")).sort(),
    ["HOME", "LANG", "NO_COLOR", "PATH", "TMPDIR"],
  );
});
test("D03 runner uncertainty retains lease after dispatcher restart", async () => {
  const d = database();
  try {
    const p = policy(),
      s = snapshot(),
      engine = new Dispatcher(p, d.store),
      broker = new ReviewBroker(
        30,
        { post: async () => assert.fail("POST"), list: async () => [] },
        d.store,
        new RunChannel(Buffer.alloc(32, 7)),
      );
    assert.equal(
      await engine.fixtureCycle(
        s,
        30,
        {
          capability,
          run: async (j) => ({
            result: JSON.stringify(fixtureResult(j)),
            treeEnded: false,
            uncertain: true,
          }),
        },
        broker,
        async () => s,
        100,
      ),
      "uncertain",
    );
    const second = new Dispatcher(p, d.store);
    assert.equal(
      await second.fixtureCycle(
        s,
        30,
        { capability, run: async () => assert.fail("duplicate") },
        broker,
        async () => s,
        101,
      ),
      "waiting",
    );
  } finally {
    d.cleanup();
  }
});
