# 計算結果

[契約の入口](README.md)／前: [照合・採用・集計の規則](reconciliation.md)／次: [合成例](examples.md)

税・保険等の計算の1回の実行（計算run）の型を定める。区分は推計。計算の規則・式・制度の範囲は定めない（T14・T15〜T19）。ここでは、どの計算器でも共通に持つ入力・版・状態・結果・丸めの記録の形を定める。T15は、この形を狭める（必須を増やす、状態の条件を厳しくする）ことはできるが、緩めることはできない。

**適用範囲（契約版1.0）:** 計算runは、結果が金額（`yen`）か小数（`decimal`）の数値の計算に限る（所得税・住民税・保険料等の試算。T16・T18等）。真偽・列挙・日付の型付きの判断結果（T17の被扶養者認定の見込み、資格の変更日等）は、契約版1.0の計算runの範囲外とする。その結果の型・型の識別子（`valueType`）・状態・比較・丸めの対象外とする規則は、T17が決め、この契約への追加として足す（決定先はT17、受入条件は[台帳](../implementation-tasks.md)のT17節。1の「数値以外の結果の型」）。T17が決めるまで、型付きの判断結果を計算runに保存せず、`unconfirmedItems`の文や金額で代えない。

## 1. 計算run（`CalculationRun`）

一度だけ書き、改訂を持たない。途中で失敗した場合も、`failed`として書く（状態は2の順序で決める）。

**run内の並びの規則（1つの規則）:** 計算runの中の並びは、それぞれ下の表のキーがrun内で一意であり、順序の意味は表のとおりとする。キーが重なるrunは保存しない（計算器の誤りとして扱う）。再計算や比較では、並びの位置ではなくキーで対応を取る。

| 並び | run内で一意のキー | 並びの順序の意味 |
| --- | --- | --- |
| `results` | `key` | 意味はない（表示の順は計算器が決める） |
| `roundingSteps` | `order` | 適用した順（`order`の連番の順に並べる。下の`RoundingStep`） |
| `assumptions` | `key` | 意味はない。同じ`key`の仮定を2つ持たない |
| `missingInputs` | `field`と`ref`の組 | 意味はない |
| `adoptions` | `year`と、`payers`の各支払者の組（同じ組は1つのスナップショットにだけ現れる。下の`AdoptionSnapshot`）。スナップショットの中の`payers`は支払者の`id`、`comparisons`は`field`で一意 | 意味はない |
| `inputs.records`・`inputs.allocations`・`inputs.decisions` | 参照先の`id`（1つのrunでは、同じ記録を1つの版でだけ参照する。下の「入力の閉包と推移的な固定」） | 意味はない |
| `unconfirmedItems` | 文そのもの（同じ文を重ねない） | 意味はない |

**参照の固定:** 計算runの中のすべての`Ref`（`inputs`の各項目、`AdoptionSnapshot`の`adoptedRef`、`Assumption`・`MissingInput`の`ref`、`ResultItem`の`explanationRefs`）は、`revision`に整数を使い、`current`を使わない。後日の改訂で、過去のrunの入力や根拠の表示が変わらないようにするため。

**入力の閉包と推移的な固定（1つの規則）:** runの中の記録は、`current`の参照（配分の`from`・`to`、判断の`targets`、記録の`supersedes`・`duplicateOf`）と`Id`の参照（マスタの`employerId`・`accountId`・`issuerId`等、判断の`coveredPayslips`・`scope.payers`）を持つ。runの中では、これらを最新の版や最新の解決に読み替えず、同じrunの`inputs.records`にある記録の版で読む。そのため、runの`inputs`は、runを作ったときの見方で選ばれた版で、次の**閉包**をすべて含む（記録は`inputs.records`に、照合配分・照合の判断は`inputs.allocations`・`inputs.decisions`に置く）。

1. 計算に使った記録（`adoptedRef`の年間資料、`Assumption`の予測を含む）と、固定した照合配分・照合の判断（`inputs.allocations`・`inputs.decisions`）。
2. 1の配分・判断が指す記録（`from`・`to`・`targets`・`coveredPayslips`。行を指す場合は、その行を持つ記録）。
3. 1・2の記録の`supersedes`・`duplicateOf`が指す記録と、それをさらにたどった記録（差し替えの系列と、二重登録の取消の鎖の全体）。
4. 1〜3の記録が参照するマスタ（雇用先・口座・発行者）と、その二重登録の取消の鎖（`duplicateOf`）の先のマスタ（[共通の型](common-types.md)の9の「マスタの取消と二重登録」）。

