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
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, join, sep } from 'node:path';

export const RECORD_FORMAT = 1;
export const RECORD_FILE_NAME = '.kurashi-ledger-install.json';
// npm run setupの作業中の印。npm ciが消すnode_modulesの外（worktreeの直下）に置く（ADR-0008）。
export const SETUP_LOCK_NAME = '.kurashi-ledger-setup.lock';
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

// 実行中のnpm ci。doneは終わるのを待つ（失敗も結果として返し、rejectしない）。
// forwardは、npm ciにシグナルを転送する（もう終わっていれば何もしない）。
export type NpmCiRun = {
  readonly done: Promise<NpmCiResult>;
  readonly forward?: ((signal: NodeJS.Signals) => void) | undefined;
};

export type SetupDependencies = {
  readonly root: string;
  readonly runtime: Runtime;
  readonly runNpmCi: () => NpmCiRun;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  // 終了のシグナルの受付。setup.tsがprocessのシグナルをここへ渡す。試験では直接notifyする。
  readonly interruption?: SetupInterruption | undefined;
  // 試験で、ディレクトリの反映の失敗を起こすために差し替える。
  readonly syncDirectory?: ((dir: string) => void) | undefined;
};

// setupが受け付ける終了のシグナル（ADR-0008）。WindowsではCtrl+CがSIGINT、Ctrl+BreakがSIGBREAKになる。
export function setupSignals(platform: string): NodeJS.Signals[] {
  return platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
}

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 };

// シグナルで中断したときの終了コード（128+シグナル番号。SIGINTは130）。
export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (SIGNAL_NUMBERS[signal] ?? 0);
}

// 終了のシグナルの受付。最初のシグナルだけを覚え、以後の手順を始めさせない。npm ciが動いていれば、
// 猶予（graceMs）のあいだに自分で終わらなければ（シグナルが届いていなければ）、同じシグナルを1回だけ転送する。
// 2回目以降のシグナル（端末のCtrl+Cと、npm runによる転送が重なる等）は、受付済みとして何もしない。
export class SetupInterruption {
  #signal: NodeJS.Signals | null = null;
  #child: NpmCiRun | null = null;
  #childDone = false;
  #timer: NodeJS.Timeout | null = null;
  readonly #graceMs: number;
  readonly #onFirstSignal: (signal: NodeJS.Signals) => void;

  constructor(options: { graceMs?: number; onFirstSignal?: (signal: NodeJS.Signals) => void } = {}) {
    this.#graceMs = options.graceMs ?? 3000;
    this.#onFirstSignal = options.onFirstSignal ?? (() => {});
  }

  get signal(): NodeJS.Signals | null {
    return this.#signal;
  }

