// GitHub Appのinstallation access tokenを発行し、そのトークンで1つのコマンドを子プロセスとして実行する中核
// （docs/github-apps.md）。入口は scripts/github-app-token.ts。時計・fetch・鍵の読取り・子プロセス・一時の
// ディレクトリは注入するので、試験はネットワークとキーチェーンを使わない。
//
// 守ること（2026-10-03の所有者決定: スクリプトがコマンドを実行する）:
// - トークンは子プロセスの環境のGH_TOKENにだけ置く。標準出力・標準エラー・ファイルに出さない。
// - 子は、発行と範囲の確認がすべて済んだときだけ起動する。失敗したら起動しない（所有者の資格情報に戻らない）。
// - 子の環境では、ghとgitが保存済みの資格情報（doc-gif）やSSHに戻らないようにする（childEnvironment）。
// - 子の終了後にトークンを失効させる。失敗は標準エラーに伝える。
// - 鍵・JWT・トークンを、エラーに出さない。GitHubのメッセージも、既知の秘密と長い英数字の並びを伏せてから出す。
// - AppのID・Installation ID・鍵をrepoに置かない（実行時に環境変数・引数・キーチェーンから渡す）。
// - 依存を加えない（Node.jsの組込みだけ）。
import { spawn } from 'node:child_process';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';

export const API_ORIGIN = 'https://api.github.com';
export const API_VERSION = '2022-11-28';
export const REPOSITORY_NAME = 'kurashi-ledger';
export const USER_AGENT = 'kurashi-ledger-github-app-token';
export const KEYCHAIN_TOOL = '/usr/bin/security';
export const MAX_KEY_BYTES = 16 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;
// キーチェーンは、項目への接続の許可やロックの解除のダイアログを出すことがあるので長めにする。
export const KEYCHAIN_TIMEOUT_MS = 60_000;
export const STDIN_TIMEOUT_MS = 10_000;
// スクリプト自身の失敗（引数の誤り・発行の失敗）。子の終了コードと区別するため、timeout(1)等と同じく125にする。
export const EXIT_OWN_FAILURE = 125;
export const EXIT_CANNOT_EXECUTE = 126;
export const EXIT_NOT_FOUND = 127;
export const JWT_BACKDATE_SECONDS = 60;
export const JWT_LIFETIME_SECONDS = 9 * 60;

export type Agent = 'codex' | 'claude';
export type Purpose = 'review' | 'implement' | 'implement-workflows';
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
// administrationはどれにも入れない（rulesetを変えられない）。この表の変更は権限の制御の変更なので、
// 独立したレビューを受ける（docs/github-apps.md）。
const CI_READ = { actions: 'read', checks: 'read', statuses: 'read' } as const;
const IMPLEMENT = { contents: 'write', pull_requests: 'write', issues: 'write', ...CI_READ } as const;
export const PURPOSES: Readonly<Record<Purpose, Readonly<Record<string, PermissionLevel>>>> = {
  // レビューの投稿（PRのレビューとPRへのコメント）とCIの結果の読取り。PRへのコメントはpull_requests:writeで書ける
  // ので、issues:writeは入れない（Issueへの書込みが要る作業はimplementで行う）。
  review: { pull_requests: 'write', contents: 'read', ...CI_READ },
  // branchのpush、PR・Issue・コメントの作成、マージ。.github/workflows/は変えられない。
  implement: IMPLEMENT,
  // .github/workflows/を変えるcommitのpushが要るときだけ使う（2026-10-03の所有者決定: 必要なときだけ付ける）。
  'implement-workflows': { ...IMPLEMENT, workflows: 'write' },
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
  // `--`のあとの、実行するコマンドとその引数。
  readonly command: readonly [string, ...string[]];
};

export class UsageError extends Error {}
// 利用者に見せてよい（秘密を含まない）文だけを持つエラー。
export class TokenError extends Error {}

const permissionList = (purpose: Purpose): string =>
  Object.entries(PURPOSES[purpose])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');

