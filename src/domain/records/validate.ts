// 記録1件で決まる保存の検査（静的な検査）。契約版1.0のcommon-types.mdの2・4・6・9・12、records.md、reconciliation.mdの3・4。
// 形・許す状態・符号と範囲・並びの一意のキー・参照の種類と粒度・期間・改訂の理由と状態の組を確かめ、違反をすべて返す。
// ほかの記録との関係で決まる条件（参照先の実在、系列、重なり、正規のID、上限等）は、ここでは確かめない（save.ts）。

import { isFactState, knownValue, stateOf, type FactState } from "./fact.ts";
import { isIdWithPrefix, isLineId, isRecordType, RECORD_PREFIX, recordTypeOfId, type RecordType } from "./ids.ts";
import { REVISION_REASONS } from "./ledger.ts";
import type { RejectionReason, Violation } from "./reasons.ts";
import { BODY_SPECS, ENVELOPE_STATES, LINE_LISTS, type Spec } from "./schema.ts";
import { isInstant, isLocalDate, isYear, isYearMonth, isYen, yenInRange } from "./values.ts";

type Obj = Readonly<Record<string, unknown>>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Out {
  readonly list: Violation[] = [];
  // 新しい版のデータの読取の検査では、Factの標準の表記の知らない項目を、ないものとして飛ばす（契約版2.0の共通の型の1「読む処理が
  // 知らない項目」、所有者の判断「新しい版のデータのときだけ読むだけ」。R28-2）。それ以外（保存しようとしている改訂、名乗りのない
  // 復元・取込）では違反にする（壊れた中身は修復の改訂で直す）。
  ignoreUnknownFacts = false;
  add(reason: RejectionReason, path: string, message: string): void {
    this.list.push({ reason, path, message });
  }
}

function checkValue(spec: Spec, v: unknown, path: string, out: Out): void {
  switch (spec.t) {
    case "any":
      return;
    case "text":
      if (typeof v !== "string") out.add("value-invalid", path, "Textではない");
      else if (spec.nonEmpty === true && v.trim() === "") out.add("value-invalid", path, "空にできない文字列が空");
      return;
    case "enum":
      if (typeof v !== "string" || !spec.values.includes(v)) out.add("value-invalid", path, `列挙にない値: ${String(v)}`);
      return;
    case "id":
      checkId(v, spec.prefix, path, out);
      return;
    case "yen":
      if (!isYen(v)) out.add("value-invalid", path, `安全な整数の円ではない: ${String(v)}`);
      else if (!yenInRange(v, spec.sign)) out.add("value-invalid", path, `${spec.sign === "pos" ? "正" : "0以上"}の項目の範囲の外: ${v}`);
      return;
    case "localDate":
      if (!isLocalDate(v)) out.add("value-invalid", path, `LocalDateではない: ${String(v)}`);
      return;
    case "yearMonth":
      if (!isYearMonth(v)) out.add("value-invalid", path, `YearMonthではない: ${String(v)}`);
      return;
    case "year":
      if (!isYear(v)) out.add("value-invalid", path, `年ではない: ${String(v)}`);
      return;
    case "subjectYear":
      if (!isObj(v) || (v["kind"] !== "calendar" && v["kind"] !== "fiscal") || !isYear(v["year"]) || Object.keys(v).length !== 2) {
        out.add("value-invalid", path, "{ kind: calendar・fiscal, year }ではない");
      }
      return;
    case "minutes":
    case "positiveInt":
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < (spec.t === "minutes" ? 0 : 1)) {
        out.add("value-invalid", path, spec.t === "minutes" ? "0以上の整数ではない" : "1以上の整数ではない");
      }
      return;
    case "boolean":
      if (typeof v !== "boolean") out.add("value-invalid", path, "真偽値ではない");
      return;
    case "lineId":
      if (!isLineId(v)) out.add("value-invalid", path, `LineIdではない: ${String(v)}`);
      return;
    case "period":
      checkPeriod(v, path, out);
      return;
    case "ref":
      checkRef(v, path, out, spec.to, spec.line);
      return;
    case "object":
      checkObject(spec.fields, v, path, out);
      return;
    case "list": {
      if (!Array.isArray(v)) {
        out.add("value-invalid", path, "並びではない");
        return;
      }
      if (spec.nonEmpty === true && v.length === 0) out.add("list-invalid", path, "空を許さない並びが空");
      const seen = new Set<string>();
      v.forEach((e, i) => {
        checkValue(spec.of, e, `${path}[${i}]`, out);
        const k = spec.uniqueKey?.(e);
        if (k !== undefined) {
          if (seen.has(k)) out.add("list-invalid", `${path}[${i}]`, `並びの一意のキーが重なる: ${k}`);
          seen.add(k);
        }
      });
      return;
    }
    case "fact":
      checkFact(spec.of, spec.states, v, path, out);
      return;
  }
}

