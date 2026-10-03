// 静的ファイルの配信の範囲（ADR-0003の13、ADR-0009）: URLのパスの検査と、配信ルートの実体パスの確認。
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ownerOnlyTempDirectory } from '../../../tests/support/http.ts';
import { createDiskStaticSource, injectLaunchId, parseStaticPath } from './static-files.ts';

test('URLのパスの検査: 配信ルートの中の普通の名前だけをセグメントにする', () => {
  assert.deepEqual(parseStaticPath('/'), { ok: true, segments: ['index.html'] });
  assert.deepEqual(parseStaticPath('/app.js?v=1'), { ok: true, segments: ['app.js'] });
  assert.deepEqual(parseStaticPath('/assets/%E6%97%A5%E6%9C%AC.css'), { ok: true, segments: ['assets', '日本.css'] });
});

test('URLのパスの検査: ..・エンコードした区切り文字・二重エンコード・バックスラッシュ・NUL・ドライブ指定等を拒否する', () => {
  const rejected: Array<[string, number]> = [
    ['/../secret.txt', 400],
    ['/a/../../secret.txt', 400],
    ['/%2e%2e/secret.txt', 400],
    ['/%2E%2E/%2E%2E/secret.txt', 400],
    ['/a%2F..%2Fsecret.txt', 400],
    ['/..%2fsecret.txt', 400],
    ['/..%5Csecret.txt', 400],
    ['/%5c..%5csecret.txt', 400],
    ['/%252e%252e/secret.txt', 400],
    ['/..%252Fsecret.txt', 400],
    ['/a\\..\\secret.txt', 400],
    ['/secret.txt%00.js', 400],
    ['/C:/Windows/win.ini', 400],
    ['/c:%5cwindows', 400],
    ['/file.txt::$DATA', 400],
    ['/CON', 400],
    ['/nul.txt', 400],
    ['/com1.js', 400],
    ['/index.html.', 400],
    ['/index.html%20', 400],
    ['/%E0%A4%A', 400],
    ['/./index.html', 400],
    ['secret.txt', 400],
    ['/assets/', 404],
    ['//etc/passwd', 404],
    ['/.env', 404],
    ['/.git/config', 404],
  ];
  for (const [url, status] of rejected) {
    const result = parseStaticPath(url);
    assert.equal(result.ok, false, url);
    if (!result.ok) assert.equal(result.status, status, url);
  }
});

test('HTMLの<head>の直後に起動の識別子の<meta>を入れ、<head>がない・すでにあるHTMLは配信しない', () => {
  const html = Buffer.from('<!doctype html><html><HEAD lang="ja"><title>t</title></HEAD><body></body></html>');
  assert.equal(
    injectLaunchId(html, 'AAAAAAAAAAAAAAAAAAAAAA')?.toString(),
    '<!doctype html><html><HEAD lang="ja"><meta name="kurashi-ledger-launch-id" content="AAAAAAAAAAAAAAAAAAAAAA"><title>t</title></HEAD><body></body></html>',
  );
  assert.equal(injectLaunchId(Buffer.from('<p>no head</p>'), 'AAAAAAAAAAAAAAAAAAAAAA'), undefined);
  assert.equal(injectLaunchId(Buffer.from('<head><meta name="kurashi-ledger-launch-id" content="x"></head>'), 'AAAAAAAAAAAAAAAAAAAAAA'), undefined);
  assert.equal(injectLaunchId(Buffer.from('<header>x</header>'), 'AAAAAAAAAAAAAAAAAAAAAA'), undefined);
});

function linkFile(t: TestContext, target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (error) {
    if (process.platform !== 'win32' || (error as { code?: string }).code !== 'EPERM') throw error;
    t.diagnostic('Windowsでファイルのsymlinkを作る権限がないため、配信ルートの外を指すファイルのリンクはjunction（ディレクトリ）だけで確かめた');
    return false;
  }
}

test('ディスクの読み出し元は、配信ルートの実体パスの配下の通常のファイルだけを返し、外を指すリンクとディレクトリを返さない', async (t) => {
  const tmp = ownerOnlyTempDirectory('static');
  try {
    const root = join(tmp.path, 'root');
    const outside = join(tmp.path, 'outside');
    mkdirSync(join(root, 'assets'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'index.html'), '<html><head></head><body>synthetic</body></html>');
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log("synthetic");');
    writeFileSync(join(outside, 'secret.txt'), 'outside-secret');
    const dirKind = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(outside, join(root, 'escape'), dirKind);
    symlinkSync(join(root, 'assets'), join(root, 'inside'), dirKind);
    const fileLink = linkFile(t, join(outside, 'secret.txt'), join(root, 'secret-link.txt'));

    const source = await createDiskStaticSource(root);
    const index = await source.read(['index.html']);
    assert.equal(index?.contentType, 'text/html; charset=utf-8');
    assert.equal((await source.read(['assets', 'app.js']))?.contentType, 'text/javascript; charset=utf-8');
    // 配信ルートの中を指すリンクは、実体が配下にあるので返す。
    assert.equal((await source.read(['inside', 'app.js']))?.body.toString(), 'console.log("synthetic");');
    assert.equal(await source.read(['escape', 'secret.txt']), undefined);
    if (fileLink) assert.equal(await source.read(['secret-link.txt']), undefined);
    assert.equal(await source.read(['assets']), undefined);
    assert.equal(await source.read(['missing.js']), undefined);

    // 配信ルート自体をリンクで渡しても、起動時に実体パスを固定するので、外へは出ない。
    symlinkSync(root, join(tmp.path, 'root-link'), dirKind);
    const viaLink = await createDiskStaticSource(join(tmp.path, 'root-link'));
    assert.equal((await viaLink.read(['index.html']))?.body.toString().includes('synthetic'), true);
    assert.equal(await viaLink.read(['escape', 'secret.txt']), undefined);
  } finally {
    tmp.cleanup();
  }
});
