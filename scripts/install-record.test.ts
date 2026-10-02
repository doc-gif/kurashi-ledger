// 依存の導入の記録の単体試験。npm ciの代わりに、結果を決めた関数を渡す。
// 実際のnpm ciを使う試験は setup.test.ts。
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  type NpmCiResult,
  type Runtime,
  RECORD_FILE_NAME,
  checkInstalledTree,
  compareRecord,
  npmChildEnvironment,
  npmCiArguments,
  observeInstall,
  recordPath,
  runSetup,
  verifyInstallRecord,
  writeInstallRecord,
} from './lib/install-record.ts';

const runtime: Runtime = { node: 'v24.21.0', platform: 'darwin', arch: 'arm64' };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// 合成のlockfile。必須の依存、このOS・CPUに当たる任意の依存、当たらない任意の依存を持つ。
const LOCKED: Record<string, Record<string, unknown>> = {
  'node_modules/required-dep': {
    version: '1.0.0',
    integrity: 'sha512-AAAA',
    dev: true,
    bin: { 'required-tool': 'cli.js' },
  },
  'node_modules/opt-this-platform': {
    version: '1.0.0',
    integrity: 'sha512-BBBB',
    optional: true,
    os: ['darwin'],
    cpu: ['arm64'],
  },
  'node_modules/opt-other-os': { version: '1.0.0', integrity: 'sha512-CCCC', optional: true, os: ['!darwin'] },
  'node_modules/opt-other-cpu': { version: '1.0.0', integrity: 'sha512-DDDD', optional: true, cpu: ['x64'] },
  'node_modules/opt-libc': {
    version: '1.0.0',
    integrity: 'sha512-EEEE',
    optional: true,
    os: ['darwin'],
    cpu: ['arm64'],
    libc: ['glibc'],
  },
};
const INSTALLED_PATHS = ['node_modules/required-dep', 'node_modules/opt-this-platform'];

function lockfileText(packages: Record<string, unknown>): string {
  const lock = { name: 'synthetic', lockfileVersion: 3, requires: true, packages: { '': { name: 'synthetic' }, ...packages } };
  return `${JSON.stringify(lock, null, 2)}\n`;
}

// npmと同じ形の実行ファイルのリンク。POSIXでは本体への相対のsymlink、Windowsでは.cmdのshim（通常のファイル）。
function linkTool(root: string): void {
  const bin = join(root, 'node_modules', '.bin');
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'required-tool.cmd'), '@node "%~dp0\\..\\required-dep\\cli.js" %*\r\n');
  } else {
    symlinkSync('../required-dep/cli.js', join(bin, 'required-tool'));
  }
}

function removeTool(root: string): void {
  for (const name of ['required-tool', 'required-tool.cmd']) {
    rmSync(join(root, 'node_modules', '.bin', name), { recursive: true, force: true });
  }
}

function pick(paths: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(paths.map((p) => [p, LOCKED[p]]));
}

// 合成のプロジェクト。lockfileとpackage.jsonの中身は記録の照合に使うだけで、npmは読まない。
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'kl-install-record-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"synthetic","private":true}\n');
  writeFileSync(join(root, '.npmrc'), 'ignore-scripts=true\n');
  writeFileSync(join(root, 'package-lock.json'), lockfileText(LOCKED));
  return root;
}

// npm ciが成功したときの様子をまねる（node_modulesを作り直し、導入したものをhidden lockfileに書き、
// 実行ファイルのリンクを.binに置く）。
function fakeSuccessfulCi(
  root: string,
  installed: Record<string, unknown> = pick(INSTALLED_PATHS),
  binLinks = true,
): NpmCiResult {
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  for (const path of Object.keys(installed)) {
    mkdirSync(join(root, ...path.split('/')), { recursive: true });
    writeFileSync(join(root, ...path.split('/'), 'package.json'), '{}');
  }
  if ('node_modules/required-dep' in installed) {
    // 実行ファイルの本体（lockfileのbin欄の cli.js）
    writeFileSync(join(root, 'node_modules', 'required-dep', 'cli.js'), '#!/usr/bin/env node\n');
  }
  if (binLinks) linkTool(root);
  writeFileSync(
    join(root, 'node_modules', '.package-lock.json'),
    JSON.stringify({ name: 'synthetic', lockfileVersion: 3, requires: true, packages: installed }),
  );
  return { status: 0, signal: null };
}

function setup(root: string, runNpmCi: () => NpmCiResult, rt: Runtime = runtime) {
  const lines: string[] = [];
  const code = runSetup({
    root,
    runtime: rt,
    runNpmCi,
    log: (l) => lines.push(l),
    error: (l) => lines.push(l),
  });
  return { code, output: lines.join('\n') };
}

test('npm ciが成功したときだけ記録を書き、記録はいまの状態に一致する', () => {
  const root = makeProject();
  const { code, output } = setup(root, () => fakeSuccessfulCi(root));
  assert.equal(code, 0, output);
  const record = JSON.parse(readFileSync(recordPath(root), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), [
    'arch',
    'format',
    'installedTreeSha256',
    'lockfileSha256',
    'node',
    'npmrcSha256',
    'packageJsonSha256',
    'platform',
  ]);
  assert.equal(record.format, 1);
  assert.equal(record.node, runtime.node);
  for (const key of ['lockfileSha256', 'packageJsonSha256', 'npmrcSha256', 'installedTreeSha256']) {
    assert.match(record[key], /^[0-9a-f]{64}$/, key);
  }
  assert.deepEqual(verifyInstallRecord(root, runtime), { ok: true, record });
});

for (const [name, result] of [
  ['終了コード1で失敗', { status: 1, signal: null }],
  ['シグナルで中断', { status: null, signal: 'SIGINT' }],
  ['起動に失敗', { status: null, signal: null, error: new Error('spawn failed') }],
] as const) {
  test(`npm ciが${name}した場合、前の記録を消したまま新しい記録を書かない`, () => {
    const root = makeProject();
    assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0);
    assert.ok(existsSync(recordPath(root)));
    let recordExistedDuringCi = true;
    const { code, output } = setup(root, () => {
      recordExistedDuringCi = existsSync(recordPath(root));
      return result;
    });
    assert.notEqual(code, 0);
    assert.equal(recordExistedDuringCi, false, 'npm ciの前に既存の記録を削除する');
    assert.equal(existsSync(recordPath(root)), false);
    assert.match(output, /記録は書いていない/);
    const check = verifyInstallRecord(root, runtime);
    assert.equal(check.ok, false);
  });
}

for (const file of ['package-lock.json', 'package.json', '.npmrc']) {
  test(`npm ciの途中で${file}が変わった場合は記録を書かない`, () => {
    const root = makeProject();
    const { code, output } = setup(root, () => {
      fakeSuccessfulCi(root);
      writeFileSync(join(root, file), `${readFileSync(join(root, file), 'utf8')}\n`);
      return { status: 0, signal: null };
    });
    assert.equal(code, 1, output);
    assert.match(output, /途中で/);
    assert.equal(existsSync(recordPath(root)), false);
  });
}

test('npm ciが成功を返しても、導入した木がlockfileと合わなければ記録を書かない', () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['必須の依存がない', pick(['node_modules/opt-this-platform']), /required-dep が導入されていない/],
    ['このOS・CPUに当たる任意の依存がない', pick(['node_modules/required-dep']), /opt-this-platform が導入されていない/],
    [
      '版が違う',
      {
        ...pick(INSTALLED_PATHS),
        'node_modules/required-dep': { ...LOCKED['node_modules/required-dep'], version: '1.0.1' },
      },
      /required-dep の version/,
    ],
    [
      'lockfileにないものが入っている',
      { ...pick(INSTALLED_PATHS), 'node_modules/extra-dep': { version: '9.9.9' } },
      /extra-dep はpackage-lock.jsonにない/,
    ],
  ];
  for (const [name, installed, message] of cases) {
    const root = makeProject();
    const { code, output } = setup(root, () => fakeSuccessfulCi(root, installed));
    assert.equal(code, 1, name);
    assert.match(output, message, name);
    assert.equal(existsSync(recordPath(root)), false, name);
  }
});

test('入った依存の実行ファイルのリンクが.binになければ、記録を書かない（bin-links=false等）', () => {
  const root = makeProject();
  const { code, output } = setup(root, () => fakeSuccessfulCi(root, pick(INSTALLED_PATHS), false));
  assert.equal(code, 1);
  assert.match(output, /required-dep の実行ファイル required-tool のリンク/);
  assert.equal(existsSync(recordPath(root)), false);
  // Windowsでは.cmdのshimでもよい。
  const win: Runtime = { ...runtime, platform: 'win32' };
  writeFileSync(join(root, 'node_modules', '.bin', 'required-tool.cmd'), '');
  assert.deepEqual(checkInstalledTree(root, win).filter((p) => p.includes('required-tool')), []);
});

