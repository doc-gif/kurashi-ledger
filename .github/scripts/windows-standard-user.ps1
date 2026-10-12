# Windowsの一般のユーザー（管理者でない）で試験を実行するCIの補助（Issue #19、.github/workflows/ci.yml の
# windows-standard-user）。workflowからは、中身をscriptblockとして読み込んで呼ぶ（ファイルを実行しないので、
# 実行ポリシーは関係しない・変えない）。Windows PowerShell 5.1で動かす。表示する文字列は英語にする
# （5.1はスクリプトの文字コードを決め打ちできないため）。失敗は例外で知らせる（scriptblockとして呼ぶので、
# exitは使わない。呼び出し側のPowerShellごと終わるため）。
#
#   -Action Run      : 一時のローカルユーザー（Usersだけ）を作り、SIDをRUNNER_TEMPのファイルに残してから、
#                      そのユーザーとしてログオンして（Start-Process -Credential）run.mjsを起動する。-Mode testsは
#                      npm testと同じ試験、-Mode hangは止まらない合成の処理（親run.mjs・子・孫）。時間切れなら、
#                      止める前のそのユーザーのプロセスを記録してから全部を止め、-OutputDirのtimed-out.jsonに
#                      止める前と後を書いて戻る。全部の終了を確かめられなければ失敗にする。
#   -Action Cleanup  : そのユーザーのすべてのプロセスを止め、全部の終了を確かめてから、ユーザーとプロファイルを消す。
#                      終了を確かめられない（列挙の失敗・時間内に残る）ときは、何も消さずに失敗にする。ユーザーが
#                      もうなければ、残したSIDでプロファイルを探す。全部消せたときだけSIDのファイルを消す。
#   -Action SelfTest : 上の2つの、成功と失敗の経路を確かめる（PR33-R002）。
#   -InjectFailure   : 試験用。enumerate（列挙の失敗）・stop（停止の失敗）・profile（プロファイルの削除の失敗）。
# パスワードは乱数で、表示もファイルへの保存もしない。
param(
  [Parameter(Mandatory = $true)][ValidateSet('Run', 'Cleanup', 'SelfTest')][string]$Action,
  [Parameter(Mandatory = $true)][string]$UserName,
  [string]$OutputDir,
  [ValidateSet('tests', 'hang')][string]$Mode = 'tests',
  [int]$TimeoutSeconds = 900,
  [ValidateSet('none', 'enumerate', 'stop', 'profile')][string]$InjectFailure = 'none',
  [int]$StopTimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'

function Get-SidFile([string]$name) { Join-Path $env:RUNNER_TEMP "kl-standard-user-$name.sid" }

function Add-Summary([string[]]$lines) {
  [System.IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, (($lines + '') -join "`n") + "`n")
}

# そのユーザーのプロセス。列挙に失敗したら例外にする（「0件」と区別する）。
function Get-UserProcesses([string]$name, [string]$sid, [string]$inject) {
  if ($inject -eq 'enumerate') { throw 'could not enumerate processes (injected failure)' }
  try {
    $all = @(Get-Process -IncludeUserName -ErrorAction Stop)
  } catch {
    throw "could not enumerate processes: $($_.Exception.Message)"
  }
  @($all | Where-Object {
      $_.UserName -and ($_.UserName.EndsWith("\$name", [System.StringComparison]::OrdinalIgnoreCase) -or ($sid -and $_.UserName -eq $sid))
    })
}

# そのユーザーのすべてのプロセスを止め、なくなるまで待つ。残った数を返す（列挙の失敗は例外のまま）。
function Stop-UserProcesses([string]$name, [string]$sid, [string]$inject, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ($true) {
    $processes = Get-UserProcesses $name $sid $inject
    if ($processes.Count -eq 0) { return 0 }
    if ((Get-Date) -gt $deadline) { return $processes.Count }
    if ($inject -ne 'stop') {
      foreach ($p in $processes) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Milliseconds 500
  }
}

function Get-ProfileSid([string]$name) {
  $user = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
  if ($null -ne $user) { return $user.SID.Value }
  $file = Get-SidFile $name
  if (Test-Path $file) { return ([System.IO.File]::ReadAllText($file)).Trim() }
  return $null
}

function Invoke-Cleanup([string]$name, [string]$inject) {
  $sid = Get-ProfileSid $name
  # 全部の終了を確かめられなければ、何も消さずに失敗にする。
  $left = Stop-UserProcesses $name $sid $inject $StopTimeoutSeconds
  if ($left -gt 0) { throw "$left process(es) of the user are still running; the user and the profile were not removed" }
  if ($null -ne (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) { Remove-LocalUser -Name $name }
  if ($null -ne (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) { throw 'the user still exists' }
  if ($null -ne $sid) {
    # プロファイルは、プロセスがなくなってから読み込みが外れるまで消せないことがあるので、少し待ってやり直す。
    $deadline = (Get-Date).AddSeconds(60)
    while ($true) {
      $profiles = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid })
      if ($profiles.Count -eq 0) { break }
      if ($inject -eq 'profile') { throw 'the profile still exists (injected failure)' }
      if ((Get-Date) -gt $deadline) { throw "the profile still exists ($($profiles[0].LocalPath))" }
      foreach ($p in $profiles) { Remove-CimInstance -InputObject $p -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 2
    }
  }
  $file = Get-SidFile $name
  if (Test-Path $file) { Remove-Item -LiteralPath $file }
  Write-Host 'The temporary user, its processes and its profile are gone.'
}

function Invoke-Run([string]$name, [string]$dir, [string]$mode, [int]$timeout, [string]$inject) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $node = (Get-Command node).Source
  if ($mode -eq 'tests') {
    # npm testと同じ対象（package.jsonのtestのscript）を、npmを通さずにnode --testで実行する。
    $script = (Get-Content -Raw package.json | ConvertFrom-Json).scripts.test
    if ($script -notmatch '^node --test ("[^"]+" ?)+$') { throw "cannot read the test script of package.json: $script" }
    $testArguments = $script.Substring('node '.Length)
  } else {
    # 止まらない合成の処理: 子（node -e）が孫を起動し、どちらも止まらない。
    $testArguments = '-e "require(''child_process'').spawn(process.execPath, [''-e'', ''setInterval(() => {}, 1000)''], { stdio: ''ignore'' }); setInterval(() => {}, 1000)"'
  }
  # 実行するユーザーに書込みを許すのは、出力のディレクトリだけ（一時ファイルは自分のプロファイルに置く）。
  [System.IO.File]::WriteAllText((Join-Path $dir 'run.mjs'), @'
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
  $user = New-LocalUser -Name $name -Password (ConvertTo-SecureString $plain -AsPlainText -Force) -PasswordNeverExpires -AccountNeverExpires -Description 'Temporary standard user for CI'
  # 後始末をやり直すときに、ユーザーを消したあとでもプロファイルを探せるよう、SIDを残す。
  [System.IO.File]::WriteAllText((Get-SidFile $name), $user.SID.Value)
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name
  icacls $dir /grant "$($name):(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
  # 試験を読むためにworkspaceを読めるようにする（継承するACEとして加え、下の階層にも効かせる）。
  icacls $env:GITHUB_WORKSPACE /grant "$($name):(OI)(CI)RX" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
  $arguments = '"' + (Join-Path $dir 'run.mjs') + '" "' + $dir + '" ' + $testArguments
  # そのユーザーとしてログオンして起動する（CreateProcessWithLogonW。プロファイルを読み込む）。
  $credential = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$name", (ConvertTo-SecureString $plain -AsPlainText -Force))
  Remove-Variable plain
  $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $env:GITHUB_WORKSPACE -Credential $credential -LoadUserProfile -WindowStyle Hidden -PassThru
  Remove-Variable credential
  $handle = $process.Handle
  $output = Join-Path $dir 'npm-test.txt'
  if (-not $process.WaitForExit($timeout * 1000)) {
    if (Test-Path $output) { Get-Content -Encoding UTF8 $output }
    # 止める前のそのユーザーのプロセスを記録してから、node --testとその子孫を含めて全部を止める。
    $sid = $user.SID.Value
    $before = @(Get-UserProcesses $name $sid $inject | ForEach-Object { $_.ProcessName })
    $left = Stop-UserProcesses $name $sid $inject $StopTimeoutSeconds
    $record = @{ before = $before.Count; names = $before; after = $left } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText((Join-Path $dir 'timed-out.json'), $record)
    Write-Host "Timed out after $timeout s; processes of the user before stopping: $($before.Count) ($($before -join ', ')); after: $left"
    if ($left -gt 0) { throw "could not stop every process of the user ($left left)" }
    return
  }
  $result = Join-Path $dir 'result.json'
  if (-not (Test-Path $result)) {
    if (Test-Path $output) { Get-Content -Encoding UTF8 $output }
    throw "the runner ended without writing the result (exit code $($process.ExitCode))"
  }
  Get-Content -Encoding UTF8 $output
  $r = Get-Content -Raw $result | ConvertFrom-Json
  # 管理者でないこと: 整合性レベルがMedium（S-1-16-8192）で、High以上がなく、Administrators（S-1-5-32-544）を含まない。
  $standard = ($r.groups -match 'S-1-16-8192') -and ($r.groups -notmatch 'S-1-16-12288|S-1-16-16384') -and ($r.groups -notmatch 'S-1-5-32-544')
  Add-Summary @(
    "### Run as a temporary Windows standard user ($mode)"
    ''
    "- Not an administrator (Medium integrity, no Administrators group): $standard"
    "- Exit code of node: $($r.status) (signal: $($r.signal), start error: $($r.error))"
    "- The user can create file symlinks: $($r.symlink)"
  )
  if (-not $standard) { throw 'the tests did not run as a standard (non-administrator) user' }
  if ($r.status -ne 0) { throw "the tests failed as the standard user (exit code $($r.status))" }
}

# 失敗するはずの処理を実行し、成功と報告したら失敗にする。
function Assert-Fails([string]$what, [scriptblock]$block) {
  $failed = $false
  try { & $block } catch { $failed = $true; Write-Host "$what failed as expected: $($_.Exception.Message)" }
  if (-not $failed) { throw "$what reported success" }
}

function Assert-True([bool]$condition, [string]$what) {
  if (-not $condition) { throw "self-test: $what" }
  Write-Host "ok: $what"
}

function Get-NodeCount([string]$name) { @(Get-UserProcesses $name $null 'none' | Where-Object { $_.ProcessName -eq 'node' }).Count }

function Invoke-SelfTest([string]$name, [string]$dir) {
  # 1. 成功の経路: 止める前に親・子・孫（node 3つ以上）が動いていて、止めたあと0件。後始末は何も残さない。
  $first = Join-Path $dir 'stop'
  Invoke-Run $name $first 'hang' 20 'none'
  $record = Get-Content -Raw (Join-Path $first 'timed-out.json') | ConvertFrom-Json
  $nodes = @($record.names | Where-Object { $_ -eq 'node' }).Count
  Assert-True ($nodes -ge 3) "before stopping, node processes of the user were alive: $nodes ($($record.names -join ', '))"
  Assert-True ($record.after -eq 0) "after stopping, no process of the user is left ($($record.after))"
  Invoke-Cleanup $name 'none'
  Assert-True ($null -eq (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) 'the user was removed'
  Assert-True (-not (Test-Path (Get-SidFile $name))) 'the SID file was removed after a full cleanup'

  # 2. 失敗の経路。停止の失敗では、時間切れの処理が失敗し、プロセスが残る。
  $second = Join-Path $dir 'failures'
  Assert-Fails 'Run with the stop failure' { Invoke-Run $name $second 'hang' 20 'stop' }
  $sid = (Get-LocalUser -Name $name).SID.Value
  Assert-True ((Get-NodeCount $name) -ge 3) 'the processes are still alive after the stop failure'
  # 列挙の失敗・停止の失敗では、後始末は失敗し、ユーザーを消さない。
  Assert-Fails 'Cleanup with the enumeration failure' { Invoke-Cleanup $name 'enumerate' }
  Assert-True ($null -ne (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) 'the user is kept after the enumeration failure'
  Assert-Fails 'Cleanup with the stop failure' { Invoke-Cleanup $name 'stop' }
  Assert-True ($null -ne (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) 'the user is kept after the stop failure'
  # プロファイルの削除の失敗では、後始末は失敗し、プロファイルとSIDのファイルが残る。
  Assert-Fails 'Cleanup with the profile failure' { Invoke-Cleanup $name 'profile' }
  Assert-True ($null -eq (Get-LocalUser -Name $name -ErrorAction SilentlyContinue)) 'the user was removed before the profile failure'
  Assert-True (@(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }).Count -gt 0) 'the profile is left after the profile failure'
  Assert-True (Test-Path (Get-SidFile $name)) 'the SID file is kept after the profile failure'
  # やり直した後始末は、残したSIDでプロファイルを見つけて消す。
  Invoke-Cleanup $name 'none'
  Assert-True (@(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid }).Count -eq 0) 'the re-run cleanup removed the left profile by its SID'
  Assert-True (-not (Test-Path (Get-SidFile $name))) 'the SID file was removed after the re-run cleanup'
  Add-Summary @('### Self-test of the standard-user cleanup', '', "- Before stopping: $($record.before) process(es) ($($record.names -join ', ')); after: $($record.after)", '- Enumeration, stop and profile failures were reported as failures; a re-run cleanup removed the left profile')
}

switch ($Action) {
  'Run' {
    if ([string]::IsNullOrEmpty($OutputDir)) { throw '-OutputDir is required for Run' }
    Invoke-Run $UserName $OutputDir $Mode $TimeoutSeconds $InjectFailure
  }
  'Cleanup' {
    Invoke-Cleanup $UserName $InjectFailure
    Add-Summary @('### Cleanup of the temporary standard user', '', '- Processes, user and profile removed: True')
  }
  'SelfTest' {
    if ([string]::IsNullOrEmpty($OutputDir)) { throw '-OutputDir is required for SelfTest' }
    Invoke-SelfTest $UserName $OutputDir
  }
}
