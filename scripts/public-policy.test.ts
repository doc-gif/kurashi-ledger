// 公開検査の規則の試験。秘密情報は合成したものだけを使い、このファイル自身が
// 検査に当たらないよう、試験の中で文字列を組み立てる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  BLOCKED_EXTENSION_KEYS,
  SYNTHETIC_LOCATIONS,
  inspectIndexEntry,
  inspectPublicFile,
  pathFindings,
  textFindings,
} from './lib/public-policy.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const text = (s: string) => new TextEncoder().encode(s);

// 除外する拡張子（実装とは別に、ここで書き出す）。実装・.gitignore・docs/public-data.mdと一致することを
// 下の試験で確かめる。例外の場所で許すのは、tests/fixtures/のcsv・pdf・png・jpg・jpegと、design/の
// png・jpg・jpegだけ。
const EXPECTED_BLOCKED_EXTENSIONS = [
  // 文書
  'pdf', 'doc', 'docx', 'odt', 'rtf', 'pages',
  // 画像（スマートフォンの写真、スキャン、スクリーンショット）
  'png', 'jpg', 'jpeg', 'jfif', 'heic', 'heif', 'webp', 'gif', 'tif', 'tiff', 'bmp', 'avif', 'dng',
  // 表計算・表形式
  'csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'numbers',
  // 金融機関の明細の書き出し
  'ofx', 'qfx', 'qif', 'qbo',
  // メールの書き出し
  'eml', 'msg', 'mbox',
  // アーカイブ・圧縮
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst',
  // ログ、鍵・証明書、暗号化したバックアップ、DB
  'log', 'pem', 'key', 'p12', 'pfx', 'age', 'db', 'sqlite',
];
const EXCEPTIONS: Record<string, readonly string[]> = {
  'tests/fixtures/': ['csv', 'pdf', 'png', 'jpg', 'jpeg'],
  'design/': ['png', 'jpg', 'jpeg'],
};

// 拡張子ごとの見本: 直下、深い階層、大文字、先頭だけ大文字、同じ名前のディレクトリ（中のファイルと、
// ディレクトリの項目そのもの）、例外の場所の中（許す種類以外は拒否、許す種類は大文字でも許す）。
function extensionSamples(): { blocked: string[]; allowed: string[] } {
  const blocked: string[] = [];
  const allowed: string[] = [];
  for (const ext of EXPECTED_BLOCKED_EXTENSIONS) {
    const upper = ext.toUpperCase();
    const capital = ext.charAt(0).toUpperCase() + ext.slice(1);
    blocked.push(
      `statement.${ext}`,
      `a/b/c/d/statement.${ext}`,
      `STATEMENT.${upper}`,
      `docs/Statement.${capital}`,
      `docs/scans.${ext}/readme.md`,
      `src/scans.${ext}/`,
    );
    for (const [location, permitted] of Object.entries(EXCEPTIONS)) {
      const inside = [`${location}sample.${ext}`, `${location}deep/er/SAMPLE.${upper}`];
      if (permitted.includes(ext)) allowed.push(...inside);
      else blocked.push(...inside);
      blocked.push(`${location}scans.${ext}/readme.md`, `${location}scans.${ext}/`);
    }
  }
  return { blocked, allowed };
}
const EXTENSION_SAMPLES = extensionSamples();

