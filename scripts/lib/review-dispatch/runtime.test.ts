import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Dispatcher,
  capabilityReady,
  workerEnvironment,
  fixtureResult,
  type Capability,
} from "./runtime.ts";
import { ReviewBroker } from "./broker.ts";
import { RunChannel } from "../../../tests/fixtures/review-dispatch-run-channel.ts";
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
    // The fake run endpoint seals; the dispatcher only forwards and the Broker only verifies.
    const endpoint = new RunChannel(Buffer.alloc(32, 7));
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
      endpoint,
    );
    const runner = {
      capability,
      run: async (j: Parameters<typeof fixtureResult>[0]) => {
        launches++;
        const result = JSON.stringify(fixtureResult(j));
        return {
          result,
          treeEnded: true,
          uncertain: false,
          origin: endpoint.seal(j, result),
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
            origin: null,
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

test("PR48-R003 dispatcher never signs: a runner result without run provenance is not posted", async () => {
  const variants = [
    (): null => null,
    // Sealed by a different endpoint key: the dispatcher cannot launder it into a valid origin.
    (j: Parameters<typeof fixtureResult>[0], r: string) =>
      new RunChannel(Buffer.alloc(32, 8)).seal(j, r),
  ];
  for (const origin of variants) {
    const d = database();
    try {
      const p = policy(),
        s = snapshot(),
        engine = new Dispatcher(p, d.store);
      let posts = 0;
      const broker = new ReviewBroker(
        30,
        {
          post: async () => {
            posts++;
          },
          list: async () => [],
        },
        d.store,
        new RunChannel(Buffer.alloc(32, 7)),
      );
      const result = await engine.fixtureCycle(
        s,
        30,
        {
          capability,
          run: async (j) => {
            const r = JSON.stringify(fixtureResult(j));
            return {
              result: r,
              treeEnded: true,
              uncertain: false,
              origin: origin(j, r),
            };
          },
        },
        broker,
        async () => s,
        100,
      );
      assert.equal(result, "uncertain");
      // The lease stays held for owner reconciliation; nothing relaunches.
      assert.equal(
        await engine.fixtureCycle(
          s,
          30,
          { capability, run: async () => assert.fail("relaunch") },
          broker,
          async () => s,
          101,
        ),
        "waiting",
      );
      assert.equal(posts, 0);
    } finally {
      d.cleanup();
    }
  }
});
