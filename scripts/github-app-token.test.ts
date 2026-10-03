// scripts/github-app-token.ts と scripts/lib/github-app-token.ts の試験（docs/github-apps.md）。
// 鍵は試験の中で生成したRSA鍵だけを使う。ネットワーク・キーチェーンは使わない（fetchとキーチェーンの読取りは注入する）。
// 秘密の番兵（トークン等）は、公開検査の型に当たらないよう、実行時に組み立てる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  API_ORIGIN,
  API_VERSION,
  JWT_BACKDATE_SECONDS,
  JWT_LIFETIME_SECONDS,
  KEYCHAIN_TOOL,
  MAX_KEY_BYTES,
  AGENTS,
  PURPOSES,
  REPOSITORY_NAME,
  TokenError,
  UsageError,
  createAppJwt,
  keyFileProblem,
  loadPrivateKey,
  parseArgs,
  pemFromKeyMaterial,
  readKeyFileFromDisk,
  readKeychainKey,
  run,
  sanitize,
  tokenRequest,
  type Deps,
  type ExecFileLike,
  type FetchInit,
  type FetchLike,
  type Purpose,
} from './lib/github-app-token.ts';

const SCRIPT = join(import.meta.dirname, 'github-app-token.ts');
const NOW = 1_900_000_000;
const APP_ID = '123456';
const INSTALLATION_ID = '7654321';

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

type Call = { readonly url: string; readonly init: FetchInit };

function fakeFetch(responses: readonly { status: number; body: string }[] | ((url: string) => never)): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (typeof responses === 'function') return responses(url);
    const r = responses[i++];
    assert.ok(r !== undefined, '想定より多い要求');
    return { status: r.status, text: async () => r.body };
  };
  return { fetch, calls };
}

function makeDeps(overrides: Partial<Deps> = {}): { deps: Deps; out: string[]; err: string[]; keychainCalls: string[][] } {
  const out: string[] = [];
  const err: string[] = [];
  const keychainCalls: string[][] = [];
  const deps: Deps = {
    env: {},
    platform: 'darwin',
    uid: 501,
    username: 'synthetic-user',
    nowSeconds: () => NOW,
    fetch: fakeFetch([{ status: 201, body: grantedBody('review') }]).fetch,
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
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...overrides,
  };
  return { deps, out, err, keychainCalls };
}

function assertNoSecrets(text: string, extra: readonly string[] = []): void {
  for (const secret of [TOKEN, PEM, PEM_BASE64, ...PEM_BODY_LINES, ...extra]) {
    assert.ok(!text.includes(secret), `出力に秘密が含まれる（長さ${secret.length}）`);
  }
  assert.doesNotMatch(text, /eyJ[A-Za-z0-9_-]{10,}\./, 'JWTらしい文字列が出力にある');
}

const ARGS = ['--agent', 'codex', '--purpose', 'review', '--app-id', APP_ID, '--installation-id', INSTALLATION_ID];

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
  assert.deepEqual(JSON.parse(r.body), {
    repositories: ['kurashi-ledger'],
    permissions: { pull_requests: 'write', contents: 'read', actions: 'read' },
  });
  assert.deepEqual(JSON.parse(tokenRequest(INSTALLATION_ID, 'x', 'implement').body), {
    repositories: ['kurashi-ledger'],
    permissions: { contents: 'write', pull_requests: 'write', issues: 'write', actions: 'read', workflows: 'write' },
  });
  for (const purpose of ['review', 'implement'] as const) {
    assert.ok(!('administration' in PURPOSES[purpose]), `${purpose}にadministrationがある`);
  }
});

