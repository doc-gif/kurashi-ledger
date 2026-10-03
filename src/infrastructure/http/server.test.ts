// ローカルHTTPサーバーの境界（ADR-0003の「別タスクで行う検証」のうちT26の項目、ADR-0009）。
// どの試験も、試験ごとの本人専用の一時ディレクトリと、ポート0（OSが選ぶ）の127.0.0.1だけを使う。
import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createServer as createNetServer, connect, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { exchange, ownerOnlyTempDirectory, sameOriginHeaders, send, sendRaw, tokenOf } from '../../../tests/support/http.ts';
import { PRODUCTION_CSP } from './response-headers.ts';
import { PortInUseError, devRequestContext, startLocalServer, type ApiRoute, type LocalServer, type LocalServerOptions } from './server.ts';
import type { StaticSource } from './static-files.ts';

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
      // 最後の1文字だけを、必ず違う文字に変える（同じ文字に変えると正しいトークンになり、64回に1回は誤って成功する）。
      const token = tokenOf(server);
      const altered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
      assert.equal((await post(JSON.stringify({ token: altered }))).status, 403);
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
      for (const path of ['/', '/index.html', '/launch', '/tricky.html']) {
        const res = await send(server.port, { path });
        assert.equal(res.status, 200, path);
        assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
        assert.equal(res.text.split(meta(server.launchId)).length, 2, path);
        // コメントの中ではなく、実際の<head>の直後に入る。
        assert.equal(res.text.includes(`<head>${meta(server.launchId)}`), true, path);
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
  let tmp: ReturnType<typeof ownerOnlyTempDirectory> | undefined;
  try {
    tmp = ownerOnlyTempDirectory('inuse');
    await assert.rejects(startLocalServer({ port, tokenDirectory: tmp.path }), (error: unknown) => {
      assert.ok(error instanceof PortInUseError);
      assert.equal(error.port, port);
      return true;
    });
    assert.deepEqual(readdirSync(tmp.path), []);
  } finally {
    blocker.close();
    tmp?.cleanup();
  }
});

test('closeで待受を止め、一時ファイルを消した結果（removed・missing・replaced）を返し、トークンを無効にする（2回呼んでも同じ）', async () => {
  const tmp = ownerOnlyTempDirectory('close');
  try {
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path });
    assert.equal(existsSync(server.launchFile), true);
    const [first, second] = await Promise.all([server.close(), server.close()]);
    assert.deepEqual(first, { launchFile: 'removed', launchFilePath: server.launchFile });
    assert.deepEqual(second, first);
    assert.equal(existsSync(server.launchFile), false);
    assert.deepEqual(readdirSync(tmp.path), []);
    assert.equal(await connectionRefused('127.0.0.1', server.port), true);

    // 交換のときに消したあとはremoved、誰かが先に消していればmissing。
    const exchanged = await startLocalServer({ port: 0, tokenDirectory: tmp.path });
    await exchange(exchanged);
    assert.equal((await exchanged.close()).launchFile, 'removed');
    const gone = await startLocalServer({ port: 0, tokenDirectory: tmp.path });
    rmSync(gone.launchFile);
    assert.equal((await gone.close()).launchFile, 'missing');
    // 作ったものと違うファイルに置き換わっていれば、消さずにreplacedを返す。
    const replaced = await startLocalServer({ port: 0, tokenDirectory: tmp.path });
    writeFileSync(join(tmp.path, 'other.html'), 'someone else');
    renameSync(join(tmp.path, 'other.html'), replaced.launchFile);
    assert.deepEqual(await replaced.close(), { launchFile: 'replaced', launchFilePath: replaced.launchFile });
    assert.equal(readFileSync(replaced.launchFile, 'utf8'), 'someone else');
  } finally {
    tmp.cleanup();
  }
});

