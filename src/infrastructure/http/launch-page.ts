// 組込みのページ（ADR-0003の4、ADR-0009）。どれもデータを含まない。
// - 起動用の一時ファイル（file://で開く）: 交換用のページのURL（フラグメントにトークン）へmeta refreshで移る。
// - 交換用のページ（/launch）と、そのスクリプト（/launch.js）: CSPでinlineのscriptを禁止しているので、同じoriginの
//   外部スクリプトだけを使う。スクリプトは、フラグメントのトークンを読み、history.replaceStateでトークンを除いたURLに
//   置き換え、POST /api/sessionでcookieに交換し、location.replaceで画面へ移る。
// - 案内ページ（配信ルートがないときの /）: T26の段階のnpm startで、画面（UI）がまだないことを示す。
// 配信するHTMLには、サーバーが<head>の直後に起動の識別子の<meta>を入れる（static-files.tsのinjectLaunchId）。
import { LAUNCH_ID_HEADER, LAUNCH_ID_META_NAME } from './request-checks.ts';

export const LAUNCH_PATH = '/launch';
export const LAUNCH_SCRIPT_PATH = '/launch.js';
export const EXCHANGE_PATH = '/api/session';

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function launchFileHtml(tokenUrl: string): string {
  const url = escapeHtml(tokenUrl);
  return [
    '<!doctype html>',
    '<html lang="ja"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0;url=${url}">`,
    '<title>Kurashi Ledger</title></head>',
    `<body><p>Kurashi Ledgerを開いています。自動で移らないときは<a href="${url}" rel="noreferrer">ここ</a>を開いてください。</p></body></html>`,
    '',
  ].join('\n');
}

export const LAUNCH_PAGE_HTML = [
  '<!doctype html>',
  '<html lang="ja"><head><meta charset="utf-8">',
  '<title>Kurashi Ledger</title>',
  `<script src="${LAUNCH_SCRIPT_PATH}" defer></script></head>`,
  '<body><p id="status">接続しています…</p></body></html>',
  '',
].join('\n');

export const LAUNCH_SCRIPT = `// 交換用のページ（ADR-0003の4、ADR-0009）。
(() => {
  'use strict';
  const status = document.getElementById('status');
  const show = (text) => {
    if (status !== null) status.textContent = text;
  };
  const token = location.hash.length > 1 ? location.hash.slice(1) : '';
  // 1. トークンを除いたURLに履歴を置き換える（戻る操作でトークン付きのURLに戻らない）。
  history.replaceState(null, '', location.pathname);
  const meta = document.querySelector('meta[name="${LAUNCH_ID_META_NAME}"]');
  const launchId = meta === null ? null : meta.getAttribute('content');
  if (token === '' || launchId === null) {
    show('このURLは使えません。ターミナルでアプリを起動し直してください。');
    return;
  }
  // 2. 同じoriginへのPOSTで、トークンをcookieに交換する（1回だけ使える）。
  fetch('${EXCHANGE_PATH}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', '${LAUNCH_ID_HEADER}': launchId },
    body: JSON.stringify({ token }),
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  }).then(
    (response) => {
      // 3. 画面へ移る。replaceなので、戻る操作でこのページに戻らない。
      if (response.status === 204) {
        location.replace('/');
        return;
      }
      show(response.status === 409
        ? 'アプリが起動し直されています。ターミナルに表示された新しい起動用のファイルを開いてください。'
        : 'この起動用のURLは使用済みか無効です。ターミナルでアプリを起動し直してください。');
    },
    () => show('アプリに接続できません。ターミナルでアプリが動いているか確かめてください。'),
  );
})();
`;

export const PLACEHOLDER_PAGE_HTML = [
  '<!doctype html>',
  '<html lang="ja"><head><meta charset="utf-8">',
  '<title>Kurashi Ledger</title></head>',
  '<body><h1>Kurashi Ledger</h1>',
  '<p>サーバーは動いています。画面（UI）はまだありません（T08以降で加えます）。</p>',
  '<p>終了するには、起動したターミナルでCtrl+Cを押してください。</p></body></html>',
  '',
].join('\n');
