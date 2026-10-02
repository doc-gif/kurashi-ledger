// `npm run setup`: 依存の導入（ADR-0002、ADR-0008）。
// 既存の記録を削除し、npm ciが成功したときだけ記録を書く。
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { currentRuntime, npmCiArguments, runSetup } from './lib/install-record.ts';

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
    // インストールスクリプトの無効化（.npmrcでも指定）と、導入する木を変えうる設定を、
    // 利用者の設定や環境変数で上書きされないよう、コマンドラインで明示する。
    const result = spawnSync(process.execPath, [npmCli, ...npmCiArguments(runtime)], {
      cwd: root,
      stdio: 'inherit',
    });
    return { status: result.status, signal: result.signal, error: result.error };
  },
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});
