// HTTPの境界の試験（T26）で使う合成の固定のスクリプト。起動の識別子を<meta>から読み、APIの要求に付ける。
// APIのパス（/api/test/...）は、試験の中だけで登録する合成のもので、製品のAPIではない。
(() => {
  'use strict';
  const meta = document.querySelector('meta[name="kurashi-ledger-launch-id"]');
  const launchId = meta === null ? '' : meta.getAttribute('content');
  const state = document.getElementById('state');
  const mutation = document.getElementById('mutation');
  const describe = (status) => (status === 200 ? '接続済み' : status === 409 ? '再読み込みしてください' : `拒否: ${status}`);
  const check = () =>
    fetch('/api/test/state', { headers: { 'Kurashi-Ledger-Launch-Id': launchId }, credentials: 'same-origin', cache: 'no-store' }).then(
      (r) => {
        state.textContent = describe(r.status);
      },
      () => {
        state.textContent = '接続できない';
      },
    );
  const mutate = () =>
    fetch('/api/test/mutate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Kurashi-Ledger-Launch-Id': launchId },
      body: JSON.stringify({ value: 'synthetic' }),
      credentials: 'same-origin',
      cache: 'no-store',
    }).then(
      (r) => {
        mutation.textContent = describe(r.status);
      },
      () => {
        mutation.textContent = '接続できない';
      },
    );
  document.getElementById('check').addEventListener('click', () => void check());
  document.getElementById('mutate').addEventListener('click', () => void mutate());
  void check();
})();
