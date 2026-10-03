# 計算結果

[契約の入口](README.md)／前: [照合・採用・集計の規則](reconciliation.md)／次: [合成例](examples.md)

税・保険等の計算の1回の実行（計算run）の型を定める。区分は推計。計算の規則・式・制度の範囲は定めない（T14・T15〜T19）。ここでは、どの計算器でも共通に持つ入力・版・状態・結果・丸めの記録の形を定める。T15は、この形を狭める（必須を増やす、状態の条件を厳しくする）ことはできるが、緩めることはできない。

**適用範囲（契約版1.0・2.0）:** 計算runは、結果が金額（`yen`）か小数（`decimal`）の数値の計算に限る（所得税・住民税・保険料等の試算。T16・T18等）。真偽・列挙・日付の型付きの判断結果（T17の被扶養者認定の見込み、資格の変更日等）は、契約版2.0までの計算runの範囲外とする。その結果の型・型の識別子（`valueType`）・状態・比較・丸めの対象外とする規則は、T17が決め、この契約への追加として足す（決定先はT17、受入条件は[台帳](../implementation-tasks.md)のT17節。1の「数値以外の結果の型」）。T17が決めるまで、型付きの判断結果を計算runに保存せず、`unconfirmedItems`の文や金額で代えない。

## 1. 計算run（`CalculationRun`）

一度だけ書き、改訂を持たない。途中で失敗した場合も、`failed`として書く（状態は2の順序で決める）。

**入力を固める前に止まったrun（1つの規則）:** runは、入力の写し（`inputs`の閉包と必要な写し）を固めたかどうかを`inputStage`（`fixed`・`not-fixed`）に持つ。

- `computed`・`provisional`・`incomplete`は`fixed`だけ。`failed`と`unsupported`は、入力を固める前に止まった場合だけ`not-fixed`にできる（入力の要求の一覧や閉包を作っている途中の異常終了、`target`の地域・年度が対象外で入力の要求の一覧が決まらない、`target.scope`が`unknown`で入力の要求が決まらない等）。
- `not-fixed`のrunは、最小の形で保存する。`inputs`の各並び・`results`・`roundingSteps`・`missingInputs`・`assumptions`は空にし、入力の閉包・必要な写しの集合・結果と丸めの検査をしない（固めていない入力の完全性は確かめられないため）。持つのは、`id`・`createdAt`・`recordedAt`・`recordedSeq`・`calculator`・`appCommit`・`target`・`status`・`inputStage`と、止まった理由（`failed`なら`failure`。どの段階で止まったかを含める。`unsupported`なら`unconfirmedItems`に対象外の理由）と、`ruleSet`・`previousRunId`（[共通の型](common-types.md)の12の表のとおり）だけ。runの履歴の鎖の検査（3）は受ける。結果の項目を持たないので、2の表の「結果の値」は当てはまらない（表示では「入力を固める前に止まった」と示す）。
- `fixed`のrunは、`failed`・`unsupported`でも、通常の検査（入力の閉包、必要な写しの集合、run内の並び）をすべて受ける。結果の値の扱いは2の表のとおり（`failed`の値は表示・比較に使わない）。

**run内の並びの規則（1つの規則）:** 計算runの中の並びは、それぞれ下の表のキーがrun内で一意であり、順序の意味は表のとおりとする。キーが重なるrunは保存しない（計算器の誤りとして扱う）。再計算や比較では、並びの位置ではなくキーで対応を取る。

| 並び | run内で一意のキー | 並びの順序の意味 |
| --- | --- | --- |
| `results` | `key`。`key`の集合は、下の「必要な写しの集合」と過不足なく一致させる | 意味はない（表示の順は計算器が決める） |
| `roundingSteps` | `order`。項目ごとの手順は、下の「必要な写しの集合」と過不足なく一致させる | 適用した順（`order`の連番の順に並べる。下の`RoundingStep`） |
| `assumptions` | `key` | 意味はない。同じ`key`の仮定を2つ持たない |
| `missingInputs` | `field`と`ref`の組 | 意味はない |
| `adoptions` | `year`と、`payers`の各支払者の組（同じ組は1つのスナップショットにだけ現れる。下の`AdoptionSnapshot`）。スナップショットの中の`payers`は支払者の`id`、`comparisons`は`field`で一意。組の集合と比較の項目は、下の「必要な写しの集合」と過不足なく一致させる | 意味はない |
| `inputs.records`・`inputs.allocations`・`inputs.decisions` | 参照先の`id`（`allocations`・`decisions`は要素の`ref`の`id`。1つのrunでは、同じ記録を1つの版でだけ参照する。下の「入力の閉包と推移的な固定」） | 意味はない |
| `unconfirmedItems` | 文そのもの（同じ文を重ねない） | 意味はない |
| `inputs.requests` | `kind`と中身の全体（同じ要求を重ねない） | 意味はない |
| `inputs.decisions`の各要素の`itemPremisesAtRun` | `item`（同じ項目を重ねない） | 意味はない |
| `inputs.attributionRules` | `incomeTimingKind`（区分ごとに1つ） | 意味はない |

**参照の固定:** 計算runの中のすべての`Ref`（`inputs`の各項目、`AdoptionSnapshot`の`adoptedRef`、`Assumption`・`MissingInput`の`ref`、`ResultItem`の`explanationRefs`）は、`revision`に整数を使い、`current`を使わない。後日の改訂で、過去のrunの入力や根拠の表示が変わらないようにするため。

**入力の閉包と推移的な固定（1つの規則）:** runの中では、記録への参照（`Ref`）も、記録・マスタの`Id`も、最新の版や最新の解決に読み替えず、runに固定した版で読む。そのため、runの`inputs`の3つの並び（`records`・`allocations`・`decisions`）は、runを作ったときの見方で選ばれた版で、次の**必要な閉包**と過不足なく一致する（下の「保存のときの検査」）。

- **根:** 次の2つの和集合。`inputs`の3つの並びは、閉包を写したものなので根にしない（根にすると、要求の外の記録を並びに足しても、その記録自身が根になって検査を通ってしまう）。
  - **入力の要求から決まる根（runの中身に頼らない）:** 計算器の版ごとに、`target`（年・年度・地域・手続・基準の時点・範囲）から決まる入力の要求の一覧を決める（T15以降で計算器と一緒に定める）。runは、使った要求を`inputs.requests`に写す。要求ごとに、データベース全体から、その要求の対象になりうる記録をすべて根にする。対象になりうる記録には、その要求の集計の規則が読む記録をすべて含める（取消した記録でも、規則が読むもの（残す方がない二重登録の通知等。[照合の規則](reconciliation.md)の7）を含む）。次元（日付・年度・支払者・口座等）が`unknown`・`not-stated`で対象から外せない記録も含める（[共通の型](common-types.md)の5の「分からない値で絞り込まない」。例: 決定額の要求なら、同じ`noticeType`で`subjectYear`が分からない通知）。
  - **仮定の参照:** runの`assumptions`の`ref`が指す記録（仮定は、計算の入力として利用者・計算器が選んだもの）。
  - **要求の範囲のマスタ:** 要求の`scope`の`employerIds`・`accountIds`が指す雇用先・口座（要求の集計の規則は、範囲のIDを正規のIDに解決するためにこれらを読む。[共通の型](common-types.md)の9の「マスタの取消と二重登録」）。範囲のマスタは、その支払者・口座の記録が1件もなくても根に入る（記録がないことも、その範囲を読んだ結果だから）。`annual-value`の要求で`scope`の`employerIds`が空なら、その時点の有効な雇用先のすべて（下の「必要な写しの集合」の`adoptions`と同じ集合）を根に入れる。ほかの`kind`で範囲が空（限定しない）なら、範囲のマスタの根はない（対象の記録からたどるマスタは、下の「たどる参照」で入る）。