test('照合のたびに、記録のあとで消えた依存や実行ファイルのリンクを見つける（中身は見ない）', () => {
  const expectMissing = (remove: (root: string) => void, message: RegExp) => {
    const root = makeProject();
    assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0);
    assert.equal(verifyInstallRecord(root, runtime).ok, true);
    remove(root);
    const r = verifyInstallRecord(root, runtime);
    assert.equal(r.ok, false, String(message));
    if (!r.ok) {
      assert.match(r.problems.join(), /記録の時点の導入と違う/);
      assert.match(r.problems.join(), message);
    }
  };
  expectMissing((root) => removeTool(root), /required-tool のリンク/);
  expectMissing(
    (root) => rmSync(join(root, 'node_modules', 'required-dep'), { recursive: true }),
    /required-dep が node_modules にない/,
  );
  // 中身の書換えは、構造が保たれていれば見ない（改ざんの検出は対象外。ADR-0008）。
  const root = makeProject();
  assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0);
  writeFileSync(join(root, 'node_modules', 'required-dep', 'package.json'), '{"changed":true}');
  assert.equal(verifyInstallRecord(root, runtime).ok, true);
});

test('子のnpmへは、npm_で始まる環境変数を渡さない', () => {
  const env = {
    PATH: '/synthetic/bin',
    HTTPS_PROXY: 'http://proxy.example.test:8080',
    NODE_ENV: 'production',
    npm_config_bin_links: 'false',
    NPM_CONFIG_OMIT: 'dev',
    npm_config_userconfig: '/synthetic/npmrc',
    npm_execpath: '/synthetic/npm-cli.js',
  };
  assert.deepEqual(npmChildEnvironment(env), {
    PATH: '/synthetic/bin',
    HTTPS_PROXY: 'http://proxy.example.test:8080',
    NODE_ENV: 'production',
  });
});

test('別のOS・CPU向けの任意の依存と、libcを指定した任意の依存は、なくてもよい', () => {
  const root = makeProject();
  fakeSuccessfulCi(root);
  assert.deepEqual(checkInstalledTree(root, runtime), []);
  // 同じ導入の結果でも、Linux（x64）なら当たる任意の依存が変わり、欠けていると判定する。
  const linux: Runtime = { ...runtime, platform: 'linux', arch: 'x64' };
  assert.deepEqual(checkInstalledTree(root, linux).sort(), [
    'node_modules/opt-other-cpu が導入されていない。',
    'node_modules/opt-other-os が導入されていない。',
  ]);
});

test('記録がない・壊れている・形式が違う場合は一致しないと判定し、理由を返す', () => {
  const root = makeProject();
  const missing = verifyInstallRecord(root, runtime);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.problems.join(), /記録がない/);

  mkdirSync(join(root, 'node_modules'));
  writeFileSync(recordPath(root), '{"format": 1, "lockfile');
  const broken = verifyInstallRecord(root, runtime);
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.match(broken.problems.join(), /読めない/);

  writeFileSync(recordPath(root), JSON.stringify({ ...observeInstall(root, runtime), format: 2 }));
  const wrongFormat = verifyInstallRecord(root, runtime);
  assert.equal(wrongFormat.ok, false);
  if (!wrongFormat.ok) assert.match(wrongFormat.problems.join(), /形式/);

  // package.jsonの欄がない記録（入力を一部しか結び付けていない記録）は認めない。
  const { packageJsonSha256: _omitted, ...withoutPackageJson } = observeInstall(root, runtime);
  writeFileSync(recordPath(root), JSON.stringify(withoutPackageJson));
  const partial = verifyInstallRecord(root, runtime);
  assert.equal(partial.ok, false);
  if (!partial.ok) assert.match(partial.problems.join(), /形式/);
});

