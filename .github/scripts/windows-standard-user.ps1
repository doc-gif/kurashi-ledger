# Windowsの一般のユーザー（管理者でない）で試験を実行するCIの補助（Issue #19、.github/workflows/ci.yml の
# windows-standard-user）。workflowからは、中身をscriptblockとして読み込んで呼ぶ（ファイルを実行しないので、
# 実行ポリシーは関係しない・変えない）。Windows PowerShell 5.1で動かす。表示する文字列は英語にする
# （5.1はスクリプトの文字コードを決め打ちできないため）。
#
#   -Action Run     : 一時のローカルユーザー（Usersだけ）を作り、そのユーザーとしてログオンして（Start-Process
#                     -Credential）run.mjsを起動する。-Mode testsはnpm testと同じ試験、-Mode hangは自己試験用の
#                     止まらない処理（子と孫を残す）。時間切れなら、そのユーザーのすべてのプロセスを止めて、
#                     -OutputDirにtimed-outのファイルを置いて戻る（失敗の判断は呼び出し側）。パスワードは乱数で、
#                     表示もファイルへの保存もしない。
# 失敗は例外で知らせる。scriptblockとして呼ぶので、exitは使わない（呼び出し側のPowerShellごと終わるため）。
#   -Action Cleanup : そのユーザーのすべてのプロセスを止め、なくなるまで待ってから、ユーザーとプロファイルを消す。
#                     プロセス・ユーザー・プロファイルのどれかが残れば失敗にする（成否にかかわらず最後に呼ぶ）。
param(
  [Parameter(Mandatory = $true)][ValidateSet('Run', 'Cleanup')][string]$Action,
  [Parameter(Mandatory = $true)][string]$UserName,
  [string]$OutputDir,
  [ValidateSet('tests', 'hang')][string]$Mode = 'tests',
  [int]$TimeoutSeconds = 900
)
$ErrorActionPreference = 'Stop'

function Get-UserProcesses([string]$name) {
  @(Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -and $_.UserName.EndsWith("\$name", [System.StringComparison]::OrdinalIgnoreCase) })
}

# そのユーザーのすべてのプロセスを止め、なくなるまで待つ。残った数を返す。
function Stop-UserProcesses([string]$name, [int]$seconds = 60) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ($true) {
    $processes = Get-UserProcesses $name
    if ($processes.Count -eq 0) { return 0 }
    if ((Get-Date) -gt $deadline) { return $processes.Count }
    foreach ($p in $processes) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
  }
}

function Add-Summary([string[]]$lines) {
  [System.IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, (($lines + '') -join "`n") + "`n")
}

if ($Action -eq 'Cleanup') {
  $problems = @()
  $user = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
  $sid = if ($null -ne $user) { $user.SID.Value } else { $null }
  $left = Stop-UserProcesses $UserName
  if ($left -gt 0) { $problems += "$left process(es) of the user are still running" }
  if ($null -ne $user) { Remove-LocalUser -Name $UserName }
  if ($null -ne (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue)) { $problems += 'the user still exists' }
  if ($null -ne $sid) {
    # プロファイルは、プロセスがなくなってから読み込みが外れるまで消せないことがあるので、少し待ってやり直す。
    $deadline = (Get-Date).AddSeconds(60)
    while ($true) {
      $profiles = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid })
      if ($profiles.Count -eq 0) { break }
      if ((Get-Date) -gt $deadline) { $problems += "the profile still exists ($($profiles[0].LocalPath))"; break }
      foreach ($p in $profiles) { Remove-CimInstance -InputObject $p -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 2
    }
  }
  Add-Summary @("### Cleanup of the temporary standard user", '', "- Processes, user and profile removed: $($problems.Count -eq 0)")
  if ($problems.Count -gt 0) { throw ('cleanup failed: ' + ($problems -join '; ')) }
  Write-Host 'The temporary user, its processes and its profile are gone.'
  return
}

