// GitHub Appのinstallation access tokenを発行する中核（docs/github-apps.md）。
// 入口は scripts/github-app-token.ts。時計・fetch・鍵の読取り・出力は注入するので、試験は
// ネットワークとキーチェーンを使わない。
//
// 守ること:
// - 標準出力には、成功したときのトークン（と改行）だけを出す。それ以外はすべて標準エラー。
// - 鍵・JWT・トークンを、エラー・ログに出さない。GitHubのメッセージも、既知の秘密と長い英数字の並びを伏せてから出す。
// - ディスクに書かない。AppのID・Installation ID・鍵をrepoに置かない（実行時に環境変数・引数・キーチェーンから渡す）。
// - 依存を加えない（node:crypto・fetch・node:child_process・node:fsだけ）。
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';

export const API_ORIGIN = 'https://api.github.com';
export const API_VERSION = '2022-11-28';
export const REPOSITORY_NAME = 'kurashi-ledger';
export const USER_AGENT = 'kurashi-ledger-github-app-token';
export const KEYCHAIN_TOOL = '/usr/bin/security';
export const MAX_KEY_BYTES = 16 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;
// キーチェーンは、項目への接続の許可やロックの解除のダイアログを出すことがあるので長めにする。
export const KEYCHAIN_TIMEOUT_MS = 60_000;
export const JWT_BACKDATE_SECONDS = 60;
export const JWT_LIFETIME_SECONDS = 9 * 60;

export type Agent = 'codex' | 'claude';
export type Purpose = 'review' | 'implement';
export type PermissionLevel = 'read' | 'write';

// AIの身元（GitHub App）ごとの設定。2つのAppは同じ権限を持ち、どちらのAIも実装とレビューを行う。
// 分離は役割ではなく身元で行う: AIは自分が実装した・pushしたPRを承認しない（docs/github-apps.md）。
export type AgentProfile = {
  // キーチェーンのserviceの既定。所有者が登録した名前をそのまま使う（名前の中の役割は昔の呼び名で、意味を持たない）。
  readonly keychainService: string;
  readonly appIdEnv: string;
  readonly installationIdEnv: string;
};

export const AGENTS: Readonly<Record<Agent, AgentProfile>> = {
  codex: {
    keychainService: 'kurashi-ledger-codex-reviewer',
    appIdEnv: 'KL_GITHUB_APP_ID_CODEX',
    installationIdEnv: 'KL_GITHUB_APP_INSTALLATION_ID_CODEX',
  },
  claude: {
    keychainService: 'kurashi-ledger-claude-implementer',
    appIdEnv: 'KL_GITHUB_APP_ID_CLAUDE',
    installationIdEnv: 'KL_GITHUB_APP_INSTALLATION_ID_CLAUDE',
  },
};

// トークンごとに縮小する権限（最小権限）。Appがより多くの権限を持っていても、トークンは用途の分だけにする。
// administrationはどちらにも入れない（rulesetを変えられない）。
export const PURPOSES: Readonly<Record<Purpose, Readonly<Record<string, PermissionLevel>>>> = {
  // レビューの投稿（PRのレビューとPRへのコメント）とCIの結果の読取り。PRへのコメントはpull_requests:writeで書ける
  // ので、issues:writeは入れない（Issueへの書込みが要る作業はimplementで行う。docs/github-apps.md）。
  review: { pull_requests: 'write', contents: 'read', actions: 'read' },
  // branchのpush、PR・Issue・コメントの作成、.github/workflows/を変えるPRのpush。
  implement: { contents: 'write', pull_requests: 'write', issues: 'write', actions: 'read', workflows: 'write' },
};

// GitHubがトークンの権限に必ず加えるもの。
const IMPLICIT_PERMISSIONS: Readonly<Record<string, PermissionLevel>> = { metadata: 'read' };

export type KeySource =
  | { readonly kind: 'keychain'; readonly service: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'stdin' };

export type Options = {
  readonly agent: Agent;
  readonly purpose: Purpose;
  readonly appId: string;
  readonly installationId: string;
  readonly key: KeySource;
};

export class UsageError extends Error {}
// 利用者に見せてよい（秘密を含まない）文だけを持つエラー。
export class TokenError extends Error {}

