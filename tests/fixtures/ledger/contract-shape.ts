// 契約版1.0（docs/contracts/）の記録の型を、台帳のfixtureの検査に使う形で書き写したもの。
// 目的は、合成の入力が契約の保存の条件（項目の有無・許す状態・符号と範囲・IDの接頭辞・参照の粒度）を
// 満たすかを、実装（T06）と独立に確かめること（原因台帳のPR11-R108）。製品のコードではない。
// ほかの記録との関係で決まる条件（上限・重なり・正規のID等）は、ここでは確かめない。
// 書き写した表と契約が食い違えば契約を正とし、この表を直す。

export type FactState = "known" | "unknown" | "not-stated" | "not-applicable";
export const FACT_STATES: readonly FactState[] = ["known", "unknown", "not-stated", "not-applicable"];

// 計算結果の契約の1（RoundingStepのmethod、Targetのprocedure）と、制度のケース・制度の規則の制度の名前。
// 台帳の検査（ledger.test.ts）と制度の規則の検査（tests/rules/rules.test.ts）が同じ一覧を使う。
export const ROUNDING_METHODS: readonly string[] = ["floor", "ceil", "half-up", "half-down"];
export const PROCEDURES: readonly string[] = ["withholding", "year-end-adjustment", "tax-return", "levy", "premium", "recognition"];
export const REGIMES: readonly string[] = ["income-tax", "resident-tax", "furusato", "nhi", "employee-insurance", "dependents"];
// 制度のケースの雛形・未確認の値（docs/test-oracles/README.mdの「制度のケース」）。
export const REGIME_PLACEHOLDER = "未確認";

export type RecordType =
  | "employer"
  | "employment-term"
  | "account"
  | "issuer"
  | "payslip"
  | "bank-deposit"
  | "annual-document"
  | "forecast"
  | "official-notice"
  | "evidence-link"
  | "allocation"
  | "decision";

// 共通の型の2の接頭辞の表。
export const PREFIX: Readonly<Record<RecordType, string>> = {
  employer: "emp",
  "employment-term": "term",
  account: "acct",
  issuer: "iss",
  payslip: "pay",
  "bank-deposit": "dep",
  "annual-document": "ann",
  forecast: "fc",
  "official-notice": "ntc",
  "evidence-link": "evl",
  allocation: "alc",
  decision: "dcs",
};
export const RECORD_TYPES = Object.keys(PREFIX) as RecordType[];
export const EVIDENCE_FILE_PREFIX = "evf";
export const RUN_PREFIX = "run";
export const MASTER_TYPES: readonly RecordType[] = ["employer", "account", "issuer"];

export function recordTypeOfId(id: string): RecordType | undefined {
  const prefix = id.split("_")[0];
  return RECORD_TYPES.find((t) => PREFIX[t] === prefix);
}

// 静的に判定できる違反の分類。台帳の拒否の理由（reason）のうち、記録1件（と同じ記録の前の版）だけで決まるもの。
export type StaticCode =
  | "shape"
  | "fact-state-not-allowed"
  | "value-invalid"
  | "list-invalid"
  | "ref-granularity"
  | "ref-target-invalid"
  | "invalid-period"
  | "transition-not-allowed";

export interface Violation {
  code: StaticCode;
  path: string;
  message: string;
}

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const DEFAULT: readonly FactState[] = ["known", "unknown", "not-stated"];
const WITH_NA: readonly FactState[] = ["known", "unknown", "not-stated", "not-applicable"];
const KNOWN_UNKNOWN: readonly FactState[] = ["known", "unknown"];
const KNOWN_NA: readonly FactState[] = ["known", "not-applicable"];

export type Spec =
  | { t: "text" }
  | { t: "nonEmptyText" }
  | { t: "enum"; values: readonly string[] }
  | { t: "id"; prefix: string }
  | { t: "yen"; sign: "nonneg" | "pos" | "signed" }
  | { t: "localDate" }
  | { t: "yearMonth" }
  | { t: "calendarYear" }
  | { t: "subjectYear" }
  | { t: "period" }
  | { t: "minutes" }
  | { t: "boolean" }
  | { t: "positiveInt" }
  | { t: "lineId" }
  | { t: "ref"; to: readonly RecordType[]; line: "whole" | "any" }
  | { t: "object"; fields: Readonly<Record<string, Spec>> }
  | { t: "list"; of: Spec; key?: (element: Obj) => string | undefined; nonEmpty?: boolean }
  | { t: "fact"; of: Spec; states: readonly FactState[]; listFromSource?: boolean }
  | { t: "any" };

const text: Spec = { t: "text" };
const nonEmptyText: Spec = { t: "nonEmptyText" };
const localDate: Spec = { t: "localDate" };
const calendarYear: Spec = { t: "calendarYear" };
const lineId: Spec = { t: "lineId" };
const enm = (...values: string[]): Spec => ({ t: "enum", values });
const id = (prefix: string): Spec => ({ t: "id", prefix });
const yen = (sign: "nonneg" | "pos" | "signed"): Spec => ({ t: "yen", sign });
const fact = (of: Spec, states: readonly FactState[] = DEFAULT): Spec => ({ t: "fact", of, states });
const sourceList = (of: Spec, key: (e: Obj) => string | undefined): Spec => ({
  t: "fact",
  of: { t: "list", of, key },
  states: KNOWN_UNKNOWN,
  listFromSource: true,
});
const byLineId = (e: Obj): string | undefined => (typeof e["lineId"] === "string" ? e["lineId"] : undefined);
const REVISIONED: readonly RecordType[] = RECORD_TYPES;

