// npm testのskipの照合（scripts/lib/test-skips.ts、T05）の試験。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  attributeSkips,
  compareSkips,
  parseSkipTable,
  parseSpecOutput,
  skipEnvironment,
  summaryProblems,
  testRoots,
} from './lib/test-skips.ts';

const repoRoot = join(import.meta.dirname, '..');

function summaryLines(s: { tests: number; pass: number; fail?: number; skipped: number; todo?: number }): string[] {
  return [
    `ℹ tests ${s.tests}`,
    'ℹ suites 0',
    `ℹ pass ${s.pass}`,
    `ℹ fail ${s.fail ?? 0}`,
    'ℹ cancelled 0',
    `ℹ skipped ${s.skipped}`,
    `ℹ todo ${s.todo ?? 0}`,
    'ℹ duration_ms 12.5',
  ];
}

test('specの出力から、要約・skipした試験と理由・diagnosticを読む（色の制御文字、入れ子、時間のない行を含む）', () => {
  const text = [
    '> kurashi-ledger@ test',
    '> node --test "scripts/**/*.test.ts"',
    '',
    '\u001b[32m✔ 通る試験 \u001b[90m(1.2ms)\u001b[39m\u001b[39m',
    '\u001b[90m﹣ 飛ばす試験 \u001b[90m(0.05ms)\u001b[39m # Windowsでは送れない\u001b[39m',
    '▶ 親',
    '  ﹣ 入れ子の試験 # rootでは再現できない',
    '✔ 親 (0.3ms)',
    'ℹ symlinkを作れないので弱めて確かめた',
    '試験が標準出力へ書いた行',
    ...summaryLines({ tests: 4, pass: 2, skipped: 2 }),
    '',
  ].join('\r\n');
  const report = parseSpecOutput(text);
  assert.deepEqual(report.summary, { tests: 4, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 2, todo: 0 });
  assert.deepEqual(report.skipped, [
    { name: '飛ばす試験', reason: 'Windowsでは送れない' },
    { name: '入れ子の試験', reason: 'rootでは再現できない' },
  ]);
  assert.deepEqual(report.diagnostics, ['symlinkを作れないので弱めて確かめた']);
});

test('要約が最後にない・欠けている・「﹣」の行の数が要約と合わないときは、読めないとして失敗にする', () => {
  assert.throws(() => parseSpecOutput('✔ 通る試験 (1ms)\n'), /要約/);
  const broken = summaryLines({ tests: 1, pass: 1, skipped: 0 }).filter((l) => !l.startsWith('ℹ todo'));
  assert.throws(() => parseSpecOutput(broken.join('\n')), /要約/);
  assert.throws(
    () => parseSpecOutput(['﹣ 飛ばす試験 # 理由', ...summaryLines({ tests: 1, pass: 0, skipped: 0 })].join('\n')),
    /合わない/,
  );
  // 要約より前のdiagnosticに「ℹ tests」等があっても、最後の並びを要約として読む。
  const report = parseSpecOutput(
    ['ℹ tests 99', ...summaryLines({ tests: 1, pass: 1, skipped: 0 })].join('\n'),
  );
  assert.equal(report.summary.tests, 1);
  assert.deepEqual(report.diagnostics, ['tests 99']);
});

test('このNode.jsの実際のnode --testの出力を読める（npm testと同じ既定の出力形式）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kl-skips-'));
  try {
    writeFileSync(
      join(dir, 'sample.test.mjs'),
      [
        "import { test } from 'node:test';",
        "test('通る試験', (t) => { t.diagnostic('合成のdiagnostic'); });",
        "test('飛ばす試験', { skip: '合成の理由' }, () => {});",
        "test('親', async (t) => { await t.test('入れ子の飛ばす試験', { skip: '入れ子の理由' }, () => {}); });",
      ].join('\n'),
    );
    // 試験の実行中に受け継ぐNODE_TEST_CONTEXT等を外し、npm testと同じく端末でない出力先へ書かせる。
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!/^NODE_/i.test(key)) env[key] = value;
    const r = spawnSync(process.execPath, ['--test', 'sample.test.mjs'], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const report = parseSpecOutput(r.stdout);
    assert.equal(report.summary.tests, 4);
    assert.equal(report.summary.skipped, 2);
    assert.deepEqual(report.skipped, [
      { name: '飛ばす試験', reason: '合成の理由' },
      { name: '入れ子の飛ばす試験', reason: '入れ子の理由' },
    ]);
    assert.deepEqual(report.diagnostics, ['合成のdiagnostic']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE_DOC = [
  '## 開発',
  '',
  '### 環境によって飛ばす試験',
  '',
  '| 環境 | 飛ばす試験（件数） | 理由 | 代わりの確認（T05） |',
  '| --- | --- | --- | --- |',
  '| Windows | `scripts/a.test.ts`の実際のシグナルの3件（`SIGINT`、`SIGTERM`）、`scripts/b.test.ts`の1件 | 理由 | 確認 |',
  '| Windows | `scripts/c.test.ts`の、印を消せないときの1件 | 理由 | 確認 |',
  '| macOS・Linuxのroot | `scripts/c.test.ts`の、印を消せないときの1件 | 理由 | 確認 |',
  '',
  '件数は、macOS・Linuxの一般のユーザーで0件、Windowsで5件、macOS・Linuxのrootで1件になる。',
  '',
  '## 次の節',
  '',
  '件数は、macOS・Linuxの一般のユーザーで9件、Windowsで9件、macOS・Linuxのrootで9件になる。',
].join('\n');

test('表と件数の文を読み、環境ごと・ファイルごとの件数を返す', () => {
  const table = parseSkipTable(SAMPLE_DOC);
  assert.deepEqual(table.stated, { 'posix-user': 0, windows: 5, 'posix-root': 1 });
  assert.deepEqual(
    [...(table.byEnvironment.get('windows') ?? [])],
    [
      ['scripts/a.test.ts', 3],
      ['scripts/b.test.ts', 1],
      ['scripts/c.test.ts', 1],
    ],
  );
  assert.deepEqual([...(table.byEnvironment.get('posix-root') ?? [])], [['scripts/c.test.ts', 1]]);
  assert.equal(table.byEnvironment.get('posix-user'), undefined);
});

test('表と件数の文が食い違う・知らない環境・読めない行・節がないときは失敗にする', () => {
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace('Windowsで5件', 'Windowsで4件')), /食い違う/);
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace('| macOS・Linuxのroot |', '| FreeBSD |')), /FreeBSD/);
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace('`scripts/b.test.ts`の1件', '`scripts/b.test.ts`の1つ')), /食い違う/);
  assert.throws(
    () => parseSkipTable(SAMPLE_DOC.replace('`scripts/c.test.ts`の、印を消せないときの1件 | 理由 | 確認 |\n| macOS', '印を消せないとき | 理由 | 確認 |\n| macOS')),
    /読めない/,
  );
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace('### 環境によって飛ばす試験', '### 別の節')), /節がない/);
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace(/件数は、macOS・Linuxの一般のユーザーで0件[^\n]*\n/, '')), /文を読めない/);
});

