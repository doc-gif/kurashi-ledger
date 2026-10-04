import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { request } from "node:http";
import { once } from "node:events";
import { ingest, serve, MAX_BODY } from "./webhook.ts";
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
