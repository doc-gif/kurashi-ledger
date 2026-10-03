// 記録の改訂・証憑ファイルの保存（契約版1.0、common-types.mdの2・7・9・10、records.mdの2・6・8・9・10）。
// 保存は、直前の状態に1件を足した新しい状態を返す純粋な関数。時計とID生成器は引数で受け取る（システムの時計・乱数を使わない）。
// 保存の検査は、保存したあとの状態に対して行い、満たさなければ状態を変えずに拒否する（連番も使わない）。
// 照合配分の確定の条件・識別の次元・配分の符号、照合の判断の保存の検証（T11）と、計算runの保存（T15）は、ここでは行わない。

import { knownValue, stateOf } from "./fact.ts";
import { EVIDENCE_FILE_PREFIX, isIdWithPrefix, isMasterType, RECORD_PREFIX, RUN_PREFIX, recordTypeOfId, type IdGenerator, type RecordType } from "./ids.ts";
import {
  bodyOf,
  idInUse,
  snapshotJson,
  recordIds,
  importKeyIndex,
  latestRevision,
  nextSeq,
  revisionsOf,
  withEvidenceFile,
  withRevision,
  withRunStamp,
  type EvidenceFile,
  type ImportKey,
  type Ledger,
  type Revision,
  type RevisionReason,
} from "./ledger.ts";
import { dependentKey, dependentViolations, isEffective, SeriesCache, type DependentViolation } from "./effective.ts";
import { REJECTION_REASONS, type RejectionReason, type Violation } from "./reasons.ts";
import { canonicalMasterId, masterRefsOf } from "./masters.ts";
import { analyzeSeries, isSeriesType, problemKey } from "./series.ts";
import { checkAgainstPrevious, knownOnInFuture, sameJson } from "./history.ts";
import { checkEvidenceFileStatic, checkRevisionStatic, lineObjects } from "./validate.ts";
import { isInstant } from "./values.ts";
import { CURRENT, type ResolvedView } from "./views.ts";

// 注入する時計。保存ごとに1回だけ読み、その値を記録日時（recordedAt）にする。
export interface Clock {
  now(): string; // Instant（RFC 3339、UTC、ミリ秒まで）
}

export interface SaveDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export type SaveOutcome =
  | { readonly kind: "accepted"; readonly ledger: Ledger; readonly revision: Revision }
  // 同じwriteRequestId・同じ内容の再送。新しい改訂を作らず、最初の結果を返す（共通の型の10）。
  | { readonly kind: "replayed"; readonly ledger: Ledger; readonly revision: Revision }
  // 同じimportKeyの記録がある（取消・差し替え済みを含む）。新しい記録を作らず、その記録を返す。
  | { readonly kind: "existing-returned"; readonly ledger: Ledger; readonly recordId: string; readonly voided: boolean }
  | { readonly kind: "rejected"; readonly ledger: Ledger; readonly reason: RejectionReason; readonly violations: readonly Violation[] };

type Obj = Readonly<Record<string, unknown>>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reject(ledger: Ledger, violations: readonly Violation[]): SaveOutcome {
  const reason = REJECTION_REASONS.find((r) => violations.some((v) => v.reason === r)) ?? (violations[0]?.reason as RejectionReason);
  return { kind: "rejected", ledger, reason, violations };
}

function one(reason: RejectionReason, path: string, message: string): Violation[] {
  return [{ reason, path, message }];
}

// 再送の比較（共通の型の10。PR28-R002）: 要求の全内容（キーの有無を含む）を、最初の要求と比べる。最初の要求は、保存した
// 改訂からrecordedAt・recordedSeqを除き、新規ならidを除いたもの（baseRevisionなし）、改訂なら元のbaseRevision（版−1）を加えたもの。
function sameRequest(input: Obj, existing: Revision): boolean {
  const { recordedAt: _a, recordedSeq: _s, id, ...rest } = existing;
  void _a;
  void _s;
  const first: Obj = existing.reason === "create" ? rest : { ...rest, id, baseRevision: existing.revision - 1 };
  return sameJson(input, first);
}

