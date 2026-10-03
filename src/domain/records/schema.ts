// 記録の種類ごとのbodyの項目（契約版1.0、docs/contracts/records.mdの1〜9、reconciliation.mdの3・4）と、
// 各Factの項目が許す状態（common-types.mdの12）。契約の表から書いたもので、T03の台帳の検査の表（contract-shape.ts）は
// 使わない（実装と台帳の検査が同じ誤りを共有しないため）。条件で決まる状態（「〜の場合だけ」等）は、許しうる状態の
// 和集合をここに書き、validate.tsの種類ごとの規則で条件ごとに狭める。

import type { Fact, FactState } from "./fact.ts";
import { EVIDENCE_FILE_PREFIX, RECORD_TYPES, type RecordType } from "./ids.ts";
import type { YenSign } from "./values.ts";

// 参照（共通の型の2）。記録どうしの関係のrevisionはcurrentだけ。
export interface Ref {
  readonly id: string;
  readonly revision: "current" | number;
  readonly line: string; // "whole"か行ID
}

export type Spec =
  | { readonly t: "text"; readonly nonEmpty?: true }
  | { readonly t: "enum"; readonly values: readonly string[] }
  | { readonly t: "id"; readonly prefix: string }
  | { readonly t: "yen"; readonly sign: YenSign }
  | { readonly t: "localDate" }
  | { readonly t: "yearMonth" }
  | { readonly t: "year" }
  | { readonly t: "subjectYear" }
  | { readonly t: "period" }
  | { readonly t: "minutes" }
  | { readonly t: "boolean" }
  | { readonly t: "positiveInt" }
  | { readonly t: "lineId" }
  | { readonly t: "ref"; readonly to: readonly RecordType[]; readonly line: "whole" | "any" }
  | { readonly t: "object"; readonly fields: Readonly<Record<string, Spec>> }
  | { readonly t: "list"; readonly of: Spec; readonly nonEmpty?: true; readonly uniqueKey?: (element: unknown) => string | undefined }
  | { readonly t: "fact"; readonly of: Spec; readonly states: readonly FactState[] }
  | { readonly t: "any" };

export interface Period {
  readonly start: Fact<string>;
  readonly end: Fact<string>;
}
export interface SubjectYear {
  readonly kind: "calendar" | "fiscal";
  readonly year: number;
}

// 仕様から値の型を導く（試験とほかのタスクが型として使うため。実行時の検査はvalidate.tsが同じ仕様で行う）。
export type Infer<S> = S extends { readonly t: "text" | "id" | "localDate" | "yearMonth" | "lineId" }
  ? string
  : S extends { readonly t: "enum"; readonly values: readonly (infer V)[] }
    ? V
    : S extends { readonly t: "yen" | "year" | "minutes" | "positiveInt" }
      ? number
      : S extends { readonly t: "boolean" }
        ? boolean
        : S extends { readonly t: "subjectYear" }
          ? SubjectYear
          : S extends { readonly t: "period" }
            ? Period
            : S extends { readonly t: "ref" }
              ? Ref
              : S extends { readonly t: "object"; readonly fields: infer F }
                ? { readonly [K in keyof F]: Infer<F[K]> }
                : S extends { readonly t: "list"; readonly of: infer O }
                  ? readonly Infer<O>[]
                  : S extends { readonly t: "fact"; readonly of: infer O }
                    ? Fact<Infer<O>>
                    : unknown;

const DEFAULT: readonly FactState[] = ["known", "unknown", "not-stated"];
const WITH_NA: readonly FactState[] = ["known", "unknown", "not-stated", "not-applicable"];
const KNOWN_UNKNOWN: readonly FactState[] = ["known", "unknown"];
const KNOWN_NA: readonly FactState[] = ["known", "not-applicable"];

