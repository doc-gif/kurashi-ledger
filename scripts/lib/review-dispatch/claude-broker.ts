import { spawn } from "node:child_process";
import { TOKEN_PATTERN } from "../github-app-token.ts";
import {
  ReviewBroker,
  type BrokerTransport,
  type PostedReview,
  type Provenance,
} from "./broker.ts";
import type { Job, Policy, Snapshot } from "./model.ts";
import { RunVerifier } from "./provenance.ts";
import type { Store } from "./store.ts";

// The real review Broker for the Claude App (design §3/§6). Its identity is fixed here as constants: no
// argument, policy field or worker output selects another App, key or token purpose. GitHub writes go through
// the reviewed token wrapper (scripts/github-app-token.ts) with the `review` purpose; the reduced token lives
// only in the fixed relay child (scripts/review-dispatch-claude-broker.ts), never in the dispatcher. The Codex
// App and its key are not reachable from this module.
export const CLAUDE_AGENT = "claude";
export const REVIEW_PURPOSE = "review";
const WRAPPER_NAME = "github-app-token.ts";
const RELAY_NAME = "review-dispatch-claude-broker.ts";
const MAX_REQUESTS = 16;
const REQUEST_LIMIT = 128 * 1024;
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const BODY_LIMIT = 32768;

// Owner-fixed installation of the reviewed copy. Values come from the owner's configuration, never from a PR,
// a worker result or the dispatcher policy file.
export type ClaudeBrokerInstall = {
  node: string;
  wrapper: string;
  relay: string;
  gh: string;
  appId: string;
  installationId: string;
  repo: string;
  actor: number;
};

const absolute = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\/[^\0\r\n]*$/.test(v) &&
  !v.split("/").some((part) => part === ".." || part === ".");

export function validateInstall(
  value: ClaudeBrokerInstall,
  platform: NodeJS.Platform,
): ClaudeBrokerInstall {
  // The dispatcher runs on the owner's Mac only (owner decision). No Windows or other backend.
  if (platform !== "darwin") throw new Error("Claude Broker is macOS-only");
  const v = value;
  const dir = (p: string): string => p.slice(0, p.lastIndexOf("/"));
  if (
    !v ||
    Object.keys(v).sort().join() !==
      "actor,appId,gh,installationId,node,relay,repo,wrapper" ||
    ![v.node, v.wrapper, v.relay, v.gh].every(absolute) ||
    !v.wrapper.endsWith(`/scripts/${WRAPPER_NAME}`) ||
    !v.relay.endsWith(`/scripts/${RELAY_NAME}`) ||
    dir(v.wrapper) !== dir(v.relay) ||
    !/^[1-9][0-9]{0,19}$/.test(v.appId) ||
    !/^[1-9][0-9]{0,19}$/.test(v.installationId) ||
    !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(v.repo) ||
    !Number.isSafeInteger(v.actor) ||
    v.actor < 1
  )
    throw new Error("Invalid Claude Broker installation");
  return { ...v };
}

// argv for the trusted wrapper. No shell. --agent and --purpose are constants.
export function claudeBrokerCommand(install: ClaudeBrokerInstall): string[] {
  return [
    install.node,
    install.wrapper,
    "--agent",
    CLAUDE_AGENT,
    "--purpose",
    REVIEW_PURPOSE,
    "--app-id",
    install.appId,
    "--installation-id",
    install.installationId,
    "--",
    install.node,
    install.relay,
    "--repo",
    install.repo,
    "--gh",
    install.gh,
    "--actor",
    String(install.actor),
  ];
}

