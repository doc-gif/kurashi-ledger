// 記録ドメイン（T06）のunit test。T03の台帳にない境界（安全な整数の上限、Asia/Tokyoの日付の境目、時計の巻き戻り、
// 入力順、検査をすり抜けたデータ等）を確かめる。値はすべて試験の中で作る架空の値。

import assert from "node:assert/strict";
import { test } from "node:test";
import { expandRecord, type Obj } from "../../../tests/fixtures/ledger/load.ts";
import { aggregateRecords } from "./aggregate.ts";
import { combineComparisons, compareFacts, type Comparable } from "./fact.ts";
import { isIdWithPrefix, uuidV7, uuidV7IdGenerator } from "./ids.ts";
import { emptyLedger, latestRevision, revisionsOf, type Ledger } from "./ledger.ts";
import { canonicalMasterId } from "./masters.ts";
import { restoreUnchecked, saveRevision, type SaveOutcome } from "./save.ts";
import { analyzeSeries } from "./series.ts";
import { checkRevisionStatic } from "./validate.ts";
import { addYen, isLocalDate, tokyoDateOf } from "./values.ts";
import { CURRENT, resolveView, selectRevision, seqForTime } from "./views.ts";

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
    assert.equal(again.ledger, l);
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
