// 本人だけの権限の判定と設定（ADR-0003の4、ADR-0009）。POSIXはモード、WindowsはACL（SDDL）で確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownerOnlyTempDirectory } from '../../../tests/support/http.ts';
import {
  checkOwnerOnly,
  evaluateMacAcl,
  evaluateMacAncestorAcl,
  evaluatePosixChain,
  evaluateWindowsChain,
  evaluateWindowsSddl,
  restrictToOwner,
} from './owner-only.ts';
import { readdirSync } from 'node:fs';
import { verifyTokenDirectory } from './launch-file.ts';

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

test('macOSのls -ledの判定: 実行中のユーザー以外へのallowの拡張ACL・読めない行を拒否し、denyとACLなしは許す', () => {
  const head = (mode: string) => `${mode}  2 alice  staff  64 Oct  3 17:36 /synthetic/dir\n`;
  assert.deepEqual(evaluateMacAcl(head('drwx------'), 'alice'), { ok: true });
  assert.deepEqual(evaluateMacAcl(`${head('drwx------+')} 0: group:everyone deny delete\n`, 'alice'), { ok: true });
  assert.deepEqual(evaluateMacAcl(`${head('-rw-------+')} 0: user:alice allow read,write\n`, 'alice'), { ok: true });
  for (const output of [
    `${head('drwx------+')} 0: group:everyone deny delete\n 1: user:nobody allow list,search,file_inherit,directory_inherit\n`,
    `${head('-rw-------+')} 0: user:nobody inherited allow read,execute\n`,
    `${head('-rw-------+')} 0: group:staff allow read\n`,
    `${head('-rw-------+')} 0: ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000001 allow read\n`,
    `${head('-rw-------+')} 0: something unexpected\n`,
    `${head('-rw-------')} 0: user:nobody allow read\n`,
    'unexpected output\n',
  ]) {
    assert.equal(evaluateMacAcl(output, 'alice').ok, false, output);
  }
});

