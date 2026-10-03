// 合成データと期待結果の台帳（T03）の検査。期待値の正しさ（契約からの導き方）は別の担当がレビューで確かめる。
// この試験が確かめるのは、台帳の形、合成の入力が契約の保存の条件を満たすこと、拒否を期待する保存のうち
// 記録だけで判定できる理由がその違反を実際に含むこと、期待の形が契約の状態の表と矛盾しないこと、
// 理由の引用が契約の本文に実在すること、合成例の節をすべて扱っていること、制度のケースの必須の項目。
// 実行: npm test（tests/**/*.test.ts。CIがmacOS・Windows・Linuxで実行する）。単独では node --test tests/fixtures/ledger/ledger.test.ts。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANNUAL_AMOUNT_ITEMS,
  BODY,
  checkEvidenceFile,
  checkFactShape,
  checkRecordStatic,
  checkRefShape,
  checkSpec,
  EVIDENCE_FILE_PREFIX,
  isCalendarYear,
  isIdOf,
  isInstant,
  isLocalDate,
  isObj,
  isYearMonth,
  MASTER_TYPES,
  recordReferences,
  NOTICE_TYPES,
  PAYSLIP_AMOUNT_ITEMS,
  PREFIX,
  RECORD_TYPES,
  recordTypeOfId,
  RUN_PREFIX,
  SPECS,
  type RecordType,
  type StaticCode,
} from "./contract-shape.ts";
import {
  CONTRACTS_DIR,
  expandRecord,
  ledgerFileNames,
  OS_METADATA_FILES_FROM_GITIGNORE,
  readLedgerFiles,
  REPO_ROOT,
  resolveOperations,
  restoredWriteRequestId,
  stableStringify,
  type LedgerFiles,
  type Obj,
} from "./load.ts";

// ---- 拒否の理由（docs/test-oracles/README.mdの「拒否の理由」の表と同じ）

const STATIC_REASONS: ReadonlySet<string> = new Set<StaticCode>([
  "fact-state-not-allowed",
  "value-invalid",
  "list-invalid",
  "ref-granularity",
  "ref-target-invalid",
  "invalid-period",
  "transition-not-allowed",
]);
const SCENARIO_REASONS: ReadonlySet<string> = new Set([
  "ref-target-missing",
  "stale-base-revision",
  "body-change-on-void-or-unvoid",
  "immutable-field-changed",
  "line-id-reused",
  "known-on-in-future",
  "write-request-conflict",
]);
const SEMANTIC_REASONS: ReadonlySet<string> = new Set([
  "supersede-dimension-mismatch",
  "supersede-shape",
  "employment-term-overlap",
  "master-void-referenced",
  "canonical-change-breaks-check",
  "issuer-kind-mismatch",
  "over-allocation",
  "allocation-limit-undeterminable",
  "identity-dimension-mismatch",
  "identity-dimension-undetermined",
  "allocation-sign",
  "confirm-condition-unmet",
  "decision-validation",
  "run-previous-mismatch",
  "run-chain-exists",
  "run-scope-not-allowed",
  "run-scope-noncanonical",
  "run-request-mismatch",
  "run-closure-mismatch",
  "run-snapshot-mismatch",
]);

const ACCEPTANCE_TAGS: readonly string[] = [
  "bank-only",
  "no-double-income",
  "order-independence",
  "correction",
  "unknown-value",
  "same-amount-different",
];

const USAGES = ["not-used", "unresolved", "duplicate-voided", "voided", "superseded", "stale", "needs-recheck", "valid"];
const MISSING_STATES = ["unknown", "not-stated", "undetermined", "conflict", "adoption-needed", "partial-scope", "rule-pending"];
const AGG_STATES = ["complete", "incomplete", "not-applicable", "no-records"];
const COMPARISON_STATES = ["rule-pending", "not-compared", "no-coverage", "incomplete", "match", "mismatch-unresolved", "mismatch-explained"];
const SELECTIONS = ["annual-document", "entered-payslips", "no-annual-document", "adoption-needed"];
const SERIES_STATUSES = ["current", "superseded", "unconfirmed-series", "voided", "not-in-view"];
const ROUNDING_METHODS = ["floor", "ceil", "half-up", "half-down"];
const PROCEDURES = ["withholding", "year-end-adjustment", "tax-return", "levy", "premium", "recognition"];

// 派生キーの表（共通の型の11）: 状態と、refが指す記録の種類。
const DERIVED_KEYS: Readonly<Record<string, { states: readonly string[]; ref: readonly RecordType[]; line?: "line" }>> = {
  "income-year": { states: ["undetermined", "conflict"], ref: ["payslip"] },
  "annual-adoption": { states: ["adoption-needed"], ref: ["employer"] },
  "annual-scope": { states: ["partial-scope"], ref: ["annual-document"] },
  "annual-mapping": { states: ["rule-pending"], ref: ["employer"] },
  "annual-no-counterpart": { states: ["unknown"], ref: ["employer"] },
  "notice-duplicate": { states: ["conflict"], ref: ["official-notice"] },
  "supersede-series": { states: ["conflict"], ref: ["payslip", "annual-document", "official-notice"] },
  "forecast-remaining": { states: ["unknown"], ref: ["forecast"], line: "line" },
  "unreconciled-amount": { states: ["unknown"], ref: ["bank-deposit", "payslip"] },
  "save-check": { states: ["conflict"], ref: RECORD_TYPES },
};

// AggregateKeyの表（共通の型の11）。許すscopeの次元は修飾子で決まる場合がある（allowedDims）。
const AGG_KINDS: Readonly<Record<string, { axis: string; modifiers: Readonly<Record<string, readonly string[]>>; dims: readonly string[] }>> = {
  "deposit-amount": { axis: "deposit-date", modifiers: {}, dims: ["accountIds"] },
  "payslip-item": { axis: "scheduled-pay-date", modifiers: { item: PAYSLIP_AMOUNT_ITEMS }, dims: ["employerIds"] },
  "payslip-by-income-year": { axis: "income-year", modifiers: { item: PAYSLIP_AMOUNT_ITEMS }, dims: ["employerIds"] },
  "annual-value": { axis: "income-year", modifiers: { item: ANNUAL_AMOUNT_ITEMS }, dims: ["employerIds"] },
  "forecast-remaining": {
    axis: "expected-month",
    modifiers: { forecastMeasure: ["gross-pay", "net-pay", "bank-transfer", "deposit-amount"] },
    // 口座で絞れるのはforecastMeasureがdeposit-amountのときだけ（下のallowedDims）。
    dims: ["employerIds"],
  },
  "notice-determination": { axis: "subject-year", modifiers: { noticeType: NOTICE_TYPES, category: ["annual-total"] }, dims: [] },
};

// ---- 契約の文書（引用の検査と、合成例の節の網羅）

export interface ContractDocs {
  sections: Map<string, Map<string, string>>; // doc -> section key -> normalized text
  exampleHeadings: { section: string; subsections: string[] }[];
}

// 引用の照合では、Markdownの記号（コードの`、強調の**、リンクの[文字](先)）と空白を除いて比べる。
function normalize(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, "");
}

function sectionKey(heading: string): string {
  const num = /^(\d+)\./.exec(heading);
  if (num?.[1] !== undefined) return num[1];
  const ex = /^(EX-\d+)/.exec(heading);
  if (ex?.[1] !== undefined) return ex[1];
  return heading.trim();
}

export function readContractDocs(dir: string = CONTRACTS_DIR): ContractDocs {
  const sections = new Map<string, Map<string, string>>();
  const exampleHeadings: { section: string; subsections: string[] }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(dir, file), "utf8");
    const map = new Map<string, string>();
    let key: string | undefined;
    let buf: string[] = [];
    const flush = (): void => {
      if (key !== undefined) map.set(key, normalize(buf.join("\n")));
    };
    // Windowsのcheckoutでは改行がCRLFになりうるので、行は\r?\nで分ける。
    for (const line of text.split(/\r?\n/)) {
      const h2 = /^## (.+)$/.exec(line);
      if (h2?.[1] !== undefined) {
        flush();
        key = sectionKey(h2[1]);
        buf = [line];
        if (file === "examples.md" && /^EX-\d+/.test(h2[1])) exampleHeadings.push({ section: key, subsections: [] });
        continue;
      }
      buf.push(line);
      const h3 = /^### (.+)$/.exec(line);
      if (h3?.[1] !== undefined && file === "examples.md") {
        const last = exampleHeadings[exampleHeadings.length - 1];
        if (last !== undefined && last.section === key) last.subsections.push(h3[1].trim());
      }
    }
    flush();
    sections.set(file, map);
  }
  return { sections, exampleHeadings };
}

// ---- 検査の本体

class Problems {
  readonly list: string[] = [];
  add(where: string, message: string): void {
    this.list.push(`${where}: ${message}`);
  }
}

interface State {
  records: Map<string, Obj[]>;
  createdBy: Map<string, string>;
  evidence: Map<string, Obj>;
  sha: Map<string, string>;
  runs: Map<string, Obj>;
  writeRequests: Map<string, { opId: string; content: string }>;
  importKeys: Map<string, string>;
  seq: number;
}

function newState(): State {
  return {
    records: new Map(),
    createdBy: new Map(),
    evidence: new Map(),
    sha: new Map(),
    runs: new Map(),
    writeRequests: new Map(),
    importKeys: new Map(),
    seq: 0,
  };
}

function cloneState(s: State): State {
  return {
    records: new Map([...s.records].map(([k, v]) => [k, [...v]])),
    createdBy: new Map(s.createdBy),
    evidence: new Map(s.evidence),
    sha: new Map(s.sha),
    runs: new Map(s.runs),
    writeRequests: new Map(s.writeRequests),
    importKeys: new Map(s.importKeys),
    seq: s.seq,
  };
}

function latest(state: State, id: string): Obj | undefined {
  const revs = state.records.get(id);
  return revs === undefined ? undefined : revs[revs.length - 1];
}

function exists(state: State, id: string): boolean {
  return state.records.has(id) || state.evidence.has(id) || state.runs.has(id);
}

// 参照は、契約の型の表でIDかRefの項目だけから取る（摘要・表示名・メモの文字列は、IDに似ていても参照にしない）。
function referencedIds(rec: Obj): Set<string> {
  return new Set(recordReferences(rec).map((r) => r.id));
}

function lineIdsOf(record: Obj): Set<string> {
  const ids = new Set<string>();
  const body = isObj(record["body"]) ? record["body"] : {};
  for (const field of ["lines", "otherEarnings", "otherDeductions", "amounts", "installments", "statusDates"]) {
    let v = body[field];
    if (isObj(v)) v = v["state"] === "known" ? v["value"] : undefined;
    if (Array.isArray(v)) for (const e of v) if (isObj(e) && typeof e["lineId"] === "string") ids.add(e["lineId"]);
  }
  return ids;
}

// 照合配分が行で指せる行のID（共通の型の2の表: 予測の行と、給与明細のotherEarningsの行だけ）。
// lineIdsOfは行IDの予約の検査に使うので、控除の行も含めたまま変えない。
function referableLineIds(record: Obj): Set<string> {
  const ids = new Set<string>();
  const body = isObj(record["body"]) ? record["body"] : {};
  const field = record["recordType"] === "payslip" ? "otherEarnings" : record["recordType"] === "forecast" ? "lines" : undefined;
  if (field === undefined) return ids;
  let v = body[field];
  if (isObj(v)) v = v["state"] === "known" ? v["value"] : undefined;
  if (Array.isArray(v)) for (const e of v) if (isObj(e) && typeof e["lineId"] === "string") ids.add(e["lineId"]);
  return ids;
}