// 記録の型の4の金額の項目名（AggregateKeyのpayslip-itemのitemと同じ列挙。共通の型の11）。
export const PAYSLIP_AMOUNT_ITEMS: readonly string[] = [
  "grossPay",
  "taxablePay",
  "nonTaxablePay",
  "commutingAllowance",
  "incomeTax",
  "residentTax",
  "healthInsurance",
  "nursingCareInsurance",
  "pensionInsurance",
  "employmentInsurance",
  "yearEndAdjustment",
  "totalDeductions",
  "netPay",
  "bankTransferAmount",
];
// 記録の型の6の金額の項目名（annual-valueのitem、比較のfield）。
export const ANNUAL_AMOUNT_ITEMS: readonly string[] = [
  "paymentAmount",
  "incomeAfterEmploymentDeduction",
  "totalIncomeDeductions",
  "withholdingTax",
  "socialInsurancePremiums",
];
export const NOTICE_TYPES: readonly string[] = [
  "resident-tax-determination",
  "nhi-premium-determination",
  "dependent-eligibility",
  "insurance-qualification",
  "other",
];
const ISSUER_KINDS = ["municipality", "tax-office", "health-insurer", "pension-office", "employer", "other"];

const EARNING_LINE: Spec = {
  t: "object",
  fields: {
    lineId,
    label: text,
    category: fact(enm("base", "overtime", "allowance", "bonus", "retroactive-adjustment", "other")),
    amount: fact(yen("signed")),
    taxTreatment: fact(enm("taxable", "non-taxable")),
    linePeriod: fact({ t: "period" }),
  },
};
const DEDUCTION_LINE: Spec = {
  t: "object",
  fields: { lineId, label: text, amount: fact(yen("nonneg")) },
};
const INCLUDED_PAYER: Spec = {
  t: "object",
  fields: {
    payerEmployerId: fact(id("emp")),
    payerLabel: fact(text),
    paymentAmount: fact(yen("nonneg")),
    withholdingTax: fact(yen("nonneg")),
    socialInsurancePremiums: fact(yen("nonneg")),
  },
};
const FORECAST_LINE: Spec = {
  t: "object",
  fields: {
    lineId,
    workPeriod: fact({ t: "period" }, WITH_NA),
    expectedMonth: { t: "yearMonth" },
    expectedDate: fact(localDate),
    // 範囲はmeasureで決まる（net-payだけ符号あり）。ここでは符号ありとして読み、型ごとの検査で狭める。
    amount: fact(yen("signed")),
    lineStatus: enm("open", "withdrawn"),
  },
};
const NOTICE_AMOUNT: Spec = {
  t: "object",
  fields: { lineId, label: text, category: fact(enm("annual-total", "other")), amount: fact(yen("nonneg")) },
};
const INSTALLMENT: Spec = {
  t: "object",
  fields: {
    lineId,
    label: text,
    dueDate: fact(localDate),
    amount: fact(yen("nonneg")),
    collectionMethod: fact(enm("special", "ordinary", "other")),
  },
};
const STATUS_DATE: Spec = {
  t: "object",
  fields: {
    lineId,
    label: text,
    kind: fact(enm("qualification-acquired", "qualification-lost", "eligibility-start", "eligibility-end", "other")),
    date: fact(localDate),
  },
};
const EXPLAINED_COMPARISON: Spec = {
  t: "object",
  fields: {
    field: enm(...ANNUAL_AMOUNT_ITEMS),
    annualValue: yen("signed"),
    payslipSum: yen("signed"),
    coveredPayslips: { t: "list", of: id("pay"), key: () => undefined },
  },
};

export interface RecordTypeSpec {
  body: Readonly<Record<string, Spec>>;
}

