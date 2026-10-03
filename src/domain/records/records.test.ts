// 記録ドメイン（T06）のunit test。T03の台帳にない境界（安全な整数の上限、Asia/Tokyoの日付の境目、時計の巻き戻り、
// 入力順、検査をすり抜けたデータ等）を確かめる。値はすべて試験の中で作る架空の値。

import assert from "node:assert/strict";
import { test } from "node:test";
import { expandRecord, type Obj } from "../../../tests/fixtures/ledger/load.ts";
import { aggregateRecords } from "./aggregate.ts";
import { combineComparisons, compareFacts, type Comparable } from "./fact.ts";
import { isIdWithPrefix, isLineId, uuidV7, uuidV7IdGenerator } from "./ids.ts";
import { isHistoryValid } from "./history.ts";
import { emptyLedger, latestRevision, revisionsOf, type Ledger } from "./ledger.ts";
import { canonicalMasterId } from "./masters.ts";
import { restoreUnchecked, saveRevision, type SaveOutcome } from "./save.ts";
import { analyzeSeries } from "./series.ts";
import { checkRevisionStatic } from "./validate.ts";
import { addYen, compareDates, isLocalDate, tokyoDateOf } from "./values.ts";
import { CURRENT, resolveView, selectRevision, seqForTime, type View } from "./views.ts";

let wr = 0;

// 台帳の既定（省略した項目の補い方）で改訂を作り、domainの保存に渡す。
function save(ledger: Ledger, compact: Obj, at: string, baseRevision?: number): SaveOutcome {
  wr += 1;
  const id = compact["id"] as string;
  const previous = latestRevision(ledger, id) as unknown as Obj | undefined;
  const record = expandRecord(compact, { scenarioId: "unit", opId: `u${wr}`, previous });
  const isCreate = record["reason"] === "create";
  const { id: _id, ...rest } = record;
  void _id;
  const input = isCreate ? rest : { ...record, baseRevision: baseRevision ?? (record["revision"] as number) - 1 };
  return saveRevision(ledger, input, { clock: { now: () => at }, ids: { next: () => id } });
}

// 既存の記録を返した要求は、記録・改訂・保存の連番を作らず、その要求の結果だけを足す（PR28-R007）。
function assertOnlyRequestResultAdded(before: Ledger, after: Ledger): void {
  assert.equal(after.saves, before.saves);
  assert.equal(after.revisions, before.revisions);
  assert.equal(after.writeRequests, before.writeRequests);
  assert.equal(after.importKeys, before.importKeys);
  assert.equal(after.requestResults.size, before.requestResults.size + 1);
}

function ok(out: SaveOutcome): Ledger {
  assert.equal(out.kind, "accepted", out.kind === "rejected" ? `${out.reason} ${JSON.stringify(out.violations)}` : out.kind);
  return out.ledger;
}

function rejected(out: SaveOutcome, reason: string): void {
  assert.equal(out.kind, "rejected");
  if (out.kind === "rejected") assert.equal(out.reason, reason, JSON.stringify(out.violations));
}

const T0 = "2026-10-01T00:00:00.000Z";

function setup(): Ledger {
  let l = emptyLedger();
  l = ok(save(l, { id: "emp_1", recordType: "employer", body: { displayName: "勤務先A" } }, T0));
  l = ok(save(l, { id: "emp_2", recordType: "employer", body: { displayName: "勤務先B" } }, T0));
  l = ok(save(l, { id: "acct_1", recordType: "account", body: { displayName: "口座1" } }, T0));
  l = ok(save(l, { id: "iss_1", recordType: "issuer", body: { displayName: "架空市", issuerKind: "municipality" } }, T0));
  return l;
}

function deposit(id: string, amount: unknown, date: unknown = { state: "known", value: "2026-10-10" }): Obj {
  return { id, recordType: "bank-deposit", body: { accountId: "acct_1", depositDate: date, amount } };
}

function payslip(id: string, body: Obj): Obj {
  return {
    id,
    recordType: "payslip",
    body: { employerId: "emp_1", paymentKind: { state: "known", value: "salary" }, scheduledPayDate: { state: "known", value: "2026-10-23" }, ...body },
  };
}

const DEPOSIT_OCT = { key: { kind: "deposit-amount" }, axis: "deposit-date", scope: { employerIds: [], accountIds: ["acct_1"], from: "2026-10-01", to: "2026-10-31" } };

function netPayOct(): Obj {
  return { key: { kind: "payslip-item", item: "netPay" }, axis: "scheduled-pay-date", scope: { employerIds: ["emp_1"], accountIds: [], from: "2026-10-01", to: "2026-10-31" } };
}

test("Factの比較は4×4の表のとおり: 分からない値は一致にも不一致にもしない", () => {
  const states: Comparable<number>[] = [{ state: "known", value: 1 }, { state: "unknown" }, { state: "not-stated" }, { state: "not-applicable" }];
  const table = states.map((a) => states.map((b) => compareFacts(a, b, (x, y) => x === y)));
  assert.deepEqual(table, [
    ["match", "undetermined", "undetermined", "mismatch"],
    ["undetermined", "undetermined", "undetermined", "undetermined"],
    ["undetermined", "undetermined", "undetermined", "undetermined"],
    ["mismatch", "undetermined", "undetermined", "match"],
  ]);
  assert.equal(compareFacts({ state: "known", value: 1 }, { state: "known", value: 2 }, (x, y) => x === y), "mismatch");
  assert.equal(combineComparisons(["match", "undetermined", "mismatch"]), "mismatch");
  assert.equal(combineComparisons(["match", "undetermined"]), "undetermined");
  assert.equal(combineComparisons([]), "match");
});

test("日付: うるう年を確かめ、Asia/Tokyoの日付はUTCの15時で変わる", () => {
  assert.equal(isLocalDate("2028-02-29"), true);
  assert.equal(isLocalDate("2000-02-29"), true);
  assert.equal(isLocalDate("2026-02-29"), false);
  assert.equal(isLocalDate("2100-02-29"), false);
  assert.equal(isLocalDate("2026-04-31"), false);
  assert.equal(tokyoDateOf("2026-10-04T14:59:59.999Z"), "2026-10-04");
  assert.equal(tokyoDateOf("2026-10-04T15:00:00.000Z"), "2026-10-05");
});

test("記録のIDの本体はUUIDv7（版7・変種10、時刻は先頭48ビット）で、内容から作らない", () => {
  const body = uuidV7(0x0123456789ab, new Uint8Array([0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88, 0x77, 0x66]));
  assert.equal(body, "01234567-89ab-7fee-9dcc-bbaa99887766");
  const gen = uuidV7IdGenerator({ nowMs: () => 1_790_000_000_000, randomBytes: (n) => new Uint8Array(n).fill(7) });
  const id = gen.next("pay");
  assert.ok(isIdWithPrefix(id, "pay"), id);
  assert.match(id, /^pay_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(() => uuidV7(-1, new Uint8Array(10)));
  assert.throws(() => uuidV7(0, new Uint8Array(9)));
});

test("円は安全な整数だけ: 上限ちょうどは保存でき、超える値・小数・範囲の外の符号は拒否する", () => {
  let l = setup();
  l = ok(save(l, deposit("dep_1", { state: "known", value: Number.MAX_SAFE_INTEGER }), T0));
  rejected(save(l, deposit("dep_2", { state: "known", value: Number.MAX_SAFE_INTEGER + 1 }), T0), "value-invalid");
  rejected(save(l, deposit("dep_3", { state: "known", value: 1.5 }), T0), "value-invalid");
  rejected(save(l, deposit("dep_4", { state: "known", value: 0 }), T0), "value-invalid");
  // 差引支給額は符号あり、総支給額は0以上（記録の型の4）。
  ok(save(l, payslip("pay_1", { netPay: { state: "known", value: -1 } }), T0));
  rejected(save(l, payslip("pay_2", { grossPay: { state: "known", value: -1 } }), T0), "value-invalid");
  assert.equal(addYen(Number.MAX_SAFE_INTEGER, 1), undefined);
  assert.equal(addYen(-Number.MAX_SAFE_INTEGER, 0), -Number.MAX_SAFE_INTEGER);
});

test("集計: 合計が安全な整数を超えればoverflowの誤りにし、丸めない。負の合計は超えない限りそのまま", () => {
  let l = setup();
  const half = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  l = ok(save(l, deposit("dep_1", { state: "known", value: half }), T0));
  l = ok(save(l, deposit("dep_2", { state: "known", value: half + 1 }), T0));
  const exact = aggregateRecords(l, DEPOSIT_OCT);
  assert.equal(exact.ok, true);
  if (exact.ok) assert.equal(exact.values[0].knownSum, Number.MAX_SAFE_INTEGER);
  l = ok(save(l, deposit("dep_3", { state: "known", value: 1 }), T0));
  const over = aggregateRecords(l, DEPOSIT_OCT);
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.error, "overflow");
  let m = setup();
  m = ok(save(m, payslip("pay_1", { netPay: { state: "known", value: -Number.MAX_SAFE_INTEGER } }), T0));
  const neg = aggregateRecords(m, netPayOct());
  assert.ok(neg.ok && neg.values[0].knownSum === -Number.MAX_SAFE_INTEGER && neg.values[0].state === "complete");
  m = ok(save(m, payslip("pay_2", { netPay: { state: "known", value: -1 } }), T0));
  const negOver = aggregateRecords(m, netPayOct());
  assert.ok(!negOver.ok && negOver.error === "overflow");
});

