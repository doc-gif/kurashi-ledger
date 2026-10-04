import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostCheckError,
  MAX_POLICY_BYTES,
  checkAncestors,
  checkDispatchRoot,
  checkLockFile,
  currentUid,
  readOwnerPolicy,
} from "./host.ts";

// Synthetic temporary directories only. Wrong owners are simulated by passing another uid.
function scratch(): { dir: string; code: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-host-")));
  const code = join(dir, "trusted-copy");
  mkdirSync(code, { mode: 0o700 });
  return { dir, code, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const file = (path: string, mode: number, body = '{"synthetic":true}') => {
  writeFileSync(path, body);
  chmodSync(path, mode);
  return path;
};

if (process.platform === "win32")
  test("R010 Windows host checks are disabled, not skipped (dispatcher is Mac-only)", () => {
    assert.throws(() => currentUid(), HostCheckError);
    assert.throws(() => readOwnerPolicy("C:\\policy.json", "C:\\code"), HostCheckError);
  });
else {
  test("R010 owner-only policy outside repo/worktree is read from the checked descriptor", () => {
    const s = scratch();
    try {
      const uid = currentUid();
      const ok = file(join(s.dir, "policy.json"), 0o644);
      assert.equal(readOwnerPolicy(ok, s.code), '{"synthetic":true}');
      assert.equal(readOwnerPolicy(file(join(s.dir, "private.json"), 0o600), s.code, uid), '{"synthetic":true}');
      // Group/other writable, another owner, hard link, symlink and non-canonical spellings are refused.
      assert.throws(() => readOwnerPolicy(file(join(s.dir, "g.json"), 0o664), s.code), HostCheckError);
      assert.throws(() => readOwnerPolicy(file(join(s.dir, "o.json"), 0o646), s.code), HostCheckError);
      assert.throws(() => readOwnerPolicy(ok, s.code, uid + 1), HostCheckError);
      const linked = file(join(s.dir, "linked.json"), 0o600);
      linkSync(linked, join(s.dir, "second-name.json"));
      assert.throws(() => readOwnerPolicy(linked, s.code), HostCheckError);
      symlinkSync(ok, join(s.dir, "alias.json"));
      assert.throws(() => readOwnerPolicy(join(s.dir, "alias.json"), s.code));
      assert.throws(() => readOwnerPolicy(s.code + "/../policy.json", s.code), HostCheckError);
      assert.throws(() => readOwnerPolicy("policy.json", s.code), HostCheckError);
      assert.throws(() => readOwnerPolicy(join(s.dir, "missing.json"), s.code));
      // Oversized policy.
      assert.throws(
        () => readOwnerPolicy(file(join(s.dir, "big.json"), 0o600, "x".repeat(MAX_POLICY_BYTES + 1)), s.code),
        HostCheckError,
      );
    } finally {
      s.cleanup();
    }
  });
  test("R010 policy inside a git repo/worktree or the trusted code copy is refused", () => {
    const s = scratch();
    try {
      const repo = join(s.dir, "repo");
      mkdirSync(join(repo, "nested"), { recursive: true, mode: 0o700 });
      mkdirSync(join(repo, ".git"));
      assert.throws(() => readOwnerPolicy(file(join(repo, "nested", "policy.json"), 0o600), s.code), HostCheckError);
      const worktree = join(s.dir, "worktree");
      mkdirSync(worktree, { mode: 0o700 });
      file(join(worktree, ".git"), 0o600, "gitdir: synthetic\n");
      assert.throws(() => readOwnerPolicy(file(join(worktree, "policy.json"), 0o600), s.code), HostCheckError);
      assert.throws(() => readOwnerPolicy(file(join(s.code, "policy.json"), 0o600), s.code), HostCheckError);
      // A sibling whose name only starts with ".." is still outside the code copy.
      const sibling = join(s.dir, "..sibling");
      mkdirSync(sibling, { mode: 0o700 });
      assert.equal(readOwnerPolicy(file(join(sibling, "policy.json"), 0o600), s.code), '{"synthetic":true}');
    } finally {
      s.cleanup();
    }
  });
  test("R010 ancestors writable by others must be sticky; another owner's ancestor is refused", () => {
    const s = scratch();
    try {
      const uid = currentUid();
      const open = join(s.dir, "open");
      mkdirSync(open);
      chmodSync(open, 0o777);
      const policy = file(join(open, "policy.json"), 0o600);
      assert.throws(() => readOwnerPolicy(policy, s.code), HostCheckError);
      chmodSync(open, 0o1777);
      assert.equal(readOwnerPolicy(policy, s.code), '{"synthetic":true}');
      chmodSync(open, 0o700);
      assert.doesNotThrow(() => checkAncestors(policy, uid));
      assert.throws(() => checkAncestors(policy, uid + 1), HostCheckError);
    } finally {
      s.cleanup();
    }
  });
  test("R010 dispatcher root, database, journals and lifetime lock: owner and private modes", () => {
    const s = scratch();
    try {
      const root = join(s.dir, "root");
      mkdirSync(root, { mode: 0o700 });
      chmodSync(root, 0o700);
      assert.doesNotThrow(() => checkDispatchRoot(root));
      chmodSync(root, 0o750);
      assert.throws(() => checkDispatchRoot(root), HostCheckError);
      chmodSync(root, 0o700);
      assert.throws(() => checkDispatchRoot(root, currentUid() + 1), HostCheckError);
      for (const name of ["dispatch.sqlite", "dispatch.sqlite-wal", "dispatch.sqlite-shm"]) {
        const path = file(join(root, name), 0o600, "");
        assert.doesNotThrow(() => checkDispatchRoot(root));
        chmodSync(path, 0o640);
        assert.throws(() => checkDispatchRoot(root), HostCheckError);
        rmSync(path);
        symlinkSync(join(s.dir, "elsewhere"), path);
        assert.throws(() => checkDispatchRoot(root));
        rmSync(path);
      }
      const lock = file(join(s.dir, ".kurashi-dispatch-synthetic.lock"), 0o600, "");
      assert.doesNotThrow(() => checkLockFile(lock));
      chmodSync(lock, 0o644);
      assert.throws(() => checkLockFile(lock), HostCheckError);
      chmodSync(lock, 0o600);
      assert.throws(() => checkLockFile(lock, currentUid() + 1), HostCheckError);
      linkSync(lock, join(s.dir, "lock-alias"));
      assert.throws(() => checkLockFile(lock), HostCheckError);
    } finally {
      s.cleanup();
    }
  });
}
