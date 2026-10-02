// `npm run setup`・`npm run check:install`・`npm run build` を、実際のnpmで試す。
// 合成の依存を1つだけ持つ一時プロジェクトを作り、127.0.0.1の合成のregistryから配る。
// インターネットや利用者のnpm設定・キャッシュ、このrepoのnode_modulesは使わない。
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..');
const DEP_NAME = 'kl-synthetic-dep';
const DEP_FILE = `${DEP_NAME}-1.0.0.tgz`;
const RECORD = join('node_modules', '.kurashi-ledger-install.json');
const TIMEOUT_MS = 120_000;

type Mode = 'ok' | 'missing' | 'hang';
type Run = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

let mode: Mode = 'ok';
let requests = 0;
const held: ServerResponse[] = [];
let server: Server;
let port = 0;
let work = '';
let tarball: Buffer;
let integrity = '';
let counter = 0;

function findNpmCli(): string {
  const fromEnv = process.env['npm_execpath'];
  if (fromEnv !== undefined && /^npm-cli\.c?js$/.test(basename(fromEnv))) return fromEnv;
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // macOS・Linux
  ];
  const found = candidates.find((c) => existsSync(c));
  if (found === undefined) throw new Error('npmが見つからない（npm-cli.js）');
  return found;
}
const npmCli = findNpmCli();

// 外側のnpm（npm test）から受け継いだ設定を消し、試験用の設定だけを渡す。
// npm_config_local_prefix等が残ると、内側のnpmがこのrepoを対象にしてしまう。
// NODE_ENV・NODE_OPTIONS等も外し、試験の結果が実行する人の環境に左右されないようにする。
function npmEnv(cacheName: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_/i.test(key) || /^NODE_/i.test(key)) continue;
    env[key] = value;
  }
  env['npm_config_cache'] = join(work, cacheName);
  env['npm_config_userconfig'] = join(work, 'empty-userconfig');
  env['npm_config_globalconfig'] = join(work, 'empty-globalconfig');
  return env;
}

// npmの子・孫のプロセス（setupが起動するnpm ci）までまとめて止める。
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // すでに終わっている
    }
  }
}

// 合成のregistryがこのプロセスで動いているので、同期の実行（spawnSync）は使わない。
function startNpm(cwd: string, args: readonly string[], cacheName: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [npmCli, ...args], {
    cwd,
    env: { ...npmEnv(cacheName), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32', // POSIXでは新しいプロセスグループにする
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  const exited = new Promise<void>((resolveExit) => child.on('exit', () => resolveExit()));
  const done = new Promise<Run>((resolveRun) => {
    const timer = setTimeout(() => killTree(child, 'SIGKILL'), TIMEOUT_MS);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolveRun({ status, signal, stdout, stderr });
    });
  });
  return { child, exited, done };
}

function npm(
  cwd: string,
  args: readonly string[],
  cacheName = `cache-${counter}`,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Run> {
  return startNpm(cwd, args, cacheName, extraEnv).done;
}

function describe(r: Run): string {
  return `status=${String(r.status)} signal=${String(r.signal)}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'kl-setup-test-'));
  writeFileSync(join(work, 'empty-userconfig'), '');
  writeFileSync(join(work, 'empty-globalconfig'), '');

  // 合成の依存。インストールスクリプトが動けば、npmを起動したディレクトリに印を残す。
  const src = join(work, 'dep-src');
  mkdirSync(src);
  writeFileSync(
    join(src, 'package.json'),
    JSON.stringify({ name: DEP_NAME, version: '1.0.0', scripts: { postinstall: 'node postinstall.cjs' } }),
  );
  writeFileSync(join(src, 'index.js'), 'module.exports = 1;\n');
  writeFileSync(
    join(src, 'postinstall.cjs'),
    "require('node:fs').writeFileSync(require('node:path').join(process.env.INIT_CWD, 'postinstall-ran'), 'x');\n",
  );
  const packed = await npm(src, ['pack', '--ignore-scripts', '--pack-destination', work], 'cache-pack');
  assert.equal(packed.status, 0, describe(packed));
  tarball = readFileSync(join(work, DEP_FILE));
  integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;

  server = createServer((req, res) => {
    requests += 1;
    if (mode === 'hang') {
      held.push(res);
      return;
    }
    if (mode === 'ok' && req.url === `/${DEP_NAME}/-/${DEP_FILE}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tarball);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  for (const res of held.splice(0)) res.destroy();
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  rmSync(work, { recursive: true, force: true });
});