test('一時ファイルを消せないとき、closeは待受を止めトークンを無効にしたうえでfailedを返し、消したことにしない', async () => {
  const tmp = ownerOnlyTempDirectory('close-fail');
  try {
    let attempts = 0;
    const removeFile = (): void => {
      attempts += 1;
      throw Object.assign(new Error('synthetic unlink failure'), { code: 'EACCES' });
    };
    const logs: string[] = [];
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, removeFile, log: (l) => logs.push(l) });
    // 交換のときに消せなくても、交換は成功し、closeでもう一度試す。
    await exchange(server);
    assert.equal(existsSync(server.launchFile), true);
    const result = await server.close();
    assert.deepEqual(result, { launchFile: 'failed', launchFilePath: server.launchFile });
    assert.equal(attempts, 2);
    assert.equal(existsSync(server.launchFile), true);
    assert.equal(await connectionRefused('127.0.0.1', server.port), true);
    assert.ok(logs.includes('launch-file-remove-failed EACCES'));
    assert.equal(logs.join('\n').includes(tokenOf(server)), false);
  } finally {
    tmp.cleanup();
  }
});

test('closeは、維持しているupgradeの接続を閉じ、実行中のAPIの処理に中止を知らせて完了を待ってから終わる', async () => {
  const tmp = ownerOnlyTempDirectory('close-inflight');
  try {
    const events: string[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let started: () => void = () => {};
    const handlerStarted = new Promise<void>((resolve) => (started = resolve));
    let aborted = false;
    const api: ApiRoute[] = [
      {
        method: 'POST',
        path: '/api/test/slow',
        handle: async (request) => {
          request.signal.addEventListener('abort', () => (aborted = true));
          started();
          await released;
          events.push('handler-finished');
          return { status: 200, body: { ok: true } };
        },
      },
    ];
    const held: Socket[] = [];
    const dev: LocalServerOptions['dev'] = {
      middleware: (_req, res) => {
        res.end();
      },
      upgrade(_req, socket) {
        held.push(socket as Socket);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      },
    };
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, api, dev });
    const cookie = await exchange(server);

    // 1. upgradeした接続を開いたままにする（サーバーは101を返して接続を維持する）。
    const client = connect({ host: '127.0.0.1', port: server.port });
    const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    let received = '';
    const switched = new Promise<void>((resolve) =>
      client.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1');
        if (received.includes('101')) resolve();
      }),
    );
    client.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nOrigin: ${server.origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    await switched;
    assert.equal(held.length, 1);

    // 2. 終わらないAPIの処理を始める。
    const pending = send(server.port, {
      method: 'POST',
      path: '/api/test/slow',
      headers: sameOriginHeaders(server, { cookie, 'content-type': 'application/json' }),
      body: '{}',
    });
    await handlerStarted;

    // 3. closeは、処理が終わるまで完了しない。中止の合図は届き、upgradeの接続は閉じる。
    let closed = false;
    const closing = server.close().then((result) => {
      closed = true;
      events.push('closed');
      return result;
    });
    await clientClosed;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(closed, false);
    assert.equal(aborted, true);
    assert.equal(held[0]?.destroyed, true);
    // 終了中は、新しい接続を受け付けない。
    assert.equal(await connectionRefused('127.0.0.1', server.port), true);

    // 4. 任意の時点で処理を終えると、その応答を返してからcloseが終わる。
    release();
    const response = await pending;
    assert.equal(response.status, 200);
    const result = await closing;
    assert.deepEqual(events, ['handler-finished', 'closed']);
    assert.equal(result.launchFile, 'removed');
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

test('closeは、応答を返していない遅い開発時のmiddlewareに中止を知らせ、その応答が終わるまで待ってから終わる', async () => {
  const tmp = ownerOnlyTempDirectory('close-dev');
  try {
    const events: string[] = [];
    let entered: () => void = () => {};
    const middlewareEntered = new Promise<void>((resolve) => (entered = resolve));
    const dev: LocalServerOptions['dev'] = {
      middleware(req, res) {
        const context = devRequestContext(req);
        entered();
        // 非同期の処理（変換等）の途中。中止の合図を受けてから、少し後に応答を終える。
        void (async () => {
          await new Promise<void>((resolve) => context?.signal.addEventListener('abort', () => resolve(), { once: true }));
          events.push('middleware-aborted');
          await new Promise((resolve) => setTimeout(resolve, 200));
          events.push('middleware-finished');
          res.end('late');
        })();
      },
    };
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, dev });
    const pending = send(server.port, { path: '/src/slow.ts' });
    await middlewareEntered;
    const result = await server.close().then((r) => {
      events.push('closed');
      return r;
    });
    assert.deepEqual(events, ['middleware-aborted', 'middleware-finished', 'closed']);
    assert.equal((await pending).text, 'late');
    assert.equal(result.launchFile, 'removed');
    assert.equal(await connectionRefused('127.0.0.1', server.port), true);
  } finally {
    tmp.cleanup();
  }
});

