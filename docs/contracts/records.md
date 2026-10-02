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

同じ雇用先で適用期間が重なる雇用条件は保存しない（T06で検証する）。加入の判定基準や制度上の意味は扱わない（T14・T17）。

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
| `taxablePay` | `Fact<Yen>`（0以上） | 課税支給額（記載がある場合） |
| `nonTaxablePay` | `Fact<Yen>`（0以上） | 非課税支給額（記載がある場合） |
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
| `supersedes` | `Fact<Ref<Payslip>>` | 再発行された明細の場合だけ、差し替える前の明細（10を参照） |

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
- 明細の雇用先・勤務期間・支払予定日・金額を変えるのは、入力の誤りを直す改訂（`correct-input-error`）だけ。勤務先が後から支給額を変えた場合は、後の明細の行（遡及差額・回収）か、再発行の明細（10）として記録する。

## 5. 銀行入金（`bank-deposit`）

口座への1件の入金。区分は実績。**総支給額でも課税給与でもない。**

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `accountId` | `Id<Account>` | 入金先の口座 |
| `depositDate` | `LocalDate` | **入金日**。通帳・明細に書かれた日付。値が必要 |
| `amount` | `Yen`（正） | 入金額。値が必要 |
| `descriptionText` | `Fact<Text>` | 摘要。記載どおり |
| `payerHint` | `Fact<Id<Employer>>` | 利用者が考える支払者。照合の候補を出すためだけに使う |
| `purpose` | `Fact<pay・reimbursement・other>` | 利用者の分類（給与の振込・経費の精算・その他）。表示と照合の候補に使う。`pay`でも給与の集計には入らない |

- 入金日と金額が分からない入金は記録しない（見込みとして予測に記録する）。
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
| `yearEndAdjustmentStatus` | `Fact<adjusted・not-adjusted>` | 年末調整の有無（記載から読み取れる場合） |
| `includedOtherPayers` | `List<IncludedPayer>` | 他の支払者の分を含むという記載（前職分等）。記載がなければ空 |
| `employmentStartDate` | `Fact<LocalDate>` | 就職の年月日（記載がある場合） |
| `employmentEndDate` | `Fact<LocalDate>` | 退職の年月日（記載がある場合） |
| `issuedDate` | `Fact<LocalDate>` | 発行日 |
| `supersedes` | `Fact<Ref<AnnualDocument>>` | 再発行（訂正版）の場合だけ、差し替える前の資料（下の「資料の差し替え」） |

`IncludedPayer`（含まれる他の支払者の分）:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `payerEmployerId` | `Fact<Id<Employer>>` | 含まれる支払者。雇用先として登録していなければ`unknown` |
| `payerLabel` | `Fact<Text>` | 記載された支払者の表示 |
| `paymentAmount` | `Fact<Yen>`（0以上） | 記載された支払金額 |
| `withholdingTax` | `Fact<Yen>`（0以上） | 記載された源泉徴収税額 |
| `socialInsurancePremiums` | `Fact<Yen>`（0以上） | 記載された社会保険料等の金額 |

- 年間資料の**範囲**は、`payerEmployerId`と、`includedOtherPayers`の`payerEmployerId`（`known`のもの）の集合。範囲は、年間資料どうしを重ねて足さないために使う（[照合の規則](reconciliation.md)の5）。
- 各項目の制度上の意味（前職分がどの項目に含まれるか、非課税の支給が支払金額に含まれるか等）は定めない。T14で一次資料を確認して決める。
- 年間資料の値を月に配分した記録を作らない。

## 7. 予測（`forecast`）

これからの支給・入金の見込み。区分は見込み。実績が届いても書き換えず、照合配分で実績と結ぶ（[照合の規則](reconciliation.md)の6）。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `subject` | `pay・deposit` | 何の見込みか（給与の支給・入金） |
| `employerId` | `Fact<Id<Employer>>` | 支払者 |
| `accountId` | `Fact<Id<Account>>` | 入金先（`subject`が`deposit`の場合だけ） |
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
| `issuerLabel` | `Fact<Text>` | 発行者の表示 |
| `issuedDate` | `Fact<LocalDate>` | 発行日。記載どおり |
| `subjectYear` | `Fact<{ kind: calendar・fiscal, year: YYYY }>` | 通知の対象の年・年度（例 住民税の年度） |
| `incomeYear` | `Fact<CalendarYear>` | 基になった所得の年（記載がある場合） |
| `applicablePeriod` | `Fact<Period>` | 決定が当てはまる期間 |
| `amounts` | `List<NoticeAmount>` | 決定された金額の行 |
| `installments` | `List<Installment>` | 納付・徴収の予定の行 |
| `statusDates` | `List<StatusDate>` | 資格の取得日・喪失日等の行 |
| `supersedes` | `Fact<Ref<OfficialNotice>>` | 変更通知等の場合だけ、置き換える前の通知（下の「資料の差し替え」） |