- **導いた結果の参照（根にしない）:** runが持つほかの参照（`adoptedRef`、`MissingInput`の`ref`、`explanationRefs`、`AdoptionSnapshot`の`payers`）は、閉包から導いた結果なので、閉包の中の記録（`payers`は閉包の中の雇用先の正規のID）だけを指せる。閉包の外を指すrunは保存しない（計算器が、要求の外の記録を根拠や不足として持ち込めないように）。例外として、`explanationRefs`は、閉包の中の記録を`target`とする証憑の紐付けを指してよい。その紐付けの版は必要な閉包に加え（証憑は金額を持たず、導いた値を変えないので、逆向きの参照では加えない）、証憑ファイルは下の「たどる参照」のとおり`id`で読む。新しく参照を持つ項目をrunに足すときは、根（入力として選んだもの）か導いた結果のどちらかに分ける。計算runへの参照（`previousRunId`）は、runが不変なので閉包に関わらない。
- **たどる参照（1つの規則）:** 閉包に入った記録が持つすべての参照を、さらにたどる。対象は、`Ref`の項目（[共通の型](common-types.md)の2の`Ref`の表のすべての行）と、型が`Id<…>`の項目（`Fact<Id<…>>`は`known`のとき）のすべてで、項目を選ばない。記録の型に参照の項目を足したときも、たどる対象になる（ここに列挙を書き写さない）。主なものは、照合配分・照合の判断の`from`・`to`・`targets`・`coveredPayslips`・`scope.payers`、証憑の紐付けの`target`（紐付けが支える記録）、記録の`supersedes`・`duplicateOf`（差し替えの系列と、二重登録の取消の鎖の全体）、記録が`Id`で参照するマスタ（雇用先・口座・発行者）と、その二重登録の取消の鎖の先のマスタ（[共通の型](common-types.md)の9の「マスタの取消と二重登録」）。行を指す参照は、その行を持つ記録をたどる。新しく増えるものがなくなるまで繰り返す。証憑ファイル（証憑の紐付けの`evidenceFileId`）は、改訂を持たず書き換えないので、版を固定せずに`id`で読み、`inputs`には置かない（保存のときの検査で実在を確かめる。runに固定した紐付けの版が指す証憑ファイルは、参照されているものとして削除しない。[記録の型](records.md)の9）。
- **置き場所:** 閉包の各記録を、種類に応じて固定する。照合配分は`inputs.allocations`、照合の判断は`inputs.decisions`、ほかの記録（マスタを含む）は`inputs.records`に、その版の整数で置く。

- **逆向きの参照（閉包の完全性）:** runが使う導いた値（予測の残り、照合の残高、帰属、年間の値、比較の状態、決定額、現在の記録、正規の記録）は、その値を決める記録・関係を指す側からたどれない（例: 予測の行を`to`に持つ`forecast-realization`は、予測からは参照されない）。そのため、閉包には、次の表で、閉包の中の記録に対して決まる記録・関係（逆向きの参照を含む）をすべて加える。取消した記録・関係も、たどる途中にあれば除かずに加える（取消した記録は差し替えの系列・二重登録の鎖の橋になり、除くとその先へたどれなくなるため。取消した関係は、使われ方が`not-used`の理由として残る）。

| 閉包の中の記録 | 加える記録・関係（逆向きを含む） | 決まる導いた値 |
| --- | --- | --- |
| 予測 | その行を`to`とする照合配分 | 予測の行の残り（[照合の規則](reconciliation.md)の6） |
| 銀行入金 | それを`to`・`from`とする照合配分 | 照合の残高、予測の実績化の上限（同3） |
| 給与明細 | それを`from`・`to`とする照合配分、それを`targets`・`coveredPayslips`に持つ照合の判断 | 照合の残高、帰属と候補の年（同8）、比較（同5） |
| 年間資料 | それを`from`とする照合配分、それを`targets`に持つ照合の判断 | 比較の状態、採用（同5） |
| 正式通知 | 同じ`noticeType`（`other`を除く）・同じ`subjectYear`の正式通知、同じ集合に割り当てられる類の記録（正規の通知の種類・年度で割り当てる。同7）、それを`targets`に持つ照合の判断 | 決定額と重複の確認（同2・7） |
| 雇用先 | それを`scope.payers`に持つ照合の判断 | 年間の値の採用（同5） |
| 差し替えを持つ記録 | それを`supersedes`で指す記録（後継） | 差し替えの系列の現在の記録（[記録の型](records.md)の10） |
| どの記録も | それを`duplicateOf`で指す記録（二重登録として取り消した記録）と、その記録を指す照合配分 | 正規の記録と、正規の記録に付く使えない関係（照合の規則の9） |

  - **必要な閉包**は、根からの順方向のたどりと、この表による逆向きの追加を、増えなくなるまで繰り返し、上の根拠の証憑の紐付けを加えたもの。年間の値を入力済みの記録から示す場合は、その年に帰属するその支払者の明細も、計算に使った記録（根）に含める。
  - **保存のときの検査:** runを作る処理は、保存のときに（`inputStage`が`fixed`のrunについて。`not-fixed`は上の「入力を固める前に止まったrun」の最小の形だけを確かめる）、次をすべて確かめる。`inputs.requests`が、計算器の版と`target`から決まる要求の一覧と同じであること。要求から決まる根を、runを作ったときの見方でデータベース全体から求め直し、仮定の参照と合わせた根から必要な閉包を計算し直すこと。`inputs`の3つの並びが、必要な閉包と記録も版も過不足なく一致すること（必要な閉包のすべての記録が、runを作ったときの見方で選ばれた版の整数で、種類に応じた並びにある。並びには、必要な閉包の外の記録も、違う版もない）。導いた結果の参照が、閉包の中（と根拠の証憑の紐付け）だけを指すこと。どれかを満たさないrun（必要な記録が足りないrun、要求の外の記録を持つrun、違う版を持つrun、含まれていない記録・マスタを指す記録があるrunを含む）は保存しない。runは不変なので、保存のあとに増えた関係では確かめ直さない（表示で「入力が変わった」と示す。3）。
  - 例はEX-07(a)の「予測を使うrunの閉包」と、EX-04(c)の「決定額を使う計算runの根」（不足と余分）。
