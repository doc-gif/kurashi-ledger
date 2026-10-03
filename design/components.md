# 部品の仕様（T04）

Figmaの「02 部品 Components」（`5:107`）にある3部品の仕様。部品の実装（HTML・React）はT08で行う。ここでは、状態の見た目・キーボード操作・アクセシビリティ・文言を決める。FigmaのIDは [figma-map.json](figma-map.json)、トークンは [tokens.json](tokens.json)。表のトークン名はFigmaの変数名（`color.`を省略）。

## 全部品に共通の決まり

- **状態を色だけで表さない。** 文言（日本語）、アイコン、線の形（破線・太さ）、フォーカスリングのどれかを必ず組み合わせる。
- **キーボードだけで全操作できる。** Tabの順序は画面の見た目の順と一致させる。独自のショートカットはT04では定義しない。
- **フォーカス:** フォーカスを受ける要素（ボタン、入力欄、チェックボックス）ごとに、`:focus-visible`のときに部品の外側に2pxの透明な隙間を空けて2pxのリングを出す（`outline: var(--focus-ring-width) solid var(--color-focus-ring); outline-offset: var(--focus-ring-offset)`）。隙間には置いた場所の背景が見えるので、リングのコントラストは背景（`bg/canvas`・`bg/surface`・`bg/subtle`、いずれも6:1以上）に対して確かめる。`outline: none`で消さず、`box-shadow`で代用しない（強制カラーモードで消えるため）。Figmaではエフェクトスタイル`focus/ring`で、透明な隙間を描けないため隙間を`bg/surface`の色で描いている。
- **無効:** 面（`bg/disabled`）と文字（`text/disabled`）に加えて、破線の枠（`border/disabled`、破線4px・間隔3px）で示す。HTMLの`disabled`属性を使い、読み上げに無効だと伝える。無効の理由が分かりにくい場面では、無効にせず操作時にエラーを示すことを優先する。
- **境界線と外寸:** 境界線は部品の内側に描く。ボタン・入力欄の外寸（境界線を含む大きさ）は最小40px。余白は外寸の端から測り、境界線は余白の内側に重なる（Figmaでは線をレイアウトに含めない設定）。CSSでは`box-sizing: border-box`で、余白から線の太さを引く（例: 上下 8px − 1px = 7px）。エラーで線が2pxになっても、外寸と文字の位置を変えない。
- **アイコン:** 16px、線1.5px。意味は隣の文言で伝え、アイコン自体は読み上げない（`aria-hidden="true"`）。
- **文言:** 日本語。ボタンは「保存する」のように動詞で終える。エラーは「エラー:」で始め、直し方を書く。

## Button

Figma: component set `7:45`。プロパティ: `Variant`、`State`、`Label`（文言）。

| Variant | 用途 | 通常 | ホバー | 押下中 |
| --- | --- | --- | --- | --- |
| Primary（主） | 画面の主な操作。原則1画面に1つ | 面`bg/accent`、文字`text/on-accent` | 面`bg/accent-hover` | 面`bg/accent-pressed` |
| Secondary（副） | 補助の操作（キャンセル等） | 面`bg/surface`、枠`border/control`、文字`text/primary` | 面`bg/neutral-hover` | 面`bg/neutral-pressed` |
| Danger（危険） | 削除・上書き等の取り消しにくい操作 | 面`bg/danger`、文字`text/on-danger` | 面`bg/danger-hover` | 面`bg/danger-pressed` |

| State | 見た目（色以外の手がかり） |
| --- | --- |
| Default | 上の表のとおり |
| Hover / Pressed | 面の色だけが変わる。ポインター操作の一時的な手応えで、情報を伝える状態ではない |
| Focus | 通常の見た目＋フォーカスリング（形が増える） |
| Disabled | Variantによらず同じ。面`bg/disabled`、文字`text/disabled`、破線の枠 |

