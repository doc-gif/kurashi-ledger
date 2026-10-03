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
import { preventDeletion } from '../tests/support/prevent-deletion.ts';
import { type ConsoleEvent, startInNewConsole } from '../tests/support/windows-console.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const LOCK = '.kurashi-ledger-setup.lock';
let work = '';
let fakeNpm = '';
let counter = 0;

const FAKE_NPM = `const fs = require('node:fs');
const path = require('node:path');
// Ctrl+Cが届いても自分では止まらないnpm（setupの転送を確かめる。Windowsだけで使う）。
if (process.env.FAKE_NPM_IGNORE_CTRL_C === '1') process.on('SIGINT', () => {});
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

// setup.tsに渡す環境変数。合成のnpmをnpm_execpathにする。外側のnpm・NODE_の設定は渡さない。
function setupEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_/i.test(key) && !/^NODE_/i.test(key)) env[key] = value;
  }
  return Object.assign(env, { npm_execpath: fakeNpm, TMPDIR: work, TEMP: work, TMP: work }, extra);
}

// setup.tsを起動する。
function startSetup(root: string, extra: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'setup.ts')], {
    cwd: root,
    env: setupEnv(extra),
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

test('強制終了（SIGKILL・Windowsはプロセスツリーの強制終了）では印が残り、次のsetupは何も変えずに止まり、印を消すと進める', async () => {
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

// ---- 実際のシグナル。POSIXは、killでsetup（かそのプロセスグループ全体）にシグナルを送る。Windowsは、setupを
// 新しいコンソールで起動し、実際のコンソールの制御イベント（Ctrl+C・Ctrl+Break）をそのコンソールの全員に送る
// （tests/support/windows-console.ts。Issue #19）。片付けの処理そのものは、scripts/install-record.test.tsの単体試験でも
// 全OSで確かめている。

type Interrupt = {
  // POSIX: 送るシグナルと、プロセスグループ全体（端末のCtrl+Cと同じ）か、setupだけか。
  readonly posix: { readonly signal: NodeJS.Signals; readonly whole: boolean };
  // Windows: コンソールに送る制御イベントと、合成のnpmがCtrl+Cを無視する（自分では止まらない）か。
  readonly windows: { readonly event: ConsoleEvent; readonly npmIgnoresCtrlC?: boolean };
};

// setupの印と記録があるnpm ciの最中に中断し、結果を返す。beforeInterruptは中断の直前に呼ぶ（戻り値で元に戻す）。
async function interrupt(
  p: ReturnType<typeof makeProject>,
  how: Interrupt,
  beforeInterrupt?: () => () => void,
): Promise<{ result: Run; signal: NodeJS.Signals }> {
  const env = { FAKE_NPM_LOG: p.log, FAKE_NPM_GO: p.go };
  let restore: (() => void) | undefined;
  try {
    if (process.platform === 'win32') {
      const ignores = how.windows.npmIgnoresCtrlC === true;
      const run = startInNewConsole(process.execPath, [join(repoRoot, 'scripts', 'setup.ts')], {
        cwd: p.root,
        env: setupEnv({ ...env, ...(ignores ? { FAKE_NPM_IGNORE_CTRL_C: '1' } : {}) }),
        exchangeParent: work,
      });
      try {
        await run.started;
        await waitFor(() => p.starts() === 1, 'npm ciが始まらない');
        restore = beforeInterrupt?.();
        await run.send(how.windows.event);
        const r = await run.done;
        assert.equal(r.timedOut, false, `時間切れ: ${r.stderr}`);
        return {
          result: { status: r.status, signal: null, stderr: r.stderr },
          signal: how.windows.event === 'ctrl-c' ? 'SIGINT' : 'SIGBREAK',
        };
      } finally {
        run.abort();
      }
    }
    const run = startSetup(p.root, env);
    await waitFor(() => p.starts() === 1, 'npm ciが始まらない');
    restore = beforeInterrupt?.();
    // wholeはCtrl+Cと同じくプロセスグループ全体（合成のnpmにも届く）、そうでなければsetupだけに送る
    // （setupが猶予のあとで合成のnpmへ転送する）。
    const pid = run.child.pid as number;
    process.kill(how.posix.whole ? -pid : pid, how.posix.signal);
    return { result: await run.done, signal: how.posix.signal };
  } finally {
    restore?.();
  }
}

async function interruptAndCheck(how: Interrupt, expectedCode: { readonly posix: number; readonly windows: number }) {
  const p = makeProject();
  const { result, signal } = await interrupt(p, how);
  assert.equal(result.status, process.platform === 'win32' ? expectedCode.windows : expectedCode.posix, result.stderr);
  assert.match(result.stderr, new RegExp(`${signal} を受けたので中断した`));
  assert.equal(existsSync(join(p.root, LOCK)), false, '作業中の印は残らない');
  assert.equal(existsSync(recordPath(p.root)), false, '記録は残らない');
  const log = readFileSync(p.log, 'utf8');
  assert.ok(!log.includes('done'), '合成のnpmは入れ終わる前に止まった');

  writeFileSync(p.go, '');
  const next = await startSetup(p.root, { FAKE_NPM_LOG: p.log, FAKE_NPM_GO: p.go }).done;
  assert.equal(next.status, 0, next.stderr);
  assert.equal(verifyInstallRecord(p.root).ok, true, '次のsetupは止まらずに進める');
}

test('Ctrl+Cがnpm ciを止めなくても（POSIXはsetupだけへのSIGINT、Windowsはnpmが無視するコンソールのCtrl+C）、猶予のあとでnpmへ転送して終了を待ち、記録も印も残さず130で終える', async () => {
  await interruptAndCheck(
    { posix: { signal: 'SIGINT', whole: false }, windows: { event: 'ctrl-c', npmIgnoresCtrlC: true } },
    { posix: 130, windows: 130 },
  );
});

test('Ctrl+C（POSIXはプロセスグループ全体へのSIGINT、Windowsは新しいコンソールへのCtrl+C）で、記録も印も残さず130で終える', async () => {
  await interruptAndCheck({ posix: { signal: 'SIGINT', whole: true }, windows: { event: 'ctrl-c' } }, { posix: 130, windows: 130 });
});

test('ほかの終了のシグナル（POSIXはSIGTERMとSIGHUP、WindowsはCtrl+Break）でも、記録も印も残さず128+番号で終える', async () => {
  // Windowsのsetupが受けるのは、SIGINT（Ctrl+C）とSIGBREAK（Ctrl+Break）だけ（setupSignals）。
  await interruptAndCheck({ posix: { signal: 'SIGTERM', whole: false }, windows: { event: 'ctrl-break' } }, { posix: 143, windows: 149 });
  if (process.platform !== 'win32') {
    await interruptAndCheck({ posix: { signal: 'SIGHUP', whole: true }, windows: { event: 'ctrl-break' } }, { posix: 129, windows: 149 });
  }
});

// 印を消せない状態は tests/support/prevent-deletion.ts で作る。rootのユーザーは書込み禁止のディレクトリからも消せる。
const lockUndeletableSkip =
  process.platform !== 'win32' && process.getuid?.() === 0
    ? 'rootのユーザーは書込み禁止のディレクトリからも消せるので、印の削除の失敗を再現できない。CIは一般のユーザーで実行する（T05）'
    : false;

test('実際のCtrl+Cで中断したときに印を消せなければ、130で終え、印が残ったことと消し方を表示し、印を消すと次のsetupが進む', { skip: lockUndeletableSkip }, async () => {
  const p = makeProject();
  const { result, signal } = await interrupt(p, { posix: { signal: 'SIGINT', whole: true }, windows: { event: 'ctrl-c' } }, () =>
    preventDeletion(p.root, LOCK),
  );
  assert.equal(result.status, 130, result.stderr);
  assert.match(result.stderr, new RegExp(`${signal} を受けたので中断した。依存の導入の記録は残していない。`));
  assert.match(result.stderr, /印（\.kurashi-ledger-setup\.lock）を消せなかった/);
  assert.match(result.stderr, /rm \.kurashi-ledger-setup\.lock/);
  assert.match(result.stderr, /Remove-Item \.kurashi-ledger-setup\.lock/);
  assert.equal(existsSync(join(p.root, LOCK)), true, '印は残る');
  assert.equal(existsSync(recordPath(p.root)), false, '記録は残らない');

  writeFileSync(p.go, '');
  const refused = await startSetup(p.root, { FAKE_NPM_LOG: p.log, FAKE_NPM_GO: p.go }).done;
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /前の `npm run setup` が強制終了/);
  assert.equal(p.starts(), 1, '止まったsetupはnpm ciを始めない');

  rmSync(join(p.root, LOCK));
  const resumed = await startSetup(p.root, { FAKE_NPM_LOG: p.log, FAKE_NPM_GO: p.go }).done;
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(verifyInstallRecord(p.root).ok, true);
});