// .gitignoreと公開検査の両方で「公開しない」になる見本と、両方で許す見本。
// 末尾が / の見本はディレクトリ（submoduleのgitlink等）として扱う。
// 置き場所の規則を変えたら、ここに見本を足す（docs/public-data.md）。
const BLOCKED_PATHS = [
  'data/ledger.json',
  'private/note.md',
  'local-data/a.txt',
  'evidence/receipt.txt',
  'exports/records.json',
  'backups/state.json',
  'notes/payslip.pdf',
  'screenshot.png',
  'docs/photo.jpg',
  'docs/photo.jpeg',
  'IMG_0001.heic',
  'docs/records.csv',
  'sheet.xlsx',
  'archive.zip',
  'npm-debug.log',
  'cert.pem',
  'server.key',
  'backup.tar.age',
  'ledger.sqlite',
  'ledger.sqlite-wal',
  'ledger.db',
  'ledger.db-journal',
  '.env',
  '.env.local',
  'config/.env.production',
  'tests/fixtures/real.xlsx',
  'tests/fixtures/archive.age',
  'tests/fixtures/ledger.sqlite',
  'tests/fixtures/.env',
  'design/spec.pdf',
  'design/table.csv',
  'src/tests/fixtures/records.csv',
  'docs/design/button.png',
  'data/',
  'private/',
  'local-data/',
  'evidence/',
  'exports/',
  'backups/',
  'private/vendor/',
  'statements.pdf/readme.md',
  'docs/archive.zip/readme.md',
  '.env/config',
  'config/.env.local/',
  'ledger.sqlite-dir/',
  // 大文字小文字の違い（スマートフォンの写真やスキャンの拡張子は大文字のことが多い）
  'DATA/record.json',
  'Private/note.md',
  'BACKUPS/',
  'photo.PNG',
  'docs/Scan.JPG',
  'IMG_0001.HEIC',
  'statement.Pdf',
  'backup.tar.AGE',
  'ledger.SQLite',
  '.ENV',
  'config/.Env.Local',
  'Tests/Fixtures/records.csv',
  'Design/hero.png',
  // 例外の拡張子は、例外の場所の下の通常のファイルの最後の名前にだけ当たる。
  // 拡張子のような名前のディレクトリは、例外の場所の中でも外でも除外する。
  'tests/fixtures/evidence.pdf/records.json',
  'tests/fixtures/evidence.pdf/',
  'tests/fixtures/scans.png/page1.png',
  'tests/fixtures/nested/report.csv/notes.md',
  'tests/fixtures/archive.zip/records.csv',
  'tests/fixtures/backup.age/',
  'tests/fixtures/.env/records.csv',
  'design/mock.png/readme.md',
  'design/mock.png/',
  'design/sub/hero.jpg/x.png',
  'docs/report.pdf/notes.md',
  'tests/fixtures.pdf/records.csv',
  'tests/fixturesX/records.csv',
  'src/tests/fixtures/records.csv/',
  '.kurashi-ledger-setup.lock',
  // 名前の例外（.env.example）は通常のファイルの最後の名前にだけ当たる。同じ名前のディレクトリは
  // どの階層でも除外し、その中のファイルも除外する。setupの作業中の印の名前のディレクトリも同じ。
  'docs/.env.example/credentials.txt',
  '.env.example/notes.txt',
  '.env.example/',
  'config/.env.example/',
  'a/b/.env.example/c/settings.txt',
  '.ENV.EXAMPLE/notes.txt',
  'tests/fixtures/.env.example/records.csv',
  '.kurashi-ledger-setup.lock/',
  '.kurashi-ledger-setup.lock/notes.txt',
  ...EXTENSION_SAMPLES.blocked,
];
const ALLOWED_PATHS = [
  'src/domain/evidence/evidence-ref.ts',
  'src/application/exports/export-records.ts',
  'src/infrastructure/backups/archive.ts',
  'docs/data/README.md',
  'tests/fixtures/payroll.csv',
  'tests/fixtures/evidence/receipt.pdf',
  'tests/fixtures/evidence/receipt.png',
  'tests/fixtures/scan.jpg',
  'tests/fixtures/scan.jpeg',
  'design/components/button.png',
  'design/screens/top.jpg',
  'design/screens/top.jpeg',
  '.env.example',
  'package-lock.json',
  'scripts/check-public.ts',
  'data',
  'src/data/',
  'vendor/',
  'tests/fixtures/evidence/',
  'design/',
  'tests/fixtures/scan.PNG',
  'tests/fixtures/records.CSV',
  'design/hero.JPG',
  '.ENV.EXAMPLE',
  'src/Data/record.ts',
  'tests/fixtures/nested/deeper/receipt.pdf',
  'tests/fixtures/data/records.csv',
  'tests/fixtures/evidence/records.json',
  'design/screens/mobile/top.png',
  'design/screens/',
  'tests/fixtures/',
  'config/deep/.env.example',
  'tests/fixtures/.env.example',
  // ソース・文書・設定に要る形式は、拡張子では除外しない（中身の検査だけを当てる）。
  'docs/diagram.svg',
  'design/icons/check.svg',
  'design/tokens.json',
  'src/ui/App.tsx',
  'src/ui/styles.css',
  'index.html',
  'config/settings.yml',
  'docs/README.MD',
  'tests/fixtures/payroll.json',
  'tests/fixtures/notice.txt',
  'tests/fixtures/statement.xml',
  // 拡張子の文字列を名前の途中に含むだけのものは許す。
  'docs/gif-guide.md',
  'src/msg/format.ts',
  'src/infrastructure/backups/tar.ts',
  'scripts/key-rotation.md',
  ...EXTENSION_SAMPLES.allowed,
];

