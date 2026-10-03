// トークンを渡す一時ファイル（ADR-0003の4、ADR-0009の「起動用の一時ファイル」）。
// - 外から渡された本人専用のディレクトリ（T09からはデータルートのtmp/）だけを扱い、ほかの場所に書かない。
//   ディレクトリは、リンクでないこと・本人だけの権限であることを確かめてから、実体パスを固定して使う。
// - ファイルは、既存のファイルやリンクがあれば失敗する排他的な作成で作り、本人だけの権限にして確かめてから、
//   作ったファイルと同じもの（devとino）であることを確かめて、トークンを書く。
// - 消すときは、作ったときと同じ通常のファイルであることを確かめてから、unlinkだけで消す（再帰しない）。
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { checkOwnerOnly, ownerOnlyDirectoryHint, restrictToOwner } from './owner-only.ts';

export type LaunchFile = {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
};

export class TokenDirectoryError extends Error {}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

// 渡されたディレクトリを確かめ、実体パスを返す。ないとき・リンクのとき・ディレクトリでないとき・権限が広いときは、
// 作らず・変えずに例外にする（既定の場所へ切り替えない）。
export function verifyTokenDirectory(directory: string): string {
  const path = resolve(directory);
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリ ${path} がない（作らない）。`);
    throw error;
  }
  if (st.isSymbolicLink()) throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリ ${path} がリンク（symlink・junction）になっている。`);
  if (!st.isDirectory()) throw new TokenDirectoryError(`トークンの一時ファイルを置く場所 ${path} がディレクトリでない。`);
  const check = checkOwnerOnly(path, 'directory');
  if (!check.ok) {
    throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリ ${path} が本人だけの権限でない: ${check.reason} ${ownerOnlyDirectoryHint(path)}`);
  }
  return realpathSync.native(path);
}

export function randomLaunchFileName(): string {
  return `launch-${randomBytes(12).toString('hex')}.html`;
}

// directoryは、verifyTokenDirectoryで確かめた実体パス。nameは区切り文字を含まない名前。
export function createLaunchFile(directory: string, name: string, content: string): LaunchFile {
  if (name === '' || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error(`一時ファイルの名前 ${name} が不正。`);
  const path = join(directory, name);
  // 既存のファイル・リンク（壊れたリンクを含む）があれば作らない。O_EXCLもリンクをたどらずに失敗するが、
  // Windowsでもリンクをたどってほかのファイルを作らないよう、先にlstatで確かめる。
  let exists = true;
  try {
    lstatSync(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    exists = false;
  }
  if (exists) throw new Error(`一時ファイル ${path} の名前に、すでにファイルかリンクがある（作らない）。`);

  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, 0o600);
  let created: LaunchFile | undefined;
  try {
    const opened = fstatSync(fd, { bigint: true });
    created = { path, dev: opened.dev, ino: opened.ino };
    restrictToOwner(path, 'file');
    const now = lstatSync(path, { bigint: true });
    if (now.isSymbolicLink() || !now.isFile() || now.dev !== opened.dev || now.ino !== opened.ino) {
      throw new Error(`一時ファイル ${path} が、作ったファイルと違うものに置き換わった。`);
    }
    // 権限を確かめてから、トークンを書く。
    const data = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    if (created !== undefined) removeLaunchFile(created);
    throw error;
  }
  closeSync(fd);
  return created;
}

export type RemoveResult = 'removed' | 'missing' | 'replaced';

// 作ったときと同じ通常のファイルだけを消す。置き換わっていれば消さずに'replaced'を返す。
export function removeLaunchFile(file: LaunchFile): RemoveResult {
  let st;
  try {
    st = lstatSync(file.path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.dev !== file.dev || st.ino !== file.ino) return 'replaced';
  try {
    unlinkSync(file.path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  return 'removed';
}