export const USAGE = `使い方: node scripts/github-app-token.ts --agent <codex|claude> --purpose <review|implement> [鍵の取り出し方]

AIの身元（GitHub App）のinstallation access tokenを発行し、標準出力にトークンだけを出す（docs/github-apps.md）。

  --agent <codex|claude>          必須。どのAIのAppか。キーチェーンのserviceと環境変数を決める
  --purpose <review|implement>    必須。トークンを縮小する権限
                                    review:    ${Object.entries(PURPOSES.review).map(([k, v]) => `${k}:${v}`).join(' ')}
                                    implement: ${Object.entries(PURPOSES.implement).map(([k, v]) => `${k}:${v}`).join(' ')}
  --app-id <数字>                 既定は環境変数（codex: ${AGENTS.codex.appIdEnv}、claude: ${AGENTS.claude.appIdEnv}）
  --installation-id <数字>        既定は環境変数（codex: ${AGENTS.codex.installationIdEnv}、claude: ${AGENTS.claude.installationIdEnv}）

鍵の取り出し方（どれか1つ。既定はmacOSのキーチェーン）:
  --keychain-service <名前>       キーチェーンの汎用パスワードのservice（値はPEMのbase64）。既定は
                                    codex: ${AGENTS.codex.keychainService}、claude: ${AGENTS.claude.keychainService}
  --key-file <パス>               PEMのファイル。macOS・Linuxでは所有者だけが読める権限（600）でなければ拒む
  --key-stdin                     標準入力からPEM（またはPEMのbase64）を読む

例: GH_TOKEN="$(node scripts/github-app-token.ts --agent codex --purpose review)" gh pr view 1
`;

const ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isAgent(value: string): value is Agent {
  return value === 'codex' || value === 'claude';
}

export function isPurpose(value: string): value is Purpose {
  return value === 'review' || value === 'implement';
}

export function validateId(value: string | undefined, what: string): string {
  if (value === undefined || value === '') throw new UsageError(`${what}がない。`);
  // 値そのものは表示しない（誤って鍵等を貼り付けた場合に出さないため）。
  if (!ID_PATTERN.test(value)) throw new UsageError(`${what}は数字だけで書く（先頭は0以外、19桁まで）。`);
  return value;
}

const FLAGS_WITH_VALUE = new Set(['--agent', '--purpose', '--app-id', '--installation-id', '--keychain-service', '--key-file']);
const FLAGS_WITHOUT_VALUE = new Set(['--key-stdin', '--help', '-h']);

export type ParseResult = { readonly help: true } | { readonly help: false; readonly options: Options };

