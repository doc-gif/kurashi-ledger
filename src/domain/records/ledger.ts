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
  readonly importKeys: ReadonlyMap<string, string>;
  readonly sha256s: ReadonlyMap<string, string>;
  // 計算runのID（予約するキー。中身はT15）。
  readonly runIds: ReadonlySet<string>;
}

export function emptyLedger(): Ledger {
  return {
    saves: [],
    revisions: new Map(),
    evidenceFiles: new Map(),
    writeRequests: new Map(),
    importKeys: new Map(),
    sha256s: new Map(),
    runIds: new Set(),
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
export function withRevision(ledger: Ledger, revision: Revision): Ledger {
  const revisions = new Map(ledger.revisions);
  revisions.set(revision.id, [...(ledger.revisions.get(revision.id) ?? []), revision]);
  const writeRequests = new Map(ledger.writeRequests);
  writeRequests.set(revision.writeRequestId, revision);
  let importKeys = ledger.importKeys;
  if (revision.importKey.state === "known" && revision.revision === 1) {
    const next = new Map(importKeys);
    next.set(importKeyIndex(revision.recordType, revision.importKey.value), revision.id);
    importKeys = next;
  }
  return { ...ledger, saves: [...ledger.saves, { kind: "revision", revision }], revisions, writeRequests, importKeys };
}

export function withEvidenceFile(ledger: Ledger, file: EvidenceFile): Ledger {
  const evidenceFiles = new Map(ledger.evidenceFiles);
  evidenceFiles.set(file.id, file);
  const sha256s = new Map(ledger.sha256s);
  sha256s.set(file.sha256, file.id);
  return { ...ledger, saves: [...ledger.saves, { kind: "evidence-file", file }], evidenceFiles, sha256s };
}

// 計算runの保存の時点だけを足す（runの形と保存の検査はT15）。保存の連番と、時点から連番への対応に使う。
export function withRunStamp(ledger: Ledger, id: string, recordedAt: string): Ledger {
  const runIds = new Set(ledger.runIds);
  runIds.add(id);
  return { ...ledger, saves: [...ledger.saves, { kind: "run", id, recordedAt, recordedSeq: nextSeq(ledger) }], runIds };
}

// 保存の境界で入力を深く写して凍結する（呼び出し元が後から入力を変えても、保存した履歴・連番・索引が変わらないように）。
// 写すのはJSONの値（null・真偽値・数・文字列、配列、プロトタイプがObjectかnullのobject）だけ。それ以外（関数、Date等の
// objectやundefined・bigint・symbol）を含めば、その位置を返して拒否させる。getterは1回だけ読む。
export function snapshotJson(v: unknown, path = "$"): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly path: string } {
  if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return { ok: true, value: v };
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i += 1) {
      const e = snapshotJson(v[i], `${path}[${i}]`);
      if (!e.ok) return e;
      out.push(e.value);
    }
    return { ok: true, value: Object.freeze(out) };
  }
  if (typeof v === "object") {
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return { ok: false, path };
    // prototypeを持たないobjectに、すべてのown keyをown data propertyとして定義する。通常の{}への代入では、JSON.parseが
    // 作ったown key「__proto__」がprototypeの差し替えになり、検査と再送の比較から消えるため（PR28-R002）。
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(v)) {
      const e = snapshotJson((v as Record<string, unknown>)[k], `${path}.${k}`);
      if (!e.ok) return e;
      Object.defineProperty(out, k, { value: e.value, enumerable: true, writable: false, configurable: false });
    }
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
