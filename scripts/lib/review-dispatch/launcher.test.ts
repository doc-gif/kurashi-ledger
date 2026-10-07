import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CAUSE_KEY,
  ENV_KEYS,
  FIXED_QUERY,
  LaunchError,
  RESULT_LIMITS,
  RESULT_SCHEMA,
  RESULT_SCHEMA_JSON,
  SANDBOX_EXEC,
  TOKEN_ENV,
  argvTemplateHash,
  buildAuthStatus,
  buildLaunch,
  buildMeasurementLaunch,
  checkPlan,
  claudeVersionSupported,
  readTokenFile,
  scanTree,
  type LaunchInstall,
  type LaunchPlan,
  type LaunchRun,
} from "./launcher.ts";
import type { Job, WorkerResult } from "./model.ts";
import { parseResult } from "./broker.ts";
import { EVIDENCE_SHAPE, PUBLICATION_RULES, publicationFindings } from "./publication.ts";
import { textFindings } from "../public-policy.ts";
import { policy } from "../../../tests/fixtures/review-dispatch.ts";

// Synthetic paths only. Nothing here is spawned.
const TOKEN = "synthetic-setup-token-0123456789abcdef";
const claudeInstall = (): LaunchInstall => ({
  backend: "claude",
  executable: "/opt/synthetic/claude/2.1.300/bin/claude",
  version: "2.1.300",
  runtime: "/opt/synthetic/claude/2.1.300",
  cliProfile: "/opt/synthetic/reviewed/seatbelt/cli.sb",
  configDir: null, // per run (Issue #50 W5c)
  tokenFile: "/srv/synthetic/owner-secrets/claude-setup-token",
  protectedRoots: [
    "/srv/synthetic/dispatch/policy",
    "/srv/synthetic/dispatch/db",
    "/srv/synthetic/repo",
    "/srv/synthetic/owner/.config/gh",
  ],
});
const codexInstall = (): LaunchInstall => ({
  ...claudeInstall(),
  backend: "codex",
  executable: "/opt/synthetic/codex/0.99.0/bin/codex",
  version: "0.99.0",
  runtime: "/opt/synthetic/codex/0.99.0",
  cliProfile: null,
  configDir: "/srv/synthetic/dispatch/codex-home",
  tokenFile: null,
});
const run = (): LaunchRun => ({
  materials: "/srv/synthetic/runs/r1/materials",
  home: "/srv/synthetic/runs/r1/home",
  tmp: "/srv/synthetic/runs/r1/tmp",
  config: "/srv/synthetic/runs/r1/config",
  schemaFile: "/srv/synthetic/runs/r1/tmp/result-schema.json",
});
const job = (actor: number): Job => ({
  id: "j1",
  key: "1:1",
  generation: 1,
  actor,
  kind: "review",
  run: "run-1",
  pair: { head: "a".repeat(40), base: "b".repeat(40) },
  policy: "p1",
});
const opts = {
  platform: "darwin" as const,
  exists: () => false,
  scan: () => [],
  readToken: () => TOKEN,
};
const flagValue = (p: LaunchPlan, flag: string) => p.args[p.args.indexOf(flag) + 1];
const file = (name: string) => ({ name, kind: "file" as const, nlink: 1 });

