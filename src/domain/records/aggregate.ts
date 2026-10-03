// 記録だけで決まる集計（契約版1.0、common-types.mdの11、reconciliation.mdの2）: 入金額（deposit-amount）と
// 給与明細の項目（payslip-item）。帰属・採用・実績化・正式通知の類を導く集計（payslip-by-income-year・annual-value・
// forecast-remaining・notice-determination）はT11が行う。
// 不明・記載なしは0として足さず、不足（missing）に挙げる。不足があればincompleteで、合計として示さない。
// 記録はIDの順に処理し、入力順・保存順に依存しない。合計が安全な整数を超えたら誤りとして止め、丸めない。

import { knownValue, stateOf } from "./fact.ts";
import { isIdWithPrefix, recordTypeOfId } from "./ids.ts";
import { bodyOf, compareStrings, recordIds, revisionsOf, type Ledger, type Revision } from "./ledger.ts";
import { canonicalMasterId } from "./masters.ts";
import { PAYSLIP_AMOUNT_ITEMS, type PayslipAmountItem } from "./schema.ts";
import { analyzeSeries } from "./series.ts";
import { isHistoryValid } from "./history.ts";
import { addYen, isLocalDate } from "./values.ts";
import { resolveView, selectRevision, type View } from "./views.ts";

export type RecordAggregateKey = { readonly kind: "deposit-amount" } | { readonly kind: "payslip-item"; readonly item: PayslipAmountItem };

export interface RecordAggregateRequest {
  readonly key: RecordAggregateKey;
  readonly axis: "deposit-date" | "scheduled-pay-date";
  readonly scope: { readonly employerIds: readonly string[]; readonly accountIds: readonly string[]; readonly from: string; readonly to: string };
}

// 不足の状態（共通の型の11のMissingState）。この集計で生じるのはconflict・not-stated・unknown。
export type MissingState = "conflict" | "adoption-needed" | "partial-scope" | "rule-pending" | "undetermined" | "not-stated" | "unknown";
const MISSING_PRIORITY: readonly MissingState[] = ["conflict", "adoption-needed", "partial-scope", "rule-pending", "undetermined", "not-stated", "unknown"];

export type FieldKey = { readonly kind: "record-item"; readonly name: string } | { readonly kind: "derived"; readonly key: "supersede-series" | "save-check" };

export interface MissingEntry {
  readonly ref: { readonly id: string; readonly revision: number; readonly line: "whole" };
  readonly field: FieldKey;
  readonly state: MissingState;
}

export type AggregateState = "complete" | "incomplete" | "not-applicable" | "no-records";

// 集計値（共通の型の11）。excludedCountは、契約の「対象外」の範囲が決まっていない（docs/test-oracles/README.mdの未決事項1）ので返さない。
export interface AggregateValue {
  readonly measure: RecordAggregateKey;
  readonly axis: RecordAggregateRequest["axis"];
  readonly scope: RecordAggregateRequest["scope"];
  readonly state: AggregateState;
  readonly knownSum: number;
  readonly missing: readonly MissingEntry[];
  readonly coverage: { readonly state: "not-applicable" };
}

export type AggregateResult =
  | { readonly ok: true; readonly values: readonly [AggregateValue] }
  | { readonly ok: false; readonly error: "overflow" | "rejected-request"; readonly message: string };

type Obj = Readonly<Record<string, unknown>>;
function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rejected(message: string): AggregateResult {
  return { ok: false, error: "rejected-request", message };
}

