// `npm run setup`: 依存の導入（ADR-0002、ADR-0008）。
// 既存の記録を削除し、npm ciが成功したときだけ記録を書く。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { currentRuntime, npmChildEnvironment, npmCiArguments, runSetup } from './lib/install-record.ts';

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== 'false' && value !== '0';
}

const npmCli = process.env['npm_execpath'];
if (npmCli === undefined || !/^npm-cli\.c?js$/.test(basename(npmCli))) {
  console.error('このスクリプトは `npm run setup`（WindowsのPowerShellでは `npm.cmd run setup`）で実行する。');
  process.exit(1);
}
if (isTruthy(process.env['npm_config_force'])) {
  // --force はdevEnginesによるNode.jsの版の検査も外すので、導入の記録を書く操作では使わない。
  console.error('`--force` を付けて実行しない。Node.jsの版が合わない場合は、package.jsonのdevEnginesの版を入れる。');
  process.exit(1);
}

const root = process.cwd();
const runtime = currentRuntime();
process.exitCode = runSetup({
  root,
  runtime,
  runNpmCi: () => {
    // 子のnpmには、利用者・全体のnpmrcとnpm_で始まる環境変数を渡さない。
    // 使う設定は、repoの.npmrcと引数だけ（ADR-0008）。
    const configDir = mkdtempSync(join(tmpdir(), 'kurashi-ledger-setup-'));
    try {
      const emptyConfigs = { user: join(configDir, 'user-npmrc'), global: join(configDir, 'global-npmrc') };
      writeFileSync(emptyConfigs.user, '');
      writeFileSync(emptyConfigs.global, '');
      const result = spawnSync(process.execPath, [npmCli, ...npmCiArguments(runtime, emptyConfigs)], {
        cwd: root,
        stdio: 'inherit',
        env: npmChildEnvironment(process.env),
      });
      return { status: result.status, signal: result.signal, error: result.error };
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  },
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});
