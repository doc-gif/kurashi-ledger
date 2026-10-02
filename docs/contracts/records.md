# 記録の型

[契約の入口](README.md)／前: [共通の型](common-types.md)／次: [照合・採用・集計の規則](reconciliation.md)

雇用先、雇用条件、口座、給与明細、銀行入金、年間資料、予測、正式通知、証憑の型を定める。各記録は[共通の型](common-types.md)の9「記録と改訂の共通の形」（ID・版・状態・改訂の理由・記録日時・把握日）を持ち、下の表はその`body`の項目を書く。

項目名は英語（実装・出力で使う名前）、説明は日本語で書く。「記載どおり」は、資料に書かれた値・文字をそのまま持ち、アプリが補ったり計算したりしないことを表す。

## 1. 雇用先（`employer`）

給与を支払う者。表示名ではなくIDで参照する。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `displayName` | `Text` | 利用者が付ける表示名（例「勤務先A」）。一意でなくてよい |
| `legalName` | `Fact<Text>` | 資料に書かれた名称 |
| `note` | `Fact<Text>` | メモ |

同じ勤務先に再就職した場合も同じ雇用先を使い、雇用条件を期間ごとに分ける。

## 2. 雇用条件（`employment-term`）

雇用先との条件のうち、期間ごとに変わるもの。適用期間が重ならないように、期間ごとに1つの記録にする。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `employerId` | `Id<Employer>` | 雇用先 |
| `applicablePeriod` | `Period` | 適用期間（この条件が当てはまる期間）。継続中なら`end`は`not-applicable` |
| `withholdingColumn` | `Fact<kou・otsu・hei>` | 源泉徴収の区分（甲欄・乙欄・丙欄）。明細や勤務先の説明による |
| `socialInsurance` | `Fact<enrolled・not-enrolled>` | 健康保険・厚生年金の加入 |
| `employmentInsurance` | `Fact<enrolled・not-enrolled>` | 雇用保険の加入 |
| `scheduledWeeklyMinutes` | `Fact<Minutes>` | 週の所定労働時間 |
| `payScheduleNote` | `Fact<Text>` | 締日・支給日の決まり（記載どおりの文。例「20日締め当月25日払い」）。支払予定日を自動で作らない |

同じ雇用先で適用期間が重なる有効な雇用条件は保存しない（保存の検査。T06で検証する）。検査の対象は有効な記録だけで、取消した雇用条件は検査を妨げない。取消の取り消しで重なりが生じる場合は、その取消の取り消しを拒否する（[共通の型](common-types.md)の9の「検査の対象は有効な記録だけ」）。期間の境界が`known`でない場合は、[共通の型](common-types.md)の6の「端が分からない期間の扱い」に従い、その側へ限りなく開いた期間として重なりを判定する。重ならないことを確かめられない保存は拒否する。たとえば、`end`が分からない雇用条件のあとに同じ雇用先の新しい雇用条件を足すには、先に`end`を確かめて改訂する。境界を推測で埋めない（`unknown`のまま保存してよいが、上の解釈で重なりを判定する）。

- `end`の`not-applicable`は「継続中（終わりの定めがない）」、`unknown`は「終わりの日が分からない、または継続中かどうかが分からない」。重なりの判定ではどちらも後ろへ無限に広げるが、意味は区別して持ち、表示も分ける（「継続中」と「終了日不明」）。
- すでに保存されている雇用条件どうしで、重ならないことを確かめられないもの（古いデータの復元等で生じたもの）は、どちらも「要確認」とし、確かめるまで、期間に基づく判定（T14・T17）の入力に使わない。
- 例はEX-09。加入の判定基準や制度上の意味は扱わない（T14・T17）。

## 3. 口座（`account`）

入金を受ける口座。照合と表示のための補助の型。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `displayName` | `Text` | 利用者が付ける表示名（例「口座1」） |
| `institutionLabel` | `Fact<Text>` | 金融機関の表示 |
| `note` | `Fact<Text>` | メモ |

口座番号は持たない（照合に使わないため）。

## 4. 給与明細（`payslip`）

