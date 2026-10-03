// `npm run check:test-skips -- <npm testの出力のファイル>`: npm testのskipを、docs/development.md の
// 「環境によって飛ばす試験」の表とこのOSで照合し、結果（skipした試験と理由、diagnostic）を記録する（T05のCI）。
// 照合は、ファイルごとに、表で飛ばしてよいとした試験の名前の集合と、実際にskipした試験の名前の集合を比べる。
// 一致しない・読めない・理由のないskipがある・失敗や中断やtodoがある・失敗を期待した試験（expectFailure）や
// 再実行で合格した試験がある・試験が0件のときは、1で終える。
// GitHub Actionsでは、同じ内容をstep summaryにも書く。
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENVIRONMENT_LABELS,
  attributeSkips,
  compareSkips,
  parseSkipTable,
  parseSpecOutput,
  skipEnvironment,
  summaryProblems,
  testRoots,
} from './lib/test-skips.ts';

const outputFile = process.argv[2];
if (outputFile === undefined || process.argv.length !== 3) {
  console.error('使い方: npm run check:test-skips -- <npm testの出力を保存したファイル>');
  process.exit(2);
}

// 試験のファイル（リポジトリからの相対パス。区切りは/）を集める。
function collectTestFiles(root: string, dir: string, found: Map<string, string>): void {
  let entries;
  try {
    entries = readdirSync(join(root, ...dir.split('/')), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== 'node_modules') collectTestFiles(root, path, found);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.set(path, readFileSync(join(root, ...path.split('/')), 'utf8'));
  }
}

const root = process.cwd();
const problems: string[] = [];
const lines: string[] = [];
const env = skipEnvironment(process.platform, process.getuid?.());
lines.push(
  `### npm testのskip（${process.platform}/${process.arch}、Node.js ${process.version}、${ENVIRONMENT_LABELS[env]}）`,
  '',
);

try {
  const report = parseSpecOutput(readFileSync(outputFile, 'utf8'));
  const table = parseSkipTable(readFileSync(join(root, 'docs', 'development.md'), 'utf8'));
  const testScript = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> })
    .scripts?.['test'];
  const sources = new Map<string, string>();
  for (const dir of testRoots(testScript ?? '')) collectTestFiles(root, dir, sources);

  const s = report.summary;
  lines.push(
    `- 試験: ${s.tests}件（成功 ${s.pass}、失敗 ${s.fail}、中断 ${s.cancelled}、skip ${s.skipped}、todo ${s.todo}）`,
    `- 表（docs/development.md「環境によって飛ばす試験」）でこの環境に期待するskip: ${table.stated[env]}件`,
    '',
  );
  problems.push(...summaryProblems(report));

  const attributed = attributeSkips(report.skipped, sources);
  problems.push(...attributed.problems);
  const expected = table.byEnvironment.get(env) ?? new Map<string, ReadonlySet<string>>();
  problems.push(...compareSkips(expected, attributed.byFile));

  const files = [...new Set([...expected.keys(), ...attributed.byFile.keys()])].sort();
  if (files.length > 0) {
    lines.push('| ファイル | 表の件数 | 実際のskip |', '| --- | --- | --- |');
    for (const file of files) {
      lines.push(`| ${file} | ${expected.get(file)?.size ?? 0} | ${attributed.byFile.get(file)?.length ?? 0} |`);
    }
    lines.push('');
  }
  lines.push('skipした試験と理由（表に名前があるものは「表どおり」）:');
  if (report.skipped.length === 0) lines.push('- なし');
  for (const [file, tests] of attributed.byFile) {
    for (const t of tests) {
      lines.push(`- ${file}: ${t.name} — ${t.reason}（${expected.get(file)?.has(t.name) === true ? '表どおり' : '表にない'}）`);
    }
  }
  lines.push('', '試験の出力のdiagnostic（弱めて確かめた箇所の記録を含む）:');
  if (report.diagnostics.length === 0) lines.push('- なし');
  for (const d of report.diagnostics) lines.push(`- ${d}`);
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
}

lines.push('', problems.length === 0 ? '照合: 一致（表で飛ばしてよいとした試験と、実際にskipした試験が同じ）。' : '照合: 不一致・読めない。');
for (const p of problems) lines.push(`- ${p}`);
const text = `${lines.join('\n')}\n`;
console.log(text);
const summary = process.env['GITHUB_STEP_SUMMARY'];
if (summary !== undefined && summary !== '') appendFileSync(summary, text);
process.exitCode = problems.length === 0 ? 0 : 1;
