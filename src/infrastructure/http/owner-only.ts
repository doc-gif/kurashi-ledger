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
import { chmodSync, fchmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';

export type OwnerOnlyKind = 'file' | 'directory';
export type OwnerOnlyCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// PowerShellのスクリプト。$env:KURASHI_LEDGER_ACL_MODEがrestrict-*なら、所有者を実行中のユーザーにし（管理者として
// 動くと、作ったものの所有者がAdministratorsになることがあるため）、継承を切って実行中のユーザーだけを
// FullControlで許可するDACLに置き換えてから、読み直す。1行目に実行中のユーザーのSID、2行目にSDDL（所有者とDACL）を出す。
const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // 読むだけ（read）のときは、改行で区切った複数のパスを受け取り、1行に1つずつ出す（経路の祖先の検査）。
  '$paths = $env:KURASHI_LEDGER_ACL_PATH -split "`n"',
  '$p = $paths[0]',
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
  '$lines = @($user.Value)',
  'foreach ($p in $paths) {',
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
  "    if ($ace -is [System.Security.AccessControl.KnownAce]) { $mask = [string]$ace.AccessMask } else { $mask = '' }",
  "    $text += '(' + $kind + ';' + [string][int]$ace.AceFlags + ';' + $mask + ';;;' + $sid + ')'",
  '  }',
  '}',
  '$lines += $text',
  '}',
  '[Console]::Out.Write(($lines -join "`n"))',
].join('\n');

function powershellPath(): string {
  // PATHを使わず、Windowsに同梱のWindows PowerShell 5.1を絶対パスで呼ぶ（.NET FrameworkのACLのAPIを使うため）。
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

type WindowsSecurity = { readonly userSid: string; readonly sddl: string; readonly all: readonly string[] };

function runWindowsAcl(path: string | readonly string[], mode: 'read' | 'restrict-file' | 'restrict-directory'): WindowsSecurity {
  const paths = typeof path === 'string' ? [path] : path;
  if (paths.length === 0 || paths.some((p) => p.includes('\n'))) throw new Error('ACLを読むパスが不正。');
  const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
  const result = spawnSync(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, KURASHI_LEDGER_ACL_PATH: paths.join('\n'), KURASHI_LEDGER_ACL_MODE: mode },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.error !== undefined) throw new Error(`Windows PowerShellを起動できなかった（${result.error.message}）。`);
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split(/\r?\n/)[0] ?? '';
    throw new Error(`Windows PowerShellでACLを${mode === 'read' ? '読め' : '設定でき'}なかった（終了コード ${String(result.status)}: ${detail}）。`);
  }
  const [userSid = '', ...all] = (result.stdout ?? '').trim().split(/\r?\n/);
  if (!/^S-1-\d+(?:-\d+)+$/.test(userSid) || all.length !== paths.length || all.some((line) => line === '')) {
    throw new Error('Windows PowerShellの出力（SIDとSDDL）を読めない。');
  }
  return { userSid, sddl: all[0] ?? '', all };
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

