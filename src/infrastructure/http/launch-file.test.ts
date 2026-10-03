// 起動用の一時ファイルと、渡されたディレクトリの確認（ADR-0003の4、ADR-0009）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ownerOnlyTempDirectory } from '../../../tests/support/http.ts';
import { TokenDirectoryError, createLaunchFile, removeLaunchFile, verifyTokenDirectory } from './launch-file.ts';
import { checkOwnerOnly, restrictToOwner } from './owner-only.ts';

// ファイルを指すsymlinkを作る。Windowsで権限（開発者モード・管理者）がなく作れないときは、ディレクトリの
// junctionで代わりに確かめ、その旨を試験の出力（diagnostic）に残す（docs/development.mdの「弱めて確かめる箇所」）。
function linkToFile(t: TestContext, target: string, path: string): 'file-symlink' | 'junction' {
  try {
    symlinkSync(target, path, 'file');
    return 'file-symlink';
  } catch (error) {
    if (process.platform !== 'win32' || (error as { code?: string }).code !== 'EPERM') throw error;
    const dir = `${target}.dir`;
    mkdirSync(dir, { recursive: true });
    symlinkSync(dir, path, 'junction');
    t.diagnostic('Windowsでファイルのsymlinkを作る権限がないため、一時ファイルの名前のリンクはjunctionで確かめた');
    return 'junction';
  }
}

test('渡されたディレクトリが、ない・ファイル・リンク・権限が広いときは、作らず変えずに拒否する', () => {
  const tmp = ownerOnlyTempDirectory('tokdir');
  try {
    const missing = join(tmp.path, 'missing');
    assert.throws(() => verifyTokenDirectory(missing), TokenDirectoryError);
    assert.equal(existsSync(missing), false);

    const file = join(tmp.path, 'file');
    writeFileSync(file, 'synthetic');
    assert.throws(() => verifyTokenDirectory(file), TokenDirectoryError);

    const link = join(tmp.path, 'link');
    symlinkSync(tmp.path, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => verifyTokenDirectory(link), /リンク/);

    const broad = join(tmp.path, 'broad');
    mkdirSync(broad, { mode: 0o755 });
    if (process.platform === 'win32') {
      // 継承したACL（実行中のユーザー以外を含む）のままのディレクトリ。
      const inherited = join(process.env['TEMP'] ?? tmp.path, `kl-inherited-${process.pid}`);
      mkdirSync(inherited, { recursive: true });
      try {
        assert.throws(() => verifyTokenDirectory(inherited), /本人だけの権限でない/);
      } finally {
        rmSync(inherited, { recursive: true, force: true });
      }
    } else {
      assert.throws(() => verifyTokenDirectory(broad), /本人だけの権限でない/);
    }
    assert.deepEqual(readdirSync(broad), []);
  } finally {
    tmp.cleanup();
  }
});

test('起動用の一時ファイルは本人だけの権限で作り、トークンを書き、作ったものだけを消す', () => {
  const tmp = ownerOnlyTempDirectory('launchfile');
  try {
    const dir = verifyTokenDirectory(tmp.path);
    const file = createLaunchFile(dir, 'launch-synthetic.html', '<p>synthetic-token</p>');
    assert.equal(readFileSync(file.path, 'utf8'), '<p>synthetic-token</p>');
    assert.deepEqual(checkOwnerOnly(file.path, 'file'), { ok: true });
    if (process.platform !== 'win32') assert.equal(lstatSync(file.path).mode & 0o777, 0o600);
    assert.equal(removeLaunchFile(file), 'removed');
    assert.equal(existsSync(file.path), false);
    assert.equal(removeLaunchFile(file), 'missing');

    // 同じ名前の別のファイルに置き換わっていたら消さない（別のファイルを先に作ってから名前を変えて重ねるので、
    // inodeの番号は再利用されない）。
    const again = createLaunchFile(dir, 'launch-replaced.html', 'first');
    writeFileSync(join(dir.path, 'other.html'), 'someone else');
    renameSync(join(dir.path, 'other.html'), again.path);
    assert.equal(removeLaunchFile(again), 'replaced');
    assert.equal(readFileSync(again.path, 'utf8'), 'someone else');
  } finally {
    tmp.cleanup();
  }
});

