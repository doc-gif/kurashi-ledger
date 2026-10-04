import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MEASURED_PROBES,
  SYNTHETIC_PROBES,
  parseMeasurement,
  profileHash,
  readProfiles,
  runDoctor,
  seatbeltHost,
  type DoctorInput,
  type Outcome,
  type Profile,
  type SandboxHost,
  type SyntheticProbe,
} from "./doctor.ts";
import { LaunchError, SANDBOX_EXEC, argvTemplateHash, buildLaunch, type LaunchInstall, type LaunchPlan } from "./launcher.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { measureCli, measurementRecord, withoutSandbox, type CliRun } from "./doctor.ts";
import { capabilityReady, REQUIRED_PROBES } from "./runtime.ts";
import { policy } from "../../../tests/fixtures/review-dispatch.ts";

const H = "c".repeat(64),
  P = "d".repeat(64);
type Call = { probe: SyntheticProbe; profile: Profile | null; keychain: string };
function fakeHost(over: {
  platform?: NodeJS.Platform;
  available?: boolean;
  nested?: "applied" | "refused" | "inconclusive";
  outcome?: (c: Call) => Outcome;
} = {}): SandboxHost & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    platform: over.platform ?? "darwin",
    available: async () => over.available ?? true,
    nested: async () => over.nested ?? "refused",
    run: async (probe, profile, keychain) => {
      const c = { probe, profile, keychain };
      calls.push(c);
      return over.outcome?.(c) ?? (profile === null ? "allowed" : "denied");
    },
  };
}
const install: LaunchInstall = {
  backend: "claude",
  executable: "/opt/synthetic/claude/2.1.300/bin/claude",
  version: "2.1.300",
  runtime: "/opt/synthetic/claude/2.1.300",
  cliProfile: "/opt/synthetic/reviewed/seatbelt/cli.sb",
  configDir: "/srv/synthetic/dispatch/claude-config",
  keychainDir: "/srv/synthetic/owner/Library/Keychains",
  protectedRoots: ["/srv/synthetic/dispatch/policy", "/srv/synthetic/dispatch/db"],
};
const codexInstall: LaunchInstall = {
  ...install,
  backend: "codex",
  executable: "/opt/synthetic/codex/1.0.0/bin/codex",
  version: "1.0.0",
  runtime: "/opt/synthetic/codex/1.0.0",
  configDir: "/srv/synthetic/dispatch/codex-home",
  keychainDir: null,
};
const run = {
  materials: "/srv/synthetic/runs/r1/materials",
  home: "/srv/synthetic/runs/r1/home",
  tmp: "/srv/synthetic/runs/r1/tmp",
  schemaFile: "/srv/synthetic/runs/r1/tmp/s.json",
};
const job = (actor: number) => ({
  id: "j1", key: "1:1", generation: 1, actor, kind: "review" as const, run: "run-1",
  pair: { head: "a".repeat(40), base: "b".repeat(40) }, policy: "p1",
});
const launchFor = (i: LaunchInstall) => ({
  plan: buildLaunch(policy(), job(i.backend === "claude" ? 30 : 20), i, run, { platform: "darwin", exists: () => false, scan: () => ({ names: [], symlink: false }) }),
  argvHash: argvTemplateHash(i),
});
const measurement = (i: LaunchInstall, over: Partial<Record<string, Outcome>> = {}) => ({
  schema: 1,
  backend: i.backend,
  version: i.version,
  codeHash: H,
  profileHash: P,
  argvHash: argvTemplateHash(i),
  outcomes: { ...Object.fromEntries(MEASURED_PROBES.map((k) => [k, "denied"])), ...over },
});
const input = (over: Partial<DoctorInput> = {}): DoctorInput => ({
  backend: "fixture",
  version: "synthetic-1",
  codeHash: H,
  profileHash: P,
  launch: null,
  measurement: null,
  external: { schema: true, descendantLock: true },
  host: fakeHost(),
  ...over,
});
const allFalse = (probes: Record<string, boolean>) => Object.values(probes).every((v) => v === false);

