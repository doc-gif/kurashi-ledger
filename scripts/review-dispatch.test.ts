import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { main, HELP } from "./review-dispatch.ts";
test("default command is off without reading policy/database/auth or spawning", async () => {
  const out: string[] = [];
  assert.equal(await main([], {}, (s) => out.push(s)), 0);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /off/);
  // W4: the start-small commands exist; Codex launch, fix pushes and merges stay out of the CLI.
  assert.match(HELP, /Codexの自動起動・修正push・マージはしない/);
  for (const c of ["cycle", "serve", "doctor", "measure", "status", "release"]) assert.match(HELP, new RegExp(`\\n  ${c} `));
  assert.match(
    HELP,
    /--purpose dispatch-read[\s\S]*supervisor.py daemon[\s\S]* shadow [\s\S]*--gh <絶対gh>/,
  );
});
test("unknown/active CLI cannot activate live integration", async () => {
  await assert.rejects(main(["active"], {}, () => {}));
  await assert.rejects(main(["shadow", "--root", "relative"], {}, () => {}));
});
test("R009/R010 CLI reads only an owner-only policy outside the repo, checks the lock file and stops while the clock is behind", async () => {
  const { database, policy } = await import("../tests/fixtures/review-dispatch.ts");
  const { CLOCK_SKEW_MS } = await import("./lib/review-dispatch/store.ts");
  const { hash } = await import("./lib/review-dispatch/model.ts");
  const { HostCheckError } = await import("./lib/review-dispatch/host.ts");
  const fs = await import("node:fs"),
    { join, dirname, resolve } = await import("node:path");
  const d = database();
  const p = policy();
  p.mode = "off";
  const file = join(d.root, "policy.json");
  fs.writeFileSync(file, JSON.stringify(p));
  fs.chmodSync(file, 0o600);
  if (process.platform === "win32") {
    try {
      await assert.rejects(
        main(["init", "--root", d.root, "--policy", file], { KL_DISPATCH_LOCK_FD: "3" }, () => {}),
      );
    } finally {
      d.cleanup();
    }
    return;
  }
  const lockPath = join(dirname(d.root), `.kurashi-dispatch-${hash(d.root)}.lock`);
  fs.writeFileSync(lockPath, "");
  fs.chmodSync(lockPath, 0o600);
  const fd = fs.openSync(lockPath, "r+"),
    env = { KL_DISPATCH_LOCK_FD: String(fd) },
    T0 = 90_000_000,
    out: string[] = [];
  try {
    assert.equal(await main(["init", "--root", d.root, "--policy", file], env, (s) => out.push(s), () => T0), 0);
    // A valid owner-only policy inside a repository/worktree (or the trusted copy) is refused before use.
    const repo = join(d.root, "synthetic-repo");
    fs.mkdirSync(join(repo, ".git"), { recursive: true });
    const inRepo = join(repo, "policy.json");
    fs.copyFileSync(file, inRepo);
    fs.chmodSync(inRepo, 0o600);
    await assert.rejects(main(["init", "--root", d.root, "--policy", inRepo], env, () => {}), HostCheckError);
    await assert.rejects(main(["init", "--root", d.root, "--policy", resolve("package.json")], env, () => {}), HostCheckError);
    fs.chmodSync(file, 0o620);
    await assert.rejects(main(["shadow", "--root", d.root, "--policy", file], env, () => {}, () => T0), HostCheckError);
    fs.chmodSync(file, 0o600);
    // Behind the stored clock beyond the tolerance: exit 3, nothing recorded, no reconcile.
    const lines: string[] = [];
    assert.equal(
      await main(["shadow", "--root", d.root, "--policy", file], env, (s) => lines.push(s), () => T0 - CLOCK_SKEW_MS - 1500),
      3,
    );
    assert.match(lines.join("\n"), /時計が保存時刻より約7秒戻っています/);
    assert.equal(d.store.clockBehind(T0), 0);
    assert.equal(d.store.db.prepare("SELECT now FROM clock").get()!["now"], T0);
    assert.equal(await main(["shadow", "--root", d.root, "--policy", file], env, () => {}, () => T0 + 1), 0);
    // A lifetime lock file with group/other permissions is not accepted.
    fs.chmodSync(lockPath, 0o644);
    await assert.rejects(main(["shadow", "--root", d.root, "--policy", file], env, () => {}, () => T0 + 2), HostCheckError);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
    d.cleanup();
  }
});

