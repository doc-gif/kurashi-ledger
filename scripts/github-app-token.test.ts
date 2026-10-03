// scripts/github-app-token.ts と scripts/lib/github-app-token.ts の試験（docs/github-apps.md）。
// 鍵は試験の中で生成したRSA鍵だけを使う。ネットワーク・キーチェーンは使わない（fetch・キーチェーン・子プロセスは注入する）。
// 秘密の番兵（トークン等）は、公開検査の型に当たらないよう、実行時に組み立てる。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  API_ORIGIN,
  API_VERSION,
  EXIT_CANNOT_EXECUTE,
  EXIT_NOT_FOUND,
  EXIT_OWN_FAILURE,
  GIT_CREDENTIAL_HELPER,
  JWT_BACKDATE_SECONDS,
  JWT_LIFETIME_SECONDS,
  KEYCHAIN_TIMEOUT_MS,
  KEYCHAIN_TOOL,
  MAX_KEY_BYTES,
  PURPOSES,
  PUSH_URL,
  REPOSITORY_NAME,
  TOKEN_PATTERN,
  TokenError,
  UNUSED_GIT_GLOBAL_CONFIG,
  UsageError,
  childEnvironment,
  createAppJwt,
  exitCodeOf,
  isExecutableFile,
  keyFileProblem,
  loadPrivateKey,
  parseArgs,
  pemFromKeyMaterial,
  readKeyFileFromDisk,
  readKeyFromStream,
  readKeychainKey,
  resolveCommand,
  run,
  sanitize,
  spawnChild,
  tokenRequest,
  type ChildResult,
  type Deps,
  type ExecFileLike,
  type FetchInit,
  type FetchLike,
  type KeyStream,
  type Purpose,
} from './lib/github-app-token.ts';

const SCRIPT = join(import.meta.dirname, 'github-app-token.ts');
const NOW = 1_900_000_000;
const APP_ID = '123456';
const INSTALLATION_ID = '7654321';
const CONFIG_DIR = '/synthetic/kl-gh-config-1';

// 合成の鍵（試験の中だけ）。
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PEM_BASE64 = Buffer.from(PEM, 'utf8').toString('base64');
const PEM_BODY_LINES = PEM.split('\n').filter((line) => line.length >= 16 && !line.startsWith('-----'));

// 番兵のトークン。GitHubのinstallation tokenと同じ形（ghs_と英数字）。
const TOKEN = ['ghs', 'SENTINEL0TOKEN0VALUE0FOR0TESTS0ONLY0x9'].join('_');
// 数字を含まない番兵（長い英数字の並びを伏せる処理では伏せられない。既知の秘密として伏せる必要がある）。
const DIGITLESS_TOKEN = ['ghs', 'X'.repeat(36)].join('_');
// stateless の形（ghs_<App ID>_<JWT>。2026-04-27からGitHubが段階導入）の合成の番兵。
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const STATELESS_TOKEN = ['ghs', APP_ID, `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sentinel: 'stateless-installation-token', iat: NOW })}.${Buffer.alloc(256, 7).toString('base64url')}`].join('_');

function decodeSegment(segment: string | undefined): unknown {
  assert.ok(segment !== undefined);
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function grantedBody(purpose: Purpose, overrides: Record<string, unknown> = {}, token: string = TOKEN): string {
  return JSON.stringify({
    token,
    expires_at: '2030-03-17T12:00:00Z',
    permissions: { ...PURPOSES[purpose], metadata: 'read' },
    repository_selection: 'selected',
    repositories: [{ id: 1, name: REPOSITORY_NAME }],
    ...overrides,
  });
}

// 発行したトークンで触れるrepoの一覧（GET /installation/repositories）の応答。
const LISTED = { status: 200, body: JSON.stringify({ total_count: 1, repositories: [{ id: 1, name: REPOSITORY_NAME }] }) };
const REVOKED = { status: 204, body: '' };

type Call = { readonly url: string; readonly init: FetchInit };
type Reply = { readonly status: number; readonly body: string } | ((url: string, init: FetchInit) => Promise<{ status: number; text(): Promise<string> }>);

// 要求と子の起動の順を1つの列に記録する。
function harness(
  replies: readonly Reply[],
  overrides: Partial<Deps> = {},
  child: ChildResult | ((kill: (signal: NodeJS.Signals) => void) => Promise<ChildResult>) = { kind: 'exited', code: 0, signal: null },
) {
  const events: string[] = [];
  const calls: Call[] = [];
  const err: string[] = [];
  const keychainCalls: string[][] = [];
  const children: { command: readonly string[]; env: Record<string, string>; stdin: string }[] = [];
  const removed: string[] = [];
  const killed: NodeJS.Signals[] = [];
  const signalHandlers: ((signal: NodeJS.Signals) => void)[] = [];
  let unregistered = 0;
  let usernameCalls = 0;
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    events.push(`${init.method} ${url.replace(API_ORIGIN, '')}`);
    const r = replies[i++];
    assert.ok(r !== undefined, `想定より多い要求: ${init.method} ${url}`);
    if (typeof r === 'function') return r(url, init);
    return { status: r.status, text: async () => r.body };
  };
  const deps: Deps = {
    env: { PATH: '/usr/bin', HOME: '/synthetic/home' },
    platform: 'darwin',
    uid: 501,
    username: () => {
      usernameCalls++;
      return 'synthetic-user';
    },
    nowSeconds: () => NOW,
    fetch,
    readKeychain: async (service, account) => {
      keychainCalls.push([service, account]);
      return `${PEM_BASE64}\n`;
    },
    readKeyFile: () => {
      throw new Error('鍵ファイルは使わない');
    },
    readStdin: async () => {
      throw new Error('標準入力は使わない');
    },
    resolveCommand: (program) => {
      events.push(`resolve ${program}`);
      return program === 'no-such-command' ? null : `/synthetic/bin/${program}`;
    },
    makeConfigDir: () => {
      events.push('mkdir');
      return CONFIG_DIR;
    },
    removeConfigDir: (path) => {
      events.push('rmdir');
      removed.push(path);
    },
    runChild: (command, env, stdin) => {
      events.push('child');
      children.push({ command, env, stdin });
      const kill = (signal: NodeJS.Signals): void => {
        events.push(`kill ${signal}`);
        killed.push(signal);
      };
      return { result: typeof child === 'function' ? child(kill) : Promise.resolve(child), kill };
    },
    onSignals: (handler) => {
      signalHandlers.push(handler);
      return () => {
        unregistered++;
      };
    },
    stderr: (text) => err.push(text),
    ...overrides,
  };
  const fire = (signal: NodeJS.Signals): void => {
    events.push(`signal ${signal}`);
    for (const h of signalHandlers) h(signal);
  };
  return {
    deps,
    events,
    calls,
    err,
    keychainCalls,
    children,
    removed,
    killed,
    fire,
    usernameCalls: () => usernameCalls,
    unregistered: () => unregistered,
    registered: () => signalHandlers.length,
  };
}

function assertNoSecrets(text: string, extra: readonly string[] = []): void {
  for (const secret of [TOKEN, DIGITLESS_TOKEN, STATELESS_TOKEN, PEM, PEM_BASE64, ...PEM_BODY_LINES, ...extra]) {
    assert.ok(!text.includes(secret), `出力に秘密が含まれる（長さ${secret.length}）`);
  }
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}\./, 'JWTらしい文字列が出力にある');
}

const ID_ARGS = ['--app-id', APP_ID, '--installation-id', INSTALLATION_ID];
const ARGS = ['--agent', 'codex', '--purpose', 'review', ...ID_ARGS, '--', 'gh', 'pr', 'view', '1'];

test('JWTのheaderとclaims（iat=now-60、exp=now+9分、iss=AppのID）と、生成した公開鍵で署名を検証できること', () => {
  const jwt = createAppJwt(APP_ID, loadPrivateKey(PEM), NOW);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(decodeSegment(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decodeSegment(p), { iat: NOW - 60, exp: NOW + 540, iss: APP_ID });
  assert.equal(JWT_BACKDATE_SECONDS, 60);
  assert.equal(JWT_LIFETIME_SECONDS, 540);
  assert.ok(s !== undefined && s.length > 0);
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')), 'RS256の署名が検証できない');
  const other: KeyObject = createPublicKey(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey);
  assert.ok(!verify('sha256', Buffer.from(`${h}.${p}`), other, Buffer.from(s, 'base64url')), '別の鍵で検証できてしまう');
});

test('RSAでない鍵と、PEMでない材料を拒み、中身をエラーに出さない', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => loadPrivateKey(ec), TokenError);
  const garbage = 'SENTINEL-NOT-A-KEY-0123456789abcdefghijklmnop';
  assert.throws(() => pemFromKeyMaterial(garbage), (e: unknown) => e instanceof TokenError && !e.message.includes(garbage));
  assert.equal(pemFromKeyMaterial(`  ${PEM_BASE64}\n`), PEM.trim());
  assert.equal(pemFromKeyMaterial(PEM), PEM.trim());
});

