import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { request } from "node:http";
import { once } from "node:events";
import {
  ingest,
  ingestOversized,
  serve,
  MAX_BODY,
  MAX_DELIVERY,
} from "./webhook.ts";
import { CLOCK_SKEW_MS } from "./store.ts";
import { database, policy } from "../../../tests/fixtures/review-dispatch.ts";
const secret = Buffer.alloc(32, 7),
  body = Buffer.from(
    JSON.stringify({
      repository: { id: 1 },
      installation: { id: 2 },
      sender: { id: 20 },
      action: "ready_for_review",
    }),
  );
const headers = (raw = body) => ({
  "x-hub-signature-256":
    "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"),
  "x-github-event": "pull_request",
  "x-github-delivery": "synthetic-delivery",
});

test("D07 signature/raw bytes/body bound/allowed repo/install and off refuse side effects", () => {
  const d = database();
  try {
    const p = policy();
    p.mode = "shadow";
    assert.equal(ingest(p, d.store, secret, headers(), body, 100), 202);
    assert.equal(ingest(p, d.store, secret, headers(), body, 101), 202);
    assert.equal(d.store.pendingInbox().length, 1);
    assert.equal(
      ingest(
        p,
        d.store,
        secret,
        { ...headers(), "x-hub-signature-256": "sha256=" + "a".repeat(64) },
        body,
        102,
      ),
      401,
    );
    assert.equal(
      ingest(
        p,
        d.store,
        secret,
        headers(),
        Buffer.concat([body, Buffer.from(" ")]),
        102,
      ),
      401,
    );
    assert.equal(
      ingest(p, d.store, secret, headers(), Buffer.alloc(MAX_BODY + 1), 102),
      413,
    );
    const other = Buffer.from(
      JSON.stringify({
        repository: { id: 9 },
        installation: { id: 2 },
        sender: { id: 20 },
      }),
    );
    assert.equal(ingest(p, d.store, secret, headers(other), other, 102), 403);
    p.mode = "off";
    assert.equal(ingest(p, d.store, secret, headers(), body, 102), 503);
  } finally {
    d.cleanup();
  }
});
test("I003 local HTTP acknowledges durable inbox quickly and refuses unknown routes", async () => {
  const d = database(),
    p = policy();
  p.mode = "shadow";
  const server = serve(p, d.store, secret, () => 100);
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const started = Date.now();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: "/webhook",
          method: "POST",
          headers: headers(),
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(status, 202);
    assert.ok(Date.now() - started < 10000);
    assert.equal(d.store.pendingInbox().length, 1);
    d.store.close();
    assert.equal(
      ingest(
        p,
        d.store,
        secret,
        { ...headers(), "x-github-delivery": "new-delivery" },
        body,
        101,
      ),
      503,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    d.cleanup();
  }
});

const post = (port: number, h: Record<string, string>, raw: Buffer) =>
  new Promise<number>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/webhook", method: "POST", headers: h },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
    req.end(raw);
  });