# ---- Run
if ([string]::IsNullOrEmpty($OutputDir)) { throw '-OutputDir is required for Run' }
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$node = (Get-Command node).Source
if ($Mode -eq 'tests') {
  # npm testと同じ対象（package.jsonのtestのscript）を、npmを通さずにnode --testで実行する。
  $script = (Get-Content -Raw package.json | ConvertFrom-Json).scripts.test
  if ($script -notmatch '^node --test ("[^"]+" ?)+$') { throw "cannot read the test script of package.json: $script" }
  $testArguments = $script.Substring('node '.Length)
} else {
  # 自己試験: 子と孫を残して止まらない処理（時間切れの後始末を確かめる）。
  $testArguments = '-e "require(''child_process'').spawn(process.execPath, [''-e'', ''setInterval(() => {}, 1000)''], { stdio: ''ignore'' }); setInterval(() => {}, 1000)"'
}
# 実行するユーザーに書込みを許すのは、出力のディレクトリだけ（一時ファイルは自分のプロファイルに置く）。
[System.IO.File]::WriteAllText((Join-Path $OutputDir 'run.mjs'), @'
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [dir, ...args] = process.argv.slice(2);
const groups = spawnSync('whoami', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
// ファイルのsymlinkを作れるか（作れなければ、install-record.test.tsは弱めて確かめ、diagnosticを出す）。
const probe = mkdtempSync(join(tmpdir(), 'kl-symlink-'));
let symlink = true;
try { writeFileSync(join(probe, 'target'), ''); symlinkSync(join(probe, 'target'), join(probe, 'link'), 'file'); } catch { symlink = false; }
rmSync(probe, { recursive: true, force: true });
const out = openSync(join(dir, 'npm-test.txt'), 'w');
const run = spawnSync(process.execPath, args, { stdio: ['ignore', out, out] });
closeSync(out);
writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: run.status, signal: run.signal, error: run.error?.message ?? null, groups: groups.stdout ?? '', symlink }));
'@)

# 乱数のパスワード。表示もファイルへの保存もせず、ユーザーの作成と起動に渡すだけ。
$bytes = New-Object byte[] 48
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$plain = [Convert]::ToBase64String($bytes) + 'aA1!'
[Array]::Clear($bytes, 0, $bytes.Length)
New-LocalUser -Name $UserName -Password (ConvertTo-SecureString $plain -AsPlainText -Force) -PasswordNeverExpires -AccountNeverExpires -Description 'Temporary standard user for CI' | Out-Null
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $UserName
icacls $OutputDir /grant "$($UserName):(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
# 試験を読むためにworkspaceを読めるようにする（継承するACEとして加え、下の階層にも効かせる）。
icacls $env:GITHUB_WORKSPACE /grant "$($UserName):(OI)(CI)RX" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
$arguments = '"' + (Join-Path $OutputDir 'run.mjs') + '" "' + $OutputDir + '" ' + $testArguments
# そのユーザーとしてログオンして起動する（CreateProcessWithLogonW。プロファイルを読み込む）。
$credential = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$UserName", (ConvertTo-SecureString $plain -AsPlainText -Force))
Remove-Variable plain
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $env:GITHUB_WORKSPACE -Credential $credential -LoadUserProfile -WindowStyle Hidden -PassThru
Remove-Variable credential
$handle = $process.Handle
$output = Join-Path $OutputDir 'npm-test.txt'
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
  if (Test-Path $output) { Get-Content -Encoding UTF8 $output }
  # run.mjsだけでなく、node --testとその子孫を含む、そのユーザーのすべてのプロセスを止める。
  $left = Stop-UserProcesses $UserName
  Write-Host "Timed out after $TimeoutSeconds s; processes of the user left after stopping: $left"
  [System.IO.File]::WriteAllText((Join-Path $OutputDir 'timed-out'), [string]$left)
  return
}
$result = Join-Path $OutputDir 'result.json'
if (-not (Test-Path $result)) {
  if (Test-Path $output) { Get-Content -Encoding UTF8 $output }
  throw "the runner ended without writing the result (exit code $($process.ExitCode))"
}
Get-Content -Encoding UTF8 $output
$r = Get-Content -Raw $result | ConvertFrom-Json
# 管理者でないこと: 整合性レベルがMedium（S-1-16-8192）で、High以上がなく、Administrators（S-1-5-32-544）を含まない。
$standard = ($r.groups -match 'S-1-16-8192') -and ($r.groups -notmatch 'S-1-16-12288|S-1-16-16384') -and ($r.groups -notmatch 'S-1-5-32-544')
Add-Summary @(
  "### Run as a temporary Windows standard user ($Mode)"
  ''
  "- Not an administrator (Medium integrity, no Administrators group): $standard"
  "- Exit code of node: $($r.status) (signal: $($r.signal), start error: $($r.error))"
  "- The user can create file symlinks: $($r.symlink)"
)
if (-not $standard) { throw 'the tests did not run as a standard (non-administrator) user' }
if ($r.status -ne 0) { throw "the tests failed as the standard user (exit code $($r.status))" }