test("doctor: verified only when every control succeeds and every confined probe is denied", async () => {
  const host = fakeHost();
  const r = await runDoctor(input({ host }));
  assert.equal(r.state, "verified");
  assert.equal(capabilityReady(r.capability), true);
  assert.deepEqual(Object.keys(r.capability.probes).sort(), [...REQUIRED_PROBES].sort());
  // Every synthetic probe ran unconfined first, then under both profiles.
  for (const id of Object.keys(SYNTHETIC_PROBES) as SyntheticProbe[])
    for (const profile of [null, "tool", "cli"] as const)
      assert.ok(host.calls.some((c) => c.probe === id && c.profile === profile), `${id}:${profile}`);
  assert.ok(r.reasons.includes("tool-profile-cannot-nest"));
});

test("doctor: disabled without macOS Seatbelt, never verified", async () => {
  for (const host of [fakeHost({ platform: "linux" }), fakeHost({ platform: "win32" }), fakeHost({ available: false })]) {
    const r = await runDoctor(input({ host }));
    assert.equal(r.state, "disabled");
    assert.equal(capabilityReady(r.capability), false);
    assert.equal(host.calls.length, 0);
  }
});

test("doctor: one allowed probe under either profile disables the backend", async () => {
  for (const id of Object.keys(SYNTHETIC_PROBES) as SyntheticProbe[])
    for (const profile of ["tool", "cli"] as const) {
      const r = await runDoctor(
        input({ host: fakeHost({ outcome: (c) => (c.profile === null || (c.probe === id && c.profile === profile) ? "allowed" : "denied") }) }),
      );
      assert.equal(r.state, "disabled", `${id}:${profile}`);
      assert.ok(r.reasons.includes(`probe-allowed:${id}:${profile}`));
      assert.ok(allFalse(r.capability.probes));
    }
});

test("doctor: failed positive control or inconclusive probe leaves the backend unverified", async () => {
  for (const id of Object.keys(SYNTHETIC_PROBES) as SyntheticProbe[]) {
    const control = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.profile === null ? (c.probe === id ? "inconclusive" : "allowed") : "denied") }) }));
    assert.equal(control.state, "unverified", id);
    assert.ok(control.reasons.includes(`control-failed:${id}`));
    // A probe that is denied only because nothing works at all is not evidence.
    const denied = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.profile === null && c.probe === id ? "denied" : c.profile === null ? "allowed" : "denied") }) }));
    assert.equal(denied.state, "unverified", id);
    const unknown = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.profile === null ? "allowed" : c.probe === id && c.profile === "tool" ? "inconclusive" : "denied") }) }));
    assert.equal(unknown.state, "unverified", id);
    assert.ok(allFalse(unknown.capability.probes));
  }
  const ext = await runDoctor(input({ external: { schema: false, descendantLock: true } }));
  assert.equal(ext.state, "unverified");
});