export const USAGE = `使い方: node <信頼した写し>/github-app-token.ts --agent <codex|claude> --purpose <用途> [鍵の取り出し方] -- <コマンド> [引数…]

AIの身元（GitHub App）のinstallation access tokenを発行し、確認がすべて済んだら、そのトークンを環境変数GH_TOKEN
にだけ置いて <コマンド> を子プロセスとして実行する。トークンは表示しない。子の終了後にトークンを失効させる。
PRのcheckoutから実行しない（docs/github-apps.md の「信頼した写し」）。

  --agent <codex|claude>          必須。どのAIのAppか。キーチェーンのserviceと環境変数を決める
  --purpose <用途>                必須。トークンを縮小する権限
                                    review:              ${permissionList('review')}
                                    implement:           ${permissionList('implement')}
                                    implement-workflows: ${permissionList('implement-workflows')}
  --app-id <数字>                 既定は環境変数（codex: ${AGENTS.codex.appIdEnv}、claude: ${AGENTS.claude.appIdEnv}）
  --installation-id <数字>        既定は環境変数（codex: ${AGENTS.codex.installationIdEnv}、claude: ${AGENTS.claude.installationIdEnv}）

鍵の取り出し方（どれか1つ。既定はmacOSのキーチェーン）:
  --keychain-service <名前>       キーチェーンの汎用パスワードのservice（値はPEMのbase64）。既定は
                                    codex: ${AGENTS.codex.keychainService}、claude: ${AGENTS.claude.keychainService}
  --key-file <パス>               PEMのファイル。macOS・Linuxでは所有者だけが読める権限（600）でなければ拒む
  --key-stdin                     標準入力からPEM（またはPEMのbase64）を読む（${STDIN_TIMEOUT_MS / 1000}秒まで）

終了コード: 子の終了コード（シグナルなら128+番号）。このスクリプト自身の失敗は${EXIT_OWN_FAILURE}、
コマンドを実行できなければ${EXIT_CANNOT_EXECUTE}、見つからなければ${EXIT_NOT_FOUND}。

例: node <信頼した写し>/github-app-token.ts --agent codex --purpose review -- gh pr view 1
`;

const ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isAgent(value: string): value is Agent {
  return value === 'codex' || value === 'claude';
}