test('要求のURL・header・bodyが、用途ごとに縮小した権限とこのrepoだけを求める', () => {
  const r = tokenRequest(INSTALLATION_ID, 'JWT.SENTINEL.VALUE', 'review');
  assert.equal(r.url, `${API_ORIGIN}/app/installations/${INSTALLATION_ID}/access_tokens`);
  assert.equal(API_ORIGIN, 'https://api.github.com');
  assert.equal(r.method, 'POST');
  assert.deepEqual(r.headers, {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer JWT.SENTINEL.VALUE',
    'Content-Type': 'application/json',
    'User-Agent': 'kurashi-ledger-github-app-token',
    'X-GitHub-Api-Version': API_VERSION,
  });
  const body = (purpose: Purpose) => JSON.parse(tokenRequest(INSTALLATION_ID, 'x', purpose).body);
  const ci = { actions: 'read', checks: 'read', statuses: 'read' };
  assert.deepEqual(body('review'), { repositories: ['kurashi-ledger'], permissions: { pull_requests: 'write', contents: 'read', ...ci } });
  const implement = { contents: 'write', pull_requests: 'write', issues: 'write', ...ci };
  assert.deepEqual(body('implement'), { repositories: ['kurashi-ledger'], permissions: implement });
  // workflowsは、必要なときだけ別の用途で付ける（2026-10-03の所有者決定）。
  assert.deepEqual(body('implement-workflows'), { repositories: ['kurashi-ledger'], permissions: { ...implement, workflows: 'write' } });
  for (const purpose of ['review', 'implement', 'implement-workflows'] as const) {
    assert.ok(!Object.hasOwn(PURPOSES[purpose], 'administration'), `${purpose}にadministrationがある`);
  }
  assert.ok(!Object.hasOwn(PURPOSES.implement, 'workflows'));
  assert.ok(!Object.hasOwn(PURPOSES.review, 'issues'));
});

test('AIごとのキーチェーンのserviceと環境変数を使い、--agent・--purpose・`--`のあとのコマンドを必須にする', () => {
  const env = {
    KL_GITHUB_APP_ID_CODEX: '11',
    KL_GITHUB_APP_INSTALLATION_ID_CODEX: '12',
    KL_GITHUB_APP_ID_CLAUDE: '21',
    KL_GITHUB_APP_INSTALLATION_ID_CLAUDE: '22',
  };
  assert.deepEqual(parseArgs(['--agent', 'codex', '--purpose', 'review', '--', 'gh', 'pr', 'view', '1'], env), {
    help: false,
    options: {
      agent: 'codex',
      purpose: 'review',
      appId: '11',
      installationId: '12',
      key: { kind: 'keychain', service: 'kurashi-ledger-codex-reviewer' },
      command: ['gh', 'pr', 'view', '1'],
    },
  });
  // どちらのAIもどの用途にも使える。serviceの名前は所有者が登録した昔の呼び名のまま。
  const claude = parseArgs(['--agent', 'claude', '--purpose', 'implement-workflows', '--', 'git', 'push'], env);
  assert.ok(!claude.help);
  assert.equal(claude.options.key.kind === 'keychain' && claude.options.key.service, 'kurashi-ledger-claude-implementer');
  assert.equal(claude.options.appId, '21');
  // `--`のあとは、このスクリプトの引数として読まない。
  const passthrough = parseArgs(['--agent', 'codex', '--purpose', 'review', '--', 'gh', '--agent', 'x', '--help'], env);
  assert.ok(!passthrough.help);
  assert.deepEqual(passthrough.options.command, ['gh', '--agent', 'x', '--help']);
  // 引数は環境変数より優先する。
  const flagged = parseArgs(['--agent', 'codex', '--purpose', 'review', '--app-id', '31', '--installation-id', '32', '--key-file', 'k.pem', '--', 'true'], env);
  assert.ok(!flagged.help);
  assert.deepEqual([flagged.options.appId, flagged.options.installationId, flagged.options.key], ['31', '32', { kind: 'file', path: 'k.pem' }]);
  assert.deepEqual(parseArgs(['--help'], {}), { help: true });
  for (const bad of [
    [],
    ['--agent', 'codex', '--purpose', 'review'],
    ['--agent', 'codex', '--purpose', 'review', '--'],
    ['--agent', 'codex', '--purpose', 'review', '--', ''],
    ['--agent', 'codex', '--', 'true'],
    ['--purpose', 'review', '--', 'true'],
    ['--agent', 'copilot', '--purpose', 'review', '--', 'true'],
    ['--agent', 'codex', '--purpose', 'admin', '--', 'true'],
    ['--agent', 'codex', '--purpose', 'review', '--key-file', 'a', '--key-stdin', '--', 'true'],
    ['--agent', 'codex', '--agent', 'codex', '--purpose', 'review', '--', 'true'],
    ['--agent', 'codex', '--purpose', 'review', '--keychain-service', 'bad name;rm', '--', 'true'],
    ['--agent', 'codex', '--purpose', 'review', 'gh', 'pr', 'view'],
  ]) {
    assert.throws(() => parseArgs(bad, env), UsageError, JSON.stringify(bad));
  }
  // AIの環境変数を取り違えない（codexでclaudeの環境変数を読まない）。
  assert.throws(() => parseArgs(['--agent', 'codex', '--purpose', 'review', '--', 'true'], { KL_GITHUB_APP_ID_CLAUDE: '21', KL_GITHUB_APP_INSTALLATION_ID_CLAUDE: '22' }), UsageError);
});

test('IDは数字だけを受け付け、拒んだ値をエラーに出さない', () => {
  for (const bad of ['', '0', '012', '12a', '-1', '1e3', ' 12', '12 ', '１２', '1'.repeat(20), '12/../x']) {
    assert.throws(
      () => parseArgs(['--agent', 'codex', '--purpose', 'review', '--app-id', bad, '--installation-id', '5', '--', 'true'], {}),
      (e: unknown) => e instanceof UsageError && (bad.length < 3 || !e.message.includes(bad)),
      `受け付けてしまう: ${JSON.stringify(bad)}`,
    );
    assert.throws(() => parseArgs(['--agent', 'codex', '--purpose', 'review', '--app-id', '5', '--installation-id', bad, '--', 'true'], {}), UsageError);
  }
  assert.throws(() => tokenRequest('5/../../user', 'x', 'review'), UsageError);
});

test('鍵ファイルは、symlink・置き換え・大きすぎるもの・所有者以外も読める権限・別の所有者を拒む', () => {
  const file = { isFile: () => true, isSymbolicLink: () => false, mode: 0o100600, uid: 501, dev: 1, ino: 2, size: 1700 };
  assert.equal(keyFileProblem(file, file, 'darwin', 501), null);
  assert.equal(keyFileProblem(file, file, 'linux', 501), null);
  const link = { ...file, isFile: () => false, isSymbolicLink: () => true };
  assert.match(keyFileProblem(link, file, 'darwin', 501) ?? '', /symlink/);
  assert.match(keyFileProblem(link, file, 'win32', undefined) ?? '', /symlink/);
  assert.match(keyFileProblem(file, { ...file, ino: 3 }, 'darwin', 501) ?? '', /置き換わった/);
  assert.match(keyFileProblem(file, { ...file, isFile: () => false }, 'darwin', 501) ?? '', /置き換わった/);
  assert.match(keyFileProblem(file, { ...file, size: MAX_KEY_BYTES + 1 }, 'darwin', 501) ?? '', /大きすぎる/);
  for (const mode of [0o100640, 0o100604, 0o100644, 0o100660, 0o100700 | 0o001]) {
    assert.match(keyFileProblem(file, { ...file, mode }, 'darwin', 501) ?? '', /chmod 600/, mode.toString(8));
  }
  assert.match(keyFileProblem(file, { ...file, uid: 0 }, 'linux', 501) ?? '', /所有者/);
  // Windowsは権限のビットを確かめない（docs/github-apps.md）。
  assert.equal(keyFileProblem(file, { ...file, mode: 0o100666 }, 'win32', undefined), null);
});