- runの中の正規のIDの解決、差し替えの系列、二重登録の鎖は、`inputs`の版だけで導く。`AdoptionSnapshot`の`payers`は、その解決による正規のIDで書く。
- **導いた状態の写し:** 照合配分の使われ方と照合の判断の前提は、確かめ直しの条件（[照合の規則](reconciliation.md)の9）のように、過去の版（`confirmedAgainst`の版）や過去の時点（確定・保存の`recordedSeq`）の解決と比べて決まるので、run時点の1つの版だけからは導けない。そのため、runの中では導き直さず、runを作ったときに導いた結果を写して持つ（`AdoptionSnapshot`と同じく、実行時に導いた結果の写し）。`inputs.allocations`の各要素は`usageAtRun`（照合の規則の9の使われ方の識別子）、`inputs.decisions`の各要素は`premiseAtRun`（`holds`＝前提を満たす、`broken`＝前提が崩れている、同4）を持つ。計算に使ってよいのは、`usageAtRun`が`valid`の配分と、`premiseAtRun`が`holds`の判断だけ（項目ごとの前提を持つ判断は、さらにその項目の前提が`holds`の項目だけ）。
- **写しの細かさ（1つの規則）:** 導いた状態の写しは、契約がその状態を決める細かさと同じにする（粗くすると、一部の項目の変化で判断全体を使えなくするか、変わった項目まで使ってしまい、実行時の状態を一意に再現できないため）。照合の判断の前提が下位の項目ごとに決まるもの（`mismatch-explanation`は`explainedComparisons`の`field`ごと、`annual-adoption`は`scope.payers`の支払者ごと。[照合の規則](reconciliation.md)の4・5）は、判断全体の前提（保存の検証）と項目ごとの前提を分けて写す（`mismatch-explanation`の判断全体の前提は保存の検証のうち資料と範囲の条件、項目ごとの前提は項目ごとの値・結んだ明細の集合・対応表の条件。同4）。照合配分の使われ方は配分ごと（上限ごとの段階2の結果も配分ごとに決まる）、比較の状態は`AdoptionSnapshot`の`comparisons`の`field`ごと、採用の選択は`AdoptionSnapshot`の年・支払者ごとに写す。それ以外の配分・判断は、結果が`unknown`・不足になった理由として固定する（例: 予測の残りが`unknown`になった理由の要再確認の配分）。runを作る処理は、その時点の判定と写しが一致することを確かめてから保存する。
- 1つのrunの中では、同じ記録を1つの版でだけ参照する。run内のすべての参照（根の項目を含む）は、`inputs`に固定した同じ記録の版と同じ整数でなければ保存しない（版が食い違うrunは、どの版で計算したかを再現できないため）。
- そのため、過去のrunを表示・再現するときは、配分・判断・差し替え・二重登録・マスタから辿った記録も、runを作ったときの版と解決になる。runのあとで記録やマスタが改訂・取消・取消の取り消しをされても、runの結果と読み方は変わらない（表示で「入力が変わった」と示す。3）。例: runに固定した`tax-year-assertion`の対象の明細を後で改訂しても、そのrunからは改訂前の版が見える。マスタの例はEX-04(a)の「マスタが変わった場合」。

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `id` | `Id<CalculationRun>` | ID（接頭辞`run`） |
| `createdAt` | `Instant` | 実行日時（実行を始めたときの注入した時計の値）。業務の時刻で、保存の時点の代わりにしない（記録時点の再現・順序には使わない。[共通の型](common-types.md)の7の「保存の時点」） |
| `recordedAt` | `Instant` | 記録日時（runの保存のときの注入した時計の値。保存の時点。同7） |
| `recordedSeq` | 1以上の整数 | 保存の連番（同7の「保存の順序」） |
| `calculator` | `{ id: Text, version: Text }` | 計算器の識別子と版（例 所得税の試算はT16で決める）。暗黙の代わりの計算器を使わない |
| `appCommit` | `Text` | 実行したアプリのcommit（40文字のSHA）。作業ツリーに変更がある状態での実行の扱いは、ADR-0002の実行物の確認と合わせてT15で決める |
| `ruleSet` | `Fact<{ id: Text, version: Text }>` | 使った制度データと版（`target`から選ぶ。1の「手続と基準の時点」）。結果の状態を問わず、制度データを読み込んだrunでは`known`（読み込んだあとで`unsupported`・`failed`になった場合を含む）、読み込まなかったrunでは`not-applicable`。`unknown`は使わない（[共通の型](common-types.md)の12の「計算runの項目の状態」の表） |
| `target` | `Target` | 計算の対象（年・年度・地域） |
| `inputs` | `Inputs` | 入力の固定した写し |
| `status` | `computed・provisional・incomplete・unsupported・failed` | 結果の状態（2の順序で1つに決める） |
| `inputStage` | `fixed・not-fixed` | 入力の写しを固めたか（1の「入力を固める前に止まったrun」）。`not-fixed`は`failed`・`unsupported`だけ |
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
| `procedure` | `withholding・year-end-adjustment・tax-return・levy・premium・recognition` | 計算する手続の種類。`withholding`は給与・賞与の支払ごとの源泉徴収、`year-end-adjustment`は年末調整、`tax-return`は確定申告・準確定申告、`levy`は賦課・決定（住民税・国民健康保険料等の年度の額）、`premium`は保険料の月ごとの額、`recognition`は認定・資格の判定。同じ年・年度でも、手続によって使う規則が違いうるため（施行日と年分の適用の違い、月ごとの料率の切り替え等）、年・年度だけで規則を選ばない |
| `referencePoint` | `Fact<ReferencePoint>` | 規則を選ぶ基準の時点。`ReferencePoint`は`kind`で判別する: `date`（`date: LocalDate`）か`month`（`month: YearMonth`）。手続ごとの意味と形は下の「手続と基準の時点」の表で決め、合わないrunは保存しない。年・年度だけで規則が決まる手続では`not-applicable`。`unknown`なら規則を選べないので、結果の状態は`unsupported`（2）。`not-stated`は使わない |
| `scope` | `Fact<TargetScope>` | 計算の対象の範囲。`TargetScope`は`kind`で判別する: `all-payers`（runを作ったときの有効な雇用先のすべて）か`payers`（`payers: List<Id<Employer>>`。空を許さず、同じ支払者を2回含まない。runを保存するときの見方で正規のID（有効な雇用先）だけを書き、二重登録として取り消した雇用先のIDを書いたrunは保存しない。保存したあとは書き換えず、あとの見方で解決し直さない。3の「runの目的の固定」）。`known`か`unknown`だけ（`not-stated`・`not-applicable`は使わない）。`unknown`なら入力の要求が決まらないので、結果の状態は`unsupported`で、入力を固める前に止まったrun（`not-fixed`）として保存する。下の「対象の範囲」 |
| `scopeNote` | `Fact<Text>` | 対象の範囲の補足のメモ。入力の要求・runの目的・結果の状態の判定に使わない（範囲は`scope`だけで決める） |