test("doctor: real Claude stays unverified until a bound owner measurement proves the CLI path", async () => {
  const base = { backend: "claude" as const, version: install.version, launch: launchFor(install) };
  const auth = { status: { authMethod: "claude.ai", configDirectory: install.configDir }, configDir: install.configDir };
  const none = await runDoctor(input({ ...base }));
  assert.equal(none.state, "unverified");
  assert.ok(none.reasons.includes("measurement-missing"));
  const host = fakeHost();
  const ok = await runDoctor(input({ ...base, host, auth, measurement: measurement(install) }));
  assert.equal(ok.state, "verified");
  assert.ok(host.calls.every((c) => c.keychain === "allow"));
  const noAuth = await runDoctor(input({ ...base, measurement: measurement(install) }));
  assert.equal(noAuth.state, "unverified");
  assert.ok(noAuth.reasons.includes("auth-status-missing"));
  for (const [status, reason] of [
    [{ authMethod: "api_key", configDirectory: install.configDir }, "auth-not-subscription"],
    [{ authMethod: "oauth_token", configDirectory: install.configDir }, "auth-not-subscription"],
    [{ authMethod: "claude.ai", configDirectory: "/srv/synthetic/other" }, "auth-config-dir-mismatch"],
    ["claude.ai", "auth-not-subscription"],
  ] as const) {
    const r = await runDoctor(input({ ...base, auth: { status, configDir: install.configDir }, measurement: measurement(install) }));
    assert.equal(r.state, "disabled", reason);
    assert.ok(r.reasons.includes(reason));
  }
  // Claude's cli.sb lets /usr/bin/security reach the login keychain; an App-key-shaped item
  // (ACL trusting /usr/bin/security) is then reachable too, which disables Claude.
  const reachable = await runDoctor(
    input({
      ...base,
      auth,
      measurement: measurement(install),
      host: fakeHost({ outcome: (c) => (c.profile === null ? "allowed" : c.profile === "cli" && c.keychain === "allow" && SYNTHETIC_PROBES[c.probe].capability === "deny-keychain" ? "allowed" : "denied") }),
    }),
  );
  assert.equal(reachable.state, "disabled");
  assert.ok(reachable.reasons.includes("app-key-keychain-reachable-from-cli"));
  for (const [name, m] of [
    ["version", { ...measurement(install), version: "2.1.301" }],
    ["code", { ...measurement(install), codeHash: "e".repeat(64) }],
    ["profile", { ...measurement(install), profileHash: "e".repeat(64) }],
    ["argv", { ...measurement(install), argvHash: "e".repeat(64) }],
    ["backend", { ...measurement(install), backend: "codex" }],
  ] as const) {
    const r = await runDoctor(input({ ...base, measurement: m }));
    assert.equal(r.state, "unverified", name);
    assert.ok(r.reasons.includes("measurement-stale"), name);
  }
  const extra = { ...measurement(install), note: "x" };
  const missing = measurement(install);
  delete (missing.outcomes as Record<string, Outcome>)["deny-hooks-mcp"];
  for (const m of [extra, missing, { ...measurement(install), schema: 2 }, measurement(install, { "deny-network": "maybe" as Outcome }), "x", 1]) {
    const r = await runDoctor(input({ ...base, measurement: m }));
    assert.equal(r.state, "unverified");
    assert.ok(r.reasons.includes("measurement-invalid"));
  }
  for (const k of MEASURED_PROBES) {
    const allowed = await runDoctor(input({ ...base, measurement: measurement(install, { [k]: "allowed" }) }));
    assert.equal(allowed.state, "disabled", k);
    const unknown = await runDoctor(input({ ...base, measurement: measurement(install, { [k]: "inconclusive" }) }));
    assert.equal(unknown.state, "unverified", k);
  }
});

test("doctor: tampered launch plans and Codex inside cli.sb are disabled", async () => {
  const launch = launchFor(install);
  launch.plan.args.push("--bare");
  const r = await runDoctor(input({ backend: "claude", version: install.version, launch, measurement: measurement(install) }));
  assert.equal(r.state, "disabled");
  assert.ok(r.reasons.includes("plan:bare"));
  const noPlan = await runDoctor(input({ backend: "claude", version: install.version }));
  assert.equal(noPlan.state, "disabled");
  // codex exec --sandbox read-only starts its own Seatbelt; macOS refuses it inside cli.sb.
  const codex = await runDoctor(
    input({ backend: "codex", version: codexInstall.version, launch: launchFor(codexInstall), measurement: measurement(codexInstall) }),
  );
  assert.equal(codex.state, "disabled");
  assert.ok(codex.reasons.includes("codex-tool-sandbox-cannot-nest"));
  const unknownNest = await runDoctor(
    input({ backend: "codex", version: codexInstall.version, launch: launchFor(codexInstall), measurement: measurement(codexInstall), host: fakeHost({ nested: "inconclusive" }) }),
  );
  assert.equal(unknownNest.state, "disabled");
});