function checkId(v: unknown, prefix: string, path: string, out: Out): void {
  if (isIdWithPrefix(v, prefix)) return;
  if (recordTypeOfId(v) !== undefined || isIdWithPrefix(v, "evf") || isIdWithPrefix(v, "run")) {
    out.add("ref-target-invalid", path, `接頭辞${prefix}のIDではない（指せない種類）: ${String(v)}`);
  } else {
    out.add("value-invalid", path, `IDではない: ${String(v)}`);
  }
}

function checkFact(of: Spec, states: readonly FactState[], v: unknown, path: string, out: Out): void {
  if (!isObj(v) || !isFactState(v["state"])) {
    out.add("value-invalid", path, "Factの標準の表記ではない");
    return;
  }
  for (const k of Object.keys(v)) {
    if (k !== "state" && k !== "value" && k !== "note") out.add("value-invalid", path, `Factに余分な項目: ${k}`);
  }
  if (v["note"] !== undefined && typeof v["note"] !== "string") out.add("value-invalid", `${path}.note`, "noteがTextではない");
  const state = v["state"];
  if (!states.includes(state)) out.add("fact-state-not-allowed", path, `この項目が許さない状態: ${state}`);
  if (state === "known") {
    if (!Object.hasOwn(v, "value")) out.add("value-invalid", path, "knownに値がない");
    else checkValue(of, v["value"], `${path}.value`, out);
  } else if (Object.hasOwn(v, "value")) {
    out.add("value-invalid", path, `${state}に値がある`);
  }
}

const PERIOD_FIELDS: Readonly<Record<string, Spec>> = {
  start: { t: "fact", of: { t: "localDate" }, states: ["known", "unknown", "not-stated"] },
  end: { t: "fact", of: { t: "localDate" }, states: ["known", "unknown", "not-stated", "not-applicable"] },
};

function checkPeriod(v: unknown, path: string, out: Out): void {
  checkObject(PERIOD_FIELDS, v, path, out);
  if (!isObj(v)) return;
  const s = knownValue(v["start"]);
  const e = knownValue(v["end"]);
  if (isLocalDate(s) && isLocalDate(e) && s > e) out.add("invalid-period", path, `startがendより後: ${s} > ${e}`);
}

function checkRef(v: unknown, path: string, out: Out, to: readonly RecordType[], line: "whole" | "any"): void {
  if (!isObj(v)) {
    out.add("value-invalid", path, "Refではない");
    return;
  }
  for (const k of Object.keys(v)) {
    if (k !== "id" && k !== "revision" && k !== "line") out.add("value-invalid", path, `Refに余分な項目: ${k}`);
  }
  const target = recordTypeOfId(v["id"]);
  if (target === undefined) out.add("value-invalid", `${path}.id`, `記録のIDではない: ${String(v["id"])}`);
  else if (!to.includes(target)) out.add("ref-target-invalid", `${path}.id`, `指せない種類の記録: ${target}`);
  // 記録どうしの関係はcurrentだけ（共通の型の2の「currentと整数の使い分け」）。
  if (v["revision"] !== "current") out.add("value-invalid", `${path}.revision`, "記録どうしの関係のrevisionはcurrentだけ");
  const l = v["line"];
  if (l !== "whole" && !isLineId(l)) out.add("value-invalid", `${path}.line`, "lineがwholeでもLineIdでもない");
  else if (line === "whole" && l !== "whole") out.add("ref-granularity", `${path}.line`, `記録全体についての関係で行を指す: ${String(l)}`);
}

