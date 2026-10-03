// npm test（node --test）のskipの照合（T05）。
// npm testの出力（既定のspecの形式）から、要約・skipした試験と理由・diagnosticを読み取り、
// docs/development.md の「環境によって飛ばす試験」の表（skipの件数と一覧の正本）と、OSごとに照合する。
// 表とは別の一覧を持たない（件数を書き写さない）。表の書き方が変わって読めなくなったら、照合を失敗にする。

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
};

// 色の制御文字（CSI）。
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const SUMMARY_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'] as const;

// node --testのspecの出力を読む。要約は最後の「ℹ tests」〜「ℹ duration_ms」の8行。diagnosticも「ℹ 」で
// 始まるので、末尾から探した最後の並びを要約とする。skipとtodoの行は「﹣ 名前 (時間ms) # 理由」の形
// （時間は0のとき出ない）。todoが0件のときだけ、「﹣」の行をすべてskipとして読める（照合ではtodoを0件に限る）。
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
  for (const line of lines.slice(0, start)) {
    const skip = /^\s*﹣ (.+?)(?: \(\d+(?:\.\d+)?ms\))? # (.*)$/.exec(line);
    if (skip !== null) {
      skippedTests.push({ name: skip[1] ?? '', reason: skip[2] ?? '' });
      continue;
    }
    const diagnostic = /^\s*ℹ (.*)$/.exec(line);
    if (diagnostic !== null) diagnostics.push(diagnostic[1] ?? '');
  }
  if (skippedTests.length !== summary.skipped + summary.todo) {
    throw new Error(
      `「﹣」の行（${skippedTests.length}件）が、要約のskipped（${summary.skipped}）とtodo（${summary.todo}）の合計と合わない（出力の形式が変わった可能性）。`,
    );
  }
  return { summary, skipped: skippedTests, diagnostics };
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
  // 環境ごとの、ファイル（リポジトリからの相対パス）ごとの件数。
  readonly byEnvironment: ReadonlyMap<SkipEnvironment, ReadonlyMap<string, number>>;
  // 表の下の「件数は、…になる。」の文の件数。
  readonly stated: Readonly<Record<SkipEnvironment, number>>;
};

export const SKIP_SECTION_HEADING = '### 環境によって飛ばす試験';

function cells(row: string): string[] {
  return row.split('|').slice(1, -1).map((c) => c.trim());
}

// docs/development.mdの「環境によって飛ばす試験」の表と件数の文を読む。表の各行は
// 「| 環境 | `ファイル`の…N件、`ファイル`の…M件 | 理由 | 代わりの確認 |」の形。
// 表の合計と文の件数が環境ごとに一致しなければ失敗にする（片方だけを直した食い違いを見逃さない）。
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
    throw new Error('「環境によって飛ばす試験」の表（環境・飛ばす試験（件数）の列）を読めない。');
  }
  const labelToEnvironment = new Map<string, SkipEnvironment>(
    Object.entries(ENVIRONMENT_LABELS).map(([env, label]) => [label, env as SkipEnvironment]),
  );
  const byEnvironment = new Map<SkipEnvironment, Map<string, number>>();
  for (const row of rows.slice(2)) {
    const [label = '', skips = ''] = cells(row);
    const env = labelToEnvironment.get(label);
    if (env === undefined) {
      throw new Error(`表の環境「${label}」を照合で扱えない。scripts/lib/test-skips.tsのENVIRONMENT_LABELSとCIの照合を同じPRで直す。`);
    }
    const files = byEnvironment.get(env) ?? new Map<string, number>();
    let found = 0;
    for (const match of skips.matchAll(/`([^`]+\.test\.ts)`の[^`]*?(\d+)件/g)) {
      const file = match[1] ?? '';
      files.set(file, (files.get(file) ?? 0) + Number(match[2]));
      found += 1;
    }
    if (found === 0) throw new Error(`表の「${label}」の行から、\`ファイル\`の…N件 の形の記載を読めない。`);
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
    const total = [...(byEnvironment.get(env)?.values() ?? [])].reduce((a, b) => a + b, 0);
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

// ファイルごとに、表の件数と実際のskipの件数を比べる。
export function compareSkips(
  expected: ReadonlyMap<string, number>,
  actual: ReadonlyMap<string, readonly SkippedTest[]>,
): string[] {
  const problems: string[] = [];
  for (const file of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
    const want = expected.get(file) ?? 0;
    const got = actual.get(file)?.length ?? 0;
    if (want !== got) problems.push(`${file}: 表では${want}件、実際は${got}件skipした。`);
  }
  return problems;
}

// 失敗・中断・todo・0件の試験も、成功に見えないように問題として返す。
export function summaryProblems(summary: TestSummary): string[] {
  const problems: string[] = [];
  if (summary.tests === 0) problems.push('試験が1件も実行されていない。');
  if (summary.fail > 0) problems.push(`失敗した試験が${summary.fail}件ある。`);
  if (summary.cancelled > 0) problems.push(`中断した試験が${summary.cancelled}件ある。`);
  if (summary.todo > 0) problems.push(`todoの試験が${summary.todo}件ある（skipと見分けられないので、照合では0件に限る）。`);
  return problems;
}
