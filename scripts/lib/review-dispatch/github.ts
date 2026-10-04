import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hash,
  samePair,
  type HistoryEvent,
  type Pair,
  type Policy,
  type Snapshot,
} from "./model.ts";
import {
  unresolvedFindings,
  type ChangeRecord,
  type ItemRecord,
} from "./findings.ts";

export const REQUIRED_JOBS = [
  "Quality gate",
  "review plan",
  ...["checks", "browser", "review tools"].flatMap((kind) =>
    ["linux", "windows", "macos"].map((os) => `${kind} (${os})`),
  ),
];
export type Response = {
  status: number;
  headers: Record<string, string>;
  body: string;
};
export type Transport = (
  endpoint: string,
  headers: Record<string, string>,
) => Promise<Response>;
export class EvidenceError extends Error {
  constructor() {
    super("GitHub evidence incomplete; no dispatch");
  }
}
export class GhReader {
  readonly prefix: string;
  readonly send: Transport;
  readonly cache = new Map<string, Response>();
  readonly clock: () => number;
  readonly deadline: number;
  // W4 row 12: the latest server Date seen by this reader (the end of an observation window).
  maxDate = Number.NaN;
  constructor(
    repo: string,
    send: Transport,
    clock: () => number = Date.now,
    budgetMs = 60000,
  ) {
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo))
      throw new EvidenceError();
    this.prefix = `/repos/${repo}/`;
    this.send = send;
    this.clock = clock;
    this.deadline = clock() + budgetMs;
  }
  async request(path: string): Promise<Response> {
    if (
      !path.startsWith(this.prefix) ||
      /[\r\n\\]/.test(path) ||
      path.split("/").includes("..") ||
      this.clock() >= this.deadline
    )
      throw new EvidenceError();
    const old = this.cache.get(path);
    const r = await this.send(
      path,
      old?.headers["etag"] ? { "If-None-Match": old.headers["etag"] } : {},
    );
    if (
      this.clock() >= this.deadline ||
      r.status === 429 ||
      r.headers["x-ratelimit-remaining"] === "0"
    )
      throw new EvidenceError();
    const date = Date.parse(r.headers["date"] ?? "");
    if (Number.isFinite(date) && !(date <= this.maxDate)) this.maxDate = date;
    if (r.status === 304) {
      if (!old) throw new EvidenceError();
      const cached = {
        ...old,
        headers: { ...old.headers, date: r.headers["date"] ?? "" },
      };
      this.cache.set(path, cached);
      return cached;
    }
    if (r.status !== 200 || Buffer.byteLength(r.body) > 8 * 1024 * 1024)
      throw new EvidenceError();
    this.cache.set(path, r);
    return r;
  }
  async object(path: string): Promise<Record<string, unknown>> {
    const r = await this.request(this.prefix + path);
    try {
      return object(JSON.parse(r.body));
    } catch {
      throw new EvidenceError();
    }
  }
  async pages(path: string, field?: string): Promise<unknown[]> {
    let next: string | null = this.prefix + path,
      out: unknown[] = [],
      expected: number | null = null;
    const seen = new Set<string>();
    while (next !== null) {
      if (seen.has(next) || seen.size >= 1000) throw new EvidenceError();
      seen.add(next);
      const r = await this.request(next);
      let value: unknown;
      try {
        value = JSON.parse(r.body);
      } catch {
        throw new EvidenceError();
      }
      if (field && Number.isSafeInteger(object(value)["total_count"])) {
        const n = Number(object(value)["total_count"]);
        if (expected !== null && expected !== n) throw new EvidenceError();
        expected = n;
      }
      const page = field ? object(value)[field] : value;
      if (!Array.isArray(page)) throw new EvidenceError();
      out.push(...page);
      const link = r.headers["link"];
      next = null;
      if (link) {
        const links = link.split(",");
        const raw = links.find((x) => /rel="next"/.test(x));
        if (raw) {
          const url = raw.match(/<([^>]+)>/)?.[1];
          if (!url) throw new EvidenceError();
          const u = new URL(url);
          if (
            u.origin !== "https://api.github.com" ||
            !u.pathname.startsWith(this.prefix)
          )
            throw new EvidenceError();
          next = u.pathname + u.search;
        }
      }
    }
    if (expected !== null && out.length !== expected) throw new EvidenceError();
    return out;
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EvidenceError();
  return value as Record<string, unknown>;
}
function text(o: Record<string, unknown>, k: string): string {
  if (typeof o[k] !== "string") throw new EvidenceError();
  return o[k];
}
function id(o: Record<string, unknown>): number {
  if (!Number.isSafeInteger(o["id"]) || Number(o["id"]) < 1)
    throw new EvidenceError();
  return Number(o["id"]);
}
const sha = (v: unknown): string => {
  if (typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v))
    throw new EvidenceError();
  return v;
};
const pair = (
  pr: Record<string, unknown>,
  main: Record<string, unknown>,
): Pair => ({
  head: sha(object(pr["head"])["sha"]),
  base: sha(object(main["commit"])["sha"]),
});
export type ReadyBinding = {
  id: string;
  actor: number;
  at: number;
  pair: Pair;
  policy: string;
};
export type ReviewBinding = {
  id: string;
  actor: number;
  pair: Pair;
  state: string;
  policy: string;
};
export type Collection = {
  policyRevision: string;
  snapshot: Snapshot;
  timeline: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  comments: unknown[];
  commits: unknown[];
  handoffs: Record<string, unknown>[];
  activity: Record<string, unknown>[];
  observedAt: number;
  headRef: string;
  headRepoId: number | null;
  creation: { id: string; actor: number; at: number } | null;
  // PR48-R008: CI-deciding files unchanged, owner-trusted change, or untrusted change (stays unknown).
  workflow: "unchanged" | "trusted" | "untrusted";
  // PR48-R007: new immutable observation records of finding items, for the caller to persist.
  findingItems: ItemRecord[];
  findingChanges: ChangeRecord[];
};
// PR48-R008: the files that decide the CI judgement. Owner decision (Issue #50, 2026-10-04,
// issuecomment-5977404200): all of .github, package.json, tools/review_guard/, scripts/check-test-skips.ts
// and what it reads (scripts/lib/test-skips.ts and the skip table in docs/development.md). Test
// contents are excluded and rely on independent content review. A path
// ending in "/" is a directory prefix; any other path is one file. Widen or narrow the unit only here.
export const CI_TRUST_PATHS: readonly string[] = [
  ".github/",
  ".npmrc", // npm's settings for npm ci in CI (owner decision, issuecomment-5977523656; W4 row 10)
  "package.json",
  "tools/review_guard/",
  "scripts/check-test-skips.ts",
  "scripts/lib/test-skips.ts",
  "docs/development.md", // the skip table check-test-skips reads (same receipt: "その読む部品")
];
// Test contents inside the trust paths (e.g. tools/review_guard/tests/, *.test.ts, test_*.py).
export const CI_TRUST_EXCLUDED: readonly RegExp[] = [
  /(?:^|\/)tests\//,
  /\.test\.[cm]?[jt]s$/,
  /(?:^|\/)test_[^/]*\.py$/,
];
export const inCiTrust = (path: string): boolean =>
  CI_TRUST_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p)) &&
  !CI_TRUST_EXCLUDED.some((re) => re.test(path));
