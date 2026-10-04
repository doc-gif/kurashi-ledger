import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ENV_KEYS,
  FIXED_QUERY,
  LaunchError,
  RESULT_SCHEMA_JSON,
  SANDBOX_EXEC,
  TOKEN_ENV,
  argvTemplateHash,
  buildAuthStatus,
  buildLaunch,
  checkPlan,
  claudeVersionSupported,
  readTokenFile,
  scanTree,
  type LaunchInstall,
  type LaunchPlan,
  type LaunchRun,
} from "./launcher.ts";
import type { Job } from "./model.ts";
import { policy } from "../../../tests/fixtures/review-dispatch.ts";

// Synthetic paths only. Nothing here is spawned.
const TOKEN = "synthetic-setup-token-0123456789abcdef";
const claudeInstall = (): LaunchInstall => ({
  backend: "claude",
  executable: "/opt/synthetic/claude/2.1.300/bin/claude",
  version: "2.1.300",
  runtime: "/opt/synthetic/claude/2.1.300",
  cliProfile: "/opt/synthetic/reviewed/seatbelt/cli.sb",
  configDir: "/srv/synthetic/dispatch/claude-config",
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
  scan: () => ({ names: [], symlink: false }),
  readToken: () => TOKEN,
};
const flagValue = (p: LaunchPlan, flag: string) => p.args[p.args.indexOf(flag) + 1];

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
      "-D", `CONFIG_DIR=${claudeInstall().configDir}`,
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
    assert.ok(settings.permissions.deny.includes(`Read(/${claudeInstall().configDir}/**)`));
    assert.ok(!("hooks" in settings) && !("apiKeyHelper" in settings) && !("env" in settings));
    assert.deepEqual(Object.keys(p.env).sort(), [...ENV_KEYS.claude].sort());
    assert.equal(p.env[TOKEN_ENV], TOKEN);
    assert.equal(p.env["CLAUDE_CONFIG_DIR"], claudeInstall().configDir);
    assert.equal(p.env["HOME"], run().home);
    const everything = JSON.stringify(p);
    for (const v of Object.values(secrets)) assert.ok(!everything.includes(v));
    // The token is only in the env, never in argv or stdin.
    assert.ok(!p.args.some((a) => a.includes(TOKEN)) && !p.stdin.includes(TOKEN));
    // Job data reaches the CLI only through stdin.
    assert.match(p.stdin, /Head: a{40}\nBase: b{40}/);
    assert.ok(!p.args.some((a) => a.includes("a".repeat(40))));
    assert.deepEqual(checkPlan(p, "claude"), []);
  } finally {
    process.env = saved;
  }
});

test("Codex launch: codex exec --sandbox read-only only, no outer Seatbelt, no token", () => {
  let read = 0;
  const p = buildLaunch(policy(), job(20), codexInstall(), run(), { ...opts, readToken: () => String(++read) });
  assert.equal(read, 0);
  assert.equal(p.file, codexInstall().executable);
  assert.deepEqual(p.args, [
    "exec", "--json", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config",
    "--ignore-rules", "--skip-git-repo-check", "--color", "never",
    "--cd", run().materials, "--output-schema", run().schemaFile, "-",
  ]);
  assert.deepEqual(Object.keys(p.env).sort(), [...ENV_KEYS.codex].sort());
  assert.equal(p.env["CODEX_HOME"], codexInstall().configDir);
  assert.deepEqual(checkPlan(p, "codex"), []);
  const wrapped = { ...p, file: SANDBOX_EXEC, args: ["-f", "/opt/x/cli.sb", codexInstall().executable, ...p.args] };
  assert.ok(checkPlan(wrapped, "codex").includes("codex-wrapped"));
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
    ["config in materials", () => buildLaunch(policy(), job(30), { ...claudeInstall(), configDir: "/srv/synthetic/runs/r1/materials/cfg" }, run(), opts)],
    ["home overlaps tmp", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), tmp: "/srv/synthetic/runs/r1/home/tmp", schemaFile: "/srv/synthetic/runs/r1/home/tmp/s.json" }, opts)],
    ["writable runtime", () => buildLaunch(policy(), job(30), claudeInstall(), { ...run(), home: "/opt/synthetic/claude/2.1.300/home" }, opts)],
    ["executable outside runtime", () => buildLaunch(policy(), job(30), { ...claudeInstall(), executable: "/usr/local/bin/claude" }, run(), opts)],
    ["schema outside tmp", () => buildLaunch(policy(), job(20), codexInstall(), { ...run(), schemaFile: "/srv/synthetic/runs/r1/materials/s.json" }, opts)],
    ["claude without token file", () => buildLaunch(policy(), job(30), { ...claudeInstall(), tokenFile: null }, run(), opts)],
    ["claude without profile", () => buildLaunch(policy(), job(30), { ...claudeInstall(), cliProfile: null }, run(), opts)],
    ["codex with profile", () => buildLaunch(policy(), job(20), { ...codexInstall(), cliProfile: "/opt/synthetic/reviewed/seatbelt/cli.sb" }, run(), opts)],
    ["codex with token", () => buildLaunch(policy(), job(20), { ...codexInstall(), tokenFile: "/srv/synthetic/owner-secrets/t" }, run(), opts)],
    ["token in config", () => buildLaunch(policy(), job(30), { ...claudeInstall(), tokenFile: "/srv/synthetic/dispatch/claude-config/token" }, run(), opts)],
    ["token in materials", () => buildLaunch(policy(), job(30), { ...claudeInstall(), tokenFile: "/srv/synthetic/runs/r1/materials/token" }, run(), opts)],
    ["token in home", () => buildLaunch(policy(), job(30), { ...claudeInstall(), tokenFile: "/srv/synthetic/runs/r1/home/token" }, run(), opts)],
    ["bad token", () => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, readToken: () => "short" })],
    ["old claude", () => buildLaunch(policy(), job(30), { ...claudeInstall(), version: "2.1.258" }, run(), opts)],
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
      () => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: () => ({ names: ["src", name], symlink: false }) }),
      LaunchError,
      name,
    );
  assert.throws(() => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: () => ({ names: ["a"], symlink: true }) }), LaunchError);
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
  assert.throws(() => readTokenFile(join(dir, "missing")));
  assert.throws(() => readTokenFile("relative/token"), LaunchError);
});