function nowOf(clock: Clock): string {
  const now = clock.now();
  if (!isInstant(now)) throw new Error(`注入した時計の値がInstantではない: ${String(now)}`);
  return now;
}

// 記録の改訂を1件保存する。inputは保存しようとしている改訂（改訂の共通の形からrecordedAt・recordedSeqを除いたもの）に、
// 改訂ならbaseRevision（基にした版）を加えたもの。新規（reasonがcreate）ではidを書かず、ID生成器が割り当てる。
export function saveRevision(ledger: Ledger, raw: unknown, deps: SaveDeps): SaveOutcome {
  // 保存の境界で入力を深く写して凍結し、以後は写しだけを検査・保存する（返す改訂も台帳と同じ写しを指す）。
  const snap = snapshotJson(raw);
  if (!snap.ok) return reject(ledger, one("value-invalid", snap.path, "JSONの値ではない"));
  const input = snap.value;
  if (!isObj(input)) return reject(ledger, one("value-invalid", "$", "保存の要求がobjectではない"));
  const { baseRevision, ...proposal } = input;
  // 1. 再送（同じwriteRequestId）。最初の結果を返すか、内容が違えば拒否する（共通の型の10）。
  const wr = proposal["writeRequestId"];
  if (typeof wr === "string") {
    const first = ledger.writeRequests.get(wr);
    if (first !== undefined) {
      if (sameRequest(input, first)) return { kind: "replayed", ledger, revision: first };
      return reject(ledger, one("write-request-conflict", "$.writeRequestId", `同じwriteRequestIdで内容の違う要求: ${wr}`));
    }
  }
  // 2. 記録1件で決まる検査。冪等キーで既存の記録を返す前に、要求そのものを確かめる（検査を迂回させない）。
  const recordType = proposal["recordType"];
  const isCreate = proposal["reason"] === "create";
  const staticViolations = checkRevisionStatic(proposal, { stored: false });
  if (isCreate && "id" in proposal) staticViolations.push({ reason: "value-invalid", path: "$.id", message: "新規の保存のIDはID生成器が割り当てる（書かない）" });
  if (isCreate && "baseRevision" in input) staticViolations.push({ reason: "value-invalid", path: "$.baseRevision", message: "新規の保存にbaseRevisionは書かない（改訂だけ）" });
  if (!isCreate && !("id" in proposal)) staticViolations.push({ reason: "value-invalid", path: "$.id", message: "改訂の保存には記録のIDが要る" });
  if (!isCreate && (typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 1)) {
    staticViolations.push({ reason: "value-invalid", path: "$.baseRevision", message: "改訂の保存は基にした版（1以上の整数）を指定する" });
  }
  if (staticViolations.length > 0) return reject(ledger, staticViolations);
  const type = recordType as RecordType;
  const reason = proposal["reason"] as RevisionReason;
  const now = nowOf(deps.clock);
  // 3. 新規と改訂の、記録とその前の版で決まる検査。
  let id: string;
  let previous: Revision | undefined;
  if (isCreate) {
    const local = [...knownOnInFuture(proposal, undefined, now), ...missingReferences(ledger, type, proposal["duplicateOf"], proposal["body"] as Obj)];
    if (local.length > 0) return reject(ledger, local);
    // 再取込（同じimportKey）。正しい要求だけについて、同じ記録の種類でsourceとkeyの組が同じ記録（取消・差し替え済みを含む）が
    // あれば、新しい記録を作らずにその記録を返す（共通の型の10。内容が違っても返す）。既存の記録との重なりで決まる検査
    // （期間の重なり・系列等）は、同じ取引の再取込そのものが当たるので、この判定の前には行わない。
    const ik = knownValue(proposal["importKey"]);
    if (isObj(ik) && typeof ik["source"] === "string" && typeof ik["key"] === "string") {
      const existing = ledger.importKeys.get(importKeyIndex(type, { source: ik["source"], key: ik["key"] }));
      if (existing !== undefined) {
        return { kind: "existing-returned", ledger, recordId: existing, voided: latestRevision(ledger, existing)?.status === "voided" };
      }
    }
    id = deps.ids.next(RECORD_PREFIX[type]);
    if (!isIdWithPrefix(id, RECORD_PREFIX[type])) return reject(ledger, one("value-invalid", "$.id", `ID生成器の値が${type}のIDではない: ${id}`));
    if (idInUse(ledger, id)) return reject(ledger, one("id-already-used", "$.id", `すでに使われたID: ${id}`));
  } else {
    id = proposal["id"] as string;
    previous = latestRevision(ledger, id);
    if (previous === undefined) return reject(ledger, one("record-not-found", "$.id", `改訂する記録がない: ${id}`));
    const scenario = checkAgainstPrevious(revisionsOf(ledger, id), proposal, baseRevision as number);
    if (scenario.length > 0) return reject(ledger, scenario);
    const future = knownOnInFuture(proposal, previous, now);
    if (future.length > 0) return reject(ledger, future);
  }
  const revision: Revision = Object.freeze({
    id,
    recordType: type,
    revision: proposal["revision"] as number,
    status: proposal["status"] as Revision["status"],
    reason,
    recordedAt: now,
    recordedSeq: nextSeq(ledger),
    knownOn: proposal["knownOn"] as Revision["knownOn"],
    changeNote: proposal["changeNote"] as Revision["changeNote"],
    duplicateOf: proposal["duplicateOf"] as Revision["duplicateOf"],
    entryChannel: proposal["entryChannel"] as Revision["entryChannel"],
    writeRequestId: proposal["writeRequestId"] as string,
    importKey: proposal["importKey"] as Revision["importKey"],
    body: proposal["body"] as Revision["body"],
  });
  const after = withRevision(ledger, revision);
  // 5. ほかの記録との関係で決まる検査（保存したあとの状態で）。
  const relational = checkRelations(ledger, after, revision, previous);
  if (relational.length > 0) return reject(ledger, relational);
  return { kind: "accepted", ledger: after, revision };
}