test('APIはクエリだけを除いた生のパスで完全一致に振り分け、ログ用に切り詰めたパスで誤って一致しない', async () => {
  const tmp = ownerOnlyTempDirectory('routing');
  try {
    const calls: string[] = [];
    const long = `/api/test/${'a'.repeat(240)}`;
    const handle = (name: string) => () => (calls.push(name), { status: 200, body: { name } });
    const logs: string[] = [];
    const server = await startLocalServer({
      port: 0,
      tokenDirectory: tmp.path,
      api: [
        { method: 'GET', path: long, handle: handle('long') },
        { method: 'GET', path: '/api/test/x', handle: handle('x') },
      ],
      log: (l) => logs.push(l),
    });
    try {
      const cookie = await exchange(server);
      const get = (path: string) => send(server.port, { path, headers: sameOriginHeaders(server, { cookie }) });
      // 200文字を超えるパスにも届く（クエリは除く）。
      assert.equal((await get(`${long}?q=1`)).status, 200);
      // 先頭が同じ別のパス・前方だけのパス・エンコードした形は一致しない。
      assert.equal((await get(`${long}b`)).status, 404);
      assert.equal((await get(long.slice(0, 200))).status, 404);
      assert.equal((await get('/api/test/%78')).status, 404);
      assert.equal((await get('/api/test/x/')).status, 404);
      // 非ASCIIのパスの要求は、どのAPIにも一致しない。
      assert.equal((await get('/api/test/%E6%97%A5')).status, 404);
      assert.deepEqual(calls, ['long']);
      // ログには切り詰めたパスだけが出る。
      assert.ok(logs.some((l) => l.startsWith(`GET ${long.slice(0, 200)}… 200`)));
    } finally {
      await server.close();
    }
    // 振り分けで比べられない形のパスは、登録のときに拒否する。
    for (const path of ['/api/test/日本', '/api/test/a b', `/api/${'a'.repeat(1100)}`, '/api/test/%41', '/api/test?x', '/api/']) {
      await assert.rejects(startLocalServer({ port: 0, tokenDirectory: tmp.path, api: [{ method: 'GET', path, handle: handle('bad') }] }), /使えない/, path);
    }
  } finally {
    tmp.cleanup();
  }
});