**手続と基準の時点（1つの規則）:** 制度データの版（`ruleSet`）と、入力の要求・結果の項目・丸めの手順は、`target`の年・年度、地域、手続、基準の時点から選ぶ。どの手続・時点でどの規則と版を使うか（施行日・適用の年分・料率の切り替えの月・認定の基準日等）はT14が一次資料で決め、この契約は決めない。`referencePoint`の意味と形は、次の表だけで決める（手続を足す、意味を変えるのは契約の変更）。

| `procedure` | `referencePoint` |
| --- | --- |
| `withholding` | `date`: その給与・賞与を支払うべき日 |
| `year-end-adjustment` | `date`: 年末調整を行う日 |
| `tax-return` | `date`: 申告書を提出する日（提出前の試算では、提出を予定する日） |
| `levy` | `not-applicable`（賦課の年度は`year`で表す） |
| `premium` | `month`: 保険料の対象の月 |
| `recognition` | `date`: 認定・判定の基準の日 |

**対象の範囲（1つの規則）:** 計算の対象の範囲は`scope`だけで表し、入力の要求の導出とrunの目的（3）の両方に、この同じ値を使う。保存した`scope`は、あとの見方で解決し直さない（3の「runの目的の固定」）。
- 計算器の版は、許す範囲を決める: `all-payers`だけ（範囲を固定する計算）か、利用者が選ぶ支払者の集合（`payers`）も許すか。許さない範囲の`scope`を持つrunは保存しない。利用者の範囲を`scopeNote`の文だけで表さない（判定に使えないため）。
- 入力の要求は、`scope`から決める。支払者で絞れる要求（給与明細・年間資料・予測の集計等。[共通の型](common-types.md)の11の許す`scope`の次元に`employerIds`がある`kind`）の`employerIds`は、`payers`ならその支払者、`all-payers`なら空（限定しない）。支払者で絞れない要求（正式通知の決定額等）は`scope`によらない。1の「保存のときの検査」は、この`scope`から求め直した要求の一覧と`inputs.requests`を比べる。
- 契約版2.0までの範囲の次元は支払者だけ（記録は利用者本人のものだけで、世帯員等の記録の型はない）。ほかの次元が必要になったら、その記録の型と一緒に`TargetScope`の`kind`として足す（契約の変更）。
- 例はEX-04(a)の「対象の範囲が違うrun」。

`Inputs`:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `records` | `List<Ref>` | 入力に使った記録と、その閉包（1の「入力の閉包と推移的な固定」。差し替えの系列・二重登録の鎖・参照するマスタを含む）。`revision`は必ず整数（固定）。`current`を使わない |
| `allocations` | `List<{ ref: Ref, usageAtRun: not-used・unresolved・duplicate-voided・voided・superseded・stale・needs-recheck・valid }>` | 使った照合配分と、結果に影響した使えない配分（版を固定）。`usageAtRun`は、runを作ったときに導いた使われ方の写し（1の「導いた状態の写し」） |
| `decisions` | `List<{ ref: Ref, premiseAtRun: holds・broken, itemPremisesAtRun: List<{ item: DecisionItem, premise: holds・broken }> }>` | 使った照合の判断と、結果に影響した前提の崩れた判断（版を固定）。`premiseAtRun`は判断全体の前提、`itemPremisesAtRun`は項目ごとの前提の写し（1の「写しの細かさ」）。`DecisionItem`は`kind`で判別する: `field`（`mismatch-explanation`の`explainedComparisons`の項目。年間資料の金額の項目名）か`payer`（`annual-adoption`の`scope.payers`の支払者。正規のID）。項目ごとの前提を持たない種類（`duplicate-review`・`tax-year-assertion`）では空。並びの一意のキーは`item` |
| `adoptions` | `List<AdoptionSnapshot>` | 年間の値の採用の結果（[照合の規則](reconciliation.md)の5）。実行時に導いた結果を写して残す |
| `assumptions` | `List<Assumption>` | 仮定 |
| `attributionRules` | `List<{ incomeTimingKind: 帰属の区分の値, ruleSet: { id: Text, version: Text } }>` | 所得の年への帰属に使った規則の写し（帰属の区分ごとに1つ。[照合の規則](reconciliation.md)の8の「帰属の区分と規則」）。runの中の帰属は、この版の規則で導く（あとで規則の版が変わっても、runの帰属と読み方は変わらない）。区分の値は、runを作った契約版が並べた値だけ。必要な集合は下の「必要な写しの集合」 |
| `requests` | `List<InputRequest>` | 入力の要求の写し（1の「入力の閉包と推移的な固定」の根）。`InputRequest`は`kind`で判別する: `aggregate`（`key`: `AggregateKey`、`scope`: 集計値の`scope`と同じ形。[共通の型](common-types.md)の11）か、`records`（`recordType`と、`target`の年・年度と重なる適用期間。端が分からない期間は[共通の型](common-types.md)の6の「端が分からない期間の扱い」で重なりを決める）。一意のキーは`kind`と中身の全体 |

`AdoptionSnapshot`: `year`（`CalendarYear`）、`payers`（`List<Id<Employer>>`。空を許さず、同じ支払者を2回含まない）、`selection`（`annual-document・entered-payslips・no-annual-document・adoption-needed`）、`adoptedRef`（`Fact<Ref>`。`annual-document`の場合だけ、版を固定。指せるのは、`targetYear`が`year`と同じで、範囲が確定していて、その範囲が`payers`と同じ集合である年間資料だけで、照合の規則の5でその年・支払者に選ばれた資料と同じであること（年間資料の値は範囲全体の分けられない合計なので、範囲の一部の支払者だけのスナップショットに年間資料を固定しない。範囲の一部だけの集計は照合の規則の5の`partial-scope`）。[共通の型](common-types.md)の2の「参照先の種類・粒度・次元」）、`coverage`（`Fact<annual-document・entered-records-only>`。`adoption-needed`の場合は`not-applicable`）、`comparisons`（`List<{ field: 年間資料の金額の項目名, state: rule-pending・not-compared・no-coverage・incomplete・match・mismatch-unresolved・mismatch-explained }>`。項目ごとの比較の状態で、同じ`field`を2回含まない。1つの項目の比較の状態は1つに決まる（[照合の規則](reconciliation.md)の5）ため）。2つの並びの一意のキーは、[共通の型](common-types.md)の12の並びの表による（重なるスナップショットを持つrunは保存しない）。1つのrunの`adoptions`では、同じ年・同じ支払者の組は、ちょうど1つの`AdoptionSnapshot`にだけ現れる（同じ`year`のスナップショットどうしで`payers`が重ならない。照合の規則では、選択は年・支払者ごとに1つのため。保存の検査）。`selection`ごとの`adoptedRef`と`coverage`の状態は1つに決まる（[共通の型](common-types.md)の12）: `annual-document`なら`adoptedRef`は`known`（版を固定）で`coverage`は`annual-document`、`entered-payslips`と`no-annual-document`なら`adoptedRef`は`not-applicable`で`coverage`は`entered-records-only`、`adoption-needed`ならどちらも`not-applicable`。

