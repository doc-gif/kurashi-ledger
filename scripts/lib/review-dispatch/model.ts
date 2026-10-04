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
  // PR48-R008: CI trust digests (github.ts ciTrustDigest) the owner recorded after an independent review.
  trustedCiDigests?: string[];
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
  if (
    p.trustedCiDigests !== undefined &&
    (!Array.isArray(p.trustedCiDigests) ||
      p.trustedCiDigests.some(
        (t) => typeof t !== "string" || !/^[a-f0-9]{64}$/.test(t),
      ) ||
      new Set(p.trustedCiDigests).size !== p.trustedCiDigests.length)
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
