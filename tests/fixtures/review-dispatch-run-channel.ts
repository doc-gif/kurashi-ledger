// Test-only fake run endpoint. It can seal results, so it must never be the verifier of a real run and does not
// live in the product code (PR #53 red team P2-1). Real runs are signed by tools/review_dispatch/supervisor.py and
// checked with scripts/lib/review-dispatch/provenance.ts RunVerifier, which has no signing code.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { hash, type Job } from "../../scripts/lib/review-dispatch/model.ts";
import type { Provenance } from "../../scripts/lib/review-dispatch/broker.ts";
import type { ResultVerifier } from "../../scripts/lib/review-dispatch/provenance.ts";
import type { Store } from "../../scripts/lib/review-dispatch/store.ts";

export class RunChannel implements ResultVerifier {
  private readonly secret: Buffer;
  constructor(secret: Buffer) {
    if (secret.length < 32) throw new Error("Run channel secret missing");
    this.secret = Buffer.from(secret);
  }
  seal(j: Job, raw: string): Provenance {
    const value = { run: j.run, actor: j.actor, resultHash: hash(raw) };
    return { ...value, signature: this.mac(j, value.resultHash) };
  }
  verify(j: Job, raw: string, origin: Provenance): boolean {
    if (
      origin.run !== j.run ||
      origin.actor !== j.actor ||
      origin.resultHash !== hash(raw) ||
      !/^[a-f0-9]{64}$/.test(origin.signature)
    )
      return false;
    return timingSafeEqual(
      Buffer.from(origin.signature, "hex"),
      Buffer.from(this.mac(j, origin.resultHash), "hex"),
    );
  }
  private mac(j: Job, digest: string): string {
    return createHmac("sha256", this.secret)
      .update(
        JSON.stringify([
          j.run,
          j.actor,
          j.generation,
          j.policy,
          j.pair,
          digest,
        ]),
      )
      .digest("hex");
  }
}

// The supervisor-signed synthetic vector (tests/fixtures/review-dispatch-run-signature.json).
export type SignedVector = {
  job: Job;
  binding: string;
  result: string;
  resultHash: string;
  key: string;
  signature: string;
  seed: string;
  independent: {
    bindingPreimage: string;
    binding: string;
    resultHash: string;
    message: string;
    messageDigest: string;
  };
};
export function signedVector(): SignedVector {
  return JSON.parse(
    readFileSync(
      new URL("./review-dispatch-run-signature.json", import.meta.url),
      "utf8",
    ),
  ) as SignedVector;
}

// Test-only: give a freshly claimed job the vector's fixed id/run, so a supervisor-signed result can flow
// through the real Store/Broker path. The vector job matches the shared fixture claim (key 1:1, generation 1, p1).
export function adoptVectorJob(store: Store, claimed: Job): Job {
  const v = signedVector().job;
  for (const k of ["key", "generation", "actor", "kind", "policy"] as const)
    if (claimed[k] !== v[k]) throw new Error(`vector job differs in ${k}`);
  store.db.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;");
  try {
    store.db
      .prepare("UPDATE leases SET job=? WHERE job=?")
      .run(v.id, claimed.id);
    store.db
      .prepare("UPDATE jobs SET id=?, run=?, value=? WHERE id=?")
      .run(v.id, v.run, JSON.stringify(v), claimed.id);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return structuredClone(v);
}