// 一時プロジェクト。scriptsはこのrepoのスクリプトを直接指す。キャッシュはプロジェクトごとに分ける。
function makeProject(): string {
  counter += 1;
  const root = join(work, `project-${counter}`);
  mkdirSync(root);
  const script = (name: string) => `node "${join(repoRoot, 'scripts', name)}"`;
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'kl-setup-fixture',
        private: true,
        scripts: {
          setup: script('setup.ts'),
          'check:install': script('check-install.ts'),
          build: script('build.ts'),
        },
        devDependencies: { [DEP_NAME]: '1.0.0' },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'kl-setup-fixture',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'kl-setup-fixture', devDependencies: { [DEP_NAME]: '1.0.0' } },
          [`node_modules/${DEP_NAME}`]: {
            version: '1.0.0',
            resolved: `http://127.0.0.1:${port}/${DEP_NAME}/-/${DEP_FILE}`,
            integrity,
            dev: true,
            hasInstallScript: true,
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, '.npmrc'),
    [
      'ignore-scripts=true',
      `registry=http://127.0.0.1:${port}/`,
      'audit=false',
      'fund=false',
      'update-notifier=false',
      'fetch-retries=0',
      '',
    ].join('\n'),
  );
  return root;
}

test('setupは記録を書き、インストールスクリプトを動かさない。npm ciを直接実行すると記録が消え、buildが止まってsetupを案内する', async () => {
  mode = 'ok';
  const root = makeProject();
  const before = requests;

  const setup = await npm(root, ['run', 'setup']);
  assert.equal(setup.status, 0, describe(setup));
  assert.ok(requests > before, '合成のregistryから依存を取得した');
  assert.ok(existsSync(join(root, RECORD)), '記録がある');
  assert.ok(existsSync(join(root, 'node_modules', DEP_NAME, 'index.js')), '依存が入っている');
  assert.equal(existsSync(join(root, 'postinstall-ran')), false, 'インストールスクリプトは動かない');
  const checked = await npm(root, ['run', 'check:install']);
  assert.equal(checked.status, 0, describe(checked));
  const build = await npm(root, ['run', 'build']);
  assert.equal(build.status, 0, describe(build));

  const plainCi = await npm(root, ['ci']);
  assert.equal(plainCi.status, 0, describe(plainCi));
  assert.ok(existsSync(join(root, 'node_modules', DEP_NAME, 'index.js')), 'npm ci自体は成功している');
  assert.equal(existsSync(join(root, RECORD)), false, 'npm ciはnode_modulesを作り直すので、記録は残らない');

  const stopped = await npm(root, ['run', 'build']);
  assert.notEqual(stopped.status, 0, describe(stopped));
  assert.match(stopped.stderr, /ビルドを中止した/);
  assert.match(stopped.stderr, /npm run setup/);
  assert.notEqual((await npm(root, ['run', 'check:install'])).status, 0);

  // setupをやり直せば、また一致する。
  assert.equal((await npm(root, ['run', 'setup'])).status, 0);
  assert.equal((await npm(root, ['run', 'build'])).status, 0);
});

test('npm ciが失敗したとき、前の記録を消し、新しい記録を書かない', async () => {
  mode = 'ok';
  const root = makeProject();
  assert.equal((await npm(root, ['run', 'setup'])).status, 0);
  assert.ok(existsSync(join(root, RECORD)));

  // 依存を取得できない（キャッシュも空）。npm ciはnode_modulesを消してから失敗する。
  mode = 'missing';
  const failed = await npm(root, ['run', 'setup'], `cache-missing-${counter}`);
  mode = 'ok';
  assert.notEqual(failed.status, 0, describe(failed));
  assert.match(failed.stderr, /記録は書いていない/);
  assert.equal(existsSync(join(root, RECORD)), false);
  assert.notEqual((await npm(root, ['run', 'build'])).status, 0);
});

