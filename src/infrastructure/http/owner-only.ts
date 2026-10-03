// 本人だけが使える権限の確認と設定（ADR-0003の4、ADR-0009の「本人だけの権限」）。
// - POSIX（macOS・Linux）: lstatで調べ（リンクをたどらない）、所有者が実行中のユーザーで、グループとほかのユーザーの
//   権限のbitがないこと（ファイルは0600、ディレクトリは0700）。拡張ACL（macOSのACL、LinuxのPOSIX ACL）は見ない
//   （ADR-0009の「見ないもの」）。
// - Windows: 所有者が実行中のユーザーのSIDで、DACLがあり（NULLのDACLは拒否）、Allowのエントリ（継承専用を含む）が
//   実行中のユーザーのSIDだけで、Allow・Deny以外の種類のエントリがないこと。表示名はロケールで変わるので使わず、
//   SDDL（SIDの文字列）で判定する。読み書きはWindows PowerShell 5.1（Windowsに同梱）の.NETのAPIで行い、
//   パスは環境変数で渡す（コマンドの文字列に埋め込まない）。
// T07（データルートの権限）も同じ基準を使う（ADR-0006の1「権限」）。基準を変えるときは、ADR-0009と両方の試験を
// 同じPRで直す。
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export type OwnerOnlyKind = 'file' | 'directory';
export type OwnerOnlyCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// PowerShellのスクリプト。$env:KURASHI_LEDGER_ACL_MODEがrestrict-*なら、継承を切って実行中のユーザーだけを
// FullControlで許可するDACLに置き換えてから、読み直す。1行目に実行中のユーザーのSID、2行目にSDDL（所有者とDACL）を出す。
const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$p = $env:KURASHI_LEDGER_ACL_PATH',
  '$mode = $env:KURASHI_LEDGER_ACL_MODE',
  '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$full = [System.Security.AccessControl.FileSystemRights]::FullControl',
  '$allow = [System.Security.AccessControl.AccessControlType]::Allow',
  "if ($mode -eq 'restrict-file') {",
  '  $sec = New-Object System.Security.AccessControl.FileSecurity',
  '  $sec.SetAccessRuleProtection($true, $false)',
  '  $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($user, $full, $allow)))',
  '  [System.IO.File]::SetAccessControl($p, $sec)',
  "} elseif ($mode -eq 'restrict-directory') {",
  '  $sec = New-Object System.Security.AccessControl.DirectorySecurity',
  '  $sec.SetAccessRuleProtection($true, $false)',
  "  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
  '  $none = [System.Security.AccessControl.PropagationFlags]::None',
  '  $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($user, $full, $inherit, $none, $allow)))',
  '  [System.IO.Directory]::SetAccessControl($p, $sec)',
  '}',
  'if ([System.IO.Directory]::Exists($p)) { $acl = [System.IO.Directory]::GetAccessControl($p) } else { $acl = [System.IO.File]::GetAccessControl($p) }',
  "$sections = [System.Security.AccessControl.AccessControlSections]'Owner, Access'",
  '[Console]::Out.Write($user.Value + "`n" + $acl.GetSecurityDescriptorSddlForm($sections))',
].join('\n');

function powershellPath(): string {
  // PATHを使わず、Windowsに同梱のWindows PowerShell 5.1を絶対パスで呼ぶ（.NET FrameworkのACLのAPIを使うため）。
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

type WindowsSecurity = { readonly userSid: string; readonly sddl: string };

function runWindowsAcl(path: string, mode: 'read' | 'restrict-file' | 'restrict-directory'): WindowsSecurity {
  const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
  const result = spawnSync(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, KURASHI_LEDGER_ACL_PATH: path, KURASHI_LEDGER_ACL_MODE: mode },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.error !== undefined) throw new Error(`Windows PowerShellを起動できなかった（${result.error.message}）。`);
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split(/\r?\n/)[0] ?? '';
    throw new Error(`Windows PowerShellでACLを${mode === 'read' ? '読め' : '設定でき'}なかった（終了コード ${String(result.status)}: ${detail}）。`);
  }
  const [userSid = '', sddl = ''] = (result.stdout ?? '').trim().split(/\r?\n/);
  if (!/^S-1-\d+(?:-\d+)+$/.test(userSid) || sddl === '') throw new Error('Windows PowerShellの出力（SIDとSDDL）を読めない。');
  return { userSid, sddl };
}