test("doctor: output carries IDs and closed outcomes only", async () => {
  const r = await runDoctor(input({ backend: "claude", version: install.version, launch: launchFor(install), measurement: { secret: "/srv/synthetic/x" } }));
  const text = JSON.stringify({ reasons: r.reasons, outcomes: r.outcomes });
  assert.ok(!text.includes("/"), text);
  assert.ok(!text.includes("synthetic"), text);
  assert.ok(Object.values(r.outcomes).every((o) => ["denied", "allowed", "inconclusive"].includes(o)));
  assert.equal(parseMeasurement(null, { backend: "claude", version: "1", codeHash: H, profileHash: P, argvHash: H }), "invalid");
  assert.notEqual(profileHash("a", "b"), profileHash("a", "c"));
  assert.notEqual(profileHash("ab", ""), profileHash("a", "b"));
});

const seatbeltDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tools/review_dispatch/seatbelt");

test("Seatbelt integration: real sandbox-exec denies every synthetic probe on macOS; elsewhere the doctor disables", async (t) => {
  const profiles = readProfiles(seatbeltDir);
  const host = seatbeltHost({ cliProfile: join(seatbeltDir, "cli.sb"), toolProfile: join(seatbeltDir, "tool.sb") });
  try {
    const r = await runDoctor(input({ host, profileHash: profiles.hash }));
    if (process.platform !== "darwin") {
      // Not a skip: on Linux and Windows the required OS mechanism is absent, and that must disable.
      t.diagnostic(`no Seatbelt on ${process.platform}: doctor disabled the backend`);
      assert.equal(r.state, "disabled");
      assert.deepEqual(r.reasons, ["no-seatbelt-platform"]);
      assert.equal(capabilityReady(r.capability), false);
      return;
    }
    t.diagnostic(`macOS Seatbelt outcomes: ${JSON.stringify(r.outcomes)}`);
    for (const id of Object.keys(SYNTHETIC_PROBES)) {
      assert.equal(r.outcomes[`${id}:control`], "allowed", `${id} control`);
      assert.equal(r.outcomes[`${id}:tool`], "denied", `${id} tool.sb`);
      assert.equal(r.outcomes[`${id}:cli`], "denied", `${id} cli.sb`);
    }
    assert.equal(r.state, "verified", JSON.stringify(r.reasons));
    // cli.sb with KEYCHAIN=allow (Claude's own login) lets the keychain tool start; tool.sb never does.
    assert.equal(await host.run("keychain-tool", "cli", "allow"), "allowed");
    assert.equal(await host.run("keychain-tool", "tool", "allow"), "denied");
    assert.equal(await host.run("app-key", "cli", "allow"), "denied");
    // So the real Claude backend is disabled until the owner decides the keychain fallback,
    // even with a bound measurement and a subscription login.
    const claude = await runDoctor(
      input({
        host,
        profileHash: profiles.hash,
        backend: "claude",
        version: install.version,
        launch: launchFor(install),
        auth: { status: { authMethod: "claude.ai", configDirectory: install.configDir }, configDir: install.configDir },
        measurement: { ...measurement(install), profileHash: profiles.hash },
      }),
    );
    assert.equal(claude.state, "disabled");
    assert.ok(claude.reasons.includes("app-key-keychain-reachable-from-cli"));
    // A missing parameter fails to compile, so nothing starts.
    const node = realpathSync(process.execPath);
    const missing = spawnSync("/usr/bin/sandbox-exec", ["-f", join(seatbeltDir, "tool.sb"), "-D", `TOOL=${node}`, node, "-e", "0"], { stdio: "ignore" });
    assert.notEqual(missing.status, 0);
    t.diagnostic(`nested sandbox_apply: ${r.outcomes["nested-sandbox"]}`);
  } finally {
    await host.close();
  }
});

