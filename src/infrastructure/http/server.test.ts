// ローカルHTTPサーバーの境界（ADR-0003の「別タスクで行う検証」のうちT26の項目、ADR-0009）。
// どの試験も、試験ごとの本人専用の一時ディレクトリと、ポート0（OSが選ぶ）の127.0.0.1だけを使う。
import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createServer as createNetServer, connect, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { exchange, ownerOnlyTempDirectory, sameOriginHeaders, send, sendRaw, tokenOf } from '../../../tests/support/http.ts';
import { PRODUCTION_CSP } from './response-headers.ts';
import { PortInUseError, devRequestContext, startLocalServer, type ApiRoute, type LocalServer, type LocalServerOptions } from './server.ts';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../tests/fixtures/http/static/', import.meta.url));

type Harness = { readonly server: LocalServer; readonly logs: string[]; readonly calls: string[]; readonly tokenDir: string };

// 試験用のAPI（合成。製品のAPIではない）。呼ばれた回数を記録して、拒否した要求で処理が呼ばれないことを確かめる。
function testRoutes(calls: string[]): ApiRoute[] {
  return [
    { method: 'GET', path: '/api/test/state', handle: () => (calls.push('state'), { status: 200, body: { state: 'synthetic' } }) },
    { method: 'POST', path: '/api/test/mutate', handle: (r) => (calls.push(`mutate ${JSON.stringify(r.body)}`), { status: 200, body: { ok: true } }) },
    {
      method: 'POST',
      path: '/api/test/upload',
      body: { type: 'octet-stream', maxBytes: 16 },
      handle: (r) => (calls.push(`upload ${(r.body as Buffer).length}`), { status: 200, body: { ok: true } }),
    },
  ];
}

async function withServer(
  options: Partial<LocalServerOptions>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const tmp = ownerOnlyTempDirectory('server');
  const logs: string[] = [];
  const calls: string[] = [];
  const server = await startLocalServer({
    port: 0,
    tokenDirectory: tmp.path,
    api: testRoutes(calls),
    log: (line) => logs.push(line),
    ...options,
  });
  try {
    await fn({ server, logs, calls, tokenDir: tmp.path });
  } finally {
    await server.close();
    tmp.cleanup();
  }
}

function connectionRefused(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket: Socket = connect({ host, port, timeout: 5000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(true));
  });
}

test('127.0.0.1だけで待ち受け、IPv6のループバックとLANのアドレスからは接続できない', async (t) => {
  await withServer({}, async ({ server }) => {
    assert.equal(server.address.address, '127.0.0.1');
    assert.equal(server.address.family, 'IPv4');
    assert.equal((await send(server.port, { path: '/launch' })).status, 200);
    assert.equal(await connectionRefused('::1', server.port), true);
    const lan = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a !== undefined && a.family === 'IPv4' && !a.internal)
      .map((a) => a?.address ?? '')
      .slice(0, 2);
    for (const address of lan) assert.equal(await connectionRefused(address, server.port), true, address);
    t.diagnostic(`LANのIPv4アドレス${lan.length}件で、接続できないことを確かめた`);
  });
});