export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): ParseResult {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (FLAGS_WITH_VALUE.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg}の値がない。`);
      if (values.has(arg)) throw new UsageError(`${arg}を2回指定した。`);
      values.set(arg, value);
      i++;
    } else if (FLAGS_WITHOUT_VALUE.has(arg)) {
      if (switches.has(arg)) throw new UsageError(`${arg}を2回指定した。`);
      switches.add(arg);
    } else {
      // 知らない引数の中身は表示しない（鍵等を誤って渡した場合に出さないため）。
      throw new UsageError(`知らない引数がある（${i + 1}番目）。`);
    }
  }
  if (switches.has('--help') || switches.has('-h')) return { help: true };

  const agent = values.get('--agent');
  if (agent === undefined) throw new UsageError('--agentがない（codex か claude）。');
  if (!isAgent(agent)) throw new UsageError('--agentは codex か claude。');
  const purpose = values.get('--purpose');
  if (purpose === undefined) throw new UsageError('--purposeがない（review か implement）。');
  if (!isPurpose(purpose)) throw new UsageError('--purposeは review か implement。');
  const profile = AGENTS[agent];

  const appId = validateId(values.get('--app-id') ?? env[profile.appIdEnv], `AppのID（--app-id か ${profile.appIdEnv}）`);
  const installationId = validateId(
    values.get('--installation-id') ?? env[profile.installationIdEnv],
    `Installation ID（--installation-id か ${profile.installationIdEnv}）`,
  );

  const sources = [values.has('--keychain-service'), values.has('--key-file'), switches.has('--key-stdin')].filter(Boolean);
  if (sources.length > 1) throw new UsageError('鍵の取り出し方は1つだけ指定する（--keychain-service・--key-file・--key-stdin）。');
  let key: KeySource;
  const file = values.get('--key-file');
  if (file !== undefined) {
    key = { kind: 'file', path: file };
  } else if (switches.has('--key-stdin')) {
    key = { kind: 'stdin' };
  } else {
    const service = values.get('--keychain-service') ?? profile.keychainService;
    if (!SERVICE_PATTERN.test(service)) throw new UsageError('キーチェーンのserviceは英数字と . _ - だけ（128文字まで）。');
    key = { kind: 'keychain', service };
  }
  return { help: false, options: { agent, purpose, appId, installationId, key } };
}

const PEM_PREFIX = '-----BEGIN ';
const BASE64_TEXT = /^[A-Za-z0-9+/=\s]+$/;

// 鍵の材料（PEM、またはPEMのbase64）からPEMを取り出す。中身はエラーに出さない。
export function pemFromKeyMaterial(material: string): string {
  const text = material.trim();
  if (text.startsWith(PEM_PREFIX)) return text;
  if (text !== '' && BASE64_TEXT.test(text)) {
    const decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64');
    try {
      const pem = decoded.toString('utf8').trim();
      if (pem.startsWith(PEM_PREFIX)) return pem;
    } finally {
      decoded.fill(0);
    }
  }
  throw new TokenError('鍵の形式が違う（PEMか、PEMのbase64を渡す）。中身は表示しない。');
}

export function loadPrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // OpenSSLのメッセージも出さない。
    throw new TokenError('秘密鍵を読めなかった（PEMの秘密鍵でない、または壊れている）。中身は表示しない。');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new TokenError('秘密鍵がRSAでない（GitHub AppはRS256）。');
  return key;
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

// RS256のJWT。iat = now-60（時計のずれに備える）、exp = now+9分（GitHubの上限は10分）、iss = AppのID。
export function createAppJwt(appId: string, key: KeyObject, nowSeconds: number): string {
  validateId(appId, 'AppのID');
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= JWT_BACKDATE_SECONDS) throw new TokenError('時刻が不正。');
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: nowSeconds - JWT_BACKDATE_SECONDS, exp: nowSeconds + JWT_LIFETIME_SECONDS, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), key);
  return `${signingInput}.${signature.toString('base64url')}`;
}

export type FetchInit = {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
};
export type FetchResponse = { readonly status: number; text(): Promise<string> };
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export function tokenRequest(
  installationId: string,
  jwt: string,
  purpose: Purpose,
): { readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body: string } {
  validateId(installationId, 'Installation ID');
  return {
    url: `${API_ORIGIN}/app/installations/${installationId}/access_tokens`,
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': API_VERSION,
    },
    body: JSON.stringify({ repositories: [REPOSITORY_NAME], permissions: PURPOSES[purpose] }),
  };
}

// 出力してよい文にする: 既知の秘密と、長い英数字の並び（JWT・トークン・鍵の行になりうる）を伏せ、
// 制御文字を除き、長さを切る。
export function sanitize(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('[伏せた]');
  }
  // 数字を含む32文字以上の並びだけを伏せる（英字とハイフンだけのserviceの名前等は残す）。
  out = out.replace(/[A-Za-z0-9+/=_.-]{32,}/g, (run) => (/[0-9]/.test(run) ? '[伏せた]' : run));
  out = out.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

function describeFailure(error: unknown): string {
  // 例外のメッセージは出さない（URLや要求の内容を含みうる）。種類だけを出す。
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const cause = (error as { cause?: { code?: unknown } }).cause;
    const causeCode = cause && typeof cause.code === 'string' ? cause.code : undefined;
    const detail = [error.name, typeof code === 'string' ? code : undefined, causeCode].filter(
      (s): s is string => s !== undefined && /^[A-Za-z0-9_]{1,40}$/.test(s),
    );
    if (detail.length > 0) return detail.join('・');
  }
  return '不明';
}

async function readBody(response: FetchResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function githubMessage(body: string, secrets: readonly string[]): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string') {
      return sanitize((parsed as { message: string }).message, secrets);
    }
  } catch {
    // JSONでなければ下へ
  }
  return '（GitHubのメッセージなし）';
}

const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;

// 応答の権限・repoが要求どおりか。違えば理由を返す（トークンは含めない）。
export function checkGrantedScope(response: unknown, purpose: Purpose): string | null {
  if (response === null || typeof response !== 'object') return '応答がJSONのオブジェクトでない';
  const r = response as { permissions?: unknown; repository_selection?: unknown; repositories?: unknown };
  const expected: Record<string, PermissionLevel> = { ...PURPOSES[purpose] };
  if (r.permissions === null || typeof r.permissions !== 'object') return '応答に権限がない';
  const granted = r.permissions as Record<string, unknown>;
  for (const [name, level] of Object.entries(granted)) {
    if (expected[name] === level) continue;
    if (IMPLICIT_PERMISSIONS[name] === level) continue;
    return `要求していない権限（${sanitize(name, [])}）がある`;
  }
  for (const [name, level] of Object.entries(expected)) {
    if (granted[name] !== level) return `権限（${name}: ${level}）が付かなかった`;
  }
  if (r.repository_selection !== 'selected') return 'repoが選んだものだけに縮小されていない';
  if (r.repositories !== undefined) {
    if (!Array.isArray(r.repositories) || r.repositories.length !== 1) return 'repoが1つでない';
    const name = (r.repositories[0] as { name?: unknown } | undefined)?.name;
    if (name !== REPOSITORY_NAME) return `repoが${REPOSITORY_NAME}でない`;
  }
  return null;
}

async function revokeToken(fetchImpl: FetchLike, token: string, timeoutMs: number): Promise<string> {
  try {
    const response = await fetchImpl(`${API_ORIGIN}/installation/token`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.status === 204 ? '発行されたトークンは失効させた。' : `発行されたトークンを失効できなかった（HTTP ${response.status}）。1時間で失効する。`;
  } catch (error) {
    return `発行されたトークンを失効できなかった（${describeFailure(error)}）。1時間で失効する。`;
  }
}

export async function requestInstallationToken(args: {
  readonly fetch: FetchLike;
  readonly installationId: string;
  readonly jwt: string;
  readonly purpose: Purpose;
  readonly timeoutMs: number;
  readonly secrets: readonly string[];
}): Promise<string> {
  const request = tokenRequest(args.installationId, args.jwt, args.purpose);
  let response: FetchResponse;
  try {
    response = await args.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (error) {
    throw new TokenError(`GitHubへの要求が失敗した（${describeFailure(error)}）。`);
  }
  const body = await readBody(response);
  const secrets = [...args.secrets, args.jwt];
  if (response.status !== 201) {
    throw new TokenError(`GitHubがトークンを発行しなかった（HTTP ${response.status}）: ${githubMessage(body, secrets)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TokenError('GitHubの応答がJSONでない（HTTP 201）。');
  }
  const token = (parsed as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new TokenError('GitHubの応答にトークンがない、または形式が違う。');
  const problem = checkGrantedScope(parsed, args.purpose);
  if (problem !== null) {
    const revoked = await revokeToken(args.fetch, token, args.timeoutMs);
    throw new TokenError(`発行されたトークンの範囲が要求と違うので使わない（${problem}）。${revoked}`);
  }
  return token;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { readonly encoding: 'utf8'; readonly timeout: number; readonly maxBuffer: number; readonly windowsHide: boolean },
) => Promise<{ readonly stdout: string }>;

// macOSのキーチェーンの汎用パスワードを読む。シェルを通さず、決めた引数だけで/usr/bin/securityを呼ぶ。
export async function readKeychainKey(
  service: string,
  account: string,
  platform: NodeJS.Platform,
  execFileImpl: ExecFileLike,
): Promise<string> {
  if (platform !== 'darwin') throw new TokenError('キーチェーンはmacOSだけ。ほかのOSでは --key-file か --key-stdin を使う。');
  if (!SERVICE_PATTERN.test(service)) throw new TokenError('キーチェーンのserviceの形式が違う。');
  if (account === '' || /[\u0000-\u001f]/.test(account)) throw new TokenError('キーチェーンのaccount（ユーザー名）を決められない。');
  try {
    const { stdout } = await execFileImpl(KEYCHAIN_TOOL, ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      timeout: KEYCHAIN_TIMEOUT_MS,
      maxBuffer: MAX_KEY_BYTES * 2,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    // securityの出力やコマンドの文は出さない。終了コードだけ。
    const code = (error as { code?: unknown }).code;
    if (code === 44) throw new TokenError(`キーチェーンに項目がない（service ${service}、account は実行中のユーザー）。`);
    const shown = typeof code === 'number' ? `終了コード ${code}` : describeFailure(error);
    throw new TokenError(`キーチェーンから読めなかった（${shown}）。`);
  }
}

type StatLike = Pick<Stats, 'mode' | 'uid' | 'dev' | 'ino' | 'size'> & { isFile(): boolean; isSymbolicLink(): boolean };

// 鍵ファイルを読んでよいか。読んではいけなければ理由を返す。
// lstatは開く前のパスの項目、fstatは開いたもの。symlinkを拒み、開く間の差し替えも拒む。
// Windowsは、POSIXの権限のビットがNTFSのACLを表さないので、権限は確かめない（docs/github-apps.md）。
export function keyFileProblem(lstat: StatLike, fstat: StatLike, platform: NodeJS.Platform, uid: number | undefined): string | null {
  if (lstat.isSymbolicLink() || !lstat.isFile()) return '通常のファイルでない（symlink等は使えない）';
  if (!fstat.isFile() || fstat.dev !== lstat.dev || fstat.ino !== lstat.ino) return '確かめている間にファイルが置き換わった';
  if (fstat.size > MAX_KEY_BYTES) return `大きすぎる（${MAX_KEY_BYTES}バイトまで）`;
  if (platform !== 'win32') {
    if ((fstat.mode & 0o077) !== 0) return '所有者だけが読める権限でない（chmod 600 にする）';
    if (uid !== undefined && fstat.uid !== uid) return '所有者が実行中のユーザーでない';
  }
  return null;
}

export type KeyFileResult = { readonly text: string; readonly warning?: string };

export function readKeyFileFromDisk(path: string, platform: NodeJS.Platform, uid: number | undefined): KeyFileResult {
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    throw new TokenError(`鍵ファイルを読めなかった（${describeFailure(error)}）。`);
  }
  // O_NOFOLLOWはmacOS・Linuxだけにある。Windowsでは上のlstatで拒む。
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (error) {
    throw new TokenError(`鍵ファイルを開けなかった（${describeFailure(error)}）。`);
  }
  try {
    const opened = fstatSync(fd);
    const problem = keyFileProblem(before, opened, platform, uid);
    if (problem !== null) throw new TokenError(`鍵ファイルを使わない: ${problem}。`);
    const buffer = Buffer.alloc(MAX_KEY_BYTES + 1);
    let length = 0;
    for (;;) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
      if (length > MAX_KEY_BYTES) {
        buffer.fill(0);
        throw new TokenError(`鍵ファイルを使わない: 大きすぎる（${MAX_KEY_BYTES}バイトまで）。`);
      }
    }
    const text = buffer.subarray(0, length).toString('utf8');
    buffer.fill(0);
    return platform === 'win32'
      ? { text, warning: 'Windowsでは鍵ファイルの権限（ACL）を確かめていない。所有者だけが読めるようにしておく（docs/github-apps.md）。' }
      : { text };
  } finally {
    closeSync(fd);
  }
}