const text = { t: "text" } as const;
const nonEmptyText = { t: "text", nonEmpty: true } as const;
const localDate = { t: "localDate" } as const;
const yearMonth = { t: "yearMonth" } as const;
const year = { t: "year" } as const;
const period = { t: "period" } as const;
const lineId = { t: "lineId" } as const;
function enm<const V extends readonly string[]>(...values: V): { readonly t: "enum"; readonly values: V } {
  return { t: "enum", values };
}
function id<const P extends string>(prefix: P): { readonly t: "id"; readonly prefix: P } {
  return { t: "id", prefix };
}
function yen<const S extends YenSign>(sign: S): { readonly t: "yen"; readonly sign: S } {
  return { t: "yen", sign };
}
function fact<const O extends Spec>(of: O, states: readonly FactState[] = DEFAULT): { readonly t: "fact"; readonly of: O; readonly states: readonly FactState[] } {
  return { t: "fact", of, states };
}
function obj<const F extends Readonly<Record<string, Spec>>>(fields: F): { readonly t: "object"; readonly fields: F } {
  return { t: "object", fields };
}
function list<const O extends Spec>(
  of: O,
  opts: { nonEmpty?: true; uniqueKey?: (element: unknown) => string | undefined } = {},
): { readonly t: "list"; readonly of: O; readonly nonEmpty?: true; readonly uniqueKey?: (element: unknown) => string | undefined } {
  return { t: "list", of, ...opts };
}
// 資料から写す並び（共通の型の12の「並びの空の意味」）。knownの空は「確かめて行がない」、unknownは「写していない」。
function sourceList<const O extends Spec>(of: O, uniqueKey: (element: unknown) => string | undefined) {
  return fact(list(of, { uniqueKey }), KNOWN_UNKNOWN);
}
function ref(to: readonly RecordType[], line: "whole" | "any"): { readonly t: "ref"; readonly to: readonly RecordType[]; readonly line: "whole" | "any" } {
  return { t: "ref", to, line };
}

function field(name: string): (element: unknown) => string | undefined {
  return (element) => {
    if (typeof element !== "object" || element === null) return undefined;
    const v = (element as Record<string, unknown>)[name];
    return typeof v === "string" ? v : undefined;
  };
}
// 並びの要素がIDの文字列そのもの（scope.payers、coveredPayslips）。
function self(element: unknown): string | undefined {
  return typeof element === "string" ? element : undefined;
}
// 年間資料の他の支払者の行の一意のキー: knownのpayerEmployerIdだけ（knownでない行は互いに区別できない）。
function knownPayer(element: unknown): string | undefined {
  if (typeof element !== "object" || element === null) return undefined;
  const f = (element as Record<string, unknown>)["payerEmployerId"];
  if (typeof f !== "object" || f === null) return undefined;
  const s = f as { state?: unknown; value?: unknown };
  return s.state === "known" && typeof s.value === "string" ? s.value : undefined;
}

// 改訂を持つ記録（証憑の紐付けの対象、判断の対象）。
const REVISIONED: readonly RecordType[] = RECORD_TYPES;

export const ISSUER_KINDS = ["municipality", "tax-office", "health-insurer", "pension-office", "employer", "other"] as const;
export const NOTICE_TYPES = [
  "resident-tax-determination",
  "nhi-premium-determination",
  "dependent-eligibility",
  "insurance-qualification",
  "other",
] as const;
// 給与明細の金額の項目名（AggregateKeyのpayslip-itemのitem。共通の型の11）。
export const PAYSLIP_AMOUNT_ITEMS = [
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
] as const;
export type PayslipAmountItem = (typeof PAYSLIP_AMOUNT_ITEMS)[number];
// 年間資料の金額の項目名（annual-valueのitem、比較のfield）。
export const ANNUAL_AMOUNT_ITEMS = [
  "paymentAmount",
  "incomeAfterEmploymentDeduction",
  "totalIncomeDeductions",
  "withholdingTax",
  "socialInsurancePremiums",
] as const;