function checkObject(fields: Readonly<Record<string, Spec>>, v: unknown, path: string, out: Out): void {
  if (!isObj(v)) {
    out.add("value-invalid", path, "objectではない");
    return;
  }
  for (const k of Object.keys(fields)) {
    if (!Object.hasOwn(v, k)) out.add("value-invalid", `${path}.${k}`, "項目がない（表に書いた項目は省略しない）");
  }
  for (const k of Object.keys(v)) {
    // 表にある項目かは、表のown keyだけで決める（「__proto__」等のキーで、表のprototypeを項目の仕様と取り違えない）。
    const s = Object.hasOwn(fields, k) ? fields[k] : undefined;
    if (s === undefined) {
      if (out.ignoreUnknownFacts && isFactNotation(v[k])) continue;
      out.add("value-invalid", `${path}.${k}`, "表にない項目");
    }
    else checkValue(s, v[k], `${path}.${k}`, out);
  }
}

function requireStates(v: unknown, allowed: readonly FactState[], path: string, out: Out, why: string): void {
  const s = stateOf(v);
  if (s !== undefined && !allowed.includes(s)) out.add("fact-state-not-allowed", path, `${why}（${s}）`);
}

const DEFAULT_STATES: readonly FactState[] = ["known", "unknown", "not-stated"];

// 改訂の共通の形の項目（recordedAt・recordedSeqは保存のときにdomainが割り当てるので、提案の改訂には含めない）。
const PROPOSED_FIELDS = ["id", "recordType", "revision", "status", "reason", "knownOn", "changeNote", "duplicateOf", "entryChannel", "writeRequestId", "importKey", "body"];
const STORED_FIELDS = [...PROPOSED_FIELDS, "recordedAt", "recordedSeq"];

export interface StaticCheckOptions {
  // trueなら保存した改訂（recordedAt・recordedSeqを持つ）として確かめる。falseなら保存しようとしている改訂（idはあってもなくてもよい）。
  readonly stored: boolean;
  // trueなら、取消（void）の改訂として、その改訂が決める項目（骨格、status・reason・duplicateOf・writeRequestId・changeNote・
  // 把握日）だけを確かめる。bodyと変えられない項目（entryChannel・importKey）は、直前の版と同じであることを遷移の検査で確かめる
  // （所有者の判断「信頼できない記録だけ修復を許す」。PR #36の共通の型の9。D2）。
  readonly voidScope?: boolean;
  // trueなら、読む処理より新しい契約版を名乗るデータから入った保存した改訂として、読取の検査で確かめる（storedのときだけ効く）。
  readonly newerVersion?: boolean;
}