- 閉包に欠けがあるrun（含まれていない記録・マスタを指す記録があるrun）は保存しない。
- runの中の正規のIDの解決、差し替えの系列、二重登録の鎖、確かめ直しの判定は、`inputs.records`の版だけで導く。`AdoptionSnapshot`の`payers`は、その解決による正規のIDで書く。
- 1つのrunの中では、同じ記録を1つの版でだけ参照する。`inputs`の各並びだけでなく、`adoptedRef`・`Assumption`・`MissingInput`の`ref`・`explanationRefs`が`inputs.records`にある記録を指す場合も、同じ版でなければ保存しない（版が食い違うrunは、どの版で計算したかを再現できないため）。
- そのため、過去のrunを表示・再現するときは、配分・判断・差し替え・二重登録・マスタから辿った記録も、runを作ったときの版と解決になる。runのあとで記録やマスタが改訂・取消・取消の取り消しをされても、runの結果と読み方は変わらない（表示で「入力が変わった」と示す。3）。例: runに固定した`tax-year-assertion`の対象の明細を後で改訂しても、そのrunからは改訂前の版が見える。マスタの例はEX-04(a)の「マスタが変わった場合」。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `id` | `Id<CalculationRun>` | ID（接頭辞`run`） |
| `createdAt` | `Instant` | 実行日時（注入した時計。順序には使わない） |
| `recordedSeq` | 1以上の整数 | 保存の連番（[共通の型](common-types.md)の7の「保存の順序」） |
| `calculator` | `{ id: Text, version: Text }` | 計算器の識別子と版（例 所得税の試算はT16で決める）。暗黙の代わりの計算器を使わない |
| `appCommit` | `Text` | 実行したアプリのcommit（40文字のSHA）。作業ツリーに変更がある状態での実行の扱いは、ADR-0002の実行物の確認と合わせてT15で決める |
| `ruleSet` | `Fact<{ id: Text, version: Text }>` | 使った制度データと版。結果の状態を問わず、制度データを読み込んだrunでは`known`（読み込んだあとで`unsupported`・`failed`になった場合を含む）、読み込まなかったrunでは`not-applicable`。`unknown`は使わない（[共通の型](common-types.md)の12の「計算runの項目の状態」の表） |
| `target` | `Target` | 計算の対象（年・年度・地域） |
| `inputs` | `Inputs` | 入力の固定した写し |
| `status` | `computed・provisional・incomplete・unsupported・failed` | 結果の状態（2の順序で1つに決める） |
| `results` | `List<ResultItem>` | 結果の項目 |
| `roundingSteps` | `List<RoundingStep>` | 丸めの記録。適用した順に並べ、`order`は1から始めて1ずつ増やす（run内で一意の連番） |
| `missingInputs` | `List<MissingInput>` | 不足した入力 |
| `unconfirmedItems` | `List<Text>` | 未確認の事項（利用者に確かめてほしいこと） |
| `previousRunId` | `Fact<Id<CalculationRun>>` | 同じ目的の前のrun（訂正後の再計算等）。その目的の最初のrunは`not-applicable`（同じ表）。保存の条件と、履歴を1本の鎖にする規則は3の「runの履歴」 |
| `failure` | `Fact<Text>` | `failed`の場合だけ（`known`が必要。同じ表）。失敗の内容（実データの値を含めない） |

`Target`:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `year` | `{ kind: calendar・fiscal, year: YYYY }` | 対象の年（所得の年）か年度 |
| `jurisdiction` | `Fact<{ kind: national・prefecture・municipality・insurer, code: Text }>` | 対象の地域・保険者。地域の符号の体系はT14で決める。`known`か`unknown`だけ（国の制度でも`{ kind: national, code }`として`known`にする。[共通の型](common-types.md)の12） |
| `scopeNote` | `Fact<Text>` | 対象の範囲の補足 |

`Inputs`:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `records` | `List<Ref>` | 入力に使った記録と、その閉包（1の「入力の閉包と推移的な固定」。差し替えの系列・二重登録の鎖・参照するマスタを含む）。`revision`は必ず整数（固定）。`current`を使わない |
| `allocations` | `List<Ref>` | 使った照合配分（版を固定） |
| `decisions` | `List<Ref>` | 使った照合の判断（版を固定） |
| `adoptions` | `List<AdoptionSnapshot>` | 年間の値の採用の結果（[照合の規則](reconciliation.md)の5）。実行時に導いた結果を写して残す |
| `assumptions` | `List<Assumption>` | 仮定 |

