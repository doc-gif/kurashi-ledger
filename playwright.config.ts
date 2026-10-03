// ブラウザ試験（Playwright）の設定（T05、ADR-0004）。使い方は docs/development.md の「ブラウザ試験」。
// - 試験は e2e/ の *.spec.ts（node --test の *.test.ts とは別）。ブラウザは e2e/browsers.ts で決める。
// - ブラウザの安全上の既定の動き（CSP、HTTPSの検査、要求のヘッダ、権限、プロキシ）を変える設定は使わない。
//   T26のcookieの交換・Origin・Sec-Fetch-Site・CSPの試験を、実際のブラウザの動きのまま確かめるため。
// - 失敗・skip・flakyを成功に見せないよう、retriesを使わず、e2e/strict-reporter.ts で照合する。
// - trace・screenshot・videoは作らない（CIでartifactをuploadしない。docs/public-data.md）。
import { defineConfig, devices } from '@playwright/test';
import { type BrowserProjectName, requiredBrowserProjects } from './e2e/browsers.ts';

const DEVICE_NAMES: Readonly<Record<BrowserProjectName, string>> = {
  chromium: 'Desktop Chrome',
  webkit: 'Desktop Safari',
};

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  reporter: [['list'], ['./e2e/strict-reporter.ts']],
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: requiredBrowserProjects(process.platform).map((name) => {
    const device = devices[DEVICE_NAMES[name]];
    if (device === undefined) throw new Error(`Playwrightに端末の設定 ${DEVICE_NAMES[name]} がない`);
    return { name, use: { ...device } };
  }),
});