export type Deps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
  readonly username: string;
  nowSeconds(): number;
  readonly fetch: FetchLike;
  readKeychain(service: string, account: string): Promise<string>;
  readKeyFile(path: string): KeyFileResult;
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  readonly timeoutMs?: number;
};

// 終了コード: 0 成功、1 発行の失敗、2 引数の誤り。
export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  let parsed: ParseResult;
  try {
    parsed = parseArgs(argv, deps.env);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (parsed.help) {
    deps.stderr(USAGE);
    return 0;
  }
  const { options } = parsed;
  const secrets: string[] = [];
  try {
    let material: string;
    if (options.key.kind === 'keychain') {
      material = await deps.readKeychain(options.key.service, deps.username);
    } else if (options.key.kind === 'file') {
      const result = deps.readKeyFile(options.key.path);
      if (result.warning !== undefined) deps.stderr(`注意: ${result.warning}\n`);
      material = result.text;
    } else {
      material = await deps.readStdin();
    }
    secrets.push(material.trim());
    const pem = pemFromKeyMaterial(material);
    secrets.push(pem, ...pem.split(/\r?\n/).filter((line) => line.length >= 16));
    const key = loadPrivateKey(pem);
    const jwt = createAppJwt(options.appId, key, deps.nowSeconds());
    secrets.push(jwt);
    const token = await requestInstallationToken({
      fetch: deps.fetch,
      installationId: options.installationId,
      jwt,
      purpose: options.purpose,
      timeoutMs: deps.timeoutMs ?? REQUEST_TIMEOUT_MS,
      secrets,
    });
    deps.stdout(`${token}\n`);
    return 0;
  } catch (error) {
    if (error instanceof TokenError) {
      deps.stderr(`トークンを発行できなかった: ${sanitize(error.message, secrets)}\n`);
    } else {
      deps.stderr(`トークンを発行できなかった: 予期しないエラー（${describeFailure(error)}）。\n`);
    }
    return 1;
  }
}