`AdoptionSnapshot`: `year`（`CalendarYear`）、`payers`（`List<Id<Employer>>`。空を許さず、同じ支払者を2回含まない）、`selection`（`annual-document・entered-payslips・no-annual-document・adoption-needed`）、`adoptedRef`（`Fact<Ref>`。`annual-document`の場合だけ、版を固定。指せるのは、`targetYear`が`year`と同じで、範囲が確定していて、その範囲が`payers`と同じ集合である年間資料だけで、照合の規則の5でその年・支払者に選ばれた資料と同じであること（年間資料の値は範囲全体の分けられない合計なので、範囲の一部の支払者だけのスナップショットに年間資料を固定しない。範囲の一部だけの集計は照合の規則の5の`partial-scope`）。[共通の型](common-types.md)の2の「参照先の種類・粒度・次元」）、`coverage`（`Fact<annual-document・entered-records-only>`。`adoption-needed`の場合は`not-applicable`）、`comparisons`（`List<{ field: Text, state: rule-pending・no-coverage・incomplete・match・mismatch-unresolved・mismatch-explained }>`。項目ごとの比較の状態で、同じ`field`を2回含まない。1つの項目の比較の状態は1つに決まる（[照合の規則](reconciliation.md)の5）ため）。2つの並びの一意のキーは、[共通の型](common-types.md)の12の並びの表による（重なるスナップショットを持つrunは保存しない）。1つのrunの`adoptions`では、同じ年・同じ支払者の組は、ちょうど1つの`AdoptionSnapshot`にだけ現れる（同じ`year`のスナップショットどうしで`payers`が重ならない。照合の規則では、選択は年・支払者ごとに1つのため。保存の検査）。`selection`ごとの`adoptedRef`と`coverage`の状態は1つに決まる（[共通の型](common-types.md)の12）: `annual-document`なら`adoptedRef`は`known`（版を固定）で`coverage`は`annual-document`、`entered-payslips`と`no-annual-document`なら`adoptedRef`は`not-applicable`で`coverage`は`entered-records-only`、`adoption-needed`ならどちらも`not-applicable`。

`Assumption`: `key`（`Text`。run内で一意。1の「run内の並びの規則」）、`valueType`（`text・decimal・yen`）、`value`（`valueType`に合う値）、`source`（`user・forecast・rule-default`）、`ref`（`Fact<Ref>`。予測の行等。`revision`は整数（固定した写し））。

`ResultItem`:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `key` | `Text` | 結果の項目の識別子（計算器ごとに決める）。run内で一意 |
| `label` | `Text` | 表示名 |
| `valueType` | `yen・decimal` | 結果の値の型の識別子（`Assumption`の`valueType`と同じ語）。`yen`なら金額（円の整数）、`decimal`なら小数。`value`の状態が`unknown`・`not-applicable`等で値を持たなくても、型はこの項目で決まる |
| `value` | `Fact<Yen>`または`Fact<Decimal>` | 結果の値。`valueType`が`yen`なら`Fact<Yen>`、`decimal`なら`Fact<Decimal>`（合わない値のrunは保存しない）。契約版1.0の`valueType`はこの2つ（金額と小数）だけ。数値以外の結果は下の「数値以外の結果の型」による |
| `nature` | `estimate` | 常に推計。正式通知の値と同じ状態にしない |
| `explanationRefs` | `List<Ref>` | 根拠の記録への参照（版を固定） |

**数値以外の結果の型（T17で足す）:** 真偽・列挙・日付等の数値以外の結果（被扶養者認定の見込み、資格の変更日等）は、契約版1.0では定めない（冒頭の「適用範囲」）。必要になるT17が、その型を、`valueType`の値と`value`の型の組として、比較の規則（[共通の型](common-types.md)の13の表への当てはめ方）、結果の状態の規則、丸めの対象外とする規則（`RoundingStep`の`itemKey`から指さない）とともに、この契約に足す。

- 足すときは追加だけとし、既存の型（`Fact<Yen>`・`Fact<Decimal>`）とその意味、結果の状態の区別は変えない。版の上げ方は[README](README.md)の「契約の変更」に従う（既存の処理が知らない型の値を受け取るので、列挙に値を足す変更と同じくメジャーを上げる）。
- それまでは、数値以外の結果を`unconfirmedItems`の文や`label`に書いて、型のある結果の代わりにしない（型・状態・再計算での比較を失うため）。

