// T03の台帳（tests/fixtures/ledger/、docs/test-oracles/README.md）を、記録ドメイン（T06）の独立の期待値として使う試験。
// 共通の設定から場面の操作を順にdomainの保存へ渡し（時計とID生成器は操作の値を返すものを注入する）、受け付け・拒否の理由・
// 保存の連番を比べる。T06の範囲の検査（見方で選ばれる版、時点から連番への対応、正規のID、系列の状態、記録だけで決まる
// 集計）を期待値と比べる。期待値は台帳のものをそのまま使い、実装の出力から作らない。
// T11（照合）・T15（計算run）が判定する拒否の理由と検査の種類は、下の一覧で範囲外として数え、一覧と台帳が過不足なく
// 一致することを確かめる（黙って飛ばさない）。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { expandRecord, REPO_ROOT, readLedgerFiles, resolveOperations, restoredWriteRequestId, type Obj } from "../../../tests/fixtures/ledger/load.ts";
import { aggregateRecords, type AggregateResult } from "./aggregate.ts";
import { recordTypeOfId } from "./ids.ts";
import { REJECTION_REASONS } from "./reasons.ts";
import { emptyLedger, latestRevision, type Ledger, type Revision } from "./ledger.ts";
import { canonicalMasterId } from "./masters.ts";
import { restoreUnchecked, saveEvidenceFile, saveRevision, saveRunStamp, type SaveDeps } from "./save.ts";
import { analyzeSeries, isSeriesType } from "./series.ts";
import { resolveView, selectRevision, seqForTime, type View } from "./views.ts";

// T11が判定する拒否の理由（照合配分の確定の条件・識別の次元・配分の符号、判断の保存の検証）と、T15が判定する理由（計算run）。
const DELEGATED_REASONS: ReadonlySet<string> = new Set([
  "over-allocation",
  "allocation-limit-undeterminable",
  "allocation-sign",
  "confirm-condition-unmet",
  "identity-dimension-mismatch",
  "identity-dimension-undetermined",
  "decision-validation",
  "run-previous-mismatch",
  "run-chain-exists",
  "run-scope-not-allowed",
  "run-scope-noncanonical",
  "run-request-mismatch",
  "run-closure-mismatch",
  "run-snapshot-mismatch",
]);
// T06が判定する検査の種類。ほかの種類（照合・帰属・採用・比較・予測の残り・判断の前提・重複の候補・runの検査・丸め）は
// T11・T15の範囲。集計はdeposit-amount・payslip-itemだけがT06。
const T06_CHECK_KINDS: ReadonlySet<string> = new Set(["selectedRevision", "seqForTime", "canonicalId", "seriesStatus", "aggregate"]);
const DELEGATED_CHECK_KINDS: ReadonlySet<string> = new Set([
  "unreconciled",
  "allocationUsage",
  "forecastLine",
  "attribution",
  "comparison",
  "adoption",
  "duplicateCandidates",
  "decisionPremise",
  "runCanonicalId",
  "runClosure",
  "runInputChange",
  "runScopeChanged",
  "runChain",
  "requiredAdoptions",
  "roundingStep",
  "roundingValidation",
  "includedPayersPrompt",
]);
const T06_AGGREGATE_KINDS: ReadonlySet<string> = new Set(["deposit-amount", "payslip-item"]);
const DELEGATED_AGGREGATE_KINDS: ReadonlySet<string> = new Set(["payslip-by-income-year", "annual-value", "forecast-remaining", "notice-determination"]);

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deps(at: string, id?: string): SaveDeps {
  return {
    clock: { now: () => at },
    ids: {
      next(prefix: string): string {
        if (id === undefined) throw new Error(`ID生成器が呼ばれたが、台帳の操作にIDがない（${prefix}）`);
        return id;
      },
    },
  };
}

const files = readLedgerFiles();

interface OpRecord {
  readonly opId: string;
  readonly outcome: string;
  readonly revision?: Revision;
}

