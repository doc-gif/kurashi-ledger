import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CI_TRUST_PATHS,
  GhReader,
  REQUIRED_JOBS,
  ciTrustDigest,
  type Transport,
} from "./github.ts";
import { reconcile } from "./evidence.ts";
import { Store } from "./store.ts";
import { ingest } from "./webhook.ts";
import { createHmac } from "node:crypto";
import { accepted, assess, reviewerEligible } from "./reducer.ts";
import {
  policy,
  database,
  HEAD,
  BASE,
  TREE,
} from "../../../tests/fixtures/review-dispatch.ts";

const BASE_TREE = "6".repeat(40);
// Synthetic repository files: inside the CI trust unit, test contents inside it, and outside it.
const FILES: Record<string, string> = {
  ".github/workflows/ci.yml": "1".repeat(40),
  ".github/PULL_REQUEST_TEMPLATE.md": "2".repeat(40),
  ".npmrc": "a4".repeat(20),
  "package.json": "3".repeat(40),
  "tools/review_guard/guard.py": "4".repeat(40),
  "tools/review_guard/tests/test_guard.py": "5".repeat(40),
  "scripts/check-test-skips.ts": "7".repeat(40),
  "scripts/lib/test-skips.ts": "8".repeat(40),
  "scripts/lib/test-skips.test.ts": "9".repeat(40),
  "scripts/other.ts": "a1".repeat(20),
  "docs/development.md": "a2".repeat(20),
  "tests/unit/sample.test.ts": "a3".repeat(20),
};
type Listing = { path: string; mode: string; type: string; sha: string }[];
function listing(changes: Record<string, string | null> = {}): Listing {
  const files = { ...FILES, ...changes };
  return Object.entries(files)
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([path, sha]) => ({ path, mode: "100644", type: "blob", sha }));
}
const t = (seconds: number) =>
  new Date(Date.parse("2026-01-01T00:00:00Z") + seconds * 1000).toISOString();
