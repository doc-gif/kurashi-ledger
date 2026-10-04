# 制度の規則と独立した期待値

T14「制度別の適用範囲と独立した期待値」の成果物。関連Issue: [#27](https://github.com/doc-gif/kurashi-ledger/issues/27)。対象の契約は[記録・照合・計算結果の契約](../contracts/README.md)の契約版`1.0`。

税・保険の制度を、制度ごとに別の仕様として、一次資料に基づいて書く。計算器（T15〜T21）と照合（T11）は、ここで**承認した**規則だけを使う。規則の値は実装の出力から作らず、期待値は規則から独立に（2通りの導き方で）求める。

## 置き場所

| 場所 | 内容 |
| --- | --- |
| `docs/rules/README.md` | この資料。規則に記録する項目、状態と承認、地域の符号、規則の選び方、未対応の扱い |
| `docs/rules/<制度>.md` | 制度ごとの仕様（範囲・入力・規則・丸め・未確認の事項・出典） |
| `rules/manifest.json` | 規則の一覧（識別子・版・状態・適用の範囲・制度データ・一次資料）と、未対応の範囲 |
| `rules/<制度>/*.json` | 規則の制度データ（表・率・丸め。値ごとに原典の箇所を持つ） |
| `tests/fixtures/ledger/regime/regime-cases.json` | 制度のケース（合成の入力と、独立に導いた期待値。T03の雛形を埋めたもの） |
| `tests/rules/rules.test.ts` | manifest・制度データ・制度のケースの形と相互の整合の検査（`npm test`） |

## 制度ごとの状態

T14は制度ごとにPRを分ける（Issue #27の「分割」）。

| 制度 | 仕様 | 状態 |
| --- | --- | --- |
| 所得税（給与所得だけの居住者の年税額: 年末調整・確定申告、令和7年分・令和8年分） | [income-tax.md](income-tax.md) | draft（レビュー待ち） |
| 給与の所得の年への帰属（T01が委ねた規則） | [salary-income-year.md](salary-income-year.md) | draft（レビュー待ち）。自動の帰属は未対応（`autoApply`が`false`。契約の変更は所有者の判断待ち） |
| 源泉徴収票と明細の比較の対応表（T01が委ねた規則） | [withholding-slip-mapping.md](withholding-slip-mapping.md) | draft（レビュー待ち） |
| 所得税の給与の支払ごとの源泉徴収 | なし | 未対応 |
| 住民税、ふるさと納税 | なし（T14のPR B） | 未対応 |
| 勤務先の社会保険（加入の確認・保険料）、被扶養者の認定 | なし（T14のPR C） | 未対応 |
| 国民健康保険 | なし（T14のPR D） | 未対応 |

正本は`rules/manifest.json`（この表は概観）。未対応の制度・手続・年は、計算runの結果の状態を`unsupported`にする（[計算結果](../contracts/calculation-results.md)の2）。未対応を0や推定の値で埋めない。

## 規則に記録する項目（1つの規則）

`rules/manifest.json`の各規則（`ruleSets`の要素）は、次をすべて持つ。欠けた規則は検査で失敗する。

| 項目 | 意味 |
| --- | --- |
| `id`・`version` | 規則の識別子と版。計算runの`ruleSet`（`{ id, version }`）と、丸めの手順の`ruleRef`の`ruleSetId`・`ruleSetVersion`に、この値を書く |
| `status` | `draft`（一次資料から書いたが、別担当のレビューで確かめていない）か`approved`（下の「承認」） |
| `regime`・`kind` | 制度（`income-tax`等。制度のケースの`regime`と同じ語）と、規則の種類（`calculation`＝計算の規則、`attribution`＝所得の年への帰属、`comparison-mapping`＝年間資料と明細の比較の対応表） |
| `spec`・`data` | 仕様の文書と制度データのファイル |
| `applies` | 適用の範囲。地域（`jurisdiction`）、対象の年・年度（`year`）、計算の規則なら手続（`procedure`）と基準の時点（`referencePoint`）。計算runの`target`がこのどれかに当たるときだけ、この規則を選ぶ（下の「規則の選び方」） |
| `sources` | 一次資料のid（manifestの`sources`）。制度データの各値の`source`もこのidを指す |
| `approval` | 承認の証跡の正本（下の「状態と承認」）。`draft`は「未確認」 |
| `requiredInputs`（計算の規則） | 手続ごとの必須の入力のパスと型（`type`: `yen`・`boolean`・`enum`（`values`）・`date`・`object`・`array`）。`procedures`で手続を限る。`when`で、ほかの入力の値による条件を付ける（`greaterThan`・`in`。条件の値が分からなければ必須）。`nullable`は`null`を許す、`emptyAllowed`は空の並びを許す。欠けた・許さない`null`・`unknown`の必須の入力があるrunは`computed`・`provisional`にしない |
| `optionalInputs`（計算の規則） | なくてもよい入力のパスと型（所得税では、年間資料の写し`annualValues`と、家族の判定で必要なときだけ求める`taxpayer`）。あれば型を確かめる。`requiredInputs`・`optionalInputs`・`unsupportedInputs`のどれにもない入力は、検査が拒否する |
| `unsupportedInputs`（計算の規則） | 範囲外の入力の条件（`path`の値が`allowed`にない入力、または数の上限`max`を超える入力。上限ちょうどは範囲内）。`procedures`で手続を限る。当たる入力のrunは、`applies`に当たっても`unsupported`。値が`unknown`なら未対応ではなく不足（`incomplete`）。制度データに対象者の条件の一覧がある制度（所得税の年末調整の`yearEndAdjustmentLimits.targetConditions`）では、条件ごとに1つの要素が同じid（`yearEndAdjustmentCondition`）で対応し、検査が一致を確かめる |
| `autoApply`（帰属の規則） | 規則の根拠で自動に年を決めるか。`false`なら、規則は帰属の根拠を作らない |

一次資料（manifestの`sources`の要素）は、`title`・`publisher`・`url`（https）・`primary`・`documentUpdatedOn`（資料の更新日）・`documentDateBasis`・`retrievedOn`（取得日）を持つ。

- **資料の更新日と取得日を分ける。** `retrievedOn`は、その資料を読んで値を確かめた日。`documentUpdatedOn`は、その資料が更新された日で、`documentDateBasis`がその決め方を示す: `http-last-modified`（取得したときのサーバーの更新日時を日本時間の日付にしたもの）、`egov-revision-updated`（e-Gov法令検索の法令の版の更新日）。資料に書かれた作成年月や「○年○月○日現在の法令」は`documentDateNote`に写す（作成年月だけの表記から日付を作らない）。
- **一次資料**（`primary: true`）は、国・自治体・保険者等が公表した資料（国税庁、総務省、厚生労働省、日本年金機構、協会けんぽ、e-Gov法令検索等）。民間の解説やまとめは一次資料にしない。
- 資料の長い引用、取得した生の資料（PDF・HTML）、作業用の資料をrepoに置かない。値と箇所（ページ・欄・条項）だけを書く。

制度データ（`rules/<制度>/*.json`）の値は、それぞれ`source`（`{ ref: 一次資料のid, location: 箇所 }`）を持つ。別の資料でも同じ値を確かめた場合は`crossCheckSource`に書く。丸めは`rounding`の並びに、項目・方法（`floor`・`ceil`・`half-up`・`half-down`。[計算結果](../contracts/calculation-results.md)の1の`RoundingStep`と同じ）・単位・原典の箇所を書く。

## 状態と承認

- `draft`の規則と制度のケースは、一次資料から書いたが、まだ別の担当が確かめていないもの。計算器・照合の承認済みの規則として使わない（契約の「規則がまだないとき」のまま。T11の比較は`rule-pending`、帰属は`undetermined`、計算runは`unsupported`）。
- **承認:** 実装していない別の担当が、PRのレビューで一次資料と期待値を確かめ（`decision: accepted`）、そのPRがmainに統合されたあと、**別のPR**で、manifestの規則の`status`を`approved`にし、`approval`に証跡を書く。この別のPRも、実装していない別の担当の独立したレビューを受ける。内容のPRの`accepted`を、あとの承認のcommitの承認とはみなさない。実装担当が自分で`approved`にしない。
- **承認の証跡（正本はmanifestの`approval`）:** `{ reviewRecord, reviewedHead, approvalPullRequest }`。`reviewRecord`は内容を確かめたレビュー（またはレビューの記録のコメント）のURL（`https://github.com/doc-gif/kurashi-ledger/pull/<番号>#pullrequestreview-<id>`か`#issuecomment-<id>`）、`reviewedHead`はそのレビューが対象にしたheadの40文字のSHA、`approvalPullRequest`は`approved`にしたPRのURL（`reviewRecord`のPRとは別）。`draft`の規則の`approval`は「未確認」。制度データには証跡を写さず、`status`だけを写す（manifestと同じことを検査する）。`approved`の制度のケースの`derivation.reviewedBy`は、その規則の`approval.reviewRecord`と同じURL。検査が、空・「未確認」・形の違う証跡と、写しの食い違いを拒否する。
- 承認した規則の版の値は書き換えない。誤りや制度の改正は、新しい版（`version`）を足して扱う。過去の計算runは、そのrunの`ruleSet`の版で読めるように、古い版を残す（[計算結果](../contracts/calculation-results.md)の3）。
- 制度のケースは、`approved`の規則だけを使うときに`approved`にできる（検査が確かめる）。

## 期待値の導き方（1つの規則）

制度のケース（`regime-cases.json`）の期待値は、次をすべて満たす。

1. 入力は、このPRで作った架空の値（端数を含む）。実際の明細・通知の値を置き換えて作らない。勤務先・氏名・住所・自治体の個別の事情を入れない。
2. 期待値は、一次資料の規則から、**2通りの独立した導き方**で求め、どちらも同じ値になることを確かめる（`derivation.method`と`derivation.crossCheck`に書く）。例: 給与所得控除後の金額は「表の行を引く」と「表の行の規則（行の下限×率−定数）」、税額は「速算表」と「税率の段階ごとの合計」、基礎控除は「表を引く」と「所得税法の額＋租税特別措置法の加算額」。
3. 実装の出力を期待値にしない（実装はまだない。実装ができたあとも、実装の値で期待値を直さない）。期待値を変える場合は、理由と根拠をPRに残す（AGENTS.md）。
4. **自治体の計算例**（市区町村が公表する住民税・国保の計算例等）は、所有者の承認まで公開のfixtureにしない。出典としてURLで引くことはできる。fixtureは法令の規則から独立に導いた値にする。
5. 公式の計算例（国の資料の設例等）と照合した場合は、その資料と箇所を`derivation`に書く。資料の数値をそのまま写したケースにはしない（合成の入力で、規則から導く）。

期待値の正しさは、検査では確かめられない（検査は形・整合・丸めの計算し直しだけを見る）。別の担当がレビューで確かめる。

## 検査の責務（所有者の決定、PR #29）

規則の検査（`tests/rules/rules.test.ts`）は、次の4つの責務を分け、どのケース・どの表にも同じように当てる（[所有者の決定](https://github.com/doc-gif/kurashi-ledger/pull/29#issuecomment-5969863635)）。

1. **(a) 適用対象:** `target`が規則の`applies`に当たるか、入力が`unsupportedInputs`（年末調整の対象者の条件を含む）に当たるか。`unsupported`の判定はこれだけで決める。
2. **(b) 存在する入力の形:** `requiredInputs`・`optionalInputs`の型、家族の入力の型と許す値、宣言にない入力の名前、年間資料の写しの形と採用した資料の合計、結果の項目の並びと値の形を、`unsupported`を含むすべてのケースで確かめる。未対応の範囲のケースに、その範囲で求められない必須の入力を足すことは求めない（欠落は(c)で数える）。制度データの表も、形（1件以上、全行、整数の昇順の上限、最後の行、率・額の型）を確かめてから中身（速算表の連続、区分のつながり、生年月日と年齢）を照合する。
3. **(c) 分からない値から結果を確定できるか:** 既知の値は正確に使い（例: 所得金額調整控除の対象かが分かれば実際の控除額で本人の合計所得金額を求める）、分からない値のときだけ範囲で控えめに判定する。結果を決めるのに要る分からない入力があれば、`computed`・`provisional`にしない。分からない値を0で補わない。逆に、入力から確定できる結果（例: 対象でない所得金額調整控除の0、家族がいないときの家族の控除の0）は、`incomplete`のケースでも`known`にする。検査は、結果の項目ごとに入力から確定できるかを決め、期待値の`known`・`unknown`と照らす（値は計算しない）。
4. **(d) 原典からの境界の期待値:** 排他の境界は、両側の例を、どの年の規則かを明記して、一次資料から独立に導いた値で持つ（所得税の例は[income-tax.md](income-tax.md)の「制度のケース」）。

## 地域の符号（契約が委ねた体系）

計算runの`target.jurisdiction`（`{ kind, code }`。[計算結果](../contracts/calculation-results.md)の1）の`code`は、次の体系で書く。

| `kind` | `code` | 根拠 |
| --- | --- | --- |
| `national` | `JP`（日本の国の制度） | 国の制度は地域を持たないが、契約は`known`を求めるので、固定の値にする |
| `prefecture` | 全国地方公共団体コードの都道府県の6桁（第3〜5桁が`000`、第6桁が検査数字。例の形: `130001`） | 総務省「全国地方公共団体コード仕様」の5・11 |
| `municipality` | 全国地方公共団体コードの市区町村の6桁（第1・2桁が都道府県、第3〜5桁が市区町村、第6桁が検査数字） | 同6・11 |
| `insurer` | 未確認（保険者番号の体系は、勤務先の保険・国保を扱うT14のPR C・Dで一次資料から決める） | — |

- 検査数字は仕様の11の方式（第1〜5桁に6・5・4・3・2を掛けた積の和を11で割った余りから求める）で確かめ、合わない符号の規則を保存しない（検査）。
- 地域で値が変わる規則（国保の料率、住民税の均等割の超過課税等）は、地域ごとの規則の版にするか入力にし、全国共通の定数にしない。最初に扱う自治体は、非公開の利用設定で選ぶ（公開のfixtureは合成の値）。
- 出典: [全国地方公共団体コード](https://www.soumu.go.jp/denshijiti/code.html)、[全国地方公共団体コード仕様](https://www.soumu.go.jp/main_content/000137948.pdf)（総務省。取得日2026-10-03）。

## 規則の選び方（計算runの`target`から）

[計算結果](../contracts/calculation-results.md)の1の「手続と基準の時点」のとおり、規則は年・年度だけで選ばず、`target`の地域・年（年度）・手続・基準の時点で選ぶ。

1. `target.jurisdiction`・`target.year`・`target.procedure`が、manifestのある規則の`applies`の要素と一致し、`referencePoint`がその要素の範囲（`from`以後、`to`があれば`to`より前）にあれば、その規則を選ぶ。選んだ規則の`unsupportedInputs`に当たる入力なら、結果の状態は`unsupported`。別の規則（`id`）どうしの範囲は重ねない（検査が確かめる）ので、当たる規則は高々1つ。同じ規則に版が2つ以上あれば、承認済みの最も新しい版を選び、使った版をrunの`ruleSet`に残す（古い版は過去のrunのために残す）。
2. 当たる規則がない（未対応の手続・年・地域、施行日前の基準の時点等）、`jurisdiction`が`known`でない、`referencePoint`が`unknown`なら、結果の状態は`unsupported`（契約の2）。
3. `status`が`draft`の規則は、承認されるまで選ばない（`unsupported`のまま）。制度のケースは`draft`の規則で書き、承認と同時に使える。

例: 令和8年分の所得税の年末調整は、改正（基礎控除の引上げ等）が2026-12-01に施行されるので、`referencePoint`（年末調整を行う日）が2026-12-01以後なら`jp-income-tax-salary-2026`、それより前（年の中途で死亡・出国した人の年末調整等）は改正前の規則で、このPRでは未対応（[income-tax.md](income-tax.md)の「規則の選び方」）。

## 契約との対応（T01が委ねた事項）

| 契約が委ねた事項 | 答え |
| --- | --- |
| 所得の年への帰属の規則（[照合の規則](../contracts/reconciliation.md)の8） | [salary-income-year.md](salary-income-year.md)。根拠は所基通36-9（支給日の定めによる）。契約版1.0の明細では範囲外の給与を見分けられないので、自動の帰属は未対応（支払予定日の年は表示の候補だけ）。見分ける項目等の契約の変更は所有者の判断待ち。行ごとの帰属は不要（理由は同資料） |
| 年間資料と明細の比較の対応表（同5） | [withholding-slip-mapping.md](withholding-slip-mapping.md)。対応表にない項目は契約どおり`rule-pending` |
| 各項目の制度上の意味（[記録の型](../contracts/records.md)の6の「前職分がどの項目に含まれるか」等） | [withholding-slip-mapping.md](withholding-slip-mapping.md)の各項目の「意味」 |
| 地域の符号の体系（計算結果の1の`Target`） | 上の「地域の符号」 |
| 手続と基準の時点ごとの規則と版、丸めの根拠（計算結果の1） | 上の「規則の選び方」と、制度ごとの仕様の「規則の選び方」「丸め」 |

契約の変更が必要と分かった事項は、契約を変えずに各資料の「契約への候補」に書き、所有者・調整係の判断を待つ（[契約の変更](../contracts/README.md)の手順）。

## OpenFisca

OpenFiscaの採用は決めない（E01）。ここで決めた規則と期待値は、計算器の実装方法によらない。
