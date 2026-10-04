import assert from "node:assert/strict";
import { test } from "node:test";
import { ReviewBroker, RunChannel, parseResult } from "./broker.ts";
import { hash } from "./model.ts";
import { fixtureResult } from "./runtime.ts";
import {
  database,
  claim,
  policy,
  snapshot,
} from "../../../tests/fixtures/review-dispatch.ts";

test("D03 actual outbox recovery recognizes posted review without repeat POST", async () => {
  const d = database();
  try {
    const p = policy(),
      s = snapshot(),
      j = claim(d.store);
    d.store.running(j);
    const raw = JSON.stringify({
      ...fixtureResult(j),
      decision: "accepted",
      unverified: [],
    });
    d.store.result(j, raw);
    let posts = 0;
    const rows: { id: string; actor: number; head: string; body: string }[] =
      [];
    const b = new ReviewBroker(
      30,
      {
        post: async (_pr, _event, head, body) => {
          posts++;
          rows.push({ id: "r1", actor: 30, head, body });
          throw new Error("reply lost");
        },
        list: async () => rows,
      },
      d.store,
      new RunChannel(Buffer.alloc(32, 7)),
    );
    const origin = b.channel.seal(j, raw);
    assert.equal(await b.submit(p, j, raw, origin, async () => s), "posted");
    assert.equal(posts, 1);
  } finally {
    d.cleanup();
  }
});
test("D03 uncertain POST without remote proof never sends again", async () => {
  const d = database();
  try {
    const p = policy(),
      s = snapshot(),
      j = claim(d.store);
    d.store.running(j);
    const raw = JSON.stringify(fixtureResult(j));
    d.store.result(j, raw);
    let posts = 0;
    const b = new ReviewBroker(
        30,
        {
          post: async () => {
            posts++;
            throw new Error("unknown");
          },
          list: async () => [],
        },
        d.store,
        new RunChannel(Buffer.alloc(32, 7)),
      ),
      origin = b.channel.seal(j, raw);
    assert.equal(await b.submit(p, j, raw, origin, async () => s), "uncertain");
    assert.equal(await b.submit(p, j, raw, origin, async () => s), "uncertain");
    assert.equal(posts, 1);
  } finally {
    d.cleanup();
  }
});
test("D06 wrong actor/run/hash/provenance and self pusher cannot post", async () => {
  const d = database();
  try {
    const p = policy(),
      s = snapshot(),
      j = claim(d.store);
    d.store.running(j);
    const raw = JSON.stringify(fixtureResult(j));
    d.store.result(j, raw);
    let calls = 0;
    const b = new ReviewBroker(
      30,
      {
        post: async () => {
          calls++;
        },
        list: async () => [],
      },
      d.store,
      new RunChannel(Buffer.alloc(32, 7)),
    );
    const origin = b.channel.seal(j, raw);
    for (const invalid of [
      { ...origin, actor: 20 },
      { ...origin, run: "other" },
      { ...origin, resultHash: "wrong" },
      { ...origin, signature: "0".repeat(64) },
    ])
      await assert.rejects(b.submit(p, j, raw, invalid, async () => s));
    s.pushers!.push(30);
    assert.equal(await b.submit(p, j, raw, origin, async () => s), "stale");
    assert.equal(calls, 0);
  } finally {
    d.cleanup();
  }
});
test("D04 before-post head/base/Ready is fetched again; active identity cannot choose another broker", async () => {
  const d = database();
  try {
    const p = policy(),
      s = snapshot(),
      j = claim(d.store);
    d.store.running(j);
    const raw = JSON.stringify(fixtureResult(j));
    d.store.result(j, raw);
    const b = new ReviewBroker(
      30,
      { post: async () => assert.fail("stale POST"), list: async () => [] },
      d.store,
      new RunChannel(Buffer.alloc(32, 7)),
    );
    s.pair.base = "d".repeat(40);
    assert.equal(
      await b.submit(p, j, raw, b.channel.seal(j, raw), async () => s),
      "stale",
    );
  } finally {
    d.cleanup();
  }
});
test("D10 schema forbids fabricated fields, duplicate findings and accepted with findings", () => {
  const d = database();
  try {
    const j = claim(d.store),
      r = fixtureResult(j);
    for (const invalid of [
      { ...r, actor: 20 },
      { ...r, extra: "override" },
      {
        ...r,
        decision: "accepted",
        findings: [
          { id: "PR1-R001", location: "x", impact: "x", completion: "x" },
        ],
      },
      { ...r, evidence: ["https://untrusted.example/"] },
      { ...r, summary: "" },
    ])
      assert.throws(() => parseResult(JSON.stringify(invalid), j));
    assert.deepEqual(parseResult(JSON.stringify(r), j), r);
  } finally {
    d.cleanup();
  }
});