function fixture() {
  const state = {
    now: 2,
    ready: false,
    review: false,
    fail: false,
    base: BASE,
    head: HEAD,
    pusher: 20,
    legacy: false,
    headFiles: {} as Record<string, string | null>,
    reviewBody: null as string | null,
    lineComments: [] as Record<string, unknown>[],
    conversation: [] as Record<string, unknown>[],
  };
  const send: Transport = async (endpoint) => {
    const path = endpoint.replace("/repos/synthetic/repository/", "");
    let value: unknown = [];
    if (path === "branches/main") value = { commit: { sha: state.base } };
    else if (path === "pulls/1")
      value = {
        number: 1,
        head: { sha: state.head, ref: "branch", repo: { id: 1 } },
        base: { sha: state.base, ref: "main", repo: { id: 1 } },
        state: "open",
        draft: false,
        labels: [],
        user: { id: 20 },
        commits: 0,
      };
    else if (path.startsWith("compare/"))
      value = { merge_base_commit: { sha: state.base } };
    else if (path === `git/commits/${state.head}`)
      value = { tree: { sha: TREE } };
    else if (path === `git/commits/${state.base}`)
      value = { tree: { sha: BASE_TREE } };
    else if (path === `git/trees/${TREE}?recursive=1`)
      value = { truncated: false, tree: listing(state.headFiles) };
    else if (path === `git/trees/${BASE_TREE}?recursive=1`)
      value = { truncated: false, tree: listing() };
    else if (path === `git/commits/${"e".repeat(40)}`)
      value = {
        tree: { sha: TREE },
        parents: [{ sha: state.base }, { sha: state.head }],
      };
    else if (path.startsWith("activity?"))
      value = [
        {
          id: 1,
          ref: "refs/heads/branch",
          actor: { id: state.pusher },
          before: "0".repeat(40),
          after: state.head,
          timestamp: t(1),
          activity_type: "push",
        },
      ];
    else if (path.startsWith("issues/1/timeline"))
      value = state.ready
        ? [
            {
              id: 7,
              event: "ready_for_review",
              actor: { id: 20 },
              created_at: t(3),
            },
          ]
        : [];
    else if (path.startsWith("pulls/1/reviews"))
      value = state.review
        ? [
            {
              id: 9,
              user: { id: 30 },
              state: "APPROVED",
              commit_id: state.head,
              submitted_at: t(4),
              body: state.reviewBody,
            },
          ]
        : [];
    else if (path.startsWith("pulls/1/comments") && !state.fail)
      value = state.lineComments;
    else if (path.startsWith("issues/1/comments"))
      value = [
        ...(state.legacy
          ? [
              {
                id: 11,
                user: { id: 20 },
                body: `<!-- kurashi-ledger:handoff:v1 -->\nworker_status: ready-for-review\nhead_sha: ${state.head}\nbase_sha: ${state.base}`,
              },
            ]
          : []),
        ...state.conversation,
      ];
    else if (path.startsWith("actions/runs?"))
      value = {
        total_count: 1,
        workflow_runs: [
          {
            id: 2,
            name: "CI",
            path: ".github/workflows/ci.yml",
            head_sha: state.head,
            conclusion: "success",
          },
        ],
      };
    else if (path.startsWith("actions/runs/2/jobs"))
      value = {
        total_count: REQUIRED_JOBS.length,
        jobs: REQUIRED_JOBS.map((name, i) => ({
          id: i + 3,
          name,
          conclusion: "success",
        })),
      };
    else if (path === "actions/jobs/3/logs")
      return {
        status: 200,
        headers: { date: t(state.now) },
        body: "TESTED_SHA: " + "e".repeat(40),
      };
    else if (path.includes("check-runs"))
      value = { total_count: 0, check_runs: [] };
    if (state.fail && path.startsWith("pulls/1/comments"))
      return { status: 500, headers: {}, body: "" };
    return {
      status: 200,
      headers: { date: t(state.now) },
      body: JSON.stringify(value),
    };
  };
  return {
    state,
    reader: () => new GhReader("synthetic/repository", send),
    send,
  };
}
function delivery(ready = true) {
  return {
    repository: { id: 1 },
    installation: { id: 2 },
    sender: { id: ready ? 20 : 30 },
    action: ready ? "ready_for_review" : "submitted",
    pull_request: {
      number: 1,
      updated_at: t(3),
      head: { sha: HEAD },
      base: { sha: BASE },
    },
    ...(ready
      ? {}
      : {
          review: {
            id: 9,
            user: { id: 30 },
            state: "APPROVED",
            commit_id: HEAD,
            submitted_at: t(4),
          },
        }),
  };
}
test("R004 signed Inbox -> gh binding -> acceptance and tombstone is atomic, replay-safe across restart", async () => {
  const d = database(),
    f = fixture(),
    p = policy();
  try {
    f.state.now = 5;
    f.state.ready = true;
    f.state.review = true;
    for (const [event, name, payload, now] of [
      ["pull_request_review", "review-delivery", delivery(false), 1],
      ["pull_request", "ready-delivery", delivery(), 2],
    ] as const) {
      const secret = Buffer.alloc(32, 9),
        raw = Buffer.from(JSON.stringify(payload));
      assert.equal(
        ingest(
          p,
          d.store,
          secret,
          {
            "x-hub-signature-256":
              "sha256=" +
              createHmac("sha256", secret).update(raw).digest("hex"),
            "x-github-event": event,
            "x-github-delivery": name,
          },
          raw,
          now,
        ),
        202,
      );
    }
    const result = (await reconcile(f.reader(), p, d.store))[0]!;
    assert.equal(assess(p, result.snapshot, null).status, "eligible");
    assert.deepEqual(result.snapshot.reviews[0]!.pair, {
      head: HEAD,
      base: BASE,
    });
    assert.equal(d.store.pendingInbox().length, 0);
    assert.equal(
      d.store.db.prepare("SELECT count(*) n FROM acceptance").get()!["n"],
      1,
    );
    d.store.close();
    const restarted = new Store(d.root);
    try {
      assert.equal(
        restarted.inbox(
          3,
          "ready-delivery",
          "pull_request",
          JSON.stringify(delivery()),
          3,
        ),
        false,
      );
      const again = (await reconcile(f.reader(), p, restarted))[0]!;
      assert.equal(assess(p, again.snapshot, null).status, "eligible");
      assert.equal(restarted.evidence("1:1", "ready").length, 1);
    } finally {
      restarted.close();
    }
  } finally {
    d.cleanup();
  }
});
test("R004 missing webhook recovers Ready and human native Review only in persisted stable server window", async () => {
  const d = database(),
    f = fixture(),
    p = policy();
  try {
    await reconcile(f.reader(), p, d.store);
    f.state.ready = true;
    f.state.review = true;
    f.state.now = 5;
    const s = (await reconcile(f.reader(), p, d.store))[0]!.snapshot;
    assert.equal(assess(p, s, null).status, "eligible");
    assert.deepEqual(s.reviews[0]!.pair, { head: HEAD, base: BASE });
    assert.equal(d.store.evidence("1:1", "ready").length, 1);
  } finally {
    d.cleanup();
  }
});
test("R004 old timeline first seen, main change, missing activity and partial page cannot manufacture a binding", async () => {
  for (const failure of ["first", "base", "activity", "page"] as const) {
    const d = database(),
      f = fixture(),
      p = policy();
    try {
      if (failure !== "first") await reconcile(f.reader(), p, d.store);
      f.state.ready = true;
      f.state.review = true;
      f.state.now = 5;
      if (failure === "base") f.state.base = "d".repeat(40);
      if (failure === "page") f.state.fail = true;
      const reader =
        failure === "activity"
          ? new GhReader(p.repo, async (path, h) =>
              path.includes("/activity?")
                ? { status: 200, headers: { date: t(5) }, body: "[]" }
                : f.send(path, h),
            )
          : f.reader();
      if (failure === "page")
        await assert.rejects(reconcile(reader, p, d.store));
      else await reconcile(reader, p, d.store);
      assert.equal(d.store.evidence("1:1", "ready").length, 0);
      assert.equal(d.store.evidence("1:1", "review").length, 0);
    } finally {
      d.cleanup();
    }
  }
});
test("R004 failure during persistence rolls back binding and processed flag together; later complete retry recovers", async () => {
  const d = database(),
    f = fixture(),
    p = policy();
  try {
    f.state.ready = true;
    f.state.now = 5;
    d.store.inbox(
      3,
      "transaction",
      "pull_request",
      JSON.stringify(delivery()),
      1,
    );
    const original = d.store.saveObservation.bind(d.store);
    d.store.saveObservation = () => {
      throw new Error("disk fault");
    };
    await assert.rejects(reconcile(f.reader(), p, d.store));
    assert.equal(d.store.evidence("1:1", "ready").length, 0);
    assert.equal(d.store.pendingInbox().length, 1);
    d.store.saveObservation = original;
    await reconcile(f.reader(), p, d.store);
    assert.equal(d.store.evidence("1:1", "ready").length, 1);
    assert.equal(d.store.pendingInbox().length, 0);
  } finally {
    d.cleanup();
  }
});
test("R004 activity actor proves pusher independence; owner anchor requires API-visible continuous suffix", async () => {
  const d = database(),
    f = fixture(),
    p = policy();
  try {
    f.state.pusher = 30;
    f.state.ready = true;
    f.state.now = 5;
    d.store.inbox(3, "ready", "pull_request", JSON.stringify(delivery()), 1);
    const s = (await reconcile(f.reader(), p, d.store))[0]!.snapshot;
    assert.deepEqual(s.pushers, [30]);
    assert.equal(reviewerEligible(p, s, 30), false);
    p.targets[0]!.identity = {
      activity: "missing-anchor",
      head: HEAD,
      at: Date.parse(t(1)),
      pushers: [20],
    };
    const unknown = (await reconcile(f.reader(), p, d.store))[0]!.snapshot;
    assert.equal(unknown.historyComplete, false);
    assert.equal(unknown.pushers, null);
  } finally {
    d.cleanup();
  }
});
test("R004 shadow stores exact pair and legacy-v1 disagreement; comparison never grants authority", async () => {
  const d = database(),
    f = fixture(),
    p = policy();
  p.mode = "shadow";
  try {
    f.state.legacy = true;
    const r = (await reconcile(f.reader(), p, d.store))[0]!;
    assert.equal(r.observation.legacyReady, true);
    assert.equal(r.observation.differs, true);
    assert.equal(assess(p, r.snapshot, null).status, "waiting");
    assert.deepEqual(d.store.observation("1:1"), r.observation);
    assert.equal(
      d.store.db.prepare("SELECT count(*) n FROM jobs").get()!["n"],
      0,
    );
  } finally {
    d.cleanup();
  }
});