// 改訂1件の静的な検査。違反がなければ空の並び。
export function checkRevisionStatic(record: unknown, options: StaticCheckOptions = { stored: false }): Violation[] {
  const out = new Out();
  out.ignoreUnknownFacts = options.stored && options.newerVersion === true;
  if (!isObj(record)) {
    out.add("value-invalid", "$", "改訂がobjectではない");
    return out.list;
  }
  const allowed = options.stored ? STORED_FIELDS : PROPOSED_FIELDS;
  for (const k of allowed) {
    if (k === "id" && !options.stored) continue;
    if (!Object.hasOwn(record, k)) out.add("value-invalid", `$.${k}`, "改訂の共通の形の項目がない");
  }
  for (const k of Object.keys(record)) if (!allowed.includes(k)) out.add("value-invalid", `$.${k}`, "改訂の共通の形にない項目");
  if (options.stored) {
    if (!isInstant(record["recordedAt"])) out.add("value-invalid", "$.recordedAt", "Instantではない");
    const seq = record["recordedSeq"];
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) out.add("value-invalid", "$.recordedSeq", "1以上の整数ではない");
  }
  const recordType = record["recordType"];
  if (!isRecordType(recordType)) {
    out.add("value-invalid", "$.recordType", `記録の種類ではない: ${String(recordType)}`);
    return out.list;
  }
  if (Object.hasOwn(record, "id") && !isIdWithPrefix(record["id"], RECORD_PREFIX[recordType])) {
    out.add("value-invalid", "$.id", `${recordType}の接頭辞${RECORD_PREFIX[recordType]}のIDではない: ${String(record["id"])}`);
  }
  const revision = record["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) out.add("value-invalid", "$.revision", "版が1以上の整数ではない");
  const reason = record["reason"];
  if (typeof reason !== "string" || !(REVISION_REASONS as readonly string[]).includes(reason)) {
    out.add("value-invalid", "$.reason", `改訂の理由ではない: ${String(reason)}`);
  }
  // 改訂のモデルの表（共通の型の9）: 改訂後のstatusは理由で決まる。createは版1だけ、版1はcreateだけ。
  const status = record["status"];
  if (status !== "active" && status !== "voided") out.add("value-invalid", "$.status", "active・voidedではない");
  else if (typeof reason === "string" && (REVISION_REASONS as readonly string[]).includes(reason)) {
    const expected = reason === "void" ? "voided" : "active";
    if (status !== expected) out.add("transition-not-allowed", "$.status", `理由${reason}の改訂後のstatusは${expected}`);
  }
  if (typeof revision === "number" && (reason === "create") !== (revision === 1)) {
    out.add("transition-not-allowed", "$.revision", "createは版1だけ、版1はcreateだけ");
  }
  checkFact({ t: "localDate" }, ENVELOPE_STATES.knownOn, record["knownOn"], "$.knownOn", out);
  checkFact({ t: "text" }, ENVELOPE_STATES.changeNote, record["changeNote"], "$.changeNote", out);
  checkFact({ t: "ref", to: [recordType], line: "whole" }, ENVELOPE_STATES.duplicateOf, record["duplicateOf"], "$.duplicateOf", out);
  // duplicateOfはvoidの改訂で、二重登録として取り消した場合だけknown。ほかの改訂ではnot-applicable（共通の型の9・12）。
  if (reason !== "void") requireStates(record["duplicateOf"], ["not-applicable"], "$.duplicateOf", out, "voidでない改訂のduplicateOfはnot-applicable");
  const dup = knownValue(record["duplicateOf"]);
  if (isObj(dup) && Object.hasOwn(record, "id") && dup["id"] === record["id"]) out.add("ref-target-invalid", "$.duplicateOf", "自分自身を残す方にできない");
  checkValue({ t: "text", nonEmpty: true }, record["writeRequestId"], "$.writeRequestId", out);
  if (options.voidScope === true) return out.list;
  const channel = record["entryChannel"];
  if (channel !== "manual" && channel !== "import") out.add("value-invalid", "$.entryChannel", "manual・importではない");
  checkFact({ t: "object", fields: { source: { t: "text", nonEmpty: true }, key: { t: "text", nonEmpty: true } } }, ENVELOPE_STATES.importKey, record["importKey"], "$.importKey", out);
  requireStates(record["importKey"], channel === "import" ? ["known"] : ["not-applicable"], "$.importKey", out, "importKeyはentryChannelがimportの場合だけknown");
  const body = record["body"];
  checkObject(BODY_SPECS[recordType], body, "$.body", out);
  if (isObj(body)) {
    checkTypeRules(recordType, body, out);
    checkLineIdsAcrossLists(recordType, body, out);
  }
  return out.list;
}

// 行IDは同じ親の記録の中で一意（共通の型の2の「LineId」）。並びをまたいで同じ行IDを持たない。
function checkLineIdsAcrossLists(type: RecordType, body: Obj, out: Out): void {
  const lists = LINE_LISTS[type];
  if (lists === undefined || lists.length < 2) return;
  const owner = new Map<string, string>();
  for (const name of lists) {
    for (const line of lineObjects(body[name])) {
      const id = line["lineId"];
      if (typeof id !== "string") continue;
      const prev = owner.get(id);
      if (prev !== undefined && prev !== name) out.add("list-invalid", `$.body.${name}`, `行ID ${id} が${prev}と${name}の両方にある`);
      owner.set(id, name);
    }
  }
}

// 並び（Factの並び、またはFactでない並び）の行のobject。
export function lineObjects(v: unknown): Obj[] {
  const list = Array.isArray(v) ? v : knownValue(v);
  return Array.isArray(list) ? list.filter(isObj) : [];
}

function refOf(v: unknown): Obj | undefined {
  return isObj(v) ? v : undefined;
}

