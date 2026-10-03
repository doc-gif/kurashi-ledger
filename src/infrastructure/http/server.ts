// ローカルHTTPサーバーと安全境界（ADR-0003、ADR-0007のG7、ADR-0009）。Node.js標準のnode:httpだけを使う。
// - 127.0.0.1にだけbindする。ポートが使用中なら別のポートへ移らずにPortInUseErrorで止める。
// - すべての要求でHostの完全一致を確かめ、すべての応答の出口で共通のヘッダ（CSP・no-store等）を付け直し、CORSの
//   ヘッダを外す。
// - /api/ の要求: 起動の識別子のヘッダ、GET/HEAD以外はSec-Fetch-Site・Origin・Content-Type、cookie（交換の
//   エンドポイントだけは1回限りのトークン）を確かめてから、登録された処理を呼ぶ。応答はJSONだけ。
// - それ以外: 交換用のページとスクリプト、配信ルートの静的ファイル（なければ案内ページ）、または開発時の口
//   （T08のViteのmiddleware）。GET/HEADだけ。HTMLには起動の識別子の<meta>を入れる。
// - WebSocketのupgrade: Host・Origin（Sec-Fetch-Site）・cookieを確かめてから、開発時の口（HMR）に渡す。口が
//   なければ拒否する。
// - ログ: 方法・クエリを除いたパス・状態・理由の符号だけ。トークン・cookie・クエリ・本文を出さない（ADR-0003の11）。
// DBもデータルートも開かない（T09）。トークンの一時ファイルは、渡された本人専用のディレクトリにだけ作る。
import { randomBytes } from 'node:crypto';
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  createLaunchFile,
  randomLaunchFileName,
  removeLaunchFile,
  verifyTokenDirectory,
  type LaunchFile,
} from './launch-file.ts';
import {
  EXCHANGE_PATH,
  LAUNCH_PAGE_HTML,
  LAUNCH_PATH,
  LAUNCH_SCRIPT,
  LAUNCH_SCRIPT_PATH,
  PLACEHOLDER_PAGE_HTML,
  launchFileHtml,
} from './launch-page.ts';
import {
  checkContentType,
  checkHost,
  checkLaunchId,
  checkSameOrigin,
  cookieValues,
  type BodyType,
  type Rejection,
} from './request-checks.ts';
import { PRODUCTION_CSP, developmentCsp, enforceResponseHeaders } from './response-headers.ts';
import { createLaunchSession, type LaunchSession } from './session.ts';
import {
  createDiskStaticSource,
  injectLaunchId,
  isHtml,
  parseStaticPath,
  type StaticSource,
} from './static-files.ts';

export const LISTEN_HOST = '127.0.0.1';

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApiRequest = {
  readonly method: ApiMethod;
  readonly path: string;
  // JSONの要求は解析した値、octet-streamの要求はBuffer、GETはundefined。
  readonly body: unknown;
  // closeが始まると中止を知らせる。処理は早めに終えてよいが、closeは処理の完了を待つ。
  readonly signal: AbortSignal;
};

export type ApiResponse = { readonly status: number; readonly body?: unknown };

export type ApiRoute = {
  readonly method: ApiMethod;
  // /api/ で始まる完全一致のパス。
  readonly path: string;
  // 既定はJSON（上限64KiB）。octet-stream（証憑の取込等）は、上限を決めて宣言したエンドポイントだけで受け付ける。
  readonly body?: { readonly type: BodyType; readonly maxBytes: number };
  readonly handle: (request: ApiRequest) => ApiResponse | Promise<ApiResponse>;
};

