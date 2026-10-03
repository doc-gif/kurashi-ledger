// 時点を指定した見方（契約版1.0、common-types.mdの7）と、時点から連番への対応。
// 見方は、各記録の改訂から1つを選ぶ。順序はrecordedSeqと版の番号だけで決め、時計の値（recordedAt）では決めない。

import { knownValue } from "./fact.ts";
import { compareDates, isLocalDate } from "./values.ts";
import { recordedAtOf, revisionsOf, type Ledger, type Revision } from "./ledger.ts";

export type View =
  | { readonly kind: "current" }
  | { readonly kind: "record-seq"; readonly seq: number }
  | { readonly kind: "record-time"; readonly time: string }
  | { readonly kind: "known-on"; readonly date: string };

export const CURRENT = { kind: "current" } as const satisfies View;

// 時点Tの連番S(T): recordedSeqが1からsまでのすべての保存の記録日時がT以下である最大のs（なければ0）。
// 時計が巻き戻っても、Tより後の記録日時の保存が現れた番号より後は含めない（連番の順を崩さない）。
export function seqForTime(ledger: Ledger, time: string): number {
  let s = 0;
  for (const entry of ledger.saves) {
    if (recordedAtOf(entry) > time) break;
    s += 1;
  }
  return s;
}

// 見方を、改訂の選び方の形にする（記録時点の再現の時点は連番にする）。
export type ResolvedView = { readonly kind: "current" } | { readonly kind: "record-seq"; readonly seq: number } | { readonly kind: "known-on"; readonly date: string };

export function resolveView(ledger: Ledger, view: View): ResolvedView {
  if (view.kind === "record-time") return { kind: "record-seq", seq: seqForTime(ledger, view.time) };
  return view;
}

// 見方で選ばれる改訂。選ばれなければundefined（現在の見方では、保存された記録なら必ず選ばれる）。
// - 現在: 最新の改訂。
// - 記録時点の再現（連番S）: recordedSeq ≤ Sの改訂のうち、版が最大のもの。
// - 把握時点の再現（日D）: knownOnがknownでD以下の改訂のうち、版が最大のもの。knownOnがunknownの改訂は選ばない。
export function selectRevision(ledger: Ledger, id: string, view: ResolvedView): Revision | undefined {
  const list = revisionsOf(ledger, id);
  let chosen: Revision | undefined;
  for (const r of list) {
    if (view.kind === "record-seq" && r.recordedSeq > view.seq) continue;
    if (view.kind === "known-on") {
      // knownでもLocalDateでない把握日（検査をすり抜けたデータ）はunknownとして扱い、選ばない（P3-1）。
      const d = knownValue(r.knownOn);
      if (!isLocalDate(d) || compareDates(d, view.date) > 0) continue;
    }
    if (chosen === undefined || r.revision > chosen.revision) chosen = r;
  }
  return chosen;
}

// マスタの正規のIDを解決するときの見方（共通の型の9の「マスタの取消と二重登録」の「見方」）。二重登録は利用者の入力の
// 誤りなので、現在の見方と把握時点の再現では各マスタの最新の改訂で、記録時点の再現では連番Sまでの改訂で解決する。
export function masterView(view: ResolvedView): ResolvedView {
  return view.kind === "known-on" ? { kind: "current" } : view;
}
