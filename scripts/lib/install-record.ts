// 依存の導入の記録（ADR-0002「依存の導入とリリースの対応」、ADR-0008）。
// 依存のないNode.jsのモジュールとして、`npm run setup`・`npm run build`と、
// 後続のT09（start:real）・T12（:realの保守コマンド）から使う。
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const RECORD_FORMAT = 1;
export const RECORD_FILE_NAME = '.kurashi-ledger-install.json';
export const SETUP_GUIDANCE =
  '対処: `npm run setup` を実行して依存を導入し直す（WindowsのPowerShellでは `npm.cmd run setup`）。`npm ci` や `npm install` を直接実行しても記録は書かれない。';

export type Runtime = {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
};

export type InstallRecord = {
  readonly format: number;
  readonly lockfileSha256: string;
  readonly installedTreeSha256: string | null;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
};

export type Verification =
  | { readonly ok: true; readonly record: InstallRecord }
  | { readonly ok: false; readonly problems: readonly string[] };

export type NpmCiResult = {
  readonly status: number | null;
  readonly signal: string | null;
  readonly error?: Error | undefined;
};

export type SetupDependencies = {
  readonly root: string;
  readonly runtime: Runtime;
  readonly runNpmCi: () => NpmCiResult;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  // 試験で、ディレクトリの反映の失敗を起こすために差し替える。
  readonly syncDirectory?: ((dir: string) => void) | undefined;
};

export function currentRuntime(): Runtime {
  return { node: process.version, platform: process.platform, arch: process.arch };
}

export function nodeModulesPath(root: string): string {
  return join(root, 'node_modules');
}

export function recordPath(root: string): string {
  return join(nodeModulesPath(root), RECORD_FILE_NAME);
}

export function lockfilePath(root: string): string {
  return join(root, 'package-lock.json');
}