- 寸法: 外寸の高さは境界線を含めて最小40px（`size/control-height`）。余白は外寸の端から左右20px（`space/5`）、上下8px（`space/2`）。角丸6px（`radius/md`）、文字`typography.label.m`（16px・Medium、行の高さ24px）。
- 長い文言: 幅が足りないときは折り返して高さが伸びる（省略しない）。幅が狭い画面ではボタンを縦に並べ、主な操作を上に置く（Figma `15:195`）。
- キーボード: Tabでフォーカス、EnterまたはSpaceで実行。
- HTML: `<button>`を使い、`type`（`button`/`submit`）を明示する。`<div>`等にクリック処理を付けない。
- Danger: 押したあとの確認（何が消えるかを文言で示す）は画面側の仕様で決める。ボタンの色だけで危険さを伝えない。

## Amount Input

Figma: component set `8:210`。プロパティ: `Value`（下の「値の状態」）、`State`（下の「操作の状態」）、`Label`、`Hint`、`Show hint`、`Allow unknown`。使ってよい組合せは、下の「組合せの規則」だけから決まる。Figmaのバリアントは`Allow unknown`=trueの場合の組合せで、node IDの一覧は [figma-map.json](figma-map.json) にある。

### 構成

1. ラベル（`typography.label.s`）。`<label>`で入力欄に関連付け、入力欄とチェックボックスをまとめたグループの名前にもする（例: `<fieldset>`の`<legend>`）。不明のあいだ入力欄がTab順から外れても、チェックボックスがどの項目のものかが読み上げで分かるようにする。
2. 補足（任意、`typography.caption`）。入力欄の`aria-describedby`に含める。
3. 入力欄: 金額（`typography.amount.m`、等幅数字・右揃え・3桁区切り）＋単位「円」（右端、`text/secondary`）。単位は入力値に含めず、`aria-describedby`等で入力欄の説明に含める。
4. チェックボックス「金額がわからない（不明として記録）」。ネイティブの`<input type="checkbox">`。不明を認めない項目では出さない（`Allow unknown` = false。項目ごとの可否はT09・T10で決める）。
5. エラーの文言（State=Errorのときだけ）: エラーのアイコン＋「エラー: 」で始まる文言（`text/danger`）。

### 値の状態（0と不明を区別する）

| Value | 意味 | 入力欄の見た目 | チェックボックス |
| --- | --- | --- | --- |
| Empty（空欄） | まだ入力していない編集中の状態。保存しない（下記） | 空。単位「円」だけ表示。入力例を値のように見せない | 未チェック |
| Amount | 金額が分かっている | 「123,456 円」 | 未チェック |
| Zero | 金額が0円だと分かっている（known 0） | 「0 円」。ほかの金額と同じ黒・等幅 | 未チェック |
| Unknown（不明） | 金額が分からない。0として計算しない | 面`bg/subtle`、「(?) 不明」（`text/secondary`）。単位「円」は出さない | チェック済み（面`bg/accent`、白いチェック） |

