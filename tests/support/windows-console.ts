// Windowsで、試験の対象を新しいコンソールで起動し、実際のコンソールの制御イベント（Ctrl+C・Ctrl+Break）を送る補助
// （Issue #19）。Node.jsは、Windowsでほかのプロセスへコンソールの制御イベントを送れない（process.killは強制終了になる）。
// そこで、Windowsに同梱のWindows PowerShell 5.1から、.NETのP/InvokeでWin32のAPIを呼ぶ（依存を加えない。
// スクリプトは-EncodedCommandで渡し、設定は環境変数で渡すので、実行ポリシーは関係しない・変えない）。
// - CreateProcessW（CREATE_NEW_CONSOLE）で、対象を新しい見えないコンソールで起動する。試験のプロセスやCIのシェルとは
//   コンソールが別なので、制御イベントは対象のコンソールのプロセスにだけ届く。標準出力・標準エラーはファイルに書かせる。
//   起動の前にSetConsoleCtrlHandler(NULL, FALSE)で、Ctrl+Cを受け付ける状態を子に継がせる（無視する状態は継承される）。
// - 対象をジョブ オブジェクトに入れ、対象が起動した子・孫を含めて全部が終わるまで待つ（npm runのように、外側の
//   プロセスが先に終わっても、残ったプロセスの片付けを待てる）。補助が終わればジョブごと終わらせる（KILL_ON_JOB_CLOSE）。
// - 送るときは、自分のコンソールから離れ（FreeConsole）、対象のコンソールに付き（AttachConsole）、自分は制御イベントを
//   無視するハンドラを登録してから、GenerateConsoleCtrlEvent(イベント, 0)でコンソールの全員に送る。端末でCtrl+C・
//   Ctrl+Breakを押したときと同じく、同じコンソールのすべてのプロセスに届く。
// 試験からの要求はファイルで渡し（標準入力はPowerShellが読むことがあるので使わない）、補助は標準出力に1行ずつ返す。
// T26のnpm startの実際のCtrl+Cの試験（Windows）も、統合後にこの補助を使う。
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ConsoleEvent = 'ctrl-c' | 'ctrl-break';

