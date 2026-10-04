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
import type { ResultVerifier } from "./provenance.ts";
import { textFindings } from "../public-policy.ts";

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
// Publication check on the exact body the Broker would post to the public repo (PR51 red team, P1): a prompt
// injection could make a reviewer read a secret and echo it. Same rules as scripts/check-public.ts
// (public-policy textFindings), plus anything shaped like a key/token and any local absolute path.
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9._-]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|credential)s?\b\s*[:=]\s*\S{6,}/i,
  /\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)[-_][A-Za-z0-9_-]{8,}/,
];
const LOCAL_PATHS: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9_.~:/-])~\/[^\s]/,
  /(?:^|[^A-Za-z0-9_.~:/-])\/(?:Users|home|private|var|tmp|etc|opt|Volumes|root|usr|Library|System|Applications|mnt|srv|proc|dev|run|nix)(?:\/|\b)/,
  /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/,
  /\\\\[A-Za-z0-9._-]+\\/, // UNC
  /\bfile:\/\//i,
];
export function publicationFindings(body: string): string[] {
  const findings = new Set(textFindings(body));
  if (TOKEN_SHAPES.some((re) => re.test(body))) findings.add("key/token");
  // Long opaque runs (keys, tokens, encoded secrets). Commit SHAs and run UUIDs are the only allowed long IDs.
  for (const run of body.match(/[A-Za-z0-9+=_-]{32,}/g) ?? [])
    if (
      /[0-9]/.test(run) &&
      /[A-Za-z]/.test(run) &&
      !/^[a-f0-9]{40}$/.test(run) &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(run)
    )
      findings.add("opaque key-like string");
  if (LOCAL_PATHS.some((re) => re.test(body)))
    findings.add("local absolute path");
  return [...findings];
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
// Fixture integrity helper for fake runners only. It can seal, so it is never the verifier of a real run.
// Real runs are signed by the supervisor and checked with provenance.ts RunVerifier (verify-only, PR48-R003).
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
export class ReviewBroker {
  // Verify-only: the Broker checks the run's provenance and never seals or signs a result itself.
  readonly verifier: ResultVerifier;
  readonly actor: number;
  readonly transport: BrokerTransport;
  readonly store: Store;
  // Identity fixed by the owner installation, never selectable from worker input.
  constructor(
    actor: number,
    transport: BrokerTransport,
    store: Store,
    verifier: ResultVerifier,
  ) {
    this.actor = actor;
    this.transport = transport;
    this.store = store;
    this.verifier = verifier;
  }
  async submit(
    p: Policy,
    j: Job,
    raw: string,
    origin: Provenance | null,
    fetchFresh: () => Promise<Snapshot>,
  ): Promise<"posted" | "uncertain" | "stale" | "blocked"> {
    if (
      !origin ||
      !this.verifier.verify(j, raw, origin) ||
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
      body = render(result, marker, identityOf(p, this.actor), j.run),
      digest = hash(body);
    if (publicationFindings(body).length) {
      // Never posted and no Outbox row: the owner must look at the run. Recorded once as an owner notice;
      // the caller keeps the lease (uncertain) so nothing relaunches or retries automatically.
      this.store.notice(`${j.key}:publication-blocked:${j.run}`);
      return "blocked";
    }
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
      const matches = reviews.filter(
        (r) =>
          r.actor === this.actor &&
          r.head === j.pair.head &&
          r.body.includes(marker) &&
          hash(r.body) === digest,
      );
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