`NoticeAmount`: `lineId`（`LineId`）、`label`（`Text`、記載どおり）、`category`（`Fact<annual-total・other>`）、`amount`（`Fact<Yen>`、0以上）。

`Installment`: `lineId`、`label`（例「第1期」）、`dueDate`（`Fact<LocalDate>`）、`amount`（`Fact<Yen>`、0以上）、`collectionMethod`（`Fact<special・ordinary・other>`。特別徴収・普通徴収・その他）。

`StatusDate`: `lineId`、`label`、`kind`（`Fact<qualification-acquired・qualification-lost・eligibility-start・eligibility-end・other>`）、`date`（`Fact<LocalDate>`）。

- 通知の金額と、給与明細の控除額（住民税・保険料）は別の集計で、足さない（決定額と徴収の実績は別の事実）。
- 通知の値を計算runの結果として保存しない。計算runの値を通知の値として保存しない。
- 納付予定の組み立て（変更通知の前後の行のつなぎ方）はT18・T19・T20で決める。この契約は、両方の通知と差し替えの関係を残すことだけを定める。

## 9. 証憑

証憑は、記録を支える資料のファイル（PDF・画像）。ファイル（`EvidenceFile`）と、記録との紐付け（`evidence-link`）に分ける。ADR-0006の「証憑」の規則に従う。

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
| `importedAt` | `Instant` | 取込日時 |

- 同じ内容（同じ`sha256`）のファイルは1件だけ持つ。同じファイルを2回取り込んでも、新しい証憑ファイルを作らない。
- ファイルを`evidence/`に書き終えてから、それを参照する記録をcommitする。参照されている証憑ファイルは書き換えず、削除しない（ADR-0006）。

### `evidence-link`（証憑の紐付け）

改訂を持つ記録。紐付けの解除は取消（`void`）で行う。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `evidenceFileId` | `Id<EvidenceFile>` | 証憑ファイル |
| `target` | `Ref<任意の記録>` | 支える記録。版は`current`、または特定の版 |
| `locator` | `Fact<Text>` | ファイルの中の位置（例「2ページ目」） |
| `role` | `source・supporting` | 記録の写し元か、補足の資料か |

- 1つのファイルが複数の記録を支えてよい（12か月分の明細が入ったPDF等）。1つの記録が複数のファイルを持ってよい。
- **証憑は金額を持たず、集計に入らない。** 証憑を紐付けても、記録の金額は変わらない。

## 10. 資料の差し替え（`supersedes`）

発行者が資料を作り直した場合（明細の再発行、訂正版の源泉徴収票、変更通知）は、改訂ではなく**新しい記録**にし、新しい記録の`supersedes`で前の記録を指す。

| 変更 | 表し方 | 前の内容 |
| --- | --- | --- |
| 利用者の入力誤り | 同じ記録の改訂（`correct-input-error`） | 前の改訂として残る |
| 発行者が作り直した資料 | 新しい記録と`supersedes` | 前の記録として残る（取消しない） |
| 後の支給での調整（遡及差額・回収） | 後の明細の行 | 前の明細は変えない |

- 差し替えられた記録（有効な記録の`supersedes`から指されている記録）は、集計・照合の採用から除き、履歴として表示する。
- `supersedes`は同じ種類の記録だけを指す。差し替えの連鎖は1本にする（同じ記録を指す有効な記録が2つあれば、「要確認」として出す）。
- 前の記録を参照していた照合配分は「要確認」になる（[照合の規則](reconciliation.md)の9）。
- 時点を指定した見方（[共通の型](common-types.md)の7）では、その見方で選ばれた記録の`supersedes`だけで差し替えを判定する（把握時点の再現で、まだ把握していない変更通知は、前の通知を差し替えない）。

## 11. 4つの日付を分ける

| 日付 | 持つ記録・項目 | 意味 | 使う集計 | 使わないこと |
| --- | --- | --- | --- | --- |
| 勤務期間 | 給与明細`workPeriod`、行の`linePeriod`、予測の行の`workPeriod` | 支給が対象とする勤務の期間 | 勤務期間の表示（期間のまま示す） | 月・年への按分、所得の年の決定 |
| 支払予定日 | 給与明細`scheduledPayDate`、予測の行の`expectedDate`・`expectedMonth` | 明細に書かれた支給日、見込みの予定 | 支払予定日の軸の集計。所得の年の規則の入力（T14の承認後） | 入金の集計 |
| 入金日 | 銀行入金`depositDate` | 口座に入った日 | 入金の集計 | 給与の月・所得の年の決定 |
| 税務上の帰属 | 給与明細ごとに、照合・判断・規則から導く（[照合の規則](reconciliation.md)の8） | 所得の年 | 所得の年の軸の集計、計算 | — |

- 勤務期間から月・年を推測しない。月ごとの表示は、1日に決まる軸（支払予定日・入金日）でだけ行い、勤務期間をまたぐ支給を日割りしない。
- 入金日は、所得の年の根拠にしない。支払予定日と入金日の年が違っても（年末の支給が年明けに入金された等）、入金日で帰属を決めない。
