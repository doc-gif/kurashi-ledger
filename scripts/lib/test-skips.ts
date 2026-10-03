// npm test（node --test）のskipの照合（T05）。
// npm testの出力（既定のspecの形式）から、要約・skipした試験と理由・diagnosticを読み取り、
// docs/development.md の「環境によって飛ばす試験」の表（飛ばしてよい試験の名前と件数の正本）と、OSごとに照合する。
// 照合は、ファイルごとに、飛ばしてよい試験の名前の集合と、実際にskipした試験の名前の集合が過不足なく一致すること
// （件数が同じでも、別の試験とのすり替えは不一致）。表とは別の一覧を持たない。表の書き方が変わって読めなくなったら、
// 照合を失敗にする。skipの理由は期待値に含めない（理由の文字列の正本は試験のファイル）。代わりに、skipごとに
// 理由の文字列があることを確かめて記録し、理由の妥当性はレビューで表と読み合わせる。

export type TestSummary = {
  readonly tests: number;
  readonly suites: number;
  readonly pass: number;
  readonly fail: number;
  readonly cancelled: number;
  readonly skipped: number;
  readonly todo: number;
};

export type SkippedTest = { readonly name: string; readonly reason: string };

export type SpecReport = {
  readonly summary: TestSummary;
  readonly skipped: readonly SkippedTest[];
  readonly diagnostics: readonly string[];
  // expectFailure（Node.js 24.14以上）で期待どおり失敗した試験。要約ではpassに数えられる。
  readonly expectedFailures: readonly string[];
  // 再実行（--test-rerun-failures）で合格した試験（「(passed on attempt N)」）。
  readonly rerunPassed: readonly string[];
  // 要約より前の、試験の結果の行（✔・✖・﹣・⚠で始まる行。前後の空白を除く）。名前の一意性の確認に使う。
  readonly resultLines: readonly string[];
};

// 色の制御文字（CSI）。
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const SUMMARY_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const;

// node --testのspecの出力を読む。要約は最後の「ℹ tests」〜「ℹ duration_ms」の8行。diagnosticも「ℹ 」で
// 始まるので、末尾から探した最後の並びを要約とする。skipの行は「﹣ 名前 (時間ms) # 理由」の形（時間は0のとき
// 出ない）。todoの行は「✔」か「⚠」で始まり「# 理由」で終わるので「﹣」には含まれない（照合ではtodoを0件に限る）。
// expectFailureで期待どおり失敗した試験は「✔ 名前 (時間ms) # EXPECTED FAILURE」で、要約ではpassに数えられるので、
// 行から集めて照合で問題にする（PR18-R002と同じ穴）。再実行で合格した試験の「(passed on attempt N)」も集める。
export function parseSpecOutput(text: string): SpecReport {
  const lines = text.replace(ANSI, '').split(/\r?\n/);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^ℹ duration_ms \d+(?:\.\d+)?$/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  const start = end - SUMMARY_KEYS.length;
  if (end < 0 || start < 0) throw new Error('npm testの出力に、node --testの要約（ℹ tests 〜 ℹ duration_ms）がない。');
  const values: number[] = [];
  SUMMARY_KEYS.forEach((key, k) => {
    const match = new RegExp(`^ℹ ${key} (\\d+)$`).exec(lines[start + k] ?? '');
    if (match === null) throw new Error(`node --testの要約の「${key}」の行を読めない（出力の形式が変わった可能性）。`);
    values.push(Number(match[1]));
  });
  const [tests = 0, suites = 0, pass = 0, fail = 0, cancelled = 0, skipped = 0, todo = 0] = values;
  const summary: TestSummary = { tests, suites, pass, fail, cancelled, skipped, todo };

  const skippedTests: SkippedTest[] = [];
  const diagnostics: string[] = [];
  const expectedFailures: string[] = [];
  const rerunPassed: string[] = [];
  const resultLines = lines
    .slice(0, start)
    .map((l) => l.trim())
    .filter((l) => /^[✔✖﹣⚠] /.test(l));
  for (const line of lines.slice(0, start)) {
    const skip = /^\s*﹣ (.+?)(?: \(\d+(?:\.\d+)?ms\))? # (.*)$/.exec(line);
    if (skip !== null) {
      skippedTests.push({ name: skip[1] ?? '', reason: skip[2] ?? '' });
      continue;
    }
    const diagnostic = /^\s*ℹ (.*)$/.exec(line);
    if (diagnostic !== null) {
      diagnostics.push(diagnostic[1] ?? '');
      continue;
    }
    const result = /^\s*[✔✖] (.+)$/.exec(line);
    if (result !== null) {
      const title = result[1] ?? '';
      if (title.endsWith(' # EXPECTED FAILURE')) expectedFailures.push(title);
      if (/ \(passed on attempt \d+\)/.test(title)) rerunPassed.push(title);
    }
  }
  if (skippedTests.length !== summary.skipped) {
    throw new Error(
      `「﹣」の行（${skippedTests.length}件）が、要約のskipped（${summary.skipped}）と合わない（出力の形式が変わった可能性）。`,
    );
  }
  return { summary, skipped: skippedTests, diagnostics, expectedFailures, rerunPassed, resultLines };
}

