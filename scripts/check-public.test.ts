// `npm run check:public` を一時のGitリポジトリで試す。ファイルはすべて合成。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kl-check-public-'));
  dirs.push(dir);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'gitconfig') };
  delete env['CI'];
  writeFileSync(join(dir, 'gitconfig'), '');
  const repo = join(dir, 'repo');
  assert.equal(spawnSync('git', ['init', '-q', repo], { env }).status, 0);
  copyFileSync(join(repoRoot, '.gitignore'), join(repo, '.gitignore'));
  const write = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  // indexにsymlink（mode 120000）を直接置く。中身はリンク先のパスの文字列。ファイルシステムの
  // symlinkを作らないので、権限の要るWindowsでも同じように試せる。
  const stageSymlink = (path: string, target: string) => {
    const r = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, env, input: target, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    git('update-index', '--add', '--cacheinfo', `120000,${r.stdout.trim()},${path}`);
  };
  const check = (args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [join(repoRoot, 'scripts', 'check-public.ts'), ...args], {
      cwd: repo,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
    });
  const gitStatus = (...args: string[]) => spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' }).status;
  return { write, git, check, stageSymlink, gitStatus };
}

test('許可したソースと合成データだけなら通る', () => {
  const { write, git, check } = makeRepo();
  write('src/domain/evidence/evidence-ref.ts', 'export type EvidenceRef = { readonly id: string };\n');
  write('tests/fixtures/payroll.csv', 'employer,month,gross_yen\nemployer-a,2026-04,unknown\n');
  write('design/components/button.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
  write('.env.example', 'KURASHI_LEDGER_HOME=\n');
  git('add', '.');
  const r = check(['--staged']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /保証ではない/);
});

test('.env.exampleという名前のディレクトリの中のファイルは、git add -fで加えても止める。通常のファイルの.env.exampleは通る', () => {
  const { write, git, check } = makeRepo();
  write('.env.example', 'KURASHI_LEDGER_HOME=\n');
  write('config/.env.example', 'KURASHI_LEDGER_HOME=\n');
  write('docs/.env.example/credentials.txt', 'synthetic\n');
  git('add', '.env.example', 'config/.env.example');
  assert.equal(check(['--staged']).status, 0);
  git('add', '-f', 'docs/.env.example/credentials.txt');
  const r = check(['--staged']);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes('公開しない: docs/.env.example/credentials.txt:'), r.stderr);
  assert.ok(!r.stderr.includes('公開しない: .env.example:'), r.stderr);
  assert.ok(!r.stderr.includes('公開しない: config/.env.example:'), r.stderr);
});

test('git add -fで加えた禁止の種類・場所のファイルと、合成の秘密情報を止める', () => {
  const { write, git, check } = makeRepo();
  const secret = 'gh' + 'p_' + 'Z9y8'.repeat(9);
  write('docs/notes.md', `token: ${secret}\n`);
  write('exports/records.json', '{}\n');
  write('notes/statement.pdf', '%PDF-1.7 synthetic\n');
  write('backup.tar.age', 'age-encryption.org/v1 synthetic\n');
  git('add', 'docs/notes.md');
  git('add', '-f', 'exports/records.json', 'notes/statement.pdf', 'backup.tar.age');
  const r = check(['--staged']);
  assert.equal(r.status, 1);
  for (const path of ['docs/notes.md', 'exports/records.json', 'notes/statement.pdf', 'backup.tar.age']) {
    assert.ok(r.stderr.includes(path), path);
  }
  assert.ok(!r.stderr.includes(secret) && !r.stdout.includes(secret), '秘密情報そのものを表示しない');
  // 追跡中の全ファイルを見る既定の方法でも止まる。
  assert.equal(check().status, 1);
});

test('CIではファイル名を出さない', () => {
  const { write, git, check } = makeRepo();
  write('notes/payslip-sample.pdf', '%PDF-1.7 synthetic\n');
  git('add', '-f', 'notes/payslip-sample.pdf');
  for (const r of [check(['--staged'], { CI: 'true' }), check(['--staged', '--redact-paths'])]) {
    assert.equal(r.status, 1);
    assert.ok(!r.stderr.includes('payslip-sample'), r.stderr);
    assert.match(r.stderr, /項目1/);
  }
});

test('--stagedはcommit済みで変更のないファイルを対象にしない', () => {
  const { write, git, check } = makeRepo();
  write('README.md', 'synthetic\n');
  git('add', 'README.md');
  git('-c', 'user.name=synthetic', '-c', 'user.email=synthetic@example.com', 'commit', '-q', '-m', 'init');
  write('docs/a.md', 'ok\n');
  git('add', 'docs/a.md');
  const r = check(['--staged']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /commitしようとしている1件/);
});