**必要な写しの集合（1つの規則）:** `inputStage`が`fixed`のrunでは、runが持つ導いた結果の写し（`adoptions`、各`AdoptionSnapshot`の`comparisons`、`inputs.decisions`の`itemPremisesAtRun`、要求の集計に由来する`missingInputs`）と、計算の結果の形（`results`の項目の`key`、`roundingSteps`の手順）は、計算器の版・`target`・入力の要求（`inputs.requests`）と閉包から一意に決まる**必要な集合**と、過不足なく一致しなければならない。重複がないことや、キーが許す値であることだけでは、欠けた要素を見つけられないため（例: `results`が空のrunや、結果の項目・丸めの手順を一部落としたrunが、入力の不足がなければ`computed`になれてしまう）。保存のときに、runを作る処理は必要な集合を求め直し、写しと結果の形を比べる。

| 写し | 必要な集合 |
| --- | --- |
| `adoptions`の（`year`、支払者）の組 | `kind`が`annual-value`の要求の、軸の範囲のすべての年と、`scope`のすべての支払者（正規のID。`scope`が空なら、その時点の有効な雇用先のすべて）の組。さらに、そのうち選択が年間資料の組には、その年間資料の範囲のすべての支払者の組を加える（スナップショットの`payers`は範囲と同じ集合にするため。範囲の一部だけを要求した集計は、照合の規則の5の`partial-scope`のまま）。`annual-value`の要求がなければ空 |
| 各`AdoptionSnapshot`の`comparisons`の`field` | `selection`が`annual-document`なら、その年の`annual-value`の要求の`item`のすべて。それ以外の`selection`なら空 |
| `inputs.decisions`の各要素の`itemPremisesAtRun`の`item` | `mismatch-explanation`なら`explainedComparisons`の`field`のすべて、`annual-adoption`なら`scope.payers`のすべて（正規のID）。ほかの種類は空 |
| `inputs.attributionRules`の`incomeTimingKind` | 閉包の中の給与明細（固定した版）の`incomeTimingKind`の`known`の値のうち、runを作ったときに承認済みの帰属の規則がある区分のすべて。各区分の`ruleSet`は、runを作ったときにその区分に当てはめた規則の識別子と版。承認済みの規則がない区分と、区分が`unknown`の明細は含めない（規則の根拠がないことは、閉包の版から導ける）。閉包に給与明細がなければ空 |
| 要求の集計に由来する`missingInputs` | 要求ごとの集計（[共通の型](common-types.md)の11）の`missing`の行のすべて。計算器の入力の不足（`calculator-input`）は、計算器がこれに足してよい |
| `results`の`key` | 計算器の版が`target`から決める結果の項目の一覧のすべて（一覧はT15以降で計算器と一緒に定める。入力の要求の一覧と同じく、入力の値やrunの中身に頼らずに決める）。当てはまらない項目・計算できなかった項目も省かず、`value`の状態で示す（2の表。当てはまらなければ`not-applicable`、`unsupported`はすべて`unknown`、`incomplete`は不足の影響を受ける項目が`unknown`、`failed`は計算できなかった項目が`unknown`）。一覧が決まらない（`target`が計算器の対象外等）runは、入力の要求の一覧も決まらないので、`not-fixed`にする（1の「入力を固める前に止まったrun」） |
| `roundingSteps`の手順（項目ごとの、`order`の順の`basis`・`method`・`unit`・`ruleRef`・`methodInput`の並び。`basis`が`input`の手順の`method`は、`methodInput`の仮定の値） | `value`が`known`の結果の項目ごとに、計算器の版が`ruleSet`の版・`target`・閉包から一意に決める丸めの手順のすべてを、その順で（手順の決め方はT15以降で計算器と一緒に定める）。`value`が`known`でない項目には手順を持たない。`failed`のrunだけは、項目ごとに、決まった手順の先頭からの一部（異常終了までに適用した分。空でもよい）を持つ（`failed`の値は表示・比較に使わないため。決まっていない手順や、順序の違う手順は持たない） |

- 必要な集合より少ない（スナップショット・支払者・比較の項目・不足の行・結果の項目・丸めの手順が欠けた）runも、多い（要求していない年・支払者・項目、計算器の版が決めていない結果の項目・丸めの手順を含む）runも保存しない。必要な結果の項目が1つ以上あるのに`results`が空の`fixed`のrunも、これで保存しない。
- 年間資料が複数の支払者を範囲に含む場合は、従来どおり、範囲と同じ集合の`payers`を持つスナップショット1つで表し、ほかのスナップショットに同じ組を重ねない（1の「run内の並びの規則」）。年間資料の値は1回だけ数える。
- 例は[合成例](examples.md)のEX-06(d)と、4の「保存しない形」（結果の項目と丸めの手順）。

`Assumption`: `key`（`Text`。run内で一意。1の「run内の並びの規則」）、`valueType`（`text・decimal・yen・rounding-method`）、`value`（`valueType`に合う値。`rounding-method`なら下の`RoundingStep`の`method`の値のどれか）、`source`（`user・forecast・rule-default`）、`ref`（`Fact<Ref>`。予測の行等。`revision`は整数（固定した写し））。

`ResultItem`:

| 項目 | 型 | 意味と制約 |
| --- | --- | --- |
| `key` | `Text` | 結果の項目の識別子。計算器の版ごとに決めた一覧の値だけを使う（自由な文字列にしない。[共通の型](common-types.md)の1の「`other`と自由な値をキーにしない」）。run内で一意 |
| `label` | `Text` | 表示名 |
| `valueType` | `yen・decimal` | 結果の値の型の識別子（`Assumption`の`valueType`と同じ語）。`yen`なら金額（円の整数）、`decimal`なら小数。`value`の状態が`unknown`・`not-applicable`等で値を持たなくても、型はこの項目で決まる |
| `value` | `Fact<Yen>`または`Fact<Decimal>` | 結果の値。`valueType`が`yen`なら`Fact<Yen>`、`decimal`なら`Fact<Decimal>`（合わない値のrunは保存しない）。契約版2.0までの`valueType`はこの2つ（金額と小数）だけ。数値以外の結果は下の「数値以外の結果の型」による |
| `nature` | `estimate` | 常に推計。正式通知の値と同じ状態にしない |
| `explanationRefs` | `List<Ref>` | 根拠の記録への参照（版を固定） |