- 「不明」を記録する手段はチェックボックスだけにする。入力欄に「不明」と打たせない。
- 不明のあいだ、入力欄は**Tab順から外し、フォーカスを受けない**。表示は「(?) 不明」（読み取り専用の表示で、クリックしても何も起きない）。部品が有効なあいだ（State≠Disabled）は、この入力欄を無効（disabled）としては読み上げず、不明であることはグループ名とチェック済みのチェックボックスで伝える。部品全体がDisabledのとき（Value=Unknown × State=Disabled を含む）は、共通の「無効」の決まりに従い、グループとチェックボックスを無効として伝える（「不明」でチェック済みであることも伝える）。実現の方法（入力要素を置かない等）はT08で選ぶ。
- チェックを外すと空欄（Empty）に戻り、入力欄がTab順に戻る。0にはしない。
- **Emptyは保存しない編集中の状態。** T01の契約（未入力は`unknown`）に合わせ、Emptyを独立した状態として保存しない。0としても保存しない。保存して再表示した状態は、保存した状態と一致させる（不明として保存したものは、チェック済みの「不明」として表示する）。利用者に知らせずに状態を変えない。
- 保存するときのEmptyの扱いは項目によって異なる。不明として保存し、そのことを画面で示すか、エラーで止めて金額の入力か「金額がわからない」の選択を求めるかを、T08で決める（[タスク台帳](../docs/implementation-tasks.md)のT08節の受入条件。項目ごとの規則はT09・T10）。FigmaのValue=Empty × State=Errorは、エラーで止める場合の見た目。
- 表示用の文字（カンマ・「円」・「不明」）を計算に使わない（T08の受入条件）。入力として受け付ける文字（全角数字の扱い等）と負の金額の可否は、項目ごとにT08・T09で決める。負の金額を表示するときは「−1,234 円」（U+2212）と書き、符号を色だけで示さない。
- 一覧での表し方（対象外は「—」と「対象外」バッジ）はFigmaの「01 基礎」の「金額の表示」（`12:136`）。Emptyは保存しないので、保存した記録の一覧には出ない。

### 操作の状態

| State | 見た目（色以外の手がかり） | 補足 |
| --- | --- | --- |
| Default | 枠`border/control`（1px） | |
| FocusInput | 入力欄にフォーカスリング | 入力位置（キャレット）を表示 |
| FocusCheckbox | チェックボックスにフォーカスリング | チェックの有無は別に示す |
| Error | 枠`border/danger`を**2px**にする＋エラーのアイコン＋「エラー: 」で始まる文言 | 入力欄に`aria-invalid="true"`、文言のidを`aria-describedby`に含める |
| Disabled | 面`bg/disabled`、文字`text/disabled`、入力欄とチェックボックスの**破線**の枠 | ラベル・補足も`text/disabled`。`<fieldset disabled>`等で全体を無効にする |

### 組合せの規則

`Value`・`State`・`Allow unknown`の組合せは、次の規則だけから決める（この表が正）。どの規則にも当てはまらない組合せは使ってよい（DefaultとDisabledには条件がない）。

| 対象 | 必要な条件 | 理由 |
| --- | --- | --- |
| `Value=Unknown` | `Allow unknown=true` | 不明はチェックボックスでしか記録しない |
| `State=FocusInput` | `Value≠Unknown` | 不明のあいだ入力欄はフォーカスを受けない |
| `State=Error` | `Value≠Unknown` | 不明は入力の誤りではない（下記） |
| `State=FocusCheckbox` | `Allow unknown=true` | チェックボックスがあるときだけフォーカスできる |

- Figmaのバリアントは、`Allow unknown=true`でこの規則を満たす組合せ（[figma-map.json](figma-map.json) の`variants`）。`Allow unknown`はブール値のプロパティなので、Figmaでは不正な組合せを選べてしまう。falseにするときは`Value=Unknown`と`State=FocusCheckbox`を選ばない。
- [figma-map.json](figma-map.json) の`combinationRule`は、この表と同じ規則を機械で読める形で書いたもの。

**不明はエラーにしない。** 不明は記録として正しい値で、入力の誤りではない（未知値を0にせず、足りない入力からは不完全・暫定の結果を出す。[AGENTS.md](../AGENTS.md)、[testing.md](../docs/testing.md)）。計算に使えないことは結果の側（Status Badge「不明」と説明。Figma `13:74`）で示す。不明を認めない項目では、チェックボックスを出さない（`Allow unknown` = false）ので、Unknownの値にならない。このため、エラーになるのは入力欄がフォーカスを受けられる値（Empty / Amount / Zero）のときだけで、エラーの文言は常に入力欄に関連付けられ、保存時のフォーカス先も常に入力欄になる。

フォーカスとエラーは同時に起きる。エラーの入力欄にフォーカスがあるときは、赤い2pxの枠とフォーカスリングを両方出す（Figmaでは組合せのバリアントを作らず、この規則で表す）。

### キーボード

- Tabの順序: 入力欄 → 「金額がわからない」 → 次の項目。不明のあいだは「金額がわからない」 → 次の項目（入力欄を飛ばす）。
- Spaceでチェックボックスを切り替える。切り替えてもフォーカスはチェックボックスに残し、入力欄へ自動で移さない（チェックを外したあとはShift+Tabで入力欄へ戻る）。
- エラーの表示は、入力中の1文字ごとではなく、フォーカスが離れたときか保存しようとしたときに行う。保存時にエラーがあれば、最初のエラーの入力欄へフォーカスを移す（エラーはEmpty / Amount / Zeroにしか起きないので、入力欄は必ずフォーカスを受けられる）。
- `Allow unknown` = false の項目では、Empty のエラー文言から「金額がわからない」の案内を除く（例: 「エラー: 金額を入力してください」）。

### 寸法

入力欄の外寸の高さは境界線を含めて最小40px（エラーの2pxの線でも変えない）、左右の余白12px（`space/3`、外寸の端から測る）、角丸6px（`radius/md`）、各行の間隔8px（`space/2`）、チェックボックス20px（`size/checkbox`、角丸4px）。Figmaの部品の幅は320px（利用時は親の幅に合わせて伸ばす）。

## Status Badge

Figma: component set `6:58`。プロパティ: `Status`。

| Status | 文言 | アイコン | 面 / 枠 / 文字 | 色以外の手がかり |
| --- | --- | --- | --- | --- |
| Confirmed | 確定 | チェック | `bg/accent-subtle` / `border/accent-subtle` / `text/accent` | 文言＋チェック |
| Forecast | 見込み | 時計 | `bg/surface` / `border/control`（破線） / `text/secondary` | 文言＋時計＋破線の枠 |
| Unknown | 不明 | 疑問符 | `bg/subtle` / `border/subtle` / `text/secondary` | 文言＋疑問符 |
| NeedsReview | 要確認 | 三角の注意 | `bg/warning-subtle` / `border/warning-subtle` / `text/warning` | 文言＋三角 |
| Error | エラー | 丸の感嘆符 | `bg/danger-subtle` / `border/danger-subtle` / `text/danger-strong` | 文言＋丸の感嘆符 |
| NotApplicable | 対象外 | 横線 | `bg/surface` / `border/subtle` / `text/secondary` | 文言＋横線 |

- 寸法: 高さ24px（`size/badge-height`）、左右の余白8px、アイコンと文言の間4px、角丸4px（`radius/sm`）、文字`typography.label.xs`（12px・Bold）。
- 表示専用で、フォーカスを受けない。文言はそのまま読み上げる。表の列見出し（例: 「状態」）など、何の状態かが周りから分かるように置く。
- 金額の横に置くときは、金額の表示と矛盾させない（例: 金額が「不明」なら「確定」を付けない）。合計に不明が含まれるときは、合計に「不明」バッジと説明を付け、確定値に見せない（Figma `13:74`）。
- これらの状態とT01の契約（unknown / not-stated / not-applicable / known(0)、実績・見込み・正式通知）との対応は、T08で決めて、この文書に記録する（[タスク台帳](../docs/implementation-tasks.md)のT08節の受入条件。T08はT01に依存する）。

## T08で確かめること

- 対応ブラウザ（Chrome・Edge・Safari）で、Tab順、Space・Enterの操作、フォーカスリング、エラーの読み上げ（`aria-invalid`・`aria-describedby`）を確かめる。
- Windowsの強制カラーモードで、フォーカス（`outline`）・入力欄の枠・チェックボックスが見えることを確かめる。
- 金額の不明と0、空欄と0が、保存・再表示で区別されたままであることを確かめる。
