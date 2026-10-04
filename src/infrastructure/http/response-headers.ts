// すべての応答に付けるヘッダと、応答の出口（ADR-0003の4・6・7・13、ADR-0009の5）。
// 応答のインスタンスの、ヘッダを書き出す公開の入口（writeHead・別名writeHeader。res.end()・write()・flushHeaders()が
// 暗黙に呼ぶ_implicitHeaderもthis.writeHeadを呼ぶ）を、1か所の包みに置き換える。包みは、Node.js v24.21.0の
// writeHeadと同じ規則でヘッダの引数を解いてsetHeader・appendHeaderへ移し、最後に必須のヘッダを付け直し、CORSの
// ヘッダ（Access-Control-*）と、サーバーが決めていない理由のヘッダを外し、元の関数には状態と文字列のreasonだけを渡す。
// 状態は200〜599の整数だけ（informational応答（1xx）は所有者の決定で禁止）。trailersも禁止する。
// prototypeの直接呼出し・内部のメソッド・ソケットへの直接の書込みは公開のインスタンスのAPIではなく、組み込むコード
// （T08のVite）の責任とする。
import type { ServerResponse } from 'node:http';

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
  // 追加の防御: 別のoriginの開き手・開いた先との参照（window.opener等）を切る。
  ['Cross-Origin-Opener-Policy', 'same-origin'],
];

// 拒否の理由の符号を返すヘッダ。値はサーバーが決めたもの（setResponseReason）だけで、ほかから付けたものは外す。
export const REASON_HEADER = 'X-Kurashi-Ledger-Reason';

// すべての応答に付けるヘッダの名前と値（定義はこの1か所）。通常のHTTPの出口（enforceResponseHeaders）と、
// upgradeの拒否・解析器の拒否の生の応答の両方が使う。
export function requiredResponseHeaders(csp: string): ReadonlyArray<readonly [string, string]> {
  return [...FIXED_HEADERS, ['Content-Security-Policy', csp]];
}

// informational応答（1xx）を書く公開のAPI（Node.js v24.21.0の_http_server.js）。2026-10-03の所有者の決定で禁止する
// （ADR-0009の5）。writeContinue・writeProcessing・writeEarlyHintsはwriteInformationを呼ぶが、どれも個別に置き換える。
export const INFORMATIONAL_METHODS = ['writeInformation', 'writeContinue', 'writeProcessing', 'writeEarlyHints'] as const;

// 200〜599以外の状態（1xxを含む）と、1xx・trailersを書く入口を呼んだときの例外の符号。
export const INFORMATIONAL_FORBIDDEN_CODE = 'ERR_KL_INFORMATIONAL_RESPONSE_FORBIDDEN';
export const TRAILERS_FORBIDDEN_CODE = 'ERR_KL_TRAILERS_FORBIDDEN';

function forbidden(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

// 最終の応答として書いてよい状態（200〜599の整数）でなければ例外。APIの応答の状態にも使う。
export function assertFinalStatus(status: unknown): asserts status is number {
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
    throw forbidden('only final responses with status 200-599 are allowed (ADR-0009)', INFORMATIONAL_FORBIDDEN_CODE);
  }
}

const reasons = new WeakMap<ServerResponse, string>();

// 拒否の理由の符号を記録する（応答のヘッダとログの両方の正本。ヘッダからは読まない）。
export function setResponseReason(res: ServerResponse, code: string): void {
  reasons.set(res, code);
}

export function responseReason(res: ServerResponse): string | undefined {
  return reasons.get(res);
}

function defineFixed(res: ServerResponse, name: string, value: unknown): void {
  Object.defineProperty(res, name, { configurable: false, writable: false, value });
}

// resに、出口の包みを設定する。cspは、その応答に使うCSP（本番はPRODUCTION_CSP）。
export function enforceResponseHeaders(res: ServerResponse, csp: string): void {
  for (const name of INFORMATIONAL_METHODS) {
    defineFixed(res, name, () => {
      throw forbidden('informational responses (1xx) are forbidden (ADR-0009)', INFORMATIONAL_FORBIDDEN_CODE);
    });
  }
  defineFixed(res, 'addTrailers', () => {
    throw forbidden('trailers are forbidden (ADR-0009)', TRAILERS_FORBIDDEN_CODE);
  });
  // 必須のヘッダを最後に付け直す。CORSのヘッダと、サーバーが決めていない理由のヘッダを外す。
  const apply = (): void => {
    for (const name of res.getHeaderNames()) {
      const lower = name.toLowerCase();
      if (lower.startsWith('access-control-') || lower === REASON_HEADER.toLowerCase()) res.removeHeader(name);
    }
    for (const [name, value] of requiredResponseHeaders(csp)) res.setHeader(name, value);
    const reason = reasons.get(res);
    if (reason !== undefined) res.setHeader(REASON_HEADER, reason);
  };
  apply();
  const original = res.writeHead.bind(res) as (statusCode: number, reason?: string) => ServerResponse;
  // Node.js v24.21.0のwriteHead(statusCode, reason, obj)と同じ規則でヘッダの引数を解く。
  const wrapped = function writeHead(statusCode: unknown, reason?: unknown, obj?: unknown): ServerResponse {
    if (res.headersSent) throw Object.assign(new Error('Cannot write headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
    assertFinalStatus(statusCode);
    const headers = typeof reason === 'string' ? obj : (obj ?? reason);
    if (Array.isArray(headers)) {
      if (headers.length % 2 !== 0) throw Object.assign(new TypeError('invalid headers array'), { code: 'ERR_INVALID_ARG_VALUE' });
      for (let i = 0; i < headers.length; i += 2) res.removeHeader(headers[i] as string);
      for (let i = 0; i < headers.length; i += 2) {
        const name = headers[i] as string;
        if (name) res.appendHeader(name, headers[i + 1] as string | readonly string[]);
      }
    } else if (headers) {
      for (const name of Object.keys(headers)) {
        if (name) res.setHeader(name, (headers as Record<string, string | number | readonly string[]>)[name] as string);
      }
    }
    apply();
    return typeof reason === 'string' ? original(statusCode, reason) : original(statusCode);
  };
  // 別名（writeHeader）も同じ包みにする。middleware（on-headers等）が包み直せるよう、書換えは禁じない
  // （包み直したものは、この包みを呼ぶ）。
  res.writeHead = wrapped as typeof res.writeHead;
  (res as unknown as { writeHeader: unknown }).writeHeader = wrapped;
}