test('クライアントが応答の前に切断しても、closeは開発時のmiddlewareの処理が解放されて終わるまで返らない', async () => {
  const tmp = ownerOnlyTempDirectory('close-disconnect');
  try {
    const events: string[] = [];
    let entered: () => void = () => {};
    const middlewareEntered = new Promise<void>((resolve) => (entered = resolve));
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const responseClosed: Array<Promise<void>> = [];
    const dev: LocalServerOptions['dev'] = {
      middleware(_req, res) {
        responseClosed.push(new Promise((resolve) => res.once('close', () => resolve())));
        entered();
        void (async () => {
          await released;
          events.push('middleware-finished');
          res.end('late');
        })();
      },
    };
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, dev });
    // 応答の前にクライアントが切断する。
    const client = connect({ host: '127.0.0.1', port: server.port });
    client.on('error', () => {});
    client.write(`GET /src/slow.ts HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`);
    await middlewareEntered;
    client.destroy();
    await responseClosed[0];
    let closed = false;
    const closing = server.close().then((result) => {
      closed = true;
      events.push('closed');
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 応答のclose（途中切断）は処理の完了ではないので、closeはまだ返らない。
    assert.equal(closed, false);
    release();
    const result = await closing;
    assert.deepEqual(events, ['middleware-finished', 'closed']);
    assert.equal(result.launchFile, 'removed');
  } finally {
    tmp.cleanup();
  }
});

test('開発時の口のupgradeの処理が同期で例外を投げても、プロセスへ抜けず、ソケットを壊して記録し、そのあとも動いて終われる', async () => {
  const tmp = ownerOnlyTempDirectory('upgrade-throw');
  try {
    const logs: string[] = [];
    const dev: LocalServerOptions['dev'] = {
      middleware: (_req, res) => {
        res.end('ok');
      },
      upgrade() {
        throw Object.assign(new Error('synthetic upgrade failure'), { code: 'ESYNTHETIC' });
      },
    };
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, dev, log: (l) => logs.push(l) });
    const cookie = await exchange(server);
    const res = await sendRaw(
      server.port,
      `GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nOrigin: ${server.origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    ).catch(() => ({ status: 0, raw: '' })); // 壊したソケットは、OSによっては接続のリセットになる。
    assert.equal(res.status, 0);
    assert.ok(logs.includes('UPGRADE /hmr upgrade-handler-error ESYNTHETIC'));
    assert.equal(logs.join('\n').includes('synthetic upgrade failure'), false);
    assert.equal((await send(server.port, { path: '/src/main.ts' })).text, 'ok');
    assert.equal((await server.close()).launchFile, 'removed');
    assert.equal(await connectionRefused('127.0.0.1', server.port), true);
  } finally {
    tmp.cleanup();
  }
});

test('静的ファイルの読み出し元を差し替えても（T09のmanifestの読み出し元の口）、パスの検査・識別子・CSPとno-store・404は同じに働く', async () => {
  const tmp = ownerOnlyTempDirectory('source');
  try {
    const requested: string[][] = [];
    const files = new Map<string, { body: Buffer; contentType: string }>([
      ['index.html', { body: Buffer.from('<!doctype html><html><head><title>t</title></head><body>memory</body></html>'), contentType: 'text/html; charset=utf-8' }],
      ['assets/app.js', { body: Buffer.from('console.log("memory");'), contentType: 'text/javascript; charset=utf-8' }],
    ]);
    const staticSource: StaticSource = {
      read: async (segments) => {
        requested.push([...segments]);
        return files.get(segments.join('/'));
      },
    };
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, staticSource });
    try {
      const home = await send(server.port, { path: '/' });
      assert.equal(home.status, 200);
      assert.equal(home.text.includes(`<head><meta name="kurashi-ledger-launch-id" content="${server.launchId}">`), true);
      assert.equal(home.headers['cache-control'], 'no-store');
      assert.equal(home.headers['content-security-policy'], PRODUCTION_CSP);
      assert.equal((await send(server.port, { path: '/assets/app.js' })).text, 'console.log("memory");');
      assert.equal((await send(server.port, { path: '/missing.js' })).status, 404);
      // パスの検査は読み出し元の前に行うので、不正なパスは読み出し元に届かない。
      for (const target of ['/../x', '/%2e%2e/x', '/a%2Fb', '/.env', '/assets/']) {
        const res = await sendRaw(server.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`);
        assert.ok(res.status === 400 || res.status === 404, target);
      }
      assert.deepEqual(requested, [['index.html'], ['assets', 'app.js'], ['missing.js']]);
    } finally {
      await server.close();
    }
    // 配信ルート・読み出し元・開発時の口は、どの2つも同時に使えない。
    const dev = { middleware: () => {} };
    for (const options of [{ staticSource, staticRoot: FIXTURE_ROOT }, { staticSource, dev }]) {
      await assert.rejects(startLocalServer({ port: 0, tokenDirectory: tmp.path, ...options }), /同時に使えない/);
    }
  } finally {
    tmp.cleanup();
  }
});

