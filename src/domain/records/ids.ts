// 記録のIDと行のID（契約版1.0、docs/contracts/common-types.mdの2）。
// IDは`<接頭辞>_<本体>`。接頭辞は記録の種類ごとに固定し、本体は英数字とハイフンの1〜40文字。比較は完全一致。
// IDは内容から作らない。生成はdomainに注入するID生成器で行う（試験では決まった値を返す生成器を渡せる）。
// 本体の生成方式は、T06でUUIDv7（RFC 9562。ハイフン付きの小文字、36文字）に決めた。時刻と乱数は注入した元から取る。

export type RecordType =
  | "employer"
  | "employment-term"
  | "account"
  | "issuer"
  | "payslip"
  | "bank-deposit"
  | "annual-document"
  | "forecast"
  | "official-notice"
  | "evidence-link"
  | "allocation"
  | "decision";

// 共通の型の2の接頭辞の表。
export const RECORD_PREFIX: Readonly<Record<RecordType, string>> = {
  employer: "emp",
  "employment-term": "term",
  account: "acct",
  issuer: "iss",
  payslip: "pay",
  "bank-deposit": "dep",
  "annual-document": "ann",
  forecast: "fc",
  "official-notice": "ntc",
  "evidence-link": "evl",
  allocation: "alc",
  decision: "dcs",
};
export const RECORD_TYPES: readonly RecordType[] = Object.keys(RECORD_PREFIX) as RecordType[];
export const EVIDENCE_FILE_PREFIX = "evf";
export const RUN_PREFIX = "run";

// マスタ（共通の型の9の「マスタの取消と二重登録」）。ほかの記録からRefではなくIdで参照される。
export const MASTER_TYPES: readonly RecordType[] = ["employer", "account", "issuer"];
export type MasterType = "employer" | "account" | "issuer";

export function isRecordType(v: unknown): v is RecordType {
  return typeof v === "string" && (RECORD_TYPES as readonly string[]).includes(v);
}

export function isMasterType(t: RecordType): t is MasterType {
  return (MASTER_TYPES as readonly string[]).includes(t);
}

const ID_BODY = /^[0-9A-Za-z-]{1,40}$/;
const LINE_ID = /^[0-9A-Za-z]{1,40}$/;

export function isIdWithPrefix(v: unknown, prefix: string): v is string {
  if (typeof v !== "string") return false;
  const sep = v.indexOf("_");
  return sep > 0 && v.slice(0, sep) === prefix && ID_BODY.test(v.slice(sep + 1));
}

// 記録の種類のID（証憑ファイル・計算runを除く）なら、その種類。
export function recordTypeOfId(v: unknown): RecordType | undefined {
  if (typeof v !== "string") return undefined;
  return RECORD_TYPES.find((t) => isIdWithPrefix(v, RECORD_PREFIX[t]));
}

export function isLineId(v: unknown): v is string {
  return typeof v === "string" && LINE_ID.test(v);
}

// ID生成器。記録の種類の接頭辞（証憑ファイルはevf）を受け取り、新しいIDを返す。
export interface IdGenerator {
  next(prefix: string): string;
}

// UUIDv7の本体（RFC 9562の5.7）。unixMsは48ビットのミリ秒、randomは10バイト（74ビットを使う）。
export function uuidV7(unixMs: number, random: Uint8Array): string {
  if (!Number.isSafeInteger(unixMs) || unixMs < 0 || unixMs >= 2 ** 48) throw new Error("UUIDv7の時刻は0以上2^48未満の整数");
  if (random.length !== 10) throw new Error("UUIDv7の乱数は10バイト");
  const b = new Uint8Array(16);
  let t = unixMs;
  for (let i = 5; i >= 0; i -= 1) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = 0x70 | ((random[0] ?? 0) & 0x0f);
  b[7] = random[1] ?? 0;
  b[8] = 0x80 | ((random[2] ?? 0) & 0x3f);
  for (let i = 9; i < 16; i += 1) b[i] = random[i - 6] ?? 0;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// UUIDv7の本体でIDを作る生成器。時刻（Unixのミリ秒）と乱数の元は呼ぶ側が注入する（domainはシステムの時計・乱数を使わない）。
export function uuidV7IdGenerator(source: { nowMs(): number; randomBytes(n: number): Uint8Array }): IdGenerator {
  return {
    next(prefix: string): string {
      return `${prefix}_${uuidV7(source.nowMs(), source.randomBytes(10))}`;
    },
  };
}