test("集計: 不明・記載なしを0で補わず、0・対象外・記録なしを区別する", () => {
  let l = setup();
  const empty = aggregateRecords(l, DEPOSIT_OCT);
  assert.ok(empty.ok && empty.values[0].state === "no-records" && empty.values[0].knownSum === 0);
  l = ok(save(l, deposit("dep_1", { state: "unknown" }), T0));
  const unknown = aggregateRecords(l, DEPOSIT_OCT);
  assert.ok(unknown.ok);
  if (unknown.ok) {
    assert.equal(unknown.values[0].state, "incomplete");
    assert.deepEqual(unknown.values[0].missing, [{ ref: { id: "dep_1", revision: 1, line: "whole" }, field: { kind: "record-item", name: "amount" }, state: "unknown" }]);
  }
  let p = setup();
  p = ok(save(p, payslip("pay_1", { residentTax: { state: "known", value: 0 } }), T0));
  const zero = aggregateRecords(p, { ...netPayOct(), key: { kind: "payslip-item", item: "residentTax" } });
  assert.ok(zero.ok && zero.values[0].state === "complete" && zero.values[0].knownSum === 0);
  p = ok(save(p, payslip("pay_2", { residentTax: { state: "not-applicable" } }), T0));
  const mixed = aggregateRecords(p, { ...netPayOct(), key: { kind: "payslip-item", item: "residentTax" } });
  assert.ok(mixed.ok && mixed.values[0].state === "complete");
  let q = setup();
  q = ok(save(q, payslip("pay_1", { residentTax: { state: "not-applicable" } }), T0));
  const na = aggregateRecords(q, { ...netPayOct(), key: { kind: "payslip-item", item: "residentTax" } });
  assert.ok(na.ok && na.values[0].state === "not-applicable");
});

test("集計の要求: kindと合わない軸、許さない次元、from > to、登録していないIDを拒否する", () => {
  const l = setup();
  const bad = [
    { ...DEPOSIT_OCT, axis: "scheduled-pay-date" },
    { ...DEPOSIT_OCT, scope: { ...DEPOSIT_OCT.scope, employerIds: ["emp_1"] } },
    { ...DEPOSIT_OCT, scope: { ...DEPOSIT_OCT.scope, from: "2026-11-01" } },
    { ...DEPOSIT_OCT, scope: { ...DEPOSIT_OCT.scope, accountIds: ["acct_9"] } },
    { ...netPayOct(), key: { kind: "payslip-item", item: "otherEarnings" } },
    { ...netPayOct(), key: { kind: "payslip-by-income-year", item: "grossPay" }, axis: "income-year" },
  ];
  for (const r of bad) {
    const out = aggregateRecords(l, r);
    assert.ok(!out.ok && out.error === "rejected-request", JSON.stringify(r));
  }
});

test("集計は入力順・保存順に依存しない（不足の並びも同じ順で返す）", () => {
  const records = [
    deposit("dep_c", { state: "known", value: 300 }),
    deposit("dep_a", { state: "unknown" }),
    deposit("dep_b", { state: "known", value: 200 }, { state: "unknown" }),
    deposit("dep_d", { state: "not-stated" }, { state: "known", value: "2026-10-02" }),
  ];
  const results = [records, [...records].reverse(), [records[2], records[0], records[3], records[1]]].map((order) => {
    let l = setup();
    for (const r of order) if (r !== undefined) l = ok(save(l, r, T0));
    return aggregateRecords(l, DEPOSIT_OCT);
  });
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  const [first] = results;
  assert.ok(first?.ok);
  if (first?.ok) {
    assert.equal(first.values[0].knownSum, 300);
    assert.deepEqual(
      first.values[0].missing.map((m) => m.ref.id),
      ["dep_d", "dep_a", "dep_b"],
    );
  }
});

