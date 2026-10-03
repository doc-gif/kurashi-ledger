// ブラウザ試験で使うブラウザ（ADR-0004、T05）。この1か所で決め、playwright.config.tsのprojects、
// e2e/strict-reporter.tsの照合、`npm run test:browser:install`が使う。
// - ChromiumはMac・Windows・Linuxで実行する（Chrome・Edgeの代わり。CIではLinuxも）。
// - WebKitはMacでだけ実行する（PlaywrightのWindows・LinuxのWebKitはSafariの代わりにならない）。
// - Firefoxはbest effortで、必須の対象に含めない（2026-10-02の所有者決定）。
// Playwrightを読み込まないので、ブラウザを入れる前のスクリプトからも使える。

export type BrowserProjectName = 'chromium' | 'webkit';

export function requiredBrowserProjects(platform: NodeJS.Platform): readonly BrowserProjectName[] {
  return platform === 'darwin' ? ['chromium', 'webkit'] : ['chromium'];
}
