# 合成データと期待結果の台帳

T03「合成データと期待結果の台帳」の成果物。関連Issue: [#22](https://github.com/doc-gif/kurashi-ledger/issues/22)。対象の契約は[記録・照合・計算結果の契約](../contracts/README.md)の契約版`1.0`。

この台帳は、契約の合成例（EX-01〜EX-09）と、T01のレビューで固めた規則を、試験の入力と期待値として読める形にしたもの。T06（記録ドメイン）・T11（照合）が主に使い、T07・T09・T12・T14・T15以降も一部を使う。期待値はすべて契約の本文から導いたもので、実装の出力を正解にしていない（実装はまだない）。期待値の正しさは、実装していない別の担当がレビューで確かめる。

## 置き場所

| 場所 | 内容 |
| --- | --- |
| `tests/fixtures/ledger/common-setup.json` | 共通の設定（examples.mdの「共通の設定」の雇用先・雇用条件・口座・発行者）の保存と、例示の規則（`illustrativeRules`） |
| `tests/fixtures/ledger/cases/EX-*.json` | 契約の合成例を元にしたケース（ファイル名はケースID） |
| `tests/fixtures/ledger/cases/TC-*.json` | 契約の規則から追加したケース（下の「ケースの一覧」） |
| `tests/fixtures/ledger/regime/regime-cases.json` | 制度のケースの雛形（すべて未確認。下の「制度のケース」） |
| `tests/fixtures/ledger/load.ts` | fixtureを読み、省略した項目を既定で補い、`baseScenario`をたどって操作の並びを作る補助。後続の試験が読んでよい |
| `tests/fixtures/ledger/contract-shape.ts` | 契約の記録の型（項目・許す状態・符号と範囲・IDの接頭辞・参照の粒度）を、fixtureの検査のために書き写した表 |
| `tests/fixtures/ledger/ledger.test.ts` | 台帳の検査（下の「台帳の検査」） |

fixtureはJSONだけで、画像・PDF・CSVは置かない。すべて合成のデータで、契約の合成例と同じ架空の勤務先（勤務先A・B・C）・口座・発行者（架空市・架空町、この台帳で足した架空村）・摘要・金額だけを使う。税額・保険料の値は制度による計算の結果ではない（[公開範囲と公開前の点検](../public-data.md)）。

## 期待値の決め方

- **契約の本文から導く。** 各検査（`checks`の要素）に、理由（`reason`）と、契約の節と語句の引用（`cites`）を付ける。引用は`{ doc, section, quote }`で、`section`は見出しの番号（`2`、`11`）か合成例のID（`EX-04`）か見出しの文字（`共通の設定`）。台帳の検査は、引用の語句がその節に実在することを確かめる（Markdownの記号と空白を除いて比べる）。契約が変わって語句がなくなると試験が失敗するので、その検査の期待値を導き直す（下の「契約が変わったとき」）。
- **規則がまだないものは「規則がない」状態で期待する。** T14が承認する前の比較の対応表と帰属の規則は、場面の`rules`を`none`にして、契約の「規則がまだないとき」（`rule-pending`・`undetermined`）を期待する。合成例が説明のために仮に使う規則（EX-06の例示の対応表、EX-05の「支払予定日の年」）は、`common-setup.json`の`illustrativeRules`に名前を付けて置き、それを使う場面だけ`rules`で指定する。どちらもT14が承認した規則ではない。
- **契約が決めていないものは検査しない。** 期待に書かない項目は検査しない（unasserted）。集計値の`excludedCount`は書かない。`payslip-by-income-year`の`coverage`も書かない（下の「未決事項」）。契約が状態を1つに決めていない値は、決まっている範囲だけを書く（例: 振込額が記載なしの明細の未照合の振込額は`notKnown`）。
- **並びは集合として比べる。** 期待の中の並び（`missing`、`pairs`、閉包の記録、`versionChanged`等）は、特に書かない限り順序を問わない。契約が順序を決める場合（共通の型の11の「並べる順序」）も、台帳では順序を検査しない。
- 場面の操作は、共通の設定だけを保存したデータベースから始める（場面は互いに独立）。保存の連番の期待は、共通の設定の保存の数を`N`として`N+k`と書く（examples.mdの「保存の連番と時点の書き方」と同じ）。

## ケースの一覧

ケースの中の場面（`scenarios`）の一覧と、どの契約の例・規則を扱うかは、各場面の`covers`と`title`が正本（ここに件数を書き写さない）。

| ケース | 元 | 主な内容 | 主な使い手 |
| --- | --- | --- | --- |
| EX-01 | examples.md EX-01 | 銀行入金だけ → 明細の追加、入力の順序 | T06・T09・T11 |
| EX-02 | EX-02 | 分割入金・合算入金、過剰配分の拒否、使えない配分による保留、復元したデータの上限（使われ方の段階）、振込額の記載がない明細 | T06・T11 |
| EX-03 | EX-03 | 同額別件、再送、writeRequestIdの食い違い、二重登録の取消と取消の取り消し、雇用先の二重登録と正規のID、正規のIDが変わる保存の検査、分類だけの訂正、取込のキー、同じ証憑ファイル | T06・T09・T11 |
| EX-04a | EX-04 (a) | 入力誤りの訂正、記録時点・把握時点の再現、時計の巻き戻り、runの鎖・範囲・目的の固定（runは射影） | T06・T07・T15 |
| EX-04b | EX-04 (b) | 遡及差額、参照の粒度（記録全体の関係はwholeだけ） | T06・T11 |
| EX-04c | EX-04 (c) | 正式通知の差し替え、未確認の差し替え、決定額の行は1行、決定額を使うrunの根と閉包、runのあとの変化、取消した橋の記録 | T06・T11・T15・T18 |
| EX-04d | EX-04 (d) | 同じ種類・同じ年度の通知（表記の違い・発行者不明・別の発行者・3件以上・other）、二重登録の類と年度 | T11・T18・T19 |
| EX-05 | EX-05 | 年またぎ、4つの日付、帰属と候補の年、根拠の食い違い、例示の規則 | T11・T14・T16 |
| EX-06 | EX-06 | 年間資料の採用・比較・不一致・説明、範囲の一部だけの集計、coverage、対応表がない場合、runの採用の写し | T11・T14・T15 |
| EX-07 | EX-07 | 予測の実績化、消込、使えない関係、取り下げ、行IDの予約、識別の次元、配分の符号、runの閉包 | T06・T11・T15・T20 |
| EX-08 | EX-08 | 金額の4つの状態、新しい情報による変化と把握時点の再現 | T06・T10・T12 |
| EX-09 | EX-09 | 雇用条件の期間の重なり（不明な境界） | T06・T17 |
| TC-01 | 共通の型の2・7・9 | 改訂の競合、理由と状態の遷移、存在しない参照、不正な期間、把握日とAsia/Tokyoの日付、取消の先、変えられない項目 | T06・T07・T09 |
| TC-02 | 共通の型の4・12 | Factの許す状態、金額の符号と範囲、並びの一意のキー、集計のoverflow | T06・T07・T12 |
| TC-03 | 共通の型の5、照合の規則の2・8 | 分からない値で絞り込まない（日付・明細の種類・行の並び・結んだ入金の日付・期間の端） | T06・T11 |
| TC-04 | 記録の型の10 | 差し替えの系列の取消と取消の取り消し、拒否する形（自己参照・循環・分岐・次元の不一致）、未確認の系列、把握時点の再現 | T06・T11 |
| TC-05 | 照合の規則の3、記録の型の5 | 通勤手当を含む振込と精算の入金の混在 | T11 |
| TC-06 | 計算結果の1・4 | 丸めの計算（4つの丸め方と負の数）と、保存しない丸めの記録の形（架空の計算器） | T15・T16 |

## 受入条件との対応

| T03の受入条件・検証 | ケース（`acceptance`のタグ） |
| --- | --- |
| T01の各ケースにID、入力、期待する記録・集計、理由を付ける | EX-01〜EX-09（合成例の見出しをすべて扱うことを台帳の検査が確かめる） |
| 将来の制度ケースは適用年・地域・原典・丸めを必須とする | `regime/regime-cases.json`と台帳の検査（下の「制度のケース」） |
| 実際の明細を名前だけ変えたデータを使わない | すべて契約の合成例か、この台帳で作った架空の値 |
| 銀行のみは入金合計に反映する一方、給与・源泉徴収は未確定になる | `bank-only`（EX-01-a） |
| 明細追加で収入は二重にならない | `no-double-income`（EX-01、EX-02、TC-05） |
| 入力順不同 | `order-independence`（`orderVariants`を持つ場面） |
| 訂正 | `correction` |
| 未知値 | `unknown-value` |
| 同額別取引 | `same-amount-different` |
| 実装から生成した値を正解にしない。ケースの期待値を別担当が確認 | 上の「期待値の決め方」。別担当のレビューで確かめる |

台帳の検査は、上のタグをそれぞれ1つ以上の場面が持つことを確かめる。

調整係の依頼でT01のレビューで固めた規則も加えた: 分からない値で絞り込まない（TC-03、EX-05-c、EX-04c-c4、EX-04d-d6e）、符号ありの差引支給額（EX-07-d、TC-02）、年度をまたぐ正式通知の類（EX-04d-d6c・d6d）、runの目的の固定（EX-04a-a5）、runの入力の閉包の完全性（EX-04c-c4・c5、EX-07-a3）、判定の順序（EX-07-b3）、使われ方の段階（EX-02-c4）、Factと Factでない値の比較（EX-07-c）、正規のIDが変わる保存（EX-03-b・c1・c2）。

## 形式

### ケースと場面

ケースのファイルは`{ schemaVersion: 1, contractVersion: "1.0", caseId, title, consumers, scenarios }`。場面は次の項目を持つ。

| 項目 | 意味 |
| --- | --- |
| `scenarioId` | `<caseId>-<名前>`。台帳全体で一意 |
| `title` | 場面の説明 |
| `covers` | 契約のどの節を扱うか（`{ doc, section, subsection? }`。examples.mdの小見出しは`(a)`や`手順1:`のように書く） |
| `acceptance` | 受入条件のタグ（任意） |
| `rules` | `{ comparisonMapping: none・EX-06-mapping, attribution: none・EX-05-scheduled-pay-date-year }` |
| `baseScenario` | 同じケースの先に書いた場面のID（任意）。その場面の操作のあとに、この場面の`operations`を続ける（検査と`orderVariants`は引き継がない） |
| `operations` | 操作の並び（下の表） |
| `orderVariants` | 入力順を入れ替えた並び（任意）。すべての操作が`accepted`の場面だけに書く。どの並びで実行しても、`afterOp`が`end`の検査は同じ結果になる |
| `checks` | 検査の並び。`{ checkId, afterOp, view?, query, expect, reason, cites }`。`afterOp`は操作の`opId`（その操作のあとの状態。正本の順序で実行したとき）か`end` |

### 操作

| `op` | 内容 | `expect.outcome` |
| --- | --- | --- |
| `save` | 記録の改訂1件の保存。`at`は注入する時計の値（記録日時）。`record`は省略した項目を既定で補う（下）。改訂は`baseRevision`（省略時は`revision`−1）を基にする | `accepted`（`recordedSeq`の期待を書いてよい）、`rejected`（`reason`）、`replayed`（同じ`writeRequestId`・同じ内容。`of`は最初の操作）、`existing-returned`（同じ`importKey`。`record`は返す記録） |
| `saveEvidenceFile` | 証憑ファイルの保存（改訂を持たない） | `accepted`、`existing-returned`（同じ`sha256`） |
| `restoreUnchecked` | 保存の検査を通らずに入った記録（古いデータの復元・取込等）を置く。照合の判定の入力を作るためのもので、T12の復元の手順の期待値ではない。`expectedViolations`に、その記録が記録だけで判定できる保存の条件のどれに当たるかを書く | `restored` |
| `saveRun` | 計算runの保存。`run`は射影（下の「runの射影」） | `accepted`、`rejected`（`reason`） |

拒否された保存は記録を作らず、保存の連番も使わない。記録のIDは、試験で注入するID生成器が返す値として扱う。拒否された新規の保存と同じIDで、あとで保存し直す場面がある（拒否された保存は記録を作らないので、一度使ったIDの再利用にはならないと読む。下の「未決事項」）。

### 省略した項目の既定

`record`は、examples.mdの「読み方」の1〜7の既定を項目ごとに決めたものとして、次のとおり補う（`load.ts`の`expandRecord`）。

- 改訂の共通の形: `revision` 1、`reason` `create`、`status`は理由から（`void`なら`voided`、ほかは`active`）、`duplicateOf`・`importKey`は`not-applicable`（`entryChannel` `manual`）、`changeNote`は`unknown`、`writeRequestId`は`w-<scenarioId>-<opId>`（同じ操作の再送は同じキー）。`restoreUnchecked`で置く改訂は、1つの操作で複数の改訂を置くので、改訂ごとに`w-<scenarioId>-<opId>-<記録のID>-v<版>`にする（`writeRequestId`はデータベース全体で予約するキーなので重ねない。台帳の検査が重なりを見つける）。`knownOn`は、`create`・`new-information`では`unknown`、`correct-input-error`・`void`・`unvoid`では直前の改訂から引き継ぐ。
- 版2以上の改訂の`body`は、直前の採用された改訂の`body`に、書いた項目だけを差し替えたもの（取消・取消の取り消しは何も書かない）。
- `body`の`Fact`の項目: 「〜の場合だけ」の項目（照合配分の`settlesForecastLine`・`confirmedAgainst`、`annual-coverage`の`amount`、照合の判断の`scope`・`explainedComparisons`、予測の`accountId`）は、その場合でなければ`not-applicable`、その場合なら省略できない。`supersedes`は`not-applicable`。資料から写す並び（`otherEarnings`・`otherDeductions`・`amounts`・`installments`・`statusDates`）は`known`の空、`includedOtherPayers`は`unknown`。ほかは`unknown`。
- `Fact`でない項目: 文字列（表示名・表題・行の名前・`reasonNote`）は`合成`、予測の行の`lineStatus`は`open`。ほかは省略できない。

補ったあとの記録は、契約の保存の条件を満たさなければならない（台帳の検査が確かめる）。

### 拒否の理由

`reason`は、契約のどの保存の条件で拒否するかを示す、台帳の名前（T06・T11が実装で別の名前を使う場合は対応を取る）。「静的」と「場面」は記録とその前の版だけで判定できるもので、台帳の検査は、拒否を期待する保存がその違反を実際に含むこと、意味の判定による拒否を期待する保存がそれらの違反を含まないこと（理由が一意に決まること）を確かめる。

| `reason` | 区分 | 契約 |
| --- | --- | --- |
| `fact-state-not-allowed` | 静的 | 共通の型の12（許す状態） |
| `value-invalid` | 静的 | 共通の型の4・6（符号・範囲・形式・空の文字列）、記録の型の7（予定日と予定月） |
| `list-invalid` | 静的 | 共通の型の12の「並びの空の意味」（空・一意のキー）、記録の型の6・8 |
| `ref-granularity` | 静的 | 共通の型の2の「参照先の種類・粒度・次元」 |
| `ref-target-invalid` | 静的・場面 | 同上（種類）、共通の型の9（`duplicateOf`の先は自分以外の有効な記録）、行が参照先の版にない |
| `invalid-period` | 静的 | 共通の型の6（`start` ≤ `end`） |
| `transition-not-allowed` | 静的・場面 | 共通の型の9の改訂のモデルの表 |
| `ref-target-missing` | 場面 | 共通の型の2（参照先が存在しない） |
| `stale-base-revision` | 場面 | 共通の型の9（古い版での上書き） |
| `body-change-on-void-or-unvoid` | 場面 | 共通の型の9 |
| `immutable-field-changed` | 場面 | 共通の型の9（改訂で変えられないもの） |
| `line-id-reused` | 場面 | 共通の型の2の`LineId` |
| `known-on-in-future` | 場面 | 共通の型の7（Asia/Tokyoの日付） |
| `write-request-conflict` | 場面 | 共通の型の10 |
| `supersede-dimension-mismatch`、`supersede-shape` | 意味 | 記録の型の10 |
| `employment-term-overlap` | 意味 | 記録の型の2 |
| `master-void-referenced`、`canonical-change-breaks-check`、`issuer-kind-mismatch` | 意味 | 共通の型の9の「マスタの取消と二重登録」 |
| `over-allocation`、`allocation-limit-undeterminable`、`allocation-sign`、`confirm-condition-unmet` | 意味 | 照合の規則の3 |
| `identity-dimension-mismatch`、`identity-dimension-undetermined` | 意味 | 照合の規則の3の「識別の次元」、共通の型の13 |
| `decision-validation` | 意味 | 照合の規則の4（保存の検証） |
| `run-previous-mismatch`、`run-chain-exists`、`run-scope-not-allowed`、`run-scope-noncanonical`、`run-request-mismatch`、`run-closure-mismatch`、`run-snapshot-mismatch` | 意味 | 計算結果の1・3 |

### 検査の種類

| `query.kind` | 問い | `expect` |
| --- | --- | --- |
| `aggregate` | 集計（`key`は`AggregateKey`、`axis`、`scope`） | `{ values: [{ state, knownSum, coverage?, missing }] }`（`annual-value`はcoverageで分けた並び）か`{ error: overflow・rejected-request }` |
| `unreconciled` | 入金の未照合の額・明細の未照合の振込額 | `{ amount: Fact }`か`{ notKnown: true }` |
| `allocationUsage` | 照合配分の使われ方 | `{ usage }`（照合の規則の9の識別子） |
| `forecastLine` | 予測の行の残り | `{ remaining: Fact, difference?: Fact }`（differenceは見込みとの差） |
| `attribution` | 給与明細の所得の年への帰属 | `{ state, year: Fact, candidateYears? }`（候補の年は`{ from, to }`の範囲の並び。`null`は限りなく開いた端） |
| `comparison` | 年間資料の項目の比較の状態 | `{ state, difference? }` |
| `adoption` | 年・支払者の年間の値の選択 | `{ selection, document? }` |
| `duplicateCandidates` | 記録の種類ごとの重複の候補 | `{ pairs: [[小さいID, 大きいID]] }` |
| `decisionPremise` | 照合の判断の前提（`item`で項目ごと） | `{ premise: holds・broken }` |
| `seriesStatus` | 差し替えの系列での位置 | `{ status: current・superseded・unconfirmed-series・voided・not-in-view }` |
| `canonicalId`、`runCanonicalId` | マスタの正規のID（runの中の解決） | `{ canonical }` |
| `selectedRevision` | 見方で選ばれる版 | `{ revision }`（選ばれなければ`none`） |
| `seqForTime` | 時点から連番への対応 | `{ seq }`（`N+k`） |
| `runClosure` | 入力の要求と仮定の参照から決まる必要な閉包 | `{ records, allocations（usageAtRun）, decisions（premiseAtRun） }` |
| `runInputChange` | runのあとの変化（入力が変わった） | `{ added?, removed?, versionChanged? }`（書いたものだけ検査） |
| `runScopeChanged`、`runChain` | 範囲の雇用先の変化、runの履歴の鎖 | `{ changed }`、`{ chain }`（最初のrunからこのrunまで。目的が決まった最初のrunは1要素。目的が決まらないrun（scope・referencePointがunknown、jurisdictionがknownでない）はどの鎖にも入らないので空の並び） |
| `requiredAdoptions` | 年間の値の要求から決まる採用の写しの必要な集合 | `{ adoptions }`（AdoptionSnapshotの形。`adoptedRef`は`Fact<Ref>`で、年間資料を採用したら`known`・整数の版・`line` `whole`、ほかの選択では`not-applicable`。`coverage`も選択で決まる） |
| `roundingStep`、`roundingValidation` | 丸めの計算、丸めの記録の形 | `{ after }`、`{ valid, reason? }`（`reason`はその形が示す欠陥。ほかの欠陥が同時に見つかってもよい） |
| `includedPayersPrompt` | 「前職分を含むかの確認」の表示 | `{ shown }` |

`view`は`current`（既定）、`record-seq`（`seq`）、`record-time`（`time`）、`known-on`（`date`）。共通の型の7の見方。

### runの射影

計算runの全体の形（`inputs.requests`の一覧、`results`のキー、丸めの手順）は計算器の版ごとにT15以降で決まるので、台帳の`saveRun`は、目的（計算器の識別子・年・地域・手続・基準の時点・範囲）と鎖の判定に使う項目、状態、入力の段階と、場面に必要なときだけ`requests`・`inputsRecords`・`explanationRefs`を持つ射影にする。`calculatorAllowsPayers`は、計算器の版が利用者の選ぶ支払者の範囲を許すかを表す。計算器（`calc-fixture-*`）は架空。状態は入力と矛盾させない（計算結果の2。必要な入力が足りなければ`incomplete`）。台帳の検査は、`computed`・`provisional`のrunについて、要求（`requests`の要素）ごとに、その要求の範囲・日付の軸・支払者（口座）に当たる固定した記録（`inputsRecords`のうち、取消しておらず、差し替えの系列の現在の記録であるもの）の、その要求の項目だけが分かっていることを確かめる。差し替えの系列はrunに固定した版だけでたどり、取消した中間の記録は通り過ぎる（A ← B ← CでBだけを取消せばCが現在の記録、BとCを取消せばAが現在の記録に戻る。記録の型の10）。差し替えの識別の次元も固定した版と正規のIDで比べる。整っていない系列（未確定の次元を持つ未確認の系列、固定していない橋の記録をはさむ系列、`restoreUnchecked`で復元した自己参照・循環を含む系列等。循環は取消していない記録どうしでも、長さによらず見つける）は、系列全体の記録を現在の記録として扱わない（TC-04-bのように明細の種類が分からない差し替えを含む系列）。要求の範囲は支払者（口座）と日付の軸で先に決め、既知の日付で範囲の外と確定できる記録は、系列が整っていなくてもその要求の不足にしない。範囲の中にある整っていない系列の記録は不足とする（記録の型の10の5の「除いた記録が入るはずだった集計」だけを`incomplete`にする）。要求どうしの項目や対象の記録は混ぜない（9月の所得税と10月の総支給額を別々に要求するrunは、9月の総支給額・10月の所得税が分からなくても`computed`になれる。EX-04a-a6）。日付の軸の日付が分からない（`unknown`・`not-stated`）記録は、その要求の範囲から外せないので、系列の形によらず不足とみなす。判断するのは、対象を固定した記録だけで決められる要求（`payslip-item`・`deposit-amount`）だけで、帰属・採用・実績化・正式通知の類を導く要求（`payslip-by-income-year`・`annual-value`・`forecast-remaining`・`notice-determination`）の不足は、この検査では判断しない（必要な集合を導く実装、T11・T15で判断する）。

## 制度のケース

`regime/regime-cases.json`の各ケースは、次の項目を必須にする（台帳の検査が確かめる）: `caseId`、`regime`、`title`、`status`（`placeholder`・`draft`・`approved`）、`consumers`、`target`（`year`、`yearKind`、`jurisdiction`、`procedure`、`referencePoint`）、`ruleSet`、`sources`、`rounding`、`input`、`expected`、`derivation`。

- いまはすべて`placeholder`で、手続（`procedure`）以外は「未確認」。`placeholder`には数値を入れない（制度の値を入れない）。手続と、住民税・国保・ふるさと納税の賦課の年度（`fiscal`）、所得税の暦年（`calendar`）は計算結果の契約の1による。勤務先の保険料・認定の年の種類は「未確認」。
- `levy`の`referencePoint`は`not-applicable`（計算結果の1の「手続と基準の時点」）。
- `approved`にするには、次の値がすべて要る。「未確認」でないことだけでなく、値の形を確かめ、`null`・空の文字列・形の違う値を通さない。`draft`の値は「未確認」か、同じ形の値。
  - 適用年`year`（`{ kind: calendar・fiscal, year }`。`kind`は`yearKind`と同じ）と地域`jurisdiction`（`{ kind: national・prefecture・municipality・insurer, code }`）。
  - 基準の時点`referencePoint`: 手続に合う形（`withholding`・`year-end-adjustment`・`tax-return`・`recognition`は`{ kind: date, date }`、`premium`は`{ kind: month, month }`）。`levy`だけは`not-applicable`。
  - 制度データの版`ruleSet`（`{ id, version }`）。
  - 原典`sources`: 一次資料（`primary: true`）を1件以上含み、各要素に`title`・`publisher`・`url`（https）・資料の更新日`documentUpdatedOn`・取得日`retrievedOn`（更新日以後）・箇所`location`。
  - 丸め`rounding`: 手順の並び（丸めがなければ空）。各手順の`itemKey`は期待値の結果の項目で、`unit`は正、`basis`が`rule`・`input`なら原典の箇所、`input`なら`methodInput`。
  - 入力`input`（空でないobject）と期待値`expected`（`{ results: [{ key, valueType: yen・decimal, value: Fact }] }`、1件以上）。
  - 導き方`derivation`（`method`と確かめた担当`reviewedBy`が空でなく、`independentOfImplementation: true`）。
- 値を入れるのはT14（一次資料で確かめ、承認したものだけ）。年・地域・原典・丸めのどれかが欠けたケースは`approved`にできない。

## 後続タスクの使い方

- **T06（記録ドメイン）:** `save`の操作を、ID生成器と時計を注入したdomainの保存の関数に順に渡し、`expect.outcome`（拒否なら理由の対応）を比べる。TC-01・TC-02と、各ケースの拒否の操作が改訂のモデル・保存の検査の試験になる。`aggregate`の検査のうち、入金額・明細の項目・4つの状態・overflowは記録の集計の試験になる。
- **T11（照合）:** `unreconciled`・`allocationUsage`・`forecastLine`・`attribution`・`comparison`・`adoption`・`duplicateCandidates`・`decisionPremise`・`seriesStatus`と、所得の年・年間の値・見込み・決定額の`aggregate`を、照合の結果と比べる。`orderVariants`で入力の順序を入れ替えても同じ結果になることを確かめる。`rules`に合わせて、比較の対応表と帰属の規則を注入する（`none`なら規則なし）。
- **T15（計算基盤）:** `saveRun`の射影を、架空の計算器の版の`requests`等で補って保存の検査に使う。`runClosure`・`requiredAdoptions`・`runInputChange`・`roundingStep`・`roundingValidation`は、計算器に依存しない判定の試験になる。
- **T14（制度調査）:** `regime/regime-cases.json`の雛形を、一次資料で確かめた値で埋め、`approved`の条件を満たしたものだけを後続へ渡す。
- 読み込みは`load.ts`の`readLedgerFiles`・`resolveOperations`・`expandRecord`を使ってよい。不正な要素（JSONでないファイル、objectでない場面・操作、型の違う`reason`・`revision`・`body`）は黙って除かず、場面IDと位置を含む誤りにする。例外として、`cases/`・`regime/`の中の`.DS_Store`・`Thumbs.db`（OSが自動で作るメタデータで、`.gitignore`でも除外している名前。`load.ts`の`OS_METADATA_FILES_FROM_GITIGNORE`）は、名前が完全に一致するものだけを読み飛ばす。ほかのJSONでないファイルは、場所を示して誤りにする。

## 台帳の検査

`npm test`（`tests/**/*.test.ts`）に含まれ、CI（T05）がmacOS・Windows・Linuxで実行する。単独では`node --test tests/fixtures/ledger/ledger.test.ts`で実行できる。確かめること:

- ファイルの形、ID（ケース・場面・操作・検査）の一意性、`baseScenario`と`afterOp`の参照。
- 共通の設定から操作を順に当てはめ、補った記録が契約の保存の条件（`contract-shape.ts`）を満たすこと。拒否の理由のうち「静的」「場面」のものは、その違反を記録が実際に含むこと。意味の判定による拒否は、それらの違反を含まないこと。二重登録の取消の残す方（`duplicateOf`）が、取消しておらず、整った差し替えの系列の現在の記録であること（未確認の系列や、自己参照・循環を含む系列の記録は残す方にできない）。現在の見方（検査の`view`を省略、または`kind`が`current`）の`seriesStatus`の期待値が、`afterOp`の時点の最新の改訂から系列の補助で導いた状態（`voided`・`unconfirmed-series`・`superseded`・`current`）と一致すること。時点を指定した見方（`record-seq`・`record-time`・`known-on`）の期待値と`not-in-view`は、最新の状態と比べない（その見方の改訂を選んで導くのはT06）。ほかの検査で台帳の状態を使うのは、記録・版・行・runが`afterOp`の時点で実在することの確認だけで、見方から導く値を最新の状態と比べない。差し替えの系列の判定は、runの射影の不足の判断・`duplicateOf`の残す方・`seriesStatus`のどれでも、同じ1つの補助（記録の型の10の1〜5）の結果だけを使い、入口ごとに食い違わせない。参照先が先に保存されていること（参照は`contract-shape.ts`の型の表でIDかRefの項目だけから取り、摘要・表示名・メモの文字列はIDに似ていても参照にしない。入力順の依存の判定も同じ）。`recordedSeq`の期待が保存の順と合うこと。
- `orderVariants`が操作の並べ替えで、参照先・前の版より前に置かれた操作がないこと。
- 期待の形: 集計の状態と`missing`・`knownSum`の関係（共通の型の11の状態の表）、集計の要求のscopeが許す次元（`forecast-remaining`で口座を許すのは`deposit-amount`だけ。拒否を期待する検査は`{ error: rejected-request }`で書ける）、不足の行の項目名・派生キー・状態・参照先の種類、候補の年の範囲の形、採用の写しの形等。期待の中の並びのobjectでない要素は、位置を示して問題にする。
- 照合配分が行を指す参照は、その項目が指せる種類の行に実在すること（給与明細は支給の行`otherEarnings`だけで、控除の行は指せない。予測は見込みの行）。
- 引用の語句が契約の節に実在すること、examples.mdのEX-NNの見出しと小見出しをすべての場面のどれかが扱うこと、受入条件のタグをそれぞれ1つ以上の場面が持つこと、制度のケースの必須の項目。
- 検査そのものが誤りを見逃さないことを、台帳を写して壊した版で確かめる。

確かめないこと: 期待値そのものの正しさ（契約からの導き方）。これは別の担当のレビューで確かめる。台帳の検査が通ることは、期待値が正しいことの証明ではない。

## 契約が変わったとき

契約の変更（[契約のREADME](../contracts/README.md)の「契約の変更」）でこの台帳の検査が失敗した場合（引用の語句がない、合成例の見出しを扱う場面がない、記録の型の表と合わない等）は、その変更のPRか後続のIssueで、影響する場面の期待値を契約から導き直し、`contract-shape.ts`の表を契約に合わせる。検査を通すためだけに引用や表を変えない。

## 未決事項

契約が一通りに決めていない、または台帳で解釈を選んだもの。期待値では検査しないか、解釈を理由に書いた。所有者・契約の担当（T01の後続の契約の変更）・T06・T11の判断を求める。

1. **集計値の`excludedCount`:** 「対象外・取消・差し替え済みで除いた件数」の「対象外」が、`not-applicable`の項目を持つ記録（状態の表では対象の記録に数える）を含むか、`missing`に挙げた記録を含むかが決まっていない。台帳では検査しない。
2. **`payslip-by-income-year`の`coverage`:** 共通の型の11の`coverage`は「所得の年の軸の年間の値」の説明で、所得の年ごとの明細の合計（`payslip-by-income-year`）のcoverageが`entered-records-only`か`not-applicable`かが読み取れない。台帳では検査しない。
3. **記載なしの振込額の明細の未照合の振込額:** 「knownにしない」とだけ定められ、`unknown`か`not-stated`かが決まっていない。台帳では`notKnown`だけを検査する（EX-02-d）。
4. **`mismatch-explanation`の判断全体の前提:** 1つの項目の値が変わったとき、判断全体（保存の検証）が崩れたとみなすかどうか。EX-06(c)の「withholdingTaxはmismatch-explainedのまま」から、判断全体は崩れず項目ごとに適用しないと読み、項目ごとの前提だけを検査する（EX-06-c3）。
5. **`same`の判断と重複の候補の表示:** 契約は`distinct`の判断が候補を抑制することだけを定める。台帳は、前提が崩れた`same`の組は候補に出る（EX-03の「distinctに改訂すると…候補に出なくなる」から）と読んだ（EX-03-a）。
6. **要求に合う記録がないrunの閉包:** 支払者で絞った要求で、その支払者の明細がないとき、要求の範囲の雇用先そのものが閉包に入るかが読み取れない。EX-04a-a5のrunには`inputsRecords`を書かない。
7. **差し替え済みの通知と決定額の重複の`conflict`:** 同じ集合に類が2つ以上あるとき、差し替え済みの記録（使わない類）も`missing`に挙げるかが読み取れないので、その組合せの集計は検査しない（EX-04c-c4）。
8. **把握時点の再現の「把握日不明」の一覧:** 一覧の形が決まっていないので検査しない（TC-04-c）。
9. **拒否された新規の保存のID:** 契約は「一度使ったIDは、取消のあとも再利用しない」と定める。拒否された保存は記録を作らないので、そのIDを、あとの保存し直しで使ってよいと読んだ（EX-04a、EX-04b、EX-04c、TC-01）。使えないとする場合は、場面のIDを分ける。
10. **拒否の理由の名前:** 台帳の名前は提案で、T06・T11が実装の名前を決めたら対応表を置く。T06（`src/domain/records/reasons.ts`）は、T06が判定する理由に台帳の名前をそのまま使う（対応表は要らない）。台帳に場面がないためにT06が足した名前は`record-not-found`（改訂する記録がない）、`id-already-used`（新規の保存に使われたIDが割り当てられた）、`known-on-not-inherited`（取消・取消の取り消しの把握日が直前と違う、または入力誤りの訂正で把握日を変えるのにchangeNoteがない）。T11の名前は未定。
11. **制度のケースの年の種類:** 勤務先の保険料（`premium`）と認定（`recognition`）の対象の年の種類はT14が一次資料で決める。