test("訂正は前の版を消さず、取消は追跡でき、取消の取り消しで戻る。拒否した保存は状態も連番も変えない", () => {
  let l = setup();
  l = ok(save(l, deposit("dep_1", { state: "known", value: 1000 }), "2026-10-02T00:00:00.000Z"));
  const seqBefore = l.saves.length;
  const stale = save(l, { id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", body: { amount: { state: "known", value: 1100 } } }, T0, 0);
  rejected(stale, "value-invalid");
  l = ok(save(l, { id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", body: { amount: { state: "known", value: 1100 } } }, "2026-10-03T00:00:00.000Z"));
  const conflict = save(l, { id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", body: { amount: { state: "known", value: 1200 } } }, T0, 1);
  rejected(conflict, "stale-base-revision");
  if (conflict.kind === "rejected") assert.equal(conflict.ledger, l);
  assert.equal(l.saves.length, seqBefore + 1);
  assert.deepEqual(
    revisionsOf(l, "dep_1").map((r) => [r.revision, knownAmount(r.body)]),
    [
      [1, 1000],
      [2, 1100],
    ],
  );
  assert.equal(selectRevision(l, "dep_1", { kind: "record-seq", seq: seqBefore })?.revision, 1);
  l = ok(save(l, { id: "dep_1", recordType: "bank-deposit", revision: 3, reason: "void" }, "2026-10-04T00:00:00.000Z"));
  const afterVoid = aggregateRecords(l, DEPOSIT_OCT);
  assert.ok(afterVoid.ok && afterVoid.values[0].state === "no-records");
  rejected(save(l, { id: "dep_1", recordType: "bank-deposit", revision: 4, reason: "correct-input-error", body: { amount: { state: "known", value: 1 } } }, T0), "transition-not-allowed");
  l = ok(save(l, { id: "dep_1", recordType: "bank-deposit", revision: 4, reason: "unvoid" }, "2026-10-05T00:00:00.000Z"));
  const back = aggregateRecords(l, DEPOSIT_OCT);
  assert.ok(back.ok && back.values[0].knownSum === 1100);
  assert.deepEqual(
    revisionsOf(l, "dep_1").map((r) => r.status),
    ["active", "active", "voided", "active"],
  );
});

function knownAmount(body: Obj): unknown {
  const a = body["amount"] as { value?: unknown };
  return a.value;
}

test("改訂の対象がない・使われたIDの新規・取消の把握日の変更を拒否する", () => {
  let l = setup();
  rejected(save(l, { id: "dep_9", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", body: { accountId: "acct_1" } }, T0), "record-not-found");
  rejected(save(l, { id: "emp_1", recordType: "employer", body: { displayName: "勤務先A" } }, T0), "id-already-used");
  l = ok(save(l, { ...deposit("dep_1", { state: "known", value: 1 }), knownOn: { state: "known", value: "2026-09-30" } }, T0));
  rejected(save(l, { id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "void", knownOn: { state: "known", value: "2026-09-29" } }, T0), "known-on-not-inherited");
});

test("参照先が存在しない参照（記録・マスタ）を拒否する", () => {
  const l = setup();
  rejected(save(l, payslip("pay_1", { supersedes: { state: "known", value: { id: "pay_9", revision: "current", line: "whole" } } }), T0), "ref-target-missing");
  rejected(save(l, { id: "dep_1", recordType: "bank-deposit", body: { accountId: "acct_9", amount: { state: "known", value: 1 } } }, T0), "ref-target-missing");
  rejected(save(l, { ...payslip("pay_2", {}), body: { ...(payslip("pay_2", {})["body"] as Obj), employerId: "emp_9" } }, T0), "ref-target-missing");
});

test("期間はstart = endを許し、start > endを拒否する", () => {
  const l = setup();
  const p = (start: string, end: string): Obj => payslip("pay_1", { workPeriod: { state: "known", value: { start: { state: "known", value: start }, end: { state: "known", value: end } } } });
  ok(save(l, p("2026-10-01", "2026-10-01"), T0));
  rejected(save(l, p("2026-10-02", "2026-10-01"), T0), "invalid-period");
});

test("時計が巻き戻っても保存の順は連番で決まり、時点から連番への対応は連番の順を崩さない", () => {
  let l = setup();
  const base = l.saves.length;
  l = ok(save(l, deposit("dep_1", { state: "known", value: 1 }), "2026-10-10T00:00:00.000Z"));
  l = ok(save(l, deposit("dep_2", { state: "known", value: 2 }), "2026-10-20T00:00:00.000Z"));
  l = ok(save(l, deposit("dep_3", { state: "known", value: 3 }), "2026-10-05T00:00:00.000Z"));
  assert.deepEqual(
    ["dep_1", "dep_2", "dep_3"].map((id) => latestRevision(l, id)?.recordedSeq),
    [base + 1, base + 2, base + 3],
  );
  // 2026-10-15の時点: dep_1までは含み、dep_2（10-20）が現れた番号より後のdep_3（時計が巻き戻った10-05）は含めない。
  assert.equal(seqForTime(l, "2026-10-15T00:00:00.000Z"), base + 1);
  assert.equal(seqForTime(l, "2026-10-20T00:00:00.000Z"), base + 3);
  assert.equal(selectRevision(l, "dep_3", resolveView(l, { kind: "record-time", time: "2026-10-15T00:00:00.000Z" })), undefined);
});

test("取消の取り消しで雇用条件の期間が重なる場合は拒否し、端が分からない期間は限りなく開いた期間として扱う", () => {
  let l = setup();
  const term = (id: string, start: unknown, end: unknown): Obj => ({ id, recordType: "employment-term", body: { employerId: "emp_1", applicablePeriod: { start, end } } });
  l = ok(save(l, term("term_1", { state: "known", value: "2026-01-01" }, { state: "known", value: "2026-03-31" }), T0));
  l = ok(save(l, { id: "term_1", recordType: "employment-term", revision: 2, reason: "void" }, T0));
  l = ok(save(l, term("term_2", { state: "known", value: "2026-03-01" }, { state: "not-applicable" }), T0));
  rejected(save(l, { id: "term_1", recordType: "employment-term", revision: 3, reason: "unvoid" }, T0), "employment-term-overlap");
  // startが分からない期間は過去へ限りなく開くので、endが2026-03-01以後なら継続中のterm_2と重なる。
  rejected(save(l, term("term_3", { state: "unknown" }, { state: "known", value: "2026-03-01" }), T0), "employment-term-overlap");
  ok(save(l, term("term_5", { state: "unknown" }, { state: "known", value: "2026-02-28" }), T0));
  ok(save(l, { ...term("term_4", { state: "unknown" }, { state: "known", value: "2025-01-01" }), body: { employerId: "emp_2", applicablePeriod: { start: { state: "unknown" }, end: { state: "known", value: "2025-01-01" } } } }, T0));
});

test("発行者の種類: 通知のissuerKindは正規の発行者と同じでなければならず、参照されている発行者の種類を変える改訂も拒否する", () => {
  let l = setup();
  const notice = (id: string, kind: string): Obj => ({
    id,
    recordType: "official-notice",
    body: { noticeType: "resident-tax-determination", noticeLabel: "通知（架空）", issuerKind: kind, issuerId: { state: "known", value: "iss_1" } },
  });
  rejected(save(l, notice("ntc_1", "tax-office"), T0), "issuer-kind-mismatch");
  l = ok(save(l, notice("ntc_1", "municipality"), T0));
  rejected(save(l, { id: "iss_1", recordType: "issuer", revision: 2, reason: "correct-input-error", body: { issuerKind: "tax-office" } }, T0), "issuer-kind-mismatch");
});

test("マスタ: 参照されている雇用先の二重登録でない取消を拒否し、二重登録の取消は正規のIDに解決する", () => {
  let l = setup();
  l = ok(save(l, payslip("pay_1", { employerId: "emp_2" }), T0));
  rejected(save(l, { id: "emp_2", recordType: "employer", revision: 2, reason: "void" }, T0), "master-void-referenced");
  l = ok(save(l, { id: "emp_2", recordType: "employer", revision: 2, reason: "void", duplicateOf: { state: "known", value: { id: "emp_1", revision: "current", line: "whole" } } }, T0));
  assert.equal(canonicalMasterId(l, "emp_2", CURRENT), "emp_1");
  // 正規のIDで比べるので、emp_1で絞った集計に、emp_2を指す明細が入る。
  const out = aggregateRecords(l, { ...netPayOct(), key: { kind: "payslip-item", item: "grossPay" } });
  assert.ok(out.ok && out.values[0].state === "incomplete" && out.values[0].missing.some((m) => m.ref.id === "pay_1"));
});

test("差し替えの系列: 取消した中間の記録を通り過ぎ、取消の取り消しで戻る。自己参照・循環・分岐を拒否する", () => {
  let l = setup();
  const p = (id: string, prev?: string): Obj => payslip(id, prev === undefined ? {} : { supersedes: { state: "known", value: { id: prev, revision: "current", line: "whole" } } });
  l = ok(save(l, p("pay_a"), T0));
  l = ok(save(l, p("pay_b", "pay_a"), T0));
  l = ok(save(l, p("pay_c", "pay_b"), T0));
  const status = (ledger: Ledger): string[] => ["pay_a", "pay_b", "pay_c"].map((id) => analyzeSeries(ledger, "payslip", CURRENT).status.get(id) ?? "");
  assert.deepEqual(status(l), ["superseded", "superseded", "current"]);
  l = ok(save(l, { id: "pay_b", recordType: "payslip", revision: 2, reason: "void" }, T0));
  assert.deepEqual(status(l), ["superseded", "voided", "current"]);
  rejected(save(l, p("pay_d", "pay_a"), T0), "supersede-shape");
  rejected(save(l, { id: "pay_a", recordType: "payslip", revision: 2, reason: "correct-input-error", body: { supersedes: { state: "known", value: { id: "pay_b", revision: "current", line: "whole" } } } }, T0), "supersede-shape");
  l = ok(save(l, { id: "pay_c", recordType: "payslip", revision: 2, reason: "void" }, T0));
  assert.deepEqual(status(l), ["current", "voided", "voided"]);
  l = ok(save(l, { id: "pay_b", recordType: "payslip", revision: 3, reason: "unvoid" }, T0));
  assert.deepEqual(status(l), ["superseded", "current", "voided"]);
});

test("検査をすり抜けた記録は、集計でsave-checkのconflictに挙げ、黙って数えない", () => {
  let l = setup();
  l = ok(save(l, deposit("dep_1", { state: "known", value: 100 }), T0));
  const bad = expandRecord(deposit("dep_2", { state: "not-applicable" }), { scenarioId: "unit", opId: "r1", previous: undefined });
  assert.ok(checkRevisionStatic(bad).some((v) => v.reason === "fact-state-not-allowed"));
  l = restoreUnchecked(l, [bad], { clock: { now: () => T0 } });
  const out = aggregateRecords(l, DEPOSIT_OCT);
  assert.ok(out.ok);
  if (out.ok) {
    assert.equal(out.values[0].state, "incomplete");
    assert.equal(out.values[0].knownSum, 100);
    assert.deepEqual(out.values[0].missing, [{ ref: { id: "dep_2", revision: 1, line: "whole" }, field: { kind: "derived", key: "save-check" }, state: "conflict" }]);
  }
});

test("行IDは同じ記録の全改訂で予約し、並びをまたいで同じ行IDを持たない", () => {
  let l = setup();
  const line = (lineId: string): Obj => ({ lineId, label: "手当", category: { state: "known", value: "allowance" }, amount: { state: "known", value: 1000 } });
  const ded = (lineId: string): Obj => ({ lineId, label: "控除", amount: { state: "known", value: 10 } });
  rejected(save(l, payslip("pay_x", { otherEarnings: { state: "known", value: [line("l1")] }, otherDeductions: { state: "known", value: [ded("l1")] } }), T0), "list-invalid");
  l = ok(save(l, payslip("pay_1", { otherEarnings: { state: "known", value: [line("l1"), line("l2")] } }), T0));
  l = ok(save(l, { id: "pay_1", recordType: "payslip", revision: 2, reason: "correct-input-error", body: { otherEarnings: { state: "known", value: [line("l1")] } } }, T0));
  rejected(save(l, { id: "pay_1", recordType: "payslip", revision: 3, reason: "correct-input-error", body: { otherEarnings: { state: "known", value: [line("l1"), line("l2")] } } }, T0), "line-id-reused");
  rejected(save(l, { id: "pay_1", recordType: "payslip", revision: 3, reason: "correct-input-error", body: { otherDeductions: { state: "known", value: [ded("l2")] } } }, T0), "line-id-reused");
  ok(save(l, { id: "pay_1", recordType: "payslip", revision: 3, reason: "correct-input-error", body: { otherEarnings: { state: "known", value: [line("l1"), line("l3")] } } }, T0));
});

test("再取込: importKeyが既存の記録と一致しても、不正な要求は既存の記録を返さずに拒否し、正しい要求だけが既存の記録を返す", () => {
  let l = setup();
  const imported = (id: string, extra: Obj = {}, body: Obj = {}): Obj => ({
    id,
    recordType: "bank-deposit",
    entryChannel: "import",
    importKey: { state: "known", value: { source: "架空の口座CSV", key: "1行目" } },
    body: { accountId: "acct_1", depositDate: { state: "known", value: "2026-10-10" }, amount: { state: "known", value: 1000 }, ...body },
    ...extra,
  });
  l = ok(save(l, imported("dep_1"), T0));
  // entryChannelがmanualなのにimportKeyがknown（共通の型の12）。
  rejected(save(l, imported("dep_2", { entryChannel: "manual" }), T0), "fact-state-not-allowed");
  // 許さない状態（入金額のnot-applicable）。
  rejected(save(l, imported("dep_3", {}, { amount: { state: "not-applicable" } }), T0), "fact-state-not-allowed");
  // bodyの項目の欠落。
  const missing = expandRecord(imported("dep_4"), { scenarioId: "unit", opId: "m1", previous: undefined });
  const { id: _m, body, ...rest } = missing;
  void _m;
  const { accountId: _a, ...bodyWithoutAccount } = body as Obj;
  void _a;
  const out = saveRevision(l, { ...rest, body: bodyWithoutAccount }, { clock: { now: () => T0 }, ids: { next: () => "dep_4" } });
  rejected(out, "value-invalid");
  // 参照先がない口座。
  rejected(save(l, imported("dep_5", {}, { accountId: "acct_9" }), T0), "ref-target-missing");
  // 正しい要求は、内容が違っても既存の記録を返し、状態を変えない（共通の型の10）。
  const again = save(l, imported("dep_6", {}, { amount: { state: "known", value: 1001 } }), T0);
  assert.equal(again.kind, "existing-returned");
  if (again.kind === "existing-returned") {
    assert.equal(again.recordId, "dep_1");
    assertOnlyRequestResultAdded(l, again.ledger);
  }
});

test("入力誤りの訂正で把握日を変えるときはchangeNoteが要り、引き継ぐときは要らない", () => {
  let l = setup();
  l = ok(save(l, { ...deposit("dep_1", { state: "known", value: 1 }), knownOn: { state: "known", value: "2026-09-20" } }, T0));
  const fix = (extra: Obj): Obj => ({ id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", body: { amount: { state: "known", value: 2 } }, ...extra });
  rejected(save(l, fix({ knownOn: { state: "known", value: "2026-09-21" } }), T0), "known-on-not-inherited");
  rejected(save(l, fix({ knownOn: { state: "known", value: "2026-09-21" }, changeNote: { state: "not-applicable" } }), T0), "known-on-not-inherited");
  ok(save(l, fix({}), T0));
  ok(save(l, fix({ knownOn: { state: "known", value: "2026-09-21" }, changeNote: { state: "known", value: "把握日の写し誤り" } }), T0));
  // 直した把握日も、保存のときの日付より後にはできない。
  rejected(save(l, fix({ knownOn: { state: "known", value: "2026-10-02" }, changeNote: { state: "known", value: "把握日の写し誤り" } }), T0), "known-on-in-future");
});

test("復元でも、importKeyが別の記録と重なる改訂は置かない", () => {
  let l = setup();
  const rec = (id: string): Obj =>
    expandRecord(
      { id, recordType: "bank-deposit", entryChannel: "import", importKey: { state: "known", value: { source: "架空の口座CSV", key: "1行目" } }, body: { accountId: "acct_1", amount: { state: "known", value: 1 } } },
      { scenarioId: "unit", opId: `r-${id}`, previous: undefined },
    );
  l = restoreUnchecked(l, [rec("dep_1")], { clock: { now: () => T0 } });
  const before = l;
  assert.throws(() => restoreUnchecked(before, [rec("dep_2")], { clock: { now: () => T0 } }), /importKey/);
});

// 復元（検査をすり抜けたデータ）の改訂を、台帳の既定で補って作る。版2以上は直前の改訂のbodyに書いた項目だけを差し替える。
function restore(ledger: Ledger, compacts: Obj[], at = T0): Ledger {
  let l = ledger;
  for (const c of compacts) {
    wr += 1;
    const previous = latestRevision(l, c["id"] as string) as unknown as Obj | undefined;
    const r = expandRecord(c, { scenarioId: "unit", opId: `restore${wr}`, previous });
    l = restoreUnchecked(l, [r], { clock: { now: () => at } });
  }
  return l;
}

function depositOct(l: Ledger, view: View = CURRENT): { state: string; knownSum: number; missing: string[] } {
  const out = aggregateRecords(l, DEPOSIT_OCT, view);
  assert.ok(out.ok, out.ok ? "" : out.message);
  if (!out.ok) return { state: "", knownSum: 0, missing: [] };
  const [v] = out.values;
  return { state: v.state, knownSum: v.knownSum, missing: v.missing.map((m) => `${m.ref.id}@${m.ref.revision}:${m.field.kind === "derived" ? m.field.key : m.field.name}:${m.state}`) };
}

test("PR28-R004: 把握日を変える訂正のchangeNoteは、knownでも空・空白だけなら拒否する", () => {
  let l = setup();
  l = ok(save(l, { ...deposit("dep_1", { state: "known", value: 1 }), knownOn: { state: "known", value: "2026-09-20" } }, T0));
  const fix = (note: Obj): Obj => ({ id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", knownOn: { state: "known", value: "2026-09-21" }, changeNote: note });
  rejected(save(l, fix({ state: "known", value: "" }), T0), "known-on-not-inherited");
  rejected(save(l, fix({ state: "known", value: " 　\t" }), T0), "known-on-not-inherited");
  ok(save(l, fix({ state: "known", value: "把握日の写し誤り" }), T0));
  // 把握日を引き継ぐ訂正には、メモは要らない（空のメモでもよい）。
  ok(save(l, { id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", changeNote: { state: "known", value: "" }, body: { amount: { state: "known", value: 2 } } }, T0));
});

test("PR28-R002: 再送は要求の全内容で比べる。正しい再送は最初の結果を返し、余分なキー・新規のbaseRevision・内容の変更は拒否する", () => {
  let l = setup();
  const create = expandRecord(deposit("dep_1", { state: "known", value: 100 }), { scenarioId: "unit", opId: "rp1", previous: undefined });
  const { id: _id, ...createInput } = create;
  void _id;
  const d = { clock: { now: () => T0 }, ids: { next: () => "dep_1" } };
  const first = saveRevision(l, createInput, d);
  l = ok(first);
  const seq = l.saves.length;
  const replay = saveRevision(l, createInput, d);
  assert.equal(replay.kind, "replayed");
  if (replay.kind === "replayed" && first.kind === "accepted") assert.equal(replay.revision, first.revision);
  for (const bad of [
    { ...createInput, extra: 1 },
    { ...createInput, baseRevision: 0 },
    { ...createInput, body: { ...(createInput["body"] as Obj), amount: { state: "known", value: 101 } } },
  ]) {
    const out = saveRevision(l, bad, d);
    rejected(out, "write-request-conflict");
    assert.equal(out.ledger, l);
    assert.equal(out.ledger.saves.length, seq);
  }
  // 改訂の再送は、元のbaseRevisionと同じときだけ最初の結果を返す。
  const revise = { ...expandRecord({ id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", body: { amount: { state: "known", value: 150 } } }, { scenarioId: "unit", opId: "rp2", previous: latestRevision(l, "dep_1") as unknown as Obj }), baseRevision: 1 };
  l = ok(saveRevision(l, revise, d));
  assert.equal(saveRevision(l, revise, d).kind, "replayed");
  rejected(saveRevision(l, { ...revise, baseRevision: 2 }, d), "write-request-conflict");
  const { baseRevision: _b, ...withoutBase } = revise;
  void _b;
  rejected(saveRevision(l, withoutBase, d), "write-request-conflict");
});

test("PR28-R003: 保存の前からある違反でも、保存する記録自身が関わる違反は免除せず、関係のない保存は止めない", () => {
  let l = setup();
  const term = (id: string, start: string, end: string): Obj => ({
    id,
    recordType: "employment-term",
    body: { employerId: "emp_1", applicablePeriod: { start: { state: "known", value: start }, end: { state: "known", value: end } } },
  });
  // 検査をすり抜けて、同じ雇用先で期間が重なる有効な雇用条件A・Bがある。
  l = restore(l, [term("term_a", "2026-01-01", "2026-06-30"), term("term_b", "2026-06-01", "2026-12-31")]);
  const seq = l.saves.length;
  const fixA = (end: string): Obj => ({ id: "term_a", recordType: "employment-term", revision: 2, reason: "correct-input-error", body: { applicablePeriod: { start: { state: "known", value: "2026-01-01" }, end: { state: "known", value: end } } } });
  const keep = save(l, fixA("2026-06-15"), T0);
  rejected(keep, "employment-term-overlap");
  assert.equal(keep.ledger, l);
  assert.equal(keep.ledger.saves.length, seq);
  ok(save(l, fixA("2026-05-31"), T0));
  // 関係のない記録の保存と、雇用先の表示名だけの訂正は止めない。
  ok(save(l, deposit("dep_1", { state: "known", value: 1 }), T0));
  ok(save(l, { id: "emp_1", recordType: "employer", revision: 2, reason: "correct-input-error", body: { displayName: "勤務先A（訂正）" } }, T0));
});

test("PR28-R001: 復元した履歴は、選んだ版までの版間の条件も確かめ、満たさなければsave-checkのconflictにする", () => {
  // 正常な履歴（新規→訂正）は数える。
  let ok1 = setup();
  ok1 = restore(ok1, [deposit("dep_1", { state: "known", value: 100 }), { id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", body: { amount: { state: "known", value: 200 } } }]);
  assert.deepEqual(depositOct(ok1), { state: "complete", knownSum: 200, missing: [] });
  // 取消の取り消しでbodyを変えた履歴（新規100→取消→取消の取り消し999）。
  let l = setup();
  const base = l.saves.length;
  l = restore(l, [
    deposit("dep_1", { state: "known", value: 100 }),
    { id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "void" },
    { id: "dep_1", recordType: "bank-deposit", revision: 3, reason: "unvoid", body: { amount: { state: "known", value: 999 } } },
  ]);
  assert.deepEqual(depositOct(l), { state: "incomplete", knownSum: 0, missing: ["dep_1@3:save-check:conflict"] });
  // 過去の見方は、その時点より後の改訂（違反を含む取消の取り消し）を使わない。
  assert.deepEqual(depositOct(l, { kind: "record-seq", seq: base + 1 }), { state: "complete", knownSum: 100, missing: [] });
  // entryChannel・importKeyを変えた改訂、直前のstatusに合わない理由（activeの記録の取消の取り消し）。
  for (const second of [
    { id: "dep_2", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", entryChannel: "import", importKey: { state: "known", value: { source: "架空の口座CSV", key: "9行目" } } },
    { id: "dep_2", recordType: "bank-deposit", revision: 2, reason: "unvoid" },
  ]) {
    let m = setup();
    m = restore(m, [deposit("dep_2", { state: "known", value: 50 }), second]);
    assert.deepEqual(depositOct(m), { state: "incomplete", knownSum: 0, missing: ["dep_2@2:save-check:conflict"] });
  }
  // 行IDの再利用（l2を消したあとで再び使う）。
  const line = (lineId: string): Obj => ({ lineId, label: "手当", category: { state: "known", value: "allowance" }, amount: { state: "known", value: 1000 } });
  let p = setup();
  p = restore(p, [
    payslip("pay_1", { grossPay: { state: "known", value: 230000 }, otherEarnings: { state: "known", value: [line("l1"), line("l2")] } }),
    { id: "pay_1", recordType: "payslip", revision: 2, reason: "correct-input-error", body: { otherEarnings: { state: "known", value: [line("l1")] } } },
    { id: "pay_1", recordType: "payslip", revision: 3, reason: "correct-input-error", body: { otherEarnings: { state: "known", value: [line("l1"), line("l2")] } } },
  ]);
  const gross = aggregateRecords(p, { ...netPayOct(), key: { kind: "payslip-item", item: "grossPay" } });
  assert.ok(gross.ok && gross.values[0].state === "incomplete" && gross.values[0].knownSum === 0, JSON.stringify(gross));
  assert.equal(analyzeSeries(p, "payslip", CURRENT).status.get("pay_1"), "unconfirmed-series");
  assert.equal(analyzeSeries(p, "payslip", { kind: "record-seq", seq: (latestRevision(p, "pay_1")?.recordedSeq ?? 0) - 1 }).status.get("pay_1"), "current");
});

test("PR28-R001: bodyがobjectでない復元した記録でも、集計と系列は例外を投げずにsave-checkのconflictにする", () => {
  let l = setup();
  const dep = { ...expandRecord(deposit("dep_1", { state: "known", value: 1 }), { scenarioId: "unit", opId: "n1", previous: undefined }), body: null };
  const pay = { ...expandRecord(payslip("pay_1", {}), { scenarioId: "unit", opId: "n2", previous: undefined }), body: null };
  l = restoreUnchecked(l, [dep, pay], { clock: { now: () => T0 } });
  assert.deepEqual(depositOct(l), { state: "incomplete", knownSum: 0, missing: ["dep_1@1:save-check:conflict"] });
  const gross = aggregateRecords(l, { ...netPayOct(), key: { kind: "payslip-item", item: "grossPay" } });
  assert.ok(gross.ok && gross.values[0].missing.some((m) => m.ref.id === "pay_1" && m.state === "conflict"), JSON.stringify(gross));
  assert.equal(analyzeSeries(l, "payslip", CURRENT).status.get("pay_1"), "unconfirmed-series");
  // 正しい記録の保存は止めない。
  ok(save(l, deposit("dep_2", { state: "known", value: 2 }), T0));
});

test("PR28-R001: 履歴が検査を満たさない記録でも、選んだ版までのすべての版が範囲の外を示すなら除く", () => {
  let l = setup();
  l = restore(l, [
    deposit("dep_1", { state: "known", value: 100 }, { state: "known", value: "2026-11-10" }),
    { id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "void" },
    { id: "dep_1", recordType: "bank-deposit", revision: 3, reason: "unvoid", body: { amount: { state: "known", value: 999 } } },
  ]);
  assert.deepEqual(depositOct(l), { state: "no-records", knownSum: 0, missing: [] });
  let m = setup();
  m = restore(m, [
    deposit("dep_1", { state: "known", value: 100 }, { state: "known", value: "2026-11-10" }),
    { id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "void" },
    { id: "dep_1", recordType: "bank-deposit", revision: 3, reason: "unvoid", body: { depositDate: { state: "known", value: "2026-10-10" } } },
  ]);
  assert.deepEqual(depositOct(m), { state: "incomplete", knownSum: 0, missing: ["dep_1@3:save-check:conflict"] });
});

test("PR28-R001: 取消した橋の履歴が壊れている（取消でsupersedesを変えた）系列は、古い資料も新しい資料も数えずconflictにする", () => {
  let l = setup();
  const sup = (prev: string): Obj => ({ supersedes: { state: "known", value: { id: prev, revision: "current", line: "whole" } } });
  const grossOct = (ledger: Ledger, view: View = CURRENT) => aggregateRecords(ledger, { ...netPayOct(), key: { kind: "payslip-item", item: "grossPay" } }, view);
  l = ok(save(l, payslip("pay_a", { grossPay: { state: "known", value: 100 } }), T0));
  l = ok(save(l, payslip("pay_b", { grossPay: { state: "known", value: 150 }, ...sup("pay_a") }), T0));
  const beforeBadVoid = l.saves.length;
  // Bの版2: 取消でbodyのsupersedesをnot-applicableに変えた不正な履歴（復元）。
  l = restore(l, [{ id: "pay_b", recordType: "payslip", revision: 2, reason: "void", body: { supersedes: { state: "not-applicable" } } }]);
  l = ok(save(l, payslip("pay_c", { grossPay: { state: "known", value: 200 }, ...sup("pay_b") }), T0));
  const now = grossOct(l);
  assert.ok(now.ok);
  if (now.ok) {
    assert.equal(now.values[0].state, "incomplete");
    assert.equal(now.values[0].knownSum, 0);
    // 不正な取消をしたBも、取消を根拠に除かず不足に挙げる（除く根拠にも履歴の検査を先に当てる規則）。
    assert.deepEqual(now.values[0].missing.map((m) => m.ref.id).sort(), ["pay_a", "pay_b", "pay_c"]);
  }
  const st = analyzeSeries(l, "payslip", CURRENT).status;
  assert.deepEqual(["pay_a", "pay_b", "pay_c"].map((id) => st.get(id)), ["unconfirmed-series", "unconfirmed-series", "unconfirmed-series"]);
  // 不正な取消より前の記録時点の再現は、後の改訂を使わず正常（Bが現在の記録）。
  const past = grossOct(l, { kind: "record-seq", seq: beforeBadVoid });
  assert.ok(past.ok && past.values[0].state === "complete" && past.values[0].knownSum === 150, JSON.stringify(past));
  // 正しい取消の橋は、これまでどおり通り過ぎる（A ← B（取消） ← Cで、Cだけを数える）。
  let g = setup();
  g = ok(save(g, payslip("pay_a", { grossPay: { state: "known", value: 100 } }), T0));
  g = ok(save(g, payslip("pay_b", { grossPay: { state: "known", value: 150 }, ...sup("pay_a") }), T0));
  g = ok(save(g, payslip("pay_c", { grossPay: { state: "known", value: 200 }, ...sup("pay_b") }), T0));
  g = ok(save(g, { id: "pay_b", recordType: "payslip", revision: 2, reason: "void" }, T0));
  const good = grossOct(g);
  assert.ok(good.ok && good.values[0].state === "complete" && good.values[0].knownSum === 200, JSON.stringify(good));
});

test("Copilot r4172813522: 履歴の検査を満たさないマスタは、正規のIDに解決しない（unknown）", () => {
  let l = setup();
  // 不正な取消の取り消し（bodyを変えた）。
  l = restore(l, [
    { id: "emp_9", recordType: "employer", body: { displayName: "勤務先Z" } },
    { id: "emp_9", recordType: "employer", revision: 2, reason: "void" },
    { id: "emp_9", recordType: "employer", revision: 3, reason: "unvoid", body: { displayName: "勤務先Z（変更）" } },
  ]);
  assert.equal(canonicalMasterId(l, "emp_9", CURRENT), undefined);
  // その時点までの履歴が正しい過去の見方では解決する。
  assert.equal(canonicalMasterId(l, "emp_9", { kind: "record-seq", seq: (latestRevision(l, "emp_9")?.recordedSeq ?? 0) - 2 }), "emp_9");
  // 形の崩れた復元したマスタ（bodyがnull）。
  const broken = { ...expandRecord({ id: "emp_8", recordType: "employer", body: { displayName: "勤務先Y" } }, { scenarioId: "unit", opId: "b1", previous: undefined }), body: null };
  l = restoreUnchecked(l, [broken], { clock: { now: () => T0 } });
  assert.equal(canonicalMasterId(l, "emp_8", CURRENT), undefined);
  // 解決できないマスタを指す明細は、範囲から外さず不足（unknown）に挙げ、新しく指す保存は拒否する。
  l = restore(l, [payslip("pay_1", { employerId: "emp_9", grossPay: { state: "known", value: 1 } })]);
  const all = aggregateRecords(l, { key: { kind: "payslip-item", item: "grossPay" }, axis: "scheduled-pay-date", scope: { employerIds: [], accountIds: [], from: "2026-10-01", to: "2026-10-31" } });
  assert.ok(all.ok && all.values[0].missing.some((m) => m.ref.id === "pay_1" && m.field.kind === "record-item" && m.field.name === "employerId" && m.state === "unknown"), JSON.stringify(all));
  rejected(save(l, payslip("pay_2", { employerId: "emp_8" }), T0), "ref-target-invalid");
});

test("Copilot r4172813501: 保存の境界で入力を写して凍結し、保存のあとで入力を変えても履歴・連番・索引は変わらない", () => {
  let l = setup();
  const input = expandRecord(
    { id: "dep_1", recordType: "bank-deposit", entryChannel: "import", importKey: { state: "known", value: { source: "架空の口座CSV", key: "1行目" } }, body: { accountId: "acct_1", depositDate: { state: "known", value: "2026-10-10" }, amount: { state: "known", value: 100 } } },
    { scenarioId: "unit", opId: "s1", previous: undefined },
  ) as Record<string, unknown>;
  delete input["id"];
  const out = saveRevision(l, input, { clock: { now: () => T0 }, ids: { next: () => "dep_1" } });
  l = ok(out);
  const seq = l.saves.length;
  const body = input["body"] as { amount: { value: number } };
  body.amount.value = 999;
  (input["importKey"] as { value: { key: string } }).value.key = "2行目";
  input["writeRequestId"] = "w-changed";
  const stored = latestRevision(l, "dep_1");
  assert.ok(stored !== undefined && Object.isFrozen(stored) && Object.isFrozen(stored.body));
  if (out.kind === "accepted") assert.equal(out.revision, stored);
  assert.deepEqual(depositOct(l), { state: "complete", knownSum: 100, missing: [] });
  assert.equal(l.saves.length, seq);
  assert.ok(l.writeRequests.has(stored?.writeRequestId ?? "") && !l.writeRequests.has("w-changed"));
  assert.equal([...l.importKeys.values()].filter((v) => v === "dep_1").length, 1);
  assert.throws(() => {
    (stored?.body as Record<string, unknown>)["amount"] = 1;
  });
  // 復元の入口も同じ。JSONの値でない入力は拒否する。
  const restored = expandRecord(deposit("dep_2", { state: "known", value: 5 }), { scenarioId: "unit", opId: "s2", previous: undefined }) as Record<string, unknown>;
  l = restoreUnchecked(l, [restored], { clock: { now: () => T0 } });
  (restored["body"] as { amount: { value: number } }).amount.value = 7;
  assert.equal(depositOct(l).knownSum, 105);
  rejected(saveRevision(l, { ...input, writeRequestId: "w-date", body: { ...(input["body"] as Obj), descriptionText: new Date(0) } }, { clock: { now: () => T0 }, ids: { next: () => "dep_3" } }), "value-invalid");
});

test("Copilotの概要: 新規の保存にbaseRevisionがあれば拒否する", () => {
  const l = setup();
  const record = expandRecord(deposit("dep_1", { state: "known", value: 1 }), { scenarioId: "unit", opId: "c1", previous: undefined });
  const { id: _id, ...input } = record;
  void _id;
  rejected(saveRevision(l, { ...input, baseRevision: 0 }, { clock: { now: () => T0 }, ids: { next: () => "dep_1" } }), "value-invalid");
  rejected(saveRevision(l, { ...input, baseRevision: 1 }, { clock: { now: () => T0 }, ids: { next: () => "dep_1" } }), "value-invalid");
  ok(saveRevision(l, input, { clock: { now: () => T0 }, ids: { next: () => "dep_1" } }));
});

test("Copilotの概要: Asia/Tokyoの暦日はタイムゾーンのデータで求め、日本の夏時間（1948〜1951年）も正しい", () => {
  assert.equal(tokyoDateOf("1948-06-01T14:30:00.000Z"), "1948-06-02");
  assert.equal(tokyoDateOf("1952-06-01T14:30:00.000Z"), "1952-06-01");
  assert.equal(tokyoDateOf("0001-01-01T00:00:00.000Z"), "0001-01-01");
  assert.equal(tokyoDateOf("9999-12-31T23:59:59.999Z"), "10000-01-01");
  assert.ok(compareDates("9999-12-31", "10000-01-01") < 0);
  // 夏時間の期間の把握日の未来の判定。UTCで6月1日14:30は東京で6月2日なので、6月2日の把握日は未来ではない。
  let l = setup();
  l = ok(save(l, { ...deposit("dep_1", { state: "known", value: 1 }, { state: "known", value: "1948-06-02" }), knownOn: { state: "known", value: "1948-06-02" } }, "1948-06-01T14:30:00.000Z"));
  rejected(save(l, { ...deposit("dep_2", { state: "known", value: 1 }), knownOn: { state: "known", value: "1948-06-03" } }, "1948-06-01T14:30:00.000Z"), "known-on-in-future");
});

test("PR28-R002: JSON.parseで作った「__proto__」のown keyも保存の写しに残し、検査と再送の比較に使う", () => {
  let l = setup();
  const record = expandRecord(deposit("dep_1", { state: "known", value: 100 }), { scenarioId: "unit", opId: "p1", previous: undefined });
  const { id: _id, ...input } = record;
  void _id;
  const json = JSON.stringify(input);
  const d = { clock: { now: () => T0 }, ids: { next: () => "dep_1" } };
  // 新規の余分なキー（トップレベル、bodyの入れ子）はvalue-invalid。JSのobject literalの__proto__はown keyにならないので、
  // JSON.parseで作る。
  const topLevel = JSON.parse(`${json.slice(0, -1)},"__proto__":{}}`) as Obj;
  assert.ok(Object.keys(topLevel).includes("__proto__"));
  const before = l;
  for (const bad of [
    topLevel,
    JSON.parse(json.replace('"body":{', '"body":{"__proto__":{"amount":{"state":"known","value":1}},')) as Obj,
  ]) {
    const out = saveRevision(l, bad, d);
    rejected(out, "value-invalid");
    assert.equal(out.ledger, before);
  }
  // 必須の項目を__proto__の下に置いても、その項目があることにはならない。
  const hidden = JSON.parse(json.replace(/"amount":\{"state":"known","value":100\},?/, "").replace('"body":{', '"body":{"__proto__":{"amount":{"state":"known","value":100}},')) as Obj;
  rejected(saveRevision(l, hidden, d), "value-invalid");
  // 正しい要求を受け付けたあと、同じwriteRequestIdに__proto__を足した再送は内容が違うので拒否し、状態・連番・索引を変えない。
  const first = saveRevision(l, JSON.parse(json) as Obj, d);
  l = ok(first);
  const seq = l.saves.length;
  const replay = saveRevision(l, JSON.parse(json) as Obj, d);
  assert.equal(replay.kind, "replayed");
  if (replay.kind === "replayed" && first.kind === "accepted") assert.equal(replay.revision, first.revision);
  for (const bad of [JSON.parse(`${json.slice(0, -1)},"__proto__":{}}`) as Obj, JSON.parse(json.replace('"body":{', '"body":{"__proto__":{},')) as Obj]) {
    const out = saveRevision(l, bad, d);
    rejected(out, "write-request-conflict");
    assert.equal(out.ledger, l);
    assert.equal(out.ledger.saves.length, seq);
    assert.equal(out.ledger.writeRequests, l.writeRequests);
    assert.equal(out.ledger.importKeys, l.importKeys);
  }
});

test("PR28-R005: 復元したすべての改訂のimportKeyを履歴全体で予約する", () => {
  const key = (k: string): Obj => ({ state: "known", value: { source: "架空の口座CSV", key: k } });
  const imported = (id: string, k: string, extra: Obj = {}): Obj => ({
    id,
    recordType: "bank-deposit",
    entryChannel: "import",
    importKey: key(k),
    body: { accountId: "acct_1", depositDate: { state: "known", value: "2026-10-10" }, amount: { state: "known", value: 1000 } },
    ...extra,
  });
  let l = setup();
  // 版1のK1と、版2で変えたK2（不正な履歴）を復元する。
  l = restore(l, [imported("dep_a", "K1"), { id: "dep_a", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", importKey: key("K2") }]);
  for (const k of ["K1", "K2"]) {
    const again = save(l, imported("dep_b", k), T0);
    assert.equal(again.kind, "existing-returned", k);
    if (again.kind === "existing-returned") {
      assert.equal(again.recordId, "dep_a");
      assertOnlyRequestResultAdded(l, again.ledger);
    }
    assert.throws(() => restore(l, [imported("dep_c", k)]), /importKey/);
  }
  // 正常な履歴（キーを変えない改訂、取消、取消のあとの再取込、同じIDの復元の改訂）は変わらない。
  let g = setup();
  g = ok(save(g, imported("dep_1", "K9"), T0));
  g = ok(save(g, { id: "dep_1", recordType: "bank-deposit", revision: 2, reason: "correct-input-error", body: { amount: { state: "known", value: 1100 } } }, T0));
  g = ok(save(g, { id: "dep_1", recordType: "bank-deposit", revision: 3, reason: "void" }, T0));
  const re = save(g, imported("dep_2", "K9"), T0);
  assert.ok(re.kind === "existing-returned" && re.recordId === "dep_1" && re.voided);
  g = restore(g, [{ id: "dep_1", recordType: "bank-deposit", revision: 4, reason: "unvoid" }]);
  assert.equal([...g.importKeys.values()].filter((v) => v === "dep_1").length, 1);
});

test("PR28-R006: 不正な期間の端（knownでもLocalDateでない）から重ならないと決めない", () => {
  let l = setup();
  const term = (id: string, start: Obj, end: Obj): Obj => ({ id, recordType: "employment-term", body: { employerId: "emp_1", applicablePeriod: { start, end } } });
  const d = (v: string): Obj => ({ state: "known", value: v });
  // 復元した有効な雇用条件A: startがknownの"zzz"、endは継続中。
  l = restore(l, [term("term_a", d("zzz"), { state: "not-applicable" })]);
  const seq = l.saves.length;
  const b = save(l, term("term_b", d("2026-01-01"), d("2026-12-31")), T0);
  rejected(b, "employment-term-overlap");
  assert.equal(b.ledger, l);
  assert.equal(b.ledger.saves.length, seq);
  // Aの端を訂正すれば、重ならない保存を受け付ける。
  const fixed = ok(save(l, { id: "term_a", recordType: "employment-term", revision: 2, reason: "correct-input-error", body: { applicablePeriod: { start: d("2027-01-01"), end: { state: "not-applicable" } } } }, T0));
  ok(save(fixed, term("term_b", d("2026-01-01"), d("2026-12-31")), T0));
  // unknownの端は限りなく開き、取消した雇用条件は検査を妨げない（これまでどおり）。
  let u = setup();
  u = ok(save(u, term("term_u", { state: "unknown" }, d("2025-12-31")), T0));
  rejected(save(u, term("term_v", d("2025-06-01"), d("2025-06-30")), T0), "employment-term-overlap");
  ok(save(u, term("term_w", d("2026-01-01"), d("2026-12-31")), T0));
  u = ok(save(u, { id: "term_u", recordType: "employment-term", revision: 2, reason: "void" }, T0));
  ok(save(u, term("term_v", d("2025-06-01"), d("2025-06-30")), T0));
});

test("Copilot r4172982694: IDと行IDの末尾の改行は、IDとして受け付けない", () => {
  assert.equal(isIdWithPrefix("dep_1\n", "dep"), false);
  assert.equal(isIdWithPrefix("dep_1\r", "dep"), false);
  assert.equal(isIdWithPrefix("dep_1", "dep"), true);
  assert.equal(isLineId("l1\n"), false);
  assert.equal(isLineId("l1"), true);
  assert.equal(isLocalDate("2026-10-10\n"), false);
});

test("PR28-R001（所有者の判断で確定した規則）: 取消・差し替え・範囲の外で除く前に、選ばれた版までの履歴を検査する", () => {
  // (a) 版1が100、版2が金額を999に変えた不正な取消の入金は、取消を根拠に除かずconflict・incomplete。
  let l = setup();
  const base = l.saves.length;
  l = restore(l, [deposit("dep_a", { state: "known", value: 100 }), { id: "dep_a", recordType: "bank-deposit", revision: 2, reason: "void", body: { amount: { state: "known", value: 999 } } }]);
  assert.deepEqual(depositOct(l), { state: "incomplete", knownSum: 0, missing: ["dep_a@2:save-check:conflict"] });
  // (c) 不正な取消より前の見方は、100でcomplete。
  assert.deepEqual(depositOct(l, { kind: "record-seq", seq: base + 1 }), { state: "complete", knownSum: 100, missing: [] });
  // (b) 正しい取消は、これまでどおりno-records。
  let v = setup();
  v = restore(v, [deposit("dep_a", { state: "known", value: 100 }), { id: "dep_a", recordType: "bank-deposit", revision: 2, reason: "void" }]);
  assert.deepEqual(depositOct(v), { state: "no-records", knownSum: 0, missing: [] });
  // (d) すべての版が範囲の外を示す不正な履歴は除く。範囲の外の正しい取消・正しい記録も除く。
  let o = setup();
  o = restore(o, [
    deposit("dep_a", { state: "known", value: 100 }, { state: "known", value: "2026-11-10" }),
    { id: "dep_a", recordType: "bank-deposit", revision: 2, reason: "void", body: { amount: { state: "known", value: 999 } } },
    deposit("dep_b", { state: "known", value: 5 }, { state: "known", value: "2026-11-11" }),
  ]);
  assert.deepEqual(depositOct(o), { state: "no-records", knownSum: 0, missing: [] });
  // (e) 不正な取消をした明細は、取消したものとせず、集計でconflict、系列の状態はunconfirmed-series。
  let p = setup();
  p = restore(p, [payslip("pay_1", { grossPay: { state: "known", value: 100 } }), { id: "pay_1", recordType: "payslip", revision: 2, reason: "void", body: { grossPay: { state: "known", value: 999 } } }]);
  const gross = aggregateRecords(p, { ...netPayOct(), key: { kind: "payslip-item", item: "grossPay" } });
  assert.ok(gross.ok && gross.values[0].state === "incomplete" && gross.values[0].missing.some((m) => m.ref.id === "pay_1" && m.state === "conflict"), JSON.stringify(gross));
  assert.equal(analyzeSeries(p, "payslip", CURRENT).status.get("pay_1"), "unconfirmed-series");
  // (f) 不正な取消をした雇用条件と重なる新規の保存は拒否し、正しい取消なら受け付ける。
  const term = (id: string): Obj => ({ id, recordType: "employment-term", body: { employerId: "emp_2", applicablePeriod: { start: { state: "known", value: "2026-01-01" }, end: { state: "known", value: "2026-12-31" } } } });
  let t = setup();
  t = restore(t, [term("term_a"), { id: "term_a", recordType: "employment-term", revision: 2, reason: "void", body: { payScheduleNote: { state: "known", value: "変更" } } }]);
  rejected(save(t, term("term_b"), T0), "employment-term-overlap");
  let tv = setup();
  tv = restore(tv, [term("term_a"), { id: "term_a", recordType: "employment-term", revision: 2, reason: "void" }]);
  ok(save(tv, term("term_b"), T0));
  // (g) 履歴の検査を満たさない記録は、二重登録の取消の残す方にできない。
  let g = setup();
  g = restore(g, [deposit("dep_x", { state: "known", value: 1 }), { id: "dep_x", recordType: "bank-deposit", revision: 2, reason: "unvoid" }]);
  g = ok(save(g, deposit("dep_y", { state: "known", value: 1 }), T0));
  rejected(save(g, { id: "dep_y", recordType: "bank-deposit", revision: 2, reason: "void", duplicateOf: { state: "known", value: { id: "dep_x", revision: "current", line: "whole" } } }, T0), "ref-target-invalid");
  // (h) 二重登録の取消でbodyを変えたマスタは、取消の先の正規のIDに解決しない。
  let m = setup();
  m = restore(m, [
    { id: "emp_9", recordType: "employer", body: { displayName: "勤務先Z" } },
    { id: "emp_9", recordType: "employer", revision: 2, reason: "void", duplicateOf: { state: "known", value: { id: "emp_1", revision: "current", line: "whole" } }, body: { displayName: "変更" } },
  ]);
  assert.equal(canonicalMasterId(m, "emp_9", CURRENT), undefined);
});

test("Copilot r4173033817: 循環するobjectは、例外ではなくvalue-invalidで拒否する", () => {
  const l = setup();
  const record = expandRecord(deposit("dep_1", { state: "known", value: 1 }), { scenarioId: "unit", opId: "cy1", previous: undefined });
  const { id: _id, ...input } = record;
  void _id;
  const cyclic: Record<string, unknown> = { ...input, body: { ...(input["body"] as Obj) } };
  (cyclic["body"] as Record<string, unknown>)["descriptionText"] = cyclic;
  const out = saveRevision(l, cyclic, { clock: { now: () => T0 }, ids: { next: () => "dep_1" } });
  rejected(out, "value-invalid");
  assert.equal(out.ledger, l);
  // 同じobjectを2か所から指すだけ（循環でない）は、JSONの値として写す。
  const shared = { state: "unknown" };
  ok(saveRevision(l, { ...input, body: { ...(input["body"] as Obj), descriptionText: shared, purpose: shared } }, { clock: { now: () => T0 }, ids: { next: () => "dep_1" } }));
  assert.throws(() => restoreUnchecked(l, [cyclic], { clock: { now: () => T0 } }), /JSONの値ではない/);
});

test("PR28-R007: 既存の記録を返した要求も、writeRequestIdごとに要求の全内容と最初の結果を持つ", () => {
  const imported = (k: string, w: string): Obj => ({
    id: "dep_x",
    recordType: "bank-deposit",
    entryChannel: "import",
    writeRequestId: w,
    importKey: { state: "known", value: { source: "架空の口座CSV", key: k } },
    body: { accountId: "acct_1", depositDate: { state: "known", value: "2026-10-10" }, amount: { state: "known", value: 1000 } },
  });
  const input = (c: Obj): Obj => {
    const { id: _id, ...rest } = expandRecord(c, { scenarioId: "unit", opId: "r7", previous: undefined });
    void _id;
    return rest;
  };
  const d = (id: string) => ({ clock: { now: () => T0 }, ids: { next: () => id } });
  let l = setup();
  // AをK1・W1で保存し、K1をW2で再取込するとAを返す（最初の結果: 取消なし）。
  l = ok(saveRevision(l, input(imported("K1", "W1")), d("dep_a")));
  const w2 = input(imported("K1", "W2"));
  const first = saveRevision(l, w2, d("dep_b"));
  assert.ok(first.kind === "existing-returned" && first.recordId === "dep_a" && !first.voided);
  if (first.kind !== "existing-returned") return;
  assertOnlyRequestResultAdded(l, first.ledger);
  l = first.ledger;
  // (1) 同じW2でimportKeyを未使用のK2に変えた要求は、内容が違うので拒否し、台帳を変えない。
  const conflict = saveRevision(l, input(imported("K2", "W2")), d("dep_c"));
  rejected(conflict, "write-request-conflict");
  assert.equal(conflict.ledger, l);
  assert.equal(l.revisions.has("dep_c"), false);
  // (2) Aを取り消したあとも、取消を取り消したあとも、同じW2の要求は最初の結果（取消なし）を返し、台帳を変えない。
  l = ok(save(l, { id: "dep_a", recordType: "bank-deposit", revision: 2, reason: "void" }, T0));
  const afterVoid = saveRevision(l, w2, d("dep_d"));
  assert.ok(afterVoid.kind === "existing-returned" && afterVoid.recordId === "dep_a" && !afterVoid.voided);
  assert.equal(afterVoid.ledger, l);
  // (3) 別のwriteRequestIdの再取込は、その時点の状態（取消済み）を返す。
  const w3 = saveRevision(l, input(imported("K1", "W3")), d("dep_e"));
  assert.ok(w3.kind === "existing-returned" && w3.recordId === "dep_a" && w3.voided);
  if (w3.kind === "existing-returned") l = w3.ledger;
  l = ok(save(l, { id: "dep_a", recordType: "bank-deposit", revision: 3, reason: "unvoid" }, T0));
  const afterUnvoid = saveRevision(l, w2, d("dep_f"));
  assert.ok(afterUnvoid.kind === "existing-returned" && !afterUnvoid.voided);
  const w3again = saveRevision(l, input(imported("K1", "W3")), d("dep_g"));
  assert.ok(w3again.kind === "existing-returned" && w3again.voided, "W3の最初の結果（取消済み）を返す");
  // (4) 記録・改訂・連番は、AとAの改訂の分だけ。
  assert.deepEqual([...l.revisions.keys()].filter((id) => id.startsWith("dep_")), ["dep_a"]);
  assert.equal(revisionsOf(l, "dep_a").length, 3);
  // 改訂を作った要求のwriteRequestIdも、既存の記録を返した要求のwriteRequestIdも、復元で重ねない。
  assert.throws(() => restore(l, [{ ...deposit("dep_h", { state: "known", value: 1 }), writeRequestId: "W2" }]), /writeRequestId/);
});

test("PR28-R008: 給与明細の記載された値をnew-informationで変えず、別の情報源で埋めるときは情報源のメモを求める", () => {
  let l = setup();
  l = ok(save(l, payslip("pay_1", { grossPay: { state: "known", value: 100 }, incomeTax: { state: "unknown" }, employmentInsurance: { state: "not-stated" } }), T0));
  const seq = l.saves.length;
  const rev = (reason: string, body: Obj, extra: Obj = {}): Obj => ({ id: "pay_1", recordType: "payslip", revision: 2, reason, body, ...extra });
  const note = { changeNote: { state: "known", value: "勤務先の回答（架空）" } };
  // knownの総支給額をnew-informationで変える保存は拒否し、台帳・連番を変えない。
  const changed = save(l, rev("new-information", { grossPay: { state: "known", value: 200 } }, note), T0);
  rejected(changed, "transition-not-allowed");
  assert.equal(changed.ledger, l);
  assert.equal(changed.ledger.saves.length, seq);
  // 雇用先（Factでない記載）もnew-informationでは変えない。
  rejected(save(l, rev("new-information", { employerId: "emp_2" }, note), T0), "transition-not-allowed");
  // unknown・not-statedの項目を、別の情報源のメモつきのnew-informationで埋めるのは受け付け、メモがなければ拒否する。
  ok(save(l, rev("new-information", { incomeTax: { state: "known", value: 3000 }, employmentInsurance: { state: "not-applicable" } }, note), T0));
  rejected(save(l, rev("new-information", { incomeTax: { state: "known", value: 3000 } }), T0), "transition-not-allowed");
  rejected(save(l, rev("new-information", { incomeTax: { state: "known", value: 3000 } }, { changeNote: { state: "known", value: " " } }), T0), "transition-not-allowed");
  // 同じ明細の入力誤りの訂正（記載された値の写し誤り）は受け付ける。
  ok(save(l, rev("correct-input-error", { grossPay: { state: "known", value: 200 } }), T0));
  // 復元した違反（knownの総支給額をnew-informationで変えた履歴）は、集計でsave-checkのconflictにする。
  let r = setup();
  r = restore(r, [payslip("pay_1", { grossPay: { state: "known", value: 100 } }), rev("new-information", { grossPay: { state: "known", value: 200 } }, note)]);
  const gross = aggregateRecords(r, { ...netPayOct(), key: { kind: "payslip-item", item: "grossPay" } });
  assert.ok(gross.ok && gross.values[0].state === "incomplete" && gross.values[0].missing.some((m) => m.ref.id === "pay_1" && m.field.kind === "derived" && m.field.key === "save-check"), JSON.stringify(gross));
});

test("PR28-R008: 予測の行の取り下げ（openからwithdrawn）はnew-informationだけで行う", () => {
  let l = setup();
  const line = (lineStatus: string): Obj => ({ lineId: "l1", expectedMonth: "2026-11", amount: { state: "known", value: 50000 }, lineStatus });
  l = ok(save(l, { id: "fc_1", recordType: "forecast", body: { subject: "pay", employerId: { state: "known", value: "emp_1" }, measure: "gross-pay", lines: [line("open")] } }, T0));
  const seq = l.saves.length;
  const withdraw = (reason: string): Obj => ({ id: "fc_1", recordType: "forecast", revision: 2, reason, body: { lines: [line("withdrawn")] } });
  const wrong = save(l, withdraw("correct-input-error"), T0);
  rejected(wrong, "transition-not-allowed");
  assert.equal(wrong.ledger, l);
  assert.equal(wrong.ledger.saves.length, seq);
  ok(save(l, withdraw("new-information"), T0));
  // 復元した違反は、系列を持たない種類でも、有効な記録の判定で使わない（履歴の検査を満たさない）。
  let r = setup();
  r = restore(r, [{ id: "fc_1", recordType: "forecast", body: { subject: "pay", employerId: { state: "known", value: "emp_1" }, measure: "gross-pay", lines: [line("open")] } }, withdraw("correct-input-error")]);
  const rev2 = latestRevision(r, "fc_1");
  assert.ok(rev2 !== undefined && !isHistoryValid(r, rev2));
});

test("PR28-R009: 行IDのwholeは予約語として受け付けず、記録全体のRefと通常の行のRefは受け付ける", () => {
  let l = setup();
  const fc = (lineId: string): Obj => ({ id: "fc_1", recordType: "forecast", body: { subject: "pay", employerId: { state: "known", value: "emp_1" }, measure: "gross-pay", lines: [{ lineId, expectedMonth: "2026-11", amount: { state: "known", value: 50000 } }] } });
  const bad = save(l, fc("whole"), T0);
  rejected(bad, "value-invalid");
  assert.equal(bad.ledger, l);
  assert.equal(isLineId("whole"), false);
  assert.equal(isLineId("Whole"), true);
  // 通常の行IDの予測と、その行を指すRef（実績化のto）、記録全体のRef（差し替えのsupersedes）は受け付ける。
  l = ok(save(l, fc("l1"), T0));
  l = ok(save(l, payslip("pay_1", { grossPay: { state: "known", value: 48000 } }), T0));
  ok(save(l, { id: "alc_1", recordType: "allocation", body: { kind: "forecast-realization", allocationStatus: "proposed", from: { id: "pay_1", revision: "current", line: "whole" }, to: { id: "fc_1", revision: "current", line: "l1" }, amount: { state: "known", value: 48000 }, settlesForecastLine: { state: "unknown" }, proposedBy: "user" } }, T0));
  ok(save(l, payslip("pay_2", { grossPay: { state: "known", value: 48000 }, supersedes: { state: "known", value: { id: "pay_1", revision: "current", line: "whole" } } }), T0));
  // 行IDがwholeの復元した明細は、集計でsave-checkのconflictにする。
  let r = setup();
  r = restore(r, [payslip("pay_9", { grossPay: { state: "known", value: 1 }, otherEarnings: { state: "known", value: [{ lineId: "whole", label: "手当", amount: { state: "known", value: 1 } }] } })]);
  const before = r;
  const gross = aggregateRecords(r, { ...netPayOct(), key: { kind: "payslip-item", item: "grossPay" } });
  assert.ok(gross.ok && gross.values[0].missing.some((m) => m.ref.id === "pay_9" && m.field.kind === "derived" && m.field.key === "save-check"), JSON.stringify(gross));
  assert.equal(r, before);
  // その行を残したままの訂正は拒否し、台帳を変えない。
  const keep = save(r, { id: "pay_9", recordType: "payslip", revision: 2, reason: "correct-input-error", body: { grossPay: { state: "known", value: 2 } } }, T0);
  rejected(keep, "value-invalid");
  assert.equal(keep.ledger, r);
});
