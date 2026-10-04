import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Host checks for the Mac-only dispatcher (PR48-R010/I008). They stop mistakes and mix-ups by the
// same OS user's tools; they are not a boundary against a malicious process of that user (O3).
export class HostCheckError extends Error {
  constructor() {
    super("Dispatcher host check failed; fix ownership/permissions before starting");
  }
}
export const MAX_POLICY_BYTES = 1024 * 1024;

export function currentUid(): number {
  if (process.platform === "win32" || typeof process.getuid !== "function")
    throw new HostCheckError(); // The dispatcher runs on macOS only.
  return process.getuid();
}
const fail = (ok: boolean): void => {
  if (!ok) throw new HostCheckError();
};
const privateMode = (st: Stats): boolean => (st.mode & 0o077) === 0;
const ownerWritableOnly = (st: Stats): boolean => (st.mode & 0o022) === 0;

// Every ancestor must be a real directory owned by the user or by root. A directory others can write
// to must be sticky (like /tmp), so another user cannot rename or replace our entries in it.
export function checkAncestors(path: string, uid: number): void {
  for (let p = dirname(path); ; p = dirname(p)) {
    const st = lstatSync(p);
    fail(
      st.isDirectory() &&
        !st.isSymbolicLink() &&
        (st.uid === uid || st.uid === 0) &&
        (ownerWritableOnly(st) || (st.mode & 0o1000) !== 0),
    );
    if (dirname(p) === p) break;
  }
}
// A private regular file: one link, owned by the user, no group/other permission bits.
export function checkPrivateFile(path: string, uid: number): void {
  const st = lstatSync(path);
  fail(
    st.isFile() &&
      !st.isSymbolicLink() &&
      st.nlink === 1 &&
      st.uid === uid &&
      privateMode(st),
  );
}
// Root, database and both SQLite journals. Missing journals are fine; wrong ones are refused, not fixed.
export function checkDispatchRoot(root: string, uid = currentUid()): void {
  const st = lstatSync(root);
  fail(
    st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && privateMode(st),
  );
  checkAncestors(root, uid);
  const file = join(root, "dispatch.sqlite");
  for (const path of [file, file + "-wal", file + "-shm"])
    if (present(path)) checkPrivateFile(path, uid);
}
// lstat-based: a dangling symlink is present (existsSync would follow it and report absent).
export function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
// The lifetime lock lives next to the root (supervisor.py). Someone else's file is not our lock.
export function checkLockFile(path: string, uid = currentUid()): void {
  checkPrivateFile(path, uid);
  checkAncestors(path, uid);
}
const inside = (path: string, dir: string): boolean => {
  const r = relative(dir, path);
  return !(r === ".." || r.startsWith(".." + sep) || isAbsolute(r));
};
// Policy: outside any repo/worktree and the trusted code copy, writable only by the owner, read from
// the same descriptor that was checked (no symlink swap between check and read).
export function readOwnerPolicy(
  path: string,
  codeRoot: string,
  uid = currentUid(),
): string {
  fail(isAbsolute(path) && resolve(path) === path);
  fail(realpathSync(path) === path);
  fail(!inside(path, realpathSync(codeRoot)));
  for (let p = dirname(path); ; p = dirname(p)) {
    fail(!present(join(p, ".git")));
    if (dirname(p) === p) break;
  }
  checkAncestors(path, uid);
  const st = lstatSync(path);
  fail(
    st.isFile() &&
      !st.isSymbolicLink() &&
      st.nlink === 1 &&
      st.uid === uid &&
      ownerWritableOnly(st) &&
      st.size <= MAX_POLICY_BYTES,
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    fail(
      opened.dev === st.dev &&
        opened.ino === st.ino &&
        opened.uid === uid &&
        ownerWritableOnly(opened) &&
        opened.nlink === 1 &&
        opened.size <= MAX_POLICY_BYTES,
    );
    const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1);
    let size = 0;
    for (;;) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (n === 0) break;
      size += n;
      fail(size <= MAX_POLICY_BYTES);
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
