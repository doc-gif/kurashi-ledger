import { textFindings } from "../public-policy.ts";
import type { DatabaseSync } from "node:sqlite";
import { hash, type Job, type Snapshot, type WorkerResult } from "./model.ts";

// Publication check for text that the Broker would post to the public repository (PR #51 red team P1,
// PR #53 red team P2-2/P2-4). One module, one normalisation, three call sites: parseResult (shape),
// the dispatcher before storing a result, and the Broker on the final body just before POST.
//
// This is a MITIGATION, not a guarantee. A determined worker can still encode a secret in ways no text rule
// catches (for example spread across prose). The guarantee that a reviewer cannot read secrets at all comes
// from the worker isolation and its negative probes (Issue #50 W1: Seatbelt/doctor, including deny-supervisor).

// Same rules as scripts/check-public.ts (public-policy textFindings), plus key/token shapes and local paths.
const TOKEN_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9._-]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
  /\bBearer\s*[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|credential)s?\b\s*[:=]\s*\S{6,}/i,
  /\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)[-_][A-Za-z0-9_-]{8,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}/,
];
const LOCAL_PATHS: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9_.~:/-])~\/[^\s]/,
  /(?:^|[^A-Za-z0-9_.~:/-])\/(?:Users|home|private|var|tmp|etc|opt|Volumes|root|usr|Library|System|Applications|mnt|srv|proc|dev|run|nix)(?:\/|\b)/,
  /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/,
  /\\\\[A-Za-z0-9._-]+\\/, // UNC
];
const FORMAT_CHARACTER = /\p{Cf}/u;
const GITHUB_URL = /https:\/\/github\.com\/[^\s<>()"'`]*/g;
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()"'`]*/gi;

// The only long identifiers allowed in public text: values the dispatcher/Broker verified itself in its own
// fresh snapshot (pair, final pair, head/base recorded in the GitHub timeline) and the trusted run ID. Nothing
// the worker wrote (evidence links included) can add to this set (PR #53 red team N1).
// A full PR commit list is not in the snapshot yet; links to other commits stay blocked (collector: W3/W4).
export type Allowed = ReadonlySet<string>;
export function allowedFor(
  j: Job,
  s: Pick<Snapshot, "pair" | "finalPair" | "history">,
): Allowed {
  const ids = new Set<string>([j.run]);
  for (const pair of [s.pair, s.finalPair, ...s.history.map((e) => e.pair)])
    if (pair) for (const sha of [pair.head, pair.base]) if (/^[a-f0-9]{40}$/.test(sha)) ids.add(sha);
  return ids;
}

// Evidence links: fixed shapes only. parseResult already enforces the shape; here the repository must be the
// policy's and a commit link must point at a commit in the allowed (snapshot-verified) set.
export const EVIDENCE_SHAPE =
  /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/(?:actions\/runs\/[0-9]{1,20}|pull\/[0-9]{1,10}#pullrequestreview-[0-9]{1,20}|commit\/([a-f0-9]{40}))$/;
export function evidenceFindings(
  evidence: readonly string[],
  repo: string,
  allowed: Allowed,
): string[] {
  const findings = new Set<string>();
  for (const url of evidence) {
    const m = EVIDENCE_SHAPE.exec(url);
    if (!m || m[1] !== repo) findings.add("evidence link not allowed");
    else if (m[2] !== undefined && !allowed.has(m[2]))
      findings.add("evidence commit not in this PR");
  }
  return [...findings];
}

export function publicationFindings(text: string, allowed: Allowed): string[] {
  const findings = new Set<string>();
  // Zero-width and other format characters can split a secret past every rule below. Reject, never strip.
  if (FORMAT_CHARACTER.test(text)) findings.add("format character");
  const n = text.normalize("NFKC");
  // Also check with whitespace/markup removed, so a token split across words or lines is rejoined.
  const compact = n.replace(/[\s>*`'"|\\]+/g, "");
  for (const t of [n, compact]) {
    for (const f of textFindings(t)) findings.add(f);
    if (TOKEN_SHAPES.some((re) => re.test(t))) findings.add("key/token");
  }
  if (LOCAL_PATHS.some((re) => re.test(n))) findings.add("local absolute path");
  for (const url of n.match(ANY_URL) ?? [])
    if (!/^https:\/\/github\.com\//.test(url)) findings.add("non-GitHub link");
  if (/\bwww\./i.test(n)) findings.add("non-GitHub link");
  if (/(?:%[0-9A-Fa-f]{2}){3,}/.test(n)) findings.add("percent-encoded data");
  // Opaque runs (keys, hex chunks, base64 with "/"). GitHub links are split into their segments first, so a
  // secret in a path or query is still seen; then this job's own IDs are removed.
  let scan = n.replace(GITHUB_URL, (url) => url.split(/[/#?=&]/).join(" "));
  for (const id of allowed) scan = scan.split(id).join(" ");
  for (const run of scan.match(/[A-Za-z0-9+/=_-]{32,}/g) ?? [])
    if (/[0-9]/.test(run) && /[A-Za-z]/.test(run))
      findings.add("opaque key-like string");
  return [...findings];
}

// Every prose field of a parsed worker result, checked as one text (so cross-field joins are also seen).
export function resultFindings(
  r: WorkerResult,
  j: Job,
  s: Pick<Snapshot, "pair" | "finalPair" | "history">,
  repo: string,
): string[] {
  const allowed = allowedFor(j, s),
    parts = [
      r.summary,
      ...r.findings.flatMap((f) => [f.location, f.impact, f.completion]),
      ...r.unverified,
      ...r.evidence,
    ];
  return [
    ...evidenceFindings(r.evidence, repo, allowed),
    ...publicationFindings(parts.join("\n"), allowed),
  ];
}

// What the dispatcher stores instead of a result that failed the check: the hash only, never the plaintext.
export function redactedResult(raw: string): string {
  return JSON.stringify({ redacted: "publication-check", resultHash: hash(raw) });
}

// Replaces a stored plaintext result with its hash-only form when the Broker blocks the final body. Matches the
// exact job and stored hash so it cannot touch another row. Uses the jobs table directly because store.ts is
// being changed by W3; moving this into the Store API is part of the W4 integration.
export function redactStoredResult(db: DatabaseSync, j: Job, raw: string): boolean {
  return (
    db
      .prepare(
        "UPDATE jobs SET result=? WHERE id=? AND run=? AND result=?",
      )
      .run(redactedResult(raw), j.id, j.run, raw).changes === 1
  );
}

// `blocked` (persistent needs-owner): never posted; the lease stays held (job status uncertain) so nothing
// relaunches for this PR; one owner notice per run. A durable per-PR needs-owner state that survives an owner
// releasing the uncertain lease is a REQUIRED Issue #50 W4 item (store.ts is W3's).
export const blockedNotice = (j: Job): string =>
  `${j.key}:publication-blocked:${j.run}`;