1回の支給について勤務先が出した明細の写し。区分は実績。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `employerId` | `Id<Employer>` | 支払者 |
| `paymentKind` | `Fact<salary・bonus・other>` | 明細の種類（給与・賞与・その他）。記載どおり |
| `periodLabel` | `Fact<Text>` | 明細に書かれた対象の表示（例「10月分」）。記載どおり。期間や月を推測しない |
| `workPeriod` | `Fact<Period>` | **勤務期間**。この支給が対象とする勤務の期間。記載がなければ`not-stated` |
| `scheduledPayDate` | `Fact<LocalDate>` | **支払予定日**。明細に書かれた支給日。実際の入金日ではない |
| `grossPay` | `Fact<Yen>`（0以上） | 総支給額。記載どおり |
| `taxablePay` | `Fact<Yen>`（0以上） | 課税支給額。記載がなければ`not-stated` |
| `nonTaxablePay` | `Fact<Yen>`（0以上） | 非課税支給額。記載がなければ`not-stated` |
| `commutingAllowance` | `Fact<Yen>`（0以上） | 通勤手当 |
| `commutingAllowanceTaxTreatment` | `Fact<non-taxable・taxable・mixed>` | 通勤手当の課税区分。記載どおり（`mixed`は一部が課税） |
| `otherEarnings` | `List<EarningLine>` | その他の支給の行 |
| `incomeTax` | `Fact<Yen>`（0以上） | 所得税（源泉徴収税額） |
| `residentTax` | `Fact<Yen>`（0以上） | 住民税（特別徴収） |
| `healthInsurance` | `Fact<Yen>`（0以上） | 健康保険料 |
| `nursingCareInsurance` | `Fact<Yen>`（0以上） | 介護保険料 |
| `pensionInsurance` | `Fact<Yen>`（0以上） | 厚生年金保険料 |
| `employmentInsurance` | `Fact<Yen>`（0以上） | 雇用保険料 |
| `otherDeductions` | `List<DeductionLine>` | その他の控除の行 |
| `yearEndAdjustment` | `Fact<Yen>`（符号あり） | 年末調整の過不足。正は本人への還付、負は追加の徴収 |
| `totalDeductions` | `Fact<Yen>`（0以上） | 控除合計。記載どおり |
| `netPay` | `Fact<Yen>`（符号あり） | 差引支給額。記載どおり |
| `bankTransferAmount` | `Fact<Yen>`（0以上） | 振込額。記載どおり。銀行入金の額から埋めない |
| `supersedes` | `Fact<Ref<Payslip>>` | 再発行された明細の場合だけ、差し替える前の明細（10を参照）。`known`か`not-applicable`だけで、`unknown`は使わない（[共通の型](common-types.md)の12） |

`EarningLine`（その他の支給の行）:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `lineId` | `LineId` | 行のID |
| `label` | `Text` | 行の名前。記載どおり（例「残業手当」「遡及差額」） |
| `category` | `Fact<base・overtime・allowance・bonus・retroactive-adjustment・other>` | 行の分類 |
| `amount` | `Fact<Yen>`（符号あり） | 金額。負は過払いの回収等、記載に負の値がある場合 |
| `taxTreatment` | `Fact<taxable・non-taxable>` | 課税区分。記載どおり |
| `linePeriod` | `Fact<Period>` | 行に書かれた対象期間（遡及差額の対象期間等）。記載がなければ`not-stated`。明細の勤務期間で補わない |

`DeductionLine`（その他の控除の行）:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `lineId` | `LineId` | 行のID |
| `label` | `Text` | 行の名前。記載どおり |
| `amount` | `Fact<Yen>`（0以上） | 金額 |

規則:

- 同じ雇用先・同じ月・同じ支払予定日の明細が複数あってよい（給与と賞与、遡及差額の支給、別の種類の支給）。
- 合計の項目（`grossPay`、`totalDeductions`、`netPay`）は記載どおりに持ち、行や項目から計算した値で上書きしない。行の合計と合計の記載が違う場合（行の入力漏れか、資料の不一致かは区別できない）、差を参考として表示するだけにする（T10・T11）。
- 銀行入金の額から、総支給額・控除・振込額を逆算しない。
- 明細に記載された値（雇用先・勤務期間・支払予定日・金額）を別の値に直すのは、入力の誤りを直す改訂（`correct-input-error`）だけ。雇用先の取り違えもこれで直す（[共通の型](common-types.md)の9の境界）。
- `unknown`・`not-stated`だった項目を、明細とは別の情報源（勤務先の回答等）に基づいて`known`・`not-applicable`にする場合は、`new-information`の改訂にし、`changeNote`に情報源を書く。同じ明細から入力漏れを埋める場合は`correct-input-error`。
- 勤務先が後から支給額を変えた場合は、明細を改訂せず、後の明細の行（遡及差額・回収）か、再発行の明細（10）として記録する。

