// Synthetic public identities/revisions; no production actor IDs or credentials.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Policy,
  type Snapshot,
  type Job,
} from "../../scripts/lib/review-dispatch/model.ts";
import { Store } from "../../scripts/lib/review-dispatch/store.ts";
import { assess } from "../../scripts/lib/review-dispatch/reducer.ts";
export const HEAD = "a".repeat(40),
  BASE = "b".repeat(40),
  TREE = "c".repeat(40);
export function policy(): Policy {
  return {
    revision: "p1",
    readyAfter: 0,
    mode: "active",
    repo: "synthetic/repository",
    repoId: 1,
    installationId: 2,
    receiveAppId: 3,
    owners: [10],
    actors: [
      { id: 10, person: "owner", kind: "human", executor: "human" },
      { id: 20, person: "implementer", kind: "ai", executor: "codex" },
      { id: 30, person: "reviewer", kind: "ai", executor: "claude" },
      { id: 40, person: "second", kind: "human", executor: "human" },
    ],
    targets: [{ pr: 1, implementer: 20, reviewers: [30] }],
    maxConcurrent: 10,
    executorLimits: { codex: 10, claude: 10 },
  };
}
export function snapshot(): Snapshot {
  return {
    repoId: 1,
    pr: 1,
    pair: { head: HEAD, base: BASE },
    finalPair: { head: HEAD, base: BASE },
    baseRef: "main",
    state: "open",
    draft: false,
    pausedLabel: false,
    author: 20,
    pushers: [20],
    historyComplete: true,
    complete: true,
    mergeBase: BASE,
    headTree: TREE,
    testedTree: TREE,
    testedParents: [BASE, HEAD],
    ci: [
      { name: "Quality gate", conclusion: "success" },
      { name: "checks", conclusion: "success" },
    ],
    requiredJobs: ["Quality gate", "checks"],
    history: [
      {
        id: "push1",
        kind: "push",
        actor: 20,
        at: 1,
        pair: { head: HEAD, base: BASE },
      },
      {
        id: "ready1",
        kind: "ready",
        policy: "p1",
        actor: 20,
        at: 2,
        pair: { head: HEAD, base: BASE },
      },
    ],
    reviews: [],
    openFindings: [],
    unresolvedDesign: [],
    faultfinding: {
      actor: 30,
      pair: { head: HEAD, base: BASE },
      unresolved: [],
    },
  };
}
export function database(): {
  root: string;
  store: Store;
  cleanup: () => void;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-synthetic-"))),
    store = new Store(root, true);
  return {
    root,
    store,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export function claim(
  store: Store,
  p = policy(),
  s = snapshot(),
  now = 100,
): Job {
  store.observe(assess(p, s, null));
  const j = store.claim(p, s, 30, "review", now);
  if (!j) throw new Error("Fixture claim failed");
  return j;
}
