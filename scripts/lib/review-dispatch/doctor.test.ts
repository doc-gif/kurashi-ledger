import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MEASURED_PROBES,
  SYNTHETIC_PROBES,
  inspectConfigDir,
  lintProfile,
  managedSettingsPresent,
  measureCli,
  measurementRecord,
  parseMeasurement,
  profileHash,
  readProfile,
  runDoctor,
  seatbeltHost,
  spawnExecutor,
  withoutSandbox,
  type CliRun,
  type DoctorInput,
  type Mode,
  type Outcome,
  type SandboxHost,
  type SyntheticProbe,
  type TrapLayout,
} from "./doctor.ts";
import { LaunchError, SANDBOX_EXEC, TOKEN_ENV, argvTemplateHash, buildLaunch, type LaunchInstall, type LaunchPlan } from "./launcher.ts";
import { capabilityReady, REQUIRED_PROBES } from "./runtime.ts";
import { policy } from "../../../tests/fixtures/review-dispatch.ts";

const H = "c".repeat(64),
  P = "d".repeat(64);
const TOKEN = "synthetic-setup-token-0123456789abcdef";
const seatbeltDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tools/review_dispatch/seatbelt");
const PROFILE = readFileSync(join(seatbeltDir, "cli.sb"), "utf8");
type Call = { probe: SyntheticProbe; mode: Mode };
function fakeHost(over: {
  platform?: NodeJS.Platform;
  available?: boolean;
  outcome?: (c: Call) => Outcome;
} = {}): SandboxHost & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    platform: over.platform ?? "darwin",
    available: async () => over.available ?? true,
    run: async (probe, mode) => {
      const c = { probe, mode };
      calls.push(c);
      return over.outcome?.(c) ?? (mode === "control" ? "allowed" : "denied");
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
  tokenFile: "/srv/synthetic/owner-secrets/claude-setup-token",
  protectedRoots: ["/srv/synthetic/dispatch/policy", "/srv/synthetic/dispatch/db"],
};
const codexInstall: LaunchInstall = {
  ...install,
  backend: "codex",
  executable: "/opt/synthetic/codex/1.0.0/bin/codex",
  version: "1.0.0",
  runtime: "/opt/synthetic/codex/1.0.0",
  cliProfile: null,
  configDir: "/srv/synthetic/dispatch/codex-home",
  tokenFile: null,
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
const opts = { platform: "darwin" as const, exists: () => false, scan: () => ({ names: [], symlink: false }), readToken: () => TOKEN };
const launchFor = (i: LaunchInstall) => ({
  plan: buildLaunch(policy(), job(i.backend === "claude" ? 30 : 20), i, run, opts),
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
const facts = (over: Partial<NonNullable<DoctorInput["claude"]>> = {}) => ({
  authStatus: { authMethod: "oauth_token", configDirectory: install.configDir },
  configDir: install.configDir,
  configProblems: [],
  managedSettings: false,
  ...over,
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
  profileText: PROFILE,
  ...over,
});
const claudeInput = (over: Partial<DoctorInput> = {}) =>
  input({ backend: "claude", version: install.version, launch: launchFor(install), claude: facts(), measurement: measurement(install), ...over });
const codexInput = (over: Partial<DoctorInput> = {}) =>
  input({ backend: "codex", version: codexInstall.version, launch: launchFor(codexInstall), measurement: measurement(codexInstall), profileText: null, ...over });
const allFalse = (probes: Record<string, boolean>) => Object.values(probes).every((v) => v === false);
const probeIds = Object.keys(SYNTHETIC_PROBES) as SyntheticProbe[];

test("doctor: verified only when every control succeeds and every confined probe and grandchild is denied", async () => {
  const host = fakeHost();
  const r = await runDoctor(input({ host }));
  assert.equal(r.state, "verified", JSON.stringify(r.reasons));
  assert.equal(capabilityReady(r.capability), true);
  assert.deepEqual(Object.keys(r.capability.probes).sort(), [...REQUIRED_PROBES].sort());
  for (const id of probeIds) {
    assert.ok(host.calls.some((c) => c.probe === id && c.mode === "control"), id);
    assert.ok(host.calls.some((c) => c.probe === id && c.mode === "cli"), id);
    assert.equal(host.calls.some((c) => c.probe === id && c.mode === "cli-child"), SYNTHETIC_PROBES[id].child, id);
  }
});

test("doctor: disabled without macOS Seatbelt, never verified", async () => {
  for (const host of [fakeHost({ platform: "linux" }), fakeHost({ platform: "win32" }), fakeHost({ available: false })]) {
    const r = await runDoctor(input({ host }));
    assert.equal(r.state, "disabled");
    assert.equal(capabilityReady(r.capability), false);
    assert.equal(host.calls.length, 0);
  }
});

test("doctor: one allowed probe, directly or in the grandchild, disables the backend", async () => {
  for (const id of probeIds)
    for (const mode of ["cli", "cli-child"] as const) {
      if (mode === "cli-child" && !SYNTHETIC_PROBES[id].child) continue;
      const r = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.mode === "control" || (c.probe === id && c.mode === mode) ? "allowed" : "denied") }) }));
      assert.equal(r.state, "disabled", `${id}:${mode}`);
      assert.ok(r.reasons.includes(`probe-allowed:${id}:${mode}`));
      assert.ok(allFalse(r.capability.probes));
    }
});

