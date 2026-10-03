// 金額・日付・期間の値（契約版1.0、docs/contracts/common-types.mdの4・6）。
// 金額は日本円の1円単位の整数で、安全な整数（−(2^53−1)〜2^53−1）の範囲だけを持つ。範囲を超える計算は誤りとして止め、
// 丸めたり浮動小数にしたりしない（ADR-0005）。日付は時刻とタイムゾーンを持たない暦日の文字列のまま扱う。

import { knownValue, stateOf } from "./fact.ts";

export type YenSign = "nonneg" | "pos" | "signed";

export function isYen(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

export function yenInRange(v: number, sign: YenSign): boolean {
  if (sign === "nonneg") return v >= 0;
  if (sign === "pos") return v > 0;
  return true;
}

// 円の合計。途中や結果が安全な整数を超えたらundefined（overflow）。丸めない。
export function addYen(a: number, b: number): number | undefined {
  const s = a + b;
  return Number.isSafeInteger(s) ? s : undefined;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEAR_MONTH = /^(\d{4})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// LocalDate（YYYY-MM-DD）。暦に実在する日だけ。
export function isLocalDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = LOCAL_DATE.exec(v);
  if (m === null) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isYearMonth(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = YEAR_MONTH.exec(v);
  if (m === null) return false;
  const mo = Number(m[2]);
  return Number(m[1]) >= 1 && mo >= 1 && mo <= 12;
}

// CalendarYear・FiscalYear（YYYY。4桁の年）。
export function isYear(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1000 && v <= 9999;
}

// Instant（RFC 3339、UTC、ミリ秒まで）。
export function isInstant(v: unknown): v is string {
  if (typeof v !== "string" || !INSTANT.test(v)) return false;
  const t = Date.parse(v);
  return !Number.isNaN(t) && new Date(t).toISOString() === v;
}

const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;

// 時点のAsia/Tokyoの日付。日本は1951年以降夏時間を使わないので、UTC+9の固定の差で決まる（共通の型の7の「把握日」の検査）。
export function tokyoDateOf(instant: string): string {
  const t = Date.parse(instant);
  if (Number.isNaN(t)) throw new Error(`Instantではない: ${instant}`);
  return new Date(t + TOKYO_OFFSET_MS).toISOString().slice(0, 10);
}

export function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

// 期間の端（共通の型の6の「端が分からない期間の扱い」）。startがknownでなければ過去へ、endがknownでなければ
// （not-applicableの継続中を含む）未来へ、限りなく開いた端として扱う。端を推測で埋めない。
export interface OpenInterval {
  readonly start: string | undefined; // undefinedは限りなく過去
  readonly end: string | undefined; // undefinedは限りなく未来
}

export function intervalOfPeriod(period: unknown): OpenInterval {
  if (typeof period !== "object" || period === null) return { start: undefined, end: undefined };
  const p = period as { start?: unknown; end?: unknown };
  const s = knownValue(p.start);
  const e = knownValue(p.end);
  return { start: typeof s === "string" ? s : undefined, end: typeof e === "string" ? e : undefined };
}

// Fact<Period>の期間。期間そのものがunknown・not-statedなら両端とも分からない期間、not-applicableなら期間がない（undefined）。
export function intervalOfFactPeriod(fact: unknown): OpenInterval | undefined {
  const st = stateOf(fact);
  if (st === "not-applicable") return undefined;
  if (st === "known") return intervalOfPeriod(knownValue(fact));
  return { start: undefined, end: undefined };
}

// 両端を含む2つの期間が重なるか。限りなく開いた端は、どの日付とも重なりうるものとして扱う。
export function intervalsOverlap(a: OpenInterval, b: OpenInterval): boolean {
  const aStartsAfterBEnds = a.start !== undefined && b.end !== undefined && a.start > b.end;
  const bStartsAfterAEnds = b.start !== undefined && a.end !== undefined && b.start > a.end;
  return !aStartsAfterBEnds && !bStartsAfterAEnds;
}
