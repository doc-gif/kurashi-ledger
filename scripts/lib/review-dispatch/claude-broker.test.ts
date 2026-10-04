import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  CLAUDE_AGENT,
  REVIEW_PURPOSE,
  ClaudeAppTransport,
  claudeBrokerCommand,
  claudeBrokerEnvironment,
  createClaudeReviewBroker,
  relay,
  relayMain,
  validateInstall,
  type ClaudeBrokerInstall,
  type SpawnRelay,
} from "./claude-broker.ts";
import {
  ReviewBroker,
  parseResult,
  render,
  type BrokerTransport,
  type PostedReview,
} from "./broker.ts";
import { Dispatcher, fixtureResult } from "./runtime.ts";
import { publicationFindings, allowedFor } from "./publication.ts";
import { RunVerifier, parseRunKeyLine, parseSignedResult, provenanceOf } from "./provenance.ts";
import type { Job } from "./model.ts";
import {
  RunChannel,
  adoptVectorJob,
  signedVector,
} from "../../../tests/fixtures/review-dispatch-run-channel.ts";
import { ghReviewTransport } from "./github.ts";
import {
  database,
  claim,
  policy,
  snapshot,
} from "../../../tests/fixtures/review-dispatch.ts";

// Synthetic installation. Never the owner's real App IDs or paths; no real wrapper, keychain, gh or network.
const install = (): ClaudeBrokerInstall => ({
  node: "/synthetic/trusted/bin/node",
  wrapper: "/synthetic/trusted/copy/scripts/github-app-token.ts",
  relay: "/synthetic/trusted/copy/scripts/review-dispatch-claude-broker.ts",
  gh: "/synthetic/trusted/bin/gh",
  appId: "101",
  installationId: "202",
  repo: "synthetic/repository",
  actor: 30,
});
const HOME = "/synthetic/home";
const TOKEN = `ghs_${"S".repeat(36)}`;

type Spawned = { command: string; args: string[]; env: Record<string, string> };
// In-process stand-in for "wrapper -> relay child": it runs the real relay loop against a fake GitHub transport.
function fakeSpawn(
  github: BrokerTransport,
  spawned: Spawned[],
  options: { silent?: boolean } = {},
): SpawnRelay {
  return (command, args, env) => {
    spawned.push({ command, args, env });
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      events = new EventEmitter();
    let exited = false;
    const exit = (): void => {
      if (exited) return;
      exited = true;
      events.emit("exit", 0);
    };
    if (!options.silent)
      void relay(
        createInterface({ input: stdin, crlfDelay: Infinity }),
        (line) => stdout.write(line),
        () => github,
      ).then(exit);
    return {
      stdin,
      stdout,
      once: (event, listener) => events.once(event, listener),
      kill: () => {
        stdin.destroy();
        exit();
      },
    };
  };
}
function github(rows: PostedReview[], counter: { posts: number; lists: number }): BrokerTransport {
  return {
    list: async () => {
      counter.lists++;
      return rows;
    },
    post: async (_pr, _event, head, body) => {
      counter.posts++;
      rows.push({ id: "9001", actor: 30, head, body });
    },
  };
}

test("Claude Broker identity is fixed: wrapper argv uses only --agent claude --purpose review", () => {
  const argv = claudeBrokerCommand(validateInstall(install(), "darwin"));
  assert.deepEqual(argv, [
    "/synthetic/trusted/bin/node",
    "/synthetic/trusted/copy/scripts/github-app-token.ts",
    "--agent",
    "claude",
    "--purpose",
    "review",
    "--app-id",
    "101",
    "--installation-id",
    "202",
    "--",
    "/synthetic/trusted/bin/node",
    "/synthetic/trusted/copy/scripts/review-dispatch-claude-broker.ts",
    "--repo",
    "synthetic/repository",
    "--gh",
    "/synthetic/trusted/bin/gh",
    "--actor",
    "30",
  ]);
  assert.equal(CLAUDE_AGENT, "claude");
  assert.equal(REVIEW_PURPOSE, "review");
  assert.equal(argv.filter((a) => a === "--agent").length, 1);
  assert.equal(argv.filter((a) => a === "--purpose").length, 1);
  // No Codex identity, key service or key-source override can appear.
  assert.ok(!argv.some((a) => /codex|keychain-service|key-file/i.test(a)));
  const env = claudeBrokerEnvironment(HOME);
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "NO_COLOR", "PATH"]);
  assert.equal(env["PATH"], "/usr/bin:/bin");
});