function jstDate(instant: string): string {
  return new Date(Date.parse(instant) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function factStateOf(v: unknown): string | undefined {
  return isObj(v) && typeof v["state"] === "string" ? v["state"] : undefined;
}

// 保存1件の、記録とその記録の前の版だけで決まる違反（静的・場面の違反）の分類を返す。
function saveViolations(state: State, rec: Obj, op: Obj, where: string, problems: Problems): Set<string> {
  const codes = new Set<string>();
  for (const v of checkRecordStatic(rec)) {
    if (v.code === "shape") problems.add(where, `形の誤り（fixtureの誤り）: ${v.path} ${v.message}`);
    else codes.add(v.code);
  }
  const id = String(rec["id"]);
  const reason = rec["reason"];
  const prev = latest(state, id);
  if (reason === "create") {
    if (state.records.has(id)) codes.add("transition-not-allowed");
  } else if (prev === undefined) {
    codes.add("ref-target-missing");
  } else {
    const revision = typeof rec["revision"] === "number" ? rec["revision"] : 0;
    const base = typeof op["baseRevision"] === "number" ? op["baseRevision"] : revision - 1;
    if (revision !== base + 1) problems.add(where, "revisionがbaseRevision＋1でない");
    if (base !== prev["revision"]) codes.add("stale-base-revision");
    const ps = prev["status"];
    if ((reason === "correct-input-error" || reason === "new-information" || reason === "void") && ps !== "active") codes.add("transition-not-allowed");
    if (reason === "unvoid" && ps !== "voided") codes.add("transition-not-allowed");
    if (reason === "void" || reason === "unvoid") {
      if (stableStringify(rec["body"]) !== stableStringify(prev["body"])) codes.add("body-change-on-void-or-unvoid");
      if (stableStringify(rec["knownOn"]) !== stableStringify(prev["knownOn"])) problems.add(where, "取消・取消の取り消しは把握日を引き継ぐ（fixtureの誤り）");
    }
    for (const f of ["recordType", "entryChannel", "importKey"]) {
      if (stableStringify(rec[f]) !== stableStringify(prev[f])) codes.add("immutable-field-changed");
    }
    const all = state.records.get(id) ?? [];
    const prevLines = lineIdsOf(prev);
    const everUsed = new Set<string>();
    for (const r of all) for (const l of lineIdsOf(r)) everUsed.add(l);
    for (const l of lineIdsOf(rec)) if (everUsed.has(l) && !prevLines.has(l)) codes.add("line-id-reused");
  }
  // 把握日（共通の型の7）: 新しく入力する把握日は、保存の時計の日付（Asia/Tokyo）より後にできない。
  const knownOn = rec["knownOn"];
  if (isObj(knownOn) && knownOn["state"] === "known" && typeof knownOn["value"] === "string" && typeof op["at"] === "string") {
    const fresh = reason === "create" || reason === "new-information" || (reason === "correct-input-error" && stableStringify(knownOn) !== stableStringify(prev?.["knownOn"]));
    if (fresh && knownOn["value"] > jstDate(op["at"])) codes.add("known-on-in-future");
  }
  // 参照先の実在（共通の型の2）。duplicateOfの先は、自分以外の有効な記録（9）。
  const refs = referencedIds(rec);
  for (const r of refs) if (r !== id && !exists(state, r)) codes.add("ref-target-missing");
  const dupOf = isObj(rec["duplicateOf"]) && rec["duplicateOf"]["state"] === "known" ? rec["duplicateOf"]["value"] : undefined;
  if (isObj(dupOf) && typeof dupOf["id"] === "string") {
    // 有効な記録＝取消しておらず、整った差し替えの系列の現在の記録（共通の型の9、記録の型の10）。系列は共通の補助でたどる。
    const target = latest(state, dupOf["id"]);
    const lookup = latestLookup(state);
    const series = seriesAmong(lookup, [...state.records.keys()]);
    if (target !== undefined && (target["status"] !== "active" || series.superseded.has(dupOf["id"]) || series.illFormed.has(dupOf["id"]))) {
      codes.add("ref-target-invalid");
    }
  }
  // 照合配分の行を指す参照は、参照先の現在の版にある、その項目が指せる種類の行だけ（共通の型の2）。
  // 給与明細で指せるのは支給の行（otherEarnings）だけ、予測は見込みの行（lines）だけ。控除の行（otherDeductions）は指せない。
  if (rec["recordType"] === "allocation" && isObj(rec["body"])) {
    for (const end of ["from", "to"]) {
      const ref = rec["body"][end];
      if (isObj(ref) && typeof ref["id"] === "string" && typeof ref["line"] === "string" && ref["line"] !== "whole") {
        const target = latest(state, ref["id"]);
        if (target !== undefined && !referableLineIds(target).has(ref["line"])) codes.add("ref-target-invalid");
      }
    }
  }
  return codes;
}

interface ReplayResult {
  state: State;
  deps: Map<string, Set<string>>;
  statesAfter: Map<string, State>;
  opOrder: string[];
}

function replayOps(
  ops: unknown,
  scenarioId: string,
  start: State,
  commonCount: number,
  where: string,
  problems: Problems,
): ReplayResult {
  const state = start;
  const deps = new Map<string, Set<string>>();
  const statesAfter = new Map<string, State>();
  const opOrder: string[] = [];
  if (!Array.isArray(ops)) {
    problems.add(where, "operationsが並びではない");
    return { state, deps, statesAfter, opOrder };
  }
  for (const op of ops) {
    if (!isObj(op) || typeof op["opId"] !== "string") {
      problems.add(where, "opIdのない操作");
      continue;
    }
    const opId = op["opId"];
    const w = `${where} ${opId}`;
    if (opOrder.includes(opId)) problems.add(w, "opIdが重なる");
    opOrder.push(opId);
    if (!isInstant(op["at"])) problems.add(w, "atがInstantではない");
    const expect = isObj(op["expect"]) ? op["expect"] : {};
    const outcome = expect["outcome"];
    const dep = new Set<string>();
    const consume = (): void => {
      state.seq += 1;
      const rs = expect["recordedSeq"];
      if (rs !== undefined) {
        const m = typeof rs === "string" ? /^N\+(\d+)$/.exec(rs) : null;
        if (m?.[1] === undefined || Number(m[1]) !== state.seq - commonCount) problems.add(w, `recordedSeqの期待${String(rs)}が、保存の順（N+${state.seq - commonCount}）と合わない`);
      }
    };
    switch (op["op"]) {
      case "save": {
        if (!isObj(op["record"])) {
          problems.add(w, "recordがない");
          break;
        }
        const compactId = String(op["record"]["id"]);
        let rec: Obj;
        try {
          rec = expandRecord(op["record"], { scenarioId, opId, previous: latest(state, compactId) });
        } catch (e) {
          problems.add(w, `記録を補えない: ${(e as Error).message}`);
          break;
        }
        const id = String(rec["id"]);
        const refs = referencedIds(rec);
        refs.add(id);
        for (const r of refs) {
          const by = state.createdBy.get(r);
          if (by !== undefined) dep.add(by);
        }
        const revOps = state.records.get(id);
        if (revOps !== undefined) for (const r of revOps) dep.add(String(r["__opId"]));
        const codes = saveViolations(state, rec, op, w, problems);
        const wrid = String(rec["writeRequestId"]);
        const content = stableStringify({ ...rec, writeRequestId: undefined });
        const seen = state.writeRequests.get(wrid);
        if (seen !== undefined && seen.content !== content) codes.add("write-request-conflict");
        const replay = seen !== undefined && seen.content === content;
        let importHit: string | undefined;
        if (rec["entryChannel"] === "import" && isObj(rec["importKey"]) && rec["importKey"]["state"] === "known") {
          const k = `${String(rec["recordType"])}|${stableStringify(rec["importKey"]["value"])}`;
          const hit = state.importKeys.get(k);
          if (hit !== undefined && hit !== id) importHit = hit;
        }
        if (outcome === "accepted") {
          if (replay) problems.add(w, "同じwriteRequestIdで同じ内容の保存は、新しい記録を作らない（replayed）");
          if (importHit !== undefined) problems.add(w, `同じimportKeyの記録${importHit}がある（existing-returned）`);
          if (codes.size > 0) problems.add(w, `acceptedを期待するが、契約の保存の条件に当たる: ${[...codes].join(", ")}`);
          const stored = { ...rec, __opId: opId };
          state.records.set(id, [...(state.records.get(id) ?? []), stored]);
          if (!state.createdBy.has(id)) state.createdBy.set(id, opId);
          if (seen === undefined) state.writeRequests.set(wrid, { opId, content });
          if (rec["entryChannel"] === "import" && isObj(rec["importKey"]) && rec["importKey"]["state"] === "known") {
            state.importKeys.set(`${String(rec["recordType"])}|${stableStringify(rec["importKey"]["value"])}`, id);
          }
          consume();
        } else if (outcome === "rejected") {
          const reason = expect["reason"];
          if (typeof reason !== "string" || !(STATIC_REASONS.has(reason) || SCENARIO_REASONS.has(reason) || SEMANTIC_REASONS.has(reason))) {
            problems.add(w, `拒否の理由が表にない: ${String(reason)}`);
          } else if (STATIC_REASONS.has(reason) || SCENARIO_REASONS.has(reason)) {
            if (!codes.has(reason)) problems.add(w, `拒否の理由${reason}を期待するが、記録にその違反がない（見つかったもの: ${[...codes].join(", ") || "なし"}）`);
          } else if (codes.size > 0) {
            problems.add(w, `意味の判定による拒否${reason}を期待するが、記録だけで判定できる違反もある（理由が一意に決まらない）: ${[...codes].join(", ")}`);
          }
        } else if (outcome === "replayed") {
          if (!replay || seen === undefined || expect["of"] !== seen.opId) problems.add(w, "replayedを期待するが、同じwriteRequestIdで同じ内容の先の保存がない");
        } else if (outcome === "existing-returned") {
          if (importHit === undefined || expect["record"] !== importHit) problems.add(w, "existing-returnedを期待するが、同じimportKeyの記録がない");
          const other = [...codes].filter((c) => c !== "transition-not-allowed");
          if (other.length > 0) problems.add(w, `取込の記録に違反がある: ${other.join(", ")}`);
        } else {
          problems.add(w, `outcomeが表にない: ${String(outcome)}`);
        }
        break;
      }
      case "saveEvidenceFile": {
        const file = op["file"];
        for (const v of checkEvidenceFile(file)) problems.add(w, `証憑ファイルの形: ${v.path} ${v.message}`);
        if (!isObj(file)) break;
        const fid = String(file["id"]);
        const hit = state.sha.get(String(file["sha256"]));
        if (outcome === "accepted") {
          if (hit !== undefined) problems.add(w, "同じsha256の証憑ファイルがある（existing-returned）");
          if (state.evidence.has(fid)) problems.add(w, "証憑ファイルのIDが重なる");
          state.evidence.set(fid, file);
          state.sha.set(String(file["sha256"]), fid);
          state.createdBy.set(fid, opId);
          consume();
        } else if (outcome === "existing-returned") {
          if (hit === undefined || expect["record"] !== hit) problems.add(w, "existing-returnedを期待するが、同じsha256の証憑ファイルがない");
        } else problems.add(w, `outcomeが表にない: ${String(outcome)}`);
        break;
      }
      case "restoreUnchecked": {
        if (outcome !== "restored") problems.add(w, "restoreUncheckedのoutcomeはrestored");
        const records = op["records"];
        if (!Array.isArray(op["expectedViolations"])) problems.add(w, "expectedViolationsが並びではない（違反がなければ空の並び）");
        const expected = new Set(Array.isArray(op["expectedViolations"]) ? op["expectedViolations"].map(String) : []);
        const found = new Set<string>();
        if (!Array.isArray(records)) {
          problems.add(w, "recordsが並びではない");
          break;
        }
        for (const [ri, r] of records.entries()) {
          if (!isObj(r)) {
            problems.add(w, `records[${ri}]がobjectではない`);
            continue;
          }
          let rec: Obj;
          const rid = String(r["id"]);
          const rrev = typeof r["revision"] === "number" ? r["revision"] : 1;
          try {
            rec = expandRecord(r, { scenarioId, opId, previous: latest(state, rid), defaultWriteRequestId: restoredWriteRequestId(scenarioId, opId, rid, rrev) });
          } catch (e) {
            problems.add(w, `記録を補えない: ${(e as Error).message}`);
            continue;
          }
          // writeRequestIdはデータベース全体で予約するキー（共通の型の9・10）。復元で置く改訂どうし・既存の保存と重ねない。
          const rwrid = String(rec["writeRequestId"]);
          const rseen = state.writeRequests.get(rwrid);
          if (rseen !== undefined) problems.add(w, `records[${ri}]のwriteRequestId ${rwrid}が、${rseen.opId}の保存と重なる`);
          else state.writeRequests.set(rwrid, { opId: `${opId}/records[${ri}]`, content: stableStringify({ ...rec, writeRequestId: undefined }) });
          // 復元は読取の検査（拡張できる列挙の知らない値は違反にしない。共通の型の1）。新しい保存の拒否はsaveの検査（TC-02-aのo05d）。
          for (const v of checkRecordStatic(rec, "read")) {
            if (v.code === "shape") problems.add(w, `形の誤り（fixtureの誤り）: ${v.path} ${v.message}`);
            else found.add(v.code);
          }
          for (const x of referencedIds(rec)) if (!exists(state, x) && x !== rec["id"]) problems.add(w, `復元する記録の参照先がない: ${x}`);
          const id = String(rec["id"]);
          state.records.set(id, [...(state.records.get(id) ?? []), { ...rec, __opId: opId }]);
          if (!state.createdBy.has(id)) state.createdBy.set(id, opId);
          consume();
        }
        if (stableStringify([...found].sort()) !== stableStringify([...expected].sort())) {
          problems.add(w, `expectedViolations ${[...expected].join(",")} と、記録の違反 ${[...found].join(",")} が合わない`);
        }
        break;
      }
      case "saveRun": {
        const run = op["run"];
        checkRunProjection(run, state, w, problems);
        if (!isObj(run)) break;
        const rid = String(run["id"]);
        const prevRun = isObj(run["previousRunId"]) && run["previousRunId"]["state"] === "known" ? String(run["previousRunId"]["value"]) : undefined;
        if (prevRun !== undefined) {
          const by = state.createdBy.get(prevRun);
          if (by !== undefined) dep.add(by);
        }
        if (outcome === "accepted") {
          if (state.runs.has(rid)) problems.add(w, "runのIDが重なる");
          state.runs.set(rid, run);
          state.createdBy.set(rid, opId);
          consume();
        } else if (outcome === "rejected") {
          const reason = expect["reason"];
          if (typeof reason !== "string" || !SEMANTIC_REASONS.has(reason) || !reason.startsWith("run-")) problems.add(w, `runの拒否の理由が表にない: ${String(reason)}`);
        } else problems.add(w, `outcomeが表にない: ${String(outcome)}`);
        break;
      }
      default:
        problems.add(w, `opが表にない: ${String(op["op"])}`);
    }
    deps.set(opId, dep);
    statesAfter.set(opId, cloneState(state));
  }
  return { state, deps, statesAfter, opOrder };
}

const FACT_JURISDICTION = SPECS.fact({ t: "object", fields: { kind: SPECS.enm("national", "prefecture", "municipality", "insurer"), code: SPECS.text } }, ["known", "unknown"]);

// ---- 鎖のたどり方（検査のコードで共通に使う補助。ほかの場所で現在の記録・正規のIDを別に導かない）
// 見方: 記録のIDから、その見方で選ばれた改訂を返す（なければundefined＝その見方で解決できない）。

type RecordLookup = (id: string) => Obj | undefined;

function latestLookup(state: State): RecordLookup {
  return (id) => latest(state, id);
}

// runに固定した版だけで引く（計算結果の1の「入力の閉包と推移的な固定」）。
function pinnedLookup(state: State, pins: ReadonlyMap<string, number>): RecordLookup {
  return (id) => {
    const r = pins.get(id);
    return r === undefined ? undefined : state.records.get(id)?.[r - 1];
  };
}

function knownRefId(v: unknown): string | undefined {
  return isObj(v) && v["state"] === "known" && isObj(v["value"]) && typeof v["value"]["id"] === "string" ? v["value"]["id"] : undefined;
}

// 共通の型の9の正規のID: 二重登録の取消（duplicateOf）をたどり、最初に着いた取消していない記録のID。
// 鎖の途中をその見方で解決できなければundefined。
function canonicalIdOf(lookup: RecordLookup, id: string): string | undefined {
  const seen = new Set<string>();
  let cur = id;
  for (;;) {
    const rec = lookup(cur);
    if (rec === undefined) return undefined;
    const next = rec["status"] === "voided" ? knownRefId(rec["duplicateOf"]) : undefined;
    if (next === undefined || seen.has(cur)) return cur;
    seen.add(cur);
    cur = next;
  }
}

// 記録の型の10の1: 取消していない記録Xが差し替える記録。Xのsupersedesをたどり、取消した記録は通り過ぎて
// （その最新の改訂＝その見方の改訂のsupersedesをさらにたどる）、最初に着いた取消していない記録。
// 何も差し替えなければnull、その見方で解決できない参照に着けば"unresolved"。
function supersededTarget(lookup: RecordLookup, x: Obj): string | null | "unresolved" {
  if (x["status"] !== "active" || !isObj(x["body"])) return null;
  const seen = new Set<string>();
  let next = knownRefId(x["body"]["supersedes"]);
  while (next !== undefined) {
    if (seen.has(next)) return "unresolved";
    seen.add(next);
    const rec = lookup(next);
    if (rec === undefined) return "unresolved";
    if (rec["status"] === "active") return next;
    next = isObj(rec["body"]) ? knownRefId(rec["body"]["supersedes"]) : undefined;
  }
  return null;
}

// 共通の型の13の4×4の表。値は{ state, value }（Factでない値はknownとして渡す）。
type Cmp = "match" | "mismatch" | "undetermined";
function compareFacts(a: { state: string; value?: unknown }, b: { state: string; value?: unknown }): Cmp {
  const open = (x: string): boolean => x === "unknown" || x === "not-stated";
  if (open(a.state) || open(b.state)) return "undetermined";
  if (a.state === "not-applicable" || b.state === "not-applicable") return a.state === b.state ? "match" : "mismatch";
  return stableStringify(a.value) === stableStringify(b.value) ? "match" : "mismatch";
}

function asFact(v: unknown): { state: string; value?: unknown } {
  return isObj(v) && typeof v["state"] === "string" ? (v["state"] === "known" ? { state: "known", value: v["value"] } : { state: v["state"] }) : { state: "known", value: v };
}

// 記録の型の10の「差し替えの識別の次元」を、見方の版と正規のIDで比べる。マスタのIDは正規のIDに解決してから比べる。
const SUPERSEDE_DIMENSIONS: Readonly<Record<string, readonly { field: string; master?: true }[]>> = {
  payslip: [{ field: "employerId", master: true }, { field: "paymentKind" }, { field: "scheduledPayDate" }],
  "annual-document": [{ field: "payerEmployerId", master: true }, { field: "documentType" }, { field: "targetYear" }],
  "official-notice": [{ field: "issuerId", master: true }, { field: "noticeType" }, { field: "subjectYear" }],
};

function supersedeDimensions(lookup: RecordLookup, x: Obj, y: Obj): Cmp {
  const dims = SUPERSEDE_DIMENSIONS[String(x["recordType"])] ?? [];
  const bx = isObj(x["body"]) ? x["body"] : {};
  const by = isObj(y["body"]) ? y["body"] : {};
  let result: Cmp = "match";
  for (const d of dims) {
    let fx = asFact(bx[d.field]);
    let fy = asFact(by[d.field]);
    if (d.master === true) {
      const canon = (f: { state: string; value?: unknown }): { state: string; value?: unknown } =>
        f.state === "known" && typeof f.value === "string" ? { state: "known", value: canonicalIdOf(lookup, f.value) ?? f.value } : f;
      fx = canon(fx);
      fy = canon(fy);
    }
    const c = compareFacts(fx, fy);
    if (c === "mismatch") return "mismatch";
    if (c === "undetermined") result = "undetermined";
  }
  return result;
}

// 記録の型の10の1〜5: 与えた記録（その見方の版）から差し替えの関係と系列を作り、
// 差し替え済みの記録（現在の記録でないもの）と、整っていない系列（未確認の系列を含む）のすべての記録を返す。
// 整っていない系列: その見方で解決できない参照、自己参照・循環（取消していない記録どうしの関係を含め、長さによらない）、
// 分岐、差し替えの識別の次元が一致でない（未確定・不一致）関係を含む系列。
// 関係は記録ごとに差し替える先が1件以下なので、つながった記録の集まりが1本の鎖なら関係の数は記録の数より1少ない。
// 関係の数が記録の数以上の集まりは循環（自己参照を含む）を持つので、系列全体を整っていない系列にする。
// runの不足の判断・二重登録の取消の残す方・系列の状態の期待値は、どれもこの補助の結果だけを使う（入口ごとに系列の判定を変えない）。
// linkLookupを渡すと、その見方で選ばれない記録（runに固定していない記録等）も、保存されている記録のsupersedesのつながりで
// 同じ系列に入れる（選ばれない記録をはさむ系列を広く取り、黙って数える記録を減らす。記録の型の10の「時点を指定した見方」）。
function seriesAmong(lookup: RecordLookup, ids: readonly string[], linkLookup?: RecordLookup): { superseded: Set<string>; illFormed: Set<string> } {
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };
  const union = (a: string, b: string): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  const superseded = new Set<string>();
  const broken = new Set<string>();
  const targets = new Map<string, string>();
  const relations: string[] = [];
  for (const id of ids) {
    const x = lookup(id);
    if (x === undefined || x["status"] !== "active") continue;
    if (!parent.has(id)) parent.set(id, id);
    const t = supersededTarget(lookup, x);
    if (t === null) continue;
    if (t === "unresolved") {
      broken.add(id);
      if (linkLookup !== undefined) {
        const seen = new Set<string>();
        let n = isObj(x["body"]) ? knownRefId(x["body"]["supersedes"]) : undefined;
        while (n !== undefined && !seen.has(n)) {
          seen.add(n);
          union(id, n);
          const r = linkLookup(n);
          n = r !== undefined && isObj(r["body"]) ? knownRefId(r["body"]["supersedes"]) : undefined;
        }
      }
      continue;
    }
    union(id, t);
    relations.push(id);
    if (targets.has(t)) broken.add(t);
    targets.set(t, id);
    const y = lookup(t);
    if (y === undefined || supersedeDimensions(lookup, x, y) !== "match") broken.add(id);
    superseded.add(t);
  }
  const badRoots = new Set([...broken].map(find));
  // 自己参照・循環: 集まりごとに関係と記録を数え、関係が記録より少なくなければ循環がある。
  const count = (keys: Iterable<string>): Map<string, number> => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(find(k), (m.get(find(k)) ?? 0) + 1);
    return m;
  };
  const nodes = count(parent.keys());
  for (const [root, n] of count(relations)) if (n >= (nodes.get(root) ?? 0)) badRoots.add(root);
  const illFormed = new Set([...parent.keys()].filter((id) => badRoots.has(find(id))));
  return { superseded, illFormed };
}

function inScope(list: unknown, id: string): boolean {
  return !Array.isArray(list) || list.length === 0 || list.includes(id);
}

