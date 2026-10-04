import assert from "node:assert/strict";
import { test } from "node:test";
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
      configDir: "/srv/synthetic/dispatch/claude-config",
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

test("W4 cycle: active needs the start-small shape and an install record before any GitHub read; no bound capability, no launch", async () => {
  if (process.platform === "win32") return; // the dispatcher and its host checks are macOS/POSIX only
  const { fakeGitHub } = await import("../tests/fixtures/review-dispatch-github.ts");
  const x = await cliSetup();
  try {
    const github = { ready: true, now: 5, calls: 0 };
    const deps = {
      transport: () => fakeGitHub(github),
      spawn: () => assert.fail("no supervisor without a bound capability"),
      digest: () => "e".repeat(64),
      readText: () => "(version 1)",
    };
    const env = { ...x.env, GH_TOKEN: "synthetic-dispatch-read" };
    const { HEAD, BASE } = await import("../tests/fixtures/review-dispatch.ts");
    // A signed Ready delivery (stored by the receiver) that the reconcile binds to the exact pair.
    x.d.store.inbox(3, "ready", "pull_request", JSON.stringify({
      repository: { id: 1 }, installation: { id: 2 }, sender: { id: 20 }, action: "ready_for_review",
      pull_request: { number: 1, updated_at: "2026-01-01T00:00:03.000Z", head: { sha: HEAD }, base: { sha: BASE } },
    }), 1);
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