test("R005 real daemon -> Node shadow -> fake gh composition uses reduced token, absolute gh and no other auth", async () => {
  if (process.platform === "win32") {
    const { main } = await import("../../review-dispatch.ts");
    await assert.rejects(main(["shadow", "--root", "relative"], {}, () => {}));
    return;
  }
  const { writeFileSync, chmodSync, rmSync } = await import("node:fs"),
    { spawnSync } = await import("node:child_process"),
    { resolve, join, dirname } = await import("node:path");
  const d = database(),
    f = fixture(),
    p = policy();
  p.mode = "shadow";
  try {
    const prefix = "/repos/synthetic/repository/",
      paths = [
        "branches/main",
        "pulls/1",
        `compare/${BASE}...${HEAD}`,
        "issues/1/timeline?per_page=100",
        "pulls/1/reviews?per_page=100",
        "issues/1/comments?per_page=100",
        "activity?ref=refs%2Fheads%2Fbranch&per_page=100",
        "pulls/1/comments?per_page=100",
        "pulls/1/commits?per_page=100",
        `commits/${HEAD}/check-runs?per_page=100`,
        `commits/${HEAD}/statuses?per_page=100`,
        `actions/runs?head_sha=${HEAD}&event=pull_request&per_page=100`,
        `git/commits/${BASE}`,
        `git/trees/${BASE_TREE}?recursive=1`,
        `git/trees/${TREE}?recursive=1`,
        `git/commits/${HEAD}`,
        "actions/runs/2/jobs?filter=latest&per_page=100",
        "actions/jobs/3/logs",
        `git/commits/${"e".repeat(40)}`,
      ];
    const map: Record<string, unknown> = {};
    for (const path of paths)
      map[prefix + path] = await f.send(prefix + path, {});
    // PR48-R011: a lost oversized delivery is reported once by event name and count, without its ID.
    d.store.oversized(3, "synthetic-oversized-delivery", "pull_request", 1);
    const gh = join(d.root, "fake-gh"),
      flag = join(d.root, "gh-boundary.json"),
      file = join(d.root, "policy.json");
    writeFileSync(file, JSON.stringify(p));
    writeFileSync(
      gh,
      `#!${process.execPath}\nconst fs=require('node:fs'); const map=${JSON.stringify(map)}; fs.writeFileSync(${JSON.stringify(flag)},JSON.stringify({token:process.env.GH_TOKEN==='synthetic-read',other:!!process.env.GITHUB_TOKEN,hooks:!!process.env.NODE_OPTIONS})); const path=process.argv.find(a=>a.startsWith('/repos/')); const r=map[path];if(!r)process.exit(2);process.stdout.write('HTTP/1.1 '+r.status+' OK\\nDate: '+r.headers.date+'\\n\\n'+r.body);`,
    );
    chmodSync(gh, 0o700);
    const py = spawnSync(
      "python3",
      ["-c", "import sys; print(sys.executable)"],
      { encoding: "utf8" },
    );
    assert.equal(py.status, 0);
    const command = [
      resolve("tools/review_dispatch/supervisor.py"),
      "daemon",
      "--root",
      d.root,
      "--",
      process.execPath,
      resolve("scripts/review-dispatch.ts"),
      "shadow",
      "--root",
      d.root,
      "--policy",
      file,
      "--gh",
      gh,
    ];
    const result = spawnSync(py.stdout.trim(), command, {
      encoding: "utf8",
      timeout: 15000,
      env: {
        PATH: process.env.PATH!,
        GH_TOKEN: "synthetic-read",
        GITHUB_TOKEN: "forbidden",
        NODE_OPTIONS: "forbidden",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /new-ready-required/);
    assert.match(result.stdout, /大きすぎて保存できない配送がありました（pull_request、1件）/);
    assert.doesNotMatch(result.stdout, /synthetic-oversized-delivery/);
    assert.deepEqual(d.store.drainOversized(), []);
    const { readFileSync } = await import("node:fs");
    assert.deepEqual(JSON.parse(readFileSync(flag, "utf8")), {
      token: true,
      other: false,
      hooks: false,
    });
    const row = d.store.observation<import("./evidence.ts").Observation>("1:1");
    assert.ok(row);
    assert.equal(row.historyComplete, true);
    rmSync(
      join(
        dirname(d.root),
        `.kurashi-dispatch-${(await import("./model.ts")).hash(d.root)}.lock`,
      ),
      { force: true },
    );
  } finally {
    d.cleanup();
  }
});

test("R004 force-push activity gap or same-time ambiguity denies completeness instead of author inference", async () => {
  for (const before of ["d".repeat(40), HEAD]) {
    const d = database(),
      f = fixture(),
      p = policy();
    try {
      const transport: Transport = async (path, h) => {
        const r = await f.send(path, h);
        if (!path.includes("/activity?")) return r;
        const rows = JSON.parse(r.body);
        rows.push({
          id: 2,
          ref: "refs/heads/branch",
          actor: { id: 30 },
          before,
          after: HEAD,
          timestamp: t(before === HEAD ? 1 : 2),
          activity_type: "force_push",
        });
        return { ...r, body: JSON.stringify(rows) };
      };
      const s = (
        await reconcile(new GhReader(p.repo, transport), p, d.store)
      )[0]!.snapshot;
      assert.equal(s.historyComplete, false);
      assert.equal(s.pushers, null);
    } finally {
      d.cleanup();
    }
  }
});
test("R004 native opened delivery binds only proven non-Draft creation pair and actor", async () => {
  const { collect, bindReady } = await import("./github.ts"),
    f = fixture(),
    p = policy();
  const transport: Transport = async (path, h) => {
    const r = await f.send(path, h);
    if (path.endsWith("/pulls/1")) {
      const pr = JSON.parse(r.body);
      return {
        ...r,
        body: JSON.stringify({ ...pr, id: 99, created_at: t(0) }),
      };
    }
    return r;
  };
  const c = await collect(new GhReader(p.repo, transport), p, 1, {
    requiredJobs: [],
    ready: [],
    pushers: null,
    historyComplete: false,
    faultfinding: null,
    unresolvedDesign: [],
  });
  const payload = {
    ...delivery(),
    action: "opened",
    pull_request: {
      ...delivery().pull_request,
      draft: false,
      created_at: t(0),
    },
  };
  assert.equal(bindReady(payload, c)?.id, "created:99:" + t(0));
  assert.equal(
    bindReady(
      { ...payload, pull_request: { ...payload.pull_request, draft: true } },
      c,
    ),
    null,
  );
  assert.equal(bindReady({ ...payload, sender: { id: 30 } }, c), null);
});

async function boundApproval(
  f: ReturnType<typeof fixture>,
  d: ReturnType<typeof database>,
  p: ReturnType<typeof policy>,
) {
  f.state.ready = true;
  f.state.review = true;
  f.state.now = 6;
  for (const [event, name, payload] of [
    ["pull_request_review", "review-delivery", delivery(false)],
    ["pull_request", "ready-delivery", delivery()],
  ] as const)
    d.store.inbox(3, name, event, JSON.stringify(payload), 1);
  return (await reconcile(f.reader(), p, d.store))[0]!;
}
test("R007 an assigned reviewer's later line finding blocks acceptance; third-party lines are reference only", async () => {
  const d = database(),
    f = fixture(),
    p = policy();
  try {
    f.state.lineComments = [
      {
        id: 21,
        user: { id: 30 },
        created_at: t(5),
        updated_at: t(5),
        body: "PR1-R001 — synthetic finding after approval",
        pull_request_review_id: 77,
      },
      {
        id: 22,
        user: { id: 50 },
        created_at: t(5),
        updated_at: t(5),
        body: "third party",
        pull_request_review_id: 78,
      },
    ];
    const r = await boundApproval(f, d, p),
      s = r.snapshot;
    assert.deepEqual(s.reviews.at(-1)!.findings, ["PR1-R001"]);
    assert.deepEqual(r.observation.findings, ["PR1-R001"]);
    const target = assess(p, s, null);
    assert.equal(target.status, "eligible");
    // The fault-finding source is R014 (out of W3); supply it to isolate the finding effect.
    s.faultfinding = { actor: 30, pair: { ...s.pair }, unresolved: [] };
    assert.equal(accepted(p, s, target), false);
    s.reviews.at(-1)!.findings = [];
    assert.equal(accepted(p, s, target), true);
  } finally {
    d.cleanup();
  }
});
test("R007 findings before the reviewer's approval are resolved by it", async () => {
  const d = database(),
    f = fixture(),
    p = policy();
  try {
    f.state.lineComments = [
      {
        id: 21,
        user: { id: 30 },
        created_at: t(2),
        updated_at: t(2),
        body: "PR1-R001 — fixed later",
        pull_request_review_id: 77,
      },
    ];
    const r = await boundApproval(f, d, p);
    assert.deepEqual(r.observation.findings, []);
    assert.deepEqual(r.snapshot.reviews[0]!.findings, []);
  } finally {
    d.cleanup();
  }
});
test("R008 a change to a CI-deciding file stays unknown until the owner trusts that exact digest", async () => {
  const change = { ".github/workflows/ci.yml": "c1".repeat(20) };
  const d = database(),
    f = fixture(),
    p = policy();
  try {
    f.state.ready = true;
    f.state.now = 5;
    f.state.headFiles = change;
    d.store.inbox(3, "ready", "pull_request", JSON.stringify(delivery()), 1);
    const untrusted = (await reconcile(f.reader(), p, d.store))[0]!;
    assert.equal(untrusted.observation.workflow, "untrusted");
    assert.equal(untrusted.snapshot.complete, false);
    assert.equal(assess(p, untrusted.snapshot, null).reason, "unknown-evidence");
    const main = ciTrustDigest(listing()),
      head = ciTrustDigest(listing(change));
    // Bound to main (owner decision 5978676604): the right head digest recorded against another main is not trusted.
    for (const record of [{ main: head, head: main }, { main: "f".repeat(64), head }]) {
      p.trustedCi = [record];
      const other = (await reconcile(f.reader(), p, d.store))[0]!;
      assert.equal(other.observation.workflow, "untrusted", JSON.stringify(record));
    }
    p.trustedCi = [{ main, head }];
    const trusted = (await reconcile(f.reader(), p, d.store))[0]!;
    assert.equal(trusted.observation.workflow, "trusted");
    assert.equal(trusted.snapshot.complete, true);
    // The Ready seen while CI was unknown is not bound afterwards: a new Ready is required (fail closed).
    assert.equal(assess(p, trusted.snapshot, null).reason, "new-ready-required");
    f.state.headFiles = {};
    const unchanged = (await reconcile(f.reader(), p, d.store))[0]!;
    assert.equal(unchanged.observation.workflow, "unchanged");
  } finally {
    d.cleanup();
  }
  // Trusted before the Ready arrives: the Ready binds and the PR becomes eligible.
  const e = database(),
    g = fixture(),
    q = policy();
  try {
    g.state.ready = true;
    g.state.now = 5;
    g.state.headFiles = change;
    q.trustedCi = [{ main: ciTrustDigest(listing()), head: ciTrustDigest(listing(change)) }];
    e.store.inbox(3, "ready", "pull_request", JSON.stringify(delivery()), 1);
    const r = (await reconcile(g.reader(), q, e.store))[0]!;
    assert.equal(r.observation.workflow, "trusted");
    assert.equal(assess(q, r.snapshot, null).status, "eligible");
  } finally {
    e.cleanup();
  }
});
test("R008 each trust path (and only those, without test contents) makes workflow trust unknown", async () => {
  const cases: [Record<string, string | null>, "unchanged" | "untrusted"][] = [
    [{ ".github/workflows/ci.yml": "c1".repeat(20) }, "untrusted"],
    [{ ".github/PULL_REQUEST_TEMPLATE.md": "c1".repeat(20) }, "untrusted"],
    [{ ".github/actions/new/action.yml": "c1".repeat(20) }, "untrusted"],
    [{ "package.json": "c1".repeat(20) }, "untrusted"],
    [{ "tools/review_guard/guard.py": "c1".repeat(20) }, "untrusted"],
    [{ "tools/review_guard/new_helper.py": "c1".repeat(20) }, "untrusted"],
    [{ "scripts/check-test-skips.ts": "c1".repeat(20) }, "untrusted"],
    [{ "scripts/lib/test-skips.ts": "c1".repeat(20) }, "untrusted"],
    [{ "scripts/lib/test-skips.ts": null }, "untrusted"],
    [{ "tools/review_guard/tests/test_guard.py": "c1".repeat(20) }, "unchanged"],
    [{ "scripts/lib/test-skips.test.ts": "c1".repeat(20) }, "unchanged"],
    [{ "scripts/other.ts": "c1".repeat(20) }, "unchanged"],
    [{ "docs/development.md": "c1".repeat(20) }, "untrusted"],
    [{ "docs/architecture.md": "c1".repeat(20) }, "unchanged"],
    [{ "tests/unit/sample.test.ts": "c1".repeat(20) }, "unchanged"],
    [{ "package.json.bak": "c1".repeat(20) }, "unchanged"],
    // W4 row 10 (owner decision 5977523656): npm's settings decide how CI installs.
    [{ ".npmrc": "c1".repeat(20) }, "untrusted"],
    [{ ".npmrc": null }, "untrusted"],
    [{ "docs/.npmrc": "c1".repeat(20) }, "unchanged"],
  ];
  for (const [change, expected] of cases) {
    const d = database(),
      f = fixture(),
      p = policy();
    try {
      f.state.headFiles = change;
      const r = (await reconcile(f.reader(), p, d.store))[0]!;
      assert.equal(r.observation.workflow, expected, JSON.stringify(change));
    } finally {
      d.cleanup();
    }
  }
  // A mode change (e.g. executable bit) of a trusted file is a change too.
  const modes = listing();
  modes.find((e) => e.path === "package.json")!.mode = "100755";
  assert.notEqual(ciTrustDigest(modes), ciTrustDigest(listing()));
  assert.deepEqual(CI_TRUST_PATHS, [
    ".github/",
    ".npmrc",
    "package.json",
    "tools/review_guard/",
    "scripts/check-test-skips.ts",
    "scripts/lib/test-skips.ts",
    "docs/development.md",
  ]);
});
test("R008 required jobs count only from the reviewed ci.yml path; a truncated tree or a removed .github is not trusted", async () => {
  for (const variant of ["other-path", "truncated", "no-github"] as const) {
    const d = database(),
      f = fixture(),
      p = policy();
    try {
      f.state.ready = true;
      f.state.now = 5;
      d.store.inbox(3, "ready", "pull_request", JSON.stringify(delivery()), 1);
      const transport: Transport = async (path, h) => {
        const r = await f.send(path, h);
        if (variant === "other-path" && path.includes("/actions/runs?")) {
          const v = JSON.parse(r.body);
          v.workflow_runs[0].path = ".github/workflows/added.yml";
          return { ...r, body: JSON.stringify(v) };
        }
        if (variant !== "other-path" && path.endsWith(`/git/trees/${TREE}?recursive=1`)) {
          const v = JSON.parse(r.body);
          if (variant === "truncated") v.truncated = true;
          else v.tree = v.tree.filter((e: { path: string }) => !e.path.startsWith(".github/"));
          return { ...r, body: JSON.stringify(v) };
        }
        return r;
      };
      const reader = new GhReader(p.repo, transport);
      if (variant === "truncated") {
        await assert.rejects(reconcile(reader, p, d.store));
        assert.equal(d.store.pendingInbox().length, 1);
        continue;
      }
      const r = (await reconcile(reader, p, d.store))[0]!;
      if (variant === "other-path") {
        assert.deepEqual(r.snapshot.ci, []);
        assert.equal(assess(p, r.snapshot, null).reason, "ci-not-proven");
      } else {
        assert.equal(r.observation.workflow, "untrusted");
        assert.equal(assess(p, r.snapshot, null).reason, "unknown-evidence");
      }
    } finally {
      d.cleanup();
    }
  }
});
test("R007 a conversation comment after approval blocks; a deleted line finding is remembered across reconciles", async () => {
  const d = database(),
    f = fixture(),
    p = policy();
  try {
    f.state.conversation = [
      {
        id: 31,
        user: { id: 30 },
        created_at: t(5),
        updated_at: t(5),
        body: "decision: changes-requested\nsynthetic conversation finding",
      },
    ];
    f.state.lineComments = [
      {
        id: 21,
        user: { id: 30 },
        created_at: t(5),
        updated_at: t(5),
        body: "PR1-R002 — synthetic line finding",
        pull_request_review_id: 77,
      },
    ];
    const first = await boundApproval(f, d, p);
    assert.deepEqual(first.observation.findings, ["PR1-R002", "issue:31"]);
    assert.equal(d.store.evidence("1:1", "item").length, 3);
    // Someone with write access deletes both comments: the deletions are recorded and still block.
    f.state.conversation = [];
    f.state.lineComments = [];
    f.state.now = 8;
    const second = (await reconcile(f.reader(), p, d.store))[0]!;
    assert.deepEqual(second.observation.findings, ["deleted:comment:21", "deleted:issue:31"]);
    assert.equal(d.store.evidence("1:1", "itemchange").length, 2);
    const third = (await reconcile(f.reader(), p, d.store))[0]!;
    assert.deepEqual(third.observation.findings, ["deleted:comment:21", "deleted:issue:31"]);
    assert.equal(d.store.evidence("1:1", "itemchange").length, 2);
  } finally {
    d.cleanup();
  }
});

test("W4 row 8: a signed edit/delete delivery raises a change the next reconcile could not see, and clears its mark", async () => {
  const d = database(),
    f = fixture(),
    p = policy();
  try {
    await boundApproval(f, d, p);
    // A reviewer's conversation comment written and deleted between two reconciles (never observed),
    // a reviewer's line comment edited, and a third party's deletion (reference only).
    const signal = (delivery: string, event: string, action: string, thing: Record<string, unknown>) =>
      d.store.inbox(
        3,
        delivery,
        event,
        JSON.stringify({
          repository: { id: 1 },
          installation: { id: 2 },
          sender: { id: 10 },
          action,
          ...(event === "issue_comment" ? { issue: { number: 1, pull_request: {} } } : { pull_request: { number: 1 } }),
          ...(event === "pull_request_review" ? { review: thing } : { comment: thing }),
        }),
        Date.parse(t(7)),
        "1:1",
      );
    signal("s1", "issue_comment", "deleted", { id: 55, user: { id: 30 }, body: "PR1-R009 hidden" });
    signal("s2", "pull_request_review_comment", "edited", { id: 56, user: { id: 30 }, body: "changed", updated_at: t(7) });
    signal("s3", "issue_comment", "deleted", { id: 57, user: { id: 99 }, body: "third party" });
    signal("s4", "pull_request_review", "dismissed", { id: 9, user: { id: 30 }, body: "" });
    assert.equal(d.store.marked("1:1"), true);
    f.state.now = 8;
    const r = (await reconcile(f.reader(), p, d.store))[0]!;
    assert.deepEqual(r.observation.findings, ["deleted:issue:55", "edited:comment:56"]);
    assert.equal(d.store.marked("1:1"), false);
    // Persisted once; the next reconcile neither duplicates nor forgets them.
    assert.equal(d.store.evidence("1:1", "itemchange").length, 2);
    f.state.now = 9;
    const again = (await reconcile(f.reader(), p, d.store))[0]!;
    assert.deepEqual(again.observation.findings, ["deleted:issue:55", "edited:comment:56"]);
    assert.equal(d.store.evidence("1:1", "itemchange").length, 2);
  } finally {
    d.cleanup();
  }
});

test("W4 faultfinding evidence in the snapshot is the dispatcher's own posted red-team record for this pair", async () => {
  const d = database(),
    f = fixture(),
    p = policy();
  try {
    const first = await boundApproval(f, d, p);
    assert.equal(first.snapshot.faultfinding, null);
    d.store.observe(assess(p, first.snapshot, null));
    const j = d.store.claim(p, first.snapshot, 30, "faultfinding", Date.parse(t(6)))!;
    assert.ok(j);
    const id = d.store.outbox(j, "faultfinding", JSON.stringify({ actor: 30, decision: "accepted", findings: [] }));
    d.store.sending(id);
    d.store.posted(id, "6001");
    f.state.now = 7;
    const r = (await reconcile(f.reader(), p, d.store))[0]!;
    assert.deepEqual(r.snapshot.faultfinding, { actor: 30, pair: { head: HEAD, base: BASE }, unresolved: [] });
  } finally {
    d.cleanup();
  }
});