const EARNING_LINE = obj({
  lineId,
  label: text,
  category: fact(enm("base", "overtime", "allowance", "bonus", "retroactive-adjustment", "other")),
  amount: fact(yen("signed")),
  taxTreatment: fact(enm("taxable", "non-taxable")),
  linePeriod: fact(period),
});
const DEDUCTION_LINE = obj({ lineId, label: text, amount: fact(yen("nonneg")) });
const INCLUDED_PAYER = obj({
  payerEmployerId: fact(id("emp")),
  payerLabel: fact(text),
  paymentAmount: fact(yen("nonneg")),
  withholdingTax: fact(yen("nonneg")),
  socialInsurancePremiums: fact(yen("nonneg")),
});
const FORECAST_LINE = obj({
  lineId,
  workPeriod: fact(period, WITH_NA),
  expectedMonth: yearMonth,
  expectedDate: fact(localDate),
  // 範囲はmeasureで決まる（net-payだけ符号あり、ほかは0以上）。ここでは符号ありとして読み、validate.tsで狭める。
  amount: fact(yen("signed")),
  lineStatus: enm("open", "withdrawn"),
});
const NOTICE_AMOUNT = obj({ lineId, label: text, category: fact(enm("annual-total", "other")), amount: fact(yen("nonneg")) });
const INSTALLMENT = obj({
  lineId,
  label: text,
  dueDate: fact(localDate),
  amount: fact(yen("nonneg")),
  collectionMethod: fact(enm("special", "ordinary", "other")),
});
const STATUS_DATE = obj({
  lineId,
  label: text,
  kind: fact(enm("qualification-acquired", "qualification-lost", "eligibility-start", "eligibility-end", "other")),
  date: fact(localDate),
});
const EXPLAINED_COMPARISON = obj({
  field: enm(...ANNUAL_AMOUNT_ITEMS),
  annualValue: yen("signed"),
  payslipSum: yen("signed"),
  coveredPayslips: list(id("pay"), { uniqueKey: self }),
});