export type SkipEnvironment = 'windows' | 'posix-root' | 'posix-user';

export const ENVIRONMENT_LABELS: Readonly<Record<SkipEnvironment, string>> = {
  windows: 'Windows',
  'posix-root': 'macOS・Linuxのroot',
  'posix-user': 'macOS・Linuxの一般のユーザー',
};

export function skipEnvironment(platform: NodeJS.Platform, uid: number | undefined): SkipEnvironment {
  if (platform === 'win32') return 'windows';
  return uid === 0 ? 'posix-root' : 'posix-user';
}

export type SkipTable = {
  // 環境ごとの、ファイル（リポジトリからの相対パス）ごとの、飛ばしてよい試験の名前。
  readonly byEnvironment: ReadonlyMap<SkipEnvironment, ReadonlyMap<string, ReadonlySet<string>>>;
  // 表の下の「件数は、…になる。」の文の件数。
  readonly stated: Readonly<Record<SkipEnvironment, number>>;
};

export const SKIP_SECTION_HEADING = '### 環境によって飛ばす試験';

function cells(row: string): string[] {
  return row.split('|').slice(1, -1).map((c) => c.trim());
}

// docs/development.mdの「環境によって飛ばす試験」の表と件数の文を読む。表の各行の2つ目の列は
// 「`ファイル`のN件（「試験の名前」「試験の名前」…）、`ファイル`のM件（…）」の形。
// 件数と名前の数、表の合計と文の件数が食い違えば失敗にする（片方だけを直した食い違いを見逃さない）。
export function parseSkipTable(markdown: string): SkipTable {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === SKIP_SECTION_HEADING);
  if (start < 0) throw new Error(`docs/development.mdに「${SKIP_SECTION_HEADING.replace(/^#+ /, '')}」の節がない。`);
  let stop = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
  if (stop < 0) stop = lines.length;
  const section = lines.slice(start + 1, stop);
  const rows = section.filter((l) => l.trimStart().startsWith('|'));
  const header = cells(rows[0] ?? '');
  if (rows.length < 3 || header[0] !== '環境' || !(header[1] ?? '').startsWith('飛ばす試験')) {
    throw new Error('「環境によって飛ばす試験」の表（環境・飛ばす試験の列）を読めない。');
  }
  const labelToEnvironment = new Map<string, SkipEnvironment>(
    Object.entries(ENVIRONMENT_LABELS).map(([env, label]) => [label, env as SkipEnvironment]),
  );
  const byEnvironment = new Map<SkipEnvironment, Map<string, Set<string>>>();
  for (const row of rows.slice(2)) {
    const [label = '', skips = ''] = cells(row);
    const env = labelToEnvironment.get(label);
    if (env === undefined) {
      throw new Error(`表の環境「${label}」を照合で扱えない。scripts/lib/test-skips.tsのENVIRONMENT_LABELSとCIの照合を同じPRで直す。`);
    }
    const files = byEnvironment.get(env) ?? new Map<string, Set<string>>();
    // 書き方の外の文字（「、」と空白以外）が残れば、読み落としとして失敗にする。
    let found = 0;
    const rest = skips.replace(/`([^`]+\.test\.ts)`の(\d+)件（((?:「[^「」]+」)+)）/g, (_all, file: string, count: string, list: string) => {
      const names = [...list.matchAll(/「([^「」]+)」/g)].map((m) => m[1] ?? '');
      if (names.length !== Number(count)) {
        throw new Error(`表の「${label}」の行の ${file}: 件数（${count}件）と、書いた試験の名前の数（${names.length}）が合わない。`);
      }
      const set = files.get(file) ?? new Set<string>();
      for (const name of names) {
        if (set.has(name)) throw new Error(`表の「${label}」の行の ${file}: 試験「${name}」が2回ある。`);
        set.add(name);
      }
      files.set(file, set);
      found += 1;
      return '';
    });
    if (found === 0 || rest.replace(/[、\s]/g, '') !== '') {
      throw new Error(`表の「${label}」の行を、\`ファイル\`のN件（「試験の名前」…）の形で読めない。`);
    }
    byEnvironment.set(env, files);
  }

  const sentence = /件数は、macOS・Linuxの一般のユーザーで(\d+)件、Windowsで(\d+)件、macOS・Linuxのrootで(\d+)件になる。/.exec(
    section.join('\n'),
  );
  if (sentence === null) throw new Error('表の下の「件数は、…になる。」の文を読めない。');
  const stated: Record<SkipEnvironment, number> = {
    'posix-user': Number(sentence[1]),
    windows: Number(sentence[2]),
    'posix-root': Number(sentence[3]),
  };
  for (const env of Object.keys(ENVIRONMENT_LABELS) as SkipEnvironment[]) {
    const total = [...(byEnvironment.get(env)?.values() ?? [])].reduce((a, names) => a + names.size, 0);
    if (total !== stated[env]) {
      throw new Error(`表の${ENVIRONMENT_LABELS[env]}の合計（${total}件）と、件数の文（${stated[env]}件）が食い違う。`);
    }
  }
  return { byEnvironment, stated };
}