  notify(signal: NodeJS.Signals): void {
    if (this.#signal !== null) return;
    this.#signal = signal;
    this.#onFirstSignal(signal);
    this.#scheduleForward();
  }

  attach(run: NpmCiRun): void {
    this.#child = run;
    this.#childDone = false;
    const finished = () => {
      this.#childDone = true;
      this.#clearTimer();
    };
    run.done.then(finished, finished);
    this.#scheduleForward();
  }

  detach(): void {
    this.#child = null;
    this.#clearTimer();
  }

  #scheduleForward(): void {
    const signal = this.#signal;
    if (signal === null || this.#child === null || this.#childDone || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#child !== null && !this.#childDone) this.#child.forward?.(signal);
    }, this.#graceMs);
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

// シグナルの処理（イベントループ）を先に回す。同期の手順の最中に届いたシグナルを、次の判断の前に受け付けるため。
function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

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

// node_modulesや記録の名前が、リンク（symlink・junction）だったり、リポジトリの外を指したり
// していることを表す。記録の削除・書込み・照合は、これを確かめてから行い、当たれば何も変えずに止める。
export class UnsafeInstallPathError extends Error {}

const UNSAFE_NODE_MODULES =
  'node_modules がリンク（symlink・junction）か、通常のディレクトリでないか、リポジトリの外を指している。' +
  'リンクをたどって外の場所を変えないよう、何も変えずに止めた。共有の node_modules は使えない。' +
  'リンク自身だけを外して（リンク先の中身は消さない）から `npm run setup` を実行する。';

// node_modulesが、リポジトリの直下にある通常のディレクトリか、まだないかを確かめる。
// lstatでリンクをたどらずに調べ、実体パスもリポジトリの直下と一致することを確かめる。
export function inspectNodeModules(root: string): 'absent' | 'directory' {
  const dir = nodeModulesPath(root);
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 'absent';
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UnsafeInstallPathError(UNSAFE_NODE_MODULES);
  if (realpathSync(dir) !== join(realpathSync(root), 'node_modules')) {
    throw new UnsafeInstallPathError(UNSAFE_NODE_MODULES);
  }
  return 'directory';
}

// 記録の名前が、まだないか、通常のファイルかを確かめる（node_modulesを確かめたあとで呼ぶ）。
function inspectRecordPath(root: string): 'absent' | 'file' {
  let stat;
  try {
    stat = lstatSync(recordPath(root));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 'absent';
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new UnsafeInstallPathError(
      `依存の導入の記録がリンクか、通常のファイルでない（${RECORD_FILE_NAME}）。リンク先を変えないよう、何も変えずに止めた。`,
    );
  }
  return 'file';
}

// その名前の項目があるか（リンクはたどらない。宙に浮いたリンクもあるとみなす）。
function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

export function setupLockPath(root: string): string {
  return join(root, SETUP_LOCK_NAME);
}

export class SetupLockError extends Error {}

export type SetupLock = { readonly token: string };

// 残っている印の中身（プロセス番号と開始時刻）を、案内のために読む。リンクはたどらない。
function describeSetupLock(root: string): string {
  const path = setupLockPath(root);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return '';
  }
  if (!stat.isFile()) return '（印の名前が通常のファイルでない（リンク等）。リンクなら、リンク自身だけを外す）';
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; startedAt?: unknown };
    const pid = typeof info.pid === 'number' ? String(info.pid) : '不明';
    const startedAt = typeof info.startedAt === 'string' ? info.startedAt : '不明';
    return `（記録されたプロセス番号 ${pid}、開始 ${startedAt}）`;
  } catch {
    return '（印の中身を読めない）';
  }
}

// worktree単位の排他。排他的な作成（wx。既存のファイルやリンクがあれば失敗する）で印を作り、
// 作れなければ何も変えずに止める。残った印を、プロセス番号の生死で判断して自動で消すことはしない
// （番号は再利用されうる。ADR-0006のG3と同じ考え方）。
export function acquireSetupLock(root: string): SetupLock {
  const path = setupLockPath(root);
  const token = randomBytes(16).toString('hex');
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o644);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      throw new SetupLockError(
        [
          `別の \`npm run setup\` が動いているか、前の \`npm run setup\` が強制終了（kill -9、タスク マネージャー、電源断等。Ctrl+Cでは残らない）して作業中の印が残っている。依存は何も変えずに止めた。`,
          `作業中の印: このworktreeの直下の ${SETUP_LOCK_NAME}${describeSetupLock(root)}`,
          '動いている setup がないことを確かめてから（macOS: `ps -p <番号>` やアクティビティモニタ、Windows: タスク マネージャーで node.exe を確かめる。プロセス番号は再利用されることがあるので、番号だけで判断しない）、印を消して（macOS: `rm .kurashi-ledger-setup.lock`、WindowsのPowerShell: `Remove-Item .kurashi-ledger-setup.lock`）、`npm run setup` をやり直す。',
        ].join('\n'),
      );
    }
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify({ format: 1, token, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkIfPresent(path);
    throw error;
  }
  closeSync(fd);
  return { token };
}