// 要求の検査（共通の型の11）: 表にないkind・修飾子、kindと合わないaxis、許さないscopeの次元に空でない値、from > toを拒否する。
function parseRequest(ledger: Ledger, request: unknown): RecordAggregateRequest | string {
  if (!isObj(request) || !isObj(request["key"]) || !isObj(request["scope"])) return "要求の形が違う";
  const key = request["key"];
  const scope = request["scope"];
  let parsedKey: RecordAggregateKey;
  let axis: RecordAggregateRequest["axis"];
  let dim: "employerIds" | "accountIds";
  if (key["kind"] === "deposit-amount" && Object.keys(key).length === 1) {
    parsedKey = { kind: "deposit-amount" };
    axis = "deposit-date";
    dim = "accountIds";
  } else if (key["kind"] === "payslip-item" && Object.keys(key).length === 2 && (PAYSLIP_AMOUNT_ITEMS as readonly unknown[]).includes(key["item"])) {
    parsedKey = { kind: "payslip-item", item: key["item"] as PayslipAmountItem };
    axis = "scheduled-pay-date";
    dim = "employerIds";
  } else {
    return `記録の集計のキーではない（deposit-amount・payslip-itemだけ。ほかの集計はT11）: ${JSON.stringify(key)}`;
  }
  if (request["axis"] !== axis) return `${parsedKey.kind}の日付の軸は${axis}`;
  const employerIds = scope["employerIds"];
  const accountIds = scope["accountIds"];
  if (!Array.isArray(employerIds) || !Array.isArray(accountIds)) return "scopeのemployerIds・accountIdsが並びではない";
  const other = dim === "employerIds" ? accountIds : employerIds;
  if (other.length > 0) return `${parsedKey.kind}はscopeの${dim === "employerIds" ? "accountIds" : "employerIds"}を許さない`;
  const ids = dim === "employerIds" ? employerIds : accountIds;
  const prefix = dim === "employerIds" ? "emp" : "acct";
  for (const id of ids) {
    if (!isIdWithPrefix(id, prefix) || !ledger.revisions.has(id)) return `scopeの${dim}に登録していないID: ${String(id)}`;
  }
  if (new Set(ids).size !== ids.length) return `scopeの${dim}に同じIDが2回ある`;
  const from = scope["from"];
  const to = scope["to"];
  if (!isLocalDate(from) || !isLocalDate(to) || from > to) return "scopeのfrom・toがLocalDateでないか、from > to";
  if (Object.keys(scope).length !== 4) return "scopeに余分な項目";
  return {
    key: parsedKey,
    axis,
    scope: { employerIds: dim === "employerIds" ? (ids as string[]) : [], accountIds: dim === "accountIds" ? (ids as string[]) : [], from, to },
  };
}

function fieldKeyString(f: FieldKey): string {
  return f.kind === "record-item" ? `record-item:${f.name}` : `derived:${f.key}`;
}