interface Run {
  ledger: Ledger;
  readonly snapshots: Map<string, Ledger>;
  readonly results: Map<string, OpRecord>;
  readonly delegated: string[];
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what}が文字列ではない`);
  return v;
}

// 台帳の1つの操作をdomainに渡し、期待した結果と比べる。
function applyOp(run: Run, op: Obj, scenarioId: string): void {
  const opId = str(op["opId"], "opId");
  const at = str(op["at"], `${scenarioId} ${opId}のat`);
  const expect = isObj(op["expect"]) ? op["expect"] : {};
  const where = `${scenarioId} ${opId}`;
  switch (op["op"]) {
    case "save": {
      const compact = op["record"] as Obj;
      const id = str(compact["id"], `${where}のrecord.id`);
      const previous = latestRevision(run.ledger, id) as unknown as Obj | undefined;
      const record = expandRecord(compact, { scenarioId, opId, previous });
      const isCreate = record["reason"] === "create";
      const { id: _id, ...withoutId } = record;
      void _id;
      const input: Obj = isCreate ? withoutId : { ...record, baseRevision: typeof op["baseRevision"] === "number" ? op["baseRevision"] : (record["revision"] as number) - 1 };
      const out = saveRevision(run.ledger, input, deps(at, isCreate ? id : undefined));
      const expected = expect["outcome"];
      const expectedReason = expect["reason"];
      if (expected === "rejected" && typeof expectedReason === "string" && DELEGATED_REASONS.has(expectedReason)) {
        // T11・T15の検査で拒否される保存。T06の検査は通るはずなので、T06が別の理由で拒否すれば台帳との食い違い。
        assert.equal(out.kind, "accepted", `${where}: T06の検査で拒否された（台帳はT11・T15の理由${expectedReason}）: ${out.kind === "rejected" ? `${out.reason} ${JSON.stringify(out.violations)}` : ""}`);
        run.delegated.push(`reason:${expectedReason}`);
        run.results.set(opId, { opId, outcome: "rejected" });
        break;
      }
      if (expected === "accepted") {
        assert.equal(out.kind, "accepted", `${where}: 受け付けるはずの保存を拒否した: ${out.kind === "rejected" ? `${out.reason} ${JSON.stringify(out.violations)}` : out.kind}`);
        if (out.kind !== "accepted") return;
        if (typeof expect["recordedSeq"] === "string") assert.equal(out.revision.recordedSeq, parseSeq(expect["recordedSeq"]), `${where}: recordedSeq`);
        run.ledger = out.ledger;
        run.results.set(opId, { opId, outcome: "accepted", revision: out.revision });
      } else if (expected === "rejected") {
        assert.equal(out.kind, "rejected", `${where}: 拒否するはずの保存を${out.kind}にした（台帳の理由${String(expectedReason)}）`);
        if (out.kind === "rejected") assert.equal(out.reason, expectedReason, `${where}: 拒否の理由 ${JSON.stringify(out.violations)}`);
        // 拒否した保存は、台帳（記録・改訂・連番・索引）を変えない。
        assert.equal(out.ledger, run.ledger, `${where}: 拒否で台帳が変わった`);
        run.results.set(opId, { opId, outcome: "rejected" });
      } else if (expected === "replayed") {
        assert.equal(out.kind, "replayed", `${where}: 再送として最初の結果を返すはず`);
        const first = run.results.get(str(expect["of"], `${where}のexpect.of`));
        if (out.kind === "replayed" && first?.revision !== undefined) {
          assert.equal(out.revision.id, first.revision.id, `${where}: 再送で返す記録`);
          assert.equal(out.revision.revision, first.revision.revision, `${where}: 再送で返す版`);
        }
        assert.equal(out.ledger, run.ledger, `${where}: 再送で状態を変えない`);
        run.results.set(opId, { opId, outcome: "replayed" });
      } else if (expected === "existing-returned") {
        assert.equal(out.kind, "existing-returned", `${where}: 同じimportKeyの既存の記録を返すはず`);
        if (out.kind === "existing-returned") {
          assert.equal(out.recordId, expect["record"], `${where}: 返す記録`);
          // 記録・改訂・保存の連番は作らず、その要求の結果だけを台帳に記録する（PR28-R007）。
          assert.equal(out.ledger.saves, run.ledger.saves, `${where}: 保存の連番を使わない`);
          run.ledger = out.ledger;
        }
        run.results.set(opId, { opId, outcome: "existing-returned" });
      } else {
        throw new Error(`${where}: 台帳の期待する結果が分からない: ${String(expected)}`);
      }
      break;
    }
    case "saveEvidenceFile": {
      const file = op["file"] as Obj;
      const { id, ...input } = file;
      const out = saveEvidenceFile(run.ledger, input, deps(at, str(id, `${where}のfile.id`)));
      if (expect["outcome"] === "accepted") {
        assert.equal(out.kind, "accepted", `${where}: 証憑ファイルを受け付けるはず: ${out.kind === "rejected" ? JSON.stringify(out.violations) : out.kind}`);
        if (out.kind === "accepted") run.ledger = out.ledger;
      } else {
        assert.equal(expect["outcome"], "existing-returned");
        assert.equal(out.kind, "existing-returned", `${where}: 同じsha256の既存のファイルを返すはず`);
        if (out.kind === "existing-returned") assert.equal(out.fileId, expect["record"]);
      }
      run.results.set(opId, { opId, outcome: String(expect["outcome"]) });
      break;
    }
    case "restoreUnchecked": {
      const records = (op["records"] as Obj[]).map((r) => {
        const rid = str(r["id"], `${where}のrecords[].id`);
        const prev = latestRevision(run.ledger, rid) as unknown as Obj | undefined;
        const revision = typeof r["revision"] === "number" ? r["revision"] : 1;
        return expandRecord(r, { scenarioId, opId, previous: prev, defaultWriteRequestId: restoredWriteRequestId(scenarioId, opId, rid, revision) });
      });
      // 1つの操作で置く改訂は、それぞれ別の保存として連番を持つ。台帳の時刻を同じ値で使う。
      run.ledger = restoreUnchecked(run.ledger, records, deps(at));
      run.results.set(opId, { opId, outcome: "restored" });
      break;
    }
    case "saveRun": {
      // 計算runの保存の検査はT15。台帳が受け付けるrunは、保存の時点（連番と記録日時）だけを足す。
      const runId = str((op["run"] as Obj)["id"], `${where}のrun.id`);
      if (expect["outcome"] === "accepted") run.ledger = saveRunStamp(run.ledger, runId, deps(at));
      run.delegated.push(`op:saveRun:${String(expect["outcome"])}`);
      run.results.set(opId, { opId, outcome: String(expect["outcome"]) });
      break;
    }
    default:
      throw new Error(`${where}: 台帳の操作の種類が分からない: ${String(op["op"])}`);
  }
  run.snapshots.set(opId, run.ledger);
}

function freshRun(base: Ledger): Run {
  return { ledger: base, snapshots: new Map(), results: new Map(), delegated: [] };
}

// 共通の設定だけを保存した状態。保存の連番の期待N+kのNは、共通の設定の保存の数（共通の設定そのものでは0）。
let N = 0;
const commonOps = files.commonSetup["operations"] as Obj[];
const commonRun = freshRun(emptyLedger());
for (const op of commonOps) applyOp(commonRun, op, "common-setup");
const BASE = commonRun.ledger;
N = BASE.saves.length;

function parseSeq(v: string): number {
  const m = /^N\+(\d+)$/.exec(v);
  if (m === null) throw new Error(`連番の書き方が違う: ${v}`);
  return N + Number(m[1]);
}

function viewOf(check: Obj): View {
  const v = check["view"];
  if (!isObj(v) || v["kind"] === "current") return { kind: "current" };
  if (v["kind"] === "record-seq") return { kind: "record-seq", seq: parseSeq(str(v["seq"], "view.seq")) };
  if (v["kind"] === "record-time") return { kind: "record-time", time: str(v["time"], "view.time") };
  if (v["kind"] === "known-on") return { kind: "known-on", date: str(v["date"], "view.date") };
  throw new Error(`見方の種類が分からない: ${JSON.stringify(v)}`);
}

// 並びを集合として比べる（docs/test-oracles/README.mdの「並びは集合として比べる」）。
function sortedJson(list: readonly unknown[]): string[] {
  return list.map((x) => JSON.stringify(x, Object.keys(flatKeys(x)).sort())).sort();
}
function flatKeys(x: unknown, acc: Record<string, true> = {}): Record<string, true> {
  if (Array.isArray(x)) x.forEach((e) => flatKeys(e, acc));
  else if (isObj(x)) for (const [k, v] of Object.entries(x)) {
    acc[k] = true;
    flatKeys(v, acc);
  }
  return acc;
}

function compareAggregate(actual: AggregateResult, expected: Obj, where: string): void {
  if ("error" in expected) {
    assert.equal(actual.ok, false, `${where}: 誤りを期待した`);
    if (!actual.ok) assert.equal(actual.error, expected["error"], `${where}: 誤りの種類（${actual.message}）`);
    return;
  }
  assert.equal(actual.ok, true, `${where}: 集計が誤りになった: ${actual.ok ? "" : `${actual.error} ${actual.message}`}`);
  if (!actual.ok) return;
  const values = expected["values"] as Obj[];
  assert.equal(actual.values.length, values.length, `${where}: 集計値の数`);
  const [a] = actual.values;
  const [e] = values;
  if (e === undefined) return;
  assert.equal(a.state, e["state"], `${where}: 集計の状態（missing: ${JSON.stringify(a.missing)}）`);
  assert.equal(a.knownSum, e["knownSum"], `${where}: knownSum`);
  if ("coverage" in e) assert.deepEqual(a.coverage, e["coverage"], `${where}: coverage`);
  assert.deepEqual(sortedJson(a.missing), sortedJson(e["missing"] as unknown[]), `${where}: missing`);
}

function evaluateCheck(ledger: Ledger, check: Obj, where: string, delegated: string[]): boolean {
  const query = check["query"] as Obj;
  const kind = str(query["kind"], `${where}のquery.kind`);
  const expect = check["expect"] as Obj;
  if (!T06_CHECK_KINDS.has(kind)) {
    if (!DELEGATED_CHECK_KINDS.has(kind)) throw new Error(`${where}: T06でもT11・T15の一覧でもない検査の種類: ${kind}`);
    delegated.push(`check:${kind}`);
    return false;
  }
  const view = viewOf(check);
  const rv = resolveView(ledger, view);
  switch (kind) {
    case "aggregate": {
      const keyKind = str((query["key"] as Obj)["kind"], `${where}のkey.kind`);
      if (!T06_AGGREGATE_KINDS.has(keyKind)) {
        if (!DELEGATED_AGGREGATE_KINDS.has(keyKind)) throw new Error(`${where}: 集計のkindが一覧にない: ${keyKind}`);
        delegated.push(`aggregate:${keyKind}`);
        return false;
      }
      compareAggregate(aggregateRecords(ledger, { key: query["key"], axis: query["axis"], scope: query["scope"] }, view), expect, where);
      return true;
    }
    case "selectedRevision": {
      const rev = selectRevision(ledger, str(query["record"], "record"), rv);
      assert.equal(rev?.revision ?? "none", expect["revision"], `${where}: 見方で選ばれる版`);
      return true;
    }
    case "seqForTime":
      assert.equal(seqForTime(ledger, str(query["time"], "time")), parseSeq(str(expect["seq"], "expect.seq")), `${where}: 時点から連番への対応`);
      return true;
    case "canonicalId":
      assert.equal(canonicalMasterId(ledger, str(query["master"], "master"), rv), expect["canonical"], `${where}: 正規のID`);
      return true;
    case "seriesStatus": {
      const id = str(query["record"], "record");
      const type = recordTypeOfId(id);
      assert.ok(type !== undefined && isSeriesType(type), `${where}: 差し替えを持つ種類の記録ではない: ${id}`);
      if (type === undefined || !isSeriesType(type)) return true;
      assert.equal(analyzeSeries(ledger, type, rv).status.get(id) ?? "not-in-view", expect["status"], `${where}: 系列の状態`);
      return true;
    }
    default:
      throw new Error(`${where}: 未対応の検査の種類: ${kind}`);
  }
}

const seenDelegated = new Set<string>();
let evaluatedChecks = 0;
let evaluatedVariants = 0;

for (const { file, data } of files.cases) {
  const caseId = str(data["caseId"], `${file}のcaseId`);
  describe(`T03の台帳 ${caseId}`, () => {
    for (const sc of data["scenarios"] as Obj[]) {
      const scenarioId = str(sc["scenarioId"], "scenarioId");
      test(`${scenarioId}: 操作を順に保存し、T06の範囲の検査が期待値と一致する`, () => {
        const ops = resolveOperations(data, scenarioId);
        const run = freshRun(BASE);
        for (const op of ops) applyOp(run, op, scenarioId);
        for (const check of (sc["checks"] as Obj[]) ?? []) {
          const afterOp = str(check["afterOp"], "afterOp");
          const ledger = afterOp === "end" ? run.ledger : run.snapshots.get(afterOp);
          assert.ok(ledger !== undefined, `${scenarioId}: afterOpの操作がない: ${afterOp}`);
          if (ledger === undefined) continue;
          if (evaluateCheck(ledger, check, `${scenarioId} ${String(check["checkId"])}`, run.delegated)) evaluatedChecks += 1;
        }
        for (const d of run.delegated) seenDelegated.add(d);
        // 入力順を入れ替えても、最後（end）の検査は同じ結果になる（共通の型の11）。
        const variants = sc["orderVariants"];
        if (Array.isArray(variants)) {
          const byId = new Map(ops.map((o) => [String(o["opId"]), o]));
          for (const [vi, variant] of variants.entries()) {
            const vrun = freshRun(BASE);
            for (const opId of variant as string[]) {
              const op = byId.get(opId);
              assert.ok(op !== undefined, `${scenarioId}: orderVariantsの操作がない: ${opId}`);
              if (op !== undefined) applyOp(vrun, op, scenarioId);
            }
            for (const check of (sc["checks"] as Obj[]) ?? []) {
              if (check["afterOp"] !== "end") continue;
              evaluateCheck(vrun.ledger, check, `${scenarioId} 並び${vi} ${String(check["checkId"])}`, []);
            }
            evaluatedVariants += 1;
          }
        }
      });
    }
  });
}

// 台帳の「拒否の理由」の表（docs/test-oracles/README.md）を読み、契約の列が照合の規則の3・4（T11）か計算結果（T15）の
// 理由と、それ以外（T06）の理由に分ける。
function oracleReasonTable(): { t06: Set<string>; delegated: Set<string> } {
  const text = readFileSync(join(REPO_ROOT, "docs", "test-oracles", "README.md"), "utf8");
  const section = text.slice(text.indexOf("### 拒否の理由"), text.indexOf("### 検査の種類"));
  const t06 = new Set<string>();
  const delegated = new Set<string>();
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5 || !cells[1]?.startsWith("`") || !/静的|場面|意味/.test(cells[2] ?? "")) continue;
    const names = [...(cells[1] ?? "").matchAll(/`([a-z-]+)`/g)].map((m) => m[1] as string);
    const contract = cells[3] ?? "";
    const isDelegated = /照合の規則の[34]/.test(contract) || contract.startsWith("計算結果");
    for (const n of names) (isDelegated ? delegated : t06).add(n);
  }
  return { t06, delegated };
}