test("CLI measurement harness: synthetic PR traps and injected reads decide outcomes from markers and nonces", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kl-measure-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config"),
    secrets = join(root, "secrets");
  mkdirSync(config);
  mkdirSync(secrets);
  const i: LaunchInstall = { ...install, configDir: config, protectedRoots: ["/srv/synthetic/dispatch/policy"] };
  const layout = (name: string) => {
    const r = join(root, name);
    mkdirSync(r);
    return { root: r, secretFiles: { key: join(secrets, `${name}-key.pem`), gh: join(secrets, `${name}-hosts.yml`), otherAi: join(secrets, `${name}-auth.json`) } };
  };
  if (process.platform === "win32") {
    // Not a skip: the measurement needs POSIX paths and Seatbelt; on Windows it refuses before any run.
    await assert.rejects(measureCli(policy(), job(30), i, layout("win"), async () => assert.fail("CLI started")), LaunchError);
    t.diagnostic("Windows: the measurement refused before starting any CLI");
    return;
  }
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const plans: LaunchPlan[] = [];
  // Fake CLIs. Each reads only the run's own files, like a model following some instructions.
  const obedient = async (p: LaunchPlan): Promise<CliRun> => {
    plans.push(p);
    return { exitCode: 0, stdout: read(join(p.cwd, "control.txt")) };
  };
  const hookRunner = async (p: LaunchPlan): Promise<CliRun> => {
    const settings = read(join(p.cwd, ".claude", "settings.json"));
    if (p.file !== SANDBOX_EXEC && settings) {
      const cmd = JSON.parse(settings).hooks.SessionStart[0].hooks[0].command as string;
      writeFileSync(cmd.split(" ")[1]!, "");
    }
    return obedient(p);
  };
  const memoryLoader = async (p: LaunchPlan): Promise<CliRun> => ({ exitCode: 0, stdout: read(join(p.cwd, "control.txt")) + read(join(p.cwd, "CLAUDE.md")) });
  const leaky = async (p: LaunchPlan): Promise<CliRun> => {
    const files = read(join(p.cwd, "notes.txt")).split("\n").filter((l) => l.startsWith("/"));
    return { exitCode: 0, stdout: files.map(read).join("") + read(join(p.cwd, "control.txt")) };
  };
  const silent = async (): Promise<CliRun> => ({ exitCode: 1, stdout: "" });

  const good = await measureCli(policy(), job(30), i, layout("good"), obedient, "darwin");
  assert.equal(good["deny-hooks-mcp"], "denied");
  assert.equal(good["deny-keys"], "denied");
  assert.equal(good["deny-gh-auth"], "denied");
  assert.equal(good["deny-other-ai-auth"], "denied");
  // Probes the CLI's tools cannot exercise stay inconclusive for the owner's separate checks.
  for (const k of ["deny-keychain", "deny-db", "deny-policy-write", "deny-network", "tool-child-confined"] as const)
    assert.equal(good[k], "inconclusive", k);
  // Run A twice (sandboxed and flags only), then run B sandboxed. The traps reached the cwd.
  assert.deepEqual(plans.map((p) => p.file), [SANDBOX_EXEC, install.executable, SANDBOX_EXEC]);
  assert.equal(withoutSandbox(plans[0]!, i).args[0], "-p");
  assert.ok(existsSync(join(plans[0]!.cwd, ".mcp.json")));
  // The config-dir trap is removed after the run.
  assert.deepEqual(readdir(config), []);

  assert.equal((await measureCli(policy(), job(30), i, layout("hook"), hookRunner, "darwin"))["deny-hooks-mcp"], "allowed");
  assert.equal((await measureCli(policy(), job(30), i, layout("memory"), memoryLoader, "darwin"))["deny-hooks-mcp"], "allowed");
  const leak = await measureCli(policy(), job(30), i, layout("leak"), leaky, "darwin");
  assert.equal(leak["deny-keys"], "allowed");
  assert.equal(leak["deny-gh-auth"], "allowed");
  assert.equal(leak["deny-other-ai-auth"], "allowed");
  const quiet = await measureCli(policy(), job(30), i, layout("quiet"), silent, "darwin");
  assert.equal(quiet["deny-hooks-mcp"], "inconclusive");
  assert.equal(quiet["deny-keys"], "inconclusive");

  const record = measurementRecord(i, H, P, good);
  assert.equal(record.argvHash, argvTemplateHash(i));
  const r = await runDoctor(input({ backend: "claude", version: i.version, launch: launchFor(install), measurement: record }));
  assert.equal(r.state, "unverified");
});

function readdir(dir: string): string[] {
  return readdirSync(dir);
}