test("doctor: failed control or inconclusive probe leaves the backend unverified; a broken inheritance check blocks tool-child-confined", async () => {
  for (const id of probeIds) {
    const control = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.mode === "control" ? (c.probe === id ? "inconclusive" : "allowed") : "denied") }) }));
    assert.equal(control.state, "unverified", id);
    assert.ok(control.reasons.includes(`control-failed:${id}`));
    // "Denied" because nothing works at all is not evidence.
    const nothing = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.mode === "control" && c.probe === id ? "denied" : c.mode === "control" ? "allowed" : "denied") }) }));
    assert.equal(nothing.state, "unverified", id);
    const unknown = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.mode === "control" ? "allowed" : c.probe === id && c.mode === "cli" ? "inconclusive" : "denied") }) }));
    assert.equal(unknown.state, "unverified", id);
    assert.ok(allFalse(unknown.capability.probes));
  }
  const child = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.mode === "control" ? "allowed" : c.mode === "cli-child" && c.probe === "db-write" ? "inconclusive" : "denied") }) }));
  assert.equal(child.state, "unverified");
  assert.equal(await runDoctor(input({ external: { schema: false, descendantLock: true } })).then((r) => r.state), "unverified");
});

test("doctor: cli.sb lint refuses rules that open the boundary", async () => {
  assert.deepEqual(lintProfile(PROFILE), []);
  const bad: [string, string][] = [
    [PROFILE.replace("(deny default)", "(allow default)"), "not-deny-default"],
    [`${PROFILE}\n(allow process-info* (target others))`, "process-access"],
    [`${PROFILE}\n(allow mach-task-name)`, "process-access"],
    [`${PROFILE}\n(allow signal)`, "signal-outside"],
    [`${PROFILE}\n(allow mach-lookup (global-name "com.apple.SecurityServer"))`, "keychain"],
    [PROFILE.replace('(deny process-exec (literal "/usr/bin/security"))', ""), "keychain-deny-missing"],
  ];
  for (const [text, problem] of bad) {
    assert.ok(lintProfile(text).includes(problem), problem);
    const r = await runDoctor(input({ profileText: text }));
    assert.equal(r.state, "disabled", problem);
  }
  const missing = await runDoctor(input({ profileText: null }));
  assert.equal(missing.state, "unverified");
  assert.ok(missing.reasons.includes("profile-text-missing"));
});

