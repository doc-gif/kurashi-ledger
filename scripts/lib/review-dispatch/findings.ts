// PR48-R007: unresolved findings, from native Reviews, line comments and conversation comments.
// GitHub REST has no thread resolution state, and anyone with write access can dismiss reviews and
// edit or delete comments, so one rule set covers every input (pre-review red team on PR #52):
// Who raises
// - reviewers assigned in the owner policy: all three inputs below;
// - owners: their CHANGES_REQUESTED / DISMISSED Reviews only. They cannot resolve anyone else's finding.
// - everybody else (third parties, the PR author) is reference only.
// What raises
// - Review body: line-start IDs `PR<N>-R<3+ digits>` of this PR. A CHANGES_REQUESTED or DISMISSED Review
//   without such an ID raises `review:<id>` (a dismissal never clears a finding);
// - line comment: its IDs, or `comment:<id>` when it has none. An edited one also raises `comment:<id>`;
// - conversation comment: its IDs; without IDs, `issue:<id>` when it has a `decision:` line other than
//   `accepted`. An edited one also raises `issue:<id>` at its update time;
// - persisted observation: the first observed body hash and IDs of each item are kept. An item that later
//   vanishes raises `deleted:<item>`, one whose body hash changes raises `edited:<item>` (Review bodies
//   have no edit time in REST, so this is the only way to see such an edit).
// What resolves
// - only a later APPROVED Review of the same actor on the current head commit. Text such as "解消",
//   other people, an approval of an older commit or a dismissal resolve nothing. Ties keep the
//   finding, and findings raised by the approving Review itself stay open.
import { EvidenceError } from "./github.ts";
import { hash } from "./model.ts";

type Raw = Record<string, unknown>;
type Raise = { actor: number; at: number; id: string; review: string | null };
// Immutable first observation of an item ("review:<id>", "comment:<id>" or "issue:<id>").
export type ItemRecord = {
  item: string;
  actor: number;
  at: number;
  hash: string;
  ids: string[];
};
// Immutable record of a detected change; `hash` is the new body hash, null when deleted.
export type ChangeRecord = {
  item: string;
  actor: number;
  at: number;
  change: "edited" | "deleted";
  hash: string | null;
};
export type FindingInput = {
  pr: number;
  head: string;
  reviewers: readonly number[];
  owners: readonly number[];
  reviews: readonly Raw[];
  comments: readonly Raw[];
  conversation: readonly Raw[];
  observedAt: number;
  items?: readonly ItemRecord[];
  changes?: readonly ChangeRecord[];
};
export type FindingResult = {
  open: Map<number, string[]>;
  items: ItemRecord[]; // new records to persist
  changes: ChangeRecord[]; // new records to persist
};

const userId = (v: Raw): number => {
  const user = v["user"];
  const id =
    user && typeof user === "object" && !Array.isArray(user)
      ? (user as Raw)["id"]
      : undefined;
  if (!Number.isSafeInteger(id) || Number(id) < 1) throw new EvidenceError();
  return Number(id);
};
const itemId = (v: Raw): string => {
  if (!Number.isSafeInteger(v["id"]) || Number(v["id"]) < 1)
    throw new EvidenceError();
  return String(v["id"]);
};
const time = (v: unknown): number => {
  const at = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(at)) throw new EvidenceError();
  return at;
};
const body = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") throw new EvidenceError();
  return v;
};
// Line-start IDs only (optionally after "- " or "* "). Quoted lines ("> ") and mid-line mentions are prose.
export function findingIds(pr: number, text: string): string[] {
  const pattern = new RegExp(
    `^[ \\t]*(?:[-*][ \\t]+)?(PR${pr}-R[0-9]{3,})(?![0-9])`,
    "gm",
  );
  return [...new Set([...text.matchAll(pattern)].map((m) => m[1]!))];
}
const decisionOtherThanAccepted = (text: string): boolean =>
  [...text.matchAll(/^[ \t]*decision:[ \t]*(\S+)/gm)].some(
    (m) => m[1] !== "accepted",
  );
