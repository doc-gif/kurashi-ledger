import { assess, accepted } from "./reducer.ts";
import {
  hash,
  type JobKind,
  type Policy,
  type Snapshot,
  type WorkerResult,
  type Job,
} from "./model.ts";
import { Store } from "./store.ts";
import {
  parseResult,
  recordIds,
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
  codeHash: string; // sha256 of the pinned CLI executable (doctor input)
  profileHash: string; // doctor.ts profileHash(cli.sb text)
  // launcher.ts argvTemplateHash(install). Required for Claude: active.ts binds all four values to the
  // plan it launches (W4); a capability measured with other flags or paths never launches.
  argvHash?: string;
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
  // A child of this run cannot write another run's area (W5c; the config dir is per run).
  "deny-other-run",
  "schema",
  // The supervisor stops the worker's process group and sees it empty (W5c). Not "all descendants ended":
  // a child that left the group is a residual risk (design §7).
  "group-ended",
] as const;
export function capabilityReady(c: Capability | null): boolean {
  const required = REQUIRED_PROBES;
  return (
    c !== null &&
    // Owner decision (Issue #50, 5977523656): Codex is never launched automatically in this release.
    c.backend !== "codex" &&
    (c.backend !== "claude" || /^[a-f0-9]{64}$/.test(c.argvHash ?? "")) &&
    c.version !== "" &&
    /^[a-f0-9]{64}$/.test(c.codeHash) &&
    /^[a-f0-9]{64}$/.test(c.profileHash) &&
    required.every((k) => c.probes[k] === true)
  );
}
// Synthetic fixture workers only (supervisor.py run-fixture). A real worker's env comes from launcher.ts,
// with its HOME/TMPDIR outside the supervisor root (W4 row 4).
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
  // The worker's process group was stopped and seen empty (necessary, never sufficient: design §7).
  groupEnded: boolean;
  uncertain: boolean;
  // The worker was proven never started (materials or plan refused before the supervisor ran it).
  neverStarted?: boolean;
  // Why it never started (a fixed reason ID, for the owner notice).
  reason?: string;
  // The run area could not be removed (W5c, ISSUE50-P003): the PR is blocked for the owner and the cycle output
  // names it, whatever else happened to the run.
  problem?: "run-area-not-removed";
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
    // Real CLI launch goes through activeCycle (start-small, Claude only).
    if (
      runner.capability.backend !== "fixture" ||
      !capabilityReady(runner.capability)
    )
      return "capability-disabled";
    return this.#launch(s, actor, "review", runner, broker, fetchFresh, now);
  }
  // Issue #50 W4: one job of the start-small active mode (active.ts decides the kind). The runner must be
  // the Claude runner with a ready, plan-bound capability; Codex and the fixture are refused here.
  async activeCycle(
    s: Snapshot,
    actor: number,
    kind: Exclude<JobKind, "fix">,
    runner: Runner,
    broker: Pick<ReviewBroker, "submit">,
    fetchFresh: () => Promise<Snapshot>,
    now: number,
  ): Promise<string> {
    this.observe(s);
    if (this.policy.mode !== "active") return this.policy.mode;
    if (
      !runnerAcceptable(runner) ||
      runner.capability.backend !== "claude" ||
      !capabilityReady(runner.capability) ||
      (kind !== "review" && kind !== "faultfinding")
    )
      return "capability-disabled";
    return this.#launch(s, actor, kind, runner, broker, fetchFresh, now);
  }
  async #launch(
    s: Snapshot,
    actor: number,
    kind: "review" | "faultfinding",
    runner: Runner,
    broker: Pick<ReviewBroker, "submit">,
    fetchFresh: () => Promise<Snapshot>,
    now: number,
  ): Promise<string> {
    const j = this.store.claim(this.policy, s, actor, kind, now);
    if (!j) return "waiting";
    let value: RunOutcome | null = null;
    const outcome = await this.#settle(j, async () => (value = await runner.run(j)), s, runner, broker, fetchFresh, now);
    const v = value as RunOutcome | null;
    if (v?.problem !== "run-area-not-removed") return outcome;
    // Reported where the owner reads (cycle output and status: the blocked row with the reason and run).
    this.store.block(j, "run-area-not-removed", now);
    return `${outcome} run-area-not-removed run ${j.run}`;
  }
  async #settle(
    j: Job,
    start: () => Promise<RunOutcome>,
    s: Snapshot,
    runner: Runner,
    broker: Pick<ReviewBroker, "submit">,
    fetchFresh: () => Promise<Snapshot>,
    now: number,
  ): Promise<string> {
    try {
      this.store.running(j);
      const value = await start();
      if (value.neverStarted === true) {
        // Nothing ran: release the lease, keep the job (no relaunch for this generation) and tell the owner once.
        this.store.release(j, { run: j.run, neverStarted: true, groupEnded: false, uncertain: false });
        this.store.notice(`${j.key}:not-started:${value.reason ?? "unknown"}:${j.run}`);
        return `not-started:${/^[a-z-]{1,40}$/.test(value.reason ?? "") ? value.reason : "unknown"}`;
      }
      if (value.uncertain || !value.groupEnded) {
        this.store.uncertain(j);
        return "uncertain";
      }
      let parsed: WorkerResult;
      try {
        parsed = parseResult(value.result, j, recordIds(this.store.runMaterials(j.run)));
      } catch (error) {
        // Content rejection (secret shape, format characters, look-alikes, links): blocked, like the check below.
        if (error instanceof ResultContentError)
          return await this.#block(j, runner, value.result, now);
        // Malformed shape: stays uncertain, but any persisted plaintext (the signed envelope) is still redacted.
        this.store.uncertain(j);
        await this.#redact(j, runner, value.result);
        return "uncertain";
      }
      if (resultFindings(parsed, j, s, this.policy.repo).length)
        return await this.#block(j, runner, value.result, now);
      this.store.result(j, value.result, value.origin);
      // The dispatcher never signs (PR48-R003). It forwards the runner's provenance; the Broker verifies it.
      return await this.#post(j, runner, value.result, value.origin, broker, fetchFresh, now);
    } catch {
      this.store.uncertain(j);
      return "uncertain";
    }
  }
  // A job whose post was deferred (an unprocessed edit/delete mark) is posted by a later cycle from its stored
  // result and provenance; the Broker verifies the signature again. Nothing is relaunched.
  async resumeDeferred(
    s: Snapshot,
    runner: Runner,
    broker: Pick<ReviewBroker, "submit">,
    fetchFresh: () => Promise<Snapshot>,
    now: number,
  ): Promise<string | null> {
    this.observe(s);
    const d = this.store.deferred(`${this.policy.repoId}:${s.pr}`);
    if (!d || this.policy.mode !== "active") return null;
    try {
      return await this.#post(d.job, runner, d.result, d.origin as Provenance, broker, fetchFresh, now);
    } catch {
      this.store.uncertain(d.job);
      return "uncertain";
    }
  }
  async #post(
    j: Job,
    runner: Runner,
    raw: string,
    origin: Provenance | null,
    broker: Pick<ReviewBroker, "submit">,
    fetchFresh: () => Promise<Snapshot>,
    now: number,
  ): Promise<string> {
    {
      const outcome = await broker.submit(this.policy, j, raw, origin, fetchFresh);
      if (outcome === "deferred") {
        // The result and the lease stay; one owner notice per run (PR #56 red team P2).
        this.store.notice(`${j.key}:deferred:${j.run}`);
        return outcome;
      }
      if (outcome === "uncertain" || outcome === "blocked") {
        // blocked: the publication check refused the body. Hold the lease for the owner (needs-owner),
        // and keep the durable per-PR blocked state (W4 row 1).
        this.store.uncertain(j);
        if (outcome === "blocked") {
          this.store.block(j, "publication", now);
          await this.#redact(j, runner, raw);
        }
        return outcome;
      }
      this.store.release(j, {
        run: j.run,
        neverStarted: false,
        groupEnded: true,
        uncertain: false,
      });
      return outcome;
    }
  }
  // blocked = persistent needs-owner: DB keeps only the hash, one owner notice, lease held, envelope redacted,
  // and the durable per-PR blocked row (store.block, W4 row 1) that only the owner's unpause clears.
  async #block(j: Job, runner: Runner, raw: string, now: number): Promise<"blocked"> {
    this.store.result(j, redactedResult(raw));
    if (!this.store.checkpoint()) this.store.notice(`${j.key}:checkpoint-busy:${j.run}`);
    this.store.notice(blockedNotice(j));
    this.store.block(j, "publication", now);
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
    causes: [],
    previous: [],
  };
}