// package.jsonのtestのscript（node --test "dir/**/*.test.ts" …）から、試験を探す場所を読む。
// npm testと同じ場所を見るため、場所を別に書き写さない。
export function testRoots(testScript: string): string[] {
  const patterns = [...testScript.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
  if (!testScript.startsWith('node --test ') || patterns.length === 0) {
    throw new Error(`package.jsonのtestのscriptを読めない: ${testScript}`);
  }
  return patterns.map((pattern) => {
    const match = /^([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)\/\*\*\/\*\.test\.ts$/.exec(pattern);
    if (match === null) throw new Error(`testのscriptの対象 ${pattern} は「<ディレクトリ>/**/*.test.ts」の形でない。`);
    return match[1] ?? '';
  });
}

// skipした試験の名前を、試験のファイルの中の文字列で探して、ファイルに結び付ける。
// 名前が1つのファイルにだけあるときに結び付け、見つからない・複数にあるときは問題として返す。
export function attributeSkips(
  skipped: readonly SkippedTest[],
  sources: ReadonlyMap<string, string>,
): { readonly byFile: ReadonlyMap<string, readonly SkippedTest[]>; readonly problems: readonly string[] } {
  const byFile = new Map<string, SkippedTest[]>();
  const problems: string[] = [];
  for (const test of skipped) {
    const quoted = [`'${test.name}'`, `"${test.name}"`, `\`${test.name}\``];
    const files = [...sources].filter(([, source]) => quoted.some((q) => source.includes(q))).map(([file]) => file);
    if (files.length !== 1) {
      problems.push(
        files.length === 0
          ? `skipした試験「${test.name}」を、試験のファイルの中に見つけられない。`
          : `skipした試験「${test.name}」が、複数のファイル（${files.join('、')}）にある。`,
      );
      continue;
    }
    const file = files[0] ?? '';
    byFile.set(file, [...(byFile.get(file) ?? []), test]);
  }
  return { byFile, problems };
}

// ファイルごとに、表で飛ばしてよいとした試験の名前の集合と、実際にskipした試験の名前の集合を比べる。
// 表にない試験のskip（同じファイルの中のすり替えを含む）、表にあるのにskipしなかった試験、同じ名前の重複を
// 問題として返す。skipに理由の文字列がない（既定のSKIP）ものも問題にする。
export function compareSkips(
  expected: ReadonlyMap<string, ReadonlySet<string>>,
  actual: ReadonlyMap<string, readonly SkippedTest[]>,
): string[] {
  const problems: string[] = [];
  for (const file of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
    const want = expected.get(file) ?? new Set<string>();
    const got = actual.get(file) ?? [];
    const seen = new Set<string>();
    for (const test of got) {
      if (seen.has(test.name)) problems.push(`${file}: 試験「${test.name}」のskipが2回ある。`);
      seen.add(test.name);
      if (!want.has(test.name)) problems.push(`${file}: 表にない試験「${test.name}」をskipした。`);
      if (test.reason.trim() === '' || test.reason.trim() === 'SKIP') {
        problems.push(`${file}: 試験「${test.name}」のskipに理由の文字列がない。`);
      }
    }
    for (const name of want) {
      if (!seen.has(name)) problems.push(`${file}: 表で飛ばすとした試験「${name}」をskipしなかった。`);
    }
  }
  return problems;
}

// 失敗・中断・todo・0件の試験、期待した失敗（expectFailure）、再実行での合格も、成功に見えないように問題として返す。
// 期待した失敗と再実行での合格は、要約ではpassに数えられる。
export function summaryProblems(report: Pick<SpecReport, 'summary' | 'expectedFailures' | 'rerunPassed'>): string[] {
  const { summary } = report;
  const problems: string[] = [];
  if (summary.tests === 0) problems.push('試験が1件も実行されていない。');
  if (summary.fail > 0) problems.push(`失敗した試験が${summary.fail}件ある。`);
  if (summary.cancelled > 0) problems.push(`中断した試験が${summary.cancelled}件ある。`);
  if (summary.todo > 0) problems.push(`todoの試験が${summary.todo}件ある（未完成の試験を成功に数えないよう、0件に限る）。`);
  for (const title of report.expectedFailures) problems.push(`失敗を期待した試験（expectFailure）がある。要約ではpassに数えられるが成功としない: ${title}`);
  for (const title of report.rerunPassed) problems.push(`再実行で合格した試験がある: ${title}`);
  return problems;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 試験の名前が、実行の結果の行に何回現れるか。名前のあとは、時間「 (Nms)」、「 # …」、行末のどれか。
export function resultCount(report: Pick<SpecReport, 'resultLines'>, name: string): number {
  const pattern = new RegExp(`^[✔✖﹣⚠] ${escapeRegExp(name)}(?: \\(\\d| #|$)`);
  return report.resultLines.filter((line) => pattern.test(line)).length;
}

// 照合は試験を名前で突き合わせるので、表に書いた試験とskipした試験の名前が、実行の結果の中で一意でなければ
// 失敗にする。node:testは同じファイルの中でも同じ名前の試験を許し、specの出力には場所が出ないので、
// 一意でないと、表の試験が実行されて同じ名前の別の試験がskipされても、集合の照合では見分けられない（PR18-R001）。
export function uniquenessProblems(report: Pick<SpecReport, 'resultLines'>, names: Iterable<string>): string[] {
  const problems: string[] = [];
  for (const name of new Set(names)) {
    const count = resultCount(report, name);
    if (count > 1) {
      problems.push(`試験の名前「${name}」が、実行の結果に${count}回ある。同じ名前の試験の間のすり替えを見分けられないので、名前を一意にする。`);
    }
  }
  return problems;
}