test('AIごとのキーチェーンのserviceと環境変数を使い、--agentと--purposeを必須にする', () => {
  const env = {
    KL_GITHUB_APP_ID_CODEX: '11',
    KL_GITHUB_APP_INSTALLATION_ID_CODEX: '12',
    KL_GITHUB_APP_ID_CLAUDE: '21',
    KL_GITHUB_APP_INSTALLATION_ID_CLAUDE: '22',
  };
  assert.deepEqual(parseArgs(['--agent', 'codex', '--purpose', 'review'], env), {
    help: false,
    options: { agent: 'codex', purpose: 'review', appId: '11', installationId: '12', key: { kind: 'keychain', service: 'kurashi-ledger-codex-reviewer' } },
  });
  // どちらのAIもどちらの用途にも使える。serviceの名前は所有者が登録した昔の呼び名のまま。
  assert.deepEqual(parseArgs(['--agent', 'claude', '--purpose', 'review'], env), {
    help: false,
    options: { agent: 'claude', purpose: 'review', appId: '21', installationId: '22', key: { kind: 'keychain', service: 'kurashi-ledger-claude-implementer' } },
  });
  assert.deepEqual(parseArgs(['--purpose', 'implement', '--agent', 'codex', '--keychain-service', 'synthetic-service'], env), {
    help: false,
    options: { agent: 'codex', purpose: 'implement', appId: '11', installationId: '12', key: { kind: 'keychain', service: 'synthetic-service' } },
  });
  // 引数は環境変数より優先する。
  const flagged = parseArgs(['--agent', 'codex', '--purpose', 'review', '--app-id', '31', '--installation-id', '32', '--key-file', 'k.pem'], env);
  assert.deepEqual(flagged, { help: false, options: { agent: 'codex', purpose: 'review', appId: '31', installationId: '32', key: { kind: 'file', path: 'k.pem' } } });
  assert.throws(() => parseArgs([], env), UsageError);
  assert.throws(() => parseArgs(['--agent', 'codex'], env), UsageError);
  assert.throws(() => parseArgs(['--purpose', 'review'], env), UsageError);
  assert.throws(() => parseArgs(['--agent', 'copilot', '--purpose', 'review'], env), UsageError);
  assert.throws(() => parseArgs(['--agent', 'codex', '--purpose', 'admin'], env), UsageError);
  // AIの環境変数を取り違えない（codexでclaudeの環境変数を読まない）。
  assert.throws(() => parseArgs(['--agent', 'codex', '--purpose', 'review'], { KL_GITHUB_APP_ID_CLAUDE: '21', KL_GITHUB_APP_INSTALLATION_ID_CLAUDE: '22' }), UsageError);
  assert.throws(() => parseArgs(['--agent', 'codex', '--purpose', 'review', '--key-file', 'a', '--key-stdin'], env), UsageError);
  assert.throws(() => parseArgs(['--agent', 'codex', '--agent', 'codex', '--purpose', 'review'], env), UsageError);
  assert.throws(() => parseArgs(['--agent', 'codex', '--purpose', 'review', '--keychain-service', 'bad name;rm'], env), UsageError);
});

test('IDは数字だけを受け付け、拒んだ値をエラーに出さない', () => {
  for (const bad of ['', '0', '012', '12a', '-1', '1e3', ' 12', '12 ', '１２', '1'.repeat(20), '12/../x']) {
    assert.throws(
      () => parseArgs(['--agent', 'codex', '--purpose', 'review', '--app-id', bad, '--installation-id', '5'], {}),
      (e: unknown) => e instanceof UsageError && (bad.length < 3 || !e.message.includes(bad)),
      `受け付けてしまう: ${JSON.stringify(bad)}`,
    );
    assert.throws(() => parseArgs(['--agent', 'codex', '--purpose', 'review', '--app-id', '5', '--installation-id', bad], {}), UsageError);
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
  assert.match(keyFileProblem(file, { ...file, size: MAX_KEY_BYTES + 1 }, 'darwin', 501) ?? '', /大きすぎる/);
  for (const mode of [0o100640, 0o100604, 0o100644, 0o100660, 0o100700 | 0o001]) {
    assert.match(keyFileProblem(file, { ...file, mode }, 'darwin', 501) ?? '', /chmod 600/, mode.toString(8));
  }
  assert.match(keyFileProblem(file, { ...file, uid: 0 }, 'linux', 501) ?? '', /所有者/);
  // Windowsは権限のビットを確かめない（docs/github-apps.md）。
  assert.equal(keyFileProblem(file, { ...file, mode: 0o100666 }, 'win32', undefined), null);
});

test('実際のファイルで: 権限600の鍵ファイルは読め、644はmacOS・Linuxで拒む（Windowsは警告を出して読む）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kl-app-token-'));
  try {
    const path = join(dir, 'synthetic-key.pem');
    writeFileSync(path, PEM, { mode: 0o600 });
    chmodSync(path, 0o600);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const ok = readKeyFileFromDisk(path, process.platform, uid);
    assert.equal(ok.text, PEM);
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
    assert.throws(() => readKeyFileFromDisk(join(dir, 'missing.pem'), process.platform, uid), TokenError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('キーチェーンは/usr/bin/securityを決めた引数で呼び、失敗の出力を表示しない。macOS以外では使わない', async () => {
  const calls: { file: string; args: readonly string[]; options: object }[] = [];
  const ok: ExecFileLike = async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: `${PEM_BASE64}\n` };
  };
  assert.equal(await readKeychainKey('kurashi-ledger-codex-reviewer', 'synthetic-user', 'darwin', ok), `${PEM_BASE64}\n`);
  assert.equal(KEYCHAIN_TOOL, '/usr/bin/security');
  assert.deepEqual(calls[0]?.file, '/usr/bin/security');
  assert.deepEqual(calls[0]?.args, ['find-generic-password', '-s', 'kurashi-ledger-codex-reviewer', '-a', 'synthetic-user', '-w']);
  assert.ok(!('shell' in (calls[0]?.options ?? {})), 'シェルを使う設定がある');
  assert.ok((calls[0]?.options as { timeout?: number }).timeout !== undefined, '時間の上限がない');

  const sentinel = 'SENTINEL-STDERR-FROM-SECURITY-0123456789';
  const missing: ExecFileLike = async () => {
    throw Object.assign(new Error(`Command failed: ${sentinel}`), { code: 44, stderr: sentinel });
  };
  await assert.rejects(readKeychainKey('kurashi-ledger-codex-reviewer', 'u', 'darwin', missing), (e: unknown) => {
    assert.ok(e instanceof TokenError);
    assert.match(e.message, /項目がない/);
    assert.ok(!e.message.includes(sentinel));
    return true;
  });
  const other: ExecFileLike = async () => {
    throw Object.assign(new Error(sentinel), { code: 51, stderr: sentinel });
  };
  await assert.rejects(readKeychainKey('s', 'u', 'darwin', other), (e: unknown) => e instanceof TokenError && !e.message.includes(sentinel));
  await assert.rejects(readKeychainKey('s', 'u', 'linux', ok), TokenError);
  await assert.rejects(readKeychainKey('s', 'u', 'win32', ok), TokenError);
  assert.equal(calls.length, 1);
});