// 自分の印だけを消す。消えていたり差し替えられていたりすれば消さずに、その旨を返す。
// 調べる・消す操作が失敗しても例外にせず、残った印の案内を返す（中断の終了コードや、成功・失敗の
// 判断を、印の後始末の失敗で変えないため。印が残れば、照合と次のsetupは止まる）。
export function releaseSetupLock(root: string, lock: SetupLock): string | null {
  const path = setupLockPath(root);
  try {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return `作業中の印（${SETUP_LOCK_NAME}）が、終わる前に消えていた。`;
      }
      throw error;
    }
    let token: unknown;
    if (stat.isFile()) {
      try {
        token = (JSON.parse(readFileSync(path, 'utf8')) as { token?: unknown }).token;
      } catch {
        token = undefined;
      }
    }
    if (token !== lock.token) {
      return `作業中の印（${SETUP_LOCK_NAME}）が自分の印でない（途中で差し替えられた等）ので、消さずに残した。中身を確かめてから消す。`;
    }
    unlinkSync(path);
    return null;
  } catch (error) {
    return [
      `作業中の印（${SETUP_LOCK_NAME}）を消せなかった: ${error instanceof Error ? error.message : String(error)}`,
      `印が残っているあいだは、照合と次の \`npm run setup\` が止まる。原因（権限等）を直してから、印を消す（macOS: \`rm ${SETUP_LOCK_NAME}\`、WindowsのPowerShell: \`Remove-Item ${SETUP_LOCK_NAME}\`）。`,
    ].join('\n');
  }
}

// シグナルで中断したときの片付け。シグナルの処理から呼ぶほか、試験から直接呼べる。
// 記録と、このプロセスが記録を書く途中の一時ファイルを消してから、自分の印だけを消す。
// 記録を消せなかった場合は印を残す（印があれば照合は不一致になり、古い記録が使われない）。
export function cleanupAfterInterruption(root: string, lock: SetupLock): { recordCleared: boolean; notes: string[] } {
  try {
    if (inspectNodeModules(root) === 'directory') {
      removeInstallRecord(root);
      const prefix = `${RECORD_FILE_NAME}.${process.pid}.`;
      for (const name of readdirSync(nodeModulesPath(root))) {
        if (name.startsWith(prefix) && name.endsWith('.tmp')) unlinkIfPresent(join(nodeModulesPath(root), name));
      }
    }
  } catch (e) {
    return { recordCleared: false, notes: [keptLockNote(e)] };
  }
  const warning = releaseSetupLock(root, lock);
  return { recordCleared: true, notes: warning === null ? [] : [warning] };
}

function keptLockNote(e: unknown): string {
  return `依存の導入の記録を片付けられなかったので、作業中の印（${SETUP_LOCK_NAME}）を残した。setupと照合は止まったままになる。原因を直してから、記録（node_modules/${RECORD_FILE_NAME}）と印を消す: ${e instanceof Error ? e.message : String(e)}`;
}

// pathをたどって（リンクを解決して）、通常のファイルに届き、その実体パスがbaseの中にあるか。
// リンク先がない（宙に浮いたリンク）、ディレクトリ、baseの外を指すものは、届かないとする。
function reachesRegularFile(path: string, base: string): 'absent' | 'ok' | 'invalid' {
  let lstat;
  try {
    lstat = lstatSync(path);
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return 'absent';
    throw error;
  }
  if (lstat.isDirectory()) return 'invalid';
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    if (isErrnoException(error) && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code ?? '')) return 'invalid';
    throw error;
  }
  if (!stat.isFile()) return 'invalid';
  const real = realpathSync(path);
  return real.startsWith(base + sep) ? 'ok' : 'invalid';
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
  return verifyInstallRecordImpl(root, runtime, false);
}

