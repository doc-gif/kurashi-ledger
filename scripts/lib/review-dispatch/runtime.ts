import { assess, accepted } from "./reducer.ts";
import {
  hash,
  type Policy,
  type Snapshot,
  type WorkerResult,
  type Job,
} from "./model.ts";
import { Store } from "./store.ts";
import { parseResult, ReviewBroker } from "./broker.ts";

export type Capability = {
  backend: "fixture" | "codex" | "claude";
  version: string;
  codeHash: string;
  profileHash: string;
  probes: Record<string, boolean>;
};
// Every probe must be proven denied (doctor.ts). Missing or false keeps the backend off.
export const REQUIRED_PROBES = [
  "deny-network",
  "deny-gh-auth",
  "deny-other-ai-auth",
  "deny-keys",
  "deny-keychain",
  "deny-db",
  "deny-policy-write",
  "deny-supervisor",
  "deny-hooks-mcp",
  "tool-child-confined",
  "schema",
  "descendant-lock",
] as const;
export function capabilityReady(c: Capability | null): boolean {
  const required = REQUIRED_PROBES;
  return (
    c !== null &&
    c.version !== "" &&
    /^[a-f0-9]{64}$/.test(c.codeHash) &&
    /^[a-f0-9]{64}$/.test(c.profileHash) &&
    required.every((k) => c.probes[k] === true)
  );
}
export function workerEnvironment(
  root: string,
  path: string,
): Record<string, string> {
  // Deliberately does not spread process.env. No auth, hooks, project config or startup variables.
  return {
    HOME: root,
    TMPDIR: root,
    PATH: path,
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  };
}
export type Runner = {
  capability: Capability;
  run(
    j: Job,
  ): Promise<{ result: string; treeEnded: boolean; uncertain: boolean }>;
};
export class Dispatcher {
  readonly policy: Policy;
  readonly store: Store;
  constructor(policy: Policy, store: Store) {
    this.policy = policy;
    this.store = store;
  }
  observe(s: Snapshot): { status: string; accepted: boolean; notice: boolean } {
    this.store.clearQuota(this.policy, s);
    const previous = this.store.target(`${this.policy.repoId}:${s.pr}`),
      t = assess(this.policy, s, previous, this.store.consumed());
    const saved = this.store.observe(t);
    const notice =
      t.status === "waiting" &&
      this.store.notice(
        `${t.key}:${t.reason}:${t.pair.head}:${t.pair.base}:${t.generation}`,
      );
    return {
      status: saved
        ? (this.store.target(t.key)?.reason ?? t.reason)
        : "cancel-required",
      accepted:
        saved && !this.store.quotaPaused(t.key) && accepted(this.policy, s, t),
      notice,
    };
  }
  async fixtureCycle(
    s: Snapshot,
    actor: number,
    runner: Runner,
    broker: ReviewBroker,
    fetchFresh: () => Promise<Snapshot>,
    now: number,
  ): Promise<string> {
    this.observe(s);
    if (this.policy.mode !== "active") return this.policy.mode;
    // Real CLI launch is deliberately unavailable until owner rollout/negative probes and reviewed installation.
    if (
      runner.capability.backend !== "fixture" ||
      !capabilityReady(runner.capability)
    )
      return "capability-disabled";
    const j = this.store.claim(this.policy, s, actor, "review", now);
    if (!j) return "waiting";
    try {
      this.store.running(j);
      const value = await runner.run(j);
      if (value.uncertain || !value.treeEnded) {
        this.store.uncertain(j);
        return "uncertain";
      }
      parseResult(value.result, j);
      this.store.result(j, value.result);
      // Fixture integrity tag only: dispatcher signs its fake runner return. This does NOT authenticate a real run endpoint.
      const outcome = await broker.submit(
        this.policy,
        j,
        value.result,
        broker.channel.seal(j, value.result),
        fetchFresh,
      );
      if (outcome === "uncertain") {
        this.store.uncertain(j);
        return outcome;
      }
      this.store.release(j, {
        run: j.run,
        neverStarted: false,
        treeEnded: true,
        uncertain: false,
      });
      return outcome;
    } catch {
      this.store.uncertain(j);
      return "uncertain";
    }
  }
}
export function fixtureResult(j: Job): WorkerResult {
  return {
    schema: 1,
    run: j.run,
    actor: j.actor,
    generation: j.generation,
    pair: j.pair,
    decision: "needs-owner",
    summary: "合成試験の結果です。",
    findings: [],
    evidence: [],
    unverified: ["実AI・本導入は未検証"],
  };
}
