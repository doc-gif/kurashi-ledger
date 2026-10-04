import {
  independent,
  keyOf,
  samePair,
  type Policy,
  type Snapshot,
  type Target,
} from "./model.ts";

// Pure decision; callers persist transitions/consumed IDs before any side effect.
export function assess(
  p: Policy,
  s: Snapshot,
  previous: Target | null,
  consumed: ReadonlySet<string> = new Set(),
): Target {
  const assignment = p.targets.find((t) => t.pr === s.pr);
  const changed =
    previous !== null &&
    (!samePair(previous.pair, s.pair) || previous.policy !== p.revision);
  const t: Target = {
    key: keyOf(p, s.pr),
    generation: previous ? previous.generation + Number(changed) : 1,
    policy: p.revision,
    pair: { ...s.pair },
    ready: null,
    paused: previous?.paused ?? false,
    status: "waiting",
    reason: "unknown-evidence",
  };
  const deny = (reason: string): Target => {
    if (previous && !changed && previous.paused !== t.paused) t.generation++;
    t.reason = reason;
    return t;
  };
  if (!assignment || s.repoId !== p.repoId) return deny("outside-policy");
  if (s.state === "closed") {
    t.status = "finished";
    return deny("closed");
  }
  const events = [...s.history].sort(
    (a, b) => a.at - b.at || a.id.localeCompare(b.id),
  );
  // Pause is sticky. Unauthorized removal cannot clear it; unpause invalidates Ready.
  let boundary = p.readyAfter;
  for (const e of events) {
    if (e.kind === "pause") {
      t.paused = true;
      boundary = Math.max(boundary, e.at);
    }
    if (e.kind === "unpause") {
      if (p.owners.includes(e.actor)) t.paused = false;
      boundary = Math.max(boundary, e.at);
    }
    if (e.kind === "push" || e.kind === "draft")
      boundary = Math.max(boundary, e.at);
  }
  if (s.pausedLabel) t.paused = true;
  if (t.paused) return deny("paused");
  if (s.draft) return deny("draft");
  if (!s.complete || !s.historyComplete || !samePair(s.pair, s.finalPair))
    return deny("unknown-evidence");
  if (s.baseRef !== "main" || s.mergeBase !== s.pair.base)
    return deny("base-not-incorporated");
  if (s.pushers === null || !p.actors.some((a) => a.id === s.author))
    return deny("unknown-identity");
  // Newly changed pair needs a newly proved event, never a saved Ready for a different base.
  const ready = events
    .filter(
      (e) =>
        e.kind === "ready" &&
        e.policy === p.revision &&
        e.at > boundary &&
        e.pair &&
        samePair(e.pair, s.pair) &&
        (e.actor === assignment.implementer || p.owners.includes(e.actor)) &&
        (!consumed.has(e.id) ||
          (previous?.ready === e.id && !changed && !previous.paused)),
    )
    .at(-1);
  if (
    !ready ||
    events.some(
      (e) =>
        e.id !== ready.id &&
        e.at === ready.at &&
        ["push", "draft", "unpause", "ready"].includes(e.kind),
    )
  )
    return deny("new-ready-required");
  t.ready = ready.id;
  if (
    previous &&
    !changed &&
    (previous.paused !== t.paused ||
      (previous.ready !== null && previous.ready !== ready.id))
  )
    t.generation++;
  if (
    s.testedTree !== s.headTree ||
    s.testedParents.length !== 2 ||
    s.testedParents[0] !== s.pair.base ||
    s.testedParents[1] !== s.pair.head ||
    !s.requiredJobs.includes("Quality gate") ||
    !s.requiredJobs.length ||
    s.ci.some((j) => j.conclusion !== "success") ||
    s.requiredJobs.some(
      (name) =>
        s.ci.filter((j) => j.name === name).length !== 1 ||
        s.ci.find((j) => j.name === name)?.conclusion !== "success",
    )
  )
    return deny("ci-not-proven");
  if (s.unresolvedDesign.length) return deny("unresolved-design");
  t.status = "eligible";
  t.reason = p.mode === "active" ? "ready" : p.mode;
  return t;
}
export function reviewerEligible(
  p: Policy,
  s: Snapshot,
  actor: number,
): boolean {
  const assignment = p.targets.find((t) => t.pr === s.pr);
  return (
    !!assignment?.reviewers.includes(actor) &&
    s.pushers !== null &&
    independent(p, actor, assignment.implementer) &&
    independent(p, actor, s.author) &&
    s.pushers.every((id) => independent(p, actor, id))
  );
}
export function accepted(p: Policy, s: Snapshot, t: Target): boolean {
  if (
    t.status !== "eligible" ||
    t.paused ||
    !samePair(t.pair, s.pair) ||
    !s.faultfinding ||
    !samePair(s.faultfinding.pair, s.pair) ||
    !reviewerEligible(p, s, s.faultfinding.actor) ||
    s.faultfinding.unresolved.length ||
    s.unresolvedDesign.length
  )
    return false;
  const assignment = p.targets.find((x) => x.pr === s.pr);
  if (!assignment) return false;
  // Latest DECISIVE review per actor wins (APPROVED, CHANGES_REQUESTED, DISMISSED): a later COMMENTED review
  // does not undo a change request (GitHub semantics; PR #56 red team P3). Any actor's latest change request
  // blocks (PR #51 rule), and unresolved findings of assigned reviewers block. A blocker is not outvoted.
  const latest = latestDecisive(s);
  if (
    [...latest.values()].some((r) => r.state === "CHANGES_REQUESTED") ||
    s.reviews.some((r) => reviewerEligible(p, s, r.actor) && r.findings.length)
  )
    return false;
  return assignment.reviewers.every((id) => {
    const r = latest.get(id);
    return (
      reviewerEligible(p, s, id) &&
      r?.state === "APPROVED" &&
      r.pair !== null &&
      samePair(r.pair, s.pair)
    );
  });
}
export function latestDecisive(s: Snapshot): Map<number, Snapshot["reviews"][number]> {
  return new Map(
    s.reviews.filter((r) => r.state !== "COMMENTED").map((r) => [r.actor, r]),
  );
}
// What stops `self` from approving now: anyone else's latest decisive change request, and unresolved findings
// raised by anyone else (owner findings included). The approver's own earlier change request and findings are
// superseded by its new approval, like a native re-review. Empty = an APPROVE may be posted (PR #56 red team P2).
export function approvalBlockers(s: Snapshot, self: number): string[] {
  const out: string[] = [];
  for (const [actor, r] of latestDecisive(s))
    if (actor !== self && r.state === "CHANGES_REQUESTED") out.push(`changes-requested:${actor}`);
  for (const f of s.openFindings ?? [])
    if (f.actor !== self) out.push(...f.ids);
  return [...new Set(out)].sort();
}