test('一時ファイルの名前に既存のファイル・リンク・壊れたリンクがあれば作成が失敗し、リンク先を変えない', (t) => {
  const tmp = ownerOnlyTempDirectory('launchexcl');
  const outside = ownerOnlyTempDirectory('launchoutside');
  try {
    const dir = verifyTokenDirectory(tmp.path);
    writeFileSync(join(dir.path, 'existing.html'), 'original');
    assert.throws(() => createLaunchFile(dir, 'existing.html', 'token'), /すでにファイルかリンクがある/);
    assert.equal(readFileSync(join(dir.path, 'existing.html'), 'utf8'), 'original');

    const target = join(outside.path, 'target.html');
    writeFileSync(target, 'outside');
    const kind = linkToFile(t, target, join(dir.path, 'link.html'));
    assert.throws(() => createLaunchFile(dir, 'link.html', 'token'), /すでにファイルかリンクがある/);
    assert.equal(readFileSync(target, 'utf8'), 'outside');

    if (kind === 'file-symlink') {
      const dangling = join(outside.path, 'not-created.html');
      symlinkSync(dangling, join(dir.path, 'dangling.html'), 'file');
      assert.throws(() => createLaunchFile(dir, 'dangling.html', 'token'), /すでにファイルかリンクがある/);
      assert.equal(existsSync(dangling), false);
    }
    assert.throws(() => createLaunchFile(dir, '../escape.html', 'token'), /名前/);
  } finally {
    tmp.cleanup();
    outside.cleanup();
  }
});

test('一時ファイルを消せないときは、例外にして（握りつぶさず）ファイルを残す', () => {
  const tmp = ownerOnlyTempDirectory('launchfail');
  try {
    const dir = verifyTokenDirectory(tmp.path);
    const file = createLaunchFile(dir, 'launch-fail.html', 'synthetic-token');
    const failing = (): void => {
      throw Object.assign(new Error('synthetic unlink failure'), { code: 'EACCES' });
    };
    assert.throws(() => removeLaunchFile(file, failing), /synthetic unlink failure/);
    assert.equal(readFileSync(file.path, 'utf8'), 'synthetic-token');
    assert.equal(removeLaunchFile(file), 'removed');
  } finally {
    tmp.cleanup();
  }
});

function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

