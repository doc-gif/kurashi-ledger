import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MEASURED_PROBES,
  PLAIN_SOCKET_PREFIX,
  PROBE_SOURCE,
  SOCKET_DENY_LINE,
  SUN_PATH_MAX,
  SYNTHETIC_PROBES,
  checkSocketPath,
  inspectConfigDir,
  lintProfile,
  managedSettingsPresent,
  inspectCodexHome,
  parseEvents,
  measureCli,
  measurementRecord,
  parseMeasurement,
  privateSocket,
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
import { LaunchError, SANDBOX_EXEC, TOKEN_ENV, argvTemplateHash, buildMeasurementLaunch, type LaunchInstall, type LaunchPlan } from "./launcher.ts";
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
      return over.outcome?.(c) ?? (mode === "control" || mode === "open" ? "allowed" : "denied");
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
const opts = { platform: "darwin" as const, exists: () => false, scan: () => [], readToken: () => TOKEN };
const launchFor = (i: LaunchInstall) => ({
  plan: buildMeasurementLaunch(policy(), job(i.backend === "claude" ? 30 : 20), i, run, opts),
  install: i,
  run,
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
  input({ backend: "codex", version: codexInstall.version, launch: launchFor(codexInstall), measurement: measurement(codexInstall), profileText: null, codexProblems: [], ...over });
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
    assert.equal(host.calls.some((c) => c.probe === id && c.mode === "open"), SYNTHETIC_PROBES[id].open, id);
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
      const r = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.mode === "control" || c.mode === "open" || (c.probe === id && c.mode === mode) ? "allowed" : "denied") }) }));
      assert.equal(r.state, "disabled", `${id}:${mode}`);
      assert.ok(r.reasons.includes(`probe-allowed:${id}:${mode}`));
      assert.ok(allFalse(r.capability.probes));
    }
});

test("doctor: failed control or inconclusive probe leaves the backend unverified; a broken inheritance check blocks tool-child-confined", async () => {
  for (const id of probeIds) {
    const control = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.mode === "control" || c.mode === "open" ? (c.probe === id && c.mode === "control" ? "inconclusive" : "allowed") : "denied") }) }));
    assert.equal(control.state, "unverified", id);
    assert.ok(control.reasons.includes(`control-failed:${id}`));
    // "Denied" because nothing works at all is not evidence.
    const nothing = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.mode === "control" && c.probe === id ? "denied" : c.mode === "control" || c.mode === "open" ? "allowed" : "denied") }) }));
    assert.equal(nothing.state, "unverified", id);
    const unknown = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.mode === "control" || c.mode === "open" ? "allowed" : c.probe === id && c.mode === "cli" ? "inconclusive" : "denied") }) }));
    assert.equal(unknown.state, "unverified", id);
    assert.ok(allFalse(unknown.capability.probes));
  }
  const child = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.mode === "control" || c.mode === "open" ? "allowed" : c.mode === "cli-child" && c.probe === "db-write" ? "inconclusive" : "denied") }) }));
  // A denial not shown to come from the explicit rule (the "open" variant also fails) is not proof.
  for (const id of probeIds.filter((x) => SYNTHETIC_PROBES[x].open)) {
    const r = await runDoctor(input({ host: fakeHost({ outcome: (c) => (c.mode === "control" ? "allowed" : c.mode === "open" && c.probe === id ? "denied" : c.mode === "open" ? "allowed" : "denied") }) }));
    assert.equal(r.state, "unverified", id);
    assert.ok(r.reasons.includes(`explicit-deny-unproven:${id}`));
  }
  assert.equal(child.state, "unverified");
  assert.equal(await runDoctor(input({ external: { schema: false, descendantLock: true } })).then((r) => r.state), "unverified");
});