**数値以外の結果の型（T17で足す）:** 真偽・列挙・日付等の数値以外の結果（被扶養者認定の見込み、資格の変更日等）は、契約版2.0までは定めない（冒頭の「適用範囲」）。必要になるT17が、その型を、`valueType`の値と`value`の型の組として、比較の規則（[共通の型](common-types.md)の13の表への当てはめ方）、結果の状態の規則、丸めの対象外とする規則（`RoundingStep`の`itemKey`から指さない）とともに、この契約に足す。

- 足すときは追加だけとし、既存の型（`Fact<Yen>`・`Fact<Decimal>`）とその意味、結果の状態の区別は変えない。版の上げ方は[README](README.md)の「契約の変更」に従う（既存の処理が知らない型の値を受け取るので、列挙に値を足す変更と同じくメジャーを上げる）。
- それまでは、数値以外の結果を`unconfirmedItems`の文や`label`に書いて、型のある結果の代わりにしない（型・状態・再計算での比較を失うため）。

`RoundingStep`: `order`（適用した順の連番。run内で一意で、1から始まり1ずつ増える）、`itemKey`（`Text`。同じrunの`results`にある`key`だけを指す）、`before`（`Decimal`）、`after`（`Decimal`）、`method`（`floor・ceil・half-up・half-down`）、`unit`（正の`Decimal`。例 `"1"`、`"100"`、`"1000"`）、`basis`（`rule・input・calculator`。下の「丸めの根拠」）、`ruleRef`（`Fact<{ ruleSetId: Text, ruleSetVersion: Text, location: Text }>`。丸めの根拠の制度の箇所）、`methodInput`（`Fact<Text>`。丸め方を受け取った仮定の`key`）。

**丸めの根拠（1つの規則）:** 各手順は、丸め方と単位を何が決めたかを`basis`に持つ。
- `rule`: 制度の規則が丸め方と単位を決める。`ruleRef`は`known`が必要で、`ruleSetId`・`ruleSetVersion`はrunの`ruleSet`（`known`）と同じ、`location`はその制度データの版の中の原典の箇所（条・項・表等）。制度データの版と照合できない参照、`unknown`・`not-stated`の参照の手順を持つrunは保存しない（制度の丸めの根拠を「書くことがない」として省かない）。
- `input`: 制度の規則が、丸め方を取り決め等で選べるとしていて、選んだ丸め方を入力から受け取る（例: 給与から控除する額の端数を、当事者の取り決めで変えられる場合）。`ruleRef`は`rule`と同じく`known`が必要（選べるとする箇所）。`methodInput`は`known`で、同じrunの`Assumption`のうち`valueType`が`rounding-method`のものの`key`を指し、`method`はその仮定の値と同じ。取り決めがあるかどうか分からない場合は、丸め方を推測せず、不足の入力（`calculator-input`）として挙げる（取り決めがないと確かめた場合は、制度の規則どおりの`rule`の手順にする）。
- `calculator`: 制度に依存しない、計算器の内部の丸め（中間の値の小数の桁をそろえる等）。`ruleRef`と`methodInput`は`not-applicable`。制度の規則が端数の扱いを決めている値には使わない。どの手順を`calculator`にするかは、計算器の版が必要な丸めの手順（1の「必要な写しの集合」）として決め、その版の説明に制度に依存しない理由を書く。原典の参照が書けない・分からないことは`calculator`にする理由にならない。
- `rule`・`calculator`の手順の`methodInput`は`not-applicable`。

**丸めではない段階:** 表引き（区間から値を引く）、累計の上限、端数を特定の期へ寄せる配分、月割等の按分、符号で分かれる処理等は丸めではないので、`RoundingStep`で表さない（`RoundingStep`は、`before`を`unit`の倍数へ`method`で丸める1つの操作だけを表す）。それらの段階の型（表の識別子と版・該当の行、上限と累計、配分の単位と寄せ先等）はT15が決め、この契約に追加だけで足す（[README](README.md)の「後続タスクへの引継ぎ」）。それまで、これらの段階を`RoundingStep`に見せかけて記録しない（計算し直せないため）。

ある結果の項目の丸めの手順は、`itemKey`がその項目の`key`である`RoundingStep`を`order`の順に並べたものとする（結果の項目の側には手順の一覧を持たず、`itemKey`だけを正とする。2か所に書いて食い違うことを防ぐため）。丸めの手順がある項目の`value`は、その項目の最後の手順の`after`と同じ値にする。

**丸めは計算し直せる形にする。** 各手順の`after`は、`before`を`unit`の倍数へ`method`で丸めた値と等しい。
- `floor`: `before`以下で最大の`unit`の倍数（負の数は0から遠い方へ）。
- `ceil`: `before`以上で最小の`unit`の倍数。
- `half-up`: 最も近い`unit`の倍数。ちょうど中間なら0から遠い方。
- `half-down`: 最も近い`unit`の倍数。ちょうど中間なら0に近い方（例: 単位`"1"`で`"2856.5"`は`"2856"`、`"-2856.5"`は`"-2856"`、`"2856.6"`は`"2857"`）。

同じ項目の手順が2つ以上あるときは、`order`の順に並べ、2つ目以降の`before`は直前の手順の`after`と等しい。丸め方はこの4つだけで、ほかの丸め方が必要になったら契約を変える（列挙を足すのでメジャーを上げる）。

保存のときに、これらと上の形（`key`の一意性、`itemKey`、`order`の連番、最後の`after`と`value`の一致、丸めの根拠）をすべて検査する。合わないrunは保存しない（計算器の誤りとして扱う。例は4）。

`MissingInput`（`field`と`ref`の組がrun内で一意。1の「run内の並びの規則」）: `field`（`FieldKey`。[共通の型](common-types.md)の11の「不足の項目」）、`ref`（`Fact<Ref>`。`revision`は整数（固定した写し）。`not-applicable`は`field`の`kind`が`calculator-input`の場合だけ）、`state`（`MissingState`。[共通の型](common-types.md)の11の表の状態と同じ）。

## 2. 結果の状態

結果の状態（`status`）は、次の表の**上から順に**条件を調べ、最初に当てはまったものに決める。各行の条件は、それより上の行に当てはまらなかったことを前提にせず、単独で書いてある（どの順に調べても、同じ優先順で1つに決まる）。優先順は`failed` > `unsupported` > `incomplete` > `provisional` > `computed`。

| 順 | 状態 | 条件 | 結果の値（`results`の`value`） |
| --- | --- | --- | --- |
| 1 | `failed` | 計算が異常終了した（ほかの条件が同時に成り立っていても、この状態にする。障害を隠さないため） | 使わない（状態を問わず保存するが、表示・比較に使わない）。監査のために残す |
| 2 | `unsupported` | 異常終了しておらず、対象の年・年度・地域・手続・基準の時点・範囲に承認済みの規則がない、または`jurisdiction`が`known`でない、または`referencePoint`が`unknown`（規則を選べない）、または`scope`が`unknown`（入力の要求が決まらない） | すべて`unknown`。0にしない |
| 3 | `incomplete` | 異常終了しておらず、対象に承認済みの規則があり、必要な入力が足りない（`MissingState`のどれかに当たる入力がある。[共通の型](common-types.md)の11） | 不足の影響を受ける項目は`unknown`。`missingInputs`に1件以上挙げる |
| 4 | `provisional` | 異常終了しておらず、規則があり、必要な入力が足りていて、見込み・仮定、または`coverage`が`entered-records-only`の年間の値を使った | `known`か`not-applicable`。「暫定」と表示する |
| 5 | `computed` | 異常終了しておらず、規則があり、必要な入力が足りていて、見込み・仮定・`entered-records-only`の年間の値を使っていない | `known`か`not-applicable`。それでも推計で、正式通知ではない |