test("Claude launch: sandbox-exec + cli.sb, documented flags, setup-token env, prompt on stdin", () => {
  const secrets = {
    GH_TOKEN: "synthetic-gh",
    KL_DISPATCH_LOCK_FD: "synthetic-lock-fd",
    ANTHROPIC_API_KEY: "synthetic-api",
    ANTHROPIC_AUTH_TOKEN: "synthetic-auth",
    OPENAI_API_KEY: "synthetic-openai",
  };
  const saved = { ...process.env };
  Object.assign(process.env, secrets);
  try {
    const p = buildLaunch(policy(), job(30), claudeInstall(), run(), opts);
    assert.equal(p.file, SANDBOX_EXEC);
    assert.equal(p.shell, false);
    assert.equal(p.cwd, run().materials);
    assert.deepEqual(p.args.slice(0, 2), ["-f", claudeInstall().cliProfile]);
    const exe = p.args.indexOf(claudeInstall().executable);
    assert.deepEqual(p.args.slice(2, exe), [
      "-D", `EXECUTABLE=${claudeInstall().executable}`,
      "-D", `RUNTIME=${claudeInstall().runtime}`,
      "-D", `MATERIALS=${run().materials}`,
      "-D", `CONFIG_DIR=${run().config}`,
      "-D", `RUN_HOME=${run().home}`,
      "-D", `RUN_TMP=${run().tmp}`,
    ]);
    const cli = p.args.slice(exe + 1);
    assert.deepEqual(cli.slice(0, 2), ["-p", FIXED_QUERY]);
    assert.ok(!cli.includes("--bare"));
    assert.equal(flagValue(p, "--tools"), "Read,Grep,Glob");
    assert.equal(flagValue(p, "--allowedTools"), `Read(/${run().materials}/**)`);
    assert.equal(flagValue(p, "--permission-mode"), "dontAsk");
    assert.equal(flagValue(p, "--permission-prompts"), "none");
    assert.equal(flagValue(p, "--mcp-config"), '{"mcpServers":{}}');
    assert.equal(flagValue(p, "--disallowedTools"), "mcp__*");
    assert.equal(flagValue(p, "--json-schema"), RESULT_SCHEMA_JSON);
    for (const f of ["--strict-mcp-config", "--restricted", "--safe-mode", "--no-session-persistence", "--disable-slash-commands"])
      assert.ok(cli.includes(f), f);
    const settings = JSON.parse(flagValue(p, "--settings")!);
    assert.equal(settings.disableAllHooks, true);
    assert.deepEqual(settings.enabledPlugins, {});
    assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
    assert.deepEqual(settings.permissions.allow, [`Read(/${run().materials}/**)`]);
    // Path rules are Read() rules only (Claude applies them to Grep and Glob).
    for (const r of [...settings.permissions.allow, ...settings.permissions.deny])
      assert.ok(!/^(?:Grep|Glob)\(/.test(r), r);
    assert.ok(settings.permissions.deny.includes(`Read(/${run().config}/**)`));
    assert.ok(!("hooks" in settings) && !("apiKeyHelper" in settings) && !("env" in settings));
    assert.deepEqual(Object.keys(p.env).sort(), [...ENV_KEYS.claude].sort());
    assert.equal(p.env[TOKEN_ENV], TOKEN);
    assert.equal(p.env["CLAUDE_CONFIG_DIR"], run().config);
    assert.equal(p.env["HOME"], run().home);
    assert.equal(p.env["CLAUDE_CODE_TMPDIR"], run().tmp);
    const everything = JSON.stringify(p);
    for (const v of Object.values(secrets)) assert.ok(!everything.includes(v));
    // The token is only in the env, never in argv or stdin.
    assert.ok(!p.args.some((a) => a.includes(TOKEN)) && !p.stdin.includes(TOKEN));
    // Job data reaches the CLI only through stdin.
    assert.match(p.stdin, /Head: a{40}\nBase: b{40}/);
    assert.ok(!p.args.some((a) => a.includes("a".repeat(40))));
    assert.deepEqual(checkPlan(p, claudeInstall(), run()), []);
  } finally {
    process.env = saved;
  }
});

test("Codex launch: codex exec --sandbox read-only only, no outer Seatbelt, no token", () => {
  // The dispatcher never launches Codex (owner decision 5977523656); only the measurement harness builds it.
  assert.throws(() => buildLaunch(policy(), job(20), codexInstall(), run(), opts), /codex automatic launch is deferred/);
  let read = 0;
  const p = buildMeasurementLaunch(policy(), job(20), codexInstall(), run(), { ...opts, readToken: () => String(++read) });
  assert.equal(read, 0);
  assert.equal(p.file, codexInstall().executable);
  assert.deepEqual(p.args, [
    "exec", "--json", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config",
    "--ignore-rules", "--skip-git-repo-check", "--color", "never",
    "--cd", run().materials, "--output-schema", run().schemaFile, "-",
  ]);
  assert.deepEqual(Object.keys(p.env).sort(), [...ENV_KEYS.codex].sort());
  assert.equal(p.env["CODEX_HOME"], codexInstall().configDir);
  assert.ok(!("CLAUDE_CODE_TMPDIR" in p.env));
  assert.deepEqual(checkPlan(p, codexInstall(), run()), []);
  const wrapped = { ...p, file: SANDBOX_EXEC, args: ["-f", "/opt/x/cli.sb", codexInstall().executable, ...p.args] };
  assert.ok(checkPlan(wrapped, codexInstall(), run()).includes("codex-wrapped"));
});

test("launch refusals fail closed with fixed messages that never echo a path or token", () => {
  const cases: [string, () => unknown][] = [
    ["not macOS", () => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, platform: "linux" })],
    ["human actor", () => buildLaunch(policy(), job(10), claudeInstall(), run(), opts)],
    ["executor mismatch", () => buildLaunch(policy(), job(20), claudeInstall(), run(), opts)],
    ["relative", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), materials: "runs/r1/materials" }, opts)],
    ["dot-dot", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), home: "/srv/synthetic/runs/r1/../home" }, opts)],
    ["trailing slash", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), tmp: "/srv/synthetic/runs/r1/tmp/" }, opts)],
    ["space", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), materials: "/srv/synthetic/run s/m" }, opts)],
    ["newline", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), materials: "/srv/synthetic/r\n1" }, opts)],
    ["materials in protected", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), materials: "/srv/synthetic/repo/materials" }, opts)],
    ["protected in home", () => buildLaunch(policy(), job(30), { ...claudeInstall(), protectedRoots: ["/srv/synthetic/runs/r1/home/.ssh"] }, run(), opts)],
    ["no protected roots", () => buildLaunch(policy(), job(30), { ...claudeInstall(), protectedRoots: [] }, run(), opts)],
    ["config in materials", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), config: "/srv/synthetic/runs/r1/materials/cfg" }, opts)],
    ["config is home", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), config: run().home }, opts)],
    ["config in protected", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), config: "/srv/synthetic/repo/cfg" }, opts)],
    // W5c (ISSUE50-P001): no shared Claude config dir; Codex keeps its CODEX_HOME.
    ["claude with a shared config dir", () => buildLaunch(policy(), job(30), { ...claudeInstall(), configDir: "/srv/synthetic/dispatch/claude-config" }, run(), opts)],
    ["codex without CODEX_HOME", () => buildMeasurementLaunch(policy(), job(20), { ...codexInstall(), configDir: null }, run(), opts)],
    ["used config dir", () => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: (d: string) => (d === run().config ? [file(".claude.json")] : []) })],
    ["unlistable config dir", () => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: (d: string) => { if (d === run().config) throw new Error("x"); return []; } })],
    ["home overlaps tmp", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), tmp: "/srv/synthetic/runs/r1/home/tmp", schemaFile: "/srv/synthetic/runs/r1/home/tmp/s.json" }, opts)],
    ["writable runtime", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), home: "/opt/synthetic/claude/2.1.300/home" }, opts)],
    ["executable outside runtime", () => buildLaunch(policy(), job(30), { ...claudeInstall(), executable: "/usr/local/bin/claude" }, run(), opts)],
    ["schema outside tmp", () => buildMeasurementLaunch(policy(), job(20), codexInstall(), { ...run(), schemaFile: "/srv/synthetic/runs/r1/materials/s.json" }, opts)],
    ["claude without token file", () => buildLaunch(policy(), job(30), { ...claudeInstall(), tokenFile: null }, run(), opts)],
    ["claude without profile", () => buildLaunch(policy(), job(30), { ...claudeInstall(), cliProfile: null }, run(), opts)],
    ["codex with profile", () => buildMeasurementLaunch(policy(), job(20), { ...codexInstall(), cliProfile: "/opt/synthetic/reviewed/seatbelt/cli.sb" }, run(), opts)],
    ["codex with token", () => buildMeasurementLaunch(policy(), job(20), { ...codexInstall(), tokenFile: "/srv/synthetic/owner-secrets/t" }, run(), opts)],
    ["token in config", () => buildLaunch(policy(), job(30), { ...claudeInstall(), tokenFile: "/srv/synthetic/runs/r1/config/token" }, run(), opts)],
    ["token in materials", () => buildLaunch(policy(), job(30), { ...claudeInstall(), tokenFile: "/srv/synthetic/runs/r1/materials/token" }, run(), opts)],
    ["token in home", () => buildLaunch(policy(), job(30), { ...claudeInstall(), tokenFile: "/srv/synthetic/runs/r1/home/token" }, run(), opts)],
    ["bad token", () => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, readToken: () => "short" })],
    ["old claude", () => buildLaunch(policy(), job(30), { ...claudeInstall(), version: "2.1.267" }, run(), opts)],
    ["unpinned", () => buildLaunch(policy(), job(30), { ...claudeInstall(), version: "latest" }, run(), opts)],
  ];
  for (const [name, f] of cases)
    assert.throws(f, (e: unknown) => {
      assert.ok(e instanceof LaunchError, name);
      assert.ok(!e.message.includes("/") && !e.message.includes(TOKEN), `${name}: ${e.message}`);
      return true;
    }, name);
  for (const name of ["CLAUDE.md", "AGENTS.md", ".claude", ".mcp.json", ".codex", ".git", "CLAUDE.local.md"])
    assert.throws(
      () => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: () => [file("src"), file(name)] }),
      LaunchError,
      name,
    );
  // Case and Unicode normalization do not hide a name (macOS volumes are case-insensitive).
  for (const name of ["claude.MD", "Agents.md", ".CLAUDE", ".Mcp.Json", "AGENTS.OVERRIDE.MD", ".Git"])
    assert.throws(() => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: () => [file(name)] }), LaunchError, name);
  assert.throws(() => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: () => [{ name: "a", kind: "other", nlink: 1 }] }), LaunchError);
  assert.throws(() => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: () => [{ name: "a", kind: "file", nlink: 2 }] }), LaunchError);
  assert.doesNotThrow(() => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: (d: string) => (d === run().materials ? [{ name: "src", kind: "dir", nlink: 3 }, file("main.ts")] : []) }));
  assert.throws(() => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: () => { throw new Error("ENOENT"); } }), LaunchError);
  for (const p of ["/srv/synthetic/runs/r1/CLAUDE.md", "/srv/synthetic/AGENTS.md", "/.git"])
    assert.throws(() => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, exists: (x) => x === p }), LaunchError, p);
  // A home-level .claude directory is not configuration of the materials and is allowed.
  assert.doesNotThrow(() =>
    buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, exists: (x) => x === "/srv/synthetic/.claude" }),
  );
});