function kindOf(sample: string): ['file' | 'directory', string] {
  return sample.endsWith('/') ? ['directory', sample.slice(0, -1)] : ['file', sample];
}

test('実データ・出力・鍵・バックアップになりうる場所と種類を拒み、ソースと合成データの置き場所は許す', () => {
  for (const sample of BLOCKED_PATHS) {
    const [kind, path] = kindOf(sample);
    assert.notDeepEqual(pathFindings(path, kind), [], sample);
  }
  for (const sample of ALLOWED_PATHS) {
    const [kind, path] = kindOf(sample);
    assert.deepEqual(pathFindings(path, kind), [], sample);
  }
});

test('除外する拡張子の一覧は、試験・実装・例外の場所・docs/public-data.mdで一致する', () => {
  assert.deepEqual([...BLOCKED_EXTENSION_KEYS].sort(), [...EXPECTED_BLOCKED_EXTENSIONS].sort());
  assert.deepEqual(
    Object.fromEntries(SYNTHETIC_LOCATIONS.map((l) => [l.prefix, [...l.extensions].sort()])),
    Object.fromEntries(Object.entries(EXCEPTIONS).map(([k, v]) => [k, [...v].sort()])),
  );
  const doc = readFileSync(join(repoRoot, 'docs', 'public-data.md'), 'utf8');
  for (const ext of EXPECTED_BLOCKED_EXTENSIONS) assert.ok(doc.includes(`\`.${ext}\``), `docs/public-data.mdに .${ext} がない`);
});

