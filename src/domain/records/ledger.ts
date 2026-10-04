// 保存した状態（記録の改訂、証憑ファイル、計算runの保存の時点）を、ドメインの中で持つ形（契約版1.0、common-types.mdの7・9・10）。
// 値は変えず、保存のたびに新しい状態を返す（拒否した保存は状態を変えない）。DB・transactionはT07が持ち、
// T07は保存した行からこの形を組み立てて、保存の検査と見方に渡す。

import type { Fact } from "./fact.ts";
import type { RecordType } from "./ids.ts";
import type { Ref } from "./schema.ts";

export type RevisionReason = "create" | "correct-input-error" | "new-information" | "void" | "unvoid";
export const REVISION_REASONS: readonly RevisionReason[] = ["create", "correct-input-error", "new-information", "void", "unvoid"];
export type RecordStatus = "active" | "voided";

export interface ImportKey {
  readonly source: string;
  readonly key: string;
}

// 改訂（共通の型の9の「記録と改訂の共通の形」）。bodyは記録の種類ごとの内容（schema.tsのBodyOf）。
export interface Revision {
  readonly id: string;
  readonly recordType: RecordType;
  readonly revision: number;
  readonly status: RecordStatus;
  readonly reason: RevisionReason;
  readonly recordedAt: string;
  readonly recordedSeq: number;
  readonly knownOn: Fact<string>;
  readonly changeNote: Fact<string>;
  readonly duplicateOf: Fact<Ref>;
  readonly entryChannel: "manual" | "import";
  readonly writeRequestId: string;
  readonly importKey: Fact<ImportKey>;
  readonly body: Readonly<Record<string, unknown>>;
}

// 証憑ファイル（記録の型の9）。一度だけ書き、改訂を持たない。
export interface EvidenceFile {
  readonly id: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly originalFileName: string;
  readonly storageName: string;
  readonly importedAt: string;
  readonly recordedAt: string;
  readonly recordedSeq: number;
}

// すべての保存の時点（共通の型の7の「保存の時点」「保存の順序」）。計算runの中身はT15が持ち、ここでは保存の時点だけを持つ。
export type SaveEntry =
  | { readonly kind: "revision"; readonly revision: Revision }
  | { readonly kind: "evidence-file"; readonly file: EvidenceFile }
  | { readonly kind: "run"; readonly id: string; readonly recordedAt: string; readonly recordedSeq: number };

export interface Ledger {
  // recordedSeqの順。saves[i]のrecordedSeqはi+1（1から始まり、抜けがない）。
  readonly saves: readonly SaveEntry[];
  // 記録のIDごとの改訂（版の昇順）。
  readonly revisions: ReadonlyMap<string, readonly Revision[]>;
  readonly evidenceFiles: ReadonlyMap<string, EvidenceFile>;
  // データベース全体で予約するキー（共通の型の9の「履歴全体で予約するキー」）。
  readonly writeRequests: ReadonlyMap<string, Revision>;
  // 既存の記録を返した要求（同じimportKeyの再取込）の、要求の全内容と最初の結果（共通の型の10。PR28-R007）。writeRequestIdは
  // writeRequestsと合わせてデータベース全体で予約する（1つのIDはどちらか一方にだけ入る）。保存ではないので、連番を持たない。
  readonly requestResults: ReadonlyMap<string, RequestResult>;
  readonly importKeys: ReadonlyMap<string, string>;
  readonly sha256s: ReadonlyMap<string, string>;
  // 計算runのID（予約するキー。中身はT15）。
  readonly runIds: ReadonlySet<string>;
  // 検査を通って保存した改訂（検査済み）の、revisionKeyの集合。印がない改訂は、検査を通らずに置いたもの（未検査。復元・取込等）と
  // して扱う（印の欠落を検査済みと読まない。N-P2-2）。T07は、この区別を改訂ごとの印（契約版2.0のsaveCheck）として永続化し、
  // 読み込みで復元する（所有者の判断「正しい保存で信頼を回復」。P1-1）。
  readonly checked: ReadonlySet<string>;
  // 読む処理（READER_CONTRACT_VERSION）より新しい契約版を名乗るデータから入った記録のID（復元・取込の入口で、データの契約版を
  // 渡したとき）。この版では、これらの記録のうち知らない項目を持つものを読むだけにする（所有者の判断「新しい版のデータのときだけ
  // 読むだけ」。R36-2）。
  readonly newerVersionRecords: ReadonlySet<string>;
}