// middlewareが同期でend・nextを呼んでからPromiseを返す場合の、処理の完了の契約（ADR-0009の6・7）。
async function closeWaitsForMiddleware(kind: 'end' | 'next' | 'reject'): Promise<void> {
  const tmp = ownerOnlyTempDirectory(`close-sync-${kind}`);
  try {
    const events: string[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let entered: () => void = () => {};
    const middlewareEntered = new Promise<void>((resolve) => (entered = resolve));
    const logs: string[] = [];
    const dev: LocalServerOptions['dev'] = {
      async middleware(_req, res, next) {
        // 呼出しの途中（最初のawaitの前）で、応答を返す（またはnext）。
        if (kind === 'next') next();
        else res.end('sync');
        entered();
        await released;
        events.push('middleware-finished');
        if (kind === 'reject') throw Object.assign(new Error('synthetic late failure'), { code: 'ELATE' });
      },
    };
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, dev, log: (l) => logs.push(l) });
    const response = await send(server.port, { path: '/src/sync.ts' });
    assert.equal(response.status, kind === 'next' ? 404 : 200);
    await middlewareEntered;
    let closed = false;
    const closing = server.close().then((result) => {
      closed = true;
      events.push('closed');
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 応答はもう返したが、返したPromiseが決着していないので、closeは返らない。
    assert.equal(closed, false, kind);
    release();
    const result = await closing;
    assert.deepEqual(events, ['middleware-finished', 'closed'], kind);
    assert.equal(result.launchFile, 'removed');
    // あとからのrejectも、処理の結果として記録される。
    if (kind === 'reject') assert.ok(logs.includes('internal-error ELATE'), logs.join('\n'));
    assert.equal(await connectionRefused('127.0.0.1', server.port), true);
  } finally {
    tmp.cleanup();
  }
}

test('middlewareが同期でres.end()を呼んでから未完了のPromiseを返すと、closeはそのPromiseの決着まで返らない', async () => {
  await closeWaitsForMiddleware('end');
});

test('middlewareが同期でnext()を呼んでから未完了のPromiseを返すと、closeはそのPromiseの決着まで返らない', async () => {
  await closeWaitsForMiddleware('next');
});

test('middlewareが同期で応答したあとで返したPromiseがrejectすると、closeはその決着を待ち、失敗を記録する', async () => {
  await closeWaitsForMiddleware('reject');
});

test('拒否したupgradeで相手が書込み側を閉じなくても、closeはそのソケットを壊して終わる', async () => {
  const tmp = ownerOnlyTempDirectory('upgrade-halfopen');
  try {
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path });
    // allowHalfOpen: サーバーが書込み側を閉じても、こちらは閉じない。
    const client = connect({ host: '127.0.0.1', port: server.port, allowHalfOpen: true });
    client.on('error', () => {});
    let received = '';
    const refused = new Promise<void>((resolve) => client.on('data', (c: Buffer) => ((received += c.toString('latin1')), received.includes('\r\n\r\n') && resolve())));
    client.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    await refused;
    assert.match(received, /^HTTP\/1\.1 403/);
    const result = await Promise.race([
      server.close(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
    ]);
    // 拒否したソケットを壊さないと、半分閉じた接続が残り、待受の終了（server.close）が完了しない。
    assert.notEqual(result, 'timeout');
    assert.equal(await connectionRefused('127.0.0.1', server.port), true);
    client.destroy();
  } finally {
    tmp.cleanup();
  }
});

