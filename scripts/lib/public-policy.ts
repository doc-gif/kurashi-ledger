// 公開検査の規則（docs/public-data.md）。.gitignoreと同じ置き場所の規則を、
// `git add -f`で追加されたファイルにも適用し、テキストの中身から秘密情報らしい文字列を探す。
// 検出は追加の防御で、保証ではない。見つけた文字列そのものは結果に含めない。

import { SETUP_LOCK_NAME } from './install-record.ts';

// リポジトリ直下にだけ置かせない、実データ・出力・バックアップ用のディレクトリ。
export const ROOT_PRIVATE_DIRS: readonly string[] = [
  'data',
  'private',
  'local-data',
  'evidence',
  'exports',
  'backups',
];

// どの階層でも公開しない拡張子（大文字小文字を区別しない）。実データ（給与明細・通知書の画像やスキャン、
// 銀行・カードの明細の書き出し、表計算、メール、バックアップ）になりうるが、ソース・文書・設定には要らない
// 形式を、種類ごとに並べる。json・md・svg・ts・txt・xml等は、ソースと文書に要るので除外しない
// （中身の検査だけを当てる。docs/public-data.md）。変更するときは、.gitignore・docs/public-data.md・
// 試験の見本を同じPRで直す。
const BLOCKED_EXTENSION_GROUPS: readonly { readonly label: string; readonly extensions: readonly string[] }[] = [
  { label: '文書', extensions: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'pages'] },
  {
    label: '画像',
    extensions: ['png', 'jpg', 'jpeg', 'jfif', 'heic', 'heif', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'avif', 'dng'],
  },
  { label: '表計算・表形式', extensions: ['csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'numbers'] },
  { label: '金融機関の明細の書き出し', extensions: ['ofx', 'qfx', 'qif', 'qbo'] },
  { label: 'メールの書き出し', extensions: ['eml', 'msg', 'mbox'] },
  { label: 'アーカイブ・圧縮', extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'] },
  { label: 'ログ', extensions: ['log'] },
  { label: '鍵・証明書', extensions: ['pem', 'key', 'p12', 'pfx'] },
  { label: '暗号化したバックアップ', extensions: ['age'] },
];

// 名前は小文字にしてから比べる。DBは付随するファイル（-wal、-journal等）も含める。
const BLOCKED_EXTENSIONS: readonly { readonly key: string; readonly pattern: RegExp }[] = [
  ...BLOCKED_EXTENSION_GROUPS.flatMap((group) =>
    group.extensions.map((key) => ({ key, pattern: new RegExp(`\\.${key}$`) })),
  ),
  { key: 'db', pattern: /\.db(?:-[^/]*)?$/ },
  { key: 'sqlite', pattern: /\.sqlite[^/]*$/ },
];

/** 除外する拡張子の一覧（文書と試験の見本のため）。DBの付随ファイルの形は含めない。 */
export const BLOCKED_EXTENSION_KEYS: readonly string[] = BLOCKED_EXTENSIONS.map((e) => e.key);

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
// - 実データ用のディレクトリと作業中の印は、リポジトリ直下の名前だけ（/data/、/.kurashi-ledger-setup.lock 等）。
//   ディレクトリの項目（submoduleのgitlink等）は、その項目自身も対象にする。
// - .envや拡張子の規則は、.gitignoreのスラッシュを含まないパターンと同じく、
//   どの階層の名前にも（ファイルにもディレクトリにも）当てる。
// - 名前による例外（.env.example、合成データの場所の拡張子）は、1つの規則に従う: 通常のファイルの
//   最後の名前にだけ当て、途中のディレクトリやディレクトリの項目には当てない。.gitignoreでは、例外の行の
//   あとに、同じ名前のディレクトリだけを除外し直す行（末尾の/）を置く。
// - 大文字小文字は、実データになりうる名前（ディレクトリ・拡張子・.env）では区別せず、例外の場所の
//   名前（tests/fixtures/、design/）と作業中の印では区別する。守る名前はすべてASCIIなので、
//   Unicodeの正規化（NFC・NFD）の違いは生じない。見た目の似た別の文字は別の名前で、例外を受けない。
export function pathFindings(path: string, kind: EntryKind = 'file'): string[] {
  const findings = new Set<string>();
  const segments = path.split('/').filter((s) => s !== '');
  const lower = segments.map((s) => s.toLowerCase());
  const directoryCount = kind === 'directory' ? segments.length : segments.length - 1;
  const first = lower[0];
  if (directoryCount > 0 && first !== undefined && ROOT_PRIVATE_DIRS.includes(first)) {
    findings.add('実データ・出力・バックアップ用のディレクトリ');
  }
  // npm run setupの作業中の印（ADR-0008）。commitすると、ほかのcloneのsetupが止まる。
  if (segments[0] === SETUP_LOCK_NAME) findings.add('npm run setupの作業中の印');
  lower.forEach((name, i) => {
    // 例外を受けられるのは、通常のファイルの最後の名前だけ。
    const isFinalFile = kind === 'file' && i === segments.length - 1;
    if ((name === '.env' || name.startsWith('.env.')) && !(isFinalFile && name === '.env.example')) {
      findings.add('環境変数ファイル');
    }
    const ext = BLOCKED_EXTENSIONS.find((e) => e.pattern.test(name));
    if (ext !== undefined) {
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

// indexの項目の種類（mode）ごとに規則を当てる。contentは、通常のファイルとsymlinkではblobの中身
// （symlinkならリンク先のパスの文字列）、gitlinkではundefined。
// - 100644・100755（通常のファイル。実行可能かどうかは問わない）: 置き場所の規則と中身の検査。
//   合成データの場所の例外を受けるのは、この種類だけ。
// - 120000（symlink）: 場所・拡張子・リンク先によらず止める。.gitignoreでは区別できないので、
//   公開検査だけが止める。リンクをたどる処理（試験等）がcheckoutの中の非公開のファイルを読む
//   経路になり、Windowsでは設定によって通常のファイルとして取り出されるため。
// - 160000（gitlink、submodule）: 中身はこのrepoにないので、ディレクトリとして置き場所の規則だけを当てる。
// - それ以外: 知らない種類として止める。
export function inspectIndexEntry(mode: string, path: string, content: Uint8Array | undefined): string[] {
  switch (mode) {
    case '100644':
    case '100755':
      if (content === undefined) throw new Error('通常のファイルの中身がない');
      return inspectPublicFile(path, content);
    case '120000': {
      const findings = ['シンボリックリンク（場所・拡張子によらず公開しない）'];
      if (content !== undefined) findings.push(...textFindings(Buffer.from(content).toString('utf8')));
      return findings;
    }
    case '160000':
      return pathFindings(path, 'directory');
    default:
      return [`種類の分からないindexの項目（mode ${mode}）`];
  }
}