export const BODY_SPECS = {
  employer: { displayName: text, legalName: fact(text), note: fact(text, WITH_NA) },
  "employment-term": {
    employerId: id("emp"),
    applicablePeriod: period,
    withholdingColumn: fact(enm("kou", "otsu", "hei")),
    socialInsurance: fact(enm("enrolled", "not-enrolled")),
    employmentInsurance: fact(enm("enrolled", "not-enrolled")),
    scheduledWeeklyMinutes: fact({ t: "minutes" } as const, WITH_NA),
    payScheduleNote: fact(text, WITH_NA),
  },
  account: { displayName: text, institutionLabel: fact(text), note: fact(text, WITH_NA) },
  issuer: { displayName: text, issuerKind: enm(...ISSUER_KINDS), note: fact(text, WITH_NA) },
  payslip: {
    employerId: id("emp"),
    paymentKind: fact(enm("salary", "bonus", "other")),
    periodLabel: fact(text),
    workPeriod: fact(period, WITH_NA),
    scheduledPayDate: fact(localDate),
    grossPay: fact(yen("nonneg")),
    taxablePay: fact(yen("nonneg")),
    nonTaxablePay: fact(yen("nonneg")),
    commutingAllowance: fact(yen("nonneg"), WITH_NA),
    commutingAllowanceTaxTreatment: fact(enm("non-taxable", "taxable", "mixed"), WITH_NA),
    otherEarnings: sourceList(EARNING_LINE, field("lineId")),
    incomeTax: fact(yen("nonneg"), WITH_NA),
    residentTax: fact(yen("nonneg"), WITH_NA),
    healthInsurance: fact(yen("nonneg"), WITH_NA),
    nursingCareInsurance: fact(yen("nonneg"), WITH_NA),
    pensionInsurance: fact(yen("nonneg"), WITH_NA),
    employmentInsurance: fact(yen("nonneg"), WITH_NA),
    otherDeductions: sourceList(DEDUCTION_LINE, field("lineId")),
    yearEndAdjustment: fact(yen("signed"), WITH_NA),
    totalDeductions: fact(yen("nonneg")),
    netPay: fact(yen("signed")),
    bankTransferAmount: fact(yen("nonneg"), WITH_NA),
    supersedes: fact(ref(["payslip"], "whole"), KNOWN_NA),
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
    targetYear: year,
    paymentAmount: fact(yen("nonneg")),
    incomeAfterEmploymentDeduction: fact(yen("nonneg")),
    totalIncomeDeductions: fact(yen("nonneg")),
    withholdingTax: fact(yen("nonneg")),
    socialInsurancePremiums: fact(yen("nonneg")),
    yearEndAdjustmentStatus: fact(enm("adjusted", "not-adjusted")),
    includedOtherPayers: sourceList(INCLUDED_PAYER, knownPayer),
    employmentStartDate: fact(localDate),
    employmentEndDate: fact(localDate),
    issuedDate: fact(localDate),
    supersedes: fact(ref(["annual-document"], "whole"), KNOWN_NA),
  },
  forecast: {
    subject: enm("pay", "deposit"),
    employerId: fact(id("emp"), WITH_NA),
    accountId: fact(id("acct"), WITH_NA),
    measure: enm("gross-pay", "net-pay", "bank-transfer", "deposit-amount"),
    lines: list(FORECAST_LINE, { nonEmpty: true, uniqueKey: field("lineId") }),
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
    subjectYear: fact({ t: "subjectYear" } as const, WITH_NA),
    incomeYear: fact(year, WITH_NA),
    applicablePeriod: fact(period, WITH_NA),
    amounts: sourceList(NOTICE_AMOUNT, field("lineId")),
    installments: sourceList(INSTALLMENT, field("lineId")),
    statusDates: sourceList(STATUS_DATE, field("lineId")),
    supersedes: fact(ref(["official-notice"], "whole"), KNOWN_NA),
  },
  "evidence-link": {
    evidenceFileId: id(EVIDENCE_FILE_PREFIX),
    target: ref(
      REVISIONED.filter((t) => t !== "evidence-link"),
      "whole",
    ),
    locator: fact(text, WITH_NA),
    role: enm("source", "supporting"),
  },
  allocation: {
    kind: enm("transfer-to-deposit", "annual-coverage", "forecast-realization"),
    allocationStatus: enm("proposed", "confirmed", "rejected"),
    from: ref(["payslip", "bank-deposit", "annual-document"], "any"),
    to: ref(["bank-deposit", "payslip", "forecast"], "any"),
    amount: fact(yen("signed"), WITH_NA),
    settlesForecastLine: fact({ t: "boolean" } as const, WITH_NA),
    confirmedAgainst: fact(obj({ fromRevision: { t: "positiveInt" } as const, toRevision: { t: "positiveInt" } as const }), WITH_NA),
    proposedBy: enm("user", "matcher"),
    note: fact(text, WITH_NA),
  },
  decision: {
    decisionType: enm("duplicate-review", "annual-adoption", "mismatch-explanation", "tax-year-assertion"),
    targets: list(ref(REVISIONED, "whole"), { uniqueKey: field("id") }),
    scope: fact(obj({ year, payers: list(id("emp"), { nonEmpty: true, uniqueKey: self }) }), WITH_NA),
    explainedComparisons: fact(list(EXPLAINED_COMPARISON, { nonEmpty: true, uniqueKey: field("field") }), WITH_NA),
    value: { t: "any" } as const,
    reasonNote: nonEmptyText,
  },
} as const satisfies Readonly<Record<RecordType, Readonly<Record<string, Spec>>>>;

export type BodySpecs = typeof BODY_SPECS;
export type BodyOf<T extends RecordType> = { readonly [K in keyof BodySpecs[T]]: Infer<BodySpecs[T][K]> };

// 行（LineId）を持つ並び。行IDの一意性と予約の範囲は、同じ親の記録の全改訂（共通の型の2の「LineId」）。
export const LINE_LISTS: Readonly<Partial<Record<RecordType, readonly string[]>>> = {
  payslip: ["otherEarnings", "otherDeductions"],
  forecast: ["lines"],
  "official-notice": ["amounts", "installments", "statusDates"],
};

// 改訂の共通の形のFactの項目の許す状態（共通の型の9・12）。条件はvalidate.tsで狭める。
export const ENVELOPE_STATES = {
  knownOn: KNOWN_UNKNOWN,
  changeNote: WITH_NA,
  duplicateOf: KNOWN_NA,
  importKey: KNOWN_NA,
} as const;
