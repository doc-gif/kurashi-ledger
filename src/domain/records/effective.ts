// 有効な記録（契約版1.0、common-types.mdの9の「検査の対象は有効な記録だけ」）と、記録どうしの関係で決まる保存の条件の
// うち、正規のIDに依存するもの（同9の「正規のIDが変わる保存」の表）。保存の検査（save.ts）は、保存の前と後の状態で
// これらを導き、保存で新しく生じた違反だけを拒否する（復元した古いデータの違反で、関係のない保存を止めない）。

import { knownValue, stateOf } from "./fact.ts";
import { isMasterType, recordTypeOfId, type RecordType } from "./ids.ts";
import { bodyOf, compareStrings, recordIds, type Ledger } from "./ledger.ts";
import { isHistoryValid } from "./history.ts";
import { canonicalMasterId, masterRefsOf } from "./masters.ts";
import { analyzeSeries, isSeriesType, type SeriesAnalysis, type SeriesType } from "./series.ts";
import { intervalOfPeriod, intervalsOverlap } from "./values.ts";
import { masterView, selectRevision, type ResolvedView } from "./views.ts";

// 見方ごとに系列の解析を1回だけ行うための入れ物。
export class SeriesCache {
  private readonly cache = new Map<SeriesType, SeriesAnalysis>();
  private readonly ledger: Ledger;
  private readonly view: ResolvedView;
  constructor(ledger: Ledger, view: ResolvedView) {
    this.ledger = ledger;
    this.view = view;
  }
  get(type: SeriesType): SeriesAnalysis {
    let a = this.cache.get(type);
    if (a === undefined) {
      a = analyzeSeries(this.ledger, type, this.view);
      this.cache.set(type, a);
    }
    return a;
  }
}

// 有効な記録: 見方で選ばれた改訂がactiveで、差し替えを持つ種類なら系列の現在の記録であるもの。その改訂までの履歴が保存の
// 検査を満たすことも求める（duplicateOfの残す方など、有効であることを根拠にする判定のため。PR28-R001）。
export function isEffective(ledger: Ledger, id: string, view: ResolvedView, series: SeriesCache): boolean {
  const type = recordTypeOfId(id);
  if (type === undefined) return false;
  const rev = selectRevision(ledger, id, view);
  if (rev === undefined || rev.status !== "active" || rev.recordType !== type || !isHistoryValid(ledger, rev)) return false;
  if (isSeriesType(type)) return series.get(type).status.get(id) === "current";
  return true;
}

export function effectiveIds(ledger: Ledger, type: RecordType, view: ResolvedView, series: SeriesCache): string[] {
  return recordIds(ledger, type).filter((id) => isEffective(ledger, id, view, series));
}

// 保存の検査（期間の重なり等）の対象にする記録: 有効な記録と、履歴の検査を満たさない記録（取消・差し替え済みであっても、
// その取消・差し替えを根拠に除かない。検査を緩めないため。PR28-R001）。
function isCheckSubject(ledger: Ledger, id: string, view: ResolvedView, series: SeriesCache): boolean {
  const rev = selectRevision(ledger, id, view);
  if (rev === undefined) return false;
  return !isHistoryValid(ledger, rev) || isEffective(ledger, id, view, series);
}

function checkSubjectIds(ledger: Ledger, type: RecordType, view: ResolvedView, series: SeriesCache): string[] {
  return recordIds(ledger, type).filter((id) => isCheckSubject(ledger, id, view, series));
}

export type DependentViolationKind = "master-ref" | "employment-term-overlap" | "included-payers" | "issuer-kind";

export interface DependentViolation {
  readonly kind: DependentViolationKind;
  readonly ids: readonly string[];
  readonly detail: string;
}

export function dependentKey(v: DependentViolation): string {
  return `${v.kind}:${v.ids.join(",")}:${v.detail}`;
}