// 開いた（作ったばかりの）ファイルを本人だけの権限にする（ADR-0009の3・4）。
// - POSIX: 開いたハンドルにfchmod(0600)するだけで、パスでは変えない。macOSの拡張ACLは、確かめた本人専用の
//   ディレクトリ（ほかのユーザーへのallowのエントリがない）の中で作るので、継承しうるのはdenyと本人へのallowだけで、
//   消す必要がない（呼び出し側が、パスで読んで確かめる）。
// - Windows: Node.jsからハンドルにACLを設定できないので、パスで設定する。呼び出し側が、直前にパスのファイルが
//   開いたものと同じことを確かめる。確かめてから設定するまでの短い間の、同じユーザー・管理者による差し替えは
//   保証しない（ADR-0003の「この境界で守らないもの」）。
export function restrictOpenFileToOwner(fd: number, path: string): void {
  if (process.platform === 'win32') {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} はリンクなので、権限を変えない。`);
    runWindowsAcl(path, 'restrict-file');
    return;
  }
  fchmodSync(fd, 0o600);
}

// 直し方の案内（利用者がディレクトリを用意するとき）。
export function ownerOnlyDirectoryHint(path: string): string {
  return process.platform === 'win32'
    ? `PowerShellで icacls "${path}" /setowner "\${env:USERNAME}" と icacls "${path}" /inheritance:r /grant:r "\${env:USERNAME}:(OI)(CI)F" を実行し、所有者を本人にして本人だけに許可する。`
    : process.platform === 'darwin'
      ? `chmod 700 "${path}" と、ほかのユーザーを許可する拡張ACLがあれば chmod -N "${path}" で、本人だけの権限にする（新しく作るなら mkdir -m 700）。`
      : `chmod 700 "${path}" で本人だけの権限にする（新しく作るなら mkdir -m 700）。`;
}

// ---- 経路の検査（ADR-0009の3・4、PR25-R005）----
// 渡されたディレクトリの実体パスの、どの要素（末端と、そこからルートまでのすべての祖先）も、ほかの一般のユーザーが
// 差し替え（名前の変更・削除してリンクを置く等）できないことを確かめる。管理者（root・Administrators・SYSTEM・
// TrustedInstaller）と、実行中のユーザー自身は、この境界の外（ADR-0003の「この境界で守らないもの」）。

// macOSの拡張ACLで、エントリの名前や内容を変えられる権限。
const MAC_MODIFYING = ['delete', 'delete_child', 'add_file', 'add_subdirectory', 'write', 'append', 'writesecurity', 'chown'];

// 祖先のディレクトリの`ls -led`の出力を判定する。ほかのユーザーに変更の権限を許すallowのエントリがあれば拒否する
// （読取りだけの許可は、差し替えにつながらないので許す）。
export function evaluateMacAncestorAcl(output: string, userName: string): OwnerOnlyCheck {
  const [first = '', ...rest] = output.replace(/\r/g, '').split('\n').filter((line) => line !== '');
  const mode = first.split(' ')[0] ?? '';
  if (!/^[-dlbcps][-rwxsStT]{9}[+@.]?$/.test(mode)) return { ok: false, reason: 'ACLを読めない（lsの出力の形が違う）。' };
  if (!mode.endsWith('+')) return { ok: true };
  for (const line of rest) {
    const entry = /^\s*\d+: (\S+) (?:inherited )?(allow|deny) (\S+)$/.exec(line);
    if (entry === null) return { ok: false, reason: `読めないACLのエントリがある（${line.trim()}）。` };
    if (entry[2] !== 'allow' || entry[1] === `user:${userName}`) continue;
    const perms = (entry[3] ?? '').split(',');
    if (perms.some((perm) => MAC_MODIFYING.includes(perm))) {
      return { ok: false, reason: `ほかのユーザー（${entry[1] ?? ''}）に変更を許す拡張ACLのエントリがある。` };
    }
  }
  return { ok: true };
}

export type PosixEntry = { readonly path: string; readonly uid: number; readonly mode: number };

// POSIXのモードと所有者で判定する。entriesは末端からルートへの順。各要素の所有者がrootか実行中のユーザーで、
// 末端以外の要素（親）がグループ・ほかのユーザーに書込みを許すなら、stickyのbitがあり、その子の所有者がrootか
// 実行中のユーザーであること（stickyのディレクトリでは、子の名前を変えられるのは子・親の所有者とrootだけ）。
export function evaluatePosixChain(entries: readonly PosixEntry[], uid: number): OwnerOnlyCheck {
  for (const [i, entry] of entries.entries()) {
    if (entry.uid !== 0 && entry.uid !== uid) return { ok: false, reason: `経路の ${entry.path} の所有者（uid ${entry.uid}）がrootでも実行中のユーザーでもない。` };
    if (i === 0) continue;
    if ((entry.mode & 0o022) === 0) continue;
    const child = entries[i - 1];
    const sticky = (entry.mode & 0o1000) !== 0;
    if (!sticky || child === undefined || (child.uid !== 0 && child.uid !== uid)) {
      return { ok: false, reason: `経路の ${entry.path} は、ほかのユーザーも書き込める（stickyなし、または子の所有者が違う）ので、その中の名前を差し替えられる。` };
    }
  }
  return { ok: true };
}

const TRUSTED_WINDOWS_SIDS = new Set([
  'S-1-5-18', // SYSTEM
  'S-1-5-32-544', // Administrators
  'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464', // TrustedInstaller
]);
const DELETE = 0x00010000;
const WRITE_DAC = 0x00040000;
const WRITE_OWNER = 0x00080000;
const GENERIC_ALL = 0x10000000;
const FILE_DELETE_CHILD = 0x00000040;
const INHERIT_ONLY = 0x08;

// Windowsの経路の判定。sddlsは末端からルートへの順で、各要素の「O:<SID>D:(<種類>;<フラグの数>;<権限の数>;;;<SID>)…」。
// 各要素の所有者が信頼するSID（実行中のユーザー・SYSTEM・Administrators・TrustedInstaller）で、継承専用でない
// Allowのエントリが、信頼しないSIDに、その要素の削除・DACLや所有者の変更（DELETE・WRITE_DAC・WRITE_OWNER・
// GENERIC_ALL）を許さず、親（末端以外）では子の削除（FILE_DELETE_CHILD）も許さないこと。
export function evaluateWindowsChain(sddls: readonly string[], paths: readonly string[], userSid: string): OwnerOnlyCheck {
  const trusted = (sid: string): boolean => sid === userSid || TRUSTED_WINDOWS_SIDS.has(sid);
  for (const [i, sddl] of sddls.entries()) {
    const path = paths[i] ?? '';
    const owner = /^O:([^:()]+?)(?=[GDS]:)/.exec(sddl)?.[1];
    if (owner === undefined || !trusted(owner)) return { ok: false, reason: `経路の ${path} の所有者（${owner ?? '不明'}）を信頼できない。` };
    const dacl = /D:([^()]*)((?:\([^()]*\))*)$/.exec(sddl);
    if (dacl === null || (dacl[1] ?? '').includes('NO_ACCESS_CONTROL')) return { ok: false, reason: `経路の ${path} のDACLがない、または読めない。` };
    const forbidden = DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL | (i > 0 ? FILE_DELETE_CHILD : 0);
    for (const m of (dacl[2] ?? '').matchAll(/\(([^()]*)\)/g)) {
      const [type = '', flags = '', mask = '', , , sid = ''] = (m[1] ?? '').split(';');
      if (type === 'D') continue;
      if (type !== 'A') return { ok: false, reason: `経路の ${path} に、判定で扱わない種類のACLのエントリ（${type}）がある。` };
      if ((Number(flags) & INHERIT_ONLY) !== 0 || trusted(sid)) continue;
      const rights = Number(mask) >>> 0;
      if (!/^-?\d+$/.test(mask) || (rights & forbidden) !== 0) {
        return { ok: false, reason: `経路の ${path} で、ほかのユーザー（${sid}）に差し替えにつながる権限がある。` };
      }
    }
  }
  return { ok: true };
}

// pathsは、末端（渡されたディレクトリの実体パス）からルートまでの順。どれもリンクでないディレクトリであること。
export function checkPathNotReplaceable(paths: readonly string[]): OwnerOnlyCheck {
  for (const path of paths) {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: `経路の ${path} がリンク、またはディレクトリでない。` };
  }
  if (process.platform === 'win32') {
    const { userSid, all } = runWindowsAcl(paths, 'read');
    return evaluateWindowsChain(all, paths, userSid);
  }
  const uid = process.getuid?.() ?? -1;
  const posix = evaluatePosixChain(paths.map((path) => {
    const st = lstatSync(path);
    return { path, uid: st.uid, mode: st.mode };
  }), uid);
  if (!posix.ok || process.platform !== 'darwin') return posix;
  for (const path of paths.slice(1)) {
    const result = spawnSync('/bin/ls', ['-led', '--', path], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 30_000 });
    if (result.error !== undefined || result.status !== 0) return { ok: false, reason: `経路の ${path} のACLを読めなかった。` };
    const check = evaluateMacAncestorAcl(result.stdout, userInfo().username);
    if (!check.ok) return { ok: false, reason: `経路の ${path}: ${check.reason}` };
  }
  return { ok: true };
}
