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
import { dirname, join, resolve } from 'node:path';
import { checkOwnerOnly, checkPathNotReplaceable, ownerOnlyDirectoryHint, restrictOpenFileToOwner } from './owner-only.ts';

// 確かめたディレクトリ。実体パスと、確かめたときの経路の各要素（末端からルートまで）のdev・ino。
export type VerifiedDirectory = {
  readonly path: string;
  readonly chain: ReadonlyArray<{ readonly path: string; readonly dev: bigint; readonly ino: bigint }>;
};

export type LaunchFile = {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly directory: VerifiedDirectory;
};

export class TokenDirectoryError extends Error {}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function chainOf(path: string): string[] {
  const chain = [path];
  for (let parent = dirname(path); parent !== chain.at(-1); parent = dirname(parent)) chain.push(parent);
  return chain;
}

// 確かめたときと同じ経路か（どの要素もリンクでないディレクトリで、devとinoが同じ）。同じでなければ例外にする。
// 作成・権限変更・削除の直前に呼ぶ（ほかのユーザーには差し替えられないことを確かめてあるので、これは同じユーザーの
// 差し替えに対する追加の防御）。
export function confirmDirectoryUnchanged(directory: VerifiedDirectory): void {
  for (const element of directory.chain) {
    let st;
    try {
      st = lstatSync(element.path, { bigint: true });
    } catch {
      throw new TokenDirectoryError(`一時ファイルを置くディレクトリの経路 ${element.path} が、確かめたあとで変わった（なくなった）。`);
    }
    if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== element.dev || st.ino !== element.ino) {
      throw new TokenDirectoryError(`一時ファイルを置くディレクトリの経路 ${element.path} が、確かめたあとで差し替わった。`);
    }
  }
}

// 渡されたディレクトリを確かめる。ないとき・リンクのとき・ディレクトリでないとき・権限が広いとき・経路のどこかを
// ほかのユーザーが差し替えられるときは、作らず・変えずに例外にする（既定の場所へ切り替えない）。
export function verifyTokenDirectory(directory: string): VerifiedDirectory {
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
  const real = realpathSync.native(path);
  const chain = chainOf(real);
  const route = checkPathNotReplaceable(chain);
  if (!route.ok) {
    throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリ ${path} の経路を、ほかのユーザーが差し替えられる: ${route.reason} 本人とrootだけが書き込める場所の中のディレクトリを指定する。`);
  }
  return {
    path: real,
    chain: chain.map((element) => {
      const st = lstatSync(element, { bigint: true });
      return { path: element, dev: st.dev, ino: st.ino };
    }),
  };
}

export function randomLaunchFileName(): string {
  return `launch-${randomBytes(12).toString('hex')}.html`;
}

// directoryは、verifyTokenDirectoryで確かめたもの。nameは区切り文字を含まない名前。onStepは、試験で各段階の間に
// 経路を差し替えるためだけに使う。
export function createLaunchFile(
  directory: VerifiedDirectory,
  name: string,
  content: string,
  onStep?: (step: 'opened' | 'restricted') => void,
): LaunchFile {
  if (name === '' || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error(`一時ファイルの名前 ${name} が不正。`);
  confirmDirectoryUnchanged(directory);
  const path = join(directory.path, name);
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
    created = { path, dev: opened.dev, ino: opened.ino, directory };
    onStep?.('opened');
    // 各操作を開いたハンドルに結び付ける（ADR-0009の3）。権限の変更は、POSIXではハンドルにfchmodするだけで、
    // パスでは変えない。Windowsはハンドルに設定できないので、パスで設定する直前に、経路とファイル自身が開いた
    // ものと同じであることを確かめ、違えば変更せずに止める。
    confirmDirectoryUnchanged(directory);
    confirmSameFile(path, opened.dev, opened.ino);
    restrictOpenFileToOwner(fd, path);
    onStep?.('restricted');
    // 権限を変えたあとで、経路とファイルが同じで、本人だけの権限であることを、読むだけの操作で確かめる。
    confirmDirectoryUnchanged(directory);
    confirmSameFile(path, opened.dev, opened.ino);
    const check = checkOwnerOnly(path, 'file');
    if (!check.ok) throw new Error(`一時ファイル ${path} を本人だけの権限にできなかった: ${check.reason}`);
    confirmSameFile(path, opened.dev, opened.ino);
    // 確認に通ってから、開いたハンドルにだけトークンを書く。
    const data = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    if (created !== undefined) {
      try {
        removeLaunchFile(created);
      } catch {
        // 後始末に失敗しても、最初の失敗を伝える（作ったファイルは、経路が同じときだけ消す）。
      }
    }
    throw error;
  }
  closeSync(fd);
  return created;
}

// パスのファイルが、開いたファイル（dev・ino）と同じ通常のファイルであること。違えば例外にする。
function confirmSameFile(path: string, dev: bigint, ino: bigint): void {
  let now;
  try {
    now = lstatSync(path, { bigint: true });
  } catch {
    throw new Error(`一時ファイル ${path} が、作ったあとでなくなった。`);
  }
  if (now.isSymbolicLink() || !now.isFile() || now.dev !== dev || now.ino !== ino) {
    throw new Error(`一時ファイル ${path} が、作ったファイルと違うものに置き換わった（変更していない）。`);
  }
}

export type RemoveResult = 'removed' | 'missing' | 'replaced';

// 確かめたときと同じ経路の、作ったときと同じ通常のファイルだけを消す。経路やファイルが置き換わっていれば、
// 消さずに'replaced'を返す。消せなければ例外にする
// （握りつぶさない。呼び出し側が、残ったことを利用者に伝える）。unlinkは、試験で削除の失敗を注入するための引数。
export function removeLaunchFile(file: LaunchFile, unlink: (path: string) => void = unlinkSync): RemoveResult {
  // 経路が確かめたときと違えば、差し替え先のファイルを消さない。
  try {
    confirmDirectoryUnchanged(file.directory);
  } catch {
    return 'replaced';
  }
  let st;
  try {
    st = lstatSync(file.path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.dev !== file.dev || st.ino !== file.ino) return 'replaced';
  try {
    unlink(file.path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  return 'removed';
}
