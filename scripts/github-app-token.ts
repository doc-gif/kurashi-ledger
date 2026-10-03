// GitHub Appのinstallation access tokenを発行し、標準出力にトークンだけを出す（docs/github-apps.md）。
//   GH_TOKEN="$(node scripts/github-app-token.ts --agent <codex|claude> --purpose <review|implement>)" gh pr view <番号>
// npm scriptにしない: npm runは標準出力に見出しを出すので、$(...)で受けるとトークンに混ざる。
// 中核と試験は scripts/lib/github-app-token.ts と scripts/github-app-token.test.ts。
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { MAX_KEY_BYTES, TokenError, readKeyFileFromDisk, readKeychainKey, run, type ExecFileLike } from './lib/github-app-token.ts';

const execFileAsync = promisify(execFile) as unknown as ExecFileLike;
const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new TokenError('--key-stdin では、鍵を標準入力へパイプで渡す（端末からは読まない）。');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.length;
    chunks.push(buffer);
    if (length > MAX_KEY_BYTES) {
      for (const c of chunks) c.fill(0);
      throw new TokenError(`標準入力の鍵が大きすぎる（${MAX_KEY_BYTES}バイトまで）。`);
    }
  }
  const joined = Buffer.concat(chunks);
  const text = joined.toString('utf8');
  joined.fill(0);
  for (const c of chunks) c.fill(0);
  return text;
}

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  platform: process.platform,
  uid,
  username: userInfo().username,
  nowSeconds: () => Math.floor(Date.now() / 1000),
  fetch: (url, init) => fetch(url, init),
  readKeychain: (service, account) => readKeychainKey(service, account, process.platform, execFileAsync),
  readKeyFile: (path) => readKeyFileFromDisk(path, process.platform, uid),
  readStdin,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
