// 資料の差し替え（supersedes）の関係と系列（契約版1.0、records.mdの10の1〜5）。
// 系列の状態・集計・二重登録の取消の残す方・保存の検査は、どれもこの1つの補助の結果だけを使う。
// 関係は取消していない記録（見方で選ばれた改訂がactive）だけから作り、取消した記録は通り過ぎる。

import { combineComparisons, compareFacts, stateOf, type Comparable, type Comparison } from "./fact.ts";
import { recordTypeOfId, type RecordType } from "./ids.ts";
import { bodyOf, compareStrings, recordIds, revisionsOf, type Ledger, type Revision } from "./ledger.ts";
import { isHistoryValid } from "./history.ts";
import { canonicalMasterId } from "./masters.ts";
import { selectRevision, type ResolvedView } from "./views.ts";

export type SeriesType = "payslip" | "annual-document" | "official-notice";
export const SERIES_TYPES: readonly SeriesType[] = ["payslip", "annual-document", "official-notice"];

export function isSeriesType(t: RecordType): t is SeriesType {
  return (SERIES_TYPES as readonly string[]).includes(t);
}

export type SeriesStatus = "current" | "superseded" | "unconfirmed-series" | "voided" | "not-in-view";

// 系列を整っていない系列にする原因。
// - self-reference・cycle・branch・dimension-mismatch: 保存の検査で拒否する形（記録の型の10の3）。
// - dimension-undetermined: 未確認の差し替え（未確定の次元だけを持つ関係）。保存は許し、系列を未確認の系列にする。
// - unresolved: 見方で改訂が選ばれない記録に着いた参照（共通の型の2の「currentの解決」）。
// - invalid-reference: 保存の検査をすり抜けたデータ（supersedesの状態・形が契約にない、参照先がない・種類が違う）。
// - save-check: 見方で選ばれた改訂までの履歴が保存の検査を満たさない（検査をすり抜けたデータ。共通の型の9。PR28-R001）。
export type SeriesProblemKind = "self-reference" | "cycle" | "branch" | "dimension-mismatch" | "dimension-undetermined" | "unresolved" | "invalid-reference" | "save-check";

export interface SeriesProblem {
  readonly kind: SeriesProblemKind;
  readonly ids: readonly string[];
}

export function problemKey(p: SeriesProblem): string {
  return `${p.kind}:${[...p.ids].sort(compareStrings).join(",")}`;
}

export interface SeriesAnalysis {
  readonly type: SeriesType;
  // その種類のすべての記録の状態。
  readonly status: ReadonlyMap<string, SeriesStatus>;
  readonly problems: readonly SeriesProblem[];
}

type SupersedesTarget = { readonly kind: "none" } | { readonly kind: "ref"; readonly id: string } | { readonly kind: "invalid" };

function supersedesOf(rev: Revision): SupersedesTarget {
  const f = bodyOf(rev)["supersedes"];
  const st = stateOf(f);
  if (st === "not-applicable") return { kind: "none" };
  if (st === "known") {
    const v = (f as { value?: unknown }).value;
    if (typeof v === "object" && v !== null) {
      const r = v as { id?: unknown; line?: unknown; revision?: unknown };
      if (typeof r.id === "string" && r.line === "whole" && r.revision === "current") return { kind: "ref", id: r.id };
    }
  }
  return { kind: "invalid" };
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p === x) return x;
    p = this.find(p);
    this.parent.set(x, p);
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    // 根はIDの小さい方（結果を入力順に依存させない）。
    if (compareStrings(ra, rb) < 0) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
}

// 差し替えの識別の次元（記録の型の10の表）を、見方で選ばれた改訂と正規のIDで、4×4の表で比べる。
export function compareSupersedeDimensions(ledger: Ledger, type: SeriesType, newer: Revision, older: Revision, view: ResolvedView): Comparison {
  const master = (v: unknown): Comparable<string> => {
    if (typeof v !== "string") return { state: "unknown" };
    const c = canonicalMasterId(ledger, v, view);
    return c === undefined ? { state: "unknown" } : { state: "known", value: c };
  };
  const factMaster = (f: unknown): Comparable<string> => {
    const st = stateOf(f);
    if (st === "known") return master((f as { value?: unknown }).value);
    return st === undefined ? { state: "unknown" } : { state: st };
  };
  const plain = (v: unknown): Comparable<unknown> => (v === undefined ? { state: "unknown" } : { state: "known", value: v });
  const factPlain = (f: unknown): Comparable<unknown> => {
    const st = stateOf(f);
    if (st === "known") return { state: "known", value: (f as { value?: unknown }).value };
    return st === undefined ? { state: "unknown" } : { state: st };
  };
  const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const subjectEq = (a: unknown, b: unknown): boolean => {
    const x = a as { kind?: unknown; year?: unknown } | null;
    const y = b as { kind?: unknown; year?: unknown } | null;
    return x !== null && y !== null && typeof x === "object" && typeof y === "object" && x.kind === y.kind && x.year === y.year;
  };
  const strEq = (a: string, b: string): boolean => a === b;
  const n = bodyOf(newer);
  const o = bodyOf(older);
  switch (type) {
    case "payslip":
      return combineComparisons([
        compareFacts(master(n["employerId"]), master(o["employerId"]), strEq),
        compareFacts(factPlain(n["paymentKind"]), factPlain(o["paymentKind"]), eq),
        compareFacts(factPlain(n["scheduledPayDate"]), factPlain(o["scheduledPayDate"]), eq),
      ]);
    case "annual-document":
      return combineComparisons([
        compareFacts(master(n["payerEmployerId"]), master(o["payerEmployerId"]), strEq),
        compareFacts(plain(n["documentType"]), plain(o["documentType"]), eq),
        compareFacts(plain(n["targetYear"]), plain(o["targetYear"]), eq),
      ]);
    case "official-notice":
      return combineComparisons([
        compareFacts(factMaster(n["issuerId"]), factMaster(o["issuerId"]), strEq),
        compareFacts(plain(n["noticeType"]), plain(o["noticeType"]), eq),
        compareFacts(factPlain(n["subjectYear"]), factPlain(o["subjectYear"]), subjectEq),
      ]);
  }
}

