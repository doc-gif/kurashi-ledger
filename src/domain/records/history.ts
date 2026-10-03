// 改訂の履歴の検査（契約版1.0、common-types.mdの2・7・9）。保存のときの版間の条件と、検査をすり抜けた履歴（復元・取込・
// 移行等）を導く判定のたびに確かめる条件（同9の「保存の検査をすり抜けたデータ」）を、同じ関数で決める。

import { knownValue, stateOf } from "./fact.ts";
import { isUnchecked, revisionsOf, type Ledger, type Revision, type RevisionReason } from "./ledger.ts";
import type { RejectionReason, Violation } from "./reasons.ts";
import { LINE_LISTS } from "./schema.ts";
import { checkRevisionStatic, lineObjects } from "./validate.ts";
import { compareDates, tokyoDateOf } from "./values.ts";

type Obj = Readonly<Record<string, unknown>>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function one(reason: RejectionReason, path: string, message: string): Violation[] {
  return [{ reason, path, message }];
}

// JSONの値の等しさ（objectの項目の順序に依存しない）。
export function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "undefined";
}


// 改訂の理由ごとに、使える直前のstatus（共通の型の9の改訂のモデルの表）。
const PREVIOUS_STATUS: Readonly<Record<Exclude<RevisionReason, "create">, "active" | "voided">> = {
  "correct-input-error": "active",
  "new-information": "active",
  void: "active",
  unvoid: "voided",
};

// 利用者が新しく入力する把握日（新規・新しい情報、把握日の写し誤りを直す入力誤りの訂正）は、保存のときの時計の日付
// （Asia/Tokyo）より後にできない。前の改訂から引き継いだ把握日は検査しない（共通の型の7）。
export function knownOnInFuture(proposal: Obj, previous: Revision | undefined, now: string): Violation[] {
  const reason = proposal["reason"];
  const entered = reason === "create" || reason === "new-information" || (reason === "correct-input-error" && !sameJson(proposal["knownOn"], previous?.knownOn));
  if (!entered) return [];
  const k = knownValue(proposal["knownOn"]);
  const today = tokyoDateOf(now);
  return typeof k === "string" && compareDates(k, today) > 0 ? one("known-on-in-future", "$.knownOn", `把握日${k}が保存のときの日付${today}（Asia/Tokyo）より後`) : [];
}

// 改訂とその前の版で決まる保存の検査（共通の型の9の改訂のモデル、2の行IDの予約、7の把握日）。historyは前の版までの改訂
// （版の昇順、最後が直前の版）。保存のとき（save.ts）と、検査をすり抜けた履歴を確かめるとき（isHistoryValid）の両方で使う。
export function checkAgainstPrevious(history: readonly Revision[], proposal: Obj, baseRevision: number): Violation[] {
  const previous = history[history.length - 1];
  if (previous === undefined) return one("transition-not-allowed", "$.reason", "改訂の前の版がない");
  const reason = proposal["reason"] as RevisionReason;
  if (proposal["recordType"] !== previous.recordType) return one("immutable-field-changed", "$.recordType", "recordTypeは改訂で変えられない");
  // 古い版での上書きを拒否する（共通の型の9）。
  if (baseRevision !== previous.revision) return one("stale-base-revision", "$.baseRevision", `基にした版${baseRevision}が現在の版${previous.revision}と違う`);
  if (proposal["revision"] !== previous.revision + 1) return one("transition-not-allowed", "$.revision", `版は直前の版${previous.revision}に1を足したもの`);
  if (reason === "create") return one("transition-not-allowed", "$.reason", "createは版1だけ");
  if (!Object.hasOwn(PREVIOUS_STATUS, reason)) return one("value-invalid", "$.reason", `改訂の理由ではない: ${String(reason)}`);
  if (previous.status !== PREVIOUS_STATUS[reason]) return one("transition-not-allowed", "$.reason", `${reason}は直前のstatusが${PREVIOUS_STATUS[reason]}のときだけ（直前は${previous.status}）`);
  if (proposal["entryChannel"] !== previous.entryChannel) return one("immutable-field-changed", "$.entryChannel", "entryChannelは改訂で変えられない");
  if (!sameJson(proposal["importKey"], previous.importKey)) return one("immutable-field-changed", "$.importKey", "importKeyは改訂で変えられない");
  if (reason === "void" || reason === "unvoid") {
    // 取消と取消の取り消しは、statusとduplicateOfだけを変える。bodyは直前と同じ（共通の型の9）。
    if (!sameJson(proposal["body"], previous.body)) return one("body-change-on-void-or-unvoid", "$.body", "取消・取消の取り消しではbodyを変えない");
    // 把握日は直前の改訂の把握日を引き継ぐ（共通の型の7の「把握日の決め方」）。
    if (!sameJson(proposal["knownOn"], previous.knownOn)) return one("known-on-not-inherited", "$.knownOn", "取消・取消の取り消しは直前の把握日を引き継ぐ");
  }
  // 入力誤りの訂正は把握日を引き継ぐ。変えてよいのは把握日そのものの写し誤りを直す場合だけで、その場合はchangeNoteに書く
  // （共通の型の7の「把握日の決め方」）。changeNoteがknownで空でない（空白だけでない）ときだけ許す（PR28-R004）。
  const note = knownValue(proposal["changeNote"]);
  if (reason === "correct-input-error" && !sameJson(proposal["knownOn"], previous.knownOn) && (typeof note !== "string" || note.trim() === "")) {
    return one("known-on-not-inherited", "$.changeNote", "入力誤りの訂正で把握日を変えるときは、changeNoteに理由を書く");
  }
  const typed = checkTypeTransition(previous, proposal, reason);
  if (typed.length > 0) return typed;
  return checkLineIdReservation(history, proposal, previous);
}

