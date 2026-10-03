// `npm run setup`: 依存の導入（ADR-0002、ADR-0008）。
// 既存の記録を削除し、npm ciが成功したときだけ記録を書く。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  type NpmCiResult,
  SetupInterruption,
  currentRuntime,
  npmChildEnvironment,
  npmCiArguments,
  runSetup,
  setupSignals,
} from './lib/install-record.ts';

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

// 終了のシグナル（POSIXはSIGINT・SIGTERM・SIGHUP、WindowsはSIGINT・SIGBREAK）を受けたら、新しい手順を始めず、
// npm ciの終了を待ってから記録と作業中の印を片付けて、128+シグナル番号で終える（ADR-0008）。
// 受付はプロセスが終わるまで外さない（確定点より後のシグナルで、片付けの途中に止まらないように）。
const interruption = new SetupInterruption({
  onFirstSignal: (signal) =>
    console.error(`${signal} を受けた。新しい手順を始めず、npm ci の終了を待ってから、記録と作業中の印を片付ける。`),
});
for (const signal of setupSignals(process.platform)) {
  process.on(signal, () => interruption.notify(signal));
}

process.exitCode = await runSetup({
  root,
  runtime,
  interruption,
  runNpmCi: () => {
    // 子のnpmには、利用者・全体のnpmrcとnpm_で始まる環境変数を渡さない。
    // 使う設定は、repoの.npmrcと引数だけ（ADR-0008）。
    const configDir = mkdtempSync(join(tmpdir(), 'kurashi-ledger-setup-'));
    const cleanup = () => rmSync(configDir, { recursive: true, force: true });
    try {
      const emptyConfigs = { user: join(configDir, 'user-npmrc'), global: join(configDir, 'global-npmrc') };
      writeFileSync(emptyConfigs.user, '');
      writeFileSync(emptyConfigs.global, '');
      const child = spawn(process.execPath, [npmCli, ...npmCiArguments(runtime, emptyConfigs)], {
        cwd: root,
        stdio: 'inherit',
        env: npmChildEnvironment(process.env),
      });
      const done = new Promise<NpmCiResult>((resolve) => {
        child.once('error', (error) => resolve({ status: null, signal: null, error }));
        child.once('exit', (status, signal) => resolve({ status, signal }));
      }).finally(cleanup);
      return {
        done,
        // WindowsではPOSIXのシグナルを送れず、SIGTERMで子を終わらせる（Node.jsの仕様）。
        forward: (signal) => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill(process.platform === 'win32' ? 'SIGTERM' : signal);
          }
        },
      };
    } catch (error) {
      cleanup();
      return { done: Promise.resolve({ status: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) }) };
    }
  },
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});
