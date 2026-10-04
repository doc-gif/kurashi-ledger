// HTTPの境界の試験（node:testとPlaywright）で使う道具。製品のコードからは使わない。
// 値はすべて合成のもので、試験ごとに作る一時のディレクトリだけを使う。
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restrictToOwner } from '../../src/infrastructure/http/owner-only.ts';
import { LAUNCH_ID_HEADER } from '../../src/infrastructure/http/request-checks.ts';
import type { LocalServer } from '../../src/infrastructure/http/server.ts';

// 試験ごとの本人専用のディレクトリ（POSIXは0700、Windowsは本人だけのACL）。cleanupで消す。
export function ownerOnlyTempDirectory(prefix: string): { readonly path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), `kl-${prefix}-`));
  restrictToOwner(path, 'directory');
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export type HttpResult = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
  readonly text: string;
};

export type RequestOptions = {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: string | Buffer;
};

// http.requestで送る。Hostは、headersで指定しなければ127.0.0.1:<port>。
export function send(port: number, options: RequestOptions = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | string[]> = { host: `127.0.0.1:${port}` };
    for (const [name, value] of Object.entries(options.headers ?? {})) headers[name.toLowerCase()] = typeof value === 'string' ? value : [...value];
    const req = request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

// 生の要求の文字列を送り、状態行と本文を返す（http.requestが送れない形の要求のため）。
export function sendRaw(port: number, text: string): Promise<{ readonly status: number; readonly raw: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('latin1');
      const match = /^HTTP\/1\.1 (\d{3})/.exec(raw);
      resolve({ status: match === null ? 0 : Number(match[1]), raw });
    });
    socket.on('error', reject);
    socket.write(text);
  });
}

export function sameOriginHeaders(server: LocalServer, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { origin: server.origin, 'sec-fetch-site': 'same-origin', [LAUNCH_ID_HEADER]: server.launchId, ...extra };
}

export function tokenOf(server: LocalServer): string {
  const at = server.tokenUrl.indexOf('#');
  return server.tokenUrl.slice(at + 1);
}

// トークンをcookieに交換し、「名前=値」を返す。
export async function exchange(server: LocalServer): Promise<string> {
  const res = await send(server.port, {
    method: 'POST',
    path: '/api/session',
    headers: sameOriginHeaders(server, { 'content-type': 'application/json' }),
    body: JSON.stringify({ token: tokenOf(server) }),
  });
  if (res.status !== 204) throw new Error(`交換に失敗した: ${res.status} ${res.text}`);
  const setCookie = res.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (first === undefined) throw new Error('Set-Cookieがない。');
  return first.split(';')[0] ?? '';
}