// 計算結果の2: 必要な入力が足りなければincomplete。computed・provisionalのrunの射影について、要求ごとに、
// その要求の範囲・日付の軸・支払者（口座）に当たる固定した記録の、その要求の項目だけで不足を判断する
// （要求の項目や対象の記録を混ぜない。必要な集合は要求から独立に導く。原因台帳のPR11-R011・PR23-R004）。
// 対象を固定した記録だけで決められる要求（payslip-item・deposit-amount）だけを判断する。帰属・採用・実績化・正式通知の類を
// 導く要求（payslip-by-income-year・annual-value・forecast-remaining・notice-determination）は、この検査では判断しない。
function checkComputedRunInputs(run: Obj, state: State, w: string, problems: Problems): void {
  if (run["status"] !== "computed" && run["status"] !== "provisional") return;
  const requests = Array.isArray(run["requests"]) ? run["requests"] : [];
  const pins = new Map<string, number>();
  for (const r of Array.isArray(run["inputsRecords"]) ? run["inputsRecords"] : []) {
    if (isObj(r) && typeof r["id"] === "string" && typeof r["revision"] === "number") pins.set(r["id"], r["revision"]);
  }
  const lookup = pinnedLookup(state, pins);
  const inputs = [...pins].map(([id, revision]) => ({ id, revision, rec: lookup(id) }));
  // 固定した版だけで差し替えの系列をたどり、現在の記録でない記録（差し替え済み）は集計の対象にしない（記録の型の10）。
  // 取消した中間の記録は通り過ぎる。整っていない系列（固定した版でたどれない参照、未確定・不一致の識別の次元等）の記録は、
  // 系列全体を集計から除いてconflictで挙げる記録なので、要求の範囲にあれば不足とする。
  const { superseded, illFormed } = seriesAmong(lookup, [...pins.keys()], latestLookup(state));
  const canonical = (id: string): string => canonicalIdOf(lookup, id) ?? id;
  requests.forEach((req, ri) => {
    const key = isObj(req) && isObj(req["key"]) ? req["key"] : undefined;
    const scope = isObj(req) && isObj(req["scope"]) ? req["scope"] : undefined;
    if (key === undefined || scope === undefined) return;
    const from = String(scope["from"]);
    const to = String(scope["to"]);
    let targetType: string;
    let item: string;
    let dateField: string;
    let dimension: (body: Obj) => boolean;
    if (key["kind"] === "payslip-item" && typeof key["item"] === "string") {
      targetType = "payslip";
      item = key["item"];
      dateField = "scheduledPayDate";
      dimension = (body) => typeof body["employerId"] === "string" && inScope(scope["employerIds"], canonical(body["employerId"]));
    } else if (key["kind"] === "deposit-amount") {
      targetType = "bank-deposit";
      item = "amount";
      dateField = "depositDate";
      dimension = (body) => typeof body["accountId"] === "string" && inScope(scope["accountIds"], canonical(body["accountId"]));
    } else return;
    for (const input of inputs) {
      const rec = input.rec;
      if (rec === undefined || rec["recordType"] !== targetType || rec["status"] !== "active" || (superseded.has(input.id) && !illFormed.has(input.id)) || !isObj(rec["body"])) continue;
      const body = rec["body"];
      // 範囲の判定（支払者・日付の軸）を先にし、既知の日付で要求の範囲の外と確定できる記録は、系列が整っていなくても
      // その要求の不足にしない（記録の型の10の5の「除いた記録が入るはずだった集計」だけをincompleteにする。PR23-R004）。
      if (!dimension(body)) continue;
      const date = body[dateField];
      const ds = factStateOf(date);
      // 日付の軸の日付が分からない記録は、その要求の範囲から外せない（照合の規則の2の「日付不明」）。
      if (ds !== "known") {
        problems.add(w, `${String(run["status"])}のrunのrequests[${ri}]（${String(key["kind"])}・${item}）の範囲に、${dateField}が${String(ds)}の${input.id}版${input.revision}がある（分からない入力）`);
        continue;
      }
      const d = isObj(date) ? String(date["value"]) : "";
      if (d < from || d > to) continue;
      if (illFormed.has(input.id)) {
        problems.add(w, `${String(run["status"])}のrunのrequests[${ri}]の対象の${input.id}版${input.revision}が、整っていない差し替えの系列（固定した版でたどれない・自己参照・循環・分岐・未確認の系列）にある（分からない入力）`);
        continue;
      }
      const st = factStateOf(body[item]);
      if (st === "unknown" || st === "not-stated") {
        problems.add(w, `${String(run["status"])}のrunのrequests[${ri}]（${String(key["kind"])}・${item}）が、分からない入力（${input.id}版${input.revision}の${item}が${st}）を要求している`);
      }
    }
  });
}

// 計算結果の3の「runの履歴」: jurisdictionがknownでない、referencePointがunknown、scopeがunknownのrunは目的が決まらない。
function runPurposeDetermined(run: Obj): boolean {
  const target = isObj(run["target"]) ? run["target"] : {};
  return factStateOf(target["jurisdiction"]) === "known" && factStateOf(target["referencePoint"]) !== "unknown" && factStateOf(target["scope"]) === "known";
}

function checkRunProjection(run: unknown, state: State, w: string, problems: Problems): void {
  if (!isObj(run)) {
    problems.add(w, "runがない");
    return;
  }
  if (!isIdOf(run["id"], RUN_PREFIX)) problems.add(w, "runのIDではない");
  const calc = run["calculator"];
  if (!isObj(calc) || typeof calc["id"] !== "string" || typeof calc["version"] !== "string") problems.add(w, "calculatorは{ id, version }");
  if (typeof run["calculatorAllowsPayers"] !== "boolean") problems.add(w, "calculatorAllowsPayersがない");
  if (!isInstant(run["createdAt"])) problems.add(w, "createdAtがInstantではない");
  const target = run["target"];
  if (!isObj(target)) {
    problems.add(w, "targetがない");
  } else {
    const y = target["year"];
    if (!isObj(y) || (y["kind"] !== "calendar" && y["kind"] !== "fiscal") || !isCalendarYear(y["year"])) problems.add(w, "target.yearの形");
    for (const v of checkSpec(FACT_JURISDICTION, target["jurisdiction"], "target.jurisdiction")) problems.add(w, `${v.path} ${v.message}`);
    if (typeof target["procedure"] !== "string" || !PROCEDURES.includes(target["procedure"])) problems.add(w, "target.procedure");
    const rp = target["referencePoint"];
    const rpState = factStateOf(rp);
    if (target["procedure"] === "levy" ? rpState !== "not-applicable" : rpState !== "known" && rpState !== "unknown") problems.add(w, "target.referencePointの状態（手続と基準の時点）");
    const scope = target["scope"];
    const ss = factStateOf(scope);
    if (ss !== "known" && ss !== "unknown") problems.add(w, "target.scopeはknownかunknownだけ");
    if (isObj(scope) && ss === "known") {
      const v = scope["value"];
      if (!isObj(v) || (v["kind"] !== "all-payers" && v["kind"] !== "payers")) problems.add(w, "target.scopeのkind");
      else if (v["kind"] === "payers") {
        const payers = v["payers"];
        if (!Array.isArray(payers) || payers.length === 0 || new Set(payers).size !== payers.length || !payers.every((p) => isIdOf(p, "emp"))) {
          problems.add(w, "target.scopeのpayersは空でなく、同じ支払者を2回含まない雇用先のID");
        }
      }
    }
    if (!isObj(target["scopeNote"])) problems.add(w, "target.scopeNoteがない");
  }
  if (!["computed", "provisional", "incomplete", "unsupported", "failed"].includes(String(run["status"]))) problems.add(w, "status");
  if (!["fixed", "not-fixed"].includes(String(run["inputStage"]))) problems.add(w, "inputStage");
  if (run["inputStage"] === "not-fixed" && !["failed", "unsupported"].includes(String(run["status"]))) problems.add(w, "not-fixedはfailed・unsupportedだけ");
  const prev = run["previousRunId"];
  const ps = factStateOf(prev);
  if (ps !== "known" && ps !== "not-applicable") problems.add(w, "previousRunIdはknownかnot-applicable");
  if (run["requests"] !== undefined) checkRequests({ state, where: w, problems, commonCount: 0 }, run["requests"]);
  checkComputedRunInputs(run, state, w, problems);
  for (const field of ["inputsRecords", "explanationRefs"]) {
    const list = run[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      problems.add(w, `${field}が並びではない`);
      continue;
    }
    for (const r of list) {
      if (!isObj(r) || typeof r["id"] !== "string" || typeof r["revision"] !== "number") {
        problems.add(w, `${field}の要素は{ id, revision }`);
        continue;
      }
      const revs = state.records.get(r["id"]);
      if (revs === undefined || r["revision"] < 1 || r["revision"] > revs.length) problems.add(w, `${field}の${r["id"]}版${r["revision"]}がない`);
    }
  }
}

// ---- 検査（checks）

interface CheckCtx {
  state: State;
  where: string;
  problems: Problems;
  commonCount: number;
}

function requireRecord(ctx: CheckCtx, id: unknown, types?: readonly RecordType[]): void {
  if (typeof id !== "string" || !ctx.state.records.has(id)) {
    ctx.problems.add(ctx.where, `検査が指す記録がない: ${String(id)}`);
    return;
  }
  const t = recordTypeOfId(id);
  if (types !== undefined && (t === undefined || !types.includes(t))) ctx.problems.add(ctx.where, `検査が指す記録の種類が違う: ${id}`);
}

function checkFact(ctx: CheckCtx, v: unknown, of: Parameters<typeof checkFactShape>[1], path: string): void {
  for (const x of checkFactShape(v, of, path)) ctx.problems.add(ctx.where, `${x.path} ${x.message}`);
}

function checkSeqLabel(v: unknown): boolean {
  return typeof v === "string" && /^N(\+\d+)?$/.test(v);
}

// checkのviewが現在の見方（省略、またはkindがcurrent）か。afterOpの時点の最新の改訂から導いた値と比べてよいのは、この見方だけ。
function isCurrentView(view: unknown): boolean {
  return view === undefined || (isObj(view) && view["kind"] === "current");
}

function checkView(ctx: CheckCtx, view: unknown): void {
  if (view === undefined) return;
  if (!isObj(view)) {
    ctx.problems.add(ctx.where, "viewの形");
    return;
  }
  const k = view["kind"];
  if (k === "current") return;
  if (k === "record-seq" && checkSeqLabel(view["seq"])) return;
  if (k === "record-time" && isInstant(view["time"])) return;
  if (k === "known-on" && isLocalDate(view["date"])) return;
  ctx.problems.add(ctx.where, `viewが表にない: ${stableStringify(view)}`);
}

function axisValueOk(axis: string, v: unknown): boolean {
  if (axis === "deposit-date" || axis === "scheduled-pay-date") return isLocalDate(v);
  if (axis === "expected-month") return isYearMonth(v);
  if (axis === "income-year") return isCalendarYear(v);
  if (axis === "subject-year") return isObj(v) && (v["kind"] === "calendar" || v["kind"] === "fiscal") && isCalendarYear(v["year"]);
  return false;
}

function axisOrder(axis: string, v: unknown): string {
  if (axis === "subject-year" && isObj(v)) return String(v["year"]);
  return String(v);
}

// 共通の型の11の「許すscopeの次元」: forecast-remainingは、gross-pay・net-pay・bank-transferはemployerIdsだけ、
// deposit-amountはemployerIdsとaccountIds。
function allowedDims(key: Obj): readonly string[] {
  const spec = AGG_KINDS[String(key["kind"])];
  if (spec === undefined) return [];
  if (key["kind"] === "forecast-remaining" && key["forecastMeasure"] === "deposit-amount") return ["employerIds", "accountIds"];
  return spec.dims;
}

function checkAggregateKey(ctx: CheckCtx, query: Obj, allowRejected: boolean): string | undefined {
  const key = query["key"];
  if (!isObj(key) || typeof key["kind"] !== "string" || AGG_KINDS[key["kind"]] === undefined) {
    ctx.problems.add(ctx.where, "AggregateKeyのkindが表にない");
    return undefined;
  }
  const spec = AGG_KINDS[key["kind"]];
  if (spec === undefined) return undefined;
  for (const [m, values] of Object.entries(spec.modifiers)) {
    if (typeof key[m] !== "string" || !values.includes(key[m])) ctx.problems.add(ctx.where, `修飾子${m}が表にない: ${String(key[m])}`);
  }
  for (const k of Object.keys(key)) if (k !== "kind" && !(k in spec.modifiers)) ctx.problems.add(ctx.where, `余分な修飾子: ${k}`);
  if (query["axis"] !== spec.axis && !allowRejected) ctx.problems.add(ctx.where, `kind ${key["kind"]}の軸は${spec.axis}`);
  const scope = query["scope"];
  if (!isObj(scope)) {
    ctx.problems.add(ctx.where, "scopeがない");
    return key["kind"];
  }
  for (const dim of ["employerIds", "accountIds"]) {
    const list = scope[dim];
    if (!Array.isArray(list)) {
      ctx.problems.add(ctx.where, `scope.${dim}が並びではない`);
      continue;
    }
    if (list.length > 0 && !allowedDims(key).includes(dim) && !allowRejected) ctx.problems.add(ctx.where, `kind ${key["kind"]}（${stableStringify(key)}）に許さない次元${dim}`);
    for (const x of list) requireRecord(ctx, x, dim === "employerIds" ? ["employer"] : ["account"]);
  }
  if (!axisValueOk(spec.axis, scope["from"]) || !axisValueOk(spec.axis, scope["to"])) ctx.problems.add(ctx.where, "scope.from・toの型が軸に合わない");
  else if (axisOrder(spec.axis, scope["from"]) > axisOrder(spec.axis, scope["to"])) ctx.problems.add(ctx.where, "scope.fromがtoより後");
  if (spec.axis === "subject-year" && isObj(scope["from"]) && isObj(scope["to"]) && scope["from"]["kind"] !== scope["to"]["kind"]) {
    ctx.problems.add(ctx.where, "暦年と年度を1つの範囲にしない");
  }
  return key["kind"];
}

function checkMissingRow(ctx: CheckCtx, row: unknown, i: number): string | undefined {
  const w = `missing[${i}]`;
  if (!isObj(row)) {
    ctx.problems.add(ctx.where, `${w}の形`);
    return undefined;
  }
  for (const v of checkRefShape(row["ref"], `${w}.ref`, "integer")) ctx.problems.add(ctx.where, `${v.path} ${v.message}`);
  const ref = isObj(row["ref"]) ? row["ref"] : {};
  const id = typeof ref["id"] === "string" ? ref["id"] : "";
  const revs = ctx.state.records.get(id);
  if (revs === undefined) ctx.problems.add(ctx.where, `${w}の記録がない: ${id}`);
  else if (typeof ref["revision"] === "number" && ref["revision"] > revs.length) ctx.problems.add(ctx.where, `${w}の版${ref["revision"]}がない: ${id}`);
  const type = recordTypeOfId(id);
  const field = row["field"];
  const state = row["state"];
  if (typeof state !== "string" || !MISSING_STATES.includes(state)) ctx.problems.add(ctx.where, `${w}.stateがMissingStateではない`);
  if (!isObj(field)) {
    ctx.problems.add(ctx.where, `${w}.fieldの形`);
    return undefined;
  }
  if (field["kind"] === "record-item") {
    const name = String(field["name"]);
    const [top, sub] = name.split(".");
    const spec = type === undefined || top === undefined ? undefined : BODY[type][top];
    let ok = spec !== undefined;
    if (spec !== undefined && sub !== undefined) {
      const list = spec.t === "fact" ? spec.of : spec;
      ok = list.t === "list" && list.of.t === "object" && sub in list.of.fields;
    }
    if (!ok) ctx.problems.add(ctx.where, `${w}.field.nameが記録の型の表にない: ${name}`);
    if (state !== "unknown" && state !== "not-stated") ctx.problems.add(ctx.where, `${w}: 記録の項目の不足はunknown・not-stated`);
  } else if (field["kind"] === "derived") {
    const d = DERIVED_KEYS[String(field["key"])];
    if (d === undefined) ctx.problems.add(ctx.where, `${w}.field.keyが派生キーの表にない`);
    else {
      if (!d.states.includes(String(state))) ctx.problems.add(ctx.where, `${w}: 派生キー${String(field["key"])}の状態は${d.states.join("・")}`);
      if (type === undefined || !d.ref.includes(type)) ctx.problems.add(ctx.where, `${w}: 派生キー${String(field["key"])}のrefの種類が違う`);
      if (d.line === "line" && ref["line"] === "whole") ctx.problems.add(ctx.where, `${w}: 派生キー${String(field["key"])}は行を指す`);
    }
  } else ctx.problems.add(ctx.where, `${w}.field.kindはrecord-item・derived（集計値の不足）`);
  return `${id}|${String(ref["line"])}|${stableStringify(field)}`;
}

