// 制度の規則（T14）の検査。rules/manifest.json・制度データ（rules/<制度>/*.json）・制度のケース
// （tests/fixtures/ledger/regime/regime-cases.json）の形と、互いの整合を確かめる（docs/rules/README.md）。
// 確かめること: 一次資料の項目（更新日と取得日を分ける）、規則の適用の範囲（地域の符号・手続・基準の時点）と重なり、
// 制度データの値の原典の参照、表から写した行・資料の括弧書きと表の規則の一致、速算表の連続、年齢の範囲と生年月日の一致、
// 制度のケースの規則の版・原典・状態・丸めの記録（計算し直せること）。
// 確かめないこと: 規則と期待値が制度として正しいこと（一次資料との照合は別の担当のレビューで行う）。
// 実行: npm test（tests/**/*.test.ts。CIがmacOS・Windows・Linuxで実行する）。単独では node --test tests/rules/rules.test.ts。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ANNUAL_AMOUNT_ITEMS, isCalendarYear, isLocalDate, isObj, isYearMonth, PAYSLIP_AMOUNT_ITEMS, PROCEDURES, REGIME_PLACEHOLDER, REGIMES, ROUNDING_METHODS } from "../fixtures/ledger/contract-shape.ts";
import { REPO_ROOT, type Obj } from "../fixtures/ledger/load.ts";

const MANIFEST_PATH = "rules/manifest.json";
const REGIME_CASES_PATH = "tests/fixtures/ledger/regime/regime-cases.json";
const KINDS = ["calculation", "attribution", "comparison-mapping"];
const STATUSES = ["draft", "approved"];
const DATE_BASES = ["http-last-modified", "egov-revision-updated"];
const RUN_STATUSES = ["computed", "provisional", "incomplete", "unsupported"];

class Problems {
  readonly list: string[] = [];
  add(where: string, message: string): void {
    this.list.push(`${where}: ${message}`);
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});

// ---- 小数（丸めの計算し直しと速算表の連続の確かめに使う。誤差のない整数の計算）

interface Dec {
  n: bigint;
  s: number;
}

function parseDec(x: unknown): Dec | undefined {
  const t = typeof x === "number" && Number.isSafeInteger(x) ? String(x) : x;
  if (typeof t !== "string" || !/^-?[0-9]+(\.[0-9]+)?$/.test(t)) return undefined;
  const neg = t.startsWith("-");
  const [i = "", f = ""] = (neg ? t.slice(1) : t).split(".");
  return { n: BigInt(i + f) * (neg ? -1n : 1n), s: f.length };
}

function scaled(d: Dec, s: number): bigint {
  return d.n * 10n ** BigInt(s - d.s);
}

function formatDec(n: bigint, s: number): string {
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(s + 1, "0");
  const int = (s === 0 ? digits : digits.slice(0, digits.length - s)) || "0";
  const frac = s === 0 ? "" : digits.slice(digits.length - s).replace(/0+$/, "");
  const body = frac === "" ? int : `${int}.${frac}`;
  return neg && body !== "0" ? `-${body}` : body;
}

function decEquals(a: unknown, b: unknown): boolean {
  const x = parseDec(a);
  const y = parseDec(b);
  if (x === undefined || y === undefined) return false;
  const s = Math.max(x.s, y.s);
  return scaled(x, s) === scaled(y, s);
}

// 計算結果の契約の1の「丸めは計算し直せる形にする」の4つの丸め方。
export function roundTo(before: string, unit: string, method: string): string | undefined {
  const b = parseDec(before);
  const u = parseDec(unit);
  if (b === undefined || u === undefined || !ROUNDING_METHODS.includes(method)) return undefined;
  const s = Math.max(b.s, u.s);
  const bv = scaled(b, s);
  const uv = scaled(u, s);
  if (uv <= 0n) return undefined;
  let q = bv / uv;
  const r = bv % uv;
  if (r !== 0n) {
    const away = bv < 0n ? -1n : 1n;
    if (method === "floor" && bv < 0n) q -= 1n;
    if (method === "ceil" && bv > 0n) q += 1n;
    if (method === "half-up" || method === "half-down") {
      const twice = 2n * (r < 0n ? -r : r);
      if (twice > uv || (twice === uv && method === "half-up")) q += away;
    }
  }
  return formatDec(q * uv, s);
}

// ---- 地域の符号（docs/rules/README.mdの「地域の符号」）

export function localGovernmentCheckDigit(first5: string): number {
  const weights = [6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 5; i++) sum += Number(first5[i]) * (weights[i] ?? 0);
  return (11 - (sum % 11)) % 10;
}

function checkJurisdiction(j: unknown, where: string, problems: Problems): void {
  if (!isObj(j) || typeof j["code"] !== "string") {
    problems.add(where, "jurisdictionは{ kind, code }");
    return;
  }
  const kind = j["kind"];
  const code = j["code"];
  if (kind === "national") {
    if (code !== "JP") problems.add(where, "nationalのcodeはJP");
    return;
  }
  if (kind === "prefecture" || kind === "municipality") {
    if (!/^[0-9]{6}$/.test(code)) {
      problems.add(where, `${kind}のcodeは全国地方公共団体コードの6桁`);
      return;
    }
    const pref = Number(code.slice(0, 2));
    if (pref < 1 || pref > 47) problems.add(where, "第1・2桁は01〜47");
    if (kind === "prefecture" && code.slice(2, 5) !== "000") problems.add(where, "都道府県の第3〜5桁は000");
    if (kind === "municipality" && code.slice(2, 5) === "000") problems.add(where, "市区町村の第3〜5桁は000ではない");
    if (Number(code[5]) !== localGovernmentCheckDigit(code.slice(0, 5))) problems.add(where, "検査数字が合わない");
    return;
  }
  if (kind === "insurer") {
    problems.add(where, "保険者の符号の体系は未確認（T14のPR C・Dで決める）");
    return;
  }
  problems.add(where, "jurisdiction.kindはnational・prefecture・municipality・insurer");
}

// ---- 規則の適用の範囲

interface Applies {
  jurisdiction: string;
  year: string;
  procedure: string;
  from: string;
  to: string | undefined;
}

function checkApplies(rs: Obj, where: string, problems: Problems): Applies[] {
  const out: Applies[] = [];
  const list = rs["applies"];
  if (!Array.isArray(list) || list.length === 0) {
    problems.add(where, "appliesがない（適用の範囲は1件以上）");
    return out;
  }
  list.forEach((a, i) => {
    const w = `${where} applies[${i}]`;
    if (!isObj(a)) {
      problems.add(w, "objectではない");
      return;
    }
    checkJurisdiction(a["jurisdiction"], w, problems);
    const y = obj(a["year"]);
    if ((y["kind"] !== "calendar" && y["kind"] !== "fiscal") || !isCalendarYear(y["year"])) problems.add(w, "yearは{ kind: calendar・fiscal, year }");
    const j = obj(a["jurisdiction"]);
    const base = { jurisdiction: `${String(j["kind"])}:${String(j["code"])}`, year: `${String(y["kind"])}:${String(y["year"])}` };
    if (rs["kind"] !== "calculation") {
      if ("procedure" in a || "referencePoint" in a) problems.add(w, "計算の規則でなければ、手続と基準の時点を持たない");
      out.push({ ...base, procedure: "", from: "", to: undefined });
      return;
    }
    const procedure = a["procedure"];
    if (typeof procedure !== "string" || !PROCEDURES.includes(procedure)) {
      problems.add(w, "procedureが計算結果の契約の表にない");
      return;
    }
    const rp = a["referencePoint"];
    if (procedure === "levy") {
      if (rp !== "not-applicable") problems.add(w, "levyのreferencePointはnot-applicable");
      out.push({ ...base, procedure, from: "", to: undefined });
      return;
    }
    const isPoint = procedure === "premium" ? isYearMonth : isLocalDate;
    const kind = procedure === "premium" ? "month" : "date";
    if (!isObj(rp) || rp["kind"] !== kind || !isPoint(rp["from"]) || ("to" in rp && !isPoint(rp["to"]))) {
      problems.add(w, `${procedure}のreferencePointは{ kind: ${kind}, from, to? }`);
      return;
    }
    const to = typeof rp["to"] === "string" ? rp["to"] : undefined;
    if (to !== undefined && to <= String(rp["from"])) problems.add(w, "referencePointのtoはfromより後");
    out.push({ ...base, procedure, from: String(rp["from"]), to });
  });
  return out;
}

function overlaps(a: Applies, b: Applies): boolean {
  if (a.jurisdiction !== b.jurisdiction || a.year !== b.year || a.procedure !== b.procedure) return false;
  const aEnd = a.to ?? "￿";
  const bEnd = b.to ?? "￿";
  return a.from < bEnd && b.from < aEnd;
}

function targetCovered(target: Obj, applies: readonly Applies[]): boolean {
  const j = obj(target["jurisdiction"]);
  const y = obj(target["year"]);
  const rp = target["referencePoint"];
  const point = isObj(rp) ? String(rp["date"] ?? rp["month"] ?? "") : "";
  return applies.some(
    (a) =>
      a.jurisdiction === `${String(j["kind"])}:${String(j["code"])}` &&
      a.year === `${String(y["kind"])}:${String(y["year"])}` &&
      a.procedure === target["procedure"] &&
      (a.from === "" || (point >= a.from && (a.to === undefined || point < a.to))),
  );
}

// ---- 制度データの原典の参照

function collectSourceRefs(v: unknown, path: string, out: { ref: unknown; location: unknown; path: string }[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => collectSourceRefs(x, `${path}[${i}]`, out));
    return;
  }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (k === "source" || k === "crossCheckSource") {
      out.push({ ref: obj(x)["ref"], location: obj(x)["location"], path: `${path}.${k}` });
    } else if ((k === "sources" || k === "crossCheckSources") && Array.isArray(x)) {
      x.forEach((s, i) => out.push({ ref: obj(s)["ref"], location: obj(s)["location"], path: `${path}.sources[${i}]` }));
    } else collectSourceRefs(x, `${path}.${k}`, out);
  }
}

// ---- 所得税の制度データ（docs/rules/income-tax.md）

type EmploymentIncome = (x: number) => Dec | undefined;

function employmentIncomeOf(data: Obj, where: string, problems: Problems): EmploymentIncome | undefined {
  const ranges = arr(obj(data["employmentIncome"])["ranges"]);
  if (ranges.length === 0) {
    problems.add(where, "employmentIncome.rangesがない");
    return undefined;
  }
  let expectFrom = 0;
  ranges.forEach((r, i) => {
    const o = obj(r);
    const w = `${where} employmentIncome.ranges[${i}]`;
    if (o["from"] !== expectFrom) problems.add(w, `fromが前の範囲のto（${expectFrom}）と続かない`);
    const last = i === ranges.length - 1;
    if (last ? o["to"] !== null : !isInt(o["to"]) || Number(o["to"]) <= Number(o["from"])) problems.add(w, last ? "最後の範囲のtoはnull" : "toはfromより大きい整数");
    if (isInt(o["to"])) expectFrom = o["to"];
    const rule = o["rule"];
    if (rule === "rows-linear") {
      const width = o["rowWidth"];
      if (!isInt(width) || width <= 0 || Number(o["from"]) % width !== 0 || (isInt(o["to"]) && o["to"] % width !== 0)) problems.add(w, "rows-linearの範囲の端は行の幅の倍数");
    }
    if (!["fixed", "minus", "rows-linear", "linear"].includes(String(rule))) problems.add(w, "ruleはfixed・minus・rows-linear・linear");
    // 規則ごとの値の形（PR29-R012と同じ種類: 欠けた値で計算が素通り・例外にならないように）。
    const yen = (v: unknown): boolean => isInt(v) && v >= 0;
    if (rule === "fixed" ? !yen(o["value"]) : rule === "minus" ? !yen(o["constant"]) : rule === "rows-linear" || rule === "linear" ? !validRate(o["rate"]) || !yen(o["constant"]) : false) problems.add(w, "fixedはvalue、minusはconstant、rows-linear・linearはrate（小数）とconstant（0以上の整数）");
  });
  return (x: number): Dec | undefined => {
    const r = ranges.map(obj).find((o) => x >= Number(o["from"]) && (o["to"] === null || x < Number(o["to"])));
    if (r === undefined || (r["rule"] !== "fixed" && !isInt(r["constant"]))) return undefined;
    const rate = parseDec(r["rate"]);
    switch (r["rule"]) {
      case "fixed":
        return parseDec(r["value"]);
      case "minus":
        return { n: BigInt(x) - BigInt(Number(r["constant"])), s: 0 };
      case "rows-linear": {
        if (rate === undefined) return undefined;
        const width = Number(r["rowWidth"]);
        const rowStart = Number(r["from"]) + Math.floor((x - Number(r["from"])) / width) * width;
        return { n: BigInt(rowStart) * rate.n - BigInt(Number(r["constant"])) * 10n ** BigInt(rate.s), s: rate.s };
      }
      case "linear": {
        if (rate === undefined) return undefined;
        const raw = { n: BigInt(x) * rate.n - BigInt(Number(r["constant"])) * 10n ** BigInt(rate.s), s: rate.s };
        const rounded = roundTo(formatDec(raw.n, raw.s), "1", "floor");
        return rounded === undefined ? undefined : parseDec(rounded);
      }
      default:
        return undefined;
    }
  };
}

function decToNumber(d: Dec | undefined): number {
  return d === undefined ? Number.NaN : Number(formatDec(d.n, d.s));
}