- 計算runの項目のうち状態で決まるもの（`ruleSet`・`failure`・`previousRunId`）は、この表で決まった状態ごとに、[共通の型](common-types.md)の12の「計算runの項目の状態」の表に従う。
- 入力が足りないときに、不足を0や前年の値で補わない。補う仮定を使う場合は、利用者が選んだ仮定として`assumptions`に記録し、状態を`provisional`にする。
- 計算結果と正式通知の値は、比べて差を示すだけで、どちらも書き換えない。

## 3. 不変と再計算

- **計算runは書き換えない。** 入力の記録が訂正されても、過去のrunの入力（固定した版）と結果は変わらない。
- 訂正・新しい情報・制度データの更新のあとで計算し直す場合は、新しいrunを作り、`previousRunId`で前のrunを指す。

**runの履歴（1つの規則）:** runの**目的**は、`calculator.id`、`target.year`、`target.jurisdiction`、`target.procedure`、`target.referencePoint`、`target.scope`の組とする（`calculator.version`・制度データの版・`scopeNote`は、同じ目的の中で変わってよい。手続や基準の時点や範囲が違うrun（月ごとの源泉徴収、年末調整と確定申告、勤務先Aだけと勤務先A・B等）は、別の目的）。`scope`は、`all-payers`は`all-payers`とだけ一致し、`payers`どうしは、それぞれのrunに保存した集合がそのまま同じなら一致する（解決し直さない。下の「runの目的の固定」）。同じ目的のrunは、`previousRunId`でつながった1本の鎖（分岐も合流もない、最初のrunから最新のrunまでの並び）にする。

- 新しいrunの`previousRunId`が`known`なら、次をすべて満たさなければ保存しない: 指すrunが保存済み（新しいrunより`recordedSeq`が小さい。自分自身は指せない）、`calculator.id`・`target.year`・`target.procedure`が同じ、`target.jurisdiction`と`target.referencePoint`が[共通の型](common-types.md)の13の4×4の表で一致（未確定は満たさない。`referencePoint`がどちらも`not-applicable`なら一致）、`target.scope`が上の比べ方で一致（`unknown`は満たさない）、指すrunを`previousRunId`で指す別のrunがない（同じ目的の最新のrunである）。
- 新しいrunの`previousRunId`が`not-applicable`なら、同じ目的（`target.jurisdiction`が`known`で、ほかの要素も上の比べ方で一致するもの）のrunがまだない場合だけ保存する（同じ目的に2本目の鎖を作らない）。`target.jurisdiction`が`known`でないrun、`target.referencePoint`が`unknown`のrun、`target.scope`が`unknown`のrunは目的が決まらないので、鎖の先頭にも途中にもならず、`previousRunId`は`not-applicable`で、ほかのrunから指されない。
- 失敗したrun（`failed`）も鎖に入る（監査のため）。最新のrunが`failed`でも、次のrunはそれを指す。
- この検査と保存は、同じ目的のrunについて1つのtransactionの中で直列に行う（同時に2件が同じrunを指して分岐しないように。T07・T15）。
- 鎖は保存のときの検査で保たれるので、表示では鎖を最新から`previousRunId`でたどり、1通りの履歴として示す。
- **入力が変わった（1つの規則）:** 過去のrunを表示するときは、runに保存した`inputs.requests`から、runのあとの変化を導き直す（記録を書き換えず、そのつど導く）。runに固定した記録の版を比べるだけでは、runのあとで要求の範囲に加わった記録を見つけられないため。`inputStage`が`not-fixed`のrunは入力を固めていないので比べない（表示は1の「入力を固める前に止まったrun」）。
  - **根の決め方:** 保存した`inputs.requests`の各要求の対象になりうる記録（1の「入力の閉包と推移的な固定」の要求から決まる根と同じ決め方）と、runの`assumptions`の`ref`が指す記録（仮定は計算の入力として選んだものなので根に含める）。runが持つほかの参照（`adoptedRef`、`MissingInput`の`ref`、`explanationRefs`、`AdoptionSnapshot`の`payers`）は、閉包から導いた結果なので根にしない（根にすると、要求の対象から外れた記録を「外れた」と示せない）。
  - **比べる2つの閉包:** 固定した側は、この根の決め方を、runに固定した記録と版（`inputs.records`・`inputs.allocations`・`inputs.decisions`）の中だけで当てはめ、1と同じたどり方で求めた閉包（保存のときの検査で、runを作ったときの根と閉包はすべて`inputs`にあるので、runを作ったときの閉包と同じになる）。現在の側は、同じ根の決め方を、現在の見方でデータベース全体に当てはめて求めた閉包。
  - 次のどれかがあれば、表示で「入力が変わった」と示し、どれに当たるかと対象の記録を示す。
    - **加わった:** 現在の閉包にあり、固定した側の閉包にない記録（runのあとに保存された、要求の対象になる記録・照合配分・照合の判断等）。
    - **外れた:** 固定した側の閉包にあり、現在の閉包にない記録（改訂で要求の対象から外れた記録等）。
    - **版が変わった:** runに固定した記録のうち、現在の版が固定した版と違う記録（根拠の証憑の紐付けを含む。閉包のマスタの改訂・取消・取消の取り消しで、現在の正規のIDがrunの中の解決と違う場合を含む）。
    - **規則の版が変わった:** `inputs.attributionRules`の区分ごとの規則の版が、現在その区分に当てはめる承認済みの規則の版と違う（規則の版の更新・取り下げ）。runの帰属と結果は変わらない（写した版で読む）。
  - 計算器の版の要求の一覧がrunのあとで変わっても、比べるのは保存した`inputs.requests`の範囲とする（そのrunが使った要求の範囲で変化を示すため）。現在の閉包を求めるときは、保存した要求のマスタのIDを現在の見方で解決する（変化を示すためだけで、runの中身・目的は変えない。上の「runの目的の固定」）。例はEX-04(a)の「マスタが変わった場合」と、EX-04(c)の「runのあとの変化」。
- 制度データが更新されても、過去のrunを新しい制度で計算し直して上書きしない。
- 過去のrunを再現するために必要な情報（入力の版、制度データの版、計算器の版、アプリのcommit）は、バックアップと復元で保たれる（ADR-0006、T12・T15）。