// SDDL（所有者とDACLの部分）を、本人だけの基準で判定する。純粋な関数として試験できるように分けている。
// 形式: O:<SID>D:<フラグ>(<種類>;<フラグ>;<権限>;<GUID>;<継承GUID>;<SID>)…
export function evaluateWindowsSddl(sddl: string, userSid: string): OwnerOnlyCheck {
  const owner = /^O:([^:()]+?)(?=[GDS]:)/.exec(sddl);
  if (owner === null) return { ok: false, reason: '所有者を読めない。' };
  if (owner[1] !== userSid) return { ok: false, reason: `所有者（${owner[1] ?? ''}）が実行中のユーザーでない。` };
  const dacl = /D:([^()]*)((?:\([^()]*\))*)/.exec(sddl);
  if (dacl === null) return { ok: false, reason: 'DACLを読めない。' };
  if ((dacl[1] ?? '').includes('NO_ACCESS_CONTROL')) return { ok: false, reason: 'DACLがない（すべての人が使える）。' };
  const aces = [...(dacl[2] ?? '').matchAll(/\(([^()]*)\)/g)].map((m) => (m[1] ?? '').split(';'));
  for (const fields of aces) {
    const [type = '', , , , , sid = ''] = fields;
    if (fields.length < 6) return { ok: false, reason: `読めないACLのエントリがある（${fields.join(';')}）。` };
    if (type === 'D') continue; // 拒否のエントリは、権限を広げない。
    if (type !== 'A') return { ok: false, reason: `本人だけの判定で扱わない種類のACLのエントリ（${type}）がある。` };
    if (sid !== userSid) return { ok: false, reason: `実行中のユーザー以外（${sid}）を許可するACLのエントリがある。` };
  }
  return { ok: true };
}

function checkPosix(path: string, kind: OwnerOnlyKind): OwnerOnlyCheck {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return { ok: false, reason: 'リンクになっている。' };
  if (kind === 'directory' ? !st.isDirectory() : !st.isFile()) {
    return { ok: false, reason: kind === 'directory' ? 'ディレクトリでない。' : '通常のファイルでない。' };
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return { ok: false, reason: `所有者（uid ${st.uid}）が実行中のユーザー（uid ${uid}）でない。` };
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return { ok: false, reason: `権限（${mode.toString(8).padStart(3, '0')}）がグループやほかのユーザーにも許している。` };
  }
  return { ok: true };
}

// pathが本人だけの権限かを確かめる。リンク（symlink・junction）は、たどらずに拒否する。
export function checkOwnerOnly(path: string, kind: OwnerOnlyKind): OwnerOnlyCheck {
  if (process.platform !== 'win32') return checkPosix(path, kind);
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return { ok: false, reason: 'リンク（symlink・junction）になっている。' };
  if (kind === 'directory' ? !st.isDirectory() : !st.isFile()) {
    return { ok: false, reason: kind === 'directory' ? 'ディレクトリでない。' : '通常のファイルでない。' };
  }
  const { userSid, sddl } = runWindowsAcl(path, 'read');
  return evaluateWindowsSddl(sddl, userSid);
}

// pathを本人だけの権限にしてから、確かめ直す（POSIXはファイル0600・ディレクトリ0700、Windowsは継承を切って
// 実行中のユーザーだけを許可するDACL）。確かめ直しで外れていれば例外にする。リンクには使わない（呼び出し側が
// lstatで確かめた、自分で作ったものだけに使う）。
export function restrictToOwner(path: string, kind: OwnerOnlyKind): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} はリンクなので、権限を変えない。`);
  let check: OwnerOnlyCheck;
  if (process.platform === 'win32') {
    const { userSid, sddl } = runWindowsAcl(path, kind === 'file' ? 'restrict-file' : 'restrict-directory');
    check = evaluateWindowsSddl(sddl, userSid);
  } else {
    chmodSync(path, kind === 'file' ? 0o600 : 0o700);
    check = checkPosix(path, kind);
  }
  if (!check.ok) throw new Error(`${path} を本人だけの権限にできなかった: ${check.reason}`);
}

// 直し方の案内（利用者がディレクトリを用意するとき）。
export function ownerOnlyDirectoryHint(path: string): string {
  return process.platform === 'win32'
    ? `PowerShellで icacls "${path}" /inheritance:r /grant:r "\${env:USERNAME}:(OI)(CI)F" を実行し、本人だけに許可する。`
    : `chmod 700 "${path}" で本人だけの権限にする（新しく作るなら mkdir -m 700）。`;
}
