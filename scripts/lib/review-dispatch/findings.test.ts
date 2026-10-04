import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findingIds,
  unresolvedFindings,
  type ChangeRecord,
  type ItemRecord,
} from "./findings.ts";
import { EvidenceError } from "./github.ts";

// Synthetic reviewers: 30 and 40 are assigned, 50 is a third party, 20 is the implementer.
const at = (s: number) =>
  new Date(Date.parse("2026-01-01T00:00:00Z") + s * 1000).toISOString();
const HEAD = "a".repeat(40),
  OLD = "b".repeat(40);
const review = (
  id: number,
  user: number,
  state: string,
  second: number,
  body: string | null = "",
  commit = HEAD,
) => ({
  id,
  user: { id: user },
  state,
  submitted_at: at(second),
  body,
  commit_id: commit,
});
const line = (
  id: number,
  user: number,
  second: number,
  body: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  user: { id: user },
  created_at: at(second),
  updated_at: at(second),
  body,
  pull_request_review_id: 900 + id,
  ...extra,
});
const talk = (id: number, user: number, second: number, body: string, extra: Record<string, unknown> = {}) => ({
  id,
  user: { id: user },
  created_at: at(second),
  updated_at: at(second),
  body,
  ...extra,
});
type R = Record<string, unknown>;
const result = (
  reviews: unknown[],
  comments: unknown[] = [],
  conversation: unknown[] = [],
  memory: { items?: ItemRecord[]; changes?: ChangeRecord[]; observedAt?: number } = {},
) =>
  unresolvedFindings({
    pr: 7,
    head: HEAD,
    reviewers: [30, 40],
    owners: [10],
    reviews: reviews as R[],
    comments: comments as R[],
    conversation: conversation as R[],
    observedAt: memory.observedAt ?? Date.parse(at(100)),
    items: memory.items ?? [],
    changes: memory.changes ?? [],
  });
const run = (reviews: unknown[], comments: unknown[] = [], conversation: unknown[] = []) =>
  Object.fromEntries(result(reviews, comments, conversation).open);