**runの目的の固定（1つの規則）:** runの目的の要素は、そのrunに保存した値だけで決め、あとの見方で解決し直さない。
- `target`の値（`scope`の`payers`のIDを含む）は、保存したあと書き換えない。`payers`のIDは、そのrunを保存したときの見方で正規のIDだったもので、その解決をrunの中に写して持つことになる（マスタの版を別に固定しなくても、目的が1つに決まる）。
- 目的の比較（上の`previousRunId`の保存の条件、同じ目的のrunがまだないかの確認）と、鎖の表示は、どれも保存した値どうしをそのまま比べる。後日の二重登録の取消・その取消の取り消しで、過去のrunの目的を分け直したり、別々の鎖を1つの目的にまとめたりしない（2本の鎖が同じ目的になって、次のrunがどちらにもつながる状態を作らないため）。
- 統合で正規でなくなった雇用先を`payers`に持つ鎖には、新しいrunはつながらない（そのIDを書いたrunは保存しないため）。その鎖は、保存した範囲のまま閉じた鎖として表示する。統合のあとの計算は、正規のIDの範囲の目的の最新のrunを指す（なければ`not-applicable`で始める）。取消を取り消して雇用先が正規に戻れば、そのIDの範囲の目的の最新のrunを指して続けられる。
- 範囲の雇用先の表示名等を示すときは、そのrunの保存の連番の見方（[共通の型](common-types.md)の7の記録時点の再現）でマスタを読む。`inputs`を持たない`not-fixed`のrunや、範囲の雇用先に明細がないrunでも、目的と表示は保存した値だけで決まる。
- `all-payers`は種類だけを目的に使う（そのときの有効な雇用先の集合は目的に入れない）。`scope`が`unknown`のrunは、これまでどおり目的が決まらない。
- 範囲の雇用先が、のちに二重登録として取り消された・取消を取り消された場合は、表示で「範囲の雇用先が変わった」と示す（目的は変えない。上の「入力が変わった」と同じく、そのつど導く）。
- 例はEX-04(a)の「範囲の雇用先が統合された場合」。

**入力を固める前に止まったrunの例:** 計算runが、入力の要求の一覧を作っている途中で異常終了した。runは`status` `failed`、`inputStage` `not-fixed`、`failure`「入力の要求の一覧を作る途中で停止（段階: 要求の作成）」で、`inputs`・`results`は空のまま保存する（閉包・必要な写しの検査はしない）。入力の写しを固めたあとで丸めの途中に異常終了したrunは、`inputStage` `fixed`で、通常どおり閉包・必要な写しの検査を受けてから`failed`として保存する。

## 4. 丸めの記録の例

形の例であり、制度の計算ではない（項目・単位・丸め方は架空）。

`run_901`の計算器の版（架空）は、`target`から決まる結果の項目の一覧を`item-a`・`item-b`とし、丸めの手順を、`item-a`は1円未満の切り捨てのあと100円未満の切り捨て、`item-b`は1000円未満の切り捨てと決めているとする（1の「必要な写しの集合」）。`item-a`の1円未満の切り捨ては、中間の値の小数をそろえる計算器の内部の丸め（`basis` `calculator`）で、ほかの2つは制度の規則による丸め（`basis` `rule`）とする。`run_901`の`ruleSet`は、架空の制度データ`{ id: rs-x, version: 1 }`。

計算run `run_901`の`results`:

| `key` | `label` | `valueType` | `value` |
| --- | --- | --- | --- |
| `item-a` | 項目A | `yen` | 値あり 12,300 |
| `item-b` | 項目B | `yen` | 値あり 4,000 |

`roundingSteps`:

| `order` | `itemKey` | `before` | `after` | `method` | `unit` | `basis` | `ruleRef` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `item-a` | `"12345.6"` | `"12345"` | `floor` | `"1"` | `calculator` | 対象外 |
| 2 | `item-a` | `"12345"` | `"12300"` | `floor` | `"100"` | `rule` | 値あり `{ ruleSetId: rs-x, ruleSetVersion: 1, location: 架空の第2条 }` |
| 3 | `item-b` | `"4049"` | `"4000"` | `floor` | `"1000"` | `rule` | 値あり `{ ruleSetId: rs-x, ruleSetVersion: 1, location: 架空の第3条 }` |

どの手順も`methodInput`は対象外（`basis`が`input`でない）。

この形から、`item-a`の丸めの手順は`order` 1・2（この順）、`item-b`は`order` 3と一通りに決まる。どちらの項目も、`value`は最後の手順の`after`と同じ。

**`half-down`と、取り決めから受け取る丸め方（架空）:** 別の計算器の版で、ある項目の手順が`before` `"2856.5"`・`unit` `"1"`だとする。`method`が`half-down`なら`after`は`"2856"`（ちょうど中間なので0に近い方）、`half-up`なら`"2857"`。制度の規則が取り決めで丸め方を選べるとしていて、利用者が取り決めを`Assumption`（`key` `rounding-agreement`、`valueType` `rounding-method`、`value` `floor`、`source` `user`）として入れた場合、その手順は`basis` `input`・`methodInput` `rounding-agreement`・`method` `floor`で、`after`は`"2856"`。`ruleRef`は、取り決めで選べるとする制度の箇所を指す。取り決めがあるかどうか分からなければ、丸め方を推測せず、不足の入力として挙げる。

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
| `results`が`item-a`だけ（`item-b`がない）、または`results`が空 | 必要な結果の項目が欠けている（1の「必要な写しの集合」）。入力の不足がなくても`computed`として保存しない |
| `results`に、計算器の版の一覧にない`item-c`がある（`item-c`の手順も形は整っている） | 計算器の版が決めていない結果の項目（余分） |
| `item-a`の手順が`order` 1（1円未満の切り捨て）だけで、`value`が12,345 | 必要な丸めの手順（100円未満の切り捨て）が欠けている。最後の`after`と`value`は一致するので、形の検査だけでは見つからない |
| `item-b`の手順が、1円未満の切り捨てと1000円未満の切り捨ての2つ（`order` 3・4） | 計算器の版が決めていない手順（1円未満の切り捨て）がある（余分） |
| `item-b`の`value`が`unknown`なのに、`order` 3の手順がある | `value`が`known`でない項目には手順を持たない |
| `order` 2（`basis` `rule`）の`ruleRef`が`unknown`、`not-stated`、または`not-applicable` | 制度の規則による丸めは、原典の箇所の参照が必要（1の「丸めの根拠」）。「書くことがない」として省けない |
| `order` 3の`ruleRef`の`ruleSetVersion`が`2`（`run_901`の`ruleSet`は版`1`） | 適用した制度データの版と照合できない |
| `order` 2を`basis` `calculator`・`ruleRef`対象外にした | 計算器の版が決めた必要な手順（`rule`）と違う。原典の参照を省くために`calculator`へ書き換えられない |
| `basis` `input`の手順で、`methodInput`が指す仮定の値が`floor`なのに、`method`が`half-down` | 入力から受け取った丸め方と違う |