`RoundingStep`: `order`（適用した順の連番。run内で一意で、1から始まり1ずつ増える）、`itemKey`（`Text`。同じrunの`results`にある`key`だけを指す）、`before`（`Decimal`）、`after`（`Decimal`）、`method`（`floor・ceil・half-up`）、`unit`（正の`Decimal`。例 `"1"`、`"100"`、`"1000"`）、`ruleRef`（`Fact<Text>`。丸めの根拠の制度の箇所）。

ある結果の項目の丸めの手順は、`itemKey`がその項目の`key`である`RoundingStep`を`order`の順に並べたものとする（結果の項目の側には手順の一覧を持たず、`itemKey`だけを正とする。2か所に書いて食い違うことを防ぐため）。丸めの手順がある項目の`value`は、その項目の最後の手順の`after`と同じ値にする。

**丸めは計算し直せる形にする。** 各手順の`after`は、`before`を`unit`の倍数へ`method`で丸めた値と等しい。
- `floor`: `before`以下で最大の`unit`の倍数（負の数は0から遠い方へ）。
- `ceil`: `before`以上で最小の`unit`の倍数。
- `half-up`: 最も近い`unit`の倍数。ちょうど中間なら0から遠い方。

同じ項目の手順が2つ以上あるときは、`order`の順に並べ、2つ目以降の`before`は直前の手順の`after`と等しい。丸め方はこの3つだけで、ほかの丸め方が必要になったら契約を変える（列挙を足すのでメジャーを上げる）。

保存のときに、これらと上の形（`key`の一意性、`itemKey`、`order`の連番、最後の`after`と`value`の一致）をすべて検査する。合わないrunは保存しない（計算器の誤りとして扱う。例は4）。

`MissingInput`（`field`と`ref`の組がrun内で一意。1の「run内の並びの規則」）: `field`（`Text`）、`ref`（`Fact<Ref>`。`revision`は整数（固定した写し））、`state`（`MissingState`。[共通の型](common-types.md)の11の6つの状態と同じ）。

## 2. 結果の状態

結果の状態（`status`）は、次の表の**上から順に**条件を調べ、最初に当てはまったものに決める。各行の条件は、それより上の行に当てはまらなかったことを前提にせず、単独で書いてある（どの順に調べても、同じ優先順で1つに決まる）。優先順は`failed` > `unsupported` > `incomplete` > `provisional` > `computed`。

| 順 | 状態 | 条件 | 結果の値（`results`の`value`） |
| --- | --- | --- | --- |
| 1 | `failed` | 計算が異常終了した（ほかの条件が同時に成り立っていても、この状態にする。障害を隠さないため） | 使わない（状態を問わず保存するが、表示・比較に使わない）。監査のために残す |
| 2 | `unsupported` | 異常終了しておらず、対象の年・年度・地域・範囲に承認済みの規則がない、または`jurisdiction`が`known`でない | すべて`unknown`。0にしない |
| 3 | `incomplete` | 異常終了しておらず、対象に承認済みの規則があり、必要な入力が足りない（`MissingState`のどれかに当たる入力がある。[共通の型](common-types.md)の11） | 不足の影響を受ける項目は`unknown`。`missingInputs`に1件以上挙げる |
| 4 | `provisional` | 異常終了しておらず、規則があり、必要な入力が足りていて、見込み・仮定、または`coverage`が`entered-records-only`の年間の値を使った | `known`か`not-applicable`。「暫定」と表示する |
| 5 | `computed` | 異常終了しておらず、規則があり、必要な入力が足りていて、見込み・仮定・`entered-records-only`の年間の値を使っていない | `known`か`not-applicable`。それでも推計で、正式通知ではない |

- 計算runの項目のうち状態で決まるもの（`ruleSet`・`failure`・`previousRunId`）は、この表で決まった状態ごとに、[共通の型](common-types.md)の12の「計算runの項目の状態」の表に従う。
- 入力が足りないときに、不足を0や前年の値で補わない。補う仮定を使う場合は、利用者が選んだ仮定として`assumptions`に記録し、状態を`provisional`にする。
- 計算結果と正式通知の値は、比べて差を示すだけで、どちらも書き換えない。

## 3. 不変と再計算