test("token file: owner-only regular file in an owner-only directory, else refused without echoing the value", (t) => {
  if (process.platform === "win32") {
    // Not a skip: workers launch on macOS only, and POSIX owner/mode checks cannot pass here.
    assert.throws(() => readTokenFile("C:/x"), LaunchError);
    t.diagnostic("Windows: token files are refused (no POSIX owner or mode)");
    return;
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kl-token-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "secrets");
  mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, "claude-setup-token");
  writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
  assert.equal(readTokenFile(file), TOKEN);
  const refuses = (why: string) =>
    assert.throws(() => readTokenFile(file), (e: unknown) => e instanceof LaunchError && !e.message.includes(TOKEN), why);
  chmodSync(file, 0o640);
  refuses("group readable");
  chmodSync(file, 0o400);
  assert.equal(readTokenFile(file), TOKEN);
  chmodSync(file, 0o600);
  chmodSync(dir, 0o770);
  refuses("group-writable directory");
  chmodSync(dir, 0o700);
  assert.throws(() => readTokenFile(file, { uid: (process.getuid?.() ?? 0) + 1 }), LaunchError);
  writeFileSync(file, "has space in it and is long enough\n", { mode: 0o600 });
  refuses("malformed");
  writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
  const link = join(dir, "link");
  symlinkSync(file, link);
  assert.throws(() => readTokenFile(link), LaunchError);
  const hard = join(dir, "hard");
  linkSync(file, hard);
  refuses("hard link");
  rmSync(hard);
  assert.throws(() => readTokenFile(join(dir, "missing")), (e: unknown) => e instanceof LaunchError && !e.message.includes("/"));
  assert.throws(() => readTokenFile("relative/token"), LaunchError);
});

