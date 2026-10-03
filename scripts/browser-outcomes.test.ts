// ブラウザ試験の照合（scripts/lib/browser-outcomes.ts、e2e/strict-reporter.ts）の試験（T05、PR18-R002）。
// 成功として数えるのは、成功を期待して実際に合格した試験だけで、期待した失敗（test.fail()）等は全体を失敗にする。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type BrowserTestResult, classifyBrowserTest, evaluateBrowserRun } from './lib/browser-outcomes.ts';

const repoRoot = join(import.meta.dirname, '..');
const passed: BrowserTestResult = {
  project: 'chromium',
  title: '合成',
  expectedStatus: 'passed',
  outcome: 'expected',
  statuses: ['passed'],
};

test('分類: 成功を期待して合格した試験だけを成功とし、期待した失敗・skip・flaky・中断・時間切れ・未実行・失敗を分ける', () => {
  const cases: readonly [Partial<BrowserTestResult>, string][] = [
    [{}, 'passed'],
    [{ outcome: 'unexpected', statuses: ['failed'] }, 'failed'],
    // test.fail()で、期待どおり失敗した（Playwrightのoutcomeはexpected）。
    [{ expectedStatus: 'failed', outcome: 'expected', statuses: ['failed'] }, 'expected-failure'],
    // test.fail()なのに合格した。
    [{ expectedStatus: 'failed', outcome: 'unexpected', statuses: ['passed'] }, 'expected-failure'],
    [{ expectedStatus: 'timedOut', outcome: 'expected', statuses: ['timedOut'] }, 'expected-failure'],
    [{ expectedStatus: 'skipped', outcome: 'skipped', statuses: ['skipped'] }, 'skipped'],
    [{ outcome: 'flaky', statuses: ['failed', 'passed'] }, 'flaky'],
    [{ outcome: 'unexpected', statuses: ['interrupted'] }, 'interrupted'],
    // skipを期待していないのにskippedで終わった（全体の時間切れで止められた）。
    [{ outcome: 'skipped', statuses: ['skipped'] }, 'interrupted'],
    [{ outcome: 'unexpected', statuses: ['timedOut'] }, 'timed-out'],
    [{ outcome: 'skipped', statuses: [] }, 'not-run'],
    // 値が食い違うときも成功にしない。
    [{ outcome: 'expected', statuses: ['failed'] }, 'failed'],
    [{ outcome: 'unexpected', statuses: ['passed'] }, 'failed'],
  ];
  for (const [patch, want] of cases) {
    assert.equal(classifyBrowserTest({ ...passed, ...patch }), want, JSON.stringify(patch));
  }
});

test('照合: 成功以外の試験、必要なブラウザで成功が0件、全体の結果がpassedでないことを、どれも問題にする', () => {
  const webkit = { ...passed, project: 'webkit' };
  assert.deepEqual(evaluateBrowserRun([passed, webkit], ['chromium', 'webkit'], 'passed').problems, []);
  const expectedFailure = { ...passed, title: '期待した失敗', expectedStatus: 'failed', statuses: ['failed'] };
  const mixed = evaluateBrowserRun([passed, expectedFailure], ['chromium'], 'passed');
  assert.deepEqual(mixed.problems, ['期待した失敗（test.fail等）: [chromium] 期待した失敗']);
  assert.equal(mixed.counts.get('chromium')?.passed, 1);
  assert.equal(mixed.counts.get('chromium')?.['expected-failure'], 1);
  // 期待した失敗だけでは、必要なブラウザの成功に数えない。
  assert.match(evaluateBrowserRun([expectedFailure], ['chromium'], 'passed').problems.join('\n'), /chromium で、成功した試験が1件もない/);
  assert.match(evaluateBrowserRun([passed], ['chromium', 'webkit'], 'passed').problems.join('\n'), /webkit で、成功した試験が1件もない/);
  assert.match(evaluateBrowserRun([passed], ['chromium'], 'interrupted').problems.join('\n'), /全体の結果が interrupted/);
  assert.match(evaluateBrowserRun([], ['chromium'], 'passed').problems.join('\n'), /chromium で、成功した試験が1件もない/);
});

// 実際のPlaywrightで、e2e/reporter-fixtures/ の合成の試験（ブラウザを使わない）を、照合を通して流す。
const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');

function runFixture(reporterCase: string) {
  const output = mkdtempSync(join(tmpdir(), 'kl-reporter-'));
  try {
    // 試験の実行中に受け継ぐNODE_TEST_CONTEXT等と、CIのstep summaryの出力先を外す。
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^NODE_/i.test(key) && key !== 'GITHUB_STEP_SUMMARY') env[key] = value;
    }
    env['KL_REPORTER_CASE'] = reporterCase;
    env['KL_REPORTER_OUTPUT'] = output;
    const config = join(repoRoot, 'e2e', 'reporter-fixtures', 'fixtures.config.ts');
    return spawnSync(process.execPath, [cli, 'test', '--config', config], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

// [場合, 終了コードが0か, 照合の出力, Playwright自身の結果（照合の前）]
const RUNS: readonly [string, boolean, RegExp, RegExp][] = [
  ['pass', true, /照合: 成功/, /Playwrightの結果: passed/],
  ['fail', false, /^- 失敗: \[/m, /Playwrightの結果: failed/],
  ['expected-failure', false, /^- 期待した失敗（test\.fail等）: \[/m, /Playwrightの結果: passed/],
  ['skip', false, /^- skip: \[/m, /Playwrightの結果: passed/],
  ['flaky', false, /^- flaky（再試行で合格）: \[/m, /Playwrightの結果: passed/],
  ['interrupted', false, /^- (中断|未実行): \[/m, /Playwrightの結果: timedout/],
];

for (const [reporterCase, succeeds, message, playwrightResult] of RUNS) {
  test(`実際のPlaywrightで「${reporterCase}」の試験を流すと、照合の結果と終了コードが合う`, () => {
    const r = runFixture(reporterCase);
    const output = `${r.stdout}\n${r.stderr}`;
    assert.equal(r.error, undefined, output);
    if (succeeds) assert.equal(r.status, 0, output);
    else assert.notEqual(r.status, 0, output);
    assert.match(output, message);
    assert.match(output, playwrightResult);
  });
}