test('.gitignoreと公開検査の置き場所の規則が一致する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kl-gitignore-'));
  try {
    // 利用者のGit設定（グローバルの除外ファイル等）の影響を受けない一時repoで確かめる。
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'empty-gitconfig') };
    writeFileSync(join(dir, 'empty-gitconfig'), '');
    assert.equal(spawnSync('git', ['init', '-q', join(dir, 'repo')], { env }).status, 0);
    copyFileSync(join(repoRoot, '.gitignore'), join(dir, 'repo', '.gitignore'));
    const paths = [...BLOCKED_PATHS, ...ALLOWED_PATHS];
    // LinuxのGitと同じく大文字小文字を区別する設定で比べる（MacやWindowsの既定では区別しないので、
    // 例外の場所の名前が大文字の場合だけ、公開検査の方が厳しくなる）。
    const r = spawnSync('git', ['-c', 'core.ignorecase=false', 'check-ignore', '--no-index', '--stdin', '-z'], {
      cwd: join(dir, 'repo'),
      env,
      input: `${paths.join('\0')}\0`,
      encoding: 'utf8',
    });
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    const ignored = new Set(r.stdout.split('\0').filter((s) => s !== ''));
    for (const path of BLOCKED_PATHS) assert.ok(ignored.has(path), `.gitignoreで除外されない: ${path}`);
    for (const path of ALLOWED_PATHS) assert.ok(!ignored.has(path), `.gitignoreで除外される: ${path}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合成の秘密情報を検出し、結果に秘密情報そのものを含めない', () => {
  const samples: [string, RegExp][] = [
    ['-----BEGIN ' + 'OPENSSH PRIVATE KEY-----', /秘密鍵/],
    ['-----BEGIN ' + 'PRIVATE KEY-----', /秘密鍵/],
    ['AGE-SECRET-' + 'KEY-1' + 'Q'.repeat(58), /ageの秘密鍵/],
    ['token=' + 'gh' + 'p_' + 'a1B2'.repeat(9), /GitHub/],
    ['github_' + 'pat_' + 'x1'.repeat(41), /GitHub/],
    ['AKIA' + 'Z'.repeat(16), /AWS/],
    ['sk-' + 'ant-' + 'k'.repeat(40), /APIキー/],
    ['xox' + 'b-' + '1234567890-abcdef', /Slack/],
    ['npm' + '_' + 'n'.repeat(36), /npm/],
  ];
  for (const [secret, label] of samples) {
    const findings = textFindings(`設定例: ${secret}\n`);
    assert.ok(findings.some((f) => label.test(f)), secret.slice(0, 12));
    assert.ok(findings.every((f) => !f.includes(secret)));
  }
});

test('個人の名前を含みうる絶対パスを検出し、書き方の例は許す', () => {
  const personal = [
    '/' + 'Users/' + 'taro/ledger',
    'C:' + '\\Users\\' + 'hanako\\AppData',
    '`/' + 'home/' + 'jiro/.npmrc`',
  ];
  for (const p of personal) assert.deepEqual(textFindings(`保存先: ${p}`), ['個人の名前を含みうる絶対パス'], p);
  const placeholders = [
    '~/Library/Application Support/KurashiLedger/',
    '%LOCALAPPDATA%\\KurashiLedger\\',
    '/' + 'Users/<user>/ledger',
    'C:' + '\\Users\\%USERNAME%\\',
    '/' + 'Users/Shared/',
    'https://example.com/home/page',
  ];
  for (const p of placeholders) assert.deepEqual(textFindings(`保存先: ${p}`), [], p);
});

test('メールアドレスを検出し、例示用のドメインとSSHのURLは許す', () => {
  assert.deepEqual(textFindings('連絡先: taro' + '@' + 'mail.co.jp'), ['メールアドレス']);
  for (const ok of [
    'user' + '@' + 'example.com',
    'a' + '@' + 'b.example',
    'ci' + '@' + 'host.test',
    '12345+name' + '@' + 'users.noreply.github.com',
    'git' + '@' + 'github.com:doc-gif/kurashi-ledger.git',
    'typescript@7.0.2',
    '@types/node@24.19.1',
  ]) {
    assert.deepEqual(textFindings(ok), [], ok);
  }
});

test('バイナリは中身を検査せず、置き場所の規則だけを適用する', () => {
  const secret = 'gh' + 'p_' + 'a1B2'.repeat(9);
  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, ...text(secret)]);
  assert.deepEqual(inspectPublicFile('design/components/button.png', binary), []);
  assert.notDeepEqual(inspectPublicFile('docs/button.png', binary), []);
  assert.notDeepEqual(inspectPublicFile('docs/notes.md', text(secret)), []);
});

test('indexの項目の種類（mode）ごとに規則を当てる', () => {
  const csv = text('a,b\n1,2\n');
  // 通常のファイルと実行可能なファイルは、合成データの場所の例外を受ける。
  assert.deepEqual(inspectIndexEntry('100644', 'tests/fixtures/records.csv', csv), []);
  assert.deepEqual(inspectIndexEntry('100755', 'tests/fixtures/records.csv', csv), []);
  assert.notDeepEqual(inspectIndexEntry('100755', 'docs/records.csv', csv), []);
  // symlinkは場所・拡張子・リンク先によらず止める。
  for (const [path, target] of [
    ['tests/fixtures/leak.csv', '../../private/records.csv'],
    ['tests/fixtures/alias.csv', 'records.csv'],
    ['design/hero.png', 'other.png'],
    ['docs/readme-link.md', '../README.md'],
  ] as const) {
    assert.ok(inspectIndexEntry('120000', path, text(target)).some((r) => r.includes('シンボリックリンク')), path);
  }
  // gitlinkはディレクトリとして置き場所の規則だけを当てる。
  assert.deepEqual(inspectIndexEntry('160000', 'vendor/tool', undefined), []);
  assert.notDeepEqual(inspectIndexEntry('160000', 'tests/fixtures/evidence.pdf', undefined), []);
  // 知らない種類は止める。
  assert.ok(inspectIndexEntry('100664', 'docs/a.md', text('ok')).some((r) => r.includes('種類')));
});