## 5. 銀行入金（`bank-deposit`）

口座への1件の入金。区分は実績。**総支給額でも課税給与でもない。**

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `accountId` | `Id<Account>` | 入金先の口座 |
| `depositDate` | `Fact<LocalDate>` | **入金日**。通帳・明細に書かれた日付。読めない等で分からなければ`unknown`（`not-applicable`は使わない） |
| `amount` | `Fact<Yen>`（正） | 入金額。分からなければ`unknown`（`not-applicable`は使わない） |
| `descriptionText` | `Fact<Text>` | 摘要。記載どおり |
| `payerHint` | `Fact<Id<Employer>>` | 利用者が考える支払者。照合の候補を出すことと、照合配分の確定の検査（`known`なら、結ぶ明細の`employerId`や予測の`employerId`と一致すること。[照合の規則](reconciliation.md)の3の「識別の次元」）に使う。給与の集計には使わない |
| `purpose` | `Fact<pay・reimbursement・other>` | 利用者の分類（給与の振込・経費の精算・その他）。表示と照合の候補に使う。`pay`でも給与の集計には入らない |

- 起きた入金は、入金日や金額の一部が分からなくても、実績の記録（銀行入金）として状態付きで持つ。予測にしない（予測は、まだ起きていない支給・入金だけ。7）。入金日が分からない入金は、入金日の軸の集計で「日付不明」になり（[照合の規則](reconciliation.md)の2）、金額が分からない入金は、集計の不足になる。
- 金額が分からない入金は、照合配分を確定できない（確定の不変条件に使う金額。[共通の型](common-types.md)の12）。入金日が分からない入金は確定できるが、所得の年の候補ではすべての年になる（[照合の規則](reconciliation.md)の8）。
- 入金だけの記録を保存できる。そのとき、勤務先の支給額・源泉徴収税額・社会保険料は分からないままにする（集計は`no-records`または`incomplete`）。

## 6. 年間資料（`annual-document`）

勤務先が1年分をまとめて出した資料（源泉徴収票等）の写し。区分は実績。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `documentType` | `withholding-slip・other` | 資料の種類（源泉徴収票・その他） |
| `documentLabel` | `Text` | 資料の表題。記載どおり |
| `payerEmployerId` | `Id<Employer>` | 発行した支払者 |
| `targetYear` | `CalendarYear` | 対象の年（「令和8年分」は`2026`） |
| `paymentAmount` | `Fact<Yen>`（0以上） | 支払金額 |
| `incomeAfterEmploymentDeduction` | `Fact<Yen>`（0以上） | 給与所得控除後の金額 |
| `totalIncomeDeductions` | `Fact<Yen>`（0以上） | 所得控除の額の合計額 |
| `withholdingTax` | `Fact<Yen>`（0以上） | 源泉徴収税額 |
| `socialInsurancePremiums` | `Fact<Yen>`（0以上） | 社会保険料等の金額 |
| `yearEndAdjustmentStatus` | `Fact<adjusted・not-adjusted>` | 年末調整の有無。記載から読み取れなければ`not-stated` |
| `includedOtherPayers` | `Fact<List<IncludedPayer>>` | 他の支払者の分を含むという記載（前職分等）。資料を確かめて記載がなければ`known`の空の並び。確かめていなければ`unknown`（既定）。この項目は`known`と`unknown`だけを使う |
| `employmentStartDate` | `Fact<LocalDate>` | 就職の年月日。記載がなければ`not-stated` |
| `employmentEndDate` | `Fact<LocalDate>` | 退職の年月日。記載がなければ`not-stated` |
| `issuedDate` | `Fact<LocalDate>` | 発行日 |
| `supersedes` | `Fact<Ref<AnnualDocument>>` | 再発行（訂正版）の場合だけ、差し替える前の資料（10）。`known`か`not-applicable`だけ（[共通の型](common-types.md)の12） |

`IncludedPayer`（含まれる他の支払者の分）:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `payerEmployerId` | `Fact<Id<Employer>>` | 含まれる支払者。雇用先として登録していなければ`unknown` |
| `payerLabel` | `Fact<Text>` | 記載された支払者の表示 |
| `paymentAmount` | `Fact<Yen>`（0以上） | 記載された支払金額 |
| `withholdingTax` | `Fact<Yen>`（0以上） | 記載された源泉徴収税額 |
| `socialInsurancePremiums` | `Fact<Yen>`（0以上） | 記載された社会保険料等の金額 |