// 年齢は誕生日の前日に1つ加わる（判定の日の翌日の時点の満年齢と同じ）。
export function ageOn(birth: string, ref: string): number {
  const [by, bm, bd] = birth.split("-").map(Number);
  const next = new Date(`${ref}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  let age = next.getUTCFullYear() - (by ?? 0);
  const m = next.getUTCMonth() + 1;
  const d = next.getUTCDate();
  if (m < (bm ?? 0) || (m === bm && d < (bd ?? 0))) age -= 1;
  return age;
}

function shiftDay(date: string, days: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

// 段階の表の形（PR29-R012）。1件以上のobjectの並びで、上限（capKey）は整数の昇順。最後の行の上限はnull（last: "null"）か整数（"int"）。
// 各行の額（ints）は0以上の整数、率（rates）は0より大きく1以下の小数、額の並び（intLists）は0以上の整数の並び（listLengthの長さ）。
// 形が正しいときだけ行を返す（中身の照合は形のあとに行う）。
function validRate(v: unknown): boolean {
  const d = parseDec(v);
  return typeof v === "string" && d !== undefined && d.n > 0n && d.n <= 10n ** BigInt(d.s);
}

function checkSteps(rows: unknown, capKey: string, opts: { last: "null" | "int"; ints?: string[]; rates?: string[]; intLists?: string[]; listLength?: number }, w: string, problems: Problems): Obj[] | undefined {
  if (!Array.isArray(rows) || rows.length === 0) {
    problems.add(w, "表がない（1件以上の行が要る）");
    return undefined;
  }
  let ok = true;
  let prev: number | undefined;
  rows.forEach((r, i) => {
    const rw = `${w}[${i}]`;
    if (!isObj(r)) {
      problems.add(rw, "行がobjectでない");
      ok = false;
      return;
    }
    const cap = r[capKey];
    const isLast = i === rows.length - 1;
    if (isLast && opts.last === "null" ? cap !== null : !isInt(cap) || (prev !== undefined && cap <= prev)) {
      problems.add(rw, `${capKey}は整数の昇順で、最後の行は${opts.last === "null" ? "null" : "整数"}`);
      ok = false;
    }
    if (isInt(cap)) prev = cap;
    const bad = (msg: string): void => {
      problems.add(rw, msg);
      ok = false;
    };
    for (const k of opts.ints ?? []) if (!isInt(r[k]) || r[k] < 0) bad(`${k}は0以上の整数`);
    for (const k of opts.rates ?? []) if (!validRate(r[k])) bad(`${k}は0より大きく1以下の小数の文字列`);
    for (const k of opts.intLists ?? []) {
      const l = r[k];
      if (!Array.isArray(l) || l.length !== opts.listLength || !l.every((x) => isInt(x) && x >= 0)) bad(`${k}は0以上の整数の並び（${String(opts.listLength)}件）`);
    }
  });
  return ok ? rows.map(obj) : undefined;
}

// 区分のつながり: 各区分の下限（overKey。この額を超える）は前の区分の上限で、最初は与えた額。
function checkChain(rows: Obj[] | undefined, overKey: string, capKey: string, first: unknown, w: string, problems: Problems): void {
  rows?.forEach((r, i) => {
    const expect = i === 0 ? first : rows[i - 1]?.[capKey];
    if (!isInt(r[overKey]) || r[overKey] !== expect) problems.add(`${w}[${i}]`, `${overKey}が前の区分の上限（最初は${String(first)}）と続かない`);
  });
}

// 所得税の計算runの結果の項目（docs/rules/income-tax.mdの「計算の順序」）。手続ごとに、どのケースもこの順にそろえる（unsupportedも値はunknownで持つ）。
const INCOME_TAX_RESULTS_COMMON = ["employment-income", "income-adjustment-deduction", "basic-deduction", "spouse-deduction", "spouse-special-deduction", "dependent-deduction", "specific-relative-deduction", "taxable-income", "computed-income-tax"];
const INCOME_TAX_RESULTS: Record<string, string[]> = {
  "year-end-adjustment": [...INCOME_TAX_RESULTS_COMMON, "annual-tax", "year-end-balance"],
  "tax-return": [...INCOME_TAX_RESULTS_COMMON, "reconstruction-tax", "income-tax-total", "filing-tax-balance"],
};

const INCOME_TAX_ROUNDING = ["employment-income|floor|1", "income-adjustment-deduction|ceil|1", "taxable-income|floor|1000", "annual-tax|floor|100", "reconstruction-tax|floor|1", "filing-tax-balance|floor|100"];

function checkIncomeTaxData(data: Obj, where: string, problems: Problems): void {
  const ei = employmentIncomeOf(data, where, problems);
  const emp = obj(data["employmentIncome"]);
  if (arr(emp["rowsTranscribed"]).length === 0) problems.add(`${where} employmentIncome`, "表から写した行（rowsTranscribed）がない");
  if (arr(obj(emp["salaryOnlyThresholdsCrossCheck"])["rows"]).length === 0) problems.add(`${where} employmentIncome`, "資料の括弧書きの収入金額（salaryOnlyThresholdsCrossCheck.rows）がない");
  if (ei !== undefined) {
    arr(emp["rowsTranscribed"]).forEach((row, i) => {
      const o = obj(row);
      const w = `${where} employmentIncome.rowsTranscribed[${i}]`;
      const from = Number(o["from"]);
      const to = Number(o["to"]);
      if (!isInt(o["from"]) || !isInt(o["to"]) || !isInt(o["value"]) || !nonEmpty(o["location"])) {
        problems.add(w, "{ from, to, value, location }");
        return;
      }
      if (decToNumber(ei(from)) !== o["value"] || decToNumber(ei(to - 1)) !== o["value"]) problems.add(w, "表から写した行と、rangesの規則の値が違う");
    });
    const cross = obj(emp["salaryOnlyThresholdsCrossCheck"]);
    const rows = [...arr(cross["rows"]), ...arr(obj(cross["spouseRows"])["rows"])];
    rows.forEach((row, i) => {
      const o = obj(row);
      const w = `${where} salaryOnlyThresholdsCrossCheck[${i}]`;
      const max = Number(o["salaryRevenueMax"]);
      const total = Number(o["totalIncomeMax"]);
      if (!(decToNumber(ei(max)) <= total) || !(decToNumber(ei(max + 1)) > total)) problems.add(w, "資料の括弧書きの収入金額の上限と、給与所得控除後の金額の規則が合わない");
    });
  }
  // 段階の表（PR29-R012、Copilot 4173206277）: 形（1件以上・全行・昇順の上限・最後の行）を先に確かめ、そのあとで中身を照合する。
  const basic = obj(data["basicDeduction"]);
  const base = basic["statutoryBase"];
  if (!isInt(base) || base <= 0) problems.add(`${where} basicDeduction`, "statutoryBase（所得税法の額）は正の整数");
  const basicRows = checkSteps(basic["brackets"], "totalIncomeMax", { last: "null", ints: ["amount"] }, `${where} basicDeduction.brackets`, problems);
  basicRows?.forEach((o, i) => {
    const w = `${where} basicDeduction.brackets[${i}]`;
    if (o["addition"] !== null && !isInt(o["addition"])) problems.add(w, "additionは整数かnull");
    if (isInt(o["addition"]) && (!isInt(base) || base + o["addition"] !== o["amount"])) problems.add(w, "所得税法の額と加算額の合計が控除額と違う");
  });
  const rateRows = checkSteps(obj(data["taxRates"])["brackets"], "taxableIncomeMax", { last: "null", ints: ["quickDeduction"], rates: ["rate"] }, `${where} taxRates.brackets`, problems);
  if (rateRows !== undefined) {
    // 課税所得0で税額0（最初の段階の控除額は0）。率は段階ごとに上がる。
    if (rateRows[0]?.["quickDeduction"] !== 0) problems.add(`${where} taxRates.brackets[0]`, "最初の段階の控除額は0");
    rateRows.forEach((b, i) => {
      const next = rateRows[i + 1];
      if (next === undefined) return;
      const w = `${where} taxRates.brackets[${i}]`;
      const r1 = parseDec(b["rate"]) as Dec;
      const r2 = parseDec(next["rate"]) as Dec;
      const sc = Math.max(r1.s, r2.s);
      if (scaled(r2, sc) <= scaled(r1, sc)) problems.add(w, "税率は段階ごとに上がる");
      // 速算表の連続: 次の段階の最初の課税所得（上限＋1,000円）で、2つの段階の式が同じ税額になる。
      const at = BigInt(Number(b["taxableIncomeMax"]) + 1000);
      const t1 = at * scaled(r1, sc) - BigInt(Number(b["quickDeduction"])) * 10n ** BigInt(sc);
      const t2 = at * scaled(r2, sc) - BigInt(Number(next["quickDeduction"])) * 10n ** BigInt(sc);
      if (t1 !== t2) problems.add(w, "速算表の控除額が段階の境で連続しない（写し誤り）");
    });
  }
  // 配偶者控除（本人の合計所得金額の列）と配偶者特別控除。列の上限は同じ並び。区分は前の区分の上限から続き、最初は配偶者控除の配偶者の上限から。
  const sp = obj(data["spouseDeduction"]);
  const sps = obj(data["spouseSpecialDeduction"]);
  const cols = checkSteps(sp["byTaxpayerTotalIncome"], "taxpayerTotalIncomeMax", { last: "int", ints: ["general", "elderly"] }, `${where} spouseDeduction.byTaxpayerTotalIncome`, problems);
  if (!isInt(sp["spouseTotalIncomeMax"]) || !isInt(sp["elderlyAgeMin"]) || !isLocalDate(sp["elderlyBornOnOrBefore"])) problems.add(`${where} spouseDeduction`, "spouseTotalIncomeMax・elderlyAgeMin（整数）とelderlyBornOnOrBefore（日付）");
  const spCols = arr(sps["taxpayerTotalIncomeMax"]);
  if (cols !== undefined && JSON.stringify(spCols) !== JSON.stringify(cols.map((c) => c["taxpayerTotalIncomeMax"]))) problems.add(`${where} spouseSpecialDeduction.taxpayerTotalIncomeMax`, "配偶者控除の本人の合計所得金額の列の上限と同じ並び");
  const spsRows = checkSteps(sps["brackets"], "spouseTotalIncomeMax", { last: "int", intLists: ["amounts"], listLength: spCols.length }, `${where} spouseSpecialDeduction.brackets`, problems);
  checkChain(spsRows, "spouseTotalIncomeOver", "spouseTotalIncomeMax", sp["spouseTotalIncomeMax"], `${where} spouseSpecialDeduction.brackets`, problems);
  const srd = obj(data["specificRelativeDeduction"]);
  const srRows = checkSteps(srd["brackets"], "totalIncomeMax", { last: "int", ints: ["amount"] }, `${where} specificRelativeDeduction.brackets`, problems);
  checkChain(srRows, "totalIncomeOver", "totalIncomeMax", obj(data["dependentDeduction"])["dependentTotalIncomeMax"], `${where} specificRelativeDeduction.brackets`, problems);
  // 所得金額調整控除・復興特別所得税・ほかの控除の額の形。
  const ia = obj(data["incomeAdjustmentDeduction"]);
  if (!isInt(ia["revenueOver"]) || !isInt(ia["revenueCap"]) || ia["revenueCap"] <= ia["revenueOver"] || !validRate(ia["rate"])) problems.add(`${where} incomeAdjustmentDeduction`, "revenueOver < revenueCap（整数）とrate（0より大きく1以下の小数）");
  const rst = obj(data["reconstructionSpecialIncomeTax"]);
  if (!validRate(rst["rate"]) || parseDec(rst["yearEndAdjustmentMultiplier"]) === undefined || Number(rst["yearEndAdjustmentMultiplier"]) !== 1 + Number(rst["rate"])) problems.add(`${where} reconstructionSpecialIncomeTax`, "rateと、yearEndAdjustmentMultiplier（1＋rate）");
  const pda = obj(data["personalDeductionAmounts"]);
  for (const k of ["disabled", "speciallyDisabled", "cohabitingSpeciallyDisabled", "widow", "singleParent", "workingStudent"]) if (!isInt(pda[k]) || pda[k] <= 0) problems.add(`${where} personalDeductionAmounts.${k}`, "正の整数");
  if (!isInt(obj(data["dependentDeduction"])["dependentTotalIncomeMax"])) problems.add(`${where} dependentDeduction`, "dependentTotalIncomeMaxは整数");
  // 丸め: 計算の順序の各段階の丸めがそろっている（制度データのroundingが空・欠落でも通らない）。
  const roundingKeys = checkDataRounding(data, where, new Problems());
  for (const k of INCOME_TAX_ROUNDING) if (!roundingKeys.has(k)) problems.add(`${where} rounding`, `丸めがない: ${k}`);
  if (!arr(data["rounding"]).some((r) => obj(r)["item"] === ia["roundingItem"])) problems.add(`${where} incomeAdjustmentDeduction`, "roundingItemの丸めがroundingにない");
  const dep = obj(data["dependentDeduction"]);
  const ref = dep["ageDeterminationDate"];
  if (isLocalDate(ref)) {
    const cats = arr(dep["categories"]).map(obj);
    if (cats.length === 0) problems.add(`${where} dependentDeduction`, "扶養親族の区分（categories）がない");
    // 老人控除対象配偶者の年齢（70歳以上）と生年月日の境界（配偶者控除の表の列を選ぶ）。
    if (isInt(sp["elderlyAgeMin"]) && isLocalDate(sp["elderlyBornOnOrBefore"])) checkAgeRange({ ageMin: sp["elderlyAgeMin"], bornOnOrBefore: sp["elderlyBornOnOrBefore"] }, ref, `${where} spouseDeduction`, problems);
    cats.forEach((c, i) => {
      const w = `${where} dependentDeduction.categories[${i}]`;
      if (checkAgeShape(c, w, problems)) checkAgeRange(c, ref, w, problems);
      if (!isInt(c["precedence"])) problems.add(w, "precedence（区分を選ぶ順）は整数");
      if (!isInt(c["amount"]) || c["amount"] <= 0) problems.add(w, "amount（控除額）は正の整数");
      for (const r of arr(c["requires"])) if (!nonEmpty(obj(r)["input"]) || arr(obj(r)["allowed"]).length === 0) problems.add(w, "requiresは{ input, allowed }の並び");
    });
    // 同じ年齢の範囲の区分（老人扶養親族の2つ）は、requiresの入力で排他に決まる（Copilot 4172926869）。
    cats.forEach((a, i) =>
      cats.slice(i + 1).forEach((b, j) => {
        const sameRange = ["ageMin", "ageBelow", "bornOnOrBefore", "bornFrom", "bornTo"].every((k) => a[k] === b[k]);
        if (!sameRange) return;
        const exclusive = arr(a["requires"]).some((ra) => arr(b["requires"]).some((rb) => obj(ra)["input"] === obj(rb)["input"] && arr(obj(ra)["allowed"]).every((v) => !arr(obj(rb)["allowed"]).includes(v))));
        if (!exclusive) problems.add(`${where} dependentDeduction.categories[${i}]・[${i + j + 1}]`, "同じ年齢の範囲の区分が、requiresの入力で排他に決まらない");
      }),
    );
  } else problems.add(where, "dependentDeduction.ageDeterminationDateがない");
  // 特定親族特別控除の年齢（19歳以上23歳未満）と判定日を制度データから読めること（PR29-R004）。
  const sr = obj(data["specificRelativeDeduction"]);
  if (!isLocalDate(sr["ageDeterminationDate"]) || sr["ageDeterminationDate"] !== ref || !checkAgeShape(sr, `${where} specificRelativeDeduction`, problems) || !isLocalDate(sr["bornFrom"]) || sr["excludedIfDependent"] !== true) {
    problems.add(`${where} specificRelativeDeduction`, "年齢の範囲（ageDeterminationDate・ageMin・ageBelow・bornFrom・bornTo）と、扶養控除と重ねないこと（excludedIfDependent）がない");
  } else checkAgeRange(sr, sr["ageDeterminationDate"], `${where} specificRelativeDeduction`, problems);
  for (const k of ["spouseDeduction", "spouseSpecialDeduction", "dependentDeduction", "specificRelativeDeduction"]) {
    const el = obj(data[k])["eligibility"];
    if (!Array.isArray(el) || el.length === 0) problems.add(`${where} ${k}`, "適用要件（eligibility）がない（所得・年齢だけで控除しない。PR29-R006）");
    arr(el).forEach((e, i) => {
      const o = obj(e);
      // 1つの条件は1つの入力（input・allowed）か、原典の例外を含むanyOf（どれかを満たせばよい）。主語（subject）を必須にし、1つの真偽値で複数の条件を代えない（PR29-R006）。
      const alts = Array.isArray(o["anyOf"]) ? o["anyOf"].map(obj) : [o];
      const shapeOk = alts.length > 0 && alts.every((a) => nonEmpty(a["input"]) && Array.isArray(a["allowed"]) && a["allowed"].length > 0);
      if (!shapeOk || !isObj(o["source"]) || !nonEmpty(o["subject"])) problems.add(`${where} ${k}.eligibility[${i}]`, "{ input, allowed（1件以上）, subject, source }か{ anyOf: [{ input, allowed }], subject, source }");
      if (o["scope"] === "taxpayer" && !String(o["input"]).startsWith("taxpayer.")) problems.add(`${where} ${k}.eligibility[${i}]`, "納税者の入力（scope taxpayer）はtaxpayer.で始める");
    });
  }
}

// 年齢の範囲の形（PR29-R004）: ageMinは整数。生年月日の境界は「bornOnOrBefore」（上限なし）か「bornFrom・bornTo・ageBelow（整数）」の
// どちらか一方。欠けた・整数でない値は、範囲の照合（checkAgeRange）より先に拒否する（Number(undefined)のNaNで比較が素通りしないように）。
function checkAgeShape(o: Obj, w: string, problems: Problems): boolean {
  const open = isLocalDate(o["bornOnOrBefore"]) && !("bornFrom" in o) && !("bornTo" in o) && !("ageBelow" in o);
  const closed = isLocalDate(o["bornFrom"]) && isLocalDate(o["bornTo"]) && isInt(o["ageBelow"]) && !("bornOnOrBefore" in o);
  if (!isInt(o["ageMin"]) || (!open && !closed)) {
    problems.add(w, "年齢の範囲の形: ageMin（整数）と、bornOnOrBeforeか、bornFrom・bornTo・ageBelow（整数）のどちらか一方が要る");
    return false;
  }
  if (closed && Number(o["ageBelow"]) <= Number(o["ageMin"])) {
    problems.add(w, "ageBelowはageMinより大きい整数");
    return false;
  }
  return true;
}

function checkAgeRange(o: Obj, ref: string, w: string, problems: Problems): void {
  const min = Number(o["ageMin"]);
  if (isLocalDate(o["bornOnOrBefore"])) {
    if (ageOn(o["bornOnOrBefore"], ref) < min || ageOn(shiftDay(o["bornOnOrBefore"], 1), ref) >= min) problems.add(w, "生年月日の範囲と年齢の下限が合わない");
  }
  if (isLocalDate(o["bornFrom"]) && isLocalDate(o["bornTo"])) {
    const below = Number(o["ageBelow"]);
    if (ageOn(o["bornTo"], ref) < min || ageOn(shiftDay(o["bornTo"], 1), ref) >= min) problems.add(w, "生年月日の範囲の終わりと年齢の下限が合わない");
    if (ageOn(o["bornFrom"], ref) >= below || ageOn(shiftDay(o["bornFrom"], -1), ref) < below) problems.add(w, "生年月日の範囲の始まりと年齢の上限が合わない");
  }
}

// 家族の入力（PR29-R006）。人ごとの基本の項目（生年月日・合計所得金額・12月31日に生存しているか・居住者か）は必ず持つ。
// 適用要件の入力は、欠けていればunknownと同じに扱い、必要なときだけ不足に数える（下の手順）。
// 型の検査（R010）は、この手順と別に、値があれば常に行う。不正な値は既知の入力として扱わない。
interface FamilyCheck {
  missingKeys: string[];
  invalid: string[];
  unknown: string[];
  // 控除ごと・人ごとの判定（粗探しF4）: applies（当たる）・none（当たらないと分かる。0のknown）・undecided（決まらない）。
  verdicts: Map<string, ("applies" | "none" | "undecided")[]>;
}

// 入力の値の型と許す値（Copilot 4172986641）。「unknown」はどの入力にも許し、分からない入力として数える。
// 不正な値（日付でない生年月日、整数でない所得、真偽値でない要件等）は、既知の入力として扱わず、問題にする。
function validValue(v: unknown, domain: readonly unknown[] | "date" | "income" | "boolean"): boolean {
  if (v === "unknown") return true;
  if (domain === "date") return isLocalDate(v);
  if (domain === "income") return isInt(v) && v >= 0;
  if (domain === "boolean") return typeof v === "boolean";
  return domain.includes(v);
}

function domainOf(alt: Obj): readonly unknown[] | "boolean" | undefined {
  const allowed = arr(alt["allowed"]);
  if (Array.isArray(alt["domain"])) return alt["domain"];
  return allowed.length > 0 && allowed.every((x) => typeof x === "boolean") ? "boolean" : undefined;
}

// 判定の結果。met（当たる）・unmet（当たらないと分かる）・unknown（決まらない。決まらない入力の名前を持つ）。
interface Judged {
  state: "met" | "unmet" | "unknown";
  unknown: string[];
}
const MET: Judged = { state: "met", unknown: [] };
const UNMET: Judged = { state: "unmet", unknown: [] };

// AND: 1つでもunmetならunmet（ほかの未知の入力は数えない）。unmetがなく、unknownがあればunknown。
function all(parts: readonly Judged[]): Judged {
  if (parts.some((p) => p.state === "unmet")) return UNMET;
  const unknown = parts.flatMap((p) => p.unknown);
  return unknown.length > 0 ? { state: "unknown", unknown } : MET;
}

// 条件群（anyOfはOR）: 既知の代替で満たせばmet（ほかの代替のunknownを数えない）。どの代替でも決まらなければunknown。
function evalGroup(e: Obj, person: Obj, ci: Obj): Judged {
  const alts = Array.isArray(e["anyOf"]) ? e["anyOf"].map(obj) : [e];
  const unknown: string[] = [];
  for (const a of alts) {
    const path = String(a["input"]);
    const v = path.startsWith("taxpayer.") ? obj(ci["taxpayer"])[path.slice("taxpayer.".length)] : person[path];
    const dom = domainOf(a);
    if (v === undefined || v === "unknown" || (dom !== undefined && !validValue(v, dom))) unknown.push(path);
    else if (arr(a["allowed"]).includes(v)) return MET;
  }
  return unknown.length > 0 ? { state: "unknown", unknown } : UNMET;
}

// 値の範囲の判定。値が分からない・不正なら、その入力の名前でunknown。
function range(v: unknown, name: string, ok: (n: number) => boolean): Judged {
  if (!isInt(v) || v < 0) return { state: "unknown", unknown: [name] };
  return ok(v) ? MET : UNMET;
}

// 本人の合計所得金額の範囲（検証の責務(c)）。給与等の収入金額が分からなければundefined。所得金額調整控除は、収入金額がrevenueOver以下なら0、
// 対象かがtrueなら実際の額（1円未満切上げ。整数で計算）、falseなら0。分からないときだけ、0と実際の額の両方を範囲の端にする。
function taxpayerTotalRange(data: Obj, ci: Obj): { lo: number; hi: number } | undefined {
  const salary = ci["salaryRevenue"];
  if (!isInt(salary) || salary < 0) return undefined;
  const adj = obj(data["incomeAdjustmentDeduction"]);
  const e = decToNumber(employmentIncomeOf(data, "", new Problems())?.(salary));
  const rate = parseDec(adj["rate"]);
  const over = Number(adj["revenueOver"]);
  const cap = Number(adj["revenueCap"]);
  if (!Number.isFinite(e) || rate === undefined) return undefined;
  const unit = 10n ** BigInt(rate.s);
  const raw = BigInt(Math.max(0, Math.min(salary, cap) - over)) * rate.n;
  const amount = salary > over ? Number((raw + unit - 1n) / unit) : 0;
  const eligible = ci["incomeAdjustmentEligible"];
  const lo = amount === 0 || eligible === false ? e : e - amount;
  const hi = amount === 0 || eligible === true ? lo : e;
  return { lo, hi };
}

function familyCheck(data: Obj, ci: Obj): FamilyCheck {
  const out: FamilyCheck = { missingKeys: [], invalid: [], unknown: [], verdicts: new Map() };
  const dep = obj(data["dependentDeduction"]);
  const ref = String(dep["ageDeterminationDate"]);
  const depMax = Number(dep["dependentTotalIncomeMax"]);
  const spouseMax = Number(obj(data["spouseDeduction"])["spouseTotalIncomeMax"]);
  const spBr = arr(obj(data["spouseSpecialDeduction"])["brackets"]).map(obj);
  const spouseSpecialMax = Number(spBr[spBr.length - 1]?.["spouseTotalIncomeMax"]);
  const sr = obj(data["specificRelativeDeduction"]);
  const srBr = arr(sr["brackets"]).map(obj);
  const srMax = Number(srBr[srBr.length - 1]?.["totalIncomeMax"]);
  const groupsOf = (k: string): Obj[] => arr(obj(data[k])["eligibility"]).map(obj);
  // 入力の名前と許す値の範囲（domain。真偽の要件は真偽値）。同じ入力が複数の条件に現れるとき、どれか1つでも範囲がなければ、範囲がないとする。
  const domains = new Map<string, readonly unknown[] | "boolean" | undefined>();
  const register = (a: Obj): string => {
    const k = String(a["input"]);
    const d = domainOf(a);
    domains.set(k, domains.has(k) && domains.get(k) === undefined ? undefined : d);
    return k;
  };
  const inputsOf = (keys: string[]): string[] =>
    keys.flatMap((k) => groupsOf(k).flatMap((e) => (Array.isArray(e["anyOf"]) ? e["anyOf"].map(obj) : [e]).map(register)));
  const personal = (k: string): boolean => !k.startsWith("taxpayer.");
  const spouseInputs = inputsOf(["spouseDeduction", "spouseSpecialDeduction"]).filter(personal);
  const relativeInputs = [...inputsOf(["dependentDeduction", "specificRelativeDeduction"]), ...arr(dep["categories"]).flatMap((c) => arr(obj(c)["requires"]).map((r) => register(obj(r))))].filter(personal);
  // 家族の構成が分からないこと（"unknown"）は許す（所有者の決定 2026-10-04、粗探しF8）。不足として数え、家族の控除は決まらない。
  if (ci["spouse"] !== null && ci["spouse"] !== "unknown" && !isObj(ci["spouse"])) out.invalid.push("spouse（objectかnullかunknown）");
  if (ci["relatives"] !== "unknown" && (!Array.isArray(ci["relatives"]) || !ci["relatives"].every(isObj))) out.invalid.push("relatives（objectの並びかunknown）");
  if ("taxpayer" in ci && !isObj(ci["taxpayer"])) out.invalid.push("taxpayer（object）");
  // 納税者側の入力（No.1177の(9)）: 型は値があれば常に確かめる。必要かどうかは特定親族特別控除の判定で決める。
  for (const [k, v] of Object.entries(obj(ci["taxpayer"]))) {
    const dom = domains.get(`taxpayer.${k}`);
    if (!domains.has(`taxpayer.${k}`)) out.invalid.push(`taxpayer.${k}（制度データの適用要件にない入力）`);
    else if (dom === undefined || !validValue(v, dom)) out.invalid.push(`taxpayer.${k}（真偽値かunknown: ${JSON.stringify(v)}）`);
  }
  // 本人の合計所得金額（配偶者の控除の候補の判定。PR29-R006の残り、Copilot 4173206297）。検証の責務(c): 既知の値は正確に使う。
  // 所得金額調整控除は、給与等の収入金額がrevenueOver以下なら0、対象かが分かればtrueで実際の額（1円未満切上げ）・falseで0。
  // 対象かが分からないときだけ、0と実際の額の両方を範囲として控えめに判定する（範囲が上限をまたげば未決）。
  const taxpayerForSpouse = ((): Judged => {
    const range = taxpayerTotalRange(data, ci);
    if (range === undefined) return { state: "unknown", unknown: ["salaryRevenue"] };
    const max = Math.max(...arr(obj(data["spouseSpecialDeduction"])["taxpayerTotalIncomeMax"]).map(Number));
    if (range.lo > max) return UNMET;
    if (range.hi <= max) return MET;
    return { state: "unknown", unknown: ["incomeAdjustmentEligible"] };
  })();
  const ageOf = (p: Obj): number | undefined => (isLocalDate(p["birthDate"]) ? ageOn(p["birthDate"], ref) : undefined);
  const age = (p: Obj, ok: (a: number) => boolean): Judged => {
    const a = ageOf(p);
    return a === undefined ? { state: "unknown", unknown: ["birthDate"] } : ok(a) ? MET : UNMET;
  };
  // 控除ごとの候補の判定（所得・年齢・本人の所得）と、額を決めるのに要る入力（候補で適用要件がunmetでないときだけ数える）。
  type Deduction = { key: string; candidate: (p: Obj) => Judged; amountInputs: (p: Obj) => Judged };
  const none = (): Judged => MET;
  const spouseDeductions: Deduction[] = [
    { key: "spouseDeduction", candidate: (p) => all([taxpayerForSpouse, range(p["totalIncome"], "totalIncome", (t) => t <= spouseMax)]), amountInputs: (p) => age(p, () => true) },
    { key: "spouseSpecialDeduction", candidate: (p) => all([taxpayerForSpouse, range(p["totalIncome"], "totalIncome", (t) => t > spouseMax && t <= spouseSpecialMax)]), amountInputs: none },
  ];
  const relativeDeductions: Deduction[] = [
    {
      key: "dependentDeduction",
      candidate: (p) => all([range(p["totalIncome"], "totalIncome", (t) => t <= depMax), age(p, (a) => a >= 16)]),
      amountInputs: (p) => {
        const a = ageOf(p);
        if (a === undefined || a < 70) return MET;
        return all(arr(dep["categories"]).flatMap((c) => arr(obj(c)["requires"]).map((r) => evalGroup(obj(r), p, ci))).filter((j) => j.state === "unknown"));
      },
    },
    {
      key: "specificRelativeDeduction",
      candidate: (p) => all([range(p["totalIncome"], "totalIncome", (t) => t > depMax && t <= srMax), age(p, (a) => a >= Number(sr["ageMin"]) && a < Number(sr["ageBelow"]))]),
      amountInputs: none,
    },
  ];
  const people: [string, Obj, string[], Deduction[]][] = [];
  if (isObj(ci["spouse"])) people.push(["spouse", obj(ci["spouse"]), spouseInputs, spouseDeductions]);
  arr(ci["relatives"]).forEach((r, i) => people.push([`relatives[${i}]`, obj(r), relativeInputs, relativeDeductions]));
  for (const [name, p, keys, deductions] of people) {
    for (const k of ["birthDate", "totalIncome", "livingAtYearEnd", "resident"]) if (!(k in p)) out.missingKeys.push(`${name}.${k}`);
    for (const k of new Set(["birthDate", "totalIncome", "livingAtYearEnd", "resident", ...keys])) {
      if (!(k in p)) continue;
      const dom = k === "birthDate" ? "date" : k === "totalIncome" ? "income" : k === "livingAtYearEnd" || k === "resident" ? "boolean" : domains.get(k);
      if (dom === undefined) out.invalid.push(`${name}.${k}（制度データに許す値の範囲（domain）がない）`);
      else if (!validValue(p[k], dom)) out.invalid.push(`${name}.${k}（型か値が正しくない: ${JSON.stringify(p[k])}）`);
    }
    // 控除ごとに同じ手順: 候補でない、または既知の不適格の条件があれば0（その控除の未知の入力を数えない）。
    // 候補（か未決）で適用要件が決まらなければ、決まらない入力だけを不足に数える。適用の余地がある未知の値を0で補わない。
    // その人の適用対象（居住者か・12月31日に生存しているか）が分からなければ、その人の家族の控除はすべて決まらない（粗探しN3）。
    // 既知でfalseなら、run全体がunsupported（unsupportedInputs）。
    const personUnknown = ["resident", "livingAtYearEnd"].filter((k) => p[k] === "unknown");
    for (const d of deductions) {
      const verdicts = out.verdicts.get(d.key) ?? [];
      out.verdicts.set(d.key, verdicts);
      if (personUnknown.length > 0) {
        verdicts.push("undecided");
        for (const k of personUnknown) out.unknown.push(`${name}.${k}（${d.key}の判定）`);
        continue;
      }
      const cand = d.candidate(p);
      const elig = cand.state === "unmet" ? UNMET : all(groupsOf(d.key).map((e) => evalGroup(e, p, ci)));
      if (cand.state === "unmet" || elig.state === "unmet") {
        verdicts.push("none");
        continue;
      }
      const need = all([cand, elig, d.amountInputs(p)]);
      verdicts.push(need.state === "met" ? "applies" : "undecided");
      for (const k of new Set(need.unknown)) out.unknown.push(`${k.startsWith("taxpayer.") || k === "salaryRevenue" || k === "incomeAdjustmentEligible" ? k : `${name}.${k}`}（${d.key}の判定）`);
    }
  }
  return out;
}

// 入力の値をパス（"a.b"、"list[].x"）で取り出す。途中がnull・ないなら値なし。
function valuesAt(input: unknown, path: string): unknown[] {
  let cur: unknown[] = [input];
  for (const part of path.split(".")) {
    const isList = part.endsWith("[]");
    const key = isList ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const v of cur) {
      if (!isObj(v) || !(key in v)) continue;
      const x = v[key];
      if (isList) next.push(...arr(x));
      else if (x !== null) next.push(x);
    }
    cur = next;
  }
  return cur;
}

// 規則のunsupportedInputsに当たるか（「unknown」は未対応ではなく不足として別に扱う）。
// 条件はallowed（許す値の列挙）かmax（数の上限。上限ちょうどは範囲内。PR29-R011の年末調整の給与の上限）。
// maxの条件で数でない値は、型の検査（requiredInputs）が別に問題にするので、ここでは当たるとしない。
function inputUnsupported(rs: Obj, input: unknown, procedure: unknown): { violates: string[]; unknown: string[] } {
  const violates: string[] = [];
  const unknown: string[] = [];
  for (const u of arr(rs["unsupportedInputs"])) {
    const o = obj(u);
    if (Array.isArray(o["procedures"]) && !o["procedures"].includes(procedure)) continue;
    const allowed = arr(o["allowed"]);
    const max = o["max"];
    for (const v of valuesAt(input, String(o["path"]))) {
      if (v === "unknown") unknown.push(String(o["path"]));
      else if (isInt(max) ? typeof v === "number" && v > max : !allowed.includes(v)) violates.push(String(o["path"]));
    }
  }
  return { violates, unknown };
}

// 手続ごとの必須の入力（manifestのrequiredInputs。PR29-R005）。欠けた・null（nullableでない）・unknownの入力は、分からない入力として数える。
// 家族がない（spouseがnull、relativesが空の並び）ことは、欠けた入力ではない。
function missingRequired(rs: Obj, input: unknown, procedure: unknown): string[] {
  const out: string[] = [];
  for (const r of arr(rs["requiredInputs"])) {
    const o = obj(r);
    if (Array.isArray(o["procedures"]) && !o["procedures"].includes(procedure)) continue;
    // 条件付きの必須の入力（Copilot 4172926847）: whenの値が分からなければ必須として扱う。
    const when = obj(o["when"]);
    if (isObj(o["when"])) {
      const v = valuesAt(input, String(when["path"]))[0];
      if (typeof when["greaterThan"] === "number" && typeof v === "number" && !(v > when["greaterThan"])) continue;
      if (Array.isArray(when["in"]) && v !== undefined && v !== "unknown" && !when["in"].includes(v)) continue;
    }
    const path = String(o["path"]);
    let cur: unknown = input;
    let missing = false;
    for (const part of path.split(".")) {
      if (!isObj(cur) || !(part in cur)) {
        missing = true;
        break;
      }
      cur = cur[part];
    }
    if (missing || cur === "unknown" || (cur === null && o["nullable"] !== true) || (Array.isArray(cur) && cur.length === 0 && o["emptyAllowed"] !== true)) out.push(`${path}（必須の入力）`);
  }
  return out;
}

// 結果の項目を入力から確定できるか（検証の責務(c)。値は計算しない。値の正しさは独立の導き方とレビューで確かめる）。
// 適用対象が分からない（unsupportedInputsの値がunknown）ならどれも確定できない。給与所得控除後の金額は給与等の収入金額が分かれば、
// 所得金額調整控除は850万円以下・対象でない・対象で収入が分かれば、基礎控除は本人の合計所得金額の範囲の両端で同じ行なら、
// 配偶者の控除は配偶者がいないか、家族の判定で不足がなく範囲の両端で同じ列（本人の上限を超える側を含む）なら、扶養控除・特定親族特別控除は
// 親族がいないか不足がなければ、課税される所得金額以降は前の項目と社会保険料控除・ほかの控除（確定申告では確定申告だけの控除も）が
// 分かれば、過不足額・申告納税額はさらに源泉徴収税額が分かれば確定できる。
function knowableResults(data: Obj, ci: Obj, procedure: string, fc: FamilyCheck, applicabilityUnknown: boolean): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const yen = (v: unknown): boolean => isInt(v) && v >= 0;
  const salary = ci["salaryRevenue"];
  const range = taxpayerTotalRange(data, ci);
  const adj = obj(data["incomeAdjustmentDeduction"]);
  const rowOf = (rows: unknown, capKey: string, t: number): number => arr(rows).map(obj).findIndex((r) => r[capKey] === null || t <= Number(r[capKey]));
  const sameRow = (rows: unknown, capKey: string): boolean => range !== undefined && rowOf(rows, capKey, range.lo) === rowOf(rows, capKey, range.hi);
  const spouse = ci["spouse"];
  const relatives = ci["relatives"];
  // 控除ごとの判定（粗探しF4）: 当たらないと分かれば0のknown、当たるなら額を決める列が本人の合計所得金額の範囲の両端で同じときだけknown、
  // 決まらなければunknown。家族の構成が分からない（"unknown"、F8）ならunknown。
  const verdictKnown = (key: string, sameColumn: boolean): boolean =>
    (fc.verdicts.get(key) ?? []).every((v) => v === "none" || (v === "applies" && sameColumn));
  const spouseKnown = (key: string): boolean => spouse === null || (spouse !== "unknown" && verdictKnown(key, sameRow(obj(data["spouseDeduction"])["byTaxpayerTotalIncome"], "taxpayerTotalIncomeMax")));
  out.set("employment-income", yen(salary));
  out.set("income-adjustment-deduction", ci["incomeAdjustmentEligible"] === false || (isInt(salary) && salary >= 0 && (salary <= Number(adj["revenueOver"]) || ci["incomeAdjustmentEligible"] === true)));
  out.set("basic-deduction", sameRow(obj(data["basicDeduction"])["brackets"], "totalIncomeMax"));
  out.set("spouse-deduction", spouseKnown("spouseDeduction"));
  out.set("spouse-special-deduction", spouseKnown("spouseSpecialDeduction"));
  out.set("dependent-deduction", relatives !== "unknown" && verdictKnown("dependentDeduction", true));
  out.set("specific-relative-deduction", relatives !== "unknown" && verdictKnown("specificRelativeDeduction", true));
  const deductionsKnown = INCOME_TAX_RESULTS_COMMON.slice(0, 7).every((k) => out.get(k) === true) && yen(ci["socialInsuranceDeduction"]) && yen(ci["otherIncomeDeductions"]) && (procedure !== "tax-return" || yen(ci["returnOnlyDeductions"]));
  for (const k of ["taxable-income", "computed-income-tax", "annual-tax", "reconstruction-tax", "income-tax-total"]) out.set(k, deductionsKnown);
  for (const k of ["year-end-balance", "filing-tax-balance"]) out.set(k, deductionsKnown && yen(ci["withheldTax"]));
  if (applicabilityUnknown) for (const k of out.keys()) out.set(k, false);
  return out;
}

// 存在する入力の形（検証の責務(b)。Copilot 5400605738・4173206315、PR29-R010）。requiredInputs・optionalInputsの型を、手続やケースの状態に
// かかわらず、値があれば確かめる: yenは0以上の整数、booleanは真偽値、enumはvaluesの列挙、dateは日付、objectはobject（nullableならnullも）、
// arrayは並び。「unknown」は不足として(c)で別に数えるので、ここでは型を問わない。宣言にない入力の名前も拒否する
// （家族の入力spouse・relatives・taxpayerの中はfamilyCheckが確かめる）。年間資料の写し（annualValues）は各資料の形と、採用した資料の合計を確かめる。
const INPUT_TYPES = ["yen", "boolean", "enum", "date", "object", "array"];
const FAMILY_KEYS = ["spouse", "relatives", "taxpayer"];

function declaredInputs(rs: Obj): Obj[] {
  return [...arr(rs["requiredInputs"]), ...arr(rs["optionalInputs"])].map(obj);
}

function invalidInputs(rs: Obj, input: unknown): string[] {
  const out: string[] = [];
  if (!isObj(input)) return ["input（object）"];
  const declared = declaredInputs(rs);
  const paths = [...declared.map((o) => String(o["path"])), ...arr(rs["unsupportedInputs"]).map((u) => String(obj(u)["path"]).replaceAll("[]", ""))];
  for (const k of Object.keys(input)) if (!paths.some((p) => p === k || p.startsWith(`${k}.`))) out.push(`${k}（manifestのrequiredInputs・optionalInputs・unsupportedInputsにない入力）`);
  for (const [k, v] of Object.entries(input)) {
    if (FAMILY_KEYS.includes(k) || !isObj(v)) continue;
    for (const kk of Object.keys(v)) if (!paths.includes(`${k}.${kk}`)) out.push(`${k}.${kk}（manifestにない入力）`);
  }
  for (const o of declared) {
    let cur: unknown = input;
    let present = true;
    for (const part of String(o["path"]).split(".")) {
      if (!isObj(cur) || !(part in cur)) {
        present = false;
        break;
      }
      cur = cur[part];
    }
    if (!present || cur === "unknown" || (cur === null && o["nullable"] === true)) continue;
    const t = o["type"];
    const ok =
      t === "yen" ? isInt(cur) && cur >= 0 : t === "boolean" ? typeof cur === "boolean" : t === "enum" ? arr(o["values"]).includes(cur) : t === "date" ? isLocalDate(cur) : t === "object" ? isObj(cur) : t === "array" ? Array.isArray(cur) : false;
    if (!ok) out.push(`${String(o["path"])}（型か値が正しくない: ${JSON.stringify(cur)}）`);
  }
  if ("annualValues" in input || "payslipDerivedValues" in input) out.push(...invalidAnnualValues(input));
  return out;
}

// 年間の値の元（確定申告。PR29-R002、粗探しF1〜F3、所有者の決定 2026-10-04「混在を扱う」）。
// annualValues（源泉徴収票の写し）: 各資料は{ id, payer, documentType: withholding-slip, paymentAmount・withholdingTax・socialInsurancePremiums（0以上の整数）,
// includedOtherPayers（並びかunknown。要素は{ payer, paymentAmount, withholdingTax, socialInsurancePremiums }）, adopted（真偽値かadoption-needed） }。
// payslipDerivedValues（源泉徴収票のない支払者の明細から示す値）: 要素は{ payer, paymentAmount・withholdingTax・socialInsurancePremiums（0以上の整数かunknown） }。
// 範囲: 採用した資料は範囲が確定し、採用した資料どうしで支払者を重ねない。採用しない資料は、採用したどれかの資料の範囲に含まれ、
// 含む側の金額と一致する（一部だけの包含はない）。明細の支払者は、どの資料の支払者・範囲とも、明細どうしとも重ねない。
// 合計: 採用が要判断の資料があるか、明細の金額がunknownなら、それに依存する入力（salaryRevenue・withheldTax・socialInsuranceDeduction）は
// unknownでなければならない（既知の値で補わない）。そうでなければ、採用した資料と明細の合計がsalaryRevenue・withheldTaxと同じ。
// 社会保険料控除額は、採用した資料と明細の社会保険料等の金額の合計と、確定申告で足す額（socialInsuranceAdditional。資料・明細があれば必須）の和と同じ
// （粗探しN2。「以上」では資料の社会保険料を二重に数えた値を通すため）。
function invalidAnnualValues(input: Obj): string[] {
  const out: string[] = [];
  const list = input["annualValues"];
  const slips = input["payslipDerivedValues"];
  if (!Array.isArray(list) && !Array.isArray(slips)) return out;
  const yen = (v: unknown): boolean => isInt(v) && v >= 0;
  const AMOUNTS = ["paymentAmount", "withholdingTax", "socialInsurancePremiums"];
  const docs = arr(list).map(obj);
  arr(list).forEach((d, i) => {
    const o = obj(d);
    const w = `annualValues[${i}]`;
    if (!isObj(d) || !nonEmpty(o["id"]) || !nonEmpty(o["payer"]) || o["documentType"] !== "withholding-slip" || !AMOUNTS.every((k) => yen(o[k]))) out.push(`${w}（{ id, payer, documentType: withholding-slip, paymentAmount・withholdingTax・socialInsurancePremiums（0以上の整数） }）`);
    const inc = o["includedOtherPayers"];
    if (inc !== "unknown" && (!Array.isArray(inc) || !inc.every((x) => isObj(x) && nonEmpty(x["payer"]) && AMOUNTS.every((k) => yen(x[k]))))) out.push(`${w}.includedOtherPayers（並びかunknown）`);
    if (o["adopted"] !== true && o["adopted"] !== false && o["adopted"] !== "adoption-needed") out.push(`${w}.adopted（真偽値かadoption-needed）`);
  });
  const pays = arr(slips).map(obj);
  arr(slips).forEach((x, i) => {
    const o = obj(x);
    if (!isObj(x) || !nonEmpty(o["payer"]) || !AMOUNTS.every((k) => yen(o[k]) || o[k] === "unknown")) out.push(`payslipDerivedValues[${i}]（{ payer, paymentAmount・withholdingTax・socialInsurancePremiums（0以上の整数かunknown） }）`);
  });
  if (out.length > 0) return out;
  // 範囲
  const covered = new Map<string, { id: string; entry: Obj }>();
  for (const d of docs.filter((x) => x["adopted"] === true)) {
    if (!Array.isArray(d["includedOtherPayers"])) {
      out.push(`annualValues（${String(d["id"])}）: 範囲（includedOtherPayers）が確定しない資料を採用している`);
      continue;
    }
    for (const entry of [d, ...d["includedOtherPayers"].map(obj)]) {
      const payer = String(entry["payer"]);
      if (covered.has(payer)) out.push(`annualValues（${String(d["id"])}）: 支払者${payer}を、採用した資料${String(covered.get(payer)?.id)}と重ねて数える`);
      else covered.set(payer, { id: String(d["id"]), entry });
    }
  }
  if (docs.every((d) => typeof d["adopted"] === "boolean")) {
    for (const d of docs.filter((x) => x["adopted"] === false)) {
      const c = covered.get(String(d["payer"]));
      if (c === undefined) out.push(`annualValues（${String(d["id"])}）: 採用しない資料の支払者が、採用したどの資料の範囲にも含まれない`);
      else if (!AMOUNTS.every((k) => c.entry[k] === d[k])) out.push(`annualValues（${String(d["id"])}）: 採用した資料${c.id}の範囲に含まれる金額が、この資料の金額と違う（一部だけの包含）`);
    }
  }
  const slipPayers = new Set(docs.flatMap((d) => [d["payer"], ...arr(d["includedOtherPayers"]).map((x) => obj(x)["payer"])]).map(String));
  const seen = new Set<string>();
  pays.forEach((x, i) => {
    const payer = String(x["payer"]);
    if (slipPayers.has(payer)) out.push(`payslipDerivedValues[${i}]: 支払者${payer}は源泉徴収票（の範囲）にもあり、重ねて数える`);
    if (seen.has(payer)) out.push(`payslipDerivedValues[${i}]: 支払者${payer}が明細から示す値に2回ある`);
    seen.add(payer);
  });
  if (out.length > 0) return out;
  // 合計
  const undecided = docs.some((d) => d["adopted"] === "adoption-needed");
  const adopted = docs.filter((d) => d["adopted"] === true);
  if (!("socialInsuranceAdditional" in input)) out.push("socialInsuranceAdditional（年間資料か明細から示す値があるときは、確定申告で足す社会保険料等の額が要る。なければ0）");
  const additional = input["socialInsuranceAdditional"];
  for (const [k, target] of [["paymentAmount", "salaryRevenue"], ["withholdingTax", "withheldTax"], ["socialInsurancePremiums", "socialInsuranceDeduction"]] as const) {
    const parts = [...adopted.map((d) => d[k]), ...pays.map((x) => x[k])];
    if (target === "socialInsuranceDeduction") parts.push(additional);
    const v = input[target];
    if (undecided || parts.some((p) => p === "unknown")) {
      if (v !== "unknown") out.push(`${target}（採用が要判断の資料か、明細から示す値・確定申告で足す額の分からない金額があるので、unknownでなければならない: ${JSON.stringify(v)}）`);
      continue;
    }
    const sum = parts.reduce((a: number, p) => a + Number(p), 0);
    if (isInt(v) && sum !== v) out.push(`annualValues・payslipDerivedValues（採用した資料と明細の${k}の合計${target === "socialInsuranceDeduction" ? "と確定申告で足す額の和" : ""}${sum}が${target}と違う）`);
  }
  return out;
}

// 年末調整の対象者の条件（PR29-R011。タックスアンサーNo.2665）。制度データのyearEndAdjustmentLimits.targetConditionsの全部が、
// manifestのunsupportedInputs（procedures: year-end-adjustmentだけ、yearEndAdjustmentConditionが同じid）と一対一で、
// 同じ入力・同じ許す値（給与の上限はmaxがsalaryRevenueMaxと同じ）を持ち、その入力は年末調整の必須の入力。
// taxableIncomeMaxは、上限の収入の給与所得控除後の金額と同じ（別の条件ではない）。確定申告にはこれらの条件を当てない。
function checkYearEndAdjustmentConditions(rs: Obj, data: Obj, w: string, problems: Problems): void {
  const limits = obj(data["yearEndAdjustmentLimits"]);
  const conds = arr(limits["targetConditions"]).map(obj);
  if (conds.length === 0) {
    problems.add(w, "yearEndAdjustmentLimits.targetConditions（年末調整の対象者の条件）がない");
    return;
  }
  const unsup = arr(rs["unsupportedInputs"]).map(obj);
  const linked = unsup.filter((u) => "yearEndAdjustmentCondition" in u);
  const ids = new Set<string>();
  for (const c of conds) {
    const id = String(c["id"]);
    if (ids.has(id)) problems.add(w, `targetConditionsのidが重なる: ${id}`);
    ids.add(id);
    const us = linked.filter((u) => u["yearEndAdjustmentCondition"] === id);
    if (us.length !== 1) {
      problems.add(w, `年末調整の対象者の条件（${id}）に対応するunsupportedInputsが1つでない: ${us.length}`);
      continue;
    }
    const u = obj(us[0]);
    if (u["path"] !== c["input"]) problems.add(w, `年末調整の対象者の条件（${id}）の入力がunsupportedInputsのpathと違う`);
    if (JSON.stringify(u["procedures"]) !== JSON.stringify(["year-end-adjustment"])) problems.add(w, `年末調整の対象者の条件（${id}）のunsupportedInputsは、proceduresがyear-end-adjustmentだけ（確定申告に当てない）`);
    if ("maxRef" in c) {
      const max = limits[String(c["maxRef"])];
      if (!isInt(max) || u["max"] !== max || "allowed" in u) problems.add(w, `年末調整の対象者の条件（${id}）の上限が、unsupportedInputsのmaxと制度データの${String(c["maxRef"])}で違う`);
    } else if (JSON.stringify(u["allowed"]) !== JSON.stringify(c["allowed"]) || arr(c["allowed"]).length === 0 || "max" in u) problems.add(w, `年末調整の対象者の条件（${id}）の許す値が、unsupportedInputsのallowedと違う`);
    const req = arr(rs["requiredInputs"]).map(obj).find((r) => r["path"] === c["input"] && (!Array.isArray(r["procedures"]) || r["procedures"].includes("year-end-adjustment")));
    if (req === undefined) problems.add(w, `年末調整の対象者の条件（${id}）の入力${String(c["input"])}が、年末調整の必須の入力（requiredInputs）にない`);
  }
  for (const u of linked) if (!ids.has(String(u["yearEndAdjustmentCondition"]))) problems.add(w, `unsupportedInputsのyearEndAdjustmentCondition（${String(u["yearEndAdjustmentCondition"])}）が制度データのtargetConditionsにない`);
  const revenueMax = limits["salaryRevenueMax"];
  const emp = isInt(revenueMax) ? decToNumber(employmentIncomeOf(data, "", new Problems())?.(revenueMax)) : Number.NaN;
  if (limits["taxableIncomeMax"] !== emp) problems.add(w, `yearEndAdjustmentLimits.taxableIncomeMaxが、salaryRevenueMaxの給与所得控除後の金額（${emp}）と違う`);
}

const REVIEW_RECORD = /^https:\/\/github\.com\/doc-gif\/kurashi-ledger\/pull\/([1-9][0-9]*)#(pullrequestreview|issuecomment)-[1-9][0-9]*$/;
const PULL_REQUEST = /^https:\/\/github\.com\/doc-gif\/kurashi-ledger\/pull\/([1-9][0-9]*)$/;

// 規則の承認の証跡（docs/rules/README.mdの「状態と承認」。正本はmanifestのapproval。PR29-R003）。
function checkApproval(rs: Obj, w: string, problems: Problems): void {
  const a = rs["approval"];
  if (rs["status"] !== "approved") {
    if (a !== REGIME_PLACEHOLDER) problems.add(w, "draftの規則のapprovalは「未確認」");
    return;
  }
  if (!isObj(a)) {
    problems.add(w, "approvedの規則には承認の証跡（approval: { reviewRecord, reviewedHead, approvalPullRequest }）が要る");
    return;
  }
  const review = REVIEW_RECORD.exec(String(a["reviewRecord"]));
  const pr = PULL_REQUEST.exec(String(a["approvalPullRequest"]));
  if (review === null) problems.add(w, "approval.reviewRecordは、このrepoのPRのレビューかコメントのURL");
  if (typeof a["reviewedHead"] !== "string" || !/^[0-9a-f]{40}$/.test(a["reviewedHead"])) problems.add(w, "approval.reviewedHeadは40文字のcommit SHA");
  if (pr === null) problems.add(w, "approval.approvalPullRequestは、approvedにしたPRのURL");
  else if (review !== null && review[1] === pr[1]) problems.add(w, "approvedにする変更は、内容をレビューしたPRとは別のPRで行う");
}

function checkDataRounding(data: Obj, where: string, problems: Problems): Set<string> {
  const keys = new Set<string>();
  const list = data["rounding"];
  if (!Array.isArray(list)) return keys;
  list.forEach((r, i) => {
    const o = obj(r);
    const w = `${where} rounding[${i}]`;
    if (!nonEmpty(o["item"]) || !ROUNDING_METHODS.includes(String(o["method"])) || parseDec(o["unit"]) === undefined || Number(o["unit"]) <= 0 || !isObj(o["source"])) {
      problems.add(w, "{ item, method, unit（正）, source }");
      return;
    }
    const key = `${String(o["item"])}|${String(o["method"])}|${String(o["unit"])}`;
    if ([...keys].some((k) => k.startsWith(`${String(o["item"])}|`))) problems.add(w, "同じ項目の丸めが2つある");
    keys.add(key);
  });
  return keys;
}

// 帰属の規則（docs/rules/salary-income-year.md）。自動で当てはめない版では、規則の根拠で年を決める例がないこと（PR29-R001）。
function checkAttribution(rs: Obj, data: Obj, where: string, problems: Problems): void {
  const auto = rs["autoApply"];
  if (typeof auto !== "boolean" || data["autoApply"] !== auto || obj(data["rule"])["autoApply"] !== auto) problems.add(where, "autoApplyがmanifest・制度データ・ruleで同じ真偽値ではない");
  const examples = arr(data["examples"]);
  if (examples.length === 0) problems.add(where, "帰属の例（examples）がない");
  examples.forEach((e, i) => {
    const x = obj(obj(e)["expected"]);
    const w = `${where} examples[${i}]`;
    const state = x["attribution"];
    if (!["undetermined", "determined", "conflict"].includes(String(state))) problems.add(w, "attributionはundetermined・determined・conflict");
    if (state === "determined" ? !isCalendarYear(x["incomeYear"]) || arr(x["bases"]).length === 0 : x["incomeYear"] !== "unknown") problems.add(w, "determinedは年と根拠、それ以外の年はunknown");
    if (auto === false && arr(x["bases"]).includes("rule")) problems.add(w, "自動で当てはめない規則の根拠（rule）で年を決めている");
  });
}

// 源泉徴収票の対応表の形（PR29-R007）。項目名・条件・符号の列挙だけを確かめ、金額の正しさの代わりにしない。
const YEA_STATUSES = ["adjusted", "not-adjusted", "not-stated", "unknown"];

function checkMapping(data: Obj, where: string, problems: Problems): void {
  if (data["documentType"] !== "withholding-slip") problems.add(where, "documentTypeはwithholding-slip");
  if (!Array.isArray(data["targetYears"]) || data["targetYears"].length === 0 || !data["targetYears"].every(isCalendarYear)) problems.add(where, "targetYearsは年の並び（1件以上）");
  const fields = arr(data["fields"]).map(obj);
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    const w = `${where} fields[${i}]`;
    const name = String(f["field"]);
    if (!ANNUAL_AMOUNT_ITEMS.includes(name)) problems.add(w, `fieldが年間資料の金額の項目にない: ${name}`);
    if (seen.has(name)) problems.add(w, `fieldが重なる: ${name}`);
    seen.add(name);
    const covered: string[] = [];
    const variants = arr(f["variants"]).map(obj);
    if (variants.length === 0) problems.add(w, "variantsがない");
    variants.forEach((v, j) => {
      const vw = `${w} variants[${j}]`;
      const st = arr(v["yearEndAdjustmentStatus"]);
      if (st.length === 0 || !st.every((x) => YEA_STATUSES.includes(String(x)))) problems.add(vw, `yearEndAdjustmentStatusは${YEA_STATUSES.join("・")}の並び`);
      for (const x of st) {
        if (covered.includes(String(x))) problems.add(vw, `年末調整の有無の条件が重なる: ${String(x)}`);
        covered.push(String(x));
      }
      const m = obj(v["mapping"]);
      if (m["kind"] === "sum") {
        const terms = arr(m["terms"]).map(obj);
        if (terms.length === 0) problems.add(vw, "sumのtermsがない");
        const items = new Set<string>();
        for (const t of terms) {
          if (!PAYSLIP_AMOUNT_ITEMS.includes(String(t["item"]))) problems.add(vw, `termsのitemが給与明細の金額の項目にない: ${String(t["item"])}`);
          if (t["sign"] !== 1 && t["sign"] !== -1) problems.add(vw, "termsのsignは1か-1");
          if (items.has(String(t["item"]))) problems.add(vw, `termsのitemが重なる: ${String(t["item"])}`);
          items.add(String(t["item"]));
        }
        if ("reason" in m) problems.add(vw, "sumはreasonを持たない");
      } else if (m["kind"] === "not-mapped") {
        if (!nonEmpty(m["reason"]) || "terms" in m) problems.add(vw, "not-mappedはreason（空でない）だけを持つ");
      } else problems.add(vw, "mapping.kindはsum・not-mapped");
    });
    for (const x of YEA_STATUSES) if (!covered.includes(x)) problems.add(w, `年末調整の有無の条件が抜けている: ${x}`);
  });
  for (const x of ANNUAL_AMOUNT_ITEMS) if (!seen.has(x)) problems.add(where, `年間資料の金額の項目の対応がない: ${x}`);
}

// ---- 全体

export interface RulesInput {
  manifest: unknown;
  dataFiles: ReadonlyMap<string, unknown>;
  fileExists: (path: string) => boolean;
  regimeCases: unknown;
}

export function validateRules(input: RulesInput): string[] {
  const problems = new Problems();
  const m = obj(input.manifest);
  if (m["schemaVersion"] !== 1 || m["contractVersion"] !== "1.0") problems.add("manifest", "schemaVersion 1・contractVersion 1.0");
  // 一次資料
  const sources = new Map<string, Obj>();
  arr(m["sources"]).forEach((s, i) => {
    const o = obj(s);
    const w = `manifest sources[${i}]`;
    const id = o["id"];
    if (!nonEmpty(id) || !/^[a-z0-9-]+$/.test(id)) problems.add(w, "idは英小文字・数字・-");
    else if (sources.has(id)) problems.add(w, `idが重なる: ${id}`);
    else sources.set(id, o);
    if (!nonEmpty(o["title"]) || !nonEmpty(o["publisher"]) || typeof o["url"] !== "string" || !o["url"].startsWith("https://") || typeof o["primary"] !== "boolean") problems.add(w, "{ title, publisher, url（https）, primary }");
    if (!isLocalDate(o["documentUpdatedOn"]) || !isLocalDate(o["retrievedOn"])) problems.add(w, "資料の更新日（documentUpdatedOn）と取得日（retrievedOn）は日付");
    else if (o["documentUpdatedOn"] > o["retrievedOn"]) problems.add(w, "資料の更新日が取得日より後");
    if (!DATE_BASES.includes(String(o["documentDateBasis"]))) problems.add(w, `documentDateBasisは${DATE_BASES.join("・")}`);
  });
  const urls = new Map<string, string>();
  for (const [id, s] of sources) {
    const u = String(s["url"]);
    if (urls.has(u)) problems.add(`manifest sources ${id}`, `同じURLの資料が2つある: ${String(urls.get(u))}`);
    urls.set(u, id);
  }
  // 規則
  if (arr(m["ruleSets"]).length === 0) problems.add("manifest", "規則（ruleSets）がない");
  const ruleSets = new Map<string, { rs: Obj; applies: Applies[]; used: Set<string> }>();
  const usedSources = new Set<string>();
  arr(m["ruleSets"]).forEach((r, i) => {
    const rs = obj(r);
    const w = `manifest ruleSets[${i}]`;
    const id = rs["id"];
    const version = rs["version"];
    if (!nonEmpty(id) || !/^[a-z0-9-]+$/.test(id) || typeof version !== "string" || !/^[1-9][0-9]*$/.test(version)) {
      problems.add(w, "idは英小文字・数字・-、versionは1以上の整数の文字列");
      return;
    }
    const key = `${id}@${version}`;
    if (ruleSets.has(key)) problems.add(w, `同じ規則の版が2つある: ${key}`);
    if (!STATUSES.includes(String(rs["status"]))) problems.add(w, "statusはdraft・approved");
    if (!REGIMES.includes(String(rs["regime"]))) problems.add(w, "regimeが表にない");
    if (!KINDS.includes(String(rs["kind"]))) problems.add(w, `kindは${KINDS.join("・")}`);
    for (const k of ["spec", "data"]) if (!nonEmpty(rs[k]) || !input.fileExists(String(rs[k]))) problems.add(w, `${k}のファイルがない: ${String(rs[k])}`);
    const listed = new Set<string>();
    for (const s of arr(rs["sources"])) {
      if (typeof s !== "string" || !sources.has(s)) problems.add(w, `sourcesのidがmanifestにない: ${String(s)}`);
      else listed.add(s);
      if (typeof s === "string") usedSources.add(s);
    }
    if (listed.size === 0) problems.add(w, "一次資料（sources）がない");
    else if (![...listed].some((s) => sources.get(s)?.["primary"] === true)) problems.add(w, "一次資料（primary: true）が要る");
    const applies = checkApplies(rs, `${w} ${key}`, problems);
    if (rs["kind"] === "calculation" && (!Array.isArray(rs["requiredInputs"]) || rs["requiredInputs"].length === 0 || !rs["requiredInputs"].every((r) => nonEmpty(obj(r)["path"]) && INPUT_TYPES.includes(String(obj(r)["type"])) && (obj(r)["type"] !== "enum" || arr(obj(r)["values"]).length > 0)))) problems.add(`${w} ${key}`, "計算の規則には必須の入力（requiredInputs: [{ path, type: yen・boolean・enum（values）・date・object・array, procedures?, when?, nullable?, emptyAllowed? }]）が要る");
    if (!arr(rs["optionalInputs"]).every((r) => nonEmpty(obj(r)["path"]) && INPUT_TYPES.includes(String(obj(r)["type"])))) problems.add(`${w} ${key}`, "任意の入力（optionalInputs）は{ path, type, procedures?, meaning? }");
    ruleSets.set(key, { rs, applies, used: new Set<string>() });
    // 制度データ
    const data = obj(input.dataFiles.get(String(rs["data"])));
    const dw = `${String(rs["data"])}`;
    if (data["ruleSetId"] !== id || data["version"] !== version || data["status"] !== rs["status"]) problems.add(dw, "ruleSetId・version・statusがmanifestと違う");
    if ("approval" in data) problems.add(dw, "承認の証跡はmanifestのapprovalだけに書く（制度データに写さない）");
    checkApproval(rs, `${w} ${key}`, problems);
    if (rs["kind"] === "attribution") checkAttribution(rs, data, dw, problems);
    if (rs["kind"] === "comparison-mapping") checkMapping(data, dw, problems);
    const refs: { ref: unknown; location: unknown; path: string }[] = [];
    collectSourceRefs(data, "", refs);
    for (const ref of refs) {
      if (typeof ref.ref !== "string" || !listed.has(ref.ref)) problems.add(`${dw} ${ref.path}`, `原典のidが規則のsourcesにない: ${String(ref.ref)}`);
      else ruleSets.get(key)?.used.add(ref.ref);
      if (!nonEmpty(ref.location)) problems.add(`${dw} ${ref.path}`, "原典の箇所（location）がない");
    }
    checkDataRounding(data, dw, problems);
    if (rs["regime"] === "income-tax" && rs["kind"] === "calculation") {
      checkIncomeTaxData(data, dw, problems);
      checkYearEndAdjustmentConditions(rs, data, `${w} ${key}`, problems);
    }
    for (const u of arr(rs["unsupportedInputs"]).map(obj)) if (!nonEmpty(u["path"]) || (isInt(u["max"]) ? "allowed" in u : arr(u["allowed"]).length === 0)) problems.add(`${w} ${key}`, `unsupportedInputs（${String(u["path"])}）はpathと、allowed（許す値の列挙）かmax（数の上限）のどちらか1つを持つ`);
  });
  // 地域の符号の体系（docs/rules/README.mdの「地域の符号」）の資料。
  const codeSystem = obj(m["jurisdictionCodeSystem"]);
  if (!nonEmpty(codeSystem["spec"]) || !input.fileExists(String(codeSystem["spec"]))) problems.add("manifest jurisdictionCodeSystem", "specのファイルがない");
  for (const s of arr(codeSystem["sources"])) {
    if (typeof s !== "string" || !sources.has(s)) problems.add("manifest jurisdictionCodeSystem", `sourcesのidがmanifestにない: ${String(s)}`);
    else usedSources.add(s);
  }
  for (const id of sources.keys()) if (!usedSources.has(id)) problems.add(`manifest sources ${id}`, "どの規則のsourcesにもない資料");
  // 別の規則どうしの適用の範囲は重ねない（同じ規則の版どうしは、版で選ぶので重なってよい）。
  const entries = [...ruleSets.entries()];
  entries.forEach(([ka, a], i) => {
    for (const [kb, b] of entries.slice(i + 1)) {
      if (a.rs["id"] === b.rs["id"] || a.rs["kind"] !== b.rs["kind"] || a.rs["regime"] !== b.rs["regime"]) continue;
      if (a.applies.some((x) => b.applies.some((y) => overlaps(x, y)))) problems.add(`manifest ${ka}`, `適用の範囲が${kb}と重なる`);
    }
  });
  // 制度のケース
  const rc = obj(input.regimeCases);
  arr(rc["cases"]).forEach((c) => {
    const o = obj(c);
    if (o["status"] === "placeholder") return;
    const w = `${REGIME_CASES_PATH} ${String(o["caseId"])}`;
    const rsRef = obj(o["ruleSet"]);
    const key = `${String(rsRef["id"])}@${String(rsRef["version"])}`;
    const entry = ruleSets.get(key);
    if (entry === undefined) {
      problems.add(w, `ruleSetがmanifestにない: ${key}`);
      return;
    }
    if (entry.rs["regime"] !== o["regime"]) problems.add(w, "regimeが規則と違う");
    if (o["status"] === "approved" && entry.rs["status"] !== "approved") problems.add(w, "approvedのケースは承認済み（approved）の規則だけを使う");
    arr(o["sources"]).forEach((s, i) => {
      const so = obj(s);
      const id = urls.get(String(so["url"]));
      const ms = id === undefined ? undefined : sources.get(id);
      if (id === undefined || ms === undefined) {
        problems.add(w, `sources[${i}]のURLがmanifestの資料にない`);
        return;
      }
      for (const k of ["title", "publisher", "primary", "documentUpdatedOn", "retrievedOn"]) if (so[k] !== ms[k]) problems.add(w, `sources[${i}]の${k}がmanifestの資料（${id}）と違う`);
      if (!arr(entry.rs["sources"]).includes(id)) problems.add(w, `sources[${i}]の資料（${id}）が規則のsourcesにない`);
      else entry.used.add(id);
    });
    const expected = obj(o["expected"]);
    const status = expected["status"];
    if (!RUN_STATUSES.includes(String(status))) {
      problems.add(w, `expected.statusは${RUN_STATUSES.join("・")}`);
      return;
    }
    const target = obj(o["target"]);
    const caseInput = o["input"];
    const unsup = inputUnsupported(entry.rs, caseInput, target["procedure"]);
    // (b) 存在する入力の形は、unsupportedを含む全ケースで確かめる（PR29-R010）。欠けた入力と分からない入力は(c)で、unsupportedでないケースだけ数える。
    const isCalc = entry.rs["kind"] === "calculation";
    const fc = isCalc && entry.rs["regime"] === "income-tax" ? familyCheck(obj(input.dataFiles.get(String(entry.rs["data"]))), obj(caseInput)) : undefined;
    if (isCalc) for (const k of invalidInputs(entry.rs, caseInput)) problems.add(w, `input.${k}`);
    for (const k of fc?.invalid ?? []) problems.add(w, `input.${k}`);
    if (fc !== undefined) {
      const keys = arr(expected["results"]).map((r) => obj(r)["key"]);
      const want = INCOME_TAX_RESULTS[String(target["procedure"])];
      if (want !== undefined && JSON.stringify(keys) !== JSON.stringify(want)) problems.add(w, `expected.resultsの項目が計算の順序の項目（${want.join("・")}）と違う`);
      for (const r of arr(expected["results"]).map(obj)) {
        const v = obj(r["value"]);
        if (r["valueType"] !== "yen" || !(v["state"] === "unknown" ? Object.keys(v).length === 1 : v["state"] === "known" && isInt(v["value"]))) problems.add(w, `expected.results（${String(r["key"])}）は{ valueType: yen, value: { state: known, value: 整数 }か{ state: unknown } }`);
      }
    }
    // (a) 適用対象: unsupportedは、targetに当たる規則がないか、入力が未対応の条件に当たるときだけ。
    if (status === "unsupported") {
      const coveredBy = entries.filter(([, e]) => e.rs["regime"] === o["regime"] && e.rs["kind"] === "calculation" && targetCovered(target, e.applies) && inputUnsupported(e.rs, caseInput, target["procedure"]).violates.length === 0).map(([k]) => k);
      if (coveredBy.length > 0) problems.add(w, `unsupportedのケースのtargetに当たり、入力も未対応の条件（unsupportedInputs）に当たらない規則がある: ${coveredBy.join("・")}`);
      if (arr(expected["results"]).some((r) => obj(obj(r)["value"])["state"] !== "unknown")) problems.add(w, "unsupportedの結果の値はすべてunknown");
      if (arr(o["rounding"]).length > 0) problems.add(w, "unsupportedのケースは丸めの手順を持たない");
      return;
    }
    if (!targetCovered(target, entry.applies)) problems.add(w, "targetが規則の適用の範囲（applies）に当たらない");
    if (unsup.violates.length > 0) problems.add(w, `入力が規則の未対応の条件に当たるのに${String(status)}: ${unsup.violates.join("・")}`);
    // (c) 分からない入力から結果を確定できるか。
    const unknownInputs = [...unsup.unknown, ...missingRequired(entry.rs, caseInput, target["procedure"])];
    // 採用が要判断の年間資料が残れば、年間の値（給与等の収入金額等）は決まらない（PR29-R002）。
    if (arr(obj(caseInput)["annualValues"]).some((d) => obj(d)["adopted"] === "adoption-needed")) unknownInputs.push("annualValues（採用が要判断の資料がある）");
    if (fc !== undefined) {
      for (const k of fc.missingKeys) problems.add(w, `input.${k}がない（家族の控除の適用要件と判定に使う入力。PR29-R006）`);
      unknownInputs.push(...fc.unknown);
      // 結果の項目ごとに、入力から確定できるならknown、できないならunknown（PR29-R006の残り、Copilot 4173508041）。
      // 適用対象が分からない: 未対応の条件の値がunknownか、未対応の条件に当たる必須の入力が欠けている（粗探しF5。欠落とunknownを同じに扱う）。
      const unsupPaths = arr(entry.rs["unsupportedInputs"]).map(obj).filter((u) => !Array.isArray(u["procedures"]) || u["procedures"].includes(target["procedure"])).map((u) => String(u["path"]));
      const missingApplicability = missingRequired(entry.rs, caseInput, target["procedure"]).some((m) => unsupPaths.includes(m.replace(/（必須の入力）$/, "")));
      // 家族の一人の適用対象（spouse.・relatives[].の条件）が分からないときは、run全体ではなく、その人の家族の控除だけが決まらない（粗探しN3。familyCheckが扱う）。
      const runApplicabilityUnknown = unsup.unknown.some((p) => !FAMILY_KEYS.some((f) => p.startsWith(`${f}.`) || p.startsWith(`${f}[]`)));
      const know = knowableResults(obj(input.dataFiles.get(String(entry.rs["data"]))), obj(caseInput), String(target["procedure"]), fc, runApplicabilityUnknown || missingApplicability);
      for (const r of arr(expected["results"]).map(obj)) {
        const k = know.get(String(r["key"]));
        const isKnown = obj(r["value"])["state"] === "known";
        if (k === true && !isKnown) problems.add(w, `expected.results（${String(r["key"])}）: 入力から確定できるのにunknown`);
        if (k === false && isKnown) problems.add(w, `expected.results（${String(r["key"])}）: 入力から確定できないのにknown`);
      }
    }
    // 明細から示す値（coverageがentered-records-onlyの年間の値）を既知の金額で使うrunはprovisional（契約版1.0の計算結果の2の表の4・5行。粗探しN1）。
    if (status === "computed" && arr(obj(caseInput)["payslipDerivedValues"]).length > 0) problems.add(w, "明細から示す値（payslipDerivedValues）を使うrunはprovisional（computedにしない）");
    if ((status === "computed" || status === "provisional") && unknownInputs.length > 0) problems.add(w, `分からない入力があるのに${String(status)}: ${unknownInputs.join("・")}`);
    if (status === "incomplete" && !arr(expected["results"]).some((r) => obj(obj(r)["value"])["state"] === "unknown")) problems.add(w, "incompleteなのに、unknownの結果がない");
    if (o["status"] === "approved" && obj(o["derivation"])["reviewedBy"] !== obj(entry.rs["approval"])["reviewRecord"]) problems.add(w, "approvedのケースのreviewedByが、規則の承認の証跡（approval.reviewRecord）と違う");
    const values = new Map<string, unknown>();
    for (const r of arr(expected["results"])) {
      const ro = obj(r);
      const v = obj(ro["value"]);
      values.set(String(ro["key"]), v["state"] === "known" ? v["value"] : undefined);
    }
    const dataRounding = checkDataRounding(obj(input.dataFiles.get(String(entry.rs["data"]))), String(entry.rs["data"]), new Problems());
    const lastAfter = new Map<string, unknown>();
    arr(o["rounding"]).forEach((r, i) => {
      const ro = obj(r);
      const rw = `${w} rounding[${i}]`;
      const item = String(ro["itemKey"]);
      if (values.get(item) === undefined) problems.add(rw, "値がknownでない項目の丸め");
      if (ro["basis"] === "rule" && !dataRounding.has(`${item}|${String(ro["method"])}|${String(ro["unit"])}`)) problems.add(rw, "制度データのroundingにない丸め（項目・方法・単位）");
      if (!("before" in ro) || !("after" in ro)) {
        problems.add(rw, "丸めの記録にbefore・afterがない（計算し直せる形にする）");
        return;
      }
      const prevAfter = lastAfter.get(item);
      if (prevAfter !== undefined && !decEquals(prevAfter, ro["before"])) problems.add(rw, "同じ項目の手順がつながっていない（beforeが直前のafterと違う）");
      const again = roundTo(String(ro["before"]), String(ro["unit"]), String(ro["method"]));
      if (again === undefined || !decEquals(again, ro["after"])) problems.add(rw, `afterが、beforeを丸め直した値（${String(again)}）と違う`);
      lastAfter.set(item, ro["after"]);
    });
    for (const [item, after] of lastAfter) if (!decEquals(after, values.get(item))) problems.add(w, `${item}の値が最後の丸めのafterと違う`);
  });
  for (const [key, e] of ruleSets) for (const s of arr(e.rs["sources"])) if (typeof s === "string" && !e.used.has(s)) problems.add(`manifest ${key}`, `sourcesの資料（${s}）を制度データも制度のケースも参照していない`);
  return problems.list;
}

// ---- 読み込み

function readRepoJson(path: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"));
}

export function readRulesInput(): RulesInput {
  const manifest = readRepoJson(MANIFEST_PATH);
  const dataFiles = new Map<string, unknown>();
  for (const rs of arr(obj(manifest)["ruleSets"])) {
    const p = obj(rs)["data"];
    if (typeof p === "string" && existsSync(join(REPO_ROOT, p))) dataFiles.set(p, readRepoJson(p));
  }
  return { manifest, dataFiles, fileExists: (p) => existsSync(join(REPO_ROOT, p)), regimeCases: readRepoJson(REGIME_CASES_PATH) };
}

const INPUT = readRulesInput();

function mutated(change: (copy: { manifest: Obj; data: Map<string, Obj>; cases: Obj[] }) => void): string[] {
  const manifest = structuredClone(INPUT.manifest) as Obj;
  const data = new Map<string, Obj>();
  for (const [k, v] of INPUT.dataFiles) data.set(k, structuredClone(v) as Obj);
  const regimeCases = structuredClone(INPUT.regimeCases) as Obj;
  const cases = arr(regimeCases["cases"]).map(obj);
  change({ manifest, data, cases });
  return validateRules({ manifest, dataFiles: data, fileExists: INPUT.fileExists, regimeCases });
}

function ruleSetOf(manifest: Obj, id: string): Obj {
  const rs = arr(manifest["ruleSets"]).map(obj).find((r) => r["id"] === id);
  assert.ok(rs, id);
  return rs;
}

function caseOf(cases: Obj[], id: string): Obj {
  const c = cases.find((x) => x["caseId"] === id);
  assert.ok(c, id);
  return c;
}

// ---- 試験

test("制度の規則・制度データ・制度のケースは、形と相互の整合の検査を満たす", () => {
  assert.deepEqual(validateRules(INPUT), []);
});

test("丸め直し: 契約の4つの丸め方（負の数とちょうど中間を含む）", () => {
  const cases: [string, string, string, string][] = [
    ["12345.6", "1", "floor", "12345"],
    ["12345", "100", "floor", "12300"],
    ["4049", "1000", "floor", "4000"],
    ["2856.5", "1", "half-down", "2856"],
    ["-2856.5", "1", "half-down", "-2856"],
    ["2856.6", "1", "half-down", "2857"],
    ["2856.5", "1", "half-up", "2857"],
    ["-2856.5", "1", "half-up", "-2857"],
    ["62345.7", "1", "ceil", "62346"],
    ["-1.5", "1", "floor", "-2"],
    ["-1.5", "1", "ceil", "-1"],
    ["190110.2", "100", "floor", "190100"],
    ["0.25", "0.1", "half-up", "0.3"],
  ];
  for (const [before, unit, method, after] of cases) assert.equal(roundTo(before, unit, method), after, `${before} ${method} ${unit}`);
  assert.equal(roundTo("1", "0", "floor"), undefined);
});

test("地域の符号: 全国地方公共団体コードの検査数字（仕様の算出例）", () => {
  assert.equal(localGovernmentCheckDigit("16201"), 9);
  // 仕様の（注）①: 余り数字が0のとき検査数字は1（11−0の下1桁）。②: 余りが1のとき0、③: 余りが10のとき1。
  assert.equal(localGovernmentCheckDigit("11000"), 1);
  const p = new Problems();
  checkJurisdiction({ kind: "municipality", code: "162019" }, "x", p);
  checkJurisdiction({ kind: "prefecture", code: "130001" }, "x", p);
  checkJurisdiction({ kind: "national", code: "JP" }, "x", p);
  assert.deepEqual(p.list, []);
  for (const [j, word] of [
    [{ kind: "municipality", code: "162010" }, "検査数字"],
    [{ kind: "municipality", code: "130001" }, "000ではない"],
    [{ kind: "prefecture", code: "162019" }, "000"],
    [{ kind: "prefecture", code: "480001" }, "01〜47"],
    [{ kind: "national", code: "jp" }, "JP"],
    [{ kind: "insurer", code: "01130012" }, "未確認"],
  ] as const) {
    const q = new Problems();
    checkJurisdiction(j, "x", q);
    assert.ok(q.list.some((x) => x.includes(word)), `${JSON.stringify(j)}: ${q.list.join(" / ")}`);
  }
});

test("年齢: 誕生日の前日に1つ加わる（1月1日生まれは前の年の12月31日に加わる）", () => {
  assert.equal(ageOn("2008-01-01", "2026-12-31"), 19);
  assert.equal(ageOn("2008-01-02", "2026-12-31"), 18);
  assert.equal(ageOn("2004-01-02", "2026-12-31"), 22);
  assert.equal(ageOn("2004-01-01", "2026-12-31"), 23);
});

test("検査の自己確認: 制度データの写し誤り（表の行・速算表・基礎控除・生年月日の範囲・資料の括弧書き）を見つける", () => {
  const checks: [string, (c: { manifest: Obj; data: Map<string, Obj>; cases: Obj[] }) => void, string][] = [
    ["表から写した行の値", (c) => ((obj(c.data.get("rules/income-tax/jp-2026.json")?.["employmentIncome"])["rowsTranscribed"] as Obj[])[0]!["value"] = 1452000), "表から写した行"],
    ["表の範囲の率", (c) => ((obj(c.data.get("rules/income-tax/jp-2025.json")?.["employmentIncome"])["ranges"] as Obj[])[3]!["rate"] = "0.79"), "表から写した行"],
    ["速算表の控除額", (c) => ((obj(c.data.get("rules/income-tax/jp-2026.json")?.["taxRates"])["brackets"] as Obj[])[2]!["quickDeduction"] = 427000), "連続しない"],
    ["基礎控除の加算額", (c) => ((obj(c.data.get("rules/income-tax/jp-2025.json")?.["basicDeduction"])["brackets"] as Obj[])[1]!["addition"] = 310000), "加算額"],
    ["特定扶養親族の生年月日の範囲", (c) => ((obj(c.data.get("rules/income-tax/jp-2026.json")?.["dependentDeduction"])["categories"] as Obj[])[1]!["bornTo"] = "2007-12-31"), "生年月日の範囲"],
    ["資料の括弧書きの収入金額", (c) => ((obj(obj(c.data.get("rules/income-tax/jp-2026.json")?.["employmentIncome"])["salaryOnlyThresholdsCrossCheck"])["rows"] as Obj[])[2]!["salaryRevenueMax"] = 6655557), "括弧書き"],
    ["範囲の切れ目", (c) => ((obj(c.data.get("rules/income-tax/jp-2026.json")?.["employmentIncome"])["ranges"] as Obj[])[2]!["from"] = 2192000), "続かない"],
  ];
  for (const [name, change, word] of checks) {
    const p = mutated(change);
    assert.ok(p.some((x) => x.includes(word)), `${name}: ${p.join(" / ") || "見つからない"}`);
  }
});

test("検査の自己確認: 一次資料の項目と原典の参照の誤りを見つける", () => {
  const checks: [string, (c: { manifest: Obj; data: Map<string, Obj>; cases: Obj[] }) => void, string][] = [
    ["更新日が取得日より後", (c) => ((c.manifest["sources"] as Obj[])[0]!["documentUpdatedOn"] = "2026-10-04"), "取得日より後"],
    ["更新日の決め方がない", (c) => delete (c.manifest["sources"] as Obj[])[0]!["documentDateBasis"], "documentDateBasis"],
    ["httpでないURL", (c) => ((c.manifest["sources"] as Obj[])[0]!["url"] = "http://www.nta.go.jp/x"), "https"],
    ["制度データの原典が規則のsourcesにない", (c) => (obj(c.data.get("rules/income-tax/jp-2025.json")?.["taxRates"])["source"] = { ref: "nta-nencho2026-rates", location: "x" }), "規則のsourcesにない"],
    ["原典の箇所がない", (c) => (obj(c.data.get("rules/income-tax/jp-2025.json")?.["taxRates"])["source"] = { ref: "nta-ta-2260" }), "location"],
    ["使われない資料", (c) => (c.manifest["sources"] as Obj[]).push({ ...(c.manifest["sources"] as Obj[])[0]!, id: "x-unused", url: "https://www.nta.go.jp/unused" }), "どの規則のsourcesにもない"],
    ["制度データの状態がmanifestと違う", (c) => (c.data.get("rules/income-tax/jp-2026.json")!["status"] = "approved"), "manifestと違う"],
  ];
  for (const [name, change, word] of checks) {
    const p = mutated(change);
    assert.ok(p.some((x) => x.includes(word)), `${name}: ${p.join(" / ") || "見つからない"}`);
  }
});

test("検査の自己確認: 規則の適用の範囲の重なりと、制度のケースの規則・状態・丸めの誤りを見つける", () => {
  const checks: [string, (c: { manifest: Obj; data: Map<string, Obj>; cases: Obj[] }) => void, string][] = [
    [
      "別の規則と範囲が重なる",
      (c) => {
        const copy = structuredClone(ruleSetOf(c.manifest, "jp-income-tax-salary-2026"));
        copy["id"] = "jp-income-tax-salary-2026-other";
        (c.manifest["ruleSets"] as Obj[]).push(copy);
      },
      "重なる",
    ],
    ["ケースの規則がない", (c) => (caseOf(c.cases, "REG-02")["ruleSet"] = { id: "jp-income-tax-salary-2026", version: "2" }), "manifestにない"],
    ["draftの規則でapprovedのケース", (c) => (caseOf(c.cases, "REG-02")["status"] = "approved"), "承認済み"],
    ["targetが規則の範囲の外", (c) => (obj(caseOf(c.cases, "REG-02")["target"])["referencePoint"] = { kind: "date", date: "2026-11-30" }), "適用の範囲"],
    ["unsupportedのケースに当たる規則がある", (c) => (obj(caseOf(c.cases, "REG-15")["target"])["referencePoint"] = { kind: "date", date: "2026-12-01" }), "入力も未対応の条件"],
    ["丸め直した値と違う", (c) => ((caseOf(c.cases, "REG-02")["rounding"] as Obj[])[1]!["after"] = "73400"), "丸め直した値"],
    ["最後の丸めと値が違う", (c) => (obj(((obj(caseOf(c.cases, "REG-03")["expected"])["results"] as Obj[]).find((r) => r["key"] === "reconstruction-tax"))!["value"])["value"] = 1781), "最後の丸め"],
    ["制度データにない丸め", (c) => ((caseOf(c.cases, "REG-02")["rounding"] as Obj[])[0]!["unit"] = "100"), "制度データのroundingにない"],
    ["原典がmanifestと違う", (c) => ((caseOf(c.cases, "REG-02")["sources"] as Obj[])[0]!["retrievedOn"] = "2026-10-02"), "manifestの資料"],
    ["期待する結果の状態がない", (c) => delete obj(caseOf(c.cases, "REG-02")["expected"])["status"], "expected.status"],
  ];
  for (const [name, change, word] of checks) {
    const p = mutated(change);
    assert.ok(p.some((x) => x.includes(word)), `${name}: ${p.join(" / ") || "見つからない"}`);
  }
});

const MAPPING = "rules/withholding-slip-mapping/v1.json";
const mapField = (c: { data: Map<string, Obj> }, i: number): Obj => obj(arr(c.data.get(MAPPING)?.["fields"])[i]);
const variant = (c: { data: Map<string, Obj> }, f: number, v: number): Obj => obj(arr(mapField(c, f)["variants"])[v]);
const term = (c: { data: Map<string, Obj> }, f: number, v: number, t: number): Obj => obj(arr(obj(variant(c, f, v)["mapping"])["terms"])[t]);

test("検査の自己確認: 入力による未対応、家族の控除の適用要件、特定親族の年齢、帰属の例、承認の証跡の誤りを見つける（PR29-R001〜R011）", () => {
  type C = { manifest: Obj; data: Map<string, Obj>; cases: Obj[] };
  const input = (c: C, id: string): Obj => obj(caseOf(c.cases, id)["input"]);
  const approved = (c: C, approval: unknown): void => {
    const rs = ruleSetOf(c.manifest, "jp-income-tax-salary-2026");
    rs["status"] = "approved";
    rs["approval"] = approval;
    c.data.get("rules/income-tax/jp-2026.json")!["status"] = "approved";
  };
  const goodApproval = { reviewRecord: "https://github.com/doc-gif/kurashi-ledger/pull/29#pullrequestreview-1", reviewedHead: "0".repeat(40), approvalPullRequest: "https://github.com/doc-gif/kurashi-ledger/pull/30" };
  const checks: [string, (c: C) => void, string][] = [
    ["入力による未対応の例が、未対応の条件に当たらない", (c) => (input(c, "REG-21")["taxpayerEvent"] = { kind: "none" }) && (input(c, "REG-21")["returnKind"] = "regular"), "入力も未対応の条件"],
    ["計算するケースの入力が未対応の条件に当たる", (c) => (input(c, "REG-02")["taxpayerEvent"] = { kind: "death", date: "2026-12-05" }), "未対応の条件に当たるのに"],
    ["家族が年の中途で死亡したのに計算する", (c) => (obj(arr(input(c, "REG-11")["relatives"])[0])["livingAtYearEnd"] = false), "未対応の条件に当たるのに"],
    ["家族の適用要件の入力がない", (c) => delete obj(arr(input(c, "REG-19")["relatives"])[0])["businessFamilyEmployee"], "relatives[0].businessFamilyEmployee（specificRelativeDeductionの判定）"],
    ["特定親族の(8)の入力がない", (c) => delete obj(arr(input(c, "REG-19")["relatives"])[0])["relativeDeclaredSourceDeductionRelativeAndWithheld"], "relatives[0].relativeDeclaredSourceDeductionRelativeAndWithheld（specificRelativeDeductionの判定）"],
    ["配偶者の(3)の入力がない", (c) => delete obj(input(c, "REG-24")["spouse"])["spouseAppliesSpecialDeduction"], "spouse.spouseAppliesSpecialDeduction（spouseSpecialDeductionの判定）"],
    ["必須の入力taxpayerEventがない", (c) => delete input(c, "REG-02")["taxpayerEvent"], "taxpayerEvent.kind（必須の入力）"],
    ["確定申告の必須の入力returnKindがない", (c) => delete input(c, "REG-17")["returnKind"], "returnKind（必須の入力）"],
    ["必須の入力residencyがない", (c) => delete input(c, "REG-02")["residency"], "residency（必須の入力）"],
    ["必須の入力incomeSourcesがない", (c) => delete input(c, "REG-03")["incomeSources"], "incomeSources（必須の入力）"],
    ["必須の入力taxCreditsがない", (c) => delete input(c, "REG-12")["taxCredits"], "taxCredits（必須の入力）"],
    ["必須の入力taxCreditsがnull", (c) => (input(c, "REG-12")["taxCredits"] = null), "taxCredits（必須の入力）"],
    ["配偶者の項目そのものがない（nullとは違う）", (c) => delete input(c, "REG-02")["spouse"], "spouse（必須の入力）"],
    ["納税者の(9)の入力がない", (c) => delete obj(input(c, "REG-19")["taxpayer"])["declaredAsSourceDeductionRelativeByOtherAndWithheld"], "taxpayer.declaredAsSourceDeductionRelativeByOtherAndWithheld（specificRelativeDeductionの判定）"],
    ["計算の規則に必須の入力の定義がない", (c) => delete ruleSetOf(c.manifest, "jp-income-tax-salary-2025")["requiredInputs"], "requiredInputs"],
    ["一般の扶養親族の区分のageMinがない", (c) => delete obj(arr(obj(c.data.get("rules/income-tax/jp-2026.json")?.["dependentDeduction"])["categories"])[0])["ageMin"], "年齢の範囲の形"],
    ["老人扶養親族の区分のageMinが整数でない", (c) => (obj(arr(obj(c.data.get("rules/income-tax/jp-2025.json")?.["dependentDeduction"])["categories"])[2])["ageMin"] = "70"), "年齢の範囲の形"],
    ["老人扶養親族の区分の生年月日の境界がない", (c) => delete obj(arr(obj(c.data.get("rules/income-tax/jp-2026.json")?.["dependentDeduction"])["categories"])[3])["bornOnOrBefore"], "年齢の範囲の形"],
    ["特定扶養親族のageBelowが整数でない", (c) => (obj(arr(obj(c.data.get("rules/income-tax/jp-2026.json")?.["dependentDeduction"])["categories"])[1])["ageBelow"] = 22.5), "年齢の範囲の形"],
    ["特定親族特別控除のageBelowがない", (c) => delete obj(c.data.get("rules/income-tax/jp-2025.json")?.["specificRelativeDeduction"])["ageBelow"], "年齢の範囲の形"],
    ["同居老親等の区分の条件がない", (c) => delete obj(arr(obj(c.data.get("rules/income-tax/jp-2026.json")?.["dependentDeduction"])["categories"])[3])["requires"], "排他に決まらない"],
    ["対応表の明細の項目の誤記", (c) => (term(c, 0, 0, 0)["item"] = "taxablepay"), "給与明細の金額の項目にない"],
    ["対応表の年間資料の項目の誤記", (c) => (mapField(c, 2)["field"] = "socialInsurance"), "年間資料の金額の項目にない"],
    ["対応表の条件の重なり", (c) => (variant(c, 1, 2)["yearEndAdjustmentStatus"] = ["adjusted", "not-stated", "unknown"]), "条件が重なる"],
    ["対応表の条件の抜け", (c) => (variant(c, 1, 2)["yearEndAdjustmentStatus"] = ["not-stated"]), "条件が抜けている: unknown"],
    ["対応表の符号", (c) => (term(c, 1, 1, 1)["sign"] = 2), "signは1か-1"],
    ["対応表の種類", (c) => (obj(variant(c, 3, 0)["mapping"])["kind"] = "difference"), "mapping.kind"],
    ["親族の所属が分からないのに計算する", (c) => (obj(arr(input(c, "REG-11")["relatives"])[0])["dependentClaimedByOtherTaxpayer"] = "unknown"), "dependentClaimedByOtherTaxpayer"],
    ["850万円超で所得金額調整控除の対象かが分からないのに計算する", (c) => (input(c, "REG-16")["incomeAdjustmentEligible"] = "unknown"), "incomeAdjustmentEligible（必須の入力）"],
    ["生年月日が日付でない", (c) => (obj(arr(input(c, "REG-11")["relatives"])[0])["birthDate"] = "not-a-date"), "birthDate（型か値が正しくない"],
    ["合計所得金額が文字列", (c) => (obj(arr(input(c, "REG-20")["relatives"])[0])["totalIncome"] = "580000"), "totalIncome（型か値が正しくない"],
    ["合計所得金額が負", (c) => (obj(input(c, "REG-11")["spouse"])["totalIncome"] = -1), "totalIncome（型か値が正しくない"],
    ["生計一が真偽値でない", (c) => (obj(arr(input(c, "REG-19")["relatives"])[0])["sameHousehold"] = "yes"), "sameHousehold（型か値が正しくない"],
    ["関係が列挙にない", (c) => (obj(arr(input(c, "REG-19")["relatives"])[0])["relationship"] = "cousin"), "relationship（型か値が正しくない"],
    ["生存が真偽値でない", (c) => (obj(arr(input(c, "REG-11")["relatives"])[1])["livingAtYearEnd"] = 1), "livingAtYearEnd（型か値が正しくない"],
    ["納税者の(9)が真偽値でない", (c) => (obj(input(c, "REG-26")["taxpayer"])["declaredAsSourceDeductionRelativeByOtherAndWithheld"] = "no"), "taxpayer.declaredAsSourceDeductionRelativeByOtherAndWithheld（真偽値か"],
    ["配偶者の(4)が真偽値でない", (c) => (obj(input(c, "REG-24")["spouse"])["spouseWithheldViaSalaryDeclaration"] = "true"), "spouseWithheldViaSalaryDeclaration（型か値が正しくない"],
    ["親族の並びにobjectでない要素", (c) => arr(input(c, "REG-19")["relatives"]).push("x"), "relatives（objectの並びかunknown）"],
    ["関係の許す値の範囲がない", (c) => delete obj(arr(obj(c.data.get("rules/income-tax/jp-2026.json")?.["dependentDeduction"])["eligibility"])[0])["domain"], "domain）がない"],
    ["合計所得金額がnull", (c) => (obj(arr(input(c, "REG-19")["relatives"])[1])["totalIncome"] = null), "totalIncome（型か値が正しくない"],
    ["真偽の要件が文字列false", (c) => (obj(arr(input(c, "REG-22")["relatives"])[0])["businessFamilyEmployee"] = "false"), "businessFamilyEmployee（型か値が正しくない"],
    ["特定親族の所属の入力がない", (c) => delete obj(arr(input(c, "REG-19")["relatives"])[0])["specificRelativeClaimedAsSpecificRelativeByOther"], "relatives[0].specificRelativeClaimedAsSpecificRelativeByOther（specificRelativeDeductionの判定）"],
    ["特定親族の所属が分からないのに計算する", (c) => (obj(arr(input(c, "REG-19")["relatives"])[0])["specificRelativeClaimedAsSpouseByOther"] = "unknown"), "specificRelativeClaimedAsSpouseByOther"],
    ["配偶者の特定親族としての所属が分からないのに計算する", (c) => (obj(input(c, "REG-24")["spouse"])["spouseClaimedAsSpecificRelativeByOther"] = "unknown"), "spouseClaimedAsSpecificRelativeByOther"],
    ["給与等の収入金額が文字列", (c) => (input(c, "REG-16")["salaryRevenue"] = "9123457"), "salaryRevenue（型か値が正しくない"],
    ["源泉徴収税額が負", (c) => (input(c, "REG-03")["withheldTax"] = -1), "withheldTax（型か値が正しくない"],
    ["所得金額調整控除の対象かが文字列", (c) => (input(c, "REG-16")["incomeAdjustmentEligible"] = "true"), "incomeAdjustmentEligible（型か値が正しくない"],
    ["居住者の区分が列挙にない", (c) => (input(c, "REG-02")["residency"] = "domestic"), "residency（型か値が正しくない"],
    ["確定申告の確定申告だけの控除がない", (c) => delete input(c, "REG-17")["returnOnlyDeductions"], "returnOnlyDeductions（必須の入力）"],
    ["年末調整に確定申告だけの控除がある", (c) => (input(c, "REG-02")["returnOnlyDeductions"] = 120000), "未対応の条件に当たるのに"],
    ["必須の入力の型の定義がない", (c) => delete obj(arr(ruleSetOf(c.manifest, "jp-income-tax-salary-2026")["requiredInputs"])[0])["type"], "requiredInputs"],
    // 年末調整の対象者の条件（PR29-R011。タックスアンサーNo.2665）
    ["年末調整の給与の上限を超えるのに計算する", (c) => (input(c, "REG-32")["salaryRevenue"] = 20000001), "未対応の条件に当たるのに"],
    ["上限の未対応の例が上限ちょうど", (c) => (input(c, "REG-33")["salaryRevenue"] = 20000000), "入力も未対応の条件"],
    ["扶養控除等申告書を提出していないのに計算する", (c) => (obj(input(c, "REG-02")["yearEndAdjustment"])["dependentDeclarationSubmitted"] = false), "未対応の条件に当たるのに"],
    ["年の中途の退職者を年末調整で計算する", (c) => (obj(input(c, "REG-09")["yearEndAdjustment"])["employedAtYearEnd"] = false), "未対応の条件に当たるのに"],
    ["災害減免法の徴収猶予を受けたのに計算する", (c) => (obj(input(c, "REG-13")["yearEndAdjustment"])["disasterReliefWithholding"] = true), "未対応の条件に当たるのに"],
    ["年末調整の対象者の条件の入力がない", (c) => delete input(c, "REG-02")["yearEndAdjustment"], "yearEndAdjustment.dependentDeclarationSubmitted（必須の入力）"],
    ["年末調整の対象者の条件の入力が真偽値でない", (c) => (obj(input(c, "REG-02")["yearEndAdjustment"])["employedAtYearEnd"] = "yes"), "yearEndAdjustment.employedAtYearEnd（型か値が正しくない"],
    ["給与の上限を確定申告にも当てる", (c) => delete obj(arr(ruleSetOf(c.manifest, "jp-income-tax-salary-2025")["unsupportedInputs"]).map(obj).find((u) => u["yearEndAdjustmentCondition"] === "salary-total-max"))["procedures"], "proceduresがyear-end-adjustmentだけ"],
    ["給与の上限を確定申告にも当てると、確定申告の境界の例が未対応になる", (c) => delete obj(arr(ruleSetOf(c.manifest, "jp-income-tax-salary-2025")["unsupportedInputs"]).map(obj).find((u) => u["yearEndAdjustmentCondition"] === "salary-total-max"))["procedures"], "REG-34: 入力が規則の未対応の条件に当たるのに"],
    ["manifestの給与の上限が制度データと違う", (c) => (obj(arr(ruleSetOf(c.manifest, "jp-income-tax-salary-2026")["unsupportedInputs"]).map(obj).find((u) => u["yearEndAdjustmentCondition"] === "salary-total-max"))["max"] = 19999999), "上限が、unsupportedInputsのmaxと"],
    ["制度データの給与の上限だけを変える", (c) => (obj(c.data.get("rules/income-tax/jp-2025.json")?.["yearEndAdjustmentLimits"])["salaryRevenueMax"] = 25000000), "上限が、unsupportedInputsのmaxと"],
    ["課税給与所得金額の上限が給与の上限と合わない", (c) => (obj(c.data.get("rules/income-tax/jp-2026.json")?.["yearEndAdjustmentLimits"])["taxableIncomeMax"] = 18000000), "taxableIncomeMaxが"],
    ["対象者の条件にunsupportedInputsがない", (c) => (ruleSetOf(c.manifest, "jp-income-tax-salary-2026")["unsupportedInputs"] = arr(ruleSetOf(c.manifest, "jp-income-tax-salary-2026")["unsupportedInputs"]).filter((u) => obj(u)["yearEndAdjustmentCondition"] !== "disaster-relief")), "（disaster-relief）に対応するunsupportedInputsが1つでない"],
    ["unsupportedInputsの条件が対象者の条件にない", (c) => (obj(arr(ruleSetOf(c.manifest, "jp-income-tax-salary-2025")["unsupportedInputs"]).map(obj).find((u) => u["yearEndAdjustmentCondition"] === "disaster-relief"))["yearEndAdjustmentCondition"] = "disaster"), "targetConditionsにない"],
    ["対象者の条件の許す値が違う", (c) => (obj(arr(ruleSetOf(c.manifest, "jp-income-tax-salary-2025")["unsupportedInputs"]).map(obj).find((u) => u["yearEndAdjustmentCondition"] === "dependent-declaration"))["allowed"] = [true, false]), "許す値が、unsupportedInputsのallowedと違う"],
    ["対象者の条件の入力が必須でない", (c) => (ruleSetOf(c.manifest, "jp-income-tax-salary-2026")["requiredInputs"] = arr(ruleSetOf(c.manifest, "jp-income-tax-salary-2026")["requiredInputs"]).filter((r) => obj(r)["path"] !== "yearEndAdjustment.employedAtYearEnd")), "必須の入力（requiredInputs）にない"],
    ["対象者の条件がない", (c) => delete obj(c.data.get("rules/income-tax/jp-2026.json")?.["yearEndAdjustmentLimits"])["targetConditions"], "targetConditions（年末調整の対象者の条件）がない"],
    ["未対応の条件に許す値も上限もない", (c) => delete obj(arr(ruleSetOf(c.manifest, "jp-income-tax-salary-2025")["unsupportedInputs"])[0])["allowed"], "allowed（許す値の列挙）かmax"],
    // 検証の責務(b): 存在する入力の形は、unsupportedのケースでも確かめる（PR29-R010の残り、Copilot 4173206315）
    ["施行日前で未対応のケースの給与等の収入金額が文字列", (c) => (input(c, "REG-15")["salaryRevenue"] = "4500000"), "REG-15: input.salaryRevenue（型か値が正しくない"],
    ["入力で未対応のケースの家族の生年月日が日付でない", (c) => (obj(arr(input(c, "REG-21")["relatives"])[0])["birthDate"] = "2008-13-40"), "REG-21: input.relatives[0].birthDate（型か値が正しくない"],
    ["年末調整の対象外のケースの源泉徴収税額がnull", (c) => (input(c, "REG-33")["withheldTax"] = null), "REG-33: input.withheldTax（型か値が正しくない"],
    ["死亡の日付が日付でない", (c) => (obj(input(c, "REG-21")["taxpayerEvent"])["date"] = "12月10日"), "REG-21: input.taxpayerEvent.date（型か値が正しくない"],
    ["宣言にない入力", (c) => (input(c, "REG-02")["bonusRevenue"] = 100000), "REG-02: input.bonusRevenue（manifestの"],
    ["宣言にない入れ子の入力", (c) => (obj(input(c, "REG-36")["yearEndAdjustment"])["submittedLate"] = true), "REG-36: input.yearEndAdjustment.submittedLate（manifestにない入力）"],
    ["年間資料の支払金額が文字列", (c) => (obj(arr(input(c, "REG-03")["annualValues"])[0])["paymentAmount"] = "3200000"), "REG-03: input.annualValues[0]（"],
    ["前職分を通算した資料と前職の資料の両方を採用する", (c) => (obj(arr(input(c, "REG-17")["annualValues"])[0])["adopted"] = true), "REG-17: input.annualValues（ann-d）: 支払者勤務先Cを、採用した資料ann-cと重ねて数える"],
    // 年間資料の採用の範囲（PR29-R002、Copilot 4173508058）: 合計まで合わせた重複、範囲が分からない資料の採用、採用しない資料の落とし、採用が要判断のままの計算
    [
      "前職分を二重に数え、合計も重複に合わせる",
      (c) => {
        obj(arr(input(c, "REG-17")["annualValues"])[0])["adopted"] = true;
        Object.assign(input(c, "REG-17"), { salaryRevenue: 4000000, withheldTax: 53000, socialInsuranceDeduction: 602318 });
      },
      "REG-17: input.annualValues（ann-d）: 支払者勤務先Cを、採用した資料ann-cと重ねて数える",
    ],
    ["範囲が分からない資料を採用する", (c) => arr(input(c, "REG-18")["annualValues"]).forEach((d, i) => (obj(d)["adopted"] = i === 1)), "REG-18: input.annualValues（ann-f）: 範囲（includedOtherPayers）が確定しない資料を採用している"],
    ["採用しない資料の分を落とす", (c) => (obj(arr(input(c, "REG-03")["annualValues"])[1])["adopted"] = false), "REG-03: input.annualValues（ann-b）: 採用しない資料の支払者が、採用したどの資料の範囲にも含まれない"],
    ["採用が要判断の資料を残して計算する", (c) => (obj(arr(input(c, "REG-17")["annualValues"])[0])["adopted"] = "adoption-needed"), "REG-17: 分からない入力があるのにcomputed: annualValues（採用が要判断の資料がある）"],
    // 粗探しF1〜F3・F5・F8（2026-10-04）
    ["採用が要判断なのに年間の値を既知にする", (c) => (input(c, "REG-18")["salaryRevenue"] = 4000000), "REG-18: input.salaryRevenue（採用が要判断の資料か"],
    ["採用しない資料の一部だけを範囲に含める", (c) => (obj(arr(obj(arr(input(c, "REG-17")["annualValues"])[1])["includedOtherPayers"])[0])["paymentAmount"] = 800000), "REG-17: input.annualValues（ann-c）: 採用した資料ann-dの範囲に含まれる金額が、この資料の金額と違う（一部だけの包含）"],
    ["明細の支払者が源泉徴収票でも覆われる", (c) => (obj(arr(input(c, "REG-62")["payslipDerivedValues"])[0])["payer"] = "勤務先A"), "REG-62: input.payslipDerivedValues[0]: 支払者勤務先Aは源泉徴収票（の範囲）にもあり、重ねて数える"],
    ["明細の支払者が採用した資料の範囲に含まれる", (c) => (obj(arr(input(c, "REG-62")["annualValues"])[0])["includedOtherPayers"] = [{ payer: "勤務先B", paymentAmount: 1450000, withholdingTax: 28331, socialInsurancePremiums: 222115 }]), "REG-62: input.payslipDerivedValues[0]: 支払者勤務先Bは源泉徴収票（の範囲）にもあり"],
    ["混在の合計が給与等の収入金額と違う", (c) => (input(c, "REG-62")["salaryRevenue"] = 3200000), "REG-62: input.annualValues・payslipDerivedValues（採用した資料と明細のpaymentAmountの合計4650000がsalaryRevenueと違う）"],
    ["明細の金額が分からないのに給与等の収入金額を既知にする", (c) => (input(c, "REG-63")["salaryRevenue"] = 4650000), "REG-63: input.salaryRevenue（採用が要判断の資料か"],
    ["明細から示す値の金額が文字列", (c) => (obj(arr(input(c, "REG-62")["payslipDerivedValues"])[0])["withholdingTax"] = "28331"), "REG-62: input.payslipDerivedValues[0]（"],
    ["適用対象の必須の入力が欠けたのに結果をknownにする", (c) => delete input(c, "REG-23")["residency"], "REG-23: expected.results（employment-income）: 入力から確定できないのにknown"],
    // 確認の粗探しN1〜N3（2026-10-04）
    ["明細から示す値を使うのにcomputed", (c) => (obj(caseOf(c.cases, "REG-62")["expected"])["status"] = "computed"), "REG-62: 明細から示す値（payslipDerivedValues）を使うrunはprovisional"],
    ["資料の社会保険料を二重に数える", (c) => (input(c, "REG-17")["socialInsuranceDeduction"] = 602318), "REG-17: input.annualValues・payslipDerivedValues（採用した資料と明細のsocialInsurancePremiumsの合計と確定申告で足す額の和452318がsocialInsuranceDeductionと違う）"],
    ["確定申告で足す社会保険料等の額がない", (c) => delete input(c, "REG-03")["socialInsuranceAdditional"], "REG-03: input.socialInsuranceAdditional（年間資料か明細から示す値があるときは"],
    ["確定申告で足す額が分からないのに社会保険料控除額を既知にする", (c) => (input(c, "REG-62")["socialInsuranceAdditional"] = "unknown"), "REG-62: input.socialInsuranceDeduction（採用が要判断の資料か"],
    ["家族の一人の適用対象が分からないのに、ほかの結果をunknownにする", (c) => (obj(arr(obj(caseOf(c.cases, "REG-66")["expected"])["results"])[0])["value"] = { state: "unknown" }), "REG-66: expected.results（employment-income）: 入力から確定できるのにunknown"],
    ["家族の一人の適用対象が分からないのに、その控除をknownにする", (c) => (obj(arr(obj(caseOf(c.cases, "REG-66")["expected"])["results"])[3])["value"] = { state: "known", value: 380000 }), "REG-66: expected.results（spouse-deduction）: 入力から確定できないのにknown"],
    ["配偶者がいるか分からないのに計算する", (c) => (input(c, "REG-02")["spouse"] = "unknown"), "REG-02: 分からない入力があるのにcomputed: spouse（必須の入力）"],
    ["配偶者がいるか分からないのに配偶者控除をknownにする", (c) => (obj(arr(obj(caseOf(c.cases, "REG-64")["expected"])["results"])[3])["value"] = { state: "known", value: 0 }), "REG-64: expected.results（spouse-deduction）: 入力から確定できないのにknown"],
    ["親族の構成が分からないのに扶養控除をknownにする", (c) => (obj(arr(obj(caseOf(c.cases, "REG-65")["expected"])["results"])[5])["value"] = { state: "known", value: 0 }), "REG-65: expected.results（dependent-deduction）: 入力から確定できないのにknown"],
    ["配偶者の値が列挙にない", (c) => (input(c, "REG-64")["spouse"] = "none"), "REG-64: input.spouse（objectかnullかunknown）"],
    // 結果を確定できるか（PR29-R006の残り、Copilot 4173508041）
    ["確定できる所得金額調整控除をunknownにする", (c) => (obj(arr(obj(caseOf(c.cases, "REG-18")["expected"])["results"])[1])["value"] = { state: "unknown" }), "REG-18: expected.results（income-adjustment-deduction）: 入力から確定できるのにunknown"],
    ["親族がいないのに扶養控除をunknownにする", (c) => (obj(arr(obj(caseOf(c.cases, "REG-18")["expected"])["results"])[5])["value"] = { state: "unknown" }), "REG-18: expected.results（dependent-deduction）: 入力から確定できるのにunknown"],
    ["範囲の両端で同じ基礎控除をunknownにする", (c) => (obj(arr(obj(caseOf(c.cases, "REG-48")["expected"])["results"])[2])["value"] = { state: "unknown" }), "REG-48: expected.results（basic-deduction）: 入力から確定できるのにunknown"],
    ["決まらない扶養控除をknownにする", (c) => (obj(arr(obj(caseOf(c.cases, "REG-23")["expected"])["results"])[5])["value"] = { state: "known", value: 630000 }), "REG-23: expected.results（dependent-deduction）: 入力から確定できないのにknown"],
    ["給与等の収入金額が分からないのに給与所得控除後の金額をknownにする", (c) => (obj(arr(obj(caseOf(c.cases, "REG-18")["expected"])["results"])[0])["value"] = { state: "known", value: 2020000 }), "REG-18: expected.results（employment-income）: 入力から確定できないのにknown"],
    ["年間資料の採用が列挙にない", (c) => (obj(arr(input(c, "REG-18")["annualValues"])[1])["adopted"] = "maybe"), "REG-18: input.annualValues[1].adopted"],
    ["結果の項目が欠ける", (c) => arr(obj(caseOf(c.cases, "REG-12")["expected"])["results"]).pop(), "REG-12: expected.resultsの項目が"],
    ["unsupportedのケースの結果の項目が欠ける", (c) => arr(obj(caseOf(c.cases, "REG-15")["expected"])["results"]).shift(), "REG-15: expected.resultsの項目が"],
    ["結果の値が整数でない", (c) => (obj(obj(arr(obj(caseOf(c.cases, "REG-02")["expected"])["results"])[0])["value"])["value"] = "3160000"), "REG-02: expected.results（employment-income）"],
    ["規則がない", (c) => (c.manifest["ruleSets"] = []), "規則（ruleSets）がない"],
    // 制度データの表の形（PR29-R012、Copilot 4173206277）: 空・欠落・単独の最後の行・順序違反
    ["速算表が空", (c) => (obj(c.data.get("rules/income-tax/jp-2026.json")?.["taxRates"])["brackets"] = []), "taxRates.brackets: 表がない"],
    ["速算表がない", (c) => delete c.data.get("rules/income-tax/jp-2025.json")?.["taxRates"], "taxRates.brackets: 表がない"],
    ["速算表が率・控除額のない最後の行だけ", (c) => (obj(c.data.get("rules/income-tax/jp-2026.json")?.["taxRates"])["brackets"] = [{ taxableIncomeMax: null }]), "rateは0より大きく1以下"],
    ["速算表の最後の行の控除額がない", (c) => delete obj(arr(obj(c.data.get("rules/income-tax/jp-2026.json")?.["taxRates"])["brackets"]).at(-1))["quickDeduction"], "quickDeductionは0以上の整数"],
    ["速算表の上限の順序違反", (c) => (obj(arr(obj(c.data.get("rules/income-tax/jp-2025.json")?.["taxRates"])["brackets"])[2])["taxableIncomeMax"] = 1000), "taxableIncomeMaxは整数の昇順"],
    ["速算表の最後の行の上限がnullでない", (c) => (obj(arr(obj(c.data.get("rules/income-tax/jp-2025.json")?.["taxRates"])["brackets"]).at(-1))["taxableIncomeMax"] = 99999999000), "最後の行はnull"],
    ["速算表の最初の控除額が0でない", (c) => (obj(arr(obj(c.data.get("rules/income-tax/jp-2026.json")?.["taxRates"])["brackets"])[0])["quickDeduction"] = 1), "最初の段階の控除額は0"],
    ["基礎控除の表が空", (c) => (obj(c.data.get("rules/income-tax/jp-2026.json")?.["basicDeduction"])["brackets"] = []), "basicDeduction.brackets: 表がない"],
    ["配偶者特別控除の額の並びが列と合わない", (c) => (obj(arr(obj(c.data.get("rules/income-tax/jp-2026.json")?.["spouseSpecialDeduction"])["brackets"])[0])["amounts"] = [380000, 260000]), "amountsは0以上の整数の並び（3件）"],
    ["特定親族特別控除の区分がつながらない", (c) => (obj(arr(obj(c.data.get("rules/income-tax/jp-2025.json")?.["specificRelativeDeduction"])["brackets"])[3])["totalIncomeOver"] = 1), "totalIncomeOverが前の区分の上限"],
    ["配偶者控除の列が空", (c) => (obj(c.data.get("rules/income-tax/jp-2026.json")?.["spouseDeduction"])["byTaxpayerTotalIncome"] = []), "byTaxpayerTotalIncome: 表がない"],
    ["老人控除対象配偶者の生年月日の境界が1日ずれる", (c) => (obj(c.data.get("rules/income-tax/jp-2026.json")?.["spouseDeduction"])["elderlyBornOnOrBefore"] = "1957-01-02"), "spouseDeduction: 生年月日の範囲と年齢の下限が合わない"],
    ["扶養親族の区分が空", (c) => (obj(c.data.get("rules/income-tax/jp-2026.json")?.["dependentDeduction"])["categories"] = []), "categories）がない"],
    ["課税される所得金額の丸めがない", (c) => (c.data.get("rules/income-tax/jp-2025.json")!["rounding"] = arr(c.data.get("rules/income-tax/jp-2025.json")?.["rounding"]).filter((r) => obj(r)["item"] !== "taxable-income")), "丸めがない: taxable-income|floor|1000"],
    ["給与所得控除後の金額の範囲の定数がない", (c) => delete obj(arr(obj(c.data.get("rules/income-tax/jp-2026.json")?.["employmentIncome"])["ranges"]).at(-1))["constant"], "minusはconstant"],
    ["復興特別所得税の年調の率が1＋税率でない", (c) => (obj(c.data.get("rules/income-tax/jp-2026.json")?.["reconstructionSpecialIncomeTax"])["yearEndAdjustmentMultiplier"] = "1.21"), "yearEndAdjustmentMultiplier"],
    ["所得金額調整控除の率がない", (c) => delete obj(c.data.get("rules/income-tax/jp-2025.json")?.["incomeAdjustmentDeduction"])["rate"], "incomeAdjustmentDeduction: revenueOver"],
    // 検証の責務(c)（PR29-R006の残り、Copilot 4173206297）: 既知の適用可否は実際の額で使う
    ["所得金額調整控除の対象なら本人所得1,000万円以下になり、配偶者の要件が要る", (c) => (input(c, "REG-45")["incomeAdjustmentEligible"] = true), "REG-45: 分からない入力があるのにcomputed: spouse.sameHousehold"],
    // 家族の控除の判定の手順（PR29-R006の残り）: 候補で適用要件が決まらなければ不足
    ["特定親族の候補でNo.1177の(9)が分からないのに計算する", (c) => (obj(caseOf(c.cases, "REG-39")["expected"])["status"] = "computed"), "taxpayer.declaredAsSourceDeductionRelativeByOtherAndWithheld（specificRelativeDeductionの判定）"],
    ["16歳未満の子を特定親族の候補に変える", (c) => Object.assign(obj(arr(input(c, "REG-37")["relatives"])[0]), { birthDate: "2006-05-05", totalIncome: 850000 }), "REG-37: 分からない入力があるのにcomputed: taxpayer.declaredAsSourceDeductionRelativeByOtherAndWithheld"],
    ["事業専従者でなくなると所属が要る", (c) => (obj(arr(input(c, "REG-38")["relatives"])[0])["businessFamilyEmployee"] = false), "relatives[0].dependentClaimedByOtherTaxpayer（dependentDeductionの判定）"],
    ["1つの条件に主語がない", (c) => delete obj(arr(obj(c.data.get("rules/income-tax/jp-2026.json")?.["specificRelativeDeduction"])["eligibility"])[4])["subject"], "subject"],
    ["分からない適用要件で計算する", (c) => (obj(input(c, "REG-11")["spouse"])["sameHousehold"] = "unknown"), "分からない入力があるのにcomputed"],
    ["incompleteなのに結果がすべて分かる", (c) => (obj(caseOf(c.cases, "REG-02")["expected"])["status"] = "incomplete"), "unknownの結果がない"],
    ["特定親族の生年月日の範囲", (c) => (obj(c.data.get("rules/income-tax/jp-2025.json")?.["specificRelativeDeduction"])["bornFrom"] = "2003-01-01"), "年齢の上限"],
    ["特定親族の年齢の範囲がない", (c) => delete obj(c.data.get("rules/income-tax/jp-2026.json")?.["specificRelativeDeduction"])["ageBelow"], "年齢の範囲"],
    ["適用要件がない", (c) => delete obj(c.data.get("rules/income-tax/jp-2026.json")?.["dependentDeduction"])["eligibility"], "適用要件（eligibility）がない"],
    ["自動で当てはめない帰属の例が規則の根拠で年を決める", (c) => (obj(obj(arr(c.data.get("rules/salary-income-year/v1.json")?.["examples"])[2])["expected"])["bases"] = ["rule"]), "自動で当てはめない"],
    ["autoApplyがmanifestと制度データで違う", (c) => (c.data.get("rules/salary-income-year/v1.json")!["autoApply"] = true), "autoApply"],
    ["approvedの規則に承認の証跡がない", (c) => approved(c, "未確認"), "承認の証跡"],
    ["承認の証跡のURLが違う", (c) => approved(c, { ...goodApproval, reviewRecord: "https://example.com/x" }), "reviewRecord"],
    ["承認の証跡のheadがSHAでない", (c) => approved(c, { ...goodApproval, reviewedHead: "abc" }), "reviewedHead"],
    ["レビューしたPRと同じPRでapprovedにする", (c) => approved(c, { ...goodApproval, approvalPullRequest: "https://github.com/doc-gif/kurashi-ledger/pull/29" }), "別のPR"],
    ["draftの規則に承認の証跡がある", (c) => (ruleSetOf(c.manifest, "jp-income-tax-salary-2025")["approval"] = goodApproval), "draftの規則のapproval"],
    ["制度データに承認の証跡を写す", (c) => (c.data.get("rules/income-tax/jp-2025.json")!["approval"] = "未確認"), "manifestのapprovalだけ"],
    [
      "approvedのケースの確かめた担当が承認の証跡と違う",
      (c) => {
        approved(c, goodApproval);
        const k = caseOf(c.cases, "REG-02");
        k["status"] = "approved";
        obj(k["derivation"])["reviewedBy"] = "https://github.com/doc-gif/kurashi-ledger/pull/29#pullrequestreview-2";
      },
      "approval.reviewRecord）と違う",
    ],
  ];
  for (const [name, change, word] of checks) {
    const p = mutated(change);
    assert.ok(p.some((x) => x.includes(word)), `${name}: ${p.join(" / ") || "見つからない"}`);
  }
  // ORの条件群: 既知の代替（配偶者特別控除を適用していない）で満たせば、ほかの代替（年中の源泉徴収）のunknownで不足にしない（Copilot 4172926928）。
  assert.deepEqual(mutated((c) => (obj(input(c, "REG-24")["spouse"])["spouseWithheldViaSalaryDeclaration"] = "unknown")), []);
  // 当てはまらない控除の要件は不足に数えない: 所得0の配偶者の配偶者特別控除の要件、850万円以下の所得金額調整控除の対象か。
  assert.deepEqual(mutated((c) => (obj(input(c, "REG-11")["spouse"])["spouseWithheldViaPensionDeclaration"] = "unknown")), []);
  assert.deepEqual(mutated((c) => (input(c, "REG-02")["incomeAdjustmentEligible"] = "unknown")), []);
  // 控除ごとに同じ手順（PR29-R006の残り）: 候補でない人・既知の不適格の条件がある控除の未知の入力は、不足に数えない。
  // 16歳未満の子だけなら、子の適用要件もNo.1177の(9)も要らない（REG-37）。欠けていても同じ。
  assert.deepEqual(mutated((c) => (obj(arr(input(c, "REG-37")["relatives"])[0])["sameHousehold"] = "unknown")), []);
  assert.deepEqual(mutated((c) => delete obj(input(c, "REG-37")["taxpayer"])["declaredAsSourceDeductionRelativeByOtherAndWithheld"]), []);
  // 事業専従者と分かっている親族は、ほかの要件が分からなくても扶養控除0（REG-38。AND）。
  assert.deepEqual(mutated((c) => (obj(arr(input(c, "REG-38")["relatives"])[0])["sameHousehold"] = "unknown")), []);
  // 本人の合計所得金額が1,000万円を超える（REG-32）なら、配偶者の控除の候補でなく、配偶者の適用要件が分からなくても計算する。
  assert.deepEqual(mutated((c) => (input(c, "REG-32")["spouse"] = { ...obj(input(c, "REG-11")["spouse"]), sameHousehold: "unknown", spouseAppliesSpecialDeduction: "unknown" })), []);
  // 給与の上限ちょうど（REG-32）は年末調整の対象。上限を超える同じ収入の確定申告（REG-34）は計算する。
  assert.deepEqual(mutated((c) => (input(c, "REG-34")["salaryRevenue"] = 25000000)).filter((x) => x.includes("未対応")), []);
  // 粗探しN3: 親族の一人が居住者か分からないとき、不足はその人の控除だけで、ほかの結果を確定できないとはしない（REG-11）。
  const n3 = mutated((c) => (obj(arr(input(c, "REG-11")["relatives"])[0])["resident"] = "unknown"));
  assert.ok(n3.some((x) => x.includes("REG-11: 分からない入力があるのにcomputed") && x.includes("relatives[0].resident")), n3.join(" / "));
  assert.ok(n3.some((x) => x.includes("REG-11: expected.results（dependent-deduction）: 入力から確定できないのにknown")), n3.join(" / "));
  assert.deepEqual(n3.filter((x) => /employment-income|basic-deduction|spouse-deduction/.test(x)), []);
  // 検証の責務(b): unsupportedのケースでも、その範囲で求められない必須の入力を足すことは求めない（欠落は数えない）。
  assert.deepEqual(mutated((c) => delete input(c, "REG-15")["withheldTax"]), []);
  // 正しい承認の証跡なら、approvedの規則とケースは通る。
  const ok = mutated((c) => {
    approved(c, goodApproval);
    const k = caseOf(c.cases, "REG-02");
    k["status"] = "approved";
    obj(k["derivation"])["reviewedBy"] = goodApproval.reviewRecord;
  });
  assert.deepEqual(ok.filter((x) => x.includes("REG-02") || x.includes("approval")), []);
});

// 検証の責務(c)の組合せ（PR29-R006の残り、Codex 5400849200の完了条件）: 本人の合計所得金額1,000万円の境界で、所得金額調整控除の対象か
// （true・false・unknown）と、配偶者（候補で要件が既知・既知の不適格（事業専従者）でほかが未知・要件が未知）の組合せごとに、
// 配偶者の未知の入力を不足に数えるかを確かめる。本人の合計所得金額は、収入金額−195万円−所得金額調整控除（対象なら（1,000万円上限−850万円）×10%）。
test("家族の控除の判定: 本人の合計所得金額1,000万円の境界と、所得金額調整控除の対象か・配偶者の状態の組合せ", () => {
  const data = obj(INPUT.dataFiles.get("rules/income-tax/jp-2026.json"));
  const spouseBase = { birthDate: "1980-04-04", totalIncome: 0, legalSpouse: true, sameHousehold: true, businessFamilyEmployee: false, spouseAppliesSpecialDeduction: false, spouseWithheldViaSalaryDeclaration: false, spouseWithheldViaPensionDeclaration: false, spouseClaimedAsSpecificRelativeByOther: false, livingAtYearEnd: true, resident: true };
  const spouses: Record<string, Obj> = {
    known: spouseBase,
    ineligible: { ...spouseBase, businessFamilyEmployee: true, sameHousehold: "unknown" },
    unknown: { ...spouseBase, sameHousehold: "unknown" },
  };
  // [収入金額, 対象か, 本人の合計所得金額（範囲）, 配偶者が候補か（true・false・未決）]
  const rows: [number, boolean | "unknown", string, boolean | "undecided"][] = [
    [11950000, false, "10,000,000", true],
    [11950001, false, "10,000,001", false],
    [11950000, true, "9,855,000", true],
    [12100000, true, "10,000,000", true],
    [12100001, true, "10,000,001", false],
    [12100000, false, "10,150,000", false],
    [11950000, "unknown", "9,850,000〜10,000,000", true],
    [11950001, "unknown", "9,850,001〜10,000,001", "undecided"],
    [12100001, "unknown", "10,000,001〜10,150,001", false],
  ];
  for (const [salary, eligible, total, candidate] of rows) {
    for (const [kind, spouse] of Object.entries(spouses)) {
      const fc = familyCheck(data, { salaryRevenue: salary, incomeAdjustmentEligible: eligible, spouse, relatives: [], taxpayer: {} });
      const spouseUnknown = fc.unknown.filter((u) => u.startsWith("spouse."));
      // 不足になるのは、候補（か未決）で、配偶者の要件が未知で、既知の不適格がないときだけ。
      const expectNeeded = candidate !== false && kind === "unknown";
      assert.equal(spouseUnknown.length > 0, expectNeeded, `収入${salary}・対象${String(eligible)}（本人${total}）・配偶者${kind}: ${fc.unknown.join(" / ")}`);
      // 本人の所得が未決で、配偶者に既知の不適格がなければ、控除が決まらないので所得金額調整控除の対象かも挙げる（既知の不適格なら0で、挙げない）。
      assert.equal(fc.unknown.some((u) => u.startsWith("incomeAdjustmentEligible")), candidate === "undecided" && kind !== "ineligible", `収入${salary}・対象${String(eligible)}・配偶者${kind}`);
      assert.deepEqual(fc.invalid, []);
    }
  }
});

// 粗探しF4: 控除が当たらないと分かれば、本人の合計所得金額の範囲が配偶者控除の列をまたいでも0と確定する。当たるなら、列をまたげば確定しない。
test("結果を確定できるか: 当たらない控除は0と確定し、当たる控除は列が決まるときだけ確定する", () => {
  const data = obj(INPUT.dataFiles.get("rules/income-tax/jp-2026.json"));
  const base = { birthDate: "1980-04-04", totalIncome: 0, legalSpouse: true, sameHousehold: true, businessFamilyEmployee: false, spouseAppliesSpecialDeduction: false, spouseWithheldViaSalaryDeclaration: false, spouseWithheldViaPensionDeclaration: false, spouseClaimedAsSpecificRelativeByOther: false, livingAtYearEnd: true, resident: true };
  // 給与10,950,001円・対象かunknownで、本人の合計所得金額は8,850,001〜9,000,001円（900万円の列をまたぐ）。
  const rows: [string, Obj, boolean][] = [
    ["配偶者の合計所得金額200万円（どちらの控除の候補でもない）", { ...base, totalIncome: 2000000 }, true],
    ["配偶者が事業専従者（どちらの控除も当たらない）", { ...base, businessFamilyEmployee: true }, true],
    ["配偶者控除が当たり、列が決まらない", base, false],
  ];
  for (const [name, spouse, known] of rows) {
    const ci = { salaryRevenue: 10950001, incomeAdjustmentEligible: "unknown", spouse, relatives: [], taxpayer: {}, socialInsuranceDeduction: 1500000, otherIncomeDeductions: 0, withheldTax: 1100000 };
    const k = knowableResults(data, ci, "year-end-adjustment", familyCheck(data, ci), false);
    assert.equal(k.get("spouse-deduction"), known, name);
    assert.equal(k.get("spouse-special-deduction"), true, name);
    assert.equal(k.get("income-adjustment-deduction"), false, name);
  }
});

test("制度のケースの雛形の値は、規則の検査でも「未確認」のまま扱う", () => {
  const placeholders = arr(obj(INPUT.regimeCases)["cases"]).map(obj).filter((c) => c["status"] === "placeholder");
  assert.ok(placeholders.length > 0);
  for (const c of placeholders) assert.equal(c["ruleSet"], REGIME_PLACEHOLDER, String(c["caseId"]));
});