// この処理が読む契約版。
export const READER_CONTRACT_VERSION = "1.0";

// 契約版（メジャー.マイナー）の比較。形が違えば、新しい版とみなす（安全側。読むだけにする）。
export function isNewerContractVersion(version: string): boolean {
  const m = /^(\d+)\.(\d+)$/.exec(version);
  if (m === null) return true;
  const [rmaj, rmin] = READER_CONTRACT_VERSION.split(".").map(Number) as [number, number];
  const maj = Number(m[1]);
  const min = Number(m[2]);
  return maj > rmaj || (maj === rmaj && min > rmin);
}

export function revisionKey(id: string, revision: number): string {
  return `${id}\u0000${revision}`;
}

export function isUnchecked(ledger: Ledger, revision: Revision): boolean {
  return !ledger.checked.has(revisionKey(revision.id, revision.revision));
}

export interface RequestResult {
  readonly kind: "existing-returned";
  readonly request: Readonly<Record<string, unknown>>; // 写して凍結した要求の全内容
  readonly recordId: string;
  // 最初に返したときの取消の有無（後の取消・取消の取り消しで変えない）。その記録の最新の版が信頼できず（検査をすり抜けた履歴）、
  // 取消かどうかを決められなかったときはundefined。
  readonly voided: boolean | undefined;
}

export function emptyLedger(): Ledger {
  return {
    saves: [],
    revisions: new Map(),
    evidenceFiles: new Map(),
    writeRequests: new Map(),
    requestResults: new Map(),
    importKeys: new Map(),
    sha256s: new Map(),
    runIds: new Set(),
    checked: new Set(),
    newerVersionRecords: new Set(),
  };
}

export function nextSeq(ledger: Ledger): number {
  return ledger.saves.length + 1;
}

export function importKeyIndex(recordType: RecordType, key: ImportKey): string {
  return JSON.stringify([recordType, key.source, key.key]);
}

export function revisionsOf(ledger: Ledger, id: string): readonly Revision[] {
  return ledger.revisions.get(id) ?? [];
}

export function latestRevision(ledger: Ledger, id: string): Revision | undefined {
  const list = ledger.revisions.get(id);
  return list === undefined ? undefined : list[list.length - 1];
}

// 記録・証憑ファイル・runのどれかのIDとして使われているか（一度使ったIDは再利用しない。共通の型の2）。
export function idInUse(ledger: Ledger, id: string): boolean {
  return ledger.revisions.has(id) || ledger.evidenceFiles.has(id) || ledger.runIds.has(id);
}

// 記録のIDを、決まった順（IDの文字列の順）で返す。集計と検査が入力順・保存順に依存しないように使う。
export function recordIds(ledger: Ledger, type?: RecordType): string[] {
  const ids: string[] = [];
  for (const [id, list] of ledger.revisions) {
    const first = list[0];
    if (first !== undefined && (type === undefined || first.recordType === type)) ids.push(id);
  }
  return ids.sort(compareStrings);
}

// 文字列の順（UTF-16のコード単位の順）。ロケールに依存させない。
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 改訂を1件足した新しい状態。検査は呼ぶ側（save.ts、restore）が行う。
// checkedは、検査を通って保存した改訂ならtrue、検査を通らずに置いた改訂（復元等）ならfalse。
export function withRevision(ledger: Ledger, revision: Revision, checked: boolean): Ledger {
  const revisions = new Map(ledger.revisions);
  revisions.set(revision.id, Object.freeze([...(ledger.revisions.get(revision.id) ?? []), revision]));
  let checkedSet = ledger.checked;
  if (checked) {
    const next = new Set(checkedSet);
    next.add(revisionKey(revision.id, revision.revision));
    checkedSet = next;
  }
  const writeRequests = new Map(ledger.writeRequests);
  writeRequests.set(revision.writeRequestId, revision);
  // importKeyは履歴全体で予約する（共通の型の9・10）。版1だけでなく、どの改訂に現れたknownのキーも、その記録に予約する
  // （復元した不正な履歴の版2以降のキーも。PR28-R005）。すでに予約されたキーの持ち主は変えない。
  let importKeys = ledger.importKeys;
  const ik: unknown = revision.importKey;
  const value = typeof ik === "object" && ik !== null && (ik as { state?: unknown }).state === "known" ? (ik as { value?: unknown }).value : undefined;
  if (typeof value === "object" && value !== null) {
    const { source, key } = value as { source?: unknown; key?: unknown };
    if (typeof source === "string" && typeof key === "string") {
      const index = importKeyIndex(revision.recordType, { source, key });
      if (!importKeys.has(index)) {
        const next = new Map(importKeys);
        next.set(index, revision.id);
        importKeys = next;
      }
    }
  }
  return { ...ledger, saves: Object.freeze([...ledger.saves, Object.freeze({ kind: "revision" as const, revision })]), revisions, writeRequests, importKeys, checked: checkedSet };
}