// Shared setup for the W4 CLI tests: a dispatcher root, an owner-only policy, the lifetime and receiver
// lock files with open descriptors (as supervisor.py would pass them), and an install record.
async function cliSetup(mutate: (p: ReturnType<typeof import("../tests/fixtures/review-dispatch.ts").policy>) => void = () => {}) {
  const { database, policy } = await import("../tests/fixtures/review-dispatch.ts");
  const fs = await import("node:fs"),
    { join } = await import("node:path"),
    { tmpdir } = await import("node:os");
  const { lockPath } = await import("./review-dispatch.ts");
  const d = database();
  const p = policy();
  mutate(p);
  const file = join(d.root, "policy.json");
  fs.writeFileSync(file, JSON.stringify(p), { mode: 0o600 });
  const runs = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "runs-")));
  fs.chmodSync(runs, 0o700);
  const install = {
    schema: 1,
    claude: {
      backend: "claude",
      executable: "/opt/synthetic/claude/2.1.300/bin/claude",
      version: "2.1.300",
      runtime: "/opt/synthetic/claude/2.1.300",
      cliProfile: "/opt/synthetic/copy/tools/review_dispatch/seatbelt/cli.sb",
      configDir: null,
      tokenFile: "/srv/synthetic/owner-secrets/claude-setup-token",
      protectedRoots: [d.root],
    },
    broker: {
      node: "/opt/synthetic/node/bin/node",
      wrapper: "/opt/synthetic/copy/scripts/github-app-token.ts",
      relay: "/opt/synthetic/copy/scripts/review-dispatch-claude-broker.ts",
      gh: "/opt/synthetic/gh/bin/gh",
      appId: "101",
      installationId: "202",
      repo: "synthetic/repository",
      actor: 30,
    },
    python: "/usr/bin/python3",
    supervisor: "/opt/synthetic/copy/tools/review_dispatch/supervisor.py",
    runs,
    home: "/srv/synthetic/owner",
    workerTimeoutSeconds: 1800,
  };
  const installFile = join(d.root, "install.json");
  fs.writeFileSync(installFile, JSON.stringify(install), { mode: 0o600 });
  const fds: number[] = [];
  const env: Record<string, string> = {};
  for (const [kind, name] of [["daemon", "KL_DISPATCH_LOCK_FD"], ["receiver", "KL_RECEIVER_LOCK_FD"]] as const) {
    const path = lockPath(d.root, kind);
    fs.writeFileSync(path, "", { mode: 0o600 });
    const fd = fs.openSync(path, "r+");
    fds.push(fd);
    env[name] = String(fd);
  }
  return {
    d, p, file, installFile, runs, env,
    cleanup: () => {
      for (const fd of fds) fs.closeSync(fd);
      for (const kind of ["daemon", "receiver"] as const) fs.rmSync(lockPath(d.root, kind), { force: true });
      fs.rmSync(runs, { recursive: true, force: true });
      d.cleanup();
    },
  };
}

test("W4 serve: receiver lock only, a fixed port 1024-65535 other than 443, an owner-only secret of 32+ bytes", async () => {
  if (process.platform === "win32") {
    await assert.rejects(main(["serve", "--root", "C:\\x", "--policy", "C:\\p", "--secret-file", "C:\\s", "--port", "8787"], {}, () => {}));
    return;
  }
  const fs = await import("node:fs"),
    { join } = await import("node:path");
  const x = await cliSetup((p) => (p.mode = "shadow"));
  try {
    const secretDir = join(x.d.root, "secret");
    fs.mkdirSync(secretDir, { mode: 0o700 });
    const short = join(secretDir, "short");
    fs.writeFileSync(short, "s".repeat(20), { mode: 0o600 });
    const args = (port: string, secret = short) => ["serve", "--root", x.d.root, "--policy", x.file, "--secret-file", secret, "--port", port];
    for (const port of ["443", "80", "0", "70000", "x"])
      await assert.rejects(main(args(port), x.env, () => {}), /port|Invalid/, port);
    await assert.rejects(main(args("8787"), x.env, () => {}), /secret too short/);
    // The lifetime (daemon) lock is not the receiver lock.
    await assert.rejects(main(args("8787"), { KL_RECEIVER_LOCK_FD: x.env["KL_DISPATCH_LOCK_FD"]! }, () => {}), /Wrong lifetime lock/);
    await assert.rejects(main(args("8787"), {}, () => {}), /lock required/);
  } finally {
    x.cleanup();
  }
});