// 記録の型（records.md・reconciliation.md）のbodyの項目。条件で決まる状態は、許しうる状態の和集合を書き、
// checkTypeRulesで条件ごとに狭める。
export const BODY: Readonly<Record<RecordType, Readonly<Record<string, Spec>>>> = {
  employer: { displayName: text, legalName: fact(text), note: fact(text, WITH_NA) },
  "employment-term": {
    employerId: id("emp"),
    applicablePeriod: { t: "period" },
    withholdingColumn: fact(enm("kou", "otsu", "hei")),
    socialInsurance: fact(enm("enrolled", "not-enrolled")),
    employmentInsurance: fact(enm("enrolled", "not-enrolled")),
    scheduledWeeklyMinutes: fact({ t: "minutes" }, WITH_NA),
    payScheduleNote: fact(text, WITH_NA),
  },
  account: { displayName: text, institutionLabel: fact(text), note: fact(text, WITH_NA) },
  issuer: { displayName: text, issuerKind: enm(...ISSUER_KINDS), note: fact(text, WITH_NA) },
  payslip: {
    employerId: id("emp"),
    paymentKind: fact(enm("salary", "bonus", "other")),
    periodLabel: fact(text),
    workPeriod: fact({ t: "period" }, WITH_NA),
    scheduledPayDate: fact(localDate),
    grossPay: fact(yen("nonneg")),
    taxablePay: fact(yen("nonneg")),
    nonTaxablePay: fact(yen("nonneg")),
    commutingAllowance: fact(yen("nonneg"), WITH_NA),
    commutingAllowanceTaxTreatment: fact(enm("non-taxable", "taxable", "mixed"), WITH_NA),
    otherEarnings: sourceList(EARNING_LINE, byLineId),
    incomeTax: fact(yen("nonneg"), WITH_NA),
    residentTax: fact(yen("nonneg"), WITH_NA),
    healthInsurance: fact(yen("nonneg"), WITH_NA),
    nursingCareInsurance: fact(yen("nonneg"), WITH_NA),
    pensionInsurance: fact(yen("nonneg"), WITH_NA),
    employmentInsurance: fact(yen("nonneg"), WITH_NA),
    otherDeductions: sourceList(DEDUCTION_LINE, byLineId),
    yearEndAdjustment: fact(yen("signed"), WITH_NA),
    totalDeductions: fact(yen("nonneg")),
    netPay: fact(yen("signed")),
    bankTransferAmount: fact(yen("nonneg"), WITH_NA),
    supersedes: fact({ t: "ref", to: ["payslip"], line: "whole" }, KNOWN_NA),
  },
  "bank-deposit": {
    accountId: id("acct"),
    depositDate: fact(localDate),
    amount: fact(yen("pos")),
    descriptionText: fact(text),
    payerHint: fact(id("emp")),
    purpose: fact(enm("pay", "reimbursement", "other")),
  },
  "annual-document": {
    documentType: enm("withholding-slip", "other"),
    documentLabel: text,
    payerEmployerId: id("emp"),
    targetYear: calendarYear,
    paymentAmount: fact(yen("nonneg")),
    incomeAfterEmploymentDeduction: fact(yen("nonneg")),
    totalIncomeDeductions: fact(yen("nonneg")),
    withholdingTax: fact(yen("nonneg")),
    socialInsurancePremiums: fact(yen("nonneg")),
    yearEndAdjustmentStatus: fact(enm("adjusted", "not-adjusted")),
    includedOtherPayers: sourceList(INCLUDED_PAYER, () => undefined),
    employmentStartDate: fact(localDate),
    employmentEndDate: fact(localDate),
    issuedDate: fact(localDate),
    supersedes: fact({ t: "ref", to: ["annual-document"], line: "whole" }, KNOWN_NA),
  },
  forecast: {
    subject: enm("pay", "deposit"),
    employerId: fact(id("emp"), WITH_NA),
    accountId: fact(id("acct"), WITH_NA),
    measure: enm("gross-pay", "net-pay", "bank-transfer", "deposit-amount"),
    lines: { t: "list", of: FORECAST_LINE, key: byLineId, nonEmpty: true },
    basis: fact(enm("contract", "past-actuals", "user-estimate", "other")),
    basisNote: fact(text, WITH_NA),
  },
  "official-notice": {
    noticeType: enm(...NOTICE_TYPES),
    noticeLabel: text,
    issuerKind: enm(...ISSUER_KINDS),
    issuerLabel: fact(text),
    issuerId: fact(id("iss")),
    issuedDate: fact(localDate),
    subjectYear: fact({ t: "subjectYear" }, WITH_NA),
    incomeYear: fact(calendarYear, WITH_NA),
    applicablePeriod: fact({ t: "period" }, WITH_NA),
    amounts: sourceList(NOTICE_AMOUNT, byLineId),
    installments: sourceList(INSTALLMENT, byLineId),
    statusDates: sourceList(STATUS_DATE, byLineId),
    supersedes: fact({ t: "ref", to: ["official-notice"], line: "whole" }, KNOWN_NA),
  },
  "evidence-link": {
    evidenceFileId: id(EVIDENCE_FILE_PREFIX),
    target: { t: "ref", to: REVISIONED.filter((t) => t !== "evidence-link"), line: "whole" },
    locator: fact(text, WITH_NA),
    role: enm("source", "supporting"),
  },
  allocation: {
    kind: enm("transfer-to-deposit", "annual-coverage", "forecast-realization"),
    allocationStatus: enm("proposed", "confirmed", "rejected"),
    from: { t: "ref", to: ["payslip", "bank-deposit", "annual-document"], line: "any" },
    to: { t: "ref", to: ["bank-deposit", "payslip", "forecast"], line: "any" },
    amount: fact(yen("signed"), WITH_NA),
    settlesForecastLine: fact({ t: "boolean" }, WITH_NA),
    confirmedAgainst: fact({ t: "object", fields: { fromRevision: { t: "positiveInt" }, toRevision: { t: "positiveInt" } } }, WITH_NA),
    proposedBy: enm("user", "matcher"),
    note: fact(text, WITH_NA),
  },
  decision: {
    decisionType: enm("duplicate-review", "annual-adoption", "mismatch-explanation", "tax-year-assertion"),
    targets: { t: "list", of: { t: "ref", to: REVISIONED, line: "any" }, key: (e) => (typeof e["id"] === "string" ? e["id"] : undefined) },
    scope: fact(
      {
        t: "object",
        fields: {
          year: calendarYear,
          payers: { t: "list", of: id("emp"), nonEmpty: true, key: () => undefined },
        },
      },
      WITH_NA,
    ),
    explainedComparisons: fact(
      { t: "list", of: EXPLAINED_COMPARISON, nonEmpty: true, key: (e) => (typeof e["field"] === "string" ? e["field"] : undefined) },
      WITH_NA,
    ),
    value: { t: "any" },
    reasonNote: nonEmptyText,
  },
};