// Rebuilt from an allowlist. No GH_*/GITHUB_*/KL_* credentials, NODE_OPTIONS or project hooks are inherited.
// HOME is the owner's account home from the passwd entry, which the wrapper needs to read its own keychain item.
export function claudeBrokerEnvironment(home: string): Record<string, string> {
  if (!absolute(home)) throw new Error("Invalid home");
  return { HOME: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1" };
}

export type RelayProcess = {
  stdin: {
    write(chunk: string): unknown;
    end(): unknown;
    on(event: "error", listener: () => void): unknown;
  };
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  // "error" covers a wrapper that cannot be started; both end the session.
  once(event: "exit" | "error", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};
export type SpawnRelay = (
  command: string,
  args: string[],
  env: Record<string, string>,
) => RelayProcess;
export const spawnRelay: SpawnRelay = (command, args, env) =>
  spawn(command, args, {
    env,
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  }) as unknown as RelayProcess;

type Pending = {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

// One wrapper session per Broker submit: one token mint for every page and the single POST, revoked by the
// wrapper when the session ends. A failed or closed session is never reopened; the Broker then reconciles
// through its Outbox (uncertain, no repeat POST).
export class ClaudeAppTransport implements BrokerTransport {
  readonly #install: ClaudeBrokerInstall;
  readonly #spawn: SpawnRelay;
  readonly #home: string;
  readonly #timeoutMs: number;
  #child: RelayProcess | null = null;
  #closed = false;
  #exited: Promise<void> | null = null;
  #next = 1;
  #buffer = "";
  readonly #pending = new Map<number, Pending>();
  constructor(
    install: ClaudeBrokerInstall,
    deps: {
      platform: NodeJS.Platform;
      home: string;
      spawn?: SpawnRelay;
      timeoutMs?: number;
    },
  ) {
    this.#install = validateInstall(install, deps.platform);
    claudeBrokerEnvironment(deps.home);
    this.#home = deps.home;
    this.#spawn = deps.spawn ?? spawnRelay;
    this.#timeoutMs = deps.timeoutMs ?? 60000;
  }
  #fail(): void {
    this.#closed = true;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Claude Broker relay unavailable"));
    }
    this.#pending.clear();
  }
  #open(): RelayProcess {
    if (this.#closed) throw new Error("Claude Broker session closed");
    if (this.#child) return this.#child;
    const [command, ...args] = claudeBrokerCommand(this.#install);
    const child = this.#spawn(
      command!,
      args,
      claudeBrokerEnvironment(this.#home),
    );
    this.#child = child;
    this.#exited = new Promise((resolve) => {
      const end = (): void => {
        this.#fail();
        resolve();
      };
      child.once("exit", end);
      child.once("error", end);
    });
    child.stdin.on("error", () => this.#fail());
    child.stdout.on("data", (chunk) => {
      this.#buffer += chunk.toString("utf8");
      if (Buffer.byteLength(this.#buffer) > RESPONSE_LIMIT) {
        child.kill("SIGTERM");
        this.#fail();
        return;
      }
      let i: number;
      while ((i = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, i);
        this.#buffer = this.#buffer.slice(i + 1);
        let v: Record<string, unknown>;
        try {
          v = JSON.parse(line) as Record<string, unknown>;
        } catch {
          child.kill("SIGTERM");
          this.#fail();
          return;
        }
        const pending =
          v && typeof v === "object" && typeof v["id"] === "number"
            ? this.#pending.get(v["id"])
            : undefined;
        if (!pending) {
          child.kill("SIGTERM");
          this.#fail();
          return;
        }
        this.#pending.delete(v["id"] as number);
        clearTimeout(pending.timer);
        pending.resolve(v);
      }
    });
    return child;
  }
  async #request(
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const child = this.#open(),
      id = this.#next++;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        child.kill("SIGTERM");
        this.#fail();
        reject(new Error("Claude Broker relay timed out"));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ id, ...body })}\n`);
    const v = await response;
    if (v["ok"] !== true) {
      // The relay ends its session after any failure; do not send more requests into it.
      this.#fail();
      child.stdin.end();
      throw new Error("Claude Broker request failed");
    }
    return v;
  }
  async list(pr: number): Promise<PostedReview[]> {
    if (!Number.isSafeInteger(pr) || pr < 1) throw new Error("Invalid PR");
    const v = await this.#request({ op: "list", pr });
    const reviews = v["reviews"];
    if (
      Object.keys(v).sort().join() !== "id,ok,reviews" ||
      !Array.isArray(reviews) ||
      reviews.length > 3000
    )
      throw new Error("Invalid relay response");
    return reviews.map((value: unknown) => {
      const r = value as Record<string, unknown>;
      if (
        !r ||
        typeof r !== "object" ||
        Object.keys(r).sort().join() !== "actor,body,head,id" ||
        typeof r["id"] !== "string" ||
        !/^[0-9]{1,20}$/.test(r["id"]) ||
        !Number.isSafeInteger(r["actor"]) ||
        typeof r["head"] !== "string" ||
        !/^[a-f0-9]{40}$/.test(r["head"]) ||
        typeof r["body"] !== "string" ||
        r["body"].length > 262144
      )
        throw new Error("Invalid relay response");
      return {
        id: r["id"],
        actor: r["actor"] as number,
        head: r["head"],
        body: r["body"],
      };
    });
  }
  async post(
    pr: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    head: string,
    body: string,
  ): Promise<void> {
    if (!validPost(pr, event, head, body)) throw new Error("Invalid review");
    const v = await this.#request({ op: "post", pr, event, head, body });
    if (Object.keys(v).sort().join() !== "id,ok")
      throw new Error("Invalid relay response");
  }
  // Ends the session: the relay exits and the wrapper revokes the token. Kills the session if it hangs.
  async close(): Promise<void> {
    const child = this.#child;
    this.#closed = true;
    if (!child || !this.#exited) return;
    child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#timeoutMs);
    });
    if ((await Promise.race([this.#exited, timeout])) === "timeout")
      child.kill("SIGTERM");
    clearTimeout(timer);
  }
}

function validPost(
  pr: unknown,
  event: unknown,
  head: unknown,
  body: unknown,
): boolean {
  return (
    Number.isSafeInteger(pr) &&
    (pr as number) > 0 &&
    typeof event === "string" &&
    ["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event) &&
    typeof head === "string" &&
    /^[a-f0-9]{40}$/.test(head) &&
    typeof body === "string" &&
    body.length > 0 &&
    body.length <= BODY_LIMIT
  );
}

// Relay loop inside the wrapper's child. Only list/post for the fixed repo/actor; at most one POST per session.
// Failures return ok:false without GitHub output or token material, and end the session.
export async function relay(
  lines: AsyncIterable<string>,
  write: (line: string) => void,
  transport: () => BrokerTransport,
): Promise<number> {
  let requests = 0,
    posted = false;
  for await (const line of lines) {
    let id = 0;
    try {
      if (++requests > MAX_REQUESTS || Buffer.byteLength(line) > REQUEST_LIMIT)
        throw new Error();
      const r = JSON.parse(line) as Record<string, unknown>;
      if (!r || typeof r !== "object" || !Number.isSafeInteger(r["id"]))
        throw new Error();
      id = r["id"] as number;
      if (
        r["op"] === "list" &&
        Object.keys(r).sort().join() === "id,op,pr" &&
        Number.isSafeInteger(r["pr"]) &&
        (r["pr"] as number) > 0
      ) {
        const reviews = await transport().list(r["pr"] as number);
        write(`${JSON.stringify({ id, ok: true, reviews })}\n`);
        continue;
      }
      if (
        r["op"] === "post" &&
        !posted &&
        Object.keys(r).sort().join() === "body,event,head,id,op,pr" &&
        validPost(r["pr"], r["event"], r["head"], r["body"])
      ) {
        posted = true; // Counted before the network call: a lost reply never allows a second POST.
        await transport().post(
          r["pr"] as number,
          r["event"] as "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
          r["head"] as string,
          r["body"] as string,
        );
        write(`${JSON.stringify({ id, ok: true })}\n`);
        continue;
      }
      throw new Error();
    } catch {
      write(`${JSON.stringify({ id, ok: false })}\n`);
      return 2;
    }
  }
  return 0;
}

// Entry logic of scripts/review-dispatch-claude-broker.ts. The token comes only from the wrapper's GH_TOKEN.
export async function relayMain(
  args: readonly string[],
  env: Record<string, string | undefined>,
  lines: AsyncIterable<string>,
  write: (line: string) => void,
  makeTransport: (
    token: string,
    gh: string,
    repo: string,
    actor: number,
  ) => BrokerTransport,
): Promise<number> {
  const token = env["GH_TOKEN"];
  delete env["GH_TOKEN"];
  if (
    args.length !== 6 ||
    args[0] !== "--repo" ||
    args[2] !== "--gh" ||
    args[4] !== "--actor" ||
    !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(args[1] ?? "") ||
    !absolute(args[3]) ||
    !/^[1-9][0-9]{0,15}$/.test(args[5] ?? "") ||
    !Number.isSafeInteger(Number(args[5])) ||
    typeof token !== "string" ||
    !TOKEN_PATTERN.test(token)
  )
    return 2;
  const repo = args[1]!,
    gh = args[3]!,
    actor = Number(args[5]);
  // A fresh transport per request keeps each GitHub read inside its own short budget.
  return relay(lines, write, () => makeTransport(token, gh, repo, actor));
}

// Fixed-identity Claude review Broker. The policy must name this App's bot as an AI actor run by Claude.
// Only the verify-only RunVerifier is accepted (supervisor-signed results); a sealing fixture cannot be passed.
// Each submit opens its own wrapper session and always closes it, so the token is minted and revoked per review.
export type ClaudeReviewBroker = {
  readonly actor: number;
  submit(
    p: Policy,
    j: Job,
    raw: string,
    origin: Provenance | null,
    fetchFresh: () => Promise<Snapshot>,
  ): Promise<"posted" | "uncertain" | "stale" | "blocked" | "deferred">;
};
export function createClaudeReviewBroker(
  policy: Policy,
  install: ClaudeBrokerInstall,
  store: Store,
  verifier: RunVerifier,
  deps: {
    platform: NodeJS.Platform;
    home: string;
    spawn?: SpawnRelay;
    timeoutMs?: number;
  },
): ClaudeReviewBroker {
  if (!(verifier instanceof RunVerifier))
    throw new Error("Claude Broker requires the run verifier");
  const fixed = validateInstall(install, deps.platform),
    actor = policy.actors.find((a) => a.id === fixed.actor);
  if (
    policy.repo !== fixed.repo ||
    actor?.kind !== "ai" ||
    actor.executor !== CLAUDE_AGENT
  )
    throw new Error("Claude Broker identity mismatch");
  claudeBrokerEnvironment(deps.home);
  return {
    actor: fixed.actor,
    async submit(p, j, raw, origin, fetchFresh) {
      const transport = new ClaudeAppTransport(fixed, deps);
      try {
        return await new ReviewBroker(
          fixed.actor,
          transport,
          store,
          verifier,
        ).submit(p, j, raw, origin, fetchFresh);
      } finally {
        await transport.close();
      }
    },
  };
}
