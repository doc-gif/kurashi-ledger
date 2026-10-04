import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, accepted, reviewerEligible } from "./reducer.ts";
import { validatePolicy } from "./model.ts";
import {
  policy,
  snapshot,
  HEAD,
  BASE,
} from "../../../tests/fixtures/review-dispatch.ts";

test("D01 human and AI roles use the same readiness/independence rules", () => {
  for (const implementer of ["human", "ai"] as const)
    for (const reviewer of ["human", "ai"] as const) {
      const p = policy();
      p.actors[1]!.kind = implementer;
      p.actors[2]!.kind = reviewer;
      assert.equal(assess(p, snapshot(), null).status, "eligible");
      assert.equal(reviewerEligible(p, snapshot(), 30), true);
    }
  const p = policy();
  p.actors[2]!.person = p.actors[1]!.person;
  assert.equal(reviewerEligible(p, snapshot(), 30), false);
  assert.throws(() => validatePolicy(p));
});
for (const [name, mutate, reason] of [
  [
    "partial batch",
    (s: ReturnType<typeof snapshot>) => {
      s.complete = false;
    },
    "unknown-evidence",
  ],
  [
    "missing history",
    (s: ReturnType<typeof snapshot>) => {
      s.historyComplete = false;
    },
    "unknown-evidence",
  ],
  [
    "changed during collection",
    (s: ReturnType<typeof snapshot>) => {
      s.finalPair.head = "d".repeat(40);
    },
    "unknown-evidence",
  ],
  [
    "retarget",
    (s: ReturnType<typeof snapshot>) => {
      s.baseRef = "release";
    },
    "base-not-incorporated",
  ],
  [
    "old ancestor",
    (s: ReturnType<typeof snapshot>) => {
      s.mergeBase = "d".repeat(40);
    },
    "base-not-incorporated",
  ],
  [
    "unknown pushers",
    (s: ReturnType<typeof snapshot>) => {
      s.pushers = null;
    },
    "unknown-identity",
  ],
  [
    "unauthorized ready",
    (s: ReturnType<typeof snapshot>) => {
      s.history[1]!.actor = 40;
    },
    "new-ready-required",
  ],
  [
    "unknown historical pair",
    (s: ReturnType<typeof snapshot>) => {
      s.history[1]!.pair = null;
    },
    "new-ready-required",
  ],
  [
    "tied push",
    (s: ReturnType<typeof snapshot>) => {
      s.history[0]!.at = 2;
    },
    "new-ready-required",
  ],
  [
    "post-ready push",
    (s: ReturnType<typeof snapshot>) => {
      s.history[0]!.at = 3;
    },
    "new-ready-required",
  ],
  [
    "draft",
    (s: ReturnType<typeof snapshot>) => {
      s.draft = true;
    },
    "draft",
  ],
  [
    "design unresolved",
    (s: ReturnType<typeof snapshot>) => {
      s.unresolvedDesign = ["PR1-D001"];
    },
    "unresolved-design",
  ],
] as const)
  test(`D04/D06 ${name} never authorizes work`, () => {
    const s = snapshot();
    mutate(s);
    assert.equal(assess(policy(), s, null).reason, reason);
  });
for (const conclusion of ["failure", "pending", "skipped", "cancelled"])
  test(`D05 CI ${conclusion} blocks`, () => {
    const s = snapshot();
    s.ci[1]!.conclusion = conclusion;
    assert.equal(assess(policy(), s, null).reason, "ci-not-proven");
  });
