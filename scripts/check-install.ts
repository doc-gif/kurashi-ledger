// `npm run check:install`: 依存の導入の記録が、いまのlockfileと実行環境に一致するかを確かめる。
import { formatVerificationFailure, verifyInstallRecord } from './lib/install-record.ts';

const result = verifyInstallRecord(process.cwd());
if (result.ok) {
  console.log('依存の導入の記録は、いまの package-lock.json と実行環境に一致する。');
} else {
  console.error(`依存の導入の記録が、いまの状態と一致しない。\n${formatVerificationFailure(result.problems)}`);
  process.exitCode = 1;
}
