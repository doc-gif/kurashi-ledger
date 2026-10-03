// 照合（e2e/strict-reporter.ts）の回帰試験の設定（PR18-R002）。scripts/browser-outcomes.test.ts が、
// 実際のPlaywrightでこの設定を使って合成の試験を流す。ふだんのブラウザ試験（playwright.config.ts）には含まれない
// （ここの試験のファイルは *.fixture.ts で、*.spec.ts でない）。
// 合成の試験はブラウザを使わない（page等を使わない）ので、ブラウザを入れていなくても動く。
// 場合は KL_REPORTER_CASE で選び、出力先（一時ディレクトリ）は KL_REPORTER_OUTPUT で受け取る。
import { defineConfig } from '@playwright/test';
import { requiredBrowserProjects } from '../browsers.ts';

const reporterCase = process.env['KL_REPORTER_CASE'] ?? 'pass';
const output = process.env['KL_REPORTER_OUTPUT'];
if (output === undefined || output === '') throw new Error('KL_REPORTER_OUTPUT に出力先の一時ディレクトリを渡す');

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.fixture.ts',
  outputDir: output,
  workers: 1,
  retries: reporterCase === 'flaky' ? 1 : 0,
  globalTimeout: reporterCase === 'interrupted' ? 5_000 : 0,
  reporter: [['../strict-reporter.ts']],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: requiredBrowserProjects(process.platform).map((name) => ({ name })),
});