export function isPurpose(value: string): value is Purpose {
  return value === 'review' || value === 'implement' || value === 'implement-workflows';
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
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  for (let i = 0; i < own.length; i++) {
    const arg = own[i] ?? '';
    if (FLAGS_WITH_VALUE.has(arg)) {
      const value = own[i + 1];
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
  if (purpose === undefined) throw new UsageError('--purposeがない（review・implement・implement-workflows）。');
  if (!isPurpose(purpose)) throw new UsageError('--purposeは review・implement・implement-workflows のどれか。');
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
  const [program, ...programArgs] = command;
  if (program === undefined || program === '') throw new UsageError('実行するコマンドがない（`-- <コマンド> [引数…]`）。トークンは表示しない。');
  return { help: false, options: { agent, purpose, appId, installationId, key, command: [program, ...programArgs] } };
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
  // リダイレクトを追わない（Authorizationを別の宛先へ送らない）。
  readonly redirect: 'error';
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
  // 完全一致: 要求した権限がその水準で付き、それ以外はGitHubが必ず加えるもの（metadata: read）だけ。
  // 自分のプロパティだけを見る（__proto__等の名前で照合をすり抜けさせない）。
  for (const [name, level] of Object.entries(granted)) {
    if (Object.hasOwn(expected, name) && expected[name] === level) continue;
    if (Object.hasOwn(IMPLICIT_PERMISSIONS, name) && IMPLICIT_PERMISSIONS[name] === level) continue;
    return `要求していない権限（${sanitize(name, [])}）がある`;
  }
  for (const [name, level] of Object.entries(expected)) {
    if (!Object.hasOwn(granted, name) || granted[name] !== level) return `権限（${name}: ${level}）が付かなかった`;
  }
  if (r.repository_selection !== 'selected') return 'repoが選んだものだけに縮小されていない';
  // repositoriesがなければ、縮小した先を確かめられないので失敗にする（fail closed）。
  return checkOnlyThisRepository(r.repositories, '発行の応答');
}

// repoの一覧が、このrepoの1件だけか。違う・確かめられなければ理由を返す。
export function checkOnlyThisRepository(repositories: unknown, where: string): string | null {
  if (repositories === undefined) return `${where}にrepoの一覧がない（縮小した先を確かめられない）`;
  if (!Array.isArray(repositories) || repositories.length !== 1) return `${where}のrepoが1つでない`;
  const name = (repositories[0] as { name?: unknown } | null | undefined)?.name;
  if (name !== REPOSITORY_NAME) return `${where}のrepoが${REPOSITORY_NAME}でない`;
  return null;
}

// 発行したトークンで、実際に触れるrepoを数える（GET /installation/repositories）。
// このrepoの1件だけでなければ、または確かめられなければ、理由を返す。
export async function verifyTokenRepositories(fetchImpl: FetchLike, token: string, timeoutMs: number): Promise<string | null> {
  let response: FetchResponse;
  try {
    response = await fetchImpl(`${API_ORIGIN}/installation/repositories?per_page=100`, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': API_VERSION,
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    return `触れるrepoの確認の要求が失敗した（${describeFailure(error)}）`;
  }
  if (response.status !== 200) return `触れるrepoを確かめられなかった（HTTP ${response.status}）`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(response));
  } catch {
    return '触れるrepoの確認の応答がJSONでない';
  }
  const r = parsed as { total_count?: unknown; repositories?: unknown } | null;
  if (r === null || typeof r !== 'object' || r.total_count !== 1) return '触れるrepoの数が1でない、または不明';
  return checkOnlyThisRepository(r.repositories, '触れるrepoの確認');
}

// 失効させる（DELETE /installation/token）。成功ならnull、失敗なら秘密を含まない理由を返す。
export async function revokeToken(fetchImpl: FetchLike, token: string, timeoutMs: number): Promise<string | null> {
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
      redirect: 'error',
    });
    return response.status === 204 ? null : `トークンを失効できなかった（HTTP ${response.status}）。1時間で失効する。`;
  } catch (error) {
    return `トークンを失効できなかった（${describeFailure(error)}）。1時間で失効する。`;
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
      redirect: 'error',
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
  const problem = checkGrantedScope(parsed, args.purpose) ?? (await verifyTokenRepositories(args.fetch, token, args.timeoutMs));
  if (problem !== null) {
    const revokeProblem = await revokeToken(args.fetch, token, args.timeoutMs);
    throw new TokenError(`発行されたトークンの範囲が要求と違うので使わない（${problem}）。${revokeProblem ?? '発行されたトークンは失効させた。'}`);
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
    if ((error as { killed?: unknown }).killed === true || typeof (error as { signal?: unknown }).signal === 'string') {
      throw new TokenError(`キーチェーンの読取りが時間切れになった（${KEYCHAIN_TIMEOUT_MS / 1000}秒。許可のダイアログに答えなかった等）。`);
    }
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new TokenError('キーチェーンの値が大きすぎる（鍵でない）。');
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
  // lstatで通常のファイルでないもの（symlink・FIFO・ディレクトリ等）は、開く前に拒む。
  if (!before.isFile() || before.isSymbolicLink()) throw new TokenError('鍵ファイルを使わない: 通常のファイルでない（symlink等は使えない）。');
  // O_NOFOLLOW・O_NONBLOCKはmacOS・Linuxだけにある。確かめた後にFIFOへ差し替えられても、開くところで止まらない
  // （O_NONBLOCK）。差し替えは、開いた後のfstatで見つける。Windowsでは上のlstatで拒む。
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
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

// 標準入力から鍵を読む。端末からは読まない。大きさと時間に上限を置く。
export type KeyStream = AsyncIterable<Buffer | string> & { readonly isTTY?: boolean; destroy?(): void };

export async function readKeyFromStream(stream: KeyStream, timeoutMs: number = STDIN_TIMEOUT_MS): Promise<string> {
  if (stream.isTTY === true) throw new TokenError('--key-stdin では、鍵を標準入力へパイプで渡す（端末からは読まない）。');
  const chunks: Buffer[] = [];
  let length = 0;
  const wipe = (): void => {
    for (const c of chunks) c.fill(0);
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TokenError(`標準入力の鍵を${timeoutMs / 1000}秒以内に読み終えなかった。`)), timeoutMs);
  });
  const read = (async (): Promise<string> => {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      chunks.push(buffer);
      if (length > MAX_KEY_BYTES) throw new TokenError(`標準入力の鍵が大きすぎる（${MAX_KEY_BYTES}バイトまで）。`);
    }
    const joined = Buffer.concat(chunks);
    const text = joined.toString('utf8');
    joined.fill(0);
    return text;
  })();
  try {
    return await Promise.race([read, timeout]);
  } catch (error) {
    stream.destroy?.();
    read.catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    wipe();
  }
}

