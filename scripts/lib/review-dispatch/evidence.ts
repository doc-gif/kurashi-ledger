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
  hash,
  keyOf,
  samePair,
  type Policy,
  type Pair,
  type HistoryEvent,
  type Snapshot,
} from "./model.ts";
import { assess } from "./reducer.ts";
import { type ChangeRecord, type ItemRecord } from "./findings.ts";
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
export type CycleResult = {
  pr: number;
  snapshot: Snapshot;
  observation: Observation;
};
export async function reconcile(
  reader: GhReader,
  p: Policy,
  store: Store,
): Promise<CycleResult[]> {
  if (p.mode === "off") return [];
  const pending = store.pendingInbox();
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
  for (const target of p.targets) {
    const key = keyOf(p, target.pr),
      ready = store.evidence<ReadyBinding>(key, "ready"),
      reviews = store.evidence<ReviewBinding>(key, "review"),
      prior = store.observation<Observation>(key);
    const c = await collect(reader, p, target.pr, {
      requiredJobs: [],
      ready,
      acceptances: reviews,
      pushers: null,
      historyComplete: false,
      faultfinding: null,
      unresolvedDesign: [],
      findingItems: store.evidence<ItemRecord>(key, "item"),
      findingChanges: store.evidence<ChangeRecord>(key, "itemchange"),
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
      const pr = payload["pull_request"];
      if (!pr || object(pr)["number"] !== target.pr) continue;
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
    const assessed = assess(p, c.snapshot, store.target(key), store.consumed());
    const legacy = legacyReady(c, p);
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
    };
    updates.push({
      key,
      ready,
      reviews,
      observation,
      items: c.findingItems,
      changes: c.findingChanges,
    });
    results.push({ pr: target.pr, snapshot: c.snapshot, observation });
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
        store.saveEvidence(
          update.key,
          "itemchange",
          `${r.change}:${r.item}:${r.hash ?? "none"}`,
          r,
        );
      store.saveObservation(update.key, update.observation);
    }
    for (const { row } of deliveries)
      store.processed(Number(row["app"]), String(row["delivery"]));
  });
  return results;
}
