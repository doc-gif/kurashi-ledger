# デザインの基礎と部品（T04）

T04「Figmaの基礎と最初の3部品」（Issue #7）の成果物。Figmaで定義した色・文字・余白・角丸・線・フォーカスと、3つの部品（Button / Amount Input / Status Badge）を、コード側（T08）が使える形で記録する。部品の実装はT08で行い、ここには含めない。

## ファイル

| ファイル | 内容 |
| --- | --- |
| [tokens.json](tokens.json) | 機械可読のデザイントークン。Figmaの各変数・各テキストスタイルには対応するトークンが1つずつある。書体（`font.*`）はFigmaの変数を持たない共通の定義で、エフェクトスタイル`focus/ring`は複数のトークンの組（下の「Figmaとの名前の対応規則」） |
| [figma-map.json](figma-map.json) | FigmaのID（変数・スタイル・ページ・部品・バリアント）と、トークン名・CSS変数名の対応表 |
| [components.md](components.md) | 3部品の仕様（状態、キーボード操作、アクセシビリティ、文言） |

## Figmaファイル

所有者のFigmaファイル（URLは公開しない）「Kurashi Ledger — Design System」。2026-10-02の所有者決定により、このrepo・Issue・PRにはファイルのURLを載せず、node IDだけを記録する。node IDは、このファイルを開ける人がFigmaで使う。共有設定はT04で変更していない。

| ページ | node ID | 内容 |
| --- | --- | --- |
| 00 表紙 Cover | `0:1` | 目的、ページ一覧、原則、一方向の更新手順 |
| 01 基礎 Foundations | `5:106` | 色（原色・用途別）、コントラストの確認、文字、余白・角丸・線、フォーカス、金額の表示規則 |
| 02 部品 Components | `5:107` | アイコン、Status Badge、Button、Amount Input。状態の定義は [components.md](components.md)、バリアントとnode IDは [figma-map.json](figma-map.json) |
| 03 利用例 Usage | `5:108` | 給与明細の入力フォーム、キーボード操作の想定、金額の一覧（桁揃え）、日本語の長文と拡大の確認 |

部品・説明用フレームのnode IDは [figma-map.json](figma-map.json) の `components` と `documentationFrames` にある。値・勤務先はすべて合成（架空）で、実際の給与・勤務先・氏名は使っていない。

## トークンの形式