- `includedOtherPayers`では、同じ支払者（`known`の`payerEmployerId`）の行は1件だけにする（保存の検査）。資料に同じ支払者の記載が複数ある場合は、1行にまとめた値を記載どおりに入れ、分けられなければ`unknown`にする。比較（[照合の規則](reconciliation.md)の5）は、この1行と行う。
- 年間資料の**範囲**は、`payerEmployerId`と、`includedOtherPayers`の各行の`payerEmployerId`の集合。範囲は、年間資料どうしを重ねて足さないために使う（[照合の規則](reconciliation.md)の5）。
- `includedOtherPayers`が`unknown`の資料、または`payerEmployerId`が`known`でない行を持つ資料は、**範囲が確定しない**。範囲が確定しない資料は、確定するまで採用しない（[照合の規則](reconciliation.md)の5）。支払者を雇用先として登録していない場合は、登録してから`payerEmployerId`を`known`にする。
- 各項目の制度上の意味（前職分がどの項目に含まれるか、非課税の支給が支払金額に含まれるか等）は定めない。T14で一次資料を確認して決める。
- 年間資料の値を月に配分した記録を作らない。

## 7. 予測（`forecast`）

これからの支給・入金の見込み。区分は見込み。すでに起きた支給・入金は、分からない項目があっても予測にせず、実績の記録（給与明細・銀行入金）に状態付きで持つ。実績が届いても書き換えず、照合配分で実績と結ぶ（[照合の規則](reconciliation.md)の6）。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `subject` | `pay・deposit` | 何の見込みか（給与の支給・入金） |
| `employerId` | `Fact<Id<Employer>>` | 支払者。入金の予測で勤務先に結び付けない場合は`not-applicable`。実績化の確定には、[照合の規則](reconciliation.md)の3の「識別の次元」に従って`known`が必要になる |
| `accountId` | `Fact<Id<Account>>` | 入金先（`subject`が`deposit`の場合だけ）。実績化の確定には`known`が必要（同3） |
| `measure` | `gross-pay・net-pay・bank-transfer・deposit-amount` | 行の金額が何を表すか。`subject`が`pay`なら`gross-pay`・`net-pay`・`bank-transfer`、`deposit`なら`deposit-amount` |
| `lines` | `List<ForecastLine>` | 見込みの行 |
| `basis` | `Fact<contract・past-actuals・user-estimate・other>` | 見込みの根拠（契約・過去の実績・利用者の見積り・その他） |
| `basisNote` | `Fact<Text>` | 根拠のメモ |

`ForecastLine`（見込みの行）:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `lineId` | `LineId` | 行のID |
| `workPeriod` | `Fact<Period>` | 見込みの対象の勤務期間 |
| `expectedMonth` | `YearMonth` | 支払・入金の予定月 |
| `expectedDate` | `Fact<LocalDate>` | 支払・入金の予定日。`known`なら`expectedMonth`の月の日付 |
| `amount` | `Fact<Yen>`（0以上） | 見込みの金額（`measure`で表す金額） |
| `lineStatus` | `open・withdrawn` | 見込みの行が有効か、取り下げたか。取り下げは改訂（`new-information`）で行う |

- 見込みの行の金額は、実績の集計に入らない。見込みの集計には、実績化した分を除いた残りだけが入る（[照合の規則](reconciliation.md)の6）。
- 所得の年への帰属は予測に持たない。計算で見込みを使う場合は、計算runの仮定として記録する（[計算結果](calculation-results.md)）。

## 8. 正式通知（`official-notice`）