// 記録の種類ごとの、改訂の理由と前後の値の規則（PR28-R008）。保存のときと、検査をすり抜けた履歴の検査で同じに使う。
// - 給与明細（記録の型の4）: 明細に記載された値（knownやnot-applicableの項目、Factでない項目）を別の値に直すのは
//   correct-input-errorだけ。new-informationで変えてよいのは、unknown・not-statedだった項目をknown・not-applicableにする
//   ことだけで、そのときはchangeNoteに情報源を書く。差し替え（supersedes）は明細に記載された値ではないので対象にしない。
// - 予測（同7）: 行の取り下げ（同じ行IDの行をopenからwithdrawnにする）は、new-informationの改訂だけで行う。
function checkTypeTransition(previous: Revision, proposal: Obj, reason: RevisionReason): Violation[] {
  const before = isObj(previous.body) ? previous.body : {};
  const after = isObj(proposal["body"]) ? proposal["body"] : {};
  if (previous.recordType === "payslip" && reason === "new-information") {
    const out: Violation[] = [];
    const state = { filled: false };
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (k === "supersedes") continue;
      compareStated(before[k], after[k], `$.body.${k}`, out, state);
    }
    if (out.length > 0) return out;
    const note = knownValue(proposal["changeNote"]);
    if (state.filled && (typeof note !== "string" || note.trim() === "")) {
      return one("transition-not-allowed", "$.changeNote", "別の情報源で項目を埋めるnew-informationには、changeNoteに情報源を書く");
    }
    return [];
  }
  if (previous.recordType === "forecast" && reason !== "new-information") {
    const statusOf = (lines: unknown): Map<string, unknown> => {
      const m = new Map<string, unknown>();
      if (Array.isArray(lines)) for (const l of lines) if (isObj(l) && typeof l["lineId"] === "string") m.set(l["lineId"], l["lineStatus"]);
      return m;
    };
    const was = statusOf(before["lines"]);
    for (const [lineId, now] of statusOf(after["lines"])) {
      if (was.get(lineId) === "open" && now === "withdrawn") {
        return one("transition-not-allowed", "$.body.lines", `行${lineId}の取り下げはnew-informationの改訂で行う（${reason}では取り下げない）`);
      }
    }
  }
  return [];
}

// 給与明細のnew-informationで、記載された値を葉まで比べる（P2-2）。
// - Factの葉: 同じ（noteを除いて）なら変更なし。noteだけの変更は記載された値ではないので許し、埋めたことにも数えない。
//   unknown・not-statedからknown・not-applicableにするのは「埋める」として許す。knownどうしで値がobject・並びなら、中を比べる。
//   それ以外（knownの値を変える、knownからunknownにする等）は、記載された値の変更として拒否する。
// - 並び（行）: 同じ行IDの行どうしを比べる。knownの並びに行を足す・消すことは、記載された値の変更として拒否する。
// - Factでない葉（ラベル・列挙・ID等）: 変われば拒否する。
function compareStated(before: unknown, after: unknown, path: string, out: Violation[], state: { filled: boolean }): void {
  if (sameJson(before, after)) return;
  const reject = (why: string): void => {
    out.push({ reason: "transition-not-allowed", path, message: `明細に記載された値をnew-informationで変えない（${why}）。写し誤りはcorrect-input-errorで直す` });
  };
  const sb = stateOf(before);
  const sa = stateOf(after);
  if (sb !== undefined && sa !== undefined) {
    const withoutNote = (f: unknown): unknown => {
      const { note: _n, ...rest } = f as Record<string, unknown>;
      void _n;
      return rest;
    };
    if (sameJson(withoutNote(before), withoutNote(after))) return;
    if ((sb === "unknown" || sb === "not-stated") && (sa === "known" || sa === "not-applicable")) {
      state.filled = true;
      return;
    }
    if (sb === "known" && sa === "known") {
      const vb = knownValue(before);
      const va = knownValue(after);
      if (typeof vb === "object" && vb !== null && typeof va === "object" && va !== null) {
        compareStated(vb, va, `${path}.value`, out, state);
        return;
      }
    }
    reject(`${sb} → ${sa}`);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const byLine = (list: readonly unknown[]): Map<string, unknown> => {
      const m = new Map<string, unknown>();
      for (const l of list) if (isObj(l) && typeof l["lineId"] === "string") m.set(l["lineId"], l);
      return m;
    };
    const mb = byLine(before);
    const ma = byLine(after);
    if (mb.size !== before.length || ma.size !== after.length) {
      reject("行を行IDで対応させられない");
      return;
    }
    for (const id of new Set([...mb.keys(), ...ma.keys()])) {
      if (!mb.has(id) || !ma.has(id)) {
        reject(`行${id}を足す・消す`);
        continue;
      }
      compareStated(mb.get(id), ma.get(id), `${path}[${id}]`, out, state);
    }
    return;
  }
  if (isObj(before) && isObj(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) compareStated(before[k], after[k], `${path}.${k}`, out, state);
    return;
  }
  reject("値");
}