test("D05 missing/duplicate jobs and wrong tested tree/parents block", () => {
  for (const mutate of [
    (s: ReturnType<typeof snapshot>) => s.ci.pop(),
    (s: ReturnType<typeof snapshot>) => s.ci.push(s.ci[0]!),
    (s: ReturnType<typeof snapshot>) => {
      s.testedParents.reverse();
    },
    (s: ReturnType<typeof snapshot>) => {
      s.testedTree = BASE;
    },
  ]) {
    const s = snapshot();
    mutate(s);
    assert.equal(assess(policy(), s, null).reason, "ci-not-proven");
  }
});
test("D02 main advance invalidates old Ready; no current pair pasted onto history", () => {
  const p = policy(),
    s = snapshot(),
    prior = assess(p, s, null);
  s.pair.base = "d".repeat(40);
  s.finalPair = s.pair;
  s.mergeBase = s.pair.base;
  const t = assess(p, s, prior);
  assert.equal(t.generation, 2);
  assert.equal(t.reason, "new-ready-required");
});
test("D06 pause removal only owner; removal alone does not Ready", () => {
  const p = policy(),
    s = snapshot();
  s.history.push({
    id: "pause1",
    kind: "pause",
    actor: 999,
    at: 3,
    pair: null,
  });
  let t = assess(p, s, null);
  assert.equal(t.paused, true);
  s.history.push({
    id: "unpause1",
    kind: "unpause",
    actor: 20,
    at: 4,
    pair: null,
  });
  t = assess(p, s, t);
  assert.equal(t.paused, true);
  s.history.push({
    id: "unpause2",
    kind: "unpause",
    actor: 10,
    at: 5,
    pair: null,
  });
  t = assess(p, s, t);
  assert.equal(t.reason, "new-ready-required");
  s.history.push({
    id: "ready2",
    kind: "ready",
    policy: "p1",
    actor: 20,
    at: 6,
    pair: s.pair,
  });
  assert.equal(assess(p, s, t).status, "eligible");
});
test("D02 consumed Ready survives replay; current unchanged Ready remains usable for next reviewer", () => {
  const p = policy(),
    s = snapshot(),
    t = assess(p, s, null);
  assert.equal(
    assess(p, s, null, new Set(["ready1"])).reason,
    "new-ready-required",
  );
  assert.equal(assess(p, s, t, new Set(["ready1"])).status, "eligible");
});
test("D06 native accepted needs exact establishment pair, independent faultfinding and complete required set", () => {
  const p = policy(),
    s = snapshot(),
    t = assess(p, s, null);
  s.reviews = [
    {
      id: "r1",
      actor: 30,
      state: "APPROVED",
      pair: { head: HEAD, base: BASE },
      findings: [],
    },
  ];
  assert.equal(accepted(p, s, t), true);
  s.reviews[0]!.pair = null;
  assert.equal(accepted(p, s, t), false);
  s.reviews[0]!.pair = s.pair;
  s.reviews.push({ ...s.reviews[0]!, id: "r2", state: "DISMISSED" });
  assert.equal(accepted(p, s, t), false);
  s.reviews.pop();
  s.faultfinding = null;
  assert.equal(accepted(p, s, t), false);
});
test("D01 multiple independent reviewers and request changes cannot be outvoted", () => {
  const p = policy(),
    s = snapshot();
  p.targets[0]!.reviewers.push(40);
  const t = assess(p, s, null);
  s.reviews = [
    { id: "r1", actor: 30, state: "APPROVED", pair: s.pair, findings: [] },
    {
      id: "r2",
      actor: 40,
      state: "CHANGES_REQUESTED",
      pair: s.pair,
      findings: [],
    },
  ];
  assert.equal(accepted(p, s, t), false);
  s.reviews[1]!.state = "APPROVED";
  assert.equal(accepted(p, s, t), true);
  s.pushers!.push(30);
  assert.equal(accepted(p, s, t), false);
});
test("D05 Copilot response absent does not add a gate; unresolved material design finding does", () => {
  const p = policy(),
    s = snapshot();
  assert.equal(assess(p, s, null).status, "eligible");
  s.unresolvedDesign = ["PR1-D001"];
  assert.equal(assess(p, s, null).status, "waiting");
});
test("D10 policy rejects expanded capacity, unknown actors and duplicate assignment", () => {
  for (const mutate of [
    (p: ReturnType<typeof policy>) => {
      p.maxConcurrent = 11;
    },
    (p: ReturnType<typeof policy>) => p.owners.push(999),
    (p: ReturnType<typeof policy>) => p.targets.push(p.targets[0]!),
  ]) {
    const p = policy();
    mutate(p);
    assert.throws(() => validatePolicy(p));
  }
});

test("D04 policy revision change requires a newly bound Ready", () => {
  const p = policy(),
    s = snapshot(),
    prior = assess(p, s, null);
  p.revision = "p2";
  assert.equal(assess(p, s, prior).reason, "new-ready-required");
});

test("D04 delayed old delivery cannot become Ready after owner policy boundary", () => {
  const p = policy(),
    s = snapshot();
  p.readyAfter = 3;
  assert.equal(assess(p, s, null).reason, "new-ready-required");
});

test("W4 one rule (owner decision 5978984980): every registered participant's latest CHANGES_REQUESTED blocks; unregistered third parties do not", () => {
  const p = policy(),
    s = snapshot(),
    t = assess(p, s, null);
  const approve = { id: "r1", actor: 30, state: "APPROVED" as const, pair: s.pair, findings: [] };
  // An unregistered third party is reference only on a public repository.
  s.reviews = [approve, { id: "r0", actor: 999, state: "CHANGES_REQUESTED", pair: null, findings: [] }];
  assert.equal(accepted(p, s, t), true);
  // The owner and a registered participant who is not an assigned reviewer.
  for (const actor of [10, 40]) {
    s.reviews = [approve, { id: "r2", actor, state: "CHANGES_REQUESTED", pair: null, findings: [] }];
    assert.equal(accepted(p, s, t), false, `actor ${actor}`);
    // A later APPROVED or DISMISSED by the same actor is their latest review and no longer blocks.
    s.reviews.push({ id: "r3", actor, state: "DISMISSED", pair: null, findings: [] });
    assert.equal(accepted(p, s, t), true, `actor ${actor} dismissed`);
  }
  // A third party's COMMENTED review stays reference only.
  s.reviews = [approve, { id: "r4", actor: 999, state: "COMMENTED", pair: null, findings: [] }];
  assert.equal(accepted(p, s, t), true);
});