// ownSetupLockがtrueなのは、setup自身が印を持ったまま最後に照合するときだけ。
function verifyInstallRecordImpl(root: string, runtime: Runtime, ownSetupLock: boolean): Verification {
  if (!ownSetupLock && pathEntryExists(setupLockPath(root))) {
    return {
      ok: false,
      problems: [
        `依存の導入の作業中の印（${SETUP_LOCK_NAME}）がある。\`npm run setup\` が動いているか、強制終了して印が残っている（\`npm run setup\` を実行すると、確かめ方と消し方を表示する）。`,
      ],
    };
  }
  const missing: Verification = {
    ok: false,
    problems: [
      '依存の導入の記録がない（`npm run setup` を実行していない、`npm ci` を直接実行した、または導入が途中で止まった）。',
    ],
  };
  try {
    if (inspectNodeModules(root) === 'absent' || inspectRecordPath(root) === 'absent') return missing;
  } catch (error) {
    if (error instanceof UnsafeInstallPathError) return { ok: false, problems: [error.message] };
    throw error;
  }
  const text = readFileSync(recordPath(root), 'utf8');
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
  if (problems.length > 0) return { ok: false, problems };
  // 記録の入力が一致しても、記録のあとでnode_modulesの一部が消えた場合（手で消した等）に備え、
  // 安く確かめられる構造（各パッケージのpackage.jsonと実行ファイルのリンクがあること）を確かめる。
  // ファイルの中身までは確かめない（ADR-0008の「この記録が示すこと・示さないこと」）。
  let treeProblems: string[];
  try {
    treeProblems = checkInstalledTree(root, runtime);
  } catch (e) {
    treeProblems = [`導入した依存の一覧を読めない: ${e instanceof Error ? e.message : String(e)}`];
  }
  if (treeProblems.length > 0) {
    return { ok: false, problems: ['node_modules が記録の時点の導入と違う（一部が消えた等）。', ...treeProblems.slice(0, 10)] };
  }
  return { ok: true, record: parsed };
}

export function formatVerificationFailure(problems: readonly string[]): string {
  return [...problems.map((p) => `- ${p}`), SETUP_GUIDANCE].join('\n');
}