// 子プロセスの環境。親の環境から、GitHubの資格情報と、gitの資格情報・SSH・設定に関わる変数を外し、
// Appのトークンだけを渡す。ghは空の設定ディレクトリを使い、保存済みのdoc-gifの資格情報に戻れない。
// gitは利用者・システムの設定（credential.helper=osxkeychain、url.*.insteadOf等）を読まず、SSHを使えず
// （GIT_SSH_COMMAND=false）、github.comへのHTTPSだけ、GH_TOKENを返すhelperで認証する。
const REMOVED_ENV = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|GH_CONFIG_DIR|GIT_CONFIG.*|GIT_ASKPASS|SSH_ASKPASS|GIT_SSH|GIT_SSH_COMMAND|GIT_TERMINAL_PROMPT|GCM_.*|KL_GITHUB_APP_.*)$/i;
export const GIT_CREDENTIAL_HELPER = '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

// 利用者の設定（~/.gitconfig）の代わりに読ませる、存在しないファイル（gitは、ない設定ファイルを空として扱う）。
// 空のデバイス（/dev/null、Windowsの\\.\nul）は、WindowsのgitがEINVALで読めないので使わない。
export const UNUSED_GIT_GLOBAL_CONFIG = 'git-global-config-unused';

export function childEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  token: string,
  configDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && !REMOVED_ENV.test(name)) env[name] = value;
  }
  return {
    ...env,
    GH_TOKEN: token,
    GH_CONFIG_DIR: configDir,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(configDir, UNUSED_GIT_GLOBAL_CONFIG),
    GIT_SSH_COMMAND: 'false',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: GIT_CREDENTIAL_HELPER,
  };
}

export type ChildResult =
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'failed'; readonly code: string };

// 子の結果を終了コードにする。シグナルは128+番号。起動できなければ126、見つからなければ127。
export function exitCodeOf(result: ChildResult): number {
  if (result.kind === 'failed') return result.code === 'ENOENT' ? EXIT_NOT_FOUND : EXIT_CANNOT_EXECUTE;
  if (result.code !== null) return result.code;
  const number = result.signal === null ? undefined : (osConstants.signals as Readonly<Record<string, number | undefined>>)[result.signal];
  return number === undefined ? EXIT_OWN_FAILURE : 128 + number;
}

// 子を実行する（シェルを通さない）。親が受けたSIGTERM・SIGHUPは子へ送る。SIGINT（端末のCtrl+C）は子も
// 受けるので、親は子の終了を待ってから失効させる。
export function spawnChild(
  command: readonly [string, ...string[]],
  env: Record<string, string>,
  stdin: 'inherit' | 'ignore',
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const [program, ...args] = command;
    const child = spawn(program, args, { env, stdio: [stdin, 'inherit', 'inherit'], shell: false, windowsHide: true });
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal);
    };
    const handlers: [NodeJS.Signals, () => void][] = [
      ['SIGINT', () => undefined],
      ['SIGTERM', forward('SIGTERM')],
      ['SIGHUP', forward('SIGHUP')],
    ];
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const done = (result: ChildResult): void => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(result);
    };
    child.once('error', (error) => {
      const code = (error as { code?: unknown }).code;
      done({ kind: 'failed', code: typeof code === 'string' ? code : 'unknown' });
    });
    child.once('exit', (code, signal) => done({ kind: 'exited', code, signal }));
  });
}

