// Test-only one-time signer (the same scheme as tools/review_dispatch/supervisor.py). It lets the TypeScript
// tests stand in for the supervisor process without Python. It must never be imported by product code: real
// runs are signed only by the supervisor, and the dispatcher and the Broker only verify (PR48-R003).
import { createHash, createHmac, randomBytes } from "node:crypto";

const secret = (seed: Buffer, index: number, bit: number): Buffer =>
  createHmac("sha256", seed)
    .update(
      Buffer.concat([
        Buffer.from("kurashi-ledger:lamport-key:v1", "ascii"),
        Buffer.from([index >> 8, index & 0xff, bit]),
      ]),
    )
    .digest();
const sha = (b: Buffer): Buffer => createHash("sha256").update(b).digest();

export class TestSigner {
  readonly seed: Buffer;
  constructor(seed: Buffer = randomBytes(32)) {
    this.seed = Buffer.from(seed);
  }
  publicKey(): string {
    const h = createHash("sha256").update("kurashi-ledger:lamport-public:v1\n", "ascii");
    for (let i = 0; i < 256; i++) for (const bit of [0, 1]) h.update(sha(secret(this.seed, i, bit)));
    return h.digest("hex");
  }
  sign(message: Buffer): string {
    const key = this.publicKey();
    const digest = createHash("sha256")
      .update(Buffer.from(`kurashi-ledger:lamport-digest:v1\n${key}\n`, "ascii"))
      .update(message)
      .digest();
    const parts: Buffer[] = [];
    for (let i = 0; i < 256; i++) {
      const bit = (digest[i >> 3]! >> (7 - (i & 7))) & 1;
      parts.push(secret(this.seed, i, bit), sha(secret(this.seed, i, 1 - bit)));
    }
    return Buffer.concat(parts).toString("hex");
  }
}
