import assert from "node:assert/strict";
import { test } from "node:test";
import { main, HELP } from "./review-dispatch.ts";
test("default command is off without reading policy/database/auth or spawning", async () => {
  const out: string[] = [];
  assert.equal(await main([], {}, (s) => out.push(s)), 0);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /off/);
  assert.match(HELP, /本導入/);
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
    // A policy inside this repository/worktree (or the trusted copy) is refused before use.
    await assert.rejects(main(["init", "--root", d.root, "--policy", resolve("package.json")], env, () => {}));
    fs.chmodSync(file, 0o620);
    await assert.rejects(main(["shadow", "--root", d.root, "--policy", file], env, () => {}, () => T0));
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
    await assert.rejects(main(["shadow", "--root", d.root, "--policy", file], env, () => {}, () => T0 + 2));
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
    d.cleanup();
  }
});