// 記録の中の参照（Ref）のうち、記録どうしの関係のもの。
function recordRefsOf(recordType: RecordType, duplicateOf: unknown, b: Obj): { path: string; id: string; line: string }[] {
  const out: { path: string; id: string; line: string }[] = [];
  const push = (path: string, v: unknown): void => {
    if (isObj(v) && typeof v["id"] === "string" && typeof v["line"] === "string") out.push({ path, id: v["id"], line: v["line"] });
  };
  push("$.duplicateOf", knownValue(duplicateOf));
  push("$.body.supersedes", knownValue(b["supersedes"]));
  if (recordType === "allocation") {
    push("$.body.from", b["from"]);
    push("$.body.to", b["to"]);
  }
  if (recordType === "decision" && Array.isArray(b["targets"])) b["targets"].forEach((t, i) => push(`$.body.targets[${i}]`, t));
  if (recordType === "evidence-link") push("$.body.target", b["target"]);
  return out;
}

// 行を指す参照で、その行が参照先の現在の版にあるか。給与明細は支給の行（otherEarnings）、予測は見込みの行（lines）だけを
// 指せる（reconciliation.mdの3の種類ごとの表）。
function lineExists(ledger: Ledger, id: string, line: string): boolean {
  const target = latestRevision(ledger, id);
  if (target === undefined) return false;
  const list = target.recordType === "payslip" ? "otherEarnings" : target.recordType === "forecast" ? "lines" : undefined;
  if (list === undefined) return false;
  return lineObjects(bodyOf(target)[list]).some((l) => l["lineId"] === line);
}