// 種類ごとの、条件で決まる規則（「〜の場合だけ」、組合せ、記録の中の一意性）。
function checkTypeRules(type: RecordType, body: Obj, out: Out): void {
  switch (type) {
    case "annual-document": {
      // 同じ支払者の行は1件だけ、発行した支払者と同じ支払者の行を持たない（記録の型の6）。正規のIDでの検査はsave.ts。
      const rows = knownValue(body["includedOtherPayers"]);
      if (Array.isArray(rows)) {
        rows.forEach((row, i) => {
          const payer = isObj(row) ? knownValue(row["payerEmployerId"]) : undefined;
          if (typeof payer === "string" && payer === body["payerEmployerId"]) {
            out.add("list-invalid", `$.body.includedOtherPayers[${i}]`, "発行した支払者と同じ支払者の行");
          }
        });
      }
      return;
    }
    case "forecast": {
      // 記録の型の7。measureはsubjectで決まる。employerIdのnot-applicableは入金の予測だけ。accountIdは入金の予測の場合だけ。
      const subject = body["subject"];
      const measure = body["measure"];
      const allowed = subject === "pay" ? ["gross-pay", "net-pay", "bank-transfer"] : subject === "deposit" ? ["deposit-amount"] : [];
      if (typeof measure === "string" && !allowed.includes(measure)) out.add("value-invalid", "$.body.measure", `subject ${String(subject)}に合わないmeasure ${measure}`);
      if (subject === "pay") {
        requireStates(body["employerId"], DEFAULT_STATES, "$.body.employerId", out, "給与の予測のemployerIdにnot-applicableは使えない");
        requireStates(body["accountId"], ["not-applicable"], "$.body.accountId", out, "accountIdは入金の予測の場合だけ");
      } else if (subject === "deposit") {
        requireStates(body["accountId"], DEFAULT_STATES, "$.body.accountId", out, "入金の予測のaccountId");
      }
      for (const [i, line] of (Array.isArray(body["lines"]) ? body["lines"] : []).entries()) {
        if (!isObj(line)) continue;
        // 行の金額の範囲はmeasureごと（net-payは符号あり、ほかは0以上）。
        const amount = knownValue(line["amount"]);
        if (typeof amount === "number" && measure !== "net-pay" && amount < 0) out.add("value-invalid", `$.body.lines[${i}].amount`, `${String(measure)}の見込みは0以上`);
        // expectedDateがknownなら、expectedMonthの月の日付。
        const date = knownValue(line["expectedDate"]);
        if (typeof date === "string" && typeof line["expectedMonth"] === "string" && !date.startsWith(`${line["expectedMonth"]}-`)) {
          out.add("value-invalid", `$.body.lines[${i}].expectedDate`, "予定日が予定月の日付でない");
        }
      }
      return;
    }
    case "official-notice": {
      // 記録の型の8。決定額の行（annual-total）は1件の通知に1行だけ。
      const amounts = knownValue(body["amounts"]);
      let annualTotals = 0;
      let categoryNotKnown = false;
      if (Array.isArray(amounts)) {
        for (const line of amounts) {
          if (!isObj(line)) continue;
          if (knownValue(line["category"]) === "annual-total") annualTotals += 1;
          if (stateOf(line["category"]) !== "known") categoryNotKnown = true;
        }
        if (annualTotals > 1) out.add("list-invalid", "$.body.amounts", "categoryがannual-totalの行が2行以上");
      }
      // subjectYearのnot-applicableは、amountsがknownで、annual-totalの行もcategoryがknownでない行もない場合だけ（共通の型の12）。
      if (stateOf(body["subjectYear"]) === "not-applicable" && (!Array.isArray(amounts) || annualTotals > 0 || categoryNotKnown)) {
        out.add("fact-state-not-allowed", "$.body.subjectYear", "決定額の行がないと確かめた通知だけnot-applicable");
      }
      return;
    }
    case "allocation":
      checkAllocationRules(body, out);
      return;
    case "decision":
      checkDecisionRules(body, out);
      return;
    default:
      return;
  }
}

function typeOfRef(v: unknown): RecordType | undefined {
  return recordTypeOfId(refOf(v)?.["id"]);
}

