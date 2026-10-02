// 公開検査の規則の試験。秘密情報は合成したものだけを使い、このファイル自身が
// 検査に当たらないよう、試験の中で文字列を組み立てる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { inspectPublicFile, pathFindings, textFindings } from './lib/public-policy.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const text = (s: string) => new TextEncoder().encode(s);

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

test('.gitignoreと公開検査の置き場所の規則が一致する', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kl-gitignore-'));
  try {
    // 利用者のGit設定（グローバルの除外ファイル等）の影響を受けない一時repoで確かめる。
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'empty-gitconfig') };
    writeFileSync(join(dir, 'empty-gitconfig'), '');
    assert.equal(spawnSync('git', ['init', '-q', join(dir, 'repo')], { env }).status, 0);
    copyFileSync(join(repoRoot, '.gitignore'), join(dir, 'repo', '.gitignore'));
    const paths = [...BLOCKED_PATHS, ...ALLOWED_PATHS];
    const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
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