test("Claude Broker installation is owner-fixed, absolute and macOS-only", () => {
  for (const platform of ["win32", "linux"] as const)
    assert.throws(() => validateInstall(install(), platform), /macOS-only/);
  const bad: Partial<Record<keyof ClaudeBrokerInstall, unknown>>[] = [
    { node: "node" },
    { wrapper: "scripts/github-app-token.ts" },
    { wrapper: "/synthetic/other/scripts/github-app-token.ts" },
    { relay: "/synthetic/trusted/copy/scripts/other.ts" },
    { wrapper: "/synthetic/trusted/copy/scripts/../scripts/github-app-token.ts" },
    { gh: "gh" },
    { appId: "0x1" },
    { installationId: "" },
    { repo: "bad repo" },
    { actor: 0 },
  ];
  for (const change of bad)
    assert.throws(
      () =>
        validateInstall(
          { ...install(), ...change } as ClaudeBrokerInstall,
          "darwin",
        ),
      /Invalid Claude Broker installation/,
    );
  // No extra selector such as an agent or purpose field is accepted.
  for (const extra of [{ agent: "codex" }, { purpose: "implement" }])
    assert.throws(() =>
      validateInstall(
        { ...install(), ...extra } as ClaudeBrokerInstall,
        "darwin",
      ),
    );
  assert.throws(() => claudeBrokerEnvironment("relative"));
});

// A Store holding the vector job, a launch-registered RunVerifier and the supervisor-signed result.
function signedSetup(): {
  d: ReturnType<typeof database>;
  j: Job;
  raw: string;
  origin: ReturnType<typeof provenanceOf>["origin"];
  verifier: RunVerifier;
} {
  const d = database(),
    v = signedVector(),
    j = adoptVectorJob(d.store, claim(d.store));
  d.store.running(j);
  const verifier = new RunVerifier();
  verifier.register(
    j,
    parseRunKeyLine(
      JSON.stringify({ schema: 1, type: "run-key", run: j.run, binding: v.binding, key: v.key }),
    ),
  );
  const { raw, origin } = provenanceOf(
    j,
    parseSignedResult(
      JSON.stringify({
        schema: 1,
        type: "run-result",
        run: j.run,
        binding: v.binding,
        resultHash: v.resultHash,
        result: v.result,
        signature: v.signature,
      }),
    ),
  );
  d.store.result(j, raw);
  return { d, j, raw, origin, verifier };
}

test("Claude Broker refuses a policy actor that is not the Claude AI identity, and any sealing verifier", () => {
  const d = database();
  try {
    const verifier = new RunVerifier();
    const deps = { platform: "darwin" as const, home: HOME, spawn: fakeSpawn(github([], { posts: 0, lists: 0 }), []) };
    for (const actor of [20, 10, 99])
      assert.throws(
        () => createClaudeReviewBroker(policy(), { ...install(), actor }, d.store, verifier, deps),
        /identity mismatch/,
      );
    const p = policy();
    p.repo = "synthetic/other";
    assert.throws(() => createClaudeReviewBroker(p, install(), d.store, verifier, deps), /identity mismatch/);
    // The test-only RunChannel can seal; the real Broker refuses it even if the types are bypassed.
    assert.throws(
      () =>
        createClaudeReviewBroker(
          policy(),
          install(),
          d.store,
          new RunChannel(Buffer.alloc(32, 7)) as unknown as RunVerifier,
          deps,
        ),
      /requires the run verifier/,
    );
    assert.equal(createClaudeReviewBroker(policy(), install(), d.store, verifier, deps).actor, 30);
  } finally {
    d.cleanup();
  }
});