function checkAggregate(ctx: CheckCtx, query: Obj, expect: Obj): void {
  const allowRejected = expect["error"] === "rejected-request";
  const kind = checkAggregateKey(ctx, query, allowRejected);
  if ("error" in expect) {
    if (expect["error"] !== "overflow" && expect["error"] !== "rejected-request") ctx.problems.add(ctx.where, "errorはoverflow・rejected-request");
    return;
  }
  const values = expect["values"];
  if (!Array.isArray(values) || values.length === 0) {
    ctx.problems.add(ctx.where, "values（集計値の並び）がない");
    return;
  }
  if (values.length > 1 && kind !== "annual-value") ctx.problems.add(ctx.where, "coverageで分けた並びはannual-valueだけ");
  const coverages = new Set<string>();
  values.forEach((v, i) => {
    if (!isObj(v)) {
      ctx.problems.add(ctx.where, `values[${i}]がobjectではない（集計値の形）`);
      return;
    }
    const st = v["state"];
    if (typeof st !== "string" || !AGG_STATES.includes(st)) ctx.problems.add(ctx.where, `values[${i}].stateが表にない`);
    const sum = v["knownSum"];
    if (typeof sum !== "number" || !Number.isSafeInteger(sum)) ctx.problems.add(ctx.where, `values[${i}].knownSumが整数ではない`);
    const missing = Array.isArray(v["missing"]) ? v["missing"] : undefined;
    if (missing === undefined) ctx.problems.add(ctx.where, `values[${i}].missingがない`);
    const keys = new Set<string>();
    (missing ?? []).forEach((row, j) => {
      const k = checkMissingRow(ctx, row, j);
      if (k !== undefined) {
        if (keys.has(k)) ctx.problems.add(ctx.where, `values[${i}].missingで、refとfieldの組が重なる`);
        keys.add(k);
      }
    });
    // 共通の型の11の状態の表と、除くと0を分ける規則。
    if ((st === "incomplete") !== ((missing?.length ?? 0) > 0)) ctx.problems.add(ctx.where, `values[${i}]: incompleteとmissingの有無が合わない`);
    if ((st === "no-records" || st === "not-applicable") && sum !== 0) ctx.problems.add(ctx.where, `values[${i}]: ${String(st)}のknownSumは0`);
    if ("coverage" in v) {
      const c = v["coverage"];
      checkFact(ctx, c, SPECS.enm("annual-document", "entered-records-only"), `values[${i}].coverage`);
      const cs = factStateOf(c);
      if (cs !== "known" && cs !== "not-applicable") ctx.problems.add(ctx.where, `values[${i}].coverageはknownかnot-applicable`);
      // 共通の型の11（契約版2.0）: coverageはannual-valueだけ。payslip-by-income-yearを含むほかのkindはnot-applicable。
      if (kind !== "annual-value" && cs !== "not-applicable") ctx.problems.add(ctx.where, "annual-value以外のcoverageはnot-applicable");
      coverages.add(stableStringify(c));
    } else if (kind === "annual-value") ctx.problems.add(ctx.where, `values[${i}]: annual-valueのcoverageを書く`);
  });
  if (values.length > 1 && coverages.size !== values.length) ctx.problems.add(ctx.where, "coverageで分けた集計値のcoverageが重なる");
}

function checkYearRanges(ctx: CheckCtx, v: unknown): void {
  if (!Array.isArray(v) || v.length === 0) {
    ctx.problems.add(ctx.where, "candidateYearsは空でない範囲の並び");
    return;
  }
  let prevTo: number | null | undefined;
  v.forEach((r, i) => {
    if (!isObj(r)) {
      ctx.problems.add(ctx.where, `candidateYears[${i}]がobjectではない（{ from, to }の範囲）`);
      prevTo = undefined;
      return;
    }
    const from = r["from"];
    const to = r["to"];
    const okEnd = (x: unknown): boolean => x === null || isCalendarYear(x);
    if (!okEnd(from) || !okEnd(to)) ctx.problems.add(ctx.where, `candidateYears[${i}]の端は年かnull`);
    if (typeof from === "number" && typeof to === "number" && from > to) ctx.problems.add(ctx.where, `candidateYears[${i}]のfromがtoより後`);
    if (i > 0 && (prevTo === null || (typeof prevTo === "number" && (from === null || (typeof from === "number" && from <= prevTo + 1))))) {
      ctx.problems.add(ctx.where, "candidateYearsは重ならず、つながらない範囲を年の順に並べる");
    }
    prevTo = to === null || typeof to === "number" ? to : undefined;
  });
}

function checkPairs(ctx: CheckCtx, pairs: unknown, recordType: string): void {
  if (!Array.isArray(pairs)) {
    ctx.problems.add(ctx.where, "pairsが並びではない");
    return;
  }
  const seen = new Set<string>();
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || typeof p[1] !== "string" || !(p[0] < p[1])) {
      ctx.problems.add(ctx.where, "pairsの要素は[小さいID, 大きいID]");
      continue;
    }
    for (const x of p) requireRecord(ctx, x, [recordType as RecordType]);
    const k = `${p[0]}|${p[1]}`;
    if (seen.has(k)) ctx.problems.add(ctx.where, "pairsが重なる");
    seen.add(k);
  }
}

function checkIdList(ctx: CheckCtx, v: unknown, name: string): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) ctx.problems.add(ctx.where, `${name}はIDの並び`);
}

function checkPinnedList(ctx: CheckCtx, v: unknown, name: string, prefix: string | undefined, extra?: { field: string; values: readonly string[] }): void {
  if (!Array.isArray(v)) {
    ctx.problems.add(ctx.where, `${name}が並びではない`);
    return;
  }
  const ids = new Set<string>();
  for (const e of v) {
    if (!isObj(e) || typeof e["id"] !== "string" || typeof e["revision"] !== "number") {
      ctx.problems.add(ctx.where, `${name}の要素は{ id, revision }`);
      continue;
    }
    const revs = ctx.state.records.get(e["id"]);
    if (revs === undefined || e["revision"] < 1 || e["revision"] > revs.length) ctx.problems.add(ctx.where, `${name}の${e["id"]}版${e["revision"]}がない`);
    if (prefix !== undefined ? !isIdOf(e["id"], prefix) : isIdOf(e["id"], "alc") || isIdOf(e["id"], "dcs")) ctx.problems.add(ctx.where, `${name}に置けない種類: ${e["id"]}`);
    if (ids.has(e["id"])) ctx.problems.add(ctx.where, `${name}で同じ記録を2つの版で持つ`);
    ids.add(e["id"]);
    if (extra !== undefined && !extra.values.includes(String(e[extra.field]))) ctx.problems.add(ctx.where, `${name}の${extra.field}が表にない`);
  }
}

function checkRequests(ctx: CheckCtx, requests: unknown): void {
  if (!Array.isArray(requests)) {
    ctx.problems.add(ctx.where, "requestsが並びではない");
    return;
  }
  for (const r of requests) {
    if (!isObj(r) || r["kind"] !== "aggregate") {
      ctx.problems.add(ctx.where, "requestsの要素は{ kind: aggregate, key, axis, scope }");
      continue;
    }
    checkAggregateKey(ctx, r, false);
  }
}

// 計算結果の1のAdoptionSnapshot。adoptedRefとcoverageの状態は選択で1つに決まる（共通の型の12）。
// adoptedRefはFact<Ref>で、年間資料を採用した場合はknown・整数の版・line wholeの年間資料の参照（共通の型の2の表）。
function checkAdoptionSnapshot(ctx: CheckCtx, a: unknown, w: string): void {
  if (!isObj(a)) {
    ctx.problems.add(ctx.where, `${w}がobjectではない（AdoptionSnapshot）`);
    return;
  }
  const keys = ["year", "payers", "selection", "adoptedRef", "coverage", "comparisons"];
  for (const k of keys) if (!(k in a)) ctx.problems.add(ctx.where, `${w}.${k}がない`);
  for (const k of Object.keys(a)) if (!keys.includes(k)) ctx.problems.add(ctx.where, `${w}に表にない項目: ${k}`);
  if (!isCalendarYear(a["year"])) ctx.problems.add(ctx.where, `${w}.yearが年ではない`);
  const payers = a["payers"];
  if (!Array.isArray(payers) || payers.length === 0 || new Set(payers).size !== payers.length) ctx.problems.add(ctx.where, `${w}.payersは空でなく、同じ支払者を2回含まない`);
  else payers.forEach((p) => requireRecord(ctx, p, ["employer"]));
  const selection = String(a["selection"]);
  if (!SELECTIONS.includes(selection)) ctx.problems.add(ctx.where, `${w}.selectionが表にない`);
  const adopted = a["adoptedRef"];
  const as = factStateOf(adopted);
  if (selection === "annual-document") {
    if (as !== "known" || !isObj(adopted)) ctx.problems.add(ctx.where, `${w}.adoptedRefは、annual-documentならknownのFact<Ref>`);
    else {
      for (const v of checkRefShape(adopted["value"], `${w}.adoptedRef.value`, "integer")) ctx.problems.add(ctx.where, `${v.path} ${v.message}`);
      const ref = adopted["value"];
      if (isObj(ref)) {
        if (ref["line"] !== "whole") ctx.problems.add(ctx.where, `${w}.adoptedRefのlineはwholeだけ`);
        requireRecord(ctx, ref["id"], ["annual-document"]);
        const revs = ctx.state.records.get(String(ref["id"]));
        if (revs !== undefined && typeof ref["revision"] === "number" && ref["revision"] > revs.length) ctx.problems.add(ctx.where, `${w}.adoptedRefの版がない`);
      }
    }
  } else if (as !== "not-applicable") ctx.problems.add(ctx.where, `${w}.adoptedRefは、annual-document以外ならnot-applicable`);
  const coverage = a["coverage"];
  const cs = factStateOf(coverage);
  const cv = isObj(coverage) ? coverage["value"] : undefined;
  const expectedCoverage = selection === "annual-document" ? "annual-document" : selection === "adoption-needed" ? undefined : "entered-records-only";
  if (expectedCoverage === undefined ? cs !== "not-applicable" : cs !== "known" || cv !== expectedCoverage) {
    ctx.problems.add(ctx.where, `${w}.coverageは選択${selection}に合わない（共通の型の12）`);
  }
  const comparisons = a["comparisons"];
  if (!Array.isArray(comparisons)) ctx.problems.add(ctx.where, `${w}.comparisonsが並びではない`);
  else {
    if (selection !== "annual-document" && comparisons.length > 0) ctx.problems.add(ctx.where, `${w}.comparisonsは、annual-document以外なら空`);
    const fields = new Set<string>();
    comparisons.forEach((c, j) => {
      if (!isObj(c) || !ANNUAL_AMOUNT_ITEMS.includes(String(c["field"])) || !COMPARISON_STATES.includes(String(c["state"]))) {
        ctx.problems.add(ctx.where, `${w}.comparisons[${j}]は{ field, state }`);
        return;
      }
      if (fields.has(String(c["field"]))) ctx.problems.add(ctx.where, `${w}.comparisonsで同じfieldが2回`);
      fields.add(String(c["field"]));
    });
  }
}

function checkOne(ctx: CheckCtx, check: Obj): void {
  const query = isObj(check["query"]) ? check["query"] : {};
  const expect = isObj(check["expect"]) ? check["expect"] : {};
  checkView(ctx, check["view"]);
  const k = query["kind"];
  switch (k) {
    case "aggregate":
      checkAggregate(ctx, query, expect);
      return;
    case "unreconciled":
      requireRecord(ctx, query["record"], ["bank-deposit", "payslip"]);
      if (expect["notKnown"] === true) return;
      checkFact(ctx, expect["amount"], SPECS.yen("signed"), "amount");
      return;
    case "allocationUsage":
      requireRecord(ctx, query["allocation"], ["allocation"]);
      if (!USAGES.includes(String(expect["usage"]))) ctx.problems.add(ctx.where, "usageが表にない");
      return;
    case "forecastLine": {
      requireRecord(ctx, query["forecast"], ["forecast"]);
      const revs = ctx.state.records.get(String(query["forecast"])) ?? [];
      if (!revs.some((r) => lineIdsOf(r).has(String(query["line"])))) ctx.problems.add(ctx.where, `予測の行がない: ${String(query["line"])}`);
      checkFact(ctx, expect["remaining"], SPECS.yen("signed"), "remaining");
      if ("difference" in expect) checkFact(ctx, expect["difference"], SPECS.yen("signed"), "difference");
      return;
    }
    case "attribution": {
      requireRecord(ctx, query["payslip"], ["payslip"]);
      const st = expect["state"];
      if (st !== "determined" && st !== "undetermined" && st !== "conflict") ctx.problems.add(ctx.where, "帰属の状態が表にない");
      checkFact(ctx, expect["year"], SPECS.calendarYear, "year");
      if ((factStateOf(expect["year"]) === "known") !== (st === "determined")) ctx.problems.add(ctx.where, "所得の年はdeterminedのときだけknown");
      if (st === "determined") {
        if ("candidateYears" in expect) ctx.problems.add(ctx.where, "determinedには候補の年を書かない");
      } else checkYearRanges(ctx, expect["candidateYears"]);
      return;
    }
    case "comparison":
      requireRecord(ctx, query["annualDocument"], ["annual-document"]);
      if (!ANNUAL_AMOUNT_ITEMS.includes(String(query["field"]))) ctx.problems.add(ctx.where, "比較のfieldが年間資料の金額の項目名ではない");
      if (!COMPARISON_STATES.includes(String(expect["state"]))) ctx.problems.add(ctx.where, "比較の状態が表にない");
      if ("difference" in expect) checkFact(ctx, expect["difference"], SPECS.yen("signed"), "difference");
      return;
    case "adoption":
      if (!isCalendarYear(query["year"])) ctx.problems.add(ctx.where, "yearの形");
      requireRecord(ctx, query["payer"], ["employer"]);
      if (!SELECTIONS.includes(String(expect["selection"]))) ctx.problems.add(ctx.where, "選択が表にない");
      if ((expect["selection"] === "annual-document") !== ("document" in expect)) ctx.problems.add(ctx.where, "documentはannual-documentのときだけ");
      if ("document" in expect) requireRecord(ctx, expect["document"], ["annual-document"]);
      return;
    case "duplicateCandidates":
      if (!RECORD_TYPES.includes(query["recordType"] as RecordType)) ctx.problems.add(ctx.where, "recordTypeが表にない");
      checkPairs(ctx, expect["pairs"], String(query["recordType"]));
      return;
    case "decisionPremise": {
      requireRecord(ctx, query["decision"], ["decision"]);
      const item = query["item"];
      if (item !== undefined && !(isObj(item) && ((item["kind"] === "field" && ANNUAL_AMOUNT_ITEMS.includes(String(item["field"]))) || (item["kind"] === "payer" && isIdOf(item["payer"], "emp"))))) {
        ctx.problems.add(ctx.where, "itemはDecisionItem（fieldかpayer）");
      }
      if (expect["premise"] !== "holds" && expect["premise"] !== "broken") ctx.problems.add(ctx.where, "premiseはholds・broken");
      return;
    }
    case "seriesStatus": {
      requireRecord(ctx, query["record"], ["payslip", "annual-document", "official-notice"]);
      if (!SERIES_STATUSES.includes(String(expect["status"]))) ctx.problems.add(ctx.where, "系列の状態が表にない");
      // 現在の見方（checkのviewを省略、またはkindがcurrent）の期待値は、runの不足の判断・二重登録の取消と同じ系列の補助で
      // 導いた状態と一致させる（入口ごとに判定を変えない）。補助はafterOpの時点の最新の改訂だけを見るので、時点を指定した見方
      // （record-seq・record-time・known-on）の期待値は比べない（その見方の改訂を選ぶ実装はT06。最新の状態を混ぜて判定しない）。
      const id = String(query["record"]);
      const rec = latest(ctx.state, id);
      if (rec !== undefined && isCurrentView(check["view"]) && Object.keys(query).every((k) => k === "kind" || k === "record") && expect["status"] !== "not-in-view") {
        const series = seriesAmong(latestLookup(ctx.state), [...ctx.state.records.keys()]);
        const actual = rec["status"] !== "active" ? "voided" : series.illFormed.has(id) ? "unconfirmed-series" : series.superseded.has(id) ? "superseded" : "current";
        if (actual !== expect["status"]) ctx.problems.add(ctx.where, `${id}の系列の状態の期待値${String(expect["status"])}が、系列の補助で導いた${actual}と合わない`);
      }
      return;
    }
    case "canonicalId":
    case "runCanonicalId":
      if (k === "runCanonicalId" && !ctx.state.runs.has(String(query["run"]))) ctx.problems.add(ctx.where, "runがない");
      requireRecord(ctx, query["master"], MASTER_TYPES);
      requireRecord(ctx, expect["canonical"], MASTER_TYPES);
      if (recordTypeOfId(String(query["master"])) !== recordTypeOfId(String(expect["canonical"]))) ctx.problems.add(ctx.where, "正規のIDは同じ種類のマスタ");
      return;
    case "selectedRevision": {
      requireRecord(ctx, query["record"]);
      const r = expect["revision"];
      const revs = ctx.state.records.get(String(query["record"])) ?? [];
      if (!(r === "none" || (typeof r === "number" && Number.isInteger(r) && r >= 1 && r <= revs.length))) ctx.problems.add(ctx.where, "revisionは版の番号かnone");
      return;
    }
    case "seqForTime":
      if (!isInstant(query["time"])) ctx.problems.add(ctx.where, "timeがInstantではない");
      if (!checkSeqLabel(expect["seq"])) ctx.problems.add(ctx.where, "seqはNかN+k");
      return;
    case "runClosure": {
      const roots = isObj(query["roots"]) ? query["roots"] : {};
      checkRequests(ctx, roots["requests"]);
      const refs = roots["assumptionRefs"];
      if (!Array.isArray(refs)) ctx.problems.add(ctx.where, "assumptionRefsが並びではない");
      else for (const r of refs) for (const v of checkRefShape(r, "assumptionRefs", "integer")) ctx.problems.add(ctx.where, `${v.path} ${v.message}`);
      checkPinnedList(ctx, expect["records"], "records", undefined);
      checkPinnedList(ctx, expect["allocations"], "allocations", "alc", { field: "usageAtRun", values: USAGES });
      checkPinnedList(ctx, expect["decisions"], "decisions", "dcs", { field: "premiseAtRun", values: ["holds", "broken"] });
      return;
    }
    case "runInputChange":
      if (!ctx.state.runs.has(String(query["run"]))) ctx.problems.add(ctx.where, "runがない");
      checkIdList(ctx, expect["added"], "added");
      checkIdList(ctx, expect["removed"], "removed");
      checkIdList(ctx, expect["versionChanged"], "versionChanged");
      return;
    case "runScopeChanged":
      if (!ctx.state.runs.has(String(query["run"]))) ctx.problems.add(ctx.where, "runがない");
      if (typeof expect["changed"] !== "boolean") ctx.problems.add(ctx.where, "changedは真偽値");
      return;
    case "runChain": {
      // 目的が決まるrunは、最初のrunからこのrunまでの鎖（最初のrunなら1要素）。目的が決まらないrun（scopeがunknown、
      // jurisdictionがknownでない、referencePointがunknown）はどの鎖にも入らないので、空の並びで期待する（計算結果の3）。
      const run = ctx.state.runs.get(String(query["run"]));
      if (run === undefined) {
        ctx.problems.add(ctx.where, "runがない");
        return;
      }
      const chain = expect["chain"];
      if (!Array.isArray(chain)) {
        ctx.problems.add(ctx.where, "chainは並び");
        return;
      }
      const determined = runPurposeDetermined(run);
      if (!determined) {
        if (chain.length !== 0) ctx.problems.add(ctx.where, "目的が決まらないrunはどの鎖にも入らない（chainは空の並び）");
        return;
      }
      if (chain.length === 0 || chain[chain.length - 1] !== query["run"]) ctx.problems.add(ctx.where, "目的が決まるrunのchainは、最初のrunからこのrunまでの並び（最初のrunなら1要素）");
      chain.forEach((r, i) => {
        if (!ctx.state.runs.has(String(r))) ctx.problems.add(ctx.where, `chain[${i}]のrunがない: ${String(r)}`);
      });
      return;
    }
    case "requiredAdoptions": {
      checkRequests(ctx, query["requests"]);
      const list = expect["adoptions"];
      if (!Array.isArray(list)) {
        ctx.problems.add(ctx.where, "adoptionsが並びではない");
        return;
      }
      list.forEach((a, i) => checkAdoptionSnapshot(ctx, a, `adoptions[${i}]`));
      return;
    }
    case "roundingStep":
      if (!/^-?[0-9]+(\.[0-9]+)?$/.test(String(query["before"])) || !/^[0-9]+(\.[0-9]+)?$/.test(String(query["unit"]))) ctx.problems.add(ctx.where, "before・unitはDecimal");
      if (!ROUNDING_METHODS.includes(String(query["method"]))) ctx.problems.add(ctx.where, "丸め方が表にない");
      if (!/^-?[0-9]+(\.[0-9]+)?$/.test(String(expect["after"]))) ctx.problems.add(ctx.where, "afterはDecimal");
      return;
    case "roundingValidation":
      if (!isObj(query["input"])) ctx.problems.add(ctx.where, "inputがない");
      if (typeof expect["valid"] !== "boolean") ctx.problems.add(ctx.where, "validは真偽値");
      if (expect["valid"] === false && typeof expect["reason"] !== "string") ctx.problems.add(ctx.where, "保存しない形には理由を書く");
      return;
    case "includedPayersPrompt":
      requireRecord(ctx, query["annualDocument"], ["annual-document"]);
      if (typeof expect["shown"] !== "boolean") ctx.problems.add(ctx.where, "shownは真偽値");
      return;
    default:
      ctx.problems.add(ctx.where, `検査の種類が表にない: ${String(k)}`);
  }
}