test("R007 IDs are parsed only at line start for this PR; quoted and mid-line mentions are prose", () => {
  assert.deepEqual(
    findingIds(
      7,
      "- PR7-R001 — a: b\nPR7-R002（低）x\n* PR7-R0031 y\n> PR7-R004 quoted\nsee PR7-R005\nPR8-R006 other PR\nPR7-R07 short\n  - PR7-R001 again",
    ),
    ["PR7-R001", "PR7-R002", "PR7-R0031"],
  );
});
test("R007 COMMENT findings stay open until the same reviewer approves later; third parties are reference only", () => {
  assert.deepEqual(
    run([
      review(1, 30, "COMMENTED", 1, "PR7-R001 — x"),
      review(2, 50, "CHANGES_REQUESTED", 2, "PR7-R009 — third party"),
      review(3, 20, "COMMENTED", 3, "PR7-R001 解消"),
    ]),
    { 30: ["PR7-R001"] },
  );
  // "解消" text, another reviewer's approval or a COMMENT never resolves.
  assert.deepEqual(
    run([
      review(1, 30, "COMMENTED", 1, "PR7-R001 — x"),
      review(2, 30, "COMMENTED", 2, "- PR7-R001 解消: fixed"),
      review(3, 40, "APPROVED", 3),
    ]),
    { 30: ["PR7-R001"] },
  );
  assert.deepEqual(
    run([
      review(1, 30, "COMMENTED", 1, "PR7-R001 — x"),
      review(2, 30, "APPROVED", 2),
    ]),
    {},
  );
});
test("R007 CHANGES_REQUESTED or DISMISSED without IDs is a finding; a dismissal never clears", () => {
  assert.deepEqual(
    run([
      review(1, 30, "CHANGES_REQUESTED", 1, "please fix"),
      review(2, 30, "COMMENTED", 2, "thanks"),
    ]),
    { 30: ["review:1"] },
  );
  assert.deepEqual(run([review(1, 30, "DISMISSED", 1, null)]), {
    30: ["review:1"],
  });
  // The approval itself was dismissed (by anyone): earlier findings are open again.
  assert.deepEqual(
    run([
      review(1, 30, "CHANGES_REQUESTED", 1, "PR7-R002 — y"),
      review(2, 30, "DISMISSED", 2),
    ]),
    { 30: ["PR7-R002", "review:2"] },
  );
  assert.deepEqual(
    run([review(1, 30, "DISMISSED", 1), review(2, 30, "APPROVED", 2)]),
    {},
  );
});
test("R007 every assigned line comment is a finding; edits fail closed; ties and the approving review keep it", () => {
  assert.deepEqual(
    run(
      [review(1, 30, "APPROVED", 5)],
      [
        line(10, 30, 1, "nit without id"),
        line(11, 30, 6, "PR7-R003 — after approval"),
        line(12, 30, 7, "reply", { in_reply_to_id: 11 }),
        line(13, 50, 8, "third party"),
      ],
    ),
    { 30: ["PR7-R003", "comment:12"] },
  );
  // Edited after the approval (by anyone with write access): kept at its update time.
  assert.deepEqual(
    run(
      [review(1, 30, "APPROVED", 5)],
      [line(10, 30, 1, "PR7-R004 — y", { updated_at: at(9) })],
    ),
    { 30: ["PR7-R004", "comment:10"] },
  );
  // Same timestamp as the approval: not resolved. A comment of the approving review itself: not resolved.
  assert.deepEqual(
    run([review(1, 30, "APPROVED", 5)], [line(10, 30, 5, "tie")]),
    { 30: ["comment:10"] },
  );
  assert.deepEqual(
    run(
      [review(1, 30, "APPROVED", 9)],
      [line(10, 30, 1, "inside", { pull_request_review_id: 1 })],
    ),
    { 30: ["comment:10"] },
  );
  assert.deepEqual(
    run(
      [review(1, 30, "APPROVED", 9, "PR7-R005 — contradictory")],
      [line(10, 30, 1, "before", { pull_request_review_id: 2 })],
    ),
    { 30: ["PR7-R005"] },
  );
});
test("R007 malformed evidence of an assigned reviewer stops the collection", () => {
  assert.throws(
    () => run([{ id: 1, user: { id: 30 }, state: "COMMENTED", body: "x" }]),
    EvidenceError,
  );
  assert.throws(
    () => run([], [{ ...line(10, 30, 1, "x"), created_at: "never" }]),
    EvidenceError,
  );
  assert.throws(() => run([], [{ ...line(10, 30, 1, "x"), body: 5 }]), EvidenceError);
  assert.throws(() => run([{ id: 1, state: "APPROVED" }]), EvidenceError);
  assert.throws(() => run([], [], [{ ...talk(60, 30, 1, "x"), created_at: 5 }]), EvidenceError);
  // Third-party malformed rows are skipped only after the identity check.
  assert.deepEqual(run([{ ...review(1, 50, "COMMENTED", 1), submitted_at: null }]), {});
});

