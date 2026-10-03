// 台帳のfixture（tests/fixtures/ledger/）を読み、省略した項目を既定で補った記録にする。
// 既定はdocs/test-oracles/README.mdの「省略した項目の既定」（examples.mdの「読み方」の1〜7を項目ごとに決めたもの）。
// 補うのは入力の記録だけで、期待値（checksのexpect）には手を加えない。T06・T11等の試験はこのモジュールを読んでよい。

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BODY, isObj, recordTypeOfId, SOURCE_LISTS_DEFAULT_EMPTY, type RecordType, type Spec } from "./contract-shape.ts";

export type Obj = Record<string, unknown>;

export const LEDGER_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(LEDGER_DIR, "..", "..", "..");
export const CONTRACTS_DIR = join(REPO_ROOT, "docs", "contracts");

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export interface LedgerFiles {
  commonSetup: Obj;
  cases: { file: string; data: Obj }[];
  regime: { file: string; data: Obj }[];
}

export function readLedgerFiles(dir: string = LEDGER_DIR): LedgerFiles {
  const common = readJson(join(dir, "common-setup.json"));
  if (!isObj(common)) throw new Error("common-setup.jsonがobjectではない");
  const list = (sub: string): { file: string; data: Obj }[] =>
    readdirSync(join(dir, sub))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        const data = readJson(join(dir, sub, f));
        if (!isObj(data)) throw new Error(`${sub}/${f}がobjectではない`);
        return { file: `${sub}/${f}`, data };
      });
  return { commonSetup: common, cases: list("cases"), regime: list("regime") };
}

const NO_DEFAULT = Symbol("no-default");

function conditionalDefault(type: RecordType, field: string, body: Obj): unknown | typeof NO_DEFAULT | undefined {
  const na = { state: "not-applicable" };
  if (type === "allocation") {
    if (field === "settlesForecastLine") return body["kind"] === "forecast-realization" ? NO_DEFAULT : na;
    if (field === "confirmedAgainst") return body["allocationStatus"] === "confirmed" ? NO_DEFAULT : na;
    if (field === "amount" && body["kind"] === "annual-coverage") return na;
  }
  if (type === "decision") {
    const t = body["decisionType"];
    if (field === "scope") return t === "annual-adoption" || t === "mismatch-explanation" ? NO_DEFAULT : na;
    if (field === "explainedComparisons") return t === "mismatch-explanation" ? NO_DEFAULT : na;
  }
  if (type === "forecast" && field === "accountId") return body["subject"] === "deposit" ? NO_DEFAULT : na;
  return undefined;
}

function defaultFor(field: string, spec: Spec): unknown | typeof NO_DEFAULT {
  if (spec.t === "fact") {
    if (field === "supersedes") return { state: "not-applicable" };
    if (spec.listFromSource === true) {
      return SOURCE_LISTS_DEFAULT_EMPTY.includes(field) ? { state: "known", value: [] } : { state: "unknown" };
    }
    return { state: "unknown" };
  }
  if (spec.t === "text" || spec.t === "nonEmptyText") return "合成";
  if (field === "lineStatus") return "open";
  return NO_DEFAULT;
}

function expandObject(fields: Readonly<Record<string, Spec>>, given: Obj, where: string, type?: RecordType): Obj {
  const out: Obj = {};
  for (const [field, spec] of Object.entries(fields)) {
    if (field in given) {
      out[field] = expandNested(spec, given[field], `${where}.${field}`);
      continue;
    }
    const cond = type === undefined ? undefined : conditionalDefault(type, field, given);
    const d = cond === undefined ? defaultFor(field, spec) : cond;
    if (d === NO_DEFAULT) throw new Error(`${where}.${field}: 既定のない項目を省略している`);
    out[field] = d;
  }
  for (const k of Object.keys(given)) if (!(k in fields)) out[k] = given[k];
  return out;
}