test('実際のファイルで: 権限600の鍵ファイルは読め、644はmacOS・Linuxで拒み（Windowsは警告を出して読む）、ディレクトリを拒む', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kl-app-token-'));
  try {
    const path = join(dir, 'synthetic-key.pem');
    writeFileSync(path, PEM, { mode: 0o600 });
    chmodSync(path, 0o600);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    assert.equal(readKeyFileFromDisk(path, process.platform, uid).text, PEM);
    chmodSync(path, 0o644);
    if (process.platform === 'win32') {
      const r = readKeyFileFromDisk(path, process.platform, uid);
      assert.equal(r.text, PEM);
      assert.match(r.warning ?? '', /ACL/);
    } else {
      assert.throws(() => readKeyFileFromDisk(path, process.platform, uid), (e: unknown) => {
        assert.ok(e instanceof TokenError);
        assert.match(e.message, /chmod 600/);
        assertNoSecrets(e.message);
        return true;
      });
    }
    const sub = join(dir, 'a-directory.pem');
    mkdirSync(sub);
    assert.throws(() => readKeyFileFromDisk(sub, process.platform, uid), /通常のファイルでない/);
    assert.throws(() => readKeyFileFromDisk(join(dir, 'missing.pem'), process.platform, uid), TokenError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// WindowsにはFIFOがなく、ファイルのsymlinkの作成に権限が要る（docs/development.mdの「環境によって飛ばす試験」）。
const posixOnly = process.platform === 'win32' ? 'WindowsにはFIFOがなく、ファイルのsymlinkの作成に権限が要る' : false;
// Node.jsは、Windowsでほかのプロセスへシグナル（Ctrl+C等）を送れない（kill は強制終了になる）。
const posixSignalsOnly = process.platform === 'win32' ? 'Windowsでは、ほかのプロセスへシグナルを送れない（killは強制終了になる）' : false;
// FIFOを開く処理が止まると、試験のプロセスごと止まる。そのため、FIFOに触れる確認は別のプロセスで行い、時間の上限を置く。
const FIFO_TIMEOUT_MS = 20_000;
test('実際のファイルで: 鍵ファイルへのsymlinkとFIFOを、開く前に拒む（FIFOで止まらない）', { skip: posixOnly }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kl-app-token-'));
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const target = join(dir, 'synthetic-key.pem');
    writeFileSync(target, PEM, { mode: 0o600 });
    const link = join(dir, 'link.pem');
    symlinkSync(target, link);
    assert.throws(() => readKeyFileFromDisk(link, process.platform, uid), /通常のファイルでない/);
    const fifo = join(dir, 'fifo.pem');
    const made = spawnSync('mkfifo', ['-m', '600', fifo]);
    assert.equal(made.status, 0, 'mkfifoを実行できない');
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(NODE_|KL_GITHUB_APP_)/i.test(k)) env[k] = v;
    // 1. 実際のスクリプトに、書く側のいないFIFOを渡す。開く前に拒み、時間内に、何も出力せずに終わる。
    const marker = join(dir, 'child-ran');
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--agent', 'codex', '--purpose', 'review', '--app-id', '1', '--installation-id', '1', '--key-file', fifo, '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`],
      { env, encoding: 'utf8', timeout: FIFO_TIMEOUT_MS },
    );
    assert.equal(r.error, undefined, 'FIFOで止まった（時間切れ）');
    assert.equal(r.status, EXIT_OWN_FAILURE, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /通常のファイルでない/);
    assert.throws(() => rmSync(marker), 'コマンドが実行された');
    // 2. 確かめた（lstat）あとでFIFOに差し替えられた場合を、lstatを差し替えて再現する。開くところで止まらず（O_NONBLOCK）、
    //    開いた後の確認で拒む。
    const lib = pathToFileURL(join(import.meta.dirname, 'lib', 'github-app-token.ts')).href;
    const source = [
      `const { readKeyFileFromDisk } = await import(${JSON.stringify(lib)});`,
      "const { lstatSync } = await import('node:fs');",
      `const regular = lstatSync(${JSON.stringify(target)});`,
      'try {',
      `  readKeyFileFromDisk(${JSON.stringify(fifo)}, process.platform, process.getuid(), () => regular);`,
      '  process.exit(3);',
      '} catch (e) {',
      "  process.stdout.write(String(e.message));",
      '  process.exit(/置き換わった/.test(String(e.message)) ? 0 : 4);',
      '}',
    ].join('\n');
    const swapped = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8', timeout: FIFO_TIMEOUT_MS });
    assert.equal(swapped.error, undefined, '差し替えたFIFOで止まった（時間切れ）');
    assert.equal(swapped.status, 0, `${swapped.stdout}${swapped.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('キーチェーンは/usr/bin/securityを決めた引数で呼び、失敗（項目なし・時間切れ・大きすぎる）の出力を表示しない。macOS以外では使わない', async () => {
  const calls: { file: string; args: readonly string[]; options: object }[] = [];
  const ok: ExecFileLike = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: `${PEM_BASE64}\n` };
  };
  assert.equal(await readKeychainKey('kurashi-ledger-codex-reviewer', 'synthetic-user', 'darwin', ok), `${PEM_BASE64}\n`);
  assert.equal(KEYCHAIN_TOOL, '/usr/bin/security');
  assert.equal(calls[0]?.file, '/usr/bin/security');
  assert.deepEqual(calls[0]?.args, ['find-generic-password', '-s', 'kurashi-ledger-codex-reviewer', '-a', 'synthetic-user', '-w']);
  assert.ok(!('shell' in (calls[0]?.options ?? {})), 'シェルを使う設定がある');
  assert.equal((calls[0]?.options as { timeout?: number }).timeout, KEYCHAIN_TIMEOUT_MS);
  assert.equal((calls[0]?.options as { maxBuffer?: number }).maxBuffer, MAX_KEY_BYTES * 2);

  const sentinel = 'SENTINEL-STDERR-FROM-SECURITY-0123456789';
  const failing = (extra: object): ExecFileLike => async () => {
    throw Object.assign(new Error(`Command failed: ${sentinel}`), { stderr: sentinel, ...extra });
  };
  const cases: [object, RegExp][] = [
    [{ code: 44 }, /項目がない/],
    [{ code: 51 }, /終了コード 51/],
    [{ killed: true, signal: 'SIGTERM', code: null }, /時間切れ/],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, /大きすぎる/],
  ];
  for (const [extra, expected] of cases) {
    await assert.rejects(readKeychainKey('kurashi-ledger-codex-reviewer', 'u', 'darwin', failing(extra)), (e: unknown) => {
      assert.ok(e instanceof TokenError);
      assert.match(e.message, expected);
      assert.ok(!e.message.includes(sentinel));
      return true;
    });
  }
  await assert.rejects(readKeychainKey('s', 'u', 'linux', ok), TokenError);
  await assert.rejects(readKeychainKey('s', 'u', 'win32', ok), TokenError);
  assert.equal(calls.length, 1);
});

test('標準入力の鍵: 端末を拒み、16KiBを超えたら止め、時間切れで読むのをやめる', async () => {
  const from = (chunks: (string | Buffer)[], extra: Partial<KeyStream> = {}): KeyStream => ({
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
    ...extra,
  });
  assert.equal(await readKeyFromStream(from([PEM.slice(0, 100), Buffer.from(PEM.slice(100))])), PEM);
  await assert.rejects(readKeyFromStream(from([PEM], { isTTY: true })), /端末からは読まない/);
  await assert.rejects(readKeyFromStream(from([Buffer.alloc(MAX_KEY_BYTES, 0x41), 'x'])), /大きすぎる/);
  assert.equal((await readKeyFromStream(from([Buffer.alloc(MAX_KEY_BYTES, 0x41)]))).length, MAX_KEY_BYTES);
  let destroyed = false;
  const never: KeyStream = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<string>>(() => undefined) }),
    destroy: () => {
      destroyed = true;
    },
  };
  await assert.rejects(readKeyFromStream(never, 30), /秒以内に読み終えなかった/);
  assert.ok(destroyed, '時間切れのあとで標準入力を閉じていない');
});

test('子の環境: Appのトークンだけを渡し、ghとgitが保存済みの資格情報・.netrc・SSH・trace・利用者とrepoの設定に戻らない', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/synthetic/home',
    LANG: 'C',
    GITHUB_TOKEN: 'parent-github-token',
    GH_TOKEN: 'parent-gh-token',
    GH_ENTERPRISE_TOKEN: 'x',
    github_enterprise_token: 'x',
    GH_HOST: 'example.test',
    GH_CONFIG_DIR: '/synthetic/home/.config/gh',
    GH_DEBUG: 'api',
    GIT_ASKPASS: '/x',
    SSH_ASKPASS: '/x',
    GIT_SSH: '/x',
    GIT_SSH_COMMAND: 'ssh -i x',
    GIT_CONFIG_PARAMETERS: "'url.ssh://github.com/.insteadof'='https://github.com/'",
    GIT_CONFIG_COUNT: '9',
    GIT_CONFIG_KEY_8: 'x',
    GIT_TRACE: '1',
    GIT_TRACE_CURL: '1',
    GIT_TRACE_PACKET: '/tmp/x',
    GIT_TRACE_REDACT: '0',
    GIT_CURL_VERBOSE: '1',
    GCM_PROVIDER: 'x',
    NODE_OPTIONS: '--require x',
    KL_GITHUB_APP_ID_CODEX: '1',
    UNDEFINED: undefined,
  };
  const env = childEnvironment(parent, TOKEN, CONFIG_DIR);
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    LANG: 'C',
    HOME: CONFIG_DIR,
    GH_TOKEN: TOKEN,
    GH_CONFIG_DIR: CONFIG_DIR,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(CONFIG_DIR, UNUSED_GIT_GLOBAL_CONFIG),
    GIT_SSH_COMMAND: 'false',
    GIT_TRACE_REDACT: '1',
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: GIT_CREDENTIAL_HELPER,
    GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: `http.${PUSH_URL}.extraheader`,
    GIT_CONFIG_VALUE_3: '',
    GIT_CONFIG_KEY_4: 'core.askPass',
    GIT_CONFIG_VALUE_4: '',
  });
  assert.equal(PUSH_URL, 'https://github.com/doc-gif/kurashi-ledger.git');
  // helperはトークンの値を含まず、子の環境のGH_TOKENを読む。
  assert.ok(!GIT_CREDENTIAL_HELPER.includes(TOKEN));
  assert.match(GIT_CREDENTIAL_HELPER, /\$GH_TOKEN"/);
});

