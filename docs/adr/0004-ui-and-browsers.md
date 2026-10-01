# ADR-0004: UI構成と対応ブラウザ

- 状態: Proposed（このPRがmainに統合された時点でAcceptedとみなす）
- 日付: 2026-10-02
- 関連: T00（Issue #1）、ADR-0002、ADR-0003。部品の実装はT08、画面はT10以降。

## 背景

UIはフォームが中心（ソース別の手入力、訂正、照合）で、金額の「不明」と「0」の区別、エラーの関連付け、キーボード操作を確実に扱う必要がある。Figmaの基礎と部品（T04）に沿ってコンポーネントを作り、UIに税式を持たせない（[architecture.md](../architecture.md)）。ADR-0002のとおり、UIはローカルのNode.jsプロセスが配信する静的ファイルとして、利用者の普段のブラウザで開く。

## 決定

- **UIライブラリ:** React（TypeScript、2026-10-02時点で19系、MIT）。サーバーサイドレンダリングやフルスタックフレームワークは使わない。ビルド済みの静的ファイルをADR-0003の境界の内側で配信するSPAにする。
- **ビルド:** Vite（2026-10-02時点で8系、MIT）。ビルドと開発のときだけ使い、実行時の依存にしない。Node.jsは`^20.19.0 || >=22.12.0`を要求するので、ADR-0002の版を満たす。開発サーバーの扱いはADR-0003の10に従う。
- **スタイル:** 素のCSSとCSSカスタムプロパティ。デザイントークンはGit管理のファイルから生成する（T08）。CSSフレームワークやCSS-in-JSは初期範囲に含めない。
- **入れないもの:** 状態管理ライブラリ、UIキット、ルーターの採否は初期には決めない。アクセシブルなフォーム部品の基盤はT08で判断する（第一候補はreact-aria-components、Apache-2.0）。ルーターはT10で、必要になったときに依存を追加するかどうかを判断する。
- **対応ブラウザ:**

| 区分 | ブラウザ | 扱い |
| --- | --- | --- |
| 対応 | Chrome・Edgeの最新安定版（Mac・Windows） | 不具合として修正する。E2EはPlaywrightのChromiumをMac・Windowsで実行する |
| 対応 | Safariの最新メジャー版（Mac。2026-10-02時点で27） | 不具合として修正する。E2EはPlaywrightのWebKitをMacでだけ実行し、リリース前に実機のSafariで手動確認する。PlaywrightのWebKitはSafariより先の開発版で、WindowsのWebKitはSafariの代わりにならない |
| 可能な範囲 | Firefoxの最新安定版 | 動作は目指すが、定常のE2E対象にしない |
| 非対応 | Internet Explorer、各ブラウザの旧版、スマートフォン | [実装計画](../implementation-plan.md)のとおりスマホ専用アプリは初期範囲外 |

- **ビルドターゲット:** Viteの既定値（`baseline-widely-available`。Vite 8ではChrome・Edge 111、Firefox 114、Safari 16.4に相当）を使う。それより古いブラウザ向けのpolyfillは入れない。

### 採用する依存のライセンスとサポート

| 依存 | ライセンス | 版（2026-10-02） | サポート方針 |
| --- | --- | --- | --- |
| React | MIT | 19.3.0 | LTSはない。旧メジャーへは、影響する脆弱性の修正だけが提供される |
| Vite | MIT | 8.3.2 | 定常の修正は最新のマイナー（8.3）だけ。一部の旧版（7.3、8.2等）には重要な修正やセキュリティ修正だけが提供される。ビルド時の依存なので、最新のマイナーへ追従する |
| Playwright | Apache-2.0 | 1.63.0 | 公式の長期サポート方針は確認できない。4〜9週ごとにマイナー版が出て、版ごとに同梱ブラウザが更新される。試験時だけの依存 |
| react-aria-components（候補） | Apache-2.0 | 1.21.1 | T08で判断する |

## 検討した候補

| 候補 | 判断 |
| --- | --- |
| React＋Vite（採用） | フォームとアクセシビリティの部品・試験の資料が多く、別のAIや人が引き継ぎやすい |
| Svelte / Vue（どちらもMIT） | 十分に実用的だが、Reactより優位になる要件が今回ない |
| Preact | 依存は小さいが、React向けの部品を使うと互換層の差異を気にする必要がある。11系が2026-09-30に出たばかり |
| フレームワークなし | 依存は最小だが、フォームの状態管理と再描画を自前で作ることになり、T08・T10の作業量と不具合が増える |
| Next.js等のフルスタック | サーバー機能がADR-0003の境界と重なり、ローカル単一プロセスの構成より大きい |

E2Eの道具の比較:

| 候補 | 判断 |
| --- | --- |
| Playwright（Apache-2.0、採用） | Chromium・Firefox・WebKitを1つの道具で扱え、Mac・Windowsに対応する |
| Cypress（MIT） | WebKitへの対応が実験的で、Safariの代わりの試験に使いにくい |
| WebdriverIO（MIT） | 実ブラウザをWebDriverで操作できるが、ブラウザとドライバの準備が増える |

## 影響

- TypeScriptとlockfileはT02で、ReactとViteは台帳のとおり「初回UI依存追加」としてT08で導入する。lockfileは共有資源なので、同時に変更するのは1名。
- Safari固有の不具合はWebKitのE2Eで検出しきれない可能性がある。リリース前の手動確認を手順に入れる。
- Firefoxで問題が見つかった場合は、対応ブラウザへ格上げするかを所有者が判断する。

## 別タスクで行う検証

- T05: UIが入ったときにE2EをCIへ追加できる構成にする（台帳のT05の検証項目）。
- T08以降: UIが入った時点で、PlaywrightのChromium（Mac/Windows/Linux）とWebKit（Mac）をCIに加える。Firefoxを加える費用も見積もる。
- T08: キーボード操作、フォーカス、エラーの関連付け、金額「不明」と0の入力を、対応ブラウザごとに確認する。
- T13: 対応ブラウザでの通し試験。

## 出典

確認日はすべて2026-10-02。

- 各パッケージの版・ライセンス: https://registry.npmjs.org/react/latest 、https://registry.npmjs.org/vite/latest 、https://registry.npmjs.org/playwright/latest 、https://registry.npmjs.org/react-aria-components/latest 、https://registry.npmjs.org/svelte/latest 、https://registry.npmjs.org/vue/latest 、https://registry.npmjs.org/preact/latest
- サポート方針: https://react.dev/community/versioning-policy 、https://vite.dev/releases 、https://playwright.dev/docs/browsers
- Cypress・WebdriverIO: https://docs.cypress.io/app/references/launching-browsers 、https://github.com/cypress-io/cypress/blob/develop/LICENSE 、https://webdriver.io/docs/automationProtocols 、https://github.com/webdriverio/webdriverio/blob/main/LICENSE
- Viteの要件と既定のビルドターゲット: https://vite.dev/guide/ 、https://vite.dev/config/build-options
- Playwrightの対応OS・ブラウザ、WebKitとSafariの違い: https://playwright.dev/docs/intro 、https://playwright.dev/docs/browsers
- Safari 27: https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes
