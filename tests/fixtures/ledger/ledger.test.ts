// 合成データと期待結果の台帳（T03）の検査。期待値の正しさ（契約からの導き方）は別の担当がレビューで確かめる。
// この試験が確かめるのは、台帳の形、合成の入力が契約の保存の条件を満たすこと、拒否を期待する保存のうち
// 記録だけで判定できる理由がその違反を実際に含むこと、期待の形が契約の状態の表と矛盾しないこと、
// 理由の引用が契約の本文に実在すること、合成例の節をすべて扱っていること、制度のケースの必須の項目。
// 実行: node --test tests/fixtures/ledger/ledger.test.ts（T05のCIの統合後はnpm testにも含まれる）。

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
import { CONTRACTS_DIR, expandRecord, ledgerFileNames, readLedgerFiles, resolveOperations, stableStringify, type LedgerFiles, type Obj } from "./load.ts";

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
const COMPARISON_STATES = ["rule-pending", "no-coverage", "incomplete", "match", "mismatch-unresolved", "mismatch-explained"];
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
  "notice-duplicate": { states: ["conflict"], ref: ["official-notice"] },
  "supersede-series": { states: ["conflict"], ref: ["payslip", "annual-document", "official-notice"] },
  "forecast-remaining": { states: ["unknown"], ref: ["forecast"], line: "line" },
  "unreconciled-amount": { states: ["unknown"], ref: ["bank-deposit", "payslip"] },
  "save-check": { states: ["conflict"], ref: RECORD_TYPES },
};

