// 状態付きの値（Fact）と、値どうしの比較（契約版1.0、docs/contracts/common-types.mdの5・13）。
// 4つの状態を型で区別し、不明・記載なしを0や空で補わない。0は known(0) だけ。

export type FactState = "known" | "unknown" | "not-stated" | "not-applicable";
export const FACT_STATES: readonly FactState[] = ["known", "unknown", "not-stated", "not-applicable"];

export type Fact<T> =
  | { readonly state: "known"; readonly value: T; readonly note?: string }
  | { readonly state: "unknown" | "not-stated" | "not-applicable"; readonly note?: string };

export function known<T>(value: T): Fact<T> {
  return { state: "known", value };
}
export const UNKNOWN: Fact<never> = { state: "unknown" };
export const NOT_STATED: Fact<never> = { state: "not-stated" };
export const NOT_APPLICABLE: Fact<never> = { state: "not-applicable" };

export function isFactState(v: unknown): v is FactState {
  return typeof v === "string" && (FACT_STATES as readonly string[]).includes(v);
}

// 保存した値（JSON）から状態を読む。Factの形でなければundefined（形の検査は検査の側で行う）。
export function stateOf(v: unknown): FactState | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const s = (v as { state?: unknown }).state;
  return isFactState(s) ? s : undefined;
}

// knownの値。knownでなければundefined（0や空で補わない）。
export function knownValue(v: unknown): unknown {
  if (stateOf(v) !== "known") return undefined;
  return (v as { value?: unknown }).value;
}

// 値どうしの比較（共通の型の13の4×4の表）。結果は一致・不一致・未確定の3つ。
export type Comparison = "match" | "mismatch" | "undetermined";

// 比べる値の当てはめ方（同13の「表への当てはめ方」）。Factでない値は、その値を持つknownとして渡す。
// 値の同じかどうかは、呼ぶ側が決めた等しさ（組なら要素がすべて同じ、マスタのIDなら正規のID）で判定する。
export type Comparable<T> = { readonly state: "known"; readonly value: T } | { readonly state: "unknown" | "not-stated" | "not-applicable" };

export function compareFacts<T>(a: Comparable<T>, b: Comparable<T>, same: (x: T, y: T) => boolean): Comparison {
  if (a.state === "unknown" || a.state === "not-stated" || b.state === "unknown" || b.state === "not-stated") return "undetermined";
  if (a.state === "not-applicable" && b.state === "not-applicable") return "match";
  if (a.state !== "known" || b.state !== "known") return "mismatch";
  return same(a.value, b.value) ? "match" : "mismatch";
}

// 複数の次元の比較を1つにまとめる。不一致が1つでもあれば不一致、そうでなく未確定が1つでもあれば未確定、すべて一致なら一致。
export function combineComparisons(results: readonly Comparison[]): Comparison {
  if (results.includes("mismatch")) return "mismatch";
  if (results.includes("undetermined")) return "undetermined";
  return "match";
}