// 既存の記録を返した要求の結果を足す（記録・改訂・保存の連番は作らない）。
export function withRequestResult(ledger: Ledger, writeRequestId: string, result: RequestResult): Ledger {
  const requestResults = new Map(ledger.requestResults);
  requestResults.set(writeRequestId, Object.freeze(result));
  return { ...ledger, requestResults };
}

// writeRequestIdが、改訂を作った要求か既存の記録を返した要求のどちらかに使われているか。
export function writeRequestIdInUse(ledger: Ledger, writeRequestId: string): boolean {
  return ledger.writeRequests.has(writeRequestId) || ledger.requestResults.has(writeRequestId);
}

export function withEvidenceFile(ledger: Ledger, file: EvidenceFile): Ledger {
  const evidenceFiles = new Map(ledger.evidenceFiles);
  evidenceFiles.set(file.id, file);
  const sha256s = new Map(ledger.sha256s);
  sha256s.set(file.sha256, file.id);
  return { ...ledger, saves: Object.freeze([...ledger.saves, Object.freeze({ kind: "evidence-file" as const, file })]), evidenceFiles, sha256s };
}

// 計算runの保存の時点だけを足す（runの形と保存の検査はT15）。保存の連番と、時点から連番への対応に使う。
export function withRunStamp(ledger: Ledger, id: string, recordedAt: string): Ledger {
  const runIds = new Set(ledger.runIds);
  runIds.add(id);
  return { ...ledger, saves: Object.freeze([...ledger.saves, Object.freeze({ kind: "run" as const, id, recordedAt, recordedSeq: nextSeq(ledger) })]), runIds };
}

// 保存の境界で入力を深く写して凍結する（呼び出し元が後から入力を変えても、保存した履歴・連番・索引が変わらないように）。
// 写すのはJSONの値（null・真偽値・数・文字列、配列、プロトタイプがObjectかnullのobject）だけ。それ以外（関数、Date等の
// objectやundefined・bigint・symbol）を含めば、その位置を返して拒否させる。getterは1回だけ読む。
// 循環するobject（JSONで表せない）は、その位置を返して拒否させる（例外で処理全体を落とさない）。
export function snapshotJson(v: unknown, path = "$", ancestors: Set<object> = new Set()): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly path: string } {
  if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return { ok: true, value: v };
  if (typeof v === "object" && ancestors.has(v)) return { ok: false, path };
  if (Array.isArray(v)) {
    ancestors.add(v);
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i += 1) {
      const e = snapshotJson(v[i], `${path}[${i}]`, ancestors);
      if (!e.ok) return e;
      out.push(e.value);
    }
    ancestors.delete(v);
    return { ok: true, value: Object.freeze(out) };
  }
  if (typeof v === "object") {
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return { ok: false, path };
    // prototypeを持たないobjectに、すべてのown keyをown data propertyとして定義する。通常の{}への代入では、JSON.parseが
    // 作ったown key「__proto__」がprototypeの差し替えになり、検査と再送の比較から消えるため（PR28-R002）。
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    ancestors.add(v);
    for (const k of Object.keys(v)) {
      const e = snapshotJson((v as Record<string, unknown>)[k], `${path}.${k}`, ancestors);
      if (!e.ok) return e;
      Object.defineProperty(out, k, { value: e.value, enumerable: true, writable: false, configurable: false });
    }
    ancestors.delete(v);
    return { ok: true, value: Object.freeze(out) };
  }
  return { ok: false, path };
}

// 保存した改訂のbody。検査をすり抜けたデータではobjectでないことがあるので、導く判定はこの関数で読み、例外を投げずに
// 空のobject（どの項目もない）として扱う（その記録は履歴の検査でsave-checkになる）。
export function bodyOf(revision: Revision): Readonly<Record<string, unknown>> {
  const b: unknown = revision.body;
  return typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Readonly<Record<string, unknown>>) : {};
}

export function recordedAtOf(entry: SaveEntry): string {
  if (entry.kind === "revision") return entry.revision.recordedAt;
  if (entry.kind === "evidence-file") return entry.file.recordedAt;
  return entry.recordedAt;
}