test("Claude Broker posts a supervisor-signed result once through one wrapper session per submit", async () => {
  const { d, j, raw, origin, verifier } = signedSetup();
  try {
    const p = policy(),
      s = snapshot(),
      rows: PostedReview[] = [{ id: "1", actor: 40, head: s.pair.head, body: "third party" }],
      counter = { posts: 0, lists: 0 },
      spawned: Spawned[] = [];
    const broker = createClaudeReviewBroker(p, install(), d.store, verifier, {
      platform: "darwin",
      home: HOME,
      spawn: fakeSpawn(github(rows, counter), spawned),
    });
    assert.equal(await broker.submit(p, j, raw, origin, async () => s), "posted");
    assert.equal(counter.posts, 1);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]!.command, "/synthetic/trusted/bin/node");
    assert.deepEqual(spawned[0]!.args.slice(1, 5), ["--agent", "claude", "--purpose", "review"]);
    assert.deepEqual(Object.keys(spawned[0]!.env).sort(), ["HOME", "LANG", "NO_COLOR", "PATH"]);
    const mine = rows.filter((r) => r.actor === 30);
    assert.equal(mine.length, 1);
    assert.match(mine[0]!.body, /role: claude-reviewer/);
    assert.match(mine[0]!.body, new RegExp(`agent_id: claude/${j.run}`));
    // A second submit opens a fresh session (closed after each submit) and recognises the existing post.
    assert.equal(await broker.submit(p, j, raw, origin, async () => s), "stale");
    assert.equal(counter.posts, 1);
    // A tampered result or signature never reaches GitHub.
    await assert.rejects(broker.submit(p, j, raw + " ", origin, async () => s), /Untrusted run provenance/);
    await assert.rejects(
      broker.submit(p, j, raw, { ...origin, signature: "0".repeat(origin.signature.length) }, async () => s),
      /Untrusted run provenance/,
    );
    assert.equal(counter.posts, 1);
  } finally {
    d.cleanup();
  }
});

test("Claude Broker never re-POSTs when the relay dies or stalls; it stays uncertain", async () => {
  for (const mode of ["post-fails", "silent"] as const) {
    const { d, j, raw, origin, verifier } = signedSetup();
    try {
      const p = policy(),
        s = snapshot(),
        counter = { posts: 0, lists: 0 },
        spawned: Spawned[] = [];
      const failing: BrokerTransport = {
        list: async () => {
          counter.lists++;
          return [];
        },
        post: async () => {
          counter.posts++;
          throw new Error("synthetic lost reply");
        },
      };
      const broker = createClaudeReviewBroker(p, install(), d.store, verifier, {
        platform: "darwin",
        home: HOME,
        spawn: fakeSpawn(failing, spawned, { silent: mode === "silent" }),
        timeoutMs: 50,
      });
      assert.equal(await broker.submit(p, j, raw, origin, async () => s), "uncertain");
      assert.equal(await broker.submit(p, j, raw, origin, async () => s), "uncertain");
      assert.equal(counter.posts, mode === "silent" ? 0 : 1);
      // One session per submit, each closed; the second only reconciles through the Outbox.
      assert.equal(spawned.length, 2);
    } finally {
      d.cleanup();
    }
  }
});

async function* from(lines: string[]): AsyncGenerator<string> {
  for (const l of lines) yield l;
}
async function run(lines: string[], transport: BrokerTransport): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await relay(from(lines), (l) => out.push(l), () => transport);
  return { code, out: out.map((l) => l.trim()) };
}

test("Claude relay allows only list/post, one POST per session, and hides failure details", async () => {
  const counter = { posts: 0, lists: 0 },
    rows: PostedReview[] = [];
  const post = (id: number) =>
    JSON.stringify({ id, op: "post", pr: 1, event: "COMMENT", head: "a".repeat(40), body: "x" });
  let r = await run([JSON.stringify({ id: 1, op: "list", pr: 1 }), post(2), post(3)], github(rows, counter));
  assert.equal(r.code, 2);
  assert.deepEqual(r.out.map((l) => JSON.parse(l).ok), [true, true, false]);
  assert.equal(counter.posts, 1);
  for (const bad of [
    "not json",
    JSON.stringify({ id: 1, op: "merge", pr: 1 }),
    JSON.stringify({ id: 1, op: "list", pr: 1, repo: "other/repo" }),
    JSON.stringify({ id: 1, op: "post", pr: 1, event: "DISMISS", head: "a".repeat(40), body: "x" }),
    JSON.stringify({ id: 1, op: "post", pr: 1, event: "COMMENT", head: "short", body: "x" }),
    JSON.stringify({ id: 1, op: "post", pr: 1, event: "COMMENT", head: "a".repeat(40), body: "x".repeat(32769) }),
    JSON.stringify({ id: 1, op: "list", pr: 1, pad: "x".repeat(140000) }),
  ]) {
    r = await run([bad], github([], counter));
    assert.equal(r.code, 2);
    assert.equal(r.out.length, 1);
    assert.equal(JSON.parse(r.out[0]!).ok, false);
  }
  r = await run(
    Array.from({ length: 17 }, (_, i) => JSON.stringify({ id: i + 1, op: "list", pr: 1 })),
    github([], counter),
  );
  assert.equal(r.code, 2);
  assert.equal(r.out.length, 17);
  // A GitHub failure becomes ok:false only; no gh output or token text crosses back.
  r = await run([post(1)], {
    list: async () => [],
    post: async () => {
      throw new Error(`gh said ${TOKEN}`);
    },
  });
  assert.deepEqual(r.out, [JSON.stringify({ id: 1, ok: false })]);
});

