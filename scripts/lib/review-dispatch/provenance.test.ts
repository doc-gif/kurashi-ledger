import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hash, type Job } from "./model.ts";
import * as provenance from "./provenance.ts";
import {
  RunVerifier,
  parseRunKeyLine,
  parseSignedResult,
  provenanceOf,
  runBinding,
  signedMessage,
  verifyOneTime,
} from "./provenance.ts";
import { ReviewBroker, parseResult } from "./broker.ts";
import {
  database,
  claim,
  policy,
  snapshot,
} from "../../../tests/fixtures/review-dispatch.ts";

// Produced by tools/review_dispatch/supervisor.py (the only signer) from a fixed synthetic seed.
// .review/tests/test_dispatch_supervisor.py reproduces the same bytes, so both languages agree.
const vector = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/review-dispatch-run-signature.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  job: Job;
  binding: string;
  result: string;
  resultHash: string;
  key: string;
  signature: string;
};
const job = (): Job => structuredClone(vector.job);
const keyLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 1,
    type: "run-key",
    run: vector.job.run,
    binding: vector.binding,
    key: vector.key,
    ...over,
  });
const resultLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 1,
    type: "run-result",
    run: vector.job.run,
    binding: vector.binding,
    resultHash: vector.resultHash,
    result: vector.result,
    signature: vector.signature,
    ...over,
  });
const flip = (hex: string, at: number): string =>
  hex.slice(0, at) + (hex[at] === "0" ? "1" : "0") + hex.slice(at + 1);

test("PR48-R003 verifier accepts the supervisor-signed vector bound to its job", () => {
  const j = job();
  assert.equal(runBinding(j), vector.binding);
  assert.equal(hash(vector.result), vector.resultHash);
  assert.deepEqual(parseResult(vector.result, j).run, j.run);
  const verifier = new RunVerifier();
  verifier.register(j, parseRunKeyLine(keyLine()));
  const { raw, origin } = provenanceOf(j, parseSignedResult(resultLine()));
  assert.equal(verifier.verify(j, raw, origin), true);
});

test("PR48-R003 any change to result, run, job binding, key or signature is rejected", () => {
  const j = job(),
    message = signedMessage(j.run, vector.binding, vector.resultHash);
  assert.equal(verifyOneTime(vector.key, message, vector.signature), true);
  for (const at of [0, 63, 64, 127, 16000, vector.signature.length - 1])
    assert.equal(
      verifyOneTime(vector.key, message, flip(vector.signature, at)),
      false,
    );
  assert.equal(
    verifyOneTime(flip(vector.key, 5), message, vector.signature),
    false,
  );
  assert.equal(
    verifyOneTime(
      vector.key,
      signedMessage(j.run, vector.binding, hash("other")),
      vector.signature,
    ),
    false,
  );
  assert.equal(verifyOneTime(vector.key, message, ""), false);
  assert.equal(
    verifyOneTime(vector.key, message, vector.signature.toUpperCase()),
    false,
  );

  const verifier = new RunVerifier();
  verifier.register(j, parseRunKeyLine(keyLine()));
  const { raw, origin } = provenanceOf(j, parseSignedResult(resultLine()));
  for (const [r, o] of [
    [raw + " ", origin],
    [raw, { ...origin, resultHash: hash(raw + " ") }],
    [raw, { ...origin, run: "other-run" }],
    [raw, { ...origin, actor: 20 }],
    [raw, { ...origin, signature: flip(origin.signature, 10) }],
  ] as const)
    assert.equal(verifier.verify(j, r, o), false);
  // The same signature cannot be used for a different generation, pair, policy or actor of the job.
  for (const changed of [
    { ...j, generation: j.generation + 1 },
    { ...j, pair: { ...j.pair, base: "c".repeat(40) } },
    { ...j, policy: "synthetic-r2" },
    { ...j, actor: 31 },
    { ...j, kind: "faultfinding" as const },
  ])
    assert.equal(
      verifier.verify(changed, raw, { ...origin, actor: changed.actor }),
      false,
    );
});

