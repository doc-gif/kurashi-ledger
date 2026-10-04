import {
  bindReady,
  bindReview,
  collect,
  object,
  type Collection,
  type GhReader,
  type ReadyBinding,
  type ReviewBinding,
} from "./github.ts";
import {
  findingRaisers,
  hash,
  keyOf,
  registered,
  samePair,
  type Policy,
  type Pair,
  type HistoryEvent,
  type Snapshot,
} from "./model.ts";
import { accepted, assess, reviewerEligible } from "./reducer.ts";
import { RED_TEAM_MARK, RT_ID } from "./active.ts";
import {
  changeKey,
  type ChangeRecord,
  type ItemRecord,
} from "./findings.ts";
import { SIGNALS } from "./webhook.ts";
import { Store } from "./store.ts";

export type Observation = {
  policy: string;
  pair: Pair;
  observedAt: number;
  historyComplete: boolean;
  status: string;
  generation: number;
  legacyReady: boolean;
  differs: boolean;
  // PR48-R008/R007: workflow trust and the assigned reviewers' unresolved finding IDs (no prose).
  workflow: Collection["workflow"];
  findings: string[];
  // PR48-R014: the dispatcher's accepted() against the current canon (every assigned reviewer's latest v1
  // record is `decision: accepted` for this head/base). A comparison only; it never grants anything.
  accepted: boolean;
  legacyAccepted: boolean;
  acceptedDiffers: boolean;
  // PR48-R014: a human reviewer's manual red-team record (comparison only): its open IDs, or null.
  manualFaultfinding: string[] | null;
};
const actorId = (v: unknown): number | null => {
  const id = object(v)["id"];
  return Number.isSafeInteger(id) && Number(id) > 0 ? Number(id) : null;
};
// Require an API-visible start anchor and contiguous server activity, not commit authors/dates.
export function activityHistory(
  p: Policy,
  c: Collection,
): { pushers: number[] | null; complete: boolean; history: HistoryEvent[] } {
  if (c.headRepoId !== p.repoId)
    return { pushers: null, complete: false, history: [] };
  const target = p.targets.find((t) => t.pr === c.snapshot.pr)!;
  const events = c.activity
    .filter((e) => e["ref"] === c.headRef)
    .sort(
      (a, b) =>
        Date.parse(String(a["timestamp"])) - Date.parse(String(b["timestamp"])),
    );
  const seed = target.identity;
  const anchor = seed
    ? events.findIndex(
        (e) =>
          String(e["id"]) === seed.activity &&
          e["after"] === seed.head &&
          Date.parse(String(e["timestamp"])) === seed.at,
      )
    : events.findIndex((e) => e["before"] === "0".repeat(40));
  if (
    anchor < 0 ||
    (seed &&
      (!seed.pushers.includes(actorId(events[anchor]!["actor"]) ?? 0) ||
        !["push", "force_push", "branch_creation"].includes(
          String(events[anchor]!["activity_type"]),
        )))
  )
    return { pushers: null, complete: false, history: [] };
  let head = seed?.head ?? "0".repeat(40),
    at = seed?.at ?? -1;
  const pushers = new Set(seed?.pushers ?? []),
    history: HistoryEvent[] = [];
  for (let i = seed ? anchor + 1 : anchor; i < events.length; i++) {
    const e = events[i]!,
      time = Date.parse(String(e["timestamp"])),
      actor = actorId(e["actor"]);
    if (
      !actor ||
      (!["push", "force_push"].includes(String(e["activity_type"])) &&
        !(i === anchor && !seed && e["activity_type"] === "branch_creation")) ||
      !/^[a-f0-9]{40}$/.test(String(e["after"])) ||
      e["after"] === "0".repeat(40) ||
      e["before"] !== head ||
      !Number.isFinite(time) ||
      time <= at ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(String(e["id"]))
    )
      return { pushers: null, complete: false, history: [] };
    head = String(e["after"]);
    at = time;
    pushers.add(actor);
    history.push({
      id: `activity:${e["id"]}`,
      kind: "push",
      actor,
      at: time,
      pair: null,
    });
  }
  if (head !== c.snapshot.pair.head || !pushers.size)
    return { pushers: null, complete: false, history: [] };
  return { pushers: [...pushers], complete: true, history };
}
function apply(
  c: Collection,
  ready: ReadyBinding[],
  reviews: ReviewBinding[],
  p: Policy,
): void {
  const proof = activityHistory(p, c);
  c.snapshot.pushers = proof.pushers;
  c.snapshot.historyComplete = proof.complete;
  c.snapshot.history.push(...proof.history);
  for (const event of c.snapshot.history) {
    const b = ready.find(
      (b) =>
        b.id === event.id &&
        b.actor === event.actor &&
        b.at === event.at &&
        b.policy === p.revision,
    );
    if (b) {
      event.pair = b.pair;
      event.policy = b.policy;
    }
  }
  for (const review of c.snapshot.reviews) {
    const b = reviews.find(
      (b) =>
        b.id === review.id &&
        b.actor === review.actor &&
        b.state === review.state &&
        b.policy === p.revision &&
        b.pair.head ===
          c.reviews.find((r) => String(r["id"]) === review.id)?.["commit_id"],
    );
    review.pair = b?.pair ?? null;
  }
}
// No missing-delivery recovery on first observation, changed pair/policy or an intervening push.
function recoverable(
  c: Collection,
  p: Policy,
  prior: Observation | null,
  at: number,
): boolean {
  return (
    prior !== null &&
    prior.policy === p.revision &&
    prior.historyComplete &&
    c.snapshot.historyComplete &&
    c.snapshot.complete &&
    samePair(prior.pair, c.snapshot.pair) &&
    Number.isFinite(c.observedAt) &&
    Number.isFinite(at) &&
    prior.observedAt < at &&
    at <= c.observedAt &&
    !c.snapshot.history.some(
      (e) => e.kind === "push" && e.at > prior.observedAt,
    )
  );
}
function legacyReady(c: Collection, p: Policy): boolean {
  const allowed = p.targets.find((t) => t.pr === c.snapshot.pr)!.implementer;
  const rows = c.handoffs.filter(
    (r) =>
      actorId(r["user"]) === allowed &&
      typeof r["body"] === "string" &&
      String(r["body"]).includes("<!-- kurashi-ledger:handoff:v1 -->"),
  );
  const row = rows.at(-1);
  if (!row) return false;
  const body = String(row["body"]);
  const field = (name: string): string | null => {
    const values = [
      ...body.matchAll(new RegExp(`^${name}: ([^\\r\\n]+)$`, "gm")),
    ];
    return values.length === 1 ? values[0]![1]! : null;
  };
  return (
    field("worker_status") === "ready-for-review" &&
    field("head_sha") === c.snapshot.pair.head &&
    field("base_sha") === c.snapshot.pair.base
  );
}
// Conversation comments and Review bodies with their server times (records written by people and Apps).
function records(c: Collection): { actor: number | null; body: string; at: number; id: string }[] {
  return [
    ...c.handoffs.map((r) => ({ r, at: r["created_at"], id: `comment-${String(r["id"])}` })),
    ...c.reviews.map((r) => ({ r, at: r["submitted_at"], id: `review-${String(r["id"])}` })),
  ]
    .filter(({ r }) => typeof r["body"] === "string")
    .map(({ r, at, id }) => ({
      actor: actorId(r["user"]),
      body: String(r["body"]),
      at: Date.parse(String(at)),
      id,
    }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}
const recordField = (body: string, name: string): string | null => {
  const values = [...body.matchAll(new RegExp(`^${name}:[ \\t]*([^\\r\\n]*?)[ \\t]*\\r?$`, "gm"))];
  return values.length === 1 ? values[0]![1]! : null;
};
const REVIEW_MARK = /^\s*<!--\s*kurashi-ledger:review:v1\s*-->[ \t]*(?:\r?\n|$)/;
// PR48-R014: the current canon's accepted (pr-review-loop.md 3節): each assigned reviewer's latest v1 record
// says `decision: accepted` for exactly this head/base.
function legacyAccepted(c: Collection, p: Policy): boolean {
  const s = c.snapshot,
    reviewers = p.targets.find((t) => t.pr === s.pr)!.reviewers;
  const v1 = records(c).filter((r) => REVIEW_MARK.test(r.body));
  return reviewers.every((id) => {
    const latest = v1.filter((r) => r.actor === id).at(-1);
    return (
      latest !== undefined &&
      recordField(latest.body, "decision") === "accepted" &&
      recordField(latest.body, "head_sha") === s.pair.head &&
      recordField(latest.body, "base_sha") === s.pair.base
    );
  });
}
// PR48-R014: a person's manual red-team record (pr-review-loop.md 担当: 人なら同じ書式で手動), read for the
// shadow COMPARISON only. It never feeds the gate (snapshot.faultfinding) until its coverage matches the AI
// side (the whole ledger, a re-check of every earlier record, readyAfter). It counts only from an assigned,
// independent human reviewer, with the marker on the first line and this exact head/base. In its tables
// (header rows skipped): a cause whose judgement does not start with `該当なし` is open; an RT row is resolved
// only by `解消`, or `対応不要` with a reason. Every RT ID in any registered participant's record is open
// unless resolved so. null: no such record.
const RT_CELL = /^RT-[1-9][0-9]{0,2}$/,
  TABLE_RULE = /^\|?\s*:?-{3,}/;
export function manualFaultfinding(p: Policy, c: Collection): string[] | null {
  const s = c.snapshot;
  const all = records(c).filter(
    (r) => RED_TEAM_MARK.test(r.body) && r.actor !== null && registered(p, r.actor),
  );
  const latest = all
    .filter(
      (r) =>
        p.actors.find((a) => a.id === r.actor)?.kind === "human" &&
        reviewerEligible(p, s, r.actor!) &&
        recordField(r.body, "head_sha") === s.pair.head &&
        recordField(r.body, "base_sha") === s.pair.base,
    )
    .at(-1);
  if (!latest) return null;
  const resolved = new Set<string>(),
    open = new Set<string>();
  const lines = latest.body.normalize("NFKC").split(/\r?\n/).map((x) => x.trim());
  lines.forEach((row, n) => {
    if (!row.startsWith("|") || TABLE_RULE.test(row) || TABLE_RULE.test(lines[n + 1] ?? "")) return;
    const cells = row.replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
    const [first = "", judgement = "", rest = ""] = cells;
    if (RT_CELL.test(first)) {
      if (
        judgement === "解消" ||
        /^対応不要[（(:：]\s*\S/.test(judgement) ||
        (judgement === "対応不要" && rest !== "")
      )
        resolved.add(first);
      else open.add(first);
    } else if (!judgement.startsWith("該当なし"))
      open.add(/^[A-Za-z0-9._/-]{1,120}$/.test(first) ? `cause:${first}` : "cause:unparsed");
  });
  for (const r of all)
    for (const m of r.body.normalize("NFKC").matchAll(RT_ID))
      if (!resolved.has(`RT-${m[1]}`)) open.add(`RT-${m[1]}`);
  return [...open].sort();
}
// W4 row 8: change records from signed edit/delete deliveries, so a change made and undone between two
// reconciles, or made before the first observation, is still raised. Same authors as findings.ts reads:
// Review bodies of registered participants (model.ts findingRaisers) and owners, comments of the registered
// participants. A dismissal is seen as
// the DISMISSED state by the next collection, so it only marks the PR (webhook.ts).
export function signalRecords(
  p: Policy,
  pr: number,
  event: string,
  payload: Record<string, unknown>,
  received: number,
): ChangeRecord[] {
  const action = String(payload["action"]);
  if (!(SIGNALS[event] ?? []).includes(action) || action === "dismissed") return [];
  const target = p.targets.find((t) => t.pr === pr);
  if (!target) return [];
  const thing = object(
    event === "pull_request_review" ? payload["review"] : payload["comment"],
  );
  const id = thing["id"],
    author = actorId(thing["user"]);
  if (!Number.isSafeInteger(id) || Number(id) < 1 || author === null) return [];
  const review = event === "pull_request_review";
  if (
    !findingRaisers(p, pr).includes(author) &&
    !(review && p.owners.includes(author))
  )
    return [];
  const item = `${review ? "review" : event === "issue_comment" ? "issue" : "comment"}:${id}`;
  const updated = Date.parse(String(thing["updated_at"]));
  const text = thing["body"];
  if (text !== null && text !== undefined && typeof text !== "string") return [];
  return [
    action === "deleted"
      ? { item, actor: author, at: received, change: "deleted", hash: null, previous: "webhook" }
      : {
          item,
          actor: author,
          // Comments carry the server's edit time; a Review edit time is the receipt time.
          at: !review && Number.isFinite(updated) ? updated : received,
          change: "edited",
          hash: hash(typeof text === "string" ? text : ""),
          previous: "webhook",
        },
  ];
}
const deliveryPr = (event: string, payload: Record<string, unknown>): number | null => {
  const holder =
    event === "issue_comment" ? payload["issue"] : payload["pull_request"];
  if (!holder || typeof holder !== "object") return null;
  const n = (holder as Record<string, unknown>)["number"];
  return Number.isSafeInteger(n) ? Number(n) : null;
};
export type CycleResult = {
  pr: number;
  snapshot: Snapshot;
  observation: Observation;
  // PR48-R013: since when (stored local clock) this PR's observation is held as transiently incomplete.
  heldSince: number | null;
};
export async function reconcile(
  reader: GhReader,
  p: Policy,
  store: Store,
): Promise<CycleResult[]> {
  if (p.mode === "off") return [];
  const pending = store.pendingInbox();
  // PR48-R015: holds created before this fetch began; this reconcile's server time is after their creation.
  const unsettled = store.unsettledHolds();
  const deliveries = pending.map((row) => ({
    row,
    payload: object(JSON.parse(String(row["payload"]))),
  }));
  const updates: {
    key: string;
    ready: ReadyBinding[];
    reviews: ReviewBinding[];
    observation: Observation;
    items: ItemRecord[];
    changes: ChangeRecord[];
  }[] = [];
  const results: CycleResult[] = [];
  // PR48-R013: PRs whose observation was transiently incomplete. Nothing of theirs is saved and their
  // deliveries stay pending, so a later complete reconcile binds a Ready missed now.
  const held = new Set<number>();
  for (const target of p.targets) {
    const key = keyOf(p, target.pr),
      ready = store.evidence<ReadyBinding>(key, "ready"),
      reviews = store.evidence<ReviewBinding>(key, "review"),
      prior = store.observation<Observation>(key),
      stored = store.evidence<ChangeRecord>(key, "itemchange"),
      signals = deliveries
        .filter(({ row, payload }) => deliveryPr(String(row["event"]), payload) === target.pr)
        .flatMap(({ row, payload }) =>
          signalRecords(p, target.pr, String(row["event"]), payload, Number(row["received"])),
        )
        .filter((r) => !stored.some((x) => changeKey(x) === changeKey(r)));
    const c = await collect(reader, p, target.pr, {
      requiredJobs: [],
      ready,
      acceptances: reviews,
      pushers: null,
      historyComplete: false,
      faultfinding: null,
      unresolvedDesign: [],
      findingItems: store.evidence<ItemRecord>(key, "item"),
      findingChanges: [...stored, ...signals],
    });
    apply(c, ready, reviews, p);
    if (!Number.isFinite(c.observedAt))
      throw new Error("Server observation time missing");
    for (const { row, payload } of deliveries) {
      if (
        Number(row["app"]) !== p.receiveAppId ||
        object(payload["repository"])["id"] !== p.repoId ||
        object(payload["installation"])["id"] !== p.installationId
      )
        throw new Error("Inbox identity changed");
      if (deliveryPr(String(row["event"]), payload) !== target.pr) continue;
      // PR58-R003: a delivery binds only under the policy revision it was received under. One received under
      // an earlier revision, or with no recorded revision, never binds (a revision change needs a new Ready),
      // however long it was held. Its change records (signals above) are still used.
      if (row["policy"] !== p.revision) continue;
      const r =
        String(row["event"]) === "pull_request" ? bindReady(payload, c) : null;
      if (r && !ready.some((x) => x.id === r.id)) ready.push(r);
      const v =
        String(row["event"]) === "pull_request_review"
          ? bindReview(payload, c)
          : null;
      if (v && !reviews.some((x) => x.id === v.id)) reviews.push(v);
    }
    for (const e of c.snapshot.history) {
      if (
        e.kind === "ready" &&
        !e.id.startsWith("created:") &&
        !ready.some((x) => x.id === e.id) &&
        recoverable(c, p, prior, e.at)
      )
        ready.push({
          id: e.id,
          actor: e.actor,
          at: e.at,
          pair: { ...c.snapshot.pair },
          policy: p.revision,
        });
    }
    for (const r of c.reviews) {
      const at = Date.parse(String(r["submitted_at"])),
        actor = actorId(r["user"]),
        id = String(r["id"]);
      if (
        actor &&
        r["commit_id"] === c.snapshot.pair.head &&
        recoverable(c, p, prior, at) &&
        !reviews.some((x) => x.id === id)
      )
        reviews.push({
          id,
          actor,
          pair: { ...c.snapshot.pair },
          state: String(r["state"]),
          policy: p.revision,
        });
    }
    // Reapply new immutable bindings; no additional network side effect or AI call.
    c.snapshot.history = c.snapshot.history.filter(
      (e) => !e.id.startsWith("activity:"),
    );
    apply(c, ready, reviews, p);
    // The red-team record this dispatcher posted for this pair and policy revision (the AI reviewer's
    // faultfinding job). A person's manual record is compared only (PR48-R014).
    c.snapshot.faultfinding = store.faultfinding(key, c.snapshot.pair, p.revision);
    const assessed = assess(p, c.snapshot, store.target(key), store.consumed());
    const legacy = legacyReady(c, p),
      dispatcherAccepted = accepted(p, c.snapshot, assessed),
      currentAccepted = legacyAccepted(c, p);
    const observation: Observation = {
      policy: p.revision,
      pair: c.snapshot.pair,
      observedAt: c.observedAt,
      historyComplete: c.snapshot.historyComplete,
      status: assessed.reason,
      generation: assessed.generation,
      legacyReady: legacy,
      differs: legacy !== (assessed.status === "eligible"),
      workflow: c.workflow,
      findings: [
        ...new Set(c.snapshot.reviews.flatMap((r) => r.findings)),
      ].sort(),
      accepted: dispatcherAccepted,
      legacyAccepted: currentAccepted,
      acceptedDiffers: dispatcherAccepted !== currentAccepted,
      manualFaultfinding: manualFaultfinding(p, c),
    };
    // PR48-R013: transient incompleteness (the PR, its state or main changed during the fetch, a short or
    // unconfirmed commit list) holds everything. So does an incomplete branch history (PR58-R001: a lost
    // activity anchor can come back; saving would move the recovery window past a missed Ready), unless a
    // known permanent cause applies: an untrusted workflow evaluated on a stable pair (a Ready that arrived
    // before the owner recorded the trust is never bound later, review-dispatch-implementation.md workflowの
    // 信頼 3), the 250-commit list limit, or a head branch outside the repository. Those are processed unbound.
    const permanent =
      c.workflow === "untrusted" || c.commitList === "capped" || c.headRepoId !== p.repoId;
    if (c.transient || (!c.snapshot.historyComplete && !permanent)) held.add(target.pr);
    else
      updates.push({
        key,
        ready,
        reviews,
        observation,
        items: c.findingItems,
        changes: [...signals, ...c.findingChanges],
      });
    results.push({ pr: target.pr, snapshot: c.snapshot, observation, heldSince: null });
  }
  // Any failed page/batch leaves Inbox pending and prior observation intact. A crash rolls back BOTH bindings and tombstones.
  store.atomic(() => {
    for (const update of updates) {
      for (const r of update.ready)
        store.saveEvidence(update.key, "ready", r.id, r);
      for (const r of update.reviews)
        store.saveEvidence(update.key, "review", r.id, r);
      // PR48-R007: first observations and detected edits/deletions are immutable.
      for (const r of update.items) store.saveEvidence(update.key, "item", r.item, r);
      for (const r of update.changes)
        store.saveEvidence(update.key, "itemchange", changeKey(r), r);
      store.saveObservation(update.key, update.observation);
      store.settleHolds(update.key, update.observation.observedAt, unsettled);
    }
    for (const r of results) r.heldSince = store.heldSince(keyOf(p, r.pr), held.has(r.pr));
    for (const { row, payload } of deliveries) {
      const pr = deliveryPr(String(row["event"]), payload);
      if (pr === null || !held.has(pr))
        store.processed(Number(row["app"]), String(row["delivery"]));
    }
  });
  return results;
}
