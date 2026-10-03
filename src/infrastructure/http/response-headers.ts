// すべての応答に付けるヘッダ（ADR-0003の4・6・7・13、ADR-0009）。
// 応答を書き出す直前（writeHead。res.end()やres.write()が暗黙に呼ぶものを含む）に、必ず付け直し、
// CORSのヘッダ（Access-Control-*）を取り除く。APIの処理や開発時のmiddleware（Vite）がヘッダを変えても、
// この出口を通るので、no-store・CSP等が外れず、CORSも返らない。
import type { OutgoingHttpHeader, OutgoingHttpHeaders, ServerResponse } from 'node:http';

// 本番の応答のCSP（ADR-0003の7の初期値）。インラインのscript・eval・外部の資源を許可しない。
export const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const NONCE_PATTERN = /^[A-Za-z0-9+/]{22}==$/;

// 開発時の口（T08のVite）からの応答だけに使うCSP（ADR-0003の7）。応答ごとの予測できないnonceを、
// script-srcとstyle-srcに加え、HMRのWebSocketのためにconnect-srcへ同じoriginのws://を加える。
// 'unsafe-inline'・'unsafe-eval'・固定のnonceは使わない。本番の応答には使わない。
export function developmentCsp(nonce: string, port: number): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error('CSPのnonceの形が不正。');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `connect-src 'self' ws://127.0.0.1:${port}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const FIXED_HEADERS: ReadonlyArray<readonly [string, string]> = [
  // 金額等や前の版のUIをブラウザに残さない（APIと静的ファイルの両方。ADR-0003の6・13）。
  ['Cache-Control', 'no-store'],
  // 同じoriginへの要求にもRefererを付けさせない（ADR-0003の4）。
  ['Referrer-Policy', 'no-referrer'],
  ['X-Content-Type-Options', 'nosniff'],
  // 追加の防御: 別のoriginのページへの埋め込み（no-corsの読込み・frame）を拒む。
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['X-Frame-Options', 'DENY'],
];

const ENFORCED = new Set([...FIXED_HEADERS.map(([name]) => name.toLowerCase()), 'content-security-policy']);

function isForbidden(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('access-control-') || ENFORCED.has(lower);
}

type HeadersArgument = OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined;

// writeHeadに直接渡されたヘッダから、付け直すヘッダとCORSのヘッダを除いた写しを作る。
function filterHeaders(headers: HeadersArgument): HeadersArgument {
  if (headers === undefined) return undefined;
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) {
      return (headers as unknown as Array<[string, OutgoingHttpHeader]>).filter(([name]) => !isForbidden(String(name))) as unknown as OutgoingHttpHeader[];
    }
    const kept: OutgoingHttpHeader[] = [];
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (!isForbidden(String(headers[i]))) kept.push(headers[i] as OutgoingHttpHeader, headers[i + 1] as OutgoingHttpHeader);
    }
    return kept;
  }
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isForbidden(name)) kept[name] = value;
  }
  return kept;
}

// resに、出口で付け直すヘッダを設定する。cspは、その応答に使うCSP（本番はPRODUCTION_CSP）。
export function enforceResponseHeaders(res: ServerResponse, csp: string): void {
  const apply = (): void => {
    for (const name of res.getHeaderNames()) {
      if (name.toLowerCase().startsWith('access-control-')) res.removeHeader(name);
    }
    for (const [name, value] of FIXED_HEADERS) res.setHeader(name, value);
    res.setHeader('Content-Security-Policy', csp);
  };
  apply();
  const original = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  const wrapped = (statusCode: number, ...rest: unknown[]): ServerResponse => {
    apply();
    const last = rest.at(-1);
    if (typeof last === 'object' && last !== null) {
      return original(statusCode, ...rest.slice(0, -1), filterHeaders(last as HeadersArgument));
    }
    return original(statusCode, ...rest);
  };
  res.writeHead = wrapped as typeof res.writeHead;
}