test('docs/development.mdの実際の表を読め、表のファイルがあり、そのファイルにskipの指定がある', () => {
  const table = parseSkipTable(readFileSync(join(repoRoot, 'docs', 'development.md'), 'utf8'));
  const files = new Set([...table.byEnvironment.values()].flatMap((m) => [...m.keys()]));
  assert.ok(files.size > 0);
  for (const file of files) {
    const path = join(repoRoot, ...file.split('/'));
    assert.ok(existsSync(path), `表のファイルがない: ${file}`);
    assert.match(readFileSync(path, 'utf8'), /\{ skip: /, `表のファイルにskipの指定がない: ${file}`);
  }
});

test('package.jsonのtestのscriptから試験の場所を読み、形の違う対象は拒む', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.ok(testRoots(pkg.scripts['test'] ?? '').includes('scripts'));
  assert.deepEqual(testRoots('node --test "scripts/**/*.test.ts" "src/a/**/*.test.ts"'), ['scripts', 'src/a']);
  assert.throws(() => testRoots('node --test "scripts/*.test.ts"'), /形でない/);
  assert.throws(() => testRoots('vitest run'), /読めない/);
});

test('skipした試験を名前でファイルに結び付け、見つからない・複数にあるときは問題にする', () => {
  const sources = new Map([
    ['scripts/a.test.ts', "test('一意の試験', { skip: 'x' }, () => {});\ntest('同じ名前', () => {});"],
    ['scripts/b.test.ts', 'test("同じ名前", () => {});'],
  ]);
  const ok = attributeSkips([{ name: '一意の試験', reason: 'x' }], sources);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual([...ok.byFile.keys()], ['scripts/a.test.ts']);
  const bad = attributeSkips([{ name: 'ない試験', reason: '' }, { name: '同じ名前', reason: '' }], sources);
  assert.equal(bad.problems.length, 2);
  assert.match(bad.problems[0] ?? '', /見つけられない/);
  assert.match(bad.problems[1] ?? '', /複数/);
});

test('ファイルごとの件数が表と違えば、多い・少ない・表にないファイルを問題にする', () => {
  const skip = { name: 'n', reason: 'r' };
  assert.deepEqual(compareSkips(new Map([['a', 1]]), new Map([['a', [skip]]])), []);
  assert.deepEqual(compareSkips(new Map(), new Map()), []);
  assert.equal(compareSkips(new Map([['a', 2]]), new Map([['a', [skip]]])).length, 1);
  assert.equal(compareSkips(new Map([['a', 1]]), new Map()).length, 1);
  assert.match(compareSkips(new Map(), new Map([['b', [skip]]]))[0] ?? '', /b: 表では0件、実際は1件/);
});

test('失敗・中断・todo・0件の試験を問題にする', () => {
  const ok = { tests: 3, suites: 0, pass: 3, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  assert.deepEqual(summaryProblems(ok), []);
  assert.equal(summaryProblems({ ...ok, tests: 0, pass: 0 }).length, 1);
  assert.equal(summaryProblems({ ...ok, fail: 1 }).length, 1);
  assert.equal(summaryProblems({ ...ok, cancelled: 1 }).length, 1);
  assert.equal(summaryProblems({ ...ok, todo: 1 }).length, 1);
});

test('環境を、Windows・macOSとLinuxのroot・一般のユーザーに分ける', () => {
  assert.equal(skipEnvironment('win32', undefined), 'windows');
  assert.equal(skipEnvironment('linux', 0), 'posix-root');
  assert.equal(skipEnvironment('darwin', 0), 'posix-root');
  assert.equal(skipEnvironment('darwin', 501), 'posix-user');
  assert.equal(skipEnvironment('linux', 1001), 'posix-user');
});