test("doctor: cli.sb lint refuses rules that open the boundary", async () => {
  assert.deepEqual(lintProfile(PROFILE), []);
  // The same rules with CRLF line endings (a Windows checkout) lint the same way.
  assert.deepEqual(lintProfile(PROFILE.replace(/\r?\n/g, "\r\n")), []);
  // PR60-R001: whitespace variants (tabs, runs, space inside parentheses) parse to the same rules.
  const spaced = PROFILE.replace(/\n/g, "\n\t  ").replace(/\(allow /g, "(  allow\t").replace(/\)\n/g, " )\n");
  assert.notEqual(spaced, PROFILE);
  assert.deepEqual(lintProfile(spaced), []);
  // Parens and ";" inside strings, #"regex" literals and comments are not structure.
  const before = (rule: string) => PROFILE.replace(";; BEGIN keychain-deny", `${rule}\n;; BEGIN keychain-deny`);
  const tricky = before(
    [
      ";; (allow default) ) (( (allow network*)",
      '(allow file-read* (literal "/srv/synthetic/a)b(c;d \\"e\\" (allow network*)"))',
      '(allow file-read* (regex #"^/srv/synthetic/(x|y)\\)\\;$"))',
    ].join("\n"),
  );
  assert.deepEqual(lintProfile(tricky), []);
  const bad: [string, string][] = [
    [PROFILE.replace("(deny default)", "(allow default)"), "not-deny-default"],
    [`${PROFILE}\n(allow process-info* (target others))`, "process-access"],
    [`${PROFILE}\n(allow mach-task-name)`, "process-access"],
    [`${PROFILE}\n(allow signal)`, "signal-outside"],
    [`${PROFILE}\n(allow mach-lookup (global-name "com.apple.SecurityServer"))`, "keychain"],
    [PROFILE.replace('(deny process-exec (literal "/usr/bin/security"))', ""), "keychain-deny-missing"],
    [PROFILE.replace("(deny process-info*)", ""), "process-info-deny-missing"],
    [PROFILE.replace('(deny network-outbound (remote ip "localhost:*"))', ""), "loopback-deny-missing"],
    [`${PROFILE}\n(allow sysctl-read)`, "sysctl-unrestricted"],
    [`${PROFILE}\n(allow process-info*)`, "process-access"],
    // W4d: the stand-in control sockets live under /private/tmp; only DNS and TCP 443 go out.
    [PROFILE.replace(SOCKET_DENY_LINE, ""), "socket-deny-missing"],
    [`${PROFILE}\n(allow file-read* (subpath "/private/tmp"))`, "socket-dir-open"],
    [`${PROFILE}\n(allow file-read* (regex #"^/tmp/kl-sock-"))`, "socket-dir-open"],
    [PROFILE.replace("(allow file-read-metadata)", '(allow file-write* (regex #"kl-ctl-"))'), "socket-dir-open"], // PR60 RT-6
    [`${PROFILE}\n(allow network-outbound)`, "network-open"],
    // PR60 RT-5: whitespace other than one space (Seatbelt accepts these).
    [PROFILE.replace("(allow file-read-metadata)", "(allow\tnetwork-outbound)"), "network-open"],
    [PROFILE.replace("(allow file-read-metadata)", "(  allow\n  network-outbound  )"), "network-open"],
    [`${PROFILE}\n(allow network*)`, "network-open"],
    [`${PROFILE}\n(allow network-outbound (remote unix-socket (path-literal "/srv/synthetic/control.sock")))`, "network-open"],
    // PR60 RT-2: a network operation anywhere in the operation list.
    [PROFILE.replace("(allow file-read-metadata)", '(allow file-read* network-outbound (subpath "/private"))'), "network-open"],
    [PROFILE.replace("(allow file-read-metadata)", "(allow system-socket network-outbound)"), "network-open"],
    // PR60 RT-3: no allow after the explicit denies (a later rule wins).
    [`${PROFILE}\n(allow file-read-data (literal "/srv/synthetic/x"))`, "allow-after-deny"],
    [PROFILE.replace(";; BEGIN socket-deny", '(allow file-read-data (literal "/srv/synthetic/x"))\n;; BEGIN socket-deny'), "allow-after-deny"],
    // PR60-R001: every allow is read whatever its depth, before the explicit denies too.
    [before('(allow network-outbound (require-all (require-any (remote tcp "*:8443"))))'), "network-open"],
    [before('(allow file-write* (require-all (require-any (require-not (require-all (regex #"^/private/tmp/kl-ctl-"))))))'), "socket-dir-open"],
    [before('(allow file-read* (require-any (require-all (require-any (literal "/srv/synthetic/Library/Keychains/login.keychain-db")))))'), "keychain"],
    // Anything the parser does not know fails closed.
    [before('(allow file-read* (literal "/srv/x")'), "profile-parse"],
    [before('(allow file-read* (literal "/srv/x"))))'), "profile-parse"],
    [before('(allow file-read* (literal "/srv/x))'), "profile-parse"],
    [before("'(allow default)"), "profile-parse"],
    [before("#| (allow default) |#"), "profile-parse"],
    [before("(define x (allow default))"), "profile-unknown-form"],
    [before("(if #t (allow default))"), "profile-parse"],
    [before('(allow file-read* (allow network-outbound))'), "profile-unknown-form"],
    [before('(allow (literal "/srv/x"))'), "profile-unknown-form"],
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
  const item = await runDoctor(claudeInput({ host: fakeHost({ outcome: (c) => (c.mode === "control" || c.mode === "open" || c.probe === "app-key-item" ? "allowed" : "denied") }) }));
  assert.equal(item.state, "disabled");
  assert.ok(item.reasons.includes("probe-allowed:app-key-item:cli"));
});

test("doctor: Codex is hard-disabled in this release, whatever its measurement says", async () => {
  const host = fakeHost();
  const ok = await runDoctor(codexInput({ host }));
  assert.equal(ok.state, "disabled");
  assert.ok(ok.reasons.includes("codex-deferred"));
  assert.equal(capabilityReady(ok.capability), false);
  assert.equal(host.calls.length, 0); // no outer Seatbelt to probe
  assert.equal((await runDoctor(codexInput({ measurement: null }))).state, "disabled");
  const dirty = await runDoctor(codexInput({ codexProblems: ["mcp_servers:config.toml"] }));
  assert.ok(dirty.reasons.includes("codex-home:mcp_servers:config.toml"));
  assert.ok((await runDoctor(codexInput({ codexProblems: null }))).reasons.includes("codex-home-unchecked"));
  const wrapped = launchFor(codexInstall);
  wrapped.plan = { ...wrapped.plan, file: SANDBOX_EXEC, args: ["-f", "/opt/x/cli.sb", codexInstall.executable, ...wrapped.plan.args] };
  const r = await runDoctor(codexInput({ launch: wrapped }));
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
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  assert.deepEqual(inspectCodexHome(codexHome), []);
  writeFileSync(join(codexHome, "config.toml"), 'model = "synthetic"\n');
  assert.deepEqual(inspectCodexHome(codexHome), []);
  writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.x]\ncommand = "/bin/sh"\nnotify = ["/bin/sh"]\n');
  writeFileSync(join(codexHome, "AGENTS.md"), "synthetic\n");
  const cp = inspectCodexHome(codexHome);
  for (const p of ["mcp_servers:config.toml", "notify:config.toml", "present:AGENTS.md"]) assert.ok(cp.includes(p), p);
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
      if (SYNTHETIC_PROBES[id].open) assert.equal(r.outcomes[`${id}:open`], "allowed", `${id} open variant`);
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

test("CLI measurement harness: outcomes need attempt evidence from the CLI's events; no evidence is inconclusive", async (t) => {
  if (process.platform === "win32") {
    // Not a skip: workers launch on macOS only; the measurement refuses before starting any CLI.
    const layout = { root: "C:/x", secretFiles: { key: "", token: "", gh: "", ssh: "", otherAi: "" }, writeTargets: { db: "", policy: "" }, keychain: null, network: { url: "", hits: () => 0 }, supervisor: { sockets: [""], hits: () => 0 } };
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
      keychain: { path: f("synthetic.keychain-db"), service: `kl-synthetic-${name}`, account: "doctor", value: `SYNTHETIC-ITEM-${name}` },
      network: { url: "http://127.0.0.1:9/synthetic", hits: () => netHits },
      supervisor: { sockets: [f("control.sock"), f("plain.sock")], hits: () => controlHits },
    };
  };
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const steps = (p: LaunchPlan) =>
    [...p.stdin.matchAll(/^- (read|run|write|fetch|socket): (?:append CHANGED to |connect to )?(.+)$/gm)].map((m) => ({ kind: m[1]!, target: m[2]! }));
  const line = (v: unknown) => JSON.stringify(v);
  const plans: LaunchPlan[] = [];
  const o = { ...opts, platform: "darwin" as const };
  // Fake CLIs. They emit the documented event shapes; none of them touches real credentials.
  // Claude: init (Read/Grep/Glob, no MCP), a Read tool_use per read step, all denied.
  const claudeDenied = async (p: LaunchPlan): Promise<CliRun> => {
    plans.push(p);
    const reads = steps(p).filter((s) => s.kind === "read");
    return {
      exitCode: 0,
      stdout: [
        line({ type: "system", subtype: "init", tools: ["Read", "Grep", "Glob"], mcp_servers: [] }),
        ...reads.map((s) => line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: s.target } }] } })),
        line({ type: "result", permission_denials: reads.map((s) => ({ tool_name: "Read", tool_input: { file_path: s.target } })) }),
      ].join("\n"),
    };
  };
  // Codex: thread.started, one command item per step, nothing leaks.
  const codexDenied = async (p: LaunchPlan): Promise<CliRun> => {
    plans.push(p);
    return {
      exitCode: 0,
      stdout: [
        line({ type: "thread.started" }),
        ...steps(p).map((s) => line({ type: "item.completed", item: { type: "command_execution", command: `${s.kind} ${s.target}`, exit_code: 1 } })),
      ].join("\n"),
    };
  };
  // Says it complied but shows no attempt: the old fail-open case.
  const obedient = async (p: LaunchPlan): Promise<CliRun> => ({ exitCode: 0, stdout: `${p.stdin.length} steps done` });
  const codexLeaky = async (p: LaunchPlan): Promise<CliRun> => ({
    exitCode: 0,
    stdout: [
      line({ type: "thread.started" }),
      ...steps(p).map((s) => line({ type: "item.completed", item: { type: "command_execution", command: `cat ${s.target}`, aggregated_output: read(s.target) } })),
    ].join("\n"),
  });
  const hookRunner = async (p: LaunchPlan): Promise<CliRun> => {
    const settings = read(join(p.cwd, ".claude", "settings.json"));
    if (p.file !== SANDBOX_EXEC && settings) {
      const cmd = JSON.parse(settings).hooks.SessionStart[0].hooks[0].command as string;
      writeFileSync(cmd.split(" ")[1]!, "");
    }
    return claudeDenied(p);
  };
  const instructionLoader = async (p: LaunchPlan): Promise<CliRun> => {
    const r = await codexDenied(p);
    return { ...r, stdout: `${r.stdout}\n${read(join(p.cwd, "AGENTS.md"))}` };
  };
  const mcpLoaded = async (p: LaunchPlan): Promise<CliRun> => ({
    exitCode: 0,
    stdout: line({ type: "system", subtype: "init", tools: ["Read", "Grep", "Glob", "mcp__trap__x"], mcp_servers: [{ name: "trap", status: "connected" }] }),
  });
  const toucher = (which: "net" | "control" | "write") => async (p: LaunchPlan): Promise<CliRun> => {
    const s = steps(p);
    if (s.length && which === "net") netHits++;
    if (s.length && which === "control") controlHits++;
    if (s.length && which === "write") writeFileSync(s.find((x) => x.kind === "write")!.target, "CHANGED\n");
    return codexDenied(p);
  };

  const claude = await measureCli(policy(), job(30), ci, layout("claude"), claudeDenied, o);
  for (const k of MEASURED_PROBES) assert.equal(claude[k], "denied", k);
  // Run A sandboxed, run A with the flag layer only, then run B; all with stream-json events.
  assert.deepEqual(plans.map((p) => p.file), [SANDBOX_EXEC, install.executable, SANDBOX_EXEC]);
  for (const p of plans) {
    assert.equal(p.args[p.args.indexOf("--output-format") + 1], "stream-json");
    assert.ok(p.args.includes("--verbose"));
  }
  assert.equal(plans[1]!.env[TOKEN_ENV], TOKEN);
  for (const f of [".mcp.json", "AGENTS.md", "CLAUDE.md", ".claude/settings.json", ".codex/config.toml"])
    assert.ok(existsSync(join(plans[0]!.cwd, f)), f);
  // The attempt request comes from the measurer's stdin, not from the materials.
  const b = plans[2]!;
  assert.match(b.stdin, /^- read: /m);
  assert.deepEqual(readdirSync(b.cwd), ["readme.txt"]);
  assert.deepEqual(readdirSync(config), []); // the config-dir trap is removed after the run

  plans.length = 0;
  const codex = await measureCli(policy(), job(20), cx, layout("codex"), codexDenied, o);
  for (const k of MEASURED_PROBES) assert.equal(codex[k], "denied", k);
  assert.deepEqual(plans.map((p) => p.file), [codexInstall.executable, codexInstall.executable]);

  // "Did not try" is never "denied".
  for (const [name, inst, j] of [["obedient-claude", ci, 30], ["obedient-codex", cx, 20]] as const) {
    const r = await measureCli(policy(), job(j), inst, layout(name), obedient, o);
    for (const k of MEASURED_PROBES) assert.equal(r[k], "inconclusive", `${name} ${k}`);
  }
  // Claude's structural proof needs its own init event: extra tools or MCP servers void it.
  const extra = await measureCli(policy(), job(30), ci, layout("extra"), async (p) => {
    const r = await claudeDenied(p);
    return { ...r, stdout: r.stdout.replace('"tools":["Read","Grep","Glob"]', '"tools":["Read","Grep","Glob","Bash"]') };
  }, o);
  for (const k of ["deny-network", "deny-supervisor"] as const) assert.equal(extra[k], "inconclusive", k);
  assert.equal((await measureCli(policy(), job(30), ci, layout("mcp"), mcpLoaded, o))["deny-hooks-mcp"], "inconclusive");

  assert.equal((await measureCli(policy(), job(30), ci, layout("hook"), hookRunner, o))["deny-hooks-mcp"], "allowed");
  assert.equal((await measureCli(policy(), job(20), cx, layout("agents"), instructionLoader, o))["deny-hooks-mcp"], "allowed");
  const leak = await measureCli(policy(), job(20), cx, layout("leak"), codexLeaky, o);
  for (const k of ["deny-keys", "deny-gh-auth", "deny-other-ai-auth", "deny-keychain", "deny-db", "deny-policy-write", "tool-child-confined"] as const)
    assert.equal(leak[k], "allowed", k);
  assert.equal((await measureCli(policy(), job(20), cx, layout("net"), toucher("net"), o))["deny-network"], "allowed");
  assert.equal((await measureCli(policy(), job(20), cx, layout("ctl"), toucher("control"), o))["deny-supervisor"], "allowed");
  assert.equal((await measureCli(policy(), job(20), cx, layout("write"), toucher("write"), o))["deny-db"], "allowed");

  const record = measurementRecord(ci, H, P, claude);
  assert.equal(record.argvHash, argvTemplateHash(ci));
  assert.ok(!JSON.stringify(record).includes(TOKEN));
  // Event parsing ignores noise and unknown shapes.
  const ev = parseEvents("claude", `noise\n{"type":"system","subtype":"init","tools":["Read"],"mcp_servers":[]}\n[1]\n`);
  assert.deepEqual(ev, { started: true, tools: ["Read"], mcpServers: 0, attempts: [] });
  assert.deepEqual(parseEvents("codex", '{"type":"item.completed","item":{"type":"agent_message","text":"/x"}}').attempts, []);
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

