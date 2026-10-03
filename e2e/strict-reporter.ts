// ブラウザ試験の結果の照合（T05）。失敗・中断・想定外のskipが成功に見えないよう、次のどれかに当たれば、
// 試験そのものが通っていても全体を失敗にする。
// - このOSで必要なブラウザ（e2e/browsers.ts）のどれかで、実行した試験が0件
// - skipした試験がある（いまは、ブラウザ試験で飛ばしてよい試験はない。加えるときは、この照合と
//   docs/development.md の「ブラウザ試験」を同じPRで直す）
// - flaky（再試行で通った）試験がある（retriesは0だが、設定を変えても見逃さないように）
// 結果はOS・ブラウザごとに表示し、GitHub Actionsではstep summaryにも書く。
import { appendFileSync } from 'node:fs';
import type { FullConfig, FullResult, Reporter, Suite } from '@playwright/test/reporter';
import { requiredBrowserProjects } from './browsers.ts';

type Counts = { passed: number; failed: number; skipped: number; flaky: number };

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
    const counts = new Map<string, Counts>();
    const problems: string[] = [];
    for (const test of tests) {
      const project = test.parent.project()?.name ?? '(不明)';
      const c = counts.get(project) ?? { passed: 0, failed: 0, skipped: 0, flaky: 0 };
      const outcome = test.outcome();
      if (outcome === 'expected') c.passed += 1;
      else if (outcome === 'unexpected') c.failed += 1;
      else if (outcome === 'flaky') c.flaky += 1;
      else c.skipped += 1;
      counts.set(project, c);
      if (outcome === 'skipped') problems.push(`skipした試験がある: [${project}] ${test.titlePath().slice(2).join(' › ')}`);
      if (outcome === 'flaky') problems.push(`再試行で通った試験がある: [${project}] ${test.titlePath().slice(2).join(' › ')}`);
    }
    for (const name of requiredBrowserProjects(process.platform)) {
      const c = counts.get(name);
      if (c === undefined || c.passed + c.failed + c.flaky === 0) {
        problems.push(`このOS（${process.platform}）で必要なブラウザ ${name} の試験が1件も実行されていない`);
      }
    }

    const rows = [...counts].map(([name, c]) => `| ${name} | ${c.passed} | ${c.failed} | ${c.skipped} | ${c.flaky} |`);
    const verdict = problems.length === 0 && result.status === 'passed' ? '成功' : '失敗';
    const report = [
      `### ブラウザ試験（${process.platform}/${process.arch}、Playwright ${this.version}）`,
      '',
      '| ブラウザ | 成功 | 失敗 | skip | flaky |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
      `Playwrightの結果: ${result.status}。照合: ${verdict}。`,
      ...problems.map((p) => `- ${p}`),
      '',
    ].join('\n');
    console.log(`\n${report}`);
    const summary = process.env['GITHUB_STEP_SUMMARY'];
    if (summary !== undefined && summary !== '') appendFileSync(summary, `${report}\n`);

    return problems.length > 0 ? { status: 'failed' } : undefined;
  }

  printsToStdio(): boolean {
    return false;
  }
}