test("doctor: Claude needs setup-token auth, a clean config dir, no managed settings and a bound measurement", async () => {
  assert.equal((await runDoctor(claudeInput())).state, "verified");
  const none = await runDoctor(claudeInput({ measurement: null }));
  assert.equal(none.state, "unverified");
  assert.ok(none.reasons.includes("measurement-missing"));
  assert.equal((await runDoctor(claudeInput({ claude: null }))).state, "unverified");
  assert.equal((await runDoctor(claudeInput({ claude: facts({ authStatus: null }) }))).state, "unverified");
  for (const [status, reason] of [
    [{ authMethod: "claude.ai", configDirectory: install.configDir }, "auth-not-setup-token"],
    [{ authMethod: "api_key", configDirectory: install.configDir }, "auth-not-setup-token"],
    [{ authMethod: "api_key_helper", configDirectory: install.configDir }, "auth-not-setup-token"],
    [{ authMethod: "third_party", configDirectory: install.configDir }, "auth-not-setup-token"],
    [{ authMethod: "oauth_token", configDirectory: "/srv/synthetic/other" }, "auth-config-dir-mismatch"],
    ["oauth_token", "auth-not-setup-token"],
  ] as const) {
    const r = await runDoctor(claudeInput({ claude: facts({ authStatus: status }) }));
    assert.equal(r.state, "disabled", reason);
    assert.ok(r.reasons.includes(reason));
  }
  const dirty = await runDoctor(claudeInput({ claude: facts({ configProblems: ["apiKeyHelper:settings.json"] }) }));
  assert.equal(dirty.state, "disabled");
  assert.ok(dirty.reasons.includes("config-dir:apiKeyHelper:settings.json"));
  const managed = await runDoctor(claudeInput({ claude: facts({ managedSettings: true }) }));
  assert.equal(managed.state, "unverified");
  assert.ok(managed.reasons.includes("managed-settings-present"));
  for (const [name, m] of [
    ["version", { ...measurement(install), version: "2.1.301" }],
    ["code", { ...measurement(install), codeHash: "e".repeat(64) }],
    ["profile", { ...measurement(install), profileHash: "e".repeat(64) }],
    ["argv", { ...measurement(install), argvHash: "e".repeat(64) }],
    ["backend", { ...measurement(install), backend: "codex" }],
  ] as const) {
    const r = await runDoctor(claudeInput({ measurement: m }));
    assert.equal(r.state, "unverified", name);
    assert.ok(r.reasons.includes("measurement-stale"), name);
  }
  const missing = measurement(install);
  delete (missing.outcomes as Record<string, Outcome>)["deny-supervisor"];
  for (const m of [{ ...measurement(install), note: "x" }, missing, { ...measurement(install), schema: 2 }, measurement(install, { "deny-network": "maybe" as Outcome }), "x", 1]) {
    const r = await runDoctor(claudeInput({ measurement: m }));
    assert.equal(r.state, "unverified");
    assert.ok(r.reasons.includes("measurement-invalid"));
  }
  for (const k of MEASURED_PROBES) {
    assert.equal((await runDoctor(claudeInput({ measurement: measurement(install, { [k]: "allowed" }) }))).state, "disabled", k);
    assert.equal((await runDoctor(claudeInput({ measurement: measurement(install, { [k]: "inconclusive" }) }))).state, "unverified", k);
  }
  // The App-key-shaped item readable from cli.sb disables Claude.
  const item = await runDoctor(claudeInput({ host: fakeHost({ outcome: (c) => (c.mode === "control" || c.probe === "app-key-item" ? "allowed" : "denied") }) }));
  assert.equal(item.state, "disabled");
  assert.ok(item.reasons.includes("probe-allowed:app-key-item:cli"));
});

test("doctor: Codex runs no synthetic Seatbelt probes and depends only on its measurement", async () => {
  const host = fakeHost();
  const ok = await runDoctor(codexInput({ host }));
  assert.equal(ok.state, "verified", JSON.stringify(ok.reasons));
  assert.equal(host.calls.length, 0);
  assert.equal((await runDoctor(codexInput({ measurement: null }))).state, "unverified");
  for (const k of MEASURED_PROBES)
    assert.equal((await runDoctor(codexInput({ measurement: measurement(codexInstall, { [k]: "allowed" }) }))).state, "disabled", k);
  const wrapped = launchFor(codexInstall);
  wrapped.plan = { ...wrapped.plan, file: SANDBOX_EXEC, args: ["-f", "/opt/x/cli.sb", codexInstall.executable, ...wrapped.plan.args] };
  const r = await runDoctor(codexInput({ launch: wrapped }));
  assert.equal(r.state, "disabled");
  assert.ok(r.reasons.includes("plan:codex-wrapped"));
});

test("doctor: tampered Claude plans are disabled; output carries IDs and closed outcomes only", async () => {
  const launch = launchFor(install);
  launch.plan.args.push("--bare");
  const r = await runDoctor(claudeInput({ launch }));
  assert.equal(r.state, "disabled");
  assert.ok(r.reasons.includes("plan:bare"));
  assert.equal((await runDoctor(claudeInput({ launch: null }))).state, "disabled");
  const out = await runDoctor(claudeInput({ measurement: { secret: "/srv/synthetic/x" } }));
  const text = JSON.stringify({ reasons: out.reasons, outcomes: out.outcomes, capability: out.capability });
  assert.ok(!text.includes("/") && !text.includes("synthetic") && !text.includes(TOKEN), text);
  assert.ok(Object.values(out.outcomes).every((o) => ["denied", "allowed", "inconclusive"].includes(o)));
  assert.equal(parseMeasurement(null, { backend: "claude", version: "1", codeHash: H, profileHash: P, argvHash: H }), "invalid");
  assert.notEqual(profileHash("a"), profileHash("b"));
});

test("config dir inspection and managed settings detection", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kl-config-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(inspectConfigDir(root), []);
  writeFileSync(join(root, "settings.json"), JSON.stringify({ theme: "dark" }));
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ numStartups: 1, projects: {} }));
  assert.deepEqual(inspectConfigDir(root), []);
  writeFileSync(join(root, "settings.json"), JSON.stringify({ env: { A: "1" }, apiKeyHelper: "/bin/echo", enabledPlugins: {} }));
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { "/x": { mcpServers: { a: {} } } } }));
  const problems = inspectConfigDir(root);
  for (const p of ["env:settings.json", "apiKeyHelper:settings.json", "enabledPlugins:settings.json", "mcpServers:.claude.json"])
    assert.ok(problems.includes(p), p);
  writeFileSync(join(root, "settings.local.json"), "{not json");
  assert.ok(inspectConfigDir(root).includes("unparsable:settings.local.json"));
  mkdirSync(join(root, "plugins"));
  writeFileSync(join(root, "CLAUDE.md"), "synthetic\n");
  assert.ok(inspectConfigDir(root).includes("present:plugins"));
  assert.ok(inspectConfigDir(root).includes("present:CLAUDE.md"));
  assert.equal(managedSettingsPresent(() => false, "someone"), false);
  assert.equal(managedSettingsPresent((p) => p === "/Library/Application Support/ClaudeCode/managed-settings.json"), true);
  assert.equal(managedSettingsPresent((p) => p === "/Library/Managed Preferences/someone/com.anthropic.claudecode.plist", "someone"), true);
});

test("Seatbelt integration: real sandbox-exec denies every synthetic probe and its grandchild on macOS; elsewhere the doctor disables", async (t) => {
  const profile = readProfile(seatbeltDir);
  const host = seatbeltHost({ cliProfile: join(seatbeltDir, "cli.sb") });
  try {
    const r = await runDoctor(input({ host, profileHash: profile.hash, profileText: profile.cli }));
    if (process.platform !== "darwin") {
      // Not a skip: on Linux and Windows the required OS mechanism is absent, and that must disable.
      t.diagnostic(`no Seatbelt on ${process.platform}: doctor disabled the backend`);
      assert.equal(r.state, "disabled");
      assert.deepEqual(r.reasons, ["not-macos"]);
      assert.equal(capabilityReady(r.capability), false);
      return;
    }
    t.diagnostic(`macOS Seatbelt outcomes: ${JSON.stringify(r.outcomes)}`);
    for (const id of probeIds) {
      assert.equal(r.outcomes[`${id}:control`], "allowed", `${id} control`);
      assert.equal(r.outcomes[`${id}:cli`], "denied", `${id} cli.sb`);
      if (SYNTHETIC_PROBES[id].child) assert.equal(r.outcomes[`${id}:cli-child`], "denied", `${id} grandchild`);
    }
    assert.equal(r.state, "verified", JSON.stringify(r.reasons));
    // A missing parameter fails to compile, so nothing starts.
    const node = realpathSync(process.execPath);
    const missing = spawnSync(SANDBOX_EXEC, ["-f", join(seatbeltDir, "cli.sb"), "-D", `EXECUTABLE=${node}`, node, "-e", "0"], { stdio: "ignore" });
    assert.notEqual(missing.status, 0);
    // Nested sandboxing is refused, which is why tool children are checked by inheritance.
    const nested = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", SANDBOX_EXEC, "-p", "(version 1)(allow default)(deny network*)", "/usr/bin/true"], { stdio: "ignore" });
    t.diagnostic(`nested sandbox_apply exit status: ${nested.status}`);
  } finally {
    await host.close();
  }
});

