// 照合（e2e/strict-reporter.ts）の回帰試験の合成の試験（PR18-R002）。ブラウザを使わない。
// KL_REPORTER_CASE で、成功・失敗・期待した失敗（test.fail()）・skip・flaky・中断を作る。
import { expect, test } from '@playwright/test';

const reporterCase = process.env['KL_REPORTER_CASE'] ?? 'pass';

test('照合の回帰試験の合成の試験', async () => {
  switch (reporterCase) {
    case 'pass':
      break;
    case 'fail':
      expect(1).toBe(2);
      break;
    case 'expected-failure':
      // 失敗を期待して、実際に失敗する。Playwright自身はこの試験を「期待どおり」として全体をpassedにする。
      test.fail();
      expect(1).toBe(2);
      break;
    case 'skip':
      test.skip(true, '合成のskip');
      break;
    case 'flaky':
      // 1回目だけ失敗し、再試行で合格する（設定でretriesを1にする）。
      expect(test.info().retry).toBe(1);
      break;
    case 'interrupted':
      // 全体の時間の上限（設定のglobalTimeout）で止められる。
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      break;
    default:
      throw new Error(`知らない場合: ${reporterCase}`);
  }
});