[W3C Design Tokens Community Group](https://www.designtokens.org/)（DTCG）の記法（`$type`・`$value`・`$description`、別名参照`{...}`）を借りた、**このプロジェクト独自の形式**とする。DTCGの現行の仕様（2025.10版）では色と寸法の値をオブジェクトで書くが、ここでは下のとおり文字列で書くので、DTCGの検証器や変換器へそのままは渡せない。DTCGの値の形へ変換するか、独自の形式のまま読む変換を作るかは、CSSの生成方法と一緒にT08で決める。

- 色の値は16進の文字列（`"#16645D"`）。寸法は`"4px"`のような文字列。行の高さは倍率の数値（`1.75`）。
- 金額用の文字（`typography.amount.*`）は、等幅数字の指定を`$extensions`の`io.github.doc-gif.kurashi-ledger.fontVariantNumeric`に書く。
- 書体の`$value`はCSSのfont-familyの並び（先頭のNoto Sans JPはFigmaで使う代表の書体）。

Figmaとの名前の対応規則:

| Figma | トークン | CSS変数（Figmaのcode syntaxと同じ） |
| --- | --- | --- |
| Primitives の `gray/50` | `color.gray.50` | `--color-gray-50` |
| Color の `bg/canvas` | `color.bg.canvas` | `--color-bg-canvas` |
| Dimension の `space/4` | `space.4` | `--space-4` |
| テキストスタイル `amount/m` | `typography.amount.m` | （CSS変数にはしない。T08で決める） |
| エフェクトスタイル `focus/ring` | `color.focus.ring`、`focus.ring-width`、`focus.ring-offset` の組 | `outline`と`outline-offset`で表す。隙間は透明（下の「フォーカスリング」） |
| （対応するFigmaの変数なし） | `font.family.base`、`font.weight.*` | テキストスタイルの書体と太さとして参照される共通の定義（Figmaではテキストスタイルの中に持つ）。CSS変数にするかはT08で決める |

変数のコレクション:

- **Primitives**（モード: Value）: 原色。部品や画面から直接参照しない。Figmaでは選択肢に出ない設定（scopes空）。
- **Color**（モード: Light）: 用途別の色。Primitivesへの別名だけで、値を直接持たない。ダークモードは対象外（Lightのみ）。
- **Dimension**（モード: Value）: 余白（4px単位）、角丸、線の太さ、フォーカス、部品の寸法。

### フォーカスリング

実装は`outline: var(--focus-ring-width) solid var(--color-focus-ring); outline-offset: var(--focus-ring-offset)`とし、部品とリングの間の2pxの隙間は**透明**にする（置いた場所の背景がそのまま見える）。`box-shadow`で白い隙間を描く方式は、Windowsの強制カラーモードで消えるため使わない（`outline`はシステムの色で描かれる）。

- リングは、隙間とその外側の両方で、置いた場所の背景と接する。そのためコントラストは「リングと背景」で確かめる。部品を置いてよい背景は`bg/canvas`・`bg/surface`・`bg/subtle`で、いずれも6:1以上（下の表）。ほかの色の面の上に部品を置くときは、確かめ直す。
- Figmaでは透明な隙間を描けないため、エフェクトスタイル`focus/ring`の隙間の影を`bg/surface`（白）の色で描いている。白以外の背景では、Figmaの見た目と実装の見た目が隙間の色だけ異なる。

## 色の方針

- 白・グレーが基調。青緑（teal）は主ボタン・チェック済み・「確定」・フォーカスだけに使う。
- 赤はエラーと取り消しにくい操作（Danger）、黄土色（amber）は「要確認」だけに使う。この2色を白・グレー＋少量の青緑に加えることは、所有者が2026-10-02に承認した。
- 状態は色だけで表さない。文言・アイコン・線の形（破線・太さ）・フォーカスリングを必ず組み合わせる（詳細は [components.md](components.md)）。
- 入力欄・副ボタン・チェックボックスの境界は`border/control`（白の上で3.89:1）を使う。`border/subtle`は装飾の区切り線だけに使い、操作できる部品の境界には使わない。

## コントラストの確認（WCAG 2.2 AA）

sRGBの相対輝度から`(L1 + 0.05) / (L2 + 0.05)`で計算し、小数第3位を四捨五入した。基準は、文字が4.5:1（1.4.3）、部品の境界・状態を示す図形が3:1（1.4.11）。無効な部品は基準の対象外だが参考に記録した。表の名前はFigmaの変数名（トークン名は先頭に`color.`を付け、`/`を`.`にしたもの）。同じ表を、変数に結び付けた見本付きでFigmaの「01 基礎」（`11:2`）に置いた。

結果: 基準のある組はすべて合格。最小は`border/control` on `bg/canvas`の3.62:1（基準3:1）、文字の最小は`text/placeholder` on `bg/surface`の5.99:1（基準4.5:1）。

| 前景 | 背景 | 比 | 基準 | 判定 | 用途 |
| --- | --- | ---: | --- | --- | --- |
| `text/primary` (#1B2020) | `bg/surface` (#FFFFFF) | 16.48:1 | 4.5:1 | 合格 | 本文・ラベル・金額 |
| `text/primary` (#1B2020) | `bg/canvas` (#F6F7F7) | 15.36:1 | 4.5:1 | 合格 | 画面背景の上の本文 |
| `text/primary` (#1B2020) | `bg/subtle` (#EDEFEF) | 14.28:1 | 4.5:1 | 合格 | 区切られた領域の本文 |
| `text/primary` (#1B2020) | `bg/neutral-hover` (#EDEFEF) | 14.28:1 | 4.5:1 | 合格 | 副ボタン（ホバー） |
| `text/primary` (#1B2020) | `bg/neutral-pressed` (#DCE0E0) | 12.39:1 | 4.5:1 | 合格 | 副ボタン（押下中） |
| `text/secondary` (#444C4C) | `bg/surface` (#FFFFFF) | 8.81:1 | 4.5:1 | 合格 | 補足・単位「円」・「見込み」「対象外」バッジ |
| `text/secondary` (#444C4C) | `bg/canvas` (#F6F7F7) | 8.21:1 | 4.5:1 | 合格 | 画面背景の上の補足 |
| `text/secondary` (#444C4C) | `bg/subtle` (#EDEFEF) | 7.63:1 | 4.5:1 | 合格 | 「不明」の入力欄・「不明」バッジ |
| `text/placeholder` (#5C6565) | `bg/surface` (#FFFFFF) | 5.99:1 | 4.5:1 | 合格 | 入力例 |
| `text/on-accent` (#FFFFFF) | `bg/accent` (#16645D) | 6.97:1 | 4.5:1 | 合格 | 主ボタン |
| `text/on-accent` (#FFFFFF) | `bg/accent-hover` (#104F49) | 9.39:1 | 4.5:1 | 合格 | 主ボタン（ホバー） |
| `text/on-accent` (#FFFFFF) | `bg/accent-pressed` (#0B3C37) | 12.24:1 | 4.5:1 | 合格 | 主ボタン（押下中） |
| `text/on-danger` (#FFFFFF) | `bg/danger` (#A93224) | 6.63:1 | 4.5:1 | 合格 | 危険ボタン |
| `text/on-danger` (#FFFFFF) | `bg/danger-hover` (#8B271B) | 8.74:1 | 4.5:1 | 合格 | 危険ボタン（ホバー） |
| `text/on-danger` (#FFFFFF) | `bg/danger-pressed` (#6F1E14) | 11.22:1 | 4.5:1 | 合格 | 危険ボタン（押下中） |
| `text/accent` (#104F49) | `bg/accent-subtle` (#EAF5F3) | 8.43:1 | 4.5:1 | 合格 | 「確定」バッジ |
| `text/accent` (#104F49) | `bg/surface` (#FFFFFF) | 9.39:1 | 4.5:1 | 合格 | リンク |
| `text/danger` (#A93224) | `bg/surface` (#FFFFFF) | 6.63:1 | 4.5:1 | 合格 | エラーの文言 |
| `text/danger` (#A93224) | `bg/canvas` (#F6F7F7) | 6.17:1 | 4.5:1 | 合格 | 画面背景の上のエラーの文言 |
| `text/danger-strong` (#8B271B) | `bg/danger-subtle` (#FCEEEC) | 7.73:1 | 4.5:1 | 合格 | 「エラー」バッジ |
| `text/warning` (#7A4E00) | `bg/warning-subtle` (#FDF4E1) | 6.58:1 | 4.5:1 | 合格 | 「要確認」バッジ |
| `text/disabled` (#7A8383) | `bg/disabled` (#EDEFEF) | 3.37:1 | — | 参考（無効は対象外） | 無効な部品。WCAG 1.4.3の対象外だが3:1以上を確保 |
| `text/disabled` (#7A8383) | `bg/surface` (#FFFFFF) | 3.89:1 | — | 参考（無効は対象外） | 無効なラベル |
| `border/control` (#7A8383) | `bg/surface` (#FFFFFF) | 3.89:1 | 3.0:1 | 合格 | 入力欄・副ボタン・チェックボックスの境界 |
| `border/control` (#7A8383) | `bg/canvas` (#F6F7F7) | 3.62:1 | 3.0:1 | 合格 | 画面背景の上の入力欄の境界 |
| `border/danger` (#A93224) | `bg/surface` (#FFFFFF) | 6.63:1 | 3.0:1 | 合格 | エラーの入力欄の境界 |
| `focus/ring` (#16645D) | `bg/surface` (#FFFFFF) | 6.97:1 | 3.0:1 | 合格 | フォーカスリングと白い面（隙間は透明で、置いた場所の背景が見える） |
| `focus/ring` (#16645D) | `bg/canvas` (#F6F7F7) | 6.49:1 | 3.0:1 | 合格 | フォーカスリングと画面背景 |
| `focus/ring` (#16645D) | `bg/subtle` (#EDEFEF) | 6.03:1 | 3.0:1 | 合格 | フォーカスリングと区切られた領域・「不明」の入力欄の面 |
| `bg/accent` (#16645D) | `bg/surface` (#FFFFFF) | 6.97:1 | 3.0:1 | 合格 | チェック済みのチェックボックス |
| `icon/on-accent` (#FFFFFF) | `bg/accent` (#16645D) | 6.97:1 | 3.0:1 | 合格 | チェックボックスのチェック |
| `icon/accent` (#104F49) | `bg/accent-subtle` (#EAF5F3) | 8.43:1 | 3.0:1 | 合格 | 「確定」バッジのアイコン |
| `icon/secondary` (#444C4C) | `bg/subtle` (#EDEFEF) | 7.63:1 | 3.0:1 | 合格 | 「不明」のアイコン |
| `icon/secondary` (#444C4C) | `bg/surface` (#FFFFFF) | 8.81:1 | 3.0:1 | 合格 | 「見込み」「対象外」のアイコン |
| `icon/warning` (#7A4E00) | `bg/warning-subtle` (#FDF4E1) | 6.58:1 | 3.0:1 | 合格 | 「要確認」のアイコン |
| `icon/danger` (#A93224) | `bg/danger-subtle` (#FCEEEC) | 5.86:1 | 3.0:1 | 合格 | 「エラー」バッジのアイコン |
| `icon/danger` (#A93224) | `bg/surface` (#FFFFFF) | 6.63:1 | 3.0:1 | 合格 | エラーの文言のアイコン |
| `border/disabled` (#C4CACA) | `bg/surface` (#FFFFFF) | 1.66:1 | — | 参考（無効は対象外） | 無効な部品の破線の枠。1.4.11の対象外 |

バッジの枠（`border/accent-subtle`等）は装飾で、状態は文言とアイコンで示すため、3:1の対象にしていない。ホバー・押下中の面の変化はポインター操作の一時的な手応えで、情報を伝える状態ではない。

## 一方向の更新手順（Figma → レビュー済みPR → トークン）

変更の起点はFigma。コードは`tokens.json`だけを参照し、コードの変更をFigmaへ書き戻さない。

1. 担当を決める。Figmaの同じファイルを同時に編集するのは1名（[AGENTS.md](../AGENTS.md)、[GitHub・複数AIの運用](../docs/github-agent-operations.md)）。Issueに担当・範囲を書く。
2. Figmaで変数・スタイル・部品を変更する。名前や値を変えるときは、削除して作り直さずに同じ変数を直す（IDを保つ）。使わなくなった変数を消すときは、`tokens.json`と対応表からも消す。
3. 同じ内容を`tokens.json`と`figma-map.json`に反映する。変数・スタイル・部品を追加・削除したら、IDも対応表に書く。部品の状態・操作が変わったら`components.md`も直す。
4. 色を変えたらコントラストを計算し直し、この文書の表とFigmaの表（`11:2`）を直す。
5. Figmaのスクリーンショットで実物を確かめ、確かめた範囲をPRに書く。画像ファイルは、T02で`.gitignore`の除外（`*.png`等）を直すまでcommitしない。
6. 別の担当のレビューを受ける。レビューとマージは [AGENTS.md](../AGENTS.md) と [docs/pr-review-loop.md](../docs/pr-review-loop.md) の手順に従う。マージ後、T08以降のコードは`tokens.json`からCSS等を作る（作り方はT08で決める）。

コード側で新しい値が必要になったら、先にFigmaで定義し、上の手順で`tokens.json`に入れる。コードにトークンの値を直接書かない。

## 検証の記録（2026-10-03、日本時間。UTCでは2026-10-02）

- **スクリーンショット:** Figmaのスクリーンショットで、表紙、基礎・部品・利用例の全てのフレームと区画を目視で確認した（node IDは`figma-map.json`の`documentationFrames`）。レビュー対応で変えたフレーム（Amount Inputの区画、基礎のフォーカス・余白・コントラスト、利用例のキーボード操作）は、変更後に撮り直して確認した。画像はrepoにcommitしていない（上記の理由）。
- **コントラスト:** 上の表のとおり。基準のある組はすべて合格。
- **日本語の長文:** 幅360pxのフレーム（`15:105`）に、長いラベル・補足・エラー文・チェックボックスの文言と、長い文言のボタン2つを置き、折り返して高さが伸びることを確認した。
- **拡大:** 200%拡大相当（幅640px、`15:165`）と400%拡大相当（幅320px、`15:195`。WCAG 1.4.10 Reflow）のフレームで、横スクロールなしに折り返すことを確認した。幅が足りないときはボタンを縦に並べる。
- **見切れの自動確認:** 4ページの全ての文字について、文字の省略設定がないこと、幅が潰れていないこと、切り抜く親の外にはみ出していないことをFigmaのPlugin APIで調べた。最初の確認で、基礎の「金額の表示」で「0 円」の見本1件が枠からはみ出していたので直した。レビュー対応の後も、変えたページを再確認して0件（確認した数はPRの引継ぎに記録する）。
- **等幅数字:** Noto Sans JPで「1111111111」「0000000000」「8888888888」の幅が同じ（20pxで111px）ことをFigmaで確かめた。
- **トークンとの対応:** `tokens.json`の値・別名と`figma-map.json`のIDを、Figmaから読み出した全ての変数・テキストスタイル・エフェクトスタイルと部品のバリアントに照合し、一致を確認した。

## T08への引継ぎと未決事項

### T08の受入条件として引き継ぐもの

実現の方式はT08で選んでよいが、次の条件は変えない。

- **フォーカス:** `outline`と透明な隙間で実装し（上の「フォーカスリング」）、入力欄・チェックボックス・ボタンのそれぞれで`:focus-visible`のリングが出ること、Windowsの強制カラーモードでもリングが見えることを確かめる。
- **不明のときの入力欄:** Tab順から外れ、フォーカスを受けないこと。部品が有効なあいだは無効（disabled）として読み上げないこと。不明であることは、グループ名（ラベル）とチェック済みの「金額がわからない（不明として記録）」で伝わること。部品全体がDisabledのとき（Unknownを含む）は、グループとチェックボックスが無効として伝わること。実現の方法（入力要素を置かない、`<fieldset>`と`<legend>`で囲む等）はT08で選ぶ（[components.md](components.md#amount-input)）。
- **外寸:** ボタン・入力欄の外寸が境界線を含めて最小40pxであること、エラーで線が2pxになっても外寸と文字の位置が変わらないこと。
- **状態の対応:** Status Badgeの状態と、T01の契約の金額・記録の状態（unknown / not-stated / not-applicable / known(0)、実績・見込み・正式通知）の対応を決め、not-statedに専用の表示が要るかを含めて、`components.md`とこのREADMEに記録すること。これは[タスク台帳](../docs/implementation-tasks.md)のT08節の受入条件で、T08はT01に依存する。
- **トークンの読み込み:** 選んだ変換方法で`tokens.json`（独自の形式）を読み込めること。DTCGの値の形へ変える場合は、`tokens.json`と`figma-map.json`を同じPRで直し、値が変わらないことを確かめる。

### T08で決めること

- **書体:** 外部から読み込まない方針（ADR-0003）のため、Noto Sans JPを同梱するか、OSの書体（Hiragino Sans、Yu Gothic UI等）に任せるかをT08で決める。OSの書体で`tabular-nums`が効くかを対応ブラウザで確かめる。
- **CSSの生成:** `tokens.json`からCSSカスタムプロパティを作る方法（自作の小さな変換か、Style Dictionary等の依存か）はT08で決める。文字の大きさはrem（16px基準）に変換し、利用者の文字サイズ設定に従わせる。
- **コントラストの自動検査:** 色を変えたときの再計算は現在は手作業。T08以降で`tokens.json`から計算する試験を加えることを提案する。

### 対象外

ダークモード、全画面・全状態のデザイン、部品の実装、ライブラリの公開。