行政・保険者・勤務先等の決定・通知の写し。区分は正式通知。推計（計算run）と同じ状態にしない。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `noticeType` | `resident-tax-determination・nhi-premium-determination・dependent-eligibility・insurance-qualification・other` | 通知の種類（住民税の決定・国保の保険料の決定・被扶養者の認定・保険の資格・その他） |
| `noticeLabel` | `Text` | 通知の表題。記載どおり |
| `issuerKind` | `municipality・tax-office・health-insurer・pension-office・employer・other` | 発行者の種類 |
| `issuerLabel` | `Fact<Text>` | 発行者の表示。記載どおり（表記が揺れるので、同じ発行者かどうかの判定には使わない） |
| `issuerId` | `Fact<Id<Issuer>>` | 利用者が登録した発行者（下の「発行者」）。同じ発行者の通知を結ぶ（差し替え等）ために使う |
| `issuedDate` | `Fact<LocalDate>` | 発行日。記載どおり |
| `subjectYear` | `Fact<{ kind: calendar・fiscal, year: YYYY }>` | 通知の対象の年・年度（例 住民税の年度） |
| `incomeYear` | `Fact<CalendarYear>` | 基になった所得の年。記載がなければ`not-stated` |
| `applicablePeriod` | `Fact<Period>` | 決定が当てはまる期間 |
| `amounts` | `List<NoticeAmount>` | 決定された金額の行 |
| `installments` | `List<Installment>` | 納付・徴収の予定の行 |
| `statusDates` | `List<StatusDate>` | 資格の取得日・喪失日等の行 |
| `supersedes` | `Fact<Ref<OfficialNotice>>` | 変更通知等の場合だけ、置き換える前の通知（10）。`known`か`not-applicable`だけ（[共通の型](common-types.md)の12） |

`NoticeAmount`: `lineId`（`LineId`）、`label`（`Text`、記載どおり）、`category`（`Fact<annual-total・other>`）、`amount`（`Fact<Yen>`、0以上）。`category`と`amount`は`not-applicable`を使わない（[共通の型](common-types.md)の12の既定）。

`Installment`: `lineId`、`label`（例「第1期」）、`dueDate`（`Fact<LocalDate>`）、`amount`（`Fact<Yen>`、0以上）、`collectionMethod`（`Fact<special・ordinary・other>`。特別徴収・普通徴収・その他）。

`StatusDate`: `lineId`、`label`、`kind`（`Fact<qualification-acquired・qualification-lost・eligibility-start・eligibility-end・other>`）、`date`（`Fact<LocalDate>`）。

- 通知の金額と、給与明細の控除額（住民税・保険料）は別の集計で、足さない（決定額と徴収の実績は別の事実）。
- 通知の値を計算runの結果として保存しない。計算runの値を通知の値として保存しない。
- 納付予定の組み立て（変更通知の前後の行のつなぎ方）はT18・T19・T20で決める。この契約は、両方の通知と差し替えの関係を残すことだけを定める。

**発行者（`issuer`）:** 正式通知の発行者を、利用者が1回登録して通知から参照する補助の型。表示の揺れ（「架空市」と「架空市役所」等）に左右されずに同じ発行者を表す。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `displayName` | `Text` | 利用者が付ける表示名（例「架空市」）。一意でなくてよい |
| `issuerKind` | `municipality・tax-office・health-insurer・pension-office・employer・other` | 発行者の種類 |
| `note` | `Fact<Text>` | メモ |

## 9. 証憑

証憑は、記録を支える資料のファイル（PDF・画像）。ファイル（`EvidenceFile`）と、記録との紐付け（`evidence-link`）に分ける。ADR-0006の1にある証憑の規則（元の場所を参照せずに複製する、ハッシュに基づく保存名、書き終えてからcommitする、参照中は削除しない）に従う。

### `EvidenceFile`（証憑ファイル）

一度だけ書き、改訂を持たない。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `id` | `Id<EvidenceFile>` | ID（接頭辞`evf`） |
| `sha256` | `Text` | 内容のSHA-256（64文字の小文字16進） |
| `byteSize` | `Count` | バイト数 |
| `mediaType` | `Text` | 例`application/pdf` |
| `originalFileName` | `Text` | 取込時の元の名前。個人情報を含みうる。保存名に使わない |
| `storageName` | `Text` | データルートの`evidence/`の中の保存名。ハッシュに基づく（ADR-0006） |
| `importedAt` | `Instant` | 取込日時（時計の値。順序には使わない） |
| `recordedSeq` | 1以上の整数 | 保存の連番（[共通の型](common-types.md)の7の「保存の順序」） |

- 同じ内容（同じ`sha256`）のファイルは1件だけ持つ。同じファイルを2回取り込んでも、新しい証憑ファイルを作らない。
- ファイルを`evidence/`に書き終えてから、それを参照する記録をcommitする。参照されている証憑ファイルは書き換えず、削除しない（ADR-0006）。

### `evidence-link`（証憑の紐付け）

