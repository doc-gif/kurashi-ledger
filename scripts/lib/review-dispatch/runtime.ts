import { assess, accepted } from "./reducer.ts";
import {
  hash,
  type Policy,
  type Snapshot,
  type WorkerResult,
  type Job,
} from "./model.ts";
import { Store } from "./store.ts";
import {
  parseResult,
  ResultContentError,
  ReviewBroker,
  type Provenance,
} from "./broker.ts";
import {
  blockedNotice,
  redactedResult,
  resultFindings,
} from "./publication.ts";

export type Capability = {
  backend: "fixture" | "codex" | "claude";
  version: string;
  codeHash: string;
  profileHash: string;
  probes: Record<string, boolean>;
};
export function capabilityReady(c: Capability | null): boolean {
  const required = [
    "deny-network",
    "deny-gh-auth",
    "deny-other-ai-auth",
    "deny-keys",
    "deny-db",
    "deny-policy-write",
    "schema",
    "descendant-lock",
  ];
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
type RunOutcome = {
  result: string;
  treeEnded: boolean;
  uncertain: boolean;
  // From the run endpoint (the supervisor's signature, or a fixture runner's seal); null if absent.
  origin: Provenance | null;
};
// Replaces the run endpoint's durable signed envelope with its hash-only form (supervisor.py redact) whenever a
// result is blocked or rejected. The real wiring is part of W4.
type Redact = (j: Job, resultHash: string) => Promise<void>;
// A fake runner keeps no envelope, so redact is optional. Every other runner MUST provide it (PR #53 round 3).
export type Runner =
  | {
      capability: Capability & { backend: "fixture" };
      run(j: Job): Promise<RunOutcome>;
      redact?: Redact;
    }
  | {
      capability: Capability & { backend: "codex" | "claude" };
      run(j: Job): Promise<RunOutcome>;
      redact: Redact;
    };
export function runnerAcceptable(r: Runner): boolean {
  return (
    r.capability.backend === "fixture" ||
    typeof (r as { redact?: unknown }).redact === "function"
  );
}
// Construction point for runners: refuses a non-fixture runner without redact even if the types are bypassed.
export function createRunner<R extends Runner>(r: R): R {
  if (!runnerAcceptable(r)) throw new Error("Runner without redact refused");
  return r;
}
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
    broker: Pick<ReviewBroker, "submit">,
    fetchFresh: () => Promise<Snapshot>,
    now: number,
  ): Promise<string> {
    this.observe(s);
    if (this.policy.mode !== "active") return this.policy.mode;
    if (!runnerAcceptable(runner)) return "capability-disabled";
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
      let parsed: WorkerResult;
      try {
        parsed = parseResult(value.result, j);
      } catch (error) {
        // Content rejection (secret shape, format characters, look-alikes, links): blocked, like the check below.
        if (error instanceof ResultContentError)
          return await this.#block(j, runner, value.result);
        // Malformed shape: stays uncertain, but any persisted plaintext (the signed envelope) is still redacted.
        this.store.uncertain(j);
        await this.#redact(j, runner, value.result);
        return "uncertain";
      }
      if (resultFindings(parsed, j, s, this.policy.repo).length)
        return await this.#block(j, runner, value.result);
      this.store.result(j, value.result);
      // The dispatcher never signs (PR48-R003). It forwards the runner's provenance; the Broker verifies it.
      const outcome = await broker.submit(
        this.policy,
        j,
        value.result,
        value.origin,
        fetchFresh,
      );
      if (outcome === "uncertain" || outcome === "blocked") {
        // blocked: the publication check refused the body. Hold the lease for the owner (needs-owner).
        this.store.uncertain(j);
        if (outcome === "blocked") await this.#redact(j, runner, value.result);
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
  // blocked = persistent needs-owner: DB keeps only the hash, one owner notice, lease held, envelope redacted.
  async #block(j: Job, runner: Runner, raw: string): Promise<"blocked"> {
    this.store.result(j, redactedResult(raw));
    this.store.notice(blockedNotice(j));
    this.store.uncertain(j);
    await this.#redact(j, runner, raw);
    return "blocked";
  }
  // A failed redact never unblocks or relaunches: the job stays as it is and the owner is notified once.
  async #redact(j: Job, runner: Runner, raw: string): Promise<void> {
    if (!runner.redact) return; // Fixture runner only (no envelope); runnerAcceptable refuses others.
    try {
      await runner.redact(j, hash(raw));
    } catch {
      this.store.notice(`${j.key}:redact-failed:${j.run}`);
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
