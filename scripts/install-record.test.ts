// 依存の導入の記録の単体試験。npm ciの代わりに、結果を決めた関数を渡す。
// 実際のnpm ciを使う試験は setup.test.ts。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  type NpmCiResult,
  type Runtime,
  RECORD_FILE_NAME,
  compareRecord,
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

// 合成のプロジェクト。lockfileの中身は記録の照合に使うだけで、npmは読まない。
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'kl-install-record-'));
  roots.push(root);
  writeFileSync(join(root, 'package-lock.json'), '{"name":"synthetic","lockfileVersion":3,"packages":{}}\n');
  return root;
}

// npm ciが成功したときの様子をまねる（node_modulesを作り直し、hidden lockfileを書く）。
function fakeSuccessfulCi(root: string): NpmCiResult {
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{"synthetic":true}\n');
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
  const { code } = setup(root, () => fakeSuccessfulCi(root));
  assert.equal(code, 0);
  const record = JSON.parse(readFileSync(recordPath(root), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), [
    'arch',
    'format',
    'installedTreeSha256',
    'lockfileSha256',
    'node',
    'platform',
  ]);
  assert.equal(record.format, 1);
  assert.equal(record.node, runtime.node);
  assert.match(record.lockfileSha256, /^[0-9a-f]{64}$/);
  assert.match(record.installedTreeSha256, /^[0-9a-f]{64}$/);
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

test('npm ciの途中でlockfileが変わった場合は記録を書かない', () => {
  const root = makeProject();
  const { code } = setup(root, () => {
    fakeSuccessfulCi(root);
    writeFileSync(join(root, 'package-lock.json'), '{"changed":true}\n');
    return { status: 0, signal: null };
  });
  assert.equal(code, 1);
  assert.equal(existsSync(recordPath(root)), false);
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
});

test('lockfile・node_modules・Node.jsの版・OS・CPUのどれが変わっても一致しない', () => {
  const root = makeProject();
  assert.equal(setup(root, () => fakeSuccessfulCi(root)).code, 0);

  const otherPatch: Runtime = { ...runtime, node: 'v24.21.1' };
  const r1 = verifyInstallRecord(root, otherPatch);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.problems.join(), /Node\.jsの版/);

  const otherCpu: Runtime = { ...runtime, arch: 'x64' };
  const r2 = verifyInstallRecord(root, otherCpu);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.problems.join(), /OS・CPU/);

  const otherOs: Runtime = { ...runtime, platform: 'win32' };
  const r3 = verifyInstallRecord(root, otherOs);
  assert.equal(r3.ok, false);

  writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{"synthetic":"reinstalled"}\n');
  const r4 = verifyInstallRecord(root, runtime);
  assert.equal(r4.ok, false);
  if (!r4.ok) assert.match(r4.problems.join(), /node_modules/);

  writeFileSync(join(root, 'package-lock.json'), '{"name":"synthetic","lockfileVersion":3,"packages":{"x":{}}}\n');
  const r5 = verifyInstallRecord(root, runtime);
  assert.equal(r5.ok, false);
  if (!r5.ok) assert.match(r5.problems.join(), /package-lock\.json/);
});

test('lockfileの改行だけの違いも別の内容として扱う（そのままのバイト列で比べる）', () => {
  const root = makeProject();
  const lf = observeInstall(root, runtime);
  writeFileSync(join(root, 'package-lock.json'), '{"name":"synthetic","lockfileVersion":3,"packages":{}}\r\n');
  const crlf = observeInstall(root, runtime);
  assert.notEqual(lf.lockfileSha256, crlf.lockfileSha256);
  assert.equal(compareRecord(lf, crlf).length, 1);
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
