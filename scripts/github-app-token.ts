// GitHub Appのinstallation access tokenを発行し、そのトークンでコマンドを子プロセスとして実行する
// （docs/github-apps.md）。トークンは子の環境のGH_TOKENにだけ置き、表示しない。
//   node <信頼した写し>/github-app-token.ts --agent <codex|claude> --purpose <dispatch-read|review|implement|implement-workflows|merge-check> -- gh pr view <番号>
// PRのcheckoutから実行しない。レビュー済みのmainのSHAから、repoの外へ取り出した写しで実行する（docs/github-apps.md）。
// 中核と試験は scripts/lib/github-app-token.ts と scripts/github-app-token.test.ts。
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  isExecutableFile,
  onProcessSignals,
  readKeyFileFromDisk,
  readKeyFromStream,
  readKeychainKey,
  resolveCommand,
  run,
  spawnChild,
  type ExecFileLike,
} from './lib/github-app-token.ts';

const execFileAsync = promisify(execFile) as unknown as ExecFileLike;
const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  platform: process.platform,
  uid,
  username: () => userInfo().username,
  nowSeconds: () => Math.floor(Date.now() / 1000),
  fetch: (url, init) => fetch(url, init),
  readKeychain: (service, account) => readKeychainKey(service, account, process.platform, execFileAsync),
  readKeyFile: (path) => readKeyFileFromDisk(path, process.platform, uid),
  readStdin: () => readKeyFromStream(process.stdin),
  resolveCommand: (program) => resolveCommand(program, process.env, process.platform, (path) => isExecutableFile(path, process.platform)),
  // ghの空の設定ディレクトリ（mkdtempは所有者だけが使える権限で作る）。子の終了後に、このディレクトリだけを消す。
  makeConfigDir: () => mkdtempSync(join(tmpdir(), 'kl-gh-config-')),
  removeConfigDir: (path) => rmSync(path, { recursive: true, force: true }),
  runChild: spawnChild,
  onSignals: onProcessSignals,
  stderr: (text) => process.stderr.write(text),
});