// SHA-256 of the `git ls-tree -r --full-tree <commit>` lines of the trusted files, sorted by path
// in byte order, each ending in "\n". The owner reproduces it with the command in the docs.
export function ciTrustDigest(
  entries: readonly { path: string; mode: string; type: string; sha: string }[],
): string {
  const lines = entries
    .filter((e) => e.type !== "tree" && inCiTrust(e.path))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    .map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}\n`);
  return hash(lines.join(""));
}
async function ciTrust(reader: GhReader, commit: string): Promise<string> {
  const c = await reader.object(`git/commits/${commit}`);
  const t = await reader.object(
    `git/trees/${sha(object(c["tree"])["sha"])}?recursive=1`,
  );
  if (t["truncated"] !== false || !Array.isArray(t["tree"]))
    throw new EvidenceError();
  return ciTrustDigest(
    t["tree"].map((value) => {
      const e = object(value);
      if (
        typeof e["path"] !== "string" ||
        /[\u0000-\u001f\u007f]/.test(e["path"]) ||
        typeof e["mode"] !== "string" ||
        !/^[0-7]{6}$/.test(e["mode"]) ||
        !["blob", "tree", "commit"].includes(String(e["type"]))
      )
        throw new EvidenceError();
      return {
        path: e["path"],
        mode: e["mode"],
        type: String(e["type"]),
        sha: sha(e["sha"]),
      };
    }),
  );
}
// Inputs below are trusted persisted observations, never PR prose. Missing identity/history stays unknown.
export async function collect(
  reader: GhReader,
  p: Policy,
  prNumber: number,
  options: {
    requiredJobs: string[];
    ready: ReadyBinding[];
    acceptances?: ReviewBinding[];
    pushers: number[] | null;
    historyComplete: boolean;
    faultfinding: Snapshot["faultfinding"];
    unresolvedDesign: string[];
    findingItems?: ItemRecord[];
    findingChanges?: ChangeRecord[];
  },
): Promise<Collection> {
  if (!p.targets.some((t) => t.pr === prNumber)) throw new EvidenceError();
  const main = await reader.object("branches/main"),
    pr = await reader.object(`pulls/${prNumber}`),
    current = pair(pr, main);
  if (object(object(pr["base"])["repo"])["id"] !== p.repoId)
    throw new EvidenceError();
  const compare = await reader.object(
    `compare/${current.base}...${current.head}`,
  );
  const timeline = (
    await reader.pages(`issues/${prNumber}/timeline?per_page=100`)
  ).map(object);
  const reviews = (
    await reader.pages(`pulls/${prNumber}/reviews?per_page=100`)
  ).map(object);
  const handoffs = (
    await reader.pages(`issues/${prNumber}/comments?per_page=100`)
  ).map(object);
  const ref = text(object(pr["head"]), "ref");
  const activity = (
    await reader.pages(
      `activity?ref=${encodeURIComponent("refs/heads/" + ref)}&per_page=100`,
    )
  ).map(object);
  const comments = await reader.pages(
    `pulls/${prNumber}/comments?per_page=100`,
  );
  const commits = await reader.pages(`pulls/${prNumber}/commits?per_page=100`);
  await reader.pages(
    `commits/${current.head}/check-runs?per_page=100`,
    "check_runs",
  );
  await reader.pages(`commits/${current.head}/statuses?per_page=100`);
  const runs = (
    await reader.pages(
      `actions/runs?head_sha=${current.head}&event=pull_request&per_page=100`,
      "workflow_runs",
    )
  ).map(object);
  // Only the reviewed workflow file may produce the required jobs; another file named "CI" cannot.
  const candidate = runs
    .filter(
      (r) =>
        r["name"] === "CI" &&
        r["path"] === ".github/workflows/ci.yml" &&
        r["head_sha"] === current.head,
    )
    .sort((a, b) => Number(b["id"]) - Number(a["id"]))[0];
  let jobs: Record<string, unknown>[] = [],
    testedParents: string[] = [],
    testedTree = "";
  // PR48-R008: any change in CI_TRUST_PATHS keeps CI unknown until the owner records the reviewed
  // digest in the policy. A policy revision change then needs a new Ready.
  const baseTrust = await ciTrust(reader, current.base),
    headTrust = await ciTrust(reader, current.head);
  const workflow: Collection["workflow"] =
    baseTrust === headTrust
      ? "unchanged"
      : (p.trustedCiDigests ?? []).includes(headTrust)
        ? "trusted"
        : "untrusted";
  const workflowTrusted = workflow !== "untrusted";
  const head = await reader.object(`git/commits/${current.head}`);
  const headTree = sha(object(head["tree"])["sha"]);
  if (candidate) {
    jobs = (
      await reader.pages(
        `actions/runs/${id(candidate)}/jobs?filter=latest&per_page=100`,
        "jobs",
      )
    ).map(object);
    const gate = jobs.find(
      (j) => j["name"] === "Quality gate" && j["conclusion"] === "success",
    );
    if (gate && candidate["conclusion"] === "success") {
      const log = await reader.request(
        reader.prefix + `actions/jobs/${id(gate)}/logs`,
      );
      const tested = log.body.match(/TESTED_SHA[=: ]+([a-f0-9]{40})/)?.[1];
      if (tested) {
        const c = await reader.object(`git/commits/${tested}`);
        testedParents = (c["parents"] as unknown[]).map((x) =>
          sha(object(x)["sha"]),
        );
        testedTree = sha(object(c["tree"])["sha"]);
      }
    }
  }
  const createdAt = Date.parse(String(pr["created_at"]));
  const creation =
    Number.isSafeInteger(pr["id"]) && Number.isFinite(createdAt)
      ? {
          id: `created:${pr["id"]}:${pr["created_at"]}`,
          actor: id(object(pr["user"])),
          at: createdAt,
        }
      : null;
  const history: HistoryEvent[] = creation
    ? [{ ...creation, kind: "ready", pair: null }]
    : [];
  for (const e of timeline) {
    const kind =
      (
        {
          ready_for_review: "ready",
          convert_to_draft: "draft",
          head_ref_force_pushed: "push",
          base_ref_changed: "push",
          review_requested: "request",
        } as Record<string, HistoryEvent["kind"]>
      )[String(e["event"])] ??
      (objectOrNull(e["label"])?.["name"] === "review:paused"
        ? e["event"] === "labeled"
          ? "pause"
          : e["event"] === "unlabeled"
            ? "unpause"
            : undefined
        : undefined);
    if (!kind) continue;
    const eventId = `timeline:${id(e)}`,
      actor = id(object(e["actor"])),
      at = Date.parse(text(e, "created_at"));
    if (!Number.isFinite(at)) throw new EvidenceError();
    const binding = options.ready.find(
      (b) =>
        b.policy === p.revision &&
        b.id === eventId &&
        b.actor === actor &&
        b.at === at,
    );
    history.push({
      id: eventId,
      actor,
      at,
      kind,
      pair: binding?.pair ?? null,
      ...(binding ? { policy: binding.policy } : {}),
    });
  }
  const afterMain = await reader.object("branches/main"),
    afterPR = await reader.object(`pulls/${prNumber}`);
  const labels = pr["labels"];
  if (!Array.isArray(labels)) throw new EvidenceError();
  const snapshot: Snapshot = {
    repoId: p.repoId,
    pr: prNumber,
    pair: current,
    finalPair: pair(afterPR, afterMain),
    baseRef: text(object(pr["base"]), "ref"),
    state: pr["state"] === "open" ? "open" : "closed",
    draft: pr["draft"] !== false,
    pausedLabel: labels.some((l) => object(l)["name"] === "review:paused"),
    author: id(object(pr["user"])),
    pushers: options.pushers,
    historyComplete: options.historyComplete,
    complete:
      workflowTrusted &&
      (typeof pr["commits"] !== "number" || commits.length === pr["commits"]),
    mergeBase: sha(object(compare["merge_base_commit"])["sha"]),
    headTree,
    testedTree,
    testedParents,
    requiredJobs: [...new Set([...REQUIRED_JOBS, ...options.requiredJobs])],
    ci: jobs.map((j) => ({
      name: text(j, "name"),
      conclusion:
        typeof j["conclusion"] === "string" ? j["conclusion"] : "pending",
    })),
    history,
    // Native human approvals need a persisted establishment pair; unknown base is never filled from today.
    reviews: reviews.map((r): Snapshot["reviews"][number] => {
      const actor = id(object(r["user"])),
        reviewId = String(id(r));
      const binding = options.acceptances?.find(
        (b) =>
          b.policy === p.revision &&
          b.id === reviewId &&
          b.actor === actor &&
          b.state === r["state"] &&
          b.pair.head === r["commit_id"],
      );
      return {
        id: reviewId,
        actor,
        state: reviewState(r["state"]),
        pair: binding?.pair ?? null,
        findings: [],
      };
    }),
    unresolvedDesign: options.unresolvedDesign,
    faultfinding: options.faultfinding,
    // W4 row 6: every commit of the PR, so evidence links to them pass the publication check.
    commits: commits.map((c) => sha(object(c)["sha"])),
  };
  // PR48-R007: unresolved findings block acceptance through the assigned reviewers' latest reviews.
  // An owner's finding is attached to every assigned reviewer (owners raise, never resolve others).
  const assignment = p.targets.find((t) => t.pr === prNumber)!;
  // W4 row 12: the latest server Date of every response so far, not only the first PR response.
  const observedAt = reader.maxDate;
  const found = unresolvedFindings({
    pr: prNumber,
    head: current.head,
    reviewers: assignment.reviewers,
    owners: p.owners,
    reviews,
    comments: comments.map(object),
    conversation: handoffs,
    observedAt,
    items: options.findingItems ?? [],
    changes: options.findingChanges ?? [],
  });
  const ownerFindings = [...found.open]
    .filter(([actor]) => !assignment.reviewers.includes(actor))
    .flatMap(([, ids]) => ids);
  for (const actor of assignment.reviewers) {
    const ids = [
      ...new Set([...(found.open.get(actor) ?? []), ...ownerFindings]),
    ].sort();
    if (!ids.length) continue;
    const latest = snapshot.reviews.findLast((r) => r.actor === actor);
    if (latest) latest.findings = ids;
    else
      snapshot.reviews.push({
        id: `findings:${actor}`,
        actor,
        state: "COMMENTED",
        pair: null,
        findings: ids,
      });
  }
  const meta = (v: Record<string, unknown>) =>
    JSON.stringify([
      v["state"],
      v["draft"],
      object(v["base"])["ref"],
      v["updated_at"],
      v["labels"],
    ]);
  if (
    !samePair(snapshot.pair, snapshot.finalPair) ||
    meta(pr) !== meta(afterPR)
  )
    snapshot.complete = false;
  return {
    policyRevision: p.revision,
    creation,
    snapshot,
    timeline,
    reviews,
    comments,
    commits,
    handoffs,
    activity,
    observedAt,
    headRef: "refs/heads/" + ref,
    headRepoId:
      (objectOrNull(object(pr["head"])["repo"])?.["id"] as number) ?? null,
    workflow,
    findingItems: found.items,
    findingChanges: found.changes,
  };
}
const objectOrNull = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
function reviewState(v: unknown): Snapshot["reviews"][number]["state"] {
  if (
    v === "APPROVED" ||
    v === "CHANGES_REQUESTED" ||
    v === "COMMENTED" ||
    v === "DISMISSED"
  )
    return v;
  return "COMMENTED";
}
export function bindReady(
  payload: unknown,
  c: Collection,
): ReadyBinding | null {
  const b = object(payload);
  if (b["action"] !== "ready_for_review" && b["action"] !== "opened")
    return null;
  const pr = object(b["pull_request"]),
    actor = id(object(b["sender"]));
  if (b["action"] === "opened") {
    const rawPair = {
      head: sha(object(pr["head"])["sha"]),
      base: sha(object(pr["base"])["sha"]),
    };
    if (
      !c.creation ||
      pr["draft"] !== false ||
      c.creation.actor !== actor ||
      c.creation.at !== Date.parse(String(pr["created_at"])) ||
      !c.snapshot.complete ||
      !samePair(rawPair, c.snapshot.pair)
    )
      return null;
    return { ...c.creation, pair: rawPair, policy: c.policyRevision };
  }
  const at = Date.parse(text(pr, "updated_at"));
  const matches = c.timeline.filter(
    (e) =>
      e["event"] === "ready_for_review" &&
      id(object(e["actor"])) === actor &&
      Date.parse(text(e, "created_at")) === at,
  );
  const rawPair = {
    head: sha(object(pr["head"])["sha"]),
    base: sha(object(pr["base"])["sha"]),
  };
  if (
    matches.length !== 1 ||
    !c.snapshot.complete ||
    !samePair(rawPair, c.snapshot.pair)
  )
    return null;
  return {
    id: `timeline:${id(matches[0]!)}`,
    actor,
    at,
    pair: rawPair,
    policy: c.policyRevision,
  };
}
export function ghTransport(token: string, ghPath: string): Transport {
  if (!token || !/^(?:\/|[A-Za-z]:[\\/])/.test(ghPath))
    throw new EvidenceError();
  return async (endpoint, headers) => {
    const home = mkdtempSync(join(tmpdir(), "dispatch-gh-"));
    try {
      const args = [
        "api",
        "--hostname",
        "github.com",
        "--include",
        endpoint,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
      ];
      for (const [k, v] of Object.entries(headers))
        args.push("-H", `${k}: ${v}`);
      const r = spawnSync(ghPath, args, {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 9 * 1024 * 1024,
        env: {
          GH_TOKEN: token,
          GH_CONFIG_DIR: home,
          HOME: home,
          PATH:
            process.platform === "win32"
              ? "C:\\Windows\\System32"
              : "/usr/bin:/bin",
          NO_COLOR: "1",
          GH_PAGER: "cat",
        },
      });
      const match = r.stdout?.match(
        /^HTTP\/\S+ (\d+) [^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/,
      );
      if (!match || r.error) throw new EvidenceError();
      const h: Record<string, string> = {};
      for (const line of match[2]!.split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i > 0) h[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
      }
      return { status: Number(match[1]), headers: h, body: match[3]! };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
}

// PR48-R011: the only body form the Broker posts. LF line ends, no trailing blanks, NFC, no other
// control characters. Recovery compares hashes exactly; a body GitHub changed stays uncertain.
export function canonicalBody(body: string): string {
  return body
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .trimEnd();
}
// Instantiate only inside the fixed-identity reviewed App wrapper. No key/App selector is exposed to worker output.
export function ghReviewTransport(
  token: string,
  ghPath: string,
  repo: string,
  fixedActor: number,
): import("./broker.ts").BrokerTransport {
  const read = new GhReader(repo, ghTransport(token, ghPath));
  return {
    list: async (pr) =>
      (await read.pages(`pulls/${pr}/reviews?per_page=100`)).map((value) => {
        const r = object(value);
        return {
          id: String(id(r)),
          actor: id(object(r["user"])),
          head: sha(r["commit_id"]),
          body: text(r, "body"),
        };
      }),
    post: async (pr, event, head, body) => {
      if (
        !Number.isSafeInteger(pr) ||
        pr < 1 ||
        !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event) ||
        !/^[a-f0-9]{40}$/.test(head) ||
        body.length > 32768 ||
        body !== canonicalBody(body)
      )
        throw new EvidenceError();
      const home = mkdtempSync(join(tmpdir(), "dispatch-broker-"));
      try {
        const r = spawnSync(
          ghPath,
          [
            "api",
            "--hostname",
            "github.com",
            `/repos/${repo}/pulls/${pr}/reviews`,
            "--method",
            "POST",
            "--input",
            "-",
          ],
          {
            input: JSON.stringify({ event, commit_id: head, body }),
            encoding: "utf8",
            timeout: 15000,
            maxBuffer: 1024 * 1024,
            env: {
              GH_TOKEN: token,
              GH_CONFIG_DIR: home,
              HOME: home,
              PATH:
                process.platform === "win32"
                  ? "C:\\Windows\\System32"
                  : "/usr/bin:/bin",
              NO_COLOR: "1",
              GH_PAGER: "cat",
            },
          },
        );
        if (r.status !== 0 || r.error) throw new EvidenceError();
        const posted = object(JSON.parse(r.stdout));
        if (
          id(object(posted["user"])) !== fixedActor ||
          sha(posted["commit_id"]) !== head
        )
          throw new EvidenceError();
      } catch {
        throw new EvidenceError();
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  };
}

// Authenticated review delivery + freshly refetched native review. Never infer base from commit dates/prose.
export function bindReview(
  payload: unknown,
  c: Collection,
): ReviewBinding | null {
  const b = object(payload);
  if (b["action"] !== "submitted") return null;
  const r = object(b["review"]),
    actor = id(object(b["sender"])),
    native = c.reviews.find((x) => x["id"] === r["id"]);
  const pr = object(b["pull_request"]);
  const rawPair = {
    head: sha(object(pr["head"])["sha"]),
    base: sha(object(pr["base"])["sha"]),
  };
  if (
    !native ||
    !c.snapshot.complete ||
    id(object(native["user"])) !== actor ||
    id(object(r["user"])) !== actor ||
    native["commit_id"] !== r["commit_id"] ||
    r["commit_id"] !== rawPair.head ||
    native["state"] !== r["state"] ||
    native["submitted_at"] !== r["submitted_at"] ||
    !samePair(rawPair, c.snapshot.pair)
  )
    return null;
  return {
    id: String(id(r)),
    actor,
    pair: rawPair,
    state: text(native, "state"),
    policy: c.policyRevision,
  };
}