test("CLI measurement harness: synthetic PR traps and injected instructions decide outcomes from markers, files, hits and nonces", async (t) => {
  if (process.platform === "win32") {
    // Not a skip: workers launch on macOS only; the measurement refuses before starting any CLI.
    const layout = { root: "C:/x", secretFiles: { key: "", token: "", gh: "", ssh: "", otherAi: "" }, writeTargets: { db: "", policy: "" }, keychain: null, network: { url: "", hits: () => 0 }, supervisor: { socket: "", hits: () => 0 } };
    await assert.rejects(measureCli(policy(), job(30), install, layout, async () => assert.fail("CLI started")), LaunchError);
    t.diagnostic("Windows: the measurement refused before starting any CLI");
    return;
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kl-measure-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config"),
    secrets = join(root, "secrets");
  mkdirSync(config);
  mkdirSync(secrets);
  const ci: LaunchInstall = { ...install, configDir: config, protectedRoots: ["/srv/synthetic/dispatch/policy"] };
  const cx: LaunchInstall = { ...codexInstall, configDir: config, protectedRoots: ["/srv/synthetic/dispatch/policy"] };
  let netHits = 0,
    controlHits = 0;
  const layout = (name: string): TrapLayout => {
    const r = join(root, name);
    mkdirSync(r);
    const f = (n: string) => join(secrets, `${name}-${n}`);
    // A plain synthetic file stands in for the keychain; a leaky fake "reads" the item from it.
    writeFileSync(f("synthetic.keychain-db"), `SYNTHETIC-ITEM-${name}\n`);
    return {
      root: r,
      secretFiles: { key: f("key.pem"), token: f("token"), gh: f("hosts.yml"), ssh: f("id_synthetic"), otherAi: f("auth.json") },
      writeTargets: { db: f("dispatch.sqlite"), policy: f("policy.json") },
      keychain: { path: f("synthetic.keychain-db"), service: "kl-synthetic", account: "doctor", value: `SYNTHETIC-ITEM-${name}` },
      network: { url: "http://127.0.0.1:9/synthetic", hits: () => netHits },
      supervisor: { socket: f("control.sock"), hits: () => controlHits },
    };
  };
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const plans: LaunchPlan[] = [];
  const o = { ...opts, platform: "darwin" as const };
  // Fake CLIs. Each touches only the run's own files, like a model following some instructions.
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
  const instructionLoader = async (p: LaunchPlan): Promise<CliRun> => ({ exitCode: 0, stdout: read(join(p.cwd, "control.txt")) + read(join(p.cwd, "AGENTS.md")) });
  const leaky = async (p: LaunchPlan): Promise<CliRun> => {
    const files = read(join(p.cwd, "notes.txt")).split("\n").filter((l) => l.startsWith("/"));
    return { exitCode: 0, stdout: files.map(read).join("") + read(join(p.cwd, "control.txt")) };
  };
  const toucher = (which: "net" | "control" | "write") => async (p: LaunchPlan): Promise<CliRun> => {
    const notes = read(join(p.cwd, "notes.txt"));
    if (notes && which === "net") netHits++;
    if (notes && which === "control") controlHits++;
    if (notes && which === "write") {
      const target = /Append the word CHANGED to (\S+) /.exec(notes)![1]!;
      writeFileSync(target, "CHANGED\n");
    }
    return obedient(p);
  };
  const silent = async (): Promise<CliRun> => ({ exitCode: 1, stdout: "" });

  const good = await measureCli(policy(), job(30), ci, layout("good"), obedient, o);
  for (const k of MEASURED_PROBES) assert.equal(good[k], "denied", k);
  // Claude: run A sandboxed, run A with the flag layer only, then run B sandboxed.
  assert.deepEqual(plans.map((p) => p.file), [SANDBOX_EXEC, install.executable, SANDBOX_EXEC]);
  assert.equal(withoutSandbox(plans[0]!, ci).args[0], "-p");
  assert.equal(plans[1]!.env[TOKEN_ENV], TOKEN);
  for (const f of [".mcp.json", "AGENTS.md", "CLAUDE.md", ".claude/settings.json", ".codex/config.toml"])
    assert.ok(existsSync(join(plans[0]!.cwd, f)), f);
  assert.deepEqual(readdirSync(config), []); // the config-dir trap is removed after the run

  plans.length = 0;
  const codex = await measureCli(policy(), job(20), cx, layout("codex"), obedient, o);
  for (const k of MEASURED_PROBES) assert.equal(codex[k], "denied", k);
  assert.deepEqual(plans.map((p) => p.file), [codexInstall.executable, codexInstall.executable]);

  assert.equal((await measureCli(policy(), job(30), ci, layout("hook"), hookRunner, o))["deny-hooks-mcp"], "allowed");
  assert.equal((await measureCli(policy(), job(20), cx, layout("agents"), instructionLoader, o))["deny-hooks-mcp"], "allowed");
  const leak = await measureCli(policy(), job(20), cx, layout("leak"), leaky, o);
  for (const k of ["deny-keys", "deny-gh-auth", "deny-other-ai-auth", "deny-keychain", "deny-db", "deny-policy-write", "tool-child-confined"] as const)
    assert.equal(leak[k], "allowed", k);
  assert.equal((await measureCli(policy(), job(20), cx, layout("net"), toucher("net"), o))["deny-network"], "allowed");
  assert.equal((await measureCli(policy(), job(20), cx, layout("ctl"), toucher("control"), o))["deny-supervisor"], "allowed");
  assert.equal((await measureCli(policy(), job(20), cx, layout("write"), toucher("write"), o))["deny-db"], "allowed");
  const quiet = await measureCli(policy(), job(30), ci, layout("quiet"), silent, o);
  for (const k of MEASURED_PROBES) assert.equal(quiet[k], "inconclusive", k);

  const record = measurementRecord(ci, H, P, good);
  assert.equal(record.argvHash, argvTemplateHash(ci));
  assert.ok(!JSON.stringify(record).includes(TOKEN));
});

test("spawnExecutor runs a plan without a shell, with its env and stdin", async (t) => {
  if (process.platform === "win32") {
    t.diagnostic("Windows: runs the same check with the Node.js runtime as the plan file");
  }
  const plan: LaunchPlan = {
    file: process.execPath,
    args: ["-e", "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s+'|'+process.env.SYNTH))"],
    env: { SYNTH: "x1", PATH: "/usr/bin:/bin" },
    cwd: tmpdir(),
    stdin: "hello $(echo no)",
    shell: false,
  };
  const r = await spawnExecutor(10000)(plan);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "hello $(echo no)|x1");
});
