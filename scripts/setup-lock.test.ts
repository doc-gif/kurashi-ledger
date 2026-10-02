// `npm run setup` の同時実行を、別々のプロセスで試す。npmの代わりに合成のnpm（npm-cli.js）を使い、
// 実際の`npm ci`やネットワークに頼らない。合成のnpmは、合図のファイルができるまで待ってから
// node_modulesを作り直すので、2つのsetupが重なる時点を決められる。
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { recordPath, verifyInstallRecord } from './lib/install-record.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const LOCK = '.kurashi-ledger-setup.lock';
let work = '';
let fakeNpm = '';
let counter = 0;

const FAKE_NPM = `const fs = require('node:fs');
const path = require('node:path');
const log = process.env.FAKE_NPM_LOG;
fs.appendFileSync(log, 'start\\n');
const go = process.env.FAKE_NPM_GO;
const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 60000;
while (go && !fs.existsSync(go)) {
  if (Date.now() > deadline) process.exit(9);
  Atomics.wait(wait, 0, 0, 20);
}
const nm = path.join(process.cwd(), 'node_modules');
fs.rmSync(nm, { recursive: true, force: true });
fs.mkdirSync(nm);
fs.writeFileSync(path.join(nm, '.package-lock.json'), JSON.stringify({ name: 'kl-lock-fixture', lockfileVersion: 3, requires: true, packages: {} }));
fs.appendFileSync(log, 'done\\n');
process.exit(Number(process.env.FAKE_NPM_EXIT || '0'));
`;

before(() => {
  work = mkdtempSync(join(tmpdir(), 'kl-setup-lock-'));
  mkdirSync(join(work, 'npm'));
  fakeNpm = join(work, 'npm', 'npm-cli.js');
  writeFileSync(fakeNpm, FAKE_NPM);
});

after(() => {
  rmSync(work, { recursive: true, force: true });
});

function makeProject() {
  counter += 1;
  const root = join(work, `project-${counter}`);
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{"name":"kl-lock-fixture","private":true}\n');
  writeFileSync(
    join(root, 'package-lock.json'),
    '{"name":"kl-lock-fixture","lockfileVersion":3,"requires":true,"packages":{"":{"name":"kl-lock-fixture"}}}\n',
  );
  const log = join(work, `npm-${counter}.log`);
  const go = join(work, `go-${counter}`);
  const starts = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l === 'start').length : 0);
  return { root, log, go, starts };
}

type Run = { status: number | null; signal: NodeJS.Signals | null; stderr: string };

// setup.tsを、合成のnpmをnpm_execpathにして起動する。外側のnpm・NODE_の設定は渡さない。
function startSetup(root: string, extra: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_/i.test(key) && !/^NODE_/i.test(key)) env[key] = value;
  }
  Object.assign(env, { npm_execpath: fakeNpm, TMPDIR: work, TEMP: work, TMP: work }, extra);
  const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'setup.ts')], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const done = new Promise<Run>((resolveRun) => child.on('close', (status, signal) => resolveRun({ status, signal, stderr })));
  return { child, done };
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else process.kill(-child.pid, 'SIGKILL');
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, what);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('同時に起動した2つ目のsetupは、依存を変える前に止まり、1つ目は記録を書く', async () => {
  const p = makeProject();
  const first = startSetup(p.root, { FAKE_NPM_LOG: p.log, FAKE_NPM_GO: p.go });
  await waitFor(() => p.starts() === 1, '1つ目のnpm ciが始まらない');

  const second = await startSetup(p.root, { FAKE_NPM_LOG: p.log, FAKE_NPM_GO: p.go }).done;
  assert.equal(second.status, 1, second.stderr);
  assert.match(second.stderr, /別の `npm run setup` が動いている/);
  assert.equal(p.starts(), 1, '2つ目はnpm ciを始めない');
  assert.equal(existsSync(join(p.root, 'node_modules')), false, '2つ目はnode_modulesを作らない');

  writeFileSync(p.go, '');
  const result = await first.done;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(verifyInstallRecord(p.root).ok, true, '1つ目の記録は有効');
  assert.equal(existsSync(join(p.root, LOCK)), false);
});

test('印を持ったまま失敗したsetupは、記録を残さず印を外す', async () => {
  const p = makeProject();
  writeFileSync(p.go, '');
  const ok = await startSetup(p.root, { FAKE_NPM_LOG: p.log, FAKE_NPM_GO: p.go }).done;
  assert.equal(ok.status, 0, ok.stderr);
  const failed = await startSetup(p.root, { FAKE_NPM_LOG: p.log, FAKE_NPM_GO: p.go, FAKE_NPM_EXIT: '1' }).done;
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(existsSync(recordPath(p.root)), false);
  assert.equal(existsSync(join(p.root, LOCK)), false);
});

test('強制終了で残った印があると、次のsetupは何も変えずに止まり、印を消すと進める', async () => {
  const p = makeProject();
  const crashed = startSetup(p.root, { FAKE_NPM_LOG: p.log, FAKE_NPM_GO: p.go });
  await waitFor(() => p.starts() === 1, 'npm ciが始まらない');
  killTree(crashed.child);
  await crashed.done;
  assert.ok(existsSync(join(p.root, LOCK)), '強制終了では印が残る');
  assert.equal(existsSync(recordPath(p.root)), false);

  writeFileSync(p.go, '');
  const refused = await startSetup(p.root, { FAKE_NPM_LOG: p.log, FAKE_NPM_GO: p.go }).done;
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /前の `npm run setup` が強制終了/);
  assert.equal(p.starts(), 1, '止まったsetupはnpm ciを始めない');
  assert.ok(existsSync(join(p.root, LOCK)), '印は自動で消さない');

  rmSync(join(p.root, LOCK));
  const resumed = await startSetup(p.root, { FAKE_NPM_LOG: p.log, FAKE_NPM_GO: p.go }).done;
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(verifyInstallRecord(p.root).ok, true);
});
