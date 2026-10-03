// `npm start`（T26の段階）: ローカルHTTPサーバーの骨格を起動する（ADR-0002の「起動と終了」、ADR-0003、ADR-0009）。
// - 画面（UI）・記録のAPI・DBはまだない。データルートも開かない（データルートの検査とtmp/のつなぎ込みはT09）。
// - トークンの一時ファイルは、--token-dirで明示した本人専用のディレクトリにだけ置く。なければ起動しない。
// - 標準出力が端末のときだけ、1回だけ使えるトークン付きURLを表示する。端末でないとき（リダイレクト・パイプ）は、
//   本人だけが読める一時ファイルのURLだけを表示する（トークンをログに残さない）。
// - Ctrl+C（SIGINT）・SIGTERM・SIGHUP（WindowsはSIGBREAKも）で、待受を止め、一時ファイルを消して0で終わる。
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TokenDirectoryError } from './infrastructure/http/launch-file.ts';
import { PortInUseError, startLocalServer, type LocalServer } from './infrastructure/http/server.ts';

export const DEFAULT_PORT = 48720;

export const USAGE = [
  '使い方: npm start -- --token-dir <本人専用のディレクトリ> [--port <番号>] [--no-open]',
  '  --token-dir  トークンの一時ファイルを置く、本人だけが使えるディレクトリ（必須。repoの外。作らない）',
  `  --port       待ち受けるポート（既定 ${DEFAULT_PORT}。0はOSが選ぶ。使用中なら別のポートへ移らずに終了する）`,
  '  --no-open    起動用のファイルをブラウザで自動で開かない',
].join('\n');

export type StartIo = {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly isTerminal: boolean;
  readonly openInBrowser: (filePath: string) => void;
  // このアプリのrepo（worktree）の実体パス。--token-dirがこの中なら拒否する。
  readonly repositoryRoot: string;
};

export type RunningApp = {
  readonly server: LocalServer;
  // Ctrl+C等で呼ぶ終了の処理。何度呼んでも1回だけ行う。
  stop(reason: string): Promise<void>;
};

export type StartResult = { readonly kind: 'running'; readonly app: RunningApp } | { readonly kind: 'exit'; readonly code: number };

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export async function startApp(argv: readonly string[], io: StartIo): Promise<StartResult> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { 'token-dir': { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return { kind: 'exit', code: 2 };
  }
  const tokenDir = values['token-dir'];
  if (tokenDir === undefined || tokenDir === '') {
    io.err(`--token-dirがない。T26の段階のnpm startは、トークンの一時ファイルを置く本人専用のディレクトリを明示しないと起動しない（既定の場所へ切り替えない）。\n${USAGE}`);
    return { kind: 'exit', code: 2 };
  }
  const portText = values.port ?? String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) {
    io.err(`--port ${portText} は0〜65535の整数でない。\n${USAGE}`);
    return { kind: 'exit', code: 2 };
  }
  let tokenReal: string;
  try {
    tokenReal = realpathSync.native(resolve(tokenDir));
  } catch {
    tokenReal = resolve(tokenDir);
  }
  if (isInside(tokenReal, io.repositoryRoot)) {
    io.err(`--token-dir ${tokenDir} はこのrepoの中にある。トークンを公開領域に書かないよう、repoの外のディレクトリを指定する。`);
    return { kind: 'exit', code: 1 };
  }

  let server: LocalServer;
  try {
    server = await startLocalServer({ port: Number(portText), tokenDirectory: tokenDir, log: (line) => io.out(`[http] ${line}`) });
  } catch (error) {
    if (error instanceof PortInUseError) {
      io.err(`${error.message} --portで別のポートを指定するか、そのポートを使っているプロセスを終了してから起動し直す。`);
    } else if (error instanceof TokenDirectoryError) {
      io.err(error.message);
    } else {
      io.err(`起動できなかった: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { kind: 'exit', code: 1 };
  }

  io.out('Kurashi Ledger（T26の段階: HTTPの境界の骨格だけ。画面・記録・DBはまだない）');
  io.out(`待ち受け: ${server.origin}/ （127.0.0.1だけ）`);
  io.out(`起動用のファイル（本人だけが読める。交換のあとで消える）: ${server.launchFileUrl}`);
  if (io.isTerminal) io.out(`ブラウザが開かないときは、次のURLを開く（1回だけ使える）: ${server.tokenUrl}`);
  else io.out('ブラウザが開かないときは、上の起動用のファイルをブラウザで開く。');
  io.out('終了するには Ctrl+C を押す。');
  if (values['no-open'] !== true) io.openInBrowser(server.launchFile);

  let stopping: Promise<void> | undefined;
  const app: RunningApp = {
    server,
    stop(reason) {
      stopping ??= (async () => {
        io.out(`終了する（${reason}）。`);
        await server.close();
        io.out('終了した。待受を止め、起動用のファイルを消した。');
      })();
      return stopping;
    },
  };
  return { kind: 'running', app };
}

// OSの既定の処理で起動用のファイルを開く。引数はファイルのパスだけで、トークンはコマンドラインに出ない。
export function openWithSystem(filePath: string, err: (line: string) => void): void {
  let command: string;
  if (process.platform === 'darwin') command = '/usr/bin/open';
  else if (process.platform === 'win32') command = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'explorer.exe');
  else command = 'xdg-open';
  const child = spawn(command, [filePath], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => err('ブラウザを自動で開けなかった。上の起動用のファイルをブラウザで開く。'));
  child.unref();
}

if (import.meta.main) {
  const repositoryRoot = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
  const io: StartIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    isTerminal: process.stdout.isTTY === true,
    openInBrowser: (filePath) => openWithSystem(filePath, (line) => process.stderr.write(`${line}\n`)),
    repositoryRoot,
  };
  const result = await startApp(process.argv.slice(2), io);
  if (result.kind === 'exit') {
    process.exitCode = result.code;
  } else {
    const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let received = 0;
    for (const signal of signals) {
      process.on(signal, () => {
        received += 1;
        // 終了の処理の途中でもう一度押されたら、待たずに終える。
        if (received > 1) process.exit(1);
        result.app.stop(signal).then(
          () => {
            process.exitCode = 0;
            for (const s of signals) process.removeAllListeners(s);
          },
          (error: unknown) => {
            process.stderr.write(`終了の処理で失敗した: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exit(1);
          },
        );
      });
    }
  }
}