改訂を持つ記録。紐付けの解除は取消（`void`）で行う。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `evidenceFileId` | `Id<EvidenceFile>` | 証憑ファイル |
| `target` | `Ref<任意の記録>` | 支える記録。`revision`は`current`だけ（記録どうしの関係。[共通の型](common-types.md)の2）。`current`は、その見方で選ばれた版を指すので、過去の時点を再現したときに、その時点になかった版へ結び付いて見えることはない。その見方で参照先の版が選ばれない場合は、紐付けは要確認になる（[共通の型](common-types.md)の2の「`current`の解決」） |
| `locator` | `Fact<Text>` | ファイルの中の位置（例「2ページ目」） |
| `role` | `source・supporting` | 記録の写し元か、補足の資料か |

- 1つのファイルが複数の記録を支えてよい（12か月分の明細が入ったPDF等）。1つの記録が複数のファイルを持ってよい。
- **証憑は金額を持たず、集計に入らない。** 証憑を紐付けても、記録の金額は変わらない。

## 10. 資料の差し替え（`supersedes`）

発行者が資料を作り直した場合（明細の再発行、訂正版の源泉徴収票、変更通知）は、改訂ではなく**新しい記録**にし、新しい記録の`supersedes`で前の記録を指す。`supersedes`は`known`（前の記録を指す）か`not-applicable`（作り直しでない、または前の資料を記録していない）だけで、`unknown`のまま保存しない。作り直しだと分かっていて前の記録が分からない場合は、前の記録を確かめてから保存する（前の記録がないまま新しい記録を足すと、新旧を両方数えるおそれがあるため）。

| 変更 | 表し方 | 前の内容 |
| --- | --- | --- |
| 利用者の入力誤り | 同じ記録の改訂（`correct-input-error`） | 前の改訂として残る |
| 発行者が作り直した資料 | 新しい記録と`supersedes` | 前の記録として残る（取消しない） |
| 後の支給での調整（遡及差額・回収） | 後の明細の行 | 前の明細は変えない |

**差し替えの関係と系列（1つの規則で扱う）:**

1. **有効な関係:** 有効な記録`X`の`supersedes`をたどり、取消した記録は通り過ぎて（取消した記録は、その最新の改訂の`supersedes`をさらにたどる）、最初に着いた有効な記録を`Y`とする。このとき「`X`は`Y`を差し替える」。たどった先に有効な記録がなければ、`X`は何も差し替えない。取消した記録は、関係に現れない。
2. **系列:** 有効な関係でつながった記録の集まり。**整った系列**は、自己参照も循環もなく、どの記録も差し替える記録が1件以下、後継（それを差し替える記録）も1件以下の、1本の鎖。`supersedes`は同じ種類の記録だけを指す。未確認の差し替え（下の「差し替えの識別の次元」）を含む系列も、整っていない系列とする。
3. **保存の検査:** 保存（新規・改訂・取消・取消の取り消し）は、保存したあとのすべての系列が整った系列であり、差し替えの関係ごとに下の「差し替えの識別の次元」が一致する場合だけ許す。自己参照（`supersedes`が自分を指す）、循環（たどると自分に戻る）、分岐（同じ記録を差し替える有効な記録が2件以上）になる保存は拒否する。もう一度作り直された資料は、系列の最新の記録を指す。この検査と保存は1つのtransactionで行う（T07）。
4. **系列の現在の記録:** 整った系列のうち、どの有効な記録にも差し替えられていない記録（鎖の最新）を、その系列の**現在の記録**とする。集計・採用・照合には現在の記録だけを使う。ほかの記録は「差し替え済み」として履歴に表示する。系列に入らない記録（差し替えも、差し替えられもしない記録）は、それ自身が現在の記録。
5. **防御:** 整っていない系列（古いデータの復元等で生じたもの）を見つけた場合は、その系列のすべての記録を、整うまで集計・採用・照合から除き、「要確認」として出す（どれか1件を数えると、二重計上や取り違えになりうるため）。除いた記録が入るはずだった集計は`incomplete`にし、`missing`に状態`conflict`で挙げる（黙って少なく数えない）。

**差し替えの識別の次元:** 差し替える記録と差し替えられる記録（有効な関係の両端）は、資料の種類ごとに次の項目がすべて一致しなければならない。同じ資料の作り直しでない記録（別の勤務先・別の年・別の発行者の資料等）を結んで、前の記録を集計から消さないため。