// 照合配分の、記録1件で決まる規則（reconciliation.mdの3の種類ごとの表と、共通の型の12）。確定の条件・識別の次元・
// 配分の符号（実績との関係）・上限はT11が判定する。
function checkAllocationRules(body: Obj, out: Out): void {
  const kind = body["kind"];
  const status = body["allocationStatus"];
  const fromType = typeOfRef(body["from"]);
  const toType = typeOfRef(body["to"]);
  const fromLine = refOf(body["from"])?.["line"];
  const toLine = refOf(body["to"])?.["line"];
  const wantWhole = (line: unknown, path: string): void => {
    if (line !== undefined && line !== "whole") out.add("ref-granularity", path, "記録全体（whole）だけ");
  };
  if (kind === "transfer-to-deposit") {
    if (fromType !== undefined && fromType !== "payslip") out.add("ref-target-invalid", "$.body.from", "transfer-to-depositのfromは給与明細");
    if (toType !== undefined && toType !== "bank-deposit") out.add("ref-target-invalid", "$.body.to", "transfer-to-depositのtoは銀行入金");
    wantWhole(fromLine, "$.body.from.line");
    wantWhole(toLine, "$.body.to.line");
  } else if (kind === "annual-coverage") {
    if (fromType !== undefined && fromType !== "annual-document") out.add("ref-target-invalid", "$.body.from", "annual-coverageのfromは年間資料");
    if (toType !== undefined && toType !== "payslip") out.add("ref-target-invalid", "$.body.to", "annual-coverageのtoは給与明細");
    wantWhole(fromLine, "$.body.from.line");
    wantWhole(toLine, "$.body.to.line");
  } else if (kind === "forecast-realization") {
    if (fromType !== undefined && fromType !== "payslip" && fromType !== "bank-deposit") out.add("ref-target-invalid", "$.body.from", "実績化のfromは給与明細か銀行入金");
    if (fromType === "bank-deposit") wantWhole(fromLine, "$.body.from.line");
    if (toType !== undefined && toType !== "forecast") out.add("ref-target-invalid", "$.body.to", "実績化のtoは予測の行");
    if (toLine === "whole") out.add("ref-granularity", "$.body.to.line", "予測の行だけ（wholeは使わない）");
  }
  if (kind === "annual-coverage") {
    requireStates(body["amount"], ["not-applicable"], "$.body.amount", out, "annual-coverageのamountはnot-applicable");
  } else {
    requireStates(body["amount"], status === "confirmed" ? ["known"] : DEFAULT_STATES, "$.body.amount", out, "確定にはknownのamount、ほかはnot-applicableを使わない");
    const amount = knownValue(body["amount"]);
    if (typeof amount === "number") {
      if (amount === 0) out.add("value-invalid", "$.body.amount", "amountは0でない");
      if (kind === "transfer-to-deposit" && amount < 0) out.add("value-invalid", "$.body.amount", "transfer-to-depositのamountは正");
    }
  }
  if (kind === "forecast-realization") {
    requireStates(body["settlesForecastLine"], status === "confirmed" ? ["known"] : DEFAULT_STATES, "$.body.settlesForecastLine", out, "実績化の確定にはknown");
  } else {
    requireStates(body["settlesForecastLine"], ["not-applicable"], "$.body.settlesForecastLine", out, "forecast-realizationの場合だけ");
  }
  requireStates(body["confirmedAgainst"], status === "confirmed" ? ["known"] : ["not-applicable"], "$.body.confirmedAgainst", out, "confirmedの場合だけknown");
}