test("Claude relay entry takes the token only from the wrapper and fixed arguments", async () => {
  const made: unknown[][] = [];
  const make = (...a: unknown[]): BrokerTransport => {
    made.push(a);
    return github([], { posts: 0, lists: 0 });
  };
  const args = ["--repo", "synthetic/repository", "--gh", "/synthetic/trusted/bin/gh", "--actor", "30"];
  const env: Record<string, string | undefined> = { GH_TOKEN: TOKEN };
  const out: string[] = [];
  assert.equal(
    await relayMain(args, env, from([JSON.stringify({ id: 1, op: "list", pr: 1 })]), (l) => out.push(l), make),
    0,
  );
  assert.deepEqual(made, [[TOKEN, "/synthetic/trusted/bin/gh", "synthetic/repository", 30]]);
  assert.equal(env["GH_TOKEN"], undefined);
  assert.ok(!out.join("").includes(TOKEN));
  for (const [badArgs, badEnv] of [
    [args, {}],
    [args, { GH_TOKEN: "ghp_" + "x".repeat(36) }],
    [args, { GH_TOKEN: "not a token" }],
    [["--repo", "synthetic/repository", "--gh", "gh", "--actor", "30"], { GH_TOKEN: TOKEN }],
    [["--repo", "synthetic/repository", "--gh", "/synthetic/gh", "--actor", "0"], { GH_TOKEN: TOKEN }],
    [[...args, "--agent", "codex"], { GH_TOKEN: TOKEN }],
  ] as const) {
    made.length = 0;
    assert.equal(
      await relayMain(badArgs, { ...badEnv }, from([JSON.stringify({ id: 1, op: "list", pr: 1 })]), () => {}, make),
      2,
    );
    assert.equal(made.length, 0);
  }
});

test("Claude Broker transport rejects malformed relay responses", async () => {
  const spawnBad = (line: string): SpawnRelay => () => {
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      events = new EventEmitter();
    stdin.once("data", () => stdout.write(line));
    return {
      stdin,
      stdout,
      once: (event, listener) => events.once(event, listener),
      kill: () => events.emit("exit", null),
    };
  };
  for (const line of [
    `${JSON.stringify({ id: 1, ok: true, reviews: [{ id: "1", actor: 30, head: "short", body: "" }] })}\n`,
    `${JSON.stringify({ id: 1, ok: true, reviews: "x" })}\n`,
    `${JSON.stringify({ id: 2, ok: true, reviews: [] })}\n`,
    "garbage\n",
  ]) {
    const t = new ClaudeAppTransport(install(), {
      platform: "darwin",
      home: HOME,
      spawn: spawnBad(line),
      timeoutMs: 100,
    });
    await assert.rejects(t.list(1));
    await t.close();
  }
  const t = new ClaudeAppTransport(install(), { platform: "darwin", home: HOME, spawn: spawnBad("") });
  await assert.rejects(t.post(1, "COMMENT", "short", "x"), /Invalid review/);
  await t.close();
});