test('入力（lockfile・package.json・.npmrc）・node_modules・Node.jsの版・OS・CPUのどれが変わっても一致しない', () => {
  const expectMismatch = (mutate: (root: string) => Runtime, message: RegExp) => {
    const root = makeProject();
    assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0);
    const r = verifyInstallRecord(root, mutate(root));
    assert.equal(r.ok, false, String(message));
    if (!r.ok) assert.match(r.problems.join(), message);
  };
  expectMismatch(() => ({ ...runtime, node: 'v24.21.1' }), /Node\.jsの版/);
  expectMismatch(() => ({ ...runtime, arch: 'x64' }), /OS・CPU/);
  expectMismatch(() => ({ ...runtime, platform: 'win32' }), /OS・CPU/);
  expectMismatch((root) => {
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{"packages":{}}');
    return runtime;
  }, /node_modules/);
  expectMismatch((root) => {
    writeFileSync(join(root, 'package-lock.json'), lockfileText({}));
    return runtime;
  }, /package-lock\.json が記録と違う/);
  // npm ciがnode_modulesを消す前に失敗する、package.jsonとlockfileの不一致もここで止まる。
  expectMismatch((root) => {
    const pkg = '{"name":"synthetic","private":true,"devDependencies":{"required-dep":"2.0.0"}}\n';
    writeFileSync(join(root, 'package.json'), pkg);
    return runtime;
  }, /package\.json が記録と違う/);
  expectMismatch((root) => {
    writeFileSync(join(root, '.npmrc'), 'ignore-scripts=false\n');
    return runtime;
  }, /\.npmrc が記録と違う/);
  expectMismatch((root) => {
    rmSync(join(root, '.npmrc'));
    return runtime;
  }, /\.npmrc が記録と違う/);
  expectMismatch((root) => {
    rmSync(join(root, 'package.json'));
    return runtime;
  }, /package\.json がない/);
});

test('lockfileの改行だけの違いも別の内容として扱う（そのままのバイト列で比べる）', () => {
  const root = makeProject();
  const lf = observeInstall(root, runtime);
  writeFileSync(join(root, 'package-lock.json'), lockfileText(LOCKED).replace(/\n/g, '\r\n'));
  const crlf = observeInstall(root, runtime);
  assert.notEqual(lf.lockfileSha256, crlf.lockfileSha256);
  assert.equal(compareRecord(lf, crlf).length, 1);
});

test('npm ciには、利用者・全体のnpmrcの代わりに空のファイルを渡し、主な既定の値を明示する', () => {
  assert.deepEqual(npmCiArguments(runtime, { user: 'empty-user', global: 'empty-global' }), [
    'ci',
    '--userconfig=empty-user',
    '--globalconfig=empty-global',
    '--ignore-scripts',
    '--dry-run=false',
    '--include=dev',
    '--include=optional',
    '--include=peer',
    '--install-strategy=hoisted',
    '--bin-links=true',
    '--os=darwin',
    '--cpu=arm64',
  ]);
});

test('記録は一時ファイルから名前変更で置き、一時ファイルを残さない', () => {
  const root = makeProject();
  mkdirSync(join(root, 'node_modules'));
  writeInstallRecord(root, observeInstall(root, runtime));
  assert.deepEqual(readdirSync(join(root, 'node_modules')), [RECORD_FILE_NAME]);
});

test('package-lock.jsonがなければ、前の記録を消し、npm ciを始めない', () => {
  const root = makeProject();
  assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0);
  rmSync(join(root, 'package-lock.json'));
  let ran = false;
  const { code } = setup(root, () => {
    ran = true;
    return fakeSuccessfulCi(root);
  });
  assert.equal(code, 1);
  assert.equal(ran, false);
  assert.equal(existsSync(recordPath(root)), false);
});

test('名前変更のあとのディレクトリの反映に失敗したら、置いた記録を消して失敗を返す', () => {
  const root = makeProject();
  mkdirSync(join(root, 'node_modules'));
  const failingSync = () => {
    throw Object.assign(new Error('synthetic fsync failure'), { code: 'EIO' });
  };
  assert.throws(() => writeInstallRecord(root, observeInstall(root, runtime), failingSync), /synthetic fsync failure/);
  assert.deepEqual(readdirSync(join(root, 'node_modules')), []);

  const lines: string[] = [];
  const code = runSetup({
    root,
    runtime,
    runNpmCi: () => fakeSuccessfulCi(root),
    log: (l) => lines.push(l),
    error: (l) => lines.push(l),
    syncDirectory: failingSync,
  });
  assert.equal(code, 1);
  assert.equal(existsSync(recordPath(root)), false);
  assert.equal(verifyInstallRecord(root, runtime).ok, false);
  assert.match(lines.join('\n'), /記録は残していない/);
});

