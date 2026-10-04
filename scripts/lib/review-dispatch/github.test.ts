import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GhReader,
  EvidenceError,
  collect,
  bindReady,
  bindReview,
  ghTransport,
  ghReviewTransport,
  canonicalBody,
  type Response,
} from "./github.ts";
import { ReviewBroker } from "./broker.ts";
import { RunChannel } from "../../../tests/fixtures/review-dispatch-run-channel.ts";
import { allowedFor, publicationFindings } from "./publication.ts";
import { fixtureResult } from "./runtime.ts";
import {
  policy,
  HEAD,
  BASE,
  TREE,
  database,
  claim,
  snapshot,
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
        commits: 0, // GitHub's count; the commit list below is empty (PR58-R002)
      });
    if (path === "git/commits/" + BASE)
      return response({ tree: { sha: "6".repeat(40) } });
    if (path.startsWith("git/trees/"))
      return response({
        truncated: false,
        tree: [
          { path: ".github/workflows/ci.yml", mode: "100644", type: "blob", sha: "5".repeat(40) },
        ],
      });
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
        total_count: 1,
        workflow_runs: [
          {
            id: 2,
            name: "CI",
            path: ".github/workflows/ci.yml",
            head_sha: HEAD,
            conclusion: "success",
          },
        ],
      });
    if (path.startsWith("actions/runs/2/jobs"))
      return response({
        total_count: 1,
        jobs: [{ id: 3, name: "Quality gate", conclusion: "success" }],
      });
    if (path === "actions/jobs/3/logs")
      return {
        status: 200,
        headers: {},
        body: "TESTED_SHA: " + "e".repeat(40),
      };
    if (path.includes("check-runs")) return response({ total_count: 0, check_runs: [] });
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