// AggregateKeyの表（共通の型の11）。
const AGG_KINDS: Readonly<Record<string, { axis: string; modifiers: Readonly<Record<string, readonly string[]>>; dims: readonly string[] }>> = {
  "deposit-amount": { axis: "deposit-date", modifiers: {}, dims: ["accountIds"] },
  "payslip-item": { axis: "scheduled-pay-date", modifiers: { item: PAYSLIP_AMOUNT_ITEMS }, dims: ["employerIds"] },
  "payslip-by-income-year": { axis: "income-year", modifiers: { item: PAYSLIP_AMOUNT_ITEMS }, dims: ["employerIds"] },
  "annual-value": { axis: "income-year", modifiers: { item: ANNUAL_AMOUNT_ITEMS }, dims: ["employerIds"] },
  "forecast-remaining": {
    axis: "expected-month",
    modifiers: { forecastMeasure: ["gross-pay", "net-pay", "bank-transfer", "deposit-amount"] },
    dims: ["employerIds", "accountIds"],
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
    for (const line of text.split("\n")) {
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
    const target = latest(state, dupOf["id"]);
    if (target !== undefined && target["status"] !== "active") codes.add("ref-target-invalid");
  }
  // 照合配分の行を指す参照は、参照先の現在の版にある行だけ（共通の型の2）。
  if (rec["recordType"] === "allocation" && isObj(rec["body"])) {
    for (const end of ["from", "to"]) {
      const ref = rec["body"][end];
      if (isObj(ref) && typeof ref["id"] === "string" && typeof ref["line"] === "string" && ref["line"] !== "whole") {
        const target = latest(state, ref["id"]);
        if (target !== undefined && !lineIdsOf(target).has(ref["line"])) codes.add("ref-target-invalid");
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
          try {
            rec = expandRecord(r, { scenarioId, opId, previous: latest(state, String(r["id"])) });
          } catch (e) {
            problems.add(w, `記録を補えない: ${(e as Error).message}`);
            continue;
          }
          for (const v of checkRecordStatic(rec)) {
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
    if (list.length > 0 && !spec.dims.includes(dim) && !allowRejected) ctx.problems.add(ctx.where, `kind ${key["kind"]}に許さない次元${dim}`);
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
    if (!isObj(v)) return;
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
      if (kind !== "annual-value" && kind !== "payslip-by-income-year" && cs !== "not-applicable") ctx.problems.add(ctx.where, "所得の年の軸以外のcoverageはnot-applicable");
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
    if (!isObj(r)) return;
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
    case "seriesStatus":
      requireRecord(ctx, query["record"], ["payslip", "annual-document", "official-notice"]);
      if (!SERIES_STATUSES.includes(String(expect["status"]))) ctx.problems.add(ctx.where, "系列の状態が表にない");
      return;
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
      if (!ctx.state.runs.has(String(query["run"]))) ctx.problems.add(ctx.where, "runがない");
      const chain = expect["chain"];
      if (!Array.isArray(chain) || chain.length === 0 || chain[chain.length - 1] !== query["run"]) ctx.problems.add(ctx.where, "chainは最初のrunからこのrunまでの並び");
      else for (const r of chain) if (!ctx.state.runs.has(String(r))) ctx.problems.add(ctx.where, `chainのrunがない: ${String(r)}`);
      return;
    }
    case "requiredAdoptions": {
      checkRequests(ctx, query["requests"]);
      const list = expect["adoptions"];
      if (!Array.isArray(list)) {
        ctx.problems.add(ctx.where, "adoptionsが並びではない");
        return;
      }
      for (const a of list) {
        if (!isObj(a) || !isCalendarYear(a["year"]) || !Array.isArray(a["payers"]) || !SELECTIONS.includes(String(a["selection"]))) {
          ctx.problems.add(ctx.where, "AdoptionSnapshotの形");
          continue;
        }
        if (!Array.isArray(a["comparisons"])) ctx.problems.add(ctx.where, "comparisonsが並びではない");
        else for (const c of a["comparisons"]) if (!isObj(c) || !ANNUAL_AMOUNT_ITEMS.includes(String(c["field"])) || !COMPARISON_STATES.includes(String(c["state"]))) ctx.problems.add(ctx.where, "comparisonsの要素の形");
      }
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

export function validateLedger(files: LedgerFiles, docs: ContractDocs): string[] {
  const problems = new Problems();
  const common = files.commonSetup;
  if (common["schemaVersion"] !== 1 || common["contractVersion"] !== "1.0") problems.add("common-setup", "schemaVersion 1・contractVersion 1.0");
  const commonReplay = replayOps(common["operations"], "common", newState(), 0, "common-setup", problems);
  const commonState = commonReplay.state;
  const commonCount = commonState.seq;
  checkCites(common["cites"], docs, "common-setup", problems);
  const covered = new Set<string>();
  if (!Array.isArray(common["coverageExceptions"])) problems.add("common-setup", "coverageExceptionsが並びではない（例外がなければ空の並び）");
  const exceptions = Array.isArray(common["coverageExceptions"]) ? common["coverageExceptions"] : [];
  for (const e of exceptions) if (isObj(e)) covered.add(`${String(e["section"])}|${String(e["subsection"] ?? "")}`);
  const tags = new Set<string>();
  const caseIds = new Set<string>();
  const scenarioIds = new Set<string>();
  for (const { file, data } of files.cases) {
    const caseId = data["caseId"];
    if (typeof caseId !== "string" || file !== `cases/${caseId}.json`) problems.add(file, "caseIdとファイル名が合わない");
    if (caseIds.has(String(caseId))) problems.add(file, "caseIdが重なる");
    caseIds.add(String(caseId));
    if (data["schemaVersion"] !== 1 || data["contractVersion"] !== "1.0") problems.add(file, "schemaVersion 1・contractVersion 1.0");
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
    if (data["schemaVersion"] !== 1) problems.add(file, "schemaVersion 1");
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
  assert.throws(() => ledgerFileNames("cases", ["EX-01.json", "EX-01.json.bak", ".DS_Store"]), /EX-01\.json\.bak, \.DS_Store/);
  assert.deepEqual(ledgerFileNames("cases", ["TC-01.json", "EX-01.json"]), ["EX-01.json", "TC-01.json"]);
});

test("台帳のIDの接頭辞は契約の表と同じ", () => {
  assert.equal(PREFIX["bank-deposit"], "dep");
  assert.equal(EVIDENCE_FILE_PREFIX, "evf");
  assert.ok(isIdOf("pay_101", "pay"));
  assert.ok(!isIdOf("pay_", "pay"));
});