test('要求の対象がorigin-formでない要求（absolute-form・authority-form・asterisk-form）は、upgrade・API・開発時のmiddlewareのどれにも渡さない', async () => {
  const tmp = ownerOnlyTempDirectory('request-target');
  try {
    const upgrades: string[] = [];
    const middlewareCalls: string[] = [];
    const calls: string[] = [];
    const dev: LocalServerOptions['dev'] = {
      middleware(req, res) {
        middlewareCalls.push(req.url ?? '');
        res.end('dev');
      },
      upgrade(req, socket) {
        upgrades.push(req.url ?? '');
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      },
    };
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, dev, api: testRoutes(calls) });
    try {
      const cookie = await exchange(server);
      const host = `127.0.0.1:${server.port}`;
      const good = `Host: ${host}\r\nOrigin: ${server.origin}\r\nCookie: ${cookie}\r\n`;
      const upgrade = (target: string) =>
        sendRaw(server.port, `GET ${target} HTTP/1.1\r\n${good}Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`).catch(() => ({ status: 0, raw: '' }));
      for (const target of ['http://attacker.invalid/hmr', `http://${host}/hmr`, host, '*']) {
        const res = await upgrade(target);
        assert.ok(res.status === 400 || res.status === 0, `${target} ${res.status}`);
      }
      assert.deepEqual(upgrades, []);
      // 同じ要求でも、origin-formなら渡す（検査が強すぎないこと）。
      assert.equal((await upgrade('/hmr')).status, 101);
      assert.deepEqual(upgrades, ['/hmr']);

      const api = `${good}Kurashi-Ledger-Launch-Id: ${server.launchId}\r\nSec-Fetch-Site: same-origin\r\nConnection: close\r\n`;
      for (const request of [
        `GET http://${host}/api/test/state HTTP/1.1\r\n${api}\r\n`,
        `GET http://attacker.invalid/src/main.ts HTTP/1.1\r\n${api}\r\n`,
        `OPTIONS * HTTP/1.1\r\n${api}\r\n`,
        `GET ${host} HTTP/1.1\r\n${api}\r\n`,
      ]) {
        const res = await sendRaw(server.port, request).catch(() => ({ status: 0, raw: '' }));
        assert.ok(res.status === 400 || res.status === 0, `${request.split('\r\n')[0] ?? ''} ${res.status}`);
      }
      // CONNECT（authority-form）は、Node.jsが受けるところがないので接続を閉じる。
      const connectRes = await sendRaw(server.port, `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`).catch(() => ({ status: 0, raw: '' }));
      assert.notEqual(connectRes.status, 200);
      assert.deepEqual(calls, []);
      assert.deepEqual(middlewareCalls, []);
    } finally {
      await server.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test('upgradeを拒否する生の応答にも、通常の応答と同じ必須のヘッダと拒否の理由が付き、CORSのヘッダは付かない', async () => {
  const tmp = ownerOnlyTempDirectory('upgrade-headers');
  try {
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path });
    try {
      const cookie = await exchange(server);
      const host = `127.0.0.1:${server.port}`;
      const base = { host, origin: server.origin, cookie };
      const cases: Array<[string, Record<string, string>, string, number]> = [
        ['/hmr', { ...base, host: `localhost:${server.port}` }, 'host-mismatch', 403],
        ['http://attacker.invalid/hmr', base, 'bad-request-target', 400],
        ['/hmr', { ...base, origin: `http://127.0.0.1:${server.port + 1}` }, 'origin-mismatch', 403],
        ['/hmr', { host, cookie }, 'origin-required', 403],
        ['/hmr', { host, origin: server.origin }, 'session-required', 401],
        ['/hmr', base, 'no-websocket', 404],
      ];
      for (const [target, headers, code, status] of cases) {
        const lines = Object.entries(headers).map(([n, v]) => `${n}: ${v}\r\n`).join('');
        const res = await sendRaw(server.port, `GET ${target} HTTP/1.1\r\n${lines}Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
        assert.equal(res.status, status, code);
        const head = res.raw.split('\r\n\r\n')[0] ?? '';
        const fields = new Map(head.split('\r\n').slice(1).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
        assert.equal(fields.get('content-security-policy'), PRODUCTION_CSP, code);
        assert.equal(fields.get('cache-control'), 'no-store', code);
        assert.equal(fields.get('referrer-policy'), 'no-referrer', code);
        assert.equal(fields.get('x-content-type-options'), 'nosniff', code);
        assert.equal(fields.get('cross-origin-resource-policy'), 'same-origin', code);
        assert.equal(fields.get('x-frame-options'), 'DENY', code);
        assert.equal(fields.get('x-kurashi-ledger-reason'), code);
        assert.deepEqual([...fields.keys()].filter((k) => k.startsWith('access-control-')), [], code);
      }
    } finally {
      await server.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test('読み出し元が返すメディア型の大文字小文字によらずHTMLに識別子を入れ、text/htmlxには入れない', async () => {
  const tmp = ownerOnlyTempDirectory('media-type');
  try {
    const page = Buffer.from('<!doctype html><html><head><title>t</title></head><body>x</body></html>');
    const staticSource: StaticSource = {
      read: async (segments) =>
        segments[0] === 'upper.html'
          ? { body: page, contentType: 'Text/HTML; charset=UTF-8' }
          : segments[0] === 'other.x'
            ? { body: page, contentType: 'text/htmlx' }
            : undefined,
    };
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, staticSource });
    try {
      assert.equal((await send(server.port, { path: '/upper.html' })).text.includes(`content="${server.launchId}"`), true);
      assert.equal((await send(server.port, { path: '/other.x' })).text.includes(server.launchId), false);
    } finally {
      await server.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test('終了が始まったあとに既存の接続で届いたupgradeには、必須のヘッダ付きの503（closing）を返してから接続を閉じる', async () => {
  const tmp = ownerOnlyTempDirectory('close-upgrade');
  try {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    let started: () => void = () => {};
    const handlerStarted = new Promise<void>((resolve) => (started = resolve));
    const api: ApiRoute[] = [
      {
        method: 'POST',
        path: '/api/test/slow',
        handle: async () => {
          started();
          await released;
          return { status: 200, body: {} };
        },
      },
    ];
    const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, api });
    const cookie = await exchange(server);
    // 1. 終了を止めておくための、終わらない処理。
    const pending = send(server.port, {
      method: 'POST',
      path: '/api/test/slow',
      headers: sameOriginHeaders(server, { cookie, 'content-type': 'application/json' }),
      body: '{}',
    });
    await handlerStarted;
    // 2. 既存の接続で、upgradeの要求の途中まで送っておく（要求の途中の接続は、待機中の接続として閉じられない）。
    const client = connect({ host: '127.0.0.1', port: server.port });
    client.on('error', () => {});
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    let received = '';
    client.on('data', (c: Buffer) => (received += c.toString('latin1')));
    const clientClosed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 3. 終了を始め、そのあとで要求の残りを送る。
    const closing = server.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    client.write(`Origin: ${server.origin}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    await clientClosed;
    assert.match(received, /^HTTP\/1\.1 503 /);
    assert.match(received, /\r\nX-Kurashi-Ledger-Reason: closing\r\n/);
    assert.match(received, /\r\nCache-Control: no-store\r\n/);
    assert.match(received, new RegExp(`\\r\\nContent-Security-Policy: ${PRODUCTION_CSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r\\n`));
    release();
    assert.equal((await pending).status, 200);
    assert.equal((await closing).launchFile, 'removed');
  } finally {
    tmp.cleanup();
  }
});