// 子の環境で実際のgitを動かす。cwdのrepoの設定（.git/config）も読まれる。
function gitIn(cwd: string, env: Record<string, string>, args: string[], input?: string) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 20_000, ...(input === undefined ? {} : { input }) });
}

test('子の環境の実際のgit: github.comにだけAppのトークンを返し、利用者とrepoの設定のhelper・extraheader・askPassを使わない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kl-app-token-'));
  try {
    const home = join(dir, 'home');
    mkdirSync(home);
    // 利用者の設定（HOMEの.gitconfig）に、保存済みの資格情報を返すhelperがあっても使わない。
    writeFileSync(join(home, '.gitconfig'), '[credential]\n\thelper = "!f() { echo username=stored-user; echo password=stored-secret; }; f"\n');
    // repoの設定（PRのcheckoutや他人のworktreeにありうる）に、helper・URLごとのhelper・extraheader・askPassを置く。
    const repo = join(dir, 'repo');
    assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
    const evil = (name: string) => `!f() { echo username=x-access-token; echo password=${name}; }; f`;
    for (const [key, value] of [
      ['credential.helper', evil('repo-plain')],
      ['credential.https://github.com.helper', evil('repo-scoped')],
      [`http.${PUSH_URL}.extraheader`, 'AUTHORIZATION: basic repo-header'],
      ['http.https://github.com/.extraheader', 'AUTHORIZATION: basic repo-header-host'],
      ['core.askPass', '/synthetic/askpass'],
    ] as const) {
      assert.equal(spawnSync('git', ['-C', repo, 'config', key, value]).status, 0, key);
    }
    const configDir = join(dir, 'gh-config');
    mkdirSync(configDir);
    const env = childEnvironment({ PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '', HOME: home, USERPROFILE: home }, TOKEN, configDir);
    for (const cwd of [home, repo]) {
      const github = gitIn(cwd, env, ['credential', 'fill'], 'protocol=https\nhost=github.com\n\n');
      assert.equal(github.status, 0, github.stderr);
      assert.match(github.stdout, /^username=x-access-token$/m);
      assert.ok(github.stdout.split(/\r?\n/).includes(`password=${TOKEN}`), cwd);
      assert.doesNotMatch(github.stdout, /stored-secret|repo-plain|repo-scoped/, '利用者やrepoの設定のhelperを使った');
      // ほかのhostにはhelperがなく、端末にも聞かない（GIT_TERMINAL_PROMPT=0）ので失敗する。
      const other = gitIn(cwd, env, ['credential', 'fill'], 'protocol=https\nhost=example.test\n\n');
      assert.notEqual(other.status, 0);
      assert.doesNotMatch(other.stdout, new RegExp(`${TOKEN}|stored-secret|repo-plain|repo-scoped`));
    }
    // pushのURLに当たるextraheaderは空（repoの設定のより細かいURLの値が残らない）。askPassも空。
    const header = gitIn(repo, env, ['config', '--get-urlmatch', 'http.extraheader', PUSH_URL]);
    assert.equal(header.stdout.trim(), '', header.stdout);
    assert.equal(gitIn(repo, env, ['config', 'core.askPass']).stdout.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 127.0.0.1の合成のサーバー。すべての要求に、Basic認証を求める401を返し、Authorizationのheaderを記録する。
async function withAuthServer(fn: (url: string, seen: string[]) => Promise<void>): Promise<void> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="synthetic"', 'Content-Type': 'text/plain' });
    res.end('synthetic');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    await fn(`http://127.0.0.1:${address.port}/doc-gif/kurashi-ledger.git`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function gitAsync(env: Record<string, string>, args: string[], cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env, stdio: 'ignore', timeout: 20_000 });
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
}

test('子の環境の実際のgitは、利用者の.netrcの資格情報を送らない（127.0.0.1の合成のサーバー。親の環境では送ることを対照にする）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kl-app-token-'));
  try {
    const home = join(dir, 'home');
    mkdirSync(home);
    const netrc = 'machine 127.0.0.1 login owner-login password owner-netrc-secret\n';
    writeFileSync(join(home, '.netrc'), netrc, { mode: 0o600 });
    writeFileSync(join(home, '_netrc'), netrc, { mode: 0o600 });
    const parent = { PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '', HOME: home, USERPROFILE: home };
    const secretHeader = `Basic ${Buffer.from('owner-login:owner-netrc-secret').toString('base64')}`;
    // 対照: 親の環境（HOMEが利用者のホーム）のgitは、.netrcの資格情報を送る（libcurlがhelperより前に.netrcを読む）。
    const plain: Record<string, string> = { ...parent, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'none') };
    await withAuthServer(async (url, seen) => {
      await gitAsync(plain, ['ls-remote', url], dir);
      assert.ok(seen.includes(secretHeader), `対照で.netrcの資格情報が送られていない（このgitは.netrcを読まない？）: ${seen.length}件`);
    });
    // 子の環境では、HOMEを一時のディレクトリにするので、利用者の.netrcを読まない。
    const configDir = join(dir, 'gh-config');
    mkdirSync(configDir);
    const env = childEnvironment(parent, TOKEN, configDir);
    await withAuthServer(async (url, seen) => {
      const code = await gitAsync(env, ['ls-remote', url], dir);
      assert.notEqual(code, 0);
      assert.ok(seen.length > 0, 'サーバーに要求が届いていない');
      assert.ok(!seen.includes(secretHeader), '.netrcの資格情報が送られた');
      assert.ok(seen.every((h) => !h.includes(Buffer.from('owner-netrc-secret').toString('base64').slice(0, 12))));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('成功すると、確認のあとでだけ子を起動し、トークンは子の環境にだけ置き、子の終了後に失効させて、子の終了コードを返す', async () => {
  const h = harness([{ status: 201, body: grantedBody('review') }, LISTED, REVOKED], {}, { kind: 'exited', code: 7, signal: null });
  assert.equal(await run(ARGS, h.deps), 7);
  assert.deepEqual(h.events, [
    'resolve gh',
    `POST /app/installations/${INSTALLATION_ID}/access_tokens`,
    'GET /installation/repositories?per_page=100',
    'mkdir',
    'child',
    'rmdir',
    'DELETE /installation/token',
  ]);
  assert.deepEqual(h.keychainCalls, [['kurashi-ledger-codex-reviewer', 'synthetic-user']]);
  assert.equal(h.usernameCalls(), 1);
  const child = h.children[0];
  assert.ok(child !== undefined);
  // コマンドは発行の前に絶対パスへ解決してから実行する。
  assert.deepEqual(child.command, ['/synthetic/bin/gh', 'pr', 'view', '1']);
  assert.equal(h.registered(), 1);
  assert.equal(h.unregistered(), 1, '失効のあとでシグナルの受け取りを解除していない');
  assert.equal(child.stdin, 'inherit');
  assert.equal(child.env['GH_TOKEN'], TOKEN);
  assert.equal(child.env['GH_CONFIG_DIR'], CONFIG_DIR);
  assert.ok(!('GITHUB_TOKEN' in child.env));
  assert.deepEqual(h.removed, [CONFIG_DIR]);
  // 親は標準出力を持たず、標準エラーにも秘密を出さない。
  assert.ok(!('stdout' in h.deps));
  const jwt = (h.calls[0]?.init.headers['Authorization'] ?? '').replace(/^Bearer /, '');
  const [hh, p, s] = jwt.split('.');
  assert.deepEqual(decodeSegment(p), { iat: NOW - 60, exp: NOW + 540, iss: APP_ID });
  assert.ok(s !== undefined && verify('sha256', Buffer.from(`${hh}.${p}`), publicKey, Buffer.from(s, 'base64url')));
  assertNoSecrets(h.err.join(''), [jwt]);
  assert.equal(h.err.join(''), '');
  // 確認と失効の要求は、発行したトークンで送り、どの要求もリダイレクトを追わない。
  assert.equal(h.calls[1]?.init.headers['Authorization'], `Bearer ${TOKEN}`);
  assert.equal(h.calls[2]?.init.headers['Authorization'], `Bearer ${TOKEN}`);
  for (const call of h.calls) {
    assert.equal(call.init.redirect, 'error', call.url);
    assert.ok(call.init.signal instanceof AbortSignal, `時間の上限がない: ${call.url}`);
  }
});

test('子の結果を終了コードにする（シグナルは128+番号、見つからない127、実行できない126）', async () => {
  const cases: [ChildResult, number][] = [
    [{ kind: 'exited', code: 0, signal: null }, 0],
    [{ kind: 'exited', code: 3, signal: null }, 3],
    [{ kind: 'exited', code: null, signal: 'SIGTERM' }, 143],
    [{ kind: 'exited', code: null, signal: 'SIGINT' }, 130],
    [{ kind: 'failed', code: 'ENOENT' }, EXIT_NOT_FOUND],
    [{ kind: 'failed', code: 'EACCES' }, EXIT_CANNOT_EXECUTE],
  ];
  for (const [result, code] of cases) {
    assert.equal(exitCodeOf(result), code, JSON.stringify(result));
    const h = harness([{ status: 201, body: grantedBody('review') }, LISTED, REVOKED], {}, result);
    assert.equal(await run(ARGS, h.deps), code, JSON.stringify(result));
    assert.equal(h.events.at(-1), 'DELETE /installation/token', '子が失敗しても失効させる');
    assertNoSecrets(h.err.join(''));
  }
});

test('失効に失敗しても子の終了コードを返し、失敗を標準エラーに伝える（トークンは出さない）', async () => {
  const replies: Reply[][] = [
    [{ status: 201, body: grantedBody('review') }, LISTED, { status: 500, body: JSON.stringify({ message: TOKEN }) }],
    [
      { status: 201, body: grantedBody('review') },
      LISTED,
      async () => {
        throw Object.assign(new Error(`reset ${TOKEN}`), { cause: { code: 'ECONNRESET' } });
      },
    ],
  ];
  for (const r of replies) {
    const h = harness(r, {}, { kind: 'exited', code: 0, signal: null });
    assert.equal(await run(ARGS, h.deps), 0);
    assert.match(h.err.join(''), /失効できなかった/);
    assertNoSecrets(h.err.join(''));
  }
});

test('キーチェーン以外の鍵では実行中のユーザー名を調べず、--key-stdinでは子に標準入力を渡さない', async () => {
  for (const material of [PEM, PEM_BASE64]) {
    const file = harness([{ status: 201, body: grantedBody('review') }, LISTED, REVOKED], { readKeyFile: () => ({ text: material }) });
    assert.equal(await run(['--agent', 'codex', '--purpose', 'review', ...ID_ARGS, '--key-file', 'synthetic.pem', '--', 'true'], file.deps), 0);
    assert.deepEqual(file.keychainCalls, []);
    assert.equal(file.usernameCalls(), 0);
    assert.equal(file.children[0]?.stdin, 'inherit');
    const stdin = harness([{ status: 201, body: grantedBody('review') }, LISTED, REVOKED], { readStdin: async () => material });
    assert.equal(await run(['--agent', 'codex', '--purpose', 'review', ...ID_ARGS, '--key-stdin', '--', 'true'], stdin.deps), 0);
    assert.equal(stdin.usernameCalls(), 0);
    assert.equal(stdin.children[0]?.stdin, 'ignore');
  }
});

test('claudeのAppとimplement-workflowsの用途は、自分のservice・環境変数・権限を使う', async () => {
  const h = harness([{ status: 201, body: grantedBody('implement-workflows') }, LISTED, REVOKED], {
    env: { KL_GITHUB_APP_ID_CLAUDE: '99', KL_GITHUB_APP_INSTALLATION_ID_CLAUDE: '98', KL_GITHUB_APP_ID_CODEX: '1', KL_GITHUB_APP_INSTALLATION_ID_CODEX: '2' },
  });
  assert.equal(await run(['--agent', 'claude', '--purpose', 'implement-workflows', '--', 'git', 'push'], h.deps), 0);
  assert.deepEqual(h.keychainCalls, [['kurashi-ledger-claude-implementer', 'synthetic-user']]);
  assert.equal(h.calls[0]?.url, 'https://api.github.com/app/installations/98/access_tokens');
  assert.deepEqual(JSON.parse(h.calls[0]?.init.body ?? '{}').permissions, PURPOSES['implement-workflows']);
  assert.deepEqual(decodeSegment((h.calls[0]?.init.headers['Authorization'] ?? '').split('.')[1]), { iat: NOW - 60, exp: NOW + 540, iss: '99' });
  // 子の環境に、AppのIDの環境変数を渡さない。
  assert.ok(!('KL_GITHUB_APP_ID_CLAUDE' in (h.children[0]?.env ?? {})));
});

test('発行・確認の失敗では子を起動せず125で終え、鍵・JWT・トークンを出さない', async () => {
  let capturedJwt = '';
  const capture = (status: number, body: (jwt: string) => string): Reply => async (_url, init) => {
    capturedJwt = (init.headers['Authorization'] ?? '').replace(/^Bearer /, '');
    return { status, text: async () => body(capturedJwt) };
  };
  const cases: { name: string; replies?: Reply[]; deps?: Partial<Deps>; expect: RegExp }[] = [
    { name: 'HTTP 401', replies: [capture(401, () => JSON.stringify({ message: 'Bad credentials' }))], expect: /HTTP 401.*Bad credentials/ },
    { name: 'GitHubのメッセージが秘密を含む', replies: [capture(422, (jwt) => JSON.stringify({ message: `echo ${jwt} ${PEM} ${TOKEN} ${PEM_BODY_LINES[0]}` }))], expect: /HTTP 422/ },
    { name: 'JSONでない失敗の応答', replies: [capture(502, (jwt) => `<html>${jwt}</html>`)], expect: /HTTP 502.*メッセージなし/ },
    {
      name: '通信の失敗（例外のメッセージにJWTを含む）',
      replies: [
        async (_url, init) => {
          capturedJwt = (init.headers['Authorization'] ?? '').replace(/^Bearer /, '');
          throw Object.assign(new Error(`connect failed ${capturedJwt} ${PEM}`), { name: 'TypeError', cause: { code: 'ECONNREFUSED' } });
        },
      ],
      expect: /要求が失敗した（TypeError・ECONNREFUSED）/,
    },
    {
      name: 'リダイレクト（redirect: errorで例外になる）',
      replies: [
        async (_url, init) => {
          assert.equal(init.redirect, 'error');
          throw new TypeError(`fetch failed: redirect ${TOKEN}`);
        },
      ],
      expect: /要求が失敗した（TypeError）/,
    },
    {
      name: '時間切れ',
      replies: [
        async () => {
          throw new DOMException(`timeout ${TOKEN}`, 'TimeoutError');
        },
      ],
      expect: /TimeoutError/,
    },
    { name: '201だがトークンがない', replies: [capture(201, () => JSON.stringify({ permissions: {} }))], expect: /トークンがない/ },
    { name: '201だがトークンに改行がある', replies: [capture(201, () => grantedBody('review', { token: `${TOKEN}\nextra` }))], expect: /形式が違う/ },
    {
      name: 'キーチェーンの失敗',
      deps: {
        readKeychain: async () => {
          throw new TokenError('キーチェーンから読めなかった（終了コード 51）。');
        },
      },
      expect: /終了コード 51/,
    },
    {
      name: '鍵が壊れている',
      deps: {
        readKeychain: async () =>
          Buffer.from(PEM.split('\n').map((l) => (l.startsWith('-----') ? l : l.replace(/[A-Za-z]/g, 'A'))).join('\n'), 'utf8').toString('base64'),
      },
      expect: /秘密鍵を読めなかった/,
    },
    {
      name: '鍵の読取りが予期しない例外',
      deps: {
        readKeychain: async () => {
          throw new Error(`unexpected ${PEM}`);
        },
      },
      expect: /予期しないエラー（Error）/,
    },
  ];
  for (const c of cases) {
    capturedJwt = '';
    const h = harness(c.replies ?? [], c.deps ?? {});
    assert.equal(await run(ARGS, h.deps), EXIT_OWN_FAILURE, c.name);
    assert.deepEqual(h.children, [], `${c.name}: 子を起動した`);
    const stderr = h.err.join('');
    assert.match(stderr, c.expect, `${c.name}: ${stderr}`);
    assert.match(stderr, /コマンドは実行していない/);
    assertNoSecrets(stderr, capturedJwt === '' ? [] : [capturedJwt]);
  }
  // 引数の誤りも125で、子を起動しない。
  const usage = harness([]);
  assert.equal(await run(['--agent', 'codex', '--purpose', 'review', '--app-id', PEM_BASE64.slice(0, 40), '--installation-id', '1', '--', 'true'], usage.deps), EXIT_OWN_FAILURE);
  assert.match(usage.err.join(''), /数字だけ/);
  assert.deepEqual(usage.children, []);
  const help = harness([]);
  assert.equal(await run(['--help'], help.deps), 0);
  assert.deepEqual(help.children, []);
});

test('発行された権限・repoが要求と完全に一致しなければ、子を起動せずにトークンを失効させる', async () => {
  const withPermissions = (purpose: Purpose, permissionsJson: string): string =>
    grantedBody(purpose).replace(/"permissions":\{[^}]*\}/, `"permissions":${permissionsJson}`);
  const permissionsOf = (o: Record<string, unknown>) => JSON.stringify({ ...o });
  const cases: { purpose: Purpose; body: string }[] = [
    { purpose: 'review', body: grantedBody('review', { permissions: { ...PURPOSES.review, metadata: 'read', administration: 'write' } }) },
    { purpose: 'review', body: grantedBody('review', { permissions: { ...PURPOSES.review, contents: 'write', metadata: 'read' } }) },
    { purpose: 'review', body: grantedBody('review', { permissions: { pull_requests: 'write', metadata: 'read' } }) },
    { purpose: 'implement', body: grantedBody('implement', { permissions: { ...PURPOSES.implement, workflows: 'write', metadata: 'read' } }) },
    { purpose: 'implement', body: grantedBody('implement', { permissions: { ...PURPOSES.implement, checks: undefined, metadata: 'read' } }) },
    { purpose: 'implement', body: grantedBody('implement', { permissions: { ...PURPOSES.implement, statuses: null, metadata: 'read' } }) },
    { purpose: 'implement', body: grantedBody('implement', { permissions: { ...PURPOSES.implement, metadata: 'write' } }) },
    { purpose: 'implement', body: grantedBody('implement', { permissions: null }) },
    // JSONの"__proto__"は自分のプロパティになる。照合をすり抜けさせない。
    { purpose: 'implement', body: withPermissions('implement', `{${permissionsOf(PURPOSES.implement).slice(1, -1)},"metadata":"read","__proto__":"write"}`) },
    { purpose: 'review', body: withPermissions('review', `{"__proto__":{"pull_requests":"write"},"contents":"read","actions":"read","checks":"read","statuses":"read"}`) },
    { purpose: 'review', body: grantedBody('review', { repository_selection: 'all' }) },
    { purpose: 'review', body: grantedBody('review', { repositories: [{ name: REPOSITORY_NAME }, { name: 'other' }] }) },
    { purpose: 'review', body: grantedBody('review', { repositories: undefined }) },
    { purpose: 'review', body: grantedBody('review', { repositories: [] }) },
    { purpose: 'review', body: grantedBody('review', { repositories: [{ name: 'other' }] }) },
    { purpose: 'review', body: grantedBody('review', { repositories: 'kurashi-ledger' }) },
  ];
  for (const c of cases) {
    JSON.parse(c.body);
    const h = harness([{ status: 201, body: c.body }, REVOKED]);
    const args = ['--agent', 'codex', '--purpose', c.purpose, ...ID_ARGS, '--', 'true'];
    assert.equal(await run(args, h.deps), EXIT_OWN_FAILURE, c.body);
    assert.deepEqual(h.children, [], c.body);
    assert.match(h.err.join(''), /範囲が要求と違う.*失効させた/, c.body);
    assertNoSecrets(h.err.join(''));
    assert.equal(h.calls[1]?.url, 'https://api.github.com/installation/token');
    assert.equal(h.calls[1]?.init.method, 'DELETE');
    assert.equal(h.calls[1]?.init.headers['Authorization'], `Bearer ${TOKEN}`);
  }
  // 要求どおりの完全一致なら通る（implementの用途）。
  const ok = harness([{ status: 201, body: grantedBody('implement') }, LISTED, REVOKED]);
  assert.equal(await run(['--agent', 'codex', '--purpose', 'implement', ...ID_ARGS, '--', 'true'], ok.deps), 0);
});

test('発行したトークンで触れるrepoがこのrepoの1件だと確かめられなければ、子を起動せずに失効させる', async () => {
  const listings: Reply[] = [
    { status: 200, body: JSON.stringify({ total_count: 2, repositories: [{ name: REPOSITORY_NAME }, { name: 'other' }] }) },
    { status: 200, body: JSON.stringify({ total_count: 1, repositories: [{ name: 'other' }] }) },
    { status: 200, body: JSON.stringify({ repositories: [{ name: REPOSITORY_NAME }] }) },
    { status: 200, body: JSON.stringify({ total_count: 1 }) },
    { status: 403, body: JSON.stringify({ message: `denied ${TOKEN}` }) },
    { status: 200, body: `<html>${TOKEN}</html>` },
    async () => {
      throw Object.assign(new Error(`reset ${TOKEN}`), { cause: { code: 'ECONNRESET' } });
    },
  ];
  for (const listing of listings) {
    const h = harness([{ status: 201, body: grantedBody('review') }, listing, REVOKED]);
    assert.equal(await run(ARGS, h.deps), EXIT_OWN_FAILURE);
    assert.deepEqual(h.children, []);
    assert.match(h.err.join(''), /範囲が要求と違う.*失効させた/);
    assertNoSecrets(h.err.join(''));
    assert.deepEqual(h.events, [
      'resolve gh',
      `POST /app/installations/${INSTALLATION_ID}/access_tokens`,
      'GET /installation/repositories?per_page=100',
      'DELETE /installation/token',
    ]);
  }
});

test('トークンの形: 従来の形とstatelessの形（ghs_<App ID>_<JWT>）を受け付け、ほかの種類・空白・制御文字・長すぎるものは受け付けない', () => {
  for (const ok of [TOKEN, DIGITLESS_TOKEN, STATELESS_TOKEN, `ghs_${'a'.repeat(36)}`]) assert.match(ok, TOKEN_PATTERN);
  assert.ok(STATELESS_TOKEN.length > 255 && STATELESS_TOKEN.includes('.'), '合成のstatelessの形が、長さと区切りを持たない');
  for (const bad of [
    '',
    'ghs_',
    `ghs_${'a'.repeat(35)}`,
    `ghs_${'a'.repeat(8189)}`,
    `ghp_${'a'.repeat(36)}`,
    `github_pat_${'a'.repeat(40)}`,
    `${'a'.repeat(40)}`,
    `${TOKEN} `,
    `${TOKEN}\n`,
    `${TOKEN}"`,
    `${TOKEN};x`,
    `${TOKEN}$x`,
    `${TOKEN}\u0000`,
    `ghs_${'a'.repeat(30)} ${'a'.repeat(10)}`,
  ]) {
    assert.doesNotMatch(bad, TOKEN_PATTERN, JSON.stringify(bad.slice(0, 50)));
  }
});

test('statelessの形のトークンでも、範囲を確かめてから子を起動し、子の環境にだけ置き、失効させる', async () => {
  const h = harness([{ status: 201, body: grantedBody('review', {}, STATELESS_TOKEN) }, LISTED, REVOKED]);
  assert.equal(await run(ARGS, h.deps), 0);
  assert.deepEqual(h.events, [
    'resolve gh',
    `POST /app/installations/${INSTALLATION_ID}/access_tokens`,
    'GET /installation/repositories?per_page=100',
    'mkdir',
    'child',
    'rmdir',
    'DELETE /installation/token',
  ]);
  assert.equal(h.children[0]?.env['GH_TOKEN'], STATELESS_TOKEN);
  assert.equal(h.calls[1]?.init.headers['Authorization'], `Bearer ${STATELESS_TOKEN}`);
  assert.equal(h.calls[2]?.init.headers['Authorization'], `Bearer ${STATELESS_TOKEN}`);
  assertNoSecrets(h.err.join(''));
});

test('発行したトークンは得た直後から既知の秘密として伏せる（数字のないトークンが権限の名前や形の誤りに入っても出さない）', async () => {
  const cases: { name: string; body: string; expect: RegExp; revoke: boolean }[] = [
    {
      name: '権限の名前にトークン（数字なし）',
      body: grantedBody('review', { permissions: { ...PURPOSES.review, metadata: 'read', [DIGITLESS_TOKEN]: 'read' } }, DIGITLESS_TOKEN),
      expect: /要求していない権限（名前は表示しない）.*失効させた/,
      revoke: true,
    },
    {
      name: '足りない権限の名前の表示（数字なし）',
      body: grantedBody('review', { permissions: { [DIGITLESS_TOKEN]: 'write', metadata: 'read' } }, DIGITLESS_TOKEN),
      expect: /範囲が要求と違う.*失効させた/,
      revoke: true,
    },
    {
      name: 'repoの名前にトークン（数字なし）',
      body: grantedBody('review', { repositories: [{ name: DIGITLESS_TOKEN }] }, DIGITLESS_TOKEN),
      expect: /範囲が要求と違う.*失効させた/,
      revoke: true,
    },
    {
      name: '形の誤り（末尾の空白）',
      body: grantedBody('review', {}, `${DIGITLESS_TOKEN} `),
      expect: /トークンの形式が違う/,
      revoke: false,
    },
  ];
  for (const c of cases) {
    const h = harness(c.revoke ? [{ status: 201, body: c.body }, REVOKED] : [{ status: 201, body: c.body }]);
    assert.equal(await run(ARGS, h.deps), EXIT_OWN_FAILURE, c.name);
    assert.deepEqual(h.children, [], c.name);
    const stderr = h.err.join('');
    assert.match(stderr, c.expect, `${c.name}: ${stderr}`);
    assert.ok(!stderr.includes(DIGITLESS_TOKEN), `${c.name}: 標準エラーにトークンがある`);
    assertNoSecrets(stderr);
    if (c.revoke) {
      assert.equal(h.calls.at(-1)?.init.method, 'DELETE', c.name);
      assert.equal(h.calls.at(-1)?.init.headers['Authorization'], `Bearer ${DIGITLESS_TOKEN}`);
    }
  }
});

test('文書と入口の例は、トークンをシェルの変数で受ける形（失敗時に保存済みの資格情報へ戻る）を使わず、信頼した写しと ` -- ` で子に渡す', () => {
  const root = join(import.meta.dirname, '..');
  const files = ['docs/github-apps.md', 'docs/pr-review-loop.md', 'docs/external-worker.md', 'docs/github-agent-operations.md', 'AGENTS.md', 'SECURITY.md', 'scripts/github-app-token.ts', 'scripts/lib/github-app-token.ts'];
  // 使わない理由を説明する背景の1行だけを除く（その行は、例ではなく「使わない」と書いた説明）。
  const background = 'トークンを標準出力に出して`GH_TOKEN="$(…)"`で受ける形は';
  let examples = 0;
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.includes(background)) continue;
      assert.doesNotMatch(line, /\$\(\s*(?:env\s[^)]*)?node[^)]*github-app-token/, `${file}: ${line.slice(0, 80)}`);
      assert.doesNotMatch(line, /\bGH_TOKEN="?\$/, `${file}: ${line.slice(0, 80)}`);
      // 実行の例（文書の中の --agent を渡す行）は、NODE_OPTIONSを外し、信頼した写しのパスから実行し、` -- `でコマンドを渡す。
      if (file.startsWith('docs/') && /github-app-token\.ts" --agent /.test(line)) {
        examples++;
        assert.match(line, /^env -u NODE_OPTIONS node "\$KL_APP_TOKEN_DIR\/github-app-token\.ts" --agent (codex|claude|<codex\|claude>) --purpose \S+ (?:.* )?-- \S/, `${file}: ${line.slice(0, 100)}`);
      }
    }
  }
  assert.ok(examples >= 10, `実行の例が少ない（${examples}件）。検査が例を見つけられていない`);
  const background_count = readFileSync(join(root, 'docs/github-apps.md'), 'utf8').split(background).length - 1;
  assert.equal(background_count, 1, '除外する背景の行は1つだけ');
});

