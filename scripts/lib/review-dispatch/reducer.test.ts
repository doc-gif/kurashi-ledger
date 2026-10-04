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

test("W4 #51 rule: any actor's latest CHANGES_REQUESTED blocks accepted, not only assigned reviewers'", () => {
  const p = policy(),
    s = snapshot(),
    t = assess(p, s, null);
  const approve = { id: "r1", actor: 30, state: "APPROVED" as const, pair: s.pair, findings: [] };
  // A third party (not in the policy) and the owner (not an assigned reviewer).
  for (const actor of [999, 10]) {
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
