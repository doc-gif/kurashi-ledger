// npm start（T26の段階）の起動と終了（ADR-0002の「起動と終了」、ADR-0003、ADR-0009）。
// 子プロセスで`node src/start.ts`を起動して確かめる。実際のシグナルでの終了はPOSIXだけで確かめ、Windowsでは
// 同じ終了の処理をプロセスの中から呼ぶ試験で確かめる（docs/development.mdの「環境によって飛ばす試験」）。
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { createServer as createNetServer, connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ownerOnlyTempDirectory, sameOriginHeaders, send } from '../tests/support/http.ts';
import { startApp, type StartIo } from './start.ts';

const START = fileURLToPath(new URL('./start.ts', import.meta.url));
const REPOSITORY_ROOT = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));

type Started = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly port: number;
  readonly launchFile: string;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function run(args: readonly string[]): { child: ChildProcessWithoutNullStreams; output(): string; exited: Started['exited'] } {
  const child = spawn(process.execPath, [START, ...args], { stdio: 'pipe', windowsHide: true });
  child.stdin.end();
  let text = '';
  child.stdout.setEncoding('utf8').on('data', (c: string) => (text += c));
  child.stderr.setEncoding('utf8').on('data', (c: string) => (text += c));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, output: () => text, exited };
}

async function startServerProcess(tokenDir: string): Promise<Started> {
  const r = run(['--token-dir', tokenDir, '--port', '0', '--no-open']);
  const deadline = Date.now() + 60_000;
  while (!r.output().includes('終了するには Ctrl+C を押す。')) {
    if (r.child.exitCode !== null || Date.now() > deadline) throw new Error(`npm startが起動しなかった:\n${r.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const port = Number(/待ち受け: http:\/\/127\.0\.0\.1:(\d+)\//.exec(r.output())?.[1]);
  const fileUrl = /起動用のファイル（[^）]*）: (file:\S+)/.exec(r.output())?.[1] ?? '';
  return { ...r, port, launchFile: fileURLToPath(fileUrl) };
}

function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

test('npm startは--token-dirがない・ポートが不正・知らない引数のとき、起動せずに使い方を表示して2で終わる', async () => {
  for (const args of [[], ['--token-dir', ''], ['--token-dir', '.', '--port', '70000'], ['--token-dir', '.', '--port', '-1'], ['--unknown']]) {
    const r = run(args);
    const { code } = await r.exited;
    assert.equal(code, 2, `${args.join(' ')}\n${r.output()}`);
    assert.match(r.output(), /使い方: npm start -- --token-dir/);
  }
});

test('npm startは127.0.0.1で待ち受け、端末でない出力にトークンを出さず、一時ファイルのURLだけを表示する', async () => {
  const tmp = ownerOnlyTempDirectory('start');
  let started: Started | undefined;
  try {
    started = await startServerProcess(tmp.path);
    assert.equal(existsSync(started.launchFile), true);
    const content = readFileSync(started.launchFile, 'utf8');
    const token = /launch#([A-Za-z0-9_-]{43})/.exec(content)?.[1] ?? '';
    assert.notEqual(token, '');
    assert.equal(started.output().includes(token), false);
    assert.equal(started.output().includes('launch#'), false);
    // 交換用のページの識別子を読み、トークンを交換する。
    const page = await send(started.port, { path: '/launch' });
    const launchId = /name="kurashi-ledger-launch-id" content="([^"]+)"/.exec(page.text)?.[1] ?? '';
    const origin = `http://127.0.0.1:${started.port}`;
    const fake = { origin, launchId, port: started.port } as Parameters<typeof sameOriginHeaders>[0];
    const res = await send(started.port, {
      method: 'POST',
      path: '/api/session',
      headers: sameOriginHeaders(fake, { 'content-type': 'application/json' }),
      body: JSON.stringify({ token }),
    });
    assert.equal(res.status, 204);
    assert.equal(existsSync(started.launchFile), false);
    assert.equal((await send(started.port, { path: '/' })).text.includes('画面（UI）はまだありません'), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(started.output().includes(token), false);
    assert.match(started.output(), /\[http\] POST \/api\/session 204/);
  } finally {
    started?.child.kill();
    await started?.exited;
    tmp.cleanup();
  }
});

test('実際のSIGINT・SIGTERMで、待受を止め、一時ファイルを消して0で終わる', { skip: process.platform === 'win32' ? 'Windowsでは試験から実際のCtrl+C（コンソールの制御イベント）を送れない（killは強制終了になる）。同じ終了の処理はプロセスの中から呼ぶ試験で確かめ、実機のCtrl+CはT13で確かめる' : false }, async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const tmp = ownerOnlyTempDirectory('signal');
    try {
      const started = await startServerProcess(tmp.path);
      assert.equal(existsSync(started.launchFile), true);
      started.child.kill(signal);
      const { code } = await started.exited;
      assert.equal(code, 0, started.output());
      assert.match(started.output(), new RegExp(`終了する（${signal}）。`));
      assert.match(started.output(), /終了した。/);
      assert.equal(existsSync(started.launchFile), false);
      assert.deepEqual(readdirSync(tmp.path), []);
      assert.equal(await refused(started.port), true);
    } finally {
      tmp.cleanup();
    }
  }
});