// 参照先の実在（共通の型の2。参照先が存在しない参照は保存できない）と、行が参照先の現在の版にあること。
function missingReferences(ledger: Ledger, recordType: RecordType, duplicateOf: unknown, body: Obj): Violation[] {
  const out: Violation[] = [];
  for (const ref of recordRefsOf(recordType, duplicateOf, body)) {
    if (revisionsOf(ledger, ref.id).length === 0) out.push({ reason: "ref-target-missing", path: ref.path, message: `参照先がない: ${ref.id}` });
    else if (ref.line !== "whole" && !lineExists(ledger, ref.id, ref.line)) {
      out.push({ reason: "ref-target-invalid", path: ref.path, message: `行${ref.line}が参照先${ref.id}の現在の版にない` });
    }
  }
  for (const ref of masterRefsOf(recordType, body)) {
    if (revisionsOf(ledger, ref.id).length === 0) out.push({ reason: "ref-target-missing", path: `$.body.${ref.path}`, message: `参照するマスタがない: ${ref.id}` });
  }
  const evf = body["evidenceFileId"];
  if (recordType === "evidence-link" && typeof evf === "string" && !ledger.evidenceFiles.has(evf)) {
    out.push({ reason: "ref-target-missing", path: "$.body.evidenceFileId", message: `証憑ファイルがない: ${evf}` });
  }
  return out;
}

function checkRelations(before: Ledger, after: Ledger, revision: Revision, previous: Revision | undefined): Violation[] {
  const view: ResolvedView = CURRENT;
  const out = missingReferences(after, revision.recordType, revision.duplicateOf, revision.body);
  if (out.length > 0) return out;
  const series = new SeriesCache(after, view);
  // duplicateOfの先は、自分以外の、保存のときに有効な記録だけ（共通の型の9）。
  const dup = knownValue(revision.duplicateOf);
  if (isObj(dup) && typeof dup["id"] === "string" && !isEffective(after, dup["id"], view, series)) {
    out.push({ reason: "ref-target-invalid", path: "$.duplicateOf", message: `残す方が有効な記録ではない（取消・差し替え済み、整っていない系列）: ${dup["id"]}` });
  }
  // 差し替えの系列（記録の型の10の3）: 保存したあとに、自己参照・循環・分岐・識別の次元の不一致が新しく生じれば拒否する。
  if (isSeriesType(revision.recordType)) {
    const beforeKeys = new Set(analyzeSeries(before, revision.recordType, view).problems.map(problemKey));
    for (const p of analyzeSeries(after, revision.recordType, view).problems) {
      if (beforeKeys.has(problemKey(p))) continue;
      if (p.kind === "self-reference" || p.kind === "cycle" || p.kind === "branch") {
        out.push({ reason: "supersede-shape", path: "$.body.supersedes", message: `差し替えの系列の${p.kind}: ${p.ids.join(", ")}` });
      } else if (p.kind === "dimension-mismatch") {
        out.push({ reason: "supersede-dimension-mismatch", path: "$.body.supersedes", message: `差し替えの識別の次元が一致しない: ${p.ids.join(" → ")}` });
      }
    }
  }
  // 正規のIDに依存する条件と、マスタへの参照の解決（保存したあとに新しく生じた違反だけ）。
  // 保存の前からある違反でも、保存する記録自身と、その保存が影響する記録（正規のIDが変わる参照、または保存するマスタへの
  // 直接の参照を持つ記録）が関わる違反は免除しない。関係のない記録の違反だけは、この保存を止めない（PR28-R003）。
  const beforeDeps = new Set(dependentViolations(before, view).map(dependentKey));
  const affected = affectedRecords(before, after, revision);
  const fresh = dependentViolations(after, view).filter((v) => !beforeDeps.has(dependentKey(v)) || v.ids.some((id) => affected.has(id)));
  for (const v of fresh) out.push(dependentToViolation(v, revision, previous));
  return out;
}