test('出力を伏せる処理は、長い英数字の並びと既知の秘密を伏せ、serviceの名前等は残す', () => {
  assert.equal(sanitize('Bad credentials', []), 'Bad credentials');
  assert.equal(sanitize('service kurashi-ledger-claude-implementer', []), 'service kurashi-ledger-claude-implementer');
  assert.ok(!sanitize(`x ${TOKEN} y`, []).includes(TOKEN));
  assert.ok(!sanitize('short-secret-1', ['short-secret-1']).includes('short-secret-1'));
  assert.ok(!sanitize('a\u001b[31mb', []).includes('\u001b'));
  assert.ok(sanitize('x'.repeat(1000), []).length <= 301);
});

test('実際の子プロセス: シェルを通さずに起動し、渡した環境だけを見せ、終了コードを返す。見つからないコマンドはENOENT', async () => {
  const env = childEnvironment({ PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '', GITHUB_TOKEN: 'parent' }, TOKEN, CONFIG_DIR);
  const source = [
    `const ok = process.env.GH_TOKEN === ${JSON.stringify(TOKEN)} && process.env.GITHUB_TOKEN === undefined`,
    `  && process.env.GH_CONFIG_DIR === ${JSON.stringify(CONFIG_DIR)} && process.argv[1] === 'a b;$(x)';`,
    'process.exit(ok ? 3 : 4);',
  ].join('\n');
  assert.deepEqual(await spawnChild([process.execPath, '-e', source, 'a b;$(x)'], env, 'ignore').result, { kind: 'exited', code: 3, signal: null });
  assert.deepEqual(await spawnChild(['kl-app-token-no-such-command-0'], env, 'ignore').result, { kind: 'failed', code: 'ENOENT' });
});

