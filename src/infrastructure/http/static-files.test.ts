// 静的ファイルの配信の範囲（ADR-0003の13、ADR-0009）: URLのパスの検査と、配信ルートの実体パスの確認。
import assert from 'node:assert/strict';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ownerOnlyTempDirectory } from '../../../tests/support/http.ts';
import { createDiskStaticSource, decodeAttributeValue, injectLaunchId, isHtml, parseStaticPath } from './static-files.ts';

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

test('識別子の注入は、コメント・title・scriptの中の文字列を要素と取り違えず、実際の<head>に入れ、実際のmetaだけを重複とする', () => {
  const id = 'AAAAAAAAAAAAAAAAAAAAAA';
  const meta = `<meta name="kurashi-ledger-launch-id" content="${id}">`;
  const inject = (html: string) => injectLaunchId(Buffer.from(html), id)?.toString();
  // コメントの中の<head>（とmeta）は要素ではない。実際の<head>の直後に入る。
  const commented = '<!doctype html><!-- <head><meta name="kurashi-ledger-launch-id" content="x"></head> --><html><head><title>t</title></head></html>';
  assert.equal(inject(commented), commented.replace('<html><head>', `<html><head>${meta}`));
  // 同じ文字列を含む<title>・script・属性の値は、metaの重複ではない。
  const titled = '<html><head><title>kurashi-ledger-launch-id</title><script>document.write("<meta name=\'kurashi-ledger-launch-id\'>")</script></head><body data-x="kurashi-ledger-launch-id"></body></html>';
  assert.equal(inject(titled), titled.replace('<html><head>', `<html><head>${meta}`));
  // 実際の同名のmeta（大文字小文字・文字参照・body の中を含む）は重複として配信しない。
  for (const html of [
    '<html><head><meta name="kurashi-ledger-launch-id" content="x"></head></html>',
    '<html><head><META NAME=Kurashi-Ledger-Launch-Id content=x></head></html>',
    '<html><head></head><body><meta name="kurashi&#45;ledger-launch-id" content="x"></body></html>',
    "<html><head><meta content='x' name='kurashi-ledger-launch-id'/></head></html>",
  ]) {
    assert.equal(inject(html), undefined, html);
  }
  // <head>より前にほかの要素や文字がある・閉じていないコメントやタグは、識別子の場所があいまいなので配信しない。
  for (const html of ['hello<head></head>', '<body><head></head></body>', '<!-- <head>', '<html><head', '<script>"<head>"</script><head></head>']) {
    assert.equal(inject(html), undefined, html);
  }
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

test('属性の値の文字参照は、ブラウザと同じ規則で解く（セミコロンのない数値の参照・16進・C1・不正な値・古い名前の参照）', () => {
  const cases: Array<[string, string, boolean]> = [
    ['kurashi&#45ledger', 'kurashi-ledger', false],
    ['kurashi&#x2dledger', 'kurashi-ledger', false],
    ['kurashi&#X2D;ledger', 'kurashi-ledger', false],
    ['&#0045;&#107', '-k', false],
    ['&#0;&#x110000;&#xD800;', '\uFFFD\uFFFD\uFFFD', false],
    ['&#150;', '\u2013', false],
    ['a&amp;b&lt c', 'a&b< c', false],
    ['a&ampb', 'a&ampb', true],
    ['a&amp=b', 'a&amp=b', true],
    ['a&dash;b&hyphen;c&minus;d', 'a\u2010b\u2010c\u2212d', false],
    ['a&unknown;b', 'a&unknown;b', true],
    ['a & b', 'a & b', false],
  ];
  for (const [raw, value, unresolved] of cases) assert.deepEqual(decodeAttributeValue(raw), { value, unresolved }, raw);
});

test('セミコロンのない数値の参照等で書いた同名のmetaも重複とし、ハイフンに似た別の文字の名前は重複としない', () => {
  const id = 'AAAAAAAAAAAAAAAAAAAAAA';
  const page = (name: string) => `<!doctype html><html><head><meta name="${name}" content="x"><title>t</title></head><body></body></html>`;
  for (const name of [
    'kurashi&#45ledger-launch-id',
    'kurashi&#x2dledger&#x2Dlaunch&#45;id',
    '&#107;urashi-ledger-launch-id',
    'KURASHI&#45LEDGER&#45LAUNCH&#45ID',
    'kurashi&unknown;-ledger-launch-id',
  ]) {
    assert.equal(injectLaunchId(Buffer.from(page(name)), id), undefined, name);
  }
  for (const name of ['kurashi&#45ledger-launch-idx', 'kurashi&dash;ledger-launch-id', 'kurashi&#8208;ledger-launch-id']) {
    assert.notEqual(injectLaunchId(Buffer.from(page(name)), id), undefined, name);
  }
});

test('HTMLの判定は、;より前のメディア型を正規化して、text/htmlと完全に一致するときだけ', () => {
  for (const type of ['text/html', 'Text/HTML; charset=UTF-8', ' text/html ;charset=utf-8', 'TEXT/HTML']) assert.equal(isHtml(type), true, type);
  for (const type of ['text/htmlx', 'text/html-sandboxed', 'application/xhtml+xml', 'text/plain', '']) assert.equal(isHtml(type), false, type);
});

test('ディスクの読み出し元は、実体パスを確かめたあと・開く前に経路が配信ルートの外へ差し替わると、外のファイルを返さない', async () => {
  const tmp = ownerOnlyTempDirectory('static-race');
  try {
    const root = join(tmp.path, 'root');
    const outside = join(tmp.path, 'outside');
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'sub', 'page.txt'), 'inside');
    writeFileSync(join(outside, 'page.txt'), 'outside-secret');
    let swapped = false;
    const source = await createDiskStaticSource(root, () => {
      if (swapped) return;
      swapped = true;
      // 確かめた実体パスの親を、配信ルートの外へのリンクに差し替える。
      renameSync(join(root, 'sub'), join(root, 'sub-moved'));
      symlinkSync(outside, join(root, 'sub'), process.platform === 'win32' ? 'junction' : 'dir');
    });
    assert.equal(await source.read(['sub', 'page.txt']), undefined);
    assert.equal(swapped, true);
  } finally {
    tmp.cleanup();
  }
});