// 正規のIDに依存する、有効な記録どうしの条件の違反（現在の見方）。
// - master-ref: 有効な記録のマスタへの参照（knownの値）が、有効なマスタに解決できない（同9の「不変条件」）。
// - employment-term-overlap: 同じ雇用先（正規のID）で適用期間が重なる有効な雇用条件（記録の型の2）。
// - included-payers: 年間資料のincludedOtherPayersで、同じ支払者（正規のID）の行が2件以上、または発行した支払者と同じ（同6）。
// - issuer-kind: 正式通知のissuerKindが、issuerIdの正規の発行者のissuerKindと違う（共通の型の9の「参照する側との属性の整合」）。
export function dependentViolations(ledger: Ledger, view: ResolvedView): DependentViolation[] {
  const series = new SeriesCache(ledger, view);
  const out: DependentViolation[] = [];
  const canon = (id: string): string | undefined => canonicalMasterId(ledger, id, view);
  for (const id of recordIds(ledger)) {
    const type = recordTypeOfId(id);
    if (type === undefined || !isCheckSubject(ledger, id, view, series)) continue;
    const rev = selectRevision(ledger, id, view);
    if (rev === undefined) continue;
    for (const ref of masterRefsOf(type, bodyOf(rev))) {
      if (canon(ref.id) === undefined) out.push({ kind: "master-ref", ids: [id], detail: `${ref.path}=${ref.id}` });
    }
  }
  // 雇用条件の期間の重なり（端が分からなければ、その側へ限りなく開いた期間として判定する。共通の型の6）。
  const terms = checkSubjectIds(ledger, "employment-term", view, series).map((id) => {
    const rev = selectRevision(ledger, id, view);
    const employer = (rev === undefined ? {} : bodyOf(rev))["employerId"];
    return { id, employer: typeof employer === "string" ? canon(employer) : undefined, interval: intervalOfPeriod((rev === undefined ? {} : bodyOf(rev))["applicablePeriod"]) };
  });
  for (let i = 0; i < terms.length; i += 1) {
    for (let j = i + 1; j < terms.length; j += 1) {
      const a = terms[i];
      const b = terms[j];
      if (a === undefined || b === undefined || a.employer === undefined || a.employer !== b.employer) continue;
      if (intervalsOverlap(a.interval, b.interval)) out.push({ kind: "employment-term-overlap", ids: [a.id, b.id], detail: a.employer });
    }
  }
  for (const id of checkSubjectIds(ledger, "annual-document", view, series)) {
    const rev = selectRevision(ledger, id, view);
    if (rev === undefined) continue;
    const payer = bodyOf(rev)["payerEmployerId"];
    const issuer = typeof payer === "string" ? canon(payer) : undefined;
    const rows = knownValue(bodyOf(rev)["includedOtherPayers"]);
    if (!Array.isArray(rows)) continue;
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      const raw = typeof row === "object" && row !== null ? knownValue((row as Record<string, unknown>)["payerEmployerId"]) : undefined;
      if (typeof raw !== "string") return;
      const c = canon(raw);
      if (c === undefined) return;
      if (c === issuer) out.push({ kind: "included-payers", ids: [id], detail: `[${i}]=issuer:${c}` });
      if (seen.has(c)) out.push({ kind: "included-payers", ids: [id], detail: `[${i}]=duplicate:${c}` });
      seen.add(c);
    });
  }
  for (const id of checkSubjectIds(ledger, "official-notice", view, series)) {
    const rev = selectRevision(ledger, id, view);
    if (rev === undefined || stateOf(bodyOf(rev)["issuerId"]) !== "known") continue;
    const raw = knownValue(bodyOf(rev)["issuerId"]);
    const c = typeof raw === "string" ? canon(raw) : undefined;
    if (c === undefined) continue;
    const issuerRev = selectRevision(ledger, c, masterView(view));
    if (issuerRev !== undefined && bodyOf(issuerRev)["issuerKind"] !== bodyOf(rev)["issuerKind"]) {
      out.push({ kind: "issuer-kind", ids: [id], detail: `${c}:${String(bodyOf(issuerRev)["issuerKind"])}` });
    }
  }
  return out.sort((a, b) => compareStrings(dependentKey(a), dependentKey(b)));
}

export function isMasterId(id: string): boolean {
  const t = recordTypeOfId(id);
  return t !== undefined && isMasterType(t);
}