test("PR48-R003 keys come only from the launch record; files a worker can write are not trusted", () => {
  const j = job(),
    signed = parseSignedResult(resultLine());
  // No launch record (e.g. a restarted dispatcher before W4 persists it): unverifiable, so not posted.
  const empty = new RunVerifier();
  const { raw, origin } = provenanceOf(j, signed);
  assert.equal(empty.verify(j, raw, origin), false);
  // A launch record for a different job binding is refused at registration.
  assert.throws(() =>
    new RunVerifier().register(
      j,
      parseRunKeyLine(keyLine({ binding: "c".repeat(64) })),
    ),
  );
  assert.throws(() =>
    new RunVerifier().register(
      { ...j, run: "another-run" },
      parseRunKeyLine(keyLine()),
    ),
  );
  // One-time keys: a run registers once and a key is never reused for another run.
  const verifier = new RunVerifier();
  verifier.register(j, parseRunKeyLine(keyLine()));
  assert.throws(() => verifier.register(j, parseRunKeyLine(keyLine())));
  const other = { ...j, run: "00000000-0000-4000-8000-000000000002" };
  assert.throws(() =>
    verifier.register(
      other,
      parseRunKeyLine(keyLine({ run: other.run, binding: runBinding(other) })),
    ),
  );
  // An envelope for another job cannot be adopted.
  assert.throws(() => provenanceOf(other, signed));
});

test("PR48-R003 supervisor lines are parsed strictly", () => {
  for (const bad of [
    keyLine({ schema: 2 }),
    keyLine({ type: "run-result" }),
    keyLine({ key: "A".repeat(64) }),
    keyLine({ run: "bad run" }),
    keyLine({ extra: true }),
    "not json",
    "[]",
  ])
    assert.throws(() => parseRunKeyLine(bad));
  for (const bad of [
    resultLine({ resultHash: hash("other") }),
    resultLine({ result: "" }),
    resultLine({ signature: vector.signature.slice(2) }),
    resultLine({ type: "run-key" }),
    resultLine({ extra: 1 }),
    resultLine({ result: "x".repeat(32769), resultHash: hash("x".repeat(32769)) }),
  ])
    assert.throws(() => parseSignedResult(bad));
});

test("PR48-R003 the TypeScript side is verify-only", () => {
  // No signing, sealing or key-generation entry point exists on the dispatcher/Broker side.
  assert.deepEqual(Object.keys(provenance).sort(), [
    "RunVerifier",
    "parseRunKeyLine",
    "parseSignedResult",
    "provenanceOf",
    "runBinding",
    "signedMessage",
    "verifyOneTime",
  ]);
  const proto = Object.getOwnPropertyNames(RunVerifier.prototype).sort();
  assert.deepEqual(proto, ["constructor", "register", "verify"]);
});

test("PR48-R003 Broker with the verify-only RunVerifier refuses unsigned or foreign results", async () => {
  const d = database();
  try {
    const p = policy(),
      s = snapshot(),
      j = claim(d.store);
    d.store.running(j);
    const raw = JSON.stringify({
      schema: 1,
      run: j.run,
      actor: j.actor,
      generation: j.generation,
      pair: j.pair,
      decision: "needs-owner",
      summary: "合成試験の結果です。",
      findings: [],
      evidence: [],
      unverified: ["実AI・本導入は未検証"],
    });
    d.store.result(j, raw);
    let posts = 0;
    const verifier = new RunVerifier(),
      broker = new ReviewBroker(
        30,
        {
          post: async () => {
            posts++;
          },
          list: async () => [],
        },
        d.store,
        verifier,
      );
    // Not registered at launch.
    await assert.rejects(
      broker.submit(
        p,
        j,
        raw,
        { run: j.run, actor: j.actor, resultHash: hash(raw), signature: vector.signature },
        async () => s,
      ),
      /Untrusted run provenance/,
    );
    // Registered, but the signature belongs to another run's key.
    verifier.register(j, { run: j.run, binding: runBinding(j), key: vector.key });
    await assert.rejects(
      broker.submit(
        p,
        j,
        raw,
        { run: j.run, actor: j.actor, resultHash: hash(raw), signature: vector.signature },
        async () => s,
      ),
      /Untrusted run provenance/,
    );
    await assert.rejects(
      broker.submit(p, j, raw, null, async () => s),
      /Untrusted run provenance/,
    );
    assert.equal(posts, 0);
  } finally {
    d.cleanup();
  }
});