// 行IDの予約（共通の型の2の「LineId」）: 同じ親の記録の全改訂で、同じ行には同じ行IDを使い、改訂で消した行の行IDを
// 後の改訂で再び使わない。並びをまたいで同じ行IDを別の行に使うことも、別の行への再利用として拒否する。
function checkLineIdReservation(history: readonly Revision[], proposal: Obj, previous: Revision): Violation[] {
  const lists = LINE_LISTS[previous.recordType];
  if (lists === undefined) return [];
  const linesOf = (body: unknown): Map<string, string> => {
    const m = new Map<string, string>();
    if (!isObj(body)) return m;
    for (const name of lists) {
      for (const line of lineObjects(body[name])) if (typeof line["lineId"] === "string") m.set(line["lineId"], name);
    }
    return m;
  };
  const used = history.map((r) => linesOf(r.body));
  const proposed = linesOf(proposal["body"]);
  const out: Violation[] = [];
  for (const [lineId, list] of proposed) {
    let seen = false;
    let removedAfterSeen = false;
    for (const h of used) {
      const where = h.get(lineId);
      if (where !== undefined && where !== list) out.push({ reason: "line-id-reused", path: `$.body.${list}`, message: `行ID ${lineId} は${where}の行に使われていた` });
      if (where !== undefined) seen = true;
      else if (seen) removedAfterSeen = true;
    }
    if (removedAfterSeen) out.push({ reason: "line-id-reused", path: `$.body.${list}`, message: `改訂で消した行の行ID ${lineId} を再び使う` });
  }
  return out;
}

// 改訂が信頼できるか（所有者の判断「正しい保存で信頼を回復」で確定した規則。P1-1。R001の規則はこの判定を使う）。
// (a) どの改訂にも、その版だけの検査（静的な検査、直前の版からの遷移、連番の増加、把握日の未来の検査）を当てる。
// (b) 検査を通って保存した改訂（検査済み）は、(a)を満たせば、それより前の版の不正に関わらず信頼する。
// (c) 検査を通らずに置いた改訂（未検査）は、(a)を満たし、かつ直前の版も信頼できるときだけ信頼する（版1は(a)だけ）。
// 不正な版は履歴に要確認として残るが、そのあとに検査を通った保存があれば、その版から先の判定は止まらない。見方で選ばれた
// 改訂より後の改訂は使わないので、回復より前の時点の見方では、これまでどおり信頼できない。
// その版だけの検査の結果は、前の改訂が変わらないので、改訂のobjectごとに覚える。
const localMemo = new WeakMap<Revision, boolean>();

export function isHistoryValid(ledger: Ledger, revision: Revision): boolean {
  const list = revisionsOf(ledger, revision.id);
  const idx = list.indexOf(revision);
  if (idx < 0) return false;
  for (let k = idx; k >= 0; k -= 1) {
    const r = list[k] as Revision;
    let ok = localMemo.get(r);
    if (ok === undefined) {
      ok = revisionValid(list.slice(0, k), r);
      localMemo.set(r, ok);
    }
    if (!ok) return false;
    if (k === 0 || !isUnchecked(ledger, r)) return true;
  }
  return true;
}

function revisionValid(prior: readonly Revision[], r: Revision): boolean {
  if (checkRevisionStatic(r, { stored: true }).length > 0) return false;
  if (r.revision !== prior.length + 1) return false;
  const previous = prior[prior.length - 1];
  if (previous !== undefined) {
    if (r.recordedSeq <= previous.recordedSeq) return false;
    if (checkAgainstPrevious(prior, r as unknown as Obj, previous.revision).length > 0) return false;
  }
  return knownOnInFuture(r as unknown as Obj, previous, r.recordedAt).length === 0;
}
