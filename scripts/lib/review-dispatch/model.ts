import { createHash } from "node:crypto";

// Trusted adapters construct evidence. PR prose and worker output cannot construct policy/evidence.
export type Pair = { head: string; base: string };
export type Actor = {
  id: number;
  person: string;
  kind: "human" | "ai";
  executor: string;
};
export type Policy = {
  revision: string;
  readyAfter: number;
  mode: "off" | "shadow" | "active";
  repo: string;
  repoId: number;
  installationId: number;
  receiveAppId: number;
  owners: number[];
  actors: Actor[];
  targets: {
    pr: number;
    implementer: number;
    reviewers: number[];
    // Explicit owner migration evidence. API activity must contain this exact anchor; no author/committer guess.
    identity?: {
      activity: string;
      head: string;
      at: number;
      pushers: number[];
    };
  }[];
  maxConcurrent: number;
  executorLimits: Record<string, number>;
  // PR48-R008: CI trust records the owner made after an independent review (github.ts ciTrustDigest).
  // Each record is bound to main (owner decision, Issue #50 issuecomment-5978676604): the digest of main's
  // CI-deciding files and the trusted head digest. When main's digest changes, the owner records again, so a
  // PR returning to an earlier trusted setting is not trusted automatically.
  trustedCi?: { main: string; head: string }[];
};
export type HistoryEvent = {
  id: string;
  kind: "ready" | "push" | "draft" | "pause" | "unpause" | "request";
  actor: number;
  at: number;
  pair: Pair | null;
  policy?: string;
};
export type Review = {
  id: string;
  actor: number;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  pair: Pair | null;
  findings: string[];
};
export type Snapshot = {
  repoId: number;
  pr: number;
  pair: Pair;
  finalPair: Pair;
  baseRef: string;
  state: "open" | "closed";
  draft: boolean;
  pausedLabel: boolean;
  author: number;
  pushers: number[] | null;
  historyComplete: boolean;
  complete: boolean;
  mergeBase: string;
  headTree: string;
  testedTree: string;
  testedParents: string[];
  ci: { name: string; conclusion: string }[];
  requiredJobs: string[];
  history: HistoryEvent[];
  reviews: Review[];
  unresolvedDesign: string[];
  faultfinding: { actor: number; pair: Pair; unresolved: string[] } | null;
  // Every commit SHA of the PR (pulls/<n>/commits, all pages). Absent in older fixtures.
  commits?: string[];
  // PR48-R007 unresolved finding IDs by the actor who raised them (assigned reviewers and owners).
  openFindings?: { actor: number; ids: string[] }[];
};
export type Target = {
  key: string;
  generation: number;
  policy: string;
  pair: Pair;
  ready: string | null;
  paused: boolean;
  status: "waiting" | "eligible" | "finished";
  reason: string;
};
export type JobKind = "review" | "faultfinding" | "fix";
export type Job = {
  id: string;
  key: string;
  generation: number;
  actor: number;
  kind: JobKind;
  run: string;
  pair: Pair;
  policy: string;
};
export type WorkerResult = {
  schema: 1;
  run: string;
  actor: number;
  generation: number;
  pair: Pair;
  decision: "accepted" | "changes-requested" | "needs-owner";
  summary: string;
  findings: {
    id: string;
    location: string;
    impact: string;
    completion: string;
  }[];
  evidence: string[];
  unverified: string[];
  // Faultfinding only (empty for a review): the judgement per ledger cause or invariant, and what became
  // of each earlier RT (pr-review-loop.md#提出前の粗探し).
  causes: { cause: string; judgement: "該当" | "該当なし" | "確認できない"; where: string }[];
  previous: { id: string; status: "解消" | "対応不要" | "未解消"; reason: string }[];
};
export const samePair = (a: Pair, b: Pair): boolean =>
  a.head === b.head && a.base === b.base;
export const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export const keyOf = (policy: Policy, pr: number): string =>
  `${policy.repoId}:${pr}`;
