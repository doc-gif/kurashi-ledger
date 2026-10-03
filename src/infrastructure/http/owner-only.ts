// 本人だけが使える権限の確認と設定（ADR-0003の4、ADR-0009の「本人だけの権限」）。
// - POSIX（macOS・Linux）: lstatで調べ（リンクをたどらない）、所有者が実行中のユーザーで、グループとほかのユーザーの
//   権限のbitがないこと（ファイルは0600、ディレクトリは0700）。
//   - macOS: モードとは別の拡張ACLで、ほかのユーザーに許可できる（chmodのモードの変更ではACLは消えない）。
//     `ls -led`でACLのエントリを読み、実行中のユーザー以外へのallowのエントリがあれば拒否する。読めない行があっても
//     拒否する。作るものは`chmod -N`でACLを消してからモードを設定する。
//   - Linux: POSIX ACLがあると、モードのグループのbitがACLのmaskになり、名前付きのユーザー・グループのエントリは
//     maskで制限される。グループとほかのユーザーのbitが0なら、ACLがあっても本人以外は使えない（ADR-0009の4）。
// - Windows: 所有者が実行中のユーザーのSIDで、DACLがあり（NULLのDACLは拒否）、Allowのエントリ（継承専用を含む）が
//   実行中のユーザーのSIDだけで、Allow・Deny以外の種類のエントリがないこと。表示名はロケールで変わるので使わず、
//   セキュリティ記述子の2進の形から取り出したSIDで判定する。読み書きはWindows PowerShell 5.1（Windowsに同梱）の.NETのAPIで行い、
//   パスは環境変数で渡す（コマンドの文字列に埋め込まない）。
// T07（データルートの権限）も同じ基準を使う（ADR-0006の1「権限」）。基準を変えるときは、ADR-0009と両方の試験を
// 同じPRで直す。
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';

export type OwnerOnlyKind = 'file' | 'directory';
export type OwnerOnlyCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// PowerShellのスクリプト。$env:KURASHI_LEDGER_ACL_MODEがrestrict-*なら、所有者を実行中のユーザーにし（管理者として
// 動くと、作ったものの所有者がAdministratorsになることがあるため）、継承を切って実行中のユーザーだけを
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
  '  $sec.SetOwner($user)',
  '  $sec.SetAccessRuleProtection($true, $false)',
  '  $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($user, $full, $allow)))',
  '  [System.IO.File]::SetAccessControl($p, $sec)',
  "} elseif ($mode -eq 'restrict-directory') {",
  '  $sec = New-Object System.Security.AccessControl.DirectorySecurity',
  '  $sec.SetOwner($user)',
  '  $sec.SetAccessRuleProtection($true, $false)',
  "  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
  '  $none = [System.Security.AccessControl.PropagationFlags]::None',
  '  $sec.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($user, $full, $inherit, $none, $allow)))',
  '  [System.IO.Directory]::SetAccessControl($p, $sec)',
  '}',
  'if ([System.IO.Directory]::Exists($p)) { $acl = [System.IO.Directory]::GetAccessControl($p) } else { $acl = [System.IO.File]::GetAccessControl($p) }',
  // SDDLの文字列（GetSecurityDescriptorSddlForm）は、よく知られたアカウントを別名（組込みのAdministratorはLA等）で
  // 書くので、実行中のユーザーのSIDと比べられない。2進の形から、SIDだけで同じ形の文字列を組み立てる。
  '$raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)',
  "$text = 'O:' + $raw.Owner.Value + 'D:'",
  "if ($null -eq $raw.DiscretionaryAcl) { $text += 'NO_ACCESS_CONTROL' } else {",
  '  foreach ($ace in $raw.DiscretionaryAcl) {',
  '    $kind = $ace.AceType.ToString()',
  "    if ($kind -eq 'AccessAllowed') { $kind = 'A' } elseif ($kind -eq 'AccessDenied') { $kind = 'D' }",
  "    if ($ace -is [System.Security.AccessControl.KnownAce]) { $sid = $ace.SecurityIdentifier.Value } else { $sid = 'unknown' }",
  "    $text += '(' + $kind + ';;;;;' + $sid + ')'",
  '  }',
  '}',
  '[Console]::Out.Write($user.Value + "`n" + $text)',
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