// 開発時の口（T08）。Viteのmiddlewareモードの`server.middlewares`と、HMRのWebSocketのupgradeを、同じ検査の後ろに
// 載せる。middlewareには、Hostの検査を通ったGET/HEADの要求（APIと交換用のページを除く）だけが届き、応答には共通の
// ヘッダ（開発時のCSP）が付く。upgradeには、Host・Origin・cookieの検査を通った要求だけが届く。
export type DevIntegration = {
  // 処理の完了（runDevMiddlewareの契約）: Promiseを返したときはその決着だけ。返さないときは、最初のnext()か
  // res.end()の呼出し（呼出しの途中に起きても、戻ってから確定する）。クライアントの途中切断では完了としない。
  // closeはこの完了を待つ。
  readonly middleware: (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void | Promise<void>;
  readonly upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
};

// signalは、closeが始まると中止を知らせる。middlewareは早めに応答を終えるかnext()を呼ぶ。closeはそれを待つ。
export type DevRequestContext = { readonly launchId: string; readonly nonce: string; readonly signal: AbortSignal };

const devContexts = new WeakMap<IncomingMessage, DevRequestContext>();

// 開発時の口に渡した要求の、起動の識別子と、その応答のCSPのnonce（T08がViteのHTMLに入れる）。
export function devRequestContext(req: IncomingMessage): DevRequestContext | undefined {
  return devContexts.get(req);
}

export type LocalServerOptions = {
  // 0はOSが選ぶ（試験用）。
  readonly port: number;
  // トークンの一時ファイルを置く、本人専用のディレクトリ（T09からはデータルートのtmp/）。
  readonly tokenDirectory: string;
  // 静的ファイルの配信ルート。なければ / で案内ページを返す。staticSource・devと同時には使えない。
  readonly staticRoot?: string;
  // 静的ファイルの読み出し元（T09が、manifestで確かめた内容をメモリから返すものを渡す）。パスの検査・HTMLの識別子・
  // 応答ヘッダは、配信ルートと同じ処理を通る。staticRoot・devと同時には使えない。
  readonly staticSource?: StaticSource;
  readonly api?: readonly ApiRoute[];
  readonly dev?: DevIntegration;
  readonly log?: (line: string) => void;
  // 一時ファイルを消す処理。試験で削除の失敗を注入するためだけに使う（既定はunlink）。
  readonly removeFile?: (path: string) => void;
};

// 一時ファイルの後始末の結果。replaced（作ったものと違うものに置き換わっていた）とfailed（消せなかった）は、
// ファイルが残っている。トークンはどちらでも無効になっている。
export type LaunchFileCleanup = 'removed' | 'missing' | 'replaced' | 'failed';

export type CloseResult = { readonly launchFile: LaunchFileCleanup; readonly launchFilePath: string };

export type LocalServer = {
  readonly port: number;
  readonly origin: string;
  readonly address: AddressInfo;
  readonly launchId: string;
  readonly cookieName: string;
  readonly launchFile: string;
  readonly launchFileUrl: string;
  // 1回だけ使えるトークン付きのURL。端末に表示するときだけ使い、ログに出さない。
  readonly tokenUrl: string;
  // 終了する。新しい接続と要求を受け付けず、実行中の処理に中止を知らせてすべての完了を待ち、upgrade済みの接続と
  // HTTPの接続を閉じ、待受を止め、トークンとセッションを無効にし、一時ファイルを消して、その結果を返す。
  // 何度呼んでも同じ結果を返す。
  close(): Promise<CloseResult>;
};

export class PortInUseError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`ポート${port}は使用中なので起動しない（別のポートへは移らない）。`);
    this.port = port;
  }
}

const DEFAULT_JSON_MAX_BYTES = 64 * 1024;
const EXCHANGE_MAX_BYTES = 1024;

function validateRoutes(routes: readonly ApiRoute[]): void {
  const seen = new Set<string>();
  for (const route of routes) {
    // 要求の生のパス（クエリを除いたもの）と完全一致で比べるので、比べられる形だけを登録できる:
    // /api/ で始まり、ASCIIの印字できる文字だけで、%・?・#・バックスラッシュを含まず、1024文字以下。
    if (!/^\/api\/[!-~]+$/.test(route.path) || route.path.length > 1024 || /[?#%\\]/.test(route.path) || route.path === EXCHANGE_PATH) {
      throw new Error(`APIのパス ${route.path} は使えない。`);
    }
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) throw new Error(`APIの ${key} が2回ある。`);
    seen.add(key);
    if (route.body !== undefined) {
      if (route.method === 'GET') throw new Error(`GETの ${route.path} に本文の種類は指定できない。`);
      if (!Number.isSafeInteger(route.body.maxBytes) || route.body.maxBytes <= 0) throw new Error(`${key} の本文の上限が不正。`);
    }
  }
}

function safePath(rawUrl: string | undefined): string {
  const url = rawUrl ?? '';
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const printable = path.replace(/[^!-~]/g, '?');
  return printable.length > 200 ? `${printable.slice(0, 200)}…` : printable;
}

function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) return String((error as { code: unknown }).code);
  return error instanceof Error ? error.name : 'unknown';
}