test("checkPlan catches tampered plans independently of the builder", () => {
  const base = () => buildLaunch(policy(), job(30), claudeInstall(), run(), opts);
  const edit = (f: (p: LaunchPlan) => void): string[] => {
    const p = base();
    f(p);
    return checkPlan(p, claudeInstall(), run());
  };
  const set = (p: LaunchPlan, flag: string, value: string) => {
    p.args[p.args.indexOf(flag) + 1] = value;
  };
  const settings = (p: LaunchPlan, f: (s: Record<string, any>) => void) => {
    const s = JSON.parse(flagValue(p, "--settings")!);
    f(s);
    set(p, "--settings", JSON.stringify(s));
  };
  assert.ok(edit((p) => p.args.push("--bare")).includes("bare"));
  // Exact match: duplicates, reordering and later repeats are caught even when named checks pass.
  assert.ok(edit((p) => p.args.push("--tools", "Read,Grep,Glob")).includes("not-canonical"));
  assert.ok(edit((p) => p.args.push("--settings", "{}")).includes("not-canonical"));
  assert.ok(edit((p) => p.args.push("--add-dir", "/srv/synthetic/repo")).includes("not-canonical"));
  assert.ok(edit((p) => (p.cwd = "/srv/synthetic/other")).includes("not-canonical"));
  assert.ok(edit((p) => (p.env["HOME"] = "/srv/synthetic/owner")).includes("not-canonical"));
  assert.deepEqual(edit(() => {}), []);
  assert.ok(edit((p) => (p.env["GH_TOKEN"] = "synthetic")).includes("env-not-allowlisted"));
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "KL_X", "GITHUB_TOKEN"])
    assert.ok(edit((p) => (p.env[k] = "synthetic")).includes("credential-env"), k);
  assert.ok(edit((p) => delete p.env[TOKEN_ENV]).includes("no-subscription-token"));
  assert.ok(edit((p) => delete p.env["CLAUDE_CONFIG_DIR"]).includes("env-not-allowlisted"));
  // W4e: Claude's own temp files must stay in the run tmp (cli.sb denies /tmp).
  const noTmp = edit((p) => delete p.env["CLAUDE_CODE_TMPDIR"]);
  assert.ok(noTmp.includes("claude-tmpdir") && noTmp.includes("env-not-allowlisted"));
  for (const v of ["/tmp", "/private/tmp", "/srv/synthetic/runs/r1", "/srv/synthetic/runs/r2/tmp", `${run().tmp}/sub`, ""]) {
    const r = edit((p) => (p.env["CLAUDE_CODE_TMPDIR"] = v));
    assert.ok(r.includes("claude-tmpdir") && r.includes("not-canonical"), v);
  }
  assert.ok(edit((p) => set(p, "--tools", "default")).includes("tools"));
  assert.ok(edit((p) => set(p, "--allowedTools", "Read")).includes("tools"));
  assert.ok(edit((p) => set(p, "--allowedTools", "Read(//**)")).includes("tools"));
  assert.ok(edit((p) => set(p, "--permission-mode", "bypassPermissions")).includes("permissions"));
  assert.ok(edit((p) => set(p, "--mcp-config", '{"mcpServers":{"x":{"command":"/bin/sh"}}}')).includes("mcp"));
  assert.ok(edit((p) => p.args.splice(p.args.indexOf("--strict-mcp-config"), 1)).includes("mcp"));
  assert.ok(edit((p) => settings(p, (s) => (s.hooks = { SessionStart: [] }))).includes("hooks"));
  assert.ok(edit((p) => settings(p, (s) => (s.apiKeyHelper = "/bin/echo"))).includes("hooks"));
  assert.ok(edit((p) => settings(p, (s) => (s.env = { ANTHROPIC_API_KEY: "x" }))).includes("hooks"));
  assert.ok(edit((p) => settings(p, (s) => (s.permissions.allow = ["Read"]))).includes("hooks"));
  assert.ok(edit((p) => settings(p, (s) => (s.disableAllHooks = false))).includes("hooks"));
  for (const f of ["--safe-mode", "--restricted"])
    assert.ok(edit((p) => p.args.splice(p.args.indexOf(f), 1)).includes("isolation"), f);
  assert.ok(edit((p) => p.args.push("--plugin-dir", "/x")).includes("forbidden-flag"));
  assert.ok(edit((p) => (p.file = "/bin/sh")).includes("not-sandboxed"));
  const codex = () => buildMeasurementLaunch(policy(), job(20), codexInstall(), run(), opts);
  const c1 = codex();
  c1.args.push("--dangerously-bypass-approvals-and-sandbox");
  assert.ok(checkPlan(c1, codexInstall(), run()).includes("forbidden-flag"));
  const c2 = codex();
  c2.args[c2.args.indexOf("read-only")] = "danger-full-access";
  assert.ok(checkPlan(c2, codexInstall(), run()).includes("codex-isolation"));
  const c3 = codex();
  c3.env[TOKEN_ENV] = TOKEN;
  assert.ok(checkPlan(c3, codexInstall(), run()).includes("credential-env"));
});