// SDDLの形（所有者とDACLの部分）を、本人だけの基準で判定する。純粋な関数として試験できるように分けている。
// 形式: O:<SID>D:<フラグ>(<種類>;<フラグ>;<権限>;<GUID>;<継承GUID>;<SID>)…。Windowsでは、上のスクリプトが
// 別名を使わずにSIDだけで組み立てた同じ形の文字列を渡す（別名やほかのSIDは、実行中のユーザーでないとして拒否する）。
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

// macOSの`ls -led`の出力（1行目がモード等、2行目以降がACLのエントリ）を判定する。純粋な関数として試験できるように分けている。
// エントリの形: ` <番号>: <user:名前|group:名前|UUID> [inherited] <allow|deny> <権限>`。
export function evaluateMacAcl(output: string, userName: string): OwnerOnlyCheck {
  const [first = '', ...rest] = output.replace(/\r/g, '').split('\n').filter((line) => line !== '');
  const mode = first.split(' ')[0] ?? '';
  if (!/^[-dlbcps][-rwxsStT]{9}[+@.]?$/.test(mode)) return { ok: false, reason: 'ACLを読めない（lsの出力の形が違う）。' };
  if (!mode.endsWith('+')) return rest.length === 0 ? { ok: true } : { ok: false, reason: 'ACLを読めない（ACLの印がないのにエントリがある）。' };
  for (const line of rest) {
    const entry = /^\s*\d+: (\S+) (?:inherited )?(allow|deny) (\S+)$/.exec(line);
    if (entry === null) return { ok: false, reason: `読めないACLのエントリがある（${line.trim()}）。` };
    if (entry[2] === 'allow' && entry[1] !== `user:${userName}`) {
      return { ok: false, reason: `実行中のユーザー以外（${entry[1] ?? ''}）を許可する拡張ACLのエントリがある。` };
    }
  }
  return { ok: true };
}

function checkMacAcl(path: string): OwnerOnlyCheck {
  const result = spawnSync('/bin/ls', ['-led', '--', path], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 30_000 });
  if (result.error !== undefined || result.status !== 0) return { ok: false, reason: `ACLを読めなかった（${(result.stderr ?? '').trim()}）。` };
  return evaluateMacAcl(result.stdout, userInfo().username);
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
  if (process.platform === 'darwin') return checkMacAcl(path);
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

// pathを本人だけの権限にしてから、確かめ直す（POSIXはファイル0600・ディレクトリ0700でmacOSは拡張ACLも消す、Windowsは継承を切って
// 実行中のユーザーだけを許可するDACL）。確かめ直しで外れていれば例外にする。リンクには使わない（呼び出し側が
// lstatで確かめた、自分で作ったものだけに使う）。
export function restrictToOwner(path: string, kind: OwnerOnlyKind): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} はリンクなので、権限を変えない。`);
  let check: OwnerOnlyCheck;
  if (process.platform === 'win32') {
    const { userSid, sddl } = runWindowsAcl(path, kind === 'file' ? 'restrict-file' : 'restrict-directory');
    check = evaluateWindowsSddl(sddl, userSid);
  } else {
    if (process.platform === 'darwin') {
      const cleared = spawnSync('/bin/chmod', ['-N', path], { encoding: 'utf8', timeout: 30_000 });
      if (cleared.error !== undefined || cleared.status !== 0) throw new Error(`${path} の拡張ACLを消せなかった（${(cleared.stderr ?? '').trim()}）。`);
    }
    chmodSync(path, kind === 'file' ? 0o600 : 0o700);
    check = checkPosix(path, kind);
  }
  if (!check.ok) throw new Error(`${path} を本人だけの権限にできなかった: ${check.reason}`);
}

// 直し方の案内（利用者がディレクトリを用意するとき）。
export function ownerOnlyDirectoryHint(path: string): string {
  return process.platform === 'win32'
    ? `PowerShellで icacls "${path}" /setowner "\${env:USERNAME}" と icacls "${path}" /inheritance:r /grant:r "\${env:USERNAME}:(OI)(CI)F" を実行し、所有者を本人にして本人だけに許可する。`
    : process.platform === 'darwin'
      ? `chmod 700 "${path}" と、ほかのユーザーを許可する拡張ACLがあれば chmod -N "${path}" で、本人だけの権限にする（新しく作るなら mkdir -m 700）。`
      : `chmod 700 "${path}" で本人だけの権限にする（新しく作るなら mkdir -m 700）。`;
}