// 見方での差し替えの系列（記録の型の10の1〜5）。
export function analyzeSeries(ledger: Ledger, type: SeriesType, view: ResolvedView): SeriesAnalysis {
  const ids = recordIds(ledger, type);
  const selected = new Map<string, Revision | undefined>();
  for (const id of ids) selected.set(id, selectRevision(ledger, id, view));
  const isActive = (id: string): boolean => selected.get(id)?.status === "active";
  const uf = new UnionFind();
  const problems: SeriesProblem[] = [];
  // 1. 差し替えの関係: 取消していない記録Xのsupersedesをたどり、取消した記録を通り過ぎて、最初に着いた取消していない記録Y。
  const relation = new Map<string, string>();
  for (const x of ids) {
    if (!isActive(x)) continue;
    const visited = [x];
    let cur = selected.get(x) as Revision;
    if (!isHistoryValid(ledger, cur)) problems.push({ kind: "save-check", ids: [x] });
    for (;;) {
      const s = supersedesOf(cur);
      if (s.kind === "none") break;
      if (s.kind === "invalid") {
        problems.push({ kind: "invalid-reference", ids: [x] });
        break;
      }
      const y = s.id;
      if (y === x && visited.length === 1) {
        problems.push({ kind: "self-reference", ids: [x] });
        break;
      }
      if (visited.includes(y)) {
        // 取消した記録を通り過ぎて戻る循環も、たどると自分に戻る循環として扱う。
        problems.push({ kind: "cycle", ids: [...visited] });
        for (const v of visited) uf.union(x, v);
        break;
      }
      if (recordTypeOfId(y) !== type || revisionsOf(ledger, y).length === 0) {
        problems.push({ kind: "invalid-reference", ids: [x] });
        break;
      }
      const ySel = selected.get(y);
      if (ySel === undefined) {
        // 見方で改訂が選ばれない記録に着いた: 解決できない参照。「関係がない」とはみなさない。
        problems.push({ kind: "unresolved", ids: [x, y] });
        uf.union(x, y);
        break;
      }
      if (ySel.status === "active") {
        relation.set(x, y);
        uf.union(x, y);
        break;
      }
      visited.push(y);
      cur = ySel;
    }
  }
  // 選ばれない記録は、どの改訂のsupersedesでつながる記録も同じ系列に入れる（記録の型の10の「時点を指定した見方」）。
  for (const u of ids) {
    if (selected.get(u) !== undefined) continue;
    for (const r of revisionsOf(ledger, u)) {
      const s = supersedesOf(r);
      if (s.kind === "ref") uf.union(u, s.id);
    }
  }
  // 2. 分岐（同じ記録を差し替える取消していない記録が2件以上）と、取消していない記録どうしの循環。
  const successors = new Map<string, string[]>();
  for (const [x, y] of relation) successors.set(y, [...(successors.get(y) ?? []), x]);
  for (const [y, xs] of successors) {
    if (xs.length > 1) problems.push({ kind: "branch", ids: [y, ...xs] });
  }
  const inCycle = new Set<string>();
  for (const start of relation.keys()) {
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && !path.includes(cur) && !inCycle.has(cur)) {
      path.push(cur);
      cur = relation.get(cur);
    }
    if (cur !== undefined && path.includes(cur)) {
      const loop = path.slice(path.indexOf(cur));
      for (const v of loop) inCycle.add(v);
      problems.push({ kind: "cycle", ids: loop });
    }
  }
  // 差し替えの識別の次元。
  for (const [x, y] of relation) {
    if (inCycle.has(x)) continue;
    const c = compareSupersedeDimensions(ledger, type, selected.get(x) as Revision, selected.get(y) as Revision, view);
    if (c === "mismatch") problems.push({ kind: "dimension-mismatch", ids: [x, y] });
    else if (c === "undetermined") problems.push({ kind: "dimension-undetermined", ids: [x, y] });
  }
  // 4・5. 系列の現在の記録と、整っていない系列。
  const bad = new Set<string>();
  for (const p of problems) for (const id of p.ids) bad.add(uf.find(id));
  const status = new Map<string, SeriesStatus>();
  for (const id of ids) {
    const sel = selected.get(id);
    if (sel === undefined) status.set(id, "not-in-view");
    else if (sel.status === "voided") status.set(id, "voided");
    else if (bad.has(uf.find(id))) status.set(id, "unconfirmed-series");
    else if (successors.has(id)) status.set(id, "superseded");
    else status.set(id, "current");
  }
  return { type, status, problems: dedupeProblems(problems) };
}

function dedupeProblems(problems: readonly SeriesProblem[]): SeriesProblem[] {
  const seen = new Map<string, SeriesProblem>();
  for (const p of problems) {
    const k = problemKey(p);
    if (!seen.has(k)) seen.set(k, p);
  }
  return [...seen.entries()].sort(([a], [b]) => compareStrings(a, b)).map(([, p]) => p);
}