type BodyResult = { readonly ok: true; readonly data: Buffer } | { readonly ok: false; readonly rejection: Rejection };

function readBody(req: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: BodyResult): void => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    let tooLarge = false;
    // 上限を超えたら、それ以上はためずに読み捨て、最後まで読んでから413で答える（読み残しで接続を壊さない）。
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(tooLarge ? { ok: false, rejection: { status: 413, code: 'body-too-large' } } : { ok: true, data: Buffer.concat(chunks) }));
    req.on('error', () => finish({ ok: false, rejection: { status: 400, code: 'body-read-error' } }));
    // クライアントが本文の途中で切断したら、それ以上は届かないので決着させる。
    req.on('close', () => {
      if (!req.complete) finish({ ok: false, rejection: { status: 400, code: 'body-incomplete' } });
    });
    // 終了が始まったら、本文の残りを待たない（届かない本文でcloseが止まらないように）。
    function onAbort(): void {
      finish({ ok: false, rejection: { status: 503, code: 'closing' } });
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseJson(data: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

// 開発時のmiddlewareを1回呼び、その処理の完了まで決着しないPromiseを返す（ADR-0009の6・7の「処理の完了」の契約）。
// サーバーはこのPromiseを所有し、closeはその決着を待つ。出来事（end・next・応答のclose）では状態を記録するだけで、
// 完了かどうかはsettleIfDone()の1か所で判定する（一度決着したPromiseは戻せないため、早まって決着させない）。
// (1) 呼出しが戻るまでは、どの出来事でも完了を確定しない。同期の例外は失敗。
// (2) 返り値がPromise（thenを持つ値）なら、その決着だけで決まる（resolveで完了、rejectで失敗）。
// (3) Promiseでなければ、呼出しの途中または後の、最初のnext()かres.end()の呼出しで完了。
// (4) 応答・接続のclose（クライアントの途中切断）は、どの場合も完了ではない。
export function runDevMiddleware(
  middleware: DevIntegration['middleware'],
  req: IncomingMessage,
  res: ServerResponse,
  onNext: (error?: unknown) => void,
): Promise<void> {
  return new Promise<void>((resolve, fail) => {
    let returned = false;
    let returnedThenable = false;
    let signaled = false;
    let settled = false;
    const settleIfDone = (): void => {
      if (settled || !returned || returnedThenable || !signaled) return;
      settled = true;
      resolve();
    };
    const originalEnd = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
    res.end = ((...args: unknown[]) => {
      const result = originalEnd(...args);
      signaled = true;
      settleIfDone();
      return result;
    }) as typeof res.end;
    const next = (error?: unknown): void => {
      onNext(error);
      signaled = true;
      settleIfDone();
    };
    let value: unknown;
    try {
      value = middleware(req, res, next);
    } catch (error) {
      settled = true;
      fail(error);
      return;
    }
    returned = true;
    if (typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function') {
      returnedThenable = true;
      (value as PromiseLike<unknown>).then(
        () => {
          if (settled) return;
          settled = true;
          resolve();
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          fail(error);
        },
      );
      return;
    }
    settleIfDone();
  });
}

export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error(`ポート${options.port}は使えない。`);
  const uiSources = [options.staticRoot, options.staticSource, options.dev].filter((v) => v !== undefined).length;
  if (uiSources > 1) throw new Error('配信ルート（staticRoot）・読み出し元（staticSource）・開発時の口（dev）は、同時に使えない。');
  const routes = options.api ?? [];
  validateRoutes(routes);
  const log = options.log ?? (() => {});
  // 起動の前に、渡されたディレクトリと配信ルートを確かめる（どちらも、作らない・変えない）。
  const tokenDirectory = verifyTokenDirectory(options.tokenDirectory);
  const staticSource: StaticSource | undefined =
    options.staticSource ?? (options.staticRoot === undefined ? undefined : await createDiskStaticSource(options.staticRoot));

  // ポートが決まるまで、起動ごとの値は作れない（cookieの名前にポートを含める）。
  let session: LaunchSession | undefined;
  let launchFile: LaunchFile | undefined;
  let port = options.port;
  let expectedHost = '';
  let expectedOrigin = '';

  // 消し終えた（removed・missing）ら、それ以上は試さない。replaced・failedは、closeでもう一度確かめる。
  let launchFileState: LaunchFileCleanup | undefined;
  const removeLaunchFileNow = (): LaunchFileCleanup => {
    if (launchFile === undefined) return 'missing';
    if (launchFileState === 'removed' || launchFileState === 'missing') return launchFileState;
    try {
      launchFileState = removeLaunchFile(launchFile, options.removeFile);
      if (launchFileState === 'replaced') log('launch-file-replaced（作ったファイルと違うものになっていたので消さなかった）');
    } catch (error) {
      launchFileState = 'failed';
      log(`launch-file-remove-failed ${errorName(error)}`);
    }
    return launchFileState;
  };

  // closeが所有するもの: 実行中の要求の処理、upgrade済みのソケット、中止の合図。
  const inflight = new Set<Promise<void>>();
  const upgradedSockets = new Set<Duplex>();
  const shutdown = new AbortController();

  const reject = (res: ServerResponse, rejection: Rejection, api: boolean): void => {
    res.statusCode = rejection.status;
    if (rejection.status === 405 && !api) res.setHeader('Allow', 'GET, HEAD');
    res.setHeader('X-Kurashi-Ledger-Reason', rejection.code);
    if (api) {
      const body = Buffer.from(JSON.stringify({ error: rejection.code }), 'utf8');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', body.length);
      res.end(body);
    } else {
      const body = Buffer.from(`${rejection.status} ${STATUS_CODES[rejection.status] ?? ''}\n`, 'utf8');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Length', body.length);
      res.end(body);
    }
  };

  const sendJson = (res: ServerResponse, response: ApiResponse): void => {
    res.statusCode = response.status;
    if (response.status === 204 || response.status === 304) {
      res.end();
      return;
    }
    const body = Buffer.from(JSON.stringify(response.body ?? {}), 'utf8');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', body.length);
    res.end(body);
  };

  const sendFile = (res: ServerResponse, body: Buffer, contentType: string, launchId: string): void => {
    let payload = body;
    if (isHtml(contentType)) {
      const injected = injectLaunchId(body, launchId);
      if (injected === undefined) {
        reject(res, { status: 500, code: 'html-without-head-or-with-launch-id' }, false);
        return;
      }
      payload = injected;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', payload.length);
    res.end(payload);
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, current: LaunchSession, path: string): Promise<void> => {
    const method = req.method ?? '';
    const changesState = method !== 'GET' && method !== 'HEAD';
    // GET/HEADでも、Sec-Fetch-Site・Originがあれば同じoriginであることを求める（追加の防御）。
    const origin = checkSameOrigin(req, expectedOrigin, changesState);
    if (origin !== undefined) return reject(res, origin, true);
    const launch = checkLaunchId(req, current.launchId);
    if (launch !== undefined) return reject(res, launch, true);

    if (path === EXCHANGE_PATH) {
      if (method !== 'POST') return reject(res, { status: 405, code: 'method-not-allowed' }, true);
      const type = checkContentType(req, 'json');
      if (type !== undefined) return reject(res, type, true);
      const body = await readBody(req, EXCHANGE_MAX_BYTES, shutdown.signal);
      if (!body.ok) return reject(res, body.rejection, true);
      const parsed = parseJson(body.data);
      if (!parsed.ok) return reject(res, { status: 400, code: 'invalid-json' }, true);
      const value = parsed.value;
      const candidate = typeof value === 'object' && value !== null && 'token' in value ? (value as { token: unknown }).token : undefined;
      const result = current.exchange(candidate);
      if (!result.ok) return reject(res, { status: 403, code: 'token-rejected' }, true);
      res.setHeader('Set-Cookie', `${current.cookieName}=${result.sessionId}; Path=/; HttpOnly; SameSite=Strict`);
      removeLaunchFileNow();
      return sendJson(res, { status: 204 });
    }

    const sameRoute = routes.filter((route) => route.path === path);
    const route = sameRoute.find((r) => r.method === method);
    if (changesState) {
      const type = checkContentType(req, route?.body?.type ?? 'json');
      if (type !== undefined) return reject(res, type, true);
    }
    if (!current.isValidSession(cookieValues(req, current.cookieName))) return reject(res, { status: 401, code: 'session-required' }, true);
    if (sameRoute.length === 0) return reject(res, { status: 404, code: 'not-found' }, true);
    if (route === undefined) return reject(res, { status: 405, code: 'method-not-allowed' }, true);

    let requestBody: unknown;
    if (changesState) {
      const body = await readBody(req, route.body?.maxBytes ?? DEFAULT_JSON_MAX_BYTES, shutdown.signal);
      if (!body.ok) return reject(res, body.rejection, true);
      if ((route.body?.type ?? 'json') === 'json') {
        const parsed = parseJson(body.data);
        if (!parsed.ok) return reject(res, { status: 400, code: 'invalid-json' }, true);
        requestBody = parsed.value;
      } else {
        requestBody = body.data;
      }
    }
    const response = await route.handle({ method: route.method, path, body: requestBody, signal: shutdown.signal });
    sendJson(res, response);
  };

  const handleUi = async (req: IncomingMessage, res: ServerResponse, current: LaunchSession, path: string): Promise<void> => {
    const method = req.method ?? '';
    if (method !== 'GET' && method !== 'HEAD') return reject(res, { status: 405, code: 'method-not-allowed' }, false);
    if (path === LAUNCH_PATH) return sendFile(res, Buffer.from(LAUNCH_PAGE_HTML, 'utf8'), 'text/html; charset=utf-8', current.launchId);
    if (path === LAUNCH_SCRIPT_PATH) return sendFile(res, Buffer.from(LAUNCH_SCRIPT, 'utf8'), 'text/javascript; charset=utf-8', current.launchId);
    if (options.dev !== undefined) {
      const dev = options.dev;
      await runDevMiddleware(dev.middleware, req, res, (error) => {
        if (!res.headersSent && !res.writableEnded) {
          reject(res, error === undefined ? { status: 404, code: 'not-found' } : { status: 500, code: 'dev-middleware-error' }, false);
        }
      });
      return;
    }
    const parsed = parseStaticPath(req.url ?? '');
    if (!parsed.ok) return reject(res, { status: parsed.status, code: parsed.code }, false);
    if (staticSource === undefined) {
      if (parsed.segments.length === 1 && parsed.segments[0] === 'index.html') {
        return sendFile(res, Buffer.from(PLACEHOLDER_PAGE_HTML, 'utf8'), 'text/html; charset=utf-8', current.launchId);
      }
      return reject(res, { status: 404, code: 'not-found' }, false);
    }
    const file = await staticSource.read(parsed.segments);
    if (file === undefined) return reject(res, { status: 404, code: 'not-found' }, false);
    sendFile(res, file.body, file.contentType, current.launchId);
  };

  const server: Server = createServer((req, res) => {
    const current = session;
    const rawUrl = req.url ?? '';
    // 振り分けには、クエリだけを除いた生のパスを使う。safePath（置き換え・切り詰め）はログにだけ使う。
    const query = rawUrl.indexOf('?');
    const path = query < 0 ? rawUrl : rawUrl.slice(0, query);
    const logPath = safePath(rawUrl);
    const api = path === '/api' || path.startsWith('/api/');
    const isDev = options.dev !== undefined && !api && path !== LAUNCH_PATH && path !== LAUNCH_SCRIPT_PATH;
    let csp = PRODUCTION_CSP;
    if (isDev && current !== undefined) {
      const nonce = randomBytes(16).toString('base64');
      csp = developmentCsp(nonce, port);
      devContexts.set(req, { launchId: current.launchId, nonce, signal: shutdown.signal });
    }
    enforceResponseHeaders(res, csp);
    res.on('finish', () => {
      const reason = res.getHeader('X-Kurashi-Ledger-Reason');
      log(`${req.method ?? '?'} ${logPath} ${res.statusCode}${reason === undefined ? '' : ` ${String(reason)}`}`);
    });
    if (current === undefined) return reject(res, { status: 503, code: 'starting' }, api);
    // 終了中は、すでにある接続に届いた要求も受け付けない。
    if (shutdown.signal.aborted) {
      res.setHeader('Connection', 'close');
      return reject(res, { status: 503, code: 'closing' }, api);
    }
    const host = checkHost(req, expectedHost);
    if (host !== undefined) return reject(res, host, api);
    if (!rawUrl.startsWith('/')) return reject(res, { status: 400, code: 'bad-request-target' }, api);
    const work = (api ? handleApi(req, res, current, path) : handleUi(req, res, current, path)).catch((error: unknown) => {
      log(`internal-error ${errorName(error)}`);
      if (!res.headersSent) reject(res, { status: 500, code: 'internal-error' }, api);
      else res.destroy();
    });
    inflight.add(work);
    void work.finally(() => inflight.delete(work));
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = safePath(req.url);
    // 受け付けるか拒否するかを決める前に、すべてのupgradeのソケットを追跡する（closeAllConnectionsはupgradeの
    // ソケットを閉じない。拒否してend()したソケットも、相手が書込み側を閉じなければ残るので、closeで壊す）。
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    // 終了中に届いたupgradeは、応答せずに壊す（終了の手順のあとに残さない）。
    if (shutdown.signal.aborted) {
      socket.destroy();
      return;
    }
    const refuse = (rejection: Rejection): void => {
      log(`UPGRADE ${path} ${rejection.status} ${rejection.code}`);
      socket.end(`HTTP/1.1 ${rejection.status} ${STATUS_CODES[rejection.status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const current = session;
    if (current === undefined) return refuse({ status: 503, code: 'starting' });
    if (shutdown.signal.aborted) return refuse({ status: 503, code: 'closing' });
    const host = checkHost(req, expectedHost);
    if (host !== undefined) return refuse(host);
    const origin = checkSameOrigin(req, expectedOrigin, true);
    if (origin !== undefined) return refuse(origin);
    if (req.headersDistinct['origin'] === undefined) return refuse({ status: 403, code: 'origin-required' });
    if (!current.isValidSession(cookieValues(req, current.cookieName))) return refuse({ status: 401, code: 'session-required' });
    const upgrade = options.dev?.upgrade;
    if (upgrade === undefined) return refuse({ status: 404, code: 'no-websocket' });
    log(`UPGRADE ${path} accepted`);
    // 開発時の口の処理が同期で例外を投げても、プロセスへ抜けさせない。理由の符号だけを記録し、ソケットを壊す。
    try {
      upgrade(req, socket, head);
    } catch (error) {
      log(`UPGRADE ${path} upgrade-handler-error ${errorName(error)}`);
      upgradedSockets.delete(socket);
      socket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown): void => {
      server.off('listening', onListening);
      if (errorName(error) === 'EADDRINUSE') reject(new PortInUseError(options.port));
      else reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port: options.port, host: LISTEN_HOST, exclusive: true });
  });

  const address = server.address() as AddressInfo;
  port = address.port;
  expectedHost = `${LISTEN_HOST}:${port}`;
  expectedOrigin = `http://${expectedHost}`;
  const current = createLaunchSession(port);
  const tokenUrl = `${expectedOrigin}${LAUNCH_PATH}#${current.token}`;
  const closeServer = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  // 終了の手順（closeの契約）。
  const shutDown = async (): Promise<void> => {
    shutdown.abort();
    // 1. 新しい接続を受け付けない（待受を止める。完了の通知は、すべての接続が閉じてから）。
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    // 2. upgradeのソケット（受け付けたものと、拒否して書込み側を閉じたもの）を壊す。
    for (const socket of upgradedSockets) socket.destroy();
    // 3. 実行中の処理（APIの処理と、開発時のmiddlewareの処理。runDevMiddlewareの契約）に中止を知らせたうえで、
    //    すべての完了を待つ（処理中に新しく加わったものも待つ）。
    server.closeIdleConnections();
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
    // 4. 残ったHTTPの接続を閉じ、待受の終了を待つ。
    server.closeAllConnections();
    for (const socket of upgradedSockets) socket.destroy(); // 待つ間に届いたもの
    await stopped;
  };
  try {
    launchFile = createLaunchFile(tokenDirectory, randomLaunchFileName(), launchFileHtml(tokenUrl));
  } catch (error) {
    await closeServer();
    throw error;
  }
  session = current;
  const createdFile = launchFile;

  let closing: Promise<CloseResult> | undefined;
  return {
    port,
    origin: expectedOrigin,
    address,
    launchId: current.launchId,
    cookieName: current.cookieName,
    launchFile: createdFile.path,
    launchFileUrl: pathToFileURL(createdFile.path).href,
    tokenUrl,
    close() {
      closing ??= (async () => {
        // 待受の停止とトークンの無効化は、一時ファイルの後始末の結果によらず行う。
        current.revoke();
        await shutDown();
        const cleanup = removeLaunchFileNow();
        return { launchFile: cleanup, launchFilePath: createdFile.path };
      })();
      return closing;
    },
  };
}