function checkCites(cites: unknown, docs: ContractDocs, where: string, problems: Problems): void {
  if (!Array.isArray(cites) || cites.length === 0) {
    problems.add(where, "理由の引用（cites）がない");
    return;
  }
  for (const c of cites) {
    if (!isObj(c) || typeof c["doc"] !== "string" || typeof c["section"] !== "string" || typeof c["quote"] !== "string") {
      problems.add(where, "引用は{ doc, section, quote }");
      continue;
    }
    const doc = docs.sections.get(c["doc"]);
    const text = doc?.get(c["section"]);
    if (text === undefined) problems.add(where, `契約に節がない: ${c["doc"]} ${c["section"]}`);
    else if (normalize(c["quote"]).length < 4 || !text.includes(normalize(c["quote"]))) problems.add(where, `契約の${c["doc"]} ${c["section"]}に引用の語句がない: ${c["quote"]}`);
  }
}

function checkOrderVariants(variants: unknown, replay: ReplayResult, ops: Obj[], where: string, problems: Problems): void {
  if (variants === undefined) return;
  if (!Array.isArray(variants)) {
    problems.add(where, "orderVariantsが並びではない");
    return;
  }
  if (ops.some((o) => !isObj(o["expect"]) || o["expect"]["outcome"] !== "accepted")) problems.add(where, "orderVariantsは、すべての操作がacceptedの場面だけに書く");
  const all = [...replay.opOrder].sort();
  for (const v of variants) {
    if (!Array.isArray(v) || stableStringify([...v].sort()) !== stableStringify(all)) {
      problems.add(where, "orderVariantsの順序は、場面の操作の並べ替え");
      continue;
    }
    const pos = new Map<string, number>(v.map((x, i) => [String(x), i]));
    for (const [opId, deps] of replay.deps) {
      for (const d of deps) {
        const a = pos.get(d);
        const b = pos.get(opId);
        if (a !== undefined && b !== undefined && a > b) problems.add(where, `orderVariantsで${opId}が、参照・前の版の${d}より前にある`);
      }
    }
  }
}

const REGIME_PLACEHOLDER = "未確認";
const REGIMES = ["income-tax", "resident-tax", "furusato", "nhi", "employee-insurance", "dependents"];

function hasNumber(v: unknown): boolean {
  if (typeof v === "number") return true;
  if (Array.isArray(v)) return v.some(hasNumber);
  if (isObj(v)) return Object.values(v).some(hasNumber);
  return false;
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;

// 制度のケースの値の形。値が正しい形でなければ、理由の並びを返す（「未確認」は呼び出し側で扱う）。
const REGIME_FIELDS: Readonly<Record<string, (v: unknown, c: Obj, target: Obj) => string[]>> = {
  "target.year": (v, _c, target) => {
    if (!isObj(v) || (v["kind"] !== "calendar" && v["kind"] !== "fiscal") || !isCalendarYear(v["year"])) return ["{ kind: calendar・fiscal, year }"];
    if (target["yearKind"] !== v["kind"]) return ["kindがyearKindと違う"];
    return [];
  },
  "target.jurisdiction": (v) =>
    isObj(v) && ["national", "prefecture", "municipality", "insurer"].includes(String(v["kind"])) && nonEmpty(v["code"]) ? [] : ["{ kind: national・prefecture・municipality・insurer, code（空でない） }"],
  "target.referencePoint": (v, _c, target) => {
    const p = target["procedure"];
    if (p === "premium") return isObj(v) && v["kind"] === "month" && isYearMonth(v["month"]) ? [] : ["premiumは{ kind: month, month }"];
    return isObj(v) && v["kind"] === "date" && isLocalDate(v["date"]) ? [] : [`${String(p)}は{ kind: date, date }`];
  },
  ruleSet: (v) => (isObj(v) && nonEmpty(v["id"]) && nonEmpty(v["version"]) ? [] : ["{ id, version }（どちらも空でない）"]),
  sources: (v) => {
    if (!Array.isArray(v) || v.length === 0) return ["1件以上の原典"];
    const out: string[] = [];
    if (!v.some((x) => isObj(x) && x["primary"] === true)) out.push("一次資料（primary: true）が要る");
    v.forEach((x, i) => {
      if (
        !isObj(x) ||
        !nonEmpty(x["title"]) ||
        !nonEmpty(x["publisher"]) ||
        typeof x["url"] !== "string" ||
        !x["url"].startsWith("https://") ||
        typeof x["primary"] !== "boolean" ||
        !isLocalDate(x["documentUpdatedOn"]) ||
        !isLocalDate(x["retrievedOn"]) ||
        !nonEmpty(x["location"])
      ) {
        out.push(`sources[${i}]は{ title, publisher, url（https）, primary, documentUpdatedOn, retrievedOn, location }`);
      } else if (String(x["documentUpdatedOn"]) > String(x["retrievedOn"])) out.push(`sources[${i}]の資料の更新日が取得日より後`);
    });
    return out;
  },
  rounding: (v, c) => {
    if (!Array.isArray(v)) return ["手順の並び（丸めがなければ空の並び）"];
    const expected = c["expected"];
    const keys = new Set(isObj(expected) && Array.isArray(expected["results"]) ? expected["results"].filter(isObj).map((r) => String(r["key"])) : []);
    const out: string[] = [];
    v.forEach((r, i) => {
      if (!isObj(r) || !nonEmpty(r["itemKey"]) || !ROUNDING_METHODS.includes(String(r["method"])) || !/^[0-9]+(\.[0-9]+)?$/.test(String(r["unit"])) || Number(r["unit"]) <= 0 || !["rule", "input", "calculator"].includes(String(r["basis"]))) {
        out.push(`rounding[${i}]は{ itemKey, method, unit（正のDecimal）, basis, location }`);
        return;
      }
      if (r["basis"] !== "calculator" && !nonEmpty(r["location"])) out.push(`rounding[${i}]: 制度の丸め（rule・input）には原典の箇所（location）が要る`);
      if (r["basis"] === "input" && !nonEmpty(r["methodInput"])) out.push(`rounding[${i}]: inputの丸めには丸め方を受け取る仮定（methodInput）が要る`);
      if (!keys.has(String(r["itemKey"]))) out.push(`rounding[${i}]のitemKeyが期待値の結果の項目にない`);
    });
    return out;
  },
  input: (v) => (isObj(v) && Object.keys(v).length > 0 ? [] : ["空でないobject"]),
  expected: (v) => {
    if (!isObj(v) || !Array.isArray(v["results"]) || v["results"].length === 0) return ["{ results: 結果の項目の並び（1件以上） }"];
    const out: string[] = [];
    const seen = new Set<string>();
    v["results"].forEach((r, i) => {
      if (!isObj(r) || !nonEmpty(r["key"]) || (r["valueType"] !== "yen" && r["valueType"] !== "decimal")) {
        out.push(`results[${i}]は{ key, valueType: yen・decimal, value }`);
        return;
      }
      if (seen.has(String(r["key"]))) out.push(`results[${i}]のkeyが重なる`);
      seen.add(String(r["key"]));
      const value = r["value"];
      const state = factStateOf(value);
      if (state === undefined || !["known", "unknown", "not-stated", "not-applicable"].includes(state)) out.push(`results[${i}].valueはFact`);
      else if (state === "known") {
        const x = isObj(value) ? value["value"] : undefined;
        const ok = r["valueType"] === "yen" ? typeof x === "number" && Number.isSafeInteger(x) : typeof x === "string" && DECIMAL.test(x);
        if (!ok) out.push(`results[${i}].valueの値がvalueTypeに合わない`);
      }
    });
    return out;
  },
  derivation: (v) =>
    isObj(v) && nonEmpty(v["method"]) && nonEmpty(v["reviewedBy"]) && v["independentOfImplementation"] === true
      ? []
      : ["{ method（空でない）, reviewedBy（空でない）, independentOfImplementation: true }"],
};

export function validateRegimeCase(c: unknown, where: string, problems: Problems): void {
  if (!isObj(c)) {
    problems.add(where, "制度のケースがobjectではない");
    return;
  }
  const required = ["caseId", "regime", "title", "status", "consumers", "target", "ruleSet", "sources", "rounding", "input", "expected", "derivation"];
  for (const k of required) if (!(k in c)) problems.add(where, `必須の項目がない: ${k}`);
  if (!REGIMES.includes(String(c["regime"]))) problems.add(where, "regimeが表にない");
  const status = c["status"];
  if (status !== "placeholder" && status !== "draft" && status !== "approved") problems.add(where, "statusはplaceholder・draft・approved");
  const target = isObj(c["target"]) ? c["target"] : {};
  if (!isObj(c["target"])) problems.add(where, "targetがobjectではない");
  for (const k of ["year", "yearKind", "jurisdiction", "procedure", "referencePoint"]) if (!(k in target)) problems.add(where, `target.${k}がない（適用年・地域・手続・基準の時点は必須）`);
  const procedure = target["procedure"];
  if (!PROCEDURES.includes(String(procedure))) problems.add(where, "target.procedureが計算結果の契約の表にない");
  if (!["calendar", "fiscal", REGIME_PLACEHOLDER].includes(String(target["yearKind"]))) problems.add(where, "target.yearKindはcalendar・fiscal・未確認");
  // levyは年度だけで規則が決まるので、基準の時点はnot-applicableだけ（計算結果の1の「手続と基準の時点」）。
  if (procedure === "levy" && target["referencePoint"] !== "not-applicable") problems.add(where, "levyのreferencePointはnot-applicable（計算結果の1）");
  if (procedure !== "levy" && target["referencePoint"] === "not-applicable") problems.add(where, "levy以外のreferencePointはnot-applicableにしない");
  const values: [string, unknown][] = [
    ["target.year", target["year"]],
    ["target.jurisdiction", target["jurisdiction"]],
    ["ruleSet", c["ruleSet"]],
    ["sources", c["sources"]],
    ["rounding", c["rounding"]],
    ["input", c["input"]],
    ["expected", c["expected"]],
    ["derivation", c["derivation"]],
  ];
  if (procedure !== "levy") values.push(["target.referencePoint", target["referencePoint"]]);
  if (status === "placeholder") {
    for (const [name, v] of values) if (v !== REGIME_PLACEHOLDER) problems.add(where, `placeholderの${name}は「未確認」だけ（制度の値を入れない）`);
    if (hasNumber(c)) problems.add(where, "placeholderに数値がある（制度の値を入れない）");
    return;
  }
  if (status === "approved" && target["yearKind"] === REGIME_PLACEHOLDER) problems.add(where, "approvedのtarget.yearKindが未確認");
  // draftは「未確認」か正しい形の値、approvedは正しい形の値だけ（null・空の文字列・形の違う値を通さない）。
  for (const [name, v] of values) {
    if (v === REGIME_PLACEHOLDER) {
      if (status === "approved") problems.add(where, `approvedの${name}が未確認`);
      continue;
    }
    const check = REGIME_FIELDS[name];
    if (check === undefined) continue;
    for (const m of check(v, c, target)) problems.add(where, `${String(status)}の${name}: ${m}`);
  }
}

// 台帳が対象にする契約版（docs/test-oracles/README.md）。共通の設定・ケース・制度のケースのすべてで同じ値にする。
const LEDGER_CONTRACT_VERSION = "2.0";

export function validateLedger(files: LedgerFiles, docs: ContractDocs): string[] {
  const problems = new Problems();
  const common = files.commonSetup;
  if (common["schemaVersion"] !== 1 || common["contractVersion"] !== LEDGER_CONTRACT_VERSION) problems.add("common-setup", `schemaVersion 1・contractVersion ${LEDGER_CONTRACT_VERSION}`);
  const commonReplay = replayOps(common["operations"], "common", newState(), 0, "common-setup", problems);
  const commonState = commonReplay.state;
  const commonCount = commonState.seq;
  checkCites(common["cites"], docs, "common-setup", problems);
  const covered = new Set<string>();
  if (!Array.isArray(common["coverageExceptions"])) problems.add("common-setup", "coverageExceptionsが並びではない（例外がなければ空の並び）");
  const exceptions = Array.isArray(common["coverageExceptions"]) ? common["coverageExceptions"] : [];
  exceptions.forEach((e, i) => {
    if (!isObj(e) || typeof e["section"] !== "string" || typeof e["reason"] !== "string") problems.add("common-setup", `coverageExceptions[${i}]は{ section, subsection?, reason }`);
    else covered.add(`${e["section"]}|${String(e["subsection"] ?? "")}`);
  });
  const tags = new Set<string>();
  const caseIds = new Set<string>();
  const scenarioIds = new Set<string>();
  for (const { file, data } of files.cases) {
    const caseId = data["caseId"];
    if (typeof caseId !== "string" || file !== `cases/${caseId}.json`) problems.add(file, "caseIdとファイル名が合わない");
    if (caseIds.has(String(caseId))) problems.add(file, "caseIdが重なる");
    caseIds.add(String(caseId));
    if (data["schemaVersion"] !== 1 || data["contractVersion"] !== LEDGER_CONTRACT_VERSION) problems.add(file, `schemaVersion 1・contractVersion ${LEDGER_CONTRACT_VERSION}`);
    if (typeof data["title"] !== "string" || data["title"] === "") problems.add(file, "titleがない");
    const consumers = data["consumers"];
    if (!Array.isArray(consumers) || consumers.length === 0 || !consumers.every((c) => typeof c === "string" && /^T\d{2}$/.test(c))) problems.add(file, "consumersはタスクIDの並び");
    const scenarios = data["scenarios"];
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      problems.add(file, "scenariosがない");
      continue;
    }
    for (const sc of scenarios) {
      if (!isObj(sc) || typeof sc["scenarioId"] !== "string") {
        problems.add(file, "scenarioIdのない場面");
        continue;
      }
      const sid = sc["scenarioId"];
      const where = `${file} ${sid}`;
      if (!sid.startsWith(`${String(caseId)}-`)) problems.add(where, "scenarioIdはcaseIdで始める");
      if (scenarioIds.has(sid)) problems.add(where, "scenarioIdが重なる");
      scenarioIds.add(sid);
      if (typeof sc["title"] !== "string" || sc["title"] === "") problems.add(where, "titleがない");
      const rules = sc["rules"];
      if (!isObj(rules) || !["none", "EX-06-mapping"].includes(String(rules["comparisonMapping"])) || !["none", "EX-05-scheduled-pay-date-year"].includes(String(rules["attribution"]))) {
        problems.add(where, "rulesは{ comparisonMapping: none・EX-06-mapping, attribution: none・EX-05-scheduled-pay-date-year }");
      }
      if ("acceptance" in sc && !Array.isArray(sc["acceptance"])) problems.add(where, "acceptanceが並びではない");
      for (const t of Array.isArray(sc["acceptance"]) ? sc["acceptance"] : []) {
        if (!ACCEPTANCE_TAGS.includes(String(t))) problems.add(where, `acceptanceのタグが表にない: ${String(t)}`);
        tags.add(String(t));
      }
      const covers = Array.isArray(sc["covers"]) ? sc["covers"] : [];
      if (covers.length === 0) problems.add(where, "coversがない（契約のどの例・規則の場面か）");
      for (const cv of covers) {
        if (!isObj(cv) || typeof cv["doc"] !== "string" || typeof cv["section"] !== "string") {
          problems.add(where, "coversは{ doc, section, subsection? }");
          continue;
        }
        const sections = docs.sections.get(cv["doc"]);
        if (sections?.get(cv["section"]) === undefined) problems.add(where, `coversの節が契約にない: ${cv["doc"]} ${cv["section"]}`);
        if (cv["doc"] === "examples.md") {
          const heading = docs.exampleHeadings.find((h) => h.section === cv["section"]);
          const sub = cv["subsection"];
          if (typeof sub === "string") {
            const match = heading?.subsections.filter((s) => s === sub || s.startsWith(`${sub} `)) ?? [];
            if (match.length !== 1) problems.add(where, `coversの小見出しが一意に決まらない: ${cv["section"]} ${sub}`);
            covered.add(`${cv["section"]}|${match[0] ?? sub}`);
          } else covered.add(`${cv["section"]}|`);
        }
      }
      let ops: Obj[];
      try {
        ops = resolveOperations(data, sid);
      } catch (e) {
        problems.add(where, (e as Error).message);
        continue;
      }
      if (!Array.isArray(sc["operations"])) problems.add(where, "operationsが並びではない（追加の操作がなければ空の並び）");
      const replay = replayOps(ops, sid, cloneState(commonState), commonCount, where, problems);
      checkOrderVariants(sc["orderVariants"], replay, ops, where, problems);
      const checks = Array.isArray(sc["checks"]) ? sc["checks"] : [];
      if (checks.length === 0) problems.add(where, "checksがない");
      const checkIds = new Set<string>();
      for (const ch of checks) {
        if (!isObj(ch) || typeof ch["checkId"] !== "string") {
          problems.add(where, "checkIdのない検査");
          continue;
        }
        const cw = `${where} ${ch["checkId"]}`;
        if (checkIds.has(ch["checkId"])) problems.add(cw, "checkIdが重なる");
        checkIds.add(ch["checkId"]);
        const after = ch["afterOp"];
        const st = after === "end" ? replay.state : typeof after === "string" ? replay.statesAfter.get(after) : undefined;
        if (st === undefined) {
          problems.add(cw, `afterOpが場面の操作にない: ${String(after)}`);
          continue;
        }
        if (typeof ch["reason"] !== "string" || ch["reason"].length < 10) problems.add(cw, "理由（reason）がない");
        checkCites(ch["cites"], docs, cw, problems);
        checkOne({ state: st, where: cw, problems, commonCount }, ch);
      }
    }
  }
  // 合成例の節（examples.mdのEX-NNと、その下の小見出し）をすべて扱う。
  for (const h of docs.exampleHeadings) {
    const keys = h.subsections.length === 0 ? [`${h.section}|`] : h.subsections.map((s) => `${h.section}|${s}`);
    for (const k of keys) if (!covered.has(k)) problems.add("coverage", `合成例の節を扱うケースがない: ${k.replace("|", " ")}`);
  }
  for (const t of ACCEPTANCE_TAGS) if (!tags.has(t)) problems.add("acceptance", `受入条件のタグ${t}を持つ場面がない`);
  // 制度のケース
  if (files.regime.length === 0) problems.add("regime", "制度のケースのファイルがない");
  for (const { file, data } of files.regime) {
    if (data["schemaVersion"] !== 1 || data["contractVersion"] !== LEDGER_CONTRACT_VERSION) problems.add(file, `schemaVersion 1・contractVersion ${LEDGER_CONTRACT_VERSION}`);
    const list = data["cases"];
    if (!Array.isArray(list) || list.length === 0) problems.add(file, "casesがない");
    else {
      const ids = new Set<string>();
      for (const c of list) {
        const cid = isObj(c) ? String(c["caseId"]) : "?";
        if (ids.has(cid)) problems.add(`${file} ${cid}`, "caseIdが重なる");
        ids.add(cid);
        validateRegimeCase(c, `${file} ${cid}`, problems);
      }
    }
  }
  return problems.list;
}