export const independent = (policy: Policy, a: number, b: number): boolean => {
  const left = policy.actors.find((x) => x.id === a),
    right = policy.actors.find((x) => x.id === b);
  return (
    left !== undefined &&
    right !== undefined &&
    a !== b &&
    left.person !== right.person
  );
};
// Who can raise a finding on a PR (owner decision, Issue #50 issuecomment-5978984980): every participant
// registered in the policy (owner, Codex, Claude and others), not only the assigned reviewers. Owners raise
// through their own narrower rule (findings.ts), so they are not listed here. The PR's implementer (and anyone
// who is the same person) is excluded: an implementer's own notes on its fixes are not findings. Unregistered
// third parties are reference only, so a stranger on a public repository cannot block.
export function findingRaisers(p: Policy, pr: number): number[] {
  const t = p.targets.find((x) => x.pr === pr);
  if (!t) return [];
  const implementer = p.actors.find((a) => a.id === t.implementer)?.person;
  return p.actors
    .filter((a) => !p.owners.includes(a.id) && a.person !== implementer)
    .map((a) => a.id)
    .sort((a, b) => a - b);
}
export const registered = (p: Policy, actor: number): boolean =>
  p.actors.some((a) => a.id === actor);
export function validatePolicy(value: unknown): Policy {
  // Explicit schema: no executable paths, credentials or arbitrary shell arguments in policy.
  const p = value as Policy;
  if (
    !p ||
    !["off", "shadow", "active"].includes(p.mode) ||
    !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(p.repo) ||
    !Number.isSafeInteger(p.readyAfter) ||
    p.readyAfter < 0 ||
    !/^[a-zA-Z0-9._-]{1,80}$/.test(p.revision) ||
    ![p.repoId, p.installationId, p.receiveAppId].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    !Number.isInteger(p.maxConcurrent) ||
    p.maxConcurrent < 1 ||
    p.maxConcurrent > 10 ||
    !Array.isArray(p.actors) ||
    !Array.isArray(p.owners) ||
    !Array.isArray(p.targets) ||
    !p.executorLimits
  )
    throw new Error("Invalid dispatcher policy");
  if (
    p.actors.some(
      (a) =>
        !Number.isSafeInteger(a.id) ||
        a.id < 1 ||
        !/^[a-zA-Z0-9._-]{1,80}$/.test(a.person) ||
        !/^[a-zA-Z0-9._-]{1,80}$/.test(a.executor) ||
        !["human", "ai"].includes(a.kind),
    ) ||
    new Set(p.actors.map((a) => a.id)).size !== p.actors.length ||
    !p.owners.length ||
    p.owners.some((id) => !p.actors.some((a) => a.id === id))
  )
    throw new Error("Invalid actor policy");
  if (
    new Set(p.targets.map((t) => t.pr)).size !== p.targets.length ||
    p.targets.some(
      (t) =>
        !Number.isSafeInteger(t.pr) ||
        t.pr < 1 ||
        !p.actors.some((a) => a.id === t.implementer) ||
        (t.identity !== undefined &&
          (!/^[a-zA-Z0-9-]{1,100}$/.test(t.identity.activity) ||
            !/^[a-f0-9]{40}$/.test(t.identity.head) ||
            !Number.isSafeInteger(t.identity.at) ||
            t.identity.at < 0 ||
            !Array.isArray(t.identity.pushers) ||
            !t.identity.pushers.length ||
            t.identity.pushers.some(
              (id) => !p.actors.some((a) => a.id === id),
            ))) ||
        !Array.isArray(t.reviewers) ||
        !t.reviewers.length ||
        new Set(t.reviewers).size !== t.reviewers.length ||
        t.reviewers.some((id) => !independent(p, id, t.implementer)),
    )
  )
    throw new Error("Invalid role assignment");
  const hex = (t: unknown) => typeof t === "string" && /^[a-f0-9]{64}$/.test(t);
  if (
    // The unbound form (W3) is refused, not ignored, so the owner re-records against main.
    "trustedCiDigests" in (p as object) ||
    (p.trustedCi !== undefined &&
      (!Array.isArray(p.trustedCi) ||
        p.trustedCi.some(
          (t) =>
            !t ||
            typeof t !== "object" ||
            Object.keys(t).sort().join() !== "head,main" ||
            !hex(t.main) ||
            !hex(t.head) ||
            t.main === t.head,
        ) ||
        new Set(p.trustedCi.map((t) => `${t.main}:${t.head}`)).size !== p.trustedCi.length))
  )
    throw new Error("Invalid workflow trust");
  for (const a of p.actors)
    if (
      a.kind === "ai" &&
      (!Number.isInteger(p.executorLimits[a.executor]) ||
        (p.executorLimits[a.executor] ?? 0) < 1 ||
        (p.executorLimits[a.executor] ?? 11) > 10)
    )
      throw new Error("Invalid executor limit");
  return structuredClone(p);
}
