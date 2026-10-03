// HTTPの境界のブラウザでの試験（T26、ADR-0003の「別タスクで行う検証」、ADR-0009）。T05の基盤（e2e/browsers.ts）で、
// ChromiumをmacOS・Windows・Linux、WebKitをmacOSで実行する。サーバーは、この試験のプロセスの中で
// startLocalServer（npm startと同じ部品）を、試験ごとの本人専用の一時ディレクトリと固定のfixture
// （tests/fixtures/http/static/）で起動する。APIの/api/test/...は、試験の中だけで登録する合成のもの。
// サーバーが受け取った要求は、node:diagnostics_channelのhttp.server.request.startで観測する
// （ブラウザ側の記録はフラグメントを含みうるので、サーバーへ実際に届いたURLとRefererを見る）。
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { PortInUseError, startLocalServer, type ApiRoute, type LocalServer } from '../src/infrastructure/http/server.ts';
import type { StaticSource } from '../src/infrastructure/http/static-files.ts';
import { ownerOnlyTempDirectory, tokenOf } from '../tests/support/http.ts';

const FIXTURE_ROOT = fileURLToPath(new URL('../tests/fixtures/http/static/', import.meta.url));

type Harness = { readonly server: LocalServer; readonly calls: string[]; readonly logs: string[]; stop(): Promise<void> };

function routes(calls: string[]): ApiRoute[] {
  return [
    { method: 'GET', path: '/api/test/state', handle: () => (calls.push('state'), { status: 200, body: { state: 'synthetic' } }) },
    { method: 'POST', path: '/api/test/mutate', handle: (r) => (calls.push(`mutate ${JSON.stringify(r.body)}`), { status: 200, body: { ok: true } }) },
  ];
}

