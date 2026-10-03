// 静的ファイルの配信の範囲（ADR-0003の13、ADR-0009）。
// 1. URLのパスの検査（parseStaticPath）: 生のパスで、バックスラッシュとエンコードされた区切り文字（%2F・%5C）を拒否し、
//    1回だけデコードしてから、%（二重エンコード）・バックスラッシュ・NUL等の制御文字・ドライブ指定やストリーム（:）・
//    ..と.のセグメント・空のセグメント（ディレクトリの要求）・Windowsの予約名・末尾の.と空白を拒否する。
//    .で始まる名前は返さない。
// 2. 読み出し元（StaticSource）: ディスクの読み出し元は、起動時に配信ルートの実体パスを固定し、候補の実体パス
//    （symlink・junctionを解決したもの）が配信ルートの実体パスの配下にある通常のファイルのときだけ返す。
//    ディレクトリの一覧は返さない。T09は、manifestで確かめた内容をメモリから返す読み出し元に替える（ADR-0002）。
import { open, realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { LAUNCH_ID_META_NAME } from './request-checks.ts';

export type StaticPath =
  | { readonly ok: true; readonly segments: readonly string[] }
  | { readonly ok: false; readonly status: 400 | 404; readonly code: string };

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

function invalid(code: string): StaticPath {
  return { ok: false, status: 400, code };
}

// req.url（origin-formの要求の対象）から、配信ルートからの相対のセグメントを取り出す。
export function parseStaticPath(rawUrl: string): StaticPath {
  if (!rawUrl.startsWith('/')) return invalid('bad-request-target');
  const query = rawUrl.indexOf('?');
  const rawPath = query < 0 ? rawUrl : rawUrl.slice(0, query);
  if (rawPath.includes('#')) return invalid('bad-request-target');
  if (rawPath.includes('\\')) return invalid('backslash');
  if (/%(?:2f|5c)/i.test(rawPath)) return invalid('encoded-separator');
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return invalid('bad-encoding');
  }
  if (decoded.includes('%')) return invalid('double-encoding');
  if (decoded.includes('\\')) return invalid('backslash');
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return invalid('control-character');
  if (decoded === '/') return { ok: true, segments: ['index.html'] };
  const segments = decoded.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '') return { ok: false, status: 404, code: 'directory' };
    if (segment === '.' || segment === '..') return invalid('dot-segment');
    if (segment.includes(':')) return invalid('drive-or-stream');
    if (/[. ]$/.test(segment)) return invalid('trailing-dot-or-space');
    if (WINDOWS_RESERVED.test(segment.split('.')[0] ?? '')) return invalid('reserved-name');
    if (segment.startsWith('.')) return { ok: false, status: 404, code: 'hidden' };
  }
  return { ok: true, segments };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function isHtml(contentType: string): boolean {
  return contentType.startsWith('text/html');
}

// 配信するHTMLの<head>の直後に、起動の識別子の<meta>を入れる（ADR-0003の14、ADR-0009）。
// <head>がないHTMLと、すでに同じ名前の<meta>を含むHTMLは、識別子があいまいになるので配信しない（undefined）。
export function injectLaunchId(html: Buffer, launchId: string): Buffer | undefined {
  const text = html.toString('utf8');
  if (text.includes(LAUNCH_ID_META_NAME)) return undefined;
  const head = /<head(?:\s[^>]*)?>/i.exec(text);
  if (head === null) return undefined;
  const at = head.index + head[0].length;
  return Buffer.from(`${text.slice(0, at)}<meta name="${LAUNCH_ID_META_NAME}" content="${launchId}">${text.slice(at)}`, 'utf8');
}

export type StaticFile = { readonly body: Buffer; readonly contentType: string };

export type StaticSource = {
  // segmentsはparseStaticPathを通ったもの。なければundefined。
  read(segments: readonly string[]): Promise<StaticFile | undefined>;
};

// 1つのファイルの大きさの上限（UIのビルド成果物には十分。メモリを使い切らないため）。
const MAX_FILE_BYTES = 32 * 1024 * 1024;

const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EACCES', 'EPERM', 'ENAMETOOLONG', 'EINVAL']);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

// rootの実体パスを起動時に固定する。rootがディレクトリでなければ例外。
export async function createDiskStaticSource(root: string): Promise<StaticSource> {
  const rootReal = await realpath(root);
  if (!(await stat(rootReal)).isDirectory()) throw new Error(`配信ルート ${root} がディレクトリでない。`);
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  return {
    async read(segments) {
      let real: string;
      try {
        real = await realpath(join(rootReal, ...segments));
      } catch (error) {
        if (NOT_FOUND_CODES.has(errorCode(error) ?? '')) return undefined;
        throw error;
      }
      // 実体パスが配信ルートの配下になければ返さない（外を指すsymlink・junctionを含む）。
      if (!real.startsWith(prefix)) return undefined;
      let handle;
      try {
        handle = await open(real, 'r');
      } catch (error) {
        if (NOT_FOUND_CODES.has(errorCode(error) ?? '')) return undefined;
        throw error;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile()) return undefined;
        if (info.size > MAX_FILE_BYTES) throw new Error('配信するファイルが大きすぎる。');
        const body = await handle.readFile();
        return { body, contentType: contentTypeFor(segments.at(-1) ?? '') };
      } finally {
        await handle.close();
      }
    },
  };
}
