// ブラウザ試験の結果の照合（T05）。失敗・中断・想定外のskipが成功に見えないよう、試験の結果を
// scripts/lib/browser-outcomes.ts で分類し、成功（成功を期待して実際に合格した試験）以外が1件でもあれば、
// 試験そのものが通っていても全体を失敗にする。
// - 期待した失敗（test.fail()等）、skip、flaky（再試行で合格）、中断、時間切れ、未実行、失敗
// - このOSで必要なブラウザ（e2e/browsers.ts）のどれかで、成功した試験が0件
// - Playwright全体の結果がpassedでない
// いまは、ブラウザ試験で飛ばしてよい試験も、失敗を期待してよい試験もない。加えるときは、この照合と
// docs/development.md の「ブラウザ試験」を同じPRで直す。
// 結果はOS・ブラウザごとに表示し、GitHub Actionsではstep summaryにも書く。
import { appendFileSync } from 'node:fs';
import type { FullConfig, FullResult, Reporter, Suite } from '@playwright/test/reporter';
import { type BrowserOutcome, OUTCOME_LABELS, evaluateBrowserRun } from '../scripts/lib/browser-outcomes.ts';
import { requiredBrowserProjects } from './browsers.ts';

const COLUMNS: readonly BrowserOutcome[] = [
  'passed',
  'failed',
  'expected-failure',
  'skipped',
  'flaky',
  'interrupted',
  'timed-out',
  'not-run',
];

export default class StrictReporter implements Reporter {
  private root: Suite | undefined;
  private version = '';

  onBegin(config: FullConfig, suite: Suite): void {
    this.root = suite;
    this.version = config.version;
  }

  // Playwrightの型では、全体の結果を変えるにはPromiseで返す。
  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    const tests = this.root?.allTests() ?? [];
    // `--list`等で試験を集めただけ（どの試験にも結果がない）なら、照合しない。CIでは試験を実行するので、
    // 同じ状態でも失敗にする（実行しなかったことを成功に見せない）。
    if (tests.length > 0 && tests.every((t) => t.results.length === 0) && result.status === 'passed' && process.env['CI'] === undefined) {
      console.log('ブラウザ試験を実行していない（--list等）。照合はしない。');
      return undefined;
    }
    const evaluation = evaluateBrowserRun(
      tests.map((t) => ({
        project: t.parent.project()?.name ?? '(不明)',
        title: t.titlePath().slice(2).join(' › '),
        expectedStatus: t.expectedStatus,
        outcome: t.outcome(),
        statuses: t.results.map((r) => r.status),
      })),
      requiredBrowserProjects(process.platform),
      result.status,
    );

    const rows = [...evaluation.counts].map(([name, c]) => `| ${name} | ${COLUMNS.map((k) => c[k]).join(' | ')} |`);
    const verdict = evaluation.problems.length === 0 ? '成功' : '失敗';
    const report = [
      `### ブラウザ試験（${process.platform}/${process.arch}、Playwright ${this.version}）`,
      '',
      `| ブラウザ | ${COLUMNS.map((k) => OUTCOME_LABELS[k]).join(' | ')} |`,
      `| --- | ${COLUMNS.map(() => '---').join(' | ')} |`,
      ...rows,
      '',
      `Playwrightの結果: ${result.status}。照合: ${verdict}（成功として数えるのは、成功を期待して実際に合格した試験だけ）。`,
      ...evaluation.problems.map((p) => `- ${p}`),
      '',
    ].join('\n');
    console.log(`\n${report}`);
    const summary = process.env['GITHUB_STEP_SUMMARY'];
    if (summary !== undefined && summary !== '') appendFileSync(summary, `${report}\n`);

    return evaluation.problems.length > 0 ? { status: 'failed' } : undefined;
  }

  printsToStdio(): boolean {
    return false;
  }
}
