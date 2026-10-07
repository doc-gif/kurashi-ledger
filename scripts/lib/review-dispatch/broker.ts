import {
  hash,
  samePair,
  type Job,
  type Policy,
  type Snapshot,
  type WorkerResult,
} from "./model.ts";
import { approvalBlockers, assess, reviewerEligible } from "./reducer.ts";
import { Store } from "./store.ts";
import { canonicalBody } from "./github.ts";
import type { ResultVerifier } from "./provenance.ts";
import {
  CAUSE_KEY,
  FINDING_FIELDS,
  FINDING_PROSE,
  RECORD_ID,
  RESULT_LIMITS as L,
  RT_ID,
  SEVERITIES,
} from "./launcher.ts";
import {
  EVIDENCE_SHAPE,
  blockedNotice,
  redactedResult,
  resultFindings,
  allowedFor,
  allowedLink,
  linkTargetsAllowed,
  publicationFindings,
} from "./publication.ts";

// Rejected because of WHAT the result says (secret shapes, format characters, look-alikes, injection, links),
// as opposed to a malformed shape. The dispatcher treats it as `blocked` and redacts it (PR #53 round 3).
export class ResultContentError extends Error {}

// `records`: the whole-record IDs (record-<comment|review>-<id>) of this job's materials (store.runMaterials).
// A red team may re-check such a record as a whole; any other record ID is refused (red team round 5).
export function parseResult(raw: string, j: Job, records: readonly string[] = []): WorkerResult {
  if (Buffer.byteLength(raw) > L.bytes)
    throw new Error("Worker result too large");
  let r: WorkerResult;
  try {
    r = JSON.parse(raw) as WorkerResult;
  } catch {
    throw new Error("Invalid worker result");
  }
  // Content first, so a secret is classified as content even when the shape is also wrong.
  // Format characters (zero-width etc.) are rejected anywhere in the decoded result, never stripped.
  if (/\p{Cf}/u.test(JSON.stringify(r) ?? ""))
    throw new ResultContentError("Unsafe result prose");
  if (
    [raw, (JSON.stringify(r) ?? "").normalize("NFKC")].some((t) =>
      /gh[pousr]_[A-Za-z0-9_]{16,}|-----BEGIN .*PRIVATE KEY|(?:\/Users\/|[A-Z]:\\Users\\)/.test(
        t,
      ),
    )
  )
    throw new ResultContentError("Private material in result");
  const singleLine = (v: string): boolean =>
    !/[\r\n\u0000-\u001f\u007f]/.test(v);
  // Checked after NFKC so full-width look-alikes cannot slip past. Only GitHub links in prose.
  const safeProse = (raw: string): boolean => {
    const v = raw.normalize("NFKC");
    return (
      !/[<@]/.test(v) &&
      !/(?:^|\n)\s*(?:role|agent_id|head_sha|base_sha|decision|worker_status|plan_path|plan_commit)\s*:/i.test(
        v,
      ) &&
      (v.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()"'`]*/gi) ?? []).every(allowedLink) &&
      linkTargetsAllowed(v) &&
      !/\bwww\./i.test(v.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()"'`]*/gi, " "))
    );
  };
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
    "causes",
    "previous",
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
    r.summary.length > L.text ||
    !Array.isArray(r.findings) ||
    r.findings.length > L.findings ||
    !Array.isArray(r.evidence) ||
    !Array.isArray(r.unverified) ||
    r.evidence.length > L.evidence ||
    r.unverified.length > L.unverified ||
    !Array.isArray(r.causes) ||
    !Array.isArray(r.previous) ||
    r.causes.length > L.causes ||
    r.previous.length > L.previous ||
    // A review has no red-team table; a red-team record has no review IDs (PR #56 red team P2/P3).
    (j.kind !== "faultfinding" && (r.causes.length || r.previous.length))
  )
    throw new Error("Invalid worker result");
  // A table cell: one line, no column separator.
  const cell = (v: unknown): boolean =>
    typeof v === "string" && !!v.trim() && v.length <= L.cell && singleLine(v) && !v.includes("|");
  for (const c of r.causes)
    if (
      !c ||
      Object.keys(c).sort().join() !== "cause,judgement,where" ||
      typeof c.cause !== "string" ||
      !CAUSE_KEY.test(c.cause) ||
      !["該当", "該当なし", "確認できない"].includes(c.judgement) ||
      !cell(c.where)
    )
      throw new Error("Invalid cause judgement");
  for (const v of r.previous)
    if (
      !v ||
      Object.keys(v).sort().join() !== "id,reason,status" ||
      typeof v.id !== "string" ||
      !(RT_ID.test(v.id) || (RECORD_ID.test(v.id) && records.includes(v.id))) ||
      !["解消", "対応不要", "未解消"].includes(v.status) ||
      !cell(v.reason)
    )
      throw new Error("Invalid earlier RT");
  if (
    new Set(r.causes.map((c) => c.cause)).size !== r.causes.length ||
    new Set(r.previous.map((v) => v.id)).size !== r.previous.length ||
    (r.decision === "accepted" && r.previous.some((v) => v.status === "未解消"))
  )
    throw new Error("Contradictory result");
  if (
    [...r.causes.map((c) => c.where), ...r.previous.map((v) => v.reason)].some((v) => !safeProse(v))
  )
    throw new ResultContentError("Unsafe table prose");
  // One line, not blank, at most `max` UTF-16 units.
  const line = (v: unknown, max: number): boolean =>
    typeof v === "string" && !!v.trim() && v.length <= max && singleLine(v);
  const fieldKeys = [...FINDING_FIELDS].sort().join();
  for (const f of r.findings)
    if (
      !f ||
      Object.keys(f).sort().join() !== fieldKeys ||
      // A review uses PR<N>-R<3 digits> only; a red-team record uses the PR-local RT-<number> of the
      // canonical format (pr-review-loop.md#提出前の粗探し), which findings.ts never reads as an R ID.
      !(j.kind === "faultfinding"
        ? RT_ID
        : new RegExp(`^PR${j.key.split(":")[1]}-R[0-9]{3}$`)
      ).test(f.id) ||
      !(SEVERITIES as readonly string[]).includes(f.severity) ||
      !line(f.title, L.title) ||
      !line(f.timing, L.timing) ||
      FINDING_PROSE.some((k) => !line(f[k], L.text))
    )
      throw new Error("Invalid finding");
  if (
    r.findings.some((f) =>
      [f.title, f.timing, ...FINDING_PROSE.map((k) => f[k])].some((v) => !safeProse(v)),
    )
  )
    throw new ResultContentError("Unsafe finding prose");
  if (
    new Set(r.findings.map((f) => f.id)).size !== r.findings.length ||
    (r.decision === "accepted" && r.findings.length)
  )
    throw new Error("Contradictory result");
  if (
    r.evidence.some((x) => typeof x !== "string") ||
    r.unverified.some(
      (x) =>
        typeof x !== "string" ||
        !x.trim() ||
        x.length > L.text ||
        !singleLine(x),
    ) ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.summary)
  )
    throw new Error("Invalid evidence");
  // Fixed evidence shapes only (a workflow run, a review on a PR, a commit checked against the PR later).
  if (r.evidence.some((x) => !EVIDENCE_SHAPE.test(x)))
    throw new ResultContentError("Evidence link not allowed");
  if (!safeProse(r.summary) || r.unverified.some((x) => !safeProse(x)))
    throw new ResultContentError("Unsafe result prose");
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
  ): Promise<"posted" | "uncertain" | "stale" | "blocked" | "deferred"> {
    if (
      !origin ||
      !this.verifier.verify(j, raw, origin) ||
      origin.actor !== this.actor ||
      this.actor !== j.actor ||
      origin.run !== j.run ||
      origin.resultHash !== hash(raw)
    )
      throw new Error("Untrusted run provenance");
    const result = parseResult(raw, j, recordIds(this.store.runMaterials(j.run)));
    // W4 row 8 / PR #56 red team P2: an edit/delete/dismiss delivery for this PR that no reconcile has processed
    // yet. Keep the result and reconcile again (fetchFresh reconciles and clears processed marks); if a mark is
    // still there after three tries, defer: the job keeps its result and lease and the next cycle posts it.
    let s = await fetchFresh();
    for (let n = 0; n < 2 && this.store.marked(j.key); n++) s = await fetchFresh();
    if (this.store.marked(j.key)) return "deferred";
    const prior = this.store.target(j.key);
    const t = assess(p, s, prior, this.store.consumed());
    const owned = this.store.job(j.id);
    // Already blocked and redacted (hash-only): stays blocked; never posted, never re-checked into a POST.
    if (owned && owned.resultHash === hash(redactedResult(raw))) return "blocked";
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
      !reviewerEligible(p, s, this.actor) ||
      (j.kind !== "review" && j.kind !== "faultfinding")
    )
      return "stale";
    // Fixed order: canonicalBody -> publication check -> hash -> POST. The check reads the exact canonical body
    // that is hashed and posted, because canonicalisation can join a split key shape (PR #52 R011 / W2).
    // A faultfinding job posts the red-team record (pr-review-loop.md#提出前の粗探し) as a COMMENT.
    // PR #56 red team P2: an APPROVE only when nothing else blocks (the accepted() rule: anyone else's latest
    // change request, anyone else's unresolved finding). Otherwise a COMMENT that names the blockers.
    const blockers =
      j.kind === "review" && result.decision === "accepted" ? approvalBlockers(p, s, this.actor) : [];
    const meta = this.store.runMaterials(j.run);
    const unresolved = j.kind === "faultfinding" ? redTeamOpen(result, meta) : [];
    const marker = `kurashi-ledger:dispatch-run:v1:${j.run}`,
      identity = identityOf(p, this.actor),
      body = canonicalBody(
        j.kind === "faultfinding"
          ? renderRedTeam(result, marker, identity, j.run, implementerOf(p, s.pr), meta, unresolved)
          : render(result, marker, identity, j.run, blockers),
      );
    if (
      resultFindings(result, j, s, p.repo).length ||
      publicationFindings(body, allowedFor(j, s)).length
    ) {
      // The plaintext result must not stay in the DB either (30-day retention, backups, WAL).
      this.store.redactResult(j, raw, redactedResult(raw));
      // blocked = persistent needs-owner: never posted, no Outbox row, one owner notice; the caller keeps the
      // lease so nothing relaunches until the owner clears it (publication.ts blockedNotice).
      this.store.notice(blockedNotice(j));
      return "blocked";
    }
    const digest = hash(body);
    if (
      j.kind === "review" &&
      result.decision === "accepted" &&
      (!s.faultfinding ||
        !samePair(s.faultfinding.pair, j.pair) ||
        !reviewerEligible(p, s, s.faultfinding.actor) ||
        s.faultfinding.unresolved.length)
    )
      return "stale";
    const id = this.store.outbox(
      j,
      j.kind,
      JSON.stringify({
        run: j.run,
        actor: j.actor,
        pair: j.pair,
        generation: j.generation,
        resultHash: hash(raw),
        bodyHash: digest,
        marker,
        body,
        decision: blockers.length ? "needs-owner" : result.decision,
        // IDs only (no prose): store.faultfinding() reads them as the unresolved RTs.
        findings: j.kind === "faultfinding" ? unresolved : result.findings.map((f) => f.id),
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
        j.kind === "faultfinding" || blockers.length
          ? "COMMENT" // A red-team record, or an approval that something else blocks.
          : result.decision === "accepted"
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
function implementerOf(p: Policy, pr: number): number {
  const t = p.targets.find((x) => x.pr === pr);
  if (!t) throw new Error("Target outside policy");
  return t.implementer;
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
// Called only after strict parseResult. Worker prose is quoted or follows a fixed label; metadata is trusted
// installation/run data.
export function render(
  r: WorkerResult,
  marker: string,
  identity: BrokerIdentity,
  run: string,
  blockers: readonly string[] = [],
): string {
  const decision = blockers.length ? "needs-owner" : r.decision;
  const held = blockers.length
    ? `受付の確認: ほかの変更要求・未解消の指摘があるため、APPROVEにせずCOMMENTにした（${blockers.join(", ")}）。\n\n`
    : "";
  return (
    `<!-- kurashi-ledger:review:v1 -->\n<!-- ${marker} -->\nrole: ${identity.role}\nagent_id: ${identity.agent}/${run}\nhead_sha: ${r.pair.head}\nbase_sha: ${r.pair.base}\ndecision: ${decision}\n\n${held}${quote(r.summary)}\n` +
    r.findings.map(findingBlock).join("") +
    checkedLines(r)
  );
}
const quote = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
// One finding in the structured format (pr-review-loop.md#指摘の書式). The heading holds the checked ID and the
// one-line title; every other worker field follows a fixed label, so none of it starts a line (findingIds and the
// record fields read line starts only).
function findingBlock(f: WorkerResult["findings"][number]): string {
  return (
    `\n### ${f.id} ${f.title}\n- 重さ: ${f.severity} ／ 時期: ${f.timing}\n- 場所: ${f.location}\n` +
    `- 問題: ${f.problem}\n- 例: ${f.example}\n- やってほしいこと: ${f.action}\n- 完了条件: ${f.completion}\n`
  );
}
// 検証 and 未検証: one line per item, at most RESULT_LIMITS.evidence / .unverified (3) each.
function checkedLines(r: WorkerResult): string {
  const lines = [...r.evidence.map((x) => `検証: ${x}`), ...r.unverified.map((x) => `未検証: ${x}`)];
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

export const recordIds = (meta: { previousRts?: string[] } | null): string[] =>
  (meta?.previousRts ?? []).filter((id) => id.startsWith("record-"));
// What stays open after a red-team record: its RTs, earlier RTs it found still open, ledger causes without a
// judgement (the scope is every cause_key; pr-review-loop.md#提出前の粗探し), and a needs-owner decision.
// `previousRts`: RT IDs of the earlier red-team records that registered participants posted on this PR (the
// dispatcher's own record of the materials; an unregistered third party's record is never evidence).
export type RunMaterials = {
  planPath: string | null;
  ledger: string[];
  previousRts: string[];
  guard?: "ok" | "refused" | "unavailable" | "none";
};
// Codex PR56-R004: clear only when every required ledger cause was judged and none of them is 確認できない,
// and every earlier RT was re-checked (解消 or 対応不要); an omitted re-check is not clear.
export function redTeamOpen(r: WorkerResult, meta: RunMaterials | null): string[] {
  const judged = new Map(r.causes.map((c) => [c.cause, c.judgement]));
  const rechecked = new Set(r.previous.map((v) => v.id));
  const ledger = meta?.ledger ?? [];
  return [
    ...r.findings.map((f) => f.id),
    ...r.previous.filter((v) => v.status === "未解消").map((v) => v.id),
    ...(meta === null || ledger.some((c) => !judged.has(c)) ? ["ledger-incomplete"] : []),
    ...ledger.filter((c) => judged.get(c) === "確認できない").map((c) => `unconfirmed:${c}`),
    ...(meta?.previousRts ?? []).filter((id) => !rechecked.has(id)).map((id) => `unchecked:${id}`),
    // A plan whose trusted guard check is missing or failed (RT-4): the red team had no guard output to start from.
    ...(meta !== null && meta.guard === "refused" ? ["guard-refused"] : []),
    ...(meta !== null && (meta.guard === "unavailable" || (meta.planPath !== null && meta.guard !== "ok" && meta.guard !== "refused"))
      ? ["guard-unavailable"]
      : []),
    ...(r.decision === "needs-owner" ? ["needs-owner"] : []),
  ];
}
// Red-team record in the canonical format (pr-review-loop.md#提出前の粗探し) for a faultfinding job. No `role:` or
// `decision:` line, so it is never read as a review record. The plan path and the ledger size are the dispatcher's
// own record of the materials (store.runMaterials). The post lists only the causes judged 該当 or 確認できない and
// a count; the whole judgement stays in the stored result (jobs.result), and redTeamOpen reads it from there.
// Earlier RTs: the resolved IDs on one line, details only for the unresolved ones.
export function renderRedTeam(
  r: WorkerResult,
  marker: string,
  identity: BrokerIdentity,
  run: string,
  implementer: number,
  meta: RunMaterials | null = null,
  open: readonly string[] = [],
): string {
  const judged = new Set(r.causes.map((c) => c.cause));
  const missing = (meta?.ledger ?? []).filter((c) => !judged.has(c));
  const verdict = open.length ? `未解消あり（${open.join(", ")}）` : "未解消のRTなし";
  const ids = (j: string) => r.causes.filter((c) => c.judgement === j).map((c) => c.cause);
  const hit = ids("該当"),
    unsure = ids("確認できない");
  const tally = `該当${hit.length}・確認できない${unsure.length}`;
  const ledger = !meta
    ? `原因台帳: 資料の記録がない（${r.causes.length}件を判定、${tally}）`
    : missing.length
      ? `原因台帳: ${meta.ledger.length}件のうち${meta.ledger.length - missing.length}件を判定（${tally}）`
      : `原因台帳: ${meta.ledger.length}件を判定（${tally}）`;
  const prev = (st: string) => r.previous.filter((v) => v.status === st).map((v) => v.id);
  const resolved = (["解消", "対応不要"] as const)
    .filter((st) => prev(st).length)
    .map((st) => `${st} ${prev(st).join(", ")}`);
  return (
    `<!-- kurashi-ledger:red-team:v1 -->\n<!-- ${marker} -->\nauditor_id: ${identity.agent}/${run}\nimplementer_id: github-actor/${implementer}\nhead_sha: ${r.pair.head}\nbase_sha: ${r.pair.base}\nplan_path: ${meta?.planPath ?? "なし（このPRに計画の変更がない）"}\n\n結論: ${verdict}\n${quote(r.summary)}\n` +
    `\n${ledger}\n` +
    (hit.length ? `- 該当: ${hit.join(", ")}\n` : "") +
    (unsure.length ? `- 確認できない: ${unsure.join(", ")}\n` : "") +
    (r.previous.length
      ? `\n前のRT: ${resolved.join(" ／ ") || "解消なし"}\n` +
        r.previous
          .filter((v) => v.status === "未解消")
          .map((v) => `- ${v.id} 未解消: ${v.reason}\n`)
          .join("")
      : "") +
    r.findings.map(findingBlock).join("") +
    checkedLines(r)
  );
}
// The machine-read lines of the format above, for a record written by hand (evidence.ts manualFaultfinding):
// `- 該当: <IDs>` and `- 確認できない: <IDs>` are open causes, `前のRT: 解消 <IDs> ／ 対応不要 <IDs>` resolves.
// Lines are read after NFKC (so "：" and "／" are ":" and "/") and trimmed. An ID of another shape is
// `cause:unparsed`, so a malformed line never clears anything.
export function redTeamLines(lines: readonly string[]): { open: string[]; resolved: string[] } {
  const open: string[] = [],
    resolved: string[] = [];
  for (const row of lines) {
    const cause = /^(?:[-*]\s*)?(?:該当|確認できない)\s*:\s*(.*)$/.exec(row);
    if (cause)
      for (const id of cause[1]!.split(/[,、\s]+/).filter((x) => x && x !== "なし"))
        open.push(/^[A-Za-z0-9._/-]{1,120}$/.test(id) ? `cause:${id}` : "cause:unparsed");
    const previous = /^前のRT\s*:\s*(.*)$/.exec(row);
    if (previous)
      for (const part of previous[1]!.split("/"))
        if (/^\s*(?:解消|対応不要)\s/.test(part))
          for (const m of part.matchAll(/\bRT-[1-9][0-9]{0,2}\b/g)) resolved.push(m[0]);
  }
  return { open, resolved };
}