test("argv template hash ignores per-run paths and the token, and binds the install shape", () => {
  const a = argvTemplateHash(claudeInstall());
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(argvTemplateHash(claudeInstall()), a);
  assert.equal(argvTemplateHash({ ...claudeInstall(), tokenFile: "/srv/synthetic/other/t" }), a);
  assert.notEqual(argvTemplateHash({ ...claudeInstall(), executable: "/opt/synthetic/claude/2.1.300/bin/other" }), a);
  assert.notEqual(argvTemplateHash({ ...claudeInstall(), cliProfile: "/opt/synthetic/other/cli.sb" }), a);
  assert.notEqual(argvTemplateHash(codexInstall()), a);
  // W5c: each run has its own config dir; the plan follows the run, the template does not change.
  const other = { ...run(), materials: "/srv/synthetic/runs/r2/materials", home: "/srv/synthetic/runs/r2/home", tmp: "/srv/synthetic/runs/r2/tmp", config: "/srv/synthetic/runs/r2/config", schemaFile: "/srv/synthetic/runs/r2/tmp/result-schema.json" };
  const p1 = buildLaunch(policy(), job(30), claudeInstall(), run(), opts);
  const p2 = buildLaunch(policy(), job(30), claudeInstall(), other, opts);
  assert.equal(p1.env["CLAUDE_CONFIG_DIR"], run().config);
  assert.equal(p2.env["CLAUDE_CONFIG_DIR"], other.config);
  assert.ok(p2.args.includes(`CONFIG_DIR=${other.config}`) && !p2.args.some((x) => x.includes(run().config)));
  assert.equal(claudeVersionSupported("2.1.268"), true);
  assert.equal(claudeVersionSupported("2.1.267"), false);
  assert.equal(claudeVersionSupported("2.2.0"), true);
  assert.equal(claudeVersionSupported("3.0.0"), true);
  assert.equal(claudeVersionSupported("2.1.259"), false);
  assert.equal(claudeVersionSupported("2.0.999"), false);
  assert.equal(claudeVersionSupported("2.1.268-beta"), false);
});