function grantOthers(path: string, rights: string): void {
  const icacls = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const r = spawnSync(icacls, [path, '/grant', `*S-1-1-0:${rights}`], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}

test('経路の祖先を、ほかのユーザーが差し替えられる（stickyなしで書ける・子の削除を許す）ときは拒否し、stickyのある共有の場所の自分のディレクトリは許す', () => {
  const tmp = ownerOnlyTempDirectory('route');
  try {
    const shared = join(tmp.path, 'shared');
    const tok = join(shared, 'tok');
    mkdirSync(tok, { recursive: true });
    restrictToOwner(tok, 'directory');
    assert.equal(verifyTokenDirectory(tok).path.endsWith('tok'), true);
    if (process.platform === 'win32') {
      grantOthers(shared, '(DC)');
      assert.throws(() => verifyTokenDirectory(tok), /差し替えられる/);
    } else {
      for (const mode of [0o777, 0o770, 0o757]) {
        chmodSync(shared, mode);
        assert.throws(() => verifyTokenDirectory(tok), /差し替えられる/, mode.toString(8));
      }
      chmodSync(shared, 0o1777);
      assert.equal(verifyTokenDirectory(tok).path.endsWith('tok'), true);
      chmodSync(shared, 0o700);
    }
    assert.deepEqual(readdirSync(tok), []);
  } finally {
    tmp.cleanup();
  }
});

test('確かめたあとで末端や深い祖先が差し替わると、作成・権限変更・削除は何もせずに止まり、差し替え先を書かず変えず消さない', () => {
  const tmp = ownerOnlyTempDirectory('swap');
  const outside = ownerOnlyTempDirectory('swap-outside');
  try {
    const tok = join(tmp.path, 'a', 'b', 'tok');
    mkdirSync(tok, { recursive: true });
    restrictToOwner(tok, 'directory');
    mkdirSync(join(outside.path, 'b', 'tok'), { recursive: true });
    mkdirSync(join(outside.path, 'tok'));
    writeFileSync(join(outside.path, 'tok', 'launch-x.html'), 'outside', { mode: 0o644 });
    writeFileSync(join(outside.path, 'tok', 'launch-y.html'), 'outside-y', { mode: 0o644 });
    const outsideMode = lstatSync(join(outside.path, 'tok', 'launch-x.html')).mode;

    // 1. 深い祖先（a）を差し替える。
    let verified = verifyTokenDirectory(tok);
    renameSync(join(tmp.path, 'a'), join(tmp.path, 'a-moved'));
    linkDirectory(outside.path, join(tmp.path, 'a'));
    assert.throws(() => createLaunchFile(verified, 'launch-1.html', 'token'), /差し替わった|変わった/);
    assert.deepEqual(readdirSync(join(outside.path, 'b', 'tok')), []);
    rmSync(join(tmp.path, 'a'));
    renameSync(join(tmp.path, 'a-moved'), join(tmp.path, 'a'));

    // 2. 末端を差し替える。
    verified = verifyTokenDirectory(tok);
    renameSync(tok, `${tok}-moved`);
    linkDirectory(join(outside.path, 'tok'), tok);
    assert.throws(() => createLaunchFile(verified, 'launch-x.html', 'token'), /差し替わった|変わった/);
    rmSync(tok);
    renameSync(`${tok}-moved`, tok);

    // 3. 作成と権限変更の間に末端を差し替える（パスで権限を変える前に止まる）。
    verified = verifyTokenDirectory(tok);
    assert.throws(
      () =>
        createLaunchFile(verified, 'launch-x.html', 'token', (step) => {
          if (step !== 'opened') return;
          renameSync(tok, `${tok}-moved`);
          linkDirectory(join(outside.path, 'tok'), tok);
        }),
      /差し替わった|変わった/,
    );
    rmSync(tok);
    renameSync(`${tok}-moved`, tok);
    // 作ったファイルは、経路が変わったので消さずに、元のディレクトリに残っている（ほかの場所は消さない）。
    assert.deepEqual(readdirSync(tok), ['launch-x.html']);

    // 4. 作成と削除の間に末端を差し替える（差し替え先の同じ名前のファイルを消さない）。
    verified = verifyTokenDirectory(tok);
    const file = createLaunchFile(verified, 'launch-y.html', 'token');
    renameSync(tok, `${tok}-moved`);
    linkDirectory(join(outside.path, 'tok'), tok);
    assert.equal(removeLaunchFile(file), 'replaced');

    // 差し替え先は、書かれず、権限も変わらず、消されていない。
    assert.equal(readFileSync(join(outside.path, 'tok', 'launch-x.html'), 'utf8'), 'outside');
    assert.equal(lstatSync(join(outside.path, 'tok', 'launch-x.html')).mode, outsideMode);
    assert.equal(readFileSync(join(outside.path, 'tok', 'launch-y.html'), 'utf8'), 'outside-y');
    assert.deepEqual(readdirSync(join(outside.path, 'tok')).sort(), ['launch-x.html', 'launch-y.html']);
    assert.deepEqual(readdirSync(join(outside.path, 'b', 'tok')), []);
  } finally {
    tmp.cleanup();
    outside.cleanup();
  }
});
