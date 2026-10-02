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
import { basename, join } from 'node:path';

export const RECORD_FORMAT = 1;
export const RECORD_FILE_NAME = '.kurashi-ledger-install.json';
export const SETUP_GUIDANCE =
  '対処: `npm run setup` を実行して依存を導入し直す（WindowsのPowerShellでは `npm.cmd run setup`）。`npm ci` や `npm install` を直接実行しても記録は書かれない。';

export type Runtime = {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
};

// 導入した木を決める入力（lockfile・package.json・.npmrc・実行環境）と、導入した木（hidden lockfile）。
export type InstallRecord = {
  readonly format: number;
  readonly lockfileSha256: string;
  readonly packageJsonSha256: string;
  readonly npmrcSha256: string | null;
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

export function packageJsonPath(root: string): string {
  return join(root, 'package.json');
}

export function npmrcPath(root: string): string {
  return join(root, '.npmrc');
}

// npmが導入の最後に書く node_modules/.package-lock.json（hidden lockfile）。
export function installedTreePath(root: string): string {
  return join(nodeModulesPath(root), '.package-lock.json');
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

// リンク自身があるか（リンク先はたどらない）。
function existsQuietly(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
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

// いまの入力（lockfile・package.json・.npmrc・実行環境）とnode_modulesに対する記録の内容を求める。
export function observeInstall(root: string, runtime: Runtime): InstallRecord {
  return {
    format: RECORD_FORMAT,
    lockfileSha256: sha256OfFile(lockfilePath(root)),
    packageJsonSha256: sha256OfFile(packageJsonPath(root)),
    npmrcSha256: sha256OfFileIfPresent(npmrcPath(root)),
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
    isHex(v['packageJsonSha256']) &&
    (v['npmrcSha256'] === null || isHex(v['npmrcSha256'])) &&
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
  if (recorded.packageJsonSha256 !== actual.packageJsonSha256) {
    problems.push(
      'package.json が記録と違う（依存の宣言やscriptsを変えた、branchやタグを切り替えた等）。',
    );
  }
  if (recorded.npmrcSha256 !== actual.npmrcSha256) {
    problems.push('.npmrc が記録と違う（npmの設定を変えた、branchやタグを切り替えた等）。');
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
      return { ok: false, problems: [`${basename(error.path ?? '')} がない。`] };
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

// npm ciへ渡す環境変数。npm_ で始まるもの（npm_config_* の設定と、npm runが渡す値）を
// すべて外す。利用者・全体のnpmrcは、引数の --userconfig・--globalconfig で空のファイルに
// 差し替える。導入する木を決めるnpmの設定を、repoの.npmrc（記録に結び付けてレビューする）と、
// 下の引数だけにするため（ADR-0008）。設定の名前を1つずつ数えて固定する方法では、
// 数え漏らした設定（bin-links等）で木が変わりうる。
export function npmChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^npm_/i.test(key)) child[key] = value;
  }
  return child;
}

// npm ciに渡す引数。emptyConfigsは中身が空の2つのnpmrcのパス（npmは同じファイルを
// 利用者と全体の両方に使うと止まる）。主な既定の値も明示し、npm自身の組込みの設定
// （npmの導入先のnpmrc）で変えられないようにする。
export function npmCiArguments(
  runtime: Runtime,
  emptyConfigs: { readonly user: string; readonly global: string },
): string[] {
  return [
    'ci',
    `--userconfig=${emptyConfigs.user}`,
    `--globalconfig=${emptyConfigs.global}`,
    '--ignore-scripts',
    '--dry-run=false',
    '--include=dev',
    '--include=optional',
    '--include=peer',
    '--install-strategy=hoisted',
    '--bin-links=true',
    `--os=${runtime.platform}`,
    `--cpu=${runtime.arch}`,
  ];
}

type LockEntry = Record<string, unknown>;

function readPackages(path: string): Map<string, LockEntry> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  const packages = (parsed as { packages?: unknown } | null)?.packages;
  if (typeof packages !== 'object' || packages === null) throw new Error(`${basename(path)} にpackagesがない`);
  return new Map(
    Object.entries(packages as Record<string, unknown>).filter(
      (e): e is [string, LockEntry] => e[0] !== '' && typeof e[1] === 'object' && e[1] !== null,
    ),
  );
}

// package.jsonのos・cpu欄と同じ書き方（"!win32"のような否定を含む）の一覧に、値が当たるか。
function matchesPlatformList(list: unknown, value: string): boolean {
  if (!Array.isArray(list) || list.length === 0) return true;
  const names = list.filter((x): x is string => typeof x === 'string');
  if (names.some((n) => n === `!${value}`)) return false;
  const positive = names.filter((n) => !n.startsWith('!'));
  return positive.length === 0 || positive.includes(value);
}

// 依存の実行ファイルのリンクを置くディレクトリ（そのパッケージがあるnode_modulesの.bin）。
function binDirectory(packagePath: string): string {
  const index = packagePath.lastIndexOf('node_modules/');
  return `${packagePath.slice(0, index)}node_modules/.bin`;
}

// npm ciのあとで、導入した木がpackage-lock.jsonと合うかを確かめる。
// - 必須の依存と、このOS・CPUに当たる任意の依存（optional）がすべて同じ版で入り、
//   lockfileにないものが入っていないこと（hidden lockfileで確かめる）。
// - 入った依存の実行ファイル（lockfileのbin欄）のリンクが.binにあること（ディスクで確かめる。
//   Windowsでは.cmdのshimでもよい）。
// 任意の依存の取得失敗等で、npm ciが成功を返しても木が欠けている場合に、記録を書かないため。
export function checkInstalledTree(root: string, runtime: Runtime): string[] {
  const locked = readPackages(lockfilePath(root));
  if (locked === null) return ['package-lock.json がない。'];
  const installed = readPackages(installedTreePath(root)) ?? new Map<string, LockEntry>();
  const problems: string[] = [];
  for (const [path, entry] of locked) {
    const got = installed.get(path);
    if (got === undefined) {
      const optional = entry['optional'] === true || entry['devOptional'] === true;
      const applies =
        matchesPlatformList(entry['os'], runtime.platform) &&
        matchesPlatformList(entry['cpu'], runtime.arch) &&
        entry['libc'] === undefined;
      if (!optional || applies) problems.push(`${path} が導入されていない。`);
      continue;
    }
    for (const key of ['version', 'integrity', 'resolved', 'link']) {
      if (key in entry && entry[key] !== got[key]) problems.push(`${path} の ${key} がpackage-lock.jsonと違う。`);
    }
    const bin = entry['bin'];
    if (typeof bin === 'object' && bin !== null) {
      for (const name of Object.keys(bin)) {
        const link = join(root, ...binDirectory(path).split('/'), name);
        const candidates = runtime.platform === 'win32' ? [link, `${link}.cmd`] : [link];
        if (!candidates.some((c) => existsQuietly(c))) {
          problems.push(`${path} の実行ファイル ${name} のリンクが node_modules/.bin 等にない。`);
        }
      }
    }
  }
  for (const path of installed.keys()) {
    if (!locked.has(path)) problems.push(`${path} はpackage-lock.jsonにない。`);
  }
  return problems;
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
  let before: InstallRecord;
  try {
    before = observeInstall(root, runtime);
  } catch (e) {
    error(`package-lock.json・package.json・.npmrc を読めない: ${e instanceof Error ? e.message : String(e)}`);
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
  if (
    record.lockfileSha256 !== before.lockfileSha256 ||
    record.packageJsonSha256 !== before.packageJsonSha256 ||
    record.npmrcSha256 !== before.npmrcSha256
  ) {
    error('npm ci の途中で package-lock.json・package.json・.npmrc のどれかが変わった。記録は書いていない。`npm run setup` をやり直す。');
    return 1;
  }
  let treeProblems: string[];
  try {
    treeProblems = checkInstalledTree(root, runtime);
  } catch (e) {
    treeProblems = [`導入した依存の一覧を読めない: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (treeProblems.length > 0) {
    const shown = treeProblems.slice(0, 10).map((p) => `- ${p}`);
    if (treeProblems.length > 10) shown.push(`- ほか${treeProblems.length - 10}件`);
    error(`npm ci は成功を返したが、導入した依存が package-lock.json と合わない。記録は書いていない。\n${shown.join('\n')}`);
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