test("W4 trust records are bound to main; the unbound W3 form is refused so the owner re-records", () => {
  const p = policy() as ReturnType<typeof policy> & Record<string, unknown>;
  const a = "a".repeat(64),
    b = "b".repeat(64);
  validatePolicy({ ...p, trustedCi: [{ main: a, head: b }] });
  for (const bad of [
    { trustedCiDigests: [b] },
    { trustedCi: [{ main: a }] },
    { trustedCi: [{ main: a, head: a }] },
    { trustedCi: [{ main: a, head: b, extra: 1 }] },
    { trustedCi: [{ main: a, head: b }, { main: a, head: b }] },
  ])
    assert.throws(() => validatePolicy({ ...p, ...bad }), /workflow trust/, JSON.stringify(bad));
});

test("W4 a later COMMENTED review does not undo a change request; approval blockers exclude only the approver", async () => {
  const { approvalBlockers } = await import("./reducer.ts");
  const p = policy(),
    s = snapshot(),
    t = assess(p, s, null);
  s.reviews = [
    { id: "r1", actor: 30, state: "APPROVED", pair: s.pair, findings: [] },
    { id: "r2", actor: 10, state: "CHANGES_REQUESTED", pair: null, findings: [] },
    { id: "r3", actor: 10, state: "COMMENTED", pair: null, findings: [] },
  ];
  assert.equal(accepted(p, s, t), false);
  // A reviewer's later COMMENTED review does not undo its approval either.
  s.reviews = [
    { id: "r1", actor: 30, state: "APPROVED", pair: s.pair, findings: [] },
    { id: "r4", actor: 30, state: "COMMENTED", pair: null, findings: [] },
  ];
  assert.equal(accepted(p, s, t), true);
  s.reviews = [
    { id: "r5", actor: 30, state: "CHANGES_REQUESTED", pair: null, findings: [] },
    { id: "r6", actor: 10, state: "CHANGES_REQUESTED", pair: null, findings: [] },
  ];
  s.openFindings = [
    { actor: 30, ids: ["PR1-R001"] },
    { actor: 10, ids: ["review:9"] },
  ];
  assert.deepEqual(approvalBlockers(p, s, 30), ["changes-requested:10", "review:9"]);
  // A registered participant who is not assigned (40) blocks too; an unregistered one (999) does not.
  s.reviews.push({ id: "r7", actor: 40, state: "CHANGES_REQUESTED", pair: null, findings: [] });
  s.reviews.push({ id: "r8", actor: 999, state: "CHANGES_REQUESTED", pair: null, findings: [] });
  s.openFindings.push({ actor: 40, ids: ["PR1-R007"] });
  assert.deepEqual(approvalBlockers(p, s, 30), ["PR1-R007", "changes-requested:10", "changes-requested:40", "review:9"]);
  // accepted() applies the same rule: an open finding of any registered participant blocks.
  s.reviews = [{ id: "r9", actor: 30, state: "APPROVED", pair: s.pair, findings: [] }];
  s.openFindings = [{ actor: 40, ids: ["PR1-R007"] }];
  assert.equal(accepted(p, s, t), false);
  s.openFindings = [];
  assert.equal(accepted(p, s, t), true);
  s.reviews = [{ id: "r5", actor: 30, state: "CHANGES_REQUESTED", pair: null, findings: [] }];
  s.openFindings = [{ actor: 30, ids: ["PR1-R001"] }];
  assert.deepEqual(approvalBlockers(p, s, 30), []);
});

test("W4 finding raisers are every registered participant, owners included, except the PR's implementer (same person included)", async () => {
  const { findingRaisers } = await import("./model.ts");
  const p = policy();
  assert.deepEqual(findingRaisers(p, 1), [10, 30, 40]); // 10 is the owner (Codex PR56-R002), 20 the implementer
  p.actors.push({ id: 21, person: "implementer", kind: "ai", executor: "claude" }); // same person as 20
  p.actors.push({ id: 50, person: "codex-reviewer", kind: "ai", executor: "codex" });
  assert.deepEqual(findingRaisers(p, 1), [10, 30, 40, 50]);
  assert.deepEqual(findingRaisers(p, 99), []);
});

test("Sweep: findings that were not collected are unknown, not none (no accepted, no APPROVE)", async () => {
  const { approvalBlockers } = await import("./reducer.ts");
  const p = policy(),
    s = snapshot(),
    t = assess(p, s, null);
  s.reviews = [{ id: "r1", actor: 30, state: "APPROVED", pair: s.pair, findings: [] }];
  assert.equal(accepted(p, s, t), true);
  assert.deepEqual(approvalBlockers(p, s, 30), []);
  delete s.openFindings;
  assert.equal(accepted(p, s, t), false);
  assert.deepEqual(approvalBlockers(p, s, 30), ["findings-unknown"]);
});