test('Hostが127.0.0.1:<port>と完全に一致しない要求は、静的ファイルもAPIも拒否する', async () => {
  await withServer({ staticRoot: FIXTURE_ROOT }, async ({ server, calls }) => {
    const cookie = await exchange(server);
    const hosts = [
      `localhost:${server.port}`,
      '127.0.0.1',
      `127.0.0.1:${server.port + 1}`,
      `attacker.example:${server.port}`,
      `[::1]:${server.port}`,
      `127.0.0.1:${server.port}.attacker.example`,
      `0.0.0.0:${server.port}`,
    ];
    for (const host of hosts) {
      for (const path of ['/', '/app.js', '/launch', '/api/test/state']) {
        const res = await send(server.port, { path, headers: { ...sameOriginHeaders(server), host, cookie } });
        assert.equal(res.status, 403, `${host} ${path}`);
        assert.equal(res.text.includes('合成の試験ページ'), false);
      }
    }
    // Hostが2つある要求も拒否する。
    const raw = await sendRaw(server.port, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nHost: attacker.example\r\nConnection: close\r\n\r\n`);
    assert.notEqual(raw.status, 200);
    assert.deepEqual(calls, []);
    assert.equal((await send(server.port, { path: '/' })).status, 200);
  });
});

test('状態を変える要求は、Sec-Fetch-Siteがsame-originか、Originが完全一致しなければ、cookieがあっても拒否する', async () => {
  await withServer({}, async ({ server, calls }) => {
    const cookie = await exchange(server);
    const base = { cookie, 'kurashi-ledger-launch-id': server.launchId, 'content-type': 'application/json' };
    const other = `http://127.0.0.1:${server.port + 1}`;
    const rejected: Array<Record<string, string>> = [
      {},
      { origin: 'null' },
      { origin: other },
      { origin: `http://localhost:${server.port}` },
      { origin: `https://127.0.0.1:${server.port}` },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-site': 'same-site', origin: other },
      { 'sec-fetch-site': 'none' },
      { 'sec-fetch-site': 'same-origin', origin: other },
      { 'sec-fetch-site': 'same-origin', origin: 'null' },
    ];
    for (const extra of rejected) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await send(server.port, { method, path: '/api/test/mutate', headers: { ...base, ...extra }, body: '{}' });
        assert.equal(res.status, 403, `${method} ${JSON.stringify(extra)}`);
      }
    }
    // Sec-Fetch-Siteが2つある要求も拒否する。
    const dup = await send(server.port, {
      method: 'POST',
      path: '/api/test/mutate',
      headers: { ...base, 'sec-fetch-site': ['same-origin', 'cross-site'] },
      body: '{}',
    });
    assert.equal(dup.status, 403);
    assert.deepEqual(calls, []);
    for (const extra of [{ 'sec-fetch-site': 'same-origin' }, { origin: server.origin }, { 'sec-fetch-site': 'same-origin', origin: server.origin }]) {
      const res = await send(server.port, { method: 'POST', path: '/api/test/mutate', headers: { ...base, ...extra }, body: '{"value":1}' });
      assert.equal(res.status, 200, JSON.stringify(extra));
    }
    assert.equal(calls.length, 3);
    // GETのAPIでも、別のサイトのSec-Fetch-Siteや別のOriginがあれば拒否する（追加の防御）。
    assert.equal((await send(server.port, { path: '/api/test/state', headers: { ...base, 'sec-fetch-site': 'same-site' } })).status, 403);
    assert.equal((await send(server.port, { path: '/api/test/state', headers: { ...base, origin: other } })).status, 403);
  });
});