// ---- 試験

const docs = readContractDocs();
const files = readLedgerFiles();

test("台帳は契約の保存の条件・期待の形・引用・網羅の検査を満たす", () => {
  const problems = validateLedger(files, docs);
  assert.deepEqual(problems, []);
});

test("契約の合成例の節を読める（引用と網羅の検査の前提）", () => {
  assert.ok(docs.exampleHeadings.length > 0);
  assert.ok(docs.sections.get("reconciliation.md")?.has("2"));
});

// 検査そのものが誤りを見逃さないことを、台帳を写して壊した版で確かめる（testing.mdの「意図的な変更」）。
function mutated(f: (copy: LedgerFiles) => void): string[] {
  const copy = structuredClone(files);
  f(copy);
  return validateLedger(copy, docs);
}

function firstCase(copy: LedgerFiles, caseId: string): Obj {
  const c = copy.cases.find((x) => x.data["caseId"] === caseId);
  assert.ok(c, `${caseId}がない`);
  return c.data;
}

function scenario(caseData: Obj, sid: string): Obj {
  const list = Array.isArray(caseData["scenarios"]) ? caseData["scenarios"] : [];
  const s = list.find((x) => isObj(x) && x["scenarioId"] === sid);
  assert.ok(isObj(s), `${sid}がない`);
  return s;
}

function op(sc: Obj, opId: string): Obj {
  const list = Array.isArray(sc["operations"]) ? sc["operations"] : [];
  const o = list.find((x) => isObj(x) && x["opId"] === opId);
  assert.ok(isObj(o), `${opId}がない`);
  return o;
}

function check(sc: Obj, checkId: string): Obj {
  const list = Array.isArray(sc["checks"]) ? sc["checks"] : [];
  const c = list.find((x) => isObj(x) && x["checkId"] === checkId);
  assert.ok(isObj(c), `${checkId}がない`);
  return c;
}

test("検査の自己確認: acceptedの入金の金額を0にすると見つける", () => {
  const p = mutated((copy) => {
    const o = op(scenario(firstCase(copy, "EX-01"), "EX-01-a"), "o1");
    const rec = o["record"] as Obj;
    (rec["body"] as Obj)["amount"] = { state: "known", value: 0 };
  });
  assert.ok(p.some((x) => x.includes("value-invalid")), p.join("\n"));
});

test("検査の自己確認: 静的な拒否の理由を期待する保存が正しい記録なら見つける", () => {
  const p = mutated((copy) => {
    const sc = scenario(firstCase(copy, "TC-02"), "TC-02-a");
    const list = sc["operations"] as Obj[];
    const target = list.find((o) => isObj(o["expect"]) && o["expect"]["reason"] === "fact-state-not-allowed");
    assert.ok(target);
    (target["record"] as Obj)["body"] = { ...((target["record"] as Obj)["body"] as Obj), grossPay: { state: "known", value: 1 }, scheduledPayDate: { state: "known", value: "2026-10-23" }, otherEarnings: { state: "known", value: [] }, supersedes: { state: "not-applicable" } };
    (target["record"] as Obj)["knownOn"] = { state: "unknown" };
  });
  assert.ok(p.some((x) => x.includes("記録にその違反がない")), p.join("\n"));
});

test("検査の自己確認: incompleteでないのに不足があると見つける", () => {
  const p = mutated((copy) => {
    const c = check(scenario(firstCase(copy, "EX-08"), "EX-08-a"), "c02");
    const v = ((c["expect"] as Obj)["values"] as Obj[])[0];
    assert.ok(v);
    v["state"] = "complete";
  });
  assert.ok(p.some((x) => x.includes("incompleteとmissingの有無が合わない")), p.join("\n"));
});

test("検査の自己確認: 契約にない語句の引用を見つける", () => {
  const p = mutated((copy) => {
    const c = check(scenario(firstCase(copy, "EX-01"), "EX-01-a"), "c01");
    c["cites"] = [{ doc: "reconciliation.md", section: "2", quote: "契約に存在しない語句の例" }];
  });
  assert.ok(p.some((x) => x.includes("引用の語句がない")), p.join("\n"));
});

test("検査の自己確認: 合成例の節を扱うケースがなくなると見つける", () => {
  const p = mutated((copy) => {
    copy.cases = copy.cases.filter((c) => c.data["caseId"] !== "EX-09");
  });
  assert.ok(p.some((x) => x.includes("合成例の節を扱うケースがない: EX-09")), p.join("\n"));
});

test("検査の自己確認: 制度のケースの必須の項目と、未確認の雛形に値を入れないこと", () => {
  const base = { caseId: "REG-X", regime: "income-tax", title: "x", status: "placeholder", consumers: ["T14"], target: { year: "未確認", yearKind: "calendar", jurisdiction: "未確認", procedure: "withholding", referencePoint: "未確認" }, ruleSet: "未確認", sources: "未確認", rounding: "未確認", input: "未確認", expected: "未確認", derivation: "未確認" };
  const run = (c: unknown): string[] => {
    const p = new Problems();
    validateRegimeCase(c, "x", p);
    return p.list;
  };
  assert.deepEqual(run(base), []);
  assert.ok(run({ ...base, target: { ...base.target, year: { kind: "calendar", year: 2026 } } }).length > 0);
});

// 承認済み（approved）の制度のケースの見本（架空の値）と、必須の値が欠けた・null・空・形の違う負の見本。
const APPROVED = {
  caseId: "REG-X",
  regime: "income-tax",
  title: "x",
  status: "approved",
  consumers: ["T14"],
  target: { year: { kind: "calendar", year: 2030 }, yearKind: "calendar", jurisdiction: { kind: "national", code: "x" }, procedure: "withholding", referencePoint: { kind: "date", date: "2030-01-25" } },
  ruleSet: { id: "rs", version: "1" },
  sources: [{ title: "t", publisher: "p", url: "https://example.org/x", primary: true, documentUpdatedOn: "2030-01-01", retrievedOn: "2030-01-02", location: "第1条" }],
  rounding: [{ itemKey: "a", method: "floor", unit: "1", basis: "rule", location: "第2条" }],
  input: { synthetic: "架空の入力" },
  expected: { results: [{ key: "a", valueType: "yen", value: { state: "known", value: 1 } }] },
  derivation: { method: "m", reviewedBy: "r", independentOfImplementation: true },
};

function runRegime(c: unknown): string[] {
  const p = new Problems();
  validateRegimeCase(c, "x", p);
  return p.list;
}

test("検査の自己確認: approvedの制度のケースの見本は通る（levyの基準の時点はnot-applicable）", () => {
  assert.deepEqual(runRegime(APPROVED), []);
  const levy = { ...APPROVED, regime: "resident-tax", target: { ...APPROVED.target, year: { kind: "fiscal", year: 2030 }, yearKind: "fiscal", procedure: "levy", referencePoint: "not-applicable" } };
  assert.deepEqual(runRegime(levy), []);
  const premium = { ...APPROVED, regime: "employee-insurance", target: { ...APPROVED.target, procedure: "premium", referencePoint: { kind: "month", month: "2030-04" } } };
  assert.deepEqual(runRegime(premium), []);
});

test("検査の自己確認: approvedで必須の値がnull・空・形の違う値なら見つける", () => {
  const t = APPROVED.target;
  const negatives: [string, unknown, string][] = [
    ["ruleSetがnull", { ...APPROVED, ruleSet: null }, "ruleSet"],
    ["ruleSetのversionがない", { ...APPROVED, ruleSet: { id: "rs" } }, "ruleSet"],
    ["ruleSetのidが空", { ...APPROVED, ruleSet: { id: " ", version: "1" } }, "ruleSet"],
    ["referencePointがnull", { ...APPROVED, target: { ...t, referencePoint: null } }, "target.referencePoint"],
    ["withholdingの基準の時点が月", { ...APPROVED, target: { ...t, referencePoint: { kind: "month", month: "2030-01" } } }, "target.referencePoint"],
    ["premiumの基準の時点が日", { ...APPROVED, target: { ...t, procedure: "premium", referencePoint: { kind: "date", date: "2030-01-25" } } }, "target.referencePoint"],
    ["levy以外の基準の時点がnot-applicable", { ...APPROVED, target: { ...t, referencePoint: "not-applicable" } }, "not-applicable"],
    ["levyの基準の時点が日", { ...APPROVED, target: { ...t, procedure: "levy", referencePoint: { kind: "date", date: "2030-01-25" } } }, "levy"],
    ["inputがnull", { ...APPROVED, input: null }, "input"],
    ["inputが空", { ...APPROVED, input: {} }, "input"],
    ["expectedがnull", { ...APPROVED, expected: null }, "expected"],
    ["expectedの結果が空", { ...APPROVED, expected: { results: [] } }, "expected"],
    ["expectedのvalueTypeが表にない", { ...APPROVED, expected: { results: [{ key: "a", valueType: "boolean", value: { state: "known", value: true } }] } }, "expected"],
    ["expectedの値が型に合わない", { ...APPROVED, expected: { results: [{ key: "a", valueType: "yen", value: { state: "known", value: 1.5 } }] } }, "expected"],
    ["derivation.methodが空", { ...APPROVED, derivation: { ...APPROVED.derivation, method: "" } }, "derivation"],
    ["derivation.reviewedByが空白", { ...APPROVED, derivation: { ...APPROVED.derivation, reviewedBy: "  " } }, "derivation"],
    ["独立に導いたことがない", { ...APPROVED, derivation: { method: "m", reviewedBy: "r" } }, "derivation"],
    ["yearがnull", { ...APPROVED, target: { ...t, year: null } }, "target.year"],
    ["yearの種類がyearKindと違う", { ...APPROVED, target: { ...t, year: { kind: "fiscal", year: 2030 } } }, "target.year"],
    ["yearKindが未確認", { ...APPROVED, target: { ...t, yearKind: "未確認" } }, "yearKind"],
    ["jurisdictionのcodeが空", { ...APPROVED, target: { ...t, jurisdiction: { kind: "national", code: "" } } }, "target.jurisdiction"],
    ["jurisdictionが未確認", { ...APPROVED, target: { ...t, jurisdiction: "未確認" } }, "未確認"],
    ["一次資料がない", { ...APPROVED, sources: [{ ...APPROVED.sources[0], primary: false }] }, "一次資料"],
    ["原典のtitleが空", { ...APPROVED, sources: [{ ...APPROVED.sources[0], title: "" }] }, "sources"],
    ["資料の更新日が取得日より後", { ...APPROVED, sources: [{ ...APPROVED.sources[0], documentUpdatedOn: "2030-02-01" }] }, "更新日"],
    ["制度の丸めに原典の箇所がない", { ...APPROVED, rounding: [{ itemKey: "a", method: "floor", unit: "1", basis: "rule" }] }, "location"],
    ["丸めの単位が0", { ...APPROVED, rounding: [{ itemKey: "a", method: "floor", unit: "0", basis: "calculator" }] }, "rounding"],
    ["丸めのitemKeyが結果にない", { ...APPROVED, rounding: [{ itemKey: "b", method: "floor", unit: "1", basis: "calculator" }] }, "itemKey"],
  ];
  for (const [name, c, word] of negatives) {
    const p = runRegime(c);
    assert.ok(p.some((x) => x.includes(word)), `${name}: ${p.join(" / ") || "見つからない"}`);
  }
});

test("検査の自己確認: 摘要等の自由な文字列のIDに似た値は参照とみなさない", () => {
  const p = mutated((copy) => {
    const o = op(scenario(firstCase(copy, "EX-01"), "EX-01-a"), "o1");
    ((o["record"] as Obj)["body"] as Obj)["descriptionText"] = { state: "known", value: "pay_999" };
    (o["record"] as Obj)["changeNote"] = { state: "known", value: "dep_999" };
  });
  assert.deepEqual(p, []);
  const q = mutated((copy) => {
    const o = op(scenario(firstCase(copy, "EX-01"), "EX-01-a"), "o1");
    ((o["record"] as Obj)["body"] as Obj)["payerHint"] = { state: "known", value: "emp_99" };
  });
  assert.ok(q.some((x) => x.includes("ref-target-missing")), q.join("\n"));
});

test("検査の自己確認: 操作の並びの不正な要素を黙って除かず、場面IDと位置を示す", () => {
  const p = mutated((copy) => {
    const sc = scenario(firstCase(copy, "EX-05"), "EX-05-e");
    sc["operations"] = [null];
  });
  assert.ok(p.some((x) => x.includes("EX-05-e") && x.includes("operations[0]")), p.join("\n"));
  const q = mutated((copy) => {
    const sc = scenario(firstCase(copy, "EX-02"), "EX-02-c4");
    const o = op(sc, "o1");
    (o["records"] as unknown[]).push("pay_205");
  });
  assert.ok(q.some((x) => x.includes("EX-02-c4") && x.includes("records[5]")), q.join("\n"));
  const r = mutated((copy) => {
    const o = op(scenario(firstCase(copy, "EX-01"), "EX-01-a"), "o1");
    (o["record"] as Obj)["body"] = "不正なbody";
  });
  assert.ok(r.some((x) => x.includes("EX-01-a") && x.includes("bodyがobjectではない")), r.join("\n"));
  assert.deepEqual(ledgerFileNames("cases", ["TC-01.json", "EX-01.json"]), ["EX-01.json", "TC-01.json"]);
});