test("Claude relay posts through the native review API and refuses a review created by another identity", async () => {
  if (process.platform === "win32") {
    // The dispatcher and this Broker are macOS-only; on Windows nothing can be constructed, so gh is never run.
    assert.throws(() => validateInstall(install(), process.platform), /macOS-only/);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "claude-relay-"));
  try {
    const gh = join(dir, "gh"),
      log = join(dir, "log.json");
    // Fake gh: records argv/env/stdin, answers the review list (with --include headers) or the POST.
    writeFileSync(
      gh,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const input = args.includes("--input") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input, env: Object.keys(process.env).sort(), token: process.env.GH_TOKEN === ${JSON.stringify(TOKEN)} }) + "\\n");
const actor = Number(fs.readFileSync(${JSON.stringify(join(dir, "actor"))}, "utf8"));
if (args.includes("POST")) {
  const body = JSON.parse(input);
  process.stdout.write(JSON.stringify({ id: 77, user: { id: actor }, commit_id: body.commit_id, body: body.body }));
} else {
  process.stdout.write("HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify([{ id: 77, user: { id: actor }, commit_id: "${"a".repeat(40)}", body: "b" }]));
}
`,
    );
    chmodSync(gh, 0o700);
    const args = ["--repo", "synthetic/repository", "--gh", gh, "--actor", "30"];
    const request = [
      JSON.stringify({ id: 1, op: "post", pr: 1, event: "APPROVE", head: "a".repeat(40), body: "synthetic" }),
      JSON.stringify({ id: 2, op: "list", pr: 1 }),
    ];
    process.env["KL_SYNTHETIC_SECRET"] = "must-not-reach-gh";
    try {
      writeFileSync(join(dir, "actor"), "30");
      let out: string[] = [];
      assert.equal(
        await relayMain(args, { GH_TOKEN: TOKEN }, from(request), (l) => out.push(l), ghReviewTransport),
        0,
      );
      assert.deepEqual(JSON.parse(out[0]!), { id: 1, ok: true });
      assert.deepEqual(JSON.parse(out[1]!).reviews, [{ id: "77", actor: 30, head: "a".repeat(40), body: "b" }]);
      const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(calls[0].args.slice(0, 6), ["api", "--hostname", "github.com", "/repos/synthetic/repository/pulls/1/reviews", "--method", "POST"]);
      assert.deepEqual(JSON.parse(calls[0].input), { event: "APPROVE", commit_id: "a".repeat(40), body: "synthetic" });
      for (const c of calls) {
        assert.equal(c.token, true);
        assert.deepEqual(
          c.env.filter((k: string) => !k.startsWith("__CF")),
          ["GH_CONFIG_DIR", "GH_PAGER", "GH_TOKEN", "HOME", "NO_COLOR", "PATH"],
        );
      }
      // GitHub reports a review by another App (e.g. the Codex bot): the relay reports failure only.
      writeFileSync(join(dir, "actor"), "20");
      out = [];
      assert.equal(
        await relayMain(args, { GH_TOKEN: TOKEN }, from([request[0]!]), (l) => out.push(l), ghReviewTransport),
        2,
      );
      assert.deepEqual(out.map((l) => JSON.parse(l)), [{ id: 1, ok: false }]);
    } finally {
      delete process.env["KL_SYNTHETIC_SECRET"];
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Synthetic secrets, assembled at runtime so this source file never contains a secret-shaped literal.
const join2 = (...parts: string[]): string => parts.join("");
const SYNTHETIC_LEAKS: readonly string[] = [
  join2("AK", "IA", "SYNTHETIC0000000"), // AWS access key shape
  join2("sk-", "ant-", "synthetic", "x".repeat(20)),
  join2("gh", "s_", "Synthetic.Stateless_", "x".repeat(20)),
  join2("github", "_pat_", "x".repeat(30)),
  join2("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJzeW50aGV0aWMifQ", ".sig"),
  join2("Bear", "er ", "Zm9vYmFyYmF6cXV4cXV1eA0123"),
  join2("api", "_key = ", "synthetic-value-1"),
  join2("pass", "word: ", "hunter2-synthetic"),
  join2("-----BEGIN ", "OPENSSH ", "PRIVATE KEY-----"),
  join2("Zm9vYmFyYmF6cXV4cXV1eA", "0123456789abcdef"), // opaque 38-char run
  join2("/ho", "me/alice/.config/gh/hosts.yml"),
  join2("/pri", "vate/var/folders/xy/synthetic/T/key.pem"),
  join2("/et", "c/passwd"),
  join2("~", "/.ssh/id_ed25519"),
  join2("D", ":\\work\\secrets.txt"),
  join2("fi", "le:///tmp/x"),
  join2("someone", "@", "private-mail.jp"),
];

const VJOB: Job = {
  id: "00000000-0000-4000-8000-0000000000a1",
  key: "1:1",
  generation: 1,
  actor: 30,
  kind: "review",
  run: "00000000-0000-4000-8000-000000000001",
  pair: { head: "a".repeat(40), base: "b".repeat(40) },
  policy: "p1",
};
const NONE = allowedFor(VJOB, []);
// Evasions from the PR #53 red team (P2-2), assembled at runtime.
const hexSecret = "0123456789abcdef".repeat(5); // 80 hex chars = two SHA-shaped chunks
const EVASIONS: readonly string[] = [
  join2("gh", "s\u200b_", "x".repeat(36)), // zero-width inside a token
  join2("ｇｈｓ＿", "ｘ".repeat(36)), // full-width token (NFKC)
  join2("gh", "s_ ", "x".repeat(18), " ", "x".repeat(18)), // split across words
  `${hexSecret.slice(0, 40)} ${hexSecret.slice(40)}`, // SHA-sized chunks not belonging to the job
  join2("QUJDREVGR0hJSktMTU5PUFFS", "/U1RVVldYWVo0NTY3ODk="), // base64 with "/"
  "%41%4B%49%41%53%59%4E", // percent-encoded
  join2("https://", "evil.example/collect?d=1"), // non-GitHub link
  join2("![x](https://", "img.example/p.png)"),
  join2("https://github.com/doc-gif/kurashi-ledger/pull/1?q=", "Zm9vYmFyYmF6cXV4cXV1eA0123456789"), // secret in a GitHub query
];

test("publication check flags every synthetic leak and red-team evasion (mitigation, not a guarantee)", () => {
  for (const leak of [...SYNTHETIC_LEAKS, ...EVASIONS])
    assert.notDeepEqual(publicationFindings(`前置き ${leak} 後置き`, NONE), [], leak);
  assert.ok(publicationFindings("a\u200bb", NONE).includes("format character"));
  // A normal v1 review body: the job's own SHAs/run, its GitHub evidence links and a commit link in evidence.
  const evidence = [
    "https://github.com/doc-gif/kurashi-ledger/actions/runs/37169377459",
    "https://github.com/doc-gif/kurashi-ledger/pull/48#pullrequestreview-5403767115",
    `https://github.com/doc-gif/kurashi-ledger/commit/${"1c".repeat(20)}`,
  ];
  const body = render(
    {
      schema: 1,
      run: VJOB.run,
      actor: 30,
      generation: 1,
      pair: VJOB.pair,
      decision: "changes-requested",
      summary: `境界の検査が不足しています。${"1c".repeat(20)} を確認。`,
      findings: [{ id: "PR51-R001", location: "scripts/lib/review-dispatch/broker.ts render()", impact: "誤投稿", completion: "試験を足す" }],
      evidence,
      unverified: ["実Macの測定"],
    },
    `kurashi-ledger:dispatch-run:v1:${VJOB.run}`,
    { role: "claude-reviewer", agent: "claude" },
    VJOB.run,
  );
  assert.deepEqual(publicationFindings(body, allowedFor(VJOB, evidence)), []);
  // A SHA is allowed only through this job's evidence/pair, and a run ID only for this job's run.
  assert.notDeepEqual(publicationFindings(body, allowedFor(VJOB, evidence.slice(0, 2))), []);
  const otherRun = "abcdef01-2345-4678-9abc-def012345678";
  assert.notDeepEqual(publicationFindings(`${body}\nagent: ${otherRun}`, allowedFor(VJOB, evidence)), []);
});

