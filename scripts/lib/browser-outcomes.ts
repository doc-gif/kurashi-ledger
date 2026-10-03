// ブラウザ試験（Playwright）の結果の分類と照合（T05）。e2e/strict-reporter.tsが使う。
// Playwrightの型には頼らず、照合に要る値（期待した結果、outcome、各試行の結果）だけを受け取る
// （ルートの型検査にDOMの型を入れないため。Playwrightの値はe2e/strict-reporter.tsで詰め替える）。
//
// 成功として数えるのは、成功を期待し（expectedStatusがpassed）、outcomeがexpectedで、最後の試行も合格した試験だけ。
// PlaywrightのoutcomeのexpectedはTest.fail()で期待どおり失敗した試験も含むので、outcomeだけでは成功と決めない
// （PR18-R002）。それ以外（期待した失敗、skip、flaky、中断、時間切れ、未実行、失敗）は、すべて問題として全体を失敗にする。

export type BrowserTestResult = {
  readonly project: string;
  readonly title: string;
  // Playwrightの TestCase.expectedStatus（passed・failed・timedOut・skipped・interrupted）
  readonly expectedStatus: string;
  // Playwrightの TestCase.outcome()（expected・unexpected・flaky・skipped）
  readonly outcome: string;
  // 各試行の TestResult.status（passed・failed・timedOut・skipped・interrupted）
  readonly statuses: readonly string[];
};

export type BrowserOutcome =
  | 'passed'
  | 'failed'
  | 'expected-failure'
  | 'skipped'
  | 'flaky'
  | 'interrupted'
  | 'timed-out'
  | 'not-run';

export const OUTCOME_LABELS: Readonly<Record<BrowserOutcome, string>> = {
  passed: '成功',
  failed: '失敗',
  'expected-failure': '期待した失敗（test.fail等）',
  skipped: 'skip',
  flaky: 'flaky（再試行で合格）',
  interrupted: '中断',
  'timed-out': '時間切れ',
  'not-run': '未実行',
};

export function classifyBrowserTest(t: BrowserTestResult): BrowserOutcome {
  const last = t.statuses.at(-1);
  if (last === undefined) return 'not-run';
  if (t.expectedStatus === 'skipped') return 'skipped';
  if (t.expectedStatus !== 'passed') return 'expected-failure';
  // skipを期待していないのにskippedで終わった試行は、実行の途中で止められたもの（全体の時間切れ等）。
  if (last === 'interrupted' || last === 'skipped') return 'interrupted';
  if (t.outcome === 'flaky') return 'flaky';
  if (last === 'timedOut') return 'timed-out';
  if (t.outcome === 'expected' && last === 'passed') return 'passed';
  return 'failed';
}

export type BrowserEvaluation = {
  readonly counts: ReadonlyMap<string, Readonly<Record<BrowserOutcome, number>>>;
  readonly problems: readonly string[];
};

function emptyCounts(): Record<BrowserOutcome, number> {
  return { passed: 0, failed: 0, 'expected-failure': 0, skipped: 0, flaky: 0, interrupted: 0, 'timed-out': 0, 'not-run': 0 };
}

// 全体の照合。成功以外の試験、必要なブラウザで成功した試験が0件、Playwright全体の結果がpassedでないことを、
// すべて問題として返す。
export function evaluateBrowserRun(
  tests: readonly BrowserTestResult[],
  requiredProjects: readonly string[],
  runStatus: string,
): BrowserEvaluation {
  const counts = new Map<string, Record<BrowserOutcome, number>>();
  const problems: string[] = [];
  for (const t of tests) {
    const outcome = classifyBrowserTest(t);
    const c = counts.get(t.project) ?? emptyCounts();
    c[outcome] += 1;
    counts.set(t.project, c);
    if (outcome !== 'passed') problems.push(`${OUTCOME_LABELS[outcome]}: [${t.project}] ${t.title}`);
  }
  for (const name of requiredProjects) {
    if ((counts.get(name)?.passed ?? 0) === 0) problems.push(`必要なブラウザ ${name} で、成功した試験が1件もない`);
  }
  if (runStatus !== 'passed') problems.push(`Playwright全体の結果が ${runStatus}（passedでない）`);
  return { counts, problems };
}