- **計算runは書き換えない。** 入力の記録が訂正されても、過去のrunの入力（固定した版）と結果は変わらない。
- 訂正・新しい情報・制度データの更新のあとで計算し直す場合は、新しいrunを作り、`previousRunId`で前のrunを指す。

**runの履歴（1つの規則）:** runの**目的**は、`calculator.id`、`target.year`、`target.jurisdiction`の組とする（`calculator.version`・制度データの版・`scopeNote`は、同じ目的の中で変わってよい）。同じ目的のrunは、`previousRunId`でつながった1本の鎖（分岐も合流もない、最初のrunから最新のrunまでの並び）にする。

- 新しいrunの`previousRunId`が`known`なら、次をすべて満たさなければ保存しない: 指すrunが保存済み（新しいrunより`recordedSeq`が小さい。自分自身は指せない）、`calculator.id`と`target.year`が同じ、`target.jurisdiction`が[共通の型](common-types.md)の13の4×4の表で一致（未確定は満たさない）、指すrunを`previousRunId`で指す別のrunがない（同じ目的の最新のrunである）。
- 新しいrunの`previousRunId`が`not-applicable`なら、同じ目的（`target.jurisdiction`が`known`で同じもの）のrunがまだない場合だけ保存する（同じ目的に2本目の鎖を作らない）。`target.jurisdiction`が`known`でないrunは目的が決まらないので、鎖の先頭にも途中にもならず、`previousRunId`は`not-applicable`で、ほかのrunから指されない。
- 失敗したrun（`failed`）も鎖に入る（監査のため）。最新のrunが`failed`でも、次のrunはそれを指す。
- この検査と保存は、同じ目的のrunについて1つのtransactionの中で直列に行う（同時に2件が同じrunを指して分岐しないように。T07・T15）。
- 鎖は保存のときの検査で保たれるので、表示では鎖を最新から`previousRunId`でたどり、1通りの履歴として示す。
- 過去のrunの入力の版が現在の版と違う場合（閉包のマスタの改訂・取消・取消の取り消しで、現在の正規のIDがrunの中の解決と違う場合を含む）、表示で「入力が変わった」と示す（記録を書き換えず、そのつど導く）。
- 制度データが更新されても、過去のrunを新しい制度で計算し直して上書きしない。
- 過去のrunを再現するために必要な情報（入力の版、制度データの版、計算器の版、アプリのcommit）は、バックアップと復元で保たれる（ADR-0006、T12・T15）。

## 4. 丸めの記録の例

形の例であり、制度の計算ではない（項目・単位・丸め方は架空）。

計算run `run_901`の`results`:

| `key` | `label` | `valueType` | `value` |
| --- | --- | --- | --- |
| `item-a` | 項目A | `yen` | 値あり 12,300 |
| `item-b` | 項目B | `yen` | 値あり 4,000 |

`roundingSteps`:

| `order` | `itemKey` | `before` | `after` | `method` | `unit` |
| --- | --- | --- | --- | --- | --- |
| 1 | `item-a` | `"12345.6"` | `"12345"` | `floor` | `"1"` |
| 2 | `item-a` | `"12345"` | `"12300"` | `floor` | `"100"` |
| 3 | `item-b` | `"4049"` | `"4000"` | `floor` | `"1000"` |

この形から、`item-a`の丸めの手順は`order` 1・2（この順）、`item-b`は`order` 3と一通りに決まる。どちらの項目も、`value`は最後の手順の`after`と同じ。

保存しない形（どれか1つでも当てはまれば、そのrunは保存しない）:

| 形 | 理由 |
| --- | --- |
| `results`に`key`が`item-a`の項目が2件ある | `key`がrun内で一意でない。手順の対象が決まらない |
| `itemKey`が`item-c`の手順がある（`results`に`item-c`がない） | `itemKey`が実在する`key`を指さない |
| `order`が1・2・4（3がない）、または1・1・2 | `order`が1から始まる連番でない |
| `item-a`の`value`が12,300で、最後の手順の`after`が`"12345"` | 値と丸めの記録が一致しない |
| `order` 3の手順が`before` `"100"`・`method` `floor`・`unit` `"1"`・`after` `"999"` | `after`が、`before`を丸めた値（`"100"`）と違う。計算し直すと合わない |
| `item-a`の`order` 2の`before`が`"12000"`（`order` 1の`after`は`"12345"`） | 同じ項目の手順がつながっていない |
| `unit`が`"0"`、または`method`が`other` | `unit`が正でない、または定めていない丸め方 |
