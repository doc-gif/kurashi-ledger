// 公開検査の規則（docs/public-data.md）。.gitignoreと同じ置き場所の規則を、
// `git add -f`で追加されたファイルにも適用し、テキストの中身から秘密情報らしい文字列を探す。
// 検出は追加の防御で、保証ではない。見つけた文字列そのものは結果に含めない。

// リポジトリ直下にだけ置かせない、実データ・出力・バックアップ用のディレクトリ。
export const ROOT_PRIVATE_DIRS: readonly string[] = [
  'data',
  'private',
  'local-data',
  'evidence',
  'exports',
  'backups',
];

// どの階層でも公開しない拡張子。名前は小文字で比べる。
const BLOCKED_EXTENSIONS: readonly { readonly key: string; readonly pattern: RegExp }[] = [
  { key: 'pdf', pattern: /\.pdf$/i },
  { key: 'png', pattern: /\.png$/i },
  { key: 'jpg', pattern: /\.jpg$/i },
  { key: 'jpeg', pattern: /\.jpeg$/i },
  { key: 'heic', pattern: /\.heic$/i },
  { key: 'csv', pattern: /\.csv$/i },
  { key: 'xlsx', pattern: /\.xlsx$/i },
  { key: 'zip', pattern: /\.zip$/i },
  { key: 'log', pattern: /\.log$/i },
  { key: 'pem', pattern: /\.pem$/i },
  { key: 'key', pattern: /\.key$/i },
  { key: 'age', pattern: /\.age$/i },
  { key: 'db', pattern: /\.db(?:-[^/]*)?$/i },
  { key: 'sqlite', pattern: /\.sqlite[^/]*$/i },
];

// 合成データ・デザイン資産だけを置く場所（リポジトリ直下からのディレクトリ）と、そこで許す拡張子。
// 例外は、この場所の下にある通常のファイルの、最後の名前の拡張子にだけ当てる（.gitignoreと同じ）。
// 変更するときは、.gitignoreの例外・docs/public-data.md・試験の見本を同じPRで直す。
export const SYNTHETIC_LOCATIONS: readonly {
  readonly prefix: string;
  readonly extensions: readonly string[];
}[] = [
  { prefix: 'tests/fixtures/', extensions: ['csv', 'pdf', 'png', 'jpg', 'jpeg'] },
  { prefix: 'design/', extensions: ['png', 'jpg', 'jpeg'] },
];

export type EntryKind = 'file' | 'directory';

// 場所のパス（'tests/fixtures/'）の名前の並びが、パスの先頭の名前の並びと一致するか（大文字小文字を区別する）。
function underLocation(segments: readonly string[], prefix: string): boolean {
  const location = prefix.split('/').filter((s) => s !== '');
  return segments.length > location.length && location.every((name, i) => segments[i] === name);
}

// .gitignoreと同じ置き場所の規則を、パスの区切り（/）ごとの名前に当てる。
// - 実データ用のディレクトリは、リポジトリ直下の名前だけ（/data/ 等）。ディレクトリの項目
//   （submoduleのgitlink等）は、その項目自身も対象にする。
// - .envや拡張子の規則は、.gitignoreのスラッシュを含まないパターンと同じく、
//   どの階層の名前にも（ファイルにもディレクトリにも）当てる。
// - 合成データの場所の例外は、その場所の下の通常のファイルの最後の名前にだけ当てる。
//   途中のディレクトリやディレクトリの項目は、拡張子のような名前でも例外にしない。
export function pathFindings(path: string, kind: EntryKind = 'file'): string[] {
  const findings = new Set<string>();
  const segments = path.split('/').filter((s) => s !== '');
  const lower = segments.map((s) => s.toLowerCase());
  const directoryCount = kind === 'directory' ? segments.length : segments.length - 1;
  const first = lower[0];
  if (directoryCount > 0 && first !== undefined && ROOT_PRIVATE_DIRS.includes(first)) {
    findings.add('実データ・出力・バックアップ用のディレクトリ');
  }
  lower.forEach((name, i) => {
    if ((name === '.env' || name.startsWith('.env.')) && name !== '.env.example') {
      findings.add('環境変数ファイル');
    }
    const ext = BLOCKED_EXTENSIONS.find((e) => e.pattern.test(name));
    if (ext !== undefined) {
      const isFinalFile = kind === 'file' && i === segments.length - 1;
      const allowed =
        isFinalFile &&
        SYNTHETIC_LOCATIONS.some((loc) => underLocation(segments, loc.prefix) && loc.extensions.includes(ext.key));
      if (!allowed) findings.add(`公開しない種類のファイル（${ext.key}）`);
    }
  });
  return [...findings];
}

const SECRET_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: '秘密鍵', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { label: 'ageの秘密鍵', pattern: /AGE-SECRET-KEY-1[0-9A-Z]{20,}/ },
  { label: 'GitHubのトークン', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { label: 'AWSのアクセスキー', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'APIキー', pattern: /\bsk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}/ },
  { label: 'APIキー', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'Slackのトークン', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'npmのトークン', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
];

// 個人の名前を含みうる絶対パス。`~`や`<user>`、`%USERPROFILE%`等の書き方は対象外。
const NAME_CHARS = String.raw`[^\s/\\'"\x60<>%$\{\}()*|;,:]+`;
const POSIX_HOME = new RegExp(String.raw`(?<![A-Za-z0-9_.~-])/(?:Users|home)/(${NAME_CHARS})`, 'g');
const WINDOWS_HOME = new RegExp(String.raw`\b[A-Za-z]:[\\/]+Users[\\/]+(${NAME_CHARS})`, 'gi');
const SHARED_HOME_NAMES: readonly string[] = ['shared', 'public', 'default', 'runner'];

// 例示用に予約されたドメイン等。追加はレビューを経て行う。
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const ALLOWED_EMAIL_DOMAINS: readonly string[] = ['example.com', 'example.net', 'example.org', 'users.noreply.github.com'];
const ALLOWED_EMAIL_TLDS: readonly string[] = ['example', 'test', 'invalid', 'localhost'];

function hasPersonalPath(text: string): boolean {
  for (const re of [POSIX_HOME, WINDOWS_HOME]) {
    for (const match of text.matchAll(re)) {
      const name = (match[1] ?? '').toLowerCase();
      if (!SHARED_HOME_NAMES.includes(name)) return true;
    }
  }
  return false;
}

function hasEmail(text: string): boolean {
  for (const match of text.matchAll(EMAIL)) {
    const address = match[0].toLowerCase();
    const domain = (match[1] ?? '').toLowerCase();
    if (address === 'git@github.com') continue; // SSHのリモートURLの書き方
    if (ALLOWED_EMAIL_DOMAINS.includes(domain)) continue;
    if (ALLOWED_EMAIL_TLDS.includes(domain.slice(domain.lastIndexOf('.') + 1))) continue;
    return true;
  }
  return false;
}

export function textFindings(text: string): string[] {
  const findings = new Set<string>();
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) findings.add(label);
  }
  if (hasPersonalPath(text)) findings.add('個人の名前を含みうる絶対パス');
  if (hasEmail(text)) findings.add('メールアドレス');
  return [...findings];
}

// 先頭8000バイトにNULがあればバイナリとみなし、中身は検査しない（docs/public-data.mdの手動の点検で扱う）。
export function isBinary(content: Uint8Array): boolean {
  return content.subarray(0, 8000).includes(0);
}

export function inspectPublicFile(path: string, content: Uint8Array): string[] {
  const findings = pathFindings(path);
  if (!isBinary(content)) findings.push(...textFindings(Buffer.from(content).toString('utf8')));
  return findings;
}