// npmが導入の最後に書く node_modules/.package-lock.json（hidden lockfile）。
export function installedTreePath(root: string): string {
  return join(nodeModulesPath(root), '.package-lock.json');
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256OfFileIfPresent(path: string): string | null {
  try {
    return sha256OfFile(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

// いまのlockfile・node_modules・実行環境に対する記録の内容を求める。
export function observeInstall(root: string, runtime: Runtime): InstallRecord {
  return {
    format: RECORD_FORMAT,
    lockfileSha256: sha256OfFile(lockfilePath(root)),
    installedTreeSha256: sha256OfFileIfPresent(installedTreePath(root)),
    node: runtime.node,
    platform: runtime.platform,
    arch: runtime.arch,
  };
}

function isRecord(value: unknown): value is InstallRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const isHex = (x: unknown): boolean => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
  return (
    v['format'] === RECORD_FORMAT &&
    isHex(v['lockfileSha256']) &&
    (v['installedTreeSha256'] === null || isHex(v['installedTreeSha256'])) &&
    typeof v['node'] === 'string' &&
    typeof v['platform'] === 'string' &&
    typeof v['arch'] === 'string'
  );
}

// 記録といまの状態の違いを、利用者が直せる言葉で返す。比べ方はADR-0008。
export function compareRecord(recorded: InstallRecord, actual: InstallRecord): string[] {
  const problems: string[] = [];
  if (recorded.lockfileSha256 !== actual.lockfileSha256) {
    problems.push(
      'package-lock.json が記録と違う（branchやタグを切り替えたあと、依存を導入し直していない等）。',
    );
  }
  if (recorded.installedTreeSha256 !== actual.installedTreeSha256) {
    problems.push('node_modules の中身が記録のあとで変わった（`npm install` 等を実行した）。');
  }
  if (recorded.node !== actual.node) {
    problems.push(`Node.jsの版が記録と違う（記録: ${recorded.node}、いま: ${actual.node}）。`);
  }
  if (recorded.platform !== actual.platform || recorded.arch !== actual.arch) {
    problems.push(
      `OS・CPUが記録と違う（記録: ${recorded.platform}/${recorded.arch}、いま: ${actual.platform}/${actual.arch}）。`,
    );
  }
  return problems;
}

export function verifyInstallRecord(root: string, runtime: Runtime = currentRuntime()): Verification {
  let text: string;
  try {
    text = readFileSync(recordPath(root), 'utf8');
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return {
        ok: false,
        problems: [
          '依存の導入の記録がない（`npm run setup` を実行していない、`npm ci` を直接実行した、または導入が途中で止まった）。',
        ],
      };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['依存の導入の記録を読めない（壊れている）。'] };
  }
  if (!isRecord(parsed)) {
    return { ok: false, problems: ['依存の導入の記録の形式が、このリリースの形式と違う。'] };
  }
  let actual: InstallRecord;
  try {
    actual = observeInstall(root, runtime);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { ok: false, problems: ['package-lock.json がない。'] };
    }
    throw error;
  }
  const problems = compareRecord(parsed, actual);
  return problems.length === 0 ? { ok: true, record: parsed } : { ok: false, problems };
}

export function formatVerificationFailure(problems: readonly string[]): string {
  return [...problems.map((p) => `- ${p}`), SETUP_GUIDANCE].join('\n');
}

export function removeInstallRecord(root: string): void {
  rmSync(recordPath(root), { force: true });
  try {
    lstatSync(recordPath(root));
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return;
    throw error;
  }
  throw new Error('依存の導入の記録を削除できなかった。');
}

// 一時ファイルへ排他的に書いてディスクへ反映し、最後に1回の名前変更で置く。
// 途中で止まっても、記録の名前に不完全なファイルは残らない。名前変更のあとの
// ディレクトリの反映に失敗した場合は、置いた記録を消してから失敗を返す。
export function writeInstallRecord(
  root: string,
  record: InstallRecord,
  syncDirectory: (dir: string) => void = syncDirectoryEntries,
): void {
  const dir = nodeModulesPath(root);
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
    mkdirSync(dir);
    stat = lstatSync(dir);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('node_modules がディレクトリでない（リンク等）ため、記録を書かない。');
  }
  const temp = join(dir, `${RECORD_FILE_NAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(temp, 'wx', 0o644);
    try {
      writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, recordPath(root));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  try {
    syncDirectory(dir);
  } catch (error) {
    rmSync(recordPath(root), { force: true });
    throw error;
  }
}

// 名前変更をディスクへ反映する。ディレクトリのfsyncはWindowsではできないので、POSIXだけで行う。
export function syncDirectoryEntries(dir: string): void {
  if (process.platform === 'win32') return;
  const dirFd = openSync(dir, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function describeNpmCiFailure(result: NpmCiResult): string {
  if (result.error) return `npm ci を起動できなかった（${result.error.message}）`;
  if (result.signal) return `npm ci が中断された（シグナル ${result.signal}）`;
  return `npm ci が失敗した（終了コード ${String(result.status)}）`;
}

// `npm run setup` の本体。既存の記録を消し、npm ciが成功したときだけ記録を書く。
export function runSetup(deps: SetupDependencies): number {
  const { root, runtime, log, error } = deps;
  try {
    removeInstallRecord(root);
  } catch (e) {
    error(`既存の記録を削除できないので、導入を始めない: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let lockBefore: string;
  try {
    lockBefore = sha256OfFile(lockfilePath(root));
  } catch (e) {
    error(`package-lock.json を読めない: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  log('既存の依存の導入の記録を削除した。npm ci を実行する（インストールスクリプトは実行しない）。');
  const result = deps.runNpmCi();
  if (result.error || result.signal || result.status !== 0) {
    error(`${describeNpmCiFailure(result)}。依存の導入の記録は書いていない。原因を直してから \`npm run setup\` をやり直す。`);
    return result.status !== null && result.status !== 0 ? result.status : 1;
  }
  let record: InstallRecord;
  try {
    record = observeInstall(root, runtime);
  } catch (e) {
    error(`導入後の状態を読めない: ${e instanceof Error ? e.message : String(e)}。記録は書いていない。`);
    return 1;
  }
  if (record.lockfileSha256 !== lockBefore) {
    error('npm ci の途中で package-lock.json が変わった。記録は書いていない。`npm run setup` をやり直す。');
    return 1;
  }
  try {
    writeInstallRecord(root, record, deps.syncDirectory);
  } catch (e) {
    error(`記録を書けなかった: ${e instanceof Error ? e.message : String(e)}。記録は残していない。`);
    return 1;
  }
  const check = verifyInstallRecord(root, runtime);
  if (!check.ok) {
    removeInstallRecord(root);
    error(`書いた記録を確かめられなかったので削除した。\n${formatVerificationFailure(check.problems)}`);
    return 1;
  }
  log(`依存の導入を記録した（Node.js ${runtime.node}、${runtime.platform}/${runtime.arch}）。`);
  return 0;
}