test('状態を変える要求はJSON以外のContent-Typeを拒否し、octet-streamは宣言したエンドポイントだけで上限まで受け付ける', async () => {
  await withServer({}, async ({ server, calls }) => {
    const cookie = await exchange(server);
    const headers = sameOriginHeaders(server, { cookie });
    for (const type of [
      undefined,
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/json; charset=latin1',
      'application/jsonp',
      'application/octet-stream',
    ]) {
      const res = await send(server.port, {
        method: 'POST',
        path: '/api/test/mutate',
        headers: type === undefined ? headers : { ...headers, 'content-type': type },
        body: '{}',
      });
      assert.equal(res.status, 415, String(type));
    }
    assert.equal((await send(server.port, { method: 'POST', path: '/api/test/upload', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status, 415);
    assert.deepEqual(calls, []);
    for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON;Charset="UTF-8"']) {
      assert.equal((await send(server.port, { method: 'POST', path: '/api/test/mutate', headers: { ...headers, 'content-type': type }, body: '{}' })).status, 200, type);
    }
    const octet = { ...headers, 'content-type': 'application/octet-stream' };
    assert.equal((await send(server.port, { method: 'POST', path: '/api/test/upload', headers: octet, body: Buffer.alloc(16, 1) })).status, 200);
    assert.equal((await send(server.port, { method: 'POST', path: '/api/test/upload', headers: octet, body: Buffer.alloc(17, 1) })).status, 413);
    const json = { ...headers, 'content-type': 'application/json' };
    assert.equal((await send(server.port, { method: 'POST', path: '/api/test/mutate', headers: json, body: 'not json' })).status, 400);
    assert.equal((await send(server.port, { method: 'POST', path: '/api/test/mutate', headers: json, body: Buffer.from([0xff, 0xfe]) })).status, 400);
    assert.equal((await send(server.port, { method: 'POST', path: '/api/test/mutate', headers: json, body: `"${'x'.repeat(70 * 1024)}"` })).status, 413);
    assert.deepEqual(calls, ['mutate {}', 'mutate {}', 'mutate {}', 'upload 16']);
  });
});

test('トークン交換のエンドポイントだけがcookieなしで有効な1回限りのトークンを受け付け、交換のあとで一時ファイルを消す', async () => {
  await withServer({}, async ({ server, calls, tokenDir }) => {
    await withServer({}, async ({ server: another }) => {
      const json = sameOriginHeaders(server, { 'content-type': 'application/json' });
      const post = (body: string) => send(server.port, { method: 'POST', path: '/api/session', headers: json, body });
      // ほかのAPIはcookieなしで拒否する。
      assert.equal((await send(server.port, { path: '/api/test/state', headers: sameOriginHeaders(server) })).status, 401);
      // トークンなし・違うトークン・別の起動のトークンは拒否する。
      assert.equal((await post('{}')).status, 403);
      assert.equal((await post('{"token":""}')).status, 403);
      assert.equal((await post('{"token":123}')).status, 403);
      assert.equal((await post(JSON.stringify({ token: `${tokenOf(server).slice(0, -1)}A` }))).status, 403);
      assert.equal((await post(JSON.stringify({ token: tokenOf(another) }))).status, 403);
      assert.equal((await send(server.port, { method: 'GET', path: '/api/session', headers: sameOriginHeaders(server) })).status, 405);
      assert.equal(existsSync(server.launchFile), true);
      // 一時ファイルの中身は、交換用のページのURL（フラグメントにトークン）へ移るHTML。
      assert.equal(readFileSync(server.launchFile, 'utf8').includes(server.tokenUrl), true);

      const ok = await post(JSON.stringify({ token: tokenOf(server) }));
      assert.equal(ok.status, 204);
      assert.equal(ok.text, '');
      const setCookie = String(ok.headers['set-cookie']);
      assert.match(setCookie, new RegExp(`^kl_session_${server.port}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict$`));
      assert.equal(setCookie.includes(tokenOf(server)), false);
      assert.equal(existsSync(server.launchFile), false);
      assert.deepEqual(readdirSync(tokenDir), []);
      // 使用済みのトークンは拒否する。
      assert.equal((await post(JSON.stringify({ token: tokenOf(server) }))).status, 403);
      const cookie = setCookie.split(';')[0] ?? '';
      assert.equal((await send(server.port, { path: '/api/test/state', headers: sameOriginHeaders(server, { cookie }) })).status, 200);
      assert.deepEqual(calls, ['state']);
    });
  });
});

test('ほかのAPIは、cookieなし・違う値・別の起動のcookie（同じポートで起動し直したものを含む）では拒否する', async () => {
  const tmp = ownerOnlyTempDirectory('restart');
  try {
    const calls: string[] = [];
    const first = await startLocalServer({ port: 0, tokenDirectory: tmp.path, api: testRoutes(calls) });
    const oldCookie = await exchange(first);
    const oldLaunchId = first.launchId;
    assert.equal((await send(first.port, { path: '/api/test/state', headers: sameOriginHeaders(first, { cookie: oldCookie }) })).status, 200);
    await first.close();
    const second = await startLocalServer({ port: first.port, tokenDirectory: tmp.path, api: testRoutes(calls) });
    try {
      assert.equal(second.cookieName, first.cookieName);
      const headers = sameOriginHeaders(second);
      assert.equal((await send(second.port, { path: '/api/test/state', headers })).status, 401);
      assert.equal((await send(second.port, { path: '/api/test/state', headers: { ...headers, cookie: oldCookie } })).status, 401);
      assert.equal((await send(second.port, { path: '/api/test/state', headers: { ...headers, cookie: `${second.cookieName}=synthetic` } })).status, 401);
      const newCookie = await exchange(second);
      // 前の起動の識別子（前の起動のUIを開いたままのタブ）は、新しいcookieがあっても409で拒否する。
      const stale = await send(second.port, { path: '/api/test/state', headers: { ...headers, cookie: newCookie, 'kurashi-ledger-launch-id': oldLaunchId } });
      assert.equal(stale.status, 409);
      assert.deepEqual(JSON.parse(stale.text), { error: 'launch-id-mismatch' });
      assert.equal((await send(second.port, { path: '/api/test/state', headers: { ...headers, cookie: `${oldCookie}; ${newCookie}` } })).status, 200);
      assert.deepEqual(calls, ['state', 'state']);
    } finally {
      await second.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test('起動の識別子のないAPI要求は403、形の違う・ほかの起動の識別子の要求は409で拒否する（交換を含む）', async () => {
  await withServer({}, async ({ server, calls }) => {
    const cookie = await exchange(server);
    const { 'Kurashi-Ledger-Launch-Id': _omit, ...withoutId } = sameOriginHeaders(server, { cookie, 'content-type': 'application/json' });
    assert.equal((await send(server.port, { path: '/api/test/state', headers: withoutId })).status, 403);
    assert.equal((await send(server.port, { method: 'POST', path: '/api/test/mutate', headers: withoutId, body: '{}' })).status, 403);
    for (const id of ['x', 'A'.repeat(22), `${server.launchId}x`, server.launchId.toLowerCase() === server.launchId ? 'B'.repeat(22) : server.launchId.toLowerCase()]) {
      assert.equal((await send(server.port, { path: '/api/test/state', headers: { ...withoutId, 'kurashi-ledger-launch-id': id } })).status, 409, id);
    }
    assert.equal(
      (await send(server.port, { path: '/api/test/state', headers: { ...withoutId, 'kurashi-ledger-launch-id': [server.launchId, server.launchId] } })).status,
      403,
    );
    assert.deepEqual(calls, []);
  });
  await withServer({}, async ({ server }) => {
    const { 'Kurashi-Ledger-Launch-Id': _omit, ...withoutId } = sameOriginHeaders(server, { 'content-type': 'application/json' });
    const body = JSON.stringify({ token: tokenOf(server) });
    assert.equal((await send(server.port, { method: 'POST', path: '/api/session', headers: withoutId, body })).status, 403);
    assert.equal((await send(server.port, { method: 'POST', path: '/api/session', headers: { ...withoutId, 'kurashi-ledger-launch-id': 'C'.repeat(22) }, body })).status, 409);
    // 拒否した交換ではトークンを使っていないので、正しい要求なら交換できる。
    assert.match(await exchange(server), /^kl_session_/);
  });
});

test('配信するHTMLと交換用のページの<meta>に起動の識別子が入り、起動ごとに変わる', async () => {
  await withServer({ staticRoot: FIXTURE_ROOT }, async ({ server }) => {
    await withServer({}, async ({ server: placeholder }) => {
      const meta = (id: string) => `<meta name="kurashi-ledger-launch-id" content="${id}">`;
      assert.match(server.launchId, /^[A-Za-z0-9_-]{22}$/);
      assert.notEqual(server.launchId, placeholder.launchId);
      for (const path of ['/', '/index.html', '/launch']) {
        const res = await send(server.port, { path });
        assert.equal(res.status, 200, path);
        assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(res.text.split(meta(server.launchId)).length, 2, path);
      }
      for (const path of ['/app.js', '/style.css', '/launch.js']) {
        const res = await send(server.port, { path });
        assert.equal(res.status, 200, path);
        assert.equal(res.text.includes(server.launchId), false, path);
      }
      // 配信ルートがない（npm startのT26の段階）ときは、/ で案内ページだけを返す。
      const home = await send(placeholder.port, { path: '/' });
      assert.equal(home.status, 200);
      assert.equal(home.text.includes(meta(placeholder.launchId)), true);
      assert.equal((await send(placeholder.port, { path: '/app.js' })).status, 404);
    });
  });
});

test('すべての応答にCSP・no-store・no-referrer等が付き、CORSのヘッダは返らない', async () => {
  await withServer({ staticRoot: FIXTURE_ROOT }, async ({ server }) => {
    const cookie = await exchange(server);
    const requests = [
      { path: '/' },
      { path: '/app.js' },
      { path: '/style.css' },
      { path: '/launch' },
      { path: '/launch.js' },
      { path: '/missing.js' },
      { path: '/../x' },
      { method: 'HEAD', path: '/' },
      { method: 'POST', path: '/' },
      { path: '/api/test/state', headers: sameOriginHeaders(server, { cookie }) },
      { path: '/api/test/state' },
      { path: '/api/unknown', headers: sameOriginHeaders(server, { cookie }) },
      { method: 'OPTIONS', path: '/api/test/mutate', headers: { origin: 'http://attacker.example', 'access-control-request-method': 'POST' } },
      { path: '/', headers: { host: 'attacker.example' } },
    ];
    for (const request of requests) {
      const res = await send(server.port, request);
      const label = `${request.method ?? 'GET'} ${request.path} ${res.status}`;
      assert.equal(res.headers['content-security-policy'], PRODUCTION_CSP, label);
      assert.equal(res.headers['cache-control'], 'no-store', label);
      assert.equal(res.headers['referrer-policy'], 'no-referrer', label);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', label);
      assert.deepEqual(Object.keys(res.headers).filter((h) => h.startsWith('access-control-')), [], label);
      if (request.path.startsWith('/api/')) assert.equal(res.headers['content-type'], 'application/json; charset=utf-8', label);
    }
    assert.equal(PRODUCTION_CSP.includes('nonce-'), false);
    assert.equal(PRODUCTION_CSP.includes('unsafe'), false);
  });
});

test('静的配信は、生の要求の..・エンコードした区切り文字・バックスラッシュ・外を指すリンクで範囲外のファイルを返さない', async () => {
  const tmp = ownerOnlyTempDirectory('static-server');
  try {
    const root = join(tmp.path, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'index.html'), '<html><head></head><body>root</body></html>');
    writeFileSync(join(tmp.path, 'secret.txt'), 'outside-secret');
    symlinkSync(tmp.path, join(root, 'up'), process.platform === 'win32' ? 'junction' : 'dir');
    await withServer({ staticRoot: root }, async ({ server }) => {
      const targets = [
        '/../secret.txt',
        '/%2e%2e/secret.txt',
        '/%2e%2e%2fsecret.txt',
        '/..%5csecret.txt',
        '/%252e%252e%252fsecret.txt',
        '/..\\secret.txt',
        '/up/secret.txt',
        '/C:/secret.txt',
        '/',
      ];
      for (const target of targets) {
        const res = await sendRaw(server.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`);
        assert.equal(res.raw.includes('outside-secret'), false, target);
        assert.match(res.raw, /\r\ncache-control: no-store\r\n/i, target);
        if (target === '/') assert.equal(res.status, 200);
        else assert.ok(res.status === 400 || res.status === 404, `${target} ${res.status}`);
      }
      // 絶対形式の要求の対象（プロキシ向けの形）も受け付けない。
      const absolute = await sendRaw(server.port, `GET http://127.0.0.1:${server.port}/../secret.txt HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`);
      assert.equal(absolute.status, 400);
    });
  } finally {
    tmp.cleanup();
  }
});

test('要求ログとサーバーへの要求のURLに、トークン・cookieの値・クエリ・本文が出ない', async () => {
  const seen: Array<{ url: string; referer: string | undefined; port: number | undefined }> = [];
  const observer = (message: unknown): void => {
    const { request, socket } = message as { request: IncomingMessage; socket: Socket };
    seen.push({ url: request.url ?? '', referer: request.headers.referer, port: socket.localPort });
  };
  subscribe('http.server.request.start', observer);
  try {
    await withServer({ staticRoot: FIXTURE_ROOT }, async ({ server, logs }) => {
      const token = tokenOf(server);
      await send(server.port, { path: '/launch' });
      await send(server.port, { path: '/launch.js' });
      const cookie = await exchange(server);
      const sessionValue = cookie.split('=')[1] ?? '';
      await send(server.port, { path: '/api/test/state?secret-query=synthetic', headers: sameOriginHeaders(server, { cookie }) });
      await send(server.port, {
        method: 'POST',
        path: '/api/test/mutate',
        headers: sameOriginHeaders(server, { cookie, 'content-type': 'application/json' }),
        body: '{"value":"synthetic-body"}',
      });
      await send(server.port, { path: '/?q=synthetic-query' });
      const mine = seen.filter((s) => s.port === server.port);
      assert.ok(mine.length >= 6);
      for (const s of mine) {
        assert.equal(s.url.includes(token), false);
        assert.equal(s.referer, undefined);
      }
      assert.ok(logs.length >= 6);
      for (const line of logs) {
        for (const secret of [token, sessionValue, 'secret-query', 'synthetic-query', 'synthetic-body', 'kl_session']) {
          assert.equal(line.includes(secret), false, line);
        }
      }
      assert.ok(logs.some((line) => line === 'POST /api/session 204'));
      assert.ok(logs.some((line) => line === 'GET /api/test/state 200'));
    });
  } finally {
    unsubscribe('http.server.request.start', observer);
  }
});

test('ポートが使用中なら別のポートへ移らずに止まり、一時ファイルを作らない', async () => {
  const blocker = createNetServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
  const port = (blocker.address() as { port: number }).port;
  const tmp = ownerOnlyTempDirectory('inuse');
  try {
    await assert.rejects(startLocalServer({ port, tokenDirectory: tmp.path }), (error: unknown) => {
      assert.ok(error instanceof PortInUseError);
      assert.equal(error.port, port);
      return true;
    });
    assert.deepEqual(readdirSync(tmp.path), []);
  } finally {
    blocker.close();
    tmp.cleanup();
  }
});

test('closeで待受を止め、一時ファイルを消し、トークンを無効にする（2回呼んでも同じ）', async () => {
  const tmp = ownerOnlyTempDirectory('close');
  try {
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path });
    assert.equal(existsSync(server.launchFile), true);
    await Promise.all([server.close(), server.close()]);
    assert.equal(existsSync(server.launchFile), false);
    assert.deepEqual(readdirSync(tmp.path), []);
    assert.equal(await connectionRefused('127.0.0.1', server.port), true);
  } finally {
    tmp.cleanup();
  }
});

test('開発時の口: middlewareとupgradeには検査を通った要求だけが届き、応答の共通のヘッダは外れず、nonceは応答ごとに変わる', async () => {
  const middlewareCalls: string[] = [];
  const upgrades: string[] = [];
  const dev: LocalServerOptions['dev'] = {
    middleware(req, res, next) {
      middlewareCalls.push(req.url ?? '');
      if (req.url === '/next') return next();
      const context = devRequestContext(req);
      // 開発のサーバーがCORSやキャッシュのヘッダを付けようとしても、出口で外れる・付け直される。
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'max-age=31536000, immutable');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Credentials': 'true', 'Content-Security-Policy': "default-src *" });
      res.end(`<html><head></head><body data-nonce="${context?.nonce ?? ''}" data-launch="${context?.launchId ?? ''}"></body></html>`);
    },
    upgrade(req, socket) {
      upgrades.push(req.url ?? '');
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    },
  };
  await withServer({ dev }, async ({ server }) => {
    const first = await send(server.port, { path: '/src/main.tsx' });
    const second = await send(server.port, { path: '/src/main.tsx' });
    const nonces = [first, second].map((r) => /data-nonce="([^"]+)"/.exec(r.text)?.[1] ?? '');
    assert.notEqual(nonces[0], nonces[1]);
    for (const [i, res] of [first, second].entries()) {
      assert.equal(res.status, 200);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual(Object.keys(res.headers).filter((h) => h.startsWith('access-control-')), []);
      assert.equal(
        res.headers['content-security-policy'],
        `default-src 'self'; script-src 'self' 'nonce-${nonces[i]}'; style-src 'self' 'nonce-${nonces[i]}'; connect-src 'self' ws://127.0.0.1:${server.port}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      );
      assert.equal(res.text.includes(`data-launch="${server.launchId}"`), true);
    }
    // 交換用のページとAPIは、開発時でも本番のCSPで、middlewareに渡らない。
    assert.equal((await send(server.port, { path: '/launch' })).headers['content-security-policy'], PRODUCTION_CSP);
    assert.equal((await send(server.port, { path: '/api/test/state' })).status, 403);
    assert.equal((await send(server.port, { path: '/next' })).status, 404);
    assert.equal((await send(server.port, { path: '/src/main.tsx', headers: { host: `localhost:${server.port}` } })).status, 403);
    assert.equal((await send(server.port, { method: 'POST', path: '/src/main.tsx', headers: sameOriginHeaders(server) })).status, 405);
    assert.deepEqual(middlewareCalls, ['/src/main.tsx', '/src/main.tsx', '/next']);

    const cookie = await exchange(server);
    const upgrade = (headers: string) =>
      sendRaw(server.port, `GET /hmr HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: c3ludGhldGljLWtleS0xMjM0NQ==\r\n${headers}\r\n`);
    const good = `Host: 127.0.0.1:${server.port}\r\nOrigin: ${server.origin}\r\nCookie: ${cookie}\r\n`;
    assert.equal((await upgrade(good.replace(`Host: 127.0.0.1:${server.port}`, `Host: localhost:${server.port}`))).status, 403);
    assert.equal((await upgrade(good.replace(`Origin: ${server.origin}`, `Origin: http://127.0.0.1:${server.port + 1}`))).status, 403);
    assert.equal((await upgrade(good.replace(`Origin: ${server.origin}\r\n`, ''))).status, 403);
    assert.equal((await upgrade(`${good}Sec-Fetch-Site: same-site\r\n`)).status, 403);
    assert.equal((await upgrade(good.replace(`Cookie: ${cookie}\r\n`, ''))).status, 401);
    assert.deepEqual(upgrades, []);
    assert.equal((await upgrade(good)).status, 101);
    assert.deepEqual(upgrades, ['/hmr']);
  });
  // 開発時の口がなければ、検査を通ったupgradeも受け付けない。
  await withServer({}, async ({ server }) => {
    const cookie = await exchange(server);
    const res = await sendRaw(
      server.port,
      `GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nOrigin: ${server.origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    );
    assert.equal(res.status, 404);
  });
});

test('配信ルートと開発時の口を同時に渡す、不正なAPIのパスを登録する設定は起動しない', async () => {
  const tmp = ownerOnlyTempDirectory('config');
  try {
    const dev = { middleware: () => {} };
    await assert.rejects(startLocalServer({ port: 0, tokenDirectory: tmp.path, staticRoot: FIXTURE_ROOT, dev }), /同時に使えない/);
    const handle = () => ({ status: 200 });
    await assert.rejects(startLocalServer({ port: 0, tokenDirectory: tmp.path, api: [{ method: 'POST', path: '/api/session', handle }] }), /使えない/);
    await assert.rejects(startLocalServer({ port: 0, tokenDirectory: tmp.path, api: [{ method: 'GET', path: '/state', handle }] }), /使えない/);
    await assert.rejects(
      startLocalServer({ port: 0, tokenDirectory: tmp.path, api: [{ method: 'GET', path: '/api/a', handle }, { method: 'GET', path: '/api/a', handle }] }),
      /2回/,
    );
    assert.deepEqual(readdirSync(tmp.path), []);
  } finally {
    tmp.cleanup();
  }
});