// 項目の省略の既定（docs/test-oracles/README.mdの「省略した項目の既定」。examples.mdの「読み方」の1〜7）で、
// 資料から写す並びのうち、既定を「確かめて行がない」（knownの空）にするもの。includedOtherPayersは既定unknown。
export const SOURCE_LISTS_DEFAULT_EMPTY: readonly string[] = [
  "otherEarnings",
  "otherDeductions",
  "amounts",
  "installments",
  "statusDates",
];

const ID_BODY = /^[0-9A-Za-z-]{1,40}$/;
const LINE_ID = /^[0-9A-Za-z]{1,40}$/;
const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MONTH = /^(\d{4})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isLocalDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = LOCAL_DATE.exec(v);
  if (!m) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export function isYearMonth(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = YEAR_MONTH.exec(v);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}
export function isInstant(v: unknown): v is string {
  if (typeof v !== "string" || !INSTANT.test(v)) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && d.toISOString() === v;
}
export function isCalendarYear(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1000 && v <= 9999;
}
export function isIdOf(v: unknown, prefix: string): v is string {
  if (typeof v !== "string") return false;
  const sep = v.indexOf("_");
  return sep > 0 && v.slice(0, sep) === prefix && ID_BODY.test(v.slice(sep + 1));
}
export function isAnyRecordId(v: unknown): v is string {
  return typeof v === "string" && RECORD_TYPES.some((t) => isIdOf(v, PREFIX[t]));
}

class Out {
  readonly list: Violation[] = [];
  add(code: StaticCode, path: string, message: string): void {
    this.list.push({ code, path, message });
  }
}

function checkValue(spec: Spec, v: unknown, path: string, out: Out): void {
  switch (spec.t) {
    case "any":
      return;
    case "text":
      if (typeof v !== "string") out.add("shape", path, "Textではない");
      return;
    case "nonEmptyText":
      if (typeof v !== "string") out.add("shape", path, "Textではない");
      else if (v.trim() === "") out.add("value-invalid", path, "空の文字列");
      return;
    case "enum":
      if (typeof v !== "string" || !spec.values.includes(v)) out.add("value-invalid", path, `列挙にない値: ${String(v)}`);
      return;
    case "id":
      if (!isIdOf(v, spec.prefix)) out.add("value-invalid", path, `接頭辞${spec.prefix}のIDではない: ${String(v)}`);
      return;
    case "yen":
      if (typeof v !== "number" || !Number.isSafeInteger(v)) {
        out.add("value-invalid", path, `安全な整数の円ではない: ${String(v)}`);
        return;
      }
      if (spec.sign === "nonneg" && v < 0) out.add("value-invalid", path, `0以上の項目に負の値: ${v}`);
      if (spec.sign === "pos" && v <= 0) out.add("value-invalid", path, `正の項目に0以下の値: ${v}`);
      return;
    case "localDate":
      if (!isLocalDate(v)) out.add("value-invalid", path, `LocalDateではない: ${String(v)}`);
      return;
    case "yearMonth":
      if (!isYearMonth(v)) out.add("value-invalid", path, `YearMonthではない: ${String(v)}`);
      return;
    case "calendarYear":
      if (!isCalendarYear(v)) out.add("value-invalid", path, `年ではない: ${String(v)}`);
      return;
    case "subjectYear":
      if (!isObj(v) || (v["kind"] !== "calendar" && v["kind"] !== "fiscal") || !isCalendarYear(v["year"]) || Object.keys(v).length !== 2) {
        out.add("value-invalid", path, "{ kind: calendar・fiscal, year }ではない");
      }
      return;
    case "minutes":
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) out.add("value-invalid", path, "0以上の整数ではない");
      return;
    case "positiveInt":
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) out.add("value-invalid", path, "1以上の整数ではない");
      return;
    case "boolean":
      if (typeof v !== "boolean") out.add("value-invalid", path, "真偽値ではない");
      return;
    case "lineId":
      if (typeof v !== "string" || !LINE_ID.test(v)) out.add("value-invalid", path, `LineIdではない: ${String(v)}`);
      return;
    case "period":
      checkPeriod(v, path, out);
      return;
    case "ref":
      checkRef(v, path, out, spec.to, spec.line, "current");
      return;
    case "object":
      checkObject(spec.fields, v, path, out);
      return;
    case "list": {
      if (!Array.isArray(v)) {
        out.add("shape", path, "並びではない");
        return;
      }
      if (spec.nonEmpty === true && v.length === 0) out.add("list-invalid", path, "空を許さない並びが空");
      const seen = new Set<string>();
      v.forEach((e, i) => {
        checkValue(spec.of, e, `${path}[${i}]`, out);
        if (spec.key && isObj(e)) {
          const k = spec.key(e);
          if (k !== undefined) {
            if (seen.has(k)) out.add("list-invalid", `${path}[${i}]`, `並びの一意のキーが重なる: ${k}`);
            seen.add(k);
          }
        }
      });
      if (spec.of.t === "id") {
        const ids = v.filter((e): e is string => typeof e === "string");
        if (new Set(ids).size !== ids.length) out.add("list-invalid", path, "同じIDを2回含む");
      }
      return;
    }
    case "fact":
      checkFact(spec, v, path, out);
      return;
  }
}

