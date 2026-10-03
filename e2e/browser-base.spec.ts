// ブラウザ試験の基盤（T05、ADR-0004）が、このOSの各ブラウザで動くことの確認。
// アプリのHTTPサーバーはまだない（T26）。ここでは試験の中だけで127.0.0.1に一時のサーバーを立て、
// 合成の固定の文字列を返す。製品の境界（Host・Origin・トークン・CSP）はT26がこの基盤に試験を加えて確かめる。
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';

const PAGE = [
  '<!doctype html>',
  '<html lang="ja"><head><meta charset="utf-8"><title>合成のページ</title></head>',
  '<body><h1>合成のデータだけを使う</h1><a href="/echo">次へ</a></body></html>',
].join('');

function startServer(): Promise<Server> {
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/') {
      res.setHeader('Set-Cookie', 'kl_probe=synthetic; Path=/; HttpOnly; SameSite=Strict');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(PAGE);
    } else if (req.url === '/echo') {
      // 受け取ったcookieをそのまま返す（合成の値だけ）。
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(req.headers.cookie ?? '(cookieなし)');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

test('ブラウザを起動して、日本語のページの見出しを読める', async ({ page }) => {
  await page.setContent(PAGE);
  await expect(page).toHaveTitle('合成のページ');
  await expect(page.getByRole('heading', { name: '合成のデータだけを使う' })).toBeVisible();
});

test('127.0.0.1の一時のサーバーのページを開き、受け取ったcookieを次の要求で送り返す', async ({ page }) => {
  const server = await startServer();
  try {
    const { port } = server.address() as AddressInfo;
    await page.goto(`http://127.0.0.1:${port}/`);
    await expect(page.getByRole('heading', { name: '合成のデータだけを使う' })).toBeVisible();
    await page.getByRole('link', { name: '次へ' }).click();
    await expect(page).toHaveURL(`http://127.0.0.1:${port}/echo`);
    await expect(page.locator('body')).toHaveText('kl_probe=synthetic');
  } finally {
    await stopServer(server);
  }
});