// 保存が影響する記録: 保存する記録自身と、マスタの保存なら、参照の正規のIDが保存の前後で変わる記録と、マスタの有効・取消か
// 発行者の種類が変わる場合にそのマスタを直接参照する記録。マスタの表示名等だけの訂正は、参照する記録に影響しない。
function affectedRecords(before: Ledger, after: Ledger, revision: Revision): Set<string> {
  const out = new Set<string>([revision.id]);
  if (!isMasterType(revision.recordType)) return out;
  const prev = latestRevision(before, revision.id);
  const directChange = prev === undefined || prev.status !== revision.status || bodyOf(prev)["issuerKind"] !== bodyOf(revision)["issuerKind"];
  for (const id of recordIds(after)) {
    const latest = latestRevision(after, id);
    if (latest === undefined) continue;
    for (const ref of masterRefsOf(latest.recordType, bodyOf(latest))) {
      if ((directChange && ref.id === revision.id) || canonicalMasterId(before, ref.id, CURRENT) !== canonicalMasterId(after, ref.id, CURRENT)) out.add(id);
    }
  }
  return out;
}

function dependentToViolation(v: DependentViolation, revision: Revision, previous: Revision | undefined): Violation {
  const message = `${v.kind}: ${v.ids.join(", ")} ${v.detail}`;
  if (isMasterType(revision.recordType)) {
    if (v.kind === "master-ref") return { reason: "master-void-referenced", path: "$.status", message: `参照されているマスタを取り消す（${message}）` };
    const canonicalChanged = stateOf(revision.duplicateOf) === "known" || (previous !== undefined && stateOf(previous.duplicateOf) === "known");
    if (canonicalChanged) return { reason: "canonical-change-breaks-check", path: "$.duplicateOf", message: `正規のIDが変わる保存で満たさなくなる記録（${message}）` };
    if (v.kind === "issuer-kind") return { reason: "issuer-kind-mismatch", path: "$.body.issuerKind", message };
    return { reason: "canonical-change-breaks-check", path: "$", message };
  }
  switch (v.kind) {
    case "master-ref":
      return { reason: "ref-target-invalid", path: "$.body", message: `有効なマスタに解決できない参照（${message}）` };
    case "employment-term-overlap":
      return { reason: "employment-term-overlap", path: "$.body.applicablePeriod", message };
    case "included-payers":
      return { reason: "list-invalid", path: "$.body.includedOtherPayers", message };
    case "issuer-kind":
      return { reason: "issuer-kind-mismatch", path: "$.body.issuerKind", message };
  }
}

// 証憑ファイルを保存する（記録の型の9）。同じ内容（同じsha256）のファイルは1件だけ持ち、2回目は既存のものを返す。
// inputは証憑ファイルの項目からid・recordedAt・recordedSeqを除いたもの（IDはID生成器が割り当てる）。
export function saveEvidenceFile(
  ledger: Ledger,
  raw: unknown,
  deps: SaveDeps,
): { readonly kind: "accepted"; readonly ledger: Ledger; readonly file: EvidenceFile } | { readonly kind: "existing-returned"; readonly ledger: Ledger; readonly fileId: string } | { readonly kind: "rejected"; readonly ledger: Ledger; readonly reason: RejectionReason; readonly violations: readonly Violation[] } {
  const snap = snapshotJson(raw);
  if (!snap.ok) return { kind: "rejected", ledger, reason: "value-invalid", violations: one("value-invalid", snap.path, "JSONの値ではない") };
  const input = snap.value;
  const violations = checkEvidenceFileStatic(input);
  if (isObj(input) && "id" in input) violations.push({ reason: "value-invalid", path: "$.id", message: "証憑ファイルのIDはID生成器が割り当てる（書かない）" });
  if (violations.length > 0 || !isObj(input)) {
    const r = reject(ledger, violations.length > 0 ? violations : one("value-invalid", "$", "objectではない"));
    return r as { kind: "rejected"; ledger: Ledger; reason: RejectionReason; violations: readonly Violation[] };
  }
  const sha = input["sha256"] as string;
  const existing = ledger.sha256s.get(sha);
  if (existing !== undefined) return { kind: "existing-returned", ledger, fileId: existing };
  const id = deps.ids.next(EVIDENCE_FILE_PREFIX);
  if (!isIdWithPrefix(id, EVIDENCE_FILE_PREFIX)) return { kind: "rejected", ledger, reason: "value-invalid", violations: one("value-invalid", "$.id", `ID生成器の値が証憑ファイルのIDではない: ${id}`) };
  if (idInUse(ledger, id)) return { kind: "rejected", ledger, reason: "id-already-used", violations: one("id-already-used", "$.id", `すでに使われたID: ${id}`) };
  const now = nowOf(deps.clock);
  const file: EvidenceFile = Object.freeze({
    id,
    sha256: sha,
    byteSize: input["byteSize"] as number,
    mediaType: input["mediaType"] as string,
    originalFileName: input["originalFileName"] as string,
    storageName: input["storageName"] as string,
    importedAt: input["importedAt"] as string,
    recordedAt: now,
    recordedSeq: nextSeq(ledger),
  });
  return { kind: "accepted", ledger: withEvidenceFile(ledger, file), file };
}