test("台帳のファイルの一覧: .gitignoreで除外したOSのメタデータだけを読み飛ばし、ほかは場所付きの誤りにする", () => {
  assert.deepEqual(ledgerFileNames("cases", ["EX-01.json", ".DS_Store", "Thumbs.db"]), ["EX-01.json"]);
  assert.throws(() => ledgerFileNames("cases", ["EX-01.json", ".DS_Store", "notes.txt"]), /tests\/fixtures\/ledger\/cases\/notes\.txt/);
  assert.throws(() => ledgerFileNames("regime", ["regime-cases.json", "regime-cases.json.bak"]), /tests\/fixtures\/ledger\/regime\/regime-cases\.json\.bak/);
  // 名前が完全に一致するものだけ（大文字小文字や接尾辞の違うものは読み飛ばさない）。
  assert.throws(() => ledgerFileNames("cases", ["._.DS_Store"]), /cases\/\._\.DS_Store/);
  assert.throws(() => ledgerFileNames("cases", [".ds_store"]), /cases\/\.ds_store/);
  assert.throws(() => ledgerFileNames("cases", ["Thumbs.db.json.tmp"]), /Thumbs\.db\.json\.tmp/);
  // 一覧は.gitignoreの行を写したもの。.gitignoreに同じ名前の行がなければ、一覧を直す。
  const gitignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
  for (const name of OS_METADATA_FILES_FROM_GITIGNORE) assert.ok(gitignore.includes(name), `.gitignoreに${name}の行がない`);
});

test("検査の自己確認: runの採用の写しのadoptedRefはFact<Ref>（known・整数の版・line whole）", () => {
  const snapshot = (copy: LedgerFiles): Obj => {
    const c = check(scenario(firstCase(copy, "EX-06"), "EX-06-d"), "c01");
    const a = ((c["expect"] as Obj)["adoptions"] as Obj[])[0];
    assert.ok(a);
    return a;
  };
  const cases: [string, (a: Obj) => void, string][] = [
    ["Factの外枠がない", (a) => (a["adoptedRef"] = { id: "ann_602", revision: 1, line: "whole" }), "adoptedRef"],
    ["版がcurrent", (a) => (a["adoptedRef"] = { state: "known", value: { id: "ann_602", revision: "current", line: "whole" } }), "revision"],
    ["行を指す", (a) => (a["adoptedRef"] = { state: "known", value: { id: "ann_602", revision: 1, line: "l1" } }), "line"],
    ["年間資料でない記録", (a) => (a["adoptedRef"] = { state: "known", value: { id: "pay_601", revision: 1, line: "whole" } }), "種類"],
    ["annual-documentなのにnot-applicable", (a) => (a["adoptedRef"] = { state: "not-applicable" }), "adoptedRef"],
    ["coverageが選択に合わない", (a) => (a["coverage"] = { state: "known", value: "entered-records-only" }), "coverage"],
    ["payersが空", (a) => (a["payers"] = []), "payers"],
  ];
  for (const [name, f, word] of cases) {
    const p = mutated((copy) => f(snapshot(copy)));
    assert.ok(p.some((x) => x.includes("EX-06-d c01") && x.includes(word)), `${name}: ${p.join(" / ") || "見つからない"}`);
  }
});

test("検査の自己確認: 実績化のfromで明細の行を指せるのは支給の行（otherEarnings）だけ", () => {
  const alloc = (copy: LedgerFiles): Obj => (op(scenario(firstCase(copy, "EX-04b"), "EX-04b-b2"), "o8")["record"] as Obj)["body"] as Obj;
  const pay = (copy: LedgerFiles): Obj => (op(scenario(firstCase(copy, "EX-04b"), "EX-04b-b2"), "o1")["record"] as Obj)["body"] as Obj;
  assert.deepEqual(mutated(() => undefined), []);
  const deduction = mutated((copy) => {
    pay(copy)["otherDeductions"] = { state: "known", value: [{ lineId: "d1", label: "その他の控除", amount: { state: "known", value: 100 } }] };
    alloc(copy)["from"] = { id: "pay_402", revision: "current", line: "d1" };
  });
  assert.ok(deduction.some((x) => x.includes("EX-04b-b2 o8") && x.includes("ref-target-invalid")), deduction.join("\n"));
  const missing = mutated((copy) => {
    alloc(copy)["from"] = { id: "pay_402", revision: "current", line: "l9" };
  });
  assert.ok(missing.some((x) => x.includes("EX-04b-b2 o8") && x.includes("ref-target-invalid")), missing.join("\n"));
});

test("検査の自己確認: 検査の中の並びのobjectでない要素を位置付きの問題にする", () => {
  const values = mutated((copy) => {
    ((check(scenario(firstCase(copy, "EX-01"), "EX-01-a"), "c01")["expect"]) as Obj)["values"] = [null];
  });
  assert.ok(values.some((x) => x.includes("EX-01-a c01") && x.includes("values[0]")), values.join("\n"));
  const years = mutated((copy) => {
    ((check(scenario(firstCase(copy, "EX-01"), "EX-01-a"), "c12")["expect"]) as Obj)["candidateYears"] = [null];
  });
  assert.ok(years.some((x) => x.includes("EX-01-a c12") && x.includes("candidateYears[0]")), years.join("\n"));
  const exceptions = mutated((copy) => {
    copy.commonSetup["coverageExceptions"] = [null];
  });
  assert.ok(exceptions.some((x) => x.includes("coverageExceptions[0]")), exceptions.join("\n"));
  const adoptions = mutated((copy) => {
    ((check(scenario(firstCase(copy, "EX-06"), "EX-06-d"), "c01")["expect"]) as Obj)["adoptions"] = [null];
  });
  assert.ok(adoptions.some((x) => x.includes("adoptions[0]")), adoptions.join("\n"));
});

test("検査の自己確認: 見込みの集計で口座の次元を許すのはdeposit-amountだけ", () => {
  const p = mutated((copy) => {
    const q = check(scenario(firstCase(copy, "EX-07"), "EX-07-a"), "c03")["query"] as Obj;
    (q["scope"] as Obj)["accountIds"] = ["acct_2"];
  });
  assert.ok(p.some((x) => x.includes("EX-07-a c03") && x.includes("許さない次元accountIds")), p.join("\n"));
  const q = mutated((copy) => {
    const c = check(scenario(firstCase(copy, "EX-07"), "EX-07-a"), "c03");
    const query = c["query"] as Obj;
    (query["key"] as Obj)["forecastMeasure"] = "deposit-amount";
    (query["scope"] as Obj)["accountIds"] = ["acct_2"];
  });
  assert.ok(!q.some((x) => x.includes("許さない次元")), q.join("\n"));
});

test("検査の自己確認: 復元で置く改訂のwriteRequestIdは一意にし、重なりを見つける", () => {
  const p = mutated((copy) => {
    const records = op(scenario(firstCase(copy, "EX-02"), "EX-02-c4"), "o1")["records"] as Obj[];
    for (const r of records.slice(0, 2)) r["writeRequestId"] = "w-dup";
  });
  assert.ok(p.some((x) => x.includes("EX-02-c4 o1") && x.includes("records[1]") && x.includes("w-dup")), p.join("\n"));
  assert.notEqual(restoredWriteRequestId("S", "o1", "pay_205", 1), restoredWriteRequestId("S", "o1", "pay_206", 1));
  assert.notEqual(restoredWriteRequestId("S", "o1", "pay_205", 1), restoredWriteRequestId("S", "o1", "pay_205", 2));
});

test("検査の自己確認: computedのrunの射影が分からない入力を要求していれば見つける", () => {
  const p = mutated((copy) => {
    const body = (op(scenario(firstCase(copy, "EX-04a"), "EX-04a-a4"), "o2")["record"] as Obj)["body"] as Obj;
    delete body["incomeTax"];
  });
  assert.ok(p.some((x) => x.includes("EX-04a-a4") && x.includes("分からない入力") && x.includes("pay_405")), p.join("\n"));
});

test("検査の自己確認: runの不足は要求ごとの範囲・日付の軸・支払者・項目だけで判断する（PR23-R004）", () => {
  const a6 = (copy: LedgerFiles): Obj => scenario(firstCase(copy, "EX-04a"), "EX-04a-a6");
  const body = (copy: LedgerFiles, opId: string): Obj => (op(a6(copy), opId)["record"] as Obj)["body"] as Obj;
  const runOf = (copy: LedgerFiles): Obj => op(a6(copy), "o3")["run"] as Obj;
  const onlyA6 = (p: string[]): string[] => p.filter((x) => x.includes("EX-04a-a6"));
  // 正常例: 9月の所得税と10月の総支給額を別々に要求し、要求していない9月の総支給額・10月の所得税は分からない。
  assert.deepEqual(onlyA6(mutated(() => undefined)), []);
  // 対: 要求していない項目がさらに分からなくても（記載なしでも）通る。
  assert.deepEqual(
    onlyA6(
      mutated((copy) => {
        body(copy, "o1")["residentTax"] = { state: "not-stated" };
        body(copy, "o2")["healthInsurance"] = { state: "unknown" };
      }),
    ),
    [],
  );
  // 負例: 実際に要求した項目（9月の所得税）が分からない。
  const requested = onlyA6(
    mutated((copy) => {
      body(copy, "o1")["incomeTax"] = { state: "unknown" };
    }),
  );
  assert.ok(requested.some((x) => x.includes("requests[0]") && x.includes("pay_421") && x.includes("incomeTax")), requested.join("\n"));
  assert.ok(!requested.some((x) => x.includes("requests[1]")), requested.join("\n"));
  // 負例: 2つ目の要求（10月の総支給額）だけが分からない。
  const second = onlyA6(
    mutated((copy) => {
      body(copy, "o2")["grossPay"] = { state: "not-stated" };
    }),
  );
  assert.ok(second.some((x) => x.includes("requests[1]") && x.includes("pay_422") && x.includes("grossPay")), second.join("\n"));
  // 負例: 要求の支払者の明細で、支払予定日が分からないものは範囲から外せない。
  const undated = onlyA6(
    mutated((copy) => {
      body(copy, "o2")["scheduledPayDate"] = { state: "unknown" };
    }),
  );
  assert.ok(undated.some((x) => x.includes("scheduledPayDate") && x.includes("pay_422")), undated.join("\n"));
  // 対: 要求の支払者でない明細は、分からない項目があっても判断に入れない。
  assert.deepEqual(
    onlyA6(
      mutated((copy) => {
        const ops = a6(copy)["operations"] as Obj[];
        ops.splice(2, 0, {
          op: "save",
          opId: "o2b",
          at: "2026-11-01T00:02:00.000Z",
          expect: { outcome: "accepted" },
          record: { id: "pay_423", recordType: "payslip", body: { employerId: "emp_2", scheduledPayDate: { state: "known", value: "2026-09-25" } } },
        });
        (runOf(copy)["inputsRecords"] as Obj[]).push({ id: "pay_423", revision: 1 });
      }),
    ),
    [],
  );
});

// A ← B ← Cの差し替えの系列を、EX-04a-a6の9月の所得税の要求の範囲に足す（合成の見本）。Aの所得税だけが分からない。
function addSeriesToA6(copy: LedgerFiles, voids: readonly string[]): void {
  const sc = scenario(firstCase(copy, "EX-04a"), "EX-04a-a6");
  const ops = sc["operations"] as Obj[];
  const pay = (id: string, tax: Obj, sup?: string): Obj => ({
    id,
    recordType: "payslip",
    body: {
      employerId: "emp_1",
      paymentKind: { state: "known", value: "salary" },
      scheduledPayDate: { state: "known", value: "2026-09-25" },
      incomeTax: tax,
      ...(sup === undefined ? {} : { supersedes: { state: "known", value: { id: sup, revision: "current", line: "whole" } } }),
    },
  });
  const added: Obj[] = [
    { op: "save", opId: "s1", at: "2026-11-01T00:10:00.000Z", expect: { outcome: "accepted" }, record: pay("pay_431", { state: "unknown" }) },
    { op: "save", opId: "s2", at: "2026-11-01T00:11:00.000Z", expect: { outcome: "accepted" }, record: pay("pay_432", { state: "known", value: 4100 }, "pay_431") },
    { op: "save", opId: "s3", at: "2026-11-01T00:12:00.000Z", expect: { outcome: "accepted" }, record: pay("pay_433", { state: "known", value: 4200 }, "pay_432") },
  ];
  const revisions = new Map<string, number>([["pay_431", 1], ["pay_432", 1], ["pay_433", 1]]);
  voids.forEach((id, i) => {
    added.push({ op: "save", opId: `v${i + 1}`, at: `2026-11-01T00:2${i}:00.000Z`, expect: { outcome: "accepted" }, record: { id, recordType: "payslip", revision: 2, reason: "void" } });
    revisions.set(id, 2);
  });
  ops.splice(2, 0, ...added);
  const run = op(sc, "o3")["run"] as Obj;
  for (const [id, revision] of revisions) (run["inputsRecords"] as Obj[]).push({ id, revision });
}

test("検査の自己確認: runの不足の判断は、取消した中間の記録を通り過ぎて現在の記録を決める（A ← B ← C）", () => {
  const onlyA6 = (p: string[]): string[] => p.filter((x) => x.includes("EX-04a-a6"));
  // 系列が整っていれば、差し替え済みのA（所得税が分からない）は判断に入らない。
  assert.deepEqual(onlyA6(mutated((copy) => addSeriesToA6(copy, []))), []);
  // Bだけを取消すと、CはBを通り過ぎてAを差し替える（現在の記録はC）。Aは判断に入らない。
  assert.deepEqual(onlyA6(mutated((copy) => addSeriesToA6(copy, ["pay_432"]))), []);
  // BとCを取消すと、取消していない記録はAだけで、Aが現在の記録に戻る。Aの所得税が分からないので不足。
  const both = onlyA6(mutated((copy) => addSeriesToA6(copy, ["pay_432", "pay_433"])));
  assert.ok(both.some((x) => x.includes("requests[0]") && x.includes("pay_431") && x.includes("incomeTax")), both.join("\n"));
  // 系列の橋の記録（取消したB）を固定していないrunは、固定した版でたどれないので不足とする。
  const bridge = onlyA6(
    mutated((copy) => {
      addSeriesToA6(copy, ["pay_432"]);
      const run = op(scenario(firstCase(copy, "EX-04a"), "EX-04a-a6"), "o3")["run"] as Obj;
      run["inputsRecords"] = (run["inputsRecords"] as Obj[]).filter((r) => r["id"] !== "pay_432");
    }),
  );
  assert.ok(bridge.some((x) => x.includes("pay_433") && x.includes("整っていない差し替えの系列")), bridge.join("\n"));
  // 固定していないBをはさむ系列はAまで広く取り、Aも系列の記録として不足にする（Cだけを除いてAを数えない）。
  assert.ok(bridge.some((x) => x.includes("pay_431") && x.includes("整っていない差し替えの系列")), bridge.join("\n"));
});

test("検査の自己確認: 二重登録の取消の残す方は、差し替えの系列の現在の記録だけ", () => {
  const p = mutated((copy) => {
    addSeriesToA6(copy, []);
    const ops = scenario(firstCase(copy, "EX-04a"), "EX-04a-a6")["operations"] as Obj[];
    ops.splice(5, 0,
      { op: "save", opId: "d1", at: "2026-11-01T00:30:00.000Z", expect: { outcome: "accepted" }, record: { id: "pay_434", recordType: "payslip", body: { employerId: "emp_1", scheduledPayDate: { state: "known", value: "2026-09-26" } } } },
      { op: "save", opId: "d2", at: "2026-11-01T00:31:00.000Z", expect: { outcome: "accepted" }, record: { id: "pay_434", recordType: "payslip", revision: 2, reason: "void", duplicateOf: { state: "known", value: { id: "pay_431", revision: "current", line: "whole" } } } },
    );
  });
  assert.ok(p.some((x) => x.includes("EX-04a-a6 d2") && x.includes("ref-target-invalid")), p.join("\n"));
});

// TC-04-bの系列（pay_S1 ← S2 ← S3 ← S7）を固定し、10月の総支給額を要求するcomputedのrun（runの射影の見本）。
function seriesRun(id: string, s7Revision: number): Obj {
  return {
    op: "saveRun",
    opId: `r-${id}`,
    at: "2026-10-29T00:00:00.000Z",
    expect: { outcome: "accepted" },
    run: {
      id,
      createdAt: "2026-10-29T00:00:00.000Z",
      calculator: { id: "calc-fixture-tax", version: "1" },
      calculatorAllowsPayers: true,
      target: {
        year: { kind: "calendar", year: 2026 },
        jurisdiction: { state: "known", value: { kind: "national", code: "fixture-national" } },
        procedure: "tax-return",
        referencePoint: { state: "known", value: { kind: "date", date: "2027-03-15" } },
        scope: { state: "known", value: { kind: "payers", payers: ["emp_1"] } },
        scopeNote: { state: "not-applicable" },
      },
      status: "computed",
      inputStage: "fixed",
      previousRunId: { state: "not-applicable" },
      requests: [{ kind: "aggregate", key: { kind: "payslip-item", item: "grossPay" }, axis: "scheduled-pay-date", scope: { employerIds: ["emp_1"], accountIds: [], from: "2026-10-01", to: "2026-10-31" } }],
      inputsRecords: [
        { id: "pay_S1", revision: 1 },
        { id: "pay_S2", revision: 1 },
        { id: "pay_S3", revision: 1 },
        { id: "pay_S7", revision: s7Revision },
        { id: "emp_1", revision: 1 },
      ],
    },
  };
}