export function aggregateRecords(ledger: Ledger, request: unknown, view: View = { kind: "current" }): AggregateResult {
  const parsed = parseRequest(ledger, request);
  if (typeof parsed === "string") return rejected(parsed);
  const rv = resolveView(ledger, view);
  const isDeposit = parsed.key.kind === "deposit-amount";
  const type = isDeposit ? "bank-deposit" : "payslip";
  const dimField = isDeposit ? "accountId" : "employerId";
  const dateField = isDeposit ? "depositDate" : "scheduledPayDate";
  const itemField = parsed.key.kind === "deposit-amount" ? "amount" : parsed.key.item;
  const scopeIds = isDeposit ? parsed.scope.accountIds : parsed.scope.employerIds;
  const scopeCanon = new Set<string>();
  for (const id of scopeIds) {
    const c = canonicalMasterId(ledger, id, rv);
    if (c === undefined) return rejected(`scopeのIDが有効なマスタに解決できない: ${id}`);
    scopeCanon.add(c);
  }
  const series = isDeposit ? undefined : analyzeSeries(ledger, "payslip", rv);
  const missing = new Map<string, { entry: MissingEntry; date: string | undefined }>();
  const addMissing = (rev: Revision, field: FieldKey, state: MissingState, date: string | undefined): void => {
    const k = `${rev.id}\u0000${fieldKeyString(field)}`;
    const prev = missing.get(k);
    // 同じ（ref, field）の組は1行。原因が2つ以上なら優先順で1つの状態にする（共通の型の11）。
    if (prev !== undefined && MISSING_PRIORITY.indexOf(prev.entry.state) <= MISSING_PRIORITY.indexOf(state)) return;
    missing.set(k, { entry: { ref: { id: rev.id, revision: rev.revision, line: "whole" }, field, state }, date });
  };
  let knownSum = 0;
  let targets = 0;
  let notApplicable = 0;
  for (const id of recordIds(ledger, type)) {
    const rev = selectRevision(ledger, id, rv);
    if (rev === undefined || rev.status !== "active") continue; // 見方にない記録と取消した記録は除く。
    const seriesStatus = series?.status.get(id);
    if (seriesStatus === "superseded") continue; // 差し替え済みの記録は除く。
    // 範囲の次元（勤務先・口座）と日付の軸で、範囲の外と確定できる記録を除く。有効なマスタに解決できない参照と、knownでない
    // 日付では除かない（共通の型の5の「分からない値で絞り込まない」）。
    const placement = (r: Revision): { out: boolean; canon: string | undefined; dateFact: unknown; date: string | undefined } => {
      const body = bodyOf(r);
      const rawDim = body[dimField];
      const canon = typeof rawDim === "string" && recordTypeOfId(rawDim) !== undefined ? canonicalMasterId(ledger, rawDim, rv) : undefined;
      const dateFact = body[dateField];
      const dv = knownValue(dateFact);
      const date = isLocalDate(dv) ? dv : undefined;
      const outOfScope = canon !== undefined && scopeCanon.size > 0 && !scopeCanon.has(canon);
      const outOfRange = date !== undefined && (date < parsed.scope.from || date > parsed.scope.to);
      return { out: outOfScope || outOfRange, canon, dateFact, date };
    };
    const here = placement(rev);
    if (!isHistoryValid(ledger, rev)) {
      // 保存の検査をすり抜けた履歴（共通の型の9。PR28-R001）。集計の根拠にせず、黙って数えも落としもしない。どの改訂の値が
      // 正しいか分からないので、選ばれた改訂までのすべての改訂がそろって範囲の外を示すときだけ除く。
      const versions = revisionsOf(ledger, id).filter((r) => r.revision <= rev.revision);
      if (versions.every((r) => placement(r).out)) continue;
      addMissing(rev, { kind: "derived", key: "save-check" }, "conflict", here.date);
      continue;
    }
    if (here.out) continue;
    const { canon, dateFact } = here;
    const dateKnown = here.date !== undefined;
    const d = here.date;
    let blocked = false;
    if (seriesStatus === "unconfirmed-series") {
      addMissing(rev, { kind: "derived", key: "supersede-series" }, "conflict", d);
      blocked = true;
    }
    if (!dateKnown) {
      const st = stateOf(dateFact);
      addMissing(rev, { kind: "record-item", name: dateField }, st === "not-stated" ? "not-stated" : "unknown", d);
      blocked = true;
    }
    if (canon === undefined) {
      addMissing(rev, { kind: "record-item", name: dimField }, "unknown", d);
      blocked = true;
    }
    if (blocked) continue;
    const v = bodyOf(rev)[itemField];
    const st = stateOf(v);
    if (st === "known") {
      const n = knownValue(v);
      if (typeof n !== "number") continue; // 形の違う値は上の保存の検査でsave-checkに挙がっている。
      const s = addYen(knownSum, n);
      if (s === undefined) return { ok: false, error: "overflow", message: `合計が安全な整数の範囲を超える（${id}で）` };
      knownSum = s;
      targets += 1;
    } else if (st === "not-applicable") {
      targets += 1;
      notApplicable += 1;
    } else {
      addMissing(rev, { kind: "record-item", name: itemField }, st === "not-stated" ? "not-stated" : "unknown", d);
    }
  }
  const missingList = [...missing.values()]
    .sort((a, b) => {
      // 並べる順序は日付の軸の値、次にIDの文字列（共通の型の11）。日付が分からないものは後ろ。
      const da = a.date ?? "￿";
      const db = b.date ?? "￿";
      if (da !== db) return compareStrings(da, db);
      if (a.entry.ref.id !== b.entry.ref.id) return compareStrings(a.entry.ref.id, b.entry.ref.id);
      return compareStrings(fieldKeyString(a.entry.field), fieldKeyString(b.entry.field));
    })
    .map((m) => m.entry);
  // 集計の状態（共通の型の11の表を上から順に）。
  let state: AggregateState;
  if (missingList.length > 0) state = "incomplete";
  else if (targets === 0) state = "no-records";
  else if (notApplicable === targets) state = "not-applicable";
  else state = "complete";
  return {
    ok: true,
    values: [{ measure: parsed.key, axis: parsed.axis, scope: parsed.scope, state, knownSum, missing: missingList, coverage: { state: "not-applicable" } }],
  };
}