test("synthetic PR tree: CLI configuration anywhere in the materials refuses the launch", (t) => {
  // Real directory tree listed by the real scanTree; the launch paths stay synthetic.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kl-launch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = () => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: (d: string) => (d === run().config ? [] : scanTree(root)) });
  mkdirSync(join(root, "pr", "src"), { recursive: true });
  writeFileSync(join(root, "pr", "src", "main.ts"), "export {};\n");
  writeFileSync(join(root, "diff.txt"), "synthetic diff\n");
  assert.doesNotThrow(plan);
  assert.ok(scanTree(root).every((e) => e.kind !== "other"));
  for (const [dir, name, isDir] of [
    ["pr", ".claude", true],
    ["pr/src", ".mcp.json", false],
    ["pr", "CLAUDE.md", false],
    ["pr/src", "AGENTS.md", false],
    ["", ".git", true],
    ["pr", ".codex", true],
    ["pr", "Claude.md", false],
    ["pr/src", ".MCP.json", false],
  ] as const) {
    const p = join(root, ...dir.split("/").filter(Boolean), name);
    if (isDir) mkdirSync(p);
    else writeFileSync(p, "synthetic\n");
    assert.throws(plan, LaunchError, name);
    rmSync(p, { recursive: true });
  }
  assert.doesNotThrow(plan);
  if (process.platform !== "win32") {
    // Real links and special files: refused before anything starts.
    symlinkSync("/srv/synthetic/elsewhere", join(root, "pr", "link"));
    assert.throws(plan, LaunchError, "symlink");
    rmSync(join(root, "pr", "link"));
    linkSync(join(root, "diff.txt"), join(root, "pr", "hard.txt"));
    assert.throws(plan, LaunchError, "hard link");
    rmSync(join(root, "pr", "hard.txt"));
    assert.doesNotThrow(plan);
  }
});

test("auth status runs under the same profile and env, Claude only", () => {
  const p = buildAuthStatus(claudeInstall(), run(), opts);
  assert.equal(p.file, SANDBOX_EXEC);
  assert.deepEqual(p.args.slice(-3), [claudeInstall().executable, "auth", "status"]);
  assert.deepEqual(Object.keys(p.env).sort(), [...ENV_KEYS.claude].sort());
  assert.equal(p.env[TOKEN_ENV], TOKEN);
  assert.equal(p.env["CLAUDE_CODE_TMPDIR"], run().tmp);
  const m = buildMeasurementLaunch(policy(), job(30), claudeInstall(), run(), opts);
  assert.equal(m.env["CLAUDE_CODE_TMPDIR"], run().tmp);
  assert.throws(() => buildAuthStatus(codexInstall(), run(), opts), LaunchError);
});

// ---- W5d: the result schema and jobText state what parseResult enforces ----

// A minimal validator for exactly the keywords RESULT_SCHEMA uses (the repository has no JSON Schema library).
// Any other keyword fails the test, so a new one cannot pass unchecked. Lengths count code points (JSON Schema).
type Schema = Record<string, unknown>;
const KEYWORDS = new Set(["type", "enum", "required", "additionalProperties", "properties", "items", "maxItems", "minLength", "maxLength", "pattern"]);
function schemaValid(s: Schema, v: unknown): boolean {
  for (const k of Object.keys(s)) assert.ok(KEYWORDS.has(k), `unchecked keyword ${k}`);
  if (s["type"] === "object") {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>,
      props = (s["properties"] ?? {}) as Record<string, Schema>;
    if (((s["required"] ?? []) as string[]).some((k) => !Object.hasOwn(o, k))) return false;
    if (s["additionalProperties"] === false && Object.keys(o).some((k) => !Object.hasOwn(props, k))) return false;
    if (!Object.entries(o).every(([k, x]) => !props[k] || schemaValid(props[k], x))) return false;
  } else if (s["type"] === "array") {
    if (!Array.isArray(v)) return false;
    if (typeof s["maxItems"] === "number" && v.length > s["maxItems"]) return false;
    if (s["items"] && !v.every((x) => schemaValid(s["items"] as Schema, x))) return false;
  } else if (s["type"] === "string") {
    if (typeof v !== "string") return false;
    const n = [...v].length;
    if (typeof s["minLength"] === "number" && n < s["minLength"]) return false;
    if (typeof s["maxLength"] === "number" && n > s["maxLength"]) return false;
    if (typeof s["pattern"] === "string" && !new RegExp(s["pattern"], "u").test(v)) return false;
  } else if (s["type"] === "integer") {
    if (!Number.isInteger(v)) return false;
  } else return false;
  return !Array.isArray(s["enum"]) || s["enum"].includes(v);
}
const SCHEMA = JSON.parse(RESULT_SCHEMA_JSON) as Schema;
const REPO = "https://github.com/synthetic/repository";
const LINKS = [`${REPO}/actions/runs/123`, `${REPO}/pull/1#pullrequestreview-456`, `${REPO}/commit/${"c".repeat(40)}`];
const ffJob = (): Job => ({ ...job(30), kind: "faultfinding" });
const RECORD = "record-comment-75";
const result = (j: Job, extra: Partial<WorkerResult> = {}): WorkerResult => ({
  schema: 1,
  run: j.run,
  actor: j.actor,
  generation: j.generation,
  pair: j.pair,
  decision: "needs-owner",
  summary: "合成の要約です。",
  findings: [],
  evidence: [],
  unverified: [],
  causes: [],
  previous: [],
  ...extra,
});
const finding = (id: string, text = "x") => ({ id, location: text, impact: text, completion: text });
const row = (cause: string, where = "x") => ({ cause, judgement: "該当なし" as const, where });

