import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GhReader,
  EvidenceError,
  collect,
  bindReady,
  bindReview,
  ghTransport,
  type Response,
} from "./github.ts";
import {
  policy,
  HEAD,
  BASE,
  TREE,
} from "../../../tests/fixtures/review-dispatch.ts";
const response = (
  value: unknown,
  headers: Record<string, string> = {},
): Response => ({ status: 200, headers, body: JSON.stringify(value) });

test("I004 paginated evidence is complete, conditional ETag reuses only verified cache", async () => {
  let n = 0;
  const r = new GhReader("synthetic/repository", async (path, headers) => {
    n++;
    if (headers["If-None-Match"] === "tag")
      return { status: 304, headers: {}, body: "" };
    return path.endsWith("page=2")
      ? response([{ id: 2 }])
      : response([{ id: 1 }], {
          etag: "tag",
          link: '<https://api.github.com/repos/synthetic/repository/issues?page=2>; rel="next"',
        });
  });
  assert.deepEqual(await r.pages("issues?page=1"), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await r.pages("issues?page=1"), [{ id: 1 }, { id: 2 }]);
  assert.equal(n, 4);
});
for (const [name, reply] of [
  ["partial failure", { status: 500, headers: {}, body: "" }],
  ["rate limit", { status: 429, headers: {}, body: "" }],
  ["empty cache 304", { status: 304, headers: {}, body: "" }],
  ["malformed JSON", { status: 200, headers: {}, body: "broken" }],
  [
    "untrusted next",
    {
      status: 200,
      headers: { link: '<https://untrusted.example/next>; rel="next"' },
      body: "[]",
    },
  ],
  [
    "cycle",
    {
      status: 200,
      headers: {
        link: '<https://api.github.com/repos/synthetic/repository/issues>; rel="next"',
      },
      body: "[]",
    },
  ],
] as const)
  test(`D05/I004 ${name} denies incomplete evidence`, async () => {
    const r = new GhReader("synthetic/repository", async () => reply);
    await assert.rejects(r.pages("issues"));
  });
test("I004 expired batch is discarded and missing token has no saved-auth fallback", async () => {
  let now = 0;
  const r = new GhReader(
    "synthetic/repository",
    async () => {
      now = 60000;
      return response([]);
    },
    () => now,
  );
  await assert.rejects(r.pages("issues"));
  assert.throws(() => ghTransport("", "/synthetic/gh"));
});
function fake(changed = false, fail = false): GhReader {
  let mainReads = 0;
  return new GhReader("synthetic/repository", async (endpoint) => {
    const path = endpoint.replace("/repos/synthetic/repository/", "");
    if (path === "branches/main") {
      mainReads++;
      return response({
        commit: { sha: changed && mainReads > 1 ? "d".repeat(40) : BASE },
      });
    }
    if (path === "pulls/1")
      return response({
        head: { sha: HEAD, ref: "synthetic-branch", repo: { id: 1 } },
        base: { sha: BASE, ref: "main", repo: { id: 1 } },
        state: "open",
        draft: false,
        labels: [],
        user: { id: 20 },
      });
    if (path.startsWith("contents/")) return response({ sha: "f".repeat(40) });
    if (path.startsWith("compare/"))
      return response({ merge_base_commit: { sha: BASE } });
    if (path === "git/commits/" + HEAD)
      return response({ tree: { sha: TREE } });
    if (path === "git/commits/" + "e".repeat(40))
      return response({
        tree: { sha: TREE },
        parents: [{ sha: BASE }, { sha: HEAD }],
      });
    if (path.startsWith("issues/1/timeline"))
      return response([
        {
          id: 1,
          event: "ready_for_review",
          actor: { id: 20 },
          created_at: "2026-01-01T00:00:00Z",
        },
      ]);
    if (path.startsWith("actions/runs?"))
      return response({
        workflow_runs: [
          { id: 2, name: "CI", head_sha: HEAD, conclusion: "success" },
        ],
      });
    if (path.startsWith("actions/runs/2/jobs"))
      return response({
        jobs: [{ id: 3, name: "Quality gate", conclusion: "success" }],
      });
    if (path === "actions/jobs/3/logs")
      return {
        status: 200,
        headers: {},
        body: "TESTED_SHA: " + "e".repeat(40),
      };
    if (path.includes("check-runs")) return response({ check_runs: [] });
    if (fail && path.startsWith("pulls/1/comments"))
      return { status: 500, headers: {}, body: "" };
    return response([]);
  });
}
test("D04 collection uses fresh main before/after; timeline without proved pair remains unknown", async () => {
  const p = policy(),
    options = {
      requiredJobs: ["Quality gate"],
      ready: [],
      pushers: [20],
      historyComplete: true,
      faultfinding: null,
      unresolvedDesign: [],
    };
  const c = await collect(fake(), p, 1, options);
  assert.equal(c.snapshot.complete, true);
  assert.deepEqual(c.snapshot.testedParents, [BASE, HEAD]);
  assert.equal(c.snapshot.history[0]!.pair, null);
  assert.equal(
    (await collect(fake(true), p, 1, options)).snapshot.complete,
    false,
  );
  await assert.rejects(
    collect(fake(false, true), p, 1, options),
    EvidenceError,
  );
});
test("D06 authenticated sender must match re-fetched Ready event actor/time and exact pair", async () => {
  const c = await collect(fake(), policy(), 1, {
    requiredJobs: ["Quality gate"],
    ready: [],
    pushers: null,
    historyComplete: false,
    faultfinding: null,
    unresolvedDesign: [],
  });
  const payload = {
    action: "ready_for_review",
    sender: { id: 20 },
    pull_request: {
      updated_at: "2026-01-01T00:00:00Z",
      head: { sha: HEAD },
      base: { sha: BASE },
    },
  };
  assert.equal(bindReady(payload, c)?.id, "timeline:1");
  assert.equal(bindReady({ ...payload, sender: { id: 40 } }, c), null);
  assert.equal(
    bindReady(
      {
        ...payload,
        pull_request: {
          ...payload.pull_request,
          head: { sha: "d".repeat(40) },
        },
      },
      c,
    ),
    null,
  );
});

test("D01/D06 native human review binds only authenticated establishment pair and current review state", async () => {
  const c = await collect(fake(), policy(), 1, {
    requiredJobs: ["Quality gate"],
    ready: [],
    pushers: null,
    historyComplete: false,
    faultfinding: null,
    unresolvedDesign: [],
  });
  const review = {
    id: 7,
    user: { id: 40 },
    commit_id: HEAD,
    state: "APPROVED",
    submitted_at: "2026-01-01T00:00:01Z",
  };
  c.reviews.push(review);
  const payload = {
    action: "submitted",
    sender: { id: 40 },
    review,
    pull_request: { head: { sha: HEAD }, base: { sha: BASE } },
  };
  assert.deepEqual(bindReview(payload, c)?.pair, { head: HEAD, base: BASE });
  assert.equal(bindReview({ ...payload, sender: { id: 20 } }, c), null);
  c.reviews[0]!["state"] = "DISMISSED";
  assert.equal(
    bindReview({ ...payload, review: { ...review, state: "APPROVED" } }, c),
    null,
  );
});
