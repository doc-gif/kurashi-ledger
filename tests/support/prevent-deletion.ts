// 試験の中で、ディレクトリの直下のファイル1つを消せない状態にする補助（作業中の印を消せないときの試験。Issue #19）。
// - POSIX: ディレクトリを書込み禁止（0555）にする。rootのユーザーは権限を無視して消せるので、呼び出し側でskipする。
// - Windows: 読取り専用の属性はNode.jsが外して消すので使えない。代わりに、ファイルにDELETE、ディレクトリに
//   DELETE_CHILD（子の削除）を拒否するACEを、Everyone（S-1-1-0。実行中のユーザーを含む）に付ける。Windowsは、
//   ファイルのDELETEか親のDELETE_CHILDのどちらかが許されれば消せるので、両方を拒否する。読み取り・書込みは拒否しない
//   （印の中身の照合はできる）。icaclsはWindowsに同梱で、SIDで指定するので表示名のロケールに左右されない。
// 戻り値の関数で元に戻す（試験の後始末で、ディレクトリを消せるようにする）。
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

const EVERYONE = '*S-1-1-0';

function icacls(args: readonly string[]): void {
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  const result = spawnSync(join(systemRoot, 'System32', 'icacls.exe'), args, { encoding: 'utf8', windowsHide: true });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`icacls ${args.join(' ')} が失敗した: ${result.error?.message ?? ''}${result.stdout}${result.stderr}`);
  }
}

export function preventDeletion(dir: string, name: string): () => void {
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o555);
    return () => chmodSync(dir, 0o755);
  }
  const file = join(dir, name);
  icacls([file, '/deny', `${EVERYONE}:(D)`]);
  try {
    icacls([dir, '/deny', `${EVERYONE}:(DC)`]);
  } catch (error) {
    icacls([file, '/remove:d', EVERYONE]);
    throw error;
  }
  return () => {
    icacls([dir, '/remove:d', EVERYONE]);
    icacls([file, '/remove:d', EVERYONE]);
  };
}
