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

// HTMLを要素の単位で読む小さな字句解析（ADR-0009の1）。コメント・宣言（doctype等）・処理命令と、生のテキストを
// 中身に持つ要素（script・style・title・textarea等）の中身を、要素と区別する。属性は引用符を考えて読む。
type HtmlToken =
  | { readonly kind: 'start'; readonly name: string; readonly attrs: ReadonlyMap<string, string>; readonly end: number }
  | { readonly kind: 'end'; readonly name: string; readonly end: number }
  | { readonly kind: 'comment' | 'declaration' | 'text'; readonly text: string; readonly end: number };

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (all, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[lower] ?? all;
  });
}

// 読めない形（閉じていないコメント・タグ・生のテキストの要素）ならundefined。
function tokenizeHtml(text: string): HtmlToken[] | undefined {
  const tokens: HtmlToken[] = [];
  let pos = 0;
  while (pos < text.length) {
    if (text.startsWith('<!--', pos)) {
      const close = text.indexOf('-->', pos + 4);
      if (close < 0) return undefined;
      tokens.push({ kind: 'comment', text: text.slice(pos, close + 3), end: close + 3 });
      pos = close + 3;
      continue;
    }
    if (text.startsWith('<!', pos) || text.startsWith('<?', pos)) {
      const close = text.indexOf('>', pos);
      if (close < 0) return undefined;
      tokens.push({ kind: 'declaration', text: text.slice(pos, close + 1), end: close + 1 });
      pos = close + 1;
      continue;
    }
    const endTag = /^<\/([A-Za-z][^\s/>]*)[^>]*>/.exec(text.slice(pos, pos + 1024));
    if (endTag !== null) {
      pos += endTag[0].length;
      tokens.push({ kind: 'end', name: (endTag[1] ?? '').toLowerCase(), end: pos });
      continue;
    }
    const startTag = /^<([A-Za-z][^\s/>]*)/.exec(text.slice(pos, pos + 1024));
    if (startTag !== null) {
      const name = (startTag[1] ?? '').toLowerCase();
      let at = pos + startTag[0].length;
      const attrs = new Map<string, string>();
      const attr = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?|\s*\/|\s+/y;
      for (;;) {
        if (at >= text.length) return undefined;
        if (text[at] === '>') break;
        attr.lastIndex = at;
        const m = attr.exec(text);
        if (m === null || m[0].length === 0) return undefined;
        if (m[1] !== undefined) {
          const key = m[1].toLowerCase();
          if (!attrs.has(key)) attrs.set(key, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
        }
        at += m[0].length;
      }
      pos = at + 1;
      tokens.push({ kind: 'start', name, attrs, end: pos });
      if (RAW_TEXT_ELEMENTS.has(name)) {
        const close = text.toLowerCase().indexOf(`</${name}`, pos);
        if (close < 0) return undefined;
        tokens.push({ kind: 'text', text: text.slice(pos, close), end: close });
        pos = close;
      }
      continue;
    }
    const next = text.indexOf('<', pos + 1);
    const stop = next < 0 ? text.length : next;
    tokens.push({ kind: 'text', text: text.slice(pos, stop), end: stop });
    pos = stop;
  }
  return tokens;
}

// 配信するHTMLに、起動の識別子の<meta>を入れる（ADR-0003の14、ADR-0009の1）。注入の契約:
// - doctype・コメント・空白・<html>の開始タグのあとの、最初の要素が<head>の開始タグであること。その直後に入れる。
// - 文書のどこにも、name属性が同じ名前（大文字小文字を区別しない）の実際の<meta>要素がないこと。
// 契約を満たさないHTML（<head>がない、<head>より前にほかの要素や文字がある、読めない形、すでに同じ<meta>がある）は、
// 識別子があいまいになるので配信しない（undefined）。コメントやscript・titleの中の文字列は要素として扱わない。
export function injectLaunchId(html: Buffer, launchId: string): Buffer | undefined {
  const text = html.toString('utf8');
  const tokens = tokenizeHtml(text);
  if (tokens === undefined) return undefined;
  let insertAt: number | undefined;
  for (const token of tokens) {
    if (token.kind === 'comment' || token.kind === 'declaration') continue;
    if (token.kind === 'text' && token.text.trim() === '') continue;
    if (token.kind === 'start' && token.name === 'html') continue;
    if (token.kind === 'start' && token.name === 'head') insertAt = token.end;
    break;
  }
  if (insertAt === undefined) return undefined;
  const duplicate = tokens.some(
    (t) => t.kind === 'start' && t.name === 'meta' && (t.attrs.get('name') ?? '').trim().toLowerCase() === LAUNCH_ID_META_NAME,
  );
  if (duplicate) return undefined;
  return Buffer.from(`${text.slice(0, insertAt)}<meta name="${LAUNCH_ID_META_NAME}" content="${launchId}">${text.slice(insertAt)}`, 'utf8');
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