async function startHarness(port = 0): Promise<Harness> {
  const tmp = ownerOnlyTempDirectory('e2e');
  const calls: string[] = [];
  const logs: string[] = [];
  let server: LocalServer | undefined;
  // 同じポートで起動し直す試験では、閉じた直後のポートが一時的に使えないOSがあるので、少しだけ待ってやり直す。
  for (let attempt = 0; server === undefined; attempt += 1) {
    try {
      server = await startLocalServer({ port, tokenDirectory: tmp.path, staticRoot: FIXTURE_ROOT, api: routes(calls), log: (l) => logs.push(l) });
    } catch (error) {
      if (!(error instanceof PortInUseError) || port === 0 || attempt >= 20) {
        tmp.cleanup();
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const started = server;
  return {
    server: started,
    calls,
    logs,
    async stop() {
      await started.close();
      tmp.cleanup();
    },
  };
}

type Seen = { readonly url: string; readonly referer: string | undefined };

function observe(port: number): { readonly requests: Seen[]; stop(): void } {
  const requests: Seen[] = [];
  const listener = (message: unknown): void => {
    const { request, socket } = message as { request: IncomingMessage; socket: Socket };
    if (socket.localPort === port) requests.push({ url: request.url ?? '', referer: request.headers.referer });
  };
  subscribe('http.server.request.start', listener);
  return { requests, stop: () => unsubscribe('http.server.request.start', listener) };
}

// 別のポートで動く、別のoriginのサーバー（合成の空のページ）。受け取った要求を記録する。
async function startOther(): Promise<{ readonly origin: string; readonly requests: string[]; stop(): Promise<void> }> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>other</title></head><body>other</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function openFromLaunchFile(page: Page, server: LocalServer): Promise<void> {
  await page.goto(server.launchFileUrl);
  await page.waitForURL(`${server.origin}/`);
  await expect(page.locator('#state')).toHaveText('接続済み');
}

test('起動用の一時ファイル（file://）から開くと、cookieに交換して画面へ移り、トークンはURL・Referer・ログ・履歴に残らない', async ({ page, context }) => {
  const h = await startHarness();
  const seen = observe(h.server.port);
  try {
    const token = tokenOf(h.server);
    expect(existsSync(h.server.launchFile)).toBe(true);
    await openFromLaunchFile(page, h.server);
    expect(page.url()).toBe(`${h.server.origin}/`);
    // 交換が済むと、一時ファイルは消える。
    expect(existsSync(h.server.launchFile)).toBe(false);
    const cookies = await context.cookies(h.server.origin);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: h.server.cookieName, path: '/', httpOnly: true, sameSite: 'Strict' });
    expect(cookies[0]?.value).not.toBe(token);
    expect(await page.evaluate(() => document.cookie)).toBe('');
    await page.locator('#mutate').click();
    await expect(page.locator('#mutation')).toHaveText('接続済み');
    expect(h.calls).toEqual(['state', 'mutate {"value":"synthetic"}']);

    // サーバーへ届いた要求のURLとReferer、要求ログに、トークンがない。
    expect(seen.requests.length).toBeGreaterThanOrEqual(5);
    for (const request of seen.requests) {
      expect(request.url).not.toContain(token);
      expect(request.referer).toBeUndefined();
    }
    expect(h.logs.join('\n')).not.toContain(token);
    expect(h.logs).toContain('POST /api/session 204');

    // 戻る操作でも、トークン付きのURL（フラグメントを含む）に戻らない。
    const visited = [page.url()];
    for (let i = 0; i < 3; i += 1) {
      await page.goBack({ waitUntil: 'commit' }).catch(() => null);
      visited.push(page.url());
    }
    for (const url of visited) {
      expect(url).not.toContain(token);
      expect(url).not.toContain('#');
    }

    // 使用済みのトークンのURLを開いても交換できず、URLからトークンが消える。
    const again = await context.newPage();
    await again.goto(h.server.tokenUrl);
    await expect(again.locator('#status')).toContainText('使用済みか無効');
    expect(again.url()).toBe(`${h.server.origin}/launch`);
    expect(h.logs).toContain('POST /api/session 403 token-rejected');
  } finally {
    seen.stop();
    await h.stop();
  }
});

test('ブラウザのDOMで、起動の識別子のmetaはちょうど1つで、コメントや紛らわしいtitleのあるページからもAPIを呼べる', async ({ page }) => {
  const h = await startHarness();
  try {
    await openFromLaunchFile(page, h.server);
    for (const path of ['/', '/tricky.html']) {
      await page.goto(`${h.server.origin}${path}`);
      await expect(page.locator('#state')).toHaveText('接続済み');
      const ids = await page.evaluate(() =>
        [...document.querySelectorAll('meta[name="kurashi-ledger-launch-id"]')].map((m) => m.getAttribute('content')),
      );
      expect(ids).toEqual([h.server.launchId]);
    }
    expect(h.calls.filter((c) => c === 'state')).toHaveLength(3);
  } finally {
    await h.stop();
  }
});

test('同じPCの別のポートのページからの要求は、cookieがあっても拒否され、APIの処理は呼ばれない', async ({ page }) => {
  const h = await startHarness();
  const other = await startOther();
  try {
    await openFromLaunchFile(page, h.server);
    h.calls.length = 0;
    await page.goto(`${other.origin}/`);
    const result = await page.evaluate(async (target) => {
      const out: Record<string, string> = {};
      try {
        await fetch(`${target}/api/test/mutate`, { method: 'POST', mode: 'no-cors', credentials: 'include', body: '{}' });
        out['noCors'] = 'sent';
      } catch {
        out['noCors'] = 'failed';
      }
      try {
        const r = await fetch(`${target}/api/test/mutate`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        out['json'] = String(r.status);
      } catch {
        out['json'] = 'blocked';
      }
      try {
        const r = await fetch(`${target}/api/test/state`, { credentials: 'include' });
        out['read'] = String(r.status);
      } catch {
        out['read'] = 'blocked';
      }
      return out;
    }, h.server.origin);
    expect(result['json']).toBe('blocked');
    expect(result['read']).toBe('blocked');
    // 別のポートのページからのformの送信（同じsiteとして扱われる）も拒否する。
    await page.evaluate((target) => {
      const form = document.createElement('form');
      form.method = 'post';
      form.action = `${target}/api/test/mutate`;
      form.enctype = 'text/plain';
      const input = document.createElement('input');
      input.name = 'value';
      input.value = 'synthetic';
      form.append(input);
      document.body.append(form);
      form.submit();
    }, h.server.origin);
    await page.waitForURL(`${h.server.origin}/api/test/mutate`);
    expect(h.calls).toEqual([]);
    expect(h.logs.filter((l) => l.startsWith('POST /api/test/mutate 403')).length).toBeGreaterThanOrEqual(2);
    // 同じoriginの画面からなら、同じcookieで成功する（cookieは有効なまま）。
    await page.goto(`${h.server.origin}/`);
    await page.locator('#mutate').click();
    await expect(page.locator('#mutation')).toHaveText('接続済み');
    expect(h.calls).toContain('mutate {"value":"synthetic"}');
  } finally {
    await other.stop();
    await h.stop();
  }
});

test('CSPで、外部のスクリプト・画像・スタイル・接続・frameとinlineのscriptが読み込まれない', async ({ page }) => {
  const h = await startHarness();
  const other = await startOther();
  try {
    await page.goto(`${h.server.origin}/`);
    const out = await page.evaluate(async (target) => {
      const violations: string[] = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
      const script = document.createElement('script');
      script.src = `${target}/x.js`;
      document.head.append(script);
      const img = document.createElement('img');
      img.src = `${target}/x.png`;
      document.body.append(img);
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${target}/x.css`;
      document.head.append(link);
      const frame = document.createElement('iframe');
      frame.src = `${target}/frame`;
      document.body.append(frame);
      let fetched = 'allowed';
      try {
        await fetch(`${target}/x.json`, { mode: 'no-cors' });
      } catch {
        fetched = 'blocked';
      }
      const inline = document.createElement('script');
      inline.textContent = 'window.__klInlineRan = true;';
      document.head.append(inline);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return { violations, fetched, inlineRan: (window as unknown as { __klInlineRan?: boolean }).__klInlineRan === true };
    }, other.origin);
    expect(out.fetched).toBe('blocked');
    expect(out.inlineRan).toBe(false);
    // 報告されるdirectiveの名前と数はブラウザで違うので、1件以上の報告と、外部のサーバーに要求が届かないことで確かめる。
    expect(out.violations.length).toBeGreaterThanOrEqual(1);
    expect(other.requests).toEqual([]);
  } finally {
    await other.stop();
    await h.stop();
  }
});

test('起動し直したあと、前の起動のページのままのAPI要求は識別子の不一致で拒否され、再読み込みで使える', async ({ context }) => {
  const first = await startHarness();
  const oldPage = await context.newPage();
  await openFromLaunchFile(oldPage, first.server);
  const port = first.server.port;
  await first.stop();
  const second = await startHarness(port);
  try {
    // 新しい起動のトークンを交換する（同じoriginなので、cookieは新しい値に置き換わる）。
    const newPage = await context.newPage();
    await openFromLaunchFile(newPage, second.server);
    await oldPage.locator('#check').click();
    await expect(oldPage.locator('#state')).toHaveText('再読み込みしてください');
    expect(second.logs).toContain('GET /api/test/state 409 launch-id-mismatch');
    await oldPage.reload();
    await expect(oldPage.locator('#state')).toHaveText('接続済み');
  } finally {
    await second.stop();
  }
});

test('文字参照で書いたmetaのnameは、ブラウザのDOMと同じに判定し、配信したページでは識別子のmetaがちょうど1つになる', async ({ page }) => {
  const names = [
    'kurashi&#45ledger-launch-id',
    'kurashi&#x2dledger&#x2Dlaunch&#45;id',
    '&#107;urashi-ledger-launch-id',
    'kurashi&#45ledger-launch-idx',
    'kurashi&dash;ledger-launch-id',
    'kurashi&#8208;ledger-launch-id',
  ];
  const html = (name: string) => `<!doctype html><html lang="ja"><head><meta name="${name}" content="x"><title>t</title></head><body>synthetic</body></html>`;
  const files = new Map(names.map((name, i) => [`v${i}.html`, html(name)]));
  const staticSource: StaticSource = {
    read: async (segments) => {
      const body = files.get(segments.join('/'));
      return body === undefined ? undefined : { body: Buffer.from(body), contentType: 'text/html; charset=utf-8' };
    },
  };
  const tmp = ownerOnlyTempDirectory('e2e-refs');
  const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, staticSource });
  try {
    for (const [i, name] of names.entries()) {
      // ブラウザが、この書き方を識別子と同じ名前のmetaと読むか。
      await page.setContent(html(name));
      const browserCount = await page.evaluate(() => document.querySelectorAll('meta[name="kurashi-ledger-launch-id"]').length);
      const response = await page.goto(`${server.origin}/v${i}.html`);
      if (browserCount > 0) {
        // ブラウザで同名になる書き方は、重複として配信しない。
        expect(response?.status(), name).toBe(500);
      } else {
        expect(response?.status(), name).toBe(200);
        const ids = await page.evaluate(() =>
          [...document.querySelectorAll('meta[name="kurashi-ledger-launch-id"]')].map((m) => m.getAttribute('content')),
        );
        expect(ids, name).toEqual([server.launchId]);
      }
    }
  } finally {
    await server.close();
    tmp.cleanup();
  }
});

test('コメントの終わりの書き方（<!-->・<!--->・--!>）も、ブラウザのDOMとサーバーの判定が一致し、配信したページでは識別子のmetaがちょうど1つになる', async ({ page }) => {
  const meta = '<meta name="kurashi-ledger-launch-id" content="x">';
  const heads = [
    `<!-->${meta}<!-- -->`,
    `<!--->${meta}<!-- -->`,
    `<!-- a --!>${meta}<!-- -->`,
    `<!-- ${meta} -->`,
    `<!---->${'<!-- x -- y -->'}<!-- ${meta} --!>`,
    `<!-- <!-- ${meta} -->`,
  ];
  const html = (head: string) => `<!doctype html><html lang="ja"><head>${head}<title>t</title></head><body>synthetic</body></html>`;
  const files = new Map(heads.map((head, i) => [`c${i}.html`, html(head)]));
  const staticSource: StaticSource = {
    read: async (segments) => {
      const body = files.get(segments.join('/'));
      return body === undefined ? undefined : { body: Buffer.from(body), contentType: 'text/html; charset=utf-8' };
    },
  };
  const tmp = ownerOnlyTempDirectory('e2e-comments');
  const server = await startLocalServer({ port: 0, tokenDirectory: tmp.path, staticSource });
  try {
    for (const [i, head] of heads.entries()) {
      await page.setContent(html(head));
      const browserCount = await page.evaluate(() => document.querySelectorAll('meta[name="kurashi-ledger-launch-id"]').length);
      const response = await page.goto(`${server.origin}/c${i}.html`);
      if (browserCount > 0) {
        expect(response?.status(), head).toBe(500);
      } else {
        expect(response?.status(), head).toBe(200);
        const ids = await page.evaluate(() =>
          [...document.querySelectorAll('meta[name="kurashi-ledger-launch-id"]')].map((m) => m.getAttribute('content')),
        );
        expect(ids, head).toEqual([server.launchId]);
      }
    }
  } finally {
    await server.close();
    tmp.cleanup();
  }
});