test("W4 cycle: active needs the start-small shape and an install record before any GitHub read; no bound capability, no launch", async (t) => {
  if (process.platform === "win32") {
    // The dispatcher and its host checks are POSIX only; the serve test checks that Windows is refused.
    t.diagnostic("Windows: the dispatcher refuses to run (host checks are POSIX only)");
    await assert.rejects(main(["cycle", "--root", "C:\\x", "--policy", "C:\\p", "--gh", "C:\\gh"], {}, () => {}));
    return;
  }
  const { fakeGitHub } = await import("../tests/fixtures/review-dispatch-github.ts");
  const x = await cliSetup();
  try {
    const github = { ready: true, now: 5, calls: 0 };
    const deps = {
      transport: () => fakeGitHub(github),
      spawn: () => assert.fail("no supervisor without a bound capability"),
      digest: () => "e".repeat(64),
      readBytes: () => Buffer.from("(version 1)"),
    };
    const env = { ...x.env, GH_TOKEN: "synthetic-dispatch-read" };
    const { HEAD, BASE } = await import("../tests/fixtures/review-dispatch.ts");
    // A signed Ready delivery (stored by the receiver) that the reconcile binds to the exact pair.
    x.d.store.inbox(3, "ready", "pull_request", JSON.stringify({
      repository: { id: 1 }, installation: { id: 2 }, sender: { id: 20 }, action: "ready_for_review",
      pull_request: { number: 1, updated_at: "2026-01-01T00:00:03.000Z", head: { sha: HEAD }, base: { sha: BASE } },
    }), 1, "p1");
    const base = ["cycle", "--root", x.d.root, "--policy", x.file, "--gh", "/opt/synthetic/gh/bin/gh"];
    // Without --install the (empty) record path fails the owner-file check.
    await assert.rejects(main(base, env, () => {}, () => 1000, deps), /host check failed/);
    assert.equal(github.calls, 0);
    const lines: string[] = [];
    assert.equal(await main([...base, "--install", x.installFile], env, (s) => lines.push(s), () => 1000, deps), 0);
    assert.ok(github.calls > 0);
    assert.match(lines.join("\n"), /PR #1: 起動しません（capability-missing）/);
    // Two reviewers: refused before reading GitHub.
    const two = await cliSetup((p) => p.targets[0]!.reviewers.push(40));
    try {
      const calls = github.calls;
      await assert.rejects(
        main(["cycle", "--root", two.d.root, "--policy", two.file, "--gh", "/opt/synthetic/gh/bin/gh", "--install", two.installFile], { ...two.env, GH_TOKEN: "t" }, () => {}, () => 1000, deps),
        /start-small-one-reviewer/,
      );
      assert.equal(github.calls, calls);
    } finally {
      two.cleanup();
    }
    // status lists IDs and counts only.
    const out: string[] = [];
    assert.equal(await main(["status", "--root", x.d.root, "--policy", x.file], x.env, (s) => out.push(s), () => 1001), 0);
    assert.match(out.join("\n"), /PR #1: eligible（ready、世代1）/);
    assert.match(out.join("\n"), /capability\(claude\): なし/);
  } finally {
    x.cleanup();
  }
});

test("PR48-R016 shadow applies the retention after the reconcile: an old processed payload is removed, the row stays", async (t) => {
  if (process.platform === "win32") {
    t.diagnostic("Windows: the dispatcher refuses to run (host checks are POSIX only)");
    return;
  }
  const { fakeGitHub } = await import("../tests/fixtures/review-dispatch-github.ts");
  const x = await cliSetup((p) => {
    p.mode = "shadow";
  });
  try {
    x.d.store.inbox(3, "old", "pull_request", "{}", 1, "p1");
    x.d.store.processed(3, "old");
    const github = { ready: false, now: 5, calls: 0 };
    const args = ["shadow", "--root", x.d.root, "--policy", x.file, "--gh", "/opt/synthetic/gh/bin/gh"];
    assert.equal(await main(args, { ...x.env, GH_TOKEN: "synthetic-dispatch-read" }, () => {}, () => 8 * 86400000, { transport: () => fakeGitHub(github) }), 0);
    assert.ok(github.calls > 0);
    const row = x.d.store.db.prepare("SELECT payload FROM inbox WHERE delivery='old'").get()!;
    assert.equal(row["payload"], null);
  } finally {
    x.cleanup();
  }
});

test("PR48-R013/R015 a PR held for an hour is reported once; a hold made in the cycle is settled by one more reconcile", async () => {
  const { heldNotices, settleNow, HELD_NOTICE_MS } = await import("./review-dispatch.ts");
  const { database, policy, claim } = await import("../tests/fixtures/review-dispatch.ts");
  const { fakeGitHub } = await import("../tests/fixtures/review-dispatch-github.ts");
  const d = database();
  try {
    const lines: string[] = [];
    const held = [{ pr: 1, heldSince: 100 }, { pr: 2, heldSince: null }];
    heldNotices(held, d.store, 100 + HELD_NOTICE_MS - 1, (s) => lines.push(s));
    assert.equal(lines.length, 0);
    for (let n = 0; n < 2; n++) heldNotices(held, d.store, 100 + HELD_NOTICE_MS, (s) => lines.push(s));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^PR #1: 照合が1時間以上不完全のままです/);
    const p = policy();
    const j = claim(d.store, p);
    d.store.running(j);
    d.store.block(j, "publication", 101);
    const github = { ready: true, now: 9, calls: 0 };
    await settleNow(p, d.store, fakeGitHub(github));
    assert.equal(d.store.blocked(j.key)!.at, Date.parse("2026-01-01T00:00:09.000Z"));
    const calls = github.calls;
    await settleNow(p, d.store, fakeGitHub(github)); // nothing pending: no GitHub read
    assert.equal(github.calls, calls);
  } finally {
    d.cleanup();
  }
});

test("Red team round 4 RT-2: shadow stops with exit 4 when the revision changed but readyAfter did not move", async (t) => {
  if (process.platform === "win32") {
    t.diagnostic("Windows: the dispatcher refuses to run (host checks are POSIX only)");
    return;
  }
  const { fakeGitHub } = await import("../tests/fixtures/review-dispatch-github.ts");
  const x = await cliSetup((p) => {
    p.mode = "shadow";
  });
  try {
    x.d.store.saveObservation("1:1", { policy: "p0", observedAt: 5000 } as never);
    const github = { ready: false, now: 5, calls: 0 };
    const lines: string[] = [];
    const args = ["shadow", "--root", x.d.root, "--policy", x.file, "--gh", "/opt/synthetic/gh/bin/gh"];
    assert.equal(await main(args, { ...x.env, GH_TOKEN: "synthetic-dispatch-read" }, (s) => lines.push(s), () => 10000, { transport: () => fakeGitHub(github) }), 4);
    assert.equal(github.calls, 0);
    assert.match(lines.join("\n"), /readyAfterが前のrevisionの最後の観測（PR #1、/);
  } finally {
    x.cleanup();
  }
});

// Shared pieces for the CLI tests of the active path (Codex PR56-R003/R005).
async function activeCli() {
  const fs = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { HEAD, BASE } = await import("../tests/fixtures/review-dispatch.ts");
  const { fakeGitHub } = await import("../tests/fixtures/review-dispatch-github.ts");
  const { argvTemplateHash } = await import("./lib/review-dispatch/launcher.ts");
  const { PROBE_SET, profileHash } = await import("./lib/review-dispatch/doctor.ts");
  const { REQUIRED_PROBES } = await import("./lib/review-dispatch/runtime.ts");
  const x = await cliSetup();
  const install = JSON.parse(fs.readFileSync(x.installFile, "utf8"));
  const A = Buffer.from("(version 1)\n(deny default)\n"),
    EXE = "e".repeat(64),
    sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  x.d.store.saveCapability(
    "claude",
    {
      backend: "claude",
      version: install.claude.version,
      codeHash: EXE,
      profileHash: profileHash(A.toString("utf8")),
      argvHash: argvTemplateHash(install.claude),
      probeSet: PROBE_SET,
      probes: Object.fromEntries(REQUIRED_PROBES.map((k) => [k, true])),
    },
    1,
  );
  x.d.store.inbox(3, "ready", "pull_request", JSON.stringify({
    repository: { id: 1 }, installation: { id: 2 }, sender: { id: 20 }, action: "ready_for_review",
    pull_request: { number: 1, updated_at: "2026-01-01T00:00:03.000Z", head: { sha: HEAD }, base: { sha: BASE } },
  }), 1, "p1");
  const github = { ready: true, now: 5, calls: 0 };
  const args = ["cycle", "--root", x.d.root, "--policy", x.file, "--gh", "/opt/synthetic/gh/bin/gh", "--install", x.installFile];
  const env = { ...x.env, GH_TOKEN: "synthetic-dispatch-read" };
  return { x, install, A, EXE, sha, github, args, env, fakeGitHub };
}

test("Codex PR56-R005: the capability is matched with the bytes read once; a profile replaced afterwards starts no worker", async (t) => {
  if (process.platform === "win32") {
    t.diagnostic("Windows: the dispatcher refuses to run (host checks are POSIX only)");
    return;
  }
  const { EventEmitter } = await import("node:events");
  // Run 1: the file now holds B. Run 2 (control, a fresh dispatcher): the file still holds A.
  for (const replaced of [true, false]) {
    const c = await activeCli();
    try {
      let spawned = 0;
      const deps = {
        transport: () => c.fakeGitHub(c.github),
        spawn: () => {
          spawned++;
          // A supervisor that reads the plan and ends without announcing a key: the worker never starts.
          const child = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
          child["stdout"] = { on: () => child };
          child["stdin"] = { on: () => child, write: () => (setImmediate(() => child.emit("close", 2)), true), end: () => true };
          child["kill"] = () => true;
          return child as never;
        },
        readBytes: () => c.A,
        digest: (path: string) =>
          path === c.install.claude.cliProfile ? c.sha(replaced ? Buffer.from("B") : c.A) : c.EXE,
        platform: "darwin" as const,
        launch: { platform: "darwin" as const, exists: () => false, readToken: () => "synthetic-setup-token-0123456789abcdef" },
      };
      const lines: string[] = [];
      assert.equal(await main(c.args, c.env, (s) => lines.push(s), () => 1000, deps), 0);
      if (replaced) {
        assert.equal(spawned, 0);
        assert.match(lines.join("\n"), /PR #1: faultfinding:not-started:bound-file-changed/);
      } else {
        assert.ok(spawned >= 1); // the binding passed and the launch reached the supervisor
        assert.match(lines.join("\n"), /PR #1: faultfinding:not-started:not-acknowledged/);
      }
    } finally {
      c.x.cleanup();
    }
  }
});

test("Codex PR56-R003: a deferred post is recovered from the cycle entry point once the mark clears: posted once, no relaunch, no new quota, lease released", async (t) => {
  if (process.platform === "win32") {
    t.diagnostic("Windows: the dispatcher refuses to run (host checks are POSIX only)");
    return;
  }
  const { EventEmitter } = await import("node:events");
  const { GhReader } = await import("./lib/review-dispatch/github.ts");
  const { reconcile } = await import("./lib/review-dispatch/evidence.ts");
  const { runBinding, signedMessage } = await import("./lib/review-dispatch/provenance.ts");
  const { hash } = await import("./lib/review-dispatch/model.ts");
  const { fixtureResult } = await import("./lib/review-dispatch/runtime.ts");
  const { TestSigner } = await import("../tests/fixtures/review-dispatch-run-signer.ts");
  // Round 4 RT-1: the recovery needs no launch proof, so it also works with no capability or a changed CLI.
  for (const launchProof of ["bound", "missing", "executable-changed"] as const) {
  const c = await activeCli();
  try {
    const store = c.x.d.store,
      p = c.x.p;
    // A faultfinding job whose result waits for its post: signed, key recorded, materials recorded, lease held.
    const s = (await reconcile(new GhReader(p.repo, c.fakeGitHub(c.github)), p, store))[0]!.snapshot;
    store.observe((await import("./lib/review-dispatch/reducer.ts")).assess(p, s, null));
    const j = store.claim(p, s, 30, "faultfinding", 500)!;
    assert.ok(j);
    store.running(j);
    const signer = new TestSigner();
    store.saveRunKey(j, { run: j.run, binding: runBinding(j), key: signer.publicKey() }, 501);
    store.saveRunMaterials(j.run, { planPath: null, ledger: [], previousRts: [] });
    const raw = JSON.stringify({ ...fixtureResult(j), decision: "accepted", unverified: [] });
    const origin = { run: j.run, actor: 30, resultHash: hash(raw), signature: signer.sign(signedMessage(j.run, runBinding(j), hash(raw))) };
    store.result(j, raw, origin);
    // A reviewer's edit delivery that no reconcile has processed yet.
    store.inbox(3, "edit-1", "issue_comment", JSON.stringify({
      repository: { id: 1 }, installation: { id: 2 }, sender: { id: 30 }, action: "edited",
      issue: { number: 1, pull_request: {} }, comment: { id: 5, user: { id: 30 }, body: "x", updated_at: "2026-01-01T00:00:04.000Z" },
    }), 502, "p1", "1:1");
    assert.ok(store.deferred("1:1"));
    if (launchProof === "missing") store.saveCapability("claude", null, 503);
    const jobsBefore = store.status("1:1").jobs.length;
    // Fake Claude App relay (list/post JSON lines), standing in for the token wrapper session.
    const posted: { event: string; body: string; head: string }[] = [];
    const relaySpawn = () => {
      const out = new EventEmitter();
      const child = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
      child["stdout"] = { on: (e: string, f: (b: Buffer) => void) => out.on(e, f) };
      child["kill"] = () => true;
      child["stdin"] = {
        on: () => child,
        end: () => setImmediate(() => child.emit("exit")),
        write: (line: string) => {
          const r = JSON.parse(line) as Record<string, unknown>;
          let reply: Record<string, unknown>;
          if (r["op"] === "post") {
            posted.push({ event: String(r["event"]), body: String(r["body"]), head: String(r["head"]) });
            reply = { id: r["id"], ok: true };
          } else reply = { id: r["id"], ok: true, reviews: posted.map((x, n) => ({ id: String(900 + n), actor: 30, head: x.head, body: x.body })) };
          setImmediate(() => out.emit("data", Buffer.from(`${JSON.stringify(reply)}\n`)));
          return true;
        },
      };
      return child as never;
    };
    const lines: string[] = [];
    const deps = {
      transport: () => c.fakeGitHub(c.github),
      spawn: () => assert.fail("no worker relaunch"),
      relaySpawn,
      readBytes: () => c.A,
      digest: (path: string) =>
        path === c.install.claude.cliProfile ? c.sha(c.A) : launchProof === "executable-changed" ? "f".repeat(64) : c.EXE,
      platform: "darwin" as const,
    };
    assert.equal(await main(c.args, c.env, (x) => lines.push(x), () => 1000, deps), 0);
    assert.match(lines.join("\n"), /PR #1: resume:posted/, launchProof);
    assert.equal(posted.length, 1);
    assert.equal(posted[0]!.event, "COMMENT");
    assert.match(posted[0]!.body, /^<!-- kurashi-ledger:red-team:v1 -->/);
    assert.equal(store.marked("1:1"), false);
    assert.equal(store.deferred("1:1"), null);
    assert.equal(store.status("1:1").jobs.length, jobsBefore); // no new job, no new quota use
    assert.equal(store.job(j.id)!.status, "posted");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM leases").get()!["n"], 0);
    // The next cycle posts nothing more.
    assert.equal(await main(c.args, c.env, () => {}, () => 1100, deps), 0);
    assert.equal(posted.length, 1);
  } finally {
    c.x.cleanup();
  }
  }
});

test("Round 4 RT-3: doctor and measure hash cli.sb from the one read they use, and see a later swap", async () => {
  const { boundFiles } = await import("./review-dispatch.ts");
  const { createHash } = await import("node:crypto");
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const A = Buffer.from("(version 1)\n(deny default)\n"),
    B = Buffer.from("(version 1)\n(allow default)\n");
  let current = A,
    reads = 0;
  const install = { claude: { cliProfile: "/opt/synthetic/copy/cli.sb", executable: "/opt/synthetic/claude/bin/claude" } } as never;
  const files = boundFiles(install, {
    readBytes: () => {
      reads++;
      return A;
    },
    digest: (path: string) => (path.endsWith("cli.sb") ? sha(current) : "e".repeat(64)),
  });
  assert.equal(reads, 1);
  assert.equal(files.text, A.toString("utf8"));
  assert.equal(files.bound.profileSha256, sha(A)); // from the bytes that were read, not a second read
  assert.equal(files.unchanged(), true);
  current = B;
  assert.equal(files.unchanged(), false);
});

// Issue #50 W10 (PR #59): our own post moves the PR's updated_at late, so the next reconcile sees a drift between
// its two reads of the PR and is held. pulls/1 here returns a later updated_at on every read.
function drifting(inner: import("./lib/review-dispatch/github.ts").Transport): import("./lib/review-dispatch/github.ts").Transport {
  let n = 0;
  return async (endpoint, headers) => {
    const r = await inner(endpoint, headers);
    if (endpoint.replace("/repos/synthetic/repository/", "") !== "pulls/1") return r;
    const v = JSON.parse(r.body) as Record<string, unknown>;
    v["updated_at"] = new Date(Date.parse("2026-01-01T00:00:10Z") + 1000 * ++n).toISOString();
    return { ...r, body: JSON.stringify(v) };
  };
}
// A supervisor that reads the plan and ends without announcing a key: the worker never starts (as in PR56-R005).
function unacknowledged(count: () => void) {
  return () => {
    count();
    const child = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
    child["stdout"] = { on: () => child };
    child["stdin"] = { on: () => child, write: () => (setImmediate(() => child.emit("close", 2)), true), end: () => true };
    child["kill"] = () => true;
    return child as never;
  };
}

test("W10 (PR #59): Ready, faultfinding posted, a held cycle from the updated_at drift, then a complete cycle: the Ready is intact and the review job starts", async (t) => {
  if (process.platform === "win32") {
    t.diagnostic("Windows: the dispatcher refuses to run (host checks are POSIX only)");
    return;
  }
  const { GhReader } = await import("./lib/review-dispatch/github.ts");
  const { reconcile } = await import("./lib/review-dispatch/evidence.ts");
  const { assess } = await import("./lib/review-dispatch/reducer.ts");
  const c = await activeCli();
  try {
    const store = c.x.d.store,
      p = c.x.p;
    // Ready -> faultfinding job (consumes the Ready) -> its clean red-team record posted -> lease released.
    const s = (await reconcile(new GhReader(p.repo, c.fakeGitHub(c.github)), p, store))[0]!.snapshot;
    store.observe(assess(p, s, null, store.consumed()));
    const ready = store.target("1:1")!;
    assert.equal(ready.status, "eligible");
    assert.ok(ready.ready);
    const j = store.claim(p, s, 30, "faultfinding", 500)!;
    assert.ok(j);
    assert.ok(store.consumed().has(ready.ready!));
    store.running(j);
    store.result(j, "{}");
    const id = store.outbox(j, "faultfinding", JSON.stringify({ actor: 30, decision: "accepted", findings: [] }));
    store.sending(id);
    store.posted(id, "900");
    store.release(j, { run: j.run, neverStarted: false, groupEnded: true, uncertain: false });
    const jobs = () => store.status("1:1").jobs.map((x) => `${x.kind}:${x.status}`);
    const before = { target: store.target("1:1"), jobs: jobs() };
    let spawned = 0;
    const deps = (transport: () => import("./lib/review-dispatch/github.ts").Transport, spawn: () => never) => ({
      transport,
      spawn,
      relaySpawn: () => assert.fail("no post in this test"),
      readBytes: () => c.A,
      digest: (path: string) => (path === c.install.claude.cliProfile ? c.sha(c.A) : c.EXE),
      platform: "darwin" as const,
      launch: { platform: "darwin" as const, exists: () => false, readToken: () => "synthetic-setup-token-0123456789abcdef" },
    });
    // Held cycle: nothing is written or launched; the stored target keeps its generation and Ready.
    const lines: string[] = [];
    const held = deps(() => drifting(c.fakeGitHub(c.github)), () => assert.fail("no launch on a held cycle"));
    assert.equal(await main(c.args, c.env, (x) => lines.push(x), () => 1000, held), 0);
    assert.deepEqual(store.target("1:1"), before.target);
    assert.deepEqual(jobs(), before.jobs);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM leases").get()!["n"], 0);
    assert.equal(lines.length, 0);
    // A second held cycle changes nothing either.
    assert.equal(await main(c.args, c.env, () => {}, () => 1001, held), 0);
    assert.deepEqual(store.target("1:1"), before.target);
    // Complete cycle: the original Ready is intact (not new-ready-required) and the next job is the review.
    lines.length = 0;
    const complete = deps(() => c.fakeGitHub(c.github), unacknowledged(() => spawned++));
    assert.equal(await main(c.args, c.env, (x) => lines.push(x), () => 1002, complete), 0);
    const after = store.target("1:1")!;
    assert.equal(after.status, "eligible", after.reason);
    assert.equal(after.ready, ready.ready);
    assert.equal(after.generation, ready.generation);
    assert.ok(spawned >= 1); // the review launch reached the supervisor
    assert.match(lines.join("\n"), /PR #1: review:not-started:not-acknowledged/);
  } finally {
    c.x.cleanup();
  }
});

test("W10 a held cycle never makes a PR eligible: no target, no job, the Ready delivery stays pending until a complete cycle", async (t) => {
  if (process.platform === "win32") {
    t.diagnostic("Windows: the dispatcher refuses to run (host checks are POSIX only)");
    return;
  }
  const c = await activeCli();
  try {
    const store = c.x.d.store;
    let spawned = 0;
    const deps = (transport: () => import("./lib/review-dispatch/github.ts").Transport) => ({
      transport,
      spawn: unacknowledged(() => spawned++),
      readBytes: () => c.A,
      digest: (path: string) => (path === c.install.claude.cliProfile ? c.sha(c.A) : c.EXE),
      platform: "darwin" as const,
      launch: { platform: "darwin" as const, exists: () => false, readToken: () => "synthetic-setup-token-0123456789abcdef" },
    });
    assert.equal(await main(c.args, c.env, () => {}, () => 1000, deps(() => drifting(c.fakeGitHub(c.github)))), 0);
    assert.equal(store.target("1:1"), null);
    assert.equal(spawned, 0);
    assert.equal(store.status("1:1").jobs.length, 0);
    assert.equal(store.consumed().size, 0);
    assert.equal(store.db.prepare("SELECT processed FROM inbox WHERE delivery='ready'").get()!["processed"], 0);
    // The complete cycle binds the Ready and starts the first job (faultfinding).
    const lines: string[] = [];
    assert.equal(await main(c.args, c.env, (x) => lines.push(x), () => 1001, deps(() => c.fakeGitHub(c.github))), 0);
    assert.equal(store.target("1:1")!.status, "eligible");
    assert.match(lines.join("\n"), /PR #1: faultfinding:not-started:not-acknowledged/);
  } finally {
    c.x.cleanup();
  }
});

test("W10 a held re-check right before a post defers it (no POST, nothing spent); the next complete cycle posts it once", async (t) => {
  if (process.platform === "win32") {
    t.diagnostic("Windows: the dispatcher refuses to run (host checks are POSIX only)");
    return;
  }
  const { GhReader } = await import("./lib/review-dispatch/github.ts");
  const { reconcile } = await import("./lib/review-dispatch/evidence.ts");
  const { assess } = await import("./lib/review-dispatch/reducer.ts");
  const { runBinding, signedMessage } = await import("./lib/review-dispatch/provenance.ts");
  const { hash } = await import("./lib/review-dispatch/model.ts");
  const { fixtureResult } = await import("./lib/review-dispatch/runtime.ts");
  const { TestSigner } = await import("../tests/fixtures/review-dispatch-run-signer.ts");
  const c = await activeCli();
  try {
    const store = c.x.d.store,
      p = c.x.p;
    // A signed faultfinding result waiting for its post (as in PR56-R003, without the edit mark).
    const s = (await reconcile(new GhReader(p.repo, c.fakeGitHub(c.github)), p, store))[0]!.snapshot;
    store.observe(assess(p, s, null));
    const j = store.claim(p, s, 30, "faultfinding", 500)!;
    store.running(j);
    const signer = new TestSigner();
    store.saveRunKey(j, { run: j.run, binding: runBinding(j), key: signer.publicKey() }, 501);
    store.saveRunMaterials(j.run, { planPath: null, ledger: [], previousRts: [] });
    const raw = JSON.stringify({ ...fixtureResult(j), decision: "accepted", unverified: [] });
    store.result(j, raw, { run: j.run, actor: 30, resultHash: hash(raw), signature: signer.sign(signedMessage(j.run, runBinding(j), hash(raw))) });
    const ready = store.target("1:1");
    // Fake Claude App relay (list/post JSON lines), as in PR56-R003.
    const posted: { head: string; body: string }[] = [];
    const relaySpawn = () => {
      const out = new EventEmitter();
      const child = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
      child["stdout"] = { on: (e: string, f: (b: Buffer) => void) => out.on(e, f) };
      child["kill"] = () => true;
      child["stdin"] = {
        on: () => child,
        end: () => setImmediate(() => child.emit("exit")),
        write: (line: string) => {
          const r = JSON.parse(line) as Record<string, unknown>;
          if (r["op"] === "post") posted.push({ head: String(r["head"]), body: String(r["body"]) });
          const reply =
            r["op"] === "post"
              ? { id: r["id"], ok: true }
              : { id: r["id"], ok: true, reviews: posted.map((x, n) => ({ id: String(900 + n), actor: 30, ...x })) };
          setImmediate(() => out.emit("data", Buffer.from(`${JSON.stringify(reply)}\n`)));
          return true;
        },
      };
      return child as never;
    };
    // The cycle's own reconcile is complete (two reads of the PR); from the re-check on, updated_at drifts.
    const late = () => {
      const inner = c.fakeGitHub(c.github),
        drift = drifting(inner);
      let reads = 0;
      return (async (endpoint, headers) => {
        if (endpoint.endsWith("/pulls/1") && ++reads > 2) return drift(endpoint, headers);
        return inner(endpoint, headers);
      }) as import("./lib/review-dispatch/github.ts").Transport;
    };
    const deps = (transport: () => import("./lib/review-dispatch/github.ts").Transport) => ({
      transport,
      spawn: () => assert.fail("no worker relaunch"),
      relaySpawn,
      readBytes: () => c.A,
      digest: (path: string) => (path === c.install.claude.cliProfile ? c.sha(c.A) : c.EXE),
      platform: "darwin" as const,
    });
    const lines: string[] = [];
    assert.equal(await main(c.args, c.env, (x) => lines.push(x), () => 1000, deps(late)), 0);
    assert.match(lines.join("\n"), /PR #1: resume:deferred/);
    assert.equal(posted.length, 0);
    assert.equal(store.deferred("1:1")?.job.id, j.id); // result and lease kept, not released as stale
    assert.deepEqual(store.target("1:1"), ready);
    lines.length = 0;
    assert.equal(await main(c.args, c.env, (x) => lines.push(x), () => 1001, deps(() => c.fakeGitHub(c.github))), 0);
    assert.match(lines.join("\n"), /PR #1: resume:posted/);
    assert.equal(posted.length, 1);
    assert.equal(store.job(j.id)!.status, "posted");
  } finally {
    c.x.cleanup();
  }
});
