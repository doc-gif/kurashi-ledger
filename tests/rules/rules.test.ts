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
import { isCalendarYear, isLocalDate, isObj, isYearMonth, PROCEDURES, REGIME_PLACEHOLDER, REGIMES, ROUNDING_METHODS } from "../fixtures/ledger/contract-shape.ts";
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
  });
  return (x: number): Dec | undefined => {
    const r = ranges.map(obj).find((o) => x >= Number(o["from"]) && (o["to"] === null || x < Number(o["to"])));
    if (r === undefined) return undefined;
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

function checkIncomeTaxData(data: Obj, where: string, problems: Problems): void {
  const ei = employmentIncomeOf(data, where, problems);
  const emp = obj(data["employmentIncome"]);
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
  const basic = obj(data["basicDeduction"]);
  const base = basic["statutoryBase"];
  let prev = -1;
  arr(basic["brackets"]).forEach((b, i, all) => {
    const o = obj(b);
    const w = `${where} basicDeduction.brackets[${i}]`;
    const max = o["totalIncomeMax"];
    if (i === all.length - 1 ? max !== null : !isInt(max) || max <= prev) problems.add(w, "合計所得金額の上限は昇順で、最後はnull");
    if (isInt(max)) prev = max;
    if (isInt(o["addition"]) && (!isInt(base) || base + o["addition"] !== o["amount"])) problems.add(w, "所得税法の額と加算額の合計が控除額と違う");
  });
  const brackets = arr(obj(data["taxRates"])["brackets"]).map(obj);
  brackets.forEach((b, i) => {
    const w = `${where} taxRates.brackets[${i}]`;
    const last = i === brackets.length - 1;
    if (last ? b["taxableIncomeMax"] !== null : !isInt(b["taxableIncomeMax"])) problems.add(w, "上限は整数で、最後はnull");
    const next = brackets[i + 1];
    if (next === undefined || !isInt(b["taxableIncomeMax"])) return;
    // 速算表の連続: 次の段階の最初の課税所得（上限＋1,000円）で、2つの段階の式が同じ税額になる。
    const at = BigInt(Number(b["taxableIncomeMax"]) + 1000);
    const r1 = parseDec(b["rate"]);
    const r2 = parseDec(next["rate"]);
    if (r1 === undefined || r2 === undefined) {
      problems.add(w, "rateが小数でない");
      return;
    }
    const s = Math.max(r1.s, r2.s);
    const t1 = at * scaled(r1, s) - BigInt(Number(b["quickDeduction"])) * 10n ** BigInt(s);
    const t2 = at * scaled(r2, s) - BigInt(Number(next["quickDeduction"])) * 10n ** BigInt(s);
    if (t1 !== t2) problems.add(w, "速算表の控除額が段階の境で連続しない（写し誤り）");
  });
  const dep = obj(data["dependentDeduction"]);
  const ref = dep["ageDeterminationDate"];
  if (isLocalDate(ref)) {
    arr(dep["categories"]).forEach((c, i) => {
      const o = obj(c);
      const w = `${where} dependentDeduction.categories[${i}]`;
      const min = Number(o["ageMin"]);
      if (isLocalDate(o["bornOnOrBefore"])) {
        if (ageOn(o["bornOnOrBefore"], ref) < min || ageOn(shiftDay(o["bornOnOrBefore"], 1), ref) >= min) problems.add(w, "生年月日の範囲と年齢の下限が合わない");
      }
      if (isLocalDate(o["bornFrom"]) && isLocalDate(o["bornTo"])) {
        const below = Number(o["ageBelow"]);
        if (ageOn(o["bornTo"], ref) < min || ageOn(shiftDay(o["bornTo"], 1), ref) >= min) problems.add(w, "生年月日の範囲の終わりと年齢の下限が合わない");
        if (ageOn(o["bornFrom"], ref) >= below || ageOn(shiftDay(o["bornFrom"], -1), ref) < below) problems.add(w, "生年月日の範囲の始まりと年齢の上限が合わない");
      }
    });
  } else problems.add(where, "dependentDeduction.ageDeterminationDateがない");
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
    ruleSets.set(key, { rs, applies, used: new Set<string>() });
    // 制度データ
    const data = obj(input.dataFiles.get(String(rs["data"])));
    const dw = `${String(rs["data"])}`;
    if (data["ruleSetId"] !== id || data["version"] !== version || data["status"] !== rs["status"]) problems.add(dw, "ruleSetId・version・statusがmanifestと違う");
    const refs: { ref: unknown; location: unknown; path: string }[] = [];
    collectSourceRefs(data, "", refs);
    for (const ref of refs) {
      if (typeof ref.ref !== "string" || !listed.has(ref.ref)) problems.add(`${dw} ${ref.path}`, `原典のidが規則のsourcesにない: ${String(ref.ref)}`);
      else ruleSets.get(key)?.used.add(ref.ref);
      if (!nonEmpty(ref.location)) problems.add(`${dw} ${ref.path}`, "原典の箇所（location）がない");
    }
    checkDataRounding(data, dw, problems);
    if (rs["regime"] === "income-tax" && rs["kind"] === "calculation") checkIncomeTaxData(data, dw, problems);
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
    if (status === "unsupported") {
      const coveredBy = entries.filter(([, e]) => e.rs["regime"] === o["regime"] && e.rs["kind"] === "calculation" && targetCovered(target, e.applies)).map(([k]) => k);
      if (coveredBy.length > 0) problems.add(w, `unsupportedのケースのtargetに当たる規則がある: ${coveredBy.join("・")}`);
      if (arr(expected["results"]).some((r) => obj(obj(r)["value"])["state"] !== "unknown")) problems.add(w, "unsupportedの結果の値はすべてunknown");
      if (arr(o["rounding"]).length > 0) problems.add(w, "unsupportedのケースは丸めの手順を持たない");
      return;
    }
    if (!targetCovered(target, entry.applies)) problems.add(w, "targetが規則の適用の範囲（applies）に当たらない");
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
    ["unsupportedのケースに当たる規則がある", (c) => (obj(caseOf(c.cases, "REG-15")["target"])["referencePoint"] = { kind: "date", date: "2026-12-01" }), "当たる規則がある"],
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

test("制度のケースの雛形の値は、規則の検査でも「未確認」のまま扱う", () => {
  const placeholders = arr(obj(INPUT.regimeCases)["cases"]).map(obj).filter((c) => c["status"] === "placeholder");
  assert.ok(placeholders.length > 0);
  for (const c of placeholders) assert.equal(c["ruleSet"], REGIME_PLACEHOLDER, String(c["caseId"]));
});