test('コマンドは発行の前に絶対パスへ解決し、見つからなければ発行せずに127で終える。相対パス・PATHの相対の項目は使わない', async () => {
  const h = harness([]);
  assert.equal(await run(['--agent', 'codex', '--purpose', 'review', ...ID_ARGS, '--', 'no-such-command'], h.deps), EXIT_NOT_FOUND);
  assert.deepEqual(h.events, ['resolve no-such-command']);
  assert.deepEqual(h.keychainCalls, []);
  assert.deepEqual(h.calls, []);
  assert.match(h.err.join(''), /トークンは発行していない/);
  const exists = new Set(['/abs/bin/gh', '/usr/bin/git', 'C:\\Tools\\gh.exe', 'C:\\Tools\\git.cmd']);
  const isFile = (path: string) => exists.has(path);
  assert.equal(resolveCommand('gh', { PATH: ['', '.', 'rel/bin', '/abs/bin'].join(':') }, 'linux', isFile), '/abs/bin/gh');
  assert.equal(resolveCommand('gh', { PATH: '.:rel' }, 'linux', () => true), null);
  assert.equal(resolveCommand('./gh', { PATH: '/abs/bin' }, 'linux', () => true), null);
  assert.equal(resolveCommand('bin/gh', { PATH: '/abs/bin' }, 'linux', () => true), null);
  assert.equal(resolveCommand('/usr/bin/git', {}, 'darwin', isFile), '/usr/bin/git');
  assert.equal(resolveCommand('/usr/bin/nothing', {}, 'darwin', isFile), null);
  assert.equal(resolveCommand('gh', { Path: 'C:\\Tools' }, 'win32', isFile), 'C:\\Tools\\gh.exe');
  // Windowsでは.cmd・.batを探さない（シェルなしで実行できない）。
  assert.equal(resolveCommand('git', { Path: 'C:\\Tools' }, 'win32', isFile), null);
  // 実際のファイルで: nodeを、PATHから絶対パスに解決できる。
  const nodeName = process.platform === 'win32' ? 'node' : basename(process.execPath);
  const real = resolveCommand(nodeName, { PATH: dirname(process.execPath), Path: dirname(process.execPath) }, process.platform, (path) => isExecutableFile(path, process.platform));
  assert.ok(real !== null && isAbsolute(real), String(real));
});

