// 起動用の一時ファイルと、渡されたディレクトリの確認（ADR-0003の4、ADR-0009）。
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ownerOnlyTempDirectory } from '../../../tests/support/http.ts';
import { TokenDirectoryError, createLaunchFile, removeLaunchFile, verifyTokenDirectory } from './launch-file.ts';
import { checkOwnerOnly } from './owner-only.ts';

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

    // 同じ名前の別のファイルに置き換わっていたら消さない。
    const again = createLaunchFile(dir, 'launch-replaced.html', 'first');
    unlinkSync(again.path);
    writeFileSync(again.path, 'someone else');
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
    writeFileSync(join(dir, 'existing.html'), 'original');
    assert.throws(() => createLaunchFile(dir, 'existing.html', 'token'), /すでにファイルかリンクがある/);
    assert.equal(readFileSync(join(dir, 'existing.html'), 'utf8'), 'original');

    const target = join(outside.path, 'target.html');
    writeFileSync(target, 'outside');
    const kind = linkToFile(t, target, join(dir, 'link.html'));
    assert.throws(() => createLaunchFile(dir, 'link.html', 'token'), /すでにファイルかリンクがある/);
    assert.equal(readFileSync(target, 'utf8'), 'outside');

    if (kind === 'file-symlink') {
      const dangling = join(outside.path, 'not-created.html');
      symlinkSync(dangling, join(dir, 'dangling.html'), 'file');
      assert.throws(() => createLaunchFile(dir, 'dangling.html', 'token'), /すでにファイルかリンクがある/);
      assert.equal(existsSync(dangling), false);
    }
    assert.throws(() => createLaunchFile(dir, '../escape.html', 'token'), /名前/);
  } finally {
    tmp.cleanup();
    outside.cleanup();
  }
});
