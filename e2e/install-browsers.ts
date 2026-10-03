// `npm run test:browser:install`: このOSのブラウザ試験に要るブラウザ（e2e/browsers.ts）だけを入れる。
// 入れる先はPlaywrightの既定（利用者のキャッシュ。node_modulesの外）で、依存の導入の記録（ADR-0008）には影響しない。
// 引数はplaywright installへそのまま渡す（例: Linuxで足りないOSのライブラリも入れる `-- --with-deps`）。
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { requiredBrowserProjects } from './browsers.ts';

const require = createRequire(import.meta.url);
// lockfileで固定した版のPlaywrightのCLIを、シェルを通さずにいまのNode.jsで起動する（Mac・Windowsで同じ動き）。
const cli = require.resolve('@playwright/test/cli');
const browsers = requiredBrowserProjects(process.platform);
const args = [cli, 'install', ...process.argv.slice(2), ...browsers];
console.log(`入れるブラウザ: ${browsers.join(', ')}（${process.platform}）`);
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) {
  console.error(`playwright install を起動できなかった: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