test('発行から失効までにシグナルを受けたら、子に転送し、子の終了後に失効させて128+番号で終える', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    let killChild: ((s: NodeJS.Signals) => void) | undefined;
    const h = harness([{ status: 201, body: grantedBody('review') }, LISTED, REVOKED], {}, (kill) => {
      killChild = kill;
      return new Promise<ChildResult>((resolve) => {
        setTimeout(() => {
          h.fire(signal);
          resolve({ kind: 'exited', code: null, signal });
        }, 5);
      });
    });
    const code = await run(ARGS, h.deps);
    assert.ok(killChild !== undefined);
    assert.equal(code, signal === 'SIGINT' ? 130 : 143);
    assert.deepEqual(h.killed, [signal], 'SIGINTも子へ転送する');
    assert.deepEqual(h.events.slice(-5), ['child', `signal ${signal}`, `kill ${signal}`, 'rmdir', 'DELETE /installation/token']);
    assert.equal(h.unregistered(), 1);
  }
});

test('確認の途中でシグナルを受けたら、確認の要求を中断し、子を起動せず、トークンを失効させて128+番号で終える', async () => {
  let fire: ((s: NodeJS.Signals) => void) | undefined;
  const hanging: Reply = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      setTimeout(() => fire?.('SIGTERM'), 5);
    });
  const h = harness([{ status: 201, body: grantedBody('review') }, hanging, REVOKED]);
  fire = h.fire;
  assert.equal(await run(ARGS, h.deps), 143);
  assert.deepEqual(h.children, []);
  assert.deepEqual(h.events, [
    'resolve gh',
    `POST /app/installations/${INSTALLATION_ID}/access_tokens`,
    'GET /installation/repositories?per_page=100',
    'signal SIGTERM',
    'DELETE /installation/token',
  ]);
  assert.match(h.err.join(''), /SIGTERM/);
  assertNoSecrets(h.err.join(''));
  // 確認が終わったあと、子を起動する前に受けた場合も、子を起動せずに失効させる。
  const late = harness([{ status: 201, body: grantedBody('review') }, LISTED, REVOKED], {
    makeConfigDir: () => {
      throw new Error('呼ばれないはず');
    },
  });
  const originalFetch = late.deps.fetch;
  const deps: Deps = {
    ...late.deps,
    fetch: async (url, init) => {
      const r = await originalFetch(url, init);
      if (url.includes('/installation/repositories')) late.fire('SIGINT');
      return r;
    },
  };
  assert.equal(await run(ARGS, deps), 130);
  assert.deepEqual(late.children, []);
  assert.equal(late.events.at(-1), 'DELETE /installation/token');
});

