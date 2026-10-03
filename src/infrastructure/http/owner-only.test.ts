// 本人だけの権限の判定と設定（ADR-0003の4、ADR-0009）。POSIXはモード、WindowsはACL（SDDL）で確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownerOnlyTempDirectory } from '../../../tests/support/http.ts';
import { checkOwnerOnly, evaluateWindowsSddl, restrictToOwner } from './owner-only.ts';

const USER = 'S-1-5-21-1000000001-1000000002-1000000003-1001';
const OTHER = 'S-1-5-21-1000000001-1000000002-1000000003-1002';

test('SDDLの判定: 所有者と許可が実行中のユーザーだけなら本人だけとする', () => {
  assert.deepEqual(evaluateWindowsSddl(`O:${USER}D:PAI(A;;FA;;;${USER})`, USER), { ok: true });
  assert.deepEqual(evaluateWindowsSddl(`O:${USER}D:PAI(A;OICI;FA;;;${USER})`, USER), { ok: true });
  // 拒否のエントリは権限を広げないので許す。
  assert.deepEqual(evaluateWindowsSddl(`O:${USER}D:P(D;;FA;;;WD)(A;;FA;;;${USER})`, USER), { ok: true });
});

test('SDDLの判定: ほかのSID・別名・継承専用・所有者の違い・NULLのDACL・未知の種類を拒否する', () => {
  const cases = [
    `O:${USER}D:PAI(A;;FA;;;${USER})(A;;FR;;;${OTHER})`,
    `O:${USER}D:PAI(A;;FA;;;${USER})(A;;FA;;;SY)`,
    `O:${USER}D:PAI(A;;FA;;;${USER})(A;;FA;;;BA)`,
    `O:${USER}D:AI(A;;FA;;;${USER})(A;OICIIO;GA;;;CO)`,
    `O:${USER}D:PAI(A;;FA;;;${USER})(A;OICIIO;FR;;;WD)`,
    `O:BAD:PAI(A;;FA;;;${USER})`,
    `O:${OTHER}D:PAI(A;;FA;;;${USER})`,
    `O:${USER}D:NO_ACCESS_CONTROL`,
    `O:${USER}D:PAI(XA;;FA;;;${USER})`,
    `O:${USER}D:PAI(OA;;FA;;;${USER})`,
    `D:PAI(A;;FA;;;${USER})`,
  ];
  for (const sddl of cases) assert.equal(evaluateWindowsSddl(sddl, USER).ok, false, sddl);
});

// 権限を広げる（POSIXはグループとほかのユーザーに読取りを許可、Windowsは Everyone に読取りを許可するACE）。
function broaden(path: string): void {
  if (process.platform === 'win32') {
    const icacls = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');
    const r = spawnSync(icacls, [path, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
  } else {
    chmodSync(path, lstatSync(path).isDirectory() ? 0o755 : 0o644);
  }
}

test('本人だけにしたディレクトリとファイルは本人だけと判定し、権限を広げると拒否する', () => {
  const tmp = ownerOnlyTempDirectory('owner');
  try {
    assert.deepEqual(checkOwnerOnly(tmp.path, 'directory'), { ok: true });
    const dir = join(tmp.path, 'dir');
    mkdirSync(dir);
    restrictToOwner(dir, 'directory');
    assert.deepEqual(checkOwnerOnly(dir, 'directory'), { ok: true });
    const file = join(tmp.path, 'file.txt');
    writeFileSync(file, 'synthetic');
    restrictToOwner(file, 'file');
    assert.deepEqual(checkOwnerOnly(file, 'file'), { ok: true });
    if (process.platform !== 'win32') {
      assert.equal(lstatSync(file).mode & 0o777, 0o600);
      assert.equal(lstatSync(dir).mode & 0o777, 0o700);
    }
    // 種類が違えば拒否する。
    assert.equal(checkOwnerOnly(file, 'directory').ok, false);
    assert.equal(checkOwnerOnly(dir, 'file').ok, false);
    broaden(dir);
    broaden(file);
    assert.equal(checkOwnerOnly(dir, 'directory').ok, false);
    assert.equal(checkOwnerOnly(file, 'file').ok, false);
  } finally {
    tmp.cleanup();
  }
});

test('リンク（symlink・junction）は、たどらずに本人だけでないと判定し、権限を変えない', () => {
  const tmp = ownerOnlyTempDirectory('owner-link');
  try {
    const target = join(tmp.path, 'target');
    mkdirSync(target);
    restrictToOwner(target, 'directory');
    const link = join(tmp.path, 'link');
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const check = checkOwnerOnly(link, 'directory');
    assert.equal(check.ok, false);
    assert.throws(() => restrictToOwner(link, 'directory'), /リンク/);
    assert.deepEqual(checkOwnerOnly(target, 'directory'), { ok: true });
  } finally {
    tmp.cleanup();
  }
});