| 記録 | 一致が必要な項目 |
| --- | --- |
| 給与明細 | `employerId`、`paymentKind`、`scheduledPayDate` |
| 年間資料 | `payerEmployerId`、`documentType`、`targetYear` |
| 正式通知 | `issuerId`、`noticeType`、`subjectYear` |

- 各項目は、[共通の型](common-types.md)の13の「値どうしの比較（4×4の表）」で比べる（`not-applicable`どうしは一致、`known`と`not-applicable`は不一致、`unknown`・`not-stated`が関わる組は未確定）。
- 不一致の項目が1つでもあれば、保存を拒否する。
- 不一致がなく、未確定の項目が1つでもあれば、保存は許すが、その差し替えは「未確認の差し替え」とし、値が分かって一致するまで、その系列を整っていない系列（上の5）として扱う。前の記録も新しい記録も黙って集計から外さず、両方を除いて`conflict`で挙げる。
- すべての項目が一致なら、その差し替えは次元を満たす。
- この表にない項目（金額、勤務期間、発行日等）は、作り直しで変わってよい。

例: `A` ← `B` ← `C`（`B.supersedes`が`A`、`C.supersedes`が`B`）。取消は`status`（と、二重登録なら`duplicateOf`）だけを変え、`body`の`supersedes`は変えない（[共通の型](common-types.md)の9）。上の1〜4から、次のとおりに決まる。

| 取消した記録 | 有効な関係 | 現在の記録 | 差し替え済み |
| --- | --- | --- | --- |
| なし | `A` ← `B` ← `C` | `C` | `A`、`B` |
| `B`だけ | `A` ← `C`（`C`から`B`を通り過ぎて`A`に着く） | `C` | `A` |
| `C`だけ | `A` ← `B` | `B` | `A` |
| `B`と`C` | なし（有効な記録は`A`だけ） | `A` | なし |

どの場合も、数えるのは現在の記録1件だけ（`A`と`C`を両方数えない）。取消した記録は現在の記録にならない。

- **取消の取り消し:** `unvoid`は`status`を`active`に戻し（`duplicateOf`は`not-applicable`に戻る）、`body`は変えないので、表の行が戻る。たとえば`B`と`C`を取消したあとで`B`の取消を取り消すと、「`C`だけ」の行になり、現在の記録は`B`になる。
- **時点を指定した見方:** その時点で選ばれた改訂の`status`で、同じ表を引く。たとえば`B`を取消す前の時点を記録時点の再現で見ると、「なし」の行になり、現在の記録は`C`になる。

- 前の記録（現在の記録でなくなった記録）を参照していた照合配分は「要確認」になる（[照合の規則](reconciliation.md)の9）。
- 時点を指定した見方（[共通の型](common-types.md)の7）では、その見方で選ばれた改訂（取消かどうかを含む）だけで、有効な関係と系列を作る（把握時点の再現で、まだ把握していない変更通知は、前の通知を差し替えない）。

## 11. 4つの日付を分ける

| 日付 | 持つ記録・項目 | 意味 | 使う集計 | 使わないこと |
| --- | --- | --- | --- | --- |
| 勤務期間 | 給与明細`workPeriod`、行の`linePeriod`、予測の行の`workPeriod` | 支給が対象とする勤務の期間 | 勤務期間の表示（期間のまま示す） | 月・年への按分。単独で所得の年を決めること |
| 支払予定日 | 給与明細`scheduledPayDate`、予測の行の`expectedDate`・`expectedMonth` | 明細に書かれた支給日、見込みの予定 | 支払予定日の軸の集計。所得の年の規則の入力（T14の承認後） | 入金の集計 |
| 入金日 | 銀行入金`depositDate` | 口座に入った日 | 入金の集計 | 給与の月の決定。単独で所得の年を決めること |
| 税務上の帰属 | 給与明細ごとに、照合・判断・規則から導く（[照合の規則](reconciliation.md)の8） | 所得の年 | 所得の年の軸の集計、計算 | — |

- 勤務期間から月・年を推測しない。月ごとの表示は、1日に決まる軸（支払予定日・入金日）でだけ行い、勤務期間をまたぐ支給を日割りしない。
- 入金日・勤務期間だけから、所得の年を決めない。支払予定日と入金日の年が違っても（年末の支給が年明けに入金された等）、入金日で帰属を決めない。これらを使う規則が必要かどうかは、T14が一次資料で確かめる（[照合の規則](reconciliation.md)の8）。