// 並びの要素（行）も、省略した項目を同じ既定で補う。
function expandNested(spec: Spec, v: unknown, where: string): unknown {
  if (spec.t === "list" && spec.of.t === "object" && Array.isArray(v)) {
    const fields = spec.of.fields;
    return v.map((e, i) => (isObj(e) ? expandObject(fields, e, `${where}[${i}]`) : e));
  }
  if (spec.t === "fact" && isObj(v) && v["state"] === "known" && "value" in v) {
    return { ...v, value: expandNested(spec.of, v["value"], `${where}.value`) };
  }
  return v;
}

export interface ExpandContext {
  scenarioId: string;
  opId: string;
  previous: Obj | undefined;
}

// 省略した改訂の共通の形の項目とbodyを補う。版2以上は、直前の採用された改訂のbodyに、書いた項目だけを差し替える。
export function expandRecord(compact: Obj, ctx: ExpandContext): Obj {
  const recordType = compact["recordType"];
  const id = compact["id"];
  if (typeof recordType !== "string" || !(recordType in BODY)) throw new Error(`${ctx.opId}: recordTypeがない`);
  const type = recordType as RecordType;
  if (typeof id !== "string" || recordTypeOfId(id) !== type) throw new Error(`${ctx.opId}: IDの接頭辞がrecordTypeと合わない: ${String(id)}`);
  const reason = typeof compact["reason"] === "string" ? compact["reason"] : "create";
  const revision = typeof compact["revision"] === "number" ? compact["revision"] : 1;
  const prev = ctx.previous;
  const given = isObj(compact["body"]) ? compact["body"] : {};
  let body: Obj;
  if (reason === "create" || prev === undefined) {
    body = expandObject(BODY[type], given, `${ctx.opId}.body`, type);
  } else {
    const base = isObj(prev["body"]) ? prev["body"] : {};
    const merged: Obj = { ...base };
    for (const [k, v] of Object.entries(given)) {
      const spec = BODY[type][k];
      merged[k] = spec === undefined ? v : expandNested(spec, v, `${ctx.opId}.body.${k}`);
    }
    body = merged;
  }
  const inherit = (field: string, fallback: unknown): unknown => (field in compact ? compact[field] : prev !== undefined ? prev[field] : fallback);
  const knownOnDefault = reason === "create" || reason === "new-information" || prev === undefined ? { state: "unknown" } : prev["knownOn"];
  const entryChannel = inherit("entryChannel", "manual");
  return {
    id,
    recordType: type,
    revision,
    status: "status" in compact ? compact["status"] : reason === "void" ? "voided" : "active",
    reason,
    knownOn: "knownOn" in compact ? compact["knownOn"] : knownOnDefault,
    changeNote: "changeNote" in compact ? compact["changeNote"] : { state: "unknown" },
    duplicateOf: "duplicateOf" in compact ? compact["duplicateOf"] : { state: "not-applicable" },
    entryChannel,
    writeRequestId: "writeRequestId" in compact ? compact["writeRequestId"] : `w-${ctx.scenarioId}-${ctx.opId}`,
    importKey: inherit("importKey", { state: "not-applicable" }),
    body,
  };
}

// 場面の操作の並び。baseScenarioがあれば、同じケースの先に書いた場面の操作（その場面のbaseScenarioも含む）のあとに、
// この場面の操作を続ける。基にした場面の検査（checks）とorderVariantsは引き継がない。
export function resolveOperations(caseData: Obj, scenarioId: string, seen: ReadonlySet<string> = new Set()): Obj[] {
  const list = Array.isArray(caseData["scenarios"]) ? caseData["scenarios"].filter(isObj) : [];
  const index = list.findIndex((s) => s["scenarioId"] === scenarioId);
  const sc = list[index];
  if (sc === undefined) throw new Error(`場面がない: ${scenarioId}`);
  const own = Array.isArray(sc["operations"]) ? sc["operations"].filter(isObj) : [];
  const base = sc["baseScenario"];
  if (base === undefined) return own;
  if (typeof base !== "string" || seen.has(base) || list.findIndex((s) => s["scenarioId"] === base) >= index) {
    throw new Error(`${scenarioId}: baseScenarioは同じケースの先に書いた場面だけ: ${String(base)}`);
  }
  return [...resolveOperations(caseData, base, new Set([...seen, scenarioId])), ...own];
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