export type Deps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly uid: number | undefined;
  // キーチェーンを使うときだけ呼ぶ（os.userInfo()。環境変数USERではない）。
  username(): string;
  nowSeconds(): number;
  readonly fetch: FetchLike;
  readKeychain(service: string, account: string): Promise<string>;
  readKeyFile(path: string): KeyFileResult;
  readStdin(): Promise<string>;
  makeConfigDir(): string;
  removeConfigDir(path: string): void;
  runChild(command: readonly [string, ...string[]], env: Record<string, string>, stdin: 'inherit' | 'ignore'): Promise<ChildResult>;
  stderr(text: string): void;
  readonly timeoutMs?: number;
};

// トークンを発行し、範囲を確かめる。確かめられなければTokenErrorを投げる（トークンは失効させてある）。
export async function mintToken(options: Options, deps: Deps, secrets: string[]): Promise<string> {
  let material: string;
  if (options.key.kind === 'keychain') {
    material = await deps.readKeychain(options.key.service, deps.username());
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
  return requestInstallationToken({
    fetch: deps.fetch,
    installationId: options.installationId,
    jwt,
    purpose: options.purpose,
    timeoutMs: deps.timeoutMs ?? REQUEST_TIMEOUT_MS,
    secrets,
  });
}

// 終了コード: 子の終了コード（シグナルは128+番号、起動できない126、見つからない127）。
// このスクリプト自身の失敗（引数の誤り・発行の失敗）は125で、子を起動しない。
export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  let parsed: ParseResult;
  try {
    parsed = parseArgs(argv, deps.env);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`${error.message}\n\n${USAGE}`);
      return EXIT_OWN_FAILURE;
    }
    throw error;
  }
  if (parsed.help) {
    deps.stderr(USAGE);
    return 0;
  }
  const { options } = parsed;
  const secrets: string[] = [];
  let token: string;
  try {
    token = await mintToken(options, deps, secrets);
  } catch (error) {
    if (error instanceof TokenError) {
      deps.stderr(`トークンを発行できなかった。コマンドは実行していない: ${sanitize(error.message, secrets)}\n`);
    } else {
      deps.stderr(`トークンを発行できなかった。コマンドは実行していない: 予期しないエラー（${describeFailure(error)}）。\n`);
    }
    return EXIT_OWN_FAILURE;
  }
  secrets.push(token);
  let configDir: string | undefined;
  let result: ChildResult;
  try {
    configDir = deps.makeConfigDir();
    const env = childEnvironment(deps.env, token, configDir);
    result = await deps.runChild(options.command, env, options.key.kind === 'stdin' ? 'ignore' : 'inherit');
  } catch (error) {
    result = { kind: 'failed', code: 'internal' };
    deps.stderr(`コマンドを実行できなかった（${describeFailure(error)}）。\n`);
  } finally {
    if (configDir !== undefined) {
      try {
        deps.removeConfigDir(configDir);
      } catch (error) {
        deps.stderr(`注意: ghの一時の設定ディレクトリを消せなかった（${describeFailure(error)}）。\n`);
      }
    }
  }
  if (result.kind === 'failed' && result.code !== 'internal') {
    deps.stderr(`コマンドを実行できなかった（${sanitize(result.code, secrets)}）。\n`);
  }
  const revokeProblem = await revokeToken(deps.fetch, token, deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  if (revokeProblem !== null) deps.stderr(`注意: ${revokeProblem}\n`);
  return exitCodeOf(result);
}
