import { createHmac, timingSafeEqual } from "node:crypto";
import {
  hash,
  samePair,
  type Job,
  type Policy,
  type Snapshot,
  type WorkerResult,
} from "./model.ts";
import { assess, reviewerEligible } from "./reducer.ts";
import { Store } from "./store.ts";
import { canonicalBody } from "./github.ts";

export function parseResult(raw: string, j: Job): WorkerResult {
  if (Buffer.byteLength(raw) > 32768)
    throw new Error("Worker result too large");
  let r: WorkerResult;
  try {
    r = JSON.parse(raw) as WorkerResult;
  } catch {
    throw new Error("Invalid worker result");
  }
  const singleLine = (v: string): boolean =>
    !/[\r\n\u0000-\u001f\u007f]/.test(v);
  const safeProse = (v: string): boolean =>
    !/[<@]/.test(v) &&
    !/(?:^|\n)\s*(?:role|agent_id|head_sha|base_sha|decision|worker_status|plan_path|plan_commit)\s*:/i.test(
      v,
    );
  const fields = [
    "schema",
    "run",
    "actor",
    "generation",
    "pair",
    "decision",
    "summary",
    "findings",
    "evidence",
    "unverified",
  ];
  if (
    !r ||
    Object.keys(r).sort().join() !== fields.sort().join() ||
    r.schema !== 1 ||
    r.run !== j.run ||
    r.actor !== j.actor ||
    r.generation !== j.generation ||
    !r.pair ||
    !samePair(r.pair, j.pair) ||
    !["accepted", "changes-requested", "needs-owner"].includes(r.decision) ||
    typeof r.summary !== "string" ||
    !r.summary.trim() ||
    r.summary.length > 1200 ||
    !Array.isArray(r.findings) ||
    r.findings.length > 30 ||
    !Array.isArray(r.evidence) ||
    !Array.isArray(r.unverified) ||
    r.evidence.length > 30 ||
    r.unverified.length > 30
  )
    throw new Error("Invalid worker result");
  for (const f of r.findings)
    if (
      !f ||
      Object.keys(f).sort().join() !== "completion,id,impact,location" ||
      !new RegExp(`^PR${j.key.split(":")[1]}-[A-Z][0-9]{3}$`).test(f.id) ||
      [f.location, f.impact, f.completion].some(
        (v) =>
          typeof v !== "string" ||
          !v.trim() ||
          v.length > 1200 ||
          !singleLine(v) ||
          !safeProse(v),
      )
    )
      throw new Error("Invalid finding");
  if (
    new Set(r.findings.map((f) => f.id)).size !== r.findings.length ||
    (r.decision === "accepted" && r.findings.length)
  )
    throw new Error("Contradictory result");
  if (
    r.evidence.some(
      (x) =>
        typeof x !== "string" ||
        !/^https:\/\/github\.com\/[a-zA-Z0-9/_?.=#&%-]+$/.test(x),
    ) ||
    r.unverified.some(
      (x) =>
        typeof x !== "string" ||
        !x.trim() ||
        x.length > 1200 ||
        !singleLine(x) ||
        !safeProse(x),
    )
  )
    throw new Error("Invalid evidence");
  if (
    /gh[pousr]_[A-Za-z0-9_]{16,}|-----BEGIN .*PRIVATE KEY|(?:\/Users\/|[A-Z]:\\Users\\)/.test(
      raw,
    )
  )
    throw new Error("Private material in result");
  if (
    !safeProse(r.summary) ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.summary)
  )
    throw new Error("Unsafe result prose");
  return r;
}
export type PostedReview = {
  id: string;
  actor: number;
  head: string;
  body: string;
};
export type BrokerTransport = {
  post(
    pr: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    head: string,
    body: string,
  ): Promise<void>;
  list(pr: number): Promise<PostedReview[]>;
};
export type Provenance = {
  run: string;
  actor: number;
  resultHash: string;
  signature: string;
};
// Fixture integrity helper, not an implemented real-run origin/key-isolation boundary.
// A real runner must receive an outside-worker authenticated endpoint and verifier-only Broker first.
export class RunChannel {
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
export class ReviewBroker {
  readonly channel: RunChannel;
  readonly actor: number;
  readonly transport: BrokerTransport;
  readonly store: Store;
  // Identity fixed by the owner installation, never selectable from worker input.
  constructor(
    actor: number,
    transport: BrokerTransport,
    store: Store,
    channel: RunChannel,
  ) {
    this.actor = actor;
    this.transport = transport;
    this.store = store;
    this.channel = channel;
  }
  async submit(
    p: Policy,
    j: Job,
    raw: string,
    origin: Provenance,
    fetchFresh: () => Promise<Snapshot>,
  ): Promise<"posted" | "uncertain" | "stale"> {
    if (
      !this.channel.verify(j, raw, origin) ||
      origin.actor !== this.actor ||
      this.actor !== j.actor ||
      origin.run !== j.run ||
      origin.resultHash !== hash(raw)
    )
      throw new Error("Untrusted run provenance");
    const result = parseResult(raw, j),
      s = await fetchFresh(),
      prior = this.store.target(j.key);
    const t = assess(p, s, prior, this.store.consumed());
    const owned = this.store.job(j.id);
    if (owned && owned.resultHash !== hash(raw))
      throw new Error("Stored result hash changed");
    if (
      !owned ||
      owned.job.run !== j.run ||
      owned.job.actor !== j.actor ||
      owned.job.generation !== j.generation ||
      owned.job.policy !== j.policy ||
      !samePair(owned.job.pair, j.pair) ||
      owned.cancel ||
      owned.status !== "result-ready" ||
      t.status !== "eligible" ||
      t.generation !== j.generation ||
      t.policy !== j.policy ||
      !samePair(s.pair, j.pair) ||
      !reviewerEligible(p, s, this.actor)
    )
      return "stale";
    const marker = `kurashi-ledger:dispatch-run:v1:${j.run}`,
      body = canonicalBody(
        render(result, marker, identityOf(p, this.actor), j.run),
      ),
      digest = hash(body);
    if (
      result.decision === "accepted" &&
      (!s.faultfinding ||
        !samePair(s.faultfinding.pair, j.pair) ||
        !reviewerEligible(p, s, s.faultfinding.actor) ||
        s.faultfinding.unresolved.length)
    )
      return "stale";
    const id = this.store.outbox(
      j,
      "review",
      JSON.stringify({
        run: j.run,
        actor: j.actor,
        pair: j.pair,
        generation: j.generation,
        resultHash: hash(raw),
        bodyHash: digest,
        marker,
        body,
        decision: result.decision,
      }),
    );
    const recover = async (): Promise<"posted" | "uncertain"> => {
      let reviews: PostedReview[];
      try {
        reviews = await this.transport.list(s.pr);
      } catch {
        return "uncertain";
      }
      const marked = reviews.filter(
          (r) =>
            r.actor === this.actor &&
            r.head === j.pair.head &&
            r.body.includes(marker),
        ),
        matches = marked.filter((r) => hash(r.body) === digest);
      // PR48-R011: a review with our marker but another body hash (GitHub normalization, edit or a
      // second post) is never counted as posted and never followed by another POST.
      if (marked.length > matches.length) return "uncertain";
      if (matches.length > 1)
        throw new Error(
          "Duplicate remote reviews; owner reconciliation required",
        );
      if (matches.length !== 1) return "uncertain";
      this.store.posted(id, matches[0]!.id);
      return "posted";
    };
    if (this.store.outboxState(id) !== "prepared") return recover();
    if (p.mode !== "active") return "stale"; // shadow/off never writes
    this.store.sending(id); // Commit uncertainty before crossing network boundary; no retry.
    try {
      await this.transport.post(
        s.pr,
        result.decision === "accepted"
          ? "APPROVE"
          : result.decision === "changes-requested"
            ? "REQUEST_CHANGES"
            : "COMMENT",
        j.pair.head,
        body,
      );
    } catch {
      return recover();
    }
    return recover();
  }
}
export type BrokerIdentity = {
  role: "codex-reviewer" | "claude-reviewer";
  agent: "codex" | "claude";
};
function identityOf(p: Policy, actor: number): BrokerIdentity {
  const configured = p.actors.find((a) => a.id === actor);
  if (
    configured?.kind !== "ai" ||
    !["codex", "claude"].includes(configured.executor)
  )
    throw new Error("Fixed AI identity unavailable");
  const agent = configured.executor as "codex" | "claude";
  return { role: `${agent}-reviewer`, agent };
}
// Called only after strict parseResult. Worker prose is quoted; metadata is trusted installation/run data.
export function render(
  r: WorkerResult,
  marker: string,
  identity: BrokerIdentity,
  run: string,
): string {
  return (
    `<!-- kurashi-ledger:review:v1 -->\n<!-- ${marker} -->\nrole: ${identity.role}\nagent_id: ${identity.agent}/${run}\nhead_sha: ${r.pair.head}\nbase_sha: ${r.pair.base}\ndecision: ${r.decision}\n\n${r.summary
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n")}\n` +
    r.findings
      .map(
        (f) =>
          `\n- ${f.id} — ${f.location}: ${f.impact} 完了条件: ${f.completion}`,
      )
      .join("") +
    (r.evidence.length ? `\n\n検証: ${r.evidence.join(" ")}\n` : "") +
    (r.unverified.length ? `\n未検証: ${r.unverified.join(" / ")}\n` : "")
  );
}
