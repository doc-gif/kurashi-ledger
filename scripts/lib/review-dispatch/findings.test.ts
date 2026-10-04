import assert from "node:assert/strict";
import { test } from "node:test";
import { findingIds, unresolvedFindings } from "./findings.ts";
import { EvidenceError } from "./github.ts";

// Synthetic reviewers: 30 and 40 are assigned, 50 is a third party, 20 is the implementer.
const at = (s: number) =>
  new Date(Date.parse("2026-01-01T00:00:00Z") + s * 1000).toISOString();
const review = (
  id: number,
  user: number,
  state: string,
  second: number,
  body: string | null = "",
) => ({ id, user: { id: user }, state, submitted_at: at(second), body });
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
const run = (reviews: unknown[], comments: unknown[] = []) =>
  Object.fromEntries(
    unresolvedFindings(
      7,
      [30, 40],
      reviews as Record<string, unknown>[],
      comments as Record<string, unknown>[],
    ),
  );

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
  // Third-party malformed rows are skipped only after the identity check.
  assert.deepEqual(run([{ ...review(1, 50, "COMMENTED", 1), submitted_at: null }]), {});
});