// 記録を消す。node_modulesと記録の名前がリンクでないことを確かめてから、通常のファイルだけを
// unlinkで消す（リンクをたどらない）。当たれば何も消さずにUnsafeInstallPathErrorを投げる。
export function removeInstallRecord(root: string): void {
  if (inspectNodeModules(root) === 'absent') return;
  if (inspectRecordPath(root) === 'absent') return;
  unlinkSync(recordPath(root));
  if (inspectRecordPath(root) !== 'absent') throw new Error('依存の導入の記録を削除できなかった。');
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
  }
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
  if (inspectNodeModules(root) === 'absent') {
    mkdirSync(dir);
    inspectNodeModules(root);
  }
  // 記録の名前にリンク等があれば止める。通常のファイルがあれば、名前変更で置き換わる。
  inspectRecordPath(root);
  // 一時ファイルは排他的に作るので、同じ名前のファイルやリンクがあれば失敗する。
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
    unlinkIfPresent(temp);
    throw error;
  }
  try {
    syncDirectory(dir);
  } catch (error) {
    unlinkIfPresent(recordPath(root));
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

// 導入した木がpackage-lock.jsonと合うかを確かめる。setupでは記録を書く前に、照合では毎回行う。
// - 必須の依存と、このOS・CPUに当たる任意の依存（optional）がすべて同じ版で入り、
//   lockfileにないものが入っていないこと（hidden lockfileで確かめる）。
// - 入った依存のpackage.json、実行ファイルの本体（lockfileのbin欄のパス）、.binのリンク
//   （Windowsでは.cmdのshimでもよい）が、リンクをたどって、node_modulesの中の通常のファイルに
//   届くこと（lockfileでlinkの依存は、リポジトリの中）。ファイルの中身は確かめない。
// 任意の依存の取得失敗等で、npm ciが成功を返しても木が欠けている場合に、記録を書かないため。
export function checkInstalledTree(root: string, runtime: Runtime): string[] {
  const locked = readPackages(lockfilePath(root));
  if (locked === null) return ['package-lock.json がない。'];
  const installed = readPackages(installedTreePath(root)) ?? new Map<string, LockEntry>();
  const problems: string[] = [];
  const repoBase = realpathSync(root);
  const nodeModulesBase = join(repoBase, 'node_modules');
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
    const base = entry['link'] === true ? repoBase : nodeModulesBase;
    const packageDir = join(root, ...path.split('/'));
    const manifest = reachesRegularFile(join(packageDir, 'package.json'), base);
    if (manifest === 'absent') problems.push(`${path} が node_modules にない（package.json がない）。`);
    if (manifest === 'invalid') problems.push(`${path} の package.json が、通常のファイルでないか、外を指している。`);
    const bin = entry['bin'];
    if (typeof bin === 'object' && bin !== null) {
      for (const [name, target] of Object.entries(bin as Record<string, unknown>)) {
        if (typeof target === 'string' && reachesRegularFile(join(packageDir, ...target.split('/')), base) !== 'ok') {
          problems.push(`${path} の実行ファイル ${name} の本体（${target}）が、通常のファイルとして入っていない。`);
        }
        const link = join(root, ...binDirectory(path).split('/'), name);
        const candidates = runtime.platform === 'win32' ? [link, `${link}.cmd`] : [link];
        if (!candidates.some((c) => reachesRegularFile(c, base) === 'ok')) {
          problems.push(
            `${path} の実行ファイル ${name} のリンクが、node_modules/.bin 等にないか、通常のファイルに届かない（リンク先がない、ディレクトリ、または外を指す）。`,
          );
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

// `npm run setup` の本体。worktree単位の作業中の印を取ってから、既存の記録を消し、npm ciが成功したときだけ
// 記録を書き、最後に印を外す。印を取れなければ、記録もnode_modulesも変えずに止まる。
// 終了のシグナルを受けたら、新しい手順を始めず、npm ciの終了を待ってから、記録・一時ファイル・自分の印を
// 片付けて、128+シグナル番号を返す。最後の照合のあとの確認（確定点）より前に届いたシグナルは中断として扱い
// （書き終えた記録も消す）、確定点より後に届いたものは、記録を残したまま成功として終える（ADR-0008）。
export async function runSetup(deps: SetupDependencies): Promise<number> {
  const interruption = deps.interruption ?? new SetupInterruption();
  let lock: SetupLock;
  try {
    lock = acquireSetupLock(deps.root);
  } catch (e) {
    deps.error(
      e instanceof SetupLockError
        ? e.message
        : `作業中の印を作れないので、導入を始めない: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  let code: number;
  let recordLeft: unknown = null;
  try {
    code = await runSetupLocked(deps, interruption);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    try {
      removeInstallRecord(deps.root);
      deps.error(`導入の途中で失敗した: ${reason}。記録は残していない。`);
    } catch (r) {
      deps.error(`導入の途中で失敗した: ${reason}。`);
      recordLeft = r;
    }
    code = 1;
  }
  // 確定点。ここまでに届いたシグナルを受け付けてから判断する。
  await yieldToEvents();
  const signal = interruption.signal;
  if (signal !== null) {
    const { recordCleared, notes } = cleanupAfterInterruption(deps.root, lock);
    const head = `${signal} を受けたので中断した。${recordCleared ? '依存の導入の記録は残していない。' : ''}`;
    deps.error([head, ...notes].join('\n'));
    return signalExitCode(signal);
  }
  if (recordLeft !== null) {
    // 記録が残ったかもしれないので、中断のときと同じく印を残して、setupと照合を止めておく。
    deps.error(keptLockNote(recordLeft));
    return code;
  }
  const warning = releaseSetupLock(deps.root, lock);
  if (warning !== null) deps.error(warning);
  return code;
}

async function runSetupLocked(deps: SetupDependencies, interruption: SetupInterruption): Promise<number> {
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
  // npm ciを始める前に、届いているシグナルを受け付ける（受けていれば始めない）。
  await yieldToEvents();
  if (interruption.signal !== null) return 1;
  log('既存の依存の導入の記録を削除した。npm ci を実行する（インストールスクリプトは実行しない）。');
  const run = deps.runNpmCi();
  interruption.attach(run);
  const result = await run.done;
  interruption.detach();
  // npm ciの最中にシグナルを受けていれば、次の手順を始めない（片付けはrunSetupで行う）。
  if (interruption.signal !== null) return 1;
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
  const check = verifyInstallRecordImpl(root, runtime, true);
  if (!check.ok) {
    removeInstallRecord(root);
    error(`書いた記録を確かめられなかったので削除した。\n${formatVerificationFailure(check.problems)}`);
    return 1;
  }
  log(`依存の導入を記録した（Node.js ${runtime.node}、${runtime.platform}/${runtime.arch}）。`);
  return 0;
}