test("R011 signed oversized delivery: streamed HMAC, 413, marker without payload; unsigned leaves nothing", async () => {
  const d = database(),
    p = policy();
  p.mode = "shadow";
  const server = serve(p, d.store, secret, () => 100);
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const big = Buffer.alloc(MAX_BODY + 4096, 0x20);
    assert.equal(
      await post(address.port, { ...headers(big), "x-github-delivery": "forged" }, Buffer.concat([big, Buffer.from("x")])),
      401,
    );
    assert.equal(d.store.drainOversized().length, 0);
    assert.equal(
      await post(address.port, { ...headers(big), "x-github-delivery": "oversized" }, big),
      413,
    );
    assert.equal(d.store.pendingInbox().length, 0);
    assert.equal(
      d.store.db.prepare("SELECT payload FROM inbox WHERE delivery='oversized'").get()!["payload"],
      null,
    );
    assert.deepEqual(d.store.drainOversized(), ["pull_request"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    d.cleanup();
  }
});
test("R011 oversized marker limits: off, size bounds, event allow-list and clock rollback record nothing", () => {
  const d = database(),
    p = policy();
  p.mode = "shadow";
  try {
    const big = Buffer.alloc(MAX_BODY + 1),
      digest = createHmac("sha256", secret).update(big).digest(),
      h = headers(big);
    assert.equal(ingestOversized(p, d.store, secret, h, digest, MAX_BODY, 1), 413);
    assert.equal(ingestOversized(p, d.store, secret, h, digest, MAX_DELIVERY + 1, 1), 413);
    assert.equal(
      ingestOversized(p, d.store, secret, { ...h, "x-github-event": "member" }, digest, big.length, 1),
      400,
    );
    assert.equal(ingestOversized(p, d.store, secret, h, Buffer.alloc(32), big.length, 1), 401);
    d.store.tick(1_000_000);
    assert.equal(
      ingestOversized(p, d.store, secret, h, digest, big.length, 1_000_000 - CLOCK_SKEW_MS - 1),
      503,
    );
    // PR48-R009: a normal delivery during a clock rollback is not acknowledged either.
    assert.equal(ingest(p, d.store, secret, headers(), body, 1_000_000 - CLOCK_SKEW_MS - 1), 503);
    p.mode = "off";
    assert.equal(ingestOversized(p, d.store, secret, h, digest, big.length, 1_000_000), 503);
    assert.deepEqual(d.store.drainOversized(), []);
    assert.equal(d.store.pendingInbox().length, 0);
  } finally {
    d.cleanup();
  }
});

test("W4 row 8: edit/delete/dismiss deliveries mark their PR in the same transaction; other actions do not", () => {
  const d = database(),
    p = policy();
  try {
    const send = (event: string, payload: Record<string, unknown>, delivery: string) => {
      const raw = Buffer.from(
        JSON.stringify({ repository: { id: 1 }, installation: { id: 2 }, sender: { id: 40 }, ...payload }),
      );
      return ingest(
        p,
        d.store,
        secret,
        { ...headers(raw), "x-github-event": event, "x-github-delivery": delivery },
        raw,
        100,
      );
    };
    // Policy target PR 1: registered participants 30 and 40, owner 10, implementer 20. Only registered
    // participants' (not the implementer's) and owners' items mark; other PRs and third parties do not.
    const by = (id: number) => ({ user: { id } });
    const cases: [string, Record<string, unknown>, string | null][] = [
      ["pull_request_review", { action: "edited", pull_request: { number: 1 }, review: by(30) }, "1:1"],
      ["pull_request_review", { action: "dismissed", pull_request: { number: 1 }, review: by(10) }, "1:1"],
      ["pull_request_review", { action: "edited", pull_request: { number: 1 }, review: by(999) }, null],
      ["pull_request_review", { action: "submitted", pull_request: { number: 1 }, review: by(30) }, null],
      ["pull_request_review_comment", { action: "deleted", pull_request: { number: 1 }, comment: by(30) }, "1:1"],
      ["pull_request_review_comment", { action: "deleted", pull_request: { number: 1 }, comment: by(20) }, null], // implementer
      ["pull_request_review_comment", { action: "edited", pull_request: { number: 1 }, comment: by(40) }, "1:1"], // registered, not assigned
      ["pull_request_review_comment", { action: "created", pull_request: { number: 1 }, comment: by(30) }, null],
      ["issue_comment", { action: "edited", issue: { number: 1, pull_request: {} }, comment: by(30) }, "1:1"],
      ["issue_comment", { action: "edited", issue: { number: 1, pull_request: {} }, comment: {} }, "1:1"], // unreadable author
      ["issue_comment", { action: "deleted", issue: { number: 1 }, comment: by(30) }, null], // a plain issue
      ["issue_comment", { action: "deleted", issue: { number: 9, pull_request: {} }, comment: by(30) }, null], // not a target
      ["pull_request", { action: "edited", pull_request: { number: 1 } }, null],
    ];
    cases.forEach(([event, payload, mark], i) => {
      assert.equal(send(event, payload, `signal-${i}`), 202, event);
      const marked = d.store.db.prepare("SELECT key FROM marks WHERE delivery=?").get(`signal-${i}`);
      assert.equal(marked?.["key"] ?? null, mark, `${i} ${event} ${String(payload["action"])}`);
    });
  } finally {
    d.cleanup();
  }
});

test("W4 receiver listens on loopback only, on a fixed port other than 443, and refuses off mode", async () => {
  const d = database(),
    p = policy();
  try {
    for (const port of [443, 80, 1023, 65536, 1.5, -1])
      assert.throws(() => serve(p, d.store, secret, () => 100, port), /port/, String(port));
    p.mode = "off";
    assert.throws(() => serve(p, d.store, secret, () => 100), /off/);
    p.mode = "active";
    let stored = 0;
    const server = serve(p, d.store, secret, () => 100, 0, () => stored++);
    await once(server, "listening");
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      assert.equal(address.address, "127.0.0.1");
      assert.equal(await post(address.port, headers(), body), 202);
      assert.equal(await post(address.port, { ...headers(), "x-hub-signature-256": "sha256=" + "0".repeat(64) }, body), 401);
      assert.equal(stored, 1); // only after a durable 202
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  } finally {
    d.cleanup();
  }
});

test("PR58-R003 the receiver records the policy revision current at receipt; a failed re-read stores nothing (503)", async () => {
  const d = database(),
    p = policy();
  p.mode = "shadow";
  let revision: () => string = () => "p1";
  const server = serve(p, d.store, secret, () => 100, 0, () => {}, () => revision());
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const send = (id: string) => post(address.port, { ...headers(), "x-github-delivery": id }, body);
    assert.equal(await send("before"), 202);
    revision = () => "p2"; // the owner raised the revision; no restart
    assert.equal(await send("after"), 202);
    revision = () => {
      throw new Error("policy unreadable");
    };
    assert.equal(await send("unreadable"), 503);
    assert.deepEqual(
      d.store.pendingInbox().map((r) => [r["delivery"], r["policy"]]).sort(),
      [["after", "p2"], ["before", "p1"]],
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    d.cleanup();
  }
});