function checkFact(spec: Extract<Spec, { t: "fact" }>, v: unknown, path: string, out: Out): void {
  if (!isObj(v) || typeof v["state"] !== "string" || !(FACT_STATES as readonly string[]).includes(v["state"])) {
    out.add("shape", path, "Factの標準の表記ではない");
    return;
  }
  for (const k of Object.keys(v)) {
    if (k !== "state" && k !== "value" && k !== "note") out.add("shape", path, `Factに余分な項目: ${k}`);
  }
  if (v["note"] !== undefined && typeof v["note"] !== "string") out.add("shape", `${path}.note`, "noteがTextではない");
  const state = v["state"] as FactState;
  if (!spec.states.includes(state)) out.add("fact-state-not-allowed", path, `許さない状態: ${state}`);
  if (state === "known") {
    if (!("value" in v)) out.add("shape", path, "knownに値がない");
    else checkValue(spec.of, v["value"], `${path}.value`, out);
  } else if ("value" in v) {
    out.add("shape", path, `${state}に値がある`);
  }
}

export function checkPeriod(v: unknown, path: string, out: Out): void {
  if (!isObj(v)) {
    out.add("shape", path, "Periodではない");
    return;
  }
  checkObject({ start: fact(localDate), end: fact(localDate, WITH_NA) }, v, path, out);
  const s = v["start"];
  const e = v["end"];
  if (isObj(s) && isObj(e) && s["state"] === "known" && e["state"] === "known") {
    if (typeof s["value"] === "string" && typeof e["value"] === "string" && s["value"] > e["value"]) {
      out.add("invalid-period", path, `startがendより後: ${s["value"]} > ${e["value"]}`);
    }
  }
}

export function checkRef(
  v: unknown,
  path: string,
  out: Out,
  to: readonly RecordType[],
  line: "whole" | "any",
  revision: "current" | "integer",
): void {
  if (!isObj(v)) {
    out.add("shape", path, "Refではない");
    return;
  }
  for (const k of Object.keys(v)) {
    if (k !== "id" && k !== "revision" && k !== "line") out.add("shape", path, `Refに余分な項目: ${k}`);
  }
  const target = typeof v["id"] === "string" ? recordTypeOfId(v["id"]) : undefined;
  if (!isAnyRecordId(v["id"]) || target === undefined) {
    out.add("value-invalid", `${path}.id`, `記録のIDではない: ${String(v["id"])}`);
  } else if (!to.includes(target)) {
    out.add("ref-target-invalid", `${path}.id`, `指せない種類の記録: ${target}`);
  }
  if (revision === "current" && v["revision"] !== "current") out.add("value-invalid", `${path}.revision`, "記録どうしの関係はcurrentだけ");
  if (revision === "integer" && !(typeof v["revision"] === "number" && Number.isSafeInteger(v["revision"]) && v["revision"] >= 1)) {
    out.add("value-invalid", `${path}.revision`, "固定した写し・集計の結果は整数の版だけ");
  }
  const l = v["line"];
  if (l !== "whole" && (typeof l !== "string" || !LINE_ID.test(l))) out.add("value-invalid", `${path}.line`, "lineがwholeでもLineIdでもない");
  else if (line === "whole" && l !== "whole") out.add("ref-granularity", `${path}.line`, `記録全体の関係で行を指す: ${String(l)}`);
}

function checkObject(fields: Readonly<Record<string, Spec>>, v: unknown, path: string, out: Out): void {
  if (!isObj(v)) {
    out.add("shape", path, "objectではない");
    return;
  }
  for (const k of Object.keys(fields)) {
    if (!(k in v)) out.add("shape", `${path}.${k}`, "項目がない（表に書いた項目は省略しない）");
  }
  for (const k of Object.keys(v)) {
    const s = fields[k];
    if (s === undefined) out.add("shape", `${path}.${k}`, "表にない項目");
    else checkValue(s, v[k], `${path}.${k}`, out);
  }
}

function factState(v: unknown): FactState | undefined {
  return isObj(v) && typeof v["state"] === "string" ? (v["state"] as FactState) : undefined;
}
function factValue(v: unknown): unknown {
  return isObj(v) && v["state"] === "known" ? v["value"] : undefined;
}
function requireStates(v: unknown, allowed: readonly FactState[], path: string, out: Out, why: string): void {
  const s = factState(v);
  if (s !== undefined && !allowed.includes(s)) out.add("fact-state-not-allowed", path, `${why}（${s}）`);
}