// リポジトリの外の共有の場所（合成）。中に、別の担当の記録と依存に見立てたファイルを置く。
// snapshotは、中のパスとファイルの中身の一覧（変わっていないことの確認に使う）。
function makeOutside(): { dir: string; snapshot: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'kl-install-record-outside-'));
  roots.push(dir);
  writeFileSync(join(dir, RECORD_FILE_NAME), '{"other":"worktree"}');
  mkdirSync(join(dir, 'shared-dep'));
  writeFileSync(join(dir, 'shared-dep', 'package.json'), '{}');
  const snapshot = () =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .sort()
      .map((name) => {
        const full = join(dir, name);
        return lstatSync(full).isFile() ? `${name}=${readFileSync(full, 'utf8')}` : `${name}/`;
      });
  return { dir, snapshot };
}

// ディレクトリへのリンク。Windowsではjunction（管理者の権限が要らない）、ほかではsymlink。
function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

test('node_modulesがリポジトリの外へのリンクなら、setupは何も消さず・書かずに止まり、npm ciも始めない', () => {
  const root = makeProject();
  const outside = makeOutside();
  const before = outside.snapshot();
  linkDirectory(outside.dir, join(root, 'node_modules'));
  let ran = false;
  const { code, output } = setup(root, () => {
    ran = true;
    return fakeSuccessfulCi(root);
  });
  assert.equal(code, 1);
  assert.equal(ran, false, 'npm ciを始めない');
  assert.match(output, /node_modules がリンク/);
  assert.deepEqual(outside.snapshot(), before, 'リンク先の中身は変わらない');
});

test('node_modulesがリンクなら、照合は不一致とし、記録を書く処理も拒む', () => {
  const root = makeProject();
  const outside = makeOutside();
  const before = outside.snapshot();
  linkDirectory(outside.dir, join(root, 'node_modules'));
  const r = verifyInstallRecord(root, runtime);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.problems.join(), /node_modules がリンク/);
  assert.throws(() => writeInstallRecord(root, observeInstall(root, runtime)), /node_modules がリンク/);
  assert.deepEqual(outside.snapshot(), before);
});

test('記録の名前がリンクなら、setupと照合は止まり、リンク先を変えない', () => {
  const root = makeProject();
  const outside = makeOutside();
  const before = outside.snapshot();
  mkdirSync(join(root, 'node_modules'));
  linkDirectory(outside.dir, recordPath(root));
  const r = verifyInstallRecord(root, runtime);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.problems.join(), /記録がリンク/);
  let ran = false;
  const { code, output } = setup(root, () => {
    ran = true;
    return fakeSuccessfulCi(root);
  });
  assert.equal(code, 1);
  assert.equal(ran, false);
  assert.match(output, /記録がリンク/);
  assert.deepEqual(outside.snapshot(), before);
});

test('実行ファイルのリンクと本体、package.jsonは、node_modulesの中の通常のファイルに届かなければ不一致', (t) => {
  const expectBroken = (name: string, breakIt: (root: string) => void, message: RegExp) => {
    const root = makeProject();
    assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0, name);
    assert.equal(verifyInstallRecord(root, runtime).ok, true, name);
    breakIt(root);
    const r = verifyInstallRecord(root, runtime);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.match(r.problems.join(), message, name);
  };
  // リンク先（本体）が消えた（POSIXではリンクが宙に浮く）。Windowsの.cmdのshimでも本体の確認で見つかる。
  expectBroken(
    'dangling',
    (root) => rmSync(join(root, 'node_modules', 'required-dep', 'cli.js')),
    /required-tool/,
  );
  // .binの実行ファイルの名前がディレクトリ。
  expectBroken(
    'directory',
    (root) => {
      removeTool(root);
      mkdirSync(join(root, 'node_modules', '.bin', 'required-tool'));
      mkdirSync(join(root, 'node_modules', '.bin', 'required-tool.cmd'));
    },
    /required-tool のリンク/,
  );
  // package.jsonがディレクトリ。
  expectBroken(
    'package.json directory',
    (root) => {
      rmSync(join(root, 'node_modules', 'required-dep', 'package.json'));
      mkdirSync(join(root, 'node_modules', 'required-dep', 'package.json'));
    },
    /required-dep の package\.json/,
  );
  // リンクがnode_modulesの外の通常のファイルを指す。Windowsでファイルのsymlinkを作るには権限が要るので、
  // 作れない場合は、リンクがない場合として確かめ、その旨を試験の出力に残す。
  const outsideFile = join(makeOutside().dir, 'shared-dep', 'package.json');
  expectBroken(
    'outside',
    (root) => {
      removeTool(root);
      try {
        symlinkSync(outsideFile, join(root, 'node_modules', '.bin', 'required-tool'));
      } catch (error) {
        if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
          t.diagnostic('Windowsでファイルのsymlinkを作る権限がないため、外を指すリンクの場合は、リンクがない場合として確かめた');
          return;
        }
        throw error;
      }
    },
    /required-tool のリンク/,
  );
});

