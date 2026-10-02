# 計算結果

[契約の入口](README.md)／前: [照合・採用・集計の規則](reconciliation.md)／次: [合成例](examples.md)

税・保険等の計算の1回の実行（計算run）の型を定める。区分は推計。計算の規則・式・制度の範囲は定めない（T14・T15〜T19）。ここでは、どの計算器でも共通に持つ入力・版・状態・結果・丸めの記録の形を定める。T15は、この形を狭める（必須を増やす、状態の条件を厳しくする）ことはできるが、緩めることはできない。

## 1. 計算run（`CalculationRun`）

一度だけ書き、改訂を持たない。途中で失敗した場合も、`failed`として書く。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `id` | `Id<CalculationRun>` | ID（接頭辞`run`） |
| `createdAt` | `Instant` | 実行日時（注入した時計） |
| `calculator` | `{ id: Text, version: Text }` | 計算器の識別子と版（例 所得税の試算はT16で決める）。暗黙の代わりの計算器を使わない |
| `appCommit` | `Text` | 実行したアプリのcommit（40文字のSHA） |
| `ruleSet` | `Fact<{ id: Text, version: Text }>` | 使った制度データと版。制度データを使わない計算は`not-applicable` |
| `target` | `Target` | 計算の対象（年・年度・地域） |
| `inputs` | `Inputs` | 入力の固定した写し |
| `status` | `computed・provisional・incomplete・unsupported・failed` | 結果の状態（2を参照） |
| `results` | `List<ResultItem>` | 結果の項目 |
| `roundingSteps` | `List<RoundingStep>` | 丸めの記録。適用した順に並べる |
| `missingInputs` | `List<MissingInput>` | 不足した入力 |
| `unconfirmedItems` | `List<Text>` | 未確認の事項（利用者に確かめてほしいこと） |
| `previousRunId` | `Fact<Id<CalculationRun>>` | 同じ目的の前のrun（訂正後の再計算等）。最初のrunは`not-applicable` |
| `failure` | `Fact<Text>` | `failed`の場合だけ。失敗の内容（実データの値を含めない） |

`Target`:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `year` | `{ kind: calendar・fiscal, year: YYYY }` | 対象の年（所得の年）か年度 |
| `jurisdiction` | `Fact<{ kind: national・prefecture・municipality・insurer, code: Text }>` | 対象の地域・保険者。地域の符号の体系はT14で決める。分からなければ`unknown` |
| `scopeNote` | `Fact<Text>` | 対象の範囲の補足 |

`Inputs`:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `records` | `List<Ref>` | 入力に使った記録。`revision`は必ず整数（固定）。`current`を使わない |
| `allocations` | `List<Ref>` | 使った照合配分（版を固定） |
| `decisions` | `List<Ref>` | 使った照合の判断（版を固定） |
| `adoptions` | `List<{ scope, adoptedRef: Fact<Ref>, coverage: annual-document・entered-records-only, comparisonState }>` | 年間の値の採用の結果（[照合の規則](reconciliation.md)の5）。実行時に導いた結果を写して残す |
| `assumptions` | `List<Assumption>` | 仮定 |

`Assumption`: `key`（`Text`）、`value`（`Text`・`Decimal`・`Yen`のどれか）、`source`（`user・forecast・rule-default`）、`ref`（`Fact<Ref>`。予測の行等）。

`ResultItem`:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `key` | `Text` | 結果の項目の識別子（計算器ごとに決める） |
| `label` | `Text` | 表示名 |
| `value` | `Fact<Yen>`または`Fact<Decimal>` | 結果の値 |
| `nature` | `estimate` | 常に推計。正式通知の値と同じ状態にしない |
| `explanationRefs` | `List<Ref>` | 根拠の記録・丸めの手順への参照 |

`RoundingStep`: `order`（1から始まる整数）、`itemKey`（`Text`）、`before`（`Decimal`）、`after`（`Decimal`）、`method`（`floor・ceil・half-up・other`）、`unit`（`Decimal`。例 `"1"`、`"100"`、`"1000"`）、`ruleRef`（`Fact<Text>`。丸めの根拠の制度の箇所）。

`MissingInput`: `field`（`Text`）、`ref`（`Fact<Ref>`）、`state`（`unknown・not-stated・undetermined・conflict・adoption-needed`）。

## 2. 結果の状態

| 状態 | 条件 | 結果の値 |
| --- | --- | --- |
| `unsupported` | 対象の年・年度・地域・範囲に、承認済みの規則がない、または地域が`unknown` | すべて`unknown`。0にしない |
| `incomplete` | 必要な入力が足りない（`unknown`・`not-stated`の項目、帰属の`undetermined`・`conflict`、年間の値の「要判断」） | 不足の影響を受ける項目は`unknown`。`missingInputs`に列挙する |
| `provisional` | 計算できたが、見込み・仮定、または`coverage`が`entered-records-only`の年間の値を使った | 値あり。「暫定」と表示する |
| `computed` | 上のどれにも当たらない | 値あり。それでも推計で、正式通知ではない |
| `failed` | 計算の途中で異常終了した | 使わない。監査のために残す |

- 状態は上の表の上から順に判定する（`failed`は異常終了したときだけ）。
- 入力が足りないときに、不足を0や前年の値で補わない。補う仮定を使う場合は、利用者が選んだ仮定として`assumptions`に記録し、状態を`provisional`にする。
- 計算結果と正式通知の値は、比べて差を示すだけで、どちらも書き換えない。

## 3. 不変と再計算

- **計算runは書き換えない。** 入力の記録が訂正されても、過去のrunの入力（固定した版）と結果は変わらない。
- 訂正・新しい情報・制度データの更新のあとで計算し直す場合は、新しいrunを作り、`previousRunId`で前のrunを指す。
- 過去のrunの入力の版が現在の版と違う場合、表示で「入力が変わった」と示す（記録を書き換えず、そのつど導く）。
- 制度データが更新されても、過去のrunを新しい制度で計算し直して上書きしない。
- 過去のrunを再現するために必要な情報（入力の版、制度データの版、計算器の版、アプリのcommit）は、バックアップと復元で保たれる（ADR-0006、T12・T15）。