// 共通の型の9の改訂の共通の形と、12の「knownが必要な項目」「not-applicableを許す項目」のうち、記録1件で決まる条件。
export function checkRecordStatic(record: unknown): Violation[] {
  const out = new Out();
  if (!isObj(record)) {
    out.add("shape", "$", "記録がobjectではない");
    return out.list;
  }
  const envFields = ["id", "recordType", "revision", "status", "reason", "knownOn", "changeNote", "duplicateOf", "entryChannel", "writeRequestId", "importKey", "body"];
  for (const k of envFields) if (!(k in record)) out.add("shape", `$.${k}`, "改訂の共通の形の項目がない");
  for (const k of Object.keys(record)) if (!envFields.includes(k)) out.add("shape", `$.${k}`, "改訂の共通の形にない項目");
  const recordType = record["recordType"];
  if (typeof recordType !== "string" || !(RECORD_TYPES as readonly string[]).includes(recordType)) {
    out.add("value-invalid", "$.recordType", `記録の種類ではない: ${String(recordType)}`);
    return out.list;
  }
  const type = recordType as RecordType;
  if (!isIdOf(record["id"], PREFIX[type])) out.add("value-invalid", "$.id", `${type}の接頭辞${PREFIX[type]}のIDではない: ${String(record["id"])}`);
  const revision = record["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) out.add("value-invalid", "$.revision", "版が1以上の整数ではない");
  const reason = record["reason"];
  const reasons = ["create", "correct-input-error", "new-information", "void", "unvoid"];
  if (typeof reason !== "string" || !reasons.includes(reason)) out.add("value-invalid", "$.reason", "改訂の理由ではない");
  const expectedStatus = reason === "void" ? "voided" : "active";
  if (record["status"] !== expectedStatus) out.add("transition-not-allowed", "$.status", `理由${String(reason)}の改訂後のstatusは${expectedStatus}`);
  if ((reason === "create") !== (revision === 1)) out.add("transition-not-allowed", "$.revision", "createは版1だけ、版1はcreateだけ");
  checkFact({ t: "fact", of: localDate, states: KNOWN_UNKNOWN }, record["knownOn"], "$.knownOn", out);
  checkFact({ t: "fact", of: text, states: WITH_NA }, record["changeNote"], "$.changeNote", out);
  checkFact({ t: "fact", of: { t: "ref", to: [type], line: "whole" }, states: KNOWN_NA }, record["duplicateOf"], "$.duplicateOf", out);
  if (reason !== "void") requireStates(record["duplicateOf"], ["not-applicable"], "$.duplicateOf", out, "voidでない改訂のduplicateOfはnot-applicable");
  const dup = factValue(record["duplicateOf"]);
  if (isObj(dup) && dup["id"] === record["id"]) out.add("ref-target-invalid", "$.duplicateOf", "自分自身を残す方にできない");
  const channel = record["entryChannel"];
  if (channel !== "manual" && channel !== "import") out.add("value-invalid", "$.entryChannel", "manual・importではない");
  checkFact(
    { t: "fact", of: { t: "object", fields: { source: nonEmptyText, key: nonEmptyText } }, states: KNOWN_NA },
    record["importKey"],
    "$.importKey",
    out,
  );
  requireStates(record["importKey"], channel === "import" ? ["known"] : ["not-applicable"], "$.importKey", out, "importKeyはimportだけknown");
  checkValue(nonEmptyText, record["writeRequestId"], "$.writeRequestId", out);
  const body = record["body"];
  checkObject(BODY[type], body, "$.body", out);
  if (isObj(body)) checkTypeRules(type, body, out);
  return out.list;
}

function refOf(v: unknown): Obj | undefined {
  return isObj(v) ? v : undefined;
}

function checkTypeRules(type: RecordType, body: Obj, out: Out): void {
  switch (type) {
    case "annual-document": {
      const list = factValue(body["includedOtherPayers"]);
      if (Array.isArray(list)) {
        const seen = new Set<string>();
        list.forEach((row, i) => {
          const payer = isObj(row) ? factValue(row["payerEmployerId"]) : undefined;
          if (typeof payer !== "string") return;
          if (payer === body["payerEmployerId"]) out.add("list-invalid", `$.body.includedOtherPayers[${i}]`, "発行した支払者と同じ支払者の行");
          if (seen.has(payer)) out.add("list-invalid", `$.body.includedOtherPayers[${i}]`, `同じ支払者の行が2件: ${payer}`);
          seen.add(payer);
        });
      }
      return;
    }
    case "forecast": {
      const subject = body["subject"];
      const measure = body["measure"];
      const ok = subject === "pay" ? ["gross-pay", "net-pay", "bank-transfer"].includes(String(measure)) : measure === "deposit-amount";
      if (!ok) out.add("value-invalid", "$.body.measure", `subject ${String(subject)}に合わないmeasure ${String(measure)}`);
      if (subject !== "deposit") requireStates(body["employerId"], DEFAULT, "$.body.employerId", out, "給与の予測のemployerIdにnot-applicableは使えない");
      if (subject === "deposit") requireStates(body["accountId"], DEFAULT, "$.body.accountId", out, "入金の予測のaccountId");
      else requireStates(body["accountId"], ["not-applicable"], "$.body.accountId", out, "accountIdは入金の予測の場合だけ");
      const lines = body["lines"];
      if (Array.isArray(lines)) {
        lines.forEach((line, i) => {
          if (!isObj(line)) return;
          const amount = factValue(line["amount"]);
          if (typeof amount === "number" && measure !== "net-pay" && amount < 0) {
            out.add("value-invalid", `$.body.lines[${i}].amount`, `${String(measure)}の見込みは0以上`);
          }
          const date = factValue(line["expectedDate"]);
          if (typeof date === "string" && typeof line["expectedMonth"] === "string" && !date.startsWith(`${line["expectedMonth"]}-`)) {
            out.add("value-invalid", `$.body.lines[${i}].expectedDate`, "予定日が予定月の日付でない");
          }
        });
      }
      return;
    }
    case "official-notice": {
      const amounts = factValue(body["amounts"]);
      let annualTotals = 0;
      let unknownCategory = false;
      if (Array.isArray(amounts)) {
        for (const line of amounts) {
          if (!isObj(line)) continue;
          if (factValue(line["category"]) === "annual-total") annualTotals += 1;
          if (factState(line["category"]) !== "known") unknownCategory = true;
        }
        if (annualTotals > 1) out.add("list-invalid", "$.body.amounts", "categoryがannual-totalの行が2行以上");
      }
      if (factState(body["subjectYear"]) === "not-applicable") {
        if (!Array.isArray(amounts) || annualTotals > 0 || unknownCategory) {
          out.add("fact-state-not-allowed", "$.body.subjectYear", "決定額の行がないと確かめた通知だけnot-applicable");
        }
      }
      return;
    }
    case "allocation": {
      const kind = body["kind"];
      const status = body["allocationStatus"];
      const from = refOf(body["from"]);
      const to = refOf(body["to"]);
      const fromType = typeof from?.["id"] === "string" ? recordTypeOfId(from["id"]) : undefined;
      const toType = typeof to?.["id"] === "string" ? recordTypeOfId(to["id"]) : undefined;
      const fromLine = from?.["line"];
      const toLine = to?.["line"];
      if (kind === "transfer-to-deposit") {
        if (fromType !== "payslip") out.add("ref-target-invalid", "$.body.from", "transfer-to-depositのfromは給与明細");
        if (toType !== "bank-deposit") out.add("ref-target-invalid", "$.body.to", "transfer-to-depositのtoは銀行入金");
        if (fromLine !== "whole") out.add("ref-granularity", "$.body.from.line", "記録全体だけ");
        if (toLine !== "whole") out.add("ref-granularity", "$.body.to.line", "記録全体だけ");
      } else if (kind === "annual-coverage") {
        if (fromType !== "annual-document") out.add("ref-target-invalid", "$.body.from", "annual-coverageのfromは年間資料");
        if (toType !== "payslip") out.add("ref-target-invalid", "$.body.to", "annual-coverageのtoは給与明細");
        if (fromLine !== "whole") out.add("ref-granularity", "$.body.from.line", "記録全体だけ");
        if (toLine !== "whole") out.add("ref-granularity", "$.body.to.line", "記録全体だけ");
      } else if (kind === "forecast-realization") {
        if (fromType !== "payslip" && fromType !== "bank-deposit") out.add("ref-target-invalid", "$.body.from", "実績化のfromは給与明細か銀行入金");
        if (fromType === "bank-deposit" && fromLine !== "whole") out.add("ref-granularity", "$.body.from.line", "銀行入金は記録全体だけ");
        if (toType !== "forecast") out.add("ref-target-invalid", "$.body.to", "実績化のtoは予測の行");
        if (toLine === "whole") out.add("ref-granularity", "$.body.to.line", "予測の行だけ（wholeは使わない）");
      }
      if (kind === "annual-coverage") requireStates(body["amount"], ["not-applicable"], "$.body.amount", out, "annual-coverageのamountはnot-applicable");
      else {
        requireStates(body["amount"], status === "confirmed" ? ["known"] : DEFAULT, "$.body.amount", out, "確定にはknownのamount");
        const amount = factValue(body["amount"]);
        if (typeof amount === "number") {
          if (amount === 0) out.add("value-invalid", "$.body.amount", "amountは0でない");
          if (kind === "transfer-to-deposit" && amount < 0) out.add("value-invalid", "$.body.amount", "transfer-to-depositのamountは正");
        }
      }
      if (kind === "forecast-realization") {
        requireStates(body["settlesForecastLine"], status === "confirmed" ? ["known"] : DEFAULT, "$.body.settlesForecastLine", out, "実績化の確定にはknown");
      } else {
        requireStates(body["settlesForecastLine"], ["not-applicable"], "$.body.settlesForecastLine", out, "実績化の場合だけ");
      }
      requireStates(body["confirmedAgainst"], status === "confirmed" ? ["known"] : ["not-applicable"], "$.body.confirmedAgainst", out, "confirmedの場合だけknown");
      return;
    }
    case "decision": {
      const t = body["decisionType"];
      const targets = Array.isArray(body["targets"]) ? body["targets"] : [];
      targets.forEach((ref, i) => {
        if (isObj(ref) && ref["line"] !== "whole") out.add("ref-granularity", `$.body.targets[${i}].line`, "判断の対象は記録全体だけ");
      });
      const types = targets.map((r) => (isObj(r) && typeof r["id"] === "string" ? recordTypeOfId(r["id"]) : undefined));
      const value = body["value"];
      const needScope = t === "annual-adoption" || t === "mismatch-explanation";
      requireStates(body["scope"], needScope ? ["known"] : ["not-applicable"], "$.body.scope", out, "annual-adoption・mismatch-explanationの場合だけknown");
      requireStates(body["explainedComparisons"], t === "mismatch-explanation" ? ["known"] : ["not-applicable"], "$.body.explainedComparisons", out, "mismatch-explanationの場合だけknown");
      if (t === "duplicate-review") {
        if (targets.length !== 2 || types[0] === undefined || types[0] !== types[1]) out.add("ref-target-invalid", "$.body.targets", "同じ種類の2件");
        const a = targets[0];
        const b = targets[1];
        if (isObj(a) && isObj(b) && a["id"] === b["id"]) out.add("ref-target-invalid", "$.body.targets", "異なる2件");
        if (value !== "distinct" && value !== "same") out.add("value-invalid", "$.body.value", "distinct・same");
      } else if (t === "annual-adoption") {
        if (value === "annual-document") {
          if (targets.length !== 1 || types[0] !== "annual-document") out.add("ref-target-invalid", "$.body.targets", "採用する年間資料1件");
        } else if (value === "entered-payslips") {
          if (targets.length !== 0) out.add("ref-target-invalid", "$.body.targets", "entered-payslipsのtargetsは空");
        } else out.add("value-invalid", "$.body.value", "annual-document・entered-payslips");
      } else if (t === "mismatch-explanation") {
        if (targets.length !== 1 || types[0] !== "annual-document") out.add("ref-target-invalid", "$.body.targets", "年間資料1件");
        if (value !== "explained") out.add("value-invalid", "$.body.value", "explained");
      } else if (t === "tax-year-assertion") {
        if (targets.length !== 1 || types[0] !== "payslip") out.add("ref-target-invalid", "$.body.targets", "給与明細1件");
        if (!isCalendarYear(value)) out.add("value-invalid", "$.body.value", "CalendarYear");
      }
      return;
    }
    default:
      return;
  }
}

// 記録が参照する記録・マスタ・証憑ファイルのID。契約の型の表（BODY）でIDかRefの項目だけをたどり、
// 摘要・表示名・メモ等の自由な文字列は、IDに似た値でも参照とみなさない（原因台帳のPR11-R107）。
export interface RecordReference {
  id: string;
  path: string;
}

function collectBySpec(spec: Spec, v: unknown, path: string, out: RecordReference[]): void {
  switch (spec.t) {
    case "id":
      if (typeof v === "string") out.push({ id: v, path });
      return;
    case "ref":
      if (isObj(v) && typeof v["id"] === "string") out.push({ id: v["id"], path: `${path}.id` });
      return;
    case "fact":
      if (isObj(v) && v["state"] === "known" && "value" in v) collectBySpec(spec.of, v["value"], `${path}.value`, out);
      return;
    case "list":
      if (Array.isArray(v)) v.forEach((e, i) => collectBySpec(spec.of, e, `${path}[${i}]`, out));
      return;
    case "object":
      if (isObj(v)) for (const [k, s] of Object.entries(spec.fields)) collectBySpec(s, v[k], `${path}.${k}`, out);
      return;
    default:
      return;
  }
}

export function recordReferences(record: unknown): RecordReference[] {
  const out: RecordReference[] = [];
  if (!isObj(record)) return out;
  const type = record["recordType"];
  if (typeof type !== "string" || !(RECORD_TYPES as readonly string[]).includes(type)) return out;
  const body = record["body"];
  if (isObj(body)) for (const [k, s] of Object.entries(BODY[type as RecordType])) collectBySpec(s, body[k], `$.body.${k}`, out);
  collectBySpec({ t: "fact", of: { t: "ref", to: RECORD_TYPES, line: "whole" }, states: FACT_STATES }, record["duplicateOf"], "$.duplicateOf", out);
  return out;
}

export function checkEvidenceFile(file: unknown): Violation[] {
  const out = new Out();
  checkObject(
    {
      id: id(EVIDENCE_FILE_PREFIX),
      sha256: text,
      byteSize: { t: "minutes" },
      mediaType: text,
      originalFileName: text,
      storageName: text,
      importedAt: text,
    },
    file,
    "$",
    out,
  );
  if (isObj(file)) {
    if (typeof file["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(file["sha256"])) out.add("value-invalid", "$.sha256", "64文字の小文字16進ではない");
    if (!isInstant(file["importedAt"])) out.add("value-invalid", "$.importedAt", "Instantではない");
  }
  return out.list;
}

// 期待値の中のFact（不足の行・残り等）の形を確かめる。
export function checkFactShape(v: unknown, of: Spec, path: string, states: readonly FactState[] = WITH_NA): Violation[] {
  const out = new Out();
  checkFact({ t: "fact", of, states }, v, path, out);
  return out.list;
}

export function checkSpec(spec: Spec, v: unknown, path: string): Violation[] {
  const out = new Out();
  checkValue(spec, v, path, out);
  return out.list;
}

export function checkRefShape(v: unknown, path: string, revision: "current" | "integer"): Violation[] {
  const out = new Out();
  checkRef(v, path, out, RECORD_TYPES, "any", revision);
  return out.list;
}

export const SPECS = { text, nonEmptyText, localDate, calendarYear, yen, id, fact, enm };