// 実際のプロセスとシグナルで確かめるための、合成のharness（ネットワークとキーチェーンを使わない。fetchは合成）。
// mode=child: 子を起動し、子がシグナルを受けたら印のファイルを作って終わる。mode=verify: 確認の要求で待ち、中断されたら失敗する。
function signalHarnessSource(dir: string, mode: 'child' | 'verify'): string {
  const lib = pathToFileURL(join(import.meta.dirname, 'lib', 'github-app-token.ts')).href;
  const childSource = [
    "const fs = require('node:fs');",
    `const dir = ${JSON.stringify(dir)};`,
    "for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { fs.writeFileSync(require('node:path').join(dir, 'child-got-' + s), ''); process.exit(0); });",
    "fs.writeFileSync(require('node:path').join(dir, 'child-pid'), String(process.pid));",
    "fs.writeFileSync(require('node:path').join(dir, 'child-started'), '');",
    'setInterval(() => undefined, 1000);',
  ].join('\n');
  return [
    "const { generateKeyPairSync } = await import('node:crypto');",
    "const { mkdtempSync, rmSync } = await import('node:fs');",
    "const { tmpdir } = await import('node:os');",
    "const { join } = await import('node:path');",
    `const m = await import(${JSON.stringify(lib)});`,
    "const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();",
    `const token = ${JSON.stringify(TOKEN)};`,
    `const granted = ${JSON.stringify(grantedBody('review'))};`,
    `const listed = ${JSON.stringify(LISTED.body)};`,
    `const mode = ${JSON.stringify(mode)};`,
    'const fetch = async (url, init) => {',
    "  if (init.method === 'POST') return { status: 201, text: async () => granted };",
    "  if (init.method === 'DELETE') { process.stdout.write('REVOKED\\n'); return { status: 204, text: async () => '' }; }",
    "  if (mode === 'child') return { status: 200, text: async () => listed };",
    "  process.stdout.write('WAITING\\n');",
    "  return new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));",
    '};',
    // 合成のfetchは待つ間にイベントループを保たない（実際の通信は保つ）ので、終わるまで保つ。
    'const keepAlive = setInterval(() => undefined, 1000);',
    'const code = await m.run(',
    `  ['--agent', 'codex', '--purpose', 'review', '--app-id', '1', '--installation-id', '2', '--key-stdin', '--', process.execPath, '-e', ${JSON.stringify(childSource)}],`,
    '  {',
    '    env: process.env, platform: process.platform, uid: process.getuid(), username: () => "u",',
    '    nowSeconds: () => Math.floor(Date.now() / 1000), fetch,',
    "    readKeychain: async () => { throw new Error('unused'); }, readKeyFile: () => { throw new Error('unused'); },",
    '    readStdin: async () => pem,',
    '    resolveCommand: (p) => m.resolveCommand(p, process.env, process.platform, (x) => m.isExecutableFile(x, process.platform)),',
    "    makeConfigDir: () => mkdtempSync(join(tmpdir(), 'kl-gh-config-')),",
    '    removeConfigDir: (p) => rmSync(p, { recursive: true, force: true }),',
    '    runChild: m.spawnChild, onSignals: m.onProcessSignals,',
    '    stderr: (t) => process.stderr.write(t),',
    '  },',
    ');',
    'clearInterval(keepAlive);',
    'process.exit(code);',
  ].join('\n');
}

function runHarness(dir: string, mode: 'child' | 'verify', signal: NodeJS.Signals, ready: () => boolean): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(NODE_|KL_GITHUB_APP_)/i.test(k)) env[k] = v;
    const child = spawn(process.execPath, ['--input-type=module', '-e', signalHarnessSource(dir, mode)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    // 時間切れのときは、harnessと、その子（転送されなければ残る）を止める。
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      try {
        process.kill(Number(readFileSync(join(dir, 'child-pid'), 'utf8')), 'SIGKILL');
      } catch {
        // 子がない、またはすでに終わっている。
      }
      reject(new Error(`時間切れ: ${out} ${err}`));
    }, 30_000);
    const poll = setInterval(() => {
      if (ready() || out.includes('WAITING')) {
        clearInterval(poll);
        child.kill(signal);
      }
    }, 20);
    child.once('exit', (code) => {
      clearTimeout(deadline);
      clearInterval(poll);
      resolve({ code, out, err });
    });
  });
}

test('実際のプロセスとシグナルで: 子の実行中のSIGINT・SIGTERMを子へ転送し、子の終了後に失効させて128+番号で終える', { skip: posixSignalsOnly }, async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'kl-app-token-'));
    try {
      const r = await runHarness(dir, 'child', signal, () => existsSync(join(dir, 'child-started')));
      assert.equal(r.code, signal === 'SIGINT' ? 130 : 143, r.err);
      // harnessのプロセスだけに送ったので、子が受けたのは転送されたシグナル。
      assert.ok(existsSync(join(dir, `child-got-${signal}`)), `子が${signal}を受けていない`);
      assert.match(r.out, /REVOKED/);
      assertNoSecrets(r.out + r.err);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // 確認の途中のSIGTERM: 確認の要求を中断し、子を起動せず、失効させて143で終える。
  const dir = mkdtempSync(join(tmpdir(), 'kl-app-token-'));
  try {
    const r = await runHarness(dir, 'verify', 'SIGTERM', () => false);
    assert.equal(r.code, 143, r.err);
    assert.match(r.out, /WAITING[\s\S]*REVOKED/);
    assert.ok(!existsSync(join(dir, 'child-started')), '子を起動した');
    assertNoSecrets(r.out + r.err);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('形の検査に通らないトークンも、ヘッダに入れて安全な値なら失効を試み、失効の401はすでに無効として扱う', async () => {
  const quoted = `${TOKEN}"`;
  const safe = harness([{ status: 201, body: grantedBody('review', {}, quoted) }, REVOKED]);
  assert.equal(await run(ARGS, safe.deps), EXIT_OWN_FAILURE);
  assert.equal(safe.calls[1]?.init.method, 'DELETE');
  assert.equal(safe.calls[1]?.init.headers['Authorization'], `Bearer ${quoted}`);
  assert.match(safe.err.join(''), /形式が違う.*失効させた/);
  assertNoSecrets(safe.err.join(''), [quoted]);
  const unsafe = harness([{ status: 201, body: grantedBody('review', {}, `${TOKEN} x`) }]);
  assert.equal(await run(ARGS, unsafe.deps), EXIT_OWN_FAILURE);
  assert.equal(unsafe.calls.length, 1, 'ヘッダに入れられない値で失効の要求を送った');
  assert.match(unsafe.err.join(''), /失効を試みていない/);
  const gone = harness([{ status: 201, body: grantedBody('review') }, LISTED, { status: 401, body: '{"message":"Bad credentials"}' }]);
  assert.equal(await run(ARGS, gone.deps), 0);
  assert.equal(gone.err.join(''), '');
});

test('スクリプトを実行しても、引数の誤りと鍵ファイルの拒否では、何も出力せず子を起動せずネットワークに出ない', () => {
  // ネットワークに出る前に止まる経路だけを、実際のプロセスで確かめる。
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(NODE_|KL_GITHUB_APP_)/i.test(k)) env[k] = v;
  const dir = mkdtempSync(join(tmpdir(), 'kl-app-token-'));
  // 子が起動したら、このファイルができる。
  const marker = join(dir, 'child-ran');
  const childArgs = ['--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`];
  try {
    const usage = spawnSync(process.execPath, [SCRIPT, '--agent', 'codex', '--purpose', 'review', '--app-id', 'abc', '--installation-id', '1', ...childArgs], { env, encoding: 'utf8' });
    assert.equal(usage.status, EXIT_OWN_FAILURE, usage.stderr);
    assert.equal(usage.stdout, '');
    assert.match(usage.stderr, /数字だけ/);
    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { env, encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.equal(help.stdout, '');
    assert.match(help.stderr, /--agent/);
    const noCommand = spawnSync(process.execPath, [SCRIPT, '--agent', 'codex', '--purpose', 'review', '--app-id', '1', '--installation-id', '1'], { env, encoding: 'utf8' });
    assert.equal(noCommand.status, EXIT_OWN_FAILURE);
    assert.equal(noCommand.stdout, '');
    assert.match(noCommand.stderr, /実行するコマンドがない/);
    const path = join(dir, 'synthetic-key.pem');
    if (process.platform !== 'win32') {
      writeFileSync(path, PEM);
      chmodSync(path, 0o644);
    } else {
      // Windowsでは権限を確かめないので、壊れた鍵ファイルで、ネットワークに出る前に止まることを確かめる。
      writeFileSync(path, 'SENTINEL-NOT-A-KEY');
    }
    const r = spawnSync(process.execPath, [SCRIPT, '--agent', 'codex', '--purpose', 'review', '--app-id', '1', '--installation-id', '1', '--key-file', path, ...childArgs], { env, encoding: 'utf8' });
    assert.equal(r.status, EXIT_OWN_FAILURE, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, process.platform === 'win32' ? /鍵の形式が違う/ : /chmod 600/);
    assert.ok(!r.stderr.includes('SENTINEL-NOT-A-KEY'));
    assertNoSecrets(r.stderr);
    // 壊れた鍵を標準入力から渡しても、ネットワークに出る前に止まり、代わりのコマンドを実行しない。
    const stdin = spawnSync(process.execPath, [SCRIPT, '--agent', 'claude', '--purpose', 'implement', '--app-id', '1', '--installation-id', '1', '--key-stdin', ...childArgs], {
      env,
      encoding: 'utf8',
      input: 'SENTINEL-NOT-A-KEY',
      timeout: 20_000,
    });
    assert.equal(stdin.status, EXIT_OWN_FAILURE, stdin.stderr);
    assert.equal(stdin.stdout, '');
    assert.match(stdin.stderr, /コマンドは実行していない/);
    assert.ok(!stdin.stderr.includes('SENTINEL-NOT-A-KEY'));
    assert.throws(() => rmSync(marker), 'コマンドが実行された');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