test("W5d result schema: the limits parseResult enforces come from the same constants, the evidence shape included", () => {
  const props = SCHEMA["properties"] as Record<string, Schema>;
  assert.equal((props["evidence"]!["items"] as Schema)["pattern"], EVIDENCE_SHAPE.source);
  assert.equal(new RegExp(EVIDENCE_SHAPE.source, "u").source, EVIDENCE_SHAPE.source);
  const cause = ((props["causes"]!["items"] as Schema)["properties"] as Record<string, Schema>)["cause"]!;
  assert.equal(cause["pattern"], CAUSE_KEY.source);
  for (const k of ["findings", "evidence", "unverified", "causes", "previous"] as const)
    assert.equal(props[k]!["maxItems"], RESULT_LIMITS[k], k);
  assert.equal(props["summary"]!["maxLength"], RESULT_LIMITS.text);
  // The argv carries this schema, so the measured argv hash binds it (an older measurement becomes stale).
  const p = buildLaunch(policy(), job(30), claudeInstall(), run(), opts);
  assert.equal(flagValue(p, "--json-schema"), JSON.stringify(RESULT_SCHEMA));
  assert.match(flagValue(p, "--json-schema")!, /pullrequestreview/);
});

test("W5d result schema is never stricter than parseResult, and what it refuses parseResult also refuses", () => {
  const r = job(30),
    ff = ffJob();
  const passes: [Job, WorkerResult][] = [
    [r, result(r)],
    [r, result(r, { decision: "changes-requested", summary: "一行目\n二行目\tタブ", findings: [finding("PR1-R001")], evidence: LINKS, unverified: ["実CLIは未検証"] })],
    [r, result(r, { summary: "x".repeat(RESULT_LIMITS.text), unverified: ["y".repeat(RESULT_LIMITS.text)] })],
    [r, result(r, { decision: "changes-requested", findings: Array.from({ length: RESULT_LIMITS.findings }, (_, n) => finding(`PR1-R${String(n + 1).padStart(3, "0")}`)) })],
    [r, result(r, { decision: "changes-requested", findings: [finding("PR1-R001", "z".repeat(RESULT_LIMITS.text))] })],
    [r, result(r, { evidence: Array.from({ length: RESULT_LIMITS.evidence }, (_, n) => `${REPO}/actions/runs/${n + 1}`) })],
    [r, result(r, { unverified: Array.from({ length: RESULT_LIMITS.unverified }, (_, n) => `項目${n}`) })],
    [ff, result(ff, { decision: "changes-requested", findings: [finding("RT-1")], causes: [row("INV-LOCK/restore-lock-identity", "w".repeat(RESULT_LIMITS.cell)), row("INV-ROOT")], previous: [{ id: RECORD, status: "未解消", reason: "r".repeat(RESULT_LIMITS.cell) }, { id: "RT-2", status: "解消", reason: "直った" }] })],
    [ff, result(ff, { causes: Array.from({ length: RESULT_LIMITS.causes }, (_, n) => row(`INV-${n}`)), previous: Array.from({ length: RESULT_LIMITS.previous }, (_, n) => ({ id: `RT-${n + 1}`, status: "解消" as const, reason: "x" })) })],
  ];
  for (const [j, v] of passes) {
    assert.deepEqual(parseResult(JSON.stringify(v), j, [RECORD]), v);
    assert.ok(schemaValid(SCHEMA, v), JSON.stringify(v).slice(0, 120));
  }
  const fails: [Job, Partial<WorkerResult>][] = [
    // The owner's measurement (W5d): prose instead of a link.
    [r, { evidence: ["Grepで教材を確認した"] }],
    [r, { evidence: ["pr/index.json"] }],
    [r, { evidence: [`${REPO}/issues/1`] }],
    [r, { evidence: Array.from({ length: RESULT_LIMITS.evidence + 1 }, () => LINKS[0]!) }],
    [r, { summary: "" }],
    [r, { summary: "x".repeat(RESULT_LIMITS.text + 1) }],
    [r, { summary: "a\rb" }],
    [r, { summary: "hello @participant" }],
    [r, { summary: "<!-- marker -->" }],
    [r, { unverified: [""] }],
    [r, { unverified: ["x\ny"] }],
    [r, { unverified: ["x".repeat(RESULT_LIMITS.text + 1)] }],
    [r, { unverified: Array.from({ length: RESULT_LIMITS.unverified + 1 }, () => "x") }],
    [r, { decision: "changes-requested", findings: [finding("R-1")] }],
    [r, { decision: "changes-requested", findings: [{ ...finding("PR1-R001"), location: "x\ny" }] }],
    [r, { decision: "changes-requested", findings: [finding("PR1-R001", "x".repeat(RESULT_LIMITS.text + 1))] }],
    [r, { decision: "changes-requested", findings: Array.from({ length: RESULT_LIMITS.findings + 1 }, (_, n) => finding(`PR1-R${String(n + 1).padStart(3, "0")}`)) }],
    [ff, { causes: [row("bad key!")] }],
    [ff, { causes: [row("INV-LOCK", "a|b")] }],
    [ff, { causes: [row("INV-LOCK", "x".repeat(RESULT_LIMITS.cell + 1))] }],
    [ff, { causes: Array.from({ length: RESULT_LIMITS.causes + 1 }, (_, n) => row(`INV-${n}`)) }],
    [ff, { previous: [{ id: "RT-0", status: "解消", reason: "x" }] }],
    [ff, { previous: Array.from({ length: RESULT_LIMITS.previous + 1 }, (_, n) => ({ id: `RT-${n + 1}`, status: "解消" as const, reason: "x" })) }],
  ];
  for (const [j, extra] of fails) {
    const v = result(j, extra);
    assert.throws(() => parseResult(JSON.stringify(v), j, [RECORD]), JSON.stringify(extra).slice(0, 80));
    assert.equal(schemaValid(SCHEMA, v), false, JSON.stringify(extra).slice(0, 80));
  }
});