test('git add -fで禁止の場所に加えたsubmodule（gitlink）も、ディレクトリとして置き場所の規則で止める（リポジトリ直下の禁止の名前そのものを含む）', () => {
  const { write, git, check } = makeRepo();
  write('README.md', 'synthetic\n');
  git('add', 'README.md');
  // 実際のsubmoduleの中身は要らない。indexにgitlink（mode 160000）を直接置く。
  const commit = '0123456789abcdef0123456789abcdef01234567';
  git('update-index', '--add', '--cacheinfo', `160000,${commit},private/vendor`);
  git('update-index', '--add', '--cacheinfo', `160000,${commit},exports/archive`);
  git('update-index', '--add', '--cacheinfo', `160000,${commit},data`);
  git('update-index', '--add', '--cacheinfo', `160000,${commit},backups`);
  git('update-index', '--add', '--cacheinfo', `160000,${commit},docs/statements.pdf`);
  // 合成データの場所の中でも、拡張子のような名前のgitlinkは例外にしない。
  git('update-index', '--add', '--cacheinfo', `160000,${commit},tests/fixtures/evidence.pdf`);
  // .env.exampleという名前のgitlink（ディレクトリ）も、ファイル向けの例外を受けない。
  git('update-index', '--add', '--cacheinfo', `160000,${commit},deep/dir/.env.example`);
  git('update-index', '--add', '--cacheinfo', `160000,${commit},vendor/allowed`);
  const r = check(['--staged']);
  assert.equal(r.status, 1, r.stdout);
  for (const path of ['private/vendor', 'exports/archive', 'data', 'backups', 'docs/statements.pdf', 'tests/fixtures/evidence.pdf', 'deep/dir/.env.example']) {
    assert.ok(r.stderr.includes(`公開しない: ${path}:`), `${path}\n${r.stderr}`);
  }
  assert.ok(!r.stderr.includes('vendor/allowed'), r.stderr);
  assert.match(r.stderr, /9件のうち7件/); // README.mdと許可の場所のgitlinkは当たらない
  assert.equal(check().status, 1);
});

test('symlink（mode 120000）は、合成データの場所や許可した拡張子でも止める。通常のファイルと実行可能なファイルは今までどおり', () => {
  const { write, git, check, stageSymlink, gitStatus } = makeRepo();
  write('tests/fixtures/records.csv', 'employer,month,gross_yen\nemployer-a,2026-04,unknown\n');
  write('tests/fixtures/scan.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]));
  write('scripts/tool.sh', '#!/bin/sh\necho synthetic\n');
  write('tests/fixtures/executable.csv', 'a,b\n1,2\n');
  git('add', 'tests/fixtures/records.csv', 'tests/fixtures/scan.png', 'scripts/tool.sh', 'tests/fixtures/executable.csv');
  git('update-index', '--chmod=+x', 'scripts/tool.sh', 'tests/fixtures/executable.csv');
  // 通常のファイル（100644）と実行可能なファイル（100755）だけなら通る。
  const clean = check(['--staged']);
  assert.equal(clean.status, 0, clean.stderr);

  // 合成データの場所の中から、禁止の場所を指す相対のリンク（合成の名前）。
  stageSymlink('tests/fixtures/leak.csv', '../../private/records.csv');
  // 合成データの場所の中で、同じ場所の許可されたファイルを指すリンク。
  stageSymlink('tests/fixtures/alias.csv', 'records.csv');
  // 許可された拡張子でない場所のリンク。
  stageSymlink('docs/notes-link.md', '../README.md');
  // ディレクトリを指すリンクも、indexでは同じmode 120000。
  stageSymlink('tests/fixtures/shared', '../../private');
  // リンクの先の階層のパス（途中の名前がリンク）は、Gitがindexに入れない（ファイルとディレクトリの衝突）。
  const blob = git('hash-object', '-w', '--stdin');
  assert.notEqual(gitStatus('update-index', '--add', '--cacheinfo', `100644,${blob},tests/fixtures/shared/records.csv`), 0);
  const r = check(['--staged']);
  assert.equal(r.status, 1, r.stdout);
  for (const path of ['tests/fixtures/leak.csv', 'tests/fixtures/alias.csv', 'docs/notes-link.md', 'tests/fixtures/shared']) {
    assert.match(r.stderr, new RegExp(`公開しない: ${path.replace(/\./g, '\\.')}: .*シンボリックリンク`), path);
  }
  for (const path of ['tests/fixtures/records.csv', 'tests/fixtures/scan.png', 'scripts/tool.sh', 'tests/fixtures/executable.csv']) {
    assert.ok(!r.stderr.includes(`公開しない: ${path}:`), `${path}\n${r.stderr}`);
  }
  assert.ok(!r.stderr.includes('private/records.csv'), 'リンク先のパスは表示しない');
  assert.equal(check().status, 1, '追跡中の全件の検査でも止まる');
});