export function unresolvedFindings(input: FindingInput): FindingResult {
  const { pr, head } = input;
  if (!Number.isSafeInteger(pr) || pr < 1 || !/^[a-f0-9]{40}$/.test(head))
    throw new EvidenceError();
  const reviewers = new Set(input.reviewers),
    owners = new Set(input.owners.filter((id) => !reviewers.has(id))),
    raises: Raise[] = [],
    approvals: { actor: number; at: number; review: string }[] = [],
    seen = new Map<string, { actor: number; at: number; hash: string; ids: string[] }>();
  const observe = (
    item: string,
    actor: number,
    at: number,
    text: string,
    ids: string[],
  ) => seen.set(item, { actor, at, hash: hash(text), ids: [...ids].sort() });
  for (const r of input.reviews) {
    const actor = userId(r);
    const owner = owners.has(actor);
    if (!reviewers.has(actor) && !owner) continue;
    const id = itemId(r),
      at = time(r["submitted_at"]),
      state = r["state"],
      text = body(r["body"]),
      ids = findingIds(pr, text);
    if (typeof state !== "string") throw new EvidenceError();
    if (state === "APPROVED" && r["commit_id"] === head)
      approvals.push({ actor, at, review: id });
    const blocking = state === "CHANGES_REQUESTED" || state === "DISMISSED";
    if (owner && !blocking) continue; // Owner comments and approvals are not findings.
    if (!ids.length && blocking) ids.push(`review:${id}`);
    observe(`review:${id}`, actor, at, text, ids);
    for (const f of ids) raises.push({ actor, at, id: f, review: id });
  }
  for (const c of input.comments) {
    const actor = userId(c);
    if (!reviewers.has(actor)) continue;
    const id = itemId(c),
      created = time(c["created_at"]),
      updated = c["updated_at"] === undefined ? created : time(c["updated_at"]),
      review =
        c["pull_request_review_id"] === null ||
        c["pull_request_review_id"] === undefined
          ? null
          : String(c["pull_request_review_id"]);
    const edited = updated !== created,
      at = Math.max(created, updated),
      text = body(c["body"]),
      ids = findingIds(pr, text);
    if (!ids.length || edited) ids.push(`comment:${id}`);
    observe(`comment:${id}`, actor, at, text, ids);
    for (const f of ids) raises.push({ actor, at, id: f, review });
  }
  for (const c of input.conversation) {
    const actor = userId(c);
    if (!reviewers.has(actor)) continue;
    const id = itemId(c),
      created = time(c["created_at"]),
      updated = c["updated_at"] === undefined ? created : time(c["updated_at"]),
      text = body(c["body"]),
      ids = findingIds(pr, text);
    const edited = updated !== created,
      at = Math.max(created, updated);
    if ((!ids.length && decisionOtherThanAccepted(text)) || edited)
      ids.push(`issue:${id}`);
    observe(`issue:${id}`, actor, at, text, ids);
    for (const f of ids) raises.push({ actor, at, id: f, review: null });
  }
  // Compare with the first observation of each item. Change records are immutable, so a later
  // approval can resolve them, and a further change raises a new one.
  const items: ItemRecord[] = [],
    changes: ChangeRecord[] = [],
    known = new Map((input.items ?? []).map((r) => [r.item, r])),
    recorded = [...(input.changes ?? [])];
  const has = (c: ChangeRecord) =>
    recorded.some(
      (r) => r.item === c.item && r.change === c.change && r.hash === c.hash,
    );
  for (const [item, v] of seen)
    if (!known.has(item))
      items.push({ item, actor: v.actor, at: v.at, hash: v.hash, ids: v.ids });
  for (const [item, first] of known) {
    const now = seen.get(item);
    if (now && now.hash === first.hash) continue;
    if (!Number.isFinite(input.observedAt)) throw new EvidenceError();
    const c: ChangeRecord = now
      ? {
          item,
          actor: first.actor,
          // Comments carry an update time; a Review body edit is only seen at observation.
          at: item.startsWith("review:") ? input.observedAt : now.at,
          change: "edited",
          hash: now.hash,
        }
      : { item, actor: first.actor, at: input.observedAt, change: "deleted", hash: null };
    if (!has(c)) {
      changes.push(c);
      recorded.push(c);
    }
  }
  for (const c of recorded)
    raises.push({ actor: c.actor, at: c.at, id: `${c.change}:${c.item}`, review: null });
  const open = new Map<number, string[]>();
  for (const actor of [...reviewers, ...owners]) {
    const resolvedBy = approvals.filter((a) => a.actor === actor);
    const left = raises.filter(
      (f) =>
        f.actor === actor &&
        !resolvedBy.some((a) => a.at > f.at && a.review !== f.review),
    );
    if (left.length) open.set(actor, [...new Set(left.map((f) => f.id))].sort());
  }
  return { open, items, changes };
}
