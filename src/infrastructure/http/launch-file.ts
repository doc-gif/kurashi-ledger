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
  readlinkSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { checkOwnerOnly, checkWalkNotReplaceable, ownerOnlyDirectoryHint, restrictOpenFileToOwner, type WalkEntry } from './owner-only.ts';

// 確かめたディレクトリ。実体パスと、確かめたときの経路の各要素（末端からルートまで）のdev・ino。
// verifyTokenDirectoryが返して凍結したものだけが有効（同じ形のオブジェクトを作っても受け付けない。isVerifiedDirectory）。
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

const verifiedDirectories = new WeakSet<object>();

// verifyTokenDirectoryが返したものか。chainが空のもの、chainの最初がpathでないものも拒否する。
export function isVerifiedDirectory(value: unknown): value is VerifiedDirectory {
  if (typeof value !== 'object' || value === null || !verifiedDirectories.has(value)) return false;
  const directory = value as VerifiedDirectory;
  return directory.chain.length > 0 && directory.chain[0]?.path === directory.path;
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
  if (!isVerifiedDirectory(directory)) throw new TokenDirectoryError('一時ファイルを置くディレクトリが、verifyTokenDirectoryで確かめたものでない。');
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
export type VerifyOptions = {
  // この中（実体パスの包含、または経路の要素がそのディレクトリそのもの）を指すものを拒否する（npm startはrepo）。
  readonly forbiddenRoots?: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  // 試験で、検証の途中に経路を差し替えるためだけに使う。
  readonly onStep?: (step: 'walked' | 'checked') => void;
};

export function verifyTokenDirectory(directory: string, options: VerifyOptions = {}): VerifiedDirectory {
  const path = resolve(directory);
  // 1. 指定したパスを、realpathを使わずにルートから1要素ずつたどる（途中のリンクを、その親とともに確かめるため）。
  const first = walkPath(path);
  // 最終的に使う実体パスと、たどった要素で、拒否する場所の中かを確かめる（表記の別名に頼らない）。
  for (const forbidden of options.forbiddenRoots ?? []) {
    const root = lstatSync(forbidden.path, { bigint: true });
    const inside =
      first.entries.some((e) => e.kind === 'dir' && e.dev === root.dev && e.ino === root.ino) ||
      isInsidePath(first.real, forbidden.path);
    if (inside) throw new TokenDirectoryError(forbidden.message);
  }
  options.onStep?.('walked');
  // 2. 名前を引いた各ディレクトリと、たどったリンクを、ほかの一般のユーザーが差し替えられないこと。
  const route = checkWalkNotReplaceable(first.entries, first.real);
  if (!route.ok) {
    throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリ ${path} の経路を、ほかのユーザーが差し替えられる: ${route.reason} 本人とrootだけが書き込める場所の中のディレクトリを指定する。`);
  }
  // 3. たどった結果の末端（実体パス）が、本人だけの権限であること。
  const check = checkOwnerOnly(first.real, 'directory');
  if (!check.ok) {
    throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリ ${path} が本人だけの権限でない: ${check.reason} ${ownerOnlyDirectoryHint(path)}`);
  }
  options.onStep?.('checked');
  // 4. もう一度たどり直し、たどった各要素（種類・dev・ino）が同じであること（検証の途中の差し替えを拒否する）。
  const second = walkPath(path);
  if (second.real !== first.real || !sameWalk(first.entries, second.entries)) {
    throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリ ${path} の経路が、確かめている間に変わった（何も作らない）。`);
  }
  const verified: VerifiedDirectory = Object.freeze({
    path: first.real,
    chain: Object.freeze(
      chainOf(first.real).map((element) => {
        const entry = second.entries.find((e) => e.kind === 'dir' && e.path === element);
        if (entry === undefined) throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリの経路 ${element} を確かめていない。`);
        return Object.freeze({ path: element, dev: entry.dev, ino: entry.ino });
      }),
    ),
  });
  verifiedDirectories.add(verified);
  return verified;
}

function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

const MAX_LINKS = 40;

// 指定したパスをルートから1要素ずつたどる。POSIXではリンクをたどり（readlinkの結果を、その位置から続ける）、
// Windowsではリンク（symlink・junction）を拒否する。指定したパスの最後の要素がリンクなら拒否する（従来どおり）。
function walkPath(path: string): { readonly real: string; readonly entries: WalkEntry[] } {
  const root = parse(path).root;
  const entries: WalkEntry[] = [];
  const statOf = (p: string) => {
    try {
      return lstatSync(p, { bigint: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリ ${path} がない（作らない）。`);
      throw error;
    }
  };
  const rootStat = statOf(root);
  entries.push({ path: root, kind: 'dir', parent: undefined, dev: rootStat.dev, ino: rootStat.ino, uid: Number(rootStat.uid), mode: Number(rootStat.mode) });
  const split = (p: string): string[] => p.split(/[\\/]+/).filter((c) => c !== '');
  const given = split(path.slice(root.length));
  let queue: Array<{ readonly name: string; readonly lastGiven: boolean }> = given.map((name, i) => ({ name, lastGiven: i === given.length - 1 }));
  let current = root;
  let links = 0;
  while (queue.length > 0) {
    const [item, ...rest] = queue;
    queue = rest;
    if (item === undefined || item.name === '.') continue;
    if (item.name === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, item.name);
    const st = statOf(next);
    const entry = { path: next, parent: current, dev: st.dev, ino: st.ino, uid: Number(st.uid), mode: Number(st.mode) };
    if (st.isSymbolicLink()) {
      if (item.lastGiven) throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリ ${path} がリンク（symlink・junction）になっている。`);
      if (process.platform === 'win32') throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリ ${path} の経路にリンク（${next}）がある。Windowsでは、リンクを含まない経路を指定する。`);
      links += 1;
      if (links > MAX_LINKS) throw new TokenDirectoryError(`トークンの一時ファイルを置くディレクトリ ${path} の経路のリンクが多すぎる。`);
      entries.push({ ...entry, kind: 'link' });
      const target = readlinkSync(next);
      if (isAbsolute(target)) current = parse(target).root;
      queue = [...split(isAbsolute(target) ? target.slice(parse(target).root.length) : target).map((name) => ({ name, lastGiven: false })), ...queue];
      continue;
    }
    if (!st.isDirectory()) throw new TokenDirectoryError(`トークンの一時ファイルを置く場所 ${path} の経路の ${next} がディレクトリでない。`);
    entries.push({ ...entry, kind: 'dir' });
    current = next;
  }
  return { real: current, entries };
}

function sameWalk(a: readonly WalkEntry[], b: readonly WalkEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => {
    const o = b[i];
    return o !== undefined && o.path === e.path && o.kind === e.kind && o.dev === e.dev && o.ino === e.ino;
  });
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
