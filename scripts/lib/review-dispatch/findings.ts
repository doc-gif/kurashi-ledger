// PR48-R007: unresolved findings of the assigned reviewers, from native Reviews and line comments.
// GitHub REST has no thread resolution state, and the PR side can dismiss reviews or edit comments, so:
// - only reviewers assigned in the owner policy raise findings (third-party comments stay reference);
// - a Review body raises the line-start IDs `PR<N>-R<3+ digits>` of this PR. A CHANGES_REQUESTED or
//   DISMISSED Review without such an ID raises `review:<id>` (a dismissal never clears a finding);
// - every line comment raises its IDs, or `comment:<id>` when it has none. An edited line comment also
//   raises `comment:<id>` at its update time, because an edit may have removed an ID;
// - only a later APPROVED Review of the same reviewer resolves what that reviewer raised before it.
//   Text such as "解消", other reviewers, the owner, the author or a dismissal resolve nothing. Ties
//   keep the finding. Findings raised in the approving Review itself stay open.
// Residual risk (documented): a Review body edited to remove an ID is invisible in REST.
import { EvidenceError } from "./github.ts";

type Raw = Record<string, unknown>;
type Raise = { actor: number; at: number; id: string; review: string | null };

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
  const pattern = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(PR${pr}-R[0-9]{3,})(?![0-9])`, "gm");
  return [...new Set([...text.matchAll(pattern)].map((m) => m[1]!))];
}
export function unresolvedFindings(
  pr: number,
  reviewers: readonly number[],
  reviews: readonly Raw[],
  comments: readonly Raw[],
): Map<number, string[]> {
  if (!Number.isSafeInteger(pr) || pr < 1) throw new EvidenceError();
  const allowed = new Set(reviewers),
    raises: Raise[] = [],
    approvals: { actor: number; at: number; review: string }[] = [];
  for (const r of reviews) {
    const actor = userId(r);
    if (!allowed.has(actor)) continue;
    const id = itemId(r),
      at = time(r["submitted_at"]),
      state = r["state"],
      ids = findingIds(pr, body(r["body"]));
    if (typeof state !== "string") throw new EvidenceError();
    if (state === "APPROVED") approvals.push({ actor, at, review: id });
    if (!ids.length && (state === "CHANGES_REQUESTED" || state === "DISMISSED"))
      ids.push(`review:${id}`);
    for (const f of ids) raises.push({ actor, at, id: f, review: id });
  }
  for (const c of comments) {
    const actor = userId(c);
    if (!allowed.has(actor)) continue;
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
      ids = findingIds(pr, body(c["body"]));
    if (!ids.length || edited) ids.push(`comment:${id}`);
    for (const f of ids) raises.push({ actor, at, id: f, review });
  }
  const out = new Map<number, string[]>();
  for (const actor of allowed) {
    const resolvedBy = approvals.filter((a) => a.actor === actor);
    const open = raises.filter(
      (f) =>
        f.actor === actor &&
        !resolvedBy.some((a) => a.at > f.at && a.review !== f.review),
    );
    if (open.length)
      out.set(actor, [...new Set(open.map((f) => f.id))].sort());
  }
  return out;
}