test('成功すると、標準出力にはトークンと改行だけを出し、キーチェーンの既定のserviceと実行中のユーザーを使う', async () => {
  const { fetch, calls } = fakeFetch([{ status: 201, body: grantedBody('review') }]);
  const { deps, out, err, keychainCalls } = makeDeps({ fetch });
  assert.equal(await run(ARGS, deps), 0);
  assert.deepEqual(out, [`${TOKEN}\n`]);
  assert.deepEqual(keychainCalls, [['kurashi-ledger-codex-reviewer', 'synthetic-user']]);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.url, `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
  assert.equal(call.init.method, 'POST');
  assert.ok(call.init.signal instanceof AbortSignal, '時間の上限（AbortSignal）がない');
  const jwt = (call.init.headers['Authorization'] ?? '').replace(/^Bearer /, '');
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(decodeSegment(p), { iat: NOW - 60, exp: NOW + 540, iss: APP_ID });
  assert.ok(s !== undefined && verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')));
  assertNoSecrets(err.join(''), [jwt]);
});

test('claudeのAppとimplementの用途は、自分のservice・環境変数・権限を使う', async () => {
  const { fetch, calls } = fakeFetch([{ status: 201, body: grantedBody('implement') }]);
  const { deps, out, keychainCalls } = makeDeps({
    fetch,
    env: { KL_GITHUB_APP_ID_CLAUDE: '99', KL_GITHUB_APP_INSTALLATION_ID_CLAUDE: '98', KL_GITHUB_APP_ID_CODEX: '1', KL_GITHUB_APP_INSTALLATION_ID_CODEX: '2' },
  });
  assert.equal(await run(['--agent', 'claude', '--purpose', 'implement'], deps), 0);
  assert.deepEqual(out, [`${TOKEN}\n`]);
  assert.deepEqual(keychainCalls, [['kurashi-ledger-claude-implementer', 'synthetic-user']]);
  assert.equal(calls[0]?.url, 'https://api.github.com/app/installations/98/access_tokens');
  assert.deepEqual(JSON.parse(calls[0]?.init.body ?? '{}').permissions, PURPOSES.implement);
  const payload = decodeSegment((calls[0]?.init.headers['Authorization'] ?? '').split('.')[1]);
  assert.deepEqual(payload, { iat: NOW - 60, exp: NOW + 540, iss: '99' });
});

test('用途がreviewなら、App全体の権限ではなくreviewの権限だけを求め、多く付いたトークンは使わない', async () => {
  const { fetch, calls } = fakeFetch([
    { status: 201, body: grantedBody('implement') },
    { status: 204, body: '' },
  ]);
  const { deps, out } = makeDeps({ fetch, env: { KL_GITHUB_APP_ID_CLAUDE: '99', KL_GITHUB_APP_INSTALLATION_ID_CLAUDE: '98' } });
  assert.equal(await run(['--agent', 'claude', '--purpose', 'review'], deps), 1);
  assert.deepEqual(out, []);
  assert.deepEqual(JSON.parse(calls[0]?.init.body ?? '{}').permissions, PURPOSES.review);
  assert.equal(calls[1]?.init.method, 'DELETE');
});

test('鍵は--key-fileと--key-stdinからも読め、PEMとそのbase64のどちらも受け付ける', async () => {
  for (const material of [PEM, PEM_BASE64]) {
    const file = makeDeps({ fetch: fakeFetch([{ status: 201, body: grantedBody('review') }]).fetch, readKeyFile: () => ({ text: material }) });
    assert.equal(await run([...ARGS, '--key-file', 'synthetic.pem'], file.deps), 0);
    assert.deepEqual(file.out, [`${TOKEN}\n`]);
    assert.deepEqual(file.keychainCalls, []);
    const stdin = makeDeps({ fetch: fakeFetch([{ status: 201, body: grantedBody('review') }]).fetch, readStdin: async () => material });
    assert.equal(await run([...ARGS, '--key-stdin'], stdin.deps), 0);
    assert.deepEqual(stdin.out, [`${TOKEN}\n`]);
  }
});

test('失敗の経路では、標準出力に何も出さず、鍵・JWT・トークンを標準エラーにも出さない', async () => {
  let capturedJwt = '';
  const capture = (status: number, body: (jwt: string) => string): FetchLike => async (_url, init) => {
    capturedJwt = (init.headers['Authorization'] ?? '').replace(/^Bearer /, '');
    return { status, text: async () => body(capturedJwt) };
  };
  const cases: { name: string; deps: Partial<Deps>; args?: string[]; status: number; expect: RegExp }[] = [
    { name: 'HTTP 401', deps: { fetch: capture(401, () => JSON.stringify({ message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' })) }, status: 1, expect: /HTTP 401.*Bad credentials/ },
    { name: 'GitHubのメッセージがJWT・鍵・トークンを含む', deps: { fetch: capture(422, (jwt) => JSON.stringify({ message: `echo ${jwt} ${PEM} ${TOKEN} ${PEM_BODY_LINES[0]}` })) }, status: 1, expect: /HTTP 422/ },
    { name: 'JSONでない失敗の応答', deps: { fetch: capture(502, (jwt) => `<html>${jwt}</html>`) }, status: 1, expect: /HTTP 502.*メッセージなし/ },
    {
      name: '通信の失敗（例外のメッセージにJWTを含む）',
      deps: {
        fetch: async (_url, init) => {
          capturedJwt = (init.headers['Authorization'] ?? '').replace(/^Bearer /, '');
          throw Object.assign(new Error(`connect failed ${capturedJwt} ${PEM}`), { name: 'TypeError', cause: { code: 'ECONNREFUSED' } });
        },
      },
      status: 1,
      expect: /要求が失敗した（TypeError・ECONNREFUSED）/,
    },
    { name: '時間切れ', deps: { fetch: async () => { throw new DOMException(`timeout ${TOKEN}`, 'TimeoutError'); } }, status: 1, expect: /TimeoutError/ },
    { name: '201だがトークンがない', deps: { fetch: capture(201, () => JSON.stringify({ permissions: {} })) }, status: 1, expect: /トークンがない/ },
    { name: '201だがトークンに改行がある', deps: { fetch: capture(201, () => grantedBody('review', { token: `${TOKEN}\nextra` })) }, status: 1, expect: /形式が違う/ },
    { name: 'キーチェーンの失敗', deps: { readKeychain: async () => { throw new TokenError('キーチェーンから読めなかった（終了コード 51）。'); } }, status: 1, expect: /終了コード 51/ },
    { name: '鍵が壊れている', deps: { readKeychain: async () => Buffer.from(PEM.split('\n').map((l) => (l.startsWith('-----') ? l : l.replace(/[A-Za-z]/g, 'A'))).join('\n'), 'utf8').toString('base64') }, status: 1, expect: /秘密鍵を読めなかった/ },
    { name: '鍵の読取りが予期しない例外', deps: { readKeychain: async () => { throw new Error(`unexpected ${PEM}`); } }, status: 1, expect: /予期しないエラー（Error）/ },
    { name: '引数の誤り', deps: {}, args: ['--agent', 'codex', '--purpose', 'review', '--app-id', PEM_BASE64.slice(0, 40), '--installation-id', '1'], status: 2, expect: /数字だけ/ },
  ];
  for (const c of cases) {
    capturedJwt = '';
    const { deps, out, err } = makeDeps(c.deps);
    const code = await run(c.args ?? ARGS, deps);
    const stderr = err.join('');
    assert.equal(code, c.status, c.name);
    assert.deepEqual(out, [], `${c.name}: 標準出力に何かを出した`);
    assert.match(stderr, c.expect, `${c.name}: ${stderr}`);
    assertNoSecrets(stderr, capturedJwt === '' ? [] : [capturedJwt]);
  }
});

test('発行された権限・repoが要求と違えば、トークンを出さずに失効させる', async () => {
  const overrides: Record<string, unknown>[] = [
    { permissions: { ...PURPOSES.review, metadata: 'read', administration: 'write' } },
    { permissions: { ...PURPOSES.review, contents: 'write', metadata: 'read' } },
    { permissions: { pull_requests: 'write', metadata: 'read' } },
    { repository_selection: 'all' },
    { repositories: [{ name: REPOSITORY_NAME }, { name: 'other' }] },
  ];
  for (const o of overrides) {
    const { fetch, calls } = fakeFetch([
      { status: 201, body: grantedBody('review', o) },
      { status: 204, body: '' },
    ]);
    const { deps, out, err } = makeDeps({ fetch });
    assert.equal(await run(ARGS, deps), 1, JSON.stringify(o));
    assert.deepEqual(out, []);
    const stderr = err.join('');
    assert.match(stderr, /範囲が要求と違う.*失効させた/);
    assertNoSecrets(stderr);
    assert.equal(calls[1]?.url, 'https://api.github.com/installation/token');
    assert.equal(calls[1]?.init.method, 'DELETE');
    assert.equal(calls[1]?.init.headers['Authorization'], `Bearer ${TOKEN}`);
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

test('スクリプトを実行しても、引数の誤りと鍵ファイルの拒否では、標準出力に何も出さずネットワークに出ない', () => {
  // ネットワークに出る前に止まる経路だけを、実際のプロセスで確かめる。
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(NODE_|KL_GITHUB_APP_)/i.test(k)) env[k] = v;
  const usage = spawnSync(process.execPath, [SCRIPT, '--agent', 'codex', '--purpose', 'review', '--app-id', 'abc', '--installation-id', '1'], { env, encoding: 'utf8' });
  assert.equal(usage.status, 2, usage.stderr);
  assert.equal(usage.stdout, '');
  assert.match(usage.stderr, /数字だけ/);
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.equal(help.stdout, '');
  assert.match(help.stderr, /--agent/);
  const missingAgent = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(missingAgent.status, 2);
  assert.equal(missingAgent.stdout, '');
  if (process.platform !== 'win32') {
    const dir = mkdtempSync(join(tmpdir(), 'kl-app-token-'));
    try {
      const path = join(dir, 'synthetic-key.pem');
      writeFileSync(path, PEM);
      chmodSync(path, 0o644);
      const r = spawnSync(process.execPath, [SCRIPT, ...ARGS, '--key-file', path], { env, encoding: 'utf8' });
      assert.equal(r.status, 1, r.stderr);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /chmod 600/);
      assertNoSecrets(r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    // Windowsでは権限を確かめないので、壊れた鍵ファイルで、ネットワークに出る前に止まることを確かめる。
    const dir = mkdtempSync(join(tmpdir(), 'kl-app-token-'));
    try {
      const path = join(dir, 'synthetic-key.pem');
      writeFileSync(path, 'SENTINEL-NOT-A-KEY');
      const r = spawnSync(process.execPath, [SCRIPT, ...ARGS, '--key-file', path], { env, encoding: 'utf8' });
      assert.equal(r.status, 1, r.stderr);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /鍵の形式が違う/);
      assert.ok(!r.stderr.includes('SENTINEL-NOT-A-KEY'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