test('npm ciがnode_modulesを消す前に失敗しても（package.jsonとlockfileの不一致）、前の記録は残らない', async () => {
  mode = 'ok';
  const root = makeProject();
  assert.equal((await npm(root, ['run', 'setup'])).status, 0);
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.devDependencies[DEP_NAME] = '2.0.0';
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  const failed = await npm(root, ['run', 'setup']);
  assert.notEqual(failed.status, 0, describe(failed));
  assert.ok(
    existsSync(join(root, 'node_modules', DEP_NAME, 'index.js')),
    'npm ciは古いnode_modulesを残したまま止まった',
  );
  assert.equal(existsSync(join(root, RECORD)), false, 'setupが最初に記録を消している');
});

test('package.jsonの依存の宣言を変えたあと、npm ciを直接実行して失敗しても、古い記録では通らない', async () => {
  mode = 'ok';
  const root = makeProject();
  assert.equal((await npm(root, ['run', 'setup'])).status, 0);
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.devDependencies[DEP_NAME] = '2.0.0';
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  // npm ciはnode_modulesを消す前に失敗するので、前の記録とhidden lockfileは残る。
  const plainCi = await npm(root, ['ci']);
  assert.notEqual(plainCi.status, 0, describe(plainCi));
  assert.ok(existsSync(join(root, RECORD)), '前の記録は残っている');
  const stopped = await npm(root, ['run', 'build']);
  assert.notEqual(stopped.status, 0, describe(stopped));
  assert.match(stopped.stderr, /package\.json が記録と違う/);
  assert.notEqual((await npm(root, ['run', 'check:install'])).status, 0);
});

test('NODE_ENV=productionやomitの設定があっても、setupはdevの依存を入れて記録する', async () => {
  mode = 'ok';
  const root = makeProject();
  const hostile = { NODE_ENV: 'production', npm_config_omit: 'dev', npm_config_install_strategy: 'nested' };
  const plain = await npm(root, ['ci'], `cache-${counter}`, hostile);
  assert.equal(plain.status, 0, describe(plain));
  assert.equal(existsSync(join(root, 'node_modules', DEP_NAME)), false, '設定のままのnpm ciはdevの依存を省く');

  const setup = await npm(root, ['run', 'setup'], `cache-${counter}`, hostile);
  assert.equal(setup.status, 0, describe(setup));
  assert.ok(existsSync(join(root, 'node_modules', DEP_NAME, 'index.js')));
  assert.equal((await npm(root, ['run', 'check:install'])).status, 0);
});

test('setupを途中で止めたとき（Ctrl+C相当）、記録は残らない', async () => {
  mode = 'ok';
  const root = makeProject();
  assert.equal((await npm(root, ['run', 'setup'])).status, 0);
  assert.ok(existsSync(join(root, RECORD)));

  mode = 'hang';
  const before = requests;
  const { child, exited, done } = startNpm(root, ['run', 'setup'], `cache-hang-${counter}`);
  const deadline = Date.now() + 60_000;
  while (requests === before) {
    assert.ok(Date.now() < deadline, 'npm ciが依存の取得を始めなかった');
    await new Promise((r) => setTimeout(r, 50));
  }
  killTree(child, 'SIGINT');
  await exited;
  // setupのプロセスは止まった。POSIXではnpm ciが残っていることがあるので、依存を渡して
  // 最後まで進めさせる。それでも記録は書かれない（記録を書くのはsetupだけ）。
  mode = 'ok';
  for (const res of held.splice(0)) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(tarball);
  }
  const result = await done;
  assert.ok(result.status !== 0 || result.signal !== null, `中断されていない: ${describe(result)}`);

  assert.equal(existsSync(join(root, RECORD)), false);
  const check = await npm(root, ['run', 'check:install']);
  assert.notEqual(check.status, 0);
  assert.match(check.stderr, /npm run setup/);
});

test('setupはnpm run経由でだけ動き、--forceを拒む', async () => {
  mode = 'ok';
  const root = makeProject();
  const direct = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'setup.ts')], {
    cwd: root,
    env: npmEnv('cache-direct'),
    encoding: 'utf8',
  });
  assert.equal(direct.status, 1, direct.stderr);
  assert.match(direct.stderr, /npm run setup/);

  const forced = await npm(root, ['run', 'setup', '--force']);
  assert.notEqual(forced.status, 0, describe(forced));
  assert.match(forced.stderr, /`--force` を付けて実行しない/);
  assert.equal(existsSync(join(root, 'node_modules')), false, 'npm ciを始めていない');
});