// 計算runの保存の時点だけを足す（runの形・目的・閉包・履歴の検査と保存はT15）。保存の連番はすべての保存で1つなので、
// runの保存もここで連番と記録日時を割り当てる。
export function saveRunStamp(ledger: Ledger, runId: string, deps: Pick<SaveDeps, "clock">): Ledger {
  if (!isIdWithPrefix(runId, RUN_PREFIX)) throw new Error(`計算runのIDではない: ${runId}`);
  if (idInUse(ledger, runId)) throw new Error(`すでに使われたID: ${runId}`);
  return withRunStamp(ledger, runId, nowOf(deps.clock));
}

// 保存の検査を通らずに入る改訂（古いデータの復元・取込・移行等。共通の型の9の「保存の検査をすり抜けたデータ」）を置く。
// 改訂の共通の形の骨格（ID・種類・版・status・理由・writeRequestId）だけを確かめ、ほかは検査しない。
// 集計等の導く判定は、このような改訂を、そのつど保存の検査と同じ条件で確かめる（aggregate.ts）。
export function restoreUnchecked(ledger: Ledger, records: readonly unknown[], deps: Pick<SaveDeps, "clock">): Ledger {
  let cur = ledger;
  for (const rawRecord of records) {
    const snap = snapshotJson(rawRecord);
    if (!snap.ok) throw new Error(`復元する改訂がJSONの値ではない: ${snap.path}`);
    const r = snap.value;
    if (!isObj(r)) throw new Error("復元する改訂がobjectではない");
    const type = recordTypeOfId(r["id"]);
    if (type === undefined || r["recordType"] !== type) throw new Error(`復元する改訂のIDと種類が合わない: ${String(r["id"])}`);
    const prev = latestRevision(cur, r["id"] as string);
    if (r["revision"] !== (prev?.revision ?? 0) + 1) throw new Error(`復元する改訂の版が続かない: ${String(r["id"])}`);
    if (r["status"] !== "active" && r["status"] !== "voided") throw new Error("復元する改訂のstatusが不正");
    if (typeof r["writeRequestId"] !== "string" || cur.writeRequests.has(r["writeRequestId"])) throw new Error("復元する改訂のwriteRequestIdがないか重なる");
    // データベース全体で予約するキー（importKey）が別の記録と重なる改訂は置かない（既存の記録の索引を黙って上書きしない）。
    const ik = knownValue(r["importKey"]);
    if (isObj(ik) && typeof ik["source"] === "string" && typeof ik["key"] === "string") {
      const owner = cur.importKeys.get(importKeyIndex(type, { source: ik["source"], key: ik["key"] }));
      if (owner !== undefined && owner !== r["id"]) throw new Error(`復元する改訂のimportKeyが別の記録${owner}と重なる`);
    }
    const revision: Revision = Object.freeze({
      ...(r as unknown as Revision),
      recordedAt: nowOf(deps.clock),
      recordedSeq: nextSeq(cur),
    });
    cur = withRevision(cur, revision);
  }
  return cur;
}

export type { ImportKey };