test("T03の台帳: 拒否の理由の表のうち、T06の理由はすべて実装の理由の名前にあり、T11・T15の理由は範囲外の一覧と一致する", () => {
  const { t06, delegated } = oracleReasonTable();
  assert.ok(t06.size >= 20 && delegated.size >= 10, `表を読めていない: ${t06.size} ${delegated.size}`);
  for (const r of t06) assert.ok((REJECTION_REASONS as readonly string[]).includes(r), `T06の理由が実装にない: ${r}`);
  assert.deepEqual([...DELEGATED_REASONS].sort(), [...delegated].sort());
});

test("T03の台帳: T06が判定しない理由・検査は、T11・T15の一覧と過不足なく一致し、T06の検査が実際に行われた", () => {
  const expected = new Set<string>();
  for (const { data } of files.cases) {
    for (const sc of data["scenarios"] as Obj[]) {
      for (const op of resolveOperations(data, String(sc["scenarioId"]))) {
        const e = op["expect"] as Obj;
        if (op["op"] === "saveRun") expected.add(`op:saveRun:${String(e["outcome"])}`);
        else if (e["outcome"] === "rejected" && DELEGATED_REASONS.has(String(e["reason"]))) expected.add(`reason:${String(e["reason"])}`);
      }
      for (const c of sc["checks"] as Obj[]) {
        const q = c["query"] as Obj;
        if (q["kind"] === "aggregate") {
          const k = String((q["key"] as Obj)["kind"]);
          if (!T06_AGGREGATE_KINDS.has(k)) expected.add(`aggregate:${k}`);
        } else if (!T06_CHECK_KINDS.has(String(q["kind"]))) expected.add(`check:${String(q["kind"])}`);
      }
    }
  }
  assert.deepEqual([...seenDelegated].sort(), [...expected].sort());
  // 一覧に書いた検査の種類は、どれも台帳に実在する（使われない名前で範囲外を広げない）。理由は上の試験で表と照合する。
  for (const k of DELEGATED_CHECK_KINDS) assert.ok(expected.has(`check:${k}`), `台帳にない検査の種類: ${k}`);
  for (const k of DELEGATED_AGGREGATE_KINDS) assert.ok(expected.has(`aggregate:${k}`), `台帳にない集計の種類: ${k}`);
  assert.ok(evaluatedChecks >= 100, `T06が評価した検査が少ない: ${evaluatedChecks}`);
  assert.ok(evaluatedVariants >= 1, "入力順を入れ替えた並びを1つも評価していない");
});