test("parseResult rejects format characters, full-width look-alikes and non-GitHub links in prose", () => {
  const r = fixtureResult(VJOB);
  for (const summary of [
    "a\u200bb",
    "連絡は＠someone へ",
    "ｄｅｃｉｓｉｏｎ： accepted",
    "see https://evil.example/x",
    "see www.example.com",
    "see ｈｔｔｐｓ：／／evil.example",
  ])
    assert.throws(() => parseResult(JSON.stringify({ ...r, summary }), VJOB), summary);
  assert.throws(() => parseResult(JSON.stringify({ ...r, unverified: ["x\u2060y"] }), VJOB));
  assert.deepEqual(
    parseResult(JSON.stringify({ ...r, summary: "詳細は https://github.com/doc-gif/kurashi-ledger/pull/1 を参照" }), VJOB).summary,
    "詳細は https://github.com/doc-gif/kurashi-ledger/pull/1 を参照",
  );
});

// The generic Broker (shared by every identity) checks the final body; the fixture verifier stands in for the
// supervisor because these bodies are new text the vector cannot cover.
test("Broker blocks a body that leaks a secret or local path: no POST, one owner notice", async () => {
  let reached = 0;
  for (const leak of SYNTHETIC_LEAKS) {
    const d = database();
    try {
      const p = policy(),
        s = snapshot(),
        j = claim(d.store);
      d.store.running(j);
      const base = fixtureResult(j);
      let raw = "";
      for (const v of [{ ...base, summary: `読んだ値: ${leak}` }, { ...base, unverified: [`確認: ${leak}`] }]) {
        try {
          const candidate = JSON.stringify(v);
          parseResult(candidate, j);
          raw = candidate;
          break;
        } catch {
          // parseResult already refused this shape; try the next field.
        }
      }
      if (!raw) continue; // Refused earlier by the strict schema; also never posted.
      reached++;
      d.store.result(j, raw);
      const counter = { posts: 0, lists: 0 },
        channel = new RunChannel(Buffer.alloc(32, 7)),
        broker = new ReviewBroker(30, github([], counter), d.store, channel);
      assert.equal(await broker.submit(p, j, raw, channel.seal(j, raw), async () => s), "blocked", leak);
      assert.equal(await broker.submit(p, j, raw, channel.seal(j, raw), async () => s), "blocked", leak);
      assert.equal(counter.posts + counter.lists, 0);
      assert.equal(d.store.notice(`${j.key}:publication-blocked:${j.run}`), false);
    } finally {
      d.cleanup();
    }
  }
  assert.ok(reached >= SYNTHETIC_LEAKS.length - 4, String(reached));
});

