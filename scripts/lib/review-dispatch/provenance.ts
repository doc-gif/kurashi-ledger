import { createHash, timingSafeEqual } from "node:crypto";
import { hash, type Job } from "./model.ts";
import type { Provenance } from "./broker.ts";

// Verify-only side of PR48-R003. The run supervisor (tools/review_dispatch/supervisor.py) is the only signer:
// it creates a one-time key per run outside the worker boundary, announces the public commitment on its own
// stdout before the worker starts, and signs exactly one result. This module has no signing code; the
// dispatcher and the Broker can check a result but cannot make one.

const HEX64 = /^[a-f0-9]{64}$/;
const RUN = /^[A-Za-z0-9-]{1,100}$/;
const SIGNATURE_BYTES = 256 * 2 * 32;
const RESULT_LIMIT = 32768;

export type RunKey = { run: string; binding: string; key: string };
export type SignedResult = {
  run: string;
  binding: string;
  resultHash: string;
  result: string;
  signature: string;
};

// Everything the Broker later re-checks for the job. A result signed for one job cannot be replayed for another.
export function runBinding(j: Job): string {
  return hash(
    JSON.stringify([
      "kurashi-ledger:dispatch-job:v1",
      j.id,
      j.key,
      j.kind,
      j.actor,
      j.generation,
      j.policy,
      j.pair.head,
      j.pair.base,
      j.run,
    ]),
  );
}

function strictLine(line: string, limit: number): Record<string, unknown> {
  if (typeof line !== "string" || Buffer.byteLength(line) > limit)
    throw new Error("Invalid supervisor line");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Invalid supervisor line");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid supervisor line");
  return value as Record<string, unknown>;
}

// The first line of the supervisor's stdout. Only the launcher that spawned the supervisor reads this pipe.
export function parseRunKeyLine(line: string): RunKey {
  const v = strictLine(line, 1024);
  if (
    Object.keys(v).sort().join() !== "binding,key,run,schema,type" ||
    v["schema"] !== 1 ||
    v["type"] !== "run-key" ||
    typeof v["run"] !== "string" ||
    !RUN.test(v["run"]) ||
    typeof v["binding"] !== "string" ||
    !HEX64.test(v["binding"]) ||
    typeof v["key"] !== "string" ||
    !HEX64.test(v["key"])
  )
    throw new Error("Invalid run key");
  return { run: v["run"], binding: v["binding"], key: v["key"] };
}

// The last line of the supervisor's stdout, or the durable run-<id>-result.json it wrote.
export function parseSignedResult(text: string): SignedResult {
  const v = strictLine(text, 8 * RESULT_LIMIT + 2 * SIGNATURE_BYTES + 4096);
  if (
    Object.keys(v).sort().join() !==
      "binding,result,resultHash,run,schema,signature,type" ||
    v["schema"] !== 1 ||
    v["type"] !== "run-result" ||
    typeof v["run"] !== "string" ||
    !RUN.test(v["run"]) ||
    typeof v["binding"] !== "string" ||
    !HEX64.test(v["binding"]) ||
    typeof v["resultHash"] !== "string" ||
    !HEX64.test(v["resultHash"]) ||
    typeof v["result"] !== "string" ||
    !v["result"] ||
    Buffer.byteLength(v["result"]) > RESULT_LIMIT ||
    hash(v["result"]) !== v["resultHash"] ||
    typeof v["signature"] !== "string" ||
    !new RegExp(`^[a-f0-9]{${SIGNATURE_BYTES * 2}}$`).test(v["signature"])
  )
    throw new Error("Invalid signed result");
  return {
    run: v["run"],
    binding: v["binding"],
    resultHash: v["resultHash"],
    result: v["result"],
    signature: v["signature"],
  };
}

export function signedMessage(
  run: string,
  binding: string,
  resultHash: string,
): Buffer {
  if (!RUN.test(run) || !HEX64.test(binding) || !HEX64.test(resultHash))
    throw new Error("Invalid signing input");
  return Buffer.from(
    `kurashi-ledger:dispatch-result:v1\n${run}\n${binding}\n${resultHash}\n`,
    "ascii",
  );
}

const sha256 = (...parts: Buffer[]): Buffer => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};

// One-time hash-based signature check (Lamport over SHA-256). The signature reveals one preimage per digest bit
// and carries the other public half; recomputing all public halves must reproduce the announced commitment.
export function verifyOneTime(
  key: string,
  message: Buffer,
  signature: string,
): boolean {
  if (
    !HEX64.test(key) ||
    signature.length !== SIGNATURE_BYTES * 2 ||
    !/^[a-f0-9]+$/.test(signature)
  )
    return false;
  const sig = Buffer.from(signature, "hex"),
    digest = sha256(
      Buffer.from(`kurashi-ledger:lamport-digest:v1\n${key}\n`, "ascii"),
      message,
    ),
    publicKey = createHash("sha256").update(
      "kurashi-ledger:lamport-public:v1\n",
      "ascii",
    );
  for (let i = 0; i < 256; i++) {
    const bit = (digest[i >> 3]! >> (7 - (i & 7))) & 1,
      revealed = sha256(sig.subarray(64 * i, 64 * i + 32)),
      other = sig.subarray(64 * i + 32, 64 * i + 64);
    publicKey.update(bit === 0 ? revealed : other);
    publicKey.update(bit === 0 ? other : revealed);
  }
  return timingSafeEqual(publicKey.digest(), Buffer.from(key, "hex"));
}

export type ResultVerifier = {
  verify(j: Job, raw: string, origin: Provenance): boolean;
};

// Holds only public commitments that the trusted launcher read from the supervisor's own stdout before the
// worker started. Never accept a key from the manifest or any file inside the supervisor root: a worker can
// write there. Persisting these records in the dispatcher DB is part of the active integration (W4); until then
// a restarted dispatcher has no record and every pending run stays unverified (fail closed).
export class RunVerifier implements ResultVerifier {
  readonly #keys = new Map<string, RunKey>();
  readonly #used = new Set<string>();
  register(j: Job, record: RunKey): void {
    if (
      !RUN.test(record.run) ||
      !HEX64.test(record.binding) ||
      !HEX64.test(record.key) ||
      record.run !== j.run ||
      record.binding !== runBinding(j) ||
      this.#keys.has(record.run) ||
      this.#used.has(record.key)
    )
      throw new Error("Run key rejected");
    this.#keys.set(record.run, { ...record });
    this.#used.add(record.key);
  }
  verify(j: Job, raw: string, origin: Provenance): boolean {
    const record = this.#keys.get(j.run);
    if (
      !record ||
      typeof raw !== "string" ||
      origin.run !== j.run ||
      origin.actor !== j.actor ||
      origin.resultHash !== hash(raw) ||
      record.binding !== runBinding(j) ||
      typeof origin.signature !== "string"
    )
      return false;
    return verifyOneTime(
      record.key,
      signedMessage(j.run, record.binding, origin.resultHash),
      origin.signature,
    );
  }
}

// Turns a parsed supervisor envelope into the Broker input. The Broker verifies it again before posting.
export function provenanceOf(
  j: Job,
  signed: SignedResult,
): { raw: string; origin: Provenance } {
  if (signed.run !== j.run || signed.binding !== runBinding(j))
    throw new Error("Signed result belongs to another job");
  return {
    raw: signed.result,
    origin: {
      run: signed.run,
      actor: j.actor,
      resultHash: signed.resultHash,
      signature: signed.signature,
    },
  };
}