test("R007 conversation comments of an assigned reviewer raise IDs or a non-accepted decision; edits fail closed", () => {
  assert.deepEqual(
    run(
      [review(1, 30, "APPROVED", 5)],
      [],
      [
        talk(60, 30, 6, "decision: changes-requested\nmore work needed"),
        talk(61, 30, 7, "PR7-R010 — after approval"),
        talk(62, 30, 8, "decision: accepted\nall good"),
        talk(63, 30, 9, "thanks"),
        talk(64, 50, 9, "decision: changes-requested (third party)"),
        talk(65, 20, 9, "PR7-R011 — the author"),
      ],
    ),
    { 30: ["PR7-R010", "issue:60"] },
  );
  assert.deepEqual(
    run([review(1, 30, "APPROVED", 5)], [], [talk(60, 30, 1, "fine", { updated_at: at(9) })]),
    { 30: ["issue:60"] },
  );
  assert.deepEqual(run([review(1, 30, "APPROVED", 9)], [], [talk(60, 30, 1, "decision: needs-owner")]), {});
});
test("R007 only an approval of the current head resolves; an older-commit approval does not", () => {
  assert.deepEqual(
    run([review(1, 30, "CHANGES_REQUESTED", 1, "PR7-R001 — x"), review(2, 30, "APPROVED", 2, "", OLD)]),
    { 30: ["PR7-R001"] },
  );
});
test("R007 an owner's CHANGES_REQUESTED raises but only the owner's own later approval resolves it", () => {
  assert.deepEqual(
    run([review(1, 10, "CHANGES_REQUESTED", 1, "stop"), review(2, 30, "APPROVED", 2), review(3, 10, "COMMENTED", 3, "PR7-R020 — prose only")]),
    { 10: ["review:1"] },
  );
  assert.deepEqual(run([review(1, 10, "CHANGES_REQUESTED", 1), review(2, 10, "APPROVED", 2)]), {});
});
test("R007 persisted observation: a deleted or edited item raises deleted:/edited: until a later approval", () => {
  const first = result([review(1, 30, "COMMENTED", 1, "PR7-R001 — x")], [line(10, 30, 2, "PR7-R002 — y")]);
  assert.deepEqual(first.items.map((r) => r.item).sort(), ["comment:10", "review:1"]);
  assert.deepEqual(first.items.find((r) => r.item === "review:1")!.ids, ["PR7-R001"]);
  // The line comment is deleted and the Review body loses its ID (REST shows no edit time for Reviews).
  const second = result([review(1, 30, "COMMENTED", 1, "nothing here")], [], [], {
    items: first.items,
    observedAt: Date.parse(at(50)),
  });
  assert.deepEqual(second.changes.map((c) => `${c.change}:${c.item}`).sort(), ["deleted:comment:10", "edited:review:1"]);
  assert.deepEqual(Object.fromEntries(second.open), { 30: ["deleted:comment:10", "edited:review:1"] });
  // Recorded changes persist (no duplicates) and are resolved only by a later current-head approval.
  const memory = { items: first.items, changes: second.changes, observedAt: Date.parse(at(60)) };
  const third = result([review(1, 30, "COMMENTED", 1, "nothing here")], [], [], memory);
  assert.deepEqual(third.changes, []);
  assert.deepEqual(Object.fromEntries(third.open), { 30: ["deleted:comment:10", "edited:review:1"] });
  const stale = result([review(1, 30, "COMMENTED", 1, "nothing here"), review(2, 30, "APPROVED", 55, "", OLD)], [], [], memory);
  assert.deepEqual(Object.fromEntries(stale.open), { 30: ["deleted:comment:10", "edited:review:1"] });
  const early = result([review(1, 30, "COMMENTED", 1, "nothing here"), review(2, 30, "APPROVED", 40)], [], [], memory);
  assert.deepEqual(Object.fromEntries(early.open), { 30: ["deleted:comment:10", "edited:review:1"] });
  const later = result([review(1, 30, "COMMENTED", 1, "nothing here"), review(2, 30, "APPROVED", 70)], [], [], memory);
  assert.deepEqual(Object.fromEntries(later.open), {});
  // A further edit raises a new record even after that approval.
  const again = result([review(1, 30, "COMMENTED", 1, "edited twice"), review(2, 30, "APPROVED", 70)], [], [], {
    ...memory,
    observedAt: Date.parse(at(80)),
  });
  assert.equal(again.changes.length, 1);
  assert.deepEqual(Object.fromEntries(again.open), { 30: ["edited:review:1"] });
});

test("W4 row 13: an edit back to an earlier body is a new change, compared with the latest known body", () => {
  const A = "PR7-R001 — original",
    B = "rewritten without the ID";
  const first = result([review(1, 30, "COMMENTED", 1, A)], [line(10, 30, 2, A)]);
  let changes: ChangeRecord[] = [];
  const observe = (body: string, second: number, comment = body, updated = second) => {
    const r = result([review(1, 30, "COMMENTED", 1, body), review(2, 30, "APPROVED", second - 1)], [line(10, 30, 2, comment, { updated_at: at(updated) })], [], {
      items: first.items,
      changes,
      observedAt: Date.parse(at(second)),
    });
    changes = [...changes, ...r.changes];
    return r;
  };
  // A -> B: one edit per item. B again: nothing new.
  assert.equal(observe(B, 10, B, 9).changes.length, 2);
  assert.equal(observe(B, 20, B, 9).changes.length, 0);
  // B -> A (back to the first body): still an edit, raised after the approval at 29.
  const back = observe(A, 30, A, 29.5);
  assert.deepEqual(back.changes.map((c) => `${c.change}:${c.item}`).sort(), ["edited:comment:10", "edited:review:1"]);
  // The comment edited after the approval reopens its own ID too.
  assert.deepEqual(Object.fromEntries(back.open), { 30: ["PR7-R001", "comment:10", "edited:comment:10", "edited:review:1"] });
  // A -> B again: a third record each (same hashes as the first edit, different time and previous).
  const twice = observe(B, 40, B, 39.5);
  assert.equal(twice.changes.length, 2);
  assert.equal(changes.length, 6);
  // Repeating the same observation adds nothing.
  assert.equal(observe(B, 50, B, 39.5).changes.length, 0);
  // Every record names the hash it changed from.
  assert.ok(changes.every((c) => typeof c.previous === "string"));
});