test("W4 doctor binds the capability to the argv template of the install it was measured with", async () => {
  const ok = await runDoctor(claudeInput());
  assert.equal(ok.state, "verified", JSON.stringify(ok.reasons));
  assert.equal(ok.capability.argvHash, argvTemplateHash(install));
  // A launch record whose hash is not this install's template disables the backend.
  const other = { ...install, configDir: "/srv/synthetic/other-config" };
  assert.notEqual(argvTemplateHash(other), argvTemplateHash(install));
  const r = await runDoctor(claudeInput({ launch: { ...launchFor(install), argvHash: argvTemplateHash(other) }, measurement: { ...measurement(install), argvHash: argvTemplateHash(other) } }));
  assert.equal(r.state, "disabled");
  assert.ok(r.reasons.includes("argv-hash-mismatch"));
  assert.equal(capabilityReady(r.capability), false);
});

test("Round 6 RT-3: only ENOENT means absent; an unreadable config file is a problem", async (t) => {
  const { existsSafe, inspectConfigDir, inspectCodexHome } = await import("./doctor.ts");
  const { lexists } = await import("./launcher.ts");
  const fs = await import("node:fs"),
    { join } = await import("node:path"),
    { tmpdir } = await import("node:os");
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "rt3-")));
  try {
    assert.equal(existsSafe(join(dir, "missing")), false);
    assert.equal(lexists(join(dir, "missing")), false);
    const eacces = () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    };
    assert.deepEqual(inspectConfigDir(dir, eacces, () => false), [
      "unreadable:settings.json", "unreadable:settings.local.json", "unreadable:.claude.json",
    ]);
    assert.deepEqual(inspectCodexHome(dir, eacces, () => false), ["unreadable:config.toml"]);
    const locked = join(dir, "locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      if (process.platform === "win32" || process.getuid?.() === 0) {
        t.diagnostic("permission bits do not restrict this user here; the injected EACCES above covers the rule");
      } else {
        // The directory cannot be searched: whether the file is there is unknown, so it counts as present.
        assert.equal(existsSafe(join(locked, "CLAUDE.md")), true);
        assert.equal(lexists(join(locked, "CLAUDE.md")), true);
      }
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- W4d: stand-in control sockets under long roots (the owner's measure failed with listen EINVAL) ----
// A root longer than 80 characters, deep enough that root/control/control.sock exceeds every sun_path limit.
function longRoot(t: { after(fn: () => void): void }, label: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `kl-w4d-${label}-`)));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, ".local", "share", "kurashi-dispatch", "runs", `measure-${"0".repeat(36)}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assert.ok(root.length > 80 && Buffer.byteLength(join(root, "control", "control.sock")) > 108, root);
  return root;
}
const connects = (path: string) =>
  new Promise<boolean>((resolve) => {
    const s = connect({ path });
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });

test("W4d: the control socket gets a fresh 0700 directory under /tmp, a path of 104 bytes or more is refused before bind, and nothing is left", async (t) => {
  if (process.platform === "win32") {
    // Not a skip: there are no Unix sockets for the measurement on Windows; it refuses.
    await assert.rejects(privateSocket(createServer()), /unix-socket-unsupported/);
    t.diagnostic("Windows: privateSocket refused (no Unix sockets for the measurement)");
    return;
  }
  // Bytes, not characters: 103 bytes fit, 104 do not.
  assert.equal(checkSocketPath(`/${"a".repeat(SUN_PATH_MAX - 2)}`).length, SUN_PATH_MAX - 1);
  assert.throws(() => checkSocketPath(`/${"a".repeat(SUN_PATH_MAX - 1)}`), /unix-socket-path-too-long: 104 bytes/);
  assert.throws(() => checkSocketPath(`/${"\u00e9".repeat(52)}`), /unix-socket-path-too-long: 105 bytes/);

  const s = await privateSocket(createServer((c) => c.end()));
  try {
    assert.ok(Buffer.byteLength(s.path) < SUN_PATH_MAX, s.path);
    assert.ok(s.dir.startsWith(join(realpathSync("/tmp"), "kl-sock-")), s.dir);
    const st = lstatSync(s.dir);
    assert.ok(st.isDirectory() && !st.isSymbolicLink());
    assert.equal(st.uid, process.getuid?.());
    assert.equal(st.mode & 0o777, 0o700);
    assert.equal(await connects(s.path), true);
  } finally {
    await s.close();
  }
  assert.equal(existsSync(s.dir), false);

  // Too long: a clear error instead of listen EINVAL; nothing bound, no directory left.
  const root = longRoot(t, "long");
  const server = createServer();
  await assert.rejects(privateSocket(server, { base: root }), /unix-socket-path-too-long/);
  assert.equal(server.listening, false);
  assert.deepEqual(readdirSync(root), []);

  // Not a private directory of this user: refused before bind, the empty directory removed.
  const uid = process.getuid?.() ?? 0;
  const bad: [string, { dir?: boolean; link?: boolean; uid?: number; mode?: number }][] = [
    ["group/other bits", { mode: 0o40755 }],
    ["symlink", { link: true }],
    ["other owner", { uid: uid + 1 }],
    ["not a directory", { dir: false }],
  ];
  for (const [name, b] of bad) {
    let made = "";
    const stat = (p: string) => {
      made = p;
      const st = lstatSync(p);
      return { isDirectory: () => b.dir ?? st.isDirectory(), isSymbolicLink: () => b.link ?? st.isSymbolicLink(), uid: b.uid ?? st.uid, mode: b.mode ?? st.mode };
    };
    const srv = createServer();
    await assert.rejects(privateSocket(srv, { stat }), /unix-socket-dir-not-private/, name);
    assert.equal(srv.listening, false, name);
    assert.ok(made !== "" && !existsSync(made), name);
  }
});

test("W4d Seatbelt: a doctor fixture root over 80 characters still binds the control sockets, and cli.sb denies them by deny default and by its own rule", async (t) => {
  if (process.platform !== "darwin") {
    // Not a skip: the doctor needs Seatbelt and disables elsewhere (the integration test above checks that).
    t.diagnostic(`no Seatbelt on ${process.platform}: the doctor disables before binding any socket`);
    return;
  }
  const base = longRoot(t, "doctor");
  const host = seatbeltHost({ cliProfile: join(seatbeltDir, "cli.sb"), base });
  try {
    assert.equal(await host.run("supervisor-pipe", "control"), "allowed");
    assert.equal(await host.run("supervisor-pipe", "cli"), "denied");
    assert.equal(await host.run("supervisor-pipe", "cli-child"), "denied");
  } finally {
    await host.close();
  }
  assert.deepEqual(readdirSync(base), []);

  // PR60 RT-1: deny default alone (cli.sb without the socket-deny line) still denies every control socket.
  const plainDir = realpathSync(mkdtempSync(join(tmpdir(), "kl-rt1-")));
  t.after(() => rmSync(plainDir, { recursive: true, force: true }));
  assert.ok(PROFILE.includes(SOCKET_DENY_LINE));
  writeFileSync(join(plainDir, "cli.sb"), PROFILE.replace(SOCKET_DENY_LINE, ""));
  const plainHost = seatbeltHost({ cliProfile: join(plainDir, "cli.sb") });
  try {
    assert.equal(await plainHost.run("supervisor-pipe", "control"), "allowed");
    assert.equal(await plainHost.run("supervisor-pipe", "cli"), "denied");
    assert.equal(await plainHost.run("supervisor-pipe", "cli-child"), "denied");
  } finally {
    await plainHost.close();
  }

  // The explicit socket-deny, not only deny-default: with broad allows placed before it the socket stays
  // denied (both spellings, /private/tmp and /tmp); the same profile without the block lets it through.
  const work = realpathSync(mkdtempSync(join(tmpdir(), "kl-w4d-sb-")));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const d = (n: string) => {
    mkdirSync(join(work, n), { mode: 0o700 });
    return join(work, n);
  };
  const materials = d("materials");
  writeFileSync(join(materials, "probe.mjs"), PROBE_SOURCE);
  const params = { MATERIALS: materials, CONFIG_DIR: d("config"), RUN_HOME: d("home"), RUN_TMP: d("tmp") };
  const [head, tail] = PROFILE.split(";; BEGIN socket-deny\n");
  assert.ok(head && tail?.includes(SOCKET_DENY_LINE));
  const broad = '(allow file-read* file-write* (subpath "/private/tmp"))\n(allow network-outbound)\n';
  const profiles = { reviewed: PROFILE, broadWithDeny: `${head}${broad};; BEGIN socket-deny\n${tail}`, broadWithoutDeny: `${head}${broad}` };
  const node = realpathSync(process.execPath);
  const s = await privateSocket(createServer((c) => c.end()));
  const plain = await privateSocket(createServer((c) => c.end()), { prefix: PLAIN_SOCKET_PREFIX });
  try {
    const probe = (profile: string, target: string) =>
      new Promise<string>((resolve) => {
        const file = join(work, `${profile}.sb`);
        writeFileSync(file, profiles[profile as keyof typeof profiles]);
        const args = ["-f", file, "-D", `EXECUTABLE=${node}`, "-D", `RUNTIME=${dirname(dirname(node))}`];
        for (const [k, v] of Object.entries(params)) args.push("-D", `${k}=${v}`);
        execFile(SANDBOX_EXEC, [...args, node, join(materials, "probe.mjs"), "unix", target], { timeout: 15000 }, (_e, out) =>
          resolve(/^\{"r":"(allowed|denied|error)"\}\n$/.exec(String(out))?.[1] ?? "inconclusive"),
        );
      });
    const spellings = [s.path, s.path.replace(/^\/private\/tmp\//, "/tmp/")];
    for (const target of spellings) {
      assert.equal(await probe("reviewed", target), "denied", `cli.sb ${target}`);
      assert.equal(await probe("broadWithDeny", target), "denied", `socket-deny ${target}`);
      assert.equal(await probe("broadWithoutDeny", target), "allowed", `control ${target}`);
    }
    // The second control socket is outside the explicit rule: only deny default denies it (PR60 RT-1).
    assert.equal(await probe("reviewed", plain.path), "denied", "deny default");
    assert.equal(await probe("broadWithDeny", plain.path), "allowed", "outside socket-deny");
  } finally {
    await s.close();
    await plain.close();
  }
});

test("PR60 RT-4: a failure late in the doctor's fixture setup leaves no directory, listener, socket or child behind", async (t) => {
  if (process.platform === "win32") {
    // Not a skip: on Windows the fixture refuses at the control sockets (no Unix sockets), before the hook.
    t.diagnostic("Windows: the doctor fixture refuses before making the sockets");
    return;
  }
  const base = realpathSync(mkdtempSync(join(tmpdir(), "kl-rt4-doctor-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  type Made = { root: string; sockets: string[]; port: number; pid: number | null; keychain: string | null };
  let made: Made | null = null;
  const host = seatbeltHost({
    cliProfile: join(seatbeltDir, "cli.sb"),
    base,
    inject: (m) => {
      made = m;
      throw new Error("synthetic-failure");
    },
  });
  await assert.rejects(host.run("supervisor-pipe", "control"), /synthetic-failure/);
  const m = made as Made | null;
  assert.ok(m && m.sockets.length === 2 && m.pid !== null);
  assert.deepEqual(readdirSync(base), []);
  for (const socket of m.sockets) assert.equal(existsSync(dirname(socket)), false, socket);
  if (m.keychain) assert.equal(existsSync(m.keychain), false);
  assert.throws(() => process.kill(m.pid!, 0), /ESRCH/, "the sleeper child is gone");
  const refused = await new Promise<boolean>((resolve) => {
    const c = connect(m.port, "127.0.0.1");
    c.on("connect", () => {
      c.destroy();
      resolve(false);
    });
    c.on("error", () => resolve(true));
  });
  assert.equal(refused, true, "the loopback listener is closed");
  await host.close();
});