test("検査の自己確認: 差し替えの識別の次元が未確定の系列（未確認の系列）は、現在の記録として扱わない", () => {
  const tc = (copy: LedgerFiles): Obj[] => scenario(firstCase(copy, "TC-04"), "TC-04-b")["operations"] as Obj[];
  const only = (p: string[]): string[] => p.filter((x) => x.includes("TC-04-b"));
  // pay_S7の明細の種類が分からない間（o04のあと）は、系列全体が未確認の系列なので、computedのrunは不足。
  const unconfirmed = only(mutated((copy) => tc(copy).splice(4, 0, seriesRun("run_441", 1))));
  assert.ok(unconfirmed.some((x) => x.includes("pay_S7") && x.includes("整っていない差し替えの系列")), unconfirmed.join("\n"));
  assert.ok(unconfirmed.some((x) => x.includes("pay_S1") && x.includes("整っていない差し替えの系列")), unconfirmed.join("\n"));
  // 対: 明細の種類を埋めて整った系列になったあと（o05のあと）は、現在の記録pay_S7だけを判断し、通る。
  assert.deepEqual(only(mutated((copy) => tc(copy).push(seriesRun("run_442", 2)))), []);
  // 二重登録の取消の残す方: 未確認の系列の記録は有効な記録ではないので、残す方にできない。
  const voidTo = (at: number, opPrefix: string): ((copy: LedgerFiles) => void) => (copy) => {
    tc(copy).splice(
      at,
      0,
      { op: "save", opId: `${opPrefix}1`, at: "2026-10-29T01:00:00.000Z", expect: { outcome: "accepted" }, record: { id: "pay_S8", recordType: "payslip", body: { employerId: "emp_1", scheduledPayDate: { state: "known", value: "2026-10-23" } } } },
      { op: "save", opId: `${opPrefix}2`, at: "2026-10-29T01:01:00.000Z", expect: { outcome: "accepted" }, record: { id: "pay_S8", recordType: "payslip", revision: 2, reason: "void", duplicateOf: { state: "known", value: { id: "pay_S7", revision: "current", line: "whole" } } } },
    );
  };
  const dup = only(mutated(voidTo(4, "d")));
  assert.ok(dup.some((x) => x.includes("TC-04-b d2") && x.includes("ref-target-invalid")), dup.join("\n"));
  // 対: 整った系列の現在の記録なら、残す方にできる。
  assert.deepEqual(only(mutated(voidTo(5, "e"))), []);
});

// EX-04a-a6のrun（9月の所得税・10月の総支給額を要求）の前に、restoreUncheckedで差し替えの関係を置いた明細を復元し、runに固定する
// （合成の見本）。どの明細も識別の次元（emp_1・salary・支払予定日）が一致し、要求の項目（所得税・総支給額）は分かっている。
// records: [ID, 版, 差し替える先（なければundefined）, 取消すか]。
type Restored = readonly [string, number, string | undefined, boolean?];
function restoreSeriesToA6(copy: LedgerFiles, records: readonly Restored[], date: Obj = { state: "known", value: "2026-09-25" }): void {
  const sc = scenario(firstCase(copy, "EX-04a"), "EX-04a-a6");
  const pins = new Map<string, number>();
  const restored = records.map(([id, revision, sup, voided]) => {
    pins.set(id, revision);
    const supersedes = sup === undefined ? { state: "not-applicable" } : { state: "known", value: { id: sup, revision: "current", line: "whole" } };
    if (revision > 1) return { id, recordType: "payslip", revision, reason: voided === true ? "void" : "correct-input-error", body: { supersedes } };
    return {
      id,
      recordType: "payslip",
      body: { employerId: "emp_1", paymentKind: { state: "known", value: "salary" }, scheduledPayDate: date, incomeTax: { state: "known", value: 4100 }, grossPay: { state: "known", value: 230000 }, supersedes },
    };
  });
  (sc["operations"] as Obj[]).splice(2, 0, { op: "restoreUnchecked", opId: "r1", at: "2026-11-01T00:10:00.000Z", expect: { outcome: "restored" }, expectedViolations: [], records: restored });
  const run = op(sc, "o3")["run"] as Obj;
  for (const [id, revision] of pins) (run["inputsRecords"] as Obj[]).push({ id, revision });
}

test("検査の自己確認: 自己参照・循環の差し替えの系列は、取消していない記録どうしでも整っていない系列にする（PR23-R005）", () => {
  const onlyA6 = (p: string[]): string[] => p.filter((x) => x.includes("EX-04a-a6"));
  const flagged = (p: string[], ids: readonly string[]): void => {
    for (const id of ids) assert.ok(p.some((x) => x.includes("requests[0]") && x.includes(id) && x.includes("整っていない差し替えの系列")), `${id}\n${p.join("\n")}`);
  };
  // 自己参照（A → A）。
  flagged(onlyA6(mutated((copy) => restoreSeriesToA6(copy, [["pay_441", 1, "pay_441"]]))), ["pay_441"]);
  // 2件の循環（A → B → A）。Aの版2でBを指す。
  flagged(onlyA6(mutated((copy) => restoreSeriesToA6(copy, [["pay_441", 1, undefined], ["pay_442", 1, "pay_441"], ["pay_441", 2, "pay_442"]]))), ["pay_441", "pay_442"]);
  // 3件の循環（A → C → B → A）。
  flagged(
    onlyA6(mutated((copy) => restoreSeriesToA6(copy, [["pay_441", 1, undefined], ["pay_442", 1, "pay_441"], ["pay_443", 1, "pay_442"], ["pay_441", 2, "pay_443"]]))),
    ["pay_441", "pay_442", "pay_443"],
  );
  // 取消した記録を通り過ぎて自分に戻る循環（A → B（取消） → A）は、Aの自己参照の関係になる。
  flagged(onlyA6(mutated((copy) => restoreSeriesToA6(copy, [["pay_441", 1, undefined], ["pay_442", 1, "pay_441"], ["pay_441", 2, "pay_442"], ["pay_442", 2, "pay_441", true]]))), ["pay_441"]);
  // 対: 同じ記録の正常な鎖（A ← B ← C）と、取消した中間の記録（Bを取消し、CがAを差し替える）は通る。
  assert.deepEqual(onlyA6(mutated((copy) => restoreSeriesToA6(copy, [["pay_441", 1, undefined], ["pay_442", 1, "pay_441"], ["pay_443", 1, "pay_442"]]))), []);
  assert.deepEqual(
    onlyA6(mutated((copy) => restoreSeriesToA6(copy, [["pay_441", 1, undefined], ["pay_442", 1, "pay_441"], ["pay_443", 1, "pay_442"], ["pay_442", 2, "pay_441", true]]))),
    [],
  );
  // 二重登録の取消の残す方: 循環の系列の記録は有効な記録ではないので、残す方にできない（同じ補助を使う）。
  const dupTo = (records: readonly Restored[]): string[] =>
    onlyA6(
      mutated((copy) => {
        restoreSeriesToA6(copy, records);
        (scenario(firstCase(copy, "EX-04a"), "EX-04a-a6")["operations"] as Obj[]).splice(
          3,
          0,
          { op: "save", opId: "d1", at: "2026-11-01T00:30:00.000Z", expect: { outcome: "accepted" }, record: { id: "pay_444", recordType: "payslip", body: { employerId: "emp_1", scheduledPayDate: { state: "known", value: "2026-09-26" } } } },
          { op: "save", opId: "d2", at: "2026-11-01T00:31:00.000Z", expect: { outcome: "accepted" }, record: { id: "pay_444", recordType: "payslip", revision: 2, reason: "void", duplicateOf: { state: "known", value: { id: "pay_442", revision: "current", line: "whole" } } } },
        );
      }),
    );
  assert.ok(dupTo([["pay_441", 1, undefined], ["pay_442", 1, "pay_441"], ["pay_441", 2, "pay_442"]]).some((x) => x.includes("EX-04a-a6 d2") && x.includes("ref-target-invalid")));
  assert.ok(dupTo([["pay_442", 1, "pay_442"]]).some((x) => x.includes("EX-04a-a6 d2") && x.includes("ref-target-invalid")));
  // 対: 正常な鎖の現在の記録（B ← Aの鎖の最新のB）なら残す方にできる。
  assert.ok(!dupTo([["pay_441", 1, undefined], ["pay_442", 1, "pay_441"]]).some((x) => x.includes("EX-04a-a6 d2")));
});

test("検査の自己確認: 整っていない系列でも、既知の日付で要求の範囲の外と確定できる記録は不足にしない（PR23-R004）", () => {
  const onlyA6 = (p: string[]): string[] => p.filter((x) => x.includes("EX-04a-a6"));
  const cycle: readonly Restored[] = [["pay_441", 1, undefined], ["pay_442", 1, "pay_441"], ["pay_441", 2, "pay_442"]];
  // 期間外: 循環の系列の明細が11月なら、9月・10月の要求のどちらの範囲にも入らないので通る。
  assert.deepEqual(onlyA6(mutated((copy) => restoreSeriesToA6(copy, cycle, { state: "known", value: "2026-11-25" }))), []);
  // 期間内: 同じ系列が9月なら、9月の要求（requests[0]）の不足。10月の要求（requests[1]）には挙がらない。
  const inside = onlyA6(mutated((copy) => restoreSeriesToA6(copy, cycle)));
  assert.ok(inside.some((x) => x.includes("requests[0]") && x.includes("整っていない差し替えの系列")), inside.join("\n"));
  assert.ok(!inside.some((x) => x.includes("requests[1]")), inside.join("\n"));
  // 日付不明: 支払予定日が分からない（unknown・not-stated）明細は範囲から外せないので、どちらの要求でも不足。
  for (const state of ["unknown", "not-stated"]) {
    const undated = onlyA6(mutated((copy) => restoreSeriesToA6(copy, cycle, { state })));
    assert.ok(undated.some((x) => x.includes("requests[0]") && x.includes(`scheduledPayDateが${state}`)), undated.join("\n"));
    assert.ok(undated.some((x) => x.includes("requests[1]") && x.includes(`scheduledPayDateが${state}`)), undated.join("\n"));
  }
  // 未確認の系列（TC-04-bのo04のあと。系列は10月）: 9月だけを要求するrunは通り、10月を要求するrunは不足（上の試験）。
  const tc = (copy: LedgerFiles): Obj[] => scenario(firstCase(copy, "TC-04"), "TC-04-b")["operations"] as Obj[];
  const september = (copy: LedgerFiles): void => {
    const r = seriesRun("run_443", 1);
    const scope = (((r["run"] as Obj)["requests"] as Obj[])[0] as Obj)["scope"] as Obj;
    scope["from"] = "2026-09-01";
    scope["to"] = "2026-09-30";
    tc(copy).splice(4, 0, r);
  };
  assert.deepEqual(mutated(september).filter((x) => x.includes("TC-04-b")), []);
});

test("検査の自己確認: 系列の状態の期待値は、runの検査・二重登録の取消と同じ系列の補助で導いた状態と一致させる", () => {
  const p = mutated((copy) => {
    (check(scenario(firstCase(copy, "TC-04"), "TC-04-b"), "c02")["expect"] as Obj)["status"] = "superseded";
  });
  assert.ok(p.some((x) => x.includes("TC-04-b c02") && x.includes("系列の補助で導いたunconfirmed-series")), p.join("\n"));
});

test("検査の自己確認: 系列の状態の期待値を最新の状態と比べるのは現在の見方だけで、時点を指定した見方は比べない（PR23-R006）", () => {
  const only = (p: string[]): string[] => p.filter((x) => x.includes("TC-04-a "));
  // TC-04-aのo03のあと（pay_S1 ← S2 ← S3）。現在はpay_S1が差し替え済み。o01の直後の時点ではpay_S2がまだなく、pay_S1は現在の記録。
  const withCheck = (view: Obj | undefined, status: string, knownOn = false): string[] =>
    only(
      mutated((copy) => {
        const sc = scenario(firstCase(copy, "TC-04"), "TC-04-a");
        if (knownOn) {
          // 把握時点の再現の見本: pay_S1は10月20日、pay_S2は10月24日に把握した（pay_S3は把握日不明のまま）。
          (op(sc, "o01")["record"] as Obj)["knownOn"] = { state: "known", value: "2026-10-20" };
          (op(sc, "o02")["record"] as Obj)["knownOn"] = { state: "known", value: "2026-10-24" };
        }
        const base = check(sc, "c02");
        (sc["checks"] as Obj[]).push({
          ...base,
          checkId: "v01",
          afterOp: "o03",
          ...(view === undefined ? {} : { view }),
          query: { kind: "seriesStatus", record: "pay_S1" },
          expect: { status },
        });
      }),
    );
  // 時点を指定した見方の正しい過去の期待値（current）は、最新の状態（superseded）と比べて拒否しない。
  assert.deepEqual(withCheck({ kind: "record-seq", seq: "N+1" }, "current"), []);
  assert.deepEqual(withCheck({ kind: "record-time", time: "2026-10-24T01:00:30.000Z" }, "current"), []);
  assert.deepEqual(withCheck({ kind: "known-on", date: "2026-10-21" }, "current", true), []);
  // 対: 見方を省略、または明示したcurrentでは、誤った期待値（current）を引き続き拒否する。
  for (const view of [undefined, { kind: "current" }]) {
    const p = withCheck(view, "current");
    assert.ok(p.some((x) => x.includes("TC-04-a v01") && x.includes("系列の補助で導いたsuperseded")), `${stableStringify(view)}\n${p.join("\n")}`);
    assert.deepEqual(withCheck(view, "superseded"), []);
  }
});

test("検査の自己確認: 目的が決まらないrunはどの鎖にも入らず、目的が決まった最初のrunは1要素の鎖", () => {
  const c = (copy: LedgerFiles, id: string): Obj => check(scenario(firstCase(copy, "EX-04a"), "EX-04a-a4"), id);
  // run_406（scopeがunknown）に1要素の鎖を期待すると問題。
  const p = mutated((copy) => {
    (c(copy, "c03")["expect"] as Obj)["chain"] = ["run_406"];
  });
  assert.ok(p.some((x) => x.includes("EX-04a-a4 c03") && x.includes("どの鎖にも入らない")), p.join("\n"));
  // 目的が決まった最初のrun（run_404）に空の鎖を期待すると問題。
  const q = mutated((copy) => {
    (c(copy, "c02")["expect"] as Obj)["chain"] = [];
  });
  assert.ok(q.some((x) => x.includes("EX-04a-a4 c02") && x.includes("1要素")), q.join("\n"));
});

test("台帳のIDの接頭辞は契約の表と同じ", () => {
  assert.equal(PREFIX["bank-deposit"], "dep");
  assert.equal(EVIDENCE_FILE_PREFIX, "evf");
  assert.ok(isIdOf("pay_101", "pay"));
  assert.ok(!isIdOf("pay_", "pay"));
});

test("検査の自己確認: 共通の設定・ケース・制度のケースの契約版が台帳の契約版と違えば見つける", () => {
  assert.deepEqual(mutated(() => undefined), []);
  const regime = mutated((copy) => {
    const r = copy.regime[0];
    assert.ok(r);
    r.data["contractVersion"] = "1.0";
  });
  assert.ok(regime.some((x) => x.startsWith("regime/") && x.includes("contractVersion")), regime.join(" / "));
  const kase = mutated((copy) => (firstCase(copy, "EX-01")["contractVersion"] = "1.0"));
  assert.ok(kase.some((x) => x.includes("EX-01") && x.includes("contractVersion")), kase.join(" / "));
  const common = mutated((copy) => (copy.commonSetup["contractVersion"] = "1.0"));
  assert.ok(common.some((x) => x.startsWith("common-setup") && x.includes("contractVersion")), common.join(" / "));
});

test("検査の自己確認: 拡張できる列挙の知らない値は、保存の検査では違反、読取・復元の検査では違反でなく、値を書き換えない（共通の型の1）", () => {
  const record = expandRecord(
    {
      id: "pay_X1",
      recordType: "payslip",
      body: {
        employerId: "emp_1",
        paymentKind: { state: "known", value: "bonus" },
        incomeTimingKind: { state: "known", value: "officer-bonus" },
        scheduledPayDate: { state: "known", value: "2026-12-25" },
        grossPay: { state: "known", value: 200000 },
      },
    },
    { scenarioId: "self-check", opId: "o1", previous: undefined },
  );
  const kind = (record["body"] as Obj)["incomeTimingKind"];
  assert.deepEqual(kind, { state: "known", value: "officer-bonus" });
  const save = checkRecordStatic(record, "save");
  assert.ok(save.some((v) => v.code === "value-invalid" && v.path.includes("incomeTimingKind")), JSON.stringify(save));
  assert.deepEqual(checkRecordStatic(record, "read"), []);
  // 読取でも、拡張できない列挙の知らない値と、空の文字列は違反のまま。
  const body = record["body"] as Obj;
  const notOpen = { ...record, body: { ...body, paymentKind: { state: "known", value: "officer-bonus" } } };
  assert.ok(checkRecordStatic(notOpen, "read").some((v) => v.code === "value-invalid" && v.path.includes("paymentKind")));
  const empty = { ...record, body: { ...body, incomeTimingKind: { state: "known", value: "" } } };
  assert.ok(checkRecordStatic(empty, "read").some((v) => v.code === "value-invalid" && v.path.includes("incomeTimingKind")));
  // 台帳の場面: EX-05-hの復元は違反なし、TC-02-aのo05dの新しい保存は拒否。
  const h = mutated((copy) => (op(scenario(firstCase(copy, "EX-05"), "EX-05-h"), "o1")["expectedViolations"] = ["value-invalid"]));
  assert.ok(h.some((x) => x.includes("EX-05-h") && x.includes("expectedViolations")), h.join(" / "));
});

