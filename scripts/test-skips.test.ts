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
  '| 環境 | 飛ばす試験（ファイル・件数・試験の名前） | 理由 | 代わりの確認 |',
  '| --- | --- | --- | --- |',
  '| Windows | `scripts/a.test.ts`の3件（「シグナルA」「シグナルB」「シグナルC」）、`scripts/b.test.ts`の1件（「npmのCtrl+C」） | 理由 | 確認 |',
  '| Windows | `scripts/c.test.ts`の1件（「印を消せない」） | 理由 | 確認 |',
  '| macOS・Linuxのroot | `scripts/c.test.ts`の1件（「印を消せない」） | 理由 | 確認 |',
  '',
  '件数は、macOS・Linuxの一般のユーザーで0件、Windowsで5件、macOS・Linuxのrootで1件になる。',
  '',
  '## 次の節',
  '',
  '件数は、macOS・Linuxの一般のユーザーで9件、Windowsで9件、macOS・Linuxのrootで9件になる。',
].join('\n');

function namesOf(table: ReturnType<typeof parseSkipTable>, env: 'windows' | 'posix-root' | 'posix-user') {
  return [...(table.byEnvironment.get(env) ?? [])].map(([file, names]) => [file, [...names]]);
}

test('表と件数の文を読み、環境ごと・ファイルごとに飛ばしてよい試験の名前を返す', () => {
  const table = parseSkipTable(SAMPLE_DOC);
  assert.deepEqual(table.stated, { 'posix-user': 0, windows: 5, 'posix-root': 1 });
  assert.deepEqual(namesOf(table, 'windows'), [
    ['scripts/a.test.ts', ['シグナルA', 'シグナルB', 'シグナルC']],
    ['scripts/b.test.ts', ['npmのCtrl+C']],
    ['scripts/c.test.ts', ['印を消せない']],
  ]);
  assert.deepEqual(namesOf(table, 'posix-root'), [['scripts/c.test.ts', ['印を消せない']]]);
  assert.equal(table.byEnvironment.get('posix-user'), undefined);
});

test('件数と名前の数、表と件数の文が食い違う・知らない環境・読めない行・名前の重複・節がないときは失敗にする', () => {
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace('Windowsで5件', 'Windowsで4件')), /食い違う/);
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace('`scripts/a.test.ts`の3件', '`scripts/a.test.ts`の2件')), /合わない/);
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace('| macOS・Linuxのroot |', '| FreeBSD |')), /FreeBSD/);
  // 名前のない書き方や、書き方の外の文字が残る行は、読み落とさずに失敗にする。
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace('`scripts/b.test.ts`の1件（「npmのCtrl+C」）', '`scripts/b.test.ts`の1件')), /読めない/);
  assert.throws(
    () => parseSkipTable(SAMPLE_DOC.replace('| Windows | `scripts/c.test.ts`の1件（「印を消せない」） |', '| Windows | 印を消せないとき |')),
    /読めない/,
  );
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace('「シグナルB」', '「シグナルA」')), /2回/);
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace('### 環境によって飛ばす試験', '### 別の節')), /節がない/);
  assert.throws(() => parseSkipTable(SAMPLE_DOC.replace(/件数は、macOS・Linuxの一般のユーザーで0件[^\n]*\n/, '')), /文を読めない/);
});

test('docs/development.mdの実際の表を読め、表の試験はそのファイルでskipの指定を持つ試験の名前である', () => {
  const table = parseSkipTable(readFileSync(join(repoRoot, 'docs', 'development.md'), 'utf8'));
  const listed = [...table.byEnvironment.values()].flatMap((m) => [...m].flatMap(([file, names]) => [...names].map((n) => [file, n] as const)));
  assert.ok(listed.length > 0);
  for (const [file, name] of listed) {
    const path = join(repoRoot, ...file.split('/'));
    assert.ok(existsSync(path), `表のファイルがない: ${file}`);
    const line = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .find((l) => l.includes(`test('${name}'`));
    assert.ok(line !== undefined, `表の試験が ${file} にない: ${name}`);
    assert.match(line, /\{ skip: /, `表の試験にskipの指定がない: ${name}`);
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

test('ファイルごとに、表の試験の名前の集合と実際のskipの集合が過不足なく一致しなければ問題にする', () => {
  const skip = (name: string, reason = '理由') => ({ name, reason });
  const expected = new Map([['a', new Set(['A', 'B'])]]);
  assert.deepEqual(compareSkips(expected, new Map([['a', [skip('A'), skip('B')]]])), []);
  assert.deepEqual(compareSkips(new Map(), new Map()), []);
  // 同じファイルの中のすり替え（件数は同じ2件）: Bの代わりにCがskipされたら拒む。
  const swapped = compareSkips(expected, new Map([['a', [skip('A'), skip('C')]]]));
  assert.equal(swapped.length, 2);
  assert.match(swapped.join('\n'), /表にない試験「C」/);
  assert.match(swapped.join('\n'), /「B」をskipしなかった/);
  // 少ない・表にないファイル・同じ名前の重複。
  assert.match(compareSkips(expected, new Map([['a', [skip('A')]]])).join(), /「B」をskipしなかった/);
  assert.match(compareSkips(new Map(), new Map([['b', [skip('X')]]])).join(), /b: 表にない試験「X」/);
  assert.match(compareSkips(expected, new Map([['a', [skip('A'), skip('A'), skip('B')]]])).join(), /2回/);
  // 理由の文字列がないskip（skip: true の既定のSKIP、空）は、表にあっても問題にする。
  assert.match(compareSkips(expected, new Map([['a', [skip('A', 'SKIP'), skip('B')]]])).join(), /理由の文字列がない/);
  assert.match(compareSkips(expected, new Map([['a', [skip('A', ' '), skip('B')]]])).join(), /理由の文字列がない/);
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
