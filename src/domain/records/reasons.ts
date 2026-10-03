// 保存を拒否する理由。T03の台帳（docs/test-oracles/README.mdの「拒否の理由」）の名前のうち、T06が判定するものは
// 同じ名前をそのまま使う（対応表を別に持たない）。台帳にない場面のためにT06が足した名前は、下の3つ。
// 照合配分の確定の条件・識別の次元・配分の符号・判断の保存の検証（T11）と、計算runの保存（T15）の理由は、ここでは判定しない。

export type RejectionReason =
  // 静的（記録1件で決まる）
  | "fact-state-not-allowed" // 共通の型の12（許す状態）
  | "value-invalid" // 共通の型の4・6（符号・範囲・形式・空の文字列）、記録の型の7
  | "list-invalid" // 共通の型の12の「並びの空の意味」（空・一意のキー）、記録の型の6・8
  | "ref-granularity" // 共通の型の2の「参照先の種類・粒度・次元」（記録全体の関係はwholeだけ）
  | "ref-target-invalid" // 同上（種類）、共通の型の9（duplicateOfの先、マスタへの参照の解決）、行が参照先の版にない
  | "invalid-period" // 共通の型の6（start ≤ end）
  | "transition-not-allowed" // 共通の型の9の改訂のモデルの表
  // 場面（記録とその前の版で決まる）
  | "ref-target-missing" // 共通の型の2（参照先が存在しない）
  | "stale-base-revision" // 共通の型の9（古い版での上書き）
  | "body-change-on-void-or-unvoid" // 共通の型の9
  | "immutable-field-changed" // 共通の型の9（改訂で変えられないもの）
  | "line-id-reused" // 共通の型の2のLineId
  | "known-on-in-future" // 共通の型の7（Asia/Tokyoの日付）
  | "write-request-conflict" // 共通の型の10
  // 意味（ほかの記録との関係で決まる）
  | "supersede-dimension-mismatch" // 記録の型の10
  | "supersede-shape" // 記録の型の10（自己参照・循環・分岐）
  | "employment-term-overlap" // 記録の型の2
  | "master-void-referenced" // 共通の型の9の「マスタの取消と二重登録」
  | "canonical-change-breaks-check" // 同上の「正規のIDが変わる保存」
  | "issuer-kind-mismatch" // 同上の「参照する側との属性の整合」
  // T06が足した名前（台帳に該当する場面がない）
  | "record-not-found" // 改訂しようとした記録が存在しない（共通の型の9。改訂は既存の記録にだけ続けられる）
  | "id-already-used" // 新規の保存に、すでに使われたIDが割り当てられた（共通の型の2。一度使ったIDは再利用しない）
  | "known-on-not-inherited"; // 取消・取消の取り消しの把握日が直前の改訂と違う、または入力誤りの訂正で把握日を変えるのにchangeNoteがknownでない（共通の型の7の「把握日の決め方」）

// 拒否の理由の一覧。違反が複数あれば、この順で最初のものを保存の結果の理由にする（違反はすべて返す）。
export const REJECTION_REASONS: readonly RejectionReason[] = [
  "value-invalid",
  "fact-state-not-allowed",
  "list-invalid",
  "ref-granularity",
  "ref-target-invalid",
  "invalid-period",
  "transition-not-allowed",
  "record-not-found",
  "id-already-used",
  "ref-target-missing",
  "stale-base-revision",
  "body-change-on-void-or-unvoid",
  "immutable-field-changed",
  "known-on-not-inherited",
  "line-id-reused",
  "known-on-in-future",
  "write-request-conflict",
  "supersede-dimension-mismatch",
  "supersede-shape",
  "employment-term-overlap",
  "master-void-referenced",
  "canonical-change-breaks-check",
  "issuer-kind-mismatch",
];

export interface Violation {
  readonly reason: RejectionReason;
  readonly path: string;
  readonly message: string;
}
