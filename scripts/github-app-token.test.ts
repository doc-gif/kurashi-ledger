// scripts/github-app-token.ts と scripts/lib/github-app-token.ts の試験（docs/github-apps.md）。
// 鍵は試験の中で生成したRSA鍵だけを使う。ネットワーク・キーチェーンは使わない（fetch・キーチェーン・子プロセスは注入する）。
// 秘密の番兵（トークン等）は、公開検査の型に当たらないよう、実行時に組み立てる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  REPOSITORY_NAME,
  TokenError,
  UNUSED_GIT_GLOBAL_CONFIG,
  UsageError,
  childEnvironment,
  createAppJwt,
  exitCodeOf,
  keyFileProblem,
  loadPrivateKey,
  parseArgs,
  pemFromKeyMaterial,
  readKeyFileFromDisk,
  readKeyFromStream,
  readKeychainKey,
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

function decodeSegment(segment: string | undefined): unknown {
  assert.ok(segment !== undefined);
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function grantedBody(purpose: Purpose, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: TOKEN,
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
function harness(replies: readonly Reply[], overrides: Partial<Deps> = {}, child: ChildResult = { kind: 'exited', code: 0, signal: null }) {
  const events: string[] = [];
  const calls: Call[] = [];
  const err: string[] = [];
  const keychainCalls: string[][] = [];
  const children: { command: readonly string[]; env: Record<string, string>; stdin: string }[] = [];
  const removed: string[] = [];
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
    makeConfigDir: () => {
      events.push('mkdir');
      return CONFIG_DIR;
    },
    removeConfigDir: (path) => {
      events.push('rmdir');
      removed.push(path);
    },
    runChild: async (command, env, stdin) => {
      events.push('child');
      children.push({ command, env, stdin });
      return child;
    },
    stderr: (text) => err.push(text),
    ...overrides,
  };
  return { deps, events, calls, err, keychainCalls, children, removed, usernameCalls: () => usernameCalls };
}

function assertNoSecrets(text: string, extra: readonly string[] = []): void {
  for (const secret of [TOKEN, PEM, PEM_BASE64, ...PEM_BODY_LINES, ...extra]) {
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
    // 書く側がいないFIFOを開くと、O_NONBLOCKやlstatの検査がなければここで止まる。
    assert.throws(() => readKeyFileFromDisk(fifo, process.platform, uid), /通常のファイルでない/);
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

test('子の環境: Appのトークンだけを渡し、ghとgitが保存済みの資格情報・SSH・利用者の設定に戻らない', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/synthetic/home',
    GITHUB_TOKEN: 'parent-github-token',
    GH_TOKEN: 'parent-gh-token',
    GH_ENTERPRISE_TOKEN: 'x',
    github_enterprise_token: 'x',
    GH_HOST: 'example.test',
    GH_CONFIG_DIR: '/synthetic/home/.config/gh',
    GIT_ASKPASS: '/x',
    SSH_ASKPASS: '/x',
    GIT_SSH: '/x',
    GIT_SSH_COMMAND: 'ssh -i x',
    GIT_CONFIG_PARAMETERS: "'url.ssh://github.com/.insteadof'='https://github.com/'",
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_4: 'x',
    GCM_PROVIDER: 'x',
    KL_GITHUB_APP_ID_CODEX: '1',
    UNDEFINED: undefined,
  };
  const env = childEnvironment(parent, TOKEN, CONFIG_DIR);
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/synthetic/home',
    GH_TOKEN: TOKEN,
    GH_CONFIG_DIR: CONFIG_DIR,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(CONFIG_DIR, UNUSED_GIT_GLOBAL_CONFIG),
    GIT_SSH_COMMAND: 'false',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: GIT_CREDENTIAL_HELPER,
  });
  // helperはトークンの値を含まず、子の環境のGH_TOKENを読む。
  assert.ok(!GIT_CREDENTIAL_HELPER.includes(TOKEN));
  assert.match(GIT_CREDENTIAL_HELPER, /\$GH_TOKEN"/);
});

test('子の環境の実際のgitは、github.comのHTTPSの資格情報としてAppのトークンを返し、ほかのhostには返さない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kl-app-token-'));
  try {
    // 利用者の設定（HOMEの.gitconfig）に、保存済みの資格情報を返すhelperがあっても使わない。
    writeFileSync(join(dir, '.gitconfig'), '[credential]\n\thelper = "!f() { echo username=stored-user; echo password=stored-secret; }; f"\n');
    const configDir = join(dir, 'gh-config');
    mkdirSync(configDir);
    const env = childEnvironment({ PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '', HOME: dir, USERPROFILE: dir }, TOKEN, configDir);
    const fill = (host: string) =>
      spawnSync('git', ['credential', 'fill'], { cwd: dir, env, input: `protocol=https\nhost=${host}\n\n`, encoding: 'utf8', timeout: 20_000 });
    const github = fill('github.com');
    assert.equal(github.status, 0, github.stderr);
    assert.match(github.stdout, /^username=x-access-token$/m);
    assert.ok(github.stdout.split(/\r?\n/).includes(`password=${TOKEN}`));
    assert.ok(!github.stdout.includes('stored-secret'), '利用者の設定のhelperを使った');
    // ほかのhostにはhelperがなく、端末にも聞かない（GIT_TERMINAL_PROMPT=0）ので失敗する。
    const other = fill('example.test');
    assert.notEqual(other.status, 0);
    assert.ok(!other.stdout.includes(TOKEN));
    assert.ok(!other.stdout.includes('stored-secret'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('成功すると、確認のあとでだけ子を起動し、トークンは子の環境にだけ置き、子の終了後に失効させて、子の終了コードを返す', async () => {
  const h = harness([{ status: 201, body: grantedBody('review') }, LISTED, REVOKED], {}, { kind: 'exited', code: 7, signal: null });
  assert.equal(await run(ARGS, h.deps), 7);
  assert.deepEqual(h.events, [
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
  assert.deepEqual(child.command, ['gh', 'pr', 'view', '1']);
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
      `POST /app/installations/${INSTALLATION_ID}/access_tokens`,
      'GET /installation/repositories?per_page=100',
      'DELETE /installation/token',
    ]);
  }
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
  assert.deepEqual(await spawnChild([process.execPath, '-e', source, 'a b;$(x)'], env, 'ignore'), { kind: 'exited', code: 3, signal: null });
  assert.deepEqual(await spawnChild(['kl-app-token-no-such-command-0'], env, 'ignore'), { kind: 'failed', code: 'ENOENT' });
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
    assert.throws(() => rmSync(marker), 'コマンドが実行された');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
