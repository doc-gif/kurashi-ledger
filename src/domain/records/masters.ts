// マスタ（雇用先・口座・発行者）の正規のID（契約版1.0、common-types.mdの9の「マスタの取消と二重登録」）。
// マスタのIDは、二重登録の取消のduplicateOfをたどり、最初に着いた有効なマスタのIDに解決する。比べる・まとめるときは、
// すべて正規のIDで行い、記録のIdの値は書き換えない。

import { knownValue } from "./fact.ts";
import { isHistoryValid } from "./history.ts";
import { isMasterType, recordTypeOfId } from "./ids.ts";
import type { Ledger } from "./ledger.ts";
import { masterView, selectRevision, type ResolvedView } from "./views.ts";

// 正規のID。有効なマスタに解決できなければundefined（存在しない、見方にない、二重登録でない取消をされた、鎖が壊れている）。
// 解決できない参照は、その値をunknownとして扱う（共通の型の9の「保存の検査をすり抜けたデータ」）。
export function canonicalMasterId(ledger: Ledger, id: string, view: ResolvedView): string | undefined {
  const type = recordTypeOfId(id);
  if (type === undefined || !isMasterType(type)) return undefined;
  const v = masterView(view);
  const seen = new Set<string>();
  let cur = id;
  for (;;) {
    if (seen.has(cur)) return undefined;
    seen.add(cur);
    const rev = selectRevision(ledger, cur, v);
    if (rev === undefined || rev.recordType !== type) return undefined;
    // 鎖でたどる改訂は、どれもその改訂までの履歴が保存の検査を満たすときだけ根拠にする（共通の型の9。PR28-R001）。
    if (!isHistoryValid(ledger, rev)) return undefined;
    if (rev.status === "active") return cur;
    const next = knownValue(rev.duplicateOf);
    if (typeof next !== "object" || next === null) return undefined;
    const nextId = (next as { id?: unknown }).id;
    if (typeof nextId !== "string") return undefined;
    cur = nextId;
  }
}

// マスタのIdを持つ項目（共通の型の9の一覧）。knownの値だけを返す（Factでない項目はそのまま）。
export function masterRefsOf(recordType: string, body: Readonly<Record<string, unknown>>): { readonly path: string; readonly id: string }[] {
  const out: { path: string; id: string }[] = [];
  const direct = (path: string, v: unknown): void => {
    if (typeof v === "string") out.push({ path, id: v });
  };
  const viaFact = (path: string, v: unknown): void => {
    const x = knownValue(v);
    if (typeof x === "string") out.push({ path, id: x });
  };
  switch (recordType) {
    case "employment-term":
    case "payslip":
      direct("employerId", body["employerId"]);
      return out;
    case "annual-document": {
      direct("payerEmployerId", body["payerEmployerId"]);
      const rows = knownValue(body["includedOtherPayers"]);
      if (Array.isArray(rows)) {
        rows.forEach((row, i) => {
          if (typeof row === "object" && row !== null) viaFact(`includedOtherPayers[${i}].payerEmployerId`, (row as Record<string, unknown>)["payerEmployerId"]);
        });
      }
      return out;
    }
    case "bank-deposit":
      direct("accountId", body["accountId"]);
      viaFact("payerHint", body["payerHint"]);
      return out;
    case "forecast":
      viaFact("employerId", body["employerId"]);
      viaFact("accountId", body["accountId"]);
      return out;
    case "official-notice":
      viaFact("issuerId", body["issuerId"]);
      return out;
    case "decision": {
      const scope = knownValue(body["scope"]);
      const payers = typeof scope === "object" && scope !== null ? (scope as Record<string, unknown>)["payers"] : undefined;
      if (Array.isArray(payers)) payers.forEach((p, i) => direct(`scope.payers[${i}]`, p));
      return out;
    }
    default:
      return out;
  }
}
