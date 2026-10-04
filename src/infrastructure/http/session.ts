// 起動ごとの秘密と識別子（ADR-0003の4・14、ADR-0009）。すべてメモリの中だけにあり、プロセスの終了で消える。
// - 起動の識別子: 16バイトの暗号論的乱数のbase64url（22文字）。秘密ではない（HTMLの<meta>に入れる）。
// - トークン: 32バイト（256bit）の暗号論的乱数のbase64url。1回だけcookieに交換できる。
// - cookieの値（セッション）: トークンとは別の32バイトの乱数。cookieの名前にはポート番号を含める。
import { randomBytes, timingSafeEqual } from 'node:crypto';

export type ExchangeResult = { readonly ok: true; readonly sessionId: string } | { readonly ok: false };

export type LaunchSession = {
  readonly launchId: string;
  readonly cookieName: string;
  // 起動用の一時ファイルとターミナルの表示にだけ使う。ログに出さない。
  readonly token: string;
  exchange(candidate: unknown): ExchangeResult;
  isValidSession(values: readonly string[]): boolean;
  // 終了時に、トークンとセッションを無効にする。
  revoke(): void;
};

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function cookieNameFor(port: number): string {
  return `kl_session_${port}`;
}

export function createLaunchSession(port: number): LaunchSession {
  const launchId = randomBytes(16).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  let tokenUsable = true;
  const sessions: string[] = [];
  return {
    launchId,
    cookieName: cookieNameFor(port),
    token,
    exchange(candidate) {
      if (!tokenUsable || typeof candidate !== 'string' || !sameSecret(candidate, token)) return { ok: false };
      tokenUsable = false;
      const sessionId = randomBytes(32).toString('base64url');
      sessions.push(sessionId);
      return { ok: true, sessionId };
    },
    isValidSession(values) {
      return values.some((value) => sessions.some((session) => sameSecret(value, session)));
    },
    revoke() {
      tokenUsable = false;
      sessions.length = 0;
    },
  };
}