test('ポートが使用中なら、npm startは別のポートへ移らずに理由を表示して1で終わり、一時ファイルを作らない', async () => {
  const blocker = createNetServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
  const port = (blocker.address() as { port: number }).port;
  const tmp = ownerOnlyTempDirectory('start-inuse');
  try {
    const r = run(['--token-dir', tmp.path, '--port', String(port), '--no-open']);
    const { code } = await r.exited;
    assert.equal(code, 1, r.output());
    assert.match(r.output(), new RegExp(`ポート${port}は使用中なので起動しない`));
    assert.equal(r.output().includes('待ち受け:'), false);
    assert.deepEqual(readdirSync(tmp.path), []);
  } finally {
    blocker.close();
    tmp.cleanup();
  }
});

test('--token-dirが、ない・リンク・本人専用でない・repoの中のときは、npm startは何も作らずに1で終わる', async () => {
  const tmp = ownerOnlyTempDirectory('start-bad');
  try {
    const link = join(tmp.path, 'link');
    const target = join(tmp.path, 'target');
    mkdirSync(target);
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const cases: Array<[string, RegExp]> = [
      [join(tmp.path, 'missing'), /がない（作らない）/],
      [link, /リンク/],
      [join(REPOSITORY_ROOT, 'src'), /repoの中にある/],
    ];
    if (process.platform !== 'win32') {
      const broad = join(tmp.path, 'broad');
      mkdirSync(broad, { mode: 0o755 });
      cases.push([broad, /本人だけの権限でない/]);
    }
    for (const [dir, message] of cases) {
      const r = run(['--token-dir', dir, '--port', '0', '--no-open']);
      const { code } = await r.exited;
      assert.equal(code, 1, `${dir}\n${r.output()}`);
      assert.match(r.output(), message);
    }
    assert.equal(existsSync(join(tmp.path, 'missing')), false);
    assert.deepEqual(readdirSync(target), []);
  } finally {
    tmp.cleanup();
  }
});

test('終了の処理（Ctrl+C等のシグナルで呼ぶもの）は、待受を止めて一時ファイルを消す。端末にはトークン付きURLを表示する', async () => {
  const tmp = ownerOnlyTempDirectory('start-inproc');
  const lines: string[] = [];
  const opened: string[] = [];
  const io: StartIo = {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    isTerminal: true,
    openInBrowser: (path) => opened.push(path),
    repositoryRoot: REPOSITORY_ROOT,
  };
  try {
    const result = await startApp(['--token-dir', tmp.path, '--port', '0'], io);
    assert.equal(result.kind, 'running');
    if (result.kind !== 'running') return;
    const { server } = result.app;
    // 端末には1回だけ使えるURLを表示する。ブラウザにはファイルのパスだけを渡す。
    assert.ok(lines.some((line) => line.includes(server.tokenUrl)));
    assert.deepEqual(opened, [server.launchFile]);
    assert.equal(opened[0]?.includes('#'), false);
    assert.equal(existsSync(server.launchFile), true);
    const first = result.app.stop('SIGINT');
    const second = result.app.stop('SIGBREAK');
    await Promise.all([first, second]);
    assert.equal(lines.filter((line) => line.startsWith('終了する（')).length, 1);
    assert.equal(existsSync(server.launchFile), false);
    assert.equal(await refused(server.port), true);
  } finally {
    tmp.cleanup();
  }
});