const LOCK = '.kurashi-ledger-setup.lock';

test('同時に起動した2つ目のsetupは、依存を変える前に止まり、1つ目の記録は有効なまま', () => {
  const root = makeProject();
  assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0);
  let second: { code: number; output: string } | undefined;
  let secondRan = false;
  let treeDuringSecond: string[] = [];
  const first = setup(root, () => {
    // 1つ目がnpm ciを実行している最中に、2つ目を起動する。
    const before = readdirSync(root).sort();
    second = setup(root, () => {
      secondRan = true;
      return fakeSuccessfulCi(root);
    });
    treeDuringSecond = readdirSync(root).sort();
    assert.deepEqual(treeDuringSecond, before, '2つ目は何も変えない');
    return fakeSuccessfulCi(root);
  });
  assert.equal(first.code, 0, first.output);
  assert.ok(second !== undefined);
  assert.equal(second.code, 1);
  assert.equal(secondRan, false, '2つ目はnpm ciを始めない');
  assert.match(second.output, /別の `npm run setup` が動いている/);
  assert.equal(verifyInstallRecord(root, runtime).ok, true, '1つ目の記録は有効');
  assert.equal(existsSync(join(root, LOCK)), false, '1つ目は終わったら印を外す');
});

test('印を持ったまま失敗・中断したsetupは、記録を残さず、印を外す', () => {
  for (const result of [
    { status: 1, signal: null },
    { status: null, signal: 'SIGINT' },
  ] as const) {
    const root = makeProject();
    assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0);
    let lockedDuringCi = false;
    const { code } = setup(root, () => {
      lockedDuringCi = existsSync(join(root, LOCK));
      return result;
    });
    assert.notEqual(code, 0);
    assert.equal(lockedDuringCi, true, 'npm ciの間は印がある');
    assert.equal(existsSync(recordPath(root)), false);
    assert.equal(existsSync(join(root, LOCK)), false);
    assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0, '次のsetupは進める');
  }
});

test('強制終了で残った印があると、setupは何も変えずに止まり、照合も不一致。印は自動で消さず、消し方を案内する', () => {
  const root = makeProject();
  assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0);
  const record = readFileSync(recordPath(root), 'utf8');
  const left = JSON.stringify({ format: 1, token: 'synthetic-crashed-run', pid: 4242, startedAt: '2026-10-03T00:00:00.000Z' });
  writeFileSync(join(root, LOCK), left);
  let ran = false;
  const { code, output } = setup(root, () => {
    ran = true;
    return fakeSuccessfulCi(root);
  });
  assert.equal(code, 1);
  assert.equal(ran, false);
  assert.equal(readFileSync(recordPath(root), 'utf8'), record, '記録を消していない');
  assert.equal(readFileSync(join(root, LOCK), 'utf8'), left, '印を自動で消さない');
  assert.match(output, /4242/);
  assert.match(output, /Remove-Item/);
  assert.match(output, /rm /);
  const check = verifyInstallRecord(root, runtime);
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.problems.join(), /作業中の印/);
  rmSync(join(root, LOCK));
  assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0, '利用者が印を消せば進める');
});

test('印の名前がリンクや別のものなら、setupは止まり、リンク先を変えない', () => {
  const root = makeProject();
  const outside = makeOutside();
  const before = outside.snapshot();
  linkDirectory(outside.dir, join(root, LOCK));
  const { code, output } = setup(root, () => fakeSuccessfulCi(root));
  assert.equal(code, 1);
  assert.match(output, /作業中の印/);
  assert.deepEqual(outside.snapshot(), before);
});

test('自分の印でなくなっていたら（途中で差し替えられた等）、終わっても消さない', () => {
  const root = makeProject();
  const replaced = JSON.stringify({ format: 1, token: 'synthetic-other-run', pid: 1, startedAt: '2026-10-03T00:00:00.000Z' });
  const { code, output } = setup(root, () => {
    writeFileSync(join(root, LOCK), replaced);
    return fakeSuccessfulCi(root);
  });
  assert.equal(code, 0, output);
  assert.equal(readFileSync(join(root, LOCK), 'utf8'), replaced);
  assert.match(output, /自分の印でない/);
});