test("W5d jobText states the rules the schema cannot express: evidence forms of this repository, one-line items, limits", () => {
  const stdin = buildLaunch(policy(), job(30), claudeInstall(), run(), opts).stdin;
  for (const form of [`${REPO}/actions/runs/RUN_ID`, `${REPO}/pull/NUMBER#pullrequestreview-REVIEW_ID`, `${REPO}/commit/SHA`])
    assert.ok(stdin.includes(form), form);
  assert.match(stdin, /Evidence: only links of these forms, otherwise an empty list/);
  assert.match(stdin, /Unverified: what you could not check, one line each/);
  assert.ok(stdin.includes(`${RESULT_LIMITS.text} characters`) && stdin.includes(`${RESULT_LIMITS.cell} per table cell`));
  assert.match(stdin, /no "<" or "@" \(full-width forms count as the same\)/);
  // W9 (PR #66 P3, PR #71 RT-1): every publication rule is stated, in the words kept next to the rule.
  for (const [finding, words] of Object.entries(PUBLICATION_RULES)) assert.ok(stdin.includes(words), finding);
  // Never a line the owner's measurement reads as a probe step (doctor.test.ts).
  assert.ok(!/^- /m.test(stdin));
  const ff = buildLaunch(policy(), ffJob(), claudeInstall(), run(), opts).stdin;
  assert.match(ff, /Evidence: only links/);
});

test("W9 every finding publicationFindings reports has its words in PUBLICATION_RULES, and following the words passes", () => {
  // One synthetic breach per rule (PR #71 RT-1: the encoded anchor and another commit's SHA blocked a review).
  const breaches: [string, string][] = [
    ["format character", "a\u200bb"],
    ["key/token", "ghp_" + "A".repeat(20)],
    ["local absolute path", "see " + ["", "Us" + "ers", "alice", "x"].join("/")], // assembled: no path literal in this file
    ["link not allowed", "https://example.com/x"],
    ["link not allowed", "https://github.com"],
    ["link not allowed", "[design](docs/review-dispatch-design.md)"],
    ["link not allowed", "www.example.org"],
    ["link not allowed", "x = 1; //TODO"],
    ["percent-encoded data", "https://github.com/doc-gif/kurashi-ledger/blob/main/docs/a.md#18-%E5%BA%83%E3%81%92"],
    ["opaque key-like string", "main is 8270f63cfebb83f939d210eafa1b6fcb0de12345 now"],
  ];
  const seen = new Set<string>();
  for (const [finding, text] of breaches) {
    const found = publicationFindings(text, new Set());
    assert.ok(found.includes(finding), `${finding}: ${JSON.stringify(found)}`);
    // Anything else it reports is a public-policy label, covered by "keys, tokens" or "@".
    for (const f of found) assert.ok(f in PUBLICATION_RULES || textFindings(text).includes(f), f);
    seen.add(finding);
  }
  assert.deepEqual([...seen].sort(), Object.keys(PUBLICATION_RULES).sort());
  // What the words ask for instead passes.
  for (const text of [
    "https://github.com/doc-gif/kurashi-ledger/blob/main/docs/a.md#18-広げる",
    "https://github.com/",
    "main is 8270f63 now",
    "x = 1; // note",
    "the head 8270f63cfebb83f939d210eafa1b6fcb0de12345 of this pull request",
  ])
    assert.deepEqual(publicationFindings(text, new Set(["8270f63cfebb83f939d210eafa1b6fcb0de12345"])), [], text);
});