test("checkPlan catches tampered plans independently of the builder", () => {
  const base = () => buildLaunch(policy(), job(30), claudeInstall(), run(), opts);
  const edit = (f: (p: LaunchPlan) => void): string[] => {
    const p = base();
    f(p);
    return checkPlan(p, "claude");
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
  assert.ok(edit((p) => (p.env["GH_TOKEN"] = "synthetic")).includes("env-not-allowlisted"));
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "KL_X", "GITHUB_TOKEN"])
    assert.ok(edit((p) => (p.env[k] = "synthetic")).includes("credential-env"), k);
  assert.ok(edit((p) => delete p.env[TOKEN_ENV]).includes("no-subscription-token"));
  assert.ok(edit((p) => delete p.env["CLAUDE_CONFIG_DIR"]).includes("env-not-allowlisted"));
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
  const codex = () => buildLaunch(policy(), job(20), codexInstall(), run(), opts);
  const c1 = codex();
  c1.args.push("--dangerously-bypass-approvals-and-sandbox");
  assert.ok(checkPlan(c1, "codex").includes("forbidden-flag"));
  const c2 = codex();
  c2.args[c2.args.indexOf("read-only")] = "danger-full-access";
  assert.ok(checkPlan(c2, "codex").includes("codex-isolation"));
  const c3 = codex();
  c3.env[TOKEN_ENV] = TOKEN;
  assert.ok(checkPlan(c3, "codex").includes("credential-env"));
});

test("argv template hash ignores per-run paths and the token, and binds the install shape", () => {
  const a = argvTemplateHash(claudeInstall());
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(argvTemplateHash(claudeInstall()), a);
  assert.equal(argvTemplateHash({ ...claudeInstall(), tokenFile: "/srv/synthetic/other/t" }), a);
  assert.notEqual(argvTemplateHash({ ...claudeInstall(), executable: "/opt/synthetic/claude/2.1.300/bin/other" }), a);
  assert.notEqual(argvTemplateHash({ ...claudeInstall(), cliProfile: "/opt/synthetic/other/cli.sb" }), a);
  assert.notEqual(argvTemplateHash(codexInstall()), a);
  assert.equal(claudeVersionSupported("2.1.259"), true);
  assert.equal(claudeVersionSupported("2.2.0"), true);
  assert.equal(claudeVersionSupported("3.0.0"), true);
  assert.equal(claudeVersionSupported("2.1.258"), false);
  assert.equal(claudeVersionSupported("2.0.999"), false);
  assert.equal(claudeVersionSupported("2.1.259-beta"), false);
});

test("synthetic PR tree: CLI configuration anywhere in the materials refuses the launch", (t) => {
  // Real directory tree listed by the real scanTree; the launch paths stay synthetic.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kl-launch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = () => buildLaunch(policy(), job(30), claudeInstall(), run(), { ...opts, scan: () => scanTree(root) });
  mkdirSync(join(root, "pr", "src"), { recursive: true });
  writeFileSync(join(root, "pr", "src", "main.ts"), "export {};\n");
  writeFileSync(join(root, "diff.txt"), "synthetic diff\n");
  assert.doesNotThrow(plan);
  assert.equal(scanTree(root).symlink, false);
  for (const [dir, name, isDir] of [
    ["pr", ".claude", true],
    ["pr/src", ".mcp.json", false],
    ["pr", "CLAUDE.md", false],
    ["pr/src", "AGENTS.md", false],
    ["", ".git", true],
    ["pr", ".codex", true],
  ] as const) {
    const p = join(root, ...dir.split("/").filter(Boolean), name);
    if (isDir) mkdirSync(p);
    else writeFileSync(p, "synthetic\n");
    assert.throws(plan, LaunchError, name);
    rmSync(p, { recursive: true });
  }
  assert.doesNotThrow(plan);
});

test("auth status runs under the same profile and env, Claude only", () => {
  const p = buildAuthStatus(claudeInstall(), run(), opts);
  assert.equal(p.file, SANDBOX_EXEC);
  assert.deepEqual(p.args.slice(-3), [claudeInstall().executable, "auth", "status"]);
  assert.deepEqual(Object.keys(p.env).sort(), [...ENV_KEYS.claude].sort());
  assert.equal(p.env[TOKEN_ENV], TOKEN);
  assert.throws(() => buildAuthStatus(codexInstall(), run(), opts), LaunchError);
});
