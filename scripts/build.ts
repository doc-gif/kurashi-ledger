// `npm run build`: ビルドの前に依存の導入の記録を確かめる（ADR-0002）。
// UIのビルドと配信物のmanifestはT08で追加する。それまではビルドする対象がない。
// .npmrcのignore-scriptsにより、prebuild等のpre/postスクリプトは実行されないので、
// 確認はこのスクリプトの中で行う。
import { formatVerificationFailure, verifyInstallRecord } from './lib/install-record.ts';

const result = verifyInstallRecord(process.cwd());
if (!result.ok) {
  console.error(`ビルドを中止した。依存の導入の記録が、いまの状態と一致しない。\n${formatVerificationFailure(result.problems)}`);
  process.exitCode = 1;
} else {
  console.log('依存の導入の記録を確かめた。ビルドする対象はまだない（UIのビルドと配信物のmanifestはT08で追加する）。dist/ とmanifestは作っていない。');
}
