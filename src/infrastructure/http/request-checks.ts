// 要求の検査（ADR-0003の3・5・14、ADR-0009）。どれも、通れば undefined、拒否なら状態と理由の符号を返す。
// 同じ名前のヘッダが2つ以上ある要求は、どの検査でも拒否する（Node.jsは一部のヘッダの重複を黙って捨てるので、
// headersDistinctで数える）。
import type { IncomingMessage } from 'node:http';

export type Rejection = { readonly status: number; readonly code: string };

// 起動の識別子（ADR-0003の14）。HTMLの<meta name>と、API要求のヘッダの名前。値は16バイトの暗号論的乱数の
// base64url（22文字）。秘密ではなく、認証（cookie）の代わりにしない。
export const LAUNCH_ID_META_NAME = 'kurashi-ledger-launch-id';
export const LAUNCH_ID_HEADER = 'Kurashi-Ledger-Launch-Id';
export const LAUNCH_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

type Single = { readonly kind: 'absent' } | { readonly kind: 'one'; readonly value: string } | { readonly kind: 'many' };

function single(req: IncomingMessage, name: string): Single {
  const values = req.headersDistinct[name.toLowerCase()];
  if (values === undefined || values.length === 0) return { kind: 'absent' };
  if (values.length > 1) return { kind: 'many' };
  return { kind: 'one', value: values[0] ?? '' };
}

// Hostは「127.0.0.1:<port>」と完全に一致しなければ拒否する（静的ファイルを含むすべての要求。DNS rebinding対策）。
export function checkHost(req: IncomingMessage, expectedHost: string): Rejection | undefined {
  const host = single(req, 'host');
  if (host.kind !== 'one' || host.value !== expectedHost) return { status: 403, code: 'host-mismatch' };
  return undefined;
}

// 同じoriginからの要求か（ADR-0003の5）。
// - Sec-Fetch-Siteがあれば same-origin であること（same-siteは同じPCの別ポートからの要求でもなるので拒否）。
// - Originがあれば「http://127.0.0.1:<port>」と完全に一致すること（nullを含め、ほかは拒否）。
// - requiredがtrue（GET/HEAD以外と、WebSocketのupgrade）なら、どちらもない要求を拒否する。
export function checkSameOrigin(req: IncomingMessage, expectedOrigin: string, required: boolean): Rejection | undefined {
  const site = single(req, 'sec-fetch-site');
  const origin = single(req, 'origin');
  if (site.kind === 'many' || origin.kind === 'many') return { status: 403, code: 'duplicate-origin-headers' };
  if (site.kind === 'one' && site.value !== 'same-origin') return { status: 403, code: 'not-same-origin' };
  if (origin.kind === 'one' && origin.value !== expectedOrigin) return { status: 403, code: 'origin-mismatch' };
  if (required && site.kind === 'absent' && origin.kind === 'absent') return { status: 403, code: 'origin-required' };
  return undefined;
}

export type BodyType = 'json' | 'octet-stream';

// 状態を変える要求のContent-Type（ADR-0003の5）。JSONは「application/json」（charsetはutf-8だけ許す）。
// octet-streamは、その種類を宣言したエンドポイント（証憑の取込等）だけで受け付ける。
export function checkContentType(req: IncomingMessage, accepted: BodyType): Rejection | undefined {
  const header = single(req, 'content-type');
  if (header.kind !== 'one') return { status: 415, code: 'unsupported-content-type' };
  const [media = '', ...params] = header.value.split(';').map((part) => part.trim());
  const type = media.toLowerCase();
  if (accepted === 'json') {
    if (type !== 'application/json') return { status: 415, code: 'unsupported-content-type' };
    for (const param of params) {
      if (!/^charset=(?:"utf-8"|utf-8)$/i.test(param)) return { status: 415, code: 'unsupported-content-type' };
    }
    return undefined;
  }
  if (type !== 'application/octet-stream' || params.length > 0) return { status: 415, code: 'unsupported-content-type' };
  return undefined;
}

// API要求の起動の識別子（ADR-0003の14）。ない要求は403、形が違う・いまの起動と違う要求は409（UIに再読み込みを促す）。
export function checkLaunchId(req: IncomingMessage, launchId: string): Rejection | undefined {
  const header = single(req, LAUNCH_ID_HEADER);
  if (header.kind === 'absent') return { status: 403, code: 'launch-id-required' };
  if (header.kind === 'many') return { status: 403, code: 'duplicate-launch-id' };
  if (header.value !== launchId) return { status: 409, code: 'launch-id-mismatch' };
  return undefined;
}

// Cookieのヘッダから、nameの値をすべて取り出す（同じ名前が複数あれば全部）。
export function cookieValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (const header of req.headersDistinct['cookie'] ?? []) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === name) values.push(part.slice(eq + 1).trim());
    }
  }
  return values;
}