test("R011 canonical review body: LF, no trailing blanks, NFC, no stray controls; idempotent", () => {
  const raw = "a  \r\nb\t\rc\u0007\n\u0065\u0301\n\n";
  const body = canonicalBody(raw);
  assert.equal(body, "a\nb\nc\n\u00e9");
  assert.equal(canonicalBody(body), body);
});
test("R011 the review transport refuses a non-canonical body before starting gh", async () => {
  if (process.platform === "win32") {
    await assert.rejects(
      ghReviewTransport("synthetic", "C:\\missing-gh.exe", "synthetic/repository", 30).post(1, "COMMENT", HEAD, "x \n"),
    );
    return;
  }
  const { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync, realpathSync } = await import("node:fs"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-gh-body-")));
  try {
    const flag = join(dir, "started"),
      gh = join(dir, "fake-gh");
    writeFileSync(gh, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(flag)}, "1");\nprocess.exit(1);\n`);
    chmodSync(gh, 0o700);
    const t = ghReviewTransport("synthetic", gh, "synthetic/repository", 30);
    for (const body of ["trailing \nspace", "crlf\r\nline", "end\n"])
      await assert.rejects(t.post(1, "COMMENT", HEAD, body));
    assert.equal(existsSync(flag), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("R011 a marked review whose body hash differs stays uncertain and is never POSTed again", async () => {
  for (const variant of ["normalized", "extra-copy"] as const) {
    const d = database();
    try {
      const p = policy(),
        s = snapshot(),
        j = claim(d.store);
      d.store.running(j);
      const raw = JSON.stringify(fixtureResult(j));
      d.store.result(j, raw);
      let posts = 0;
      const rows: { id: string; actor: number; head: string; body: string }[] = [];
      const channel = new RunChannel(Buffer.alloc(32, 7));
      const b = new ReviewBroker(
        30,
        {
          post: async (_pr, _event, head, body) => {
            posts++;
            assert.equal(body, canonicalBody(body));
            // GitHub may change the stored text (e.g. a trailing newline) or a second copy may exist.
            if (variant === "normalized") rows.push({ id: "r1", actor: 30, head, body: body + "\n" });
            else
              rows.push(
                { id: "r1", actor: 30, head, body },
                { id: "r2", actor: 30, head, body: body + " edited" },
              );
          },
          list: async () => rows,
        },
        d.store,
        channel,
      );
      const origin = channel.seal(j, raw);
      assert.equal(await b.submit(p, j, raw, origin, async () => s), "uncertain");
      assert.equal(await b.submit(p, j, raw, origin, async () => s), "uncertain");
      assert.equal(posts, 1);
    } finally {
      d.cleanup();
    }
  }
});
test("R011/W4 ordering: canonicalisation can join a split key shape, so a publication check must read the canonical body", async () => {
  const { parseResult } = await import("./broker.ts");
  // Synthetic shape only (not a real token). A control character splits it before canonicalisation.
  const key = /gh[pousr]_[A-Za-z0-9_]{16,}/;
  const split = "ghp_" + "A".repeat(10) + "\u0007" + "B".repeat(10);
  assert.equal(key.test(split), false);
  assert.equal(key.test(canonicalBody(split)), true);
  // The publication check misses the split shape but catches it after canonicalisation. This is why the Broker
  // runs canonicalBody -> publicationFindings -> hash -> POST and checks the exact body it posts.
  const d = database();
  try {
    const j = claim(d.store),
      allowed = allowedFor(j, snapshot());
    assert.deepEqual(publicationFindings(split, allowed), []);
    assert.ok(publicationFindings(canonicalBody(split), allowed).includes("key/token"));
    assert.ok(publicationFindings(canonicalBody(`前置き ${split} 後置き`), allowed).includes("key/token"));
    // Worker fields cannot carry such a control character into render() in the first place.
    for (const field of ["summary", "unverified"] as const) {
      const r = fixtureResult(j) as unknown as Record<string, unknown>;
      r[field] = field === "summary" ? split : [split];
      assert.throws(() => parseResult(JSON.stringify(r), j));
    }
  } finally {
    d.cleanup();
  }
});

test("W4 row 14: the owner's CI trust command (git ls-tree -z, quotePath off) equals ciTrustDigest on a synthetic repository", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { ciTrustDigest } = await import("./github.ts");
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ci-trust-")));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  try {
    git("init", "-q");
    // Inside the unit (non-ASCII and spaces too), test contents inside it, and files outside it.
    const files: Record<string, string> = {
      ".github/workflows/ci.yml": "name: CI\n",
      ".github/日本語 の説明.md": "合成\n",
      ".npmrc": "engine-strict=true\n",
      "package.json": "{}\n",
      "tools/review_guard/guard.py": "print()\n",
      "tools/review_guard/tests/test_guard.py": "pass\n",
      "scripts/check-test-skips.ts": "export {};\n",
      "scripts/lib/test-skips.ts": "export {};\n",
      "scripts/lib/test-skips.test.ts": "export {};\n",
      "docs/development.md": "# 開発\n",
      "docs/日本語.md": "外\n",
      "src/app.ts": "export {};\n",
    };
    for (const [path, body] of Object.entries(files)) {
      fs.mkdirSync(join(dir, path, ".."), { recursive: true });
      fs.writeFileSync(join(dir, path), body);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "synthetic");
    const head = git("rev-parse", "HEAD").trim();
    // The dispatcher's side: the same entries as the tree API gives (from git, without quoting).
    const entries = git("-c", "core.quotePath=false", "ls-tree", "-r", "-z", "--full-tree", head)
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t") as [string, string];
        const [mode, type, sha] = meta.split(" ") as [string, string, string];
        return { path, mode, type, sha };
      });
    assert.ok(entries.some((e) => e.path === ".github/日本語 の説明.md"));
    const expected = ciTrustDigest(entries);
    if (process.platform === "win32") {
      // The owner command is POSIX sh (the dispatcher runs on macOS only); Windows checks the parse above.
      t.diagnostic("owner command is POSIX-only; Windows compared the -z parse with ciTrustDigest only");
      assert.match(expected, /^[a-f0-9]{64}$/);
      return;
    }
    const script = join(import.meta.dirname, "..", "..", "..", "tools", "review_dispatch", "ci-trust-digest.sh");
    const run = (commit: string) => spawnSync("sh", [script, dir, commit], { encoding: "utf8" });
    const r = run(head);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), expected);
    // The quoted form (core.quotePath=true, without -z) would have hashed a different path text.
    const quoted = spawnSync("git", ["-C", dir, "-c", "core.quotePath=true", "ls-tree", "-r", "--full-tree", head], { encoding: "utf8" }).stdout;
    assert.match(quoted, /"\.github\/\\346/);
    // A changed trusted file changes the digest; an unknown commit fails instead of hashing nothing.
    fs.writeFileSync(join(dir, ".npmrc"), "engine-strict=false\n");
    git("commit", "-q", "-am", "change");
    const next = git("rev-parse", "HEAD").trim();
    assert.notEqual(run(next).stdout.trim(), expected);
    assert.notEqual(run("0".repeat(40)).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
