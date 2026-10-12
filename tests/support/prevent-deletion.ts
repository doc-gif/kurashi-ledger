// 試験の中で、ディレクトリの直下のファイル1つを消せない状態にする補助（作業中の印を消せないときの試験。Issue #19）。
// - POSIX: ディレクトリを書込み禁止（0555）にする。rootのユーザーは権限を無視して消せるので、呼び出し側でskipする。
// - Windows: ほかのプロセスが、削除の共有を許さずに（FileShare.Readだけで）ファイルを開いたままにする。Windowsは、
//   開いているハンドルのどれかが削除の共有を許していなければ、削除を共有違反（EBUSY）で拒む。読み取りは許すので、
//   印の中身の照合はできる。Issue #19の手での確認と同じ方法で、権限の有無（管理者か）に左右されない。読取り専用の
//   属性はNode.jsが外して消すので使えず、削除を拒否するACEは、管理者で動くGitHubのWindowsのrunnerでは削除を
//   止められなかった（CIで確かめた）ので使わない。
//   開いたままにするのは、Windowsに同梱のWindows PowerShell 5.1（スクリプトは-EncodedCommand、パスは環境変数で渡す）。
// 呼び出し側が同期の処理の中から使えるよう、開き終わる・閉じ終わるまで同期で待つ。
// 戻り値の関数で元に戻す（試験の後始末で、ファイルとディレクトリを消せるようにする）。
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 開いてから合図のファイルを置き、解放の合図のファイルができる（または2分たつ）まで開いたままにする。
const HOLD_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "  $f = [System.IO.File]::Open($env:KL_HOLD_PATH, 'Open', 'Read', 'Read')",
  '} catch {',
  "  [System.IO.File]::WriteAllText($env:KL_HOLD_FAILED, $_.Exception.Message)",
  '  exit 1',
  '}',
  "[System.IO.File]::WriteAllText($env:KL_HOLD_READY, 'held')",
  '$deadline = (Get-Date).AddMinutes(2)',
  'while (-not [System.IO.File]::Exists($env:KL_HOLD_RELEASE) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 20 }',
  '$f.Close()',
  "[System.IO.File]::WriteAllText($env:KL_HOLD_CLOSED, 'closed')",
].join('\r\n');

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function waitSync(done: () => boolean, what: string): void {
  const deadline = Date.now() + 60_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(what);
    Atomics.wait(sleeper, 0, 0, 20);
  }
}

export function preventDeletion(dir: string, name: string): () => void {
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o555);
    return () => chmodSync(dir, 0o755);
  }
  const signals = mkdtempSync(join(tmpdir(), 'kl-hold-'));
  const files = {
    KL_HOLD_PATH: join(dir, name),
    KL_HOLD_READY: join(signals, 'ready'),
    KL_HOLD_FAILED: join(signals, 'failed'),
    KL_HOLD_RELEASE: join(signals, 'release'),
    KL_HOLD_CLOSED: join(signals, 'closed'),
  };
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  const holder = spawn(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(HOLD_SCRIPT, 'utf16le').toString('base64')],
    { env: { ...process.env, ...files }, stdio: 'ignore', windowsHide: true },
  );
  // 試験が途中で失敗しても、このプロセスの終了を妨げない（補助は2分で自分で閉じて終わる）。
  holder.unref();
  waitSync(() => existsSync(files.KL_HOLD_READY) || existsSync(files.KL_HOLD_FAILED), `${name}を開いたままにできなかった（時間切れ）`);
  if (existsSync(files.KL_HOLD_FAILED)) {
    const reason = readFileSync(files.KL_HOLD_FAILED, 'utf8');
    rmSync(signals, { recursive: true, force: true });
    throw new Error(`${name}を開いたままにできなかった: ${reason}`);
  }
  return () => {
    writeFileSync(files.KL_HOLD_RELEASE, '');
    waitSync(() => existsSync(files.KL_HOLD_CLOSED), `${name}を閉じられなかった（時間切れ）`);
    rmSync(signals, { recursive: true, force: true });
  };
}