function run(command: string, args: readonly string[]): string {
  const r = spawnSync(command, [...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(r.status, 0, `${command} ${args.join(' ')}: ${r.stderr ?? ''}`);
  return r.stdout ?? '';
}

test('モード700でも、ほかのユーザーを許可する拡張ACL（macOSのACL・LinuxのPOSIX ACL・WindowsのACE）があれば本人だけでないとし、渡されたディレクトリは変えず、作るファイルは本人だけにする', (t) => {
  const tmp = ownerOnlyTempDirectory('acl');
  try {
    const shared = join(tmp.path, 'shared');
    mkdirSync(shared, { mode: 0o700 });
    const file = join(tmp.path, 'file.txt');
    writeFileSync(file, 'synthetic', { mode: 0o600 });
    if (process.platform === 'darwin') {
      // 別のユーザーに一覧・読取りを許可し、新しいファイルにも継承させるACL。モードは700のまま。
      run('/bin/chmod', ['+a', 'user:nobody allow list,search,read,file_inherit,directory_inherit', shared]);
      run('/bin/chmod', ['+a', 'user:nobody allow read', file]);
      assert.equal(lstatSync(shared).mode & 0o777, 0o700);
    } else if (process.platform === 'linux') {
      // 名前付きのユーザーへのエントリを足すと、ACLのmask（モードのグループのbit）が広がる。
      run('setfacl', ['-m', 'u:nobody:rx', shared]);
      run('setfacl', ['-m', 'u:nobody:r', file]);
      t.diagnostic(`setfaclのあとのモード: ${(lstatSync(shared).mode & 0o777).toString(8)}`);
    } else {
      const icacls = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');
      run(icacls, [shared, '/grant', '*S-1-1-0:(OI)(CI)(R)']);
      run(icacls, [file, '/grant', '*S-1-1-0:(R)']);
    }
    assert.equal(checkOwnerOnly(shared, 'directory').ok, false);
    assert.throws(() => verifyTokenDirectory(shared), /本人だけの権限でない/);
    assert.deepEqual(readdirSync(shared), []);
    // 渡されたディレクトリのACLは変えない（拒否したまま）。
    assert.equal(checkOwnerOnly(shared, 'directory').ok, false);
    if (process.platform === 'darwin') assert.match(run('/bin/ls', ['-led', '--', shared]), /user:nobody allow/);

    // 自分で作ったファイルは、ACLを含めて本人だけにする。
    assert.equal(checkOwnerOnly(file, 'file').ok, false);
    restrictToOwner(file, 'file');
    assert.deepEqual(checkOwnerOnly(file, 'file'), { ok: true });
    if (process.platform === 'darwin') assert.doesNotMatch(run('/bin/ls', ['-led', '--', file]).split('\n')[0] ?? '', /\+$|\+ /);
    if (process.platform === 'linux') {
      // POSIX ACLのエントリが残っても、maskが空なので本人以外には効かない。
      assert.match(run('getfacl', ['-p', file]), /mask::---/);
    }
  } finally {
    tmp.cleanup();
  }
});

test('経路の判定（POSIX）: 所有者がroot・本人以外、またはstickyなしでほかのユーザーも書ける祖先があれば拒否する', () => {
  const uid = 1000;
  const entry = (path: string, owner: number, mode: number) => ({ path, uid: owner, mode });
  const ok = [entry('/home/shared/tok', uid, 0o40700), entry('/home/shared', uid, 0o40755), entry('/home', 0, 0o40755), entry('/', 0, 0o40755)];
  assert.deepEqual(evaluatePosixChain(ok, uid), { ok: true });
  // stickyのある共有のディレクトリ（/tmp等）の中の、自分のディレクトリは許す。
  assert.deepEqual(evaluatePosixChain([entry('/tmp/tok', uid, 0o40700), entry('/tmp', 0, 0o41777), entry('/', 0, 0o40755)], uid), { ok: true });
  for (const chain of [
    [entry('/tmp/tok', uid, 0o40700), entry('/tmp', 0, 0o40777), entry('/', 0, 0o40755)],
    [entry('/srv/tok', uid, 0o40700), entry('/srv', 0, 0o40775), entry('/', 0, 0o40755)],
    [entry('/tmp/x/tok', uid, 0o40700), entry('/tmp/x', 2000, 0o41777), entry('/tmp', 0, 0o41777), entry('/', 0, 0o40755)],
    [entry('/tmp/x/tok', uid, 0o40700), entry('/tmp/x', 2000, 0o40755), entry('/tmp', 0, 0o41777), entry('/', 0, 0o40755)],
    [entry('/home/shared/tok', uid, 0o40700), entry('/home/shared', 2000, 0o40755), entry('/', 0, 0o40755)],
  ]) {
    assert.equal(evaluatePosixChain(chain, uid).ok, false, JSON.stringify(chain));
  }
});

test('経路の判定（Windows・macOSのACL）: ほかのユーザーに削除・子の削除・権限の変更を許すエントリを拒否し、読取りと継承専用は許す', () => {
  const paths = ['C:\\Users\\Shared\\tok', 'C:\\Users\\Shared', 'C:\\'];
  const sys = 'S-1-5-18';
  const tok = `O:${USER}D:(A;0;2032127;;;${USER})`;
  const home = `O:${sys}D:(A;3;2032127;;;${USER})(A;3;2032127;;;${sys})(A;3;2032127;;;S-1-5-32-544)`;
  // C:\ の既定に近い形: Authenticated Usersに継承専用の変更と、フォルダーの作成（AppendData）だけ。
  const root = `O:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464D:(A;3;2032127;;;${sys})(A;11;-536805376;;;S-1-5-11)(A;0;4;;;S-1-5-11)(A;3;1179817;;;S-1-5-32-545)`;
  assert.deepEqual(evaluateWindowsChain([tok, home, root], paths, USER), { ok: true });
  const deleteChild = `${home}(A;0;64;;;${OTHER})`;
  const deleteSelf = `${home}(A;0;65536;;;${OTHER})`;
  const writeDac = `${root}(A;0;262144;;;S-1-1-0)`;
  const genericAll = `${home}(A;0;268435456;;;S-1-5-32-545)`;
  const otherOwner = `O:${OTHER}D:(A;3;2032127;;;${USER})`;
  for (const [sddls, label] of [
    [[tok, deleteChild, root], '親の子の削除'],
    [[tok, deleteSelf, root], '祖先の削除'],
    [[tok, home, writeDac], 'DACLの変更'],
    [[tok, genericAll, root], 'GENERIC_ALL'],
    [[tok, otherOwner, root], 'ほかの所有者'],
    [[tok, `O:${sys}D:NO_ACCESS_CONTROL`, root], 'NULLのDACL'],
  ] as const) {
    assert.equal(evaluateWindowsChain(sddls, paths, USER).ok, false, label);
  }
  // 末端の子の削除（FILE_DELETE_CHILD）は、末端の中の名前なので、末端（本人だけ）の判定に任せる。
  assert.deepEqual(evaluateWindowsChain([`O:${USER}D:(A;0;64;;;${USER})`, home, root], paths, USER), { ok: true });

  const head = (mode: string) => `${mode}  5 root  admin  160 Oct  3 17:36 /synthetic\n`;
  assert.deepEqual(evaluateMacAncestorAcl(`${head('drwxr-xr-x+')} 0: group:everyone deny delete\n 1: group:staff allow list,search\n`, 'alice'), { ok: true });
  for (const perm of ['delete', 'delete_child', 'add_subdirectory', 'add_file', 'writesecurity', 'chown']) {
    assert.equal(evaluateMacAncestorAcl(`${head('drwxr-xr-x+')} 0: user:nobody allow list,${perm}\n`, 'alice').ok, false, perm);
  }
});