test("dispatcher checks before storing: a leaking result keeps only its hash, blocks, and holds the lease", async () => {
  const d = database();
  try {
    const p = policy(),
      s = snapshot(),
      engine = new Dispatcher(p, d.store),
      endpoint = new RunChannel(Buffer.alloc(32, 7)),
      counter = { posts: 0, lists: 0 },
      broker = new ReviewBroker(30, github([], counter), d.store, endpoint);
    const capability = {
      backend: "fixture" as const,
      version: "fixture",
      codeHash: "a".repeat(64),
      profileHash: "b".repeat(64),
      probes: Object.fromEntries(
        ["deny-network", "deny-gh-auth", "deny-other-ai-auth", "deny-keys", "deny-db", "deny-policy-write", "schema", "descendant-lock"].map((k) => [k, true]),
      ),
    };
    const leak = SYNTHETIC_LEAKS[0]!;
    let raw = "";
    assert.equal(
      await engine.fixtureCycle(
        s,
        30,
        {
          capability,
          run: async (j) => {
            raw = JSON.stringify({ ...fixtureResult(j), summary: `値 ${leak}` });
            return { result: raw, treeEnded: true, uncertain: false, origin: endpoint.seal(j, raw) };
          },
        },
        broker,
        async () => s,
        100,
      ),
      "blocked",
    );
    const stored = d.store.db.prepare("SELECT result, status FROM jobs").all() as { result: string; status: string }[];
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.status, "uncertain");
    assert.ok(!stored[0]!.result.includes(leak));
    assert.deepEqual(JSON.parse(stored[0]!.result), { redacted: "publication-check", resultHash: createHash("sha256").update(raw).digest("hex") });
    assert.equal(
      await engine.fixtureCycle(s, 30, { capability, run: async () => assert.fail("relaunch") }, broker, async () => s, 101),
      "waiting",
    );
    assert.equal(counter.posts, 0);
  } finally {
    d.cleanup();
  }
});
