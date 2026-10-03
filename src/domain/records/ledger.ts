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