// 照合の判断の、記録1件で決まる規則（reconciliation.mdの4の種類ごとの表と、共通の型の12）。保存の検証（資料との整合）はT11。
function checkDecisionRules(body: Obj, out: Out): void {
  const t = body["decisionType"];
  const targets = Array.isArray(body["targets"]) ? body["targets"] : [];
  const types = targets.map(typeOfRef);
  const value = body["value"];
  const needScope = t === "annual-adoption" || t === "mismatch-explanation";
  requireStates(body["scope"], needScope ? ["known"] : ["not-applicable"], "$.body.scope", out, "annual-adoption・mismatch-explanationの場合だけknown");
  requireStates(body["explainedComparisons"], t === "mismatch-explanation" ? ["known"] : ["not-applicable"], "$.body.explainedComparisons", out, "mismatch-explanationの場合だけknown");
  if (t === "duplicate-review") {
    const [a, b] = types;
    if (targets.length !== 2 || a === undefined || a !== b) out.add("ref-target-invalid", "$.body.targets", "duplicate-reviewの対象は同じ種類の2件");
    if (value !== "distinct" && value !== "same") out.add("value-invalid", "$.body.value", "distinct・sameではない");
  } else if (t === "annual-adoption") {
    if (value === "annual-document") {
      if (targets.length !== 1 || types[0] !== "annual-document") out.add("ref-target-invalid", "$.body.targets", "採用する年間資料1件");
    } else if (value === "entered-payslips") {
      if (targets.length !== 0) out.add("ref-target-invalid", "$.body.targets", "entered-payslipsのtargetsは空");
    } else out.add("value-invalid", "$.body.value", "annual-document・entered-payslipsではない");
  } else if (t === "mismatch-explanation") {
    if (targets.length !== 1 || types[0] !== "annual-document") out.add("ref-target-invalid", "$.body.targets", "年間資料1件");
    if (value !== "explained") out.add("value-invalid", "$.body.value", "explainedではない");
  } else if (t === "tax-year-assertion") {
    if (targets.length !== 1 || types[0] !== "payslip") out.add("ref-target-invalid", "$.body.targets", "給与明細1件");
    if (!isYear(value)) out.add("value-invalid", "$.body.value", "CalendarYearではない");
  }
}

// 証憑ファイルの形（記録の型の9）。保存の時点（recordedAt・recordedSeq）は、保存のときにdomainが割り当てる。
export function checkEvidenceFileStatic(file: unknown): Violation[] {
  const out = new Out();
  const fields: Readonly<Record<string, Spec>> = {
    sha256: { t: "text" },
    byteSize: { t: "minutes" },
    mediaType: { t: "text", nonEmpty: true },
    originalFileName: { t: "text" },
    storageName: { t: "text", nonEmpty: true },
    importedAt: { t: "text" },
  };
  checkObject(fields, file, "$", out);
  if (isObj(file)) {
    if (typeof file["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(file["sha256"])) out.add("value-invalid", "$.sha256", "64文字の小文字16進ではない");
    if (!isInstant(file["importedAt"])) out.add("value-invalid", "$.importedAt", "Instantではない");
  }
  return out.list;
}

// Factの標準の表記（4つの状態のどれかで、knownなら値を持ち、ほかは値を持たない。項目はstate・value・noteだけ）か。
export function isFactNotation(v: unknown): boolean {
  if (!isObj(v) || !isFactState(v["state"])) return false;
  if (Object.keys(v).some((k) => k !== "state" && k !== "value" && k !== "note")) return false;
  if (v["note"] !== undefined && typeof v["note"] !== "string") return false;
  return v["state"] === "known" ? Object.hasOwn(v, "value") : !Object.hasOwn(v, "value");
}

// この版の表にない項目（bodyのobjectの、仕様にない項目）を持つか。新しい契約版で足した項目を古い版が読む場合に当たる。この版では
// その記録を読むだけにし、改訂を保存しない（所有者の判断「古い版では読むだけにする」）。形の違う値（型の違反）は対象にしない。
export function hasUnknownContent(recordType: RecordType, body: unknown): boolean {
  return unknownIn({ t: "object", fields: BODY_SPECS[recordType] }, body);
}

function unknownIn(spec: Spec, v: unknown): boolean {
  if (spec.t === "object") {
    if (!isObj(v)) return false;
    return Object.keys(v).some((k) => !Object.hasOwn(spec.fields, k) || unknownIn(spec.fields[k] as Spec, v[k]));
  }
  if (spec.t === "fact") return isObj(v) && v["state"] === "known" && Object.hasOwn(v, "value") && unknownIn(spec.of, v["value"]);
  if (spec.t === "list") return Array.isArray(v) && v.some((e) => unknownIn(spec.of, e));
  if (spec.t === "period") return isObj(v) && Object.keys(v).some((k) => k !== "start" && k !== "end");
  return false;
}