export type ConsoleRunResult = {
  // 直接起動したプロセスの終了コード（時間切れならnull）。
  readonly status: number | null;
  // 直接起動したプロセスが終わった時点で、まだ動いていた子・孫の数（ジョブの中の数）。
  readonly remainingAtExit: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

export type ConsoleRun = {
  // 起動したプロセスの番号。
  readonly started: Promise<number>;
  // コンソールに制御イベントを送る。送り終えたら（GenerateConsoleCtrlEventが成功したら）解決する。
  send(event: ConsoleEvent): Promise<void>;
  // 起動したプロセスとその子・孫がすべて終わる（または時間切れでジョブごと終わらせる）と解決する。
  readonly done: Promise<ConsoleRunResult>;
  // 補助を強制終了する（ジョブの中のプロセスもOSが終わらせる）。試験の失敗時の後始末に使う。
  abort(): void;
};

// CreateProcessWに渡すコマンドラインを、CommandLineToArgvW（とNode.js・CランタイムのC:\の引数の読み方）の規則で組む。
// 空白・タブ・引用符を含む引数と空の引数は引用符で囲み、引用符の前の\の並びは2倍にしてから\"にする。
export function windowsCommandLine(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg !== '' && !/[\s"]/.test(arg)) return arg;
      let quoted = '"';
      let backslashes = 0;
      for (const ch of arg) {
        if (ch === '\\') {
          backslashes += 1;
          continue;
        }
        quoted += ch === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${ch}`;
        backslashes = 0;
      }
      return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
    })
    .join(' ');
}

// C# 5（Windows PowerShell 5.1のAdd-Typeが使うコンパイラ）の範囲で書く。
const CSHARP = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class KurashiLedgerConsole {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInformation { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct SecurityAttributes { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicAccounting {
    public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit {
    public BasicLimit BasicLimitInformation; public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  delegate bool CtrlHandler(uint ctrlType);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string fileName, uint desiredAccess, uint shareMode, ref SecurityAttributes securityAttributes,
    uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out BasicAccounting info, int length, IntPtr returnLength);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int stdHandle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(CtrlHandler handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);

  // 自分に届いた制御イベントを処理済みにして、補助自身は終わらない（GCされないよう静的に持つ）。
  static readonly CtrlHandler Ignore = delegate (uint ctrlType) { return true; };
  static readonly IntPtr Invalid = new IntPtr(-1);

  static void Say(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }
  static string Failure(string what) { return what + " failed (Win32 error " + Marshal.GetLastWin32Error() + ")"; }

  static string Setting(string name) {
    string value = Environment.GetEnvironmentVariable(name);
    if (String.IsNullOrEmpty(value)) throw new InvalidOperationException(name + " is not set");
    // 対象には渡さない（対象は補助の環境変数を受け継ぐ）。
    Environment.SetEnvironmentVariable(name, null);
    return value;
  }

  static IntPtr OpenForChild(string path, uint access, uint disposition) {
    SecurityAttributes inheritable = new SecurityAttributes();
    inheritable.nLength = Marshal.SizeOf(typeof(SecurityAttributes));
    inheritable.bInheritHandle = 1;
    IntPtr handle = CreateFileW(path, access, 3, ref inheritable, disposition, 0, IntPtr.Zero);
    if (handle == Invalid) throw new InvalidOperationException(Failure("CreateFileW"));
    return handle;
  }

  static uint Active(IntPtr job) {
    BasicAccounting info;
    if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(BasicAccounting)), IntPtr.Zero)) return UInt32.MaxValue;
    return info.ActiveProcesses;
  }

  static string Send(uint processId, string kind) {
    uint ctrlEvent;
    if (kind == "ctrl-c") ctrlEvent = 0; else if (kind == "ctrl-break") ctrlEvent = 1; else return "unknown event " + kind;
    FreeConsole();
    if (!AttachConsole(processId)) return Failure("AttachConsole");
    try {
      if (!SetConsoleCtrlHandler(Ignore, true)) return Failure("SetConsoleCtrlHandler");
      if (!GenerateConsoleCtrlEvent(ctrlEvent, 0)) return Failure("GenerateConsoleCtrlEvent");
      Thread.Sleep(200);
      return null;
    } finally {
      FreeConsole();
    }
  }

  public static int Run() {
    string commandLine = Setting("KL_CONSOLE_COMMAND_LINE");
    string directory = Setting("KL_CONSOLE_CWD");
    string exchange = Setting("KL_CONSOLE_EXCHANGE");
    int timeoutMs = Int32.Parse(Setting("KL_CONSOLE_TIMEOUT_MS"));
    // 自分の標準入出力（試験とのパイプ）を、対象に受け継がせない。
    foreach (int std in new int[] { -10, -11, -12 }) {
      IntPtr handle = GetStdHandle(std);
      if (handle != IntPtr.Zero && handle != Invalid) SetHandleInformation(handle, 1, 0);
    }
    IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) { Say("error " + Failure("CreateJobObjectW")); return 2; }
    ExtendedLimit limit = new ExtendedLimit();
    limit.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limit, Marshal.SizeOf(typeof(ExtendedLimit)))) { Say("error " + Failure("SetInformationJobObject")); return 2; }

    IntPtr input = OpenForChild("NUL", 0x80000000, 3);
    IntPtr output = OpenForChild(Path.Combine(exchange, "stdout.txt"), 0x40000000, 2);
    IntPtr error = OpenForChild(Path.Combine(exchange, "stderr.txt"), 0x40000000, 2);
    StartupInfo startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.dwFlags = 0x100 | 0x1; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
    startup.wShowWindow = 0;       // SW_HIDE
    startup.hStdInput = input;
    startup.hStdOutput = output;
    startup.hStdError = error;
    SetConsoleCtrlHandler(null, false);
    ProcessInformation process;
    // CREATE_SUSPENDED | CREATE_NEW_CONSOLE。ジョブに入れてから動かす。
    bool created = CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x10, IntPtr.Zero, directory, ref startup, out process);
    string createFailure = created ? null : Failure("CreateProcessW");
    CloseHandle(input);
    CloseHandle(output);
    CloseHandle(error);
    if (!created) { Say("error " + createFailure); return 2; }
    if (!AssignProcessToJobObject(job, process.hProcess)) {
      string assignFailure = Failure("AssignProcessToJobObject");
      TerminateProcess(process.hProcess, 1);
      Say("error " + assignFailure);
      return 2;
    }
    ResumeThread(process.hThread);
    CloseHandle(process.hThread);
    uint processId = (uint)process.dwProcessId;
    Say("started " + processId);

    DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    int next = 1;
    bool exited = false;
    while (true) {
      string request = Path.Combine(exchange, "request-" + next);
      if (File.Exists(request)) {
        string kind = File.ReadAllText(request).Trim();
        string failure = exited ? "the process has already exited" : Send(processId, kind);
        Say(failure == null ? "sent " + next : "send-failed " + next + " " + failure);
        next++;
      }
      if (!exited && WaitForSingleObject(process.hProcess, 0) == 0) {
        uint code;
        GetExitCodeProcess(process.hProcess, out code);
        exited = true;
        Say("exited " + code + " " + Active(job));
      }
      if (exited && Active(job) == 0) { Say("drained"); return 0; }
      if (DateTime.UtcNow > deadline) {
        TerminateJobObject(job, 1);
        Say("timeout");
        return 0;
      }
      Thread.Sleep(20);
    }
  }
}
`;

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$source = @'",
  CSHARP.trim(),
  "'@",
  'Add-Type -TypeDefinition $source -Language CSharp',
  'exit [KurashiLedgerConsole]::Run()',
].join('\r\n');

function powershellPath(): string {
  // PATHを使わず、Windowsに同梱のWindows PowerShell 5.1を絶対パスで呼ぶ。
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// commandを、argsを付けて、新しいコンソールで起動する（Windowsだけ）。exchangeParentの下に、標準出力・標準エラーと
// 要求のファイルを置くディレクトリを作る。envは対象にそのまま渡る（補助の設定の環境変数は対象に渡さない）。
export function startInNewConsole(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly exchangeParent: string; readonly timeoutMs?: number },
): ConsoleRun {
  if (process.platform !== 'win32') throw new Error('startInNewConsoleはWindowsだけで使う。');
  const exchange = mkdtempSync(join(options.exchangeParent, 'kl-console-'));
  const child: ChildProcess = spawn(
    powershellPath(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    {
      env: {
        ...options.env,
        KL_CONSOLE_COMMAND_LINE: windowsCommandLine([command, ...args]),
        KL_CONSOLE_CWD: options.cwd,
        KL_CONSOLE_EXCHANGE: exchange,
        KL_CONSOLE_TIMEOUT_MS: String(options.timeoutMs ?? 120_000),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  const lines: string[] = [];
  let helperStderr = '';
  let pending = '';
  const waiters: Array<{ match: (line: string) => boolean; resolve: (line: string) => void; reject: (e: Error) => void }> = [];
  let finished: Error | null = null;
  const describe = () => `補助の出力: ${lines.join(' | ')} / 補助の標準エラー: ${helperStderr.trim()}`;
  const waitFor = (match: (line: string) => boolean): Promise<string> => {
    const seen = lines.find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    if (finished !== null) return Promise.reject(finished);
    return new Promise((resolve, reject) => waiters.push({ match, resolve, reject }));
  };
  child.stdout?.setEncoding('utf8').on('data', (data: string) => {
    pending += data;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? '';
    for (const line of parts) {
      if (line === '') continue;
      lines.push(line);
      for (const waiter of [...waiters]) {
        if (waiter.match(line)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
    }
  });
  child.stderr?.setEncoding('utf8').on('data', (data: string) => (helperStderr += data));
  // 補助そのものが止まった場合（PowerShellの起動やコンパイルで止まる等）にも、試験が終わるようにする。
  const timeoutMs = options.timeoutMs ?? 120_000;
  const watchdog = setTimeout(() => {
    helperStderr += `\n補助が${timeoutMs + 60_000}ms以内に終わらなかったので終わらせた。`;
    child.kill();
  }, timeoutMs + 60_000);
  watchdog.unref();
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      helperStderr += `\n${error.message}`;
      resolve(null);
    });
    child.once('close', (code) => resolve(code));
  }).then((code) => {
    clearTimeout(watchdog);
    finished = new Error(`コンソールの補助が終わった（終了コード ${String(code)}）。${describe()}`);
    for (const waiter of waiters.splice(0)) waiter.reject(finished);
    return code;
  });

  const started = waitFor((l) => l.startsWith('started ') || l.startsWith('error ')).then((line) => {
    if (!line.startsWith('started ')) throw new Error(`新しいコンソールで起動できなかった。${describe()}`);
    return Number(line.slice('started '.length));
  });
  let requests = 0;
  const send = async (event: ConsoleEvent): Promise<void> => {
    await started;
    requests += 1;
    const n = requests;
    // 補助が書きかけを読まないよう、別の名前で書いてから名前を変える。
    writeFileSync(join(exchange, `request-${n}.tmp`), event);
    renameSync(join(exchange, `request-${n}.tmp`), join(exchange, `request-${n}`));
    const line = await waitFor((l) => l === `sent ${n}` || l.startsWith(`send-failed ${n} `));
    if (line !== `sent ${n}`) throw new Error(`${event}を送れなかった: ${line}。${describe()}`);
  };
  const done = closed.then((code): ConsoleRunResult => {
    const exitedLine = lines.find((l) => l.startsWith('exited '));
    const timedOut = lines.includes('timeout');
    if (code !== 0 || (!timedOut && (exitedLine === undefined || !lines.includes('drained')))) {
      throw new Error(`コンソールの補助が正しく終わらなかった（終了コード ${String(code)}）。${describe()}`);
    }
    const [, status, remaining] = exitedLine?.split(' ') ?? [];
    const read = (name: string) => {
      try {
        return readFileSync(join(exchange, name), 'utf8');
      } catch {
        return '';
      }
    };
    return {
      status: timedOut || status === undefined ? null : Number(status),
      remainingAtExit: Number(remaining ?? '0'),
      timedOut,
      stdout: read('stdout.txt'),
      stderr: read('stderr.txt'),
    };
  });
  // 呼び出し側がdoneを待つ前に失敗しても、未処理のrejectionにしない。
  started.catch(() => {});
  done.catch(() => {});
  return {
    started,
    send,
    done,
    abort: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}
